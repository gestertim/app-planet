import { describe, expect, it } from "vitest";
import {
  CREATION_FLOW_STAGES,
  creationFlowInputSchema,
  evaluateCreationFlow,
} from "@app-planet/core";
import type { CreationFlowInput } from "@app-planet/core";

const projectId = "a1000000-0000-4000-8000-000000000001";
const otherProjectId = "a1000000-0000-4000-8000-000000000002";
const confirmerId = "a2000000-0000-4000-8000-000000000001";
const confirmationId = "a3000000-0000-4000-8000-000000000001";

const requirements = {
  description: "合成的待分類作品需求",
  runtime_needs: "static" as const,
  runtime_ai_required: false,
};

type InputOverrides = {
  project?: CreationFlowInput["project"];
  requested_stage?: CreationFlowInput["requested_stage"];
  requirements?: CreationFlowInput["requirements"];
  classification?: CreationFlowInput["classification"];
  platform_ai_assisted_creation?: boolean;
  stage_drafts?: CreationFlowInput["stage_drafts"];
};

type ConfirmedClassification = Extract<
  CreationFlowInput["classification"],
  { state: "confirmed" }
> & {
  confirmation: Extract<
    CreationFlowInput["classification"],
    { state: "confirmed" }
  >["confirmation"] & {
    project_id: string;
    tier: "A" | "B";
    needs_visitor_identity: boolean;
  };
};

function confirmedClassificationEvidence(): ConfirmedClassification {
  return {
    project_id: projectId,
    state: "confirmed",
    requested_tier: "A",
    tier: "A",
    needs_visitor_identity: false,
    requirements_revision: 4,
    confirmation: {
      id: confirmationId,
      project_id: projectId,
      tier: "A",
      needs_visitor_identity: false,
      requirements_revision: 4,
      confirmed_by: confirmerId,
      confirmed_at: "2026-10-24T08:00:00Z",
      source: "student_explicit_confirmation",
      requirements_snapshot: requirements,
      requested_tier_at_confirmation: "A",
      requested_tier_acknowledgement: "matches",
    },
  };
}

function confirmedInput(overrides: InputOverrides = {}): CreationFlowInput {
  return creationFlowInputSchema.parse({
    project: { id: projectId, current_stage: "點子" },
    requested_stage: "A/B",
    requirements: { project_id: projectId, revision: 4, content: requirements },
    classification: confirmedClassificationEvidence(),
    platform_ai_assisted_creation: true,
    stage_drafts: [],
    ...overrides,
  });
}

function savedDraft(stage: CreationFlowInput["requested_stage"], id = projectId) {
  return {
    project_id: id,
    stage,
    row_version: 0,
    state: "ai_draft" as const,
    content_source: "student_input" as const,
    content: { text: "合成草稿" },
    approved_by: null,
    approved_at: null,
  };
}

describe("T052 創作旅程與階段前置判斷", () => {
  it("回傳的 unresolved_decisions 不會讓 caller 污染後續判斷", () => {
    const input = confirmedInput({ requested_stage: "Final Pack" });
    const first = evaluateCreationFlow(input);

    expect(first.outcome).toBe("evaluated");
    if (first.outcome !== "evaluated" || first.stage_assessment.outcome !== "unsupported") {
      expect.fail("預期取得未定規則判斷");
      return;
    }

    const unresolvedDecisions = first.stage_assessment.unresolved_decisions;
    const expected = [...unresolvedDecisions];
    try {
      Reflect.set(unresolvedDecisions, 0, "caller_mutation");
      const second = evaluateCreationFlow(input);

      expect(second.outcome).toBe("evaluated");
      if (second.outcome !== "evaluated" || second.stage_assessment.outcome !== "unsupported") {
        expect.fail("預期相同輸入仍取得未定規則判斷");
        return;
      }
      expect(second.stage_assessment.unresolved_decisions).toEqual(expected);
    } finally {
      expected.forEach((decision, index) => Reflect.set(unresolvedDecisions, index, decision));
    }
  });

  it("保留九個正式階段的名稱及順序，前置步驟只表示順序、不推定完成", () => {
    const input = confirmedInput({ requested_stage: "Final Pack" });
    const result = evaluateCreationFlow(input);

    expect(CREATION_FLOW_STAGES).toEqual([
      "點子", "A/B", "Specification", "Checkpoint", "Constitution",
      "UX/UI", "Specification Sync", "Technical Plan", "Final Pack",
    ]);
    expect(result.outcome).toBe("evaluated");
    if (result.outcome !== "evaluated") return;
    expect(result.evidence_assurance).toBe("structural_only");
    expect(result.requested_stage_prerequisites).toEqual(CREATION_FLOW_STAGES.slice(0, 8));
    expect(result.stage_assessment.outcome).toBe("unsupported");
    if (result.stage_assessment.outcome === "unsupported") {
      expect(result.stage_assessment.unresolved_decisions).toContain("approved_task_scope_mapping");
      expect(result.stage_assessment.unresolved_decisions).toContain("review_evidence_contract");
    }
  });

  it("有效分類確認只滿足分類規則，不代表點子或其他階段完成", () => {
    const result = evaluateCreationFlow(confirmedInput());

    expect(result.outcome).toBe("evaluated");
    if (result.outcome !== "evaluated") return;
    expect(result.classification_assessment).toMatchObject({
      outcome: "satisfied",
      tier: "A",
      requirements_revision: 4,
    });
    expect(result).not.toHaveProperty("trusted_source");
    expect(result.stage_assessment.outcome).toBe("unsupported");
  });

  it("確認證據綁定專案、正式 tier 與 visitor 值，並保留有效需求／acknowledgement", () => {
    const valid = confirmedInput();
    expect(evaluateCreationFlow(valid)).toMatchObject({
      outcome: "evaluated",
      classification_assessment: { outcome: "satisfied", tier: "A", requirements_revision: 4 },
      work_scope_assessment: { outcome: "satisfied" },
    });

    const originalConfirmation = confirmedClassificationEvidence().confirmation;
    const crossProject = evaluateCreationFlow(confirmedInput({
      project: { id: otherProjectId, current_stage: "點子" },
      requirements: { project_id: otherProjectId, revision: 4, content: requirements },
      classification: {
        ...confirmedClassificationEvidence(),
        project_id: otherProjectId,
      },
    }));
    const crossTier = evaluateCreationFlow(confirmedInput({
      classification: {
        ...confirmedClassificationEvidence(),
        requested_tier: null,
        tier: "B",
        confirmation: {
          ...originalConfirmation,
          requested_tier_at_confirmation: null,
          requested_tier_acknowledgement: "no_preference",
        },
      },
    }));
    const crossVisitorIdentity = evaluateCreationFlow(confirmedInput({
      classification: {
        ...confirmedClassificationEvidence(),
        needs_visitor_identity: true,
      },
    }));

    expect(crossProject).toMatchObject({
      outcome: "invalid_evidence",
      reason: "confirmation_mismatch",
    });
    expect(crossTier).toMatchObject({
      outcome: "invalid_evidence",
      reason: "confirmation_mismatch",
    });
    expect(crossVisitorIdentity).toMatchObject({
      outcome: "invalid_evidence",
      reason: "confirmation_mismatch",
    });
  });

  it.each(["project_id", "tier", "needs_visitor_identity"] as const)(
    "確認證據缺少必要欄位 %s 時拒絕輸入",
    (field) => {
      const confirmation = { ...confirmedClassificationEvidence().confirmation };
      Reflect.deleteProperty(confirmation, field);
      const input = {
        ...confirmedInput(),
        classification: {
          ...confirmedClassificationEvidence(),
          confirmation,
        },
      };

      expect(creationFlowInputSchema.safeParse(input).success).toBe(false);
    },
  );

  it.each([
    ["project_id", "not-a-uuid"],
    ["tier", "C"],
    ["needs_visitor_identity", "false"],
  ] as const)("確認證據欄位 %s 型別／值非法時拒絕輸入", (field, value) => {
    const confirmation = { ...confirmedClassificationEvidence().confirmation };
    Reflect.set(confirmation, field, value);
    const input = {
      ...confirmedInput(),
      classification: {
        ...confirmedClassificationEvidence(),
        confirmation,
      },
    };

    expect(creationFlowInputSchema.safeParse(input).success).toBe(false);
  });

  it("草稿只回報已保存事實，不能冒充學生確認或教師／管理員批准", () => {
    const result = evaluateCreationFlow(confirmedInput({
      requested_stage: "Final Pack",
      stage_drafts: [savedDraft("Final Pack")],
    }));

    expect(result.outcome).toBe("evaluated");
    if (result.outcome !== "evaluated") return;
    expect(result.observed_drafts).toEqual([{
      stage: "Final Pack",
      state: "ai_draft",
      content_source: "student_input",
    }]);
    expect(result.stage_assessment.outcome).toBe("unsupported");
  });

  it("只有草稿時仍缺少學生明確確認；人工批准欄位不能從草稿輸入", () => {
    const input = confirmedInput({
      classification: {
        project_id: projectId,
        state: "unconfirmed",
        requested_tier: "A",
        tier: null,
        needs_visitor_identity: null,
        requirements_revision: 4,
        confirmation: null,
      },
      stage_drafts: [savedDraft("點子")],
    });
    const result = evaluateCreationFlow(input);
    const forgedApproval = creationFlowInputSchema.safeParse({
      ...confirmedInput(),
      stage_drafts: [{
        ...savedDraft("Constitution"),
        state: "approved",
        approved_by: confirmerId,
      }],
    });

    expect(result).toMatchObject({
      outcome: "evaluated",
      classification_assessment: { outcome: "missing_evidence" },
      stage_assessment: { outcome: "missing_evidence" },
    });
    expect(forgedApproval.success).toBe(false);
  });

  it("後段草稿及 projects.stage 不補足前段前置條件", () => {
    const input = confirmedInput({
      requested_stage: "Final Pack",
      project: { id: projectId, current_stage: "Final Pack" },
      stage_drafts: [savedDraft("Final Pack")],
    });
    const result = evaluateCreationFlow(input);

    expect(result.outcome).toBe("evaluated");
    if (result.outcome !== "evaluated") return;
    if (result.stage_assessment.outcome !== "unsupported") {
      expect.fail("預期未定規則會明確回報 unsupported");
    }
    expect(result.stage_assessment.reason).toBe("stage_completion_rules_undecided");
  });

  it.each([
    "Specification", "Checkpoint", "Constitution", "UX/UI", "Specification Sync",
    "Technical Plan", "Final Pack",
  ] as const)(
    "%s 的草稿及分類確認不代替該步驟／同步／任務／審查完成判準",
    (stage) => {
      const result = evaluateCreationFlow(confirmedInput({
        requested_stage: stage,
        stage_drafts: [savedDraft(stage)],
      }));

      expect(result).toMatchObject({
        outcome: "evaluated",
        stage_assessment: { outcome: "unsupported", reason: "stage_completion_rules_undecided" },
      });
    },
  );

  it("缺少當前分類確認與單純 requested_tier 是缺證據，不是確認", () => {
    const input = confirmedInput({
      classification: {
        project_id: projectId,
        state: "unconfirmed",
        requested_tier: "A",
        tier: null,
        needs_visitor_identity: null,
        requirements_revision: 4,
        confirmation: null,
      },
    });
    const result = evaluateCreationFlow(input);

    expect(result.outcome).toBe("evaluated");
    if (result.outcome !== "evaluated") return;
    expect(result.classification_assessment.outcome).toBe("missing_evidence");
    expect(result.stage_assessment.outcome).toBe("missing_evidence");
  });

  it("拒絕混用不同專案、需求 revision 或確認目標的證據", () => {
    const crossProject = evaluateCreationFlow(confirmedInput({
      classification: { ...confirmedClassificationEvidence(), project_id: otherProjectId },
    }));
    const crossRevision = evaluateCreationFlow(confirmedInput({
      classification: {
        ...confirmedClassificationEvidence(),
        requirements_revision: 3,
      },
    }));
    const crossTarget = evaluateCreationFlow(confirmedInput({
      classification: {
        ...confirmedClassificationEvidence(),
        confirmation: {
          ...confirmedClassificationEvidence().confirmation,
          requirements_revision: 3,
        },
      },
    }));
    const crossContents = evaluateCreationFlow(confirmedInput({
      classification: {
        ...confirmedClassificationEvidence(),
        confirmation: {
          ...confirmedClassificationEvidence().confirmation,
          requirements_snapshot: { ...requirements, description: "另一版需求" },
        },
      },
    }));

    expect(crossProject).toMatchObject({ outcome: "invalid_evidence" });
    expect(crossRevision).toMatchObject({ outcome: "invalid_evidence" });
    expect(crossTarget).toMatchObject({ outcome: "invalid_evidence" });
    expect(crossContents).toMatchObject({ outcome: "invalid_evidence" });
  });

  it("拒絕互相矛盾的分類狀態與正式欄位", () => {
    const input = confirmedInput({
      classification: {
        project_id: projectId,
        state: "unconfirmed",
        requested_tier: "A",
        tier: "A",
        needs_visitor_identity: false,
        requirements_revision: 4,
        confirmation: null,
      },
    });

    expect(evaluateCreationFlow(input)).toMatchObject({ outcome: "invalid_evidence" });
  });

  it("已失效／歷史未驗證分類不會被當成目前確認", () => {
    const input = confirmedInput({
      requirements: null,
      classification: {
        project_id: projectId,
        state: "legacy_unverified",
        requested_tier: null,
        tier: "A",
        needs_visitor_identity: false,
        requirements_revision: 0,
        confirmation: null,
      },
    });
    const result = evaluateCreationFlow(input);

    expect(result.outcome).toBe("evaluated");
    if (result.outcome !== "evaluated") return;
    expect(result.classification_assessment.outcome).toBe("missing_evidence");
  });

  it("拒絕 caller 傳入 approved、complete、canAdvance 或其他未知結論欄位", () => {
    const input = confirmedInput();
    expect(creationFlowInputSchema.safeParse({
      ...input,
      canAdvance: true,
      approved: true,
      complete: true,
    }).success).toBe(false);
    expect(creationFlowInputSchema.safeParse({
      ...input,
      classification: { ...input.classification, approved: true },
    }).success).toBe(false);
    expect(creationFlowInputSchema.safeParse({
      ...input,
      classification: { ...input.classification, tier: "C" },
    }).success).toBe(false);
  });

  it("區分無效輸入、無效證據、缺漏證據與未定規則", () => {
    const malformed = evaluateCreationFlow({
      ...confirmedInput(),
      requested_stage: "Readiness Gate" as CreationFlowInput["requested_stage"],
    });
    const absent = evaluateCreationFlow(confirmedInput({
      classification: {
        project_id: projectId,
        state: "unconfirmed",
        requested_tier: null,
        tier: null,
        needs_visitor_identity: null,
        requirements_revision: 4,
        confirmation: null,
      },
      requested_stage: "A/B",
    }));
    const unsupported = evaluateCreationFlow(confirmedInput({ requested_stage: "點子" }));
    const contradictory = evaluateCreationFlow(confirmedInput({
      classification: {
        ...confirmedClassificationEvidence(),
        confirmation: {
          ...confirmedClassificationEvidence().confirmation,
          requested_tier_at_confirmation: "B",
        },
      },
    }));

    expect(malformed).toMatchObject({ outcome: "invalid_input" });
    expect(absent).toMatchObject({
      outcome: "evaluated",
      classification_assessment: { outcome: "missing_evidence" },
      stage_assessment: { outcome: "missing_evidence" },
    });
    expect(unsupported).toMatchObject({
      outcome: "evaluated",
      stage_assessment: { outcome: "unsupported" },
    });
    expect(contradictory).toMatchObject({ outcome: "invalid_evidence" });
  });

  it("A/B 範圍承認平台 AI 輔助創作，不承認作品 runtime AI", () => {
    const platformAi = evaluateCreationFlow(confirmedInput());
    const runtimeAiRequirements = { ...requirements, runtime_ai_required: true };
    const workRuntimeAi = evaluateCreationFlow(confirmedInput({
      requirements: {
        project_id: projectId,
        revision: 4,
        content: runtimeAiRequirements,
      },
      classification: {
        ...confirmedClassificationEvidence(),
        confirmation: {
          ...confirmedClassificationEvidence().confirmation,
          requirements_snapshot: runtimeAiRequirements,
        },
      },
    }));

    expect(platformAi).toMatchObject({
      outcome: "evaluated",
      work_scope_assessment: { outcome: "satisfied" },
    });
    expect(workRuntimeAi).toMatchObject({
      outcome: "evaluated",
      work_scope_assessment: {
        outcome: "unsupported",
        reasons: ["work_runtime_ai_not_in_mvp"],
      },
    });
  });

  it("平台 AI 輔助是選填背景資訊，不影響作品範圍判斷", () => {
    const input = confirmedInput();
    const { platform_ai_assisted_creation: _background, ...withoutBackground } = input;
    const parsed = creationFlowInputSchema.safeParse(withoutBackground);

    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(evaluateCreationFlow(parsed.data)).toEqual(evaluateCreationFlow(input));
    expect(evaluateCreationFlow(confirmedInput({ platform_ai_assisted_creation: false })))
      .toEqual(evaluateCreationFlow(input));
  });

  it("檢查 A/B 與需求 runtime 一致性，不把作品範圍當成操作資格", () => {
    const mismatchedRequirements = { ...requirements, runtime_needs: "work_data_api" as const };
    const inconsistent = evaluateCreationFlow(confirmedInput({
      requirements: {
        project_id: projectId,
        revision: 4,
        content: mismatchedRequirements,
      },
      classification: {
        ...confirmedClassificationEvidence(),
        confirmation: {
          ...confirmedClassificationEvidence().confirmation,
          requirements_snapshot: mismatchedRequirements,
        },
      },
    }));
    const bRequirements = { ...requirements, runtime_needs: "work_data_api" as const };
    const validB = evaluateCreationFlow(confirmedInput({
      classification: {
        ...confirmedClassificationEvidence(),
        requested_tier: "B",
        tier: "B",
        needs_visitor_identity: true,
        confirmation: {
          ...confirmedClassificationEvidence().confirmation,
          tier: "B",
          needs_visitor_identity: true,
          requirements_snapshot: bRequirements,
          requested_tier_at_confirmation: "B",
          requested_tier_acknowledgement: "matches",
        },
      },
      requirements: {
        project_id: projectId,
        revision: 4,
        content: bRequirements,
      },
    }));

    expect(inconsistent).toMatchObject({
      outcome: "evaluated",
      work_scope_assessment: { outcome: "invalid_evidence" },
    });
    expect(validB).toMatchObject({
      outcome: "evaluated",
      work_scope_assessment: { outcome: "satisfied" },
    });
    if (validB.outcome === "evaluated") {
      expect(validB).not.toHaveProperty("preview");
      expect(validB).not.toHaveProperty("publish");
      expect(validB).not.toHaveProperty("operation_grant");
      expect(validB).not.toHaveProperty("account");
      expect(validB).not.toHaveProperty("data_access");
      expect(validB).not.toHaveProperty("ai_access");
    }

    const restrictedServerRequirements = {
      ...requirements,
      runtime_needs: "restricted_server" as const,
    };
    const restrictedServer = evaluateCreationFlow(confirmedInput({
      requirements: {
        project_id: projectId,
        revision: 4,
        content: restrictedServerRequirements,
      },
      classification: {
        ...confirmedClassificationEvidence(),
        confirmation: {
          ...confirmedClassificationEvidence().confirmation,
          requirements_snapshot: restrictedServerRequirements,
        },
      },
    }));
    expect(restrictedServer).toMatchObject({
      outcome: "evaluated",
      work_scope_assessment: {
        outcome: "unsupported",
        reasons: ["student_server_runtime_not_in_mvp"],
      },
    });
  });

  it("拒絕跨專案草稿，且相同輸入純函式重現相同輸出、不修改輸入", () => {
    const crossProject = evaluateCreationFlow(confirmedInput({
      stage_drafts: [savedDraft("Final Pack", otherProjectId)],
    }));
    const input = confirmedInput({ requested_stage: "Technical Plan" });
    const before = structuredClone(input);
    const first = evaluateCreationFlow(input);
    const second = evaluateCreationFlow(input);

    expect(crossProject).toMatchObject({ outcome: "invalid_evidence" });
    expect(first).toEqual(second);
    expect(input).toEqual(before);
  });
});
