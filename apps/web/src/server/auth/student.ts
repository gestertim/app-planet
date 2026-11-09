import { z } from "zod";
import {
  abortable, readBoundedJson, revokeAccessToken, verifyAccessToken, type AuthConfiguration,
} from "../auth-principal.ts";
import { createDatabaseSession } from "../database-session.ts";
import {
  jsonResponse, newRequestId, problemResponse, readJsonBody, type ProblemCode,
} from "../http.ts";
import { readCurrentAccountStatus, type AccountStatusRead } from "./account-status.ts";
import {
  hmacKey, readStaffLoginRuntime, readTrustedClientSource, sameOrigin, staffSessionCookie,
  type PasswordGrantResult,
} from "./staff.ts";
import {
  lookupStudentLogin, studentCredentialSchema, type StudentLookup,
} from "./student-lookup.ts";
import { processStudentThrottle, StudentLoginThrottle } from "./student-throttle.ts";
import { parseStudentJson } from "./student-json.ts";

type StudentInput = Readonly<{ handle: string; login_code: string }>;
type ParsedInput = { kind: "ok"; value: StudentInput } | { kind: "invalid" | "unknown_field" };
const whiteEdges = /^\p{White_Space}+|\p{White_Space}+$/gu;

export function parseStudentLoginBody(value: unknown): ParsedInput {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return { kind: "invalid" };
  if (Object.keys(value).some((key) => key !== "handle" && key !== "login_code")) return { kind: "unknown_field" };
  const parsed = z.object({ handle: z.string(), login_code: z.string() }).safeParse(value);
  if (!parsed.success ||
      Buffer.byteLength(parsed.data.handle, "utf8") > 128 ||
      Buffer.byteLength(parsed.data.login_code, "utf8") > 128) return { kind: "invalid" };
  const handle = parsed.data.handle.replace(whiteEdges, "");
  const code = parsed.data.login_code.replace(/[\p{White_Space}-]/gu, "");
  if (!/^[A-Za-z0-9-]{4,32}$/.test(handle) || !/^[0-9A-HJKMNP-TV-Za-hjkmnp-tv-z]{10}$/.test(code)) {
    return { kind: "invalid" };
  }
  return { kind: "ok", value: { handle: handle.toLowerCase(), login_code: code.toUpperCase() } };
}

export function readStudentLoginRuntime(env: NodeJS.ProcessEnv = process.env) {
  const base = readStaffLoginRuntime(env);
  if (!base.ok || !["test", "development"].includes(env.NODE_ENV ?? "") || env.APP_PLANET_ENV !== "isolated-local-test" ||
      env.APP_PLANET_STUDENT_LOGIN_MODE !== "isolated-local-test" ||
      env.APP_PLANET_STUDENT_AUTH_TTL_SECONDS !== "600" ||
      !z.uuid().safeParse(env.APP_PLANET_STUDENT_LOGIN_ISOLATION_ID).success ||
      !/^ap-[0-9a-f-]{36}@example[.]invalid$/.test(env.APP_PLANET_STUDENT_DUMMY_ALIAS ?? "") ||
      !base.value.auth.appOrigin.startsWith("https:")) return null;
  try {
    const url = new URL(env.APP_PLANET_STUDENT_LOGIN_DATABASE_URL ?? "");
    if (!["postgres:", "postgresql:"].includes(url.protocol) ||
        !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
        url.username !== "app_student_login_runtime") return null;
    return { ...base.value, dummyAlias: env.APP_PLANET_STUDENT_DUMMY_ALIAS! };
  } catch {
    return null;
  }
}

const grantSchema = z.object({
  access_token: z.string().regex(/^[A-Za-z0-9._~-]{1,8192}$/),
  token_type: z.string().regex(/^bearer$/i),
  expires_in: z.literal(600),
});

export async function requestStudentGrant(
  email: string, password: string, auth: AuthConfiguration, fetchImpl: typeof fetch = fetch,
  timeoutMs = 5_000,
): Promise<PasswordGrantResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await abortable(fetchImpl(`${auth.authOrigin}/auth/v1/token?grant_type=password`, {
      method: "POST", cache: "no-store", redirect: "error", signal: controller.signal,
      headers: { apikey: auth.authApiKey, "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ email, password }),
    }), controller.signal);
    if (response.status === 429) {
      await abortable(response.body?.cancel() ?? Promise.resolve(), controller.signal);
      const retry = Number(response.headers.get("retry-after"));
      return { outcome: "throttled", retryAfterSeconds: Number.isSafeInteger(retry) && retry >= 1 && retry <= 3600 ? retry : 60 };
    }
    if (![200, 400, 401, 403, 422].includes(response.status) ||
        response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json") {
      await abortable(response.body?.cancel() ?? Promise.resolve(), controller.signal);
      return { outcome: "unavailable" };
    }
    const body = await readBoundedJson(response, controller.signal, 64 * 1024);
    if (response.status !== 200) {
      const failure = z.object({ error_code: z.string() }).safeParse(body);
      return failure.success && failure.data.error_code === "invalid_credentials"
        ? { outcome: "invalid" } : { outcome: "unavailable" };
    }
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

export function decideStudentLogin(read: AccountStatusRead, userId: string): ProblemCode | null {
  if (read.outcome !== "found" || read.record.subject.toLowerCase() !== userId.toLowerCase()) return "dependency_unavailable";
  const r = read.record;
  if (r.role !== "student") return "invalid_credentials";
  if (r.status !== "approved" || r.deletion_state !== "none") return "account_unavailable";
  if (!r.school_found || r.school_state === null || r.school_state === "unconfirmed") return "school_not_confirmed";
  return r.login_gate ? null : "account_unavailable";
}

export interface StudentLoginDependencies {
  readonly env?: NodeJS.ProcessEnv;
  readonly fetchImpl?: typeof fetch;
  readonly throttle?: StudentLoginThrottle;
  readonly lookup?: (handle: string, env: NodeJS.ProcessEnv) => Promise<StudentLookup>;
  readonly readStatus?: (id: string, env: NodeJS.ProcessEnv) => Promise<AccountStatusRead>;
}

export function createStudentLoginHandler(dependencies: StudentLoginDependencies = {}) {
  const env = dependencies.env ?? process.env;
  const fetchImpl = dependencies.fetchImpl ?? fetch;
  const lookup = dependencies.lookup ?? lookupStudentLogin;
  const readStatus = dependencies.readStatus ?? ((id, settings) =>
    readCurrentAccountStatus(createDatabaseSession(id, settings).read, id));
  return async (request: Request): Promise<Response> => {
    const context = { requestId: newRequestId(), instance: "/api/v1/auth/student/login" };
    const problem = async (code: ProblemCode, headers: Record<string, string> = {}) => {
      const response = problemResponse(code, context, headers);
      if (code !== "invalid_credentials" && code !== "account_unavailable") return response;
      const body: unknown = await response.json();
      if (typeof body !== "object" || body === null) return problemResponse("dependency_unavailable", context);
      return new Response(JSON.stringify({ ...body, user_message_zh: code === "invalid_credentials"
        ? "請確認帳號與登入碼後再試一次。" : "帳號目前無法使用，請找老師或管理員協助。" }),
      { status: response.status, headers: response.headers });
    };
    try {
      if (request.method !== "POST") return problem("method_not_allowed", { allow: "POST" });
      const runtime = readStudentLoginRuntime(env);
      if (!runtime) return problem("dependency_unavailable");
      if (!sameOrigin(request, runtime.auth.appOrigin)) return problem("forbidden");
      const source = readTrustedClientSource(request, runtime.sourceProof);
      if (source === null) return problem("forbidden");
      const body = await readJsonBody(request, parseStudentLoginBody, 4096, parseStudentJson);
      if (!body.ok) return problem(body.code);
      if (body.data.kind !== "ok") return problem(body.data.kind === "unknown_field" ? "unknown_field" : "invalid_request");
      const input = body.data.value;
      const throttle = dependencies.throttle ?? processStudentThrottle();
      const reservation = throttle.reserve(
        hmacKey(runtime.hmacSecret, "student-login-pair-v1", input.handle, source),
        hmacKey(runtime.hmacSecret, "student-login-source-v1", source),
      );
      if (!reservation.ok) return problem("login_throttled", { "retry-after": String(reservation.retryAfterSeconds) });
      let outcome: "success" | "failure" | "neutral" = "neutral";
      let token: string | null = null;
      try {
        const found = await lookup(input.handle, env);
        if (found.outcome === "unavailable") return problem("dependency_unavailable");
        const credential = found.outcome === "found" ? studentCredentialSchema.safeParse(found.credential) : null;
        if (credential && !credential.success) return problem("dependency_unavailable");
        const active = credential?.success && credential.data.state === "active" ? credential.data : null;
        const grant = await requestStudentGrant(active?.auth_email_alias ?? runtime.dummyAlias, input.login_code, runtime.auth, fetchImpl);
        if (grant.outcome === "invalid") { outcome = "failure"; return problem("invalid_credentials"); }
        if (grant.outcome === "throttled") return problem("login_throttled", { "retry-after": String(grant.retryAfterSeconds) });
        if (grant.outcome !== "session") return problem("dependency_unavailable");
        token = grant.accessToken;
        if (!active) return problem("dependency_unavailable");
        const verified = await verifyAccessToken(token, runtime.auth, fetchImpl);
        if (verified.outcome !== "authenticated" || verified.userId.toLowerCase() !== active.student_id.toLowerCase()) {
          return problem("dependency_unavailable");
        }
        const decision = decideStudentLogin(await readStatus(verified.userId, env), verified.userId);
        if (decision) return problem(decision);
        const reread = await lookup(input.handle, env);
        if (reread.outcome !== "found" ||
            !studentCredentialSchema.safeParse(reread.credential).success ||
            reread.credential.student_id !== active.student_id ||
            reread.credential.auth_email_alias !== active.auth_email_alias ||
            reread.credential.version !== active.version || reread.credential.state !== "active") {
          return problem("dependency_unavailable");
        }
        const finalDecision = decideStudentLogin(await readStatus(verified.userId, env), verified.userId);
        if (finalDecision) return problem("dependency_unavailable");
        const response = jsonResponse(200, { account_status: "approved", landing: "home" }, context,
          { "set-cookie": staffSessionCookie(token, Math.min(grant.expiresIn, 600)) });
        outcome = "success";
        return response;
      } finally {
        throttle.settle(reservation.ticket, outcome);
        if (token !== null && outcome !== "success") {
          const revoked = await revokeAccessToken(token, runtime.auth, fetchImpl);
          console.info(JSON.stringify({ check: "student-login-local-logout", result: revoked }));
        }
      }
    } catch {
      return problem("dependency_unavailable");
    }
  };
}
