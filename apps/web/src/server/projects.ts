import { utcInstantSchema } from "@app-planet/core";
export {
  readOwnedProjectWorkspaceSubset,
  type OwnedProjectWorkspaceDto,
  type OwnedProjectWorkspaceReadResult,
} from "./project-workspace.ts";
export {
  readOwnedProjectCreationFlowAssessmentSubset,
  type OwnedProjectCreationFlowAssessmentResult,
} from "./creation-flow-assessment.ts";
import type { AuthorizationContext } from "./authorization.ts";
import {
  parseCurrentProjectClassificationDto,
  projectClassificationReadSql,
  type CurrentProjectClassificationDto,
} from "./project-classification.ts";

export type ProjectStage =
  | "點子" | "A/B" | "Specification" | "Checkpoint" | "Constitution"
  | "UX/UI" | "Specification Sync" | "Technical Plan" | "Final Pack";

export interface OwnedProjectReadSubset {
  id: string;
  title: string;
  tier: "A" | "B";
  needs_visitor_identity: boolean;
  stage: ProjectStage;
  created_at: string;
  row_version: number;
}

interface OwnedProjectReadCommon {
  id: string;
  title: string;
  stage: ProjectStage;
  created_at: string;
  row_version: number;
}

export type OwnedProjectClassificationReadSubset =
  | (OwnedProjectReadCommon & {
    classification_state: "unconfirmed";
    requested_tier: "A" | "B" | null;
    tier: null;
    needs_visitor_identity: null;
  })
  | (OwnedProjectReadCommon & {
    classification_state: "legacy_unverified";
    requested_tier: null;
    tier: "A" | "B";
    needs_visitor_identity: boolean;
  });

type ProjectReadFailure = {
  outcome: "failed";
  reason: "invalid_input" | "invalid_context" | "dependency_failure" | "invalid_result";
};
type UnsupportedProjectRepresentation = { outcome: "unsupported_representation" };
type OwnedProjectsListResult<T> =
  | { outcome: "listed"; projects: T[] }
  | { outcome: "denied"; reason: "policy_denied" }
  | UnsupportedProjectRepresentation
  | ProjectReadFailure;
export type OwnedProjectsListSubsetResult = OwnedProjectsListResult<OwnedProjectReadSubset>;
export type OwnedProjectClassificationListSubsetResult =
  OwnedProjectsListResult<OwnedProjectClassificationReadSubset>;
type OwnedProjectReadResult<T> =
  | { outcome: "found"; project: T }
  | { outcome: "not_found" }
  | UnsupportedProjectRepresentation
  | ProjectReadFailure;
export type OwnedProjectReadSubsetResult = OwnedProjectReadResult<OwnedProjectReadSubset>;
export type OwnedProjectClassificationReadSubsetResult =
  OwnedProjectReadResult<OwnedProjectClassificationReadSubset>;

export interface ProjectCreationQuery {
  query(text: string, values?: unknown[]): Promise<{ rows: unknown[] }>;
}

export interface ProjectCreationContext {
  runTransaction<T>(operation: (query: ProjectCreationQuery) => Promise<T>): Promise<T>;
}

type ProjectRepresentation<T> =
  | { kind: "supported"; project: T }
  | { kind: "unsupported"; id: string }
  | { kind: "invalid" };

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const stages: ReadonlySet<string> = new Set<ProjectStage>([
  "點子", "A/B", "Specification", "Checkpoint", "Constitution",
  "UX/UI", "Specification Sync", "Technical Plan", "Final Pack",
]);

// 沿用 §37 防護而不改動已完成的授權模組；gate 與 RLS 資料在同一 statement snapshot。
const readSql = projectClassificationReadSql(false, true);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStage(value: unknown): value is ProjectStage {
  return typeof value === "string" && stages.has(value);
}

function projectReadCommon(value: Record<string, unknown>): OwnedProjectReadCommon | null {
  if (typeof value.id !== "string" || !uuid.test(value.id) ||
      typeof value.title !== "string" || !isStage(value.stage) ||
      typeof value.created_at !== "string" || !utcInstantSchema.safeParse(value.created_at).success ||
      typeof value.row_version !== "number" || !Number.isInteger(value.row_version) ||
      value.row_version < -2147483648 || value.row_version > 2147483647) {
    return null;
  }
  return {
    id: value.id,
    title: value.title,
    stage: value.stage,
    created_at: value.created_at,
    row_version: value.row_version,
  };
}

function classifiedProjectDto(value: unknown): OwnedProjectClassificationReadSubset | null {
  if (!isRecord(value) ||
      (value.classification_state !== "unconfirmed" && value.classification_state !== "legacy_unverified")) {
    return null;
  }
  const common = projectReadCommon(value);
  if (!common) return null;

  if (value.classification_state === "unconfirmed") {
    if ((value.requested_tier !== null && value.requested_tier !== "A" && value.requested_tier !== "B") ||
        value.tier !== null || value.needs_visitor_identity !== null) {
      return null;
    }
    return {
      ...common,
      classification_state: "unconfirmed",
      requested_tier: value.requested_tier,
      tier: null,
      needs_visitor_identity: null,
    };
  }

  if (value.requested_tier !== null ||
      (value.tier !== "A" && value.tier !== "B") ||
      typeof value.needs_visitor_identity !== "boolean") {
    return null;
  }
  return {
    ...common,
    classification_state: "legacy_unverified",
    requested_tier: null,
    tier: value.tier,
    needs_visitor_identity: value.needs_visitor_identity,
  };
}

function legacyProjectDto(value: unknown): ProjectRepresentation<OwnedProjectReadSubset> {
  const parsed = classificationProject(value);
  if (parsed.kind !== "supported") return parsed;
  const classified = parsed.project;
  if (classified.classification_state === "unconfirmed") return { kind: "unsupported", id: classified.id };
  return {
    kind: "supported",
    project: {
      id: classified.id,
      title: classified.title,
      tier: classified.tier,
      needs_visitor_identity: classified.needs_visitor_identity,
      stage: classified.stage,
      created_at: classified.created_at,
      row_version: classified.row_version,
    },
  };
}

function classificationProject(value: unknown): ProjectRepresentation<OwnedProjectClassificationReadSubset> {
  if (isRecord(value) && value.classification_state === "confirmed") {
    const current = parseCurrentProjectClassificationDto(value);
    return current ? { kind: "unsupported", id: current.id } : { kind: "invalid" };
  }
  const project = classifiedProjectDto(value);
  return project ? { kind: "supported", project } : { kind: "invalid" };
}

async function querySubset<T extends { id: string }>(
  context: AuthorizationContext,
  maximumRows: number,
  representation: (value: unknown) => ProjectRepresentation<T>,
  projectId?: string,
): Promise<OwnedProjectsListResult<T>> {
  try {
    return await context.runReadOnly(async (query): Promise<OwnedProjectsListResult<T>> => {
      const { rows } = await query.query(readSql, [String(maximumRows), projectId ?? ""]);
      if (rows.length !== 1 || !isRecord(rows[0])) {
        return { outcome: "failed", reason: "invalid_result" };
      }
      const row = rows[0];
      if (typeof row.subject !== "string" || !uuid.test(row.subject) || row.actor_valid !== true) {
        return { outcome: "failed", reason: "invalid_context" };
      }
      if (typeof row.allowed !== "boolean" || !Array.isArray(row.projects)) {
        return { outcome: "failed", reason: "invalid_result" };
      }
      if (!row.allowed) {
        return row.projects.length === 0
          ? { outcome: "denied", reason: "policy_denied" }
          : { outcome: "failed", reason: "invalid_result" };
      }
      if (row.projects.length > maximumRows) {
        return { outcome: "failed", reason: "invalid_result" };
      }
      const represented: T[] = [];
      const ids = new Set<string>();
      let unsupported = false;
      for (const value of row.projects) {
        const parsed = representation(value);
        if (parsed.kind === "invalid") return { outcome: "failed", reason: "invalid_result" };
        const id = parsed.kind === "supported" ? parsed.project.id : parsed.id;
        if (ids.has(id) || (projectId !== undefined && id !== projectId.toLowerCase())) {
          return { outcome: "failed", reason: "invalid_result" };
        }
        ids.add(id);
        if (parsed.kind === "unsupported") unsupported = true;
        else represented.push(parsed.project);
      }
      if (unsupported) return { outcome: "unsupported_representation" };
      return { outcome: "listed", projects: represented };
    });
  } catch {
    // 僅安全的失敗分類；不回傳 SQL、SQLSTATE、driver error、stack 或憑證。
    return { outcome: "failed", reason: "dependency_failure" };
  }
}

// 有界、無排序保證的資料子集，不是完整產品列表／分頁契約。
export async function listOwnedProjectsSubset(
  context: AuthorizationContext,
  maximumRows: unknown,
): Promise<OwnedProjectsListSubsetResult> {
  if (typeof maximumRows !== "number" || !Number.isInteger(maximumRows) ||
      maximumRows < 1 || maximumRows > 2147483647) {
    return { outcome: "failed", reason: "invalid_input" };
  }
  return querySubset(context, maximumRows, legacyProjectDto);
}

export async function listOwnedProjectsWithClassificationSubset(
  context: AuthorizationContext,
  maximumRows: unknown,
): Promise<OwnedProjectClassificationListSubsetResult> {
  if (typeof maximumRows !== "number" || !Number.isInteger(maximumRows) ||
      maximumRows < 1 || maximumRows > 2147483647) {
    return { outcome: "failed", reason: "invalid_input" };
  }
  return querySubset(context, maximumRows, classificationProject);
}

export async function listCurrentOwnedProjectsSubset(
  context: AuthorizationContext,
): Promise<OwnedProjectsListResult<CurrentProjectClassificationDto>> {
  return querySubset<CurrentProjectClassificationDto>(context, 2147483647, (value) => {
    const project = parseCurrentProjectClassificationDto(value);
    return project ? { kind: "supported", project } : { kind: "invalid" };
  });
}

export async function readOwnedProjectSubset(
  context: AuthorizationContext,
  projectId: unknown,
): Promise<OwnedProjectReadSubsetResult> {
  if (typeof projectId !== "string" || !uuid.test(projectId)) {
    return { outcome: "failed", reason: "invalid_input" };
  }
  const result = await querySubset(context, 1, legacyProjectDto, projectId);
  if (result.outcome === "failed") return result;
  if (result.outcome === "unsupported_representation") return result;
  if (result.outcome === "denied" || result.projects.length === 0) return { outcome: "not_found" };
  return { outcome: "found", project: result.projects[0] };
}

export async function readOwnedProjectWithClassificationSubset(
  context: AuthorizationContext,
  projectId: unknown,
): Promise<OwnedProjectClassificationReadSubsetResult> {
  if (typeof projectId !== "string" || !uuid.test(projectId)) {
    return { outcome: "failed", reason: "invalid_input" };
  }
  const result = await querySubset(context, 1, classificationProject, projectId);
  if (result.outcome === "failed" || result.outcome === "unsupported_representation") return result;
  if (result.outcome === "denied" || result.projects.length === 0) return { outcome: "not_found" };
  return { outcome: "found", project: result.projects[0] };
}

export type OwnedProjectCreationSubsetResult =
  | { outcome: "created"; project: Extract<OwnedProjectClassificationReadSubset, { classification_state: "unconfirmed" }> }
  | { outcome: "denied"; reason: "policy_denied" }
  | { outcome: "conflict"; reason: "idempotency_mismatch" }
  | { outcome: "failed"; reason: "invalid_input" | "invalid_context" | "dependency_failure" | "invalid_result" };

export type OwnedProjectRecoverySubsetResult =
  | { outcome: "replayed"; project: Extract<OwnedProjectClassificationReadSubset, { classification_state: "unconfirmed" }> }
  | { outcome: "unrecoverable" }
  | { outcome: "denied"; reason: "policy_denied" }
  | { outcome: "conflict"; reason: "idempotency_mismatch" }
  | { outcome: "failed"; reason: "invalid_input" | "invalid_context" | "dependency_failure" | "invalid_result" };

type ParsedProjectCreationInput = {
  title: string;
  requestedTier: "A" | "B" | null;
  tierWasProvided: boolean;
  idempotencyKey: string;
};

function parseProjectCreationInput(input: unknown, idempotencyKey: unknown): ParsedProjectCreationInput | null {
  if (!isRecord(input) || !Object.hasOwn(input, "title") || typeof input.title !== "string" ||
      Reflect.ownKeys(input).some((key) => key !== "title" && key !== "tier") ||
      (Object.hasOwn(input, "tier") && input.tier !== "A" && input.tier !== "B") ||
      typeof idempotencyKey !== "string" || !uuid.test(idempotencyKey)) {
    return null;
  }
  const tierWasProvided = Object.hasOwn(input, "tier");
  const requestedTier = input.tier === "A" || input.tier === "B" ? input.tier : null;
  return {
    title: input.title,
    requestedTier,
    tierWasProvided,
    idempotencyKey,
  };
}

function projectOperationSql(functionName: "create_unclassified_project" | "replay_unclassified_project"): string {
  return `
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
      THEN app.${functionName}($1::text, $2::text, $3::boolean, $4::uuid)
      ELSE jsonb_build_object('outcome', 'invalid_context')
    END AS result
  FROM actor
`;
}

const createProjectSql = projectOperationSql("create_unclassified_project");
const replayProjectSql = projectOperationSql("replay_unclassified_project");

function creationResult(value: unknown): OwnedProjectCreationSubsetResult | null {
  if (!isRecord(value) || typeof value.outcome !== "string") return null;
  if (value.outcome === "denied") return { outcome: "denied", reason: "policy_denied" };
  if (value.outcome === "idempotency_conflict") {
    return { outcome: "conflict", reason: "idempotency_mismatch" };
  }
  if (value.outcome === "invalid_input") return { outcome: "failed", reason: "invalid_input" };
  if (value.outcome === "invalid_context") return { outcome: "failed", reason: "invalid_context" };
  if (value.outcome !== "created") return null;

  const project = classifiedProjectDto(value.project);
  if (!project ||
      project.classification_state !== "unconfirmed" ||
      project.stage !== "點子" ||
      project.row_version !== 0) {
    return null;
  }
  return { outcome: "created", project };
}

function recoveryResult(value: unknown): OwnedProjectRecoverySubsetResult | null {
  if (!isRecord(value) || typeof value.outcome !== "string") return null;
  if (value.outcome === "denied") return { outcome: "denied", reason: "policy_denied" };
  if (value.outcome === "idempotency_conflict") {
    return { outcome: "conflict", reason: "idempotency_mismatch" };
  }
  if (value.outcome === "unrecoverable") return { outcome: "unrecoverable" };
  if (value.outcome === "invalid_input") return { outcome: "failed", reason: "invalid_input" };
  if (value.outcome === "invalid_context") return { outcome: "failed", reason: "invalid_context" };
  if (value.outcome !== "replayed") return null;

  const project = classifiedProjectDto(value.project);
  if (!project ||
      project.classification_state !== "unconfirmed" ||
      project.stage !== "點子" ||
      project.row_version !== 0) {
    return null;
  }
  return { outcome: "replayed", project };
}

async function runProjectOperation(
  context: ProjectCreationContext,
  sql: string,
  input: ParsedProjectCreationInput,
): Promise<{ ok: true; value: unknown } | { ok: false; reason: "invalid_context" | "dependency_failure" }> {
  try {
    const value = await context.runTransaction(async (query) => {
      const { rows } = await query.query(sql, [
        input.title, input.requestedTier, input.tierWasProvided, input.idempotencyKey,
      ]);
      if (rows.length !== 1 || !isRecord(rows[0]) ||
          rows[0].actor_valid !== true || !("result" in rows[0])) {
        return { invalidContext: true as const };
      }
      return { result: rows[0].result };
    });
    if ("invalidContext" in value) return { ok: false, reason: "invalid_context" };
    return { ok: true, value: value.result };
  } catch {
    return { ok: false, reason: "dependency_failure" };
  }
}

export async function createOwnedProjectSubset(
  context: ProjectCreationContext,
  input: unknown,
  idempotencyKey: unknown,
): Promise<OwnedProjectCreationSubsetResult> {
  const parsedInput = parseProjectCreationInput(input, idempotencyKey);
  if (!parsedInput) {
    return { outcome: "failed", reason: "invalid_input" };
  }

  const execution = await runProjectOperation(context, createProjectSql, parsedInput);
  if (!execution.ok) return { outcome: "failed", reason: execution.reason };
  return creationResult(execution.value) ?? { outcome: "failed", reason: "invalid_result" };
}

export async function replayOwnedProjectSubset(
  context: ProjectCreationContext,
  input: unknown,
  idempotencyKey: unknown,
): Promise<OwnedProjectRecoverySubsetResult> {
  const parsedInput = parseProjectCreationInput(input, idempotencyKey);
  if (!parsedInput) return { outcome: "failed", reason: "invalid_input" };

  const execution = await runProjectOperation(context, replayProjectSql, parsedInput);
  if (!execution.ok) return { outcome: "failed", reason: execution.reason };
  return recoveryResult(execution.value) ?? { outcome: "failed", reason: "invalid_result" };
}

export {
  confirmOwnedProjectClassificationSubset,
  hasTrustedProjectClassification,
  readCurrentOwnedProjectClassificationSubset,
  resolveTrustedProjectClassification,
  saveOwnedProjectRequirementsSubset,
} from "./project-classification.ts";
export type {
  ConfirmProjectClassificationResult,
  CurrentProjectClassificationDto,
  ProjectClassificationReadResult,
  SaveProjectRequirementsResult,
  TrustedProjectClassification,
} from "./project-classification.ts";
