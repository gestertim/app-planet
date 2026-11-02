import { WorkspaceNotReady } from "@/components/project/workspace-not-ready";

export const dynamic = "force-dynamic";

export default async function ProjectPublishPage({ params }: Readonly<{ params: Promise<{ id: string }> }>) {
  const { id } = await params;
  return <WorkspaceNotReady projectId={id} title="發布"
    reason="審查、人工批准、部署及公開網址流程尚未就緒；不提供送審或發布操作。" />;
}
