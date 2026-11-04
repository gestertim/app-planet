"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type FormEvent } from "react";

// readiness §92：教師註冊申請表單（隔離本機子集）。只送四個已批准欄位；沒有角色或狀態選項。
// 密碼只存在元件記憶體，送出後立即清除；不寫入 URL、storage 或日誌。結果不明時只保留
// 非秘密的申請識別與欄位，請使用者重新輸入密碼後以同一申請重試，不在背景重送。
const limits = { email: 254, displayName: 40, schoolNote: 200 } as const;

type Fields = { readonly email: string; readonly displayName: string; readonly schoolNote: string };

type FormState =
  | { readonly kind: "idle" }
  | { readonly kind: "submitting" }
  | { readonly kind: "submitted" }
  | { readonly kind: "unknown" }
  | { readonly kind: "error"; readonly message: string };

function readProblemCode(body: unknown): string | null {
  return typeof body === "object" && body !== null && "code" in body && typeof body.code === "string"
    ? body.code
    : null;
}

function retryMessage(response: Response, fallback: string, template: (seconds: number) => string): string {
  const retry = Number(response.headers.get("retry-after"));
  return Number.isSafeInteger(retry) && retry > 0 ? template(retry) : fallback;
}

export function TeacherSignupForm() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [schoolNote, setSchoolNote] = useState("");
  const [state, setState] = useState<FormState>({ kind: "idle" });
  const operation = useRef<{ readonly key: string; readonly fields: Fields } | null>(null);
  const alertRef = useRef<HTMLDivElement>(null);

  const [ready, setReady] = useState(false);
  useEffect(() => setReady(true), []);
  useEffect(() => () => setPassword(""), []);
  useEffect(() => {
    if (state.kind !== "idle" && state.kind !== "submitting") alertRef.current?.focus();
  }, [state]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!ready || state.kind === "submitting") return;
    const fields: Fields = { email, displayName, schoolNote };
    const previous = operation.current;
    if (previous !== null && (previous.fields.email !== fields.email ||
      previous.fields.displayName !== fields.displayName || previous.fields.schoolNote !== fields.schoolNote)) {
      setPassword("");
      setState({ kind: "unknown" });
      return;
    }
    const current = previous ?? { key: crypto.randomUUID(), fields };
    operation.current = current;
    const body = JSON.stringify({
      email: fields.email, password, display_name: fields.displayName, school_note: fields.schoolNote,
    });
    setPassword("");
    setState({ kind: "submitting" });
    let response: Response;
    try {
      response = await fetch("/api/v1/auth/teacher-signup", {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        redirect: "error",
        headers: { "content-type": "application/json", "idempotency-key": current.key },
        body,
      });
    } catch {
      setState({ kind: "unknown" });
      return;
    }
    const result: unknown = await response.json().catch(() => null);
    if (response.status === 202 && typeof result === "object" && result !== null &&
        "status" in result && result.status === "submitted") {
      setState({ kind: "submitted" });
      return;
    }
    const code = readProblemCode(result);
    if (code === "signup_outcome_unknown" || response.status >= 500 && code !== "dependency_unavailable") {
      setState({ kind: "unknown" });
      return;
    }
    if (code === "signup_operation_expired" || code === "idempotency_key_reuse") {
      setState({ kind: "unknown" });
      return;
    }
    if (code === "invalid_request" || code === "unknown_field") operation.current = null;
    setState({
      kind: "error",
      message: code === "signup_throttled"
        ? retryMessage(response, "送出次數太多；請稍候再試。", (s) => `送出次數太多；請約 ${s} 秒後再試。`)
        : code === "invalid_request"
          ? "資料格式不符合要求；請確認電子郵件、密碼（至少 8 個字元）、顯示名稱與學校說明後再試。"
          : code === "dependency_unavailable"
              ? "教師申請目前未開放或服務暫時無法使用；請稍後再試。"
              : "無法確認申請；請保留原申請內容，稍後查看信箱或嘗試登入。",
    });
  }

  const submitting = state.kind === "submitting";
  const disabled = !ready || submitting;
  if (state.kind === "submitted") {
    return (
      <section className="card grid gap-2" data-testid="signup-submitted">
        <div ref={alertRef} role="status" tabIndex={-1}>
          <h2>已接收申請請求</h2>
          <p>
            本回應不確認帳號是否已建立，也不確認是否已寄信。送出成功不代表信件已送達，
            也不代表電郵已驗證或帳號已核准。若先前申請結果不明，系統不會再次建立申請。
          </p>
          <p>完成驗證後，帳號仍需平台管理員審核；審核前不能使用教師工作台。</p>
        </div>
        <p>沒收到信？可以在下方「重新寄送驗證信」再試一次，或稍後再到登入頁查看狀態。</p>
        <Link className="button-link" href="/login">前往登入頁</Link>
      </section>
    );
  }
  return (
    <form className="card grid gap-2" noValidate method="post" action="/api/v1/auth/teacher-signup"
      onSubmit={(event) => void submit(event)} aria-describedby="teacher-signup-note" data-ready={ready}>
      <p className="muted" id="teacher-signup-note">
        本表單只提供教師帳號申請；送出後需完成電郵驗證，並等待平台管理員審核。學生不使用本表單。
      </p>
      {!ready && <p role="status">申請表單正在載入；若長時間無法操作，請確認 JavaScript 已啟用並重新整理。</p>}
      <noscript>教師申請需要 JavaScript；請啟用後重新載入。</noscript>
      <label htmlFor="teacher-signup-email">電子郵件</label>
      <input id="teacher-signup-email" name="email" type="email" autoComplete="email" required
        value={email} onChange={(event) => setEmail(event.target.value)} disabled={disabled} maxLength={limits.email} />
      <label htmlFor="teacher-signup-password">密碼（至少 8 個字元）</label>
      <input id="teacher-signup-password" name="password" type="password" autoComplete="new-password" required
        value={password} onChange={(event) => setPassword(event.target.value)} disabled={disabled} />
      <label htmlFor="teacher-signup-display-name">顯示名稱（最多 {limits.displayName} 字）</label>
      <input id="teacher-signup-display-name" name="display_name" type="text" autoComplete="nickname" required
        value={displayName} onChange={(event) => setDisplayName(event.target.value)} disabled={disabled}
        maxLength={limits.displayName} />
      <label htmlFor="teacher-signup-school-note">所屬學校／任教說明（最多 {limits.schoolNote} 字）</label>
      <textarea id="teacher-signup-school-note" name="school_note" required rows={3}
        aria-describedby="teacher-signup-school-help"
        value={schoolNote} onChange={(event) => setSchoolNote(event.target.value)} disabled={disabled}
        maxLength={limits.schoolNote} />
      <p className="muted" id="teacher-signup-school-help">
        僅供管理員審核參考，不會自動建立學校歸屬。請勿填寫電話、地址、證件或學生資料。
      </p>
      <button className="min-h-10 rounded-lg border px-3 font-bold" type="submit" disabled={disabled}
        aria-busy={submitting}>
        {submitting ? "送出中…" : "送出教師申請"}
      </button>
      {submitting && <p role="status">正在送出申請…</p>}
      {state.kind === "unknown" && (
        <div ref={alertRef} role="alert" tabIndex={-1} data-testid="signup-unknown">
          <strong>無法確認申請結果</strong>
          <p>申請可能已送出，也可能尚未建立帳號而安全停止。請保留原欄位；修改內容不會建立新申請。
            以原內容再次送出只取得中性接收回應，不保證恢復或再次派送。請查看信箱或嘗試登入；重載或新分頁也不解除伺服器的未結限制。</p>
        </div>
      )}
      {state.kind === "error" && <div ref={alertRef} role="alert" tabIndex={-1}>{state.message}</div>}
    </form>
  );
}

export function TeacherSignupResendForm() {
  const [email, setEmail] = useState("");
  const [state, setState] = useState<FormState>({ kind: "idle" });
  const [ready, setReady] = useState(false);
  useEffect(() => setReady(true), []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!ready || state.kind === "submitting") return;
    setState({ kind: "submitting" });
    let response: Response;
    try {
      response = await fetch("/api/v1/auth/teacher-signup/resend", {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        redirect: "error",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email }),
      });
    } catch {
      setState({ kind: "error", message: "無法連線；請稍後再試。" });
      return;
    }
    const result: unknown = await response.json().catch(() => null);
    if (response.status === 202) {
      setState({ kind: "submitted" });
      return;
    }
    const code = readProblemCode(result);
    setState({
      kind: "error",
      message: code === "signup_throttled"
        ? retryMessage(response, "重寄次數太多；請稍候再試。", (s) => `重寄次數太多；請約 ${s} 秒後再試。`)
        : code === "invalid_request"
          ? "電子郵件格式不正確；請確認後再試。"
          : "目前無法處理重寄要求；請稍後再試。",
    });
  }

  const submitting = state.kind === "submitting";
  return (
    <form id="resend" className="card grid gap-2" noValidate method="post" action="/api/v1/auth/teacher-signup/resend"
      onSubmit={(event) => void submit(event)} data-ready={ready} aria-labelledby="teacher-resend-heading">
      <h2 id="teacher-resend-heading">重新寄送驗證信</h2>
      <label htmlFor="teacher-resend-email">申請時使用的電子郵件</label>
      <input id="teacher-resend-email" name="email" type="email" autoComplete="email" required value={email}
        onChange={(event) => setEmail(event.target.value)} disabled={!ready || submitting} maxLength={limits.email} />
      <button className="min-h-10 rounded-lg border px-3 font-bold" type="submit" disabled={!ready || submitting}
        aria-busy={submitting}>
        {submitting ? "處理中…" : "重新寄送驗證信"}
      </button>
      {state.kind === "submitted" && (
        <p role="status" data-testid="resend-submitted">
          如果這個電子郵件有尚未驗證的申請，驗證服務會再寄一封信；這不代表信件已送達。
        </p>
      )}
      {state.kind === "error" && <p role="alert">{state.message}</p>}
    </form>
  );
}
