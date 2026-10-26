import { z } from "zod";
import {
  type TrustedPrincipalResolver,
  type PrincipalResolution,
} from "./http.ts";
import { createDatabaseSession } from "./database-session.ts";

export const sessionCookieName = "__Host-app-planet-session";

const authUserSchema = z.object({ id: z.uuid() });
const tokenPattern = /^[A-Za-z0-9._~-]{1,8192}$/;

export type AuthConfiguration = Readonly<{
  authOrigin: string;
  authApiKey: string;
  appOrigin: string;
  localHttp: boolean;
}>;

type ConfigurationResult =
  | { readonly ok: true; readonly value: AuthConfiguration }
  | { readonly ok: false };

function parseOrigin(value: string | undefined, allowLocalHttp: boolean): string | null {
  if (!value) return null;
  try {
    const parsed = new URL(value);
    if (parsed.username || parsed.password || parsed.pathname !== "/" ||
        parsed.search || parsed.hash || parsed.origin === "null") return null;
    if (parsed.protocol !== "https:" &&
        !(allowLocalHttp && parsed.protocol === "http:" &&
          (parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost"))) return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

export function readAuthConfiguration(
  env: NodeJS.ProcessEnv = process.env,
): ConfigurationResult {
  const localHttp = env.APP_PLANET_LOCAL_AUTH === "1" && env.NODE_ENV !== "production";
  const authOrigin = parseOrigin(env.APP_PLANET_AUTH_ORIGIN, localHttp);
  const appOrigin = parseOrigin(env.APP_PLANET_APP_ORIGIN, localHttp);
  const authApiKey = env.APP_PLANET_AUTH_API_KEY;
  if (!authOrigin || !appOrigin || !authApiKey || authApiKey.length > 4096 ||
      /[\r\n]/.test(authApiKey)) return { ok: false };
  return {
    ok: true,
    value: Object.freeze({ authOrigin, authApiKey, appOrigin, localHttp }),
  };
}

export type AuthUserResult =
  | { readonly outcome: "authenticated"; readonly userId: string }
  | { readonly outcome: "unauthenticated" }
  | { readonly outcome: "unavailable" };

export function readSessionCookie(cookieHeader: string | null): string | null {
  if (cookieHeader === null || cookieHeader.length > 16_384) return null;
  const matches = cookieHeader.split(";").flatMap((part) => {
    const separator = part.indexOf("=");
    if (separator < 0) return [];
    return part.slice(0, separator).trim() === sessionCookieName
      ? [part.slice(separator + 1).trim()]
      : [];
  });
  if (matches.length !== 1 || !tokenPattern.test(matches[0])) return null;
  return matches[0];
}

export async function verifyAccessToken(
  accessToken: string,
  config: AuthConfiguration,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 5_000,
): Promise<AuthUserResult> {
  if (!tokenPattern.test(accessToken) || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) {
    return { outcome: "unauthenticated" };
  }
  let response: Response;
  try {
    response = await fetchImpl(`${config.authOrigin}/auth/v1/user`, {
      method: "GET",
      cache: "no-store",
      redirect: "error",
      headers: {
        apikey: config.authApiKey,
        authorization: `Bearer ${accessToken}`,
        accept: "application/json",
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    if (error instanceof TypeError ||
        (error instanceof DOMException && error.name === "TimeoutError")) {
      return { outcome: "unavailable" };
    }
    throw error;
  }
  if (response.status === 401 || response.status === 403) {
    return { outcome: "unauthenticated" };
  }
  if (!response.ok || !response.headers.get("content-type")?.toLowerCase().includes("application/json")) {
    return { outcome: "unavailable" };
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch (error) {
    if (error instanceof SyntaxError) return { outcome: "unavailable" };
    throw error;
  }
  const user = authUserSchema.safeParse(body);
  return user.success
    ? { outcome: "authenticated", userId: user.data.id.toLowerCase() }
    : { outcome: "unavailable" };
}

export function createAuthPrincipalResolver(
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = fetch,
): TrustedPrincipalResolver {
  return {
    async resolve(request): Promise<PrincipalResolution> {
      const config = readAuthConfiguration(env);
      if (!config.ok) return { ok: false, reason: "dependency_unavailable" };
      const token = readSessionCookie(request.headers.get("cookie"));
      if (!token) return { ok: false, reason: "unauthenticated" };
      const verified = await verifyAccessToken(token, config.value, fetchImpl);
      if (verified.outcome === "unauthenticated") {
        return { ok: false, reason: "unauthenticated" };
      }
      if (verified.outcome === "unavailable") {
        return { ok: false, reason: "dependency_unavailable" };
      }
      return {
        ok: true,
        session: createDatabaseSession(verified.userId, env),
      };
    },
  };
}

export type LogoutResult = "revoked" | "already_invalid" | "unavailable";

export async function revokeLocalSession(
  cookieHeader: string | null,
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = fetch,
): Promise<LogoutResult> {
  const config = readAuthConfiguration(env);
  const token = readSessionCookie(cookieHeader);
  if (!config.ok) return "unavailable";
  if (!token) return "already_invalid";
  let response: Response;
  try {
    response = await fetchImpl(`${config.value.authOrigin}/auth/v1/logout?scope=local`, {
      method: "POST",
      cache: "no-store",
      redirect: "error",
      headers: {
        apikey: config.value.authApiKey,
        authorization: `Bearer ${token}`,
      },
      signal: AbortSignal.timeout(5_000),
    });
  } catch (error) {
    if (error instanceof TypeError ||
        (error instanceof DOMException && error.name === "TimeoutError")) return "unavailable";
    throw error;
  }
  if (response.status === 401) return "already_invalid";
  return response.ok ? "revoked" : "unavailable";
}
