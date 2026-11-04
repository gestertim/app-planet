import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import type { Pool } from "pg";
import {
  createSyntheticStaffAccount,
  deleteSyntheticStaffAccount,
  openControlPool,
  type SyntheticStaffAccount,
} from "../support/real-auth-fixture.ts";
import { sessionCookieName } from "../../apps/web/src/server/auth-principal.ts";

// 真實 Next HTTPS＋可信來源 proxy＋隔離 Auth／PostgreSQL：setup 只建立合成帳號與 DB 前置資料，
// 登入一律經產品表單；不使用 addCookies、storageState 或測試 endpoint 注入 session。
// 本檔只覆蓋既有教職員入口（readiness §90），不是學生登入碼 E2E，也不是完整 S-02 驗收。
test.describe.configure({ mode: "serial" });

let control!: Pool;
let teacher!: SyntheticStaffAccount;
let admin!: SyntheticStaffAccount;
let pending!: SyntheticStaffAccount;
let rejected!: SyntheticStaffAccount;
let disabled!: SyntheticStaffAccount;
let expiring!: SyntheticStaffAccount;
let throttled!: SyntheticStaffAccount;

test.beforeAll(async () => {
  control = openControlPool();
  teacher = await createSyntheticStaffAccount(control, "BrowserTeacher", { role: "teacher" });
  admin = await createSyntheticStaffAccount(control, "BrowserAdmin", { role: "admin" });
  pending = await createSyntheticStaffAccount(control, "BrowserPending", { role: "teacher", status: "pending" });
  rejected = await createSyntheticStaffAccount(control, "BrowserRejected", { role: "admin", status: "rejected" });
  disabled = await createSyntheticStaffAccount(control, "BrowserDisabled", { role: "teacher", status: "disabled" });
  expiring = await createSyntheticStaffAccount(control, "BrowserExpiry", { role: "teacher" });
  throttled = await createSyntheticStaffAccount(control, "BrowserThrottle", { role: "teacher" });
});

test.afterAll(async () => {
  for (const account of [teacher, admin, pending, rejected, disabled, expiring, throttled]) {
    if (account) await deleteSyntheticStaffAccount(control, account);
  }
  await control?.end();
});

// Next 自帶的 route announcer 也是 role=alert；只取產品提示。
function productAlert(page: Page) {
  return page.locator('[role="alert"]:not(#__next-route-announcer__)');
}

async function newContext(browser: import("@playwright/test").Browser): Promise<BrowserContext> {
  return browser.newContext({ locale: "zh-TW", ignoreHTTPSErrors: true });
}

async function submitLogin(page: Page, email: string, password: string): Promise<number> {
  await page.goto("/login");
  await expect(page.getByRole("heading", { name: "教職員登入" })).toBeVisible();
  // 等 client 表單 hydration，確保走產品 fetch 路徑而非無 JS 後援。
  await expect(page.locator("form[data-ready=\"true\"]")).toHaveCount(1);
  await page.getByLabel("電子郵件").fill(email);
  await page.getByLabel("密碼").fill(password);
  const reply = page.waitForResponse((response) =>
    new URL(response.url()).pathname === "/api/v1/auth/staff/login" && response.request().method() === "POST");
  await page.getByRole("button", { name: "登入", exact: true }).press("Enter");
  const response = await reply;
  // 成功後立即導向，body 已不可讀；成功 body 形狀由 integration 驗證。錯誤 body 不得含 token。
  if (response.status() !== 200) {
    const text = await response.text();
    expect(text).not.toMatch(/access_token|refresh_token|eyJ[A-Za-z0-9_-]{10,}/);
  }
  return response.status();
}

async function expectNoSecretPersisted(page: Page, password: string) {
  expect(page.url()).not.toContain(encodeURIComponent(password));
  const stored = await page.evaluate(() => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }));
  expect(stored.includes(password)).toBe(false);
  expect(await page.content()).not.toContain(password);
}

async function expectSessionCookieProtected(context: BrowserContext) {
  const cookies = (await context.cookies()).filter((cookie) => cookie.name === sessionCookieName);
  expect(cookies).toHaveLength(1);
  const [cookie] = cookies;
  expect(cookie?.httpOnly).toBe(true);
  expect(cookie?.secure).toBe(true);
  expect(cookie?.sameSite).toBe("Strict");
  expect(cookie?.path).toBe("/");
  expect(cookie?.domain).toBe("localhost");
  return cookie?.expires ?? -1;
}

async function logout(page: Page) {
  const done = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/v1/auth/logout");
  await page.getByRole("button", { name: "登出", exact: true }).click();
  expect((await done).status()).toBe(204);
  await expect(page).toHaveURL(/\/login$/);
}

for (const submitMethod of ["mouse", "Enter"] as const) {
  test(`hydration 前停用滑鼠與 Enter 送出，釋放 JavaScript 後同頁以 ${submitMethod} 正常登入`, async ({ browser }) => {
    const context = await newContext(browser);
    let releaseScripts!: () => void;
    const scriptsReleased = new Promise<void>((resolve) => { releaseScripts = resolve; });
    let scriptObserved!: () => void;
    const scriptIntercepted = new Promise<void>((resolve) => { scriptObserved = resolve; });
    let blockedScripts = 0;
    let released = false;
    try {
      await context.route("**/_next/**", async (route) => {
        if (route.request().resourceType() === "script") {
          blockedScripts += 1;
          scriptObserved();
          await scriptsReleased;
        }
        await route.continue();
      });
      const page = await context.newPage();
      let loginPosts = 0;
      let documentRequests = 0;
      page.on("request", (request) => {
        if (new URL(request.url()).pathname === "/api/v1/auth/staff/login" && request.method() === "POST") loginPosts += 1;
        if (request.isNavigationRequest() && request.frame() === page.mainFrame()) documentRequests += 1;
      });
      await page.goto("/login", { waitUntil: "commit" });
      const form = page.locator("form[data-ready]");
      await expect(form).toBeVisible();
      await scriptIntercepted;
      expect(blockedScripts).toBeGreaterThan(0);
      expect(released).toBe(false);
      await expect(form).toHaveAttribute("data-ready", "false");
      const email = page.getByLabel("電子郵件");
      const password = page.getByLabel("密碼");
      const button = page.getByRole("button", { name: "登入", exact: true });
      await expect(email).toBeDisabled();
      await expect(password).toBeDisabled();
      await expect(button).toBeDisabled();
      const initialDocumentRequests = documentRequests;
      for (const control of [email, password, button]) {
        const box = await control.boundingBox();
        if (!box) throw new Error("登入控制項不可見");
        await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
        await page.keyboard.type("blocked");
        await page.keyboard.press("Enter");
      }
      await expect(email).toHaveValue("");
      await expect(password).toHaveValue("");
      // 僅輔助探測 implicit-submit 演算法：暫時開放並聚焦 email，submit button 仍保持 SSR 停用；
      // 這不是實際使用者可操作的狀態，不能替代上面的真滑鼠／鍵盤證據。
      await email.evaluate((element: HTMLInputElement) => { element.disabled = false; element.focus(); });
      await page.keyboard.press("Enter");
      await email.evaluate((element: HTMLInputElement) => { element.disabled = true; element.blur(); });
      // 與 browser task／繪製同步，不以短 sleep 猜測是否送出。
      await page.evaluate(() => new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }));
      await expect(form).toHaveAttribute("data-ready", "false");
      expect(loginPosts).toBe(0);
      expect(documentRequests).toBe(initialDocumentRequests);
      await expect(page).toHaveURL(/\/login$/);
      expect((await context.cookies()).length).toBe(0);
      console.info(JSON.stringify({
        check: "pre-hydration", submitMethod, scriptsHeld: blockedScripts > 0 && !released,
        ready: await form.getAttribute("data-ready"), loginPosts,
        additionalDocumentRequests: documentRequests - initialDocumentRequests, cookieCount: 0,
      }));

      released = true;
      releaseScripts();
      await expect(form).toHaveAttribute("data-ready", "true");
      const readyAfterRelease = await form.getAttribute("data-ready");
      await expect(email).toBeEnabled();
      await expect(password).toBeEnabled();
      await expect(button).toBeEnabled();
      // 不重新 goto、不注入 cookie；同一份 SSR 文件 hydration 後以產品 fetch 登入。
      await email.fill(teacher.email);
      await password.fill(teacher.password);
      const reply = page.waitForResponse((response) =>
        new URL(response.url()).pathname === "/api/v1/auth/staff/login" && response.request().method() === "POST");
      if (submitMethod === "mouse") await button.click();
      else await password.press("Enter");
      const response = await reply;
      expect(response.status()).toBe(200);
      expect(response.request().headers()["content-type"]).toBe("application/json");
      await expect(page).toHaveURL(/\/teacher$/);
      expect(loginPosts).toBe(1);
      await expect(page.getByTestId("staff-session")).toHaveAttribute("data-role", "teacher");
      await expectNoSecretPersisted(page, teacher.password);
      await expectSessionCookieProtected(context);
      console.info(JSON.stringify({
        check: "post-hydration", submitMethod, ready: readyAfterRelease,
        loginPosts, httpStatus: response.status(), jsonRequest: true, teacherLanding: true, protectedCookie: true,
      }));
      await logout(page);
    } finally {
      releaseScripts();
      await context.close();
    }
  });
}

test("JavaScript 未啟動時保留停用控制項並提供提示，不送出原生表單", async ({ browser }) => {
  const context = await browser.newContext({ javaScriptEnabled: false, ignoreHTTPSErrors: true });
  try {
    const page = await context.newPage();
    let loginPosts = 0;
    page.on("request", (request) => {
      if (new URL(request.url()).pathname === "/api/v1/auth/staff/login" && request.method() === "POST") loginPosts += 1;
    });
    await page.goto("/login");
    await expect(page.locator("form[data-ready]")).toHaveAttribute("data-ready", "false");
    await expect(page.getByLabel("電子郵件")).toBeDisabled();
    await expect(page.getByLabel("密碼")).toBeDisabled();
    await expect(page.getByRole("button", { name: "登入", exact: true })).toBeDisabled();
    await expect(page.locator("noscript")).toBeVisible();
    expect(await page.locator("noscript").textContent()).toBe("教職員登入需要 JavaScript；請啟用後重新載入。");
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/login$/);
    expect(loginPosts).toBe(0);
    expect((await context.cookies()).length).toBe(0);
  } finally {
    await context.close();
  }
});

test("teacher：產品表單登入 → 教師頁 → reload → 登出 → 受保護資料拒絕 → 重新填表登入；跨角色 URL 拒絕", async ({ browser }) => {
  const context = await newContext(browser);
  try {
    const page = await context.newPage();
    expect(await submitLogin(page, teacher.email, teacher.password)).toBe(200);
    await expect(page).toHaveURL(/\/teacher$/);
    await expect(page.getByTestId("staff-session")).toHaveAttribute("data-role", "teacher");
    await expectNoSecretPersisted(page, teacher.password);
    const expires = await expectSessionCookieProtected(context);
    // Cookie 期限不超過可信 Auth expires_in 與隔離 TTL（runner：jwt_expiry=60、session 上限 900）。
    expect(expires - Date.now() / 1000).toBeLessThanOrEqual(61);
    await page.reload();
    await expect(page.getByTestId("staff-session")).toHaveAttribute("data-role", "teacher");
    expect((await page.request.get("/api/v1/me")).status()).toBe(200);

    await page.goto("/admin");
    await expect(productAlert(page)).toContainText("目前帳號沒有這個頁面的權限");
    await expect(page.getByTestId("staff-session")).toHaveCount(0);
    await page.goto("/teacher");

    await logout(page);
    expect((await context.cookies()).some((cookie) => cookie.name === sessionCookieName)).toBe(false);
    expect((await page.request.get("/api/v1/me")).status()).toBe(401);
    await page.goto("/teacher");
    await expect(productAlert(page)).toContainText("尚未登入，或登入已過期");
    await expect(page.getByTestId("staff-session")).toHaveCount(0);

    expect(await submitLogin(page, teacher.email, teacher.password)).toBe(200);
    await expect(page).toHaveURL(/\/teacher$/);
    await expect(page.getByTestId("staff-session")).toHaveAttribute("data-role", "teacher");
    await expect(page).not.toHaveURL(/\/student/);
    await logout(page);
  } finally {
    await context.close();
  }
});

test("admin：產品表單登入 → 管理頁 → reload → 跨角色拒絕 → 登出 → 重新登入", async ({ browser }) => {
  const context = await newContext(browser);
  try {
    const page = await context.newPage();
    expect(await submitLogin(page, admin.email, admin.password)).toBe(200);
    await expect(page).toHaveURL(/\/admin$/);
    await expect(page.getByTestId("staff-session")).toHaveAttribute("data-role", "admin");
    await expectSessionCookieProtected(context);
    await page.reload();
    await expect(page.getByTestId("staff-session")).toHaveAttribute("data-role", "admin");
    await page.goto("/teacher");
    await expect(productAlert(page)).toContainText("目前帳號沒有這個頁面的權限");
    await page.goto("/admin");
    await logout(page);
    expect((await page.request.get("/api/v1/me")).status()).toBe(401);
    await page.goto("/admin");
    await expect(productAlert(page)).toContainText("尚未登入，或登入已過期");
    expect(await submitLogin(page, admin.email, admin.password)).toBe(200);
    await expect(page.getByTestId("staff-session")).toHaveAttribute("data-role", "admin");
    await logout(page);
  } finally {
    await context.close();
  }
});

test("待審／拒絕顯示本人受限狀態與登出；停用不發 cookie 並顯示無法使用", async ({ browser }) => {
  for (const [account, status, heading] of [
    [pending, "pending", "帳號待審核"],
    [rejected, "rejected", "帳號申請未通過"],
  ] as const) {
    const context = await newContext(browser);
    try {
      const page = await context.newPage();
      expect(await submitLogin(page, account.email, account.password)).toBe(200);
      await expect(page).toHaveURL(/\/account\/status$/);
      const card = page.getByTestId("account-status");
      await expect(card).toHaveAttribute("data-account-status", status);
      await expect(card).toContainText(heading);
      await page.goto(account.role === "admin" ? "/admin" : "/teacher");
      await expect(productAlert(page)).toContainText("沒有這個頁面的權限");
      await expect(page.getByTestId("staff-session")).toHaveCount(0);
      await page.goto("/account/status");
      await logout(page);
      expect((await page.request.get("/api/v1/me")).status()).toBe(401);
    } finally {
      await context.close();
    }
  }
  const context = await newContext(browser);
  try {
    const page = await context.newPage();
    expect(await submitLogin(page, disabled.email, disabled.password)).toBe(403);
    await expect(page.getByTestId("account-unavailable")).toContainText("帳號目前無法使用");
    await expect(page).toHaveURL(/\/login$/);
    expect((await context.cookies()).some((cookie) => cookie.name === sessionCookieName)).toBe(false);
  } finally {
    await context.close();
  }
});

test("錯誤憑證與依賴故障提示；密碼送出後清除且不寫入 URL／storage", async ({ browser }) => {
  const context = await newContext(browser);
  try {
    const page = await context.newPage();
    const wrong = `${teacher.password}x`;
    expect(await submitLogin(page, teacher.email, wrong)).toBe(401);
    await expect(productAlert(page)).toHaveText("電子郵件或密碼不正確；請確認後再試一次。");
    await expect(page.getByLabel("密碼")).toHaveValue("");
    await expectNoSecretPersisted(page, wrong);

    await control.query("REVOKE EXECUTE ON FUNCTION app.current_account_status() FROM authenticated");
    try {
      expect(await submitLogin(page, teacher.email, teacher.password)).toBe(503);
      await expect(productAlert(page)).toHaveText("登入服務暫時無法使用；請稍後再試。");
      expect((await context.cookies()).some((cookie) => cookie.name === sessionCookieName)).toBe(false);
    } finally {
      await control.query("GRANT EXECUTE ON FUNCTION app.current_account_status() TO authenticated");
    }
  } finally {
    await context.close();
  }
});

test("token 到期後要求重新登入，不自動 refresh；之後重新填表可登入", async ({ browser }) => {
  test.setTimeout(240_000);
  const context = await newContext(browser);
  try {
    const page = await context.newPage();
    const authCalls: string[] = [];
    page.on("request", (request) => {
      const path = new URL(request.url()).pathname;
      if (/refresh|token/i.test(path)) authCalls.push(path);
    });
    expect(await submitLogin(page, expiring.email, expiring.password)).toBe(200);
    await expect(page.getByTestId("staff-session")).toHaveAttribute("data-role", "teacher");
    await page.waitForTimeout(66_000);
    await page.reload();
    await expect(productAlert(page)).toContainText("尚未登入，或登入已過期");
    await expect(page.getByTestId("staff-session")).toHaveCount(0);
    expect((await page.request.get("/api/v1/me")).status()).toBe(401);
    expect(authCalls).toEqual([]);
    await page.getByRole("link", { name: "前往教職員登入" }).click();
    await expect(page).toHaveURL(/\/login$/);
    expect(await submitLogin(page, expiring.email, expiring.password)).toBe(200);
    await expect(page.getByTestId("staff-session")).toHaveAttribute("data-role", "teacher");
    await logout(page);
  } finally {
    await context.close();
  }
});

test("帳號×來源節流：連續錯誤後顯示稍後再試，正確密碼在鎖定期間也不放行", async ({ browser }) => {
  const context = await newContext(browser);
  try {
    const page = await context.newPage();
    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect(await submitLogin(page, throttled.email, `${throttled.password}${attempt}`)).toBe(401);
    }
    expect(await submitLogin(page, throttled.email, `${throttled.password}z`)).toBe(429);
    await expect(productAlert(page)).toContainText(/嘗試登入次數太多；請約 \d+ 秒後再試。/);
    expect(await submitLogin(page, throttled.email, throttled.password)).toBe(429);
    expect((await context.cookies()).some((cookie) => cookie.name === sessionCookieName)).toBe(false);
  } finally {
    await context.close();
  }
});
