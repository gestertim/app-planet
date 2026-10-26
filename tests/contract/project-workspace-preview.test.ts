import { describe, expect, it } from "vitest";
import {
  assessmentMessages,
  classificationLabel,
  draftLabel,
  projectWorkspacePreviewScenarios,
  projectWorkspaceTabs,
  requirementsLabel,
  resultMessage,
} from "../../apps/web/src/components/project-workspace-preview-model.ts";

describe("學生工作區唯讀合成展示", () => {
  it("合成專案使用不同 ID，並保留需求／分類／草稿三態差異", () => {
    const projects = projectWorkspacePreviewScenarios
      .flatMap((scenario) => scenario.workspaceResult.outcome === "found"
        ? [scenario.workspaceResult.workspace.project]
        : []);
    expect(new Set(projects.map((project) => project.id)).size).toBe(projects.length);
    expect(projects.length).toBeGreaterThanOrEqual(2);

    const unconfirmed = projectWorkspacePreviewScenarios[0].workspaceResult;
    const confirmed = projectWorkspacePreviewScenarios[1].workspaceResult;
    const legacy = projectWorkspacePreviewScenarios[2].workspaceResult;
    if (unconfirmed.outcome !== "found" || confirmed.outcome !== "found" || legacy.outcome !== "found") {
      throw new Error("預期合成的可讀工作區情境");
    }

    expect(requirementsLabel(unconfirmed.workspace)).toBe("尚未建立需求");
    expect(classificationLabel(unconfirmed.workspace.classification)).toBe("分類尚未確認");
    expect(classificationLabel(confirmed.workspace.classification)).toBe("分類已確認（A）");
    expect(classificationLabel(legacy.workspace.classification)).toBe("歷史分類尚未驗證（B）");
    expect(draftLabel(undefined)).toBe("尚無草稿");
    expect(draftLabel(confirmed.workspace.drafts.find((draft) => draft.stage === "點子")))
      .toBe("已保存空白內容｜版本 0");
    expect(draftLabel(confirmed.workspace.drafts.find((draft) => draft.stage === "UX/UI")))
      .toBe("已保存，尚未確認｜版本 3");
  });

  it("七頁籤與九階段資料分開，合成情境沒有未核定的映射", () => {
    expect(projectWorkspaceTabs.map((tab) => tab.label)).toEqual([
      "藍圖", "設計", "計畫", "建立", "測試", "版本", "發布",
    ]);
    const stageNames = projectWorkspacePreviewScenarios
      .flatMap((scenario) => scenario.workspaceResult.outcome === "found"
        ? scenario.workspaceResult.workspace.drafts.map((draft) => draft.stage)
        : []);
    expect(stageNames).toContain("UX/UI");
    const draftStages = new Set<string>(stageNames);
    expect(projectWorkspaceTabs.some((tab) => draftStages.has(tab.label))).toBe(false);
  });

  it("缺少證據與未定規則使用不同、不責備學生的說明", () => {
    const missing = assessmentMessages(projectWorkspacePreviewScenarios[0].assessmentResult);
    const undecided = assessmentMessages(projectWorkspacePreviewScenarios[1].assessmentResult);
    expect(missing).toContain("目前缺少這個階段所需的確認資料。");
    expect(undecided).toContain("這個階段的完成規則尚未開放判定。");
    expect(undecided).toContain("分類資料已確認為 A；這不代表整段旅程完成。");
    expect(undecided.join(" ")).not.toContain("reason");
    expect(undecided.join(" ")).not.toContain("整個旅程已完成");
  });

  it("分類已確認只說明分類，不代表旅程完成或操作獲准", () => {
    const messages = assessmentMessages(projectWorkspacePreviewScenarios[1].assessmentResult).join(" ");
    expect(messages).toContain("分類資料已確認為 A");
    expect(messages).toContain("不代表整段旅程完成");
    expect(messages).toContain("不代表已獲准執行操作");
  });

  it("拒絕、錯誤及不存在情境以安全文字取代內部原因", () => {
    const denied = projectWorkspacePreviewScenarios[3];
    const failed = projectWorkspacePreviewScenarios[4];
    const notFound = projectWorkspacePreviewScenarios[5];
    expect(resultMessage(denied.workspaceResult)).toBe("這個工作區目前無法顯示。");
    expect(resultMessage(failed.workspaceResult)).toBe("目前無法讀取工作區。");
    expect(resultMessage(notFound.workspaceResult)).toBe("找不到這個專案。");
    expect(resultMessage(failed.workspaceResult)).not.toContain("dependency_failure");
  });

  it("拒絕／錯誤／不存在資料不攜帶任何專案工作區", () => {
    for (const scenario of projectWorkspacePreviewScenarios.slice(3)) {
      expect(scenario.workspaceResult.outcome).not.toBe("found");
      expect(JSON.stringify(scenario)).not.toContain("小小生態觀察");
      expect(JSON.stringify(scenario)).not.toContain("紙飛機風向觀察");
      expect(JSON.stringify(scenario)).not.toContain("星空小百科");
    }
  });
});
