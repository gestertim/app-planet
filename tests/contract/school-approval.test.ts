import { describe, expect, it } from "vitest";
import { schoolCreateSchema, schoolDetailSchema, schoolListSchema, schoolReceiptSchema } from "@app-planet/core";
const id = "10000000-0000-4000-8000-000000000001";
const row = { id, label: "合成學校", approval_state: "unconfirmed", approval_epoch: 0, valid_until: null };
describe("L-1／L-3 有界契約；不涵蓋 L-2", () => {
  it.each([null, {}, { label: 1 }, { label: "" }, { label: " \t\n　\u00a0\ufeff" }, { label: "A\0B" },
    ...["approved", "approval_epoch", "valid_until", "current_doc_version", "actor", "role"].map((key) => ({ label: "校", [key]: true }))])(
    "拒絕非法型別、空名稱及額外資格欄位 %#", (input) => expect(schoolCreateSchema.safeParse(input).success).toBe(false));
  it("不去空白、不擅自新增 120 字名稱上限或同名政策", () => {
    for (const label of [" 學校 ", "校".repeat(121)]) expect(schoolCreateSchema.parse({ label })).toEqual({ label });
  });
  it("strict 投影及唯一排序／精確 next cursor", () => {
    expect(schoolListSchema.parse({ outcome: "found", items: [], next_cursor: null }).items).toEqual([]);
    for (const input of [
      { outcome: "found", items: [row, row], next_cursor: null },
      { outcome: "found", items: [], next_cursor: id },
      { outcome: "found", items: [{ ...row, secret: "hidden" }], next_cursor: null },
    ]) expect(schoolListSchema.safeParse(input).success).toBe(false);
    const detail = { outcome: "found", school: { ...row, current_doc_version: null, verification_history: "not_available", last_change: null } };
    expect(schoolDetailSchema.safeParse(detail).success).toBe(true);
    expect(schoolDetailSchema.safeParse({ ...detail, school: { ...detail.school, verified_at: "created_at" } }).success).toBe(false);
  });
  it("成功 receipt 不能暗示批准、期限或假文件", () => {
    const receipt = { outcome: "created", operation: "create", school_id: id, label: "校",
      approval_state: "unconfirmed", approval_epoch: 0, valid_until: null, current_doc_version: null,
      operated_at: "2026-11-06T00:00:00.000000Z" };
    expect(schoolReceiptSchema.safeParse(receipt).success).toBe(true);
    expect(schoolReceiptSchema.safeParse({ ...receipt, approval_state: "approved" }).success).toBe(false);
  });
});
