import { describe, expect, it } from "vitest";
import {
  evaluateWorkEligibility,
  getWorkEligibilityRequirementBlockers,
  type WorkEligibilityInput,
  type WorkEligibilityReason,
} from "@app-planet/core";

const validA: WorkEligibilityInput = {
  tier: "A",
  runtimeNeeds: "static",
  context: "public",
  requiresVisitorIdentity: false,
  runtimeAiRequired: false,
  platformAiAssistedCreation: false,
};

const validB: WorkEligibilityInput = {
  tier: "B",
  runtimeNeeds: "work_data_api",
  context: "public",
  requiresVisitorIdentity: false,
  runtimeAiRequired: false,
  platformAiAssistedCreation: false,
};

const invalidInputReason: WorkEligibilityReason = "invalid_input";

describe("作品範圍資格（本機純函式）", () => {
  it("只由正式 runtime 需求辨識不可支援項目，不推定 A／B 分類", () => {
    expect(getWorkEligibilityRequirementBlockers({
      runtimeNeeds: "restricted_server",
      runtimeAiRequired: true,
    })).toEqual([
      "student_server_runtime_not_in_mvp",
      "work_runtime_ai_not_in_mvp",
    ]);
    expect(getWorkEligibilityRequirementBlockers({
      runtimeNeeds: "work_data_api",
      runtimeAiRequired: false,
    })).toEqual([]);
    expect(getWorkEligibilityRequirementBlockers({
      runtimeNeeds: "unknown",
      runtimeAiRequired: false,
    })).toEqual(["invalid_input"]);
  });

  it.each([
    [
      "A／public／不需訪客識別",
      "範圍符合",
      "spec.md Assumptions 的 A 定義；2026-10-21 決定允許其他合格 A 公開",
      "公開作品審查、實際需求真實性及發布授權",
      { ...validA, context: "public" },
      true,
      [],
    ],
    [
      "A／public／需要訪客識別",
      "分類矛盾",
      "spec.md Assumptions 的 A 為 local-first 且原則上不加登入；B 才適用登入／權限需求，並且公開 B 限制見 FR-048",
      "訪客登入、帳號核發、識別服務、事實來源與發布授權",
      { ...validA, context: "public", requiresVisitorIdentity: true },
      false,
      ["inconsistent_input"],
    ],
    [
      "A／a1_preview／不需訪客識別",
      "範圍符合",
      "spec.md A 定義；publishing-and-public-runtime.md §3.7 的 A1 私人預覽",
      "A1 會話、實際預覽及登入授權",
      { ...validA, context: "a1_preview" },
      true,
      [],
    ],
    [
      "A／a1_preview／需要訪客識別",
      "範圍符合",
      "publishing-and-public-runtime.md §3.7 的 A1 私人預覽；公開 B 訪客限制不延伸至 A1，沒有條文依據在此新增 A1 A 矛盾",
      "訪客／主體身分、A1 會話與外部身分服務能力",
      { ...validA, context: "a1_preview", requiresVisitorIdentity: true },
      true,
      [],
    ],
    [
      "B／public／不需訪客識別",
      "範圍符合",
      "spec.md FR-048 與 2026-10-21 範圍決定：其他合格 B 公開",
      "B2 逐請求授權、配額、發布審查與正式服務",
      { ...validB, context: "public" },
      true,
      [],
    ],
    [
      "B／public／需要訪客識別",
      "契約既定公開阻擋",
      "spec.md FR-048／2026-10-21 範圍決定；data-model.md §5.4 的 tier_b_needs_visitor_identity",
      "B2 資料授權、訪客身分核發與服務端執行",
      { ...validB, context: "public", requiresVisitorIdentity: true },
      false,
      ["tier_b_needs_visitor_identity"],
    ],
    [
      "B／a1_preview／不需訪客識別",
      "範圍符合",
      "publishing-and-public-runtime.md §3.7 的 A1 私人預覽與 B2 區隔",
      "A1 會話、B2 預覽資料集及實際資料存取授權",
      { ...validB, context: "a1_preview" },
      true,
      [],
    ],
    [
      "B／a1_preview／需要訪客識別",
      "範圍符合",
      "publishing-and-public-runtime.md §3.7 的 A1 私人預覽；FR-048 訪客限制限公開 B",
      "A1 會話、訪客身分核發、B2 預覽資料集及外部服務",
      { ...validB, context: "a1_preview", requiresVisitorIdentity: true },
      true,
      [],
    ],
  ] as const)(
    "%s：%s；依據：%s；此函式未驗證：%s",
    (_name, _classification, _basis, _notVerified, input, expectedSupport, expectedReasons) => {
      const result = evaluateWorkEligibility(input);

      expect(result.withinMvpSupport).toBe(expectedSupport);
      expect(new Set(result.reasons)).toEqual(new Set(expectedReasons));
    },
  );

  it("公開 A 同時需要訪客識別及 runtime AI 時仍拒絕，原因不代表優先序", () => {
    const result = evaluateWorkEligibility({
      ...validA,
      requiresVisitorIdentity: true,
      runtimeAiRequired: true,
    });

    expect(result.withinMvpSupport).toBe(false);
    expect(new Set(result.reasons)).toEqual(
      new Set(["inconsistent_input", "work_runtime_ai_not_in_mvp"]),
    );
  });

  it("只改公開訪客作品的 tier 標籤不能使相同需求符合範圍", () => {
    const declaredA = {
      ...validA,
      requiresVisitorIdentity: true,
    };
    const relabeledB: WorkEligibilityInput = {
      ...declaredA,
      tier: "B",
    };
    const aResult = evaluateWorkEligibility(declaredA);
    const bResult = evaluateWorkEligibility(relabeledB);

    expect(aResult.withinMvpSupport).toBe(false);
    expect(bResult.withinMvpSupport).toBe(false);
    expect(new Set(aResult.reasons)).toEqual(new Set(["inconsistent_input"]));
    expect(new Set(bResult.reasons)).toEqual(
      new Set(["inconsistent_input", "tier_b_needs_visitor_identity"]),
    );
  });

  it.each([
    ["合法 A 靜態公開作品", validA, true, []],
    ["合格 B 使用平台 Work Data API", validB, true, []],
    [
      "公開 B 要求訪客識別",
      { ...validB, requiresVisitorIdentity: true },
      false,
      ["tier_b_needs_visitor_identity"],
    ],
    [
      "學生伺服器執行需求",
      { ...validB, runtimeNeeds: "restricted_server" },
      false,
      ["student_server_runtime_not_in_mvp"],
    ],
    [
      "作品執行時需要 AI",
      { ...validA, runtimeAiRequired: true },
      false,
      ["work_runtime_ai_not_in_mvp"],
    ],
    [
      "平台 AI 協助製作不等於作品 runtime AI",
      { ...validA, platformAiAssistedCreation: true },
      true,
      [],
    ],
    [
      "A 分類與 Work Data API 執行需求互相矛盾",
      { ...validA, runtimeNeeds: "work_data_api" },
      false,
      ["inconsistent_input"],
    ],
    [
      "公開 B 訪客識別與 runtime AI 同時不符合",
      { ...validB, requiresVisitorIdentity: true, runtimeAiRequired: true },
      false,
      ["tier_b_needs_visitor_identity", "work_runtime_ai_not_in_mvp"],
    ],
    [
      "必要事實缺漏",
      {
        runtimeNeeds: "static",
        context: "public",
        requiresVisitorIdentity: false,
        runtimeAiRequired: false,
      },
      false,
      [invalidInputReason],
    ],
    [
      "未知作品級別",
      { ...validA, tier: "C" },
      false,
      [invalidInputReason],
    ],
    [
      "非法情境",
      { ...validA, context: "preview" },
      false,
      [invalidInputReason],
    ],
    [
      "未定義欄位",
      { ...validA, visitorIdentity: false },
      false,
      [invalidInputReason],
    ],
  ] as const)(
    "%s",
    (_name, input, expectedSupport, expectedReasons) => {
      const result = evaluateWorkEligibility(input);

      expect(result.withinMvpSupport).toBe(expectedSupport);
      expect(new Set(result.reasons)).toEqual(new Set(expectedReasons));
    },
  );

  it("platform AI 輔助背景可省略且不改變作品範圍判斷", () => {
    const { platformAiAssistedCreation: _background, ...withoutBackground } = validA;

    expect(evaluateWorkEligibility(withoutBackground)).toEqual(evaluateWorkEligibility(validA));
    expect(evaluateWorkEligibility({
      ...withoutBackground,
      platformAiAssistedCreation: true,
    })).toEqual(evaluateWorkEligibility(validA));
  });

  it("拒絕非物件及非法欄位型別，不把缺漏事實補成 A 或 false", () => {
    expect(evaluateWorkEligibility(null)).toEqual({
      withinMvpSupport: false,
      context: null,
      reasons: ["invalid_input"],
    });
    expect(
      evaluateWorkEligibility({ ...validB, requiresVisitorIdentity: "false" }),
    ).toEqual({
      withinMvpSupport: false,
      context: null,
      reasons: ["invalid_input"],
    });
  });

  it("不修改輸入，且符合範圍的結果不承諾發布、資料存取或 Gate 通過", () => {
    const input = { ...validB };
    const original = structuredClone(input);
    const result = evaluateWorkEligibility(input);

    expect(input).toEqual(original);
    expect(result).toEqual({
      withinMvpSupport: true,
      context: "public",
      reasons: [],
    });
    expect(result).not.toHaveProperty("published");
    expect(result).not.toHaveProperty("dataAccessAllowed");
    expect(result).not.toHaveProperty("gatePassed");
  });
});
