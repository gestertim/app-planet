import { z } from "zod";
import {
  abortable,
  readBoundedJson,
  revokeAccessToken,
  type AuthConfiguration,
} from "../auth-principal.ts";
import { runSignupIntake } from "../database-session.ts";
import {
  jsonResponse,
  newRequestId,
  problemResponse,
  readJsonBody,
  type ProblemCode,
  type ResponseContext,
} from "../http.ts";
import { readIdempotencyKey } from "../idempotency.ts";
import {
  hmacKey,
  readStaffLoginRuntime,
  readTrustedClientSource,
  sameOrigin,
  type StaffLoginRuntime,
} from "./staff.ts";

// readiness §92：教師註冊申請→電郵驗證（T017 主要子集）的隔離本機實作。
// 下列數值為「隔離測試值」，不是 PP 正式核定、保存或配額政策；正式環境一律拒絕啟用。
export const teacherSignupIsolatedTestPolicy = Object.freeze({
  profile: "isolated-test-v1",
  maxBodyBytes: 4_096,
  maxEmailLength: 254,
  minPasswordLength: 8,
  maxPasswordBytes: 72,
  maxDisplayNameLength: 40,
  maxSchoolNoteLength: 200,
  authTimeoutMs: 8_000,
  maxAuthBodyBytes: 64 * 1024,
  signupSourceLimit: 20,
  signupEmailLimit: 5,
  resendSourceLimit: 10,
  resendEmailLimit: 3,
  verifySourceLimit: 30,
  windowMs: 10 * 60_000,
  maxTrackedBuckets: 10_000,
  verifyCookieMaxAgeSeconds: 600,
});

export const verifyCookieName = "__Host-app-planet-signup-verify";
const tokenHashPattern = /^[0-9a-f]{40,128}$/;
const emailPattern = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@[A-Za-z0-9-]{1,63}(\.[A-Za-z0-9-]{1,63})+$/;
// 與 0028 app.teacher_signup_text_ok 相同：拒絕控制字元、雙向／零寬格式字元。
// eslint-disable-next-line no-control-regex
const forbiddenText = /[\p{Cc}\u00AD\u061C\u180E\u200B-\u200F\u2028-\u202E\u2060-\u206F\uFEFF\uFFF9-\uFFFB]/u;

export type TeacherSignupRuntime = StaffLoginRuntime;

export function readTeacherSignupRuntime(
  env: NodeJS.ProcessEnv = process.env,
): { readonly ok: true; readonly value: TeacherSignupRuntime } | { readonly ok: false } {
  if (env.APP_PLANET_TEACHER_SIGNUP_MODE !== "isolated-local-test" ||
      env.APP_PLANET_ENV !== "isolated-local-test") return { ok: false };
  return readStaffLoginRuntime(env);
}

// ---- strict DTO：只接受四個已批准欄位；任何身分／權限自報欄位一律 unknown_field ----
export type TeacherSignupInput = Readonly<{
  email: string;
  password: string;
  displayName: string;
  schoolNote: string;
}>;

type Parsed<T> =
  | { readonly kind: "ok"; readonly value: T }
  | { readonly kind: "unknown_field" }
  | { readonly kind: "invalid" };

const signupKeys = new Set(["email", "password", "display_name", "school_note"]);

export function normalizeSignupText(value: string, max: number): string | null {
  const normalized = value.normalize("NFC").trim();
  return normalized.length > 0 && [...normalized].length <= max && !forbiddenText.test(normalized)
    ? normalized
    : null;
}

export function validEmail(value: string): boolean {
  return value.length <= teacherSignupIsolatedTestPolicy.maxEmailLength && emailPattern.test(value);
}

export function parseTeacherSignupBody(value: unknown): Parsed<TeacherSignupInput> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return { kind: "invalid" };
  if (Object.keys(value).some((key) => !signupKeys.has(key))) return { kind: "unknown_field" };
  const parsed = z.object({
    email: z.string(), password: z.string(), display_name: z.string(), school_note: z.string(),
  }).safeParse(value);
  if (!parsed.success) return { kind: "invalid" };
  const { email, password } = parsed.data;
  const displayName = normalizeSignupText(parsed.data.display_name, teacherSignupIsolatedTestPolicy.maxDisplayNameLength);
  const schoolNote = normalizeSignupText(parsed.data.school_note, teacherSignupIsolatedTestPolicy.maxSchoolNoteLength);
  // 密碼逐位元保留：不 trim、不正規化；只檢查長度與上游 bcrypt 72 bytes 上限。
  if (!validEmail(email) || displayName === null || schoolNote === null ||
      [...password].length < teacherSignupIsolatedTestPolicy.minPasswordLength ||
      Buffer.byteLength(password, "utf8") > teacherSignupIsolatedTestPolicy.maxPasswordBytes) {
    return { kind: "invalid" };
  }
  return { kind: "ok", value: Object.freeze({ email, password, displayName, schoolNote }) };
}

export function parseResendBody(value: unknown): Parsed<{ readonly email: string }> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return { kind: "invalid" };
  if (Object.keys(value).some((key) => key !== "email")) return { kind: "unknown_field" };
  const parsed = z.object({ email: z.string() }).safeParse(value);
  if (!parsed.success || !validEmail(parsed.data.email)) return { kind: "invalid" };
  return { kind: "ok", value: Object.freeze({ email: parsed.data.email }) };
}

// ---- 固定視窗限流（單程序記憶體；只適用本機單一 server 程序拓樸）----
export class SignupRateLimiter {
  readonly #buckets = new Map<string, { count: number; windowStart: number }>();

  constructor(
    private readonly windowMs: number = teacherSignupIsolatedTestPolicy.windowMs,
    private readonly maxBuckets: number = teacherSignupIsolatedTestPolicy.maxTrackedBuckets,
    private readonly now: () => number = Date.now,
  ) {}

  // 所有鍵都未超限才一起計數；任一超限即整體拒絕，回最長等待秒數。
  take(entries: readonly { readonly key: string; readonly limit: number }[]):
    { readonly ok: true } | { readonly ok: false; readonly retryAfterSeconds: number } {
    const now = this.now();
    for (const [key, bucket] of this.#buckets) {
      if (now - bucket.windowStart >= this.windowMs) this.#buckets.delete(key);
    }
    if (this.#buckets.size + entries.length > this.maxBuckets) {
      return { ok: false, retryAfterSeconds: Math.ceil(this.windowMs / 1000) };
    }
    let wait = 0;
    for (const entry of entries) {
      const bucket = this.#buckets.get(entry.key);
      if (bucket && bucket.count >= entry.limit) {
        wait = Math.max(wait, Math.ceil((bucket.windowStart + this.windowMs - now) / 1000));
      }
    }
    if (wait > 0) return { ok: false, retryAfterSeconds: Math.max(1, wait) };
    for (const entry of entries) {
      const bucket = this.#buckets.get(entry.key) ?? { count: 0, windowStart: now };
      bucket.count += 1;
      this.#buckets.set(entry.key, bucket);
    }
    return { ok: true };
  }
}

const limiterKey = Symbol.for("app-planet.teacher-signup-limiter.memory-single-process");
type LimiterGlobal = typeof globalThis & { [limiterKey]?: SignupRateLimiter };
function processLimiter(): SignupRateLimiter {
  const global = globalThis as LimiterGlobal;
  global[limiterKey] ??= new SignupRateLimiter();
  return global[limiterKey];
}

// ---- 申請意圖（受限 DB 角色；只回非秘密 outcome 與伺服器隨機選擇子）----
export type IntentResult =
  | { readonly outcome: "created"; readonly intent: string }
  | { readonly outcome: "consumed" | "existing" | "in_flight" | "expired" | "idempotency_key_reuse" | "invalid_input" | "unavailable" };

const intentSchema = z.union([
  z.strictObject({ outcome: z.literal("created"), intent: z.uuid() }),
  z.strictObject({ outcome: z.enum(["consumed", "existing", "in_flight", "expired", "idempotency_key_reuse", "invalid_input", "unavailable"]) }),
]);

export async function registerSignupIntent(
  operation: string, input: TeacherSignupInput, env: NodeJS.ProcessEnv,
): Promise<IntentResult | { readonly outcome: "unknown" }> {
  try {
    const { rows } = await runSignupIntake((client) => client.query<{ result: unknown }>(
      "SELECT app.register_teacher_signup_intent($1::uuid,$2::text,$3::text,$4::text) AS result",
      [operation, input.email, input.displayName, input.schoolNote],
    ), env);
    const parsed = intentSchema.safeParse(rows.length === 1 ? rows[0]?.result : null);
    return parsed.success ? parsed.data : { outcome: "unknown" };
  } catch {
    return { outcome: "unknown" };
  }
}

// ---- 受信任 Auth 呼叫：只用公開 anon key，不用 admin API；不帶 redirect_to（目的地固定為 site_url）----
async function authPost(
  config: AuthConfiguration, path: string, body: unknown, fetchImpl: typeof fetch,
): Promise<{ readonly status: number; readonly json: unknown } | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), teacherSignupIsolatedTestPolicy.authTimeoutMs);
  try {
    const response = await abortable(fetchImpl(`${config.authOrigin}${path}`, {
      method: "POST",
      cache: "no-store",
      redirect: "error",
      headers: { apikey: config.authApiKey, "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    }), controller.signal);
    let json: unknown = null;
    if (/^application\/json(?:\s*;\s*charset=utf-8)?\s*$/i.test(response.headers.get("content-type") ?? "")) {
      json = await readBoundedJson(response, controller.signal, teacherSignupIsolatedTestPolicy.maxAuthBodyBytes)
        .catch(() => null);
    } else {
      await response.body?.cancel().catch(() => undefined);
    }
    return { status: response.status, json };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

export type AuthSignupResult = "accepted" | "rejected_input" | "unknown";

// 上游 200（含既有帳號的去識別假使用者）與 429（含既有未驗證帳號的寄信頻率）一律中性；
// 5xx／逾時代表結果無法確認（可能已建立或已回滾），不盲目當失敗或成功。
export async function requestAuthSignup(
  input: TeacherSignupInput, intent: string, config: AuthConfiguration, fetchImpl: typeof fetch = fetch,
): Promise<AuthSignupResult> {
  const reply = await authPost(config, "/auth/v1/signup", {
    email: input.email,
    password: input.password,
    data: { app_planet_signup_intent: intent },
  }, fetchImpl);
  if (reply === null) return "unknown";
  if (reply.status === 200 || reply.status === 429) return "accepted";
  if (reply.status === 400 || reply.status === 422) return "rejected_input";
  return "unknown";
}

export async function requestAuthResend(
  email: string, config: AuthConfiguration, fetchImpl: typeof fetch = fetch,
): Promise<void> {
  await authPost(config, "/auth/v1/resend", { type: "signup", email }, fetchImpl);
}

export type AuthVerifyResult = "verified" | "verified_cleanup_unknown" | "invalid" | "throttled" | "unknown";

const accessTokenSchema = z.string().max(8192).regex(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
const verifiedSessionSchema = z.object({
  access_token: accessTokenSchema,
  token_type: z.literal("bearer"),
  expires_in: z.number().int().positive(),
  refresh_token: z.string().min(1).max(8192),
  user: z.object({ id: z.uuid(), email: z.string().refine(validEmail), email_confirmed_at: z.iso.datetime({ offset: true }) }),
});

// 驗證成功後上游會發 session；本輪不自動登入、不交給瀏覽器，立即以 local scope 撤銷。
export async function requestAuthVerify(
  tokenHash: string, config: AuthConfiguration, fetchImpl: typeof fetch = fetch,
): Promise<AuthVerifyResult> {
  const reply = await authPost(config, "/auth/v1/verify", { type: "signup", token_hash: tokenHash }, fetchImpl);
  if (reply === null) return "unknown";
  if (reply.status === 200) {
    const session = verifiedSessionSchema.safeParse(reply.json);
    // 只信任固定 Auth origin 的結果，不解碼 JWT 或採用 metadata 的驗證宣告。
    // 其餘欄位不合法但可解析 token 時仍盡力撤銷；不能因此宣告驗證成功。
    const token = z.object({ access_token: accessTokenSchema }).safeParse(reply.json);
    const revoked = token.success ? await revokeAccessToken(token.data.access_token, config, fetchImpl) : "unavailable";
    if (!session.success) return "unknown";
    return revoked === "unavailable" ? "verified_cleanup_unknown" : "verified";
  }
  if (reply.status === 429) return "throttled";
  if (reply.status >= 400 && reply.status < 500) return "invalid";
  return "unknown";
}

// ---- 共用請求前置 ----
export interface TeacherSignupDependencies {
  readonly env?: NodeJS.ProcessEnv;
  readonly fetchImpl?: typeof fetch;
  readonly limiter?: SignupRateLimiter;
  readonly registerIntent?: typeof registerSignupIntent;
}

function responseContext(request: Request): ResponseContext {
  let instance = "/";
  try {
    instance = new URL(request.url).pathname;
  } catch {
    // 固定 instance。
  }
  return { requestId: newRequestId(), instance };
}

type Prepared =
  | { readonly ok: true; readonly runtime: TeacherSignupRuntime; readonly source: string }
  | { readonly ok: false; readonly response: Response };

function prepare(
  request: Request, context: ResponseContext, env: NodeJS.ProcessEnv, methods: readonly string[],
): Prepared {
  const problem = (code: ProblemCode, extra: Record<string, string> = {}) =>
    ({ ok: false as const, response: problemResponse(code, context, extra) });
  if (!methods.includes(request.method)) return problem("method_not_allowed", { allow: methods.join(", ") });
  const runtime = readTeacherSignupRuntime(env);
  if (!runtime.ok) return problem("dependency_unavailable");
  if (new URL(request.url).search) return problem("invalid_request");
  if (!sameOrigin(request, runtime.value.auth.appOrigin)) return problem("forbidden");
  const source = readTrustedClientSource(request, runtime.value.sourceProof);
  if (source === null) return problem("forbidden");
  return { ok: true, runtime: runtime.value, source };
}

function emailKey(runtime: TeacherSignupRuntime, label: string, email: string): string {
  return hmacKey(runtime.hmacSecret, label, email.toLowerCase());
}

const neutralSubmitted = { status: "submitted" } as const;

export function createTeacherSignupHandler(
  dependencies: TeacherSignupDependencies = {},
): (request: Request) => Promise<Response> {
  const env = dependencies.env ?? process.env;
  const fetchImpl = dependencies.fetchImpl ?? fetch;
  const register = dependencies.registerIntent ?? registerSignupIntent;
  return async (request) => {
    const context = responseContext(request);
    const problem = (code: ProblemCode, extra: Record<string, string> = {}) => problemResponse(code, context, extra);
    try {
      const prepared = prepare(request, context, env, ["POST"]);
      if (!prepared.ok) return prepared.response;
      const { runtime, source } = prepared;
      const key = readIdempotencyKey(request.headers);
      if (!key.ok) return problem(key.code);
      const body = await readJsonBody(request, parseTeacherSignupBody, teacherSignupIsolatedTestPolicy.maxBodyBytes);
      if (!body.ok) return problem(body.code);
      if (body.data.kind === "unknown_field") return problem("unknown_field");
      if (body.data.kind === "invalid") return problem("invalid_request");
      const input = body.data.value;
      const limiter = dependencies.limiter ?? processLimiter();
      const limited = limiter.take([
        { key: hmacKey(runtime.hmacSecret, "teacher-signup-source-v1", source), limit: teacherSignupIsolatedTestPolicy.signupSourceLimit },
        { key: emailKey(runtime, "teacher-signup-email-v1", input.email), limit: teacherSignupIsolatedTestPolicy.signupEmailLimit },
      ]);
      if (!limited.ok) return problem("signup_throttled", { "retry-after": String(limited.retryAfterSeconds) });
      const intent = await register(key.key, input, env);
      switch (intent.outcome) {
        case "consumed":
        case "existing":
        case "in_flight":
          return jsonResponse(202, neutralSubmitted, context);
        case "expired": return problem("signup_operation_expired");
        case "idempotency_key_reuse": return problem("idempotency_key_reuse");
        case "invalid_input": return problem("invalid_request");
        case "unavailable": return problem("dependency_unavailable");
        case "unknown": return problem("signup_outcome_unknown");
        case "created": break;
      }
      // 只有持久派送資格的首次回應能呼叫 Auth。HTTP 結果不是完成證據；
      // completed 只由 auth.users INSERT 同交易寫入，未結操作不重新派送。
      await requestAuthSignup(input, intent.intent, runtime.auth, fetchImpl);
      return jsonResponse(202, neutralSubmitted, context);
    } catch {
      return problem("internal_error");
    }
  };
}

export function createTeacherSignupResendHandler(
  dependencies: TeacherSignupDependencies = {},
): (request: Request) => Promise<Response> {
  const env = dependencies.env ?? process.env;
  const fetchImpl = dependencies.fetchImpl ?? fetch;
  return async (request) => {
    const context = responseContext(request);
    const problem = (code: ProblemCode, extra: Record<string, string> = {}) => problemResponse(code, context, extra);
    try {
      const prepared = prepare(request, context, env, ["POST"]);
      if (!prepared.ok) return prepared.response;
      const { runtime, source } = prepared;
      const body = await readJsonBody(request, parseResendBody, 1_024);
      if (!body.ok) return problem(body.code);
      if (body.data.kind === "unknown_field") return problem("unknown_field");
      if (body.data.kind === "invalid") return problem("invalid_request");
      const limiter = dependencies.limiter ?? processLimiter();
      const limited = limiter.take([
        { key: hmacKey(runtime.hmacSecret, "teacher-resend-source-v1", source), limit: teacherSignupIsolatedTestPolicy.resendSourceLimit },
        { key: emailKey(runtime, "teacher-resend-email-v1", body.data.value.email), limit: teacherSignupIsolatedTestPolicy.resendEmailLimit },
      ]);
      if (!limited.ok) return problem("signup_throttled", { "retry-after": String(limited.retryAfterSeconds) });
      // 不論帳號是否存在、是否已驗證或上游寄信是否成功，都回同一中性結果；不宣稱已送達。
      await requestAuthResend(body.data.value.email, runtime.auth, fetchImpl);
      return jsonResponse(202, neutralSubmitted, context);
    } catch {
      return problem("internal_error");
    }
  };
}

export function readVerifyCookie(cookieHeader: string | null): string | null {
  if (cookieHeader === null || cookieHeader.length > 16_384) return null;
  const values = cookieHeader.split(";").flatMap((part) => {
    const separator = part.indexOf("=");
    return separator >= 0 && part.slice(0, separator).trim() === verifyCookieName
      ? [part.slice(separator + 1).trim()]
      : [];
  });
  return values.length === 1 && tokenHashPattern.test(values[0]!) ? values[0]! : null;
}

export function verifyCookie(tokenHash: string): string {
  return `${verifyCookieName}=${tokenHash}; Path=/; HttpOnly; Secure; SameSite=Strict; ` +
    `Max-Age=${teacherSignupIsolatedTestPolicy.verifyCookieMaxAgeSeconds}`;
}

export const clearVerifyCookie = `${verifyCookieName}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;

// GET /auth/confirm：信件連結的固定落點。只接受 token_hash 與 type=signup；把 token_hash 移入短期
// HttpOnly cookie 後 303 到不含秘密的頁面，不在此處消耗驗證（避免郵件掃描器預先開啟即完成驗證）。
export function createEmailConfirmLandingHandler(
  env: NodeJS.ProcessEnv = process.env,
): (request: Request) => Response {
  return (request) => {
    const headers: Record<string, string> = {
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      location: "/signup/verify",
    };
    if (request.method !== "GET" || !readTeacherSignupRuntime(env).ok) {
      return new Response(null, { status: 303, headers: { ...headers, "set-cookie": clearVerifyCookie } });
    }
    let params: URLSearchParams;
    try {
      params = new URL(request.url).searchParams;
    } catch {
      return new Response(null, { status: 303, headers: { ...headers, "set-cookie": clearVerifyCookie } });
    }
    const keys = [...params.keys()];
    const tokenHash = params.get("token_hash");
    const valid = keys.length === 2 && params.getAll("token_hash").length === 1 && params.getAll("type").length === 1 &&
      params.get("type") === "signup" && tokenHash !== null && tokenHashPattern.test(tokenHash);
    return new Response(null, {
      status: 303,
      headers: { ...headers, "set-cookie": valid ? verifyCookie(tokenHash) : clearVerifyCookie },
    });
  };
}

export function createTeacherSignupVerifyHandler(
  dependencies: TeacherSignupDependencies = {},
): (request: Request) => Promise<Response> {
  const env = dependencies.env ?? process.env;
  const fetchImpl = dependencies.fetchImpl ?? fetch;
  return async (request) => {
    const context = responseContext(request);
    const problem = (code: ProblemCode, extra: Record<string, string> = {}) => problemResponse(code, context, extra);
    try {
      const prepared = prepare(request, context, env, ["POST", "DELETE"]);
      if (!prepared.ok) return prepared.response;
      if (request.method === "DELETE") {
        return new Response(null, {
          status: 204,
          headers: { "cache-control": "no-store", "x-content-type-options": "nosniff", "set-cookie": clearVerifyCookie,
            "x-request-id": context.requestId },
        });
      }
      const { runtime, source } = prepared;
      const tokenHash = readVerifyCookie(request.headers.get("cookie"));
      if (tokenHash === null) return problem("verification_link_invalid", { "set-cookie": clearVerifyCookie });
      const limiter = dependencies.limiter ?? processLimiter();
      const limited = limiter.take([
        { key: hmacKey(runtime.hmacSecret, "teacher-verify-source-v1", source), limit: teacherSignupIsolatedTestPolicy.verifySourceLimit },
      ]);
      if (!limited.ok) return problem("signup_throttled", { "retry-after": String(limited.retryAfterSeconds) });
      const result = await requestAuthVerify(tokenHash, runtime.auth, fetchImpl);
      switch (result) {
        case "verified": return jsonResponse(200, { status: "verified" }, context, { "set-cookie": clearVerifyCookie });
        case "verified_cleanup_unknown":
          return jsonResponse(200, { status: "verified", session_cleanup: "unknown" }, context, { "set-cookie": clearVerifyCookie });
        case "invalid": return problem("verification_link_invalid", { "set-cookie": clearVerifyCookie });
        case "throttled": return problem("signup_throttled", { "retry-after": "60" });
        // 結果不明時保留短期 cookie，讓使用者以同一連結再按一次；token 不回傳給 JavaScript。
        case "unknown": return problem("verification_outcome_unknown");
      }
    } catch {
      return problem("internal_error");
    }
  };
}
