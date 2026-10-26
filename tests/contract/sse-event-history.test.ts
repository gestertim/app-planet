import { describe, expect, it } from "vitest";
import {
  appendSseEvent,
  deriveMessageState,
  selectReplayEvents,
  validateSseEventHistory,
  type StoredSseEvent,
} from "@app-planet/core";

// 全部為記憶體合成資料；不建立儲存、串流或重放服務，也不證明資料庫持久化或原子性。
type Candidate = { event: string; payload: unknown; outputChecked?: boolean };

const delta = (seq: number, text = `合成片段 ${seq}`): Candidate => ({
  event: "delta",
  payload: { seq, text },
  outputChecked: true,
});
const done = (usage: unknown = { reserved: 1, settled_display: 1 }): Candidate => ({
  event: "done",
  payload: { usage },
});
const partial = (saved_through_seq: number): Candidate => ({
  event: "partial",
  payload: { saved_through_seq },
});
const errorEvent = (code = "generation_failed", retryable = true): Candidate => ({
  event: "error",
  payload: { code, user_message_zh: "合成錯誤提示", retryable },
});
const block = (): Candidate => ({
  event: "block",
  payload: { category_group: "inappropriate", safe_alternative_key: "safe-key" },
});
const support = (): Candidate => ({
  event: "support",
  payload: { level: "support", template_key: "support-key" },
});

function build(...candidates: Candidate[]): StoredSseEvent[] {
  let history: StoredSseEvent[] = [];
  for (const candidate of candidates) {
    const result = appendSseEvent(history, candidate);
    if (!result.ok) {
      throw new Error(`合成事件 ${candidate.event} 無法加入：${result.code}`);
    }
    history = result.events;
  }
  return history;
}

describe("事件序列：加入已檢查並可安全建構的事件", () => {
  it("依序分配自 1 遞增的游標，回傳新陣列且不修改輸入", () => {
    const first = appendSseEvent([], delta(1));
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error("unreachable");
    const before = JSON.stringify(first.events);
    const second = appendSseEvent(first.events, delta(2));
    expect(second.ok).toBe(true);
    if (!second.ok) throw new Error("unreachable");
    expect(second.events.map((event) => event.id)).toEqual([1, 2]);
    expect(second.events).not.toBe(first.events);
    expect(JSON.stringify(first.events)).toBe(before);
  });

  it("只保存 schema 建構後的 payload：額外欄位被拒絕，不被原樣保存", () => {
    expect(
      appendSseEvent([], {
        event: "delta",
        payload: { seq: 1, text: "合成", leaked: "secret-like" },
        outputChecked: true,
      }),
    ).toEqual({ ok: false, code: "invalid_payload" });
  });

  it("未檢查的內容不保存：delta 沒有 outputChecked 或為 false 一律拒絕，且不消耗游標", () => {
    for (const outputChecked of [undefined, false, "true", 1]) {
      expect(
        appendSseEvent([], { event: "delta", payload: { seq: 1, text: "合成" }, outputChecked }),
      ).toEqual({ ok: false, code: "unchecked_content" });
    }
    const history = build(delta(1));
    const rejected = appendSseEvent(history, {
      event: "delta",
      payload: { seq: 2, text: "未檢查" },
      outputChecked: false,
    });
    expect(rejected.ok).toBe(false);
    const next = appendSseEvent(history, delta(2));
    expect(next.ok && next.stored.id).toBe(2);
  });

  it("delta.seq 須自 1 起連續遞增", () => {
    expect(appendSseEvent([], delta(2))).toEqual({ ok: false, code: "delta_seq_gap" });
    expect(appendSseEvent(build(delta(1)), delta(1))).toEqual({ ok: false, code: "delta_seq_gap" });
    expect(appendSseEvent(build(delta(1)), delta(3))).toEqual({ ok: false, code: "delta_seq_gap" });
  });

  it("未知事件名稱、錯誤 payload 與 HTTP 專屬碼的 error 都不被保存", () => {
    expect(appendSseEvent([], { event: "complete", payload: {} })).toEqual({
      ok: false,
      code: "invalid_input",
    });
    expect(appendSseEvent([], { event: "block", payload: { seq: 1, text: "x" } })).toEqual({
      ok: false,
      code: "invalid_payload",
    });
    expect(appendSseEvent([], errorEvent("ai_off_duty", false))).toEqual({
      ok: false,
      code: "invalid_payload",
    });
    expect(appendSseEvent([], errorEvent("web_search_failed", false))).toEqual({
      ok: false,
      code: "invalid_payload",
    });
    expect(appendSseEvent([], null)).toEqual({ ok: false, code: "invalid_input" });
  });

  it.each([block(), support()])("$event → done 仍可加入、驗證及按原 id／payload 重放", (candidate) => {
    const history = build(candidate, done());
    const expected = [
      { id: 1, event: candidate.event, payload: candidate.payload },
      { id: 2, event: "done", payload: done().payload },
    ];
    expect(history).toEqual(expected);
    expect(validateSseEventHistory(history)).toEqual({ ok: true, termination: "done" });
    expect(selectReplayEvents(history)).toEqual({ ok: true, events: expected });
    expect(selectReplayEvents(history, 1)).toEqual({ ok: true, events: [expected[1]] });
    expect(history).toEqual(expected);
  });
});

describe("終止事件互斥與終止後不新增事件", () => {
  const terminals: Array<[string, Candidate[]]> = [
    ["done", [delta(1), done()]],
    ["partial", [delta(1), partial(1)]],
    ["error", [delta(1), errorEvent()]],
  ];
  const followUps: Array<[string, Candidate]> = [
    ["delta", delta(2)],
    ["block", block()],
    ["support", support()],
    ["done", done()],
    ["partial", partial(1)],
    ["error", errorEvent("stream_internal_error", false)],
  ];

  for (const [terminal, candidates] of terminals) {
    it(`${terminal} 之後不得再新增任何事件（含 delta、block、support 與其他終止事件）`, () => {
      const history = build(...candidates);
      for (const [name, followUp] of followUps) {
        expect(appendSseEvent(history, followUp), `${terminal} 之後新增 ${name}`).toEqual({
          ok: false,
          code: "already_terminated",
        });
      }
    });
  }

  it("被拒絕的新增不改變已終止的歷史", () => {
    const history = build(delta(1), errorEvent());
    const before = JSON.stringify(history);
    appendSseEvent(history, done());
    appendSseEvent(history, delta(2));
    expect(JSON.stringify(history)).toBe(before);
    expect(validateSseEventHistory(history)).toEqual({ ok: true, termination: "error" });
  });

  it("單一歷史最多一個終止事件：驗證會拒絕含兩個終止事件或終止後仍有事件的歷史", () => {
    const [firstDelta, errorStored] = build(delta(1), errorEvent());
    const doneAfterError = { id: 3, event: "done", payload: { usage: { reserved: 0, settled_display: 0 } } };
    expect(validateSseEventHistory([firstDelta, errorStored, doneAfterError])).toEqual({
      ok: false,
      code: "multiple_terminal_events",
    });
    const deltaAfterDone = [
      ...build(delta(1), done()),
      { id: 3, event: "delta", payload: { seq: 2, text: "終止後" } },
    ];
    expect(validateSseEventHistory(deltaAfterDone)).toEqual({
      ok: false,
      code: "event_after_terminal",
    });
  });

  it("無終止事件的歷史為 none；不會被當成成功", () => {
    expect(validateSseEventHistory([])).toEqual({ ok: true, termination: "none" });
    expect(validateSseEventHistory(build(delta(1), delta(2)))).toEqual({
      ok: true,
      termination: "none",
    });
  });

  it("歷史必須游標連續、delta 連續且 partial 與最後片段相符", () => {
    expect(
      validateSseEventHistory([{ id: 2, event: "delta", payload: { seq: 1, text: "x" } }]),
    ).toEqual({ ok: false, code: "invalid_history" });
    expect(
      validateSseEventHistory([{ id: 1, event: "delta", payload: { seq: 2, text: "x" } }]),
    ).toEqual({ ok: false, code: "delta_seq_gap" });
    expect(
      validateSseEventHistory([{ id: 1, event: "error", payload: { code: "ai_off_duty" } }]),
    ).toEqual({ ok: false, code: "invalid_payload" });
    expect(validateSseEventHistory("not-history")).toEqual({ ok: false, code: "invalid_input" });
  });
});

describe("partial：停止、逾時或可回報中斷，無片段時為 saved_through_seq:0", () => {
  it("無片段的 partial 可為 0；有片段時必須等於最後片段 seq", () => {
    expect(build(partial(0)).map((event) => event.event)).toEqual(["partial"]);
    expect(build(delta(1), delta(2), delta(3), partial(3))).toHaveLength(4);
    expect(appendSseEvent([], partial(1))).toEqual({ ok: false, code: "partial_seq_mismatch" });
    expect(appendSseEvent(build(delta(1), delta(2)), partial(1))).toEqual({
      ok: false,
      code: "partial_seq_mismatch",
    });
    expect(appendSseEvent(build(delta(1)), partial(0))).toEqual({
      ok: false,
      code: "partial_seq_mismatch",
    });
  });

  it("以成因區分：partial 與 error 互斥，不因片段數改變可用性", () => {
    expect(validateSseEventHistory(build(partial(0)))).toEqual({ ok: true, termination: "partial" });
    expect(validateSseEventHistory(build(errorEvent("generation_failed", false)))).toEqual({
      ok: true,
      termination: "error",
    });
    expect(appendSseEvent(build(partial(0)), errorEvent())).toEqual({
      ok: false,
      code: "already_terminated",
    });
    expect(appendSseEvent(build(errorEvent()), partial(0))).toEqual({
      ok: false,
      code: "already_terminated",
    });
  });
});

describe("已保存歷史重放不算新增生成", () => {
  it("從游標之後重放，沿用原 id 與原 payload，且不改變歷史或終止狀態", () => {
    const history = build(delta(1), delta(2), delta(3), done({ reserved: 5, settled_display: "unknown" }));
    const snapshot = JSON.stringify(history);
    const replay = selectReplayEvents(history, 2);
    expect(replay).toEqual({ ok: true, events: [history[2], history[3]] });
    expect(replay.ok && replay.events.map((event) => event.id)).toEqual([3, 4]);
    expect(JSON.stringify(history)).toBe(snapshot);
    expect(validateSseEventHistory(history)).toEqual({ ok: true, termination: "done" });
  });

  it("重放歷史 done：usage 不重新計算，unknown 維持 unknown 而非 0", () => {
    const history = build(delta(1), done({ reserved: "unknown", settled_display: "unknown" }));
    const replay = selectReplayEvents(history);
    expect(replay.ok && replay.events[1]?.payload).toEqual({
      usage: { reserved: "unknown", settled_display: "unknown" },
    });
  });

  it("安全的 partial 與 error 也沿用原 id 重放", () => {
    const errorHistory = build(delta(1), errorEvent("stream_internal_error", false));
    const replay = selectReplayEvents(errorHistory, 1);
    expect(replay.ok && replay.events).toEqual([
      {
        id: 2,
        event: "error",
        payload: { code: "stream_internal_error", user_message_zh: "合成錯誤提示", retryable: false },
      },
    ]);
    const partialHistory = build(partial(0));
    expect(selectReplayEvents(partialHistory)).toEqual({ ok: true, events: [partialHistory[0]] });
  });

  it("重放終止歷史後，仍不得新增任何事件", () => {
    const history = build(delta(1), errorEvent());
    selectReplayEvents(history);
    expect(appendSseEvent(history, delta(2))).toEqual({ ok: false, code: "already_terminated" });
    expect(appendSseEvent(history, errorEvent())).toEqual({ ok: false, code: "already_terminated" });
  });

  it("游標超前、非整數或負值拒絕；等於最後游標時沒有事件", () => {
    const history = build(delta(1), done());
    expect(selectReplayEvents(history, 2)).toEqual({ ok: true, events: [] });
    for (const cursor of [3, -1, 1.5, "1", Number.NaN]) {
      expect(selectReplayEvents(history, cursor)).toEqual({ ok: false, code: "invalid_cursor" });
    }
  });

  it("重放時缺少終止事件不被讀成成功", () => {
    const history = build(delta(1), delta(2));
    expect(selectReplayEvents(history)).toMatchObject({ ok: true });
    expect(deriveMessageState(history)).toMatchObject({ ok: true, state: "partial", incomplete: true });
  });
});

describe("訊息狀態映射的適用範圍", () => {
  it.each([block(), support()])("$event → done 不推測為 complete，而是明確回未支援映射", (candidate) => {
    expect(deriveMessageState(build(candidate, done()))).toEqual({
      ok: false,
      code: "unsupported_message_state_mapping",
    });
  });

  it.each([block(), support()])("已含 $event 但尚未終止也不猜測訊息狀態", (candidate) => {
    expect(deriveMessageState(build(delta(1), candidate))).toEqual({
      ok: false,
      code: "unsupported_message_state_mapping",
    });
  });

  it.each([
    {
      name: "事件格式錯誤",
      history: [...build(block()), null],
      code: "invalid_history",
    },
    {
      name: "游標不連續",
      history: [...build(support()), { id: 3, event: "done", payload: done().payload }],
      code: "invalid_history",
    },
    {
      name: "payload 錯誤",
      history: [{ id: 1, event: "block", payload: {} }],
      code: "invalid_payload",
    },
    {
      name: "delta 序號錯誤",
      history: [...build(support()), { id: 2, event: "delta", payload: delta(2).payload }],
      code: "delta_seq_gap",
    },
    {
      name: "partial 與已保存片段不符",
      history: [...build(block()), { id: 2, event: "partial", payload: partial(1).payload }],
      code: "partial_seq_mismatch",
    },
    {
      name: "多個終止事件",
      history: [...build(support(), done()), { id: 3, event: "error", payload: errorEvent().payload }],
      code: "multiple_terminal_events",
    },
    {
      name: "終止後仍有事件",
      history: [...build(done()), { id: 2, event: "block", payload: block().payload }],
      code: "event_after_terminal",
    },
  ])("含 block／support 的非法歷史先回原有驗證錯誤：$name", ({ history, code }) => {
    expect(deriveMessageState(history)).toEqual({ ok: false, code });
  });
});

describe("已支援歷史對訊息狀態的純映射", () => {
  it("error → failed；已檢查並保存的片段保留可讀，明示未完成，不標 complete", () => {
    const state = deriveMessageState(build(delta(1, "第一句"), delta(2, "第二句"), errorEvent()));
    expect(state).toEqual({
      ok: true,
      termination: "error",
      state: "failed",
      incomplete: true,
      preservedThroughSeq: 2,
      savedFragments: [
        { seq: 1, text: "第一句" },
        { seq: 2, text: "第二句" },
      ],
    });
  });

  it("error 且無片段：failed、preservedThroughSeq 為 0，不虛構內容", () => {
    expect(deriveMessageState(build(errorEvent("web_search_failed", true)))).toEqual({
      ok: true,
      termination: "error",
      state: "failed",
      incomplete: true,
      preservedThroughSeq: 0,
      savedFragments: [],
    });
  });

  it("未檢查內容從未進入歷史，因此不會出現在保存成果", () => {
    const history = build(delta(1, "已檢查"));
    const rejected = appendSseEvent(history, {
      event: "delta",
      payload: { seq: 2, text: "未檢查的內容" },
      outputChecked: false,
    });
    expect(rejected.ok).toBe(false);
    const withError = appendSseEvent(history, errorEvent("safety_check_unavailable", true));
    expect(withError.ok).toBe(true);
    const state = withError.ok ? deriveMessageState(withError.events) : null;
    expect(state).toMatchObject({ state: "failed", preservedThroughSeq: 1 });
    expect(JSON.stringify(state)).not.toContain("未檢查的內容");
  });

  it("其餘終止的對應：done → complete、partial → partial、無終止 → partial（H-4 先寫入狀態）", () => {
    expect(deriveMessageState(build(delta(1), done()))).toMatchObject({
      state: "complete",
      incomplete: false,
      preservedThroughSeq: 1,
    });
    expect(deriveMessageState(build(delta(1), delta(2), partial(2)))).toMatchObject({
      state: "partial",
      incomplete: true,
      preservedThroughSeq: 2,
    });
    expect(deriveMessageState([])).toMatchObject({
      termination: "none",
      state: "partial",
      incomplete: true,
    });
  });

  it("無效歷史不映射", () => {
    expect(deriveMessageState("bad")).toEqual({ ok: false, code: "invalid_input" });
    expect(
      deriveMessageState([{ id: 1, event: "delta", payload: { seq: 2, text: "x" } }]),
    ).toEqual({ ok: false, code: "delta_seq_gap" });
  });
});
