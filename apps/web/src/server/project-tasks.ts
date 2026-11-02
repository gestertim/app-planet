import {
  patchProjectTaskDoneInputSchema,
  projectTaskConflictSchema,
  projectTaskDtoSchema,
  projectTaskImportInputSchema,
  projectTaskImportResultSchema,
  readProjectTaskInputSchema,
  readProjectTasksInputSchema,
  type PatchProjectTaskDoneInput,
  type ProjectTaskDto,
  type ProjectTaskImportInput,
} from "@app-planet/core";
import type { AuthorizationContext } from "./authorization.ts";
import type { ProjectCreationContext, ProjectCreationQuery } from "./projects.ts";

type TaskFailure = {
  outcome: "failed";
  reason: "invalid_input" | "invalid_context" | "invalid_result" | "dependency_failure" | "version_exhausted";
};
type TaskDenied = { outcome: "denied"; reason: "policy_denied" };
export type ProjectTasksReadResult =
  | { outcome: "listed"; tasks: ProjectTaskDto[] }
  | { outcome: "not_found" }
  | TaskDenied | TaskFailure;
export type ProjectTaskReadResult =
  | { outcome: "found"; task: ProjectTaskDto }
  | { outcome: "not_found" }
  | TaskDenied | TaskFailure;
export type ProjectTaskDonePatchResult =
  | { outcome: "saved"; task: ProjectTaskDto }
  | { outcome: "conflict"; conflict: { current: { version: number; content: { done: boolean } }; submitted: { version: number; content: { done: boolean } } } }
  | { outcome: "not_found" }
  | TaskDenied | TaskFailure;

export type ProjectTaskImportResult =
  | { outcome: "created" | "replayed"; tasks: ProjectTaskDto[] }
  | { outcome: "conflict"; reason: "tasks_already_exist" | "idempotency_key_reuse" }
  | { outcome: "not_found" }
  | TaskDenied | TaskFailure;

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function actorSql(readOnly: boolean): string {
  return `auth.uid()::text AS subject,
    (current_user = 'authenticated'
      AND current_setting('transaction_read_only') = '${readOnly ? "on" : "off"}'
      AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles
        WHERE rolname IN (current_user, session_user) AND (rolsuper OR rolbypassrls))
      AND NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_class relation
        JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace
        JOIN pg_catalog.pg_roles actor ON actor.oid = relation.relowner
        WHERE namespace.nspname = 'app' AND actor.rolname IN (current_user, session_user)
      )
    ) AS actor_valid`;
}

function validActor(row: Record<string, unknown>, readOnly: boolean): boolean {
  return typeof row.subject === "string" && uuid.test(row.subject) &&
    row.actor_valid === true && row.transaction_read_only === readOnly;
}

function taskQuery(single: boolean): string {
  return `
    WITH access AS MATERIALIZED (
      SELECT ${actorSql(true)}, current_setting('transaction_read_only') = 'on' AS transaction_read_only,
        app.current_account_gate('read_saved_content') AS allowed
    ),
    owned_project AS MATERIALIZED (
      SELECT project.id
      FROM app.projects AS project
      CROSS JOIN access
      WHERE project.id = $1::uuid
        AND project.owner_id = auth.uid()
        AND access.allowed
    ),
    task_rows AS (
      SELECT coalesce(jsonb_agg(jsonb_build_object(
        'id', task.id,
        'project_id', task.project_id,
        'order', task."order",
        'title', task.title,
        'done', task.done,
        'row_version', task.row_version
      ) ORDER BY task."order", task.id), '[]'::jsonb) AS tasks
      FROM app.tasks AS task
      JOIN owned_project AS project ON project.id = task.project_id
      WHERE NOT $2::boolean OR task.id = $3::uuid
    )
    SELECT access.*, EXISTS (SELECT 1 FROM owned_project) AS project_exists,
      CASE WHEN EXISTS (SELECT 1 FROM owned_project) THEN task_rows.tasks ELSE NULL END AS tasks
    FROM access CROSS JOIN task_rows
  `;
}

async function readTaskRows(
  query: ProjectCreationQuery,
  projectId: string,
  taskId: string | null,
): Promise<ProjectTasksReadResult> {
  const { rows } = await query.query(taskQuery(taskId !== null), [projectId, taskId !== null, taskId]);
  if (rows.length !== 1 || !isRecord(rows[0])) return { outcome: "failed", reason: "invalid_result" };
  const row = rows[0];
  if (!validActor(row, true)) return { outcome: "failed", reason: "invalid_context" };
  if (typeof row.allowed !== "boolean" || typeof row.project_exists !== "boolean") {
    return { outcome: "failed", reason: "invalid_result" };
  }
  if (!row.allowed) return { outcome: "denied", reason: "policy_denied" };
  if (!row.project_exists) return { outcome: "not_found" };
  if (!Array.isArray(row.tasks)) return { outcome: "failed", reason: "invalid_result" };

  const tasks: ProjectTaskDto[] = [];
  const ids = new Set<string>();
  for (const value of row.tasks) {
    const parsed = projectTaskDtoSchema.safeParse(value);
    if (!parsed.success || parsed.data.project_id.toLowerCase() !== projectId.toLowerCase() ||
        (taskId !== null && parsed.data.id.toLowerCase() !== taskId.toLowerCase()) ||
        ids.has(parsed.data.id.toLowerCase())) {
      return { outcome: "failed", reason: "invalid_result" };
    }
    ids.add(parsed.data.id.toLowerCase());
    tasks.push(parsed.data);
  }
  return { outcome: "listed", tasks };
}

export async function listOwnedProjectTasksSubset(
  context: AuthorizationContext,
  input: unknown,
): Promise<ProjectTasksReadResult> {
  const parsed = readProjectTasksInputSchema.safeParse(input);
  if (!parsed.success) return { outcome: "failed", reason: "invalid_input" };
  try {
    return await context.runReadOnly((query) => readTaskRows(query, parsed.data.project_id, null));
  } catch {
    return { outcome: "failed", reason: "dependency_failure" };
  }
}

export async function readOwnedProjectTaskSubset(
  context: AuthorizationContext,
  input: unknown,
): Promise<ProjectTaskReadResult> {
  const parsed = readProjectTaskInputSchema.safeParse(input);
  if (!parsed.success) return { outcome: "failed", reason: "invalid_input" };
  try {
    const result = await context.runReadOnly((query) =>
      readTaskRows(query, parsed.data.project_id, parsed.data.task_id));
    if (result.outcome !== "listed") return result;
    return result.tasks.length === 1
      ? { outcome: "found", task: result.tasks[0] }
      : { outcome: "not_found" };
  } catch {
    return { outcome: "failed", reason: "dependency_failure" };
  }
}

function parsePatchResult(
  value: unknown,
  input: PatchProjectTaskDoneInput,
): ProjectTaskDonePatchResult | null {
  if (!isRecord(value) || typeof value.outcome !== "string") return null;
  if (value.outcome === "denied") return { outcome: "denied", reason: "policy_denied" };
  if (value.outcome === "not_found") return { outcome: "not_found" };
  if (value.outcome === "invalid_input") return { outcome: "failed", reason: "invalid_input" };
  if (value.outcome === "invalid_context") return { outcome: "failed", reason: "invalid_context" };
  if (value.outcome === "version_exhausted") return { outcome: "failed", reason: "version_exhausted" };
  if (value.outcome === "version_conflict") {
    const parsed = projectTaskConflictSchema.safeParse(value.conflict);
    if (!parsed.success ||
        parsed.data.current.version === input.expected_row_version ||
        parsed.data.submitted.version !== input.expected_row_version ||
        parsed.data.submitted.content.done !== input.done) {
      return null;
    }
    return { outcome: "conflict", conflict: parsed.data };
  }
  if (value.outcome !== "saved") return null;
  const task = projectTaskDtoSchema.safeParse(value.task);
  if (!task.success ||
      task.data.id.toLowerCase() !== input.task_id.toLowerCase() ||
      task.data.project_id.toLowerCase() !== input.project_id.toLowerCase() ||
      task.data.done !== input.done ||
      task.data.row_version !== input.expected_row_version + 1) {
    return null;
  }
  return { outcome: "saved", task: task.data };
}

const importSql = `
  WITH actor AS MATERIALIZED (
    SELECT ${actorSql(false)}, current_setting('transaction_read_only') = 'on' AS transaction_read_only
  )
  SELECT actor.subject, actor.actor_valid, actor.transaction_read_only,
    CASE WHEN actor.actor_valid AND actor.subject IS NOT NULL
      THEN app.import_owned_project_tasks($1::uuid, $2::uuid, $3::jsonb)
      ELSE jsonb_build_object('outcome', 'invalid_context')
    END AS result
  FROM actor
`;

function parseImportResult(value: unknown, input: ProjectTaskImportInput): ProjectTaskImportResult | null {
  if (!isRecord(value) || typeof value.outcome !== "string") return null;
  switch (value.outcome) {
    case "denied": return { outcome: "denied", reason: "policy_denied" };
    case "not_found": return { outcome: "not_found" };
    case "invalid_input": return { outcome: "failed", reason: "invalid_input" };
    case "invalid_context": return { outcome: "failed", reason: "invalid_context" };
    case "tasks_exist": return { outcome: "conflict", reason: "tasks_already_exist" };
    case "key_reuse": return { outcome: "conflict", reason: "idempotency_key_reuse" };
    case "created":
    case "replayed": {
      const parsed = projectTaskImportResultSchema.safeParse(value);
      if (!parsed.success || parsed.data.tasks.length !== input.titles.length) return null;
      const seen = new Set<string>();
      for (const [index, task] of parsed.data.tasks.entries()) {
        const id = task.id.toLowerCase();
        if (seen.has(id) || task.project_id.toLowerCase() !== input.project_id.toLowerCase() ||
            task.order !== index + 1 || task.title !== input.titles[index]) return null;
        // 只驗證請求順序／標題；replay 後 done／版本可能已由 P-4 變更。
        if (parsed.data.outcome === "created" && (task.done || task.row_version !== 0)) return null;
        seen.add(id);
      }
      return { outcome: parsed.data.outcome, tasks: parsed.data.tasks };
    }
    default: return null;
  }
}

export async function importOwnedProjectTasksSubset(
  context: ProjectCreationContext,
  input: unknown,
): Promise<ProjectTaskImportResult> {
  const parsed = projectTaskImportInputSchema.safeParse(input);
  if (!parsed.success) return { outcome: "failed", reason: "invalid_input" };
  const value = parsed.data;
  try {
    return await context.runTransaction(async (query: ProjectCreationQuery) => {
      const { rows } = await query.query(importSql, [
        value.project_id, value.idempotency_key, JSON.stringify(value.titles),
      ]);
      if (rows.length !== 1 || !isRecord(rows[0])) {
        throw new Error("task_import_invalid_result");
      }
      if (!validActor(rows[0], false)) throw new Error("task_import_invalid_context");
      if (!isRecord(rows[0].result)) throw new Error("task_import_invalid_result");
      const result = parseImportResult(rows[0].result, value);
      // 內部結果無法驗證時拋出以回滾，不留下半份或不可信的清單。
      if (result === null) throw new Error("task_import_invalid_result");
      return result;
    });
  } catch {
    return { outcome: "failed", reason: "dependency_failure" };
  }
}

const patchSql = `
  WITH actor AS MATERIALIZED (
    SELECT ${actorSql(false)}, current_setting('transaction_read_only') = 'on' AS transaction_read_only
  )
  SELECT actor.subject, actor.actor_valid, actor.transaction_read_only,
    CASE WHEN actor.actor_valid AND actor.subject IS NOT NULL
      THEN app.patch_owned_project_task_done($1::uuid, $2::uuid, $3::integer, $4::boolean)
      ELSE jsonb_build_object('outcome', 'invalid_context')
    END AS result
  FROM actor
`;

export async function patchOwnedProjectTaskDoneSubset(
  context: ProjectCreationContext,
  input: unknown,
): Promise<ProjectTaskDonePatchResult> {
  const parsed = patchProjectTaskDoneInputSchema.safeParse(input);
  if (!parsed.success) return { outcome: "failed", reason: "invalid_input" };
  const value = parsed.data;
  try {
    return await context.runTransaction(async (query: ProjectCreationQuery) => {
      const { rows } = await query.query(patchSql, [
        value.project_id, value.task_id, value.expected_row_version, value.done,
      ]);
      if (rows.length !== 1 || !isRecord(rows[0])) {
        return { outcome: "failed", reason: "invalid_result" };
      }
      if (!validActor(rows[0], false)) {
        return { outcome: "failed", reason: "invalid_context" };
      }
      if (!isRecord(rows[0].result)) return { outcome: "failed", reason: "invalid_result" };
      return parsePatchResult(rows[0].result, value) ??
        { outcome: "failed", reason: "invalid_result" };
    });
  } catch {
    return { outcome: "failed", reason: "dependency_failure" };
  }
}
