import type { WorkEligibilityContext, WorkEligibilityReason } from "@app-planet/core";
import type { ProjectWorkEligibilityResult } from "@/server/publishing/eligibility";

type ScopeBlocker = Extract<
  WorkEligibilityReason,
  "student_server_runtime_not_in_mvp" | "work_runtime_ai_not_in_mvp"
>;

export type WorkLimitationsState =
  | Readonly<{ kind: "within_scope" }>
  | Readonly<{ kind: "requirements_missing" }>
  | Readonly<{ kind: "unconfirmed" }>
  | Readonly<{ kind: "legacy_unverified" }>
  | Readonly<{ kind: "outside_scope"; blockers: readonly ScopeBlocker[] }>
  | Readonly<{ kind: "public_visitor_identity" }>
  | Readonly<{ kind: "unavailable" }>
  | Readonly<{ kind: "access_closed" }>;

export function toWorkLimitationsState(
  result: ProjectWorkEligibilityResult,
  purpose: WorkEligibilityContext,
): WorkLimitationsState {
  switch (result.outcome) {
    case "within_mvp_scope":
      return result.assurance === "current_declared_requirements_only" && result.reasons.length === 0
        ? { kind: "within_scope" }
        : { kind: "unavailable" };
    case "outside_mvp_scope": {
      if (result.assurance !== "current_declared_requirements_only") return { kind: "unavailable" };
      const blockers = result.reasons.filter((reason): reason is ScopeBlocker =>
        reason === "student_server_runtime_not_in_mvp" || reason === "work_runtime_ai_not_in_mvp");
      if (blockers.length !== result.reasons.length) {
        return purpose === "public" &&
            result.reasons.length === 1 &&
            result.reasons[0] === "tier_b_needs_visitor_identity"
          ? { kind: "public_visitor_identity" }
          : { kind: "unavailable" };
      }
      return blockers.length > 0 ? { kind: "outside_scope", blockers } : { kind: "unavailable" };
    }
    case "requirements_missing":
      return { kind: "requirements_missing" };
    case "unconfirmed":
      return { kind: "unconfirmed" };
    case "legacy_unverified":
      return { kind: "legacy_unverified" };
    case "not_found":
    case "unauthenticated":
    case "denied":
      return { kind: "access_closed" };
    case "failed":
      return { kind: "unavailable" };
  }
}
