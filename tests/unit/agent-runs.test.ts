import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createAgentRunOperations } from "../../apps/web/src/server/agent-runs.ts";
import type { TrustedPrincipalResolver, TrustedSession } from "../../apps/web/src/server/http.ts";

const request = () => new Request("https://example.invalid/internal");
describe("Agent Run 可信 server adapter", () => {
  it("每次操作重取可信主體，不以 Job ID shape 取得 Run", async () => {
    const query = vi.fn(async (sql: string) => ({
      rows: sql.includes("current_user") ? [{ valid: true }] : [{ result: { outcome: "not_found" } }],
    }));
    const session: TrustedSession = {
      read: { runReadOnly: async (operation) => operation({ query }) },
      write: { runTransaction: async (operation) => operation({ query }) },
      usage: { runTransaction: async (operation) => operation({ query }) },
    };
    const resolve = vi.fn<TrustedPrincipalResolver["resolve"]>(async () => ({ ok: true, session }));
    const operations = createAgentRunOperations({ resolve });
    const run_id = randomUUID();
    expect(await operations.read(request(), { run_id })).toEqual({ outcome: "not_found" });
    expect(await operations.stop(request(), { run_id })).toEqual({ outcome: "not_found" });
    expect(resolve).toHaveBeenCalledTimes(2);
    expect(query.mock.calls.flat().join(" ")).toContain("app.owned_agent_run");
    expect(query.mock.calls.flat().join(" ")).not.toContain("app.job_cancel");
    expect(await operations.stop(request(), { job_id: run_id })).toEqual({ outcome: "invalid_input" });
    expect(resolve).toHaveBeenCalledTimes(2);
  });
  it("Auth 失敗明確報錯，不採 caller 主體或成功 fallback", async () => {
    const operations = createAgentRunOperations({
      resolve: async () => ({ ok: false, reason: "unauthenticated" }),
    });
    await expect(operations.read(request(), { run_id: randomUUID() }))
      .rejects.toMatchObject({ code: "unauthenticated" });
  });
});
