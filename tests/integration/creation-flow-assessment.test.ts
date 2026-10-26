import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { setTimeout as delay } from "node:timers/promises";
import {
  confirmOwnedProjectClassificationSubset,
  createOwnedProjectSubset,
  hasTrustedProjectClassification,
  readOwnedProjectCreationFlowAssessmentSubset,
  saveOwnedProjectRequirementsSubset,
  type ProjectCreationContext,
} from "../../apps/web/src/server/projects.ts";
import { saveOwnedStageDraftSubset } from "../../apps/web/src/server/stage-drafts.ts";
import type { AuthorizationContext } from "../../apps/web/src/server/authorization.ts";
import { inspectConnection, localPools, syntheticContext, syntheticCreationContext } from "./authorization-context.ts";

const { control, authorization, parallelAuthorization } = localPools();
const actor = (n: number) => `a5000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const school = (n: number) => `a6000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const key = () => `a7000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}`;
let sequence = 0;
const projects = new Set<string>();
const writeContext = (n = 1) => syntheticCreationContext(authorization, actor(n));
const readContext = (n = 1) => syntheticContext(authorization, actor(n));
const read = (projectId: unknown, requestedStage: unknown, n = 1) =>
  readOwnedProjectCreationFlowAssessmentSubset(readContext(n), {
    project_id: projectId,
    requested_stage: requestedStage,
  });
const requirements = (tier: "A" | "B" = "A", description = "synthetic requirement text") => ({
  description,
  runtime_needs: tier === "A" ? "static" as const : "work_data_api" as const,
  runtime_ai_required: false,
});
const projectTables = [
  "project_requirements", "project_classification_confirmations", "project_classification_idempotency",
  "stage_records", "stage_draft_idempotency", "project_create_idempotency",
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function create() {
  const result = await createOwnedProjectSubset(writeContext(), { title: "synthetic-creation-flow" }, key());
  if (result.outcome !== "created") throw new Error("合成專案建立前置條件失敗");
  projects.add(result.project.id);
  return result.project.id;
}

async function saveRequirements(projectId: string, rowVersion: number, revision: number,
  content = requirements(), context: ProjectCreationContext = writeContext()) {
  return saveOwnedProjectRequirementsSubset(context, {
    project_id: projectId,
    expected_row_version: rowVersion,
    expected_requirements_revision: revision,
    requirements: content,
  }, key());
}

async function confirm(projectId: string, rowVersion: number, revision: number, tier: "A" | "B") {
  return confirmOwnedProjectClassificationSubset(writeContext(), {
    project_id: projectId,
    expected_row_version: rowVersion,
    expected_requirements_revision: revision,
    tier,
    needs_visitor_identity: tier === "B",
    requested_tier_acknowledgement: "no_preference",
  }, key());
}

async function saveDraft(projectId: string, stage: string, text: string, rowVersion: number | null = null,
  context: ProjectCreationContext = writeContext()) {
  return saveOwnedStageDraftSubset(context, {
    project_id: projectId,
    stage,
    expected_row_version: rowVersion,
    content: { text },
  }, key());
}

async function snapshot(projectId: string) {
  const result = await control.query(`SELECT jsonb_build_object(
    'project', (SELECT to_jsonb(p) FROM app.projects p WHERE id=$1),
    ${projectTables.map((table) => `'${table}', (SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text), '[]')
      FROM app.${table} t WHERE project_id=$1)`).join(",")}
  ) AS data`, [projectId]);
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
    } finally {
      for (const client of clients) client.release();
    }
  }
}

beforeAll(async () => {
  for (const n of [1, 2]) await control.query(`
    INSERT INTO app.schools(id,label,approval_state,approval_epoch,created_at,updated_at)
    VALUES ($1,'synthetic-creation-flow-school','approved',1,now(),now())`, [school(n)]);
  for (const n of [1, 2, 3, 4, 5]) {
    await control.query("INSERT INTO auth.users(id) VALUES ($1)", [actor(n)]);
    await control.query(`INSERT INTO app.profiles
      (id,role,status,deletion_state,school_id,display_label,status_changed_at)
      VALUES ($1,$2,'approved','none',$3,'synthetic-creation-flow-actor',now())`,
    [actor(n), n === 4 ? "teacher" : n === 5 ? "admin" : "student", n === 3 ? school(2) : school(1)]);
  }
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
  await control.query("UPDATE app.schools SET approval_state='approved' WHERE id=ANY($1::uuid[])",
    [[school(1), school(2)]]);
});

afterAll(async () => {
  try {
    await poolState();
    for (const n of [1, 2, 3, 4, 5]) {
      await control.query("DELETE FROM app.profiles WHERE id=$1", [actor(n)]);
      await control.query("DELETE FROM auth.users WHERE id=$1", [actor(n)]);
    }
    await control.query("DELETE FROM app.schools WHERE id=ANY($1::uuid[])", [[school(1), school(2)]]);
    console.log("creation-flow assessment pool role/claim/transaction clean: 9 sockets");
  } finally {
    await Promise.all([authorization.end(), parallelAuthorization.end(), control.end()]);
  }
});

describe("創作旅程唯讀評估隔離 PostgreSQL 整合", () => {
  it("新專案沒有需求／草稿時回合法缺證據與未支援評估，且不寫資料", async () => {
    const id = await create();
    const before = await snapshot(id);
    const result = await read(id, "點子");
    expect(result).toMatchObject({
      outcome: "evaluated",
      snapshot: "single_statement",
      project_id: id,
      row_version: 0,
      requirements_revision: 0,
      assessment: {
        outcome: "evaluated",
        evidence_assurance: "structural_only",
        stage_assessment: { outcome: "unsupported", reason: "stage_completion_rules_undecided" },
        classification_assessment: {
          outcome: "missing_evidence",
          reason: "current_student_confirmation_required",
        },
        work_scope_assessment: {
          outcome: "missing_evidence",
          reason: "current_classification_confirmation_required",
        },
        observed_drafts: [],
      },
    });
    expect(await snapshot(id)).toEqual(before);
  });

  it.each(["A", "B"] as const)("同一快照組合有效 %s 確認與獨立草稿，不輸出本文或確認人", async (tier) => {
    const id = await create();
    const content = requirements(tier, `private ${tier} requirement`);
    expect((await saveRequirements(id, 0, 0, content)).outcome).toBe("saved");
    expect((await confirm(id, 1, 1, tier)).outcome).toBe("confirmed");
    expect((await saveDraft(id, "Specification", "private draft text")).outcome).toBe("saved");
    const before = await snapshot(id);
    const result = await read(id, "A/B");
    expect(result).toMatchObject({
      outcome: "evaluated",
      snapshot: "single_statement",
      project_id: id,
      row_version: 2,
      requirements_revision: 1,
      assessment: {
        outcome: "evaluated",
        evidence_assurance: "structural_only",
        requested_stage: "A/B",
        stage_assessment: { outcome: "unsupported", reason: "stage_completion_rules_undecided" },
        classification_assessment: { outcome: "satisfied", tier, requirements_revision: 1 },
        work_scope_assessment: { outcome: "satisfied", reasons: [] },
        observed_drafts: [{ stage: "Specification", state: "ai_draft", content_source: "student_input" }],
      },
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("private requirement");
    expect(serialized).not.toContain("private draft text");
    expect(serialized).not.toContain(actor(1));
    expect(serialized).not.toMatch(/confirmed_by|requirements_snapshot|sqlstate|driver_error|meta|trusted/i);
    expect(hasTrustedProjectClassification(result)).toBe(false);
    expect(await snapshot(id)).toEqual(before);
  });

  it("草稿不等於確認或批准，後段草稿不跳過前置條件", async () => {
    const id = await create();
    expect((await saveDraft(id, "Final Pack", "unapproved synthetic draft")).outcome).toBe("saved");
    expect(await read(id, "Final Pack")).toMatchObject({
      outcome: "evaluated",
      assessment: {
        outcome: "evaluated",
        requested_stage: "Final Pack",
        stage_assessment: {
          outcome: "missing_evidence",
          evidence: "current_classification_confirmation",
        },
        classification_assessment: { outcome: "missing_evidence" },
        observed_drafts: [{ stage: "Final Pack", state: "ai_draft", content_source: "student_input" }],
      },
    });
  });

  it("legacy_unverified 不升格為 confirmed", async () => {
    const id = await create();
    await control.query(`UPDATE app.projects SET classification_state='legacy_unverified',
      tier='B',needs_visitor_identity=true WHERE id=$1`, [id]);
    expect(await read(id, "A/B")).toMatchObject({
      outcome: "evaluated",
      assessment: {
        outcome: "evaluated",
        classification_assessment: { outcome: "missing_evidence" },
        work_scope_assessment: { outcome: "missing_evidence" },
      },
    });
  });

  it("需求修改使舊確認失效，新交易只評估目前缺確認狀態", async () => {
    const id = await create();
    expect((await saveRequirements(id, 0, 0)).outcome).toBe("saved");
    expect((await confirm(id, 1, 1, "A")).outcome).toBe("confirmed");
    expect(await read(id, "A/B")).toMatchObject({
      assessment: { classification_assessment: { outcome: "satisfied" } },
    });
    expect((await saveRequirements(id, 2, 1, requirements("A", "changed requirement"))).outcome).toBe("saved");
    expect(await read(id, "A/B")).toMatchObject({
      outcome: "evaluated",
      row_version: 3,
      requirements_revision: 2,
      assessment: {
        classification_assessment: { outcome: "missing_evidence" },
        stage_assessment: { outcome: "missing_evidence" },
      },
    });
  });

  it("同校／跨校其他學生不得得知專案存在，教師／管理員無讀取捷徑", async () => {
    const id = await create();
    await saveRequirements(id, 0, 0);
    await saveDraft(id, "點子", "private content");
    for (const n of [2, 3, 4, 5]) {
      const expected = n < 4 ? { outcome: "not_found" } : { outcome: "denied", reason: "policy_denied" };
      expect(await read(id, "點子", n)).toEqual(expected);
      expect(await readOwnedProjectCreationFlowAssessmentSubset(
        syntheticContext(authorization, actor(n), {
          claims: { role: "student", owner_id: actor(1), school_id: school(1), allowed: true },
        }),
        { project_id: id, requested_stage: "點子" },
      )).toEqual(expected);
    }
  });

  it.each(["disabled", "marked", "unconfirmed"] as const)(
    "新交易重新讀取當下帳號／學校狀態（%s）", async (condition) => {
      const id = await create();
      const context: AuthorizationContext = {
        runReadOnly(operation) {
          return readContext().runReadOnly(async (query) => {
            await query.query("SELECT 1");
            if (condition === "disabled") await control.query(
              "UPDATE app.profiles SET status='disabled' WHERE id=$1", [actor(1)],
            );
            else if (condition === "marked") await control.query(
              "UPDATE app.profiles SET deletion_state='marked' WHERE id=$1", [actor(1)],
            );
            else await control.query(
              "UPDATE app.schools SET approval_state='unconfirmed' WHERE id=$1", [school(1)],
            );
            return operation(query);
          });
        },
      };
      expect(await readOwnedProjectCreationFlowAssessmentSubset(context, {
        project_id: id,
        requested_stage: "點子",
      })).toEqual({ outcome: "denied", reason: "policy_denied" });
    },
  );

  it.each(["withdrawn", "expired"] as const)(
    "%s 沿用既有 read_saved_content，不新增限制或提升 AI 權限", async (state) => {
      const id = await create();
      await control.query("UPDATE app.schools SET approval_state=$2 WHERE id=$1", [school(1), state]);
      expect((await read(id, "點子")).outcome).toBe("evaluated");
      expect((await readContext().runReadOnly((query) => query.query(
        "SELECT app.current_account_gate('ai_call') AS allowed",
      ))).rows).toEqual([{ allowed: false }]);
    },
  );

  it("拒絕 caller 夾帶確認、需求、owner、角色、能力或結論", async () => {
    const id = await create();
    expect(await read(id, "not-a-stage")).toEqual({ outcome: "failed", reason: "invalid_input" });
    expect(await readOwnedProjectCreationFlowAssessmentSubset(
      syntheticContext(authorization, null),
      { project_id: id, requested_stage: "點子" },
    )).toEqual({ outcome: "failed", reason: "invalid_context" });
    const result = await readOwnedProjectCreationFlowAssessmentSubset(readContext(), {
      project_id: id,
      requested_stage: "點子",
      requirements: requirements(),
      classification: { state: "confirmed" },
      confirmation: { confirmed_by: actor(1) },
      owner_id: actor(1),
      role: "admin",
      capability: "read_saved_content",
      canAdvance: true,
    });
    expect(result).toEqual({ outcome: "failed", reason: "invalid_input" });
  });

  it("當前需求缺漏或 DB 確認證據原文矛盾時整份安全失敗", async () => {
    const id = await create();
    await saveRequirements(id, 0, 0);
    await control.query("UPDATE app.projects SET requirements_revision=99 WHERE id=$1", [id]);
    const missingRequirements = await snapshot(id);
    expect(await read(id, "A/B")).toEqual({ outcome: "failed", reason: "invalid_result" });
    expect(await snapshot(id)).toEqual(missingRequirements);

    await control.query("UPDATE app.projects SET requirements_revision=1 WHERE id=$1", [id]);
    expect((await confirm(id, 1, 1, "A")).outcome).toBe("confirmed");
    const inserted = await control.query(`INSERT INTO app.project_classification_confirmations (
      id,project_id,requirements_revision,requirements_description,requirements_runtime_needs,
      requirements_runtime_ai_required,requested_tier_at_confirmation,requested_tier_acknowledgement,
      tier,needs_visitor_identity,confirmed_by,confirmed_at,source
    ) SELECT gen_random_uuid(),project_id,requirements_revision,'synthetic contradictory evidence',
      requirements_runtime_needs,requirements_runtime_ai_required,requested_tier_at_confirmation,
      requested_tier_acknowledgement,tier,needs_visitor_identity,confirmed_by,confirmed_at,source
      FROM app.project_classification_confirmations WHERE project_id=$1 RETURNING id`, [id]);
    await control.query("UPDATE app.projects SET current_confirmation_id=$2 WHERE id=$1", [id, inserted.rows[0].id]);
    expect(await read(id, "A/B")).toEqual({ outcome: "failed", reason: "invalid_result" });
  });

  it("真實併發更新期間讀取保持單一 statement 舊快照，下一交易讀到完整新狀態", async () => {
    const id = await create();
    expect((await saveRequirements(id, 0, 0, requirements("A", "old requirement"))).outcome).toBe("saved");
    expect((await confirm(id, 1, 1, "A")).outcome).toBe("confirmed");
    await saveDraft(id, "Specification", "old draft");
    const old = await read(id, "A/B");
    await control.query("SELECT pg_advisory_lock(490024)");
    let dispatched: () => void = () => { throw new Error("statement 同步點未建立"); };
    const started = new Promise<void>((resolve) => { dispatched = resolve; });
    let calls = 0;
    const paused: AuthorizationContext = {
      runReadOnly(operation) {
        return syntheticContext(parallelAuthorization, actor(1)).runReadOnly((query) => operation({
          async query(sql, values) {
            calls++;
            const pending = query.query(`WITH creation_flow_pause_49 AS MATERIALIZED (
              SELECT pg_advisory_xact_lock(490024)
            ) SELECT snapshot.* FROM creation_flow_pause_49
              CROSS JOIN LATERAL (${sql}) snapshot`, values);
            dispatched();
            return pending;
          },
        }));
      },
    };
    const pending = readOwnedProjectCreationFlowAssessmentSubset(paused, {
      project_id: id,
      requested_stage: "A/B",
    });
    let blocked = false;
    try {
      await started;
      for (let i = 0; i < 100; i++) {
        const activity = await control.query(`SELECT count(*)::int AS count FROM pg_stat_activity
          WHERE usename='app_authorization_test' AND wait_event='advisory'
            AND query LIKE '%creation_flow_pause_49%'`);
        if (activity.rows[0].count === 1) { blocked = true; break; }
        await delay(10);
      }
      expect(blocked).toBe(true);
      await writeContext().runTransaction(async (query) => {
        const transaction: ProjectCreationContext = {
          async runTransaction(operation) { return operation(query); },
        };
        expect((await saveRequirements(id, 2, 1, requirements("A", "new requirement"), transaction)).outcome)
          .toBe("saved");
        await saveDraft(id, "Specification", "new draft", 0, transaction);
      });
    } finally {
      await control.query("SELECT pg_advisory_unlock(490024)");
    }
    expect(calls).toBe(1);
    expect(await pending).toEqual(old);
    expect(await read(id, "A/B")).toMatchObject({
      outcome: "evaluated",
      row_version: 3,
      requirements_revision: 2,
      assessment: {
        classification_assessment: { outcome: "missing_evidence" },
        observed_drafts: [{ stage: "Specification", state: "ai_draft" }],
      },
    });
    console.log("creation-flow snapshot concurrency verified: one statement waited while writer committed");
  });

  it("回傳損壞測試 adapter 僅破壞查詢結果，不冒稱 DB 自然壞列", async () => {
    const id = await create();
    const before = await snapshot(id);
    const brokenAdapter: AuthorizationContext = {
      runReadOnly(operation) {
        return readContext().runReadOnly((query) => operation({
          async query(sql, values) {
            const result = await query.query(sql, values);
            const row = result.rows[0];
            if (!isRecord(row) || !Object.hasOwn(row, "project")) {
              throw new Error("測試 adapter 未收到預期 SQL envelope");
            }
            return { rows: [{ ...row, meta: "private synthetic fault" }] };
          },
        }));
      },
    };
    expect(await readOwnedProjectCreationFlowAssessmentSubset(brokenAdapter, {
      project_id: id,
      requested_stage: "點子",
    })).toEqual({ outcome: "failed", reason: "invalid_result" });
    expect(await snapshot(id)).toEqual(before);
    expect(await read(id, "點子")).toMatchObject({ outcome: "evaluated" });
  });

  it.each(["project", "revision", "requirements", "tier", "visitor", "duplicate_draft"] as const)(
    "測試 adapter 回傳的 %s 關聯損壞會整份拒絕（非 DB 壞列）",
    async (fault) => {
      const id = await create();
      expect((await saveRequirements(id, 0, 0)).outcome).toBe("saved");
      expect((await confirm(id, 1, 1, "A")).outcome).toBe("confirmed");
      if (fault === "duplicate_draft") {
        expect((await saveDraft(id, "點子", "synthetic")).outcome).toBe("saved");
      }
      const before = await snapshot(id);
      const corruptedAdapter: AuthorizationContext = {
        runReadOnly(operation) {
          return readContext().runReadOnly((query) => operation({
            async query(sql, values) {
              const result = await query.query(sql, values);
              const row = result.rows[0];
              if (!isRecord(row) || !isRecord(row.confirmation_evidence) || !Array.isArray(row.drafts)) {
                throw new Error("測試 adapter 未收到有效資料庫來源");
              }
              const evidence = row.confirmation_evidence;
              if (fault === "project") evidence.project_id = actor(2);
              else if (fault === "revision" && typeof evidence.requirements_revision === "number") {
                evidence.requirements_revision++;
              } else if (fault === "requirements" && isRecord(evidence.requirements_snapshot)) {
                evidence.requirements_snapshot.description = "adapter-only changed text";
              } else if (fault === "tier") evidence.tier = "B";
              else if (fault === "visitor") evidence.needs_visitor_identity = true;
              else if (fault === "duplicate_draft" && row.drafts.length > 0) {
                row.drafts.push(row.drafts[0]);
              }
              return result;
            },
          }));
        },
      };
      expect(await readOwnedProjectCreationFlowAssessmentSubset(corruptedAdapter, {
        project_id: id,
        requested_stage: "A/B",
      })).toEqual({ outcome: "failed", reason: "invalid_result" });
      expect(await snapshot(id)).toEqual(before);
      expect(await read(id, "A/B")).toMatchObject({ outcome: "evaluated" });
    },
  );

  it("真 SQL 依賴故障回固定結果，pool 無 role／claim／交易殘留", async () => {
    const id = await create();
    const fault: AuthorizationContext = {
      runReadOnly(operation) {
        return readContext().runReadOnly((query) => operation({
          async query() { return query.query("SELECT 1 / 0"); },
        }));
      },
    };
    expect(await readOwnedProjectCreationFlowAssessmentSubset(fault, {
      project_id: id,
      requested_stage: "點子",
    })).toEqual({ outcome: "failed", reason: "dependency_failure" });
    expect(await read(id, "點子")).toMatchObject({ outcome: "evaluated" });
    await poolState();
  });
});
