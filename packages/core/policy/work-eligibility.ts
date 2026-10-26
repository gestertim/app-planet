import { z } from "zod";
import { projectTierSchema } from "../contracts/common.ts";

// This helper validates input shape, not the provenance of student- or project-declared facts.
export const workEligibilityContextSchema = z.enum(["a1_preview", "public"]);
const runtimeNeedsSchema = z.enum(["static", "work_data_api", "restricted_server"]);

export const workEligibilityInputSchema = z
  .object({
    tier: projectTierSchema,
    runtimeNeeds: runtimeNeedsSchema,
    context: workEligibilityContextSchema,
    requiresVisitorIdentity: z.boolean(),
    runtimeAiRequired: z.boolean(),
    platformAiAssistedCreation: z.boolean().optional(),
  })
  .strict();

export type WorkEligibilityInput = z.infer<typeof workEligibilityInputSchema>;
export type WorkEligibilityContext = z.infer<typeof workEligibilityContextSchema>;
export type WorkEligibilityReason =
  | "invalid_input"
  | "inconsistent_input"
  | "tier_b_needs_visitor_identity"
  | "student_server_runtime_not_in_mvp"
  | "work_runtime_ai_not_in_mvp";

export interface WorkEligibilityResult {
  withinMvpSupport: boolean;
  context: WorkEligibilityContext | null;
  reasons: readonly WorkEligibilityReason[];
}

// Local reasons describe scope only; they are not an HTTP error mapping or an operation grant.
export function evaluateWorkEligibility(input: unknown): WorkEligibilityResult {
  const parsed = workEligibilityInputSchema.safeParse(input);
  if (!parsed.success) {
    return {
      withinMvpSupport: false,
      context: null,
      reasons: ["invalid_input"],
    };
  }

  const facts = parsed.data;
  const reasons: WorkEligibilityReason[] = [];

  if (facts.runtimeNeeds === "restricted_server") {
    reasons.push("student_server_runtime_not_in_mvp");
  } else {
    const expectedRuntimeNeeds = facts.tier === "A" ? "static" : "work_data_api";
    if (facts.runtimeNeeds !== expectedRuntimeNeeds) {
      reasons.push("inconsistent_input");
    }
  }

  if (
    facts.context === "public" &&
    facts.requiresVisitorIdentity
  ) {
    if (facts.tier === "B") {
      reasons.push("tier_b_needs_visitor_identity");
    } else if (!reasons.includes("inconsistent_input")) {
      reasons.push("inconsistent_input");
    }
  }

  if (facts.runtimeAiRequired) {
    reasons.push("work_runtime_ai_not_in_mvp");
  }

  return {
    withinMvpSupport: reasons.length === 0,
    context: facts.context,
    reasons,
  };
}
