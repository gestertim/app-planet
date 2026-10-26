'use strict';
// B2 grant 更新／單作品撤銷／到期／逐請求檢查（本機確定性時鐘；合成資料；不含供應商推送機制與延遲）
// 執行：node --test b/b2-renewal.test.js
const test = require('node:test');
const assert = require('node:assert');
const { Clock } = require('../lib/util');
const { DataPlatform } = require('./platform-data');

const HOUR = 3600_000;
function setup(opts) {
  const clock = new Clock();
  const p = new DataPlatform(clock, opts);
  p.addWork('w1', { school: 'S1' });
  p.addWork('w2', { school: 'S1' });
  return { clock, p };
}
const call = (p, id, grant, method = 'GET', key = 'feed', body = '') =>
  p.handle({ method, id, key, body, ts: '0', nonce: 'x', auth: { scheme: 'grant', grant } }).status;

test('更新：新 grant 生效；舊 grant 不因更新而被撤銷（至自身 exp）；edge 無法自行更新或延長', () => {
  const { clock, p } = setup();
  const old = p.mintGrant('w1', { ttlMs: 6 * HOUR });
  clock.advance(5 * HOUR); // 接近到期，平台重簽
  const fresh = p.mintGrant('w1', { ttlMs: 6 * HOUR });
  assert.deepStrictEqual([call(p, 'w1', old), call(p, 'w1', fresh)], [200, 200], '更新不撤銷舊 grant（撤銷只能靠 epoch／kid／下架）');
  clock.advance(1 * HOUR + 1);
  assert.deepStrictEqual([call(p, 'w1', old), call(p, 'w1', fresh)], [401, 200], '舊 grant 於自身 exp 失效，新者持續');
  // edge 竄改 exp 以自行延長
  const [c, s] = fresh.split('.');
  const claims = JSON.parse(Buffer.from(c, 'base64url').toString());
  claims.exp += 1000 * HOUR;
  const forged = `${Buffer.from(JSON.stringify(claims)).toString('base64url')}.${s}`;
  assert.strictEqual(call(p, 'w1', forged), 401, '竄改 exp＝簽章失敗');
  // edge 持舊 grant 逾時後重放
  clock.advance(10 * HOUR);
  assert.strictEqual(call(p, 'w1', fresh), 401, '平台停止更新（推送失敗）＝fail-closed：作品資料中斷，直到平台恢復推送');
});

test('單作品撤銷：epoch 遞增後舊 grant 立即失效（同一時刻＝0ms）；他作品不受影響；重簽後恢復', () => {
  const { clock, p } = setup();
  const g1 = p.mintGrant('w1');
  const g2 = p.mintGrant('w2');
  assert.deepStrictEqual([call(p, 'w1', g1), call(p, 'w2', g2)], [200, 200]);
  p.bumpEpoch('w1');
  assert.deepStrictEqual([call(p, 'w1', g1), call(p, 'w2', g2)], [401, 200], '同一時鐘刻度即失效；他作品不受影響');
  const g1b = p.mintGrant('w1');
  assert.deepStrictEqual([call(p, 'w1', g1), call(p, 'w1', g1b)], [401, 200], '更新後的新 epoch grant 生效，舊者仍失效');
  clock.advance(1);
  assert.strictEqual(call(p, 'w1', g1), 401);
});

test('到期：逾 exp 的 grant 一律 401；預覽 grant 不得超過會話到期', () => {
  const { clock, p } = setup();
  p.addWork('pv', { school: 'S1', kind: 'preview', state: 'active' });
  const sessionExp = clock.now() + 30 * 60_000;
  const g = p.mintGrant('pv', { ttlMs: sessionExp - clock.now() }); // 平台簽發時以會話剩餘時間為上限
  assert.strictEqual(call(p, 'pv', g, 'PUT', 'k', 'v'), 200);
  clock.advance(30 * 60_000);
  assert.strictEqual(call(p, 'pv', g), 401, '會話到期當下 grant 同時失效');
  const late = p.mintGrant('pv', { ttlMs: 24 * HOUR }); // 若平台誤簽長效預覽 grant
  p.works.get('pv').state = 'expired'; // 平台狀態已到期
  assert.strictEqual(call(p, 'pv', late), 410, '即使 grant 簽章與 exp 有效，平台逐請求查會話狀態仍拒絕');
});

test('逐請求平台端檢查：grant 有效仍受 live／配額／限流／格式／ops 約束', () => {
  const { p } = setup({ ratePerMin: 3, quotaBytes: 20 });
  const g = p.mintGrant('w1');
  const ro = p.mintGrant('w1', { ops: ['read'] });
  p.works.get('w1').state = 'down';
  assert.strictEqual(call(p, 'w1', g), 410, '下架：不經 edge 快取、立即 410');
  p.works.get('w1').state = 'live';
  assert.strictEqual(call(p, 'w1', g, 'GET', '../x'), 400, '非法 key');
  assert.strictEqual(call(p, 'W1!', g), 400, '非法作品識別字');
  assert.strictEqual(call(p, 'w1', ro, 'PUT', 'k', 'v'), 403, '超出 ops');
  assert.strictEqual(call(p, 'w1', g, 'PUT', 'k', 'x'.repeat(50)), 413, '配額');
  const codes = [1, 2, 3, 4].map(() => call(p, 'w1', g));
  assert.deepStrictEqual(codes.slice(-1), [429], '持有效 grant 仍被每作品限流');
});

test('B2 不縮小入侵範圍（誠實對照）：edge 持有所有 live 作品 grant 時，可觸及集合＝全部 live 作品', () => {
  const { p } = setup();
  p.addWork('w3', { school: 'S2' });
  const grants = Object.fromEntries(['w1', 'w2', 'w3'].map((id) => [id, p.mintGrant(id)]));
  const reach = Object.entries(grants).map(([id, g]) => call(p, id, g));
  assert.deepStrictEqual(reach, [200, 200, 200], '跨校亦然：B2 無分片，故集合與 B0 相同');
});
