import { describe, expect, it } from "vitest";
import { bindingCreateSchema, bindingEndSchema, bindingIntentSchema, bindingListSchema,
  bindingQuerySchema, bindingReceiptSchema } from "@app-planet/core";
const teacher = "10000000-0000-4000-8000-000000000001";
const student = "10000000-0000-4000-8000-000000000002";
describe("T076 T-1／T-2 有界契約", () => {
  it("正式 body 嚴格且不接受 caller role／school／actor", () => {
    expect(bindingCreateSchema.safeParse({ teacher_id: teacher, student_id: student }).success).toBe(true);
    for (const extra of [{ role: "admin" }, { school_id: teacher }, { actor_id: teacher }, { approved: true }]) {
      expect(bindingCreateSchema.safeParse({ teacher_id: teacher, student_id: student, ...extra }).success).toBe(false);
    }
    expect(bindingEndSchema.safeParse({ end_reason: "保留合法原文", state: "ended" }).success).toBe(false);
  });
  it.each(["", " \u3000\u00a0", "\u2028\ufeff", "字\u0001", "字\u007f", "字\u009f", "\ud800", "字".repeat(2001)])(
    "解除理由拒絕不合法文字 %#", (reason) => {
      expect(bindingEndSchema.safeParse({ end_reason: reason }).success).toBe(false);
    });
  it("合法 Unicode 理由不靜默改寫，工程上限沿既有文字防護", () => {
    const reason = "\u3000 合法原文 😀 \u00a0";
    expect(bindingEndSchema.parse({ end_reason: reason }).end_reason).toBe(reason);
    expect(bindingEndSchema.safeParse({ end_reason: "😀".repeat(2000) }).success).toBe(true);
  });
  it("UUID key、確切對象及原本文可持久恢復，無平行任意操作", () => {
    expect(bindingIntentSchema.safeParse({ operation: "end", target: teacher, key: student,
      body: { end_reason: "明確解除" } }).success).toBe(true);
    expect(bindingIntentSchema.safeParse({ operation: "end", target: teacher, key: "任意文字",
      body: { end_reason: "明確解除" } }).success).toBe(false);
    expect(bindingIntentSchema.safeParse({ operation: "end", key: student, body: { end_reason: "解除" } }).success).toBe(false);
  });
  it("receipt 為原操作而非目前授權，建立與解除狀態不可混淆", () => {
    const receipt = { outcome: "replayed", operation: "create", state: "active",
      binding_id: teacher, operated_at: "2026-11-04T08:00:00.000000Z" };
    expect(bindingReceiptSchema.safeParse(receipt).success).toBe(true);
    expect(bindingReceiptSchema.safeParse({ ...receipt, state: "ended" }).success).toBe(false);
    expect(bindingReceiptSchema.safeParse({ ...receipt, current_approval: true }).success).toBe(false);
  });
  it("候選查詢及清單有明確分頁、角色與最小投影", () => {
    expect(bindingQuerySchema.safeParse({ kind: "students", teacher_id: teacher, school_id: student }).success).toBe(true);
    expect(bindingQuerySchema.safeParse({ kind: "students" }).success).toBe(false);
    expect(bindingQuerySchema.safeParse({ kind: "teachers", teacher_id: teacher }).success).toBe(false);
    expect(bindingQuerySchema.safeParse({ kind: "bindings", after: "0" }).success).toBe(false);
    expect(bindingQuerySchema.safeParse({ kind: "bindings", limit: "unlimited" }).success).toBe(false);
    const candidate = { id: teacher, account_id: teacher, label: "合成教師", role: "teacher",
      qualified: true, school_id: student, school_label: "合成學校" };
    const page = { outcome: "found", kind: "teachers", items: [candidate], next_cursor: null };
    expect(bindingListSchema.safeParse(page).success).toBe(true);
    expect(bindingListSchema.safeParse({ ...page, items: [{ ...candidate, email: "private@example.invalid" }] }).success).toBe(false);
    expect(bindingListSchema.safeParse({ ...page, items: Array.from({ length: 21 }, () => candidate) }).success).toBe(false);
  });
});
