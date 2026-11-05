import { projectRenameBodySchema } from "@app-planet/core";
import { authorizeCapability } from "./authorization.ts";
import { readCurrentAccountStatus } from "./auth/account-status.ts";
import {
  createRouteHandler,
  jsonResponse,
  problemResponse,
  readJsonBody,
  readRowIfMatch,
  rowEtag,
  versionConflictResponse,
  type RouteOptions,
} from "./http.ts";
import { readIdempotencyKey, runGuarded } from "./idempotency.ts";
import { patchOwnedProjectTitle, projectRenamePublicResult } from "./project-rename.ts";

export const projectRenameConflictPolicy = {
  resource: "row",
  allowedContentFields: ["title"],
} as const;

export function createProjectRenameHandlers(
  options: Pick<RouteOptions, "resolver" | "log" | "requireSameOrigin">,
) {
  const patch = createRouteHandler({
    ...options, route: "project_title_patch", methods: ["PATCH"],
  }, async ({ request, session, routeParams, ...context }) => {
    const gate = await authorizeCapability(session.read, "edit_saved_content");
    if (gate.outcome !== "allowed") {
      if (gate.outcome !== "denied") return problemResponse("dependency_unavailable", context);
      const account = await readCurrentAccountStatus(session.read);
      if (account.outcome === "unavailable") return problemResponse("dependency_unavailable", context);
      if (account.outcome === "found" &&
          (account.record.role === "teacher" || account.record.role === "admin") &&
          account.record.status === "approved" && account.record.deletion_state === "none" &&
          account.record.login_gate) {
        return problemResponse("not_found", context);
      }
      return problemResponse("forbidden", context);
    }

    const match = readRowIfMatch(request.headers);
    if (!match.ok) return problemResponse(match.code, context);
    const key = readIdempotencyKey(request.headers);
    if (!key.ok) return problemResponse(key.code, context);
    const rawReplayOnly = request.headers.get("idempotency-replay-only");
    if (rawReplayOnly !== null && rawReplayOnly !== "true") {
      return problemResponse("invalid_request", context);
    }
    const body = await readJsonBody(request, (value) => {
      const parsed = projectRenameBodySchema.safeParse(value);
      return parsed.success ? parsed.data : null;
    }, 64 * 1024);
    if (!body.ok) return problemResponse(body.code, context);

    const result = await runGuarded(() => patchOwnedProjectTitle(session.write, {
      project_id: routeParams.id,
      title: body.data.title,
      expected_row_version: match.version,
      idempotency_key: key.key,
      replay_only: rawReplayOnly === "true",
    }));
    if (result.state === "unknown") return problemResponse("operation_outcome_unknown", context);
    switch (result.value.outcome) {
      case "denied": return problemResponse("forbidden", context);
      case "not_found": return problemResponse("not_found", context);
      case "idempotency_conflict": return problemResponse("idempotency_key_reuse", context);
      case "unrecoverable": return problemResponse("operation_outcome_unrecoverable", context);
      case "version_conflict":
        return versionConflictResponse(result.value.conflict, projectRenameConflictPolicy, context);
      case "failed":
        return problemResponse(result.value.reason === "invalid_input"
          ? "invalid_request" : "operation_outcome_unknown", context);
      case "saved":
      case "replayed": {
        const response = projectRenamePublicResult(result.value);
        if (!response) return problemResponse("operation_outcome_unknown", context);
        return jsonResponse(200, response, context, { etag: rowEtag(response.current.row_version) });
      }
    }
  });
  return { patch };
}
