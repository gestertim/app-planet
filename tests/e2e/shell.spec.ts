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
});
