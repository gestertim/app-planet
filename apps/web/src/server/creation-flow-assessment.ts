import { z } from "zod";
import {
  creationFlowInputSchema,
  projectRequirementsSchema,
  projectStageSchema,
  stageDraftDtoSchema,
  evaluateCreationFlow,
  type CreationFlowAssessment,
  type CreationFlowInput,
  type ProjectRequirements,
} from "@app-planet/core";
import type { AuthorizationContext } from "./authorization.ts";
import {
  parseCurrentProjectClassificationDto,
  projectClassificationReadSql,
  type CurrentProjectClassificationDto,
} from "./project-classification.ts";

export type OwnedProjectCreationFlowAssessmentResult =
  | {
    outcome: "evaluated";
    snapshot: "single_statement";
    project_id: string;
    row_version: number;
    requirements_revision: number;
    assessment: Extract<CreationFlowAssessment, { outcome: "evaluated" }>;
  }
  | { outcome: "not_found" }
  | { outcome: "denied"; reason: "policy_denied" }
  | { outcome: "failed"; reason: "invalid_input" | "invalid_context" | "dependency_failure" | "invalid_result" };

const requestSchema = z.object({
  project_id: z.string().uuid(),
  requested_stage: projectStageSchema,
}).strict();

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const projectKeys = [
  "id", "title", "stage", "created_at", "row_version", "classification_state", "requested_tier", "tier",
  "needs_visitor_identity", "requirements_revision", "requirements", "confirmation",
] as const;
const confirmationKeys = [
  "id", "requirements_revision", "confirmed_by", "confirmed_at", "source", "requested_tier_at_confirmation",
  "requested_tier_acknowledgement", "requirements_match",
] as const;
const evidenceKeys = [
  "id", "project_id", "requirements_revision", "requirements_snapshot", "tier", "needs_visitor_identity",
  "confirmed_by", "confirmed_at", "source", "requested_tier_at_confirmation",
  "requested_tier_acknowledgement",
] as const;
const draftKeys = [
  "project_id", "stage", "row_version", "state", "content_source", "content", "approved_by", "approved_at",
] as const;
const confirmationEvidenceSchema = z.object({
  id: z.string().uuid(),
  project_id: z.string().uuid(),
  requirements_revision: z.number().int().positive().max(2147483647),
  requirements_snapshot: projectRequirementsSchema,
  tier: z.enum(["A", "B"]),
  needs_visitor_identity: z.boolean(),
  confirmed_by: z.string().uuid(),
  confirmed_at: z.string(),
  source: z.literal("student_explicit_confirmation"),
  requested_tier_at_confirmation: z.enum(["A", "B"]).nullable(),
  requested_tier_acknowledgement: z.enum(["no_preference", "matches", "explicit_change"]),
}).strict();

const creationFlowReadSql = `
  WITH current_project AS MATERIALIZED (${projectClassificationReadSql(false)})
  SELECT current_project.subject, current_project.actor_valid, current_project.allowed,
    current_project.project,
    CASE WHEN current_project.project IS NULL
      OR current_project.project->'confirmation' = 'null'::jsonb THEN NULL
      ELSE (
        SELECT jsonb_build_object(
          'id', evidence.id::text,
          'project_id', evidence.project_id::text,
          'requirements_revision', evidence.requirements_revision,
          'requirements_snapshot', jsonb_build_object(
            'description', evidence.requirements_description,
            'runtime_needs', evidence.requirements_runtime_needs,
            'runtime_ai_required', evidence.requirements_runtime_ai_required
          ),
          'tier', evidence.tier,
          'needs_visitor_identity', evidence.needs_visitor_identity,
          'confirmed_by', evidence.confirmed_by::text,
          'confirmed_at', to_char(evidence.confirmed_at AT TIME ZONE 'UTC',
            'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
          'source', evidence.source,
          'requested_tier_at_confirmation', evidence.requested_tier_at_confirmation,
          'requested_tier_acknowledgement', evidence.requested_tier_acknowledgement
        )
        FROM app.project_classification_confirmations AS evidence
        WHERE evidence.project_id = $1::uuid
          AND evidence.id::text = current_project.project->'confirmation'->>'id'
        LIMIT 1
      )
    END AS confirmation_evidence,
    (
      SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'project_id', draft.project_id::text,
        'stage', draft.stage,
        'row_version', draft.row_version,
        'state', draft.state,
        'content_source', draft.content_source,
        'content', draft.content,
        'approved_by', draft.approved_by::text,
        'approved_at', CASE WHEN draft.approved_at IS NULL THEN NULL ELSE to_char(
          draft.approved_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
        ) END
      ) ORDER BY array_position(ARRAY[
        '點子', 'A/B', 'Specification', 'Checkpoint', 'Constitution',
        'UX/UI', 'Specification Sync', 'Technical Plan', 'Final Pack'
      ]::text[], draft.stage)), '[]'::jsonb)
      FROM app.stage_records AS draft
      WHERE draft.project_id = $1::uuid
        AND current_project.project IS NOT NULL
        AND current_project.actor_valid AND current_project.allowed
    ) AS drafts
  FROM current_project
`;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function sameRequirements(
  left: ProjectRequirements,
  right: ProjectRequirements,
): boolean {
  return left.description === right.description &&
    left.runtime_needs === right.runtime_needs &&
    left.runtime_ai_required === right.runtime_ai_required;
}

function parseConfirmationEvidence(
  value: unknown,
  project: Extract<CurrentProjectClassificationDto, { classification_state: "confirmed" }>,
): Extract<CreationFlowInput["classification"], { state: "confirmed" }>["confirmation"] | null {
  if (!isRecord(value) || !exactKeys(value, evidenceKeys)) return null;
  const parsedEvidence = confirmationEvidenceSchema.safeParse(value);
  if (!parsedEvidence.success) return null;
  const evidence = parsedEvidence.data;
  if (evidence.id !== project.confirmation.id ||
      evidence.project_id !== project.id ||
      evidence.requirements_revision !== project.requirements_revision ||
      evidence.requirements_revision !== project.confirmation.requirements_revision ||
      evidence.tier !== project.tier ||
      evidence.needs_visitor_identity !== project.needs_visitor_identity ||
      evidence.confirmed_by !== project.confirmation.confirmed_by ||
      evidence.confirmed_at !== project.confirmation.confirmed_at ||
      evidence.source !== project.confirmation.source ||
      evidence.requested_tier_at_confirmation !== project.confirmation.requested_tier_at_confirmation ||
      evidence.requested_tier_acknowledgement !== project.confirmation.requested_tier_acknowledgement ||
      project.requirements === null ||
      !sameRequirements(evidence.requirements_snapshot, project.requirements)) {
    return null;
  }
  return evidence;
}

function parseProject(
  value: unknown,
  projectId: string,
): CurrentProjectClassificationDto | null {
  if (!isRecord(value) || !exactKeys(value, projectKeys)) return null;
  if (value.confirmation !== null &&
      (!isRecord(value.confirmation) || !exactKeys(value.confirmation, confirmationKeys))) return null;
  const project = parseCurrentProjectClassificationDto(value);
  if (!project || project.id !== projectId) return null;
  if ((project.requirements === null) !== (project.requirements_revision === 0)) return null;
  return project;
}

function buildCreationFlowInput(
  project: CurrentProjectClassificationDto,
  requestedStage: CreationFlowInput["requested_stage"],
  confirmationValue: unknown,
  draftValues: unknown[],
): CreationFlowInput | null {
  let classification: CreationFlowInput["classification"];
  if (project.classification_state === "confirmed") {
    const confirmation = parseConfirmationEvidence(confirmationValue, project);
    if (!confirmation) return null;
    classification = {
      project_id: project.id,
      state: "confirmed",
      requested_tier: project.requested_tier,
      tier: project.tier,
      needs_visitor_identity: project.needs_visitor_identity,
      requirements_revision: project.requirements_revision,
      confirmation,
    };
  } else {
    if (confirmationValue !== null) return null;
    if (project.classification_state === "unconfirmed") {
      classification = {
        project_id: project.id,
        state: "unconfirmed",
        requested_tier: project.requested_tier,
        tier: null,
        needs_visitor_identity: null,
        requirements_revision: project.requirements_revision,
        confirmation: null,
      };
    } else {
      classification = {
        project_id: project.id,
        state: "legacy_unverified",
        requested_tier: null,
        tier: project.tier,
        needs_visitor_identity: project.needs_visitor_identity,
        requirements_revision: 0,
        confirmation: null,
      };
    }
  }

  if (draftValues.length > projectStageSchema.options.length) return null;
  const drafts: CreationFlowInput["stage_drafts"] = [];
  const seenStages = new Set<string>();
  for (const value of draftValues) {
    if (!isRecord(value) || !exactKeys(value, draftKeys)) return null;
    const parsed = stageDraftDtoSchema.safeParse(value);
    if (!parsed.success || parsed.data.project_id !== project.id || seenStages.has(parsed.data.stage)) return null;
    seenStages.add(parsed.data.stage);
    drafts.push(parsed.data);
  }

  const input = {
    project: { id: project.id, current_stage: project.stage },
    requested_stage: requestedStage,
    requirements: project.requirements === null ? null : {
      project_id: project.id,
      revision: project.requirements_revision,
      content: project.requirements,
    },
    classification,
    stage_drafts: drafts,
  };
  const parsed = creationFlowInputSchema.safeParse(input);
  return parsed.success ? parsed.data : null;
}

export async function readOwnedProjectCreationFlowAssessmentSubset(
  context: AuthorizationContext,
  input: unknown,
): Promise<OwnedProjectCreationFlowAssessmentResult> {
  const parsedInput = requestSchema.safeParse(input);
  if (!parsedInput.success) return { outcome: "failed", reason: "invalid_input" };
  const projectId = parsedInput.data.project_id.toLowerCase();

  try {
    return await context.runReadOnly(async (query): Promise<OwnedProjectCreationFlowAssessmentResult> => {
      const { rows } = await query.query(creationFlowReadSql, [projectId]);
      if (rows.length !== 1 || !isRecord(rows[0]) ||
          !exactKeys(rows[0], [
            "subject", "actor_valid", "allowed", "project", "confirmation_evidence", "drafts",
          ])) {
        return { outcome: "failed", reason: "invalid_result" };
      }
      const row = rows[0];
      if (typeof row.subject !== "string" || !uuid.test(row.subject) || row.actor_valid !== true) {
        return { outcome: "failed", reason: "invalid_context" };
      }
      if (typeof row.allowed !== "boolean" || !Array.isArray(row.drafts)) {
        return { outcome: "failed", reason: "invalid_result" };
      }
      if (!row.allowed) {
        return row.project === null && row.confirmation_evidence === null && row.drafts.length === 0
          ? { outcome: "denied", reason: "policy_denied" }
          : { outcome: "failed", reason: "invalid_result" };
      }
      if (row.project === null) {
        return row.confirmation_evidence === null && row.drafts.length === 0
          ? { outcome: "not_found" }
          : { outcome: "failed", reason: "invalid_result" };
      }

      const project = parseProject(row.project, projectId);
      if (!project) return { outcome: "failed", reason: "invalid_result" };
      const creationInput = buildCreationFlowInput(
        project,
        parsedInput.data.requested_stage,
        row.confirmation_evidence,
        row.drafts,
      );
      if (!creationInput) return { outcome: "failed", reason: "invalid_result" };

      const assessment = evaluateCreationFlow(creationInput);
      if (assessment.outcome !== "evaluated") return { outcome: "failed", reason: "invalid_result" };
      return {
        outcome: "evaluated",
        snapshot: "single_statement",
        project_id: project.id,
        row_version: project.row_version,
        requirements_revision: project.requirements_revision,
        assessment,
      };
    });
  } catch {
    return { outcome: "failed", reason: "dependency_failure" };
  }
}
