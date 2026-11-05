import { describe, expect, it } from "vitest";
import { teacherViewAuditPageSchema, teacherViewAuditQuerySchema } from "@app-planet/core";
import { parseTeacherViewAuditQuery } from "../../apps/web/src/server/admin/teacher-view-audit.ts";

const teacher = "a0000000-0000-4000-8000-000000000001";
const student = "a0000000-0000-4000-8000-000000000002";
const at = "2026-11-05T00:00:00.123456Z";
const cursor = (extra = {}) => Buffer.from(JSON.stringify({
  v: 1, teacher_id: teacher, student_id: null, position: { at, id: student }, ...extra,
})).toString("base64url");

describe("T-5 strict query／DTO", () => {
  it("uses explicit engineering page bounds, canonical UUID filters, and rejects ambiguous inputs", () => {
    expect(teacherViewAuditQuerySchema.parse({})).toEqual({ limit: 20 });
    expect(parseTeacherViewAuditQuery(new URLSearchParams({ teacher_id: teacher.toUpperCase(), limit: "50" })))
      .toMatchObject({ teacher_id: teacher, limit: 50 });
    for (const text of [
      "teacher_id=bad", "student_id=", "student_id=00000000-0000-0000-0000-00000000000g",
      "limit=51", "limit=0", "limit=1.5", "limit=2e1", "limit=020", "limit=", "limit=+1",
      "role=admin", `teacher_id=${teacher}&teacher_id=${teacher}`, "after=bad!",
      "after=e30", "after=", "limit=20&limit=20",
    ]) expect(parseTeacherViewAuditQuery(new URLSearchParams(text)), text).toBeNull();
  });
  it("binds cursor to both filters and retains microsecond tie-breaking", () => {
    expect(parseTeacherViewAuditQuery(new URLSearchParams({ teacher_id: teacher, after: cursor() })))
      .toMatchObject({ position: { at, id: student } });
    const invalidCursors: Record<string, string>[] = [
      { after: cursor() },
      { teacher_id: student, after: cursor() },
      { teacher_id: teacher, student_id: student, after: cursor() },
      { teacher_id: teacher, after: cursor({ unexpected: true }) },
      { teacher_id: teacher, after: cursor({ position: { at: "infinity", id: student } }) },
      { teacher_id: teacher, after: cursor({ position: { at: "2026-02-30T00:00:00.000000Z", id: student } }) },
    ];
    for (const params of invalidCursors) expect(parseTeacherViewAuditQuery(new URLSearchParams(params))).toBeNull();
  });
  it("allows only labels, timestamp and pagination; empty success is explicit", () => {
    const item = { teacher_label: "教師代號甲", student_label: "學生代號乙", viewed_at: at };
    const page = { outcome: "found", items: [item], next_cursor: null };
    expect(teacherViewAuditPageSchema.parse(page)).toEqual(page);
    expect(teacherViewAuditPageSchema.parse({ ...page, items: [] }).items).toEqual([]);
    for (const key of ["id", "actor_aid", "subject_aid", "email", "meta", "content", "object_ref",
      "requirements", "draft", "task", "feedback", "identity_map", "secret"]) {
      expect(teacherViewAuditPageSchema.safeParse({
        ...page, items: [{ ...item, [key]: "not-allowed" }],
      }).success).toBe(false);
    }
    expect(teacherViewAuditPageSchema.safeParse({ ...page, extra: true }).success).toBe(false);
    expect(teacherViewAuditPageSchema.safeParse({ ...page, next_cursor: undefined }).success).toBe(false);
  });
});
