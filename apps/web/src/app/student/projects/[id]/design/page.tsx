import { WorkspaceStageCard } from "@/components/project/workspace-stage-card";
import { readOwnedProjectStageOverviewSubset } from "@/server/creation-flow-assessment";
import { readWorkspacePageData } from "@/server/workspace-page-data";

export const dynamic = "force-dynamic";

export default async function ProjectDesignPage({ params }: Readonly<{ params: Promise<{ id: string }> }>) {
  const { id } = await params;
  const result = await readWorkspacePageData(id);
  if (result.outcome !== "found") return <p className="card" role="alert">
    {result.outcome === "unavailable"
      ? "目前無法重新確認專案資料；受保護內容已隱藏，請稍後重新載入。"
      : result.outcome === "unauthenticated" ? "尚未登入或工作階段已失效。"
        : "找不到這個專案，或目前帳號沒有檢視權限。"}
  </p>;
  const overview = await readOwnedProjectStageOverviewSubset(result.principal.session.read, id);
  if (overview.outcome !== "found") return <p className="card" role="alert">
    九階段狀態暫時無法確認；受保護內容已隱藏，請稍後重新載入。
  </p>;
  const step = overview.items.find((item) => item.stage === "UX/UI");
  if (!step) return <p className="card" role="alert">無法確認 UX/UI 階段狀態；內容已隱藏。</p>;
  const draft = result.workspace.drafts.find((item) => item.stage === "UX/UI") ?? null;
  return <section className="grid gap-4" aria-label="畫面設計" data-testid="workspace-design">
    <div className="card">
      <h2>畫面設計</h2>
      <p>此頁接續九階段中的 UX/UI 草稿與學生確認。畫面編輯器、設計預覽與版本化成果尚未就緒。</p>
    </div>
    <WorkspaceStageCard projectId={result.workspace.project.id} stage="UX/UI" draft={draft} overview={step} />
  </section>;
}
