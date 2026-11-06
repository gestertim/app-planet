import { randomUUID } from "node:crypto";
import { expect, test, type Request as BrowserRequest } from "@playwright/test";
import { createSyntheticStaffAccount, deleteSyntheticStaffAccount, openControlPool } from "../support/real-auth-fixture.ts";

test("真 HTTPS：管理員產品登入→取消／Escape→登錄未確認學校→詳情 reload→列表→提交回應遺失原鍵恢復", async ({ browser }) => {
  test.setTimeout(240_000);
  const control = openControlPool(), origin = process.env.APP_PLANET_APP_ORIGIN!;
  const account = await createSyntheticStaffAccount(control, "SchoolRegistrationAdmin", { role: "admin" });
  const context = await browser.newContext({ locale: "zh-TW", ignoreHTTPSErrors: true });
  const page = await context.newPage(), path = "/api/v1/admin/schools";
  const marker = randomUUID(), labels = [`合成 HTTPS 學校 ${marker}`, `合成 HTTPS 回應遺失 ${marker}`];
  const calls: { key?: string; body: string | null }[] = [];
  const observe = (r: BrowserRequest) => {
    if (new URL(r.url()).pathname === path && r.method() === "POST")
      calls.push({ key: r.headers()["idempotency-key"], body: r.postData() });
  };
  page.on("request", observe);
  const region = () => page.getByRole("region", { name: "學校管理", exact: true });
  let releaseScripts = () => {};
  try {
    expect((await control.query("SELECT id FROM app.schools WHERE label=ANY($1::text[])", [labels])).rowCount).toBe(0);
    await page.goto(`${origin}/login`);
    await expect(page.locator('form[data-ready="true"]')).toHaveCount(1);
    await page.getByLabel("電子郵件").fill(account.email);
    await page.getByLabel("密碼").fill(account.password);
    await page.getByRole("button", { name: "登入", exact: true }).press("Enter");
    await expect(page).toHaveURL(`${origin}/admin`);
    await expect(page.getByRole("link", { name: "學校管理", exact: true })).toHaveAttribute("href", "/admin/schools");
    const scripts = new Promise<void>((resolve) => { releaseScripts = resolve; });
    let held = 0;
    await page.route("**/*", async (route) => {
      if (route.request().resourceType() === "script") { held++; await scripts; }
      await route.continue();
    });
    const initial = await page.goto(`${origin}/admin/schools`, { waitUntil: "commit" });
    await initial!.finished(); expect(initial?.status()).toBe(200);
    await expect.poll(() => held).toBeGreaterThan(0);
    await expect(region().getByRole("button", { name: "核對並建立學校", exact: true })).toBeDisabled();
    await page.keyboard.press("Enter"); expect(calls).toHaveLength(0);
    releaseScripts(); await page.unrouteAll({ behavior: "wait" });
    await expect(region().getByRole("textbox", { name: "學校名稱", exact: true })).toBeEnabled();
    await region().getByRole("textbox", { name: "學校名稱", exact: true }).fill(labels[0]!);
    const trigger = region().getByRole("button", { name: "核對並建立學校", exact: true });
    await trigger.press("Enter");
    await page.getByRole("dialog").getByRole("button", { name: "取消，尚未送出", exact: true }).press("Enter");
    await expect(page.getByRole("dialog")).toHaveCount(0); await expect(trigger).toBeFocused();
    await trigger.press("Enter"); await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0); await expect(trigger).toBeFocused();
    expect(calls).toHaveLength(0);
    const create = async () => {
      await region().getByRole("button", { name: "核對並建立學校", exact: true }).press("Enter");
      await expect(page.getByRole("dialog")).toContainText("不代表學校已批准");
      await page.getByRole("dialog").getByRole("button", { name: "明確確認並送出建立", exact: true }).press("Enter");
    };
    const sent = page.waitForResponse((r) => new URL(r.url()).pathname === path && r.request().method() === "POST");
    await create(); const first = await sent; expect(first.status()).toBe(201);
    const id = (await control.query("SELECT id FROM app.schools WHERE label=$1", [labels[0]])).rows[0].id as string;
    await expect(page).toHaveURL(`${origin}/admin/schools/${id}`);
    await expect(region().getByTestId("school-detail")).toContainText(labels[0]!);
    await expect(region().getByTestId("school-detail")).toContainText("unconfirmed");
    await page.reload();
    await expect(region().getByTestId("school-detail")).toContainText(id);
    await expect(region().getByTestId("school-detail")).toContainText("尚無核驗紀錄");
    await expect(region().getByRole("button", { name: /核准|恢復/ })).toHaveCount(0);
    await region().getByRole("link", { name: "返回學校列表", exact: true }).click();
    await expect(region().getByRole("link", { name: labels[0]!, exact: true })).toBeVisible();
    await region().getByRole("textbox", { name: "學校名稱", exact: true }).fill(labels[1]!);
    let dropped = false;
    await page.route(`**${path}`, async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      const response = await route.fetch(); expect(response.status()).toBe(201);
      dropped = true; await route.abort("failed");
    }, { times: 1 });
    await create();
    await expect(region().getByRole("button", { name: "以原名稱與原鍵重試", exact: true })).toBeVisible();
    expect(dropped).toBe(true);
    expect((await control.query("SELECT id FROM app.schools WHERE label=$1", [labels[1]])).rowCount).toBe(1);
    await page.reload();
    await expect(region().getByRole("button", { name: "以原名稱與原鍵重試", exact: true })).toBeVisible();
    const replay = page.waitForResponse((r) => new URL(r.url()).pathname === path && r.request().method() === "POST");
    await region().getByRole("button", { name: "以原名稱與原鍵重試", exact: true }).press("Enter");
    const replayResponse = await replay; expect(replayResponse.status()).toBe(200);
    expect(replayResponse.headers()["idempotent-replay"]).toBe("true");
    const replayId = (await control.query("SELECT id FROM app.schools WHERE label=$1", [labels[1]])).rows[0].id as string;
    await expect(page).toHaveURL(`${origin}/admin/schools/${replayId}`);
    await expect(region().getByTestId("school-detail")).toContainText(labels[1]!);
    expect(calls).toHaveLength(3); expect(calls[1]).toEqual(calls[2]);
    const db = await control.query(`SELECT label,approval_state,approval_epoch::int,valid_until,current_doc_version
      FROM app.schools WHERE label=ANY($1::text[]) ORDER BY label`, [labels]);
    expect(db.rowCount).toBe(2);
    expect(db.rows.every((s) => s.approval_state === "unconfirmed" && s.approval_epoch === 0
      && s.valid_until === null && s.current_doc_version === null)).toBe(true);
    expect((await control.query(`SELECT id FROM app.teacher_school_memberships WHERE school_id IN
      (SELECT id FROM app.schools WHERE label=ANY($1::text[]))`, [labels])).rowCount).toBe(0);
    console.log("SchoolHTTPS=product_form_login;SSR_hydration_disabled;cancel_Escape_focus;POST_201;detail_reload_DB;paginated_list_find;committed_response_aborted;original_key_body_reload_replay_200;DB_exactly_two_unconfirmed;no_approval_or_fake_verification");
  } finally {
    releaseScripts(); await context.close();
    await control.query("DELETE FROM app.school_registration_receipts WHERE actor_id=$1", [account.id]);
    await control.query(`DELETE FROM app.audit_events WHERE actor_aid IN
      (SELECT aid FROM app.audit_identity_map WHERE account_id=$1)`, [account.id]);
    await control.query("DELETE FROM app.audit_identity_map WHERE account_id=$1", [account.id]);
    await control.query("DELETE FROM app.schools WHERE label=ANY($1::text[])", [labels]);
    await deleteSyntheticStaffAccount(control, account); await control.end();
  }
});
