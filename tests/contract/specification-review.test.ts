import { describe, expect, it } from "vitest";
import { specificationSubmitSchema, specificationDecisionSchema, specificationQuerySchema } from "@app-planet/core";
const valid = { expected_draft_version: 0, expected_requirements_revision: 1,
  expected_classification_id: "10000000-0000-4000-8000-000000000001" };
describe("Specification 審查 strict 契約", () => {
  it("只接受保存版本 CAS，零版有效，不要求學生階段確認", () => {
    expect(specificationSubmitSchema.safeParse(valid).success).toBe(true);
    for (const field of ["owner", "reviewer", "approved", "submitted_at", "content", "student_confirmation"]) {
      expect(specificationSubmitSchema.safeParse({ ...valid, [field]: "forged" }).success).toBe(false);
    }
    expect(specificationSubmitSchema.safeParse({ ...valid, expected_requirements_revision: 0 }).success).toBe(false);
  });
  it("批准不可帶理由；退回必填有效理由及明示工程界限", () => {
    expect(specificationDecisionSchema.safeParse({ decision: "approved", reason: null }).success).toBe(true);
    expect(specificationDecisionSchema.safeParse({ decision: "returned", reason: "字".repeat(2000) }).success).toBe(true);
    for (const reason of ["", "  ", "換\n行", "\u0085", "\ud800", "\udc00", "字".repeat(2001), null]) {
      expect(specificationDecisionSchema.safeParse({ decision: "returned", reason }).success).toBe(false);
    }
    expect(specificationDecisionSchema.safeParse({ decision: "approved", reason: "x" }).success).toBe(false);
  });
  it("分頁順序游標有 bigint 界限，重複／非法形狀不默默截斷", () => {
    expect(specificationQuerySchema.parse({})).toEqual({ after: "0", limit: "20" });
    for (const query of [{ after: "-1" }, { after: "9223372036854775808" }, { limit: "51" }, { role: "admin" }, { after: ["1", "2"] }]) {
      expect(specificationQuerySchema.safeParse(query).success).toBe(false);
    }
  });
  it("退回理由使用 JavaScript trim 非空與原文 Unicode 碼點長度，不改寫合法空白", () => {
    const parse = (reason: string) => specificationDecisionSchema.safeParse({ decision: "returned", reason });
    for (const reason of ["\u3000", "\u00a0", " \u3000\u00a0 ", "\u1680", "\u2000\u200a",
      "\u2028\u2029", "\u202f", "\u205f", "\ufeff", "\t\r\n", " ".repeat(2000) + "字",
      "😀".repeat(2000) + "字", " " + "字".repeat(1999) + " ", "字\u009f"]) {
      expect(parse(reason).success).toBe(false);
    }
    for (const reason of ["\u3000 請補充用途 \u00a0", " " + "字".repeat(1998) + " ",
      "😀".repeat(2000), "😀".repeat(1998) + "字 ", "😀".repeat(1000) + "字", "\u200b", "\u180e"]) {
      const result = parse(reason);
      expect(result.success).toBe(true);
      if (result.success) expect(result.data.reason).toBe(reason);
    }
  });
});
