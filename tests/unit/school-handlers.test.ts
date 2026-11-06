import { describe, expect, it, vi } from "vitest";
import { createSchoolHandlers } from "../../apps/web/src/server/admin/schools.ts";
import type { PrincipalResolution, TrustedSession } from "../../apps/web/src/server/http.ts";
const id = "10000000-0000-4000-8000-000000000001";
const receipt = { outcome: "created", operation: "create", school_id: id, label: "合成校",
  approval_state: "unconfirmed", approval_epoch: 0, valid_until: null, current_doc_version: null,
  operated_at: "2026-11-06T00:00:00.000000Z" };
function harness(result: unknown, fault = false, principal?: PrincipalResolution) {
  const query = vi.fn(async () => {
    if (fault) throw new Error("private_dependency");
    return { rows: [{ subject: id, actor_valid: true, result }] };
  });
  const session: TrustedSession = {
    read: { async runReadOnly() { throw new Error("lock_required"); } },
    write: { async runTransaction(fn) { return fn({ query }); } },
    usage: { async runTransaction() { throw new Error("not_used"); } },
  };
  const log = vi.fn(), handlers = createSchoolHandlers({
    resolver: { async resolve() { return principal ?? { ok: true, session }; } }, log,
  });
  return { handlers, query, log };
}
const request = (method = "GET", suffix = "", body?: unknown) => new Request(`https://localhost/api/v1/admin/schools${suffix}`, {
  method, headers: { "content-type": "application/json", "idempotency-key": id },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});
describe("學校 HTTP strict／故障／狀態", () => {
  it.each(["created", "replayed"] as const)("%s 狀態與 replay header", async (outcome) => {
    const h = harness({ ...receipt, outcome }), response = await h.handlers.create(request("POST", "", { label: "合成校" }));
    expect(response.status).toBe(outcome === "created" ? 201 : 200);
    expect(response.headers.get("idempotent-replay")).toBe(outcome === "replayed" ? "true" : null);
    expect(response.headers.get("cache-control")).toContain("no-store");
  });
  it.each([["denied", 403], ["idempotency_conflict", 422]] as const)("%s 不成功", async (outcome, status) => {
    const h = harness({ outcome });
    expect((await h.handlers.create(request("POST", "", { label: "合成校" }))).status).toBe(status);
    expect(h.log).toHaveBeenCalledOnce();
    expect(JSON.stringify(h.log.mock.calls)).not.toContain("合成校");
  });
  it("query 重複／額外鍵及 body 額外欄位拒絕", async () => {
    const h = harness(null);
    for (const q of ["?after=bad", `?after=${id}&after=${id}`, "?role=admin"])
      expect((await h.handlers.list(request("GET", q))).status).toBe(400);
    expect((await h.handlers.create(request("POST", "", { label: "校", approval_state: "approved" }))).status).toBe(400);
    expect(h.query).not.toHaveBeenCalled();
  });
  it("真正空結果與 query／decoder 故障分開，create 故障是 unknown", async () => {
    const h = harness({ outcome: "found", items: [], next_cursor: null });
    expect((await h.handlers.list(request())).status).toBe(200);
    for (const h of [harness(null), harness(null, true), harness({ outcome: "found", items: [], next_cursor: null, email: "private" })]) {
      expect((await h.handlers.list(request())).status).toBe(503);
      expect(await (await h.handlers.create(request("POST", "", { label: "合成校" }))).json())
        .toMatchObject({ code: "operation_outcome_unknown" });
      expect(JSON.stringify(h.log.mock.calls)).not.toContain("private");
    }
  });
  it("詳情關聯與不存在；未登入／依賴故障不混成 403", async () => {
    expect((await harness({ outcome: "not_found" }).handlers.detail(request(), { id })).status).toBe(404);
    for (const reason of ["unauthenticated", "dependency_unavailable"] as const)
      expect((await harness(null, false, { ok: false, reason }).handlers.list(request())).status)
        .toBe(reason === "unauthenticated" ? 401 : 503);
    expect((await harness({ outcome: "found", school: { id } }).handlers.detail(request(), { id })).status).toBe(503);
  });
});
