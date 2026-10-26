import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createCheckpoints } from "../../apps/worker/src/jobs/checkpoint.ts";
import { closeServerDatabasePool } from "../../apps/web/src/server/database-session.ts";
import { sessionCookieName } from "../../apps/web/src/server/auth-principal.ts";
import { GET as getStageDraft, PUT as putStageDraft } from "../../apps/web/src/app/api/v1/projects/[id]/stages/[stage]/route.ts";
import { GET as getJob } from "../../apps/web/src/app/api/v1/jobs/[id]/route.ts";
import { POST as stopAgentRun } from "../../apps/web/src/app/api/v1/agent-runs/[id]/stop/route.ts";
import { POST as logout } from "../../apps/web/src/app/api/v1/auth/logout/route.ts";
import {
  closeSyntheticWorkerPool,
  createOwnedSyntheticProject,
  createSyntheticAgentJob,
  createSyntheticAuthAccount,
  createSyntheticWorkerContext,
  deleteSyntheticAuthAccount,
  loginSyntheticAccount,
  openControlPool,
  type NativeAuthSession,
  type SyntheticAuthAccount,
} from "../support/real-auth-fixture.ts";

const authOrigin = process.env.APP_PLANET_AUTH_ORIGIN!;
const authApiKey = process.env.APP_PLANET_AUTH_API_KEY!;
const appOrigin = process.env.APP_PLANET_APP_ORIGIN!;
const accounts: SyntheticAuthAccount[] = [];
const projectIds: string[] = [];
let control!: Pool;
let firstAccount: SyntheticAuthAccount;
let secondAccount: SyntheticAuthAccount;
let firstProject: string;
let raceProject: string;

function request(
  path: string,
  method: string,
  session?: NativeAuthSession,
  headers: Record<string, string> = {},
  body?: unknown,
): Request {
  const requestHeaders = new Headers(headers);
  if (session) requestHeaders.set("cookie", `${sessionCookieName}=${session.accessToken}`);
  if (method !== "GET" && method !== "HEAD" && !requestHeaders.has("origin")) {
    requestHeaders.set("origin", appOrigin);
  }
  if (body !== undefined) requestHeaders.set("content-type", "application/json");
  return new Request(`${appOrigin}${path}`, {
    method,
    headers: requestHeaders,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

function draftPath(projectId: string): string {
  return `/api/v1/projects/${encodeURIComponent(projectId)}/stages/Specification`;
}

function draftRouteParams(projectId: string) {
  return { params: Promise.resolve({ id: projectId, stage: "Specification" }) };
}

async function putDraft(
  projectId: string,
  session: NativeAuthSession | undefined,
  content: string,
  key: string,
  precondition: Record<string, string>,
  extra: Record<string, string> = {},
): Promise<Response> {
  return putStageDraft(request(
    draftPath(projectId),
    "PUT",
    session,
    { "idempotency-key": key, ...precondition, ...extra },
    { content: { text: content } },
  ), draftRouteParams(projectId));
}

async function authUserStatus(session: NativeAuthSession): Promise<number> {
  const response = await fetch(`${authOrigin}/auth/v1/user`, {
    cache: "no-store",
    redirect: "error",
    headers: {
      apikey: authApiKey,
      authorization: `Bearer ${session.accessToken}`,
    },
    signal: AbortSignal.timeout(5_000),
  });
  return response.status;
}

function restoreAuthOrigin(origin: string | undefined): void {
  if (origin === undefined) delete process.env.APP_PLANET_AUTH_ORIGIN;
  else process.env.APP_PLANET_AUTH_ORIGIN = origin;
}

beforeAll(async () => {
  control = openControlPool();
  firstAccount = await createSyntheticAuthAccount(control, "A");
  secondAccount = await createSyntheticAuthAccount(control, "B");
  accounts.push(firstAccount, secondAccount);
  firstProject = await createOwnedSyntheticProject(firstAccount);
  raceProject = await createOwnedSyntheticProject(firstAccount);
  projectIds.push(firstProject, raceProject);
});

afterAll(async () => {
  const errors: unknown[] = [];
  try {
    await closeServerDatabasePool();
    await closeSyntheticWorkerPool();
    if (!control) return;
    if (projectIds.length) {
      await control.query("DELETE FROM app.stage_draft_idempotency WHERE project_id=ANY($1::uuid[])", [projectIds]);
      await control.query("DELETE FROM app.stage_records WHERE project_id=ANY($1::uuid[])", [projectIds]);
      await control.query("DELETE FROM app.project_create_idempotency WHERE project_id=ANY($1::uuid[])", [projectIds]);
      await control.query("DELETE FROM app.projects WHERE id=ANY($1::uuid[])", [projectIds]);
    }
    await control.query("DELETE FROM app.usage_audit");
    await control.query("DELETE FROM app.jobs");
    await control.query("DELETE FROM app.usage_reservations");
    await control.query("DELETE FROM app.usage_totals");
    await control.query("DELETE FROM app.model_prices");
    await control.query("DELETE FROM app.quota_policies");
    await control.query("DELETE FROM app.pool_limits");
    await control.query("DELETE FROM app.budget_pools");
    for (const account of accounts) {
      await control.query("DELETE FROM app.profiles WHERE id=$1", [account.id]);
      await control.query("DELETE FROM app.schools WHERE id=$1", [account.schoolId]);
      await deleteSyntheticAuthAccount(account);
    }
  } catch (error) {
    errors.push(error);
  } finally {
    await control?.end();
  }
  if (errors.length) throw new Error("真實 Auth 整合測試清理失敗。", { cause: errors[0] });
});

describe("真實本機 Auth → Next Route Handler → 隔離 PostgreSQL", () => {
  it("真 session 可讀取、首建、更新、同鍵重放；格式、412／409／422 沿用共用 handler", async () => {
    const session = await loginSyntheticAccount(firstAccount);
    const path = draftPath(firstProject);
    const readBefore = await getStageDraft(request(path, "GET", session), draftRouteParams(firstProject));
    expect(readBefore.status).toBe(404);

    const key = randomUUID();
    const created = await putDraft(firstProject, session, "初次草稿", key, { "if-none-match": "*" });
    expect(created.status).toBe(201);
    expect(created.headers.get("location")).toBe(path);
    expect(created.headers.get("etag")).toBe('"0"');
    expect(await created.json()).toMatchObject({
      project_id: firstProject,
      row_version: 0,
      content: { text: "初次草稿" },
      content_source: "student_input",
    });

    const updated = await putDraft(firstProject, session, "更新草稿", randomUUID(), { "if-match": '"0"' });
    expect(updated.status).toBe(200);
    expect(updated.headers.get("etag")).toBe('"1"');
    expect(await updated.json()).toMatchObject({ row_version: 1, content: { text: "更新草稿" } });

    const replay = await putDraft(firstProject, session, "初次草稿", key, { "if-none-match": "*" });
    expect(replay.status).toBe(200);
    expect(replay.headers.get("idempotent-replay")).toBe("true");
    expect(await replay.json()).toMatchObject({
      operation: { row_version: 0, content: { text: "初次草稿" } },
      current_draft: { row_version: 1, content: { text: "更新草稿" } },
    });
    expect((await putDraft(firstProject, session, "異內容", key, { "if-none-match": "*" })).status).toBe(422);
    expect((await putDraft(firstProject, session, "舊版本", randomUUID(), { "if-match": '"0"' })).status).toBe(409);
    expect((await putDraft(firstProject, session, "缺前置", randomUUID(), {})).status).toBe(400);
    expect((await putDraft(firstProject, session, "並存前置", randomUUID(), {
      "if-match": '"1"', "if-none-match": "*",
    })).status).toBe(400);

    const current = await getStageDraft(request(path, "GET", session), draftRouteParams(firstProject));
    expect(current.status).toBe(200);
    expect(current.headers.get("etag")).toBe('"1"');
  });

  it("並行首建、跨帳號、偽造身分標頭、未登入與來源檢查均經產品路由", async () => {
    const owner = await loginSyntheticAccount(firstAccount);
    const other = await loginSyntheticAccount(secondAccount);
    const attempts = await Promise.all(Array.from({ length: 8 }, (_, index) =>
      putDraft(raceProject, owner, `race-${index}`, randomUUID(), { "if-none-match": "*" })));
    expect(attempts.filter((response) => response.status === 201)).toHaveLength(1);
    expect(attempts.filter((response) => response.status === 412)).toHaveLength(7);

    const ownRead = await getStageDraft(request(draftPath(firstProject), "GET", owner, {
      "x-user-id": secondAccount.id,
      "x-role": "admin",
      "x-school-id": secondAccount.schoolId,
    }), draftRouteParams(firstProject));
    expect(ownRead.status).toBe(200);
    const crossRead = await getStageDraft(request(draftPath(firstProject), "GET", other), draftRouteParams(firstProject));
    expect(crossRead.status).toBe(404);
    const crossWrite = await putDraft(firstProject, other, "跨帳號", randomUUID(), { "if-match": '"1"' }, {
      "x-user-id": firstAccount.id,
      "x-role": "student",
      "x-school-id": firstAccount.schoolId,
    });
    expect(crossWrite.status).toBe(404);

    const missing = await getStageDraft(request(draftPath(firstProject), "GET"), draftRouteParams(firstProject));
    expect(missing.status).toBe(401);
    const forged = request(draftPath(firstProject), "GET", undefined);
    forged.headers.set("cookie", `${sessionCookieName}=not-a-real-session`);
    expect((await getStageDraft(forged, draftRouteParams(firstProject))).status).toBe(401);

    const noOrigin = new Request(`${appOrigin}${draftPath(firstProject)}`, {
      method: "PUT",
      headers: {
        cookie: `${sessionCookieName}=${owner.accessToken}`,
        "content-type": "application/json",
        "idempotency-key": randomUUID(),
        "if-match": '"1"',
      },
      body: JSON.stringify({ content: { text: "CSRF" } }),
    });
    expect((await putStageDraft(noOrigin, draftRouteParams(firstProject))).status).toBe(403);
    expect((await putDraft(firstProject, owner, "CSRF", randomUUID(), { "if-match": '"1"' }, {
      origin: "https://attacker.example.invalid",
    })).status).toBe(403);
    expect((await putDraft(firstProject, owner, "CSRF", randomUUID(), { "if-match": '"1"' }, {
      "sec-fetch-site": "cross-site",
    })).status).toBe(403);
    expect(noOrigin.headers.has("origin")).toBe(false);
  });

  it("Auth 不可用、逾時、畸形回應與 DB 帳號 gate 變更 fail closed，不寫入草稿", async () => {
    const session = await loginSyntheticAccount(firstAccount);
    const before = await control.query(
      "SELECT row_version,content FROM app.stage_records WHERE project_id=$1 AND stage='Specification'",
      [firstProject],
    );
    const originalAuthOrigin = process.env.APP_PLANET_AUTH_ORIGIN;
    process.env.APP_PLANET_AUTH_ORIGIN = "http://127.0.0.1:1";
    try {
      const unavailable = await putDraft(firstProject, session, "Auth unavailable", randomUUID(), {
        "if-match": '"1"',
      });
      expect(unavailable.status).toBe(503);
    } finally {
      restoreAuthOrigin(originalAuthOrigin);
    }

    const malformedServer = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{");
    });
    await new Promise<void>((resolveListen, rejectListen) => {
      malformedServer.once("error", rejectListen);
      malformedServer.listen(0, "127.0.0.1", resolveListen);
    });
    const malformedAddress = malformedServer.address();
    if (!malformedAddress || typeof malformedAddress === "string") {
      throw new Error("Auth malformed-response test server did not bind.");
    }
    process.env.APP_PLANET_AUTH_ORIGIN = `http://127.0.0.1:${malformedAddress.port}`;
    try {
      const malformed = await putDraft(firstProject, session, "Auth malformed", randomUUID(), {
        "if-match": '"1"',
      });
      expect(malformed.status).toBe(503);
    } finally {
      malformedServer.closeAllConnections();
      await new Promise<void>((resolveClose, rejectClose) => {
        malformedServer.close((error) => error ? rejectClose(error) : resolveClose());
      });
      restoreAuthOrigin(originalAuthOrigin);
    }

    let delayedResponse: NodeJS.Timeout | undefined;
    const slowServer = createServer((_request, response) => {
      delayedResponse = setTimeout(() => {
        if (!response.destroyed) {
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify({ id: firstAccount.id }));
        }
      }, 5_500);
    });
    await new Promise<void>((resolveListen, rejectListen) => {
      slowServer.once("error", rejectListen);
      slowServer.listen(0, "127.0.0.1", resolveListen);
    });
    const slowAddress = slowServer.address();
    if (!slowAddress || typeof slowAddress === "string") {
      throw new Error("Auth timeout test server did not bind.");
    }
    process.env.APP_PLANET_AUTH_ORIGIN = `http://127.0.0.1:${slowAddress.port}`;
    try {
      const timeout = await putDraft(firstProject, session, "Auth timeout", randomUUID(), {
        "if-match": '"1"',
      });
      expect(timeout.status).toBe(503);
    } finally {
      clearTimeout(delayedResponse);
      slowServer.closeAllConnections();
      await new Promise<void>((resolveClose, rejectClose) => {
        slowServer.close((error) => error ? rejectClose(error) : resolveClose());
      });
      restoreAuthOrigin(originalAuthOrigin);
    }

    await control.query("UPDATE app.profiles SET status='disabled' WHERE id=$1", [firstAccount.id]);
    const disabled = await putDraft(firstProject, session, "帳號停用", randomUUID(), { "if-match": '"1"' });
    expect(disabled.status).toBe(403);
    await control.query("UPDATE app.profiles SET status='approved' WHERE id=$1", [firstAccount.id]);
    await control.query("UPDATE app.schools SET approval_state='unconfirmed' WHERE id=$1", [firstAccount.schoolId]);
    const schoolGate = await putDraft(firstProject, session, "學校未確認", randomUUID(), { "if-match": '"1"' });
    expect(schoolGate.status).toBe(403);
    await control.query("UPDATE app.schools SET approval_state='approved' WHERE id=$1", [firstAccount.schoolId]);

    const after = await control.query(
      "SELECT row_version,content FROM app.stage_records WHERE project_id=$1 AND stage='Specification'",
      [firstProject],
    );
    expect(after.rows).toEqual(before.rows);
  });

  it("Job 狀態／取消走 owner-only 交易；Worker 依既有規則釋放未送出的預留", async () => {
    const owner = await loginSyntheticAccount(firstAccount);
    const other = await loginSyntheticAccount(secondAccount);
    const jobId = await createSyntheticAgentJob(control, firstAccount);
    const statusPath = `/api/v1/jobs/${jobId}`;
    const owned = await getJob(request(statusPath, "GET", owner), { params: Promise.resolve({ id: jobId }) });
    expect(owned.status).toBe(200);
    expect(await owned.json()).toMatchObject({ id: jobId, state: "queued", result: null });
    const hidden = await getJob(request(statusPath, "GET", other), { params: Promise.resolve({ id: jobId }) });
    expect(hidden.status).toBe(404);

    const deniedCancel = await stopAgentRun(
      request(`/api/v1/agent-runs/${jobId}/stop`, "POST", other),
      { params: Promise.resolve({ id: jobId }) },
    );
    expect(deniedCancel.status).toBe(404);
    const cancelled = await stopAgentRun(
      request(`/api/v1/agent-runs/${jobId}/stop`, "POST", owner),
      { params: Promise.resolve({ id: jobId }) },
    );
    expect(cancelled.status).toBe(202);
    const worker = createCheckpoints(createSyntheticWorkerContext(firstAccount.id), {
      async authorize() { return true; },
    }, randomUUID(), 5_000);
    expect(await worker.claim()).toBeNull();
    expect(await control.query(
      `SELECT j.state,r.state AS reservation_state
       FROM app.jobs j JOIN app.usage_reservations r ON r.id=j.reservation_id WHERE j.id=$1`,
      [jobId],
    )).toMatchObject({ rows: [{ state: "cancelled", reservation_state: "released" }] });
    const finalStatus = await getJob(request(statusPath, "GET", owner), {
      params: Promise.resolve({ id: jobId }),
    });
    expect(await finalStatus.json()).toMatchObject({ state: "cancelled", result: null });
  });

  it("原生 local logout 撤銷本 session 而保留另一 session；管理改碼後拒絕舊 session", async () => {
    const first = await loginSyntheticAccount(firstAccount);
    const second = await loginSyntheticAccount(firstAccount);
    expect(await authUserStatus(first)).toBe(200);
    expect(await authUserStatus(second)).toBe(200);

    const response = await logout(request("/api/v1/auth/logout", "POST", first));
    expect(response.status).toBe(204);
    expect(response.headers.get("set-cookie")).toMatch(/HttpOnly; Secure; SameSite=Strict; Max-Age=0/);
    expect([401, 403]).toContain(await authUserStatus(first));
    expect(await authUserStatus(second)).toBe(200);
    expect((await getStageDraft(
      request(draftPath(firstProject), "GET", first),
      draftRouteParams(firstProject),
    )).status).toBe(401);
    expect((await getStageDraft(
      request(draftPath(firstProject), "GET", second),
      draftRouteParams(firstProject),
    )).status).toBe(200);

    const replacementPassword = `${randomUUID()}Aa9!`;
    const update = await fetch(`${authOrigin}/auth/v1/admin/users/${firstAccount.id}`, {
      method: "PUT",
      cache: "no-store",
      redirect: "error",
      headers: {
        apikey: process.env.APP_PLANET_TEST_AUTH_ADMIN_KEY!,
        authorization: `Bearer ${process.env.APP_PLANET_TEST_AUTH_ADMIN_KEY!}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ password: replacementPassword }),
      signal: AbortSignal.timeout(10_000),
    });
    expect(update.ok).toBe(true);
    expect([401, 403]).toContain(await authUserStatus(second));

    firstAccount.password = replacementPassword;
    const replacementSession = await loginSyntheticAccount(firstAccount);
    expect(await authUserStatus(replacementSession)).toBe(200);
    expect(await authUserStatus(await loginSyntheticAccount(secondAccount))).toBe(200);
  });

  it("過期 access session 經 Auth /user 拒絕；不以解碼 JWT 降級", async () => {
    const session = await loginSyntheticAccount(secondAccount);
    await new Promise((resolve) => setTimeout(resolve, 61_000));
    expect([401, 403]).toContain(await authUserStatus(session));
    const expired = await getStageDraft(
      request(draftPath(firstProject), "GET", session),
      draftRouteParams(firstProject),
    );
    expect(expired.status).toBe(401);
  });
});
