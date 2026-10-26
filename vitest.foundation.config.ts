import { defineConfig } from "vitest/config";

// 經 scripts/pgtap-local.ps1 -Scenario Usage 執行：需要隔離 PostgreSQL、app_authorization_test 與 app_usage_test。
export default defineConfig({
  test: {
    environment: "node",
    setupFiles: ["tests/support/setup-isolation.ts"],
    include: ["tests/integration/http-foundation.test.ts"],
    reporters: ["verbose"],
    fileParallelism: false,
    testTimeout: 20_000,
    hookTimeout: 30_000,
  },
});
