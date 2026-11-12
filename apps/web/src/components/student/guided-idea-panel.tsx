"use client";

import type { GuidedIdeaAction, GuidedIdeaFlow } from "./guided-idea";
import { canContinueGuidedIdea } from "./guided-idea";
import styles from "./creation-space.module.css";

export function GuidedIdeaPanel({
  flow,
  error,
  carried,
  disabled,
  onAction,
  onPreview,
  onCarry,
  onCancel,
}: Readonly<{
  flow: GuidedIdeaFlow;
  error: string;
  carried: boolean;
  disabled: boolean;
  onAction: (action: GuidedIdeaAction) => void;
  onPreview: () => void;
  onCarry: () => void;
  onCancel: () => void;
}>) {
  const step = flow.step;
  const stepNumber = step === "preview" ? 3 : step;
  const canContinue = canContinueGuidedIdea(flow);

  return (
    <section className={styles.guidedPanel} aria-labelledby="guided-idea-title" data-testid="guided-idea-panel">
      <div className={styles.guidedHeading}>
        <div>
          <p className={styles.eyebrow}>App 點子產生器・三步驟引導・AI 功能尚未啟用</p>
          <h2 id="guided-idea-title">{step === "preview" ? "我的 App 點子卡" : `第 ${step} 題，共 3 題`}</h2>
        </div>
        <button type="button" className={styles.secondaryButton} disabled={disabled} onClick={onCancel}>取消引導</button>
      </div>
      <ol className={styles.progress} aria-label={`目前第 ${stepNumber} 題，共 3 題`}>
        {([1, 2, 3] as const).map((number) =>
          <li key={number} aria-current={step === number ? "step" : undefined}
            className={number <= stepNumber ? styles.progressDone : undefined}>
            第 {number} 題
          </li>)}
      </ol>

      {step === 1 && <div className={styles.question}>
        <label htmlFor="guided-idea-audience">你想幫誰？</label>
        <p id="guided-idea-audience-help">可以是自己、同學、家人或某一群人；請不要填真實姓名、電話、地址或班級。</p>
        <textarea id="guided-idea-audience" rows={3} value={flow.idea.audience}
          aria-describedby="guided-idea-audience-help" autoFocus
          disabled={disabled}
          placeholder="例如：想幫助常常找不到東西的同學"
          onChange={(event) => onAction({ type: "set_text", field: "audience", value: event.target.value })} />
        <div className={styles.guidedActions}>
          <button type="button" disabled={disabled || !canContinue} onClick={() => onAction({ type: "next" })}>下一題</button>
        </div>
      </div>}

      {step === 2 && <div className={styles.question}>
        <label htmlFor="guided-idea-problem">想解決什麼問題？</label>
        <p id="guided-idea-problem-help">想想這些人遇到什麼不方便，或有什麼事情可以變得更好。</p>
        <textarea id="guided-idea-problem" rows={3} value={flow.idea.problem}
          aria-describedby="guided-idea-problem-help" autoFocus
          disabled={disabled}
          placeholder="寫下你觀察到的小麻煩"
          onChange={(event) => onAction({ type: "set_text", field: "problem", value: event.target.value })} />
        <div className={styles.guidedActions}>
          <button type="button" className={styles.secondaryButton} disabled={disabled} onClick={() => onAction({ type: "back" })}>上一步</button>
          <button type="button" disabled={disabled || !canContinue} onClick={() => onAction({ type: "next" })}>下一題</button>
        </div>
      </div>}

      {step === 3 && <div className={styles.question}>
        <h3 id="guided-idea-features-title">App 想做哪三件事？</h3>
        <p id="guided-idea-features-help">先想一到三個重要功能就好；至少填一項，不需要一次想得很完整。</p>
        <div className={styles.featureFields} aria-describedby="guided-idea-features-help">
          {flow.idea.features.map((feature, index) =>
            <div className={styles.featureField} key={index}>
              <label htmlFor={`guided-idea-feature-${index}`}>主要功能 {index + 1}</label>
              <input id={`guided-idea-feature-${index}`} value={feature} disabled={disabled}
                placeholder={`例如：${index === 0 ? "記錄物品放在哪裡" : "提醒要做的小事"}`}
                onChange={(event) => onAction({ type: "set_feature", index, value: event.target.value })} />
              {flow.idea.features.length > 1 &&
                <button type="button" className={styles.removeFeature}
                  disabled={disabled}
                  aria-label={`移除主要功能 ${index + 1}`}
                  onClick={() => onAction({ type: "remove_feature", index })}>移除</button>}
            </div>)}
        </div>
        <div className={styles.guidedActions}>
          <button type="button" className={styles.secondaryButton} disabled={disabled} onClick={() => onAction({ type: "back" })}>上一步</button>
          <button type="button" className={styles.secondaryButton}
            disabled={disabled || flow.idea.features.length >= 3}
            onClick={() => onAction({ type: "add_feature" })}>＋ 增加功能</button>
          <button type="button" disabled={disabled || !canContinue} onClick={onPreview}>預覽點子卡</button>
        </div>
        {error && <p role="alert" className={styles.guideError}>{error}</p>}
      </div>}

      {step === "preview" && <div className={styles.question}>
        <label htmlFor="guided-idea-name">App 暫定名稱（可留白，稍後也能修改）</label>
        <input id="guided-idea-name" value={flow.idea.name} autoFocus disabled={disabled}
          placeholder="還沒想到名稱也沒關係"
          onChange={(event) => onAction({ type: "set_text", field: "name", value: event.target.value })} />
        <article className={styles.ideaCard} aria-label="點子卡預覽">
          <h3>我的 App 點子</h3>
          <p><strong>App 名稱：</strong>{flow.idea.name.trim()
            ? flow.idea.name
            : "尚未填寫（請在既有建立專案表單輸入）"}</p>
          <p><strong>想幫助的人：</strong>{flow.idea.audience}</p>
          <p><strong>想解決的問題：</strong>{flow.idea.problem}</p>
          <div><strong>主要功能：</strong>
            <ol>{flow.idea.features.filter((feature) => feature.trim()).map((feature, index) =>
              <li key={index}>{feature}</li>)}</ol>
          </div>
        </article>
        <div className={styles.editAnswers} aria-label="修改點子卡回答">
          {([1, 2, 3] as const).map((number) =>
            <button type="button" key={number} className={styles.secondaryButton}
              disabled={disabled}
              onClick={() => onAction({ type: "edit", step: number })}>
              修改第 {number} 題
            </button>)}
        </div>
        {error && <p role="alert" className={styles.guideError}>{error}</p>}
        {flow.confirmed
          ? <p role="status" aria-live="polite" className={styles.guideStatus}>
            點子卡已確認；尚未建立專案、儲存到伺服器或啟動 AI。
          </p>
          : <p className={styles.guideStatus}>請檢查這張卡。確認只代表你接受內容，不會建立或保存專案。</p>}
        <div className={styles.guidedActions}>
          <button type="button" className={styles.secondaryButton} disabled={disabled} onClick={() => onAction({ type: "back" })}>回上一題</button>
          {!flow.confirmed
            ? <button type="button" disabled={disabled} onClick={() => onAction({ type: "confirm" })}>確認這張點子卡</button>
            : <button type="button" disabled={disabled || carried} onClick={onCarry}>
              {carried ? "已帶入建立專案表單" : "帶入既有建立專案表單"}
            </button>}
        </div>
      </div>}
      <p className={styles.guideFootnote} role="status" aria-live="polite">
        回答只保留在目前頁面記憶體；未保存，重新載入或離開後可能遺失。
      </p>
    </section>
  );
}
