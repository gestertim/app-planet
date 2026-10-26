import {
  confirmProjectClassificationInputSchema,
  projectRequirementsSchema,
  saveProjectRequirementsInputSchema,
  utcInstantSchema,
  type ConfirmProjectClassificationInput,
  type ProjectRequirements,
  type SaveProjectRequirementsInput,
} from "@app-planet/core";
import type { AuthorizationContext } from "./authorization.ts";
import type { ProjectCreationContext } from "./projects.ts";

type ProjectReadQuery = {
  query(text: string, values?: unknown[]): Promise<{ rows: unknown[] }>;
};

type ProjectReadCommon = {
  id: string;
  title: string;
  stage: string;
  created_at: string;
  row_version: number;
};

export type CurrentProjectClassificationDto =
  | (ProjectReadCommon & {
    classification_state: "unconfirmed";
    requested_tier: "A" | "B" | null;
    tier: null;
    needs_visitor_identity: null;
    requirements_revision: number;
    requirements: ProjectRequirements | null;
    confirmation: null;
  })
  | (ProjectReadCommon & {
    classification_state: "legacy_unverified";
    requested_tier: null;
    tier: "A" | "B";
    needs_visitor_identity: boolean;
    requirements_revision: 0;
    requirements: null;
    confirmation: null;
  })
  | (ProjectReadCommon & {
    classification_state: "confirmed";
    requested_tier: "A" | "B" | null;
    tier: "A" | "B";
    needs_visitor_identity: boolean;
    requirements_revision: number;
    requirements: ProjectRequirements;
    confirmation: {
      id: string;
      requirements_revision: number;
      confirmed_by: string;
      confirmed_at: string;
      source: "student_explicit_confirmation";
      requested_tier_at_confirmation: "A" | "B" | null;
      requested_tier_acknowledgement: "no_preference" | "matches" | "explicit_change";
    };
  });

export type TrustedProjectClassification = Readonly<{
  project_id: string;
  requirements_revision: number;
  tier: "A" | "B";
  needs_visitor_identity: boolean;
  confirmed_by: string;
  confirmed_at: string;
}>;

export type ProjectClassificationReadResult =
  | { outcome: "found"; project: CurrentProjectClassificationDto }
  | { outcome: "not_found" }
  | { outcome: "denied"; reason: "policy_denied" }
  | { outcome: "failed"; reason: "invalid_input" | "invalid_context" | "dependency_failure" | "invalid_result" };

type ProjectOperationReceipt =
  | {
    outcome: "saved";
    requirements_revision: number;
    requirements: ProjectRequirements;
    row_version: number;
    changed: boolean;
  }
  | {
    outcome: "confirmed";
    requirements_revision: number;
    tier: "A" | "B";
    needs_visitor_identity: boolean;
    confirmation: {
      id: string;
      requirements_revision: number;
      confirmed_by: string;
      confirmed_at: string;
      source: "student_explicit_confirmation";
    };
    row_version: number;
  };

type ProjectOperationResult =
  | { outcome: "saved"; operation: Extract<ProjectOperationReceipt, { outcome: "saved" }> }
  | { outcome: "confirmed"; operation: Extract<ProjectOperationReceipt, { outcome: "confirmed" }> }
  | {
    outcome: "replayed";
    operation: ProjectOperationReceipt;
    current_classification: ProjectClassificationReadResult;
  }
  | { outcome: "denied"; reason: "policy_denied" }
  | { outcome: "not_found" }
  | { outcome: "conflict"; reason: "idempotency_mismatch" }
  | {
    outcome: "failed";
    reason:
      | "invalid_input"
      | "invalid_context"
      | "dependency_failure"
      | "invalid_result"
      | "version_conflict"
      | "requirements_missing"
      | "unsupported_runtime"
      | "unsupported_runtime_ai"
      | "inconsistent_input"
      | "requested_tier_acknowledgement_required"
      | "version_exhausted";
  };

export type SaveProjectRequirementsResult = ProjectOperationResult;
export type ConfirmProjectClassificationResult = ProjectOperationResult;

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const validStages = new Set([
  "點子", "A/B", "Specification", "Checkpoint", "Constitution",
  "UX/UI", "Specification Sync", "Technical Plan", "Final Pack",
]);
const trustedClassifications = new WeakSet<object>();

export function projectClassificationReadSql(readWriteTransaction: boolean, list = false): string {
  const expectedReadOnly = readWriteTransaction ? "off" : "on";
  return `
  WITH access AS MATERIALIZED (
    SELECT auth.uid() AS subject,
      (current_user = 'authenticated'
        AND current_setting('transaction_read_only') = '${expectedReadOnly}'
        AND NOT EXISTS (
          SELECT 1 FROM pg_catalog.pg_roles
          WHERE rolname IN (current_user, session_user) AND (rolsuper OR rolbypassrls)
        )
        AND NOT EXISTS (
          SELECT 1 FROM pg_catalog.pg_class AS relation
          JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
          JOIN pg_catalog.pg_roles AS actor ON actor.oid = relation.relowner
          WHERE namespace.nspname = 'app' AND actor.rolname IN (current_user, session_user)
        )
      ) AS actor_valid,
      app.current_account_gate('read_saved_content') AS allowed
  )
  SELECT access.subject::text, access.actor_valid, access.allowed,
    (
      SELECT ${list ? "COALESCE(jsonb_agg(visible.project), '[]'::jsonb)" : "visible.project"}
      FROM (
      SELECT jsonb_build_object(
        'id', project.id::text,
        'title', project.title,
        'stage', project.stage,
        'created_at', to_char(project.created_at AT TIME ZONE 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
        'row_version', project.row_version,
        'classification_state', project.classification_state,
        'requested_tier', project.requested_tier,
        'tier', project.tier,
        'needs_visitor_identity', project.needs_visitor_identity,
        'requirements_revision', project.requirements_revision,
        'requirements', CASE WHEN requirement.project_id IS NULL THEN NULL ELSE
          jsonb_build_object(
            'description', requirement.description,
            'runtime_needs', requirement.runtime_needs,
            'runtime_ai_required', requirement.runtime_ai_required
          ) END,
        'confirmation', CASE WHEN evidence.id IS NULL THEN NULL ELSE
          jsonb_build_object(
            'id', evidence.id::text,
            'requirements_revision', evidence.requirements_revision,
            'confirmed_by', evidence.confirmed_by::text,
            'confirmed_at', to_char(evidence.confirmed_at AT TIME ZONE 'UTC',
              'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
            'source', evidence.source,
            'requested_tier_at_confirmation', evidence.requested_tier_at_confirmation,
            'requested_tier_acknowledgement', evidence.requested_tier_acknowledgement,
            'requirements_match',
              evidence.project_id = project.id
              AND evidence.requirements_revision = project.requirements_revision
              AND evidence.confirmed_by = project.owner_id
              AND evidence.source = 'student_explicit_confirmation'
              AND convert_to(evidence.requirements_description, 'UTF8')
                = convert_to(requirement.description, 'UTF8')
              AND evidence.requirements_runtime_needs = requirement.runtime_needs
              AND evidence.requirements_runtime_ai_required = requirement.runtime_ai_required
              AND evidence.tier = project.tier
              AND evidence.needs_visitor_identity = project.needs_visitor_identity
              AND evidence.requested_tier_at_confirmation IS NOT DISTINCT FROM project.requested_tier
              AND evidence.requested_tier_acknowledgement = CASE
                WHEN project.requested_tier IS NULL THEN 'no_preference'
                WHEN project.requested_tier = project.tier THEN 'matches'
                ELSE 'explicit_change'
              END
          ) END
      ) AS project
      FROM app.projects AS project
      LEFT JOIN app.project_requirements AS requirement
        ON requirement.project_id = project.id
       AND requirement.revision = project.requirements_revision
      LEFT JOIN app.project_classification_confirmations AS evidence
        ON evidence.project_id = project.id
       AND evidence.id = project.current_confirmation_id
       AND evidence.requirements_revision = project.requirements_revision
      WHERE access.actor_valid AND access.allowed
        AND ${list ? "($2::text = '' OR project.id = nullif($2::text, '')::uuid)" : "project.id = $1::uuid"}
        AND project.owner_id = access.subject
      LIMIT ${list ? "$1::int" : "1"}
      ) AS visible
    ) AS ${list ? "projects" : "project"}
  FROM access
`;
}

const saveRequirementsSql = `
  WITH actor AS MATERIALIZED (
    SELECT (
      current_user = 'authenticated'
      AND current_setting('transaction_read_only') = 'off'
      AND NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_roles
        WHERE rolname IN (current_user, session_user) AND (rolsuper OR rolbypassrls)
      )
      AND NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_class AS relation
        JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
        JOIN pg_catalog.pg_roles AS actor_role ON actor_role.oid = relation.relowner
        WHERE namespace.nspname = 'app' AND actor_role.rolname IN (current_user, session_user)
      )
    ) AS actor_valid
  )
  SELECT actor.actor_valid,
    CASE WHEN actor.actor_valid
      THEN app.save_project_requirements(
        $1::uuid, $2::integer, $3::integer, $4::text, $5::text, $6::boolean, $7::uuid
      )
      ELSE jsonb_build_object('outcome', 'invalid_context')
    END AS result
  FROM actor
`;

const confirmClassificationSql = `
  WITH actor AS MATERIALIZED (
    SELECT (
      current_user = 'authenticated'
      AND current_setting('transaction_read_only') = 'off'
      AND NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_roles
        WHERE rolname IN (current_user, session_user) AND (rolsuper OR rolbypassrls)
      )
      AND NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_class AS relation
        JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
        JOIN pg_catalog.pg_roles AS actor_role ON actor_role.oid = relation.relowner
        WHERE namespace.nspname = 'app' AND actor_role.rolname IN (current_user, session_user)
      )
    ) AS actor_valid
  )
  SELECT actor.actor_valid,
    CASE WHEN actor.actor_valid
      THEN app.confirm_project_classification(
        $1::uuid, $2::integer, $3::integer, $4::text, $5::boolean, $6::text, $7::uuid
      )
      ELSE jsonb_build_object('outcome', 'invalid_context')
    END AS result
  FROM actor
`;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseCurrentProjectClassificationDto(value: unknown): CurrentProjectClassificationDto | null {
  if (!isRecord(value) ||
      typeof value.id !== "string" || !uuid.test(value.id) ||
      typeof value.title !== "string" ||
      typeof value.stage !== "string" || !validStages.has(value.stage) ||
      typeof value.created_at !== "string" ||
      !utcInstantSchema.safeParse(value.created_at).success ||
      typeof value.row_version !== "number" || !Number.isInteger(value.row_version) ||
      value.row_version < -2147483648 || value.row_version > 2147483647 ||
      typeof value.requirements_revision !== "number" ||
      !Number.isInteger(value.requirements_revision) ||
      value.requirements_revision < 0 || value.requirements_revision > 2147483647) {
    return null;
  }

  const common: ProjectReadCommon = {
    id: value.id,
    title: value.title,
    stage: value.stage,
    created_at: value.created_at,
    row_version: value.row_version,
  };
  const parsedRequirements = value.requirements === null
    ? null
    : projectRequirementsSchema.safeParse(value.requirements);
  if (parsedRequirements && parsedRequirements !== null && !parsedRequirements.success) return null;
  const requirements = parsedRequirements && parsedRequirements !== null
    ? parsedRequirements.data
    : null;

  if (value.classification_state === "legacy_unverified") {
    if (value.requested_tier !== null ||
        (value.tier !== "A" && value.tier !== "B") ||
        typeof value.needs_visitor_identity !== "boolean" ||
        value.requirements_revision !== 0 || requirements !== null || value.confirmation !== null) {
      return null;
    }
    return {
      ...common,
      classification_state: "legacy_unverified",
      requested_tier: null,
      tier: value.tier,
      needs_visitor_identity: value.needs_visitor_identity,
      requirements_revision: 0,
      requirements: null,
      confirmation: null,
    };
  }

  if (value.classification_state === "unconfirmed") {
    if ((value.requested_tier !== null && value.requested_tier !== "A" && value.requested_tier !== "B") ||
        value.tier !== null || value.needs_visitor_identity !== null || value.confirmation !== null ||
        (value.requirements_revision === 0 && requirements !== null) ||
        (value.requirements_revision > 0 && requirements === null)) {
      return null;
    }
    return {
      ...common,
      classification_state: "unconfirmed",
      requested_tier: value.requested_tier,
      tier: null,
      needs_visitor_identity: null,
      requirements_revision: value.requirements_revision,
      requirements,
      confirmation: null,
    };
  }

  if (value.classification_state !== "confirmed" ||
      (value.requested_tier !== null && value.requested_tier !== "A" && value.requested_tier !== "B") ||
      (value.tier !== "A" && value.tier !== "B") ||
      typeof value.needs_visitor_identity !== "boolean" ||
      value.requirements_revision <= 0 || requirements === null ||
      !isRecord(value.confirmation)) {
    return null;
  }

  const confirmation = value.confirmation;
  if (confirmation.requirements_match !== true ||
      typeof confirmation.id !== "string" || !uuid.test(confirmation.id) ||
      confirmation.requirements_revision !== value.requirements_revision ||
      typeof confirmation.confirmed_by !== "string" || !uuid.test(confirmation.confirmed_by) ||
      typeof confirmation.confirmed_at !== "string" ||
      !utcInstantSchema.safeParse(confirmation.confirmed_at).success ||
      confirmation.source !== "student_explicit_confirmation" ||
      (confirmation.requested_tier_at_confirmation !== null &&
        confirmation.requested_tier_at_confirmation !== "A" &&
        confirmation.requested_tier_at_confirmation !== "B") ||
      (confirmation.requested_tier_acknowledgement !== "no_preference" &&
        confirmation.requested_tier_acknowledgement !== "matches" &&
        confirmation.requested_tier_acknowledgement !== "explicit_change") ||
      (value.tier === "A" && requirements.runtime_needs !== "static") ||
      (value.tier === "B" && requirements.runtime_needs !== "work_data_api") ||
      requirements.runtime_ai_required ||
      confirmation.requested_tier_at_confirmation !== value.requested_tier ||
      (value.requested_tier === null &&
        confirmation.requested_tier_acknowledgement !== "no_preference") ||
      (value.requested_tier === value.tier &&
        confirmation.requested_tier_acknowledgement !== "matches") ||
      (value.requested_tier !== null && value.requested_tier !== value.tier &&
        confirmation.requested_tier_acknowledgement !== "explicit_change")) {
    return null;
  }

  return {
    ...common,
    classification_state: "confirmed",
    requested_tier: value.requested_tier,
    tier: value.tier,
    needs_visitor_identity: value.needs_visitor_identity,
    requirements_revision: value.requirements_revision,
    requirements,
    confirmation: {
      id: confirmation.id,
      requirements_revision: confirmation.requirements_revision,
      confirmed_by: confirmation.confirmed_by,
      confirmed_at: confirmation.confirmed_at,
      source: "student_explicit_confirmation",
      requested_tier_at_confirmation: confirmation.requested_tier_at_confirmation,
      requested_tier_acknowledgement: confirmation.requested_tier_acknowledgement,
    },
  };
}

function freezeDto<T>(value: T): T {
  if (typeof value === "object" && value !== null) {
    for (const child of Object.values(value)) freezeDto(child);
    Object.freeze(value);
  }
  return value;
}

async function readCurrentWithQuery(
  query: ProjectReadQuery,
  projectId: string,
  readWriteTransaction = false,
): Promise<ProjectClassificationReadResult> {
  const { rows } = await query.query(projectClassificationReadSql(readWriteTransaction), [projectId]);
  if (rows.length !== 1 || !isRecord(rows[0])) {
    return { outcome: "failed", reason: "invalid_result" };
  }
  const row = rows[0];
  if (typeof row.subject !== "string" || !uuid.test(row.subject) || row.actor_valid !== true) {
    return { outcome: "failed", reason: "invalid_context" };
  }
  if (typeof row.allowed !== "boolean") return { outcome: "failed", reason: "invalid_result" };
  if (!row.allowed) return { outcome: "denied", reason: "policy_denied" };
  if (row.project === null) return { outcome: "not_found" };
  const project = parseCurrentProjectClassificationDto(row.project);
  if (!project) return { outcome: "failed", reason: "invalid_result" };
  freezeDto(project);
  return { outcome: "found", project };
}

export async function readCurrentOwnedProjectClassificationSubset(
  context: AuthorizationContext,
  projectId: unknown,
): Promise<ProjectClassificationReadResult> {
  if (typeof projectId !== "string" || !uuid.test(projectId)) {
    return { outcome: "failed", reason: "invalid_input" };
  }
  try {
    return await context.runReadOnly((query) => readCurrentWithQuery(query, projectId));
  } catch {
    return { outcome: "failed", reason: "dependency_failure" };
  }
}

function operationResult(value: unknown): ProjectOperationResult | null {
  if (!isRecord(value) || typeof value.outcome !== "string") return null;
  switch (value.outcome) {
    case "denied": return { outcome: "denied", reason: "policy_denied" };
    case "not_found": return { outcome: "not_found" };
    case "idempotency_conflict": return { outcome: "conflict", reason: "idempotency_mismatch" };
    case "invalid_input": return { outcome: "failed", reason: "invalid_input" };
    case "invalid_context": return { outcome: "failed", reason: "invalid_context" };
    case "version_conflict": return { outcome: "failed", reason: "version_conflict" };
    case "requirements_missing": return { outcome: "failed", reason: "requirements_missing" };
    case "unsupported_runtime": return { outcome: "failed", reason: "unsupported_runtime" };
    case "unsupported_runtime_ai": return { outcome: "failed", reason: "unsupported_runtime_ai" };
    case "inconsistent_input": return { outcome: "failed", reason: "inconsistent_input" };
    case "requested_tier_acknowledgement_required":
      return { outcome: "failed", reason: "requested_tier_acknowledgement_required" };
    case "version_exhausted": return { outcome: "failed", reason: "version_exhausted" };
    case "replayed":
    case "saved":
    case "confirmed": {
      const operation = parseOperationReceipt(value.operation);
      if (!operation) return null;
      if (value.outcome === "replayed") {
        return {
          outcome: "replayed",
          operation,
          current_classification: { outcome: "failed", reason: "invalid_result" },
        };
      }
      if (value.outcome === "saved" && operation.outcome === "saved") {
        return { outcome: "saved", operation };
      }
      if (value.outcome === "confirmed" && operation.outcome === "confirmed") {
        return { outcome: "confirmed", operation };
      }
      return null;
    }
    default:
      return null;
  }
}

function parseOperationReceipt(value: unknown): ProjectOperationReceipt | null {
  if (!isRecord(value) || typeof value.outcome !== "string" ||
      typeof value.row_version !== "number" || !Number.isInteger(value.row_version) ||
      value.row_version < -2147483648 || value.row_version > 2147483647) {
    return null;
  }
  if (value.outcome === "saved") {
    const requirements = projectRequirementsSchema.safeParse(value.requirements);
    if (!requirements.success ||
        typeof value.requirements_revision !== "number" ||
        !Number.isInteger(value.requirements_revision) ||
        value.requirements_revision <= 0 || value.requirements_revision > 2147483647 ||
        typeof value.changed !== "boolean") {
      return null;
    }
    return {
      outcome: "saved",
      requirements_revision: value.requirements_revision,
      requirements: requirements.data,
      row_version: value.row_version,
      changed: value.changed,
    };
  }
  if (value.outcome === "confirmed" &&
      (value.tier === "A" || value.tier === "B") &&
      typeof value.needs_visitor_identity === "boolean" &&
      typeof value.requirements_revision === "number" &&
      Number.isInteger(value.requirements_revision) && value.requirements_revision > 0 &&
      value.requirements_revision <= 2147483647 && isRecord(value.confirmation) &&
      typeof value.confirmation.id === "string" && uuid.test(value.confirmation.id) &&
      value.confirmation.requirements_revision === value.requirements_revision &&
      typeof value.confirmation.confirmed_by === "string" && uuid.test(value.confirmation.confirmed_by) &&
      typeof value.confirmation.confirmed_at === "string" &&
      utcInstantSchema.safeParse(value.confirmation.confirmed_at).success &&
      value.confirmation.source === "student_explicit_confirmation") {
    return {
      outcome: "confirmed",
      requirements_revision: value.requirements_revision,
      tier: value.tier,
      needs_visitor_identity: value.needs_visitor_identity,
      confirmation: {
        id: value.confirmation.id,
        requirements_revision: value.confirmation.requirements_revision,
        confirmed_by: value.confirmation.confirmed_by,
        confirmed_at: value.confirmation.confirmed_at,
        source: "student_explicit_confirmation",
      },
      row_version: value.row_version,
    };
  }
  return null;
}

class InvalidProjectOperationResult extends Error {}

async function callProjectOperation(
  context: ProjectCreationContext,
  sql: string,
  values: unknown[],
  projectId: string,
): Promise<ProjectOperationResult> {
  try {
    return await context.runTransaction(async (query) => {
      const result = await query.query(sql, values);
      if (result.rows.length !== 1 || !isRecord(result.rows[0]) ||
          result.rows[0].actor_valid !== true || !("result" in result.rows[0])) {
        throw new InvalidProjectOperationResult();
      }
      const parsed = operationResult(result.rows[0].result);
      if (!parsed) throw new InvalidProjectOperationResult();
      if (parsed.outcome !== "replayed") return parsed;
      const current = await readCurrentWithQuery(query, projectId, true);
      if (current.outcome === "failed") throw new InvalidProjectOperationResult();
      return { ...parsed, current_classification: current };
    });
  } catch (error) {
    return {
      outcome: "failed",
      reason: error instanceof InvalidProjectOperationResult ? "invalid_result" : "dependency_failure",
    };
  }
}

export async function saveOwnedProjectRequirementsSubset(
  context: ProjectCreationContext,
  input: unknown,
  idempotencyKey: unknown,
): Promise<SaveProjectRequirementsResult> {
  const parsed = saveProjectRequirementsInputSchema.safeParse(input);
  if (!parsed.success || typeof idempotencyKey !== "string" || !uuid.test(idempotencyKey)) {
    return { outcome: "failed", reason: "invalid_input" };
  }
  const value: SaveProjectRequirementsInput = parsed.data;
  return callProjectOperation(context, saveRequirementsSql, [
    value.project_id,
    value.expected_row_version,
    value.expected_requirements_revision,
    value.requirements.description,
    value.requirements.runtime_needs,
    value.requirements.runtime_ai_required,
    idempotencyKey,
  ], value.project_id);
}

export async function confirmOwnedProjectClassificationSubset(
  context: ProjectCreationContext,
  input: unknown,
  idempotencyKey: unknown,
): Promise<ConfirmProjectClassificationResult> {
  const parsed = confirmProjectClassificationInputSchema.safeParse(input);
  if (!parsed.success || typeof idempotencyKey !== "string" || !uuid.test(idempotencyKey)) {
    return { outcome: "failed", reason: "invalid_input" };
  }
  const value: ConfirmProjectClassificationInput = parsed.data;
  return callProjectOperation(context, confirmClassificationSql, [
    value.project_id,
    value.expected_row_version,
    value.expected_requirements_revision,
    value.tier,
    value.needs_visitor_identity,
    value.requested_tier_acknowledgement,
    idempotencyKey,
  ], value.project_id);
}

export async function resolveTrustedProjectClassification(
  context: AuthorizationContext,
  projectId: unknown,
): Promise<
  | { outcome: "trusted"; classification: TrustedProjectClassification }
  | { outcome: "unconfirmed" | "legacy_unverified" }
  | Exclude<ProjectClassificationReadResult, { outcome: "found" }>
> {
  const result = await readCurrentOwnedProjectClassificationSubset(context, projectId);
  if (result.outcome !== "found") return result;
  if (result.project.classification_state !== "confirmed") {
    return { outcome: result.project.classification_state };
  }
  const classification: TrustedProjectClassification = Object.freeze({
    project_id: result.project.id,
    requirements_revision: result.project.requirements_revision,
    tier: result.project.tier,
    needs_visitor_identity: result.project.needs_visitor_identity,
    confirmed_by: result.project.confirmation.confirmed_by,
    confirmed_at: result.project.confirmation.confirmed_at,
  });
  trustedClassifications.add(classification);
  return { outcome: "trusted", classification };
}

export function hasTrustedProjectClassification(value: unknown): value is TrustedProjectClassification {
  // 僅證明 resolver 來源；當前資格須重新解析 DB，不以舊物件替代即時授權。
  return typeof value === "object" && value !== null && trustedClassifications.has(value);
}
