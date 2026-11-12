import {
  formatGuidedIdeaCard,
  type GuidedIdea,
} from "./student/guided-idea";

export type TeacherDemoDraft = Readonly<{
  idea: GuidedIdea;
  sampleContent: string;
}>;

export type TeacherDemoValidation =
  | Readonly<{ valid: true; idea: GuidedIdea }>
  | Readonly<{ valid: false; message: string }>;

export type SampleContentValidation =
  | Readonly<{ valid: true; items: readonly string[] }>
  | Readonly<{ valid: false; message: string }>;

export type TeacherDemoVersion = Readonly<{
  id: string;
  savedAt: string;
  draft: TeacherDemoDraft;
}>;

const syntheticIdea: GuidedIdea = {
  name: "下課玩什麼？",
  audience: "想在下課時快速找到遊戲的同學",
  problem: "下課時間很短，常常不知道可以玩什麼。",
  features: ["查看遊戲清單", "依下課時間找遊戲", "挑選一個遊戲試試看"],
};
const syntheticSampleContent = "猜拳\n畫畫\n傳球";

export function createSyntheticTeacherDemoDraft(): TeacherDemoDraft {
  return {
    idea: { ...syntheticIdea, features: [...syntheticIdea.features] },
    sampleContent: syntheticSampleContent,
  };
}

export function createTeacherDemoDraftFromIdea(idea: GuidedIdea): TeacherDemoDraft {
  return {
    idea: { ...idea, features: [...idea.features] },
    sampleContent: syntheticSampleContent,
  };
}

export function validateTeacherDemoIdea(
  idea: GuidedIdea,
  options: Readonly<{ allowMissingName?: boolean }> = {},
): TeacherDemoValidation {
  const name = idea.name.trim();
  const audience = idea.audience.trim();
  const problem = idea.problem.trim();
  const features = idea.features.map((feature) => feature.trim());

  if ((!options.allowMissingName && !name) || name.length > 60) {
    return { valid: false, message: "App 名稱請填 1 到 60 個字。" };
  }
  if (!audience || audience.length > 120) {
    return { valid: false, message: "使用者請填 1 到 120 個字。" };
  }
  if (!problem || problem.length > 160) {
    return { valid: false, message: "用途請填 1 到 160 個字。" };
  }
  if (features.length < 1 || features.length > 3 || features.some((feature) => !feature || feature.length > 100)) {
    return { valid: false, message: "請填寫 1 到 3 項核心功能，每項最多 100 個字；空白功能請移除。" };
  }

  const uniqueFeatures = new Set(features.map((feature) => feature.normalize("NFKC").toLocaleLowerCase("zh-TW")));
  if (uniqueFeatures.size !== features.length) {
    return { valid: false, message: "核心功能不能重複，請修改或移除重複項目。" };
  }

  const normalized: GuidedIdea = { name, audience, problem, features };
  if (formatGuidedIdeaCard(normalized).outcome !== "ready") {
    return { valid: false, message: "藍圖內容不符合既有點子卡格式，請檢查特殊字元或縮短內容。" };
  }

  return { valid: true, idea: normalized };
}

export function validateTeacherDemoSampleContent(content: string): SampleContentValidation {
  const items = content.split(/\r?\n/u).map((item) => item.trim()).filter(Boolean);
  if (items.length < 1 || items.length > 8 || items.some((item) => item.length > 80)) {
    return { valid: false, message: "示範清單需有 1 到 8 個項目，每項最多 80 個字。" };
  }

  const uniqueItems = new Set(items.map((item) => item.normalize("NFKC").toLocaleLowerCase("zh-TW")));
  if (uniqueItems.size !== items.length) {
    return { valid: false, message: "示範清單不能有重複項目，請修改內容。" };
  }

  return { valid: true, items };
}

export function createTeacherDemoVersion(
  draft: TeacherDemoDraft,
  id: string,
  savedAt: string,
): TeacherDemoVersion {
  return {
    id,
    savedAt,
    draft: {
      idea: { ...draft.idea, features: [...draft.idea.features] },
      sampleContent: draft.sampleContent,
    },
  };
}

export function restoreTeacherDemoVersion(version: TeacherDemoVersion): TeacherDemoDraft {
  return {
    idea: { ...version.draft.idea, features: [...version.draft.idea.features] },
    sampleContent: version.draft.sampleContent,
  };
}
