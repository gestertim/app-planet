import { z } from "zod";
import { bindingCreateSchema, bindingEndSchema, bindingListSchema, bindingQuerySchema,
  bindingReceiptSchema } from "@app-planet/core";
import type { AuthorizationQuery } from "../authorization.ts";
import type { TrustedSession } from "../http.ts";
import { createRouteHandler, jsonResponse, problemResponse, readJsonBody,
  type ResponseContext, type RouteOptions } from "../http.ts";
import { readIdempotencyKey } from "../idempotency.ts";
import { actorSql, record, validActor } from "../stage-drafts.ts";

const failure = z.object({ outcome: z.enum(["denied", "invalid_input", "not_found", "idempotency_conflict",
  "binding_exists", "binding_ended", "teacher_not_eligible", "student_not_approved", "school_not_eligible",
  "teacher_school_mismatch", "invalid_pair"]) }).strict();

async function execute<T>(session: TrustedSession, write: boolean, sql: string, values: string[], schema: z.ZodType<T>) {
  const run = async (q: AuthorizationQuery) => {
    const { rows } = await q.query(`WITH actor AS MATERIALIZED (SELECT ${actorSql(!write)})
      SELECT actor.*,CASE WHEN actor.actor_valid AND actor.subject IS NOT NULL THEN ${sql}
      ELSE jsonb_build_object('outcome','invalid_context') END result FROM actor`, values);
    if (rows.length !== 1 || !record(rows[0]) || !validActor(rows[0])) throw new Error("invalid_binding_actor");
    const parsed = z.union([schema, failure]).safeParse(rows[0].result);
    if (!parsed.success) throw new Error("invalid_binding_result");
    return parsed.data;
  };
  try { return write ? await session.write.runTransaction(run) : await session.read.runReadOnly(run); }
  catch { return { outcome: "dependency_failure" } as const; }
}
function respond(value: { outcome: string }, context: ResponseContext, write: boolean) {
  const codes = { denied: "forbidden", invalid_input: "invalid_request", not_found: "not_found",
    idempotency_conflict: "idempotency_key_reuse", invalid_pair: "invalid_binding_pair",
    binding_exists: "binding_exists", binding_ended: "binding_ended", teacher_not_eligible: "teacher_not_eligible",
    student_not_approved: "student_not_approved", school_not_eligible: "school_not_eligible",
    teacher_school_mismatch: "teacher_school_mismatch" } as const;
  if (value.outcome in codes) return problemResponse(codes[value.outcome as keyof typeof codes], context);
  if (value.outcome === "dependency_failure") return problemResponse(
    write ? "operation_outcome_unknown" : "dependency_unavailable", context);
  return jsonResponse(value.outcome === "created" ? 201 : 200, value, context,
    value.outcome === "replayed" ? { "idempotent-replay": "true" } : {});
}
export function createBindingHandlers(options: Pick<RouteOptions, "resolver" | "log" | "requireSameOrigin">) {
  const list = createRouteHandler({ ...options, route: "admin_binding_list", methods: ["GET"], requireSameOrigin: false },
    async ({ session, request, ...context }) => {
      const params = new URL(request.url).searchParams;
      if ([...params.keys()].some((key) => params.getAll(key).length !== 1)) return problemResponse("invalid_request", context);
      const parsed = bindingQuerySchema.safeParse(Object.fromEntries(params));
      if (!parsed.success) return problemResponse("invalid_request", context);
      const p = parsed.data;
      return respond(await execute(session, false,
        "app.list_binding_options($1::text,nullif($2,'')::uuid,nullif($3,'')::uuid,nullif($4,'')::uuid)",
        [p.kind, p.after ?? "", p.teacher_id ?? "", p.school_id ?? ""], bindingListSchema), context, false);
    });
  const mutate = (end: boolean) => createRouteHandler({
    ...options, route: end ? "admin_binding_end" : "admin_binding_create", methods: [end ? "DELETE" : "POST"],
  }, async ({ request, session, routeParams, ...context }) => {
    if (new URL(request.url).search || (end && !z.uuid().safeParse(routeParams.id).success)) {
      return problemResponse("invalid_request", context);
    }
    const key = readIdempotencyKey(request.headers);
    if (!key.ok) return problemResponse(key.code, context);
    const body = await readJsonBody(request, (input) => input, 16 * 1024);
    if (!body.ok) return problemResponse(body.code, context);
    if (end) {
      const parsed = bindingEndSchema.safeParse(body.data);
      if (!parsed.success) return problemResponse("invalid_request", context);
      return respond(await execute(session, true, "app.end_teacher_student_binding($1::uuid,$2::text,$3::uuid)",
        [routeParams.id, parsed.data.end_reason, key.key], bindingReceiptSchema), context, true);
    }
    const parsed = bindingCreateSchema.safeParse(body.data);
    if (!parsed.success) return problemResponse("invalid_request", context);
    return respond(await execute(session, true, "app.create_teacher_student_binding($1::uuid,$2::uuid,$3::uuid)",
      [parsed.data.teacher_id, parsed.data.student_id, key.key], bindingReceiptSchema), context, true);
  });
  return { list, create: mutate(false), end: mutate(true) };
}
