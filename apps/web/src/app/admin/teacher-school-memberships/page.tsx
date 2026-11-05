import { AppShell } from "@/components/app-shell";
import { MembershipManagement } from "@/components/auth/membership-management";
import { resolvePagePrincipal } from "@/server/page-principal";
import { readCurrentAccountStatus } from "@/server/auth/account-status";

export const dynamic = "force-dynamic";
export default async function MembershipsPage() {
  const principal = await resolvePagePrincipal();
  if (!principal.ok) return <p role="alert">請先登入有效管理員帳號；目前無法確認權限。</p>;
  const account = await readCurrentAccountStatus(principal.session.read);
  if (account.outcome !== "found" || account.record.role !== "admin" || account.record.status !== "approved"
    || account.record.deletion_state !== "none") return <p role="alert">目前沒有教師學校歸屬管理權限。</p>;
  return <AppShell authenticated preview={false} logoutRedirect="/login" heading="教師學校歸屬管理"
    subtitle="管理既有教師與學校的歸屬；歸屬不是學生查看授權。"
    capabilities={[{ href: "/admin", label: "管理員工作台", prefetch: false },
      { href: "/admin/bindings", label: "師生綁定", prefetch: false }]}>
    <MembershipManagement accountScope={principal.operationStorageScope} />
  </AppShell>;
}
