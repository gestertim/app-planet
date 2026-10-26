// VC-3 OIDC 專案隔離：以專案 2 的 OIDC 權杖嘗試存取專案 1 的沙箱與快照（合成資料）
import { Sandbox, Snapshot } from '@vercel/sandbox';
import { readFileSync, writeFileSync } from 'node:fs';

const raw = JSON.parse(readFileSync('results/vc3a-raw.json', 'utf8'));
const P1 = { name: raw.resumeName, snapshotId: raw.setup.snapshotId };
const tok2 = process.env.VERCEL_OIDC_TOKEN; const c2 = JSON.parse(Buffer.from(tok2.split('.')[1], 'base64url').toString());
const tok1 = readFileSync('.env.local', 'utf8').match(/VERCEL_OIDC_TOKEN="?([^"\r\n]+)/)[1]; const c1 = JSON.parse(Buffer.from(tok1.split('.')[1], 'base64url').toString());
const out = { project1: c1.project, project2: c2.project, sameTeam: c1.owner_id === c2.owner_id, checks: [] };
const rec = (name, r) => { out.checks.push({ name, ...r }); console.log(name, JSON.stringify(r)); };
const attempt = async (name, fn) => { try { const v = await fn(); rec(name, { allowed: true, result: v }); } catch (e) { rec(name, { allowed: false, status: e.response?.status ?? null, error: String(e.message).slice(0, 160) }); } };

await attempt('P2 token: Sandbox.get(P1 named sandbox)', async () => { const s = await Sandbox.get({ name: P1.name, resume: false }); return { found: s.name }; });
await attempt('P2 token + P1 projectId override: Sandbox.get', async () => { const s = await Sandbox.get({ name: P1.name, resume: false, token: tok2, teamId: c2.owner_id, projectId: c1.project_id }); return { found: s.name }; });
await attempt('P2 token: create sandbox from P1 snapshot', async () => { const s = await Sandbox.create({ ports: [], networkPolicy: 'deny-all', resources: { vcpus: 1 }, region: 'hnd1', timeout: 30000, source: { type: 'snapshot', snapshotId: P1.snapshotId } }); const n = s.name; await s.stop(); return { created: n }; });
await attempt('P2 token: Snapshot.get(P1 snapshot)', async () => { const s = await Snapshot.get({ snapshotId: P1.snapshotId }); return { found: s.snapshotId }; });
await attempt('P2 token: list sandboxes (should not include P1 names)', async () => { const l = await Sandbox.list({ limit: 50 }); const names = (l.json?.sandboxes || []).map((s) => s.name); return { count: names.length, includesP1Resume: names.includes(P1.name) }; });
for (const [label, token, id] of [['P1 token (positive control)', tok1, c1]]) {
  await attempt(label + ': Sandbox.get(P1 named sandbox)', async () => { const s = await Sandbox.get({ name: P1.name, resume: false, token, teamId: id.owner_id, projectId: id.project_id }); return { found: s.name }; });
}
const r = await fetch(`https://api.vercel.com/v2/sandboxes/${P1.name}?teamId=${c2.owner_id}`, { headers: { authorization: 'Bearer ' + tok2 } }); rec('P2 token REST GET P1 sandbox', { status: r.status, body: (await r.text()).slice(0, 120) });
const r2 = await fetch(`https://api.vercel.com/v2/sandboxes/${P1.name}?teamId=${c2.owner_id}&projectId=${c1.project_id}`, { headers: { authorization: 'Bearer ' + tok2 } }); rec('P2 token REST GET P1 sandbox + projectId=P1', { status: r2.status, body: (await r2.text()).slice(0, 120) });
const r3 = await fetch(`https://api.vercel.com/v2/sandboxes/${P1.name}`, { headers: { authorization: 'Bearer ' + tok2 } }); rec('P2 token REST GET without teamId', { status: r3.status, body: (await r3.text()).slice(0, 120) });
writeFileSync('results/vc3c-raw.json', JSON.stringify(out, null, 2));
