import { createElement, type ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { GuidedIdea } from "../../apps/web/src/components/student/guided-idea.ts";
import {
  createSyntheticTeacherDemoDraft,
  createTeacherDemoVersion,
  restoreTeacherDemoVersion,
  validateTeacherDemoIdea,
  validateTeacherDemoSampleContent,
} from "../../apps/web/src/components/pilot30-teacher-demo-model.ts";
import { isPilot30TeacherDemoEnabled } from "../../apps/web/src/server/pilot30-teacher-demo-access.ts";

type PreviewProps = Readonly<{
  idea: GuidedIdea;
  created: boolean;
  items: readonly string[];
  pickedItem: string;
  contentError: string;
  onPick: () => void;
}>;
const { TeacherDemo, TeacherDemoPreview } = await vi.importActual<{
  TeacherDemo: ComponentType;
  TeacherDemoPreview: ComponentType<PreviewProps>;
}>("../../apps/web/src/components/pilot30-teacher-demo.tsx");

describe("Pilot30 教師本機示範", () => {
  it("只在 development 且明確開關時允許進入", () => {
    expect(isPilot30TeacherDemoEnabled({ NODE_ENV: "development", PILOT30_TEACHER_DEMO_ENABLED: "true" })).toBe(true);
    expect(isPilot30TeacherDemoEnabled({ NODE_ENV: "development" })).toBe(false);
    expect(isPilot30TeacherDemoEnabled({ NODE_ENV: "production", PILOT30_TEACHER_DEMO_ENABLED: "true" })).toBe(false);
    expect(isPilot30TeacherDemoEnabled({ NODE_ENV: "test", PILOT30_TEACHER_DEMO_ENABLED: "true" })).toBe(false);
  });

  it("沿用 Guided Idea 結構並拒絕空白、重複或超過三項的藍圖", () => {
    const sample = createSyntheticTeacherDemoDraft().idea;
    expect(validateTeacherDemoIdea(sample).valid).toBe(true);
    expect(validateTeacherDemoIdea({ ...sample, name: "  " }).valid).toBe(false);
    expect(validateTeacherDemoIdea({ ...sample, features: ["猜拳", " 猜拳 ", "畫畫"] }).valid).toBe(false);
    expect(validateTeacherDemoIdea({ ...sample, features: ["一", "二", "三", "四"] }).valid).toBe(false);
    expect(validateTeacherDemoIdea({ ...sample, features: ["一", ""] }).valid).toBe(false);
  });

  it("只接受 1 到 8 個不重複的示範清單項目", () => {
    expect(validateTeacherDemoSampleContent("猜拳\n畫畫")).toEqual({ valid: true, items: ["猜拳", "畫畫"] });
    expect(validateTeacherDemoSampleContent("猜拳\n 猜拳 ").valid).toBe(false);
    expect(validateTeacherDemoSampleContent("\n ").valid).toBe(false);
    expect(validateTeacherDemoSampleContent(Array.from({ length: 9 }, (_, index) => `項目${index}`).join("\n")).valid)
      .toBe(false);
  });

  it("保存獨立快照並在還原後複製功能清單", () => {
    const original = createSyntheticTeacherDemoDraft();
    const version = createTeacherDemoVersion(original, "demo-v1", "2026-11-12T00:00:00.000Z");
    const restored = restoreTeacherDemoVersion(version);
    const editedAfterRestore = {
      ...restored,
      idea: { ...restored.idea, features: ["只修改目前草稿"] },
    };

    expect(version.draft.idea.features).toEqual(original.idea.features);
    expect(editedAfterRestore.idea.features).not.toBe(version.draft.idea.features);
    expect(version.draft.idea.features[0]).toBe("查看遊戲清單");
  });

  it("呈現可見範本與清楚的合成／非 AI 限制", () => {
    const html = renderToStaticMarkup(createElement(TeacherDemo));
    expect(html).toContain("本機教師示範／合成資料／非 AI 生成");
    expect(html).toContain("下課玩什麼？");
    expect(html).toContain("不是隔離 App Sandbox");
    expect(html).toContain("不執行使用者程式碼");
  });

  it("把示範內容當文字呈現，不解析 HTML", () => {
    const html = renderToStaticMarkup(createElement(TeacherDemoPreview, {
      idea: createSyntheticTeacherDemoDraft().idea,
      created: true,
      items: ["<img src=x onerror=alert(1)>"],
      pickedItem: "",
      contentError: "",
      onPick: () => undefined,
    }));
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("尚未挑選");
  });
});
