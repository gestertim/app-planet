"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useRef, useState } from "react";
import { productFetch as fetch } from "../auth/product-fetch.ts";
import { useProjectAccessLost } from "./protected-project-view.tsx";
import {
  classifyGuardCondition,
  UnsavedChangesGuard,
} from "./unsaved-changes-guard.tsx";
import {
  ProjectFileController,
  type ProjectFileWriteIntent,
  type SessionStore,
} from "./project-file-controller.ts";
import { ProjectSnapshotsPanel } from "./project-snapshots-panel.tsx";

const MonacoEditor = dynamic(() => import("./project-monaco-editor.tsx"), { ssr: false });

const serverSessionStore: SessionStore = {
  get length() { return 0; },
  key: () => null,
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {},
};

function storageOrNull(): SessionStore | null {
  try { return typeof window === "undefined" ? serverSessionStore : window.sessionStorage; }
  catch { return null; }
}

function fileUrl(projectId: string, path: string): string {
  const encoded = path.split("/").map(encodeURIComponent).join("/");
  return `/api/v1/projects/${encodeURIComponent(projectId)}/files/${encoded}`;
}

function browserHashPath(): string | null {
  if (typeof window === "undefined" || !window.location.hash.startsWith("#file=")) return null;
  try { return decodeURIComponent(window.location.hash.slice(6)); } catch { return null; }
}

function languageFor(path: string | null): "html" | "css" | "javascript" {
  if (path?.endsWith(".css")) return "css";
  if (path?.endsWith(".js")) return "javascript";
  return "html";
}

export function ProjectFileWorkspace({
  projectId,
  accountScope,
}: Readonly<{ projectId: string; accountScope: string }>) {
  const accessLost = useProjectAccessLost();
  const transport = useCallback(() => ({
    async list() {
      return fetch(`/api/v1/projects/${encodeURIComponent(projectId)}/files`, {
        method: "GET", credentials: "same-origin", cache: "no-store",
        signal: AbortSignal.timeout(15_000),
      });
    },
    async read(path: string) {
      return fetch(fileUrl(projectId, path), {
        method: "GET", credentials: "same-origin", cache: "no-store",
        signal: AbortSignal.timeout(15_000),
      });
    },
    async write(path: string, intent: ProjectFileWriteIntent,
      replayOnly: boolean) {
      return fetch(fileUrl(projectId, path), {
        method: "PUT", credentials: "same-origin", cache: "no-store",
        headers: {
          "content-type": "application/json",
          "idempotency-key": intent.key,
          ...(intent.ifMatch ? { "if-match": `"${intent.ifMatch}"` } : { "if-none-match": "*" }),
          ...(replayOnly ? { "idempotency-replay-only": "true" } : {}),
        },
        body: JSON.stringify({ content: intent.content }),
        signal: AbortSignal.timeout(20_000),
      });
    },
  }), [projectId]);
  const [controller] = useState(() => new ProjectFileController(
    projectId, accountScope, transport(), storageOrNull(), accessLost,
  ));
  const [state, setState] = useState(() => controller.getState());
  const [newPath, setNewPath] = useState("");
  const [composing, setComposing] = useState(false);
  const composingRef = useRef(false);
  const pendingNewPath = useRef<string | null>(null);

  useEffect(() => controller.subscribe(() => setState(controller.getState())), [controller]);
  useEffect(() => {
    void controller.initialize(browserHashPath());
    const selectHash = (href?: string) => {
      let path = browserHashPath();
      if (href) {
        try {
          const target = new URL(href, window.location.href);
          if (target.hash.startsWith("#file=")) path = decodeURIComponent(target.hash.slice(6));
        } catch { path = null; }
      }
      if (!path) return;
      if (pendingNewPath.current === path) {
        pendingNewPath.current = null;
        controller.createDraft(path);
      } else void controller.open(path);
    };
    const onHashChange = () => selectHash();
    window.addEventListener("hashchange", onHashChange);
    const onGuardedNavigation = (event: Event) => {
      const detail = (event as CustomEvent<unknown>).detail;
      if (typeof detail === "string") selectHash(detail);
    };
    window.addEventListener("app-planet:guarded-navigation", onGuardedNavigation);
    return () => {
      window.removeEventListener("hashchange", onHashChange);
      window.removeEventListener("app-planet:guarded-navigation", onGuardedNavigation);
      controller.dispose();
    };
  }, [controller]);

  const openNewFile = (event: React.MouseEvent<HTMLAnchorElement>) => {
    if (!newPath.trim()) {
      event.preventDefault();
      return;
    }
    pendingNewPath.current = newPath.trim();
  };
  const hrefFor = (path: string) => `#file=${encodeURIComponent(path)}`;
  const condition = state.status === "saving" ? "saving"
    : state.status === "unknown" || state.status === "unrecoverable" ? "unknown"
      : state.status === "conflict" ? "conflict" : state.dirty ? "dirty" : "clean";

  return <section className="card grid gap-4" aria-label="App 原始碼工作區" data-testid="project-file-workspace">
    <h2>建立 App</h2>
    <p>檔案只以文字編輯；不會執行原始碼或提供預覽。預覽版本：尚未提供。</p>
    <UnsavedChangesGuard
      identity={{ accountScope, projectId, resourceId: `project-file:${state.active_path ?? "none"}` }}
      condition={condition}
      actions={{
        saveThenLeave: () => controller.save(),
        retryThenLeave: () => controller.retryThenLeave(),
        discardAndLeave: () => controller.discardAndLeave(),
      }}
      composingRef={composingRef}
    />
    {state.storage_warning && <p role="status" className="rounded-lg bg-amber-50 p-3 text-amber-950">
      {state.storage_warning}
    </p>}
    {state.error && <p role="alert">{state.error}</p>}
    <div className="grid gap-4 lg:grid-cols-[minmax(12rem,0.8fr)_minmax(0,2fr)]">
      <aside className="grid content-start gap-3" aria-label="專案檔案">
        <h3>檔案</h3>
        {state.status === "loading" && <p role="status">正在讀取檔案…</p>}
        {state.files.length === 0 && state.status !== "loading" && <p>目前沒有檔案。新增 HTML、CSS 或 JavaScript 檔案開始創作。</p>}
        <ul className="grid gap-1">
          {state.files.map((file) => <li key={file.path}>
            <a href={hrefFor(file.path)} aria-current={state.active_path === file.path ? "page" : undefined}
              className="block rounded px-2 py-2 underline" data-testid={`project-file-${file.path}`}>
              {file.path}{file.local_only ? "（本機草稿，尚未保存）" : ""}
            </a>
          </li>)}
        </ul>
        <label className="grid gap-1" htmlFor="new-project-file">新增檔案名稱</label>
        <input id="new-project-file" value={newPath} onChange={(event) => {
          const value = event.target.value.trim();
          setNewPath(event.target.value);
          pendingNewPath.current = value || null;
        }}
          placeholder="index.html" autoComplete="off" />
        <a className="button" href={newPath.trim() ? hrefFor(newPath.trim()) : "#"}
          onClick={openNewFile}>新增檔案</a>
      </aside>
      <div className="grid content-start gap-3">
        {state.active_path ? <>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3>{state.active_path}</h3>
            <button type="button" className="button" disabled={state.status === "saving" ||
              state.status === "unrecoverable" || composing ||
              (!state.dirty && Boolean(state.saved_file))}
              onClick={() => void controller.save()}>
              {state.status === "unrecoverable" ? "原操作受控停止"
                : state.status === "unknown" ? "使用原操作重試" : "保存到資料庫"}
            </button>
          </div>
          <p>
            {state.saved_file
              ? `DB 已保存版本：SHA-256 ${state.saved_file.hash}（${state.saved_file.bytes} UTF-8 bytes）`
              : "DB 狀態：尚未建立；保存時會以 If-None-Match: * 防止覆蓋。"}
            {state.dirty ? "；目前有未保存草稿。" : "；目前內容與已保存版本一致。"}
          </p>
          {state.server_conflict && <section className="grid gap-2 rounded border border-amber-600 p-3"
            aria-label="版本衝突比對">
            <h4>伺服器版本與本機草稿不同</h4>
            <p>本機內容仍保留。請比較兩邊後明確選擇；不會自動覆蓋。</p>
            <details>
              <summary>查看最新伺服器原文（純文字）</summary>
              <pre className="max-h-64 overflow-auto whitespace-pre-wrap">{state.server_conflict.content}</pre>
            </details>
            <div className="flex flex-wrap gap-2">
              <button type="button" className="button" onClick={() => void controller.adoptServerVersion()}>
                採用伺服器版本並放棄本機草稿
              </button>
              <button type="button" className="button" onClick={() => void controller.continueFromServerVersion()}>
                保留本機文字，以伺服器版本作為 CAS 基準
              </button>
            </div>
          </section>}
          <div onCompositionStartCapture={() => { composingRef.current = true; setComposing(true); }}
            onCompositionEndCapture={() => { composingRef.current = false; setComposing(false); }}
            onKeyDownCapture={(event) => {
              if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s" &&
                  !composingRef.current && !event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229) {
                event.preventDefault();
                void controller.save();
              }
            }}>
            <MonacoEditor
              height="420px"
              language={languageFor(state.active_path)}
              value={state.content}
              onChange={(value) => controller.edit(value ?? "")}
              options={{
                automaticLayout: true,
                minimap: { enabled: false },
                wordWrap: "on",
                scrollBeyondLastLine: false,
                readOnly: state.status === "denied",
                ariaLabel: `${state.active_path} 原始碼文字編輯器`,
              }}
            />
          </div>
          {composing && <p role="status">中文輸入法組字尚未完成；此時不會保存或切換檔案。</p>}
        </> : <p>選擇既有檔案，或先新增一個檔案。</p>}
      </div>
    </div>
    <ProjectSnapshotsPanel projectId={projectId} accountScope={accountScope}
      dirty={state.dirty || state.status === "saving" || state.status === "unknown" || state.status === "conflict"}
      onAccessLost={accessLost} />
  </section>;
}
