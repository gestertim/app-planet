import { defineConfig } from "@playwright/test";
import { assertNoProductionTestEnvironment } from "./tests/support/production-isolation.ts";

assertNoProductionTestEnvironment();

const port = Number(process.env.APP_PLANET_E2E_PORT ?? "3107");
const baseURL = `http://127.0.0.1:${port}`;
// 預設使用 Playwright 內建 Chromium；可用 APP_PLANET_E2E_CHANNEL=msedge|chrome 改用本機已安裝的瀏覽器。
const channel = process.env.APP_PLANET_E2E_CHANNEL;

export default defineConfig({
  testDir: "tests/e2e",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: true,
  timeout: 30_000,
  reporter: "list",
  use: {
    baseURL,
    locale: "zh-TW",
    ...(channel === undefined ? {} : { channel }),
  },
  webServer: {
    command: `npm --workspace @app-planet/web run dev -- --port ${port}`,
    url: baseURL,
    reuseExistingServer: false,
    timeout: 120_000,
    stdout: "ignore",
    stderr: "pipe",
  },
});
