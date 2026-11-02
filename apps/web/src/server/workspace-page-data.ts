import { resolvePagePrincipal } from "./page-principal.ts";
import { readOwnedProjectWorkspaceSubset } from "./project-workspace.ts";

type Principal = Awaited<ReturnType<typeof resolvePagePrincipal>>;
export type WorkspacePrincipal = Extract<Principal, { ok: true }>;
type WorkspaceRead = Awaited<ReturnType<typeof readOwnedProjectWorkspaceSubset>>;
export type WorkspaceData = Extract<WorkspaceRead, { outcome: "found" }>["workspace"];

export type WorkspacePageData =
  | Readonly<{ outcome: "found"; principal: WorkspacePrincipal; workspace: WorkspaceData }>
  | Readonly<{ outcome: "unauthenticated" | "unavailable" | "not_found" }>;

export async function readWorkspacePageData(projectId: string): Promise<WorkspacePageData> {
  const principal = await resolvePagePrincipal();
  if (!principal.ok) {
    return principal.reason === "unauthenticated"
      ? { outcome: "unauthenticated" }
      : { outcome: "unavailable" };
  }
  const result = await readOwnedProjectWorkspaceSubset(principal.session.read, projectId);
  if (result.outcome === "found") return { outcome: "found", principal, workspace: result.workspace };
  if (result.outcome === "not_found") return { outcome: "not_found" };
  return result.outcome === "failed" && result.reason !== "invalid_input"
    ? { outcome: "unavailable" }
    : { outcome: "not_found" };
}
