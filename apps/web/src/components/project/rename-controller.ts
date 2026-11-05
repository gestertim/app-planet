import { z } from "zod";
import {
  projectRenameBodySchema, projectRenameCurrentSchema, projectRenameResponseSchema,
  problemJsonSchema, type ProjectRenameCurrent, type ProjectRenameResponse,
} from "@app-planet/core";
import { readBoundedJson } from "./bounded-json.ts";

const version = z.number().int().min(-2147483648).max(2147483647);
export const renameIntentSchema = z.strictObject({
  projectId: z.uuid(), key: z.uuid(), version, body: projectRenameBodySchema,
});
export type RenameIntent = z.infer<typeof renameIntentSchema>;
type Conflict = {
  current: { version: number; content: { title: string } };
  submitted: { version: number; content: { title: string } };
};
type Failure = { ok: false; kind: "unknown" | "closed" | "rejected"; message: string }
  | { ok: false; kind: "conflict"; message: string; conflict: Conflict };
export interface RenameTransport {
  read(): Promise<{ ok: true; current: ProjectRenameCurrent } | Failure>;
  write(intent: RenameIntent, replayOnly: boolean): Promise<{ ok: true; result: ProjectRenameResponse } | Failure>;
}
type State = {
  current: ProjectRenameCurrent; editor: string; intent: RenameIntent | null;
  status: "idle" | "saving" | "unknown" | "closed" | "rejected" | "conflict" | "success";
  reading: boolean; message: string; conflict: Conflict | null;
};
const owners = new Map<string, object>();
export class RenameController {
  private state: State;
  private epoch = 0;
  private reads = 0;
  private edits = 0;
  private active = false;
  private readonly owner = {};
  private readonly listeners = new Set<() => void>();
  constructor(initial: ProjectRenameCurrent, private readonly transport: RenameTransport,
    private readonly storage: Pick<Storage, "getItem" | "setItem" | "removeItem">,
    private readonly storageKey: string) {
    this.state = { current: initial, editor: initial.title, intent: null, status: "idle",
      reading: false, message: "", conflict: null };
  }
  getState = () => this.state;
  get dirty() { return this.state.editor !== this.state.current.title; }
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  private update(patch: Partial<State>) {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }
  private live(epoch: number) {
    return this.active && epoch === this.epoch && owners.get(this.storageKey) === this.owner;
  }
  attach() {
    this.active = true;
    ++this.epoch;
    owners.set(this.storageKey, this.owner);
    try {
      const raw = this.storage.getItem(this.storageKey);
      if (raw !== null) {
        const parsed = renameIntentSchema.safeParse(JSON.parse(raw));
        if (!parsed.success || parsed.data.projectId !== this.state.current.id) throw new Error("invalid_intent");
        this.update({ intent: parsed.data, editor: parsed.data.body.title, status: "unknown",
          message: "原改名結果待確認；只可用原鍵、原名稱與原版本重試。" });
      }
    } catch {
      this.update({ status: "closed", message: "原操作紀錄無法讀取；已停止送出，請保留紀錄並請老師協助。" });
    }
  }
  detach() {
    this.active = false;
    ++this.epoch;
    ++this.reads;
    if (owners.get(this.storageKey) === this.owner) owners.delete(this.storageKey);
  }
  edit(editor: string) {
    if (!this.active || this.state.status === "closed") return;
    ++this.edits;
    this.update({ editor });
  }
  private clear(intent: RenameIntent) {
    const raw = this.storage.getItem(this.storageKey);
    if (raw !== JSON.stringify(intent)) throw new Error("operation_record_changed");
    this.storage.removeItem(this.storageKey);
    if (this.storage.getItem(this.storageKey) !== null) throw new Error("operation_record_not_removed");
  }
  async save() {
    if (!this.live(this.epoch) || this.state.intent || this.state.status === "saving" || this.state.status === "closed") return false;
    const parsed = projectRenameBodySchema.safeParse({ title: this.state.editor });
    if (!parsed.success) {
      this.update({ status: "rejected", message: "請輸入符合專案名稱規則的名稱；原輸入仍保留。" });
      return false;
    }
    const intent = { projectId: this.state.current.id, key: crypto.randomUUID(),
      version: this.state.current.row_version, body: parsed.data };
    try {
      if (this.storage.getItem(this.storageKey) !== null) throw new Error("unresolved_operation");
      const raw = JSON.stringify(intent);
      this.storage.setItem(this.storageKey, raw);
      if (this.storage.getItem(this.storageKey) !== raw) throw new Error("storage_verification_failed");
    } catch {
      this.update({ status: "closed", message: "無法可靠保留原操作；尚未送出，請重新載入核對紀錄。" });
      return false;
    }
    this.update({ intent });
    return this.send(intent, false);
  }
  retry() {
    return this.state.intent && this.state.status === "unknown" && this.live(this.epoch)
      ? this.send(this.state.intent, true) : Promise.resolve(false);
  }
  private async send(intent: RenameIntent, replayOnly: boolean) {
    const epoch = this.epoch;
    ++this.reads;
    this.update({ status: "saving", reading: false, message: "正在保存專案名稱…" });
    let response: Awaited<ReturnType<RenameTransport["write"]>>;
    try { response = await this.transport.write(intent, replayOnly); }
    catch { response = { ok: false, kind: "unknown", message: "結果未知（可能已提交）；請用原操作重試。" }; }
    if (!this.live(epoch) || this.state.status === "closed") return false;
    if (!response.ok) {
      if (response.kind === "conflict" && (response.conflict.submitted.version !== intent.version ||
          response.conflict.submitted.content.title !== intent.body.title)) {
        this.update({ status: "unknown", message: "衝突回應與原操作不符；保留原鍵核對。" });
        return false;
      }
      if (response.kind === "conflict" || response.kind === "rejected") {
        try { this.clear(intent); }
        catch {
          this.update({ status: "unknown", message: "無法清除原操作紀錄；請保留原鍵核對。" });
          return false;
        }
        this.update({ intent: null, ...(response.kind === "conflict" ? {
          conflict: response.conflict, current: { id: intent.projectId,
            title: response.conflict.current.content.title, row_version: response.conflict.current.version },
        } : {}) });
      }
      this.update({ status: response.kind, message: response.message });
      return false;
    }
    const { operation, current } = response.result;
    if (operation.id !== intent.projectId || current.id !== intent.projectId ||
      operation.title !== intent.body.title || operation.row_version !== intent.version + 1 ||
      current.row_version < operation.row_version ||
      current.row_version === operation.row_version && current.title !== operation.title) {
      this.update({ status: "unknown", message: "回應與原操作不符；原鍵已保留，不把名稱相同當成成功證據。" });
      return false;
    }
    try { this.clear(intent); }
    catch {
      this.update({ status: "unknown", message: "已取得 receipt，但紀錄清理失敗；請保留原操作核對。" });
      return false;
    }
    this.update({ current, intent: null, conflict: null, status: "success",
      editor: this.state.editor === intent.body.title ? current.title : this.state.editor,
      message: response.result.outcome === "replayed"
        ? "原改名已確認；目前名稱另由資料庫讀取，不會覆蓋後來的修改。"
        : "專案名稱已保存，並已讀回資料庫目前名稱。" });
    return !this.dirty;
  }
  async refresh(adopt = false) {
    if (!this.live(this.epoch) || this.state.status === "saving" || this.state.status === "closed") return false;
    const epoch = this.epoch;
    const generation = ++this.reads;
    const edits = this.edits;
    this.update({ reading: true });
    let result: Awaited<ReturnType<RenameTransport["read"]>>;
    try { result = await this.transport.read(); }
    catch { result = { ok: false, kind: "unknown", message: "無法讀取資料庫名稱；輸入仍保留。" }; }
    if (!this.live(epoch)) return false;
    if (!result.ok && result.kind === "closed") {
      ++this.reads;
      ++this.epoch;
      this.update({ status: "closed", reading: false, message: result.message });
      return false;
    }
    if (generation !== this.reads) return false;
    if (!result.ok || result.current.id !== this.state.current.id) {
      this.update({ reading: false, message: result.ok ? "專案回應不符；輸入仍保留。" : result.message });
      return false;
    }
    const changed = edits !== this.edits;
    this.update({ current: result.current, reading: false, conflict: null,
      ...(adopt && !changed && !this.state.intent ? { editor: result.current.title } : {}),
      status: this.state.intent ? "unknown" : "idle",
      message: changed ? "已讀取目前名稱；等待期間的新輸入已保留。" : "已重新讀取資料庫目前名稱。" });
    return true;
  }
  cancel() {
    if (!this.live(this.epoch) || this.state.status === "saving" || this.state.status === "closed") return false;
    ++this.reads;
    this.update({ editor: this.state.current.title, reading: false, conflict: null,
      status: this.state.intent ? "unknown" : "idle",
      message: this.state.intent ? "已放棄本頁編輯；未知操作仍保留，這不會撤回可能已提交的改名。" : "已取消；沒有送出改名。" });
    return true;
  }
}

const side = z.strictObject({ version: z.union([version, z.string().regex(/^(?:0|-?[1-9]\d*)$/).transform(Number).pipe(version)]),
  content: projectRenameBodySchema });
const conflictSchema = problemJsonSchema.extend({ status: z.literal(409), code: z.literal("version_conflict"),
  conflict: z.strictObject({ current: side, submitted: side }) }).strict();
export function createRenameTransport(id: string, run: typeof fetch = fetch): RenameTransport {
  const url = `/api/v1/projects/${encodeURIComponent(id)}`;
  const failure = async (response: Response): Promise<Failure> => {
    if ([401, 403, 404].includes(response.status)) return {
      ok: false, kind: "closed", message: "已失去專案存取權；內容已隱藏，原操作仍保留。" };
    const raw = await readBoundedJson(response);
    const conflict = conflictSchema.safeParse(raw);
    if (response.status === 409 && conflict.success &&
      response.headers.get("content-type")?.startsWith("application/problem+json")) return { ok: false, kind: "conflict",
      message: "版本衝突：你的名稱仍保留。請比較目前名稱，再重新讀取或明確再次保存。",
      conflict: conflict.data.conflict };
    const problem = problemJsonSchema.safeParse(raw);
    const knownRejection = problem.success && problem.data.status === response.status &&
      response.headers.get("content-type")?.startsWith("application/problem+json") &&
      problem.data.code !== "idempotency_key_reuse" &&
      [400, 413, 415, 422].includes(response.status);
    return { ok: false, kind: knownRejection ? "rejected" : "unknown",
      message: problem.success ? problem.data.user_message_zh : "回應無法確認；原操作仍保留。" };
  };
  return {
    async read() {
      const response = await run(url, { cache: "no-store", credentials: "same-origin", signal: AbortSignal.timeout(10_000) });
      if (!response.ok) return failure(response);
      const raw = await readBoundedJson(response);
      const projected = typeof raw === "object" && raw !== null
        ? projectRenameCurrentSchema.safeParse(Object.fromEntries(
          Object.entries(raw).filter(([key]) => ["id", "title", "row_version"].includes(key)))) : null;
      return response.status === 200 && response.headers.get("content-type")?.startsWith("application/json") &&
        projected?.success && response.headers.get("etag") === `"${projected.data.row_version}"`
        ? { ok: true, current: projected.data } :
        { ok: false, kind: "unknown", message: "目前名稱回應無法驗證；輸入仍保留。" };
    },
    async write(intent, replayOnly) {
      const response = await run(url, {
        method: "PATCH", credentials: "same-origin", cache: "no-store",
        headers: { "content-type": "application/json", "if-match": `"${intent.version}"`,
          "idempotency-key": intent.key, ...(replayOnly ? { "idempotency-replay-only": "true" } : {}) },
        body: JSON.stringify(intent.body), signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) return failure(response);
      const raw = await readBoundedJson(response);
      const parsed = projectRenameResponseSchema.safeParse(raw);
      return response.status === 200 && response.headers.get("content-type")?.startsWith("application/json") &&
        parsed.success && response.headers.get("etag") === `"${parsed.data.current.row_version}"`
        ? { ok: true, result: parsed.data } :
        { ok: false, kind: "unknown", message: "保存回應無法驗證；請以原操作重試。" };
    },
  };
}
