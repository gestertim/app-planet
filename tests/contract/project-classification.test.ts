import { describe, expect, it } from "vitest";
import {
  confirmProjectClassificationInputSchema,
  projectRequirementsSchema,
  saveProjectRequirementsInputSchema,
} from "@app-planet/core";

const projectId = "71000000-0000-4000-8000-000000000001";
const requirements = {
  description: "  Shared stories: café  ",
  runtime_needs: "static",
  runtime_ai_required: false,
} as const;

describe("T051 需求版本與 A/B 分類確認契約", () => {
  it("保留自由文字原值，不 trim 或正規化", () => {
    expect(projectRequirementsSchema.parse(requirements)).toEqual(requirements);
  });

  it.each([
    { description: requirements.description, runtime_needs: "static" },
    { description: requirements.description, runtime_needs: "static", runtime_ai_required: null },
    { ...requirements, unexpected: true },
    { ...requirements, runtime_needs: "restricted_server_extra" },
  ])("拒絕缺漏、錯型別與未知需求欄位：%j", (input) => {
    expect(projectRequirementsSchema.safeParse(input).success).toBe(false);
  });

  it("需求保存要求 project row_version、需求 revision、內容及 UUID 鍵", () => {
    const input = {
      project_id: projectId,
      expected_row_version: 0,
      expected_requirements_revision: 0,
      requirements,
    };
    expect(saveProjectRequirementsInputSchema.parse(input)).toEqual(input);
    expect(saveProjectRequirementsInputSchema.safeParse({
      ...input,
      requirements: { ...requirements, ignored: "unknown" },
    }).success).toBe(false);
    expect(saveProjectRequirementsInputSchema.safeParse({
      ...input,
      expected_row_version: -2147483649,
    }).success).toBe(false);
  });

  it("確認要求明確分類及完整 visitor boolean，不接受 claim 或 caller confirmed", () => {
    const input = {
      project_id: projectId,
      expected_row_version: 1,
      expected_requirements_revision: 1,
      tier: "A",
      needs_visitor_identity: false,
      requested_tier_acknowledgement: "matches",
    };
    expect(confirmProjectClassificationInputSchema.parse(input)).toEqual(input);
    expect(confirmProjectClassificationInputSchema.safeParse({
      ...input,
      needs_visitor_identity: undefined,
    }).success).toBe(false);
    expect(confirmProjectClassificationInputSchema.safeParse({
      ...input,
      confirmed: true,
    }).success).toBe(false);
    expect(confirmProjectClassificationInputSchema.safeParse({
      ...input,
      confirmer_id: projectId,
    }).success).toBe(false);
    expect(confirmProjectClassificationInputSchema.safeParse({
      ...input,
      requested_tier_acknowledgement: "automatic",
    }).success).toBe(false);
  });
});
