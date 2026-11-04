import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createTrustedSourceProxy } from "./trusted-source-proxy.mjs";

const npmCli = process.env.npm_execpath;
const port = Number(process.env.APP_PLANET_E2E_PORT);
if (!npmCli || !Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("請由原生 Auth Playwright runner 啟動 Web server。");
}
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const certificateDir = path.join(repoRoot, "apps", "web", "certificates");

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port: selected } = server.address();
      server.close(() => resolve(selected));
    });
  });
}

function canConnect(targetPort) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "localhost", port: targetPort });
    socket.once("connect", () => { socket.destroy(); resolve(true); });
    socket.once("error", () => resolve(false));
  });
}

// readiness §90：Next 只聽內部 loopback 埠；瀏覽器經 runner 建立的可信來源 proxy 進入，
// proof 每次啟動隨機產生，只交給本次 Next 子程序，不寫入檔案或輸出。
const internalPort = await freePort();
const proof = randomBytes(32).toString("hex");
const env = { ...process.env };
for (const name of Object.keys(env)) {
  if (name.startsWith("APP_PLANET_TEST_") || name.startsWith("APP_PLANET_BOOTSTRAP_")) delete env[name];
}
env.NODE_ENV = "development";
env.APP_PLANET_SOURCE_PROXY_PROOF = proof;

const child = spawn(process.execPath, [
  npmCli,
  "--workspace", "@app-planet/web",
  "run", "dev", "--",
  "--experimental-https",
  "--hostname", "localhost",
  "--port", String(internalPort),
], {
  env,
  stdio: "inherit",
  windowsHide: true,
});

let proxy = null;
let stopping = false;
function stop(code) {
  if (stopping) return;
  stopping = true;
  proxy?.close();
  if (child.exitCode === null && child.signalCode === null) child.kill();
  process.exitCode = code;
}

child.once("error", () => {
  console.error("Next Web server 無法啟動。");
  stop(1);
});
child.once("exit", (code, signal) => {
  proxy?.close();
  if (!stopping) {
    stopping = true;
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exitCode = code ?? 1;
  }
});
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => stop(0));
}

const deadline = Date.now() + 110_000;
while (!(await canConnect(internalPort))) {
  if (stopping) process.exit(process.exitCode ?? 1);
  if (Date.now() > deadline) {
    console.error("Next Web server 未在時限內就緒。");
    stop(1);
    process.exit(1);
  }
  await new Promise((resolve) => setTimeout(resolve, 250));
}

const certificate = readFileSync(path.join(certificateDir, "localhost.pem"), "utf8");
const key = readFileSync(path.join(certificateDir, "localhost-key.pem"), "utf8");
proxy = createTrustedSourceProxy({
  upstream: { origin: `https://localhost:${internalPort}`, pinnedCertificatePem: certificate },
  proof,
  tlsOptions: { cert: certificate, key },
});
proxy.once("error", () => {
  console.error("可信來源 proxy 無法啟動。");
  stop(1);
});
proxy.listen(port, "127.0.0.1");
