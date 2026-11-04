import { describe, expect, it, vi } from "vitest";
import {
  clientSourceHeader,
  createStaffLoginHandler,
  parseStaffLoginBody,
  readStaffLoginRuntime,
  readTrustedClientSource,
  requestPasswordGrant,
  sourceProofHeader,
  staffLoginIsolatedTestPolicy,
  StaffLoginThrottle,
} from "../../apps/web/src/server/auth/staff.ts";
import type { AccountStatusRead, AccountStatusRecord } from "../../apps/web/src/server/auth/account-status.ts";
import type { AuthConfiguration } from "../../apps/web/src/server/auth-principal.ts";
import { findProductionTestEnvironmentViolations } from "../support/production-isolation.ts";
import { buildForwardHeaders, normalizeLoopbackSource } from "../../scripts/trusted-source-proxy.mjs";

const proof = "a1".repeat(32);
const appOrigin = "https://localhost:3443";
const userId = "b7000000-0000-4000-8000-0000000000aa";
const syntheticToken = "synthetic.access.token-for-unit";
const baseEnv = Object.freeze({
  NODE_ENV: "test",
  APP_PLANET_LOCAL_AUTH: "1",
  APP_PLANET_AUTH_ORIGIN: "http://127.0.0.1:54321",
  APP_PLANET_APP_ORIGIN: appOrigin,
  APP_PLANET_AUTH_API_KEY: "public-test-key",
  APP_PLANET_DATABASE_URL: "postgresql://synthetic@127.0.0.1:5432/app",
  APP_PLANET_STAFF_LOGIN_MODE: "isolated-local-test",
  APP_PLANET_STAFF_LOGIN_THROTTLE_BACKEND: "memory-single-process",
  APP_PLANET_STAFF_LOGIN_HMAC_SECRET: "b2".repeat(32),
  APP_PLANET_SOURCE_PROXY_PROOF: proof,
  APP_PLANET_STAFF_SESSION_MAX_AGE_SECONDS: "900",
}) as unknown as NodeJS.ProcessEnv;

const authConfig: AuthConfiguration = {
  authOrigin: "http://127.0.0.1:54321",
  authApiKey: "public-test-key",
  appOrigin,
  localHttp: true,
};

function record(overrides: Partial<AccountStatusRecord> = {}): AccountStatusRecord {
  return {
    subject: userId,
    role: "teacher",
    status: "approved",
    deletion_state: "none",
    school_found: false,
    school_state: null,
    login_gate: true,
    public_deploy_gate: false,
    ai_call_gate: false,
    teacher_labels: [],
    ...overrides,
  };
}

function loginRequest(
  body: unknown = { email: "teacher@example.invalid", password: "Correct-Horse 9!" },
  headers: Record<string, string> = {},
  source = "127.0.0.1",
): Request {
  return new Request(`${appOrigin}/api/v1/auth/staff/login`, {
    method: "POST",
    headers: {
      origin: appOrigin,
      "sec-fetch-site": "same-origin",
      "content-type": "application/json",
      [clientSourceHeader]: source,
      [sourceProofHeader]: proof,
      ...headers,
    },
    body: typeof body === "string" ? body : body instanceof Uint8Array ? new Blob([new Uint8Array(body)]) : JSON.stringify(body),
  });
}

type AuthScript = {
  token?: () => Response | Promise<Response>;
  user?: () => Response | Promise<Response>;
  logout?: () => Response | Promise<Response>;
};

function fakeAuth(script: AuthScript = {}) {
  const calls: { path: string; body: string | null }[] = [];
  const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(String(input));
    calls.push({ path: url.pathname + url.search, body: typeof init?.body === "string" ? init.body : null });
    expect(url.origin).toBe("http://127.0.0.1:54321");
    expect(init?.redirect).toBe("error");
    if (url.pathname === "/auth/v1/token") {
      return script.token ? script.token() : Response.json({
        access_token: syntheticToken, token_type: "bearer", expires_in: 60, refresh_token: "synthetic-refresh",
        user: { id: userId, role: "admin" },
      });
    }
    if (url.pathname === "/auth/v1/user") {
      return script.user ? script.user() : Response.json({ id: userId });
    }
    if (url.pathname === "/auth/v1/logout") {
      return script.logout ? script.logout() : new Response(null, { status: 204 });
    }
    throw new Error("unexpected Auth path");
  });
  return { fetchImpl, calls, count: (path: string) => calls.filter((call) => call.path.startsWith(path)).length };
}

function handlerWith(
  options: { auth?: ReturnType<typeof fakeAuth>; status?: AccountStatusRead | (() => Promise<AccountStatusRead>);
    env?: NodeJS.ProcessEnv; throttle?: StaffLoginThrottle } = {},
) {
  const auth = options.auth ?? fakeAuth();
  const status = options.status ?? { outcome: "found", record: record() };
  const readStatus = vi.fn(async () => (typeof status === "function" ? status() : status));
  const handler = createStaffLoginHandler({
    env: options.env ?? baseEnv,
    fetchImpl: auth.fetchImpl,
    throttle: options.throttle ?? new StaffLoginThrottle(),
    readStatus,
  });
  return { handler, auth, readStatus };
}

async function problemCode(response: Response): Promise<string> {
  expect(response.headers.get("content-type")).toMatch(/^application\/problem\+json/);
  const body = await response.json() as { code: string };
  return body.code;
}

describe("staff login isolated runtime", () => {
  it("enables only with every explicit isolated-local setting and loopback targets", () => {
    expect(readStaffLoginRuntime(baseEnv).ok).toBe(true);
    for (const name of [
      "APP_PLANET_STAFF_LOGIN_MODE", "APP_PLANET_STAFF_LOGIN_THROTTLE_BACKEND", "APP_PLANET_STAFF_LOGIN_HMAC_SECRET",
      "APP_PLANET_SOURCE_PROXY_PROOF", "APP_PLANET_STAFF_SESSION_MAX_AGE_SECONDS", "APP_PLANET_LOCAL_AUTH",
    ]) {
      const env = { ...baseEnv };
      delete env[name];
      expect(readStaffLoginRuntime(env).ok, name).toBe(false);
    }
    expect(readStaffLoginRuntime({ ...baseEnv, NODE_ENV: "production" }).ok).toBe(false);
    expect(readStaffLoginRuntime({ ...baseEnv, APP_PLANET_ENV: "Production" }).ok).toBe(false);
    expect(readStaffLoginRuntime({ ...baseEnv, APP_PLANET_STAFF_LOGIN_MODE: "on" }).ok).toBe(false);
    expect(readStaffLoginRuntime({ ...baseEnv, APP_PLANET_STAFF_LOGIN_THROTTLE_BACKEND: "redis" }).ok).toBe(false);
    expect(readStaffLoginRuntime({ ...baseEnv, APP_PLANET_AUTH_ORIGIN: "https://auth.example.invalid" }).ok).toBe(false);
    expect(readStaffLoginRuntime({ ...baseEnv, APP_PLANET_DATABASE_URL: "postgresql://u@db.example.invalid/app" }).ok)
      .toBe(false);
    expect(readStaffLoginRuntime({ ...baseEnv, APP_PLANET_STAFF_SESSION_MAX_AGE_SECONDS: "86400" }).ok).toBe(false);
    expect(readStaffLoginRuntime({ ...baseEnv, APP_PLANET_STAFF_LOGIN_HMAC_SECRET: "short" }).ok).toBe(false);
  });

  it("returns a controlled 503 without contacting Auth when the isolated setting is missing", async () => {
    const env = { ...baseEnv };
    delete env.APP_PLANET_STAFF_LOGIN_MODE;
    const { handler, auth } = handlerWith({ env });
    const response = await handler(loginRequest());
    expect(response.status).toBe(503);
    expect(await problemCode(response)).toBe("dependency_unavailable");
    expect(auth.fetchImpl).not.toHaveBeenCalled();
  });

  it("flags the staff login test mode next to production markers in the shared isolation tool", () => {
    expect(findProductionTestEnvironmentViolations({ APP_PLANET_STAFF_LOGIN_MODE: "isolated-local-test", NODE_ENV: "production" }))
      .toContain("APP_PLANET_STAFF_LOGIN_MODE");
    expect(findProductionTestEnvironmentViolations({ APP_PLANET_STAFF_LOGIN_MODE: "isolated-local-test", NODE_ENV: "test" }))
      .toEqual([]);
  });
});

describe("staff login request boundary", () => {
  it("rejects cross-site and unproven sources before reading the body or contacting Auth", async () => {
    const cases: Request[] = [
      loginRequest(undefined, { origin: "https://evil.example.invalid" }),
      loginRequest(undefined, { "sec-fetch-site": "cross-site" }),
      loginRequest(undefined, { [sourceProofHeader]: "c3".repeat(32) }),
      loginRequest(undefined, { [sourceProofHeader]: "not-hex" }),
      loginRequest(undefined, {}, "not-an-ip"),
    ];
    const withoutProof = loginRequest(undefined, { "x-forwarded-for": "198.51.100.7" });
    withoutProof.headers.delete(sourceProofHeader);
    cases.push(withoutProof);
    const withoutOrigin = loginRequest();
    withoutOrigin.headers.delete("origin");
    cases.push(withoutOrigin);
    for (const request of cases) {
      const { handler, auth } = handlerWith();
      const response = await handler(request);
      expect(response.status).toBe(403);
      expect(await problemCode(response)).toBe("forbidden");
      expect(auth.fetchImpl).not.toHaveBeenCalled();
    }
  });

  it("reads the network source only from the proven proxy header, never X-Forwarded-For", () => {
    const proofBytes = Buffer.from(proof, "hex");
    expect(readTrustedClientSource(loginRequest(undefined, { "x-forwarded-for": "198.51.100.7" }), proofBytes))
      .toBe("127.0.0.1");
    expect(readTrustedClientSource(loginRequest(undefined, {}, "::ffff:127.0.0.4"), proofBytes)).toBe("127.0.0.4");
    const forged = loginRequest(undefined, { "x-forwarded-for": "198.51.100.7" });
    forged.headers.delete(clientSourceHeader);
    expect(readTrustedClientSource(forged, proofBytes)).toBeNull();
  });

  it("accepts only the strict { email, password } DTO and keeps the password byte-exact", async () => {
    expect(parseStaffLoginBody({ email: "a@example.invalid", password: "x", role: "admin" })).toEqual({ kind: "unknown_field" });
    for (const extra of ["user_id", "account_status", "school_id"]) {
      expect(parseStaffLoginBody({ email: "a@example.invalid", password: "x", [extra]: "y" }).kind).toBe("unknown_field");
    }
    expect(parseStaffLoginBody({ email: "a@example.invalid" }).kind).toBe("invalid");
    expect(parseStaffLoginBody({ email: 1, password: "x" }).kind).toBe("invalid");
    expect(parseStaffLoginBody({ email: "not-an-email", password: "x" }).kind).toBe("invalid");
    expect(parseStaffLoginBody({ email: "a@example.invalid", password: "" }).kind).toBe("invalid");
    expect(parseStaffLoginBody({ email: "a@example.invalid", password: "é".repeat(513) }).kind).toBe("invalid");
    expect(parseStaffLoginBody([]).kind).toBe("invalid");

    const { handler, auth } = handlerWith({ auth: fakeAuth({ token: () => Response.json({}, { status: 400 }) }) });
    const response = await handler(loginRequest({ email: "teacher@example.invalid", password: "  Mixed Case  " }));
    expect(response.status).toBe(401);
    expect(JSON.parse(auth.calls[0]!.body!)).toEqual({ email: "teacher@example.invalid", password: "  Mixed Case  " });
  });

  it("maps unknown fields, media type, malformed, oversized and invalid UTF-8 bodies to problem codes", async () => {
    const cases: [Request, number, string][] = [
      [loginRequest({ email: "a@example.invalid", password: "x", role: "admin" }), 422, "unknown_field"],
      [loginRequest(undefined, { "content-type": "text/plain" }), 415, "unsupported_media_type"],
      [loginRequest("{not json"), 400, "invalid_request"],
      [loginRequest(JSON.stringify({ email: "a@example.invalid", password: "x".repeat(5_000) })), 413, "payload_too_large"],
      [loginRequest(new Uint8Array([0x7b, 0x22, 0xff, 0x22, 0x7d])), 400, "invalid_request"],
    ];
    for (const [request, status, code] of cases) {
      const { handler, auth } = handlerWith();
      const response = await handler(request);
      expect(response.status, code).toBe(status);
      expect(await problemCode(response)).toBe(code);
      expect(auth.fetchImpl).not.toHaveBeenCalled();
    }
    const { handler } = handlerWith();
    const wrongMethod = await handler(new Request(`${appOrigin}/api/v1/auth/staff/login`, { method: "GET" }));
    expect(wrongMethod.status).toBe(405);
  });
});

describe("trusted Auth password grant", () => {
  const input = { email: "teacher@example.invalid", password: "Correct-Horse 9!" };

  it("fails closed for malformed, oversized, truncated, redirected or unavailable Auth responses", async () => {
    const responses: (() => Response)[] = [
      () => new Response("oops", { status: 500 }),
      () => new Response(null, { status: 302, headers: { location: "https://evil.example.invalid/" } }),
      () => new Response("{}", { status: 200, headers: { "content-type": "text/html" } }),
      () => new Response("{not json", { status: 200, headers: { "content-type": "application/json" } }),
      () => Response.json({ access_token: syntheticToken, token_type: "bearer" }),
      () => Response.json({ access_token: "has space", token_type: "bearer", expires_in: 60 }),
      () => new Response(JSON.stringify({ padding: "x".repeat(70 * 1024) }), { headers: { "content-type": "application/json" } }),
      () => new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("{\"access_token\":"));
          controller.error(new Error("connection reset"));
        },
      }), { headers: { "content-type": "application/json" } }),
      () => new Response(new Uint8Array([0x7b, 0x22, 0xff]), { headers: { "content-type": "application/json" } }),
    ];
    for (const make of responses) {
      const result = await requestPasswordGrant(input, authConfig, vi.fn<typeof fetch>(async () => make()));
      expect(result).toEqual({ outcome: "unavailable" });
    }
    expect(await requestPasswordGrant(input, authConfig, vi.fn<typeof fetch>(async () => {
      throw new TypeError("redirect mode is error");
    }))).toEqual({ outcome: "unavailable" });
  });

  it("bounds the whole exchange including a stalled response body", async () => {
    const started = Date.now();
    const stalled = vi.fn<typeof fetch>(async () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode("{")); },
    }), { headers: { "content-type": "application/json" } }));
    expect(await requestPasswordGrant(input, authConfig, stalled, 50)).toEqual({ outcome: "unavailable" });
    const hanging = vi.fn<typeof fetch>(() => new Promise<Response>(() => undefined));
    expect(await requestPasswordGrant(input, authConfig, hanging, 50)).toEqual({ outcome: "unavailable" });
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("maps credential rejections and upstream throttling without exposing upstream bodies", async () => {
    for (const status of [400, 401, 403, 404, 422]) {
      const result = await requestPasswordGrant(input, authConfig, vi.fn<typeof fetch>(async () =>
        Response.json({ error: "invalid_grant", error_description: "Invalid login credentials" }, { status })));
      expect(result).toEqual({ outcome: "invalid" });
    }
    expect(await requestPasswordGrant(input, authConfig, vi.fn<typeof fetch>(async () =>
      new Response(null, { status: 429, headers: { "retry-after": "12" } })))).toEqual({ outcome: "throttled", retryAfterSeconds: 12 });
    expect(await requestPasswordGrant(input, authConfig, vi.fn<typeof fetch>(async () =>
      new Response(null, { status: 429 })))).toEqual({
      outcome: "throttled", retryAfterSeconds: staffLoginIsolatedTestPolicy.upstreamRetryAfterDefaultSeconds,
    });
  });
});

describe("staff login session issuance", () => {
  it("issues only the protected session cookie for approved staff and keeps tokens out of the body", async () => {
    for (const [role, landing] of [["teacher", "teacher_home"], ["admin", "admin_home"]] as const) {
      const { handler, auth } = handlerWith({ status: { outcome: "found", record: record({ role }) } });
      const response = await handler(loginRequest());
      expect(response.status).toBe(200);
      const text = await response.text();
      expect(JSON.parse(text)).toEqual({ account_status: "approved", landing });
      expect(text).not.toContain(syntheticToken);
      expect(text).not.toContain("synthetic-refresh");
      expect(response.headers.get("cache-control")).toContain("no-store");
      const cookie = response.headers.get("set-cookie")!;
      expect(cookie).toBe(`__Host-app-planet-session=${syntheticToken}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=60`);
      expect(cookie).not.toMatch(/domain=/i);
      expect(cookie).not.toContain("synthetic-refresh");
      expect(auth.count("/auth/v1/user")).toBe(1);
      expect(auth.count("/auth/v1/logout")).toBe(0);
    }
  });

  it("never lets the cookie outlive the Auth result or the isolated session setting", async () => {
    const auth = fakeAuth({
      token: () => Response.json({ access_token: syntheticToken, token_type: "bearer", expires_in: 3_600 }),
    });
    const { handler } = handlerWith({ auth, env: { ...baseEnv, APP_PLANET_STAFF_SESSION_MAX_AGE_SECONDS: "120" } });
    const response = await handler(loginRequest());
    expect(response.headers.get("set-cookie")).toMatch(/Max-Age=120$/);
  });

  it("replaces any caller session instead of reusing it", async () => {
    const { handler, auth } = handlerWith();
    const response = await handler(loginRequest(undefined, { cookie: "__Host-app-planet-session=caller.supplied.token" }));
    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toContain(`=${syntheticToken};`);
    expect(auth.calls.every((call) => !call.body?.includes("caller.supplied.token"))).toBe(true);
  });

  it("gives pending and rejected staff a session that lands only on the account status page", async () => {
    for (const status of ["pending", "rejected"] as const) {
      const { handler } = handlerWith({ status: { outcome: "found", record: record({ status }) } });
      const response = await handler(loginRequest());
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ account_status: status, landing: "account_status" });
    }
  });

  it("denies students, disabled, deleted and profile-less accounts, revoking the new Auth session", async () => {
    const cases: [AccountStatusRead, number, string][] = [
      [{ outcome: "found", record: record({ role: "student", school_found: true, school_state: "approved" }) }, 401,
        "invalid_credentials"],
      [{ outcome: "found", record: record({ status: "disabled", login_gate: false }) }, 403, "account_unavailable"],
      [{ outcome: "found", record: record({ deletion_state: "marked", login_gate: false }) }, 403, "account_unavailable"],
      [{ outcome: "no_profile" }, 403, "account_unavailable"],
      [{ outcome: "unavailable" }, 503, "dependency_unavailable"],
    ];
    for (const [status, httpStatus, code] of cases) {
      const { handler, auth } = handlerWith({ status });
      const response = await handler(loginRequest());
      expect(response.status, code).toBe(httpStatus);
      expect(await problemCode(response)).toBe(code);
      expect(response.headers.get("set-cookie")).toBeNull();
      expect(auth.count("/auth/v1/logout")).toBe(1);
    }
  });

  it("keeps the denial when revocation fails and when the DB read throws", async () => {
    const failingLogout = fakeAuth({ logout: () => new Response("down", { status: 500 }) });
    const denied = await handlerWith({ auth: failingLogout, status: { outcome: "no_profile" } }).handler(loginRequest());
    expect(denied.status).toBe(403);
    expect(denied.headers.get("set-cookie")).toBeNull();

    const throwing = handlerWith({ status: async () => { throw new Error("db down"); } });
    const response = await throwing.handler(loginRequest());
    expect(response.status).toBe(503);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(throwing.auth.count("/auth/v1/logout")).toBe(1);
  });

  it("does not trust the grant without the fixed /auth/v1/user verification", async () => {
    const auth = fakeAuth({ user: () => new Response(null, { status: 401 }) });
    const { handler, readStatus } = handlerWith({ auth });
    const response = await handler(loginRequest());
    expect(response.status).toBe(503);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(readStatus).not.toHaveBeenCalled();
    expect(auth.count("/auth/v1/logout")).toBe(1);
  });

  it("does not leak upstream messages and uses the same problem body for wrong password and unknown account", async () => {
    const bodies: string[] = [];
    for (const description of ["Invalid login credentials", "User not found"]) {
      const auth = fakeAuth({ token: () => Response.json({ error_description: description }, { status: 400 }) });
      const response = await handlerWith({ auth }).handler(loginRequest());
      expect(response.status).toBe(401);
      const body = await response.json() as Record<string, unknown>;
      delete body.request_id;
      bodies.push(JSON.stringify(body));
      expect(JSON.stringify(body)).not.toContain(description);
    }
    expect(bodies[0]).toBe(bodies[1]);
  });
});

describe("staff login throttle", () => {
  it("locks an account×source key after the failure limit without contacting Auth again", async () => {
    const throttle = new StaffLoginThrottle();
    const auth = fakeAuth({ token: () => Response.json({}, { status: 400 }) });
    const { handler } = handlerWith({ auth, throttle });
    for (let attempt = 0; attempt < staffLoginIsolatedTestPolicy.accountFailureLimit; attempt += 1) {
      expect((await handler(loginRequest())).status).toBe(401);
    }
    const locked = await handler(loginRequest());
    expect(locked.status).toBe(429);
    expect(await problemCode(locked)).toBe("login_throttled");
    expect(Number(locked.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(auth.count("/auth/v1/token")).toBe(staffLoginIsolatedTestPolicy.accountFailureLimit);
    const otherSource = await handler(loginRequest(undefined, {}, "127.0.0.2"));
    expect(otherSource.status).toBe(401);
  });

  it("counts unknown accounts the same way and caps total attempts per source", async () => {
    const throttle = new StaffLoginThrottle();
    const auth = fakeAuth({ token: () => Response.json({}, { status: 400 }) });
    const { handler } = handlerWith({ auth, throttle });
    for (let index = 0; index < staffLoginIsolatedTestPolicy.sourceAttemptLimit; index += 1) {
      const response = await handler(loginRequest({ email: `unknown-${index}@example.invalid`, password: "x" }, {}, "127.0.0.3"));
      expect(response.status).toBe(401);
    }
    const capped = await handler(loginRequest({ email: "another@example.invalid", password: "x" }, {}, "127.0.0.3"));
    expect(capped.status).toBe(429);
    expect(auth.count("/auth/v1/token")).toBe(staffLoginIsolatedTestPolicy.sourceAttemptLimit);
  });

  it("does not let concurrent attempts pass the account limit while Auth is pending", async () => {
    const releases: (() => void)[] = [];
    const auth = fakeAuth({
      token: () => new Promise<Response>((resolve) => releases.push(() => resolve(Response.json({}, { status: 400 })))),
    });
    const { handler } = handlerWith({ auth, throttle: new StaffLoginThrottle() });
    const pending = Array.from({ length: 12 }, () => handler(loginRequest()));
    await vi.waitFor(() => expect(releases.length).toBe(staffLoginIsolatedTestPolicy.accountFailureLimit));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(releases.length).toBe(staffLoginIsolatedTestPolicy.accountFailureLimit);
    releases.forEach((release) => release());
    const statuses = (await Promise.all(pending)).map((response) => response.status).sort();
    expect(statuses.filter((status) => status === 401)).toHaveLength(staffLoginIsolatedTestPolicy.accountFailureLimit);
    expect(statuses.filter((status) => status === 429)).toHaveLength(12 - staffLoginIsolatedTestPolicy.accountFailureLimit);
  });

  it("uses bounded exponential backoff and resets after success", () => {
    let now = 1_000_000;
    const throttle = new StaffLoginThrottle(staffLoginIsolatedTestPolicy, () => now);
    const lockOnce = () => {
      for (let index = 0; index < staffLoginIsolatedTestPolicy.accountFailureLimit; index += 1) {
        const reservation = throttle.reserve("account", `source-${now}-${index}`);
        expect(reservation.ok).toBe(true);
        if (reservation.ok) throttle.settle(reservation.ticket, "failure");
      }
      const blocked = throttle.reserve("account", `source-${now}-blocked`);
      expect(blocked.ok).toBe(false);
      return blocked.ok ? 0 : blocked.retryAfterSeconds;
    };
    expect(lockOnce()).toBe(30);
    now += 30_000;
    expect(lockOnce()).toBe(60);
    now += 60_000;
    expect(lockOnce()).toBe(120);
    now += 120_000;
    expect(lockOnce()).toBe(240);
    now += 240_000;
    expect(lockOnce()).toBe(300);
    now += 300_000;
    const success = throttle.reserve("account", "fresh-source");
    expect(success.ok).toBe(true);
    if (success.ok) throttle.settle(success.ticket, "success");
    expect(lockOnce()).toBe(30);
  });

  it("stores only HMAC keys and fails closed when the throttle backend fails", async () => {
    const throttle = new StaffLoginThrottle();
    const reserve = vi.spyOn(throttle, "reserve");
    const { handler } = handlerWith({ throttle });
    await handler(loginRequest({ email: "Teacher@Example.invalid", password: "x" }, {}, "127.0.0.9"));
    const [accountKey, sourceKey] = reserve.mock.calls[0]!;
    for (const key of [accountKey, sourceKey]) {
      expect(key).toMatch(/^[0-9a-f]{64}$/);
      expect(key).not.toContain("teacher");
      expect(key).not.toContain("127.0.0.9");
    }

    const broken = new StaffLoginThrottle();
    vi.spyOn(broken, "reserve").mockImplementation(() => { throw new Error("backend down"); });
    const failing = handlerWith({ throttle: broken });
    const response = await failing.handler(loginRequest());
    expect(response.status).toBe(500);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(failing.auth.fetchImpl).not.toHaveBeenCalled();
  });
});

describe("trusted source proxy headers", () => {
  it("strips caller-supplied forwarding and source headers before injecting the proven source", () => {
    const forwarded = buildForwardHeaders([
      "Host", "localhost:3443",
      "X-Forwarded-For", "198.51.100.7",
      "Forwarded", "for=198.51.100.7",
      "X-Real-IP", "198.51.100.7",
      "X-App-Planet-Client-Source", "198.51.100.7",
      "X-App-Planet-Source-Proof", "c3".repeat(32),
      "Connection", "keep-alive, X-Custom-Hop",
      "X-Custom-Hop", "1",
      "Content-Type", "application/json",
    ], "127.0.0.5", proof);
    const pairs: [string, string][] = [];
    for (let index = 0; index < forwarded.length; index += 2) pairs.push([forwarded[index]!.toLowerCase(), forwarded[index + 1]!]);
    expect(pairs).toEqual([
      ["host", "localhost:3443"],
      ["content-type", "application/json"],
      [clientSourceHeader, "127.0.0.5"],
      [sourceProofHeader, proof],
    ]);
  });

  it("accepts only loopback peers", () => {
    expect(normalizeLoopbackSource("127.0.0.1")).toBe("127.0.0.1");
    expect(normalizeLoopbackSource("::ffff:127.0.0.7")).toBe("127.0.0.7");
    expect(normalizeLoopbackSource("::1")).toBe("::1");
    expect(normalizeLoopbackSource("192.168.1.10")).toBeNull();
    expect(normalizeLoopbackSource("::ffff:10.0.0.1")).toBeNull();
    expect(normalizeLoopbackSource(undefined)).toBeNull();
  });
});
