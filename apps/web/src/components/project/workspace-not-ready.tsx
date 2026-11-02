import { readWorkspacePageData } from "@/server/workspace-page-data";

export async function WorkspaceNotReady({ projectId, title, reason }: Readonly<{
  projectId: string;
  title: string;
  reason: string;
}>) {
  const result = await readWorkspacePageData(projectId);
  if (result.outcome !== "found") {
    return <p className="card" role="alert">
      {result.outcome === "unavailable"
        ? "目前無法重新確認專案權限；受保護內容已隱藏，請稍後重新載入。"
        : result.outcome === "unauthenticated" ? "尚未登入或工作階段已失效。"
          : "找不到這個專案，或目前帳號沒有檢視權限。"}
    </p>;
  }
  return <section className="card" data-testid={`workspace-unready-${projectId}`}>
    <h2>{title}</h2>
    <p>{reason}</p>
    <p>此區不會顯示假成果，也沒有可提交或宣稱成功的操作。</p>
  </section>;
}
