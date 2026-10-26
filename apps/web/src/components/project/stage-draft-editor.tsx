"use client";

import * as Dialog from "@radix-ui/react-dialog";
import { useEffect, useState } from "react";
import type { StageDraftDto } from "@app-planet/core";
import type { StageDraftReadResult } from "../../server/stage-drafts.ts";
import { presentSaveState, type Connectivity } from "../operation-presentation.ts";
import { OperationStatusBanner } from "../operation-state.tsx";
import { createHttpSaveAdapter } from "./http-save-adapter.ts";
import { stageDraftDtoSchema } from "@app-planet/core";
import {
  StageDraftSaveController,
  type StageDraftTarget,
} from "./save-controller.ts";

export interface StageDraftEditorProps {
  readonly target: StageDraftTarget;
  readonly initialDraft?: StageDraftDto | null;
  readonly hasTrustedPrincipal?: boolean;
  readonly readCurrentDraft?: () => Promise<StageDraftReadResult>;
}

function buildSaveUrl(target: StageDraftTarget): string {
  return `/api/v1/projects/${encodeURIComponent(target.project_id)}/stages/${encodeURIComponent(target.stage)}`;
}

async function readDraftFromRoute(target: StageDraftTarget): Promise<StageDraftReadResult> {
  const response = await fetch(buildSaveUrl(target), {
    method: "GET",
    credentials: "same-origin",
    cache: "no-store",
    signal: AbortSignal.timeout(10_000),
  });
  if (response.status === 401 || response.status === 403) {
    return { outcome: "denied", reason: "policy_denied" };
  }
  if (response.status === 404) return { outcome: "not_found" };
  if (!response.ok) return { outcome: "failed", reason: "dependency_failure" };
  const parsed = stageDraftDtoSchema.safeParse(await response.json().catch(() => null));
  return parsed.success
    ? { outcome: "found", draft: parsed.data }
    : { outcome: "failed", reason: "invalid_result" };
}

export function StageDraftEditor({
  target,
  initialDraft,
  hasTrustedPrincipal = false,
  readCurrentDraft,
}: Readonly<StageDraftEditorProps>) {
  const [adapter] = useState(() => createHttpSaveAdapter({
    buildUrl: buildSaveUrl,
    isOnline: () => typeof navigator === "undefined" || navigator.onLine,
  }));
  const [controller] = useState(() => new StageDraftSaveController({
    adapter,
    initialTarget: target,
    initialDraft,
  }));
  const [state, setState] = useState(() => controller.getState(target));
  const [connectivity, setConnectivity] = useState<Connectivity>("online");
  const [conflictDialogOpen, setConflictDialogOpen] = useState(false);
  const [serverDraft, setServerDraft] = useState<StageDraftDto | null>(initialDraft ?? null);
  const [reloadError, setReloadError] = useState<string | null>(null);
  const [reloadPending, setReloadPending] = useState(false);

  useEffect(() => controller.subscribe(() => {
    const next = controller.getState(target);
    setState(next);
    setServerDraft(next.confirmedDraft);
    if (next.operation.status === "failed" &&
        (next.operation.reason === "policy_denied" || next.operation.reason === "project_not_found")) {
      setServerDraft(null);
    }
  }), [controller, target]);

  useEffect(() => {
    const updateConnectivity = () => setConnectivity(navigator.onLine ? "online" : "offline");
    updateConnectivity();
    window.addEventListener("online", updateConnectivity);
    window.addEventListener("offline", updateConnectivity);
    return () => {
      window.removeEventListener("online", updateConnectivity);
      window.removeEventListener("offline", updateConnectivity);
    };
  }, []);

  const presentation = presentSaveState({
    operation: state.operation,
    dirty: state.dirty,
    connectivity,
    signal: adapter.signal,
    hasTrustedPrincipal,
    hasConfirmedDraft: state.confirmedDraft !== null,
  });
  const conflict = state.operation.status === "conflict" ? state.operation.conflict : null;

  return (
    <section aria-label="階段草稿編輯器" className="mx-auto grid max-w-4xl gap-4 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
      <OperationStatusBanner presentation={presentation} />
      {!presentation.hideServerData && state.operation.status === "replayed" && (
        <p data-testid="operation-receipt">
          原操作版本 {state.operation.receipt.row_version}：{state.operation.receipt.content.text}
          （僅確認原操作，不表示它仍是目前版本）
        </p>
      )}
      {reloadError && <p role="alert">{reloadError}</p>}
      {!presentation.hideServerData && serverDraft && (
        <p className="text-sm text-slate-600" data-testid="confirmed-server-draft">
          伺服器版本 {serverDraft.row_version}：{serverDraft.content.text}
        </p>
      )}
      {!presentation.hideServerData && (
        <label className="grid gap-2 font-semibold text-slate-800">
          階段草稿文字
          <textarea
            aria-describedby="operation-status"
            className="min-h-48 rounded-lg border border-slate-300 p-3 font-normal focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-700"
            onChange={(event) => controller.edit(event.currentTarget.value, target)}
            value={state.editorText}
          />
        </label>
      )}
      {!presentation.hideServerData && (
        <div className="flex flex-wrap items-center gap-3">
          <button
            className="min-h-11 rounded-lg bg-blue-700 px-5 font-bold text-white hover:bg-blue-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-700 disabled:cursor-not-allowed disabled:bg-slate-400"
            disabled={!presentation.canSave}
            onClick={() => void controller.save(target)}
            type="button"
          >
            保存
          </button>
          {presentation.canRetry && (
            <button
              className="min-h-11 rounded-lg border border-blue-700 px-5 font-bold text-blue-800 hover:bg-blue-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-700"
              onClick={() => void controller.retry(target)}
              type="button"
            >
              使用原操作鍵重試
            </button>
          )}
          {state.operation.status === "failed" && state.operation.reason === "draft_already_exists" &&
            readCurrentDraft && (
            <button
              type="button"
              disabled={reloadPending}
              className="min-h-11 rounded-lg border border-amber-700 px-5 font-bold text-amber-900"
              onClick={() => {
                  const read = readCurrentDraft ?? (() => readDraftFromRoute(target));
                  setReloadError(null);
                  setReloadPending(true);
                  void read().then((result) => {
                  if (result.outcome === "denied" || result.outcome === "not_found") {
                    controller.rejectCurrentAccess(result.outcome === "denied" ? "policy_denied" : "project_not_found", target);
                    return;
                  }
                  if (result.outcome !== "found") throw new Error("current_draft_unconfirmed");
                  controller.compareExistingDraft(result.draft, target);
                  setConflictDialogOpen(true);
                }).catch(() => {
                  setReloadError("無法確認目前草稿；本地內容仍保留，請確認登入與資格後重新載入／比對。");
                }).finally(() => {
                  setReloadPending(false);
                });
              }}
            >
              重新載入／比對
            </button>
          )}
          {conflict && (
            <Dialog.Root open={conflictDialogOpen} onOpenChange={setConflictDialogOpen}>
              <Dialog.Trigger asChild>
                <button
                  className="min-h-11 rounded-lg border border-amber-700 px-5 font-bold text-amber-900 hover:bg-amber-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-700"
                  type="button"
                >
                  查看版本衝突說明
                </button>
              </Dialog.Trigger>
              <Dialog.Portal>
                <Dialog.Overlay className="fixed inset-0 bg-slate-950/40" />
                <Dialog.Content className="fixed left-1/2 top-1/2 grid max-h-[85vh] w-[min(92vw,40rem)] -translate-x-1/2 -translate-y-1/2 gap-4 overflow-y-auto rounded-2xl bg-white p-6 shadow-2xl focus:outline-none">
                  <Dialog.Title className="text-xl font-extrabold text-slate-900">版本衝突：草稿仍保留</Dialog.Title>
                  <Dialog.Description className="text-slate-700">
                    伺服器目前是版本 {conflict.current.version ?? "尚無版本"}；你提交的內容沒有覆蓋伺服器資料。請先比對，再自行決定下一步。
                  </Dialog.Description>
                  <div className="grid gap-3">
                    <section aria-label="伺服器目前內容">
                      <h3 className="font-bold">伺服器目前內容</h3>
                      <pre className="whitespace-pre-wrap rounded-lg bg-slate-100 p-3">{conflict.current.content?.text ?? "目前沒有伺服器草稿。"}</pre>
                    </section>
                    <section aria-label="本次提交內容">
                      <h3 className="font-bold">本次提交內容</h3>
                      <pre className="whitespace-pre-wrap rounded-lg bg-blue-50 p-3">{conflict.submitted.content.text}</pre>
                    </section>
                  </div>
                  <Dialog.Close asChild>
                    <button type="button" className="min-h-11 rounded-lg border p-3"
                      onClick={() => controller.resolveConflict("keep_local", target)}>
                      保留本地，採用目前版本作為更新基準
                    </button>
                  </Dialog.Close>
                  <Dialog.Close asChild>
                    <button type="button" className="min-h-11 rounded-lg border p-3"
                      onClick={() => controller.resolveConflict("use_current", target)}>
                      採用目前內容
                    </button>
                  </Dialog.Close>
                  <Dialog.Close asChild>
                    <button
                      className="min-h-11 justify-self-end rounded-lg bg-blue-700 px-5 font-bold text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-700"
                      type="button"
                    >
                      關閉
                    </button>
                  </Dialog.Close>
                </Dialog.Content>
              </Dialog.Portal>
            </Dialog.Root>
          )}
        </div>
      )}
    </section>
  );
}
