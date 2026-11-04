import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import type { Pool } from "pg";
import {
  createSyntheticStaffAccount, deleteSyntheticStaffAccount, openControlPool, type SyntheticStaffAccount,
} from "../support/real-auth-fixture.ts";

test.describe.configure({ mode: "serial" });
let control: Pool;
let admin: SyntheticStaffAccount;
let approved: SyntheticStaffAccount;
let rejected: SyntheticStaffAccount;
const accounts: SyntheticStaffAccount[] = [];

test.beforeAll(async () => {
  control = openControlPool();
  for (const name of ["BootstrapBrowser", "ApproveBrowser", "RejectBrowser"]) {
    accounts.push(await createSyntheticStaffAccount(control, name, { role: "teacher", status: "pending" }));
  }
  [admin, approved, rejected] = accounts as [SyntheticStaffAccount, SyntheticStaffAccount, SyntheticStaffAccount];
  const cli = await promisify(execFile)(process.execPath, ["apps\\worker\\src\\admin\\bootstrap-cli.ts", admin.id], {
    env: process.env, windowsHide: true,
  });
  expect(JSON.parse(cli.stdout)).toEqual({ outcome: "completed" });
});

test.afterAll(async () => {
  if (!control) return;
  const ids = accounts.map((account) => account.id);
  await control.query("DELETE FROM app.staff_review_receipts WHERE actor_id=ANY($1::uuid[])", [ids]);
  await control.query(`DELETE FROM app.audit_events WHERE actor_aid IN
    (SELECT aid FROM app.audit_identity_map WHERE account_id=ANY($1::uuid[]))`, [ids]);
  await control.query("DELETE FROM app.audit_identity_map WHERE account_id=ANY($1::uuid[])", [ids]);
  await control.query("DELETE FROM app.first_admin_bootstrap WHERE target_id=ANY($1::uuid[])", [ids]);
  for (const account of accounts) await deleteSyntheticStaffAccount(control, account);
  await control.end();
});

async function context(browser: Browser): Promise<BrowserContext> {
  return browser.newContext({ locale: "zh-TW", ignoreHTTPSErrors: true });
}
async function login(page: Page, account: SyntheticStaffAccount) {
  await page.goto("/login");
  await expect(page.locator('form[data-ready="true"]')).toBeVisible();
  await page.getByLabel("電子郵件").fill(account.email);
  await page.getByLabel("密碼").fill(account.password);
  const response = page.waitForResponse((reply) => new URL(reply.url()).pathname === "/api/v1/auth/staff/login");
  await page.getByRole("button", { name: "登入", exact: true }).click();
  expect((await response).status()).toBe(200);
}

test("正式 bootstrap→產品雙 session 登入→UI 原鍵恢復批准／拒絕→教師重載→DB 稽核交叉驗證", async ({ browser }) => {
  const adminContext = await context(browser);
  const teacherContext = await context(browser);
  const rejectContext = await context(browser);
  try {
    const adminPage = await adminContext.newPage();
    const teacherPage = await teacherContext.newPage();
    const rejectPage = await rejectContext.newPage();
    await login(teacherPage, approved);
    await expect(teacherPage.getByTestId("account-status")).toHaveAttribute("data-account-status", "pending");
    await login(rejectPage, rejected);
    await expect(rejectPage.getByTestId("account-status")).toHaveAttribute("data-account-status", "pending");
    await teacherPage.goto("/admin");
    await expect(teacherPage.getByTestId("teacher-review")).toHaveCount(0);
    expect((await teacherContext.request.get("/api/v1/admin/teachers")).status()).toBe(403);
    await teacherPage.goto("/account/status");
    await login(adminPage, admin);
    const panel = adminPage.getByTestId("teacher-review");
    await expect(panel).toHaveAttribute("data-ready", "true");
    await expect(panel.getByRole("button", { name: "批准 合成教職員ApproveBrowser", exact: true })).toBeVisible();

    let dropped = false;
    const keys: string[] = [];
    await adminContext.route("**/api/v1/admin/teachers/*/review", async (route) => {
      keys.push(route.request().headers()["idempotency-key"]!);
      if (!dropped) {
        dropped = true;
        const reply = await route.fetch();
        expect(reply.status()).toBe(200);
        await route.abort("connectionreset");
      } else await route.continue();
    });
    await panel.getByRole("button", { name: "批准 合成教職員ApproveBrowser", exact: true }).click();
    await expect(panel.getByRole("dialog")).toContainText(approved.id);
    await panel.getByRole("button", { name: "確認批准", exact: true }).click();
    await expect(panel.getByRole("button", { name: "以原鍵重試同一決策" })).toBeVisible();
    expect((await control.query("SELECT status FROM app.profiles WHERE id=$1", [approved.id])).rows[0].status).toBe("approved");
    await panel.getByRole("button", { name: "以原鍵重試同一決策" }).click();
    await expect(panel.getByRole("status").filter({ hasText: "已批准" })).toBeVisible();
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
    await teacherPage.reload();
    await expect(teacherPage.getByTestId("account-status")).toHaveAttribute("data-account-status", "approved");
    await teacherPage.getByRole("link", { name: "前往教師工作台", exact: true }).click();
    await expect(teacherPage.getByTestId("staff-session")).toHaveAttribute("data-role", "teacher");
    expect((await teacherContext.request.get("/api/v1/admin/teachers")).status()).toBe(403);

    await panel.getByRole("button", { name: "拒絕 合成教職員RejectBrowser", exact: true }).click();
    await expect(panel.getByRole("dialog")).toContainText(rejected.id);
    await panel.getByRole("button", { name: "確認拒絕", exact: true }).click();
    await expect(panel.getByRole("status").filter({ hasText: "已拒絕" })).toBeVisible();
    await rejectPage.reload();
    await expect(rejectPage.getByTestId("account-status")).toHaveAttribute("data-account-status", "rejected");
    await rejectPage.goto("/teacher");
    await expect(rejectPage.getByTestId("staff-session")).toHaveCount(0);
    await rejectPage.goto("/admin");
    await expect(rejectPage.getByTestId("teacher-review")).toHaveCount(0);
    expect((await rejectContext.request.get("/api/v1/admin/teachers")).status()).toBe(403);

    const { rows } = await control.query(`SELECT p.id,p.role,p.status,p.row_version,
      (SELECT count(*)::int FROM app.audit_events e JOIN app.audit_identity_map m ON m.aid=e.subject_aid
       WHERE m.account_id=p.id AND e.action=CASE p.status WHEN 'approved' THEN 'teacher_approved' ELSE 'teacher_rejected' END) AS audits
      FROM app.profiles p WHERE p.id=ANY($1::uuid[]) ORDER BY p.id`, [[approved.id, rejected.id]]);
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.role).toBe("teacher");
      expect(row.row_version).toBe(1);
      expect(row.audits).toBe(1);
      expect(row.status).toBe(row.id === approved.id ? "approved" : "rejected");
    }
    expect((await control.query("SELECT count(*)::int AS n FROM app.first_admin_bootstrap WHERE target_id=$1", [admin.id])).rows[0].n).toBe(1);
    console.info("T018 browser: bootstrap CLI、產品表單登入、真 DB 批准／拒絕、原鍵 response-loss replay、教師重載與逐筆稽核均已核對。");
  } finally {
    await Promise.all([adminContext.close(), teacherContext.close(), rejectContext.close()]);
  }
});
