import { execFile } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import type { Pool } from "pg";
import {
  createSyntheticStaffAccount, deleteSyntheticStaffAccount, openControlPool, type SyntheticStaffAccount,
} from "../support/real-auth-fixture.ts";
import { deleteMailFor, waitForNewMail } from "../support/test-mailbox.ts";

// readiness §92：真 Next HTTPS 瀏覽器端到端。教師帳號一律由產品申請頁建立；驗證一律開啟隔離信箱中的真實驗證信；
// 不預建教師 Auth／profile、不以 admin API／SQL 設定驗證、不注入 cookie、不直接 UPDATE 批准。管理員沿用正式 bootstrap。
test.describe.configure({ mode: "serial" });

const appOrigin = process.env.APP_PLANET_APP_ORIGIN!;
const mailOrigin = new URL(process.env.APP_PLANET_TEST_MAIL_API_URL!).origin;
const adminAuthKey = process.env.APP_PLANET_TEST_AUTH_ADMIN_KEY!;
const authOrigin = process.env.APP_PLANET_AUTH_ORIGIN!;
const suffix = randomBytes(3).toString("hex");
type Applicant = { email: string; password: string; displayName: string; schoolNote: string };
const makeApplicant = (label: string): Applicant => ({
  email: `ap-browser-${randomUUID()}@example.invalid`,
  password: `${randomBytes(18).toString("base64url")}Aa9!`,
  displayName: `合成教師${label}${suffix}`,
  schoolNote: `合成國小${label}　五年級導師`,
});
const approvedApplicant = makeApplicant("甲");
const rejectedApplicant = makeApplicant("乙");
const applicants = [approvedApplicant, rejectedApplicant];
const recoveryApplicants: Applicant[] = [];
let control: Pool;
let admin: SyntheticStaffAccount;
const observed: { url: string; postData: string | null }[] = [];
const consoleText: string[] = [];

test.beforeAll(async () => {
  control = openControlPool();
  const { rows } = await control.query<{ ready: boolean }>(`SELECT EXISTS (SELECT 1 FROM app.teacher_signup_local_config)
    AND NOT EXISTS (SELECT 1 FROM app.first_admin_bootstrap) AS ready`);
  expect(rows[0]!.ready).toBe(true);
  for (const person of applicants) {
    expect((await control.query("SELECT 1 FROM auth.users WHERE lower(email)=lower($1)", [person.email])).rowCount).toBe(0);
  }
  admin = await createSyntheticStaffAccount(control, `SignupBrowserAdmin${suffix}`, { role: "teacher", status: "pending" });
  const cli = await promisify(execFile)(process.execPath, ["apps\\worker\\src\\admin\\bootstrap-cli.ts", admin.id], {
    env: process.env, windowsHide: true,
  });
  expect(JSON.parse(cli.stdout)).toEqual({ outcome: "completed" });
});

test.afterAll(async () => {
  if (!control) return;
  const emails = [...applicants, ...recoveryApplicants].map((person) => person.email.toLowerCase());
  const users = (await control.query<{ id: string }>("SELECT id::text FROM auth.users WHERE lower(email)=ANY($1::text[])", [emails])).rows;
  const ids = [...users.map((row) => row.id), admin?.id].filter(Boolean) as string[];
  await control.query("DELETE FROM app.staff_review_receipts WHERE actor_id=ANY($1::uuid[]) OR target_id=ANY($1::uuid[])", [ids]);
  await control.query(`DELETE FROM app.audit_events WHERE actor_aid IN
    (SELECT aid FROM app.audit_identity_map WHERE account_id=ANY($1::uuid[]))
    OR subject_aid IN (SELECT aid FROM app.audit_identity_map WHERE account_id=ANY($1::uuid[]))`, [ids]);
  await control.query("DELETE FROM app.audit_identity_map WHERE account_id=ANY($1::uuid[])", [ids]);
  await control.query("DELETE FROM app.first_admin_bootstrap WHERE target_id=ANY($1::uuid[])", [ids]);
  await control.query("DELETE FROM app.teacher_applications WHERE account_id=ANY($1::uuid[])", [ids]);
  await control.query("DELETE FROM app.teacher_signup_intents WHERE email_sha256=ANY($1::bytea[])",
    [emails.map((email) => createHash("sha256").update(email, "utf8").digest())]);
  await control.query("DELETE FROM app.profiles WHERE id=ANY($1::uuid[])", [users.map((row) => row.id)]);
  for (const row of users) {
    const response = await fetch(`${authOrigin}/auth/v1/admin/users/${row.id}`, {
      method: "DELETE", cache: "no-store", redirect: "error",
      headers: { apikey: adminAuthKey, authorization: `Bearer ${adminAuthKey}` },
    });

    expect([200, 204, 404]).toContain(response.status);
  }
  if (admin) await deleteSyntheticStaffAccount(control, admin);
  await deleteMailFor(emails);
  await control.end();
});

test("§92 unknown 後修改欄位不換鍵；reload／新分頁不能繞過持久未結申請", async ({ browser }) => {
  const person = makeApplicant("未知恢復");
  recoveryApplicants.push(person);
  const key = randomUUID();
  const client = await control.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL ROLE app_signup_intake");
    await client.query("SELECT app.register_teacher_signup_intent($1::uuid,$2,$3,$4)",
      [key, person.email, person.displayName, person.schoolNote]);
    await client.query("COMMIT");
  } finally { client.release(); }
  const context = await newContext(browser);
  let requests = 0;
  let loseResponse = true;
  try {
    await context.route("**/api/v1/auth/teacher-signup", async (route) => {
      requests++;
      const response = await route.fetch();
      expect(response.status()).toBe(202);
      if (loseResponse) { loseResponse = false; await route.abort("failed"); }
      else await route.fulfill({ response });
    });
    const page = await context.newPage();
    const fill = async (target: Page) => {
      await target.goto("/signup");
      await expect(target.locator('form[data-ready="true"]').first()).toBeVisible();
      await target.getByLabel("電子郵件", { exact: true }).first().fill(person.email);
      await target.getByLabel("密碼（至少 8 個字元）").fill(person.password);
      await target.getByLabel("顯示名稱（最多 40 字）").fill(person.displayName);
      await target.getByLabel("所屬學校／任教說明（最多 200 字）").fill(person.schoolNote);
    };
    await fill(page);
    await page.getByRole("button", { name: "送出教師申請", exact: true }).click();
    await expect(page.getByTestId("signup-unknown")).toBeVisible();
    await page.getByLabel("顯示名稱（最多 40 字）").fill("更改嘗試");
    await page.getByLabel("所屬學校／任教說明（最多 200 字）").fill("更改說明");
    await page.getByLabel("密碼（至少 8 個字元）").fill(person.password);
    await page.getByRole("button", { name: "送出教師申請", exact: true }).press("Enter");
    await expect(page.getByTestId("signup-unknown")).toBeFocused();
    expect(requests).toBe(1);
    await expectNoSecretsInStorage(page, person);
    await page.reload();
    await fill(page);
    await page.getByRole("button", { name: "送出教師申請", exact: true }).click();
    await expect(page.getByTestId("signup-submitted")).toContainText("不確認帳號是否已建立");
    const tab = await context.newPage();
    await fill(tab);
    await tab.getByRole("button", { name: "送出教師申請", exact: true }).click();
    await expect(tab.getByTestId("signup-submitted")).toBeVisible();
    expect(requests).toBe(3);
    expect((await control.query("SELECT count(*)::int AS n FROM auth.users WHERE email=$1", [person.email])).rows[0].n).toBe(0);
    expect((await control.query("SELECT count(*)::int AS n FROM app.teacher_signup_intents WHERE email_sha256=$1",
      [createHash("sha256").update(person.email).digest()])).rows[0].n).toBe(1);
    console.info("BrowserUnknown fieldChangeRequests=0 reloadAndNewTabAccounts=0 durableIntents=1");
  } finally { await context.close(); }
});

test("§92 UI 非法 200 不顯示電郵已驗證", async ({ browser }) => {
  const context = await newContext(browser);
  try {
    const page = await context.newPage();
    await page.goto(`/auth/confirm?token_hash=${randomBytes(28).toString("hex")}&type=signup`);
    await page.route("**/api/v1/auth/teacher-signup/verify", (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: '{"unexpected":true}' }));
    await page.getByRole("button", { name: "確認電郵", exact: true }).click();
    await expect(page.getByTestId("email-verify")).toHaveAttribute("data-verify-state", "unknown");
    await expect(page.getByRole("heading", { name: "電郵已驗證" })).toHaveCount(0);
    expect((await context.cookies()).some((cookie) => cookie.name === "__Host-app-planet-signup-verify")).toBe(true);
  } finally { await context.close(); }
});

test("§92 過期與衝突回應不清除原操作鍵", async ({ browser }) => {
  for (const code of ["signup_operation_expired", "idempotency_key_reuse"]) {
    const context = await newContext(browser);
    const person = makeApplicant("保留原鍵");
    const keys: (string | undefined)[] = [];
    try {
      const page = await context.newPage();
      await page.route("**/api/v1/auth/teacher-signup", async (route) => {
        keys.push(route.request().headers()["idempotency-key"]);
        await route.fulfill({ status: keys.length === 1 ? 409 : 202, contentType: "application/json",
          body: JSON.stringify(keys.length === 1 ? { code } : { status: "submitted" }) });
      });
      await page.goto("/signup");
      await expect(page.locator('form[data-ready="true"]').first()).toBeVisible();
      await page.getByLabel("電子郵件", { exact: true }).first().fill(person.email);
      await page.getByLabel("密碼（至少 8 個字元）").fill(person.password);
      await page.getByLabel("顯示名稱（最多 40 字）").fill(person.displayName);
      await page.getByLabel("所屬學校／任教說明（最多 200 字）").fill(person.schoolNote);
      await page.getByRole("button", { name: "送出教師申請", exact: true }).click();
      await expect(page.getByTestId("signup-unknown")).toBeVisible();
      await page.getByLabel("密碼（至少 8 個字元）").fill(person.password);
      await page.getByRole("button", { name: "送出教師申請", exact: true }).click();
      await expect(page.getByTestId("signup-submitted")).toBeVisible();
      expect(keys).toHaveLength(2);
      expect(keys[0]).toBeTruthy();
      expect(keys[1]).toBe(keys[0]);
    } finally { await context.close(); }
  }
});

async function newContext(browser: Browser, javaScriptEnabled = true): Promise<BrowserContext> {
  const context = await browser.newContext({ locale: "zh-TW", ignoreHTTPSErrors: true, javaScriptEnabled });
  // 郵件接收器只供測試工具讀取；瀏覽器不得連線（若產品頁面試圖存取即失敗並被記錄）。
  await context.route(`${mailOrigin}/**`, (route) => route.abort("blockedbyclient"));
  context.on("request", (request) => observed.push({ url: request.url(), postData: request.postData() }));
  context.on("console", (message) => consoleText.push(message.text()));
  return context;
}

async function staffLogin(page: Page, person: { email: string; password: string }, expected = 200) {
  await page.goto("/login");
  await expect(page.locator('form[data-ready="true"]')).toBeVisible();
  await page.getByLabel("電子郵件", { exact: true }).fill(person.email);
  await page.getByLabel("密碼", { exact: true }).fill(person.password);
  const response = page.waitForResponse((reply) => new URL(reply.url()).pathname === "/api/v1/auth/staff/login");
  await page.getByRole("button", { name: "登入", exact: true }).click();
  expect((await response).status()).toBe(expected);
}

async function applyViaProduct(page: Page, person: Applicant, viaKeyboard: boolean) {
  await page.goto("/login");
  await page.getByRole("link", { name: "申請教師帳號", exact: true }).click();
  await expect(page).toHaveURL(/\/signup$/);
  const form = page.locator("form").filter({ has: page.getByRole("button", { name: "送出教師申請" }) });
  await expect(form).toHaveAttribute("data-ready", "true");
  await page.getByLabel("電子郵件", { exact: true }).fill(person.email);
  await page.getByLabel("密碼（至少 8 個字元）").fill(person.password);
  await page.getByLabel("顯示名稱（最多 40 字）").fill(person.displayName);
  await page.getByLabel("所屬學校／任教說明（最多 200 字）").fill(person.schoolNote);
  const response = page.waitForResponse((reply) => new URL(reply.url()).pathname === "/api/v1/auth/teacher-signup");
  if (viaKeyboard) await page.getByLabel("顯示名稱（最多 40 字）").press("Enter");
  else await page.getByRole("button", { name: "送出教師申請", exact: true }).click();
  const reply = await response;
  expect(reply.status()).toBe(202);
  expect(reply.request().headers()["idempotency-key"]).toMatch(/^[0-9a-f-]{36}$/);
  await expect(page.getByTestId("signup-submitted")).toContainText("送出成功不代表信件已送達");
  expect(page.url()).toBe(`${appOrigin}/signup`);
}

async function verifyViaMail(page: Page, person: Applicant): Promise<string> {
  const mail = await waitForNewMail(person.email, [], appOrigin);
  await page.goto(mail.pathAndQuery);
  // 落點立即 303 到不含驗證值的頁面；按下確認才消耗。
  await expect(page).toHaveURL(`${appOrigin}/signup/verify`);
  const panel = page.getByTestId("email-verify");
  await expect(panel).toHaveAttribute("data-ready", "true");
  await expect(panel).toHaveAttribute("data-verify-state", "idle");
  const cookies = await page.context().cookies();
  const pending = cookies.find((cookie) => cookie.name === "__Host-app-planet-signup-verify");
  expect(pending).toEqual(expect.objectContaining({ httpOnly: true, secure: true, sameSite: "Strict", path: "/" }));
  await panel.getByRole("button", { name: "確認電郵", exact: true }).click();
  await expect(panel).toHaveAttribute("data-verify-state", "verified");
  await expect(panel).toContainText("仍待平台管理員審核");
  expect((await page.context().cookies()).some((cookie) => cookie.name === "__Host-app-planet-signup-verify")).toBe(false);
  return mail.pathAndQuery;
}

async function expectNoSecretsInStorage(page: Page, person: Applicant) {
  const dump = await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage }, href: location.href }));
  expect(dump).not.toContain(person.password);
  expect(dump).not.toContain("token_hash");
}

test("產品申請→真實驗證信→待審→管理員 UI 批准／拒絕→教師重載取得正確狀態；DB 交叉核對", async ({ browser }) => {
  // hydration 前：停用 JavaScript 時表單不可操作，原生送出不會發生。
  const observedStart = observed.length;
  const noScript = await newContext(browser, false);
  try {
    const page = await noScript.newPage();
    await page.goto("/signup");
    await expect(page.getByRole("button", { name: "送出教師申請" })).toBeDisabled();
    await expect(page.getByLabel("電子郵件", { exact: true })).toBeDisabled();
    expect(observed.slice(observedStart).some((entry) => new URL(entry.url).pathname.startsWith("/api/v1/auth/teacher-signup"))).toBe(false);
  } finally {
    await noScript.close();
  }

  const approvedContext = await newContext(browser);
  const rejectedContext = await newContext(browser);
  const adminContext = await newContext(browser);
  try {
    const approvedPage = await approvedContext.newPage();
    const rejectedPage = await rejectedContext.newPage();
    await applyViaProduct(approvedPage, approvedApplicant, true);
    await applyViaProduct(rejectedPage, rejectedApplicant, false);
    await expectNoSecretsInStorage(approvedPage, approvedApplicant);

    // 驗證前：產品登入只顯示未驗證提示，不發 session、不能進教師工作台。
    await staffLogin(approvedPage, approvedApplicant, 403);
    await expect(approvedPage.getByTestId("email-not-verified")).toBeVisible();
    expect((await approvedContext.cookies()).some((cookie) => cookie.name === "__Host-app-planet-session")).toBe(false);
    await approvedPage.goto("/teacher");
    await expect(approvedPage.getByTestId("staff-session")).toHaveCount(0);

    // 管理員登入；未驗證申請不出現在可審清單。
    const adminPage = await adminContext.newPage();
    await staffLogin(adminPage, admin);
    const panel = adminPage.getByTestId("teacher-review");
    await expect(panel).toHaveAttribute("data-ready", "true");
    await expect(panel.getByRole("button", { name: `批准 ${approvedApplicant.displayName}`, exact: true })).toHaveCount(0);

    const usedLink = await verifyViaMail(approvedPage, approvedApplicant);
    await verifyViaMail(rejectedPage, rejectedApplicant);

    // 重放已使用連結與未知連結：回到可理解的無效狀態，不改變帳號。
    await approvedPage.goto(usedLink);
    await approvedPage.getByTestId("email-verify").getByRole("button", { name: "確認電郵", exact: true }).click();
    await expect(approvedPage.getByTestId("email-verify")).toHaveAttribute("data-verify-state", "invalid");
    await approvedPage.goto(`/auth/confirm?token_hash=${randomBytes(28).toString("hex")}&type=signup`);
    await approvedPage.getByTestId("email-verify").getByRole("button", { name: "確認電郵", exact: true }).click();
    await expect(approvedPage.getByTestId("email-verify")).toHaveAttribute("data-verify-state", "invalid");
    await approvedPage.goto("/auth/confirm?token_hash=zz&type=recovery");
    await expect(approvedPage.getByTestId("email-verify")).toHaveAttribute("data-verify-state", "invalid");

    // 驗證後、審核前：登入只到狀態頁（待審），不能進工作台。
    for (const [page, person] of [[approvedPage, approvedApplicant], [rejectedPage, rejectedApplicant]] as const) {
      await staffLogin(page, person);
      await expect(page.getByTestId("account-status")).toHaveAttribute("data-account-status", "pending");
      await page.goto("/teacher");
      await expect(page.getByTestId("staff-session")).toHaveCount(0);
      await page.goto("/account/status");
    }

    // 管理員從既有 §91 畫面看到申請說明並批准／拒絕。
    await adminPage.reload();
    await expect(panel).toHaveAttribute("data-ready", "true");
    await expect(panel).toContainText(approvedApplicant.schoolNote);
    await panel.getByRole("button", { name: `批准 ${approvedApplicant.displayName}`, exact: true }).click();
    await panel.getByRole("button", { name: "確認批准", exact: true }).click();
    await expect(panel.getByRole("status").filter({ hasText: "已批准" })).toBeVisible();
    await panel.getByRole("button", { name: `拒絕 ${rejectedApplicant.displayName}`, exact: true }).click();
    await panel.getByRole("button", { name: "確認拒絕", exact: true }).click();
    await expect(panel.getByRole("status").filter({ hasText: "已拒絕" })).toBeVisible();

    await approvedPage.reload();
    await expect(approvedPage.getByTestId("account-status")).toHaveAttribute("data-account-status", "approved");
    await approvedPage.getByRole("link", { name: "前往教師工作台", exact: true }).click();
    await expect(approvedPage.getByTestId("staff-session")).toHaveAttribute("data-role", "teacher");
    expect((await approvedContext.request.get("/api/v1/admin/teachers")).status()).toBe(403);
    await rejectedPage.reload();
    await expect(rejectedPage.getByTestId("account-status")).toHaveAttribute("data-account-status", "rejected");
    await rejectedPage.goto("/teacher");
    await expect(rejectedPage.getByTestId("staff-session")).toHaveCount(0);

    // 重新登入仍取得正確狀態。
    await staffLogin(rejectedPage, rejectedApplicant);
    await expect(rejectedPage.getByTestId("account-status")).toHaveAttribute("data-account-status", "rejected");
    await expectNoSecretsInStorage(rejectedPage, rejectedApplicant);

    const { rows } = await control.query(`SELECT p.id, u.email, p.role, p.status, p.school_id, p.display_label, p.row_version,
        u.email_confirmed_at IS NOT NULL AS verified, a.school_note,
        (SELECT count(*)::int FROM app.audit_events e JOIN app.audit_identity_map m ON m.aid=e.subject_aid WHERE m.account_id=p.id) AS audits,
        (SELECT e.meta::text FROM app.audit_events e JOIN app.audit_identity_map m ON m.aid=e.subject_aid WHERE m.account_id=p.id) AS meta
      FROM auth.users u JOIN app.profiles p ON p.id=u.id JOIN app.teacher_applications a ON a.account_id=p.id
      WHERE lower(u.email)=ANY($1::text[])`, [applicants.map((person) => person.email.toLowerCase())]);
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      const person = row.email === approvedApplicant.email.toLowerCase() ? approvedApplicant : rejectedApplicant;
      expect(row).toEqual(expect.objectContaining({
        role: "teacher", status: person === approvedApplicant ? "approved" : "rejected", school_id: null,
        display_label: person.displayName, row_version: 1, verified: true, school_note: person.schoolNote, audits: 1,
      }));
      for (const secret of [person.email, person.displayName, person.schoolNote]) expect(row.meta).not.toContain(secret);
    }
    expect((await control.query("SELECT count(*)::int AS n FROM app.first_admin_bootstrap")).rows[0].n).toBe(1);
  } finally {
    await Promise.all([approvedContext.close(), rejectedContext.close(), adminContext.close()]);
  }

  // 密碼／驗證值不出現在任何瀏覽器請求 URL；密碼只出現在申請與登入 POST 本文；瀏覽器未連郵件接收器；console 無秘密。
  for (const person of applicants) {
    for (const entry of observed) {
      expect(entry.url).not.toContain(encodeURIComponent(person.password));
      expect(entry.url).not.toContain(person.password);
      const path = new URL(entry.url).pathname;
      if (entry.postData?.includes(person.password)) {
        expect(["/api/v1/auth/teacher-signup", "/api/v1/auth/staff/login"]).toContain(path);
      }
    }
    expect(consoleText.join("\n")).not.toContain(person.password);
  }
  expect(observed.filter((entry) => entry.url.includes("/auth/confirm?")).every((entry) =>
    !entry.url.includes("token_hash=") || new URL(entry.url).pathname === "/auth/confirm")).toBe(true);
  expect(observed.some((entry) => new URL(entry.url).origin === mailOrigin)).toBe(false);
  console.info("T017 browser: 產品申請、真實驗證信、未驗證阻擋、待審、§91 UI 批准／拒絕、教師重載／重新登入與 DB 稽核均已核對。");
});
