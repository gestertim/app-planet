// R-12 的輸出前遮蔽／拒絕層：只偵測已知形狀的憑證、標頭名稱、堆疊與位址文字。
// 這是縱深防禦，不是完整去敏：實際安全仍依賴「逐欄白名單建構」，兩者互不取代。
// 登入碼的碼長與格式尚未核定（D-07b～e），因此不以樣式猜測登入碼；原始 preview id 也無可辨識前綴，
// 同樣只能靠白名單不收錄。
const sensitivePatterns: readonly RegExp[] = [
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/i,
  /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/,
  /\bsb_[A-Za-z0-9_-]{8,}/,
  /\bsk-[A-Za-z0-9_-]{8,}/,
  /\b(?:set-cookie|cookie|authorization)\s*:/i,
  /(?:^|\n)\s*at\s+\S+\s*\(?[^\n]*:\d+(?::\d+)?\)?/,
  /\b[A-Za-z]:\\[^\s]/,
  /(?:^|[\s"'(])\/(?:home|Users|var|etc|usr|opt|root)\/[^\s]/,
  /\bnode_modules\b/,
  /\b(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}\b/,
  /(?:^|[^:\w])(?:[0-9a-f]{1,4}:){7}[0-9a-f]{1,4}(?![\w:])/i,
  /(?:^|[^:\w])(?:[0-9a-f]{0,4}:){1,6}:(?:[0-9a-f]{1,4}(?::[0-9a-f]{1,4}){0,5})?(?![\w:])/i,
];

export function containsSensitiveText(value: string): boolean {
  return sensitivePatterns.some((pattern) => pattern.test(value));
}
