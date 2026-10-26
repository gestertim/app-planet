import {
  buildDiagnosticLogDto,
  buildJobAcceptedResponse,
  buildProblemJson,
  buildVersionConflictProblem,
  jobSnapshotCoreShapeSchema,
  parseRowIfMatch,
  UsageFailure,
  type UsageContext,
  type VersionConflictPolicy,
} from "@app-planet/core";
import type { AuthorizationContext } from "./authorization.ts";
import type { ProjectCreationContext } from "./projects.ts";
import { readAuthConfiguration } from "./auth-principal.ts";
import { readOwnedStageDraftSubset } from "./stage-drafts.ts";

// ---- 固定錯誤碼登錄（可信設定；不透傳供應商／資料庫／內部碼）----
// 每個碼附繁體中文可採取的下一步。措辭仍屬草案，待教育者／專業審閱後才能上線。
const registry = {
  unauthenticated: { status: 401, title: "尚未登入", next: "請先登入後再試一次。" },
  account_disabled: { status: 403, title: "帳號目前無法使用", next: "請聯絡你的老師或管理員確認帳號狀態。" },
  forbidden: { status: 403, title: "沒有這項操作的權限", next: "請確認使用的是自己的帳號，或聯絡老師協助。" },
  ai_not_open: { status: 403, title: "此功能目前尚未開放", next: "請稍後再試，或詢問老師何時開放。" },
  not_found: { status: 404, title: "找不到資料", next: "請回到清單重新選擇，或確認連結是否正確。" },
  method_not_allowed: { status: 405, title: "不支援的操作方式", next: "請重新整理頁面後再試一次。" },
  invalid_request: { status: 400, title: "送出的內容格式不正確", next: "請檢查內容後重新送出。" },
  payload_too_large: { status: 413, title: "送出的內容太大", next: "請縮短內容後重新送出。" },
  unsupported_media_type: { status: 415, title: "不支援的內容格式", next: "請重新整理頁面後再試一次。" },
  idempotency_key_required: { status: 400, title: "缺少操作識別", next: "請重新整理頁面後再操作一次。" },
  invalid_idempotency_key: { status: 400, title: "操作識別格式不正確", next: "請重新整理頁面後再操作一次。" },
  idempotency_key_reuse: { status: 422, title: "這個操作識別已用於不同內容", next: "請重新整理頁面，確認內容後以新的操作送出。" },
  if_match_required: { status: 400, title: "缺少版本資訊", next: "請重新載入最新內容後再儲存。" },
  invalid_if_match: { status: 400, title: "版本資訊格式不正確", next: "請重新載入最新內容後再儲存。" },
  precondition_required: { status: 400, title: "缺少草稿保存條件", next: "首次保存須確認尚無草稿；更新須提供目前版本，請重新載入並比對。" },
  invalid_precondition: { status: 400, title: "草稿保存條件不正確", next: "首次保存只可提供 If-None-Match: *；更新只可提供單一強版本 If-Match，請重新載入並比對。" },
  draft_already_exists: { status: 412, title: "草稿已存在", next: "本地內容仍保留；請明確選擇重新載入並比對，不會自動覆寫。" },
  version_conflict: { status: 409, title: "內容已被更新", next: "你的草稿仍保留；請比對最新內容後再決定如何儲存。" },
  rate_limited: { status: 429, title: "操作太頻繁", next: "請稍等一下再試一次。" },
  concurrency_limited: { status: 429, title: "同時進行的操作太多", next: "請等目前的操作結束後再試。" },
  quota_daily_exhausted: { status: 429, title: "今天的額度已用完", next: "請明天再試，或詢問老師。" },
  pool_creator_exhausted: { status: 429, title: "共用額度暫時用完", next: "請稍後再試，或詢問老師。" },
  operation_outcome_unknown: { status: 503, title: "結果尚待確認", next: "請不要重新建立操作；用同一個操作重試，系統會回報原本的結果。" },
  dependency_unavailable: { status: 503, title: "服務暫時無法使用", next: "你的內容仍保留在畫面上；請稍後再試。" },
  job_result_unavailable: { status: 503, title: "工作結果尚無法顯示", next: "請稍後再查看，或詢問老師。" },
  internal_error: { status: 500, title: "發生未預期的問題", next: "你的內容仍保留；請稍後再試，若持續發生請告知老師。" },
} as const;

export type ProblemCode = keyof typeof registry;
export const problemCodes = Object.freeze(Object.keys(registry)) as readonly ProblemCode[];
const problemPolicy = { codes: [...problemCodes] };

export function problemStatus(code: ProblemCode): number {
  return registry[code].status;
}

const baseHeaders = {
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
} as const;

export interface ResponseContext {
  readonly requestId: string;
  // 只含 pathname，不含 query。
  readonly instance: string;
}

export function newRequestId(): string {
  return `req_${crypto.randomUUID().replaceAll("-", "")}`;
}

function finish(body: string, status: number, contentType: string, requestId: string, extra: Record<string, string> = {}) {
  return new Response(body, {
    status,
    headers: { ...baseHeaders, ...extra, "content-type": contentType, "x-request-id": requestId },
  });
}

function problemInput(code: ProblemCode, context: ResponseContext, instance: string) {
  const entry = registry[code];
  return {
    type: `/problems/${code}`,
    title: entry.title,
    status: entry.status,
    code,
    instance,
    request_id: context.requestId,
    user_message_zh: `${entry.title}。${entry.next}`,
  };
}

// 固定且不含輸入的最後備援，確保任何建構失敗都不會洩漏內部資訊或回成功形狀。
function fallbackProblem(requestId: string): Response {
  const safeId = /^[A-Za-z0-9_-]{1,64}$/.test(requestId) ? requestId : newRequestId();
  return finish(JSON.stringify({
    type: "/problems/internal_error", title: "發生未預期的問題", status: 500, code: "internal_error",
    instance: "/", request_id: safeId, user_message_zh: "發生未預期的問題。你的內容仍保留；請稍後再試。",
  }), 500, "application/problem+json", safeId);
}

const emittedCodes = new WeakMap<Response, ProblemCode>();

export function problemResponse(
  code: ProblemCode, context: ResponseContext, extraHeaders: Record<string, string> = {},
): Response {
  for (const instance of [context.instance, "/"]) {
    const built = buildProblemJson(problemInput(code, context, instance), problemPolicy);
    if (built.ok) {
      const response = finish(JSON.stringify(built.data), built.data.status, "application/problem+json", context.requestId, extraHeaders);
      emittedCodes.set(response, code);
      return response;
    }
  }
  return fallbackProblem(context.requestId);
}

export function versionConflictResponse(
  conflict: unknown, policy: VersionConflictPolicy, context: ResponseContext,
): Response {
  const built = buildVersionConflictProblem({
    ...problemInput("version_conflict", context, context.instance), conflict,
  }, policy);
  if (!built.ok) return problemResponse("internal_error", context);
  const response = finish(JSON.stringify(built.data), 409, "application/problem+json", context.requestId);
  emittedCodes.set(response, "version_conflict");
  return response;
}

export function jsonResponse(
  status: 200 | 201, body: unknown, context: ResponseContext, extraHeaders: Record<string, string> = {},
): Response {
  return finish(JSON.stringify(body), status, "application/json; charset=utf-8", context.requestId, extraHeaders);
}

export const rowEtag = (version: number): string => `"${version}"`;

// ---- If-Match（row 版本；file 版本使用另一個 hash 契約，不在此混用）----
export type IfMatchResult =
  | { readonly ok: true; readonly version: number }
  | { readonly ok: false; readonly code: "if_match_required" | "invalid_if_match" };

export function readRowIfMatch(headers: Headers): IfMatchResult {
  const raw = headers.get("if-match");
  if (raw === null) return { ok: false, code: "if_match_required" };
  // 多值／重複標頭會被 Headers 以逗號合併，不符 strong quoted 單值格式。
  const text = parseRowIfMatch(raw);
  const version = text === null ? Number.NaN : Number(text);
  return Number.isSafeInteger(version) && version >= 0 && version <= 2147483647
    ? { ok: true, version }
    : { ok: false, code: "invalid_if_match" };
}

export function readStageDraftPrecondition(headers: Headers):
  | { readonly ok: true; readonly version: number | null }
  | { readonly ok: false; readonly code: "precondition_required" | "invalid_precondition" } {
  const match = headers.get("if-match");
  const none = headers.get("if-none-match");
  if (match === null && none === null) return { ok: false, code: "precondition_required" };
  if (match !== null && none !== null) return { ok: false, code: "invalid_precondition" };
  if (none !== null) return none === "*"
    ? { ok: true, version: null }
    : { ok: false, code: "invalid_precondition" };
  const parsed = readRowIfMatch(headers);
  return parsed.ok ? parsed : { ok: false, code: "invalid_precondition" };
}

// ---- 可信 principal ----
// 身分只能由此 resolver 提供：不讀 Body／Header 自報的 subject、role、school。
// 每個 context 的 runTransaction 必須在同一交易綁定已驗證主體，由資料庫 RLS／gate 再次判斷當下資格。
export interface TrustedSession {
  readonly read: AuthorizationContext;
  readonly write: ProjectCreationContext;
  readonly usage: UsageContext;
}
export type PrincipalResolution =
  | { readonly ok: true; readonly session: TrustedSession }
  | { readonly ok: false; readonly reason: "unauthenticated" | "account_disabled" | "dependency_unavailable" };
export interface TrustedPrincipalResolver {
  resolve(request: Request): Promise<PrincipalResolution>;
}

// 正式 Auth 尚未接通（M3 未啟用）：一般入口一律拒絕。
export const closedPrincipalResolver: TrustedPrincipalResolver = Object.freeze({
  async resolve() {
    return { ok: false, reason: "unauthenticated" } as const;
  },
});

// ---- 本文讀取 ----
export type BodyResult<T> =
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly code: "invalid_request" | "payload_too_large" | "unsupported_media_type" };

export async function readJsonBody<T>(
  request: Request, parse: (value: unknown) => T | null, maxBytes: number,
): Promise<BodyResult<T>> {
  const contentType = request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
  if (contentType !== "application/json") return { ok: false, code: "unsupported_media_type" };
  const declared = request.headers.get("content-length");
  if (declared !== null && Number(declared) > maxBytes) return { ok: false, code: "payload_too_large" };
  const reader = request.body?.getReader();
  if (!reader) return { ok: false, code: "invalid_request" };
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      return { ok: false, code: "payload_too_large" };
    }
    chunks.push(value);
  }
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
    const data = parse(JSON.parse(text));
    return data === null ? { ok: false, code: "invalid_request" } : { ok: true, data };
  } catch {
    return { ok: false, code: "invalid_request" };
  }
}

// ---- Job 202 與狀態查詢 ----
export function jobAcceptedResponse(snapshot: unknown, context: ResponseContext): Response {
  const built = buildJobAcceptedResponse(snapshot);
  if (!built.ok) return problemResponse("internal_error", context);
  return finish(JSON.stringify(built.data.body), 202, "application/json; charset=utf-8",
    context.requestId, { location: built.data.headers.location });
}

const terminalWithFailure = new Set(["failed", "cancelled", "stopped"]);
const successStates = new Set(["succeeded", "done"]);

// 只輸出契約已定義的形狀：各 kind 的成功 result 尚未定義，因此成功終態回「結果尚無法顯示」，
// 絕不以 200＋空 result 暗示已完成。
export function jobSnapshotResponse(
  snapshot: unknown, failure: { code: string; user_message_zh: string } | null, context: ResponseContext,
): Response {
  const parsed = jobSnapshotCoreShapeSchema.safeParse(snapshot);
  if (!parsed.success) return problemResponse("internal_error", context);
  const job = parsed.data;
  if (successStates.has(job.state)) return problemResponse("job_result_unavailable", context);
  const needsFailure = terminalWithFailure.has(job.state);
  if (needsFailure !== (failure !== null)) return problemResponse("internal_error", context);
  if (failure !== null && (!/^[a-z][a-z0-9_]*$/.test(failure.code) || !/\p{Script=Han}/u.test(failure.user_message_zh))) {
    return problemResponse("internal_error", context);
  }
  return finish(JSON.stringify({ ...job, result: null, failure }), 200,
    "application/json; charset=utf-8", context.requestId);
}

// ---- usage／Job 交易錯誤 → HTTP 固定碼 ----
const usageProblemMap: Readonly<Record<string, ProblemCode>> = {
  invalid_input: "invalid_request",
  authorization_denied: "forbidden",
  policy_not_approved: "ai_not_open",
  idempotency_key_reuse: "idempotency_key_reuse",
  rate_limited: "rate_limited",
  concurrency_limited: "concurrency_limited",
  quota_daily_exhausted: "quota_daily_exhausted",
  pool_creator_exhausted: "pool_creator_exhausted",
};

// 未登錄的碼（含 dependency_failure）一律是依賴失敗；不把任何失敗包成成功。
export function usageFailureProblem(error: unknown): ProblemCode {
  return error instanceof UsageFailure ? usageProblemMap[error.code] ?? "dependency_unavailable" : "dependency_unavailable";
}

// ---- 白名單診斷日誌 ----
export type LogSink = (record: unknown) => void;

// ---- 路由包裝 ----
export interface RouteOptions {
  // 日誌 route 識別碼（小寫識別字），由可信設定提供。
  readonly route: string;
  readonly methods: readonly string[];
  readonly resolver: TrustedPrincipalResolver;
  readonly log?: LogSink;
  readonly requireSameOrigin?: boolean;
}
export interface RouteInput extends ResponseContext {
  readonly request: Request;
  readonly session: TrustedSession;
  readonly routeParams: Readonly<Record<string, string>>;
}

export function createRouteHandler(
  options: RouteOptions, handler: (input: RouteInput) => Promise<Response>,
): (request: Request, routeParams?: Readonly<Record<string, string>>) => Promise<Response> {
  const logPolicy = { routeIds: [options.route], httpErrorCodes: [...problemCodes] };
  return async (request, routeParams = {}) => {
    const started = performance.now();
    const requestId = newRequestId();
    let instance = "/";
    try {
      instance = new URL(request.url).pathname;
    } catch {
      // 保持固定 instance
    }
    const context: ResponseContext = { requestId, instance };
    let response: Response;
    let code: ProblemCode | undefined;
    try {
      if (!options.methods.includes(request.method)) {
        code = "method_not_allowed";
        response = problemResponse(code, context, { allow: options.methods.join(", ") });
      } else if (options.requireSameOrigin && !hasTrustedSameOrigin(request)) {
        code = "forbidden";
        response = problemResponse(code, context);
      } else {
        const principal = await options.resolver.resolve(request).catch(() => null);
        if (principal === null) {
          code = "dependency_unavailable";
          response = problemResponse(code, context);
        } else if (!principal.ok) {
          code = principal.reason === "dependency_unavailable" ? "dependency_unavailable" : principal.reason;
          response = problemResponse(code, context);
        } else {
          response = await handler({ ...context, request, session: principal.session, routeParams });
        }
      }
    } catch {
      code = "internal_error";
      response = problemResponse(code, context);
    }
    if (options.log) {
      code ??= emittedCodes.get(response);
      const dto = buildDiagnosticLogDto({
        request_id: requestId, route: options.route, status_code: response.status,
        duration: Math.round(performance.now() - started),
        ...(code ? { error_code: code } : {}),
      }, logPolicy);
      try {
        if (dto.ok) options.log(dto.data);
      } catch {
        // 日誌失敗不影響回應，也不回傳診斷。
      }
    }
    return response;
  };
}

export function hasTrustedSameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  const config = readAuthConfiguration();
  if (!config.ok || origin !== config.value.appOrigin) return false;
  const fetchSite = request.headers.get("sec-fetch-site");
  return fetchSite === null || fetchSite === "same-origin" || fetchSite === "none";
}
