import { describe, expect, it } from "vitest";
import {
  canContinueGuidedIdea,
  createGuidedIdeaFlow,
  formatGuidedIdeaCard,
  guidedIdeaReducer,
  hasGuidedIdeaAnswers,
} from "../../apps/web/src/components/student/guided-idea.ts";

describe("三步驟 App 點子引導", () => {
  it("從第一題開始，必填後前進，返回時保留並可修改回答", () => {
    let flow = createGuidedIdeaFlow();
    expect(flow.step).toBe(1);
    expect(guidedIdeaReducer(flow, { type: "next" })).toEqual(flow);
    flow = guidedIdeaReducer(flow, { type: "set_text", field: "audience", value: "  " });
    expect(canContinueGuidedIdea(flow)).toBe(false);
    expect(guidedIdeaReducer(flow, { type: "next" })).toEqual(flow);

    flow = guidedIdeaReducer(flow, { type: "set_text", field: "audience", value: "常找不到東西的同學" });
    flow = guidedIdeaReducer(flow, { type: "next" });
    expect(flow.step).toBe(2);
    expect(canContinueGuidedIdea(flow)).toBe(false);
    expect(guidedIdeaReducer(flow, { type: "next" })).toEqual(flow);
    flow = guidedIdeaReducer(flow, { type: "set_text", field: "problem", value: "東西放好後忘記位置" });
    flow = guidedIdeaReducer(flow, { type: "back" });
    expect(flow).toMatchObject({ step: 1, idea: { audience: "常找不到東西的同學" } });
    flow = guidedIdeaReducer(flow, { type: "set_text", field: "audience", value: "需要整理物品的人" });
    flow = guidedIdeaReducer(flow, { type: "next" });
    expect(flow).toMatchObject({ step: 2, idea: { problem: "東西放好後忘記位置" } });
  });

  it("第三題至少一項、最多三項，不能新增第四項或移除唯一欄位", () => {
    let flow = createGuidedIdeaFlow();
    flow = guidedIdeaReducer(flow, { type: "set_text", field: "audience", value: "同學" });
    flow = guidedIdeaReducer(flow, { type: "next" });
    flow = guidedIdeaReducer(flow, { type: "set_text", field: "problem", value: "找東西花很多時間" });
    flow = guidedIdeaReducer(flow, { type: "next" });
    expect(flow.step).toBe(3);
    expect(canContinueGuidedIdea(flow)).toBe(false);
    expect(guidedIdeaReducer(flow, { type: "preview" })).toEqual(flow);

    flow = guidedIdeaReducer(flow, { type: "set_feature", index: 0, value: "記錄物品位置" });
    flow = guidedIdeaReducer(flow, { type: "add_feature" });
    flow = guidedIdeaReducer(flow, { type: "set_feature", index: 1, value: "搜尋物品" });
    flow = guidedIdeaReducer(flow, { type: "add_feature" });
    flow = guidedIdeaReducer(flow, { type: "set_feature", index: 2, value: "提醒歸還物品" });
    expect(flow.idea.features).toHaveLength(3);
    expect(guidedIdeaReducer(flow, { type: "add_feature" })).toEqual(flow);
    flow = guidedIdeaReducer(flow, { type: "remove_feature", index: 1 });
    expect(flow.idea.features).toEqual(["記錄物品位置", "提醒歸還物品"]);
    flow = guidedIdeaReducer(flow, { type: "remove_feature", index: 1 });
    const onlyFeature = flow;
    flow = guidedIdeaReducer(flow, { type: "remove_feature", index: 0 });
    expect(flow).toBe(onlyFeature);
    expect(flow.idea.features).toEqual(["記錄物品位置"]);
  });

  it("預覽只用實際回答，允許未命名並提示由既有表單命名", () => {
    const result = formatGuidedIdeaCard({
      name: "",
      audience: "幫助家人",
      problem: "常忘記植物何時要澆水",
      features: ["記錄澆水日期", "", "設定下次提醒"],
    });
    expect(result).toEqual({
      outcome: "ready",
      text: [
        "我的 App 點子",
        "App 名稱：尚未填寫（請在既有建立專案表單輸入）",
        "想幫助的人：幫助家人",
        "想解決的問題：常忘記植物何時要澆水",
        "主要功能：",
        "1. 記錄澆水日期",
        "2. 設定下次提醒",
      ].join("\n"),
    });
    expect(formatGuidedIdeaCard({
      name: "小小提醒",
      audience: "朋友",
      problem: "容易忘記事情",
      features: ["記下事情"],
    })).toMatchObject({ outcome: "ready", text: expect.stringContaining("App 名稱：小小提醒") });
  });

  it("確認只在預覽後有效，修改內容會解除確認，並支援直接修改任一題", () => {
    let flow = createGuidedIdeaFlow();
    flow = guidedIdeaReducer(flow, { type: "set_text", field: "audience", value: "需要幫忙的人" });
    flow = guidedIdeaReducer(flow, { type: "next" });
    flow = guidedIdeaReducer(flow, { type: "set_text", field: "problem", value: "有一件不方便的事" });
    flow = guidedIdeaReducer(flow, { type: "next" });
    flow = guidedIdeaReducer(flow, { type: "set_feature", index: 0, value: "完成一件事" });
    flow = guidedIdeaReducer(flow, { type: "preview" });
    expect(flow.step).toBe("preview");
    flow = guidedIdeaReducer(flow, { type: "confirm" });
    expect(flow.confirmed).toBe(true);
    flow = guidedIdeaReducer(flow, { type: "edit", step: 2 });
    expect(flow).toMatchObject({ step: 2, confirmed: false, idea: { problem: "有一件不方便的事" } });
  });

  it("延用既有 JSON UTF-8 64 KiB 與字元限制", () => {
    expect(formatGuidedIdeaCard({
      name: "整理星球 🌍",
      audience: "想整理收藏品的學生",
      problem: "物品太多時不容易找到",
      features: ["用關鍵字搜尋 📚"],
    }).outcome).toBe("ready");
    const oversized = {
      name: "",
      audience: "同學".repeat(22000),
      problem: "有東西找不到",
      features: ["記錄位置"],
    };
    expect(formatGuidedIdeaCard(oversized)).toEqual({ outcome: "too_large" });
    let flow = createGuidedIdeaFlow();
    flow = guidedIdeaReducer(flow, { type: "set_text", field: "audience", value: oversized.audience });
    flow = guidedIdeaReducer(flow, { type: "next" });
    flow = guidedIdeaReducer(flow, { type: "set_text", field: "problem", value: oversized.problem });
    flow = guidedIdeaReducer(flow, { type: "next" });
    flow = guidedIdeaReducer(flow, { type: "set_feature", index: 0, value: oversized.features[0] });
    expect(guidedIdeaReducer(flow, { type: "preview" }).step).toBe(3);
    expect(formatGuidedIdeaCard({
      name: "",
      audience: "同學",
      problem: "有東西找不到",
      features: ["\0"],
    })).toEqual({ outcome: "invalid" });
  });

  it("辨識引導中是否有回答，方便取消或切換前明確確認", () => {
    expect(hasGuidedIdeaAnswers(createGuidedIdeaFlow().idea)).toBe(false);
    expect(hasGuidedIdeaAnswers({ ...createGuidedIdeaFlow().idea, audience: "同學" })).toBe(true);
  });
});
