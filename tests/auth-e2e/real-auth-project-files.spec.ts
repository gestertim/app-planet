import { expect, test } from "@playwright/test";
import {
  createOwnedSyntheticProject,
  createSyntheticAuthAccount,
  loginSyntheticAccount,
  openControlPool,
} from "../support/real-auth-fixture.ts";
import { sessionCookieName } from "../../apps/web/src/server/auth-principal.ts";

test("學生以產品 Monaco 工作區保存、reload、快照檢視並處理未知結果與 CAS 衝突", async ({ browser }) => {
  test.setTimeout(180_000);
  const control = openControlPool();
  const account = await createSyntheticAuthAccount(control, "ProjectFilesE2E");
  const session = await loginSyntheticAccount(account);
  const projectId = await createOwnedSyntheticProject(account);
  const appOrigin = process.env.APP_PLANET_APP_ORIGIN;
  if (!appOrigin) throw new Error("隔離瀏覽器測試缺少本機 app origin。");
  const context = await browser.newContext({ locale: "zh-TW" });
  const secondContext = await browser.newContext({ locale: "zh-TW" });
  const cdnRequests: string[] = [];
  let page: import("@playwright/test").Page | null = null;
  try {
    const cookie = {
      name: sessionCookieName,
      value: session.accessToken,
      url: appOrigin,
      httpOnly: true,
      secure: true,
      sameSite: "Strict" as const,
    };
    await context.addCookies([cookie]);
    await secondContext.addCookies([cookie]);
    page = await context.newPage();
    page.on("request", (request) => {
      if (/cdn\.jsdelivr\.net|unpkg\.com/.test(request.url())) cdnRequests.push(request.url());
    });

    await page.goto(`${appOrigin}/student/projects/${projectId}/build`, {
      waitUntil: "domcontentloaded", timeout: 30_000,
    });
    const workspace = page.getByTestId("project-file-workspace");
    await expect(workspace).toBeVisible({ timeout: 15_000 });
    await expect(workspace).toContainText("目前沒有檔案", { timeout: 15_000 });
    await expect(page.locator("iframe")).toHaveCount(0);

    const createAndSave = async (path: string, text: string) => {
      await page!.getByLabel("新增檔案名稱").fill(path);
      await page!.getByRole("link", { name: "新增檔案", exact: true }).click();
      await expect(page!.getByRole("heading", { name: path, exact: true })).toBeVisible({ timeout: 15_000 });
      const editor = page!.getByRole("textbox", { name: `${path} 原始碼文字編輯器` });
      await expect(editor).toBeVisible({ timeout: 15_000 });
      await editor.press("Control+A", { timeout: 10_000 });
      await page!.keyboard.insertText(text);
      const saved = page!.waitForResponse((response) =>
        new URL(response.url()).pathname === `/api/v1/projects/${projectId}/files/${path}` &&
        response.request().method() === "PUT", { timeout: 20_000 });
      await page!.getByRole("button", { name: "保存到資料庫" }).click();
      const response = await saved;
      expect([200, 201]).toContain(response.status());
      await expect(page!.getByText(/DB 已保存版本：SHA-256/)).toBeVisible();
    };

    const html = "<!doctype html>\n<h1>學生作品你好 🌍</h1>";
    const css = "body { color: #123; }";
    const js = 'window.__student_source_is_text_only = "不可執行";';
    await createAndSave("index.html", html);
    await createAndSave("styles.css", css);
    await createAndSave("app.js", js);
    await page.reload();
    await expect(workspace.getByTestId("project-file-index.html")).toBeVisible();
    await expect(page.locator(".monaco-editor .view-lines")).toContainText("不可執行");
    expect(await page.evaluate(() => Object.hasOwn(window, "__student_source_is_text_only"))).toBe(false);

    const snapshotResponse = page.waitForResponse((response) =>
      new URL(response.url()).pathname === `/api/v1/projects/${projectId}/snapshots` &&
      response.request().method() === "POST", { timeout: 20_000 });
    await page.getByRole("button", { name: "建立 manual 快照" }).click();
    expect((await snapshotResponse).status()).toBe(201);
    await expect(page.getByRole("button", { name: /版本 1/ })).toBeVisible();
    await page.getByRole("button", { name: /版本 1/ }).click();
    await expect(page.getByRole("heading", { name: /manifest（唯讀）/ })).toBeVisible();
    await page.getByRole("button", { name: /index\.html/ }).last().click();
    await expect(page.locator("pre")).toContainText("學生作品你好 🌍");

    await page.getByLabel("新增檔案名稱").fill("unsaved.css");
    await page.getByRole("link", { name: "新增檔案", exact: true }).click();
    const unsavedEditor = page.getByRole("textbox", { name: "unsaved.css 原始碼文字編輯器" });
    await expect(unsavedEditor).toBeVisible({ timeout: 15_000 });
    await unsavedEditor.press("Control+A", { timeout: 10_000 });
    await page.keyboard.insertText("body { color: red; }");
    const createSnapshot = page.getByRole("button", { name: "建立 manual 快照" });
    await expect(createSnapshot).toBeDisabled();
    await expect(page.getByText(/有未保存內容；先保存，再建立快照/)).toBeVisible();
    await page.getByRole("button", { name: "保存到資料庫" }).click();
    await expect(createSnapshot).toBeEnabled();

    const secondPage = await secondContext.newPage();
    await secondPage.goto(`${appOrigin}/student/projects/${projectId}/build#file=index.html`);
    const secondEditor = secondPage.getByRole("textbox", { name: "index.html 原始碼文字編輯器" });
    await expect(secondEditor).toBeVisible({ timeout: 15_000 });
    await expect(secondPage.locator(".monaco-editor .view-lines")).toContainText("學生作品你好 🌍");
    await secondEditor.press("Control+A", { timeout: 10_000 });
    await secondPage.keyboard.insertText("<h1>另一個 context 的舊版本</h1>");

    await page.getByTestId("project-file-index.html").click();
    const firstEditor = page.getByRole("textbox", { name: "index.html 原始碼文字編輯器" });
    await expect(page.locator(".monaco-editor .view-lines")).toContainText("學生作品你好 🌍");
    await firstEditor.press("Control+A", { timeout: 10_000 });
    await page.keyboard.insertText("<h1>第一個 context 的新版本</h1>");
    const firstSave = page.waitForResponse((response) =>
      new URL(response.url()).pathname === `/api/v1/projects/${projectId}/files/index.html` &&
      response.request().method() === "PUT", { timeout: 20_000 });
    await page.getByRole("button", { name: "保存到資料庫" }).click();
    expect((await firstSave).status()).toBe(200);
    const staleSave = secondPage.waitForResponse((response) =>
      new URL(response.url()).pathname === `/api/v1/projects/${projectId}/files/index.html` &&
      response.request().method() === "PUT", { timeout: 20_000 });
    await secondPage.getByRole("button", { name: "保存到資料庫" }).click();
    expect((await staleSave).status()).toBe(409);
    await expect(secondPage.getByRole("region", { name: "版本衝突比對" })).toBeVisible();
    await expect(secondPage.locator(".monaco-editor .view-lines")).toContainText("另一個 context 的舊版本");
    await secondPage.getByText("查看最新伺服器原文（純文字）").click();
    await expect(secondPage.locator("details[open] pre"))
      .toContainText("<h1>第一個 context 的新版本</h1>");

    await page.getByRole("button", { name: /版本 1/ }).click();
    await page.getByRole("button", { name: /index\.html/ }).last().click();
    await expect(page.locator("pre")).toContainText("學生作品你好 🌍");
    await expect(page.locator("pre")).not.toContainText("第一個 context 的新版本");

    await page.getByLabel("新增檔案名稱").fill("lost-response.js");
    await page.getByRole("link", { name: "新增檔案", exact: true }).click();
    const lostEditor = page.getByRole("textbox", { name: "lost-response.js 原始碼文字編輯器" });
    await expect(lostEditor).toBeVisible({ timeout: 15_000 });
    await lostEditor.press("Control+A", { timeout: 10_000 });
    await page.keyboard.insertText("response committed, reply lost");
    let committedStatus: number | null = null;
    await page.route(`**/api/v1/projects/${projectId}/files/lost-response.js`, async (route) => {
      const response = await route.fetch();
      committedStatus = response.status();
      await route.abort("connectionreset");
    }, { times: 1 });
    await page.getByRole("button", { name: "保存到資料庫" }).click();
    await expect(page.getByText(/保存結果未知/)).toBeVisible();
    expect(committedStatus).toBe(201);
    await page.reload();
    await expect(page.locator(".monaco-editor .view-lines")).toContainText("response committed, reply lost");
    const replay = page.waitForResponse((response) =>
      new URL(response.url()).pathname === `/api/v1/projects/${projectId}/files/lost-response.js` &&
      response.request().method() === "PUT", { timeout: 20_000 });
    await page.getByRole("button", { name: "使用原操作重試" }).click();
    expect((await replay).status()).toBe(200);
    await expect(page.getByText(/目前內容與已保存版本一致。/)).toBeVisible();
    expect(cdnRequests).toEqual([]);
    expect((await control.query(
      "SELECT count(*)::int AS count FROM app.project_files WHERE project_id=$1 AND path='lost-response.js'",
      [projectId],
    )).rows[0].count).toBe(1);
  } finally {
    await page?.close();
    await context.close();
    await secondContext.close();
    await control.end();
  }
});
