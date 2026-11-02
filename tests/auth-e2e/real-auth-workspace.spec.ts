import { expect, test } from "@playwright/test";
import {
  createSyntheticAuthAccount,
  deleteSyntheticAuthAccount,
  loginSyntheticAccount,
  openControlPool,
} from "../support/real-auth-fixture.ts";
import { sessionCookieName } from "../../apps/web/src/server/auth-principal.ts";

test("產品 logout＋測試 setup 重新驗證後恢復：真 Auth／Next HTTPS／DB 與跨帳號隔離", async ({ browser }) => {
  test.setTimeout(360_000);
  const control = openControlPool();
  const account = await createSyntheticAuthAccount(control, "WorkspaceRestore");
  const otherAccount = await createSyntheticAuthAccount(control, "WorkspaceOther");
  const initialSession = await loginSyntheticAccount(account);
  const appOrigin = process.env.APP_PLANET_APP_ORIGIN;
  if (!appOrigin) throw new Error("隔離瀏覽器測試缺少本機 app origin。");
  const context = await browser.newContext({ locale: "zh-TW" });
  const projectIds: string[] = [];
  let taskId: string | null = null;
  try {
    const setSession = async (token: string) => context.addCookies([{
      name: sessionCookieName,
      value: token,
      url: appOrigin,
      httpOnly: true,
      secure: true,
      sameSite: "Strict",
    }]);
    const createProject = async (page: import("@playwright/test").Page, title: string) => {
      await page.goto(`${appOrigin}/student`);
      await page.getByLabel("專案名稱").fill(title);
      const created = page.waitForResponse((response) =>
        new URL(response.url()).pathname === "/api/v1/projects" && response.request().method() === "POST");
      await page.getByRole("button", { name: "建立專案", exact: true }).click();
      const response = await created;
      expect(response.status()).toBe(201);
      const body: unknown = await response.json();
      if (typeof body !== "object" || body === null || !("id" in body) || typeof body.id !== "string") {
        throw new Error("產品建立專案回應缺少 ID。");
      }
      projectIds.push(body.id);
      return body.id;
    };

    await setSession(initialSession.accessToken);
    const page = await context.newPage();
    const firstProject = await createProject(page, "重新驗證恢復：藍圖專案");
    const secondProject = await createProject(page, "重新驗證恢復：計畫專案");

    await page.goto(`${appOrigin}/student/projects/${firstProject}/stages/Specification`);
    const editor = page.getByLabel("階段草稿文字");
    await editor.fill("logout 後應由同帳號重新讀回的草稿");
    await page.getByRole("button", { name: "保存", exact: true }).click();
    await expect(page.getByText("已確認版本 0。")).toBeVisible();
    await page.getByTestId("confirm-saved-version").click();
    await expect(page.getByTestId("confirmation-headline"))
      .toHaveAttribute("data-state", "confirmed_current");

    await page.goto(`${appOrigin}/student/projects/${secondProject}/plan`);
    await page.getByLabel(/任務清單（每行一項/).fill("重新驗證後保留的 P-4 任務\n第二項 P-4 任務");
    await page.getByRole("button", { name: "預覽任務清單" }).click();
    let lostImportStatus: number | null = null;
    await page.route(`**/api/v1/projects/${secondProject}/tasks`, async (route) => {
      const response = await route.fetch();
      lostImportStatus = response.status();
      await route.abort("connectionreset");
    }, { times: 1 });
    await page.getByRole("button", { name: "確認並建立任務清單" }).click();
    await expect(page.getByTestId("project-task-import-status")).toContainText("匯入結果尚待確認");
    expect(lostImportStatus).toBe(201);
    const pendingKey = await page.evaluate(() =>
      Object.keys(sessionStorage).find((key) => key.startsWith("app-planet.task-import.")) ?? null);
    expect(pendingKey).not.toBeNull();
    const pendingOperation = await page.evaluate((key) => sessionStorage.getItem(key!), pendingKey);
    expect(pendingOperation).toContain("重新驗證後保留的 P-4 任務");
    taskId = (await control.query(
      "SELECT id FROM app.tasks WHERE project_id=$1 AND title=$2",
      [secondProject, "重新驗證後保留的 P-4 任務"],
    )).rows[0]?.id as string | undefined ?? null;
    expect(taskId).toBeTruthy();

    // Reload restores the pending import while the P-4 task list loads from the server.
    await page.reload();
    await expect(page.getByTestId("project-task-import-pending"))
      .toContainText("重新驗證後保留的 P-4 任務");
    const taskCheckbox = page.getByRole("checkbox", { name: "完成任務：重新驗證後保留的 P-4 任務" });
    await expect(taskCheckbox).toBeVisible();
    let releaseTaskWrite!: () => void;
    const taskWriteGate = new Promise<void>((resolve) => { releaseTaskWrite = resolve; });
    await page.route(`**/api/v1/projects/${secondProject}/tasks/*`, async (route) => {
      if (route.request().method() === "PATCH") await taskWriteGate;
      await route.continue();
    }, { times: 1 });
    const taskWriteRequest = page.waitForRequest((request) =>
      new URL(request.url()).pathname.startsWith(`/api/v1/projects/${secondProject}/tasks/`) &&
      request.method() === "PATCH");
    await taskCheckbox.check();
    await taskWriteRequest;
    await expect(page.getByTestId("project-task-save-status")).toContainText("正在保存");
    const planUrl = page.url();
    const buildTab = page.getByRole("link", { name: "建立 App", exact: true });
    await buildTab.click();
    const firstGuard = page.getByTestId("unsaved-changes-dialog");
    await expect(firstGuard).toBeVisible();
    try {
      const heading = await firstGuard.getByRole("heading").textContent();
      if (heading === "正在保存") {
        await firstGuard.getByRole("button", { name: "保存完成後離開" }).click();
        releaseTaskWrite();
        await expect(page).toHaveURL(planUrl);
        await expect(page.getByText(/本頁另有 1 個/)).toBeVisible();
      } else {
        await firstGuard.getByRole("button", { name: "留在目前頁面" }).click();
        releaseTaskWrite();
      }
    } finally {
      releaseTaskWrite();
    }
    await expect(page.getByTestId("project-task-save-status")).toContainText("已保存你的任務勾選");
    await expect(page.getByTestId("project-task-import-pending"))
      .toContainText("重新驗證後保留的 P-4 任務");
    await buildTab.click();
    const importGuard = page.getByTestId("unsaved-changes-dialog");
    await expect(importGuard).toBeVisible();
    await importGuard.getByRole("button", { name: "留在目前頁面" }).click();
    await expect(page).toHaveURL(planUrl);

    const logoutResponse = page.waitForResponse((response) =>
      new URL(response.url()).pathname === "/api/v1/auth/logout" &&
      response.request().method() === "POST");
    page.once("dialog", (dialog) => void dialog.accept());
    await page.getByRole("button", { name: "登出", exact: true }).click();
    expect((await logoutResponse).ok()).toBe(true);
    await expect(page).toHaveURL(`${appOrigin}/`);

    await setSession(initialSession.accessToken);
    await page.goto(`${appOrigin}/student/projects/${firstProject}`);
    await expect(page.getByTestId("project-workspace-closed")).toBeVisible();
    const oldWriteStatus = await page.evaluate(async ({ projectId, id }) => {
      const response = await fetch(`/api/v1/projects/${projectId}/tasks/${id}`, {
        method: "PATCH",
        credentials: "same-origin",
        headers: { "content-type": "application/json", "if-match": '"0"' },
        body: JSON.stringify({ done: true }),
      });
      return response.status;
    }, { projectId: secondProject, id: taskId });
    expect([401, 403]).toContain(oldWriteStatus);
    expect((await control.query(
      "SELECT done,row_version FROM app.tasks WHERE id=$1 AND project_id=$2", [taskId, secondProject],
    )).rows).toEqual([{ done: true, row_version: 1 }]);

    const otherSession = await loginSyntheticAccount(otherAccount);
    await setSession(otherSession.accessToken);
    await page.goto(`${appOrigin}/student/projects/${secondProject}/plan`);
    await expect(page.getByTestId("project-workspace-closed")).toBeVisible();
    await expect(page.getByText("重新驗證後保留的 P-4 任務")).toHaveCount(0);
    const otherProject = await createProject(page, "另一帳號的隔離專案");
    await page.goto(`${appOrigin}/student/projects/${otherProject}/plan`);
    await expect(page.getByTestId("project-task-import")).toBeVisible();
    await expect(page.getByTestId("project-task-import-pending")).toHaveCount(0);
    await expect(page.getByLabel(/任務清單（每行一項/)).toHaveValue("");
    await expect(page.getByText("重新驗證後保留的 P-4 任務")).toHaveCount(0);

    const restoredSession = await loginSyntheticAccount(account);
    await setSession(restoredSession.accessToken);
    await page.goto(`${appOrigin}/student/projects/${firstProject}`);
    await expect(page.getByTestId("workspace-project-id")).toHaveText(firstProject);
    const specification = page.getByTestId("workspace-stage-Specification");
    await expect(specification).toContainText("logout 後應由同帳號重新讀回的草稿");
    await expect(specification).toContainText("學生確認目前有效");
    await expect(specification).toContainText("人工批准尚未取得／尚未開放");

    await page.goto(`${appOrigin}/student/projects/${secondProject}/plan`);
    await expect(page.getByTestId("project-task-import-pending"))
      .toContainText("重新驗證後保留的 P-4 任務");
    await page.getByRole("button", { name: "以原操作確認結果" }).click();
    const restoredTask = page.getByRole("checkbox", { name: "完成任務：重新驗證後保留的 P-4 任務" });
    await expect(restoredTask).toBeChecked();
    await page.reload();
    await expect(restoredTask).toBeChecked();

    expect((await control.query(
      "SELECT id,stage,classification_state,row_version FROM app.projects WHERE id=ANY($1::uuid[]) ORDER BY id",
      [[firstProject, secondProject, otherProject]],
    )).rows).toHaveLength(3);
    expect((await control.query(
      "SELECT stage,classification_state,row_version FROM app.projects WHERE id=ANY($1::uuid[]) ORDER BY id",
      [[firstProject, secondProject, otherProject]],
    )).rows).toEqual([
      { stage: "點子", classification_state: "unconfirmed", row_version: 0 },
      { stage: "點子", classification_state: "unconfirmed", row_version: 0 },
      { stage: "點子", classification_state: "unconfirmed", row_version: 0 },
    ]);
    expect((await control.query(
      "SELECT done,row_version FROM app.tasks WHERE id=$1 AND project_id=$2", [taskId, secondProject],
    )).rows).toEqual([{ done: true, row_version: 1 }]);
    expect((await control.query(
      "SELECT count(*)::int AS n FROM app.stage_records WHERE project_id=$1 AND stage='Specification' AND approved_by IS NULL AND approved_at IS NULL",
      [firstProject],
    )).rows).toEqual([{ n: 1 }]);
    expect((await control.query(
      "SELECT count(*)::int AS n FROM app.stage_draft_confirmations WHERE project_id=$1 AND stage='Specification'",
      [firstProject],
    )).rows).toEqual([{ n: 1 }]);
  } finally {
    await context.close();
    if (projectIds.length) {
      await control.query("DELETE FROM app.stage_draft_confirmations WHERE project_id=ANY($1::uuid[])", [projectIds]);
      await control.query("DELETE FROM app.stage_draft_idempotency WHERE project_id=ANY($1::uuid[])", [projectIds]);
      await control.query("DELETE FROM app.project_task_imports WHERE project_id=ANY($1::uuid[])", [projectIds]);
      await control.query("DELETE FROM app.tasks WHERE project_id=ANY($1::uuid[])", [projectIds]);
      await control.query("DELETE FROM app.stage_records WHERE project_id=ANY($1::uuid[])", [projectIds]);
      await control.query("DELETE FROM app.project_create_idempotency WHERE project_id=ANY($1::uuid[])", [projectIds]);
      await control.query("DELETE FROM app.projects WHERE id=ANY($1::uuid[])", [projectIds]);
    }
    await control.query("DELETE FROM app.profiles WHERE id=ANY($1::uuid[])", [[account.id, otherAccount.id]]);
    await control.query("DELETE FROM app.schools WHERE id=ANY($1::uuid[])", [[account.schoolId, otherAccount.schoolId]]);
    await deleteSyntheticAuthAccount(account);
    await deleteSyntheticAuthAccount(otherAccount);
    await control.end();
  }
});
