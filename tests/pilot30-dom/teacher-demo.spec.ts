import { test as base, expect, type Locator, type Page } from "@playwright/test";

type Audit = { add: (label: string, value: unknown) => void };
const test = base.extend<{ audit: Audit }>({
  audit: [async ({ page, context, browser }, use, info) => {
    const observations: { label: string; value: unknown }[] = [];
    const errors: string[] = [];
    const expectedHttpErrors: { text: string; url: string }[] = [];
    const warnings: string[] = [];
    const dialogs: string[] = [];
    const forbidden: string[] = [];
    const paths = new Set<string>();
    await context.route("**/*", async (route) => {
      const url = new URL(route.request().url());
      if (["http:", "https:"].includes(url.protocol)) {
        if (url.origin !== "http://127.0.0.1:32191" ||
            /^\/(?:api|auth)(?:\/|$)/u.test(url.pathname)) {
          forbidden.push(`${url.origin}${url.pathname}`);
          await route.abort("blockedbyclient");
          return;
        }
        paths.add(url.pathname);
      }
      await route.continue();
    });
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("dialog", async (dialog) => {
      dialogs.push(dialog.type());
      await dialog.dismiss();
    });
    page.on("console", (message) => {
      if (message.type() === "error") {
        const url = message.location().url;
        if (process.env.P30_GATE_EXPECT === "off" &&
            url === "http://127.0.0.1:32191/pilot30/teacher-demo" &&
            message.text() === "Failed to load resource: the server responded with a status of 404 (Not Found)") {
          expectedHttpErrors.push({ text: message.text(), url });
        } else {
          errors.push(message.text());
        }
      }
      if (message.type() === "warning") warnings.push(message.text());
    });
    await use({ add: (label, value) => observations.push({ label, value }) });
    await info.attach("dom-observations", {
      body: JSON.stringify({
        browser: browser.version(),
        observations,
        errors,
        expectedHttpErrors,
        warnings,
        dialogs,
        forbidden,
        requestPaths: [...paths].sort(),
      }, null, 2),
      contentType: "application/json",
    });
    expect(forbidden, "No external or Auth/API request may be attempted").toEqual([]);
    expect(errors, "No browser console/React runtime error").toEqual([]);
    expect(dialogs, "User-entered text must not open script dialogs").toEqual([]);
    expect(warnings.filter((warning) => /hydrat|react.*(?:error|warning)/iu.test(warning))).toEqual([]);
  }, { auto: true }],
});

const route = "/pilot30/teacher-demo";
const listLabel = "示範清單（每行一個項目，最多 8 個）";
const A = ["合成甲遊戲", "合成乙遊戲"];
const B = ["合成丙遊戲", "合成丁遊戲", "合成戊遊戲"];
const preview = (page: Page) => page.getByRole("region", { name: "示範 App 預覽", exact: true });
const picker = (page: Page) => page.getByRole("region", { name: "清單挑選互動", exact: true });
const appStatus = (page: Page) => page.getByRole("status").filter({ hasText: /固定 React|已保存|已還原/u });
const version = (page: Page, id: string) => page.getByRole("radio", { name: new RegExp(id, "u") });
const textbox = (page: Page, name: string) => page.getByRole("textbox", { name, exact: true });
const alerts = (page: Page) => page.getByRole("main").getByRole("alert");

async function open(page: Page) {
  const response = await page.goto(route);
  expect(response?.status()).toBe(200);
  await expect(page.getByLabel("App 名稱", { exact: true })).toBeVisible();
}

async function create(page: Page) {
  await open(page);
  await page.getByRole("button", { name: "下一步：設定範本", exact: true }).click();
  await expect(preview(page)).toContainText("完成藍圖後");
  await page.getByRole("button", { name: "建立示範 App", exact: true }).click();
  await expect(picker(page).getByRole("button", { name: "幫我挑一個" })).toBeEnabled();
}

async function expectItems(page: Page, items: readonly string[]) {
  await expect(picker(page).getByRole("listitem")).toHaveText([...items]);
}

async function saveTwo(page: Page) {
  await create(page);
  await textbox(page, listLabel).fill(A.join("\n"));
  await page.getByRole("button", { name: "下一步：保存版本" }).click();
  await expect(page.getByRole("button", { name: "還原選取版本" })).toBeDisabled();
  await page.getByRole("button", { name: "保存目前示範版本" }).click();
  await expect(version(page, "demo-v1")).toBeChecked();
  await page.getByRole("button", { name: "上一階段", exact: true }).click();
  await textbox(page, listLabel).fill(B.join("\n"));
  await page.getByRole("button", { name: "下一步：保存版本" }).click();
  await page.getByRole("button", { name: "保存目前示範版本" }).click();
  await expect(version(page, "demo-v2")).toBeChecked();
  await expect(page.getByRole("radio")).toHaveCount(2);
}

async function restore(page: Page, id: string, items: readonly string[]) {
  await version(page, id).check();
  await page.getByRole("button", { name: "還原選取版本" }).click();
  await expect(version(page, id)).toBeChecked();
  await expectItems(page, items);
  await expect(picker(page).getByRole("status")).toHaveText("尚未挑選");
  await page.getByRole("button", { name: "上一階段", exact: true }).click();
  await expect(textbox(page, listLabel)).toHaveValue(items.join("\n"));
}

async function nativeClick(control: Locator) {
  await control.evaluate((element) => {
    if (!(element instanceof HTMLButtonElement)) throw new Error("Expected a native button.");
    element.click();
  });
}

async function focusDescription(page: Page) {
  return page.evaluate(() => {
    const element = document.activeElement;
    return {
      tag: element?.tagName,
      id: element?.id,
      text: element?.textContent?.trim().slice(0, 100),
      label: element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement
        ? element.labels?.[0]?.textContent?.trim() : undefined,
    };
  });
}

test("P30-DOM-01 flag OFF：HTTP 404 且 DOM 無示範表單", async ({ page, audit }) => {
  test.skip(process.env.P30_GATE_EXPECT !== "off");
  const response = await page.goto(route);
  expect(response?.status()).toBe(404);
  await expect(page.getByLabel("App 名稱", { exact: true })).toHaveCount(0);
  audit.add("gate", { flag: "unset", http: response?.status(), demoFormCount: 0 });
});

test.describe("flag ON development 的真實 React DOM", () => {
  test.beforeEach(() => test.skip(process.env.P30_GATE_EXPECT === "off"));

  test("P30-DOM-01 flag ON：HTTP 200 且可操作 DOM", async ({ page, audit }) => {
    await open(page);
    await page.getByLabel("App 名稱", { exact: true }).fill("合成入口測試");
    await expect(page.getByLabel("App 名稱", { exact: true })).toHaveValue("合成入口測試");
    audit.add("gate", { flag: "true", environment: "development", http: 200, controlledInput: true });
  });

  test("P30-DOM-02 Blueprint：真實輸入、錯誤修正與最多三項", async ({ page, audit }) => {
    await open(page);
    const name = page.getByLabel("App 名稱", { exact: true });
    const next = page.getByRole("button", { name: "下一步：設定範本", exact: true });
    await name.fill(" ");
    await expect(alerts(page)).toContainText("App 名稱");
    await expect(next).toBeDisabled();
    await nativeClick(next);
    await expect(page.getByRole("heading", { name: "確認藍圖", exact: true })).toBeVisible();
    await name.fill("合成清單星球");
    await page.getByLabel("使用者", { exact: true }).fill("合成練習者");
    await textbox(page, "用途／要解決的問題").fill("從合成清單挑選活動");
    await page.getByLabel("功能 1", { exact: true }).fill("顯示合成清單");
    await page.getByLabel("功能 2", { exact: true }).fill("顯示合成清單");
    await expect(alerts(page)).toContainText("不能重複");
    await expect(next).toBeDisabled();
    await page.getByLabel("功能 2", { exact: true }).fill("挑選合成項目");
    await page.getByLabel("功能 3", { exact: true }).fill("修改合成內容");
    const add = page.getByRole("button", { name: "＋ 增加功能", exact: true });
    await expect(add).toBeDisabled();
    await nativeClick(add);
    await expect(page.getByRole("group", { name: "核心功能（最多 3 項）" }).getByRole("textbox"))
      .toHaveCount(3);
    await expect(alerts(page)).toHaveCount(0);
    await expect(name).toHaveValue("合成清單星球");
    await expect(page.getByLabel("使用者", { exact: true })).toHaveValue("合成練習者");
    await expect(textbox(page, "用途／要解決的問題")).toHaveValue("從合成清單挑選活動");
    await next.click();
    await expect(page.getByRole("heading", { name: "建立與預覽", exact: true })).toBeVisible();
    audit.add("blueprint", { blankBlocked: true, duplicateBlocked: true, fourthBlocked: true });
  });

  test("P30-DOM-03 建立 Preview：可見範本與非 AI 限制", async ({ page, audit }) => {
    await open(page);
    await page.getByLabel("App 名稱", { exact: true }).fill("合成預覽星球");
    await textbox(page, "用途／要解決的問題").fill("練習清單挑選");
    await page.getByRole("button", { name: "下一步：設定範本", exact: true }).click();
    await expect(preview(page)).toContainText("完成藍圖後");
    await expect(page.getByRole("button", { name: "下一步：保存版本" })).toBeDisabled();
    await page.getByRole("button", { name: "建立示範 App", exact: true }).click();
    await expect(preview(page).getByRole("heading", { name: "合成預覽星球" })).toBeVisible();
    await expect(preview(page)).toContainText("練習清單挑選");
    await expect(page.getByText("本機教師示範／合成資料／非 AI 生成", { exact: false })).toBeVisible();
    await expect(appStatus(page)).toContainText("沒有呼叫 AI、API、Auth 或資料庫");
    await expect(page.getByRole("button", { name: "固定示範 App 已建立" })).toBeDisabled();
    await expect(page.getByRole("button", { name: "下一步：保存版本" })).toBeEnabled();
    audit.add("preview", { created: true, title: await preview(page).getByRole("heading", { level: 3 }).innerText() });
    await page.screenshot({ path: test.info().outputPath("created-preview.png"), fullPage: true });
  });

  test("P30-DOM-04 連續兩次挑選：status 與畫面結果確實更新", async ({ page, audit }) => {
    await create(page);
    const status = picker(page).getByRole("status");
    await expect(status).toHaveText("尚未挑選");
    await picker(page).getByRole("button", { name: "幫我挑一個" }).click();
    await expect(status).toHaveText("這次先試試看：猜拳");
    const first = await status.innerText();
    await picker(page).getByRole("button", { name: "幫我挑一個" }).click();
    await expect(status).toHaveText("這次先試試看：畫畫");
    const second = await status.innerText();
    expect(first).not.toBe(second);
    await expectItems(page, ["猜拳", "畫畫", "傳球"]);
    audit.add("two-picks", { first, second, currentList: ["猜拳", "畫畫", "傳球"] });
  });

  test("P30-DOM-05 修改同步：兩組清單、失效舊結果、非法清單與藍圖文字", async ({ page, audit }) => {
    await create(page);
    const input = textbox(page, listLabel);
    const pick = picker(page).getByRole("button", { name: "幫我挑一個" });
    const status = picker(page).getByRole("status");
    for (const items of [A, B]) {
      await input.fill(items.join("\n"));
      await expectItems(page, items);
      await expect(status).toHaveText("尚未挑選");
      await pick.click();
      await expect(status).toHaveText(`這次先試試看：${items[0]}`);
    }
    for (const invalid of ["", "重複\n重複", Array.from({ length: 9 }, (_, i) => `合成${i}`).join("\n")]) {
      await input.fill(invalid);
      await expect(alerts(page)).toBeVisible();
      await expect(pick).toBeDisabled();
      await nativeClick(pick);
      await expect(status).toHaveText("尚未挑選");
      await page.getByRole("button", { name: "下一步：保存版本" }).click();
      const save = page.getByRole("button", { name: "保存目前示範版本" });
      await expect(save).toBeDisabled();
      await nativeClick(save);
      await expect(page.getByRole("radio")).toHaveCount(0);
      await page.getByRole("button", { name: "上一階段", exact: true }).click();
    }
    await input.fill(B.join("\n"));
    await expect(alerts(page)).toHaveCount(0);
    await page.getByRole("button", { name: "上一階段", exact: true }).click();
    await page.getByLabel("App 名稱", { exact: true }).fill("合成即時改名");
    await textbox(page, "用途／要解決的問題").fill("合成用途已更新");
    await expect(preview(page).getByRole("heading", { name: "合成即時改名" })).toBeVisible();
    await expect(preview(page)).toContainText("合成用途已更新");
    await expectItems(page, B);
    audit.add("sync", { lists: [A, B], invalidCases: 3, draftTitle: "合成即時改名" });
  });

  test("P30-DOM-06 保存兩版：透過還原讀回確認 A/B 獨立快照", async ({ page, audit }) => {
    await saveTwo(page);
    await expect(appStatus(page)).toContainText("demo-v2 已保存");
    await restore(page, "demo-v1", A);
    await page.getByRole("button", { name: "下一步：保存版本" }).click();
    await restore(page, "demo-v2", B);
    audit.add("read-back", { "demo-v1": A, "demo-v2": B, versionCount: 2 });
  });

  test("P30-DOM-07 還原第一版：草稿、Preview、選取一致且再編輯不污染快照", async ({ page, audit }) => {
    await saveTwo(page);
    await restore(page, "demo-v1", A);
    await textbox(page, listLabel).fill("僅修改目前草稿\n合成暫時內容");
    await expectItems(page, ["僅修改目前草稿", "合成暫時內容"]);
    await page.getByRole("button", { name: "下一步：保存版本" }).click();
    await restore(page, "demo-v1", A);
    await page.getByRole("button", { name: "下一步：保存版本" }).click();
    await restore(page, "demo-v2", B);
    await page.getByRole("button", { name: "下一步：保存版本" }).click();
    await expect(page.getByRole("radio")).toHaveCount(2);
    await expect(version(page, "demo-v2")).toBeChecked();
    audit.add("restore-isolation", { v1AfterDraftEdit: A, v2AfterRestore: B, selected: "demo-v2" });
    await page.screenshot({ path: test.info().outputPath("restored-v2.png"), fullPage: true });
  });

  test("P30-DOM-08 鍵盤、焦點、disabled、alert/status 與純文字安全", async ({ page, audit }) => {
    await open(page);
    await page.getByRole("link", { name: /AI APP 超級創客/u }).focus();
    const expectedLabels = ["App 名稱", "使用者", "用途／要解決的問題", "功能 1"];
    const tabOrder: unknown[] = [];
    for (const label of expectedLabels) {
      await page.keyboard.press("Tab");
      await expect(textbox(page, label)).toBeFocused();
      tabOrder.push(await focusDescription(page));
    }
    for (const control of [
      page.getByRole("button", { name: "移除", exact: true }).nth(0),
      page.getByLabel("功能 2", { exact: true }),
      page.getByRole("button", { name: "移除", exact: true }).nth(1),
      page.getByLabel("功能 3", { exact: true }),
      page.getByRole("button", { name: "移除", exact: true }).nth(2),
      page.getByRole("button", { name: "下一步：設定範本", exact: true }),
    ]) {
      await page.keyboard.press("Tab");
      await expect(control).toBeFocused();
      tabOrder.push(await focusDescription(page));
    }
    await page.getByLabel("App 名稱", { exact: true }).fill(" ");
    await expect(alerts(page)).toBeVisible();
    const next = page.getByRole("button", { name: "下一步：設定範本", exact: true });
    await expect(next).toBeDisabled();
    await nativeClick(next);
    await expect(page.getByLabel("App 名稱", { exact: true })).toBeVisible();
    const payload = "<img src=x onerror=alert(1)>";
    await page.getByLabel("App 名稱", { exact: true }).fill(payload);
    await next.focus();
    await page.keyboard.press("Enter");
    audit.add("focus-after-next", await focusDescription(page));
    await expect(page.getByRole("heading", { name: "建立與預覽", exact: true })).toBeVisible();
    await page.keyboard.press("Tab");
    audit.add("first-tab-after-next", await focusDescription(page));
    await expect(textbox(page, listLabel)).toBeFocused();
    await textbox(page, listLabel).fill(`${payload}\n<script>alert(2)</script>`);
    const createButton = page.getByRole("button", { name: "建立示範 App", exact: true });
    await createButton.focus();
    await page.keyboard.press("Space");
    await expect(preview(page).getByRole("heading", { name: payload, exact: true })).toBeVisible();
    await expect(picker(page).getByRole("listitem")).toHaveText([payload, "<script>alert(2)</script>"]);
    await expect(preview(page).locator("img, script, iframe")).toHaveCount(0);
    await expect(appStatus(page)).toContainText("沒有呼叫 AI");
    const pick = picker(page).getByRole("button", { name: "幫我挑一個" });
    await pick.focus();
    await page.keyboard.press("Enter");
    await expect(picker(page).getByRole("status")).toHaveText(`這次先試試看：${payload}`);
    await page.keyboard.press("Space");
    await expect(picker(page).getByRole("status")).toHaveText("這次先試試看：<script>alert(2)</script>");
    await page.getByRole("button", { name: "下一步：保存版本" }).focus();
    await page.keyboard.press("Enter");
    audit.add("focus-after-version-step", await focusDescription(page));
    const save = page.getByRole("button", { name: "保存目前示範版本" });
    await page.keyboard.press("Tab");
    audit.add("first-tab-after-version-step", await focusDescription(page));
    await expect(save).toBeFocused();
    await page.keyboard.press("Space");
    await expect(version(page, "demo-v1")).toBeChecked();
    await page.keyboard.press("Enter");
    await expect(version(page, "demo-v2")).toBeChecked();
    await version(page, "demo-v2").focus();
    await page.keyboard.press("ArrowUp");
    await expect(version(page, "demo-v1")).toBeChecked();
    await expect(version(page, "demo-v1")).toBeFocused();
    await page.getByRole("button", { name: "還原選取版本" }).focus();
    await page.keyboard.press("Enter");
    await expect(appStatus(page)).toContainText("demo-v1 已還原");
    audit.add("keyboard", { tabOrder, radioArrowSelection: "demo-v1", restoreFocus: await focusDescription(page) });
  });
});
