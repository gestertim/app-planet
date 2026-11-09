import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";

const [secondsText, label, executable, ...args] = process.argv.slice(2);
const seconds = Number(secondsText);
if (!Number.isSafeInteger(seconds) || seconds < 1 || !label || !executable) {
  throw new Error("Usage: node scripts\\bounded.mjs seconds label executable ...args");
}
const startedAt = new Date().toISOString();
const directory = resolve(process.env.APP_PLANET_BATCH_EVIDENCE ?? "test-results", "batch");
mkdirSync(directory, { recursive: true });
function sourceHashes() {
  const listing = spawnSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"],
    { encoding: "utf8", windowsHide: true, timeout: 15_000 });
  if (listing.status !== 0) throw new Error("無法建立受測來源雜湊。");
  return Object.fromEntries(listing.stdout.split(/\r?\n/).filter((file) =>
    /^(?:apps\/[^/]+\/src\/|packages\/|scripts\/|supabase\/migrations\/|tests\/)/.test(file) &&
      /\.(?:ts|tsx|mjs|mts|ps1|sql|json)$/.test(file) ||
      /^(?:package(?:-lock)?\.json|[^/]*config\.ts)$/.test(file),
  ).map((file) => [file, createHash("sha256").update(readFileSync(file)).digest("hex")]));
}
const hashSources = process.env.APP_PLANET_BATCH_EVIDENCE !== undefined;
if (hashSources) writeFileSync(resolve(directory, `${label}.source-before.json`), JSON.stringify(sourceHashes(), null, 2));
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
  if (hashSources) writeFileSync(resolve(directory, `${label}.source-after.json`), JSON.stringify(sourceHashes(), null, 2));
  writeFileSync(resolve(directory, `${label}.log`), Buffer.concat(chunks));
  writeFileSync(resolve(directory, `${label}.json`), JSON.stringify({
    label, code, timedOut, seconds, startedAt, endedAt: new Date().toISOString(), executable, args,
  }, null, 2));
  process.exitCode = timedOut ? 124 : (code ?? 1);
});
