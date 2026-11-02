"use client";

import * as Dialog from "@radix-ui/react-dialog";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, type MutableRefObject } from "react";
import type { StageDraftEditorState } from "./save-controller.ts";

export type GuardCondition = "clean" | "dirty" | "saving" | "unknown" | "conflict";
export type GuardChoice = "save_then_switch" | "discard_and_switch";
export type GuardResult =
  | Readonly<{ outcome: "switched" | "kept" }>
  | Readonly<{ outcome: "blocked"; reason: "saving" | "retry_required" | "conflict" | "save_failed" | "still_dirty" }>;

export function classifyGuardCondition(state: StageDraftEditorState): GuardCondition {
  const operation = state.operation;
  if (operation.status === "conflict" ||
      (operation.status === "failed" && operation.reason === "draft_already_exists")) return "conflict";
  if (operation.status === "saving") return "saving";
  if (operation.status === "failed" && operation.retryable) return "unknown";
  return state.dirty ? "dirty" : "clean";
}

export type GuardActions = Readonly<{
  saveThenLeave: () => Promise<GuardResult>;
  retryThenLeave: () => Promise<GuardResult>;
  discardAndLeave: () => Promise<GuardResult>;
}>;

type Intent =
  | Readonly<{ kind: "link"; href: string }>
  | Readonly<{ kind: "history"; href: string; key: string }>;

type RegisteredGuard = Readonly<{
  identityKey: string;
  isGuarded: () => boolean;
}>;

const registeredGuards = new Map<object, RegisteredGuard>();

function otherGuardedResourceCount(current: object): number {
  const identities = new Set<string>();
  for (const [id, guard] of registeredGuards) {
    if (id !== current && guard.isGuarded()) identities.add(guard.identityKey);
  }
  return identities.size;
}

const messages = {
  saving: "保存仍在進行，尚未取得伺服器結果；為避免遺失內容，結果出來前不會離開。",
  conflict: "版本衝突：本地內容仍保留，尚未採用伺服器版本。請先留在頁面比對，或明確放棄本地修改。",
  save_failed: "保存沒有取得可信的成功回應，內容仍保留在本頁。",
  still_dirty: "目前內容尚未有可確認的保存結果；請留在本頁完成明確操作，或放棄本地修改。",
  retry_required: "上一次保存結果未知（可能已寫入伺服器）；請使用原操作恢復，或明確放棄本地修改。放棄不會撤回可能已提交的寫入。",
} as const;

export function UnsavedChangesGuard({
  identity,
  condition,
  actions,
  composingRef,
}: Readonly<{
  identity: Readonly<{ accountScope: string; projectId: string; resourceId: string }>;
  condition: GuardCondition;
  actions: GuardActions;
  composingRef: MutableRefObject<boolean>;
}>) {
  const router = useRouter();
  const identityKey = `${identity.accountScope}\u0000${identity.projectId}\u0000${identity.resourceId}`;
  const guarded = condition !== "clean";
  const [intent, setIntent] = useState<Intent | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [historyProtection, setHistoryProtection] = useState<"available" | "limited">("limited");
  const intentRef = useRef<Intent | null>(null);
  const guardedRef = useRef(guarded);
  const actionsRef = useRef(actions);
  const registration = useRef<object>({});
  const leaving = useRef(false);
  const attempt = useRef(0);
  const opener = useRef<HTMLElement | null>(null);
  const bypass = useRef(false);
  intentRef.current = intent;
  guardedRef.current = guarded;
  actionsRef.current = actions;

  useEffect(() => {
    const registrationId = registration.current;
    registeredGuards.set(registrationId, {
      identityKey,
      isGuarded: () => guardedRef.current,
    });
    const navigation = window.navigation;
    const navigationSupported = Boolean(navigation && typeof navigation.traverseTo === "function");
    setHistoryProtection(navigationSupported ? "available" : "limited");
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!guardedRef.current || leaving.current) return;
      event.preventDefault();
      event.returnValue = "";
    };
    const onClick = (event: MouseEvent) => {
      if (!guardedRef.current || leaving.current || event.defaultPrevented || event.button !== 0 ||
          event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const anchor = event.target instanceof Element ? event.target.closest("a[href]") : null;
      if (!(anchor instanceof HTMLAnchorElement)) return;
      if ((anchor.target && anchor.target !== "_self") || anchor.hasAttribute("download")) return;
      const url = new URL(anchor.href, window.location.href);
      if (url.origin !== window.location.origin || url.href === window.location.href) return;
      event.preventDefault();
      event.stopPropagation();
      if (composingRef.current || intentRef.current) {
        setNotice("輸入法組字尚未完成；內容仍留在本頁，請完成組字後再操作。");
        return;
      }
      setNotice(null);
      opener.current = anchor;
      setIntent({ kind: "link", href: `${url.pathname}${url.search}${url.hash}` });
    };
    const onNavigate = (event: NavigateEvent) => {
      if (bypass.current) {
        bypass.current = false;
        return;
      }
      if (event.navigationType !== "traverse" || !guardedRef.current || leaving.current ||
          !event.canIntercept || !event.cancelable) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (composingRef.current || intentRef.current) {
        setNotice("輸入法組字尚未完成；返回／前進已取消，請完成組字後再操作。");
        return;
      }
      setNotice(null);
      opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      setIntent({
        kind: "history",
        href: event.destination.url,
        key: event.destination.key,
      });
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    document.addEventListener("click", onClick, true);
    if (navigationSupported) navigation.addEventListener("navigate", onNavigate, true);
    return () => {
      window.removeEventListener("beforeunload", onBeforeUnload);
      document.removeEventListener("click", onClick, true);
      if (navigationSupported) navigation.removeEventListener("navigate", onNavigate, true);
      registeredGuards.delete(registrationId);
    };
  }, [composingRef, identityKey]);

  useEffect(() => {
    attempt.current++;
    setIntent(null);
    setNotice(null);
    setBusy(false);
    leaving.current = false;
    bypass.current = false;
  }, [identityKey]);

  const perform = (current: Intent) => {
    const otherGuardCount = otherGuardedResourceCount(registration.current);
    if (otherGuardCount > 0) {
      leaving.current = false;
      bypass.current = false;
      setIntent(null);
      setBusy(false);
      setNotice(`目前項目已依你的選擇處理；本頁另有 ${otherGuardCount} 個帳號／專案／資源待處理，請逐項保存、恢復或明確放棄後再切換。`);
      return;
    }
    leaving.current = true;
    if (current.kind === "link") {
        router.push(current.href);
      return;
    }
    const navigation = window.navigation;
    if (!navigation || typeof navigation.traverseTo !== "function") {
      leaving.current = false;
      setNotice("此瀏覽器無法安全恢復指定歷史項目；內容仍留在本頁，請使用頁面內導覽。");
      return;
    }
    bypass.current = true;
    const traversal = navigation.traverseTo(current.key);
    const committed = traversal.committed;
    if (!committed) {
      bypass.current = false;
      leaving.current = false;
      setNotice("無法啟動這次歷史導覽；內容仍留在本頁，請使用頁面內導覽。");
      return;
    }
    void committed.catch(() => {
      bypass.current = false;
      leaving.current = false;
      setNotice("無法完成這次歷史導覽；內容仍留在本頁，請使用頁面內導覽。");
    });
  };

  const stay = () => {
    attempt.current++;
    setBusy(false);
    setNotice(null);
    setIntent(null);
  };

  const choose = async (choice: GuardChoice) => {
    const current = intentRef.current;
    if (!current) return;
    const token = ++attempt.current;
    setBusy(true);
    setNotice(null);
    const result = choice === "save_then_switch"
      ? await actionsRef.current.saveThenLeave()
      : await actionsRef.current.discardAndLeave();
    if (token !== attempt.current) return;
    setBusy(false);
    if (result.outcome === "switched") perform(current);
    else if (result.outcome === "kept") stay();
    else if (result.outcome === "blocked") setNotice(messages[result.reason]);
  };

  const retryThenLeave = async () => {
    const current = intentRef.current;
    if (!current) return;
    const token = ++attempt.current;
    setBusy(true);
    setNotice(null);
    const result = await actionsRef.current.retryThenLeave();
    if (token !== attempt.current) return;
    setBusy(false);
    if (result.outcome === "switched") perform(current);
    else if (result.outcome === "kept") stay();
    else if (result.outcome === "blocked") setNotice(messages[result.reason]);
  };

  const button = "min-h-11 rounded-lg border border-slate-400 px-4 font-bold text-slate-900 hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-700 disabled:cursor-not-allowed disabled:opacity-50";
  const primary = "min-h-11 rounded-lg bg-blue-700 px-4 font-bold text-white hover:bg-blue-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-700 disabled:cursor-not-allowed disabled:bg-slate-400";

  return <>
    {notice && !intent && <p role="status" className="card">{notice}</p>}
    {guarded &&
      <p role="status" className="card">
        {historyProtection === "limited"
          ? "此瀏覽器不支援可取消的返回／前進防護；頁面內連結仍會先詢問。"
          : "此瀏覽器可保護允許攔截的返回／前進與頁面內連結。"}
        重新載入、關閉分頁，以及瀏覽器不允許 Navigation API 攔截的歷史項目，只能依賴原生提示，無法保證攔截所有離開情境。
      </p>}
    <Dialog.Root open={intent !== null && guarded} onOpenChange={(open) => { if (!open) stay(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-slate-950/40" />
        <Dialog.Content className="fixed left-1/2 top-1/2 grid max-h-[85vh] w-[min(92vw,34rem)] -translate-x-1/2 -translate-y-1/2 gap-4 overflow-y-auto rounded-2xl bg-white p-6 shadow-2xl focus:outline-none"
          data-testid="unsaved-changes-dialog" data-resource={identityKey}
          data-destination={intent?.kind === "history" ? intent.href : undefined}
          onCloseAutoFocus={(event) => {
            const target = opener.current;
            if (target?.isConnected) { event.preventDefault(); target.focus(); }
          }}>
          <Dialog.Title className="text-xl font-extrabold text-slate-900">
            {condition === "conflict" ? "版本衝突：離開前請先處理"
              : condition === "unknown" ? "保存結果未知：離開前請先確認"
              : condition === "saving" ? "正在保存" : "有尚未保存的修改"}
          </Dialog.Title>
          <Dialog.Description className="text-slate-700">
            {condition === "unknown"
              ? "上一次保存沒有取得可信回應，伺服器可能已寫入也可能沒有。放棄本地修改不會撤回可能已提交的寫入。"
              : condition === "conflict"
                ? "伺服器版本與你的內容不同；本地內容仍保留，不會自動採用伺服器版本。"
                : condition === "saving"
                  ? "請等待伺服器回應；只有收到可信成功回應才算保存。"
                  : "離開本頁會失去尚未保存的內容。這些編輯內容只保留在目前頁面記憶體；重新載入或關閉分頁後不保證恢復。"}
          </Dialog.Description>
          {notice && <p role="alert" className="rounded-lg bg-amber-50 p-3 text-amber-950">{notice}</p>}
          <div className="grid gap-3">
            {condition === "unknown" ? (
              <button type="button" className={primary} disabled={busy} onClick={() => void retryThenLeave()}>
                使用原操作恢復後離開
              </button>
            ) : condition !== "conflict" && (
              <button type="button" className={primary} disabled={busy && condition !== "saving"}
                onClick={() => void choose("save_then_switch")}>
                {condition === "saving" ? "保存完成後離開" : "保存後離開"}
              </button>
            )}
            <button type="button" className={button} onClick={stay}>留在目前頁面</button>
            <button type="button" className={button} disabled={busy || condition === "saving"}
              onClick={() => void choose("discard_and_switch")}>
              放棄本頁修改並離開
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  </>;
}
