import {
  readStageDraftInputSchema,
  saveStageDraftInputSchema,
  stageDraftContentSchema,
  stageDraftDtoSchema,
  stageDraftIdempotencyKeySchema,
  type SaveStageDraftInput,
  type StageDraftDto,
} from "@app-planet/core";
import type { AuthorizationContext } from "./authorization.ts";
import type { ProjectCreationContext, ProjectCreationQuery } from "./projects.ts";

type DraftFailure = {
  outcome: "failed";
  reason: "invalid_input" | "invalid_context" | "invalid_result" | "dependency_failure" | "version_exhausted";
};
type DraftDenied = { outcome: "denied"; reason: "policy_denied" };
export type StageDraftReadResult =
  | { outcome: "found"; draft: StageDraftDto }
  | { outcome: "not_found" }
  | DraftDenied | DraftFailure;
type Content = StageDraftDto["content"];
type DraftConflict = {
  current: { version: number | null; content: Content | null };
  submitted: { version: number | null; content: Content };
};
export type StageDraftSaveResult =
  | { outcome: "saved"; operation: StageDraftDto }
  | { outcome: "replayed"; operation: StageDraftDto; current_draft: StageDraftReadResult }
  | { outcome: "conflict"; reason: "version_conflict"; conflict: DraftConflict }
  | { outcome: "conflict"; reason: "idempotency_mismatch" }
  | { outcome: "conflict"; reason: "draft_already_exists" }
  | { outcome: "not_found" }
  | DraftDenied | DraftFailure;

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
class InvalidDraftResult extends Error {}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function actorSql(readOnly: boolean): string {
  return `auth.uid()::text AS subject,
    (current_user = 'authenticated'
      AND current_setting('transaction_read_only') = '${readOnly ? "on" : "off"}'
      AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles
        WHERE rolname IN (current_user, session_user) AND (rolsuper OR rolbypassrls))
      AND NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_class r
        JOIN pg_catalog.pg_namespace n ON n.oid = r.relnamespace
        JOIN pg_catalog.pg_roles a ON a.oid = r.relowner
        WHERE n.nspname = 'app' AND a.rolname IN (current_user, session_user)
      )
    ) AS actor_valid`;
}
function validActor(row: Record<string, unknown>): boolean {
  return typeof row.subject === "string" && uuid.test(row.subject) && row.actor_valid === true;
}
function dto(value: unknown, projectId: string, stage: string): StageDraftDto | null {
  const parsed = stageDraftDtoSchema.safeParse(value);
  if (!parsed.success || parsed.data.project_id.toLowerCase() !== projectId.toLowerCase() ||
      parsed.data.stage !== stage) return null;
  const draft = parsed.data;
  return Object.freeze({
    project_id: draft.project_id, stage: draft.stage, row_version: draft.row_version,
    state: draft.state, content_source: draft.content_source,
    content: Object.freeze({ text: draft.content.text }),
    approved_by: null, approved_at: null,
  });
}
async function readWithQuery(
  query: ProjectCreationQuery, projectId: string, stage: string, readOnly: boolean,
): Promise<StageDraftReadResult> {
  const { rows } = await query.query(`
    SELECT ${actorSql(readOnly)}, app.current_account_gate('read_saved_content') AS allowed,
      (SELECT jsonb_build_object(
        'project_id', d.project_id, 'stage', d.stage, 'row_version', d.row_version,
        'state', d.state, 'content_source', d.content_source, 'content', d.content,
        'approved_by', d.approved_by, 'approved_at', d.approved_at
      ) FROM app.stage_records d
      JOIN app.projects p ON p.id = d.project_id
      WHERE d.project_id = $1::uuid AND d.stage = $2 AND p.owner_id = auth.uid()) AS draft
  `, [projectId, stage]);
  if (rows.length !== 1 || !record(rows[0])) return { outcome: "failed", reason: "invalid_result" };
  const row = rows[0];
  if (!validActor(row)) return { outcome: "failed", reason: "invalid_context" };
  if (typeof row.allowed !== "boolean") return { outcome: "failed", reason: "invalid_result" };
  if (!row.allowed) return { outcome: "denied", reason: "policy_denied" };
  if (row.draft === null) return { outcome: "not_found" };
  const draft = dto(row.draft, projectId, stage);
  return draft ? { outcome: "found", draft } : { outcome: "failed", reason: "invalid_result" };
}

export async function readOwnedStageDraftSubset(
  context: AuthorizationContext, input: unknown,
): Promise<StageDraftReadResult> {
  const parsed = readStageDraftInputSchema.safeParse(input);
  if (!parsed.success) return { outcome: "failed", reason: "invalid_input" };
  try {
    return await context.runReadOnly((query) =>
      readWithQuery(query, parsed.data.project_id, parsed.data.stage, true));
  } catch {
    return { outcome: "failed", reason: "dependency_failure" };
  }
}

function parseConflict(value: unknown, input: SaveStageDraftInput): DraftConflict | null {
  if (!record(value) || !record(value.current) || !record(value.submitted)) return null;
  const { current, submitted } = value;
  const content = stageDraftContentSchema.safeParse(submitted.content);
  if (!content.success || submitted.version !== input.expected_row_version ||
      content.data.text !== input.content.text) return null;
  if (current.version === null && current.content === null) {
    if (input.expected_row_version === null) return null;
    return {
      current: { version: null, content: null },
      submitted: { version: input.expected_row_version, content: { text: input.content.text } },
    };
  }
  const currentContent = stageDraftContentSchema.safeParse(current.content);
  if (typeof current.version !== "number" || !Number.isInteger(current.version) ||
      current.version < 0 || current.version > 2147483647 || !currentContent.success ||
      current.version === input.expected_row_version) return null;
  return {
    current: { version: current.version, content: { text: currentContent.data.text } },
    submitted: { version: input.expected_row_version, content: { text: input.content.text } },
  };
}

export async function saveOwnedStageDraftSubset(
  context: ProjectCreationContext, input: unknown, idempotencyKey: unknown,
): Promise<StageDraftSaveResult> {
  const parsed = saveStageDraftInputSchema.safeParse(input);
  const key = stageDraftIdempotencyKeySchema.safeParse(idempotencyKey);
  if (!parsed.success || !key.success) return { outcome: "failed", reason: "invalid_input" };
  const value = parsed.data;
  try {
    return await context.runTransaction<StageDraftSaveResult>(async (query) => {
      const { rows } = await query.query(`
        WITH access AS MATERIALIZED (SELECT ${actorSql(false)})
        SELECT access.*, CASE WHEN access.actor_valid AND access.subject IS NOT NULL THEN
          app.save_stage_draft($1::uuid,$2::text,$3::integer,$4::text,$5::uuid)
          ELSE jsonb_build_object('outcome','invalid_context') END AS result
        FROM access
      `, [value.project_id, value.stage, value.expected_row_version, value.content.text, key.data]);
      if (rows.length !== 1 || !record(rows[0]) || !validActor(rows[0]) ||
          !record(rows[0].result)) throw new InvalidDraftResult();
      const result = rows[0].result;
      switch (result.outcome) {
        case "saved":
        case "replayed": {
          const operation = dto(result.operation, value.project_id, value.stage);
          if (!operation || operation.content.text !== value.content.text ||
              operation.row_version !== (value.expected_row_version === null ? 0 : value.expected_row_version + 1)) {
            throw new InvalidDraftResult();
          }
          if (result.outcome === "saved") return { outcome: "saved", operation };
          const current = await readWithQuery(query, value.project_id, value.stage, false);
          if (current.outcome === "failed") throw new InvalidDraftResult();
          return { outcome: "replayed", operation, current_draft: current };
        }
        case "version_conflict": {
          const conflict = parseConflict(result.conflict, value);
          if (!conflict) throw new InvalidDraftResult();
          return { outcome: "conflict", reason: "version_conflict", conflict };
        }
        case "denied": return { outcome: "denied", reason: "policy_denied" };
        case "not_found": return { outcome: "not_found" };
        case "idempotency_conflict": return { outcome: "conflict", reason: "idempotency_mismatch" };
        case "version_exhausted": return { outcome: "failed", reason: "version_exhausted" };
        case "invalid_input": return { outcome: "failed", reason: "invalid_input" };
        default: throw new InvalidDraftResult();
      }
    });
  } catch (error) {
    return {
      outcome: "failed",
      reason: error instanceof InvalidDraftResult ? "invalid_result" : "dependency_failure",
    };
  }
}
