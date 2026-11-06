import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { schoolDetailSchema, schoolListSchema, schoolReceiptSchema } from "@app-planet/core";
import { productSchoolHandlers as schools, productMembershipHandlers as memberships,
  productFoundationHandlers as foundation } from "../../apps/web/src/server/product-handlers.ts";
import { sessionCookieName } from "../../apps/web/src/server/auth-principal.ts";
import { closeServerDatabasePool } from "../../apps/web/src/server/database-session.ts";
import { loginSyntheticAccount, openControlPool, type NativeAuthSession } from "../support/real-auth-fixture.ts";
import { cleanupReviewActors, createReviewActors } from "../support/specification-review-fixture.ts";

const origin = process.env.APP_PLANET_APP_ORIGIN!, path = "/api/v1/admin/schools";
let control: Pool, runtime: Pool, actors: Awaited<ReturnType<typeof createReviewActors>>;
let admin: NativeAuthSession, teacher: NativeAuthSession, student: NativeAuthSession;
const created = new Set<string>();
function request(who: NativeAuthSession | null, method = "GET", suffix = "", body?: unknown, key = randomUUID(),
  extra: Record<string, string> = {}) {
  return new Request(origin + path + suffix, { method, headers: { origin, "sec-fetch-site": "same-origin",
    "content-type": "application/json", "idempotency-key": key,
    ...(who ? { cookie: `${sessionCookieName}=${who.accessToken}` } : {}), ...extra },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
const create = (label: string, key = randomUUID(), who = admin) => schools.create(request(who, "POST", "", { label }, key));
async function receipt(response: Response, status = 201) {
  expect(response.status).toBe(status);
  expect(response.headers.get("cache-control")).toContain("no-store");
  const result = schoolReceiptSchema.parse(await response.json()); created.add(result.school_id); return result;
}
async function bind(client: PoolClient, id = actors.admin.id) {
  await client.query("SET LOCAL ROLE authenticated");
  await client.query("SELECT set_config('request.jwt.claim.sub',$1,true),set_config('request.jwt.claims',$2,true)",
    [id, JSON.stringify({ sub: id })]);
}
async function asActor<T>(sql: string, values: unknown[] = [], id = actors.admin.id) {
  const c = await runtime.connect();
  try { await c.query("BEGIN"); await bind(c, id); return await c.query<T & import("pg").QueryResultRow>(sql, values); }
  finally { await c.query("ROLLBACK"); c.release(); }
}
async function snapshot() {
  return (await control.query(`SELECT jsonb_build_object(
    'schools',(SELECT jsonb_agg(to_jsonb(s) ORDER BY id) FROM app.schools s),
    'memberships',(SELECT jsonb_agg(to_jsonb(m) ORDER BY id) FROM app.teacher_school_memberships m),
    'bindings',(SELECT jsonb_agg(to_jsonb(b) ORDER BY id) FROM app.teacher_student_bindings b),
    'history_table',to_regclass('app.school_approval_records')) snapshot`)).rows[0].snapshot;
}
beforeAll(async () => {
  if (process.env.APP_PLANET_ENV !== "isolated-local-test" || !origin) throw new Error("isolated_runner_required");
  control = openControlPool();
  runtime = new Pool({ connectionString: process.env.APP_PLANET_DATABASE_URL, max: 3, query_timeout: 15_000 });
  actors = await createReviewActors(control);
  if (process.env.APP_PLANET_TEST_MIGRATE_THROUGH === "0039") {
    const before = await snapshot();
    await control.query(await readFile(new URL("../../supabase/migrations/0040_admin_school_registration.sql", import.meta.url), "utf8"));
    expect(await snapshot()).toEqual(before);
    console.info("UpgradeEvidence=0039->0040 existing schools/memberships/bindings/history unchanged");
  }
  [admin, teacher, student] = await Promise.all([actors.admin, actors.teacher, actors.student].map(loginSyntheticAccount));
});
afterAll(async () => {
  await closeServerDatabasePool(); await runtime?.end();
  if (actors) {
    await control.query("DELETE FROM app.school_registration_receipts WHERE actor_id=ANY($1::uuid[])",
      [[actors.admin.id, actors.teacher.id, actors.student.id]]);
    await control.query("DELETE FROM app.audit_events WHERE school_id=ANY($1::uuid[])", [[...created]]);
    await control.query("DELETE FROM app.schools WHERE id=ANY($1::uuid[])", [[...created]]);
    await cleanupReviewActors(control, actors);
  }
  await control?.end();
});
describe("真 Auth L-1／L-3 與必要列表（新庫／0039 升級）", () => {
  it("原子建立、讀 DB、原鍵 response-loss replay、異意圖、不同鍵同名", async () => {
    const before = await snapshot(), key = randomUUID(), label = "  合成未核驗學校  ";
    const first = await receipt(await create(label, key));
    const replayResponse = await create(label, key);
    expect(replayResponse.headers.get("idempotent-replay")).toBe("true");
    const replay = await receipt(replayResponse, 200); expect(replay.school_id).toBe(first.school_id);
    expect((await create(label + "不同", key)).status).toBe(422);
    const sameName = await receipt(await create(label)); expect(sameName.school_id).not.toBe(first.school_id);
    const detailResponse = await schools.detail(request(admin, "GET", `/${first.school_id}`), { id: first.school_id });
    expect(detailResponse.status).toBe(200);
    expect(schoolDetailSchema.parse(await detailResponse.json()).school).toEqual({
      id: first.school_id, label, approval_state: "unconfirmed", approval_epoch: 0, valid_until: null,
      current_doc_version: null, verification_history: "not_available", last_change: null,
    });
    const db = (await control.query("SELECT approval_state,approval_epoch::int,valid_until,current_doc_version FROM app.schools WHERE id=$1",
      [first.school_id])).rows[0];
    expect(db).toEqual({ approval_state: "unconfirmed", approval_epoch: 0, valid_until: null, current_doc_version: null });
    const events = await control.query("SELECT action,meta FROM app.audit_events WHERE school_id=$1", [first.school_id]);
    expect(events.rows).toEqual([{ action: "school_registered", meta: {} }]);
    const after = await snapshot();
    expect(after.memberships).toEqual(before.memberships); expect(after.bindings).toEqual(before.bindings);
    expect(after.schools.filter((s: { id: string }) => ![first.school_id, sameName.school_id].includes(s.id))).toEqual(before.schools);
    expect(after.history_table).toBeNull();
    console.info("CommitLossEvidence=discarded first committed HTTP result; original key returned same school");
  });
  it("同鍵並行只有一所學校與一份成功稽核", async () => {
    const label = "合成並行學校", key = randomUUID();
    const responses = await Promise.all([create(label, key), create(label, key)]);
    expect(responses.map((r) => r.status).sort()).toEqual([200, 201]);
    const results = await Promise.all(responses.map((r) => receipt(r, r.status)));
    expect(results[0]!.school_id).toBe(results[1]!.school_id);
    expect((await control.query("SELECT id FROM app.schools WHERE label=$1", [label])).rowCount).toBe(1);
    expect((await control.query("SELECT id FROM app.audit_events WHERE school_id=$1", [results[0]!.school_id])).rowCount).toBe(1);
  });
  it("成功 receipt 不能繞過後來失權；每請求重驗 DB 狀態", async () => {
    const key = randomUUID(), label = "合成重驗學校"; await receipt(await create(label, key));
    try {
      for (const change of ["status='disabled'", "deletion_state='marked'", "role='teacher'"]) {
        await control.query(`UPDATE app.profiles SET ${change} WHERE id=$1`, [actors.admin.id]);
        expect((await create(label, key)).status).toBe(403);
        expect((await schools.list(request(admin))).status).toBe(403);
        await control.query("UPDATE app.profiles SET status='approved',deletion_state='none',role='admin' WHERE id=$1", [actors.admin.id]);
      }
    } finally { await control.query("UPDATE app.profiles SET status='approved',deletion_state='none',role='admin' WHERE id=$1", [actors.admin.id]); }
  });
  it("未登入 401；teacher／student 偽造角色仍 403，只有固定安全事件", async () => {
    expect((await schools.list(request(null))).status).toBe(401);
    for (const who of [teacher, student]) {
      const before = await control.query("SELECT count(*)::int n FROM app.audit_events WHERE action='school_registration_denied'");
      expect((await schools.create(request(who, "POST", "", { label: "禁止記錄的名稱" }, randomUUID(), { "x-role": "admin" }))).status).toBe(403);
      expect((await schools.list(request(who))).status).toBe(403);
      expect((await schools.detail(request(who), { id: actors.student.schoolId })).status).toBe(403);
      const events = await control.query("SELECT meta,object_ref,school_id FROM app.audit_events WHERE action='school_registration_denied'");
      expect(events.rowCount).toBe(before.rows[0].n + 1);
      expect(events.rows.every((e) => JSON.stringify(e) === JSON.stringify({ meta: {}, object_ref: null, school_id: null }))).toBe(true);
    }
  });
  it.each(["create", "list", "detail"] as const)("%s 真鎖障壁：等 profile lock 期間失權不交付", async (kind) => {
    const blocker = await control.connect();
    let pending: Promise<Response> | undefined;
    try {
      await blocker.query("BEGIN");
      const pid = (await blocker.query("SELECT pg_backend_pid() pid")).rows[0].pid;
      await blocker.query("UPDATE app.profiles SET status='disabled' WHERE id=$1", [actors.admin.id]);
      pending = kind === "create" ? create("不得建立的等待學校") : kind === "list"
        ? schools.list(request(admin)) : schools.detail(request(admin), { id: actors.student.schoolId });
      void pending.catch(() => undefined);
      let observed = false;
      for (let i = 0; i < 250; i++) {
        const wait = await control.query(`SELECT 1 FROM pg_stat_activity WHERE usename='app_usage_test'
          AND wait_event_type='Lock' AND $1=ANY(pg_blocking_pids(pid))`, [pid]);
        if (wait.rowCount) { observed = true; break; }
        await delay(20);
      }
      expect(observed).toBe(true);
      await blocker.query("COMMIT");
      expect((await pending).status).toBe(403);
      expect((await control.query("SELECT id FROM app.schools WHERE label='不得建立的等待學校'")).rowCount).toBe(0);
    } finally {
      await blocker.query("ROLLBACK"); await pending?.catch(() => undefined); blocker.release();
      await control.query("UPDATE app.profiles SET status='approved' WHERE id=$1", [actors.admin.id]);
    }
  });
  it("audit 故障 school／receipt 全 rollback，原鍵仍可建立", async () => {
    const label = "合成稽核失敗", key = randomUUID();
    await control.query(`CREATE FUNCTION app.school_test_audit_failure() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.action='school_registered' THEN RAISE EXCEPTION 'synthetic_audit_failure'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER school_test_audit_failure BEFORE INSERT ON app.audit_events
      FOR EACH ROW EXECUTE FUNCTION app.school_test_audit_failure()`);
    try {
      const response = await create(label, key); expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ code: "operation_outcome_unknown" });
      expect((await control.query("SELECT id FROM app.schools WHERE label=$1", [label])).rowCount).toBe(0);
      expect((await control.query("SELECT operation_key FROM app.school_registration_receipts WHERE operation_key=$1", [key])).rowCount).toBe(0);
    } finally { await control.query("DROP TRIGGER school_test_audit_failure ON app.audit_events; DROP FUNCTION app.school_test_audit_failure()"); }
    await receipt(await create(label, key));
  });
  it("跨頁不漏不重複、最後空頁不是故障；真值期限／文件不被改寫", async () => {
    for (let i = 0; i < 22; i++) await receipt(await create(`合成分頁學校 ${i}`));
    const ids: string[] = []; let cursor: string | null = null;
    do {
      const response = await schools.list(request(admin, "GET", cursor ? `?after=${cursor}` : ""));
      expect(response.status).toBe(200);
      const page = schoolListSchema.parse(await response.json());
      ids.push(...page.items.map((s) => s.id)); cursor = page.next_cursor;
    } while (cursor);
    const all = (await control.query("SELECT id FROM app.schools ORDER BY id")).rows.map((r) => r.id);
    expect(ids).toEqual(all); expect(new Set(ids).size).toBe(ids.length);
    const empty = await schools.list(request(admin, "GET", "?after=ffffffff-ffff-4fff-bfff-ffffffffffff"));
    expect(schoolListSchema.parse(await empty.json()).items).toEqual([]);
    const id = actors.student.schoolId;
    try {
      await control.query("UPDATE app.schools SET valid_until='2031-02-03T04:05:06Z',current_doc_version='synthetic-existing-v1' WHERE id=$1", [id]);
      const detail = schoolDetailSchema.parse(await (await schools.detail(request(admin), { id })).json());
      expect(detail.school.valid_until).toBe("2031-02-03T04:05:06.000000Z");
      expect(detail.school.current_doc_version).toBe("synthetic-existing-v1");
    } finally { await control.query("UPDATE app.schools SET valid_until=NULL,current_doc_version=NULL WHERE id=$1", [id]); }
  });
  it("strict 本文／RPC 無批准參數；通用 DML 與 helper 不開放；新學校拒絕 membership／學生 gate", async () => {
    for (const extra of [{ approval_state: "approved" }, { approval_epoch: 9 }, { valid_until: "2030-01-01Z" },
      { current_doc_version: "fake" }, { verified_by: actors.admin.id }])
      expect((await schools.create(request(admin, "POST", "", { label: "校", ...extra }))).status).toBe(400);
    const result = await receipt(await create("合成資格封閉"));
    const member = new Request(`${origin}/api/v1/admin/teacher-school-memberships`, {
      method: "POST", headers: request(admin).headers, body: JSON.stringify({ teacher_id: actors.teacher.id, school_id: result.school_id }),
    });
    expect((await memberships.create(member)).status).toBe(409);
    try {
      await control.query("UPDATE app.profiles SET school_id=$1 WHERE id=$2", [result.school_id, actors.student.id]);
      const denied = await foundation.getStageDraft(new Request(origin + "/api/v1/projects/synthetic/stages/Specification", {
        headers: request(student).headers,
      }), randomUUID(), "Specification");
      expect(denied.status).toBe(403);
      for (const capability of ["login", "read_saved_content", "edit_saved_content", "internal_ai", "public_deploy"])
        expect((await asActor<{ allowed: boolean }>("SELECT app.current_account_gate($1) allowed", [capability], actors.student.id))
          .rows[0]!.allowed).toBe(false);
    } finally { await control.query("UPDATE app.profiles SET school_id=$1 WHERE id=$2", [actors.student.schoolId, actors.student.id]); }
    for (const sql of [
      "INSERT INTO app.schools(id,label,approval_epoch,created_at,updated_at) VALUES(gen_random_uuid(),'x',0,now(),now())",
      "UPDATE app.schools SET approval_state='approved'",
      "INSERT INTO app.school_registration_receipts VALUES(auth.uid(),gen_random_uuid(),'{}','{}')",
      "UPDATE app.school_registration_receipts SET result='{}'",
      "INSERT INTO app.audit_events(id,at,actor_aid,action,object_type,result,meta) VALUES(gen_random_uuid(),now(),gen_random_uuid(),'school_registration_denied','school','denied','{}')",
      "SELECT app.school_registration_audit(NULL)",
      "SELECT app.school_admin_lock()",
      "SELECT app.register_school('x',gen_random_uuid(),'approved')",
      "SET LOCAL ROLE app_school_manager",
    ]) await expect(asActor(sql)).rejects.toThrow();
    const roles = (await control.query(`SELECT rolcanlogin,rolsuper,rolbypassrls FROM pg_roles WHERE rolname='app_school_manager'`)).rows;
    expect(roles).toEqual([{ rolcanlogin: false, rolsuper: false, rolbypassrls: false }]);
    for (const role of ["anon", "authenticated", "service_role"]) {
      const privileges = (await control.query(`SELECT
        has_table_privilege($1,'app.schools','INSERT') school_insert,
        has_table_privilege($1,'app.schools','UPDATE') school_update,
        has_table_privilege($1,'app.school_registration_receipts','INSERT') receipt_insert,
        has_table_privilege($1,'app.audit_events','INSERT') audit_insert,
        has_function_privilege($1,'app.school_registration_audit(uuid)','EXECUTE') audit_helper,
        has_function_privilege($1,'app.register_school(text,uuid)','EXECUTE') register`, [role])).rows[0];
      expect(privileges).toEqual({ school_insert: false, school_update: false, receipt_insert: false,
        audit_insert: false, audit_helper: false, register: role === "authenticated" });
    }
    for (const label of ["", " \t\n　\u00a0\ufeff"]) {
      const invalid = await asActor<{ result: unknown }>("SELECT app.register_school($1,$2::uuid) result", [label, randomUUID()]);
      expect(invalid.rows[0]!.result).toEqual({ outcome: "invalid_input" });
    }
  });
});
