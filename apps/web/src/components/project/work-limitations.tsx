"use client";

import { useLayoutEffect } from "react";
import type { WorkEligibilityContext } from "@app-planet/core";
import { useProjectScopeResult } from "./protected-project-view.tsx";
import type { WorkLimitationsState } from "./work-limitations-state";

function blueprintHref(projectId: string): string {
  return `/student/projects/${encodeURIComponent(projectId)}/stages/A%2FB`;
}

function retryHref(projectId: string, purpose: WorkEligibilityContext): string {
  const suffix = purpose === "a1_preview" ? "build" : "publish";
  return `/student/projects/${encodeURIComponent(projectId)}/${suffix}`;
}

function ScopeMessage({
  projectId,
  purpose,
  state,
}: Readonly<{
  projectId: string;
  purpose: WorkEligibilityContext;
  state: WorkLimitationsState;
}>) {
  switch (state.kind) {
    case "within_scope":
      return <p>目前的作品需求符合首版範圍</p>;
    case "requirements_missing":
      return <>
        <p>還沒有保存正式需求。請先到我的藍圖，完成需求保存與 A／B 分類確認。</p>
        <a href={blueprintHref(projectId)}>前往我的藍圖</a>
      </>;
    case "unconfirmed":
      return <>
        <p>正式需求還沒有完成分類確認，現在不能判斷是否符合首版範圍。</p>
        <p>請到我的藍圖，依畫面上的流程確認需求與 A／B 分類。</p>
        <a href={blueprintHref(projectId)}>前往我的藍圖</a>
      </>;
    case "legacy_unverified":
      return <>
        <p>這份舊分類還沒有重新確認，不能當成已通過。</p>
        <p>請到我的藍圖，依目前提供的流程重新確認需求與分類。</p>
        <a href={blueprintHref(projectId)}>前往我的藍圖</a>
      </>;
    case "outside_scope":
      return <>
        {state.blockers.includes("student_server_runtime_not_in_mvp") &&
          <p>首版不會執行需要學生伺服器的程式。已保存的設計與檔案會保留；不會自動刪除需求或改變 A／B 分類。</p>}
        {state.blockers.includes("work_runtime_ai_not_in_mvp") &&
          <p>首版不支援作品執行時使用 AI。已保存的設計與檔案會保留；不會自動刪除需求或改變 A／B 分類。</p>}
        <p>如果要調整，請回到我的藍圖，依現有流程修改並重新確認。</p>
        <a href={blueprintHref(projectId)}>前往我的藍圖</a>
      </>;
    case "public_visitor_identity":
      return <p>首版不提供公開服務：這個作品需要訪客登入、帳號或辨識訪客資料，因此目前不能公開。</p>;
    case "unavailable":
      return <>
        <p role="status">目前無法判斷作品範圍，這不代表作品符合首版範圍。</p>
        <a href={retryHref(projectId, purpose)}>重新載入並再試一次</a>
      </>;
    case "access_closed":
      return null;
  }
}

export function WorkLimitations({
  projectId,
  purpose,
  state,
  resultId,
  requestId,
  accountScope,
}: Readonly<{
  projectId: string;
  purpose: WorkEligibilityContext;
  state: WorkLimitationsState;
  resultId: string;
  requestId: string | null;
  accountScope: string | null;
}>) {
  const reportScope = useProjectScopeResult();
  useLayoutEffect(() => {
    reportScope(projectId, purpose, state, resultId, requestId, accountScope);
  }, [accountScope, projectId, purpose, reportScope, requestId, resultId, state]);

  if (state.kind === "access_closed") return null;
  const isPreview = purpose === "a1_preview";
  return <>
    <section className="card" aria-label="作品範圍說明" data-testid="work-limitations"
      data-scope-state={state.kind} data-scope-request={requestId ?? ""}>
      <h2>作品範圍</h2>
      <ScopeMessage projectId={projectId} purpose={purpose} state={state} />
    </section>
    <section className="card" aria-label="功能開放狀態" data-testid="work-operation-availability">
      <h2>功能開放狀態</h2>
      {isPreview
        ? <>
          <p><strong>預覽功能尚未開放。</strong></p>
          <p>目前不能在瀏覽器執行作品。</p>
        </>
        : <>
          <p><strong>發布功能尚未開放。</strong></p>
          <p>不提供送審、部署或公開網址操作。</p>
        </>}
    </section>
  </>;
}
