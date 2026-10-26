// VC-1b：沙箱內（root）憑證與控制面探索；不印出任何值，只印名稱／長度／形狀旗標
import { Sandbox } from '@vercel/sandbox';
import { writeFileSync } from 'node:fs';

const SCAN = `
const fs = require('fs');
const out = [];
const shape = (v) => (/^eyJ[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}\\./.test(v) ? 'JWT' : /^(vc[a-z]_|sk-|ghp_|xox)/i.test(v) ? 'KEYPREFIX' : '');
const seen = new Set();
for (const pid of fs.readdirSync('/proc').filter((x) => /^\\d+$/.test(x))) {
  let raw; try { raw = fs.readFileSync('/proc/' + pid + '/environ'); } catch { continue; }
  for (const kv of raw.toString('utf8').split('\\0')) {
    const i = kv.indexOf('='); if (i < 1) continue; const n = kv.slice(0, i), v = kv.slice(i + 1);
    const s = shape(v); const sus = /TOKEN|SECRET|OIDC|VERCEL|CREDENTIAL|API_?KEY|PASSWORD|AUTH/i.test(n);
    if (s || sus) { const k = n + '|' + s; if (!seen.has(k)) { seen.add(k); out.push('environ pid=' + pid + ' ' + n + ' len=' + v.length + ' ' + s); } }
  }
}
function walk(d, depth) {
  let ents; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    const p = d + '/' + e.name;
    if (e.isDirectory()) { if (depth < 6 && !/node_modules|^\\/proc|^\\/sys|^\\/dev|^\\/usr\\/(share|lib|include)/.test(p)) walk(p, depth + 1); continue; }
    if (!e.isFile() || /scan\\.js$/.test(p)) continue;
    let st; try { st = fs.statSync(p); } catch { continue; }
    if (st.size > 2e6) continue;
    if (/(^|\\/)(\\.env.*|auth\\.json|credentials.*|.*\\.token)$/.test(p)) out.push('credfile ' + p);
    let t; try { t = fs.readFileSync(p, 'latin1'); } catch { continue; }
    if (/eyJ[A-Za-z0-9_-]{20,}\\.[A-Za-z0-9_-]{20,}\\./.test(t)) out.push('jwt-shaped-content ' + p);
    if (/VERCEL_OIDC_TOKEN|VERCEL_TOKEN/.test(t)) out.push('vercel-token-name-in ' + p);
  }
}
for (const r of ['/etc', '/root', '/home', '/vercel', '/run', '/opt', '/var/lib', '/tmp', '/usr/local', '/srv']) walk(r, 0);
console.log(out.length ? out.join('\\n') : 'NO_FINDINGS');
`;

const PROBE = `
echo "== 23456 owner"; ss -ltnp | grep 23456
echo "== 127.0.0.1:23456 /"; curl -s -m 4 -i http://127.0.0.1:23456/ | head -12 | cut -c1-200; echo "exit=$?"
echo "== 169.254.0.2:23456 /"; curl -s -m 4 -i http://169.254.0.2:23456/ | head -12 | cut -c1-200
echo "== init socket"; ls -l /run/vercel/share/ 2>&1 | head; 
echo "== gateway 169.254.0.1"; curl -s -m 4 -o /dev/null -w '%{http_code}\\n' http://169.254.0.1/ ; echo "exit=$?"
echo "== dns lookup (deny-all)"; getent hosts api.vercel.com; echo "exit=$?"
echo "== sudo -l"; sudo -n -l 2>&1 | head -5
`;

const nul = await Sandbox.create({ ports: [], timeout: 180000, persistent: false, networkPolicy: 'deny-all', region: 'hnd1', resources: { vcpus: 1 } });
const res = {};
await nul.writeFiles([{ path: '/opt/scan.js', content: Buffer.from(SCAN) }, { path: '/opt/probe.sh', content: Buffer.from(PROBE) }]);
let r = await nul.runCommand({ cmd: 'node', args: ['/opt/scan.js'], sudo: true }); res.scan = (await r.stdout()) + (await r.stderr());
r = await nul.runCommand({ cmd: 'bash', args: ['/opt/probe.sh'], sudo: true }); res.probe = (await r.stdout()) + (await r.stderr());
console.log('== scan (deny-all, root) ==\n' + res.scan + '\n== probe ==\n' + res.probe);
await nul.stop().catch(() => {});
writeFileSync('results/vc1b-raw.json', JSON.stringify(res, null, 2));
