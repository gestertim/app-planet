"use client";
import { productFetch } from "../auth/product-fetch.ts";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { evaluateWorkEligibility, type ProjectClassificationCurrent } from "@app-planet/core";
import { useProjectAccessLost } from "./protected-project-view.tsx";
import { UnsavedChangesGuard, type GuardCondition, type GuardResult } from "./unsaved-changes-guard.tsx";
import { classificationIntentSchema, createClassificationTransport, RequirementsController } from "./requirements-controller.ts";

export function ProjectRequirementsPanel({ initial, accountScope }: Readonly<{
  initial: ProjectClassificationCurrent; accountScope: string;
}>) {
  const storageKey = `app-planet.classification.${accountScope}.${initial.id}`;
  const [controller] = useState(() => new RequirementsController(initial,
    createClassificationTransport(initial.id, productFetch), (intent) => {
      if (intent) {
        const raw = JSON.stringify(intent);
        sessionStorage.setItem(storageKey, raw);
        if (sessionStorage.getItem(storageKey) !== raw) throw new Error("原操作保存無法驗證");
      } else {
        sessionStorage.removeItem(storageKey);
        if (sessionStorage.getItem(storageKey) !== null) throw new Error("原操作清理無法驗證");
      }
    }));
  const [state, setState] = useState(controller.getState);
  const [ready, setReady] = useState(false);
  const [storageError, setStorageError] = useState(false);
  const [tier, setTier] = useState<"A" | "B" | null>(null);
  const [visitor, setVisitor] = useState<boolean | null>(null);
  const [explicitChange, setExplicitChange] = useState(false);
  const composingRef = useRef(false);
  const noticeRef = useRef<HTMLParagraphElement>(null);
  const accessLost = useProjectAccessLost();
  const router = useRouter();
  useEffect(() => controller.subscribe(() => setState(controller.getState())), [controller]);
  useEffect(() => {
    try {
      const raw = sessionStorage.getItem(storageKey);
      if (raw !== null) {
        const parsed = classificationIntentSchema.safeParse(JSON.parse(raw));
        if (!parsed.success || parsed.data.projectId !== initial.id) throw new Error("原操作紀錄無效");
        controller.restore(parsed.data);
      }
      setReady(true);
    } catch { setStorageError(true); }
  }, [controller, initial.id, storageKey]);
  useEffect(() => {
    if (state.status === "closed") accessLost();
    if (["conflict", "rejected", "unknown", "unavailable"].includes(state.status)) noticeRef.current?.focus();
  }, [state.status, accessLost]);
  useEffect(() => {
    if (state.receipt && state.status === "idle") router.refresh();
  }, [state.receipt, router]);

  const dirty = controller.dirty;
  const condition: GuardCondition = state.status === "saving" ? "saving" :
    state.intent ? "unknown" : state.status === "conflict" ? "conflict" : dirty ? "dirty" : "clean";
  const leave = async (retry: boolean): Promise<GuardResult> => {
    if (state.status === "saving") return { outcome: "blocked", reason: "saving" };
    const success = retry ? await controller.retry() : await controller.save();
    return success && !controller.dirty ? { outcome: "switched" } :
      { outcome: "blocked", reason: "save_failed" };
  };
  const saved = state.current.requirements;
  const unverified = state.status === "saving" || state.status === "unknown" || state.status === "unavailable";
  const statusText = unverified ? "當前需求／分類尚待核對；摘要僅為上次可信讀取，不代表本次操作成功。"
    : state.current.classification_state === "confirmed"
    ? `當前正式分類已確認：${state.current.tier}（需求版本 ${state.current.requirements_revision}）。`
    : state.current.classification_state === "legacy_unverified"
      ? "歷史 legacy_unverified：舊分類未驗證，不能當有效正式分類。"
      : saved === null ? "尚無正式需求。"
        : state.current.requirements_revision > 1
          ? "需求已保存；先前分類確認（若有）已失效，目前未確認。"
          : "需求已保存；正式分類尚未確認。";
  const eligibility = state.current.classification_state === "confirmed" && saved
    ? evaluateWorkEligibility({
      tier: state.current.tier, runtimeNeeds: saved.runtime_needs,
      requiresVisitorIdentity: state.current.needs_visitor_identity,
      runtimeAiRequired: saved.runtime_ai_required, context: "public",
    }) : null;
  const canConfirm = ready && !storageError && controller.canConfirm(tier, visitor, explicitChange);
  const busy = state.status === "saving";
  const edit = (patch: Partial<typeof state.editor>) => controller.edit({ ...state.editor, ...patch });

  if (state.status === "closed") return <p role="alert">
    失權後需求與確認內容已隱藏；原未知操作仍按帳號隔離保留，不代表未提交。
  </p>;

  return <section className="card grid gap-4" aria-label="正式需求與 A/B 分類">
    <UnsavedChangesGuard
      identity={{ accountScope, projectId: initial.id, resourceId: "formal-requirements" }}
      condition={condition}
      composingRef={composingRef}
      actions={{
        saveThenLeave: () => leave(false), retryThenLeave: () => leave(true),
        discardAndLeave: async () => {
          return controller.discard() ? { outcome: "switched" } : { outcome: "blocked", reason: "saving" };
        },
      }}
    />
    <h2>正式需求與 A/B 分類</h2>
    <p>下方是正式需求資源，不是階段草稿。不會自動帶入草稿；保存需求不等於學生階段確認、正式分類確認或老師批准。</p>
    <p data-testid="formal-classification-current" data-state={unverified ? state.status : state.current.classification_state}>{statusText}</p>
    <p>教師／管理員批准：尚未取得。分類不表示作品完成、階段完成、可部署或 Gate 通過。</p>
    <p ref={noticeRef} tabIndex={-1} role={state.status === "idle" ? "status" : "alert"}
      data-testid="formal-operation-status">{storageError ? "無法讀取原操作紀錄；已停止送出，請保留紀錄並請老師協助。" : state.message}</p>
    {state.reading && <p role="status">正在讀取當前需求與分類；仍可繼續編輯，尚未採用回應。</p>}
    <label>正式需求說明
      <textarea className="min-h-32 w-full rounded border p-2" value={state.editor.description}
        onChange={(event) => edit({ description: event.target.value })}
        onCompositionStart={() => { composingRef.current = true; }}
        onCompositionEnd={() => { composingRef.current = false; }}
        onBlur={() => { composingRef.current = false; }} />
    </label>
    <label>作品執行需求
      <select aria-label="作品執行需求" value={state.editor.runtime_needs} onChange={(event) => {
        const value = event.target.value;
        if (value === "static" || value === "work_data_api" || value === "restricted_server") edit({ runtime_needs: value });
      }}>
        <option value="static">靜態作品：畫面與互動，不使用平台資料服務（A）</option>
        <option value="work_data_api">平台資料服務：保存或讀取作品資料（B）</option>
        <option value="restricted_server">需要自己寫伺服器程式（首版不支援）</option>
      </select>
    </label>
    <label>作品執行時需要 AI
      <select aria-label="作品執行時需要 AI" value={String(state.editor.runtime_ai_required)}
        onChange={(event) => edit({ runtime_ai_required: event.target.value === "true" })}>
        <option value="false">不需要：作品執行時不呼叫 AI</option>
        <option value="true">需要：作品執行時會呼叫 AI（首版不支援）</option>
      </select>
    </label>
    <p>例如：使用平台 AI 幫你創作，不等於作品執行時需要 AI。請如實描述；不支援的需求仍可保存，但不能確認分類。</p>
    <div className="flex flex-wrap gap-3">
      <button type="button" disabled={!ready || storageError || busy || !!state.intent}
        onClick={() => { if (!composingRef.current) void controller.save(); }}>保存正式需求</button>
      {state.intent && <button type="button" disabled={!ready || busy}
        onClick={() => void controller.retry()}>使用原操作鍵重試需求／分類</button>}
      <button type="button" disabled={!ready || busy || state.reading} onClick={() => void controller.refresh()}>
        重新讀取需求與分類（保留本地編輯）
      </button>
      {state.status === "conflict" && <button type="button" disabled={!ready || state.reading}
        onClick={() => void controller.refresh(true)}>
        放棄本地需求並採用當前版本
      </button>}
    </div>
    {state.receipt && <p data-testid="formal-operation-receipt">
      原操作 receipt：{state.receipt.outcome}、需求版本 {state.receipt.requirements_revision}、
      專案版本 {state.receipt.row_version}；這不是當前分類或操作授權。
    </p>}
    <section className="grid gap-3 rounded border p-3" aria-label="明確確認正式分類">
      <h3>確認前核對已保存正式需求</h3>
      <p data-testid="formal-saved-summary">需求版本 {state.current.requirements_revision}；
        專案版本 {state.current.row_version}；已保存原文：{saved?.description ?? "尚無"}；
        執行需求：{saved?.runtime_needs ?? "尚無"}；執行時 AI：{saved ? String(saved.runtime_ai_required) : "尚無"}</p>
      {dirty && <p>本地需求尚未保存，不能確認分類。</p>}
      <label>正式 A/B 分類
        <select aria-label="正式 A/B 分類" value={tier ?? ""} onChange={(event) => {
          const value = event.target.value;
          setTier(value === "A" || value === "B" ? value : null);
          setExplicitChange(false);
        }}>
          <option value="">請明確選擇 A 或 B</option>
          <option value="A">A：靜態作品</option>
          <option value="B">B：使用平台資料服務</option>
        </select>
      </label>
      <label>需要識別訪客身分嗎
        <select aria-label="需要識別訪客身分嗎" value={visitor === null ? "" : String(visitor)} onChange={(event) =>
          setVisitor(event.target.value === "" ? null : event.target.value === "true")}>
          <option value="">請明確選擇，不會預設為不需要</option>
          <option value="false">不需要：不辨認是哪位訪客</option>
          <option value="true">需要：需要辨認不同訪客（公開能力尚不支援）</option>
        </select>
      </label>
      <p>建立專案時偏好：{state.current.requested_tier ?? "未指定"}；本次選擇：{tier ?? "尚未選擇"}；
        訪客識別：{visitor === null ? "尚未明選" : visitor ? "需要" : "不需要"}。</p>
      {tier && state.current.requested_tier && tier !== state.current.requested_tier &&
        <label><input type="checkbox" checked={explicitChange}
          onChange={(event) => setExplicitChange(event.target.checked)} />
          我明確確認：本次分類與建立專案時的偏好不同（explicit_change）
        </label>}
      {saved && (saved.runtime_needs === "restricted_server" || saved.runtime_ai_required) &&
        <p role="alert">已保存的真實需求包含首版不支援能力，不能確認 A/B；不會自動修改需求以通過。</p>}
      {visitor === true && <p>可如實記錄訪客識別需求；這不代表已取得公開資格或已開放訪客功能。</p>}
      {eligibility && !eligibility.withinMvpSupport && <p role="alert">
        分類有確認紀錄，但目前不符合公開作品支援範圍；沒有發布授權。
      </p>}
      <button type="button" disabled={!canConfirm} onClick={() => {
        if (tier && !composingRef.current) void controller.confirm(tier, visitor, explicitChange);
      }}>明確確認正式分類</button>
    </section>
  </section>;
}
