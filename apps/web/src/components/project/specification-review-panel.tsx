"use client";
import { productFetch as fetch } from "../auth/product-fetch.ts";

import * as Dialog from "@radix-ui/react-dialog";
import { useEffect, useRef, useState } from "react";
import {
  specificationDetailSchema, specificationStatusSchema, specificationReasonSchema,
  type SpecificationStatus, type SpecificationSubmission,
} from "@app-planet/core";
import { ReviewOperationController, reviewUrl, submissionUrl } from "./review-operation-controller.ts";
import { UnsavedChangesGuard } from "./unsaved-changes-guard.tsx";

const labels = { pending: "待審", approved: "已批准", returned: "已退回", invalidated: "因相依變更／資格變化而不再有效" };
export function SpecificationEvidence({ submission }: { submission: SpecificationSubmission }) {
  return <section className="grid gap-2" aria-label="提交時的確切證據">
    <p>提交識別：{submission.id}；提交時間：{submission.submitted_at}</p>
    <p>Specification 保存版本 {submission.draft_version}；正式需求 revision {submission.requirements_revision}；
      分類確認 ID {submission.classification_id}</p>
    <h3>提交時的 Specification（不是後來編輯的內容）</h3>
    <pre className="whitespace-pre-wrap">{submission.specification.text}</pre>
    <h3>提交時的正式需求</h3>
    <pre className="whitespace-pre-wrap">{submission.requirements.description}</pre>
    <p>執行需求：{submission.requirements.runtime_needs}；作品執行時 AI：{submission.requirements.runtime_ai_required ? "是" : "否"}；
      分類 {submission.classification.tier}；訪客識別：{submission.classification.needs_visitor_identity ? "需要" : "不需要"}</p>
  </section>;
}

type Props = {
  accountScope: string; target: string;
} & ({ mode: "submit"; initial: SpecificationStatus; savedVersion: number | null; blocked: boolean }
  | { mode: "decide"; initial: SpecificationSubmission });

export function SpecificationReviewPanel(props: Props) {
  const [controller] = useState(() => new ReviewOperationController({
    kind: props.mode, target: props.target,
    storageKey: `app-planet:specification:${props.accountScope}:${props.mode}:${props.target}`,
    storage: {
      getItem: (key) => sessionStorage.getItem(key),
      setItem: (key, value) => sessionStorage.setItem(key, value),
      removeItem: (key) => sessionStorage.removeItem(key),
    },
    fetch: (...args) => fetch(...args), uuid: () => crypto.randomUUID(),
  }));
  const [operation, setOperation] = useState(controller.getState);
  const [data, setData] = useState<SpecificationStatus | SpecificationSubmission | null>(props.initial);
  const [reading, setReading] = useState(false);
  const [notice, setNotice] = useState("");
  const [decision, setDecision] = useState<"approved" | "returned" | "">("");
  const [reason, setReason] = useState("");
  const [open, setOpen] = useState(false);
  const [candidate, setCandidate] = useState<unknown>(null);
  const composing = useRef(false);
  const generation = useRef(0);
  const alertRef = useRef<HTMLParagraphElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const isBlocked = props.mode === "submit" && props.blocked;
  const savedVersion = props.mode === "submit" ? props.savedVersion : null;

  const refresh = async () => {
    const token = ++generation.current;
    setOpen(false);
    setCandidate(null);
    setReading(true);
    setData(null);
    try {
      const response = await fetch(props.mode === "submit" ? submissionUrl(props.target) : reviewUrl(props.target), {
        credentials: "same-origin", cache: "no-store", signal: AbortSignal.timeout(10_000),
      });
      if ([401, 403, 404].includes(response.status)) { controller.close(); return; }
      if (!response.ok) throw new Error("read_failed");
      const raw: unknown = await response.json();
      const parsed = props.mode === "submit" ? specificationStatusSchema.safeParse(raw) : specificationDetailSchema.safeParse(raw);
      if (!parsed.success) throw new Error("invalid_read");
      const next = "submission" in parsed.data ? parsed.data.submission : parsed.data;
      if (("project_id" in next && props.mode === "submit" && next.project_id !== props.target) ||
        ("id" in next && props.mode === "decide" && next.id !== props.target)) throw new Error("wrong_resource");
      if (token !== generation.current || controller.getState().status === "closed") return;
      setData(next);
      setNotice("");
    } catch {
      if (token === generation.current) setNotice("目前無法讀取可信審查狀態；不會顯示舊批准為目前有效，請重試。");
    } finally { if (token === generation.current) setReading(false); }
  };
  useEffect(() => {
    const unsubscribe = controller.subscribe(() => {
      const next = controller.getState();
      ++generation.current;
      setReading(false);
      setOperation(next);
      if (["pending", "unknown", "closed", "success"].includes(next.status)) setData(null);
      if (next.status === "success" || next.status === "conflict" || next.status === "failed") void refresh();
    });
    controller.restore();
    return () => { unsubscribe(); ++generation.current; };
  }, [controller]);
  useEffect(() => {
    if (props.mode === "submit" && savedVersion !== props.initial.evidence.draft_version) void refresh();
  }, [savedVersion]);
  useEffect(() => { if (notice || operation.message) alertRef.current?.focus(); }, [notice, operation.message]);

  const latest = data && ("latest" in data ? data.latest : data);
  const evidence = data && "evidence" in data ? data.evidence : null;
  const busy = operation.status === "initial" || operation.status === "pending" || operation.status === "unknown";
  const canSubmit = props.mode === "submit" && !isBlocked && !busy && !reading && evidence &&
    evidence.draft_version !== null && evidence.draft_version === savedVersion &&
    evidence.requirements_revision > 0 && evidence.classification_id !== null &&
    (!latest || latest.state === "returned" || latest.state === "invalidated");
  const canDecide = props.mode === "decide" && !busy && !reading && latest?.state === "pending" && decision &&
    (decision === "approved" || specificationReasonSchema.safeParse(reason).success);
  const guardRetry = async () => {
    await controller.retry();
    return controller.getState().status === "success"
      ? { outcome: "switched" } as const : { outcome: "blocked", reason: "retry_required" } as const;
  };
  if (operation.status === "closed") return <p role="alert">{operation.message}</p>;
  return <section className="card grid gap-3" aria-label="Specification 提交與教師審查">
    <UnsavedChangesGuard
      identity={{ accountScope: props.accountScope, projectId: props.target, resourceId: `specification-${props.mode}` }}
      condition={operation.status === "pending" ? "saving" : operation.status === "unknown" ? "unknown" : "clean"}
      composingRef={composing}
      actions={{ saveThenLeave: async () => ({ outcome: "blocked", reason: "retry_required" }),
        retryThenLeave: guardRetry,
        discardAndLeave: async () => ({ outcome: "switched" }) }}
    />
    <h2>Specification 提交與教師審查</h2>
    <p>僅此保存版本的單階段審查。不推進旅程，不等於 Checkpoint、Final Pack、Agent 執行或發布批准。</p>
    <p ref={alertRef} tabIndex={-1} role="status">{notice || operation.message}</p>
    {operation.status === "unknown" && <button type="button" onClick={() => void controller.retry()}>以原決定與原鍵重試</button>}
    {operation.intent?.kind === "decide" && <p>原決定：{labels[operation.intent.body.decision]}；{operation.intent.body.reason}</p>}
    {reading && <p>正在向伺服器重新確認狀態。</p>}
    {data && <p data-testid="specification-review-state">目前審查狀態：{latest ? labels[latest.state] : "尚未提交"}</p>}
    {latest?.decision && <p>歷史明確決策：{labels[latest.decision.decision]}（{latest.decision.decided_at}）
      {latest.decision.reason && <span>；退回理由：{latest.decision.reason}</span>}
      {latest.state === "invalidated" && "。這筆歷史決策不再有效；條件恢復也不會復活，須重新提交。"}</p>}
    {props.mode === "submit" && <>
      {isBlocked && <p>有未保存編輯或保存尚未核對：請先用上方「保存」完成並核對結果，再送審。</p>}
      {evidence && <p>即將提交：Specification 保存版本 {evidence.draft_version ?? "缺少"}；
        需求 revision {evidence.requirements_revision}；分類確認 ID {evidence.classification_id ?? "缺少"}。</p>}
      {evidence && (!evidence.classification_id || evidence.requirements_revision === 0) &&
        <a href={`/student/projects/${props.target}/stages/A%2FB`}>前往補齊正式需求與分類確認</a>}
      <button ref={triggerRef} type="button" disabled={!canSubmit} onClick={() => {
        if (!canSubmit || !evidence) return;
        setCandidate({ expected_draft_version: evidence.draft_version,
          expected_requirements_revision: evidence.requirements_revision, expected_classification_id: evidence.classification_id });
        setOpen(true);
      }}>提交已保存 Specification 給教師審查</button>
    </>}
    {latest && <SpecificationEvidence submission={latest} />}
    {props.mode === "decide" && latest?.state === "pending" && <fieldset disabled={busy || reading}>
      <legend>明確選擇本筆提交的決策</legend>
      <label><input type="radio" name="specification-decision" checked={decision === "approved"}
        onChange={() => setDecision("approved")} />批准</label>
      <label><input type="radio" name="specification-decision" checked={decision === "returned"}
        onChange={() => setDecision("returned")} />退回</label>
      {decision === "returned" && <label>學生可讀的退回理由
        <textarea value={reason} maxLength={2000} onChange={(event) => setReason(event.target.value)}
          onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }} />
        <span>工程輸入防護：最多 2000 字元，不含控制字元；不是正式配額。</span>
      </label>}
      <button ref={triggerRef} type="button" disabled={!canDecide} onClick={() => {
        if (!canDecide || composing.current) return;
        setCandidate({ decision, reason: decision === "returned" ? reason : null }); setOpen(true);
      }}>核對審查決定</button>
    </fieldset>}
    <button type="button" disabled={busy || reading} onClick={() => void refresh()}>重新讀取審查狀態</button>
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Portal><Dialog.Overlay className="fixed inset-0 bg-slate-950/40" />
        <Dialog.Content onCloseAutoFocus={(event) => {
          event.preventDefault();
          if (!triggerRef.current?.disabled && controller.getState().status !== "closed") triggerRef.current?.focus();
        }} className="fixed left-1/2 top-1/2 grid w-[min(92vw,40rem)] -translate-x-1/2 -translate-y-1/2 gap-4 rounded-2xl bg-white p-6">
          <Dialog.Title>確認送出此筆 {props.mode === "submit" ? "Specification" : "審查決定"}</Dialog.Title>
          <Dialog.Description>{props.mode === "submit"
            ? `明確確認送出已保存版本 ${evidence?.draft_version}、需求 revision ${evidence?.requirements_revision}、分類 ${evidence?.classification_id}；不提交未保存編輯。`
            : `提交識別 ${latest?.id}、保存版本 ${latest?.draft_version}；決定：${decision ? labels[decision] : ""}。${decision === "returned" ? reason : ""}`}</Dialog.Description>
          <button type="button" disabled={busy || reading || isBlocked || !(canSubmit || canDecide)} onClick={() => {
            setOpen(false); void controller.start(candidate);
          }}>確認送出</button>
          <Dialog.Close asChild><button type="button">取消，尚未送出</button></Dialog.Close>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  </section>;
}
