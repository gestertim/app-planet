import { z } from "zod";
import {
  sseEventNameSchema,
  validateSseProducerPayload,
  type SseEventName,
} from "../contracts/common.ts";

// 純事件序列規則與訊息狀態映射，只處理記憶體中的合成資料：
// 不建立儲存、串流或重放服務，也不證明資料庫持久化、原子性或端點授權。
// 只有已通過 payload schema（可安全建構）且文字已檢查的事件可進入歷史；
// 游標只在進入歷史時分配，重放沿用原 id。

export type StoredSseEvent = {
  id: number;
  event: SseEventName;
  payload: unknown;
};

export type SseTermination = "none" | "done" | "partial" | "error";

export type SseSequenceErrorCode =
  | "invalid_input"
  | "invalid_history"
  | "invalid_payload"
  | "already_terminated"
  | "unchecked_content"
  | "delta_seq_gap"
  | "partial_seq_mismatch"
  | "multiple_terminal_events"
  | "event_after_terminal"
  | "invalid_cursor";

type Failure = { ok: false; code: SseSequenceErrorCode };
const fail = (code: SseSequenceErrorCode): Failure => ({ ok: false, code });

const terminalEvents: ReadonlySet<SseEventName> = new Set(["done", "partial", "error"]);

const candidateSchema = z
  .object({
    event: sseEventNameSchema,
    payload: z.unknown(),
    outputChecked: z.unknown().optional(),
  })
  .strict();

const storedEventShapeSchema = z
  .object({
    id: z.number().int().positive(),
    event: sseEventNameSchema,
    payload: z.unknown(),
  })
  .strict();

type BuiltPayload = Record<string, unknown>;

function buildPayload(event: SseEventName, payload: unknown): BuiltPayload | null {
  const result = validateSseProducerPayload(event, payload);
  return result.success ? (result.data as BuiltPayload) : null;
}

type Scan =
  | { ok: true; termination: SseTermination; lastDeltaSeq: number; events: StoredSseEvent[] }
  | Failure;

// 檢查整份歷史：游標自 1 連續、payload 合乎登錄 schema、delta.seq 自 1 連續、
// 單一終止事件且其後無事件、partial 與最後片段相符。
function scanHistory(input: unknown): Scan {
  if (!Array.isArray(input)) {
    return fail("invalid_input");
  }
  const events: StoredSseEvent[] = [];
  let termination: SseTermination = "none";
  let lastDeltaSeq = 0;

  for (const [index, item] of input.entries()) {
    const shape = storedEventShapeSchema.safeParse(item);
    if (!shape.success) {
      return fail("invalid_history");
    }
    const { id, event } = shape.data;
    if (id !== index + 1) {
      return fail("invalid_history");
    }
    if (termination !== "none") {
      return fail(terminalEvents.has(event) ? "multiple_terminal_events" : "event_after_terminal");
    }
    const payload = buildPayload(event, shape.data.payload);
    if (payload === null) {
      return fail("invalid_payload");
    }
    if (event === "delta") {
      if (payload.seq !== lastDeltaSeq + 1) {
        return fail("delta_seq_gap");
      }
      lastDeltaSeq = payload.seq as number;
    }
    if (event === "partial" && payload.saved_through_seq !== lastDeltaSeq) {
      return fail("partial_seq_mismatch");
    }
    if (terminalEvents.has(event)) {
      termination = event as SseTermination;
    }
    events.push({ id, event, payload });
  }
  return { ok: true, termination, lastDeltaSeq, events };
}

export type AppendSseEventResult =
  | { ok: true; events: StoredSseEvent[]; stored: StoredSseEvent }
  | Failure;

// 新增事件：回傳新陣列，不修改輸入。終止後不得再新增任何事件；
// 文字片段（delta）必須明確標示已通過輸出檢查，未檢查內容不保存。
export function appendSseEvent(history: unknown, candidateInput: unknown): AppendSseEventResult {
  const scanned = scanHistory(history);
  if (!scanned.ok) {
    return scanned;
  }
  const candidate = candidateSchema.safeParse(candidateInput);
  if (!candidate.success) {
    return fail("invalid_input");
  }
  const { event, payload, outputChecked } = candidate.data;

  if (scanned.termination !== "none") {
    return fail("already_terminated");
  }
  const built = buildPayload(event, payload);
  if (built === null) {
    return fail("invalid_payload");
  }
  if (event === "delta") {
    if (outputChecked !== true) {
      return fail("unchecked_content");
    }
    if (built.seq !== scanned.lastDeltaSeq + 1) {
      return fail("delta_seq_gap");
    }
  }
  if (event === "partial" && built.saved_through_seq !== scanned.lastDeltaSeq) {
    return fail("partial_seq_mismatch");
  }

  const stored: StoredSseEvent = { id: scanned.events.length + 1, event, payload: built };
  return { ok: true, events: [...scanned.events, stored], stored };
}

export type ValidateSseHistoryResult = { ok: true; termination: SseTermination } | Failure;

export function validateSseEventHistory(history: unknown): ValidateSseHistoryResult {
  const scanned = scanHistory(history);
  return scanned.ok ? { ok: true, termination: scanned.termination } : scanned;
}

export type SelectReplayResult = { ok: true; events: StoredSseEvent[] } | Failure;

// 重放已保存事件：只選取游標之後的原事件，沿用原 id 與原 payload；
// 不新增事件、不重新計算 usage，因此不算新增生成。
export function selectReplayEvents(history: unknown, lastEventId?: unknown): SelectReplayResult {
  const scanned = scanHistory(history);
  if (!scanned.ok) {
    return scanned;
  }
  let after = 0;
  if (lastEventId !== undefined) {
    if (
      typeof lastEventId !== "number" ||
      !Number.isInteger(lastEventId) ||
      lastEventId < 0 ||
      lastEventId > scanned.events.length
    ) {
      return fail("invalid_cursor");
    }
    after = lastEventId;
  }
  return { ok: true, events: scanned.events.slice(after) };
}

// 本機 helper 已支援的狀態子集，不是 messages.state 的完整契約列舉。
export type MessageState = "complete" | "partial" | "failed";

export type DerivedMessageState =
  | {
      ok: true;
      termination: SseTermination;
      state: MessageState;
      incomplete: boolean;
      preservedThroughSeq: number;
      savedFragments: Array<{ seq: number; text: string }>;
    }
  | Failure
  | { ok: false; code: "unsupported_message_state_mapping" };

const stateByTermination: Record<SseTermination, MessageState> = {
  done: "complete",
  partial: "partial",
  error: "failed",
  // H-4 先以 partial 寫入；沒有終止事件時不得被讀成成功。
  none: "partial",
};

// error → failed；已檢查並保存的片段保留可讀並明示未完成，不標 complete。
// 先驗證完整歷史；有效歷史若含 block／support，回本機 unsupported_message_state_mapping，
// 不推測訊息狀態，也不改寫 CHAT 的 block → blocked 契約；此碼不是 HTTP／SSE 錯誤碼。
export function deriveMessageState(history: unknown): DerivedMessageState {
  const scanned = scanHistory(history);
  if (!scanned.ok) {
    return scanned;
  }
  if (scanned.events.some((stored) => stored.event === "block" || stored.event === "support")) {
    return { ok: false, code: "unsupported_message_state_mapping" };
  }
  const savedFragments = scanned.events
    .filter((stored) => stored.event === "delta")
    .map((stored) => {
      const payload = stored.payload as { seq: number; text: string };
      return { seq: payload.seq, text: payload.text };
    });
  return {
    ok: true,
    termination: scanned.termination,
    state: stateByTermination[scanned.termination],
    incomplete: scanned.termination !== "done",
    preservedThroughSeq: scanned.lastDeltaSeq,
    savedFragments,
  };
}
