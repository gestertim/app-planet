import { randomUUID } from "node:crypto";
import { expect, test, type BrowserContext, type Page, type Route } from "@playwright/test";
import { createSyntheticAuthAccount, deleteSyntheticAuthAccount, loginSyntheticAccount, openControlPool,
  type SyntheticAuthAccount } from "../support/real-auth-fixture.ts";
import { sessionCookieName } from "../../apps/web/src/server/auth-principal.ts";

test.use({ actionTimeout: 15_000 });
test("真管理員登入→UI建立／解除／重綁→教師審查失效與新批准，response-loss reload 原鍵恢復", async ({ browser }) => {
  test.setTimeout(300_000);
  const control = openControlPool(), origin = process.env.APP_PLANET_APP_ORIGIN!;
  const studentAccount = await createSyntheticAuthAccount(control, "BindingStudent");
  const teacherAccount = await createSyntheticAuthAccount(control, "BindingTeacher");
  const adminAccount = await createSyntheticAuthAccount(control, "BindingAdmin");
  const accounts = [studentAccount, teacherAccount, adminAccount], ids = accounts.map((a) => a.id);
  await control.query("UPDATE app.profiles SET role='teacher' WHERE id=$1", [teacherAccount.id]);
  await control.query("UPDATE app.profiles SET role='admin' WHERE id=$1", [adminAccount.id]);
  const membership = randomUUID();
  await control.query(`INSERT INTO app.teacher_school_memberships(id,teacher_id,school_id,state,created_by_aid,created_at)
    VALUES($1,$2,$3,'active',$4,clock_timestamp())`, [membership, teacherAccount.id, studentAccount.schoolId, randomUUID()]);
  const contexts = await Promise.all(accounts.map(() => browser.newContext({ locale: "zh-TW", ignoreHTTPSErrors: true })));
  const [studentContext, teacherContext, adminContext] = contexts;
  const [student, teacher, admin] = await Promise.all(contexts.map((c) => c.newPage()));
  const review = (p: Page) => p.getByRole("region", { name: "Specification 提交與教師審查", exact: true });
  const bindings = () => admin.getByRole("region", { name: "師生綁定管理", exact: true });
  const response = (p: Page, path: string, method: string) => p.waitForResponse((r) =>
    new URL(r.url()).pathname === path && r.request().method() === method);
  student.on("response", (r) => {
    if (r.status() >= 400 && new URL(r.url()).pathname.startsWith("/api/v1/")) {
      console.log(`BindingStudentHTTP=${r.status()};path=${new URL(r.url()).pathname}`);
    }
  });
  const renewStudentSetup = async () => {
    const session = await loginSyntheticAccount(studentAccount);
    await studentContext.addCookies([{ name: sessionCookieName, value: session.accessToken, url: origin,
      secure: true, httpOnly: true, sameSite: "Strict" }]);
  };
  const login = async (p: Page, account: SyntheticAuthAccount, role: "admin" | "teacher") => {
    await p.goto(`${origin}/login`);
    await expect(p.locator('form[data-ready="true"]')).toHaveCount(1);
    await p.getByLabel("電子郵件").fill(account.email);
    await p.getByLabel("密碼").fill(account.password);
    const sent = response(p, "/api/v1/auth/staff/login", "POST");
    await p.getByRole("button", { name: "登入", exact: true }).press("Enter");
    expect((await sent).status()).toBe(200);
    await expect(p).toHaveURL(`${origin}/${role}`);
  };
  const selectPair = async () => {
    await expect(bindings().getByLabel("合格教師與學校")).toBeEnabled();
    await bindings().getByLabel("合格教師與學校").selectOption(membership);
    await expect(bindings().getByLabel("合格學生").locator(`option[value="${studentAccount.id}"]`)).toHaveCount(1);
    await bindings().getByLabel("合格學生").selectOption(studentAccount.id);
    await expect(bindings().getByRole("button", { name: "核對並建立綁定", exact: true })).toBeEnabled();
  };
  const cancel = async (name: string) => {
    const trigger = bindings().getByRole("button", { name, exact: true });
    await trigger.press("Enter");
    await expect(admin.getByRole("dialog")).toBeVisible();
    await admin.getByRole("dialog").getByRole("button", { name: "取消，尚未送出", exact: true }).click();
    await expect(admin.getByRole("dialog")).toHaveCount(0);
    await expect(trigger).toBeFocused();
    await trigger.press("Enter"); await admin.keyboard.press("Escape");
    await expect(admin.getByRole("dialog")).toHaveCount(0);
    await expect(trigger).toBeFocused();
  };
  const mutate = async (kind: "create" | "end", binding?: string, loss = false) => {
    const path = `/api/v1/admin/bindings${kind === "end" ? `/${binding}` : ""}`;
    const method = kind === "end" ? "DELETE" : "POST";
    const calls: { key?: string; body: string | null; url: string }[] = [];
    const observe = (r: import("@playwright/test").Request) => {
      if (new URL(r.url()).pathname === path && r.method() === method) calls.push({
        key: r.headers()["idempotency-key"], body: r.postData(), url: new URL(r.url()).pathname,
      });
    };
    admin.on("request", observe);
    try {
      await bindings().getByRole("button", { name: kind === "end" ? "核對並解除綁定" : "核對並建立綁定", exact: true }).press("Enter");
      await expect(admin.getByRole("dialog")).toContainText(kind === "end" ? binding! : "合成帳號BindingStudent");
      if (loss) await admin.route(`**${path}`, async (route) => {
        const upstream = await route.fetch();
        expect(upstream.status()).toBe(kind === "end" ? 200 : 201);
        await route.abort("failed");
      }, { times: 1 });
      const sent = loss ? null : response(admin, path, method);
      await admin.getByRole("dialog").getByRole("button", {
        name: kind === "end" ? "明確確認並送出解除" : "明確確認並送出建立", exact: true,
      }).press("Enter");
      if (!loss) {
        const result = await sent!;
        expect(result.status()).toBe(kind === "end" ? 200 : 201);
        expect(calls).toHaveLength(1);
        return (await result.json()).binding_id as string;
      }
      await expect(bindings().getByRole("button", { name: "以原對象與原鍵重試" })).toBeVisible();
      await expect(bindings().getByRole("button", { name: "核對並建立綁定", exact: true })).toBeDisabled();
      const committed = await control.query(`SELECT id FROM app.teacher_student_bindings
        WHERE teacher_id=$1 AND student_id=$2 AND state=$3`,
      [teacherAccount.id, studentAccount.id, kind === "create" ? "active" : "ended"]);
      expect(committed.rowCount).toBe(1);
      await admin.reload();
      await expect(bindings().getByRole("button", { name: "以原對象與原鍵重試" })).toBeVisible();
      const replay = response(admin, path, method);
      await bindings().getByRole("button", { name: "以原對象與原鍵重試" }).press("Enter");
      const result = await replay;
      expect(result.status()).toBe(200);
      expect(result.headers()["idempotent-replay"]).toBe("true");
      expect(calls).toHaveLength(2); expect(calls[0]).toEqual(calls[1]);
      return (await result.json()).binding_id as string;
    } finally { admin.off("request", observe); }
  };
  try {
    await renewStudentSetup();
    await student.goto(`${origin}/student`);
    await expect(student.getByTestId("teacher-relationship-notice")).toContainText("沒有符合資格");
    await student.getByLabel("專案名稱").fill("綁定垂直產品驗收");
    const created = response(student, "/api/v1/projects", "POST");
    await student.getByRole("button", { name: "建立專案", exact: true }).click();
    const project = (await (await created).json()).id as string;
    await student.goto(`${origin}/student/projects/${project}/stages/A%2FB`);
    await student.getByLabel("正式需求說明").fill("合成按鈕顯示學習提示");
    const saved = response(student, `/api/v1/projects/${project}/requirements`, "PUT");
    await student.getByRole("button", { name: "保存正式需求", exact: true }).click();
    expect((await saved).status()).toBe(200);
    await student.getByLabel("正式 A/B 分類", { exact: true }).selectOption("A");
    await student.getByLabel("需要識別訪客身分嗎", { exact: true }).selectOption("false");
    const classified = response(student, `/api/v1/projects/${project}/classification/confirmation`, "POST");
    await student.getByRole("button", { name: "明確確認正式分類", exact: true }).click();
    expect((await classified).status()).toBe(200);
    await student.goto(`${origin}/student/projects/${project}/stages/Specification`);
    await student.getByLabel("階段草稿文字").fill("綁定資格與規格審查產品證據");
    const draft = response(student, `/api/v1/projects/${project}/stages/Specification`, "PUT");
    await student.getByRole("button", { name: "保存", exact: true }).click();
    expect((await draft).status()).toBe(201);
    const submit = async () => {
      const trigger = review(student).getByRole("button", { name: "提交已保存 Specification 給教師審查", exact: true });
      await expect(trigger).toBeEnabled(); await trigger.press("Enter");
      const sent = response(student, `/api/v1/projects/${project}/stages/Specification/submissions`, "POST");
      await student.getByRole("dialog").getByRole("button", { name: "確認送出", exact: true }).press("Enter");
      const result = await sent; expect(result.status()).toBe(200);
      return (await result.json()).submission_id as string;
    };
    const first = await submit();
    await login(teacher, teacherAccount, "teacher");
    await expect(teacher.getByRole("region", { name: "Specification 待審清單" })).not.toContainText("綁定垂直產品驗收");
    expect((await teacherContext.request.get(`${origin}/api/v1/teacher/specification-submissions/${first}`)).status()).toBe(404);
    await login(admin, adminAccount, "admin");
    await admin.getByRole("link", { name: "師生綁定", exact: true }).click();
    await expect(admin).toHaveURL(`${origin}/admin/bindings`);
    await selectPair();
    let writes = 0;
    const watchWrites = (r: import("@playwright/test").Request) => {
      if (["POST", "DELETE"].includes(r.method()) && new URL(r.url()).pathname.startsWith("/api/v1/admin/bindings")) writes++;
    };
    admin.on("request", watchWrites);
    await cancel("核對並建立綁定"); expect(writes).toBe(0);
    const firstBinding = await mutate("create", undefined, true);
    await expect(bindings().getByTestId("binding-receipt")).toContainText(firstBinding);
    await admin.reload();
    await expect(bindings().getByLabel("既有綁定").locator(`option[value="${firstBinding}"]`)).toHaveCount(1);
    await bindings().getByLabel("既有綁定").selectOption(firstBinding);
    await expect(bindings().getByTestId("current-binding")).toContainText("目前有效");
    expect((await control.query("SELECT state FROM app.teacher_student_bindings WHERE id=$1", [firstBinding])).rows[0].state).toBe("active");
    // 不重新載入學生頁；下次真實產品讀取觸發 A-4 重讀。
    await review(student).getByRole("button", { name: "重新讀取審查狀態", exact: true }).click();
    await expect(student.getByTestId("teacher-relationship-notice")).toContainText("合成帳號BindingTeacher");
    await teacher.goto(`${origin}/teacher`);
    await teacher.getByRole("link", { name: "綁定垂直產品驗收 — Specification 版本 0", exact: true }).click();
    await expect(review(teacher)).toContainText("綁定資格與規格審查產品證據");
    const approve = async (submission: string) => {
      await teacher.getByRole("radio", { name: "批准", exact: true }).check();
      await review(teacher).getByRole("button", { name: "核對審查決定", exact: true }).click();
      const sent = response(teacher, `/api/v1/teacher/specification-submissions/${submission}/decision`, "POST");
      await teacher.getByRole("dialog").getByRole("button", { name: "確認送出", exact: true }).press("Enter");
      expect((await sent).status()).toBe(200);
    };
    await approve(first);
    await review(student).getByRole("button", { name: "重新讀取審查狀態", exact: true }).click();
    await expect(review(student).getByTestId("specification-review-state")).toContainText("已批准");
    const endReason = "\u3000 已完成本次合成教學關係 \u00a0";
    await bindings().getByLabel("解除理由").fill(endReason);
    const beforeCancel = writes;
    await cancel("核對並解除綁定"); expect(writes).toBe(beforeCancel);
    expect(await mutate("end", firstBinding, true)).toBe(firstBinding);
    const ended = (await control.query("SELECT state,end_reason,specification_review_epoch FROM app.teacher_student_bindings WHERE id=$1",
      [firstBinding])).rows[0];
    expect(ended).toMatchObject({ state: "ended", end_reason: endReason }); expect(Number(ended.specification_review_epoch)).toBeGreaterThan(0);
    expect((await teacherContext.request.get(`${origin}/api/v1/teacher/specification-submissions/${first}`)).status()).toBe(404);
    expect((await teacherContext.request.post(`${origin}/api/v1/teacher/specification-submissions/${first}/decision`, {
      headers: { origin, "idempotency-key": randomUUID() }, data: { decision: "approved", reason: null },
    })).status()).toBe(404);
    await review(student).getByRole("button", { name: "重新讀取審查狀態", exact: true }).click();
    await expect(review(student).getByTestId("specification-review-state")).toContainText("不再有效");
    await expect(student.getByTestId("teacher-relationship-notice")).toContainText("沒有符合資格");
    await selectPair();
    const rebound = await mutate("create");
    expect(rebound).not.toBe(firstBinding);
    await review(student).getByRole("button", { name: "重新讀取審查狀態", exact: true }).click();
    await expect(review(student).getByTestId("specification-review-state")).toContainText("不再有效");
    await expect(student.getByTestId("teacher-relationship-notice")).toContainText("合成帳號BindingTeacher");
    const second = await submit(); expect(second).not.toBe(first);
    await teacher.goto(`${origin}/teacher/specification-submissions/${second}`);
    await approve(second);
    // 隔離 Auth 的 60 秒 access token；只更新合成學生 session，不重新載入頁面或替代產品操作。
    await renewStudentSetup();
    const finalRead = response(student, `/api/v1/projects/${project}/stages/Specification/submissions`, "GET");
    await review(student).getByRole("button", { name: "重新讀取審查狀態", exact: true }).click();
    expect((await finalRead).status()).toBe(200);
    await expect(review(student).getByTestId("specification-review-state")).toContainText("已批准");
    const decisionBindings = (await control.query(`SELECT d.binding_id FROM app.specification_decisions d
      WHERE d.submission_id=ANY($1::uuid[]) ORDER BY d.decided_at`, [[first, second]])).rows.map((r) => r.binding_id);
    expect(decisionBindings).toEqual([firstBinding, rebound]);
    expect(writes).toBe(5); // 建立及解除各原鍵兩次，重綁一次。
    console.log("T077Product=admin_form_login;create_end_rebind_UI;reload_DB;new_binding_ID;old_approval_invalid;new_review_valid;student_next_request_notice;loss_restore_same_key_body_target;cancel_Escape_focus;writes=5");
    admin.off("request", watchWrites);
  } finally {
    for (const context of contexts) await context.close();
    await control.query("DELETE FROM app.binding_operation_receipts WHERE actor_id=ANY($1::uuid[])", [ids]);
    await control.query(`DELETE FROM app.specification_decisions WHERE submission_id IN
      (SELECT id FROM app.specification_submissions WHERE student_id=ANY($1::uuid[]))`, [ids]);
    await control.query("DELETE FROM app.specification_submissions WHERE student_id=ANY($1::uuid[])", [ids]);
    await control.query(`UPDATE app.projects SET classification_state='unconfirmed',tier=NULL,
      needs_visitor_identity=NULL,current_confirmation_id=NULL WHERE owner_id=ANY($1::uuid[])`, [ids]);
    for (const table of ["stage_draft_confirmations", "stage_draft_idempotency", "stage_records",
      "project_classification_idempotency", "project_classification_confirmations", "project_requirements", "project_create_idempotency"]) {
      await control.query(`DELETE FROM app.${table} WHERE project_id IN (SELECT id FROM app.projects WHERE owner_id=ANY($1::uuid[]))`, [ids]);
    }
    await control.query("DELETE FROM app.projects WHERE owner_id=ANY($1::uuid[])", [ids]);
    await control.query("DELETE FROM app.teacher_student_bindings WHERE teacher_id=ANY($1::uuid[]) OR student_id=ANY($1::uuid[])", [ids]);
    await control.query("DELETE FROM app.teacher_school_memberships WHERE teacher_id=ANY($1::uuid[])", [ids]);
    await control.query(`DELETE FROM app.audit_events WHERE actor_aid IN
      (SELECT aid FROM app.audit_identity_map WHERE account_id=ANY($1::uuid[]))`, [ids]);
    await control.query("DELETE FROM app.audit_identity_map WHERE account_id=ANY($1::uuid[])", [ids]);
    await control.query("DELETE FROM app.profiles WHERE id=ANY($1::uuid[])", [ids]);
    await control.query("DELETE FROM app.schools WHERE id=ANY($1::uuid[])", [accounts.map((a) => a.schoolId)]);
    for (const account of accounts) await deleteSyntheticAuthAccount(account);
    await control.end();
  }
});

test("管理員綁定頁 hydration 前不會送出，未知操作不自動重送", async ({ browser }) => {
  test.setTimeout(90_000);
  const control = openControlPool(), origin = process.env.APP_PLANET_APP_ORIGIN!;
  const account = await createSyntheticAuthAccount(control, "BindingHydrationAdmin");
  await control.query("UPDATE app.profiles SET role='admin' WHERE id=$1", [account.id]);
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  try {
    const session = await loginSyntheticAccount(account);
    await context.addCookies([{ name: sessionCookieName, value: session.accessToken, url: origin,
      secure: true, httpOnly: true, sameSite: "Strict" }]);
    const page = await context.newPage();
    let writes = 0, held = 0;
    page.on("request", (r) => { if (["POST", "DELETE"].includes(r.method())) writes++; });
    const hold = async (route: Route) => {
      if (route.request().resourceType() === "script") { held++; await gate; }
      await route.continue();
    };
    await page.route("**/*", hold);
    const result = await page.goto(`${origin}/admin/bindings`, { waitUntil: "commit" });
    expect(result?.status()).toBe(200); await result!.finished();
    await expect.poll(() => held).toBeGreaterThan(0);
    await expect(page.getByRole("button", { name: "核對並建立綁定", exact: true })).toBeDisabled();
    await expect(page.getByRole("button", { name: "核對並解除綁定", exact: true })).toBeDisabled();
    await page.keyboard.press("Enter"); await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0); expect(writes).toBe(0);
    console.log(`BindingHydration=actual_disabled_controls;scripts_held=${held};POST_DELETE=0`);
    release(); await page.unrouteAll({ behavior: "wait" });
    await expect(page.getByRole("button", { name: "重新讀取目前關係與候選" })).toBeEnabled();
    expect(writes).toBe(0);
  } finally {
    release?.();
    await context.close();
    await control.query("DELETE FROM app.profiles WHERE id=$1", [account.id]);
    await control.query("DELETE FROM app.schools WHERE id=$1", [account.schoolId]);
    await deleteSyntheticAuthAccount(account); await control.end();
  }
});

test("F-01 真 Next 離頁生命週期：晚到舊 create 不得清除新 end 意圖", async ({ browser }) => {
  test.setTimeout(180_000);
  const control = openControlPool(), origin = process.env.APP_PLANET_APP_ORIGIN!;
  const accounts: SyntheticAuthAccount[] = [];
  let context: BrowserContext | undefined;
  let releaseRoute: (() => void) | undefined;
  let oldForwardedResolve!: () => void;
  const oldForwarded = new Promise<void>((resolve) => { oldForwardedResolve = resolve; });
  try {
    const studentAccount = await createSyntheticAuthAccount(control, "BindingLifecycleStudent");
    accounts.push(studentAccount);
    const teacherAccount = await createSyntheticAuthAccount(control, "BindingLifecycleTeacher");
    accounts.push(teacherAccount);
    const adminAccount = await createSyntheticAuthAccount(control, "BindingLifecycleAdmin");
    accounts.push(adminAccount);
    await control.query("UPDATE app.profiles SET role='teacher' WHERE id=$1", [teacherAccount.id]);
    await control.query("UPDATE app.profiles SET role='admin' WHERE id=$1", [adminAccount.id]);
    const membership = randomUUID();
    await control.query(`INSERT INTO app.teacher_school_memberships(id,teacher_id,school_id,state,created_by_aid,created_at)
      VALUES($1,$2,$3,'active',$4,clock_timestamp())`,
    [membership, teacherAccount.id, studentAccount.schoolId, randomUUID()]);
    context = await browser.newContext({ locale: "zh-TW", ignoreHTTPSErrors: true });
    const admin = await context.newPage();
    const documentNavigations: string[] = [];
    admin.on("request", (request) => {
      if (request.resourceType() === "document") {
        documentNavigations.push(new URL(request.url()).pathname);
      }
    });
    const bindings = () => admin.getByRole("region", { name: "師生綁定管理", exact: true });
    await admin.goto(`${origin}/login`);
    await expect(admin.locator('form[data-ready="true"]')).toHaveCount(1);
    await admin.getByLabel("電子郵件").fill(adminAccount.email);
    await admin.getByLabel("密碼").fill(adminAccount.password);
    const login = admin.waitForResponse((response) =>
      new URL(response.url()).pathname === "/api/v1/auth/staff/login" && response.request().method() === "POST");
    await admin.getByRole("button", { name: "登入", exact: true }).press("Enter");
    expect((await login).status()).toBe(200);
    await expect(admin).toHaveURL(`${origin}/admin`);
    await admin.getByRole("link", { name: "師生綁定", exact: true }).click();
    await expect(admin).toHaveURL(`${origin}/admin/bindings`);
    const documentCountBeforeLifecycle = documentNavigations.length;
    await expect(bindings().getByLabel("合格教師與學校")).toBeEnabled();
    await bindings().getByLabel("合格教師與學校").selectOption(membership);
    await bindings().getByLabel("合格學生").selectOption(studentAccount.id);

    let firstKey = "", firstBody: string | null = null, firstReceipt: unknown;
    let firstRequest: import("@playwright/test").Request | undefined;
    const routeGate = new Promise<void>((resolve) => { releaseRoute = resolve; });
    let firstEntered!: () => void;
    const firstHit = new Promise<void>((resolve) => { firstEntered = resolve; });
    await context.route("**/api/v1/admin/bindings", async (route) => {
      firstRequest = route.request();
      firstKey = route.request().headers()["idempotency-key"] ?? "";
      firstBody = route.request().postData();
      const upstream = await route.fetch();
      expect(upstream.status()).toBe(201);
      const body = await upstream.json();
      firstReceipt = body;
      firstEntered();
      await routeGate;
      try { await route.fulfill({
        status: upstream.status(), contentType: "application/json", body: JSON.stringify(body),
      }); }
      finally { oldForwardedResolve(); }
    }, { times: 1 });
    await bindings().getByRole("button", { name: "核對並建立綁定", exact: true }).press("Enter");
    await expect(admin.getByRole("dialog")).toBeVisible();
    await admin.getByRole("dialog").getByRole("button", {
      name: "明確確認並送出建立", exact: true,
    }).press("Enter");
    await firstHit;
    expect(firstKey).toMatch(/^[0-9a-f-]{36}$/i);
    expect((await control.query(`SELECT count(*)::int n FROM app.teacher_student_bindings
      WHERE teacher_id=$1 AND student_id=$2 AND state='active'`, [teacherAccount.id, studentAccount.id])).rows[0].n).toBe(1);

    await admin.getByRole("link", { name: "管理員工作台", exact: true }).click();
    await expect(admin).toHaveURL(`${origin}/admin`);
    await admin.getByRole("link", { name: "師生綁定", exact: true }).click();
    await expect(admin).toHaveURL(`${origin}/admin/bindings`);
    expect(documentNavigations).toHaveLength(documentCountBeforeLifecycle);
    const retryCreate = bindings().getByRole("button", { name: "以原對象與原鍵重試", exact: true });
    await expect(retryCreate).toBeVisible();
    const createReplay = admin.waitForResponse((response) =>
      new URL(response.url()).pathname === "/api/v1/admin/bindings" && response.request().method() === "POST");
    await retryCreate.press("Enter");
    const replay = await createReplay;
    expect(replay.status()).toBe(200);
    expect(replay.headers()["idempotent-replay"]).toBe("true");
    expect(replay.request().headers()["idempotency-key"]).toBe(firstKey);
    expect(replay.request().postData()).toBe(firstBody);
    const bindingId = (await replay.json()).binding_id as string;
    expect(firstReceipt).toMatchObject({ operation: "create", binding_id: bindingId });
    expect(bindingId).toMatch(/^[0-9a-f-]{36}$/i);

    const bindingSelect = bindings().getByLabel("既有綁定");
    await expect(bindingSelect.locator(`option[value="${bindingId}"]`)).toHaveCount(1);
    await bindingSelect.selectOption(bindingId);
    await bindings().getByLabel("解除理由").fill("F-01 延遲回應競態");
    let deleteRequests = 0, secondKey = "", secondBody: string | null = null;
    const observeDelete = (request: import("@playwright/test").Request) => {
      if (request.method() === "DELETE") {
        deleteRequests++;
        secondKey = request.headers()["idempotency-key"] ?? "";
        secondBody = request.postData();
      }
    };
    admin.on("request", observeDelete);
    await bindings().getByRole("button", { name: "核對並解除綁定", exact: true }).press("Enter");
    await expect(admin.getByRole("dialog")).toBeVisible();
    await admin.route(`**/api/v1/admin/bindings/${bindingId}`, async (route) => {
      const upstream = await route.fetch();
      expect(upstream.status()).toBe(200);
      await route.abort("failed");
    }, { times: 1 });
    await admin.getByRole("dialog").getByRole("button", {
      name: "明確確認並送出解除", exact: true,
    }).press("Enter");
    await expect(bindings().getByRole("button", { name: "以原對象與原鍵重試", exact: true })).toBeVisible();
    expect(deleteRequests).toBe(1);
    const savedB = await admin.evaluate(() => {
      const key = Object.keys(sessionStorage).find((item) => item.startsWith("app-planet:bindings:"));
      return key ? { key, value: sessionStorage.getItem(key) } : null;
    });
    expect(savedB?.value).toBeTruthy();
    const intentB = JSON.parse(savedB!.value!);
    expect(intentB).toMatchObject({ operation: "end", target: bindingId, key: secondKey });
    expect(firstBody).toBeTruthy();
    expect(secondBody).toBeTruthy();

    const lateOld = admin.waitForResponse((response) =>
      response.request() === firstRequest);
    const oldRequestFinished = admin.waitForEvent("requestfinished", {
      predicate: (request) => request === firstRequest,
    });
    releaseRoute?.();
    const outcome = await Promise.race([
      lateOld.then((response) => ({ response })),
      admin.waitForEvent("requestfailed", { predicate: (request) => request === firstRequest })
        .then((request) => ({ failure: request.failure()?.errorText ?? "unknown" })),
      admin.waitForTimeout(5_000).then(() => ({ timeout: true as const })),
    ]);
    if (!("response" in outcome)) throw new Error("舊 A 的真實 HTTP 回應未在離頁後抵達。");
    const oldResponse = outcome.response;
    expect(oldResponse.status()).toBe(201);
    await oldForwarded;
    const requestOutcome = await Promise.race([
      oldRequestFinished.then(() => ({ finished: true as const })),
      admin.waitForEvent("requestfailed", { predicate: (request) => request === firstRequest })
        .then((request) => ({ failed: request.failure()?.errorText ?? "unknown" })),
      admin.waitForTimeout(5_000).then(() => ({ timeout: true as const })),
    ]);
    expect(requestOutcome, "舊 A 的 HTTP response body 必須完成傳輸").toEqual({ finished: true });
    const afterOld = await admin.evaluate((key) => sessionStorage.getItem(key), savedB!.key);
    expect(afterOld).toBe(savedB!.value);

    await admin.reload();
    await expect(bindings().getByRole("button", { name: "以原對象與原鍵重試", exact: true })).toBeVisible();
    expect(deleteRequests).toBe(1);
    const retryEnd = admin.waitForResponse((response) =>
      new URL(response.url()).pathname === `/api/v1/admin/bindings/${bindingId}` &&
      response.request().method() === "DELETE");
    await bindings().getByRole("button", { name: "以原對象與原鍵重試", exact: true }).press("Enter");
    const ended = await retryEnd;
    expect(ended.status()).toBe(200);
    expect(ended.headers()["idempotent-replay"]).toBe("true");
    const endRequest = ended.request();
    expect(endRequest.headers()["idempotency-key"]).toBe(secondKey);
    expect(endRequest.postData()).toBe(secondBody);
    expect(await admin.evaluate((key) => sessionStorage.getItem(key), savedB!.key)).toBeNull();
    expect((await control.query("SELECT state FROM app.teacher_student_bindings WHERE id=$1", [bindingId])).rows)
      .toEqual([{ state: "ended" }]);
    const audit = (await control.query(`SELECT action FROM app.audit_events WHERE object_ref=$1 ORDER BY at,id`,
      [bindingId])).rows.map((row) => row.action);
    expect(audit).toEqual(["binding_created", "binding_ended"]);
    admin.off("request", observeDelete);
  } finally {
    releaseRoute?.();
    if (context) await context.close();
    const ids = accounts.map((account) => account.id);
    if (ids.length) {
      await control.query("DELETE FROM app.binding_operation_receipts WHERE actor_id=ANY($1::uuid[])", [ids]);
      await control.query(`DELETE FROM app.audit_events WHERE actor_aid IN
        (SELECT aid FROM app.audit_identity_map WHERE account_id=ANY($1::uuid[]))`, [ids]);
      await control.query("DELETE FROM app.teacher_student_bindings WHERE teacher_id=ANY($1::uuid[]) OR student_id=ANY($1::uuid[])", [ids]);
      await control.query("DELETE FROM app.teacher_school_memberships WHERE teacher_id=ANY($1::uuid[])", [ids]);
      await control.query("DELETE FROM app.audit_identity_map WHERE account_id=ANY($1::uuid[])", [ids]);
      await control.query("DELETE FROM app.profiles WHERE id=ANY($1::uuid[])", [ids]);
      await control.query("DELETE FROM app.schools WHERE id=ANY($1::uuid[])", [accounts.map((account) => account.schoolId)]);
      for (const account of accounts) await deleteSyntheticAuthAccount(account);
    }
    await control.end();
  }
});

test("F-02 HTTPS：101 位有效教師完整提示，產品 UI 建立／解除及失權後更新", async ({ browser }) => {
  test.setTimeout(300_000);
  const control = openControlPool(), origin = process.env.APP_PLANET_APP_ORIGIN!;
  const accounts: SyntheticAuthAccount[] = [];
  const projectIds: string[] = [];
  let studentContext: BrowserContext | undefined, adminContext: BrowserContext | undefined;
  let otherContext: BrowserContext | undefined;
  try {
    const studentAccount = await createSyntheticAuthAccount(control, "BindingLimitStudent");
    accounts.push(studentAccount);
    const teacherAccount = await createSyntheticAuthAccount(control, "BindingLimitTeacher101");
    accounts.push(teacherAccount);
    const adminAccount = await createSyntheticAuthAccount(control, "BindingLimitAdmin");
    accounts.push(adminAccount);
    await control.query("UPDATE app.profiles SET role='teacher' WHERE id=$1", [teacherAccount.id]);
    await control.query("UPDATE app.profiles SET role='admin' WHERE id=$1", [adminAccount.id]);
    const teacherMembership = randomUUID();
    await control.query(`INSERT INTO app.teacher_school_memberships(id,teacher_id,school_id,state,created_by_aid,created_at)
      VALUES($1,$2,$3,'active',$4,clock_timestamp())`,
    [teacherMembership, teacherAccount.id, studentAccount.schoolId, randomUUID()]);

    const extra: SyntheticAuthAccount[] = [];
    for (let offset = 0; offset < 100; offset += 10) {
      const batch = await Promise.all(Array.from({ length: 10 }, async (_, index) => {
        const account = await createSyntheticAuthAccount(control,
          `數量邊界老師${String(offset + index + 1).padStart(3, "0")}`);
        accounts.push(account);
        return account;
      }));
      extra.push(...batch);
      const ids = batch.map((account) => account.id);
      await control.query("UPDATE app.profiles SET role='teacher',school_id=$2 WHERE id=ANY($1::uuid[])",
        [ids, studentAccount.schoolId]);
      await control.query(`INSERT INTO app.teacher_school_memberships
        (id,teacher_id,school_id,state,created_by_aid,created_at)
        SELECT gen_random_uuid(),teacher_id,$2,'active',gen_random_uuid(),clock_timestamp()
        FROM unnest($1::uuid[]) AS candidates(teacher_id)`, [ids, studentAccount.schoolId]);
      await control.query(`INSERT INTO app.teacher_student_bindings
        (id,teacher_id,student_id,state,created_by_aid,created_at)
        SELECT gen_random_uuid(),teacher_id,$2,'active',gen_random_uuid(),clock_timestamp()
        FROM unnest($1::uuid[]) AS candidates(teacher_id)`, [ids, studentAccount.id]);
    }

    studentContext = await browser.newContext({ locale: "zh-TW", ignoreHTTPSErrors: true });
    adminContext = await browser.newContext({ locale: "zh-TW", ignoreHTTPSErrors: true });
    const studentSession = await loginSyntheticAccount(studentAccount);
    await studentContext.addCookies([{ name: sessionCookieName, value: studentSession.accessToken, url: origin,
      secure: true, httpOnly: true, sameSite: "Strict" }]);
    const student = await studentContext.newPage();
    await student.goto(`${origin}/student`);
    const notice = student.getByTestId("teacher-relationship-notice");
    await expect(notice).toContainText("共 100 位");
    await expect(notice).toContainText("合成帳號數量邊界老師100");
    async function createProductProject(title: string) {
      if (new URL(student.url()).pathname !== "/student") {
        throw new Error("產品建立表單應留在學生工作台。");
      }
      await student.getByLabel("專案名稱").fill(title);
      const result = student.waitForResponse((response) =>
        new URL(response.url()).pathname === "/api/v1/projects" && response.request().method() === "POST");
      await student.getByRole("button", { name: "建立專案", exact: true }).click();
      const response = await result;
      expect(response.status()).toBe(201);
      const projectId = (await response.json()).id as string;
      projectIds.push(projectId);
      await expect(student.getByRole("link", { name: "開啟剛建立的專案", exact: true }))
        .toHaveAttribute("href", `/student/projects/${projectId}`);
    }

    const admin = await adminContext.newPage();
    await admin.goto(`${origin}/login`);
    await expect(admin.locator('form[data-ready="true"]')).toHaveCount(1);
    await admin.getByLabel("電子郵件").fill(adminAccount.email);
    await admin.getByLabel("密碼").fill(adminAccount.password);
    const login = admin.waitForResponse((response) =>
      new URL(response.url()).pathname === "/api/v1/auth/staff/login" && response.request().method() === "POST");
    await admin.getByRole("button", { name: "登入", exact: true }).press("Enter");
    expect((await login).status()).toBe(200);
    await expect(admin).toHaveURL(`${origin}/admin`);
    await admin.getByRole("link", { name: "師生綁定", exact: true }).click();
    const bindings = admin.getByRole("region", { name: "師生綁定管理", exact: true });
    const teacherSelect = bindings.getByLabel("合格教師與學校");
    for (let page = 0; page < 10; page++) {
      if (await teacherSelect.locator(`option[value="${teacherMembership}"]`).count()) break;
      const nextTeachers = admin.waitForResponse((response) => {
        const url = new URL(response.url());
        return url.pathname === "/api/v1/admin/bindings" &&
          url.searchParams.get("kind") === "teachers" && url.searchParams.has("after");
      });
      await bindings.getByRole("button", { name: "下一頁教師", exact: true }).click();
      expect((await nextTeachers).status()).toBe(200);
    }
    await expect(teacherSelect.locator(`option[value="${teacherMembership}"]`)).toHaveCount(1);
    await teacherSelect.selectOption(teacherMembership);
    await bindings.getByLabel("合格學生").selectOption(studentAccount.id);
    const createdResponse = admin.waitForResponse((response) =>
      new URL(response.url()).pathname === "/api/v1/admin/bindings" && response.request().method() === "POST");
    await bindings.getByRole("button", { name: "核對並建立綁定", exact: true }).press("Enter");
    await expect(admin.getByRole("dialog")).toBeVisible();
    await admin.getByRole("dialog").getByRole("button", {
      name: "明確確認並送出建立", exact: true,
    }).press("Enter");
    const created = await createdResponse;
    expect(created.status()).toBe(201);
    const bindingId = (await created.json()).binding_id as string;
    await createProductProject("101 關係後的產品操作");
    await expect(notice).toContainText("共 101 位");
    await expect(notice).toContainText("合成帳號BindingLimitTeacher101");

    const bindingSelect = bindings.getByLabel("既有綁定");
    for (let page = 0; page < 10; page++) {
      if (await bindingSelect.locator(`option[value="${bindingId}"]`).count()) break;
      const nextBindings = admin.waitForResponse((response) => {
        const url = new URL(response.url());
        return url.pathname === "/api/v1/admin/bindings" &&
          url.searchParams.get("kind") === "bindings" && url.searchParams.has("after");
      });
      await bindings.getByRole("button", { name: "下一頁關係", exact: true }).click();
      expect((await nextBindings).status()).toBe(200);
    }
    await expect(bindingSelect.locator(`option[value="${bindingId}"]`)).toHaveCount(1);
    await bindingSelect.selectOption(bindingId);
    await bindings.getByLabel("解除理由").fill("101 位提示驗收後解除");
    const endedResponse = admin.waitForResponse((response) =>
      new URL(response.url()).pathname === `/api/v1/admin/bindings/${bindingId}` &&
      response.request().method() === "DELETE");
    await bindings.getByRole("button", { name: "核對並解除綁定", exact: true }).press("Enter");
    await expect(admin.getByRole("dialog")).toBeVisible();
    await admin.getByRole("dialog").getByRole("button", {
      name: "明確確認並送出解除", exact: true,
    }).press("Enter");
    expect((await endedResponse).status()).toBe(200);
    await createProductProject("解除後的產品操作");
    await expect(notice).toContainText("共 100 位");
    await expect(notice).not.toContainText("合成帳號BindingLimitTeacher101");

    await control.query("UPDATE app.profiles SET status='disabled' WHERE id=$1", [extra[0]!.id]);
    await createProductProject("教師失權後的產品操作");
    await expect(notice).toContainText("共 99 位");
    await expect(notice).not.toContainText("合成帳號數量邊界老師001");

    const unrelated = await createSyntheticAuthAccount(control, "BindingUnrelatedStudent");
    accounts.push(unrelated);
    const unrelatedSession = await loginSyntheticAccount(unrelated);
    otherContext = await browser.newContext({ ignoreHTTPSErrors: true });
    await otherContext.addCookies([{ name: sessionCookieName, value: unrelatedSession.accessToken, url: origin,
      secure: true, httpOnly: true, sameSite: "Strict" }]);
    const unrelatedMe = await otherContext.request.get(`${origin}/api/v1/me`);
    expect(unrelatedMe.status()).toBe(200);
    expect(await unrelatedMe.json()).not.toHaveProperty("teacher_notice");
  } finally {
    await otherContext?.close();
    await adminContext?.close();
    await studentContext?.close();
    const ids = accounts.map((account) => account.id);
    if (ids.length) {
      await control.query("DELETE FROM app.binding_operation_receipts WHERE actor_id=ANY($1::uuid[])", [ids]);
      if (projectIds.length) {
        await control.query(`UPDATE app.projects SET classification_state='unconfirmed',tier=NULL,
          needs_visitor_identity=NULL,current_confirmation_id=NULL WHERE id=ANY($1::uuid[])`, [projectIds]);
        for (const table of ["stage_draft_confirmations", "stage_draft_idempotency", "stage_records",
          "project_classification_idempotency", "project_classification_confirmations", "project_requirements",
          "project_create_idempotency"]) {
          await control.query(`DELETE FROM app.${table} WHERE project_id=ANY($1::uuid[])`, [projectIds]);
        }
        await control.query("DELETE FROM app.projects WHERE id=ANY($1::uuid[])", [projectIds]);
      }
      await control.query("DELETE FROM app.teacher_student_bindings WHERE teacher_id=ANY($1::uuid[]) OR student_id=ANY($1::uuid[])", [ids]);
      await control.query("DELETE FROM app.teacher_school_memberships WHERE teacher_id=ANY($1::uuid[])", [ids]);
      await control.query(`DELETE FROM app.audit_events WHERE actor_aid IN
        (SELECT aid FROM app.audit_identity_map WHERE account_id=ANY($1::uuid[])) OR subject_aid IN
        (SELECT aid FROM app.audit_identity_map WHERE account_id=ANY($1::uuid[]))`, [ids]);
      await control.query("DELETE FROM app.audit_identity_map WHERE account_id=ANY($1::uuid[])", [ids]);
      await control.query("DELETE FROM app.profiles WHERE id=ANY($1::uuid[])", [ids]);
      await control.query("DELETE FROM app.schools WHERE id=ANY($1::uuid[])", [accounts.map((account) => account.schoolId)]);
      for (let offset = 0; offset < accounts.length; offset += 10) {
        await Promise.all(accounts.slice(offset, offset + 10).map(deleteSyntheticAuthAccount));
      }
    }
    await control.end();
  }
});
