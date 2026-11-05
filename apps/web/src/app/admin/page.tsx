import { AppShell } from "@/components/app-shell";
import { ClosedAction } from "@/components/operation-state";
import { AccountGateNotice } from "@/components/auth/account-gate-notice";
import { isApprovedStaff, resolvePageAccount } from "@/server/page-principal";
import { TeacherReview } from "@/components/auth/teacher-review";

// 直接輸入網址須經可信身分與相符角色；教師審核的每次讀寫仍由 DB 重新授權。
export const dynamic = "force-dynamic";

export default async function AdminPage() {
  const account = await resolvePageAccount();
  if (!isApprovedStaff(account, "admin")) return <AccountGateNotice account={account} heading="管理員工作台" />;
  return (
    <AppShell
      authenticated
      logoutRedirect="/login"
      preview={false}
      capabilities={[{ href: "/admin", label: "工作台", prefetch: false }, { href: "/admin/teacher-school-memberships", label: "教師學校歸屬", prefetch: false }, { href: "/admin/bindings", label: "師生綁定", prefetch: false }, { href: "/admin/audit/teacher-views", label: "教師查看紀錄", prefetch: false }, { href: "/account/status", label: "我的帳號狀態" }]}
      heading="管理員工作台"
      subtitle="既有教師審核、教師學校歸屬、師生綁定與教師查看紀錄；其他管理能力尚未接通。"
    >
      <section className="card" data-testid="staff-session" data-role="admin">
        <p>已以管理員身分登入（伺服器確認）。可使用待審教師審核、教師學校歸屬、師生綁定與教師查看紀錄。</p>
      </section>
      <TeacherReview />
      <section className="grid">
        <article className="card">
          <span className="sample-label">合成學校資料</span>
          <h2>示範學校（虛構）</h2>
          <p className="muted">此狀態僅示意未確認畫面，不代表任何真實學校狀態。</p>
          <span className="status">未確認｜畫面示例</span>
          <div className="action-list">
            <ClosedAction label="核准學校" />
            <ClosedAction label="變更核准狀態" />
          </div>
        </article>
        <article className="card">
          <span className="sample-label">平台狀態</span>
          <h2>其他管理功能尚未接通</h2>
          <p className="muted">僅待審教師審核、教師學校歸屬、師生綁定與教師查看紀錄查詢已接通；學校建立／批准、通知、用量管理仍未開放。</p>
          <span className="status">其他管理｜尚未接通</span>
        </article>
      </section>
      <section className="card" style={{ marginTop: "1rem" }}>
        <h2>管理操作</h2>
        <p className="muted">學生帳號核發、預算與通知尚未接通；不會由這些按鈕產生變更。</p>
        <div className="action-list">
          <ClosedAction label="核發學生帳號" />
          <ClosedAction label="調整用量" />
          <ClosedAction label="傳送通知" />
        </div>
      </section>
    </AppShell>
  );
}
