import { stageDraftContentSchema } from "@app-planet/core";
import type { StageDraftEditorState, StageDraftTarget } from "./save-controller.ts";

export type AppliedIdeaDraft = Readonly<{ accountScope: string; target: StageDraftTarget }>;

export function canDiscardIdeaDraft(
  applied: AppliedIdeaDraft | null, accountScope: string, state: StageDraftEditorState,
): boolean {
  return applied !== null && applied.accountScope === accountScope &&
    applied.target.project_id === state.target.project_id && applied.target.stage === state.target.stage &&
    state.target.stage === "點子" && state.confirmedDraft === null &&
    state.dirty && state.operation.status === "idle";
}

export function validateIdeaDraft(text: string): "valid" | "invalid" | "too_large" {
  if (!stageDraftContentSchema.safeParse({ text }).success) return "invalid";
  return new TextEncoder().encode(JSON.stringify({ content: { text } })).byteLength <= 64 * 1024
    ? "valid" : "too_large";
}

type Handoff = {
  accountScope: string;
  operationKey: string;
  text: string;
  projectId: string | null;
};

// 只跨同一份文件的 Next 導覽；不保存至 URL 或瀏覽器儲存。
export class IdeaDraftHandoff {
  private pending: Handoff | null = null;

  begin(accountScope: string, operationKey: string, text: string): boolean {
    if (this.pending || validateIdeaDraft(text) !== "valid") return false;
    this.pending = { accountScope, operationKey, text, projectId: null };
    return true;
  }

  confirm(accountScope: string, operationKey: string, projectId: string): boolean {
    const pending = this.pending;
    if (!pending || pending.accountScope !== accountScope ||
        pending.operationKey !== operationKey || pending.projectId !== null) return false;
    pending.projectId = projectId;
    return true;
  }

  cancel(accountScope?: string): void {
    if (accountScope === undefined || this.pending?.accountScope === accountScope) this.pending = null;
  }

  abandonUnconfirmed(accountScope: string): void {
    if (this.pending?.accountScope === accountScope && this.pending.projectId === null) this.pending = null;
  }

  take(accountScope: string, state: StageDraftEditorState):
    { outcome: "applied"; text: string } | { outcome: "unavailable" | "occupied" } {
    const pending = this.pending;
    if (!pending) return { outcome: "unavailable" };
    if (pending.accountScope !== accountScope) {
      this.pending = null;
      return { outcome: "unavailable" };
    }
    if (state.target.stage !== "點子" || pending.projectId !== state.target.project_id) {
      return { outcome: "unavailable" };
    }
    this.pending = null;
    if (state.confirmedDraft !== null || state.dirty || state.editorText !== "" ||
        state.operation.status !== "idle") return { outcome: "occupied" };
    return { outcome: "applied", text: pending.text };
  }
}

export const ideaDraftHandoff = new IdeaDraftHandoff();
