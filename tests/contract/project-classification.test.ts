import { describe, expect, it } from "vitest";
import {
  confirmProjectClassificationInputSchema,
  projectRequirementsSchema,
  saveProjectRequirementsInputSchema,
  projectRequirementsBodySchema,
  projectClassificationBodySchema,
  projectClassificationResponseSchema,
} from "@app-planet/core";
import { readClassificationVersion } from "../../apps/web/src/server/project-classification-handlers.ts";

const projectId = "71000000-0000-4000-8000-000000000001";
const requirements = {
  description: "  Shared stories: café  ",
  runtime_needs: "static",
  runtime_ai_required: false,
} as const;

describe("T051 需求版本與 A/B 分類確認契約", () => {
  it("HTTP header 唯一對應 project version，body 對應 revision；拒絕重複／矛盾來源", () => {
    expect(readClassificationVersion(new Headers({ "if-match": '"-1"' }))).toEqual({ ok: true, version: -1 });
    expect(projectRequirementsBodySchema.parse({ expected_requirements_revision: 0, requirements }))
      .toEqual({ expected_requirements_revision: 0, requirements });
    for (const raw of ['W/"1"', '"1","2"', '"2147483648"', '"01"', '"-0"', "*"]) {
      expect(readClassificationVersion(new Headers({ "if-match": raw })).ok).toBe(false);
    }
    expect(readClassificationVersion(new Headers({ "if-match": '"1"', "if-none-match": "*" })).ok).toBe(false);
    expect(projectRequirementsBodySchema.safeParse({
      expected_requirements_revision: 1, expected_row_version: 99, requirements,
    }).success).toBe(false);
    expect(projectClassificationBodySchema.safeParse({
      expected_requirements_revision: 1, tier: "A", requested_tier_acknowledgement: "matches",
    }).success).toBe(false);
  });

  it("receipt 與 current 可不同版本；舊確認 receipt 不使 current 成為 confirmed", () => {
    const value = {
      outcome: "replayed",
      operation: {
        outcome: "confirmed", row_version: 2, requirements_revision: 1,
        tier: "A", needs_visitor_identity: false,
        confirmation: { id: projectId, requirements_revision: 1,
          confirmed_at: "2026-11-04T00:00:00.000Z", source: "student_explicit_confirmation" },
      },
      current: {
        id: projectId, row_version: 3, requirements_revision: 2, requested_tier: "A",
        classification_state: "unconfirmed", requirements, tier: null,
        needs_visitor_identity: null, confirmation: null,
      },
    };
    expect(projectClassificationResponseSchema.parse(value).current.classification_state).toBe("unconfirmed");
    expect(projectClassificationResponseSchema.safeParse({
      ...value, current: { ...value.current, classification_state: "confirmed" },
    }).success).toBe(false);
  });
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
