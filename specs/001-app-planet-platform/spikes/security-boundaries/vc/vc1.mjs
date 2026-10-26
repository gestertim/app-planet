// VC-1：ports: [] 沙箱的零暴露驗證（合成資料；僅供隔離測試 Team 使用）
import { Sandbox } from '@vercel/sandbox';
import https from 'node:https';
import http from 'node:http';
import dns from 'node:dns/promises';
import { writeFileSync, mkdirSync } from 'node:fs';

const REGION = 'hnd1';
const PORTS = [80, 443, 3000, 5173, 8080, 23456, 26661];
const out = { startedAt: new Date().toISOString(), region: REGION, probes: [], inVm: {}, notes: [] };
const log = (...a) => console.log(...a);

const SERVER = `
const http = require('http'); const crypto = require('crypto');
const ports = ${JSON.stringify(PORTS)};
for (const p of ports) {
  const s = http.createServer((q, r) => { r.writeHead(200, {'content-type':'text/plain'}); r.end('CANARY:' + (process.env.LABEL||'x') + ':' + p + ':' + q.url); });
  s.on('upgrade', (q, sock) => {
    const k = q.headers['sec-websocket-key'] || '';
    const a = crypto.createHash('sha1').update(k + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    sock.write('HTTP/1.1 101 Switching Protocols\\r\\nUpgrade: websocket\\r\\nConnection: Upgrade\\r\\nSec-WebSocket-Accept: ' + a + '\\r\\n\\r\\n');
    sock.write(Buffer.from([0x81, 0x0b, ...Buffer.from('WSCANARY:' + p).slice(0, 11)]));
  });
  s.on('error', e => console.error('listen fail', p, e.code));
  s.listen(p, '0.0.0.0', () => console.log('listening', p));
}
setInterval(() => {}, 1000);
`;

const INSPECT = `
echo "== id"; id; echo "== uname"; uname -a | cut -c1-120
echo "== listening"; (ss -ltnp 2>/dev/null || netstat -ltnp 2>/dev/null) | cut -c1-160
echo "== ip"; ip -4 addr 2>/dev/null | grep -E 'inet |^[0-9]' | cut -c1-120
echo "== resolv"; cat /etc/resolv.conf 2>/dev/null | cut -c1-100
echo "== hostname"; hostname
echo "== env names + secret-shaped flags (values never printed)"
env | awk -F= '{n=$1; v=substr($0,length(n)+2); flag=""; if (v ~ /^eyJ[A-Za-z0-9_-]+\\./) flag=" JWT-SHAPED"; if (n ~ /TOKEN|SECRET|KEY|PASSWORD|OIDC|CREDENTIAL|AUTH/) flag=flag" NAME-SUSPECT"; print n " len=" length(v) flag}'
echo "== proc environ scan (names only)"
for f in /proc/[0-9]*/environ; do tr '\\0' '\\n' < $f 2>/dev/null | awk -F= -v f=$f '$1 ~ /TOKEN|SECRET|OIDC|VERCEL|CREDENTIAL|API_KEY/ {print f " " $1}'; done | sort -u | head -40
echo "== file scan for token-shaped/credential files (paths only)"
grep -rIlE 'eyJ[A-Za-z0-9_-]{20,}\\.[A-Za-z0-9_-]{20,}\\.|VERCEL_OIDC_TOKEN|VERCEL_TOKEN|Bearer [A-Za-z0-9_-]{20,}' /etc /root /home /vercel /run /opt /usr/local /var/lib /var/run /tmp --exclude-dir=node_modules --exclude-dir=proc 2>/dev/null | head -40
echo "== files named like credentials"; find / -xdev \\( -name '.vercel' -o -name 'auth.json' -o -name '.env*' -o -name '*.token' -o -name 'credentials*' \\) -not -path '*/node_modules/*' -not -path '/proc/*' -not -path '/usr/share/*' 2>/dev/null | head -20
echo "== processes"; ps -eo pid,user,comm,args 2>/dev/null | cut -c1-140 | head -40
echo "== grep route/domain hints in config (paths only)"; grep -rIl 'vercel.run' /etc /root /home /vercel /run /opt 2>/dev/null | head -10
`;

function req(url, { method = 'GET', headers = {}, timeout = 10000 } = {}) {
  return new Promise((resolve) => {
    const t = Date.now();
    const u = new URL(url);
    const lib = u.protocol === 'https:' ? https : http;
    const r = lib.request(u, { method, headers, timeout, rejectUnauthorized: true }, (res) => {
      let b = ''; res.setEncoding('utf8'); res.on('data', (d) => { if (b.length < 400) b += d; });
      res.on('end', () => resolve({ url, kind: 'http', status: res.statusCode, ms: Date.now() - t, body: b.slice(0, 160), canary: b.includes('CANARY:'), server: res.headers.server || null }));
    });
    r.on('timeout', () => { r.destroy(); resolve({ url, kind: 'http', error: 'timeout', ms: Date.now() - t, canary: false }); });
    r.on('error', (e) => resolve({ url, kind: 'http', error: e.code || e.message, ms: Date.now() - t, canary: false }));
    r.end();
  });
}

function wsProbe(url, timeout = 10000) {
  return new Promise((resolve) => {
    const t = Date.now();
    const u = new URL(url);
    const lib = u.protocol === 'https:' ? https : http;
    const key = Buffer.from(Array.from({ length: 16 }, (_, i) => i + 1)).toString('base64');
    const r = lib.request(u, { timeout, headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': key } });
    let done = false; const fin = (o) => { if (!done) { done = true; resolve({ url, kind: 'ws', ms: Date.now() - t, canary: false, ...o }); } };
    r.on('upgrade', (res, sock) => { let b = Buffer.alloc(0); sock.on('data', (d) => { b = Buffer.concat([b, d]); }); setTimeout(() => { fin({ status: res.statusCode, upgraded: true, canary: b.toString().includes('WSCANARY') }); sock.destroy(); }, 1500); });
    r.on('response', (res) => fin({ status: res.statusCode, upgraded: false }));
    r.on('timeout', () => { r.destroy(); fin({ error: 'timeout' }); });
    r.on('error', (e) => fin({ error: e.code || e.message }));
    r.end();
  });
}

async function startServers(sb, label) {
  await sb.writeFiles([{ path: '/tmp/srv.js', content: Buffer.from(SERVER) }]);
  await sb.runCommand({ cmd: 'node', args: ['/tmp/srv.js'], env: { LABEL: label }, sudo: true, detached: true });
  await new Promise((r) => setTimeout(r, 2500));
}

async function inspect(sb, label) {
  const r = await sb.runCommand({ cmd: 'bash', args: ['-lc', INSPECT], sudo: true });
  const text = (await r.stdout()) + (await r.stderr());
  out.inVm[label] = text;
  log(`\n----- in-VM inspect: ${label} (exit ${r.exitCode}) -----\n` + text);
}

async function egressChecks(sb, label) {
  const cmds = {
    imds: `curl -s -m 5 -o /dev/null -w '%{http_code}' http://169.254.169.254/ ; echo " exit=$?"`,
    vercelApi: `curl -s -m 5 -o /dev/null -w '%{http_code}' https://api.vercel.com/v2/sandboxes ; echo " exit=$?"`,
    vercelApiPatch: `curl -s -m 5 -X PATCH -H 'content-type: application/json' -d '{"ports":[3000]}' -w ' http=%{http_code}' https://api.vercel.com/v2/sandboxes/none ; echo " exit=$?"`,
    internalGateway: `curl -s -m 5 -o /dev/null -w '%{http_code}' http://10.0.0.1/ ; echo " exit=$?"`,
  };
  out.inVm[label + '_egress'] = {};
  for (const [k, c] of Object.entries(cmds)) {
    const r = await sb.runCommand({ cmd: 'bash', args: ['-lc', c], sudo: true });
    const s = ((await r.stdout()) + (await r.stderr())).trim().replace(/\s+/g, ' ').slice(0, 300);
    out.inVm[label + '_egress'][k] = s; log(`[${label}] egress ${k}: ${s}`);
  }
}

const ctl = await Sandbox.create({ ports: [3000], timeout: 300000, persistent: false, networkPolicy: 'deny-all', region: REGION, resources: { vcpus: 1 } });
const nul = await Sandbox.create({ ports: [], timeout: 300000, persistent: false, networkPolicy: 'deny-all', region: REGION, resources: { vcpus: 1 } });
const alw = await Sandbox.create({ ports: [], timeout: 300000, persistent: false, networkPolicy: 'allow-all', region: REGION, resources: { vcpus: 1 } });
out.sandboxes = { control: { name: ctl.name, routes: ctl.routes }, nullPorts: { name: nul.name, routes: nul.routes, session: nul.currentSession().sessionId }, allowAllNullPorts: { name: alw.name, routes: alw.routes } };
log('control routes', JSON.stringify(ctl.routes)); log('null routes', JSON.stringify(nul.routes), 'allow-all routes', JSON.stringify(alw.routes));

await Promise.all([startServers(ctl, 'control'), startServers(nul, 'null'), startServers(alw, 'allow')]);
for (const p of PORTS) { try { nul.domain(p); out.notes.push('UNEXPECTED: nul.domain(' + p + ') returned'); } catch (e) { out.probes.push({ kind: 'sdk', target: `nul.domain(${p})`, error: e.message }); } }

// 外部探測：不帶任何憑證（以 Node https/http 直連）
const ctlHost = new URL(ctl.routes[0].url).host;
const probes = [];
probes.push(req(`https://${ctlHost}/`), wsProbe(`https://${ctlHost}/ws`));
for (const p of [80, 443, 5173, 8080, 23456, 26661]) { probes.push(req(`https://${ctlHost}:${p}/`, { timeout: 8000 }), req(`http://${ctlHost}:${p}/`, { timeout: 8000 })); }
probes.push(req('https://sb-doesnotexist00.vercel.run/'));
const results = await Promise.all(probes);
out.probes.push(...results);

// null 沙箱：以所有可得識別碼推測的主機名
const ids = [nul.name, nul.currentSession().sessionId, nul.currentSession().sessionId.replace('sbx_', ''), ctlHost.split('.')[0]];
const hosts = new Set();
for (const id of ids) { hosts.add(`${id}.vercel.run`); hosts.add(`sb-${id}.vercel.run`); for (const p of PORTS) { hosts.add(`${id}-${p}.vercel.run`); hosts.add(`sb-${id}-${p}.vercel.run`); } }
const nullProbes = [];
for (const h of hosts) nullProbes.push(req(`https://${h}/`, { timeout: 8000 }));
for (const h of [`${nul.name}.vercel.run`, `${nul.currentSession().sessionId}.vercel.run`]) nullProbes.push(wsProbe(`https://${h}/ws`, 8000));
const nres = await Promise.all(nullProbes);
out.probes.push(...nres.map((x) => ({ ...x, target: 'null-guess' })));
out.guessedHostCount = hosts.size;

// VM 內檢查
await inspect(nul, 'null_deny_all');
await egressChecks(nul, 'null_deny_all');
await inspect(alw, 'null_allow_all');
await egressChecks(alw, 'null_allow_all');

// 路由列表（管理 API，需憑證）再確認一次
const tok = process.env.VERCEL_OIDC_TOKEN; const claims = JSON.parse(Buffer.from(tok.split('.')[1], 'base64url').toString());
for (const [label, sb] of [['null', nul], ['allowAll', alw]]) {
  const r = await fetch(`https://api.vercel.com/v2/sandboxes/${sb.name}?teamId=${claims.owner_id}`, { headers: { authorization: 'Bearer ' + tok } });
  const j = await r.json(); out.probes.push({ kind: 'rest-routes', target: label, status: r.status, routes: j.routes });
}
// 無憑證直接讀管理 API（對照）
{
  const r = await fetch(`https://api.vercel.com/v2/sandboxes/${nul.name}?teamId=${claims.owner_id}`); out.probes.push({ kind: 'rest-no-cred', status: r.status });
}

for (const s of [ctl, nul, alw]) await s.stop().catch((e) => log('stop err', e.message));
out.finishedAt = new Date().toISOString();
mkdirSync('results', { recursive: true });
writeFileSync('results/vc1-raw.json', JSON.stringify(out, null, 2));

const canaryHits = out.probes.filter((p) => p.canary);
log('\n== summary ==');
log('control host canary hits:', canaryHits.filter((p) => p.url?.includes(ctlHost)).map((p) => `${p.kind} ${p.url} ${p.status}`));
log('null-guess canary hits:', out.probes.filter((p) => p.target === 'null-guess' && p.canary).length, 'of', nres.length);
const sig = {}; for (const p of nres) { const k = p.error || p.status; sig[k] = (sig[k] || 0) + 1; } log('null-guess response signatures', JSON.stringify(sig));
log('baseline nonexistent host:', JSON.stringify(out.probes.find((p) => p.url === 'https://sb-doesnotexist00.vercel.run/')));
log('other ports on control host:', JSON.stringify(out.probes.filter((p) => p.url?.startsWith(`http`) && p.url.includes(ctlHost + ':')).map((p) => `${p.url} => ${p.error || p.status}`)));
