// VC-3d (P1)：fs/read 控制面突發直到出現 429。僅使用 P1 的 OIDC 權杖。合成資料。
import { Sandbox } from '@vercel/sandbox';
import { readFileSync, writeFileSync } from 'node:fs';
import { now, sleep } from './lib.mjs';

const raw = JSON.parse(readFileSync('results/vc3a-raw.json', 'utf8'));
const tok = process.env.VERCEL_OIDC_TOKEN; const me = JSON.parse(Buffer.from(tok.split('.')[1], 'base64url').toString());
const MAX = Number(process.env.MAX || 4000), CONC = 40, STOP_AFTER_429 = 100;
await sleep(Number(process.env.START_DELAY_MS || 0));
const s = await Sandbox.create({ ports: [], networkPolicy: 'deny-all', resources: { vcpus: 1 }, region: 'hnd1', timeout: 240000, source: { type: 'snapshot', snapshotId: raw.setup.snapshotId }, persistent: false });
const sess = s.currentSession().sessionId;
const read = () => fetch(`https://api.vercel.com/v2/sandboxes/sessions/${sess}/fs/read?teamId=${me.owner_id}`, { method: 'POST', headers: { authorization: 'Bearer ' + tok, 'content-type': 'application/json' }, body: JSON.stringify({ path: '/opt/fn/manifest.json' }) });
const out = { project: me.project, max: MAX, concurrency: CONC, startedAtIso: new Date().toISOString(), perSecond: {}, first429: null, codes: {}, headerSamples: [] };
const t0 = now(); let sent = 0, n429 = 0;
const worker = async () => {
  while (sent < MAX && n429 < STOP_AFTER_429) {
    sent++; const r = await read(); const sec = Math.floor((now() - t0) / 1000);
    out.codes[r.status] = (out.codes[r.status] || 0) + 1; out.perSecond[sec] = out.perSecond[sec] || { ok: 0, r429: 0 };
    if (out.headerSamples.length < 3 && r.status === 200) out.headerSamples.push(Object.fromEntries([...r.headers].filter(([k]) => /ratelimit|retry/i.test(k))));
    if (r.status === 429) { n429++; out.perSecond[sec].r429++; if (!out.first429) { out.first429 = { afterRequests: sent, atMs: Math.round(now() - t0), at: new Date().toISOString(), headers: Object.fromEntries([...r.headers].filter(([k]) => /ratelimit|retry/i.test(k))), body: (await r.text()).slice(0, 200) }; } else await r.arrayBuffer(); }
    else { out.perSecond[sec].ok++; await r.arrayBuffer(); }
  }
};
await Promise.all(Array.from({ length: CONC }, worker));
out.sent = sent; out.wallMs = Math.round(now() - t0); out.n429 = n429; out.endedAtIso = new Date().toISOString();
console.log('burst', JSON.stringify({ sent, wallMs: out.wallMs, codes: out.codes, first429: out.first429 }));
// 429 期間：SDK 建立／一般控制面是否受影響
const during = {};
{ const t = now(); try { const x = await Sandbox.create({ ports: [], networkPolicy: 'deny-all', resources: { vcpus: 1 }, region: 'hnd1', timeout: 30000, persistent: false }); during.create = { ok: true, ms: Math.round(now() - t) }; await x.delete(); } catch (e) { during.create = { ok: false, status: e.response?.status, err: String(e.message).slice(0, 160) }; } }
{ const t = now(); try { const r = await s.runCommand({ cmd: 'echo', args: ['hi'] }); during.runCommand = { ok: true, exit: r.exitCode, ms: Math.round(now() - t) }; } catch (e) { during.runCommand = { ok: false, status: e.response?.status, err: String(e.message).slice(0, 160) }; } }
out.during429 = during; console.log('during', JSON.stringify(during));
await sleep(65000);
{ const r = await read(); out.after65s = r.status; await r.arrayBuffer(); }
console.log('after65s', out.after65s);
await s.delete().catch(() => {});
writeFileSync('results/vc3d-p1-raw.json', JSON.stringify(out, null, 2));
