import {
  projectRenameCurrentSchema,
  projectRenameResponseSchema,
  type ProjectRenameCurrent,
  type ProjectRenameResponse,
} from "@app-planet/core";
import type { ProjectCreationContext, ProjectCreationQuery } from "./projects.ts";

export type ProjectRenameInput = {
  readonly project_id: string;
  readonly title: string;
  readonly expected_row_version: number;
  readonly idempotency_key: string;
  readonly replay_only: boolean;
};

export type ProjectRenameConflict = {
  readonly current: { readonly version: number; readonly content: { readonly title: string } };
  readonly submitted: { readonly version: number; readonly content: { readonly title: string } };
};

export type ProjectRenameResult =
  | { readonly outcome: "saved" | "replayed"; readonly operation: ProjectRenameCurrent; readonly current: ProjectRenameCurrent }
  | { readonly outcome: "version_conflict"; readonly conflict: ProjectRenameConflict }
  | { readonly outcome: "denied" }
  | { readonly outcome: "not_found" }
  | { readonly outcome: "idempotency_conflict" }
  | { readonly outcome: "unrecoverable" }
  | { readonly outcome: "failed"; readonly reason: "invalid_input" | "invalid_context" | "dependency_failure" | "invalid_result" };

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validInput(value: unknown): value is ProjectRenameInput {
  return isRecord(value) &&
    typeof value.project_id === "string" && uuid.test(value.project_id) &&
    typeof value.title === "string" &&
    typeof value.expected_row_version === "number" && Number.isInteger(value.expected_row_version) &&
    value.expected_row_version >= 0 && value.expected_row_version <= 2147483647 &&
    typeof value.idempotency_key === "string" && uuid.test(value.idempotency_key) &&
    typeof value.replay_only === "boolean";
}

function parseConflict(value: unknown, input: ProjectRenameInput): ProjectRenameConflict | null {
  if (!isRecord(value) || !isRecord(value.current) || !isRecord(value.submitted)) return null;
  const { current, submitted } = value;
  if (!isRecord(current.content) || !isRecord(submitted.content)) return null;
  const currentContent = current.content;
  const submittedContent = submitted.content;
  if (typeof current.version !== "number" || !Number.isInteger(current.version) ||
      current.version < 0 || current.version > 2147483647 ||
      (current.version === input.expected_row_version && current.version !== 2147483647) ||
      typeof currentContent.title !== "string" ||
      submitted.version !== input.expected_row_version ||
      submittedContent.title !== input.title) return null;
  return {
    current: { version: current.version, content: { title: currentContent.title } },
    submitted: { version: input.expected_row_version, content: { title: input.title } },
  };
}

function parseResult(value: unknown, input: ProjectRenameInput): ProjectRenameResult | null {
  if (!isRecord(value) || typeof value.outcome !== "string") return null;
  switch (value.outcome) {
    case "denied": return { outcome: "denied" };
    case "not_found": return { outcome: "not_found" };
    case "idempotency_conflict": return { outcome: "idempotency_conflict" };
    case "unrecoverable": return { outcome: "unrecoverable" };
    case "version_conflict": {
      const conflict = parseConflict(value.conflict, input);
      return conflict ? { outcome: "version_conflict", conflict } : null;
    }
    case "saved":
    case "replayed": {
      const response = projectRenameResponseSchema.safeParse({
        outcome: value.outcome,
        operation: value.operation,
        current: value.current,
      });
      if (!response.success ||
          response.data.operation.id.toLowerCase() !== input.project_id.toLowerCase() ||
          response.data.operation.title !== input.title ||
          response.data.operation.row_version !== input.expected_row_version + 1 ||
          response.data.current.id.toLowerCase() !== input.project_id.toLowerCase() ||
          response.data.current.row_version < response.data.operation.row_version ||
          (value.outcome === "saved" &&
            (response.data.current.title !== response.data.operation.title ||
              response.data.current.row_version !== response.data.operation.row_version))) {
        return null;
      }
      return response.data;
    }
    default: return null;
  }
}

const renameSql = `
  WITH actor AS MATERIALIZED (
    SELECT auth.uid()::text AS subject,
      (current_user = 'authenticated'
        AND current_setting('transaction_read_only') = 'off'
        AND NOT EXISTS (
          SELECT 1 FROM pg_catalog.pg_roles
          WHERE rolname IN (current_user, session_user) AND (rolsuper OR rolbypassrls)
        )
        AND NOT EXISTS (
          SELECT 1 FROM pg_catalog.pg_class AS relation
          JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
          JOIN pg_catalog.pg_roles AS owner_role ON owner_role.oid = relation.relowner
          WHERE namespace.nspname = 'app' AND owner_role.rolname IN (current_user, session_user)
        )
      ) AS actor_valid
  )
  SELECT actor.subject, actor.actor_valid,
    CASE WHEN actor.actor_valid AND actor.subject IS NOT NULL
      THEN app.patch_project_title($1::uuid, $2::text, $3::integer, $4::uuid, $5::boolean)
      ELSE pg_catalog.jsonb_build_object('outcome', 'invalid_context')
    END AS result
  FROM actor
`;

export async function patchOwnedProjectTitle(
  context: ProjectCreationContext,
  input: unknown,
): Promise<ProjectRenameResult> {
  if (!validInput(input)) return { outcome: "failed", reason: "invalid_input" };
  try {
    return await context.runTransaction(async (query: ProjectCreationQuery) => {
      const { rows } = await query.query(renameSql, [
        input.project_id, input.title, input.expected_row_version, input.idempotency_key, input.replay_only,
      ]);
      if (rows.length !== 1 || !isRecord(rows[0]) ||
          typeof rows[0].subject !== "string" || !uuid.test(rows[0].subject) ||
          rows[0].actor_valid !== true) {
        return { outcome: "failed", reason: "invalid_context" };
      }
      const result = parseResult(rows[0].result, input);
      return result ?? { outcome: "failed", reason: "invalid_result" };
    });
  } catch {
    return { outcome: "failed", reason: "dependency_failure" };
  }
}

export function projectRenamePublicResult(value: ProjectRenameResult): ProjectRenameResponse | null {
  if (value.outcome !== "saved" && value.outcome !== "replayed") return null;
  const parsed = projectRenameResponseSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
