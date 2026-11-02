import { createHash, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeServerDatabasePool, createDatabaseSession } from "../../apps/web/src/server/database-session.ts";
import { createAuthPrincipalResolver, sessionCookieName } from "../../apps/web/src/server/auth-principal.ts";
import { createProjectHandlers } from "../../apps/web/src/server/project-handlers.ts";
import { PUT as saveDraftRoute } from "../../apps/web/src/app/api/v1/projects/[id]/stages/[stage]/route.ts";
import {
  GET as statusRoute, POST as confirmRoute,
} from "../../apps/web/src/app/api/v1/projects/[id]/stages/[stage]/confirmation/route.ts";
import {
  closeSyntheticWorkerPool, createOwnedSyntheticProject, createSyntheticAuthAccount,
  deleteSyntheticAuthAccount, loginSyntheticAccount, openControlPool,
  type NativeAuthSession, type SyntheticAuthAccount,
} from "../support/real-auth-fixture.ts";

const appOrigin = process.env.APP_PLANET_APP_ORIGIN!;
const accounts: SyntheticAuthAccount[] = [];
const projectIds: string[] = [];
let control!: Pool;
let owner: SyntheticAuthAccount;
let other: SyntheticAuthAccount;
let ownerSession: NativeAuthSession;
let otherSession: NativeAuthSession;
const stage = "Specification";
const sha = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

function req(path: string, method: string, session: NativeAuthSession | undefined,
  headers: Record<string, string>, body?: unknown): Request {
  const h = new Headers(headers);
  if (session) h.set("cookie", `${sessionCookieName}=${session.accessToken}`);
  if (!h.has("origin")) h.set("origin", appOrigin);
  if (body !== undefined) h.set("content-type", "application/json");
  return new Request(`${appOrigin}${path}`, {
    method, headers: h, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
const stagePath = (project: string, s = stage) => `/api/v1/projects/${project}/stages/${encodeURIComponent(s)}`;

function save(project: string, text: string, version: number | null, session = ownerSession,
  s = stage, key = randomUUID()): Promise<Response> {
  return saveDraftRoute(req(stagePath(project, s), "PUT", session, {
    "idempotency-key": key,
    ...(version === null ? { "if-none-match": "*" } : { "if-match": `"${version}"` }),
  }, { content: { text } }), { params: Promise.resolve({ id: project, stage: s }) });
}
function confirm(project: string, version: unknown, session: NativeAuthSession | null = ownerSession,
  key: string | null = randomUUID(), s = stage, body: unknown = { expected_row_version: version }): Promise<Response> {
  return confirmRoute(req(`${stagePath(project, s)}/confirmation`, "POST", session ?? undefined,
    key === null ? {} : { "idempotency-key": key }, body), { params: Promise.resolve({ id: project, stage: s }) });
}
async function status(project: string, session = ownerSession, s = stage) {
  const response = await statusRoute(req(`${stagePath(project, s)}/confirmation`, "GET", session, {}),
    { params: Promise.resolve({ id: project, stage: s }) });
  return { http: response.status, body: response.status === 200 ? await response.json() : await response.json().catch(() => null) };
}
async function newProject(): Promise<string> {
  const id = await createOwnedSyntheticProject(owner);
  projectIds.push(id);
  return id;
}
const evidence = async (project: string) => (await control.query(
  `SELECT stage, record_row_version, content_hash, confirmed_by, source, confirmed_at
   FROM app.stage_draft_confirmations WHERE project_id=$1 ORDER BY record_row_version`, [project])).rows;
async function untouched(project: string) {
  expect((await control.query(
    "SELECT stage,row_version,classification_state,current_confirmation_id FROM app.projects WHERE id=$1", [project],
  )).rows).toEqual([{ stage: "點子", row_version: 0, classification_state: "unconfirmed", current_confirmation_id: null }]);
  expect((await control.query(
    "SELECT count(*)::int n FROM app.stage_records WHERE project_id=$1 AND (state<>'ai_draft' OR approved_by IS NOT NULL OR approved_at IS NOT NULL)",
    [project])).rows[0].n).toBe(0);
  expect((await control.query("SELECT count(*)::int n FROM app.tasks WHERE project_id=$1", [project])).rows[0].n).toBe(0);
}

beforeAll(async () => {
  control = openControlPool();
  owner = await createSyntheticAuthAccount(control, "ConfirmOwner");
  other = await createSyntheticAuthAccount(control, "ConfirmOther");
  accounts.push(owner, other);
  ownerSession = await loginSyntheticAccount(owner);
  otherSession = await loginSyntheticAccount(other);
});

afterAll(async () => {
  try {
    await control.query("DROP TRIGGER IF EXISTS test_fail_confirm ON app.stage_draft_confirmations");
    await control.query("DROP TRIGGER IF EXISTS test_fail_save ON app.stage_records");
    await control.query("DROP FUNCTION IF EXISTS app.test_fail_confirm()");
    await closeServerDatabasePool();
    await closeSyntheticWorkerPool();
    if (projectIds.length) {
      await control.query("DELETE FROM app.stage_draft_confirmations WHERE project_id=ANY($1::uuid[])", [projectIds]);
      await control.query("DELETE FROM app.stage_draft_idempotency WHERE project_id=ANY($1::uuid[])", [projectIds]);
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

describe("階段草稿學生確認（真 Auth → Route Handler → 隔離 PostgreSQL）", () => {
  it("保存 → 明確確認 → 有效；DB 時間／主體／hash 由伺服器決定；不改 stage／分類／任務", async () => {
    const project = await newProject();
    expect((await save(project, "第一版", null)).status).toBe(201);
    expect((await status(project)).body).toMatchObject({ state: "unconfirmed", draft_row_version: 0, latest_confirmation: null });
    const response = await confirm(project, 0);
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body).toMatchObject({ outcome: "confirmed", current: true, confirmation: { row_version: 0, content_hash: sha("第一版") } });
    const rows = await evidence(project);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      stage, record_row_version: 0, content_hash: sha("第一版"), confirmed_by: owner.id,
      source: "student_explicit_confirmation",
    });
    expect(Math.abs(Date.now() - new Date(rows[0].confirmed_at).getTime())).toBeLessThan(60_000);
    const current = await status(project);
    expect(current.body).toMatchObject({
      state: "confirmed_current", draft_row_version: 0, approval: "manual_approval_unavailable",
    });
    expect(JSON.stringify(current.body)).not.toMatch(/confirmed_by|owner/);
    await untouched(project);
  });

  it("沒有已保存草稿不能確認；舊／未來版本不確認；無副作用", async () => {
    const project = await newProject();
    const none = await confirm(project, 0);
    expect(none.status).toBe(409);
    expect((await none.json()).code).toBe("stage_draft_not_saved");
    expect((await status(project)).body.state).toBe("no_draft");
    await save(project, "甲", null);
    await save(project, "乙", 0);
    const stale = await confirm(project, 0);
    expect(stale.status).toBe(409);
    expect((await stale.json()).code).toBe("stage_confirmation_version_mismatch");
    expect((await confirm(project, 2)).status).toBe(409);
    expect(await evidence(project)).toEqual([]);
    expect((await status(project)).body.state).toBe("unconfirmed");
    await untouched(project);
  });

  it("保存後再修改使確認失效；舊證據保留；改回相同文字不復活；新版需重新確認", async () => {
    const project = await newProject();
    await save(project, "同一段文字", null);
    expect((await confirm(project, 0)).status).toBe(201);
    expect((await save(project, "改過", 0)).status).toBe(200);
    expect((await status(project)).body).toMatchObject({ state: "confirmation_stale", draft_row_version: 1 });
    expect((await save(project, "同一段文字", 1)).status).toBe(200);
    const stale = await status(project);
    expect(stale.body).toMatchObject({ state: "confirmation_stale", draft_row_version: 2 });
    expect(stale.body.latest_confirmation.row_version).toBe(0);
    expect(await evidence(project)).toHaveLength(1);
    expect((await confirm(project, 1)).status).toBe(409);
    expect((await confirm(project, 2)).status).toBe(201);
    expect((await status(project)).body).toMatchObject({ state: "confirmed_current", draft_row_version: 2 });
    expect((await evidence(project)).map((row) => row.record_row_version)).toEqual([0, 2]);
    await untouched(project);
  });

  it("同鍵重送不重複；異意圖拒絕；舊 receipt 不恢復已失效確認；同版新鍵不新增", async () => {
    const project = await newProject();
    await save(project, "甲", null);
    const key = randomUUID();
    expect((await confirm(project, 0, ownerSession, key)).status).toBe(201);
    const replay = await confirm(project, 0, ownerSession, key);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ outcome: "replayed", current: true });
    expect((await confirm(project, 1, ownerSession, key)).status).toBe(422);
    expect((await confirm(project, 0, ownerSession, key, "Checkpoint")).status).toBe(422);
    const sameVersion = await confirm(project, 0, ownerSession, randomUUID());
    expect(sameVersion.status).toBe(200);
    expect((await sameVersion.json()).outcome).toBe("already_confirmed");
    expect(await evidence(project)).toHaveLength(1);

    await save(project, "乙", 0);
    const afterEdit = await confirm(project, 0, ownerSession, key);
    expect(afterEdit.status).toBe(200);
    expect(await afterEdit.json()).toMatchObject({ outcome: "replayed", current: false });
    expect((await status(project)).body.state).toBe("confirmation_stale");
    expect(await evidence(project)).toHaveLength(1);
  });

  it("缺 key／畸形 body／偽造 actor、hash、時間、批准欄位均拒絕且無副作用", async () => {
    const project = await newProject();
    await save(project, "甲", null);
    expect((await confirm(project, 0, ownerSession, null)).status).toBe(400);
    expect((await confirm(project, "0")).status).toBe(400);
    expect((await confirm(project, -1)).status).toBe(400);
    expect((await confirm(project, 0, ownerSession, randomUUID(), stage, {})).status).toBe(400);
    for (const forged of [
      { confirmed_by: other.id }, { content_hash: sha("甲") }, { confirmed_at: "2000-01-01T00:00:00Z" },
      { approved: true }, { state: "approved" }, { approved_by: owner.id }, { owner_id: other.id },
    ]) {
      expect((await confirm(project, 0, ownerSession, randomUUID(), stage, { expected_row_version: 0, ...forged })).status).toBe(400);
    }
    const draftForged = await saveDraftRoute(req(stagePath(project), "PUT", ownerSession, {
      "idempotency-key": randomUUID(), "if-match": '"0"',
    }, { content: { text: "乙" }, state: "user_confirmed", confirmed: true, approved_by: owner.id }),
    { params: Promise.resolve({ id: project, stage }) });
    expect(draftForged.status).toBe(400);
    expect(await evidence(project)).toEqual([]);
    expect((await control.query("SELECT row_version,state FROM app.stage_records WHERE project_id=$1", [project])).rows)
      .toEqual([{ row_version: 0, state: "ai_draft" }]);
    await untouched(project);
  });

  it("跨帳號、錯專案／階段、角色冒充皆拒絕；沒有人工批准路徑", async () => {
    const project = await newProject();
    await save(project, "甲", null);
    expect((await confirm(project, 0, otherSession)).status).toBe(404);
    expect((await status(project, otherSession)).http).toBe(404);
    expect((await confirm(randomUUID(), 0)).status).toBe(404);
    expect((await confirm("not-a-uuid", 0)).status).toBe(404);
    expect((await confirm(project, 0, ownerSession, randomUUID(), "不存在階段")).status).toBe(404);
    const otherStage = await confirm(project, 0, ownerSession, randomUUID(), "Checkpoint");
    expect(otherStage.status).toBe(409);
    expect((await confirm(project, 0, null)).status).toBe(401);
    for (const role of ["teacher", "admin"]) {
      await control.query("UPDATE app.profiles SET role=$2 WHERE id=$1", [other.id, role]);
      expect([403, 404]).toContain((await confirm(project, 0, otherSession)).status);
      expect([403, 404]).toContain((await status(project, otherSession)).http);
    }
    await control.query("UPDATE app.profiles SET role='student' WHERE id=$1", [other.id]);
    expect(await evidence(project)).toEqual([]);
    await untouched(project);
  });

  it("handler 檢查後失權，DB 仍拒絕；恢復後可確認", async () => {
    const project = await newProject();
    await save(project, "甲", null);
    const revoking = createProjectHandlers({
      resolver: createAuthPrincipalResolver(), requireSameOrigin: true,
      beforeExecute: async () => {
        await control.query("UPDATE app.profiles SET status='disabled' WHERE id=$1", [owner.id]);
      },
    });
    try {
      const response = await revoking.confirmStage(
        req(`${stagePath(project)}/confirmation`, "POST", ownerSession, { "idempotency-key": randomUUID() }, { expected_row_version: 0 }),
        { projectId: project, stage });
      expect(response.status).toBe(403);
    } finally {
      await control.query("UPDATE app.profiles SET status='approved' WHERE id=$1", [owner.id]);
    }
    expect(await evidence(project)).toEqual([]);
    expect((await confirm(project, 0)).status).toBe(201);
  });

  it("保存與舊版確認並行：不確認錯版、不留矛盾狀態", async () => {
    for (let round = 0; round < 4; round += 1) {
      const project = await newProject();
      await save(project, "v0", null);
      const [savedResponse, confirmResponse] = await Promise.all([
        save(project, "v1", 0), confirm(project, 0),
      ]);
      expect(savedResponse.status).toBe(200);
      expect([201, 409]).toContain(confirmResponse.status);
      const rows = await evidence(project);
      for (const row of rows) expect(row.content_hash).toBe(sha(row.record_row_version === 0 ? "v0" : "v1"));
      expect(rows.length).toBe(confirmResponse.status === 201 ? 1 : 0);
      const final = await status(project);
      expect(final.body.draft_row_version).toBe(1);
      expect(final.body.state).toBe(rows.length ? "confirmation_stale" : "unconfirmed");
    }
  });

  it("同版並行確認：新舊鍵只產生一份證據；同鍵並行只建立一次", async () => {
    const project = await newProject();
    await save(project, "甲", null);
    const results = await Promise.all(Array.from({ length: 5 }, () => confirm(project, 0)));
    expect(results.map((r) => r.status).sort()).toEqual([200, 200, 200, 200, 201]);
    expect(await evidence(project)).toHaveLength(1);
    const second = await newProject();
    await save(second, "乙", null);
    const key = randomUUID();
    const same = await Promise.all(Array.from({ length: 4 }, () => confirm(second, 0, ownerSession, key)));
    expect(same.map((r) => r.status).sort()).toEqual([200, 200, 200, 201]);
    expect(await evidence(second)).toHaveLength(1);
  });

  it("故障注入：確認 INSERT／保存 UPDATE 失敗整筆 rollback，既有有效確認不被改動", async () => {
    await control.query(`
      CREATE FUNCTION app.test_fail_confirm() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'synthetic failure'; END $$`);
    try {
      const project = await newProject();
      await save(project, "甲", null);
      await control.query("CREATE TRIGGER test_fail_confirm BEFORE INSERT ON app.stage_draft_confirmations FOR EACH ROW EXECUTE FUNCTION app.test_fail_confirm()");
      expect((await confirm(project, 0)).status).toBe(503);
      expect(await evidence(project)).toEqual([]);
      await control.query("DROP TRIGGER test_fail_confirm ON app.stage_draft_confirmations");
      expect((await confirm(project, 0)).status).toBe(201);

      await control.query("CREATE TRIGGER test_fail_save BEFORE UPDATE ON app.stage_records FOR EACH ROW EXECUTE FUNCTION app.test_fail_confirm()");
      expect((await save(project, "乙", 0)).status).toBe(503);
      await control.query("DROP TRIGGER test_fail_save ON app.stage_records");
      expect((await control.query("SELECT row_version, content FROM app.stage_records WHERE project_id=$1", [project])).rows)
        .toEqual([{ row_version: 0, content: { text: "甲" } }]);
      expect((await status(project)).body.state).toBe("confirmed_current");
      expect(await evidence(project)).toHaveLength(1);
    } finally {
      await control.query("DROP TRIGGER IF EXISTS test_fail_confirm ON app.stage_draft_confirmations");
      await control.query("DROP TRIGGER IF EXISTS test_fail_save ON app.stage_records");
      await control.query("DROP FUNCTION IF EXISTS app.test_fail_confirm()");
    }
  });

  it("DB 權限：authenticated 不可直接寫入／改寫證據或偽造批准；函式受控、證據表 FORCE RLS", async () => {
    const project = await newProject();
    await save(project, "甲", null);
    await confirm(project, 0);
    const session = createDatabaseSession(owner.id);
    const hash = sha("甲");
    await expect(session.write.runTransaction((q) => q.query(
      `INSERT INTO app.stage_draft_confirmations (project_id,stage,record_row_version,content_hash,confirmed_by,confirmed_at,source,idempotency_key)
       VALUES ($1,$2,5,$3,$4,now(),'student_explicit_confirmation',$5)`,
      [project, stage, hash, owner.id, randomUUID()]))).rejects.toThrow();
    await expect(session.write.runTransaction((q) => q.query(
      "UPDATE app.stage_draft_confirmations SET content_hash=$2 WHERE project_id=$1", [project, "0".repeat(64)]))).rejects.toThrow();
    await expect(session.write.runTransaction((q) => q.query(
      "DELETE FROM app.stage_draft_confirmations WHERE project_id=$1", [project]))).rejects.toThrow();
    await expect(session.write.runTransaction((q) => q.query(
      "UPDATE app.stage_records SET state='approved', approved_by=$2 WHERE project_id=$1", [project, owner.id]))).rejects.toThrow();
    await expect(session.write.runTransaction((q) => q.query(
      "UPDATE app.stage_records SET row_version=row_version WHERE project_id=$1", [project]))).rejects.toThrow();
    expect(await evidence(project)).toHaveLength(1);
    await untouched(project);

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
      rolcanlogin: false, rolbypassrls: false, rolsuper: false, prosecdef: true,
      owner: "app_stage_confirmer", auth_exec: true, anon_exec: false, public_exec: false,
      relrowsecurity: true, relforcerowsecurity: true, auth_insert: false, auth_update: false, auth_delete: false,
    }]);
  });
});
