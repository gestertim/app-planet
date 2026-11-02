import { expect, test, type Route } from "@playwright/test";
import {
  createSyntheticAuthAccount,
  deleteSyntheticAuthAccount,
  loginSyntheticAccount,
  openControlPool,
} from "../support/real-auth-fixture.ts";
import { sessionCookieName } from "../../apps/web/src/server/auth-principal.ts";

const storagePrefix = "app-planet.project-create.";

test("真 Auth／Next／DB 升級案例：sessionStorage v2 只走 recovery，原 key 不變且不重建", async ({ browser }) => {
  test.setTimeout(180_000);
  const control = openControlPool();
  const account = await createSyntheticAuthAccount(control, "RecoveryUpgrade");
  const session = await loginSyntheticAccount(account);
  const appOrigin = process.env.APP_PLANET_APP_ORIGIN;
  if (!appOrigin) throw new Error("隔離瀏覽器測試缺少本機 app origin。");
  const context = await browser.newContext({ locale: "zh-TW" });
  let projectId: string | null = null;
  let recoveredKey: string | null = null;
  const posts: Array<{ path: string; key: string | undefined }> = [];
  const dropCreateResponse = async (route: Route) => {
    const response = await route.fetch();
    expect(response.status()).toBe(201);
    const body: unknown = await response.json();
    if (typeof body !== "object" || body === null || !("id" in body) || typeof body.id !== "string") {
      throw new Error("P-1 實際建立回應缺少專案 ID。");
    }
    projectId = body.id;
    await route.abort("connectionreset");
  };

  try {
    await context.addCookies([{
      name: sessionCookieName,
      value: session.accessToken,
      url: appOrigin,
      httpOnly: true,
      secure: true,
      sameSite: "Strict",
    }]);
    const page = await context.newPage();
    page.on("request", (request) => {
      const url = new URL(request.url());
      if (request.method() === "POST" && url.pathname.startsWith("/api/v1/projects")) {
        posts.push({ path: url.pathname, key: request.headers()["idempotency-key"] });
      }
    });

    await page.route("**/api/v1/projects", dropCreateResponse);
    await page.goto(`${appOrigin}/student`);
    await expect(page.getByText("目前沒有專案。")).toBeVisible();
    await page.getByLabel("專案名稱").fill("sessionStorage v2 升級驗收");
    await page.getByRole("button", { name: "建立專案", exact: true }).click();
    await expect(page.getByText(/建立結果仍待確認/)).toBeVisible();
    expect(projectId).not.toBeNull();

    const stored = await page.evaluate((prefix) => {
      const key = Object.keys(sessionStorage).find((name) => name.startsWith(prefix));
      return key ? { key, value: sessionStorage.getItem(key) } : null;
    }, storagePrefix);
    expect(stored?.value).not.toBeNull();
    if (!stored?.value) throw new Error("首次操作沒有寫入分頁 sessionStorage。");
    const current: unknown = JSON.parse(stored.value);
    if (typeof current !== "object" || current === null || !("key" in current) ||
        typeof current.key !== "string" || !("payload" in current) ||
        typeof current.payload !== "object" || current.payload === null ||
        !("title" in current.payload) || typeof current.payload.title !== "string") {
      throw new Error("sessionStorage 中的首次操作格式不正確。");
    }
    const originalKey = current.key;
    recoveredKey = originalKey;
    const oldV2 = JSON.stringify({
      v: 2,
      key: current.key,
      payload: { title: current.payload.title },
      started_server_ms: Date.UTC(2026, 9, 1),
    });
    await page.evaluate(({ storageKey, raw }) => {
      sessionStorage.setItem(storageKey, raw);
      localStorage.removeItem(storageKey);
    }, { storageKey: stored.key, raw: oldV2 });
    expect(await page.evaluate(() => Object.keys(localStorage))).toEqual([]);
    expect(await control.query(
      "SELECT count(*)::int AS count FROM app.projects WHERE id=$1 AND owner_id=$2",
      [projectId, account.id],
    )).toMatchObject({ rows: [{ count: 1 }] });

    await page.unroute("**/api/v1/projects", dropCreateResponse);
    await page.reload();
    await expect(page.getByRole("button", { name: "只查詢原操作", exact: true })).toBeVisible();
    expect(await page.evaluate((prefix) =>
      Object.keys(localStorage).filter((name) => name.startsWith(prefix)), storagePrefix)).toEqual([]);
    expect(await page.evaluate((storageKey) => sessionStorage.getItem(storageKey), stored.key)).toBe(oldV2);

    await page.getByRole("button", { name: "只查詢原操作", exact: true }).click();
    await expect(page.getByText("伺服器已確認原操作建立專案；分類仍未確認。")).toBeVisible();
    expect(posts).toEqual([
      { path: "/api/v1/projects", key: originalKey },
      { path: "/api/v1/projects/recovery", key: originalKey },
    ]);
    await expect(page.getByTestId("owned-project-list").getByRole("link", {
      name: "sessionStorage v2 升級驗收",
    })).toHaveCount(1);
    expect(await control.query(
      "SELECT count(*)::int AS count FROM app.projects WHERE owner_id=$1 AND title=$2",
      [account.id, "sessionStorage v2 升級驗收"],
    )).toMatchObject({ rows: [{ count: 1 }] });
    expect(await page.evaluate((storageKey) => sessionStorage.getItem(storageKey), stored.key)).toBeNull();
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
