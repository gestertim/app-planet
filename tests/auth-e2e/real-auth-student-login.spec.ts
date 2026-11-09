import { expect as baseExpect, test, type BrowserContext, type Page } from "@playwright/test";
import { sessionCookieName } from "../../apps/web/src/server/auth-principal.ts";
import { createSyntheticStudent, removeSyntheticStudent, type SyntheticStudent } from "../support/student-login-fixture.ts";
import { openControlPool } from "../support/real-auth-fixture.ts";

const expect = baseExpect.configure({ timeout: 15_000 });
const rawIdea = "我想製作同學借書小幫手 📚\n保留換行\n尾端空格  ";
test.use({ trace: "off", screenshot: "off", video: "off" });

async function chunkedJson(chunks: readonly Buffer[]) {
  const origin = process.env.APP_PLANET_APP_ORIGIN;
  if (!origin || new URL(origin).hostname !== "localhost") throw new Error("缺少本批 HTTPS loopback origin。");
  return new Promise<{ status: number; body: unknown; hasCookie: boolean }>((resolve, reject) => {
    const request = https.request(`${origin}/api/v1/auth/student/login`, {
      method: "POST", rejectUnauthorized: false,
      headers: { origin, "content-type": "application/json", "transfer-encoding": "chunked" },
    }, (response) => {
      const body: Buffer[] = [];
      let size = 0;
      response.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > 64 * 1024) { response.destroy(); reject(new Error("隔離 HTTP 測試回應過大。")); }
        else body.push(chunk);
      });
      response.on("error", () => reject(new Error("隔離 HTTP 測試讀取失敗。")));
      response.on("end", () => {
        try {
          resolve({ status: response.statusCode ?? 0, body: JSON.parse(Buffer.concat(body).toString("utf8")),
            hasCookie: response.headers["set-cookie"] !== undefined });
        } catch { reject(new Error("隔離 HTTP 測試回應格式不正確。")); }
      });
    });
    request.setTimeout(10_000, () => { request.destroy(); reject(new Error("隔離 HTTP 測試逾時。")); });
    request.on("error", () => reject(new Error("隔離 HTTP 測試連線失敗。")));
    for (const chunk of chunks) request.write(chunk);
    request.end();
  });
}

async function login(page: Page, account: SyntheticStudent, variant = false) {
  await page.goto("/login/student");
  await expect(page.locator("form[data-ready]")).toHaveAttribute("data-ready", "true");
  await page.getByLabel("學生帳號", { exact: true }).fill(variant ? `\u2003${account.handle.toUpperCase()}\u2003` : account.handle);
  const code = variant ? account.password.toLowerCase().split("").join("-") : account.password;
  await page.getByLabel("登入碼", { exact: true }).fill(code);
  const response = page.waitForResponse((response) =>
    new URL(response.url()).pathname === "/api/v1/auth/student/login" && response.request().method() === "POST");
  await page.getByRole("button", { name: "學生登入", exact: true }).click();
  return response;
}
async function cookieProtected(context: BrowserContext) {
  const cookies = await context.cookies();
  const cookie = cookies.find((cookie) => cookie.name === sessionCookieName);
  expect(cookies.length === 1 && cookie !== undefined).toBe(true);
  expect(cookie?.httpOnly && cookie.secure && cookie.sameSite === "Strict" && cookie.path === "/").toBe(true);
  expect(cookie !== undefined && cookie.expires > Date.now() / 1000 && cookie.expires - Date.now() / 1000 <= 601).toBe(true);
  return cookie!;
}
async function firstSave(page: Page, control: ReturnType<typeof openControlPool>, account: SyntheticStudent) {
  await expect(page).toHaveURL(/\/student$/);
  await page.getByRole("button", { name: /^我想開始做 App/ }).click();
  await page.getByLabel("我的點子草稿").fill(rawIdea);
  await page.getByRole("button", { name: "將點子帶入新專案", exact: true }).click();
  await page.getByLabel("專案名稱").fill("隔離 A-1 借書小幫手");
  const creation = page.waitForResponse((response) =>
    new URL(response.url()).pathname === "/api/v1/projects" && response.request().method() === "POST");
  await page.getByRole("button", { name: "建立專案", exact: true }).click();
  const response = await creation;
  expect(response.status()).toBe(201);
  const body: unknown = await response.json();
  if (typeof body !== "object" || body === null || !("id" in body) || typeof body.id !== "string") {
    throw new Error("建立作品結果無法確認。");
  }
  const id = body.id;
  await expect(page).toHaveURL(new RegExp(`/student/projects/${id}/stages/`));
  await expect(page.getByLabel("階段草稿文字")).toHaveValue(rawIdea);
  const before = await control.query(`SELECT count(*)::int AS n FROM app.stage_records WHERE project_id=$1 AND stage='點子'`, [id]);
  expect(before.rows[0].n).toBe(0);
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await expect(page.getByTestId("confirmed-server-draft")).toContainText("伺服器版本 0");
  const saved = await control.query(`SELECT s.row_version AS version,s.content->>'text' AS text,p.owner_id
    FROM app.stage_records s JOIN app.projects p ON p.id=s.project_id WHERE s.project_id=$1 AND s.stage='點子'`, [id]);
  expect(saved.rows.length).toBe(1);
  expect(saved.rows[0].version).toBe(0);
  expect(saved.rows[0].text === rawIdea && saved.rows[0].owner_id === account.id).toBe(true);
  await page.reload();
  await expect(page.getByLabel("階段草稿文字")).toHaveValue(rawIdea);
  await expect(page.getByTestId("confirmed-server-draft")).toContainText("伺服器版本 0");
  const reloaded = await control.query(`SELECT count(*)::int AS n,bool_and(row_version=0 AND content->>'text'=$2) AS same
    FROM app.stage_records WHERE project_id=$1 AND stage='點子'`, [id, rawIdea]);
  expect(reloaded.rows[0].n === 1 && reloaded.rows[0].same === true).toBe(true);
  console.info(JSON.stringify({ check: "empty-cookie-A1-first-manual-save-reload", projectId: id,
    countBefore: 0, countAfter: 1, version: 0, exactText: true, exactReload: true, sameOwner: true }));
  return id;
}

test("全新空cookie → 真學生表單A-1 → 同作品首次手動保存stage_records 0→1 version0 → reload逐字一致", async ({ browser }) => {
  const control = openControlPool();
  const account = await createSyntheticStudent(control);
  const context = await browser.newContext({ locale: "zh-TW", ignoreHTTPSErrors: true });
  try {
    expect((await context.cookies()).length).toBe(0);
    const page = await context.newPage();
    const response = await login(page, account, true);
    expect(response.status()).toBe(200);
    await cookieProtected(context);
    await firstSave(page, control, account);
    const leaked = await page.evaluate(({ password, email }) => {
      const persisted = location.href + JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage });
      return persisted.includes(password) || persisted.includes(email);
    }, { password: account.password, email: account.email });
    expect(leaked).toBe(false);
  } finally { await context.close(); await removeSyntheticStudent(control, account); await control.end(); }
});

test("同碼 active 真登入 → 產品登出空cookie → 控制層revoked提交讀回 → 同碼401，不聲稱A9", async ({ browser }) => {
  const control = openControlPool();
  const account = await createSyntheticStudent(control);
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  try {
    expect((await context.cookies()).length).toBe(0);
    const page = await context.newPage();
    expect((await login(page, account)).status()).toBe(200);
    await expect(page).toHaveURL(/\/student$/);
    const loggedOut = page.waitForResponse((response) =>
      new URL(response.url()).pathname === "/api/v1/auth/logout" && response.request().method() === "POST");
    await page.getByRole("button", { name: "登出", exact: true }).click();
    expect((await loggedOut).status()).toBe(204);
    expect((await context.cookies()).length).toBe(0);
    await control.query("UPDATE app.student_login_credentials SET state='revoked' WHERE student_id=$1", [account.id]);
    const read = await control.query("SELECT state='revoked' AS revoked FROM app.student_login_credentials WHERE student_id=$1", [account.id]);
    expect(read.rows.length === 1 && read.rows[0].revoked === true).toBe(true);
    const response = await login(page, account);
    expect(response.status()).toBe(401);
    expect(await response.json()).toMatchObject({ status: 401, code: "invalid_credentials" });
    expect((await context.cookies()).length).toBe(0);
    await expect(page).toHaveURL(/\/login\/student$/);
    await expect(page.locator("form").getByRole("alert")).toContainText("請確認帳號與登入碼後再試一次");
    console.info(JSON.stringify({ check: "same-code-revoked-consumer", activeSuccess: true, productLogoutEmpty: true, revokedReadBack: true, sameCode401: true, a9Executed: false }));
  } finally { await context.close(); await removeSyntheticStudent(control, account); await control.end(); }
});

for (const state of ["withdrawn", "expired"] as const) {
  test(`${state} 真表單可登入及保存；AI與公開部署關閉`, async ({ browser }) => {
    const control = openControlPool();
    const account = await createSyntheticStudent(control);
    const context = await browser.newContext({ ignoreHTTPSErrors: true });
    try {
      await control.query("UPDATE app.schools SET approval_state=$2 WHERE id=$1", [account.schoolId, state]);
      expect((await context.cookies()).length).toBe(0);
      const page = await context.newPage();
      expect((await login(page, account)).status()).toBe(200);
      await expect(page).toHaveURL(/\/student$/);
      const me = await page.request.get("/api/v1/me");
      expect(me.status()).toBe(200);
      const body = await me.json() as { school_gate?: { ai_available?: boolean; public_deploy_available?: boolean; state?: string } };
      expect(body.school_gate?.state === state && body.school_gate.ai_available === false && body.school_gate.public_deploy_available === false).toBe(true);
      await firstSave(page, control, account);
      console.info(JSON.stringify({ check: "school-withdrawn-expired-saved-content", state, saveReload: true, aiAvailable: false, publicDeployAvailable: false }));
    } finally { await context.close(); await removeSyntheticStudent(control, account); await control.end(); }
  });
}

test("真 HTTPS strict body、F-01及跨來源拒絕；proxy覆寫caller proof", async ({ browser }) => {
  const control = openControlPool();
  const account = await createSyntheticStudent(control);
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  try {
    const page = await context.newPage();
    await page.goto("/login/student");
    const valid = { handle: account.handle, login_code: account.password };
    const cases: { data: unknown; status: number; code: string; contentType?: string }[] = [
      { data: { ...valid, handle: " ".repeat(129) }, status: 400, code: "invalid_request" },
      { data: { ...valid, login_code: " ".repeat(129) }, status: 400, code: "invalid_request" },
      { data: " ".repeat(4097), status: 413, code: "payload_too_large" },
      { data: { ...valid, extra: true }, status: 422, code: "unknown_field" },
      { data: "{", status: 400, code: "invalid_request" },
      { data: '{"handle":"sim-a","handle":"sim-b","login_code":"0000000000"}', status: 400, code: "invalid_request" },
      { data: JSON.stringify(valid), contentType: "text/plain", status: 415, code: "unsupported_media_type" },
    ];
    for (const item of cases) {
      const response = await page.request.post("/api/v1/auth/student/login", {
        headers: { origin: process.env.APP_PLANET_APP_ORIGIN!, "content-type": item.contentType ?? "application/json" },
        data: typeof item.data === "string" ? item.data : JSON.stringify(item.data),
      });
      expect(response.status()).toBe(item.status);
      expect(await response.json()).toMatchObject({ status: item.status, code: item.code });
      expect(response.headers()["set-cookie"] === undefined).toBe(true);
    }
    // proxy 必須剝除 caller proof/source，而非相信它；後續實際來源仍由 proxy 注入。
    const response = await page.request.post("/api/v1/auth/student/login", {
      headers: { origin: "https://forged.invalid", "x-app-planet-source-proof": "00".repeat(32) },
      data: valid,
    });
    expect(response.status()).toBe(403);
    expect(await response.json()).toMatchObject({ status: 403, code: "forbidden" });
    expect((await context.cookies()).length).toBe(0);
    const oversized = await chunkedJson([Buffer.alloc(2048, 32), Buffer.alloc(2049, 32)]);
    expect(oversized.status).toBe(413);
    expect(oversized.body).toMatchObject({ status: 413, code: "payload_too_large" });
    expect(oversized.hasCookie).toBe(false);
    const utf8 = await chunkedJson([Buffer.from([0xff])]);
    expect(utf8.status).toBe(400);
    expect(utf8.body).toMatchObject({ status: 400, code: "invalid_request" });
    expect(utf8.hasCookie).toBe(false);
    const json = JSON.stringify(valid);
    const boundary = await chunkedJson([Buffer.from(json), Buffer.alloc(4096 - Buffer.byteLength(json), 32)]);
    expect(boundary.status).toBe(200);
    expect(boundary.body).toEqual({ account_status: "approved", landing: "home" });
    expect(boundary.hasCookie).toBe(true);
    console.info(JSON.stringify({ check: "real-https-chunked-json", noContentLength: true,
      bytes4096: 200, bytes4097: 413, invalidUtf8: 400 }));
  } finally { await context.close(); await removeSyntheticStudent(control, account); await control.end(); }
});

test("無 JavaScript 不提交，不把合成碼寫入URL", async ({ browser }) => {
  const context = await browser.newContext({ javaScriptEnabled: false, ignoreHTTPSErrors: true });
  try {
    const page = await context.newPage();
    let posts = 0;
    page.on("request", (request) => { if (request.method() === "POST") posts++; });
    await page.goto("/login/student");
    await expect(page.getByLabel("登入碼", { exact: true })).toBeDisabled();
    await expect(page.getByRole("button", { name: "學生登入", exact: true })).toBeDisabled();
    await expect(page.locator("noscript")).toBeVisible();
    expect(await page.locator("noscript").textContent()).toBe("學生登入需要 JavaScript；請啟用後重新載入。");
    expect(posts).toBe(0);
    expect((await context.cookies()).length).toBe(0);
  } finally { await context.close(); }
});

for (const submitMethod of ["mouse", "Enter"] as const) {
  test(`hydration前停用${submitMethod}，釋放script後才以真表單登入`, async ({ browser }) => {
    const control = openControlPool();
    const account = await createSyntheticStudent(control);
    const context = await browser.newContext({ ignoreHTTPSErrors: true });
    let release!: () => void;
    const released = new Promise<void>((resolve) => { release = resolve; });
    try {
      await context.route("**/_next/**", async (route) => {
        if (route.request().resourceType() === "script") await released;
        await route.continue();
      });
      const page = await context.newPage();
      let posts = 0, documents = 0;
      page.on("request", (request) => {
        if (request.method() === "POST") posts++;
        if (request.isNavigationRequest() && request.frame() === page.mainFrame()) documents++;
      });
      await page.goto("/login/student", { waitUntil: "commit" });
      const form = page.locator("form[data-ready]");
      await expect(form).toHaveAttribute("data-ready", "false");
      const button = page.getByRole("button", { name: "學生登入", exact: true });
      await expect(button).toBeDisabled();
      await expect(page.getByLabel("學生帳號", { exact: true })).toBeDisabled();
      await expect(page.getByLabel("登入碼", { exact: true })).toBeDisabled();
      const before = documents;
      const box = await button.boundingBox();
      if (!box) throw new Error("學生登入按鈕不可見。");
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      await page.keyboard.press("Enter");
      await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      expect(posts === 0 && documents === before && (await context.cookies()).length === 0).toBe(true);
      release();
      await expect(form).toHaveAttribute("data-ready", "true");
      await page.getByLabel("學生帳號", { exact: true }).fill(account.handle);
      await page.getByLabel("登入碼", { exact: true }).fill(account.password);
      const response = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/v1/auth/student/login");
      if (submitMethod === "mouse") await button.click();
      else await button.press("Enter");
      expect((await response).status()).toBe(200);
      await expect(page).toHaveURL(/\/student$/);
      expect(posts).toBe(1);
      console.info(JSON.stringify({ check: "student-pre-hydration", submitMethod, beforePosts: 0, hydratedPosts: 1 }));
    } finally { release(); await context.close(); await removeSyntheticStudent(control, account); await control.end(); }
  });
}

test("600 秒真 Auth／cookie 到期後拒絕（含記憶體保留的過期access token），不refresh", async ({ browser }) => {
  test.setTimeout(700_000);
  const control = openControlPool();
  const account = await createSyntheticStudent(control);
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  try {
    expect((await context.cookies()).length).toBe(0);
    const page = await context.newPage();
    let refreshes = 0;
    page.on("request", (request) => { if (request.url().includes("grant_type=refresh_token")) refreshes++; });
    expect((await login(page, account)).status()).toBe(200);
    await expect(page).toHaveURL(/\/student$/);
    const cookie = await cookieProtected(context);
    const expiry = cookie.expires;
    const wait = Math.max(0, Math.ceil(expiry * 1000 - Date.now()) + 2500);
    expect(wait > 580_000 && wait <= 603_000).toBe(true);
    console.info(JSON.stringify({ check: "student-ttl-wait-start", maxAgeSeconds: 600, actualWaitMs: wait }));
    await new Promise((resolve) => setTimeout(resolve, wait));
    expect((await context.cookies()).length).toBe(0);
    const missing = await page.request.get("/api/v1/me");
    expect(missing.status()).toBe(401);
    expect(await missing.json()).toMatchObject({ status: 401, code: "unauthenticated" });
    const expired = await page.request.get("/api/v1/me", { headers: { cookie: `${sessionCookieName}=${cookie.value}` } });
    expect(expired.status()).toBe(401);
    expect(await expired.json()).toMatchObject({ status: 401, code: "unauthenticated" });
    expect(refreshes).toBe(0);
    console.info(JSON.stringify({ check: "student-ttl-expired", actualAuthTTL: 600, cookieExpired: true, expiredToken401: true, refreshed: false }));
  } finally { await context.close(); await removeSyntheticStudent(control, account); await control.end(); }
});
import https from "node:https";
