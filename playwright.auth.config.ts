import { defineConfig } from "@playwright/test";
import { assertNoProductionTestEnvironment } from "./tests/support/production-isolation.ts";

assertNoProductionTestEnvironment();

const port = Number(process.env.APP_PLANET_E2E_PORT);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("原生 Auth 瀏覽器測試必須使用 runner 指定的隔離埠。");
}

export default defineConfig({
  testDir: "tests/auth-e2e",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: true,
  timeout: 180_000,
  reporter: "list",
  use: {
    baseURL: `https://localhost:${port}`,
    locale: "zh-TW",
    channel: process.env.APP_PLANET_E2E_CHANNEL ?? "msedge",
    ignoreHTTPSErrors: true,
  },
  webServer: {
    command: "node scripts/start-web-test-server.mjs",
    port,
    reuseExistingServer: false,
    timeout: 120_000,
    stdout: "ignore",
    stderr: "pipe",
  },
});
