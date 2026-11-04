import { z } from "zod";
import {
  pendingTeacherSchema, staffReviewBodySchema, staffReviewResultSchema,
} from "@app-planet/core";
import type { AuthorizationContext } from "../authorization.ts";
import type { ProjectCreationContext } from "../projects.ts";
import { createAuthPrincipalResolver, readAuthConfiguration } from "../auth-principal.ts";
import {
  createRouteHandler, jsonResponse, problemResponse, readJsonBody, readRowIfMatch, rowEtag,
  type TrustedPrincipalResolver,
} from "../http.ts";
import { readIdempotencyKey } from "../idempotency.ts";

const listedSchema = z.strictObject({ outcome: z.literal("listed"), items: z.array(pendingTeacherSchema).max(51) });
const failedSchema = z.strictObject({
  outcome: z.enum(["denied", "unavailable", "invalid_input", "invalid_target", "version_conflict", "idempotency_key_reuse", "not_eligible"]),
});
const reviewedSchema = z.strictObject({
  outcome: z.enum(["reviewed", "replayed"]), result: staffReviewResultSchema,
});
const mutationSchema = z.union([reviewedSchema, failedSchema]);
const resultRowSchema = z.object({ result: z.unknown() });

function localReviewEnabled(): boolean {
  const config = readAuthConfiguration();
  return process.env.APP_PLANET_STAFF_REVIEW_MODE === "isolated-local-test" &&
    process.env.APP_PLANET_ENV === "isolated-local-test" && process.env.NODE_ENV !== "production" &&
    process.env.APP_PLANET_LOCAL_AUTH === "1" && config.ok &&
    [config.value.authOrigin, config.value.appOrigin].every((origin) =>
      ["localhost", "127.0.0.1"].includes(new URL(origin).hostname));
}

export async function listPendingTeachers(context: AuthorizationContext, after: string | null) {
  try {
    const { rows } = await context.runReadOnly((query) => query.query(
      "SELECT app.list_pending_teachers(nullif($1,'')::uuid) AS result", [after ?? ""],
    ));
    if (rows.length !== 1) return { outcome: "unavailable" } as const;
    const row = resultRowSchema.safeParse(rows[0]);
    const parsed = z.union([listedSchema, failedSchema]).safeParse(row.success ? row.data.result : null);
    if (!parsed.success) return { outcome: "unavailable" } as const;
    if (parsed.data.outcome !== "listed") return { outcome: parsed.data.outcome === "denied" ? "denied" : "unavailable" } as const;
    const items = parsed.data.items.slice(0, 50);
    return {
      outcome: "listed" as const,
      page: { items, next_cursor: parsed.data.items.length > 50 ? items[49]!.id : null },
    };
  } catch {
    return { outcome: "unavailable" } as const;
  }
}

export async function reviewPendingTeacher(
  context: ProjectCreationContext, target: string, decision: "approved" | "rejected", version: number, key: string,
) {
  try {
    const { rows } = await context.runTransaction((query) => query.query(
      "SELECT app.review_pending_teacher($1::uuid,$2::text,$3::integer,$4::uuid) AS result",
      [target, decision, version, key],
    ));
    const row = resultRowSchema.safeParse(rows.length === 1 ? rows[0] : null);
    const parsed = mutationSchema.safeParse(row.success ? row.data.result : null);
    return parsed.success ? parsed.data : { outcome: "unknown" } as const;
  } catch {
    return { outcome: "unknown" } as const;
  }
}

export function createTeacherReviewHandlers(resolver: TrustedPrincipalResolver = createAuthPrincipalResolver()) {
  const list = createRouteHandler({ route: "pending_teachers", methods: ["GET"], resolver }, async ({ request, session, ...context }) => {
    if (!localReviewEnabled()) return problemResponse("dependency_unavailable", context);
    const params = new URL(request.url).searchParams;
    if ([...params.keys()].some((key) => key !== "after") || params.getAll("after").length > 1) {
      return problemResponse("invalid_request", context);
    }
    const after = params.get("after");
    if (after !== null && !z.uuid().safeParse(after).success) return problemResponse("invalid_request", context);
    const result = await listPendingTeachers(session.read, after);
    if (result.outcome !== "listed") return problemResponse(
      result.outcome === "denied" ? "forbidden" : "dependency_unavailable", context,
    );
    return jsonResponse(200, result.page, context, { vary: "cookie" });
  });
  const review = createRouteHandler({
    route: "review_teacher", methods: ["POST"], resolver, requireSameOrigin: true,
  }, async ({ request, session, routeParams, ...context }) => {
    if (!localReviewEnabled()) return problemResponse("dependency_unavailable", context);
    const target = z.uuid().safeParse(routeParams.id);
    if (!target.success || new URL(request.url).search) return problemResponse("invalid_request", context);
    const key = readIdempotencyKey(request.headers);
    if (!key.ok) return problemResponse(key.code, context);
    const version = readRowIfMatch(request.headers);
    if (!version.ok) return problemResponse(version.code, context);
    if (request.headers.has("if-none-match")) return problemResponse("invalid_if_match", context);
    const body = await readJsonBody(request, (value) => value, 1024);
    if (!body.ok) return problemResponse(body.code, context);
    const parsed = staffReviewBodySchema.safeParse(body.data);
    if (!parsed.success) return problemResponse(
      parsed.error.issues.some((issue) => issue.code === "unrecognized_keys") ? "unknown_field" : "invalid_request", context,
    );
    const result = await reviewPendingTeacher(session.write, target.data, parsed.data.decision, version.version, key.key);
    switch (result.outcome) {
      case "reviewed":
      case "replayed": return jsonResponse(200, result.result, context, {
        etag: rowEtag(result.result.row_version),
        ...(result.outcome === "replayed" ? { "idempotent-replay": "true" } : {}),
      });
      case "denied": return problemResponse("forbidden", context);
      case "invalid_target": return problemResponse("not_found", context);
      case "version_conflict": return problemResponse("teacher_review_conflict", context);
      case "not_eligible": return problemResponse("teacher_not_verified", context);
      case "idempotency_key_reuse": return problemResponse("idempotency_key_reuse", context);
      case "invalid_input": return problemResponse("invalid_request", context);
      case "unavailable": return problemResponse("dependency_unavailable", context);
      case "unknown": return problemResponse("operation_outcome_unknown", context);
    }
  });
  return { list, review };
}
