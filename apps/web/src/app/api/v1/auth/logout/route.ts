import { revokeLocalSession, sessionCookieName } from "../../../../../server/auth-principal.ts";
import {
  hasTrustedSameOrigin,
  newRequestId,
  problemResponse,
} from "../../../../../server/http.ts";

const noStoreHeaders = {
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
};

function expiredSessionCookie(): string {
  return `${sessionCookieName}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;
}

export async function POST(request: Request): Promise<Response> {
  const requestId = newRequestId();
  const context = { requestId, instance: new URL(request.url).pathname };
  if (!hasTrustedSameOrigin(request)) return problemResponse("forbidden", context);
  const result = await revokeLocalSession(request.headers.get("cookie"));
  if (result === "unavailable") return problemResponse("dependency_unavailable", context);
  return new Response(null, {
    status: 204,
    headers: { ...noStoreHeaders, "x-request-id": requestId, "set-cookie": expiredSessionCookie() },
  });
}
