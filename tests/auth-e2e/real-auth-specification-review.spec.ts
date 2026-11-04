import { expect, test, type Page, type Route } from "@playwright/test";
import { cleanupReviewActors, createReviewActors } from "../support/specification-review-fixture.ts";
import { loginSyntheticAccount, openControlPool } from "../support/real-auth-fixture.ts";
import { sessionCookieName } from "../../apps/web/src/server/auth-principal.ts";

test.use({ actionTimeout: 15_000 });
test("學生產品保存／送審→教師表單登入批准／退回→讀回、修改失效與 response-loss 原鍵恢復", async ({ browser }) => {
  test.setTimeout(300_000);
  const control = openControlPool();
  const actors = await createReviewActors(control);
  const studentSession = await loginSyntheticAccount(actors.student);
  const origin = process.env.APP_PLANET_APP_ORIGIN!;
  const studentContext = await browser.newContext({ locale: "zh-TW", ignoreHTTPSErrors: true });
  const teacherContext = await browser.newContext({ locale: "zh-TW", ignoreHTTPSErrors: true });
  const outsiderContext = await browser.newContext({ locale: "zh-TW", ignoreHTTPSErrors: true });
  const panel = (page: Page) => page.getByRole("region", { name: "Specification 提交與教師審查", exact: true });
  const waitMutation = (page: Page, path: string) => page.waitForResponse((r) =>
    new URL(r.url()).pathname === path && ["POST", "PUT"].includes(r.request().method()));
  const hydrationBoundary = async (page: Page, url: string, triggerName: string, mode: "submit" | "decide") => {
    let release!: () => void;
    const scripts = new Promise<void>((resolve) => { release = resolve; });
    let held = 0, writes = 0;
    const observe = (r: import("@playwright/test").Request) => { if (r.method() === "POST") writes++; };
    const hold = async (route: Route) => {
      if (route.request().resourceType() === "script") { held++; await scripts; }
      await route.continue();
    };
    page.on("request", observe);
    await page.route("**/*", hold);
    try {
      const response = await page.goto(url, { waitUntil: "commit" });
      expect(response?.status()).toBe(200);
      await response!.finished();
      await expect.poll(() => held).toBeGreaterThan(0);
      const trigger = page.getByRole("button", { name: triggerName, exact: true });
      const visible = await trigger.isVisible();
      let observed = "actual_disabled_control";
      if (visible) {
        await expect(trigger).toBeDisabled();
        const box = await trigger.boundingBox();
        expect(box).not.toBeNull();
        await page.mouse.click(box!.x + box!.width / 2, box!.y + box!.height / 2);
        await page.keyboard.press("Enter");
      } else {
        const fallback = page.getByRole("status").filter({
          hasText: /^(正在由伺服器確認登入、權限與專案資料…|正在重新確認存取權限；專案資料暫時隱藏。)$/,
          visible: true,
        });
        await expect(fallback).toHaveCount(1);
        observed = (await fallback.innerText()).includes("正在重新") ? "authorization_fallback_only" : "streaming_fallback_only";
      }
      await expect(page.getByRole("dialog")).toHaveCount(0);
      expect(writes).toBe(0);
      console.log(`HydrationBoundary=${mode};external_scripts_held=${held};visible=${observed};POST=0`);
    } finally {
      release();
      await page.unrouteAll({ behavior: "wait" });
      page.off("request", observe);
    }
    await page.waitForLoadState("domcontentloaded");
    if (mode === "submit") await expect(page.getByRole("button", { name: triggerName, exact: true })).toBeEnabled();
    else await expect(page.getByRole("radio", { name: "批准", exact: true })).toBeEnabled();
  };
  const cancelAndFocus = async (page: Page, triggerName: string, mode: string) => {
    const trigger = panel(page).getByRole("button", { name: triggerName, exact: true });
    let writes = 0;
    const observe = (r: import("@playwright/test").Request) => { if (r.method() === "POST") writes++; };
    page.on("request", observe);
    try {
      await expect(trigger).toBeEnabled();
      await trigger.click();
      await expect(page.getByRole("dialog")).toBeVisible();
      expect(writes).toBe(0);
      await page.getByRole("dialog").getByRole("button", { name: "取消，尚未送出", exact: true }).click();
      await expect(page.getByRole("dialog")).toHaveCount(0);
      await expect(trigger).toBeFocused();
      expect(writes).toBe(0);
      await trigger.press("Enter");
      await expect(page.getByRole("dialog")).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(page.getByRole("dialog")).toHaveCount(0);
      await expect(trigger).toBeFocused();
      expect(writes).toBe(0);
      console.log(`Confirmation=${mode};open_cancel_escape_POST=0;focus_returned_to_trigger`);
    } finally { page.off("request", observe); }
  };
  const loginTeacher = async (page: Page, account: typeof actors.teacher) => {
    await page.goto(`${origin}/login`);
    await expect(page.locator('form[data-ready="true"]')).toHaveCount(1);
    await page.getByLabel("電子郵件").fill(account.email);
    await page.getByLabel("密碼").fill(account.password);
    const response = waitMutation(page, "/api/v1/auth/staff/login");
    await page.getByRole("button", { name: "登入", exact: true }).press("Enter");
    expect((await response).status()).toBe(200);
    await expect(page).toHaveURL(`${origin}/teacher`);
  };
  try {
    // 學生 session／持久綁定為合成 setup；送審及決策一律產品 UI，不以 SQL 填批准。
    await studentContext.addCookies([{ name: sessionCookieName, value: studentSession.accessToken,
      url: origin, secure: true, httpOnly: true, sameSite: "Strict" }]);
    const student = await studentContext.newPage(), teacher = await teacherContext.newPage();
    let studentReviewPosts = 0, teacherReviewPosts = 0;
    student.on("request", (r) => {
      if (r.method() === "POST" && new URL(r.url()).pathname.endsWith("/Specification/submissions")) studentReviewPosts++;
    });
    teacher.on("request", (r) => {
      if (r.method() === "POST" && new URL(r.url()).pathname.endsWith("/decision")) teacherReviewPosts++;
    });
    await student.goto(`${origin}/student`);
    await student.getByLabel("專案名稱").fill("Specification 垂直產品驗收");
    const created = waitMutation(student, "/api/v1/projects");
    await student.getByRole("button", { name: "建立專案", exact: true }).click();
    const createdResponse = await created;
    expect(createdResponse.status()).toBe(201);
    const id = (await createdResponse.json()).id as string;
    await student.goto(`${origin}/student/projects/${id}/stages/A%2FB`);
    await student.getByLabel("正式需求說明").fill("按鈕顯示合成教學提示");
    const requirements = waitMutation(student, `/api/v1/projects/${id}/requirements`);
    await student.getByRole("button", { name: "保存正式需求", exact: true }).click();
    expect((await requirements).status()).toBe(200);
    await student.getByLabel("正式 A/B 分類", { exact: true }).selectOption("A");
    await student.getByLabel("需要識別訪客身分嗎", { exact: true }).selectOption("false");
    const classified = waitMutation(student, `/api/v1/projects/${id}/classification/confirmation`);
    await student.getByRole("button", { name: "明確確認正式分類", exact: true }).click();
    expect((await classified).status()).toBe(200);
    await student.goto(`${origin}/student/projects/${id}/stages/Specification`);
    await expect(panel(student).getByTestId("specification-review-state")).toContainText("尚未提交");
    await expect(panel(student).getByRole("button", { name: "提交已保存 Specification 給教師審查" })).toBeDisabled();
    const saveDraft = async (text: string) => {
      await student.getByLabel("階段草稿文字").fill(text);
      await expect(panel(student).getByRole("button", { name: "提交已保存 Specification 給教師審查" })).toBeDisabled();
      const saved = waitMutation(student, `/api/v1/projects/${id}/stages/Specification`);
      await student.getByRole("button", { name: "保存", exact: true }).click();
      expect([200, 201]).toContain((await saved).status());
      await expect(student.getByTestId("confirmed-server-draft")).toContainText(text);
    };
    await saveDraft("規格原文：按鈕顯示提示。");
    const noJs = await browser.newContext({ javaScriptEnabled: false, ignoreHTTPSErrors: true });
    try {
      await noJs.addCookies([{ name: sessionCookieName, value: studentSession.accessToken, url: origin,
        httpOnly: true, secure: true, sameSite: "Strict" }]);
      const ssr = await noJs.newPage();
      let writes = 0;
      ssr.on("request", (r) => { if (r.method() === "POST") writes++; });
      await ssr.goto(`${origin}/student/projects/${id}/stages/Specification`);
      await expect(ssr.locator("button:not([disabled])").filter({
        hasText: "提交已保存 Specification 給教師審查",
      })).toHaveCount(0);
      await expect(ssr.getByRole("dialog")).toHaveCount(0);
      expect(writes).toBe(0);
    } finally { await noJs.close(); }
    await hydrationBoundary(student, `${origin}/student/projects/${id}/stages/Specification`,
      "提交已保存 Specification 給教師審查", "submit");
    await cancelAndFocus(student, "提交已保存 Specification 給教師審查", "submit");
    const submit = async (loseResponse = false) => {
      await expect(panel(student).getByRole("button", { name: "提交已保存 Specification 給教師審查" })).toBeEnabled();
      await panel(student).getByRole("button", { name: "提交已保存 Specification 給教師審查" }).press("Enter");
      const dialog = student.getByRole("dialog");
      await expect(dialog).toContainText("明確確認送出已保存版本");
      if (loseResponse) {
        const path = `/api/v1/projects/${id}/stages/Specification/submissions`;
        const requests: { key: string | undefined; body: string | null }[] = [];
        student.on("request", (r) => {
          if (new URL(r.url()).pathname === path && r.method() === "POST") {
            requests.push({ key: r.headers()["idempotency-key"], body: r.postData() });
          }
        });
        await student.route(`**${path}`, async (route) => {
          const response = await route.fetch();
          expect(response.status()).toBe(200);
          await route.abort("failed");
        }, { times: 1 });
        await dialog.getByRole("button", { name: "確認送出", exact: true }).click();
        await expect(panel(student).getByRole("button", { name: "以原決定與原鍵重試" })).toBeVisible();
        await student.reload();
        const replayed = waitMutation(student, path);
        await panel(student).getByRole("button", { name: "以原決定與原鍵重試" }).click();
        const response = await replayed;
        expect(response.status()).toBe(200);
        expect(requests).toHaveLength(2);
        expect(requests[0]).toEqual(requests[1]);
        await expect(panel(student).getByTestId("specification-review-state")).toContainText("待審");
        return (await response.json()).submission_id as string;
      }
      const sent = waitMutation(student, `/api/v1/projects/${id}/stages/Specification/submissions`);
      await dialog.getByRole("button", { name: "確認送出", exact: true }).press("Enter");
      const response = await sent;
      expect(response.status()).toBe(200);
      const submission = (await response.json()).submission_id as string;
      await expect(panel(student).getByTestId("specification-review-state")).toContainText("待審");
      return submission;
    };
    const first = await submit();
    expect(studentReviewPosts).toBe(1);
    expect((await control.query("SELECT count(*)::int n FROM app.specification_submissions WHERE project_id=$1", [id])).rows[0].n).toBe(1);
    await loginTeacher(teacher, actors.teacher);
    await teacher.getByRole("region", { name: "Specification 待審清單" }).getByRole("link",
      { name: "Specification 垂直產品驗收 — Specification 版本 0" }).click();
    await expect(panel(teacher)).toContainText("規格原文：按鈕顯示提示。");
    await expect(panel(teacher)).toContainText("按鈕顯示合成教學提示");
    await hydrationBoundary(teacher, `${origin}/teacher/specification-submissions/${first}`, "核對審查決定", "decide");
    await teacher.getByRole("radio", { name: "批准", exact: true }).check();
    await cancelAndFocus(teacher, "核對審查決定", "approve");
    await panel(teacher).getByRole("button", { name: "核對審查決定" }).click();
    await expect(teacher.getByRole("dialog")).toContainText(first);
    const approved = waitMutation(teacher, `/api/v1/teacher/specification-submissions/${first}/decision`);
    await teacher.getByRole("dialog").getByRole("button", { name: "確認送出", exact: true }).press("Enter");
    expect((await approved).status()).toBe(200);
    expect(teacherReviewPosts).toBe(1);
    expect((await control.query("SELECT count(*)::int n FROM app.specification_decisions WHERE submission_id=$1", [first])).rows[0].n).toBe(1);
    await expect(panel(teacher).getByTestId("specification-review-state")).toContainText("已批准");
    await student.reload();
    await expect(panel(student).getByTestId("specification-review-state")).toContainText("已批准");

    const outsider = await outsiderContext.newPage();
    await loginTeacher(outsider, actors.outsider);
    await expect(outsider.getByRole("region", { name: "Specification 待審清單" })).not.toContainText("Specification 垂直產品驗收");
    await outsider.goto(`${origin}/teacher/specification-submissions/${first}`);
    await expect(outsider.getByText("規格原文：按鈕顯示提示。", { exact: true })).toHaveCount(0);

    await saveDraft("規格第二版：增加說明。");
    await expect(panel(student).getByTestId("specification-review-state")).toContainText("不再有效");
    await saveDraft("規格原文：按鈕顯示提示。");
    await expect(panel(student).getByTestId("specification-review-state")).toContainText("不再有效");
    const second = await submit();
    await teacher.goto(`${origin}/teacher/specification-submissions/${second}`);
    await teacher.getByRole("radio", { name: "退回", exact: true }).check();
    await teacher.getByLabel("學生可讀的退回理由").fill("請補充按鈕的鍵盤操作");
    await cancelAndFocus(teacher, "核對審查決定", "return");
    await panel(teacher).getByRole("button", { name: "核對審查決定" }).click();
    const decisionPath = `/api/v1/teacher/specification-submissions/${second}/decision`;
    const sentBodies: { body: string | null; key: string | undefined }[] = [];
    teacher.on("request", (r) => {
      if (new URL(r.url()).pathname === decisionPath && r.method() === "POST") {
        sentBodies.push({ body: r.postData(), key: r.headers()["idempotency-key"] });
      }
    });
    await teacher.route(`**${decisionPath}`, async (route) => {
      const response = await route.fetch();
      expect(response.status()).toBe(200);
      await route.abort("failed");
    }, { times: 1 });
    await teacher.getByRole("dialog").getByRole("button", { name: "確認送出", exact: true }).click();
    await expect(panel(teacher).getByRole("button", { name: "以原決定與原鍵重試" })).toBeVisible();
    await teacher.reload();
    await expect(panel(teacher)).toContainText("原決定：已退回");
    await panel(teacher).getByRole("button", { name: "以原決定與原鍵重試" }).click();
    await expect(panel(teacher).getByTestId("specification-review-state")).toContainText("已退回");
    expect(sentBodies).toHaveLength(2);
    expect(sentBodies[0]).toEqual(sentBodies[1]);
    await student.reload();
    await expect(panel(student)).toContainText("退回理由：請補充按鈕的鍵盤操作");
    await saveDraft("規格第三版：按 Enter 顯示提示。");
    const third = await submit(true);
    expect(third).not.toBe(second);
    const history = await control.query(`SELECT s.id,d.decision,d.reason FROM app.specification_submissions s
      LEFT JOIN app.specification_decisions d ON d.submission_id=s.id WHERE s.project_id=$1 ORDER BY s.sequence`, [id]);
    expect(history.rows).toEqual([
      { id: first, decision: "approved", reason: null },
      { id: second, decision: "returned", reason: "請補充按鈕的鍵盤操作" },
      { id: third, decision: null, reason: null },
    ]);
    expect((await control.query("SELECT stage FROM app.projects WHERE id=$1", [id])).rows[0].stage).toBe("點子");
    console.log("SpecificationVertical=student_UI_save_submit;teacher_form_login_UI_approve_return;reload_readback;immutable_history;response_loss_original_key_verified");
  } finally {
    await Promise.all([studentContext.close(), teacherContext.close(), outsiderContext.close()]);
    await cleanupReviewActors(control, actors);
    await control.end();
  }
});
