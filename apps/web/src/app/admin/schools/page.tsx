import { AppShell } from "@/components/app-shell";
import { SchoolManagement } from "@/components/auth/school-management";
import { resolvePagePrincipal } from "@/server/page-principal";
import { readCurrentAccountStatus } from "@/server/auth/account-status";

export const dynamic = "force-dynamic";
export default async function SchoolsPage() {
  const principal = await resolvePagePrincipal();
  if (!principal.ok) return <p role="alert">請先登入有效管理員帳號；目前無法確認權限。</p>;
  const account = await readCurrentAccountStatus(principal.session.read);
  if (account.outcome !== "found" || account.record.role !== "admin" || account.record.status !== "approved"
    || account.record.deletion_state !== "none") return <p role="alert">目前沒有學校管理權限。</p>;
  return <AppShell authenticated preview={false} logoutRedirect="/login" heading="學校管理"
    subtitle="只登錄未確認學校，不核准學校身分。"
    capabilities={[{ href: "/admin", label: "管理員工作台", prefetch: false }]}>
    <SchoolManagement accountScope={principal.operationStorageScope} />
  </AppShell>;
}
