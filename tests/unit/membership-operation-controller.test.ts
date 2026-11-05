import { describe, expect, it, vi } from "vitest";
import type { MembershipIntent } from "@app-planet/core";
import { MembershipOperationController } from "../../apps/web/src/components/auth/membership-operation-controller.ts";
const id = "10000000-0000-4000-8000-000000000001", key = "10000000-0000-4000-8000-000000000002";
const intents: MembershipIntent[] = [
  { operation: "create", key, body: { teacher_id: id, school_id: key } },
  { operation: "end", key, target: id, body: {} },
];
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const receipt = (intent: MembershipIntent) => ({ outcome: "replayed", operation: intent.operation,
  membership_id: id, teacher_id: id, school_id: key, state: intent.operation === "create" ? "active" : "ended",
  operated_at: "2026-11-05T01:00:00.000000Z" });
function setup(transport: typeof fetch, storage = new Map<string, string>()) {
  return new MembershipOperationController({ fetch: transport, storageKey: "scope",
    storage: { getItem: (k) => storage.get(k) ?? null, setItem: (k, v) => { storage.set(k, v); },
      removeItem: (k) => { storage.delete(k); } } });
}
describe("歸屬原意圖／生命周期", () => {
  for (const intent of intents) {
    it(`${intent.operation} hydration 前與取消不送出；未知結果重入保留原鍵本文`, async () => {
      const storage = new Map<string, string>(), calls: RequestInit[] = [];
      const transport: typeof fetch = async (_url, init) => {
        calls.push(init!);
        if (calls.length === 1) throw new Error("response_loss_after_commit");
        return Response.json(receipt(intent));
      };
      const c = setup(transport, storage);
      await c.start(intent); expect(calls).toHaveLength(0);
      c.restore(); expect(calls).toHaveLength(0);
      await c.start(intent); expect(c.getState().status).toBe("unknown");
      const next = setup(transport, storage); next.restore();
      await next.start({ ...intent, key: id }); expect(calls).toHaveLength(1);
      await next.retry();
      expect(calls[0]).toMatchObject({ method: calls[1].method, body: calls[1].body, headers: calls[1].headers });
      expect(next.getState()).toMatchObject({ status: "success", intent: null, receipt: receipt(intent) });
      expect(storage.size).toBe(0);
    });
    it.each(["success", "rejection", "parse", "network"] as const)(
      `${intent.operation} 卸載後 %s 晚到不清除新 instance 操作`, async (outcome) => {
        const storage = new Map<string, string>(), gate = deferred<Response>();
        const old = setup(async () => gate.promise, storage);
        const deactivate = old.activate(); old.restore(); const pending = old.start(intent); deactivate();
        const different = { ...intent, key: id };
        storage.set("scope", JSON.stringify(different));
        const fresh = setup(async () => { throw new Error("fresh_unknown"); }, storage); fresh.restore();
        if (outcome === "success") gate.resolve(Response.json(receipt(intent)));
        else if (outcome === "rejection") gate.resolve(Response.json({ code: "membership_ended" }, { status: 409 }));
        else if (outcome === "parse") gate.resolve(new Response("{"));
        else gate.reject(new Error("late"));
        await pending;
        expect(storage.get("scope")).toBe(JSON.stringify(different));
        expect(fresh.getState()).toMatchObject({ status: "unknown", intent: different });
      });
    it(`${intent.operation} 晚到 body／closed 與同 storage key 不同完整原意圖皆保留`, async () => {
      const storage = new Map<string, string>(), body = deferred<unknown>(), entered = deferred<void>();
      const response = Response.json({});
      vi.spyOn(response, "json").mockImplementation(() => { entered.resolve(); return body.promise; });
      const c = setup(async () => response, storage); const deactivate = c.activate(); c.restore();
      const pending = c.start(intent); await entered.promise; deactivate();
      const changed = intent.operation === "create"
        ? { ...intent, body: { teacher_id: key, school_id: id } } : { ...intent, target: key };
      storage.set("scope", JSON.stringify(changed)); body.resolve(receipt(intent)); await pending;
      expect(storage.get("scope")).toBe(JSON.stringify(changed));
      const next = setup(async () => Response.json(receipt(intent)), storage); next.restore(); await next.retry();
      expect(next.getState().status).toBe("unknown");
      expect(storage.get("scope")).toBe(JSON.stringify(changed));
    });
    it(`${intent.operation} 當下失權保留紀錄並隱藏內容`, async () => {
      const storage = new Map<string, string>(), c = setup(async () => new Response(null, { status: 403 }), storage);
      c.restore(); await c.start(intent);
      expect(c.getState()).toMatchObject({ status: "closed", intent: null, receipt: null });
      expect(storage.get("scope")).toBe(JSON.stringify(intent));
    });
  }
});
