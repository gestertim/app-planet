import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAuthPrincipalResolver, sessionCookieName } from "../../apps/web/src/server/auth-principal.ts";
import { closeServerDatabasePool } from "../../apps/web/src/server/database-session.ts";
import { createProjectHandlers } from "../../apps/web/src/server/project-handlers.ts";
import { createWorkEligibilityService } from "../../apps/web/src/server/publishing/eligibility.ts";
import { PUT } from "../../apps/web/src/app/api/v1/projects/[id]/requirements/route.ts";
import { POST } from "../../apps/web/src/app/api/v1/projects/[id]/classification/confirmation/route.ts";
import {
  createSyntheticAuthAccount, deleteSyntheticAuthAccount, loginSyntheticAccount, openControlPool,
  type SyntheticAuthAccount, type NativeAuthSession,
} from "../support/real-auth-fixture.ts";

const origin = process.env.APP_PLANET_APP_ORIGIN!;
let control: Pool;
let owner: SyntheticAuthAccount;
let other: SyntheticAuthAccount;
let session: NativeAuthSession;
let otherSession: NativeAuthSession;
const ids: string[] = [];
const defaultRequirements = {
  description: "合成目前作品需求",
  runtime_needs: "static",
  runtime_ai_required: false,
} as const;
const publicEligibility = createWorkEligibilityService("public");
const previewEligibility = createWorkEligibilityService("a1_preview");
const path = (id: string, confirm = false) =>
  `/api/v1/projects/${id}/${confirm ? "classification/confirmation" : "requirements"}`;

function request(
  id: string,
  method: string,
  body: unknown,
  version: number,
  actor: NativeAuthSession,
) {
  return new Request(`${origin}${path(id, method === "POST")}`, {
    method,
    headers: {
      cookie: `${sessionCookieName}=${actor.accessToken}`,
      origin,
      "content-type": "application/json",
      "if-match": `"${version}"`,
      "idempotency-key": randomUUID(),
    },
    body: JSON.stringify(body),
  });
}

function eligibilityRequest(actor: NativeAuthSession, claims?: unknown) {
  return new Request(`${origin}/internal/work-eligibility`, {
    method: claims === undefined ? "GET" : "POST",
    headers: {
      cookie: `${sessionCookieName}=${actor.accessToken}`,
      ...(claims === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(claims === undefined ? {} : { body: JSON.stringify(claims) }),
  });
}

const context = (id: string) => ({ params: Promise.resolve({ id }) });

async function project(actor = session) {
  const handlers = createProjectHandlers({
    resolver: createAuthPrincipalResolver(),
    requireSameOrigin: true,
  });
  const response = await handlers.create(new Request(`${origin}/api/v1/projects`, {
    method: "POST",
    headers: {
      cookie: `${sessionCookieName}=${actor.accessToken}`,
      origin,
      "content-type": "application/json",
      "idempotency-key": randomUUID(),
    },
    body: JSON.stringify({ title: "合成作品範圍驗收", tier: "A" }),
  }));
  expect(response.status).toBe(201);
  const id = (await response.json()).id as string;
  ids.push(id);
  return id;
}

async function save(
  id: string,
  rowVersion: number,
  requirementsRevision: number,
  requirements: unknown = defaultRequirements,
  actor = session,
) {
  return PUT(request(id, "PUT", {
    expected_requirements_revision: requirementsRevision,
    requirements,
  }, rowVersion, actor), context(id));
}

async function confirm(
  id: string,
  rowVersion: number,
  requirementsRevision: number,
  tier: "A" | "B" = "A",
  needsVisitorIdentity = false,
  acknowledgement: "matches" | "explicit_change" = "matches",
  actor = session,
) {
  return POST(request(id, "POST", {
    expected_requirements_revision: requirementsRevision,
    tier,
    needs_visitor_identity: needsVisitorIdentity,
    requested_tier_acknowledgement: acknowledgement,
  }, rowVersion, actor), context(id));
}

async function snapshot(id: string) {
  const { rows } = await control.query(`
    SELECT
      (SELECT to_jsonb(p) FROM app.projects p WHERE id = $1) AS project,
      (SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY revision), '[]'::jsonb)
        FROM app.project_requirements r WHERE project_id = $1) AS requirements,
      (SELECT coalesce(jsonb_agg(to_jsonb(c) ORDER BY id), '[]'::jsonb)
        FROM app.project_classification_confirmations c WHERE project_id = $1) AS confirmations,
      (SELECT coalesce(jsonb_agg(to_jsonb(i) ORDER BY operation_scope, idempotency_key), '[]'::jsonb)
        FROM app.project_classification_idempotency i WHERE project_id = $1) AS receipts
  `, [id]);
  return rows[0];
}

async function assess(
  service: typeof publicEligibility,
  id: string,
  actor = session,
  claims?: unknown,
) {
  return service.assess(eligibilityRequest(actor, claims), id);
}

beforeAll(async () => {
  control = openControlPool();
  owner = await createSyntheticAuthAccount(control, "EligibilityOwner");
  other = await createSyntheticAuthAccount(control, "EligibilityOther");
  session = await loginSyntheticAccount(owner);
  otherSession = await loginSyntheticAccount(other);
});

afterAll(async () => {
  try {
    await closeServerDatabasePool();
    if (ids.length) {
      await control.query(`
        UPDATE app.projects
        SET classification_state = 'unconfirmed', tier = NULL,
          needs_visitor_identity = NULL, current_confirmation_id = NULL
        WHERE id = ANY($1::uuid[])
      `, [ids]);
      for (const table of [
        "project_classification_idempotency",
        "project_classification_confirmations",
        "project_requirements",
        "project_create_idempotency",
        "projects",
      ]) {
        await control.query(
          `DELETE FROM app.${table} WHERE ${table === "projects" ? "id" : "project_id"} = ANY($1::uuid[])`,
          [ids],
        );
      }
    }
    for (const account of [owner, other]) {
      await control.query("DELETE FROM app.profiles WHERE id = $1", [account.id]);
      await control.query("DELETE FROM app.schools WHERE id = $1", [account.schoolId]);
      await deleteSyntheticAuthAccount(account);
    }
    console.log("WorkEligibilityCleanup=verified synthetic rows removed");
  } finally {
    await control.end();
  }
});

describe("T095 真 Auth／同一 PostgreSQL statement 作品範圍判斷", () => {
  it("A：revision N 符合，改存 N+1 後舊確認立即失效，只有新確認恢復正向", async () => {
    const id = await project();
    expect((await save(id, 0, 0)).status).toBe(200);
    expect((await confirm(id, 1, 1)).status).toBe(200);

    const before = await snapshot(id);
    expect(await assess(publicEligibility, id, session, {
      tier: "B",
      runtime_needs: "restricted_server",
      runtime_ai_required: true,
      needs_visitor_identity: true,
      confirmation: { requirements_revision: 999 },
    })).toEqual({
      outcome: "within_mvp_scope",
      assurance: "current_declared_requirements_only",
      requirements_revision: 1,
      reasons: [],
    });
    expect(await snapshot(id)).toEqual(before);

    expect((await save(id, 2, 1, {
      ...defaultRequirements,
      description: "第二個合成需求版本",
    })).status).toBe(200);
    const changed = await snapshot(id);
    expect(changed.project).toMatchObject({
      requirements_revision: 2,
      classification_state: "unconfirmed",
      current_confirmation_id: null,
    });
    expect(changed.confirmations).toHaveLength(1);
    expect(await assess(publicEligibility, id)).toEqual({
      outcome: "unconfirmed",
      requirements_revision: 2,
    });
    expect(await snapshot(id)).toEqual(changed);

    expect((await confirm(id, 3, 2)).status).toBe(200);
    const current = await snapshot(id);
    expect(await assess(publicEligibility, id)).toMatchObject({
      outcome: "within_mvp_scope",
      requirements_revision: 2,
    });
    expect(await snapshot(id)).toEqual(current);
  });

  it("B：合格 B 可判斷；公開 visitor 需求受阻，但 A1 preview 不套用公開限定", async () => {
    const id = await project();
    expect((await save(id, 0, 0, {
      ...defaultRequirements,
      runtime_needs: "work_data_api",
    })).status).toBe(200);
    expect((await confirm(id, 1, 1, "B", false, "explicit_change")).status).toBe(200);
    expect(await assess(publicEligibility, id)).toMatchObject({
      outcome: "within_mvp_scope",
      requirements_revision: 1,
    });

    expect((await save(id, 2, 1, {
      ...defaultRequirements,
      runtime_needs: "work_data_api",
      description: "需要訪客識別的 B 作品",
    })).status).toBe(200);
    expect((await confirm(id, 3, 2, "B", true, "explicit_change")).status).toBe(200);
    const beforeRead = await snapshot(id);
    expect(await assess(publicEligibility, id)).toMatchObject({
      outcome: "outside_mvp_scope",
      requirements_revision: 2,
      reasons: ["tier_b_needs_visitor_identity"],
    });
    expect(await assess(previewEligibility, id)).toMatchObject({
      outcome: "within_mvp_scope",
      requirements_revision: 2,
    });
    expect(await snapshot(id)).toEqual(beforeRead);
  });

  it("restricted_server／作品 runtime AI 是當前硬阻擋；不偽造分類確認", async () => {
    const id = await project();
    expect((await save(id, 0, 0, {
      ...defaultRequirements,
      runtime_needs: "restricted_server",
    })).status).toBe(200);
    expect(await assess(publicEligibility, id)).toMatchObject({
      outcome: "outside_mvp_scope",
      requirements_revision: 1,
      reasons: ["student_server_runtime_not_in_mvp"],
    });
    expect((await save(id, 1, 1, {
      ...defaultRequirements,
      runtime_ai_required: true,
    })).status).toBe(200);
    expect(await assess(publicEligibility, id)).toMatchObject({
      outcome: "outside_mvp_scope",
      requirements_revision: 2,
      reasons: ["work_runtime_ai_not_in_mvp"],
    });
    expect((await snapshot(id)).project).toMatchObject({
      classification_state: "unconfirmed",
      tier: null,
      current_confirmation_id: null,
    });
  });

  it("未確認／歷史未驗證不產生正向結果；不存在與非擁有者不洩漏", async () => {
    const unconfirmedId = await project();
    expect(await assess(publicEligibility, unconfirmedId)).toEqual({
      outcome: "requirements_missing",
      requirements_revision: 0,
    });
    expect((await save(unconfirmedId, 0, 0)).status).toBe(200);
    expect(await assess(publicEligibility, unconfirmedId)).toEqual({
      outcome: "unconfirmed",
      requirements_revision: 1,
    });

    const legacyId = await project();
    await control.query(`
      UPDATE app.projects
      SET classification_state = 'legacy_unverified', requested_tier = NULL,
        tier = 'A', needs_visitor_identity = false,
        requirements_revision = 0, current_confirmation_id = NULL
      WHERE id = $1
    `, [legacyId]);
    expect(await assess(publicEligibility, legacyId)).toEqual({ outcome: "legacy_unverified" });

    const otherId = await project(otherSession);
    expect(await assess(publicEligibility, otherId)).toEqual({ outcome: "not_found" });
    expect(await assess(publicEligibility, unconfirmedId, otherSession)).toEqual({ outcome: "not_found" });
  });

  it("角色／帳號／學校資格失效即拒絕，恢復後按當前 DB 判斷", async () => {
    const id = await project();
    expect((await save(id, 0, 0)).status).toBe(200);
    expect((await confirm(id, 1, 1)).status).toBe(200);

    await control.query("UPDATE app.profiles SET role = 'teacher' WHERE id = $1", [owner.id]);
    expect(await assess(publicEligibility, id)).toEqual({
      outcome: "denied",
      reason: "policy_denied",
    });
    await control.query("UPDATE app.profiles SET role = 'student' WHERE id = $1", [owner.id]);

    await control.query("UPDATE app.profiles SET status = 'disabled' WHERE id = $1", [owner.id]);
    expect(await assess(publicEligibility, id)).toEqual({
      outcome: "denied",
      reason: "policy_denied",
    });
    await control.query("UPDATE app.profiles SET status = 'approved' WHERE id = $1", [owner.id]);

    for (const approvalState of ["withdrawn", "expired"]) {
      await control.query("UPDATE app.schools SET approval_state = $1 WHERE id = $2", [approvalState, owner.schoolId]);
      expect(await assess(publicEligibility, id)).toMatchObject({
        outcome: "within_mvp_scope",
        requirements_revision: 1,
      });
    }

    await control.query("UPDATE app.schools SET approval_state = 'unconfirmed' WHERE id = $1", [owner.schoolId]);
    expect(await assess(publicEligibility, id)).toEqual({
      outcome: "denied",
      reason: "policy_denied",
    });
    await control.query("UPDATE app.schools SET approval_state = 'approved' WHERE id = $1", [owner.schoolId]);
    expect(await assess(publicEligibility, id)).toMatchObject({
      outcome: "within_mvp_scope",
      requirements_revision: 1,
    });
  });

  it("DB 欄位讀取故障回 dependency_failure，恢復權限後可重新讀取", async () => {
    const id = await project();
    expect((await save(id, 0, 0)).status).toBe(200);
    expect((await confirm(id, 1, 1)).status).toBe(200);
    const before = await snapshot(id);
    const privilege = await control.query(`
      SELECT has_table_privilege('authenticated', 'app.project_requirements', 'SELECT') AS granted
    `);
    expect(privilege.rows[0].granted).toBe(true);

    await control.query("REVOKE SELECT ON app.project_requirements FROM authenticated");
    try {
      expect(await assess(publicEligibility, id)).toEqual({
        outcome: "failed",
        reason: "dependency_failure",
      });
    } finally {
      await control.query("GRANT SELECT ON app.project_requirements TO authenticated");
    }

    const restored = await control.query(`
      SELECT has_table_privilege('authenticated', 'app.project_requirements', 'SELECT') AS granted
    `);
    expect(restored.rows[0].granted).toBe(true);
    expect(await snapshot(id)).toEqual(before);
    expect(await assess(publicEligibility, id)).toMatchObject({ outcome: "within_mvp_scope" });
  });
});
