import React from "react";
import { CREATION_FLOW_STAGES, type CreationFlowAssessment, type WorkEligibilityReason } from "@app-planet/core";
import type { CreationFlowPageResult } from "../../server/creation-flow-page-data.ts";

type Evaluated = Extract<CreationFlowAssessment, { outcome: "evaluated" }>;
const reasonText: Record<WorkEligibilityReason, string> = {
  invalid_input: "目前執行需求資料無法判讀，請重新核對正式需求。",
  inconsistent_input: "分類與執行需求不一致，請重新核對正式需求與分類。",
  tier_b_needs_visitor_identity: "需要識別訪客的 B 級作品，首版不提供公開服務。",
  student_server_runtime_not_in_mvp: "首版不支援作品執行自己的伺服器程式。",
  work_runtime_ai_not_in_mvp: "首版不支援作品在執行時呼叫生成式 AI。",
};
const decisionText: Record<Extract<Evaluated["stage_assessment"], { outcome: "unsupported" }>["unresolved_decisions"][number], string> = {
  stage_completion_policy: "每個階段需要哪些證據才能完成。",
  six_to_nine_stage_mapping: "簡化旅程摘要如何對應九個階段。",
  approval_evidence_contract: "人工批准需要綁定哪些版本與證據。",
  specification_sync_evidence_contract: "規格同步需要哪些證據。",
  approved_task_scope_mapping: "本次批准範圍要包含哪些任務。",
  review_evidence_contract: "審查需要哪些紀錄。",
};

export function CreationFlowCheck({ projectId, result }: Readonly<{
  projectId: string;
  result: CreationFlowPageResult;
}>) {
  const base = `/student/projects/${projectId}`;
  const stageHref = (stage: string) => `${base}/stages/${encodeURIComponent(stage)}`;
  const assessment = result.outcome === "evaluated" ? result.assessment : null;
  const retryHref = assessment
    ? `${base}?requested_stage=${encodeURIComponent(assessment.requested_stage)}` : base;
  return <section className="card grid gap-4" aria-label="檢查目標階段" data-testid="creation-flow-check">
    <h2>檢查目標階段</h2>
    <p>選擇你準備進行的階段，只會重新讀取檢查，不會切換專案階段或修改版本。</p>
    <nav aria-label="選擇檢查目標階段"><ol>
      {CREATION_FLOW_STAGES.map((stage) => <li key={stage}>
        <a href={`${base}?requested_stage=${encodeURIComponent(stage)}`}
          aria-current={assessment?.requested_stage === stage ? "true" : undefined}>檢查 {stage}</a>
      </li>)}
    </ol></nav>
    {result.outcome !== "evaluated" ? <p role="alert" data-testid="creation-flow-error">
      {result.outcome === "invalid_selection"
        ? "檢查網址不正確。只能選擇九個階段之一，不能附帶角色、批准或其他判斷資料。請重新選擇。"
        : result.outcome === "failed"
          ? "目前無法讀取本次檢查資料；評估內容已隱藏，請重試。"
          : "找不到這個專案，或目前帳號已無檢視權限；評估內容已隱藏。"}
    </p> : <div data-testid="creation-flow-result">
      <p>專案目前階段：{result.assessment.current_stage}；本次檢查目標：{result.assessment.requested_stage}。</p>
      <p>本次檢查讀到的專案版本：{result.row_version}；需求版本：{result.requirements_revision}。</p>
      <p>本區的資料來自伺服器同一次資料庫查詢。專案脈絡、藍圖與九階段總覽各自另行讀取，
        可能不是同一時點；不合併作為完整通關證據。</p>
      <h3>正式需求與分類確認</h3>
      <p data-testid="creation-flow-classification">{result.assessment.classification_assessment.outcome === "satisfied"
        ? `目前有有效的學生 ${result.assessment.classification_assessment.tier} 級分類確認（需求版本 ${result.assessment.classification_assessment.requirements_revision}）。這不是老師或管理員的人工批准。`
        : result.requirements_revision === 0
          ? "尚無正式需求，也沒有有效的學生分類確認。請先保存需求，再明確確認 A 或 B。"
          : "需求已有保存，但目前沒有有效的學生分類確認；修改需求後，先前確認不再有效。請重新核對 A 或 B。"}</p>
      <a href={stageHref("A/B")}>前往 A/B 補齊正式需求與分類確認</a>
      <h3>作品執行需求的支援範圍</h3>
      <p data-testid="creation-flow-work-scope">{result.assessment.work_scope_assessment.outcome === "satisfied"
        ? "目前已確認的作品執行需求在本次評估支援範圍內。"
        : result.assessment.work_scope_assessment.outcome === "missing_evidence"
          ? "缺少目前有效的分類確認，尚不能判斷支援範圍；這不表示需求已獲支援。"
          : result.assessment.work_scope_assessment.outcome === "invalid_evidence"
            ? "執行需求與分類證據不一致，無法採用本次支援判斷。"
            : "目前作品執行需求不在支援範圍內。"}</p>
      {["unsupported", "invalid_evidence"].includes(result.assessment.work_scope_assessment.outcome) &&
        "reasons" in result.assessment.work_scope_assessment
        ? <ul>{result.assessment.work_scope_assessment.reasons.map((reason) => <li key={reason}>{reasonText[reason]}</li>)}</ul> : null}
      <p>這是私人作品執行需求的範圍檢查，不是公開資格，也不授予 AI、Agent、預覽、發布或部署權限。</p>
      <h3>先前階段順序</h3>
      <p>以下只是九階段中排在目標之前的順序，不是已核定的逐階段通關規則。</p>
      {result.assessment.requested_stage_prerequisites.length === 0 ? <p>這個目標前面沒有其他階段。</p>
        : <ol data-testid="creation-flow-prerequisites">{result.assessment.requested_stage_prerequisites.map((stage) =>
          <li key={stage}><a href={stageHref(stage)}>編輯 {stage}</a></li>)}</ol>}
      <a href={stageHref(result.assessment.requested_stage)}>編輯目標階段：{result.assessment.requested_stage}</a>
      <h3>已保存草稿的觀察</h3>
      <p>本次 reader 只提供草稿存在、未確認草稿狀態與學生輸入來源；
        沒有提供學生階段確認或人工批准證據，不從草稿存在推導確認、批准或完成。</p>
      {result.assessment.observed_drafts.length === 0 ? <p>本次讀取尚無已保存內容；這不代表失敗或未完成。</p>
        : <ul data-testid="creation-flow-drafts">{result.assessment.observed_drafts.map((draft) =>
          <li key={draft.stage}>{draft.stage}：觀察到已保存的學生輸入草稿，不能據此判定階段完成。</li>)}</ul>}
      <h3>目前還不能判定的事項</h3>
      {result.assessment.stage_assessment.outcome === "missing_evidence"
        ? <p>本次階段判斷缺少有效的正式分類確認。補齊確認仍不表示完成或人工批准；
          完成與批准規則仍待決議。</p>
        : <><p>階段完成規則尚未決議，因此本次無法判定目標階段是否完成或可推進。</p>
          <ul>{result.assessment.stage_assessment.unresolved_decisions.map((decision) =>
            <li key={decision}>{decisionText[decision]}</li>)}</ul></>}
    </div>}
    <a href={retryHref}>重新檢查目標階段</a>
    <p>保存或確認後，請回到總覽選擇目標或重新檢查；本次結果不會被保存為完成結論。</p>
  </section>;
}
