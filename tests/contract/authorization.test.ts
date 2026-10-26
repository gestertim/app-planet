import { describe, expect, it } from "vitest";
import {
  authorizeCapability,
  authorizeTeacherRelationship,
  type AuthorizationContext,
} from "../../apps/web/src/server/authorization.ts";

const subject = "12000000-0000-4000-8000-000000000001";

function contextWithRows(rows: unknown[]): AuthorizationContext {
  return {
    async runReadOnly(operation) {
      return operation({
        async query() {
          return { rows };
        },
      });
    },
  };
}

describe("唯讀授權結果邊界", () => {
  it("只投影允許，不回傳資料列或額外內容", async () => {
    expect(await authorizeCapability(contextWithRows([
      { subject, actor_valid: true, allowed: true, secret: "not-returned" },
    ]), "login")).toEqual({ outcome: "allowed", scope: "account_capability" });
  });

  it("SQL false 只表示一般政策拒絕", async () => {
    expect(await authorizeCapability(contextWithRows([
      { subject, actor_valid: true, allowed: false },
    ]), "login")).toEqual({ outcome: "denied", reason: "policy_denied" });
  });

  it.each([[], [{}], [{ subject, actor_valid: true, allowed: null }],
    [{ subject, actor_valid: true, allowed: "true" }],
    [{ subject, actor_valid: true, allowed: true }, { subject, actor_valid: true, allowed: true }],
  ])("缺漏或非預期結果不能變成允許：%j", async (...rows) => {
    expect((await authorizeCapability(contextWithRows(rows), "login")).outcome).toBe("failed");
  });

  it.each([null, "", "invalid"])("無效主體 %j 拒絕", async (invalid) => {
    expect(await authorizeCapability(contextWithRows([
      { subject: invalid, actor_valid: true, allowed: true },
    ]), "login")).toEqual({ outcome: "failed", reason: "invalid_context" });
  });

  it("高權限 actor 不接受即使 gate 為 true", async () => {
    expect(await authorizeCapability(contextWithRows([
      { subject, actor_valid: false, allowed: true },
    ]), "login")).toEqual({ outcome: "failed", reason: "invalid_context" });
  });

  it.each(["unknown", null, { role: "admin" }])("無效 capability %j 不呼叫依賴", async (capability) => {
    const context: AuthorizationContext = { runReadOnly() { throw new Error("must not query"); } };
    expect(await authorizeCapability(context, capability)).toEqual({
      outcome: "failed", reason: "invalid_input",
    });
  });

  it("學生目標 id 不合法時不查詢", async () => {
    expect(await authorizeTeacherRelationship(contextWithRows([]), "invalid")).toEqual({
      outcome: "failed", reason: "invalid_input",
    });
  });

  it("driver 例外只回依賴失敗，不輸出原錯誤", async () => {
    const context: AuthorizationContext = {
      async runReadOnly() { throw new Error("SELECT password SQLSTATE stack postgres://credential"); },
    };
    expect(await authorizeCapability(context, "login")).toEqual({
      outcome: "failed", reason: "dependency_failure",
    });
  });
});
