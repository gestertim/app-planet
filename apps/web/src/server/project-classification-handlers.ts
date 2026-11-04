import {
  projectClassificationBodySchema,
  projectClassificationCurrentSchema,
  projectClassificationResponseSchema,
  projectRequirementsBodySchema,
  type ProjectClassificationCurrent,
} from "@app-planet/core";
import { authorizeCapability } from "./authorization.ts";
import {
  confirmOwnedProjectClassificationSubset, readCurrentOwnedProjectClassificationSubset,
  saveOwnedProjectRequirementsSubset, type CurrentProjectClassificationDto,
} from "./project-classification.ts";
import {
  createRouteHandler, jsonResponse, problemResponse, rowEtag,
  type ResponseContext, type RouteOptions,
} from "./http.ts";
import { readJsonBody } from "./http.ts";
import { readIdempotencyKey, runGuarded } from "./idempotency.ts";

export function publicProjectClassification(project: CurrentProjectClassificationDto): ProjectClassificationCurrent {
  const confirmation = project.confirmation;
  return projectClassificationCurrentSchema.parse({
    id: project.id, row_version: project.row_version,
    requirements_revision: project.requirements_revision,
    requested_tier: project.requested_tier,
    classification_state: project.classification_state,
    requirements: project.requirements,
    tier: project.tier, needs_visitor_identity: project.needs_visitor_identity,
    confirmation: confirmation ? {
      id: confirmation.id, requirements_revision: confirmation.requirements_revision,
      confirmed_at: confirmation.confirmed_at, source: confirmation.source,
    } : null,
  });
}

export function readClassificationVersion(headers: Headers):
  | { ok: true; version: number }
  | { ok: false; code: "if_match_required" | "invalid_if_match" } {
  const raw = headers.get("if-match");
  if (raw === null) return { ok: false, code: "if_match_required" };
  if (headers.has("if-none-match") || !/^"(?:0|[1-9]\d*|-[1-9]\d*)"$/.test(raw)) {
    return { ok: false, code: "invalid_if_match" };
  }
  const version = Number(raw.slice(1, -1));
  return Number.isInteger(version) && version >= -2147483648 && version <= 2147483647
    ? { ok: true, version } : { ok: false, code: "invalid_if_match" };
}

function boundedJson(body: unknown, context: ResponseContext, version: number) {
  if (Buffer.byteLength(JSON.stringify(body), "utf8") > 256 * 1024) {
    return problemResponse("dependency_unavailable", context);
  }
  return jsonResponse(200, body, context, { etag: rowEtag(version) });
}

export function createProjectClassificationHandlers(
  options: Pick<RouteOptions, "resolver" | "log" | "requireSameOrigin">,
) {
  const read = createRouteHandler({
    ...options, route: "project_classification_read", methods: ["GET"], requireSameOrigin: false,
  }, async ({ session, routeParams, ...context }) => {
    const result = await readCurrentOwnedProjectClassificationSubset(session.read, routeParams.id);
    if (result.outcome === "found") {
      const current = publicProjectClassification(result.project);
      return boundedJson(current, context, current.row_version);
    }
    return problemResponse(result.outcome === "denied" ? "forbidden" :
      result.outcome === "not_found" || result.reason === "invalid_input" ? "not_found" :
        "dependency_unavailable", context);
  });

  const write = (kind: "requirements" | "confirmation") => createRouteHandler({
    ...options, route: `project_classification_${kind}`, methods: [kind === "requirements" ? "PUT" : "POST"],
  }, async ({ request, session, routeParams, ...context }) => {
    const gate = await authorizeCapability(session.read, "edit_saved_content");
    if (gate.outcome !== "allowed") {
      return problemResponse(gate.outcome === "denied" ? "forbidden" : "dependency_unavailable", context);
    }
    const match = readClassificationVersion(request.headers);
    if (!match.ok) return problemResponse(match.code, context);
    const key = readIdempotencyKey(request.headers);
    if (!key.ok) return problemResponse(key.code, context);
    const body = await readJsonBody(request, (value) => {
      const schema = kind === "requirements" ? projectRequirementsBodySchema : projectClassificationBodySchema;
      const parsed = schema.safeParse(value);
      return parsed.success ? parsed.data : null;
    }, 64 * 1024);
    if (!body.ok) return problemResponse(body.code, context);
    const input = { ...body.data, project_id: routeParams.id, expected_row_version: match.version };
    const result = await runGuarded(() => kind === "requirements"
      ? saveOwnedProjectRequirementsSubset(session.write, input, key.key)
      : confirmOwnedProjectClassificationSubset(session.write, input, key.key));
    if (result.state === "unknown") return problemResponse("operation_outcome_unknown", context);
    const value = result.value;
    if (value.outcome === "denied") return problemResponse("forbidden", context);
    if (value.outcome === "not_found") return problemResponse("not_found", context);
    if (value.outcome === "conflict") return problemResponse("idempotency_key_reuse", context);
    if (value.outcome === "failed") {
      const codes = {
        invalid_input: "invalid_request",
        invalid_context: "operation_outcome_unknown",
        dependency_failure: "operation_outcome_unknown",
        invalid_result: "operation_outcome_unknown",
        version_conflict: "version_conflict",
        requirements_missing: "project_requirements_missing",
        unsupported_runtime: "student_server_runtime_not_in_mvp",
        unsupported_runtime_ai: "work_runtime_ai_not_in_mvp",
        inconsistent_input: "classification_inconsistent",
        requested_tier_acknowledgement_required: "classification_acknowledgement_required",
        version_exhausted: "version_conflict",
      } as const;
      return problemResponse(codes[value.reason], context);
    }
    // receipt 描述原提交；current 必須重讀，不能由 receipt 恢復分類。
    const current = await readCurrentOwnedProjectClassificationSubset(session.read, routeParams.id);
    if (current.outcome !== "found") return problemResponse(
      current.outcome === "denied" ? "forbidden" : current.outcome === "not_found" ? "not_found" :
        "operation_outcome_unknown", context);
    const operation = value.operation.outcome === "saved" ? value.operation : {
      ...value.operation,
      confirmation: {
        id: value.operation.confirmation.id,
        requirements_revision: value.operation.confirmation.requirements_revision,
        confirmed_at: value.operation.confirmation.confirmed_at,
        source: value.operation.confirmation.source,
      },
    };
    const response = projectClassificationResponseSchema.safeParse({
      outcome: value.outcome, operation, current: publicProjectClassification(current.project),
    });
    if (!response.success) return problemResponse("operation_outcome_unknown", context);
    return boundedJson(response.data, context, response.data.current.row_version);
  });
  return { read, save: write("requirements"), confirm: write("confirmation") };
}
