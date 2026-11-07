import { describe, expect, it, vi } from "vitest";
import { DatabaseConfigurationUnavailableError } from "../../apps/web/src/server/database-session.ts";
import { createWorkEligibilityService } from "../../apps/web/src/server/publishing/eligibility.ts";
import type { AuthorizationQuery } from "../../apps/web/src/server/authorization.ts";
import type { TrustedPrincipalResolver, TrustedSession } from "../../apps/web/src/server/http.ts";

const ownerId = "10000000-0000-4000-8000-000000000001";
const projectId = "20000000-0000-4000-8000-000000000001";
const confirmationId = "30000000-0000-4000-8000-000000000001";
const requirement = {
  description: "合成目前需求",
  runtime_needs: "static",
  runtime_ai_required: false,
};

function confirmedProject(overrides: Record<string, unknown> = {}) {
  return {
    id: projectId,
    title: "合成作品",
    stage: "A/B",
    created_at: "2026-01-01T00:00:00.000Z",
    row_version: 2,
    classification_state: "confirmed",
    requested_tier: "A",
    tier: "A",
    needs_visitor_identity: false,
    requirements_revision: 1,
    requirements: requirement,
    confirmation: {
      id: confirmationId,
      requirements_revision: 1,
      confirmed_by: ownerId,
      confirmed_at: "2026-01-01T00:00:00.000Z",
      source: "student_explicit_confirmation",
      requested_tier_at_confirmation: "A",
      requested_tier_acknowledgement: "matches",
      requirements_match: true,
    },
    ...overrides,
  };
}

function harness(project: unknown, options: {
  readFailure?: boolean;
  allowed?: boolean;
  resolveFailure?: unknown;
  principal?: { ok: false; reason: "unauthenticated" | "account_disabled" | "dependency_unavailable" };
} = {}) {
  let statementCount = 0;
  const query: AuthorizationQuery["query"] = async () => {
    statementCount += 1;
    if (options.readFailure) throw new Error("private_database_error");
    return {
      rows: [{
        subject: ownerId,
        actor_valid: true,
        allowed: options.allowed ?? true,
        project,
      }],
    };
  };
  const session: TrustedSession = {
    read: { runReadOnly: (operation) => operation({ query }) },
    write: { runTransaction: (operation) => operation({ query }) },
    usage: { runTransaction: (operation) => operation({ query }) },
  };
  const resolve = vi.fn<TrustedPrincipalResolver["resolve"]>(async () => {
    if (options.resolveFailure !== undefined) throw options.resolveFailure;
    return options.principal ?? { ok: true, session };
  });
  const resolver: TrustedPrincipalResolver = { resolve };
  const service = createWorkEligibilityService("public", resolver);
  return { service, resolve, getStatementCount: () => statementCount };
}

const request = (claims?: unknown) => new Request("https://example.invalid/internal", {
  method: claims === undefined ? "GET" : "POST",
  ...(claims === undefined ? {} : {
    headers: { "content-type": "application/json" },
    body: JSON.stringify(claims),
  }),
});

describe("server-side work eligibility service", () => {
  it("每次重新讀當前專案；不採 caller claims，正向只描述申報範圍", async () => {
    const h = harness(confirmedProject());
    const before = {
      tier: "B",
      runtime_needs: "restricted_server",
      runtime_ai_required: true,
      needs_visitor_identity: true,
      confirmation: { requirements_revision: 999 },
    };
    const result = await h.service.assess(request(before), projectId);

    expect(result).toEqual({
      outcome: "within_mvp_scope",
      assurance: "current_declared_requirements_only",
      requirements_revision: 1,
      reasons: [],
    });
    expect(h.resolve).toHaveBeenCalledOnce();
    expect(h.getStatementCount()).toBe(1);
  });

  it("未確認的目前正式需求只回不可支援 blockers 或 unconfirmed，不推定 tier", async () => {
    const restricted = harness({
      id: projectId, title: "合成作品", stage: "A/B", created_at: "2026-01-01T00:00:00.000Z",
      row_version: 1, classification_state: "unconfirmed", requested_tier: "A", tier: null,
      needs_visitor_identity: null, requirements_revision: 3,
      requirements: { ...requirement, runtime_needs: "restricted_server", runtime_ai_required: true },
      confirmation: null,
    });
    const result = await restricted.service.assess(request(), projectId);
    expect(result).toEqual({
      outcome: "outside_mvp_scope",
      assurance: "current_declared_requirements_only",
      requirements_revision: 3,
      reasons: ["student_server_runtime_not_in_mvp", "work_runtime_ai_not_in_mvp"],
    });

    const unconfirmed = harness({
      id: projectId, title: "合成作品", stage: "A/B", created_at: "2026-01-01T00:00:00.000Z",
      row_version: 1, classification_state: "unconfirmed", requested_tier: "A", tier: null,
      needs_visitor_identity: null, requirements_revision: 3, requirements: requirement, confirmation: null,
    });
    expect(await unconfirmed.service.assess(request(), projectId)).toEqual({
      outcome: "unconfirmed",
      requirements_revision: 3,
    });
  });

  it("公開 B 的 visitor 需求受阻，A1 private 不套用公開限定", async () => {
    const b = confirmedProject({
      requested_tier: "A",
      tier: "B",
      needs_visitor_identity: true,
      requirements: { ...requirement, runtime_needs: "work_data_api" },
      confirmation: {
        id: confirmationId,
        requirements_revision: 1,
        confirmed_by: ownerId,
        confirmed_at: "2026-01-01T00:00:00.000Z",
        source: "student_explicit_confirmation",
        requested_tier_at_confirmation: "A",
        requested_tier_acknowledgement: "explicit_change",
        requirements_match: true,
      },
    });
    const publicHarness = harness(b);
    const privateHarness = harness(b);
    const publicService = publicHarness.service;
    const privateService = createWorkEligibilityService("a1_preview", {
      resolve: privateHarness.resolve,
    });
    expect(await publicService.assess(request(), projectId)).toMatchObject({
      outcome: "outside_mvp_scope",
      reasons: ["tier_b_needs_visitor_identity"],
    });
    expect(await privateService.assess(request(), projectId)).toMatchObject({
      outcome: "within_mvp_scope",
      requirements_revision: 1,
    });
  });

  it("分開回傳缺需求、歷史未驗證、not found、policy denied 與 Auth／DB 失敗", async () => {
    const missing = harness({
      id: projectId, title: "合成作品", stage: "點子", created_at: "2026-01-01T00:00:00.000Z",
      row_version: 0, classification_state: "unconfirmed", requested_tier: "A", tier: null,
      needs_visitor_identity: null, requirements_revision: 0, requirements: null, confirmation: null,
    });
    expect(await missing.service.assess(request(), projectId)).toEqual({
      outcome: "requirements_missing",
      requirements_revision: 0,
    });

    const legacy = harness({
      id: projectId, title: "合成作品", stage: "點子", created_at: "2026-01-01T00:00:00.000Z",
      row_version: 0, classification_state: "legacy_unverified", requested_tier: null, tier: "A",
      needs_visitor_identity: false, requirements_revision: 0, requirements: null, confirmation: null,
    });
    expect(await legacy.service.assess(request(), projectId)).toEqual({ outcome: "legacy_unverified" });
    expect(await harness(null).service.assess(request(), projectId)).toEqual({ outcome: "not_found" });
    expect(await harness(confirmedProject(), { allowed: false }).service.assess(request(), projectId))
      .toEqual({ outcome: "denied", reason: "policy_denied" });
    expect(await harness(null, { principal: { ok: false, reason: "unauthenticated" } })
      .service.assess(request(), projectId)).toEqual({ outcome: "unauthenticated" });
    expect(await harness(null, { principal: { ok: false, reason: "dependency_unavailable" } })
      .service.assess(request(), projectId)).toEqual({ outcome: "failed", reason: "dependency_failure" });
    expect(await harness(confirmedProject(), { readFailure: true }).service.assess(request(), projectId))
      .toEqual({ outcome: "failed", reason: "dependency_failure" });
  });

  it("只將資料庫設定依賴錯誤轉為 failed，其他 resolver 例外仍明確拋出", async () => {
    const unavailable = harness(null, { resolveFailure: new DatabaseConfigurationUnavailableError() });
    expect(await unavailable.service.assess(request(), projectId)).toEqual({
      outcome: "failed",
      reason: "dependency_failure",
    });
    expect(unavailable.getStatementCount()).toBe(0);

    const unexpected = harness(null, { resolveFailure: new Error("unexpected_resolver_failure") });
    await expect(unexpected.service.assess(request(), projectId))
      .rejects.toThrow("unexpected_resolver_failure");
    expect(unexpected.getStatementCount()).toBe(0);
  });

  it("拒絕非法專案 ID，且不執行 DB 查詢", async () => {
    const h = harness(confirmedProject());
    expect(await h.service.assess(request(), "not-a-project-id")).toEqual({
      outcome: "failed",
      reason: "invalid_input",
    });
    expect(h.getStatementCount()).toBe(0);
  });
});
