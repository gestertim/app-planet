"use client";
import { productFetch as fetch } from "../auth/product-fetch.ts";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { z } from "zod";
import {
  parseManualTaskLines,
  problemJsonSchema,
  projectTaskImportLimits,
  projectTaskImportResultSchema,
} from "@app-planet/core";
import { useProjectAccessLost } from "./protected-project-view";
import { clearIntentSnapshot, shortOperationId } from "./create-project-intent";
import { UnsavedChangesGuard, type GuardCondition, type GuardResult } from "./unsaved-changes-guard.tsx";

const intentSchema = z.strictObject({
  v: z.literal(1),
  key: z.uuid(),
  tasks: z.array(z.string()).min(1).max(projectTaskImportLimits.maxTasks),
});
type ImportIntent = z.infer<typeof intentSchema>;

// 伺服器以這些問題碼證明本次匯入沒有寫入。
const noWriteCodes = new Set([
  "invalid_request", "payload_too_large", "unsupported_media_type", "idempotency_key_required",
  "invalid_idempotency_key", "not_found", "task_list_already_exists",
]);
const noLocalCopy = { getItem: () => null, removeItem: () => undefined };

const lineProblems: Record<string, string> = {
  empty: "請至少輸入一項任務（每行一項）。",
  too_many: `任務最多 ${projectTaskImportLimits.maxTasks} 項。`,
  title_too_long: `每項任務最多 ${projectTaskImportLimits.maxTitleCodePoints} 個字元。`,
  control_character: "任務內容不可包含控制字元。",
};

export function ProjectTaskImport({ projectId, storageScope, hasTasks }: Readonly<{
  projectId: string;
  storageScope: string;
  hasTasks: boolean;
}>) {
  const router = useRouter();
  const accessLost = useProjectAccessLost();
  const storageKey = `app-planet.task-import.${storageScope}.${projectId}`;
  const [loaded, setLoaded] = useState(false);
  const [text, setText] = useState("");
  const [preview, setPreview] = useState<string[] | null>(null);
  const [intent, setIntent] = useState<ImportIntent | null>(null);
  const [raw, setRaw] = useState<string | null>(null);
  const [stopped, setStopped] = useState(false);
  const [busy, setBusy] = useState(false);
  const [imported, setImported] = useState(false);
  const [message, setMessage] = useState("");
  const busyRef = useRef(false);
  const pendingImportRef = useRef<Promise<boolean> | null>(null);
  const composingRef = useRef(false);
  const [composing, setComposing] = useState(false);

  useEffect(() => {
    setLoaded(false);
    setIntent(null);
    setRaw(null);
    setPreview(null);
    setStopped(false);
    setMessage("");
    try {
      const stored = sessionStorage.getItem(storageKey);
      if (stored !== null) {
        let parsed: z.ZodSafeParseResult<ImportIntent>;
        try {
          parsed = intentSchema.safeParse(JSON.parse(stored));
        } catch {
          parsed = intentSchema.safeParse(null);
        }
        if (parsed.success) {
          setIntent(parsed.data);
          setRaw(stored);
          setMessage(`上次匯入結果待確認（操作代號 ${shortOperationId(parsed.data.key)}）。只會以原操作識別與原內容重送，不會換鍵或改內容。`);
        } else {
          setStopped(true);
          setMessage("待確認的任務匯入紀錄無法安全恢復；紀錄已保留，已停止送出。請重新載入確認專案任務，或請老師協助。");
        }
      }
    } catch {
      setStopped(true);
      setMessage("無法安全讀取或保存本機操作紀錄；已停止送出，不會重複匯入。");
    }
    setLoaded(true);
  }, [storageKey]);

  function showPreview() {
    if (composingRef.current) return;
    const parsed = parseManualTaskLines(text);
    if (!parsed.ok) {
      setMessage(lineProblems[parsed.reason]);
      return;
    }
    setPreview(parsed.titles);
    setMessage("這是預覽，尚未保存為專案任務。請確認內容與順序後再建立。");
  }

  function finish(cleared: boolean, note: string) {
    if (cleared) {
      setIntent(null);
      setRaw(null);
    } else {
      setStopped(true);
    }
    setMessage(note);
  }

  async function performConfirmAndSend(): Promise<boolean> {
    if (stopped || !loaded) return false;
    let operation = intent;
    let operationRaw = raw;
    if (operation === null) {
      if (preview === null || composingRef.current) return false;
      operation = { v: 1, key: crypto.randomUUID(), tasks: preview };
      operationRaw = JSON.stringify(operation);
      try {
        sessionStorage.setItem(storageKey, operationRaw);
        if (sessionStorage.getItem(storageKey) !== operationRaw) throw new Error("verification failed");
      } catch {
        setStopped(true);
        setMessage("無法安全保存操作識別；尚未送出，不會建立任務。");
        return false;
      }
      setIntent(operation);
      setRaw(operationRaw);
    }
    setBusy(true);
    setMessage("正在送出你確認的任務清單；伺服器確認前不會顯示為已保存。");
    try {
      return await send(operation, operationRaw);
    } finally {
      setBusy(false);
    }
  }

  function confirmAndSend(): Promise<boolean> {
    if (busyRef.current || stopped || !loaded) return Promise.resolve(false);
    busyRef.current = true;
    const pending = performConfirmAndSend();
    pendingImportRef.current = pending;
    void pending.finally(() => {
      busyRef.current = false;
      if (pendingImportRef.current === pending) pendingImportRef.current = null;
    });
    return pending;
  }

  async function send(operation: ImportIntent, operationRaw: string | null): Promise<boolean> {
    const sources = { session: operationRaw, local: null };
    try {
      const response = await fetch(`/api/v1/projects/${encodeURIComponent(projectId)}/tasks`, {
        method: "POST", cache: "no-store", credentials: "same-origin", redirect: "error",
        headers: { "content-type": "application/json", "idempotency-key": operation.key },
        body: JSON.stringify({ confirmed: true, tasks: operation.tasks.map((title) => ({ title })) }),
        signal: AbortSignal.timeout(15_000),
      });
      if (response.status === 401 || response.status === 403) {
        setIntent(null);
        setPreview(null);
        setStopped(true);
        accessLost();
        return false;
      }
      if (response.status === 201 || response.status === 200) {
        const parsed = projectTaskImportResultSchema.safeParse(await response.json());
        const matches = parsed.success &&
          parsed.data.outcome === (response.status === 201 ? "created" : "replayed") &&
          parsed.data.tasks.length === operation.tasks.length &&
          parsed.data.tasks.every((task, index) =>
            task.project_id === projectId && task.order === index + 1 && task.title === operation.tasks[index]);
        if (!matches) {
          setMessage("結果待確認：伺服器回應無法驗證。原操作已保留；只會以原識別重送。");
          return false;
        }
        const cleared = clearIntentSnapshot(sessionStorage, noLocalCopy, storageKey, sources) === "cleared";
        setImported(true);
        finish(cleared, cleared
          ? "已建立任務清單；任務來自你手動輸入並確認的內容。"
          : "已建立任務清單，但本機紀錄無法清除；請勿再送出，重新載入即可。");
        router.refresh();
        return true;
      }
      if (response.status === 409 || response.status === 400 || response.status === 404 ||
          response.status === 413 || response.status === 415) {
        let problem: z.ZodSafeParseResult<z.infer<typeof problemJsonSchema>> | null = null;
        try {
          problem = response.headers.get("content-type")?.startsWith("application/problem+json")
            ? problemJsonSchema.safeParse(await response.json())
            : null;
        } catch {
          problem = null;
        }
        if (problem?.success && problem.data.status === response.status && noWriteCodes.has(problem.data.code)) {
          const exists = problem.data.code === "task_list_already_exists";
          const cleared = clearIntentSnapshot(sessionStorage, noLocalCopy, storageKey, sources) === "cleared";
          setPreview(null);
          finish(cleared, cleared
            ? exists
              ? "這個專案已有任務清單，沒有覆蓋或新增任何任務；已重新載入。"
              : "伺服器確認這次沒有建立任務；請檢查內容後再送出。"
            : "伺服器確認這次沒有建立任務，但本機紀錄已變更或無法安全清除；已停止操作。");
          if (exists) router.refresh();
          return false;
        }
      }
      setMessage("匯入結果尚待確認。原操作識別與內容已保留；之後只會以原操作重送，不會換鍵或改內容。");
      return false;
    } catch {
      setMessage("匯入結果尚待確認：連線或回應中斷。原操作已保留；之後只會以原操作重送，不會換鍵或改內容。");
      return false;
    }
  }

  const condition: GuardCondition = busy ? "saving"
    : intent !== null || stopped ? "unknown"
      : text.length > 0 || preview !== null ? "dirty" : "clean";
  const saveThenLeave = async (): Promise<GuardResult> => {
    if (busyRef.current && pendingImportRef.current) {
      const saved = await pendingImportRef.current;
      return saved ? { outcome: "switched" } : { outcome: "blocked", reason: "retry_required" };
    }
    return condition === "clean"
      ? { outcome: "switched" }
      : { outcome: "blocked", reason: condition === "saving" ? "saving"
        : condition === "unknown" ? "retry_required" : "still_dirty" };
  };
  const retryThenLeave = async (): Promise<GuardResult> => {
    if (intent === null || stopped) return { outcome: "blocked", reason: "retry_required" };
    const saved = await confirmAndSend();
    if (saved) return { outcome: "switched" };
    return { outcome: "blocked", reason: "retry_required" };
  };
  const discardAndLeave = async (): Promise<GuardResult> => {
    if (busyRef.current) return { outcome: "blocked", reason: "saving" };
    setText("");
    setPreview(null);
    if (intent === null && !stopped) setMessage("");
    return { outcome: "switched" };
  };
  const guard = <UnsavedChangesGuard
    identity={{ accountScope: storageScope, projectId, resourceId: "manual-task-import" }}
    condition={loaded ? condition : "saving"}
    actions={{ saveThenLeave, retryThenLeave, discardAndLeave }}
    composingRef={composingRef}
  />;

  if (!loaded) return <section className="card" data-testid="project-task-import">
    {guard}
    <p role="status">正在安全讀取本帳號的任務匯入紀錄。</p>
  </section>;
  if (imported) return <section className="card" data-testid="project-task-import">
    <p role="status" data-testid="project-task-import-status">{message}</p>
  </section>;
  if (hasTasks && intent === null) return null;

  return <section className="card" aria-labelledby="project-task-import-heading" data-testid="project-task-import">
    {guard}
    <h2 id="project-task-import-heading">手動建立任務清單</h2>
    <p>任務由你自己輸入與確認，不是由 AI 或 Skills 產生。確認後只建立專案任務，不代表階段完成、教師批准或作品可發布。</p>
    <p>未確認的文字與預覽只保留在目前頁面記憶體；只有已明確確認並送出的待確認操作，才以原識別留在此分頁恢復。</p>
    {intent !== null
      ? <>
        <p>待確認的任務清單（原內容，不可修改）：</p>
        <ol data-testid="project-task-import-pending">{intent.tasks.map((title, index) => <li key={index}>{title}</li>)}</ol>
        <button type="button" disabled={busy || stopped} onClick={() => void confirmAndSend()}>
          以原操作確認結果
        </button>
      </>
      : preview === null
        ? <form onSubmit={(event) => { event.preventDefault(); showPreview(); }}>
          <label htmlFor="project-task-lines">任務清單（每行一項，最多 {projectTaskImportLimits.maxTasks} 項）</label>
          <textarea id="project-task-lines" rows={6} value={text} disabled={stopped || busy}
            onChange={(event) => setText(event.target.value)}
            onCompositionStart={() => { composingRef.current = true; setComposing(true); }}
            onCompositionEnd={() => { composingRef.current = false; setComposing(false); }}
            onBlur={() => { composingRef.current = false; setComposing(false); }} />
          <button type="submit" disabled={stopped || busy || composing}>預覽任務清單</button>
        </form>
        : <>
          <p>預覽（尚未保存）：</p>
          <ol data-testid="project-task-import-preview">{preview.map((title, index) => <li key={index}>{title}</li>)}</ol>
          <button type="button" disabled={busy || stopped} onClick={() => void confirmAndSend()}>
            確認並建立任務清單
          </button>
          <button type="button" disabled={busy} onClick={() => { setPreview(null); setMessage(""); }}>返回修改</button>
        </>}
    <p role="status" aria-live="polite" data-testid="project-task-import-status">{message}</p>
  </section>;
}
