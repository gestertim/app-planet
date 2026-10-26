import { Sandbox } from '@vercel/sandbox';
const mode = process.argv[2] || 'stop';
const l = await Sandbox.list({ limit: 50 });
const items = l.sandboxes ?? [];
console.log('sandboxes:', items.length);
for (const s of items) {
  console.log(s.name, s.status, s.persistent ? 'persistent' : '', s.createdAt ?? '');
  if (mode === 'delete') { try { const sb = await Sandbox.get({ name: s.name, resume: false }); await sb.delete(); console.log(' deleted'); } catch (e) { console.log(' delete err', e.message); } }
  else if (s.status === 'running' || s.status === 'pending') { try { const sb = await Sandbox.get({ name: s.name, resume: false }); await sb.stop(); console.log(' stopped'); } catch (e) { console.log(' stop err', e.message); } }
}
