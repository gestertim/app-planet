import { cookies } from "next/headers";
import { projectStageSchema, readStageDraftInputSchema } from "@app-planet/core";
import { AppShell } from "@/components/app-shell";
import { StageDraftEditor } from "@/components/project/stage-draft-editor";
import { authorizeCapability } from "@/server/authorization";
import { createAuthPrincipalResolver, sessionCookieName } from "@/server/auth-principal";
import { readOwnedStageDraftSubset } from "@/server/stage-drafts";
import { readOwnedProjectWithClassificationSubset } from "@/server/projects";

export const dynamic = "force-dynamic";

type PageProps = {
  params: Promise<{ id: string; stage: string }>;
};

function ClosedMessage({ children }: Readonly<{ children: React.ReactNode }>) {
  return <p className="card" role="status">{children}</p>;
}

export default async function StageDraftPage({ params }: PageProps) {
  const { id, stage } = await params;
  const target = readStageDraftInputSchema.safeParse({ project_id: id, stage });
  if (!target.success || !projectStageSchema.safeParse(stage).success) {
    return <AppShell heading="無法開啟草稿" subtitle="請確認作品與階段連結。">
      <ClosedMessage>找不到這份內容，或目前帳號沒有檢視權限。</ClosedMessage>
    </AppShell>;
  }

  const cookieJar = await cookies();
  const accessToken = cookieJar.get(sessionCookieName)?.value;
  const request = new Request("http://localhost/", {
    headers: accessToken ? { cookie: `${sessionCookieName}=${accessToken}` } : {},
  });
  const principal = await createAuthPrincipalResolver().resolve(request).catch(() => ({
    ok: false as const,
    reason: "dependency_unavailable" as const,
  }));
  if (!principal.ok) {
    return <AppShell heading="草稿工作區" subtitle="登入狀態由伺服器確認。">
      <ClosedMessage>
        {principal.reason === "unauthenticated"
          ? "尚未登入或工作階段已失效；請使用核准的登入流程。"
          : "目前無法確認登入狀態；受保護資料不會顯示。"}
      </ClosedMessage>
    </AppShell>;
  }

  const gate = await authorizeCapability(principal.session.read, "edit_saved_content");
  if (gate.outcome !== "allowed") {
    return <AppShell heading="草稿工作區" subtitle="目前帳號無法開啟這份內容。">
      <ClosedMessage>目前帳號沒有編輯權限，或無法確認帳號資格。</ClosedMessage>
    </AppShell>;
  }

  const project = await readOwnedProjectWithClassificationSubset(principal.session.read, target.data.project_id);
  if (project.outcome !== "found") {
    return <AppShell heading="無法開啟草稿" subtitle="請回到自己的作品重新選擇。">
      <ClosedMessage>找不到這份內容，或目前帳號沒有檢視權限。</ClosedMessage>
    </AppShell>;
  }

  const draft = await readOwnedStageDraftSubset(principal.session.read, target.data);
  if (draft.outcome === "denied" || draft.outcome === "failed") {
    return <AppShell heading="草稿工作區" subtitle="目前無法確認作品資格。">
      <ClosedMessage>受保護資料已隱藏；請重新登入或稍後再試。</ClosedMessage>
    </AppShell>;
  }

  return (
    <AppShell
      authenticated
      capabilities={[{ href: "/student", label: "工作台" }]}
      heading="階段草稿"
      subtitle="未確認草稿只會在伺服器完成當下登入、帳號與作品權限檢查後顯示。"
    >
      <StageDraftEditor
        hasTrustedPrincipal
        initialDraft={draft.outcome === "found" ? draft.draft : null}
        target={target.data}
      />
    </AppShell>
  );
}
