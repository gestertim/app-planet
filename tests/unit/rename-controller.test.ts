import { describe, expect, it } from "vitest";
import {
  RenameController, createRenameTransport, type RenameIntent, type RenameTransport,
} from "../../apps/web/src/components/project/rename-controller.ts";

const initial = { id: "71000000-0000-4000-8000-000000000001", title: "原名", row_version: 0 };
type Write = Awaited<ReturnType<RenameTransport["write"]>>;
type Read = Awaited<ReturnType<RenameTransport["read"]>>;
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => { resolve = yes; });
  return { promise, resolve };
}
function fixture(transport: Partial<RenameTransport> = {}) {
  const data = new Map<string, string>();
  const writes: { intent: RenameIntent; replay: boolean }[] = [];
  const storage = {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value); },
    removeItem: (key: string) => { data.delete(key); },
  };
  const impl: RenameTransport = {
    read: async () => ({ ok: true, current: initial }),
    write: async (intent, replay) => {
      writes.push({ intent, replay });
      return { ok: true, result: { outcome: replay ? "replayed" : "saved",
        operation: { ...initial, title: intent.body.title, row_version: intent.version + 1 },
        current: { ...initial, title: intent.body.title, row_version: intent.version + 1 } } };
    }, ...transport,
  };
  const make = () => new RenameController(initial, impl, storage, crypto.randomUUID());
  const key = crypto.randomUUID();
  const shared = () => new RenameController(initial, impl, storage, key);
  const c = make(); c.attach();
  return { c, shared, data, writes, storage };
}
const unknown: Write = { ok: false, kind: "unknown", message: "未知" };

describe("P-2 改名控制器", () => {
  it("成功採 current，不把舊 receipt 倒蓋目前名稱；取消不送出", async () => {
    const operation = { ...initial, title: "新名", row_version: 1 };
    const current = { ...initial, title: "後來的名稱", row_version: 2 };
    const { c, data } = fixture({ write: async () => ({ ok: true,
      result: { outcome: "replayed", operation, current } }) });
    c.edit("未保存"); expect(c.cancel()).toBe(true);
    expect(c.getState().editor).toBe("原名");
    c.edit("新名"); expect(await c.save()).toBe(true);
    expect(c.getState()).toMatchObject({ editor: current.title, current, intent: null, status: "success" });
    expect(data.size).toBe(0);
  });
  it("未知結果只允許原鍵／名稱／版本 replay-only，禁止重複保存", async () => {
    const pending = deferred<Write>();
    const sent: { intent: RenameIntent; replay: boolean }[] = [];
    const { c, data } = fixture({ write: (intent, replay) => {
      sent.push({ intent, replay }); return pending.promise;
    } });
    c.edit("新名");
    const save = c.save();
    expect(await c.save()).toBe(false);
    expect(await c.retry()).toBe(false);
    pending.resolve(unknown); await save;
    expect(data.size).toBe(1);
    expect(await c.save()).toBe(false);
    await c.retry();
    expect(sent).toHaveLength(2);
    expect(sent[1]).toEqual({ intent: sent[0].intent, replay: true });
    expect(sent[0].replay).toBe(false);
  });
  it("409 保留輸入及雙方名稱；再次保存必須明確操作並用新鍵／新版本", async () => {
    const sent: RenameIntent[] = [];
    const { c } = fixture({ write: async (intent) => {
      sent.push(intent);
      return { ok: false, kind: "conflict", message: "衝突", conflict: {
        current: { version: 3, content: { title: "其他分頁" } },
        submitted: { version: intent.version, content: intent.body },
      } };
    } });
    c.edit("我的名稱"); await c.save();
    expect(sent).toHaveLength(1);
    expect(c.getState()).toMatchObject({ status: "conflict", editor: "我的名稱",
      current: { title: "其他分頁", row_version: 3 }, intent: null });
    await c.save();
    expect(sent[1].version).toBe(3);
    expect(sent[1].key).not.toBe(sent[0].key);
  });
  it("失權保留原紀錄且不接受新操作", async () => {
    const { c, data } = fixture({ write: async () => ({ ok: false, kind: "closed", message: "失權" }) });
    c.edit("新名"); await c.save();
    expect(c.getState().status).toBe("closed");
    expect(data.size).toBe(1);
    expect(await c.retry()).toBe(false);
    expect(await c.save()).toBe(false);
  });
  it("舊 GET 晚於成功 PATCH，不覆蓋 current；採用 GET 期間續編不丟失", async () => {
    const read = deferred<Read>();
    const { c } = fixture({ read: () => read.promise });
    const refresh = c.refresh(true);
    c.edit("新名"); await c.save();
    read.resolve({ ok: true, current: initial });
    expect(await refresh).toBe(false);
    expect(c.getState().current.title).toBe("新名");
    const next = deferred<Read>();
    const f = fixture({ read: () => next.promise });
    const adopt = f.c.refresh(true);
    f.c.edit("讀取期間續編");
    next.resolve({ ok: true, current: { ...initial, title: "DB", row_version: 2 } });
    await adopt;
    expect(f.c.getState()).toMatchObject({ editor: "讀取期間續編", current: { title: "DB" } });
  });
  it("離頁重入：舊 instance 晚到成功不得清除新 instance 的原操作或解鎖 UI", async () => {
    const pending = deferred<Write>();
    const { shared, data } = fixture({ write: () => pending.promise });
    const old = shared(); old.attach(); old.edit("新名");
    const save = old.save();
    const raw = [...data.values()][0];
    old.detach();
    const next = shared(); next.attach();
    expect(next.getState().status).toBe("unknown");
    pending.resolve({ ok: true, result: { outcome: "saved",
      operation: { ...initial, title: "新名", row_version: 1 },
      current: { ...initial, title: "新名", row_version: 1 } } });
    expect(await save).toBe(false);
    expect([...data.values()]).toContain(raw);
    expect(next.getState().status).toBe("unknown");
    expect(old.getState().status).toBe("saving");
  });
  it("不以目前名稱相同作為 unknown 成功證據；取消不清除未知操作", async () => {
    const { c, data } = fixture({ write: async () => unknown,
      read: async () => ({ ok: true, current: { ...initial, title: "新名", row_version: 1 } }) });
    c.edit("新名"); await c.save(); await c.refresh(true);
    expect(c.getState().status).toBe("unknown");
    expect(c.cancel()).toBe(true);
    expect(data.size).toBe(1);
    expect(await c.save()).toBe(false);
  });
  it("storage 失敗時不送出", async () => {
    let sent = 0;
    const c = new RenameController(initial, { read: async () => ({ ok: true, current: initial }),
      write: async () => { sent++; return unknown; } }, {
      getItem: () => null, setItem: () => { throw Error("storage"); }, removeItem: () => undefined,
    }, crypto.randomUUID());
    c.attach(); c.edit("新名"); await c.save();
    expect(sent).toBe(0);
    expect(c.getState().message).toContain("尚未送出");
  });
  it("舊讀取回報失權後，進行中的成功寫入也不能重開或清除紀錄", async () => {
    const read = deferred<Read>();
    const write = deferred<Write>();
    const { c, data } = fixture({ read: () => read.promise, write: () => write.promise });
    const reading = c.refresh();
    c.edit("新名");
    const saving = c.save();
    read.resolve({ ok: false, kind: "closed", message: "失權" });
    await reading;
    write.resolve({ ok: true, result: { outcome: "saved",
      operation: { ...initial, title: "新名", row_version: 1 },
      current: { ...initial, title: "新名", row_version: 1 } } });
    expect(await saving).toBe(false);
    expect(c.getState().status).toBe("closed");
    expect(data.size).toBe(1);
  });
});

describe("P-2 transport 晚到本文", () => {
  it("原鍵異意圖或 receipt 無法恢復不清除紀錄、不允許盲目換鍵", async () => {
    for (const [status, code] of [[422, "idempotency_key_reuse"], [409, "operation_outcome_unrecoverable"]] as const) {
      const transport = createRenameTransport(initial.id, async () => new Response(JSON.stringify({
        type: "about:blank", title: "拒絕", status, code, instance: "/api", request_id: "synthetic",
        user_message_zh: "原操作無法確認，請保留紀錄。",
      }), { status, headers: { "content-type": "application/problem+json" } }));
      const { c, data } = fixture(transport);
      c.edit("新名");
      await c.save();
      expect(c.getState().status).toBe("unknown");
      expect(data.size).toBe(1);
      expect(await c.save()).toBe(false);
    }
  });
  it("卸載後 response body 晚到不清除重入 instance 紀錄，原鍵重試帶 replay-only", async () => {
    const body = deferred<ReadableStreamDefaultController<Uint8Array>>();
    const stream = new ReadableStream<Uint8Array>({ start(controller) { body.resolve(controller); } });
    const calls: RequestInit[] = [];
    const transport = createRenameTransport(initial.id, async (_url, init) => {
      calls.push(init!);
      return new Response(stream, { status: 200, headers: { "content-type": "application/json", etag: '"1"' } });
    });
    const data = new Map<string, string>();
    const storage = { getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => { data.set(k, v); }, removeItem: (k: string) => { data.delete(k); } };
    const key = crypto.randomUUID();
    const old = new RenameController(initial, transport, storage, key);
    old.attach(); old.edit("新名");
    const saving = old.save();
    await Promise.resolve();
    old.detach();
    const next = new RenameController(initial, transport, storage, key); next.attach();
    const controller = await body.promise;
    controller.enqueue(new TextEncoder().encode(JSON.stringify({ outcome: "saved",
      operation: { ...initial, title: "新名", row_version: 1 },
      current: { ...initial, title: "新名", row_version: 1 } })));
    controller.close();
    expect(await saving).toBe(false);
    expect(data.size).toBe(1);
    expect(next.getState().status).toBe("unknown");
    expect(new Headers(calls[0].headers).get("idempotency-replay-only")).toBeNull();
  });
});
