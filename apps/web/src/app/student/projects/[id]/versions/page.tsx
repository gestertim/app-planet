import { ProjectFileWorkspace } from "@/components/project/project-file-workspace";
import { readWorkspacePageData } from "@/server/workspace-page-data";

export const dynamic = "force-dynamic";

export default async function ProjectVersionsPage({ params }: Readonly<{ params: Promise<{ id: string }> }>) {
  const { id } = await params;
  const result = await readWorkspacePageData(id);
  if (result.outcome !== "found") return <p className="card" role="alert">
    {result.outcome === "unavailable"
      ? "目前無法重新確認專案權限；受保護內容已隱藏，請稍後重新載入。"
      : result.outcome === "unauthenticated" ? "尚未登入或工作階段已失效。"
        : "找不到這個專案，或目前帳號沒有檢視權限。"}
  </p>;
  return <section className="grid gap-4" aria-label="版本">
    <h1>版本</h1>
    <ProjectFileWorkspace key={`${result.principal.operationStorageScope}:${id}:versions`}
      projectId={result.workspace.project.id}
      accountScope={result.principal.operationStorageScope} />
  </section>;
}
