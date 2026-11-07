import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import {
  createOwnedSyntheticProject,
  createSyntheticAuthAccount,
  loginSyntheticAccount,
  openControlPool,
  type SyntheticAuthAccount,
} from "../support/real-auth-fixture.ts";
import { sessionCookieName } from "../../apps/web/src/server/auth-principal.ts";

test("學生以產品 Monaco 工作區保存、reload、快照檢視並處理未知結果與 CAS 衝突", async ({ browser }) => {
  test.setTimeout(300_000);
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
  // 隔離 runner 的 jwt_expiry=60；長流程沿用既有合成 session 續期 setup（非學生產品登入）。
  let renewalError: unknown = null;
  const renewSession = async () => {
    const renewed = await loginSyntheticAccount(account);
    for (const target of [context, secondContext]) {
      await target.addCookies([{ name: sessionCookieName, value: renewed.accessToken, url: appOrigin,
        httpOnly: true, secure: true, sameSite: "Strict" }]);
    }
  };
  const sessionRenewal = setInterval(() => { renewSession().catch((error) => { renewalError = error; }); }, 30_000);
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
    // times:1 路由耗盡時 Playwright 會以未等待的空攔截模式更新，可能與緊接註冊的下一個路由競速而停用攔截；
    // 以不改變請求的 fallback 路由維持攔截啟用，個別 hold／注入仍各只攔一次。
    await page.route(`**/api/v1/projects/${projectId}/**`, (route) => route.fallback());
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
    const createSnapshotButton = page.getByRole("button", { name: "建立 manual 快照" });
    await expect(createSnapshotButton).toBeEnabled();
    await createSnapshotButton.click();
    const firstSnapshotResponse = await snapshotResponse;
    expect(firstSnapshotResponse.status()).toBe(201);
    const firstSnapshotId = (await firstSnapshotResponse.json()).id as string;
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

    const secondSnapshotResponse = page.waitForResponse((response) =>
      new URL(response.url()).pathname === `/api/v1/projects/${projectId}/snapshots` &&
      response.request().method() === "POST", { timeout: 20_000 });
    await expect(createSnapshotButton).toBeEnabled();
    await createSnapshotButton.click();
    const secondSnapshotResult = await secondSnapshotResponse;
    expect(secondSnapshotResult.status()).toBe(201);
    const secondSnapshotId = (await secondSnapshotResult.json()).id as string;
    expect(secondSnapshotId).toMatch(/^[0-9a-f-]{36}$/i);
    await expect(page.getByRole("button", { name: /版本 2/ })).toBeVisible();

    let failedSnapshotKey = "";
    await page.route(`**/api/v1/projects/${projectId}/snapshots`, async (route) => {
      failedSnapshotKey = route.request().headers()["idempotency-key"] ?? "";
      await route.fulfill({
        status: 507,
        contentType: "application/problem+json",
        body: JSON.stringify({
          type: "about:blank", title: "容量防護拒絕", status: 507, code: "storage_limit",
          instance: `/api/v1/projects/${projectId}/snapshots`, request_id: "synthetic-storage-limit",
          user_message_zh: "整筆未建立。",
        }),
      });
    }, { times: 1 });
    const storageRejected = page.waitForResponse((response) =>
      new URL(response.url()).pathname === `/api/v1/projects/${projectId}/snapshots` &&
      response.request().method() === "POST", { timeout: 20_000 });
    await page.getByRole("button", { name: "建立 manual 快照" }).click();
    expect((await storageRejected).status()).toBe(507);
    expect(failedSnapshotKey).toMatch(/^[0-9a-f-]{36}$/i);
    await expect(page.getByText(/已確認整筆未建立，沒有部分快照/)).toBeVisible();
    expect(await page.evaluate((id) =>
      Object.keys(window.sessionStorage).filter((key) => key.endsWith(`.${id}.pending`)), projectId))
      .toEqual([]);
    expect((await control.query(
      "SELECT count(*)::int AS count FROM app.snapshots WHERE project_id=$1", [projectId],
    )).rows[0]?.count).toBe(2);
    const nextSnapshotResponse = page.waitForResponse((response) =>
      new URL(response.url()).pathname === `/api/v1/projects/${projectId}/snapshots` &&
      response.request().method() === "POST", { timeout: 20_000 });
    await expect(createSnapshotButton).toBeEnabled();
    await createSnapshotButton.click();
    expect((await nextSnapshotResponse).status()).toBe(201);
    expect((await nextSnapshotResponse).request().headers()["idempotency-key"]).not.toBe(failedSnapshotKey);
    await expect(page.getByRole("button", { name: /版本 3/ })).toBeVisible();

    let committedSnapshotStatus: number | null = null;
    let committedSnapshotKey = "";
    await page.route(`**/api/v1/projects/${projectId}/snapshots`, async (route) => {
      committedSnapshotKey = route.request().headers()["idempotency-key"] ?? "";
      const response = await route.fetch();
      committedSnapshotStatus = response.status();
      await route.abort("connectionreset");
    }, { times: 1 });
    await createSnapshotButton.click();
    await expect(page.getByText(/快照結果未知/)).toBeVisible();
    expect(committedSnapshotStatus).toBe(201);
    expect(committedSnapshotKey).toMatch(/^[0-9a-f-]{36}$/i);
    const snapshotRetry = page.getByRole("button", { name: "以原操作重試快照" });
    await page.reload();
    await expect(snapshotRetry).toBeEnabled();
    const replaySnapshotResponse = page.waitForResponse((response) =>
      new URL(response.url()).pathname === `/api/v1/projects/${projectId}/snapshots` &&
      response.request().method() === "POST", { timeout: 20_000 });
    await snapshotRetry.click();
    const replayedSnapshot = await replaySnapshotResponse;
    expect(replayedSnapshot.status()).toBe(200);
    expect(replayedSnapshot.request().headers()["idempotency-key"]).toBe(committedSnapshotKey);
    expect(replayedSnapshot.request().headers()["idempotency-replay-only"]).toBe("true");
    await expect(page.getByRole("button", { name: /版本 4/ })).toBeVisible();
    expect((await control.query(
      "SELECT count(*)::int AS count FROM app.snapshots WHERE project_id=$1", [projectId],
    )).rows[0]?.count).toBe(4);

    const unrecoverableProblem = {
      type: "about:blank", title: "操作結果無法安全確認", status: 409,
      code: "operation_outcome_unrecoverable",
      instance: `/api/v1/projects/${projectId}/snapshots`, request_id: "synthetic-unrecoverable",
      user_message_zh: "請人工核對。",
    };
    const unrecoverableKeys: string[] = [];
    const rejectSnapshotAsUnrecoverable = async (route: import("@playwright/test").Route) => {
      await route.fulfill({
        status: 409, contentType: "application/problem+json",
        body: JSON.stringify(unrecoverableProblem),
      });
    };
    await page.route(`**/api/v1/projects/${projectId}/snapshots`, async (route) => {
      unrecoverableKeys.push(route.request().headers()["idempotency-key"] ?? "");
      await rejectSnapshotAsUnrecoverable(route);
    }, { times: 1 });
    const firstUnrecoverable = page.waitForResponse((response) =>
      new URL(response.url()).pathname === `/api/v1/projects/${projectId}/snapshots` &&
      response.request().method() === "POST", { timeout: 20_000 });
    await createSnapshotButton.click();
    expect((await firstUnrecoverable).status()).toBe(409);
    await expect(page.getByRole("button", { name: "原快照操作受控停止" })).toBeDisabled();
    const pendingSnapshotKeys = await page.evaluate((id) =>
      Object.keys(window.sessionStorage).filter((key) => key.endsWith(`.${id}.pending`)), projectId);
    expect(pendingSnapshotKeys).toHaveLength(1);
    const unrecoverableStorageValue = await page.evaluate((key) =>
      window.sessionStorage.getItem(key), pendingSnapshotKeys[0]!);
    await page.reload();
    const retrySnapshotButton = page.getByRole("button", { name: "以原操作重試快照" });
    await expect(retrySnapshotButton).toBeEnabled();
    let replayOnlyHeader = "";
    await page.route(`**/api/v1/projects/${projectId}/snapshots`, async (route) => {
      unrecoverableKeys.push(route.request().headers()["idempotency-key"] ?? "");
      replayOnlyHeader = route.request().headers()["idempotency-replay-only"] ?? "";
      await rejectSnapshotAsUnrecoverable(route);
    }, { times: 1 });
    const replayUnrecoverable = page.waitForResponse((response) =>
      new URL(response.url()).pathname === `/api/v1/projects/${projectId}/snapshots` &&
      response.request().method() === "POST", { timeout: 20_000 });
    await retrySnapshotButton.click();
    expect((await replayUnrecoverable).status()).toBe(409);
    expect(unrecoverableKeys).toHaveLength(2);
    expect(unrecoverableKeys[1]).toBe(unrecoverableKeys[0]);
    expect(replayOnlyHeader).toBe("true");
    expect(await page.evaluate((key) => window.sessionStorage.getItem(key), pendingSnapshotKeys[0]!))
      .toBe(unrecoverableStorageValue);
    await expect(page.getByRole("button", { name: "原快照操作受控停止" })).toBeDisabled();

    // 診斷：hold 等待設期限並記錄 handler／route.fetch 狀態，避免無期限等待掩蓋實際失敗原因。
    const holdDiagnostics: string[] = [];
    const holdDeadline = async (pending: Promise<void>, label: string) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([pending, new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`${label} 未在期限內抵達 hold；${holdDiagnostics.join(" | ") || "handler 未被呼叫"}`)), 30_000);
        })]);
      } finally {
        clearTimeout(timer);
      }
    };
    const observeSnapshotRead = (request: import("@playwright/test").Request) => {
      if (request.method() === "GET" && new URL(request.url()).pathname.includes(`/snapshots/${firstSnapshotId}/`)) {
        holdDiagnostics.push(`request:${new URL(request.url()).pathname.split("/").slice(-2).join("/")}`);
      }
    };
    page.on("request", observeSnapshotRead);
    page.on("requestfailed", (request) => {
      if (new URL(request.url()).pathname.includes(`/snapshots/${firstSnapshotId}/`)) {
        holdDiagnostics.push(`requestfailed:${request.failure()?.errorText ?? "unknown"}`);
      }
    });
    let releaseFirstManifest!: () => void;
    let firstManifestReady!: () => void;
    const firstManifestFetched = new Promise<void>((resolve) => { firstManifestReady = resolve; });
    const firstManifestRelease = new Promise<void>((resolve) => { releaseFirstManifest = resolve; });
    await page.route(
      `**/api/v1/projects/${projectId}/snapshots/${firstSnapshotId}/manifest`,
      async (route) => {
        holdDiagnostics.push("manifest-handler");
        const upstream = await route.fetch().catch((error: unknown) => {
          holdDiagnostics.push(`manifest-fetch-error:${String(error).split("\n")[0]}`);
          throw error;
        });
        holdDiagnostics.push(`manifest-upstream:${upstream.status()}`);
        firstManifestReady();
        await firstManifestRelease;
        await route.fulfill({ response: upstream });
      },
      { times: 1 },
    );
    await page.getByRole("button", { name: /版本 1/ }).click();
    await holdDeadline(firstManifestFetched, "版本 1 manifest");
    await page.getByRole("button", { name: /版本 2/ }).click();
    await expect(page.getByRole("heading", { name: "版本 2 manifest（唯讀）" })).toBeVisible();
    releaseFirstManifest();
    await expect(page.getByRole("heading", { name: "版本 2 manifest（唯讀）" })).toBeVisible();

    let releaseFirstFile!: () => void;
    let firstFileReady!: () => void;
    const firstFileFetched = new Promise<void>((resolve) => { firstFileReady = resolve; });
    const firstFileRelease = new Promise<void>((resolve) => { releaseFirstFile = resolve; });
    await page.route(
      `**/api/v1/projects/${projectId}/snapshots/${firstSnapshotId}/files/index.html`,
      async (route) => {
        holdDiagnostics.push("file-handler");
        const upstream = await route.fetch().catch((error: unknown) => {
          holdDiagnostics.push(`file-fetch-error:${String(error).split("\n")[0]}`);
          throw error;
        });
        holdDiagnostics.push(`file-upstream:${upstream.status()}`);
        firstFileReady();
        await firstFileRelease;
        await route.fulfill({ response: upstream });
      },
      { times: 1 },
    );
    await page.getByRole("button", { name: /版本 1/ }).click();
    await expect(page.getByRole("heading", { name: "版本 1 manifest（唯讀）" })).toBeVisible();
    await page.getByRole("button", { name: /index\.html/ }).last().click();
    await holdDeadline(firstFileFetched, "版本 1 index.html");
    await page.getByRole("button", { name: /版本 2/ }).click();
    await expect(page.getByRole("heading", { name: "版本 2 manifest（唯讀）" })).toBeVisible();
    await page.getByRole("button", { name: /index\.html/ }).last().click();
    await expect(page.locator("pre")).toContainText("第一個 context 的新版本");
    releaseFirstFile();
    page.off("request", observeSnapshotRead);
    console.info(`Test1HoldDiagnostics=${holdDiagnostics.join(";")}`);
    await expect(page.locator("pre")).toContainText("第一個 context 的新版本");
    await expect(page.locator("pre")).not.toContainText("學生作品你好 🌍");

    await page.getByLabel("新增檔案名稱").fill("definite-failure.js");
    await page.getByRole("link", { name: "新增檔案", exact: true }).click();
    const rejectedEditor = page.getByRole("textbox", { name: "definite-failure.js 原始碼文字編輯器" });
    await expect(rejectedEditor).toBeVisible({ timeout: 15_000 });
    await rejectedEditor.press("Control+A", { timeout: 10_000 });
    await page.keyboard.insertText("DB 尚未保存；reload 後仍要恢復");
    let rejectedKey = "";
    await page.route(`**/api/v1/projects/${projectId}/files/definite-failure.js`, async (route) => {
      rejectedKey = route.request().headers()["idempotency-key"] ?? "";
      await route.fulfill({
        status: 400,
        contentType: "application/problem+json",
        body: JSON.stringify({
          type: "about:blank", title: "合成確定拒絕", status: 400, code: "invalid_request",
          instance: "/api/v1/projects/files/definite-failure.js", request_id: "synthetic-request",
          user_message_zh: "本次沒有保存。",
        }),
      });
    }, { times: 1 });
    const rejected = page.waitForResponse((response) =>
      new URL(response.url()).pathname.endsWith("/files/definite-failure.js") &&
      response.request().method() === "PUT", { timeout: 20_000 });
    await page.getByRole("button", { name: "保存到資料庫" }).click();
    expect((await rejected).status()).toBe(400);
    expect(rejectedKey).toMatch(/^[0-9a-f-]{36}$/i);
    expect((await control.query(
      "SELECT count(*)::int AS count FROM app.project_files WHERE project_id=$1 AND path='definite-failure.js'",
      [projectId],
    )).rows[0]?.count).toBe(0);
    await page.reload();
    await expect(page.locator(".monaco-editor .view-lines")).toContainText("DB 尚未保存；reload 後仍要恢復");
    expect((await control.query(
      "SELECT count(*)::int AS count FROM app.project_files WHERE project_id=$1 AND path='definite-failure.js'",
      [projectId],
    )).rows[0]?.count).toBe(0);
    const retry = page.waitForResponse((response) =>
      new URL(response.url()).pathname.endsWith("/files/definite-failure.js") &&
      response.request().method() === "PUT", { timeout: 20_000 });
    await page.getByRole("button", { name: "保存到資料庫" }).click();
    const retried = await retry;
    expect(retried.status()).toBe(201);
    expect(retried.request().headers()["idempotency-key"]).not.toBe(rejectedKey);
    expect((await control.query(
      "SELECT count(*)::int AS count FROM app.project_files WHERE project_id=$1 AND path='definite-failure.js'",
      [projectId],
    )).rows[0]?.count).toBe(1);

    await page.getByLabel("新增檔案名稱").fill("guard.html");
    await page.getByRole("link", { name: "新增檔案", exact: true }).click();
    const guardEditor = page.getByRole("textbox", { name: "guard.html 原始碼文字編輯器" });
    await expect(guardEditor).toBeVisible({ timeout: 15_000 });
    await guardEditor.press("Control+A", { timeout: 10_000 });
    await page.keyboard.insertText("<h1>留在本頁或明確保存</h1>");
    await page.getByTestId("project-file-index.html").click();
    const guardDialog = page.getByTestId("unsaved-changes-dialog");
    await expect(guardDialog).toBeVisible();
    await guardDialog.getByRole("button", { name: "留在目前頁面" }).click();
    await expect(page.getByRole("heading", { name: "guard.html", exact: true })).toBeVisible();
    await page.getByTestId("project-file-index.html").click();
    await expect(guardDialog).toBeVisible();
    const saveAndSwitch = page.waitForResponse((response) =>
      new URL(response.url()).pathname.endsWith("/files/guard.html") &&
      response.request().method() === "PUT", { timeout: 20_000 });
    await guardDialog.getByRole("button", { name: "保存後離開" }).click();
    expect((await saveAndSwitch).status()).toBe(201);
    await expect(page.getByRole("heading", { name: "index.html", exact: true })).toBeVisible();
    expect(new URL(page.url()).hash).toBe("#file=index.html");

    await page.getByLabel("新增檔案名稱").fill("discard.css");
    await page.getByRole("link", { name: "新增檔案", exact: true }).click();
    const discardEditor = page.getByRole("textbox", { name: "discard.css 原始碼文字編輯器" });
    await expect(discardEditor).toBeVisible({ timeout: 15_000 });
    await discardEditor.press("Control+A", { timeout: 10_000 });
    await page.keyboard.insertText("本機草稿必須明確放棄");
    await expect(page).toHaveURL(/#file=discard\.css$/);
    await page.getByTestId("project-file-index.html").click();
    await expect(guardDialog).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(guardDialog).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "discard.css", exact: true })).toBeVisible();
    await page.getByTestId("project-file-index.html").click();
    await expect(guardDialog).toBeVisible();
    await guardDialog.getByRole("button", { name: "放棄本頁修改並離開" }).click();
    await expect(page.getByRole("heading", { name: "index.html", exact: true })).toBeVisible();
    await expect(page.getByTestId("project-file-discard.css")).toHaveCount(0);
    expect((await control.query(
      "SELECT count(*)::int AS count FROM app.project_files WHERE project_id=$1 AND path='discard.css'",
      [projectId],
    )).rows[0]?.count).toBe(0);

    await page.getByLabel("新增檔案名稱").fill("ime-check.js");
    await page.getByRole("link", { name: "新增檔案", exact: true }).click();
    const imeEditor = page.getByRole("textbox", { name: "ime-check.js 原始碼文字編輯器" });
    await expect(imeEditor).toBeVisible({ timeout: 15_000 });
    await imeEditor.press("Control+A", { timeout: 10_000 });
    await page.keyboard.insertText("synthetic composition check");
    let imeSaveCount = 0;
    const countImeSave = (request: import("@playwright/test").Request) => {
      if (request.method() === "PUT" &&
          new URL(request.url()).pathname.endsWith("/files/ime-check.js")) imeSaveCount++;
    };
    page.on("request", countImeSave);
    await imeEditor.evaluate((element) =>
      element.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true })));
    await page.keyboard.press("Control+s");
    expect(imeSaveCount).toBe(0);
    await imeEditor.evaluate((element) =>
      element.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true })));
    const imeSave = page.waitForResponse((response) =>
      new URL(response.url()).pathname.endsWith("/files/ime-check.js") &&
      response.request().method() === "PUT", { timeout: 20_000 });
    await page.keyboard.press("Control+s");
    expect((await imeSave).status()).toBe(201);
    page.off("request", countImeSave);

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
    expect(renewalError).toBeNull();
  } finally {
    clearInterval(sessionRenewal);
    await page?.close();
    await context.close();
    await secondContext.close();
    await control.end();
  }
});

test("真 Next HTTPS：教師由產品登入唯讀查看學生保存的 manual 快照，收權後隱藏內容", async ({ browser }) => {
  test.setTimeout(180_000);
  const control = openControlPool();
  const origin = process.env.APP_PLANET_APP_ORIGIN;
  if (!origin) throw new Error("隔離瀏覽器測試缺少本機 app origin。");
  let studentAccount: SyntheticAuthAccount | null = null;
  let teacherAccount: SyntheticAuthAccount | null = null;
  let studentContext: import("@playwright/test").BrowserContext | null = null;
  let teacherContext: import("@playwright/test").BrowserContext | null = null;
  let bindingId: string | null = null;
  let membershipId: string | null = null;
  try {
    studentAccount = await createSyntheticAuthAccount(control, "SnapshotStudent");
    teacherAccount = await createSyntheticAuthAccount(control, "SnapshotTeacher");
    await control.query("UPDATE app.profiles SET role='teacher',school_id=$2 WHERE id=$1",
      [teacherAccount.id, studentAccount.schoolId]);
    bindingId = randomUUID();
    membershipId = randomUUID();
    await control.query(`INSERT INTO app.teacher_school_memberships
      (id,teacher_id,school_id,state,created_by_aid,created_at)
      VALUES($1,$2,$3,'active',$4,now())`,
    [membershipId, teacherAccount.id, studentAccount.schoolId, randomUUID()]);
    await control.query(`INSERT INTO app.teacher_student_bindings
      (id,teacher_id,student_id,state,created_by_aid,created_at)
      VALUES($1,$2,$3,'active',$4,now())`,
    [bindingId, teacherAccount.id, studentAccount.id, randomUUID()]);

    const projectId = await createOwnedSyntheticProject(studentAccount);
    const studentSession = await loginSyntheticAccount(studentAccount);
    studentContext = await browser.newContext({ locale: "zh-TW", ignoreHTTPSErrors: true });
    await studentContext.addCookies([{
      name: sessionCookieName, value: studentSession.accessToken, url: origin,
      secure: true, httpOnly: true, sameSite: "Strict",
    }]);
    const studentPage = await studentContext.newPage();
    await studentPage.goto(`${origin}/student/projects/${projectId}/build`, {
      waitUntil: "domcontentloaded", timeout: 30_000,
    });
    const source = "<!doctype html>\n<h1>產品 UI 保存的教師唯讀快照</h1>";
    await studentPage.getByLabel("新增檔案名稱").fill("index.html");
    await studentPage.getByRole("link", { name: "新增檔案", exact: true }).click();
    const editor = studentPage.getByRole("textbox", { name: "index.html 原始碼文字編輯器" });
    await expect(editor).toBeVisible({ timeout: 15_000 });
    await editor.press("Control+A");
    await studentPage.keyboard.insertText(source);
    const saved = studentPage.waitForResponse((response) =>
      new URL(response.url()).pathname === `/api/v1/projects/${projectId}/files/index.html` &&
      response.request().method() === "PUT", { timeout: 20_000 });
    await studentPage.getByRole("button", { name: "保存到資料庫" }).click();
    expect((await saved).status()).toBe(201);
    const snapshot = studentPage.waitForResponse((response) =>
      new URL(response.url()).pathname === `/api/v1/projects/${projectId}/snapshots` &&
      response.request().method() === "POST", { timeout: 20_000 });
    const createSnapshot = studentPage.getByRole("button", { name: "建立 manual 快照" });
    await expect(createSnapshot).toBeEnabled();
    await createSnapshot.click();
    const snapshotResponse = await snapshot;
    expect(snapshotResponse.status()).toBe(201);
    const snapshotId = (await snapshotResponse.json()).id as string;
    expect(snapshotId).toMatch(/^[0-9a-f-]{36}$/i);

    teacherContext = await browser.newContext({ locale: "zh-TW", ignoreHTTPSErrors: true });
    const teacherPage = await teacherContext.newPage();
    await teacherPage.goto(`${origin}/login`);
    await expect(teacherPage.locator('form[data-ready="true"]')).toHaveCount(1);
    await teacherPage.getByLabel("電子郵件").fill(teacherAccount.email);
    await teacherPage.getByLabel("密碼").fill(teacherAccount.password);
    const login = teacherPage.waitForResponse((response) =>
      new URL(response.url()).pathname === "/api/v1/auth/staff/login" &&
      response.request().method() === "POST", { timeout: 20_000 });
    await teacherPage.getByRole("button", { name: "登入", exact: true }).press("Enter");
    expect((await login).status()).toBe(200);
    await expect(teacherPage).toHaveURL(`${origin}/teacher`);
    await teacherPage.goto(
      `${origin}/teacher/students/${studentAccount.id}/projects/${projectId}`,
      { waitUntil: "domcontentloaded", timeout: 30_000 },
    );
    const snapshotVersion = teacherPage.getByRole("button", { name: /版本 1/ });
    await expect(snapshotVersion).toBeVisible({ timeout: 20_000 });
    await expect(teacherPage.getByRole("button", { name: "建立 manual 快照" })).toHaveCount(0);
    await expect(teacherPage.getByRole("textbox")).toHaveCount(0);
    await snapshotVersion.click();
    await expect(teacherPage.getByRole("heading", { name: "版本 1 manifest（唯讀）" })).toBeVisible();
    await teacherPage.getByRole("button", { name: /index\.html/ }).last().click();
    await expect(teacherPage.locator("pre")).toContainText("產品 UI 保存的教師唯讀快照");

    const beforeRevocationAudit = await control.query(
      "SELECT count(*)::int AS count FROM app.audit_events WHERE action='teacher_view' AND object_ref=$1",
      [projectId],
    );
    await control.query("UPDATE app.teacher_student_bindings SET state='ended' WHERE id=$1", [bindingId]);
    const deniedManifest = teacherPage.waitForResponse((response) =>
      new URL(response.url()).pathname ===
        `/api/v1/teacher/students/${studentAccount!.id}/projects/${projectId}/snapshots/${snapshotId}/manifest` &&
      response.status() >= 400, { timeout: 20_000 });
    await snapshotVersion.click();
    expect([403, 404]).toContain((await deniedManifest).status());
    await expect(teacherPage.getByText("產品 UI 保存的教師唯讀快照")).toHaveCount(0);
    const afterRevocationAudit = await control.query(
      "SELECT count(*)::int AS count FROM app.audit_events WHERE action='teacher_view' AND object_ref=$1",
      [projectId],
    );
    expect(afterRevocationAudit.rows[0]?.count).toBe(beforeRevocationAudit.rows[0]?.count);
    console.info("TeacherSnapshotHTTPS=teacher_product_login;synthetic_student_session_and_school_binding;student_product_save_and_manual_snapshot;read_only;revocation_hidden");
  } finally {
    await teacherContext?.close();
    await studentContext?.close();
    if (bindingId) await control.query("DELETE FROM app.teacher_student_bindings WHERE id=$1", [bindingId]);
    if (membershipId)     await control.query("DELETE FROM app.teacher_school_memberships WHERE id=$1", [membershipId]);
    await control.end();
  }
});

type HoldRule = Readonly<{ method: string; pathSuffix: string; searchIncludes?: string }>;

// 測試注入（非產品後門）：只在 Playwright context 內包裝 window.fetch，讓指定請求的
// 上游回應完整收下後，以 highWaterMark:0 的 body 串流延遲交付；記錄產品確實呼叫
// response.json() 與其 settle，作為晚到 body 抵達產品非同步處理邊界的證據。
function installResponseHold() {
  const w = window as unknown as Record<string, unknown>;
  const original = window.fetch.bind(window);
  const state: Record<string, unknown> = {
    rule: null, matched: 0, status: 0, jsonCalled: false, jsonSettled: false, released: null, release: null,
  };
  w.__apHold = state;
  w.__apArmHold = (rule: HoldRule) => {
    let release: () => void = () => undefined;
    const released = new Promise<void>((resolve) => { release = resolve; });
    Object.assign(state, { rule, matched: 0, status: 0, jsonCalled: false, jsonSettled: false, released, release });
  };
  w.__apReleaseHold = () => (state.release as () => void)();
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const href = input instanceof Request ? input.url : String(input);
    const url = new URL(href, window.location.href);
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    const rule = state.rule as HoldRule | null;
    if (!rule || method !== rule.method || !url.pathname.endsWith(rule.pathSuffix) ||
        (rule.searchIncludes && !url.search.includes(rule.searchIncludes))) return original(input, init);
    state.rule = null;
    state.matched = (state.matched as number) + 1;
    const upstream = await original(input, init);
    const bytes = new Uint8Array(await upstream.arrayBuffer());
    state.status = upstream.status;
    const released = state.released as Promise<void>;
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        await released;
        controller.enqueue(bytes);
        controller.close();
      },
    }, { highWaterMark: 0 });
    const held = new Response(body, {
      status: upstream.status, statusText: upstream.statusText, headers: upstream.headers,
    });
    const nativeJson = held.json.bind(held);
    held.json = () => {
      state.jsonCalled = true;
      return nativeJson().finally(() => { state.jsonSettled = true; });
    };
    return held;
  };
}

type Page = import("@playwright/test").Page;
const armHold = (page: Page, rule: HoldRule) =>
  page.evaluate((value) => (window as unknown as { __apArmHold(rule: unknown): void }).__apArmHold(value), rule);
const holdState = (page: Page) =>
  page.evaluate(() => {
    const state = (window as unknown as { __apHold: Record<string, unknown> }).__apHold;
    return { matched: state.matched as number, status: state.status as number,
      jsonCalled: state.jsonCalled as boolean, jsonSettled: state.jsonSettled as boolean };
  });
const waitBodyAwaited = (page: Page) => page.waitForFunction(() =>
  (window as unknown as { __apHold: { jsonCalled: boolean } }).__apHold.jsonCalled === true, null, { timeout: 20_000 });
async function releaseHoldAndDrain(page: Page) {
  await page.evaluate(() => (window as unknown as { __apReleaseHold(): void }).__apReleaseHold());
  await page.waitForFunction(() =>
    (window as unknown as { __apHold: { jsonSettled: boolean } }).__apHold.jsonSettled === true, null, { timeout: 20_000 });
  // macrotask 邊界：產品 await response.json() 之後的 microtask 全數排空。
  await page.evaluate(() => new Promise<void>((resolve) => { setTimeout(resolve, 0); }));
}
const sessionStorageEntries = (page: Page) => page.evaluate(() =>
  Object.keys(window.sessionStorage).sort().map((key) => [key, window.sessionStorage.getItem(key)] as const));
const pendingFileKey = async (page: Page, projectId: string, path: string) => {
  const raw = await page.evaluate(([id, file]) => {
    const key = Object.keys(window.sessionStorage).find((candidate) =>
      candidate.startsWith("app-planet.project-files.v1.") && candidate.endsWith(`.${id}.${encodeURIComponent(file!)}`));
    return key ? window.sessionStorage.getItem(key) : null;
  }, [projectId, path] as const);
  return (JSON.parse(raw ?? "null") as { pending?: { key?: string } } | null)?.pending?.key ?? null;
};
const visibleVersions = async (page: Page) => (await page.getByRole("button", { name: /^版本 \d+（manual）/ })
  .allTextContents()).map((text) => Number(/^版本 (\d+)/.exec(text)?.[1]));

test("§108 真 Next HTTPS：replay-only 收據、導覽返回晚到 body、快照讀取競態與教師失權", async ({ browser }) => {
  test.setTimeout(420_000);
  const control = openControlPool();
  const origin = process.env.APP_PLANET_APP_ORIGIN;
  if (!origin) throw new Error("隔離瀏覽器測試缺少本機 app origin。");
  let studentContext: import("@playwright/test").BrowserContext | null = null;
  let teacherContext: import("@playwright/test").BrowserContext | null = null;
  let bindingId: string | null = null;
  let membershipId: string | null = null;
  let sessionRenewal: ReturnType<typeof setInterval> | undefined;
  let renewalError: unknown = null;
  try {
    const student = await createSyntheticAuthAccount(control, "RaceStudent");
    const teacher = await createSyntheticAuthAccount(control, "RaceTeacher");
    await control.query("UPDATE app.profiles SET role='teacher',school_id=$2 WHERE id=$1",
      [teacher.id, student.schoolId]);
    bindingId = randomUUID();
    membershipId = randomUUID();
    await control.query(`INSERT INTO app.teacher_school_memberships
      (id,teacher_id,school_id,state,created_by_aid,created_at)
      VALUES($1,$2,$3,'active',$4,now())`, [membershipId, teacher.id, student.schoolId, randomUUID()]);
    await control.query(`INSERT INTO app.teacher_student_bindings
      (id,teacher_id,student_id,state,created_by_aid,created_at)
      VALUES($1,$2,$3,'active',$4,now())`, [bindingId, teacher.id, student.id, randomUUID()]);
    const projectA = await createOwnedSyntheticProject(student);
    const projectB = await createOwnedSyntheticProject(student);
    const session = await loginSyntheticAccount(student);
    studentContext = await browser.newContext({ locale: "zh-TW", ignoreHTTPSErrors: true });
    await studentContext.addCookies([{
      name: sessionCookieName, value: session.accessToken, url: origin,
      secure: true, httpOnly: true, sameSite: "Strict",
    }]);
    // 隔離 runner 的 jwt_expiry=60；長流程沿用既有合成 session 續期 setup（非學生產品登入）。
    const renewStudentSession = async () => {
      const renewed = await loginSyntheticAccount(student);
      await studentContext!.addCookies([{
        name: sessionCookieName, value: renewed.accessToken, url: origin,
        secure: true, httpOnly: true, sameSite: "Strict",
      }]);
    };
    sessionRenewal = setInterval(() => {
      renewStudentSession().catch((error) => { renewalError = error; });
    }, 30_000);
    await studentContext.addInitScript(installResponseHold);
    const page = await studentContext.newPage();
    // 同測試 1：維持攔截啟用，避免 times:1 路由耗盡後的空模式更新與下一個注入競速。
    await page.route("**/api/v1/projects/**", (route) => route.fallback());
    const tabs = page.getByTestId("project-workspace-tabs");
    const workspace = page.getByTestId("project-file-workspace");
    const blueprintUrl = `${origin}/student/projects/${projectA}`;
    const dbFiles = async (id: string) => (await control.query(`
      SELECT f.path,convert_from(b.content,'UTF8') AS content FROM app.project_files f JOIN app.blobs b ON b.hash=f.blob_hash
      WHERE f.project_id=$1 ORDER BY f.path COLLATE "C"`, [id])).rows;
    const snapshotCount = async (id: string) => (await control.query(
      "SELECT count(*)::int AS count FROM app.snapshots WHERE project_id=$1", [id])).rows[0]?.count as number;
    const newDraft = async (path: string, text: string) => {
      await page.getByLabel("新增檔案名稱").fill(path);
      await page.getByRole("link", { name: "新增檔案", exact: true }).click();
      const editor = page.getByRole("textbox", { name: `${path} 原始碼文字編輯器` });
      await expect(editor).toBeVisible({ timeout: 15_000 });
      await editor.press("Control+A", { timeout: 10_000 });
      await page.keyboard.insertText(text);
    };
    const filePut = (path: string, id = projectA) => page.waitForResponse((response) =>
      new URL(response.url()).pathname === `/api/v1/projects/${id}/files/${path}` &&
      response.request().method() === "PUT", { timeout: 20_000 });
    const snapshotPost = () => page.waitForResponse((response) =>
      new URL(response.url()).pathname === `/api/v1/projects/${projectA}/snapshots` &&
      response.request().method() === "POST", { timeout: 20_000 });

    // 檔案保存中：body 停在 await response.json() 時，產品 guard 必須擋下返回；釋放後正常完成。
    await page.goto(blueprintUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await tabs.getByRole("link", { name: "建立 App", exact: true }).click();
    await expect(workspace).toBeVisible({ timeout: 20_000 });
    await expect(workspace).toContainText("目前沒有檔案", { timeout: 15_000 });
    const marker = randomUUID();
    await page.evaluate((value) => { (window as unknown as { __apDocument: string }).__apDocument = value; }, marker);
    const documentMarker = () => page.evaluate(() => (window as unknown as { __apDocument?: string }).__apDocument);
    await newDraft("a.html", "<h1>operation A</h1>");
    await armHold(page, { method: "PUT", pathSuffix: `/projects/${projectA}/files/a.html` });
    await page.getByRole("button", { name: "保存到資料庫" }).click();
    await waitBodyAwaited(page);
    expect(await holdState(page)).toMatchObject({ matched: 1, status: 201, jsonCalled: true, jsonSettled: false });
    const fileKeyA = await pendingFileKey(page, projectA, "a.html");
    expect(fileKeyA).toMatch(/^[0-9a-f-]{36}$/i);
    const guardDialog = page.getByTestId("unsaved-changes-dialog");
    const urlBeforeBack = page.url();
    expect(urlBeforeBack.startsWith(`${blueprintUrl}/build`)).toBe(true);
    await page.goBack({ timeout: 4_000 }).catch(() => null);
    await expect(guardDialog).toBeVisible();
    await expect(guardDialog).toContainText("正在保存");
    await expect(page).toHaveURL(urlBeforeBack);
    await guardDialog.getByRole("button", { name: "留在目前頁面" }).click();
    await expect(guardDialog).toHaveCount(0);
    await releaseHoldAndDrain(page);
    await expect(page.getByText(/目前內容與已保存版本一致。/)).toBeVisible();
    expect(await pendingFileKey(page, projectA, "a.html")).toBeNull();
    expect(await dbFiles(projectA)).toEqual([{ path: "a.html", content: "<h1>operation A</h1>" }]);
    console.info("FileSavingGuardHTTPS=traverse_cancelable_guarded;json_awaited;stay;late_body_completed_same_instance");

    await newDraft("b.js", "window.operationB = 'B';");
    const savedB = filePut("b.js");
    await page.getByRole("button", { name: "保存到資料庫" }).click();
    expect((await savedB).status()).toBe(201);
    await expect(page.getByText(/目前內容與已保存版本一致。/)).toBeVisible();
    // F-05（檔案）：replay-only 收到 201 不承認，原鍵保留；再以原鍵取得 200 才完成。
    await newDraft("c.css", "body { color: #0a0; }");
    await page.route(`**/api/v1/projects/${projectA}/files/c.css`, async (route) => {
      await route.fetch();
      await route.abort("connectionreset");
    }, { times: 1 });
    await page.getByRole("button", { name: "保存到資料庫" }).click();
    await expect(page.getByText(/保存結果未知/).first()).toBeVisible();
    const keyC = await pendingFileKey(page, projectA, "c.css");
    await page.reload();
    await expect(page.locator(".monaco-editor .view-lines")).toContainText("#0a0", { timeout: 15_000 });
    let forgedFileStatus = 0;
    await page.route(`**/api/v1/projects/${projectA}/files/c.css`, async (route) => {
      const upstream = await route.fetch();
      forgedFileStatus = upstream.status();
      await route.fulfill({ response: upstream, status: 201 });
    }, { times: 1 });
    const forgedFile = filePut("c.css");
    await page.getByRole("button", { name: "使用原操作重試" }).click();
    expect((await forgedFile).request().headers()["idempotency-replay-only"]).toBe("true");
    expect(forgedFileStatus).toBe(200);
    await expect(page.getByText(/保存成功回應缺少可信完整收據/)).toBeVisible();
    expect(await pendingFileKey(page, projectA, "c.css")).toBe(keyC);
    const trustedFile = filePut("c.css");
    await page.getByRole("button", { name: "使用原操作重試" }).click();
    expect((await trustedFile).status()).toBe(200);
    expect((await trustedFile).request().headers()["idempotency-key"]).toBe(keyC);
    await expect(page.getByText(/目前內容與已保存版本一致。/)).toBeVisible();
    expect(await pendingFileKey(page, projectA, "c.css")).toBeNull();

    // F-03：manual 快照 A 的 body 停在 await response.json()；經產品頁籤離開／返回後以原鍵確認，
    // 再讓新的 B 成為未知；釋放舊 A body 後 B 的 storage 逐字不變，reload 仍以原 B 鍵恢復。
    // 上方 c.css 驗收含 reload；此處重新標記同一文件，用於證明下列頁籤離開／返回不重載文件。
    await page.evaluate((value) => { (window as unknown as { __apDocument: string }).__apDocument = value; }, marker);
    const createButton = page.getByRole("button", { name: "建立 manual 快照" });
    const retrySnapshot = page.getByRole("button", { name: "以原操作重試快照" });
    const snapshotPending = async () => page.evaluate((suffix) => {
      const key = Object.keys(window.sessionStorage).find((candidate) => candidate.endsWith(suffix));
      return key ? window.sessionStorage.getItem(key) : null;
    }, `.${projectA}.pending`);
    await expect(createButton).toBeEnabled();
    await armHold(page, { method: "POST", pathSuffix: `/projects/${projectA}/snapshots` });
    await createButton.click();
    await waitBodyAwaited(page);
    expect(await holdState(page)).toMatchObject({ matched: 1, status: 201, jsonCalled: true, jsonSettled: false });
    const snapshotKeyA = await snapshotPending();
    expect(snapshotKeyA).toMatch(/^[0-9a-f-]{36}$/i);
    await tabs.getByRole("link", { name: "版本", exact: true }).click();
    await expect(page).toHaveURL(`${blueprintUrl}/versions`);
    await expect(workspace).toHaveCount(0, { timeout: 20_000 });
    expect(await documentMarker()).toBe(marker);
    await tabs.getByRole("link", { name: "建立 App", exact: true }).click();
    await expect(workspace).toBeVisible({ timeout: 20_000 });
    await expect(retrySnapshot).toBeEnabled({ timeout: 15_000 });
    const replaySnapshotA = snapshotPost();
    await retrySnapshot.click();
    const replayedSnapshotA = await replaySnapshotA;
    expect(replayedSnapshotA.status()).toBe(200);
    expect(replayedSnapshotA.request().headers()["idempotency-key"]).toBe(snapshotKeyA);
    expect(replayedSnapshotA.request().headers()["idempotency-replay-only"]).toBe("true");
    await expect(page.getByRole("button", { name: /^版本 1（manual）/ })).toBeVisible();
    expect(await snapshotPending()).toBeNull();
    let committedSnapshotB: number | null = null;
    await page.route(`**/api/v1/projects/${projectA}/snapshots`, async (route) => {
      if (route.request().method() !== "POST") return route.fallback();
      committedSnapshotB = (await route.fetch()).status();
      await route.abort("connectionreset");
    }, { times: 1 });
    await expect(createButton).toBeEnabled();
    await createButton.click();
    await expect(page.getByText(/快照結果未知/)).toBeVisible();
    expect(committedSnapshotB).toBe(201);
    const snapshotKeyB = await snapshotPending();
    expect(snapshotKeyB).toMatch(/^[0-9a-f-]{36}$/i);
    expect(snapshotKeyB).not.toBe(snapshotKeyA);
    const storageBeforeRelease = await sessionStorageEntries(page);
    expect((await holdState(page)).jsonSettled).toBe(false);
    await releaseHoldAndDrain(page);
    expect(await sessionStorageEntries(page)).toEqual(storageBeforeRelease);
    expect(await snapshotPending()).toBe(snapshotKeyB);
    await expect(retrySnapshot).toBeEnabled();
    await expect(page.getByText(/快照結果未知/)).toBeVisible();
    expect(await visibleVersions(page)).toEqual([1]);
    expect(await documentMarker()).toBe(marker);
    await page.reload();
    await expect(retrySnapshot).toBeEnabled({ timeout: 15_000 });
    expect(await snapshotPending()).toBe(snapshotKeyB);
    const replaySnapshotB = snapshotPost();
    await retrySnapshot.click();
    const replayedSnapshotB = await replaySnapshotB;
    expect(replayedSnapshotB.status()).toBe(200);
    expect(replayedSnapshotB.request().headers()["idempotency-key"]).toBe(snapshotKeyB);
    expect(replayedSnapshotB.request().headers()["idempotency-replay-only"]).toBe("true");
    await expect(page.getByRole("button", { name: /^版本 2（manual）/ })).toBeVisible();
    expect(await snapshotPending()).toBeNull();
    expect(await snapshotCount(projectA)).toBe(2);
    console.info("NavigationLateBodyHTTPS=snapshot_create;product_tab_leave_return;same_document;json_awaited_before_leave;A_original_key_replay_200;B_storage_unchanged;reload_original_key_replay_200");
    // F-05（快照）：replay-only 收到 201＋合法 DTO 仍維持未知，不換鍵；可信 200 才完成。
    await expect(createButton).toBeEnabled();
    await page.route(`**/api/v1/projects/${projectA}/snapshots`, async (route) => {
      if (route.request().method() !== "POST") return route.fallback();
      await route.fetch();
      await route.abort("connectionreset");
    }, { times: 1 });
    await createButton.click();
    await expect(page.getByText(/快照結果未知/)).toBeVisible();
    const originalSnapshotKey = await snapshotPending();
    expect(originalSnapshotKey).toMatch(/^[0-9a-f-]{36}$/i);
    await page.reload();
    await expect(retrySnapshot).toBeEnabled({ timeout: 15_000 });
    let forgedSnapshotStatus = 0;
    await page.route(`**/api/v1/projects/${projectA}/snapshots`, async (route) => {
      if (route.request().method() !== "POST") return route.fallback();
      const upstream = await route.fetch();
      forgedSnapshotStatus = upstream.status();
      await route.fulfill({ response: upstream, status: 201 });
    }, { times: 1 });
    const forgedSnapshot = snapshotPost();
    await retrySnapshot.click();
    const forgedSnapshotResponse = await forgedSnapshot;
    expect(forgedSnapshotResponse.request().headers()["idempotency-key"]).toBe(originalSnapshotKey);
    expect(forgedSnapshotResponse.request().headers()["idempotency-replay-only"]).toBe("true");
    expect(forgedSnapshotStatus).toBe(200);
    await expect(page.getByText(/原操作重放未取得正式重放收據/)).toBeVisible();
    await expect(retrySnapshot).toBeEnabled();
    expect(await snapshotPending()).toBe(originalSnapshotKey);
    expect(await snapshotCount(projectA)).toBe(3);
    expect(await visibleVersions(page)).toEqual([3, 2, 1]);
    const trustedSnapshot = snapshotPost();
    await retrySnapshot.click();
    const trustedSnapshotResponse = await trustedSnapshot;
    expect(trustedSnapshotResponse.status()).toBe(200);
    expect(trustedSnapshotResponse.request().headers()["idempotency-key"]).toBe(originalSnapshotKey);
    await expect(page.getByRole("button", { name: /^版本 3（manual）/ })).toBeVisible();
    await expect(createButton).toBeEnabled();
    expect(await snapshotPending()).toBeNull();
    expect(await snapshotCount(projectA)).toBe(3);

    // 以產品 UI 逐一建立 manual 快照，形成跨頁清單（每頁 20）。
    for (let version = 4; version <= 21; version++) {
      const created = snapshotPost();
      await expect(createButton).toBeEnabled();
      await createButton.click();
      expect((await created).status()).toBe(201);
      await expect(page.getByRole("button", { name: new RegExp(`^版本 ${version}（manual）`) })).toBeVisible();
    }
    await page.reload();
    await expect(page.getByRole("button", { name: "載入更多版本" })).toBeVisible({ timeout: 15_000 });
    expect(await visibleVersions(page)).toEqual(Array.from({ length: 20 }, (_, index) => 21 - index));

    // 清單重新載入與分頁亂序：同一實例載入中時產品停用建立與載入更多（loading gate），
    // 故以產品頁籤卸載重入：舊實例第二頁 body 停住 → 新實例重新載入 → 建立 V22 觸發再次重新載入 → 釋放舊第二頁。
    await page.evaluate((value) => { (window as unknown as { __apDocument: string }).__apDocument = value; }, marker);
    await armHold(page, { method: "GET", pathSuffix: `/projects/${projectA}/snapshots`, searchIncludes: "cursor=" });
    await page.getByRole("button", { name: "載入更多版本" }).click();
    await waitBodyAwaited(page);
    await expect(createButton).toBeDisabled();
    await expect(page.getByRole("button", { name: "載入更多版本" })).toBeDisabled();
    await tabs.getByRole("link", { name: "版本", exact: true }).click();
    await expect(workspace).toHaveCount(0, { timeout: 20_000 });
    await tabs.getByRole("link", { name: "建立 App", exact: true }).click();
    await expect(workspace).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole("button", { name: "載入更多版本" })).toBeEnabled({ timeout: 15_000 });
    expect(await visibleVersions(page)).toEqual(Array.from({ length: 20 }, (_, index) => 21 - index));
    await expect(createButton).toBeEnabled();
    const reloadCreate = snapshotPost();
    await createButton.click();
    expect((await reloadCreate).status()).toBe(201);
    await expect(page.getByRole("button", { name: /^版本 22（manual）/ })).toBeVisible();
    await expect(page.getByRole("button", { name: "載入更多版本" })).toBeEnabled();
    expect((await holdState(page)).jsonSettled).toBe(false);
    await releaseHoldAndDrain(page);
    expect(await page.evaluate(() => (window as unknown as { __apDocument?: string }).__apDocument)).toBe(marker);
    expect(await visibleVersions(page)).toEqual(Array.from({ length: 20 }, (_, index) => 22 - index));
    await page.getByRole("button", { name: "載入更多版本" }).click();
    await expect(page.getByRole("button", { name: /^版本 1（manual）/ })).toBeVisible();
    const allVersions = await visibleVersions(page);
    expect(allVersions).toEqual(Array.from({ length: 22 }, (_, index) => 22 - index));
    expect(new Set(allVersions).size).toBe(22);
    await expect(page.getByRole("button", { name: "載入更多版本" })).toHaveCount(0);

    // 卸載重入：舊 manifest body 停住，經產品頁籤離開 build 再回來後釋放，不得顯示。
    const latest = await control.query(
      "SELECT id,manifest FROM app.snapshots WHERE project_id=$1 AND version_no=22", [projectA]);
    const latestId = latest.rows[0]?.id as string;
    await armHold(page, { method: "GET", pathSuffix: `/snapshots/${latestId}/manifest` });
    await page.getByRole("button", { name: /^版本 22（manual）/ }).click();
    await waitBodyAwaited(page);
    await tabs.getByRole("link", { name: "版本", exact: true }).click();
    await expect(workspace).toHaveCount(0, { timeout: 20_000 });
    await tabs.getByRole("link", { name: "建立 App", exact: true }).click();
    await expect(workspace).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole("button", { name: /^版本 22（manual）/ })).toBeVisible({ timeout: 15_000 });
    const storageBeforeManifestRelease = await sessionStorageEntries(page);
    await releaseHoldAndDrain(page);
    await expect(page.getByRole("region", { name: "快照 manifest" })).toHaveCount(0);
    expect(await sessionStorageEntries(page)).toEqual(storageBeforeManifestRelease);
    expect(await page.evaluate(() => (window as unknown as { __apDocument?: string }).__apDocument)).toBe(marker);
    expect(await visibleVersions(page)).toEqual(Array.from({ length: 20 }, (_, index) => 22 - index));
    await page.getByRole("button", { name: "載入更多版本" }).click();
    await page.getByRole("button", { name: /^版本 1（manual）/ }).click();
    await expect(page.getByRole("heading", { name: "版本 1 manifest（唯讀）" })).toBeVisible();
    const manifestRegion = page.getByRole("region", { name: "快照 manifest" });
    await expect(manifestRegion).toContainText("檔案數：3");
    await manifestRegion.getByRole("button", { name: /^b\.js — / }).click();
    await expect(page.locator("pre")).toHaveText("window.operationB = 'B';");

    // 切換專案：舊專案 manifest body 停住，經產品「工作台」→ 另一專案 → 建立 App，釋放後不得污染。
    const v1 = await control.query(
      "SELECT id FROM app.snapshots WHERE project_id=$1 AND version_no=1", [projectA]);
    await armHold(page, { method: "GET", pathSuffix: `/snapshots/${v1.rows[0]?.id as string}/manifest` });
    await page.getByRole("button", { name: /^版本 2（manual）/ }).click();
    await expect(page.getByRole("heading", { name: "版本 2 manifest（唯讀）" })).toBeVisible();
    await page.getByRole("button", { name: /^版本 1（manual）/ }).click();
    await waitBodyAwaited(page);
    await page.getByRole("link", { name: "工作台", exact: true }).click();
    await page.locator(`a[href="/student/projects/${projectB}"]`).click();
    await tabs.getByRole("link", { name: "建立 App", exact: true }).click();
    await expect(page).toHaveURL(`${origin}/student/projects/${projectB}/build`);
    await expect(workspace).toContainText("目前沒有檔案", { timeout: 20_000 });
    await expect(page.getByText("尚無 manual 快照。")).toBeVisible({ timeout: 15_000 });
    const storageBeforeSwitchRelease = await sessionStorageEntries(page);
    await releaseHoldAndDrain(page);
    await expect(page.getByRole("region", { name: "快照 manifest" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /^版本 \d+（manual）/ })).toHaveCount(0);
    await expect(workspace).not.toContainText("b.js");
    expect(await sessionStorageEntries(page)).toEqual(storageBeforeSwitchRelease);
    expect(await page.evaluate(() => (window as unknown as { __apDocument?: string }).__apDocument)).toBe(marker);
    expect(await snapshotCount(projectB)).toBe(0);
    console.info("SnapshotReadRaceHTTPS=page2_old_instance_vs_reentry_reload_and_create;unmount_reentry_manifest;project_switch_manifest;json_awaited;same_document");

    // 教師：舊成功 manifest body 停住 → 收權 → 可信 403／404 拒絕 → 釋放舊 body，不得恢復受保護內容。
    teacherContext = await browser.newContext({ locale: "zh-TW", ignoreHTTPSErrors: true });
    await teacherContext.addInitScript(installResponseHold);
    const teacherPage = await teacherContext.newPage();
    await teacherPage.goto(`${origin}/login`);
    await expect(teacherPage.locator('form[data-ready="true"]')).toHaveCount(1);
    await teacherPage.getByLabel("電子郵件").fill(teacher.email);
    await teacherPage.getByLabel("密碼").fill(teacher.password);
    const login = teacherPage.waitForResponse((response) =>
      new URL(response.url()).pathname === "/api/v1/auth/staff/login" &&
      response.request().method() === "POST", { timeout: 20_000 });
    await teacherPage.getByRole("button", { name: "登入", exact: true }).press("Enter");
    expect((await login).status()).toBe(200);
    await expect(teacherPage).toHaveURL(`${origin}/teacher`);
    await teacherPage.goto(`${origin}/teacher/students/${student.id}/projects/${projectA}`,
      { waitUntil: "domcontentloaded", timeout: 30_000 });
    await expect(teacherPage.getByRole("button", { name: /^版本 22（manual）/ })).toBeVisible({ timeout: 20_000 });
    await expect(teacherPage.getByRole("button", { name: "載入更多版本" })).toBeVisible();
    await armHold(teacherPage, { method: "GET", pathSuffix: `/snapshots/${latestId}/manifest` });
    await teacherPage.getByRole("button", { name: /^版本 22（manual）/ }).click();
    await waitBodyAwaited(teacherPage);
    expect((await holdState(teacherPage)).status).toBe(200);
    await control.query("UPDATE app.teacher_student_bindings SET state='ended' WHERE id=$1", [bindingId]);
    const auditAfterRevocation = await control.query(
      "SELECT count(*)::int AS count FROM app.audit_events WHERE action='teacher_view' AND object_ref=$1", [projectA]);
    const denied = teacherPage.waitForResponse((response) =>
      new URL(response.url()).pathname === `/api/v1/teacher/students/${student.id}/projects/${projectA}/snapshots` &&
      response.status() >= 400, { timeout: 20_000 });
    await teacherPage.getByRole("button", { name: "載入更多版本" }).click();
    expect([403, 404]).toContain((await denied).status());
    await expect(teacherPage.getByText("目前無法重新確認讀取權限；快照內容已隱藏。")).toBeVisible();
    await releaseHoldAndDrain(teacherPage);
    await expect(teacherPage.getByRole("region", { name: "快照 manifest" })).toHaveCount(0);
    await expect(teacherPage.getByRole("button", { name: /^版本 \d+（manual）/ })).toHaveCount(0);
    await expect(teacherPage.locator("pre")).toHaveCount(0);
    await expect(teacherPage.getByText(/b\.js — \d+ bytes/)).toHaveCount(0);
    expect((await control.query(
      "SELECT count(*)::int AS count FROM app.audit_events WHERE action='teacher_view' AND object_ref=$1", [projectA],
    )).rows[0]?.count).toBe(auditAfterRevocation.rows[0]?.count);
    expect(await snapshotCount(projectA)).toBe(22);
    console.info("TeacherRevocationRaceHTTPS=teacher_product_login;old_manifest_json_awaited;trusted_denial_first;release_hidden;no_new_teacher_view");
    expect(renewalError).toBeNull();
  } finally {
    clearInterval(sessionRenewal);
    await teacherContext?.close();
    await studentContext?.close();
    if (bindingId) await control.query("DELETE FROM app.teacher_student_bindings WHERE id=$1", [bindingId]);
    if (membershipId) await control.query("DELETE FROM app.teacher_school_memberships WHERE id=$1", [membershipId]);
    await control.end();
  }
});