import { AppShell } from "@/components/app-shell";
import { TeacherRelationshipNotice } from "@/components/auth/teacher-relationship-notice";
import { ProtectedProjectView } from "@/components/project/protected-project-view";
import { SevenTabs } from "@/components/project/seven-tabs";
import { ProjectExportDownload } from "@/components/project/project-export-download";
import { readWorkspacePageData } from "@/server/workspace-page-data";

export const dynamic = "force-dynamic";

type LayoutProps = Readonly<{
  params: Promise<{ id: string }>;
  children: React.ReactNode;
}>;

export default async function ProjectWorkspaceLayout({ params, children }: LayoutProps) {
  const { id } = await params;
  const result = await readWorkspacePageData(id);
  if (result.outcome !== "found") {
    const message = result.outcome === "unauthenticated"
      ? "尚未登入或工作階段已失效。"
      : result.outcome === "unavailable"
        ? "目前無法確認登入、資料庫或專案服務；受保護資料已隱藏，請稍後重新載入。"
        : "找不到這個專案，或目前帳號沒有檢視權限。";
    return <main className="main" data-testid="project-workspace-closed">
      <h1>無法開啟專案</h1>
      <p role="alert">{message}</p>
    </main>;
  }

  const { workspace } = result;
  const classification = workspace.classification.state === "confirmed"
    ? `已確認 ${workspace.classification.tier}`
    : workspace.classification.state === "unconfirmed" ? "未分類" : "歷史分類未驗證";
  return <ProtectedProjectView revision={crypto.randomUUID()}>
    <AppShell authenticated preview={false} heading={workspace.project.title}
      subtitle="每個頁面與資料操作都會由伺服器重新確認登入、帳號資格及專案權限。"
      capabilities={[{ href: "/student", label: "工作台" }]}>
      <section className="card" aria-label="專案脈絡" data-testid="workspace-project-context">
        <h2>專案脈絡</h2>
        <p>專案 ID：<code data-testid="workspace-project-id">{workspace.project.id}</code></p>
        <p>分類：{classification}</p>
        <p>目前創作步驟：{workspace.project.stage}</p>
        <p>專案資料版本：{workspace.project.row_version}
          {workspace.requirements ? `；需求版本：${workspace.requirements.revision}` : "；尚無需求版本"}</p>
        <p>草稿與學生確認屬各自的階段內容；學生確認不代表階段完成或人工批准。</p>
      </section>
      <TeacherRelationshipNotice />
      <ProjectExportDownload key={`${result.principal.operationStorageScope}:${workspace.project.id}`}
        projectId={workspace.project.id} />
      <SevenTabs projectId={workspace.project.id} />
      {children}
    </AppShell>
  </ProtectedProjectView>;
}
