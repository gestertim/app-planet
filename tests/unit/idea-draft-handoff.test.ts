import { describe, expect, it } from "vitest";
import { canDiscardIdeaDraft, IdeaDraftHandoff, validateIdeaDraft } from "../../apps/web/src/components/project/idea-draft-handoff.ts";
import { StageDraftSaveController } from "../../apps/web/src/components/project/save-controller.ts";

const scope = "synthetic-account-scope";
const key = "11111111-1111-4111-8111-111111111111";
const project = "22222222-2222-4222-8222-222222222222";
const target = { project_id: project, stage: "點子" as const };
const editor = () => new StageDraftSaveController({
  initialTarget: target,
  adapter: { save: async () => { throw new Error("帶入不得呼叫保存"); } },
});

describe("首頁點子暫態交接", () => {
  it("放棄只限已套用、同帳號／專案／階段、尚未保存且無待確認操作的草稿", async () => {
    const controller = editor();
    controller.edit("成功帶入後的編輯");
    const applied = { accountScope: scope, target };
    const state = controller.getState();
    expect(canDiscardIdeaDraft(applied, scope, state)).toBe(true);
    expect(canDiscardIdeaDraft(null, scope, state)).toBe(false);
    expect(canDiscardIdeaDraft(applied, "another-account", state)).toBe(false);
    expect(canDiscardIdeaDraft(applied, scope, { ...state, target: { ...target, project_id: key } })).toBe(false);
    expect(canDiscardIdeaDraft(applied, scope, { ...state, target: { ...target, stage: "A/B" } })).toBe(false);
    expect(canDiscardIdeaDraft(applied, scope, { ...state, dirty: false })).toBe(false);
    const saved = { ...target, row_version: 0, state: "ai_draft" as const,
      content_source: "student_input" as const, content: { text: "" }, approved_by: null, approved_at: null };
    expect(canDiscardIdeaDraft(applied, scope, { ...state, confirmedDraft: saved })).toBe(false);
    const saving = new StageDraftSaveController({
      initialTarget: target,
      adapter: { save: async (request) => ({ target, result: { outcome: "saved",
        operation: { ...saved, content: request.content } } }) },
    });
    saving.edit("帶入");
    const pending = saving.save();
    expect(canDiscardIdeaDraft(applied, scope, saving.getState())).toBe(false);
    await pending;
    saving.edit("保存後再編輯");
    expect(canDiscardIdeaDraft(applied, scope, saving.getState())).toBe(false);
    const conflicting = new StageDraftSaveController({
      initialTarget: target,
      adapter: { save: async () => ({ target, result: { outcome: "conflict", reason: "draft_already_exists" } }) },
    });
    conflicting.edit("帶入");
    await conflicting.save();
    conflicting.compareExistingDraft(saved);
    conflicting.resolveConflict("use_current");
    conflicting.edit("採用已保存內容後的獨立編輯");
    expect(conflicting.getState().operation.status).toBe("idle");
    expect(canDiscardIdeaDraft(applied, scope, conflicting.getState())).toBe(false);
  });

  it("只在原帳號與原操作確認後帶入原文一次，不呼叫保存", () => {
    const handoff = new IdeaDraftHandoff();
    const controller = editor();
    const text = "幫同學找書 📚\n第二行\n尾端空格  ";
    expect(handoff.begin(scope, key, text)).toBe(true);
    expect(handoff.take(scope, controller.getState())).toEqual({ outcome: "unavailable" });
    expect(handoff.confirm(scope, "wrong-key", project)).toBe(false);
    expect(handoff.confirm("another-account", key, project)).toBe(false);
    expect(handoff.confirm(scope, key, project)).toBe(true);
    const result = handoff.take(scope, controller.getState());
    expect(result).toEqual({ outcome: "applied", text });
    if (result.outcome === "applied") controller.edit(result.text);
    expect(controller.getState()).toMatchObject({ dirty: true, confirmedDraft: null, editorText: text });
    expect(handoff.take(scope, controller.getState())).toEqual({ outcome: "unavailable" });
    expect(handoff.confirm(scope, key, project)).toBe(false);
  });

  it("其他專案／階段不會收到；另一帳號使交接失效", () => {
    const handoff = new IdeaDraftHandoff();
    handoff.begin(scope, key, "原文");
    handoff.confirm(scope, key, project);
    const state = editor().getState();
    expect(handoff.take(scope, { ...state, target: { ...target, project_id: key } }).outcome).toBe("unavailable");
    expect(handoff.take(scope, { ...state, target: { ...target, stage: "A/B" } }).outcome).toBe("unavailable");
    expect(handoff.take("another-account", state).outcome).toBe("unavailable");
    expect(handoff.take(scope, state).outcome).toBe("unavailable");
  });

  it("取消、來源卸載或失權後，舊成功回應無法復活草稿", () => {
    for (const clear of ["cancel", "abandon"] as const) {
      const handoff = new IdeaDraftHandoff();
      handoff.begin(scope, key, "原文");
      if (clear === "cancel") handoff.cancel(scope);
      else handoff.abandonUnconfirmed(scope);
      expect(handoff.confirm(scope, key, project)).toBe(false);
    }
    const handoff = new IdeaDraftHandoff();
    handoff.begin(scope, key, "原文");
    handoff.confirm(scope, key, project);
    handoff.cancel();
    expect(handoff.take(scope, editor().getState()).outcome).toBe("unavailable");
  });

  it("既有已保存草稿（含空草稿）及其他未保存編輯都不覆寫，拒絕後也不重套", () => {
    const state = editor().getState();
    const occupied = [
      { ...state, dirty: true, editorText: "另一筆未保存編輯" },
      { ...state, confirmedDraft: { ...target, row_version: 0, state: "ai_draft" as const,
        content_source: "student_input" as const, content: { text: "" }, approved_by: null, approved_at: null } },
      { ...state, operation: { status: "failed" as const, reason: "outcome_unknown" as const,
        retryable: true, submitted: null } },
    ];
    for (const current of occupied) {
      const handoff = new IdeaDraftHandoff();
      handoff.begin(scope, key, "不可覆寫");
      handoff.confirm(scope, key, project);
      expect(handoff.take(scope, current).outcome).toBe("occupied");
      expect(handoff.take(scope, state).outcome).toBe("unavailable");
    }
  });

  it("沿用精確字元驗證與實際 JSON UTF-8 64 KiB 界線，不 trim 或截斷", () => {
    const overhead = new TextEncoder().encode(JSON.stringify({ content: { text: "" } })).byteLength;
    expect(validateIdeaDraft("x".repeat(65536 - overhead))).toBe("valid");
    expect(validateIdeaDraft("x".repeat(65537 - overhead))).toBe("too_large");
    expect(validateIdeaDraft("中".repeat(22000))).toBe("too_large");
    expect(validateIdeaDraft("\n".repeat(32768))).toBe("too_large");
    expect(validateIdeaDraft("\0")).toBe("invalid");
    expect(validateIdeaDraft("\ud800")).toBe("invalid");
    expect(validateIdeaDraft(" \n  ")).toBe("valid");
    expect(new IdeaDraftHandoff().begin(scope, key, "\0")).toBe(false);
  });
});
