import type { StageDraftSaveOperationState } from "./project/save-controller.ts";

// 純函式：把控制器狀態與可信連線／工作階段訊號對應為使用者可見的操作狀態。
// 「已保存」只會由伺服器確認的 saved／replayed 產生；其餘一律不得顯示為已保存。
export type OperationKind =
  | "closed"
  | "unmodified"
  | "unsaved"
  | "saving"
  | "saved"
  | "conflict"
  | "offline"
  | "denied"
  | "dependency_failed"
  | "outcome_unknown"
  | "rejected"
  | "accepted";

export type Connectivity = "online" | "offline";
export type SaveSignal = "none" | "session_expired" | "dependency_unavailable" | "unreachable";

export interface OperationPresentation {
  kind: OperationKind;
  code: string;
  title: string;
  nextStep: string;
  tone: "neutral" | "progress" | "success" | "warning" | "danger";
  canSave: boolean;
  canRetry: boolean;
  savedVersion: number | null;
  // 失去資格（登入失效、降權、拒絕）後，不得再顯示只有合格者才能看見的 server 資料。
  hideServerData: boolean;
}

export interface SaveStateInput {
  operation: StageDraftSaveOperationState;
  dirty: boolean;
  connectivity: Connectivity;
  signal: SaveSignal;
  hasTrustedPrincipal: boolean;
  hasConfirmedDraft?: boolean;
}

const base: Omit<OperationPresentation, "kind" | "code" | "title" | "nextStep" | "tone"> = {
  canSave: false, canRetry: false, savedVersion: null, hideServerData: false,
};
const make = (
  kind: OperationKind, code: string, title: string, nextStep: string,
  tone: OperationPresentation["tone"], extra: Partial<OperationPresentation> = {},
): OperationPresentation => ({ ...base, kind, code, title, nextStep, tone, ...extra });

export function presentSaveState(input: SaveStateInput): OperationPresentation {
  const { operation, dirty, connectivity, signal } = input;
  if (!input.hasTrustedPrincipal) {
    return make("closed", "unauthenticated", "尚未開放", "此功能需要已驗證的登入身分；目前沒有可信身分，操作維持關閉。",
      "neutral", { hideServerData: true });
  }
  if (signal === "session_expired") {
    return make("denied", "unauthenticated", "登入已失效", "你的草稿仍保留在這個畫面；請重新登入後再保存，不會顯示需要資格才能看的資料。",
      "danger", { hideServerData: true });
  }
  if (operation.status === "saving") {
    return make("saving", "saving", "保存中", "請稍候；你可以繼續編輯，已送出的內容不會改變。", "progress");
  }
  if (operation.status === "saved" || operation.status === "replayed") {
    if (operation.status === "replayed" &&
        operation.currentDraft?.row_version !== operation.receipt.row_version) {
      return make(dirty ? "unsaved" : "saved", "original_operation_confirmed", "原操作已確認",
        `原操作版本 ${operation.receipt.row_version} 已保存；${operation.currentDraft
          ? `目前伺服器為版本 ${operation.currentDraft.row_version}，不是本次提交的版本。`
          : "目前已無可讀取的草稿，不會自動重建。"}${dirty ? "本地內容尚未保存為目前版本。" : ""}`,
        "warning", { savedVersion: operation.receipt.row_version, canSave: dirty });
    }
    if (dirty) {
      return make("unsaved", "unsaved_after_save", "另有修改尚未保存",
        `伺服器已確認版本 ${operation.receipt.row_version}；之後的修改尚未保存。`, "warning",
        { savedVersion: operation.receipt.row_version, canSave: true });
    }
    return make("saved", "saved", "已保存", "伺服器已確認這次保存。", "success",
      { savedVersion: operation.receipt.row_version, canSave: dirty });
  }
  if (operation.status === "conflict") {
    return make("conflict", "version_conflict", "版本衝突",
      "別處已有較新的版本；你的草稿仍保留。請選擇保留本地後重新保存，或採用目前版本，不會自動覆寫。", "warning");
  }
  if (operation.status === "failed") {
    switch (operation.reason) {
      case "policy_denied":
        return make("denied", "forbidden", "沒有權限", "目前帳號不能保存這份內容；草稿保留在畫面，請聯絡教師或管理員。",
          "danger", { hideServerData: true });
      case "project_not_found":
        return make("denied", "not_found", "找不到這份內容", "此內容不存在或你沒有權限；草稿保留在畫面。",
          "danger", { hideServerData: true });
      case "idempotency_conflict":
        return make("rejected", "idempotency_key_reuse", "操作鍵已用於不同內容",
          "請重新整理後再保存，系統會使用新的操作。", "danger");
      case "draft_already_exists":
        return make("conflict", "draft_already_exists", "草稿已存在",
          "本地內容仍保留；請選擇重新載入／比對，取得可信目前版本後再明確決定，不會自動覆寫。", "warning");
      case "invalid_input":
      case "invalid_operation_key":
      case "save_rejected":
        return make("rejected", "invalid_request", "保存被拒絕", "內容或請求不符合規則；請修改後再保存，草稿仍保留。", "danger",
          { canSave: true });
      default: {
        // outcome_unknown / invalid_response：結果未確認，絕不自動當作失敗，也不自動換新鍵重送。
        if (connectivity === "offline") {
          return make("offline", "client_offline", "目前離線", "草稿保留在畫面；連線恢復後使用同一操作重試，不會重複保存。",
            "warning", { canRetry: operation.retryable });
        }
        if (signal === "dependency_unavailable") {
          return make("dependency_failed", "dependency_unavailable", "服務暫時無法使用",
            "草稿保留；稍後使用同一操作重試。", "warning", { canRetry: operation.retryable });
        }
        return make("outcome_unknown", "operation_outcome_unknown", "結果待確認",
          "不確定是否已保存；請用同一操作重試確認，不要另存為新內容。", "warning", { canRetry: operation.retryable });
      }
    }
  }
  if (connectivity === "offline") {
    return make("offline", "client_offline", "目前離線", "草稿保留在畫面；可以嘗試保存，連線恢復後再用同一操作重試。", "warning",
      { canSave: dirty });
  }
  if (input.hasConfirmedDraft === false) {
    return make("unsaved", "never_saved", "未保存", "這份草稿尚未保存；首次保存確認後才會有版本 0。",
      "neutral", { canSave: true });
  }
  return dirty
    ? make("unsaved", "unsaved", "未保存", "你有尚未保存的修改。", "neutral", { canSave: true })
    : make("unmodified", "unmodified", "未修改", "內容與最近確認的伺服器版本一致。", "neutral");
}

export interface JobAcceptedInput { state: "queued" | "running" | "failed" | "cancelled" | "done" | "unknown"; }

// 202 與 queued／running 只代表已接受或處理中；成功結果內容未核定時不顯示完成。
export function presentJobState(input: JobAcceptedInput): OperationPresentation {
  switch (input.state) {
    case "queued":
    case "running":
      return make("accepted", "accepted", "已接受，處理中", "工作正在處理；請稍後查看狀態，這不代表已完成。", "progress");
    case "failed":
      return make("dependency_failed", "job_failed", "工作失敗", "請稍後再試或聯絡教師。", "danger");
    case "cancelled":
      return make("rejected", "job_cancelled", "工作已取消", "如需繼續請重新送出。", "warning");
    default:
      return make("outcome_unknown", "job_result_unavailable", "結果尚無法顯示", "請稍後再確認，系統不會顯示未確認的完成。", "warning");
  }
}
