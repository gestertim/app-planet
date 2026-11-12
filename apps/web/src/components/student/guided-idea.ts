import { validateIdeaDraft } from "../project/idea-draft-handoff.ts";

export type GuidedIdea = Readonly<{
  name: string;
  audience: string;
  problem: string;
  features: readonly string[];
}>;

export type GuidedIdeaStep = 1 | 2 | 3 | "preview";

export function resolveSuggestedProjectTitle(current: string, suggestion: string, userEdited: boolean): string {
  return userEdited ? current : suggestion;
}

export type GuidedIdeaFlow = Readonly<{
  idea: GuidedIdea;
  step: GuidedIdeaStep;
  confirmed: boolean;
}>;

export type GuidedIdeaAction =
  | Readonly<{ type: "set_text"; field: "name" | "audience" | "problem"; value: string }>
  | Readonly<{ type: "set_feature"; index: number; value: string }>
  | Readonly<{ type: "add_feature" }>
  | Readonly<{ type: "remove_feature"; index: number }>
  | Readonly<{ type: "next" }>
  | Readonly<{ type: "back" }>
  | Readonly<{ type: "preview" }>
  | Readonly<{ type: "edit"; step: 1 | 2 | 3 }>
  | Readonly<{ type: "confirm" }>
  | Readonly<{ type: "reset" }>;

export function createGuidedIdeaFlow(): GuidedIdeaFlow {
  return {
    idea: { name: "", audience: "", problem: "", features: [""] },
    step: 1,
    confirmed: false,
  };
}

function hasText(value: string): boolean {
  return value.trim().length > 0;
}

export function canContinueGuidedIdea(flow: GuidedIdeaFlow): boolean {
  if (flow.step === 1) return hasText(flow.idea.audience);
  if (flow.step === 2) return hasText(flow.idea.problem);
  if (flow.step === 3) return flow.idea.features.some(hasText);
  return false;
}

export function hasGuidedIdeaAnswers(idea: GuidedIdea): boolean {
  return hasText(idea.name) || hasText(idea.audience) || hasText(idea.problem) ||
    idea.features.some(hasText);
}

export function guidedIdeaReducer(flow: GuidedIdeaFlow, action: GuidedIdeaAction): GuidedIdeaFlow {
  switch (action.type) {
    case "reset":
      return createGuidedIdeaFlow();
    case "set_text":
      return {
        ...flow,
        idea: { ...flow.idea, [action.field]: action.value },
        confirmed: false,
      };
    case "set_feature":
      if (action.index < 0 || action.index >= flow.idea.features.length) return flow;
      return {
        ...flow,
        idea: {
          ...flow.idea,
          features: flow.idea.features.map((feature, index) => index === action.index ? action.value : feature),
        },
        confirmed: false,
      };
    case "add_feature":
      if (flow.idea.features.length >= 3) return flow;
      return { ...flow, idea: { ...flow.idea, features: [...flow.idea.features, ""] }, confirmed: false };
    case "remove_feature":
      if (flow.idea.features.length <= 1 || action.index < 0 || action.index >= flow.idea.features.length) return flow;
      return {
        ...flow,
        idea: { ...flow.idea, features: flow.idea.features.filter((_, index) => index !== action.index) },
        confirmed: false,
      };
    case "next":
      if (!canContinueGuidedIdea(flow)) return flow;
      if (flow.step === 1) return { ...flow, step: 2, confirmed: false };
      if (flow.step === 2) return { ...flow, step: 3, confirmed: false };
      return flow;
    case "back":
      if (flow.step === "preview") return { ...flow, step: 3, confirmed: false };
      if (flow.step === 3) return { ...flow, step: 2, confirmed: false };
      if (flow.step === 2) return { ...flow, step: 1, confirmed: false };
      return flow;
    case "preview":
      return flow.step === 3 && canContinueGuidedIdea(flow) &&
        formatGuidedIdeaCard(flow.idea).outcome === "ready"
        ? { ...flow, step: "preview", confirmed: false }
        : flow;
    case "edit":
      return { ...flow, step: action.step, confirmed: false };
    case "confirm":
      return flow.step === "preview" && formatGuidedIdeaCard(flow.idea).outcome === "ready"
        ? { ...flow, confirmed: true }
        : flow;
  }
}

export type GuidedIdeaCardResult =
  | Readonly<{ outcome: "ready"; text: string }>
  | Readonly<{ outcome: "incomplete" }>
  | Readonly<{ outcome: "invalid" | "too_large" }>;

export function formatGuidedIdeaCard(idea: GuidedIdea, projectName?: string): GuidedIdeaCardResult {
  const features = idea.features.filter(hasText);
  if (!hasText(idea.audience) || !hasText(idea.problem) || features.length === 0 || features.length > 3) {
    return { outcome: "incomplete" };
  }

  const name = projectName ?? (hasText(idea.name)
    ? idea.name
    : "尚未填寫（請在既有建立專案表單輸入）");
  const text = [
    "我的 App 點子",
    `App 名稱：${name}`,
    ...(projectName !== undefined && hasText(idea.name) && idea.name !== projectName
      ? [`已確認的卡片暫名：${idea.name}`] : []),
    `想幫助的人：${idea.audience}`,
    `想解決的問題：${idea.problem}`,
    "主要功能：",
    ...features.map((feature, index) => `${index + 1}. ${feature}`),
  ].join("\n");
  const validation = validateIdeaDraft(text);
  if (validation !== "valid") return { outcome: validation };
  return { outcome: "ready", text };
}
