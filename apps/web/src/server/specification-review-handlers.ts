import { specificationDecisionSchema, specificationSubmitSchema } from "@app-planet/core";
import { createRouteHandler, jsonResponse, problemResponse, readJsonBody,
  type ResponseContext, type RouteOptions } from "./http.ts";
import { readIdempotencyKey } from "./idempotency.ts";
import { decideSpecification, listSpecificationReviews, readSpecificationReview,
  readSpecificationStatus, submitSpecification } from "./specification-review.ts";

function respond(value: { outcome: string }, context: ResponseContext, write: boolean) {
  const codes = {
    denied: "forbidden", not_found: "not_found", invalid_input: "invalid_request",
    idempotency_conflict: "idempotency_key_reuse", version_conflict: "version_conflict",
    evidence_missing: "project_requirements_missing",
  } as const;
  if (value.outcome in codes) return problemResponse(codes[value.outcome as keyof typeof codes], context);
  if (value.outcome === "dependency_failure") {
    return problemResponse(write ? "operation_outcome_unknown" : "dependency_unavailable", context);
  }
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > 256 * 1024) {
    return problemResponse(write ? "operation_outcome_unknown" : "dependency_unavailable", context);
  }
  return jsonResponse(200, value, context);
}
export function createSpecificationReviewHandlers(options: Pick<RouteOptions, "resolver" | "log" | "requireSameOrigin">) {
  const read = createRouteHandler({
    ...options, route: "specification_status", methods: ["GET"], requireSameOrigin: false,
  }, async ({ session, routeParams, ...context }) =>
    respond(await readSpecificationStatus(session, routeParams.id), context, false));
  const list = createRouteHandler({
    ...options, route: "specification_list", methods: ["GET"], requireSameOrigin: false,
  }, async ({ session, request, ...context }) => {
    const params = new URL(request.url).searchParams;
    if ([...params.keys()].some((key) => params.getAll(key).length !== 1)) {
      return problemResponse("invalid_request", context);
    }
    return respond(await listSpecificationReviews(session, Object.fromEntries(params)), context, false);
  });
  const detail = createRouteHandler({
    ...options, route: "specification_detail", methods: ["GET"], requireSameOrigin: false,
  }, async ({ session, routeParams, ...context }) =>
    respond(await readSpecificationReview(session, routeParams.id), context, false));
  const mutate = (kind: "submit" | "decide") => createRouteHandler({
    ...options, route: `specification_${kind}`, methods: ["POST"],
  }, async ({ request, session, routeParams, ...context }) => {
    const key = readIdempotencyKey(request.headers);
    if (!key.ok) return problemResponse(key.code, context);
    const body = await readJsonBody(request, (value) => {
      const parsed = (kind === "submit" ? specificationSubmitSchema : specificationDecisionSchema).safeParse(value);
      return parsed.success ? parsed.data : null;
    }, 16 * 1024);
    if (!body.ok) return problemResponse(body.code, context);
    const result = kind === "submit"
      ? await submitSpecification(session, routeParams.id, body.data, key.key)
      : await decideSpecification(session, routeParams.id, body.data, key.key);
    return respond(result, context, true);
  });
  return { read, list, detail, submit: mutate("submit"), decide: mutate("decide") };
}
