import Link from "next/link";
import { AppShell } from "@/components/app-shell";
import { AccountGateNotice } from "@/components/auth/account-gate-notice";
import { resolvePageAccount } from "@/server/page-principal";
import type { AccountStatusRecord } from "@/server/auth/account-status";

export const dynamic = "force-dynamic";

const roleLabels = { student: "學生", teacher: "教師", admin: "管理員" } as const;

function restrictedMessage(record: AccountStatusRecord): { title: string; detail: string } | null {
  switch (record.status) {
    case "pending":
      return { title: "帳號待審核", detail: "你的帳號尚未通過審核；在核准前只能查看本頁的帳號狀態。" };
    case "rejected":
      return { title: "帳號申請未通過", detail: "你的帳號申請未獲核准；目前只能查看本頁的帳號狀態。如有疑問請聯絡平台管理員。" };
    case "disabled":
      return { title: "帳號已停用", detail: "這個帳號目前無法使用平台功能；請聯絡學校或平台管理員確認。" };
    default:
      return null;
  }
}

function homeFor(record: AccountStatusRecord): { href: string; label: string } | null {
  if (record.status !== "approved" || !record.login_gate) return null;
  if (record.role === "teacher") return { href: "/teacher", label: "前往教師工作台" };
  if (record.role === "admin") return { href: "/admin", label: "前往管理員工作台" };
  return { href: "/student", label: "前往學生工作台" };
}

export default async function AccountStatusPage() {
  const account = await resolvePageAccount();
  if (account.kind !== "account") return <AccountGateNotice account={account} heading="我的帳號狀態" />;
  const record = account.record;
  const restricted = restrictedMessage(record);
  const home = homeFor(record);
  return (
    <AppShell authenticated logoutRedirect="/login" preview={false} heading="我的帳號狀態" subtitle="以下狀態由伺服器即時確認，只顯示你自己的帳號。"
      capabilities={home ? [{ href: home.href, label: "工作台" }] : []}>
      <section className="card" data-testid="account-status" data-account-status={record.status} data-role={record.role}>
        <p>角色：{roleLabels[record.role]}</p>
        {restricted ? (
          <div role="status">
            <h2>{restricted.title}</h2>
            <p>{restricted.detail}</p>
          </div>
        ) : (
          <div role="status">
            <h2>帳號已核准</h2>
            {home ? <Link className="button-link" href={home.href}>{home.label}</Link>
              : <p>目前無法使用工作台；請稍後重新載入或聯絡管理員。</p>}
          </div>
        )}
      </section>
    </AppShell>
  );
}
