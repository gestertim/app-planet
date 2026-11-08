import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect as baseExpect, test, type BrowserContext, type Page } from "@playwright/test";
import {
  createOwnedSyntheticProject, createSyntheticAuthAccount, loginSyntheticAccount, openControlPool,
  type SyntheticAuthAccount,
} from "../support/real-auth-fixture.ts";
import { sessionCookieName } from "../../apps/web/src/server/auth-principal.ts";

const evidenceDirectory = process.env.APP_PLANET_UI_EVIDENCE_DIR;
const expect = baseExpect.configure({ timeout: 15_000 });

async function setSession(context: BrowserContext, account: SyntheticAuthAccount) {
  const origin = process.env.APP_PLANET_APP_ORIGIN;
  if (!origin) throw new Error("隔離瀏覽器測試缺少本機 app origin。");
  const session = await loginSyntheticAccount(account);
  await context.addCookies([{ name: sessionCookieName, value: session.accessToken, url: origin,
    httpOnly: true, secure: true, sameSite: "Strict" }]);
}

async function screenshot(page: Page, name: string) {
  if (!evidenceDirectory) return;
  await mkdir(evidenceDirectory, { recursive: true });
  await page.screenshot({ path: path.join(evidenceDirectory, `${name}.png`),
    style: "nextjs-portal { visibility: hidden; }" });
}

async function recordCss(page: Page, label: "before" | "after") {
  if (!evidenceDirectory) return;
  const urls = await page.locator('link[rel="stylesheet"]').evaluateAll((links) =>
    links.map((link) => (link as HTMLLinkElement).href));
  const entries = [];
  for (const [index, url] of urls.entries()) {
    const response = await page.request.get(url);
    expect(response.ok()).toBe(true);
    const content = await response.body();
    const file = `loaded-student-${label}-${index}.css`;
    await writeFile(path.join(evidenceDirectory, file), content);
    entries.push({ pathname: new URL(url).pathname, file,
      sha256: createHash("sha256").update(content).digest("hex") });
  }
  expect(entries.length).toBeGreaterThan(0);
  await writeFile(path.join(evidenceDirectory, `loaded-css-${label}.json`), JSON.stringify(entries, null, 2));
  return entries.map((entry) => ({ pathname: entry.pathname, sha256: entry.sha256 }));
}

async function measureUi(page: Page) {
  const measurements = await page.getByTestId("student-creation-space").evaluate((home) => {
    const textPairs = [];
    const walker = document.createTreeWalker(home, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const node = walker.currentNode;
      const element = node.parentElement;
      if (!element || !node.textContent?.trim() || element.closest('[aria-hidden="true"]')
        || element.closest("#my-projects") || element.closest(".notice")) continue;
      const style = getComputedStyle(element);
      let ancestor: Element | null = element;
      let background = "rgb(252, 253, 251)";
      while (ancestor) {
        const painted = getComputedStyle(ancestor).backgroundColor;
        if (/^rgb\(/.test(painted)) { background = painted; break; }
        ancestor = ancestor.parentElement;
      }
      textPairs.push({ text: node.textContent.trim(), color: style.color, background,
        fontSize: Number.parseFloat(style.fontSize), fontWeight: Number.parseInt(style.fontWeight, 10) });
    }
    const positions = Array.from(home.querySelectorAll("aside, header, main > section, #guide-title, #student-idea"))
      .slice(0, 8).map((element) => {
        const rect = element.getBoundingClientRect();
        return { element: element.id || element.tagName, x: rect.x, y: rect.y, width: rect.width, height: rect.height };
      });
    return { textPairs, positions, viewport: { width: innerWidth, height: innerHeight } };
  });
  const luminance = (rgb: string) => {
    const components = rgb.match(/\d+/g)?.slice(0, 3).map(Number);
    if (!components || components.length !== 3) throw new Error("無法驗算實際文字配色。");
    return components.map((component) => {
      const normalized = component / 255;
      return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
    }).reduce((total, component, index) => total + component * [0.2126, 0.7152, 0.0722][index], 0);
  };
  const contrasts = measurements.textPairs.map((pair) => {
    const a = luminance(pair.color), b = luminance(pair.background);
    const ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    const required = pair.fontSize >= 24 || (pair.fontSize >= 18.66 && pair.fontWeight >= 700) ? 3 : 4.5;
    expect(ratio, `文字對比：${pair.text}`).toBeGreaterThanOrEqual(required);
    return { ...pair, ratio, required };
  });
  const outlineColor = luminance("rgb(14, 118, 109)");
  const outlineOnCanvas = (luminance("rgb(252, 253, 251)") + 0.05) / (outlineColor + 0.05);
  expect(outlineOnCanvas).toBeGreaterThanOrEqual(3);
  if (evidenceDirectory) await writeFile(path.join(evidenceDirectory, "ui-measurements.json"),
    JSON.stringify({ positions: measurements.positions, viewport: measurements.viewport, contrasts, outlineOnCanvas }, null, 2));
}

test("學生首頁：可信清單、四條草稿路徑、鍵盤、窄畫面與拒絕／失敗邊界", async ({ browser }) => {
  test.setTimeout(360_000);
  const control = openControlPool();
  const account = await createSyntheticAuthAccount(control, "HomeEntry");
  const other = await createSyntheticAuthAccount(control, "HomeOther");
  const project = await createOwnedSyntheticProject(account);
  await control.query("UPDATE app.projects SET title=$2,stage='Specification' WHERE id=$1",
    [project, "森林觀察小幫手"]);
  const context = await browser.newContext({ locale: "zh-TW", ignoreHTTPSErrors: true,
    viewport: { width: 1440, height: 900 } });
  const guest = await browser.newContext({ locale: "zh-TW", ignoreHTTPSErrors: true });
  const noScript = await browser.newContext({ javaScriptEnabled: false, ignoreHTTPSErrors: true });
  let renewalError: unknown = null;
  const renewal = setInterval(() => {
    setSession(context, account).catch((error: unknown) => { renewalError = error; });
  }, 30_000);
  try {
    const guestPage = await guest.newPage();
    await guestPage.goto("/student");
    await expect(guestPage.getByText("尚未登入或工作階段已失效；請使用核准的登入流程。")).toBeVisible();
    await expect(guestPage.getByTestId("student-creation-space")).toHaveCount(0);
    await expect(guestPage.getByTestId("owned-project-list")).toHaveCount(0);
    await screenshot(guestPage, "unauthenticated");

    await setSession(noScript, account);
    const hiddenPage = await noScript.newPage();
    await hiddenPage.goto("/student");
    await expect(hiddenPage.getByTestId("student-creation-space")).toBeHidden();

    await setSession(context, account);
    const page = await context.newPage();
    page.on("dialog", (dialog) => void dialog.accept());
    const writes: string[] = [];
    page.on("request", (request) => {
      if (["POST", "PUT", "PATCH", "DELETE"].includes(request.method())) writes.push(new URL(request.url()).pathname);
    });
    await page.goto("/student");
    const home = page.getByTestId("student-creation-space");
    await expect(home).toBeVisible();
    await expect(home.getByText("AI APP 超級創客", { exact: true })).toBeVisible();
    await expect(home.getByText("App Planet", { exact: true })).toBeVisible();
    await expect(home.getByText("Chat. Create. Launch.", { exact: true })).toBeVisible();
    await expect(page.getByTestId("owned-project-list")).toContainText("森林觀察小幫手");
    await expect(page.getByTestId("continue-project")).toContainText("實際階段：Specification");
    await expect(page.getByTestId("continue-project")).toContainText("尚無可讀取的專案摘要");
    await screenshot(page, "student-1440x900");
    const cssBefore = await recordCss(page, "before");
    await measureUi(page);
    const editor = page.getByRole("textbox", { name: "我的點子草稿" });
    const cardNames = ["我還沒有點子", "我想開始做 App", "我想學會新知識"];
    const tools = ["App 點子產生器", "AI App 超級創客 v5", "萬能教師"];
    for (const [index, name] of cardNames.entries()) {
      await editor.fill("");
      const card = page.getByRole("button", { name: new RegExp(`^${name}`) });
      await card.click();
      await expect(editor).not.toHaveValue("");
      await expect(editor).toBeFocused();
      await expect(card).toHaveAttribute("aria-pressed", "true");
      await expect(page.locator("#student-guide-status")).toContainText(tools[index]);
      const text = `完整草稿 ${index}\n第二行：空格也保留  `;
      await editor.fill(text);
      for (const otherName of cardNames) {
        await page.getByRole("button", { name: new RegExp(`^${otherName}`) }).click();
        await expect(editor).toHaveValue(text);
      }
      await page.getByRole("button", { name: `${tools[index]}：帶入草稿引導` }).click();
      await expect(editor).toHaveValue(text);
    }
    await page.reload();
    await expect(editor).toHaveValue("");
    await editor.fill("直接輸入，不選卡也可以。");
    await expect(page.locator("#student-guide-status")).toContainText("尚未選擇引導");
    await expect(page.locator("#student-guide-status")).toContainText("未啟用特定 Skill");
    for (const label of ["＋ 新對話", "檔案庫", "＋ 附件", "啟用 Skill", "送出點子", "使用指南"]) {
      await expect(page.getByRole("button", { name: `${label}｜尚未開放`, exact: true })).toBeDisabled();
    }
    expect(writes).toEqual([]);
    await page.reload();
    await expect(home).toBeVisible();
    await page.keyboard.press("Tab");
    await expect(page.getByRole("link", { name: "跳到創作空間內容" })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.locator("#student-main")).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(editor).toBeFocused();
    await editor.press("Control+A");
    await page.keyboard.insertText("鍵盤輸入的點子");
    await page.keyboard.press("Tab");
    const firstCard = page.getByRole("button", { name: /^我還沒有點子/ });
    await expect(firstCard).toBeFocused();
    const outline = await firstCard.evaluate((element) => {
      const style = getComputedStyle(element);
      return { style: style.outlineStyle, width: style.outlineWidth, color: style.outlineColor };
    });
    expect(outline).toEqual({ style: "solid", width: "3px", color: "rgb(14, 118, 109)" });
    await page.keyboard.press("Enter");
    await expect(editor).toHaveValue("鍵盤輸入的點子");
    await expect(editor).toBeFocused();
    await screenshot(page, "keyboard-focus");
    for (let step = 0; step < 4; step++) await page.keyboard.press("Tab");
    await expect(page.getByTestId("owned-project-list").getByRole("link", { name: "森林觀察小幫手" }))
      .toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("student-draft-dialog")).toBeVisible();
    await page.getByRole("button", { name: "放棄草稿並離開", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/student/projects/${project}$`), { timeout: 30_000 });
    await expect(page.getByTestId("workspace-project-context")).toBeVisible({ timeout: 30_000 });
    await page.goto("/student");
    await expect(home).toBeVisible();
    await page.getByRole("link", { name: "▦ 我的專案" }).click();
    await expect(page).toHaveURL(/#my-projects$/);
    await expect(page.getByTestId("owned-project-list")).toBeInViewport();
    await screenshot(page, "student-projects");
    await expect(page.getByLabel("專案名稱")).toBeVisible();
    await page.getByRole("region", { name: "建立未分類點子" }).scrollIntoViewIfNeeded();
    await screenshot(page, "student-create-form");
    await page.setViewportSize({ width: 600, height: 900 });
    await page.goto("/student");
    await expect(page.getByRole("navigation", { name: "學生主導覽" })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await screenshot(page, "student-narrow");
    await page.getByRole("link", { name: "▦ 我的專案" }).click();
    await expect(page.getByTestId("owned-project-list")).toBeInViewport();
    await screenshot(page, "student-narrow-projects");
    expect(await recordCss(page, "after")).toEqual(cssBefore);

    const otherContext = await browser.newContext({ ignoreHTTPSErrors: true });
    try {
      await setSession(otherContext, other);
      const otherPage = await otherContext.newPage();
      await otherPage.goto("/student");
      await expect(otherPage.getByTestId("owned-project-list")).toContainText("目前沒有專案");
      await expect(otherPage.getByText("森林觀察小幫手")).toHaveCount(0);
      await expect(otherPage.getByTestId("continue-project")).toHaveCount(0);
      await otherPage.getByRole("link", { name: "▦ 我的專案" }).click();
      await screenshot(otherPage, "empty-projects");
      await otherPage.goto(`/student/projects/${project}`);
      await expect(otherPage.getByTestId("project-workspace-closed")).toBeVisible();
      await expect(otherPage.getByTestId("workspace-project-context")).toHaveCount(0);
    } finally { await otherContext.close(); }

    await page.setViewportSize({ width: 1440, height: 900 });
    await control.query("UPDATE app.projects SET created_at='infinity' WHERE id=$1", [project]);
    try {
      await page.goto("/student");
      await expect(page.getByText("專案服務暫時無法確認；不是空清單，請稍後重新載入。")).toBeVisible();
      await expect(home).toHaveCount(0);
      await expect(page.getByTestId("owned-project-list")).toHaveCount(0);
      await screenshot(page, "project-read-failure");
    } finally {
      await control.query("UPDATE app.projects SET created_at=now() WHERE id=$1", [project]);
    }
    await control.query("REVOKE SELECT ON app.projects FROM authenticated");
    try {
      await page.goto("/student");
      await expect(page.getByText("專案服務暫時無法確認；不是空清單，請稍後重新載入。")).toBeVisible();
      await expect(home).toHaveCount(0);
      await screenshot(page, "project-dependency-failure");
    } finally {
      await control.query("GRANT SELECT ON app.projects TO authenticated");
    }
    await page.goto("/student");
    await expect(home).toBeVisible();
    await control.query("UPDATE app.profiles SET status='disabled',status_changed_at=now() WHERE id=$1", [account.id]);
    await page.reload();
    await expect(page.getByText("目前帳號沒有檢視專案的權限；受保護資料已隱藏。")).toBeVisible();
    await expect(home).toHaveCount(0);
    await screenshot(page, "access-denied");
    expect(renewalError).toBeNull();
  } finally {
    clearInterval(renewal);
    await context.close(); await guest.close(); await noScript.close();
    await control.end();
  }
});

test("學生點子草稿：離頁確認、原文焦點、同頁錨點、桌機重排與失權優先", async ({ browser }) => {
  test.setTimeout(360_000);
  const control = openControlPool();
  const account = await createSyntheticAuthAccount(control, "DraftGuard");
  const project = await createOwnedSyntheticProject(account);
  const title = "很長的中文作品標題：一起觀察森林中的植物與昆蟲並記錄每天的新發現".repeat(3);
  await control.query("UPDATE app.projects SET title=$2 WHERE id=$1", [project, title]);
  const context = await browser.newContext({ ignoreHTTPSErrors: true, locale: "zh-TW",
    viewport: { width: 1440, height: 900 } });
  let renewalError: unknown = null;
  const renewal = setInterval(() => {
    setSession(context, account).catch((error: unknown) => { renewalError = error; });
  }, 30_000);
  const matrix = [];
  try {
    await setSession(context, account);
    const page = await context.newPage();
    await page.goto("/student");
    const home = page.getByTestId("student-creation-space");
    const editor = page.getByRole("textbox", { name: "我的點子草稿" });
    const dialog = page.getByTestId("student-draft-dialog");
    const text = "完整第一行\n第二行有尾端空格  \n最後一行也保留   ";
    const entrypoints = [
      page.getByRole("link", { name: "App Planet 首頁", exact: true }),
      page.getByRole("link", { name: "回到首頁與其他登入入口", exact: true }),
      page.getByTestId("owned-project-list").getByRole("link", { name: title, exact: true }),
      page.getByTestId("continue-project").getByRole("link"),
    ];
    for (const [index, link] of entrypoints.entries()) {
      await editor.fill(text);
      await link.click();
      await expect(dialog).toBeVisible();
      await expect(page.getByRole("button", { name: "留在本頁", exact: true })).toBeFocused();
      await page.getByRole("button", { name: "留在本頁", exact: true }).click();
      await expect(dialog).toBeHidden();
      await expect(editor).toHaveValue(text);
      await expect(link).toBeFocused();
      await link.focus();
      await page.keyboard.press("Enter");
      await expect(dialog).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(dialog).toBeHidden();
      await expect(editor).toHaveValue(text);
      await expect(link).toBeFocused();
      await page.keyboard.press("Enter");
      await page.keyboard.press("Tab");
      await expect(page.getByRole("button", { name: "放棄草稿並離開", exact: true })).toBeFocused();
      await page.keyboard.press("Enter");
      await expect(page).toHaveURL(index < 2 ? /\/$/ : new RegExp(`/student/projects/${project}$`),
        { timeout: 30_000 });
      if (index >= 2) await expect(page.getByTestId("workspace-project-context")).toBeVisible();
      await page.goto("/student");
      await expect(home).toBeVisible();
      await expect(editor).toHaveValue("");
      await link.click();
      await expect(dialog).toHaveCount(0);
      await expect(page).toHaveURL(index < 2 ? /\/$/ : new RegExp(`/student/projects/${project}$`),
        { timeout: 30_000 });
      await page.goto("/student");
      await expect(home).toBeVisible();
    }
    await editor.fill(text);
    for (const name of ["▦ 我的專案", "✦ 創作空間", "跳到創作空間內容"]) {
      const anchor = page.getByRole("link", { name, exact: true });
      await anchor.focus();
      await page.keyboard.press("Enter");
      await expect(dialog).toBeHidden();
      await expect(editor).toHaveValue(text);
      await expect(page.locator(name === "▦ 我的專案" ? "#my-projects" : "#student-main")).toBeFocused();
    }
    // 空白字元也是原文；不得以 trim 將它當成空草稿丟棄。
    await editor.fill(" \n  ");
    await entrypoints[0].click();
    await expect(dialog).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(editor).toHaveValue(" \n  ");

    for (const [width, height, mode] of [
      [1920, 1080, "viewport"], [1440, 900, "viewport"], [1280, 720, "viewport"],
      [1024, 768, "viewport"], [768, 768, "viewport"], [600, 900, "viewport"],
      [2560, 1440, "viewport"], [720, 450, "200%-reflow-simulation"],
    ] as const) {
      await page.setViewportSize({ width, height });
      await editor.fill(text);
      await page.evaluate(() => window.scrollTo(0, 0));
      await screenshot(page, `after-${width}x${height}-${mode}`);
      if (width <= 850) {
        await editor.scrollIntoViewIfNeeded();
        await screenshot(page, `main-${width}x${height}-${mode}`);
      }
      const measurements = await home.evaluate((element) => {
        const main = element.querySelector("main")!;
        const cards = Array.from(element.querySelectorAll('button[aria-pressed]')).map((card) => {
          const rect = card.getBoundingClientRect();
          return { x: rect.x, y: rect.y, width: rect.width };
        });
        return { scrollWidth: document.documentElement.scrollWidth, viewportWidth: innerWidth,
          mainWidth: main.getBoundingClientRect().width, cards,
          sidebarAbove: element.querySelector("aside")!.getBoundingClientRect().bottom <=
            main.getBoundingClientRect().top };
      });
      expect(measurements.scrollWidth).toBeLessThanOrEqual(width);
      expect(measurements.mainWidth).toBeLessThanOrEqual(1280);
      const columns = new Set(measurements.cards.map((card) => Math.round(card.x))).size;
      if (width >= 1280) expect(columns).toBe(3);
      if (width === 1024 || width === 600) expect(columns).toBe(2);
      if (width <= 850) expect(measurements.sidebarAbove).toBe(true);
      for (const controlLocator of [
        editor, ...["我還沒有點子", "我想開始做 App", "我想學會新知識"].map((name) =>
          page.getByRole("button", { name: new RegExp(`^${name}`) })),
        entrypoints[2], page.getByRole("textbox", { name: "專案名稱" }),
        page.getByRole("button", { name: "建立專案", exact: true }),
      ]) {
        await controlLocator.focus();
        await page.keyboard.press("Tab");
        await page.keyboard.press("Shift+Tab");
        await expect(controlLocator).toBeFocused();
        await expect(controlLocator).toBeInViewport();
        await expect.poll(() => controlLocator.evaluate((element) => {
          const rect = element.getBoundingClientRect();
          return rect.top >= 7 && rect.bottom <= innerHeight - 7;
        }), { message: `完整焦點盒：${width}x${height}` }).toBe(true);
        const focus = await controlLocator.evaluate((element) => {
          const rect = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom,
            outline: style.outlineStyle, outlineWidth: style.outlineWidth,
            viewportWidth: innerWidth, viewportHeight: innerHeight };
        });
        expect(focus.outline).toBe("solid");
        expect(focus.outlineWidth).toBe("3px");
        expect(focus.left).toBeGreaterThanOrEqual(4);
        expect(focus.right).toBeLessThanOrEqual(focus.viewportWidth - 4);
        expect(focus.top, `焦點頂緣：${width}x${height} ${await controlLocator.textContent()}`).toBeGreaterThanOrEqual(7);
        expect(focus.bottom).toBeLessThanOrEqual(focus.viewportHeight - 7);
      }
      await entrypoints[3].click();
      await expect(dialog).toBeVisible();
      const cancel = page.getByRole("button", { name: "留在本頁", exact: true });
      const discard = page.getByRole("button", { name: "放棄草稿並離開", exact: true });
      await expect(cancel).toBeFocused();
      await page.keyboard.press("Shift+Tab");
      await expect(discard).toBeFocused();
      await page.keyboard.press("Tab");
      await expect(cancel).toBeFocused();
      for (const button of [cancel, discard]) {
        await button.focus();
        await expect(button).toBeInViewport();
        const rect = await button.boundingBox();
        expect(rect).not.toBeNull();
        expect(rect!.y).toBeGreaterThanOrEqual(4);
        expect(rect!.y + rect!.height).toBeLessThanOrEqual(height - 4);
      }
      await screenshot(page, `dialog-${width}x${height}-${mode}`);
      await page.keyboard.press("Escape");
      await expect(editor).toHaveValue(text);
      await expect(entrypoints[3]).toBeFocused();
      matrix.push({ width, height, mode, ...measurements, columns, passed: true });
    }
    if (evidenceDirectory) await writeFile(path.join(evidenceDirectory, "viewport-matrix.json"),
      JSON.stringify(matrix, null, 2));

    await page.setViewportSize({ width: 1440, height: 900 });
    await editor.fill(text);
    const nativeDialogs: string[] = [];
    page.on("dialog", (nativeDialog) => {
      nativeDialogs.push(nativeDialog.type());
      void nativeDialog.dismiss();
    });
    await page.reload({ timeout: 30_000 });
    await expect(editor).toHaveValue("");
    expect(nativeDialogs).toEqual([]);

    await editor.fill(text);
    await entrypoints[0].click();
    await expect(dialog).toBeVisible();
    await control.query("UPDATE app.profiles SET status='disabled',status_changed_at=now() WHERE id=$1", [account.id]);
    // 使用既有 focus 重驗，對話框不得使可信拒絕等候使用者放棄草稿。
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(home).toBeHidden({ timeout: 30_000 });
    await expect(dialog).toBeHidden();
    await expect(page.getByText("目前帳號沒有檢視專案的權限；受保護資料已隱藏。")).toBeVisible();
    await screenshot(page, "draft-access-denied");
    await control.query("UPDATE app.profiles SET status='approved',status_changed_at=now() WHERE id=$1", [account.id]);
    await setSession(context, account);
    await page.goto("/student");
    await expect(home).toBeVisible();
    await editor.fill(text);
    clearInterval(renewal);
    await page.getByRole("button", { name: "登出", exact: true }).click();
    await expect(page).toHaveURL(/\/$/, { timeout: 30_000 });
    await expect(dialog).toHaveCount(0);
    expect(nativeDialogs).toEqual([]);
    await page.goto("/student");
    await expect(page.getByText("尚未登入或工作階段已失效；請使用核准的登入流程。")).toBeVisible();
    if (evidenceDirectory) await writeFile(path.join(evidenceDirectory, "draft-lifecycle.json"),
      JSON.stringify({ reloadProtection: "not_implemented", reloadClearedDraft: true,
        logoutWithDraftWasNotBlocked: true, nativeDialogs,
        tabClose: "not_run", browserHistory: "not_run" }, null, 2));
    expect(renewalError).toBeNull();
  } finally {
    clearInterval(renewal);
    await context.close();
    await control.end();
  }
});

test("從首頁進入既有專案：真 HTTPS 保存、快照、恢復與 reload 讀回", async ({ browser }) => {
  test.setTimeout(300_000);
  const control = openControlPool();
  const account = await createSyntheticAuthAccount(control, "HomeFiles");
  const project = await createOwnedSyntheticProject(account);
  await control.query("UPDATE app.projects SET title=$2 WHERE id=$1", [project, "星球創作練習"]);
  const context = await browser.newContext({ ignoreHTTPSErrors: true, locale: "zh-TW" });
  let renewalError: unknown = null;
  const renewal = setInterval(() => {
    setSession(context, account).catch((error: unknown) => { renewalError = error; });
  }, 30_000);
  const requests: Array<{ method: string; path: string; status: number }> = [];
  try {
    await setSession(context, account);
    const page = await context.newPage();
    page.on("response", (response) => {
      const pathname = new URL(response.url()).pathname;
      if (pathname.startsWith("/api/v1/projects")) requests.push({
        method: response.request().method(),
        path: pathname.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, "<synthetic-id>"),
        status: response.status(),
      });
    });
    await page.goto("/student");
    await page.getByRole("link", { name: "▦ 我的專案" }).click();
    await page.getByTestId("owned-project-list").getByRole("link", { name: "星球創作練習", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/student/projects/${project}$`), { timeout: 30_000 });
    await expect(page.getByTestId("workspace-project-context")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("workspace-project-context")).toContainText(project);
    await page.getByRole("link", { name: "建立 App", exact: true }).click();
    await expect(page.getByTestId("project-file-workspace")).toBeVisible({ timeout: 30_000 });
    await page.getByLabel("新增檔案名稱").fill("index.html");
    await page.getByRole("link", { name: "新增檔案", exact: true }).click();
    const editor = page.getByRole("textbox", { name: "index.html 原始碼文字編輯器" });
    await expect(editor).toBeVisible({ timeout: 30_000 });
    const save = async (text: string) => {
      await editor.press("Control+A");
      await page.keyboard.insertText(text);
      const reply = page.waitForResponse((response) =>
        new URL(response.url()).pathname === `/api/v1/projects/${project}/files/index.html`
        && response.request().method() === "PUT");
      await page.getByRole("button", { name: "保存到資料庫" }).click();
      expect([200, 201]).toContain((await reply).status());
      await expect(page.getByText(/DB 已保存版本：SHA-256/)).toBeVisible();
    };
    await save("<h1>首頁進入後保存的 A</h1>");
    const snapshotReply = page.waitForResponse((response) =>
      new URL(response.url()).pathname === `/api/v1/projects/${project}/snapshots`
      && response.request().method() === "POST");
    await page.getByRole("button", { name: "建立 manual 快照" }).click();
    expect((await snapshotReply).status()).toBe(201);
    await save("<h1>稍後要恢復的 B</h1>");
    const versionEntry = await page.getByRole("link", { name: "版本", exact: true }).getAttribute("href");
    expect(versionEntry).toBe(`/student/projects/${project}/versions`);
    if (!versionEntry) throw new Error("既有版本入口缺少連結。");
    await page.goto(versionEntry);
    await expect(page.getByTestId("project-file-workspace")).toBeVisible({ timeout: 30_000 });
    await page.getByTestId("project-file-index.html").click();
    await expect(page.locator(".monaco-editor .view-lines")).toContainText("稍後要恢復的 B");
    const row = page.locator("li").filter({ hasText: /版本 1（manual）/ });
    await expect(row.getByRole("button", { name: "查看並恢復此版本" })).toBeEnabled();
    const manifestReply = page.waitForResponse((response) =>
      new URL(response.url()).pathname.endsWith("/manifest") && response.request().method() === "GET");
    await row.getByRole("button", { name: "查看並恢復此版本" }).click();
    expect((await manifestReply).status()).toBe(200);
    const confirmation = page.getByRole("alertdialog", { name: "確認完整恢復版本" });
    await expect(confirmation).toBeVisible();
    const restoreReply = page.waitForResponse((response) =>
      new URL(response.url()).pathname === `/api/v1/projects/${project}/restore`
      && response.request().method() === "POST");
    await confirmation.getByRole("button", { name: "確認完整取代並恢復" }).click();
    expect((await restoreReply).status()).toBe(200);
    await expect(page.getByText("恢復已由伺服器收據確認；目前檔案與版本已重新讀取，並已選取恢復前版本。"))
      .toBeVisible({ timeout: 30_000 });
    await expect(confirmation).toHaveCount(0, { timeout: 30_000 });
    await page.reload();
    await expect(page.getByTestId("project-file-index.html")).toBeVisible({ timeout: 30_000 });
    await page.getByTestId("project-file-index.html").click();
    await expect(page.locator(".monaco-editor .view-lines")).toContainText("首頁進入後保存的 A");
    const saved = await control.query(`SELECT convert_from(blob.content,'UTF8') AS content
      FROM app.project_files AS file JOIN app.blobs AS blob ON blob.hash=file.blob_hash
      WHERE file.project_id=$1 AND file.path='index.html'`, [project]);
    expect(saved.rows).toEqual([{ content: "<h1>首頁進入後保存的 A</h1>" }]);
    if (evidenceDirectory) {
      await page.getByTestId("project-file-workspace").screenshot({ path: path.join(evidenceDirectory, "files-restored.png") });
    }
    expect(renewalError).toBeNull();
  } finally {
    clearInterval(renewal);
    await context.close();
    await control.end();
    if (evidenceDirectory) await writeFile(path.join(evidenceDirectory, "files-https-requests.json"),
      JSON.stringify(requests, null, 2));
  }
});
