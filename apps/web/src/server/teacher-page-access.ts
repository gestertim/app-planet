import { isApprovedStaff, resolvePageAccount, resolvePagePrincipal } from "./page-principal.ts";

export async function resolveTeacherPageSession() {
  const account = await resolvePageAccount();
  if (!isApprovedStaff(account, "teacher")) return { outcome: "denied" } as const;
  const principal = await resolvePagePrincipal();
  if (!principal.ok) return { outcome: "unavailable" } as const;
  return { outcome: "ready", session: principal.session } as const;
}
