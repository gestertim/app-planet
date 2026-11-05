import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { Pool } from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";
import { teacherViewAuditPageSchema } from "@app-planet/core";
import { sessionCookieName } from "../../apps/web/src/server/auth-principal.ts";
import { closeServerDatabasePool, createDatabaseSession } from "../../apps/web/src/server/database-session.ts";
import {
  productBindingHandlers as bindings, productTeacherResourceHandlers as teacherReads,
  productTeacherViewAuditHandler as audit, productProjectHandlers as projects,
} from "../../apps/web/src/server/product-handlers.ts";
import {
  createSyntheticAuthAccount, deleteSyntheticAuthAccount, loginSyntheticAccount, openControlPool,
  type NativeAuthSession, type SyntheticAuthAccount,
} from "../support/real-auth-fixture.ts";

type Actor = SyntheticAuthAccount & { session: NativeAuthSession };
const accounts: Actor[] = [];
const projectIds: string[] = [];
const eventIds: string[] = [];
const origin = process.env.APP_PLANET_APP_ORIGIN!;
let control: Pool;
let admin: Actor, teacherA: Actor, teacherB: Actor, studentA: Actor, studentB: Actor;
const path = "/api/v1/admin/audit/teacher-views";
async function actor(role: "student" | "teacher" | "admin", label: string): Promise<Actor> {
  const account = await createSyntheticAuthAccount(control, label);
  if (role !== "student") await control.query("UPDATE app.profiles SET role=$2 WHERE id=$1", [account.id, role]);
  const result = { ...account, session: await loginSyntheticAccount(account) };
  accounts.push(result);
  return result;
}
function request(who: Actor | null, url = path, method = "GET", body?: unknown) {
  return new Request(origin + url, { method, headers: {
    ...(who ? { cookie: `${sessionCookieName}=${who.session.accessToken}` } : {}),
    origin, "sec-fetch-site": "same-origin", "content-type": "application/json", "idempotency-key": randomUUID(),
  }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
async function page(query = "", who = admin) {
  const response = await audit(request(who, `${path}${query ? `?${query}` : ""}`));
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toContain("no-store");
  return teacherViewAuditPageSchema.parse(await response.json());
}
async function problem(who: Actor | null, query: string, status: number) {
  const response = await audit(request(who, `${path}?${query}`));
  expect(response.status).toBe(status);
  expect(response.headers.get("content-type")).toContain("application/problem+json");
  expect(response.headers.get("cache-control")).toContain("no-store");
  const body = await response.text();
  for (const forbidden of ["teacher_label", "student_label", "items", teacherA.email, studentA.id]) {
    expect(body).not.toContain(forbidden);
  }
}
async function snapshot() {
  const ids = accounts.map((a) => a.id);
  return (await control.query(`SELECT
    (SELECT coalesce(jsonb_agg(to_jsonb(e) ORDER BY e.id),'[]') FROM app.audit_events e) audits,
    (SELECT coalesce(jsonb_agg(to_jsonb(m) ORDER BY m.aid),'[]') FROM app.audit_identity_map m) identities,
    (SELECT coalesce(jsonb_agg(to_jsonb(b) ORDER BY b.id),'[]') FROM app.teacher_student_bindings b) bindings,
    (SELECT coalesce(jsonb_agg(to_jsonb(p) ORDER BY p.id),'[]') FROM app.projects p WHERE owner_id=ANY($1::uuid[])) projects,
    (SELECT coalesce(jsonb_agg(to_jsonb(p) ORDER BY p.id),'[]') FROM app.profiles p WHERE id=ANY($1::uuid[])) profiles`,
  [ids])).rows[0];
}
beforeAll(async () => {
  if (process.env.APP_PLANET_ENV !== "isolated-local-test" || !origin) throw new Error("isolated runner required");
  control = openControlPool();
  [admin, teacherA, teacherB, studentA, studentB] = await Promise.all([
    actor("admin", "稽核管理"), actor("teacher", "教師甲"), actor("teacher", "教師乙"),
    actor("student", "學生甲"), actor("student", "學生乙"),
  ]);
});
afterAll(async () => {
  await closeServerDatabasePool();
  const ids = accounts.map((a) => a.id);
  await control.query("DELETE FROM app.binding_operation_receipts WHERE actor_id=ANY($1::uuid[])", [ids]);
  await control.query("DELETE FROM app.project_create_idempotency WHERE project_id=ANY($1::uuid[])", [projectIds]);
  await control.query("DELETE FROM app.projects WHERE id=ANY($1::uuid[])", [projectIds]);
  await control.query("DELETE FROM app.teacher_student_bindings WHERE teacher_id=ANY($1::uuid[]) OR student_id=ANY($1::uuid[])", [ids]);
  await control.query("DELETE FROM app.teacher_school_memberships WHERE teacher_id=ANY($1::uuid[])", [ids]);
  await control.query(`DELETE FROM app.audit_events WHERE id=ANY($1::uuid[]) OR actor_aid IN
    (SELECT aid FROM app.audit_identity_map WHERE account_id=ANY($2::uuid[])) OR subject_aid IN
    (SELECT aid FROM app.audit_identity_map WHERE account_id=ANY($2::uuid[]))`, [eventIds, ids]);
  await control.query("DELETE FROM app.audit_identity_map WHERE account_id=ANY($1::uuid[])", [ids]);
  await control.query("DELETE FROM app.profiles WHERE id=ANY($1::uuid[])", [ids]);
  await control.query("DELETE FROM app.schools WHERE id=ANY($1::uuid[])", [accounts.map((a) => a.schoolId)]);
  for (const a of accounts) await deleteSyntheticAuthAccount(a);
  await control.end();
  console.log("TeacherViewAuditCleanup=verified owned synthetic data removed");
});

it("T-5 真 Auth／DB：正式教師 reader 事件、歷史核對、strict 分頁／拒絕、鎖障壁及最小權限", async () => {
  const bindingIds: string[] = [];
  for (const [teacher, student] of [[teacherA, studentA], [teacherB, studentB], [teacherA, studentB]] as const) {
    await control.query(`INSERT INTO app.teacher_school_memberships
      (id,teacher_id,school_id,state,created_by_aid,created_at) VALUES($1,$2,$3,'active',$4,now())`,
    [randomUUID(), teacher.id, student.schoolId, randomUUID()]);
    const linked = await bindings.create(request(admin, "/api/v1/admin/bindings", "POST",
      { teacher_id: teacher.id, student_id: student.id }));
    expect(linked.status).toBe(201);
    bindingIds.push((await linked.json()).binding_id as string);
    const created = await projects.create(request(student, "/api/v1/projects", "POST", { title: "不得進入稽核 DTO 的專案本文" }));
    expect(created.status).toBe(201);
    const project = (await created.json()).id as string;
    projectIds.push(project);
    expect((await teacherReads.project(request(teacher,
      `/api/v1/teacher/students/${student.id}/projects/${project}`),
    { studentId: student.id, projectId: project })).status).toBe(200);
  }
  // On upgrade runs, these are real 0034 reader events existing before 0035 is applied.
  const beforeMigration = await snapshot();
  if (process.env.APP_PLANET_TEST_MIGRATE_THROUGH === "0034") {
    await control.query(await readFile(new URL("../../supabase/migrations/0035_admin_teacher_view_audit.sql", import.meta.url), "utf8"));
    expect(await snapshot()).toEqual(beforeMigration);
    console.log("Upgrade0034to0035=historical events, mappings, profiles, projects and bindings preserved");
  }
  const beforeReads = await snapshot();
  expect((await page()).items).toHaveLength(3);
  expect((await page(`teacher_id=${teacherA.id}`)).items).toHaveLength(2);
  expect((await page(`student_id=${studentB.id}`)).items).toHaveLength(2);
  expect((await page(`teacher_id=${teacherA.id}&student_id=${studentB.id}`)).items).toHaveLength(1);
  expect((await page(`teacher_id=${teacherB.id}&student_id=${studentA.id}`)).items).toEqual([]);
  expect(await snapshot()).toEqual(beforeReads);
  const ended = await bindings.end(request(admin, `/api/v1/admin/bindings/${bindingIds[0]}`, "DELETE",
    { end_reason: "合成歷史核對解除" }), { id: bindingIds[0] });
  expect(ended.status).toBe(200);
  expect((await page(`teacher_id=${teacherA.id}&student_id=${studentA.id}`)).items).toHaveLength(1);
  expect((await teacherReads.project(request(teacherA,
    `/api/v1/teacher/students/${studentA.id}/projects/${projectIds[0]}`),
  { studentId: studentA.id, projectId: projectIds[0] })).status).toBe(404);

  const rawEvents = await control.query(`SELECT id,actor_aid,subject_aid FROM app.audit_events
    WHERE action='teacher_view' ORDER BY id LIMIT 1`);
  const base = rawEvents.rows[0] as { id: string; actor_aid: string; subject_aid: string };
  for (let n = 0; n < 55; n++) {
    const id = randomUUID();
    eventIds.push(id);
    await control.query(`INSERT INTO app.audit_events(id,at,actor_aid,subject_aid,action,object_type,result,meta)
      VALUES($1,'2026-01-01T00:00:00.123456Z',$2,$3,'teacher_view','project','ok','{}')`,
    [id, base.actor_aid, base.subject_aid]);
  }
  const unchanged = await snapshot();
  const expected = (await control.query(`SELECT id FROM app.audit_events WHERE action='teacher_view' ORDER BY at DESC,id DESC`))
    .rows.map((r: { id: string }) => r.id);
  const seen: string[] = [];
  let after: string | null = null;
  let count = 0;
  do {
    const p = await page(`limit=7${after ? `&after=${after}` : ""}`);
    count += p.items.length;
    after = p.next_cursor;
    if (after) {
      const position = JSON.parse(Buffer.from(after, "base64url").toString("utf8")).position as { id: string };
      seen.push(position.id);
      expect(position.id).toBe(expected[count - 1]);
    }
    expect(JSON.stringify(p)).not.toContain("不得進入");
    for (const item of p.items) expect(Object.keys(item).sort()).toEqual(["student_label", "teacher_label", "viewed_at"]);
  } while (after);
  expect(count).toBe(expected.length);
  expect(new Set(seen).size).toBe(seen.length);
  // Check every row boundary with page size 1, including all same-time rows.
  const exact: string[] = [];
  after = null;
  do {
    const p = await page(`limit=1${after ? `&after=${after}` : ""}`);
    after = p.next_cursor;
    if (after) exact.push(JSON.parse(Buffer.from(after, "base64url").toString("utf8")).position.id as string);
  } while (after);
  expect(exact).toEqual(expected.slice(0, -1));
  expect(await snapshot()).toEqual(unchanged);

  for (const who of [teacherA, studentA]) {
    await problem(who, `teacher_id=${teacherA.id}`, 403);
    await problem(who, "teacher_id=bad&unknown=x", 403);
  }
  await problem(null, "teacher_id=bad", 401);
  for (const status of ["pending", "rejected", "disabled"]) {
    await control.query("UPDATE app.profiles SET status=$2 WHERE id=$1", [admin.id, status]);
    await problem(admin, `teacher_id=${teacherA.id}`, 403);
    await problem(admin, "teacher_id=bad", 403);
  }
  await control.query("UPDATE app.profiles SET status='approved' WHERE id=$1", [admin.id]);
  for (const state of ["marked", "purging", "purge_failed", "purged"]) {
    await control.query("UPDATE app.profiles SET deletion_state=$2 WHERE id=$1", [admin.id, state]);
    await problem(admin, `student_id=${studentA.id}`, 403);
    await problem(admin, "student_id=bad", 403);
  }
  await control.query("UPDATE app.profiles SET deletion_state='none' WHERE id=$1", [admin.id]);
  for (const query of ["teacher_id=bad", "limit=51", `teacher_id=${teacherA.id}&teacher_id=${teacherA.id}`,
    "unknown=1", "after=e30"]) await problem(admin, query, 400);
  const filtered = await page(`teacher_id=${teacherA.id}&limit=1`);
  expect(filtered.next_cursor).not.toBeNull();
  const filteredNext = await page(`teacher_id=${teacherA.id}&limit=1&after=${filtered.next_cursor}`);
  expect(filteredNext.items).toHaveLength(1);
  expect(filteredNext.items[0].teacher_label).toBe("合成帳號教師甲");
  await problem(admin, `teacher_id=${teacherB.id}&after=${filtered.next_cursor}`, 400);

  const blocker = await control.connect();
  try {
    await blocker.query("BEGIN");
    const blockerPid = (await blocker.query("SELECT pg_backend_pid() AS pid")).rows[0].pid as number;
    await blocker.query("UPDATE app.profiles SET status='disabled' WHERE id=$1", [admin.id]);
    const pending = audit(request(admin));
    let waiting = false;
    for (let n = 0; n < 150; n++) {
      const lock = await control.query(`SELECT 1 FROM pg_stat_activity WHERE application_name='app-planet-web'
        AND wait_event_type='Lock' AND query LIKE '%read_admin_teacher_views%'
        AND $1=ANY(pg_blocking_pids(pid))`, [blockerPid]);
      if (lock.rowCount) { waiting = true; break; }
      await delay(20);
    }
    expect(waiting).toBe(true);
    await blocker.query("COMMIT");
    const denied = await pending;
    expect(denied.status).toBe(403);
    expect(await denied.text()).not.toContain("items");
  } finally { await blocker.query("ROLLBACK"); blocker.release(); }
  await control.query("UPDATE app.profiles SET status='approved' WHERE id=$1", [admin.id]);

  const session = createDatabaseSession(admin.id);
  for (const table of ["audit_events", "audit_identity_map"]) {
    await expect(session.read.runReadOnly((q) => q.query(`SELECT * FROM app.${table}`))).rejects.toThrow();
  }
  const privileges = (await control.query(`SELECT
    has_table_privilege('authenticated','app.audit_events','SELECT') event_select,
    has_table_privilege('authenticated','app.audit_identity_map','SELECT') identity_select,
    pg_has_role('authenticated','app_teacher_view_audit_reader','MEMBER') reader_member,
    has_function_privilege('anon','app.read_admin_teacher_views(uuid,uuid,timestamptz,uuid,integer,boolean)','EXECUTE') anon_execute,
    has_function_privilege('service_role','app.read_admin_teacher_views(uuid,uuid,timestamptz,uuid,integer,boolean)','EXECUTE') service_execute`)).rows[0];
  expect(Object.values(privileges)).toEqual([false, false, false, false, false]);
  const functionShape = (await control.query(`SELECT p.prosecdef, p.proconfig,
    r.rolname, r.rolcanlogin, r.rolsuper, r.rolbypassrls FROM pg_proc p
    JOIN pg_roles r ON r.oid=p.proowner WHERE p.oid=
    'app.read_admin_teacher_views(uuid,uuid,timestamptz,uuid,integer,boolean)'::regprocedure`)).rows[0];
  expect(functionShape).toEqual({ prosecdef: true, proconfig: ["search_path=pg_catalog"],
    rolname: "app_teacher_view_audit_reader", rolcanlogin: false, rolsuper: false, rolbypassrls: false });

  // Missing mappings are a policy gap, never replaced with an internal UUID or silently omitted.
  const map = (await control.query("SELECT * FROM app.audit_identity_map WHERE aid=$1", [base.subject_aid])).rows[0];
  await control.query("DELETE FROM app.audit_identity_map WHERE aid=$1", [base.subject_aid]);
  await problem(admin, "", 503);
  await problem(admin, `teacher_id=${teacherB.id}`, 503);
  await control.query("INSERT INTO app.audit_identity_map(aid,account_id,created_at) VALUES($1,$2,$3)",
    [map.aid, map.account_id, map.created_at]);
  expect((await page()).items.length).toBe(20);
  await control.query("DELETE FROM app.binding_operation_receipts WHERE actor_id=$1", [admin.id]);
  const profile = (await control.query("SELECT * FROM app.profiles WHERE id=$1", [admin.id])).rows[0];
  await control.query("DELETE FROM app.audit_identity_map WHERE account_id=$1", [admin.id]);
  await control.query("DELETE FROM app.profiles WHERE id=$1", [admin.id]);
  await problem(admin, `student_id=${studentA.id}`, 403);
  await problem(admin, "student_id=bad", 403);
  await control.query(`INSERT INTO app.profiles(id,role,status,deletion_state,school_id,display_label,status_changed_at)
    VALUES($1,'admin','approved','none',$2,$3,now())`, [admin.id, profile.school_id, profile.display_label]);
  console.log("TeacherViewAudit=filters;stable_microsecond_pages;historical_unbound;no_writes;roles;lock_revocation;grants;missing_map_fail_closed");
});
