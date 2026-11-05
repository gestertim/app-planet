import { z } from "zod";
import {
  teacherViewAuditCursorSchema, teacherViewAuditPositionSchema, teacherViewAuditQuerySchema,
  teacherViewAuditItemSchema, teacherViewAuditPageSchema, type TeacherViewAuditPage,
} from "@app-planet/core";
import {
  createRouteHandler, jsonResponse, problemResponse, type RouteOptions, type TrustedSession,
} from "../http.ts";

const databaseResultSchema = z.union([
  z.strictObject({
    outcome: z.literal("found"),
    items: z.array(teacherViewAuditItemSchema).max(50),
    next: teacherViewAuditPositionSchema.nullable(),
  }),
  z.strictObject({ outcome: z.enum(["denied", "invalid_input", "identity_unavailable"]) }),
]);
type AuditResult = TeacherViewAuditPage | {
  outcome: "denied" | "invalid_input" | "identity_unavailable" | "dependency_failure";
};

export function parseTeacherViewAuditQuery(params: URLSearchParams) {
  if ([...params.keys()].some((key) => params.getAll(key).length !== 1)) return null;
  const parsed = teacherViewAuditQuerySchema.safeParse(Object.fromEntries(params));
  if (!parsed.success) return null;
  const query = parsed.data;
  let position: z.infer<typeof teacherViewAuditPositionSchema> | null = null;
  if (query.after) {
    try {
      const bytes = Buffer.from(query.after, "base64url");
      if (bytes.toString("base64url") !== query.after) return null;
      const cursor = teacherViewAuditCursorSchema.safeParse(JSON.parse(bytes.toString("utf8")));
      if (!cursor.success || cursor.data.teacher_id !== (query.teacher_id ?? null)
        || cursor.data.student_id !== (query.student_id ?? null)) return null;
      position = cursor.data.position;
    } catch {
      return null;
    }
  }
  return { ...query, position };
}

export async function readAdminTeacherViews(session: TrustedSession, params: URLSearchParams): Promise<AuditResult> {
  const query = parseTeacherViewAuditQuery(params);
  try {
    return await session.write.runTransaction(async (db) => {
      // Even malformed queries reach the DB authorization lock before invalid_input.
      const result = await db.query(`SELECT app.read_admin_teacher_views(
        nullif($1,'')::uuid,nullif($2,'')::uuid,nullif($3,'')::timestamptz,nullif($4,'')::uuid,
        $5::integer,$6::boolean) AS result`,
      [query?.teacher_id ?? "", query?.student_id ?? "", query?.position?.at ?? "",
        query?.position?.id ?? "", query?.limit ?? 20, query !== null]);
      if (result.rows.length !== 1) throw new Error("invalid_teacher_view_audit_row");
      const row = z.strictObject({ result: databaseResultSchema }).parse(result.rows[0]);
      if (row.result.outcome !== "found") return row.result;
      if (!query) throw new Error("invalid_teacher_view_audit_query_result");
      const next = row.result.next;
      return teacherViewAuditPageSchema.parse({
        outcome: "found", items: row.result.items,
        next_cursor: next === null ? null : Buffer.from(JSON.stringify({
          v: 1, teacher_id: query.teacher_id ?? null, student_id: query.student_id ?? null, position: next,
        })).toString("base64url"),
      });
    });
  } catch {
    return { outcome: "dependency_failure" };
  }
}

export function createTeacherViewAuditHandler(options: Pick<RouteOptions, "resolver" | "log">) {
  return createRouteHandler({
    ...options, route: "admin_teacher_view_audit", methods: ["GET"], requireSameOrigin: false,
  }, async ({ request, session, ...context }) => {
    const result = await readAdminTeacherViews(session, new URL(request.url).searchParams);
    if (result.outcome === "denied") return problemResponse("forbidden", context);
    if (result.outcome === "invalid_input") return problemResponse("invalid_request", context);
    if (result.outcome !== "found") return problemResponse("dependency_unavailable", context);
    return jsonResponse(200, result, context);
  });
}
