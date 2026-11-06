import { z } from "zod";
import { schoolCreateSchema, schoolDetailSchema, schoolListSchema, schoolQuerySchema,
  schoolReceiptSchema } from "@app-planet/core";
import { createRouteHandler, jsonResponse, problemResponse, readJsonBody,
  type TrustedSession, type ResponseContext, type RouteOptions } from "../http.ts";
import { readIdempotencyKey } from "../idempotency.ts";
import { actorSql, record, validActor } from "../stage-drafts.ts";

const failure = z.object({
  outcome: z.enum(["denied", "invalid_input", "not_found", "idempotency_conflict"]),
}).strict();
async function execute<T>(session: TrustedSession, sql: string, values: string[], schema: z.ZodType<T>) {
  try {
    // GET 只用 write transaction 取得資格鎖；沒有資料異動，不能用唯讀交易跳過鎖。
    return await session.write.runTransaction(async (q) => {
      const { rows } = await q.query(`WITH actor AS MATERIALIZED (SELECT ${actorSql(false)})
        SELECT actor.*,CASE WHEN actor.actor_valid AND actor.subject IS NOT NULL THEN ${sql}
        ELSE jsonb_build_object('outcome','invalid_context') END result FROM actor`, values);
      if (rows.length !== 1 || !record(rows[0]) || !validActor(rows[0])) throw new Error("invalid_school_actor");
      const parsed = z.union([schema, failure]).safeParse(rows[0].result);
      if (!parsed.success) throw new Error("invalid_school_result");
      return parsed.data;
    });
  } catch { return { outcome: "dependency_failure" } as const; }
}
function respond(value: { outcome: string }, context: ResponseContext, create = false) {
  switch (value.outcome) {
    case "denied": return problemResponse("forbidden", context);
    case "invalid_input": return problemResponse("invalid_request", context);
    case "not_found": return problemResponse("not_found", context);
    case "idempotency_conflict": return problemResponse("idempotency_key_reuse", context);
    case "dependency_failure": return problemResponse(
      create ? "operation_outcome_unknown" : "dependency_unavailable", context);
    default: return jsonResponse(value.outcome === "created" ? 201 : 200, value, context,
      value.outcome === "replayed" ? { "idempotent-replay": "true" } : {});
  }
}
export function createSchoolHandlers(options: Pick<RouteOptions, "resolver" | "log" | "requireSameOrigin">) {
  const list = createRouteHandler({ ...options, route: "admin_school_list", methods: ["GET"], requireSameOrigin: false },
    async ({ session, request, ...context }) => {
      const params = new URL(request.url).searchParams;
      if ([...params.keys()].some((key) => params.getAll(key).length !== 1)) return problemResponse("invalid_request", context);
      const parsed = schoolQuerySchema.safeParse(Object.fromEntries(params));
      if (!parsed.success) return problemResponse("invalid_request", context);
      const result = await execute(session, "app.list_admin_schools(nullif($1,'')::uuid)",
        [parsed.data.after ?? ""], schoolListSchema);
      if ("items" in result && parsed.data.after && result.items.some((item) =>
        item.id.toLowerCase() <= parsed.data.after!.toLowerCase())) return problemResponse("dependency_unavailable", context);
      return respond(result, context);
    });
  const detail = createRouteHandler({ ...options, route: "admin_school_detail", methods: ["GET"], requireSameOrigin: false },
    async ({ request, session, routeParams, ...context }) => {
      if (new URL(request.url).search || !z.uuid().safeParse(routeParams.id).success) return problemResponse("invalid_request", context);
      const result = await execute(session, "app.read_admin_school($1::uuid)", [routeParams.id!], schoolDetailSchema);
      if ("school" in result && result.school.id.toLowerCase() !== routeParams.id!.toLowerCase())
        return problemResponse("dependency_unavailable", context);
      return respond(result, context);
    });
  const create = createRouteHandler({ ...options, route: "admin_school_create", methods: ["POST"] },
    async ({ request, session, ...context }) => {
      if (new URL(request.url).search) return problemResponse("invalid_request", context);
      const key = readIdempotencyKey(request.headers);
      if (!key.ok) return problemResponse(key.code, context);
      const body = await readJsonBody(request, (input) => input, 16 * 1024);
      if (!body.ok) return problemResponse(body.code, context);
      const parsed = schoolCreateSchema.safeParse(body.data);
      if (!parsed.success) return problemResponse("invalid_request", context);
      const result = await execute(session, "app.register_school($1::text,$2::uuid)",
        [parsed.data.label, key.key], schoolReceiptSchema);
      if ("label" in result && result.label !== parsed.data.label) return problemResponse("operation_outcome_unknown", context);
      return respond(result, context, true);
    });
  return { list, detail, create };
}
