import { bindingIntentSchema, bindingReceiptSchema, type BindingIntent, type BindingReceipt } from "@app-planet/core";

type State = {
  status: "initial" | "idle" | "pending" | "unknown" | "success" | "failed" | "closed";
  intent: BindingIntent | null;
  receipt: BindingReceipt | null;
  message: string;
};
const reasons: Record<string, string> = {
  binding_exists: "這對師生已有有效綁定，沒有新增關係。",
  binding_ended: "指定的舊關聯已解除；沒有解除任何新關聯。",
  teacher_not_eligible: "教師目前不符合資格；須已批准、未停用且未刪除。",
  student_not_approved: "學生目前不符合資格；須已批准、未停用且未刪除。",
  school_not_eligible: "學生學校尚未核准或已失效。",
  teacher_school_mismatch: "教師沒有學生學校的有效持久歸屬。",
  invalid_binding_pair: "不能綁定自己；請核對教師與學生角色。",
  idempotency_key_reuse: "原操作鍵已用於不同內容；本次遭拒，請重新核對關係。",
};
export class BindingOperationController {
  private state: State = { status: "initial", intent: null, receipt: null, message: "" };
  private listeners = new Set<() => void>();
  private lifecycle = 0;
  private active = true;
  constructor(private readonly options: {
    storageKey: string; storage: Pick<Storage, "getItem" | "setItem" | "removeItem">;
    fetch: typeof fetch;
  }) {}
  getState = () => this.state;
  activate() {
    const lifecycle = ++this.lifecycle;
    this.active = true;
    return () => {
      if (this.lifecycle === lifecycle) {
        this.active = false;
        ++this.lifecycle;
      }
    };
  }
  private isCurrent(lifecycle: number) {
    return this.active && this.lifecycle === lifecycle;
  }
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  private update(state: State) {
    if (this.state.status === "closed") return;
    this.state = state;
    for (const listener of this.listeners) listener();
  }
  close() {
    this.update({ status: "closed", intent: null, receipt: null,
      message: "目前無法確認管理權限；關係資料已隱藏，未決原操作仍保留，不會自動重送。" });
  }
  restore() {
    if (!this.active || this.state.status !== "initial") return;
    try {
      const raw = this.options.storage.getItem(this.options.storageKey);
      if (!raw) return this.update({ ...this.state, status: "idle" });
      const parsed = bindingIntentSchema.safeParse(JSON.parse(raw));
      if (!parsed.success) {
        return this.update({ ...this.state, status: "closed", message: "原操作紀錄不完整；已停止送出，請洽支援。" });
      }
      this.update({ status: "unknown", intent: parsed.data, receipt: null,
        message: "有待確認操作；只可明確使用原鍵、原本文及原對象重試。" });
    } catch {
      this.update({ ...this.state, status: "closed", message: "無法讀取操作紀錄；為避免重複操作，已停止送出。" });
    }
  }
  async start(intent: BindingIntent) {
    if (!this.active || !["idle", "success", "failed"].includes(this.state.status) || this.state.intent) return;
    const parsed = bindingIntentSchema.safeParse(intent);
    if (!parsed.success) return this.update({ ...this.state, status: "failed", message: "請核對教師、學生或有效解除理由。" });
    try { this.options.storage.setItem(this.options.storageKey, JSON.stringify(parsed.data)); }
    catch {
      return this.update({ ...this.state, status: "failed", message: "無法保存原鍵；本次尚未送出，請檢查瀏覽器儲存設定。" });
    }
    await this.send(parsed.data, this.lifecycle);
  }
  async retry() {
    if (this.active && this.state.status === "unknown" && this.state.intent) {
      await this.send(this.state.intent, this.lifecycle);
    }
  }
  private clearIntent(intent: BindingIntent, lifecycle: number) {
    if (!this.isCurrent(lifecycle)) return;
    const raw = this.options.storage.getItem(this.options.storageKey);
    if (raw === null) return;
    const stored = bindingIntentSchema.safeParse(JSON.parse(raw));
    if (!stored.success || JSON.stringify(stored.data) !== JSON.stringify(intent)) {
      throw new Error("storage_intent_changed");
    }
    if (this.isCurrent(lifecycle)) this.options.storage.removeItem(this.options.storageKey);
  }
  private async send(intent: BindingIntent, lifecycle: number) {
    if (!this.isCurrent(lifecycle)) return;
    this.update({ status: "pending", intent, receipt: null, message: "正在確認原操作結果，請稍候。" });
    try {
      if (!this.isCurrent(lifecycle)) return;
      const response = await this.options.fetch(intent.operation === "create"
        ? "/api/v1/admin/bindings" : `/api/v1/admin/bindings/${encodeURIComponent(intent.target)}`, {
        method: intent.operation === "create" ? "POST" : "DELETE", credentials: "same-origin", cache: "no-store",
        headers: { "content-type": "application/json", "idempotency-key": intent.key },
        body: JSON.stringify(intent.body), signal: AbortSignal.timeout(15_000),
      });
      if (!this.isCurrent(lifecycle) || this.state.status === "closed") return;
      if ([401, 403].includes(response.status)) return this.close();
      const raw: unknown = await response.json();
      if (!this.isCurrent(lifecycle) || this.getState().status === "closed") return;
      if (response.ok) {
        const parsed = bindingReceiptSchema.safeParse(raw);
        if (!parsed.success || parsed.data.operation !== intent.operation ||
          (intent.operation === "end" && parsed.data.binding_id !== intent.target)) throw new Error("invalid_receipt");
        this.clearIntent(intent, lifecycle);
        if (!this.isCurrent(lifecycle)) return;
        this.update({ status: "success", intent: null, receipt: parsed.data,
          message: "已確認原操作 receipt；目前關係另由下方伺服器清單讀取，receipt 不代表目前授權。" });
      } else if ([400, 404, 409, 413, 415, 422].includes(response.status)) {
        const code = typeof raw === "object" && raw !== null && "code" in raw && typeof raw.code === "string" ? raw.code : "";
        this.clearIntent(intent, lifecycle);
        if (!this.isCurrent(lifecycle)) return;
        this.update({ status: "failed", intent: null, receipt: null,
          message: reasons[code] ?? (response.status === 404 ? "找不到指定關聯；未改動其他關係。" : "本次遭拒，請重新讀取並核對，不會自動改送其他操作。") });
      } else throw new Error("unknown_response");
    } catch {
      if (this.isCurrent(lifecycle)) {
        this.update({ status: "unknown", intent, receipt: null,
          message: "結果未知，可能已提交。原鍵、原本文及原對象已保留；重新載入後仍只可原鍵重試。" });
      }
    }
  }
}
