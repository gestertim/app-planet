import {
  readStageDraftInputSchema,
  stageConfirmationBodySchema,
  stageConfirmationReceiptSchema,
  stageConfirmationStatusSchema,
  stageDraftIdempotencyKeySchema,
  type StageConfirmationReceipt,
  type StageConfirmationStatus,
} from "@app-planet/core";
import { z } from "zod";
import type { AuthorizationContext } from "./authorization.ts";
import type { ProjectCreationContext } from "./projects.ts";
import { actorSql, record, validActor } from "./stage-drafts.ts";

type Failure = {
  outcome: "failed";
  reason: "invalid_input" | "invalid_context" | "invalid_result" | "dependency_failure";
};
type Denied = { outcome: "denied"; reason: "policy_denied" };
export type StageConfirmationReadResult =
  | { outcome: "found"; status: StageConfirmationStatus }
  | { outcome: "not_found" }
  | Denied | Failure;
export type StageConfirmResult =
  | {
    outcome: "confirmed" | "replayed" | "already_confirmed";
    confirmation: StageConfirmationReceipt;
    current: boolean;
  }
  | { outcome: "conflict"; reason: "idempotency_mismatch" }
  | { outcome: "conflict"; reason: "no_draft" }
  | { outcome: "conflict"; reason: "version_mismatch"; current_row_version: number }
  | { outcome: "not_found" }
  | Denied | Failure;

const confirmInputSchema = readStageDraftInputSchema.extend(stageConfirmationBodySchema.shape).strict();
class InvalidConfirmationResult extends Error {}

function receipt(value: unknown, projectId: string, stage: string): StageConfirmationReceipt | null {
  const raw = record(value) && value.confirmed_at instanceof Date
    ? { ...value, confirmed_at: value.confirmed_at.toISOString() }
    : value;
  const parsed = stageConfirmationReceiptSchema.safeParse(raw);
  if (!parsed.success || parsed.data.project_id.toLowerCase() !== projectId.toLowerCase() ||
      parsed.data.stage !== stage || Number.isNaN(Date.parse(parsed.data.confirmed_at))) return null;
  return Object.freeze({ ...parsed.data });
}

const hashSql = "encode(pg_catalog.sha256(pg_catalog.convert_to(d.content->>'text', 'UTF8')), 'hex')";
const receiptSql = `jsonb_build_object(
  'project_id', c.project_id, 'stage', c.stage, 'row_version', c.record_row_version,
  'content_hash', c.content_hash,
  'confirmed_at', to_char(c.confirmed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'))`;

export async function readOwnedStageConfirmationStatus(
  context: AuthorizationContext, input: unknown,
): Promise<StageConfirmationReadResult> {
  const parsed = readStageDraftInputSchema.safeParse(input);
  if (!parsed.success) return { outcome: "failed", reason: "invalid_input" };
  const { project_id: projectId, stage } = parsed.data;
  try {
    return await context.runReadOnly(async (query) => {
      const { rows } = await query.query(`
        SELECT ${actorSql(true)}, app.current_account_gate('read_saved_content') AS allowed,
          EXISTS (SELECT 1 FROM app.projects p WHERE p.id = $1::uuid AND p.owner_id = auth.uid()) AS owned,
          (SELECT d.row_version FROM app.stage_records d WHERE d.project_id = $1::uuid AND d.stage = $2) AS draft_version,
          (SELECT ${receiptSql} FROM app.stage_draft_confirmations c
            JOIN app.stage_records d ON d.project_id = c.project_id AND d.stage = c.stage
            WHERE c.project_id = $1::uuid AND c.stage = $2 AND c.confirmed_by = auth.uid()
              AND c.record_row_version = d.row_version AND c.content_hash = ${hashSql}) AS current_confirmation,
          (SELECT ${receiptSql} FROM app.stage_draft_confirmations c
            WHERE c.project_id = $1::uuid AND c.stage = $2 AND c.confirmed_by = auth.uid()
            ORDER BY c.record_row_version DESC LIMIT 1) AS latest_confirmation
      `, [projectId, stage]);
      if (rows.length !== 1 || !record(rows[0])) return { outcome: "failed", reason: "invalid_result" } as const;
      const row = rows[0];
      if (!validActor(row)) return { outcome: "failed", reason: "invalid_context" } as const;
      if (typeof row.allowed !== "boolean" || typeof row.owned !== "boolean") {
        return { outcome: "failed", reason: "invalid_result" } as const;
      }
      if (!row.allowed) return { outcome: "denied", reason: "policy_denied" } as const;
      if (!row.owned) return { outcome: "not_found" } as const;
      const draftVersion = row.draft_version === null ? null : row.draft_version;
      if (draftVersion !== null && !Number.isInteger(draftVersion)) {
        return { outcome: "failed", reason: "invalid_result" } as const;
      }
      const current = row.current_confirmation === null ? null : receipt(row.current_confirmation, projectId, stage);
      const latest = row.latest_confirmation === null ? null : receipt(row.latest_confirmation, projectId, stage);
      if ((row.current_confirmation !== null && !current) || (row.latest_confirmation !== null && !latest) ||
          (current && (draftVersion === null || current.row_version !== draftVersion))) {
        return { outcome: "failed", reason: "invalid_result" } as const;
      }
      const state = draftVersion === null ? "no_draft"
        : current ? "confirmed_current"
        : latest ? "confirmation_stale" : "unconfirmed";
      const status = stageConfirmationStatusSchema.safeParse({
        project_id: projectId, stage, state, draft_row_version: draftVersion,
        latest_confirmation: current ?? latest,
        approval: stage === "Specification" ? "separate_specification_review" : "manual_approval_unavailable",
      });
      return status.success
        ? { outcome: "found", status: status.data } as const
        : { outcome: "failed", reason: "invalid_result" } as const;
    });
  } catch {
    return { outcome: "failed", reason: "dependency_failure" };
  }
}

export async function confirmOwnedStageDraft(
  context: ProjectCreationContext, input: unknown, idempotencyKey: unknown,
): Promise<StageConfirmResult> {
  const parsed = confirmInputSchema.safeParse(input);
  const key = stageDraftIdempotencyKeySchema.safeParse(idempotencyKey);
  if (!parsed.success || !key.success) return { outcome: "failed", reason: "invalid_input" };
  const value = parsed.data;
  try {
    return await context.runTransaction<StageConfirmResult>(async (query) => {
      const { rows } = await query.query(`
        WITH access AS MATERIALIZED (SELECT ${actorSql(false)})
        SELECT access.*, CASE WHEN access.actor_valid AND access.subject IS NOT NULL THEN
          app.confirm_stage_draft($1::uuid,$2::text,$3::integer,$4::uuid)
          ELSE jsonb_build_object('outcome','invalid_context') END AS result
        FROM access
      `, [value.project_id, value.stage, value.expected_row_version, key.data]);
      if (rows.length !== 1 || !record(rows[0]) || !validActor(rows[0]) ||
          !record(rows[0].result)) throw new InvalidConfirmationResult();
      const result = rows[0].result;
      switch (result.outcome) {
        case "confirmed":
        case "replayed":
        case "already_confirmed": {
          const confirmation = receipt(result.confirmation, value.project_id, value.stage);
          if (!confirmation || confirmation.row_version !== value.expected_row_version) {
            throw new InvalidConfirmationResult();
          }
          const current = result.outcome === "replayed" ? result.current === true : true;
          if (result.outcome === "replayed" && typeof result.current !== "boolean") {
            throw new InvalidConfirmationResult();
          }
          return { outcome: result.outcome, confirmation, current };
        }
        case "version_mismatch": {
          const current = z.number().int().min(0).safeParse(result.current_row_version);
          if (!current.success || current.data === value.expected_row_version) {
            throw new InvalidConfirmationResult();
          }
          return { outcome: "conflict", reason: "version_mismatch", current_row_version: current.data };
        }
        case "no_draft": return { outcome: "conflict", reason: "no_draft" };
        case "idempotency_conflict": return { outcome: "conflict", reason: "idempotency_mismatch" };
        case "denied": return { outcome: "denied", reason: "policy_denied" };
        case "not_found": return { outcome: "not_found" };
        case "invalid_input": return { outcome: "failed", reason: "invalid_input" };
        default: throw new InvalidConfirmationResult();
      }
    });
  } catch (error) {
    return {
      outcome: "failed",
      reason: error instanceof InvalidConfirmationResult ? "invalid_result" : "dependency_failure",
    };
  }
}
