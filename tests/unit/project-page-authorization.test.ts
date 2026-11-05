import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
const { default: ProjectPage } = await vi.importActual<{
  default: (props: {
    params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | string[] | undefined>>;
  }) => Promise<React.ReactElement>;
}>("../../apps/web/src/app/student/projects/[id]/page.tsx");

const readers = vi.hoisted(() => ({ workspace: vi.fn(), overview: vi.fn(), assessment: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
vi.mock("../../apps/web/src/server/workspace-page-data.ts", () => ({ readWorkspacePageData: readers.workspace }));
vi.mock("../../apps/web/src/server/creation-flow-assessment.ts", () => ({
  readOwnedProjectStageOverviewSubset: readers.overview,
}));
vi.mock("../../apps/web/src/server/creation-flow-page-data.ts", () => ({
  readCreationFlowPageData: readers.assessment,
}));
vi.mock("../../apps/web/src/components/project/workspace-stage-card.tsx", () => ({
  WorkspaceStageCard: ({ draft }: { draft: { content: { text: string } } }) =>
    createElement("p", null, draft.content.text),
}));
vi.mock("../../apps/web/src/components/project/stage-overview.tsx", () => ({
  ProjectStageOverview: () => createElement("p", null, "受保護九階段總覽"),
}));
vi.mock("../../apps/web/src/components/project/creation-flow-check.tsx", () => ({
  CreationFlowCheck: ({ result }: { result: { outcome: string } }) =>
    createElement("p", null, result.outcome),
}));
beforeEach(() => {
  vi.clearAllMocks();
  readers.workspace.mockResolvedValue({
    outcome: "found", principal: { session: { read: {} }, operationStorageScope: "synthetic-scope" },
    workspace: {
      project: { id: "10000000-0000-4000-8000-000000000001", stage: "點子", title: "受保護專案名稱", row_version: 0 },
      requirements: { revision: 1, content: { description: "受保護需求本文" } },
      drafts: [{ stage: "Specification", content: { text: "受保護規格草稿" } }],
    },
  });
  readers.overview.mockResolvedValue({
    outcome: "found", project: { stage: "點子" }, items: [{ stage: "Specification" }],
  });
});
describe("專案頁最後 reader 失權", () => {
  it.each(["denied", "not_found"])("%s 隱藏先前成功讀取的全部保護內容", async (outcome) => {
    readers.assessment.mockResolvedValue({ outcome });
    const html = renderToStaticMarkup(await ProjectPage({
      params: Promise.resolve({ id: "10000000-0000-4000-8000-000000000001" }),
      searchParams: Promise.resolve({}),
    }));
    expect(readers.workspace).toHaveBeenCalledOnce();
    expect(readers.overview).toHaveBeenCalledOnce();
    expect(readers.assessment).toHaveBeenCalledOnce();
    for (const content of ["受保護需求本文", "受保護規格草稿", "受保護九階段總覽", "workspace-blueprint", "重新命名"]) {
      expect(html).not.toContain(content);
    }
    expect(html).toContain("受保護內容已隱藏");
    expect(html).not.toContain("尚未登入");
  });
  it.each(["invalid_selection", "failed", "evaluated"])("%s 保留非失權檢查與導覽", async (outcome) => {
    readers.assessment.mockResolvedValue({ outcome });
    const html = renderToStaticMarkup(await ProjectPage({
      params: Promise.resolve({ id: "10000000-0000-4000-8000-000000000001" }),
      searchParams: Promise.resolve({}),
    }));
    for (const content of ["受保護需求本文", "受保護規格草稿", "受保護九階段總覽", outcome]) {
      expect(html).toContain(content);
    }
    expect(html).toContain('disabled="" aria-expanded="false"');
    expect(html).not.toContain("<form");
  });
});
