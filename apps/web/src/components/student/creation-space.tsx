"use client";

import * as Dialog from "@radix-ui/react-dialog";
import { useCallback, useReducer, useRef, useState, type FocusEvent, type MouseEvent } from "react";
import Link from "next/link";
import { ClosedAction, OperationNotice } from "@/components/operation-state";
import { CreateProjectForm } from "../project/create-project-form";
import { ideaDraftHandoff, validateIdeaDraft } from "../project/idea-draft-handoff";
import {
  createGuidedIdeaFlow,
  formatGuidedIdeaCard,
  guidedIdeaReducer,
  hasGuidedIdeaAnswers,
  type GuidedIdeaAction,
} from "./guided-idea";
import { GuidedIdeaPanel } from "./guided-idea-panel";
import styles from "./creation-space.module.css";

const guides = [
  { title: "我還沒有點子", tool: "App 點子產生器", icon: "☀", tone: "idea",
    description: "一起從生活中找靈感，先想一個小問題。",
    prompt: "我還沒有點子。我想從生活中找靈感，先想想可以解決什麼小問題。" },
  { title: "我想開始做 App", tool: "AI App 超級創客 v5", icon: "✳", tone: "maker",
    description: "把你的想法寫下來，想想 App 要幫誰。",
    prompt: "我想開始做 App。我的點子是：我想幫助的對象是：" },
  { title: "我想學會新知識", tool: "萬能教師", icon: "◇", tone: "learn",
    description: "不懂的地方，放心問！先寫下想學的主題。",
    prompt: "我想學會新知識。我想學的主題是：我目前知道的是：" },
] as const;

export function StudentCreationSpace({ children, storageScope }: Readonly<{
  children: React.ReactNode;
  storageScope: string;
}>) {
  const [draft, setDraft] = useState("");
  const [carry, setCarry] = useState(false);
  const [guidedCarry, setGuidedCarry] = useState(false);
  const [bound, setBound] = useState(false);
  const [carryMessage, setCarryMessage] = useState("");
  const [selected, setSelected] = useState<number | null>(null);
  const [guidedOpen, setGuidedOpen] = useState(false);
  const [guidedFlow, dispatchGuided] = useReducer(guidedIdeaReducer, undefined, createGuidedIdeaFlow);
  const [guidedError, setGuidedError] = useState("");
  const [pendingGuideAction, setPendingGuideAction] = useState<
    "start" | "cancel" | Readonly<{ kind: "select"; index: number }> | null
  >(null);
  const [destination, setDestination] = useState<HTMLAnchorElement | null>(null);
  const [portal, setPortal] = useState<HTMLDivElement | null>(null);
  const space = useRef<HTMLDivElement | null>(null);
  const bypass = useRef(false);
  const autoNavigationAllowed = useRef(true);
  const opener = useRef<HTMLAnchorElement | null>(null);
  const editor = useRef<HTMLTextAreaElement>(null);
  const mountSpace = useCallback((element: HTMLDivElement | null) => {
    space.current = element;
    setPortal(element);
  }, []);
  const hasDraft = draft.length > 0;
  const hasGuidedAnswers = hasGuidedIdeaAnswers(guidedFlow.idea);
  const hasUncommittedContent = hasDraft || (guidedOpen && hasGuidedAnswers);
  const revealFocus = (event: FocusEvent<HTMLDivElement>) => {
    const target = event.target;
    if (!target.matches("a, button, textarea, input, select")) return;
    // 瀏覽器可能只捲到 textarea 的游標行；在其預設捲動後讓整個焦點盒留白可見。
    requestAnimationFrame(() => {
      if (!target.isConnected || target.closest("[hidden]") || document.activeElement !== target) return;
      const rect = target.getBoundingClientRect();
      if (rect.top < 8 || rect.bottom > window.innerHeight - 8)
        target.scrollIntoView({ block: "nearest", inline: "nearest" });
    });
  };
  const protectNavigation = (event: MouseEvent<HTMLDivElement>) => {
    if (bypass.current || !hasUncommittedContent || event.defaultPrevented || event.button !== 0 ||
      event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const anchor = event.target instanceof Element ? event.target.closest("a[href]") : null;
    if (!(anchor instanceof HTMLAnchorElement) || anchor.hasAttribute("download") ||
      (anchor.target && anchor.target !== "_self")) return;
    const target = new URL(anchor.href);
    const current = new URL(window.location.href);
    if (target.origin === current.origin && target.pathname === current.pathname &&
      target.search === current.search) return;
    event.preventDefault();
    event.stopPropagation();
    opener.current = anchor;
    setDestination(anchor);
  };
  const leave = () => {
    if (!destination?.isConnected || space.current?.closest("[hidden]")) return;
    autoNavigationAllowed.current = false;
    ideaDraftHandoff.cancel(storageScope);
    setDestination(null);
    setDraft("");
    setCarry(false);
    setGuidedCarry(false);
    setBound(false);
    setCarryMessage("");
    setGuidedOpen(false);
    dispatchGuided({ type: "reset" });
    // 重送原控制項的點擊，沿用 Link 導覽，不另建路由機制。
    bypass.current = true;
    destination.click();
    bypass.current = false;
  };
  const startGuidedIdea = () => {
    dispatchGuided({ type: "reset" });
    setGuidedError("");
    setGuidedOpen(true);
    setSelected(0);
  };
  const selectStandardGuide = (index: number) => {
    setGuidedOpen(false);
    setGuidedCarry(false);
    dispatchGuided({ type: "reset" });
    setGuidedError("");
    setSelected(index);
    setDraft((current) => current.length === 0 ? guides[index].prompt : current);
    editor.current?.focus();
  };
  const selectGuide = (index: number) => {
    if (index === 0) {
      if (guidedOpen) return;
      if (hasDraft) setPendingGuideAction("start");
      else startGuidedIdea();
      return;
    }
    if (guidedOpen) {
      if (hasGuidedAnswers) setPendingGuideAction({ kind: "select", index });
      else selectStandardGuide(index);
      return;
    }
    selectStandardGuide(index);
  };
  const cancelGuidedIdea = () => {
    if (hasGuidedAnswers) setPendingGuideAction("cancel");
    else {
      setGuidedOpen(false);
      setSelected(null);
    }
  };
  const finishGuideAction = () => {
    const action = pendingGuideAction;
    setPendingGuideAction(null);
    if (action === "start") {
      startGuidedIdea();
      return;
    }
    if (action === "cancel") {
      setGuidedOpen(false);
      setSelected(null);
      dispatchGuided({ type: "reset" });
      setGuidedCarry(false);
      if (!carry) setCarryMessage("");
      return;
    }
    if (action?.kind === "select") selectStandardGuide(action.index);
  };
  const updateGuidedIdea = (action: GuidedIdeaAction) => {
    if (action.type === "confirm") {
      const result = formatGuidedIdeaCard(guidedFlow.idea);
      if (result.outcome !== "ready") {
        setGuidedError(result.outcome === "too_large"
          ? "點子卡超過既有保存的 64 KiB JSON UTF-8 上限；請縮短名稱或回答。"
          : result.outcome === "invalid"
            ? "點子卡含無法精確保存的字元；請檢查名稱或回答。"
            : "請完成三題並至少填寫一項主要功能。");
        return;
      }
      setGuidedError("");
      dispatchGuided(action);
      return;
    }
    if (action.type !== "reset") {
      setGuidedCarry(false);
      if (!carry) setCarryMessage("");
      setGuidedError("");
    }
    dispatchGuided(action);
  };
  const previewGuidedIdea = () => {
    const result = formatGuidedIdeaCard(guidedFlow.idea);
    if (result.outcome === "ready") {
      setGuidedError("");
      dispatchGuided({ type: "preview" });
    } else {
      setGuidedError(result.outcome === "too_large"
        ? "點子卡超過既有保存的 64 KiB JSON UTF-8 上限；請縮短回答後再預覽。"
        : result.outcome === "invalid"
          ? "點子卡含無法精確保存的字元；請檢查回答後再試。"
          : "請先回答前面的問題，並至少填寫一項主要功能。");
    }
  };
  const carryGuidedIdea = () => {
    if (!guidedFlow.confirmed) return;
    const result = formatGuidedIdeaCard(guidedFlow.idea);
    if (result.outcome !== "ready") {
      setGuidedError("點子卡目前無法安全帶入；請檢查回答並重新確認。");
      return;
    }
    setCarry(false);
    setGuidedCarry(true);
    setCarryMessage("已確認的點子卡已帶入記憶體中的建立專案流程；尚未建立或保存。請在既有表單確認專案名稱並按「建立專案」。");
    document.getElementById("project-title")?.focus();
  };

  return <div className={styles.frame}><div className={styles.space} data-testid="student-creation-space"
    ref={mountSpace} onClickCapture={protectNavigation} onFocusCapture={revealFocus}>
    <a className={styles.skip} href="#student-main">跳到創作空間內容</a>
    <aside className={styles.sidebar}>
      <Link href="/" className={styles.brand} aria-label="App Planet 首頁">
        <span className={styles.logo} aria-hidden="true">RAE<span>✦</span></span>
        <span><strong>AI APP 超級創客</strong><b>App Planet</b><small>Chat. Create. Launch.</small></span>
      </Link>
      <ClosedAction label="＋ 新對話" />
      <nav aria-label="學生主導覽" className={styles.nav}>
        <a href="#student-main" aria-current="page">✦ 創作空間</a>
        <a href="#my-projects">▦ 我的專案</a>
        <ClosedAction label="檔案庫" />
      </nav>
      <p className={styles.sectionLabel}>我的創作工具・本頁引導</p>
      <div className={styles.tools}>{guides.map((guide, index) =>
        <button type="button" key={guide.tool} disabled={bound} onClick={() => selectGuide(index)}
          aria-label={`${guide.tool}：帶入草稿引導`}>
          <span aria-hidden="true">{guide.icon}</span>{guide.tool}
        </button>)}</div>
      <p className={styles.sidebarNote}>引導只協助你寫點子草稿。<br />AI、對話歷史與創作額度尚未開放；不顯示模擬紀錄或額度。</p>
      <Link className={styles.homeLink} href="/" prefetch={false}>回到首頁與其他登入入口</Link>
    </aside>
    <div className={styles.body}>
      <header className={styles.topbar}>
        <span>我的創作空間</span>
        <div><span className={styles.session}>已驗證工作階段</span><ClosedAction label="使用指南" /></div>
      </header>
      <main id="student-main" tabIndex={-1} className={styles.main}>
        <section className={styles.welcome} aria-labelledby="welcome-title">
          <div>
            <p className={styles.eyebrow}>你好，小小創客 ✦</p>
            <h1 id="welcome-title">嗨，小創客！<br />今天想把什麼<span>點子變成 App？</span></h1>
            <p>從一個「如果可以⋯」開始，寫下你的靈感、問題或想學的事。<br />你的下一個厲害作品，就從這裡起步。</p>
          </div>
          <div className={styles.robot} aria-hidden="true">
            <div className={styles.robotHead}><div className={styles.robotFace}>● ●</div><i /></div>
            <span>一起找個好點子！ ✦</span>
          </div>
        </section>
        <section className={styles.composer} aria-label="本頁點子草稿">
          <label htmlFor="student-idea">我的點子草稿</label>
          <textarea id="student-idea" ref={editor} value={draft} disabled={bound} onChange={(event) => setDraft(event.target.value)}
            aria-describedby="student-draft-help student-guide-status"
            placeholder="說說你的點子，或寫下任何關於 App 的問題⋯" rows={3} />
          <div className={styles.composerActions}>
            <ClosedAction label="＋ 附件" /><ClosedAction label="啟用 Skill" /><ClosedAction label="送出點子" />
            <button type="button" disabled={carry || guidedCarry || bound || guidedOpen} onClick={() => {
              const validation = validateIdeaDraft(draft);
              if (validation !== "valid") {
                setCarryMessage(validation === "too_large"
                  ? "點子超過既有保存的 64 KiB JSON UTF-8 上限；請縮短原文，不會截斷或建立專案。"
                  : "點子含無法精確保存的字元；請檢查內容，不會建立專案。");
                return;
              }
              setCarry(true);
              setCarryMessage("已選擇帶入；尚未建立或保存。請在下方輸入專案名稱，再按「建立專案」。");
              document.getElementById("project-title")?.focus();
            }}>將點子帶入新專案</button>
            {(carry || guidedCarry) && <button type="button" disabled={bound} onClick={() => {
              if (guidedCarry) {
                setGuidedCarry(false);
                setCarryMessage("已取消點子卡帶入；卡片與首頁自由草稿仍留在本頁。");
                return;
              }
              ideaDraftHandoff.cancel(storageScope);
              setCarry(false);
              setCarryMessage("已取消自由草稿帶入；原文仍留在本頁。已送出的建立操作仍只可查回，不會重新建立。");
            }}>取消帶入</button>}
          </div>
          <p role="status" data-testid="idea-carry-status">{carryMessage}</p>
          <p id="student-draft-help">自由草稿及引導回答僅在本頁記憶體暫存，未自動保存；離頁連結會先詢問。重新載入、關閉分頁及瀏覽器返回／前進不在此保護範圍，離開後可能無法恢復。</p>
        </section>
        <p className={styles.tagline}>聊出點子，做出自己的 App！</p>
        <section aria-labelledby="guide-title" className={styles.guides}>
          <div className={styles.guideHeading}><h2 id="guide-title">每個好點子，都有一個好起點</h2><span>選一張卡，或直接輸入</span></div>
          <div className={styles.cards}>{guides.map((guide, index) =>
            <button type="button" key={guide.title} className={styles.guideCard}
              aria-pressed={selected === index} disabled={bound} onClick={() => selectGuide(index)}>
              <span className={`${styles.guideIcon} ${styles[guide.tone]}`} aria-hidden="true">{guide.icon}</span>
              <strong>{guide.title}</strong><span>{guide.description}</span><small>{guide.tool}・草稿引導</small>
            </button>)}</div>
          {guidedOpen && <GuidedIdeaPanel flow={guidedFlow} error={guidedError} carried={guidedCarry} disabled={bound}
            onAction={updateGuidedIdea} onPreview={previewGuidedIdea}
            onCarry={carryGuidedIdea} onCancel={cancelGuidedIdea} />}
          <p id="student-guide-status" role="status" aria-live="polite">
            {selected === null ? "尚未選擇引導，可直接輸入。" : `已選擇「${guides[selected].tool}」的草稿引導。`}
            {" "}引導依你的回答整理，不會啟動 AI 或建立對話；切卡前會先確認是否放棄引導回答。
          </p>
        </section>
        <section id="my-projects" tabIndex={-1} className={styles.projects} aria-label="本人專案區">
          {children}
          <CreateProjectForm storageScope={storageScope}
            ideaDraft={carry ? draft : null}
            guidedIdea={guidedCarry && guidedOpen && guidedFlow.confirmed ? guidedFlow.idea : null}
            canAutoNavigate={() => autoNavigationAllowed.current}
            onCarryBound={() => setBound(true)}
            onCarryReleased={() => setBound(false)} />
        </section>
        <OperationNotice authenticated />
      </main>
    </div>
    <Dialog.Root open={destination !== null} onOpenChange={(open) => { if (!open) setDestination(null); }}>
      <Dialog.Portal container={portal}>
        <Dialog.Overlay className={styles.overlay} />
        <Dialog.Content className={styles.dialog} data-testid="student-draft-dialog"
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            if (opener.current?.isConnected && !space.current?.closest("[hidden]")) opener.current.focus();
          }}>
          <Dialog.Title>離開前，要放棄尚未保存的內容嗎？</Dialog.Title>
          <Dialog.Description>首頁草稿或引導回答尚未保存。離開後可能遺失，重新載入或關閉分頁後無法恢復。</Dialog.Description>
          <div className={styles.dialogActions}>
            <button type="button" onClick={() => setDestination(null)}>留在本頁</button>
            <button type="button" onClick={leave}>放棄草稿並離開</button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
      <Dialog.Root open={pendingGuideAction !== null} onOpenChange={(open) => {
        if (!open) setPendingGuideAction(null);
      }}>
        <Dialog.Portal container={portal}>
          <Dialog.Overlay className={styles.overlay} />
          <Dialog.Content className={styles.dialog} data-testid="guided-idea-switch-dialog">
            <Dialog.Title>{pendingGuideAction === "start"
              ? "先保留目前草稿，再開始引導？"
              : pendingGuideAction === "cancel"
                ? "要放棄尚未保存的引導回答嗎？"
                : "要放棄引導回答並切換嗎？"}</Dialog.Title>
            <Dialog.Description>{pendingGuideAction === "start"
              ? "你的自由草稿會留在原處，不會被引導回答覆蓋。引導回答只在本頁記憶體，離開頁面可能遺失。"
              : "引導回答只留在目前頁面記憶體。自由草稿會保留；放棄引導回答後不能恢復。"}</Dialog.Description>
            <div className={styles.dialogActions}>
              <button type="button" onClick={() => setPendingGuideAction(null)}>
                {pendingGuideAction === "start" ? "留在原頁" : "留在引導"}
              </button>
              <button type="button" onClick={finishGuideAction}>
                {pendingGuideAction === "start"
                  ? "開始引導（保留原草稿）"
                  : pendingGuideAction === "cancel"
                    ? "放棄回答並取消引導"
                    : "放棄回答並切換"}
              </button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
  </div></div>;
}
