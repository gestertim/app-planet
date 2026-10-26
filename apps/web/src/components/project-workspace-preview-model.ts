import type { OwnedProjectCreationFlowAssessmentResult } from "../server/creation-flow-assessment";
import type {
  OwnedProjectWorkspaceDto,
  OwnedProjectWorkspaceReadResult,
} from "../server/project-workspace";

export const projectWorkspaceTabs = [
  { id: "blueprint", label: "藍圖" },
  { id: "design", label: "設計" },
  { id: "plan", label: "計畫" },
  { id: "build", label: "建立" },
  { id: "test", label: "測試" },
  { id: "versions", label: "版本" },
  { id: "publish", label: "發布" },
] as const;

export type ProjectWorkspaceTabId = (typeof projectWorkspaceTabs)[number]["id"];

export interface ProjectWorkspacePreviewScenario {
  id: string;
  label: string;
  workspaceResult: OwnedProjectWorkspaceReadResult;
  assessmentResult: OwnedProjectCreationFlowAssessmentResult;
}

const projectId = (last: string) => `85000000-0000-4000-8000-${last.padStart(12, "0")}`;

const unconfirmedWorkspace: OwnedProjectWorkspaceDto = {
  project: {
    id: projectId("1"),
    title: "小小生態觀察",
    stage: "點子",
    created_at: "2026-10-24T08:00:00.000Z",
    row_version: 0,
  },
  requirements: null,
  classification: {
    state: "unconfirmed",
    requested_tier: null,
    tier: null,
    needs_visitor_identity: null,
  },
  drafts: [],
};

const confirmedWorkspace: OwnedProjectWorkspaceDto = {
  project: {
    id: projectId("2"),
    title: "紙飛機風向觀察",
    stage: "UX/UI",
    created_at: "2026-10-23T08:00:00.000Z",
    row_version: 4,
  },
  requirements: {
    revision: 2,
    content: {
      description: "記錄不同紙飛機的飛行距離，並用圖表比較結果。",
      runtime_needs: "static",
      runtime_ai_required: false,
    },
  },
  classification: {
    state: "confirmed",
    requested_tier: "A",
    tier: "A",
    needs_visitor_identity: false,
  },
  drafts: [
    {
      stage: "點子",
      row_version: 0,
      state: "ai_draft",
      content_source: "student_input",
      content: { text: "" },
    },
    {
      stage: "UX/UI",
      row_version: 3,
      state: "ai_draft",
      content_source: "student_input",
      content: {
        text: '<script>globalThis.previewWasExecuted = true;</script>\n<img src="https://example.invalid/picture.png">',
      },
    },
  ],
};

const legacyWorkspace: OwnedProjectWorkspaceDto = {
  project: {
    id: projectId("3"),
    title: "星空小百科",
    stage: "Specification",
    created_at: "2025-10-23T08:00:00.000Z",
    row_version: 1,
  },
  requirements: null,
  classification: {
    state: "legacy_unverified",
    requested_tier: null,
    tier: "B",
    needs_visitor_identity: false,
  },
  drafts: [
    {
      stage: "Specification",
      row_version: 1,
      state: "ai_draft",
      content_source: "student_input",
      content: { text: "我想整理星星的顏色和名稱。" },
    },
  ],
};

const confirmedAssessment: Extract<
  OwnedProjectCreationFlowAssessmentResult,
  { outcome: "evaluated" }
>["assessment"] = {
  outcome: "evaluated",
  evidence_assurance: "structural_only",
  current_stage: "UX/UI",
  requested_stage: "Checkpoint",
  requested_stage_prerequisites: ["點子", "A/B", "Specification"],
  stage_assessment: {
    outcome: "unsupported",
    reason: "stage_completion_rules_undecided",
    unresolved_prerequisites: ["點子", "A/B", "Specification"],
    unresolved_decisions: [
      "stage_completion_policy",
      "six_to_nine_stage_mapping",
      "approval_evidence_contract",
      "specification_sync_evidence_contract",
      "approved_task_scope_mapping",
      "review_evidence_contract",
    ],
  },
  classification_assessment: {
    outcome: "satisfied",
    tier: "A",
    requirements_revision: 2,
  },
  work_scope_assessment: { outcome: "satisfied", reasons: [] },
  observed_drafts: [
    { stage: "點子", state: "ai_draft", content_source: "student_input" },
    { stage: "UX/UI", state: "ai_draft", content_source: "student_input" },
  ],
};

const missingEvidenceAssessment: Extract<
  OwnedProjectCreationFlowAssessmentResult,
  { outcome: "evaluated" }
>["assessment"] = {
  outcome: "evaluated",
  evidence_assurance: "structural_only",
  current_stage: "點子",
  requested_stage: "A/B",
  requested_stage_prerequisites: ["點子"],
  stage_assessment: {
    outcome: "missing_evidence",
    evidence: "current_classification_confirmation",
  },
  classification_assessment: {
    outcome: "missing_evidence",
    reason: "current_student_confirmation_required",
  },
  work_scope_assessment: {
    outcome: "missing_evidence",
    reason: "current_classification_confirmation_required",
  },
  observed_drafts: [],
};

const legacyAssessment: typeof missingEvidenceAssessment = {
  ...missingEvidenceAssessment,
  current_stage: "Specification",
  requested_stage: "UX/UI",
  requested_stage_prerequisites: [
    "點子",
    "A/B",
    "Specification",
    "Checkpoint",
    "Constitution",
  ],
  observed_drafts: [
    { stage: "Specification", state: "ai_draft", content_source: "student_input" },
  ],
};

function foundWorkspace(workspace: OwnedProjectWorkspaceDto): OwnedProjectWorkspaceReadResult {
  return { outcome: "found", workspace };
}

function evaluatedAssessment(
  workspace: OwnedProjectWorkspaceDto,
  assessment: Extract<OwnedProjectCreationFlowAssessmentResult, { outcome: "evaluated" }>["assessment"],
): OwnedProjectCreationFlowAssessmentResult {
  return {
    outcome: "evaluated",
    snapshot: "single_statement",
    project_id: workspace.project.id,
    row_version: workspace.project.row_version,
    requirements_revision: workspace.requirements?.revision ?? 0,
    assessment,
  };
}

export const projectWorkspacePreviewScenarios: readonly ProjectWorkspacePreviewScenario[] = [
  {
    id: "unconfirmed-no-requirements",
    label: "情境 A｜尚未建立需求",
    workspaceResult: foundWorkspace(unconfirmedWorkspace),
    assessmentResult: evaluatedAssessment(unconfirmedWorkspace, missingEvidenceAssessment),
  },
  {
    id: "confirmed-empty-and-text-drafts",
    label: "情境 B｜已確認與已保存草稿",
    workspaceResult: foundWorkspace(confirmedWorkspace),
    assessmentResult: evaluatedAssessment(confirmedWorkspace, confirmedAssessment),
  },
  {
    id: "legacy-unverified",
    label: "情境 C｜歷史分類未驗證",
    workspaceResult: foundWorkspace(legacyWorkspace),
    assessmentResult: evaluatedAssessment(legacyWorkspace, legacyAssessment),
  },
  {
    id: "policy-refused",
    label: "拒絕讀取情境",
    workspaceResult: { outcome: "denied", reason: "policy_denied" },
    assessmentResult: { outcome: "denied", reason: "policy_denied" },
  },
  {
    id: "read-failed",
    label: "讀取錯誤情境",
    workspaceResult: { outcome: "failed", reason: "dependency_failure" },
    assessmentResult: { outcome: "failed", reason: "dependency_failure" },
  },
  {
    id: "project-not-found",
    label: "找不到專案情境",
    workspaceResult: { outcome: "not_found" },
    assessmentResult: { outcome: "not_found" },
  },
];

export function classificationLabel(
  classification: OwnedProjectWorkspaceDto["classification"],
): string {
  if (classification.state === "unconfirmed") return "分類尚未確認";
  if (classification.state === "legacy_unverified") {
    return `歷史分類尚未驗證（${classification.tier}）`;
  }
  return `分類已確認（${classification.tier}）`;
}

export function requirementsLabel(workspace: OwnedProjectWorkspaceDto): string {
  return workspace.requirements === null
    ? "尚未建立需求"
    : `已保存需求（第 ${workspace.requirements.revision} 版）`;
}

export function draftLabel(
  draft: OwnedProjectWorkspaceDto["drafts"][number] | undefined,
): string {
  if (!draft) return "尚無草稿";
  return draft.content.text === ""
    ? `已保存空白內容｜版本 ${draft.row_version}`
    : `已保存，尚未確認｜版本 ${draft.row_version}`;
}

export function assessmentMessages(
  result: OwnedProjectCreationFlowAssessmentResult,
): readonly string[] {
  if (result.outcome !== "evaluated") return [resultMessage(result)];

  const messages = [];
  const assessment = result.assessment;
  messages.push(
    assessment.stage_assessment.outcome === "missing_evidence"
      ? "目前缺少這個階段所需的確認資料。"
      : "這個階段的完成規則尚未開放判定。",
  );
  messages.push(
    assessment.classification_assessment.outcome === "missing_evidence"
      ? "目前沒有這個專案的分類確認資料。"
      : `分類資料已確認為 ${assessment.classification_assessment.tier}；這不代表整段旅程完成。`,
  );
  if (assessment.work_scope_assessment.outcome === "missing_evidence") {
    messages.push("目前缺少判斷作品範圍的資料。");
  } else if (assessment.work_scope_assessment.outcome === "unsupported") {
    messages.push("目前尚不支援判斷這個作品範圍。");
  } else if (assessment.work_scope_assessment.outcome === "invalid_evidence") {
    messages.push("目前無法確認作品範圍資料是否一致。");
  } else {
    messages.push("作品範圍資料符合目前可判斷的部分；這不代表已獲准執行操作。");
  }
  return messages;
}

export function resultMessage(
  result: OwnedProjectWorkspaceReadResult | OwnedProjectCreationFlowAssessmentResult,
): string {
  if (result.outcome === "not_found") return "找不到這個專案。";
  if (result.outcome === "denied") return "這個工作區目前無法顯示。";
  if (result.outcome === "failed") return "目前無法讀取工作區。";
  return "";
}
