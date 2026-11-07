import "server-only";
import {
  evaluateWorkEligibility,
  getWorkEligibilityRequirementBlockers,
  workEligibilityContextSchema,
  type WorkEligibilityContext,
  type WorkEligibilityReason,
} from "@app-planet/core";
import { createAuthPrincipalResolver } from "../auth-principal.ts";
import { DatabaseConfigurationUnavailableError } from "../database-session.ts";
import { readCurrentOwnedProjectClassificationSubset } from "../project-classification.ts";
import type { PrincipalResolution, TrustedPrincipalResolver } from "../http.ts";

type RequirementScopeOutcome = "within_mvp_scope" | "outside_mvp_scope";
type ScopeAssurance = "current_declared_requirements_only";

export type ProjectWorkEligibilityResult =
  | {
    outcome: RequirementScopeOutcome;
    assurance: ScopeAssurance;
    requirements_revision: number;
    reasons: readonly WorkEligibilityReason[];
  }
  | { outcome: "unconfirmed"; requirements_revision: number }
  | { outcome: "requirements_missing"; requirements_revision: number }
  | { outcome: "legacy_unverified" }
  | { outcome: "not_found" }
  | { outcome: "unauthenticated" }
  | { outcome: "denied"; reason: "policy_denied" }
  | {
    outcome: "failed";
    reason: "invalid_input" | "invalid_context" | "dependency_failure" | "invalid_result";
  };

export interface WorkEligibilityService {
  assess(request: Request, projectId: unknown): Promise<ProjectWorkEligibilityResult>;
}

export function createWorkEligibilityService(
  purpose: WorkEligibilityContext,
  resolver: TrustedPrincipalResolver = createAuthPrincipalResolver(),
): WorkEligibilityService {
  const parsedPurpose = workEligibilityContextSchema.safeParse(purpose);
  if (!parsedPurpose.success) throw new TypeError("invalid_work_eligibility_purpose");

  return Object.freeze({
    async assess(request: Request, projectId: unknown): Promise<ProjectWorkEligibilityResult> {
      let principal: PrincipalResolution;
      try {
        principal = await resolver.resolve(request);
      } catch (error) {
        if (error instanceof DatabaseConfigurationUnavailableError) {
          return { outcome: "failed", reason: "dependency_failure" };
        }
        throw error;
      }

      if (!principal.ok) {
        if (principal.reason === "unauthenticated") return { outcome: "unauthenticated" };
        if (principal.reason === "dependency_unavailable") {
          return { outcome: "failed", reason: "dependency_failure" };
        }
        return { outcome: "denied", reason: "policy_denied" };
      }

      const current = await readCurrentOwnedProjectClassificationSubset(principal.session.read, projectId);
      if (current.outcome !== "found") {
        if (current.outcome === "not_found") return current;
        if (current.outcome === "denied") return current;
        return { outcome: "failed", reason: current.reason };
      }

      const project = current.project;
      if (project.classification_state === "legacy_unverified") {
        return { outcome: "legacy_unverified" };
      }

      if (!project.requirements) {
        return {
          outcome: "requirements_missing",
          requirements_revision: project.requirements_revision,
        };
      }

      const blockers = getWorkEligibilityRequirementBlockers({
        runtimeNeeds: project.requirements.runtime_needs,
        runtimeAiRequired: project.requirements.runtime_ai_required,
      });
      if (blockers.includes("invalid_input")) {
        return { outcome: "failed", reason: "invalid_result" };
      }
      if (blockers.length > 0) {
        return {
          outcome: "outside_mvp_scope",
          assurance: "current_declared_requirements_only",
          requirements_revision: project.requirements_revision,
          reasons: blockers,
        };
      }

      if (project.classification_state === "unconfirmed") {
        return {
          outcome: "unconfirmed",
          requirements_revision: project.requirements_revision,
        };
      }

      const assessment = evaluateWorkEligibility({
        tier: project.tier,
        runtimeNeeds: project.requirements.runtime_needs,
        context: parsedPurpose.data,
        requiresVisitorIdentity: project.needs_visitor_identity,
        runtimeAiRequired: project.requirements.runtime_ai_required,
      });
      if (assessment.context === null || assessment.reasons.includes("invalid_input")) {
        return { outcome: "failed", reason: "invalid_result" };
      }

      return {
        outcome: assessment.withinMvpSupport ? "within_mvp_scope" : "outside_mvp_scope",
        assurance: "current_declared_requirements_only",
        requirements_revision: project.requirements_revision,
        reasons: assessment.reasons,
      };
    },
  });
}
