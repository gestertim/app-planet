import { AppShell } from "@/components/app-shell";
import { SpecificationReviewPanel } from "@/components/project/specification-review-panel";
import { resolvePagePrincipal } from "@/server/page-principal";
import { readSpecificationReview } from "@/server/specification-review";

export const dynamic = "force-dynamic";
export default async function SpecificationReviewPage({ params }: { params: Promise<{ id: string }> }) {
  const principal = await resolvePagePrincipal();
  if (!principal.ok) return <p role="alert">尚未登入或目前無法確認存取權限。</p>;
  const { id } = await params;
  const result = await readSpecificationReview(principal.session, id);
  if (result.outcome !== "found") return <p role="alert">找不到這筆可見提交，或目前無法確認審查資格。</p>;
  return <AppShell authenticated logoutRedirect="/login" preview={false} heading="Specification 審查"
    subtitle="核對不可變提交後，明確批准或退回。" capabilities={[{ href: "/teacher", label: "教師工作台" }]}>
    <SpecificationReviewPanel key={`${principal.operationStorageScope}:${id}`} mode="decide" target={id}
      accountScope={principal.operationStorageScope} initial={result.submission} />
  </AppShell>;
}
