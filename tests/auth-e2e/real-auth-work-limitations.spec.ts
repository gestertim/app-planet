import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { Client } from "pg";
import {
  createSyntheticAuthAccount,
  deleteSyntheticAuthAccount,
  loginSyntheticAccount,
  openControlPool,
} from "../support/real-auth-fixture.ts";
import { sessionCookieName } from "../../apps/web/src/server/auth-principal.ts";

type CreatedProject = Readonly<{ id: string; rowVersion: number; requirementsRevision: number }>;

const requirement = (description: string, runtimeNeeds: string, runtimeAiRequired = false) => ({
  description,
  runtime_needs: runtimeNeeds,
  runtime_ai_required: runtimeAiRequired,
});

const eligibilityBarrierKey = 97113;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

async function installProtectedScopeObserver(context: import("@playwright/test").BrowserContext) {
  await context.addInitScript(() => {
    const observations: string[] = [];
    const state = { active: false, observations };
    (window as Window & { __t097ScopeWatch?: typeof state }).__t097ScopeWatch = state;
    const activeKey = "t097.scope-observation-active";
    const observationsKey = "t097.scope-observations";
    const capture = () => {
      if (sessionStorage.getItem(activeKey) !== "1" ||
          !document.body ||
          !/^\/student\/projects\/[^/]+\/(?:build|publish)\/?$/.test(window.location.pathname)) return;
      const visibleText = document.body.innerText;
      const protectedVisible = [...document.querySelectorAll(
        "[data-testid='workspace-project-context'], [data-testid='project-workspace-tabs'], " +
        "[data-testid='work-limitations'], [data-testid='project-file-workspace'], " +
        "[data-testid='publish-workflow-unavailable']",
      )].some((element) => {
        const node = element as HTMLElement;
        return node.getClientRects().length > 0 && getComputedStyle(node).visibility !== "hidden";
      });
      const markers = [
        "T097-SYNTHETIC-TITLE",
        "T097-SYNTHETIC-FILE",
        "T097-F01-publish-history",
        "目前的作品需求符合首版範圍",
      ];
      const record = (marker: string) => {
        const observation = `${window.location.pathname}:${marker}`;
        if (observations.includes(observation)) return;
        observations.push(observation);
        const recorded = JSON.parse(sessionStorage.getItem(observationsKey) ?? "[]") as string[];
        if (!recorded.includes(observation)) {
          recorded.push(observation);
          sessionStorage.setItem(observationsKey, JSON.stringify(recorded));
        }
      };
      for (const marker of markers.filter((candidate) => visibleText.includes(candidate))) {
        record(marker);
      }
      if (protectedVisible) record("T097-PROTECTED-WORKSPACE-VISIBLE");
      const sample = {
        path: window.location.pathname,
        phase: sessionStorage.getItem("t097.scope-phase") ?? "before-return",
        scope: document.querySelector("[data-testid='work-limitations']")?.getAttribute("data-scope-state") ?? null,
        protectedVisible,
        positiveVisible: visibleText.includes("目前的作品需求符合首版範圍"),
      };
      const timeline = JSON.parse(sessionStorage.getItem("t097.scope-timeline") ?? "[]") as typeof sample[];
      if (JSON.stringify(timeline.at(-1)) !== JSON.stringify(sample)) {
        timeline.push(sample);
        sessionStorage.setItem("t097.scope-timeline", JSON.stringify(timeline));
      }
    };
    new MutationObserver(capture).observe(document, {
      subtree: true, childList: true, characterData: true, attributes: true, attributeOldValue: true,
    });
    const sample = () => { capture(); requestAnimationFrame(sample); };
    requestAnimationFrame(sample);
  });
}

async function startScopeObservation(page: import("@playwright/test").Page) {
  await page.evaluate(() => {
    sessionStorage.setItem("t097.scope-observation-active", "1");
    sessionStorage.setItem("t097.scope-observations", "[]");
    sessionStorage.setItem("t097.scope-timeline", "[]");
    sessionStorage.setItem("t097.scope-phase", "before-return");
  });
}

async function scopePhase(page: import("@playwright/test").Page, phase: string) {
  await page.evaluate((value) => sessionStorage.setItem("t097.scope-phase", value), phase);
}

async function finishScopeObservation(
  page: import("@playwright/test").Page, path: string, denied: boolean, requestId: string | null,
) {
  await page.evaluate(() => new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  const timeline = await page.evaluate((target) => {
    const samples = JSON.parse(sessionStorage.getItem("t097.scope-timeline") ?? "[]") as Array<{
      path: string; phase: string; scope: string | null; protectedVisible: boolean; positiveVisible: boolean;
    }>;
    return samples.filter((sample) => sample.path === target);
  }, path);
  console.log(`T097E01FullInterval=${JSON.stringify({ denied, timeline })}`);
  expect(timeline.length).toBeGreaterThan(0);
  expect(timeline.some((sample) => sample.positiveVisible)).toBe(false);
  if (denied) expect(timeline.some((sample) => sample.protectedVisible)).toBe(false);
  else {
    expect(timeline.filter((sample) => sample.protectedVisible).every(
      (sample) => sample.phase === "current-result-released" && sample.scope === "outside_scope",
    )).toBe(true);
    expect(timeline.some((sample) => sample.protectedVisible && sample.scope === "outside_scope")).toBe(true);
    expect(requestId).toBeTruthy();
    await expect(page.getByTestId("work-limitations")).toHaveAttribute("data-scope-request", requestId!);
  }
}

async function releaseCurrentScopeResult(
  page: import("@playwright/test").Page,
  path: string,
  release: () => void,
  state: "outside_scope" | "access_closed",
) {
  const responsePromise = page.waitForResponse((response) =>
    new URL(response.url()).pathname === path && new URL(response.url()).searchParams.has("_rsc"));
  await scopePhase(page, "current-result-released");
  release();
  const response = await responsePromise;
  expect(response.status()).toBe(200);
  const body = await response.text();
  expect(body).toContain(state);
  const requestId = new URL(response.url()).searchParams.get("__scope_request");
  expect(requestId).toBeTruthy();
  expect(body).toContain(requestId!);
  console.log(`T097E01CurrentResponse=${JSON.stringify({
    path, state, status: response.status(),
    requestId,
    order: ["return-observed", "recheck-barrier-arrived", "barrier-released", "trusted-response-body-received"],
  })}`);
  return requestId;
}

async function expectScopeUrl(page: import("@playwright/test").Page, target: string) {
  await expect(page).toHaveURL((url) => {
    url.searchParams.delete("__scope_request");
    return url.href === target;
  });
}

function installScopeRefreshHold(
  page: import("@playwright/test").Page,
  targetPath: string,
  abortOnRelease = false,
) {
  let armed = false;
  let requestsToSkip = 0;
  let didArrive = false;
  let arrived = deferred<void>();
  let release = deferred<void>();
  let settled = deferred<void>();
  const matcher = (url: URL) =>
    url.pathname.replace(/\/$/, "") === targetPath && url.searchParams.has("_rsc");
  const handler = async (route: import("@playwright/test").Route) => {
    if (!armed) return route.continue();
    if (requestsToSkip > 0) {
      requestsToSkip -= 1;
      return route.continue();
    }
    armed = false;
    didArrive = true;
    arrived.resolve();
    await release.promise;
    try {
      if (abortOnRelease) await route.abort();
      else await route.continue();
    } finally {
      settled.resolve();
    }
  };
  return {
    install: () => page.route(matcher, handler),
    arm: (skipRequests = 0) => {
      arrived = deferred<void>();
      release = deferred<void>();
      settled = deferred<void>();
      requestsToSkip = skipRequests;
      didArrive = false;
      armed = true;
      return {
        arrived: arrived.promise,
        settled: settled.promise,
        hasArrived: () => didArrive,
        release: () => release.resolve(),
      };
    },
    remove: () => page.unroute(matcher, handler),
  };
}

test("T097 真 Auth／隔離 PostgreSQL／Next HTTPS：兩頁顯示當前作品範圍且不沿用舊結果", async ({ browser }) => {
  test.setTimeout(300_000);
  const control = openControlPool();
  const owner = await createSyntheticAuthAccount(control, "WorkLimitationsOwner");
  const other = await createSyntheticAuthAccount(control, "WorkLimitationsOther");
  const ownerSession = await loginSyntheticAccount(owner);
  const otherSession = await loginSyntheticAccount(other);
  const origin = process.env.APP_PLANET_APP_ORIGIN;
  if (!origin) throw new Error("隔離瀏覽器測試缺少本機 app origin。");
  const context = await browser.newContext({ locale: "zh-TW" });
  const otherContext = await browser.newContext({ locale: "zh-TW" });
  const projectIds: string[] = [];
  let ownerDisabled = false;
  await installProtectedScopeObserver(context);

  const installSession = (target: typeof context, token: string) => target.addCookies([{
    name: sessionCookieName,
    value: token,
    url: origin,
    httpOnly: true,
    secure: true,
    sameSite: "Strict",
  }]);

  const createProject = async (page: import("@playwright/test").Page, title: string): Promise<CreatedProject> => {
    await page.goto(`${origin}/student`);
    await page.getByLabel("專案名稱").fill(title);
    const creating = page.waitForResponse((response) =>
      new URL(response.url()).pathname === "/api/v1/projects" && response.request().method() === "POST");
    await page.getByRole("button", { name: "建立專案", exact: true }).click();
    const response = await creating;
    expect(response.status()).toBe(201);
    const body: unknown = await response.json();
    if (typeof body !== "object" || body === null || !("id" in body) ||
        typeof body.id !== "string") {
      throw new Error("產品建立專案回應缺少合成作品識別資料。");
    }
    projectIds.push(body.id);
    return { id: body.id, rowVersion: 0, requirementsRevision: 0 };
  };

  const saveRequirements = async (
    project: CreatedProject,
    requirements: ReturnType<typeof requirement>,
  ): Promise<CreatedProject> => {
    const response = await context.request.put(
      `${origin}/api/v1/projects/${project.id}/requirements`,
      {
        headers: {
          origin,
          "if-match": `"${project.rowVersion}"`,
          "idempotency-key": randomUUID(),
        },
        data: {
          expected_requirements_revision: project.requirementsRevision,
          requirements,
        },
      },
    );
    expect(response.status()).toBe(200);
    return {
      id: project.id,
      rowVersion: project.rowVersion + 1,
      requirementsRevision: project.requirementsRevision + 1,
    };
  };

  const confirmClassification = async (
    project: CreatedProject,
    tier: "A" | "B",
    needsVisitorIdentity: boolean,
  ): Promise<CreatedProject> => {
    const response = await context.request.post(
      `${origin}/api/v1/projects/${project.id}/classification/confirmation`,
      {
        headers: {
          origin,
          "if-match": `"${project.rowVersion}"`,
          "idempotency-key": randomUUID(),
        },
        data: {
          expected_requirements_revision: project.requirementsRevision,
          tier,
          needs_visitor_identity: needsVisitorIdentity,
          requested_tier_acknowledgement: "no_preference",
        },
      },
    );
    expect(response.status()).toBe(200);
    return { ...project, rowVersion: project.rowVersion + 1 };
  };

  const openScope = async (
    page: import("@playwright/test").Page,
    projectId: string,
    destination: "build" | "publish",
    state: string,
  ) => {
    await page.goto(`${origin}/student/projects/${projectId}/${destination}`);
    await expect(page.getByTestId("work-limitations")).toHaveAttribute("data-scope-state", state);
    await expect(page.getByTestId("work-operation-availability")).toBeVisible();
    await expect(page.locator("body")).not.toContainText("SYNTHETIC-REQUIREMENT");
  };

  const saveFile = async (page: import("@playwright/test").Page, projectId: string, text: string) => {
    await page.getByLabel("新增檔案名稱").fill("index.html");
    await page.getByRole("link", { name: "新增檔案", exact: true }).click();
    const editor = page.getByRole("textbox", { name: "index.html 原始碼文字編輯器" });
    await expect(editor).toBeVisible();
    await editor.press("Control+A");
    await page.keyboard.insertText(text);
    const saved = page.waitForResponse((response) =>
      new URL(response.url()).pathname === `/api/v1/projects/${projectId}/files/index.html` &&
      response.request().method() === "PUT");
    await page.getByRole("button", { name: "保存到資料庫" }).click();
    expect([200, 201]).toContain((await saved).status());
  };

  try {
    await installSession(context, ownerSession.accessToken);
    await installSession(otherContext, otherSession.accessToken);
    const page = await context.newPage();

    let aProject = await createProject(page, "T097-SYNTHETIC-TITLE 合成範圍 A");
    aProject = await saveRequirements(aProject, requirement("SYNTHETIC-REQUIREMENT-A", "static"));
    aProject = await confirmClassification(aProject, "A", false);

    let bProject = await createProject(page, "合成範圍 B 訪客");
    bProject = await saveRequirements(bProject, requirement("SYNTHETIC-REQUIREMENT-B", "work_data_api"));
    bProject = await confirmClassification(bProject, "B", true);

    const serverProject = await saveRequirements(
      await createProject(page, "合成學生伺服器需求"),
      requirement("SYNTHETIC-REQUIREMENT-SERVER", "restricted_server"),
    );
    const aiProject = await saveRequirements(
      await createProject(page, "合成作品 runtime AI 需求"),
      requirement("SYNTHETIC-REQUIREMENT-RUNTIME-AI", "static", true),
    );

    for (const destination of ["build", "publish"] as const) {
      await openScope(page, aProject.id, destination, "within_scope");
      await expect(page.getByText("目前的作品需求符合首版範圍", { exact: true })).toBeVisible();
      await expect(page.getByTestId("work-operation-availability"))
        .toContainText(destination === "build" ? "預覽功能尚未開放" : "發布功能尚未開放");
    }

    await openScope(page, bProject.id, "build", "within_scope");
    await expect(page.getByText("首版不提供公開服務")).toHaveCount(0);
    await openScope(page, bProject.id, "publish", "public_visitor_identity");
    await expect(page.getByText(/首版不提供公開服務/)).toBeVisible();

    for (const destination of ["build", "publish"] as const) {
      await openScope(page, serverProject.id, destination, "outside_scope");
      await expect(page.getByText(/首版不會執行需要學生伺服器的程式/)).toBeVisible();
      await expect(page.getByText(/不會自動刪除需求或改變 A／B 分類/)).toBeVisible();
      await openScope(page, aiProject.id, destination, "outside_scope");
      await expect(page.getByText(/首版不支援作品執行時使用 AI/)).toBeVisible();
    }

    const aBuildUrl = `${origin}/student/projects/${aProject.id}/build`;
    const aPublishUrl = `${origin}/student/projects/${aProject.id}/publish`;
    await page.goto(aBuildUrl);
    await expect(page.getByTestId("work-limitations")).toHaveAttribute("data-scope-state", "within_scope");
    await saveFile(page, aProject.id, "<h1>T097-SYNTHETIC-FILE</h1>");
    await page.evaluate(() => history.replaceState(history.state, "", window.location.pathname));
    await expect(page).toHaveURL(aBuildUrl);
    await expect(page.locator(".monaco-editor .view-lines")).toContainText("T097-SYNTHETIC-FILE");
    await page.getByRole("link", { name: "發布", exact: true }).click();
    await expectScopeUrl(page, aPublishUrl);
    await expect(page.getByTestId("work-limitations")).toHaveAttribute("data-scope-state", "within_scope");
    const changedRequirements = await context.request.put(
      `${origin}/api/v1/projects/${aProject.id}/requirements`,
      {
        headers: {
          origin,
          "if-match": `"${aProject.rowVersion}"`,
          "idempotency-key": randomUUID(),
        },
        data: {
          expected_requirements_revision: aProject.requirementsRevision,
          requirements: requirement("SYNTHETIC-REQUIREMENT-REVISED", "restricted_server"),
        },
      },
    );
    expect(changedRequirements.status()).toBe(200);
    await page.evaluate(() => {
      const state = (window as Window & {
        __t097ScopeWatch?: { active: boolean; observations: string[] };
      }).__t097ScopeWatch!;
      state.observations.length = 0;
      state.active = true;
      sessionStorage.setItem("t097.scope-observation-active", "1");
      sessionStorage.setItem("t097.scope-observations", "[]");
      const positiveControl = document.createElement("div");
      positiveControl.id = "t097-scope-observer-positive-control";
      positiveControl.dataset.testid = "work-limitations";
      positiveControl.style.cssText =
        "position:fixed;top:0;left:0;z-index:2147483647;background:white;color:black";
      positiveControl.textContent = "T097 scope observer positive control";
      document.body.appendChild(positiveControl);
    });
    await expect.poll(async () => page.evaluate(() =>
      (window as Window & { __t097ScopeWatch?: { observations: string[] } })
        .__t097ScopeWatch!.observations.includes(
          `${window.location.pathname}:T097-PROTECTED-WORKSPACE-VISIBLE`,
        ),
    )).toBe(true);
    console.log("T097ScopeObserverPositiveControl=visible protected node mutation recorded");
    await page.evaluate(() => {
      const state = (window as Window & {
        __t097ScopeWatch?: { active: boolean; observations: string[] };
      }).__t097ScopeWatch!;
      document.getElementById("t097-scope-observer-positive-control")!.remove();
      state.observations.length = 0;
      state.active = false;
      sessionStorage.setItem("t097.scope-observation-active", "0");
      sessionStorage.setItem("t097.scope-observations", "[]");
    });
    const requirementHold = installScopeRefreshHold(page, new URL(aBuildUrl).pathname);
    await requirementHold.install();
    await page.evaluate(() => {
      sessionStorage.setItem("t097.scope-observation-active", "1");
      sessionStorage.setItem("t097.scope-observations", "[]");
      (window as Window & { __t097ScopeWatch?: { active: boolean } }).__t097ScopeWatch!.active = true;
    });
    const requirementBarrier = requirementHold.arm();
    await startScopeObservation(page);
    const requirementBack = page.goBack({ waitUntil: "commit" }).catch((error: unknown) => error);
    await expectScopeUrl(page, aBuildUrl);
    await requirementBarrier.arrived;
    const heldRequirementState = await page.evaluate(() => ({
      status: /正在重新確認存取權限|正在由伺服器確認登入、權限與專案資料/.test(document.body.innerText),
      statuses: [...document.querySelectorAll("[role='status']")].map((element) => ({
        text: element.textContent,
        hidden: (element as HTMLElement).hidden,
        visible: element.getClientRects().length > 0,
      })),
      closedVisible: [...document.querySelectorAll("[role='alert']")].some(
        (element) => element.getClientRects().length > 0,
      ),
      pageText: document.body.innerText.slice(0, 240),
      protectedVisible: [...document.querySelectorAll(
        "[data-testid='workspace-project-context'], [data-testid='project-workspace-tabs'], " +
        "[data-testid='work-limitations'], [data-testid='project-file-workspace']",
      )].some((element) => {
        const node = element as HTMLElement;
        return node.getClientRects().length > 0 && getComputedStyle(node).visibility !== "hidden";
      }),
      observations: (window as Window & { __t097ScopeWatch?: { observations: string[] } })
        .__t097ScopeWatch!.observations.filter((observation) =>
          observation.startsWith(`${window.location.pathname}:`)),
      visibleMarkers: [
        "T097-SYNTHETIC-TITLE",
        "T097-SYNTHETIC-FILE",
        "目前的作品需求符合首版範圍",
      ].filter((marker) => document.body.innerText.includes(marker)),
      recorded: (JSON.parse(sessionStorage.getItem("t097.scope-observations") ?? "[]") as string[])
        .filter((observation) => observation.startsWith(`${window.location.pathname}:`)),
    }));
    console.log(`T097F01RequirementsHeld=${JSON.stringify(heldRequirementState)}`);
    expect.soft(heldRequirementState.status).toBe(true);
    expect.soft(heldRequirementState.protectedVisible).toBe(false);
    expect.soft(heldRequirementState.visibleMarkers).toEqual([]);
    expect.soft(heldRequirementState.recorded).toEqual([]);
    const requirementRequestId = await releaseCurrentScopeResult(
      page, new URL(aBuildUrl).pathname, requirementBarrier.release, "outside_scope");
    const requirementBackResult = await requirementBack;
    if (requirementBackResult instanceof Error) throw requirementBackResult;
    await requirementHold.remove();
    await expect(page.getByTestId("work-limitations")).toHaveAttribute("data-scope-state", "outside_scope");
    await expect(page.getByText("目前的作品需求符合首版範圍", { exact: true })).toHaveCount(0);
    await expect(page.getByText(/首版不會執行需要學生伺服器的程式/)).toBeVisible();
    await finishScopeObservation(page, new URL(aBuildUrl).pathname, false, requirementRequestId);
    await page.reload();
    await expect(page.getByTestId("work-limitations")).toHaveAttribute("data-scope-state", "outside_scope");
    await page.goto(`${origin}/student/projects/${bProject.id}/build`);
    await expect(page.getByTestId("work-limitations")).toHaveAttribute("data-scope-state", "within_scope");
    await expect(page.getByText(/首版不會執行需要學生伺服器的程式/)).toHaveCount(0);

    const publishHistoryProject = await confirmClassification(
      await saveRequirements(
        await createProject(page, "T097-F01-publish-history"),
        requirement("T097-F01-PUBLISH-INITIAL", "static"),
      ),
      "A",
      false,
    );
    const publishHistoryUrl = `${origin}/student/projects/${publishHistoryProject.id}/publish`;
    await page.goto(publishHistoryUrl);
    await expect(page.getByTestId("work-limitations")).toHaveAttribute("data-scope-state", "within_scope");
    await expect(page.getByText("目前的作品需求符合首版範圍", { exact: true })).toBeVisible();
    await page.evaluate(() => {
      const state = (window as Window & {
        __t097ScopeWatch?: { active: boolean; observations: string[] };
      }).__t097ScopeWatch!;
      state.observations.length = 0;
      state.active = true;
      sessionStorage.setItem("t097.scope-observation-active", "1");
      sessionStorage.setItem("t097.scope-observations", "[]");
    });
    await page.getByRole("link", { name: "版本", exact: true }).click();
    await expect(page).toHaveURL(`${origin}/student/projects/${publishHistoryProject.id}/versions`);
    const changedPublishRequirements = await context.request.put(
      `${origin}/api/v1/projects/${publishHistoryProject.id}/requirements`,
      {
        headers: {
          origin,
          "if-match": `"${publishHistoryProject.rowVersion}"`,
          "idempotency-key": randomUUID(),
        },
        data: {
          expected_requirements_revision: publishHistoryProject.requirementsRevision,
          requirements: requirement("T097-F01-PUBLISH-REVISED", "restricted_server"),
        },
      },
    );
    expect(changedPublishRequirements.status()).toBe(200);
    const publishHold = installScopeRefreshHold(page, new URL(publishHistoryUrl).pathname);
    await publishHold.install();
    await page.evaluate(() => {
      const state = (window as Window & {
        __t097ScopeWatch?: { active: boolean; observations: string[] };
      }).__t097ScopeWatch!;
      state.observations.length = 0;
      sessionStorage.setItem("t097.scope-observations", "[]");
    });
    const publishBarrier = publishHold.arm();
    await startScopeObservation(page);
    const publishBack = page.goBack({ waitUntil: "commit" }).catch((error: unknown) => error);
    await expectScopeUrl(page, publishHistoryUrl);
    await publishBarrier.arrived;
    const heldPublishState = await page.evaluate(() => ({
      protectedVisible: [...document.querySelectorAll(
        "[data-testid='workspace-project-context'], [data-testid='project-workspace-tabs'], " +
        "[data-testid='work-limitations'], [data-testid='publish-workflow-unavailable']",
      )].some((element) => (element as HTMLElement).getClientRects().length > 0),
      visibleMarkers: [
        "T097-F01-publish-history",
        "目前的作品需求符合首版範圍",
      ].filter((marker) => document.body.innerText.includes(marker)),
      observations: (window as Window & { __t097ScopeWatch?: { observations: string[] } })
        .__t097ScopeWatch!.observations.slice(),
      recorded: JSON.parse(sessionStorage.getItem("t097.scope-observations") ?? "[]") as string[],
    }));
    console.log(`T097F01PublishHeld=${JSON.stringify(heldPublishState)}`);
    expect(heldPublishState.protectedVisible).toBe(false);
    expect(heldPublishState.visibleMarkers).toEqual([]);
    expect(heldPublishState.observations).toEqual([]);
    expect(heldPublishState.recorded).toEqual([]);
    const publishRequestId = await releaseCurrentScopeResult(
      page, new URL(publishHistoryUrl).pathname, publishBarrier.release, "outside_scope");
    const publishBackResult = await publishBack;
    if (publishBackResult instanceof Error) throw publishBackResult;
    await publishHold.remove();
    await expect(page.getByTestId("work-limitations")).toHaveAttribute("data-scope-state", "outside_scope");
    await expect(page.getByText(/首版不會執行需要學生伺服器的程式/)).toBeVisible();
    await finishScopeObservation(page, new URL(publishHistoryUrl).pathname, false, publishRequestId);

    await installSession(context, (await loginSyntheticAccount(owner)).accessToken);
    const lifecycleStorageKey = "t097.publish-page-lifecycle";
    await page.evaluate((storageKey) => {
      const state = {
        pagehideHidden: false,
        pagehidePersisted: false,
        pageshows: [] as Array<{ persisted: boolean; contentHidden: boolean; visibleMarkers: string[] }>,
      };
      const inspect = () => {
        const shell = document.querySelector(".page-shell");
        return Boolean(shell?.closest("div[hidden]"));
      };
      const store = () => sessionStorage.setItem(storageKey, JSON.stringify(state));
      store();
      window.addEventListener("pagehide", (event) => {
        state.pagehideHidden = inspect();
        state.pagehidePersisted = (event as PageTransitionEvent).persisted;
        store();
      });
      window.addEventListener("pageshow", (event) => {
        state.pageshows.push({
          persisted: (event as PageTransitionEvent).persisted,
          contentHidden: inspect(),
          visibleMarkers: [
            "T097-F01-publish-history",
            "目前的作品需求符合首版範圍",
            "首版不會執行需要學生伺服器的程式",
          ].filter((marker) => document.body.innerText.includes(marker)),
        });
        store();
      });
    }, lifecycleStorageKey);
    const publishPath = new URL(publishHistoryUrl).pathname;
    await page.addInitScript((config: { path: string; storageKey: string }) => {
      if (window.location.pathname !== config.path) return;
      window.addEventListener("pageshow", (event) => {
        const state = JSON.parse(sessionStorage.getItem(config.storageKey) ?? "null") as
          | { pagehideHidden: boolean; pagehidePersisted: boolean; pageshows: Array<{
            persisted: boolean;
            contentHidden: boolean;
            visibleMarkers: string[];
          }> }
          | null;
        if (!state) return;
        const shell = document.querySelector(".page-shell");
        state.pageshows.push({
          persisted: (event as PageTransitionEvent).persisted,
          contentHidden: Boolean(shell?.closest("div[hidden]")),
          visibleMarkers: [
            "T097-F01-publish-history",
            "目前的作品需求符合首版範圍",
            "首版不會執行需要學生伺服器的程式",
          ].filter((marker) => document.body.innerText.includes(marker)),
        });
        sessionStorage.setItem(config.storageKey, JSON.stringify(state));
      });
    }, { path: publishPath, storageKey: lifecycleStorageKey });
    const bfcacheHold = installScopeRefreshHold(page, publishPath);
    await bfcacheHold.install();
    const bfcacheBarrier = bfcacheHold.arm();
    let bfcacheHoldInstalled = true;
    try {
      await page.goto(`${origin}/student`, { waitUntil: "commit" });
      await page.goBack({ waitUntil: "commit" });
      await expectScopeUrl(page, publishHistoryUrl);
      await expect.poll(async () => {
        const state = await page.evaluate((storageKey) => {
          const serialized = sessionStorage.getItem(storageKey);
          return serialized ? JSON.parse(serialized) as { pageshows: unknown[] } : null;
        }, lifecycleStorageKey);
        return state?.pageshows.length ?? 0;
      }, { timeout: 10_000 }).toBeGreaterThan(0);
      const bfcacheState = await page.evaluate((storageKey) => {
        const state = sessionStorage.getItem(storageKey);
        return state ? JSON.parse(state) as {
          pagehideHidden: boolean;
          pagehidePersisted: boolean;
          pageshows: Array<{ persisted: boolean; contentHidden: boolean; visibleMarkers: string[] }>;
        } : null;
      }, lifecycleStorageKey);
      console.log(`T097F01BfcacheHeld=${JSON.stringify(bfcacheState)}`);
      expect(bfcacheState?.pagehideHidden).toBe(true);
      const actualBfcache = bfcacheState?.pagehidePersisted === true &&
        bfcacheState.pageshows.at(-1)?.persisted === true;
      if (actualBfcache) {
        await bfcacheBarrier.arrived;
        const refreshResponse = page.waitForResponse((response) =>
          new URL(response.url()).pathname === publishPath &&
          response.request().method() === "GET" &&
          new URL(response.url()).searchParams.has("_rsc"));
        const restoredState = await page.evaluate((storageKey) => {
          const serialized = sessionStorage.getItem(storageKey);
          return serialized ? JSON.parse(serialized) as {
            pageshows: Array<{ persisted: boolean; contentHidden: boolean; visibleMarkers: string[] }>;
          } : null;
        }, lifecycleStorageKey);
        expect(restoredState?.pageshows.at(-1)?.contentHidden).toBe(true);
        expect(restoredState?.pageshows.at(-1)?.visibleMarkers).toEqual([]);
        bfcacheBarrier.release();
        const response = await refreshResponse;
        expect(response.status()).toBe(200);
      } else {
        console.log("T097F01BfcacheSkip=Browser history returned pageshow.persisted=false; no real BFCache restore was available.");
        bfcacheBarrier.release();
        if (bfcacheBarrier.hasArrived()) await bfcacheBarrier.settled;
        await bfcacheHold.remove();
        bfcacheHoldInstalled = false;

        await expect(page.getByTestId("work-limitations")).toHaveAttribute("data-scope-state", "outside_scope");
        const simulatedHold = installScopeRefreshHold(page, publishPath);
        await simulatedHold.install();
        const simulatedBarrier = simulatedHold.arm();
        try {
          const simulatedResponse = page.waitForResponse((response) =>
            new URL(response.url()).pathname === publishPath &&
            response.request().method() === "GET" &&
            new URL(response.url()).searchParams.has("_rsc"));
          await page.evaluate(() => window.dispatchEvent(
            new PageTransitionEvent("pageshow", { persisted: true }),
          ));
          await simulatedBarrier.arrived;
          const simulatedState = await page.evaluate(() => ({
            contentHidden: Boolean(document.querySelector(".page-shell")?.closest("div[hidden]")),
            visibleMarkers: [
              "T097-F01-publish-history",
              "目前的作品需求符合首版範圍",
              "首版不會執行需要學生伺服器的程式",
            ].filter((marker) => document.body.innerText.includes(marker)),
          }));
          console.log(`T097F01PageshowSimulation=${JSON.stringify(simulatedState)}`);
          expect(simulatedState.contentHidden).toBe(true);
          expect(simulatedState.visibleMarkers).toEqual([]);
          simulatedBarrier.release();
          const response = await simulatedResponse;
          expect(response.status()).toBe(200);
        } finally {
          simulatedBarrier.release();
          if (simulatedBarrier.hasArrived()) await simulatedBarrier.settled;
          await simulatedHold.remove();
        }
      }
      await expect(page.getByTestId("work-limitations")).toHaveAttribute("data-scope-state", "outside_scope");
    } finally {
      bfcacheBarrier.release();
      if (bfcacheBarrier.hasArrived()) await bfcacheBarrier.settled;
      if (bfcacheHoldInstalled) await bfcacheHold.remove();
    }

    await page.evaluate(() => {
      sessionStorage.setItem("t097.scope-observation-active", "0");
      (window as Window & { __t097ScopeWatch?: { active: boolean } }).__t097ScopeWatch!.active = false;
    });
    const bBuildUrl = `${origin}/student/projects/${bProject.id}/build`;
    const bPublishUrl = `${origin}/student/projects/${bProject.id}/publish`;
    await page.goto(bBuildUrl);
    await expect(page.getByTestId("work-limitations")).toHaveAttribute("data-scope-state", "within_scope");
    await saveFile(page, bProject.id, "<h1>T097-SYNTHETIC-FILE</h1>");
    await page.evaluate(() => history.replaceState(history.state, "", window.location.pathname));
    await expect(page).toHaveURL(bBuildUrl);
    await expect(page.locator(".monaco-editor .view-lines")).toContainText("T097-SYNTHETIC-FILE");
    await page.getByRole("link", { name: "發布", exact: true }).click();
    await expectScopeUrl(page, bPublishUrl);
    await expect(page.getByTestId("work-limitations")).toHaveAttribute("data-scope-state", "public_visitor_identity");
    const revokedHold = installScopeRefreshHold(page, new URL(bBuildUrl).pathname);
    await revokedHold.install();
    await control.query(
      "UPDATE app.profiles SET status='disabled',status_changed_at=now() WHERE id=$1",
      [owner.id],
    );
    ownerDisabled = true;
    await page.evaluate(() => {
      const state = (window as Window & {
        __t097ScopeWatch?: { active: boolean; observations: string[] };
      }).__t097ScopeWatch!;
      state.observations.length = 0;
      state.active = true;
      sessionStorage.setItem("t097.scope-observation-active", "1");
      sessionStorage.setItem("t097.scope-observations", "[]");
    });
    const revokedBarrier = revokedHold.arm();
    await startScopeObservation(page);
    const revokedBack = page.goBack({ waitUntil: "commit" }).catch((error: unknown) => error);
    await expectScopeUrl(page, bBuildUrl);
    await revokedBarrier.arrived;
    const heldRevokedState = await page.evaluate(() => ({
      status: /正在重新確認存取權限|正在由伺服器確認登入、權限與專案資料/.test(document.body.innerText),
      statuses: [...document.querySelectorAll("[role='status']")].map((element) => ({
        text: element.textContent,
        hidden: (element as HTMLElement).hidden,
        visible: element.getClientRects().length > 0,
      })),
      closedVisible: [...document.querySelectorAll("[role='alert']")].some(
        (element) => element.getClientRects().length > 0,
      ),
      pageText: document.body.innerText.slice(0, 240),
      protectedVisible: [...document.querySelectorAll(
        "[data-testid='workspace-project-context'], [data-testid='project-workspace-tabs'], " +
        "[data-testid='work-limitations'], [data-testid='project-file-workspace']",
      )].some((element) => {
        const node = element as HTMLElement;
        return node.getClientRects().length > 0 && getComputedStyle(node).visibility !== "hidden";
      }),
      observations: (window as Window & { __t097ScopeWatch?: { observations: string[] } })
        .__t097ScopeWatch!.observations.slice(),
      visibleMarkers: [
        "T097-SYNTHETIC-TITLE",
        "T097-SYNTHETIC-FILE",
        "目前的作品需求符合首版範圍",
      ].filter((marker) => document.body.innerText.includes(marker)),
      recorded: JSON.parse(sessionStorage.getItem("t097.scope-observations") ?? "[]") as string[],
    }));
    console.log(`T097F01RevocationHeld=${JSON.stringify(heldRevokedState)}`);
    expect.soft(heldRevokedState.status).toBe(true);
    expect.soft(heldRevokedState.protectedVisible).toBe(false);
    expect.soft(heldRevokedState.visibleMarkers).toEqual([]);
    expect.soft(heldRevokedState.recorded).toEqual([]);
    const revokedRequestId = await releaseCurrentScopeResult(
      page, new URL(bBuildUrl).pathname, revokedBarrier.release, "access_closed");
    const revokedBackResult = await revokedBack;
    if (revokedBackResult instanceof Error) throw revokedBackResult;
    await revokedHold.remove();
    await expect.soft(page.getByTestId("project-workspace-closed")).toBeVisible();
    await expect.soft(page.getByTestId("workspace-project-context")).toBeHidden();
    await finishScopeObservation(page, new URL(bBuildUrl).pathname, true, revokedRequestId);
    await control.query(
      "UPDATE app.profiles SET status='approved',status_changed_at=now() WHERE id=$1",
      [owner.id],
    );
    ownerDisabled = false;

    const interleavedProject = await confirmClassification(
      await saveRequirements(await createProject(page, "T097-E01-interleaved"),
        requirement("T097-E01-INITIAL", "static")), "A", false,
    );
    const interleavedPath = `/student/projects/${interleavedProject.id}/build`;
    await page.goto(`${origin}${interleavedPath}`);
    await expect(page.getByTestId("work-limitations")).toBeVisible();
    const oldCaptured = deferred<void>();
    const currentCaptured = deferred<void>();
    const releaseOld = deferred<void>();
    const releaseCurrent = deferred<void>();
    const oldDelivered = deferred<void>();
    const currentDelivered = deferred<void>();
    const interleavedEvents: string[] = [];
    let requestCount = 0;
    let oldRequestId: string | null = null;
    let currentRequestId: string | null = null;
    const interleavedMatcher = (url: URL) => url.pathname === interleavedPath && url.searchParams.has("_rsc");
    const interleavedHandler = async (route: import("@playwright/test").Route) => {
      requestCount++;
      const requestId = new URL(route.request().url()).searchParams.get("__scope_request");
      if (requestCount === 1) {
        oldRequestId = requestId;
        const response = await route.fetch();
        const body = await response.text();
        expect(response.status()).toBe(200);
        expect(body).toContain("within_scope");
        expect(body).toContain(requestId!);
        interleavedEvents.push("earlier-trusted-positive-captured");
        oldCaptured.resolve();
        await releaseOld.promise;
        await route.fulfill({ response, body });
        interleavedEvents.push("earlier-response-delivered-to-browser");
        oldDelivered.resolve();
      } else if (requestCount === 2) {
        currentRequestId = requestId;
        interleavedEvents.push("current-request-held-before-server");
        currentCaptured.resolve();
        await releaseCurrent.promise;
        const response = await route.fetch();
        const body = await response.text();
        expect(response.status()).toBe(200);
        expect(body).toContain("outside_scope");
        expect(body).toContain(requestId!);
        await route.fulfill({ response, body });
        interleavedEvents.push("current-trusted-result-delivered");
        currentDelivered.resolve();
      } else {
        await route.continue();
      }
    };
    await page.route(interleavedMatcher, interleavedHandler);
    try {
      await page.evaluate(() => window.dispatchEvent(new Event("focus")));
      await oldCaptured.promise;
      await saveRequirements(interleavedProject, requirement("T097-E01-REVISED", "restricted_server"));
      interleavedEvents.push("requirements-update-committed");
      await page.evaluate(() => window.dispatchEvent(new Event("focus")));
      await currentCaptured.promise;
      expect(oldRequestId).toBeTruthy();
      expect(currentRequestId).toBeTruthy();
      expect(currentRequestId).not.toBe(oldRequestId);
      await startScopeObservation(page);
      releaseOld.resolve();
      await oldDelivered.promise;
      await page.evaluate(() => new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      const oldReachedView = await page.getByTestId("work-limitations")
        .getAttribute("data-scope-request") === oldRequestId;
      console.log(`T097E01EarlierDelivery=${JSON.stringify({
        oldReachedView,
        classification: oldReachedView ? "committed-to-product-view" : "not-observed-at-product-view-framework-discard-or-pending",
        boundaryRegression: "tests/unit/protected-project-view.test.ts directly invokes actual receiver",
        events: interleavedEvents,
      })}`);
      await expect(page.getByTestId("workspace-project-context")).toBeHidden();
      await expect(page.getByTestId("project-file-workspace")).toBeHidden();
      await expect(page.getByTestId("work-limitations")).toBeHidden();
      interleavedEvents.push("earlier-response-cannot-unmask");
      await scopePhase(page, "current-result-released");
      releaseCurrent.resolve();
      await currentDelivered.promise;
      await expect(page.getByTestId("work-limitations")).toHaveAttribute("data-scope-state", "outside_scope");
      await expect(page.getByTestId("work-limitations")).toBeVisible();
      await finishScopeObservation(page, interleavedPath, false, currentRequestId);
      console.log(`T097E01InterleavedEvents=${JSON.stringify(interleavedEvents)}`);
    } finally {
      releaseOld.resolve();
      releaseCurrent.resolve();
      await page.unroute(interleavedMatcher, interleavedHandler);
    }

    await saveFile(page, interleavedProject.id, "<h1>T097-HASH-SAVED</h1>");
    await page.evaluate(() => {
      history.pushState(history.state, "", `${window.location.pathname}#file=index.html`);
      history.pushState(history.state, "", window.location.pathname);
    });
    const hashRecheck = page.waitForResponse((response) =>
      new URL(response.url()).pathname === interleavedPath &&
      new URL(response.url()).searchParams.has("__scope_request"));
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    expect((await hashRecheck).status()).toBe(200);
    await expect(page.getByTestId("workspace-project-context")).toBeVisible();
    expect(new URL(page.url()).searchParams.has("__scope_request")).toBe(false);
    await page.goBack();
    await expect(page).toHaveURL(`${origin}${interleavedPath}#file=index.html`);
    await expect(page.getByTestId("workspace-project-context")).toBeVisible();
    await expect(page.locator(".monaco-editor .view-lines")).toContainText("T097-HASH-SAVED");
    console.log("T097E01HashHistory=refresh_between_hash_entries;nonce_removed;browser_back_visible;saved_content_preserved");

    const f03Project = await createProject(page, "T097-F03-closed-parent");
    const f03VersionsPath = `/student/projects/${f03Project.id}/versions`;
    const f03BuildPath = `/student/projects/${f03Project.id}/build`;
    await page.goto(`${origin}${f03VersionsPath}`);
    await expect(page.getByTestId("workspace-project-context")).toBeVisible();
    await expect(page.getByRole("heading", { name: "版本", exact: true })).toBeVisible();
    const f03Events = ["layout-found"];
    let f03Requests = 0;
    const f03AccessClosedDelivered = deferred<void>();
    const f03RefreshArrived = deferred<void>();
    const releaseF03Refresh = deferred<void>();
    const f03RefreshSettled = deferred<void>();
    const f03BuildMatcher = (url: URL) =>
      url.pathname === f03BuildPath && url.searchParams.has("_rsc");
    const f03BuildHandler = async (route: import("@playwright/test").Route) => {
      f03Requests += 1;
      const response = await route.fetch();
      const body = await response.text();
      if (!body.includes("requirements_missing")) {
        throw new Error("F-03 RSC fixture did not contain the expected synthetic scope state.");
      }
      const accessClosedBody = body.replaceAll("requirements_missing", "access_closed");
      if (f03Requests === 1) {
        await route.fulfill({ response, body: accessClosedBody });
        f03Events.push("eligibility-access_closed");
        f03AccessClosedDelivered.resolve();
        return;
      }
      f03RefreshArrived.resolve();
      await releaseF03Refresh.promise;
      try {
        await route.fulfill({ response, body: accessClosedBody });
      } finally {
        f03RefreshSettled.resolve();
      }
    };
    await page.route(f03BuildMatcher, f03BuildHandler);
    try {
      await page.getByRole("link", { name: "建立 App", exact: true }).click();
      await expectScopeUrl(page, `${origin}${f03BuildPath}`);
      await f03AccessClosedDelivered.promise;
      await expect(page.getByTestId("project-workspace-closed")).toBeVisible();
      const deniedParentState = await page.evaluate(() => ({
        parentContentHidden: document.querySelector(".page-shell")?.closest("div[hidden]") !== null,
        layoutDenied: document.querySelector("main[data-testid='project-workspace-closed']") !== null,
        contextMounted: document.querySelector("[data-testid='workspace-project-context']") !== null,
        navigationMounted: document.querySelector("[data-testid='project-workspace-tabs']") !== null,
      }));
      expect(deniedParentState.parentContentHidden).toBe(true);
      expect(deniedParentState.layoutDenied).toBe(false);
      expect(deniedParentState.contextMounted).toBe(true);
      expect(deniedParentState.navigationMounted).toBe(true);
      await f03RefreshArrived.promise;
      f03Events.push("followup-refresh-held");
      console.log(`T097F03_EVENTS=${JSON.stringify(f03Events)}`);
      releaseF03Refresh.resolve();
      await f03RefreshSettled.promise;
      await page.unroute(f03BuildMatcher, f03BuildHandler);
      await expect(page.getByTestId("project-workspace-closed")).toBeVisible();
      await page.goBack({ waitUntil: "commit" });
      await expect(page).toHaveURL(`${origin}${f03VersionsPath}`);
      await page.waitForLoadState("networkidle");
      const returnedParentState = await page.evaluate(() => ({
        path: window.location.pathname,
        versionHeadingCount: document.querySelectorAll("section[aria-label='版本'] > h1").length,
        pageText: document.body.innerText.slice(0, 180),
        closedAlertVisible: [...document.querySelectorAll(
          "p[data-testid='project-workspace-closed']",
        )].some((element) => (element as HTMLElement).getClientRects().length > 0),
        layoutDenied: document.querySelector("main[data-testid='project-workspace-closed']") !== null,
        parentContentHidden: document.querySelector(".page-shell")?.closest("div[hidden]") !== null,
        contextMounted: document.querySelector("[data-testid='workspace-project-context']") !== null,
        navigationMounted: document.querySelector("[data-testid='project-workspace-tabs']") !== null,
        protectedVisible: [...document.querySelectorAll(
          "[data-testid='workspace-project-context'], [data-testid='project-workspace-tabs'], " +
          "[data-testid='project-file-workspace'], [data-testid='project-snapshots-panel']",
        )].some((element) => (element as HTMLElement).getClientRects().length > 0),
      }));
      f03Events.push("browser-back-to-cached-versions");
      console.log(`T097F03_RETURN=${JSON.stringify({ ...returnedParentState, events: f03Events })}`);
      expect(returnedParentState.path).toBe(f03VersionsPath);
      expect(returnedParentState.closedAlertVisible).toBe(true);
      expect(returnedParentState.layoutDenied).toBe(false);
      expect(returnedParentState.parentContentHidden).toBe(true);
      expect(returnedParentState.contextMounted).toBe(true);
      expect(returnedParentState.navigationMounted).toBe(true);
      expect(returnedParentState.protectedVisible).toBe(false);
      expect(returnedParentState.versionHeadingCount).toBe(1);
    } finally {
      releaseF03Refresh.resolve();
      if (f03Requests > 1) await f03RefreshSettled.promise;
      await page.unroute(f03BuildMatcher, f03BuildHandler);
    }

    for (const destination of ["build", "publish"] as const) {
      await installSession(context, (await loginSyntheticAccount(owner)).accessToken);
      const f02Project = await createProject(page, `T097-F02-${destination}`);
      const f02Page = await context.newPage();
      const f02Path = `/student/projects/${f02Project.id}/${destination}`;
      const f02Events: string[] = [];
      const eligibilityBarrier = new Client({
        connectionString: process.env.APP_PLANET_TEST_DB_ADMIN_URL,
      });
      let barrierLocked = false;
      let releaseHeldRefresh: (() => void) | null = null;
      let removeRefreshHold: (() => Promise<void>) | null = null;
      let heldRefreshSettled: Promise<void> | null = null;
      try {
        await f02Page.goto(`${origin}${f02Path}`);
        await expect(f02Page.getByTestId("workspace-project-context")).toBeVisible();
        await expect(f02Page.getByRole("heading", { name: `T097-F02-${destination}`, exact: true })).toBeVisible();
        await expect(f02Page.getByTestId("project-workspace-tabs")).toBeVisible();
        await expect(f02Page.getByTestId("work-limitations")).toBeVisible();
        if (destination === "build") {
          await expect(f02Page.getByTestId("project-file-workspace")).toBeVisible();
        } else {
          await expect(f02Page.getByTestId("publish-workflow-unavailable")).toBeVisible();
        }
        f02Events.push("layout-found");
        await f02Page.getByRole("link", { name: "版本", exact: true }).click();
        await expect(f02Page).toHaveURL(`${origin}/student/projects/${f02Project.id}/versions`);
        await expect(f02Page.getByTestId("workspace-project-context")).toBeVisible();
        await eligibilityBarrier.connect();
        await eligibilityBarrier.query(
          "SELECT pg_advisory_lock(hashtext($1), $2)",
          [f02Project.id, eligibilityBarrierKey],
        );
        barrierLocked = true;
        const refreshHold = installScopeRefreshHold(f02Page, f02Path, true);
        removeRefreshHold = refreshHold.remove;
        await refreshHold.install();
        const heldRefresh = refreshHold.arm(1);
        releaseHeldRefresh = heldRefresh.release;
        const pageResult = f02Page.waitForResponse((response) =>
          new URL(response.url()).pathname === f02Path &&
          response.request().method() === "GET" &&
          new URL(response.url()).searchParams.has("_rsc"));
        const click = f02Page.getByRole("link", {
          name: destination === "build" ? "建立 App" : "發布",
          exact: true,
        }).click();
        await expect.poll(async () => {
          const waiting = await control.query(`
            SELECT count(*)::int AS count
            FROM pg_stat_activity
            WHERE wait_event_type='Lock'
              AND query LIKE '%pg_advisory_lock(hashtext%'
              AND application_name='app-planet-web'
          `);
          return Number(waiting.rows[0]?.count ?? 0);
        }, { timeout: 10_000 }).toBeGreaterThan(0);
        f02Events.push("eligibility-awaiting");
        await control.query(
          "UPDATE app.profiles SET status='disabled',status_changed_at=now() WHERE id=$1",
          [owner.id],
        );
        ownerDisabled = true;
        f02Events.push("revocation-committed");
        await eligibilityBarrier.query(
          "SELECT pg_advisory_unlock(hashtext($1), $2)",
          [f02Project.id, eligibilityBarrierKey],
        );
        barrierLocked = false;
        await click;
        await expectScopeUrl(f02Page, `${origin}${f02Path}`);
        const response = await pageResult;
        expect(response.status()).toBe(200);
        const rscBody = await response.text();
        expect(rscBody).toContain("access_closed");
        f02Events.push("eligibility-access_closed");
        await heldRefresh.arrived;
        heldRefreshSettled = heldRefresh.settled;
        f02Events.push("followup-refresh-held");
        console.log(`T097F02_EVENTS_${destination}=${JSON.stringify(f02Events)}`);
        await expect(f02Page.locator("p[data-testid='project-workspace-closed']"))
          .toContainText("無法確認存取權限；受保護專案資料已隱藏。");
        const parentState = await f02Page.evaluate(() => ({
          title: document.querySelector(".page-shell > main h1")?.textContent?.trim() ?? null,
          parentContentMounted: document.querySelector(".page-shell")?.isConnected ?? false,
          parentContentHidden: document.querySelector(".page-shell")?.closest("div[hidden]") !== null,
          layoutDenied: document.querySelector("main[data-testid='project-workspace-closed']") !== null,
          contextMounted: document.querySelector("[data-testid='workspace-project-context']") !== null,
          contextVisible: [...document.querySelectorAll("[data-testid='workspace-project-context']")]
            .some((element) => (element as HTMLElement).getClientRects().length > 0),
          navigationMounted: document.querySelector("[data-testid='project-workspace-tabs']") !== null,
          navigationVisible: [...document.querySelectorAll("[data-testid='project-workspace-tabs']")]
            .some((element) => (element as HTMLElement).getClientRects().length > 0),
          scopeVisible: [...document.querySelectorAll("[data-testid='work-limitations']")]
            .some((element) => (element as HTMLElement).getClientRects().length > 0),
          filesVisible: [...document.querySelectorAll("[data-testid='project-file-workspace']")]
            .some((element) => (element as HTMLElement).getClientRects().length > 0),
        }));
        console.log(`T097F02_${destination}=${JSON.stringify({ events: f02Events, parentState })}`);
        expect.soft(parentState.title).toBe(`T097-F02-${destination}`);
        expect.soft(parentState.parentContentMounted).toBe(true);
        expect.soft(parentState.parentContentHidden).toBe(true);
        expect.soft(parentState.layoutDenied).toBe(false);
        expect.soft(parentState.contextMounted).toBe(true);
        expect.soft(parentState.navigationMounted).toBe(true);
        expect.soft(parentState.contextVisible).toBe(false);
        expect.soft(parentState.navigationVisible).toBe(false);
        expect.soft(parentState.scopeVisible).toBe(false);
        expect.soft(parentState.filesVisible).toBe(false);
      } finally {
        releaseHeldRefresh?.();
        if (heldRefreshSettled) await heldRefreshSettled;
        await removeRefreshHold?.();
        if (barrierLocked) {
          await eligibilityBarrier.query(
            "SELECT pg_advisory_unlock(hashtext($1), $2)",
            [f02Project.id, eligibilityBarrierKey],
          );
        }
        await eligibilityBarrier.end();
        if (ownerDisabled) {
          await control.query(
            "UPDATE app.profiles SET status='approved',status_changed_at=now() WHERE id=$1",
            [owner.id],
          );
          ownerDisabled = false;
        }
        await f02Page.close();
      }
    }

    const otherPage = await otherContext.newPage();
    for (const destination of ["build", "publish"] as const) {
      await otherPage.goto(`${origin}/student/projects/${bProject.id}/${destination}`);
      await expect(otherPage.getByTestId("project-workspace-closed")).toBeVisible();
      await expect(otherPage.getByTestId("work-limitations")).toHaveCount(0);
      await expect(otherPage.getByText(/首版不提供公開服務/)).toHaveCount(0);
    }

    await control.query(
      "UPDATE app.profiles SET status='disabled',status_changed_at=now() WHERE id=$1",
      [owner.id],
    );
    ownerDisabled = true;
    await page.goto(`${origin}/student/projects/${bProject.id}/publish`);
    await expect(page.getByTestId("project-workspace-closed")).toBeVisible();
    await expect(page.getByTestId("work-limitations")).toHaveCount(0);

    console.log("T097Browser=verified_https_auth_postgres; A_build_publish; B_private_public; restricted_server; runtime_ai; revision_refresh; project_switch; non_owner_and_disabled_hidden");
  } finally {
    if (ownerDisabled) {
      await control.query(
        "UPDATE app.profiles SET status='approved',status_changed_at=now() WHERE id=$1",
        [owner.id],
      );
    }
    await context.close();
    await otherContext.close();
    if (projectIds.length) {
      await control.query(`
        UPDATE app.projects
        SET classification_state='unconfirmed',tier=NULL,
          needs_visitor_identity=NULL,current_confirmation_id=NULL
        WHERE id=ANY($1::uuid[])
      `, [projectIds]);
      for (const table of [
        "project_restore_receipts",
        "snapshot_receipts",
        "snapshots",
        "project_file_audit",
        "project_file_receipts",
        "project_files",
        "project_classification_idempotency",
        "project_classification_confirmations",
        "project_requirements",
        "project_create_idempotency",
        "projects",
      ]) {
        await control.query(
          `DELETE FROM app.${table} WHERE ${table === "projects" ? "id" : "project_id"}=ANY($1::uuid[])`,
          [projectIds],
        );
      }
    }
    await control.query(`DELETE FROM app.audit_events WHERE actor_aid IN
      (SELECT aid FROM app.audit_identity_map WHERE account_id=ANY($1::uuid[]))
      OR subject_aid IN
      (SELECT aid FROM app.audit_identity_map WHERE account_id=ANY($1::uuid[]))`,
    [[owner.id, other.id]]);
    await control.query(
      "DELETE FROM app.audit_identity_map WHERE account_id=ANY($1::uuid[])",
      [[owner.id, other.id]],
    );
    await control.query("DELETE FROM app.profiles WHERE id=ANY($1::uuid[])", [[owner.id, other.id]]);
    await control.query("DELETE FROM app.schools WHERE id=ANY($1::uuid[])", [[owner.schoolId, other.schoolId]]);
    await deleteSyntheticAuthAccount(owner);
    await deleteSyntheticAuthAccount(other);
    await control.end();
  }
});
