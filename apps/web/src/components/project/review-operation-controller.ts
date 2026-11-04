import { z } from "zod";
import { specificationDecisionSchema, specificationReceiptSchema, specificationSubmitSchema } from "@app-planet/core";

const intentSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("submit"), target: z.uuid(), key: z.uuid(), body: specificationSubmitSchema }).strict(),
  z.object({ kind: z.literal("decide"), target: z.uuid(), key: z.uuid(), body: specificationDecisionSchema }).strict(),
]);
type Intent = z.infer<typeof intentSchema>;
export type ReviewOperationState = {
  status: "initial" | "idle" | "pending" | "unknown" | "success" | "conflict" | "failed" | "closed";
  intent: Intent | null;
  message: string;
};
export const submissionUrl = (id: string) => `/api/v1/projects/${encodeURIComponent(id)}/stages/Specification/submissions`;
export const reviewUrl = (id: string) => `/api/v1/teacher/specification-submissions/${encodeURIComponent(id)}`;

export class ReviewOperationController {
  private state: ReviewOperationState = { status: "initial", intent: null, message: "" };
  private listeners = new Set<() => void>();
  constructor(private readonly options: {
    kind: Intent["kind"]; target: string; storageKey: string;
    storage: Pick<Storage, "getItem" | "setItem" | "removeItem">;
    fetch: typeof fetch; uuid: () => string;
  }) {}
  getState = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  private update(state: ReviewOperationState) {
    if (this.state.status === "closed" && state.status !== "closed") return;
    this.state = state;
    for (const listener of this.listeners) listener();
  }
  restore() {
    if (this.state.status !== "initial") return;
    try {
      const raw = this.options.storage.getItem(this.options.storageKey);
      if (!raw) return this.update({ status: "idle", intent: null, message: "" });
      const parsed = intentSchema.safeParse(JSON.parse(raw));
      if (!parsed.success || parsed.data.kind !== this.options.kind || parsed.data.target !== this.options.target) {
        return this.update({ status: "closed", intent: null, message: "待確認操作資料不完整；請停止操作並洽支援，不會自動重送。" });
      }
      this.update({ status: "unknown", intent: parsed.data, message: "上次操作結果待確認；只可使用原決定與原操作鍵重試。" });
    } catch {
      this.update({ status: "closed", intent: null, message: "無法讀取待確認操作；為避免重複提交，已停止送出。" });
    }
  }
  close() {
    this.update({ ...this.state, status: "closed", message: "無法確認存取權限；受保護審查資料已隱藏，請重新載入。" });
  }
  async start(body: unknown) {
    if (!["idle", "success", "conflict", "failed"].includes(this.state.status) || this.state.intent) return;
    const parsed = intentSchema.safeParse({
      kind: this.options.kind, target: this.options.target, key: this.options.uuid(), body,
    });
    if (!parsed.success) return this.update({ status: "failed", intent: null, message: "請核對完整保存版本或有效退回理由。" });
    try { this.options.storage.setItem(this.options.storageKey, JSON.stringify(parsed.data)); }
    catch { return this.update({ status: "failed", intent: null, message: "無法保存原操作鍵；本次尚未送出，請檢查瀏覽器儲存設定。" }); }
    await this.send(parsed.data);
  }
  async retry() {
    if (this.state.status === "unknown" && this.state.intent) await this.send(this.state.intent);
  }
  private async send(intent: Intent) {
    this.update({ status: "pending", intent, message: "正在送出明確確認的操作，請稍候。" });
    try {
      const response = await this.options.fetch(intent.kind === "submit"
        ? submissionUrl(intent.target) : `${reviewUrl(intent.target)}/decision`, {
        method: "POST", credentials: "same-origin", cache: "no-store",
        headers: { "content-type": "application/json", "idempotency-key": intent.key },
        body: JSON.stringify(intent.body), signal: AbortSignal.timeout(15_000),
      });
      if ([401, 403, 404].includes(response.status)) return this.close();
      if (this.state.status === "closed") return;
      if (response.ok) {
        const raw: unknown = await response.json();
        if (this.getState().status === "closed") return;
        const parsed = specificationReceiptSchema.safeParse(raw);
        if (!parsed.success || (intent.kind === "decide" && parsed.data.submission_id !== intent.target)) {
          throw new Error("invalid_receipt");
        }
        this.options.storage.removeItem(this.options.storageKey);
        this.update({ status: "success", intent: null, message: "原操作已確認；以下狀態仍須重新向伺服器讀取，receipt 不代表目前有效批准。" });
      } else if ([400, 409, 413, 415, 422].includes(response.status)) {
        this.options.storage.removeItem(this.options.storageKey);
        this.update({ status: response.status === 409 ? "conflict" : "failed", intent: null,
          message: "本次操作遭拒絕或證據已變更；請重新讀取並核對，不會改送其他決定。" });
      } else throw new Error("unknown_response");
    } catch {
      this.update({ status: "unknown", intent, message: "結果未知（可能已提交）。原決定、版本與操作鍵已保留；請用原鍵重試。" });
    }
  }
}
