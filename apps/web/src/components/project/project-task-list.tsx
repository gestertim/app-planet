"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { problemJsonSchema, projectTaskDtoSchema, type ProjectTaskDto } from "@app-planet/core";
import { UnsavedChangesGuard, type GuardCondition, type GuardResult } from "./unsaved-changes-guard.tsx";
import { useProjectAccessLost } from "./protected-project-view";

export function ProjectTaskList({
  projectId,
  accountScope,
  initialTasks,
  revision,
}: Readonly<{
  projectId: string;
  accountScope: string;
  initialTasks: readonly ProjectTaskDto[];
  revision: string;
}>) {
  const router = useRouter();
  const accessLost = useProjectAccessLost();
  const [tasks, setTasks] = useState<readonly ProjectTaskDto[]>(initialTasks);
  const [intent, setIntent] = useState<{ task: ProjectTaskDto; done: boolean } | null>(null);
  const [saving, setSaving] = useState(false);
  const [reloadRequested, setReloadRequested] = useState(false);
  const [message, setMessage] = useState("");
  const [operationState, setOperationState] = useState<GuardCondition>("clean");
  const operationStateRef = useRef<GuardCondition>("clean");
  const pendingSaveRef = useRef<Promise<void> | null>(null);
  const composingRef = useRef(false);
  const lastRevision = useRef(revision);

  function updateOperationState(next: GuardCondition) {
    operationStateRef.current = next;
    setOperationState(next);
  }

  function readOperationState(): GuardCondition {
    return operationStateRef.current;
  }

  useEffect(() => {
    if (revision === lastRevision.current) return;
    lastRevision.current = revision;
    if (reloadRequested) {
      setTasks(initialTasks);
      setIntent(null);
      updateOperationState("clean");
      setMessage("已重新載入最新任務；請比對後再操作。");
      setReloadRequested(false);
      return;
    }
    if (intent === null && !saving) setTasks(initialTasks);
  }, [initialTasks, intent, reloadRequested, revision, saving]);

  function save(task: ProjectTaskDto, done: boolean) {
    if (operationStateRef.current === "saving" || intent !== null) return;
    setIntent({ task, done });
    setSaving(true);
    updateOperationState("saving");
    setMessage("正在保存你的任務勾選；尚未確認前不會標示為已保存。");
    const pending = persist(task, done);
    pendingSaveRef.current = pending;
    void pending.finally(() => {
      if (pendingSaveRef.current === pending) pendingSaveRef.current = null;
    });
  }

  async function persist(task: ProjectTaskDto, done: boolean) {
    setSaving(true);
    updateOperationState("saving");
    try {
      const response = await fetch(
        `/api/v1/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(task.id)}`,
        {
          method: "PATCH",
          cache: "no-store",
          credentials: "same-origin",
          redirect: "error",
          headers: {
            "content-type": "application/json",
            "if-match": `"${task.row_version}"`,
          },
          body: JSON.stringify({ done }),
          signal: AbortSignal.timeout(15_000),
        },
      );
      if (response.status === 401 || response.status === 403) {
        accessLost();
        setIntent(null);
        updateOperationState("clean");
        return;
      }
      if (response.status === 409) {
        let conflict = false;
        try {
          const parsed = problemJsonSchema.safeParse(await response.json());
          conflict = parsed.success && parsed.data.code === "version_conflict";
        } catch {
          conflict = false;
        }
        setMessage(conflict
          ? "版本已被其他操作更新；你的勾選意圖仍保留，請重新載入並比對後再決定。"
          : "保存結果尚未確認；你的勾選意圖仍保留，請重新載入並比對。");
        updateOperationState(conflict ? "conflict" : "unknown");
        return;
      }
      if (response.status !== 200) {
        setMessage("保存結果尚未確認；你的勾選意圖仍保留，請重新載入並比對。");
        updateOperationState("unknown");
        return;
      }
      let raw: unknown;
      try {
        raw = await response.json();
      } catch {
        setMessage("伺服器回應無法驗證；保存結果尚未確認，你的勾選意圖仍保留。");
        updateOperationState("unknown");
        return;
      }
      const parsed = projectTaskDtoSchema.safeParse(raw);
      if (!parsed.success ||
          parsed.data.id !== task.id ||
          parsed.data.project_id !== projectId ||
          parsed.data.done !== done ||
          parsed.data.row_version !== task.row_version + 1 ||
          response.headers.get("etag") !== `"${parsed.data.row_version}"`) {
        setMessage("伺服器回應無法驗證；保存結果尚未確認，你的勾選意圖仍保留。");
        updateOperationState("unknown");
        return;
      }
      setTasks((current) => current.map((item) => item.id === parsed.data.id ? parsed.data : item));
      setIntent(null);
      updateOperationState("clean");
      setMessage(`已保存你的任務勾選（版本 ${parsed.data.row_version}）。這不代表階段或作品已完成。`);
    } catch {
      setMessage("連線中斷或結果未知；不會顯示成功，你的勾選意圖仍保留，請重新載入並比對。");
      updateOperationState("unknown");
    } finally {
      setSaving(false);
      if (operationStateRef.current === "saving") updateOperationState("unknown");
    }
  }

  const retryExactOperation = async (): Promise<GuardResult> => {
    if (operationStateRef.current !== "unknown" || intent === null) {
      return { outcome: "blocked", reason: "retry_required" };
    }
    const original = intent;
    await persist(original.task, original.done);
    const state = readOperationState();
    if (state === "clean") return { outcome: "switched" };
    return {
      outcome: "blocked",
      reason: state === "conflict" ? "conflict" : "retry_required",
    };
  };

  const saveThenLeave = async (): Promise<GuardResult> => {
    if (operationStateRef.current === "saving" && pendingSaveRef.current) {
      await pendingSaveRef.current;
    }
    const state = readOperationState();
    if (state === "clean") return { outcome: "switched" };
    return {
      outcome: "blocked",
      reason: state === "conflict" ? "conflict"
        : state === "saving" ? "saving" : "retry_required",
    };
  };

  const discardAndLeave = async (): Promise<GuardResult> => {
    if (operationStateRef.current === "saving") return { outcome: "blocked", reason: "saving" };
    const state = readOperationState();
    const uncertain = state === "unknown" || state === "conflict";
    setIntent(null);
    updateOperationState("clean");
    setMessage(uncertain
      ? "已放棄本頁的本地勾選意圖；先前請求可能已寫入，重新進入時請重新載入確認。"
      : "已放棄本頁的本地勾選意圖。");
    return { outcome: "switched" };
  };

  function reload() {
    setReloadRequested(true);
    setMessage("正在重新載入伺服器任務；目前勾選意圖尚未保存確認。");
    router.refresh();
  }

  return <section className="card" aria-labelledby="project-tasks-heading" data-testid="project-task-list">
    <UnsavedChangesGuard
      identity={{ accountScope, projectId, resourceId: "project-tasks" }}
      condition={operationState}
      actions={{
        saveThenLeave,
        retryThenLeave: retryExactOperation,
        discardAndLeave,
      }}
      composingRef={composingRef}
    />
    <h2 id="project-tasks-heading">專案任務</h2>
    <p>勾選只表示你的任務標記，不代表階段完成、教師批准、Agent 已執行、測試通過或作品可發布。</p>
    {tasks.length === 0
      ? <p>目前沒有正式任務；請在上方手動輸入並確認任務清單，不會顯示示例任務。</p>
      : <ul>
        {tasks.map((task) => {
          const checked = intent?.task.id === task.id ? intent.done : task.done;
          return <li key={task.id}>
            <label>
              <input
                type="checkbox"
                aria-label={`完成任務：${task.title}`}
                checked={checked}
                disabled={saving || intent !== null}
                onChange={(event) => void save(task, event.currentTarget.checked)}
              />
              {task.title}
            </label>
            <span className="muted">（已保存版本 {task.row_version}）</span>
          </li>;
        })}
      </ul>}
    <p role="status" aria-live="polite" data-testid="project-task-save-status">
      {message || (tasks.length ? "任務狀態來自伺服器已保存資料。" : "尚無可顯示的正式任務。")}
    </p>
    {intent !== null && !saving && <button type="button" onClick={reload}>重新載入並比對</button>}
  </section>;
}
