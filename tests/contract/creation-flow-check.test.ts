import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { evaluateCreationFlow, type CreationFlowInput } from "@app-planet/core";
import { CreationFlowCheck } from "../../apps/web/src/components/project/creation-flow-check.tsx";
import type { CreationFlowPageResult } from "../../apps/web/src/server/creation-flow-page-data.ts";

const id = "10000000-0000-4000-8000-000000000001";
const input: CreationFlowInput = {
  project: { id, current_stage: "點子" }, requested_stage: "Final Pack", requirements: null,
  classification: { project_id: id, state: "unconfirmed", requested_tier: null, tier: null,
    needs_visitor_identity: null, requirements_revision: 0, confirmation: null }, stage_drafts: [],
};
function result(): Extract<CreationFlowPageResult, { outcome: "evaluated" }> {
  const assessment = evaluateCreationFlow(input);
  if (assessment.outcome !== "evaluated") throw new Error("invalid fixture");
  return { outcome: "evaluated", snapshot: "single_statement", project_id: id,
    row_version: 0, requirements_revision: 0, assessment };
}
const render = (value: CreationFlowPageResult) =>
  renderToStaticMarkup(createElement(CreationFlowCheck, { projectId: id, result: value }));

describe("唯讀檢查學生投影", () => {
  it("實際評估缺項、八個先前階段及安全補齊入口", () => {
    const html = render(result());
    expect(html).toContain("尚無正式需求，也沒有有效");
    expect(html).toContain("尚不能判斷支援範圍");
    expect(html).toContain("尚無已保存內容");
    expect(html).toContain("stages/A%2FB");
    expect(html.match(/>編輯 /g)).toHaveLength(8);
    expect(html).toContain("編輯目標階段：Final Pack");
    expect(html).toContain("不是已核定的逐階段通關規則");
    expect(html).toContain("可能不是同一時點");
    expect(html).not.toContain("current_student_confirmation_required");
    expect(html).not.toContain("已解鎖");
  });
  it("有效分類與草稿仍不推導人工批准／完成／公開資格", () => {
    const value = result();
    value.requirements_revision = 1;
    value.assessment.classification_assessment = { outcome: "satisfied", tier: "B", requirements_revision: 1 };
    value.assessment.work_scope_assessment = { outcome: "satisfied", reasons: [] };
    value.assessment.observed_drafts = [{ stage: "Specification", state: "ai_draft", content_source: "student_input" }];
    const html = render(value);
    expect(html).toContain("學生 B 級分類確認");
    expect(html).toContain("不是老師或管理員的人工批准");
    expect(html).toContain("觀察到已保存的學生輸入草稿");
    expect(html).toContain("沒有提供學生階段確認");
    expect(html).toContain("不是公開資格");
    expect(html).not.toContain("confirmed_by");
  });
  it("unsupported 與未決事項逐一轉成可讀文案，不假通過", () => {
    const value = result();
    value.assessment.work_scope_assessment = { outcome: "unsupported",
      reasons: ["student_server_runtime_not_in_mvp", "work_runtime_ai_not_in_mvp"] };
    value.assessment.stage_assessment = { outcome: "unsupported", reason: "stage_completion_rules_undecided",
      unresolved_prerequisites: ["點子"], unresolved_decisions: ["stage_completion_policy",
        "six_to_nine_stage_mapping", "approval_evidence_contract", "specification_sync_evidence_contract",
        "approved_task_scope_mapping", "review_evidence_contract"] };
    const html = render(value);
    expect(html).toContain("不在支援範圍");
    expect(html).toContain("自己的伺服器程式");
    expect(html).toContain("生成式 AI");
    expect(html).toContain("人工批准需要綁定哪些版本");
    expect(html).not.toContain("student_server_runtime_not_in_mvp");
    expect(html).not.toContain("stage_completion_policy");
  });
  it.each([
    { outcome: "invalid_selection" }, { outcome: "failed", reason: "dependency_failure" },
    { outcome: "denied", reason: "policy_denied" }, { outcome: "not_found" },
  ] as const)("讀取失敗無評估內容且可重新檢查：%j", (failure) => {
    const html = render(failure);
    expect(html).toContain('role="alert"');
    expect(html).not.toContain('data-testid="creation-flow-result"');
    expect(html).not.toContain("專案目前階段：");
    expect(html).toContain("重新檢查目標階段");
  });
});
