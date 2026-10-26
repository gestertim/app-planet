"use client";

import { useEffect, useRef, useState } from "react";
import { AppShell } from "./app-shell";
import {
  StageDraftSaveController,
  type StageDraftSaveAdapter,
  type StageDraftSaveRequest,
  type StageDraftSaveResponse,
  type StageDraftTarget,
  type StageDraftSwitchChoice,
} from "./project/save-controller";
import type { StageDraftDto } from "@app-planet/core";

const projectA = "95000000-0000-4000-8000-000000000001";
const projectB = "95000000-0000-4000-8000-000000000002";
const initialTarget: StageDraftTarget = { project_id: projectA, stage: "Specification" };
const targets: readonly Readonly<{ value: string; label: string; target: StageDraftTarget }>[] = [
  { value: `${projectA}:Specification`, label: "小小生態觀察｜Specification", target: initialTarget },
  {
    value: `${projectA}:UX/UI`,
    label: "小小生態觀察｜UX/UI",
    target: { project_id: projectA, stage: "UX/UI" },
  },
  {
    value: `${projectB}:Specification`,
    label: "紙飛機風向觀察｜Specification",
    target: { project_id: projectB, stage: "Specification" },
  },
];

interface PendingSimulation {
  request: StageDraftSaveRequest;
  resolve: (response: StageDraftSaveResponse) => void;
}

const initialDraft: StageDraftDto = {
  project_id: projectA,
  stage: "Specification",
  row_version: 2,
  state: "ai_draft",
  content_source: "student_input",
  content: { text: "原有的合成草稿" },
  approved_by: null,
  approved_at: null,
};

function makeDraft(request: StageDraftSaveRequest, version: number, text: string): StageDraftDto {
  return {
    project_id: request.project_id,
    stage: request.stage,
    row_version: version,
    state: "ai_draft",
    content_source: "student_input",
    content: { text },
    approved_by: null,
    approved_at: null,
  };
}

function makeSimulationResponse(
  request: StageDraftSaveRequest,
  mode: "saved" | "failed" | "conflict" | "replayed",
): StageDraftSaveResponse {
  const target = { project_id: request.project_id, stage: request.stage };
  const nextVersion = request.expected_row_version === null ? 0 : request.expected_row_version + 1;
  if (mode === "failed") {
    return { target, result: { outcome: "failed", reason: "dependency_failure" } };
  }
  if (mode === "conflict") {
    return {
      target,
      result: {
        outcome: "conflict",
        reason: "version_conflict",
        conflict: {
          current: { version: request.expected_row_version === null ? 0 : request.expected_row_version + 1,
            content: { text: "另一個模擬版本" } },
          submitted: {
            version: request.expected_row_version,
            content: { text: request.content.text },
          },
        },
      },
    };
  }
  const operation = makeDraft(request, nextVersion, request.content.text);
  if (mode === "saved") return { target, result: { outcome: "saved", operation } };
  return {
    target,
    result: {
      outcome: "replayed",
      operation,
      current_draft: {
        outcome: "found",
        draft: makeDraft(request, nextVersion + 2, "較新的模擬 current"),
      },
    },
  };
}

function operationMessage(state: ReturnType<StageDraftSaveController["getState"]>): string {
  switch (state.operation.status) {
    case "idle":
      return "目前沒有保存操作。";
    case "saving":
      return "模擬保存中；你仍可繼續編輯，已送出的快照不會改變。";
    case "saved":
      return `模擬保存成功：此操作確認版本 ${state.operation.receipt.row_version}。`;
    case "replayed":
      return `模擬重播 receipt 版本 ${state.operation.receipt.row_version}；` +
        (state.operation.currentDraft
          ? `current 版本 ${state.operation.currentDraft.row_version}。`
          : "未取得可用 current，不以 receipt 當成目前草稿。");
    case "conflict":
      return `模擬版本衝突：伺服器 current 版本 ${state.operation.conflict.current.version ?? "無草稿"}，` +
        `本次 submitted 版本 ${state.operation.conflict.submitted.version ?? "首次保存"}；本地文字仍保留。`;
    case "failed":
      if (state.operation.reason === "outcome_unknown") {
        return "模擬保存結果尚不確定；保留原操作，可用同一快照與操作鍵明確重試。";
      }
      return "模擬保存失敗；本地編輯保留，沒有顯示為已保存。";
  }
}

export function StageDraftSaveSimulation() {
  const [pending, setPending] = useState<PendingSimulation | null>(null);
  const [requestedTarget, setRequestedTarget] = useState<StageDraftTarget | null>(null);
  const [notice, setNotice] = useState("");
  const switchDecisionSequence = useRef(0);
  const adapter: StageDraftSaveAdapter = {
    save(request) {
      return new Promise((resolve) => setPending({ request, resolve }));
    },
  };
  const [controller] = useState(() => new StageDraftSaveController({
    adapter,
    initialTarget,
    initialDraft,
  }));
  const [state, setState] = useState(() => controller.getState());

  useEffect(() => controller.subscribe(() => setState(controller.getState())), [controller]);

  function selectTarget(value: string) {
    const next = targets.find((entry) => entry.value === value)?.target;
    if (!next) return;
    switchDecisionSequence.current += 1;
    if (state.dirty || state.operation.status === "conflict") {
      void controller.requestSwitch(next, "keep_and_stay");
      setRequestedTarget(next);
      return;
    }
    setRequestedTarget(null);
    void controller.requestSwitch(next, "keep_and_stay");
  }

  async function decideSwitch(choice: StageDraftSwitchChoice) {
    if (!requestedTarget) return;
    const decisionSequence = ++switchDecisionSequence.current;
    const result = await controller.requestSwitch(requestedTarget, choice);
    if (decisionSequence !== switchDecisionSequence.current) return;
    if (result.outcome === "switched") {
      setNotice("已切換展示中的記憶體資源；沒有呼叫資料服務。");
      setRequestedTarget(null);
    } else if (result.outcome === "kept") {
      setNotice("保留目前編輯，沒有切換。");
      setRequestedTarget(null);
    } else if (result.outcome === "superseded") {
      setNotice("此切換意圖已由較新的選擇取代；已送出的模擬保存仍會獨立完成。");
    } else {
      setNotice("目前不能切換；請先解決保存中、失敗、衝突或仍未保存的內容。");
    }
  }

  function completeSimulation(mode: "saved" | "failed" | "conflict" | "replayed") {
    if (!pending) return;
    pending.resolve(makeSimulationResponse(pending.request, mode));
    setPending(null);
  }

  const activeValue = `${state.target.project_id}:${state.target.stage}`;
  const operation = state.operation;
  const retryable = operation.status === "failed" && operation.retryable;
  const hasConflict = operation.status === "conflict";

  return (
    <AppShell
      heading="保存流程模擬"
      subtitle="只使用本頁記憶體與合成 adapter；重新整理會清除編輯，沒有資料庫保存。"
    >
      <div className="save-simulation">
        <section className="card save-simulation-warning" aria-label="模擬範圍">
          <span className="sample-label">獨立模擬入口｜非正式產品操作</span>
          <p>
            本頁不連接登入、HTTP、Server Action 或資料庫。以下「成功／失敗／衝突／重播」都是你手動選擇的合成回應，
            不代表已保存至資料庫。
          </p>
        </section>

        <section className="card save-simulation-editor" aria-labelledby="save-simulation-heading">
          <div className="save-simulation-toolbar">
            <label>
              <span>專案／階段</span>
              <select
                aria-label="選擇模擬專案與階段"
                onChange={(event) => selectTarget(event.currentTarget.value)}
                value={requestedTarget
                  ? `${requestedTarget.project_id}:${requestedTarget.stage}`
                  : activeValue}
              >
                {targets.map((entry) => (
                  <option key={entry.value} value={entry.value}>{entry.label}</option>
                ))}
              </select>
            </label>
            <span className={state.dirty ? "status save-status-dirty" : "status"}>
              {state.dirty ? "有未保存的記憶體修改" : "與最近確認內容一致"}
            </span>
          </div>
          {requestedTarget && (
            <div className="save-switch-prompt" role="group" aria-label="未保存內容的切換選擇">
              <p>目前有未保存內容。請明確選擇如何處理：</p>
              <div className="action-list">
                <button type="button" onClick={() => void decideSwitch("save_then_switch")}>
                  保存後切換
                </button>
                <button type="button" onClick={() => void decideSwitch("keep_and_stay")}>
                  保留並暫不切換
                </button>
                <button type="button" onClick={() => void decideSwitch("discard_and_switch")}>
                  放棄後切換
                </button>
              </div>
            </div>
          )}

          <h2 id="save-simulation-heading">草稿編輯</h2>
          <p>最近確認的伺服器草稿：{state.confirmedDraft
            ? `版本 ${state.confirmedDraft.row_version}`
            : "尚無草稿"}</p>
          <textarea
            aria-label="階段草稿文字"
            onChange={(event) => controller.edit(event.currentTarget.value)}
            rows={8}
            value={state.editorText}
          />
          <div className="action-list">
            <button
              type="button"
              onClick={() => void controller.save()}
              disabled={Boolean(pending) || retryable || hasConflict ||
                (!state.dirty && state.confirmedDraft !== null)}
            >
              模擬保存
            </button>
            {retryable && (
              <button type="button" onClick={() => void controller.retry()} disabled={Boolean(pending)}>
                使用原操作鍵重試
              </button>
            )}
          </div>
          <p className="save-operation-status" role="status" aria-live="polite">
            {operationMessage(state)}
          </p>

          {hasConflict && (
            <div className="save-conflict-controls" aria-label="處理模擬版本衝突">
              <p>不會自動合併或覆寫；請明確選擇保留本地或採用 current。</p>
              <div className="action-list">
                <button type="button" onClick={() => controller.resolveConflict("keep_local")}>
                  保留本地並使用 current 版本重新保存
                </button>
                <button type="button" onClick={() => controller.resolveConflict("use_current")}>
                  明確採用 current 內容
                </button>
              </div>
            </div>
          )}
        </section>

        {pending && (
          <section className="card save-simulation-pending" aria-labelledby="simulation-response-heading">
            <h2 id="simulation-response-heading">選擇本次合成 adapter 回應</h2>
            <p>
              保存中的提交快照固定為「{pending.request.content.text === ""
                ? "（空文字）"
                : pending.request.content.text}」。你可以先回到上方繼續編輯。
            </p>
            <div className="action-list">
              <button type="button" onClick={() => completeSimulation("saved")}>模擬保存成功</button>
              <button type="button" onClick={() => completeSimulation("failed")}>模擬保存失敗／結果不確定</button>
              <button type="button" onClick={() => completeSimulation("conflict")}>模擬保存衝突</button>
              <button type="button" onClick={() => completeSimulation("replayed")}>模擬重播 receipt／current</button>
            </div>
          </section>
        )}

        {notice && <p className="save-simulation-notice" role="status">{notice}</p>}
      </div>
    </AppShell>
  );
}
