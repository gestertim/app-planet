import { z } from "zod";
import {
  projectStageSchema,
  stageDraftDtoSchema,
} from "../contracts/stage-drafts.ts";
import {
  projectRequirementsSchema,
  type ProjectRequirements,
} from "../contracts/project-classification.ts";
import { utcInstantSchema } from "../contracts/common.ts";
import {
  evaluateWorkEligibility,
  type WorkEligibilityReason,
} from "./work-eligibility.ts";

const uuidSchema = z.string().uuid();
const revisionSchema = z.number().int().min(0).max(2147483647);

const confirmationSchema = z.object({
  id: uuidSchema,
  project_id: uuidSchema,
  tier: z.enum(["A", "B"]),
  needs_visitor_identity: z.boolean(),
  requirements_revision: z.number().int().positive().max(2147483647),
  confirmed_by: uuidSchema,
  confirmed_at: utcInstantSchema,
  source: z.literal("student_explicit_confirmation"),
  requirements_snapshot: projectRequirementsSchema,
  requested_tier_at_confirmation: z.enum(["A", "B"]).nullable(),
  requested_tier_acknowledgement: z.enum(["no_preference", "matches", "explicit_change"]),
}).strict();

const unconfirmedClassificationSchema = z.object({
  project_id: uuidSchema,
  state: z.literal("unconfirmed"),
  requested_tier: z.enum(["A", "B"]).nullable(),
  tier: z.enum(["A", "B"]).nullable(),
  needs_visitor_identity: z.boolean().nullable(),
  requirements_revision: revisionSchema,
  confirmation: confirmationSchema.nullable(),
}).strict();

const legacyClassificationSchema = z.object({
  project_id: uuidSchema,
  state: z.literal("legacy_unverified"),
  requested_tier: z.null(),
  tier: z.enum(["A", "B"]),
  needs_visitor_identity: z.boolean(),
  requirements_revision: z.literal(0),
  confirmation: z.null(),
}).strict();

const confirmedClassificationSchema = z.object({
  project_id: uuidSchema,
  state: z.literal("confirmed"),
  requested_tier: z.enum(["A", "B"]).nullable(),
  tier: z.enum(["A", "B"]),
  needs_visitor_identity: z.boolean(),
  requirements_revision: z.number().int().positive().max(2147483647),
  confirmation: confirmationSchema,
}).strict();

export const creationClassificationEvidenceSchema = z.discriminatedUnion("state", [
  unconfirmedClassificationSchema,
  legacyClassificationSchema,
  confirmedClassificationSchema,
]);

const projectEvidenceSchema = z.object({
  id: uuidSchema,
  current_stage: projectStageSchema,
}).strict();

const requirementsEvidenceSchema = z.object({
  project_id: uuidSchema,
  revision: z.number().int().positive().max(2147483647),
  content: projectRequirementsSchema,
}).strict();

export const creationFlowInputSchema = z.object({
  project: projectEvidenceSchema,
  requested_stage: projectStageSchema,
  requirements: requirementsEvidenceSchema.nullable(),
  classification: creationClassificationEvidenceSchema,
  platform_ai_assisted_creation: z.boolean().optional(),
  stage_drafts: z.array(stageDraftDtoSchema),
}).strict();

export type CreationClassificationEvidence = z.infer<typeof creationClassificationEvidenceSchema>;
export type CreationFlowInput = z.infer<typeof creationFlowInputSchema>;
export type CreationFlowStage = z.infer<typeof projectStageSchema>;

export const CREATION_FLOW_STAGES: readonly CreationFlowStage[] =
  Object.freeze([...projectStageSchema.options]);
const UNRESOLVED_CREATION_FLOW_DECISIONS = Object.freeze([
  "stage_completion_policy",
  "six_to_nine_stage_mapping",
  "approval_evidence_contract",
  "specification_sync_evidence_contract",
  "approved_task_scope_mapping",
  "review_evidence_contract",
] as const);

export type CreationFlowAssessment =
  | {
    outcome: "evaluated";
    evidence_assurance: "structural_only";
    current_stage: CreationFlowStage;
    requested_stage: CreationFlowStage;
    requested_stage_prerequisites: readonly CreationFlowStage[];
    stage_assessment:
      | { outcome: "missing_evidence"; evidence: "current_classification_confirmation" }
      | {
        outcome: "unsupported";
        reason: "stage_completion_rules_undecided";
        unresolved_prerequisites: readonly CreationFlowStage[];
        unresolved_decisions: typeof UNRESOLVED_CREATION_FLOW_DECISIONS;
      };
    classification_assessment:
      | { outcome: "satisfied"; tier: "A" | "B"; requirements_revision: number }
      | {
        outcome: "missing_evidence";
        reason: "current_student_confirmation_required";
      };
    work_scope_assessment:
      | { outcome: "missing_evidence"; reason: "current_classification_confirmation_required" }
      | { outcome: "satisfied"; reasons: readonly [] }
      | {
        outcome: "unsupported" | "invalid_evidence";
        reasons: readonly WorkEligibilityReason[];
      };
    observed_drafts: readonly {
      stage: CreationFlowStage;
      state: "ai_draft";
      content_source: "student_input";
    }[];
  }
  | { outcome: "invalid_input"; reason: "invalid_shape" }
  | {
    outcome: "invalid_evidence";
    reason:
      | "project_mismatch"
      | "requirements_revision_mismatch"
      | "confirmation_mismatch"
      | "classification_contradiction"
      | "draft_project_mismatch"
      | "duplicate_stage_draft";
  };

type InvalidEvidenceReason = Extract<
  CreationFlowAssessment,
  { outcome: "invalid_evidence" }
>["reason"];

function sameRequirements(left: ProjectRequirements, right: ProjectRequirements): boolean {
  return left.description === right.description &&
    left.runtime_needs === right.runtime_needs &&
    left.runtime_ai_required === right.runtime_ai_required;
}

function relationFailure(input: CreationFlowInput): InvalidEvidenceReason | null {
  const { project, requirements, classification, stage_drafts } = input;
  if (classification.project_id !== project.id) return "project_mismatch";
  if (requirements !== null && requirements.project_id !== project.id) return "project_mismatch";

  const currentRevision = requirements?.revision ?? 0;
  if (classification.requirements_revision !== currentRevision) {
    return "requirements_revision_mismatch";
  }

  if (classification.state === "unconfirmed") {
    if (
      classification.tier !== null ||
      classification.needs_visitor_identity !== null ||
      classification.confirmation !== null
    ) return "classification_contradiction";
    if ((currentRevision === 0) !== (requirements === null)) {
      return "requirements_revision_mismatch";
    }
  } else if (classification.state === "legacy_unverified") {
    if (requirements !== null || classification.confirmation !== null) {
      return "classification_contradiction";
    }
  } else {
    const confirmation = classification.confirmation;
    if (
      requirements === null ||
      confirmation.project_id !== project.id ||
      confirmation.project_id !== classification.project_id ||
      confirmation.tier !== classification.tier ||
      confirmation.needs_visitor_identity !== classification.needs_visitor_identity ||
      confirmation.requirements_revision !== currentRevision ||
      confirmation.source !== "student_explicit_confirmation" ||
      !sameRequirements(confirmation.requirements_snapshot, requirements.content)
    ) return "confirmation_mismatch";
    const requestedTierAtConfirmation = confirmation.requested_tier_at_confirmation;
    const acknowledgement = confirmation.requested_tier_acknowledgement;
    if (
      requestedTierAtConfirmation !== classification.requested_tier ||
      (requestedTierAtConfirmation === null && acknowledgement !== "no_preference") ||
      (requestedTierAtConfirmation === classification.tier && acknowledgement !== "matches") ||
      (requestedTierAtConfirmation !== null &&
        requestedTierAtConfirmation !== classification.tier &&
        acknowledgement !== "explicit_change")
    ) return "confirmation_mismatch";
  }

  const seenStages = new Set<CreationFlowStage>();
  for (const draft of stage_drafts) {
    if (draft.project_id !== project.id) return "draft_project_mismatch";
    if (seenStages.has(draft.stage)) return "duplicate_stage_draft";
    seenStages.add(draft.stage);
  }

  return null;
}

function currentClassification(
  input: CreationFlowInput,
): Extract<CreationFlowAssessment, { outcome: "evaluated" }>["classification_assessment"] {
  const { classification } = input;
  if (classification.state !== "confirmed") {
    return {
      outcome: "missing_evidence",
      reason: "current_student_confirmation_required",
    };
  }
  return {
    outcome: "satisfied",
    tier: classification.tier,
    requirements_revision: classification.requirements_revision,
  };
}

function assessWorkScope(
  input: CreationFlowInput,
): Extract<CreationFlowAssessment, { outcome: "evaluated" }>["work_scope_assessment"] {
  const { classification, requirements } = input;
  if (classification.state !== "confirmed" || requirements === null) {
    return {
      outcome: "missing_evidence",
      reason: "current_classification_confirmation_required",
    };
  }

  // This checks only runtime scope; the preview context is not returned as an authorization decision.
  const assessment = evaluateWorkEligibility({
    tier: classification.tier,
    runtimeNeeds: requirements.content.runtime_needs,
    context: "a1_preview",
    requiresVisitorIdentity: classification.needs_visitor_identity,
    runtimeAiRequired: requirements.content.runtime_ai_required,
  });
  if (assessment.reasons.includes("inconsistent_input")) {
    return { outcome: "invalid_evidence", reasons: assessment.reasons };
  }
  if (!assessment.withinMvpSupport) {
    return { outcome: "unsupported", reasons: assessment.reasons };
  }
  return { outcome: "satisfied", reasons: [] };
}

export function evaluateCreationFlow(input: CreationFlowInput): CreationFlowAssessment {
  const parsed = creationFlowInputSchema.safeParse(input);
  if (!parsed.success) return { outcome: "invalid_input", reason: "invalid_shape" };

  const evidence = parsed.data;
  const relationError = relationFailure(evidence);
  if (relationError !== null) return { outcome: "invalid_evidence", reason: relationError };

  const targetIndex = CREATION_FLOW_STAGES.indexOf(evidence.requested_stage);
  const prerequisites = CREATION_FLOW_STAGES.slice(0, targetIndex);
  const classificationAssessment = currentClassification(evidence);
  const stageAssessment =
    targetIndex > 0 && classificationAssessment.outcome === "missing_evidence"
      ? {
        outcome: "missing_evidence" as const,
        evidence: "current_classification_confirmation" as const,
      }
      : {
        outcome: "unsupported" as const,
        reason: "stage_completion_rules_undecided" as const,
        unresolved_prerequisites: prerequisites,
        unresolved_decisions: UNRESOLVED_CREATION_FLOW_DECISIONS,
      };

  return {
    outcome: "evaluated",
    evidence_assurance: "structural_only",
    current_stage: evidence.project.current_stage,
    requested_stage: evidence.requested_stage,
    requested_stage_prerequisites: prerequisites,
    stage_assessment: stageAssessment,
    classification_assessment: classificationAssessment,
    work_scope_assessment: assessWorkScope(evidence),
    observed_drafts: evidence.stage_drafts.map((draft) => ({
      stage: draft.stage,
      state: draft.state,
      content_source: draft.content_source,
    })),
  };
}
