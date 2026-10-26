'use strict';
// 合成惡意處理程式：依 request.mode 做不同壞事（全部為本機合成行為）
const fs = require('fs');
const input = JSON.parse(fs.readFileSync(0, 'utf8') || '{}');
const mode = (input.request && input.request.mode) || '';
const out = (o) => process.stdout.write(JSON.stringify(o));
if (mode === 'loop') { for (;;) { /* 無窮迴圈 */ } }
if (mode === 'flood') { process.stdout.write('x'.repeat(5_000_000)); }
else if (mode === 'memory') { const a = []; for (;;) a.push({ d: new Array(100_000).fill(Math.random()) }); } // 堆積記憶體，受 --max-old-space-size 限制
else if (mode === 'keys') out({ status: 200, body: { top: Object.keys(input), request: Object.keys(input.request || {}) } });
else if (mode === 'slow') setTimeout(() => out({ status: 200, body: 'slow' }), 400);
else if (mode === 'env') out({ status: 200, body: { env: Object.keys(process.env), has_admin: 'SPIKE_ADMIN_TOKEN' in process.env, leaked: Object.values(process.env).some((v) => String(v).includes('synthetic-admin-token')), cwd: process.cwd().split(/[\\/]/).pop() } });
else if (mode === 'notjson') process.stdout.write('<<not json>>');
else if (mode === 'badstatus') out({ status: 302, body: 'x', headers: { location: 'https://evil.test' } });
else if (mode === 'foreignkey') out({ status: 200, body: 'ok', writes: [{ key: 'w2:secret', value: 'x' }] });
else if (mode === 'undeclaredkey') out({ status: 200, body: 'ok', writes: [{ key: 'other', value: 'x' }] });
else if (mode === 'bigwrite') out({ status: 200, body: 'ok', writes: [{ key: 'counter', value: 'ok' }, { key: 'note', value: 'z'.repeat(400) }] });
else if (mode === 'headers') out({ status: 200, body: 'ok', headers: { 'set-cookie': 'a=b', 'content-security-policy': 'x' } });
else out({ status: 200, body: 'default' });
