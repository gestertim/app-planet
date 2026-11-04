"use client";
import { productFetch as fetch } from "../auth/product-fetch.ts";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { z } from "zod";
import { problemJsonSchema, utcInstantSchema } from "@app-planet/core";
import { useProjectAccessLost } from "./protected-project-view";
import {
  clearIntentSnapshot,
  resolveStoredIntents,
  shortOperationId,
  type CreateIntent,
  type StoredIntentSources,
} from "./create-project-intent";

const createdSchema = z.strictObject({
  id: z.uuid(), title: z.string(), stage: z.literal("點子"), created_at: utcInstantSchema,
  row_version: z.literal(0), classification_state: z.literal("unconfirmed"),
  requested_tier: z.enum(["A", "B"]).nullable(), tier: z.null(), needs_visitor_identity: z.null(),
});
const replayedSchema = z.strictObject({
  outcome: z.literal("replayed"),
  project: createdSchema,
});
const noWriteCreateCodes = new Set([
  "unauthenticated", "account_disabled", "forbidden", "invalid_request", "tier_not_supported",
  "payload_too_large", "unsupported_media_type", "idempotency_key_required", "invalid_idempotency_key",
]);

async function readProblem(response: Response) {
  if (!response.headers.get("content-type")?.startsWith("application/problem+json")) return null;
  try {
    return problemJsonSchema.safeParse(await response.json());
  } catch {
    return null;
  }
}

function provesCreateWasNotExecuted(response: Response, problem: Awaited<ReturnType<typeof readProblem>>) {
  return problem?.success === true &&
    problem.data.status === response.status &&
    noWriteCreateCodes.has(problem.data.code);
}

export function CreateProjectForm({ storageScope }: { storageScope: string }) {
  const router = useRouter();
  const accessLost = useProjectAccessLost();
  const [title, setTitle] = useState("");
  const [requestedTier, setRequestedTier] = useState<"A" | "B" | null>(null);
  const [intent, setIntent] = useState<CreateIntent | null>(null);
  const [stopped, setStopped] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [created, setCreated] = useState<{ id: string; title: string } | null>(null);
  const [loadedStorageKey, setLoadedStorageKey] = useState<string | null>(null);
  const [storageUnavailable, setStorageUnavailable] = useState(false);
  const [storedSources, setStoredSources] = useState<StoredIntentSources>({ session: null, local: null });
  const storageKey = `app-planet.project-create.${storageScope}`;
  const scopeReady = loadedStorageKey === storageKey;
  const storageReady = scopeReady && !storageUnavailable;

  useEffect(() => {
    setLoadedStorageKey(null);
    setStorageUnavailable(false);
    setTitle("");
    setRequestedTier(null);
    setIntent(null);
    setStopped(false);
    setCreated(null);
    setMessage("");
    setStoredSources({ session: null, local: null });
    try {
      const sessionRaw = sessionStorage.getItem(storageKey);
      const localRaw = localStorage.getItem(storageKey);
      const resolved = resolveStoredIntents(sessionRaw, localRaw);
      setStoredSources({ session: sessionRaw, local: localRaw });
      if (resolved.kind === "unusable") {
        const operationIds = [...new Set(resolved.operationIds)].map((id) => shortOperationId(id)).join("、");
        if (resolved.reason === "conflict") {
          setStopped(true);
          setMessage(`分頁與舊版儲存位置的操作紀錄不同${operationIds ? `（操作代號 ${operationIds}）` : ""}；`
            + "未選用或覆寫任何紀錄，已停止送出。請在下方專案清單人工核對，勿另建重複專案。");
        } else {
          setStopped(true);
          setMessage(`${resolved.reason === "legacy"
            ? "待確認操作是舊版紀錄，無法安全恢復"
            : "待確認操作紀錄無法安全恢復"}${operationIds ? `（操作代號 ${operationIds}）` : ""}；`
            + "已停止送出；紀錄均已保留。請在下方專案清單人工核對，勿另建重複專案。");
        }
        setLoadedStorageKey(storageKey);
        return;
      }
      if (resolved.kind === "intent") {
        setIntent(resolved.intent);
        setTitle(resolved.intent.payload.title);
        setRequestedTier(resolved.intent.payload.tier ?? null);
        setMessage("上次建立結果待確認。只會以原操作識別與原本文查詢／恢復，絕不重新建立或換鍵。");
      }
      setLoadedStorageKey(storageKey);
    } catch {
      setStorageUnavailable(true);
      setStopped(true);
      setMessage("無法安全讀取或保存本機操作紀錄；已停止送出，請勿另建重複專案。");
      setLoadedStorageKey(storageKey);
    }
  }, [storageKey]);

  function hideProtectedState() {
    setTitle("");
    setIntent(null);
    setCreated(null);
    setStopped(true);
    accessLost();
  }

  async function submit() {
    if (busy || !storageReady || stopped) return;
    setBusy(true);
    setCreated(null);
    setMessage(intent ? "正在以原操作查詢建立結果。" : "正在保存操作識別並建立專案。");
    try {
      const operation = intent ?? {
        v: 3 as const,
        key: crypto.randomUUID(),
        payload: requestedTier === null ? { title } : { title, tier: requestedTier },
      };
      const initialCreate = intent === null;
      // 本次操作實際保存的來源快照；不可依賴剛呼叫 setter 的 state。
      let sources: StoredIntentSources = storedSources;
      if (initialCreate) {
        const serialized = JSON.stringify(operation);
        try {
          sessionStorage.setItem(storageKey, serialized);
          if (sessionStorage.getItem(storageKey) !== serialized) throw new Error("session storage verification failed");
        } catch {
          setStorageUnavailable(true);
          setStopped(true);
          setMessage("無法安全保存操作識別；尚未送出建立，請勿另建重複專案。");
          return;
        }
        sources = { session: serialized, local: null };
        setStoredSources(sources);
        setIntent(operation);
      }
      await send(operation, initialCreate, sources);
    } finally {
      setBusy(false);
    }
  }

  async function send(operation: CreateIntent, initialCreate: boolean, sources: StoredIntentSources) {
    setMessage(initialCreate ? "正在等待伺服器確認建立結果。" : "正在只查詢原操作的建立結果。");
    try {
      const response = await fetch(initialCreate ? "/api/v1/projects" : "/api/v1/projects/recovery", {
        method: "POST", cache: "no-store", credentials: "same-origin", redirect: "error",
        headers: { "content-type": "application/json", "idempotency-key": operation.key },
        body: JSON.stringify(operation.payload), signal: AbortSignal.timeout(15_000),
      });
      if (response.status === 401 || response.status === 403) {
        hideProtectedState();
        return;
      }
      if (initialCreate && (response.status === 400 || response.status === 413 || response.status === 415)) {
        const problem = await readProblem(response);
        if (provesCreateWasNotExecuted(response, problem)) {
          if (clearIntentSnapshot(sessionStorage, localStorage, storageKey, sources) === "cleared") {
            setStoredSources({ session: null, local: null });
            setIntent(null);
            setMessage("伺服器明確拒絕首次請求，確認尚未建立；請檢查內容後再送出。");
          } else {
            setStopped(true);
            setMessage("伺服器明確拒絕首次請求，但本機紀錄已變更或無法安全清除；已停止操作。");
          }
          return;
        }
      }
      if (response.status === 409 && !initialCreate) {
        const problem = await readProblem(response);
        if (problem?.success && problem.data.code === "operation_outcome_unrecoverable") {
          setStopped(true);
          setMessage(`操作 ${shortOperationId(operation.key)} 無法從有效完整的 receipt 確認；系統不會重新建立。`
            + "原操作仍保留，請在專案清單人工核對並請老師協助。");
          return;
        }
      }
      if (initialCreate && response.status === 201) {
        const parsed = createdSchema.safeParse(await response.json());
        if (!parsed.success || parsed.data.title !== operation.payload.title ||
            parsed.data.requested_tier !== (operation.payload.tier ?? null)) {
          setMessage("建立結果待確認：回應無法驗證。下次只會查詢原操作，不會重新建立。");
          return;
        }
        await finishConfirmed(parsed.data, sources);
        return;
      }
      if (!initialCreate && response.status === 200) {
        const parsed = replayedSchema.safeParse(await response.json());
        if (!parsed.success || parsed.data.project.title !== operation.payload.title ||
            parsed.data.project.requested_tier !== (operation.payload.tier ?? null)) {
          setMessage("恢復結果待確認：回應無法驗證。原操作已保留，請勿另建專案。");
          return;
        }
        await finishConfirmed(parsed.data.project, sources);
        return;
      }
      setMessage("建立結果仍待確認。原操作識別與本文已保留；後續只會查詢原操作，不會重新建立或換鍵。");
    } catch {
      setMessage("建立結果仍待確認：連線或回應中斷。原操作已保留；後續只會查詢原操作，不會重新建立或換鍵。");
    }
  }

  async function finishConfirmed(project: { id: string; title: string }, sources: StoredIntentSources) {
    const cleared = clearIntentSnapshot(sessionStorage, localStorage, storageKey, sources) === "cleared";
    setCreated(project);
    setTitle("");
    setRequestedTier(null);
    if (cleared) {
      setStoredSources({ session: null, local: null });
      setIntent(null);
    } else {
      // 紀錄仍在：保留意圖並停止，避免以新 key 重複建立。
      setStopped(true);
    }
    setMessage(cleared
      ? "伺服器已確認原操作建立專案；分類仍未確認。"
      : "伺服器已確認原操作建立專案，但本機紀錄無法清除；請勿另建，重新載入後仍只會查詢原操作。");
    router.refresh();
  }

  return <section className="card" aria-labelledby="create-project-heading">
    <h2 id="create-project-heading">建立未分類點子</h2>
    <form onSubmit={(event) => { event.preventDefault(); void submit(); }}>
      <label htmlFor="project-title">專案名稱</label>
      <input id="project-title" value={scopeReady ? title : ""} disabled={!storageReady || busy || stopped || intent !== null}
        onChange={(event) => setTitle(event.target.value)} />
      <label htmlFor="project-requested-tier">建立時的 A/B 偏好（不是正式分類）</label>
      <select id="project-requested-tier" value={scopeReady ? requestedTier ?? "" : ""}
        disabled={!storageReady || busy || stopped || intent !== null}
        onChange={(event) => {
          const value = event.target.value;
          setRequestedTier(value === "A" || value === "B" ? value : null);
        }}>
        <option value="">尚無偏好</option>
        <option value="A">偏好 A：靜態作品</option>
        <option value="B">偏好 B：平台資料服務</option>
      </select>
      <button type="submit" disabled={!storageReady || busy || stopped}>
        {intent ? stopped ? "操作已停止" : "只查詢原操作" : "建立專案"}
      </button>
    </form>
    <p role="status" aria-live="polite">{scopeReady ? message : "正在安全讀取本帳號的操作紀錄。"}</p>
    {scopeReady && created && <Link prefetch={false} href={`/student/projects/${created.id}`}>開啟剛建立的專案</Link>}
  </section>;
}
