// 刪除：所有沙箱（含持久）與所有快照；用於測試後清理。KEEP 環境變數可指定保留的快照 ID（逗號分隔）。
import { Sandbox, Snapshot } from '@vercel/sandbox';
const keep = new Set((process.env.KEEP || '').split(',').filter(Boolean));
const l = await Sandbox.list({ limit: 50 }); let n = 0;
for (const s of l.sandboxes ?? []) { try { const sb = await Sandbox.get({ name: s.name, resume: false }); await sb.delete({ deleteOrphanSnapshots: true }); n++; } catch (e) { console.log('del sandbox err', s.name, e.message.slice(0, 80)); } }
console.log('sandboxes deleted', n);
let m = 0;
for (let page = 0; page < 10; page++) {
  const sl = await Snapshot.list({ limit: 50 }); const items = (sl.snapshots ?? []).filter((x) => x.status !== 'deleted' && !keep.has(x.id));
  if (!items.length) break;
  for (const s of items) { try { const sn = await Snapshot.get({ snapshotId: s.id }); await sn.delete(); m++; } catch (e) { console.log('del snap err', s.id, e.message.slice(0, 80)); } }
}
const rest = await Snapshot.list({ limit: 50 });
console.log('snapshots deleted', m, 'remaining', (rest.snapshots ?? []).filter((x) => x.status !== 'deleted').length);
