"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";

export function StudentLoginForm() {
  const [handle, setHandle] = useState("");
  const [code, setCode] = useState("");
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const alert = useRef<HTMLDivElement>(null);
  useEffect(() => setReady(true), []);
  useEffect(() => { if (message) alert.current?.focus(); }, [message]);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!ready || busy) return;
    const input = { handle, login_code: code };
    setCode("");
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch("/api/v1/auth/student/login", {
        method: "POST", credentials: "same-origin", cache: "no-store", redirect: "error",
        headers: { "content-type": "application/json" }, body: JSON.stringify(input),
      });
      const body: unknown = await response.json();
      if (response.status === 200 && typeof body === "object" && body !== null &&
          Object.keys(body).length === 2 && "account_status" in body && body.account_status === "approved" &&
          "landing" in body && body.landing === "home") {
        window.location.assign("/student");
        return;
      }
      const problem = typeof body === "object" && body !== null && "code" in body ? body.code : null;
      setMessage(problem === "invalid_credentials" ? "請確認帳號與登入碼後再試一次。"
        : problem === "account_unavailable" ? "帳號目前無法使用，請找老師或管理員協助。"
        : problem === "school_not_confirmed" ? "學校尚未確認，請找老師或管理員協助。"
        : problem === "login_throttled" ? "嘗試登入次數太多；請稍候再試。"
        : "登入服務暫時無法使用；請稍後再試。");
    } catch {
      setMessage("登入服務暫時無法使用；請稍後再試。");
    } finally {
      setBusy(false);
    }
  }
  return (
    <form className="card grid gap-2" method="post" action="/api/v1/auth/student/login"
      noValidate data-ready={ready} onSubmit={(event) => void submit(event)}>
      <p>使用老師提供的學生帳號與登入碼。目前僅供隔離本機測試。</p>
      {!ready && <p role="status">登入表單正在載入；請確認 JavaScript 已啟用。</p>}
      <noscript>學生登入需要 JavaScript；請啟用後重新載入。</noscript>
      <label htmlFor="student-handle">學生帳號</label>
      <input id="student-handle" name="handle" autoComplete="off" autoCapitalize="none"
        value={handle} onChange={(event) => setHandle(event.target.value)} disabled={!ready || busy} />
      <label htmlFor="student-code">登入碼</label>
      <input id="student-code" name="login_code" type="password" autoComplete="off"
        value={code} onChange={(event) => setCode(event.target.value)} disabled={!ready || busy} />
      <button type="submit" disabled={!ready || busy}>{busy ? "登入中…" : "學生登入"}</button>
      {message && <div ref={alert} role="alert" tabIndex={-1}>{message}</div>}
    </form>
  );
}
