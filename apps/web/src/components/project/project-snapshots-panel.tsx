"use client";

import { useEffect, useRef, useState } from "react";
import {
  problemJsonSchema,
  projectFilePathSchema,
  projectSnapshotDtoSchema,
  projectSnapshotFileSchema,
  projectSnapshotListSchema,
  projectSnapshotManifestSchema,
} from "@app-planet/core";
import { productFetch as fetch } from "../auth/product-fetch.ts";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isSnapshotOperationKey(value: string): boolean {
  return uuid.test(value);
}
type SnapshotPage = ReturnType<typeof projectSnapshotListSchema.parse>;
type SnapshotManifest = ReturnType<typeof projectSnapshotManifestSchema.parse>;
type SnapshotFile = ReturnType<typeof projectSnapshotFileSchema.parse>;
export type SnapshotProblemDisposition = "unrecoverable" | "storage_limit" | "unknown" | "rejected";

export function classifySnapshotProblem(status: number, code: string): SnapshotProblemDisposition {
  if (code === "operation_outcome_unrecoverable") return "unrecoverable";
  if (status === 507 && code === "storage_limit") return "storage_limit";
  if (code === "operation_outcome_unknown" || status >= 500) return "unknown";
  return "rejected";
}

export type SnapshotCreateMode = "initial" | "replay_only";

// 只有本次新產生且尚未送出過的 key 是一般模式；沿用任何既有 key 都只能重放原操作。
export function snapshotCreateMode(
  { keyGeneratedForThisRequest }: Readonly<{ keyGeneratedForThisRequest: boolean }>,
): SnapshotCreateMode {
  return keyGeneratedForThisRequest ? "initial" : "replay_only";
}

// 正式契約：首次建立 201、同鍵重放 200；replay-only 只承認 200。
// 本面板送出的 body 只有 { kind: "manual" }，可信收據須與此一致。
export function trustedSnapshotCreateReceipt(
  mode: SnapshotCreateMode,
  status: number,
  payload: unknown,
): ReturnType<typeof projectSnapshotDtoSchema.parse> | null {
  const statusAllowed = mode === "replay_only" ? status === 200 : status === 201 || status === 200;
  if (!statusAllowed) return null;
  const parsed = projectSnapshotDtoSchema.safeParse(payload);
  if (!parsed.success || parsed.data.kind !== "manual" || parsed.data.immutable !== false ||
      parsed.data.message !== null) return null;
  return parsed.data;
}

function encodePath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

export function ProjectSnapshotsPanel({
  projectId,
  accountScope,
  dirty,
  baseUrl = `/api/v1/projects/${encodeURIComponent(projectId)}/snapshots`,
  readOnly = false,
  onAccessLost,
}: Readonly<{
  projectId: string;
  accountScope: string;
  dirty: boolean;
  baseUrl?: string;
  readOnly?: boolean;
  onAccessLost?: () => void;
}>) {
  const [items, setItems] = useState<SnapshotPage["items"]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingKey, setPendingKey] = useState<string | null>(null);
  const [pendingUnknown, setPendingUnknown] = useState(false);
  const [pendingUnrecoverable, setPendingUnrecoverable] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [manifest, setManifest] = useState<SnapshotManifest | null>(null);
  const [file, setFile] = useState<SnapshotFile | null>(null);
  const [busyFile, setBusyFile] = useState(false);
  const [createHint, setCreateHint] = useState<string | null>(null);
  const [activeResource, setActiveResource] = useState("");

  const resourceKey = `${accountScope}\u0000${projectId}\u0000${baseUrl}\u0000${readOnly}`;
  const storageKey = `app-planet.project-snapshots.v1.${accountScope}.${projectId}.pending`;
  const generation = useRef(0);
  const resourceRef = useRef(resourceKey);
  const accessLost = useRef(false);
  const itemsRef = useRef<SnapshotPage["items"]>([]);
  const cursorRef = useRef<string | null>(null);
  const listGeneration = useRef(0);
  const inFlightPages = useRef(new Set<string>());
  const selectedIdRef = useRef<string | null>(null);
  const selectedGeneration = useRef(0);
  const fileRequestGeneration = useRef(0);
  const manifestRef = useRef<SnapshotManifest | null>(null);
  const pendingKeyRef = useRef<string | null>(null);
  const createRequestGeneration = useRef(0);
  const createInFlight = useRef(false);

  const current = (resource: string, requestGeneration: number) =>
    resourceRef.current === resource && resource === resourceKey &&
    generation.current === requestGeneration && !accessLost.current;

  function updateItems(next: SnapshotPage["items"]) {
    itemsRef.current = next;
    setItems(next);
  }

  function hideProtectedContent(resource: string, requestGeneration: number) {
    if (!current(resource, requestGeneration)) return;
    accessLost.current = true;
    generation.current++;
    listGeneration.current++;
    selectedGeneration.current++;
    fileRequestGeneration.current++;
    createRequestGeneration.current++;
    createInFlight.current = false;
    selectedIdRef.current = null;
    manifestRef.current = null;
    cursorRef.current = null;
    updateItems([]);
    setCursor(null);
    setLoading(false);
    setSelectedId(null);
    setManifest(null);
    setFile(null);
    setBusyFile(false);
    onAccessLost?.();
  }

  async function loadPage(next: string | null, append: boolean): Promise<void> {
    const requestResource = resourceKey;
    const requestGeneration = generation.current;
    if (!current(requestResource, requestGeneration)) return;
    if (append && (next === null || next !== cursorRef.current)) return;
    const pageKey = append ? `${listGeneration.current}:${next}` : null;
    if (pageKey && inFlightPages.current.has(pageKey)) return;
    if (!append) {
      listGeneration.current++;
      cursorRef.current = null;
      setCursor(null);
    } else if (pageKey) inFlightPages.current.add(pageKey);
    const requestListGeneration = listGeneration.current;
    setLoading(true);
    setError(null);
    try {
      const query = new URLSearchParams({ limit: "20" });
      if (next) query.set("cursor", next);
      const response = await fetch(`${baseUrl}?${query}`, {
        method: "GET", credentials: "same-origin", cache: "no-store",
        signal: AbortSignal.timeout(15_000),
      });
      if (!current(requestResource, requestGeneration) ||
          requestListGeneration !== listGeneration.current) return;
      if ([401, 403, 404].includes(response.status)) {
        hideProtectedContent(requestResource, requestGeneration);
        setError("目前無法重新確認讀取權限；快照內容已隱藏。");
        return;
      }
      const payload = response.ok ? await response.json().catch(() => null) : null;
      if (!current(requestResource, requestGeneration) ||
          requestListGeneration !== listGeneration.current ||
          (append && cursorRef.current !== next)) return;
      const parsed = projectSnapshotListSchema.safeParse(payload);
      if (!parsed.success) {
        setError("無法確認快照清單；請稍後重新載入。");
        return;
      }
      const nextItems = append
        ? [...itemsRef.current, ...parsed.data.items.filter((item) =>
          !itemsRef.current.some((currentItem) => currentItem.id === item.id))]
        : parsed.data.items;
      updateItems(nextItems);
      cursorRef.current = parsed.data.next_cursor;
      setCursor(parsed.data.next_cursor);
    } catch {
      if (current(requestResource, requestGeneration) &&
          requestListGeneration === listGeneration.current) {
        setError("快照清單讀取失敗；請確認連線後重試。");
      }
    } finally {
      if (pageKey) inFlightPages.current.delete(pageKey);
      if (current(requestResource, requestGeneration) &&
          requestListGeneration === listGeneration.current) setLoading(false);
    }
  }

  useEffect(() => {
    generation.current++;
    const requestGeneration = generation.current;
    resourceRef.current = resourceKey;
    accessLost.current = false;
    listGeneration.current++;
    selectedGeneration.current++;
    fileRequestGeneration.current++;
    createRequestGeneration.current++;
    createInFlight.current = false;
    itemsRef.current = [];
    cursorRef.current = null;
    selectedIdRef.current = null;
    manifestRef.current = null;
    pendingKeyRef.current = null;
    setActiveResource(resourceKey);
    setItems([]);
    setCursor(null);
    setLoading(false);
    setError(null);
    setPendingKey(null);
    setPendingUnknown(false);
    setPendingUnrecoverable(false);
    setSelectedId(null);
    setManifest(null);
    setFile(null);
    setBusyFile(false);
    setCreateHint(null);
    if (!readOnly) {
      try {
        const saved = window.sessionStorage.getItem(storageKey);
        if (saved && isSnapshotOperationKey(saved)) {
          pendingKeyRef.current = saved;
          setPendingKey(saved);
          setPendingUnknown(true);
        } else if (saved !== null) {
          setError("快照重試識別資料格式錯誤；不會自動建立新操作。");
        }
      } catch {
        setError("無法讀取快照重試識別；結果未知時只能留在本頁使用原操作重試。");
      }
    }
    void loadPage(null, false);
    return () => {
      if (generation.current === requestGeneration) {
        generation.current++;
        listGeneration.current++;
        selectedGeneration.current++;
        fileRequestGeneration.current++;
        createRequestGeneration.current++;
      }
    };
  }, [resourceKey]);

  async function createSnapshot() {
    if (readOnly || dirty || createInFlight.current || activeResource !== resourceKey ||
        !current(resourceKey, generation.current)) return;
    createInFlight.current = true;
    const requestGeneration = generation.current;
    const requestResource = resourceKey;
    const requestId = ++createRequestGeneration.current;
    setCreateHint(null);

    let key = pendingKeyRef.current;
    let keyGeneratedForThisRequest = false;
    if (!key) {
      try {
        const saved = window.sessionStorage.getItem(storageKey);
        if (saved !== null) {
          if (!isSnapshotOperationKey(saved)) {
            setError("快照重試識別資料格式錯誤；不會覆寫或建立新操作。");
            createInFlight.current = false;
            return;
          }
          key = saved;
        } else {
          key = crypto.randomUUID();
          window.sessionStorage.setItem(storageKey, key);
          keyGeneratedForThisRequest = true;
        }
      } catch {
        setError("無法保存快照重試識別；本次未送出快照，請先恢復 sessionStorage。");
        createInFlight.current = false;
        return;
      }
      pendingKeyRef.current = key;
      setPendingKey(key);
    } else {
      try {
        const saved = window.sessionStorage.getItem(storageKey);
        if (saved !== null && saved !== key) {
          setError("快照重試識別已由其他頁面實例變更；本頁不會覆寫或送出另一個操作。");
          createInFlight.current = false;
          return;
        }
        if (saved === null) window.sessionStorage.setItem(storageKey, key);
      } catch {
        setError("無法確認快照重試識別；本次不會建立新的操作識別。");
        createInFlight.current = false;
        return;
      }
    }

    const mode = snapshotCreateMode({ keyGeneratedForThisRequest });
    if (mode === "replay_only") setPendingUnknown(true);
    const ownsCreate = () => current(requestResource, requestGeneration) &&
      createRequestGeneration.current === requestId && pendingKeyRef.current === key;
    try {
      const response = await fetch(baseUrl, {
        method: "POST", credentials: "same-origin", cache: "no-store",
        headers: {
          "content-type": "application/json",
          "idempotency-key": key,
          ...(mode === "replay_only" ? { "idempotency-replay-only": "true" } : {}),
        },
        body: JSON.stringify({ kind: "manual" }),
        signal: AbortSignal.timeout(20_000),
      });
      if (!ownsCreate()) return;
      let payload: unknown = null;
      try { payload = await response.json(); } catch { /* a missing receipt is an unknown outcome */ }
      if (!ownsCreate()) return;
      if (response.ok) {
        if (!trustedSnapshotCreateReceipt(mode, response.status, payload)) {
          setPendingUnknown(true);
          setError(mode === "replay_only" && response.status !== 200
            ? "原操作重放未取得正式重放收據；原操作識別已保留，結果仍未知，請以原操作重試。"
            : "快照成功回應缺少可信完整收據；原操作識別已保留，請以原操作重試。");
          return;
        }
        if (!clearPendingKey(key, requestResource, requestGeneration)) return;
        setPendingUnrecoverable(false);
        setError(null);
        await loadPage(null, false);
        return;
      }
      const problem = problemJsonSchema.safeParse(payload);
      if (!problem.success || problem.data.status !== response.status) {
        setPendingUnknown(true);
        setError("快照回應無法依正式 problem 格式確認；原操作識別已保留，請以原操作重試。");
        return;
      }
      const disposition = classifySnapshotProblem(response.status, problem.data.code);
      if (disposition === "unrecoverable") {
        setPendingUnknown(true);
        setPendingUnrecoverable(true);
        setError("原快照操作目前無法安全確認；操作識別已保留，系統不會建立新版本。請先人工核對並尋求協助。");
        return;
      }
      if (disposition === "storage_limit") {
        if (!clearPendingKey(key, requestResource, requestGeneration)) return;
        setPendingUnrecoverable(false);
        setError("工程容量防護值不足；已確認整筆未建立，沒有部分快照。");
        return;
      }
      if (disposition === "unknown") {
        setPendingUnknown(true);
        setError("快照結果未知；原操作識別已保留，請用原操作重試。");
        return;
      }
      if (!clearPendingKey(key, requestResource, requestGeneration)) return;
      setPendingUnrecoverable(false);
      if (problem.data.code === "idempotency_key_reuse") {
        setError("原操作識別與目前請求不一致；本次未建立快照。");
      } else {
        setError("快照建立遭拒；已保存檔案未變更，可檢查後再開始新操作。");
      }
    } catch {
      if (ownsCreate()) {
        setPendingUnknown(true);
        setError("快照結果未知；請以相同操作識別重試，不要建立新版本。");
      }
    } finally {
      if (createRequestGeneration.current === requestId) createInFlight.current = false;
    }
  }

  function clearPendingKey(key: string, resource: string, requestGeneration: number): boolean {
    if (!current(resource, requestGeneration) || pendingKeyRef.current !== key) return false;
    try {
      const saved = window.sessionStorage.getItem(storageKey);
      if (saved !== null && saved !== key) return false;
      if (saved === key) window.sessionStorage.removeItem(storageKey);
    } catch {
      setPendingUnknown(true);
      setError("伺服器已回覆，但無法清除本機重試識別；可安全地留在本頁以原操作確認。");
      return false;
    }
    pendingKeyRef.current = null;
    setPendingKey(null);
    setPendingUnknown(false);
    return true;
  }

  async function openManifest(snapshotId: string) {
    if (activeResource !== resourceKey || !current(resourceKey, generation.current)) return;
    const requestResource = resourceKey;
    const requestGeneration = generation.current;
    const selection = ++selectedGeneration.current;
    selectedIdRef.current = snapshotId;
    manifestRef.current = null;
    fileRequestGeneration.current++;
    setSelectedId(snapshotId);
    setManifest(null);
    setFile(null);
    setError(null);
    try {
      const response = await fetch(`${baseUrl}/${encodeURIComponent(snapshotId)}/manifest`, {
        method: "GET", credentials: "same-origin", cache: "no-store",
        signal: AbortSignal.timeout(15_000),
      });
      const ownsRead = () => current(requestResource, requestGeneration) &&
        selectedGeneration.current === selection && selectedIdRef.current === snapshotId;
      if (!ownsRead()) return;
      if ([401, 403, 404].includes(response.status)) {
        hideProtectedContent(requestResource, requestGeneration);
        setError("目前無法重新確認讀取權限；快照內容已隱藏。");
        return;
      }
      const payload = response.ok ? await response.json().catch(() => null) : null;
      if (!ownsRead()) return;
      const parsed = projectSnapshotManifestSchema.safeParse(payload);
      if (!parsed.success || parsed.data.snapshot.id !== snapshotId) {
        setError("無法確認快照 manifest；內容未顯示，請稍後重試。");
        return;
      }
      manifestRef.current = parsed.data;
      setManifest(parsed.data);
      setError(null);
    } catch {
      if (current(requestResource, requestGeneration) &&
          selectedGeneration.current === selection && selectedIdRef.current === snapshotId) {
        setError("快照 manifest 讀取失敗；內容未顯示。");
      }
    }
  }

  async function openSnapshotFile(path: string) {
    const snapshotId = selectedIdRef.current;
    const selectedManifest = manifestRef.current;
    if (!snapshotId || !selectedManifest ||
        !projectFilePathSchema.safeParse(path).success ||
        !current(resourceKey, generation.current)) return;
    const manifestEntry = selectedManifest.files.find((entry) => entry.path === path);
    if (!manifestEntry) return;
    const requestResource = resourceKey;
    const requestGeneration = generation.current;
    const selection = selectedGeneration.current;
    const fileRequest = ++fileRequestGeneration.current;
    const ownsRead = () => current(requestResource, requestGeneration) &&
      selectedGeneration.current === selection && selectedIdRef.current === snapshotId &&
      fileRequestGeneration.current === fileRequest;
    setBusyFile(true);
    setFile(null);
    try {
      const response = await fetch(`${baseUrl}/${encodeURIComponent(snapshotId)}/files/${encodePath(path)}`, {
        method: "GET", credentials: "same-origin", cache: "no-store",
        signal: AbortSignal.timeout(15_000),
      });
      if (!ownsRead()) return;
      if ([401, 403, 404].includes(response.status)) {
        hideProtectedContent(requestResource, requestGeneration);
        setError("目前無法重新確認讀取權限；快照內容已隱藏。");
        return;
      }
      const payload = response.ok ? await response.json().catch(() => null) : null;
      if (!ownsRead()) return;
      const parsed = projectSnapshotFileSchema.safeParse(payload);
      if (!parsed.success || parsed.data.path !== path ||
          parsed.data.hash !== manifestEntry.hash || parsed.data.bytes !== manifestEntry.bytes) {
        setFile(null);
        setError("快照檔案與所選 manifest 不一致；內容未顯示。");
        return;
      }
      setFile(parsed.data);
      setError(null);
    } catch {
      if (ownsRead()) setError("快照檔案讀取失敗；內容未顯示。");
    } finally {
      if (ownsRead()) setBusyFile(false);
    }
  }

  const resourceMatches = activeResource === resourceKey;
  const visibleItems = resourceMatches ? items : [];
  const visibleCursor = resourceMatches ? cursor : null;
  const visibleManifest = resourceMatches ? manifest : null;
  const visibleFile = resourceMatches ? file : null;
  const visibleError = resourceMatches ? error : null;
  return <section className="grid gap-3 border-t border-slate-300 pt-4" aria-label="手動快照">
    <h3>手動快照</h3>
    {!readOnly && <div>
      <button type="button" className="min-h-11 self-end rounded-lg bg-blue-700 px-4 font-bold text-white disabled:bg-slate-400"
        disabled={!resourceMatches || accessLost.current || loading || dirty || pendingUnrecoverable}
        onClick={() => void createSnapshot()}>
        {pendingUnrecoverable ? "原快照操作受控停止"
          : pendingUnknown ? "以原操作重試快照" : "建立 manual 快照"}
      </button>
    </div>}
    {dirty && !readOnly && <p role="status">有未保存內容；先保存，再建立快照。未保存文字不會混入快照。</p>}
    {createHint && <p role="status">{createHint}</p>}
    {visibleError && <p role="alert">{visibleError}</p>}
    {resourceMatches && loading && <p role="status">正在讀取快照…</p>}
    {resourceMatches && !loading && visibleItems.length === 0 && <p>尚無 manual 快照。</p>}
    <ol className="grid gap-2">
      {visibleItems.map((snapshot) => <li key={snapshot.id} className="rounded border p-3">
        <button type="button" className="text-left font-bold underline"
          onClick={() => void openManifest(snapshot.id)}>
          版本 {snapshot.version_no}（{snapshot.kind}）— {snapshot.created_at}
        </button>
        <p>識別碼：<code>{snapshot.id}</code></p>
        <p>manifest SHA-256：<code>{snapshot.content_hash}</code>；immutable：{snapshot.immutable ? "是" : "否"}</p>
        {snapshot.message && <p>備註：{snapshot.message}</p>}
        <p>變更：新增 {snapshot.changes.added.length}、修改 {snapshot.changes.changed.length}、移除 {snapshot.changes.removed.length}</p>
        {snapshot.changes.added.length > 0 && <p>新增：{snapshot.changes.added.join("、")}</p>}
        {snapshot.changes.changed.length > 0 && <p>修改：{snapshot.changes.changed.join("、")}</p>}
        {snapshot.changes.removed.length > 0 && <p>移除：{snapshot.changes.removed.join("、")}</p>}
      </li>)}
    </ol>
    {visibleCursor && <button type="button" className="min-h-11 justify-self-start rounded-lg border px-4"
      disabled={!resourceMatches || loading} onClick={() => void loadPage(visibleCursor, true)}>
      載入更多版本</button>}
    {visibleManifest && <section className="grid gap-2 rounded border p-3" aria-label="快照 manifest">
      <h4>版本 {visibleManifest.snapshot.version_no} manifest（唯讀）</h4>
      <p>檔案數：{visibleManifest.files.length}</p>
      <ul>{visibleManifest.files.map((entry) => <li key={entry.path}>
        <button type="button" className="underline" onClick={() => void openSnapshotFile(entry.path)}>
          {entry.path} — {entry.bytes} bytes — {entry.hash}
        </button>
      </li>)}</ul>
      {resourceMatches && busyFile && <p role="status">正在讀取快照檔案…</p>}
      {visibleFile && <div>
        <h5>{visibleFile.path}（版本唯讀，{visibleFile.bytes} UTF-8 bytes；SHA-256 {visibleFile.hash}）</h5>
        <pre className="max-h-96 overflow-auto whitespace-pre-wrap rounded bg-slate-50 p-3">{visibleFile.content}</pre>
      </div>}
    </section>}
    <p>快照只保存 DB 已保存內容；不提供更新、刪除、還原或預覽。</p>
  </section>;
}
