"use client";

import * as Dialog from "@radix-ui/react-dialog";
import { useCallback, useRef, useState, type FocusEvent, type MouseEvent } from "react";
import Link from "next/link";
import { ClosedAction, OperationNotice } from "@/components/operation-state";
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

export function StudentCreationSpace({ children }: Readonly<{ children: React.ReactNode }>) {
  const [draft, setDraft] = useState("");
  const [selected, setSelected] = useState<number | null>(null);
  const [destination, setDestination] = useState<HTMLAnchorElement | null>(null);
  const [portal, setPortal] = useState<HTMLDivElement | null>(null);
  const space = useRef<HTMLDivElement | null>(null);
  const bypass = useRef(false);
  const opener = useRef<HTMLAnchorElement | null>(null);
  const editor = useRef<HTMLTextAreaElement>(null);
  const mountSpace = useCallback((element: HTMLDivElement | null) => {
    space.current = element;
    setPortal(element);
  }, []);
  const hasDraft = draft.length > 0;
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
    if (bypass.current || !hasDraft || event.defaultPrevented || event.button !== 0 ||
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
    setDestination(null);
    setDraft("");
    // 重送原控制項的點擊，沿用 Link 導覽，不另建路由機制。
    bypass.current = true;
    destination.click();
    bypass.current = false;
  };
  const selectGuide = (index: number) => {
    setSelected(index);
    setDraft((current) => current.trim() === "" ? guides[index].prompt : current);
    editor.current?.focus();
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
        <button type="button" key={guide.tool} onClick={() => selectGuide(index)}
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
          <textarea id="student-idea" ref={editor} value={draft} onChange={(event) => setDraft(event.target.value)}
            aria-describedby="student-draft-help student-guide-status"
            placeholder="說說你的點子，或寫下任何關於 App 的問題⋯" rows={3} />
          <div className={styles.composerActions}>
            <ClosedAction label="＋ 附件" /><ClosedAction label="啟用 Skill" /><ClosedAction label="送出點子" />
          </div>
          <p id="student-draft-help">僅在本頁暫存，未儲存、未送出；本頁離頁連結會先詢問。重新載入、關閉分頁及瀏覽器返回／前進不在此保護範圍，離開後草稿無法恢復。</p>
        </section>
        <p className={styles.tagline}>聊出點子，做出自己的 App！</p>
        <section aria-labelledby="guide-title" className={styles.guides}>
          <div className={styles.guideHeading}><h2 id="guide-title">每個好點子，都有一個好起點</h2><span>選一張卡，或直接輸入</span></div>
          <div className={styles.cards}>{guides.map((guide, index) =>
            <button type="button" key={guide.title} className={styles.guideCard}
              aria-pressed={selected === index} onClick={() => selectGuide(index)}>
              <span className={`${styles.guideIcon} ${styles[guide.tone]}`} aria-hidden="true">{guide.icon}</span>
              <strong>{guide.title}</strong><span>{guide.description}</span><small>{guide.tool}・草稿引導</small>
            </button>)}</div>
          <p id="student-guide-status" role="status" aria-live="polite">
            {selected === null ? "尚未選擇引導，可直接輸入。" : `已選擇「${guides[selected].tool}」的草稿引導。`}
            {" "}未啟用特定 Skill；切卡保留已有文字，不建立對話。
          </p>
        </section>
        <section id="my-projects" tabIndex={-1} className={styles.projects} aria-label="本人專案區">
          {children}
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
          <Dialog.Title>離開前，要放棄點子草稿嗎？</Dialog.Title>
          <Dialog.Description>這份點子尚未儲存或送出。放棄並離開後，無法恢復本頁草稿。</Dialog.Description>
          <div className={styles.dialogActions}>
            <button type="button" onClick={() => setDestination(null)}>留在本頁</button>
            <button type="button" onClick={leave}>放棄草稿並離開</button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  </div></div>;
}
