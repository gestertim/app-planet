import { describe, expect, it, vi } from "vitest";
import {
  createAuthPrincipalResolver,
  readAuthConfiguration,
  readSessionCookie,
  verifyAccessToken,
  type AuthConfiguration,
} from "../../apps/web/src/server/auth-principal.ts";

const configuration: AuthConfiguration = {
  authOrigin: "https://auth.example.invalid",
  authApiKey: "public-test-key",
  appOrigin: "https://app.example.invalid",
  localHttp: false,
};

describe("server Auth principal", () => {
  it("requires protected origins and server Auth configuration", () => {
    expect(readAuthConfiguration({ NODE_ENV: "production" } as NodeJS.ProcessEnv).ok).toBe(false);
    expect(readAuthConfiguration({
      NODE_ENV: "production",
      APP_PLANET_AUTH_ORIGIN: "http://127.0.0.1:54321",
      APP_PLANET_APP_ORIGIN: "https://app.example.invalid",
      APP_PLANET_AUTH_API_KEY: "public-test-key",
    } as NodeJS.ProcessEnv).ok).toBe(false);
    expect(readAuthConfiguration({
      NODE_ENV: "test",
      APP_PLANET_LOCAL_AUTH: "1",
      APP_PLANET_AUTH_ORIGIN: "http://127.0.0.1:54321",
      APP_PLANET_APP_ORIGIN: "http://127.0.0.1:3000",
      APP_PLANET_AUTH_API_KEY: "public-test-key",
    } as NodeJS.ProcessEnv)).toMatchObject({ ok: true });
    expect(readAuthConfiguration({
      NODE_ENV: "production",
      APP_PLANET_LOCAL_AUTH: "1",
      APP_PLANET_AUTH_ORIGIN: "http://127.0.0.1:54321",
      APP_PLANET_APP_ORIGIN: "http://127.0.0.1:3000",
      APP_PLANET_AUTH_API_KEY: "public-test-key",
    } as NodeJS.ProcessEnv).ok).toBe(false);
  });

  it("rejects missing, duplicate, oversized, and malformed session cookies", () => {
    expect(readSessionCookie(null)).toBeNull();
    expect(readSessionCookie("__Host-app-planet-session=one; __Host-app-planet-session=two")).toBeNull();
    expect(readSessionCookie("__Host-app-planet-session=has%20space")).toBeNull();
    expect(readSessionCookie(`__Host-app-planet-session=${"a".repeat(8193)}`)).toBeNull();
    expect(readSessionCookie("__Host-app-planet-session=valid.token_123")).toBe("valid.token_123");
  });

  it("asks the fixed Auth user endpoint and trusts only its validated user id", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      expect(String(input)).toBe("https://auth.example.invalid/auth/v1/user");
      expect(init?.method).toBe("GET");
      expect(init?.redirect).toBe("error");
      expect((init?.headers as Record<string, string>).authorization).toBe("Bearer test-access-token");
      return Response.json({
        id: "b7000000-0000-4000-8000-000000000001",
        role: "caller-controlled-role-is-ignored",
        user_metadata: { school_id: "caller-controlled-school-is-ignored" },
      });
    });
    await expect(verifyAccessToken("test-access-token", configuration, fetchImpl)).resolves.toEqual({
      outcome: "authenticated",
      userId: "b7000000-0000-4000-8000-000000000001",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("fails closed for invalid sessions, Auth errors, malformed responses, and timeouts", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    await expect(verifyAccessToken("not a token", configuration, fetchImpl)).resolves.toEqual({
      outcome: "unauthenticated",
    });
    expect(fetchImpl).not.toHaveBeenCalled();

    fetchImpl.mockResolvedValueOnce(new Response(null, { status: 401 }));
    await expect(verifyAccessToken("test-access-token", configuration, fetchImpl)).resolves.toEqual({
      outcome: "unauthenticated",
    });
    fetchImpl.mockResolvedValueOnce(new Response(null, { status: 403 }));
    await expect(verifyAccessToken("test-access-token", configuration, fetchImpl)).resolves.toEqual({
      outcome: "unauthenticated",
    });
    fetchImpl.mockResolvedValueOnce(new Response(null, { status: 503 }));
    await expect(verifyAccessToken("test-access-token", configuration, fetchImpl)).resolves.toEqual({
      outcome: "unavailable",
    });
    fetchImpl.mockResolvedValueOnce(new Response("{", {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    await expect(verifyAccessToken("test-access-token", configuration, fetchImpl)).resolves.toEqual({
      outcome: "unavailable",
    });
    fetchImpl.mockRejectedValueOnce(new DOMException("timeout", "TimeoutError"));
    await expect(verifyAccessToken("test-access-token", configuration, fetchImpl)).resolves.toEqual({
      outcome: "unavailable",
    });
  });

  const jsonHeaders = { "content-type": "application/json" };
  const unavailable = { outcome: "unavailable" };
  const encoder = new TextEncoder();
  // 與 JWT 形狀相同、payload 含 sub；驗證失敗時不得回退到解碼它。
  const jwtLike = `${btoa('{"alg":"none"}')}.${btoa('{"sub":"b7000000-0000-4000-8000-000000000009"}')}.sig`
    .replaceAll("=", "");

  it("returns a controlled failure when the body errors after headers were received", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('{"id":"b7000000-0000-'));
        controller.error(new TypeError("terminated: secret-provider-detail"));
      },
    });
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(stream, { status: 200, headers: jsonHeaders }));
    await expect(verifyAccessToken(jwtLike, configuration, fetchImpl)).resolves.toEqual(unavailable);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("bounds a body that never finishes even when the transport ignores the abort signal", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('{"id":'));
      },
    });
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(stream, { status: 200, headers: jsonHeaders }));
    const started = Date.now();
    await expect(verifyAccessToken(jwtLike, configuration, fetchImpl, 50)).resolves.toEqual(unavailable);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("bounds a fetch that never settles", async () => {
    const fetchImpl = vi.fn<typeof fetch>(() => new Promise<Response>(() => undefined));
    await expect(verifyAccessToken(jwtLike, configuration, fetchImpl, 50)).resolves.toEqual(unavailable);
  });

  it("rejects oversized, non-UTF-8, empty, and non-object bodies without trusting them", async () => {
    const bodies: Array<BodyInit | null> = [
      `{"id":"b7000000-0000-4000-8000-000000000001","pad":"${"x".repeat(70 * 1024)}"}`,
      new Uint8Array([0x7b, 0xff, 0xfe, 0x7d]),
      null,
      "[]",
      "null",
      '"b7000000-0000-4000-8000-000000000001"',
      '{"id":42}',
      '{"id":"not-a-uuid"}',
      '{"sub":"b7000000-0000-4000-8000-000000000001"}',
    ];
    for (const body of bodies) {
      const fetchImpl = vi.fn<typeof fetch>(async () => new Response(body, { status: 200, headers: jsonHeaders }));
      await expect(verifyAccessToken(jwtLike, configuration, fetchImpl)).resolves.toEqual(unavailable);
    }
  });

  it("maps unexpected fetch exceptions to unavailable and never to authenticated", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => { throw new Error("provider internal detail"); });
    await expect(verifyAccessToken(jwtLike, configuration, fetchImpl)).resolves.toEqual(unavailable);
  });

  it("treats redirects, wrong content types, and missing content types as unavailable", async () => {
    const cases: Array<[Response, unknown]> = [
      [new Response(null, { status: 302, headers: { location: "https://evil.example.invalid/" } }), unavailable],
      [new Response('{"id":"b7000000-0000-4000-8000-000000000001"}', { status: 200, headers: { "content-type": "text/html" } }), unavailable],
      [new Response(null, { status: 200 }), unavailable],
    ];
    for (const [response, expected] of cases) {
      const fetchImpl = vi.fn<typeof fetch>(async () => response);
      await expect(verifyAccessToken(jwtLike, configuration, fetchImpl)).resolves.toEqual(expected);
    }
  });

  it("maps body interruption to a controlled dependency failure at the resolver", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { controller.error(new Error("socket hang up")); },
    });
    const resolver = createAuthPrincipalResolver({
      NODE_ENV: "production",
      APP_PLANET_AUTH_ORIGIN: configuration.authOrigin,
      APP_PLANET_APP_ORIGIN: configuration.appOrigin,
      APP_PLANET_AUTH_API_KEY: configuration.authApiKey,
    } as NodeJS.ProcessEnv, async () => new Response(stream, { status: 200, headers: jsonHeaders }));
    const resolved = await resolver.resolve(new Request("https://app.example.invalid/api/v1/jobs/x", {
      headers: { cookie: "__Host-app-planet-session=valid.token_123" },
    }));
    expect(resolved).toEqual({ ok: false, reason: "dependency_unavailable" });
  });

  it("keeps formal mode closed when Auth configuration is absent or incomplete", () => {
    const base = {
      NODE_ENV: "production",
      APP_PLANET_AUTH_ORIGIN: "https://auth.example.invalid",
      APP_PLANET_APP_ORIGIN: "https://app.example.invalid",
      APP_PLANET_AUTH_API_KEY: "public-test-key",
    };
    expect(readAuthConfiguration(base as NodeJS.ProcessEnv).ok).toBe(true);
    for (const key of Object.keys(base).filter((name) => name !== "NODE_ENV")) {
      expect(readAuthConfiguration({ ...base, [key]: undefined } as unknown as NodeJS.ProcessEnv).ok).toBe(false);
    }
    expect(readAuthConfiguration({} as NodeJS.ProcessEnv).ok).toBe(false);
  });
});
