import { expect, test, type Page } from "@playwright/test";
import {
  createSyntheticAuthAccount, deleteSyntheticAuthAccount, loginSyntheticAccount, openControlPool,
} from "../support/real-auth-fixture.ts";
import { sessionCookieName } from "../../apps/web/src/server/auth-principal.ts";

test.use({ actionTimeout: 15_000 });

test("T052 真 Next HTTPS：建立→檢查→A/B保存確認→讀回→修改失效與授權隱藏", async ({ browser }) => {
  test.setTimeout(300_000);
  const control = openControlPool();
  const owner = await createSyntheticAuthAccount(control, "FlowBrowser");
  const other = await createSyntheticAuthAccount(control, "FlowBrowserOther");
  // 合成學生 session setup；不是學生產品登入／登入碼 E2E。
  const session = await loginSyntheticAccount(owner);
  const origin = process.env.APP_PLANET_APP_ORIGIN!;
  const context = await browser.newContext({ locale: "zh-TW" });
  let projectId: string | undefined;
  const check = (page: Page) => page.getByTestId("creation-flow-check");
  const formal = (page: Page) => page.getByRole("region", { name: "正式需求與 A/B 分類", exact: true });
  const save = async (page: Page) => {
    const saved = page.waitForResponse((response) =>
      new URL(response.url()).pathname === `/api/v1/projects/${projectId}/requirements`
      && response.request().method() === "PUT");
    await formal(page).getByRole("button", { name: "保存正式需求", exact: true }).click();
    expect((await saved).status()).toBe(200);
    await expect(formal(page).getByTestId("formal-operation-status")).toContainText("正式需求已保存");
  };
  const versions = async () => (await control.query(
    "SELECT stage,row_version,requirements_revision FROM app.projects WHERE id=$1", [projectId])).rows[0];
  try {
    await context.addCookies([{ name: sessionCookieName, value: session.accessToken, url: origin,
      httpOnly: true, secure: true, sameSite: "Strict" }]);
    const page = await context.newPage();
    await page.goto(`${origin}/student`);
    await page.getByLabel("專案名稱").fill("目標階段檢查作品");
    const created = page.waitForResponse((r) =>
      new URL(r.url()).pathname === "/api/v1/projects" && r.request().method() === "POST");
    await page.getByRole("button", { name: "建立專案", exact: true }).click();
    const response = await created;
    expect(response.status()).toBe(201);
    projectId = (await response.json()).id as string;
    const base = `${origin}/student/projects/${projectId}`;
    await page.getByTestId("owned-project-list").getByRole("link", { name: "目標階段檢查作品", exact: true }).click();
    await expect(check(page)).toBeVisible();
    await expect(check(page).getByTestId("creation-flow-classification")).toContainText("尚無正式需求");
    const initial = await versions();
    // 原生連結以鍵盤選目標，保證每次重新讀取，並沿用共用 anchor guard。
    await check(page).getByRole("link", { name: "檢查 Final Pack", exact: true }).press("Enter");
    await expect(page).toHaveURL(`${base}?requested_stage=Final%20Pack`);
    await expect(check(page).getByTestId("creation-flow-prerequisites").getByRole("listitem")).toHaveCount(8);
    await expect(check(page)).toContainText("本次檢查目標：Final Pack");
    expect(await versions()).toEqual(initial);
    await check(page).getByRole("link", { name: "前往 A/B 補齊正式需求與分類確認" }).press("Enter");
    await formal(page).getByLabel("正式需求說明").fill("從檢查入口保存的靜態作品");
    await save(page);
    await formal(page).getByLabel("正式 A/B 分類", { exact: true }).selectOption("A");
    await formal(page).getByLabel("需要識別訪客身分嗎", { exact: true }).selectOption("false");
    const confirmed = page.waitForResponse((r) =>
      new URL(r.url()).pathname === `/api/v1/projects/${projectId}/classification/confirmation`);
    await formal(page).getByRole("button", { name: "明確確認正式分類", exact: true }).press("Enter");
    expect((await confirmed).status()).toBe(200);
    await expect(formal(page).getByTestId("formal-classification-current")).toHaveAttribute("data-state", "confirmed");
    await page.getByRole("link", { name: "回到九階段總覽" }).click();
    await expect(check(page).getByTestId("creation-flow-classification")).toContainText("有效的學生 A");
    await expect(check(page).getByTestId("creation-flow-work-scope")).toContainText("在本次評估支援範圍內");
    await expect(check(page)).toContainText("不是老師或管理員的人工批准");
    const confirmedVersions = await versions();
    expect(confirmedVersions).toEqual({ stage: "點子", row_version: 2, requirements_revision: 1 });
    await check(page).getByRole("link", { name: "檢查 Constitution", exact: true }).press("Enter");
    await expect(check(page).getByTestId("creation-flow-prerequisites").getByRole("listitem")).toHaveCount(4);
    await check(page).getByRole("link", { name: "重新檢查目標階段" }).click();
    await expect(check(page)).toContainText("本次檢查目標：Constitution");
    expect(await versions()).toEqual(confirmedVersions);

    await check(page).getByRole("link", { name: "前往 A/B 補齊正式需求與分類確認" }).click();
    await formal(page).getByLabel("正式需求說明").fill("修改後的正式需求");
    await save(page);
    // 未保存正式需求與自由草稿的共用防護仍然攔截返回補齊流程。
    await formal(page).getByLabel("正式需求說明").fill("不應遺失的本地修改");
    await page.getByRole("link", { name: "回到九階段總覽" }).press("Enter");
    await expect(page.getByTestId("unsaved-changes-dialog")).toBeVisible();
    await page.getByTestId("unsaved-changes-dialog").getByRole("button", { name: "留在目前頁面" }).click();
    await expect(formal(page).getByLabel("正式需求說明")).toHaveValue("不應遺失的本地修改");
    await formal(page).getByLabel("正式需求說明").fill("修改後的正式需求");
    await page.getByRole("link", { name: "回到九階段總覽" }).click();
    await expect(check(page).getByTestId("creation-flow-classification")).toContainText("先前確認不再有效");
    await expect(check(page).getByTestId("creation-flow-work-scope")).toContainText("尚不能判斷");
    const modified = await versions();
    expect(modified).toEqual({ stage: "點子", row_version: 3, requirements_revision: 2 });
    await check(page).getByRole("link", { name: "編輯目標階段：點子" }).click();
    await page.getByLabel("階段草稿文字").fill("這只是已保存草稿");
    await page.getByRole("button", { name: "保存", exact: true }).click();
    await expect(page.getByText("已確認版本 0。", { exact: true })).toBeVisible();
    await page.getByRole("link", { name: "回到九階段總覽" }).click();
    await expect(check(page).getByTestId("creation-flow-drafts")).toContainText("已保存的學生輸入草稿");
    await expect(check(page)).toContainText("沒有提供學生階段確認");
    expect(await versions()).toEqual(modified);

    await check(page).getByRole("link", { name: "前往 A/B 補齊正式需求與分類確認" }).click();
    await formal(page).getByLabel("作品執行需求", { exact: true }).selectOption("restricted_server");
    await save(page);
    await formal(page).getByLabel("正式 A/B 分類", { exact: true }).selectOption("B");
    await formal(page).getByLabel("需要識別訪客身分嗎", { exact: true }).selectOption("false");
    const unsupported = page.waitForResponse((r) =>
      new URL(r.url()).pathname === `/api/v1/projects/${projectId}/classification/confirmation`);
    await formal(page).getByRole("button", { name: "明確確認正式分類", exact: true }).click();
    expect((await unsupported).status()).toBe(422);
    await page.getByRole("link", { name: "回到九階段總覽" }).click();
    await expect(check(page).getByTestId("creation-flow-work-scope")).toContainText("這不表示需求已獲支援");
    const unsupportedVersions = await versions();
    expect(unsupportedVersions).toEqual({ stage: "點子", row_version: 4, requirements_revision: 3 });
    await page.goto(`${base}?requested_stage=Final%20Pack&approved=true`);
    await expect(check(page).getByTestId("creation-flow-error")).toContainText("不能附帶角色");
    await expect(check(page).getByTestId("creation-flow-result")).toHaveCount(0);
    await page.goto(`${base}?requested_stage=wrong`);
    await expect(check(page).getByTestId("creation-flow-error")).toBeVisible();
    await check(page).getByRole("link", { name: "檢查 A/B", exact: true }).press("Enter");
    await expect(check(page)).toContainText("本次檢查目標：A/B");
    expect(await versions()).toEqual(unsupportedVersions);

    try {
      await control.query("REVOKE SELECT ON app.stage_records FROM authenticated");
      await page.reload();
      await expect(page.getByTestId("project-workspace-closed")).toContainText("受保護資料已隱藏");
      await expect(page.getByTestId("creation-flow-result")).toHaveCount(0);
    } finally { await control.query("GRANT SELECT ON app.stage_records TO authenticated"); }
    await page.reload();
    await expect(check(page)).toBeVisible();
    await expect(check(page).getByTestId("creation-flow-classification")).toContainText("沒有有效");
    expect(await versions()).toEqual(unsupportedVersions);
    await control.query("UPDATE app.profiles SET status='disabled' WHERE id=$1", [owner.id]);
    await page.reload();
    await expect(page.getByTestId("project-workspace-closed")).toBeVisible();
    await expect(page.getByTestId("creation-flow-result")).toHaveCount(0);
    await control.query("UPDATE app.profiles SET status='approved' WHERE id=$1", [owner.id]);
    const foreign = await loginSyntheticAccount(other);
    await context.addCookies([{ name: sessionCookieName, value: foreign.accessToken, url: origin,
      httpOnly: true, secure: true, sameSite: "Strict" }]);
    await page.goto(base);
    await expect(page.getByTestId("project-workspace-closed")).toBeVisible();
    await expect(page.getByTestId("creation-flow-result")).toHaveCount(0);
    await context.clearCookies();
    await page.goto(base);
    await expect(page.getByTestId("project-workspace-closed")).toContainText("尚未登入");
    expect(await versions()).toEqual(unsupportedVersions);
    console.log("CreationFlowHTTPS=UI_create_save_confirm_modify; targets_FinalPack_Constitution_AB; readonly_versions_verified; guards_and_access_closed");
  } finally {
    await context.close();
    if (projectId) {
      await control.query(`UPDATE app.projects SET classification_state='unconfirmed',tier=NULL,
        needs_visitor_identity=NULL,current_confirmation_id=NULL WHERE id=$1`, [projectId]);
      for (const table of ["stage_draft_confirmations", "stage_draft_idempotency", "stage_records",
        "project_classification_idempotency", "project_classification_confirmations", "project_requirements",
        "project_create_idempotency", "projects"]) {
        await control.query(`DELETE FROM app.${table} WHERE ${table === "projects" ? "id" : "project_id"}=$1`, [projectId]);
      }
    }
    for (const account of [owner, other]) {
      await control.query("DELETE FROM app.profiles WHERE id=$1", [account.id]);
      await control.query("DELETE FROM app.schools WHERE id=$1", [account.schoolId]);
      await deleteSyntheticAuthAccount(account);
    }
    await control.end();
    console.log("CreationFlowHTTPSCleanup=owned synthetic rows and accounts removed");
  }
});
