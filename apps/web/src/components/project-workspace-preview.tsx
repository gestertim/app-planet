"use client";

import { useRef, useState, type KeyboardEvent } from "react";
import { projectStageSchema } from "@app-planet/core";
import { ClosedAction } from "./operation-state";
import {
  assessmentMessages,
  classificationLabel,
  draftLabel,
  projectWorkspaceTabs,
  requirementsLabel,
  resultMessage,
  type ProjectWorkspacePreviewScenario,
  type ProjectWorkspaceTabId,
} from "./project-workspace-preview-model";
import type { OwnedProjectWorkspaceDto } from "../server/project-workspace";

const stageNames = projectStageSchema.options;

const closedActions = [
  "保存內容",
  "確認分類",
  "批准階段",
  "前往下一階段",
  "開始 AI 對話",
  "建立或執行 App",
  "執行測試",
  "恢復版本",
  "預覽作品",
  "提交審查",
  "發布或部署",
] as const;

function WorkspaceSummary({
  scenario,
  workspace,
}: Readonly<{
  scenario: ProjectWorkspacePreviewScenario;
  workspace: OwnedProjectWorkspaceDto;
}>) {
  return (
    <>
      <section aria-label="專案共同脈絡" className="workspace-shared grid">
        <article className="card">
          <span className="sample-label">合成專案</span>
          <h2>{workspace.project.title}</h2>
          <p>目前階段：{workspace.project.stage}</p>
          <p className="muted">專案資料版本：{workspace.project.row_version}</p>
          <p className="status">{classificationLabel(workspace.classification)}</p>
          <h3>需求摘要</h3>
          <p className="muted">
            {requirementsLabel(workspace)}
            {workspace.requirements !== null && `｜${workspace.requirements.content.description}`}
          </p>
        </article>
        <article className="card">
          <h2>指定階段評估</h2>
          <AssessmentSummary scenario={scenario} />
        </article>
      </section>
      <section aria-labelledby="workspace-drafts-heading" className="card workspace-drafts">
        <h2 id="workspace-drafts-heading">九階段草稿（唯讀）</h2>
        <p className="muted">
          草稿階段與上方七個頁籤分開顯示，不代表階段已完成或獲准操作。
        </p>
        <div className="workspace-draft-list">
          {stageNames.map((stage) => {
            const draft = workspace.drafts.find((entry) => entry.stage === stage);
            return (
              <article className="workspace-draft" key={stage}>
                <div className="workspace-draft-heading">
                  <h3>{stage}</h3>
                  <span className="status">{draftLabel(draft)}</span>
                </div>
                {draft && (
                  <>
                    <p className="muted">文字來源：學生提交｜尚未確認</p>
                    <pre className="workspace-draft-text">
                      {draft.content.text === "" ? "（已保存空白文字）" : draft.content.text}
                    </pre>
                  </>
                )}
              </article>
            );
          })}
        </div>
      </section>
    </>
  );
}

function AssessmentSummary({
  scenario,
}: Readonly<{ scenario: ProjectWorkspacePreviewScenario }>) {
  const result = scenario.assessmentResult;
  if (result.outcome !== "evaluated") {
    return <p className="muted">{resultMessage(result)}</p>;
  }
  return (
    <>
      <p>指定階段：{result.assessment.requested_stage}</p>
      <ul>
        {assessmentMessages(result).map((message) => <li key={message}>{message}</li>)}
      </ul>
      <p className="muted">評估只描述合成資料，不代表階段完成或取得操作許可。</p>
    </>
  );
}

function WorkspaceTabs({
  scenario,
  selectedTab,
  onSelectTab,
}: Readonly<{
  scenario: ProjectWorkspacePreviewScenario;
  selectedTab: ProjectWorkspaceTabId;
  onSelectTab: (tab: ProjectWorkspaceTabId) => void;
}>) {
  const tabButtons = useRef<(HTMLButtonElement | null)[]>([]);

  function handleKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    const currentIndex = projectWorkspaceTabs.findIndex(
      (tab) => `workspace-tab-${tab.id}` === event.currentTarget.id,
    );
    let nextIndex: number | null = null;
    if (event.key === "ArrowRight") nextIndex = (currentIndex + 1) % projectWorkspaceTabs.length;
    if (event.key === "ArrowLeft") {
      nextIndex = (currentIndex - 1 + projectWorkspaceTabs.length) % projectWorkspaceTabs.length;
    }
    if (event.key === "Home") nextIndex = 0;
    if (event.key === "End") nextIndex = projectWorkspaceTabs.length - 1;
    if (nextIndex !== null) {
      event.preventDefault();
      onSelectTab(projectWorkspaceTabs[nextIndex].id);
      tabButtons.current[nextIndex]?.focus();
    }
  }

  const selected = projectWorkspaceTabs.find((tab) => tab.id === selectedTab);
  const projectIsReadable = scenario.workspaceResult.outcome === "found";

  return (
    <>
      <div aria-label="專案工作區頁籤" className="workspace-tabs" role="tablist">
        {projectWorkspaceTabs.map((tab) => (
          <button
            aria-controls="workspace-tab-panel"
            aria-selected={tab.id === selectedTab}
            className="workspace-tab"
            id={`workspace-tab-${tab.id}`}
            key={tab.id}
            onClick={() => onSelectTab(tab.id)}
            onKeyDown={handleKeyDown}
            ref={(element) => { tabButtons.current[projectWorkspaceTabs.indexOf(tab)] = element; }}
            role="tab"
            tabIndex={tab.id === selectedTab ? 0 : -1}
            type="button"
          >
            {tab.label}
          </button>
        ))}
      </div>
      <section
        aria-labelledby={`workspace-tab-${selectedTab}`}
        className="card workspace-tab-panel"
        id="workspace-tab-panel"
        role="tabpanel"
        tabIndex={0}
      >
        <h2>{selected?.label ?? "工作區"}</h2>
        <p>
          {projectIsReadable
            ? `「${selected?.label ?? "此"}」頁籤尚未開放。選取頁籤不會改變目前階段，也不表示已進入或完成階段。`
            : "目前無法顯示專案內容；此情境不會保留其他專案的可讀資料。"}
        </p>
      </section>
    </>
  );
}

function WorkspaceScenario({
  scenario,
  scenarios,
  onScenarioChange,
}: Readonly<{
  scenario: ProjectWorkspacePreviewScenario;
  scenarios: readonly ProjectWorkspacePreviewScenario[];
  onScenarioChange: (scenarioId: string) => void;
}>) {
  const [selectedTab, setSelectedTab] = useState<ProjectWorkspaceTabId>("blueprint");
  const workspaceResult = scenario.workspaceResult;
  const readableWorkspace = workspaceResult.outcome === "found" ? workspaceResult.workspace : null;

  function selectTab(tab: ProjectWorkspaceTabId) {
    setSelectedTab(tab);
  }

  return (
    <section className="workspace-preview">
      <div className="workspace-preview-heading">
        <div>
          <span className="sample-label">
            合成資料／介面預覽，未連接登入或資料服務
          </span>
          <p className="muted">切換情境只改變本頁展示，不會切換帳號或恢復資料。</p>
        </div>
        <label className="workspace-scenario-picker">
          <span>展示情境</span>
          <ScenarioPicker
            currentScenarioId={scenario.id}
            onChange={onScenarioChange}
            scenarios={scenarios}
          />
        </label>
      </div>
      {readableWorkspace ? (
        <WorkspaceSummary scenario={scenario} workspace={readableWorkspace} />
      ) : (
        <section aria-live="polite" className="card workspace-result-message" role="status">
          <h2>{resultMessage(workspaceResult)}</h2>
          <p>目前情境沒有可顯示的專案資料。</p>
        </section>
      )}
      <WorkspaceTabs
        onSelectTab={selectTab}
        scenario={scenario}
        selectedTab={selectedTab}
      />
      <section aria-labelledby="workspace-actions-heading" className="card workspace-actions">
        <h2 id="workspace-actions-heading">產品操作</h2>
        <p className="muted">這些操作在本機介面預覽中全部關閉。</p>
        <div className="action-list">
          {closedActions.map((label) => <ClosedAction key={label} label={label} />)}
        </div>
      </section>
    </section>
  );
}

function ScenarioPicker({
  currentScenarioId,
  onChange,
  scenarios,
}: Readonly<{
  currentScenarioId: string;
  onChange: (scenarioId: string) => void;
  scenarios: readonly ProjectWorkspacePreviewScenario[];
}>) {
  return (
    <select
      aria-label="切換合成專案情境"
      onChange={(event) => onChange(event.currentTarget.value)}
      value={currentScenarioId}
    >
      {scenarios.map((scenario) => (
        <option key={scenario.id} value={scenario.id}>{scenario.label}</option>
      ))}
    </select>
  );
}

export function ProjectWorkspacePreview({
  scenarios,
}: Readonly<{ scenarios: readonly ProjectWorkspacePreviewScenario[] }>) {
  const [selectedScenarioId, setSelectedScenarioId] = useState(scenarios[0]?.id ?? "");
  const selectedScenario = scenarios.find((scenario) => scenario.id === selectedScenarioId);
  if (!selectedScenario) {
    return <p className="muted">目前沒有可用的合成展示情境。</p>;
  }

  function onScenarioChange(scenarioId: string) {
    const nextScenario = scenarios.find((scenario) => scenario.id === scenarioId);
    if (nextScenario) setSelectedScenarioId(nextScenario.id);
  }

  return (
    <WorkspaceScenario
      key={selectedScenario.id}
      onScenarioChange={onScenarioChange}
      scenario={selectedScenario}
      scenarios={scenarios}
    />
  );
}
