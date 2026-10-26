'use strict';
// 執行：node --test b/b.test.js
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const { Clock, hmac } = require('../lib/util');
const { DataPlatform, buildRequest } = require('./platform-data');

// 合成世界：S1 校有 w1、w2、（已下架）w4 與預覽 p1；S2 校有 w3
function world(opts) {
  const clock = new Clock();
  const p = new DataPlatform(clock, opts);
  p.addWork('w1', { school: 'S1' });
  p.addWork('w2', { school: 'S1' });
  p.addWork('w3', { school: 'S2' });
  p.addWork('w4', { school: 'S1' });
  p.addWork('p1xxxxxxxxxxxxxxxxxxxxxxxx', { school: 'S1', kind: 'preview', state: 'active' });
  const m = {
    global: { scheme: 'global', kid: 'k1', secret: p.globalKeys.get('k1').secret },
    masterDerived: { scheme: 'derived', kid: '-', master: p.derivedMaster, epoch: 1 },
    workDerived: { scheme: 'derived', kid: '-', workKeys: { w1: p.derivedKey('w1') } },
    school: { scheme: 'school', kid: 'S1:1', secret: p.schoolKey('S1', '1') },
    grants: { scheme: 'grant', grants: {} },
  };
  for (const id of ['w1', 'w2', 'w3', 'w4', 'p1xxxxxxxxxxxxxxxxxxxxxxxx']) m.grants.grants[id] = p.mintGrant(id);
  p.takeDown('w4'); // 下架：epoch 遞增、state=down；edge 手上仍留有舊 grant
  return { clock, p, m };
}

const P1 = 'p1xxxxxxxxxxxxxxxxxxxxxxxx';
const CELLS = [['GET', 'w1'], ['GET', 'w2'], ['GET', 'w3'], ['GET', 'w4'], ['PUT', 'w1'], ['PUT', 'w3'], ['DELETE', 'w1'], ['DELETE', 'w3'], ['GET', P1]];
const HEAD = 'R:w1 R:w2 R:w3 R:w4(下架) W:w1 W:w3 D:w1 D:w3 R:p1';

// 攻擊者：auth＝其手上材料；knowsPreview＝是否知道 p1 的 preview_id；captured＝只握有一個已簽名請求
const attackers = (m, p, clock) => [
  { n: 'B0 現行｜works-edge 遭入侵', auth: m.global, kp: true, exp: '✔✔✔✖✔✔✔✔✔' },
  { n: 'B0 現行｜單一金鑰外洩', auth: m.global, kp: false, exp: '✔✔✔✖✔✔✔✔·' },
  { n: 'B0 現行｜單一已簽名請求外洩（重放）', captured: true, kp: false, exp: '✔✖✖✖✖✖✖✖·' },
  { n: 'B1 衍生金鑰（主金鑰在 edge）｜works-edge 遭入侵', auth: m.masterDerived, kp: true, exp: '✔✔✔✖✔✔✔✔✔' },
  { n: 'B1｜主金鑰外洩', auth: m.masterDerived, kp: false, exp: '✔✔✔✖✔✔✔✔·' },
  { n: 'B1｜單一作品衍生金鑰外洩（w1）', auth: m.workDerived, kp: false, exp: '✔✖✖✖✔✖✔✖·' },
  { n: 'B2 每作品 grant｜works-edge 遭入侵（持有全部 grant）', auth: m.grants, kp: true, exp: '✔✔✔✖✔✔✔✔✔' },
  { n: 'B2｜平台簽署私鑰外洩（＝平台層事故）', forgeWithPriv: true, kp: false, exp: '✔✔✔✖✔✔✔✔·' },
  { n: 'B2｜單一作品 grant 外洩（w1）', auth: { scheme: 'grant', grants: { w1: m.grants.grants.w1 } }, kp: false, exp: '✔✖✖✖✔✖✔✖·' },
  { n: 'B3 每校金鑰（S1 分片）｜該分片 edge 遭入侵', auth: m.school, kp: true, exp: '✔✔✖✖✔✖✔✖✔' },
  { n: 'B3｜S1 校金鑰外洩', auth: m.school, kp: false, exp: '✔✔✖✖✔✖✔✖·' },
];

function attempt(a, p, [method, id]) {
  if (id === P1 && !a.kp) return '·';
  let req;
  if (a.captured) {
    if (a.cap === undefined) throw new Error('no capture');
    return method === 'GET' && id === 'w1' ? sym(p.handle(a.cap)) : '✖';
  }
  if (a.forgeWithPriv) {
    const w = p.works.get(id);
    const g = p.mintGrantWithPrivateKey(p.grantPriv, { kid: 'g1', id, ops: ['read', 'write', 'delete'], epoch: w.epoch, exp: p.clock.now() + 3600_000 });
    req = { method, id, key: 'feed', body: method === 'PUT' ? 'x' : '', ts: String(p.clock.now()), nonce: 'f', auth: { scheme: 'grant', grant: g } };
  } else {
    req = buildRequest(p, a.auth, { method, id, body: method === 'PUT' ? 'x' : '' });
  }
  return sym(p.handle(req));
}
const sym = (r) => (r.status === 200 ? '✔' : '✖');

test('B 攻擊面矩陣：預期 vs 實際（每格使用全新合成世界）', () => {
  const rows = [];
  const names = attackers(world().m, null, null).map((a) => a.n);
  names.forEach((n, i) => {
    const cells = CELLS.map((c) => {
      const w = world();
      const a = attackers(w.m, w.p, w.clock)[i];
      if (a.captured) a.cap = buildRequest(w.p, w.m.global, { method: 'GET', id: 'w1' });
      return attempt(a, w.p, c);
    }).join('');
    const exp = attackers(world().m)[i].exp;
    rows.push({ n, exp, act: cells });
  });
  console.log(`\n  欄位：${HEAD}\n  （✔＝可成功；✖＝被平台拒絕；·＝攻擊者不知該 preview_id，無從嘗試）`);
  rows.forEach((r) => console.log(`  ${r.act === r.exp ? 'OK ' : 'DIFF'} ${r.act}（預期 ${r.exp}）  ${r.n}`));
  rows.forEach((r) => assert.strictEqual(r.act, r.exp, r.n));
});

test('B 入侵結束後的殘存能力：B0 金鑰持續有效；B2 grant 逾時失效；入侵後新建作品', () => {
  const w = world();
  const edgeSnapshot = { global: { ...w.m.global }, grants: { ...w.m.grants } }; // 入侵期間外帶的材料
  w.p.addWork('w5', { school: 'S1' }); // 入侵結束後才建立
  w.p.works.get('w5').epoch = 1;
  w.clock.advance(25 * 3600_000); // 25 小時後（grant TTL 24h）
  const b0Old = w.p.handle(buildRequest(w.p, edgeSnapshot.global, { method: 'GET', id: 'w1' })).status;
  const b0New = w.p.handle(buildRequest(w.p, edgeSnapshot.global, { method: 'GET', id: 'w5' })).status;
  const b2Old = w.p.handle(buildRequest(w.p, edgeSnapshot.grants, { method: 'GET', id: 'w1' })).status;
  const b2New = w.p.handle(buildRequest(w.p, edgeSnapshot.grants, { method: 'GET', id: 'w5' })).status;
  console.log(`  25h 後：B0 舊作品=${b0Old} 新作品=${b0New}；B2 舊作品=${b2Old} 新作品=${b2New}`);
  assert.deepStrictEqual([b0Old, b0New, b2Old, b2New], [200, 200, 401, 401]);
});

test('平台端獨立檢查（共通）：竄改、過期時間戳、重放、非法識別字、非 live、配額、限流', () => {
  const schemes = { global: (w) => w.m.global, derived: (w) => w.m.masterDerived, school: (w) => w.m.school };
  for (const [name, pick] of Object.entries(schemes)) {
    const w = world({ ratePerMin: 5, quotaBytes: 60 });
    const a = pick(w);
    const ok = buildRequest(w.p, a, { method: 'PUT', id: 'w1', body: 'abc' });
    assert.strictEqual(w.p.handle({ ...ok, body: 'tampered' }).status, 401, `${name} 竄改 Body`);
    assert.strictEqual(w.p.handle(ok).status, 200, `${name} 正常`);
    assert.strictEqual(w.p.handle(ok).status, 401, `${name} 重放`);
    const old = buildRequest(w.p, a, { method: 'GET', id: 'w1' });
    w.clock.advance(61_000);
    assert.strictEqual(w.p.handle(old).status, 401, `${name} 過期時間戳`);
    assert.strictEqual(w.p.handle(buildRequest(w.p, a, { method: 'GET', id: '../w2' })).status, 400, `${name} 路徑穿越字元`);
    assert.strictEqual(w.p.handle(buildRequest(w.p, a, { method: 'PUT', id: 'w1', key: 'big', body: 'x'.repeat(100) })).status, 413, `${name} 配額`);
    const w2 = world({ ratePerMin: 5 });
    const a2 = pick(w2);
    const codes = Array.from({ length: 7 }, () => w2.p.handle(buildRequest(w2.p, a2, { method: 'GET', id: 'w2' })).status);
    assert.deepStrictEqual(codes, [200, 200, 200, 200, 200, 429, 429], `${name} 平台端獨立限流（持金鑰也不能無限讀寫單一作品）`);
    const w3 = world();
    const a3 = pick(w3);
    assert.strictEqual(w3.p.handle(buildRequest(w3.p, a3, { method: 'GET', id: 'w2' })).status, 200);
    w3.p.works.get('w2').state = 'down';
    assert.strictEqual(w3.p.handle(buildRequest(w3.p, a3, { method: 'GET', id: 'w2' })).status, 410, `${name} 下架立即生效（不經 edge 快取）`);
  }
});

test('B2 grant：範圍、跨作品、逾時、偽造簽章、未知 kid、竄改 claims', () => {
  const w = world();
  const g = w.m.grants.grants;
  const ro = w.p.mintGrant('w1', { ops: ['read'] });
  const get = (id, grant) => w.p.handle({ method: 'GET', id, key: 'feed', body: '', ts: '0', nonce: 'x', auth: { scheme: 'grant', grant } }).status;
  const put = (id, grant) => w.p.handle({ method: 'PUT', id, key: 'feed', body: 'v', ts: '0', nonce: 'x', auth: { scheme: 'grant', grant } }).status;
  assert.strictEqual(get('w1', ro), 200);
  assert.strictEqual(put('w1', ro), 403, '唯讀 grant 不可寫');
  assert.strictEqual(get('w2', g.w1), 403, 'w1 的 grant 不可讀 w2');
  const attackerKey = crypto.generateKeyPairSync('ed25519').privateKey;
  const forged = w.p.mintGrantWithPrivateKey(attackerKey, { kid: 'g1', id: 'w1', ops: ['read', 'write', 'delete'], epoch: 1, exp: w.clock.now() + 1e9 });
  assert.strictEqual(get('w1', forged), 401, '非平台私鑰簽署');
  const [c, s] = g.w1.split('.');
  const tampered = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(c, 'base64url')), id: 'w3' })).toString('base64url') + '.' + s;
  assert.strictEqual(get('w3', tampered), 401, '竄改 claims（改成 w3）');
  const unknownKid = w.p.mintGrantWithPrivateKey(w.p.grantPriv, { kid: 'gX', id: 'w1', ops: ['read'], epoch: 1, exp: w.clock.now() + 1000 });
  assert.strictEqual(get('w1', unknownKid), 401, '未知 kid');
  w.clock.advance(25 * 3600_000);
  assert.strictEqual(get('w1', g.w1), 401, '逾時');
});

test('輪替與撤銷：各方案能做到什麼', () => {
  // B0：雙金鑰重疊、之後退役；無法只撤銷單一作品的憑證（只能整體輪替或下架）
  let w = world();
  const old = { ...w.m.global };
  w.p.globalKeys.set('k2', { secret: crypto.randomBytes(32), status: 'active' });
  const neu = { scheme: 'global', kid: 'k2', secret: w.p.globalKeys.get('k2').secret };
  const getB0 = (a, id) => w.p.handle(buildRequest(w.p, a, { method: 'GET', id })).status;
  assert.deepStrictEqual([getB0(old, 'w1'), getB0(neu, 'w1')], [200, 200], 'B0 重疊期新舊皆可');
  w.p.globalKeys.get('k1').status = 'retired';
  assert.deepStrictEqual([getB0(old, 'w1'), getB0(neu, 'w1')], [401, 200], 'B0 退役後舊金鑰失效（但所有作品同時受影響）');

  // B1：epoch 遞增撤銷單一作品衍生金鑰；但握有主金鑰者可再算出新 epoch 的金鑰
  w = world();
  const stolen = { scheme: 'derived', kid: '-', workKeys: { w1: w.p.derivedKey('w1') } };
  w.p.bumpEpoch('w1');
  assert.strictEqual(w.p.handle(buildRequest(w.p, stolen, { method: 'GET', id: 'w1' })).status, 401, 'B1 單一衍生金鑰在 epoch 遞增後失效');
  const hit = [1, 2, 3, 4, 5].map((e) => w.p.handle(buildRequest(w.p, { ...w.m.masterDerived, epoch: e }, { method: 'GET', id: 'w1' })).status);
  console.log(`  B1 主金鑰持有者嘗試 epoch 1..5：${hit.join(',')}（含 200＝撤銷被繞過）`);
  assert.ok(hit.includes(200), 'B1：主金鑰仍在 edge，撤銷被繞過');

  // B2：epoch 遞增撤銷單一作品；簽署 kid 輪替撤銷全部舊 grant；edge 無法自行簽發新 grant
  w = world();
  const g = w.m.grants.grants;
  const getG = (id, grant) => w.p.handle({ method: 'GET', id, key: 'feed', body: '', ts: '0', nonce: 'x', auth: { scheme: 'grant', grant } }).status;
  w.p.bumpEpoch('w1');
  assert.deepStrictEqual([getG('w1', g.w1), getG('w2', g.w2)], [401, 200], 'B2 單一作品撤銷不影響他作品');
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  w.p.grantKeys.set('g2', { pub: publicKey, status: 'active' });
  w.p.grantKeys.get('g1').status = 'retired';
  const fresh = w.p.mintGrantWithPrivateKey(privateKey, { kid: 'g2', id: 'w2', ops: ['read'], epoch: 1, exp: w.clock.now() + 1000 });
  assert.deepStrictEqual([getG('w2', g.w2), getG('w2', fresh)], [401, 200], 'B2 kid 輪替：舊 grant 全失效、新 kid 生效');

  // B3：退役 S1 校金鑰不影響 S2
  w = world();
  const s2 = { scheme: 'school', kid: 'S2:1', secret: w.p.schoolKey('S2', '1') };
  w.p.schoolRetired.add('S1:1');
  assert.deepStrictEqual(
    [w.p.handle(buildRequest(w.p, w.m.school, { method: 'GET', id: 'w1' })).status, w.p.handle(buildRequest(w.p, s2, { method: 'GET', id: 'w3' })).status],
    [401, 200], 'B3 只影響該校');
  void hmac;
});
