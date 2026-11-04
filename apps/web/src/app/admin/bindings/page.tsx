import { AppShell } from "@/components/app-shell";
import { BindingManagement } from "@/components/auth/binding-management";
import { resolvePagePrincipal } from "@/server/page-principal";
import { readCurrentAccountStatus } from "@/server/auth/account-status";

export const dynamic = "force-dynamic";
export default async function BindingsPage() {
  const principal = await resolvePagePrincipal();
  if (!principal.ok) return <p role="alert">請先登入有效管理員帳號；目前無法確認權限。</p>;
  const account = await readCurrentAccountStatus(principal.session.read);
  if (account.outcome !== "found" || account.record.role !== "admin" || account.record.status !== "approved"
    || account.record.deletion_state !== "none") return <p role="alert">目前沒有師生綁定管理權限。</p>;
  return <AppShell authenticated preview={false} logoutRedirect="/login" heading="師生綁定管理"
    subtitle="建立／解除既有合格師生關係；不開啟其他管理服務。"
    capabilities={[{ href: "/admin", label: "管理員工作台" }, { href: "/admin/bindings", label: "師生綁定" }]}>
    <BindingManagement accountScope={principal.operationStorageScope} />
  </AppShell>;
}
