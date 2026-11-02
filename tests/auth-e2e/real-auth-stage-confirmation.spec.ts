import { expect, test } from "@playwright/test";
import {
  createSyntheticAuthAccount,
  deleteSyntheticAuthAccount,
  loginSyntheticAccount,
  openControlPool,
} from "../support/real-auth-fixture.ts";
import { sessionCookieName } from "../../apps/web/src/server/auth-principal.ts";

test("真 Auth／Next HTTPS／DB：保存→明確確認→reload→修改後失效，且無人工批准", async ({ browser }) => {
  test.setTimeout(240_000);
  const control = openControlPool();
  const account = await createSyntheticAuthAccount(control, "ConfirmBrowser");
  const session = await loginSyntheticAccount(account);
  const appOrigin = process.env.APP_PLANET_APP_ORIGIN;
  if (!appOrigin) throw new Error("隔離瀏覽器測試缺少本機 app origin。");
  const context = await browser.newContext({ locale: "zh-TW" });
  let projectId: string | null = null;
  const name = "階段確認 browser 驗收";
  const text = page_text();
  try {
    await context.addCookies([{
      name: sessionCookieName, value: session.accessToken, url: appOrigin,
      httpOnly: true, secure: true, sameSite: "Strict",
    }]);
    const page = await context.newPage();
    await page.goto(`${appOrigin}/student`);
    await page.getByLabel("專案名稱").fill(name);
    const created = page.waitForResponse((r) =>
      new URL(r.url()).pathname === "/api/v1/projects" && r.request().method() === "POST");
    await page.getByRole("button", { name: "建立專案", exact: true }).click();
    const createdResponse = await created;
    expect(createdResponse.status()).toBe(201);
    projectId = (await createdResponse.json()).id;
    await page.getByTestId("owned-project-list").getByRole("link", { name }).click();
    await page.getByTestId("stage-row-3")
      .getByRole("link", { name: "開啟 Specification 草稿", exact: true }).click();
    const editorUrl = `${appOrigin}/student/projects/${projectId}/stages/Specification`;
    await expect(page).toHaveURL(editorUrl);

    const headline = page.getByTestId("confirmation-headline");
    const confirmButton = page.getByTestId("confirm-saved-version");
    const editor = page.getByLabel("階段草稿文字");
    const save = page.getByRole("button", { name: "保存", exact: true });
    const countConfirmations = async () => (await control.query(
      "SELECT count(*)::int AS n FROM app.stage_draft_confirmations WHERE project_id=$1", [projectId])).rows[0].n;

    // 無已保存草稿：不能確認。
    await expect(headline).toHaveAttribute("data-state", "no_draft");
    await expect(confirmButton).toBeDisabled();
    await expect(page.getByTestId("manual-approval-status")).toContainText("尚未取得");

    // 未保存編輯：不能確認。
    await editor.fill(text.first);
    await expect(headline).toHaveAttribute("data-state", "dirty");
    await expect(confirmButton).toBeDisabled();
    expect(await countConfirmations()).toBe(0);

    await save.click();
    await expect(page.getByText("已確認版本 0。")).toBeVisible();
    await expect(headline).toHaveAttribute("data-state", "unconfirmed");
    await expect(confirmButton).toBeEnabled();

    // response-loss：伺服器已提交但回應遺失，不顯示已確認，只能原操作重送且不重複。
    let lostStatus: number | null = null;
    await page.route("**/api/v1/projects/*/stages/*/confirmation", async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      const response = await route.fetch();
      lostStatus = response.status();
      await route.abort("connectionreset");
    }, { times: 1 });
    await confirmButton.click();
    await expect(page.getByTestId("confirmation-unknown")).toBeVisible();
    expect(lostStatus).toBe(201);
    await expect(headline).not.toHaveAttribute("data-state", "confirmed_current");
    expect(await countConfirmations()).toBe(1);
    await page.getByTestId("retry-confirmation").click();
    await expect(headline).toHaveAttribute("data-state", "confirmed_current");
    expect(await countConfirmations()).toBe(1);
    await expect(page.getByTestId("confirmation-evidence")).toContainText("版本 0");

    // reload 後由伺服器重新判定。
    await page.reload();
    await expect(page.getByTestId("confirmation-headline")).toHaveAttribute("data-state", "confirmed_current");
    expect(await page.evaluate(() => [
      ...Object.keys(localStorage), ...Object.keys(sessionStorage)].filter((k) => /confirm/i.test(k)))).toEqual([]);

    // 修改後保存：確認失效，舊證據保留。
    await editor.fill(text.second);
    await save.click();
    await expect(page.getByText("已確認版本 1。")).toBeVisible();
    await expect(headline).toHaveAttribute("data-state", "confirmation_stale");
    await expect(headline).toContainText("不再有效");
    expect(await countConfirmations()).toBe(1);

    // 改回相同文字：不復活。
    await editor.fill(text.first);
    await save.click();
    await expect(page.getByText("已確認版本 2。")).toBeVisible();
    await expect(headline).toHaveAttribute("data-state", "confirmation_stale");
    expect(await countConfirmations()).toBe(1);

    // 409：另一來源先保存，確認舊版本被拒且保留本地編輯。
    await page.route("**/api/v1/projects/*/stages/*/confirmation", async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      await control.query(
        "UPDATE app.stage_records SET row_version=row_version+1 WHERE project_id=$1", [projectId]);
      await route.continue();
    }, { times: 1 });
    await confirmButton.click();
    await expect(page.getByTestId("confirmation-mismatch")).toBeVisible();
    await expect(editor).toHaveValue(text.first);
    expect(await countConfirmations()).toBe(1);

    const rows = (await control.query(
      "SELECT p.stage AS project_stage, (SELECT count(*)::int FROM app.tasks t WHERE t.project_id=p.id AND t.done) AS done FROM app.projects p WHERE p.id=$1",
      [projectId])).rows[0];
    expect(rows.done).toBe(0);

    // 失權後隱藏受保護內容與確認資料。
    await control.query("UPDATE app.profiles SET status='disabled' WHERE id=$1", [account.id]);
    await page.reload();
    await expect(page.getByTestId("stage-confirmation")).toHaveCount(0);
    await expect(page.getByTestId("confirmation-evidence")).toHaveCount(0);
    await control.query("UPDATE app.profiles SET status='approved' WHERE id=$1", [account.id]);
  } finally {
    await context.close();
    if (projectId) {
      await control.query("DELETE FROM app.stage_draft_confirmations WHERE project_id=$1", [projectId]);
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

function page_text() {
  return { first: "確認用合成草稿 A", second: "確認用合成草稿 B" };
}
