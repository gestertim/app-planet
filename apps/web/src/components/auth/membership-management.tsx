"use client";

import * as Dialog from "@radix-ui/react-dialog";
import { useEffect, useRef, useState } from "react";
import { membershipListSchema, type MembershipCandidate, type MembershipIntent,
  type MembershipList, type MembershipRow } from "@app-planet/core";
import { MembershipOperationController } from "./membership-operation-controller.ts";

type Kind = MembershipList["kind"];
const kinds = ["teachers", "schools", "memberships"] as const;
export function MembershipManagement({ accountScope }: { accountScope: string }) {
  const [controller] = useState(() => new MembershipOperationController({
    storageKey: `app-planet:memberships:${accountScope}`,
    storage: { getItem: (key) => sessionStorage.getItem(key), setItem: (key, value) => sessionStorage.setItem(key, value),
      removeItem: (key) => sessionStorage.removeItem(key) },
    fetch: (...args) => fetch(...args),
  }));
  const [operation, setOperation] = useState(controller.getState);
  const [pages, setPages] = useState<Partial<Record<Kind, MembershipList>>>({});
  const [reading, setReading] = useState<Partial<Record<Kind, boolean>>>({});
  const [notices, setNotices] = useState<Partial<Record<Kind, string>>>({});
  const [teacher, setTeacher] = useState<MembershipCandidate | null>(null);
  const [school, setSchool] = useState<MembershipCandidate | null>(null);
  const [ending, setEnding] = useState<MembershipRow | null>(null);
  const [confirmation, setConfirmation] = useState<"create" | "end" | null>(null);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const live = useRef(false);
  const generations = useRef({ teachers: 0, schools: 0, memberships: 0 });
  const busy = ["initial", "pending", "unknown", "closed"].includes(operation.status);
  const teachers = pages.teachers?.kind === "teachers" ? pages.teachers.items : [];
  const schools = pages.schools?.kind === "schools" ? pages.schools.items : [];
  const memberships = pages.memberships?.kind === "memberships" ? pages.memberships.items : [];
  const load = async (kind: Kind, after?: string) => {
    const token = ++generations.current[kind];
    setConfirmation(null);
    setPages((p) => ({ ...p, [kind]: undefined }));
    setReading((p) => ({ ...p, [kind]: true }));
    if (kind === "teachers") setTeacher(null);
    if (kind === "schools") setSchool(null);
    if (kind === "memberships") setEnding(null);
    try {
      const params = new URLSearchParams({ kind, ...(after ? { after } : {}) });
      const response = await fetch(`/api/v1/admin/teacher-school-memberships?${params}`, {
        credentials: "same-origin", cache: "no-store", signal: AbortSignal.timeout(10_000),
      });
      if (!live.current || token !== generations.current[kind] || controller.getState().status === "closed") return;
      if ([401, 403].includes(response.status)) return controller.close();
      if (!response.ok) throw new Error("list_failed");
      const parsed = membershipListSchema.safeParse(await response.json());
      if (!parsed.success || parsed.data.kind !== kind) throw new Error("invalid_list");
      if (!live.current || token !== generations.current[kind] || controller.getState().status === "closed") return;
      setPages((p) => ({ ...p, [kind]: parsed.data }));
      setNotices((p) => ({ ...p, [kind]: "" }));
    } catch {
      if (live.current && token === generations.current[kind] && controller.getState().status !== "closed")
        setNotices((p) => ({ ...p, [kind]: "無法讀取目前候選或歸屬；未沿用舊資料，請重新讀取。" }));
    } finally {
      if (live.current && token === generations.current[kind]) setReading((p) => ({ ...p, [kind]: false }));
    }
  };
  useEffect(() => {
    live.current = true;
    const deactivate = controller.activate();
    const unsubscribe = controller.subscribe(() => {
      const next = controller.getState();
      setOperation(next); setConfirmation(null);
      if (["pending", "closed"].includes(next.status)) {
        for (const kind of kinds) ++generations.current[kind];
        setPages({}); setTeacher(null); setSchool(null); setEnding(null); setReading({});
      }
      if (["success", "failed"].includes(next.status)) for (const kind of kinds) void load(kind);
    });
    controller.restore();
    if (controller.getState().status !== "closed") for (const kind of kinds) void load(kind);
    return () => {
      live.current = false; unsubscribe(); deactivate();
      for (const kind of kinds) ++generations.current[kind];
    };
  }, [controller]);
  const open = (kind: "create" | "end", source: HTMLButtonElement) => {
    if (busy) return;
    trigger.current = source; setConfirmation(kind);
  };
  const send = () => {
    if (busy) return;
    let intent: MembershipIntent;
    if (confirmation === "create" && teacher && school) {
      intent = { operation: "create", key: crypto.randomUUID(), body: { teacher_id: teacher.id, school_id: school.id } };
    } else if (confirmation === "end" && ending?.state === "active") {
      intent = { operation: "end", key: crypto.randomUUID(), target: ending.id, body: {} };
    } else return;
    setConfirmation(null); void controller.start(intent);
  };
  if (operation.status === "closed") return <p role="alert">{operation.message}</p>;
  return <section className="card grid gap-3" aria-label="教師學校歸屬">
    <h2>教師學校歸屬</h2>
    <p>歸屬不等於學生查看授權，仍須有效師生綁定與其他全部資格。建立不綁學生、不批准教師或學校、不變更登入。</p>
    <p>本輪新增只開放既有合格教師及已核准、未到期學校；未確認、撤回、到期學校目前不支援新增。結束是收權，不因目標後來失效而阻擋。</p>
    <p role="status">{kinds.map((kind) => notices[kind]).filter(Boolean).join(" ") || operation.message}</p>
    {operation.intent && <p>待確認原意圖：{operation.intent.operation === "create"
      ? `建立；教師 ${operation.intent.body.teacher_id}；學校 ${operation.intent.body.school_id}`
      : `結束；歸屬 ${operation.intent.target}`}。只會原鍵、原本文、原對象重試。</p>}
    {operation.status === "unknown" && <button type="button" onClick={() => void controller.retry()}>以原對象與原鍵重試</button>}
    {operation.receipt && <p data-testid="membership-receipt">原操作 receipt：{operation.receipt.operation === "create" ? "建立" : "結束"}；
      歸屬 {operation.receipt.membership_id}；操作時狀態 {operation.receipt.state}；{operation.receipt.operated_at}。
      不代表目前歸屬或批准。</p>}
    <button type="button" disabled={operation.status === "initial" || operation.status === "pending"}
      onClick={() => { for (const kind of kinds) void load(kind); }}>重新讀取目前歸屬與候選</button>
    <fieldset disabled={busy || reading.teachers || reading.schools}>
      <legend>建立既有教師與學校的歸屬</legend>
      <label>合格教師<select value={teacher?.id ?? ""} onChange={(e) =>
        setTeacher(teachers.find((t) => t.id === e.target.value) ?? null)}>
        <option value="">請選擇教師</option>
        {teachers.map((t) => <option key={t.id} value={t.id}>{t.display_label}｜已批准教師</option>)}
      </select></label>
      <button type="button" disabled={!pages.teachers?.next_cursor}
        onClick={() => void load("teachers", pages.teachers?.next_cursor ?? undefined)}>下一頁教師</button>
      <label>合格學校<select value={school?.id ?? ""} onChange={(e) =>
        setSchool(schools.find((s) => s.id === e.target.value) ?? null)}>
        <option value="">請選擇學校</option>
        {schools.map((s) => <option key={s.id} value={s.id}>{s.display_label}｜已核准且未到期</option>)}
      </select></label>
      <button type="button" disabled={!pages.schools?.next_cursor}
        onClick={() => void load("schools", pages.schools?.next_cursor ?? undefined)}>下一頁學校</button>
      <button type="button" disabled={!teacher || !school}
        onClick={(e) => open("create", e.currentTarget)}>核對並建立歸屬</button>
    </fieldset>
    <fieldset disabled={busy || reading.memberships}>
      <legend>目前歸屬與歷史（active／ended）</legend>
      <p>每頁最多 20 筆，按各資源 ID 穩定排序；ended 保留歷史，重新加入使用新 ID，舊批准不會復活。</p>
      <ul>{memberships.map((m) => <li key={m.id} data-testid={`membership-${m.id}`}>
        {m.teacher_label}｜{m.school_label}｜{m.state === "active" ? "有效 active" : "已結束 ended"}｜{m.id}
      </li>)}</ul>
      <label>要結束的有效歸屬<select value={ending?.id ?? ""} onChange={(e) =>
        setEnding(memberships.find((m) => m.id === e.target.value && m.state === "active") ?? null)}>
        <option value="">請選擇指定歸屬</option>
        {memberships.filter((m) => m.state === "active").map((m) =>
          <option key={m.id} value={m.id}>{m.teacher_label}｜{m.school_label}｜active｜{m.id}</option>)}
      </select></label>
      <button type="button" disabled={!ending} onClick={(e) => open("end", e.currentTarget)}>核對並結束歸屬</button>
      <button type="button" disabled={!pages.memberships?.next_cursor}
        onClick={() => void load("memberships", pages.memberships?.next_cursor ?? undefined)}>下一頁歸屬</button>
    </fieldset>
    <Dialog.Root open={confirmation !== null} onOpenChange={(open) => { if (!open) setConfirmation(null); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className="dialog-content" onCloseAutoFocus={(e) => { e.preventDefault(); trigger.current?.focus(); }}>
          <Dialog.Title>{confirmation === "create" ? "確認建立教師學校歸屬" : "確認結束指定歸屬"}</Dialog.Title>
          <Dialog.Description>
            {confirmation === "create"
              ? `教師：${teacher?.display_label}（${teacher?.id}），已批准；學校：${school?.display_label}（${school?.id}），已核准且未到期。候選為讀取當下狀態，送出會重驗。`
              : `教師：${ending?.teacher_label}（${ending?.teacher_id}）；學校：${ending?.school_label}（${ending?.school_id}）；歸屬：${ending?.id}，目前讀取狀態 active。結束後依此歸屬的舊批准失效，不自動結束師生綁定。`}
          </Dialog.Description>
          <Dialog.Close asChild><button type="button">取消，尚未送出</button></Dialog.Close>
          <button type="button" disabled={busy} onClick={send}>
            {confirmation === "create" ? "明確確認並送出建立" : "明確確認並送出結束"}</button>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  </section>;
}
