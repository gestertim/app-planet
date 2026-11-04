import Link from "next/link";
import type { StageOverviewItem } from "@/server/creation-flow-assessment";
import type { OwnedProjectWorkspaceDto } from "@/server/project-workspace";
import { stageStateLabel } from "./stage-overview";

type WorkspaceDraft = OwnedProjectWorkspaceDto["drafts"][number];

export function WorkspaceStageCard({ projectId, stage, draft, overview }: Readonly<{
  projectId: string;
  stage: StageOverviewItem["stage"];
  draft: WorkspaceDraft | null;
  overview: StageOverviewItem;
}>) {
  const consistent = draft?.row_version === overview.draft_row_version ||
    (draft === null && overview.draft_row_version === null);
  return <section className="card" aria-label={`${stage}階段草稿與確認`} data-testid={`workspace-stage-${stage}`}>
    <h3>{stage} 階段內容</h3>
    {!consistent
      ? <p role="status">階段資料在讀取期間更新；為避免混用不同版本，請重新載入。</p>
      : <>
        <p>狀態：{stageStateLabel(overview.state)}</p>
        <p>學生確認只適用於確切已保存版本；
          {stage === "Specification" ? "Specification 教師審查請至保存頁讀取獨立狀態。" : "人工批准尚未取得／尚未開放。"}</p>
        {draft
          ? <div><p>已保存版本：{draft.row_version}</p>
            <p>內容來源：{draft.content_source === "student_input" ? "學生輸入" : "AI 草案"}</p>
            <pre className="whitespace-pre-wrap">{draft.content.text}</pre></div>
          : <p>尚無已保存草稿；不會顯示示例作品。</p>}
      </>}
    <Link prefetch={false} href={`/student/projects/${projectId}/stages/${encodeURIComponent(stage)}`}>
      開啟 {stage} 草稿與學生確認
    </Link>
  </section>;
}
