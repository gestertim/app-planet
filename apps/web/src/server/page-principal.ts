import { cookies } from "next/headers";
import { createAuthPrincipalResolver, sessionCookieName } from "./auth-principal.ts";
import type { PrincipalResolution } from "./http.ts";
import { readCurrentAccountStatus, type AccountStatusRecord } from "./auth/account-status.ts";

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

export type PageAccount =
  | { readonly kind: "signed_out" }
  | { readonly kind: "unavailable" }
  | { readonly kind: "account_unavailable" }
  | { readonly kind: "account"; readonly record: AccountStatusRecord };

// 角色頁與狀態頁共用：每次 render 都重新經受信任 /auth/v1/user 與本人 DB 狀態判斷，不依登入後 redirect。
export async function resolvePageAccount(): Promise<PageAccount> {
  const principal = await resolvePagePrincipal();
  if (!principal.ok) {
    if (principal.reason === "unauthenticated") return { kind: "signed_out" };
    return principal.reason === "account_disabled" ? { kind: "account_unavailable" } : { kind: "unavailable" };
  }
  const status = await readCurrentAccountStatus(principal.session.read);
  if (status.outcome === "unavailable") return { kind: "unavailable" };
  if (status.outcome === "no_profile" || status.record.deletion_state !== "none") {
    return { kind: "account_unavailable" };
  }
  return { kind: "account", record: status.record };
}

export function isApprovedStaff(account: PageAccount, role: "teacher" | "admin"): boolean {
  return account.kind === "account" && account.record.role === role &&
    account.record.status === "approved" && account.record.login_gate;
}
