import Link from "next/link";
import { notFound } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { decodeStageParam } from "@/server/stage-param";
import { resolveTeacherPageSession } from "@/server/teacher-page-access";
import { readTeacherStageDraft } from "@/server/teacher-resources";

export const dynamic = "force-dynamic";

export default async function TeacherStagePage({ params }: {
  params: Promise<{ studentId: string; projectId: string; stage: string }>;
}) {
  const { studentId, projectId, stage: encodedStage } = await params;
  const stage = decodeStageParam(encodedStage);
  const access = await resolveTeacherPageSession();
  if (access.outcome === "denied") notFound();
  const base = `/teacher/students/${studentId}/projects/${projectId}`;
  const retryHref = `${base}/stages/${encodeURIComponent(stage)}`;
  if (access.outcome !== "ready") return <p role="alert">目前無法確認教師資格，未顯示草稿。
    <Link prefetch={false} href={retryHref}>重新讀取階段草稿</Link>
  </p>;
  const result = await readTeacherStageDraft(access.session, studentId, projectId, stage);
  if (result.outcome === "not_found" || result.outcome === "invalid_input") notFound();
  if (result.outcome !== "found") return <p role="alert">目前無法重新確認草稿權限，內容已隱藏。
    <Link prefetch={false} href={retryHref}>重新確認階段草稿權限</Link>
  </p>;
  const draft = result.value;
  return <AppShell authenticated logoutRedirect="/login" preview={false}
    heading={`${draft.stage} 階段草稿`}
    subtitle="唯讀內容只代表資料庫中目前保存的草稿，不會因為存在或已確認而自動完成或獲得批准。"
    capabilities={[{ href: "/teacher", label: "教師工作台", prefetch: false },
      { href: "/teacher/students", label: "學生名冊", prefetch: false }]}>
    <p><Link prefetch={false} href={base}>返回專案</Link></p>
    {draft.saved
      ? <section className="card" aria-label="已保存草稿">
          <h2>已保存版本 {draft.row_version}</h2>
          <p>學生確認狀態：{confirmationLabel(draft.student_confirmation)}</p>
          {draft.confirmed_at && <p>確認紀錄時間：{draft.confirmed_at}</p>}
          <pre>{draft.content?.text}</pre>
        </section>
      : <section className="card" aria-label="無已保存草稿">
          <h2>尚無已保存草稿</h2>
          <p>目前沒有可供檢視的保存內容。</p>
        </section>}
    <p>學生確認不是教師批准；Specification 人工審查只會顯示於專案摘要，且不代表其他階段批准。</p>
  </AppShell>;
}

function confirmationLabel(state: "not_applicable" | "not_confirmed" | "current" | "stale"): string {
  if (state === "current") return "已確認目前保存版本";
  if (state === "stale") return "舊確認已不再對應目前版本";
  if (state === "not_confirmed") return "目前保存版本尚未確認";
  return "無適用確認（尚無保存內容）";
}
