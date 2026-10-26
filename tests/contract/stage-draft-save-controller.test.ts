import { describe, expect, it, vi } from "vitest";
import {
  stageDraftIdempotencyKeySchema,
  stageDraftDtoSchema,
  type StageDraftDto,
} from "@app-planet/core";
import {
  StageDraftSaveController,
  type StageDraftSaveAdapter,
  type StageDraftSaveRequest,
  type StageDraftSaveResponse,
} from "../../apps/web/src/components/project/save-controller.ts";

const projectA = "91000000-0000-4000-8000-000000000001";
const projectB = "91000000-0000-4000-8000-000000000002";
const firstKey = "92000000-0000-4000-8000-000000000001";
const secondKey = "92000000-0000-4000-8000-000000000002";
const targetA = { project_id: projectA, stage: "Specification" as const };
const targetB = { project_id: projectB, stage: "Specification" as const };
const targetOtherStage = { project_id: projectA, stage: "UX/UI" as const };

function draft(
  projectId: string,
  stage: StageDraftSaveRequest["stage"],
  rowVersion: number,
  text: string,
): StageDraftDto {
  return {
    project_id: projectId,
    stage,
    row_version: rowVersion,
    state: "ai_draft",
    content_source: "student_input",
    content: { text },
    approved_by: null,
    approved_at: null,
  };
}

function response(
  target: StageDraftSaveResponse["target"],
  result: StageDraftSaveResponse["result"],
): StageDraftSaveResponse {
  return { target, result };
}

function saved(request: StageDraftSaveRequest): StageDraftSaveResponse {
  return response(
    { project_id: request.project_id, stage: request.stage },
    {
      outcome: "saved",
      operation: draft(
        request.project_id,
        request.stage,
        request.expected_row_version === null ? 0 : request.expected_row_version + 1,
        request.content.text,
      ),
    },
  );
}

function conflict(request: StageDraftSaveRequest, version: number, text: string): StageDraftSaveResponse {
  return response(
    { project_id: request.project_id, stage: request.stage },
    {
      outcome: "conflict",
      reason: "version_conflict",
      conflict: {
        current: { version, content: { text } },
        submitted: {
          version: request.expected_row_version,
          content: { text: request.content.text },
        },
      },
    },
  );
}

function malformedConflict(
  request: StageDraftSaveRequest,
  value: unknown,
): StageDraftSaveResponse {
  return {
    target: { project_id: request.project_id, stage: request.stage },
    result: {
      outcome: "conflict",
      reason: "version_conflict",
      conflict: value,
    },
  } as StageDraftSaveResponse;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function controlledAdapter() {
  const calls: {
    request: StageDraftSaveRequest;
    deferred: ReturnType<typeof deferred<StageDraftSaveResponse>>;
  }[] = [];
  const adapter: StageDraftSaveAdapter = {
    save(request) {
      const pending = deferred<StageDraftSaveResponse>();
      calls.push({ request, deferred: pending });
      return pending.promise;
    },
  };
  return { adapter, calls };
}

function controller(
  adapter: StageDraftSaveAdapter,
  initialDraft: StageDraftDto | null = null,
  keys = [firstKey, secondKey],
) {
  let index = 0;
  return new StageDraftSaveController({
    adapter,
    initialTarget: targetA,
    initialDraft,
    createOperationKey: () => keys[index++],
  });
}

describe("T054 傳輸無關階段草稿保存控制器", () => {
  it("區分初始無草稿、既有草稿及相同內容；保存空字串後保留版本 0", async () => {
    const { adapter, calls } = controlledAdapter();
    const emptyController = controller(adapter);
    expect(emptyController.getState()).toMatchObject({
      confirmedDraft: null,
      editorText: "",
      dirty: false,
      operation: { status: "idle" },
    });

    const pending = emptyController.save();
    expect(calls[0].request).toMatchObject({
      expected_row_version: null,
      content: { text: "" },
      idempotency_key: firstKey,
    });
    calls[0].deferred.resolve(saved(calls[0].request));
    await expect(pending).resolves.toMatchObject({ outcome: "saved" });
    expect(emptyController.getState()).toMatchObject({
      confirmedDraft: { row_version: 0, content: { text: "" } },
      editorText: "",
      dirty: false,
      operation: { status: "saved", receipt: { row_version: 0, content: { text: "" } } },
    });

    const existing = draft(projectA, "Specification", 3, "原有文字");
    const sameController = controller(adapter, existing);
    expect(sameController.getState()).toMatchObject({
      confirmedDraft: existing,
      editorText: "原有文字",
      dirty: false,
    });
    await expect(sameController.save()).resolves.toEqual({ outcome: "not_dirty" });
    expect(calls).toHaveLength(1);
  });

  it("保留空白與 Unicode 原文，且固定不可變快照；保存中編輯不被舊成功回應清除", async () => {
    const text = " \t學生 🌍 e\u0301\r\n";
    const { adapter, calls } = controlledAdapter();
    const instance = controller(adapter);
    instance.edit(text);

    const pending = instance.save();
    const request = calls[0].request;
    expect(Object.isFrozen(request)).toBe(true);
    expect(Object.isFrozen(request.content)).toBe(true);
    expect(request.content.text).toBe(text);

    instance.edit("新的記憶體內容");
    calls[0].deferred.resolve(saved(request));
    await expect(pending).resolves.toMatchObject({ outcome: "saved" });

    expect(instance.getState()).toMatchObject({
      confirmedDraft: { row_version: 0, content: { text } },
      editorText: "新的記憶體內容",
      dirty: true,
      operation: { status: "saved", receipt: { content: { text } } },
    });
  });

  it("逾時後保留本文與原 UUID；重試仍送出同一快照，即使編輯器已變更", async () => {
    const { adapter, calls } = controlledAdapter();
    const instance = controller(adapter);
    instance.edit("第一次提交");

    const firstAttempt = instance.save();
    const original = calls[0].request;
    calls[0].deferred.reject(new Error("synthetic timeout"));
    await expect(firstAttempt).resolves.toMatchObject({ outcome: "failed", reason: "outcome_unknown" });
    expect(instance.getState()).toMatchObject({
      editorText: "第一次提交",
      dirty: true,
      operation: { status: "failed", retryable: true },
    });

    instance.edit("後續編輯");
    const retry = instance.retry();
    expect(calls).toHaveLength(2);
    expect(calls[1].request).toEqual(original);
    expect(calls[1].request.idempotency_key).toBe(firstKey);
    expect(calls[1].request.content.text).toBe("第一次提交");
    calls[1].deferred.resolve(saved(original));
    await expect(retry).resolves.toMatchObject({ outcome: "saved" });
    expect(instance.getState()).toMatchObject({
      confirmedDraft: { row_version: 0, content: { text: "第一次提交" } },
      editorText: "後續編輯",
      dirty: true,
    });
  });

  it("依草稿版本保存更新；失敗不更新確認版本也不丟棄本地文字", async () => {
    const { adapter, calls } = controlledAdapter();
    const instance = controller(adapter, draft(projectA, "Specification", 6, "已確認"));
    instance.edit("待保存更新");

    const pending = instance.save();
    expect(calls[0].request.expected_row_version).toBe(6);
    calls[0].deferred.resolve(response(
      targetA,
      { outcome: "failed", reason: "dependency_failure" },
    ));
    await expect(pending).resolves.toMatchObject({ outcome: "failed", reason: "outcome_unknown" });
    expect(instance.getState()).toMatchObject({
      confirmedDraft: { row_version: 6, content: { text: "已確認" } },
      editorText: "待保存更新",
      dirty: true,
      operation: { status: "failed", retryable: true },
    });
  });

  it("衝突保留 current／submitted 與本地編輯，須明確 rebase 才能另行保存", async () => {
    const { adapter, calls } = controlledAdapter();
    const instance = controller(adapter, draft(projectA, "Specification", 2, "伺服器原文"));
    instance.edit("我的本地修改");

    const pending = instance.save();
    calls[0].deferred.resolve(conflict(calls[0].request, 5, "其他裝置的新版本"));
    await expect(pending).resolves.toMatchObject({ outcome: "conflict" });
    expect(instance.getState()).toMatchObject({
      confirmedDraft: { row_version: 5, content: { text: "其他裝置的新版本" } },
      editorText: "我的本地修改",
      dirty: true,
      operation: {
        status: "conflict",
        conflict: {
          current: { version: 5, content: { text: "其他裝置的新版本" } },
          submitted: { version: 2, content: { text: "我的本地修改" } },
        },
      },
    });
    await expect(instance.save()).resolves.toMatchObject({ outcome: "blocked" });

    instance.resolveConflict("keep_local");
    const next = instance.save();
    expect(calls[1].request).toMatchObject({
      expected_row_version: 5,
      content: { text: "我的本地修改" },
      idempotency_key: secondKey,
    });
    calls[1].deferred.resolve(saved(calls[1].request));
    await expect(next).resolves.toMatchObject({ outcome: "saved" });
  });

  it("以原 operation receipt 與較新的 current 分開處理 replay，不覆蓋記憶體編輯", async () => {
    const { adapter, calls } = controlledAdapter();
    const existing = draft(projectA, "Specification", 0, "既有確認內容");
    const instance = controller(adapter, existing);
    instance.edit("第一版提交");
    const pending = instance.save();
    const request = calls[0].request;
    const receipt = draft(projectA, "Specification", 1, "第一版提交");
    const current = draft(projectA, "Specification", 4, "後續伺服器版本");
    calls[0].deferred.resolve(response(targetA, {
      outcome: "replayed",
      operation: receipt,
      current_draft: { outcome: "found", draft: current },
    }));
    await expect(pending).resolves.toMatchObject({ outcome: "replayed" });

    instance.edit("尚未保存的新編輯");
    expect(instance.getState()).toMatchObject({
      confirmedDraft: current,
      editorText: "尚未保存的新編輯",
      dirty: true,
      operation: {
        status: "replayed",
        receipt,
        currentDraft: current,
      },
    });
    expect(instance.getState().confirmedDraft?.row_version).toBeGreaterThan(receipt.row_version);
    expect(request.content.text).toBe(receipt.content.text);
  });

  it("拒絕跨目標、內容／版本矛盾及非法 envelope；保留安全錯誤與原確認版本", async () => {
    const variants: Array<{
      name: string;
      make: (request: StageDraftSaveRequest) => StageDraftSaveResponse;
    }> = [
      {
        name: "跨專案目標",
        make: (request) => response(targetB, {
          outcome: "saved",
          operation: draft(projectA, request.stage, 0, request.content.text),
        }),
      },
      {
        name: "錯誤本文",
        make: (request) => response(targetA, {
          outcome: "saved",
          operation: draft(projectA, request.stage, 0, "不是提交內容"),
        }),
      },
      {
        name: "錯誤版本",
        make: (request) => response(targetA, {
          outcome: "saved",
          operation: draft(
            projectA,
            request.stage,
            request.expected_row_version === null ? 7 : request.expected_row_version,
            request.content.text,
          ),
        }),
      },
      {
        name: "任意 meta",
        make: (request) => ({
          ...saved(request),
          meta: { raw: "不得傳給 UI" },
        } as StageDraftSaveResponse),
      },
    ];

    for (const variant of variants) {
      const { adapter, calls } = controlledAdapter();
      const existing = draft(projectA, "Specification", 8, "目前確認版本");
      const instance = controller(adapter, existing);
      instance.edit("新內容");
      const pending = instance.save();
      calls[0].deferred.resolve(variant.make(calls[0].request));
      await expect(pending).resolves.toMatchObject({
        outcome: "failed",
        reason: "invalid_response",
      });
      expect(instance.getState()).toMatchObject({
        confirmedDraft: existing,
        editorText: "新內容",
        dirty: true,
        operation: { status: "failed", reason: "invalid_response", retryable: true },
      });
      expect(JSON.stringify(instance.getState())).not.toContain("不得傳給 UI");
    }
  });

  it("同資源保存明確序列化為拒絕；不同專案／階段狀態與舊回應互不污染", async () => {
    const { adapter, calls } = controlledAdapter();
    const instance = controller(adapter);
    instance.edit("A 專案內容");
    const saveA = instance.save();
    await expect(instance.save()).resolves.toEqual({ outcome: "blocked", reason: "saving" });
    expect(calls).toHaveLength(1);

    instance.edit("B 專案內容", targetB);
    instance.edit("另一階段內容", targetOtherStage);
    expect(instance.getState(targetB).editorText).toBe("B 專案內容");
    expect(instance.getState(targetOtherStage).editorText).toBe("另一階段內容");

    calls[0].deferred.resolve(saved(calls[0].request));
    await expect(saveA).resolves.toMatchObject({ outcome: "saved" });
    expect(instance.getState(targetB)).toMatchObject({
      confirmedDraft: null,
      editorText: "B 專案內容",
      dirty: true,
    });
    expect(instance.getState(targetOtherStage)).toMatchObject({
      confirmedDraft: null,
      editorText: "另一階段內容",
      dirty: true,
    });
    expect(instance.getState(targetA).confirmedDraft?.content.text).toBe("A 專案內容");
  });

  it("保存後切換只在確認成功且沒有更新中的編輯時完成", async () => {
    const { adapter, calls } = controlledAdapter();
    const instance = controller(adapter);
    instance.edit("原提交");

    const switchPromise = instance.requestSwitch(targetB, "save_then_switch");
    expect(instance.getActiveTarget()).toEqual(targetA);
    instance.edit("保存中新增的內容");
    calls[0].deferred.resolve(saved(calls[0].request));
    await expect(switchPromise).resolves.toEqual({
      outcome: "blocked",
      reason: "still_dirty",
    });
    expect(instance.getActiveTarget()).toEqual(targetA);
    expect(instance.getState()).toMatchObject({
      confirmedDraft: { content: { text: "原提交" } },
      editorText: "保存中新增的內容",
      dirty: true,
    });
  });

  it("保存失敗不完成保存後切換；取消保留內容，明確放棄才清除記憶體編輯", async () => {
    const { adapter, calls } = controlledAdapter();
    const instance = controller(adapter);
    instance.edit("不能因失敗而丟棄");

    const switchPromise = instance.requestSwitch(targetB, "save_then_switch");
    calls[0].deferred.resolve(response(targetA, {
      outcome: "failed",
      reason: "dependency_failure",
    }));
    await expect(switchPromise).resolves.toMatchObject({
      outcome: "blocked",
      reason: "save_failed",
    });
    expect(instance.getActiveTarget()).toEqual(targetA);
    expect(instance.getState().editorText).toBe("不能因失敗而丟棄");

    await expect(instance.requestSwitch(targetB, "keep_and_stay")).resolves.toEqual({
      outcome: "kept",
    });
    expect(instance.getState().editorText).toBe("不能因失敗而丟棄");

    await expect(instance.requestSwitch(targetB, "discard_and_switch")).resolves.toEqual({
      outcome: "switched",
    });
    expect(instance.getActiveTarget()).toEqual(targetB);
    expect(instance.getState(targetA)).toMatchObject({
      editorText: "",
      dirty: false,
      operation: { status: "failed", retryable: true },
    });
  });

  it("版本衝突阻擋保存後切換；採用 current 與保留本地都是明確操作", async () => {
    const { adapter, calls } = controlledAdapter();
    const instance = controller(adapter, draft(projectA, "Specification", 0, "伺服器版本"));
    instance.edit("本地版本");

    const switchPromise = instance.requestSwitch(targetB, "save_then_switch");
    calls[0].deferred.resolve(conflict(calls[0].request, 1, "衝突 current"));
    await expect(switchPromise).resolves.toMatchObject({
      outcome: "blocked",
      reason: "conflict",
    });
    expect(instance.getActiveTarget()).toEqual(targetA);
    expect(instance.getState().editorText).toBe("本地版本");

    instance.resolveConflict("use_current");
    expect(instance.getState()).toMatchObject({
      editorText: "衝突 current",
      dirty: false,
      operation: { status: "idle" },
    });
    await expect(instance.requestSwitch(targetB, "keep_and_stay")).resolves.toEqual({
      outcome: "switched",
    });
  });

  it("正常保存成功後仍可切換，且連續切換依目前資源處理", async () => {
    const { adapter, calls } = controlledAdapter();
    const instance = controller(adapter);
    instance.edit("保存後切換內容");

    const switching = instance.requestSwitch(targetB, "save_then_switch");
    calls[0].deferred.resolve(saved(calls[0].request));
    await expect(switching).resolves.toEqual({ outcome: "switched" });
    expect(instance.getActiveTarget()).toEqual(targetB);
    expect(instance.getState(targetA)).toMatchObject({
      confirmedDraft: { row_version: 0, content: { text: "保存後切換內容" } },
      dirty: false,
    });

    await expect(instance.requestSwitch(targetA, "keep_and_stay")).resolves.toEqual({
      outcome: "switched",
    });
    await expect(instance.requestSwitch(targetOtherStage, "keep_and_stay")).resolves.toEqual({
      outcome: "switched",
    });
    expect(instance.getActiveTarget()).toEqual(targetOtherStage);
  });

  it("pending 保存選擇保留並暫不切換；舊成功只更新原資源且不恢復舊目標", async () => {
    const { adapter, calls } = controlledAdapter();
    const instance = controller(adapter);
    instance.edit("A 的已送出內容");

    const switching = instance.requestSwitch(targetB, "save_then_switch");
    expect(instance.getActiveTarget()).toEqual(targetA);
    await expect(instance.requestSwitch(targetB, "keep_and_stay")).resolves.toEqual({
      outcome: "kept",
    });

    calls[0].deferred.resolve(saved(calls[0].request));
    await expect(switching).resolves.toEqual({ outcome: "superseded" });
    expect(instance.getActiveTarget()).toEqual(targetA);
    expect(instance.getState(targetA)).toMatchObject({
      confirmedDraft: { row_version: 0, content: { text: "A 的已送出內容" } },
      editorText: "A 的已送出內容",
      dirty: false,
      operation: { status: "saved" },
    });
    expect(instance.getState(targetB)).toMatchObject({
      confirmedDraft: null,
      editorText: "",
      dirty: false,
    });
  });

  it("pending 保存被較新目標意圖取代時不切回舊目標；同目標新意圖共用原保存", async () => {
    const { adapter, calls } = controlledAdapter();
    const instance = controller(adapter);
    instance.edit("A 的提交");

    const firstSwitch = instance.requestSwitch(targetB, "save_then_switch");
    const latestSwitch = instance.requestSwitch(targetOtherStage, "save_then_switch");
    expect(calls).toHaveLength(1);
    calls[0].deferred.resolve(saved(calls[0].request));

    await expect(firstSwitch).resolves.toEqual({ outcome: "superseded" });
    await expect(latestSwitch).resolves.toEqual({ outcome: "switched" });
    expect(instance.getActiveTarget()).toEqual(targetOtherStage);
    expect(instance.getState(targetA).confirmedDraft?.content.text).toBe("A 的提交");

    const backToA = instance.requestSwitch(targetA, "keep_and_stay");
    await expect(backToA).resolves.toEqual({ outcome: "switched" });
    instance.edit("回到 A 後的新編輯");
    const sameTargetFirst = instance.requestSwitch(targetB, "save_then_switch");
    const sameTargetLatest = instance.requestSwitch(targetB, "save_then_switch");
    expect(calls).toHaveLength(2);
    calls[1].deferred.resolve(saved(calls[1].request));
    await expect(sameTargetFirst).resolves.toEqual({ outcome: "superseded" });
    await expect(sameTargetLatest).resolves.toEqual({ outcome: "switched" });
    expect(instance.getActiveTarget()).toEqual(targetB);
  });

  it("pending 保存時返回原資源會取消舊切換意圖", async () => {
    const { adapter, calls } = controlledAdapter();
    const instance = controller(adapter);
    instance.edit("原資源內容");

    const switchingAway = instance.requestSwitch(targetB, "save_then_switch");
    await expect(instance.requestSwitch(targetA, "keep_and_stay")).resolves.toEqual({
      outcome: "switched",
    });
    calls[0].deferred.resolve(saved(calls[0].request));

    await expect(switchingAway).resolves.toEqual({ outcome: "superseded" });
    expect(instance.getActiveTarget()).toEqual(targetA);
    expect(instance.getState(targetA).confirmedDraft?.content.text).toBe("原資源內容");
  });

  it("拒絕含非法文字、錯型別或未知欄位的 current／submitted conflict，且無法 use_current", async () => {
    const invalidTexts = ["含 NUL\0文字", "孤立 high \uD800", "孤立 low \uDC00"];
    const invalidVariants: Array<{ name: string; value: (request: StageDraftSaveRequest) => unknown }> = [];
    for (const field of ["current", "submitted"] as const) {
      for (const text of invalidTexts) {
        invalidVariants.push({
          name: `${field} 非法文字`,
          value: (request) => ({
            current: { version: 7, content: { text: "current 合法內容" } },
            submitted: { version: request.expected_row_version, content: { text: request.content.text } },
            [field]: {
              version: field === "current" ? 7 : request.expected_row_version,
              content: { text },
            },
          }),
        });
      }
      invalidVariants.push(
        {
          name: `${field} 內容錯型別`,
          value: (request) => ({
            current: { version: 7, content: { text: "current 合法內容" } },
            submitted: { version: request.expected_row_version, content: { text: request.content.text } },
            [field]: {
              version: field === "current" ? 7 : request.expected_row_version,
              content: { text: 42 },
            },
          }),
        },
        {
          name: `${field} 內容未知欄位`,
          value: (request) => ({
            current: { version: 7, content: { text: "current 合法內容" } },
            submitted: { version: request.expected_row_version, content: { text: request.content.text } },
            [field]: {
              version: field === "current" ? 7 : request.expected_row_version,
              content: { text: field === "current" ? "current 合法內容" : request.content.text, extra: true },
            },
          }),
        },
        {
          name: `${field} envelope 未知欄位`,
          value: (request) => ({
            current: { version: 7, content: { text: "current 合法內容" } },
            submitted: { version: request.expected_row_version, content: { text: request.content.text } },
            [field]: {
              version: field === "current" ? 7 : request.expected_row_version,
              content: { text: field === "current" ? "current 合法內容" : request.content.text },
              extra: true,
            },
          }),
        },
      );
    }

    for (const variant of invalidVariants) {
      const { adapter, calls } = controlledAdapter();
      const existing = draft(projectA, "Specification", 6, "原確認版本");
      const instance = controller(adapter, existing);
      instance.edit("本地 editor 原文");
      const pending = instance.save();
      calls[0].deferred.resolve(malformedConflict(
        calls[0].request,
        variant.value(calls[0].request),
      ));

      await expect(pending, variant.name).resolves.toEqual({
        outcome: "failed",
        reason: "invalid_response",
      });
      expect(instance.getState()).toMatchObject({
        confirmedDraft: existing,
        editorText: "本地 editor 原文",
        dirty: true,
        operation: { status: "failed", reason: "invalid_response" },
      });
      instance.resolveConflict("use_current");
      expect(instance.getState()).toMatchObject({
        confirmedDraft: existing,
        editorText: "本地 editor 原文",
        dirty: true,
        operation: { status: "failed", reason: "invalid_response" },
      });
      expect(stageDraftDtoSchema.safeParse(instance.getState().confirmedDraft).success).toBe(true);
    }
  });

  it("保留合法 conflict 空字串、空白、Unicode 與換行原文", async () => {
    for (const text of ["", " \t  ", "生態 🌱\r\n第二行"]) {
      const { adapter, calls } = controlledAdapter();
      const existing = draft(projectA, "Specification", 6, "原確認版本");
      const instance = controller(adapter, existing);
      instance.edit(text);
      const pending = instance.save();
      calls[0].deferred.resolve(conflict(calls[0].request, 7, text));

      await expect(pending).resolves.toEqual({ outcome: "conflict" });
      expect(instance.getState()).toMatchObject({
        confirmedDraft: { row_version: 7, content: { text } },
        editorText: text,
        operation: { status: "conflict" },
      });
      expect(stageDraftDtoSchema.safeParse(instance.getState().confirmedDraft).success).toBe(true);
      instance.resolveConflict("use_current");
      expect(instance.getState()).toMatchObject({
        confirmedDraft: { row_version: 7, content: { text } },
        editorText: text,
        dirty: false,
      });
    }
  });

  it("adapter 輸入是唯讀快照；編輯操作只改記憶體，沒有意外持久化", async () => {
    const save = vi.fn(async (request: StageDraftSaveRequest) => saved(request));
    const instance = controller({ save });
    instance.edit("只存在記憶體的文字");
    expect(save).not.toHaveBeenCalled();
    await instance.save();
    expect(save).toHaveBeenCalledTimes(1);
    expect(Object.isFrozen(save.mock.calls[0][0])).toBe(true);
    expect(stageDraftIdempotencyKeySchema.safeParse(save.mock.calls[0][0].idempotency_key).success).toBe(true);
  });
});
