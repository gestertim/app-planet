"use client";

import { useEffect, useRef, useState } from "react";
import {
  pendingTeachersPageSchema, staffReviewResultSchema, type PendingTeacher,
} from "@app-planet/core";

type Intent = { target: PendingTeacher; decision: "approved" | "rejected"; key: string };
type Phase = "confirm" | "sending" | "unknown" | "denied" | "conflict" | "completed";

export function TeacherReview() {
  const [ready, setReady] = useState(false);
  const [items, setItems] = useState<PendingTeacher[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [intent, setIntent] = useState<Intent | null>(null);
  const [phase, setPhase] = useState<Phase>("confirm");
  const [notice, setNotice] = useState("");
  const inFlight = useRef(false);
  const generation = useRef(0);

  async function load(after: string | null = null) {
    const current = ++generation.current;
    setLoading(true);
    setError("");
    try {
      const response = await fetch(`/api/v1/admin/teachers${after ? `?after=${encodeURIComponent(after)}` : ""}`, {
        cache: "no-store", credentials: "same-origin", redirect: "error", signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) throw new Error(response.status === 401 || response.status === 403 ? "denied" : "unavailable");
      const page = pendingTeachersPageSchema.parse(await response.json());
      if (current !== generation.current) return;
      setItems(page.items);
      setCursor(page.next_cursor);
    } catch (failure) {
      if (current !== generation.current) return;
      setItems([]);
      setCursor(null);
      setError(failure instanceof Error && failure.message === "denied"
        ? "目前沒有讀取權限，請重新登入並核對帳號狀態。" : "待審教師資料暫時無法取得，請重試。");
    } finally {
      if (current === generation.current) setLoading(false);
    }
  }
  useEffect(() => { setReady(true); void load(); return () => { generation.current += 1; }; }, []);

  async function send() {
    if (!ready || !intent || inFlight.current) return;
    inFlight.current = true;
    setPhase("sending");
    try {
      const response = await fetch(`/api/v1/admin/teachers/${intent.target.id}/review`, {
        method: "POST", cache: "no-store", credentials: "same-origin", redirect: "error",
        headers: {
          "content-type": "application/json", "idempotency-key": intent.key,
          "if-match": `"${intent.target.row_version}"`,
        },
        body: JSON.stringify({ decision: intent.decision }),
        signal: AbortSignal.timeout(15_000),
      });
      if (response.status === 401 || response.status === 403) { setPhase("denied"); return; }
      if (response.status === 409 || response.status === 404 || response.status === 422) { setPhase("conflict"); return; }
      if (!response.ok) { setPhase("unknown"); return; }
      const saved = staffReviewResultSchema.safeParse(await response.json());
      if (!saved.success || saved.data.id !== intent.target.id || saved.data.status !== intent.decision ||
          saved.data.row_version !== intent.target.row_version + 1 ||
          response.headers.get("etag") !== `"${saved.data.row_version}"`) {
        setPhase("unknown");
        return;
      }
      setPhase("completed");
      setNotice(`已${intent.decision === "approved" ? "批准" : "拒絕"} ${intent.target.display_label ?? "未設定顯示標籤"}。`);
      await load();
    } catch {
      setPhase("unknown");
    } finally {
      inFlight.current = false;
    }
  }

  const unresolved = intent !== null && !["completed", "conflict", "confirm"].includes(phase);
  return <section className="card" data-testid="teacher-review" data-ready={ready}>
    <h2>待審教師</h2>
    <p>只處理已完成電郵驗證的待審教師帳號；尚未完成電郵驗證的申請不具批准資格，不會出現在此清單。批准不代表學校核准、師生綁定或 AI 開放；不發通知。</p>
    <noscript>需要 JavaScript 才能載入及確認審核操作。</noscript>
    <button type="button" disabled={!ready || loading || inFlight.current} onClick={() => void load()}>重新載入待審教師</button>
    {loading && <p role="status">正在載入真實待審資料…</p>}
    {error && <p role="alert">{error}</p>}
    {!loading && !error && items.length === 0 && <p>目前沒有待審教師。</p>}
    {!error && <ul>{items.map((item) => <li key={item.id}>
      <p>{item.display_label ?? "未設定顯示標籤"}｜待審核｜版本 {item.row_version}</p>
      <p data-testid="teacher-school-note">申請者自述學校／任教說明（未經核實，不建立學校歸屬）：{item.school_note ?? "（無申請說明）"}</p>
      <small>內部識別：{item.id}</small>
      {(["approved", "rejected"] as const).map((decision) => <button key={decision} type="button"
        disabled={!ready || loading || unresolved || inFlight.current}
        onClick={() => { setIntent({ target: item, decision, key: crypto.randomUUID() }); setPhase("confirm"); setNotice(""); }}>
        {decision === "approved" ? "批准" : "拒絕"} {item.display_label ?? item.id}
      </button>)}
    </li>)}</ul>}
    {cursor && <button type="button" disabled={!ready || loading || unresolved}
      onClick={() => void load(cursor)}>下一頁（每頁最多 50 位）</button>}
    {notice && <p role="status">{notice}</p>}
    {intent && phase === "confirm" && <div role="dialog" aria-modal="true" aria-label="確認教師審核">
      <p>確定要{intent.decision === "approved" ? "批准" : "拒絕"} {intent.target.display_label ?? "未設定顯示標籤"}？</p>
      <p>內部識別：{intent.target.id}；版本 {intent.target.row_version}。拒絕後本輪不提供重新申請。</p>
      <button type="button" disabled={!ready} onClick={() => void send()}>確認{intent.decision === "approved" ? "批准" : "拒絕"}</button>
      <button type="button" disabled={!ready} onClick={() => setIntent(null)}>取消</button>
    </div>}
    {intent && phase === "sending" && <p role="status">正在提交，請勿重複操作…</p>}
    {intent && (phase === "unknown" || phase === "denied") && <div role="alert">
      <p>{phase === "denied" ? "身分或權限未通過，結果尚待核對。" : "結果尚待確認，可能已提交。"}不會自動換鍵、改決策或另送新操作；請勿關閉本頁，原意圖僅保留於本頁記憶體。</p>
      <button type="button" disabled={!ready} onClick={() => void send()}>以原鍵重試同一決策</button>
    </div>}
    {intent && phase === "conflict" && <div role="alert">
      <p>狀態、版本或操作識別衝突；未自動覆寫。請重新載入並明確核對。</p>
      <button type="button" disabled={!ready} onClick={() => { setIntent(null); void load(); }}>核對最新清單</button>
    </div>}
  </section>;
}
