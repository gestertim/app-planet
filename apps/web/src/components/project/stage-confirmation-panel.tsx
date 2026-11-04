"use client";
import { productFetch as fetch } from "../auth/product-fetch.ts";

import { useEffect, useRef, useState } from "react";
import {
  stageConfirmationResultSchema,
  stageConfirmationStatusSchema,
  type StageConfirmationStatus,
  type StageDraftDto,
} from "@app-planet/core";
import type { StageDraftTarget } from "./save-controller.ts";

export interface StageConfirmationPanelProps {
  readonly target: StageDraftTarget;
  readonly initialStatus: StageConfirmationStatus | null;
  readonly savedDraft: StageDraftDto | null;
  readonly dirty: boolean;
  readonly saving: boolean;
}

type Notice =
  | { kind: "none" }
  | { kind: "unknown" }
  | { kind: "version_mismatch" }
  | { kind: "no_draft" }
  | { kind: "key_reuse" }
  | { kind: "closed" }
  | { kind: "reload_failed" };
type Intent = { key: string; version: number };

const url = (target: StageDraftTarget) =>
  `/api/v1/projects/${encodeURIComponent(target.project_id)}/stages/${encodeURIComponent(target.stage)}/confirmation`;

async function readStatus(target: StageDraftTarget): Promise<
  { ok: true; status: StageConfirmationStatus } | { ok: false; closed: boolean }
> {
  try {
    const response = await fetch(url(target), {
      method: "GET", credentials: "same-origin", cache: "no-store", signal: AbortSignal.timeout(10_000),
    });
    if ([401, 403, 404].includes(response.status)) return { ok: false, closed: true };
    if (!response.ok) return { ok: false, closed: false };
    const parsed = stageConfirmationStatusSchema.safeParse(await response.json().catch(() => null));
    if (!parsed.success || parsed.data.project_id.toLowerCase() !== target.project_id.toLowerCase() ||
        parsed.data.stage !== target.stage) return { ok: false, closed: false };
    return { ok: true, status: parsed.data };
  } catch {
    return { ok: false, closed: false };
  }
}

export function StageConfirmationPanel({
  target, initialStatus, savedDraft, dirty, saving,
}: Readonly<StageConfirmationPanelProps>) {
  const [status, setStatus] = useState<StageConfirmationStatus | null>(initialStatus);
  const [notice, setNotice] = useState<Notice>({ kind: "none" });
  const [pending, setPending] = useState(false);
  const intent = useRef<Intent | null>(null);
  const savedVersion = savedDraft?.row_version ?? null;

  const refresh = async () => {
    const result = await readStatus(target);
    if (result.ok) {
      setStatus(result.status);
      if (result.status.state === "confirmed_current") intent.current = null;
      setNotice((previous) =>
        previous.kind === "reload_failed" || (previous.kind === "unknown" && result.status.state === "confirmed_current")
          ? { kind: "none" } : previous);
      return true;
    }
    if (result.closed) {
      setStatus(null);
      setNotice({ kind: "closed" });
    } else {
      setNotice({ kind: "reload_failed" });
    }
    return false;
  };

  useEffect(() => {
    if (savedVersion === null || status?.draft_row_version === savedVersion) return;
    setNotice((previous) => previous.kind === "unknown" ? previous : { kind: "none" });
    void refresh();
    // 只在本機已確認的伺服器版本改變時重讀；狀態權威仍是伺服器。
  }, [savedVersion]);

  if (notice.kind === "closed") {
    return <p role="alert" data-testid="confirmation-closed">無法確認存取權限；確認資料已隱藏，請重新載入。</p>;
  }

  const serverVersion = status?.draft_row_version ?? null;
  const confirmable = !!status && !dirty && !saving && !pending && savedVersion !== null &&
    serverVersion === savedVersion && (status.state === "unconfirmed" || status.state === "confirmation_stale") &&
    notice.kind !== "unknown";

  const send = async (current: Intent) => {
    setPending(true);
    try {
      const response = await fetch(url(target), {
        method: "POST", credentials: "same-origin", cache: "no-store",
        headers: { "content-type": "application/json", "idempotency-key": current.key },
        body: JSON.stringify({ expected_row_version: current.version }),
        signal: AbortSignal.timeout(15_000),
      });
      if (response.status === 200 || response.status === 201) {
        const parsed = stageConfirmationResultSchema.safeParse(await response.json().catch(() => null));
        if (!parsed.success || parsed.data.confirmation.row_version !== current.version) {
          setNotice({ kind: "unknown" });
          return;
        }
        intent.current = null;
        setNotice({ kind: "none" });
        await refresh();
        return;
      }
      const code = (await response.json().catch(() => null))?.code;
      if (response.status === 401 || response.status === 403 || response.status === 404) {
        intent.current = null;
        setStatus(null);
        setNotice({ kind: "closed" });
      } else if (response.status === 409) {
        intent.current = null;
        setNotice({ kind: code === "stage_draft_not_saved" ? "no_draft" : "version_mismatch" });
        await refresh();
      } else if (response.status === 422) {
        intent.current = null;
        setNotice({ kind: "key_reuse" });
      } else {
        setNotice({ kind: "unknown" });
      }
    } catch {
      setNotice({ kind: "unknown" });
    } finally {
      setPending(false);
    }
  };

  const confirm = () => {
    if (!confirmable || serverVersion === null) return;
    intent.current = { key: crypto.randomUUID(), version: serverVersion };
    void send(intent.current);
  };

  let headline: string;
  const syncing = savedVersion !== null && serverVersion !== savedVersion;
  if (dirty) headline = "有未保存的編輯：請先保存並核對伺服器回應，再確認已保存版本。";
  else if (syncing) headline = "正在向伺服器讀取最新確認狀態；在核對完成前不會顯示為已確認。";
  else if (!status || status.state === "no_draft") headline = "尚無已保存版本：請先保存草稿。";
  else if (status.state === "confirmed_current") headline = `版本 ${status.draft_row_version} 已由你確認，目前仍有效。`;
  else if (status.state === "confirmation_stale") headline = `內容已變更：先前確認（版本 ${status.latest_confirmation?.row_version}）不再有效，請重新確認目前已保存版本。`;
  else headline = `已保存版本 ${status.draft_row_version} 尚未確認。`;

  return (
    <section aria-label="階段內容確認" className="grid gap-2 rounded-lg border border-slate-200 p-4" data-testid="stage-confirmation">
      <h2 className="font-bold">學生確認</h2>
      <p data-testid="confirmation-headline" data-state={dirty ? "dirty" : syncing ? "syncing" : status?.state ?? "no_draft"}>{headline}</p>
      {!dirty && !syncing && status?.state === "confirmed_current" && status.latest_confirmation && (
        <p className="text-sm text-slate-600" data-testid="confirmation-evidence">
          確認的是已保存版本 {status.latest_confirmation.row_version}（內容指紋 {status.latest_confirmation.content_hash.slice(0, 12)}…），
          伺服器時間 {status.latest_confirmation.confirmed_at}。
        </p>
      )}
      <p className="text-sm text-amber-900" data-testid="manual-approval-status">
        {target.stage === "Specification"
          ? "Specification 教師審查請使用下方獨立送審入口；此學生確認不是送審前置，也不代表教師批准。"
          : "教師／管理員人工批准：尚未取得，此階段目前尚未開放批准操作。"}
        學生確認不等於階段完成或批准，也不會開放 AI、預覽或發布。
      </p>
      {notice.kind === "unknown" && (
        <p role="alert" data-testid="confirmation-unknown">
          結果尚待確認：不會顯示為已確認，也不會更換操作識別。請使用原操作重試，或重新讀取伺服器狀態。
        </p>
      )}
      {notice.kind === "version_mismatch" && (
        <p role="alert" data-testid="confirmation-mismatch">已保存版本已變更，沒有確認任何內容；你的本地編輯仍保留，請比對後重新確認。</p>
      )}
      {notice.kind === "no_draft" && <p role="alert">這個階段尚無已保存草稿，沒有確認任何內容。</p>}
      {notice.kind === "key_reuse" && <p role="alert">這次操作識別與先前不同的意圖衝突，沒有確認任何內容；請重新整理後再試。</p>}
      {notice.kind === "reload_failed" && <p role="alert">目前無法重新讀取確認狀態；不顯示為已確認。</p>}
      <div className="flex flex-wrap gap-3">
        <button
          type="button" data-testid="confirm-saved-version" disabled={!confirmable}
          className="min-h-11 rounded-lg bg-emerald-700 px-5 font-bold text-white disabled:cursor-not-allowed disabled:bg-slate-400"
          onClick={confirm}
        >
          確認已保存版本
        </button>
        {notice.kind === "unknown" && intent.current && (
          <button
            type="button" data-testid="retry-confirmation" disabled={pending}
            className="min-h-11 rounded-lg border border-emerald-700 px-5 font-bold text-emerald-900"
            onClick={() => intent.current && void send(intent.current)}
          >
            使用原操作鍵重試
          </button>
        )}
        {(notice.kind === "unknown" || notice.kind === "reload_failed") && (
          <button
            type="button" data-testid="reload-confirmation" disabled={pending}
            className="min-h-11 rounded-lg border px-5 font-bold"
            onClick={() => void refresh()}
          >
            重新讀取確認狀態
          </button>
        )}
      </div>
    </section>
  );
}
