import { describe, expect, it, vi } from "vitest";
import { createMembershipHandlers } from "../../apps/web/src/server/admin/teacher-school-memberships.ts";
import type { TrustedSession } from "../../apps/web/src/server/http.ts";
const id = "10000000-0000-4000-8000-000000000001";
function harness(result: unknown, fail = false, actorValid = true) {
  const query = vi.fn(async () => {
    if (fail) throw new Error("private_dependency_details");
    return { rows: [{ subject: id, actor_valid: actorValid, result }] };
  });
  const session: TrustedSession = {
    read: { async runReadOnly() { throw new Error("authorization_lock_required"); } },
    write: { async runTransaction(operation) { return operation({ query }); } },
    usage: { async runTransaction() { throw new Error("no_usage"); } },
  };
  const log = vi.fn();
  const handlers = createMembershipHandlers({ resolver: { async resolve() { return { ok: true, session }; } }, log });
  return { handlers, query, log };
}
const request = (query = "?kind=schools") => new Request(`https://localhost/api/v1/admin/teacher-school-memberships${query}`);
describe("歸屬 handler 當下授權／依賴錯誤語意", () => {
  it.each(["denied", "invalid_input"] as const)("%s 明確拒絕且記錄固定碼", async (outcome) => {
    const h = harness({ outcome }); const r = await h.handlers.list(request());
    expect(r.status).toBe(outcome === "denied" ? 403 : 400);
    expect(r.headers.get("cache-control")).toContain("no-store"); expect(h.log).toHaveBeenCalledOnce();
  });
  it.each([null, {}, { outcome: "found", kind: "schools", items: [], next_cursor: null, email: "not-exported" }])(
    "不合法投影不回空成功 %#", async (value) => {
      const h = harness(value); const r = await h.handlers.list(request());
      expect(r.status).toBe(503); expect(await r.text()).not.toContain("items");
    });
  it("DB failure／非法 actor 與真正空頁分開，僅固定錯誤進日誌", async () => {
    for (const h of [harness(null, true), harness(null, false, false)]) {
      const r = await h.handlers.list(request()); expect(r.status).toBe(503);
      expect(await r.text()).not.toContain("private_dependency"); expect(JSON.stringify(h.log.mock.calls)).not.toContain("private_dependency");
    }
    const h = harness({ outcome: "found", kind: "schools", items: [], next_cursor: null });
    expect(await (await h.handlers.list(request())).json()).toEqual({ outcome: "found", kind: "schools", items: [], next_cursor: null });
  });
  it("strict query、UUID key 與 mutation 本文拒絕，DB 不被呼叫", async () => {
    const h = harness(null);
    for (const q of ["?kind=schools&role=admin", "?kind=schools&kind=teachers", "?kind=schools&after=bad"]) {
      expect((await h.handlers.list(request(q))).status).toBe(400);
    }
    const r = await h.handlers.create(new Request("https://localhost/api/v1/admin/teacher-school-memberships", {
      method: "POST", headers: { "content-type": "application/json", "idempotency-key": id },
      body: JSON.stringify({ teacher_id: id, school_id: id, state: "active" }),
    }));
    expect(r.status).toBe(400); expect(h.query).not.toHaveBeenCalled();
  });
  it("mutation DB failure 是未知結果，而非清單依賴故障", async () => {
    const h = harness(null, true);
    const r = await h.handlers.end(new Request(`https://localhost/api/v1/admin/teacher-school-memberships/${id}`, {
      method: "DELETE", headers: { "content-type": "application/json", "idempotency-key": id }, body: "{}",
    }), { id });
    expect(r.status).toBe(503); expect(await r.json()).toMatchObject({ code: "operation_outcome_unknown" });
  });
});
