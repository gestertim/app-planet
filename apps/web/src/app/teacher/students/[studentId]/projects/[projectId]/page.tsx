import Link from "next/link";
import { notFound } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { resolveTeacherPageSession } from "@/server/teacher-page-access";
import { readTeacherProject } from "@/server/teacher-resources";

export const dynamic = "force-dynamic";

export default async function TeacherProjectPage({ params }: {
  params: Promise<{ studentId: string; projectId: string }>;
}) {
  const { studentId, projectId } = await params;
  const access = await resolveTeacherPageSession();
  if (access.outcome === "denied") notFound();
  const base = `/teacher/students/${studentId}/projects/${projectId}`;
  if (access.outcome !== "ready") return <p role="alert">目前無法確認教師資格，未顯示專案內容。
    <Link prefetch={false} href={base}>重新讀取專案內容</Link>
  </p>;
  const result = await readTeacherProject(access.session, studentId, projectId);
  if (result.outcome === "not_found" || result.outcome === "invalid_input") notFound();
  if (result.outcome !== "found") return <p role="alert">目前無法重新確認專案權限，內容已隱藏。
    <Link prefetch={false} href={base}>重新確認專案權限</Link>
  </p>;
  const { project, classification, requirements, stages, specification_review: review, tasks } = result.value;
  return <AppShell authenticated logoutRedirect="/login" preview={false} heading={project.title}
    subtitle="教師唯讀檢視。此頁沒有學生編輯或保存操作；所有資料均來自本次受權讀取。"
    capabilities={[{ href: "/teacher", label: "教師工作台", prefetch: false },
      { href: "/teacher/students", label: "學生名冊", prefetch: false }]}>
    <p><Link prefetch={false} href={`/teacher/students/${studentId}/projects`}>返回專案清單</Link></p>
    <section className="card" aria-label="專案摘要">
      <h2>專案摘要</h2>
      <p>目前階段：{project.stage}</p>
      <p>分類狀態：{classificationLabel(classification.state)}</p>
      {classification.tier && <p>已記錄分類：{classification.tier}</p>}
      {classification.needs_visitor_identity !== null &&
        <p>訪客識別需求：{classification.needs_visitor_identity ? "需要" : "不需要"}</p>}
      {classification.confirmation &&
        <p>學生確認分類時間：{classification.confirmation.confirmed_at}</p>}
      <p>Specification 人工審查：{reviewLabel(review)}</p>
      <p>人工審查只適用 Specification；不是其他階段的批准，也不代表整體完成。</p>
    </section>
    <section className="card" aria-label="正式需求">
      <h2>已保存的正式需求</h2>
      {requirements
        ? <><p>需求版本：{requirements.revision}</p>
          <pre>{requirements.content.description}</pre>
          <p>執行方式：{runtimeLabel(requirements.content.runtime_needs)}</p>
          <p>作品執行時 AI：{requirements.content.runtime_ai_required ? "需求有記錄" : "需求未記錄"}</p></>
        : <p>目前沒有已保存的正式需求。</p>}
    </section>
    <section className="card" aria-label="九階段保存與學生確認摘要">
      <h2>九階段保存與學生確認摘要</h2>
      <p>保存草稿不代表完成；學生確認只證明確認某個保存版本，不是教師批准。</p>
      <ul>{stages.map((stage) => <li key={stage.stage}>
        <Link prefetch={false} href={`${base}/stages/${encodeURIComponent(stage.stage)}`}>
          {stage.stage}：{stage.saved ? `已保存版本 ${stage.row_version}` : "尚無已保存草稿"}；
          {confirmationLabel(stage.student_confirmation)}
        </Link>
      </li>)}</ul>
    </section>
    <section className="card" aria-label="已保存任務">
      <h2>已保存任務與勾選狀態</h2>
      {tasks.items.length === 0 && <p>目前沒有已保存任務。</p>}
      <ul>{tasks.items.map((task) => <li key={task.id}>
        {task.done ? "已勾選" : "未勾選"}：{task.title}
      </li>)}</ul>
      {tasks.next_cursor && <Link prefetch={false} href={`${base}/tasks?after=${tasks.next_cursor}`}>
        查看下一頁任務
      </Link>}
    </section>
  </AppShell>;
}

function classificationLabel(state: "confirmed" | "legacy_unverified" | "unconfirmed"): string {
  if (state === "confirmed") return "學生已明確確認分類";
  if (state === "legacy_unverified") return "舊資料分類尚未驗證";
  return "尚未確認";
}

function reviewLabel(state: "not_submitted" | "pending" | "approved" | "returned" | "invalidated"): string {
  if (state === "approved") return "教師已批准此 Specification 版本";
  if (state === "returned") return "教師已退回此 Specification 版本";
  if (state === "pending") return "等待教師審查";
  if (state === "invalidated") return "先前提交已失效";
  return "尚無提交";
}

function confirmationLabel(state: "not_applicable" | "not_confirmed" | "current" | "stale"): string {
  if (state === "current") return "學生已確認目前保存版本";
  if (state === "stale") return "先前學生確認不再對應目前保存版本";
  if (state === "not_confirmed") return "目前保存版本未確認";
  return "尚無保存草稿";
}

function runtimeLabel(value: "static" | "work_data_api" | "restricted_server"): string {
  if (value === "static") return "靜態內容";
  if (value === "work_data_api") return "平台資料服務";
  return "受限伺服器執行";
}
