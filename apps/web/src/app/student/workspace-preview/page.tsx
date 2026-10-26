import { AppShell } from "@/components/app-shell";
import { ProjectWorkspacePreview } from "@/components/project-workspace-preview";
import { projectWorkspacePreviewScenarios } from "@/components/project-workspace-preview-model";

export default function StudentWorkspacePreviewPage() {
  return (
    <AppShell
      heading="學生專案工作區"
      subtitle="瀏覽唯讀的合成專案資料與尚未開放的功能。"
    >
      <ProjectWorkspacePreview scenarios={projectWorkspacePreviewScenarios} />
    </AppShell>
  );
}
