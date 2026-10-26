// VC-3a：β2 逐次呼叫路徑延遲（新建／恢復／暖）。合成資料。
import { Sandbox } from '@vercel/sandbox';
import { writeFileSync, mkdirSync } from 'node:fs';
import { REGION, stats, callsSince, summarize, now, sleep, HANDLER, MANIFEST } from './lib.mjs';

const N = Number(process.env.N || 30);
const out = { startedAt: new Date().toISOString(), region: REGION, N, setup: {}, new: [], resume: [], warm: [], warmParallel: null, names: [], errors: [] };
const save = () => { mkdirSync('results', { recursive: true }); writeFileSync('results/vc3a-raw.json', JSON.stringify(out, null, 2)); };
const req = (i) => Buffer.from(JSON.stringify({ fn: 'score', n: i }));
const RUN = { cmd: 'node', args: ['/opt/fn/handler.js', '/tmp/req.json'] };
const BASE = { ports: [], networkPolicy: 'deny-all', resources: { vcpus: 1 }, region: REGION };

// 建置快照（Worker 於部署時一次性執行）
let t = now(); let c0 = stats.calls;
const base = await Sandbox.create({ ...BASE, timeout: 120000, persistent: false });
out.setup.createBaseMs = Math.round(now() - t);
await base.writeFiles([{ path: '/opt/fn/handler.js', content: Buffer.from(HANDLER) }, { path: '/opt/fn/manifest.json', content: Buffer.from(JSON.stringify(MANIFEST)) }]);
t = now(); const snap = await base.snapshot(); out.setup.snapshotMs = Math.round(now() - t); out.setup.snapshotId = snap.snapshotId; out.setup.calls = callsSince(c0);
out.names.push(base.name);
console.log('snapshot', snap.snapshotId, out.setup);
save();

async function newPath(i) {
  const c = stats.calls; const t0 = now();
  const sb = await Sandbox.create({ ...BASE, source: { type: 'snapshot', snapshotId: snap.snapshotId }, timeout: 60000, persistent: false });
  const t1 = now();
  await sb.writeFiles([{ path: '/tmp/req.json', content: req(i) }]);
  const t2 = now();
  const r = await sb.runCommand(RUN); const o = JSON.parse(await r.stdout());
  const t3 = now();
  const callsToResponse = stats.calls - c;
  await sb.stop();
  const t4 = now();
  if (o.body.n !== i) throw new Error('bad output');
  out.names.push(sb.name);
  return { i, createMs: t1 - t0, writeMs: t2 - t1, runMs: t3 - t2, toResponseMs: t3 - t0, stopMs: t4 - t3, totalMs: t4 - t0, calls: stats.calls - c, callsToResponse };
}
for (let i = 0; i < N; i++) { try { out.new.push(await newPath(i)); } catch (e) { out.errors.push({ path: 'new', i, e: String(e.message || e) }); } }
out.summary = { newToResponse: summarize(out.new.map((x) => x.toResponseMs)), newCreate: summarize(out.new.map((x) => x.createMs)), newStop: summarize(out.new.map((x) => x.stopMs)), newTotal: summarize(out.new.map((x) => x.totalMs)) };
console.log('new', JSON.stringify(out.summary)); save();

// 恢復路徑：具名持久沙箱，停止時自動快照，下一次呼叫自動恢復
const RES_NAME = 'vc3-resume-' + Date.now().toString(36);
let sb = await Sandbox.create({ ...BASE, name: RES_NAME, source: { type: 'snapshot', snapshotId: snap.snapshotId }, timeout: 60000, persistent: true });
await sb.writeFiles([{ path: '/tmp/req.json', content: req(-1) }]); await sb.runCommand(RUN); await sb.stop();
out.resumeName = RES_NAME; out.names.push(RES_NAME);
for (let i = 0; i < N; i++) {
  try {
    const c = stats.calls; const t0 = now();
    const s = await Sandbox.get({ name: RES_NAME });
    const t1 = now();
    await s.writeFiles([{ path: '/tmp/req.json', content: req(i) }]);
    const t2 = now();
    const r = await s.runCommand(RUN); const o = JSON.parse(await r.stdout());
    const t3 = now(); const callsToResponse = stats.calls - c;
    await s.stop(); const t4 = now();
    if (o.body.n !== i) throw new Error('bad output');
    out.resume.push({ i, getMs: t1 - t0, firstCallMs: t2 - t1, runMs: t3 - t2, toResponseMs: t3 - t0, stopMs: t4 - t3, totalMs: t4 - t0, calls: stats.calls - c, callsToResponse });
  } catch (e) { out.errors.push({ path: 'resume', i, e: String(e.message || e) }); }
}
out.summary.resumeToResponse = summarize(out.resume.map((x) => x.toResponseMs)); out.summary.resumeFirstCall = summarize(out.resume.map((x) => x.firstCallMs)); out.summary.resumeStop = summarize(out.resume.map((x) => x.stopMs));
console.log('resume', JSON.stringify({ r: out.summary.resumeToResponse, first: out.summary.resumeFirstCall, stop: out.summary.resumeStop })); save();

// 暖路徑：沙箱已在執行；每請求寫入請求檔＋執行
const warm = await Sandbox.create({ ...BASE, source: { type: 'snapshot', snapshotId: snap.snapshotId }, timeout: 300000, persistent: false });
out.names.push(warm.name);
for (let i = 0; i < N; i++) {
  try {
    const c = stats.calls; const t0 = now();
    await warm.writeFiles([{ path: '/tmp/req.json', content: req(i) }]);
    const r = await warm.runCommand(RUN); const o = JSON.parse(await r.stdout());
    const t1 = now(); if (o.body.n !== i) throw new Error('bad output');
    out.warm.push({ i, toResponseMs: t1 - t0, calls: stats.calls - c });
  } catch (e) { out.errors.push({ path: 'warm', i, e: String(e.message || e) }); }
}
out.summary.warm = summarize(out.warm.map((x) => x.toResponseMs));
// 暖沙箱並行 10：同一沙箱的共用檔案會互相覆蓋（隔離風險的示範：以不同檔名避免競態，但狀態仍共用）
{
  const t0 = now();
  const rs = await Promise.all(Array.from({ length: 10 }, async (_, i) => { const t = now(); await warm.writeFiles([{ path: `/tmp/req${i}.json`, content: req(i) }]); const r = await warm.runCommand({ cmd: 'node', args: ['/opt/fn/handler.js', `/tmp/req${i}.json`] }); JSON.parse(await r.stdout()); return now() - t; }));
  out.warmParallel = { wallMs: Math.round(now() - t0), perRequest: summarize(rs) };
}
console.log('warm', JSON.stringify(out.summary.warm), 'parallel10', JSON.stringify(out.warmParallel));
await warm.stop();
out.apiCalls = { total: stats.calls, byStatus: stats.byStatus, byHost: stats.byHost };
out.finishedAt = new Date().toISOString();
writeFileSync('results/vc3a-calls.json', JSON.stringify({ rl: stats.rl.slice(0, 50), log: stats.log.slice(0, 120) }, null, 2));
save();
console.log('errors', out.errors.length, JSON.stringify(out.errors.slice(0, 5)), 'apiCalls', JSON.stringify(out.apiCalls));
