"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { ProjectRenameCurrent } from "@app-planet/core";
import { productFetch } from "../auth/product-fetch.ts";
import { RenameController, createRenameTransport } from "./rename-controller.ts";
import { useProjectAccessLost } from "./protected-project-view.tsx";
import { UnsavedChangesGuard, type GuardCondition, type GuardResult } from "./unsaved-changes-guard.tsx";

export function ProjectRename({ initial, accountScope }: Readonly<{
  initial: ProjectRenameCurrent; accountScope: string;
}>) {
  const [controller] = useState(() => new RenameController(initial, createRenameTransport(initial.id, productFetch), {
    getItem: (key) => sessionStorage.getItem(key),
    setItem: (key, value) => sessionStorage.setItem(key, value),
    removeItem: (key) => sessionStorage.removeItem(key),
  }, `app-planet.rename.${accountScope}.${initial.id}`));
  const [state, setState] = useState(controller.getState);
  const [ready, setReady] = useState(false);
  const [open, setOpen] = useState(false);
  const composing = useRef(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const notice = useRef<HTMLParagraphElement>(null);
  const closeAccess = useProjectAccessLost();
  const router = useRouter();
  useEffect(() => {
    const unsubscribe = controller.subscribe(() => setState(controller.getState()));
    controller.attach();
    setReady(true);
    if (controller.getState().intent) setOpen(true);
    return () => { unsubscribe(); controller.detach(); };
  }, [controller]);
  useEffect(() => {
    if (state.status === "closed") closeAccess();
    if (["conflict", "unknown", "rejected"].includes(state.status)) notice.current?.focus();
    if (state.status === "success") router.refresh();
  }, [state.status, state.current.row_version, closeAccess, router]);
  useEffect(() => { if (open) input.current?.focus(); }, [open]);
  const busy = state.status === "saving";
  const condition: GuardCondition = busy ? "saving" : state.intent ? "unknown" :
    state.status === "conflict" ? "conflict" : controller.dirty ? "dirty" : "clean";
  const leave = async (retry: boolean): Promise<GuardResult> => {
    const success = retry ? await controller.retry() : await controller.save();
    return success && !controller.dirty ? { outcome: "switched" } : { outcome: "blocked", reason: "save_failed" };
  };
  const cancel = () => {
    if (!controller.cancel()) return;
    setOpen(false);
    trigger.current?.focus();
  };
  return <section aria-label="專案重新命名" className="card grid gap-3">
    <UnsavedChangesGuard identity={{ accountScope, projectId: initial.id, resourceId: "project-title" }}
      condition={condition} composingRef={composing} actions={{
        saveThenLeave: () => leave(false), retryThenLeave: () => leave(true),
        discardAndLeave: async () => controller.cancel() ? { outcome: "switched" } : { outcome: "blocked", reason: "saving" },
      }} />
    <button type="button" ref={trigger} disabled={!ready || busy} aria-expanded={open}
      onClick={() => setOpen(true)}>重新命名</button>
    {open && <div className="grid gap-3" onKeyDown={(event) => {
      if (event.key === "Escape" && !event.nativeEvent.isComposing && !composing.current) {
        event.preventDefault();
        cancel();
      }
    }}>
      <p data-testid="rename-current">資料庫目前名稱：{state.current.title}（版本 {state.current.row_version}）</p>
      <label>新專案名稱
        <input ref={input} className="w-full rounded border p-2" value={state.editor}
          disabled={busy || Boolean(state.intent)} onChange={(event) => controller.edit(event.target.value)}
          onCompositionStart={() => { composing.current = true; }}
          onCompositionEnd={() => { composing.current = false; }}
          onBlur={() => { composing.current = false; }} />
      </label>
      <p role="status">{controller.dirty ? "名稱尚未保存。" : "名稱與上次可信讀取一致。"}</p>
      <p ref={notice} tabIndex={-1} role={["unknown", "conflict", "rejected", "closed"].includes(state.status) ? "alert" : "status"}
        data-testid="rename-status">{state.message}</p>
      {state.conflict && <div data-testid="rename-conflict">
        <p>你的名稱：{state.editor}（提交版本 {state.conflict.submitted.version}）</p>
        <p>目前 DB 名稱：{state.conflict.current.content.title}（版本 {state.conflict.current.version}）</p>
        <p>不會自動覆蓋。再次保存會以剛才讀到的版本提出新操作；若版本又變動，仍會拒絕。</p>
      </div>}
      {state.intent && <p>原操作名稱：{state.intent.body.title}；原版本 {state.intent.version}。不會換鍵或改名重試。</p>}
      <div className="flex flex-wrap gap-3">
        <button type="button" disabled={!ready || busy || Boolean(state.intent) || !controller.dirty}
          onClick={() => { if (!composing.current) void controller.save(); }}>{state.status === "conflict" ? "明確再次保存我的名稱" : "保存名稱"}</button>
        <button type="button" disabled={busy} onClick={cancel}>取消重新命名</button>
        <button type="button" disabled={busy || state.reading || Boolean(state.intent)}
          onClick={() => { void controller.refresh(true); }}>重新讀取並採用 DB 名稱</button>
        {state.intent && <button type="button" disabled={busy}
          onClick={() => { void controller.retry(); }}>以原操作重試改名</button>}
      </div>
      {state.reading && <p role="status">正在讀取目前名稱；等待期間的新輸入仍保留。</p>}
    </div>}
  </section>;
}
