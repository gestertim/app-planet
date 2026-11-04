import {
  teacherProjectDetailSchema,
  teacherProjectPageSchema,
  teacherResourcePageQuerySchema,
  teacherStageDraftSchema,
  teacherStudentPageSchema,
  teacherTaskPageResultSchema,
  type TeacherProjectDetail,
  type TeacherProjectPage,
  type TeacherStageDraft,
  type TeacherStudentPage,
  type TeacherTaskPageResult,
} from "@app-planet/core";
import type { TrustedSession } from "./http.ts";

type ReadResult<T> =
  | { outcome: "found"; value: T }
  | { outcome: "not_found" | "invalid_input" | "dependency_failure" };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function callReader<T>(
  session: TrustedSession,
  sql: string,
  values: string[],
  schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } },
): Promise<ReadResult<T>> {
  try {
    return await session.write.runTransaction(async (query) => {
      const { rows } = await query.query(sql, values);
      if (rows.length !== 1 || !isRecord(rows[0]) || !Object.hasOwn(rows[0], "result")) {
        return { outcome: "dependency_failure" };
      }
      const result = rows[0].result;
      if (isRecord(result) && result.outcome === "not_found") return { outcome: "not_found" };
      if (isRecord(result) && result.outcome === "invalid_input") return { outcome: "invalid_input" };
      const parsed = schema.safeParse(result);
      return parsed.success
        ? { outcome: "found", value: parsed.data }
        : { outcome: "dependency_failure" };
    });
  } catch {
    return { outcome: "dependency_failure" };
  }
}

export async function readTeacherStudents(
  session: TrustedSession,
  query: unknown,
): Promise<ReadResult<TeacherStudentPage>> {
  const parsed = teacherResourcePageQuerySchema.safeParse(query);
  if (!parsed.success) return { outcome: "invalid_input" };
  return callReader(session, "SELECT app.read_teacher_students(nullif($1,'')::uuid,$2::integer) AS result",
    [parsed.data.after ?? "", String(parsed.data.limit)], teacherStudentPageSchema);
}

export async function readTeacherStudentProjects(
  session: TrustedSession,
  studentId: string,
  query: unknown,
): Promise<ReadResult<TeacherProjectPage>> {
  const id = parseUuid(studentId);
  const parsed = teacherResourcePageQuerySchema.safeParse(query);
  if (!id || !parsed.success) return { outcome: "invalid_input" };
  return callReader(session,
    "SELECT app.read_teacher_student_projects($1::uuid,nullif($2,'')::uuid,$3::integer) AS result",
    [id, parsed.data.after ?? "", String(parsed.data.limit)], teacherProjectPageSchema);
}

export async function readTeacherProject(
  session: TrustedSession,
  studentId: string,
  projectId: string,
): Promise<ReadResult<TeacherProjectDetail>> {
  const student = parseUuid(studentId);
  const project = parseUuid(projectId);
  if (!student || !project) return { outcome: "invalid_input" };
  return callReader(session, "SELECT app.read_teacher_project($1::uuid,$2::uuid) AS result",
    [student, project], teacherProjectDetailSchema);
}

export async function readTeacherStageDraft(
  session: TrustedSession,
  studentId: string,
  projectId: string,
  stage: string,
): Promise<ReadResult<TeacherStageDraft>> {
  const student = parseUuid(studentId);
  const project = parseUuid(projectId);
  if (!student || !project) return { outcome: "invalid_input" };
  return callReader(session,
    "SELECT app.read_teacher_stage_draft($1::uuid,$2::uuid,$3::text) AS result",
    [student, project, stage], teacherStageDraftSchema);
}

export async function readTeacherProjectTasks(
  session: TrustedSession,
  studentId: string,
  projectId: string,
  query: unknown,
): Promise<ReadResult<TeacherTaskPageResult>> {
  const student = parseUuid(studentId);
  const project = parseUuid(projectId);
  const parsed = teacherResourcePageQuerySchema.safeParse(query);
  if (!student || !project || !parsed.success) return { outcome: "invalid_input" };
  return callReader(session,
    "SELECT app.read_teacher_project_tasks($1::uuid,$2::uuid,nullif($3,'')::uuid,$4::integer) AS result",
    [student, project, parsed.data.after ?? "", String(parsed.data.limit)], teacherTaskPageResultSchema);
}

function parseUuid(value: string): string | null {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
    ? value.toLowerCase()
    : null;
}

export type TeacherResourcePageQuery = {
  readonly after?: string;
  readonly limit: number;
};
