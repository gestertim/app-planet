"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";

// readiness §92：電郵驗證確認面板。驗證值只存在短期 HttpOnly cookie，JavaScript 無法讀取；
// 由使用者按下確認才消耗，避免郵件掃描器預先開啟連結即完成驗證。驗證成功不等於核准。
type PanelState =
  | { readonly kind: "idle" }
  | { readonly kind: "working" }
  | { readonly kind: "verified"; readonly cleanupUnknown: boolean }
  | { readonly kind: "invalid" }
  | { readonly kind: "cancelled" }
  | { readonly kind: "unknown" }
  | { readonly kind: "error"; readonly message: string };

function readProblemCode(body: unknown): string | null {
  return typeof body === "object" && body !== null && "code" in body && typeof body.code === "string"
    ? body.code
    : null;
}

export function EmailVerifyPanel({ hasPendingLink }: { readonly hasPendingLink: boolean }) {
  const [state, setState] = useState<PanelState>(hasPendingLink ? { kind: "idle" } : { kind: "invalid" });
  const [ready, setReady] = useState(false);
  const alertRef = useRef<HTMLDivElement>(null);
  useEffect(() => setReady(true), []);
  useEffect(() => {
    if (state.kind !== "idle" && state.kind !== "working") alertRef.current?.focus();
  }, [state]);

  async function call(method: "POST" | "DELETE") {
    if (!ready || state.kind === "working") return;
    setState({ kind: "working" });
    let response: Response;
    try {
      response = await fetch("/api/v1/auth/teacher-signup/verify", {
        method, credentials: "same-origin", cache: "no-store", redirect: "error",
      });
    } catch {
      setState(method === "POST" ? { kind: "unknown" } : { kind: "error", message: "無法連線；請稍後再試。" });
      return;
    }
    if (method === "DELETE") {
      setState(response.status === 204 ? { kind: "cancelled" } : { kind: "error", message: "無法取消；請稍後再試。" });
      return;
    }
    const body: unknown = await response.json().catch(() => null);
    if (response.status === 200 && typeof body === "object" && body !== null &&
        "status" in body && body.status === "verified") {
      setState({ kind: "verified", cleanupUnknown: "session_cleanup" in body && body.session_cleanup === "unknown" });
      return;
    }
    const code = readProblemCode(body);
    if (code === "verification_link_invalid") setState({ kind: "invalid" });
    else if (code === "signup_throttled") setState({ kind: "error", message: "嘗試次數太多；請稍候再按一次確認。" });
    else setState({ kind: "unknown" });
  }

  const working = state.kind === "working";
  return (
    <section className="card grid gap-2" data-testid="email-verify" data-verify-state={state.kind} data-ready={ready}>
      {(state.kind === "idle" || working || state.kind === "unknown" || state.kind === "error") && (
        <>
          <p>請按下「確認電郵」完成教師申請的電郵驗證。完成後帳號仍需平台管理員審核。</p>
          <div className="flex gap-2">
            <button className="min-h-10 rounded-lg border px-3 font-bold" type="button" disabled={!ready || working}
              aria-busy={working} onClick={() => void call("POST")}>
              {working ? "處理中…" : "確認電郵"}
            </button>
            <button className="min-h-10 rounded-lg border px-3" type="button" disabled={!ready || working}
              onClick={() => void call("DELETE")}>
              取消
            </button>
          </div>
        </>
      )}
      {state.kind === "unknown" && (
        <div ref={alertRef} role="alert" tabIndex={-1}>
          無法確認驗證結果；上游可能已完成驗證但回應遺失。可以再按一次「確認電郵」，但不保證自動恢復；
          若連結已用或仍無法確認，請到登入頁查看狀態。尚未驗證時可重新寄送驗證信。
        </div>
      )}
      {state.kind === "error" && <div ref={alertRef} role="alert" tabIndex={-1}>{state.message}</div>}
      {state.kind === "verified" && (
        <div ref={alertRef} role="status" tabIndex={-1}>
          <h2>電郵已驗證</h2>
          {state.cleanupUnknown && <p role="alert">驗證服務的暫存工作階段撤銷結果不明；本頁未將該工作階段交給瀏覽器，也未自動登入。</p>}
          <p>你的教師申請仍待平台管理員審核；審核通過前不能使用教師工作台。</p>
          <Link className="button-link" href="/login">前往登入查看狀態</Link>
        </div>
      )}
      {state.kind === "invalid" && (
        <div ref={alertRef} role="alert" tabIndex={-1}>
          <h2>驗證連結無效或已失效</h2>
          <p>連結可能已使用、已過期或不完整。若尚未完成驗證，可以重新寄送驗證信；若已完成，請直接登入。</p>
          <p><Link href="/signup#resend">重新寄送驗證信</Link>　<Link href="/login">前往登入</Link></p>
        </div>
      )}
      {state.kind === "cancelled" && (
        <div ref={alertRef} role="status" tabIndex={-1}>
          <h2>已取消</h2>
          <p>已離開本頁確認流程，不代表撤回上游可能已完成的驗證。之後可嘗試登入查看狀態，或重新開啟信中的連結。</p>
          <p><Link href="/login">前往登入</Link></p>
        </div>
      )}
    </section>
  );
}
