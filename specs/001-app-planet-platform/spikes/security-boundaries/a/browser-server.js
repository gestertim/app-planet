'use strict';
// 本機真實瀏覽器 Spike 伺服器（合成資料；僅 localhost，不含 TLS、真實網域或 PSL）
// 啟動：node a/browser-server.js ；以瀏覽器開 http://app.localhost:4100/embed?v=E2
const http = require('http');
const { createSandbox } = require('./sandbox-sim');
const { PreviewPlatform } = require('./platform-preview');
const { PreviewEdge } = require('./edge-preview');

const PLATFORM_PORT = 4100;
const APP_JS = `(async () => {
  const out = {};
  out.sub = (await fetch('/app.js?probe=1')).status;
  out.data = (await fetch('/_work/data/v1/k', { method: 'PUT', body: 'v' })).status;
  out.ws = await new Promise((r) => { try { const w = new WebSocket('ws://' + location.host + '/ws'); w.onopen = () => w.send('hi'); w.onmessage = (e) => { r(e.data); w.close(); }; w.onerror = () => r('error'); setTimeout(() => r('timeout'), 2500); } catch (e) { r('exc'); } });
  try { localStorage.setItem('a', '1'); out.ls = localStorage.getItem('a'); } catch (e) { out.ls = 'blocked'; }
  try { await fetch('http://app.localhost:${PLATFORM_PORT}/api/csrf', { method: 'POST', credentials: 'include', mode: 'no-cors' }); out.csrfSent = true; } catch (e) { out.csrfSent = 'error'; }
  document.body.setAttribute('data-result', JSON.stringify(out));
})();`;

(async () => {
  const platform = new PreviewPlatform({ now: () => Date.now(), advance() {} }); // 真實時間
  const sandbox = await createSandbox({ appJs: APP_JS });
  const variants = {
    E1: { port: 4101, domain: 'preview.localhost', mode: 'host', desc: 'A0 主機名即憑證（跨站）' },
    E2: { port: 4102, domain: 'preview.localhost', mode: 'cookie', cookieAttrs: 'SameSite=None; Secure; Partitioned', desc: 'A1 SameSite=None; Secure; Partitioned（跨站）' },
    E3: { port: 4103, domain: 'preview.localhost', mode: 'cookie', cookieAttrs: 'SameSite=Lax', desc: '對照：host-only SameSite=Lax（跨站）' },
    E4: { port: 4104, domain: 'preview.localhost', mode: 'cookie', cookieAttrs: 'SameSite=None; Secure', desc: '對照：SameSite=None; Secure 無 Partitioned（跨站）' },
    E5: { port: 4105, domain: 'app.localhost', mode: 'cookie', cookieAttrs: 'SameSite=Lax', desc: 'A2 同站子網域 + SameSite=Lax' },
  };
  const edges = {};
  for (const [k, v] of Object.entries(variants)) {
    // 測試用：frameAncestors 另允許 other.localhost，以檢驗 cookie 分區
    edges[k] = new PreviewEdge({ platform, clock: { now: () => Date.now() }, upstream: { port: sandbox.port }, frameAncestors: `http://app.localhost:${PLATFORM_PORT} http://other.localhost:${PLATFORM_PORT}`, stateTtlMs: 2000, ...v });
    edges[k].server = http.createServer((q, s) => edges[k].handle(q, s).catch(() => s.writeHead(500).end()));
    edges[k].server.on('upgrade', (q, sock, h) => edges[k].upgrade(q, sock, h));
    await new Promise((r) => edges[k].server.listen(v.port, '127.0.0.1', r));
  }
  const csrfLog = [];
  http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/embed') {
      const v = variants[u.searchParams.get('v')];
      const s = platform.issue();
      res.setHeader('set-cookie', 'plat=SYNTHETIC-PLATFORM-SESSION; Path=/; SameSite=Lax');
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(`<html><body>platform<iframe id="f" width="500" height="200" sandbox="allow-scripts allow-same-origin allow-forms allow-modals" allow="" referrerpolicy="no-referrer" src="http://${s.preview_id}.${v.domain}:${v.port}/_work/preview/redeem?t=${s.token}"></iframe></body></html>`);
    } else if (u.pathname === '/frame') { // 以不同頂層站台（other.localhost）內嵌同一預覽網址，檢驗 cookie 分區
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(`<html><body>other-top-level<iframe id="f" width="500" height="200" sandbox="allow-scripts allow-same-origin" src="${u.searchParams.get('u').replace(/"/g, '')}"></iframe></body></html>`);
    } else if (u.pathname === '/api/csrf') {
      csrfLog.push({ method: req.method, platformCookieSent: /plat=/.test(req.headers.cookie || ''), secFetchSite: req.headers['sec-fetch-site'], origin: req.headers.origin || null });
      res.writeHead(204).end();
    } else if (u.pathname === '/csrf-log') {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(csrfLog));
    } else res.writeHead(404).end();
  }).listen(PLATFORM_PORT, '127.0.0.1', () => console.log('browser spike ready: platform :' + PLATFORM_PORT + ' variants ' + Object.keys(variants).join(',')));
})();
