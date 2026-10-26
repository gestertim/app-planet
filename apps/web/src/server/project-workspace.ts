import { projectStageSchema, stageDraftDtoSchema, type ProjectRequirements, type StageDraftDto } from "@app-planet/core";
import type { AuthorizationContext } from "./authorization.ts";
import {
  parseCurrentProjectClassificationDto, projectClassificationReadSql,
  type CurrentProjectClassificationDto,
} from "./project-classification.ts";

type WorkspaceClassification =
  | { state: "unconfirmed"; requested_tier: "A" | "B" | null; tier: null; needs_visitor_identity: null }
  | { state: "confirmed"; requested_tier: "A" | "B" | null; tier: "A" | "B"; needs_visitor_identity: boolean }
  | { state: "legacy_unverified"; requested_tier: null; tier: "A" | "B"; needs_visitor_identity: boolean };

export interface OwnedProjectWorkspaceDto {
  project: Pick<CurrentProjectClassificationDto, "id" | "title" | "stage" | "created_at" | "row_version">;
  requirements: { revision: number; content: ProjectRequirements } | null;
  classification: WorkspaceClassification;
  drafts: Pick<StageDraftDto, "stage" | "row_version" | "state" | "content_source" | "content">[];
}
export type OwnedProjectWorkspaceReadResult =
  | { outcome: "found"; workspace: OwnedProjectWorkspaceDto }
  | { outcome: "not_found" }
  | { outcome: "denied"; reason: "policy_denied" }
  | { outcome: "failed"; reason: "invalid_input" | "invalid_context" | "invalid_result" | "dependency_failure" };

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// 內嵌既有完整確認投影；gate、證據與草稿共用同一 statement snapshot。
const workspaceSql = `
  WITH current_workspace_project AS MATERIALIZED (${projectClassificationReadSql(false)})
  SELECT current_workspace_project.subject, current_workspace_project.actor_valid,
    current_workspace_project.allowed, current_workspace_project.project,
    (SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'project_id', d.project_id, 'stage', d.stage, 'row_version', d.row_version,
      'state', d.state, 'content_source', d.content_source, 'content', d.content,
      'approved_by', d.approved_by, 'approved_at', d.approved_at
    )), '[]'::jsonb)
    FROM app.stage_records d
    WHERE d.project_id = $1::uuid AND current_workspace_project.project IS NOT NULL
      AND current_workspace_project.actor_valid AND current_workspace_project.allowed
    ) AS drafts
  FROM current_workspace_project
`;
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}
function classificationDto(project: CurrentProjectClassificationDto): WorkspaceClassification {
  if (project.classification_state === "unconfirmed") return {
    state: "unconfirmed", requested_tier: project.requested_tier, tier: null, needs_visitor_identity: null,
  };
  if (project.classification_state === "legacy_unverified") return {
    state: "legacy_unverified", requested_tier: null, tier: project.tier,
    needs_visitor_identity: project.needs_visitor_identity,
  };
  return {
    state: "confirmed", requested_tier: project.requested_tier, tier: project.tier,
    needs_visitor_identity: project.needs_visitor_identity,
  };
}
function parseWorkspace(projectValue: unknown, draftValues: unknown[], id: string): OwnedProjectWorkspaceDto | null {
  if (!record(projectValue) || !exactKeys(projectValue, [
    "id", "title", "stage", "created_at", "row_version", "classification_state", "requested_tier", "tier",
    "needs_visitor_identity", "requirements_revision", "requirements", "confirmation",
  ])) return null;
  if (projectValue.confirmation !== null && (!record(projectValue.confirmation) || !exactKeys(projectValue.confirmation, [
    "id", "requirements_revision", "confirmed_by", "confirmed_at", "source", "requested_tier_at_confirmation",
    "requested_tier_acknowledgement", "requirements_match",
  ]))) return null;
  const project = parseCurrentProjectClassificationDto(projectValue);
  if (!project || project.id !== id || draftValues.length > projectStageSchema.options.length) return null;
  const drafts: OwnedProjectWorkspaceDto["drafts"] = [];
  const stages = new Set<string>();
  for (const value of draftValues) {
    const parsed = stageDraftDtoSchema.safeParse(value);
    if (!parsed.success || parsed.data.project_id !== id || stages.has(parsed.data.stage)) return null;
    const draft = parsed.data;
    stages.add(draft.stage);
    drafts.push({
      stage: draft.stage, row_version: draft.row_version, state: draft.state,
      content_source: draft.content_source, content: { text: draft.content.text },
    });
  }
  drafts.sort((a, b) => projectStageSchema.options.indexOf(a.stage) - projectStageSchema.options.indexOf(b.stage));
  return {
    project: {
      id: project.id, title: project.title, stage: project.stage,
      created_at: project.created_at, row_version: project.row_version,
    },
    requirements: project.requirements === null ? null : {
      revision: project.requirements_revision,
      content: {
        description: project.requirements.description, runtime_needs: project.requirements.runtime_needs,
        runtime_ai_required: project.requirements.runtime_ai_required,
      },
    },
    classification: classificationDto(project),
    drafts,
  };
}

export async function readOwnedProjectWorkspaceSubset(
  context: AuthorizationContext, projectId: unknown,
): Promise<OwnedProjectWorkspaceReadResult> {
  if (typeof projectId !== "string" || !uuid.test(projectId)) return { outcome: "failed", reason: "invalid_input" };
  const id = projectId.toLowerCase();
  try {
    return await context.runReadOnly(async (query): Promise<OwnedProjectWorkspaceReadResult> => {
      const { rows } = await query.query(workspaceSql, [id]);
      if (rows.length !== 1 || !record(rows[0])) return { outcome: "failed", reason: "invalid_result" };
      const row = rows[0];
      if (typeof row.subject !== "string" || !uuid.test(row.subject) || row.actor_valid !== true) {
        return { outcome: "failed", reason: "invalid_context" };
      }
      if (!exactKeys(row, ["subject", "actor_valid", "allowed", "project", "drafts"]) ||
        typeof row.allowed !== "boolean" || !Array.isArray(row.drafts)) return { outcome: "failed", reason: "invalid_result" };
      if (!row.allowed) return row.project === null && row.drafts.length === 0
        ? { outcome: "denied", reason: "policy_denied" }
        : { outcome: "failed", reason: "invalid_result" };
      if (row.project === null) return row.drafts.length === 0
        ? { outcome: "not_found" }
        : { outcome: "failed", reason: "invalid_result" };
      const workspace = parseWorkspace(row.project, row.drafts, id);
      return workspace ? { outcome: "found", workspace } : { outcome: "failed", reason: "invalid_result" };
    });
  } catch {
    return { outcome: "failed", reason: "dependency_failure" };
  }
}
