import { describe, expect, it } from "vitest";
import { membershipCreateSchema, membershipEndSchema, membershipIntentSchema,
  membershipListSchema, membershipQuerySchema, membershipReceiptSchema } from "@app-planet/core";
const teacher = "10000000-0000-4000-8000-000000000001";
const school = "10000000-0000-4000-8000-000000000002";
describe("T076 教師學校歸屬有界 DTO", () => {
  it("strict body 不接受 owner／角色／批准／state／epoch／時間", () => {
    const body = { teacher_id: teacher, school_id: school };
    expect(membershipCreateSchema.parse(body)).toEqual(body);
    for (const extra of ["owner", "role", "approved", "state", "epoch", "created_at", "actor_id"]) {
      expect(membershipCreateSchema.safeParse({ ...body, [extra]: teacher }).success).toBe(false);
      expect(membershipEndSchema.safeParse({ [extra]: teacher }).success).toBe(false);
    }
    expect(membershipEndSchema.parse({})).toEqual({});
    expect(membershipIntentSchema.safeParse({ operation: "end", key: school, target: teacher, body: {} }).success).toBe(true);
    expect(membershipIntentSchema.safeParse({ operation: "end", key: "new-key", target: teacher, body: {} }).success).toBe(false);
  });
  it("分頁不接受額外 scope 或任意名額；display_label 不回傳 email", () => {
    expect(membershipQuerySchema.safeParse({ kind: "schools", after: school }).success).toBe(true);
    for (const extra of [{ limit: "unlimited" }, { role: "admin" }, { teacher_id: teacher }, { after: "offset" }])
      expect(membershipQuerySchema.safeParse({ kind: "teachers", ...extra }).success).toBe(false);
    const row = { id: teacher, display_label: "合成教師", qualified: true };
    const page = { outcome: "found", kind: "teachers", items: [row], next_cursor: school };
    expect(membershipListSchema.safeParse(page).success).toBe(true);
    expect(membershipListSchema.safeParse({ ...page, items: [{ ...row, email: "not-exported" }] }).success).toBe(false);
    expect(membershipListSchema.safeParse({ ...page, items: Array(21).fill(row) }).success).toBe(false);
  });
  it("receipt 只表示原異動，current 或批准不能混入", () => {
    const receipt = { outcome: "replayed", operation: "create", membership_id: teacher,
      teacher_id: teacher, school_id: school, state: "active", operated_at: "2026-11-05T01:00:00.000000Z" };
    expect(membershipReceiptSchema.safeParse(receipt).success).toBe(true);
    for (const extra of [{ current: "active" }, { approved: true }, { state: "ended" }])
      expect(membershipReceiptSchema.safeParse({ ...receipt, ...extra }).success).toBe(false);
  });
});
