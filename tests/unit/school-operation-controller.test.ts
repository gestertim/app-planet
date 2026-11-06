import { describe, expect, it, vi } from "vitest";
import { SchoolOperationController } from "../../apps/web/src/components/auth/school-operation-controller.ts";
const intent = { operation: "create" as const, key: "10000000-0000-4000-8000-000000000001", body: { label: " 合成校 " } };
const receipt = { outcome: "replayed", operation: "create", school_id: intent.key, label: intent.body.label,
  approval_state: "unconfirmed", approval_epoch: 0, valid_until: null, current_doc_version: null,
  operated_at: "2026-11-06T00:00:00.000000Z" };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => { resolve = yes; });
  return { promise, resolve };
}
function setup(fetch: typeof globalThis.fetch, store = new Map<string, string>()) {
  return new SchoolOperationController({ fetch, storageKey: "schools",
    storage: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => { store.set(k, v); },
      removeItem: (k) => { store.delete(k); } } });
}
describe("學校原意圖可靠恢復", () => {
  it("hydration 前／未明確確認不送，unknown reload 原鍵原本文", async () => {
    const store = new Map<string, string>(), calls: RequestInit[] = [];
    const fetch: typeof globalThis.fetch = async (_, init) => {
      calls.push(init!); if (calls.length === 1) throw new Error("response_loss");
      return Response.json(receipt);
    };
    const c = setup(fetch, store); await c.start(intent); expect(calls).toHaveLength(0);
    c.restore(); expect(calls).toHaveLength(0);
    await c.start(intent); expect(c.getState().status).toBe("unknown");
    const next = setup(fetch, store); next.restore(); expect(calls).toHaveLength(1);
    await next.retry(); expect(calls[0]).toMatchObject({ body: calls[1].body, headers: calls[1].headers });
    expect(next.getState().status).toBe("success"); expect(store.size).toBe(0);
  });
  it("舊 instance 晚到 body 不清新操作；清除前核對完整 intent", async () => {
    const store = new Map<string, string>(), body = deferred<unknown>(), entered = deferred<void>();
    const response = Response.json({});
    vi.spyOn(response, "json").mockImplementation(() => { entered.resolve(); return body.promise; });
    const old = setup(async () => response, store), deactivate = old.activate();
    old.restore(); const pending = old.start(intent); await entered.promise; deactivate();
    const changed = { ...intent, body: { label: "另一所同鍵原意圖" } };
    store.set("schools", JSON.stringify(changed)); body.resolve(receipt); await pending;
    expect(store.get("schools")).toBe(JSON.stringify(changed));
    const next = setup(async () => Response.json(receipt), store); next.restore(); await next.retry();
    expect(next.getState().status).toBe("unknown"); expect(store.get("schools")).toBe(JSON.stringify(changed));
    const live = setup(async () => { store.set("schools", JSON.stringify(changed)); return Response.json(receipt); }, store);
    store.clear(); live.restore(); await live.start(intent);
    expect(live.getState().status).toBe("unknown"); expect(store.get("schools")).toBe(JSON.stringify(changed));
  });
  it("失權與錯誤投影不清未知紀錄", async () => {
    for (const response of [new Response(null, { status: 403 }), Response.json({ ...receipt, approval_state: "approved" })]) {
      const store = new Map<string, string>(), c = setup(async () => response, store);
      c.restore(); await c.start(intent); expect(["closed", "unknown"]).toContain(c.getState().status);
      expect(store.has("schools")).toBe(true);
    }
  });
});
