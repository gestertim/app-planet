import { spawnSync } from "node:child_process";

const result = spawnSync(process.execPath, [
  "scripts\\bounded.mjs", "180", "edge-smoke",
  process.execPath, "node_modules\\@playwright\\test\\cli.js", "test",
], {
  env: { ...process.env, APP_PLANET_E2E_CHANNEL: "msedge" },
  stdio: "inherit",
  timeout: 200_000,
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
