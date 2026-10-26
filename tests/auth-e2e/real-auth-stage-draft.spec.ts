import { expect, test } from "@playwright/test";
import {
  createOwnedSyntheticProject,
  createSyntheticAuthAccount,
  deleteSyntheticAuthAccount,
  loginSyntheticAccount,
  openControlPool,
} from "../support/real-auth-fixture.ts";
import { sessionCookieName } from "../../apps/web/src/server/auth-principal.ts";

test("原生 Auth 登入後由真實頁面首建、更新、處理衝突並在失權後隱藏資料", async ({ browser }) => {
  test.setTimeout(180_000);
  const control = openControlPool();
  const account = await createSyntheticAuthAccount(control, "Browser");
  let projectId: string | null = null;
  const contexts: Awaited<ReturnType<typeof browser.newContext>>[] = [];
  try {
    projectId = await createOwnedSyntheticProject(account);
    const firstSession = await loginSyntheticAccount(account);
    const secondSession = await loginSyntheticAccount(account);
    const appOrigin = process.env.APP_PLANET_APP_ORIGIN;
    if (!appOrigin) throw new Error("隔離瀏覽器測試缺少本機 app origin。");

    const firstContext = await browser.newContext({ locale: "zh-TW" });
    const secondContext = await browser.newContext({ locale: "zh-TW" });
    contexts.push(firstContext, secondContext);
    await firstContext.addCookies([{
      name: sessionCookieName,
      value: firstSession.accessToken,
      url: appOrigin,
      httpOnly: true,
      secure: true,
      sameSite: "Strict",
    }]);
    await secondContext.addCookies([{
      name: sessionCookieName,
      value: secondSession.accessToken,
      url: appOrigin,
      httpOnly: true,
      secure: true,
      sameSite: "Strict",
    }]);

    const page = await firstContext.newPage();
    const otherPage = await secondContext.newPage();
    const editorUrl = `${appOrigin}/student/projects/${projectId}/stages/Specification`;
    await page.goto(editorUrl);
    await expect(page.getByText("伺服器已驗證登入")).toBeVisible();
    await expect(page.getByLabel("階段草稿文字")).toBeVisible();
    await expect(page.getByTestId("confirmed-server-draft")).toHaveCount(0);
    await expect(page.getByText("未保存", { exact: true })).toBeVisible();

    await page.getByLabel("階段草稿文字").fill("瀏覽器首建草稿");
    await page.getByRole("button", { name: "保存", exact: true }).click();
    await expect(page.getByText("已確認版本 0。")).toBeVisible();
    await expect(page.getByTestId("confirmed-server-draft")).toContainText("伺服器版本 0：瀏覽器首建草稿");

    await page.getByLabel("階段草稿文字").fill("瀏覽器更新草稿");
    await page.getByRole("button", { name: "保存", exact: true }).click();
    await expect(page.getByText("已確認版本 1。")).toBeVisible();

    await otherPage.goto(editorUrl, { waitUntil: "networkidle" });
    await expect(otherPage.getByLabel("階段草稿文字")).toBeVisible();
    await otherPage.getByLabel("階段草稿文字").fill("另一個有效 session 的更新");
    const otherSave = otherPage.getByRole("button", { name: "保存", exact: true });
    await expect(otherPage.getByLabel("階段草稿文字")).toHaveValue("另一個有效 session 的更新");
    await expect(otherPage.locator("#operation-status")).toHaveAttribute("data-code", "unsaved");
    await expect(otherSave).toBeEnabled();
    await otherSave.click();
    await expect(otherPage.getByText("已確認版本 2。")).toBeVisible();

    await page.getByLabel("階段草稿文字").fill("衝突後保留的本地內容");
    await page.getByRole("button", { name: "保存", exact: true }).click();
    await expect(page.getByRole("button", { name: "查看版本衝突說明" })).toBeVisible();
    await page.getByRole("button", { name: "查看版本衝突說明" }).click();
    await expect(page.getByRole("dialog")).toContainText("伺服器目前是版本 2");
    await page.getByRole("button", { name: "保留本地，採用目前版本作為更新基準" }).click();
    await page.getByRole("button", { name: "保存", exact: true }).click();
    await expect(page.getByText("已確認版本 3。")).toBeVisible();
    await expect(page.getByLabel("階段草稿文字")).toHaveValue("衝突後保留的本地內容");

    await control.query("UPDATE app.profiles SET status='disabled' WHERE id=$1", [account.id]);
    await page.getByLabel("階段草稿文字").fill("失權後的本地草稿");
    await page.getByRole("button", { name: "保存", exact: true }).click();
    await expect(page.getByText("沒有權限", { exact: true })).toBeVisible();
    await expect(page.getByLabel("階段草稿文字")).toHaveCount(0);
    await expect(page.getByTestId("confirmed-server-draft")).toHaveCount(0);
    await control.query("UPDATE app.profiles SET status='approved' WHERE id=$1", [account.id]);
  } finally {
    for (const context of contexts) await context.close();
    if (projectId) {
      await control.query("DELETE FROM app.stage_draft_idempotency WHERE project_id=$1", [projectId]);
      await control.query("DELETE FROM app.stage_records WHERE project_id=$1", [projectId]);
      await control.query("DELETE FROM app.project_create_idempotency WHERE project_id=$1", [projectId]);
      await control.query("DELETE FROM app.projects WHERE id=$1", [projectId]);
    }
    await control.query("DELETE FROM app.profiles WHERE id=$1", [account.id]);
    await control.query("DELETE FROM app.schools WHERE id=$1", [account.schoolId]);
    await deleteSyntheticAuthAccount(account);
    await control.end();
  }
});
