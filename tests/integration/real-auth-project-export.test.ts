import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { projectExportSchema, type ProjectExport } from "@app-planet/core";
import { GET as exportProject } from "../../apps/web/src/app/api/v1/projects/[id]/export/route.ts";
import { createAuthPrincipalResolver, sessionCookieName } from "../../apps/web/src/server/auth-principal.ts";
import { closeServerDatabasePool, createDatabaseSession } from "../../apps/web/src/server/database-session.ts";
import { createProjectExportHandler } from "../../apps/web/src/server/project-export-handlers.ts";
import { productProjectClassificationHandlers as classification, productProjectHandlers as projects,
  productFoundationHandlers as foundation } from "../../apps/web/src/server/product-handlers.ts";
import { cleanupReviewActors, createReviewActors } from "../support/specification-review-fixture.ts";
import { loginSyntheticAccount, openControlPool, type NativeAuthSession } from "../support/real-auth-fixture.ts";

let control: Pool;
let actors: Awaited<ReturnType<typeof createReviewActors>>;
let student: NativeAuthSession, other: NativeAuthSession, teacher: NativeAuthSession, admin: NativeAuthSession;
let upgradedId: string | null = null;
const origin = process.env.APP_PLANET_APP_ORIGIN!;
const text = '已保存繁中 🚀 "引號" <script>不是程式</script> café e\u0301\n第二行';
function request(actor: NativeAuthSession | null, path: string, method = "GET", body?: unknown, extra = {}) {
  return new Request(`${origin}/api/v1/projects${path}`, {
    method,
    headers: { ...(actor ? { cookie: `${sessionCookieName}=${actor.accessToken}` } : {}),
      origin, ...(body === undefined ? {} : { "content-type": "application/json", "idempotency-key": randomUUID() }),
      ...extra },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
const download = (id: string, actor: NativeAuthSession | null = student) =>
  exportProject(request(actor, `/${id}/export`), { params: Promise.resolve({ id }) });
async function create(actor = student) {
  const r = await projects.create(request(actor, "", "POST", { title: text }));
  expect(r.status).toBe(201);
  return (await r.json()).id as string;
}
async function saveRequirements(id: string, version: number, revision: number, description: string) {
  const r = await classification.save(request(student, `/${id}/requirements`, "PUT", {
    expected_requirements_revision: revision,
    requirements: { description, runtime_needs: "static", runtime_ai_required: false },
  }, { "if-match": `"${version}"` }), { id });
  expect(r.status).toBe(200);
}
async function buildEvidence(id: string) {
  await saveRequirements(id, 0, 0, text);
  const c = await classification.confirm(request(student, `/${id}/classification/confirmation`, "POST", {
    expected_requirements_revision: 1, tier: "A", needs_visitor_identity: false,
    requested_tier_acknowledgement: "no_preference",
  }, { "if-match": '"1"' }), { id });
  expect(c.status).toBe(200);
  for (const stage of ["點子", "Specification"]) {
    const r = await foundation.saveStageDraft(request(student, `/${id}/stages/${stage}`, "PUT",
      { content: { text: `${stage} ${text}` } }, { "if-none-match": "*" }), id, stage);
    expect(r.status).toBe(201);
    const confirmed = await projects.confirmStage(request(student, `/${id}/stages/${stage}/confirmation`, "POST",
      { expected_row_version: 0 }), { projectId: id, stage });
    expect(confirmed.status).toBe(201);
  }
  const imported = await projects.importTasks(request(student, `/${id}/tasks`, "POST", {
    confirmed: true, tasks: [{ title: "繁中 🚀 任務" }, { title: '<h1>"原文"</h1>' }],
  }), { projectId: id });
  expect(imported.status).toBe(201);
  const tasks = (await imported.json()).tasks;
  const done = await projects.patchTaskDone(request(student, `/${id}/tasks/${tasks[0].id}`, "PATCH",
    { done: true }, { "if-match": '"0"' }), { projectId: id, taskId: tasks[0].id });
  expect(done.status).toBe(200);
}
async function snapshot(id: string) {
  const values: unknown[] = [];
  for (const [table, predicate, order] of [
    ["projects", "id=$1", "id"],
    ["project_requirements", "project_id=$1", "revision"],
    ["project_classification_confirmations", "project_id=$1", "id"],
    ["stage_records", "project_id=$1", "stage"],
    ["stage_draft_confirmations", "project_id=$1", "stage,record_row_version"],
    ["tasks", "project_id=$1", '"order",id'],
    ["project_classification_idempotency", "project_id=$1", "idempotency_key"],
    ["stage_draft_idempotency", "project_id=$1", "idempotency_key"],
    ["project_task_imports", "project_id=$1", "idempotency_key"],
    ["project_create_idempotency", "project_id=$1", "idempotency_key"],
    ["project_rename_receipts", "project_id=$1", "idempotency_key"],
  ]) {
    values.push((await control.query(`SELECT to_jsonb(r) AS row FROM app.${table} r WHERE ${predicate} ORDER BY ${order}`, [id])).rows);
  }
  values.push((await control.query("SELECT count(*)::int AS count FROM app.audit_events")).rows);
  return values;
}
async function body(id: string): Promise<ProjectExport> {
  const r = await download(id);
  expect(r.status).toBe(200);
  expect(r.headers.get("cache-control")).toBe("no-store");
  const bytes = new Uint8Array(await r.arrayBuffer());
  expect(Number(r.headers.get("content-length"))).toBe(bytes.byteLength);
  return projectExportSchema.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
}
async function waitForLock() {
  for (let i = 0; i < 120; i++) {
    const r = await control.query(`SELECT count(*)::int AS count FROM pg_stat_activity
      WHERE query LIKE 'SELECT app.read_saved_project_export%' AND cardinality(pg_blocking_pids(pid)) > 0`);
    if (r.rows[0].count > 0) return;
    await delay(25);
  }
  throw Error("未觀測到真下載等待鎖");
}
beforeAll(async () => {
  if (process.env.APP_PLANET_ENV !== "isolated-local-test") throw Error("isolated runner required");
  control = openControlPool();
  actors = await createReviewActors(control);
  [student, other, teacher, admin] = await Promise.all(
    [actors.student, actors.otherStudent, actors.teacher, actors.admin].map(loginSyntheticAccount));
  if (process.env.APP_PLANET_TEST_MIGRATE_THROUGH === "0038") {
    upgradedId = await create();
    await buildEvidence(upgradedId);
    const before = await snapshot(upgradedId);
    await control.query(await readFile(new URL("../../supabase/migrations/0039_saved_project_export.sql", import.meta.url), "utf8"));
    expect(await snapshot(upgradedId)).toEqual(before);
  }
});
afterAll(async () => {
  await closeServerDatabasePool();
  if (actors) {
    const ids = [actors.student.id, actors.otherStudent.id];
    for (const table of ["project_task_imports", "tasks"]) {
      await control.query(`DELETE FROM app.${table} WHERE project_id IN (SELECT id FROM app.projects WHERE owner_id=ANY($1::uuid[]))`, [ids]);
    }
    await cleanupReviewActors(control, actors);
  }
  await control.end();
});

describe("T025 本人已保存資料真 Auth／正式 HTTP／隔離 PostgreSQL", () => {
  it("新庫／0038→0039：產品 handler 寫入，逐欄讀回、無本文 audit、下載前後全資料不變", async () => {
    const id = upgradedId ?? await create();
    if (!upgradedId) await buildEvidence(id);
    const before = await snapshot(id);
    const result = await body(id);
    const p = (await control.query("SELECT id,title,stage,row_version FROM app.projects WHERE id=$1", [id])).rows[0];
    expect(result.project).toEqual(p);
    expect(result.requirements).toEqual({ revision: 1,
      content: { description: text, runtime_needs: "static", runtime_ai_required: false } });
    expect(result.classification).toMatchObject({ classification_state: "confirmed", tier: "A",
      needs_visitor_identity: false, confirmation_validity: "valid",
      confirmation: { requirements_revision: 1, source: "student_explicit_confirmation" } });
    const c = (await control.query(`SELECT id,requirements_revision,
      to_char(confirmed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS confirmed_at,source
      FROM app.project_classification_confirmations WHERE project_id=$1`, [id])).rows[0];
    expect(result.classification.confirmation).toEqual(c);
    for (const s of result.stages) {
      const d = (await control.query("SELECT row_version,state,content_source,content FROM app.stage_records WHERE project_id=$1 AND stage=$2", [id, s.stage])).rows[0];
      expect(s.draft).toEqual(d ?? null);
      const confirmation = (await control.query(`SELECT record_row_version AS row_version,
        to_char(confirmed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS confirmed_at,source
        FROM app.stage_draft_confirmations WHERE project_id=$1 AND stage=$2 ORDER BY record_row_version DESC LIMIT 1`, [id, s.stage])).rows[0];
      expect(s.confirmation).toEqual(confirmation ? { ...confirmation, current: true } : null);
    }
    expect(result.tasks).toEqual((await control.query('SELECT id,project_id,"order",title,done,row_version FROM app.tasks WHERE project_id=$1 ORDER BY "order",id', [id])).rows);
    expect(result.tasks[0]).toMatchObject({ done: true, row_version: 1 });
    expect(Date.parse(result.read_at)).toBeLessThanOrEqual(Date.now() + 1000);
    expect(await snapshot(id)).toEqual(before);
  });
  it("無保存內容明示 null；後續保存使舊階段確認失效，保留原文與版本", async () => {
    const id = await create();
    let result = await body(id);
    expect(result.requirements).toBeNull();
    expect(result.stages.every((s) => s.draft === null && s.confirmation === null)).toBe(true);
    expect(result.tasks).toEqual([]);
    await buildEvidence(id);
    const r = await foundation.saveStageDraft(request(student, `/${id}/stages/Specification`, "PUT",
      { content: { text: "新草稿 🚀" } }, { "if-match": '"0"' }), id, "Specification");
    expect(r.status).toBe(200);
    result = await body(id);
    expect(result.stages.find((s) => s.stage === "Specification")).toMatchObject({
      draft: { row_version: 1, content: { text: "新草稿 🚀" } }, confirmation: { row_version: 0, current: false },
    });
  });
  it("真另一學生既存專案與有效教師／管理員均 404，不接受自報身分；無效 Auth 401", async () => {
    const mine = await create(), theirs = await create(other);
    for (const [actor, id] of [[other, mine], [student, theirs], [teacher, mine], [admin, mine],
      [teacher, randomUUID()], [admin, randomUUID()], [student, randomUUID()]] as const) {
      const r = await download(id, actor);
      expect(r.status).toBe(404);
      expect(r.headers.get("content-disposition")).toBeNull();
      expect(JSON.stringify(await r.json())).not.toContain(text);
    }
    expect((await download(mine, null)).status).toBe(401);
    expect((await download(mine, { ...student, accessToken: "invalid-session" })).status).toBe(401);
  });
  it("account／school 能力矩陣，撤回／失效可下載而 AI／部署仍關閉", async () => {
    const id = await create();
    try {
      for (const status of ["pending", "rejected", "disabled"]) {
        await control.query("UPDATE app.profiles SET status=$2 WHERE id=$1", [actors.student.id, status]);
        expect((await download(id)).status).toBe(403);
      }
      await control.query("UPDATE app.profiles SET status='approved' WHERE id=$1", [actors.student.id]);
      for (const deletion of ["marked", "purging", "purge_failed", "purged"]) {
        await control.query("UPDATE app.profiles SET deletion_state=$2 WHERE id=$1", [actors.student.id, deletion]);
        expect((await download(id)).status).toBe(403);
      }
      await control.query("UPDATE app.profiles SET deletion_state='none' WHERE id=$1", [actors.student.id]);
      for (const state of ["unconfirmed", "approved", "withdrawn", "expired"]) {
        await control.query("UPDATE app.schools SET approval_state=$2,valid_until=NULL WHERE id=$1", [actors.student.schoolId, state]);
        expect((await download(id)).status).toBe(state === "unconfirmed" ? 403 : 200);
        if (state === "withdrawn" || state === "expired") {
          const gates = await createDatabaseSession(actors.student.id).read.runReadOnly((q) => q.query(
            "SELECT app.current_account_gate('ai_call') AS ai,app.current_account_gate('public_deploy') AS deploy"));
          expect(gates.rows[0]).toEqual({ ai: false, deploy: false });
        }
      }
      await control.query("UPDATE app.schools SET approval_state='approved',valid_until=now()-interval '1 day' WHERE id=$1", [actors.student.schoolId]);
      expect((await download(id)).status).toBe(200);
    } finally {
      await control.query("UPDATE app.profiles SET status='approved',deletion_state='none' WHERE id=$1", [actors.student.id]);
      await control.query("UPDATE app.schools SET approval_state='approved',valid_until=NULL WHERE id=$1", [actors.student.schoolId]);
    }
  });
  it("真 profile／school／project 等鎖失權先提交：等待中的下載拒絕，沒有保護內容", async () => {
    const id = await create();
    for (const table of ["profiles", "schools", "projects"] as const) {
      const blocker = await control.connect();
      let work: Promise<Response> | null = null;
      try {
        await blocker.query("BEGIN");
        if (table === "projects") {
          await blocker.query("UPDATE app.projects SET owner_id=$2 WHERE id=$1", [id, actors.otherStudent.id]);
        } else {
          await blocker.query(table === "profiles" ? "UPDATE app.profiles SET status='disabled' WHERE id=$1"
            : "UPDATE app.schools SET approval_state='unconfirmed' WHERE id=$1",
          [table === "profiles" ? actors.student.id : actors.student.schoolId]);
        }
        work = download(id);
        await waitForLock();
        await blocker.query("COMMIT");
        const r = await work;
        expect(r.status).toBe(table === "projects" ? 404 : 403);
        expect(r.headers.get("content-disposition")).toBeNull();
        expect(JSON.stringify(await r.json())).not.toContain(text);
      } finally {
        await blocker.query("ROLLBACK");
        blocker.release();
        await work;
        await control.query("UPDATE app.profiles SET status='approved' WHERE id=$1", [actors.student.id]);
        await control.query("UPDATE app.schools SET approval_state='approved' WHERE id=$1", [actors.student.schoolId]);
        await control.query("UPDATE app.projects SET owner_id=$2 WHERE id=$1", [id, actors.student.id]);
      }
    }
  });
  it("並行真保存只得完整舊或新 statement，不能新版需求配舊有效分類", async () => {
    const id = await create();
    await buildEvidence(id);
    const work = saveRequirements(id, 2, 1, "並行新版需求");
    const downloads = await Promise.all(Array.from({ length: 8 }, () => body(id)));
    await work;
    for (const result of downloads) {
      if (result.requirements?.revision === 1) {
        expect(result.requirements.content.description).toBe(text);
        expect(result.classification.confirmation_validity).toBe("valid");
      } else {
        expect(result.requirements).toMatchObject({ revision: 2, content: { description: "並行新版需求" } });
        expect(result.classification).toMatchObject({ classification_state: "unconfirmed",
          confirmation: null, confirmation_validity: "not_confirmed" });
      }
    }
    expect((await body(id)).requirements?.revision).toBe(2);
  });
  it("真 Auth 故障、DB SQL 故障與 decoder 故障拒絕，無成功檔案或部分內容", async () => {
    const id = await create();
    const before = await snapshot(id);
    const authFailure = createProjectExportHandler({
      resolver: createAuthPrincipalResolver(process.env, async () => { throw new TypeError("synthetic Auth failure"); }),
    });
    expect((await authFailure(request(student, `/${id}/export`), { id })).status).toBe(503);
    for (const corrupt of [false, true]) {
      const trusted = createAuthPrincipalResolver();
      const handler = createProjectExportHandler({ resolver: { resolve: async (r) => {
        const principal = await trusted.resolve(r);
        if (!principal.ok) return principal;
        return { ...principal, session: { ...principal.session, write: { runTransaction: (operation) =>
          principal.session.write.runTransaction((q) => operation({ query: async (sql, values) => {
            const result = await q.query(corrupt ? sql : "SELECT missing_export_dependency()", values);
            return corrupt ? { rows: [{ result: { outcome: "found", data: {} } }] } : result;
          } })) } } };
      } } });
      const r = await handler(request(student, `/${id}/export`), { id });
      expect(r.status).toBe(503);
      expect(r.headers.get("content-type")).toBe("application/problem+json");
      expect(r.headers.get("content-disposition")).toBeNull();
    }
    expect(await snapshot(id)).toEqual(before);
  });
  it("超過有界組裝明確拒絕，沒有截斷；reader 無寫入／私有欄位／role 切換權限", async () => {
    const id = await create();
    await saveRequirements(id, 0, 0, text);
    const titleBytes = (await control.query("SELECT octet_length(to_jsonb(title)::text) AS bytes FROM app.projects WHERE id=$1", [id])).rows[0].bytes as number;
    const boundaryText = "x".repeat(8 * 1024 * 1024 - 4096 - titleBytes - 2);
    await control.query(`INSERT INTO app.project_requirements
      (project_id,revision,description,runtime_needs,runtime_ai_required,created_by,created_at)
      VALUES ($1,2,$2,'static',false,$3,now())`, [id, boundaryText, actors.student.id]);
    await control.query("UPDATE app.projects SET requirements_revision=2 WHERE id=$1", [id]);
    expect((await body(id)).requirements?.content.description.length).toBe(boundaryText.length);
    await control.query(`INSERT INTO app.project_requirements
      (project_id,revision,description,runtime_needs,runtime_ai_required,created_by,created_at)
      VALUES ($1,3,$2,'static',false,$3,now())`, [id, boundaryText + "x", actors.student.id]);
    await control.query("UPDATE app.projects SET requirements_revision=3 WHERE id=$1", [id]);
    const r = await download(id);
    expect(r.status).toBe(413);
    expect(r.headers.get("content-disposition")).toBeNull();
    const privileges = (await control.query(`SELECT
      has_table_privilege('app_saved_project_export_reader','app.projects','INSERT') AS insert_project,
      has_column_privilege('app_saved_project_export_reader','app.projects','title','UPDATE') AS update_title,
      has_column_privilege('app_saved_project_export_reader','app.profiles','display_label','SELECT') AS private_profile,
      has_table_privilege('app_saved_project_export_reader','app.audit_events','INSERT') AS audit_write,
      has_table_privilege('app_saved_project_export_reader','app.stage_records','UPDATE') AS draft_write,
      pg_has_role('authenticated','app_saved_project_export_reader','MEMBER') AS member,
      (SELECT rolbypassrls OR rolsuper OR rolcanlogin FROM pg_roles WHERE rolname='app_saved_project_export_reader') AS elevated,
      (SELECT count(*)::int FROM information_schema.tables WHERE table_schema='app' AND table_name LIKE '%export%') AS export_tables`)).rows[0];
    expect(privileges).toEqual({ insert_project: false, update_title: false, private_profile: false,
      audit_write: false, draft_write: false, member: false, elevated: false, export_tables: 0 });
    const q = await control.connect();
    try {
      await q.query("BEGIN");
      await q.query("SET LOCAL ROLE app_saved_project_export_reader");
      await q.query("SELECT set_config('request.jwt.claim.sub',$1,true)", [actors.student.id]);
      await expect(q.query("UPDATE app.profiles SET id=id WHERE id=$1 RETURNING id", [actors.student.id]))
        .rejects.toMatchObject({ code: "42501" });
    } finally { await q.query("ROLLBACK"); q.release(); }
  });
});
