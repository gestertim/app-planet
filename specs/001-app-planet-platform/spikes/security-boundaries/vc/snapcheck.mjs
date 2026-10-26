import { Sandbox, Snapshot } from '@vercel/sandbox';
import { readFileSync } from 'node:fs';
const raw = JSON.parse(readFileSync('results/vc3a-raw.json', 'utf8'));
try { const l = await Snapshot.list({ limit: 50 }); const items = l.snapshots ?? []; console.log('snapshots', items.length, JSON.stringify(items.slice(0, 3)).slice(0, 600)); } catch (e) { console.log('list err', e.message.slice(0, 200)); }
try { const s = await Sandbox.create({ ports: [], networkPolicy: 'deny-all', resources: { vcpus: 1 }, region: 'hnd1', timeout: 30000, persistent: false, source: { type: 'snapshot', snapshotId: raw.setup.snapshotId } }); console.log('create from snapshot OK', s.name); await s.delete(); } catch (e) { console.log('create from snapshot FAIL', e.response?.status, e.message.slice(0, 300)); }
try { const s = await Sandbox.create({ ports: [], networkPolicy: 'deny-all', resources: { vcpus: 1 }, region: 'hnd1', timeout: 30000, persistent: false }); console.log('plain create OK', s.name); await s.delete(); } catch (e) { console.log('plain create FAIL', e.response?.status, e.message.slice(0, 300)); }
