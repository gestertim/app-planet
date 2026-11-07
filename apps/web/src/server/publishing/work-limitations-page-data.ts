import { randomUUID } from "node:crypto";
import { cookies } from "next/headers";
import type { WorkEligibilityContext } from "@app-planet/core";
import { sessionCookieName } from "../auth-principal.ts";
import { waitForWorkEligibilityTestBarrier } from "../database-session.ts";
import { createWorkEligibilityService } from "./eligibility.ts";
import { toWorkLimitationsState } from "../../components/project/work-limitations-state.ts";

export function scopeRequestId(params: Record<string, string | string[] | undefined>): string | null {
  const value = params.__scope_request;
  if (value === undefined) return null;
  if (typeof value !== "string" ||
      !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(value)) {
    throw new TypeError("invalid_scope_request_id");
  }
  return value;
}

export async function readWorkLimitationsPageData(projectId: string, purpose: WorkEligibilityContext) {
  await waitForWorkEligibilityTestBarrier(projectId);
  const token = (await cookies()).get(sessionCookieName)?.value;
  const request = new Request("http://localhost/", {
    headers: token ? { cookie: `${sessionCookieName}=${token}` } : {},
  });
  const result = await createWorkEligibilityService(purpose).assess(request, projectId);
  return { state: toWorkLimitationsState(result, purpose), resultId: randomUUID() };
}
