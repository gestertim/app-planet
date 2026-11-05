import { describe, expect, it, vi } from "vitest";
import { createTeacherViewAuditHandler } from "../../apps/web/src/server/admin/teacher-view-audit.ts";
import type { TrustedSession } from "../../apps/web/src/server/http.ts";

function harness(value: unknown, fail = false) {
  const query = vi.fn(async () => {
    if (fail) throw new Error("private database failure");
    return { rows: [{ result: value }] };
  });
  const session: TrustedSession = {
    read: { async runReadOnly() { throw new Error("must use authorization locks"); } },
    write: { async runTransaction(operation) { return operation({ query }); } },
    usage: { async runTransaction() { throw new Error("no usage"); } },
  };
  const log = vi.fn();
  const handler = createTeacherViewAuditHandler({
    resolver: { async resolve() { return { ok: true, session }; } }, log,
  });
  return { query, handler, log };
}
describe("T-5 HTTP safe failure", () => {
  it.each(["denied", "invalid_input", "identity_unavailable"])("surfaces %s without old results", async (outcome) => {
    const { handler, query } = harness({ outcome });
    const response = await handler(new Request("https://localhost/api/v1/admin/audit/teacher-views?teacher_id=bad"));
    expect(response.status).toBe(outcome === "denied" ? 403 : outcome === "invalid_input" ? 400 : 503);
    expect(query).toHaveBeenCalledOnce();
    expect(query.mock.calls[0]).toBeDefined();
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(response.headers.get("content-type")).toContain("application/problem+json");
    expect(await response.text()).not.toContain("items");
  });
  it.each([null, {}, { outcome: "found", items: [], next: null, metadata: "secret" }])(
    "decoder failure is 503, not empty success (%j)", async (value) => {
      const { handler } = harness(value);
      const response = await handler(new Request("https://localhost/api/v1/admin/audit/teacher-views"));
      expect(response.status).toBe(503);
      expect(await response.text()).not.toContain("secret");
    });
  it("distinguishes DB failure, empty results, and subsequent revocation", async () => {
    const failed = harness(null, true);
    expect((await failed.handler(new Request("https://localhost/"))).status).toBe(503);
    const h = harness({ outcome: "found", items: [], next: null });
    expect(await (await h.handler(new Request("https://localhost/"))).json())
      .toEqual({ outcome: "found", items: [], next_cursor: null });
    h.query.mockResolvedValueOnce({ rows: [{ result: { outcome: "denied" } }] });
    expect((await h.handler(new Request("https://localhost/"))).status).toBe(403);
  });
});
