import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    setupFiles: ["tests/support/setup-isolation.ts"],
    reporters: ["verbose"],
    include: ["tests/integration/real-auth-routes.test.ts", "tests/integration/real-auth-task-import.test.ts", "tests/integration/real-auth-stage-confirmation.test.ts", "tests/integration/real-auth-stage-overview.test.ts"],
    fileParallelism: false,
    testTimeout: 90_000,
    hookTimeout: 120_000,
  },
});
