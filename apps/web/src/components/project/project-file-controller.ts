import {
  problemJsonSchema,
  projectFileContentDtoSchema,
  projectFileContentSchema,
  projectFileDtoSchema,
  projectFileListSchema,
  projectFilePathSchema,
  type ProjectFileContentDto,
  type ProjectFileDto,
} from "@app-planet/core";
import type { GuardResult } from "./unsaved-changes-guard.tsx";

type FetchResponse = Readonly<{ status: number; ok: boolean; json(): Promise<unknown> }>;
export type ProjectFileWriteIntent = Readonly<{
  key: string;
  content: string;
  ifMatch: string | null;
  ifNoneMatch: "*" | null;
  revision: number;
}>;
type LocalDraft = Readonly<{
  version: 1;
  account_scope: string;
  project_id: string;
  path: string;
  base_hash: string | null;
  content: string;
  pending: ProjectFileWriteIntent | null;
}>;
type WorkspaceFile = ProjectFileDto & Readonly<{ local_only: boolean }>;

export type ProjectFileWorkspaceState = Readonly<{
  files: readonly WorkspaceFile[];
  active_path: string | null;
  content: string;
  saved_file: ProjectFileContentDto | null;
  saved_content: string | null;
  dirty: boolean;
  status: "loading" | "ready" | "saving" | "unknown" | "unrecoverable" | "conflict" | "failed" | "denied";
  error: string | null;
  storage_warning: string | null;
  server_conflict: ProjectFileContentDto | null;
}>;

export type ProjectFileTransport = Readonly<{
  list(): Promise<FetchResponse>;
  read(path: string): Promise<FetchResponse>;
  write(path: string, intent: ProjectFileWriteIntent, replayOnly: boolean): Promise<FetchResponse>;
}>;

export type SessionStore = Pick<Storage, "getItem" | "setItem" | "removeItem" | "key" | "length">;

const initialState: ProjectFileWorkspaceState = Object.freeze({
  files: [], active_path: null, content: "", saved_file: null, saved_content: null,
  dirty: false, status: "loading", error: null, storage_warning: null, server_conflict: null,
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseLocalDraft(value: unknown, scope: string, projectId: string, path: string): LocalDraft | null {
  if (!isRecord(value) || Object.keys(value).sort().join(",") !==
      "account_scope,base_hash,content,path,pending,project_id,version") return null;
  if (value.version !== 1 || value.account_scope !== scope || value.project_id !== projectId ||
      value.path !== path || !(value.base_hash === null || /^[0-9a-f]{64}$/.test(String(value.base_hash))) ||
      typeof value.content !== "string" || !projectFileContentSchema.safeParse(value.content).success) return null;
  let pending: ProjectFileWriteIntent | null = null;
  if (value.pending !== null) {
    if (!isRecord(value.pending) ||
        Object.keys(value.pending).sort().join(",") !== "content,ifMatch,ifNoneMatch,key,revision" ||
        typeof value.pending.key !== "string" || !/^[0-9a-f-]{36}$/i.test(value.pending.key) ||
        typeof value.pending.content !== "string" ||
        !projectFileContentSchema.safeParse(value.pending.content).success ||
        !(value.pending.ifMatch === null || /^[0-9a-f]{64}$/.test(String(value.pending.ifMatch))) ||
        !(value.pending.ifNoneMatch === null || value.pending.ifNoneMatch === "*") ||
        !Number.isInteger(value.pending.revision)) return null;
    pending = {
      key: value.pending.key,
      content: value.pending.content,
      ifMatch: value.pending.ifMatch as string | null,
      ifNoneMatch: value.pending.ifNoneMatch as "*" | null,
      revision: value.pending.revision as number,
    };
  }
  return {
    version: 1, account_scope: scope, project_id: projectId, path,
    base_hash: value.base_hash as string | null, content: value.content, pending,
  };
}

export class ProjectFileController {
  private state: ProjectFileWorkspaceState = initialState;
  private readonly listeners = new Set<() => void>();
  private epoch = 0;
  private editRevision = 0;
  private pending: ProjectFileWriteIntent | null = null;
  private draftBaseHash: string | null = null;
  private readonly ownedDraftRecords = new Map<string, string | null>();
  private disposed = false;
  // 檔案選取世代：open／createDraft 各自遞增，較舊的讀取或初始 hash 開檔不能奪回目前檔案。
  private selection = 0;
  private storageProblem = false;
  private readonly prefix: string;

  constructor(
    private readonly projectId: string,
    private readonly accountScope: string,
    private readonly transport: ProjectFileTransport,
    private readonly storage: SessionStore | null,
    private readonly onAccessLost: () => void,
  ) {
    this.prefix = `app-planet.project-files.v1.${accountScope}.${projectId}.`;
    if (!storage) this.patch({ storage_warning: "sessionStorage 不可用；本機草稿只留在目前頁面，無法保證 reload 後恢復。" });
  }

  getState(): ProjectFileWorkspaceState { return this.state; }
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  dispose(): void {
    this.disposed = true;
    this.epoch++;
    this.listeners.clear();
  }

  async initialize(path: string | null): Promise<void> {
    const epoch = ++this.epoch;
    const selection = this.selection;
    this.disposed = false;
    this.patch({ status: "loading", error: null });
    let response: FetchResponse;
    try { response = await this.transport.list(); }
    catch {
      if (this.live(epoch)) this.patch({ status: "failed", error: "無法載入已保存檔案清單；請確認連線後重試。" });
      return;
    }
    if (!this.live(epoch)) return;
    if (response.status === 401 || response.status === 403 || response.status === 404) {
      this.loseAccess();
      return;
    }
    const payload = response.ok ? await response.json().catch(() => null) : null;
    if (!this.live(epoch)) return;
    const parsed = projectFileListSchema.safeParse(payload);
    if (!response.ok || !parsed.success) {
      this.patch({ status: "failed", error: "檔案清單回應無法確認；受保護內容未載入。" });
      return;
    }
    const server = parsed.data.items.map((file) => ({ ...file, local_only: false }));
    const drafts = this.readDraftIndex();
    const merged = [...server];
    for (const draftPath of drafts) {
      if (server.some((file) => file.path === draftPath)) continue;
      const draft = this.readDraft(draftPath);
      if (draft) merged.push({
        path: draftPath, hash: draft.base_hash ?? "0".repeat(64), bytes: new TextEncoder().encode(draft.content).byteLength,
        updated_at: "1970-01-01T00:00:00.000000Z", local_only: true,
      });
    }
    for (const file of this.state.files) {
      if (file.local_only && !merged.some((entry) => entry.path === file.path)) merged.push(file);
    }
    merged.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    this.patch({ files: merged, status: "ready" });
    if (selection !== this.selection) return;
    if (path && projectFilePathSchema.safeParse(path).success) {
      if (merged.some((file) => file.path === path)) await this.open(path);
    }
  }

  async open(path: string): Promise<void> {
    if (!projectFilePathSchema.safeParse(path).success) {
      this.patch({ error: "檔案路徑不符合支援格式。" });
      return;
    }
    const epoch = ++this.epoch;
    const selection = ++this.selection;
    const selected = () => this.live(epoch) && selection === this.selection;
    this.patch({ status: "loading", active_path: path, error: null, saved_file: null,
      saved_content: null, content: "", dirty: false, server_conflict: null });
    let serverFile: ProjectFileContentDto | null = null;
    const listEntry = this.state.files.find((file) => file.path === path && !file.local_only);
    if (listEntry) {
      let response: FetchResponse;
      try { response = await this.transport.read(path); }
      catch {
        if (selected()) this.patch({ status: "failed", error: "無法讀取伺服器檔案；本機草稿未變更。" });
        return;
      }
      if (!selected()) return;
      if (response.status === 401 || response.status === 403 || response.status === 404) {
        if (response.status === 404) {
          this.patch({ status: "conflict", error: "檔案清單與讀取結果不同；本機內容仍保留，請重新載入清單。" });
        } else this.loseAccess();
        return;
      }
      const payload = response.ok ? await response.json().catch(() => null) : null;
      if (!selected()) return;
      const parsed = projectFileContentDtoSchema.safeParse(payload);
      if (!response.ok || !parsed.success) {
        this.patch({ status: "failed", error: "伺服器檔案回應無法確認；本機草稿未變更。" });
        return;
      }
      serverFile = parsed.data;
    }
    const local = this.readDraft(path);
    if (!selected()) return;
    if (!serverFile && !local) {
      this.patch({ status: "failed", active_path: null, error: "此檔案不存在。請使用「新增檔案」明確建立。" });
      return;
    }
    if (!serverFile && local && local.base_hash !== null) {
      this.patch({ status: "conflict", error: "本機草稿原本對應的伺服器檔案已不存在；內容仍保留。" });
      return;
    }
    this.pending = local?.pending ?? null;
    this.draftBaseHash = local ? local.base_hash : serverFile?.hash ?? null;
    const conflict = Boolean(serverFile && local && local.base_hash !== serverFile.hash && !local.pending);
    this.patch({
      files: this.state.files,
      status: this.pending ? "unknown" : conflict ? "conflict" : "ready",
      active_path: path,
      content: local?.content ?? serverFile?.content ?? "",
      saved_file: serverFile,
      saved_content: serverFile?.content ?? null,
      dirty: local ? (!serverFile || local.content !== serverFile.content || Boolean(local.pending)) : false,
      server_conflict: conflict ? serverFile : null,
      error: conflict ? "server 保存版本已變更；本機草稿保留，請比對後明確選擇處理方式。" : null,
    });
  }

  createDraft(path: string): boolean {
    if (!projectFilePathSchema.safeParse(path).success) {
      this.patch({ error: "檔名不符合支援格式，僅接受 .html、.css、.js。" });
      return false;
    }
    if (this.state.files.some((file) => file.path === path)) {
      this.patch({ error: "這個檔案名稱已存在；不會覆蓋或清除原草稿。" });
      return false;
    }
    this.selection++;
    this.pending = null;
    this.draftBaseHash = null;
    this.ownedDraftRecords.set(path, null);
    this.editRevision++;
    this.patch({
      active_path: path, content: "", saved_file: null, saved_content: null,
      dirty: true, status: "ready", error: null, server_conflict: null,
      files: this.withLocalFile(path, null, ""),
    });
    this.persistDraft();
    return true;
  }

  edit(content: string): void {
    if (!projectFileContentSchema.safeParse(content).success) {
      this.patch({ error: "原始碼超過 262,144 UTF-8 bytes，或包含不支援的 Unicode。" });
      return;
    }
    this.editRevision++;
    this.patch({ content, dirty: this.state.saved_content !== content || this.state.saved_file === null,
      error: null });
    this.persistDraft();
  }

  async save(): Promise<GuardResult> {
    const path = this.state.active_path;
    if (!path || this.state.status === "saving" || this.state.status === "unrecoverable") {
      return { outcome: "blocked", reason: "saving" };
    }
    if (this.state.status === "conflict") return { outcome: "blocked", reason: "conflict" };
    if (!this.state.dirty && this.state.saved_file) return { outcome: "switched" };

    // 模式在送出前固定：沿用既有 pending（未知或 reload 恢復）一律 replay-only。
    const replayOnly = this.pending !== null;
    const intent: ProjectFileWriteIntent = this.pending ?? {
      key: crypto.randomUUID(),
      content: this.state.content,
      ifMatch: this.state.saved_file?.hash ?? null,
      ifNoneMatch: this.state.saved_file ? null : "*",
      revision: this.editRevision,
    };
    this.pending = intent;
    this.persistDraft();
    this.patch({ status: "saving", error: null });
    const epoch = this.epoch;
    let response: FetchResponse;
    try { response = await this.transport.write(path, intent, replayOnly); }
    catch {
      if (this.ownsWrite(epoch, path, intent)) {
        this.patch({ status: "unknown", error: "保存結果未知（可能已寫入）；原內容與操作識別已保留，請用原操作重試。" });
      }
      return { outcome: "blocked", reason: "retry_required" };
    }
    if (!this.ownsWrite(epoch, path, intent)) {
      return { outcome: "blocked", reason: "still_dirty" };
    }
    if (response.status === 401 || response.status === 403 || response.status === 404) {
      this.loseAccess();
      return { outcome: "blocked", reason: "save_failed" };
    }
    let payload: unknown = null;
    try { payload = await response.json(); } catch { /* an incomplete body leaves the operation outcome unknown */ }
    if (!this.ownsWrite(epoch, path, intent)) return { outcome: "blocked", reason: "still_dirty" };

    if (response.ok) {
      const saved = projectFileDtoSchema.safeParse(payload);
      let expectedHash: string | null = null;
      try { expectedHash = await sha256(intent.content); } catch { /* without a verified digest the receipt is not trusted */ }
      if (!this.ownsWrite(epoch, path, intent)) return { outcome: "blocked", reason: "still_dirty" };
      const bytes = new TextEncoder().encode(intent.content).byteLength;
      // 正式契約：首次新建 201；CAS 更新與任何同鍵重放 200。replay-only 只承認 200。
      const validStatus = replayOnly
        ? response.status === 200
        : response.status === 201 ? intent.ifNoneMatch === "*" : response.status === 200;
      if (!saved?.success || !expectedHash || !validStatus ||
          saved.data.path !== path || saved.data.bytes !== bytes || saved.data.hash !== expectedHash) {
        this.markWriteUnknown("保存成功回應缺少可信完整收據；原本文與操作識別已保留，請用原操作重試。");
        return { outcome: "blocked", reason: "retry_required" };
      }
      this.pending = null;
      const nextSaved = { ...saved.data, content: intent.content };
      this.draftBaseHash = nextSaved.hash;
      const unchanged = this.state.content === intent.content;
      this.patch({
        status: "ready", saved_file: nextSaved, saved_content: intent.content,
        content: unchanged ? intent.content : this.state.content,
        dirty: !unchanged,
        files: this.withServerFile(nextSaved),
        error: null, server_conflict: null,
      });
      if (unchanged) this.removeDraft(path);
      else this.persistDraft();
      return unchanged ? { outcome: "switched" } : { outcome: "blocked", reason: "still_dirty" };
    }
    const problem = problemJsonSchema.safeParse(payload);
    if (!problem.success || problem.data.status !== response.status) {
      this.markWriteUnknown("保存回應無法依正式 problem 格式確認；原操作識別仍保留，請用原操作重試。");
      return { outcome: "blocked", reason: "retry_required" };
    }
    if (problem.data.code === "version_conflict" && response.status === 409) {
      this.pending = null;
      this.persistDraft();
      await this.reloadConflict(path, epoch);
      return { outcome: "blocked", reason: "conflict" };
    }
    if (problem.data.code === "operation_outcome_unrecoverable") {
      this.patch({ status: "unrecoverable",
        error: "原保存操作目前無法安全確認；操作識別與草稿已保留，系統不會建立新操作。請先人工核對並尋求協助。" });
      this.persistDraft();
      return { outcome: "blocked", reason: "retry_required" };
    }
    if (problem.data.code === "operation_outcome_unknown" || response.status >= 500) {
      this.markWriteUnknown("保存結果未知；本機草稿與原操作識別保留，請使用原操作重試。");
      return { outcome: "blocked", reason: "retry_required" };
    }
    this.pending = null;
    this.patch({ status: "failed", error: response.status === 412
      ? "檔案已存在；本機內容保留，沒有覆蓋伺服器檔案。"
      : "保存失敗；本機草稿仍保留，可修正後重試。" });
    this.persistDraft();
    return { outcome: "blocked", reason: "save_failed" };
  }

  async retryThenLeave(): Promise<GuardResult> {
    if (this.state.status === "unrecoverable") return { outcome: "blocked", reason: "retry_required" };
    if (this.state.status !== "unknown" || !this.pending) {
      return { outcome: "blocked", reason: "retry_required" };
    }
    return this.save();
  }

  async discardAndLeave(): Promise<GuardResult> {
    if (this.state.status === "saving") return { outcome: "blocked", reason: "saving" };
    if (this.state.status === "unknown") return { outcome: "blocked", reason: "retry_required" };
    const path = this.state.active_path;
    if (path) this.removeDraft(path);
    this.pending = null;
    this.draftBaseHash = (this.state.server_conflict ?? this.state.saved_file)?.hash ?? null;
    this.editRevision++;
    const files = path && !this.state.saved_file
      ? this.state.files.filter((file) => file.path !== path)
      : this.state.files;
    this.patch({
      content: this.state.server_conflict?.content ?? this.state.saved_content ?? "", dirty: false, status: "ready",
      saved_file: this.state.server_conflict ?? this.state.saved_file,
      saved_content: this.state.server_conflict?.content ?? this.state.saved_content,
      server_conflict: null, error: null, files,
    });
    return { outcome: "switched" };
  }

  async adoptServerVersion(): Promise<void> {
    const current = this.state.server_conflict;
    const path = this.state.active_path;
    if (!current || !path) return;
    this.removeDraft(path);
    this.pending = null;
    this.draftBaseHash = current.hash;
    this.editRevision++;
    this.patch({
      saved_file: current, saved_content: current.content, content: current.content,
      dirty: false, status: "ready", server_conflict: null, error: null,
      files: this.withServerFile(current),
    });
  }

  async continueFromServerVersion(): Promise<void> {
    const current = this.state.server_conflict;
    const path = this.state.active_path;
    if (!current || !path) return;
    this.pending = null;
    this.draftBaseHash = current.hash;
    this.patch({ saved_file: current, saved_content: current.content, status: "ready",
      server_conflict: null, error: "已明確採用伺服器版本作為 CAS 基準；本機文字仍保留，保存前請再次比對。" });
    this.persistDraft();
  }

  private async reloadConflict(path: string, epoch: number): Promise<void> {
    try {
      const response = await this.transport.read(path);
      if (!this.live(epoch)) return;
      if (response.status === 401 || response.status === 403) { this.loseAccess(); return; }
      const payload = response.ok ? await response.json().catch(() => null) : null;
      if (!this.live(epoch) || this.state.active_path !== path) return;
      const parsed = response.ok ? projectFileContentDtoSchema.safeParse(payload) : null;
      if (!parsed?.success) {
        this.patch({ status: "conflict", error: "版本衝突；無法確認最新伺服器本文，本機內容仍保留。" });
        return;
      }
      this.patch({ status: "conflict", server_conflict: parsed.data,
        error: "版本衝突；請比較伺服器版本與本機草稿，選擇採用伺服器或明確以新版本為 CAS 基準。" });
      this.persistDraft();
    } catch {
      if (this.live(epoch)) this.patch({ status: "conflict",
        error: "版本衝突且無法重新讀取伺服器版本；本機內容仍保留。" });
    }
  }

  private readDraftIndex(): string[] {
    if (!this.storage) return [];
    try {
      const raw = this.storage.getItem(`${this.prefix}index`);
      if (raw === null) return [];
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed) || parsed.some((item) =>
        typeof item !== "string" || !projectFilePathSchema.safeParse(item).success)) {
        this.storageProblem = true;
        this.patch({ storage_warning: "本機草稿索引已損壞；不會覆蓋 server 版本，部分草稿可能無法恢復。" });
        return [];
      }
      return [...new Set(parsed as string[])];
    } catch {
      this.storageProblem = true;
      this.patch({ storage_warning: "無法讀取本機草稿索引；本機草稿恢復受限，server 內容仍以 DB 為準。" });
      return [];
    }
  }

  private readDraft(path: string): LocalDraft | null {
    if (!this.storage) return null;
    try {
      const raw = this.storage.getItem(this.draftKey(path));
      this.ownedDraftRecords.set(path, raw);
      if (raw === null) return null;
      const parsed = parseLocalDraft(JSON.parse(raw), this.accountScope, this.projectId, path);
      if (!parsed) {
        this.storageProblem = true;
        this.patch({ storage_warning: "本機草稿資料損壞或格式不支援；未將其當作已保存內容。" });
      }
      return parsed;
    } catch {
      this.storageProblem = true;
      this.patch({ storage_warning: "本機草稿無法讀取；未將其當作已保存內容。" });
      return null;
    }
  }

  private persistDraft(): void {
    const path = this.state.active_path;
    if (!path || !this.storage) return;
    const indexKey = `${this.prefix}index`;
    try {
      if (!this.ownedDraftRecords.has(path)) {
        this.ownedDraftRecords.set(path, this.storage.getItem(this.draftKey(path)));
      }
      const currentRecord = this.storage.getItem(this.draftKey(path));
      if (currentRecord !== this.ownedDraftRecords.get(path)) {
        this.patch({ storage_warning: "本機草稿已由其他頁面實例更新；本頁不會覆寫或清除較新的草稿。" });
        return;
      }
      const paths = this.readDraftIndex();
      const draft: LocalDraft = {
        version: 1, account_scope: this.accountScope, project_id: this.projectId, path,
        base_hash: this.draftBaseHash,
        content: this.state.content, pending: this.pending,
      };
      const serialized = JSON.stringify(draft);
      if (!this.storageProblem && !paths.includes(path)) {
        this.storage.setItem(indexKey, JSON.stringify([...paths, path]));
      }
      this.storage.setItem(this.draftKey(path), serialized);
      this.ownedDraftRecords.set(path, serialized);
      if (!this.storageProblem) this.patch({ storage_warning: null });
    } catch {
      this.storageProblem = true;
      this.patch({ storage_warning: "sessionStorage 額度不足或不可用；草稿仍留在本頁，但 reload 後可能無法恢復。" });
    }
  }

  private removeDraft(path: string): void {
    if (!this.storage) return;
    try {
      if (!this.ownedDraftRecords.has(path)) return;
      const currentRecord = this.storage.getItem(this.draftKey(path));
      if (currentRecord !== this.ownedDraftRecords.get(path)) return;
      this.storage.removeItem(this.draftKey(path));
      this.ownedDraftRecords.set(path, null);
      if (this.storageProblem) return;
      const paths = this.readDraftIndex().filter((item) => item !== path);
      if (paths.length) this.storage.setItem(`${this.prefix}index`, JSON.stringify(paths));
      else this.storage.removeItem(`${this.prefix}index`);
    } catch {
      this.storageProblem = true;
      this.patch({ storage_warning: "無法清理本功能的 sessionStorage 草稿鍵；不會清除其他儲存資料。" });
    }
  }

  private draftKey(path: string): string {
    return `${this.prefix}${encodeURIComponent(path)}`;
  }

  private withLocalFile(path: string, hash: string | null, content: string): WorkspaceFile[] {
    const without = this.state.files.filter((file) => file.path !== path);
    without.push({
      path, hash: hash ?? "0".repeat(64), bytes: new TextEncoder().encode(content).byteLength,
      updated_at: "1970-01-01T00:00:00.000000Z", local_only: true,
    });
    return without.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  }

  private withServerFile(file: ProjectFileDto): WorkspaceFile[] {
    const without = this.state.files.filter((item) => item.path !== file.path);
    without.push({ ...file, local_only: false });
    return without.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  }

  private loseAccess(): void {
    this.pending = null;
    this.epoch++;
    this.patch({ files: [], active_path: null, content: "", saved_file: null,
      saved_content: null, dirty: false, status: "denied", error: "無法重新確認權限；受保護內容已隱藏。" });
    this.onAccessLost();
  }

  private live(epoch: number): boolean {
    return !this.disposed && epoch === this.epoch;
  }

  private ownsWrite(epoch: number, path: string, intent: ProjectFileWriteIntent): boolean {
    return this.live(epoch) && this.state.active_path === path && this.pending?.key === intent.key;
  }

  private markWriteUnknown(message: string): void {
    this.patch({ status: "unknown", error: message });
    this.persistDraft();
  }

  private patch(update: Partial<ProjectFileWorkspaceState>): void {
    if (this.disposed) return;
    this.state = Object.freeze({ ...this.state, ...update });
    for (const listener of this.listeners) listener();
  }

}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
