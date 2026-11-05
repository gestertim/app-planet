import { AppShell } from "@/components/app-shell";
import { resolvePagePrincipal } from "@/server/page-principal";
import { readAdminTeacherViews } from "@/server/admin/teacher-view-audit";

export const dynamic = "force-dynamic";
const path = "/admin/audit/teacher-views";
type Search = Record<string, string | string[] | undefined>;

export default async function TeacherViewAuditPage({ searchParams }: { searchParams: Promise<Search> }) {
  const principal = await resolvePagePrincipal();
  if (!principal.ok) return <p role="alert">請先登入有效管理員帳號；目前無法確認權限。</p>;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(await searchParams)) {
    if (Array.isArray(value)) value.forEach((item) => params.append(key, item));
    else if (value !== undefined) params.append(key, value);
  }
  // Empty GET form fields mean no filter; the API itself still rejects empty UUIDs.
  for (const key of ["teacher_id", "student_id"]) {
    if (params.getAll(key).length === 1 && params.get(key) === "") params.delete(key);
  }
  const result = await readAdminTeacherViews(principal.session, params);
  if (result.outcome === "denied") return <p role="alert">目前沒有教師查看紀錄查詢權限。</p>;
  const nextParams = new URLSearchParams(params);
  if (result.outcome === "found" && result.next_cursor) nextParams.set("after", result.next_cursor);
  return <AppShell authenticated preview={false} logoutRedirect="/login" heading="教師查看紀錄"
    subtitle="僅顯示教師代號、學生代號與查看時間；歷史紀錄不以目前綁定為條件。"
    capabilities={[{ href: "/admin", label: "管理員工作台", prefetch: false }]}>
    <form method="get" action={path} className="card">
      <label>教師 UUID（查詢條件，非顯示名稱）
        <input name="teacher_id" defaultValue={params.get("teacher_id") ?? ""} />
      </label>
      <label>學生 UUID（查詢條件，非顯示名稱）
        <input name="student_id" defaultValue={params.get("student_id") ?? ""} />
      </label>
      <button type="submit">查詢</button>
      <a href={path}>清除篩選</a>
    </form>
    {result.outcome !== "found" ? <section role="alert" className="card">
      <p>{result.outcome === "invalid_input" ? "篩選或分頁格式不正確，請清除或重新查詢。"
        : "目前無法讀取查看紀錄；未顯示先前結果，請重新讀取。"} </p>
      <a href={`${path}?${params.toString()}`}>重新讀取</a>
    </section> : <section className="card" aria-label="教師查看紀錄結果">
      {result.items.length === 0 ? <p>沒有符合條件的查看紀錄。</p> : <table>
        <thead><tr><th>教師代號</th><th>學生代號</th><th>查看時間（UTC）</th></tr></thead>
        <tbody>{result.items.map((item, index) => <tr key={index}>
          <td>{item.teacher_label}</td><td>{item.student_label}</td>
          <td><time dateTime={item.viewed_at}>{item.viewed_at}（UTC）</time></td>
        </tr>)}</tbody>
      </table>}
      {result.next_cursor && <a href={`${path}?${nextParams.toString()}`}>下一頁</a>}
      {params.has("after") && <a href={`${path}?${new URLSearchParams(
        [...params].filter(([key]) => key !== "after")).toString()}`}>回到第一頁</a>}
    </section>}
  </AppShell>;
}
