import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  confirmOwnedProjectClassificationSubset,
  createOwnedProjectSubset,
  hasTrustedProjectClassification,
  listOwnedProjectsSubset,
  listOwnedProjectsWithClassificationSubset,
  readCurrentOwnedProjectClassificationSubset,
  readOwnedProjectSubset,
  readOwnedProjectWithClassificationSubset,
  resolveTrustedProjectClassification,
  saveOwnedProjectRequirementsSubset,
  type ProjectCreationContext,
  type ProjectCreationQuery,
} from "../../apps/web/src/server/projects.ts";
import {
  inspectConnection,
  localPools,
  syntheticContext,
  syntheticCreationContext,
} from "./authorization-context.ts";
import type { ProjectRequirements } from "@app-planet/core";

const { control, authorization, parallelAuthorization } = localPools();
const actor = (n: number) => `81000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const school = (n: number) => `82000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const key = (n: number) => `83000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const createdProjects = new Set<string>();
let keyCounter = 1;

const nextKey = () => key(keyCounter++);
const context = (n = 1) => syntheticCreationContext(authorization, actor(n));
const readContext = (n = 1) => syntheticContext(authorization, actor(n));
const requirement = (
  tier: "A" | "B" = "A",
  description = "synthetic requirement",
  runtimeAiRequired = false,
): ProjectRequirements => ({
  description,
  runtime_needs: tier === "A" ? "static" : "work_data_api",
  runtime_ai_required: runtimeAiRequired,
});

const visibleSnapshotSql = `
  SELECT jsonb_build_object(
    'projects', (SELECT to_jsonb(p) FROM app.projects p WHERE id=$1),
    'requirements', (SELECT COALESCE(jsonb_agg(to_jsonb(r) ORDER BY revision), '[]')
      FROM app.project_requirements r WHERE project_id=$1),
    'confirmations', (SELECT COALESCE(jsonb_agg(to_jsonb(c) ORDER BY id), '[]')
      FROM app.project_classification_confirmations c WHERE project_id=$1)
  ) AS snapshot
`;
const completeSnapshotSql = `
  SELECT visible.snapshot || jsonb_build_object(
    'idempotency', (SELECT COALESCE(jsonb_agg(to_jsonb(i)
      ORDER BY operation_scope,idempotency_key), '[]')
      FROM app.project_classification_idempotency i WHERE project_id=$1)
  ) AS snapshot FROM (${visibleSnapshotSql}) visible
`;
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
async function snapshot(query: ProjectCreationQuery, projectId: string, complete = false) {
  return (await query.query(complete ? completeSnapshotSql : visibleSnapshotSql, [projectId])).rows[0];
}

async function createProject(owner = 1, requestedTier?: "A" | "B") {
  const input = requestedTier === undefined
    ? { title: `synthetic-classification-${keyCounter}` }
    : { title: `synthetic-classification-${keyCounter}`, tier: requestedTier };
  const result = await createOwnedProjectSubset(context(owner), input, nextKey());
  if (result.outcome !== "created") throw new Error("合成專案建立未成功");
  createdProjects.add(result.project.id);
  return result.project;
}

async function saveRequirements(
  projectId: string,
  input: {
    rowVersion: number;
    revision: number;
    requirements: ReturnType<typeof requirement>;
    actorNumber?: number;
    operationKey?: string;
  },
) {
  return saveOwnedProjectRequirementsSubset(context(input.actorNumber ?? 1), {
    project_id: projectId,
    expected_row_version: input.rowVersion,
    expected_requirements_revision: input.revision,
    requirements: input.requirements,
  }, input.operationKey ?? nextKey());
}

async function confirmClassification(
  projectId: string,
  input: {
    rowVersion: number;
    revision: number;
    tier: "A" | "B";
    needsVisitorIdentity: boolean;
    requestedTierAcknowledgement?: "no_preference" | "matches" | "explicit_change";
    actorNumber?: number;
    operationKey?: string;
  },
) {
  return confirmOwnedProjectClassificationSubset(context(input.actorNumber ?? 1), {
    project_id: projectId,
    expected_row_version: input.rowVersion,
    expected_requirements_revision: input.revision,
    tier: input.tier,
    needs_visitor_identity: input.needsVisitorIdentity,
    requested_tier_acknowledgement: input.requestedTierAcknowledgement ?? "no_preference",
  }, input.operationKey ?? nextKey());
}

beforeAll(async () => {
  await control.query(`
    INSERT INTO app.schools(id,label,approval_state,approval_epoch,created_at,updated_at)
    VALUES ($1,'synthetic-classification-school-a','approved',1,now(),now()),
           ($2,'synthetic-classification-school-b','approved',1,now(),now())
  `, [school(1), school(2)]);
  for (const n of [1, 2, 3, 4, 5, 6]) {
    await control.query("INSERT INTO auth.users(id) VALUES ($1)", [actor(n)]);
    await control.query(`
      INSERT INTO app.profiles(id,role,status,deletion_state,school_id,display_label,status_changed_at)
      VALUES ($1,$2,'approved','none',$3,'synthetic-classification-actor',now())
    `, [
      actor(n),
      n === 5 ? "teacher" : n === 6 ? "admin" : "student",
      n === 4 ? school(2) : school(1),
    ]);
  }
});

afterEach(async () => {
  const ids = [...createdProjects];
  if (ids.length > 0) {
    await control.query(`
      UPDATE app.projects
      SET classification_state='unconfirmed',tier=NULL,needs_visitor_identity=NULL,
        current_confirmation_id=NULL
      WHERE id=ANY($1::uuid[])
    `, [ids]);
    await control.query("DELETE FROM app.project_classification_idempotency WHERE project_id=ANY($1::uuid[])", [ids]);
    await control.query("DELETE FROM app.project_classification_confirmations WHERE project_id=ANY($1::uuid[])", [ids]);
    await control.query("DELETE FROM app.project_requirements WHERE project_id=ANY($1::uuid[])", [ids]);
    await control.query("DELETE FROM app.project_create_idempotency WHERE project_id=ANY($1::uuid[])", [ids]);
    await control.query("DELETE FROM app.projects WHERE id=ANY($1::uuid[])", [ids]);
    createdProjects.clear();
  }
  await control.query("UPDATE app.profiles SET status='approved',deletion_state='none' WHERE id=ANY($1::uuid[])", [
    [actor(1), actor(2), actor(3), actor(4), actor(5), actor(6)],
  ]);
  await control.query("UPDATE app.schools SET approval_state='approved' WHERE id=ANY($1::uuid[])", [
    [school(1), school(2)],
  ]);
});

afterAll(async () => {
  await Promise.all([control.end(), authorization.end(), parallelAuthorization.end()]);
});

describe("T051 需求版本／分類確認 PostgreSQL 整合", () => {
  it("F-01 真實三態 DTO／receipt 不可信，僅 resolver 原物件通過且不代表永久資格", async () => {
    const project = await createProject();
    const unconfirmed = await readCurrentOwnedProjectClassificationSubset(readContext(), project.id);
    const legacy = await createProject();
    await control.query(`
      UPDATE app.projects SET classification_state='legacy_unverified',
        requested_tier=NULL,tier='A',needs_visitor_identity=false WHERE id=$1
    `, [legacy.id]);
    const legacyDto = await readCurrentOwnedProjectClassificationSubset(readContext(), legacy.id);
    await saveRequirements(project.id, { rowVersion: 0, revision: 0, requirements: requirement() });
    const receipt = await confirmClassification(project.id, {
      rowVersion: 1, revision: 1, tier: "A", needsVisitorIdentity: false,
    });
    const confirmed = await readCurrentOwnedProjectClassificationSubset(readContext(), project.id);
    const resolved = await resolveTrustedProjectClassification(readContext(), project.id);
    if (unconfirmed.outcome !== "found" || legacyDto.outcome !== "found" ||
        confirmed.outcome !== "found" || receipt.outcome !== "confirmed" ||
        resolved.outcome !== "trusted") throw new Error("F-01 合成前置狀態未建立");
    const classification = resolved.classification;
    expect(classification).toEqual({
      project_id: project.id, requirements_revision: 1, tier: "A",
      needs_visitor_identity: false, confirmed_by: actor(1),
      confirmed_at: receipt.operation.confirmation.confirmed_at,
    });
    expect(hasTrustedProjectClassification(classification)).toBe(true);
    expect(Object.isFrozen(classification)).toBe(true);
    for (const value of [
      unconfirmed.project, legacyDto.project, confirmed.project, receipt.operation,
      { ...classification }, JSON.parse(JSON.stringify(classification)),
      { project_id: project.id, requirements_revision: 1, tier: "A",
        needs_visitor_identity: false, confirmed_by: actor(1),
        confirmed_at: classification.confirmed_at },
    ]) {
      expect(hasTrustedProjectClassification(value)).toBe(false);
    }
    await saveRequirements(project.id, {
      rowVersion: 2, revision: 1, requirements: requirement("A", "changed requirement"),
    });
    expect(await resolveTrustedProjectClassification(readContext(), project.id))
      .toEqual({ outcome: "unconfirmed" });
    // WeakSet 僅記來源；舊物件不會被變成即時 DB 資格／撤銷機制。
    expect(hasTrustedProjectClassification(classification)).toBe(true);
  });

  it("F-02 真實 confirmed 對四個舊單筆／列表介面均不支援，不部分成功或洩漏他人狀態", async () => {
    const creationKey = nextKey();
    const input = { title: `synthetic-f02-${keyCounter}` };
    const created = await createOwnedProjectSubset(context(), input, creationKey);
    if (created.outcome !== "created") throw new Error("F-02 建立失敗");
    const project = created.project;
    createdProjects.add(project.id);
    await saveRequirements(project.id, { rowVersion: 0, revision: 0, requirements: requirement() });
    await confirmClassification(project.id, {
      rowVersion: 1, revision: 1, tier: "A", needsVisitorIdentity: false,
    });
    const unconfirmed = await createProject();
    const legacy = await createProject();
    await control.query(`
      UPDATE app.projects SET classification_state='legacy_unverified',
        requested_tier=NULL,tier='B',needs_visitor_identity=true WHERE id=$1
    `, [legacy.id]);
    expect(await readCurrentOwnedProjectClassificationSubset(readContext(), project.id))
      .toMatchObject({ outcome: "found", project: { classification_state: "confirmed" } });
    expect(await createOwnedProjectSubset(context(), input, creationKey)).toEqual(created);
    expect(await readOwnedProjectSubset(readContext(), legacy.id)).toMatchObject({
      outcome: "found", project: { tier: "B", needs_visitor_identity: true },
    });
    expect(await readOwnedProjectWithClassificationSubset(readContext(), unconfirmed.id))
      .toMatchObject({ outcome: "found", project: { classification_state: "unconfirmed" } });
    const ownerResults = await Promise.all([
      readOwnedProjectSubset(readContext(), project.id),
      readOwnedProjectWithClassificationSubset(readContext(), project.id),
      listOwnedProjectsSubset(readContext(), 100),
      listOwnedProjectsWithClassificationSubset(readContext(), 100),
    ]);
    expect(ownerResults).toEqual(Array.from({ length: 4 }, () => ({ outcome: "unsupported_representation" })));
    for (const peer of [2, 4]) {
      expect(await readOwnedProjectSubset(readContext(peer), project.id)).toEqual({ outcome: "not_found" });
      expect(await readOwnedProjectWithClassificationSubset(readContext(peer), project.id))
        .toEqual({ outcome: "not_found" });
      expect(await readCurrentOwnedProjectClassificationSubset(readContext(peer), project.id))
        .toEqual({ outcome: "not_found" });
      expect(await listOwnedProjectsSubset(readContext(peer), 100)).toEqual({ outcome: "listed", projects: [] });
      expect(await listOwnedProjectsWithClassificationSubset(readContext(peer), 100))
        .toEqual({ outcome: "listed", projects: [] });
    }
  });

  describe.each(["save", "confirm"] as const)("F-03 %s 真實寫入後僅破壞返回資料", (operationName) => {
    it.each(["missing_result", "invalid_actor", "invalid_envelope", "missing_receipt", "invalid_receipt"] as const)(
      "%s 由服務偵測並完整回滾，pool 乾淨且正常重試成功",
      async (corruption) => {
        const project = await createProject();
        await saveRequirements(project.id, { rowVersion: 0, revision: 0, requirements: requirement() });
        await confirmClassification(project.id, {
          rowVersion: 1, revision: 1, tier: "A", needsVisitorIdentity: false,
        });
        if (operationName === "confirm") {
          await saveRequirements(project.id, {
            rowVersion: 2, revision: 1, requirements: requirement("A", "revision two"),
          });
        }
        const rowVersion = operationName === "save" ? 2 : 3;
        const revision = operationName === "save" ? 1 : 2;
        const operationKey = nextKey();
        const before = await snapshot(control, project.id, true);
        const visibleBefore = await snapshot(control, project.id);
        let visibleDuring: unknown;
        let actorDuring: unknown;
        let originalEnvelope: unknown;
        let queryCompleted = false;
        const wrapped: ProjectCreationContext = {
          runTransaction(operation) {
            return context().runTransaction((query) => operation({
              async query(sql, values) {
                const result = await query.query(sql, values);
                // 真 SQL 已完成，另查同一交易中可見的實際寫入；wrapper 不主動拋錯。
                visibleDuring = await snapshot(query, project.id);
                actorDuring = (await query.query(`
                  SELECT current_user::text AS actor, session_user::text AS login,
                    current_setting('transaction_read_only') AS read_only,
                    current_setting('request.jwt.claim.sub') AS sub,
                    (SELECT bool_or(rolsuper OR rolbypassrls) FROM pg_roles
                      WHERE rolname IN (current_user, session_user)) AS privileged
                `)).rows[0];
                originalEnvelope = result.rows[0];
                queryCompleted = true;
                if (corruption === "missing_result") return { rows: [{ actor_valid: true }] };
                if (corruption === "invalid_actor") {
                  return { rows: [isRecord(originalEnvelope)
                    ? { ...originalEnvelope, actor_valid: "true" }
                    : { actor_valid: "true" }] };
                }
                if (corruption === "invalid_envelope") return { rows: [] };
                if (!isRecord(originalEnvelope) || !isRecord(originalEnvelope.result)) return { rows: [{}] };
                const rawResult = originalEnvelope.result;
                if (corruption === "missing_receipt") {
                  return { rows: [{ actor_valid: true, result: { ...rawResult, operation: null } }] };
                }
                const receipt = isRecord(rawResult.operation) ? rawResult.operation : {};
                const { row_version: omitted, ...incompleteReceipt } = receipt;
                void omitted;
                return { rows: [{ actor_valid: true, result: { ...rawResult, operation: incompleteReceipt } }] };
              },
            }));
          },
        };
        const invoke = (ctx: ProjectCreationContext) => operationName === "save"
          ? saveOwnedProjectRequirementsSubset(ctx, {
            project_id: project.id, expected_row_version: rowVersion,
            expected_requirements_revision: revision, requirements: requirement("B", "changed after confirmation"),
          }, operationKey)
          : confirmOwnedProjectClassificationSubset(ctx, {
            project_id: project.id, expected_row_version: rowVersion, expected_requirements_revision: revision,
            tier: "A", needs_visitor_identity: true, requested_tier_acknowledgement: "no_preference",
          }, operationKey);
        const result = await invoke(wrapped);
        const after = await snapshot(control, project.id, true);
        const client = await authorization.connect();
        let cleanConnection: unknown;
        let transactionIdle: unknown;
        try {
          cleanConnection = await inspectConnection(client);
          transactionIdle = (await control.query(`
            SELECT state, xact_start IS NULL AS no_transaction
            FROM pg_stat_activity WHERE pid=$1
          `, [isRecord(cleanConnection) ? cleanConnection.pid : null])).rows[0];
        } finally {
          client.release();
        }
        console.info("F-03 evidence", JSON.stringify({
          operation: operationName, corruption, query_completed: queryCompleted,
          write_observed: JSON.stringify(visibleDuring) !== JSON.stringify(visibleBefore),
          actor: actorDuring, original_envelope: originalEnvelope,
          before, during: visibleDuring, result, after,
          fully_rolled_back: JSON.stringify(after) === JSON.stringify(before),
          pool: cleanConnection, transaction: transactionIdle,
        }));
        expect(queryCompleted).toBe(true);
        expect(actorDuring).toEqual({
          actor: "authenticated", login: "app_authorization_test",
          read_only: "off", sub: actor(1), privileged: false,
        });
        expect(originalEnvelope).toMatchObject({
          actor_valid: true, result: { outcome: operationName === "save" ? "saved" : "confirmed" },
        });
        expect(visibleDuring).not.toEqual(visibleBefore);
        expect(visibleDuring).toMatchObject({
          snapshot: {
            projects: {
              row_version: rowVersion + 1, requirements_revision: 2,
              classification_state: operationName === "save" ? "unconfirmed" : "confirmed",
              tier: operationName === "save" ? null : "A",
              needs_visitor_identity: operationName === "save" ? null : true,
              current_confirmation_id: operationName === "save" ? null : expect.any(String),
            },
            requirements: [
              { revision: 1 },
              { revision: 2, description: operationName === "save" ? "changed after confirmation" : "revision two" },
            ],
            confirmations: operationName === "save"
              ? [{ requirements_revision: 1 }]
              : expect.arrayContaining([expect.objectContaining({
                requirements_revision: 2, needs_visitor_identity: true,
                requirements_description: "revision two",
              })]),
          },
        });
        expect(result).toEqual({ outcome: "failed", reason: "invalid_result" });
        expect(after).toEqual(before);
        expect(cleanConnection).toMatchObject({ actor: "app_authorization_test", sub: null, claims: null });
        expect(transactionIdle).toEqual({ state: "idle", no_transaction: true });
        const success = await invoke(context());
        expect(success.outcome).toBe(operationName === "save" ? "saved" : "confirmed");
        expect(await snapshot(control, project.id, true)).not.toEqual(before);
      },
    );

    it("replay 的 current 結果非法也必須離開 callback 觸發回滾，而非正常提交", async () => {
      const project = await createProject();
      const operationKey = nextKey();
      if (operationName === "confirm") {
        await saveRequirements(project.id, { rowVersion: 0, revision: 0, requirements: requirement() });
      }
      const invoke = (ctx: ProjectCreationContext) => operationName === "save"
        ? saveOwnedProjectRequirementsSubset(ctx, {
          project_id: project.id, expected_row_version: 0, expected_requirements_revision: 0,
          requirements: requirement(),
        }, operationKey)
        : confirmOwnedProjectClassificationSubset(ctx, {
          project_id: project.id, expected_row_version: 1, expected_requirements_revision: 1,
          tier: "A", needs_visitor_identity: false, requested_tier_acknowledgement: "no_preference",
        }, operationKey);
      await invoke(context());
      const before = await snapshot(control, project.id, true);
      let callbackReturned = false;
      let readCompleted = false;
      const wrapped: ProjectCreationContext = {
        runTransaction(operation) {
          return context().runTransaction(async (query) => {
            const result = await operation({
              async query(sql, values) {
                const result = await query.query(sql, values);
                if (sql.includes("AS project")) {
                  readCompleted = true;
                  return { rows: [{ subject: actor(1), actor_valid: true, allowed: true, project: {} }] };
                }
                return result;
              },
            });
            callbackReturned = true;
            return result;
          });
        },
      };
      const result = await invoke(wrapped);
      expect(readCompleted).toBe(true);
      expect({ result, callbackReturned }).toEqual({
        result: { outcome: "failed", reason: "invalid_result" }, callbackReturned: false,
      });
      expect(await snapshot(control, project.id, true)).toEqual(before);
      expect((await invoke(context())).outcome).toBe("replayed");
    });
  });

  it("未分類點子→保存精確需求→學生明確確認→可信 DB 讀回", async () => {
    const project = await createProject();
    const saved = await saveRequirements(project.id, {
      rowVersion: 0, revision: 0, requirements: requirement("A", "  café / same bytes  "),
    });
    expect(saved).toMatchObject({
      outcome: "saved",
      operation: { requirements_revision: 1, row_version: 1, changed: true },
    });
    const confirmed = await confirmClassification(project.id, {
      rowVersion: 1, revision: 1, tier: "A", needsVisitorIdentity: false,
    });
    expect(confirmed).toMatchObject({
      outcome: "confirmed",
      operation: { requirements_revision: 1, tier: "A", needs_visitor_identity: false, row_version: 2 },
    });
    const current = await readCurrentOwnedProjectClassificationSubset(readContext(), project.id);
    expect(current).toMatchObject({
      outcome: "found",
      project: {
        classification_state: "confirmed",
        requirements_revision: 1,
        requirements: { description: "  café / same bytes  ", runtime_needs: "static" },
        tier: "A",
        needs_visitor_identity: false,
        confirmation: {
          requirements_revision: 1,
          confirmed_by: actor(1),
          source: "student_explicit_confirmation",
        },
      },
    });
    if (current.outcome !== "found") throw new Error("未取得可信分類");
    expect(hasTrustedProjectClassification(current.project)).toBe(false);
    expect(await resolveTrustedProjectClassification(readContext(), project.id))
      .toMatchObject({ outcome: "trusted", classification: { tier: "A", requirements_revision: 1 } });
    expect(hasTrustedProjectClassification({
      ...current.project,
      confirmation: { ...current.project.confirmation },
    })).toBe(false);
  });

  it.each([
    ["A", false], ["A", true], ["B", false], ["B", true],
  ] as const)("學生可明確確認 %s／visitor=%s，分類與公開資格分離", async (tier, visitor) => {
    const project = await createProject();
    await saveRequirements(project.id, {
      rowVersion: 0, revision: 0, requirements: requirement(tier),
    });
    const result = await confirmClassification(project.id, {
      rowVersion: 1, revision: 1, tier, needsVisitorIdentity: visitor,
    });
    expect(result.outcome).toBe("confirmed");
    const trusted = await resolveTrustedProjectClassification(readContext(), project.id);
    expect(trusted).toMatchObject({
      outcome: "trusted",
      classification: { tier, needs_visitor_identity: visitor },
    });
  });

  it("requested_tier 差異不默默採用，明確選擇並標示變更後才確認", async () => {
    const project = await createProject(1, "A");
    await saveRequirements(project.id, {
      rowVersion: 0, revision: 0, requirements: requirement("B"),
    });
    expect(await confirmClassification(project.id, {
      rowVersion: 1,
      revision: 1,
      tier: "B",
      needsVisitorIdentity: false,
      requestedTierAcknowledgement: "matches",
    })).toMatchObject({ outcome: "failed", reason: "requested_tier_acknowledgement_required" });
    expect(await confirmClassification(project.id, {
      rowVersion: 1,
      revision: 1,
      tier: "B",
      needsVisitorIdentity: false,
      requestedTierAcknowledgement: "explicit_change",
    })).toMatchObject({
      outcome: "confirmed",
      operation: { tier: "B", needs_visitor_identity: false },
    });
  });

  it("unsupported runtime AI／restricted_server 與分類不一致 fail-closed", async () => {
    const aiProject = await createProject();
    await saveRequirements(aiProject.id, {
      rowVersion: 0, revision: 0, requirements: requirement("A", "synthetic AI runtime", true),
    });
    expect(await confirmClassification(aiProject.id, {
      rowVersion: 1, revision: 1, tier: "A", needsVisitorIdentity: false,
    })).toMatchObject({ outcome: "failed", reason: "unsupported_runtime_ai" });

    const serverProject = await createProject();
    await saveRequirements(serverProject.id, {
      rowVersion: 0,
      revision: 0,
      requirements: {
        description: "synthetic restricted runtime",
        runtime_needs: "restricted_server",
        runtime_ai_required: false,
      },
    });
    expect(await confirmClassification(serverProject.id, {
      rowVersion: 1, revision: 1, tier: "B", needsVisitorIdentity: false,
    })).toMatchObject({ outcome: "failed", reason: "unsupported_runtime" });

    const mismatchProject = await createProject();
    await saveRequirements(mismatchProject.id, {
      rowVersion: 0, revision: 0, requirements: requirement("B"),
    });
    expect(await confirmClassification(mismatchProject.id, {
      rowVersion: 1, revision: 1, tier: "A", needsVisitorIdentity: false,
    })).toMatchObject({ outcome: "failed", reason: "inconsistent_input" });
  });

  it("修改需求建立新 revision、立即清除有效分類並保留舊確認證據", async () => {
    const project = await createProject();
    await saveRequirements(project.id, {
      rowVersion: 0, revision: 0, requirements: requirement("A", "version one"),
    });
    const confirmed = await confirmClassification(project.id, {
      rowVersion: 1, revision: 1, tier: "A", needsVisitorIdentity: false,
    });
    expect(confirmed.outcome).toBe("confirmed");
    const changed = await saveRequirements(project.id, {
      rowVersion: 2, revision: 1, requirements: requirement("A", "version  one"),
    });
    expect(changed).toMatchObject({
      outcome: "saved",
      operation: { requirements_revision: 2, row_version: 3, changed: true },
    });
    expect(await resolveTrustedProjectClassification(readContext(), project.id)).toEqual({
      outcome: "unconfirmed",
    });
    expect((await control.query(`
      SELECT classification_state,tier,needs_visitor_identity,requirements_revision,
        current_confirmation_id
      FROM app.projects WHERE id=$1
    `, [project.id])).rows[0]).toMatchObject({
      classification_state: "unconfirmed",
      tier: null,
      needs_visitor_identity: null,
      requirements_revision: 2,
      current_confirmation_id: null,
    });
    expect((await control.query(
      "SELECT count(*)::int AS count FROM app.project_classification_confirmations WHERE project_id=$1",
      [project.id],
    )).rows).toEqual([{ count: 1 }]);
    expect(await confirmClassification(project.id, {
      rowVersion: 2, revision: 1, tier: "A", needsVisitorIdentity: false,
    })).toMatchObject({ outcome: "failed", reason: "version_conflict" });
    expect(await confirmClassification(project.id, {
      rowVersion: 3, revision: 2, tier: "A", needsVisitorIdentity: false,
    })).toMatchObject({ outcome: "confirmed", operation: { requirements_revision: 2 } });
    expect(await confirmClassification(project.id, {
      rowVersion: 4, revision: 1, tier: "A", needsVisitorIdentity: false,
    })).toMatchObject({ outcome: "failed", reason: "version_conflict" });
  });

  it("同內容不產生新需求 revision；舊 project row_version 拒絕更新", async () => {
    const project = await createProject();
    const content = requirement("A", "exact content");
    expect(await saveRequirements(project.id, { rowVersion: 0, revision: 0, requirements: content }))
      .toMatchObject({ outcome: "saved", operation: { requirements_revision: 1, row_version: 1 } });
    expect(await saveRequirements(project.id, {
      rowVersion: 1, revision: 1, requirements: content,
    })).toMatchObject({
      outcome: "saved",
      operation: { requirements_revision: 1, row_version: 1, changed: false },
    });
    expect(await saveRequirements(project.id, {
      rowVersion: 0, revision: 0, requirements: requirement("A", "changed"),
    })).toMatchObject({ outcome: "failed", reason: "version_conflict" });
  });

  it("相同 UUID 與同內容重放原保存結果，另列目前分類狀態", async () => {
    const project = await createProject();
    const input = {
      rowVersion: 0,
      revision: 0,
      requirements: requirement("A", "same operation content"),
      operationKey: nextKey(),
    };
    expect(await saveRequirements(project.id, input))
      .toMatchObject({ outcome: "saved", operation: { row_version: 1 } });
    expect(await saveRequirements(project.id, input)).toMatchObject({
      outcome: "replayed",
      operation: { outcome: "saved", requirements_revision: 1, row_version: 1 },
      current_classification: {
        outcome: "found",
        project: { classification_state: "unconfirmed", requirements_revision: 1 },
      },
    });
  });

  it("真實併發兩次需求更新只接受一個 expected row_version", async () => {
    const project = await createProject();
    let arrived = 0;
    let release!: () => void;
    const rendezvous = new Promise<void>((resolve) => { release = resolve; });
    const synchronize = async () => {
      arrived += 1;
      if (arrived === 2) release();
      await rendezvous;
    };
    const results = await Promise.all([
      saveOwnedProjectRequirementsSubset(
        syntheticCreationContext(parallelAuthorization, actor(1), { synchronize }),
        {
          project_id: project.id, expected_row_version: 0, expected_requirements_revision: 0,
          requirements: requirement("A", "concurrent left"),
        },
        nextKey(),
      ),
      saveOwnedProjectRequirementsSubset(
        syntheticCreationContext(parallelAuthorization, actor(1), { synchronize }),
        {
          project_id: project.id, expected_row_version: 0, expected_requirements_revision: 0,
          requirements: requirement("A", "concurrent right"),
        },
        nextKey(),
      ),
    ]);
    expect(results.filter((result) => result.outcome === "saved")).toHaveLength(1);
    expect(results.filter((result) => result.outcome === "failed" && result.reason === "version_conflict"))
      .toHaveLength(1);
    expect((await control.query(`
      SELECT row_version,requirements_revision,classification_state,tier,needs_visitor_identity,stage
      FROM app.projects WHERE id=$1
    `, [project.id])).rows[0]).toMatchObject({
      row_version: 1,
      requirements_revision: 1,
      classification_state: "unconfirmed",
      tier: null,
      needs_visitor_identity: null,
      stage: "點子",
    });
    expect((await control.query(
      "SELECT count(*)::int AS count FROM app.project_requirements WHERE project_id=$1",
      [project.id],
    )).rows).toEqual([{ count: 1 }]);
  });

  it("不存在、同校／跨校他人、教師／管理員與當下停用／學校政策變更均拒絕", async () => {
    const project = await createProject();
    for (const n of [2, 3, 4, 5, 6]) {
      expect(await saveOwnedProjectRequirementsSubset(context(n), {
        project_id: project.id,
        expected_row_version: 0,
        expected_requirements_revision: 0,
        requirements: requirement(),
      }, nextKey()).then((result) => result.outcome)).not.toBe("saved");
      expect(await confirmClassification(project.id, {
        actorNumber: n, rowVersion: 0, revision: 1, tier: "A", needsVisitorIdentity: false,
      }).then((result) => result.outcome)).not.toBe("confirmed");
      expect(await readCurrentOwnedProjectClassificationSubset(
        syntheticContext(authorization, actor(n)), project.id,
      )).not.toMatchObject({ outcome: "found" });
    }
    expect(await readCurrentOwnedProjectClassificationSubset(readContext(), actor(999)))
      .toMatchObject({ outcome: "not_found" });

    await control.query("UPDATE app.profiles SET status='disabled' WHERE id=$1", [actor(1)]);
    expect(await saveRequirements(project.id, {
      rowVersion: 0, revision: 0, requirements: requirement(),
    })).toMatchObject({ outcome: "denied" });
    await control.query("UPDATE app.profiles SET status='approved' WHERE id=$1", [actor(1)]);
    await control.query("UPDATE app.profiles SET deletion_state='marked' WHERE id=$1", [actor(1)]);
    expect(await saveRequirements(project.id, {
      rowVersion: 0, revision: 0, requirements: requirement(),
    })).toMatchObject({ outcome: "denied" });
    expect(await confirmClassification(project.id, {
      rowVersion: 0, revision: 1, tier: "A", needsVisitorIdentity: false,
    })).toMatchObject({ outcome: "denied" });
    expect(await readCurrentOwnedProjectClassificationSubset(readContext(), project.id))
      .toMatchObject({ outcome: "denied" });
    await control.query("UPDATE app.profiles SET deletion_state='none' WHERE id=$1", [actor(1)]);
    await control.query("UPDATE app.schools SET approval_state='unconfirmed' WHERE id=$1", [school(1)]);
    expect(await saveRequirements(project.id, {
      rowVersion: 0, revision: 0, requirements: requirement(),
    })).toMatchObject({ outcome: "denied" });
  });

  it("歷史 legacy_unverified 保留原值但可信分類解析不升格", async () => {
    const project = await createProject();
    await control.query(`
      UPDATE app.projects
      SET requested_tier=NULL,classification_state='legacy_unverified',
        tier='B',needs_visitor_identity=false,requirements_revision=0,
        current_confirmation_id=NULL
      WHERE id=$1
    `, [project.id]);
    expect(await readCurrentOwnedProjectClassificationSubset(readContext(), project.id))
      .toMatchObject({
        outcome: "found",
        project: {
          classification_state: "legacy_unverified",
          tier: "B",
          needs_visitor_identity: false,
          requirements_revision: 0,
          confirmation: null,
        },
      });
    expect(await resolveTrustedProjectClassification(readContext(), project.id))
      .toEqual({ outcome: "legacy_unverified" });
  });

  it("成功確認重放保留原操作回應，並另回目前已失效分類", async () => {
    const project = await createProject();
    await saveRequirements(project.id, {
      rowVersion: 0, revision: 0, requirements: requirement(),
    });
    const confirmationKey = nextKey();
    const confirmation = await confirmClassification(project.id, {
      rowVersion: 1, revision: 1, tier: "A", needsVisitorIdentity: false,
      operationKey: confirmationKey,
    });
    expect(confirmation.outcome).toBe("confirmed");
    await saveRequirements(project.id, {
      rowVersion: 2, revision: 1, requirements: requirement("A", "new current requirement"),
    });
    const replay = await confirmClassification(project.id, {
      rowVersion: 1, revision: 1, tier: "A", needsVisitorIdentity: false,
      operationKey: confirmationKey,
    });
    expect(replay).toMatchObject({
      outcome: "replayed",
      operation: { outcome: "confirmed", requirements_revision: 1 },
      current_classification: {
        outcome: "found",
        project: { classification_state: "unconfirmed", tier: null, needs_visitor_identity: null },
      },
    });
    expect(await resolveTrustedProjectClassification(readContext(), project.id))
      .toEqual({ outcome: "unconfirmed" });
  });

  it("冪等 UUID 同鍵異內容拒絕，跨主體 scope 隔離，重放前重新授權", async () => {
    const first = await createProject();
    const second = await createProject(2);
    const sharedKey = nextKey();
    const firstSave = await saveRequirements(first.id, {
      rowVersion: 0, revision: 0, requirements: requirement("A", "owner one"),
      operationKey: sharedKey,
    });
    expect(firstSave.outcome).toBe("saved");
    expect(await saveRequirements(first.id, {
      rowVersion: 0, revision: 0, requirements: requirement("A", "other content"),
      operationKey: sharedKey,
    })).toMatchObject({ outcome: "conflict", reason: "idempotency_mismatch" });
    expect(await saveRequirements(second.id, {
      actorNumber: 2,
      rowVersion: 0,
      revision: 0,
      requirements: requirement("A", "owner two"),
      operationKey: sharedKey,
    })).toMatchObject({ outcome: "saved" });
    await control.query("UPDATE app.profiles SET deletion_state='marked' WHERE id=$1", [actor(1)]);
    expect(await saveRequirements(first.id, {
      rowVersion: 0, revision: 0, requirements: requirement("A", "owner one"),
      operationKey: sharedKey,
    })).toMatchObject({ outcome: "denied" });
  });

  it("真實併發保存／確認只提交一個 row_version，不復活舊分類", async () => {
    const project = await createProject();
    await saveRequirements(project.id, {
      rowVersion: 0, revision: 0, requirements: requirement(),
    });
    let arrived = 0;
    let release!: () => void;
    const rendezvous = new Promise<void>((resolve) => { release = resolve; });
    const synchronize = async () => {
      arrived += 1;
      if (arrived === 2) release();
      await rendezvous;
    };
    const results = await Promise.all([
      confirmOwnedProjectClassificationSubset(
        syntheticCreationContext(parallelAuthorization, actor(1), { synchronize }),
        {
          project_id: project.id, expected_row_version: 1, expected_requirements_revision: 1,
          tier: "A", needs_visitor_identity: false, requested_tier_acknowledgement: "no_preference",
        },
        nextKey(),
      ),
      saveOwnedProjectRequirementsSubset(
        syntheticCreationContext(parallelAuthorization, actor(1), { synchronize }),
        {
          project_id: project.id, expected_row_version: 1, expected_requirements_revision: 1,
          requirements: requirement("A", "concurrent update"),
        },
        nextKey(),
      ),
    ]);
    expect(results.filter((result) => result.outcome === "confirmed" || result.outcome === "saved"))
      .toHaveLength(1);
    expect(results.filter((result) => result.outcome === "failed" && result.reason === "version_conflict"))
      .toHaveLength(1);
    const state = (await control.query(`
      SELECT classification_state,requirements_revision,tier,needs_visitor_identity,
        current_confirmation_id,row_version
      FROM app.projects WHERE id=$1
    `, [project.id])).rows[0];
    expect(state.row_version).toBe(2);
    if (state.classification_state === "confirmed") {
      expect(state).toMatchObject({
        requirements_revision: 1, tier: "A", needs_visitor_identity: false,
      });
      expect(await resolveTrustedProjectClassification(readContext(), project.id))
        .toMatchObject({ outcome: "trusted" });
    } else {
      expect(state).toMatchObject({
        classification_state: "unconfirmed",
        requirements_revision: 2,
        tier: null,
        needs_visitor_identity: null,
        current_confirmation_id: null,
      });
      expect(await resolveTrustedProjectClassification(readContext(), project.id))
        .toEqual({ outcome: "unconfirmed" });
    }
  });

  it("交易寫入後故障回滾需求、證據、project 版本與冪等資料，pool 無 claim 污染", async () => {
    const project = await createProject();
    const base = context();
    const operationKey = nextKey();
    const failAfterWrite: ProjectCreationContext = {
      runTransaction(operation) {
        return base.runTransaction(async (query) => {
          await operation(query);
          throw new Error("synthetic post-write failure");
        });
      },
    };
    expect(await saveOwnedProjectRequirementsSubset(failAfterWrite, {
      project_id: project.id,
      expected_row_version: 0,
      expected_requirements_revision: 0,
      requirements: requirement(),
    }, operationKey)).toMatchObject({ outcome: "failed", reason: "dependency_failure" });
    expect((await control.query(`
      SELECT row_version,requirements_revision,classification_state,tier,needs_visitor_identity
      FROM app.projects WHERE id=$1
    `, [project.id])).rows[0]).toMatchObject({
      row_version: 0,
      requirements_revision: 0,
      classification_state: "unconfirmed",
      tier: null,
      needs_visitor_identity: null,
    });
    expect((await control.query("SELECT 1 FROM app.project_requirements WHERE project_id=$1", [project.id])).rows)
      .toEqual([]);
    expect((await control.query(
      "SELECT 1 FROM app.project_classification_idempotency WHERE project_id=$1",
      [project.id],
    )).rows).toEqual([]);
    const client = await authorization.connect();
    try {
      expect(await inspectConnection(client)).toMatchObject({
        actor: "app_authorization_test", sub: null, claims: null,
      });
    } finally {
      client.release();
    }
  });

  it("非特權 READ WRITE actor 不得直接 DML 需求、證據或正式分類", async () => {
    const project = await createProject();
    const client = await authorization.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL READ COMMITTED READ WRITE");
      await client.query("SET LOCAL ROLE authenticated");
      await client.query("SELECT set_config('request.jwt.claim.sub',$1,true)", [actor(1)]);
      await client.query("SAVEPOINT direct_project_update");
      await expect(client.query(
        "UPDATE app.projects SET classification_state='confirmed' WHERE id=$1",
        [project.id],
      )).rejects.toMatchObject({ code: "42501" });
      await client.query("ROLLBACK TO SAVEPOINT direct_project_update");
      await client.query("SAVEPOINT direct_owner_update");
      await expect(client.query(
        "UPDATE app.projects SET owner_id=$2 WHERE id=$1",
        [project.id, actor(2)],
      )).rejects.toMatchObject({ code: "42501" });
      await client.query("ROLLBACK TO SAVEPOINT direct_owner_update");
      await client.query("SAVEPOINT direct_tier_update");
      await expect(client.query(
        "UPDATE app.projects SET tier='A' WHERE id=$1",
        [project.id],
      )).rejects.toMatchObject({ code: "42501" });
      await client.query("ROLLBACK TO SAVEPOINT direct_tier_update");
      await client.query("SAVEPOINT direct_visitor_update");
      await expect(client.query(
        "UPDATE app.projects SET needs_visitor_identity=false WHERE id=$1",
        [project.id],
      )).rejects.toMatchObject({ code: "42501" });
      await client.query("ROLLBACK TO SAVEPOINT direct_visitor_update");
      await client.query("SAVEPOINT direct_requirements_insert");
      await expect(client.query(
        "INSERT INTO app.project_requirements(project_id,revision,description,runtime_needs,runtime_ai_required,created_by,created_at) VALUES ($1,1,'fake','static',false,$2,now())",
        [project.id, actor(1)],
      )).rejects.toMatchObject({ code: "42501" });
      await client.query("ROLLBACK TO SAVEPOINT direct_requirements_insert");
      await client.query("SAVEPOINT direct_evidence_insert");
      await expect(client.query(`
        INSERT INTO app.project_classification_confirmations (
          project_id,requirements_revision,requirements_description,
          requirements_runtime_needs,requirements_runtime_ai_required,
          requested_tier_acknowledgement,tier,needs_visitor_identity,
          confirmed_by,confirmed_at,source
        ) VALUES ($1,1,'fake','static',false,'no_preference','A',false,$2,now(),
          'student_explicit_confirmation')
      `, [project.id, actor(1)])).rejects.toMatchObject({ code: "42501" });
      await client.query("ROLLBACK TO SAVEPOINT direct_evidence_insert");
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
  });
});
