"use client";

import * as Dialog from "@radix-ui/react-dialog";
import { useEffect, useRef, useState } from "react";
import { bindingEndSchema, bindingListSchema, type BindingCandidate, type BindingIntent,
  type BindingList, type BindingRow } from "@app-planet/core";
import { BindingOperationController } from "./binding-operation-controller.ts";

type Kind = BindingList["kind"];
export function BindingManagement({ accountScope }: { accountScope: string }) {
  const [controller] = useState(() => new BindingOperationController({
    storageKey: `app-planet:bindings:${accountScope}`,
    storage: { getItem: (key) => sessionStorage.getItem(key), setItem: (key, value) => sessionStorage.setItem(key, value),
      removeItem: (key) => sessionStorage.removeItem(key) },
    fetch: (...args) => fetch(...args),
  }));
  const [operation, setOperation] = useState(controller.getState);
  const [pages, setPages] = useState<Partial<Record<Kind, BindingList>>>({});
  const [reading, setReading] = useState<Partial<Record<Kind, boolean>>>({});
  const [notice, setNotice] = useState("");
  const [teacher, setTeacher] = useState<BindingCandidate | null>(null);
  const [student, setStudent] = useState<BindingCandidate | null>(null);
  const [ending, setEnding] = useState<BindingRow | null>(null);
  const [reason, setReason] = useState("");
  const [confirmation, setConfirmation] = useState<"create" | "end" | null>(null);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const generations = useRef({ teachers: 0, students: 0, bindings: 0 });
  const live = useRef(false);
  const busy = ["initial", "pending", "unknown", "closed"].includes(operation.status);
  const teachers = pages.teachers?.kind === "teachers" ? pages.teachers.items : [];
  const students = pages.students?.kind === "students" ? pages.students.items : [];
  const bindings = pages.bindings?.kind === "bindings" ? pages.bindings.items : [];

  const load = async (kind: Kind, after?: string, selected = teacher) => {
    const token = ++generations.current[kind];
    setConfirmation(null);
    setPages((p) => ({ ...p, [kind]: undefined }));
    setReading((p) => ({ ...p, [kind]: true }));
    if (kind === "teachers") { setTeacher(null); setStudent(null); setEnding(null); ++generations.current.students; }
    if (kind === "students") setStudent(null);
    if (kind === "bindings") setEnding(null);
    try {
      const params = new URLSearchParams({ kind, ...(after ? { after } : {}),
        ...(kind === "students" && selected ? { teacher_id: selected.account_id, school_id: selected.school_id } : {}) });
      const response = await fetch(`/api/v1/admin/bindings?${params}`, {
        credentials: "same-origin", cache: "no-store", signal: AbortSignal.timeout(10_000),
      });
      if (!live.current || token !== generations.current[kind] || controller.getState().status === "closed") return;
      if ([401, 403].includes(response.status)) return controller.close();
      if (!response.ok) throw new Error("list_failed");
      const parsed = bindingListSchema.safeParse(await response.json());
      if (!parsed.success || parsed.data.kind !== kind) throw new Error("invalid_list");
      if (!live.current || token !== generations.current[kind] || controller.getState().status === "closed") return;
      setPages((p) => ({ ...p, [kind]: parsed.data }));
      setNotice("");
    } catch {
      if (live.current && token === generations.current[kind] && controller.getState().status !== "closed") {
        setNotice("無法讀取目前候選或關係；未沿用舊資料，請重新讀取。");
      }
    } finally {
      if (live.current && token === generations.current[kind]) setReading((p) => ({ ...p, [kind]: false }));
    }
  };
  useEffect(() => {
    live.current = true;
    const deactivate = controller.activate();
    const unsubscribe = controller.subscribe(() => {
      const next = controller.getState();
      setOperation(next);
      setConfirmation(null);
      if (["pending", "closed"].includes(next.status)) {
        for (const kind of ["teachers", "students", "bindings"] as const) ++generations.current[kind];
        setPages({}); setTeacher(null); setStudent(null); setEnding(null); setReading({});
      }
      if (["success", "failed"].includes(next.status)) { void load("teachers"); void load("bindings"); }
    });
    controller.restore();
    if (controller.getState().status !== "closed") { void load("teachers"); void load("bindings"); }
    return () => {
      live.current = false; unsubscribe();
      deactivate();
      for (const kind of ["teachers", "students", "bindings"] as const) ++generations.current[kind];
    };
  }, [controller]);
  const open = (kind: "create" | "end", source: HTMLButtonElement) => {
    if (busy) return;
    trigger.current = source;
    setConfirmation(kind);
  };
  const send = () => {
    if (busy) return;
    let intent: BindingIntent;
    if (confirmation === "create" && teacher && student) {
      intent = { operation: "create", key: crypto.randomUUID(),
        body: { teacher_id: teacher.account_id, student_id: student.account_id } };
    } else if (confirmation === "end" && ending && bindingEndSchema.safeParse({ end_reason: reason }).success) {
      intent = { operation: "end", target: ending.id, key: crypto.randomUUID(), body: { end_reason: reason } };
    } else return;
    setConfirmation(null);
    void controller.start(intent);
  };
  if (operation.status === "closed") return <p role="alert">{operation.message}</p>;
  return <section className="card grid gap-3" aria-label="師生綁定管理">
    <h2>師生綁定管理</h2>
    <p>只選擇既有合格帳號，不批准帳號、學校或教師學校歸屬。候選是讀取當下狀態，送出時會再次驗證。</p>
    <p role="status">{notice || operation.message}</p>
    {operation.intent && <p>待確認原操作：{operation.intent.operation === "create" ? "建立" : "解除"}；
      {operation.intent.operation === "end" ? `關聯 ${operation.intent.target}；理由：${operation.intent.body.end_reason}`
        : `教師 ${operation.intent.body.teacher_id}；學生 ${operation.intent.body.student_id}`}</p>}
    {operation.status === "unknown" && <button type="button" onClick={() => void controller.retry()}>以原對象與原鍵重試</button>}
    {operation.receipt && <p data-testid="binding-receipt">原操作 receipt：{operation.receipt.operation === "create" ? "建立" : "解除"}；
      關聯 {operation.receipt.binding_id}；操作時狀態 {operation.receipt.state}；{operation.receipt.operated_at}。
      不代表目前關係或目前審查批准。</p>}
    <button type="button" disabled={operation.status === "initial" || operation.status === "pending"}
      onClick={() => { void load("teachers"); void load("bindings"); }}>重新讀取目前關係與候選</button>
    <fieldset disabled={busy || reading.teachers}>
      <legend>1. 選擇教師及有效學校歸屬</legend>
      <label>合格教師與學校<select aria-label="合格教師與學校" value={teacher?.id ?? ""} onChange={(e) => {
        const selected = teachers.find((t) => t.id === e.target.value) ?? null;
        setTeacher(selected); setStudent(null); setPages((p) => ({ ...p, students: undefined }));
        ++generations.current.students;
        if (selected) void load("students", undefined, selected);
      }}>
        <option value="">請選擇教師及學校</option>
        {teachers.map((t) => <option value={t.id} key={t.id}>{t.label}｜教師｜{t.school_label}｜有效歸屬</option>)}
      </select></label>
      <p>每頁最多 20 筆；按持久歸屬 ID 穩定排序。</p>
      <button type="button" disabled={!pages.teachers?.next_cursor}
        onClick={() => void load("teachers", pages.teachers?.next_cursor ?? undefined)}>下一頁教師</button>
    </fieldset>
    <fieldset disabled={busy || !teacher || reading.students}>
      <legend>2. 選擇同校合格學生</legend>
      <label>合格學生<select aria-label="合格學生" value={student?.id ?? ""} onChange={(e) =>
        setStudent(students.find((s) => s.id === e.target.value) ?? null)}>
        <option value="">請選擇學生</option>
        {students.map((s) => <option value={s.id} key={s.id}>{s.label}｜學生｜{s.school_label}｜目前合格</option>)}
      </select></label>
      <button type="button" disabled={!pages.students?.next_cursor}
        onClick={() => void load("students", pages.students?.next_cursor ?? undefined)}>下一頁學生</button>
    </fieldset>
    {teacher && student && <p>核對：教師 {teacher.label}；學生 {student.label}；學校 {student.school_label}。
      教師的有效持久學校歸屬：{teacher.id}。本操作不會自動修改角色或學校。</p>}
    <button type="button" disabled={busy || !teacher || !student || reading.students}
      onClick={(e) => open("create", e.currentTarget)}>核對並建立綁定</button>
    <fieldset disabled={busy || reading.bindings}>
      <legend>3. 查看持久關係／解除指定綁定</legend>
      <label>既有綁定<select aria-label="既有綁定" value={ending?.id ?? ""} onChange={(e) => {
        setEnding(bindings.find((b) => b.id === e.target.value) ?? null); setReason("");
      }}>
        <option value="">請選擇關聯</option>
        {bindings.map((b) => <option key={b.id} value={b.id}>{b.teacher_label} → {b.student_label}｜
          {b.school_label}｜{b.state === "active" ? "有效" : "已解除"}｜{b.id}</option>)}
      </select></label>
      <p>目前伺服器讀取：{bindings.length} 筆（含歷史），按關聯 ID 穩定排序，每頁最多 20 筆。</p>
      <button type="button" disabled={!pages.bindings?.next_cursor}
        onClick={() => void load("bindings", pages.bindings?.next_cursor ?? undefined)}>下一頁關係</button>
      {ending && <p data-testid="current-binding">關聯 {ending.id}；目前{ending.state === "active" ? "有效" : "已解除"}。</p>}
      <label>解除理由<textarea aria-label="解除理由" value={reason} onChange={(e) => setReason(e.target.value)}
        disabled={ending?.state !== "active"} /></label>
      <p>理由最多 2000 個 Unicode 字元（工程輸入防護，非正式產品配額），不可只有空白或含控制字元；原文精確保存。</p>
      <button type="button" disabled={ending?.state !== "active" || !bindingEndSchema.safeParse({ end_reason: reason }).success}
        onClick={(e) => open("end", e.currentTarget)}>核對並解除綁定</button>
    </fieldset>
    <Dialog.Root open={confirmation !== null} onOpenChange={(value) => { if (!value) setConfirmation(null); }}>
      <Dialog.Portal><Dialog.Overlay className="dialog-overlay" /><Dialog.Content className="dialog-content"
        onCloseAutoFocus={(event) => { event.preventDefault(); trigger.current?.focus(); }}>
        <Dialog.Title>{confirmation === "end" ? "確認解除指定綁定" : "確認建立師生綁定"}</Dialog.Title>
        <Dialog.Description>{confirmation === "end"
          ? `只解除關聯 ${ending?.id}。提交後教師新的審查存取將被拒絕，舊批准失效；重綁也不會復活。已送達內容無法收回。`
          : `教師 ${teacher?.label}；學生 ${student?.label}；學校 ${student?.school_label}。請再次核對有效學校歸屬。`}</Dialog.Description>
        {confirmation === "end" && <p className="whitespace-pre-wrap">解除理由：{reason}</p>}
        <Dialog.Close asChild><button type="button">取消，尚未送出</button></Dialog.Close>
        <button type="button" disabled={busy} onClick={send}>明確確認並送出{confirmation === "end" ? "解除" : "建立"}</button>
      </Dialog.Content></Dialog.Portal>
    </Dialog.Root>
  </section>;
}
