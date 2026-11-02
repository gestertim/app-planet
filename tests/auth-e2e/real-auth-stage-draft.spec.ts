import { expect, test, type Page } from "@playwright/test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  createSyntheticAuthAccount,
  deleteSyntheticAuthAccount,
  loginSyntheticAccount,
  openControlPool,
} from "../support/real-auth-fixture.ts";
import { sessionCookieName } from "../../apps/web/src/server/auth-principal.ts";

const intentPrefix = "app-planet.project-create.";
const readIntentEntry = (page: Page) => page.evaluate(
  (prefix) => {
    const key = Object.keys(sessionStorage).find((name) => name.startsWith(prefix));
    return key ? { key, value: sessionStorage.getItem(key) } : null;
  }, intentPrefix);
const readIntent = async (page: Page, key?: string) => {
  const entry = await readIntentEntry(page);
  return key ? page.evaluate((storageKey) => sessionStorage.getItem(storageKey), key) : entry?.value ?? null;
};
const writeIntent = (page: Page, value: string, key?: string) => page.evaluate(
  ({ prefix, raw, target }) => {
    const storageKey = target ?? Object.keys(sessionStorage).find((name) => name.startsWith(prefix));
    if (!storageKey) throw new Error("找不到待確認操作的 storage key。");
    sessionStorage.setItem(storageKey, raw);
  }, { prefix: intentPrefix, raw: value, target: key ?? null });

test("原生 Auth session setup 後，產品工作台建專案、開啟草稿、首建、更新與失權隱藏", async ({ browser }) => {
  test.setTimeout(180_000);
  const control = openControlPool();
  const account = await createSyntheticAuthAccount(control, "Browser");
  let projectId: string | null = null;
  const contexts: Awaited<ReturnType<typeof browser.newContext>>[] = [];
  try {
    const firstSession = await loginSyntheticAccount(account);
    const secondSession = await loginSyntheticAccount(account);
    const appOrigin = process.env.APP_PLANET_APP_ORIGIN;
    if (!appOrigin) throw new Error("隔離瀏覽器測試缺少本機 app origin。");

    const firstContext = await browser.newContext({ locale: "zh-TW" });
    const secondContext = await browser.newContext({ locale: "zh-TW" });
    contexts.push(firstContext, secondContext);
    await firstContext.addCookies([{
      name: sessionCookieName,
      value: firstSession.accessToken,
      url: appOrigin,
      httpOnly: true,
      secure: true,
      sameSite: "Strict",
    }]);
    await secondContext.addCookies([{
      name: sessionCookieName,
      value: secondSession.accessToken,
      url: appOrigin,
      httpOnly: true,
      secure: true,
      sameSite: "Strict",
    }]);

    const page = await firstContext.newPage();
    const otherPage = await secondContext.newPage();
    await page.goto(`${appOrigin}/student`);
    await expect(page.getByText("目前沒有專案。")).toBeVisible();
    await page.getByLabel("專案名稱").fill("產品工作台建立驗收");
    const creation = page.waitForResponse((response) =>
      new URL(response.url()).pathname === "/api/v1/projects" && response.request().method() === "POST");
    await page.getByRole("button", { name: "建立專案", exact: true }).click();
    const createdResponse = await creation;
    expect(createdResponse.status()).toBe(201);
    projectId = (await createdResponse.json()).id;
    expect(projectId).toBeTruthy();
    await expect(page.getByTestId("owned-project-list")).toContainText("產品工作台建立驗收");
    await page.getByTestId("owned-project-list").getByRole("link", { name: "產品工作台建立驗收" }).click();
    await expect(page.getByRole("heading", { name: "產品工作台建立驗收" })).toBeVisible();
    await expect(page.getByText("分類：未分類", { exact: true })).toBeVisible();
    await page.getByTestId("stage-row-3")
      .getByRole("link", { name: "開啟 Specification 草稿", exact: true }).click();
    const editorUrl = `${appOrigin}/student/projects/${projectId}/stages/Specification`;
    await expect(page).toHaveURL(editorUrl);
    await expect(page.getByText("伺服器已驗證登入")).toBeVisible();
    await expect(page.getByLabel("階段草稿文字")).toBeVisible();
    await expect(page.getByTestId("confirmed-server-draft")).toHaveCount(0);
    await expect(page.getByText("未保存", { exact: true })).toBeVisible();

    await page.getByLabel("階段草稿文字").fill("瀏覽器首建草稿");
    await page.getByRole("button", { name: "保存", exact: true }).click();
    await expect(page.getByText("已確認版本 0。")).toBeVisible();
    await expect(page.getByTestId("confirmed-server-draft")).toContainText("伺服器版本 0：瀏覽器首建草稿");

    await page.getByLabel("階段草稿文字").fill("瀏覽器更新草稿");
    await page.getByRole("button", { name: "保存", exact: true }).click();
    await expect(page.getByText("已確認版本 1。")).toBeVisible();

    await otherPage.goto(editorUrl, { waitUntil: "networkidle" });
    await expect(otherPage.getByLabel("階段草稿文字")).toBeVisible();
    await otherPage.getByLabel("階段草稿文字").fill("另一個有效 session 的更新");
    const otherSave = otherPage.getByRole("button", { name: "保存", exact: true });
    await expect(otherPage.getByLabel("階段草稿文字")).toHaveValue("另一個有效 session 的更新");
    await expect(otherPage.locator("#operation-status")).toHaveAttribute("data-code", "unsaved");
    await expect(otherSave).toBeEnabled();
    await otherSave.click();
    await expect(otherPage.getByText("已確認版本 2。")).toBeVisible();

    await page.getByLabel("階段草稿文字").fill("衝突後保留的本地內容");
    await page.getByRole("button", { name: "保存", exact: true }).click();
    await expect(page.getByRole("button", { name: "查看版本衝突說明" })).toBeVisible();
    await page.getByRole("button", { name: "查看版本衝突說明" }).click();
    await expect(page.getByRole("dialog")).toContainText("伺服器目前是版本 2");
    await page.getByRole("button", { name: "保留本地，採用目前版本作為更新基準" }).click();
    await page.getByRole("button", { name: "保存", exact: true }).click();
    await expect(page.getByText("已確認版本 3。")).toBeVisible();
    await expect(page.getByLabel("階段草稿文字")).toHaveValue("衝突後保留的本地內容");

    await control.query("UPDATE app.profiles SET status='disabled' WHERE id=$1", [account.id]);
    await page.getByLabel("階段草稿文字").fill("失權後的本地草稿");
    await page.getByRole("button", { name: "保存", exact: true }).click();
    await expect(page.getByText("沒有權限", { exact: true })).toBeVisible();
    await expect(page.getByLabel("階段草稿文字")).toHaveCount(0);
    await expect(page.getByTestId("confirmed-server-draft")).toHaveCount(0);
    await control.query("UPDATE app.profiles SET status='approved' WHERE id=$1", [account.id]);
  } finally {
    for (const context of contexts) await context.close();
    if (projectId) {
      await control.query("DELETE FROM app.stage_draft_idempotency WHERE project_id=$1", [projectId]);
      await control.query("DELETE FROM app.stage_records WHERE project_id=$1", [projectId]);
      await control.query("DELETE FROM app.project_create_idempotency WHERE project_id=$1", [projectId]);
      await control.query("DELETE FROM app.projects WHERE id=$1", [projectId]);
    }
    await control.query("DELETE FROM app.profiles WHERE id=$1", [account.id]);
    await control.query("DELETE FROM app.schools WHERE id=$1", [account.schoolId]);
    await deleteSyntheticAuthAccount(account);
    await control.end();
  }
});

test("真 Auth 暫時不可用時保留未知建立操作；恢復後只查詢原鍵且無假清單", async ({ browser }) => {
  const control = openControlPool();
  const account = await createSyntheticAuthAccount(control, "AuthUnavailableBrowser");
  const context = await browser.newContext({ locale: "zh-TW" });
  const appOrigin = process.env.APP_PLANET_APP_ORIGIN!;
  const container = process.env.APP_PLANET_TEST_AUTH_CONTAINER;
  if (!container || !/^supabase_auth_app-planet-auth-[a-f0-9]{12}$/.test(container)) {
    throw new Error("瀏覽器 Auth 故障注入必須指定本批隔離容器。");
  }
  const docker = promisify(execFile);
  let paused = false;
  try {
    const session = await loginSyntheticAccount(account);
    await context.addCookies([{
      name: sessionCookieName, value: session.accessToken, url: appOrigin,
      httpOnly: true, secure: true, sameSite: "Strict",
    }]);
    const page = await context.newPage();
    const createRequests: { key: string | undefined; body: string | null }[] = [];
    const recoveryRequests: { key: string | undefined; body: string | null }[] = [];
    page.on("request", (request) => {
      if (request.method() !== "POST") return;
      const path = new URL(request.url()).pathname;
      const record = { key: request.headers()["idempotency-key"], body: request.postData() };
      if (path === "/api/v1/projects") createRequests.push(record);
      if (path === "/api/v1/projects/recovery") recoveryRequests.push(record);
    });
    await page.goto(`${appOrigin}/student`);
    await page.getByLabel("專案名稱").fill("Auth 依賴故障不建立");
    await docker("docker", ["pause", container], { timeout: 15_000 });
    paused = true;
    const createResponse = page.waitForResponse((response) =>
      new URL(response.url()).pathname === "/api/v1/projects" && response.request().method() === "POST");
    await page.getByRole("button", { name: "建立專案", exact: true }).click();
    expect((await createResponse).status()).toBe(503);
    await expect(page.getByLabel("專案名稱")).toBeDisabled();
    const saved = await readIntentEntry(page);
    expect(saved).not.toBeNull();
    expect(JSON.parse(saved!.value!)).toMatchObject({
      v: 3, payload: { title: "Auth 依賴故障不建立" },
    });
    expect(createRequests).toHaveLength(1);
    expect(createRequests[0].key).toBe(JSON.parse(saved!.value!).key);
    await page.reload();
    await expect(page.getByText("目前無法確認登入狀態；受保護資料不會顯示。")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("owned-project-list")).toHaveCount(0);
    expect((await control.query("SELECT count(*)::int AS n FROM app.projects WHERE owner_id=$1", [account.id])).rows[0].n).toBe(0);
    await docker("docker", ["unpause", container], { timeout: 15_000 });
    paused = false;
    await page.reload();
    await expect(page.getByLabel("專案名稱")).toHaveValue("Auth 依賴故障不建立");
    await page.getByRole("button", { name: "只查詢原操作" }).click();
    await expect(page.getByText("無法從有效完整的 receipt 確認")).toBeVisible();
    expect(recoveryRequests).toHaveLength(1);
    expect(recoveryRequests[0]).toEqual(createRequests[0]);
    expect(await readIntent(page, saved!.key)).toBe(saved!.value);
    expect((await control.query("SELECT count(*)::int AS n FROM app.projects WHERE owner_id=$1", [account.id])).rows[0].n)
      .toBe(0);
    await context.clearCookies();
    await page.reload();
    await expect(page.getByText("尚未登入或工作階段已失效；請使用核准的登入流程。")).toBeVisible();
    await expect(page.getByLabel("專案名稱")).toHaveCount(0);
  } finally {
    if (paused) await docker("docker", ["unpause", container], { timeout: 15_000 });
    await context.close();
    await control.query("DELETE FROM app.profiles WHERE id=$1", [account.id]);
    await control.query("DELETE FROM app.schools WHERE id=$1", [account.schoolId]);
    await deleteSyntheticAuthAccount(account);
    await control.end();
  }
});

test("receipt 到期與帳號隔離：只送 replay-only、保留原鍵；舊版／損壞／storage 失敗均停止", async ({ browser }) => {
  const control = openControlPool();
  const account = await createSyntheticAuthAccount(control, "ExpiryBrowser");
  const other = await createSyntheticAuthAccount(control, "ExpiryOtherBrowser");
  const context = await browser.newContext({ locale: "zh-TW" });
  const appOrigin = process.env.APP_PLANET_APP_ORIGIN!;
  let projectId: string | null = null;
  const cookie = (token: string) => ({
    name: sessionCookieName, value: token, url: appOrigin, httpOnly: true, secure: true, sameSite: "Strict" as const,
  });
  const count = async () => (await control.query(
    "SELECT count(*)::int AS n FROM app.projects WHERE owner_id=$1", [account.id])).rows[0].n;
  const createRequests: { key: string | undefined; body: string | null }[] = [];
  const recoveryRequests: { key: string | undefined; body: string | null }[] = [];
  try {
    await context.addCookies([cookie((await loginSyntheticAccount(account)).accessToken)]);
    const page = await context.newPage();
    page.on("request", (request) => {
      if (request.method() !== "POST") return;
      const path = new URL(request.url()).pathname;
      const record = { key: request.headers()["idempotency-key"], body: request.postData() };
      if (path === "/api/v1/projects") {
        createRequests.push(record);
      } else if (path === "/api/v1/projects/recovery") {
        recoveryRequests.push(record);
      }
    });
    await page.goto(`${appOrigin}/student`);
    await page.getByLabel("專案名稱").fill("到期後不得重複建立");
    await page.route("**/api/v1/projects", async (route) => {
      const response = await route.fetch();
      expect(response.status()).toBe(201);
      projectId = (await response.json()).id;
      await route.abort("connectionreset");
    }, { times: 1 });
    await page.getByRole("button", { name: "建立專案", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: "建立結果仍待確認" })).toBeVisible();
    expect(await count()).toBe(1);
    const savedEntry = await readIntentEntry(page);
    expect(savedEntry).not.toBeNull();
    const stored = JSON.parse(savedEntry!.value!);
    expect(stored).toMatchObject({ v: 3, payload: { title: "到期後不得重複建立" } });

    // 以隔離 DB 的 receipt 時間欄位模擬到期，不等待 24 小時、不改主機時鐘。
    await control.query(
      `UPDATE app.project_create_idempotency
         SET created_at = created_at - interval '25 hours', expires_at = expires_at - interval '25 hours'
       WHERE owner_id=$1`, [account.id]);
    await page.reload();
    await expect(page.getByLabel("專案名稱")).toHaveValue("到期後不得重複建立");
    await page.getByRole("button", { name: "只查詢原操作" }).click();
    await expect(page.getByText("無法從有效完整的 receipt 確認")).toBeVisible();
    await expect(page.getByRole("button", { name: "操作已停止" })).toBeDisabled();
    await expect(page.getByLabel("專案名稱")).toBeDisabled();
    expect(createRequests).toHaveLength(1);
    expect(recoveryRequests).toHaveLength(1);
    expect(recoveryRequests[0]).toEqual(createRequests[0]);
    expect(await count()).toBe(1);
    expect(await readIntent(page, savedEntry!.key)).toBe(savedEntry!.value);
    await page.reload();
    await expect(page.getByRole("button", { name: "只查詢原操作" })).toBeEnabled();
    expect(recoveryRequests).toHaveLength(1);

    // §84 localStorage v3 是唯讀相容來源；即使只有此紀錄仍只查 recovery。
    await page.evaluate(({ storageKey, raw }) => {
      sessionStorage.removeItem(storageKey);
      localStorage.setItem(storageKey, raw);
    }, { storageKey: savedEntry!.key, raw: savedEntry!.value! });
    await page.reload();
    await expect(page.getByRole("button", { name: "只查詢原操作" })).toBeEnabled();
    await page.getByRole("button", { name: "只查詢原操作" }).click();
    await expect(page.getByText("無法從有效完整的 receipt 確認")).toBeVisible();
    expect(await page.evaluate((storageKey) => sessionStorage.getItem(storageKey), savedEntry!.key)).toBeNull();
    expect(await page.evaluate((storageKey) => localStorage.getItem(storageKey), savedEntry!.key))
      .toBe(savedEntry!.value);
    expect(createRequests).toHaveLength(1);
    expect(recoveryRequests).toHaveLength(2);
    await page.evaluate((storageKey) => localStorage.removeItem(storageKey), savedEntry!.key);

    // 舊版、缺欄位、損壞：載入即停止，不補欄位、不自動送出，保留原字串。
    for (const raw of [
      JSON.stringify({ key: stored.key, payload: stored.payload }),
      JSON.stringify({ ...stored, payload: undefined }),
      JSON.stringify({ ...stored, key: "not-a-uuid" }),
      "{損壞",
    ]) {
      await writeIntent(page, raw, savedEntry!.key);
      await page.reload();
      await expect(page.getByRole("button", { name: "建立專案", exact: true })).toBeDisabled();
      await expect(page.getByLabel("專案名稱")).toBeDisabled();
      await expect(page.getByRole("status").filter({ hasText: "已停止送出" })).toBeVisible();
      expect(await readIntent(page, savedEntry!.key)).toBe(raw);
    }
    expect(createRequests).toHaveLength(1);
    expect(recoveryRequests).toHaveLength(2);
    expect(await count()).toBe(1);

    // 不同帳號不恢復另一帳號的紀錄；原帳號的本機紀錄仍未被讀寫或移除。
    await writeIntent(page, savedEntry!.value!, savedEntry!.key);
    await context.addCookies([cookie((await loginSyntheticAccount(other)).accessToken)]);
    await page.reload();
    await expect(page.getByLabel("專案名稱")).toHaveValue("");
    await expect(page.getByLabel("專案名稱")).toBeEnabled();
    await expect(page.getByRole("button", { name: "建立專案", exact: true })).toBeEnabled();
    expect(await readIntent(page, savedEntry!.key)).toBe(savedEntry!.value);
    expect(createRequests).toHaveLength(1);
    expect(recoveryRequests).toHaveLength(2);
    expect(await count()).toBe(1);

    const blockedStoragePage = await context.newPage();
    await blockedStoragePage.addInitScript(() => {
      Object.defineProperty(window, "localStorage", {
        configurable: true,
        get() { throw new DOMException("storage unavailable", "SecurityError"); },
      });
    });
    await blockedStoragePage.goto(`${appOrigin}/student`);
    await expect(blockedStoragePage.getByRole("status").filter({ hasText: "無法安全讀取或保存本機操作紀錄" }))
      .toBeVisible();
    await expect(blockedStoragePage.getByRole("button", { name: "建立專案", exact: true })).toBeDisabled();
    expect(createRequests).toHaveLength(1);
    expect(recoveryRequests).toHaveLength(2);
    await blockedStoragePage.close();

    const blockedSessionPage = await context.newPage();
    await blockedSessionPage.addInitScript(() => {
      Object.defineProperty(window, "sessionStorage", {
        configurable: true,
        get() { throw new DOMException("storage unavailable", "SecurityError"); },
      });
    });
    await blockedSessionPage.goto(`${appOrigin}/student`);
    await expect(blockedSessionPage.getByRole("status").filter({ hasText: "無法安全讀取或保存本機操作紀錄" }))
      .toBeVisible();
    await expect(blockedSessionPage.getByRole("button", { name: "建立專案", exact: true })).toBeDisabled();
    expect(createRequests).toHaveLength(1);
    expect(recoveryRequests).toHaveLength(2);
    await blockedSessionPage.close();

    const failedWritePage = await context.newPage();
    await failedWritePage.addInitScript((prefix) => {
      const original = Storage.prototype.setItem;
      Storage.prototype.setItem = function (key, value) {
        if (key.startsWith(prefix)) throw new DOMException("storage unavailable", "QuotaExceededError");
        return original.call(this, key, value);
      };
    }, intentPrefix);
    await failedWritePage.goto(`${appOrigin}/student`);
    await failedWritePage.getByLabel("專案名稱").fill("sessionStorage 寫入失敗不得建立");
    await failedWritePage.getByRole("button", { name: "建立專案", exact: true }).click();
    await expect(failedWritePage.getByRole("status").filter({ hasText: "無法安全保存操作識別" })).toBeVisible();
    expect(createRequests).toHaveLength(1);
    expect(recoveryRequests).toHaveLength(2);
    await failedWritePage.close();
  } finally {
    await context.close();
    for (const owner of [account.id, other.id]) {
      await control.query("DELETE FROM app.project_create_idempotency WHERE owner_id=$1", [owner]);
      await control.query("DELETE FROM app.projects WHERE owner_id=$1", [owner]);
    }
    for (const item of [account, other]) {
      await control.query("DELETE FROM app.profiles WHERE id=$1", [item.id]);
      await control.query("DELETE FROM app.schools WHERE id=$1", [item.schoolId]);
      await deleteSyntheticAuthAccount(item);
    }
    await control.end();
  }
});

test("response-loss 後失權保留原鍵；同帳號重新驗證只走 replay-only，失敗不清除未知操作", async ({ browser }) => {
  const control = openControlPool();
  const account = await createSyntheticAuthAccount(control, "ProjectBrowser");
  const context = await browser.newContext({ locale: "zh-TW" });
  let projectId: string | null = null;
  const appOrigin = process.env.APP_PLANET_APP_ORIGIN!;
  try {
    const session = await loginSyntheticAccount(account);
    await context.addCookies([{
      name: sessionCookieName, value: session.accessToken, url: appOrigin,
      httpOnly: true, secure: true, sameSite: "Strict",
    }]);
    const page = await context.newPage();
    const createRequests: { key: string | undefined; body: string | null }[] = [];
    const recoveryRequests: { key: string | undefined; body: string | null }[] = [];
    page.on("request", (request) => {
      if (request.method() !== "POST") return;
      const path = new URL(request.url()).pathname;
      const record = { key: request.headers()["idempotency-key"], body: request.postData() };
      if (path === "/api/v1/projects") createRequests.push(record);
      if (path === "/api/v1/projects/recovery") recoveryRequests.push(record);
    });
    await page.goto(`${appOrigin}/student`);
    await page.getByLabel("專案名稱").fill("回應遺失驗收");
    await page.route("**/api/v1/projects", async (route) => {
      const response = await route.fetch();
      expect(response.status()).toBe(201);
      projectId = (await response.json()).id;
      await route.abort("connectionreset");
    }, { times: 1 });
    await page.getByRole("button", { name: "建立專案", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: "建立結果仍待確認" })).toBeVisible();
    await expect(page.getByLabel("專案名稱")).toBeDisabled();
    const storedBefore = await readIntent(page);
    expect(JSON.parse(storedBefore!)).toMatchObject({ v: 3, payload: { title: "回應遺失驗收" } });
    const originalEntry = await readIntentEntry(page);
    expect(originalEntry?.value).toBe(storedBefore);

    await control.query("UPDATE app.profiles SET status='disabled' WHERE id=$1", [account.id]);
    await page.getByRole("button", { name: "只查詢原操作" }).click();
    await expect(page.getByText("無法確認存取權限；受保護專案資料已隱藏。")).toBeVisible();
    expect(await readIntent(page, originalEntry!.key)).toBe(storedBefore);
    expect(createRequests).toHaveLength(1);
    expect(recoveryRequests).toHaveLength(1);
    expect(recoveryRequests[0]).toEqual(createRequests[0]);
    expect((await control.query("SELECT count(*)::int AS n FROM app.projects WHERE owner_id=$1", [account.id])).rows[0].n)
      .toBe(1);

    await control.query("UPDATE app.profiles SET status='approved' WHERE id=$1", [account.id]);
    const replacementSession = await loginSyntheticAccount(account);
    await context.addCookies([{
      name: sessionCookieName, value: replacementSession.accessToken, url: appOrigin,
      httpOnly: true, secure: true, sameSite: "Strict",
    }]);
    await page.reload();
    await expect(page.getByLabel("專案名稱")).toHaveValue("回應遺失驗收");
    await expect(page.getByLabel("專案名稱")).toBeDisabled();
    expect(await readIntent(page, originalEntry!.key)).toBe(storedBefore);
    await page.getByRole("button", { name: "只查詢原操作" }).click();
    await expect(page.getByText("伺服器已確認原操作建立專案；分類仍未確認。")).toBeVisible();
    expect(createRequests).toHaveLength(1);
    expect(recoveryRequests).toHaveLength(2);
    expect(recoveryRequests[0]).toEqual(recoveryRequests[1]);
    expect(await readIntent(page)).toBeNull();
    expect((await control.query("SELECT count(*)::int AS n FROM app.projects WHERE owner_id=$1", [account.id])).rows[0].n).toBe(1);
    await expect(page.getByTestId("owned-project-list")).toContainText("回應遺失驗收");

    const detail = await context.newPage();
    await detail.goto(`${appOrigin}/student/projects/${projectId}`);
    await expect(detail.getByRole("heading", { name: "回應遺失驗收" })).toBeVisible();
    await control.query("REVOKE EXECUTE ON FUNCTION app.current_account_gate(text) FROM authenticated");
    try {
      await page.getByLabel("專案名稱").fill("DB 無法確認不得假成功");
      await page.getByRole("button", { name: "建立專案", exact: true }).click();
      await expect(page.getByRole("status").filter({ hasText: "建立結果仍待確認" })).toBeVisible();
      expect(createRequests).toHaveLength(2);
      expect(await readIntent(page)).not.toBeNull();
      await detail.reload();
      await expect(detail.getByRole("alert")
        .filter({ hasText: "目前無法確認登入、資料庫或專案服務；受保護資料已隱藏，請稍後重新載入。" }))
        .toBeVisible();
      await page.reload();
      await expect(page.getByText("專案服務暫時無法確認；不是空清單，請稍後重新載入。")).toBeVisible();
      await expect(page.getByTestId("owned-project-list")).toHaveCount(0);
    } finally {
      await control.query("GRANT EXECUTE ON FUNCTION app.current_account_gate(text) TO authenticated");
    }
    await control.query("UPDATE app.profiles SET status='approved' WHERE id=$1", [account.id]);
    await page.reload();
    await expect(page.getByRole("button", { name: "只查詢原操作" })).toBeEnabled();
    await page.getByRole("button", { name: "只查詢原操作" }).click();
    await expect(page.getByText("無法從有效完整的 receipt 確認")).toBeVisible();
    expect(createRequests).toHaveLength(2);
    expect(recoveryRequests).toHaveLength(3);
    expect(await readIntent(page)).not.toBeNull();
    expect((await control.query("SELECT count(*)::int AS n FROM app.projects WHERE owner_id=$1", [account.id])).rows[0].n)
      .toBe(1);
    await control.query("GRANT EXECUTE ON FUNCTION app.current_account_gate(text) TO authenticated");
    await detail.reload();
    await expect(page.getByTestId("owned-project-list")).toContainText("回應遺失驗收");
    await control.query("UPDATE app.profiles SET status='disabled' WHERE id=$1", [account.id]);
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await detail.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(page.getByTestId("owned-project-list")).toHaveCount(0);
    await expect(detail.getByRole("heading", { name: "回應遺失驗收" })).toHaveCount(0);
    expect((await control.query("SELECT count(*)::int AS n FROM app.projects WHERE owner_id=$1", [account.id])).rows[0].n).toBe(1);
  } finally {
    await context.close();
    if (projectId) {
      await control.query("DELETE FROM app.project_create_idempotency WHERE project_id=$1", [projectId]);
      await control.query("DELETE FROM app.projects WHERE id=$1", [projectId]);
    }
    await control.query("DELETE FROM app.profiles WHERE id=$1", [account.id]);
    await control.query("DELETE FROM app.schools WHERE id=$1", [account.schoolId]);
    await deleteSyntheticAuthAccount(account);
    await control.end();
  }
});
