import { describe, expect, it, vi } from "vitest";
import {
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
});
