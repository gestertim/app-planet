import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
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
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve: (value: T) => resolve(value) };
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
        return response(201, dto("index.html", "保留原始操作"));
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
});
