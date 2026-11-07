import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import {
  createOwnedSyntheticProject,
  createSyntheticAuthAccount,
  loginSyntheticAccount,
  openControlPool,
} from "../support/real-auth-fixture.ts";
import { sessionCookieName } from "../../apps/web/src/server/auth-principal.ts";
import { armHold, holdState, installResponseHold, releaseHoldAndDrain, waitBodyAwaited } from "../support/response-hold.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

test("學生在版本頁完整恢復 A、reload 後找回 B，且空目標明確清空", async ({ browser }) => {
  test.setTimeout(300_000);
  const control = openControlPool();
  const account = await createSyntheticAuthAccount(control, "ProjectRestoreE2E");
  const session = await loginSyntheticAccount(account);
  const projectId = await createOwnedSyntheticProject(account);
  const otherProjectId = await createOwnedSyntheticProject(account);
  const appOrigin = process.env.APP_PLANET_APP_ORIGIN;
  if (!appOrigin) throw new Error("隔離瀏覽器測試缺少本機 app origin。");
  const context = await browser.newContext({ locale: "zh-TW" });
  const cookie = {
    name: sessionCookieName, value: session.accessToken, url: appOrigin,
    httpOnly: true, secure: true, sameSite: "Strict" as const,
  };
  await context.addCookies([cookie]);
  await context.addInitScript(installResponseHold);
  const page = await context.newPage();
  await page.route(`**/api/v1/projects/${projectId}/**`, (route) => route.fallback());
  let renewalError: unknown = null;
  const renewSession = async () => {
    const renewed = await loginSyntheticAccount(account);
    await context.addCookies([{ ...cookie, value: renewed.accessToken }]);
  };
  const sessionRenewal = setInterval(() => {
    renewSession().catch((error: unknown) => { renewalError = error; });
  }, 30_000);

  try {
    await page.goto(`${appOrigin}/student/projects/${projectId}/build`, {
      waitUntil: "domcontentloaded", timeout: 30_000,
    });
    const workspace = page.getByTestId("project-file-workspace");
    await expect(workspace).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole("button", { name: "建立 manual 快照" })).toBeEnabled({ timeout: 15_000 });

    const createAndSave = async (path: string, text: string) => {
      await page.getByLabel("新增檔案名稱").fill(path);
      await page.getByRole("link", { name: "新增檔案", exact: true }).click();
      const editor = page.getByRole("textbox", { name: `${path} 原始碼文字編輯器` });
      await expect(editor).toBeVisible({ timeout: 15_000 });
      await editor.press("Control+A");
      await page.keyboard.insertText(text);
      const saved = page.waitForResponse((response) =>
        new URL(response.url()).pathname === `/api/v1/projects/${projectId}/files/${path}` &&
        response.request().method() === "PUT", { timeout: 20_000 });
      await page.getByRole("button", { name: "保存到資料庫" }).click();
      expect([200, 201]).toContain((await saved).status());
      await expect(page.getByText(/DB 已保存版本：SHA-256/)).toBeVisible();
    };

    const makeManualSnapshot = async () => {
      const responsePromise = page.waitForResponse((response) =>
        new URL(response.url()).pathname === `/api/v1/projects/${projectId}/snapshots` &&
        response.request().method() === "POST", { timeout: 20_000 });
      await page.getByRole("button", { name: "建立 manual 快照" }).click();
      const response = await responsePromise;
      expect(response.status()).toBe(201);
      return response.json();
    };

    const emptySnapshot = await makeManualSnapshot();
    expect(emptySnapshot.version_no).toBe(1);
    const contentA = "<h1>已保存版本 A</h1>";
    await createAndSave("index.html", contentA);
    await createAndSave("a-only.css", "A 的檔案");
    const snapshotA = await makeManualSnapshot();
    expect(snapshotA.version_no).toBe(2);

    await page.getByTestId("project-file-index.html").click();
    const indexEditor = page.getByRole("textbox", { name: "index.html 原始碼文字編輯器" });
    await expect(page.locator(".monaco-editor .view-lines")).toContainText("已保存版本 A");
    const contentB = "<h1>已保存版本 B</h1>";
    await indexEditor.press("Control+A");
    await page.keyboard.insertText(contentB);
    const updateResponse = page.waitForResponse((response) =>
      new URL(response.url()).pathname === `/api/v1/projects/${projectId}/files/index.html` &&
      response.request().method() === "PUT", { timeout: 20_000 });
    await page.getByRole("button", { name: "保存到資料庫" }).click();
    expect((await updateResponse).status()).toBe(200);
    await createAndSave("b-only.css", "B 的額外檔案");

    await page.goto(`${appOrigin}/student/projects/${projectId}/versions`, {
      waitUntil: "domcontentloaded", timeout: 30_000,
    });
    await expect(page.getByTestId("project-file-workspace")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("project-file-b-only.css")).toBeVisible();
    const aRow = page.locator("li").filter({ hasText: /版本 2（manual）/ });
    await aRow.getByRole("button", { name: "查看並恢復此版本" }).click();
    const aConfirmation = page.getByRole("alertdialog", { name: "確認完整恢復版本" });
    await expect(aConfirmation).toContainText("版本 2（manual）");
    await expect(aConfirmation).toContainText("目標檔案數：2");
    await expect(aConfirmation).toContainText("完整取代目前已保存檔案");

    const saveFailureProblem = {
      type: "about:blank", title: "無法先保存目前版本", status: 409,
      code: "save_failed", instance: `/api/v1/projects/${projectId}/restore`,
      request_id: randomUUID(), user_message_zh: "目前已保存檔案未變更，請重新載入核對。",
    };
    await page.route(`**/api/v1/projects/${projectId}/restore`, (route) =>
      route.fulfill({ status: 409, contentType: "application/problem+json",
        body: JSON.stringify(saveFailureProblem) }), { times: 1 });
    await aConfirmation.getByRole("button", { name: "確認完整取代並恢復" }).click();
    await expect(page.getByText("保存完整恢復前版本失敗；已保存檔案未變更，可重新確認後再試。"))
      .toBeVisible();
    expect(await page.evaluate((id) => Object.keys(window.sessionStorage)
      .filter((key) => key.endsWith(`.${id}.restore-pending`)), projectId)).toHaveLength(0);
    await expect(page.getByTestId("project-file-b-only.css")).toBeVisible();

    const committedRestore = deferred<{ status: number; body: string; key: string }>();
    await page.route(`**/api/v1/projects/${projectId}/restore`, async (route) => {
      const response = await route.fetch();
      committedRestore.resolve({
        status: response.status(),
        body: await response.text(),
        key: route.request().headers()["idempotency-key"] ?? "",
      });
      await route.abort();
    }, { times: 1 });
    await aConfirmation.getByRole("button", { name: "確認完整取代並恢復" }).click();
    const lostResponse = await committedRestore.promise;
    expect(lostResponse.status).toBe(200);
    const firstReceipt = JSON.parse(lostResponse.body) as { pre_restore_snapshot_id: string };
    const restoreStorageKey = await page.evaluate((id) =>
      Object.keys(window.sessionStorage).find((key) => key.endsWith(`.${id}.restore-pending`)) ?? null,
    projectId);
    if (!restoreStorageKey) throw new Error("恢復結果未知時未保留原操作識別。");
    const operationRecord = await page.evaluate((key) => window.sessionStorage.getItem(key), restoreStorageKey);
    if (!operationRecord) throw new Error("恢復結果未知時未保存原操作資料。");
    expect(operationRecord).toContain(lostResponse.key);
    expect(JSON.parse(operationRecord).snapshot_id).toBe(snapshotA.id);
    await expect(page.getByText(/恢復結果未知；原目標與操作識別已保留/)).toBeVisible();
    await page.reload();
    await expect(page.getByTestId("project-file-workspace")).toBeVisible({ timeout: 15_000 });
    const replayConfirmation = page.getByRole("alertdialog", { name: "確認完整恢復版本" });
    await expect(replayConfirmation).toContainText("版本 2（manual）");
    await expect(replayConfirmation).toContainText(/恢復結果尚未確認/);
    const replayButton = replayConfirmation.getByRole("button", { name: "以原操作重試恢復" });
    for (const status of [401, 403, 404]) {
      await page.route(`**/api/v1/projects/${projectId}/restore`, (route) =>
        route.fulfill({ status, contentType: "application/problem+json", body: JSON.stringify({
          type: "about:blank", title: "目前無法確認", status,
          code: status === 401 ? "unauthenticated" : status === 403 ? "forbidden" : "not_found",
          instance: `/api/v1/projects/${projectId}/restore`, request_id: randomUUID(),
          user_message_zh: "目前無法確認存取權限。",
        }) }), { times: 1 });
      await expect(replayButton).toBeEnabled();
      await replayButton.click();
      await expect(page.getByTestId("project-workspace-closed")
        .getByText(/目前無法確認原恢復結果；原鍵與原目標已保留/)).toBeVisible();
      expect(await page.evaluate((key) => window.sessionStorage.getItem(key), restoreStorageKey))
        .toBe(operationRecord);
      await expect(page.getByTestId("project-file-workspace")).toBeHidden();
      await expect(page.getByText("恢復遭拒；已保存檔案未變更。請重新載入並確認目前版本。")).toHaveCount(0);
      await page.reload();
      await expect(replayConfirmation).toContainText(/恢復結果尚未確認/);
    }
    const replayPromise = page.waitForResponse((response) =>
      new URL(response.url()).pathname === `/api/v1/projects/${projectId}/restore` &&
      response.request().method() === "POST", { timeout: 20_000 });
    await expect(replayButton).toBeEnabled();
    await replayButton.click();
    const replayResponse = await replayPromise;
    expect(replayResponse.status()).toBe(200);
    expect(replayResponse.request().headers()["idempotency-key"]).toBe(lostResponse.key);
    expect(replayResponse.request().headers()["idempotency-replay-only"]).toBe("true");
    expect(await replayResponse.json()).toEqual(firstReceipt);
    await expect(page.getByTestId("project-file-a-only.css")).toBeVisible();
    await expect(page.getByTestId("project-file-b-only.css")).toHaveCount(0);

    await page.reload();
    await expect(page.getByTestId("project-file-workspace")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("project-file-a-only.css")).toBeVisible();
    await expect(page.getByTestId("project-file-b-only.css")).toHaveCount(0);
    await page.getByTestId("project-file-index.html").click();
    await expect(page.locator(".monaco-editor .view-lines")).toContainText("已保存版本 A");

    const bRow = page.locator("li").filter({ hasText: /版本 3（pre_restore）/ });
    await page.getByRole("textbox", { name: "index.html 原始碼文字編輯器" }).press("Control+A");
    await page.keyboard.insertText("未保存草稿不得被恢復覆蓋");
    const bRestore = bRow.getByRole("button", { name: "查看並恢復救援副本" });
    await expect(bRestore).toBeDisabled();
    const saveReachedDatabase = deferred<number>();
    const releaseSaveResponse = deferred<void>();
    await page.route(`**/api/v1/projects/${projectId}/files/index.html`, async (route) => {
      const response = await route.fetch();
      saveReachedDatabase.resolve(response.status());
      await releaseSaveResponse.promise;
      await route.fulfill({ response });
    }, { times: 1 });
    const saveResponse = page.waitForResponse((response) =>
      new URL(response.url()).pathname === `/api/v1/projects/${projectId}/files/index.html` &&
      response.request().method() === "PUT", { timeout: 20_000 });
    await page.getByRole("button", { name: "保存到資料庫" }).click();
    expect(await saveReachedDatabase.promise).toBe(200);
    try {
      await expect(bRestore).toBeDisabled();
    } finally {
      releaseSaveResponse.resolve();
    }
    expect((await saveResponse).status()).toBe(200);
    await expect(bRestore).toBeEnabled();
    await bRestore.click();
    const bConfirmation = page.getByRole("alertdialog", { name: "確認完整恢復版本" });
    await expect(bConfirmation).toContainText("版本 3（pre_restore）");
    await expect(page.getByRole("region", { name: "快照 manifest" })).toContainText("b-only.css");
    const bSnapshotId = (await bRow.locator("code").first().textContent())?.trim();
    if (!bSnapshotId) throw new Error("版本清單缺少救援副本識別。");
    const malformedRestore = deferred<{ status: number; key: string }>();
    await page.route(`**/api/v1/projects/${projectId}/restore`, async (route) => {
      const response = await route.fetch();
      malformedRestore.resolve({
        status: response.status(),
        key: route.request().headers()["idempotency-key"] ?? "",
      });
      await route.fulfill({
        status: response.status(), contentType: "application/json", body: "{}",
      });
    }, { times: 1 });
    const malformedResponse = page.waitForResponse((response) =>
      new URL(response.url()).pathname === `/api/v1/projects/${projectId}/restore` &&
      response.request().method() === "POST", { timeout: 20_000 });
    await bConfirmation.getByRole("button", { name: "確認完整取代並恢復" }).click();
    const malformedCommit = await malformedRestore.promise;
    expect(malformedCommit.status).toBe(200);
    expect((await malformedResponse).status()).toBe(200);
    await expect(page.getByText(/恢復回應缺少可信收據；原目標與操作識別已保留/)).toBeVisible();
    const malformedRecord = await page.evaluate((key) => window.sessionStorage.getItem(key), restoreStorageKey);
    if (!malformedRecord) throw new Error("無效恢復收據後未保存原操作資料。");
    expect(JSON.parse(malformedRecord).snapshot_id).toBe(bSnapshotId);
    expect(malformedRecord).toContain(malformedCommit.key);
    await page.reload();
    await expect(page.getByTestId("project-file-workspace")).toBeVisible({ timeout: 15_000 });
    const recoveredBConfirmation = page.getByRole("alertdialog", { name: "確認完整恢復版本" });
    await expect(recoveredBConfirmation).toContainText("版本 3（pre_restore）");
    await expect(recoveredBConfirmation).toContainText(/恢復結果尚未確認/);
    const recoverBResponse = page.waitForResponse((response) =>
      new URL(response.url()).pathname === `/api/v1/projects/${projectId}/restore` &&
      response.request().method() === "POST", { timeout: 20_000 });
    const recoverBButton = recoveredBConfirmation.getByRole("button", { name: "以原操作重試恢復" });
    await expect(recoverBButton).toBeEnabled();
    await recoverBButton.click();
    expect((await recoverBResponse).status()).toBe(200);
    expect((await recoverBResponse).request().headers()["idempotency-key"]).toBe(malformedCommit.key);
    expect((await recoverBResponse).request().headers()["idempotency-replay-only"]).toBe("true");
    await expect(page.getByTestId("project-file-b-only.css")).toBeVisible();
    await page.reload();
    await expect(page.getByTestId("project-file-b-only.css")).toBeVisible({ timeout: 15_000 });
    await page.getByTestId("project-file-index.html").click();
    await expect(page.locator(".monaco-editor .view-lines")).toContainText("已保存版本 B");

    const emptyRow = page.locator("li").filter({ hasText: /版本 1（manual）/ });
    await emptyRow.getByRole("button", { name: "查看並恢復此版本" }).click();
    const emptyConfirmation = page.getByRole("alertdialog", { name: "確認完整恢復版本" });
    await expect(emptyConfirmation).toContainText("目標檔案數：0");
    await expect(emptyConfirmation).toContainText("恢復後專案將沒有任何已保存檔案");
    const emptyResponse = page.waitForResponse((response) =>
      new URL(response.url()).pathname === `/api/v1/projects/${projectId}/restore` &&
      response.request().method() === "POST", { timeout: 20_000 });
    await emptyConfirmation.getByRole("button", { name: "確認完整取代並恢復" }).click();
    expect((await emptyResponse).status()).toBe(200);
    await expect(page.getByText("目前沒有檔案。新增 HTML、CSS 或 JavaScript 檔案開始創作。")).toBeVisible();

    const tabs = page.getByTestId("project-workspace-tabs");
    const switchToVersions = async (id: string) => {
      await page.getByRole("link", { name: "工作台", exact: true }).click();
      await page.locator(`a[href="/student/projects/${id}"]`).click();
      await tabs.getByRole("link", { name: "版本", exact: true }).click();
      await expect(page).toHaveURL(`${appOrigin}/student/projects/${id}/versions`);
      await expect(page.getByTestId("project-file-workspace")).toBeVisible({ timeout: 15_000 });
    };
    await switchToVersions(otherProjectId);
    const bManualResponse = page.waitForResponse((response) =>
      new URL(response.url()).pathname === `/api/v1/projects/${otherProjectId}/snapshots` &&
      response.request().method() === "POST");
    await page.getByRole("button", { name: "建立 manual 快照" }).click();
    expect((await bManualResponse).status()).toBe(201);
    const otherSnapshot = await (await bManualResponse).json();
    await switchToVersions(projectId);

    const lateTarget = page.locator("li").filter({ hasText: /版本 3（pre_restore）/ });
    await lateTarget.getByRole("button", { name: "查看並恢復救援副本" }).click();
    const lateConfirmation = page.getByRole("alertdialog", { name: "確認完整恢復版本" });
    await expect(lateConfirmation).toContainText("版本 3（pre_restore）");
    const marker = randomUUID();
    await page.evaluate((value) => {
      (window as unknown as { __apDocument: string }).__apDocument = value;
    }, marker);
    await armHold(page, { method: "POST", pathSuffix: `/projects/${projectId}/restore` });
    await lateConfirmation.getByRole("button", { name: "確認完整取代並恢復" }).click();
    await waitBodyAwaited(page);
    expect(await holdState(page)).toEqual({ matched: 1, status: 200, jsonCalled: true, jsonSettled: false });
    const lateRecord = await page.evaluate((key) => window.sessionStorage.getItem(key), restoreStorageKey);
    if (!lateRecord) throw new Error("晚到恢復回應前未保存原操作資料。");
    expect(JSON.parse(lateRecord).snapshot_id).toBe(bSnapshotId);

    await switchToVersions(otherProjectId);
    await expect(page.getByText("目前沒有檔案。新增 HTML、CSS 或 JavaScript 檔案開始創作。")).toBeVisible();
    await expect(page.getByTestId("project-file-b-only.css")).toHaveCount(0);
    await page.locator("li").filter({ hasText: /版本 1（manual）/ })
      .getByRole("button", { name: "查看並恢復此版本" }).click();
    const bPendingConfirmation = page.getByRole("alertdialog", { name: "確認完整恢復版本" });
    await page.route(`**/api/v1/projects/${otherProjectId}/restore`, async (route) => {
      const response = await route.fetch();
      expect(response.status()).toBe(200);
      await route.abort();
    }, { times: 1 });
    await bPendingConfirmation.getByRole("button", { name: "確認完整取代並恢復" }).click();
    await expect(page.getByText(/恢復結果未知；原目標與操作識別已保留/)).toBeVisible();
    const bStorageKey = await page.evaluate((id) => Object.keys(window.sessionStorage)
      .find((key) => key.endsWith(`.${id}.restore-pending`)) ?? null, otherProjectId);
    if (!bStorageKey) throw new Error("專案 B 未保留待確認恢復操作。");
    const bRecord = await page.evaluate((key) => window.sessionStorage.getItem(key), bStorageKey);
    if (!bRecord) throw new Error("專案 B 原操作資料缺失。");
    expect(JSON.parse(bRecord).snapshot_id).toBe(otherSnapshot.id);
    const bDialogText = await bPendingConfirmation.innerText();
    const bVersionsText = await page.locator("ol").innerText();
    await releaseHoldAndDrain(page);
    expect(await holdState(page)).toEqual({ matched: 1, status: 200, jsonCalled: true, jsonSettled: true });
    expect(await page.evaluate((key) => window.sessionStorage.getItem(key), restoreStorageKey)).toBe(lateRecord);
    expect(await page.evaluate((key) => window.sessionStorage.getItem(key), bStorageKey)).toBe(bRecord);
    expect(await bPendingConfirmation.innerText()).toBe(bDialogText);
    expect(await page.locator("ol").innerText()).toBe(bVersionsText);
    await expect(bPendingConfirmation.getByRole("button", { name: "以原操作重試恢復" })).toBeEnabled();
    await expect(page.getByTestId("project-file-b-only.css")).toHaveCount(0);
    expect(await page.evaluate(() =>
      (window as unknown as { __apDocument: string }).__apDocument)).toBe(marker);
    console.info("RestoreLateBodyHTTPS=real_200;json_awaited;json_settled;same_document;A_B_records_byte_equal;B_state_unchanged");

    await switchToVersions(projectId);
    await expect(page.getByTestId("project-file-workspace")).toBeVisible({ timeout: 15_000 });
    const lateReplayConfirmation = page.getByRole("alertdialog", { name: "確認完整恢復版本" });
    await expect(lateReplayConfirmation).toContainText("版本 3（pre_restore）");
    const lateReplay = page.waitForResponse((response) =>
      new URL(response.url()).pathname === `/api/v1/projects/${projectId}/restore` &&
      response.request().method() === "POST", { timeout: 20_000 });
    await lateReplayConfirmation.getByRole("button", { name: "以原操作重試恢復" }).click();
    const lateReplayResponse = await lateReplay;
    expect(lateReplayResponse.status()).toBe(200);
    expect(lateReplayResponse.request().headers()["idempotency-key"]).toBe(JSON.parse(lateRecord).key);
    expect(lateReplayResponse.request().headers()["idempotency-replay-only"]).toBe("true");
    await expect(page.getByTestId("project-file-b-only.css")).toBeVisible();
    expect(await page.evaluate((key) => window.sessionStorage.getItem(key), bStorageKey)).toBe(bRecord);
    expect(renewalError).toBeNull();
  } finally {
    clearInterval(sessionRenewal);
    await context.close();
    await control.end();
  }
});
