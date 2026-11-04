import { beforeEach, describe, expect, it, vi } from "vitest";
import { readCreationFlowPageData } from "../../apps/web/src/server/creation-flow-page-data.ts";
import { readOwnedProjectCreationFlowAssessmentSubset } from "../../apps/web/src/server/projects.ts";
import { CREATION_FLOW_STAGES } from "@app-planet/core";
import type { AuthorizationContext } from "../../apps/web/src/server/authorization.ts";

vi.mock("../../apps/web/src/server/projects.ts", () => ({
  readOwnedProjectCreationFlowAssessmentSubset: vi.fn(),
}));
const context: AuthorizationContext = { runReadOnly: async () => { throw new Error("not used"); } };
const id = "10000000-0000-4000-8000-000000000001";
beforeEach(() => {
  vi.mocked(readOwnedProjectCreationFlowAssessmentSubset).mockReset();
  vi.mocked(readOwnedProjectCreationFlowAssessmentSubset).mockResolvedValue({ outcome: "not_found" });
});
describe("目標選擇 strict 投影", () => {
  it.each(CREATION_FLOW_STAGES)("只傳可信 context、專案 ID 與真實目標 %s", async (stage) => {
    await readCreationFlowPageData(context, id, "點子", { requested_stage: stage });
    expect(readOwnedProjectCreationFlowAssessmentSubset).toHaveBeenCalledExactlyOnceWith(context,
      { project_id: id, requested_stage: stage });
  });
  it("省略目標採用當前階段，不變更專案", async () => {
    await readCreationFlowPageData(context, id, "Checkpoint", {});
    expect(readOwnedProjectCreationFlowAssessmentSubset).toHaveBeenCalledExactlyOnceWith(context,
      { project_id: id, requested_stage: "Checkpoint" });
  });
  it.each([
    { requested_stage: "" }, { requested_stage: "Specification " },
    { requested_stage: "approved" }, { requested_stage: ["點子", "A/B"] },
    { requested_stage: "點子", role: "admin" }, { owner: id }, { approved: "true" },
    { completed: "true" }, { evidence: "{}" },
  ])("非法／重複／額外自報欄位不進 reader：%j", async (query) => {
    expect(await readCreationFlowPageData(context, id, "點子", query)).toEqual({ outcome: "invalid_selection" });
    expect(readOwnedProjectCreationFlowAssessmentSubset).not.toHaveBeenCalled();
  });
  it.each([
    { outcome: "failed", reason: "dependency_failure" },
    { outcome: "denied", reason: "policy_denied" },
    { outcome: "not_found" },
  ] as const)("安全結果不替換為成功：%j", async (failure) => {
    vi.mocked(readOwnedProjectCreationFlowAssessmentSubset).mockResolvedValue(failure);
    expect(await readCreationFlowPageData(context, id, "點子", {})).toEqual(failure);
  });
});
