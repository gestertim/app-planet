import { expect, test, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { specificationStatusSchema } from "@app-planet/core";
import {
  createSyntheticAuthAccount, deleteSyntheticAuthAccount, loginSyntheticAccount, openControlPool,
} from "../support/real-auth-fixture.ts";
import { sessionCookieName } from "../../apps/web/src/server/auth-principal.ts";

test.use({ actionTimeout: 15_000 });
const region = (page: Page) => page.getByRole("region", { name: "專案重新命名", exact: true });
const endpoint = (id: string) => `/api/v1/projects/${id}`;
const patchResponse = (page: Page, id: string) => page.waitForResponse((response) =>
  new URL(response.url()).pathname === endpoint(id) && response.request().method() === "PATCH");
async function rename(page: Page, id: string, title: string) {
  await region(page).getByRole("button", { name: "重新命名", exact: true }).click();
  await region(page).getByLabel("新專案名稱").fill(title);
  const pending = patchResponse(page, id);
  await region(page).getByRole("button", { name: "保存名稱", exact: true }).click();
  const response = await pending;
  expect(response.status()).toBe(200);
  await expect(region(page).getByTestId("rename-status")).toContainText("已保存");
}

test("P-2 真 HTTPS：產品建立、取消／鍵盤／guard、改名讀回與雙分頁真 409", async ({ browser }) => {
  test.setTimeout(180_000);
  const control = openControlPool();
  const account = await createSyntheticAuthAccount(control, "RenameBrowser");
  // 合成學生由測試 setup 取得真 Auth session，不是學生登入碼產品 E2E。
  const session = await loginSyntheticAccount(account);
  const origin = process.env.APP_PLANET_APP_ORIGIN!;
  const context = await browser.newContext({ locale: "zh-TW" });
  let id: string | undefined;
  try {
    await context.addCookies([{ name: sessionCookieName, value: session.accessToken, url: origin,
      secure: true, httpOnly: true, sameSite: "Strict" }]);
    const page = await context.newPage();
    await page.goto(`${origin}/student`);
    await page.getByLabel("專案名稱").fill("改名前");
    const creating = page.waitForResponse((r) => new URL(r.url()).pathname === "/api/v1/projects" && r.request().method() === "POST");
    await page.getByRole("button", { name: "建立專案", exact: true }).click();
    const created = await creating;
    expect(created.status()).toBe(201);
    id = (await created.json()).id as string;
    const mutationHeaders = () => ({ origin, "idempotency-key": randomUUID() });
    const savedRequirements = await context.request.put(`${origin}${endpoint(id)}/requirements`, {
      headers: { ...mutationHeaders(), "if-match": '"0"' },
      data: { expected_requirements_revision: 0,
        requirements: { description: "改名不可改寫的正式需求", runtime_needs: "static", runtime_ai_required: false } },
    });
    expect(savedRequirements.status()).toBe(200);
    const classified = await context.request.post(`${origin}${endpoint(id)}/classification/confirmation`, {
      headers: { ...mutationHeaders(), "if-match": '"1"' },
      data: { expected_requirements_revision: 1, tier: "A", needs_visitor_identity: false,
        requested_tier_acknowledgement: "no_preference" },
    });
    expect(classified.status()).toBe(200);
    const classification = await classified.json();
    const stageUrl = `${origin}${endpoint(id)}/stages/Specification`;
    const draft = await context.request.put(stageUrl, {
      headers: { ...mutationHeaders(), "if-none-match": "*" }, data: { content: { text: "改名不可改寫的 Specification" } },
    });
    expect(draft.status()).toBe(201);
    const submission = await context.request.post(`${stageUrl}/submissions`, {
      headers: mutationHeaders(), data: { expected_draft_version: 0,
        expected_requirements_revision: 1, expected_classification_id: classification.current.confirmation.id },
    });
    expect(submission.status()).toBe(200);
    const evidenceBefore = specificationStatusSchema.parse(await (await context.request.get(`${stageUrl}/submissions`)).json());
    if (!evidenceBefore.latest) throw new Error("合成提交未建立");
    const immutableBefore = (await control.query("SELECT to_jsonb(s) AS submission FROM app.specification_submissions s WHERE project_id=$1", [id])).rows;
    const { row_version: _versionBefore, ...requirementsBefore } =
      await (await context.request.get(`${origin}${endpoint(id)}/requirements`)).json();
    const baseVersion = (await control.query("SELECT row_version FROM app.projects WHERE id=$1", [id])).rows[0].row_version as number;
    await page.getByTestId("owned-project-list").getByRole("link", { name: "改名前", exact: true }).click();
    let patches = 0;
    page.on("request", (r) => { if (r.method() === "PATCH" && new URL(r.url()).pathname === endpoint(id!)) patches++; });
    const trigger = region(page).getByRole("button", { name: "重新命名", exact: true });
    await trigger.focus(); await page.keyboard.press("Enter");
    const input = region(page).getByLabel("新專案名稱");
    await expect(input).toBeFocused();
    await input.fill("取消的名稱");
    await page.keyboard.press("Escape");
    await expect(trigger).toBeFocused();
    expect(patches).toBe(0);
    await trigger.click();
    await expect(input).toHaveValue("改名前");
    await input.fill("尚未保存");
    await page.getByRole("link", { name: "畫面設計", exact: true }).click();
    await expect(page.getByTestId("unsaved-changes-dialog")).toBeVisible();
    await page.getByTestId("unsaved-changes-dialog").getByRole("button", { name: "留在目前頁面" }).click();
    await expect(input).toHaveValue("尚未保存");
    await region(page).getByRole("button", { name: "取消重新命名" }).click();
    await rename(page, id, "第一個新名稱");
    await expect(page.getByRole("heading", { name: "第一個新名稱", exact: true })).toBeVisible();
    await page.reload();
    await expect(page.getByRole("heading", { name: "第一個新名稱", exact: true })).toBeVisible();
    await page.getByRole("link", { name: "工作台", exact: true }).first().click();
    await expect(page.getByTestId("owned-project-list").getByRole("link", { name: "第一個新名稱", exact: true })).toBeVisible();
    await page.getByTestId("owned-project-list").getByRole("link", { name: "第一個新名稱", exact: true }).click();
    const other = await context.newPage();
    await other.goto(`${origin}/student/projects/${id}`);
    await trigger.click();
    await input.fill("我的衝突名稱");
    await rename(other, id, "另一分頁的新名");
    const pending = patchResponse(page, id);
    await region(page).getByRole("button", { name: "保存名稱", exact: true }).click();
    const conflict = await pending;
    expect(conflict.status()).toBe(409);
    expect((await conflict.json()).conflict).toEqual({
      current: { version: baseVersion + 2, content: { title: "另一分頁的新名" } },
      submitted: { version: baseVersion + 1, content: { title: "我的衝突名稱" } },
    });
    await expect(input).toHaveValue("我的衝突名稱");
    await expect(region(page).getByTestId("rename-conflict")).toContainText("另一分頁的新名");
    expect(patches).toBe(2);
    const retry = patchResponse(page, id);
    await region(page).getByRole("button", { name: "明確再次保存我的名稱" }).click();
    expect((await retry).status()).toBe(200);
    await expect(region(page).getByTestId("rename-status")).toContainText("已保存");
    await page.reload();
    await expect(page.getByRole("heading", { name: "我的衝突名稱", exact: true })).toBeVisible();
    await region(other).getByLabel("新專案名稱").fill("選擇重新讀取而非覆蓋");
    const anotherConflict = patchResponse(other, id);
    await region(other).getByRole("button", { name: "保存名稱", exact: true }).click();
    expect((await anotherConflict).status()).toBe(409);
    await expect(region(other).getByLabel("新專案名稱")).toHaveValue("選擇重新讀取而非覆蓋");
    await region(other).getByRole("button", { name: "重新讀取並採用 DB 名稱" }).click();
    await expect(region(other).getByLabel("新專案名稱")).toHaveValue("我的衝突名稱");
    expect((await control.query("SELECT title,row_version,stage FROM app.projects WHERE id=$1", [id])).rows[0])
      .toEqual({ title: "我的衝突名稱", row_version: baseVersion + 3, stage: "點子" });
    const evidenceAfter = specificationStatusSchema.parse(await (await context.request.get(`${stageUrl}/submissions`)).json());
    expect(evidenceAfter).toEqual({ ...evidenceBefore, latest: { ...evidenceBefore.latest, title: "我的衝突名稱" } });
    expect((await control.query("SELECT to_jsonb(s) AS submission FROM app.specification_submissions s WHERE project_id=$1", [id])).rows)
      .toEqual(immutableBefore);
    const { row_version: _versionAfter, ...requirementsAfter } =
      await (await context.request.get(`${origin}${endpoint(id)}/requirements`)).json();
    expect(requirementsAfter).toEqual(requirementsBefore);
    const unhydrated = await browser.newContext({ javaScriptEnabled: false });
    await unhydrated.addCookies(await context.cookies());
    try {
      const ssr = await unhydrated.newPage();
      await ssr.goto(`${origin}/student/projects/${id}`);
      const ssrRegion = ssr.locator('section[aria-label="專案重新命名"]');
      await expect(ssrRegion.locator("button")).toBeDisabled();
      await expect(ssrRegion.locator("form")).toHaveCount(0);
    } finally { await unhydrated.close(); }
    console.log("RenameHTTPS=product_create/reload/workbench; real409/explicit_save; cancel/keyboard/Escape/focus/guard; SSR_no_native_POST");
  } finally {
    await context.close();
    if (id) {
      await control.query("DELETE FROM app.project_rename_receipts WHERE project_id=$1", [id]);
      await control.query("DELETE FROM app.specification_submissions WHERE project_id=$1", [id]);
      await control.query("DELETE FROM app.stage_draft_idempotency WHERE project_id=$1", [id]);
      await control.query("DELETE FROM app.stage_records WHERE project_id=$1", [id]);
      await control.query("UPDATE app.projects SET classification_state='unconfirmed',tier=NULL,needs_visitor_identity=NULL,current_confirmation_id=NULL WHERE id=$1", [id]);
      await control.query("DELETE FROM app.project_classification_idempotency WHERE project_id=$1", [id]);
      await control.query("DELETE FROM app.project_classification_confirmations WHERE project_id=$1", [id]);
      await control.query("DELETE FROM app.project_requirements WHERE project_id=$1", [id]);
      await control.query("DELETE FROM app.project_create_idempotency WHERE project_id=$1", [id]);
      await control.query("DELETE FROM app.projects WHERE id=$1 AND owner_id=$2", [id, account.id]);
    }
    await control.query("DELETE FROM app.audit_events WHERE actor_aid IN (SELECT aid FROM app.audit_identity_map WHERE account_id=$1)", [account.id]);
    await control.query("DELETE FROM app.audit_identity_map WHERE account_id=$1", [account.id]);
    await control.query("DELETE FROM app.profiles WHERE id=$1", [account.id]);
    await control.query("DELETE FROM app.schools WHERE id=$1", [account.schoolId]);
    await deleteSyntheticAuthAccount(account);
    await control.end();
  }
});

test("P-2 COMMIT 後 response loss、reload 原意圖 replay 不倒蓋 current", async ({ browser }) => {
  test.setTimeout(180_000);
  const control = openControlPool();
  const account = await createSyntheticAuthAccount(control, "RenameLoss");
  const session = await loginSyntheticAccount(account);
  const origin = process.env.APP_PLANET_APP_ORIGIN!;
  const context = await browser.newContext({ locale: "zh-TW" });
  let id: string | undefined;
  try {
    await context.addCookies([{ name: sessionCookieName, value: session.accessToken, url: origin,
      secure: true, httpOnly: true, sameSite: "Strict" }]);
    const page = await context.newPage();
    await page.goto(`${origin}/student`);
    await page.getByLabel("專案名稱").fill("回應遺失前");
    const creating = page.waitForResponse((r) => new URL(r.url()).pathname === "/api/v1/projects" && r.request().method() === "POST");
    await page.getByRole("button", { name: "建立專案", exact: true }).click();
    id = (await (await creating).json()).id as string;
    await page.getByTestId("owned-project-list").getByRole("link", { name: "回應遺失前", exact: true }).click();
    let originalBody = "";
    let originalKey = "";
    await page.route(`**${endpoint(id)}`, async (route) => {
      if (route.request().method() !== "PATCH") return route.continue();
      originalBody = route.request().postData()!;
      originalKey = route.request().headers()["idempotency-key"];
      const response = await route.fetch();
      expect(response.status()).toBe(200);
      await route.abort("failed");
    }, { times: 1 });
    await region(page).getByRole("button", { name: "重新命名", exact: true }).click();
    await region(page).getByLabel("新專案名稱").fill("已提交但未收到");
    await region(page).getByRole("button", { name: "保存名稱", exact: true }).click();
    await expect(region(page).getByTestId("rename-status")).toContainText("未知");
    const before = (await control.query("SELECT title,row_version FROM app.projects WHERE id=$1", [id])).rows[0];
    expect(before).toEqual({ title: "已提交但未收到", row_version: 1 });
    const other = await context.newPage();
    await other.goto(`${origin}/student/projects/${id}`);
    await rename(other, id, "更晚的名稱");
    page.on("dialog", (dialog) => { void dialog.accept(); });
    await page.reload();
    await expect(region(page).getByTestId("rename-status")).toContainText("待確認");
    const request = page.waitForRequest((r) => r.method() === "PATCH" && new URL(r.url()).pathname === endpoint(id!));
    const response = patchResponse(page, id);
    await region(page).getByRole("button", { name: "以原操作重試改名" }).click();
    const replay = await request;
    expect(replay.headers()["idempotency-key"]).toBe(originalKey);
    expect(replay.headers()["if-match"]).toBe('"0"');
    expect(replay.headers()["idempotency-replay-only"]).toBe("true");
    expect(replay.postData()).toBe(originalBody);
    const replayResponse = await response;
    expect(replayResponse.status()).toBe(200);
    expect(await replayResponse.json()).toMatchObject({ outcome: "replayed",
      operation: { title: "已提交但未收到", row_version: 1 },
      current: { title: "更晚的名稱", row_version: 2 } });
    await expect(region(page).getByTestId("rename-status")).toContainText("原改名已確認");
    await expect(page.getByRole("heading", { name: "更晚的名稱", exact: true })).toBeVisible();
    expect((await control.query("SELECT title,row_version FROM app.projects WHERE id=$1", [id])).rows[0])
      .toEqual({ title: "更晚的名稱", row_version: 2 });
    console.log("RenameResponseLoss=commit1; newer_commit2; reload_original_intent_replay_only; DB_version2_no_rewrite");
  } finally {
    await context.close();
    if (id) {
      await control.query("DELETE FROM app.project_rename_receipts WHERE project_id=$1", [id]);
      await control.query("DELETE FROM app.project_create_idempotency WHERE project_id=$1", [id]);
      await control.query("DELETE FROM app.projects WHERE id=$1 AND owner_id=$2", [id, account.id]);
    }
    await control.query("DELETE FROM app.audit_events WHERE actor_aid IN (SELECT aid FROM app.audit_identity_map WHERE account_id=$1)", [account.id]);
    await control.query("DELETE FROM app.audit_identity_map WHERE account_id=$1", [account.id]);
    await control.query("DELETE FROM app.profiles WHERE id=$1", [account.id]);
    await control.query("DELETE FROM app.schools WHERE id=$1", [account.schoolId]);
    await deleteSyntheticAuthAccount(account);
    await control.end();
  }
});
