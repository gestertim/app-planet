import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const [secondsText, label, executable, ...args] = process.argv.slice(2);
const seconds = Number(secondsText);
if (!Number.isSafeInteger(seconds) || seconds < 1 || !label || !executable) {
  throw new Error("Usage: node scripts\\bounded.mjs seconds label executable ...args");
}
const child = spawn(executable, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
const chunks = [];
let timedOut = false;
for (const [stream, destination] of [[child.stdout, process.stdout], [child.stderr, process.stderr]]) {
  stream.on("data", (data) => { chunks.push(data); destination.write(data); });
}
const timer = setTimeout(() => {
  timedOut = true;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { timeout: 15_000, stdio: "ignore" });
  } else {
    child.kill("SIGKILL");
  }
}, seconds * 1000);
child.on("error", (error) => { process.stderr.write(`${error.message}\n`); });
child.on("close", (code) => {
  clearTimeout(timer);
  const directory = resolve(process.env.APP_PLANET_BATCH_EVIDENCE ?? "test-results", "batch");
  mkdirSync(directory, { recursive: true });
  writeFileSync(resolve(directory, `${label}.log`), Buffer.concat(chunks));
  writeFileSync(resolve(directory, `${label}.json`), JSON.stringify({ label, code, timedOut, seconds }, null, 2));
  process.exitCode = timedOut ? 124 : (code ?? 1);
});
