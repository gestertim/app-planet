import Link from "next/link";
import { notFound } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { resolveTeacherPageSession } from "@/server/teacher-page-access";
import { readTeacherStudents } from "@/server/teacher-resources";

export const dynamic = "force-dynamic";

export default async function TeacherStudentsPage({ searchParams }: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const access = await resolveTeacherPageSession();
  if (access.outcome === "denied") notFound();
  if (access.outcome !== "ready") return <p role="alert">目前無法重新確認教師資格，未顯示學生資料。
    <Link prefetch={false} href="/teacher/students">重新讀取學生名冊</Link>
  </p>;
  const query = await searchParams;
  const page = await readTeacherStudents(access.session, query);
  if (page.outcome === "not_found" || page.outcome === "invalid_input") notFound();
  if (page.outcome !== "found") {
    const retry = new URLSearchParams();
    if (typeof query.after === "string") retry.set("after", query.after);
    if (typeof query.limit === "string") retry.set("limit", query.limit);
    const suffix = retry.toString();
    return <p role="alert">目前無法讀取學生名冊；未顯示舊資料。
      <Link prefetch={false} href={`/teacher/students${suffix ? `?${suffix}` : ""}`}>重新讀取學生名冊</Link>
    </p>;
  }
  return <AppShell authenticated logoutRedirect="/login" preview={false} heading="有效綁定學生"
    subtitle="學生代號由系統產生；每次載入都重新核對教師、學生、學校、membership 與綁定資格。"
    capabilities={[{ href: "/teacher", label: "教師工作台", prefetch: false },
      { href: "/teacher/students", label: "學生名冊", prefetch: false }]}>
    <section className="card" aria-label="學生名冊">
      {page.value.items.length === 0 && <p>目前沒有可檢視的有效綁定學生。</p>}
      <ul>{page.value.items.map((student) => <li key={student.id}>
        <Link prefetch={false} href={`/teacher/students/${student.id}/projects`}>
          {student.display_label}：查看專案
        </Link>
      </li>)}</ul>
      {page.value.next_cursor && <Link prefetch={false}
        href={`/teacher/students?after=${page.value.next_cursor}`}>下一頁學生</Link>}
      <Link prefetch={false} href="/teacher/students">重新讀取第一頁</Link>
    </section>
  </AppShell>;
}
