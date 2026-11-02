import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeServerDatabasePool, createDatabaseSession } from "../../apps/web/src/server/database-session.ts";
import { sessionCookieName } from "../../apps/web/src/server/auth-principal.ts";
import { PUT as saveDraftRoute } from "../../apps/web/src/app/api/v1/projects/[id]/stages/[stage]/route.ts";
import {
  GET as statusRoute, POST as confirmRoute,
} from "../../apps/web/src/app/api/v1/projects/[id]/stages/[stage]/confirmation/route.ts";
import { POST as importTasksRoute } from "../../apps/web/src/app/api/v1/projects/[id]/tasks/route.ts";
import { PATCH as patchTaskDone } from "../../apps/web/src/app/api/v1/projects/[id]/tasks/[tid]/route.ts";
import {
  closeSyntheticWorkerPool, createOwnedSyntheticProject, createSyntheticAuthAccount,
  deleteSyntheticAuthAccount, loginSyntheticAccount, openControlPool,
  type NativeAuthSession, type SyntheticAuthAccount,
} from "../support/real-auth-fixture.ts";

// 0024 既有資料 → 只套用 0025 的升級驗收；runner 以 APP_PLANET_TEST_MIGRATE_THROUGH=0024 準備 DB。
const appOrigin = process.env.APP_PLANET_APP_ORIGIN!;
const sha = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
const accounts: SyntheticAuthAccount[] = [];
const projectIds: string[] = [];
let control!: Pool;
let owner: SyntheticAuthAccount;
let other: SyntheticAuthAccount;
let ownerSession: NativeAuthSession;
let otherSession: NativeAuthSession;

function req(path: string, method: string, session: NativeAuthSession | undefined,
  headers: Record<string, string>, body?: unknown): Request {
  const h = new Headers(headers);
  if (session) h.set("cookie", `${sessionCookieName}=${session.accessToken}`);
  h.set("origin", appOrigin);
  if (body !== undefined) h.set("content-type", "application/json");
  return new Request(`${appOrigin}${path}`, { method, headers: h, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
const stagePath = (project: string, stage: string) => `/api/v1/projects/${project}/stages/${encodeURIComponent(stage)}`;
const save = (project: string, stage: string, text: string, version: number | null, session = ownerSession) =>
  saveDraftRoute(req(stagePath(project, stage), "PUT", session, {
    "idempotency-key": randomUUID(),
    ...(version === null ? { "if-none-match": "*" } : { "if-match": `"${version}"` }),
  }, { content: { text } }), { params: Promise.resolve({ id: project, stage }) });
const confirm = (project: string, stage: string, version: number, session = ownerSession) =>
  confirmRoute(req(`${stagePath(project, stage)}/confirmation`, "POST", session, { "idempotency-key": randomUUID() },
    { expected_row_version: version }), { params: Promise.resolve({ id: project, stage }) });
const status = async (project: string, stage: string, session = ownerSession) => {
  const response = await statusRoute(req(`${stagePath(project, stage)}/confirmation`, "GET", session, {}),
    { params: Promise.resolve({ id: project, stage }) });
  return { http: response.status, body: await response.json().catch(() => null) };
};
const importTasks = (project: string, titles: string[]) => importTasksRoute(
  req(`/api/v1/projects/${project}/tasks`, "POST", ownerSession, { "idempotency-key": randomUUID() },
    { confirmed: true, tasks: titles.map((title) => ({ title })) }),
  { params: Promise.resolve({ id: project }) });
const markDone = (project: string, taskId: string, version: number) => patchTaskDone(
  req(`/api/v1/projects/${project}/tasks/${taskId}`, "PATCH", ownerSession, { "if-match": `"${version}"` }, { done: true }),
  { params: Promise.resolve({ id: project, tid: taskId }) });

const dataTables = ["projects", "stage_records", "stage_draft_idempotency", "tasks", "project_task_imports", "project_create_idempotency"];
async function dataBaseline(): Promise<Record<string, unknown[]>> {
  const result: Record<string, unknown[]> = {};
  for (const table of dataTables) {
    const exists = (await control.query("SELECT to_regclass($1)::text AS n", [`app.${table}`])).rows[0].n;
    if (!exists) continue;
    const where = table === "projects" ? "id = ANY($1::uuid[])" : "project_id = ANY($1::uuid[])";
    result[table] = (await control.query(
      `SELECT to_jsonb(t) AS row FROM app.${table} t WHERE ${where} ORDER BY to_jsonb(t)::text`, [projectIds],
    )).rows.map((r) => r.row);
  }
  return result;
}
// 既有物件的權限／RLS／owner 基線（不含 0025 新增的 app_stage_confirmer 授權與新物件）。
async function permissionBaseline() {
  const relations = (await control.query(`
    SELECT c.relname, pg_get_userbyid(c.relowner) AS owner, c.relrowsecurity, c.relforcerowsecurity,
      coalesce((SELECT jsonb_agg(jsonb_build_array(a.grantee::regrole::text, a.privilege_type, a.is_grantable) ORDER BY 1,2)
        FROM aclexplode(c.relacl) a WHERE a.grantee::regrole::text <> 'app_stage_confirmer'), '[]') AS acl
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace AND n.nspname='app'
    WHERE c.relkind IN ('r','v','S') AND c.relname <> 'stage_draft_confirmations' ORDER BY c.relname`)).rows;
  const columns = (await control.query(`
    SELECT c.relname, a.attname, coalesce((SELECT jsonb_agg(jsonb_build_array(x.grantee::regrole::text, x.privilege_type) ORDER BY 1,2)
      FROM aclexplode(a.attacl) x WHERE x.grantee::regrole::text <> 'app_stage_confirmer'), '[]') AS acl
    FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace AND n.nspname='app'
    WHERE a.attnum > 0 AND NOT a.attisdropped AND a.attacl IS NOT NULL AND c.relname <> 'stage_draft_confirmations'
    ORDER BY c.relname, a.attname`)).rows
    .filter((row) => (row.acl as unknown[]).length > 0);
  const policies = (await control.query(`
    SELECT tablename, policyname, cmd, roles::text, qual, with_check FROM pg_policies
    WHERE schemaname='app' AND tablename <> 'stage_draft_confirmations'
      AND policyname NOT IN ('projects_stage_confirmer_read_owner','stage_records_confirmer_read_owner')
    ORDER BY tablename, policyname`)).rows;
  const functions = (await control.query(`
    SELECT p.oid::regprocedure::text AS sig, pg_get_userbyid(p.proowner) AS owner, p.prosecdef, p.proconfig::text,
      md5(pg_get_functiondef(p.oid)) AS def,
      coalesce((SELECT jsonb_agg(jsonb_build_array(a.grantee::regrole::text, a.privilege_type) ORDER BY 1,2)
        FROM aclexplode(p.proacl) a WHERE a.grantee::regrole::text <> 'app_stage_confirmer'), '[]') AS acl
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace AND n.nspname='app'
    WHERE p.proname <> 'confirm_stage_draft' ORDER BY 1`)).rows;
  return { relations, columns, policies, functions };
}
const evidenceRows = async (project: string) => (await control.query(
  "SELECT stage, record_row_version, content_hash, confirmed_by, source FROM app.stage_draft_confirmations WHERE project_id=$1 ORDER BY stage, record_row_version",
  [project])).rows;

let a: string; let b: string;
let before: Record<string, unknown[]>;
let permissionsBefore: Awaited<ReturnType<typeof permissionBaseline>>;
let taskId: string;

beforeAll(async () => {
  control = openControlPool();
  owner = await createSyntheticAuthAccount(control, "UpgradeOwner");
  other = await createSyntheticAuthAccount(control, "UpgradeOther");
  accounts.push(owner, other);
  ownerSession = await loginSyntheticAccount(owner);
  otherSession = await loginSyntheticAccount(other);
});

afterAll(async () => {
  try {
    await closeServerDatabasePool();
    await closeSyntheticWorkerPool();
    if (projectIds.length) {
      await control.query("DELETE FROM app.stage_draft_confirmations WHERE project_id=ANY($1::uuid[])", [projectIds]).catch(() => undefined);
      await control.query("DELETE FROM app.stage_draft_idempotency WHERE project_id=ANY($1::uuid[])", [projectIds]);
      await control.query("DELETE FROM app.project_task_imports WHERE project_id=ANY($1::uuid[])", [projectIds]);
      await control.query("DELETE FROM app.tasks WHERE project_id=ANY($1::uuid[])", [projectIds]);
      await control.query("DELETE FROM app.stage_records WHERE project_id=ANY($1::uuid[])", [projectIds]);
      await control.query("DELETE FROM app.project_create_idempotency WHERE project_id=ANY($1::uuid[])", [projectIds]);
      await control.query("DELETE FROM app.projects WHERE id=ANY($1::uuid[])", [projectIds]);
    }
    for (const account of accounts) {
      await control.query("DELETE FROM app.profiles WHERE id=$1", [account.id]);
      await control.query("DELETE FROM app.schools WHERE id=$1", [account.schoolId]);
      await deleteSyntheticAuthAccount(account);
    }
  } finally {
    await control.end();
  }
});

describe("0024 既有資料升級至 0025（真 Auth → Route Handler → 隔離 PostgreSQL）", () => {
  it("前置：DB 確實停在 0024（無 0025 物件），建立不同版本草稿與手動任務", async () => {
    expect((await control.query("SELECT to_regclass('app.stage_draft_confirmations')::text AS n")).rows[0].n).toBeNull();
    expect((await control.query("SELECT to_regprocedure('app.confirm_stage_draft(uuid,text,integer,uuid)')::text AS n")).rows[0].n).toBeNull();
    expect((await control.query("SELECT to_regclass('app.project_task_imports')::text AS n")).rows[0].n).not.toBeNull();
    a = await createOwnedSyntheticProject(owner);
    b = await createOwnedSyntheticProject(other);
    projectIds.push(a, b);
    expect((await save(a, "Specification", "規格v0", null)).status).toBe(201);
    expect((await save(a, "Specification", "規格v1", 0)).status).toBe(200);
    expect((await save(a, "Specification", "規格v2", 1)).status).toBe(200);
    expect((await save(a, "點子", "點子v0", null)).status).toBe(201);
    expect((await save(a, "A/B", "AB v0", null)).status).toBe(201);
    expect((await save(a, "A/B", "AB v1", 0)).status).toBe(200);
    expect((await save(b, "Specification", "他人規格", null, otherSession)).status).toBe(201);
    const imported = await importTasks(a, ["任務一", "任務二"]);
    expect(imported.status).toBe(201);
    taskId = (await imported.json()).tasks[0].id;
    expect((await markDone(a, taskId, 0)).status).toBe(200);
    before = await dataBaseline();
    permissionsBefore = await permissionBaseline();
    expect(before.stage_records).toHaveLength(4);
    expect(before.tasks).toHaveLength(2);
    expect(before.project_task_imports).toHaveLength(1);
    expect((await status(a, "Specification")).http).not.toBe(200);
  });

  it("只套用 0025：舊資料、ID、內容、版本與既有權限基線不變；舊草稿無確認", async () => {
    const sql = await readFile(new URL("../../supabase/migrations/0025_stage_draft_confirmation.sql", import.meta.url), "utf8");
    await control.query(sql);
    expect(await dataBaseline()).toEqual(before);
    expect(await permissionBaseline()).toEqual(permissionsBefore);
    expect((await control.query("SELECT count(*)::int AS n FROM app.stage_draft_confirmations")).rows[0].n).toBe(0);
    for (const [stage, version] of [["Specification", 2], ["點子", 0], ["A/B", 1]] as const) {
      expect((await status(a, stage)).body).toMatchObject({
        state: "unconfirmed", draft_row_version: version, latest_confirmation: null, approval: "manual_approval_unavailable",
      });
    }
    expect((await status(a, "Checkpoint")).body).toMatchObject({ state: "no_draft", draft_row_version: null });
    expect((await status(a, "Specification", otherSession)).http).toBe(404);
    expect((await status(b, "Specification", ownerSession)).http).toBe(404);
  });

  it("可確認 v2；再保存使其失效；舊確認不復活；歷史證據保留", async () => {
    expect((await confirm(a, "Specification", 0)).status).toBe(409);
    expect((await confirm(a, "Specification", 2)).status).toBe(201);
    expect((await status(a, "Specification")).body).toMatchObject({
      state: "confirmed_current", draft_row_version: 2,
      latest_confirmation: { row_version: 2, content_hash: sha("規格v2") },
    });
    // 其他階段不受牽連。
    expect((await status(a, "A/B")).body).toMatchObject({ state: "unconfirmed" });
    expect((await save(a, "Specification", "規格v3", 2)).status).toBe(200);
    expect((await status(a, "Specification")).body).toMatchObject({ state: "confirmation_stale", draft_row_version: 3 });
    expect((await save(a, "Specification", "規格v2", 3)).status).toBe(200);
    expect((await status(a, "Specification")).body).toMatchObject({ state: "confirmation_stale", draft_row_version: 4 });
    expect((await evidenceRows(a)).map((r) => [r.stage, r.record_row_version, r.content_hash])).toEqual([["Specification", 2, sha("規格v2")]]);
    expect((await confirm(a, "Specification", 4)).status).toBe(201);
    expect((await status(a, "Specification")).body).toMatchObject({ state: "confirmed_current", draft_row_version: 4 });
    expect((await evidenceRows(a))).toHaveLength(2);
    // 另一專案的舊草稿仍未確認。
    expect((await status(b, "Specification", otherSession)).body).toMatchObject({ state: "unconfirmed", draft_row_version: 0 });
  });

  it("RLS、函式 owner／grant 與直接寫入拒絕", async () => {
    const session = createDatabaseSession(owner.id);
    const hash = sha("規格v2");
    await expect(session.write.runTransaction((q) => q.query(
      `INSERT INTO app.stage_draft_confirmations (project_id,stage,record_row_version,content_hash,confirmed_by,confirmed_at,source,idempotency_key)
       VALUES ($1,'點子',0,$2,$3,now(),'student_explicit_confirmation',$4)`, [a, hash, owner.id, randomUUID()]))).rejects.toThrow();
    await expect(session.write.runTransaction((q) => q.query(
      "UPDATE app.stage_draft_confirmations SET content_hash=$2 WHERE project_id=$1", [a, "0".repeat(64)]))).rejects.toThrow();
    await expect(session.write.runTransaction((q) => q.query(
      "DELETE FROM app.stage_draft_confirmations WHERE project_id=$1", [a]))).rejects.toThrow();
    await expect(session.write.runTransaction((q) => q.query(
      "UPDATE app.stage_records SET state='approved', approved_by=$2 WHERE project_id=$1", [a, owner.id]))).rejects.toThrow();
    const catalog = (await control.query(`
      SELECT r.rolcanlogin, r.rolbypassrls, r.rolsuper, p.prosecdef, pg_get_userbyid(p.proowner) AS owner,
        has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth_exec,
        has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_exec,
        has_function_privilege('public', p.oid, 'EXECUTE') AS public_exec,
        c.relrowsecurity, c.relforcerowsecurity,
        has_table_privilege('authenticated', c.oid, 'INSERT') AS auth_insert,
        has_table_privilege('authenticated', c.oid, 'UPDATE') AS auth_update,
        has_table_privilege('authenticated', c.oid, 'DELETE') AS auth_delete
      FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace AND n.nspname='app'
      JOIN pg_roles r ON r.oid=p.proowner
      JOIN pg_class c ON c.relname='stage_draft_confirmations' AND c.relnamespace=n.oid
      WHERE p.proname='confirm_stage_draft'`)).rows;
    expect(catalog).toEqual([{
      rolcanlogin: false, rolbypassrls: false, rolsuper: false, prosecdef: true, owner: "app_stage_confirmer",
      auth_exec: true, anon_exec: false, public_exec: false, relrowsecurity: true, relforcerowsecurity: true,
      auth_insert: false, auth_update: false, auth_delete: false,
    }]);
    expect((await evidenceRows(a))).toHaveLength(2);
  });

  it("既有建立、草稿、任務功能無回歸；未修改 stage／分類／批准", async () => {
    const created = await createOwnedSyntheticProject(owner);
    projectIds.push(created);
    expect((await save(created, "Constitution", "新稿", null)).status).toBe(201);
    expect((await importTasks(created, ["新任務"])).status).toBe(201);
    expect((await save(a, "點子", "點子v1", 0)).status).toBe(200);
    expect((await status(a, "點子")).body).toMatchObject({ state: "unconfirmed", draft_row_version: 1 });
    expect((await markDone(a, taskId, 0)).status).toBe(409);
    const tasks = (await control.query("SELECT done,row_version FROM app.tasks WHERE id=$1", [taskId])).rows;
    expect(tasks).toEqual([{ done: true, row_version: 1 }]);
    expect((await control.query(
      "SELECT stage,classification_state FROM app.projects WHERE id=ANY($1::uuid[]) ORDER BY id", [[a, b, created]],
    )).rows.every((row) => row.stage === "點子" && row.classification_state === "unconfirmed")).toBe(true);
    expect((await control.query(
      "SELECT count(*)::int AS n FROM app.stage_records WHERE project_id=ANY($1::uuid[]) AND (approved_by IS NOT NULL OR approved_at IS NOT NULL OR state<>'ai_draft')",
      [[a, b, created]])).rows[0].n).toBe(0);
  });
});
