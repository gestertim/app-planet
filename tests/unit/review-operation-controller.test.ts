import { describe, expect, it, vi } from "vitest";
import { ReviewOperationController } from "../../apps/web/src/components/project/review-operation-controller.ts";

const target = "10000000-0000-4000-8000-000000000001";
const key = "10000000-0000-4000-8000-000000000002";
const body = { decision: "returned", reason: "請補充用途" };
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function setup(transport: typeof fetch, stored = new Map<string, string>(), kind: "submit" | "decide" = "decide") {
  return new ReviewOperationController({
    kind, target, storageKey: "scope", uuid: () => key, fetch: transport,
    storage: { getItem: (k) => stored.get(k) ?? null, setItem: (k, v) => { stored.set(k, v); }, removeItem: (k) => { stored.delete(k); } },
  });
}
describe("明確審查操作控制器", () => {
  for (const kind of ["submit", "decide"] as const) {
    const original = kind === "decide" ? body : {
      expected_draft_version: 7, expected_requirements_revision: 3, expected_classification_id: key,
    };
    it.each(["success", "parse_failure"] as const)(`${kind} 成功標頭後本文 pending→close→%s，逐字保存原意圖供 reload`, async (result) => {
      const stored = new Map<string, string>(), requests: RequestInit[] = [];
      const parsing = deferred<unknown>();
      const entered = deferred<void>();
      const response = Response.json({ outcome: kind === "submit" ? "submitted" : "decided", submission_id: target });
      vi.spyOn(response, "json").mockImplementation(() => { entered.resolve(); return parsing.promise; });
      const transport: typeof fetch = async (_url, init) => {
        requests.push(init!);
        return requests.length === 1 ? response : Response.json({ outcome: "replayed", submission_id: target });
      };
      const controller = setup(transport, stored, kind);
      controller.restore();
      const pending = controller.start(original);
      await entered.promise;
      const raw = stored.get("scope");
      expect(raw).toBeDefined();
      const intent = controller.getState().intent;
      controller.close();
      if (result === "success") parsing.resolve({ outcome: kind === "submit" ? "submitted" : "decided", submission_id: target });
      else parsing.reject(new SyntaxError("truncated_json"));
      await pending;
      expect(controller.getState()).toMatchObject({ status: "closed", intent });
      expect(stored.get("scope")).toBe(raw);
      await controller.retry();
      expect(requests).toHaveLength(1);
      const restored = setup(transport, stored, kind);
      restored.restore();
      expect(restored.getState()).toMatchObject({ status: "unknown", intent });
      await restored.start(kind === "decide" ? { decision: "approved", reason: null } : {
        ...original, expected_draft_version: 8,
      });
      expect(requests).toHaveLength(1);
      await restored.retry();
      expect(requests[1].body).toBe(requests[0].body);
      expect(requests[1].headers).toEqual(requests[0].headers);
      expect(restored.getState().status).toBe("success");
      expect(stored.size).toBe(0);
    });
    it(`${kind} 有效成功清理；清理失敗保留可恢復未知狀態`, async () => {
      const stored = new Map<string, string>();
      const transport: typeof fetch = async () => Response.json({
        outcome: kind === "submit" ? "submitted" : "decided", submission_id: target,
      });
      const valid = setup(transport, stored, kind);
      valid.restore();
      await valid.start(original);
      expect(valid.getState().status).toBe("success");
      expect(stored.size).toBe(0);
      const failedCleanup = new ReviewOperationController({
        kind, target, storageKey: "scope", uuid: () => key, fetch: transport,
        storage: { getItem: (k) => stored.get(k) ?? null, setItem: (k, v) => { stored.set(k, v); },
          removeItem: () => { throw new Error("storage_unavailable"); } },
      });
      failedCleanup.restore();
      await failedCleanup.start(original);
      expect(failedCleanup.getState()).toMatchObject({ status: "unknown", intent: { kind, key, target, body: original } });
      const restored = setup(transport, stored, kind);
      restored.restore();
      expect(restored.getState().intent).toEqual(failedCleanup.getState().intent);
    });
  }
  it("未 hydration 不送出；response-loss／reload 後保留原決定與原鍵，不重試相反決策", async () => {
    const requests: RequestInit[] = [], stored = new Map<string, string>();
    const transport: typeof fetch = async (_url, init) => {
      requests.push(init!);
      if (requests.length === 1) throw new Error("response_lost_after_commit");
      return Response.json({ outcome: "replayed", submission_id: target });
    };
    const controller = setup(transport, stored);
    await controller.start(body);
    expect(requests).toHaveLength(0);
    controller.restore();
    await controller.start(body);
    expect(controller.getState().status).toBe("unknown");
    const restored = setup(transport, stored);
    restored.restore();
    await restored.start({ decision: "approved", reason: null });
    expect(requests).toHaveLength(1);
    await restored.retry();
    expect(requests[0].body).toEqual(requests[1].body);
    expect(requests[0].headers).toEqual(requests[1].headers);
    expect(restored.getState().status).toBe("success");
    expect(stored.size).toBe(0);
  });
  it("同時點擊只送一筆；失權關閉不被晚到成功打開", async () => {
    let resolve!: (response: Response) => void;
    let calls = 0;
    const controller = setup(async () => { calls++; return new Promise((r) => { resolve = r; }); });
    controller.restore();
    const pending = controller.start(body);
    await controller.start(body);
    expect(calls).toBe(1);
    controller.close();
    resolve(Response.json({ outcome: "decided", submission_id: target }));
    await pending;
    expect(controller.getState().status).toBe("closed");
  });
  it("不同 target 的 storage 不自動送出；無效理由明確拒絕", async () => {
    const controller = setup(async () => { throw new Error("not sent"); });
    controller.restore();
    await controller.start({ decision: "returned", reason: " \n" });
    expect(controller.getState().status).toBe("failed");
    const foreign = setup(async () => { throw new Error("not sent"); }, new Map([["scope", JSON.stringify({
      kind: "decide", target: key, key, body,
    })]]));
    foreign.restore();
    expect(foreign.getState().status).toBe("closed");
  });
  it("storage 寫入失敗停止送出，明示尚未送出", async () => {
    const controller = new ReviewOperationController({
      kind: "decide", target, storageKey: "scope", uuid: () => key,
      storage: { getItem: () => null, setItem: () => { throw new Error("quota"); }, removeItem: () => {} },
      fetch: async () => { throw new Error("must not send"); },
    });
    controller.restore();
    await controller.start(body);
    expect(controller.getState()).toMatchObject({ status: "failed", intent: null });
    expect(controller.getState().message).toContain("尚未送出");
  });
});
