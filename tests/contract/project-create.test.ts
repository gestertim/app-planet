import { describe, expect, it } from "vitest";
import type { ProjectCreationContext } from "../../apps/web/src/server/projects.ts";
import {
  createOwnedProjectSubset,
  hasTrustedProjectClassification,
  replayOwnedProjectSubset,
} from "../../apps/web/src/server/projects.ts";

const subject = "71000000-0000-4000-8000-000000000001";
const key = "73000000-0000-4000-8000-000000000001";
const failed = (reason: string) => ({ outcome: "failed", reason });

function context(
  rows: readonly unknown[],
  inspected?: (sql: string, values: unknown[] | undefined) => void,
): ProjectCreationContext {
  return {
    async runTransaction(operation) {
      return operation({
        async query(sql, values) {
          inspected?.(sql, values);
          return { rows: [...rows] };
        },
      });
    },
  };
}

async function create(ctx: ProjectCreationContext, input: unknown, operationKey: unknown = key) {
  return createOwnedProjectSubset(ctx, input, operationKey);
}

async function replay(ctx: ProjectCreationContext, input: unknown, operationKey: unknown = key) {
  return replayOwnedProjectSubset(ctx, input, operationKey);
}

describe("T051 方案 B 建立契約", () => {
  it.each([
    null, [], "title", {}, { title: 1 }, { title: null },
    { title: "synthetic", tier: "C" }, { title: "synthetic", tier: "a" },
    { title: "synthetic", tier: null }, { title: "synthetic", tier: undefined },
    { title: "synthetic", owner_id: subject }, { title: "synthetic", role: "student" },
    { title: "synthetic", school_id: subject }, { title: "synthetic", id: subject },
    { title: "synthetic", created_at: "2026-10-24T00:00:00Z" },
    { title: "synthetic", stage: "點子" }, { title: "synthetic", row_version: 0 },
    { title: "synthetic", classification_state: "confirmed" },
    { title: "synthetic", tier: "A", needs_visitor_identity: false },
    { title: "synthetic", unknown: true }, { title: "synthetic", "Idempotency-Key": key },
  ].map((input) => [input]))("拒絕 caller 欄位或非法本文 %j 且不啟動交易", async (input) => {
    const unused: ProjectCreationContext = {
      runTransaction() { throw new Error("非法輸入不得呼叫 DB"); },
    };
    expect(await create(unused, input)).toEqual(failed("invalid_input"));
  });

  it.each([null, "", "bad", 1, [], "'; SELECT 1 --"])("非法 UUID 操作鍵 %j 不啟動交易", async (invalid) => {
    const unused: ProjectCreationContext = {
      runTransaction() { throw new Error("非法輸入不得呼叫 DB"); },
    };
    expect(await create(unused, { title: "synthetic" }, invalid)).toEqual(failed("invalid_input"));
  });

  it.each([
    [{ title: "synthetic" }, ["synthetic", null, false, key]],
    [{ title: "synthetic", tier: "A" }, ["synthetic", "A", true, key]],
    [{ title: "synthetic", tier: "B" }, ["synthetic", "B", true, key]],
  ])("本文逐字傳入固定受控 RPC，tier 省略語意不變：%j", async (input, expectedValues) => {
    const inspected: Array<{ sql: string; values: unknown[] | undefined }> = [];
    const ctx = context([{ actor_valid: true, result: { outcome: "denied" } }], (sql, values) => {
      inspected.push({ sql, values });
    });
    expect(await create(ctx, input)).toEqual({ outcome: "denied", reason: "policy_denied" });
    expect(inspected).toHaveLength(1);
    expect(inspected[0].sql).toContain("app.create_unclassified_project");
    expect(inspected[0].sql).toContain("current_user = 'authenticated'");
    expect(inspected[0].sql).toContain("transaction_read_only");
    expect(inspected[0].sql).not.toContain(input.title);
    expect(inspected[0].values).toEqual(expectedValues);
  });

  it("同鍵異本文由資料庫冪等邊界回安全衝突", async () => {
    expect(await create(context([
      { actor_valid: true, result: { outcome: "idempotency_conflict" } },
    ]), { title: "synthetic", tier: "A" }))
      .toEqual({ outcome: "conflict", reason: "idempotency_mismatch" });
  });

  it.each([
    [[], "invalid_context"],
    [[{ actor_valid: false, result: { outcome: "created" } }], "invalid_context"],
    [[{ actor_valid: true, result: { outcome: "created", project: {} } }], "invalid_result"],
    [[{ actor_valid: true, result: { outcome: "created", project: {
      id: subject, title: "synthetic", requested_tier: "A", classification_state: "unconfirmed",
      tier: "A", needs_visitor_identity: false, stage: "點子",
      created_at: "2026-10-24T00:00:00.000000Z", row_version: 0,
    } } }], "invalid_result"],
  ] as const)("無效／不一致 DB 結果不成功：%j", async (rows, reason) => {
    expect(await create(context(rows), { title: "synthetic", tier: "A" })).toEqual(failed(reason));
  });

  it("交易或 driver 故障只回安全失敗", async () => {
    const broken: ProjectCreationContext = {
      async runTransaction() { throw new Error("SQLSTATE 23505 SELECT secret stack"); },
    };
    expect(await create(broken, { title: "synthetic" })).toEqual(failed("dependency_failure"));
  });

  it("replay-only 使用固定 RPC、可信 actor context 與原 key／本文，不呼叫 create RPC", async () => {
    const inspected: Array<{ sql: string; values: unknown[] | undefined }> = [];
    const ctx = context([{ actor_valid: true, result: { outcome: "unrecoverable" } }], (sql, values) => {
      inspected.push({ sql, values });
    });
    expect(await replay(ctx, { title: "synthetic", tier: "B" }, key))
      .toEqual({ outcome: "unrecoverable" });
    expect(inspected).toHaveLength(1);
    expect(inspected[0].sql).toContain("app.replay_unclassified_project");
    expect(inspected[0].sql).not.toContain("app.create_unclassified_project");
    expect(inspected[0].sql).toContain("current_user = 'authenticated'");
    expect(inspected[0].values).toEqual(["synthetic", "B", true, key]);
  });

  it("replay-only 僅接受 strict 輸入，並驗證回放成功 DTO", async () => {
    const project = {
      id: subject, title: "synthetic", stage: "點子",
      created_at: "2026-10-24T00:00:00.000000Z", row_version: 0,
      classification_state: "unconfirmed", requested_tier: null,
      tier: null, needs_visitor_identity: null,
    };
    expect(await replay(context([
      { actor_valid: true, result: { outcome: "replayed", project } },
    ]), { title: "synthetic" })).toEqual({ outcome: "replayed", project });
    const unused: ProjectCreationContext = {
      runTransaction() { throw new Error("非法輸入不得呼叫 DB"); },
    };
    expect(await replay(unused, { title: "synthetic", owner_id: subject }))
      .toEqual(failed("invalid_input"));
  });

  it("未分類、歷史 boolean false 與缺少確認證據均沒有分類資格", () => {
    expect(hasTrustedProjectClassification({
      id: subject, title: "synthetic", stage: "點子",
      created_at: "2026-10-24T00:00:00.000000Z", row_version: 0,
      classification_state: "unconfirmed", requested_tier: "A",
      tier: null, needs_visitor_identity: null,
    })).toBe(false);
    expect(hasTrustedProjectClassification({
      id: subject, title: "synthetic", stage: "點子",
      created_at: "2026-10-24T00:00:00.000000Z", row_version: -1,
      classification_state: "legacy_unverified", requested_tier: null,
      tier: "A", needs_visitor_identity: false,
    })).toBe(false);
  });
});
