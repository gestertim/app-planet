"use client";

import { useEffect, useState } from "react";
import {
  projectSnapshotFileSchema,
  projectSnapshotListSchema,
  projectSnapshotManifestSchema,
  projectFilePathSchema,
} from "@app-planet/core";
import { productFetch as fetch } from "../auth/product-fetch.ts";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
  const [items, setItems] = useState<ReturnType<typeof projectSnapshotListSchema.parse>["items"]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingKey, setPendingKey] = useState<string | null>(null);
  const [pendingUnknown, setPendingUnknown] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [manifest, setManifest] = useState<ReturnType<typeof projectSnapshotManifestSchema.parse> | null>(null);
  const [file, setFile] = useState<ReturnType<typeof projectSnapshotFileSchema.parse> | null>(null);
  const [busyFile, setBusyFile] = useState(false);
  const [createHint, setCreateHint] = useState<string | null>(null);
  const storageKey = `app-planet.project-snapshots.v1.${accountScope}.${projectId}.pending`;

  function hideProtectedContent() {
    setItems([]);
    setCursor(null);
    setSelectedId(null);
    setManifest(null);
    setFile(null);
    onAccessLost?.();
  }

  useEffect(() => {
    if (readOnly) return;
    try {
      const saved = window.sessionStorage.getItem(storageKey);
      if (saved && uuid.test(saved)) {
        setPendingKey(saved);
        setPendingUnknown(true);
      }
    } catch {
      setError("無法讀取快照重試識別；本機不會記錄快照內容，結果未知時只能留在本頁重試。");
    }
  }, [readOnly, storageKey]);

  async function loadPage(next: string | null, append: boolean) {
    setLoading(true);
    setError(null);
    try {
      const query = new URLSearchParams({ limit: "20" });
      if (next) query.set("cursor", next);
      const response = await fetch(`${baseUrl}?${query}`, {
        method: "GET", credentials: "same-origin", cache: "no-store",
        signal: AbortSignal.timeout(15_000),
      });
      if (response.status === 401 || response.status === 403 || response.status === 404) {
        hideProtectedContent();
        setError("目前無法重新確認讀取權限；快照內容已隱藏。");
        return;
      }
      const parsed = response.ok
        ? projectSnapshotListSchema.safeParse(await response.json().catch(() => null))
        : null;
      if (!parsed?.success) {
        setError("無法確認快照清單；請稍後重新載入。");
        return;
      }
      setItems((current) => append ? [...current, ...parsed.data.items] : parsed.data.items);
      setCursor(parsed.data.next_cursor);
    } catch {
      setError("快照清單讀取失敗；請確認連線後重試。");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void loadPage(null, false); }, [baseUrl]);

  async function createSnapshot() {
    if (readOnly) return;
    if (dirty) {
      setCreateHint("目前有未保存內容；請先保存檔案，快照只會包含 server 已保存的完整檔案集。");
      return;
    }
    setCreateHint(null);
    const key = pendingKey ?? crypto.randomUUID();
    if (!pendingKey) {
      setPendingKey(key);
      try { window.sessionStorage.setItem(storageKey, key); }
      catch { setError("無法保存快照重試識別；本次仍會送出，但請勿重複建立新操作。"); }
    }
    try {
      const response = await fetch(baseUrl, {
        method: "POST", credentials: "same-origin", cache: "no-store",
        headers: {
          "content-type": "application/json",
          "idempotency-key": key,
          ...(pendingUnknown ? { "idempotency-replay-only": "true" } : {}),
        },
        body: JSON.stringify({ kind: "manual" }),
        signal: AbortSignal.timeout(20_000),
      });
      const payload = await response.json().catch(() => null);
      if (response.ok && payload && typeof payload === "object" && "id" in payload) {
        setPendingKey(null);
        setPendingUnknown(false);
        try { window.sessionStorage.removeItem(storageKey); } catch { /* only this feature key is removed */ }
        setError(null);
        await loadPage(null, false);
        return;
      }
      if (response.status >= 500) {
        setPendingUnknown(true);
        setError("快照結果未知；沒有建立新識別，請使用原操作重試。");
        return;
      }
      const code = payload && typeof payload === "object" && "code" in payload ? payload.code : null;
      if (code === "storage_limit") setError("工程容量防護值不足；整筆未建立，沒有部分快照。");
      else if (code === "idempotency_key_reuse") setError("原操作識別與目前請求不一致；快照未建立。");
      else setError("快照建立失敗；已保存檔案未變更。");
      setPendingKey(null);
      setPendingUnknown(false);
      try { window.sessionStorage.removeItem(storageKey); } catch { /* only this feature key is removed */ }
    } catch {
      setPendingUnknown(true);
      setError("快照結果未知；請以相同操作識別重試，不要建立新版本。");
    }
  }

  async function openManifest(snapshotId: string) {
    setSelectedId(snapshotId);
    setManifest(null);
    setFile(null);
    try {
      const response = await fetch(`${baseUrl}/${encodeURIComponent(snapshotId)}/manifest`, {
        method: "GET", credentials: "same-origin", cache: "no-store",
        signal: AbortSignal.timeout(15_000),
      });
      const parsed = response.ok
        ? projectSnapshotManifestSchema.safeParse(await response.json().catch(() => null))
        : null;
      if (!parsed?.success) {
        if ([401, 403, 404].includes(response.status)) {
          hideProtectedContent();
          setError("目前無法重新確認讀取權限；快照內容已隱藏。");
        } else setError("無法確認快照 manifest；內容未顯示，請稍後重試。");
        return;
      }
      setManifest(parsed.data);
      setError(null);
    } catch {
      setError("快照 manifest 讀取失敗；內容未顯示。");
    }
  }

  async function openSnapshotFile(path: string) {
    if (!selectedId || !projectFilePathSchema.safeParse(path).success) return;
    setBusyFile(true);
    setFile(null);
    try {
      const response = await fetch(`${baseUrl}/${encodeURIComponent(selectedId)}/files/${encodePath(path)}`, {
        method: "GET", credentials: "same-origin", cache: "no-store",
        signal: AbortSignal.timeout(15_000),
      });
      const parsed = response.ok
        ? projectSnapshotFileSchema.safeParse(await response.json().catch(() => null))
        : null;
      if (!parsed?.success) {
        setFile(null);
        if ([401, 403, 404].includes(response.status)) {
          hideProtectedContent();
          setError("目前無法重新確認讀取權限；快照內容已隱藏。");
        } else setError("無法確認快照檔案；內容未顯示，請稍後重試。");
        return;
      }
      setFile(parsed.data);
      setError(null);
    } catch {
      setError("快照檔案讀取失敗；內容未顯示。");
    } finally {
      setBusyFile(false);
    }
  }

  return <section className="grid gap-3 border-t border-slate-300 pt-4" aria-label="手動快照">
    <h3>手動快照</h3>
    {!readOnly && <div>
      <button type="button" className="min-h-11 self-end rounded-lg bg-blue-700 px-4 font-bold text-white disabled:bg-slate-400"
        disabled={loading || dirty} onClick={() => void createSnapshot()}>
        {pendingUnknown ? "以原操作重試快照" : "建立 manual 快照"}
      </button>
    </div>}
    {dirty && !readOnly && <p role="status">有未保存內容；先保存，再建立快照。未保存文字不會混入快照。</p>}
    {createHint && <p role="status">{createHint}</p>}
    {error && <p role="alert">{error}</p>}
    {loading && <p role="status">正在讀取快照…</p>}
    {!loading && items.length === 0 && <p>尚無 manual 快照。</p>}
    <ol className="grid gap-2">
      {items.map((snapshot) => <li key={snapshot.id} className="rounded border p-3">
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
    {cursor && <button type="button" className="min-h-11 justify-self-start rounded-lg border px-4"
      disabled={loading} onClick={() => void loadPage(cursor, true)}>載入更多版本</button>}
    {manifest && <section className="grid gap-2 rounded border p-3" aria-label="快照 manifest">
      <h4>版本 {manifest.snapshot.version_no} manifest（唯讀）</h4>
      <p>檔案數：{manifest.files.length}</p>
      <ul>{manifest.files.map((entry) => <li key={entry.path}>
        <button type="button" className="underline" onClick={() => void openSnapshotFile(entry.path)}>
          {entry.path} — {entry.bytes} bytes — {entry.hash}
        </button>
      </li>)}</ul>
      {busyFile && <p role="status">正在讀取快照檔案…</p>}
      {file && <div>
        <h5>{file.path}（版本唯讀，{file.bytes} UTF-8 bytes；SHA-256 {file.hash}）</h5>
        <pre className="max-h-96 overflow-auto whitespace-pre-wrap rounded bg-slate-50 p-3">{file.content}</pre>
      </div>}
    </section>}
    <p>快照只保存 DB 已保存內容；不提供更新、刪除、還原或預覽。</p>
  </section>;
}
