import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  ProjectFileController,
  type ProjectFileTransport,
  type ProjectFileWriteIntent,
  type SessionStore,
} from "../../apps/web/src/components/project/project-file-controller.ts";

const stamp = "2026-11-06T00:00:00.000000Z";
const dto = (path: string, content: string, valueHash?: string) => ({
  path,
  hash: valueHash ?? createHash("sha256").update(content, "utf8").digest("hex"),
  bytes: new TextEncoder().encode(content).byteLength,
  updated_at: stamp,
});
const response = (status: number, body: unknown) => ({
  status, ok: status >= 200 && status < 300, async json() { return body; },
});

class MemoryStorage implements SessionStore {
  private readonly data = new Map<string, string>();
  get length() { return this.data.size; }
  key(index: number) { return [...this.data.keys()][index] ?? null; }
  getItem(key: string) { return this.data.get(key) ?? null; }
  setItem(key: string, value: string) { this.data.set(key, value); }
  removeItem(key: string) { this.data.delete(key); }
}

function controller(
  storage: SessionStore,
  transport: ProjectFileTransport,
  onAccessLost = () => {},
  accountScope = "synthetic-account-scope",
) {
  return new ProjectFileController(
    "10000000-0000-4000-8000-000000000001",
    accountScope,
    transport,
    storage,
    onAccessLost,
  );
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve: (value: T) => resolve(value), reject: (reason: unknown) => reject(reason) };
}

describe("專案原始碼草稿控制器", () => {
  it("新增檔案使用 If-None-Match 語意，DB 成功後保留已保存 hash", async () => {
    let intent: ProjectFileWriteIntent | null = null;
    const transport: ProjectFileTransport = {
      async list() { return response(200, { items: [] }); },
      async read() { return response(404, {}); },
      async write(_path, submitted) {
        intent = submitted;
        return response(201, dto("index.html", "<h1>你好 🌍</h1>"));
      },
    };
    const store = new MemoryStorage();
    const editor = controller(store, transport);
    await editor.initialize(null);
    expect(editor.createDraft("index.html")).toBe(true);
    editor.edit("<h1>你好 🌍</h1>");
    await editor.save();
    expect(intent).toMatchObject({ ifMatch: null, ifNoneMatch: "*", content: "<h1>你好 🌍</h1>" });
    expect(editor.getState()).toMatchObject({
      status: "ready", dirty: false,
      saved_file: { hash: createHash("sha256").update("<h1>你好 🌍</h1>").digest("hex") },
      saved_content: "<h1>你好 🌍</h1>",
    });
  });

  it("保存期間續編不會被較晚成功回應覆蓋", async () => {
    const pending = deferred<Awaited<ReturnType<ProjectFileTransport["write"]>>>();
    const submitted: ProjectFileWriteIntent[] = [];
    const store = new MemoryStorage();
    const transport: ProjectFileTransport = {
      async list() { return response(200, { items: [] }); },
      async read() { return response(404, {}); },
      write(_path, intent) { submitted.push(intent); return pending.promise; },
    };
    const editor = controller(store, transport);
    await editor.initialize(null);
    editor.createDraft("index.js");
    editor.edit("const version = 1;");
    const saving = editor.save();
    editor.edit("const version = 2;");
    pending.resolve(response(201, dto("index.js", "const version = 1;")));
    await saving;
    expect(submitted[0]?.content).toBe("const version = 1;");
    expect(editor.getState()).toMatchObject({
      status: "ready", content: "const version = 2;", saved_content: "const version = 1;", dirty: true,
    });
  });

  it("未知結果以原鍵／原本文重放，不把同文 current 當成功證據", async () => {
    const calls: Array<{ intent: ProjectFileWriteIntent; replayOnly: boolean }> = [];
    const transport: ProjectFileTransport = {
      async list() { return response(200, { items: [] }); },
      async read() { return response(404, {}); },
      async write(_path, intent, replayOnly) {
        calls.push({ intent, replayOnly });
        if (calls.length === 1) throw new Error("synthetic transport loss");
        return response(calls.length === 1 ? 201 : 200, dto("index.html", "保留原始操作"));
      },
    };
    const editor = controller(new MemoryStorage(), transport);
    await editor.initialize(null);
    editor.createDraft("index.html");
    editor.edit("保留原始操作");
    await expect(editor.save()).resolves.toMatchObject({ outcome: "blocked", reason: "retry_required" });
    await editor.retryThenLeave();
    expect(calls).toHaveLength(2);
    expect(calls[1]).toMatchObject({
      intent: { key: calls[0].intent.key, content: "保留原始操作", ifNoneMatch: "*" },
      replayOnly: true,
    });
    expect(editor.getState().dirty).toBe(false);
  });

  it("reload 後重放已提交操作會清除相同內容草稿", async () => {
    const store = new MemoryStorage();
    let originalIntent: ProjectFileWriteIntent | null = null;
    const lostResponseTransport: ProjectFileTransport = {
      async list() { return response(200, { items: [] }); },
      async read() { return response(404, {}); },
      async write(_path, intent) {
        originalIntent = intent;
        throw new Error("synthetic response loss after commit");
      },
    };
    const first = controller(store, lostResponseTransport);
    await first.initialize(null);
    first.createDraft("index.html");
    first.edit("已提交內容");
    await first.save();
    first.dispose();

    let replayIntent: ProjectFileWriteIntent | null = null;
    const replayTransport: ProjectFileTransport = {
      async list() { return response(200, { items: [dto("index.html", "已提交內容")] }); },
      async read() {
        return response(200, { ...dto("index.html", "已提交內容"), content: "已提交內容" });
      },
      async write(_path, intent, replayOnly) {
        replayIntent = replayOnly ? intent : null;
        return response(200, dto("index.html", "已提交內容"));
      },
    };
    const reloaded = controller(store, replayTransport);
    await reloaded.initialize("index.html");
    expect(reloaded.getState()).toMatchObject({ status: "unknown", content: "已提交內容", dirty: true });
    await reloaded.retryThenLeave();
    expect(replayIntent).toEqual(originalIntent);
    expect(reloaded.getState()).toMatchObject({ status: "ready", dirty: false, saved_content: "已提交內容" });
  });

  it("reload 發現同路徑本機草稿與 server 不同時保留雙方並要求明確選擇", async () => {
    const store = new MemoryStorage();
    const localTransport: ProjectFileTransport = {
      async list() { return response(200, { items: [] }); },
      async read() { return response(404, {}); },
      async write() { return response(500, {}); },
    };
    const first = controller(store, localTransport);
    await first.initialize(null);
    first.createDraft("index.html");
    first.edit("本機未保存文字");
    first.dispose();

    const serverTransport: ProjectFileTransport = {
      async list() { return response(200, { items: [dto("index.html", "DB 目前版本")] }); },
      async read() { return response(200, { ...dto("index.html", "DB 目前版本"), content: "DB 目前版本" }); },
      async write() { return response(500, {}); },
    };
    const reloaded = controller(store, serverTransport);
    await reloaded.initialize("index.html");
    expect(reloaded.getState()).toMatchObject({
      status: "conflict", content: "本機未保存文字", dirty: true,
      saved_content: "DB 目前版本", server_conflict: { content: "DB 目前版本" },
    });
  });

  it("sessionStorage 損壞或額度不足時明示限制且不丟失本頁編輯", async () => {
    const corrupt = new MemoryStorage();
    corrupt.setItem("app-planet.project-files.v1.synthetic-account-scope.10000000-0000-4000-8000-000000000001.index", "{");
    const transport: ProjectFileTransport = {
      async list() { return response(200, { items: [] }); },
      async read() { return response(404, {}); },
      async write() { return response(500, {}); },
    };
    const editor = controller(corrupt, transport);
    await editor.initialize(null);
    editor.createDraft("index.html");
    editor.edit("尚未保存");
    expect(editor.getState()).toMatchObject({ content: "尚未保存", dirty: true });
    expect(editor.getState().storage_warning).toContain("恢復受限");

    const full: SessionStore = {
      length: 0, key: () => null, getItem: () => null, removeItem: () => {},
      setItem() { throw new Error("synthetic quota exceeded"); },
    };
    const limited = controller(full, transport);
    await limited.initialize(null);
    limited.createDraft("index.html");
    limited.edit("本頁仍保留");
    expect(limited.getState()).toMatchObject({ content: "本頁仍保留", dirty: true });
    expect(limited.getState().storage_warning).toContain("額度不足");
  });

  it("不同可信帳號 scope 不會讀取彼此的本機草稿", async () => {
    const store = new MemoryStorage();
    const localOnlyTransport: ProjectFileTransport = {
      async list() { return response(200, { items: [] }); },
      async read() { return response(404, {}); },
      async write() { return response(500, {}); },
    };
    const first = controller(store, localOnlyTransport, () => {}, "synthetic-account-one");
    await first.initialize(null);
    first.createDraft("index.html");
    first.edit("只屬於第一個帳號");
    const keyCount = store.length;

    const second = controller(store, localOnlyTransport, () => {}, "synthetic-account-two");
    await second.initialize("index.html");
    expect(second.getState()).toMatchObject({
      files: [], active_path: null, content: "", status: "ready",
    });
    expect(store.length).toBe(keyCount);
  });

  it.each([
    ["body 中斷", async () => { throw new Error("body interrupted"); }],
    ["非法 DTO", async () => ({ ...dto("index.js", "原始操作本文"), path: "other.js" })],
  ])("成功 HTTP 但%s 時保留原鍵與原本文", async (_label, json) => {
    const calls: Array<{ intent: ProjectFileWriteIntent; replayOnly: boolean }> = [];
    const transport: ProjectFileTransport = {
      async list() { return response(200, { items: [] }); },
      async read() { return response(404, {}); },
      async write(_path, intent, replayOnly) {
        calls.push({ intent, replayOnly });
        return calls.length === 1
          ? { status: 201, ok: true, json }
          : response(200, dto("index.js", "原始操作本文"));
      },
    };
    const store = new MemoryStorage();
    const editor = controller(store, transport);
    await editor.initialize(null);
    editor.createDraft("index.js");
    editor.edit("原始操作本文");

    await editor.save();

    expect(editor.getState()).toMatchObject({ status: "unknown", dirty: true });
    editor.edit("續編的新草稿");
    const pending = JSON.parse(store.getItem(
      "app-planet.project-files.v1.synthetic-account-scope.10000000-0000-4000-8000-000000000001.index.js",
    ) ?? "null") as { content: string; pending: ProjectFileWriteIntent | null };
    expect(pending).toMatchObject({ content: "續編的新草稿", pending: { content: "原始操作本文" } });
    await editor.retryThenLeave();
    expect(calls[1]).toMatchObject({
      intent: { key: calls[0]?.intent.key, content: "原始操作本文" },
      replayOnly: true,
    });
    expect(editor.getState()).toMatchObject({
      content: "續編的新草稿", saved_content: "原始操作本文", dirty: true,
    });
  });

  it("非法 JSON 與 unrecoverable 409 都保留原操作，不偽裝成 version conflict", async () => {
    for (const broken of [
      { status: 201, ok: true, async json() { throw new SyntaxError("invalid JSON"); } },
      response(409, { code: "operation_outcome_unrecoverable" }),
    ]) {
      const store = new MemoryStorage();
      const calls: Array<{ intent: ProjectFileWriteIntent; replayOnly: boolean }> = [];
      const transport: ProjectFileTransport = {
        async list() { return response(200, { items: [] }); },
        async read() { return response(404, {}); },
        async write(_path, intent, replayOnly) {
          calls.push({ intent, replayOnly });
          return broken;
        },
      };
      const editor = controller(store, transport);
      await editor.initialize(null);
      editor.createDraft("index.html");
      editor.edit("仍需核對的原操作");
      await editor.save();
      const firstKey = calls[0]?.intent.key;

      expect(editor.getState().status).toBe("unknown");
      await editor.retryThenLeave();
      expect(calls[1]).toMatchObject({
        intent: { key: firstKey, content: "仍需核對的原操作" },
        replayOnly: true,
      });
    }
  });

  it("衝突續編與 reload 不會暗中採用 server current 作為新 CAS 基準", async () => {
    const store = new MemoryStorage();
    const initialHash = dto("index.html", "server H1").hash;
    const seedTransport: ProjectFileTransport = {
      async list() { return response(200, { items: [dto("index.html", "server H1")] }); },
      async read() { return response(200, { ...dto("index.html", "server H1"), content: "server H1" }); },
      async write() { return response(500, {}); },
    };
    const seed = controller(store, seedTransport);
    await seed.initialize("index.html");
    seed.edit("local draft based on H1");
    seed.dispose();

    const currentTransport: ProjectFileTransport = {
      async list() { return response(200, { items: [dto("index.html", "server H2")] }); },
      async read() { return response(200, { ...dto("index.html", "server H2"), content: "server H2" }); },
      async write() { return response(200, dto("index.html", "local draft based on H1")); },
    };
    const conflicted = controller(store, currentTransport);
    await conflicted.initialize("index.html");
    expect(conflicted.getState()).toMatchObject({
      status: "conflict", server_conflict: { content: "server H2" },
    });
    conflicted.edit("local H1 draft continued");
    const savedDraft = JSON.parse(store.getItem(
      "app-planet.project-files.v1.synthetic-account-scope.10000000-0000-4000-8000-000000000001.index.html",
    ) ?? "null") as { base_hash: string | null };
    expect(savedDraft.base_hash).toBe(initialHash);
    conflicted.dispose();

    const reloaded = controller(store, currentTransport);
    await reloaded.initialize("index.html");
    expect(reloaded.getState()).toMatchObject({
      status: "conflict",
      content: "local H1 draft continued",
      saved_content: "server H2",
      server_conflict: { content: "server H2" },
    });
    expect(await reloaded.save()).toMatchObject({ outcome: "blocked", reason: "conflict" });
  });

  it("舊 instance 的成功 body 晚到時不能刪除新 instance 同路徑草稿", async () => {
    const store = new MemoryStorage();
    const delayedBody = deferred<unknown>();
    const oldTransport: ProjectFileTransport = {
      async list() { return response(200, { items: [] }); },
      async read() { return response(404, {}); },
      async write() { return { status: 201, ok: true, json: () => delayedBody.promise }; },
    };
    const old = controller(store, oldTransport);
    await old.initialize(null);
    old.createDraft("index.html");
    old.edit("operation A");
    const oldSave = old.save();
    await Promise.resolve();
    old.dispose();

    const returnedTransport: ProjectFileTransport = {
      async list() { return response(200, { items: [] }); },
      async read() { return response(404, {}); },
      async write(_path, intent, replayOnly) {
        expect(replayOnly).toBe(true);
        return response(200, dto("index.html", intent.content));
      },
    };
    const current = controller(store, returnedTransport);
    await current.initialize("index.html");
    await current.retryThenLeave();
    current.edit("operation B");
    const key = "app-planet.project-files.v1.synthetic-account-scope.10000000-0000-4000-8000-000000000001.index.html";
    const operationB = store.getItem(key);
    delayedBody.resolve(dto("index.html", "operation A"));
    await oldSave;

    expect(store.getItem(key)).toBe(operationB);
    expect(JSON.parse(store.getItem(key) ?? "null")).toMatchObject({ content: "operation B" });
  });

  it("舊 instance 的成功、拒絕、body 與 fetch 晚到均不能改寫替代 instance 草稿", async () => {
    type DeferredWrite = ReturnType<typeof deferred<Awaited<ReturnType<ProjectFileTransport["write"]>>>>;
    const cases = [
      {
        settle: (pending: DeferredWrite) =>
          pending.resolve(response(201, dto("index.html", "operation A"))),
      },
      {
        settle: (pending: DeferredWrite) =>
          pending.resolve(response(400, {
            type: "about:blank", title: "確定拒絕", status: 400, code: "invalid_request",
            instance: "/files/index.html", request_id: "synthetic-late-rejection",
            user_message_zh: "未保存。",
          })),
      },
      {
        settle: (pending: DeferredWrite) =>
          pending.resolve({
            status: 201, ok: true, async json() { throw new SyntaxError("late broken body"); },
          }),
      },
      {
        settle: (pending: DeferredWrite) =>
          pending.reject(new Error("late fetch failure")),
      },
    ];
    for (const late of cases) {
      const store = new MemoryStorage();
      const delayedWrite = deferred<Awaited<ReturnType<ProjectFileTransport["write"]>>>();
      const old = controller(store, {
        async list() { return response(200, { items: [] }); },
        async read() { return response(404, {}); },
        write() { return delayedWrite.promise; },
      });
      await old.initialize(null);
      old.createDraft("index.html");
      old.edit("operation A");
      const oldSave = old.save();
      await Promise.resolve();
      old.dispose();

      const replacement = controller(store, {
        async list() { return response(200, { items: [] }); },
        async read() { return response(404, {}); },
        async write(_path, intent, replayOnly) {
          expect(replayOnly).toBe(true);
          return response(200, dto("index.html", intent.content));
        },
      });
      await replacement.initialize("index.html");
      await replacement.retryThenLeave();
      replacement.edit("operation B");
      const key = "app-planet.project-files.v1.synthetic-account-scope.10000000-0000-4000-8000-000000000001.index.html";
      const operationB = store.getItem(key);
      late.settle(delayedWrite);
      await oldSave;
      expect(store.getItem(key)).toBe(operationB);
      expect(JSON.parse(store.getItem(key) ?? "null")).toMatchObject({ content: "operation B" });
      expect(replacement.getState()).toMatchObject({ content: "operation B", dirty: true });
      replacement.dispose();
    }
  });

  it("§108 E2E 首敗：載入中舊檔案的晚到讀取不能奪回新建草稿，續編不得寫入舊檔案", async () => {
    const prefix = "app-planet.project-files.v1.synthetic-account-scope.10000000-0000-4000-8000-000000000001.";
    const read = deferred<Awaited<ReturnType<ProjectFileTransport["read"]>>>();
    const transport: ProjectFileTransport = {
      async list() { return response(200, { items: [dto("index.html", "<h1>saved</h1>")] }); },
      read() { return read.promise; },
      async write() { throw new Error("此案例不保存"); },
    };
    const store = new MemoryStorage();
    const editor = controller(store, transport);
    await editor.initialize(null);
    const opening = editor.open("index.html");
    expect(editor.createDraft("discard.css")).toBe(true);
    read.resolve(response(200, { ...dto("index.html", "<h1>saved</h1>"), content: "<h1>saved</h1>" }));
    await opening;
    editor.edit("本機草稿必須明確放棄");
    expect(editor.getState()).toMatchObject({
      active_path: "discard.css", content: "本機草稿必須明確放棄", dirty: true, saved_file: null,
    });
    expect(store.getItem(`${prefix}index.html`)).toBeNull();
    expect(JSON.parse(store.getItem(`${prefix}discard.css`) ?? "null")).toMatchObject({ content: "本機草稿必須明確放棄" });
  });

  it("§108 E2E 首敗：清單載入期間新建草稿後，晚到清單不得改開初始 hash 檔案", async () => {
    const list = deferred<Awaited<ReturnType<ProjectFileTransport["list"]>>>();
    let reads = 0;
    const transport: ProjectFileTransport = {
      list() { return list.promise; },
      async read() { reads++; return response(200, { ...dto("index.html", "<h1>saved</h1>"), content: "<h1>saved</h1>" }); },
      async write() { throw new Error("此案例不保存"); },
    };
    const editor = controller(new MemoryStorage(), transport);
    const initializing = editor.initialize("index.html");
    expect(editor.createDraft("new.css")).toBe(true);
    list.resolve(response(200, { items: [dto("index.html", "<h1>saved</h1>")] }));
    await initializing;
    editor.edit("body {}");
    expect(reads).toBe(0);
    expect(editor.getState()).toMatchObject({ active_path: "new.css", content: "body {}", dirty: true });
    expect(editor.getState().files.map((file) => [file.path, file.local_only])).toEqual([
      ["index.html", false], ["new.css", true],
    ]);
  });
  it("§108 F-03：舊 A 已進入 response.json() 後卸載，新實例原鍵確認 A 並留下未知 B，晚到 body 不改 B 且 reload 可原鍵重試", async () => {
    const store = new MemoryStorage();
    const delayedBody = deferred<unknown>();
    let bodyRequested = false;
    let bodyDelivered = false;
    const old = controller(store, {
      async list() { return response(200, { items: [] }); },
      async read() { return response(404, {}); },
      async write() {
        return {
          status: 201, ok: true,
          json: () => {
            bodyRequested = true;
            return delayedBody.promise.finally(() => { bodyDelivered = true; });
          },
        };
      },
    });
    await old.initialize(null);
    old.createDraft("a.html");
    old.edit("operation A");
    const oldSave = old.save();
    await vi.waitFor(() => expect(bodyRequested).toBe(true));
    const keyA = "app-planet.project-files.v1.synthetic-account-scope.10000000-0000-4000-8000-000000000001.a.html";
    const keyB = "app-planet.project-files.v1.synthetic-account-scope.10000000-0000-4000-8000-000000000001.b.js";
    const originalA = JSON.parse(store.getItem(keyA) ?? "null").pending.key as string;
    old.dispose();

    const writes: Array<{ path: string; key: string; replayOnly: boolean }> = [];
    const current = controller(store, {
      async list() { return response(200, { items: [dto("a.html", "operation A")] }); },
      async read() { return response(200, { ...dto("a.html", "operation A"), content: "operation A" }); },
      async write(path, intent, replayOnly) {
        writes.push({ path, key: intent.key, replayOnly });
        if (path === "a.html") return response(200, dto("a.html", intent.content));
        throw new TypeError("synthetic lost response for B");
      },
    });
    await current.initialize("a.html");
    expect(current.getState()).toMatchObject({ status: "unknown", active_path: "a.html" });
    await current.retryThenLeave();
    expect(writes[0]).toEqual({ path: "a.html", key: originalA, replayOnly: true });
    expect(store.getItem(keyA)).toBeNull();
    current.createDraft("b.js");
    current.edit("operation B");
    await current.save();
    expect(current.getState()).toMatchObject({ status: "unknown", active_path: "b.js" });
    const keyBOriginal = JSON.parse(store.getItem(keyB) ?? "null").pending.key as string;
    const before = new Map(Array.from({ length: store.length }, (_, index) => {
      const key = store.key(index)!;
      return [key, store.getItem(key)] as const;
    }));

    delayedBody.resolve(dto("a.html", "operation A"));
    await oldSave;
    expect(bodyDelivered).toBe(true);
    const after = new Map(Array.from({ length: store.length }, (_, index) => {
      const key = store.key(index)!;
      return [key, store.getItem(key)] as const;
    }));
    expect(after).toEqual(before);
    expect(current.getState()).toMatchObject({ status: "unknown", active_path: "b.js", content: "operation B" });
    current.dispose();

    const reloadWrites: Array<{ key: string; replayOnly: boolean; content: string }> = [];
    const reloaded = controller(store, {
      async list() { return response(200, { items: [dto("a.html", "operation A")] }); },
      async read() { return response(404, {}); },
      async write(_path, intent, replayOnly) {
        reloadWrites.push({ key: intent.key, replayOnly, content: intent.content });
        return response(200, dto("b.js", intent.content));
      },
    });
    await reloaded.initialize("b.js");
    expect(reloaded.getState()).toMatchObject({ status: "unknown", content: "operation B" });
    await reloaded.retryThenLeave();
    expect(reloadWrites).toEqual([{ key: keyBOriginal, replayOnly: true, content: "operation B" }]);
    expect(store.getItem(keyB)).toBeNull();
  });
  describe("§108 F-05：送出時固定操作模式並依模式核對成功狀態碼", () => {
    const draftKey = (path: string) =>
      `app-planet.project-files.v1.synthetic-account-scope.10000000-0000-4000-8000-000000000001.${path}`;
    type Call = { intent: ProjectFileWriteIntent; replayOnly: boolean };

    async function unknownAfterTransportLoss(path: string, content: string,
      second: (intent: ProjectFileWriteIntent) => Awaited<ReturnType<ProjectFileTransport["write"]>>) {
      const calls: Call[] = [];
      const store = new MemoryStorage();
      const editor = controller(store, {
        async list() { return response(200, { items: [] }); },
        async read() { return response(404, {}); },
        async write(_path, intent, replayOnly) {
          calls.push({ intent, replayOnly });
          if (calls.length === 1) throw new Error("synthetic transport loss");
          return second(intent);
        },
      });
      await editor.initialize(null);
      editor.createDraft(path);
      editor.edit(content);
      await editor.save();
      expect(editor.getState().status).toBe("unknown");
      return { calls, store, editor };
    }

    it("replay-only 收到合法 DTO 的 201 時不清鍵、維持未知，後續仍以原鍵 replay-only", async () => {
      const content = "replay-only 只接受 200";
      let attempt = 0;
      const { calls, store, editor } = await unknownAfterTransportLoss("index.js", content, () =>
        ++attempt === 1 ? response(201, dto("index.js", content)) : response(200, dto("index.js", content)));
      const before = store.getItem(draftKey("index.js"));
      await editor.retryThenLeave();
      expect(calls[1]).toMatchObject({ replayOnly: true, intent: { key: calls[0]?.intent.key } });
      expect(editor.getState()).toMatchObject({ status: "unknown", dirty: true, saved_file: null });
      expect(store.getItem(draftKey("index.js"))).toBe(before);
      expect(JSON.parse(before ?? "null")).toMatchObject({ pending: { key: calls[0]?.intent.key, content } });

      await editor.retryThenLeave();
      expect(calls[2]).toMatchObject({ replayOnly: true, intent: { key: calls[0]?.intent.key, content } });
      expect(editor.getState()).toMatchObject({ status: "ready", dirty: false, saved_content: content });
      expect(store.getItem(draftKey("index.js"))).toBeNull();
    });

    it("replay-only 收到可信 200 時完成原操作並清除原紀錄", async () => {
      const content = "原鍵重放成功";
      const { calls, store, editor } = await unknownAfterTransportLoss("index.css", content,
        () => response(200, dto("index.css", content)));
      await editor.retryThenLeave();
      expect(calls[1]).toMatchObject({ replayOnly: true, intent: { key: calls[0]?.intent.key, ifNoneMatch: "*" } });
      expect(editor.getState()).toMatchObject({ status: "ready", dirty: false, saved_content: content });
      expect(store.getItem(draftKey("index.css"))).toBeNull();
    });

    it("一般新建首次 201 與同鍵重放 200 都依正式契約完成", async () => {
      for (const status of [201, 200]) {
        const content = `一般新建 ${status}`;
        const calls: Call[] = [];
        const store = new MemoryStorage();
        const editor = controller(store, {
          async list() { return response(200, { items: [] }); },
          async read() { return response(404, {}); },
          async write(_path, intent, replayOnly) {
            calls.push({ intent, replayOnly });
            return response(status, dto("new.html", content));
          },
        });
        await editor.initialize(null);
        editor.createDraft("new.html");
        editor.edit(content);
        await editor.save();
        expect(calls).toHaveLength(1);
        expect(calls[0]).toMatchObject({ replayOnly: false, intent: { ifNoneMatch: "*", ifMatch: null } });
        expect(editor.getState(), String(status)).toMatchObject({ status: "ready", dirty: false, saved_content: content });
        expect(store.getItem(draftKey("new.html"))).toBeNull();
      }
    });

    it("一般 CAS 更新只接受 200；201 與不可信成功 body 均保留原鍵", async () => {
      for (const reply of [
        (content: string) => response(201, dto("index.html", content)),
        () => response(200, { ...dto("index.html", "其他內容") }),
        () => response(200, { ...dto("index.html", "其他內容"), extra: true }),
        () => ({ status: 200, ok: true, async json() { throw new Error("body interrupted"); } }),
      ]) {
        const calls: Call[] = [];
        const store = new MemoryStorage();
        const editor = controller(store, {
          async list() { return response(200, { items: [dto("index.html", "H1")] }); },
          async read() { return response(200, { ...dto("index.html", "H1"), content: "H1" }); },
          async write(_path, intent, replayOnly) {
            calls.push({ intent, replayOnly });
            return reply(intent.content);
          },
        });
        await editor.initialize("index.html");
        editor.edit("CAS 更新本文");
        await editor.save();
        expect(calls[0]).toMatchObject({ replayOnly: false, intent: { ifMatch: dto("index.html", "H1").hash } });
        expect(editor.getState()).toMatchObject({ status: "unknown", dirty: true });
        expect(JSON.parse(store.getItem(draftKey("index.html")) ?? "null"))
          .toMatchObject({ pending: { key: calls[0]?.intent.key, content: "CAS 更新本文" } });
      }
    });

    it("reload 恢復的 pending 一律以 replay-only 送出，且 201 不被承認", async () => {
      const content = "reload 後的原操作";
      const store = new MemoryStorage();
      const first = controller(store, {
        async list() { return response(200, { items: [] }); },
        async read() { return response(404, {}); },
        async write() { throw new Error("synthetic loss"); },
      });
      await first.initialize(null);
      first.createDraft("index.html");
      first.edit(content);
      await first.save();
      first.dispose();
      const saved = store.getItem(draftKey("index.html"));
      const calls: Call[] = [];
      const reloaded = controller(store, {
        async list() { return response(200, { items: [] }); },
        async read() { return response(404, {}); },
        async write(_path, intent, replayOnly) {
          calls.push({ intent, replayOnly });
          return response(201, dto("index.html", content));
        },
      });
      await reloaded.initialize("index.html");
      await reloaded.save();
      expect(calls[0]?.replayOnly).toBe(true);
      expect(reloaded.getState()).toMatchObject({ status: "unknown", dirty: true });
      expect(store.getItem(draftKey("index.html"))).toBe(saved);
    });
  });
});
