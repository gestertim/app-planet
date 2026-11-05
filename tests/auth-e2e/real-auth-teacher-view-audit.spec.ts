import { randomUUID } from "node:crypto";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { sessionCookieName } from "../../apps/web/src/server/auth-principal.ts";
import {
  createSyntheticAuthAccount, deleteSyntheticAuthAccount, loginSyntheticAccount,
  openControlPool, type SyntheticAuthAccount,
} from "../support/real-auth-fixture.ts";

test.use({ actionTimeout: 15_000 });
test("T-5 真 HTTPS：產品教師查看→管理員表單登入→篩選／分頁／reload→解除後歷史／失敗重試", async ({ browser }) => {
  test.setTimeout(300_000);
  const control = openControlPool();
  const origin = process.env.APP_PLANET_APP_ORIGIN!;
  const accounts: SyntheticAuthAccount[] = [];
  const contexts: BrowserContext[] = [];
  const projectIds: string[] = [];
  const auditPath = "/admin/audit/teacher-views";
  const signature = "app.read_admin_teacher_views(uuid,uuid,timestamptz,uuid,integer,boolean)";
  const secretText = "受保護的學生草稿－不得出現在管理稽核表格";
  let grantRevoked = false;
  try {
    const [studentAccount, teacherAccount, adminAccount] = await Promise.all([
      createSyntheticAuthAccount(control, "稽核學生"), createSyntheticAuthAccount(control, "稽核教師"),
      createSyntheticAuthAccount(control, "稽核管理員"),
    ]);
    accounts.push(studentAccount, teacherAccount, adminAccount);
    await control.query("UPDATE app.profiles SET role='teacher' WHERE id=$1", [teacherAccount.id]);
    await control.query("UPDATE app.profiles SET role='admin' WHERE id=$1", [adminAccount.id]);
    const membership = randomUUID();
    await control.query(`INSERT INTO app.teacher_school_memberships
      (id,teacher_id,school_id,state,created_by_aid,created_at) VALUES($1,$2,$3,'active',$4,now())`,
    [membership, teacherAccount.id, studentAccount.schoolId, randomUUID()]);
    contexts.push(...await Promise.all(accounts.map(() => browser.newContext({
      ignoreHTTPSErrors: true, locale: "zh-TW",
    }))));
    const [student, teacher, admin] = await Promise.all(contexts.map((c) => c.newPage()));
    const responseFor = (page: Page, path: string, method: string) => page.waitForResponse((response) =>
      new URL(response.url()).pathname === path && response.request().method() === method);
    const login = async (page: Page, account: SyntheticAuthAccount, role: string) => {
      await page.goto(`${origin}/login`);
      await expect(page.locator('form[data-ready="true"]')).toHaveCount(1);
      await page.getByLabel("電子郵件").fill(account.email);
      await page.getByLabel("密碼").fill(account.password);
      const sent = responseFor(page, "/api/v1/auth/staff/login", "POST");
      await page.getByRole("button", { name: "登入", exact: true }).press("Enter");
      expect((await sent).status()).toBe(200);
      await expect(page).toHaveURL(`${origin}/${role}`);
    };
    const session = await loginSyntheticAccount(studentAccount);
    await contexts[0].addCookies([{
      name: sessionCookieName, value: session.accessToken, url: origin, secure: true,
      httpOnly: true, sameSite: "Strict",
    }]);
    await student.goto(`${origin}/student`);
    await student.getByLabel("專案名稱").fill("稽核不得顯示的學生作品");
    const created = responseFor(student, "/api/v1/projects", "POST");
    await student.getByRole("button", { name: "建立專案", exact: true }).click();
    const createdResponse = await created;
    expect(createdResponse.status()).toBe(201);
    const project = (await createdResponse.json()).id as string;
    projectIds.push(project);
    await student.goto(`${origin}/student/projects/${project}/stages/Specification`);
    await student.getByLabel("階段草稿文字").fill(secretText);
    const saved = responseFor(student, `/api/v1/projects/${project}/stages/Specification`, "PUT");
    await student.getByRole("button", { name: "保存", exact: true }).click();
    expect((await saved).status()).toBe(201);

    await login(admin, adminAccount, "admin");
    await admin.getByRole("link", { name: "師生綁定", exact: true }).click();
    const region = admin.getByRole("region", { name: "師生綁定管理", exact: true });
    await expect(region.getByLabel("合格教師與學校")).toBeEnabled();
    await region.getByLabel("合格教師與學校").selectOption(membership);
    await region.getByLabel("合格學生").selectOption(studentAccount.id);
    const linked = responseFor(admin, "/api/v1/admin/bindings", "POST");
    await region.getByRole("button", { name: "核對並建立綁定", exact: true }).press("Enter");
    await admin.getByRole("dialog").getByRole("button", { name: "明確確認並送出建立", exact: true }).press("Enter");
    const linkedResponse = await linked;
    expect(linkedResponse.status()).toBe(201);
    const binding = (await linkedResponse.json()).binding_id as string;
    await login(teacher, teacherAccount, "teacher");
    await teacher.getByRole("link", { name: `學生-${studentAccount.id.slice(0, 8)} 的專案` }).click();
    await teacher.getByRole("link", { name: /稽核不得顯示的學生作品/ }).click();
    await teacher.getByRole("region", { name: "九階段保存與學生確認摘要" })
      .getByRole("link", { name: /^Specification：/ }).click();
    await expect(teacher.getByText(secretText)).toBeVisible();
    // Product page reloads, not SQL fixtures, generate enough independent teacher_view events.
    for (let n = 0; n < 21; n++) {
      await teacher.reload();
      await expect(teacher.getByText(secretText)).toBeVisible();
    }

    await admin.goto(`${origin}/admin`);
    await admin.getByRole("link", { name: "教師查看紀錄", exact: true }).click();
    await expect(admin).toHaveURL(`${origin}${auditPath}`);
    const results = admin.getByRole("region", { name: "教師查看紀錄結果", exact: true });
    await expect(results.locator("tbody tr")).toHaveCount(20);
    const labels = await results.locator("tbody tr").first().innerText();
    expect(labels).toContain("合成帳號稽核教師");
    expect(labels).toContain("合成帳號稽核學生");
    expect(labels).toContain("UTC");
    expect(await results.innerText()).not.toContain(studentAccount.id);
    expect(await admin.locator("body").innerText()).not.toContain(secretText);
    expect(await admin.locator("body").innerText()).not.toContain(studentAccount.email);
    await admin.getByLabel("教師 UUID", { exact: false }).fill(teacherAccount.id);
    await admin.getByRole("button", { name: "查詢", exact: true }).click();
    await expect(results.locator("tbody tr")).toHaveCount(20);
    await admin.reload();
    await expect(admin.getByLabel("教師 UUID", { exact: false })).toHaveValue(teacherAccount.id);
    await admin.getByLabel("學生 UUID", { exact: false }).fill(studentAccount.id);
    await admin.getByRole("button", { name: "查詢", exact: true }).click();
    await expect(results.locator("tbody tr")).toHaveCount(20);
    await admin.getByRole("link", { name: "下一頁", exact: true }).click();
    const nextUrl = admin.url();
    expect(new URL(nextUrl).searchParams.has("after")).toBe(true);
    await expect(results.locator("tbody tr")).toHaveCount(4);
    await admin.reload();
    expect(admin.url()).toBe(nextUrl);
    await expect(results.locator("tbody tr")).toHaveCount(4);
    await admin.getByRole("link", { name: "清除篩選", exact: true }).click();
    await expect(admin).toHaveURL(`${origin}${auditPath}`);
    await expect(admin.getByLabel("教師 UUID", { exact: false })).toHaveValue("");
    await admin.getByLabel("學生 UUID", { exact: false }).fill(randomUUID());
    await admin.getByRole("button", { name: "查詢", exact: true }).click();
    await expect(admin.getByText("沒有符合條件的查看紀錄。")).toBeVisible();
    await admin.getByRole("link", { name: "清除篩選", exact: true }).click();

    await admin.goto(`${origin}/admin/bindings`);
    await region.getByLabel("既有綁定").selectOption(binding);
    await region.getByLabel("解除理由").fill("合成稽核產品解除");
    const ended = responseFor(admin, `/api/v1/admin/bindings/${binding}`, "DELETE");
    await region.getByRole("button", { name: "核對並解除綁定", exact: true }).press("Enter");
    await admin.getByRole("dialog").getByRole("button", { name: "明確確認並送出解除", exact: true }).press("Enter");
    expect((await ended).status()).toBe(200);
    await teacher.reload();
    await expect(teacher.getByText(secretText)).toHaveCount(0);
    const denied = await teacher.request.get(`${origin}/api/v1/teacher/students/${studentAccount.id}/projects/${project}`);
    expect(denied.status()).toBe(404);
    await admin.goto(`${origin}${auditPath}?student_id=${studentAccount.id}`);
    await expect(results.locator("tbody tr")).toHaveCount(20);
    const api = await admin.request.get(`${origin}/api/v1/admin/audit/teacher-views?student_id=${studentAccount.id}`);
    expect(api.status()).toBe(200);
    expect(api.headers()["cache-control"]).toContain("no-store");
    expect((await api.json()).items).toHaveLength(20);

    await control.query(`REVOKE EXECUTE ON FUNCTION ${signature} FROM authenticated`);
    grantRevoked = true;
    await admin.reload();
    await expect(admin.getByRole("alert")).toContainText("目前無法讀取查看紀錄");
    await expect(results).toHaveCount(0);
    await control.query(`GRANT EXECUTE ON FUNCTION ${signature} TO authenticated`);
    grantRevoked = false;
    await admin.getByRole("link", { name: "重新讀取", exact: true }).click();
    await expect(results.locator("tbody tr")).toHaveCount(20);
    await control.query("UPDATE app.profiles SET status='disabled' WHERE id=$1", [adminAccount.id]);
    await admin.reload();
    await expect(admin.getByRole("alert").filter({ hasText: "目前沒有教師查看紀錄查詢權限" })).toBeVisible();
    await expect(results).toHaveCount(0);
    expect((await admin.request.get(`${origin}/api/v1/admin/audit/teacher-views?teacher_id=bad`)).status()).toBe(403);
    console.log("TeacherViewAuditHTTPS=product_login;product_teacher_views;admin_entry;filters;pages;reload;UI_unbind;history;dependency_retry;revocation");
  } finally {
    if (grantRevoked) await control.query(`GRANT EXECUTE ON FUNCTION ${signature} TO authenticated`);
    for (const context of contexts) await context.close();
    const ids = accounts.map((a) => a.id);
    await control.query("DELETE FROM app.binding_operation_receipts WHERE actor_id=ANY($1::uuid[])", [ids]);
    for (const table of ["stage_draft_confirmations", "stage_draft_idempotency", "stage_records", "project_create_idempotency"]) {
      await control.query(`DELETE FROM app.${table} WHERE project_id=ANY($1::uuid[])`, [projectIds]);
    }
    await control.query("DELETE FROM app.projects WHERE id=ANY($1::uuid[])", [projectIds]);
    await control.query("DELETE FROM app.teacher_student_bindings WHERE teacher_id=ANY($1::uuid[]) OR student_id=ANY($1::uuid[])", [ids]);
    await control.query("DELETE FROM app.teacher_school_memberships WHERE teacher_id=ANY($1::uuid[])", [ids]);
    await control.query(`DELETE FROM app.audit_events WHERE actor_aid IN
      (SELECT aid FROM app.audit_identity_map WHERE account_id=ANY($1::uuid[])) OR subject_aid IN
      (SELECT aid FROM app.audit_identity_map WHERE account_id=ANY($1::uuid[]))`, [ids]);
    await control.query("DELETE FROM app.audit_identity_map WHERE account_id=ANY($1::uuid[])", [ids]);
    await control.query("DELETE FROM app.profiles WHERE id=ANY($1::uuid[])", [ids]);
    await control.query("DELETE FROM app.schools WHERE id=ANY($1::uuid[])", [accounts.map((a) => a.schoolId)]);
    for (const a of accounts) await deleteSyntheticAuthAccount(a);
    await control.end();
    console.log("TeacherViewAuditHTTPSCleanup=verified owned synthetic data removed");
  }
});
