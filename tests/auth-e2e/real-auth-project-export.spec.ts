import { expect, test, type Download } from "@playwright/test";
import { readFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { projectExportFilename, projectExportSchema } from "@app-planet/core";
import { createSyntheticAuthAccount, deleteSyntheticAuthAccount, loginSyntheticAccount, openControlPool } from "../support/real-auth-fixture.ts";
import { sessionCookieName } from "../../apps/web/src/server/auth-principal.ts";

test.use({ actionTimeout: 15_000 });
test("T025 真 Next HTTPS：產品保存、實際 JSON 下載、未保存仍保留、reload 與 DB 故障重試", async ({ browser }) => {
  test.setTimeout(240_000);
  const control = openControlPool();
  const account = await createSyntheticAuthAccount(control, "ExportBrowser");
  // 合成學生 session setup；不是學生產品登入碼 E2E，學校僅隔離 fixture。
  const session = await loginSyntheticAccount(account);
  const origin = process.env.APP_PLANET_APP_ORIGIN!;
  const context = await browser.newContext({ locale: "zh-TW" });
  let id: string | null = null;
  let revoked = false;
  try {
    await context.addCookies([{ name: sessionCookieName, value: session.accessToken, url: origin,
      secure: true, httpOnly: true, sameSite: "Strict" }]);
    const page = await context.newPage();
    let downloads = 0, exportRequests = 0;
    page.on("download", () => { downloads++; });
    page.on("request", (r) => { if (new URL(r.url()).pathname.endsWith("/export")) exportRequests++; });
    await page.goto(`${origin}/student`);
    const title = '繁中 🚀 "專案" <h1>原文</h1>';
    await page.getByLabel("專案名稱").fill(title);
    const creating = page.waitForResponse((r) => new URL(r.url()).pathname === "/api/v1/projects" && r.request().method() === "POST");
    await page.getByRole("button", { name: "建立專案", exact: true }).click();
    const created = await creating;
    expect(created.status()).toBe(201);
    id = (await created.json()).id as string;
    await page.getByTestId("owned-project-list").getByRole("link", { name: title, exact: true }).click();
    await page.getByTestId("stage-row-2").getByRole("link", { name: "開啟 A/B 草稿", exact: true }).click();
    const formal = page.getByRole("region", { name: "正式需求與 A/B 分類", exact: true });
    const requirements = '已保存需求 🚀 "引號" <script>原文</script>\n第二行';
    await formal.getByLabel("正式需求說明").fill(requirements);
    await formal.getByLabel("作品執行需求", { exact: true }).selectOption("static");
    await formal.getByLabel("作品執行時需要 AI", { exact: true }).selectOption("false");
    await formal.getByRole("button", { name: "保存正式需求", exact: true }).click();
    await expect(formal.getByTestId("formal-operation-status")).toContainText("正式需求已保存");
    await formal.getByLabel("正式 A/B 分類", { exact: true }).selectOption("A");
    await formal.getByLabel("需要識別訪客身分嗎", { exact: true }).selectOption("false");
    await formal.getByRole("button", { name: "明確確認正式分類", exact: true }).click();
    await expect(formal.getByTestId("formal-classification-current")).toHaveAttribute("data-state", "confirmed");
    const draftText = '已保存階段草稿 🚀 "<p>"';
    const draft = page.getByLabel("階段草稿文字");
    await draft.fill(draftText);
    await page.getByRole("button", { name: "保存", exact: true }).click();
    await expect(page.getByText("已確認版本 0。")).toBeVisible();
    await page.getByTestId("confirm-saved-version").click();
    await expect(page.getByTestId("confirmation-headline")).toHaveAttribute("data-state", "confirmed_current");
    await page.getByRole("link", { name: "創作計畫", exact: true }).click();
    await page.getByLabel(/任務清單（每行一項/).fill('我的任務 🚀\n<h1>"第二項"</h1>');
    await page.getByRole("button", { name: "預覽任務清單" }).click();
    await page.getByRole("button", { name: "確認並建立任務清單" }).click();
    await expect(page.getByTestId("project-task-import-status")).toContainText("已");
    await page.getByRole("checkbox", { name: "完成任務：我的任務 🚀" }).check();
    await expect(page.getByTestId("project-task-save-status")).toContainText("已保存你的任務勾選");
    expect(downloads).toBe(0);
    expect(exportRequests).toBe(0);

    const readDownload = async (download: Download) => {
      expect(download.suggestedFilename()).toBe(projectExportFilename);
      expect(await download.failure()).toBeNull();
      const path = await download.path();
      if (!path) throw Error("Playwright 沒有實際下載檔");
      return projectExportSchema.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await readFile(path))));
    };
    const clickDownload = async () => {
      const event = page.waitForEvent("download");
      await page.getByRole("button", { name: "下載已保存資料", exact: true }).click();
      const download = await event;
      const value = await readDownload(download);
      await expect(page.getByTestId("project-export-status")).toContainText("已下載已保存資料");
      return { value, download };
    };
    const first = await clickDownload();
    expect(first.value.project).toEqual((await control.query("SELECT id,title,stage,row_version FROM app.projects WHERE id=$1", [id])).rows[0]);
    expect(first.value.requirements?.content.description).toBe(requirements);
    expect(first.value.classification.confirmation_validity).toBe("valid");
    expect(first.value.stages.find((s) => s.stage === "A/B")).toMatchObject({
      draft: { row_version: 0, content: { text: draftText } }, confirmation: { row_version: 0, current: true },
    });
    expect(first.value.tasks).toEqual((await control.query('SELECT id,project_id,"order",title,done,row_version FROM app.tasks WHERE project_id=$1 ORDER BY "order",id', [id])).rows);
    expect(first.value.tasks[0]).toMatchObject({ done: true, row_version: 1 });
    if (process.env.APP_PLANET_EXPORT_EVIDENCE_DIRECTORY) {
      await mkdir(process.env.APP_PLANET_EXPORT_EVIDENCE_DIRECTORY, { recursive: true });
      await first.download.saveAs(join(process.env.APP_PLANET_EXPORT_EVIDENCE_DIRECTORY, "https-actual-download.json"));
    }

    await page.goto(`${origin}/student/projects/${id}/stages/A%2FB`);
    const unsaved = "不在 DB 的未保存文字 🚀";
    await draft.fill(unsaved);
    const dirty = await clickDownload();
    expect(dirty.value.stages.find((s) => s.stage === "A/B")?.draft?.content.text).toBe(draftText);
    await expect(draft).toHaveValue(unsaved);
    await expect(page.getByTestId("project-export-status")).toContainText("未保存");
    const untouched = (await control.query("SELECT content,row_version FROM app.stage_records WHERE project_id=$1 AND stage='A/B'", [id])).rows[0];
    expect(untouched).toEqual({ content: { text: draftText }, row_version: 0 });
    page.once("dialog", (dialog) => void dialog.accept());
    await page.reload();
    await expect(draft).toHaveValue(draftText);
    const reloaded = await clickDownload();
    const { read_at: _firstTime, ...firstContent } = first.value;
    const { read_at: _reloadTime, ...reloadContent } = reloaded.value;
    expect(reloadContent).toEqual(firstContent);

    const count = downloads;
    await control.query("REVOKE EXECUTE ON FUNCTION app.read_saved_project_export(uuid) FROM authenticated");
    revoked = true;
    const failed = page.waitForResponse((r) => new URL(r.url()).pathname === `/api/v1/projects/${id}/export`);
    await page.getByRole("button", { name: "下載已保存資料", exact: true }).click();
    const response = await failed;
    expect(response.status()).toBe(503);
    expect(response.headers()["content-type"]).toBe("application/problem+json");
    await expect(page.getByTestId("project-export-status")).toContainText("下載失敗");
    await expect(page.getByTestId("project-export-status")).toContainText("重試");
    expect(downloads).toBe(count);
    await expect(page).toHaveURL(new RegExp(`/student/projects/${id}/stages/A%2FB$`));
    await control.query("GRANT EXECUTE ON FUNCTION app.read_saved_project_export(uuid) TO authenticated");
    revoked = false;
    await clickDownload();
    expect(downloads).toBe(count + 1);
    expect(await page.evaluate(() => [...Object.values(localStorage), ...Object.values(sessionStorage)]
      .some((v) => v.includes("app-planet.saved-project.v1")))).toBe(false);
  } finally {
    if (revoked) await control.query("GRANT EXECUTE ON FUNCTION app.read_saved_project_export(uuid) TO authenticated");
    await context.close();
    if (id) {
      await control.query(`UPDATE app.projects SET classification_state='unconfirmed',tier=NULL,
        needs_visitor_identity=NULL,current_confirmation_id=NULL WHERE id=$1`, [id]);
      for (const table of ["project_task_imports", "tasks", "stage_draft_confirmations", "stage_draft_idempotency",
        "stage_records", "project_classification_idempotency", "project_classification_confirmations",
        "project_requirements", "project_create_idempotency"]) {
        await control.query(`DELETE FROM app.${table} WHERE project_id=$1`, [id]);
      }
      await control.query("DELETE FROM app.projects WHERE id=$1", [id]);
    }
    await control.query("DELETE FROM app.profiles WHERE id=$1", [account.id]);
    await control.query("DELETE FROM app.schools WHERE id=$1", [account.schoolId]);
    await deleteSyntheticAuthAccount(account);
    await control.end();
    console.log("SavedProjectExportCleanup=verified synthetic data and browser context removed");
  }
});
