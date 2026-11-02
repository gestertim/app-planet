import { expect, test, type Route } from "@playwright/test";
import {
  createSyntheticAuthAccount,
  deleteSyntheticAuthAccount,
  loginSyntheticAccount,
  openControlPool,
} from "../support/real-auth-fixture.ts";
import { sessionCookieName } from "../../apps/web/src/server/auth-principal.ts";

const storagePrefix = "app-planet.project-create.";
const confirmedMessage = "伺服器已確認原操作建立專案；分類仍未確認。";
const clearFailedFragment = "本機紀錄無法清除";

async function prepareStudent(label: string) {
  const control = openControlPool();
  const account = await createSyntheticAuthAccount(control, label);
  const session = await loginSyntheticAccount(account);
  const appOrigin = process.env.APP_PLANET_APP_ORIGIN;
  if (!appOrigin) throw new Error("隔離瀏覽器測試缺少本機 app origin。");
  return { control, account, session, appOrigin };
}
async function setup(browser: import("@playwright/test").Browser, label: string) {
  const prepared = await prepareStudent(label);
  const context = await browser.newContext({ locale: "zh-TW" });
  await context.addCookies([{
    name: sessionCookieName, value: prepared.session.accessToken, url: prepared.appOrigin,
    httpOnly: true, secure: true, sameSite: "Strict",
  }]);
  const page = await context.newPage();
  const storedKeys = () => page.evaluate((prefix) => ({
    session: Object.keys(sessionStorage).filter((name) => name.startsWith(prefix)),
    local: Object.keys(localStorage).filter((name) => name.startsWith(prefix)),
  }), storagePrefix);
  const cleanup = async () => {
    await context.close();
    await prepared.control.query(
      "DELETE FROM app.project_create_idempotency WHERE project_id IN (SELECT id FROM app.projects WHERE owner_id=$1)",
      [prepared.account.id],
    );
    await prepared.control.query("DELETE FROM app.projects WHERE owner_id=$1", [prepared.account.id]);
    await prepared.control.query("DELETE FROM app.profiles WHERE id=$1", [prepared.account.id]);
    await prepared.control.query("DELETE FROM app.schools WHERE id=$1", [prepared.account.schoolId]);
    await deleteSyntheticAuthAccount(prepared.account);
    await prepared.control.end();
  };
  const count = async (title: string) => Number((await prepared.control.query(
    "SELECT count(*)::int AS count FROM app.projects WHERE owner_id=$1 AND title=$2",
    [prepared.account.id, title],
  )).rows[0].count);
  return { page, appOrigin: prepared.appOrigin, storedKeys, cleanup, count };
}

test("A 正常首次成功：紀錄確實清除且沒有清理失敗提示", async ({ browser }) => {
  const env = await setup(browser, "CleanupNormal");
  try {
    const title = "A 正常首次成功";
    await env.page.goto(`${env.appOrigin}/student`);
    await expect(env.page.getByText("目前沒有專案。")).toBeVisible();
    await env.page.getByLabel("專案名稱").fill(title);
    await env.page.getByRole("button", { name: "建立專案", exact: true }).click();
    await expect(env.page.getByText(confirmedMessage)).toBeVisible();
    await expect(env.page.getByText(clearFailedFragment)).toHaveCount(0);
    expect(await env.storedKeys()).toEqual({ session: [], local: [] });
    expect(await env.count(title)).toBe(1);
    await env.page.reload();
    await expect(env.page.getByRole("button", { name: "建立專案", exact: true })).toBeEnabled();
    expect(await env.storedKeys()).toEqual({ session: [], local: [] });
  } finally {
    await env.cleanup();
  }
});

test("A 首次被明確拒絕（未執行）：僅在可確認未執行時結束意圖", async ({ browser }) => {
  const env = await setup(browser, "CleanupRejected");
  try {
    let hits = 0;
    await env.page.route("**/api/v1/projects", async (route: Route) => {
      hits++;
      await route.fulfill({
        status: 400,
        contentType: "application/problem+json",
        body: JSON.stringify({
          type: "about:blank", title: "invalid_request", status: 400, code: "invalid_request",
          detail: "合成拒絕", instance: "/api/v1/projects",
          request_id: "synthetic-request", user_message_zh: "請求內容不正確。",
        }),
      });
    });
    await env.page.goto(`${env.appOrigin}/student`);
    await env.page.getByLabel("專案名稱").fill("A 首次明確拒絕");
    await env.page.getByRole("button", { name: "建立專案", exact: true }).click();
    await expect(env.page.getByText("伺服器明確拒絕首次請求，確認尚未建立；請檢查內容後再送出。")).toBeVisible();
    expect(hits).toBe(1);
    expect(await env.storedKeys()).toEqual({ session: [], local: [] });
    expect(await env.count("A 首次明確拒絕")).toBe(0);
    await expect(env.page.getByRole("button", { name: "建立專案", exact: true })).toBeEnabled();
  } finally {
    await env.cleanup();
  }
});

test("A response-loss 後只走 recovery 成功並清除紀錄", async ({ browser }) => {
  const env = await setup(browser, "CleanupRecovery");
  try {
    const title = "A response-loss recovery";
    const posts: string[] = [];
    env.page.on("request", (request) => {
      const url = new URL(request.url());
      if (request.method() === "POST" && url.pathname.startsWith("/api/v1/projects")) posts.push(url.pathname);
    });
    const drop = async (route: Route) => {
      await route.fetch();
      await route.abort("connectionreset");
    };
    await env.page.route("**/api/v1/projects", drop);
    await env.page.goto(`${env.appOrigin}/student`);
    await env.page.getByLabel("專案名稱").fill(title);
    await env.page.getByRole("button", { name: "建立專案", exact: true }).click();
    await expect(env.page.getByText(/建立結果仍待確認/)).toBeVisible();
    expect((await env.storedKeys()).session).toHaveLength(1);
    await env.page.unroute("**/api/v1/projects", drop);
    await env.page.reload();
    await env.page.getByRole("button", { name: "只查詢原操作", exact: true }).click();
    await expect(env.page.getByText(confirmedMessage)).toBeVisible();
    await expect(env.page.getByText(clearFailedFragment)).toHaveCount(0);
    expect(await env.storedKeys()).toEqual({ session: [], local: [] });
    expect(await env.count(title)).toBe(1);
    expect(posts).toEqual(["/api/v1/projects", "/api/v1/projects/recovery"]);
  } finally {
    await env.cleanup();
  }
});

test("A 清理前儲存內容被替換：保留新紀錄、停止新建且 UI 與行為一致", async ({ browser }) => {
  const env = await setup(browser, "CleanupReplaced");
  try {
    const title = "A 清理前被替換";
    const foreign = JSON.stringify({
      v: 3, key: "22222222-2222-4222-8222-222222222222", payload: { title: "其他分頁的意圖" },
    });
    await env.page.route("**/api/v1/projects", async (route: Route) => {
      const response = await route.fetch();
      await env.page.evaluate((raw) => {
        const key = Object.keys(sessionStorage).find((name) => name.startsWith("app-planet.project-create."));
        if (key) sessionStorage.setItem(key, raw);
      }, foreign);
      await route.fulfill({ response });
    });
    await env.page.goto(`${env.appOrigin}/student`);
    await env.page.getByLabel("專案名稱").fill(title);
    await env.page.getByRole("button", { name: "建立專案", exact: true }).click();
    await expect(env.page.getByText(new RegExp(clearFailedFragment))).toBeVisible();
    expect(await env.page.evaluate((prefix) => {
      const key = Object.keys(sessionStorage).find((name) => name.startsWith(prefix));
      return key ? sessionStorage.getItem(key) : null;
    }, storagePrefix)).toBe(foreign);
    await expect(env.page.getByRole("button", { name: "操作已停止", exact: true })).toBeDisabled();
    expect(await env.count(title)).toBe(1);
  } finally {
    await env.cleanup();
  }
});

test("A 清理讀寫失敗：保留紀錄並停止新建", async ({ browser }) => {
  const env = await setup(browser, "CleanupStorageFail");
  try {
    const title = "A 清理讀寫失敗";
    await env.page.addInitScript(() => {
      const original = Storage.prototype.removeItem;
      Storage.prototype.removeItem = function patched(this: Storage, name: string) {
        if ((window as unknown as { __failRemove?: boolean }).__failRemove &&
            name.startsWith("app-planet.project-create.")) {
          throw new Error("synthetic remove failure");
        }
        return original.call(this, name);
      };
    });
    await env.page.goto(`${env.appOrigin}/student`);
    await env.page.evaluate(() => { (window as unknown as { __failRemove?: boolean }).__failRemove = true; });
    await env.page.getByLabel("專案名稱").fill(title);
    await env.page.getByRole("button", { name: "建立專案", exact: true }).click();
    await expect(env.page.getByText(new RegExp(clearFailedFragment))).toBeVisible();
    expect((await env.storedKeys()).session).toHaveLength(1);
    await expect(env.page.getByRole("button", { name: "操作已停止", exact: true })).toBeDisabled();
    expect(await env.count(title)).toBe(1);
    await env.page.evaluate(() => { (window as unknown as { __failRemove?: boolean }).__failRemove = false; });
    await env.page.reload();
    await env.page.getByRole("button", { name: "只查詢原操作", exact: true }).click();
    await expect(env.page.getByText(confirmedMessage)).toBeVisible();
    expect(await env.storedKeys()).toEqual({ session: [], local: [] });
    expect(await env.count(title)).toBe(1);
  } finally {
    await env.cleanup();
  }
});

test("A 同帳號失權後未知操作仍保留，只走 recovery", async ({ browser }) => {
  const env = await setup(browser, "CleanupAccessLost");
  try {
    const title = "A 失權保留";
    const drop = async (route: Route) => {
      await route.fetch();
      await route.abort("connectionreset");
    };
    await env.page.route("**/api/v1/projects", drop);
    await env.page.goto(`${env.appOrigin}/student`);
    await env.page.getByLabel("專案名稱").fill(title);
    await env.page.getByRole("button", { name: "建立專案", exact: true }).click();
    await expect(env.page.getByText(/建立結果仍待確認/)).toBeVisible();
    await env.page.unroute("**/api/v1/projects", drop);
    const posts: string[] = [];
    env.page.on("request", (request) => {
      const url = new URL(request.url());
      if (request.method() === "POST" && url.pathname.startsWith("/api/v1/projects")) posts.push(url.pathname);
    });
    await env.page.route("**/api/v1/projects/recovery", (route) => route.fulfill({
      status: 403, contentType: "application/problem+json",
      body: JSON.stringify({
        type: "about:blank", title: "forbidden", status: 403, code: "forbidden",
        detail: "合成失權", instance: "/api/v1/projects/recovery",
      }),
    }));
    await env.page.getByRole("button", { name: "只查詢原操作", exact: true }).click();
    await expect.poll(async () => (await env.storedKeys()).session.length).toBe(1);
    expect(posts).toEqual(["/api/v1/projects/recovery"]);
    expect(await env.count(title)).toBe(1);
  } finally {
    await env.cleanup();
  }
});
