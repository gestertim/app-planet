import { expect, test } from "@playwright/test";
import {
  createSyntheticAuthAccount,
  deleteSyntheticAuthAccount,
  loginSyntheticAccount,
  openControlPool,
} from "../support/real-auth-fixture.ts";
import { sessionCookieName } from "../../apps/web/src/server/auth-principal.ts";

test("真 Auth／Next HTTPS／DB：P-4 done 持久化、ETag 與 response-loss 後 reload", async ({ browser }) => {
  test.setTimeout(180_000);
  const control = openControlPool();
  const account = await createSyntheticAuthAccount(control, "TaskDoneBrowser");
  const session = await loginSyntheticAccount(account);
  const appOrigin = process.env.APP_PLANET_APP_ORIGIN;
  if (!appOrigin) throw new Error("隔離瀏覽器測試缺少本機 app origin。");
  const context = await browser.newContext({ locale: "zh-TW" });
  let projectId: string | null = null;
  let taskId: string | null = null;
  let lostResponseStatus: number | null = null;
  let lostResponseEtag: string | null = null;
  let taskPatchExecuteRevoked = false;
  try {
    await context.addCookies([{
      name: sessionCookieName,
      value: session.accessToken,
      url: appOrigin,
      httpOnly: true,
      secure: true,
      sameSite: "Strict",
    }]);
    const page = await context.newPage();
    await page.goto(`${appOrigin}/student`);
    await expect(page.getByText("目前沒有專案。")).toBeVisible();
    await page.getByLabel("專案名稱").fill("P-4 真實保存 browser 驗收");
    const createdResponsePromise = page.waitForResponse((response) =>
      new URL(response.url()).pathname === "/api/v1/projects" && response.request().method() === "POST");
    await page.getByRole("button", { name: "建立專案", exact: true }).click();
    const createdResponse = await createdResponsePromise;
    expect(createdResponse.status()).toBe(201);
    projectId = (await createdResponse.json()).id;
    if (typeof projectId !== "string") throw new Error("P-1 browser setup 未取得專案 ID。");

    await expect(page.getByTestId("owned-project-list").getByRole("link", {
      name: "P-4 真實保存 browser 驗收",
    })).toBeVisible();
    await page.getByTestId("owned-project-list").getByRole("link", {
      name: "P-4 真實保存 browser 驗收",
    }).click();
    await expect(page).toHaveURL(`${appOrigin}/student/projects/${projectId}`);
    await page.getByRole("link", { name: "創作計畫", exact: true }).click();
    await expect(page).toHaveURL(`${appOrigin}/student/projects/${projectId}/plan`);
    await page.reload();
    await expect(page.getByTestId("project-task-import")).toBeVisible();

    // B：任務只能由本人手動輸入並確認後經產品 API 建立；不使用任何 SQL fixture。
    await expect(page.getByText("目前沒有正式任務")).toBeVisible();
    await page.getByLabel(/任務清單（每行一項/).fill("browser 合成持久化任務\n第二項任務");
    await page.getByRole("button", { name: "預覽任務清單" }).click();
    await expect(page.getByTestId("project-task-import-preview").getByRole("listitem")).toHaveCount(2);
    await expect(page.getByText("預覽（尚未保存）")).toBeVisible();
    expect((await control.query("SELECT count(*)::int AS n FROM app.tasks WHERE project_id=$1", [projectId])).rows[0].n).toBe(0);
    await expect(page.getByRole("checkbox")).toHaveCount(0);

    // 第一次匯入：伺服器已提交但回應遺失；只能以原操作重送，不得重複建立。
    let lostImportStatus: number | null = null;
    await page.route("**/api/v1/projects/*/tasks", async (route) => {
      const response = await route.fetch();
      lostImportStatus = response.status();
      await route.abort("connectionreset");
    }, { times: 1 });
    await page.getByRole("button", { name: "確認並建立任務清單" }).click();
    await expect(page.getByTestId("project-task-import-status")).toContainText("匯入結果尚待確認");
    expect(lostImportStatus).toBe(201);
    await expect(page.getByRole("checkbox")).toHaveCount(0);
    expect((await control.query("SELECT count(*)::int AS n FROM app.tasks WHERE project_id=$1", [projectId])).rows[0].n).toBe(2);

    const replayPromise = page.waitForResponse((response) =>
      new URL(response.url()).pathname.endsWith(`/projects/${projectId}/tasks`) && response.request().method() === "POST");
    await page.getByRole("button", { name: "以原操作確認結果" }).click();
    expect((await replayPromise).status()).toBe(200);
    expect((await control.query("SELECT count(*)::int AS n FROM app.tasks WHERE project_id=$1", [projectId])).rows[0].n).toBe(2);
    expect((await control.query("SELECT count(*)::int AS n FROM app.project_task_imports WHERE project_id=$1", [projectId])).rows[0].n).toBe(1);
    expect(await page.evaluate(() => Object.keys(sessionStorage).filter((key) => key.startsWith("app-planet.task-import.")))).toEqual([]);

    const checkbox = page.getByRole("checkbox", { name: "完成任務：browser 合成持久化任務" });
    await expect(checkbox).toBeVisible();
    await expect(checkbox).not.toBeChecked();
    taskId = (await control.query(
      "SELECT id FROM app.tasks WHERE project_id=$1 AND title='browser 合成持久化任務'", [projectId])).rows[0].id;

    const firstSavePromise = page.waitForResponse((response) =>
      new URL(response.url()).pathname.endsWith(`/tasks/${taskId}`) &&
      response.request().method() === "PATCH");
    await checkbox.check();
    const firstSave = await firstSavePromise;
    expect(firstSave.status()).toBe(200);
    expect(firstSave.headers().etag).toBe('"1"');
    expect(await firstSave.json()).toMatchObject({
      id: taskId, project_id: projectId, done: true, row_version: 1,
    });
    await expect(page.getByTestId("project-task-save-status"))
      .toContainText("已保存你的任務勾選（版本 1）");
    expect((await control.query(
      "SELECT done,row_version FROM app.tasks WHERE id=$1 AND project_id=$2",
      [taskId, projectId],
    )).rows).toEqual([{ done: true, row_version: 1 }]);

    await page.reload();
    const reloadedCheckbox = page.getByRole("checkbox", { name: "完成任務：browser 合成持久化任務" });
    await expect(reloadedCheckbox).toBeChecked();

    await page.route("**/api/v1/projects/*/tasks/*", async (route) => {
      await control.query("UPDATE app.tasks SET done=true,row_version=2 WHERE id=$1", [taskId]);
      await route.continue();
    }, { times: 1 });
    const conflictResponsePromise = page.waitForResponse((response) =>
      new URL(response.url()).pathname.endsWith(`/tasks/${taskId}`) &&
      response.request().method() === "PATCH");
    await reloadedCheckbox.uncheck();
    const conflictResponse = await conflictResponsePromise;
    expect(conflictResponse.status()).toBe(409);
    await expect(reloadedCheckbox).not.toBeChecked();
    await expect(page.getByTestId("project-task-save-status"))
      .toContainText("版本已被其他操作更新");
    await expect(page.getByRole("button", { name: "重新載入並比對" })).toBeVisible();
    expect((await control.query(
      "SELECT done,row_version FROM app.tasks WHERE id=$1 AND project_id=$2",
      [taskId, projectId],
    )).rows).toEqual([{ done: true, row_version: 2 }]);
    await page.getByRole("button", { name: "重新載入並比對" }).click();
    await expect(reloadedCheckbox).toBeChecked();

    await page.route("**/api/v1/projects/*/tasks/*", async (route) => {
      const response = await route.fetch();
      lostResponseStatus = response.status();
      lostResponseEtag = response.headers().etag ?? null;
      await route.abort("connectionreset");
    }, { times: 1 });
    await reloadedCheckbox.uncheck();
    await expect(page.getByTestId("project-task-save-status"))
      .toContainText("連線中斷或結果未知");
    await expect(reloadedCheckbox).not.toBeChecked();
    await expect(page.getByTestId("project-task-save-status")).not.toContainText("已保存你的任務勾選");
    expect(lostResponseStatus).toBe(200);
    expect(lostResponseEtag).toBe('"3"');
    expect((await control.query(
      "SELECT done,row_version FROM app.tasks WHERE id=$1 AND project_id=$2",
      [taskId, projectId],
    )).rows).toEqual([{ done: false, row_version: 3 }]);

    await page.reload();
    const finalCheckbox = page.getByRole("checkbox", { name: "完成任務：browser 合成持久化任務" });
    await expect(finalCheckbox).not.toBeChecked();
    await expect(page.getByTestId("project-task-save-status")).toContainText("任務狀態來自伺服器已保存資料");
    expect((await control.query(
      "SELECT stage,row_version,classification_state,current_confirmation_id FROM app.projects WHERE id=$1",
      [projectId],
    )).rows).toEqual([{
      stage: "點子",
      row_version: 0,
      classification_state: "unconfirmed",
      current_confirmation_id: null,
    }]);
    expect((await control.query(
      "SELECT count(*)::int AS count FROM app.stage_records WHERE project_id=$1",
      [projectId],
    )).rows).toEqual([{ count: 0 }]);

      await page.route("**/api/v1/projects/*/tasks/*", async (route) => {
        await control.query(
          "REVOKE EXECUTE ON FUNCTION app.patch_owned_project_task_done(uuid,uuid,integer,boolean) FROM authenticated",
        );
        taskPatchExecuteRevoked = true;
        await route.continue();
      }, { times: 1 });
      const failedSavePromise = page.waitForResponse((response) =>
        new URL(response.url()).pathname.endsWith(`/tasks/${taskId}`) &&
        response.request().method() === "PATCH");
      await finalCheckbox.check();
      const failedSave = await failedSavePromise;
      expect(failedSave.status()).toBe(503);
      await expect(finalCheckbox).toBeChecked();
      await expect(page.getByTestId("project-task-save-status"))
        .toContainText("保存結果尚未確認");
      await expect(page.getByTestId("project-task-save-status")).not.toContainText("已保存你的任務勾選");
      await control.query(
        "GRANT EXECUTE ON FUNCTION app.patch_owned_project_task_done(uuid,uuid,integer,boolean) TO authenticated",
      );
      taskPatchExecuteRevoked = false;
      expect((await control.query(
        "SELECT done,row_version FROM app.tasks WHERE id=$1 AND project_id=$2",
        [taskId, projectId],
      )).rows).toEqual([{ done: false, row_version: 3 }]);
      await page.getByRole("button", { name: "重新載入並比對" }).click();
      await expect(finalCheckbox).not.toBeChecked();

      await page.route("**/api/v1/projects/*/tasks/*", async (route) => {
        await control.query("UPDATE app.profiles SET status='disabled' WHERE id=$1", [account.id]);
        await route.continue();
      }, { times: 1 });
      await finalCheckbox.check();
      await expect(page.getByText("無法確認存取權限；受保護專案資料已隱藏。請重新載入確認。")).toBeVisible();
      expect((await control.query(
        "SELECT done,row_version FROM app.tasks WHERE id=$1 AND project_id=$2",
        [taskId, projectId],
      )).rows).toEqual([{ done: false, row_version: 3 }]);
  } finally {
    if (taskPatchExecuteRevoked) {
      await control.query(
        "GRANT EXECUTE ON FUNCTION app.patch_owned_project_task_done(uuid,uuid,integer,boolean) TO authenticated",
      );
    }
    await context.close();
    if (projectId) {
      await control.query("DELETE FROM app.project_task_imports WHERE project_id=$1", [projectId]);
      await control.query("DELETE FROM app.tasks WHERE project_id=$1", [projectId]);
      await control.query("DELETE FROM app.project_create_idempotency WHERE project_id=$1", [projectId]);
      await control.query("DELETE FROM app.projects WHERE id=$1", [projectId]);
    }
    await control.query("DELETE FROM app.profiles WHERE id=$1", [account.id]);
    await control.query("DELETE FROM app.schools WHERE id=$1", [account.schoolId]);
    await deleteSyntheticAuthAccount(account);
    await control.end();
  }
});
