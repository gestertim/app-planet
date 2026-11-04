import Link from "next/link";
import { notFound } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { resolveTeacherPageSession } from "@/server/teacher-page-access";
import { readTeacherProjectTasks } from "@/server/teacher-resources";

export const dynamic = "force-dynamic";

export default async function TeacherTasksPage({ params, searchParams }: {
  params: Promise<{ studentId: string; projectId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ studentId, projectId }, query] = await Promise.all([params, searchParams]);
  const access = await resolveTeacherPageSession();
  if (access.outcome === "denied") notFound();
  const base = `/teacher/students/${studentId}/projects/${projectId}`;
  if (access.outcome !== "ready") return <p role="alert">目前無法確認教師資格，未顯示任務資料。
    <Link prefetch={false} href={`${base}/tasks`}>重新讀取任務</Link>
  </p>;
  const result = await readTeacherProjectTasks(access.session, studentId, projectId, query);
  if (result.outcome === "not_found" || result.outcome === "invalid_input") notFound();
  if (result.outcome !== "found") return <p role="alert">目前無法重新確認任務權限；內容已隱藏。
    <Link prefetch={false} href={`${base}/tasks`}>重新確認任務權限</Link>
  </p>;
  const { tasks } = result.value;
  return <AppShell authenticated logoutRedirect="/login" preview={false} heading="已保存任務"
    subtitle="唯讀顯示資料庫保存的任務與勾選狀態，不代表整體完成或教師批准。"
    capabilities={[{ href: "/teacher", label: "教師工作台", prefetch: false },
      { href: "/teacher/students", label: "學生名冊", prefetch: false }]}>
    <p><Link prefetch={false} href={base}>返回專案</Link></p>
    {tasks.items.length === 0 && <p>目前沒有已保存任務。</p>}
    <ul>{tasks.items.map((task) => <li key={task.id}>
      {task.done ? "已勾選" : "未勾選"}：{task.title}
    </li>)}</ul>
    {tasks.next_cursor && <Link prefetch={false} href={`${base}/tasks?after=${tasks.next_cursor}`}>
      下一頁任務
    </Link>}
    <Link prefetch={false} href={`${base}/tasks`}>重新讀取第一頁</Link>
  </AppShell>;
}
