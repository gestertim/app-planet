import { spawn } from "node:child_process";

const npmCli = process.env.npm_execpath;
const port = process.env.APP_PLANET_E2E_PORT;
if (!npmCli || !port) throw new Error("請由原生 Auth Playwright runner 啟動 Web server。");

const env = { ...process.env };
for (const name of Object.keys(env)) {
  if (name.startsWith("APP_PLANET_TEST_")) delete env[name];
}
env.NODE_ENV = "development";

const child = spawn(process.execPath, [
  npmCli,
  "--workspace", "@app-planet/web",
  "run", "dev", "--",
  "--experimental-https",
  "--hostname", "localhost",
  "--port", port,
], {
  env,
  stdio: "inherit",
  windowsHide: true,
});

child.once("error", (error) => {
  console.error("Next Web server 無法啟動。");
  process.exitCode = 1;
  throw error;
});
child.once("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exitCode = code ?? 1;
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => child.kill(signal));
}
