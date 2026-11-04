import { createHmac, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import { z } from "zod";
import {
  abortable,
  readAuthConfiguration,
  readBoundedJson,
  revokeAccessToken,
  sessionCookieName,
  verifyAccessToken,
  type AuthConfiguration,
} from "../auth-principal.ts";
import { createDatabaseSession } from "../database-session.ts";
import {
  jsonResponse,
  newRequestId,
  problemResponse,
  readJsonBody,
  type ProblemCode,
  type ResponseContext,
} from "../http.ts";
import { decideStaffLogin, readCurrentAccountStatus, type AccountStatusRead } from "./account-status.ts";

// readiness §90：既有教職員帳號登入（A-2）的隔離本機子集。
// 下列數值是本輪「隔離測試值」，不是 PP-03／PP-04 正式核定，也不解除 Q-AUTH；正式環境一律拒絕啟用。
export const staffLoginIsolatedTestPolicy = Object.freeze({
  profile: "isolated-test-v1",
  maxBodyBytes: 4_096,
  maxEmailLength: 320,
  maxPasswordBytes: 1_024,
  authTimeoutMs: 5_000,
  maxAuthBodyBytes: 64 * 1024,
  accountFailureLimit: 5,
  accountWindowMs: 5 * 60_000,
  sourceAttemptLimit: 20,
  sourceWindowMs: 60_000,
  backoffBaseMs: 30_000,
  backoffMaxMs: 5 * 60_000,
  upstreamRetryAfterDefaultSeconds: 60,
  maxTrackedBuckets: 10_000,
  sessionMaxAgeMinSeconds: 60,
  sessionMaxAgeMaxSeconds: 3_600,
});

export type StaffLoginPolicy = typeof staffLoginIsolatedTestPolicy;

export const clientSourceHeader = "x-app-planet-client-source";
export const sourceProofHeader = "x-app-planet-source-proof";

export type StaffLoginRuntime = Readonly<{
  auth: AuthConfiguration;
  hmacSecret: Buffer;
  sourceProof: Buffer;
  sessionMaxAgeSeconds: number;
}>;

const loopbackHosts = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

function isLoopbackUrl(value: string | undefined): boolean {
  if (!value) return false;
  try {
    return loopbackHosts.has(new URL(value).hostname);
  } catch {
    return false;
  }
}

// 只在明確辨識的隔離本機環境啟用；不靠前端開關，缺任一設定即拒絕。
export function readStaffLoginRuntime(
  env: NodeJS.ProcessEnv = process.env,
): { readonly ok: true; readonly value: StaffLoginRuntime } | { readonly ok: false } {
  const target = env.APP_PLANET_ENV?.trim().toLowerCase();
  if (env.NODE_ENV === "production" || target === "production" || target === "prod") return { ok: false };
  if (env.APP_PLANET_STAFF_LOGIN_MODE !== "isolated-local-test" ||
      env.APP_PLANET_LOCAL_AUTH !== "1" ||
      env.APP_PLANET_STAFF_LOGIN_THROTTLE_BACKEND !== "memory-single-process") return { ok: false };
  const secret = env.APP_PLANET_STAFF_LOGIN_HMAC_SECRET;
  const proof = env.APP_PLANET_SOURCE_PROXY_PROOF;
  const maxAge = Number(env.APP_PLANET_STAFF_SESSION_MAX_AGE_SECONDS);
  if (!secret || !/^[0-9a-f]{64,128}$/.test(secret) || !proof || !/^[0-9a-f]{64}$/.test(proof) ||
      !Number.isSafeInteger(maxAge) ||
      maxAge < staffLoginIsolatedTestPolicy.sessionMaxAgeMinSeconds ||
      maxAge > staffLoginIsolatedTestPolicy.sessionMaxAgeMaxSeconds) return { ok: false };
  const auth = readAuthConfiguration(env);
  if (!auth.ok || !isLoopbackUrl(auth.value.authOrigin) || !isLoopbackUrl(auth.value.appOrigin) ||
      !isLoopbackUrl(env.APP_PLANET_DATABASE_URL)) return { ok: false };
  return {
    ok: true,
    value: Object.freeze({
      auth: auth.value,
      hmacSecret: Buffer.from(secret, "hex"),
      sourceProof: Buffer.from(proof, "hex"),
      sessionMaxAgeSeconds: maxAge,
    }),
  };
}

// ---- 可信網路來源：只接受 runner 建立的 loopback proxy 以本輪 proof 注入的來源；不讀 X-Forwarded-For ----
export function readTrustedClientSource(request: Request, proof: Buffer): string | null {
  const presented = request.headers.get(sourceProofHeader);
  const source = request.headers.get(clientSourceHeader);
  if (presented === null || source === null || !/^[0-9a-f]{64}$/.test(presented) || proof.length !== 32) return null;
  if (!timingSafeEqual(Buffer.from(presented, "hex"), proof)) return null;
  const normalized = source.startsWith("::ffff:") ? source.slice(7) : source;
  return normalized.length <= 64 && isIP(normalized) !== 0 ? normalized.toLowerCase() : null;
}

export function hmacKey(secret: Buffer, label: string, ...parts: string[]): string {
  const mac = createHmac("sha256", secret).update(label);
  for (const part of parts) mac.update("\u0000").update(part);
  return mac.digest("hex");
}

// ---- 節流（單程序記憶體後端；只適用本機單一 server 程序拓樸，不可宣稱正式多實例可用）----
type AccountBucket = { failures: number; windowStart: number; inflight: number; lockedUntil: number; lockCount: number };
type SourceBucket = { attempts: number; windowStart: number };

export type ThrottleTicket = Readonly<{ accountKey: string }>;
export type ThrottleReservation =
  | { readonly ok: true; readonly ticket: ThrottleTicket }
  | { readonly ok: false; readonly retryAfterSeconds: number };

export class StaffLoginThrottle {
  readonly #accounts = new Map<string, AccountBucket>();
  readonly #sources = new Map<string, SourceBucket>();

  constructor(
    private readonly policy: StaffLoginPolicy = staffLoginIsolatedTestPolicy,
    private readonly now: () => number = Date.now,
  ) {}

  // 同步檢查並預留，避免並行請求在等待 Auth 時越過門檻。
  reserve(accountKey: string, sourceKey: string): ThrottleReservation {
    const now = this.now();
    this.#prune(now);
    if (this.#accounts.size + this.#sources.size >= this.policy.maxTrackedBuckets) {
      return { ok: false, retryAfterSeconds: Math.ceil(this.policy.sourceWindowMs / 1000) };
    }
    let source = this.#sources.get(sourceKey);
    if (!source || now - source.windowStart >= this.policy.sourceWindowMs) {
      source = { attempts: 0, windowStart: now };
    }
    let account = this.#accounts.get(accountKey);
    if (!account || (account.inflight === 0 && account.lockedUntil <= now &&
        now - account.windowStart >= this.policy.accountWindowMs)) {
      account = { failures: 0, windowStart: now, inflight: 0, lockedUntil: 0, lockCount: account?.lockCount ?? 0 };
    }
    if (source.attempts >= this.policy.sourceAttemptLimit) {
      return { ok: false, retryAfterSeconds: secondsUntil(source.windowStart + this.policy.sourceWindowMs, now) };
    }
    if (account.lockedUntil > now) {
      return { ok: false, retryAfterSeconds: secondsUntil(account.lockedUntil, now) };
    }
    if (account.failures + account.inflight >= this.policy.accountFailureLimit) {
      return { ok: false, retryAfterSeconds: secondsUntil(now + this.policy.backoffBaseMs, now) };
    }
    source.attempts += 1;
    account.inflight += 1;
    this.#sources.set(sourceKey, source);
    this.#accounts.set(accountKey, account);
    return { ok: true, ticket: Object.freeze({ accountKey }) };
  }

  settle(ticket: ThrottleTicket, outcome: "success" | "failure" | "neutral"): void {
    const account = this.#accounts.get(ticket.accountKey);
    if (!account) return;
    account.inflight = Math.max(0, account.inflight - 1);
    if (outcome === "success") {
      if (account.inflight === 0) this.#accounts.delete(ticket.accountKey);
      else { account.failures = 0; account.lockCount = 0; }
      return;
    }
    if (outcome === "neutral") return;
    const now = this.now();
    account.failures += 1;
    if (account.failures >= this.policy.accountFailureLimit) {
      const backoff = Math.min(this.policy.backoffBaseMs * 2 ** account.lockCount, this.policy.backoffMaxMs);
      account.lockedUntil = now + backoff;
      account.lockCount = Math.min(account.lockCount + 1, 16);
      account.failures = 0;
      account.windowStart = now;
    }
  }

  #prune(now: number): void {
    for (const [key, source] of this.#sources) {
      if (now - source.windowStart >= this.policy.sourceWindowMs) this.#sources.delete(key);
    }
    for (const [key, account] of this.#accounts) {
      if (account.inflight === 0 && account.lockedUntil <= now &&
          now - account.windowStart >= this.policy.accountWindowMs + this.policy.backoffMaxMs) {
        this.#accounts.delete(key);
      }
    }
  }
}

function secondsUntil(deadline: number, now: number): number {
  return Math.max(1, Math.ceil((deadline - now) / 1000));
}

const throttleKey = Symbol.for("app-planet.staff-login-throttle.memory-single-process");
type ThrottleGlobal = typeof globalThis & { [throttleKey]?: StaffLoginThrottle };

function processThrottle(): StaffLoginThrottle {
  const global = globalThis as ThrottleGlobal;
  global[throttleKey] ??= new StaffLoginThrottle();
  return global[throttleKey];
}

// ---- 輸入 DTO：只接受 { email, password }；密碼不 trim、不轉大小寫、不記錄 ----
export type StaffLoginInput = Readonly<{ email: string; password: string }>;
type ParsedBody =
  | { readonly kind: "ok"; readonly value: StaffLoginInput }
  | { readonly kind: "unknown_field" }
  | { readonly kind: "invalid" };

const emailPattern = /^[^\s@\p{Cc}]{1,64}@[^\s@\p{Cc}]{1,255}$/u;

export function parseStaffLoginBody(value: unknown): ParsedBody {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return { kind: "invalid" };
  const keys = Object.keys(value);
  if (keys.some((key) => key !== "email" && key !== "password")) return { kind: "unknown_field" };
  const parsed = z.object({ email: z.string(), password: z.string() }).safeParse(value);
  if (!parsed.success) return { kind: "invalid" };
  const { email, password } = parsed.data;
  if (email.length > staffLoginIsolatedTestPolicy.maxEmailLength || !emailPattern.test(email) ||
      password.length === 0 ||
      Buffer.byteLength(password, "utf8") > staffLoginIsolatedTestPolicy.maxPasswordBytes) {
    return { kind: "invalid" };
  }
  return { kind: "ok", value: Object.freeze({ email, password }) };
}

// ---- 受信任 Auth 密碼驗證（正式 password grant；不使用 admin API）----
export type PasswordGrantResult =
  | { readonly outcome: "session"; readonly accessToken: string; readonly expiresIn: number }
  | { readonly outcome: "invalid" }
  // readiness §92：上游只在密碼正確後才回 email_not_confirmed；不代表帳號已核准，也不發 session。
  | { readonly outcome: "email_not_confirmed" }
  | { readonly outcome: "throttled"; readonly retryAfterSeconds: number }
  | { readonly outcome: "unavailable" };

const tokenPattern = /^[A-Za-z0-9._~-]{1,8192}$/;
const grantSchema = z.object({
  access_token: z.string().regex(tokenPattern),
  token_type: z.string().regex(/^bearer$/i),
  expires_in: z.number().int().min(1).max(86_400),
});

export async function requestPasswordGrant(
  input: StaffLoginInput,
  config: AuthConfiguration,
  fetchImpl: typeof fetch = fetch,
  timeoutMs: number = staffLoginIsolatedTestPolicy.authTimeoutMs,
): Promise<PasswordGrantResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await abortable(fetchImpl(`${config.authOrigin}/auth/v1/token?grant_type=password`, {
      method: "POST",
      cache: "no-store",
      redirect: "error",
      headers: {
        apikey: config.authApiKey,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify({ email: input.email, password: input.password }),
      signal: controller.signal,
    }), controller.signal);
    if (response.status === 400 &&
        response.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
      const failure = await readBoundedJson(response, controller.signal, 4_096).catch(() => null);
      const code = z.object({ error_code: z.string() }).safeParse(failure);
      return code.success && code.data.error_code === "email_not_confirmed"
        ? { outcome: "email_not_confirmed" }
        : { outcome: "invalid" };
    }
    if ([400, 401, 403, 404, 422].includes(response.status)) {
      await response.body?.cancel().catch(() => undefined);
      return { outcome: "invalid" };
    }
    if (response.status === 429) {
      await response.body?.cancel().catch(() => undefined);
      const header = Number(response.headers.get("retry-after"));
      return {
        outcome: "throttled",
        retryAfterSeconds: Number.isSafeInteger(header) && header >= 1 && header <= 3_600
          ? header
          : staffLoginIsolatedTestPolicy.upstreamRetryAfterDefaultSeconds,
      };
    }
    if (response.status !== 200 ||
        !response.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
      await response.body?.cancel().catch(() => undefined);
      return { outcome: "unavailable" };
    }
    const body = await readBoundedJson(response, controller.signal, staffLoginIsolatedTestPolicy.maxAuthBodyBytes);
    // refresh_token 等其他欄位不讀取、不保存；本輪不做 refresh。
    const grant = grantSchema.safeParse(body);
    return grant.success
      ? { outcome: "session", accessToken: grant.data.access_token, expiresIn: grant.data.expires_in }
      : { outcome: "unavailable" };
  } catch {
    return { outcome: "unavailable" };
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

export function staffSessionCookie(accessToken: string, maxAgeSeconds: number): string {
  return `${sessionCookieName}=${accessToken}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAgeSeconds}`;
}

export function sameOrigin(request: Request, appOrigin: string): boolean {
  const fetchSite = request.headers.get("sec-fetch-site");
  return request.headers.get("origin") === appOrigin &&
    (fetchSite === null || fetchSite === "same-origin");
}

export interface StaffLoginDependencies {
  readonly env?: NodeJS.ProcessEnv;
  readonly fetchImpl?: typeof fetch;
  readonly throttle?: StaffLoginThrottle;
  readonly readStatus?: (userId: string, env: NodeJS.ProcessEnv) => Promise<AccountStatusRead>;
}

async function defaultReadStatus(userId: string, env: NodeJS.ProcessEnv): Promise<AccountStatusRead> {
  try {
    return await readCurrentAccountStatus(createDatabaseSession(userId, env).read, userId);
  } catch {
    return { outcome: "unavailable" };
  }
}

export function createStaffLoginHandler(
  dependencies: StaffLoginDependencies = {},
): (request: Request) => Promise<Response> {
  const env = dependencies.env ?? process.env;
  const fetchImpl = dependencies.fetchImpl ?? fetch;
  const readStatus = dependencies.readStatus ?? defaultReadStatus;
  return async (request) => {
    const requestId = newRequestId();
    let instance = "/";
    try {
      instance = new URL(request.url).pathname;
    } catch {
      // 固定 instance。
    }
    const context: ResponseContext = { requestId, instance };
    const problem = (code: ProblemCode, extra: Record<string, string> = {}) => problemResponse(code, context, extra);
    try {
      if (request.method !== "POST") return problem("method_not_allowed", { allow: "POST" });
      const runtime = readStaffLoginRuntime(env);
      if (!runtime.ok) return problem("dependency_unavailable");
      if (!sameOrigin(request, runtime.value.auth.appOrigin)) return problem("forbidden");
      const source = readTrustedClientSource(request, runtime.value.sourceProof);
      if (source === null) return problem("forbidden");
      const body = await readJsonBody(request, parseStaffLoginBody, staffLoginIsolatedTestPolicy.maxBodyBytes);
      if (!body.ok) return problem(body.code);
      if (body.data.kind === "unknown_field") return problem("unknown_field");
      if (body.data.kind === "invalid") return problem("invalid_request");
      const input = body.data.value;
      const throttle = dependencies.throttle ?? processThrottle();
      // 未知帳號同樣進桶；不先查帳號是否存在。
      const reservation = throttle.reserve(
        hmacKey(runtime.value.hmacSecret, "staff-login-account-v1", input.email.normalize("NFC").toLowerCase(), source),
        hmacKey(runtime.value.hmacSecret, "staff-login-source-v1", source),
      );
      if (!reservation.ok) {
        return problem("login_throttled", { "retry-after": String(reservation.retryAfterSeconds) });
      }
      const ticket = reservation.ticket;
      let settled = false;
      const settle = (outcome: "success" | "failure" | "neutral") => {
        if (!settled) throttle.settle(ticket, outcome);
        settled = true;
      };
      try {
        const grant = await requestPasswordGrant(input, runtime.value.auth, fetchImpl);
        if (grant.outcome === "invalid") {
          settle("failure");
          return problem("invalid_credentials");
        }
        if (grant.outcome === "email_not_confirmed") {
          settle("neutral");
          return problem("email_not_verified");
        }
        if (grant.outcome === "throttled") {
          settle("neutral");
          return problem("login_throttled", { "retry-after": String(grant.retryAfterSeconds) });
        }
        if (grant.outcome === "unavailable") {
          settle("neutral");
          return problem("dependency_unavailable");
        }
        // 身分只取自固定 /auth/v1/user 的驗證結果，不解碼 JWT。
        const verified = await verifyAccessToken(grant.accessToken, runtime.value.auth, fetchImpl);
        if (verified.outcome !== "authenticated") {
          await revokeAccessToken(grant.accessToken, runtime.value.auth, fetchImpl);
          settle("neutral");
          return problem("dependency_unavailable");
        }
        const status = await readStatus(verified.userId, env).catch((): AccountStatusRead => ({ outcome: "unavailable" }));
        const decision = status.outcome === "found"
          ? decideStaffLogin(status.record)
          : status.outcome === "no_profile"
            ? { kind: "deny" as const, code: "account_unavailable" as const }
            : null;
        if (decision === null || decision.kind === "deny") {
          // 新 session 不交給瀏覽器；撤銷結果不改變拒絕，也不代表上游 session 已必然終結。
          await revokeAccessToken(grant.accessToken, runtime.value.auth, fetchImpl);
          if (decision === null) {
            settle("neutral");
            return problem("dependency_unavailable");
          }
          settle(decision.code === "invalid_credentials" ? "failure" : "neutral");
          return problem(decision.code);
        }
        settle("success");
        const maxAge = Math.min(grant.expiresIn, runtime.value.sessionMaxAgeSeconds);
        return jsonResponse(200, { account_status: decision.accountStatus, landing: decision.landing }, context, {
          "set-cookie": staffSessionCookie(grant.accessToken, maxAge),
        });
      } finally {
        settle("neutral");
      }
    } catch {
      return problem("internal_error");
    }
  };
}
