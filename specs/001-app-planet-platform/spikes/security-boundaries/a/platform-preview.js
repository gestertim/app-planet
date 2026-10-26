'use strict';
// 平台端「預覽會話」模擬（合成資料；僅示意授權邏輯，不是產品程式）
const crypto = require('crypto');
const { sha256, safeEq, newPreviewId } = require('../lib/util');

class PreviewPlatform {
  constructor(clock, { tokenTtlMs = 60_000, sessionTtlMs = 30 * 60_000, maxKeys = 20 } = {}) {
    this.clock = clock;
    this.tokenTtlMs = tokenTtlMs;
    this.sessionTtlMs = sessionTtlMs;
    this.maxKeys = maxKeys;
    this.sessions = new Map(); // sha256(preview_id) -> session（只存雜湊）
  }

  issue(owner = 'synthetic-teacher-1') {
    const preview_id = newPreviewId();
    const token = crypto.randomBytes(24).toString('base64url');
    const now = this.clock.now();
    this.sessions.set(sha256(preview_id), {
      owner, state: 'issued', tokenHash: sha256(token), tokenExp: now + this.tokenTtlMs,
      exp: now + this.sessionTtlMs, cookieHash: null, data: new Map(),
    });
    return { preview_id, token, expires_at: now + this.sessionTtlMs };
  }

  redeem(preview_id, token) {
    const s = this.sessions.get(sha256(preview_id || ''));
    if (!s || s.state !== 'issued' || this.clock.now() > s.tokenExp || !safeEq(s.tokenHash, sha256(token || ''))) return null;
    s.state = 'active'; // 原子標記已使用
    const cookie = crypto.randomBytes(32).toString('base64url');
    s.cookieHash = sha256(cookie);
    return { cookie, expires_at: s.exp };
  }

  // requireCookie=true（A1）：另須出示綁定此 preview_id 的會話 cookie
  state(preview_id, cookie, { requireCookie = false } = {}) {
    const s = this.sessions.get(sha256(preview_id || ''));
    if (!s) return { ok: false, why: 'unknown' };
    if (s.state === 'revoked') return { ok: false, why: 'revoked' };
    if (s.state !== 'active') return { ok: false, why: 'unredeemed' };
    if (this.clock.now() >= s.exp) return { ok: false, why: 'expired' };
    if (requireCookie && !(cookie && s.cookieHash && safeEq(s.cookieHash, sha256(cookie)))) return { ok: false, why: 'cookie' };
    return { ok: true, exp: s.exp };
  }

  revoke(preview_id) {
    const s = this.sessions.get(sha256(preview_id));
    if (s) s.state = 'revoked';
  }

  // 資料 API：每次請求都重驗，不使用 edge 快取
  data(preview_id, cookie, opts, method, key, value) {
    const v = this.state(preview_id, cookie, opts);
    if (!v.ok) return { status: 403 };
    const s = this.sessions.get(sha256(preview_id));
    if (!/^[a-z0-9_-]{1,32}$/.test(key || '')) return { status: 400 };
    if (method === 'GET') return s.data.has(key) ? { status: 200, body: s.data.get(key) } : { status: 404 };
    if (method === 'PUT') {
      if (!s.data.has(key) && s.data.size >= this.maxKeys) return { status: 413 };
      s.data.set(key, value);
      return { status: 200 };
    }
    if (method === 'DELETE') { s.data.delete(key); return { status: 200 }; }
    return { status: 405 };
  }
}

module.exports = { PreviewPlatform };
