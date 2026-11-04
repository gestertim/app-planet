import { createAuthPrincipalResolver } from "../auth-principal.ts";
import { createRouteHandler, jsonResponse, problemResponse, type TrustedPrincipalResolver } from "../http.ts";
import { projectMe, readCurrentAccountStatus } from "./account-status.ts";

// A-4 GET /api/v1/me：每次請求都經受信任 /auth/v1/user → 本人 DB 狀態 → 最小 DTO（no-store）。
// 受限狀態可讀到自己的最小狀態，不代表任何一般資料權限。
export function createMeHandler(
  resolver: TrustedPrincipalResolver = createAuthPrincipalResolver(),
): (request: Request) => Promise<Response> {
  const handler = createRouteHandler({ route: "me", methods: ["GET"], resolver }, async ({ session, ...context }) => {
    const status = await readCurrentAccountStatus(session.read);
    if (status.outcome === "unavailable") return problemResponse("dependency_unavailable", context);
    if (status.outcome === "no_profile") return problemResponse("account_unavailable", context);
    const projection = projectMe(status.record);
    return projection.kind === "view"
      ? jsonResponse(200, projection.body, context, { vary: "cookie" })
      : problemResponse(projection.code, context);
  });
  return (request) => handler(request);
}
