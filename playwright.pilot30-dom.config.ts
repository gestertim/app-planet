import { defineConfig } from "@playwright/test";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const executablePath = process.env.P30_BROWSER_EXECUTABLE;
if (!executablePath) throw new Error("P30_BROWSER_EXECUTABLE must identify an installed local browser.");
if (!existsSync(executablePath)) throw new Error("The requested local browser does not exist.");
if (!["on", "off"].includes(process.env.P30_GATE_EXPECT ?? "")) throw new Error("Set P30_GATE_EXPECT.");
if (process.env.NEXT_TELEMETRY_DISABLED !== "1" || process.env.NPM_CONFIG_OFFLINE !== "true") {
  throw new Error("Run through scripts/pilot30-dom-guard.ps1.");
}
const runtime = fileURLToPath(new URL("../evidence/runtime/", import.meta.url));
const run = process.env.P30_RUN_LABEL ?? "browser";
if (!/^[a-z0-9-]+$/u.test(run)) throw new Error("Invalid P30_RUN_LABEL.");

export default defineConfig({
  testDir: "tests/pilot30-dom",
  outputDir: resolve(runtime, "test-results", run),
  reporter: [
    ["list"],
    ["json", { outputFile: resolve(runtime, `${run}.json`) }],
  ],
  workers: 1,
  fullyParallel: false,
  forbidOnly: true,
  retries: 0,
  timeout: 45_000,
  globalTimeout: 480_000,
  use: {
    baseURL: "http://127.0.0.1:32191",
    browserName: "chromium",
    locale: "zh-TW",
    viewport: { width: 1440, height: 1000 },
    serviceWorkers: "block",
    trace: "off",
    screenshot: "only-on-failure",
    launchOptions: {
      executablePath,
      args: [
        "--disable-background-networking",
        "--disable-component-update",
        "--disable-sync",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-domain-reliability",
        "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1",
      ],
    },
  },
});
