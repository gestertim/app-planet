"use client";

import * as Dialog from "@radix-ui/react-dialog";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { schoolCreateSchema, schoolDetailSchema, schoolListSchema, type SchoolDetail, type SchoolList } from "@app-planet/core";
import { SchoolOperationController } from "./school-operation-controller.ts";

export function SchoolManagement({ accountScope, schoolId }: { accountScope: string; schoolId?: string }) {
  const [controller] = useState(() => new SchoolOperationController({
    storageKey: `app-planet:schools:${accountScope}`,
    storage: { getItem: (key) => sessionStorage.getItem(key), setItem: (key, value) => sessionStorage.setItem(key, value),
      removeItem: (key) => sessionStorage.removeItem(key) },
    fetch: (...args) => fetch(...args),
  }));
  const [operation, setOperation] = useState(controller.getState);
  const [label, setLabel] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [page, setPage] = useState<SchoolList | null>(null);
  const [detail, setDetail] = useState<SchoolDetail | null>(null);
  const [notice, setNotice] = useState("");
  const [reading, setReading] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const live = useRef(false), generation = useRef(0);
  const busy = ["initial", "pending", "unknown", "closed"].includes(operation.status);
  const load = async (after?: string) => {
    const token = ++generation.current;
    setPage(null); setDetail(null); setReading(true); setNotice("");
    try {
      const path = schoolId ? `/api/v1/admin/schools/${encodeURIComponent(schoolId)}`
        : `/api/v1/admin/schools${after ? `?after=${encodeURIComponent(after)}` : ""}`;
      const response = await fetch(path, { credentials: "same-origin", cache: "no-store", signal: AbortSignal.timeout(10_000) });
      if (!live.current || token !== generation.current || controller.getState().status === "closed") return;
      if ([401, 403].includes(response.status)) return controller.close();
      if (response.status === 404) { setNotice("找不到這所學校；請回列表重新選擇。"); return; }
      if (!response.ok) throw new Error("school_read_failed");
      const raw: unknown = await response.json();
      if (!live.current || token !== generation.current || controller.getState().status === "closed") return;
      if (schoolId) {
        const parsed = schoolDetailSchema.safeParse(raw);
        if (!parsed.success || parsed.data.school.id !== schoolId) throw new Error("invalid_school_detail");
        setDetail(parsed.data);
      } else {
        const parsed = schoolListSchema.safeParse(raw);
        if (!parsed.success || (after && parsed.data.items.some((s) => s.id <= after))) throw new Error("invalid_school_list");
        setPage(parsed.data);
      }
    } catch {
      if (live.current && token === generation.current && controller.getState().status !== "closed")
        setNotice("無法讀取學校；這不代表沒有學校。請重新讀取。");
    } finally { if (live.current && token === generation.current) setReading(false); }
  };
  useEffect(() => {
    live.current = true;
    const deactivate = controller.activate();
    const unsubscribe = controller.subscribe(() => {
      const next = controller.getState();
      setOperation(next); setConfirming(false);
      if (next.status === "closed") { ++generation.current; setPage(null); setDetail(null); setReading(false); }
      if (next.status === "success" && next.receipt) {
        // receipt 不當作 current 詳情；新文件重新經可信 Auth 與 DB 讀取。
        window.location.assign(`/admin/schools/${encodeURIComponent(next.receipt.school_id)}`);
      }
    });
    controller.restore();
    if (controller.getState().status !== "closed") void load();
    return () => { live.current = false; ++generation.current; unsubscribe(); deactivate(); };
  }, [controller, schoolId]);
  const send = () => {
    if (busy || !confirming || !schoolCreateSchema.safeParse({ label }).success) return;
    setConfirming(false);
    void controller.start({ operation: "create", key: crypto.randomUUID(), body: { label } });
  };
  if (operation.status === "closed") return <p role="alert">{operation.message}</p>;
  return <section className="card grid gap-3" aria-label="學校管理">
    <h2>{schoolId ? "學校詳情" : "學校登錄與列表"}</h2>
    <p>本輪新建學校：已登錄，尚未核驗；不代表學校已批准。</p>
    <p>登錄不建立教師歸屬或師生綁定，也不放行學生登入、AI、部署或公開作品。本輪不提供核准／恢復操作。</p>
    <p role="status">{notice || (reading ? "正在讀取 DB 目前資料。" : operation.message)}</p>
    {operation.intent && <p>待確認原名稱：{operation.intent.body.label}。結果可能已提交，僅可原鍵、原本文重試。</p>}
    {operation.status === "unknown" && <button type="button" onClick={() => void controller.retry()}>以原名稱與原鍵重試</button>}
    <button type="button" disabled={operation.status === "initial" || operation.status === "pending" || reading}
      onClick={() => void load()}>重新讀取學校</button>
    {!schoolId && <>
      <fieldset disabled={busy}>
        <legend>登錄未確認學校</legend>
        <label>學校名稱<input value={label} onChange={(e) => setLabel(e.target.value)} /></label>
        <button ref={trigger} type="button" disabled={!schoolCreateSchema.safeParse({ label }).success}
          onClick={() => setConfirming(true)}>核對並建立學校</button>
      </fieldset>
      {page && <>
        {page.items.length === 0 ? <p>目前這一頁沒有學校。</p> : <ul>{page.items.map((s) => <li key={s.id}>
          <Link href={`/admin/schools/${s.id}`} prefetch={false}>{s.label}</Link>
          <span>｜{s.approval_state}｜{s.id}</span>
        </li>)}</ul>}
        <button type="button" disabled={!page.next_cursor || reading}
          onClick={() => void load(page.next_cursor ?? undefined)}>下一頁學校</button>
      </>}
    </>}
    {detail && <dl data-testid="school-detail">
      <dt>名稱</dt><dd>{detail.school.label}</dd>
      <dt>學校識別</dt><dd>{detail.school.id}</dd>
      <dt>目前核准狀態</dt><dd>{detail.school.approval_state}</dd>
      <dt>核准 epoch</dt><dd>{detail.school.approval_epoch}</dd>
      <dt>有效期限（DB 真值；語意仍待核定）</dt><dd>{detail.school.valid_until ?? "未設定"}</dd>
      <dt>目前文件版本標籤（不等於核驗歷史）</dt><dd>{detail.school.current_doc_version ?? "未設定"}</dd>
      <dt>核驗紀錄與最後變更摘要</dt><dd>尚無核驗紀錄可供讀取；本輪缺正式歷史來源，未提供最後變更摘要，不以建立時間替代。</dd>
    </dl>}
    {schoolId && <Link href="/admin/schools" prefetch={false}>返回學校列表</Link>}
    <Dialog.Root open={confirming} onOpenChange={setConfirming}>
      <Dialog.Portal><Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className="dialog-content" onCloseAutoFocus={(event) => {
          event.preventDefault(); trigger.current?.focus();
        }}>
          <Dialog.Title>明確確認登錄未確認學校</Dialog.Title>
          <Dialog.Description>請核對名稱：{label}。已登錄，尚未核驗；不代表學校已批准。尚未送出，不建立核驗文件或其他關係。</Dialog.Description>
          <Dialog.Close asChild><button type="button">取消，尚未送出</button></Dialog.Close>
          <button type="button" disabled={busy} onClick={send}>明確確認並送出建立</button>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  </section>;
}
