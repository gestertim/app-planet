import { AppShell } from "@/components/app-shell";
import { SchoolManagement } from "@/components/auth/school-management";
import { resolvePagePrincipal } from "@/server/page-principal";
import { readCurrentAccountStatus } from "@/server/auth/account-status";
import { notFound } from "next/navigation";
import { z } from "zod";

export const dynamic = "force-dynamic";
export default async function SchoolPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!z.uuid().safeParse(id).success) notFound();
  const principal = await resolvePagePrincipal();
  if (!principal.ok) return <p role="alert">請先登入有效管理員帳號；目前無法確認權限。</p>;
  const account = await readCurrentAccountStatus(principal.session.read);
  if (account.outcome !== "found" || account.record.role !== "admin" || account.record.status !== "approved"
    || account.record.deletion_state !== "none") return <p role="alert">目前沒有學校管理權限。</p>;
  return <AppShell authenticated preview={false} logoutRedirect="/login" heading="學校詳情"
    subtitle="從 DB 讀回目前狀態；登錄不是核驗。"
    capabilities={[{ href: "/admin", label: "管理員工作台", prefetch: false },
      { href: "/admin/schools", label: "學校列表", prefetch: false }]}>
    <SchoolManagement accountScope={principal.operationStorageScope} schoolId={id.toLowerCase()} />
  </AppShell>;
}
