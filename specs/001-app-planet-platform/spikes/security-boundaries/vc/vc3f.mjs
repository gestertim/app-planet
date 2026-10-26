// VC-3f：每請求新建 ×N，逐筆讀取供應商的用量計數（totalActiveCpuDurationMs 等），與費用模型對照。合成資料。
import { Sandbox } from '@vercel/sandbox';
import { readFileSync, writeFileSync } from 'node:fs';
import { REGION, now } from './lib.mjs';

const N = Number(process.env.N || 40);
const raw = JSON.parse(readFileSync('results/vc3a-raw.json', 'utf8'));
const tok = process.env.VERCEL_OIDC_TOKEN; const me = JSON.parse(Buffer.from(tok.split('.')[1], 'base64url').toString());
const BASE = { ports: [], networkPolicy: 'deny-all', resources: { vcpus: 1 }, region: REGION, source: { type: 'snapshot', snapshotId: raw.setup.snapshotId }, persistent: false, timeout: 60000 };
const out = { startedAt: new Date().toISOString(), N, rows: [] };
for (let i = 0; i < N; i++) {
  const sb = await Sandbox.create(BASE);
  await sb.writeFiles([{ path: '/tmp/req.json', content: Buffer.from(JSON.stringify({ fn: 'score', n: i })) }]);
  const r = await sb.runCommand({ cmd: 'node', args: ['/opt/fn/handler.js', '/tmp/req.json'] }); await r.stdout();
  await sb.stop();
  let meta = null;
  for (let k = 0; k < 6 && !meta; k++) { try { const g = await fetch(`https://api.vercel.com/v2/sandboxes/${sb.name}?teamId=${me.owner_id}`, { headers: { authorization: 'Bearer ' + tok } }); const j = await g.json(); if (j.sandbox && j.session?.status === 'stopped') meta = j; else await new Promise((x) => setTimeout(x, 700)); } catch { await new Promise((x) => setTimeout(x, 1500)); } }
  const s = meta?.sandbox ?? {}, ss = meta?.session ?? {};
  out.rows.push({ i, status: ss.status, vcpus: ss.vcpus, memory: ss.memory, sandboxCpuMs: s.totalActiveCpuDurationMs, sandboxDurationMs: s.totalDurationMs, ingress: s.totalIngressBytes, egress: s.totalEgressBytes, sessionKeys: Object.keys(ss).filter((k) => /duration|cpu|bytes|stop|start/i.test(k)).reduce((o, k) => ({ ...o, [k]: ss[k] }), {}) });
  await sb.delete().catch(() => {});
  writeFileSync('results/vc3f-partial.json', JSON.stringify(out, null, 2));
}
const sum = (k) => out.rows.reduce((a, r) => a + (r[k] || 0), 0);
const RATE = { cpuHr: 0.202, memGbHr: 0.0334, create: 0.0000006, netGb: 0.16 };
const memGb = (out.rows[0]?.memory ?? 2048) / 1024;
const cpuUsd = (sum('sandboxCpuMs') / 3.6e6) * RATE.cpuHr;
const memActual = memGb * (sum('sandboxDurationMs') / 3.6e6) * RATE.memGbHr;
const memMin1 = out.rows.reduce((a, r) => a + memGb * (Math.max(r.sandboxDurationMs || 0, 60000) / 3.6e6) * RATE.memGbHr, 0);
const createUsd = N * RATE.create;
out.model = { rates: RATE, memGb, totals: { cpuMs: sum('sandboxCpuMs'), durationMs: sum('sandboxDurationMs'), ingress: sum('ingress'), egress: sum('egress') }, usd: { cpu: cpuUsd, memoryActualDuration: memActual, memoryWithMin1Min: memMin1, creates: createUsd, totalActualDuration: cpuUsd + memActual + createUsd, totalWithMin1Min: cpuUsd + memMin1 + createUsd, perRequestWithMin1Min: (cpuUsd + memMin1 + createUsd) / N, per1000WithMin1Min: ((cpuUsd + memMin1 + createUsd) / N) * 1000 } };
out.finishedAt = new Date().toISOString();
writeFileSync('results/vc3f-raw.json', JSON.stringify(out, null, 2));
console.log(JSON.stringify({ first: out.rows[0], model: out.model }, null, 1));
