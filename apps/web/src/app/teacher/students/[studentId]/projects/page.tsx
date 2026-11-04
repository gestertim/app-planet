import Link from "next/link";
import { notFound } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { resolveTeacherPageSession } from "@/server/teacher-page-access";
import { readTeacherStudentProjects } from "@/server/teacher-resources";

export const dynamic = "force-dynamic";

export default async function TeacherStudentProjectsPage({ params, searchParams }: {
  params: Promise<{ studentId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ studentId }, query] = await Promise.all([params, searchParams]);
  const access = await resolveTeacherPageSession();
  if (access.outcome === "denied") notFound();
  if (access.outcome !== "ready") return <p role="alert">目前無法確認教師資格，未顯示專案資料。
    <Link prefetch={false} href={`/teacher/students/${studentId}/projects`}>重新讀取專案清單</Link>
  </p>;
  const page = await readTeacherStudentProjects(access.session, studentId, query);
  if (page.outcome === "not_found" || page.outcome === "invalid_input") notFound();
  if (page.outcome !== "found") {
    const retry = new URLSearchParams();
    if (typeof query.after === "string") retry.set("after", query.after);
    if (typeof query.limit === "string") retry.set("limit", query.limit);
    const suffix = retry.toString();
    return <p role="alert">目前無法讀取專案；未顯示舊資料。
      <Link prefetch={false}
        href={`/teacher/students/${studentId}/projects${suffix ? `?${suffix}` : ""}`}>重新讀取專案清單</Link>
    </p>;
  }
  return <AppShell authenticated logoutRedirect="/login" preview={false} heading="學生專案"
    subtitle="僅顯示目前有效綁定學生的真實專案；開啟項目時會留下不含內容的查看稽核。"
    capabilities={[{ href: "/teacher", label: "教師工作台", prefetch: false },
      { href: "/teacher/students", label: "學生名冊", prefetch: false }]}>
    <section className="card" aria-label="專案清單">
      <Link prefetch={false} href="/teacher/students">返回學生名冊</Link>
      {page.value.items.length === 0 && <p>這位學生目前沒有已保存專案。</p>}
      <ul>{page.value.items.map((project) => <li key={project.id}>
        <Link prefetch={false}
          href={`/teacher/students/${studentId}/projects/${project.id}`}>
          {project.title}（目前階段：{project.stage}；分類：{classificationLabel(project.classification_state)}）
        </Link>
      </li>)}</ul>
      {page.value.next_cursor && <Link prefetch={false}
        href={`/teacher/students/${studentId}/projects?after=${page.value.next_cursor}`}>下一頁專案</Link>}
      <Link prefetch={false} href={`/teacher/students/${studentId}/projects`}>重新讀取第一頁</Link>
    </section>
  </AppShell>;
}

function classificationLabel(value: "unconfirmed" | "legacy_unverified" | "confirmed"): string {
  if (value === "confirmed") return "已由學生確認分類";
  if (value === "legacy_unverified") return "舊資料未驗證分類";
  return "尚未確認分類";
}
