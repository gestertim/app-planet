'use strict';
// 任務 B Spike：平台端作品資料服務的「授權模型」模擬（合成作品；非產品程式、無資料庫）
// scheme：
//   global  ＝現行方案 B0：works-edge 持有單一資料 HMAC 金鑰
//   derived ＝B1：由主金鑰衍生每作品金鑰，但主金鑰仍在 works-edge（不算縮小）
//   school  ＝B3：每校一把金鑰，只交給該校的 edge 分片；主金鑰僅平台持有
//   grant   ＝B2：平台以 Ed25519 簽發每作品授權（grant）；works-edge 只持有 grant，不持有任何簽署能力
const crypto = require('crypto');
const { sha256, hmac, safeEq } = require('../lib/util');

const OPS = { GET: 'read', PUT: 'write', POST: 'write', DELETE: 'delete' };
const ID_RE = /^[a-z0-9-]{2,63}$/;
const KEY_RE = /^[a-z0-9_-]{1,32}$/;
const b64 = (x) => Buffer.from(x).toString('base64url');

const signingString = (r) => [r.method, r.id, r.key, sha256(r.body || ''), r.ts, r.nonce].join('\n');

class DataPlatform {
  constructor(clock, { tsWindowMs = 60_000, ratePerMin = 30, quotaBytes = 200 } = {}) {
    Object.assign(this, { clock, tsWindowMs, ratePerMin, quotaBytes });
    this.works = new Map();
    this.nonces = new Set();
    this.globalKeys = new Map(); // kid -> {secret, status}
    this.derivedMaster = crypto.randomBytes(32); // B1：與 edge 共享（刻意呈現其缺陷）
    this.schoolMaster = crypto.randomBytes(32); // B3：僅平台
    this.schoolRetired = new Set(); // 'S1:1'
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    this.grantPriv = privateKey; // 僅平台
    this.grantKeys = new Map([['g1', { pub: publicKey, status: 'active' }]]);
    this.globalKeys.set('k1', { secret: crypto.randomBytes(32), status: 'active' });
  }

  addWork(id, { school, kind = 'work', state = 'live', data = { feed: 'seed' } }) {
    this.works.set(id, { school, kind, state, epoch: 1, data: new Map(Object.entries(data)), hits: [] });
  }

  // —— 金鑰／授權材料（平台端產生）——
  derivedKey(id) { return hmac(this.derivedMaster, `work|${id}|${this.works.get(id).epoch}`); }
  schoolKey(school, ver) { return hmac(this.schoolMaster, `school|${school}|${ver}`); }
  mintGrant(id, { ops = ['read', 'write', 'delete'], ttlMs = 24 * 3600_000, kid = 'g1' } = {}) {
    const w = this.works.get(id);
    const claims = b64(JSON.stringify({ kid, id, ops, epoch: w.epoch, exp: this.clock.now() + ttlMs }));
    const sig = crypto.sign(null, Buffer.from(claims), this.grantPriv);
    return `${claims}.${b64(sig)}`;
  }
  mintGrantWithPrivateKey(priv, claimsObj) { // 用於「簽署私鑰外洩」情境
    const claims = b64(JSON.stringify(claimsObj));
    return `${claims}.${b64(crypto.sign(null, Buffer.from(claims), priv))}`;
  }
  bumpEpoch(id) { this.works.get(id).epoch += 1; }
  takeDown(id) { const w = this.works.get(id); w.state = 'down'; w.epoch += 1; }

  // —— 認證：回傳 { ok:true, ops? } 或 { status } ——
  authenticate(r) {
    const w = this.works.get(r.id);
    const a = r.auth || {};
    if (a.scheme === 'grant') {
      const [c, s] = String(a.grant || '').split('.');
      if (!c || !s) return { status: 401 };
      let claims;
      try { claims = JSON.parse(Buffer.from(c, 'base64url').toString()); } catch (_) { return { status: 401 }; }
      const k = this.grantKeys.get(claims.kid);
      if (!k || k.status === 'retired') return { status: 401 };
      if (!crypto.verify(null, Buffer.from(c), k.pub, Buffer.from(s, 'base64url'))) return { status: 401 };
      if (claims.exp <= this.clock.now()) return { status: 401 };
      if (claims.id !== r.id) return { status: 403 }; // 跨作品
      if (!w || claims.epoch !== w.epoch) return { status: 401 }; // 撤銷（epoch）
      if (!claims.ops.includes(OPS[r.method])) return { status: 403 }; // 超出範圍
      return { ok: true };
    }
    // HMAC 家族：時間窗口與 nonce 重放
    if (Math.abs(this.clock.now() - Number(r.ts)) > this.tsWindowMs) return { status: 401 };
    let secret;
    if (a.scheme === 'global') {
      const k = this.globalKeys.get(a.kid);
      if (!k || k.status === 'retired') return { status: 401 };
      secret = k.secret;
    } else if (a.scheme === 'derived') {
      if (!w) return { status: 401 };
      secret = this.derivedKey(r.id);
    } else if (a.scheme === 'school') {
      const [sch, ver] = String(a.kid).split(':');
      if (this.schoolRetired.has(a.kid)) return { status: 401 };
      secret = this.schoolKey(sch, ver);
      if (w && w.school !== sch) {
        // 簽章先驗再判斷歸屬，避免洩漏作品存在與否
        if (!safeEq(hmac(secret, signingString(r)), a.sig || '')) return { status: 401 };
        return { status: 403 };
      }
    } else return { status: 401 };
    if (!safeEq(hmac(secret, signingString(r)), a.sig || '')) return { status: 401 };
    if (this.nonces.has(`${a.kid}|${r.nonce}`)) return { status: 401 };
    this.nonces.add(`${a.kid}|${r.nonce}`);
    return { ok: true };
  }

  // —— 所有 scheme 共用的「平台端獨立檢查」——
  handle(r) {
    if (!ID_RE.test(r.id || '') || !KEY_RE.test(r.key || '') || !OPS[r.method]) return { status: 400 };
    const auth = this.authenticate(r);
    if (!auth.ok) return { status: auth.status };
    const w = this.works.get(r.id);
    if (!w) return { status: 403 };
    if (w.state !== 'live' && w.state !== 'active') return { status: 410 }; // 每次重驗，不用快取
    const now = this.clock.now();
    w.hits = w.hits.filter((t) => now - t < 60_000);
    if (w.hits.length >= this.ratePerMin) return { status: 429 };
    w.hits.push(now);
    if (r.method === 'GET') return w.data.has(r.key) ? { status: 200, body: w.data.get(r.key) } : { status: 404 };
    if (r.method === 'DELETE') { w.data.delete(r.key); return { status: 200 }; }
    const bytes = [...w.data].reduce((n, [k, v]) => n + k.length + String(v).length, 0) + (r.body || '').length;
    if (bytes > this.quotaBytes) return { status: 413 };
    w.data.set(r.key, r.body || '');
    return { status: 200 };
  }
}

// —— 持有者端：用手上的材料組出請求（works-edge 或攻擊者共用同一段程式）——
let seq = 0;
function buildRequest(platform, auth, { method, id, key = 'feed', body = '' }) {
  const r = { method, id, key, body, ts: String(platform.clock.now()), nonce: `n${++seq}` };
  if (auth.scheme === 'grant') return { ...r, auth: { scheme: 'grant', grant: auth.grants[id] } };
  const secret = auth.scheme === 'global' ? auth.secret
    : auth.scheme === 'derived' ? (auth.master ? hmac(auth.master, `work|${id}|${auth.epoch || 1}`) : auth.workKeys[id])
      : auth.secret;
  return { ...r, auth: { scheme: auth.scheme, kid: auth.kid, sig: secret ? hmac(secret, signingString(r)) : 'none' } };
}

module.exports = { DataPlatform, buildRequest, signingString, OPS };
