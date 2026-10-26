// 共用 works_csp_policy（PUB §3.2）：公開頁與預覽的 CSP 只由此純函式產生，兩處不各自手寫。
// 不新增跨源來源、不使用萬用字元、不含任何生成式 AI 端點；除 frame-ancestors 外兩模式指令相同。
// 預覽不另送 X-Frame-Options（無法表達來源清單且會與 CSP 衝突），因此這裡也不提供該標頭。

export type WorksCspMode = "public" | "preview";

export interface PublicWorksCspOptions {
  readonly mode: "public";
}

export interface PreviewWorksCspOptions {
  readonly mode: "preview";
  // 只能來自可信部署設定的明確平台 origin 清單，不得取自請求、Referer、Origin 標頭或學生程式。
  readonly platformFrameOrigins?: readonly string[];
  // works_domain／preview_domain：清單內任何主機落在其下即視為不合法。未提供時無法驗證，fail-closed。
  readonly excludedFrameDomains?: readonly string[];
}

export type WorksCspOptions = PublicWorksCspOptions | PreviewWorksCspOptions;

export interface WorksCspResult {
  readonly policy: string;
  readonly frameAncestors: "none" | "origins";
  // 預覽設定缺失／為空／格式不符時為 true：frame-ancestors 退為 'none'，呼叫端須顯示錯誤，不放寬。
  readonly failClosed: boolean;
}

export const worksCspBaseDirectives = Object.freeze([
  "default-src 'self'",
  "connect-src 'self'",
  "form-action 'self'",
  "base-uri 'self'",
] as const);

const dnsHostPattern = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;

function isDnsHost(host: string): boolean {
  if (!dnsHostPattern.test(host)) {
    return false;
  }
  // 最後一個標籤至少含一個字母，排除 IPv4 字面值。
  return /[a-z]/.test(host.slice(host.lastIndexOf(".") + 1));
}

function normalizeExcludedDomains(domains: unknown): string[] | null {
  if (!Array.isArray(domains) || domains.length === 0) {
    return null;
  }
  const normalized: string[] = [];
  for (const domain of domains) {
    if (typeof domain !== "string" || domain !== domain.toLowerCase() || !isDnsHost(domain)) {
      return null;
    }
    normalized.push(domain);
  }
  return normalized;
}

function parsePlatformOrigin(value: unknown, excludedDomains: readonly string[]): string | null {
  if (typeof value !== "string" || value === "" || /[\s;,*'"\\]/.test(value)) {
    return null;
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (
    url.protocol !== "https:" ||
    url.origin !== value ||
    url.username !== "" ||
    url.password !== "" ||
    !isDnsHost(url.hostname)
  ) {
    return null;
  }
  const underExcluded = excludedDomains.some(
    (domain) => url.hostname === domain || url.hostname.endsWith(`.${domain}`),
  );
  return underExcluded ? null : value;
}

function resolvePreviewFrameOrigins(options: PreviewWorksCspOptions): string[] | null {
  const excluded = normalizeExcludedDomains(options.excludedFrameDomains);
  const origins = options.platformFrameOrigins;
  if (excluded === null || !Array.isArray(origins) || origins.length === 0) {
    return null;
  }
  const parsed: string[] = [];
  for (const origin of origins) {
    const checked = parsePlatformOrigin(origin, excluded);
    if (checked === null) {
      return null;
    }
    if (!parsed.includes(checked)) {
      parsed.push(checked);
    }
  }
  return parsed;
}

function compose(frameAncestors: string): string {
  return [...worksCspBaseDirectives, `frame-ancestors ${frameAncestors}`].join("; ");
}

export function buildWorksCsp(options: WorksCspOptions): WorksCspResult {
  // 公開模式只看 mode：即使呼叫端多傳 frame 來源，也一律固定 'none'。
  if (options.mode === "public") {
    return { policy: compose("'none'"), frameAncestors: "none", failClosed: false };
  }
  if (options.mode !== "preview") {
    return { policy: compose("'none'"), frameAncestors: "none", failClosed: true };
  }
  const origins = resolvePreviewFrameOrigins(options);
  if (origins === null) {
    return { policy: compose("'none'"), frameAncestors: "none", failClosed: true };
  }
  return { policy: compose(origins.join(" ")), frameAncestors: "origins", failClosed: false };
}
