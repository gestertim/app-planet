import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  createOwnedProjectSubset, saveOwnedProjectRequirementsSubset,
  confirmOwnedProjectClassificationSubset, resolveTrustedProjectClassification,
  hasTrustedProjectClassification, readCurrentOwnedProjectClassificationSubset,
  type ProjectCreationContext, type ProjectCreationQuery,
} from "../../apps/web/src/server/projects.ts";
import { readOwnedStageDraftSubset, saveOwnedStageDraftSubset } from "../../apps/web/src/server/stage-drafts.ts";
import { inspectConnection, localPools, syntheticContext, syntheticCreationContext } from "./authorization-context.ts";
import type { StageDraftDto } from "@app-planet/core";

const { control, authorization, parallelAuthorization } = localPools();
const actor = (n: number) => `94000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const school = (n: number) => `95000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const key = (n: number) => `96000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const projects = new Set<string>();
let keyCounter = 1;
const nextKey = () => key(keyCounter++);
const context = (n = 1) => syntheticCreationContext(authorization, actor(n));
const readContext = (n = 1) => syntheticContext(authorization, actor(n));
const input = (projectId: string, version: number | null = null, text = " \t草稿 🌍 e\u0301\r\n", stage: StageDraftDto["stage"] = "Specification") => ({
  project_id: projectId, stage, expected_row_version: version, content: { text },
});
async function createProject(owner = 1) {
  const result = await createOwnedProjectSubset(context(owner), { title: "synthetic-stage-draft" }, nextKey());
  if (result.outcome !== "created") throw new Error("合成專案建立失敗");
  projects.add(result.project.id);
  return result.project.id;
}
async function save(projectId: string, version: number | null = null, text?: string) {
  return saveOwnedStageDraftSubset(context(), input(projectId, version, text), nextKey());
}
async function read(projectId: string, stage: StageDraftDto["stage"] = "Specification", owner = 1) {
  return readOwnedStageDraftSubset(readContext(owner), { project_id: projectId, stage });
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
const snapshotSql = `
  SELECT jsonb_build_object(
    'project', (SELECT to_jsonb(p) FROM app.projects p WHERE id=$1),
    'requirements', (SELECT COALESCE(jsonb_agg(to_jsonb(r) ORDER BY revision), '[]')
      FROM app.project_requirements r WHERE project_id=$1),
    'confirmations', (SELECT COALESCE(jsonb_agg(to_jsonb(c) ORDER BY id), '[]')
      FROM app.project_classification_confirmations c WHERE project_id=$1),
    'classification_keys', (SELECT COALESCE(jsonb_agg(to_jsonb(i) ORDER BY operation_scope,idempotency_key), '[]')
      FROM app.project_classification_idempotency i WHERE project_id=$1),
    'drafts', (SELECT COALESCE(jsonb_agg(to_jsonb(d) ORDER BY stage), '[]')
      FROM app.stage_records d WHERE project_id=$1),
    'keys', (SELECT COALESCE(jsonb_agg(to_jsonb(i) ORDER BY idempotency_key), '[]')
      FROM app.stage_draft_idempotency i WHERE project_id=$1)
  ) AS snapshot`;
async function snapshot(query: ProjectCreationQuery, id: string) {
  return (await query.query(snapshotSql, [id])).rows[0];
}
async function poolState() {
  const client = await authorization.connect();
  let state;
  try { state = await inspectConnection(client); } finally { client.release(); }
  const activity = await control.query("SELECT state,xact_start FROM pg_stat_activity WHERE pid=$1", [state.pid]);
  expect(state).toMatchObject({ actor: "app_authorization_test", login: "app_authorization_test", sub: null, claims: null });
  expect(activity.rows).toEqual([{ state: "idle", xact_start: null }]);
  return { ...state, activity: activity.rows };
}
function barrier() {
  let entered = 0;
  let release: () => void = () => { throw new Error("尚未建立同步點"); };
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return async () => { if (++entered === 2) release(); await promise; };
}

beforeAll(async () => {
  for (const n of [1, 2]) {
    await control.query(`
      INSERT INTO app.schools(id,label,approval_state,approval_epoch,created_at,updated_at)
      VALUES ($1,'synthetic-draft-school','approved',1,now(),now())
    `, [school(n)]);
  }
  for (const n of [1, 2, 3, 4, 5]) {
    await control.query("INSERT INTO auth.users(id) VALUES ($1)", [actor(n)]);
    await control.query(`
      INSERT INTO app.profiles(id,role,status,deletion_state,school_id,display_label,status_changed_at)
      VALUES ($1,$2,'approved','none',$3,'synthetic-draft-actor',now())
    `, [actor(n), n === 4 ? "teacher" : n === 5 ? "admin" : "student", n === 3 ? school(2) : school(1)]);
  }
  const permissions = await control.query(`
    SELECT r.relname,r.relrowsecurity,r.relforcerowsecurity,
      has_table_privilege('authenticated',r.oid,'INSERT') AS actor_insert,
      has_any_column_privilege('authenticated',r.oid,'UPDATE') AS actor_update,
      has_table_privilege('authenticated',r.oid,'DELETE') AS actor_delete
    FROM pg_class r JOIN pg_namespace n ON n.oid=r.relnamespace
    WHERE n.nspname='app' AND r.relname IN ('stage_records','stage_draft_idempotency')
    ORDER BY r.relname`);
  expect(permissions.rows).toHaveLength(2);
  for (const permission of permissions.rows) expect(permission).toMatchObject({
    relrowsecurity: true, relforcerowsecurity: true, actor_insert: false, actor_update: false, actor_delete: false,
  });
  const writer = await control.query(`
    SELECT r.rolname,r.rolcanlogin,r.rolsuper,r.rolbypassrls,
      p.prosecdef,p.proconfig,pg_get_userbyid(p.proowner) AS function_owner,
      has_schema_privilege(r.rolname,'app','CREATE') AS schema_create,
      has_function_privilege('anon',p.oid,'EXECUTE') AS anon_execute,
      has_function_privilege('service_role',p.oid,'EXECUTE') AS service_execute,
      has_function_privilege('authenticated',p.oid,'EXECUTE') AS actor_execute,
      has_any_column_privilege(r.rolname,'app.projects','UPDATE') AS project_update,
      has_column_privilege(r.rolname,'app.stage_records','state','UPDATE') AS state_update,
      has_column_privilege(r.rolname,'app.stage_records','approved_by','INSERT') AS approval_insert,
      (SELECT count(*)::int FROM pg_auth_members m WHERE m.roleid=r.oid) AS members
    FROM pg_roles r JOIN pg_proc p ON p.proowner=r.oid
    WHERE r.rolname='app_stage_draft_writer' AND p.proname='save_stage_draft'`);
  expect(writer.rows).toEqual([{
    rolname: "app_stage_draft_writer", rolcanlogin: false, rolsuper: false, rolbypassrls: false,
    prosecdef: true, proconfig: ["search_path=pg_catalog"], function_owner: "app_stage_draft_writer",
    schema_create: false, anon_execute: false, service_execute: false, actor_execute: true,
    project_update: false, state_update: false, approval_insert: false, members: 0,
  }]);
  console.log("stage draft permission snapshot", JSON.stringify({ tables: permissions.rows, writer: writer.rows }));
});
afterEach(async () => {
  const ids = [...projects];
  if (ids.length) {
    await control.query("DELETE FROM app.stage_draft_idempotency WHERE project_id=ANY($1::uuid[])", [ids]);
    await control.query("DELETE FROM app.stage_records WHERE project_id=ANY($1::uuid[])", [ids]);
    await control.query(`UPDATE app.projects SET classification_state='unconfirmed',
      tier=NULL,needs_visitor_identity=NULL,current_confirmation_id=NULL WHERE id=ANY($1::uuid[])`, [ids]);
    for (const table of ["project_classification_idempotency", "project_classification_confirmations",
      "project_requirements", "project_create_idempotency"]) {
      await control.query(`DELETE FROM app.${table} WHERE project_id=ANY($1::uuid[])`, [ids]);
    }
    await control.query("DELETE FROM app.projects WHERE id=ANY($1::uuid[])", [ids]);
    projects.clear();
  }
  await control.query("UPDATE app.profiles SET status='approved',deletion_state='none' WHERE id=ANY($1::uuid[])", [
    [1, 2, 3, 4, 5].map(actor),
  ]);
  await control.query("UPDATE app.schools SET approval_state='approved' WHERE id=ANY($1::uuid[])", [[school(1), school(2)]]);
});
afterAll(async () => { await Promise.all([control.end(), authorization.end(), parallelAuthorization.end()]); });

describe("獨立未確認階段草稿真實 PostgreSQL", () => {
  it("首次保存、新 context 讀回、更新、原文與空草稿；不動 project／分類", async () => {
    const id = await createProject();
    const before = await readCurrentOwnedProjectClassificationSubset(readContext(), id);
    const first = await save(id);
    expect(first).toMatchObject({ outcome: "saved" });
    if (first.outcome !== "saved") throw new Error("首次草稿保存失敗");
    expect(first.operation).toEqual({
      project_id: id, stage: "Specification", content: input(id).content, row_version: 0,
      state: "ai_draft", content_source: "student_input", approved_by: null, approved_at: null,
    });
    expect(await read(id)).toEqual({ outcome: "found", draft: first.operation });
    expect(await save(id, 0, "")).toMatchObject({ outcome: "saved", operation: { content: { text: "" }, row_version: 1 } });
    expect(await read(id)).toMatchObject({ outcome: "found", draft: { content: { text: "" }, row_version: 1 } });
    expect(await readCurrentOwnedProjectClassificationSubset(readContext(), id)).toEqual(before);
    expect(await resolveTrustedProjectClassification(readContext(), id)).toEqual({ outcome: "unconfirmed" });
    expect(hasTrustedProjectClassification(first.operation)).toBe(false);
  });

  it("九步與兩個專案各自隔離；Final Pack 草稿不是證據", async () => {
    const a = await createProject(), b = await createProject();
    const stages: StageDraftDto["stage"][] = [
      "點子", "A/B", "Specification", "Checkpoint", "Constitution",
      "UX/UI", "Specification Sync", "Technical Plan", "Final Pack",
    ];
    for (const id of [a, b]) {
      for (const stage of stages) {
        const text = ` \t${id} ${stage} \r\n`;
        expect(await saveOwnedStageDraftSubset(context(), input(id, null, text, stage), nextKey()))
          .toMatchObject({ outcome: "saved", operation: { row_version: 0, content_source: "student_input" } });
        expect(await read(id, stage)).toMatchObject({ outcome: "found", draft: { content: { text }, approved_by: null, approved_at: null } });
      }
    }
    const rows = await control.query("SELECT stage,row_version,requirements_revision,classification_state FROM app.projects WHERE id=ANY($1::uuid[])", [[a, b]]);
    expect(rows.rows).toEqual(Array(2).fill({ stage: "點子", row_version: 0, requirements_revision: 0, classification_state: "unconfirmed" }));
  });

  it.each([2, 3, 4, 5])("同校／跨校／教師／管理員 %i 不得讀寫或取得衝突內容", async (n) => {
    const id = await createProject();
    await save(id);
    expect(await read(id, "Specification", n)).toEqual(n < 4 ? { outcome: "not_found" } : { outcome: "denied", reason: "policy_denied" });
    expect(await saveOwnedStageDraftSubset(context(n), input(id, 99, "forged"), nextKey()))
      .toEqual(n < 4 ? { outcome: "not_found" } : { outcome: "denied", reason: "policy_denied" });
    const rows = await readContext(n).runReadOnly((query) => query.query("SELECT * FROM app.stage_records WHERE project_id=$1", [id]));
    expect(rows.rows).toEqual([]);
  });

  it.each(["owner_id", "state", "approved_by", "approved_at", "content_source", "meta"])("caller 偽造 %s 不執行交易", async (field) => {
    let called = false;
    const guarded: ProjectCreationContext = { async runTransaction() { called = true; throw new Error("不應執行"); } };
    const id = await createProject();
    expect(await saveOwnedStageDraftSubset(guarded, { ...input(id), [field]: "forged" }, nextKey()))
      .toEqual({ outcome: "failed", reason: "invalid_input" });
    expect(called).toBe(false);
  });

  it.each(["disabled", "marked", "unconfirmed"])("控制連線提交 %s 後同交易新 statement 立即拒絕", async (condition) => {
    const id = await createProject();
    const operationKey = nextKey();
    const firstInput = input(id);
    await saveOwnedStageDraftSubset(context(), firstInput, operationKey);
    const change = async () => {
      if (condition === "disabled") await control.query("UPDATE app.profiles SET status='disabled' WHERE id=$1", [actor(1)]);
      else if (condition === "marked") await control.query("UPDATE app.profiles SET deletion_state='marked' WHERE id=$1", [actor(1)]);
      else await control.query("UPDATE app.schools SET approval_state='unconfirmed' WHERE id=$1", [school(1)]);
    };
    const ctx = syntheticCreationContext(authorization, actor(1), { synchronize: change });
    expect(await saveOwnedStageDraftSubset(ctx, input(id, 0, "new"), nextKey()))
      .toEqual({ outcome: "denied", reason: "policy_denied" });
    expect(await read(id)).toEqual({ outcome: "denied", reason: "policy_denied" });
    expect(await saveOwnedStageDraftSubset(context(), firstInput, operationKey))
      .toEqual({ outcome: "denied", reason: "policy_denied" });
  });

  it.each(["withdrawn", "expired"])("%s 仍可非 AI 讀寫草稿，不授予 AI", async (state) => {
    const id = await createProject();
    await control.query("UPDATE app.schools SET approval_state=$2 WHERE id=$1", [school(1), state]);
    expect(await save(id)).toMatchObject({ outcome: "saved" });
    expect(await read(id)).toMatchObject({ outcome: "found" });
    expect(await save(id, 0, "update")).toMatchObject({ outcome: "saved", operation: { row_version: 1 } });
    const gate = await readContext().runReadOnly((query) => query.query("SELECT app.current_account_gate('ai_call') AS allowed"));
    expect(gate.rows).toEqual([{ allowed: false }]);
  });

  it("舊版衝突與首次已存在，回安全雙方內容且完全不覆寫", async () => {
    const id = await createProject();
    await save(id);
    await save(id, 0, "current");
    const before = await snapshot(control, id);
    for (const version of [0, null]) {
      expect(await save(id, version, "submitted")).toEqual({
        outcome: "conflict", reason: "version_conflict",
        conflict: { current: { version: 1, content: { text: "current" } }, submitted: { version, content: { text: "submitted" } } },
      });
      expect(await snapshot(control, id)).toEqual(before);
    }
  });
  it("尚無草稿但帶更新版本，不能暗中建立", async () => {
    const id = await createProject();
    expect(await save(id, 0, "submitted")).toEqual({
      outcome: "conflict", reason: "version_conflict",
      conflict: { current: { version: null, content: null }, submitted: { version: 0, content: { text: "submitted" } } },
    });
    expect(await read(id)).toEqual({ outcome: "not_found" });
  });

  it.each([false, true])("真實併發首次／更新（已有列=%s）僅一個成功", async (existing) => {
    const id = await createProject();
    if (existing) await save(id);
    const synchronize = barrier();
    const results = await Promise.all(["left", "right"].map((text) =>
      saveOwnedStageDraftSubset(syntheticCreationContext(parallelAuthorization, actor(1), { synchronize }),
        input(id, existing ? 0 : null, text), nextKey())));
    expect(results.filter((r) => r.outcome === "saved")).toHaveLength(1);
    expect(results.filter((r) => r.outcome === "conflict" && r.reason === "version_conflict")).toHaveLength(1);
    const rows = await control.query("SELECT row_version,content FROM app.stage_records WHERE project_id=$1", [id]);
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0].row_version).toBe(existing ? 1 : 0);
    console.log("stage concurrent evidence", JSON.stringify({ existing, results, rows: rows.rows }));
  });

  it("冪等原 receipt 與目前草稿分開，同鍵異內容／目標／版本拒絕", async () => {
    const id = await createProject();
    const operationKey = nextKey(), firstInput = input(id);
    const first = await saveOwnedStageDraftSubset(context(), firstInput, operationKey);
    await save(id, 0, "newer");
    const before = await snapshot(control, id);
    expect(await saveOwnedStageDraftSubset(context(), firstInput, operationKey)).toMatchObject({
      outcome: "replayed", operation: { row_version: 0, content: firstInput.content },
      current_draft: { outcome: "found", draft: { row_version: 1, content: { text: "newer" } } },
    });
    for (const changed of [input(id, null, "different"), input(id, 0), input(id, null, undefined, "點子")]) {
      expect(await saveOwnedStageDraftSubset(context(), changed, operationKey))
        .toEqual({ outcome: "conflict", reason: "idempotency_mismatch" });
    }
    expect(await snapshot(control, id)).toEqual(before);
    expect(first).toMatchObject({ outcome: "saved", operation: { row_version: 0 } });
    const ttl = await control.query("SELECT expires_at-created_at=interval '24 hours' AS valid FROM app.stage_draft_idempotency WHERE project_id=$1", [id]);
    expect(ttl.rows.every((row) => row.valid === true)).toBe(true);
  });
  it("同 UUID 跨主體隔離；相同內容新操作遞增；同鍵併發只寫一次", async () => {
    const a = await createProject(), b = await createProject(2), operationKey = nextKey();
    const synchronize = barrier();
    const results = await Promise.all([1, 2].map(() =>
      saveOwnedStageDraftSubset(syntheticCreationContext(parallelAuthorization, actor(1), { synchronize }),
        input(a), operationKey)));
    expect(results.map((r) => r.outcome).sort()).toEqual(["replayed", "saved"]);
    expect(await saveOwnedStageDraftSubset(context(2), input(b), operationKey)).toMatchObject({ outcome: "saved" });
    expect(await save(a, 0)).toMatchObject({ outcome: "saved", operation: { row_version: 1 } });
    const entries = await control.query("SELECT owner_id FROM app.stage_draft_idempotency WHERE idempotency_key=$1 ORDER BY owner_id", [operationKey]);
    expect(entries.rows).toEqual([{ owner_id: actor(1) }, { owner_id: actor(2) }]);
  });
  it("同鍵跨專案拒絕；過期同鍵重用不建立新清除排程", async () => {
    const a = await createProject(), b = await createProject(), operationKey = nextKey();
    await saveOwnedStageDraftSubset(context(), input(a), operationKey);
    expect(await saveOwnedStageDraftSubset(context(), input(b), operationKey))
      .toEqual({ outcome: "conflict", reason: "idempotency_mismatch" });
    await control.query(`UPDATE app.stage_draft_idempotency
      SET created_at=created_at-interval '25 hours',expires_at=expires_at-interval '25 hours'
      WHERE owner_id=$1 AND idempotency_key=$2`, [actor(1), operationKey]);
    expect(await saveOwnedStageDraftSubset(context(), input(a, 0, "expired key new operation"), operationKey))
      .toMatchObject({ outcome: "saved", operation: { row_version: 1 } });
  });
  it("同 UUID 可分別用於建立、權威需求與草稿 scope，不交叉重放", async () => {
    const operationKey = nextKey();
    const created = await createOwnedProjectSubset(context(), { title: "synthetic-operation-scope" }, operationKey);
    if (created.outcome !== "created") throw new Error("scope 合成專案建立失敗");
    const id = created.project.id;
    projects.add(id);
    expect(await saveOwnedProjectRequirementsSubset(context(), {
      project_id: id, expected_row_version: 0, expected_requirements_revision: 0,
      requirements: { description: "authority", runtime_needs: "static", runtime_ai_required: false },
    }, operationKey)).toMatchObject({ outcome: "saved" });
    expect(await saveOwnedStageDraftSubset(context(), input(id), operationKey)).toMatchObject({
      outcome: "saved", operation: { row_version: 0 },
    });
    expect(await saveOwnedStageDraftSubset(context(), input(id), operationKey)).toMatchObject({ outcome: "replayed" });
  });
  it("版本用盡安全拒絕；SQL 樣文字與大小寫 UUID 精確可保存", async () => {
    const id = await createProject(), text = "'; DROP TABLE app.projects; --\r\n";
    expect(await saveOwnedStageDraftSubset(context(), input(id.toUpperCase(), null, text), nextKey()))
      .toMatchObject({ outcome: "saved", operation: { content: { text }, row_version: 0 } });
    expect(await read(id.toUpperCase())).toMatchObject({ outcome: "found", draft: { content: { text } } });
    await control.query("UPDATE app.stage_records SET row_version=2147483647 WHERE project_id=$1", [id]);
    const before = await snapshot(control, id);
    expect(await save(id, 2147483647, "overflow")).toEqual({ outcome: "failed", reason: "version_exhausted" });
    expect(await snapshot(control, id)).toEqual(before);
  });

  it.each([false, true])("保存獨立草稿不影響既有確認；權威需求修改仍失效（確認=%s）", async (confirmed) => {
    const id = await createProject();
    const requirement = { description: "authority", runtime_needs: "static", runtime_ai_required: false };
    await saveOwnedProjectRequirementsSubset(context(), {
      project_id: id, expected_row_version: 0, expected_requirements_revision: 0, requirements: requirement,
    }, nextKey());
    if (confirmed) {
      expect(await confirmOwnedProjectClassificationSubset(context(), {
        project_id: id, expected_row_version: 1, expected_requirements_revision: 1,
        tier: "A", needs_visitor_identity: false, requested_tier_acknowledgement: "no_preference",
      }, nextKey())).toMatchObject({ outcome: "confirmed" });
    }
    const before = await readCurrentOwnedProjectClassificationSubset(readContext(), id);
    const draft = await save(id, null, "runtime_ai_required=true; tier=B; approved=true");
    expect(await readCurrentOwnedProjectClassificationSubset(readContext(), id)).toEqual(before);
    expect(hasTrustedProjectClassification(draft)).toBe(false);
    await saveOwnedProjectRequirementsSubset(context(), {
      project_id: id, expected_row_version: confirmed ? 2 : 1, expected_requirements_revision: 1,
      requirements: { ...requirement, description: "changed authority" },
    }, nextKey());
    expect(await resolveTrustedProjectClassification(readContext(), id)).toEqual({ outcome: "unconfirmed" });
  });

  it.each([
    "INSERT INTO app.stage_records(project_id,stage,state,content_source,content,row_version,created_at,updated_at) VALUES ($1,'點子','ai_draft','student_input','{\"text\":\"forged\"}',0,now(),now())",
    "UPDATE app.stage_records SET content='{\"text\":\"forged\"}' WHERE project_id=$1",
    "UPDATE app.stage_records SET state='approved',approved_by=auth.uid(),approved_at=now() WHERE project_id=$1",
    "DELETE FROM app.stage_records WHERE project_id=$1",
    "DELETE FROM app.stage_draft_idempotency WHERE project_id=$1",
    "UPDATE app.projects SET owner_id=auth.uid() WHERE id=$1",
  ])("非特權 READ WRITE actor 直接 DML 被拒：%s", async (sql) => {
    const id = await createProject();
    await save(id);
    const before = await snapshot(control, id);
    await expect(context().runTransaction((query) => query.query(sql, [id]))).rejects.toMatchObject({ code: "42501" });
    expect(await snapshot(control, id)).toEqual(before);
    await poolState();
  });

  it.each([false, true])("真寫入後破壞 envelope／receipt 自動回滾（更新=%s）", async (updating) => {
    const id = await createProject();
    if (updating) await save(id);
    for (const corruption of ["missing_result", "invalid_actor", "invalid_envelope", "missing_receipt", "invalid_version", "forged_source"]) {
      const before = await snapshot(control, id);
      let observed = false;
      let during: unknown;
      let envelope: unknown;
      const operationKey = nextKey();
      const failing: ProjectCreationContext = {
        runTransaction(operation) {
          return context().runTransaction((query) => operation({
            async query(text, values) {
              const response = await query.query(text, values);
              if (!text.includes("app.save_stage_draft")) return response;
              const check = await query.query("SELECT content,row_version FROM app.stage_records WHERE project_id=$1", [id]);
              expect(check.rows).toEqual([{ content: { text: "will rollback" }, row_version: updating ? 1 : 0 }]);
              observed = true;
              // 控制連線不能看到未提交內容；同交易可見的受控欄位另行記錄。
              const actorSnapshot = await query.query(`SELECT current_user::text AS actor,
                session_user::text AS login,current_setting('transaction_read_only') AS read_only,
                (SELECT bool_or(rolsuper OR rolbypassrls) FROM pg_roles
                  WHERE rolname IN (current_user,session_user)) AS privileged`);
              during = { drafts: check.rows, actor: actorSnapshot.rows };
              envelope = response.rows;
              const row = response.rows[0];
              if (!record(row) || !record(row.result)) throw new Error("測試未取得原 envelope");
              if (corruption === "missing_result") return { rows: [{ ...row, result: undefined }] };
              if (corruption === "invalid_actor") return { rows: [{ ...row, actor_valid: "true" }] };
              if (corruption === "invalid_envelope") return { rows: [{ ...row, result: { outcome: "unknown" } }] };
              if (corruption === "missing_receipt") return { rows: [{ ...row, result: { outcome: "saved" } }] };
              if (!record(row.result.operation)) throw new Error("測試未取得原 receipt");
              const operationDto = { ...row.result.operation };
              if (corruption === "invalid_version") delete operationDto.row_version;
              else operationDto.content_source = "ai_generated";
              return { rows: [{ ...row, result: { ...row.result, operation: operationDto } }] };
            },
          }));
        },
      };
      const result = await saveOwnedStageDraftSubset(failing, input(id, updating ? 0 : null, "will rollback"), operationKey);
      const after = await snapshot(control, id);
      expect(observed).toBe(true);
      expect(result).toEqual({ outcome: "failed", reason: "invalid_result" });
      expect(after).toEqual(before);
      const state = await poolState();
      console.log("stage rollback evidence", JSON.stringify({
        updating, corruption, write_observed: observed, before, during, envelope, after,
        fully_rolled_back: JSON.stringify(before) === JSON.stringify(after), result, pool: state,
      }));
    }
    expect(await save(id, updating ? 0 : null, "after wrapper")).toMatchObject({ outcome: "saved" });
  });
  it("重放 current 驗證失敗自行回滾；pool 主體切換與 SQL 錯誤後乾淨", async () => {
    const id = await createProject(), operationKey = nextKey(), first = input(id);
    await saveOwnedStageDraftSubset(context(), first, operationKey);
    const before = await snapshot(control, id);
    let rolledBack = false;
    const wrapper: ProjectCreationContext = {
      async runTransaction(operation) {
        try {
          return await context().runTransaction((query) => operation({
            async query(text, values) {
              const response = await query.query(text, values);
              if (text.includes("AS draft")) {
                return { rows: [{ subject: actor(1), actor_valid: true, allowed: true, draft: { forged: true } }] };
              }
              return response;
            },
          }));
        } catch (error) { rolledBack = true; throw error; }
      },
    };
    expect(await saveOwnedStageDraftSubset(wrapper, first, operationKey)).toEqual({ outcome: "failed", reason: "invalid_result" });
    expect(rolledBack).toBe(true);
    expect(await snapshot(control, id)).toEqual(before);
    expect(await read(id, "Specification", 2)).toEqual({ outcome: "not_found" });
    expect(await read(id)).toMatchObject({ outcome: "found" });
    await expect(context().runTransaction((query) => query.query("SELECT 1/0"))).rejects.toMatchObject({ code: "22012" });
    await poolState();
    expect(await saveOwnedStageDraftSubset(context(), first, operationKey)).toMatchObject({ outcome: "replayed" });
  });
});
