"use client";

import { useMemo, useRef, useState, type ChangeEvent } from "react";
import type { GuidedIdea } from "./student/guided-idea";
import {
  createSyntheticTeacherDemoDraft,
  createTeacherDemoVersion,
  restoreTeacherDemoVersion,
  validateTeacherDemoIdea,
  validateTeacherDemoSampleContent,
  type TeacherDemoDraft,
  type TeacherDemoVersion,
} from "./pilot30-teacher-demo-model";
import styles from "./pilot30-teacher-demo.module.css";

const steps = ["確認藍圖", "建立與預覽", "保存與還原"] as const;

export function TeacherDemo() {
  const [draft, setDraft] = useState(createSyntheticTeacherDemoDraft);
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [appCreated, setAppCreated] = useState(false);
  const [selectedItemIndex, setSelectedItemIndex] = useState(-1);
  const [versions, setVersions] = useState<readonly TeacherDemoVersion[]>([]);
  const [selectedVersionId, setSelectedVersionId] = useState("");
  const [status, setStatus] = useState("先檢查合成藍圖，再建立固定範本。");
  const nextVersion = useRef(1);
  const ideaValidation = useMemo(() => validateTeacherDemoIdea(draft.idea), [draft.idea]);
  const contentValidation = useMemo(
    () => validateTeacherDemoSampleContent(draft.sampleContent),
    [draft.sampleContent],
  );

  const updateIdea = (field: "name" | "audience" | "problem", value: string) => {
    setDraft((current) => ({ ...current, idea: { ...current.idea, [field]: value } }));
  };

  const updateFeature = (index: number, value: string) => {
    setDraft((current) => ({
      ...current,
      idea: {
        ...current.idea,
        features: current.idea.features.map((feature, featureIndex) =>
          featureIndex === index ? value : feature),
      },
    }));
  };

  const addFeature = () => {
    setDraft((current) => current.idea.features.length >= 3 ? current : ({
      ...current,
      idea: { ...current.idea, features: [...current.idea.features, ""] },
    }));
  };

  const removeFeature = (index: number) => {
    setDraft((current) => ({
      ...current,
      idea: {
        ...current.idea,
        features: current.idea.features.filter((_, featureIndex) => featureIndex !== index),
      },
    }));
  };

  const updateSampleContent = (event: ChangeEvent<HTMLTextAreaElement>) => {
    setSelectedItemIndex(-1);
    setDraft((current) => ({ ...current, sampleContent: event.target.value }));
  };

  const createApp = () => {
    if (!ideaValidation.valid) {
      setStatus(ideaValidation.message);
      return;
    }
    setAppCreated(true);
    setStatus("固定 React 示範範本已建立；沒有呼叫 AI、API、Auth 或資料庫。");
  };

  const saveVersion = () => {
    if (!ideaValidation.valid || !contentValidation.valid || !appCreated) return;
    const id = `demo-v${nextVersion.current}`;
    nextVersion.current += 1;
    const version = createTeacherDemoVersion(draft, id, new Date().toISOString());
    setVersions((current) => [...current, version]);
    setSelectedVersionId(id);
    setStatus(`${id} 已保存至本頁記憶體；重新整理後暫存可能消失。`);
  };

  const restoreSelectedVersion = () => {
    const version = versions.find((candidate) => candidate.id === selectedVersionId);
    if (!version) return;
    setDraft(restoreTeacherDemoVersion(version));
    setSelectedItemIndex(-1);
    setStatus(`${version.id} 已還原；預覽已同步，舊版本快照不會被修改。`);
  };

  const pickedItem = contentValidation.valid && selectedItemIndex >= 0
    ? contentValidation.items[selectedItemIndex % contentValidation.items.length] ?? ""
    : "";

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <a className={styles.brand} href="/pilot30/teacher-demo">
          <span className={styles.brandMark} aria-hidden="true">AP</span>
          <span><strong>AI APP 超級創客</strong><small>App Planet · Chat. Create. Launch.</small></span>
        </a>
        <span className={styles.mode}>本機教師示範</span>
      </header>

      <main className={styles.main}>
        <section className={styles.intro} aria-labelledby="pilot30-title">
          <p className={styles.eyebrow}>PILOT30 · TEACHER DEMO</p>
          <h1 id="pilot30-title">把點子變成可操作的示範 App</h1>
          <p>這是封閉的本機教學示範，不是正式教師帳號、學生作品或公開課堂入口。</p>
          <p className={styles.notice}>
            本機教師示範／合成資料／非 AI 生成／重新整理後示範暫存可能消失。
          </p>
          <p className={styles.limits}>
            不連外、不使用真實 Auth／資料庫／API；預覽是固定 React 範本，不是隔離 App Sandbox。
            AI 功能未開放。此示範不保存學生個資，也不會改動正式作品。
          </p>
        </section>

        <ol className={styles.stepper} aria-label="教師示範創作階段">
          {steps.map((label, index) => {
            const number = index + 1;
            return (
              <li key={label} aria-current={step === number ? "step" : undefined}>
                <span>{number}</span>{label}
              </li>
            );
          })}
        </ol>

        <div className={styles.workspace}>
          <section className={styles.editor} aria-labelledby="stage-title">
            {step === 1 && <BlueprintEditor
              idea={draft.idea}
              onTextChange={updateIdea}
              onFeatureChange={updateFeature}
              onAddFeature={addFeature}
              onRemoveFeature={removeFeature}
              validation={ideaValidation}
              onNext={() => setStep(2)}
            />}
            {step === 2 && <TemplateSetup
              draft={draft}
              appCreated={appCreated}
              ideaValid={ideaValidation.valid}
              contentValidation={contentValidation}
              onSampleContentChange={updateSampleContent}
              onCreateApp={createApp}
              onBack={() => setStep(1)}
              onNext={() => setStep(3)}
            />}
            {step === 3 && <VersionPanel
              versions={versions}
              selectedVersionId={selectedVersionId}
              canSave={appCreated && ideaValidation.valid && contentValidation.valid}
              onSelect={setSelectedVersionId}
              onSave={saveVersion}
              onRestore={restoreSelectedVersion}
              onBack={() => setStep(2)}
            />}
          </section>

          <TeacherDemoPreview
            idea={draft.idea}
            created={appCreated}
            items={contentValidation.valid ? contentValidation.items : []}
            pickedItem={pickedItem}
            contentError={contentValidation.valid ? "" : contentValidation.message}
            onPick={() => {
              if (contentValidation.valid) {
                setSelectedItemIndex((current) => (current + 1) % contentValidation.items.length);
              }
            }}
          />
        </div>
        <p className={styles.liveStatus} role="status" aria-live="polite">{status}</p>
        <p className={styles.footerNote}>
          這個固定範本只示範清單挑選互動；藍圖功能文字會顯示在預覽中，但不會自動變成可執行功能。
          「下課玩什麼？」是合成教學例子，不是所有學生的指定作品。
        </p>
      </main>
    </div>
  );
}

function BlueprintEditor({
  idea,
  onTextChange,
  onFeatureChange,
  onAddFeature,
  onRemoveFeature,
  validation,
  onNext,
}: Readonly<{
  idea: GuidedIdea;
  onTextChange: (field: "name" | "audience" | "problem", value: string) => void;
  onFeatureChange: (index: number, value: string) => void;
  onAddFeature: () => void;
  onRemoveFeature: (index: number) => void;
  validation: ReturnType<typeof validateTeacherDemoIdea>;
  onNext: () => void;
}>) {
  return (
    <>
      <p className={styles.eyebrow}>第 1 步 · 合成示例，可自行修改</p>
      <h2 id="stage-title">確認藍圖</h2>
      <p className={styles.help}>請用不含姓名、電話、地址或班級的合成資料練習。</p>
      <label className={styles.field}>
        App 名稱
        <input value={idea.name} maxLength={60} onChange={(event) => onTextChange("name", event.target.value)} />
      </label>
      <label className={styles.field}>
        使用者
        <input value={idea.audience} maxLength={120} onChange={(event) => onTextChange("audience", event.target.value)} />
      </label>
      <label className={styles.field}>
        用途／要解決的問題
        <textarea rows={3} value={idea.problem} maxLength={160}
          onChange={(event) => onTextChange("problem", event.target.value)} />
      </label>
      <fieldset className={styles.features}>
        <legend>核心功能（最多 3 項）</legend>
        {idea.features.map((feature, index) => (
          <div className={styles.featureRow} key={index}>
            <label htmlFor={`pilot30-feature-${index}`}>功能 {index + 1}</label>
            <input id={`pilot30-feature-${index}`} value={feature} maxLength={100}
              onChange={(event) => onFeatureChange(index, event.target.value)} />
            <button type="button" className={styles.secondaryButton} onClick={() => onRemoveFeature(index)}>
              移除
            </button>
          </div>
        ))}
        <button type="button" className={styles.secondaryButton} onClick={onAddFeature}
          disabled={idea.features.length >= 3}>＋ 增加功能</button>
      </fieldset>
      {!validation.valid && <p className={styles.error} role="alert">{validation.message}</p>}
      <div className={styles.actions}>
        <button type="button" className={styles.primaryButton} onClick={onNext} disabled={!validation.valid}>
          下一步：設定範本
        </button>
      </div>
    </>
  );
}

function TemplateSetup({
  draft,
  appCreated,
  ideaValid,
  contentValidation,
  onSampleContentChange,
  onCreateApp,
  onBack,
  onNext,
}: Readonly<{
  draft: TeacherDemoDraft;
  appCreated: boolean;
  ideaValid: boolean;
  contentValidation: ReturnType<typeof validateTeacherDemoSampleContent>;
  onSampleContentChange: (event: ChangeEvent<HTMLTextAreaElement>) => void;
  onCreateApp: () => void;
  onBack: () => void;
  onNext: () => void;
}>) {
  return (
    <>
      <p className={styles.eyebrow}>第 2 步 · 固定 React 範本</p>
      <h2 id="stage-title">建立與預覽</h2>
      <p className={styles.help}>可改清單內容，右側 Preview 會同步更新；文字不會被當成程式執行。</p>
      <label className={styles.field}>
        示範清單（每行一個項目，最多 8 個）
        <textarea rows={6} value={draft.sampleContent} onChange={onSampleContentChange} />
      </label>
      {!contentValidation.valid && <p className={styles.error} role="alert">{contentValidation.message}</p>}
      {!ideaValid && <p className={styles.error} role="alert">藍圖有錯誤，請回上一步修正後再建立。</p>}
      <div className={styles.actions}>
        <button type="button" className={styles.secondaryButton} onClick={onBack}>上一階段</button>
        <button type="button" className={styles.primaryButton} onClick={onCreateApp}
          disabled={!ideaValid || !contentValidation.valid || appCreated}>
          {appCreated ? "固定示範 App 已建立" : "建立示範 App"}
        </button>
        <button type="button" className={styles.secondaryButton} onClick={onNext} disabled={!appCreated}>
          下一步：保存版本
        </button>
      </div>
    </>
  );
}

function VersionPanel({
  versions,
  selectedVersionId,
  canSave,
  onSelect,
  onSave,
  onRestore,
  onBack,
}: Readonly<{
  versions: readonly TeacherDemoVersion[];
  selectedVersionId: string;
  canSave: boolean;
  onSelect: (id: string) => void;
  onSave: () => void;
  onRestore: () => void;
  onBack: () => void;
}>) {
  return (
    <>
      <p className={styles.eyebrow}>第 3 步 · 本頁記憶體</p>
      <h2 id="stage-title">保存與還原</h2>
      <p className={styles.help}>每次保存都建立獨立快照；還原不會改寫其他版本。</p>
      <div className={styles.actions}>
        <button type="button" className={styles.primaryButton} onClick={onSave} disabled={!canSave}>
          保存目前示範版本
        </button>
        <button type="button" className={styles.secondaryButton} onClick={onRestore}
          disabled={!versions.some((version) => version.id === selectedVersionId)}>
          還原選取版本
        </button>
        <button type="button" className={styles.secondaryButton} onClick={onBack}>上一階段</button>
      </div>
      {versions.length === 0
        ? <p className={styles.emptyState}>還沒有保存版本。建立示範 App 後，按「保存目前示範版本」。</p>
        : <fieldset className={styles.versionList}>
          <legend>選擇要還原的版本</legend>
          {versions.map((version, index) => (
            <label key={version.id} className={styles.versionItem}>
              <input type="radio" name="pilot30-version" value={version.id}
                checked={selectedVersionId === version.id} onChange={() => onSelect(version.id)} />
              <span><strong>{version.id}</strong> · {new Date(version.savedAt).toLocaleString("zh-TW")}</span>
              <small>{version.draft.idea.name} · 第 {index + 1} 個快照</small>
            </label>
          ))}
        </fieldset>}
    </>
  );
}

export function TeacherDemoPreview({
  idea,
  created,
  items,
  pickedItem,
  contentError,
  onPick,
}: Readonly<{
  idea: GuidedIdea;
  created: boolean;
  items: readonly string[];
  pickedItem: string;
  contentError: string;
  onPick: () => void;
}>) {
  return (
    <section className={styles.preview} aria-labelledby="preview-title">
      <div className={styles.previewHeading}>
        <div><p className={styles.eyebrow}>PREVIEW · 本機固定範本</p><h2 id="preview-title">示範 App 預覽</h2></div>
        <span className={styles.previewTag}>不執行使用者程式碼</span>
      </div>
      {!created
        ? <p className={styles.emptyState}>完成藍圖後，按「建立示範 App」即可查看互動預覽。</p>
        : <div className={styles.appPreview}>
          <header><span>DEMO APP</span><h3>{idea.name}</h3><p>為{idea.audience}準備的示範</p></header>
          <section aria-label="用途與核心功能">
            <p>{idea.problem}</p>
            <h4>藍圖中的核心功能</h4>
            <ul>{idea.features.map((feature, index) =>
              <li key={`${index}-${feature}`}>{feature}</li>)}</ul>
            <p className={styles.previewDisclaimer}>以上功能文字僅呈現於畫面，未被自動建置成對應功能。</p>
          </section>
          <section className={styles.interaction} aria-label="清單挑選互動">
            <h4>下課遊戲清單</h4>
            {items.length > 0
              ? <ul>{items.map((item, index) => <li key={`${index}-${item}`}>{item}</li>)}</ul>
              : <p className={styles.error}>{contentError || "清單目前沒有可預覽的項目。"}</p>}
            <button type="button" className={styles.primaryButton} onClick={onPick} disabled={items.length === 0}>
              幫我挑一個
            </button>
            <p className={styles.pickResult} role="status" aria-live="polite">
              {pickedItem ? `這次先試試看：${pickedItem}` : "尚未挑選"}
            </p>
          </section>
          <p className={styles.previewDisclaimer}>本機示範 Preview；不是正式建置結果或隔離 App Sandbox。</p>
        </div>}
    </section>
  );
}
