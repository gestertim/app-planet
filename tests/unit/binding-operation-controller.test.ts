import { describe, expect, it, vi } from "vitest";
import { BindingOperationController } from "../../apps/web/src/components/auth/binding-operation-controller.ts";
import type { BindingIntent } from "@app-planet/core";
const id = "10000000-0000-4000-8000-000000000001", key = "10000000-0000-4000-8000-000000000002";
const intents: BindingIntent[] = [
  { operation: "create", key, body: { teacher_id: id, student_id: key } },
  { operation: "end", key, target: id, body: { end_reason: "\u3000 合法理由 \u00a0" } },
];
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function setup(fetch: typeof globalThis.fetch, saved = new Map<string, string>(), fail = "") {
  return new BindingOperationController({ storageKey: "scope", fetch,
    storage: {
      getItem: (k) => { if (fail === "read") throw new Error("storage"); return saved.get(k) ?? null; },
      setItem: (k, v) => { if (fail === "write") throw new Error("storage"); saved.set(k, v); },
      removeItem: (k) => { if (fail === "remove") throw new Error("storage"); saved.delete(k); },
    } });
}
const receipt = (intent: BindingIntent, replay = false) => ({
  operation: intent.operation, outcome: replay ? "replayed" : intent.operation === "create" ? "created" : "ended",
  state: intent.operation === "create" ? "active" : "ended", binding_id: id, operated_at: "2026-11-04T08:00:00.000000Z",
});
describe("綁定操作：明確確認與未知結果邊界", () => {
  for (const intent of intents) {
    it.each(["success", "rejection", "parse_failure", "fetch_failure"] as const)(
      `${intent.operation} 離頁後舊請求晚到 %s 不得清除新 instance 的紀錄`,
      async (outcome) => {
        const saved = new Map<string, string>([["scope", JSON.stringify(intent)]]);
        const lateResponse = deferred<Response>(), entered = deferred<void>();
        const old = setup(async () => { entered.resolve(); return lateResponse.promise; }, saved);
        const deactivate = old.activate();
        const unsubscribe = old.subscribe(() => undefined);
        old.restore();
        const oldPending = old.retry();
        await entered.promise;
        unsubscribe();
        deactivate();

        const fresh = setup(async () => Response.json(receipt(intent, true)), saved);
        fresh.activate();
        fresh.restore();
        await fresh.retry();
        const nextIntent = intents.find((candidate) => candidate.operation !== intent.operation)!;
        const nextGate = deferred<Response>(), nextEntered = deferred<void>();
        const next = setup(async () => { nextEntered.resolve(); return nextGate.promise; }, saved);
        next.restore();
        const nextPending = next.start(nextIntent);
        await nextEntered.promise;
        const nextRaw = saved.get("scope");
        expect(nextRaw).toBe(JSON.stringify(nextIntent));

        if (outcome === "success") {
          lateResponse.resolve(Response.json(receipt(intent)));
        } else if (outcome === "rejection") {
          lateResponse.resolve(Response.json({ code: "binding_exists" }, { status: 409 }));
        } else if (outcome === "parse_failure") {
          lateResponse.resolve(new Response("{", { status: 200 }));
        } else {
          lateResponse.reject(new Error("late_response_lost"));
        }
        await oldPending;
        expect(saved.get("scope")).toBe(nextRaw);

        nextGate.reject(new Error("next_response_lost"));
        await nextPending;
        const restored = setup(async () => Response.json(receipt(nextIntent, true)), saved);
        restored.restore();
        expect(restored.getState()).toMatchObject({ status: "unknown", intent: nextIntent });
        await restored.retry();
        expect(restored.getState()).toMatchObject({ status: "success", receipt: receipt(nextIntent, true) });
      },
    );

    it(`${intent.operation} hydration 前不送出、pending 不重複、response-loss reload 原鍵原本文`, async () => {
      const saved = new Map<string, string>(), gate = deferred<Response>();
      const calls: RequestInit[] = [];
      const transport: typeof fetch = async (_url, init) => { calls.push(init!); return calls.length === 1
        ? gate.promise : Response.json(receipt(intent, true)); };
      const controller = setup(transport, saved);
      await controller.start(intent);
      expect(calls).toHaveLength(0);
      controller.restore();
      const pending = controller.start(intent);
      await controller.start(intent); await controller.retry();
      expect(calls).toHaveLength(1);
      gate.reject(new Error("response_lost_after_commit"));
      await pending;
      const raw = saved.get("scope");
      expect(controller.getState().status).toBe("unknown");
      const restored = setup(transport, saved);
      restored.restore();
      await restored.start({ ...intent, key: id });
      expect(calls).toHaveLength(1);
      expect(saved.get("scope")).toBe(raw);
      await restored.retry();
      expect(calls[0]).toMatchObject({ body: calls[1].body, headers: calls[1].headers, method: calls[1].method });
      expect(restored.getState()).toMatchObject({ status: "success", receipt: receipt(intent, true) });
      expect(saved.size).toBe(0);
    });
    it.each(["success", "failure"] as const)(`${intent.operation} 晚到本文 %s 不刪除 closed 原紀錄`, async (outcome) => {
      const saved = new Map<string, string>(), body = deferred<unknown>(), entered = deferred<void>();
      const response = Response.json({});
      vi.spyOn(response, "json").mockImplementation(() => { entered.resolve(); return body.promise; });
      const controller = setup(async () => response, saved);
      controller.restore();
      const pending = controller.start(intent);
      await entered.promise;
      const raw = saved.get("scope");
      controller.close();
      if (outcome === "success") body.resolve(receipt(intent)); else body.reject(new Error("truncated_body"));
      await pending;
      expect(controller.getState().status).toBe("closed");
      expect(saved.get("scope")).toBe(raw);
      const restored = setup(async () => Response.json(receipt(intent, true)), saved);
      restored.restore();
      expect(restored.getState()).toMatchObject({ status: "unknown", intent });
    });
    it(`${intent.operation} storage 寫入失敗不送，清理失敗保留未知，解析失敗同鍵恢復`, async () => {
      let calls = 0;
      const transport: typeof fetch = async () => { calls++; return Response.json(receipt(intent)); };
      const before = setup(transport, new Map(), "write");
      before.restore(); await before.start(intent);
      expect(calls).toBe(0);
      expect(before.getState().message).toContain("尚未送出");
      const saved = new Map<string, string>();
      const cleanup = setup(transport, saved, "remove");
      cleanup.restore(); await cleanup.start(intent);
      expect(cleanup.getState()).toMatchObject({ status: "unknown", intent });
      expect(saved.size).toBe(1);
      const malformed = setup(async () => new Response("{", { status: 200 }), new Map());
      malformed.restore(); await malformed.start(intent);
      expect(malformed.getState()).toMatchObject({ status: "unknown", intent });
    });
  }
  it("StrictMode setup-cleanup-setup 重新啟用同一 controller 且只送出一次", async () => {
    const saved = new Map<string, string>();
    let calls = 0;
    const controller = setup(async () => { calls++; return Response.json(receipt(intents[0]!)); }, saved);
    const firstCleanup = controller.activate();
    controller.restore();
    firstCleanup();
    const secondCleanup = controller.activate();
    controller.restore();
    await controller.start(intents[0]!);
    expect(calls).toBe(1);
    expect(controller.getState().status).toBe("success");
    expect(saved.size).toBe(0);
    secondCleanup();
  });
  it("失權時隱藏 receipt／intent，保留原鍵；讀 storage 失敗或污染停止", async () => {
    const saved = new Map<string, string>();
    const controller = setup(async () => Response.json({}, { status: 403 }), saved);
    controller.restore(); await controller.start(intents[0]);
    expect(controller.getState()).toMatchObject({ status: "closed", receipt: null, intent: null });
    expect(saved.size).toBe(1);
    const corrupt = setup(async () => Response.json({}), new Map([["scope", "{}"]]));
    corrupt.restore(); expect(corrupt.getState().status).toBe("closed");
    const failed = setup(async () => Response.json({}), new Map(), "read");
    failed.restore(); expect(failed.getState().status).toBe("closed");
  });
  it("409 與 404 明確區分已解除及不存在，不當作成功或改送另一關聯", async () => {
    for (const [status, code, text] of [[409, "binding_ended", "舊關聯已解除"], [404, "not_found", "找不到指定關聯"]] as const) {
      const controller = setup(async () => Response.json({ code }, { status }));
      controller.restore(); await controller.start(intents[1]);
      expect(controller.getState()).toMatchObject({ status: "failed", receipt: null, intent: null });
      expect(controller.getState().message).toContain(text);
    }
  });
});
