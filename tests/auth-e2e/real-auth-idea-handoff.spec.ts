import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect as baseExpect, test, type BrowserContext, type Page } from "@playwright/test";
import {
  createOwnedSyntheticProject, createSyntheticAuthAccount, deleteSyntheticAuthAccount,
  loginSyntheticAccount, openControlPool, type SyntheticAuthAccount,
} from "../support/real-auth-fixture.ts";
import { sessionCookieName } from "../../apps/web/src/server/auth-principal.ts";

const expect = baseExpect.configure({ timeout: 15_000 });
const raw = "我想幫同學找書 📚\n保留第二行\n尾端空格  ";
const origin = () => {
  if (!process.env.APP_PLANET_APP_ORIGIN) throw new Error("缺少隔離 HTTPS origin");
  return process.env.APP_PLANET_APP_ORIGIN;
};
const ideaPath = (id: string) => `/student/projects/${id}/stages/${encodeURIComponent("點子")}`;
async function session(context: BrowserContext, account: SyntheticAuthAccount) {
  const auth = await loginSyntheticAccount(account);
  await context.addCookies([{ name: sessionCookieName, value: auth.accessToken, url: origin(),
    httpOnly: true, secure: true, sameSite: "Strict" }]);
}
async function evidence(page: Page, name: string) {
  const directory = process.env.APP_PLANET_UI_EVIDENCE_DIR;
  if (!directory) return;
  await mkdir(directory, { recursive: true });
  await page.screenshot({ path: path.join(directory, `${name}.png`), fullPage: true, caret: "initial",
    mask: [page.getByTestId("workspace-project-context")],
    style: "nextjs-portal { visibility: hidden; }" });
}
async function assertNoSavedIdea(control: ReturnType<typeof openControlPool>, id: string) {
  expect((await control.query("SELECT count(*)::int AS n FROM app.stage_records WHERE project_id=$1 AND stage='點子'",
    [id])).rows[0].n).toBe(0);
}
async function cleanup(control: ReturnType<typeof openControlPool>, accounts: SyntheticAuthAccount[]) {
  for (const account of accounts) {
    for (const table of ["stage_draft_idempotency", "stage_records", "project_create_idempotency"]) {
      await control.query(`DELETE FROM app.${table} WHERE project_id IN (SELECT id FROM app.projects WHERE owner_id=$1)`,
        [account.id]);
    }
    await control.query("DELETE FROM app.projects WHERE owner_id=$1", [account.id]);
    await control.query("DELETE FROM app.profiles WHERE id=$1", [account.id]);
    await control.query("DELETE FROM app.schools WHERE id=$1", [account.schoolId]);
    await deleteSyntheticAuthAccount(account);
  }
  await control.end();
}
async function choose(page: Page) {
  await page.getByLabel("我的點子草稿").fill(raw);
  await page.getByRole("button", { name: "將點子帶入新專案", exact: true }).click();
  await expect(page.getByTestId("idea-carry-status")).toContainText("尚未建立或保存");
}

test("無作品首頁 → 明確帶入 → 未儲存原文 → 學生保存 → reload；取消與不帶入原路徑", async ({ browser }) => {
  const control = openControlPool();
  const account = await createSyntheticAuthAccount(control, "IdeaHandoff");
  const context = await browser.newContext({ locale: "zh-TW", ignoreHTTPSErrors: true });
  try {
    await session(context, account);
    const page = await context.newPage();
    await page.goto(`${origin()}/student`);
    await expect(page.getByTestId("owned-project-list")).toContainText("目前沒有專案");
    let writes = 0;
    page.on("request", (request) => { if (request.method() === "POST" || request.method() === "PUT") writes++; });
    await page.getByRole("button", { name: /^我想開始做 App/ }).click();
    await choose(page);
    expect(writes).toBe(0);
    await page.getByRole("button", { name: "取消帶入", exact: true }).click();
    await expect(page.getByLabel("我的點子草稿")).toHaveValue(raw);
    expect(writes).toBe(0);
    await page.getByRole("button", { name: "將點子帶入新專案", exact: true }).click();
    await evidence(page, "01-home-selected");
    await page.getByLabel("專案名稱").fill("找書小幫手");
    const creation = page.waitForResponse((r) => new URL(r.url()).pathname === "/api/v1/projects");
    await page.getByRole("button", { name: "建立專案", exact: true }).click();
    const response = await creation;
    expect(response.status()).toBe(201);
    expect(response.request().postDataJSON()).toEqual({ title: "找書小幫手" });
    const id = (await response.json()).id as string;
    await expect(page).toHaveURL(`${origin()}${ideaPath(id)}`);
    await expect(page.getByLabel("階段草稿文字")).toHaveValue(raw);
    await expect(page.getByTestId("idea-handoff-status")).toContainText("未儲存");
    await expect(page.locator("#operation-status")).toHaveAttribute("data-kind", "unsaved");
    await expect(page.locator("#operation-status")).toHaveAttribute("data-code", "never_saved");
    await expect(page.getByTestId("confirmed-server-draft")).toHaveCount(0);
    await assertNoSavedIdea(control, id);
    expect(writes).toBe(1);
    await evidence(page, "02-editor-unsaved");
    await page.getByRole("button", { name: "保存", exact: true }).click();
    await expect(page.getByTestId("confirmed-server-draft")).toContainText("伺服器版本 0");
    expect((await control.query("SELECT content->>'text' AS text FROM app.stage_records WHERE project_id=$1 AND stage='點子'",
      [id])).rows[0].text).toBe(raw);
    await page.getByLabel("階段草稿文字").fill(`${raw}\n保存後的新編輯  `);
    await expect(page.locator("#operation-status")).toHaveAttribute("data-kind", "unsaved");
    await expect(page.getByRole("button", { name: "放棄帶入", exact: true })).toHaveCount(0);
    await expect(page.getByLabel("階段草稿文字")).toHaveValue(`${raw}\n保存後的新編輯  `);
    expect(writes).toBe(2);
    expect((await control.query("SELECT content->>'text' AS text FROM app.stage_records WHERE project_id=$1 AND stage='點子'",
      [id])).rows[0].text).toBe(raw);
    await evidence(page, "f01-saved-then-edited-no-discard");
    await page.reload();
    await expect(page.getByLabel("階段草稿文字")).toHaveValue(raw);
    await expect(page.getByTestId("idea-handoff-status")).toHaveCount(0);
    await evidence(page, "03-reload-saved");
    await page.goto(`${origin()}/student`);
    await page.getByLabel("專案名稱").fill("不帶入原路徑");
    const plainCreate = page.waitForResponse((r) => new URL(r.url()).pathname === "/api/v1/projects");
    await page.getByRole("button", { name: "建立專案", exact: true }).click();
    const plainId = (await (await plainCreate).json()).id as string;
    await expect(page.getByRole("link", { name: "開啟剛建立的專案", exact: true })).toBeVisible();
    await expect(page).toHaveURL(`${origin()}/student`);
    await page.goto(`${origin()}${ideaPath(plainId)}`);
    await expect(page.getByLabel("階段草稿文字")).toHaveValue("");
    await assertNoSavedIdea(control, plainId);
  } finally {
    await context.close();
    await cleanup(control, [account]);
  }
});

for (const occupied of [false, true]) {
  test(`首次建立已 COMMIT 但回應遺失；原鍵查回一次${occupied ? "且保護已有內容" : "，同頁原文帶入一次與帳號／專案隔離"}`, async ({ browser }) => {
    const control = openControlPool();
    const account = await createSyntheticAuthAccount(control, "IdeaRecovery");
    const other = await createSyntheticAuthAccount(control, "IdeaOther");
    const context = await browser.newContext({ locale: "zh-TW", ignoreHTTPSErrors: true });
    const otherContext = await browser.newContext({ locale: "zh-TW", ignoreHTTPSErrors: true });
    try {
      await session(context, account);
      await session(otherContext, other);
      const page = await context.newPage();
      await page.goto(`${origin()}/student`);
      await expect(page.getByTestId("owned-project-list")).toContainText("目前沒有專案");
      await choose(page);
      await page.getByLabel("專案名稱").fill("查回原專案");
      let id = "", originalKey = "", creates = 0, recoveries = 0;
      await page.route("**/api/v1/projects", async (route) => {
        creates++;
        originalKey = route.request().headers()["idempotency-key"];
        const response = await route.fetch();
        expect(response.status()).toBe(201);
        id = (await response.json()).id;
        await route.abort("failed");
      });
      await page.getByRole("button", { name: "建立專案", exact: true }).click();
      await expect(page.getByRole("button", { name: "只查詢原操作", exact: true })).toBeEnabled();
      await expect(page.getByLabel("我的點子草稿")).toHaveValue(raw);
      expect(creates).toBe(1);
      expect((await control.query("SELECT count(*)::int AS n FROM app.projects WHERE owner_id=$1", [account.id])).rows[0].n)
        .toBe(1);
      expect(await page.evaluate((text) => [...Object.values(sessionStorage), ...Object.values(localStorage)]
        .some((value) => value.includes(text)), "我想幫同學找書")).toBe(false);
      const sibling = await context.newPage();
      await sibling.goto(`${origin()}${ideaPath(id)}`);
      await expect(sibling.getByLabel("階段草稿文字")).toHaveValue("");
      if (occupied) {
        await sibling.getByLabel("階段草稿文字").fill("另一頁已保存的原文  ");
        await sibling.getByRole("button", { name: "保存", exact: true }).click();
        await expect(sibling.getByTestId("confirmed-server-draft")).toContainText("伺服器版本 0");
      }
      const anotherProject = await createOwnedSyntheticProject(account);
      await sibling.goto(`${origin()}${ideaPath(anotherProject)}`);
      await expect(sibling.getByLabel("階段草稿文字")).toHaveValue("");
      const foreign = await otherContext.newPage();
      await foreign.goto(`${origin()}${ideaPath(id)}`);
      await expect(foreign.getByTestId("project-workspace-closed")).toBeVisible();
      await expect(foreign.getByLabel("階段草稿文字")).toHaveCount(0);
      await page.route("**/api/v1/projects/recovery", async (route) => {
        recoveries++;
        expect(route.request().headers()["idempotency-key"]).toBe(originalKey);
        expect(route.request().postDataJSON()).toEqual({ title: "查回原專案" });
        const response = await route.fetch();
        expect(response.status()).toBe(200);
        expect((await response.json()).project.id).toBe(id);
        await route.fulfill({ response });
      });
      await page.getByRole("button", { name: "只查詢原操作", exact: true }).click();
      await expect(page).toHaveURL(`${origin()}${ideaPath(id)}`);
      await expect(page.getByLabel("階段草稿文字")).toHaveValue(occupied ? "另一頁已保存的原文  " : raw);
      await expect(page.getByTestId("idea-handoff-status")).toContainText(occupied ? "不會覆寫" : "未儲存");
      expect(creates).toBe(1);
      expect(recoveries).toBe(1);
      await evidence(page, occupied ? "05-existing-content-protected" : "04-recovery-once");
      if (!occupied) {
        await assertNoSavedIdea(control, id);
        await page.getByRole("button", { name: "放棄帶入", exact: true }).click();
        await expect(page.getByLabel("階段草稿文字")).toHaveValue("");
        await expect(page.getByRole("button", { name: "放棄帶入", exact: true })).toHaveCount(0);
        await assertNoSavedIdea(control, id);
        await evidence(page, "f01-applied-then-discarded-no-write");
        await page.getByLabel("階段草稿文字").fill("放棄後的獨立編輯  ");
        await expect(page.locator("#operation-status")).toHaveAttribute("data-kind", "unsaved");
        await expect(page.getByRole("button", { name: "放棄帶入", exact: true })).toHaveCount(0);
        await assertNoSavedIdea(control, id);
      } else {
        const edited = "學生修改既有內容 📚\n精確尾端空格  ";
        await page.getByLabel("階段草稿文字").fill(edited);
        await expect(page.locator("#operation-status")).toHaveAttribute("data-kind", "unsaved");
        await expect(page.getByRole("button", { name: "放棄帶入", exact: true })).toHaveCount(0);
        await expect(page.getByLabel("階段草稿文字")).toHaveValue(edited);
        expect((await control.query("SELECT content->>'text' AS text FROM app.stage_records WHERE project_id=$1 AND stage='點子'",
          [id])).rows[0].text).toBe("另一頁已保存的原文  ");
        await evidence(page, "f01-rejected-handoff-edit-preserved");
      }
      await page.reload();
      await expect(page.getByLabel("階段草稿文字")).toHaveValue(occupied ? "另一頁已保存的原文  " : "");
      await expect(page.getByTestId("idea-handoff-status")).toHaveCount(0);
      if (process.env.APP_PLANET_UI_EVIDENCE_DIR) {
        await writeFile(path.join(process.env.APP_PLANET_UI_EVIDENCE_DIR, `recovery-${occupied}.json`),
          JSON.stringify({ creates, recoveries, sameOriginalProject: true, storedDraft: false,
            occupiedProtected: occupied, originalTextExact: true, foreignAccountDenied: true,
            siblingTabEmpty: true, otherProjectEmpty: true, reappliedAfterReload: false }, null, 2));
      }
    } finally {
      await context.close();
      await otherContext.close();
      await cleanup(control, [account, other]);
    }
  });

}

for (const heldOperation of ["create", "recovery", "cancel-leave"] as const) {
    test(`F-02 ${heldOperation}：${heldOperation === "cancel-leave"
      ? "取消離頁保留原交接，晚到成功仍可帶入"
      : "確認離頁同步撤銷，來源仍掛載時晚到成功不得搶走目的地"}`, async ({ browser }) => {
      const control = openControlPool();
      const account = await createSyntheticAuthAccount(control, "IdeaLeaveRace");
      const context = await browser.newContext({ locale: "zh-TW", ignoreHTTPSErrors: true });
      const barriers: string[] = [];
      const barrier = () => {
        let release!: () => void;
        const promise = new Promise<void>((resolve) => { release = resolve; });
        return { promise, release };
      };
      const committed = barrier(), releaseSuccess = barrier(), destinationHeld = barrier(), releaseDestination = barrier();
      let successReleased = false, destinationReleased = false;
      try {
        await session(context, account);
        const destinationId = await createOwnedSyntheticProject(account);
        const page = await context.newPage();
        await page.goto(`${origin()}/student`);
        await expect(page.getByTestId("owned-project-list")).toBeVisible();
        const source = await page.getByTestId("student-creation-space").elementHandle();
        if (!source) throw new Error("缺少來源創作空間");
        await choose(page);
        const title = "晚到成功不搶走目的地";
        await page.getByLabel("專案名稱").fill(title);
        let createdId = "", key = "", creates = 0, recoveries = 0;
        const navigations: string[] = [];
        let newProjectNavigationRequests = 0;
        page.on("framenavigated", (frame) => {
          if (frame === page.mainFrame()) navigations.push(new URL(frame.url()).pathname);
        });
        page.on("request", (request) => {
          if (createdId && new URL(request.url()).pathname.startsWith(`/student/projects/${createdId}`)) {
            newProjectNavigationRequests++;
          }
        });
        await page.route("**/api/v1/projects", async (route) => {
          creates++;
          key = route.request().headers()["idempotency-key"];
          const response = await route.fetch();
          expect(response.status()).toBe(201);
          createdId = (await response.json()).id;
          barriers.push("真建立已完成並回傳 201，成功本文尚未送至頁面");
          if (heldOperation === "recovery") {
            await route.abort("failed");
            return;
          }
          committed.release();
          await releaseSuccess.promise;
          await route.fulfill({ response });
        });
        await page.route("**/api/v1/projects/recovery", async (route) => {
          recoveries++;
          expect(route.request().headers()["idempotency-key"]).toBe(key);
          const response = await route.fetch();
          expect(response.status()).toBe(200);
          expect((await response.json()).project.id).toBe(createdId);
          barriers.push("原鍵查回已成功，成功本文尚未送至頁面");
          committed.release();
          await releaseSuccess.promise;
          await route.fulfill({ response });
        });
        await page.getByRole("button", { name: "建立專案", exact: true }).click();
        if (heldOperation === "recovery") {
          await page.getByRole("button", { name: "只查詢原操作", exact: true }).click();
        }
        await committed.promise;
        expect((await control.query("SELECT count(*)::int AS n FROM app.projects WHERE id=$1 AND owner_id=$2",
          [createdId, account.id])).rows[0].n).toBe(1);
        barriers.push("控制連線確認新專案已 COMMIT");
        const destinationPath = `/student/projects/${destinationId}`;
        await page.route((url) => url.pathname === destinationPath, async (route) => {
          barriers.push("學生原選目的頁載入已扣住");
          destinationHeld.release();
          await releaseDestination.promise;
          await route.continue();
        });
        const destination = page.getByTestId("owned-project-list").locator(`a[href="${destinationPath}"]`);
        await destination.click();
        await page.getByRole("button", { name: "留在本頁", exact: true }).click();
        await expect(page.getByLabel("我的點子草稿")).toHaveValue(raw);
        await expect(page.getByRole("button", { name: "取消帶入", exact: true })).toBeVisible();
        barriers.push("取消離頁保留草稿與帶入意圖");
        if (heldOperation === "cancel-leave") {
          releaseSuccess.release();
          successReleased = true;
          await expect(page).toHaveURL(`${origin()}${ideaPath(createdId)}`);
          await expect(page.getByLabel("階段草稿文字")).toHaveValue(raw);
          await expect(page.getByRole("button", { name: "放棄帶入", exact: true })).toBeVisible();
          await assertNoSavedIdea(control, createdId);
          expect(creates).toBe(1);
          expect(recoveries).toBe(0);
          barriers.push("取消離頁後成功仍沿原交接帶入精確原文，未保存且僅建立一次");
          await evidence(page, "f02-cancel-leave-intent-retained");
          return;
        }
        await destination.click();
        barriers.push("學生點擊明確放棄，隨後沿用原連結");
        await page.getByRole("button", { name: "放棄草稿並離開", exact: true }).click();
        await destinationHeld.promise;
        expect(await source.evaluate((element) => element.isConnected)).toBe(true);
        await expect(page.getByTestId("student-creation-space")).toBeVisible();
        await expect(page.getByLabel("我的點子草稿")).toHaveValue("");
        expect(await page.evaluate(({ key, title }) => Object.values(sessionStorage).some((value) => {
          try {
            const stored = JSON.parse(value);
            return stored.v === 3 && stored.key === key && stored.payload.title === title;
          } catch { return false; }
        }), { key, title })).toBe(true);
        barriers.push("來源仍掛載，未確認操作紀錄仍保留");
        const success = page.waitForResponse((response) =>
          new URL(response.url()).pathname === (heldOperation === "create" ? "/api/v1/projects" : "/api/v1/projects/recovery"));
        releaseSuccess.release();
        successReleased = true;
        const arrived = await success;
        expect(arrived.status()).toBe(heldOperation === "create" ? 201 : 200);
        await arrived.finished();
        barriers.push("扣住的成功回應已實際抵達瀏覽器");
        await expect(page.getByRole("link", { name: "開啟剛建立的專案", exact: true })).toBeVisible();
        expect(await source.evaluate((element) => element.isConnected)).toBe(true);
        await expect(page.getByTestId("student-creation-space")).toBeVisible();
        await expect(page.getByLabel("我的點子草稿")).toHaveValue("");
        await expect(page.getByRole("button", { name: "取消帶入", exact: true })).toHaveCount(0);
        barriers.push("成功回應確實抵達且已處理，來源仍掛載，草稿未復活");
        await evidence(page, `f02-${heldOperation}-late-success-source-mounted`);
        releaseDestination.release();
        destinationReleased = true;
        await expect(page).toHaveURL(`${origin()}${destinationPath}`);
        await expect(page.getByTestId("workspace-project-context")).toBeVisible();
        expect(navigations).not.toContain(ideaPath(createdId));
        expect(newProjectNavigationRequests).toBe(0);
        const unsolicitedNavigationRequests = newProjectNavigationRequests;
        expect(creates).toBe(1);
        expect(recoveries).toBe(heldOperation === "recovery" ? 1 : 0);
        await assertNoSavedIdea(control, createdId);
        barriers.push("釋放目的頁後停在原選本人專案，建立僅一次，無新專案導覽");
        const receipt = await page.request.post(`${origin()}/api/v1/projects/recovery`, {
          headers: { "content-type": "application/json", "idempotency-key": key, origin: origin() },
          data: { title },
        });
        expect(receipt.status()).toBe(200);
        expect((await receipt.json()).project.id).toBe(createdId);
        barriers.push("既有 recovery API 以原鍵原本文取得同一建立結果");
        await page.goto(`${origin()}${ideaPath(createdId)}`);
        await expect(page.getByLabel("階段草稿文字")).toHaveValue("");
        await expect(page.getByTestId("idea-handoff-status")).toHaveCount(0);
        await evidence(page, `f02-${heldOperation}-no-revived-draft`);
        if (process.env.APP_PLANET_UI_EVIDENCE_DIR) {
          await writeFile(path.join(process.env.APP_PLANET_UI_EVIDENCE_DIR, `f02-${heldOperation}-barriers.json`),
            JSON.stringify({ barriers, creates, recoveries,
              newProjectNavigationRequestsBeforeExplicitVisit: unsolicitedNavigationRequests, originalDestinationPreserved: true,
              sourceMountedWhenSuccessProcessed: true, originalReceiptRecoverable: true, draftRevived: false }, null, 2));
        }
      } finally {
        if (!successReleased) releaseSuccess.release();
        if (!destinationReleased) releaseDestination.release();
        await context.close();
        await cleanup(control, [account]);
        if (process.env.APP_PLANET_UI_EVIDENCE_DIR) {
          await writeFile(path.join(process.env.APP_PLANET_UI_EVIDENCE_DIR, `f02-${heldOperation}-attempt.json`),
            JSON.stringify({ barriers }, null, 2));
        }
      }
    });
}

test("建立回應抵達前取消／失權，不復活帶入；reload 查回只找專案不找草稿", async ({ browser }) => {
  const control = openControlPool();
  const account = await createSyntheticAuthAccount(control, "IdeaCancelled");
  const context = await browser.newContext({ locale: "zh-TW", ignoreHTTPSErrors: true });
  try {
    await session(context, account);
    const page = await context.newPage();
    await page.goto(`${origin()}/student`);
    await choose(page);
    await page.getByLabel("專案名稱").fill("取消帶入不重建");
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let committed!: () => void;
    const didCommit = new Promise<void>((resolve) => { committed = resolve; });
    let id = "", creates = 0;
    await page.route("**/api/v1/projects", async (route) => {
      creates++;
      const response = await route.fetch();
      expect(response.status()).toBe(201);
      id = (await response.json()).id;
      committed();
      await held;
      await route.fulfill({ response });
    });
    await page.getByRole("button", { name: "建立專案", exact: true }).click();
    await didCommit;
    await page.getByRole("button", { name: "取消帶入", exact: true }).click();
    await expect(page.getByLabel("我的點子草稿")).toHaveValue(raw);
    release();
    await expect(page.getByRole("link", { name: "開啟剛建立的專案", exact: true })).toBeVisible();
    await expect(page).toHaveURL(`${origin()}/student`);
    await expect(page.getByLabel("我的點子草稿")).toHaveValue(raw);
    expect(creates).toBe(1);
    await page.goto(`${origin()}${ideaPath(id)}`);
    await expect(page.getByLabel("階段草稿文字")).toHaveValue("");
    await assertNoSavedIdea(control, id);
    await page.goto(`${origin()}/student`);
    await choose(page);
    await page.getByLabel("專案名稱").fill("失權後只能查回");
    await page.unroute("**/api/v1/projects");
    await page.route("**/api/v1/projects", async (route) => {
      creates++;
      const response = await route.fetch();
      expect(response.status()).toBe(201);
      id = (await response.json()).id;
      await route.abort("failed");
    });
    await page.getByRole("button", { name: "建立專案", exact: true }).click();
    await expect(page.getByRole("button", { name: "只查詢原操作", exact: true })).toBeEnabled();
    await control.query("UPDATE app.profiles SET status='disabled' WHERE id=$1", [account.id]);
    await page.getByRole("button", { name: "只查詢原操作", exact: true }).click();
    await expect(page.getByLabel("我的點子草稿")).toBeHidden();
    await control.query("UPDATE app.profiles SET status='approved' WHERE id=$1", [account.id]);
    await page.reload();
    await expect(page.getByLabel("我的點子草稿")).toHaveValue("");
    await expect(page.getByText(/查回只能取得專案/)).toBeVisible();
    await page.getByRole("button", { name: "只查詢原操作", exact: true }).click();
    await expect(page.getByRole("link", { name: "開啟剛建立的專案", exact: true })).toBeVisible();
    expect(creates).toBe(2);
    await page.goto(`${origin()}${ideaPath(id)}`);
    await expect(page.getByLabel("階段草稿文字")).toHaveValue("");
    await assertNoSavedIdea(control, id);
    await evidence(page, "06-cancelled-or-unavailable-no-draft");
  } finally {
    await context.close();
    await cleanup(control, [account]);
  }
});
