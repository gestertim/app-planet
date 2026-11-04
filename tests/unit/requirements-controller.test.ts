import { describe, expect, it } from "vitest";
import { RequirementsController, type ClassificationTransport } from "../../apps/web/src/components/project/requirements-controller.ts";
import type { ProjectClassificationCurrent } from "@app-planet/core";

const current: ProjectClassificationCurrent = {
  id: "71000000-0000-4000-8000-000000000001", row_version: 0, requirements_revision: 0,
  requested_tier: "A", classification_state: "unconfirmed", requirements: null,
  tier: null, needs_visitor_identity: null, confirmation: null,
};
const requirements = { description: "  原文  ", runtime_needs: "static", runtime_ai_required: false } as const;

type ReadResult = Awaited<ReturnType<ClassificationTransport["read"]>>;
type WriteResult = Awaited<ReturnType<ClassificationTransport["write"]>>;
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const saved = { ...current, requirements, requirements_revision: 1, row_version: 1 };
const newer = { ...saved, requirements: { ...requirements, description: "new" },
  requirements_revision: 2, row_version: 2 };
const savedResult: WriteResult = { ok: true, result: { outcome: "saved",
  operation: { outcome: "saved", requirements: newer.requirements, requirements_revision: 2,
    row_version: 2, changed: true }, current: newer } };

describe("正式需求非同步讀取競態", () => {
  it("A：舊 GET 晚於成功保存，不倒退 current 或誤報 dirty", async () => {
    const read = deferred<ReadResult>();
    const controller = new RequirementsController(saved, {
      read: () => read.promise, write: async () => savedResult,
    }, () => undefined);
    const refresh = controller.refresh();
    controller.edit(newer.requirements);
    await controller.save();
    const afterSave = controller.getState();
    read.resolve({ ok: true, current: saved });
    expect(await refresh).toBe(false);
    expect(controller.getState()).toEqual(afterSave);
    expect(controller.getState().current).toEqual(newer);
    expect(controller.dirty).toBe(false);
    controller.edit({ ...requirements, description: "真正續編" });
    expect(controller.dirty).toBe(true);
  });

  it.each(["save", "confirm", "retry"] as const)("B：舊 GET 不干擾 %s 或其未知結果／原意圖", async (action) => {
    const read = deferred<ReadResult>();
    const write = deferred<WriteResult>();
    const sent: Parameters<ClassificationTransport["write"]>[0][] = [];
    const controller = new RequirementsController(saved, {
      read: () => read.promise, write: (intent) => { sent.push(intent); return write.promise; },
    }, () => undefined);
    if (action === "retry") controller.restore({
      projectId: current.id, key: current.id, version: 1, kind: "requirements",
      body: { expected_requirements_revision: 1, requirements: newer.requirements },
    });
    const refresh = controller.refresh(true);
    if (action === "save") controller.edit(newer.requirements);
    const operation = action === "save" ? controller.save() :
      action === "confirm" ? controller.confirm("A", false, false) : controller.retry();
    const pending = controller.getState();
    read.resolve({ ok: true, current: newer });
    expect(await refresh).toBe(false);
    expect(controller.getState()).toEqual(pending);
    expect(await controller.save()).toBe(false);
    expect(sent).toHaveLength(1);
    write.resolve({ ok: false, kind: "unknown", message: "結果未知" });
    await operation;
    expect(controller.getState()).toMatchObject({ status: "unknown", intent: pending.intent });
    await controller.retry();
    expect(sent[1]).toEqual(sent[0]);
  });

  it.each(["unknown", "conflict"] as const)("B：舊 GET 不能清掉保存後的 %s", async (kind) => {
    const read = deferred<ReadResult>();
    const controller = new RequirementsController(saved, {
      read: () => read.promise, write: async () => ({ ok: false, kind, message: kind }),
    }, () => undefined);
    const refresh = controller.refresh();
    controller.edit(newer.requirements);
    await controller.save();
    const failed = controller.getState();
    read.resolve({ ok: true, current: saved });
    expect(await refresh).toBe(false);
    expect(controller.getState()).toEqual(failed);
  });

  it("C：多個 GET 反向返回，只採用最新請求", async () => {
    const first = deferred<ReadResult>();
    const second = deferred<ReadResult>();
    const reads = [first, second];
    const controller = new RequirementsController(saved, {
      read: () => reads.shift()!.promise, write: async () => savedResult,
    }, () => undefined);
    const a = controller.refresh();
    const b = controller.refresh();
    second.resolve({ ok: true, current: newer });
    expect(await b).toBe(true);
    const latest = controller.getState();
    first.resolve({ ok: true, current: saved });
    expect(await a).toBe(false);
    expect(controller.getState()).toEqual(latest);
  });

  it("讀取中獨立標示；過期故障不清掉新讀取的 pending 或 message", async () => {
    const first = deferred<ReadResult>();
    const second = deferred<ReadResult>();
    const reads = [first, second];
    const controller = new RequirementsController(saved, {
      read: () => reads.shift()!.promise, write: async () => savedResult,
    }, () => undefined);
    const a = controller.refresh();
    const b = controller.refresh();
    expect(controller.getState()).toMatchObject({ reading: true, status: "idle" });
    expect(controller.dirty).toBe(false);
    first.reject(new Error("dependency unavailable"));
    expect(await a).toBe(false);
    expect(controller.getState()).toMatchObject({ reading: true, status: "idle", message: "" });
    second.reject(new Error("dependency unavailable"));
    expect(await b).toBe(false);
    expect(controller.getState()).toMatchObject({ reading: false, status: "unavailable" });
    expect(controller.getState().message).toContain("無法讀取");
  });

  it("過期失權優先於較新有效 GET，關閉不清掉後續已開始讀取", async () => {
    const first = deferred<ReadResult>();
    const second = deferred<ReadResult>();
    const reads = [first, second];
    const controller = new RequirementsController(saved, {
      read: () => reads.shift()!.promise, write: async () => savedResult,
    }, () => undefined);
    const a = controller.refresh();
    const b = controller.refresh();
    first.resolve({ ok: false, kind: "closed", message: "存取已拒絕" });
    await a;
    second.resolve({ ok: true, current: newer });
    expect(await b).toBe(false);
    expect(controller.getState()).toMatchObject({ reading: false, status: "closed", current: saved });
  });

  it("明確放棄離開會使 pending 採用失效，不能重設已清理的 guard", async () => {
    const read = deferred<ReadResult>();
    const controller = new RequirementsController(saved, {
      read: () => read.promise, write: async () => savedResult,
    }, () => undefined);
    controller.edit(newer.requirements);
    const refresh = controller.refresh(true);
    expect(controller.discard()).toBe(true);
    read.resolve({ ok: true, current: newer });
    expect(await refresh).toBe(false);
    expect(controller.getState()).toMatchObject({ reading: false, status: "idle", current: saved });
    expect(controller.dirty).toBe(false);
  });

  it("D：採用等待期間續編保留輸入，必須再次明確採用", async () => {
    const read = deferred<ReadResult>();
    const controller = new RequirementsController(saved, {
      read: () => read.promise, write: async () => savedResult,
    }, () => undefined);
    const refresh = controller.refresh(true);
    controller.edit({ ...requirements, description: "等待期間的新輸入" });
    read.resolve({ ok: true, current: newer });
    await refresh;
    expect(controller.getState()).toMatchObject({
      current: newer, editor: { description: "等待期間的新輸入" }, status: "conflict",
    });
    expect(controller.getState().message).toContain("新輸入");
    expect(controller.dirty).toBe(true);
    await controller.refresh(true);
    expect(controller.getState().editor).toEqual(newer.requirements);
    expect(controller.dirty).toBe(false);
  });

  it("D：編輯後改回原值仍不能被舊採用授權丟棄；一般讀取保留 editor", async () => {
    const read = deferred<ReadResult>();
    const controller = new RequirementsController(saved, {
      read: () => read.promise, write: async () => savedResult,
    }, () => undefined);
    const refresh = controller.refresh(true);
    controller.edit(newer.requirements);
    controller.edit(requirements);
    read.resolve({ ok: true, current: newer });
    await refresh;
    expect(controller.getState().editor).toEqual(requirements);
    await controller.refresh();
    expect(controller.getState().editor).toEqual(requirements);
  });

  it.each(["closed", "unavailable"] as const)("E：有效 %s 讀取不清除未知操作", async (kind) => {
    const controller = new RequirementsController(saved, {
      read: async () => ({ ok: false, kind, message: "讀取失敗" }),
      write: async () => savedResult,
    }, () => undefined);
    controller.restore({ projectId: current.id, key: current.id, version: 1, kind: "requirements",
      body: { expected_requirements_revision: 1, requirements: newer.requirements } });
    const intent = controller.getState().intent;
    expect(await controller.refresh()).toBe(false);
    expect(controller.getState()).toMatchObject({ status: kind, intent, current: saved });
  });

  it("E：即使過期 GET 失權仍關閉；進行中的成功寫入也不能重新開啟", async () => {
    const read = deferred<ReadResult>();
    const write = deferred<WriteResult>();
    const controller = new RequirementsController(saved, {
      read: () => read.promise, write: () => write.promise,
    }, () => undefined);
    const refresh = controller.refresh();
    controller.edit(newer.requirements);
    const operation = controller.save();
    const intent = controller.getState().intent;
    read.resolve({ ok: false, kind: "closed", message: "失權" });
    await refresh;
    expect(controller.getState().status).toBe("closed");
    write.resolve(savedResult);
    await operation;
    expect(controller.getState()).toMatchObject({ status: "closed", intent, current: saved });
    expect(await controller.retry()).toBe(false);
    expect(await controller.refresh()).toBe(false);
    expect(controller.discard()).toBe(false);
  });
});

describe("正式需求 controller", () => {
  it("dirty／無需求／unknown 時不能確認，visitor 無選擇不作 false", async () => {
    const transport: ClassificationTransport = {
      read: async () => ({ ok: true, current }),
      write: async () => ({ ok: false, kind: "unknown", message: "結果未知" }),
    };
    const controller = new RequirementsController(current, transport, () => undefined);
    controller.edit(requirements);
    expect(controller.canConfirm("A", null, false)).toBe(false);
    await controller.save();
    const intent = controller.getState().intent;
    expect(controller.getState().status).toBe("unknown");
    expect(controller.canConfirm("A", false, false)).toBe(false);
    await controller.retry();
    expect(controller.getState().intent).toEqual(intent);
  });

  it("保存中續編不被舊回應蓋掉，原 key／body／雙版本保留", async () => {
    let release!: (value: Awaited<ReturnType<ClassificationTransport["write"]>>) => void;
    const pending = new Promise<Awaited<ReturnType<ClassificationTransport["write"]>>>((resolve) => { release = resolve; });
    const controller = new RequirementsController(current, {
      read: async () => ({ ok: true, current }),
      write: async () => pending,
    }, () => undefined);
    controller.edit(requirements);
    const save = controller.save();
    const intent = controller.getState().intent;
    expect(intent?.version).toBe(0);
    expect(intent?.body.expected_requirements_revision).toBe(0);
    controller.edit({ ...requirements, description: "續編" });
    release({ ok: true, result: {
      outcome: "saved",
      operation: { outcome: "saved", requirements, requirements_revision: 1, row_version: 1, changed: true },
      current: { ...current, requirements, requirements_revision: 1, row_version: 1 },
    } });
    await save;
    expect(controller.getState().editor.description).toBe("續編");
    expect(controller.dirty).toBe(true);
    expect(controller.canConfirm("A", false, false)).toBe(false);
  });

  it("偏好不同必須 explicit_change；未支援需求保持原值", () => {
    const saved = { ...current, requirements, requirements_revision: 1, row_version: 1 };
    const controller = new RequirementsController(saved, {
      read: async () => ({ ok: true, current: saved }),
      write: async () => ({ ok: false, kind: "rejected", message: "不支援" }),
    }, () => undefined);
    expect(controller.canConfirm("B", false, false)).toBe(false);
    expect(controller.canConfirm("B", false, true)).toBe(true);
    expect(controller.canConfirm("A", null, false)).toBe(false);
    controller.edit({ ...requirements, runtime_needs: "restricted_server", runtime_ai_required: true });
    expect(controller.getState().editor).toMatchObject({ runtime_needs: "restricted_server", runtime_ai_required: true });
    expect(controller.canConfirm("A", false, false)).toBe(false);
  });

  it("409 與重新讀取都保留本地文字；明確採用才替換", async () => {
    const saved = { ...current, requirements, requirements_revision: 1, row_version: 1 };
    const newer = { ...saved, requirements: { ...requirements, description: "別分頁的新需求" },
      requirements_revision: 2, row_version: 2 };
    const controller = new RequirementsController(saved, {
      read: async () => ({ ok: true, current: newer }),
      write: async () => ({ ok: false, kind: "conflict", message: "409" }),
    }, () => undefined);
    controller.edit({ ...requirements, description: "本地內容" });
    await controller.save();
    expect(controller.getState()).toMatchObject({ status: "conflict", editor: { description: "本地內容" } });
    await controller.refresh();
    expect(controller.getState().editor.description).toBe("本地內容");
    expect(controller.dirty).toBe(true);
    await controller.refresh(true);
    expect(controller.getState().editor.description).toBe("別分頁的新需求");
    expect(controller.dirty).toBe(false);
  });

  it("不能用舊確認 receipt 恢復 current；unknown reload 仍用原意圖", async () => {
    const saved = { ...current, requirements, requirements_revision: 1, row_version: 1 };
    const next = { ...saved, requirements_revision: 2, row_version: 3,
      requirements: { ...requirements, description: "已修改" } };
    let writes = 0;
    const controller = new RequirementsController(saved, {
      read: async () => ({ ok: true, current: next }),
      write: async () => {
        writes++;
        return { ok: true, result: {
          outcome: "replayed",
          operation: { outcome: "confirmed", tier: "A", needs_visitor_identity: false,
            requirements_revision: 1, row_version: 2,
            confirmation: { id: current.id, requirements_revision: 1,
              confirmed_at: "2026-11-04T00:00:00Z", source: "student_explicit_confirmation" } },
          current: next,
        } };
      },
    }, () => undefined);
    controller.restore({
      projectId: current.id, key: current.id, version: 1, kind: "confirmation",
      body: { expected_requirements_revision: 1, tier: "A", needs_visitor_identity: false,
        requested_tier_acknowledgement: "matches" },
    });
    await controller.refresh();
    expect(controller.getState().status).toBe("unknown");
    await controller.retry();
    expect(writes).toBe(1);
    expect(controller.getState().current.classification_state).toBe("unconfirmed");
    expect(controller.getState().receipt?.outcome).toBe("confirmed");
  });

  it("storage 無法保留原操作時不送出；失權保留原 intent", async () => {
    let writes = 0;
    const transport: ClassificationTransport = {
      read: async () => ({ ok: false, kind: "closed", message: "失權" }),
      write: async () => { writes++; return { ok: false, kind: "closed", message: "失權" }; },
    };
    const failedStorage = new RequirementsController(current, transport, () => { throw new Error("storage failure"); });
    failedStorage.edit(requirements);
    await failedStorage.save();
    expect(writes).toBe(0);
    expect(failedStorage.getState().status).toBe("unavailable");
    const controller = new RequirementsController(current, transport, () => undefined);
    controller.edit(requirements);
    await controller.save();
    expect(controller.getState().status).toBe("closed");
    expect(controller.getState().intent).not.toBeNull();
  });
});
