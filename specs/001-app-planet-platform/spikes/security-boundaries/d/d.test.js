'use strict';
// β2 候選 M（管理通道逐次呼叫）Spike（合成資料；非產品程式）。執行：node --test d/d.test.js
// 範圍：只驗證「呼叫契約與平台側檢查」。本機子行程不是 microVM：不證明隔離強度、出站封鎖、延遲、費用或供應商行為。
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { Clock } = require('../lib/util');
const { DataPlatform } = require('../b/platform-data');
const { FnInvoker, FnEdge, LocalChannel } = require('./fn-invoker');

process.env.SPIKE_ADMIN_TOKEN = 'synthetic-admin-token-not-a-secret'; // 平台側才有；用來檢查不會流進處理程式環境

const SPEC = (argv, extra = {}) => ({ argv, reads: ['counter'], writes: ['counter', 'note'], timeoutMs: 1500, maxOutputBytes: 64 * 1024, memMb: 64, ...extra });
const manifest = () => ({ fns: { count: SPEC(['echo.js']), evil: SPEC(['evil.js']), probe: SPEC(['evil.js']) } });

function world({ limits, naive, gateOpen } = {}) {
  const clock = new Clock();
  const platform = new DataPlatform(clock, { ratePerMin: 10_000, quotaBytes: 200 });
  platform.addWork('w1', { school: 'S1', data: { counter: '0' } });
  platform.addWork('w2', { school: 'S1', data: { counter: '100', secret: 'w2-only' } });
  const channel = new LocalChannel({ adminToken: process.env.SPIKE_ADMIN_TOKEN });
  const invoker = new FnInvoker({ platform, clock, channel, limits, naive, gateOpen });
  invoker.register('w1', manifest());
  invoker.register('w2', manifest());
  return { clock, platform, channel, invoker, g1: invoker.mintInvokeGrant('w1'), g2: invoker.mintInvokeGrant('w2') };
}
const call = (w, { grant = w.g1, workId = 'w1', fn = 'count', body = '{}' } = {}) => w.invoker.invoke({ grant, workId, fn, body });
const j = (r) => JSON.parse(r.body);
const post = (port, host, p, body = '{}', headers = {}) => new Promise((resolve, reject) => {
  const r = http.request({ host: '127.0.0.1', port, path: p, method: 'POST', agent: false, headers: { host, ...headers } }, (res) => {
    const c = []; res.on('data', (d) => c.push(d));
    res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(c).toString() }));
  });
  r.on('error', reject); r.end(body);
});
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (_) { return false; } };

test('功能：訪客 → edge → 平台側 invoker → 處理程式；資料經 Work Data API 持久；回應標頭由 edge 決定', async () => {
  const w = world();
  const edge = await new FnEdge({ invoker: w.invoker, hosts: { 'a.works.test': { workId: 'w1', grant: w.g1 } } }).start();
  try {
    const r1 = await post(edge.port, 'a.works.test', '/_work/fn/v1/count', '{"name":"小明"}');
    assert.strictEqual(r1.status, 200);
    assert.deepStrictEqual(JSON.parse(r1.body), { echo: { name: '小明' }, counter: 1 });
    assert.strictEqual(JSON.parse((await post(edge.port, 'a.works.test', '/_work/fn/v1/count')).body).counter, 2);
    assert.strictEqual(r1.headers['cache-control'], 'no-store');
    assert.strictEqual(r1.headers['set-cookie'], undefined);
    assert.strictEqual((await post(edge.port, 'unknown.works.test', '/_work/fn/v1/count')).status, 404);
    assert.strictEqual((await post(edge.port, 'a.works.test', '/_work/fn/v1/a/b')).status, 404);
    assert.strictEqual((await post(edge.port, 'a.works.test', '/_work/fn/v1/count', 'x'.repeat(9000))).status, 413);
  } finally { edge.close(); }
});

test('訪客資料最小化：處理程式只收到 { request, data }，不含標頭、IP、cookie', async () => {
  const w = world();
  const edge = await new FnEdge({ invoker: w.invoker, hosts: { 'a.works.test': { workId: 'w1', grant: w.g1 } } }).start();
  try {
    const r = await post(edge.port, 'a.works.test', '/_work/fn/v1/evil', '{"mode":"keys"}', { cookie: 'sid=1', 'x-forwarded-for': '203.0.113.9', 'user-agent': 'synthetic' });
    assert.deepStrictEqual(JSON.parse(r.body), { top: ['request', 'data'], request: ['mode'] });
  } finally { edge.close(); }
});

test('身分與範圍：作品 A 的 grant 不能呼叫作品 B；缺 invoke、過期、竄改、epoch 遞增皆被拒', async () => {
  const w = world();
  assert.strictEqual((await call(w, { grant: w.g1, workId: 'w2' })).status, 403, '跨作品');
  assert.strictEqual((await call(w, { grant: w.invoker.mintInvokeGrant('w1', { ops: ['read'] }) })).status, 403, '缺 invoke');
  assert.strictEqual((await call(w, { grant: 'garbage' })).status, 401);
  const [c, s] = w.g1.split('.');
  const claims = JSON.parse(Buffer.from(c, 'base64url').toString());
  claims.exp += 10 * 3600_000;
  assert.strictEqual((await call(w, { grant: `${Buffer.from(JSON.stringify(claims)).toString('base64url')}.${s}` })).status, 401, 'edge 竄改 exp');
  assert.strictEqual((await call(w, { fn: 'nope' })).status, 404, '未宣告的函式');
  assert.strictEqual((await call(w)).status, 200);
  w.platform.bumpEpoch('w1');
  assert.strictEqual((await call(w)).status, 401, 'epoch 遞增後舊 grant 立即失效');
  const w2 = world();
  w2.clock.advance(7 * 3600_000);
  assert.strictEqual((await call(w2)).status, 401, '逾 exp');
});

test('命令不由訪客決定：manifest 固定 argv；naive 負對照下訪客可改跑別的程式', async () => {
  const safe = world();
  const r = j(await call(safe, { body: '{"argv":"evil.js","mode":"env"}' }));
  assert.strictEqual(r.counter, 1, '仍執行 echo.js');
  const naive = world({ naive: true });
  const bad = j(await call(naive, { body: '{"argv":"evil.js","mode":"env"}' }));
  assert.ok(bad.env && !bad.counter, '負對照：訪客改跑 evil.js');
});

test('金鑰與資料隔離：處理程式環境不含平台側憑證；跨作品與未宣告鍵的寫入被拒且不落地', async () => {
  const w = world();
  assert.ok(process.env.SPIKE_ADMIN_TOKEN, '前提：平台側行程確有此值');
  const env = j(await call(w, { fn: 'probe', body: '{"mode":"env"}' }));
  assert.strictEqual(env.has_admin, false);
  assert.strictEqual(env.leaked, false, '任何環境值都不含平台側憑證');
  assert.ok(!env.env.some((k) => /TOKEN|KEY|SECRET|SPIKE/i.test(k)), '環境鍵名不含憑證類名稱（Windows 會自動補 PATH 等系統變數，與憑證無關）');
  assert.strictEqual(env.cwd, 'handlers');
  assert.strictEqual((await call(w, { fn: 'evil', body: '{"mode":"foreignkey"}' })).status, 502);
  assert.strictEqual((await call(w, { fn: 'evil', body: '{"mode":"undeclaredkey"}' })).status, 502);
  assert.strictEqual(w.platform.works.get('w2').data.get('secret'), 'w2-only');
  assert.strictEqual(w.platform.works.get('w1').data.has('other'), false);
  // 讀取只含 manifest 宣告的鍵（w1 不能讀 w2 的資料）
  assert.deepStrictEqual(j(await call(w, { fn: 'evil', body: '{"mode":"keys"}' })).top, ['request', 'data']);
});

test('輸出被當作不受信任資料：非 JSON、非法狀態碼、學生指定標頭一律不採用；超額寫入全有或全無', async () => {
  const w = world();
  assert.strictEqual((await call(w, { fn: 'evil', body: '{"mode":"notjson"}' })).status, 502);
  assert.strictEqual((await call(w, { fn: 'evil', body: '{"mode":"badstatus"}' })).status, 502);
  const edge = await new FnEdge({ invoker: w.invoker, hosts: { 'a.works.test': { workId: 'w1', grant: w.g1 } } }).start();
  try {
    const r = await post(edge.port, 'a.works.test', '/_work/fn/v1/evil', '{"mode":"headers"}');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.headers['set-cookie'], undefined);
    assert.strictEqual(r.headers['content-security-policy'], undefined);
  } finally { edge.close(); }
  const before = w.platform.works.get('w1').data.get('counter');
  assert.strictEqual((await call(w, { fn: 'evil', body: '{"mode":"bigwrite"}' })).status, 413);
  assert.strictEqual(w.platform.works.get('w1').data.get('counter'), before, '部分寫入已還原');
  assert.strictEqual(w.platform.works.get('w1').data.has('note'), false);
});

test('限制：逾時、輸出上限、記憶體上限皆被強制，且處理程式行程確已結束', async () => {
  const w = world();
  const loop = w.channel.run({ argv: ['evil.js'], stdin: '{"request":{"mode":"loop"}}', timeoutMs: 300, maxOutputBytes: 1000 });
  const lr = await loop.done;
  assert.ok(lr.timedOut && !alive(loop.pid), '無窮迴圈被終止');
  const flood = w.channel.run({ argv: ['evil.js'], stdin: '{"request":{"mode":"flood"}}', timeoutMs: 3000, maxOutputBytes: 1000 });
  const fr = await flood.done;
  assert.ok(fr.truncated && !alive(flood.pid), '輸出爆量被終止');
  assert.strictEqual((await call(w, { fn: 'evil', body: '{"mode":"loop"}' })).status, 504);
  assert.strictEqual((await call(w, { fn: 'evil', body: '{"mode":"flood"}' })).status, 502);
  const mem = await call(w, { fn: 'evil', body: '{"mode":"memory"}' });
  assert.ok([502, 504].includes(mem.status), `記憶體耗盡 → ${mem.status}`);
});

test('限流與並行：每作品速率、每作品並行、全域並行皆有硬上限', async () => {
  const a = world({ limits: { ratePerMin: 3 } });
  const codes = []; for (let i = 0; i < 4; i++) codes.push((await call(a)).status);
  assert.deepStrictEqual(codes, [200, 200, 200, 429]);
  a.clock.advance(61_000);
  assert.strictEqual((await call(a)).status, 200, '視窗過後恢復');

  const b = world({ limits: { perWorkConcurrency: 2, globalConcurrency: 3 } });
  const slow = (workId, grant) => call(b, { workId, grant, fn: 'evil', body: '{"mode":"slow"}' });
  const three = await Promise.all([slow('w1', b.g1), slow('w1', b.g1), slow('w1', b.g1)]);
  assert.deepStrictEqual(three.map((r) => r.status).sort(), [200, 200, 429], '每作品並行 2');
  const mixed = await Promise.all([slow('w1', b.g1), slow('w1', b.g1), slow('w2', b.g2), slow('w2', b.g2)]);
  assert.deepStrictEqual(mixed.map((r) => r.status).sort(), [200, 200, 200, 503], '全域並行 3');
});

test('停用／下架／撤銷：新請求立即拒絕；在途請求被終止且結果不回傳、不套用', async () => {
  const w = world();
  assert.strictEqual((await call(w)).status, 200);
  const inflight = call(w, { fn: 'evil', body: '{"mode":"slow"}' });
  await new Promise((r) => setTimeout(r, 120));
  const t0 = Date.now();
  w.invoker.revoke('w1');
  const r = await inflight;
  assert.strictEqual(r.status, 410);
  assert.ok(Date.now() - t0 < 300, `在途呼叫於撤銷後 ${Date.now() - t0} ms 結束（遠小於 slow 的 400 ms 自然結束）`);
  assert.strictEqual((await call(w)).status, 401, '舊 grant：epoch 已遞增，立即失效（無 TTL）');
  assert.strictEqual((await call(w, { grant: w.invoker.mintInvokeGrant('w1') })).status, 410, '即使重簽新 grant，live 檢查仍拒絕');
  assert.strictEqual(w.platform.works.get('w1').data.get('counter'), '1', '撤銷後無新寫入');
  assert.strictEqual((await call(world({ gateOpen: false }))).status, 503, 'restricted_runtime_gate 未開 → fail-closed');
  const nomf = world(); nomf.invoker.manifests.delete('w1');
  assert.strictEqual((await call(nomf)).status, 503, '無 runtime profile → fail-closed');
});

test('結構：invoker 無出站連線程式碼、沙箱 ports 為空、edge 不持有簽署金鑰或管理憑證', () => {
  const src = fs.readFileSync(path.join(__dirname, 'fn-invoker.js'), 'utf8');
  assert.ok(!/http\.request|http\.get|https\.request|fetch\(|net\.connect|net\.createConnection/.test(src), '無出站連線呼叫');
  const w = world();
  assert.deepStrictEqual(w.channel.ports, []);
  const edge = new FnEdge({ invoker: w.invoker, hosts: { 'a.works.test': { workId: 'w1', grant: w.g1 } } });
  const keys = Object.keys(edge); // 'invoker' 為平台側元件的參照；實際部署中 edge 與 invoker 為不同服務
  assert.deepStrictEqual(keys.sort(), ['hosts', 'invoker']);
  assert.deepStrictEqual(Object.keys(edge.hosts['a.works.test']).sort(), ['grant', 'workId']);
});

test('量測（本機子行程下界；非供應商、無閾值判定）：30 次連續呼叫的耗時分佈', async () => {
  const w = world({ limits: { ratePerMin: 1000 } });
  const ms = [];
  for (let i = 0; i < 30; i++) { const t = process.hrtime.bigint(); const r = await call(w); ms.push(Number(process.hrtime.bigint() - t) / 1e6); assert.strictEqual(r.status, 200); }
  ms.sort((a, b) => a - b);
  const pick = (p) => ms[Math.min(ms.length - 1, Math.ceil(p * ms.length) - 1)];
  const out = { n: ms.length, p50_ms: +pick(0.5).toFixed(1), p95_ms: +pick(0.95).toFixed(1), max_ms: +ms[ms.length - 1].toFixed(1), node: process.version, platform: process.platform,
    note: '本機 Node 子行程啟動＋JSON 往返的下界；不含網路、管理 API、沙箱建立或恢復' };
  fs.mkdirSync(path.join(__dirname, '..', 'results'), { recursive: true });
  fs.writeFileSync(path.join(__dirname, '..', 'results', 'fn-local-latency.json'), JSON.stringify(out, null, 2));
  console.log('local latency', JSON.stringify(out));
});
