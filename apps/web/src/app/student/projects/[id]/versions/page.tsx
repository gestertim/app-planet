import { WorkspaceNotReady } from "@/components/project/workspace-not-ready";

export const dynamic = "force-dynamic";

export default async function ProjectVersionsPage({ params }: Readonly<{ params: Promise<{ id: string }> }>) {
  const { id } = await params;
  return <WorkspaceNotReady projectId={id} title="版本"
    reason="不可變版本、快照與恢復流程尚未就緒；不顯示假版本或恢復按鈕。" />;
}
