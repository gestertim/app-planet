import Link from "next/link";
import { projectStageSchema } from "@app-planet/core";
import type { StageOverviewItem, StageOverviewState } from "@/server/creation-flow-assessment";

const stateLabel: Record<StageOverviewState, string> = {
  no_draft: "尚無已保存內容",
  unconfirmed: "已保存，尚未由學生確認",
  confirmed_current: "學生確認目前有效（僅表示確認該保存版本）",
  confirmation_stale: "保存版本已變，先前確認已失效",
};

export function stageStateLabel(state: StageOverviewState): string {
  return stateLabel[state];
}

export function ProjectStageOverview({ projectId, items, currentStage, completionJudgment }: Readonly<{
  projectId: string;
  items: readonly StageOverviewItem[];
  currentStage: string;
  completionJudgment: "unsupported_rules_undecided" | "missing_classification_evidence";
}>) {
  return <section className="card" aria-label="九階段總覽" data-testid="stage-overview">
    <h2>九階段總覽</h2>
    <p>以下狀態來自伺服器同一次讀取的已保存草稿與學生確認證據；學生確認不等於階段完成，也不是人工批准。</p>
    <p data-testid="completion-judgment">{completionJudgment === "unsupported_rules_undecided"
      ? "階段完成判斷：完成規則尚未決議，保持阻擋（不影響保存與讀取）。"
      : "階段完成判斷：缺少已確認的分類證據，保持阻擋。"}</p>
    <ol>{items.map((item) => <li key={item.stage} data-testid={`stage-row-${item.order}`}
      data-state={item.state}>
      <strong>{item.order}. {item.stage}</strong>
      {item.stage === currentStage ? <span>（專案目前階段）</span> : null}
      <span> — <span data-testid="stage-state">{stateLabel[item.state]}</span></span>
      {item.draft_row_version !== null ? <span>｜已保存版本 {item.draft_row_version}</span> : null}
      {item.confirmed_row_version !== null
        ? <span>｜{item.state === "confirmed_current" ? "確認版本" : "最近確認版本"} {item.confirmed_row_version}</span> : null}
      <span>｜人工批准：尚未取得／尚未開放</span>
      <span> — <Link prefetch={false} href={`/student/projects/${projectId}/stages/${encodeURIComponent(item.stage)}`}>
        開啟 {item.stage} 草稿</Link></span>
    </li>)}</ol>
    <p>開啟草稿不代表已解鎖執行、預覽或發布；IDE、測試、版本與發布能力尚未就緒。</p>
  </section>;
}

export function StageNav({ projectId, current }: Readonly<{ projectId: string; current: string }>) {
  return <nav aria-label="九階段導覽" className="card" data-testid="stage-nav">
    <Link prefetch={false} href={`/student/projects/${projectId}`}>回到九階段總覽</Link>
    <ol>{projectStageSchema.options
      .map((stage) => <li key={stage}>{stage === current
        ? <span aria-current="page">{stage}（目前）</span>
        : <Link prefetch={false} href={`/student/projects/${projectId}/stages/${encodeURIComponent(stage)}`}>{stage}</Link>}</li>)}</ol>
  </nav>;
}
