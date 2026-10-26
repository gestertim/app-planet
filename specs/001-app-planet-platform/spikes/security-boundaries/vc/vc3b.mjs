// VC-3b：控制面額度／突發、撤銷與在途終止、出站、時間／記憶體限制。合成資料。
import { Sandbox } from '@vercel/sandbox';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { REGION, stats, summarize, now, sleep } from './lib.mjs';

const snapshotId = JSON.parse(readFileSync('results/vc3a-raw.json', 'utf8')).setup.snapshotId;
const BASE = { ports: [], networkPolicy: 'deny-all', resources: { vcpus: 1 }, region: REGION, source: { type: 'snapshot', snapshotId }, persistent: false };
const out = { startedAt: new Date().toISOString(), snapshotId, names: [], errors: [] };
const save = () => { mkdirSync('results', { recursive: true }); writeFileSync('results/vc3b-raw.json', JSON.stringify(out, null, 2)); };
const tok = process.env.VERCEL_OIDC_TOKEN; const claims = JSON.parse(Buffer.from(tok.split('.')[1], 'base64url').toString());
const RUN = { cmd: 'node', args: ['/opt/fn/handler.js', '/tmp/req.json'] };

// 1. 控制面往返基線與限額標頭
const probeSb = await Sandbox.create({ ...BASE, timeout: 120000 }); out.names.push(probeSb.name);
const rtts = []; let hdrs = null;
for (let i = 0; i < 20; i++) { const t = now(); const r = await fetch(`https://api.vercel.com/v2/sandboxes/${probeSb.name}?teamId=${claims.owner_id}`, { headers: { authorization: 'Bearer ' + tok } }); await r.text(); rtts.push(now() - t); if (!hdrs) hdrs = Object.fromEntries([...r.headers].filter(([k]) => /ratelimit|retry|x-vercel-id|server/i.test(k))); }
out.rtt = { restGetSandbox: summarize(rtts), sampleHeaders: hdrs };
console.log('rtt', JSON.stringify(out.rtt)); save();

// 2. 唯讀控制面突發：600 次 GET，並行 60
{
  const codes = {}; let done = 0; const t0 = now(); const lat = []; const rlSamples = [];
  const worker = async () => { while (done < 600) { done++; const t = now(); const r = await fetch(`https://api.vercel.com/v2/sandboxes/${probeSb.name}?teamId=${claims.owner_id}`, { headers: { authorization: 'Bearer ' + tok } }); codes[r.status] = (codes[r.status] || 0) + 1; if (rlSamples.length < 3) rlSamples.push(Object.fromEntries([...r.headers].filter(([k]) => /ratelimit|retry/i.test(k)))); await r.text(); lat.push(now() - t); } };
  await Promise.all(Array.from({ length: 60 }, worker));
  out.readBurst = { requests: 600, concurrency: 60, wallMs: Math.round(now() - t0), codes, latency: summarize(lat), rlSamples };
  console.log('readBurst', JSON.stringify({ ...out.readBurst, rlSamples: undefined })); save();
}
await probeSb.stop();

// 3. 突發：30 並行的「每請求新建」
async function cycle(i) {
  const t0 = now();
  const sb = await Sandbox.create({ ...BASE, timeout: 60000 }); const t1 = now();
  await sb.writeFiles([{ path: '/tmp/req.json', content: Buffer.from(JSON.stringify({ fn: 'score', n: i })) }]);
  const r = await sb.runCommand(RUN); JSON.parse(await r.stdout()); const t2 = now();
  await sb.stop(); out.names.push(sb.name);
  return { createMs: t1 - t0, toResponseMs: t2 - t0, totalMs: now() - t0 };
}
{
  const c0 = stats.calls; const t0 = now(); const res = await Promise.allSettled(Array.from({ length: 30 }, (_, i) => cycle(i)));
  const ok = res.filter((r) => r.status === 'fulfilled').map((r) => r.value); const bad = res.filter((r) => r.status === 'rejected').map((r) => String(r.reason?.message || r.reason).slice(0, 200));
  out.coldBurst30 = { wallMs: Math.round(now() - t0), ok: ok.length, failed: bad.length, failures: bad.slice(0, 5), toResponse: ok.length ? summarize(ok.map((x) => x.toResponseMs)) : null, create: ok.length ? summarize(ok.map((x) => x.createMs)) : null, apiCalls: stats.calls - c0, byStatus: { ...stats.byStatus } };
  console.log('coldBurst30', JSON.stringify(out.coldBurst30)); save();
}

// 4. 撤銷與在途呼叫終止：在途 runCommand（sleep 120）被 stop／kill／delete 中斷
async function inflight(kind) {
  const sb = await Sandbox.create({ ...BASE, timeout: 300000 }); out.names.push(sb.name);
  let cmdP, cmd;
  if (kind === 'kill') { cmd = await sb.runCommand({ cmd: 'sleep', args: ['120'], detached: true }); cmdP = cmd.wait().then((r) => ({ exit: r.exitCode }), (e) => ({ err: String(e.message).slice(0, 80) })); }
  else { cmdP = sb.runCommand({ cmd: 'sleep', args: ['120'] }).then((r) => ({ exit: r.exitCode }), (e) => ({ err: String(e.message).slice(0, 80) })); }
  await sleep(2000);
  const t0 = now(); let revokeMs, extra = {};
  if (kind === 'stop') { await sb.stop(); revokeMs = now() - t0; }
  else if (kind === 'kill') { await cmd.kill('SIGKILL'); revokeMs = now() - t0; const r = await sb.runCommand({ cmd: 'bash', args: ['-c', 'pgrep -c -x sleep || true'] }); extra.sleepProcsAfterKill = (await r.stdout()).trim(); await sb.stop(); }
  else { await sb.delete(); revokeMs = now() - t0; }
  const settled = await Promise.race([cmdP, sleep(60000).then(() => ({ timeout: true }))]); const inflightEndedMs = now() - t0;
  let newCallAfter = null; const t1 = now(); try { await sb.runCommand({ cmd: 'echo', args: ['x'] }); newCallAfter = { ok: true }; } catch (e) { newCallAfter = { rejected: String(e.message).slice(0, 100), ms: Math.round(now() - t1) }; }
  return { kind, revokeCallMs: Math.round(revokeMs), inflightEndedMs: Math.round(inflightEndedMs), settled, newCallAfter, ...extra };
}
out.inflight = [];
for (const kind of ['stop', 'kill', 'delete']) for (let i = 0; i < 10; i++) { try { out.inflight.push(await inflight(kind)); } catch (e) { out.errors.push({ phase: 'inflight', kind, e: String(e.message || e).slice(0, 200) }); } }
out.inflightSummary = {};
for (const k of ['stop', 'kill', 'delete']) { const a = out.inflight.filter((x) => x.kind === k); if (a.length) out.inflightSummary[k] = { n: a.length, revokeCall: summarize(a.map((x) => x.revokeCallMs)), inflightEnded: summarize(a.map((x) => x.inflightEndedMs)), settledSample: a[0].settled, newCallAfterSample: a[0].newCallAfter }; }
console.log('inflight', JSON.stringify(out.inflightSummary)); save();

// 5. 出站（自快照建立的 deny-all 沙箱）、記憶體、時間、磁碟
{
  const sb = await Sandbox.create({ ...BASE, timeout: 120000 }); out.names.push(sb.name);
  const sh = async (s) => { const r = await sb.runCommand({ cmd: 'bash', args: ['-c', s] }); return ((await r.stdout()) + (await r.stderr())).trim().replace(/\s+/g, ' ').slice(0, 300); };
  out.limits = { egress: {}, };
  for (const [k, u] of Object.entries({ example: 'https://example.com', cloudflareIp: 'https://1.1.1.1', imds: 'http://169.254.169.254/', vercelApi: 'https://api.vercel.com/v2/sandboxes', npmRegistry: 'https://registry.npmjs.org/', openai: 'https://api.openai.com/v1/models' })) out.limits.egress[k] = await sh(`curl -s -m 6 -o /dev/null -w 'http=%{http_code}' ${u}; echo " exit=$?"`);
  out.limits.resources = await sh('nproc; free -m | sed -n 2p; df -h / | tail -1');
  out.limits.memoryHog = await sh(`node -e "const a=[];try{for(let i=0;i<64;i++){a.push(Buffer.alloc(100*1024*1024,1));}console.log('allocated MB',a.length*100)}catch(e){console.log('JS error',e.message)}" ; echo "exit=$?"`);
  const t = now(); const ac = new AbortController(); setTimeout(() => ac.abort(), 2000);
  let abortRes; try { await sb.runCommand({ cmd: 'sleep', args: ['30'], signal: ac.signal }); abortRes = 'completed'; } catch (e) { abortRes = 'aborted: ' + String(e.name || e.message).slice(0, 60); }
  out.limits.abort = { result: abortRes, ms: Math.round(now() - t) };
  out.limits.sleepAfterAbort = await sh('pgrep -c -x sleep || true');
  await sb.stop();
}
{
  const t0 = now(); const sb = await Sandbox.create({ ...BASE, timeout: 15000 }); out.names.push(sb.name);
  let stoppedAt = null; for (let i = 0; i < 60 && stoppedAt === null; i++) { await sleep(2000); const s = await Sandbox.get({ name: sb.name, resume: false }); if (s.status === 'stopped' || s.status === 'stopping') stoppedAt = now() - t0; }
  out.limits.sandboxTimeout = { configuredMs: 15000, observedStopMsFromCreateStart: stoppedAt && Math.round(stoppedAt) };
}
out.apiCalls = { total: stats.calls, byStatus: stats.byStatus }; out.finishedAt = new Date().toISOString(); save();
console.log('limits', JSON.stringify(out.limits)); console.log('errors', out.errors.length, JSON.stringify(out.errors.slice(0, 5)));
