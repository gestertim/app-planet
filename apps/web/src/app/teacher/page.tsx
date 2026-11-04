import { AppShell } from "@/components/app-shell";
import Link from "next/link";
import { AccountGateNotice } from "@/components/auth/account-gate-notice";
import { resolvePageAccount } from "@/server/page-principal";
import { resolveTeacherPageSession } from "@/server/teacher-page-access";
import { listSpecificationReviews } from "@/server/specification-review";
import { readTeacherStudents } from "@/server/teacher-resources";

// 直接輸入網址也須經可信身分與相符角色（readiness §90）；Specification 審查維持原有獨立授權。
export const dynamic = "force-dynamic";

export default async function TeacherPage({ searchParams }: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const account = await resolvePageAccount();
  if (account.kind !== "account" || account.record.role !== "teacher" ||
      account.record.status !== "approved" || !account.record.login_gate) {
    return <AccountGateNotice account={account} heading="教師工作台" />;
  }
  const access = await resolveTeacherPageSession();
  if (access.outcome !== "ready") return <p role="alert">目前無法重新確認教師資格；受保護內容已隱藏。
    <Link prefetch={false} href="/teacher">重新讀取教師工作台</Link>
  </p>;
  const students = await readTeacherStudents(access.session, {});
  if (students.outcome !== "found") return <p role="alert">目前無法確認有效學生關係；請重新登入或稍後再試。
    <Link prefetch={false} href="/teacher">重新讀取教師工作台</Link>
  </p>;
  const reviews = await listSpecificationReviews(access.session, await searchParams);
  if (reviews.outcome !== "found") return <p role="alert">無法讀取待審提交；請核對網址或重新登入後再試。
    <Link prefetch={false} href="/teacher">重新讀取教師工作台</Link>
  </p>;
  return (
    <AppShell
      authenticated
      logoutRedirect="/login"
      preview={false}
      capabilities={[{ href: "/teacher", label: "工作台", prefetch: false },
        { href: "/teacher/students", label: "學生名冊", prefetch: false },
        { href: "/account/status", label: "我的帳號狀態", prefetch: false }]}
      heading="教師工作台"
      subtitle="僅檢視目前有效綁定學生的已保存專案資料； Specification 人工審查維持獨立入口。"
    >
      <section className="card" data-testid="staff-session" data-role="teacher">
        <p>已由伺服器確認教師身分。學生與專案資料只供唯讀檢視；這不代表學生已完成或取得教師批准。</p>
      </section>
      <section className="card" aria-label="有效綁定學生">
        <h2>目前有效綁定的學生</h2>
        <p>只列本次重新確認仍符合資格的學生；停用快照與失效學校名冊不在本輪提供。</p>
        {students.value.items.length === 0 && <p>目前沒有可檢視的有效綁定學生。</p>}
        <ul>{students.value.items.map((student) => <li key={student.id}>
          <Link prefetch={false} href={`/teacher/students/${student.id}/projects`}>
            {student.display_label} 的專案
          </Link>
        </li>)}</ul>
        {students.value.next_cursor && <Link prefetch={false}
          href={`/teacher/students?after=${students.value.next_cursor}`}>查看更多學生</Link>}
        <Link prefetch={false} href="/teacher/students">開啟學生名冊</Link>
      </section>
      <section className="card" aria-label="Specification 待審清單">
        <h2>Specification 待審清單</h2>
        <p>依提交順序由舊到新；每頁最多 20 筆，只列目前有效且可審的提交。</p>
        {reviews.items.length === 0 && <p>目前沒有可審的提交。</p>}
        <ul>{reviews.items.map((item) => <li key={item.id}>
          <a href={`/teacher/specification-submissions/${item.id}`}>{item.title} — Specification 版本 {item.draft_version}</a>
          <span>（{item.submitted_at}）</span>
        </li>)}</ul>
        {reviews.next_cursor && <a href={`/teacher?after=${reviews.next_cursor}`}>下一頁待審提交</a>}
        <a href="/teacher">重新讀取第一頁</a>
      </section>
    </AppShell>
  );
}
