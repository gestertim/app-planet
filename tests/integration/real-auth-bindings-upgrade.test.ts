import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { Pool, type PoolClient, type QueryResult } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bindingReceiptSchema, specificationStatusSchema } from "@app-planet/core";
import { sessionCookieName } from "../../apps/web/src/server/auth-principal.ts";
import { closeServerDatabasePool } from "../../apps/web/src/server/database-session.ts";
import {
  productBindingHandlers as bindings, productProjectHandlers as projects,
  productProjectClassificationHandlers as classification, productFoundationHandlers as foundation,
  productSpecificationReviewHandlers as review,
} from "../../apps/web/src/server/product-handlers.ts";
import { loginSyntheticAccount, openControlPool, type NativeAuthSession } from "../support/real-auth-fixture.ts";
import { cleanupReviewActors, createReviewActors } from "../support/specification-review-fixture.ts";

// 僅 -Upgrade0032：runner 真正停在 0031；依序套用 0032／0033／0034，不回退 schema 模擬。
const enabled = process.env.APP_PLANET_TEST_MIGRATE_THROUGH === "0031";
const origin = process.env.APP_PLANET_APP_ORIGIN!;
let control: Pool, runtime: Pool;
let actors: Awaited<ReturnType<typeof createReviewActors>> | undefined;
let student: NativeAuthSession, teacher: NativeAuthSession, admin: NativeAuthSession;
let upgraded = false;
type Result = { outcome: string; submission_id?: string; binding_id?: string };

function request(who: NativeAuthSession, method: string, path: string, body?: unknown,
  key: string = randomUUID(), headers: Record<string, string> = {}) {
  return new Request(origin + path, { method, headers: {
    cookie: `${sessionCookieName}=${who.accessToken}`, origin, "sec-fetch-site": "same-origin",
    "content-type": "application/json", "idempotency-key": key, ...headers,
  }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
async function status(id: string) {
  const response = await review.read(request(student, "GET",
    `/api/v1/projects/${id}/stages/Specification/submissions`), { id });
  expect(response.status).toBe(200);
  return specificationStatusSchema.parse(await response.json());
}
async function submitted() {
  const response = await projects.create(request(student, "POST", "/api/v1/projects", { title: "合成真升級歷史" }));
  expect(response.status).toBe(201);
  const id = (await response.json()).id as string;
  expect((await classification.save(request(student, "PUT", `/api/v1/projects/${id}/requirements`, {
    expected_requirements_revision: 0,
    requirements: { description: "合成需求原文", runtime_needs: "static", runtime_ai_required: false },
  }, randomUUID(), { "if-match": '"0"' }), { id })).status).toBe(200);
  expect((await classification.confirm(request(student, "POST", `/api/v1/projects/${id}/classification/confirmation`, {
    expected_requirements_revision: 1, tier: "A", needs_visitor_identity: false,
    requested_tier_acknowledgement: "no_preference",
  }, randomUUID(), { "if-match": '"1"' }), { id })).status).toBe(200);
  expect((await foundation.saveStageDraft(request(student, "PUT", `/api/v1/projects/${id}/stages/Specification`,
    { content: { text: "不可變規格原文 😀" } }, randomUUID(), { "if-none-match": "*" }),
  id, "Specification")).status).toBe(201);
  const evidence = (await status(id)).evidence;
  const submission = await review.submit(request(student, "POST",
    `/api/v1/projects/${id}/stages/Specification/submissions`, {
      expected_draft_version: evidence.draft_version,
      expected_requirements_revision: evidence.requirements_revision,
      expected_classification_id: evidence.classification_id,
    }), { id });
  expect(submission.status).toBe(200);
  return { id, submission: (await submission.json()).submission_id as string };
}
async function decide(id: string, decision: "approved" | "returned", reason: string | null = null) {
  const response = await review.decide(request(teacher, "POST",
    `/api/v1/teacher/specification-submissions/${id}/decision`, { decision, reason }), { id });
  expect(response.status).toBe(200);
}
async function snapshot() {
  const ids = [actors!.student, actors!.otherStudent, actors!.teacher, actors!.outsider, actors!.admin].map((a) => a.id);
  const result: Record<string, unknown> = {};
  const queries = {
    profiles: "SELECT * FROM app.profiles WHERE id=ANY($1::uuid[])",
    schools: "SELECT * FROM app.schools WHERE id IN (SELECT school_id FROM app.profiles WHERE id=ANY($1::uuid[]))",
    memberships: "SELECT * FROM app.teacher_school_memberships WHERE teacher_id=ANY($1::uuid[])",
    bindings: "SELECT * FROM app.teacher_student_bindings WHERE teacher_id=ANY($1::uuid[]) OR student_id=ANY($1::uuid[])",
    projects: "SELECT * FROM app.projects WHERE owner_id=ANY($1::uuid[])",
    requirements: "SELECT r.* FROM app.project_requirements r JOIN app.projects p ON p.id=r.project_id WHERE p.owner_id=ANY($1::uuid[])",
    confirmations: "SELECT c.* FROM app.project_classification_confirmations c JOIN app.projects p ON p.id=c.project_id WHERE p.owner_id=ANY($1::uuid[])",
    classification_receipts: "SELECT c.* FROM app.project_classification_idempotency c JOIN app.projects p ON p.id=c.project_id WHERE p.owner_id=ANY($1::uuid[])",
    project_receipts: "SELECT c.* FROM app.project_create_idempotency c JOIN app.projects p ON p.id=c.project_id WHERE p.owner_id=ANY($1::uuid[])",
    drafts: "SELECT d.* FROM app.stage_records d JOIN app.projects p ON p.id=d.project_id WHERE p.owner_id=ANY($1::uuid[])",
    draft_receipts: "SELECT d.* FROM app.stage_draft_idempotency d JOIN app.projects p ON p.id=d.project_id WHERE p.owner_id=ANY($1::uuid[])",
    draft_confirmations: "SELECT d.* FROM app.stage_draft_confirmations d JOIN app.projects p ON p.id=d.project_id WHERE p.owner_id=ANY($1::uuid[])",
    submissions: "SELECT * FROM app.specification_submissions WHERE student_id=ANY($1::uuid[])",
    decisions: "SELECT * FROM app.specification_decisions WHERE teacher_id=ANY($1::uuid[])",
    identities: "SELECT * FROM app.audit_identity_map WHERE account_id=ANY($1::uuid[])",
    audits: `SELECT * FROM app.audit_events WHERE actor_aid IN
      (SELECT aid FROM app.audit_identity_map WHERE account_id=ANY($1::uuid[]))`,
  };
  for (const [name, sql] of Object.entries(queries)) {
    // DB 端轉 text，保留 timestamp 微秒與 bigint，不經 JavaScript Date／number 截斷。
    result[name] = (await control.query(`SELECT to_jsonb(source)::text exact_row FROM (${sql}) source
      ORDER BY to_jsonb(source)::text`, [ids])).rows;
  }
  return result;
}
async function bindActor(client: PoolClient, id: string) {
  await client.query("SET LOCAL ROLE authenticated");
  await client.query("SELECT set_config('request.jwt.claim.sub',$1,true),set_config('request.jwt.claims',$2,true)",
    [id, JSON.stringify({ sub: id })]);
}
async function waitForLock(pid: number, blocker: number) {
  for (let attempt = 0; attempt < 150; attempt++) {
    if ((await control.query(`SELECT 1 FROM pg_stat_activity WHERE pid=$1
      AND wait_event_type='Lock' AND $2=ANY(pg_blocking_pids(pid))`, [pid, blocker])).rowCount) return;
    await delay(20);
  }
  throw new Error("真升級綁定競態未觀察到預期鎖等待。");
}
async function newBinding() {
  const response = await bindings.create(request(admin, "POST", "/api/v1/admin/bindings", {
    teacher_id: actors!.teacher.id, student_id: actors!.student.id,
  }));
  expect(response.status).toBe(201);
  return bindingReceiptSchema.parse(await response.json()).binding_id;
}

describe.runIf(enabled)("真正 0031 既有資料→0034 與教師決策／解除確定鎖序", () => {
  beforeAll(async () => {
    if (process.env.APP_PLANET_ENV !== "isolated-local-test" || process.env.NODE_ENV !== "test" ||
        process.env.APP_PLANET_LOCAL_AUTH !== "1" || !origin) throw new Error("只允許隔離真升級 runner。");
    control = openControlPool();
    runtime = new Pool({ connectionString: process.env.APP_PLANET_DATABASE_URL, max: 2,
      connectionTimeoutMillis: 5_000, query_timeout: 12_000 });
    expect((await control.query(`SELECT to_regclass('app.binding_operation_receipts') receipt,
      to_regprocedure('app.create_teacher_student_binding(uuid,uuid,uuid)') create_rpc,
      EXISTS(SELECT 1 FROM pg_roles WHERE rolname='app_binding_writer') writer,
      EXISTS(SELECT 1 FROM pg_roles WHERE rolname='app_teacher_resource_reader') teacher_reader`)).rows[0])
      .toEqual({ receipt: null, create_rpc: null, writer: false, teacher_reader: false });
    actors = await createReviewActors(control);
    [student, teacher, admin] = await Promise.all([actors.student, actors.teacher, actors.admin].map(loginSyntheticAccount));
    // 先形成非零世代歷史，再提交有效新證據；不以零 epoch 冒充保留測試。
    await control.query("UPDATE app.profiles SET status='disabled' WHERE id=ANY($1::uuid[])", [[actors.student.id, actors.teacher.id]]);
    await control.query("UPDATE app.profiles SET status='approved' WHERE id=ANY($1::uuid[])", [[actors.student.id, actors.teacher.id]]);
    await control.query("UPDATE app.schools SET approval_state='withdrawn' WHERE id=$1", [actors.student.schoolId]);
    await control.query("UPDATE app.schools SET approval_state='approved' WHERE id=$1", [actors.student.schoolId]);
    await control.query("UPDATE app.teacher_school_memberships SET state='ended' WHERE id=$1", [actors.membership]);
    await control.query("UPDATE app.teacher_school_memberships SET state='active' WHERE id=$1", [actors.membership]);
    await control.query("UPDATE app.teacher_student_bindings SET state='ended' WHERE id=$1", [actors.binding]);
    await control.query("UPDATE app.teacher_student_bindings SET state='active' WHERE id=$1", [actors.binding]);
  });
  afterAll(async () => {
    await closeServerDatabasePool();
    await runtime?.end();
    try {
      if (actors) {
        const ids = [actors.student, actors.otherStudent, actors.teacher, actors.outsider, actors.admin].map((a) => a.id);
        if ((await control.query("SELECT to_regclass('app.binding_operation_receipts') receipt")).rows[0].receipt) {
          await control.query("DELETE FROM app.binding_operation_receipts WHERE actor_id=ANY($1::uuid[])", [ids]);
        }
        await cleanupReviewActors(control, actors);
      }
    } finally { await control?.end(); }
  });

  it("先於真 0031 建立 pending／approved／returned 原文與世代；提交 0032／0033／0034 完整保留，再經 API 解除失效", async () => {
    const pending = await submitted(), approved = await submitted(), returned = await submitted();
    const reason = "\u3000 合法既有理由 😀 \u00a0";
    await decide(approved.submission, "approved");
    await decide(returned.submission, "returned", reason);
    expect((await status(pending.id)).latest?.state).toBe("pending");
    expect((await status(approved.id)).latest?.state).toBe("approved");
    expect((await status(returned.id)).latest).toMatchObject({ state: "returned", decision: { reason } });
    const epochs = (await control.query(`SELECT d.teacher_epoch,d.binding_epoch,d.membership_epoch,
      s.student_epoch,s.school_epoch FROM app.specification_decisions d
      JOIN app.specification_submissions s ON s.id=d.submission_id WHERE s.id=$1`, [approved.submission])).rows[0];
    expect(Object.values(epochs).every((epoch) => BigInt(epoch as string) > 0n)).toBe(true);
    const before = await snapshot();
    const migration = await readFile(new URL("../../supabase/migrations/0032_admin_bindings.sql", import.meta.url), "utf8");
    await control.query(migration);
    const bindingLockMigration = await readFile(new URL("../../supabase/migrations/0033_admin_binding_id_lock.sql", import.meta.url), "utf8");
    await control.query(bindingLockMigration);
    const teacherResourcesMigration = await readFile(new URL("../../supabase/migrations/0034_teacher_readonly_resources.sql", import.meta.url), "utf8");
    await control.query(teacherResourcesMigration);
    upgraded = true;
    expect(await snapshot()).toEqual(before);
    expect((await status(pending.id)).latest?.state).toBe("pending");
    expect((await status(approved.id)).latest?.state).toBe("approved");
    expect((await status(returned.id)).latest).toMatchObject({ state: "returned", decision: { reason } });
    expect((await control.query("SELECT count(*)::int n FROM app.binding_operation_receipts")).rows[0].n).toBe(0);
    const role = (await control.query(`SELECT rolcanlogin,rolsuper,rolbypassrls,rolcreatedb,rolcreaterole
      FROM pg_roles WHERE rolname='app_binding_writer'`)).rows[0];
    expect(Object.values(role)).toEqual([false, false, false, false, false]);
    expect((await control.query(`SELECT relrowsecurity,relforcerowsecurity FROM pg_class
      WHERE oid='app.binding_operation_receipts'::regclass`)).rows[0])
      .toEqual({ relrowsecurity: true, relforcerowsecurity: true });
    expect((await control.query(`SELECT rolcanlogin,rolsuper,rolbypassrls,rolcreatedb,rolcreaterole
      FROM pg_roles WHERE rolname='app_teacher_resource_reader'`)).rows[0])
      .toEqual({ rolcanlogin: false, rolsuper: false, rolbypassrls: false, rolcreatedb: false, rolcreaterole: false });
    expect((await control.query(`SELECT pg_has_role('authenticated','app_teacher_resource_reader','MEMBER') member,
      has_function_privilege('authenticated','app.read_teacher_students(uuid,integer)','EXECUTE') read_api,
      has_function_privilege('anon','app.read_teacher_students(uuid,integer)','EXECUTE') anon_api,
      has_function_privilege('authenticated','app.teacher_resource_eligible(uuid)','EXECUTE') helper,
      has_table_privilege('authenticated','app.audit_events','SELECT') audit_read`)).rows[0])
      .toEqual({ member: false, read_api: true, anon_api: false, helper: false, audit_read: false });
    for (const table of ["profiles", "schools", "teacher_school_memberships"]) {
      expect((await control.query(`SELECT has_column_privilege('app_binding_writer',$1,'id','UPDATE') lock,
        has_table_privilege('app_binding_writer',$1,'UPDATE') rewrite`, [`app.${table}`])).rows[0])
        .toEqual({ lock: true, rewrite: false });
    }
    for (const name of ["anon", "authenticated", "service_role"]) {
      for (const signature of ["app.binding_admin_valid()", "app.binding_eligibility(uuid,uuid)",
        "app.binding_audit(uuid,uuid,uuid,uuid,boolean)"]) {
        expect((await control.query("SELECT has_function_privilege($1,$2,'EXECUTE') allowed", [name, signature]))
          .rows[0].allowed).toBe(false);
      }
      for (const signature of ["app.create_teacher_student_binding(uuid,uuid,uuid)",
        "app.end_teacher_student_binding(uuid,text,uuid)", "app.list_binding_options(text,uuid,uuid,uuid)"]) {
        expect((await control.query("SELECT has_function_privilege($1,$2,'EXECUTE') allowed", [name, signature]))
          .rows[0].allowed).toBe(name === "authenticated");
      }
      expect((await control.query(`SELECT has_table_privilege($1,'app.binding_operation_receipts','SELECT,INSERT,UPDATE,DELETE') allowed`,
        [name])).rows[0].allowed).toBe(false);
    }
    const client = await runtime.connect();
    try {
      await client.query("BEGIN");
      await bindActor(client, admin.userId);
      expect((await client.query(`SELECT session_user::text name,r.rolsuper,r.rolbypassrls,
        pg_has_role(session_user,'app_binding_writer','MEMBER') member FROM pg_roles r WHERE rolname=session_user`)).rows[0])
        .toEqual({ name: "app_usage_test", rolsuper: false, rolbypassrls: false, member: false });
      await expect(client.query("SET LOCAL ROLE app_binding_writer")).rejects.toMatchObject({ code: "42501" });
    } finally { await client.query("ROLLBACK"); client.release(); }
    const response = await bindings.end(request(admin, "DELETE", `/api/v1/admin/bindings/${actors!.binding}`,
      { end_reason: "真升級後合成解除" }), { id: actors!.binding });
    expect(response.status).toBe(200);
    expect(bindingReceiptSchema.parse(await response.json())).toMatchObject({ state: "ended", binding_id: actors!.binding });
    expect((await status(approved.id)).latest?.state).toBe("invalidated");
    expect((await control.query("SELECT decision FROM app.specification_decisions WHERE submission_id=$1",
      [approved.submission])).rows).toEqual([{ decision: "approved" }]);
  }, 120_000);

  it.each(["decide-first", "end-first"] as const)("%s：真 binding SHARE／UPDATE 等鎖，提交後不保留有效舊批准", async (order) => {
    expect(upgraded).toBe(true);
    const binding = await newBinding(), target = await submitted();
    const first = await runtime.connect(), second = await runtime.connect();
    let pending: Promise<QueryResult<{ result: Result }>> | undefined;
    try {
      await first.query("BEGIN");
      await second.query("BEGIN");
      const decideSql = "SELECT app.decide_specification($1,'approved',NULL,$2) result";
      const endSql = "SELECT app.end_teacher_student_binding($1,'合成確定競態解除',$2) result";
      await bindActor(first, order === "decide-first" ? teacher.userId : admin.userId);
      await bindActor(second, order === "decide-first" ? admin.userId : teacher.userId);
      const firstPid = (await first.query("SELECT pg_backend_pid() pid")).rows[0].pid as number;
      const secondPid = (await second.query("SELECT pg_backend_pid() pid")).rows[0].pid as number;
      const decidedKey = randomUUID(), endedKey = randomUUID();
      const done = await first.query<{ result: Result }>(order === "decide-first" ? decideSql : endSql,
        [order === "decide-first" ? target.submission : binding, order === "decide-first" ? decidedKey : endedKey]);
      expect(done.rows[0]!.result.outcome).toBe(order === "decide-first" ? "decided" : "ended");
      // 第一個 RPC 已完成但交易未提交，保留真實 SHARE 或 UPDATE row lock。
      pending = second.query<{ result: Result }>(order === "decide-first" ? endSql : decideSql,
        [order === "decide-first" ? binding : target.submission, order === "decide-first" ? endedKey : decidedKey]);
      void pending.catch(() => undefined);
      await waitForLock(secondPid, firstPid);
      expect((await control.query("SELECT decision FROM app.specification_decisions WHERE submission_id=$1",
        [target.submission])).rows).toEqual([]);
      await first.query("COMMIT");
      expect((await pending).rows[0]!.result.outcome).toBe(order === "decide-first" ? "ended" : "not_found");
      await second.query("COMMIT");
      const decisions = (await control.query("SELECT decision FROM app.specification_decisions WHERE submission_id=$1",
        [target.submission])).rows;
      expect(decisions).toEqual(order === "decide-first" ? [{ decision: "approved" }] : []);
      expect((await status(target.id)).latest?.state).toBe(order === "decide-first" ? "invalidated" : "pending");
      expect((await control.query("SELECT state FROM app.teacher_student_bindings WHERE id=$1", [binding])).rows)
        .toEqual([{ state: "ended" }]);
      expect((await control.query(`SELECT count(*)::int n FROM app.audit_events
        WHERE object_ref=$1 AND action='specification_approved'`, [target.id])).rows[0].n)
        .toBe(order === "decide-first" ? 1 : 0);
    } finally {
      await first.query("ROLLBACK");
      await pending?.catch(() => undefined);
      await second.query("ROLLBACK");
      first.release();
      second.release();
    }
  });
});
