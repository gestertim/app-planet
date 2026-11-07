import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { WorkLimitations } from "../../apps/web/src/components/project/work-limitations.tsx";
import { toWorkLimitationsState } from "../../apps/web/src/components/project/work-limitations-state.ts";
import type { ProjectWorkEligibilityResult } from "../../apps/web/src/server/publishing/eligibility.ts";

const withinScope: ProjectWorkEligibilityResult = {
  outcome: "within_mvp_scope",
  assurance: "current_declared_requirements_only",
  requirements_revision: 4,
  reasons: [],
};

function render(state: ReturnType<typeof toWorkLimitationsState>, purpose: "a1_preview" | "public") {
  return renderToStaticMarkup(
    createElement(WorkLimitations, {
      projectId: "synthetic-project",
      purpose,
      state,
      resultId: "synthetic-result",
      requestId: null,
      accountScope: "synthetic-account",
    }),
  );
}

describe("作品範圍判斷至學生介面白名單狀態", () => {
  it("正向結果只呈現需求範圍，並將預覽尚未開放獨立顯示", () => {
    const state = toWorkLimitationsState(withinScope, "a1_preview");
    const markup = render(state, "a1_preview");

    expect(state).toEqual({ kind: "within_scope" });
    expect(markup).toContain("目前的作品需求符合首版範圍");
    expect(markup).toContain("預覽功能尚未開放");
    expect(markup).not.toContain("已核准");
    expect(markup).not.toContain("可立即預覽");
    expect(markup).toContain('data-testid="work-limitations" data-scope-state="within_scope"');
    expect(markup).toContain('data-testid="work-operation-availability"');
  });

  it("公開訪客限制只在 public 顯示", () => {
    const result: ProjectWorkEligibilityResult = {
      outcome: "outside_mvp_scope",
      assurance: "current_declared_requirements_only",
      requirements_revision: 2,
      reasons: ["tier_b_needs_visitor_identity"],
    };

    expect(toWorkLimitationsState(result, "public")).toEqual({ kind: "public_visitor_identity" });
    expect(render(toWorkLimitationsState(result, "public"), "public"))
      .toContain("首版不提供公開服務");
    expect(toWorkLimitationsState(result, "a1_preview")).toEqual({ kind: "unavailable" });
    expect(render(toWorkLimitationsState(result, "a1_preview"), "a1_preview"))
      .not.toContain("首版不提供公開服務");
  });

  it("分別保留學生伺服器與作品 runtime AI 阻擋原因", () => {
    const serverResult: ProjectWorkEligibilityResult = {
      outcome: "outside_mvp_scope",
      assurance: "current_declared_requirements_only",
      requirements_revision: 3,
      reasons: ["student_server_runtime_not_in_mvp"],
    };
    const aiResult: ProjectWorkEligibilityResult = {
      outcome: "outside_mvp_scope",
      assurance: "current_declared_requirements_only",
      requirements_revision: 5,
      reasons: ["work_runtime_ai_not_in_mvp"],
    };

    expect(render(toWorkLimitationsState(serverResult, "a1_preview"), "a1_preview"))
      .toContain("首版不會執行需要學生伺服器的程式");
    expect(render(toWorkLimitationsState(aiResult, "public"), "public"))
      .toContain("首版不支援作品執行時使用 AI");
    expect(render(toWorkLimitationsState(serverResult, "a1_preview"), "a1_preview"))
      .toContain("不會自動刪除需求或改變 A／B 分類");
  });

  it("未保存、未確認及歷史未驗證分類各自引導回藍圖", () => {
    const results: readonly [ProjectWorkEligibilityResult, string][] = [
      [{ outcome: "requirements_missing", requirements_revision: 0 }, "保存正式需求"],
      [{ outcome: "unconfirmed", requirements_revision: 1 }, "分類確認"],
      [{ outcome: "legacy_unverified" }, "不能當成已通過"],
    ];

    for (const [result, expected] of results) {
      const state = toWorkLimitationsState(result, "public");
      const markup = render(state, "public");
      expect(markup).toContain(expected);
      expect(markup).toContain("/stages/A%2FB");
    }
  });

  it("依賴故障顯示安全重試，拒絕結果不降級成一般範圍提示", () => {
    const dependencyFailure = toWorkLimitationsState(
      { outcome: "failed", reason: "dependency_failure" },
      "public",
    );
    expect(dependencyFailure).toEqual({ kind: "unavailable" });
    expect(render(dependencyFailure, "public"))
      .toContain("目前無法判斷作品範圍");
    expect(render(dependencyFailure, "public"))
      .toContain("/student/projects/synthetic-project/publish");

    for (const result of [
      { outcome: "unauthenticated" },
      { outcome: "denied", reason: "policy_denied" },
      { outcome: "not_found" },
    ] as const) {
      const state = toWorkLimitationsState(result, "a1_preview");
      expect(state).toEqual({ kind: "access_closed" });
      expect(render(state, "a1_preview")).toBe("");
    }
  });
});
