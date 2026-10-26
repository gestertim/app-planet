// VC-3e：撤銷與在途呼叫終止（stop／kill／delete）、撤銷後舊控制代碼能否復活、出站／記憶體／時間限制。合成資料。
import { Sandbox } from '@vercel/sandbox';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { REGION, stats, summarize, now, sleep } from './lib.mjs';

const snapshotId = JSON.parse(readFileSync('results/vc3a-raw.json', 'utf8')).setup.snapshotId;
const BASE = { ports: [], networkPolicy: 'deny-all', resources: { vcpus: 1 }, region: REGION, source: { type: 'snapshot', snapshotId }, persistent: false };
const out = { startedAt: new Date().toISOString(), snapshotId, names: [], errors: [] };
const save = () => { mkdirSync('results', { recursive: true }); writeFileSync('results/vc3e-raw.json', JSON.stringify(out, null, 2)); };
const N = Number(process.env.N || 10);

async function statusOf(name) { try { const s = await Sandbox.get({ name, resume: false }); return s.status; } catch (e) { return 'get-error:' + String(e.message).slice(0, 60); } }

async function inflight(kind) {
  const sb = await Sandbox.create({ ...BASE, timeout: 300000 }); out.names.push(sb.name);
  try {
    let cmdP, cmd;
    if (kind === 'kill') { cmd = await sb.runCommand({ cmd: 'sleep', args: ['120'], detached: true }); cmdP = cmd.wait().then((r) => ({ exit: r.exitCode }), (e) => ({ err: String(e.message).slice(0, 80) })); }
    else { cmdP = sb.runCommand({ cmd: 'sleep', args: ['120'] }).then((r) => ({ exit: r.exitCode }), (e) => ({ err: String(e.message).slice(0, 80) })); }
    await sleep(2000);
    const t0 = now(); let revokeMs; const extra = {};
    if (kind === 'stop') { await sb.stop(); revokeMs = now() - t0; }
    else if (kind === 'kill') { await cmd.kill('SIGKILL'); revokeMs = now() - t0; const r = await sb.runCommand({ cmd: 'bash', args: ['-c', 'pgrep -c -x sleep || true'] }); extra.sleepProcsAfterKill = (await r.stdout()).trim(); }
    else { await sb.delete(); revokeMs = now() - t0; }
    const settled = await Promise.race([cmdP, sleep(60000).then(() => ({ timeout: true }))]); const inflightEndedMs = now() - t0;
    extra.statusAfterRevoke = await statusOf(sb.name);
    let newCallAfter; const t1 = now();
    try { const r = await sb.runCommand({ cmd: 'echo', args: ['x'] }); newCallAfter = { ok: true, exit: r.exitCode, ms: Math.round(now() - t1) }; } catch (e) { newCallAfter = { rejected: String(e.message).slice(0, 100), ms: Math.round(now() - t1) }; }
    extra.statusAfterNewCall = await statusOf(sb.name);
    return { kind, revokeCallMs: Math.round(revokeMs), inflightEndedMs: Math.round(inflightEndedMs), settled, newCallAfter, ...extra };
  } finally { try { await sb.delete(); } catch { /* already deleted */ } }
}
out.inflight = [];
for (const kind of ['stop', 'kill', 'delete']) for (let i = 0; i < N; i++) { try { out.inflight.push(await inflight(kind)); } catch (e) { out.errors.push({ phase: 'inflight', kind, e: String(e.message || e).slice(0, 200) }); } save(); }
out.inflightSummary = {};
for (const k of ['stop', 'kill', 'delete']) { const a = out.inflight.filter((x) => x.kind === k); if (a.length) out.inflightSummary[k] = { n: a.length, revokeCall: summarize(a.map((x) => x.revokeCallMs)), inflightEnded: summarize(a.map((x) => x.inflightEndedMs)), settled: [...new Set(a.map((x) => JSON.stringify(x.settled)))], newCallAfter: a.map((x) => x.newCallAfter.ok ? 'ok' : 'rejected').reduce((m, v) => ({ ...m, [v]: (m[v] || 0) + 1 }), {}), statusAfterRevoke: [...new Set(a.map((x) => x.statusAfterRevoke))], statusAfterNewCall: [...new Set(a.map((x) => x.statusAfterNewCall))] }; }
console.log('inflight', JSON.stringify(out.inflightSummary)); save();

{
  const sb = await Sandbox.create({ ...BASE, timeout: 120000 }); out.names.push(sb.name);
  const sh = async (s) => { const r = await sb.runCommand({ cmd: 'bash', args: ['-c', s] }); return ((await r.stdout()) + (await r.stderr())).trim().replace(/\s+/g, ' ').slice(0, 300); };
  out.limits = { egress: {} };
  for (const [k, u] of Object.entries({ example: 'https://example.com', cloudflareIp: 'https://1.1.1.1', imds: 'http://169.254.169.254/', vercelApi: 'https://api.vercel.com/v2/sandboxes', npmRegistry: 'https://registry.npmjs.org/', openai: 'https://api.openai.com/v1/models' })) out.limits.egress[k] = await sh(`curl -s -m 6 -o /dev/null -w 'http=%{http_code}' ${u}; echo " exit=$?"`);
  out.limits.resources = await sh('nproc; free -m | sed -n 2p; df -h / | tail -1');
  out.limits.memoryHog = await sh(`node -e "const a=[];try{for(let i=0;i<64;i++){a.push(Buffer.alloc(100*1024*1024,1));}console.log('allocated MB',a.length*100)}catch(e){console.log('JS error',e.message)}" ; echo "exit=$?"`);
  const t = now(); const ac = new AbortController(); setTimeout(() => ac.abort(), 2000);
  let abortRes; try { await sb.runCommand({ cmd: 'sleep', args: ['30'], signal: ac.signal }); abortRes = 'completed'; } catch (e) { abortRes = 'aborted: ' + String(e.name || e.message).slice(0, 60); }
  out.limits.abort = { result: abortRes, ms: Math.round(now() - t) };
  out.limits.sleepAfterAbort = await sh('pgrep -c -x sleep || true');
  await sb.delete();
}
{
  const t0 = now(); const sb = await Sandbox.create({ ...BASE, timeout: 15000 }); out.names.push(sb.name);
  let stoppedAt = null; for (let i = 0; i < 60 && stoppedAt === null; i++) { await sleep(2000); const st = await statusOf(sb.name); if (st === 'stopped' || st === 'stopping') stoppedAt = now() - t0; }
  out.limits.sandboxTimeout = { configuredMs: 15000, observedStopMsFromCreateStart: stoppedAt && Math.round(stoppedAt) };
  try { await sb.delete(); } catch { /* ignore */ }
}
out.apiCalls = { total: stats.calls, byStatus: stats.byStatus }; out.finishedAt = new Date().toISOString(); save();
console.log('limits', JSON.stringify(out.limits)); console.log('errors', out.errors.length, JSON.stringify(out.errors.slice(0, 5)));
