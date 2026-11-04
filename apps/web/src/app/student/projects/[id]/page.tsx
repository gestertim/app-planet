import { ProjectStageOverview } from "@/components/project/stage-overview";
import { WorkspaceStageCard } from "@/components/project/workspace-stage-card";
import { readOwnedProjectStageOverviewSubset } from "@/server/creation-flow-assessment";
import { readWorkspacePageData } from "@/server/workspace-page-data";
import { readCreationFlowPageData } from "@/server/creation-flow-page-data";
import { CreationFlowCheck } from "@/components/project/creation-flow-check";

export const dynamic = "force-dynamic";

export default async function ProjectPage({ params, searchParams }: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await params;
  const result = await readWorkspacePageData(id);
  if (result.outcome !== "found") return <p className="card" role="alert">
    {result.outcome === "unavailable"
      ? "目前無法重新確認專案資料；受保護內容已隱藏，請稍後重新載入。"
      : result.outcome === "unauthenticated" ? "尚未登入或工作階段已失效。"
        : "找不到這個專案，或目前帳號沒有檢視權限。"}
  </p>;
  const overview = await readOwnedProjectStageOverviewSubset(result.principal.session.read, result.workspace.project.id);
  if (overview.outcome !== "found") return <p className="card" role="alert">
    {overview.outcome === "failed"
      ? "九階段狀態暫時無法確認；受保護內容已隱藏，請稍後重新載入。"
      : "找不到這個專案，或目前帳號沒有檢視權限。"}
  </p>;
  const specification = overview.items.find((item) => item.stage === "Specification");
  if (!specification) return <p className="card" role="alert">無法確認 Specification 階段狀態；內容已隱藏。</p>;
  const draft = result.workspace.drafts.find((item) => item.stage === "Specification") ?? null;
  const assessment = await readCreationFlowPageData(result.principal.session.read,
    result.workspace.project.id, result.workspace.project.stage, await searchParams);
  if (assessment.outcome === "denied" || assessment.outcome === "not_found") {
    return <p className="card" role="alert">找不到這個專案，或目前帳號沒有檢視權限；受保護內容已隱藏。</p>;
  }
  return <section className="grid gap-4" aria-label="我的藍圖" data-testid="workspace-blueprint">
    <div className="card">
      <h2>我的藍圖</h2>
      <p>此區呈現專案基本資料與九階段創作步驟；學生確認、階段完成判斷及人工批准彼此分開。</p>
      {result.workspace.requirements
        ? <p>需求版本 {result.workspace.requirements.revision}：{result.workspace.requirements.content.description}</p>
        : <p>尚無已確認的需求版本；不會把草案當成正式分類或批准。</p>}
    </div>
    <CreationFlowCheck projectId={result.workspace.project.id} result={assessment} />
    <WorkspaceStageCard projectId={result.workspace.project.id} stage="Specification"
      draft={draft} overview={specification} />
    <ProjectStageOverview projectId={result.workspace.project.id} items={overview.items}
      currentStage={overview.project.stage} completionJudgment={overview.completion_judgment} />
  </section>;
}
