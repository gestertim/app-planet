import { describe, expect, it } from "vitest";
import {
  clearIntentSnapshot,
  parseStoredIntent,
  removeIntentIfUnchanged,
  resolveStoredIntents,
  shortOperationId,
} from "../../apps/web/src/components/project/create-project-intent.ts";

const key = "11111111-1111-4111-8111-111111111111";
const intent = { v: 3, key, payload: { title: "專案" } };

describe("建立專案待確認操作：帳號範圍與 replay-only 紀錄", () => {
  it("接受 strict v3 原操作，忽略任何未知或額外欄位的紀錄不得自動送出", () => {
    expect(parseStoredIntent(JSON.stringify(intent))).toEqual({ kind: "intent", intent });
    expect(parseStoredIntent(JSON.stringify({ ...intent, extra: true })))
      .toEqual({ kind: "unusable", reason: "invalid", operationId: key });
    expect(parseStoredIntent(JSON.stringify({ ...intent, payload: { title: "專案", tier: "B" } })).kind)
      .toBe("intent");
    expect(parseStoredIntent(JSON.stringify({ ...intent, payload: { title: "專案", tier: "C" } })).kind)
      .toBe("unusable");
    expect(resolveStoredIntents(JSON.stringify(intent),
      JSON.stringify({ ...intent, payload: { title: "專案", tier: "B" } })))
      .toMatchObject({ kind: "unusable", reason: "conflict" });
  });

  it("現行 strict v2 key／本文可安全轉為 replay-only；舊無版本紀錄不可恢復", () => {
    const previous = {
      v: 2, key, payload: { title: "專案" }, started_server_ms: Date.UTC(2026, 9, 1),
    };
    expect(parseStoredIntent(JSON.stringify(previous))).toEqual({
      kind: "intent",
      intent,
    });
    expect(parseStoredIntent(JSON.stringify({ key, payload: { title: "舊版" } })))
      .toEqual({ kind: "unusable", reason: "legacy", operationId: key });
  });

  it("sessionStorage 舊 v2 單獨存在時保留 key／本文並只解析成 recovery 意圖", () => {
    const old = JSON.stringify({
      v: 2, key, payload: { title: "專案" }, started_server_ms: Date.UTC(2026, 9, 1),
    });
    expect(resolveStoredIntents(old, null)).toEqual({
      kind: "intent",
      intent,
      sources: { session: old, local: null },
    });
  });

  it("只存在 localStorage v3 時可作舊紀錄恢復，兩處相同意圖可安全銜接", () => {
    const current = JSON.stringify(intent);
    expect(resolveStoredIntents(null, current)).toEqual({
      kind: "intent",
      intent,
      sources: { session: null, local: current },
    });
    expect(resolveStoredIntents(current, current)).toEqual({
      kind: "intent",
      intent,
      sources: { session: current, local: current },
    });
  });

  it("不同意圖、損壞或任一處無法解析都阻擋建立且保留兩份來源", () => {
    const other = JSON.stringify({ ...intent, key: "22222222-2222-4222-8222-222222222222" });
    expect(resolveStoredIntents(JSON.stringify(intent), other)).toMatchObject({
      kind: "unusable", reason: "conflict", operationIds: [key, "22222222-2222-4222-8222-222222222222"],
    });
    expect(resolveStoredIntents("{損壞", null)).toMatchObject({ kind: "unusable", reason: "invalid" });
    expect(resolveStoredIntents(JSON.stringify(intent), "{損壞")).toMatchObject({
      kind: "unusable", reason: "invalid",
    });
  });

  it("成功清理只移除仍等於原紀錄的來源，不刪除其他分頁的新意圖", () => {
    let value: string | null = JSON.stringify(intent);
    const storage = {
      getItem: () => value,
      removeItem: () => { value = null; },
    };
    expect(removeIntentIfUnchanged(storage, "key", value)).toBe(true);
    expect(value).toBeNull();

    value = JSON.stringify({ ...intent, key: "22222222-2222-4222-8222-222222222222" });
    expect(removeIntentIfUnchanged(storage, "key", JSON.stringify(intent))).toBe(false);
    expect(value).toContain("22222222-2222-4222-8222-222222222222");
  });

  it("清理使用本次操作快照：首次保存內容與快照一致時清除，沿用舊空快照則保留", () => {
    const raw = JSON.stringify(intent);
    const make = (initial: string | null) => {
      const state = { value: initial, removed: 0 };
      return {
        state,
        storage: {
          getItem: () => state.value,
          removeItem: () => { state.removed++; state.value = null; },
        },
      };
    };
    const session = make(raw);
    const local = make(null);
    expect(clearIntentSnapshot(session.storage, local.storage, "k", { session: raw, local: null }))
      .toBe("cleared");
    expect(session.state.value).toBeNull();
    expect(local.state.removed).toBe(0);

    const stale = make(raw);
    expect(clearIntentSnapshot(stale.storage, make(null).storage, "k", { session: null, local: null }))
      .toBe("changed");
    expect(stale.state.value).toBe(raw);
  });

  it("清理前內容被替換、讀取或移除失敗、移除無效時一律保留紀錄", () => {
    const raw = JSON.stringify(intent);
    const replaced = JSON.stringify({ ...intent, key: "22222222-2222-4222-8222-222222222222" });
    let value: string | null = replaced;
    const sources = { session: raw, local: null };
    const empty = { getItem: () => null, removeItem: () => undefined };
    expect(clearIntentSnapshot({ getItem: () => value, removeItem: () => { value = null; } }, empty, "k", sources))
      .toBe("changed");
    expect(value).toBe(replaced);

    const throwingRead = { getItem: () => { throw new Error("read"); }, removeItem: () => undefined };
    expect(clearIntentSnapshot(throwingRead, empty, "k", sources)).toBe("failed");
    const throwingRemove = { getItem: () => raw, removeItem: () => { throw new Error("write"); } };
    expect(clearIntentSnapshot(throwingRemove, empty, "k", sources)).toBe("failed");
    const noop = { getItem: () => raw, removeItem: () => undefined };
    expect(clearIntentSnapshot(noop, empty, "k", sources)).toBe("changed");
  });

  it("缺欄位、錯誤型別、不合理舊期限與損壞資料均保留代號且停止自動送出", () => {
    const invalid: unknown[] = [
      { ...intent, key: "not-a-uuid" },
      { ...intent, payload: { title: 1 } },
      { ...intent, v: 2, started_server_ms: undefined },
      { ...intent, v: 2, started_server_ms: "now" },
      { ...intent, v: 2, started_server_ms: 0 },
      [], null, 7,
    ];
    for (const value of invalid) {
      expect(parseStoredIntent(JSON.stringify(value)).kind).toBe("unusable");
    }
    expect(parseStoredIntent("{損壞"))
      .toEqual({ kind: "unusable", reason: "invalid", operationId: null });
    expect(shortOperationId(key)).toBe(key.slice(0, 8));
    expect(shortOperationId(null)).toBe("未知");
  });
});
