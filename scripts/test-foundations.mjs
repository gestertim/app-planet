import { spawn, spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error("請使用 npm run test:foundations 執行此回歸入口。");

function parseVitestCounts(output) {
  const files = [...output.matchAll(/^\s*Test Files\s+(\d+)\s+passed\b/gm)]
    .reduce((sum, match) => sum + Number(match[1]), 0);
  const tests = [...output.matchAll(/^\s*Tests\s+(\d+)\s+passed\b/gm)]
    .reduce((sum, match) => sum + Number(match[1]), 0);
  return { files, tests };
}

function runStep(label, script, timeoutMs) {
  return new Promise((resolveStep, rejectStep) => {
    const child = spawn(process.execPath, [npmCli, "run", script], {
      cwd: root,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const output = [];
    let timedOut = false;
    let settled = false;
    const write = (chunk, destination) => {
      output.push(chunk);
      destination.write(chunk);
    };
    child.stdout.on("data", (chunk) => write(chunk, process.stdout));
    child.stderr.on("data", (chunk) => write(chunk, process.stderr));
    const timer = setTimeout(() => {
      timedOut = true;
      if (process.platform === "win32" && child.pid) {
        spawnSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
          timeout: 15_000,
          stdio: "ignore",
        });
      } else {
        child.kill("SIGKILL");
      }
    }, timeoutMs);
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      rejectStep(new Error(`${label} 無法啟動：${error.message}`, { cause: error }));
    });
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const text = Buffer.concat(output).toString("utf8");
      const result = { label, script, code: timedOut ? 124 : (code ?? 1), timedOut, text };
      console.log(`\n[${label}] ${result.code === 0 ? "PASS" : "FAIL"}${timedOut ? "（逾時）" : ""}`);
      if (result.code !== 0) rejectStep(Object.assign(new Error(`${label} 失敗，exit ${result.code}`), { result }));
      else resolveStep(result);
    });
  });
}

async function reportDatabaseLayers(output) {
  const evidenceMatch = output.match(/^Evidence=(.+)$/m);
  if (!evidenceMatch) throw new Error("Usage DB runner 未回報證據目錄。");
  const evidencePath = evidenceMatch[1].trim();
  const summary = JSON.parse(await readFile(join(evidencePath, "run-summary.json"), "utf8"));
  if (summary.status !== "passed" || summary.cleanup_status !== "complete" ||
      summary.temporary_grant_revocation_status !== "verified") {
    throw new Error("Usage DB runner 的結果、清理或權限撤銷未完整通過。");
  }
  const layers = [];
  for (const test of summary.tests) {
    if (!test.file?.endsWith(".sql")) continue;
    const tapPath = join(evidencePath, `${test.file}.derived.tap`);
    const tap = await readFile(tapPath, "utf8");
    const assertions = tap.match(/^1\.\.(\d+)$/m)?.[1];
    if (!assertions) throw new Error(`無法讀取 pgTAP 數量：${test.file}`);
    layers.push(`${test.file}: ${assertions} assertions`);
  }
  for (const command of summary.commands.filter((item) => item.name.startsWith("application-"))) {
    const log = await readFile(join(evidencePath, command.stdout_file), "utf8");
    const counts = parseVitestCounts(log);
    layers.push(`${command.name}: ${counts.files} file(s), ${counts.tests} tests`);
  }
  console.log(`\nDB／HTTP／Worker／Edge 個別驗收：\n  ${layers.join("\n  ")}`);
}

const steps = [
  ["workspace compatibility", "verify:workspaces", 180_000],
  ["typecheck", "typecheck", 180_000],
  ["production build", "build", 240_000],
  ["unit", "test:unit", 180_000],
  ["contract", "test:contract", 180_000],
  ["isolated PostgreSQL + HTTP + Edge", "test:usage:db", 900_000],
  ["isolated native Auth + product routes + browser", "test:auth:local", 900_000],
];
const completed = [];
try {
  for (const [label, script, timeout] of steps) {
    const result = await runStep(label, script, timeout);
    completed.push(result);
    const counts = parseVitestCounts(result.text);
    if (counts.files || counts.tests) {
      console.log(`  ${counts.files} test file(s), ${counts.tests} test(s)`);
    }
    if (script === "test:usage:db") await reportDatabaseLayers(result.text);
  }
  console.log(`\nFoundations regression passed: ${completed.length}/${steps.length} layers.`);
} catch (error) {
  console.error(`\nFoundations regression stopped: ${error.message}`);
  process.exitCode = 1;
}
