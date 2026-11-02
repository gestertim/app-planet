import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createCheckpoints } from "../../apps/worker/src/jobs/checkpoint.ts";
import { closeServerDatabasePool } from "../../apps/web/src/server/database-session.ts";
import { sessionCookieName, createAuthPrincipalResolver } from "../../apps/web/src/server/auth-principal.ts";
import { createFoundationHandlers } from "../../apps/web/src/server/foundation-handlers.ts";
import { GET as getStageDraft, PUT as putStageDraft } from "../../apps/web/src/app/api/v1/projects/[id]/stages/[stage]/route.ts";
import { GET as getJob } from "../../apps/web/src/app/api/v1/jobs/[id]/route.ts";
import { POST as stopAgentRun } from "../../apps/web/src/app/api/v1/agent-runs/[id]/stop/route.ts";
import { POST as logout } from "../../apps/web/src/app/api/v1/auth/logout/route.ts";
import { POST as createProject } from "../../apps/web/src/app/api/v1/projects/route.ts";
import { POST as recoverProject } from "../../apps/web/src/app/api/v1/projects/recovery/route.ts";
import { GET as getProject } from "../../apps/web/src/app/api/v1/projects/[id]/route.ts";
import { PATCH as patchProjectTaskDone } from "../../apps/web/src/app/api/v1/projects/[id]/tasks/[tid]/route.ts";
import { listCurrentOwnedProjectsSubset } from "../../apps/web/src/server/projects.ts";
import {
  listOwnedProjectTasksSubset, patchOwnedProjectTaskDoneSubset,
} from "../../apps/web/src/server/project-tasks.ts";
import { createProjectHandlers } from "../../apps/web/src/server/project-handlers.ts";
import { createDatabaseSession } from "../../apps/web/src/server/database-session.ts";
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

function taskPath(projectId: string, taskId: string): string {
  return `/api/v1/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(taskId)}`;
}

function taskRouteParams(projectId: string, taskId: string) {
  return { params: Promise.resolve({ id: projectId, tid: taskId }) };
}

async function patchTask(
  projectId: string,
  taskId: string,
  session: NativeAuthSession | undefined,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  return patchProjectTaskDone(
    request(taskPath(projectId, taskId), "PATCH", session, headers, body),
    taskRouteParams(projectId, taskId),
  );
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
      await control.query("DELETE FROM app.tasks WHERE project_id=ANY($1::uuid[])", [projectIds]);
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
  it("P-1／P-2：真 session 建立、列表、詳情與 response-loss 同鍵重試不重建", async () => {
    const session = await loginSyntheticAccount(firstAccount);
    const key = randomUUID();
    const body = { title: "產品專案接線" };
    const send = (payload: unknown = body, actor = session) => createProject(request(
      "/api/v1/projects", "POST", actor, { "idempotency-key": key }, payload,
    ));
    const recover = (payload: unknown = body, actor = session) => recoverProject(request(
      "/api/v1/projects/recovery", "POST", actor, { "idempotency-key": key }, payload,
    ));
    const created = await send();
    expect(created.status).toBe(201);
    const project = await created.json();
    projectIds.push(project.id);
    expect(project).toMatchObject({
      title: body.title, classification_state: "unconfirmed", requested_tier: null,
      tier: null, needs_visitor_identity: null, stage: "點子", row_version: 0,
    });
    expect(created.headers.get("cache-control")).toBe("no-store");
    // 丟棄第一次 HTTP 結果，再以原 key／payload 取得 receipt。
    const replay = await recover();
    expect(replay.status).toBe(200);
    expect(replay.headers.get("cache-control")).toBe("no-store");
    expect(await replay.json()).toEqual({ outcome: "replayed", project });
    const createReplay = await send();
    expect(createReplay.status).toBe(201);
    expect(await createReplay.json()).toEqual(project);
    expect((await send({ title: "不同意圖" })).status).toBe(422);
    const missing = await recoverProject(request(
      "/api/v1/projects/recovery", "POST", session, { "idempotency-key": randomUUID() }, body,
    ));
    expect(missing.status).toBe(409);
    expect(await missing.json()).toMatchObject({
      code: "operation_outcome_unrecoverable", status: 409,
    });
    const { rows } = await control.query("SELECT count(*)::int AS n FROM app.projects WHERE id=$1", [project.id]);
    expect(rows[0].n).toBe(1);
    const listed = await listCurrentOwnedProjectsSubset(createDatabaseSession(firstAccount.id).read);
    expect(listed.outcome).toBe("listed");
    if (listed.outcome === "listed") expect(listed.projects.map((p) => p.id)).toContain(project.id);
    const detail = await getProject(request(`/api/v1/projects/${project.id}`, "GET", session), {
      params: Promise.resolve({ id: project.id }),
    });
    expect(detail.status).toBe(200);
    expect(detail.headers.get("etag")).toBe('"0"');
    expect(await detail.json()).toMatchObject({ id: project.id, title: body.title, classification_state: "unconfirmed" });
    const other = await loginSyntheticAccount(secondAccount);
    expect((await getProject(request(`/api/v1/projects/${project.id}`, "GET", other), {
      params: Promise.resolve({ id: project.id }),
    })).status).toBe(404);
    const otherList = await listCurrentOwnedProjectsSubset(createDatabaseSession(secondAccount.id).read);
    expect(otherList.outcome).toBe("listed");
    if (otherList.outcome === "listed") expect(otherList.projects.map((p) => p.id)).not.toContain(project.id);
    const forged = await getProject(request(`/api/v1/projects/${project.id}`, "GET", other, {
      "x-owner-id": firstAccount.id, "x-role": "student", "x-principal": firstAccount.id,
    }), { params: Promise.resolve({ id: project.id }) });
    expect(forged.status).toBe(404);
  });

  it("P-1 到期後同鍵可新建；replay-only 過期時固定失敗且不建第二列", async () => {
    const session = await loginSyntheticAccount(firstAccount);
    const key = randomUUID();
    const title = `receipt 到期語意 ${key.slice(0, 8)}`;
    const send = () => createProject(request("/api/v1/projects", "POST", session, { "idempotency-key": key }, { title }));
    const recover = () => recoverProject(request(
      "/api/v1/projects/recovery", "POST", session, { "idempotency-key": key }, { title },
    ));
    const count = async () => (await control.query(
      "SELECT count(*)::int AS n FROM app.projects WHERE title=$1", [title])).rows[0].n;
    const shift = (hours: number) => control.query(
      `UPDATE app.project_create_idempotency
         SET created_at = created_at - make_interval(hours => $2), expires_at = expires_at - make_interval(hours => $2)
       WHERE idempotency_key=$1`, [key, hours]);
    const first = await send();
    expect(first.status).toBe(201);
    const firstProject = await first.json();
    projectIds.push(firstProject.id);
    await shift(23);
    const replay = await send();
    expect(replay.status).toBe(201);
    expect((await replay.json()).id).toBe(firstProject.id);
    const recoveryBeforeExpiry = await recover();
    expect(recoveryBeforeExpiry.status).toBe(200);
    expect(await recoveryBeforeExpiry.json()).toMatchObject({ outcome: "replayed", project: { id: firstProject.id } });
    expect(await count()).toBe(1);
    await shift(2);
    const recoveryAfterExpiry = await recover();
    expect(recoveryAfterExpiry.status).toBe(409);
    expect(await recoveryAfterExpiry.json()).toMatchObject({
      code: "operation_outcome_unrecoverable", status: 409,
    });
    expect(await count()).toBe(1);
    const afterExpiry = await send();
    expect(afterExpiry.status).toBe(201);
    const second = await afterExpiry.json();
    projectIds.push(second.id);
    expect(second.id).not.toBe(firstProject.id);
    expect(await count()).toBe(2);
  });

  it("專案產品端點拒絕偽造／失權，withdrawn／expired 仍依既有能力表允許", async () => {
    const session = await loginSyntheticAccount(firstAccount);
    const send = (body: unknown, actor?: NativeAuthSession, headers: Record<string, string> = {}) =>
      createProject(request("/api/v1/projects", "POST", actor, { "idempotency-key": randomUUID(), ...headers }, body));
    const count = async () => (await control.query("SELECT count(*)::int AS n FROM app.projects")).rows[0].n;
    const before = await count();
    expect((await send({ title: "未登入" })).status).toBe(401);
    for (const extra of [{ owner_id: secondAccount.id }, { role: "admin" }, { school_id: secondAccount.schoolId }, { principal: firstAccount.id }]) {
      expect((await send({ title: "偽造", ...extra }, session)).status).toBe(400);
    }
    expect((await send({ title: "外站" }, session, { origin: "https://example.invalid" })).status).toBe(403);
    for (const tier of ["C", "", null, 1, false]) {
      expect((await send({ title: "不支援等級", tier }, session)).status).toBe(422);
    }
    for (const role of ["teacher", "admin"]) {
      await control.query("UPDATE app.profiles SET role=$2 WHERE id=$1", [firstAccount.id, role]);
      expect((await send({ title: "非學生" }, session)).status).toBe(403);
      expect((await listCurrentOwnedProjectsSubset(createDatabaseSession(firstAccount.id).read)).outcome).toBe("denied");
      expect((await getProject(request(`/api/v1/projects/${firstProject}`, "GET", session), {
        params: Promise.resolve({ id: firstProject }),
      })).status).toBe(403);
    }
    await control.query("UPDATE app.profiles SET role='student',status='disabled' WHERE id=$1", [firstAccount.id]);
    expect((await send({ title: "失權" }, session)).status).toBe(403);
    const deniedList = await listCurrentOwnedProjectsSubset(createDatabaseSession(firstAccount.id).read);
    expect(deniedList).toEqual({ outcome: "denied", reason: "policy_denied" });
    const deniedDetail = await getProject(request(`/api/v1/projects/${firstProject}`, "GET", session), {
      params: Promise.resolve({ id: firstProject }),
    });
    expect(deniedDetail.status).toBe(403);
    expect(await deniedDetail.text()).not.toContain("合成階段草稿驗收");
    expect(await count()).toBe(before);
    await control.query("UPDATE app.profiles SET status='approved' WHERE id=$1", [firstAccount.id]);
    for (const change of [
      "UPDATE app.profiles SET status='pending' WHERE id=$1",
      "UPDATE app.profiles SET status='rejected' WHERE id=$1",
      "UPDATE app.profiles SET deletion_state='marked' WHERE id=$1",
      "UPDATE app.profiles SET deletion_state='purging' WHERE id=$1",
    ]) {
      try {
        await control.query(change, [firstAccount.id]);
        expect((await send({ title: "失權矩陣" }, session)).status).toBe(403);
        expect((await listCurrentOwnedProjectsSubset(createDatabaseSession(firstAccount.id).read)).outcome).toBe("denied");
        expect((await getProject(request(`/api/v1/projects/${firstProject}`, "GET", session), {
          params: Promise.resolve({ id: firstProject }),
        })).status).toBe(403);
      } finally {
        await control.query("UPDATE app.profiles SET status='approved',deletion_state='none' WHERE id=$1", [firstAccount.id]);
      }
    }
    try {
      await control.query("UPDATE app.schools SET approval_state='unconfirmed' WHERE id=$1", [firstAccount.schoolId]);
      expect((await send({ title: "學校未確認" }, session)).status).toBe(403);
      expect((await listCurrentOwnedProjectsSubset(createDatabaseSession(firstAccount.id).read)).outcome).toBe("denied");
    } finally {
      await control.query("UPDATE app.schools SET approval_state='approved' WHERE id=$1", [firstAccount.schoolId]);
    }
    for (const state of ["withdrawn", "expired"]) {
      await control.query("UPDATE app.schools SET approval_state=$2 WHERE id=$1", [firstAccount.schoolId, state]);
      const response = await send({ title: `保留編輯-${state}` }, session);
      expect(response.status).toBe(201);
      projectIds.push((await response.json()).id);
      expect((await listCurrentOwnedProjectsSubset(createDatabaseSession(firstAccount.id).read)).outcome).toBe("listed");
      expect((await getProject(request(`/api/v1/projects/${firstProject}`, "GET", session), {
        params: Promise.resolve({ id: firstProject }),
      })).status).toBe(200);
    }
    await control.query("UPDATE app.schools SET approval_state='approved' WHERE id=$1", [firstAccount.schoolId]);
  });

  it("專案 Auth／DB 依賴失敗無假成功；交易無法確認保留原操作語意", async () => {
    const session = await loginSyntheticAccount(firstAccount);
    const send = () => createProject(request("/api/v1/projects", "POST", session, {
      "idempotency-key": randomUUID(),
    }, { title: "依賴失敗不建立" }));
    const before = (await control.query("SELECT count(*)::int AS n FROM app.projects")).rows[0].n;
    const oldOrigin = process.env.APP_PLANET_AUTH_ORIGIN;
    try {
      process.env.APP_PLANET_AUTH_ORIGIN = "http://127.0.0.1:1";
      expect((await send()).status).toBe(503);
      expect((await getProject(request(`/api/v1/projects/${firstProject}`, "GET", session), {
        params: Promise.resolve({ id: firstProject }),
      })).status).toBe(503);
    } finally { restoreAuthOrigin(oldOrigin); }
    try {
      await control.query("REVOKE EXECUTE ON FUNCTION app.current_account_gate(text) FROM authenticated");
      expect((await send()).status).toBe(503);
      expect((await listCurrentOwnedProjectsSubset(createDatabaseSession(firstAccount.id).read)).outcome).toBe("failed");
      expect((await getProject(request(`/api/v1/projects/${firstProject}`, "GET", session), {
        params: Promise.resolve({ id: firstProject }),
      })).status).toBe(503);
    } finally {
      await control.query("GRANT EXECUTE ON FUNCTION app.current_account_gate(text) TO authenticated");
    }
    try {
      await control.query("REVOKE EXECUTE ON FUNCTION app.create_unclassified_project(text,text,boolean,uuid) FROM authenticated");
      const unknown = await send();
      expect(unknown.status).toBe(503);
      expect(await unknown.json()).toMatchObject({ code: "operation_outcome_unknown" });
    } finally {
      await control.query("GRANT EXECUTE ON FUNCTION app.create_unclassified_project(text,text,boolean,uuid) TO authenticated");
    }
    expect((await control.query("SELECT count(*)::int AS n FROM app.projects")).rows[0].n).toBe(before);
  });

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

  it("P-4 真 Auth／產品 PATCH：done CAS、隱匿、strict body、失權重驗與並行 409", async () => {
    const owner = await loginSyntheticAccount(firstAccount);
    const other = await loginSyntheticAccount(secondAccount);
    const taskId = randomUUID();
    await control.query(
      `INSERT INTO app.tasks (id, project_id, "order", title) VALUES ($1,$2,1,'真實 DB 任務')`,
      [taskId, firstProject],
    );

    const read = await listOwnedProjectTasksSubset(createDatabaseSession(firstAccount.id).read, {
      project_id: firstProject,
    });
    expect(read).toMatchObject({
      outcome: "listed",
      tasks: [{ id: taskId, project_id: firstProject, done: false, row_version: 0 }],
    });
    const initial = await control.query(
      "SELECT done,row_version FROM app.tasks WHERE id=$1 AND project_id=$2",
      [taskId, firstProject],
    );
    expect(initial.rows).toEqual([{ done: false, row_version: 0 }]);

    const missingHeader = await patchTask(firstProject, taskId, owner, { done: true });
    expect(missingHeader.status).toBe(400);
    expect(await missingHeader.json()).toMatchObject({ code: "if_match_required" });
    for (const invalid of ['W/"0"', '"00"', '"-1"', '"0", "1"', "*", "0"]) {
      const response = await patchTask(firstProject, taskId, owner, { done: true }, { "if-match": invalid });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ code: "invalid_if_match" });
    }
    for (const invalidBody of [
      { done: true, owner_id: firstAccount.id },
      { done: true, project_id: raceProject },
      { done: true, row_version: 0 },
      { done: true, approved: true },
      { done: 1 },
    ]) {
      expect((await patchTask(firstProject, taskId, owner, invalidBody, { "if-match": '"0"' })).status).toBe(400);
    }
    expect((await patchTask(firstProject, randomUUID(), owner, {}, {})).status).toBe(404);
    expect((await patchTask(firstProject, taskId, other, { done: true }, { "if-match": '"0"' })).status).toBe(404);
    expect((await patchTask(raceProject, taskId, owner, { done: true }, { "if-match": '"0"' })).status).toBe(404);
    try {
      for (const role of ["teacher", "admin"] as const) {
        await control.query("UPDATE app.profiles SET role=$1 WHERE id=$2", [role, secondAccount.id]);
        expect((await patchTask(firstProject, taskId, other, { done: true }, { "if-match": '"0"' })).status)
          .toBe(403);
      }
    } finally {
      await control.query("UPDATE app.profiles SET role='student' WHERE id=$1", [secondAccount.id]);
    }
    expect((await control.query(
      "SELECT done,row_version FROM app.tasks WHERE id=$1",
      [taskId],
    )).rows).toEqual([{ done: false, row_version: 0 }]);

    const writerProbe = await patchOwnedProjectTaskDoneSubset(createDatabaseSession(firstAccount.id).write, {
      project_id: firstProject,
      task_id: taskId,
      expected_row_version: 0,
      done: true,
    });
    expect(writerProbe, JSON.stringify(writerProbe)).toMatchObject({
      outcome: "saved",
      task: { id: taskId, project_id: firstProject, done: true, row_version: 1 },
    });
    await control.query("UPDATE app.tasks SET done=false,row_version=0 WHERE id=$1", [taskId]);

    const checked = await patchTask(firstProject, taskId, owner, { done: true }, { "if-match": '"0"' });
    expect(checked.status).toBe(200);
    expect(checked.headers.get("etag")).toBe('"1"');
    expect(await checked.json()).toMatchObject({
      id: taskId, project_id: firstProject, done: true, row_version: 1,
    });
    const unchecked = await patchTask(firstProject, taskId, owner, { done: false }, { "if-match": '"1"' });
    expect(unchecked.status).toBe(200);
    expect(unchecked.headers.get("etag")).toBe('"2"');
    expect(await unchecked.json()).toMatchObject({ id: taskId, done: false, row_version: 2 });
    expect((await control.query(
      "SELECT done,row_version FROM app.tasks WHERE id=$1",
      [taskId],
    )).rows).toEqual([{ done: false, row_version: 2 }]);

    for (const role of ["teacher", "admin"]) {
      await control.query("UPDATE app.profiles SET role=$2 WHERE id=$1", [secondAccount.id, role]);
      const response = await patchTask(firstProject, taskId, other, { done: true }, { "if-match": '"2"' });
      expect(response.status).toBe(403);
    }
    await control.query("UPDATE app.profiles SET role='student' WHERE id=$1", [secondAccount.id]);

    const concurrent = await Promise.all([
      patchTask(firstProject, taskId, owner, { done: true }, { "if-match": '"2"' }),
      patchTask(firstProject, taskId, owner, { done: false }, { "if-match": '"2"' }),
    ]);
    expect(concurrent.map((response) => response.status).sort()).toEqual([200, 409]);
    const savedResponse = concurrent.find((response) => response.status === 200);
    const conflictResponse = concurrent.find((response) => response.status === 409);
    expect(savedResponse?.headers.get("etag")).toBe('"3"');
    expect(await conflictResponse?.json()).toMatchObject({
      code: "version_conflict",
      conflict: {
        current: { version: 3 },
        submitted: { version: 2 },
      },
    });
    const savedTask = await savedResponse!.json();
    expect(savedTask).toMatchObject({ id: taskId, project_id: firstProject, row_version: 3 });
    const afterRace = await control.query("SELECT done,row_version FROM app.tasks WHERE id=$1", [taskId]);
    expect(afterRace.rows).toEqual([{ done: savedTask.done, row_version: 3 }]);

    const revokingHandlers = createProjectHandlers({
      resolver: createAuthPrincipalResolver(),
      requireSameOrigin: true,
      beforeExecute: async () => {
        await control.query("UPDATE app.profiles SET status='disabled' WHERE id=$1", [firstAccount.id]);
      },
    });
    const afterPrecheckRevocation = await revokingHandlers.patchTaskDone(
      request(taskPath(firstProject, taskId), "PATCH", owner, { "if-match": '"3"' }, { done: true }),
      { projectId: firstProject, taskId },
    );
    expect(afterPrecheckRevocation.status).toBe(403);
    await control.query("UPDATE app.profiles SET status='approved' WHERE id=$1", [firstAccount.id]);
    expect((await control.query(
      "SELECT done,row_version FROM app.tasks WHERE id=$1",
      [taskId],
    )).rows[0].row_version).toBe(3);

    await control.query("DELETE FROM app.tasks WHERE id=$1", [taskId]);
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

    for (const mode of ["destroy", "stall"] as const) {
      let stallTimer: NodeJS.Timeout | undefined;
      const interruptedServer = createServer((_request, response) => {
        response.writeHead(200, { "content-type": "application/json" });
        response.write('{"id":"');
        if (mode === "destroy") setTimeout(() => response.destroy(), 20);
        else stallTimer = setTimeout(() => response.end(`${firstAccount.id}"}`), 30_000);
      });
      await new Promise<void>((resolveListen, rejectListen) => {
        interruptedServer.once("error", rejectListen);
        interruptedServer.listen(0, "127.0.0.1", resolveListen);
      });
      const interruptedAddress = interruptedServer.address();
      if (!interruptedAddress || typeof interruptedAddress === "string") {
        throw new Error("Auth interrupted-body test server did not bind.");
      }
      process.env.APP_PLANET_AUTH_ORIGIN = `http://127.0.0.1:${interruptedAddress.port}`;
      try {
        const started = Date.now();
        const interrupted = await putDraft(firstProject, session, `Auth body ${mode}`, randomUUID(), {
          "if-match": '"1"',
        });
        expect(interrupted.status, mode).toBe(503);
        expect(Date.now() - started, mode).toBeLessThan(10_000);
        const body = await interrupted.text();
        expect(body).not.toMatch(/ECONN|socket|terminated|stack|127\.0\.0\.1/i);
      } finally {
        clearTimeout(stallTimer);
        interruptedServer.closeAllConnections();
        await new Promise<void>((resolveClose, rejectClose) => {
          interruptedServer.close((error) => error ? rejectClose(error) : resolveClose());
        });
        restoreAuthOrigin(originalAuthOrigin);
      }
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

  it("Job 狀態可讀；G-3 產品路由 fail-closed；內部取消核心走 owner-only 交易且 Worker 釋放未送出的預留", async () => {
    const owner = await loginSyntheticAccount(firstAccount);
    const other = await loginSyntheticAccount(secondAccount);
    const jobId = await createSyntheticAgentJob(control, firstAccount);
    const statusPath = `/api/v1/jobs/${jobId}`;
    const owned = await getJob(request(statusPath, "GET", owner), { params: Promise.resolve({ id: jobId }) });
    expect(owned.status).toBe(200);
    expect(await owned.json()).toMatchObject({ id: jobId, state: "queued", result: null });
    const hidden = await getJob(request(statusPath, "GET", other), { params: Promise.resolve({ id: jobId }) });
    expect(hidden.status).toBe(404);

    // G-3 產品路由：Job ID 不能冒充 Run ID；無可信 Run→Job 關聯時 fail-closed，Job 不受影響。
    const jobState = () => control.query(
      `SELECT j.state,j.cancel_requested,r.state AS reservation_state
       FROM app.jobs j JOIN app.usage_reservations r ON r.id=j.reservation_id WHERE j.id=$1`,
      [jobId],
    );
    const unchanged = { rows: [{ state: "queued", cancel_requested: false, reservation_state: "reserved" }] };
    for (const [session, label] of [[other, "跨帳號"], [owner, "擁有者"], [undefined, "未登入"]] as const) {
      const run = await stopAgentRun(
        request(`/api/v1/agent-runs/${jobId}/stop`, "POST", session),
        { params: Promise.resolve({ id: jobId }) },
      );
      expect(run.status, label).toBe(session ? 403 : 401);
      expect(await jobState(), label).toMatchObject(unchanged);
    }
    const unknownRun = randomUUID();
    expect((await stopAgentRun(
      request(`/api/v1/agent-runs/${unknownRun}/stop`, "POST", owner),
      { params: Promise.resolve({ id: unknownRun }) },
    )).status).toBe(403);
    expect(await jobState()).toMatchObject(unchanged);

    // 內部 Job 取消核心（非產品路由）：直接以真 Auth 建立 handler 驗證 owner-only 與 Worker 釋放。
    const core = createFoundationHandlers({ resolver: createAuthPrincipalResolver(), requireSameOrigin: true });
    const deniedCancel = await core.cancelJob(request(`/internal/jobs/${jobId}/cancel`, "POST", other), jobId);
    expect(deniedCancel.status).toBe(404);
    const cancelled = await core.cancelJob(request(`/internal/jobs/${jobId}/cancel`, "POST", owner), jobId);
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

  it("教師（已綁定／未綁定）與管理員不是作品 owner：經產品路由讀寫學生草稿均拒絕且不洩漏；失權與學校狀態即時隱藏資料", async () => {
    const before = await control.query(
      "SELECT row_version,content FROM app.stage_records WHERE project_id=$1 AND stage='Specification'",
      [firstProject],
    );
    expect(before.rows).toHaveLength(1);
    const secret = String(before.rows[0].content.text);
    const bindingId = randomUUID();
    const readDraft = async (session: NativeAuthSession) => getStageDraft(
      request(draftPath(firstProject), "GET", session), draftRouteParams(firstProject));
    const expectHidden = async (label: string, session: NativeAuthSession, status: number) => {
      const read = await readDraft(session);
      expect(read.status, `${label} GET`).toBe(status);
      const write = await putDraft(firstProject, session, `${label}-write`, randomUUID(), { "if-match": '"1"' });
      expect(write.status, `${label} PUT`).toBe(status);
      for (const response of [read, write]) {
        expect(await response.text(), label).not.toContain(secret);
      }
    };
    try {
      const other = await loginSyntheticAccount(secondAccount);
      await expectHidden("跨帳號學生", other, 404);

      await control.query("UPDATE app.profiles SET role='teacher', school_id=NULL WHERE id=$1", [secondAccount.id]);
      await expectHidden("未綁定教師", other, 403);
      await control.query(`INSERT INTO app.teacher_student_bindings(
        id,teacher_id,student_id,state,created_by_aid,created_at
      ) VALUES ($1,$2,$3,'active',$4,now())`, [bindingId, secondAccount.id, firstAccount.id, randomUUID()]);
      await expectHidden("已綁定教師", other, 403);
      await control.query("DELETE FROM app.teacher_student_bindings WHERE id=$1", [bindingId]);

      await control.query("UPDATE app.profiles SET role='admin' WHERE id=$1", [secondAccount.id]);
      await expectHidden("管理員", other, 403);
    } finally {
      await control.query("DELETE FROM app.teacher_student_bindings WHERE id=$1", [bindingId]);
      await control.query("UPDATE app.profiles SET role='student', school_id=$2 WHERE id=$1", [
        secondAccount.id, secondAccount.schoolId,
      ]);
    }

    const owner = await loginSyntheticAccount(firstAccount);
    expect((await readDraft(owner)).status).toBe(200);
    try {
      for (const state of ["withdrawn", "expired"]) {
        await control.query("UPDATE app.schools SET approval_state=$1 WHERE id=$2", [state, firstAccount.schoolId]);
        expect((await readDraft(owner)).status, state).toBe(200);
      }
      await control.query("UPDATE app.schools SET approval_state='approved' WHERE id=$1", [firstAccount.schoolId]);
      for (const change of [
        "UPDATE app.profiles SET status='disabled' WHERE id=$1",
        "UPDATE app.profiles SET deletion_state='marked' WHERE id=$1",
        "UPDATE app.profiles SET deletion_state='purging' WHERE id=$1",
      ]) {
        try {
          await control.query(change, [firstAccount.id]);
          await expectHidden("失權 owner", owner, 403);
        } finally {
          await control.query("UPDATE app.profiles SET status='approved', deletion_state='none' WHERE id=$1", [firstAccount.id]);
        }
      }
      await control.query("UPDATE app.schools SET approval_state='unconfirmed' WHERE id=$1", [firstAccount.schoolId]);
      await expectHidden("學校未確認 owner", owner, 403);
    } finally {
      await control.query("UPDATE app.schools SET approval_state='approved' WHERE id=$1", [firstAccount.schoolId]);
    }
    expect((await readDraft(owner)).status).toBe(200);
    const after = await control.query(
      "SELECT row_version,content FROM app.stage_records WHERE project_id=$1 AND stage='Specification'",
      [firstProject],
    );
    expect(after.rows).toEqual(before.rows);
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
