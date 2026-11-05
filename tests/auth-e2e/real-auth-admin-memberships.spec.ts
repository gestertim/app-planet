import { randomUUID } from "node:crypto";
import { expect, test, type Page, type Request as BrowserRequest } from "@playwright/test";
import { sessionCookieName } from "../../apps/web/src/server/auth-principal.ts";
import { createSyntheticAuthAccount, loginSyntheticAccount, openControlPool,
  type SyntheticAuthAccount } from "../support/real-auth-fixture.ts";
import { cleanupReviewActors } from "../support/specification-review-fixture.ts";

test.use({ actionTimeout: 15_000 });
test("真 HTTPS 管理員表單登入→歸屬 UI→綁定 UI→教師登入／查看／批准→歸屬結束／新 ID 重加不復活", async ({ browser }) => {
  test.setTimeout(300_000);
  const control = openControlPool(), origin = process.env.APP_PLANET_APP_ORIGIN!;
  const [studentAccount, otherStudent, teacherAccount, outsider, adminAccount] = await Promise.all([
    "MembershipStudent", "MembershipOtherStudent", "MembershipTeacher", "MembershipOutsider", "MembershipAdmin",
  ].map((label) => createSyntheticAuthAccount(control, label)));
  await control.query("UPDATE app.profiles SET role='teacher' WHERE id=ANY($1::uuid[])", [[teacherAccount.id, outsider.id]]);
  await control.query("UPDATE app.profiles SET role='admin' WHERE id=$1", [adminAccount.id]);
  const actors = { student: studentAccount, otherStudent, teacher: teacherAccount, outsider, admin: adminAccount,
    binding: randomUUID(), membership: randomUUID() };
  const [studentContext, teacherContext, adminContext] = await Promise.all([1, 2, 3].map(() =>
    browser.newContext({ locale: "zh-TW", ignoreHTTPSErrors: true })));
  const [student, teacher, admin] = await Promise.all([studentContext, teacherContext, adminContext].map((c) => c.newPage()));
  const region = () => admin.getByRole("region", { name: "教師學校歸屬", exact: true });
  const review = (p: Page) => p.getByRole("region", { name: "Specification 提交與教師審查", exact: true });
  const path = "/api/v1/admin/teacher-school-memberships";
  const response = (p: Page, url: string, method: string) => p.waitForResponse((r) =>
    new URL(r.url()).pathname === url && r.request().method() === method);
  const login = async (p: Page, account: SyntheticAuthAccount, role: "admin" | "teacher") => {
    await p.goto(`${origin}/login`);
    await expect(p.locator('form[data-ready="true"]')).toHaveCount(1);
    await p.getByLabel("電子郵件").fill(account.email);
    await p.getByLabel("密碼").fill(account.password);
    const sent = response(p, "/api/v1/auth/staff/login", "POST");
    await p.getByRole("button", { name: "登入", exact: true }).press("Enter");
    expect((await sent).status()).toBe(200); await expect(p).toHaveURL(`${origin}/${role}`);
  };
  const studentSetup = async () => {
    const session = await loginSyntheticAccount(studentAccount);
    await studentContext.addCookies([{ name: sessionCookieName, value: session.accessToken, url: origin,
      secure: true, httpOnly: true, sameSite: "Strict" }]);
  };
  let writes = 0;
  const watch = (r: BrowserRequest) => { if (new URL(r.url()).pathname.startsWith(path) && ["POST", "DELETE"].includes(r.method())) writes++; };
  admin.on("request", watch);
  const selectPair = async () => {
    await expect(region().getByRole("combobox", { name: "合格教師", exact: true })).toBeEnabled();
    await region().getByRole("combobox", { name: "合格教師", exact: true }).selectOption(teacherAccount.id);
    await region().getByRole("combobox", { name: "合格學校", exact: true }).selectOption(studentAccount.schoolId);
  };
  const cancel = async (name: string) => {
    const trigger = region().getByRole("button", { name, exact: true });
    const before = writes;
    await trigger.press("Enter"); await expect(admin.getByRole("dialog")).toBeVisible();
    await admin.getByRole("dialog").getByRole("button", { name: "取消，尚未送出", exact: true }).press("Enter");
    await expect(admin.getByRole("dialog")).toHaveCount(0); await expect(trigger).toBeFocused();
    await trigger.press("Enter"); await admin.keyboard.press("Escape");
    await expect(admin.getByRole("dialog")).toHaveCount(0); await expect(trigger).toBeFocused();
    expect(writes).toBe(before);
  };
  const mutate = async (kind: "create" | "end", id?: string, loss = false) => {
    const url = path + (kind === "end" ? `/${id}` : ""), method = kind === "end" ? "DELETE" : "POST";
    const calls: { key?: string; body: string | null; url: string }[] = [];
    const observe = (r: BrowserRequest) => {
      if (new URL(r.url()).pathname === url && r.method() === method)
        calls.push({ key: r.headers()["idempotency-key"], body: r.postData(), url: new URL(r.url()).pathname });
    };
    admin.on("request", observe);
    try {
      await region().getByRole("button", { name: kind === "create" ? "核對並建立歸屬" : "核對並結束歸屬", exact: true }).press("Enter");
      await expect(admin.getByRole("dialog")).toContainText("合成帳號MembershipTeacher");
      await expect(admin.getByRole("dialog")).toContainText(studentAccount.schoolId);
      if (kind === "end") await expect(admin.getByRole("dialog")).toContainText(id!);
      if (loss) await admin.route(`**${url}`, async (route) => {
        const upstream = await route.fetch();
        expect(upstream.status()).toBe(kind === "create" ? 201 : 200);
        await route.abort("failed");
      }, { times: 1 });
      const sent = loss ? null : response(admin, url, method);
      await admin.getByRole("dialog").getByRole("button", {
        name: kind === "create" ? "明確確認並送出建立" : "明確確認並送出結束", exact: true,
      }).press("Enter");
      if (!loss) {
        const result = await sent!; expect(result.status()).toBe(kind === "create" ? 201 : 200);
        return (await result.json()).membership_id as string;
      }
      await expect(region().getByRole("button", { name: "以原對象與原鍵重試", exact: true })).toBeVisible();
      const committed = await control.query("SELECT id FROM app.teacher_school_memberships WHERE teacher_id=$1 AND school_id=$2 AND state='active'",
        [teacherAccount.id, studentAccount.schoolId]);
      expect(committed.rowCount).toBe(1);
      await admin.reload();
      await expect(region().getByRole("button", { name: "以原對象與原鍵重試", exact: true })).toBeVisible();
      const replay = response(admin, url, method);
      await region().getByRole("button", { name: "以原對象與原鍵重試", exact: true }).press("Enter");
      const result = await replay; expect(result.status()).toBe(200);
      expect(result.headers()["idempotent-replay"]).toBe("true"); expect(calls).toHaveLength(2); expect(calls[0]).toEqual(calls[1]);
      return (await result.json()).membership_id as string;
    } finally { admin.off("request", observe); }
  };
  let releaseScripts = () => {};
  try {
    expect((await control.query("SELECT 1 FROM app.teacher_school_memberships WHERE teacher_id=$1", [teacherAccount.id])).rowCount).toBe(0);
    await login(admin, adminAccount, "admin");
    await expect(admin.getByRole("link", { name: "教師學校歸屬", exact: true })).toHaveAttribute("href", "/admin/teacher-school-memberships");
    let held = 0;
    const scripts = new Promise<void>((resolve) => { releaseScripts = resolve; });
    await admin.route("**/*", async (route) => {
      if (route.request().resourceType() === "script") { held++; await scripts; }
      await route.continue();
    });
    // 真 SSR：攔住新文件 scripts，不靠設定 data-ready 模擬 hydration。
    const initial = await admin.goto(`${origin}/admin/teacher-school-memberships`, { waitUntil: "commit" });
    expect(initial?.status()).toBe(200); await initial!.finished();
    await expect.poll(() => held).toBeGreaterThan(0);
    await expect(region().getByRole("button", { name: "核對並建立歸屬", exact: true })).toBeDisabled();
    await expect(region().getByRole("button", { name: "核對並結束歸屬", exact: true })).toBeDisabled();
    await admin.keyboard.press("Enter"); await admin.keyboard.press("Escape"); expect(writes).toBe(0);
    releaseScripts(); await admin.unrouteAll({ behavior: "wait" });
    await selectPair(); await cancel("核對並建立歸屬");
    const firstMembership = await mutate("create", undefined, true);
    await admin.reload();
    await expect(region().getByTestId(`membership-${firstMembership}`)).toContainText("有效 active");
    expect((await control.query("SELECT 1 FROM app.teacher_student_bindings WHERE teacher_id=$1", [teacherAccount.id])).rowCount).toBe(0);
    await admin.getByRole("link", { name: "師生綁定", exact: true }).click();
    const bindings = admin.getByRole("region", { name: "師生綁定管理", exact: true });
    await expect(bindings.getByLabel("合格教師與學校")).toBeEnabled();
    await bindings.getByLabel("合格教師與學校").selectOption(firstMembership);
    await expect(bindings.getByLabel("合格學生").locator(`option[value="${studentAccount.id}"]`)).toHaveCount(1);
    await bindings.getByLabel("合格學生").selectOption(studentAccount.id);
    await bindings.getByRole("button", { name: "核對並建立綁定", exact: true }).press("Enter");
    const bindingResponse = response(admin, "/api/v1/admin/bindings", "POST");
    await admin.getByRole("dialog").getByRole("button", { name: "明確確認並送出建立", exact: true }).press("Enter");
    const bindingResult = await bindingResponse; expect(bindingResult.status()).toBe(201);
    const binding = (await bindingResult.json()).binding_id as string;

    await studentSetup(); await student.goto(`${origin}/student`);
    await student.getByLabel("專案名稱").fill("教師歸屬完整產品驗收");
    const created = response(student, "/api/v1/projects", "POST");
    await student.getByRole("button", { name: "建立專案", exact: true }).click();
    const project = (await (await created).json()).id as string;
    await student.goto(`${origin}/student/projects/${project}/stages/A%2FB`);
    await student.getByLabel("正式需求說明").fill("教師歸屬學習提示按鈕");
    const saved = response(student, `/api/v1/projects/${project}/requirements`, "PUT");
    await student.getByRole("button", { name: "保存正式需求", exact: true }).click(); expect((await saved).status()).toBe(200);
    await student.getByLabel("正式 A/B 分類", { exact: true }).selectOption("A");
    await student.getByLabel("需要識別訪客身分嗎", { exact: true }).selectOption("false");
    const classified = response(student, `/api/v1/projects/${project}/classification/confirmation`, "POST");
    await student.getByRole("button", { name: "明確確認正式分類", exact: true }).click(); expect((await classified).status()).toBe(200);
    await student.goto(`${origin}/student/projects/${project}/stages/Specification`);
    await student.getByLabel("階段草稿文字").fill("歸屬結束不復活舊批准");
    const draft = response(student, `/api/v1/projects/${project}/stages/Specification`, "PUT");
    await student.getByRole("button", { name: "保存", exact: true }).click(); expect((await draft).status()).toBe(201);
    const submitTrigger = review(student).getByRole("button", { name: "提交已保存 Specification 給教師審查", exact: true });
    await expect(submitTrigger).toBeEnabled();
    await submitTrigger.press("Enter");
    const submitted = response(student, `/api/v1/projects/${project}/stages/Specification/submissions`, "POST");
    await student.getByRole("dialog").getByRole("button", { name: "確認送出", exact: true }).press("Enter");
    const submission = (await (await submitted).json()).submission_id as string;

    await login(teacher, teacherAccount, "teacher");
    await teacher.goto(`${origin}/teacher/students/${studentAccount.id}/projects/${project}`);
    await expect(teacher.getByText("教師歸屬學習提示按鈕", { exact: true })).toBeVisible();
    await teacher.goto(`${origin}/teacher/specification-submissions/${submission}`);
    await expect(review(teacher)).toContainText("歸屬結束不復活舊批准");
    await teacher.getByRole("radio", { name: "批准", exact: true }).check();
    await review(teacher).getByRole("button", { name: "核對審查決定", exact: true }).click();
    const decided = response(teacher, `/api/v1/teacher/specification-submissions/${submission}/decision`, "POST");
    await teacher.getByRole("dialog").getByRole("button", { name: "確認送出", exact: true }).press("Enter");
    expect((await decided).status()).toBe(200);
    await studentSetup();
    await review(student).getByRole("button", { name: "重新讀取審查狀態", exact: true }).click();
    await expect(review(student).getByTestId("specification-review-state")).toContainText("已批准");
    const history = (await control.query("SELECT to_jsonb(d)::text exact_row FROM app.specification_decisions d WHERE submission_id=$1", [submission])).rows;
    await login(admin, adminAccount, "admin");
    await admin.getByRole("link", { name: "教師學校歸屬", exact: true }).click();
    await expect(region().getByRole("combobox", { name: "要結束的有效歸屬", exact: true })).toBeEnabled();
    await region().getByRole("combobox", { name: "要結束的有效歸屬", exact: true }).selectOption(firstMembership);
    await cancel("核對並結束歸屬"); expect(await mutate("end", firstMembership)).toBe(firstMembership);
    await admin.reload(); await expect(region().getByTestId(`membership-${firstMembership}`)).toContainText("已結束 ended");
    await login(teacher, teacherAccount, "teacher");
    expect((await teacherContext.request.get(`${origin}/api/v1/teacher/students/${studentAccount.id}/projects/${project}`)).status()).toBe(404);
    expect((await teacherContext.request.post(`${origin}/api/v1/teacher/specification-submissions/${submission}/decision`, {
      headers: { origin, "idempotency-key": randomUUID() }, data: { decision: "approved", reason: null },
    })).status()).toBe(404);
    await studentSetup();
    await review(student).getByRole("button", { name: "重新讀取審查狀態", exact: true }).click();
    await expect(review(student).getByTestId("specification-review-state")).toContainText("不再有效");
    await selectPair();
    const rejoined = await mutate("create"); expect(rejoined).not.toBe(firstMembership);
    await admin.reload();
    await expect(region().getByTestId(`membership-${rejoined}`)).toContainText("有效 active");
    await expect(region().getByTestId(`membership-${firstMembership}`)).toContainText("已結束 ended");
    await teacher.goto(`${origin}/teacher/students/${studentAccount.id}/projects/${project}`);
    await expect(teacher.getByText("教師歸屬學習提示按鈕", { exact: true })).toBeVisible();
    await studentSetup();
    await review(student).getByRole("button", { name: "重新讀取審查狀態", exact: true }).click();
    await expect(review(student).getByTestId("specification-review-state")).toContainText("不再有效");
    expect((await control.query("SELECT to_jsonb(d)::text exact_row FROM app.specification_decisions d WHERE submission_id=$1", [submission])).rows).toEqual(history);
    expect((await control.query("SELECT state FROM app.teacher_student_bindings WHERE id=$1", [binding])).rows[0].state).toBe("active");
    expect(writes).toBe(4);
    console.log("MembershipHTTPS=admin_teacher_product_form_login;create_end_rejoin_UI;binding_UI;teacher_reader_Specification;student_invalidated;new_ID;history_unchanged;loss_original_key_body;SSR_cancel_Escape_focus;writes=4;school_approval_student_login_code_not_E2E");
  } finally {
    releaseScripts();
    for (const context of [studentContext, teacherContext, adminContext]) await context.close();
    await control.query("DELETE FROM app.membership_operation_receipts WHERE actor_id=$1", [adminAccount.id]);
    await control.query("DELETE FROM app.binding_operation_receipts WHERE actor_id=$1", [adminAccount.id]);
    await cleanupReviewActors(control, actors); await control.end();
  }
});
