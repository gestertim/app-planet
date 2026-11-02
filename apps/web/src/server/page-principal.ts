import { cookies } from "next/headers";
import { createAuthPrincipalResolver, sessionCookieName } from "./auth-principal.ts";
import type { PrincipalResolution } from "./http.ts";

type PagePrincipal =
  | (Extract<PrincipalResolution, { ok: true }> & { operationStorageScope: string })
  | Extract<PrincipalResolution, { ok: false }>;

export async function resolvePagePrincipal(): Promise<PagePrincipal> {
  const token = (await cookies()).get(sessionCookieName)?.value;
  const request = new Request("http://localhost/", {
    headers: token ? { cookie: `${sessionCookieName}=${token}` } : {},
  });
  try {
    const principal = await createAuthPrincipalResolver().resolve(request);
    if (!principal.ok) return principal;
    const operationStorageScope = principal.operationStorageScope;
    if (!operationStorageScope) return { ok: false, reason: "dependency_unavailable" };
    return { ...principal, operationStorageScope };
  } catch {
    return { ok: false, reason: "dependency_unavailable" };
  }
}
