import type { WorksCspMode } from "@app-planet/core";

// 僅宣告骨架狀態與 core 契約的型別相依；沒有任何請求處理、路由或回應標頭輸出。
export const worksEdgeWorkspace = {
  service: "works-edge",
  implemented: false,
} as const;

export type WorksEdgeCspMode = WorksCspMode;
