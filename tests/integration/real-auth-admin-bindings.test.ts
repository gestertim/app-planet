import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { Pool, type PoolClient, type QueryResult } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { bindingListSchema, bindingReceiptSchema, type BindingList, type BindingReceipt } from "@app-planet/core";
import { createBindingHandlers } from "../../apps/web/src/server/admin/accounts-bindings.ts";
import { createMeHandler } from "../../apps/web/src/server/auth/me.ts";
import { createAuthPrincipalResolver, sessionCookieName } from "../../apps/web/src/server/auth-principal.ts";
import { closeServerDatabasePool, createDatabaseSession } from "../../apps/web/src/server/database-session.ts";
import type { TrustedPrincipalResolver } from "../../apps/web/src/server/http.ts";
import {
  productBindingHandlers as bindings, productProjectHandlers as projects,
  productProjectClassificationHandlers as classification, productFoundationHandlers as foundation,
  productSpecificationReviewHandlers as review,
} from "../../apps/web/src/server/product-handlers.ts";
import {
  createSyntheticAuthAccount, deleteSyntheticAuthAccount, loginSyntheticAccount, openControlPool,
  type NativeAuthSession, type SyntheticAuthAccount,
} from "../support/real-auth-fixture.ts";

// 真原生 Auth／產品 Request handler／RPC／PostgreSQL；非 TCP、瀏覽器或正式部署驗收。
// fixture 只建立帳號、學校及歸屬，所有主要綁定驗收均經產品 handler 或公開 RPC。
type Actor = SyntheticAuthAccount & { session: NativeAuthSession };
type Rpc = { outcome: string } & Partial<BindingReceipt>;
const origin = process.env.APP_PLANET_APP_ORIGIN!;
const accounts: SyntheticAuthAccount[] = [];
const projectIds: string[] = [];
const auditFailure = "admin_binding_regression_audit_failure";
let control: Pool, runtime: Pool;
let admin: Actor, teacher: Actor, student: Actor;
let membership: string;

async function actor(role: "student" | "teacher" | "admin" = "student"): Promise<Actor> {
  const account = await createSyntheticAuthAccount(control, "綁定回歸");
  accounts.push(account);
  if (role !== "student") await control.query("UPDATE app.profiles SET role=$2 WHERE id=$1", [account.id, role]);
  return { ...account, session: await loginSyntheticAccount(account) };
}
async function member(teacherId: string, schoolId: string): Promise<string> {
  const id = randomUUID();
  await control.query(`INSERT INTO app.teacher_school_memberships
    (id,teacher_id,school_id,state,created_by_aid,created_at) VALUES($1,$2,$3,'active',$4,now())`,
  [id, teacherId, schoolId, randomUUID()]);
  return id;
}
function request(
  who: Actor | null, method: string, path: string, body?: unknown, key: string = randomUUID(),
  headers: Record<string, string> = {},
): Request {
  return new Request(origin + path, { method, headers: {
    origin, "sec-fetch-site": "same-origin", "content-type": "application/json", "idempotency-key": key,
    ...(who ? { cookie: `${sessionCookieName}=${who.session.accessToken}` } : {}), ...headers,
  }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
const createRequest = (key: string = randomUUID(), who: Actor | null = admin, t = teacher.id, s = student.id) =>
  request(who, "POST", "/api/v1/admin/bindings", { teacher_id: t, student_id: s }, key);
const endRequest = (id: string, key = randomUUID(), reason = "合成解除理由", who: Actor | null = admin) =>
  request(who, "DELETE", `/api/v1/admin/bindings/${id}`, { end_reason: reason }, key);
const create = (key = randomUUID(), who = admin, t = teacher.id, s = student.id) =>
  bindings.create(createRequest(key, who, t, s));
const end = (id: string, key = randomUUID(), reason = "合成解除理由", who = admin) =>
  bindings.end(endRequest(id, key, reason, who), { id });
async function receipt(response: Response, status: number): Promise<BindingReceipt> {
  expect(response.status).toBe(status);
  expect(response.headers.get("cache-control")).toContain("no-store");
  expect(response.headers.has("set-cookie")).toBe(false);
  return bindingReceiptSchema.parse(await response.json());
}
async function problem(response: Response, status: number, code: string): Promise<void> {
  expect(response.status).toBe(status);
  expect(response.headers.get("content-type")).toContain("application/problem+json");
  expect(response.headers.get("cache-control")).toContain("no-store");
  expect(response.headers.has("set-cookie")).toBe(false);
  const body: unknown = await response.json();
  expect(body).toMatchObject({ status, code });
  expect(Object.keys(body as object).sort()).toEqual([
    "code", "instance", "request_id", "status", "title", "type", "user_message_zh",
  ]);
}
async function rpc(sql: string, values: unknown[], who = admin): Promise<Rpc> {
  const result = await createDatabaseSession(who.id).write.runTransaction((q) => q.query(sql, values));
  return (result.rows[0] as { result: Rpc }).result;
}
const rpcCreate = (key = randomUUID(), who = admin, t = teacher.id, s = student.id) =>
  rpc("SELECT app.create_teacher_student_binding($1::uuid,$2::uuid,$3::uuid) result", [t, s, key], who);
const rpcEnd = (id: string, key = randomUUID(), reason = "合成解除理由", who = admin) =>
  rpc("SELECT app.end_teacher_student_binding($1::uuid,$2::text,$3::uuid) result", [id, reason, key], who);
async function state(id: string) {
  return (await control.query("SELECT * FROM app.teacher_student_bindings WHERE id=$1", [id])).rows[0];
}
async function snapshot() {
  const ids = accounts.map((a) => a.id);
  return (await control.query(`SELECT
    (SELECT coalesce(jsonb_agg(to_jsonb(b) ORDER BY b.id),'[]') FROM app.teacher_student_bindings b
      WHERE teacher_id=ANY($1::uuid[]) OR student_id=ANY($1::uuid[])) bindings,
    (SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY r.actor_id,r.operation_key),'[]')
      FROM app.binding_operation_receipts r WHERE actor_id=ANY($1::uuid[])) receipts,
    (SELECT coalesce(jsonb_agg(to_jsonb(e) ORDER BY e.id),'[]') FROM app.audit_events e
      WHERE actor_aid IN (SELECT aid FROM app.audit_identity_map WHERE account_id=ANY($1::uuid[]))) audits,
    (SELECT coalesce(jsonb_agg(to_jsonb(m) ORDER BY m.aid),'[]') FROM app.audit_identity_map m
      WHERE account_id=ANY($1::uuid[])) identities`, [ids])).rows[0];
}
async function bindActor(client: PoolClient, id: string) {
  await client.query("SET LOCAL ROLE authenticated");
  await client.query("SELECT set_config('request.jwt.claim.sub',$1,true),set_config('request.jwt.claims',$2,true)",
    [id, JSON.stringify({ sub: id })]);
}
async function waitForLock(pid: number, blocker: number) {
  for (let attempt = 0; attempt < 150; attempt++) {
    const result = await control.query(`SELECT 1 FROM pg_stat_activity
      WHERE pid=$1 AND wait_event_type='Lock' AND $2=ANY(pg_blocking_pids(pid))`, [pid, blocker]);
    if (result.rowCount) return;
    await delay(20);
  }
  throw new Error("綁定回歸未到達 PostgreSQL 鎖等待屏障。");
}

beforeAll(() => {
  if (process.env.APP_PLANET_ENV !== "isolated-local-test" || process.env.NODE_ENV !== "test" ||
      process.env.APP_PLANET_LOCAL_AUTH !== "1" || !origin) {
    throw new Error("師生綁定回歸只允許專用隔離 runner。");
  }
  control = openControlPool();
  runtime = new Pool({ connectionString: process.env.APP_PLANET_DATABASE_URL, max: 2,
    connectionTimeoutMillis: 5_000, query_timeout: 12_000 });
});
beforeEach(async () => {
  [admin, teacher, student] = await Promise.all([actor("admin"), actor("teacher"), actor()]);
  membership = await member(teacher.id, student.schoolId);
});
afterEach(async () => {
  if (!control) return;
  await closeServerDatabasePool();
  const ids = accounts.map((a) => a.id);
  const client = await control.connect();
  try {
    await client.query("BEGIN");
    await client.query(`ALTER TABLE app.audit_events DROP CONSTRAINT IF EXISTS ${auditFailure}`);
    if (projectIds.length) {
      await client.query(`DELETE FROM app.specification_decisions WHERE submission_id IN
        (SELECT id FROM app.specification_submissions WHERE project_id=ANY($1::uuid[]))`, [projectIds]);
      await client.query("DELETE FROM app.specification_submissions WHERE project_id=ANY($1::uuid[])", [projectIds]);
      await client.query(`UPDATE app.projects SET classification_state='unconfirmed',tier=NULL,
        needs_visitor_identity=NULL,current_confirmation_id=NULL WHERE id=ANY($1::uuid[])`, [projectIds]);
      for (const table of ["stage_draft_confirmations", "stage_draft_idempotency", "stage_records",
        "project_classification_idempotency", "project_classification_confirmations", "project_requirements",
        "project_create_idempotency"]) {
        await client.query(`DELETE FROM app.${table} WHERE project_id=ANY($1::uuid[])`, [projectIds]);
      }
      await client.query("DELETE FROM app.projects WHERE id=ANY($1::uuid[])", [projectIds]);
    }
    await client.query("DELETE FROM app.binding_operation_receipts WHERE actor_id=ANY($1::uuid[])", [ids]);
    await client.query(`DELETE FROM app.audit_events WHERE actor_aid IN
      (SELECT aid FROM app.audit_identity_map WHERE account_id=ANY($1::uuid[])) OR subject_aid IN
      (SELECT aid FROM app.audit_identity_map WHERE account_id=ANY($1::uuid[]))`, [ids]);
    await client.query(`DELETE FROM app.teacher_student_bindings
      WHERE teacher_id=ANY($1::uuid[]) OR student_id=ANY($1::uuid[])`, [ids]);
    await client.query("DELETE FROM app.teacher_school_memberships WHERE teacher_id=ANY($1::uuid[])", [ids]);
    await client.query("DELETE FROM app.audit_identity_map WHERE account_id=ANY($1::uuid[])", [ids]);
    await client.query("DELETE FROM app.profiles WHERE id=ANY($1::uuid[])", [ids]);
    await client.query("DELETE FROM app.schools WHERE id=ANY($1::uuid[])", [accounts.map((a) => a.schoolId)]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally { client.release(); }
  const deletions = await Promise.allSettled(accounts.map(deleteSyntheticAuthAccount));
  accounts.length = 0;
  projectIds.length = 0;
  expect(deletions.every((result) => result.status === "fulfilled"), "合成 Auth 帳號清理").toBe(true);
});
afterAll(async () => {
  await closeServerDatabasePool();
  await runtime?.end();
  await control?.end();
});

describe("T077 真 Auth／HTTP／公開 RPC／持久師生綁定", () => {
  it("UUID create／end 原鍵 replay，結束後不復活；新鍵產生新 ID，指定舊 ID 不解除新關聯", async () => {
    const createKey = randomUUID(), endKey = randomUUID();
    const first = await receipt(await create(createKey), 201);
    expect(first).toMatchObject({ operation: "create", state: "active", outcome: "created" });
    const replay = await create(createKey);
    expect(replay.headers.get("idempotent-replay")).toBe("true");
    expect(await receipt(replay, 200)).toEqual({ ...first, outcome: "replayed" });
    await problem(await create(), 409, "binding_exists");
    const ended = await receipt(await end(first.binding_id, endKey), 200);
    expect(ended).toMatchObject({ operation: "end", state: "ended", binding_id: first.binding_id });
    const replayEnd = await end(first.binding_id, endKey);
    expect(replayEnd.headers.get("idempotent-replay")).toBe("true");
    expect(await receipt(replayEnd, 200)).toEqual({ ...ended, outcome: "replayed" });
    expect(await receipt(await create(createKey), 200)).toEqual({ ...first, outcome: "replayed" });
    expect(await state(first.binding_id)).toMatchObject({ state: "ended", end_reason: "合成解除理由" });
    const replacement = await receipt(await create(), 201);
    expect(replacement.binding_id).not.toBe(first.binding_id);
    const before = await snapshot();
    await problem(await end(first.binding_id), 409, "binding_ended");
    await problem(await end(randomUUID()), 404, "not_found");
    expect(await snapshot()).toEqual(before);
    expect(await state(replacement.binding_id)).toMatchObject({ state: "active" });
    const audit = (await control.query(`SELECT e.*,a.account_id actor,s.account_id subject,t.account_id teacher
      FROM app.audit_events e JOIN app.audit_identity_map a ON a.aid=e.actor_aid
      JOIN app.audit_identity_map s ON s.aid=e.subject_aid
      JOIN app.audit_identity_map t ON t.aid=(e.meta->>'teacher_aid')::uuid
      WHERE e.object_ref=$1 ORDER BY e.at,e.id`, [first.binding_id])).rows;
    expect(audit.map((e) => e.action)).toEqual(["binding_created", "binding_ended"]);
    for (const [index, event] of audit.entries()) {
      expect(event).toMatchObject({ actor: admin.id, subject: student.id, teacher: teacher.id,
        object_type: "binding", school_id: student.schoolId, result: "ok",
        meta: { from_state: index === 0 ? null : "active", to_state: index === 0 ? "active" : "ended" } });
      expect(Object.keys(event.meta).sort()).toEqual(["from_state", "teacher_aid", "to_state"]);
      expect(event.at).toBeInstanceOf(Date);
      expect(JSON.stringify(event.meta)).not.toContain("合成解除理由");
    }
  });

  it("同鍵異 pair／operation／binding ID／理由拒絕，replay 仍即時重驗 admin", async () => {
    const key = randomUUID(), endKey = randomUUID();
    const first = await receipt(await create(key), 201);
    await problem(await create(key, admin, student.id, teacher.id), 422, "idempotency_key_reuse");
    await problem(await end(first.binding_id, key), 422, "idempotency_key_reuse");
    await receipt(await end(first.binding_id, endKey), 200);
    const before = await snapshot();
    await problem(await end(first.binding_id, endKey, "不同解除理由"), 422, "idempotency_key_reuse");
    await problem(await end(randomUUID(), endKey), 422, "idempotency_key_reuse");
    expect(await snapshot()).toEqual(before);
    await control.query("UPDATE app.profiles SET status='disabled' WHERE id=$1", [admin.id]);
    await problem(await create(key), 403, "forbidden");
    await problem(await end(first.binding_id, endKey), 403, "forbidden");
    expect(await rpcCreate(key)).toEqual({ outcome: "denied" });
    expect(await rpcEnd(first.binding_id, endKey)).toEqual({ outcome: "denied" });
  });

  it.each(["same", "different"] as const)("並行 create（%s UUID keys）只有一次建立及 audit", async (mode) => {
    const keys = [randomUUID(), randomUUID()];
    if (mode === "same") keys[1] = keys[0]!;
    const results = await Promise.all(keys.map((key) => rpcCreate(key)));
    expect(results.map((r) => r.outcome).sort()).toEqual(
      mode === "same" ? ["created", "replayed"] : ["binding_exists", "created"]);
    const saved = await snapshot();
    expect(saved.bindings).toHaveLength(1);
    expect(saved.receipts).toHaveLength(1);
    expect(saved.audits).toHaveLength(1);
    expect(saved.bindings[0].state).toBe("active");
  });

  it.each(["same", "different"] as const)("並行 end（%s UUID keys）只有一次解除及 audit", async (mode) => {
    const first = await receipt(await create(), 201);
    const keys = [randomUUID(), randomUUID()];
    if (mode === "same") keys[1] = keys[0]!;
    const results = await Promise.all(keys.map((key) => rpcEnd(first.binding_id, key)));
    expect(results.map((r) => r.outcome).sort()).toEqual(
      mode === "same" ? ["ended", "replayed"] : ["binding_ended", "ended"]);
    const saved = await snapshot();
    expect(saved.bindings).toHaveLength(1);
    expect(saved.receipts).toHaveLength(2);
    expect(saved.audits).toHaveLength(2);
    expect(saved.bindings[0].state).toBe("ended");
  });

  it("E-01 create-first：未提交建立與指定新 ID 解除有真 PostgreSQL 鎖等待", async () => {
    const first = await runtime.connect(), second = await runtime.connect();
    const createKey = randomUUID(), endKey = randomUUID();
    let pending: Promise<QueryResult<{ result: Rpc }>> | undefined;
    let bindingId = "";
    try {
      await first.query("BEGIN");
      await bindActor(first, admin.id);
      const firstPid = (await first.query("SELECT pg_backend_pid() pid")).rows[0].pid as number;
      const created = (await first.query<{ result: Rpc }>(
        "SELECT app.create_teacher_student_binding($1,$2,$3) result",
        [teacher.id, student.id, createKey],
      )).rows[0]!.result;
      expect(created.outcome).toBe("created");
      bindingId = created.binding_id!;

      await second.query("BEGIN");
      await bindActor(second, admin.id);
      const secondPid = (await second.query("SELECT pg_backend_pid() pid")).rows[0].pid as number;
      pending = second.query<{ result: Rpc }>(
        "SELECT app.end_teacher_student_binding($1,$2,$3) result",
        [bindingId, "create-first 真鎖解除", endKey],
      );
      void pending.catch(() => undefined);
      await waitForLock(secondPid, firstPid);
      await first.query("COMMIT");
      expect((await pending).rows[0]!.result).toMatchObject({
        outcome: "ended", operation: "end", binding_id: bindingId,
      });
      await second.query("COMMIT");
    } finally {
      await first.query("ROLLBACK");
      await pending?.catch(() => undefined);
      await second.query("ROLLBACK");
      first.release(); second.release();
    }

    const saved = await snapshot();
    expect(saved.bindings).toHaveLength(1);
    expect(saved.bindings[0]).toMatchObject({ id: bindingId, state: "ended" });
    expect(saved.receipts).toHaveLength(2);
    expect(saved.audits.map((event: { action: string }) => event.action).sort()).toEqual(["binding_created", "binding_ended"]);
    const receipts = (await control.query(`SELECT operation_key,intent,result
      FROM app.binding_operation_receipts WHERE actor_id=$1 ORDER BY operation_key`, [admin.id])).rows;
    expect(receipts.find((row) => row.operation_key === createKey)?.result.binding_id).toBe(bindingId);
    expect(receipts.find((row) => row.operation_key === endKey)?.intent).toEqual({
      operation: "end", binding_id: bindingId, end_reason: "create-first 真鎖解除",
    });
  });

  it("E-01 end-first：未提交解除等待中的 create 只建立新 ID，舊 end／create receipt 不改寫", async () => {
    const createKey = randomUUID(), endKey = randomUUID(), reboundKey = randomUUID();
    const original = await receipt(await create(createKey), 201);
    const first = await runtime.connect(), second = await runtime.connect();
    let pending: Promise<QueryResult<{ result: Rpc }>> | undefined;
    let reboundId = "";
    try {
      await first.query("BEGIN");
      await bindActor(first, admin.id);
      const firstPid = (await first.query("SELECT pg_backend_pid() pid")).rows[0].pid as number;
      expect((await first.query<{ result: Rpc }>(
        "SELECT app.end_teacher_student_binding($1,$2,$3) result",
        [original.binding_id, "end-first 真鎖解除", endKey],
      )).rows[0]!.result.outcome).toBe("ended");

      await second.query("BEGIN");
      await bindActor(second, admin.id);
      const secondPid = (await second.query("SELECT pg_backend_pid() pid")).rows[0].pid as number;
      pending = second.query<{ result: Rpc }>(
        "SELECT app.create_teacher_student_binding($1,$2,$3) result",
        [teacher.id, student.id, reboundKey],
      );
      void pending.catch(() => undefined);
      await waitForLock(secondPid, firstPid);
      await first.query("COMMIT");
      const created = (await pending).rows[0]!.result;
      expect(created.outcome).toBe("created");
      reboundId = created.binding_id!;
      await second.query("COMMIT");
    } finally {
      await first.query("ROLLBACK");
      await pending?.catch(() => undefined);
      await second.query("ROLLBACK");
      first.release(); second.release();
    }

    expect(reboundId).not.toBe(original.binding_id);
    expect(await state(original.binding_id)).toMatchObject({ state: "ended", end_reason: "end-first 真鎖解除" });
    expect(await state(reboundId)).toMatchObject({ state: "active" });
    expect((await control.query(`SELECT count(*)::int n FROM app.teacher_student_bindings
      WHERE teacher_id=$1 AND student_id=$2 AND state='active'`, [teacher.id, student.id])).rows[0].n).toBe(1);
    const beforeReplay = await snapshot();
    expect(await receipt(await create(createKey), 200)).toMatchObject({
      outcome: "replayed", binding_id: original.binding_id, state: "active",
    });
    expect(await receipt(await end(original.binding_id, endKey, "end-first 真鎖解除"), 200)).toMatchObject({
      outcome: "replayed", binding_id: original.binding_id, state: "ended",
    });
    await problem(await end(original.binding_id, randomUUID()), 409, "binding_ended");
    expect(await snapshot()).toEqual(beforeReplay);
    const audit = (await control.query(`SELECT object_ref,action FROM app.audit_events
      WHERE object_ref=ANY($1::uuid[]) ORDER BY at,id`, [[original.binding_id, reboundId]])).rows;
    expect(audit).toEqual([
      { object_ref: original.binding_id, action: "binding_created" },
      { object_ref: original.binding_id, action: "binding_ended" },
      { object_ref: reboundId, action: "binding_created" },
    ]);
  });

  it("E-01 active pair create-first：建立衝突先線性化，等待解除只結束舊 ID", async () => {
    const original = await receipt(await create(), 201);
    const first = await runtime.connect(), second = await runtime.connect();
    let pending: Promise<QueryResult<{ result: Rpc }>> | undefined;
    try {
      await first.query("BEGIN");
      await bindActor(first, admin.id);
      const firstPid = (await first.query("SELECT pg_backend_pid() pid")).rows[0].pid as number;
      expect((await first.query<{ result: Rpc }>(
        "SELECT app.create_teacher_student_binding($1,$2,$3) result",
        [teacher.id, student.id, randomUUID()],
      )).rows[0]!.result.outcome).toBe("binding_exists");

      await second.query("BEGIN");
      await bindActor(second, admin.id);
      const secondPid = (await second.query("SELECT pg_backend_pid() pid")).rows[0].pid as number;
      pending = second.query<{ result: Rpc }>(
        "SELECT app.end_teacher_student_binding($1,$2,$3) result",
        [original.binding_id, "active create-first 真鎖解除", randomUUID()],
      );
      void pending.catch(() => undefined);
      await waitForLock(secondPid, firstPid);
      await first.query("COMMIT");
      expect((await pending).rows[0]!.result).toMatchObject({ outcome: "ended", binding_id: original.binding_id });
      await second.query("COMMIT");
    } finally {
      await first.query("ROLLBACK");
      await pending?.catch(() => undefined);
      await second.query("ROLLBACK");
      first.release(); second.release();
    }
    expect(await state(original.binding_id)).toMatchObject({ state: "ended" });
    expect((await control.query(`SELECT count(*)::int n FROM app.teacher_student_bindings
      WHERE teacher_id=$1 AND student_id=$2 AND state='active'`, [teacher.id, student.id])).rows[0].n).toBe(0);
    const saved = await snapshot();
    expect(saved.bindings).toHaveLength(1);
    expect(saved.receipts).toHaveLength(2);
    expect(saved.audits.map((event: { action: string }) => event.action).sort()).toEqual(["binding_created", "binding_ended"]);
  });

  it.each(["create", "end"] as const)("%s 真 COMMIT 後丟失回應，原鍵重試僅 replay", async (operation) => {
    const id = operation === "end" ? (await receipt(await create(), 201)).binding_id : null;
    const key = randomUUID(), actual = createAuthPrincipalResolver();
    let committed = false;
    const loss: TrustedPrincipalResolver = {
      async resolve(input) {
        const principal = await actual.resolve(input);
        if (!principal.ok) return principal;
        return { ...principal, session: { ...principal.session, write: {
          async runTransaction(work) {
            await principal.session.write.runTransaction(work);
            committed = true;
            throw new Error("合成提交後回應遺失。");
          },
        } } };
      },
    };
    const handlers = createBindingHandlers({ resolver: loss, requireSameOrigin: true });
    const response = id
      ? await handlers.end(endRequest(id, key), { id })
      : await handlers.create(createRequest(key));
    await problem(response, 503, "operation_outcome_unknown");
    expect(committed).toBe(true);
    const before = await snapshot();
    const persisted = before.receipts.find((r: { operation_key: string }) => r.operation_key === key).result;
    const retry = id ? await end(id, key) : await create(key);
    expect(retry.headers.get("idempotent-replay")).toBe("true");
    expect(await receipt(retry, 200)).toEqual({ ...persisted, outcome: "replayed" });
    expect(await snapshot()).toEqual(before);
  });

  it.each(["teacher", "student"] as const)("%s HTTP 與所有公開 RPC 均拒絕，header 偽裝無效", async (role) => {
    const who = role === "teacher" ? teacher : student;
    const first = await receipt(await create(), 201), before = await snapshot();
    await problem(await create(randomUUID(), who), 403, "forbidden");
    await problem(await end(first.binding_id, randomUUID(), "解除", who), 403, "forbidden");
    for (const kind of ["teachers", "bindings", `students&teacher_id=${teacher.id}&school_id=${student.schoolId}`]) {
      await problem(await bindings.list(request(who, "GET", `/api/v1/admin/bindings?kind=${kind}`, undefined,
        randomUUID(), { "x-role": "admin", "x-user-id": admin.id })), 403, "forbidden");
    }
    expect(await rpcCreate(randomUUID(), who)).toEqual({ outcome: "denied" });
    expect(await rpcEnd(first.binding_id, randomUUID(), "解除", who)).toEqual({ outcome: "denied" });
    expect(await rpc("SELECT app.list_binding_options('teachers',NULL,NULL,NULL) result", [], who))
      .toEqual({ outcome: "denied" });
    expect(await snapshot()).toEqual(before);
  });

  it.each([
    ["pending", "none"], ["rejected", "none"], ["disabled", "none"],
    ["approved", "marked"], ["approved", "purging"], ["approved", "purge_failed"], ["approved", "purged"],
  ])("admin %s／%s：所有 HTTP／RPC 即時拒絕且不留副作用", async (status, deletion) => {
    const first = await receipt(await create(), 201), before = await snapshot();
    await control.query("UPDATE app.profiles SET status=$2,deletion_state=$3 WHERE id=$1", [admin.id, status, deletion]);
    await problem(await create(), 403, "forbidden");
    await problem(await end(first.binding_id), 403, "forbidden");
    await problem(await bindings.list(request(admin, "GET", "/api/v1/admin/bindings?kind=bindings")), 403, "forbidden");
    expect(await rpcCreate()).toEqual({ outcome: "denied" });
    expect(await rpcEnd(first.binding_id)).toEqual({ outcome: "denied" });
    expect(await rpc("SELECT app.list_binding_options('teachers',NULL,NULL,NULL) result", []))
      .toEqual({ outcome: "denied" });
    expect(await snapshot()).toEqual(before);
  });

  it("匿名／無效 cookie、跨來源、未知欄位、非 UUID key／ID 及非法理由均不變更資料", async () => {
    const first = await receipt(await create(), 201), before = await snapshot();
    await problem(await bindings.create(createRequest(randomUUID(), null)), 401, "unauthenticated");
    await problem(await bindings.create(request(null, "POST", "/api/v1/admin/bindings",
      { teacher_id: teacher.id, student_id: student.id }, randomUUID(),
      { cookie: `${sessionCookieName}=not-a-valid-session` })), 401, "unauthenticated");
    const cross = createRequest();
    cross.headers.set("origin", "https://example.invalid");
    await problem(await bindings.create(cross), 403, "forbidden");
    for (const body of [
      { teacher_id: teacher.id, student_id: student.id, role: "admin" },
      { teacher_id: "invalid", student_id: student.id }, { teacher_id: teacher.id },
    ]) await problem(await bindings.create(request(admin, "POST", "/api/v1/admin/bindings", body)), 400, "invalid_request");
    for (const key of ["", "not-a-uuid"]) {
      await problem(await bindings.create(createRequest(key)), 400, "invalid_idempotency_key");
    }
    const missingKey = createRequest();
    missingKey.headers.delete("idempotency-key");
    await problem(await bindings.create(missingKey), 400, "idempotency_key_required");
    for (const reason of ["", "\u3000", "字\u0001", "字".repeat(2001)]) {
      await problem(await end(first.binding_id, randomUUID(), reason), 400, "invalid_request");
      expect(await rpcEnd(first.binding_id, randomUUID(), reason)).toEqual({ outcome: "invalid_input" });
    }
    await problem(await bindings.end(endRequest("invalid"), { id: "invalid" }), 400, "invalid_request");
    expect(await rpc("SELECT app.create_teacher_student_binding(NULL,$1,$2) result",
      [student.id, randomUUID()])).toEqual({ outcome: "invalid_input" });
    expect(await snapshot()).toEqual(before);
  });

  it.each([
    ["teacher wrong role", "UPDATE app.profiles SET role='admin' WHERE id=$1", "teacher", "teacher_not_eligible"],
    ["student wrong role", "UPDATE app.profiles SET role='teacher' WHERE id=$1", "student", "student_not_approved"],
    ...["pending", "rejected", "disabled"].flatMap((status) => [
      [`teacher ${status}`, `UPDATE app.profiles SET status='${status}' WHERE id=$1`, "teacher", "teacher_not_eligible"],
      [`student ${status}`, `UPDATE app.profiles SET status='${status}' WHERE id=$1`, "student", "student_not_approved"],
    ]),
    ...["marked", "purging", "purge_failed", "purged"].flatMap((deletion) => [
      [`teacher ${deletion}`, `UPDATE app.profiles SET deletion_state='${deletion}' WHERE id=$1`, "teacher", "teacher_not_eligible"],
      [`student ${deletion}`, `UPDATE app.profiles SET deletion_state='${deletion}' WHERE id=$1`, "student", "student_not_approved"],
    ]),
    ...["unconfirmed", "withdrawn", "expired"].map((status) =>
      [`school ${status}`, `UPDATE app.schools SET approval_state='${status}' WHERE id=$1`, "school", "school_not_eligible"]),
    ["school deadline", "UPDATE app.schools SET valid_until=clock_timestamp()-interval '1 second' WHERE id=$1",
      "school", "school_not_eligible"],
    ["membership ended", "UPDATE app.teacher_school_memberships SET state='ended' WHERE id=$1",
      "membership", "teacher_school_mismatch"],
  ])("%s：HTTP／RPC 建立拒絕且無 receipt／audit", async (_label, sql, target, outcome) => {
    const id = target === "teacher" ? teacher.id : target === "student" ? student.id :
      target === "school" ? student.schoolId : membership;
    await control.query(sql!, [id]);
    const before = await snapshot();
    await problem(await create(), 409, outcome!);
    expect(await rpcCreate()).toEqual({ outcome });
    expect(await snapshot()).toEqual(before);
  });

  it("自綁／跨校 membership／缺學校拒絕，不以教師 profile school_id 當持久歸屬", async () => {
    await problem(await create(randomUUID(), admin, teacher.id, teacher.id), 409, "invalid_binding_pair");
    expect(await rpcCreate(randomUUID(), admin, teacher.id, teacher.id)).toEqual({ outcome: "invalid_pair" });
    await control.query("DELETE FROM app.teacher_school_memberships WHERE id=$1", [membership]);
    await member(teacher.id, teacher.schoolId);
    await control.query("UPDATE app.profiles SET school_id=$2 WHERE id=$1", [teacher.id, student.schoolId]);
    await problem(await create(), 409, "teacher_school_mismatch");
    expect(await rpcCreate()).toEqual({ outcome: "teacher_school_mismatch" });
    // 正常 schema 已禁止學生無學校；只於回滾交易移除 CHECK，驗證 RPC 防線也不放行。
    const client = await control.connect();
    try {
      await client.query("BEGIN");
      await client.query("ALTER TABLE app.profiles DROP CONSTRAINT profiles_student_school_required");
      await client.query("UPDATE app.profiles SET school_id=NULL WHERE id=$1", [student.id]);
      await bindActor(client, admin.id);
      expect((await client.query("SELECT app.create_teacher_student_binding($1,$2,$3) result",
        [teacher.id, student.id, randomUUID()])).rows[0].result).toEqual({ outcome: "school_not_eligible" });
    } finally { await client.query("ROLLBACK"); client.release(); }
    expect((await snapshot()).bindings).toEqual([]);
    expect((await snapshot()).receipts).toEqual([]);
    expect((await snapshot()).audits).toEqual([]);
  });

  it.each([
    ["admin", "UPDATE app.profiles SET status='disabled' WHERE id=$1", "denied"],
    ["teacher", "UPDATE app.profiles SET status='disabled' WHERE id=$1", "teacher_not_eligible"],
    ["student", "UPDATE app.profiles SET status='disabled' WHERE id=$1", "student_not_approved"],
    ["school", "UPDATE app.schools SET approval_state='withdrawn' WHERE id=$1", "school_not_eligible"],
    ["membership", "UPDATE app.teacher_school_memberships SET state='ended' WHERE id=$1", "teacher_school_mismatch"],
  ])("等待 %s 鎖後失權：建立必須重新判斷已提交現況", async (target, sql, outcome) => {
    const id = target === "admin" ? admin.id : target === "teacher" ? teacher.id :
      target === "student" ? student.id : target === "school" ? student.schoolId : membership;
    const blocker = await control.connect(), caller = await runtime.connect();
    let pending: Promise<QueryResult<{ result: Rpc }>> | undefined;
    try {
      await blocker.query("BEGIN");
      const blockingPid = (await blocker.query("SELECT pg_backend_pid() pid")).rows[0].pid as number;
      await blocker.query(sql!, [id]);
      await caller.query("BEGIN");
      await bindActor(caller, admin.id);
      const pid = (await caller.query("SELECT pg_backend_pid() pid")).rows[0].pid as number;
      pending = caller.query<{ result: Rpc }>("SELECT app.create_teacher_student_binding($1,$2,$3) result",
        [teacher.id, student.id, randomUUID()]);
      void pending.catch(() => undefined);
      await waitForLock(pid, blockingPid);
      await blocker.query("COMMIT");
      expect((await pending).rows[0]!.result).toEqual({ outcome });
      await caller.query("COMMIT");
    } finally {
      await blocker.query("ROLLBACK");
      await pending?.catch(() => undefined);
      await caller.query("ROLLBACK");
      blocker.release();
      caller.release();
    }
    const saved = await snapshot();
    expect(saved.bindings).toEqual([]);
    expect(saved.receipts).toEqual([]);
    expect(saved.audits).toEqual([]);
  });

  it("解除不受目標後來停用／刪除／學校到期／歸屬結束阻擋；admin 本人失權仍拒絕", async () => {
    const first = await receipt(await create(), 201);
    await control.query("UPDATE app.profiles SET status='disabled',deletion_state='marked' WHERE id=ANY($1::uuid[])",
      [[teacher.id, student.id]]);
    await control.query("UPDATE app.schools SET valid_until=clock_timestamp()-interval '1 second' WHERE id=$1", [student.schoolId]);
    await control.query("UPDATE app.teacher_school_memberships SET state='ended' WHERE id=$1", [membership]);
    const ended = await receipt(await end(first.binding_id), 200);
    expect(ended).toMatchObject({ state: "ended", binding_id: first.binding_id });
    await control.query("UPDATE app.profiles SET deletion_state='marked' WHERE id=$1", [admin.id]);
    await problem(await end(first.binding_id), 403, "forbidden");
  });

  it.each(["create", "end"] as const)("%s audit append 故障完整回滾，原鍵可重試成功", async (operation) => {
    const id = operation === "end" ? (await receipt(await create(), 201)).binding_id : null;
    const before = await snapshot(), key = randomUUID();
    await control.query(`ALTER TABLE app.audit_events ADD CONSTRAINT ${auditFailure}
      CHECK(action NOT IN ('binding_created','binding_ended')) NOT VALID`);
    try {
      await problem(id ? await end(id, key) : await create(key), 503, "operation_outcome_unknown");
      expect(await snapshot()).toEqual(before);
    } finally { await control.query(`ALTER TABLE app.audit_events DROP CONSTRAINT ${auditFailure}`); }
    await receipt(id ? await end(id, key) : await create(key), id ? 200 : 201);
    const saved = await snapshot();
    expect(saved.audits).toHaveLength(before.audits.length + 1);
    expect(saved.receipts).toHaveLength(before.receipts.length + 1);
  });

  it("RLS／最小 grants／helper EXECUTE：authenticated 不可直接寫入或升權，receipt 依 actor 隔離", async () => {
    const created = await receipt(await create(), 201);
    // SET ROLE 的可切換角色由 session_user 決定；control 的 superuser 不適合驗證此拒絕。
    const application = await runtime.connect();
    try {
      await application.query("BEGIN");
      await bindActor(application, student.id);
      expect((await application.query(`SELECT session_user::text session_role,current_user::text active_role,
        r.rolsuper,r.rolbypassrls,
        pg_has_role(session_user,'app_binding_writer','MEMBER') writer_member
        FROM pg_roles r WHERE r.rolname=session_user`)).rows[0]).toEqual({
        session_role: "app_usage_test", active_role: "authenticated",
        rolsuper: false, rolbypassrls: false, writer_member: false,
      });
      await expect(application.query("SET LOCAL ROLE app_binding_writer"))
        .rejects.toMatchObject({ code: "42501" });
    } finally { await application.query("ROLLBACK"); application.release(); }
    const client = await control.connect();
    try {
      await client.query("BEGIN");
      const role = (await client.query(`SELECT rolcanlogin,rolinherit,rolsuper,rolbypassrls,rolcreatedb,rolcreaterole
        FROM pg_roles WHERE rolname='app_binding_writer'`)).rows[0];
      expect(Object.values(role)).toEqual([false, false, false, false, false, false]);
      const relations = (await client.query(`SELECT relname,relrowsecurity,relforcerowsecurity FROM pg_class
        WHERE oid=ANY(ARRAY['app.binding_operation_receipts'::regclass,'app.teacher_student_bindings'::regclass])`)).rows;
      expect(relations).toHaveLength(2);
      for (const relation of relations) expect(relation).toMatchObject({ relrowsecurity: true, relforcerowsecurity: true });
      for (const roleName of ["anon", "authenticated", "service_role"]) {
        for (const table of ["profiles", "schools", "teacher_school_memberships", "teacher_student_bindings",
          "binding_operation_receipts"]) {
          for (const permission of ["INSERT", "UPDATE", "DELETE", "TRUNCATE"]) {
            expect((await client.query("SELECT has_table_privilege($1,$2,$3) allowed",
              [roleName, `app.${table}`, permission])).rows[0].allowed).toBe(false);
          }
        }
      }
      for (const table of ["profiles", "schools", "teacher_school_memberships"]) {
        expect((await client.query(`SELECT has_column_privilege('app_binding_writer',$1,'id','UPDATE') lock,
          has_table_privilege('app_binding_writer',$1,'UPDATE') rewrite`, [`app.${table}`])).rows[0])
          .toEqual({ lock: true, rewrite: false });
      }
      for (const column of ["teacher_id", "student_id", "created_by_aid", "created_at"]) {
        expect((await client.query(`SELECT has_column_privilege('app_binding_writer',
          'app.teacher_student_bindings',$1,'UPDATE') allowed`, [column])).rows[0].allowed).toBe(false);
      }
      for (const column of ["state", "ended_at", "ended_by_aid", "end_reason"]) {
        expect((await client.query(`SELECT has_column_privilege('app_binding_writer',
          'app.teacher_student_bindings',$1,'UPDATE') allowed`, [column])).rows[0].allowed).toBe(true);
      }
      for (const signature of ["app.binding_admin_valid()", "app.binding_eligibility(uuid,uuid)",
        "app.binding_audit(uuid,uuid,uuid,uuid,boolean)"]) {
        for (const roleName of ["anon", "authenticated", "service_role"]) {
          expect((await client.query("SELECT has_function_privilege($1,$2,'EXECUTE') allowed",
            [roleName, signature])).rows[0].allowed).toBe(false);
        }
      }
      for (const signature of ["app.create_teacher_student_binding(uuid,uuid,uuid)",
        "app.end_teacher_student_binding(uuid,text,uuid)", "app.list_binding_options(text,uuid,uuid,uuid)"]) {
        for (const roleName of ["anon", "authenticated", "service_role"]) {
          expect((await client.query("SELECT has_function_privilege($1,$2,'EXECUTE') allowed",
            [roleName, signature])).rows[0].allowed).toBe(roleName === "authenticated");
        }
        expect((await client.query(`SELECT proowner::regrole::text owner,prosecdef,
          proconfig @> ARRAY['search_path=pg_catalog'] AS safe_path,
          EXISTS(SELECT 1 FROM aclexplode(proacl) WHERE grantee=0 AND privilege_type='EXECUTE') public_execute
          FROM pg_proc WHERE oid=$1::regprocedure`, [signature])).rows[0])
          .toEqual({ owner: "app_binding_writer", prosecdef: true, safe_path: true, public_execute: false });
      }
      await bindActor(client, student.id);
      for (const sql of [
        "SELECT * FROM app.binding_operation_receipts", "SELECT app.binding_admin_valid()",
        `SELECT app.binding_eligibility('${teacher.id}','${student.id}')`,
        `SELECT app.binding_audit('${created.binding_id}','${teacher.id}','${student.id}','${student.schoolId}',false)`,
        `UPDATE app.teacher_student_bindings SET state='ended' WHERE id='${created.binding_id}'`,
      ]) {
        await client.query("SAVEPOINT denied_call");
        await expect(client.query(sql)).rejects.toMatchObject({ code: "42501" });
        await client.query("ROLLBACK TO SAVEPOINT denied_call");
      }
      expect((await client.query("SELECT id FROM app.teacher_student_bindings WHERE id=$1", [created.binding_id])).rows).toEqual([]);
      await client.query("RESET ROLE");
      await client.query("SET LOCAL ROLE app_binding_writer");
      expect((await client.query("SELECT * FROM app.binding_operation_receipts")).rows).toEqual([]);
      await client.query("SAVEPOINT receipt_other_actor");
      await expect(client.query(`INSERT INTO app.binding_operation_receipts VALUES($1,$2,'{}','{}')`,
        [admin.id, randomUUID()])).rejects.toMatchObject({ code: "42501" });
      await client.query("ROLLBACK TO SAVEPOINT receipt_other_actor");
      await client.query("SELECT set_config('request.jwt.claim.sub',$1,true)", [admin.id]);
      expect((await client.query("SELECT actor_id FROM app.binding_operation_receipts")).rows).toEqual([{ actor_id: admin.id }]);
      await client.query("SAVEPOINT lock_not_rewrite");
      await expect(client.query("UPDATE app.profiles SET id=id WHERE id=$1", [student.id]))
        .rejects.toMatchObject({ code: "42501" });
      await client.query("ROLLBACK TO SAVEPOINT lock_not_rewrite");
      for (const privilege of ["UPDATE", "DELETE", "TRUNCATE"]) {
        expect((await client.query("SELECT has_table_privilege('app_binding_writer','app.binding_operation_receipts',$1) allowed",
          [privilege])).rows[0].allowed).toBe(false);
      }
    } finally { await client.query("ROLLBACK"); client.release(); }
  });

  it("teachers／students／bindings UUID keyset 分頁皆最多 20；最小嚴格投影且無重複或遺漏", async () => {
    const extra: Actor[] = [];
    for (let offset = 0; offset < 21; offset += 3) {
      extra.push(...await Promise.all(Array.from({ length: Math.min(3, 21 - offset) }, () => actor())));
    }
    const allStudents = [student, ...extra], memberships = [membership], bindingIds: string[] = [];
    for (const account of extra) {
      memberships.push(await member(teacher.id, account.schoolId));
      await control.query("UPDATE app.profiles SET school_id=$2 WHERE id=$1", [account.id, student.schoolId]);
    }
    for (const account of allStudents) {
      bindingIds.push((await receipt(await create(randomUUID(), admin, teacher.id, account.id), 201)).binding_id);
    }
    for (const kind of ["teachers", "students", "bindings"] as const) {
      let cursor: string | null = null;
      const seen: string[] = [];
      let pages = 0;
      do {
        const query = new URLSearchParams({ kind, ...(cursor ? { after: cursor } : {}),
          ...(kind === "students" ? { teacher_id: teacher.id, school_id: student.schoolId } : {}) });
        const response = await bindings.list(request(admin, "GET", `/api/v1/admin/bindings?${query}`));
        expect(response.status).toBe(200);
        expect(response.headers.get("cache-control")).toContain("no-store");
        const page: BindingList = bindingListSchema.parse(await response.json());
        expect(page.kind).toBe(kind);
        expect(page.items.length).toBeLessThanOrEqual(20);
        const ids = page.items.map((row) => row.id);
        expect(ids).toEqual([...ids].sort());
        if (cursor) expect(ids.every((id) => id > cursor!)).toBe(true);
        expect(ids.some((id) => seen.includes(id))).toBe(false);
        seen.push(...ids);
        if (page.next_cursor) {
          expect(ids).toHaveLength(20);
          expect(page.next_cursor).toBe(ids.at(-1));
        }
        for (const row of page.items) {
          expect(Object.keys(row).sort()).toEqual((kind === "bindings"
            ? ["id", "teacher_id", "student_id", "state", "teacher_label", "student_label", "school_id", "school_label"]
            : ["id", "account_id", "label", "role", "qualified", "school_id", "school_label"]).sort());
        }
        cursor = page.next_cursor;
        expect(++pages).toBeLessThan(100);
      } while (cursor);
      const expected = (kind === "teachers" ? memberships :
        kind === "students" ? allStudents.map((a) => a.id) : bindingIds).sort();
      expect(seen.filter((id) => expected.includes(id)).sort()).toEqual(expected);
      expect(pages).toBeGreaterThanOrEqual(2);
    }
    for (const query of ["kind=invalid", "kind=students", "kind=teachers&limit=100",
      "kind=teachers&after=invalid", "kind=teachers&kind=bindings", `kind=teachers&teacher_id=${teacher.id}`]) {
      await problem(await bindings.list(request(admin, "GET", `/api/v1/admin/bindings?${query}`)), 400, "invalid_request");
    }
  }, 120_000);

  it("真 Auth／DB /me 投影 0／100／101 關係完整；合法第 101 筆建立、解除與失權後不遺漏", async () => {
    const me = createMeHandler();
    const read = async (who = student) => {
      const response = await me(request(who, "GET", "/api/v1/me"));
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toContain("no-store");
      return await response.json() as { teacher_notice?: { teachers: { display_label: string }[]; scope: string[] } };
    };
    expect((await read()).teacher_notice).toBeUndefined();
    const extra: SyntheticAuthAccount[] = [];
    for (let offset = 0; offset < 100; offset += 10) {
      const batch = await Promise.all(Array.from({ length: 10 }, (_, index) =>
        createSyntheticAuthAccount(control, `邊界老師${String(offset + index + 1).padStart(3, "0")}`)));
      extra.push(...batch);
      accounts.push(...batch);
      const ids = batch.map((account) => account.id);
      await control.query("UPDATE app.profiles SET role='teacher',school_id=$2 WHERE id=ANY($1::uuid[])",
        [ids, student.schoolId]);
      await control.query(`INSERT INTO app.teacher_school_memberships
        (id,teacher_id,school_id,state,created_by_aid,created_at)
        SELECT gen_random_uuid(),teacher_id,$2,'active',gen_random_uuid(),clock_timestamp()
        FROM unnest($1::uuid[]) AS candidates(teacher_id)`, [ids, student.schoolId]);
      await control.query(`INSERT INTO app.teacher_student_bindings
        (id,teacher_id,student_id,state,created_by_aid,created_at)
        SELECT gen_random_uuid(),teacher_id,$2,'active',gen_random_uuid(),clock_timestamp()
        FROM unnest($1::uuid[]) AS candidates(teacher_id)`, [ids, student.id]);
    }
    const hundred = await read();
    expect(hundred.teacher_notice?.teachers).toHaveLength(100);
    expect(new Set(hundred.teacher_notice?.teachers.map((entry) => entry.display_label)).size).toBe(100);

    const oneHundredFirst = await receipt(await create(), 201);
    const all = await read();
    expect(all.teacher_notice?.teachers).toHaveLength(101);
    expect(all.teacher_notice?.teachers.map((entry) => entry.display_label)).toContain("合成帳號綁定回歸");
    expect(all.teacher_notice?.teachers.every((entry) => Object.keys(entry).length === 1)).toBe(true);
    expect(all.teacher_notice?.scope).toEqual(["已保存的專案需求、階段草稿、學生確認狀態與任務"]);

    await control.query("UPDATE app.profiles SET status='disabled' WHERE id=$1", [extra[0]!.id]);
    const oneDisabled = await read();
    expect(oneDisabled.teacher_notice?.teachers).toHaveLength(100);
    expect(oneDisabled.teacher_notice?.teachers.map((entry) => entry.display_label))
      .not.toContain("合成帳號邊界老師001");
    await control.query("UPDATE app.profiles SET status='approved' WHERE id=$1", [extra[0]!.id]);
    await receipt(await end(oneHundredFirst.binding_id), 200);
    expect((await read()).teacher_notice?.teachers).toHaveLength(100);

    const unrelated = await actor();
    expect((await read(unrelated)).teacher_notice).toBeUndefined();
  }, 120_000);

  it("下次學生 /me 即時 teacher_notice 只含教師標籤及範圍，解除／失權不需刷新", async () => {
    const me = createMeHandler();
    const read = async (who = student) => {
      const response = await me(request(who, "GET", "/api/v1/me"));
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toContain("no-store");
      return await response.json() as { teacher_notice?: { teachers: { display_label: string }[]; scope: string[] } };
    };
    expect((await read()).teacher_notice).toBeUndefined();
    const first = await receipt(await create(), 201);
    expect((await read()).teacher_notice).toEqual({
      teachers: [{ display_label: "合成帳號綁定回歸" }],
      scope: ["已保存的專案需求、階段草稿、學生確認狀態與任務"],
    });
    expect((await read(teacher)).teacher_notice).toBeUndefined();
    expect((await read(admin)).teacher_notice).toBeUndefined();
    await control.query("UPDATE app.profiles SET status='disabled' WHERE id=$1", [teacher.id]);
    expect((await read()).teacher_notice).toBeUndefined();
    await control.query("UPDATE app.profiles SET status='approved' WHERE id=$1", [teacher.id]);
    expect((await read()).teacher_notice?.teachers).toHaveLength(1);
    await control.query("UPDATE app.teacher_school_memberships SET state='ended' WHERE id=$1", [membership]);
    expect((await read()).teacher_notice).toBeUndefined();
    await control.query("UPDATE app.teacher_school_memberships SET state='active' WHERE id=$1", [membership]);
    await control.query("UPDATE app.schools SET valid_until=clock_timestamp()-interval '1 second' WHERE id=$1", [student.schoolId]);
    expect((await read()).teacher_notice).toBeUndefined();
    await control.query("UPDATE app.schools SET valid_until=NULL WHERE id=$1", [student.schoolId]);
    await receipt(await end(first.binding_id), 200);
    expect((await read()).teacher_notice).toBeUndefined();
    await receipt(await create(), 201);
    expect((await read()).teacher_notice?.teachers).toHaveLength(1);
  });

  it("0031→0032 回滾交易 replay：既有 binding／submission／decision／epoch 歷史完全不變", async () => {
    // 此唯一 migration fixture 手動建立「升級前已有」的綁定；不取代上方產品建立／解除驗收。
    const historicalBinding = randomUUID();
    await control.query(`INSERT INTO app.teacher_student_bindings
      (id,teacher_id,student_id,state,created_by_aid,created_at) VALUES($1,$2,$3,'active',$4,now())`,
    [historicalBinding, teacher.id, student.id, randomUUID()]);
    const response = await projects.create(request(student, "POST", "/api/v1/projects", { title: "合成升級歷史" }));
    expect(response.status).toBe(201);
    const project = (await response.json()).id as string;
    projectIds.push(project);
    expect((await classification.save(request(student, "PUT", `/api/v1/projects/${project}/requirements`, {
      expected_requirements_revision: 0,
      requirements: { description: "合成歷史需求", runtime_needs: "static", runtime_ai_required: false },
    }, randomUUID(), { "if-match": '"0"' }), { id: project })).status).toBe(200);
    expect((await classification.confirm(request(student, "POST", `/api/v1/projects/${project}/classification/confirmation`, {
      expected_requirements_revision: 1, tier: "A", needs_visitor_identity: false,
      requested_tier_acknowledgement: "no_preference",
    }, randomUUID(), { "if-match": '"1"' }), { id: project })).status).toBe(200);
    expect((await foundation.saveStageDraft(request(student, "PUT", `/api/v1/projects/${project}/stages/Specification`,
      { content: { text: "合成不可變規格原文 😀" } }, randomUUID(), { "if-none-match": "*" }),
    project, "Specification")).status).toBe(201);
    const current = await review.read(request(student, "GET",
      `/api/v1/projects/${project}/stages/Specification/submissions`), { id: project });
    expect(current.status).toBe(200);
    const evidence = (await current.json()).evidence;
    const submission = await review.submit(request(student, "POST",
      `/api/v1/projects/${project}/stages/Specification/submissions`, {
        expected_draft_version: evidence.draft_version,
        expected_requirements_revision: evidence.requirements_revision,
        expected_classification_id: evidence.classification_id,
      }), { id: project });
    expect(submission.status).toBe(200);
    const submitted = (await submission.json()).submission_id as string;
    const reason = "\u3000 合成合法歷史理由 😀 \u00a0";
    expect(await rpc("SELECT app.decide_specification($1,'returned',$2,$3) result",
      [submitted, reason, randomUUID()], teacher)).toMatchObject({ outcome: "decided" });
    const historySql = `SELECT
      (SELECT to_jsonb(b) FROM app.teacher_student_bindings b WHERE id=$1) binding,
      (SELECT to_jsonb(m) FROM app.teacher_school_memberships m WHERE id=$2) membership,
      (SELECT jsonb_agg(to_jsonb(p) ORDER BY p.id) FROM app.profiles p WHERE id=ANY($3::uuid[])) profiles,
      (SELECT to_jsonb(s) FROM app.schools s WHERE id=$4) school,
      (SELECT to_jsonb(p) FROM app.projects p WHERE id=$5) project,
      (SELECT jsonb_agg(to_jsonb(r) ORDER BY r.stage) FROM app.stage_records r WHERE project_id=$5) drafts,
      (SELECT jsonb_agg(to_jsonb(c) ORDER BY c.id) FROM app.project_classification_confirmations c WHERE project_id=$5) classifications,
      (SELECT jsonb_agg(to_jsonb(s) ORDER BY s.sequence) FROM app.specification_submissions s WHERE project_id=$5) submissions,
      (SELECT to_jsonb(d) FROM app.specification_decisions d WHERE submission_id=$6) decision,
      (SELECT jsonb_agg(to_jsonb(e) ORDER BY e.id) FROM app.audit_events e WHERE object_ref=$5) audits`;
    const values = [historicalBinding, membership, [admin.id, teacher.id, student.id], student.schoolId, project, submitted];
    const before = (await control.query(historySql, values)).rows[0];
    expect(before.decision.reason).toBe(reason);
    const [migration, priorReview, priorStatus] = await Promise.all([
      readFile(new URL("../../supabase/migrations/0032_admin_bindings.sql", import.meta.url), "utf8"),
      readFile(new URL("../../supabase/migrations/0030_specification_review.sql", import.meta.url), "utf8"),
      readFile(new URL("../../supabase/migrations/0026_account_self_status.sql", import.meta.url), "utf8"),
    ]);
    const auditStart = priorReview.indexOf("ALTER TABLE app.audit_events DROP CONSTRAINT audit_events_staff_shape;");
    const auditEnd = priorReview.indexOf("GRANT SELECT,INSERT ON app.audit_identity_map", auditStart);
    const statusStart = priorStatus.indexOf("CREATE FUNCTION app.current_account_status()");
    const statusEnd = priorStatus.indexOf("$function$;", statusStart) + "$function$;".length;
    expect(auditStart).toBeGreaterThan(0);
    expect(auditEnd).toBeGreaterThan(auditStart);
    expect(statusStart).toBeGreaterThan(0);
    expect(statusEnd).toBeGreaterThan(statusStart);
    const client = await control.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL lock_timeout='3s'");
      // 只在此未提交交易還原 0032 新增物件；0030／0031 歷史與世代 trigger 完全保留。
      await client.query("DROP TABLE app.binding_operation_receipts");
      await client.query("DROP OWNED BY app_binding_writer");
      await client.query("DROP ROLE app_binding_writer");
      await client.query(priorReview.slice(auditStart, auditEnd));
      await client.query(priorStatus.slice(statusStart, statusEnd).replace("CREATE FUNCTION", "CREATE OR REPLACE FUNCTION"));
      expect((await client.query(historySql, values)).rows[0]).toEqual(before);
      await client.query(migration.trim().replace(/^BEGIN\s*;/i, "").replace(/COMMIT\s*;$/i, ""));
      expect((await client.query(historySql, values)).rows[0]).toEqual(before);
      expect((await client.query("SELECT count(*)::int n FROM app.binding_operation_receipts")).rows[0].n).toBe(0);
      await bindActor(client, admin.id);
      const list = (await client.query("SELECT app.list_binding_options('bindings',NULL,NULL,NULL) result")).rows[0].result;
      expect(bindingListSchema.parse(list).items.some((item) => item.id === historicalBinding)).toBe(true);
    } finally { await client.query("ROLLBACK"); client.release(); }
    expect((await control.query(historySql, values)).rows[0]).toEqual(before);
    expect(await rpcCreate()).toEqual({ outcome: "binding_exists" });
  }, 60_000);
});
