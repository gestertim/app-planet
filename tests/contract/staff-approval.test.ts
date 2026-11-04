import { describe, expect, it, vi, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import {
  pendingTeachersPageSchema, staffReviewBodySchema, staffReviewResultSchema,
} from "@app-planet/core";
import { createTeacherReviewHandlers } from "../../apps/web/src/server/admin/teacher-review.ts";
import { createDatabaseSession } from "../../apps/web/src/server/database-session.ts";
import type { TrustedPrincipalResolver } from "../../apps/web/src/server/http.ts";

afterEach(() => vi.unstubAllEnvs());
const target = randomUUID();
const actor = randomUUID();
const resolver: TrustedPrincipalResolver = {
  async resolve() { return { ok: true, session: createDatabaseSession(actor, {}) }; },
};

describe("T018 教師審核 strict wire 契約", () => {
  it("只接受兩種固定決策，不允許自報 actor、角色或原因", () => {
    for (const decision of ["approved", "rejected"]) expect(staffReviewBodySchema.safeParse({ decision }).success).toBe(true);
    for (const input of [
      {}, { decision: "disabled" }, { decision: "approved", actor }, { decision: "approved", role: "admin" },
      { decision: "rejected", reason: "自由文字" }, { decision: "approved", school_id: target },
    ]) expect(staffReviewBodySchema.safeParse(input).success).toBe(false);
  });
  it("清單有界、明列後續游標且拒絕 email 等多餘資料", () => {
    const item = { id: target, display_label: "合成教師", school_note: null, status: "pending", row_version: 0 };
    expect(pendingTeachersPageSchema.safeParse({ items: [item], next_cursor: null }).success).toBe(true);
    expect(pendingTeachersPageSchema.safeParse({ items: [{ ...item, school_note: "合成學校說明" }], next_cursor: null }).success).toBe(true);
    expect(pendingTeachersPageSchema.safeParse({ items: [{ ...item, school_note: "x".repeat(201) }], next_cursor: null }).success).toBe(false);
    expect(pendingTeachersPageSchema.safeParse({ items: [{ id: target, display_label: "缺說明", status: "pending", row_version: 0 }], next_cursor: null }).success).toBe(false);
    expect(pendingTeachersPageSchema.safeParse({ items: Array(51).fill(item), next_cursor: null }).success).toBe(false);
    expect(pendingTeachersPageSchema.safeParse({ items: [{ ...item, email: "private" }], next_cursor: null }).success).toBe(false);
    expect(pendingTeachersPageSchema.safeParse({ items: [] }).success).toBe(false);
  });
  it("成功 DTO 僅狀態、內部 id 與真正整數版本", () => {
    expect(staffReviewResultSchema.safeParse({ id: target, status: "approved", row_version: 1 }).success).toBe(true);
    for (const row_version of [-1, 0.1, "1", 2147483648]) {
      expect(staffReviewResultSchema.safeParse({ id: target, status: "rejected", row_version }).success).toBe(false);
    }
  });
  it("未登入拒絕，安全標頭與 problem DTO 不含主體資訊", async () => {
    const handler = createTeacherReviewHandlers({ async resolve() { return { ok: false, reason: "unauthenticated" }; } });
    const result = await handler.list(new Request("https://localhost/api/v1/admin/teachers"));
    expect(result.status).toBe(401);
    expect(result.headers.get("content-type")).toContain("application/problem+json");
    expect(result.headers.get("cache-control")).toBe("no-store");
    expect(result.headers.get("x-content-type-options")).toBe("nosniff");
  });
  it("缺可信隔離連線是依賴失敗而非空清單", async () => {
    const result = await createTeacherReviewHandlers(resolver).list(new Request("https://localhost/api/v1/admin/teachers"));
    expect(result.status).toBe(503);
  });
});
