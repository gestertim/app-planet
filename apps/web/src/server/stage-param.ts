// Next 動態路由參數可能仍是百分比編碼（如「點子」「A%2FB」）；階段名稱不含 %，解碼失敗則保留原值交由 schema 拒絕。
export function decodeStageParam(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
