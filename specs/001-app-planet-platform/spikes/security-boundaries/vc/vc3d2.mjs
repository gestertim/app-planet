// VC-3d (P2)：在 P1 突發期間，以 P2 權杖每 400 ms 輪詢 fs/read，記錄狀態碼與限額標頭（判斷額度是否以 Team 為單位）。合成資料。
import { Sandbox } from '@vercel/sandbox';
import { writeFileSync } from 'node:fs';
import { now, sleep } from './lib.mjs';

const tok = process.env.VERCEL_OIDC_TOKEN; const me = JSON.parse(Buffer.from(tok.split('.')[1], 'base64url').toString());
const DURATION = Number(process.env.DURATION_MS || 110000);
const s = await Sandbox.create({ ports: [], networkPolicy: 'deny-all', resources: { vcpus: 1 }, region: 'hnd1', timeout: 240000, persistent: false });
const sess = s.currentSession().sessionId;
const samples = []; const t0 = now();
while (now() - t0 < DURATION) {
  const r = await fetch(`https://api.vercel.com/v2/sandboxes/sessions/${sess}/fs/read?teamId=${me.owner_id}`, { method: 'POST', headers: { authorization: 'Bearer ' + tok, 'content-type': 'application/json' }, body: JSON.stringify({ path: '/etc/hostname' }) });
  samples.push({ t: new Date().toISOString(), status: r.status, ...Object.fromEntries([...r.headers].filter(([k]) => /ratelimit|retry/i.test(k))) }); await r.arrayBuffer(); await sleep(400);
}
await s.delete().catch(() => {});
const codes = {}; for (const x of samples) codes[x.status] = (codes[x.status] || 0) + 1;
console.log('p2 codes', JSON.stringify(codes), 'samples', samples.length);
writeFileSync('results/vc3d-p2-raw.json', JSON.stringify({ project: me.project, codes, samples }, null, 2));
