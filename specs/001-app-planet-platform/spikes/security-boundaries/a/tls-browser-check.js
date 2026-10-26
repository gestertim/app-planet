'use strict';
// 本機 TLS＋真實瀏覽器（Chrome／Edge，headless，CDP）補充驗證。合成資料；僅 *.localhost。
// 注意：使用本機自簽憑證（以 SPKI 釘選忽略信任錯誤），**不是**公開信任的「正式 TLS」，無供應商網域、無 PSL。
// 執行：node a/tls-browser-check.js（N_MAIN／N_CTRL 環境變數調整次數）；結果寫入 results/tls-local-n<N_MAIN>.json
const https = require('https');
const tls = require('tls');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, execFileSync } = require('child_process');
const { createSandbox } = require('./sandbox-sim');
const { PreviewPlatform } = require('./platform-preview');
const { PreviewEdge } = require('./edge-preview');

const PLATFORM_PORT = 4443;
const N_MAIN = Number(process.env.N_MAIN || 30);
const N_CTRL = Number(process.env.N_CTRL || 3);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const BROWSERS = {
  chrome: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  edge: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
};
const CONFIGS = {
  default: { args: [] },
  incognito: { args: ['--incognito'] },
  block3p_pref: { args: [], prefs: { profile: { cookie_controls_mode: 1, block_third_party_cookies: true } } },
  phaseout_flag: { args: ['--test-third-party-cookie-phaseout'] },
};

const APP_JS = `(async () => {
  const out = { path: location.pathname };
  out.sub = (await fetch('/app.js?probe=1')).status;
  out.data = (await fetch('/_work/data/v1/k', { method: 'PUT', body: 'v' })).status;
  out.ws = await new Promise((r) => { try { const w = new WebSocket('wss://' + location.host + '/ws'); w.onopen = () => w.send('hi'); w.onmessage = (e) => { r('echo'); w.close(); }; w.onerror = () => r('error'); setTimeout(() => r('timeout'), 2500); } catch (e) { r('exc'); } });
  try { localStorage.setItem('a', '1'); out.ls = localStorage.getItem('a'); } catch (e) { out.ls = 'blocked'; }
  out.jsCookie = document.cookie;
  parent.postMessage(out, '*');
})();`;

function makeCert(dir) {
  const pw = 'synthetic-pw';
  const ps = `$ErrorActionPreference='Stop'; $c=New-SelfSignedCertificate -DnsName 'app.localhost','other.localhost','*.preview.localhost' -CertStoreLocation Cert:\\CurrentUser\\My -NotAfter (Get-Date).AddDays(2) -KeyAlgorithm ECDSA_nistP256 -KeyExportPolicy Exportable; try { Export-PfxCertificate -Cert $c -FilePath '${dir}\\t.pfx' -Password (ConvertTo-SecureString '${pw}' -AsPlainText -Force) | Out-Null; Export-Certificate -Cert $c -FilePath '${dir}\\t.cer' | Out-Null } finally { Remove-Item $c.PSPath }`;
  execFileSync(process.env.PWSH_PATH || 'pwsh', ['-NoProfile', '-Command', ps]);
  const x = new crypto.X509Certificate(fs.readFileSync(path.join(dir, 't.cer')));
  const spki = crypto.createHash('sha256').update(x.publicKey.export({ type: 'spki', format: 'der' })).digest('base64');
  return { tlsOpts: { pfx: fs.readFileSync(path.join(dir, 't.pfx')), passphrase: pw }, spki };
}

class Cdp {
  constructor(url) {
    this.ws = new WebSocket(url); this.id = 0; this.p = new Map();
    this.ready = new Promise((r) => this.ws.addEventListener('open', r));
    this.ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && this.p.has(m.id)) { this.p.get(m.id)(m); this.p.delete(m.id); } });
  }
  send(method, params = {}) { const id = ++this.id; this.ws.send(JSON.stringify({ id, method, params })); return new Promise((r) => this.p.set(id, r)); }
  async evalValue(expression) { const r = await this.send('Runtime.evaluate', { expression, returnByValue: true }); return r.result && r.result.result && r.result.result.value; }
  close() { try { this.ws.close(); } catch (_) { /* ignore */ } }
}

async function launch(exe, cfg, spki) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'app-planet-br-'));
  if (cfg.prefs) { fs.mkdirSync(path.join(dir, 'Default')); fs.writeFileSync(path.join(dir, 'Default', 'Preferences'), JSON.stringify(cfg.prefs)); }
  const args = ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${dir}`, `--ignore-certificate-errors-spki-list=${spki}`,
    '--no-first-run', '--no-default-browser-check', '--disable-extensions', ...cfg.args, 'about:blank'];
  const child = spawn(exe, args, { stdio: 'ignore' });
  let port = null;
  for (let i = 0; i < 100 && !port; i++) {
    await sleep(200);
    try { port = Number(fs.readFileSync(path.join(dir, 'DevToolsActivePort'), 'utf8').split('\n')[0]); } catch (_) { /* wait */ }
  }
  if (!port) { child.kill(); throw new Error('browser did not start'); }
  const ver = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
  const tgt = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json();
  const cdp = new Cdp(tgt.webSocketDebuggerUrl); await cdp.ready;
  await cdp.send('Page.enable');
  return { cdp, version: ver.Browser, close: async () => {
    cdp.close();
    try { execFileSync(process.env.PWSH_PATH || 'pwsh', ['-NoProfile', '-Command', `Get-CimInstance Win32_Process | ? { $_.CommandLine -like '*${path.basename(dir)}*' -and $_.ProcessId -ne $PID } | % { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`], { stdio: 'ignore' }); } catch (_) { /* best effort：Edge 會脫離子行程樹 */ }
    await sleep(1000);
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); } catch (_) { /* best effort */ }
  } };
}

async function visit(cdp, url, waitExpr, timeoutMs = 15000) {
  await cdp.send('Page.navigate', { url: 'about:blank' }); await sleep(80);
  await cdp.send('Page.navigate', { url });
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    await sleep(120);
    const v = await cdp.evalValue(waitExpr);
    if (v) return v;
  }
  return null;
}
const DONE = "document.body&&document.body.getAttribute('data-done')?JSON.stringify(window.__msgs):''";

const okMsg = (m) => m && m.sub === 200 && m.data === 200 && m.ws === 'echo' && m.ls === '1';

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'app-planet-tls-'));
  const { tlsOpts, spki } = makeCert(tmp);
  const platform = new PreviewPlatform({ now: () => Date.now() });
  const sandbox = await createSandbox({ appJs: APP_JS });
  const variants = {
    T1: { port: 4451, mode: 'host', desc: 'A0 主機名即憑證（對照）' },
    T2: { port: 4452, mode: 'cookie', cookieName: '__Host-Http-pv', cookieAttrs: 'Path=/; Secure; HttpOnly; SameSite=None; Partitioned', desc: 'A1 __Host-Http- + Partitioned' },
    T3: { port: 4453, mode: 'cookie', cookieName: 'pv', cookieAttrs: 'Path=/; Secure; HttpOnly; SameSite=None', desc: '對照：SameSite=None; Secure 無 Partitioned' },
    T4: { port: 4454, mode: 'cookie', cookieName: 'pv', cookieAttrs: 'Path=/; Secure; HttpOnly; SameSite=Lax', desc: '對照：SameSite=Lax' },
  };
  const frameAncestors = `https://app.localhost:${PLATFORM_PORT} https://other.localhost:${PLATFORM_PORT}`;
  const edges = {};
  for (const [k, v] of Object.entries(variants)) {
    const e = new PreviewEdge({ platform, clock: { now: () => Date.now() }, upstream: { port: sandbox.port }, frameAncestors, stateTtlMs: 1000, domain: 'preview.localhost', ...v });
    e.server = https.createServer(tlsOpts, (q, s) => e.handle(q, s).catch(() => s.writeHead(500).end()));
    e.server.on('upgrade', (q, sock, h) => e.upgrade(q, sock, h));
    await new Promise((r) => e.server.listen(v.port, '127.0.0.1', r));
    edges[k] = e;
  }

  let last = null;
  const page = (src, base, reload) => `<html><body><iframe id="f" width="500" height="200" sandbox="allow-scripts allow-same-origin allow-forms allow-modals" allow="" referrerpolicy="no-referrer" src="${src}"></iframe><script>
const f=document.getElementById('f'),msgs=window.__msgs=[],BASE=${JSON.stringify(base)},RELOAD=${reload};let loads=0,t;
const finish=()=>document.body.setAttribute('data-done','1');
const next=()=>{ if(RELOAD&&loads===1&&msgs[0].path!=='none') f.src=BASE; else finish(); };
addEventListener('message',e=>{ clearTimeout(t); msgs.push(e.data); next(); });
f.addEventListener('load',()=>{ loads++; clearTimeout(t); t=setTimeout(()=>{ if(msgs.length<loads){ msgs.push({path:'none'}); next(); } },1500); });
</script></body></html>`;
  const platformServer = https.createServer(tlsOpts, (req, res) => {
    const u = new URL(req.url, 'https://x');
    if (u.pathname === '/embed') {
      const v = variants[u.searchParams.get('v')];
      const s = platform.issue();
      const base = `https://${s.preview_id}.preview.localhost:${v.port}/`;
      last = { base, id: s.preview_id };
      res.writeHead(200, { 'content-type': 'text/html' }).end(page(`${base}_work/preview/redeem?t=${s.token}`, base, 1));
    } else if (u.pathname === '/frame') {
      res.writeHead(200, { 'content-type': 'text/html' }).end(page(u.searchParams.get('u').replace(/"/g, ''), '', 0));
    } else if (u.pathname === '/p/set') {
      res.setHeader('set-cookie', [
        '__Host-Http-good=1; Path=/; Secure; HttpOnly; SameSite=None; Partitioned',
        '__Host-Http-bad1=1; Path=/; Secure; SameSite=Lax',
        '__Host-Http-bad2=1; Path=/; Secure; HttpOnly; Domain=app.localhost',
        '__Http-bad3=1; Path=/; Secure',
        '__Host-bad4=1; Path=/; Secure; Domain=app.localhost',
      ]);
      res.writeHead(200, { 'content-type': 'text/plain' }).end('set');
    } else if (u.pathname === '/p/read') {
      res.writeHead(200, { 'content-type': 'text/plain' }).end('COOKIES:' + (req.headers.cookie || '').split(/;\s*/).map((c) => c.split('=')[0]).filter(Boolean).sort().join(','));
    } else res.writeHead(404).end();
  });
  await new Promise((r) => platformServer.listen(PLATFORM_PORT, '127.0.0.1', r));

  const results = { startedAt: new Date().toISOString(), tls: 'local self-signed (SPKI pinned; NOT publicly trusted)', n_main: N_MAIN, n_ctrl: N_CTRL, browsers: {}, rawClient: null };

  // 瀏覽器矩陣
  for (const [bname, exe] of Object.entries(BROWSERS)) {
    if (!fs.existsSync(exe)) { results.browsers[bname] = { skipped: 'not installed' }; continue; }
    for (const [cname, cfg] of Object.entries(CONFIGS)) {
      const key = `${bname}/${cname}`;
      console.log('==', key);
      const br = await launch(exe, cfg, spki);
      const r = { version: br.version, cells: {} };
      try {
        const run = async (v, n, topHost = 'app.localhost') => {
          let ok = 0, none = 0; const sample = [];
          for (let i = 0; i < n; i++) {
            const raw = await visit(br.cdp, `https://${topHost}:${PLATFORM_PORT}/embed?v=${v}`, DONE);
            const msgs = raw ? JSON.parse(raw) : [];
            const pass = msgs.length === 2 && msgs.every(okMsg);
            if (pass) ok++; else none++;
            if (i === 0) sample.push(msgs);
          }
          return { ok, fail: none, n, sample: sample[0] };
        };
        r.cells.T2_A1_iframe = await run('T2', N_MAIN);
        r.cells.T1_A0_iframe = await run('T1', N_CTRL);
        r.cells.T3_None_Secure_iframe = await run('T3', N_CTRL);
        r.cells.T4_Lax_iframe = await run('T4', N_CTRL);
        // cookie 分區：同一預覽網址改由另一頂層站台內嵌／直接導覽
        for (const v of ['T2', 'T3']) {
          let other = 0, direct = 0; const n = 5;
          for (let i = 0; i < n; i++) {
            await visit(br.cdp, `https://app.localhost:${PLATFORM_PORT}/embed?v=${v}`, DONE); // 於 app.localhost 分區兌換
            const base = last.base;
            const raw = await visit(br.cdp, `https://other.localhost:${PLATFORM_PORT}/frame?u=${encodeURIComponent(base)}`, DONE);
            const msgs = raw ? JSON.parse(raw) : [];
            if (msgs.length && msgs.every(okMsg)) other++;
            await visit(br.cdp, base, "document.body&&document.body.innerText?document.body.innerText:''");
            const txt = await br.cdp.evalValue('document.body.innerText');
            if (txt && txt.includes('SYNTHETIC-STUDENT-APP')) direct++;
          }
          r.cells[`${v}_other_toplevel_embed_success`] = `${other}/${n}`;
          r.cells[`${v}_direct_navigation_success`] = `${direct}/${n}`;
        }
        // __Host-Http- 前綴行為
        await visit(br.cdp, `https://app.localhost:${PLATFORM_PORT}/p/set`, "document.body&&document.body.innerText==='set'?'1':''");
        await visit(br.cdp, `https://app.localhost:${PLATFORM_PORT}/p/read`, "document.body&&document.body.innerText.startsWith('COOKIES:')?'1':''");
        r.cells.prefix_probe_accepted_cookies = await br.cdp.evalValue('document.body.innerText');
      } catch (e) { r.error = String(e && e.message || e); }
      await br.close();
      results.browsers[key] = r;
    }
  }

  // 無瀏覽器、無 cookie 的外部用戶端（洩漏主機名情境），經 TLS
  const idFor = () => { const s = platform.issue(); return s; };
  const getStatus = (host, port, p, method = 'GET', body) => new Promise((resolve) => {
    const rq = https.request({ host: '127.0.0.1', port, path: p, method, headers: { host: `${host}:${port}`, 'content-type': 'text/plain' }, rejectUnauthorized: false }, (rs) => { rs.resume(); rs.on('end', () => resolve(rs.statusCode)); });
    rq.on('error', () => resolve('err')); rq.end(body);
  });
  const wsStatus = (host, port) => new Promise((resolve) => {
    const s = tls.connect({ host: '127.0.0.1', port, rejectUnauthorized: false, servername: host }, () => {
      s.write(`GET /ws HTTP/1.1\r\nHost: ${host}:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${crypto.randomBytes(16).toString('base64')}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
    });
    s.once('data', (d) => { resolve(d.toString().split('\r\n')[0]); s.destroy(); });
    s.on('error', () => resolve('err')); setTimeout(() => { resolve('timeout'); s.destroy(); }, 3000);
  });
  results.rawClient = {};
  for (const k of ['T1', 'T2']) {
    const s = idFor();
    const host = `${s.preview_id}.preview.localhost`;
    const e = edges[k]; const v = variants[k];
    // 兌換（合法瀏覽器取得 cookie）；raw client 不帶 cookie
    await getStatus(host, v.port, `/_work/preview/redeem?t=${s.token}`);
    results.rawClient[k] = {
      html: await getStatus(host, v.port, '/'), js: await getStatus(host, v.port, '/app.js'),
      dataGet: await getStatus(host, v.port, '/_work/data/v1/k'), dataPut: await getStatus(host, v.port, '/_work/data/v1/k', 'PUT', 'x'),
      dataDel: await getStatus(host, v.port, '/_work/data/v1/k', 'DELETE'), ws: await wsStatus(host, v.port),
    };
    void e;
  }

  results.finishedAt = new Date().toISOString();
  const outDir = path.join(__dirname, '..', 'results'); fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, `tls-local-n${N_MAIN}.json`), JSON.stringify(results, null, 2));
  for (const e of Object.values(edges)) e.server.close();
  platformServer.close(); sandbox.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(JSON.stringify(results, (k, v) => (k === 'sample' ? undefined : v), 1));
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
