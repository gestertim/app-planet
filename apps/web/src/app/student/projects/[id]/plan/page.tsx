import { ProjectTaskImport } from "@/components/project/project-task-import";
import { ProjectTaskList } from "@/components/project/project-task-list";
import { WorkspaceStageCard } from "@/components/project/workspace-stage-card";
import { readOwnedProjectStageOverviewSubset } from "@/server/creation-flow-assessment";
import { listOwnedProjectTasksSubset } from "@/server/project-tasks";
import { readWorkspacePageData } from "@/server/workspace-page-data";

export const dynamic = "force-dynamic";

export default async function ProjectPlanPage({ params }: Readonly<{ params: Promise<{ id: string }> }>) {
  const { id } = await params;
  const result = await readWorkspacePageData(id);
  if (result.outcome !== "found") return <p className="card" role="alert">
    {result.outcome === "unavailable"
      ? "目前無法重新確認專案資料；受保護內容已隱藏，請稍後重新載入。"
      : result.outcome === "unauthenticated" ? "尚未登入或工作階段已失效。"
        : "找不到這個專案，或目前帳號沒有檢視權限。"}
  </p>;
  const [overview, tasks] = await Promise.all([
    readOwnedProjectStageOverviewSubset(result.principal.session.read, id),
    listOwnedProjectTasksSubset(result.principal.session.read, { project_id: id }),
  ]);
  if (overview.outcome !== "found" || tasks.outcome !== "listed") {
    return <p className="card" role="alert">
      目前無法確認計畫、任務或學生確認資料；受保護內容已隱藏，請稍後重新載入。
    </p>;
  }
  const step = overview.items.find((item) => item.stage === "Technical Plan");
  if (!step) return <p className="card" role="alert">無法確認 Technical Plan 階段狀態；內容已隱藏。</p>;
  const draft = result.workspace.drafts.find((item) => item.stage === "Technical Plan") ?? null;
  const revision = crypto.randomUUID();
  return <section className="grid gap-4" aria-label="創作計畫" data-testid="workspace-plan">
    <div className="card">
      <h2>創作計畫</h2>
      <p>任務來自本人手動輸入並確認的清單；P-4 僅保存個別任務完成標記，不會自動推進專案階段。</p>
      <p>匯入待確認操作只保留原操作識別；離開後重新進入仍會恢復原操作，不會自動換鍵。</p>
    </div>
    <WorkspaceStageCard projectId={result.workspace.project.id} stage="Technical Plan"
      draft={draft} overview={step} />
    <ProjectTaskImport key={`${result.principal.operationStorageScope}:${id}:task-import`}
      projectId={result.workspace.project.id}
      storageScope={result.principal.operationStorageScope}
      hasTasks={tasks.tasks.length > 0} />
    <ProjectTaskList key={`${result.principal.operationStorageScope}:${id}:task-list`}
      projectId={result.workspace.project.id} accountScope={result.principal.operationStorageScope}
      initialTasks={tasks.tasks} revision={revision} />
  </section>;
}
