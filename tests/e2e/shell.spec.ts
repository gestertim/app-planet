import { expect, test } from "@playwright/test";

// 合成本機介面煙霧測試：不登入、不連線、不保存資料。
test.describe("本機合成介面", () => {
  test("首頁顯示品牌標語、原型聲明與三個合成角色入口", async ({ page }) => {
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));

    await page.goto("/");
    await expect(page.getByText("Chat. Create. Launch.")).toBeVisible();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("讓好奇心，成為下一個作品。");
    await expect(page.getByRole("status")).toContainText("目前是本機原型");
    await expect(page.getByRole("link", { name: "開啟介面預覽" })).toHaveCount(3);
    expect(pageErrors).toEqual([]);
  });

  test("學生專案工作區預覽為唯讀合成資料，沒有真實操作入口", async ({ page }) => {
    await page.goto("/student/workspace-preview");
    await expect(page.getByRole("heading", { name: "學生專案工作區" })).toBeVisible();
    await expect(page.getByText("合成").first()).toBeVisible();
  });

  test("導覽由可信 server 能力決定：無可信身分時不提供角色切換連結", async ({ page }) => {
    await page.goto("/student/save-flow-simulation");
      await page.waitForLoadState("networkidle");
    await expect(page.getByRole("navigation", { name: "功能導覽" })).toContainText("尚無可信身分");
    await expect(page.getByRole("link", { name: /介面預覽/ })).toHaveCount(0);
  });

  test.describe("保存流程狀態（合成 adapter，非正式保存）", () => {
    const banner = (page: import("@playwright/test").Page) => page.locator(".operation-banner");
    async function startSave(page: import("@playwright/test").Page, text: string) {
      await page.goto("/student/save-flow-simulation");
      await page.waitForLoadState("networkidle");
      const editor = page.getByLabel("階段草稿文字");
      await editor.fill(text);
      await expect(banner(page)).toHaveAttribute("data-kind", "unsaved");
      await page.getByRole("button", { name: "模擬保存", exact: true }).click();
      await expect(banner(page)).toHaveAttribute("data-kind", "saving");
      return editor;
    }

    test("保存中不是已保存；成功回應後才顯示已保存", async ({ page }) => {
      await startSave(page, "成功草稿");
      await expect(banner(page)).not.toContainText("已保存");
      await page.getByRole("button", { name: "模擬保存成功" }).click();
      await expect(banner(page)).toHaveAttribute("data-kind", "saved");
      await expect(banner(page)).toContainText("已保存");
    });

    test("版本衝突保留本地草稿，且不顯示已保存", async ({ page }) => {
      const editor = await startSave(page, "我的本地草稿");
      await page.getByRole("button", { name: "模擬保存衝突" }).click();
      await expect(banner(page)).toHaveAttribute("data-code", "version_conflict");
      await expect(editor).toHaveValue("我的本地草稿");
    });

    test("結果待確認可用原操作重試，不自動視為失敗", async ({ page }) => {
      const editor = await startSave(page, "待確認草稿");
      await page.getByRole("button", { name: "模擬保存失敗／結果不確定" }).click();
      await expect(banner(page)).toHaveAttribute("data-code", "dependency_unavailable");
      await expect(editor).toHaveValue("待確認草稿");
      await expect(page.getByRole("button", { name: "使用原操作鍵重試" })).toBeVisible();
    });

    test("離線時保留草稿並顯示離線；登入失效顯示固定碼", async ({ page }) => {
      await page.goto("/student/save-flow-simulation");
      await page.waitForLoadState("networkidle");
      await page.getByLabel("模擬離線", { exact: false }).check();
      const editor = page.getByLabel("階段草稿文字");
      await editor.fill("離線草稿");
      await page.getByRole("button", { name: "模擬保存", exact: true }).click();
      await expect(banner(page)).toHaveAttribute("data-kind", "offline");
      await expect(editor).toHaveValue("離線草稿");
      await page.getByLabel("模擬離線", { exact: false }).uncheck();
      await page.getByRole("button", { name: "使用原操作鍵重試" }).click();
      await page.getByRole("button", { name: "模擬登入失效" }).click();
      await expect(banner(page)).toHaveAttribute("data-code", "unauthenticated");
      await expect(editor).toHaveValue("離線草稿");
    });
  });
});
