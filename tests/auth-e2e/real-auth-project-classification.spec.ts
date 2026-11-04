import { expect, test, type Page } from "@playwright/test";
import {
  createSyntheticAuthAccount, deleteSyntheticAuthAccount, loginSyntheticAccount, openControlPool,
} from "../support/real-auth-fixture.ts";
import { sessionCookieName } from "../../apps/web/src/server/auth-principal.ts";

test.use({ actionTimeout: 15_000 });

test("T051 非同步真 GET：保存後不倒退、採用期間續編不遺失與雙資源 guard", async ({ browser }) => {
  test.setTimeout(180_000);
  const control = openControlPool();
  const account = await createSyntheticAuthAccount(control, "FormalReadRace");
  // 沿用隔離合成學生 session setup，不是學生產品登入／登入碼 E2E。
  const session = await loginSyntheticAccount(account);
  const origin = process.env.APP_PLANET_APP_ORIGIN!;
  const context = await browser.newContext({ locale: "zh-TW" });
  const ids: string[] = [];
  const releases: (() => void)[] = [];
  const formal = (page: Page) => page.getByRole("region", { name: "正式需求與 A/B 分類", exact: true });
  const save = async (page: Page, id: string) => {
    const response = page.waitForResponse((r) => new URL(r.url()).pathname === `/api/v1/projects/${id}/requirements`
      && r.request().method() === "PUT");
    await formal(page).getByRole("button", { name: "保存正式需求", exact: true }).click();
    expect((await response).status()).toBe(200);
    await expect(formal(page).getByTestId("formal-operation-status")).toContainText("正式需求已保存");
  };
  const delayRead = async (page: Page, id: string) => {
    let fetched!: () => void;
    let release!: () => void;
    const captured = new Promise<void>((resolve) => { fetched = resolve; });
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    releases.push(release);
    await page.route(`**/api/v1/projects/${id}/requirements`, async (route) => {
      expect(route.request().method()).toBe("GET");
      const response = await route.fetch();
      expect(response.status()).toBe(200);
      fetched();
      await barrier;
      await route.fulfill({ response });
    }, { times: 1 });
    return { captured, async finish() {
      const response = page.waitForResponse((r) => new URL(r.url()).pathname === `/api/v1/projects/${id}/requirements`
        && r.request().method() === "GET");
      release();
      await (await response).finished();
      await page.evaluate(() => new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    } };
  };
  try {
    await context.addCookies([{ name: sessionCookieName, value: session.accessToken, url: origin,
      httpOnly: true, secure: true, sameSite: "Strict" }]);
    const page = await context.newPage();
    await page.goto(`${origin}/student`);
    await page.getByLabel("專案名稱").fill("正式需求讀取競態");
    const created = page.waitForResponse((r) => new URL(r.url()).pathname === "/api/v1/projects"
      && r.request().method() === "POST");
    await page.getByRole("button", { name: "建立專案", exact: true }).click();
    const response = await created;
    expect(response.status()).toBe(201);
    const id = (await response.json()).id as string;
    ids.push(id);
    await page.getByTestId("owned-project-list").getByRole("link", { name: "正式需求讀取競態", exact: true }).click();
    await page.getByTestId("stage-row-2").getByRole("link", { name: "開啟 A/B 草稿", exact: true }).click();
    const editor = formal(page).getByLabel("正式需求說明");
    const summary = formal(page).getByTestId("formal-saved-summary");
    await editor.fill("old");
    await save(page, id);
    await expect(summary).toContainText("專案版本 1");

    const oldRead = await delayRead(page, id);
    await formal(page).getByRole("button", { name: "重新讀取需求與分類（保留本地編輯）" }).click();
    await oldRead.captured;
    await expect(formal(page).getByText("正在讀取當前需求與分類；仍可繼續編輯，尚未採用回應。")).toBeVisible();
    await expect(formal(page).getByRole("button", { name: "重新讀取需求與分類（保留本地編輯）" })).toBeDisabled();
    await editor.fill("new");
    await save(page, id);
    await oldRead.finish();
    await expect(summary).toContainText("專案版本 2");
    await expect(summary).toContainText("已保存原文：new");
    await expect(editor).toHaveValue("new");
    await expect(formal(page).getByText("本地需求尚未保存，不能確認分類。")).toHaveCount(0);
    await expect(formal(page).getByTestId("formal-operation-status")).toContainText("正式需求已保存");
    await page.getByRole("link", { name: "畫面設計", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/student/projects/${id}/design$`));
    await expect(page.getByTestId("unsaved-changes-dialog")).toHaveCount(0);
    await page.goto(`${origin}/student/projects/${id}/stages/A%2FB`);

    const otherPage = await context.newPage();
    await otherPage.goto(`${origin}/student/projects/${id}/stages/A%2FB`);
    await formal(otherPage).getByLabel("正式需求說明").fill("另一分頁保存的版本");
    await save(otherPage, id);
    await otherPage.close();
    await editor.fill("衝突的本地內容");
    const conflict = page.waitForResponse((r) => r.request().method() === "PUT"
      && new URL(r.url()).pathname === `/api/v1/projects/${id}/requirements`);
    await formal(page).getByRole("button", { name: "保存正式需求", exact: true }).click();
    expect((await conflict).status()).toBe(409);
    const adopt = formal(page).getByRole("button", { name: "放棄本地需求並採用當前版本" });
    const adopting = await delayRead(page, id);
    await adopt.click();
    await adopting.captured;
    await expect(adopt).toBeDisabled();
    await editor.fill("採用等待期間的新輸入");
    await adopting.finish();
    await expect(editor).toHaveValue("採用等待期間的新輸入");
    await expect(summary).toContainText("專案版本 3");
    await expect(formal(page).getByTestId("formal-operation-status")).toContainText("新輸入已保留");
    await expect(adopt).toBeEnabled();
    await page.getByLabel("階段草稿文字").fill("獨立草稿仍需防護");
    await page.getByRole("link", { name: "畫面設計", exact: true }).click();
    await expect(page.getByTestId("unsaved-changes-dialog")).toBeVisible();
    await page.getByTestId("unsaved-changes-dialog").getByRole("button", { name: "留在目前頁面" }).click();
    await adopt.click();
    await expect(editor).toHaveValue("另一分頁保存的版本");
    await expect(formal(page).getByText("本地需求尚未保存，不能確認分類。")).toHaveCount(0);
    await page.getByRole("link", { name: "畫面設計", exact: true }).click();
    await expect(page.getByTestId("unsaved-changes-dialog")).toBeVisible();
    await page.getByTestId("unsaved-changes-dialog").getByRole("button", { name: "留在目前頁面" }).click();
    await expect(page.getByLabel("階段草稿文字")).toHaveValue("獨立草稿仍需防護");
    expect((await control.query(
      "SELECT requirements_revision,row_version,stage FROM app.projects WHERE id=$1", [id])).rows[0])
      .toEqual({ requirements_revision: 3, row_version: 3, stage: "點子" });
    console.log("FormalReadRace=real_delayed_GET; UI_saves; version3; continued_input_preserved; clean_and_draft_guards_verified");
  } finally {
    for (const release of releases) release();
    await context.close();
    if (ids.length) {
      for (const table of ["project_classification_idempotency", "project_requirements",
        "project_create_idempotency", "projects"]) {
        await control.query(`DELETE FROM app.${table} WHERE ${table === "projects" ? "id" : "project_id"}=ANY($1::uuid[])`, [ids]);
      }
    }
    await control.query("DELETE FROM app.profiles WHERE id=$1", [account.id]);
    await control.query("DELETE FROM app.schools WHERE id=$1", [account.schoolId]);
    await deleteSyntheticAuthAccount(account);
    await control.end();
    console.log("FormalReadRaceCleanup=verified owned contexts and synthetic data removed");
  }
});

test("T051 產品正式需求 A／B、reload、失效、衝突、response-loss、原鍵重試及共同 guard", async ({ browser }) => {
  test.setTimeout(360_000);
  const control = openControlPool();
  const account = await createSyntheticAuthAccount(control, "FormalBrowser");
  const other = await createSyntheticAuthAccount(control, "FormalBrowserOther");
  const session = await loginSyntheticAccount(account);
  const otherSession = await loginSyntheticAccount(other);
  const origin = process.env.APP_PLANET_APP_ORIGIN!;
  const context = await browser.newContext({ locale: "zh-TW" });
  const otherContext = await browser.newContext({ locale: "zh-TW" });
  const ids: string[] = [];
  const formal = (page: Page) => page.getByRole("region", { name: "正式需求與 A/B 分類", exact: true });
  const create = async (page: Page, title: string) => {
    await page.goto(`${origin}/student`);
    await page.getByLabel("專案名稱").fill(title);
    await page.getByLabel("建立時的 A/B 偏好（不是正式分類）").selectOption("A");
    const response = page.waitForResponse((r) => new URL(r.url()).pathname === "/api/v1/projects" &&
      r.request().method() === "POST");
    await page.getByRole("button", { name: "建立專案", exact: true }).click();
    const created = await response;
    expect(created.status()).toBe(201);
    const id = (await created.json()).id as string;
    ids.push(id);
    await page.getByTestId("owned-project-list").getByRole("link", { name: title, exact: true }).click();
    await page.getByTestId("stage-row-2").getByRole("link", { name: "開啟 A/B 草稿", exact: true }).click();
    await expect(formal(page)).toBeVisible();
    return id;
  };
  const save = async (page: Page, id: string) => {
    const response = page.waitForResponse((r) => new URL(r.url()).pathname === `/api/v1/projects/${id}/requirements` &&
      r.request().method() === "PUT");
    await formal(page).getByRole("button", { name: "保存正式需求", exact: true }).click();
    return response;
  };
  const confirm = async (page: Page, id: string, keyboard = false) => {
    const response = page.waitForResponse((r) =>
      new URL(r.url()).pathname === `/api/v1/projects/${id}/classification/confirmation`);
    const button = formal(page).getByRole("button", { name: "明確確認正式分類", exact: true });
    if (keyboard) await button.press("Enter");
    else await button.click();
    return response;
  };
  const row = async (id: string) => (await control.query(
    `SELECT requirements_revision,row_version,classification_state,tier,needs_visitor_identity,
      current_confirmation_id,stage FROM app.projects WHERE id=$1`, [id])).rows[0];
  const evidence = async (id: string) => (await control.query(
    "SELECT * FROM app.project_classification_confirmations WHERE project_id=$1 ORDER BY confirmed_at,id", [id])).rows;
  try {
    await context.addCookies([{ name: sessionCookieName, value: session.accessToken, url: origin,
      httpOnly: true, secure: true, sameSite: "Strict" }]);
    const page = await context.newPage();
    const id = await create(page, "正式需求 A 畫面驗收");
    await expect(formal(page).getByTestId("formal-classification-current")).toContainText("尚無正式需求");
    await expect(formal(page).getByRole("button", { name: "明確確認正式分類", exact: true })).toBeDisabled();
    await formal(page).getByLabel("正式需求說明").fill("  A 畫面原文 café e\u0301  ");
    await formal(page).getByLabel("作品執行需求", { exact: true }).selectOption("static");
    await formal(page).getByLabel("作品執行時需要 AI", { exact: true }).selectOption("false");
    expect((await save(page, id)).status()).toBe(200);
    await formal(page).getByLabel("正式 A/B 分類", { exact: true }).selectOption("A");
    // visitor 未明選不能確認；不是 false 預設。
    await expect(formal(page).getByRole("button", { name: "明確確認正式分類", exact: true })).toBeDisabled();
    await formal(page).getByLabel("需要識別訪客身分嗎", { exact: true }).selectOption("false");
    expect((await confirm(page, id, true)).status()).toBe(200);
    await expect(formal(page).getByTestId("formal-classification-current")).toHaveAttribute("data-state", "confirmed");
    expect(await row(id)).toMatchObject({ row_version: 2, requirements_revision: 1, tier: "A",
      needs_visitor_identity: false, stage: "點子" });
    const originalEvidence = await evidence(id);
    expect(originalEvidence).toHaveLength(1);
    expect(originalEvidence[0].confirmed_by).toBe(account.id);
    await page.reload();
    await expect(formal(page).getByLabel("正式需求說明")).toHaveValue("  A 畫面原文 café e\u0301  ");
    await expect(formal(page).getByTestId("formal-classification-current")).toHaveAttribute("data-state", "confirmed");

    await formal(page).getByLabel("正式需求說明").fill("A 畫面第二版");
    expect((await save(page, id)).status()).toBe(200);
    await expect(formal(page).getByTestId("formal-classification-current")).toContainText("已失效");
    expect(await row(id)).toMatchObject({ row_version: 3, requirements_revision: 2, current_confirmation_id: null });
    await formal(page).getByLabel("正式 A/B 分類", { exact: true }).selectOption("A");
    await formal(page).getByLabel("需要識別訪客身分嗎", { exact: true }).selectOption("false");
    expect((await confirm(page, id)).status()).toBe(200);
    const secondEvidence = await evidence(id);
    expect(secondEvidence).toHaveLength(2);

    // 真 response-loss：Next 已提交，丟棄傳輸回應；另分頁修改後以原鍵重試。
    const secondPage = await context.newPage();
    await secondPage.goto(`${origin}/student/projects/${id}/stages/A%2FB`);
    await expect(formal(secondPage)).toBeVisible();
    await formal(page).getByLabel("正式 A/B 分類", { exact: true }).selectOption("A");
    type RequestSnapshot = { key: string | undefined; body: string | null; version: string | undefined };
    let originalRequest: RequestSnapshot | null = null;
    let lostStatus: number | null = null;
    await page.route(`**/api/v1/projects/${id}/classification/confirmation`, async (route) => {
      const response = await route.fetch();
      lostStatus = response.status();
      originalRequest = { key: route.request().headers()["idempotency-key"],
        body: route.request().postData(), version: route.request().headers()["if-match"] };
      await route.abort("connectionreset");
    }, { times: 1 });
    await formal(page).getByRole("button", { name: "明確確認正式分類", exact: true }).click();
    await expect(formal(page).getByTestId("formal-operation-status")).toContainText("結果尚待確認");
    await expect(formal(page).getByTestId("formal-classification-current")).toHaveAttribute("data-state", "unknown");
    expect(lostStatus).toBe(200);
    expect(await evidence(id)).toHaveLength(3);
    // 第二分頁版本舊了，明確重新讀取後再保存。
    await formal(secondPage).getByRole("button", { name: "重新讀取需求與分類（保留本地編輯）" }).click();
    await expect(formal(secondPage).getByTestId("formal-saved-summary")).toContainText("專案版本 5");
    await formal(secondPage).getByLabel("正式需求說明").fill("確認回應遺失後的新需求");
    expect((await save(secondPage, id)).status()).toBe(200);
    const beforeReplay = await evidence(id);
    await secondPage.close();
    page.once("dialog", (dialog) => void dialog.accept());
    await page.reload();
    await expect(formal(page).getByRole("button", { name: "使用原操作鍵重試需求／分類" })).toBeVisible();
    let replayRequest: RequestSnapshot | null = null;
    page.on("request", (req) => {
      if (new URL(req.url()).pathname === `/api/v1/projects/${id}/classification/confirmation`) {
        replayRequest = { key: req.headers()["idempotency-key"], body: req.postData(), version: req.headers()["if-match"] };
      }
    });
    await formal(page).getByRole("button", { name: "使用原操作鍵重試需求／分類" }).click();
    await expect(formal(page).getByTestId("formal-operation-receipt")).toContainText("confirmed");
    expect(replayRequest).toEqual(originalRequest);
    await expect(formal(page).getByTestId("formal-classification-current")).toHaveAttribute("data-state", "unconfirmed");
    expect(await row(id)).toMatchObject({ row_version: 6, requirements_revision: 3, current_confirmation_id: null });
    expect(await evidence(id)).toEqual(beforeReplay);

    // 兩分頁 CAS 衝突不覆寫本地文字。
    const stalePage = await context.newPage();
    await stalePage.goto(`${origin}/student/projects/${id}/stages/A%2FB`);
    await expect(formal(stalePage)).toBeVisible();
    await formal(page).getByLabel("正式需求說明").fill("勝者需求");
    expect((await save(page, id)).status()).toBe(200);
    await formal(stalePage).getByLabel("正式需求說明").fill("stale 本地需求保留");
    expect((await save(stalePage, id)).status()).toBe(409);
    await expect(formal(stalePage).getByLabel("正式需求說明")).toHaveValue("stale 本地需求保留");
    await expect(formal(stalePage).getByRole("button", { name: "明確確認正式分類", exact: true })).toBeDisabled();
    expect((await row(id)).requirements_revision).toBe(4);
    stalePage.once("dialog", (dialog) => void dialog.accept());
    await stalePage.close();

    // 正式需求與階段草稿共用 guard；保存階段草稿不是正式需求。
    await formal(page).getByLabel("正式需求說明").fill("未保存的正式需求");
    await page.getByLabel("階段草稿文字").fill("獨立階段草稿");
    await page.getByRole("link", { name: "畫面設計", exact: true }).click();
    await expect(page.getByTestId("unsaved-changes-dialog")).toBeVisible();
    await page.getByTestId("unsaved-changes-dialog").getByRole("button", { name: "留在目前頁面" }).click();
    await expect(formal(page).getByLabel("正式需求說明")).toHaveValue("未保存的正式需求");
    await page.getByRole("button", { name: "保存", exact: true }).click();
    await expect(page.getByText("已確認版本 0。")).toBeVisible();
    expect((await control.query("SELECT description FROM app.project_requirements WHERE project_id=$1 AND revision=4", [id]))
      .rows[0].description).toBe("勝者需求");
    expect((await save(page, id)).status()).toBe(200);
    expect((await evidence(id)).slice(0, 1)).toEqual(originalEvidence);

    // 另一專案 B，偏好 A 必須 explicit_change；unsupported 不能默改。
    const b = await create(page, "正式需求 B 畫面驗收");
    await formal(page).getByLabel("正式需求說明").fill("B：使用平台資料服務的合成作品");
    await formal(page).getByLabel("作品執行需求", { exact: true }).selectOption("work_data_api");
    expect((await save(page, b)).status()).toBe(200);
    await formal(page).getByLabel("正式 A/B 分類", { exact: true }).selectOption("B");
    await formal(page).getByLabel("需要識別訪客身分嗎", { exact: true }).selectOption("false");
    await expect(formal(page).getByRole("button", { name: "明確確認正式分類", exact: true })).toBeDisabled();
    await formal(page).getByRole("checkbox", { name: /我明確確認/ }).check();
    expect((await confirm(page, b)).status()).toBe(200);
    await page.reload();
    await expect(formal(page).getByLabel("作品執行需求", { exact: true })).toHaveValue("work_data_api");
    await expect(formal(page).getByTestId("formal-classification-current")).toContainText("已確認：B");
    await expect(page.getByTestId("workspace-project-context")).toContainText("分類：已確認 B");
    expect((await evidence(b))[0]).toMatchObject({ requested_tier_at_confirmation: "A",
      requested_tier_acknowledgement: "explicit_change", confirmed_by: account.id });
    const screenshotPath = process.env.APP_PLANET_T051_EVIDENCE_DIR;
    if (screenshotPath) await page.screenshot({ path: `${screenshotPath}\\formal-b-confirmed.png`, fullPage: true });
    await formal(page).getByLabel("作品執行需求", { exact: true }).selectOption("restricted_server");
    await formal(page).getByLabel("作品執行時需要 AI", { exact: true }).selectOption("true");
    expect((await save(page, b)).status()).toBe(200);
    await formal(page).getByLabel("正式 A/B 分類", { exact: true }).selectOption("B");
    await formal(page).getByLabel("需要識別訪客身分嗎", { exact: true }).selectOption("true");
    await formal(page).getByRole("checkbox", { name: /我明確確認/ }).check();
    expect((await confirm(page, b)).status()).toBe(422);
    await expect(formal(page).getByTestId("formal-operation-status")).toContainText("首版作品不支援執行時 AI");
    await expect(formal(page).getByTestId("formal-operation-status")).toBeFocused();
    expect(await row(b)).toMatchObject({ classification_state: "unconfirmed", current_confirmation_id: null });
    expect((await control.query("SELECT runtime_needs,runtime_ai_required FROM app.project_requirements WHERE project_id=$1 AND revision=2", [b]))
      .rows[0]).toEqual({ runtime_needs: "restricted_server", runtime_ai_required: true });

    const beforeHydration = await browser.newContext({ javaScriptEnabled: false, locale: "zh-TW" });
    try {
      await beforeHydration.addCookies([{ name: sessionCookieName, value: session.accessToken, url: origin,
        httpOnly: true, secure: true, sameSite: "Strict" }]);
      const noScriptPage = await beforeHydration.newPage();
      let mutations = 0;
      noScriptPage.on("request", (req) => { if (["PUT", "POST"].includes(req.method())) mutations++; });
      await noScriptPage.goto(`${origin}/student/projects/${b}/stages/A%2FB`);
      await expect(noScriptPage.locator('button').filter({ hasText: /^保存正式需求$/ })).toBeDisabled();
      await expect(noScriptPage.locator('button').filter({ hasText: /^明確確認正式分類$/ })).toBeDisabled();
      expect(mutations).toBe(0);
    } finally { await beforeHydration.close(); }

    await otherContext.addCookies([{ name: sessionCookieName, value: otherSession.accessToken, url: origin,
      httpOnly: true, secure: true, sameSite: "Strict" }]);
    const otherPage = await otherContext.newPage();
    await otherPage.goto(`${origin}/student/projects/${b}/stages/A%2FB`);
    await expect(otherPage.getByTestId("project-workspace-closed")).toBeVisible();
    await expect(formal(otherPage)).toHaveCount(0);
    await control.query("UPDATE app.profiles SET status='disabled' WHERE id=$1", [account.id]);
    await formal(page).getByRole("button", { name: "重新讀取需求與分類（保留本地編輯）" }).click();
    await expect(formal(page)).toHaveCount(0);
    await expect(page.getByText("無法確認存取權限；受保護專案資料已隱藏。請重新載入確認。")).toBeVisible();
    expect(await row(id)).toMatchObject({ requirements_revision: 5, row_version: 8,
      classification_state: "unconfirmed", current_confirmation_id: null, stage: "點子" });
    expect(await row(b)).toMatchObject({ requirements_revision: 2, row_version: 3, stage: "點子" });
    console.log("FormalBrowserDBEvidence=A revision5 row_version8; B revision2 row_version3; current_null; immutable_history; same_key_body_versions; no_stage_advance");
  } finally {
    await context.close();
    await otherContext.close();
    if (ids.length) {
      await control.query(`UPDATE app.projects SET classification_state='unconfirmed',tier=NULL,
        needs_visitor_identity=NULL,current_confirmation_id=NULL WHERE id=ANY($1::uuid[])`, [ids]);
      for (const table of ["project_classification_idempotency", "project_classification_confirmations",
        "project_requirements", "stage_draft_confirmations", "stage_draft_idempotency", "stage_records",
        "project_create_idempotency", "projects"]) {
        await control.query(`DELETE FROM app.${table} WHERE ${table === "projects" ? "id" : "project_id"}=ANY($1::uuid[])`, [ids]);
      }
    }
    for (const a of [account, other]) {
      await control.query("DELETE FROM app.profiles WHERE id=$1", [a.id]);
      await control.query("DELETE FROM app.schools WHERE id=$1", [a.schoolId]);
      await deleteSyntheticAuthAccount(a);
    }
    await control.end();
    console.log("FormalBrowserCleanup=verified owned contexts and synthetic data removed");
  }
});
