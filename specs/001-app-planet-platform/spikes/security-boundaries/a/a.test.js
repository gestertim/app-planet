'use strict';
// 任務 A Spike：以合成預覽會話比較「主機名即憑證（host）」與「主機名＋分區 cookie 逐請求驗證（cookie）」
// 執行：node --test a/a.test.js
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const crypto = require('crypto');
const { Clock, sha256 } = require('../lib/util');
const ws = require('../lib/ws-mini');
const { createSandbox } = require('./sandbox-sim');
const { PreviewPlatform } = require('./platform-preview');
const { PreviewEdge, FORBIDDEN_BODY } = require('./edge-preview');

function request(edge, id, path, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port: edge.port, path, method, headers: { host: `${id}.preview.test`, ...headers } }, (res) => {
      const c = []; res.on('data', (d) => c.push(d));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(c).toString() }));
    });
    r.on('error', reject); r.end(body);
  });
}

async function setup(mode, { stateTtlMs = 15_000, sandboxToken = null } = {}) {
  const clock = new Clock();
  const platform = new PreviewPlatform(clock);
  const sandbox = await createSandbox({ requireToken: sandboxToken });
  const edge = await new PreviewEdge({ platform, clock, mode, stateTtlMs, upstream: { port: sandbox.port }, upstreamToken: sandboxToken }).start();
  // 「瀏覽器」：經一次性權杖兌換取得 cookie（若有）
  const open = async () => {
    const s = platform.issue();
    const r = await request(edge, s.preview_id, `/_work/preview/redeem?t=${s.token}`);
    const m = /pv=([^;]+)/.exec(r.headers['set-cookie'] || '');
    return { ...s, redeem: r, cookie: m && m[1], ck: m ? { cookie: `pv=${m[1]}` } : {} };
  };
  const close = () => { edge.close(); sandbox.close(); };
  return { clock, platform, sandbox, edge, open, close };
}

for (const mode of ['host', 'cookie']) {
  test(`[${mode}] 授權用戶：HTML、子資源、資料 API、重新整理、WebSocket 皆可用`, async () => {
    const t = await setup(mode);
    try {
      const p = await t.open();
      assert.strictEqual(p.redeem.status, 302);
      assert.strictEqual(p.redeem.headers.location, '/');
      assert.ok(!/t=/.test(p.redeem.headers.location), '網址不含權杖');
      for (const path of ['/', '/app.js', '/']) { // 第三次＝重新整理
        const r = await request(t.edge, p.preview_id, path, { headers: p.ck });
        assert.strictEqual(r.status, 200, path);
      }
      assert.strictEqual((await request(t.edge, p.preview_id, '/_work/data/v1/k1', { method: 'PUT', body: 'v1', headers: p.ck })).status, 200);
      assert.strictEqual((await request(t.edge, p.preview_id, '/_work/data/v1/k1', { headers: p.ck })).body, 'v1');
      const w = await ws.connect({ port: t.edge.port, host: `${p.preview_id}.preview.test`, headers: p.ck });
      assert.strictEqual(w.status, 101);
      w.send('hi');
      assert.strictEqual(await w.next(), 'echo:hi');
      w.socket.destroy();
      // 安全標頭與 cookie/Authorization 不轉送給沙箱程式
      const r = await request(t.edge, p.preview_id, '/', { headers: { ...p.ck, authorization: 'Bearer x' } });
      assert.strictEqual(r.headers['cache-control'], 'no-store');
      assert.strictEqual(r.headers['referrer-policy'], 'no-referrer');
      assert.match(r.headers['content-security-policy'], /frame-ancestors https:\/\/app\.platform\.test/);
      assert.ok(t.sandbox.hits.every((h) => !h.cookie && !h.authorization), '沙箱端看不到 cookie／Authorization');
    } finally { t.close(); }
  });

  test(`[${mode}] 未授權：未知、未兌換、權杖重用、逾時、錯綁皆為不可區分的 403`, async () => {
    const t = await setup(mode);
    try {
      const bodies = new Set();
      const statuses = new Set();
      const note = (r) => { bodies.add(sha256(r.body)); statuses.add(r.status); };
      note(await request(t.edge, 'a'.repeat(26), '/'));                       // 未知
      const issued = t.platform.issue();
      note(await request(t.edge, issued.preview_id, '/'));                    // 已簽發未兌換
      note(await request(t.edge, issued.preview_id, '/_work/preview/redeem?t=wrong')); // 錯權杖
      const other = t.platform.issue();
      note(await request(t.edge, issued.preview_id, `/_work/preview/redeem?t=${other.token}`)); // 錯綁
      const ok = await request(t.edge, issued.preview_id, `/_work/preview/redeem?t=${issued.token}`);
      assert.strictEqual(ok.status, 302);
      note(await request(t.edge, issued.preview_id, `/_work/preview/redeem?t=${issued.token}`)); // 重用
      const late = t.platform.issue();
      t.clock.advance(61_000);
      note(await request(t.edge, late.preview_id, `/_work/preview/redeem?t=${late.token}`)); // 權杖逾時
      assert.deepStrictEqual([...statuses], [403]);
      assert.strictEqual(bodies.size, 1, '所有拒絕回應內容相同');
      assert.strictEqual([...bodies][0], sha256(FORBIDDEN_BODY));
      // 日誌不含明文 preview_id 與權杖
      const logText = JSON.stringify(t.edge.log);
      assert.ok(!logText.includes(issued.preview_id) && !logText.includes(issued.token));
    } finally { t.close(); }
  });

  test(`[${mode}] 預覽之間 origin 隔離：他人的主機名／cookie 讀不到我的資料`, async () => {
    const t = await setup(mode);
    try {
      const a = await t.open(); const b = await t.open();
      await request(t.edge, a.preview_id, '/_work/data/v1/secret', { method: 'PUT', body: 'A-only', headers: a.ck });
      const r1 = await request(t.edge, b.preview_id, '/_work/data/v1/secret', { headers: b.ck });
      assert.strictEqual(r1.status, 404, 'B 的資料集不含 A 的鍵');
      // 以 B 的 cookie 打 A 的主機名
      const r2 = await request(t.edge, a.preview_id, '/_work/data/v1/secret', { headers: b.ck });
      assert.strictEqual(r2.status, mode === 'cookie' ? 403 : 200, mode === 'cookie' ? 'cookie 綁定 preview_id' : 'host 模式不看 cookie');
    } finally { t.close(); }
  });

  test(`[${mode}] 主機名洩漏（無 cookie 的另一個用戶端）：實際後果`, async () => {
    const t = await setup(mode);
    try {
      const p = await t.open();
      await request(t.edge, p.preview_id, '/_work/data/v1/note', { method: 'PUT', body: 'synthetic-data', headers: p.ck });
      const leaked = {}; // 攻擊者只有主機名
      const exp = mode === 'host'
        ? { html: 200, js: 200, dataGet: 200, dataPut: 200, dataDel: 200, ws: 101 }
        : { html: 403, js: 403, dataGet: 403, dataPut: 403, dataDel: 403, ws: 403 };
      const act = {
        html: (await request(t.edge, p.preview_id, '/', { headers: leaked })).status,
        js: (await request(t.edge, p.preview_id, '/app.js')).status,
        dataGet: (await request(t.edge, p.preview_id, '/_work/data/v1/note')).status,
        dataPut: (await request(t.edge, p.preview_id, '/_work/data/v1/note', { method: 'PUT', body: 'overwritten-by-leaker' })).status,
        dataDel: (await request(t.edge, p.preview_id, '/_work/data/v1/note', { method: 'DELETE' })).status,
      };
      const w = await ws.connect({ port: t.edge.port, host: `${p.preview_id}.preview.test` });
      act.ws = w.status; if (w.socket) w.socket.destroy();
      console.log(`  [${mode}] 洩漏主機名 預期=${JSON.stringify(exp)} 實際=${JSON.stringify(act)}`);
      assert.deepStrictEqual(act, exp);
    } finally { t.close(); }
  });

  test(`[${mode}] 到期：新請求、資料 API、新 WebSocket 皆拒絕；既有 WebSocket 於 recheck 後關閉`, async () => {
    const t = await setup(mode, { stateTtlMs: 5_000 });
    try {
      const p = await t.open();
      const w = await ws.connect({ port: t.edge.port, host: `${p.preview_id}.preview.test`, headers: p.ck });
      assert.strictEqual(w.status, 101);
      t.clock.advance(31 * 60_000);
      assert.strictEqual((await request(t.edge, p.preview_id, '/', { headers: p.ck })).status, 403);
      assert.strictEqual((await request(t.edge, p.preview_id, '/_work/data/v1/k', { headers: p.ck })).status, 403);
      assert.strictEqual((await ws.connect({ port: t.edge.port, host: `${p.preview_id}.preview.test`, headers: p.ck })).status, 403);
      w.send('still-alive?');
      assert.strictEqual(await w.next(600), 'echo:still-alive?', '既有連線在 recheck 前仍存活（已知缺口）');
      t.edge.recheck();
      assert.strictEqual(await w.next(800), null, 'recheck 後既有連線被關閉');
    } finally { t.close(); }
  });

  test(`[${mode}] 撤銷：資料 API 立即；HTML 受快取 TTL 約束；子資源與 WebSocket 同 TTL／recheck`, async () => {
    const ttl = 10_000;
    const t = await setup(mode, { stateTtlMs: ttl });
    try {
      const p = await t.open();
      assert.strictEqual((await request(t.edge, p.preview_id, '/', { headers: p.ck })).status, 200); // 填快取
      t.platform.revoke(p.preview_id);
      const data = (await request(t.edge, p.preview_id, '/_work/data/v1/k', { headers: p.ck })).status;
      const stale = (await request(t.edge, p.preview_id, '/app.js', { headers: p.ck })).status;
      t.clock.advance(ttl - 1);
      const stillStale = (await request(t.edge, p.preview_id, '/', { headers: p.ck })).status;
      t.clock.advance(2);
      const after = (await request(t.edge, p.preview_id, '/', { headers: p.ck })).status;
      console.log(`  [${mode}] 撤銷後：資料API=${data}（預期403）；快取內 /app.js=${stale}、TTL-1ms=${stillStale}（預期200，＝撤銷上界）；TTL 後=${after}（預期403）`);
      assert.deepStrictEqual([data, stale, stillStale, after], [403, 200, 200, 403]);
    } finally { t.close(); }
  });
}

test('[cookie] 僅持有 cookie、主機名錯誤（偽造 Host）不得通過', async () => {
  const t = await setup('cookie');
  try {
    const a = await t.open();
    const fake = crypto.randomBytes(16).toString('hex').slice(0, 26).replace(/[01689]/g, 'a');
    const r = await request(t.edge, fake, '/', { headers: a.ck });
    assert.strictEqual(r.status, 403);
  } finally { t.close(); }
});

test('S-05 前提（模擬）：沙箱預覽埠若公開可達，edge 的所有控制可被繞過；上游權杖可阻擋', async () => {
  const open = await createSandbox({ requireToken: null });
  const guarded = await createSandbox({ requireToken: 'synthetic-upstream-secret' });
  try {
    const get = (port, headers = {}) => new Promise((res) => http.get({ host: '127.0.0.1', port, path: '/', headers }, (r) => { r.resume(); res(r.statusCode); }));
    assert.strictEqual(await get(open.port), 200, '公開位址：不經 edge、無任何憑證即可取得學生作品');
    assert.strictEqual(await get(guarded.port), 401, '上游權杖：直連被拒');
    assert.strictEqual(await get(guarded.port, { 'x-upstream-token': 'synthetic-upstream-secret' }), 200);
    console.log('  註：本測試只證明「若供應商位址公開可達則 edge 無效」的邏輯；供應商實際行為：未驗證（見 RESULTS.md）');
  } finally { open.close(); guarded.close(); }
});
