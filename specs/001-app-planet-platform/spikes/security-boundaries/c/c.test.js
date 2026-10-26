'use strict';
// 私人預覽入站邊界 Spike（合成資料；非產品程式）。執行：node --test c/c.test.js
// 範圍：只驗證「閘道與入庫邏輯」；不證明任何供應商的埠暴露、路由或存取控制行為（見 RESULTS-preview-inbound-boundary.md）。
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { Clock } = require('../lib/util');
const ws = require('../lib/ws-mini');
const { PreviewPlatform } = require('../a/platform-preview');
const { ArtifactGateway, ingestArtifact } = require('./artifact-gateway');

const get = (port, host, p, { method = 'GET', headers = {}, body } = {}) => new Promise((resolve, reject) => {
  const r = http.request({ host: '127.0.0.1', port, path: p, method, agent: false, headers: { host, ...headers } }, (res) => {
    const c = []; res.on('data', (d) => c.push(d));
    res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(c).toString() }));
  });
  r.on('error', reject); r.end(body);
});
const listen = (server, port = 0) => new Promise((r) => server.listen(port, '127.0.0.1', () => r(server.address().port)));
const file = (p, content = 'x') => ({ type: 'file', path: p, content });
const goodFiles = (tag = 'v1') => [file('index.html', `<script src="app.js"></script>${tag}`), file('app.js', `window.v='${tag}'`)];

// 負對照：同一個 VM 內的守門程序，在學生具 root 時不是邊界
test('負對照：同沙箱守門程序＋具 root 的學生程式 → 學生停掉守門程序後，無權杖請求直達學生程式', async () => {
  const student = http.createServer((q, s) => s.end('STUDENT-APP'));
  const studentPort = await listen(student);
  const guardFn = (q, s) => {
    if (q.headers['x-upstream-token'] !== 'secret') return void s.writeHead(401).end('denied');
    http.get({ host: '127.0.0.1', port: studentPort, path: '/', agent: false }, (u) => u.pipe(s));
  };
  let guard = http.createServer(guardFn);
  const publicPort = await listen(guard); // 供應商「公開網址」所對應的埠
  const outside = () => get(publicPort, 'x.test', '/');
  assert.strictEqual((await outside()).status, 401, '守門程序存在時外部被擋');
  // 學生（root／sudo）：終止守門程序，並在同一個公開埠改綁自己的伺服器
  guard.closeAllConnections(); await new Promise((r) => guard.close(r));
  guard = http.createServer((q, s) => s.end('STUDENT-REBOUND'));
  await listen(guard, publicPort);
  const r = await outside();
  assert.strictEqual(r.status, 200, '守門程序被繞過：入站授權不可放在學生可控的 VM 內');
  guard.close(); student.close();
});

// 候選 X：閘道只服務平台驗證後的產物
async function setup(mode, stateTtlMs = 15_000) {
  const clock = new Clock();
  const platform = new PreviewPlatform(clock);
  const gw = await new ArtifactGateway({ platform, clock, mode, stateTtlMs }).start();
  const open = async (files = goodFiles()) => {
    const s = platform.issue();
    const art = ingestArtifact(files);
    assert.ok(art.ok);
    gw.bind(s.preview_id, 1, art.files);
    const host = `${s.preview_id}.preview.test`;
    const r = await get(gw.port, host, `/_work/preview/redeem?t=${s.token}`);
    const m = /pv=([^;]+)/.exec(r.headers['set-cookie'] || '');
    return { ...s, host, redeem: r, ck: m ? { cookie: `pv=${m[1]}` } : {} };
  };
  return { clock, platform, gw, open, close: () => gw.close() };
}

for (const mode of ['host', 'cookie']) {
  test(`[${mode}] 授權者：HTML、子資源、重新整理、同源資料 API 可用；洩漏主機名＋無 cookie 的結果依模式而定`, async () => {
    const t = await setup(mode);
    try {
      const p = await t.open();
      assert.strictEqual(p.redeem.status, 302);
      for (const x of ['/', '/app.js', '/']) assert.strictEqual((await get(t.gw.port, p.host, x, { headers: p.ck })).status, 200, x);
      assert.strictEqual((await get(t.gw.port, p.host, '/_work/data/v1/k1', { method: 'PUT', body: 'v', headers: p.ck })).status, 200);
      assert.strictEqual((await get(t.gw.port, p.host, '/_work/data/v1/k1', { headers: p.ck })).body, 'v');
      const bare = await get(t.gw.port, p.host, '/');
      assert.strictEqual(bare.status, mode === 'host' ? 200 : 403, mode === 'host' ? 'A0：主機名即憑證（既有已知性質）' : 'A1：無 cookie 被拒');
    } finally { t.close(); }
  });
}

test('惡意產物（視為來自具 root 的學生程式）：整份拒絕', () => {
  const cases = {
    'bad-path': [file('index.html'), file('../escape.js')],
    'bad-path ': [file('index.html'), file('/etc/passwd.txt')],
    'reserved-prefix': [file('index.html'), file('_work/data/v1/k.json')],
    'not-regular-file': [file('index.html'), { type: 'symlink', path: 'link.js', target: '/etc/shadow' }],
    'type-not-allowed': [file('index.html'), file('_headers')],
    'type-not-allowed ': [file('index.html'), file('run.sh')],
    'file-too-large': [file('index.html', 'a'.repeat(1_000_001))],
    'duplicate-path': [file('index.html'), file('INDEX.HTML')],
    'no-index': [file('app.js')],
  };
  for (const [why, entries] of Object.entries(cases)) {
    const r = ingestArtifact(entries);
    assert.strictEqual(r.ok, false, why);
    assert.strictEqual(r.why, why.trim());
  }
  assert.strictEqual(ingestArtifact(Array.from({ length: 201 }, (_, i) => file(`f${i}.js`))).why, 'file-count');
  assert.ok(ingestArtifact(goodFiles()).ok);
});

test('標頭與內容類型只由閘道決定；產物不能覆寫 CSP、不能遮蔽 /_work/*', async () => {
  const t = await setup('host');
  try {
    const evil = [file('index.html', "<meta http-equiv='Content-Security-Policy' content='default-src *'>"), file('data.json', '{}')];
    const p = await t.open(evil);
    const h = (await get(t.gw.port, p.host, '/')).headers;
    assert.match(h['content-security-policy'], /^default-src 'self'; connect-src 'self'.*frame-ancestors https:\/\/app\.platform\.test$/);
    assert.strictEqual(h['x-content-type-options'], 'nosniff');
    assert.strictEqual(h['cache-control'], 'no-store');
    assert.strictEqual((await get(t.gw.port, p.host, '/data.json')).headers['content-type'], 'application/json');
    assert.strictEqual((await get(t.gw.port, p.host, '/_work/other', { headers: p.ck })).status, 404);
  } finally { t.close(); }
});

test('無長連線：WebSocket 升級一律被拒；因此撤銷後沒有殘留連線（對照既有 A 方案的 WS 重驗缺口）', async () => {
  const t = await setup('host');
  try {
    const p = await t.open();
    const w = await ws.connect({ port: t.gw.port, host: p.host, headers: p.ck });
    assert.notStrictEqual(w.status, 101);
    assert.strictEqual(t.gw.upgradeAttempts, 1);
  } finally { t.close(); }
});

test('撤銷：資料 API 立即；內容於授權快取 TTL 內失效；TTL＝0 時立即；無長連線可殘留', async () => {
  const t = await setup('host', 15_000);
  try {
    const p = await t.open();
    assert.strictEqual((await get(t.gw.port, p.host, '/')).status, 200);
    t.platform.revoke(p.preview_id);
    assert.strictEqual((await get(t.gw.port, p.host, '/_work/data/v1/k')).status, 403, '資料 API 不經快取');
    assert.strictEqual((await get(t.gw.port, p.host, '/')).status, 200, '快取 TTL 內仍可取得內容（已知上界＝TTL）');
    t.clock.advance(15_000);
    assert.strictEqual((await get(t.gw.port, p.host, '/')).status, 403);
  } finally { t.close(); }
  const z = await setup('host', 0);
  try {
    const p = await z.open();
    assert.strictEqual((await get(z.gw.port, p.host, '/')).status, 200);
    z.platform.revoke(p.preview_id);
    assert.strictEqual((await get(z.gw.port, p.host, '/')).status, 403);
  } finally { z.close(); }
});

test('到期與未兌換：403；未知主機名：403', async () => {
  const t = await setup('host', 0);
  try {
    const p = await t.open();
    t.clock.advance(30 * 60_000 + 1);
    assert.strictEqual((await get(t.gw.port, p.host, '/')).status, 403);
    const s = t.platform.issue();
    t.gw.bind(s.preview_id, 1, ingestArtifact(goodFiles()).files);
    assert.strictEqual((await get(t.gw.port, `${s.preview_id}.preview.test`, '/')).status, 403, '未兌換');
    assert.strictEqual((await get(t.gw.port, 'aaaaaaaaaaaaaaaaaaaaaaaaaa.preview.test', '/')).status, 403);
  } finally { t.close(); }
});

test('預覽間隔離：A 的 cookie／資料不能用於 B；各自只看到自己的產物', async () => {
  const t = await setup('cookie');
  try {
    const a = await t.open(goodFiles('AAA'));
    const b = await t.open(goodFiles('BBB'));
    assert.match((await get(t.gw.port, a.host, '/', { headers: a.ck })).body, /AAA/);
    assert.match((await get(t.gw.port, b.host, '/', { headers: b.ck })).body, /BBB/);
    assert.strictEqual((await get(t.gw.port, b.host, '/', { headers: a.ck })).status, 403);
    await get(t.gw.port, a.host, '/_work/data/v1/k', { method: 'PUT', body: 'secretA', headers: a.ck });
    assert.strictEqual((await get(t.gw.port, b.host, '/_work/data/v1/k', { headers: b.ck })).status, 404);
  } finally { t.close(); }
});

test('替代更新機制：重建後綁定新版本，重新整理即得新內容（不依賴 WebSocket／HMR）', async () => {
  const t = await setup('host');
  try {
    const p = await t.open(goodFiles('v1'));
    assert.match((await get(t.gw.port, p.host, '/')).body, /v1/);
    t.gw.bind(p.preview_id, 2, ingestArtifact(goodFiles('v2')).files);
    const r = await get(t.gw.port, p.host, '/');
    assert.match(r.body, /v2/);
    assert.strictEqual(r.headers['x-artifact-version'], '2');
  } finally { t.close(); }
});

test('結構：閘道不持有上游、原始碼無任何出站連線呼叫', () => {
  const src = fs.readFileSync(path.join(__dirname, 'artifact-gateway.js'), 'utf8');
  assert.ok(!/\bhttps?\.request\b|\bhttps?\.get\b|\bnet\.connect\b|\bfetch\(/.test(src));
  const gw = new ArtifactGateway({ platform: {}, clock: {} });
  assert.ok(!Object.keys(gw).some((k) => /upstream|sandbox/i.test(k)));
});
