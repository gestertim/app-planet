// VC-3c：OIDC 專案隔離。以環境變數指向不同專案的 OIDC 權杖，分三階段執行：setup(P1) → attack(P2) → verify(P1)。合成資料。
import { Sandbox, Snapshot } from '@vercel/sandbox';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const phase = process.argv[2];
const raw = JSON.parse(readFileSync('results/vc3a-raw.json', 'utf8'));
const tok = process.env.VERCEL_OIDC_TOKEN; const me = JSON.parse(Buffer.from(tok.split('.')[1], 'base64url').toString());
const FILE = 'results/vc3c2-raw.json';
const out = existsSync(FILE) ? JSON.parse(readFileSync(FILE, 'utf8')) : { checks: [] };
const rec = (name, r) => { out.checks.push({ phase, project: me.project, name, ...r }); console.log(`[${phase}/${me.project}]`, name, JSON.stringify(r)); };
const attempt = async (name, fn) => { try { rec(name, { allowed: true, result: await fn() }); } catch (e) { rec(name, { allowed: false, status: e.response?.status ?? null, error: String(e.message).slice(0, 200) }); } };
const BASE = { ports: [], networkPolicy: 'deny-all', resources: { vcpus: 1 }, region: 'hnd1', persistent: false };

if (phase === 'setup') {
  const s = await Sandbox.create({ ...BASE, timeout: 600000 });
  await s.writeFiles([{ path: '/tmp/secret.txt', content: Buffer.from('synthetic-p1-only') }]);
  out.target = { name: s.name, session: s.currentSession().sessionId, projectId: me.project_id, owner: me.owner_id, snapshotId: raw.setup.snapshotId };
  rec('P1 created target sandbox', { name: s.name });
} else if (phase === 'attack') {
  const t = out.target;
  await attempt('Sandbox.get(P1 target)', async () => { const s = await Sandbox.get({ name: t.name, resume: false }); return { found: s.name }; });
  await attempt('Sandbox.get(P1 target) + readFile', async () => { const s = await Sandbox.get({ name: t.name }); const b = await s.readFileToBuffer({ path: '/tmp/secret.txt' }); return { read: b?.toString() }; });
  await attempt('create sandbox from P1 snapshot', async () => { const s = await Sandbox.create({ ...BASE, timeout: 30000, source: { type: 'snapshot', snapshotId: t.snapshotId } }); const n = s.name; await s.delete(); return { created: n }; });
  await attempt('Snapshot.get(P1 snapshot)', async () => { const s = await Snapshot.get({ snapshotId: t.snapshotId }); return { found: s.snapshotId }; });
  await attempt('list sandboxes', async () => { const l = await Sandbox.list({ limit: 50 }); const names = (l.sandboxes || []).map((s) => s.name); return { count: names.length, includesP1Target: names.includes(t.name) }; });
  await attempt('list snapshots', async () => { const l = await Snapshot.list({ limit: 50 }); const ids = (l.snapshots || []).map((s) => s.id); return { count: ids.length, includesP1Snapshot: ids.includes(t.snapshotId) }; });
  for (const [label, path] of [['REST GET target (teamId)', `/v2/sandboxes/${t.name}?teamId=${me.owner_id}`], ['REST GET target + projectId=P1', `/v2/sandboxes/${t.name}?teamId=${me.owner_id}&projectId=${t.projectId}`], ['REST POST fs/read on P1 session', `/v2/sandboxes/sessions/${t.session}/fs/read?teamId=${me.owner_id}`]]) {
    const isPost = label.includes('POST');
    const r = await fetch('https://api.vercel.com' + path, { method: isPost ? 'POST' : 'GET', headers: { authorization: 'Bearer ' + tok, 'content-type': 'application/json' }, body: isPost ? JSON.stringify({ path: '/tmp/secret.txt' }) : undefined });
    rec(label, { status: r.status, body: (await r.text()).slice(0, 120) });
  }
} else if (phase === 'verify') {
  const t = out.target;
  await attempt('P1 positive control: Sandbox.get + readFile', async () => { const s = await Sandbox.get({ name: t.name }); const b = await s.readFileToBuffer({ path: '/tmp/secret.txt' }); await s.delete(); return { read: b?.toString() }; });
}
writeFileSync(FILE, JSON.stringify(out, null, 2));
