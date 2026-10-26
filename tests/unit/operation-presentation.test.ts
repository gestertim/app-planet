import { describe, expect, it } from "vitest";
import { presentJobState, presentSaveState, type SaveStateInput } from "../../apps/web/src/components/operation-presentation.ts";

const base: SaveStateInput = {
  operation: { status: "idle" }, dirty: false, connectivity: "online", signal: "none", hasTrustedPrincipal: true,
};
const draft = { row_version: 3 } as never;

describe("T014 操作狀態呈現（純函式）", () => {
  it("無可信 principal 一律關閉並隱藏 server 資料", () => {
    expect(presentSaveState({ ...base, hasTrustedPrincipal: false, dirty: true }))
      .toMatchObject({ kind: "closed", code: "unauthenticated", hideServerData: true, canSave: false });
  });
  it("未修改／未保存／保存中", () => {
    expect(presentSaveState(base).kind).toBe("unmodified");
    expect(presentSaveState({ ...base, dirty: true })).toMatchObject({ kind: "unsaved", canSave: true });
    expect(presentSaveState({ ...base, operation: { status: "saving", submitted: {} as never } }).kind).toBe("saving");
  });
  it("尚無草稿含空本文仍未保存；unknown 優先於尚未首建", () => {
    expect(presentSaveState({ ...base, hasConfirmedDraft: false }))
      .toMatchObject({ kind: "unsaved", code: "never_saved", savedVersion: null, canSave: true });
    expect(presentSaveState({
      ...base, hasConfirmedDraft: false,
      operation: { status: "failed", reason: "outcome_unknown", retryable: true, submitted: null },
    })).toMatchObject({ kind: "outcome_unknown", canSave: false, canRetry: true });
    expect(presentSaveState({
      ...base, hasConfirmedDraft: false,
      operation: { status: "failed", reason: "draft_already_exists", retryable: false, submitted: null },
    })).toMatchObject({ kind: "conflict", code: "draft_already_exists", canSave: false, canRetry: false });
  });
  it("只有 saved／replayed 會顯示已保存", () => {
    expect(presentSaveState({ ...base, operation: { status: "saved", receipt: draft, currentDraft: draft } }))
      .toMatchObject({ kind: "saved", savedVersion: 3 });
    expect(presentSaveState({ ...base, operation: { status: "replayed", receipt: draft, currentDraft: null } }).kind).toBe("saved");
    const others: SaveStateInput[] = [
      { ...base, dirty: true },
      { ...base, operation: { status: "failed", reason: "outcome_unknown", retryable: true, submitted: null } },
      { ...base, operation: { status: "failed", reason: "policy_denied", retryable: false, submitted: null } },
      { ...base, operation: { status: "conflict", conflict: {} as never, submitted: {} as never } },
      { ...base, signal: "session_expired" },
    ];
    for (const input of others) expect(presentSaveState(input).kind).not.toBe("saved");
  });
  it("保存完成後若又編輯，明確顯示新修改未保存並保留已確認版本", () => {
    expect(presentSaveState({
      ...base,
      dirty: true,
      operation: { status: "saved", receipt: draft, currentDraft: draft },
    })).toMatchObject({
      kind: "unsaved",
      code: "unsaved_after_save",
      savedVersion: 3,
      canSave: true,
    });
  });
  it("unknown 不當失敗：結果待確認且只提供同一操作重試", () => {
    const result = presentSaveState({
      ...base, operation: { status: "failed", reason: "outcome_unknown", retryable: true, submitted: null },
    });
    expect(result).toMatchObject({ kind: "outcome_unknown", code: "operation_outcome_unknown", canRetry: true });
    expect(result.nextStep).toContain("同一操作");
  });
  it("離線、登入失效、拒絕、依賴失敗、衝突各有固定碼與下一步", () => {
    const unknown = { status: "failed", reason: "outcome_unknown", retryable: true, submitted: null } as const;
    expect(presentSaveState({ ...base, operation: unknown, connectivity: "offline" })).toMatchObject({ kind: "offline", code: "client_offline" });
    expect(presentSaveState({ ...base, connectivity: "offline", dirty: true })).toMatchObject({
      kind: "offline", canSave: true,
    });
    expect(presentSaveState({ ...base, operation: unknown, signal: "dependency_unavailable" })).toMatchObject({ kind: "dependency_failed" });
    expect(presentSaveState({ ...base, signal: "session_expired" })).toMatchObject({ kind: "denied", hideServerData: true });
    expect(presentSaveState({ ...base, operation: { status: "failed", reason: "policy_denied", retryable: false, submitted: null } }))
      .toMatchObject({ kind: "denied", code: "forbidden", hideServerData: true });
    const conflict = presentSaveState({ ...base, operation: { status: "conflict", conflict: {} as never, submitted: {} as never } });
    expect(conflict).toMatchObject({ kind: "conflict", code: "version_conflict" });
    for (const kind of ["offline", "denied", "conflict"]) expect(kind).toBeTruthy();
  });
  it("202／queued／running 只顯示已接受，不顯示完成", () => {
    for (const state of ["queued", "running"] as const) {
      const result = presentJobState({ state });
      expect(result.kind).toBe("accepted");
      expect(result.title).not.toContain("完成");
    }
    expect(presentJobState({ state: "done" }).kind).not.toBe("saved");
    expect(presentJobState({ state: "unknown" }).kind).toBe("outcome_unknown");
  });
});
