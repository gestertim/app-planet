"use client";

import { useEffect, useRef, useState } from "react";
import { downloadSavedProject } from "./export-download.ts";
import { hasGuardedWorkspaceResources } from "./unsaved-changes-guard.tsx";

export function ProjectExportDownload({ projectId }: Readonly<{ projectId: string }>) {
  const active = useRef<AbortController | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => () => { active.current?.abort(); active.current = null; }, [projectId]);
  const download = async () => {
    if (active.current) return;
    const controller = new AbortController();
    active.current = controller;
    setBusy(true);
    setFailed(false);
    const pending = hasGuardedWorkspaceResources();
    setNotice(pending
      ? "本頁有未保存、保存中或待確認操作；本次只讀取伺服器已保存內容，不會自動保存或清除本頁操作。"
      : "正在讀取伺服器已保存內容。");
    try {
      await downloadSavedProject(projectId, AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]));
      if (!controller.signal.aborted) setNotice(pending
        ? "已下載已保存資料；本頁未保存或待確認操作仍保留，檔案不包含未保存文字。"
        : "已下載已保存資料；不代表作品已完成或獲批准。");
    } catch {
      if (!controller.signal.aborted) {
        setFailed(true);
        setNotice("下載失敗，沒有產生成功檔案；本頁輸入與操作仍保留。請稍後點選「下載已保存資料」重試。");
      }
    } finally {
      if (!controller.signal.aborted && active.current === controller) {
        active.current = null;
        setBusy(false);
      }
    }
  };
  return <section className="card" aria-label="下載本人已保存資料">
    <h2>下載已保存資料</h2>
    <p>只含 server 已保存內容，未保存文字不包含；保存中或結果未知的操作以本次 DB 讀取時已提交的資料為準。</p>
    <p>不代表作品已完成或獲批准；不是 Final Pack、部署包或可還原備份。本輪不支援匯入或恢復。</p>
    <button type="button" onClick={() => void download()} disabled={busy}>
      {busy ? "正在下載…" : "下載已保存資料"}
    </button>
    {notice && <p role={failed ? "alert" : "status"} data-testid="project-export-status">{notice}</p>}
  </section>;
}
