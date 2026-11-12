import { createElement, type ComponentType, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  createGuidedIdeaFlow, formatGuidedIdeaCard, resolveSuggestedProjectTitle, type GuidedIdea, type GuidedIdeaAction,
} from "../../apps/web/src/components/student/guided-idea.ts";
import { IdeaDraftHandoff } from "../../apps/web/src/components/project/idea-draft-handoff.ts";
import { StageDraftSaveController } from "../../apps/web/src/components/project/save-controller.ts";
import { createHttpSaveAdapter } from "../../apps/web/src/components/project/http-save-adapter.ts";
import { stageDraftContentSchema, stageDraftDtoSchema, type StageDraftDto } from "@app-planet/core";

const idea: GuidedIdea = {
  name: "", audience: "需要整理物品的人", problem: "找不到物品\nApp 名稱：這是學生原文",
  features: ["記錄位置 📚", "搜尋物品"],
};
const scope = "synthetic-student-a";
const key = "11111111-1111-4111-8111-111111111111";
const project = "22222222-2222-4222-8222-222222222222";
const target = { project_id: project, stage: "點子" as const };
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
  usePathname: () => "/student",
}));
const { GuidedIdeaPanel } = await vi.importActual<{
  GuidedIdeaPanel: ComponentType<{
    flow: ReturnType<typeof createGuidedIdeaFlow>; error: string; carried: boolean; disabled: boolean;
    onAction: (action: GuidedIdeaAction) => void; onPreview: () => void; onCarry: () => void; onCancel: () => void;
  }>;
}>("../../apps/web/src/components/student/guided-idea-panel.tsx");
const { StudentCreationSpace } = await vi.importActual<{
  StudentCreationSpace: ComponentType<{ children: ReactNode; storageScope: string }>;
}>("../../apps/web/src/components/student/creation-space.tsx");

describe("Guided Idea 名稱：純函式／合成 contract，非 DOM 互動", () => {
  it("NC-01：自動建議可更新、取消清空、重新確認不沿用舊名", () => {
    let title = resolveSuggestedProjectTitle("", "舊名", false);
    title = resolveSuggestedProjectTitle(title, "新名", false);
    expect(title).toBe("新名");
    title = resolveSuggestedProjectTitle(title, "", false);
    expect(title).toBe("");
    expect(resolveSuggestedProjectTitle(title, "重新確認", false)).toBe("重新確認");
  });

  it("NC-02：學生自行修改或手動清空，均不套用新建議", () => {
    expect(resolveSuggestedProjectTitle("自己的名稱", "新建議", true)).toBe("自己的名稱");
    expect(resolveSuggestedProjectTitle("", "新建議", true)).toBe("");
    expect(resolveSuggestedProjectTitle("", "", true)).toBe("");
  });

  it("NC-03：未命名卡片使用最後名稱，不替換其他回答中的同名文字", () => {
    const result = formatGuidedIdeaCard(idea, "整理星球 🌍");
    expect(result.outcome).toBe("ready");
    if (result.outcome !== "ready") throw new Error("應產生最終卡片");
    expect(result.text).toContain("App 名稱：整理星球 🌍");
    expect(result.text).not.toContain("尚未填寫");
    expect(result.text).toContain(`想解決的問題：${idea.problem}`);
    expect(result.text).toContain(`想幫助的人：${idea.audience}`);
    expect(result.text).toContain("1. 記錄位置 📚\n2. 搜尋物品");
    expect(idea.name).toBe("");
    expect(stageDraftContentSchema.safeParse({ text: result.text }).success).toBe(true);
  });

  it("不同名稱會明列原卡片暫名，而不無聲刪除已確認資訊", () => {
    const named = { ...idea, name: "原卡片名稱" };
    const result = formatGuidedIdeaCard(named, "最後確認名稱");
    expect(result).toMatchObject({ outcome: "ready",
      text: expect.stringContaining("App 名稱：最後確認名稱\n已確認的卡片暫名：原卡片名稱") });
    expect(named.name).toBe("原卡片名稱");
    expect(formatGuidedIdeaCard(named, named.name)).toMatchObject({
      outcome: "ready", text: expect.not.stringContaining("已確認的卡片暫名"),
    });
  });

  it("最終名稱及額外暫名行都計入 JSON UTF-8 的精確 64 KiB 邊界", () => {
    const initial = formatGuidedIdeaCard(idea, "");
    if (initial.outcome !== "ready") throw new Error("應產生基礎卡片");
    const overhead = new TextEncoder().encode(JSON.stringify({ content: { text: initial.text } })).byteLength;
    expect(formatGuidedIdeaCard(idea, "x".repeat(65536 - overhead)).outcome).toBe("ready");
    expect(formatGuidedIdeaCard(idea, "x".repeat(65537 - overhead))).toEqual({ outcome: "too_large" });
    expect(formatGuidedIdeaCard(idea, "\ud800")).toEqual({ outcome: "invalid" });
    expect(formatGuidedIdeaCard({ ...idea, name: "舊".repeat(22000) }, "新")).toEqual({ outcome: "too_large" });
  });

  it("NC-04／NC-05：已綁定操作快照不隨卡片變動，不能開始第二次交接", () => {
    const handoff = new IdeaDraftHandoff();
    const card = formatGuidedIdeaCard(idea, "原操作名稱");
    if (card.outcome !== "ready") throw new Error("應產生卡片");
    const operation = { key, payload: { title: "原操作名稱" } };
    const snapshot = JSON.stringify(operation);
    expect(handoff.begin(scope, operation.key, card.text)).toBe(true);
    const changed = formatGuidedIdeaCard({ ...idea, problem: "之後修改" }, "之後名稱");
    if (changed.outcome !== "ready") throw new Error("應產生修改卡片");
    expect(handoff.begin(scope, operation.key, changed.text)).toBe(false);
    expect(JSON.stringify(operation)).toBe(snapshot);
    expect(handoff.confirm(scope, "wrong-key", project)).toBe(false);
    expect(handoff.confirm(scope, key, project)).toBe(true);
    const controller = new StageDraftSaveController({ initialTarget: target,
      adapter: { save: async () => { throw new Error("交接不可自動保存"); } } });
    expect(handoff.take(scope, controller.getState())).toEqual({ outcome: "applied", text: card.text });
    expect(handoff.take(scope, controller.getState())).toEqual({ outcome: "unavailable" });
  });

  it("NC-06：取消後晚到、跨帳號及跨專案不能交接舊卡", () => {
    const handoff = new IdeaDraftHandoff();
    const controller = new StageDraftSaveController({ initialTarget: target,
      adapter: { save: async () => { throw new Error("不可保存"); } } });
    handoff.begin(scope, key, "舊卡");
    handoff.cancel(scope);
    expect(handoff.confirm(scope, key, project)).toBe(false);
    handoff.begin(scope, key, "新卡");
    handoff.confirm(scope, key, project);
    expect(handoff.take(scope, { ...controller.getState(), target: { ...target, project_id: key } }).outcome)
      .toBe("unavailable");
    expect(handoff.take("synthetic-student-b", controller.getState()).outcome).toBe("unavailable");
    expect(handoff.take(scope, controller.getState()).outcome).toBe("unavailable");
  });

  it("GD-13／GD-14／GD-16：合成 adapter 手動保存最終卡片、重新讀回及 scope 隔離", async () => {
    const records = new Map<string, StageDraftDto>();
    let writes = 0;
    const card = formatGuidedIdeaCard(idea, "最後確認名稱");
    if (card.outcome !== "ready") throw new Error("應產生最終卡片");
    const adapter = createHttpSaveAdapter({
      buildUrl: () => "/synthetic-stage-draft",
      fetchImpl: async (_url, init) => {
        expect(init?.method).toBe("PUT");
        expect(new Headers(init?.headers).get("if-none-match")).toBe("*");
        const body: unknown = JSON.parse(String(init?.body));
        const parsed = stageDraftDtoSchema.parse({
          ...target, row_version: 0, state: "ai_draft", content_source: "student_input",
          content: stageDraftContentSchema.parse(
            body !== null && typeof body === "object" && "content" in body ? body.content : null),
          approved_by: null, approved_at: null,
        });
        records.set(`${scope}:${project}`, parsed);
        writes++;
        return new Response(JSON.stringify(parsed), { status: 201 });
      },
    });
    const controller = new StageDraftSaveController({ initialTarget: target, adapter });
    controller.edit(card.text);
    expect(writes).toBe(0);
    expect(controller.getState().confirmedDraft).toBeNull();
    expect((await controller.save()).outcome).toBe("saved");
    expect(writes).toBe(1);
    const readBack = records.get(`${scope}:${project}`);
    expect(readBack?.content.text).toBe(card.text);
    const reopened = new StageDraftSaveController({ initialTarget: target, adapter, initialDraft: readBack });
    expect(reopened.getState()).toMatchObject({ editorText: card.text, dirty: false });
    expect(records.get(`synthetic-student-b:${project}`)).toBeUndefined();
    expect(records.get(`${scope}:${key}`)).toBeUndefined();
  });

  it("GD-15／GD-18：合成失敗、失權及不存在回應保留本地，不暴露可信保存內容", async () => {
    const card = formatGuidedIdeaCard(idea, "可恢復名稱");
    if (card.outcome !== "ready") throw new Error("應產生最終卡片");
    for (const status of [403, 404, 503]) {
      const controller = new StageDraftSaveController({
        initialTarget: target,
        adapter: createHttpSaveAdapter({
          buildUrl: () => "/synthetic-stage-draft",
          fetchImpl: async () => new Response("{}", { status }),
        }),
      });
      controller.edit(card.text);
      await controller.save();
      expect(controller.getState()).toMatchObject({
        editorText: card.text, dirty: true, confirmedDraft: null,
      });
      expect(controller.getState().operation.status).toBe("failed");
    }
  });

  it("F-04／GD-20／GD-21：實際 React 靜態 render 明示正式名稱、引導模式、AI 關閉與適齡標籤", () => {
    const noop = () => undefined;
    const html = renderToStaticMarkup(createElement(GuidedIdeaPanel, {
      flow: createGuidedIdeaFlow(), error: "", carried: false, disabled: false,
      onAction: noop, onPreview: noop, onCarry: noop, onCancel: noop,
    }));
    expect(html).toContain("App 點子產生器・三步驟引導・AI 功能尚未啟用");
    expect(html).toContain("你想幫誰？");
    expect(html).toContain('aria-describedby="guided-idea-audience-help"');
    expect(html).toContain("未保存");
    expect(html).not.toContain("伺服器已保存");
  });

  it("F-04／GD-19／GD-22：首頁實際靜態 render 保留三卡正式名稱、品牌與既有入口", () => {
    const html = renderToStaticMarkup(createElement(StudentCreationSpace, {
      storageScope: scope, children: createElement("p", null, "合成本人專案入口"),
    }));
    for (const name of ["App 點子產生器", "AI App 超級創客 v5", "萬能教師"]) {
      expect(html.split(name).length - 1).toBeGreaterThanOrEqual(2);
    }
    expect(html).toContain("Chat. Create. Launch.");
    expect(html).toContain("RAE");
    expect(html).toContain("我的點子草稿");
    expect(html).toContain("合成本人專案入口");
    expect(html).toContain('id="project-title"');
    expect(html).not.toContain("三步驟點子引導");
    expect(html).not.toContain('data-testid="guided-idea-panel"');
  });
});
