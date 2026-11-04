import { z } from "zod";
import {
  projectClassificationBodySchema, projectClassificationCurrentSchema,
  projectClassificationResponseSchema, projectRequirementsBodySchema,
  problemJsonSchema,
  type ProjectClassificationCurrent, type ProjectClassificationResponse, type ProjectRequirements,
} from "@app-planet/core";

export const classificationIntentSchema = z.object({
  projectId: z.uuid(),
  key: z.uuid(),
  version: z.number().int().min(-2147483648).max(2147483647),
  kind: z.enum(["requirements", "confirmation"]),
  body: z.union([projectRequirementsBodySchema, projectClassificationBodySchema]),
}).strict().refine((value) => value.kind === "requirements"
  ? projectRequirementsBodySchema.safeParse(value.body).success
  : projectClassificationBodySchema.safeParse(value.body).success);
export type ClassificationIntent = z.infer<typeof classificationIntentSchema>;
type FailureKind = "unknown" | "conflict" | "unavailable" | "rejected" | "closed";
type Failure = { ok: false; kind: FailureKind; message: string };
export interface ClassificationTransport {
  read(): Promise<{ ok: true; current: ProjectClassificationCurrent } | Failure>;
  write(intent: ClassificationIntent): Promise<{ ok: true; result: ProjectClassificationResponse } | Failure>;
}

export type RequirementsState = {
  current: ProjectClassificationCurrent;
  editor: ProjectRequirements;
  intent: ClassificationIntent | null;
  status: "idle" | "saving" | FailureKind;
  reading: boolean;
  message: string;
  receipt: ProjectClassificationResponse["operation"] | null;
};
const emptyRequirements: ProjectRequirements = {
  description: "", runtime_needs: "static", runtime_ai_required: false,
};
export const sameRequirements = (a: ProjectRequirements, b: ProjectRequirements | null) =>
  b !== null && a.description === b.description &&
  a.runtime_needs === b.runtime_needs && a.runtime_ai_required === b.runtime_ai_required;

export class RequirementsController {
  private state: RequirementsState;
  private readGeneration = 0;
  private editGeneration = 0;
  private readonly listeners = new Set<() => void>();
  constructor(
    initial: ProjectClassificationCurrent,
    private readonly transport: ClassificationTransport,
    private readonly persist: (intent: ClassificationIntent | null) => void,
  ) {
    this.state = {
      current: initial, editor: { ...(initial.requirements ?? emptyRequirements) },
      intent: null, status: "idle", reading: false, message: "", receipt: null,
    };
  }
  getState = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  private update(patch: Partial<RequirementsState>) {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }
  get dirty() { return !sameRequirements(this.state.editor, this.state.current.requirements ?? emptyRequirements); }
  private invalidateReads() {
    this.readGeneration++;
    this.update({ reading: false });
  }
  edit(editor: ProjectRequirements) {
    this.editGeneration++;
    this.update({ editor: { ...editor } });
  }
  restore(intent: ClassificationIntent) {
    if (intent.projectId !== this.state.current.id) throw new Error("操作與專案不符，已停止。");
    this.invalidateReads();
    this.update({
      intent, status: "unknown", message: "原操作結果尚待確認；只可使用原鍵、原本文與原版本重試。",
      ...("requirements" in intent.body ? { editor: { ...intent.body.requirements } } : {}),
    });
  }
  canConfirm(tier: "A" | "B" | null, visitor: boolean | null, explicitChange: boolean) {
    const { current, status, intent } = this.state;
    return !this.dirty && current.requirements !== null && status === "idle" && intent === null &&
      tier !== null && visitor !== null &&
      (current.requested_tier === null || current.requested_tier === tier || explicitChange);
  }
  private async start(kind: ClassificationIntent["kind"], body: ClassificationIntent["body"]) {
    if (this.state.intent || this.state.status === "saving" || this.state.status === "closed") return false;
    this.invalidateReads();
    const intent: ClassificationIntent = {
      projectId: this.state.current.id, key: crypto.randomUUID(),
      version: this.state.current.row_version, kind, body,
    };
    try { this.persist(intent); }
    catch {
      this.update({ status: "unavailable", message: "無法保留原操作識別；尚未送出，請先修復瀏覽器儲存設定。" });
      return false;
    }
    this.update({ intent });
    return this.send(intent);
  }
  save() {
    return this.start("requirements", {
      expected_requirements_revision: this.state.current.requirements_revision,
      requirements: { ...this.state.editor },
    });
  }
  confirm(tier: "A" | "B", visitor: boolean | null, explicitChange: boolean) {
    if (!this.canConfirm(tier, visitor, explicitChange) || visitor === null) return Promise.resolve(false);
    const requested = this.state.current.requested_tier;
    return this.start("confirmation", {
      expected_requirements_revision: this.state.current.requirements_revision,
      tier, needs_visitor_identity: visitor,
      requested_tier_acknowledgement: requested === null ? "no_preference" :
        requested === tier ? "matches" : "explicit_change",
    });
  }
  retry() {
    return this.state.intent && this.state.status !== "saving" && this.state.status !== "closed"
      ? this.send(this.state.intent) : Promise.resolve(false);
  }
  private async send(intent: ClassificationIntent) {
    this.invalidateReads();
    this.update({ status: "saving", message: intent.kind === "requirements" ? "正在保存正式需求…" : "正在確認分類…" });
    let result: Awaited<ReturnType<ClassificationTransport["write"]>>;
    try { result = await this.transport.write(intent); }
    catch { result = { ok: false, kind: "unknown", message: "結果尚待確認；請以原操作重試。" }; }
    if (this.state.status === "closed") return false;
    if (!result.ok) {
      // 失權與不確定結果均不清除原意圖；關閉畫面不代表未提交。
      if (result.kind === "conflict" || result.kind === "rejected") {
        try { this.persist(null); }
        catch {
          this.update({ status: "unknown", message: "無法清除原操作紀錄；請保留原操作並重新讀取。" });
          return false;
        }
        this.update({ intent: null });
      }
      this.update({ status: result.kind, message: result.message });
      return false;
    }
    if (result.result.current.id !== intent.projectId ||
        result.result.operation.outcome !== (intent.kind === "requirements" ? "saved" : "confirmed") ||
        intent.kind === "confirmation" &&
          result.result.operation.requirements_revision !== intent.body.expected_requirements_revision ||
        result.result.operation.outcome === "confirmed" && "tier" in intent.body &&
          (result.result.operation.tier !== intent.body.tier ||
            result.result.operation.needs_visitor_identity !== intent.body.needs_visitor_identity ||
            result.result.operation.row_version !== intent.version + 1) ||
        result.result.operation.outcome === "saved" && "requirements" in intent.body &&
          !sameRequirements(result.result.operation.requirements, intent.body.requirements)) {
      this.update({ status: "unknown", message: "回應與原操作不符；保留原鍵，尚未確認成功。" });
      return false;
    }
    const { current, operation } = result.result;
    const editor = "requirements" in intent.body && sameRequirements(this.state.editor, intent.body.requirements)
      ? { ...(current.requirements ?? this.state.editor) } : this.state.editor;
    try { this.persist(null); }
    catch {
      this.update({ current, receipt: operation, status: "unknown", message: "提交已取得回應，但原操作紀錄清理失敗；請保留原鍵核對。" });
      return false;
    }
    this.update({ current, editor, intent: null, receipt: operation, status: "idle",
      message: result.result.outcome === "replayed"
        ? "已取得原操作 receipt；當前分類另由伺服器讀取，不會恢復舊確認。"
        : intent.kind === "requirements" ? "正式需求已保存；分類狀態已重新讀取。" : "分類操作已確認；請核對當前狀態。" });
    return !this.dirty;
  }
  async refresh(adopt = false) {
    if (this.state.status === "saving" || this.state.status === "closed") return false;
    const readGeneration = ++this.readGeneration;
    const editGeneration = this.editGeneration;
    this.update({ reading: true });
    let result: Awaited<ReturnType<ClassificationTransport["read"]>>;
    try { result = await this.transport.read(); }
    catch { result = { ok: false, kind: "unavailable", message: "無法讀取服務；請稍後再試。" }; }
    // 失權採保守關閉，即使讀取已過期也不以較新的成功回應抵銷。
    if (!result.ok && result.kind === "closed") {
      this.invalidateReads();
      this.update({ status: "closed", message: result.message });
      return false;
    }
    if (readGeneration !== this.readGeneration) return false;
    if (!result.ok || result.current.id !== this.state.current.id) {
      this.update({ reading: false, status: result.ok ? "unavailable" : result.kind,
        message: result.ok ? "回應與專案不符；受保護內容不會更新。" : result.message });
      return false;
    }
    const editedSinceAdopt = adopt && editGeneration !== this.editGeneration;
    this.update({ current: result.current, reading: false,
      ...(adopt && !editedSinceAdopt ? { editor: { ...(result.current.requirements ?? emptyRequirements) } } : {}),
      status: this.state.intent ? "unknown" : editedSinceAdopt ? "conflict" : "idle",
      message: editedSinceAdopt
        ? "已讀取當前版本；等待期間的新輸入已保留，請重新核對，或再次明確採用當前版本。"
        : "已重新讀取當前需求與分類；未自動確認任何版本。" });
    return true;
  }
  discard() {
    if (this.state.status === "saving" || this.state.status === "closed") return false;
    this.invalidateReads();
    this.update({
      editor: { ...(this.state.current.requirements ?? emptyRequirements) },
      status: this.state.intent ? "unknown" : "idle",
      message: "已放棄本頁未保存編輯；沒有撤回任何已送出操作，未知操作紀錄仍保留。",
    });
    return true;
  }
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("回應缺少內容");
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0;
  let text = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > 256 * 1024) {
      await reader.cancel();
      throw new Error("回應超過界線");
    }
    text += decoder.decode(value, { stream: true });
  }
  return JSON.parse(text + decoder.decode());
}

async function responseFailure(response: Response): Promise<Failure> {
  const parsed = problemJsonSchema.safeParse(await readBoundedJson(response));
  if (!parsed.success || parsed.data.status !== response.status ||
      !response.headers.get("content-type")?.startsWith("application/problem+json")) {
    return { ok: false, kind: "unknown", message: "錯誤回應無法驗證；保留原操作，不會更換操作鍵。" };
  }
  return {
    ok: false,
    kind: [401, 403, 404].includes(response.status) ? "closed" : response.status === 409 ? "conflict" :
      response.status >= 400 && response.status < 500 ? "rejected" : "unknown",
    message: parsed.data.user_message_zh,
  };
}

export function createClassificationTransport(projectId: string, fetchImpl: typeof fetch = fetch): ClassificationTransport {
  const base = `/api/v1/projects/${encodeURIComponent(projectId)}`;
  return {
    async read() {
      const response = await fetchImpl(`${base}/requirements`, {
        cache: "no-store", credentials: "same-origin", signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) return responseFailure(response);
      if (response.status !== 200 || !response.headers.get("content-type")?.startsWith("application/json")) {
        return { ok: false, kind: "unavailable", message: "當前需求回應格式不符；請重新讀取。" };
      }
      const parsed = projectClassificationCurrentSchema.safeParse(await readBoundedJson(response));
      return parsed.success ? { ok: true, current: parsed.data } :
        { ok: false, kind: "unavailable", message: "當前需求回應無法驗證；請重新讀取。" };
    },
    async write(intent) {
      const response = await fetchImpl(`${base}/${intent.kind === "requirements" ? "requirements" : "classification/confirmation"}`, {
        method: intent.kind === "requirements" ? "PUT" : "POST",
        credentials: "same-origin", cache: "no-store",
        headers: { "content-type": "application/json", "if-match": `"${intent.version}"`, "idempotency-key": intent.key },
        body: JSON.stringify(intent.body), signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) return responseFailure(response);
      if (response.status !== 200 || !response.headers.get("content-type")?.startsWith("application/json")) {
        return { ok: false, kind: "unknown", message: "操作回應格式不符；請保留原鍵重試。" };
      }
      const parsed = projectClassificationResponseSchema.safeParse(await readBoundedJson(response));
      return parsed.success ? { ok: true, result: parsed.data } :
        { ok: false, kind: "unknown", message: "操作回應無法驗證；請使用原鍵重試。" };
    },
  };
}
