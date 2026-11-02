import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    setupFiles: ["tests/support/setup-isolation.ts"],
    reporters: ["verbose"],
    include: ["tests/integration/migration-0025-upgrade.test.ts"],
    fileParallelism: false,
    testTimeout: 90_000,
    hookTimeout: 120_000,
  },
});
