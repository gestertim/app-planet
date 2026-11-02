import { WorkspaceNotReady } from "@/components/project/workspace-not-ready";

export const dynamic = "force-dynamic";

export default async function ProjectBuildPage({ params }: Readonly<{ params: Promise<{ id: string }> }>) {
  const { id } = await params;
  return <WorkspaceNotReady projectId={id} title="建立 App"
    reason="IDE、檔案保存、Coding Agent 與私人預覽尚未就緒；不提供假編輯器或執行按鈕。" />;
}
