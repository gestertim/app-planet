import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { bootstrapFirstAdmin } from "../../apps/worker/src/admin/bootstrap.ts";

describe("非 HTTP bootstrap 隔離守門", () => {
  const allowed: NodeJS.ProcessEnv = {
    NODE_ENV: "test", APP_PLANET_ENV: "isolated-local-test", APP_PLANET_LOCAL_AUTH: "1",
    APP_PLANET_BOOTSTRAP_MODE: "isolated-local-test", APP_PLANET_BOOTSTRAP_ISOLATION_ID: randomUUID(),
  };
  it("無設定或錯誤 UUID 明確拒絕，不建立連線", async () => {
    await expect(bootstrapFirstAdmin(randomUUID(), {})).rejects.toThrow("bootstrap_isolation_required");
    await expect(bootstrapFirstAdmin("not-a-uuid", allowed)).rejects.toThrow("bootstrap_invalid_target");
    await expect(bootstrapFirstAdmin(randomUUID(), allowed)).rejects.toThrow("bootstrap_configuration_required");
  });
  it("正式、缺隔離標記或非 loopback 的目標均拒絕", async () => {
    for (const override of [
      { NODE_ENV: "production" }, { APP_PLANET_ENV: "production" }, { APP_PLANET_LOCAL_AUTH: "0" },
      { APP_PLANET_BOOTSTRAP_ISOLATION_ID: "" },
      { APP_PLANET_BOOTSTRAP_DATABASE_URL: "postgresql://synthetic:synthetic@example.invalid/test" },
    ]) await expect(bootstrapFirstAdmin(randomUUID(), { ...allowed, ...override })).rejects.toThrow();
  });
});
