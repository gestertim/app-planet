import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    environment: "node",
    setupFiles: ["tests/support/setup-isolation.ts"],
    include: ["tests/integration/usage-worker.test.ts"],
    reporters: ["verbose"],
    fileParallelism: false,
    testTimeout: 15_000,
    hookTimeout: 30_000,
  },
});
