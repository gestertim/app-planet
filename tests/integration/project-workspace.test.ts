import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { setTimeout as delay } from "node:timers/promises";
import {
  createOwnedProjectSubset, saveOwnedProjectRequirementsSubset, confirmOwnedProjectClassificationSubset,
  readOwnedProjectWorkspaceSubset, resolveTrustedProjectClassification, hasTrustedProjectClassification,
  type ProjectCreationContext,
} from "../../apps/web/src/server/projects.ts";
import { saveOwnedStageDraftSubset } from "../../apps/web/src/server/stage-drafts.ts";
import type { AuthorizationContext } from "../../apps/web/src/server/authorization.ts";
import { projectStageSchema } from "@app-planet/core";
import { inspectConnection, localPools, syntheticContext, syntheticCreationContext } from "./authorization-context.ts";

const { control, authorization, parallelAuthorization } = localPools();
const actor = (n: number) => `a2000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const school = (n: number) => `a3000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const key = () => `a4000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}`;
let sequence = 0;
const projects = new Set<string>();
const writeContext = (n = 1) => syntheticCreationContext(authorization, actor(n));
const readContext = (n = 1) => syntheticContext(authorization, actor(n));
const requirements = (description = "需求 🌍 e\u0301\r\n") => ({
  description, runtime_needs: "static", runtime_ai_required: false,
});
async function create() {
  const result = await createOwnedProjectSubset(writeContext(), { title: "synthetic-workspace-46" }, key());
  if (result.outcome !== "created") throw new Error("合成專案建立失敗");
  projects.add(result.project.id);
  return result.project.id;
}
async function saveRequirement(id: string, rowVersion: number, revision: number, description?: string,
  context: ProjectCreationContext = writeContext()) {
  const result = await saveOwnedProjectRequirementsSubset(context, {
    project_id: id, expected_row_version: rowVersion, expected_requirements_revision: revision,
    requirements: requirements(description),
  }, key());
  expect(result.outcome).toBe("saved");
  return result;
}
async function confirm(id: string, rowVersion: number, revision: number) {
  const result = await confirmOwnedProjectClassificationSubset(writeContext(), {
    project_id: id, expected_row_version: rowVersion, expected_requirements_revision: revision,
    tier: "A", needs_visitor_identity: false, requested_tier_acknowledgement: "no_preference",
  }, key());
  expect(result.outcome).toBe("confirmed");
}
async function saveDraft(id: string, stage: string, text: string, version: number | null = null,
  context: ProjectCreationContext = writeContext()) {
  const result = await saveOwnedStageDraftSubset(context, {
    project_id: id, stage, expected_row_version: version, content: { text },
  }, key());
  expect(result.outcome).toBe("saved");
}
const read = (id: string, n = 1) => readOwnedProjectWorkspaceSubset(readContext(n), id);
const tables = [
  "project_requirements", "project_classification_confirmations", "project_classification_idempotency",
  "stage_records", "stage_draft_idempotency", "project_create_idempotency",
];
async function snapshot(id: string) {
  const result = await control.query(`SELECT jsonb_build_object(
    'project', (SELECT to_jsonb(p) FROM app.projects p WHERE id=$1),
    ${tables.map((table) => `'${table}', (SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text), '[]')
      FROM app.${table} t WHERE project_id=$1)`).join(",")}
  ) AS data`, [id]);
  return result.rows;
}
async function poolState() {
  for (const [pool, count] of [[authorization, 1], [parallelAuthorization, 8]] as const) {
    const clients = await Promise.all(Array.from({ length: count }, () => pool.connect()));
    try {
      for (const client of clients) {
        const state = await inspectConnection(client);
        expect(state).toMatchObject({
          actor: "app_authorization_test", login: "app_authorization_test", sub: null, claims: null,
        });
        const activity = await control.query("SELECT state,xact_start FROM pg_stat_activity WHERE pid=$1", [state.pid]);
        expect(activity.rows).toEqual([{ state: "idle", xact_start: null }]);
      }
    } finally { for (const client of clients) client.release(); }
  }
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

beforeAll(async () => {
  for (const n of [1, 2]) await control.query(`
    INSERT INTO app.schools(id,label,approval_state,approval_epoch,created_at,updated_at)
    VALUES ($1,'synthetic-workspace-school','approved',1,now(),now())`, [school(n)]);
  for (const n of [1, 2, 3, 4, 5]) {
    await control.query("INSERT INTO auth.users(id) VALUES ($1)", [actor(n)]);
    await control.query(`INSERT INTO app.profiles
      (id,role,status,deletion_state,school_id,display_label,status_changed_at)
      VALUES ($1,$2,'approved','none',$3,'synthetic-workspace-actor',now())`,
    [actor(n), n === 4 ? "teacher" : n === 5 ? "admin" : "student", n === 3 ? school(2) : school(1)]);
  }
  const permissions = await control.query(`
    SELECT r.relname,r.relrowsecurity,r.relforcerowsecurity,
      has_table_privilege('authenticated',r.oid,'INSERT') AS can_insert,
      has_any_column_privilege('authenticated',r.oid,'UPDATE') AS can_update,
      has_table_privilege('authenticated',r.oid,'DELETE') AS can_delete,
      has_table_privilege('authenticated',r.oid,'SELECT') AS table_select
    FROM pg_class r JOIN pg_namespace n ON n.oid=r.relnamespace
    WHERE n.nspname='app' AND r.relname=ANY($1::text[]) ORDER BY r.relname`,
  [["projects", ...tables]]);
  expect(permissions.rows).toHaveLength(7);
  for (const row of permissions.rows) expect(row).toMatchObject({
    relrowsecurity: true, relforcerowsecurity: true, can_insert: false, can_update: false, can_delete: false,
  });
  const columns = await control.query(`SELECT table_name,column_name FROM information_schema.column_privileges
    WHERE grantee='authenticated' AND table_schema='app' AND privilege_type='SELECT'
      AND table_name IN ('projects','project_requirements','project_classification_confirmations','stage_records')
    ORDER BY table_name,column_name`);
  console.log("workspace existing RLS and column grants", JSON.stringify({ tables: permissions.rows, columns: columns.rows }));
});
afterEach(async () => {
  await control.query("SELECT pg_advisory_unlock_all()");
  const ids = [...projects];
  if (ids.length) {
    await control.query(`UPDATE app.projects SET classification_state='unconfirmed',
      tier=NULL,needs_visitor_identity=NULL,current_confirmation_id=NULL WHERE id=ANY($1::uuid[])`, [ids]);
    for (const table of ["stage_draft_idempotency", "stage_records", "project_classification_idempotency",
      "project_classification_confirmations", "project_requirements", "project_create_idempotency"]) {
      await control.query(`DELETE FROM app.${table} WHERE project_id=ANY($1::uuid[])`, [ids]);
    }
    await control.query("DELETE FROM app.projects WHERE id=ANY($1::uuid[])", [ids]);
    projects.clear();
  }
  await control.query("UPDATE app.profiles SET status='approved',deletion_state='none' WHERE id=ANY($1::uuid[])",
    [[1, 2, 3, 4, 5].map(actor)]);
  await control.query("UPDATE app.schools SET approval_state='approved' WHERE id=ANY($1::uuid[])", [[school(1), school(2)]]);
});
afterAll(async () => {
  try {
    await poolState();
    for (const n of [1, 2, 3, 4, 5]) {
      await control.query("DELETE FROM app.profiles WHERE id=$1", [actor(n)]);
      await control.query("DELETE FROM auth.users WHERE id=$1", [actor(n)]);
    }
    await control.query("DELETE FROM app.schools WHERE id=ANY($1::uuid[])", [[school(1), school(2)]]);
    console.log("workspace pool role/claim/transaction clean: 9 sockets");
  } finally {
    await Promise.all([authorization.end(), parallelAuthorization.end(), control.end()]);
  }
});

describe("工作區單一 snapshot 真實隔離 PostgreSQL", () => {
  it("新專案無需求／草稿為合法結果；讀前後完整資料不變", async () => {
    const id = await create();
    const before = await snapshot(id);
    expect(await read(id)).toMatchObject({ outcome: "found", workspace: {
      project: { id, row_version: 0, stage: "點子" }, requirements: null,
      classification: { state: "unconfirmed", tier: null, needs_visitor_identity: null }, drafts: [],
    } });
    expect(await snapshot(id)).toEqual(before);
    expect(await read(actor(99))).toEqual({ outcome: "not_found" });
  });
  it("九步新交易讀回空字串／空白／Unicode，各版本互不代用且不寫資料", async () => {
    const id = await create();
    await saveRequirement(id, 0, 0);
    await confirm(id, 1, 1);
    const texts = ["", " \t\r\n", "🌍 e\u0301 繁體中文\r\n", "'; DELETE FROM app.projects; --", "五", "六", "七", "八", "九"];
    for (const [i, stage] of projectStageSchema.options.entries()) await saveDraft(id, stage, texts[i]);
    await saveDraft(id, "Specification", texts[2], 0);
    const before = await snapshot(id);
    const first = await read(id);
    expect(first.outcome).toBe("found");
    if (first.outcome !== "found") throw new Error("工作區讀取失敗");
    expect(first.workspace.project.row_version).toBe(2);
    expect(first.workspace.requirements).toEqual({ revision: 1, content: requirements() });
    expect(first.workspace.drafts.map((d) => d.content.text)).toEqual(texts);
    expect(first.workspace.drafts.map((d) => d.row_version)).toEqual([0, 0, 1, 0, 0, 0, 0, 0, 0]);
    expect(first.workspace.drafts.every((d) => d.state === "ai_draft" && d.content_source === "student_input")).toBe(true);
    expect(await read(id)).toEqual(first);
    expect(await snapshot(id)).toEqual(before);
    for (const value of [first.workspace.classification, { ...first.workspace.classification },
      JSON.parse(JSON.stringify(first.workspace.classification)), first.workspace]) {
      expect(hasTrustedProjectClassification(value)).toBe(false);
    }
    const trusted = await resolveTrustedProjectClassification(readContext(), id);
    expect(trusted.outcome).toBe("trusted");
    if (trusted.outcome === "trusted") expect(hasTrustedProjectClassification(trusted.classification)).toBe(true);
    console.log("workspace nine stages exact text, independent versions, read-only snapshots verified");
  });
  it("legacy_unverified 舊值保留，無草稿不補空草稿；負專案版本相容", async () => {
    const id = await create();
    await control.query(`UPDATE app.projects SET classification_state='legacy_unverified',
      tier='B',needs_visitor_identity=true,row_version=-3 WHERE id=$1`, [id]);
    expect(await read(id)).toMatchObject({ outcome: "found", workspace: {
      project: { row_version: -3 }, requirements: null, drafts: [],
      classification: { state: "legacy_unverified", requested_tier: null, tier: "B", needs_visitor_identity: true },
    } });
  });
  it.each([2, 3, 4, 5])("同校／跨校／教師／管理員 %i 不得取得內容，偽造 claim 無效", async (n) => {
    const id = await create();
    await saveRequirement(id, 0, 0);
    await saveDraft(id, "Specification", "private synthetic");
    const expected = n < 4 ? { outcome: "not_found" } : { outcome: "denied", reason: "policy_denied" };
    expect(await read(id, n)).toEqual(expected);
    expect(await readOwnedProjectWorkspaceSubset(syntheticContext(authorization, actor(n), {
      claims: { role: "student", owner_id: actor(1), school_id: school(1), allowed: true },
    }), id)).toEqual(expected);
    expect((await readContext(n).runReadOnly((q) => q.query("SELECT content FROM app.stage_records WHERE project_id=$1", [id]))).rows)
      .toEqual([]);
  });
  it.each(["disabled", "marked", "unconfirmed"])("已開啟交易中控制連線提交 %s，下一 statement 立即拒絕", async (condition) => {
    const id = await create();
    await saveDraft(id, "點子", "");
    expect((await read(id)).outcome).toBe("found");
    const context: AuthorizationContext = {
      runReadOnly(operation) {
        return readContext().runReadOnly(async (query) => {
          await query.query("SELECT 1");
          if (condition === "disabled") await control.query("UPDATE app.profiles SET status='disabled' WHERE id=$1", [actor(1)]);
          else if (condition === "marked") await control.query("UPDATE app.profiles SET deletion_state='marked' WHERE id=$1", [actor(1)]);
          else await control.query("UPDATE app.schools SET approval_state='unconfirmed' WHERE id=$1", [school(1)]);
          return operation(query);
        });
      },
    };
    expect(await readOwnedProjectWorkspaceSubset(context, id)).toEqual({ outcome: "denied", reason: "policy_denied" });
    expect(await read(id)).toEqual({ outcome: "denied", reason: "policy_denied" });
  });
  it.each(["withdrawn", "expired"])("%s 沿既有 read_saved_content 能力，不提升 AI 權限", async (state) => {
    const id = await create();
    await saveDraft(id, "點子", " \t");
    await control.query("UPDATE app.schools SET approval_state=$2 WHERE id=$1", [school(1), state]);
    expect(await read(id)).toMatchObject({ outcome: "found", workspace: { drafts: [{ content: { text: " \t" } }] } });
    expect((await readContext().runReadOnly((q) => q.query("SELECT app.current_account_gate('ai_call') AS allowed"))).rows)
      .toEqual([{ allowed: false }]);
  });
  it("需求修改後新交易立即 unconfirmed；舊普通 DTO 不成為永久資格", async () => {
    const id = await create();
    await saveRequirement(id, 0, 0, "old");
    await confirm(id, 1, 1);
    const old = await read(id);
    expect(old).toMatchObject({ outcome: "found", workspace: { classification: { state: "confirmed" } } });
    await saveRequirement(id, 2, 1, "new");
    expect(await read(id)).toMatchObject({ outcome: "found", workspace: {
      project: { row_version: 3 }, requirements: { revision: 2, content: requirements("new") },
      classification: { state: "unconfirmed", tier: null, needs_visitor_identity: null },
    } });
    expect(await resolveTrustedProjectClassification(readContext(), id)).toEqual({ outcome: "unconfirmed" });
    expect(hasTrustedProjectClassification(old)).toBe(false);
  });
  it("真實 DB 缺當前需求或確認內容矛盾，整份失敗而不是合法缺資料", async () => {
    const id = await create();
    await saveDraft(id, "Specification", "不能部分交付");
    await saveRequirement(id, 0, 0);
    await control.query("UPDATE app.projects SET requirements_revision=99 WHERE id=$1", [id]);
    const missing = await snapshot(id);
    expect(await read(id)).toEqual({ outcome: "failed", reason: "invalid_result" });
    expect(await snapshot(id)).toEqual(missing);
    await control.query("UPDATE app.projects SET requirements_revision=1 WHERE id=$1", [id]);
    await confirm(id, 1, 1);
    const corrupted = await control.query(`INSERT INTO app.project_classification_confirmations (
      id,project_id,requirements_revision,requirements_description,requirements_runtime_needs,
      requirements_runtime_ai_required,requested_tier_at_confirmation,requested_tier_acknowledgement,
      tier,needs_visitor_identity,confirmed_by,confirmed_at,source
    ) SELECT gen_random_uuid(),project_id,requirements_revision,'synthetic mismatched evidence',
      requirements_runtime_needs,requirements_runtime_ai_required,requested_tier_at_confirmation,
      requested_tier_acknowledgement,tier,needs_visitor_identity,confirmed_by,confirmed_at,source
      FROM app.project_classification_confirmations WHERE project_id=$1 RETURNING id`, [id]);
    await control.query("UPDATE app.projects SET current_confirmation_id=$2 WHERE id=$1", [id, corrupted.rows[0].id]);
    const contradictory = await snapshot(id);
    expect(await read(id)).toEqual({ outcome: "failed", reason: "invalid_result" });
    expect(await snapshot(id)).toEqual(contradictory);
  });
  it("真實併發：查詢等待中原子更新並提交需求／分類失效／草稿，不得拼接兩時點", async () => {
    const id = await create();
    await saveRequirement(id, 0, 0, "old");
    await confirm(id, 1, 1);
    await saveDraft(id, "Specification", "old");
    const old = await read(id);
    await control.query("SELECT pg_advisory_lock(460024)");
    let dispatched: () => void = () => { throw new Error("同步點未建立"); };
    const started = new Promise<void>((resolve) => { dispatched = resolve; });
    let calls = 0;
    const paused: AuthorizationContext = {
      runReadOnly(operation) {
        return syntheticContext(parallelAuthorization, actor(1)).runReadOnly((query) => operation({
          async query(sql, values) {
            calls++;
            const pending = query.query(`WITH workspace_pause_46 AS MATERIALIZED (
              SELECT pg_advisory_xact_lock(460024)
            ) SELECT snapshot.* FROM workspace_pause_46 CROSS JOIN LATERAL (${sql}) snapshot`, values);
            dispatched();
            return pending;
          },
        }));
      },
    };
    const pending = readOwnedProjectWorkspaceSubset(paused, id);
    let blocked = false;
    try {
      await started;
      for (let i = 0; i < 100; i++) {
        const activity = await control.query(`SELECT count(*)::int AS count FROM pg_stat_activity
          WHERE usename='app_authorization_test' AND wait_event='advisory'
            AND query LIKE '%workspace_pause_46%'`);
        if (activity.rows[0].count === 1) { blocked = true; break; }
        await delay(10);
      }
      expect(blocked).toBe(true);
      await writeContext().runTransaction(async (query) => {
        const atomic: ProjectCreationContext = { async runTransaction(op) { return op(query); } };
        await saveRequirement(id, 2, 1, "new", atomic);
        await saveDraft(id, "Specification", "new", 0, atomic);
      });
    } finally { await control.query("SELECT pg_advisory_unlock(460024)"); }
    const during = await pending;
    expect(calls).toBe(1);
    expect(during).toEqual(old);
    expect(await read(id)).toMatchObject({ outcome: "found", workspace: {
      project: { row_version: 3 }, requirements: { revision: 2, content: requirements("new") },
      classification: { state: "unconfirmed", tier: null },
      drafts: [{ stage: "Specification", row_version: 1, content: { text: "new" } }],
    } });
    console.log("workspace concurrency verified: actual advisory wait, writer committed while read statement pending; old snapshot then current new snapshot");
  });
  it.each(["envelope", "field", "duplicate", "contradiction", "confirmation"])(
    "執行真 SQL 後僅破壞 %s，全份安全失敗且 DB 不變", async (fault) => {
      const id = await create();
      await saveRequirement(id, 0, 0);
      await confirm(id, 1, 1);
      await saveDraft(id, "Specification", "");
      const before = await snapshot(id);
      const poisoned: AuthorizationContext = {
        runReadOnly(operation) {
          return readContext().runReadOnly((query) => operation({
            async query(sql, values) {
              const result = await query.query(sql, values);
              const row = result.rows[0];
              if (!record(row) || !record(row.project) || !Array.isArray(row.drafts) ||
                !record(row.project.confirmation)) throw new Error("真 SQL 回傳不符合測試前置");
              if (fault === "envelope") return { rows: [null] };
              if (fault === "field") row.meta = "private SQL driver synthetic";
              if (fault === "duplicate") row.drafts.push(row.drafts[0]);
              if (fault === "contradiction") row.project.requirements_revision = 999;
              if (fault === "confirmation") row.project.confirmation.requirements_match = false;
              return result;
            },
          }));
        },
      };
      expect(await readOwnedProjectWorkspaceSubset(poisoned, id)).toEqual({ outcome: "failed", reason: "invalid_result" });
      expect(await snapshot(id)).toEqual(before);
      expect((await read(id)).outcome).toBe("found");
    },
  );
  it("真 SQL 故障不洩漏錯誤，後續池角色／claim／交易乾淨", async () => {
    const id = await create();
    expect(await readOwnedProjectWorkspaceSubset(syntheticContext(authorization, actor(1), { fault: "sql" }), id))
      .toEqual({ outcome: "failed", reason: "dependency_failure" });
    expect((await read(id)).outcome).toBe("found");
    await poolState();
  });
});
