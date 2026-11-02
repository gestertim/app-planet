import { WorkspaceNotReady } from "@/components/project/workspace-not-ready";

export const dynamic = "force-dynamic";

export default async function ProjectTestPage({ params }: Readonly<{ params: Promise<{ id: string }> }>) {
  const { id } = await params;
  return <WorkspaceNotReady projectId={id} title="測試"
    reason="作品測試執行與版本綁定結果尚未就緒；沒有測試通過或失敗的假結果。" />;
}
