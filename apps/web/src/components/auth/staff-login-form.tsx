"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type FormEvent } from "react";

// 既有教職員登入表單（A-2 隔離本機子集）。密碼只在元件記憶體；不寫入 URL、storage 或日誌，
// 送出後與離開時清除。導向目的地固定由伺服器回應的 landing 對照，不接受 return URL。
const landingPaths = {
  teacher_home: "/teacher",
  admin_home: "/admin",
  account_status: "/account/status",
} as const;

type FormState =
  | { readonly kind: "idle" }
  | { readonly kind: "submitting" }
  | { readonly kind: "error"; readonly message: string }
  | { readonly kind: "email_not_verified" }
  | { readonly kind: "account_unavailable" };

function readProblemCode(body: unknown): string | null {
  return typeof body === "object" && body !== null && "code" in body && typeof body.code === "string"
    ? body.code
    : null;
}

function readLanding(body: unknown): keyof typeof landingPaths | null {
  if (typeof body !== "object" || body === null || !("landing" in body)) return null;
  const landing = body.landing;
  return landing === "teacher_home" || landing === "admin_home" || landing === "account_status" ? landing : null;
}

export function StaffLoginForm() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [state, setState] = useState<FormState>({ kind: "idle" });
  const alertRef = useRef<HTMLDivElement>(null);

  const [ready, setReady] = useState(false);
  useEffect(() => setReady(true), []);
  useEffect(() => () => setPassword(""), []);
  useEffect(() => {
    if (state.kind === "error" || state.kind === "account_unavailable" || state.kind === "email_not_verified") {
      alertRef.current?.focus();
    }
  }, [state]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!ready || state.kind === "submitting") return;
    const credentials = { email, password };
    setPassword("");
    setState({ kind: "submitting" });
    let response: Response;
    try {
      response = await fetch("/api/v1/auth/staff/login", {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        redirect: "error",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(credentials),
      });
    } catch {
      setState({ kind: "error", message: "無法連線到登入服務；請確認網路後再試一次。" });
      return;
    }
    const body: unknown = await response.json().catch(() => null);
    if (response.ok) {
      const landing = readLanding(body);
      if (landing === null) {
        setState({ kind: "error", message: "登入結果無法確認；請重新整理後再試一次。" });
        return;
      }
      window.location.assign(landingPaths[landing]);
      return;
    }
    const code = readProblemCode(body);
    if (code === "account_unavailable") {
      setState({ kind: "account_unavailable" });
      return;
    }
    if (code === "email_not_verified") {
      setState({ kind: "email_not_verified" });
      return;
    }
    if (code === "login_throttled") {
      const retry = Number(response.headers.get("retry-after"));
      setState({
        kind: "error",
        message: Number.isSafeInteger(retry) && retry > 0
          ? `嘗試登入次數太多；請約 ${retry} 秒後再試。`
          : "嘗試登入次數太多；請稍候再試。",
      });
      return;
    }
    setState({
      kind: "error",
      message: code === "invalid_credentials"
        ? "電子郵件或密碼不正確；請確認後再試一次。"
        : code === "dependency_unavailable"
          ? "登入服務暫時無法使用；請稍後再試。"
          : "無法完成登入；請重新整理頁面後再試一次。",
    });
  }

  const submitting = state.kind === "submitting";
  return (
    <form className="card grid gap-2" noValidate method="post" action="/api/v1/auth/staff/login"
      onSubmit={(event) => void submit(event)} aria-describedby="staff-login-note" data-ready={ready}>
      <p className="muted" id="staff-login-note">僅限已建立的教師／管理員帳號。學生請使用學生登入方式。</p>
      {!ready && <p role="status">登入表單正在載入；若長時間無法操作，請確認 JavaScript 已啟用並重新整理。</p>}
      <noscript>教職員登入需要 JavaScript；請啟用後重新載入。</noscript>
      <label htmlFor="staff-login-email">電子郵件</label>
      <input id="staff-login-email" name="email" type="email" autoComplete="username" required
        value={email} onChange={(event) => setEmail(event.target.value)} disabled={!ready || submitting} maxLength={320} />
      <label htmlFor="staff-login-password">密碼</label>
      <input id="staff-login-password" name="password" type="password" autoComplete="current-password" required
        value={password} onChange={(event) => setPassword(event.target.value)} disabled={!ready || submitting} />
      <button className="min-h-10 rounded-lg border px-3 font-bold" type="submit" disabled={!ready || submitting}
        aria-busy={submitting}>
        {submitting ? "登入中…" : "登入"}
      </button>
      {submitting && <p role="status">正在確認登入資訊…</p>}
      {state.kind === "error" && <div ref={alertRef} role="alert" tabIndex={-1}>{state.message}</div>}
      {state.kind === "account_unavailable" && (
        <div ref={alertRef} role="alert" tabIndex={-1} data-testid="account-unavailable">
          <strong>帳號目前無法使用</strong>
          <p>這個帳號目前不能登入 App Planet（例如已停用）。請聯絡學校或平台管理員確認帳號狀態。</p>
        </div>
      )}
      {state.kind === "email_not_verified" && (
        <div ref={alertRef} role="alert" tabIndex={-1} data-testid="email-not-verified">
          <strong>電郵尚未驗證</strong>
          <p>請先開啟驗證信中的連結完成電郵驗證；完成後帳號仍需管理員審核。</p>
          <p><Link href="/signup#resend">重新寄送驗證信</Link></p>
        </div>
      )}
    </form>
  );
}
