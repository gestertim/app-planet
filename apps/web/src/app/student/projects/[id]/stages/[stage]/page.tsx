import { projectStageSchema, readStageDraftInputSchema } from "@app-planet/core";
import { StageDraftEditor } from "@/components/project/stage-draft-editor";
import { decodeStageParam } from "@/server/stage-param";
import { StageNav } from "@/components/project/stage-overview";
import { authorizeCapability } from "@/server/authorization";
import { resolvePagePrincipal } from "@/server/page-principal";
import { readOwnedStageDraftSubset } from "@/server/stage-drafts";
import { readOwnedStageConfirmationStatus } from "@/server/stage-draft-confirmations";
import { readCurrentOwnedProjectClassificationSubset } from "@/server/projects";

export const dynamic = "force-dynamic";

type PageProps = {
  params: Promise<{ id: string; stage: string }>;
};

function ClosedMessage({ children }: Readonly<{ children: React.ReactNode }>) {
  return <p className="card" role="status">{children}</p>;
}

export default async function StageDraftPage({ params }: PageProps) {
  const { id, stage: rawStage } = await params;
  const stage = decodeStageParam(rawStage);
  const target = readStageDraftInputSchema.safeParse({ project_id: id, stage });
  if (!target.success || !projectStageSchema.safeParse(stage).success) {
    return <ClosedMessage>找不到這份內容，或目前帳號沒有檢視權限。</ClosedMessage>;
  }

  const principal = await resolvePagePrincipal();
  if (!principal.ok) {
    return <ClosedMessage>
      {principal.reason === "unauthenticated"
        ? "尚未登入或工作階段已失效；請使用核准的登入流程。"
        : "目前無法確認登入狀態；受保護資料不會顯示。"}
    </ClosedMessage>;
  }

  const gate = await authorizeCapability(principal.session.read, "edit_saved_content");
  if (gate.outcome !== "allowed") {
    return <ClosedMessage>目前帳號沒有編輯權限，或無法確認帳號資格。</ClosedMessage>;
  }

  const project = await readCurrentOwnedProjectClassificationSubset(principal.session.read, target.data.project_id);
  if (project.outcome !== "found") {
    return <ClosedMessage>找不到這份內容，或目前帳號沒有檢視權限。</ClosedMessage>;
  }

  const draft = await readOwnedStageDraftSubset(principal.session.read, target.data);
  if (draft.outcome === "denied" || draft.outcome === "failed") {
    return <ClosedMessage>受保護資料已隱藏；請重新登入或稍後再試。</ClosedMessage>;
  }

  const confirmation = await readOwnedStageConfirmationStatus(principal.session.read, target.data);
  if (confirmation.outcome === "denied" || confirmation.outcome === "failed") {
    return <ClosedMessage>受保護資料已隱藏；請重新登入或稍後再試。</ClosedMessage>;
  }

  return (
    <section className="grid gap-4" aria-label="九階段創作步驟">
      <StageNav projectId={target.data.project_id} current={target.data.stage} />
      <StageDraftEditor
        key={`${principal.operationStorageScope}:${target.data.project_id}:${target.data.stage}`}
        hasTrustedPrincipal
        accountScope={principal.operationStorageScope}
        initialDraft={draft.outcome === "found" ? draft.draft : null}
        initialConfirmation={confirmation.outcome === "found" ? confirmation.status : null}
        target={target.data}
      />
    </section>
  );
}
