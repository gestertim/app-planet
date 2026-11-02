import { expect, test, type Dialog, type Page } from "@playwright/test";
import {
  createSyntheticAuthAccount, deleteSyntheticAuthAccount, loginSyntheticAccount, openControlPool,
} from "../support/real-auth-fixture.ts";
import { sessionCookieName } from "../../apps/web/src/server/auth-principal.ts";

const stageStatePattern = (n: number) => `[data-testid="stage-row-${n}"]`;
type NavigationProbe = Readonly<{
  navigationType: string;
  canIntercept: boolean;
  cancelable: boolean;
  destination: string;
  sameDocument: boolean;
}>;

test("真 Auth／Next HTTPS／DB：九階段總覽、導航與未保存離開防護（兩個專案）", async ({ browser }) => {
  test.setTimeout(300_000);
  const control = openControlPool();
  const account = await createSyntheticAuthAccount(control, "OverviewBrowser");
  const session = await loginSyntheticAccount(account);
  const appOrigin = process.env.APP_PLANET_APP_ORIGIN;
  if (!appOrigin) throw new Error("隔離瀏覽器測試缺少本機 app origin。");
  const context = await browser.newContext({ locale: "zh-TW" });
  const projectIds: string[] = [];
  try {
    await context.addCookies([{
      name: sessionCookieName, value: session.accessToken, url: appOrigin,
      httpOnly: true, secure: true, sameSite: "Strict",
    }]);
    const page = await context.newPage();
    await page.addInitScript(() => {
      const trace: NavigationProbe[] = [];
      Object.defineProperty(window, "__appPlanetNavigateTrace", { value: trace });
      window.navigation.addEventListener("navigate", (event) => {
        trace.push({
          navigationType: event.navigationType,
          canIntercept: event.canIntercept,
          cancelable: event.cancelable,
          destination: event.destination.url,
          sameDocument: event.destination.sameDocument,
        });
      }, { capture: true });
    });
    const create = async (name: string) => {
      await page.goto(`${appOrigin}/student`);
      await page.getByLabel("專案名稱").fill(name);
      const created = page.waitForResponse((r) =>
        new URL(r.url()).pathname === "/api/v1/projects" && r.request().method() === "POST");
      await page.getByRole("button", { name: "建立專案", exact: true }).click();
      const response = await created;
      expect(response.status()).toBe(201);
      const id = (await response.json()).id as string;
      projectIds.push(id);
      return id;
    };
    const p1 = await create("總覽專案一");
    const p2 = await create("總覽專案二");
    const count = async (sql: string, args: unknown[]) => (await control.query(sql, args)).rows[0].n as number;
    const renewTestSession = async () => {
      const current = await loginSyntheticAccount(account);
      await context.addCookies([{
        name: sessionCookieName, value: current.accessToken, url: appOrigin,
        httpOnly: true, secure: true, sameSite: "Strict",
      }]);
    };

    // 正式七頁籤：直接網址、reload、active 狀態與未就緒標示。
    const tabs = [
      { href: "", key: "blueprint", label: "我的藍圖", ready: true },
      { href: "/design", key: "design", label: "畫面設計", ready: true },
      { href: "/plan", key: "plan", label: "創作計畫", ready: true },
      { href: "/build", key: "build", label: "建立 App", ready: false },
      { href: "/test", key: "test", label: "測試", ready: false },
      { href: "/versions", key: "versions", label: "版本", ready: false },
      { href: "/publish", key: "publish", label: "發布", ready: false },
    ] as const;
    for (const tab of tabs) {
      await page.goto(`${appOrigin}/student/projects/${p1}${tab.href}`);
      const activeTab = page.getByTestId("project-workspace-tabs")
        .getByRole("link", { name: tab.label, exact: true });
      await expect(activeTab).toHaveAttribute("aria-current", "page");
      await expect(page.getByTestId("workspace-project-id")).toHaveText(p1);
      if (tab.key === "blueprint") await expect(page.getByTestId("stage-overview")).toBeVisible();
      if (tab.key === "design") await expect(page.getByTestId("workspace-design")).toBeVisible();
      if (tab.key === "plan") {
        await expect(page.getByTestId("workspace-plan")).toBeVisible();
        await expect(page.getByTestId("project-task-import")).toBeVisible();
        await expect(page.getByTestId("project-task-list")).toBeVisible();
      }
      if (!tab.ready) {
        await expect(page.getByTestId(`workspace-unready-${p1}`)).toContainText("尚未就緒");
      }
      await page.reload();
      await expect(activeTab).toHaveAttribute("aria-current", "page");
      await expect(page.getByTestId("workspace-project-id")).toHaveText(p1);
    }
    for (const stage of [
      { route: "Specification", tab: "blueprint" },
      { route: "UX%2FUI", tab: "design" },
      { route: "Technical%20Plan", tab: "plan" },
    ]) {
      await page.goto(`${appOrigin}/student/projects/${p1}/stages/${stage.route}`);
      await expect(page.getByTestId("project-workspace-tabs").locator(`[data-tab="${stage.tab}"]`))
        .toHaveAttribute("aria-current", "page");
      await page.reload();
      await expect(page.getByTestId("project-workspace-tabs").locator(`[data-tab="${stage.tab}"]`))
        .toHaveAttribute("aria-current", "page");
    }
    await renewTestSession();
    expect((await context.cookies(appOrigin)).some((cookie) => cookie.name === sessionCookieName)).toBe(true);
    await page.goto(`${appOrigin}/student/projects/${p2}`);
    await expect(page.getByTestId("workspace-project-id")).toHaveText(p2);
    await expect(page.getByRole("heading", { name: "總覽專案二", exact: true })).toBeVisible();
    await expect(page.locator(stageStatePattern(3))).toHaveAttribute("data-state", "no_draft");

    // 1. 總覽：九階段、無稿
    await page.goto(`${appOrigin}/student/projects/${p1}`);
    const overview = page.getByTestId("stage-overview");
    await expect(overview).toBeVisible();
    for (let i = 1; i <= 9; i += 1) {
      await expect(page.locator(stageStatePattern(i))).toHaveAttribute("data-state", "no_draft");
    }
    await expect(overview).toContainText("IDE、測試、版本與發布能力尚未就緒");
    await expect(page.getByTestId("completion-judgment")).toContainText("保持阻擋");

    // 2. 進入階段頁；保存 → 未確認 → 確認 → 總覽一致
    await page.getByRole("link", { name: "開啟 Specification 草稿", exact: true }).click();
    await expect(page).toHaveURL(`${appOrigin}/student/projects/${p1}/stages/Specification`);
    const editor = page.getByLabel("階段草稿文字");
    const save = page.getByRole("button", { name: "保存", exact: true });
    await editor.fill("第一版");
    await save.click();
    await expect(page.getByText("已確認版本 0。")).toBeVisible();
    await page.getByTestId("confirm-saved-version").click();
    await expect(page.getByTestId("confirmation-headline")).toHaveAttribute("data-state", "confirmed_current");
    await page.getByRole("link", { name: "回到九階段總覽" }).click();
    await expect(page.locator(stageStatePattern(3))).toHaveAttribute("data-state", "confirmed_current");
    await page.reload();
    await expect(page.locator(stageStatePattern(3))).toHaveAttribute("data-state", "confirmed_current");
    await expect(page.locator(stageStatePattern(3))).toContainText("人工批准：尚未取得");

    // 3. 再保存 → 失效；改回相同文字不復活
    await page.getByRole("link", { name: "開啟 Specification 草稿", exact: true }).click();
    await editor.fill("第二版");
    await save.click();
    await expect(page.getByText("已確認版本 1。")).toBeVisible();
    await editor.fill("第一版");
    await save.click();
    await expect(page.getByText("已確認版本 2。")).toBeVisible();
    await expect(page.getByTestId("confirmation-headline")).not.toHaveAttribute("data-state", "confirmed_current");
    await page.getByRole("link", { name: "回到九階段總覽" }).click();
    await expect(page.locator(stageStatePattern(3))).toHaveAttribute("data-state", "confirmation_stale");

    // 專案二不受影響
    await page.goto(`${appOrigin}/student/projects/${p2}`);
    await expect(page.locator(stageStatePattern(3))).toHaveAttribute("data-state", "no_draft");

    // 4. dirty 離開：取消（留在目前頁面）
    await renewTestSession();
    await page.goto(`${appOrigin}/student/projects/${p1}/stages/Specification`);
    await page.waitForLoadState("networkidle");
    await editor.fill("未保存的變更");
    await page.getByRole("link", { name: "點子", exact: true }).click();
    const dialog = page.getByTestId("unsaved-changes-dialog");
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "留在目前頁面" }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page).toHaveURL(`${appOrigin}/student/projects/${p1}/stages/Specification`);
    await expect(editor).toHaveValue("未保存的變更");
    expect(await count("SELECT count(*)::int n FROM app.stage_records WHERE project_id=$1 AND stage='點子'", [p1])).toBe(0);

    // 5. 保存後離開（切階段）
    await page.getByRole("link", { name: "點子", exact: true }).click();
    await dialog.getByRole("button", { name: /保存後離開/ }).click();
    await expect(page).toHaveURL(`${appOrigin}/student/projects/${p1}/stages/${encodeURIComponent("點子")}`, { timeout: 30_000 });
    expect(await count(
      "SELECT count(*)::int n FROM app.stage_records WHERE project_id=$1 AND stage='Specification' AND content->>'text'='未保存的變更'",
      [p1])).toBe(1);

    // 6. dirty 頁籤：留下後保留內容，再保存後切換至設計頁。
    await renewTestSession();
    await page.goto(`${appOrigin}/student/projects/${p1}/stages/Specification`);
    await editor.fill("頁籤切換保存的內容");
    const designTab = page.getByRole("link", { name: "畫面設計", exact: true });
    await designTab.click();
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "留在目前頁面" }).click();
    await expect(editor).toHaveValue("頁籤切換保存的內容");
    await designTab.click();
    await dialog.getByRole("button", { name: /保存後離開/ }).click();
    await expect(page).toHaveURL(`${appOrigin}/student/projects/${p1}/design`);
    expect(await count(
      "SELECT count(*)::int n FROM app.stage_records WHERE project_id=$1 AND stage='Specification' AND content->>'text'='頁籤切換保存的內容'",
      [p1])).toBe(1);

    // 7. dirty 專案切換：取消後保留、保存後離開，再從列表切至另一專案。
    await renewTestSession();
    await page.goto(`${appOrigin}/student/projects/${p1}/stages/Specification`);
    await editor.fill("專案切換保存的內容");
    const workbench = page.getByRole("link", { name: "工作台" }).first();
    await workbench.click();
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "留在目前頁面" }).click();
    await expect(editor).toHaveValue("專案切換保存的內容");
    await workbench.click();
    await dialog.getByRole("button", { name: /保存後離開/ }).click();
    await expect(page).toHaveURL(`${appOrigin}/student`, { timeout: 30_000 });
    await page.getByTestId("owned-project-list").getByRole("link", { name: "總覽專案二" }).click();
    await expect(page.getByTestId("workspace-project-id")).toHaveText(p2);

    // 8. 明確放棄後切換專案；列表與另一專案不繼承被放棄內容。
    await renewTestSession();
    await page.goto(`${appOrigin}/student/projects/${p2}/stages/Specification`);
    await editor.fill("將被放棄");
    await workbench.click();
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "放棄本頁修改並離開" }).click();
    await expect(page).toHaveURL(`${appOrigin}/student`, { timeout: 30_000 });
    expect(await count(
      "SELECT count(*)::int n FROM app.stage_records WHERE project_id=$1 AND stage='Specification' AND content->>'text'='將被放棄'",
      [p2])).toBe(0);
    await page.getByTestId("owned-project-list").getByRole("link", { name: "總覽專案一" }).click();
    await expect(page.getByTestId("workspace-project-id")).toHaveText(p1);

    // 9. 保存期間再編輯：舊成功回應不吞掉新編輯，離開前仍攔截
    await renewTestSession();
    await page.goto(`${appOrigin}/student/projects/${p2}/stages/Specification`);
    await page.waitForLoadState("networkidle");
    await editor.fill("保存中 v1");
    await page.route("**/api/v1/projects/*/stages/*", async (route) => {
      if (route.request().method() !== "PUT") return route.continue();
      await new Promise((r) => setTimeout(r, 1500));
      return route.continue();
    }, { times: 1 });
    await save.click();
    await editor.fill("保存中 v1 之後再編輯");
    await expect(page.getByText("已確認版本 0。")).toBeVisible({ timeout: 30_000 });
    await expect(editor).toHaveValue("保存中 v1 之後再編輯");
    await page.getByRole("link", { name: "回到九階段總覽" }).click();
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "留在目前頁面" }).click();

    // 8. 畸形成功回應：不算已保存，仍不可離開
    await page.route("**/api/v1/projects/*/stages/*", (route) => route.request().method() === "PUT"
      ? route.fulfill({ status: 200, contentType: "application/json", body: "{\"bogus\":true}" }) : route.continue(), { times: 1 });
    await save.click();
    await page.getByRole("link", { name: "回到九階段總覽" }).click();
    await expect(dialog).toBeVisible();
    await expect(page).toHaveURL(`${appOrigin}/student/projects/${p2}/stages/Specification`);
    await dialog.getByRole("button", { name: "留在目前頁面" }).click();
    await page.getByRole("button", { name: "使用原操作鍵重試", exact: true }).click();
    await expect(page.getByTestId("confirmed-server-draft"))
      .toContainText("保存中 v1 之後再編輯");
    await editor.fill("歷史導航已保存基準");
    await save.click();
    await expect(page.getByText("已確認版本 2。")).toBeVisible();

    // 保存已編輯內容，建立真實 forward entry，再驗證返回／前進取消不移動歷史。
    await renewTestSession();
    await expect(page.getByTestId("confirmed-server-draft")).toContainText("歷史導航已保存基準");
    await page.getByRole("link", { name: "我的藍圖", exact: true }).click();
    await page.getByRole("link", { name: "畫面設計", exact: true }).click();
    await page.getByRole("link", { name: "我的藍圖", exact: true }).click();
    await page.getByTestId("workspace-stage-Specification")
      .getByRole("link", { name: "開啟 Specification 草稿與學生確認", exact: true }).click();
    await expect(page).toHaveURL(`${appOrigin}/student/projects/${p2}/stages/Specification`);
    await page.getByRole("link", { name: "畫面設計", exact: true }).click();
    await expect(page).toHaveURL(`${appOrigin}/student/projects/${p2}/design`);
    const historyChain = await page.evaluate(() =>
      window.navigation.entries().map((entry) => ({
        index: entry.index,
        url: entry.url,
        sameDocument: entry.sameDocument,
      })));
    console.log(`workspace-history-chain=${JSON.stringify(historyChain)}`);
    await page.goBack();
    await expect(page).toHaveURL(`${appOrigin}/student/projects/${p2}/stages/Specification`);
    await editor.fill("歷史鏈取消後仍保留的本頁內容");
    const history = await page.evaluate(() => {
      const nav = window.navigation;
      const entries = nav.entries();
      const current = nav.currentEntry;
      if (!current) throw new Error("Navigation API 沒有目前歷史項目。");
      const position = entries.findIndex((entry) => entry.key === current.key);
      return {
        index: current.index,
        key: current.key,
        state: JSON.stringify(window.history.state),
        url: window.location.href,
        back: entries[position - 1]?.url ?? null,
        multi: entries[position - 2]?.url ?? null,
        forward: entries[position + 1]?.url ?? null,
        backSameDocument: entries[position - 1]?.sameDocument ?? false,
        multiSameDocument: entries[position - 2]?.sameDocument ?? false,
        forwardSameDocument: entries[position + 1]?.sameDocument ?? false,
      };
    });
    expect(history.back).toBeTruthy();
    expect(history.multi).toBeTruthy();
    expect(history.forward).toContain("/design");
    await expect(page.getByText(/重新載入、關閉分頁/)).toBeVisible();
    const traverseHistory = async (delta: number, destination: string, leave: boolean) => {
      let nativePrompt: string | null = null;
      const before = await page.evaluate(() => {
        const trace = (window as Window & { __appPlanetNavigateTrace?: NavigationProbe[] })
          .__appPlanetNavigateTrace;
        return trace?.length ?? 0;
      });
      const handleNativeDialog = async (nativeDialog: Dialog) => {
        nativePrompt = nativeDialog.type();
        if (leave) await nativeDialog.accept();
        else await nativeDialog.dismiss();
      };
      page.on("dialog", handleNativeDialog);
      await page.evaluate((offset) => window.history.go(offset), delta);
      await expect.poll(() => page.evaluate(() =>
        (window as Window & { __appPlanetNavigateTrace?: NavigationProbe[] })
          .__appPlanetNavigateTrace?.length ?? 0)).toBeGreaterThan(before);
      const event = await page.evaluate(() =>
        (window as Window & { __appPlanetNavigateTrace?: NavigationProbe[] })
          .__appPlanetNavigateTrace?.at(-1) ?? null);
      expect(event?.navigationType).toBe("traverse");
      expect(event?.destination).toBe(destination);
      const interceptable = Boolean(event?.canIntercept && event.cancelable);
      if (interceptable) {
        await expect(dialog).toBeVisible();
        await expect(dialog).toHaveAttribute("data-destination", destination);
        await dialog.getByRole("button", {
          name: leave ? "放棄本頁修改並離開" : "留在目前頁面",
        }).click();
      } else {
        await expect.poll(() => nativePrompt).toBe("beforeunload");
        await expect.poll(() => page.url()).toBe(leave ? destination : history.url);
      }
      page.off("dialog", handleNativeDialog);
      if (leave) {
        await expect(page).toHaveURL(destination);
      } else {
        await expect(page).toHaveURL(history.url);
        expect(await page.evaluate(() => window.navigation.currentEntry?.index)).toBe(history.index);
        expect(await page.evaluate(() => JSON.stringify(window.history.state))).toBe(history.state);
        await expect(editor).toHaveValue("歷史鏈取消後仍保留的本頁內容");
      }
      return interceptable;
    };
    const backMode = await traverseHistory(-1, history.back!, false);
    await traverseHistory(-1, history.back!, false);
    const forwardMode = await traverseHistory(1, history.forward!, false);
    const multiStepMode = await traverseHistory(-2, history.multi!, false);
    await traverseHistory(-2, history.multi!, true);
    console.log(`history-interception=${JSON.stringify({
      back: backMode ? "Navigation API" : "native beforeunload",
      forward: forwardMode ? "Navigation API" : "native beforeunload",
      multiStep: multiStepMode ? "Navigation API" : "native beforeunload",
    })}`);

    await page.goto(`${appOrigin}/student/projects/${p2}/stages/Specification`);
    await editor.fill("重新載入前的記憶體內容");
    let reloadPrompt: string | null = null;
    page.once("dialog", async (nativeDialog) => {
      reloadPrompt = nativeDialog.type();
      await nativeDialog.accept();
    });
    await page.reload();
    expect(reloadPrompt).toBe("beforeunload");
    await expect(editor).toHaveValue("歷史導航已保存基準");

    await editor.fill("跨文件返回取消後仍保留的內容");
    let crossDocumentPrompt: string | null = null;
    page.once("dialog", (nativeDialog) => {
      crossDocumentPrompt = nativeDialog.type();
      void nativeDialog.dismiss().catch(() => undefined);
    });
    const currentUrl = page.url();
    await page.evaluate(() => window.history.back());
    await expect.poll(() => page.url()).toBe(currentUrl);
    await expect.poll(() => crossDocumentPrompt).toBe("beforeunload");
    await expect(editor).toHaveValue("跨文件返回取消後仍保留的內容");

    // 10. 鍵盤與焦點：Escape 取消後焦點回到觸發連結
    await renewTestSession();
    await page.goto(`${appOrigin}/student/projects/${p2}/stages/Specification`);
    await editor.fill("鍵盤取消後仍保留的本頁內容");
    const trigger = page.getByRole("link", { name: "回到九階段總覽" });
    await trigger.focus();
    await page.keyboard.press("Enter");
    await expect(dialog).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(trigger).toBeFocused();

    // 11. IME 組字期間 Enter 不誤觸保存／切頁
    const cdp = await context.newCDPSession(page);
    const before = await count("SELECT row_version n FROM app.stage_records WHERE project_id=$1 AND stage='Specification'", [p2]);
    await editor.focus();
    await cdp.send("Input.imeSetComposition", { text: "ㄅㄆ", selectionStart: 2, selectionEnd: 2 });
    await expect(save).toBeDisabled();
    await cdp.send("Input.insertText", { text: "組字完成" });
    expect(await count("SELECT row_version n FROM app.stage_records WHERE project_id=$1 AND stage='Specification'", [p2])).toBe(before);

    // 12. 真實提交後 response-loss：重試必須沿用原鍵且不可重複寫入。
    await renewTestSession();
    const savePath = `/api/v1/projects/${p2}/stages/Specification`;
    const currentVersion = async () => count(
      "SELECT row_version n FROM app.stage_records WHERE project_id=$1 AND stage='Specification'", [p2]);
    const versionBeforeResponseLoss = await currentVersion();
    const saveKeys: string[] = [];
    page.on("request", (request) => {
      if (new URL(request.url()).pathname !== savePath || request.method() !== "PUT") return;
      const key = request.headers()["idempotency-key"];
      if (key) saveKeys.push(key);
    });
    let responseLossStatus: number | null = null;
    await editor.fill("階段保存 response-loss 的原操作");
    await page.route(`**${savePath}`, async (route) => {
      if (route.request().method() !== "PUT") return route.continue();
      const response = await route.fetch();
      responseLossStatus = response.status();
      await route.abort("connectionreset");
    }, { times: 1 });
    await save.click();
    await expect(page.locator("#operation-status")).toHaveAttribute("data-kind", "outcome_unknown");
    expect(responseLossStatus).toBe(200);
    expect(await currentVersion()).toBe(versionBeforeResponseLoss + 1);
    await page.getByRole("button", { name: "使用原操作鍵重試", exact: true }).click();
    await expect(page.getByTestId("operation-receipt")).toContainText("階段保存 response-loss 的原操作");
    expect(saveKeys).toHaveLength(2);
    expect(saveKeys[1]).toBe(saveKeys[0]);
    expect(await currentVersion()).toBe(versionBeforeResponseLoss + 1);

    // 13. 另一分頁先更新；舊版本提交必須收到真實 409 並保留本地內容。
    const stalePage = await context.newPage();
    await stalePage.goto(`${appOrigin}/student/projects/${p2}/stages/Specification`);
    const staleEditor = stalePage.getByLabel("階段草稿文字");
    await expect(stalePage.getByTestId("confirmed-server-draft"))
      .toContainText("階段保存 response-loss 的原操作");
    await editor.fill("另一分頁已保存的較新版本");
    await save.click();
    await expect(page.locator("#operation-status")).toHaveAttribute("data-kind", "saved");
    await expect(staleEditor).toHaveValue("階段保存 response-loss 的原操作");
    const conflictResponsePromise = stalePage.waitForResponse((response) =>
      new URL(response.url()).pathname === savePath && response.request().method() === "PUT");
    await staleEditor.fill("409 後仍保留的本地內容");
    await stalePage.getByRole("button", { name: "保存", exact: true }).click();
    expect((await conflictResponsePromise).status()).toBe(409);
    await expect(stalePage.getByRole("button", { name: "查看版本衝突說明" })).toBeVisible();
    await expect(staleEditor).toHaveValue("409 後仍保留的本地內容");
    const conflictDialog = stalePage.getByRole("dialog", { name: "版本衝突：草稿仍保留" });
    await stalePage.getByRole("button", { name: "查看版本衝突說明" }).click();
    await expect(conflictDialog).toContainText("另一分頁已保存的較新版本");
    await expect(conflictDialog).toContainText("409 後仍保留的本地內容");
    await conflictDialog.getByRole("button", { name: "關閉" }).click();
    await stalePage.getByRole("link", { name: "我的藍圖", exact: true }).click();
    const conflictGuard = stalePage.getByTestId("unsaved-changes-dialog");
    await expect(conflictGuard).toBeVisible();
    await expect(conflictGuard.getByRole("button", { name: "保存後離開" })).toHaveCount(0);
    await conflictGuard.getByRole("button", { name: "留在目前頁面" }).click();
    await expect(staleEditor).toHaveValue("409 後仍保留的本地內容");
    await stalePage.close();

    // 14. 失權後隱藏總覽；DB 狀態不被改動。
    await editor.fill("另一分頁已保存的較新版本");
    await editor.blur();
    await expect(save).toBeDisabled();
    page.on("dialog", (d) => void d.accept());
    await page.goto(`${appOrigin}/student/projects/${p1}`);
    await control.query("UPDATE app.profiles SET status='disabled' WHERE id=$1", [account.id]);
    await page.reload();
    await expect(page.getByTestId("stage-overview")).toHaveCount(0);
    await control.query("UPDATE app.profiles SET status='approved' WHERE id=$1", [account.id]);

    for (const id of [p1, p2]) {
      expect((await control.query("SELECT stage,classification_state FROM app.projects WHERE id=$1", [id])).rows)
        .toEqual([{ stage: "點子", classification_state: "unconfirmed" }]);
      expect(await count("SELECT count(*)::int n FROM app.stage_records WHERE project_id=$1 AND (state<>'ai_draft' OR approved_by IS NOT NULL)", [id])).toBe(0);
    }
  } finally {
    await context.close();
    if (projectIds.length) {
      await control.query("DELETE FROM app.stage_draft_confirmations WHERE project_id=ANY($1::uuid[])", [projectIds]);
      await control.query("DELETE FROM app.stage_draft_idempotency WHERE project_id=ANY($1::uuid[])", [projectIds]);
      await control.query("DELETE FROM app.stage_records WHERE project_id=ANY($1::uuid[])", [projectIds]);
      await control.query("DELETE FROM app.project_create_idempotency WHERE project_id=ANY($1::uuid[])", [projectIds]);
      await control.query("DELETE FROM app.projects WHERE id=ANY($1::uuid[])", [projectIds]);
    }
    await control.query("DELETE FROM app.profiles WHERE id=$1", [account.id]);
    await control.query("DELETE FROM app.schools WHERE id=$1", [account.schoolId]);
    await deleteSyntheticAuthAccount(account);
    await control.end();
  }
});

export type _Unused = Page;
