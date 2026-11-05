import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { Pool, type PoolClient, type QueryResult } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { membershipListSchema, membershipReceiptSchema, specificationStatusSchema } from "@app-planet/core";
import { sessionCookieName } from "../../apps/web/src/server/auth-principal.ts";
import { closeServerDatabasePool } from "../../apps/web/src/server/database-session.ts";
import { productMembershipHandlers as memberships, productProjectHandlers as projects,
  productProjectClassificationHandlers as classification, productFoundationHandlers as foundation,
  productSpecificationReviewHandlers as review } from "../../apps/web/src/server/product-handlers.ts";
import { loginSyntheticAccount, openControlPool, type NativeAuthSession } from "../support/real-auth-fixture.ts";
import { cleanupReviewActors, createReviewActors } from "../support/specification-review-fixture.ts";

const origin = process.env.APP_PLANET_APP_ORIGIN!;
const upgrade = process.env.APP_PLANET_TEST_MIGRATE_THROUGH === "0037";
let control: Pool, runtime: Pool, actors: Awaited<ReturnType<typeof createReviewActors>>;
let admin: NativeAuthSession, teacher: NativeAuthSession, student: NativeAuthSession;
type Result = { outcome: string; membership_id?: string };
function request(who: NativeAuthSession | null, method: string, path: string, body?: unknown,
  key = randomUUID(), extra: Record<string, string> = {}) {
  return new Request(origin + path, { method, headers: { origin, "sec-fetch-site": "same-origin",
    "content-type": "application/json", "idempotency-key": key,
    ...(who ? { cookie: `${sessionCookieName}=${who.accessToken}` } : {}), ...extra },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
const path = "/api/v1/admin/teacher-school-memberships";
const create = (key = randomUUID(), who = admin, t = actors.teacher.id, s = actors.student.schoolId) =>
  memberships.create(request(who, "POST", path, { teacher_id: t, school_id: s }, key));
const end = (id: string, key = randomUUID(), who = admin) =>
  memberships.end(request(who, "DELETE", `${path}/${id}`, {}, key), { id });
async function receipt(response: Response, status = 201) {
  expect(response.status).toBe(status);
  expect(response.headers.get("cache-control")).toContain("no-store");
  return membershipReceiptSchema.parse(await response.json());
}
async function problem(response: Response, status: number, code: string) {
  expect(response.status).toBe(status);
  expect(response.headers.get("cache-control")).toContain("no-store");
  expect(await response.json()).toMatchObject({ status, code });
}
const createSql = "SELECT app.create_teacher_school_membership($1::uuid,$2::uuid,$3::uuid) result";
const endSql = "SELECT app.end_teacher_school_membership($1::uuid,$2::uuid) result";
const createArgs = (key = randomUUID()) => [actors.teacher.id, actors.student.schoolId, key];
async function bind(client: PoolClient, id: string) {
  await client.query("SET LOCAL ROLE authenticated");
  await client.query("SELECT set_config('request.jwt.claim.sub',$1,true),set_config('request.jwt.claims',$2,true)",
    [id, JSON.stringify({ sub: id })]);
}
async function waitForLock(pid: number, blocker: number) {
  for (let i = 0; i < 200; i++) {
    if ((await control.query(`SELECT 1 FROM pg_stat_activity WHERE pid=$1 AND wait_event_type='Lock'
      AND $2=ANY(pg_blocking_pids(pid))`, [pid, blocker])).rowCount) return;
    await delay(20);
  }
  throw new Error("membership_expected_blocker_not_observed");
}
async function ordered(firstSql: string, firstArgs: unknown[], firstActor: string,
  nextSql: string, nextArgs: unknown[], nextActor: string) {
  const first = await runtime.connect(), next = await runtime.connect();
  let pending: Promise<QueryResult<{ result: Result }>> | undefined;
  try {
    await first.query("BEGIN"); await bind(first, firstActor);
    const blocker = (await first.query("SELECT pg_backend_pid() pid")).rows[0].pid as number;
    const a = (await first.query<{ result: Result }>(firstSql, firstArgs)).rows[0]!.result;
    await next.query("BEGIN"); await bind(next, nextActor);
    const pid = (await next.query("SELECT pg_backend_pid() pid")).rows[0].pid as number;
    pending = next.query<{ result: Result }>(nextSql, nextArgs); void pending.catch(() => undefined);
    await waitForLock(pid, blocker);
    await first.query("COMMIT");
    const b = (await pending).rows[0]!.result;
    await next.query("COMMIT"); return [a, b] as const;
  } finally {
    await first.query("ROLLBACK"); await pending?.catch(() => undefined); await next.query("ROLLBACK");
    first.release(); next.release();
  }
}
async function status(id: string) {
  const response = await review.read(request(student, "GET", `/api/v1/projects/${id}/stages/Specification/submissions`), { id });
  expect(response.status).toBe(200); return specificationStatusSchema.parse(await response.json());
}
async function submitted() {
  const response = await projects.create(request(student, "POST", "/api/v1/projects", { title: "歸屬不可變證據" }));
  expect(response.status).toBe(201); const id = (await response.json()).id as string;
  expect((await classification.save(request(student, "PUT", `/api/v1/projects/${id}/requirements`, {
    expected_requirements_revision: 0, requirements: { description: "合成靜態學習", runtime_needs: "static", runtime_ai_required: false },
  }, randomUUID(), { "if-match": '"0"' }), { id })).status).toBe(200);
  expect((await classification.confirm(request(student, "POST", `/api/v1/projects/${id}/classification/confirmation`, {
    expected_requirements_revision: 1, tier: "A", needs_visitor_identity: false, requested_tier_acknowledgement: "no_preference",
  }, randomUUID(), { "if-match": '"1"' }), { id })).status).toBe(200);
  expect((await foundation.saveStageDraft(request(student, "PUT", `/api/v1/projects/${id}/stages/Specification`,
    { content: { text: "歸屬證據合成原文" } }, randomUUID(), { "if-none-match": "*" }), id, "Specification")).status).toBe(201);
  const evidence = (await status(id)).evidence;
  const sub = await review.submit(request(student, "POST", `/api/v1/projects/${id}/stages/Specification/submissions`, {
    expected_draft_version: evidence.draft_version, expected_requirements_revision: evidence.requirements_revision,
    expected_classification_id: evidence.classification_id,
  }), { id });
  expect(sub.status).toBe(200); return { id, submission: (await sub.json()).submission_id as string };
}
beforeAll(async () => {
  if (process.env.APP_PLANET_ENV !== "isolated-local-test" || !origin) throw new Error("isolated_runner_required");
  control = openControlPool();
  runtime = new Pool({ connectionString: process.env.APP_PLANET_DATABASE_URL, max: 2, query_timeout: 15_000 });
  if (upgrade) {
    const legacy = await createReviewActors(control);
    actors = legacy;
    [admin, teacher, student] = await Promise.all([legacy.admin, legacy.teacher, legacy.student].map(loginSyntheticAccount));
    const project = await submitted();
    expect((await review.decide(request(teacher, "POST", `/api/v1/teacher/specification-submissions/${project.submission}/decision`,
      { decision: "approved", reason: null }), { id: project.submission })).status).toBe(200);
    await control.query("UPDATE app.teacher_school_memberships SET state='ended',ended_at=clock_timestamp(),ended_by_aid=$2 WHERE id=$1",
      [legacy.membership, randomUUID()]);
    const rejoined = randomUUID();
    await control.query(`INSERT INTO app.teacher_school_memberships(id,teacher_id,school_id,state,created_by_aid,created_at)
      VALUES($1,$2,$3,'active',$4,clock_timestamp())`, [rejoined, legacy.teacher.id, legacy.student.schoolId, randomUUID()]);
    const snapshotSql = `SELECT jsonb_build_object(
      'memberships',(SELECT jsonb_agg(to_jsonb(m) ORDER BY m.id) FROM app.teacher_school_memberships m WHERE teacher_id=$1),
      'bindings',(SELECT jsonb_agg(to_jsonb(b) ORDER BY b.id) FROM app.teacher_student_bindings b WHERE teacher_id=$1),
      'submissions',(SELECT jsonb_agg(to_jsonb(s) ORDER BY s.id) FROM app.specification_submissions s WHERE student_id=$2),
      'decisions',(SELECT jsonb_agg(to_jsonb(d) ORDER BY d.submission_id) FROM app.specification_decisions d WHERE teacher_id=$1)
      )::text exact_history`;
    const snapshot = await control.query(snapshotSql, [legacy.teacher.id, legacy.student.id]);
    await control.query(await readFile(new URL("../../supabase/migrations/0038_admin_teacher_school_memberships.sql", import.meta.url), "utf8"));
    expect((await control.query(snapshotSql, [legacy.teacher.id, legacy.student.id])).rows).toEqual(snapshot.rows);
    expect((await status(project.id)).latest?.state).toBe("invalidated");
    await cleanupReviewActors(control, legacy);
    console.log("MembershipUpgrade=0037_to_0038;existing_history_exactly_preserved");
  }
});
beforeEach(async () => {
  actors = await createReviewActors(control);
  await control.query("DELETE FROM app.teacher_school_memberships WHERE id=$1", [actors.membership]);
  [admin, teacher, student] = await Promise.all([actors.admin, actors.teacher, actors.student].map(loginSyntheticAccount));
});
afterEach(async () => {
  await closeServerDatabasePool();
  await control.query("ALTER TABLE app.audit_events DROP CONSTRAINT IF EXISTS membership_test_audit_failure");
  await control.query("DELETE FROM app.membership_operation_receipts WHERE actor_id=$1", [actors.admin.id]);
  await cleanupReviewActors(control, actors);
});
afterAll(async () => { await runtime?.end(); await control?.end(); });

describe("T077 真 Auth／隔離 DB 教師學校歸屬", () => {
  it("建立／結束／新 ID、多校、receipt 與 current 分離、舊 create/end replay 不影響新列", async () => {
    const key = randomUUID(), first = await receipt(await create(key));
    const independent = await receipt(await create(randomUUID(), admin, actors.teacher.id, actors.teacher.schoolId));
    await problem(await create(), 409, "membership_exists");
    const endKey = randomUUID(); await receipt(await end(first.membership_id, endKey), 200);
    const rejoined = await receipt(await create()); expect(rejoined.membership_id).not.toBe(first.membership_id);
    expect((await receipt(await create(key), 200)).membership_id).toBe(first.membership_id);
    expect((await receipt(await end(first.membership_id, endKey), 200)).membership_id).toBe(first.membership_id);
    await problem(await end(first.membership_id), 409, "membership_ended");
    await problem(await create(key, admin, actors.teacher.id, actors.teacher.schoolId), 422, "idempotency_key_reuse");
    await problem(await end(first.membership_id, key), 422, "idempotency_key_reuse");
    const rows = (await control.query("SELECT id,state,specification_review_epoch FROM app.teacher_school_memberships WHERE id=ANY($1::uuid[])",
      [[first.membership_id, rejoined.membership_id, independent.membership_id]])).rows;
    expect(rows.find((r) => r.id === first.membership_id)).toMatchObject({ state: "ended", specification_review_epoch: "1" });
    expect(rows.filter((r) => r.state === "active")).toHaveLength(2);
    const audit = (await control.query(`SELECT action,object_type,meta FROM app.audit_events
      WHERE object_ref=$1 ORDER BY at`, [first.membership_id])).rows;
    expect(audit).toEqual([
      { action: "membership_created", object_type: "membership", meta: { from_state: null, to_state: "active" } },
      { action: "membership_ended", object_type: "membership", meta: { from_state: "active", to_state: "ended" } },
    ]);
  });
  it("strict DTO／來源拒絕、非管理員／失权與偽造角色、replay 重驗", async () => {
    await problem(await memberships.create(request(null, "POST", path, {})), 401, "unauthenticated");
    await problem(await create(randomUUID(), teacher), 403, "forbidden");
    await problem(await create(randomUUID(), student), 403, "forbidden");
    await problem(await memberships.create(request(teacher, "POST", path, {
      teacher_id: actors.teacher.id, school_id: actors.student.schoolId,
    }, randomUUID(), { "x-role": "admin", "x-school-approved": "true" })), 403, "forbidden");
    await problem(await create(randomUUID(), { ...teacher, accessToken: "forged-role-admin" }), 401, "unauthenticated");
    await problem(await memberships.create(request(teacher, "POST", path, {
      teacher_id: actors.teacher.id, school_id: actors.student.schoolId, role: "admin",
    })), 400, "invalid_request");
    await problem(await memberships.create(request(admin, "POST", path, {
      teacher_id: actors.teacher.id, school_id: actors.student.schoolId, epoch: 3,
    })), 400, "invalid_request");
    await problem(await memberships.create(request(admin, "POST", path, {}, randomUUID(), { origin: "https://other.invalid" })), 403, "forbidden");
    const key = randomUUID(); await receipt(await create(key));
    await control.query("UPDATE app.profiles SET status='disabled' WHERE id=$1", [actors.admin.id]);
    await problem(await create(key), 403, "forbidden");
    await problem(await memberships.list(request(admin, "GET", `${path}?kind=schools`)), 403, "forbidden");
  });
  it.each(["pending", "disabled", "rejected", "marked"] as const)("教師 %s 新增拒絕", async (state) => {
    if (state === "marked") await control.query("UPDATE app.profiles SET deletion_state='marked' WHERE id=$1", [actors.teacher.id]);
    else await control.query("UPDATE app.profiles SET status=$2 WHERE id=$1", [actors.teacher.id, state]);
    await problem(await create(), 409, "teacher_not_eligible");
  });
  it.each(["unconfirmed", "withdrawn", "expired", "elapsed"] as const)("學校 %s 新增目前不支援；目標失效仍可結束", async (state) => {
    const created = await receipt(await create());
    await control.query("UPDATE app.profiles SET status='disabled',deletion_state='marked' WHERE id=$1", [actors.teacher.id]);
    await control.query("UPDATE app.schools SET approval_state=$2,valid_until=clock_timestamp()-interval '1 second' WHERE id=$1",
      [actors.student.schoolId, state === "elapsed" ? "approved" : state]);
    await receipt(await end(created.membership_id), 200);
    await control.query("UPDATE app.profiles SET status='approved',deletion_state='none' WHERE id=$1", [actors.teacher.id]);
    await problem(await create(), 409, "membership_school_not_supported");
  });
  it("三種穩定 ID 游標分頁／無 email、錯誤不冒充空清單", async () => {
    for (let i = 0; i < 22; i++) {
      const school = randomUUID();
      await control.query(`INSERT INTO app.schools(id,label,approval_state,approval_epoch,created_at,updated_at)
        VALUES($1,'合成分頁學校','approved',1,now(),now())`, [school]);
      await receipt(await create(randomUUID(), admin, actors.teacher.id, school));
    }
    for (const kind of ["teachers", "schools", "memberships"]) {
      let cursor: string | null = null; const ids: string[] = [];
      do {
        const response = await memberships.list(request(admin, "GET", `${path}?kind=${kind}${cursor ? `&after=${cursor}` : ""}`));
        expect(response.status).toBe(200);
        const page = membershipListSchema.parse(await response.json());
        expect(JSON.stringify(page)).not.toContain("email");
        ids.push(...page.items.map((i) => i.id)); cursor = page.next_cursor;
      } while (cursor);
      expect(ids).toEqual([...new Set(ids)].sort());
      if (kind !== "teachers") expect(ids.length).toBeGreaterThan(20);
    }
    await problem(await memberships.list(request(admin, "GET", `${path}?kind=schools&kind=teachers`)), 400, "invalid_request");
    // 本測試自己建立且無帳號指向的機構列，精確透過本 actor receipt 找出後清理。
    const extra = (await control.query(`SELECT DISTINCT intent->>'school_id' id FROM app.membership_operation_receipts
      WHERE actor_id=$1 AND intent->>'operation'='create'`, [actors.admin.id])).rows.map((r) => r.id as string);
    await control.query("DELETE FROM app.teacher_school_memberships WHERE teacher_id=$1 AND school_id=ANY($2::uuid[])", [actors.teacher.id, extra]);
    await control.query("DELETE FROM app.audit_events WHERE actor_aid IN (SELECT aid FROM app.audit_identity_map WHERE account_id=$1) AND school_id=ANY($2::uuid[])", [actors.admin.id, extra]);
    await control.query("DELETE FROM app.schools WHERE id=ANY($1::uuid[])", [extra]);
  });
  it.each(["admin", "teacher", "school"] as const)("等待 %s 真 blocker 後失權重驗", async (target) => {
    const blocker = await control.connect(), caller = await runtime.connect();
    let pending: Promise<QueryResult<{ result: Result }>> | undefined;
    try {
      await blocker.query("BEGIN");
      const blockingPid = (await blocker.query("SELECT pg_backend_pid() pid")).rows[0].pid as number;
      const id = target === "admin" ? actors.admin.id : target === "teacher" ? actors.teacher.id : actors.student.schoolId;
      await blocker.query(target === "school" ? "UPDATE app.schools SET approval_state='withdrawn' WHERE id=$1"
        : "UPDATE app.profiles SET status='disabled' WHERE id=$1", [id]);
      await caller.query("BEGIN"); await bind(caller, actors.admin.id);
      const pid = (await caller.query("SELECT pg_backend_pid() pid")).rows[0].pid as number;
      pending = caller.query(createSql, createArgs()); void pending.catch(() => undefined);
      await waitForLock(pid, blockingPid); await blocker.query("COMMIT");
      expect((await pending).rows[0]!.result.outcome).toBe(target === "admin" ? "denied"
        : target === "teacher" ? "teacher_not_eligible" : "membership_school_not_supported");
      await caller.query("COMMIT");
    } finally {
      await blocker.query("ROLLBACK"); await pending?.catch(() => undefined); await caller.query("ROLLBACK");
      blocker.release(); caller.release();
    }
  });
  it.each(["end", "list"] as const)("%s 等待管理員真 blocker 後失權重驗", async (operation) => {
    const created = await receipt(await create());
    const blocker = await control.connect(), caller = await runtime.connect();
    let pending: Promise<QueryResult<{ result: Result }>> | undefined;
    try {
      await blocker.query("BEGIN");
      const blockingPid = (await blocker.query("SELECT pg_backend_pid() pid")).rows[0].pid as number;
      await blocker.query("UPDATE app.profiles SET status='disabled' WHERE id=$1", [actors.admin.id]);
      await caller.query("BEGIN"); await bind(caller, actors.admin.id);
      const pid = (await caller.query("SELECT pg_backend_pid() pid")).rows[0].pid as number;
      pending = caller.query(operation === "end" ? endSql : "SELECT app.list_membership_options('schools',null) result",
        operation === "end" ? [created.membership_id, randomUUID()] : []);
      void pending.catch(() => undefined);
      await waitForLock(pid, blockingPid); await blocker.query("COMMIT");
      expect((await pending).rows[0]!.result.outcome).toBe("denied");
      await caller.query("COMMIT");
    } finally {
      await blocker.query("ROLLBACK"); await pending?.catch(() => undefined); await caller.query("ROLLBACK");
      blocker.release(); caller.release();
    }
    expect((await control.query("SELECT state FROM app.teacher_school_memberships WHERE id=$1", [created.membership_id])).rows[0].state).toBe("active");
  });
  it("create/create、end/end、end→create、create→end 真鎖兩種先後序", async () => {
    const [a, b] = await ordered(createSql, createArgs(), actors.admin.id, createSql, createArgs(), actors.admin.id);
    expect(a.outcome).toBe("created"); expect(b.outcome).toBe("membership_exists");
    const [c, d] = await ordered(endSql, [a.membership_id, randomUUID()], actors.admin.id,
      endSql, [a.membership_id, randomUUID()], actors.admin.id);
    expect(c.outcome).toBe("ended"); expect(d.outcome).toBe("membership_ended");
    const first = await receipt(await create());
    const [e, f] = await ordered(endSql, [first.membership_id, randomUUID()], actors.admin.id,
      createSql, createArgs(), actors.admin.id);
    expect(e.outcome).toBe("ended"); expect(f.outcome).toBe("created"); expect(f.membership_id).not.toBe(first.membership_id);
    const [g, h] = await ordered(createSql, createArgs(), actors.admin.id,
      endSql, [f.membership_id, randomUUID()], actors.admin.id);
    expect(g.outcome).toBe("membership_exists"); expect(h.outcome).toBe("ended");
  });
  it("audit 故障 rollback、固定 search_path、最小 grants 與 ended 不可復活", async () => {
    await control.query(`ALTER TABLE app.audit_events ADD CONSTRAINT membership_test_audit_failure CHECK(action<>'membership_created')`);
    await problem(await create(), 503, "operation_outcome_unknown");
    expect((await control.query("SELECT 1 FROM app.membership_operation_receipts WHERE actor_id=$1", [actors.admin.id])).rowCount).toBe(0);
    expect((await control.query("SELECT 1 FROM app.teacher_school_memberships WHERE teacher_id=$1 AND school_id=$2",
      [actors.teacher.id, actors.student.schoolId])).rowCount).toBe(0);
    await control.query("ALTER TABLE app.audit_events DROP CONSTRAINT membership_test_audit_failure");
    const first = await receipt(await create());
    await control.query(`ALTER TABLE app.audit_events ADD CONSTRAINT membership_test_audit_failure CHECK(action<>'membership_ended')`);
    await problem(await end(first.membership_id), 503, "operation_outcome_unknown");
    expect((await control.query("SELECT state,specification_review_epoch FROM app.teacher_school_memberships WHERE id=$1",
      [first.membership_id])).rows[0]).toEqual({ state: "active", specification_review_epoch: "0" });
    expect((await control.query("SELECT 1 FROM app.membership_operation_receipts WHERE actor_id=$1", [actors.admin.id])).rowCount).toBe(1);
    await control.query("ALTER TABLE app.audit_events DROP CONSTRAINT membership_test_audit_failure");
    await receipt(await end(first.membership_id), 200);
    await expect(control.query("UPDATE app.teacher_school_memberships SET state='active' WHERE id=$1", [first.membership_id])).rejects.toMatchObject({ code: "23514" });
    for (const role of ["anon", "authenticated", "service_role"]) {
      const row = (await control.query(`SELECT has_table_privilege($1,'app.teacher_school_memberships','INSERT,UPDATE,DELETE') writes,
        has_table_privilege($1,'app.membership_operation_receipts','SELECT,INSERT,UPDATE,DELETE') receipts,
        has_table_privilege($1,'app.audit_events','INSERT,UPDATE,DELETE') audit,
        has_function_privilege($1,'app.membership_audit(uuid,uuid,uuid,boolean)','EXECUTE') helper`, [role])).rows[0];
      expect(row).toEqual({ writes: false, receipts: false, audit: false, helper: false });
    }
    const funcs = (await control.query(`SELECT p.proconfig,r.rolsuper,r.rolbypassrls,r.rolcanlogin FROM pg_proc p
      JOIN pg_roles r ON r.oid=p.proowner WHERE p.oid=ANY(ARRAY[
      'app.create_teacher_school_membership(uuid,uuid,uuid)'::regprocedure,
      'app.end_teacher_school_membership(uuid,uuid)'::regprocedure])`)).rows;
    expect(funcs).toHaveLength(2);
    for (const f of funcs) expect(f).toEqual({ proconfig: ["search_path=pg_catalog"], rolsuper: false, rolbypassrls: false, rolcanlogin: false });
  });
  it.each(["reader", "decision"] as const)("%s 與收權兩種真鎖先後序；重加不復活批准／獨立學校仍有效", async (operation) => {
    const first = await receipt(await create()), p = await submitted();
    const sql = operation === "reader" ? "SELECT app.read_teacher_project($1::uuid,$2::uuid) result"
      : "SELECT app.decide_specification($1::uuid,'approved',null,$2::uuid) result";
    const args = operation === "reader" ? [actors.student.id, p.id] : [p.submission, randomUUID()];
    const [a, b] = await ordered(sql, args, actors.teacher.id, endSql,
      [first.membership_id, randomUUID()], actors.admin.id);
    expect(a.outcome).toBe(operation === "reader" ? "found" : "decided"); expect(b.outcome).toBe("ended");
    const decisions = (await control.query("SELECT to_jsonb(d)::text exact_row FROM app.specification_decisions d WHERE submission_id=$1", [p.submission])).rows;
    const newMember = await receipt(await create()); expect(newMember.membership_id).not.toBe(first.membership_id);
    if (operation === "decision") {
      expect((await status(p.id)).latest?.state).toBe("invalidated");
      expect((await control.query("SELECT to_jsonb(d)::text exact_row FROM app.specification_decisions d WHERE submission_id=$1", [p.submission])).rows).toEqual(decisions);
    }
    const [c, d] = await ordered(endSql, [newMember.membership_id, randomUUID()], actors.admin.id,
      sql, args, actors.teacher.id);
    expect(c.outcome).toBe("ended"); expect(d.outcome).toBe("not_found");
    const caller = await runtime.connect();
    try {
      await caller.query("BEGIN"); await bind(caller, actors.teacher.id);
      const independent = (await caller.query("SELECT app.read_teacher_student_projects($1::uuid,null,20) result", [actors.otherStudent.id])).rows[0].result;
      expect(independent.outcome).toBe("found");
      await caller.query("COMMIT");
    } finally { await caller.query("ROLLBACK"); caller.release(); }
  });
});
