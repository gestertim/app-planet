import { WorkLimitations } from "@/components/project/work-limitations";
import { readWorkLimitationsPageData, scopeRequestId } from "@/server/publishing/work-limitations-page-data";
import { readWorkspacePageData } from "@/server/workspace-page-data";

export const dynamic = "force-dynamic";

export default async function ProjectPublishPage({ params, searchParams }: Readonly<{
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}>) {
  const { id } = await params;
  const requestId = scopeRequestId(await searchParams);
  const [result, workLimitations] = await Promise.all([
    readWorkspacePageData(id),
    readWorkLimitationsPageData(id, "public"),
  ]);
  const scopeState = result.outcome === "found" ? workLimitations.state : { kind: "access_closed" as const };
  return <>
    <WorkLimitations projectId={id} purpose="public" state={scopeState} resultId={workLimitations.resultId}
      requestId={requestId} accountScope={result.outcome === "found" ? result.principal.operationStorageScope : null} />
    {scopeState.kind === "access_closed" && <p className="card" role="alert">
      {result.outcome === "unavailable"
        ? "目前無法重新確認專案權限；受保護內容已隱藏，請稍後重新載入。"
        : result.outcome === "unauthenticated" ? "尚未登入或工作階段已失效。"
          : "找不到這個專案，或目前帳號沒有檢視權限。"}
    </p>}
    {result.outcome === "found" && <>
      <section className="card" aria-label="發布流程狀態" data-testid="publish-workflow-unavailable">
        <h2>發布</h2>
        <p>審查、人工批准、部署及公開網址流程尚未就緒；不提供送審或發布操作。</p>
        <p>此區不會顯示假成果，也沒有可提交或宣稱成功的操作。</p>
      </section>
    </>}
  </>;
}
