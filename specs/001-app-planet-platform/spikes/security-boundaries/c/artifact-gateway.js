'use strict';
// 候選 X（產物式預覽）最小模擬：閘道只提供「平台驗證後保存的產物位元組」。
// 結構性質：不持有任何沙箱位址、不發出任何出站連線；沙箱只在建置時被平台以管理通道讀取檔案。
const http = require('http');
const { sha256 } = require('../lib/util');

const MIME = {
  html: 'text/html; charset=utf-8', js: 'text/javascript; charset=utf-8', css: 'text/css; charset=utf-8',
  json: 'application/json', txt: 'text/plain; charset=utf-8', png: 'image/png', jpg: 'image/jpeg',
  webp: 'image/webp', woff2: 'font/woff2',
};

// 平台端入庫：任何違規即整份拒絕（fail-closed）。entries 來自沙箱，視為不受信任。
function ingestArtifact(entries, { maxFiles = 200, maxFileBytes = 1_000_000, maxTotalBytes = 5_000_000 } = {}) {
  if (!Array.isArray(entries) || entries.length === 0 || entries.length > maxFiles) return { ok: false, why: 'file-count' };
  const files = new Map();
  let total = 0;
  for (const e of entries) {
    const p = e && e.path;
    if (!e || e.type !== 'file') return { ok: false, why: 'not-regular-file' };
    if (typeof p !== 'string' || !p || p.includes('\0') || p.includes('\\') || p.startsWith('/')) return { ok: false, why: 'bad-path' };
    const segs = p.split('/');
    if (segs.some((s) => s === '' || s === '.' || s === '..')) return { ok: false, why: 'bad-path' };
    if (segs[0] === '_work') return { ok: false, why: 'reserved-prefix' };
    const name = segs[segs.length - 1];
    const ext = name.includes('.') ? name.split('.').pop().toLowerCase() : '';
    if (!MIME[ext]) return { ok: false, why: 'type-not-allowed' };
    const bytes = Buffer.from(e.content || '');
    if (bytes.length > maxFileBytes) return { ok: false, why: 'file-too-large' };
    total += bytes.length;
    if (total > maxTotalBytes) return { ok: false, why: 'total-too-large' };
    if (files.has(p.toLowerCase())) return { ok: false, why: 'duplicate-path' };
    files.set(p.toLowerCase(), { bytes, mime: MIME[ext] });
  }
  if (!files.has('index.html')) return { ok: false, why: 'no-index' };
  return { ok: true, files };
}

class ArtifactGateway {
  constructor({ platform, clock, mode = 'host', stateTtlMs = 15_000, frameAncestors = 'https://app.platform.test', domain = 'preview.test' }) {
    Object.assign(this, { platform, clock, mode, stateTtlMs, frameAncestors });
    this.hostRe = new RegExp(`^([a-z2-7]{26})\\.${domain.replace(/\./g, '\\.')}(?::\\d+)?$`);
    this.requireCookie = mode === 'cookie';
    this.artifacts = new Map(); // preview_id -> { version, files }
    this.cache = new Map();
    this.upgradeAttempts = 0;
  }

  bind(id, version, files) { this.artifacts.set(id, { version, files }); }

  start() {
    this.server = http.createServer((q, s) => this.handle(q, s).catch(() => s.writeHead(500).end()));
    this.server.on('upgrade', (q, sock) => { this.upgradeAttempts++; sock.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n'); });
    return new Promise((r) => this.server.listen(0, '127.0.0.1', () => { this.port = this.server.address().port; r(this); }));
  }

  close() { this.server.close(); }

  authorize(id, cookie) {
    const key = `${id}|${cookie ? sha256(cookie) : ''}`;
    const hit = this.cache.get(key);
    const now = this.clock.now();
    if (hit && now - hit.at < this.stateTtlMs) return hit.ok;
    const ok = this.platform.state(id, cookie, { requireCookie: this.requireCookie }).ok;
    this.cache.set(key, { ok, at: now });
    return ok;
  }

  headers(extra = {}) {
    return {
      'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff',
      'x-robots-tag': 'noindex, nofollow',
      'content-security-policy': `default-src 'self'; connect-src 'self'; form-action 'self'; base-uri 'self'; frame-ancestors ${this.frameAncestors}`,
      ...extra,
    };
  }

  deny(res, status = 403) { res.writeHead(status, this.headers({ 'content-type': 'text/plain' })).end('preview-unavailable'); }

  async handle(req, res) {
    const m = this.hostRe.exec(req.headers.host || '');
    if (!m) return this.deny(res);
    const id = m[1];
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/_work/preview/redeem') {
      const r = this.platform.redeem(id, url.searchParams.get('t'));
      if (!r) return this.deny(res);
      const h = this.headers({ location: '/' });
      if (this.requireCookie) h['set-cookie'] = `pv=${r.cookie}; Path=/; HttpOnly; SameSite=None; Secure; Partitioned`;
      return void res.writeHead(302, h).end();
    }
    const ck = /(?:^|;\s*)pv=([^;]+)/.exec(req.headers.cookie || '');
    const cookie = ck ? ck[1] : null;
    if (url.pathname.startsWith('/_work/data/v1/')) {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const r = this.platform.data(id, cookie, { requireCookie: this.requireCookie }, req.method,
        url.pathname.slice('/_work/data/v1/'.length), Buffer.concat(chunks).toString() || undefined);
      if (r.status === 403) return this.deny(res);
      return void res.writeHead(r.status, this.headers({ 'content-type': 'text/plain' })).end(r.body || '');
    }
    if (url.pathname.startsWith('/_work/')) return this.deny(res, 404);
    if (!this.authorize(id, cookie)) return this.deny(res);
    const art = this.artifacts.get(id);
    const key = (url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1))).toLowerCase();
    const f = art && art.files.get(key);
    if (!f) return this.deny(res, 404);
    res.writeHead(200, this.headers({ 'content-type': f.mime, 'x-artifact-version': String(art.version) })).end(f.bytes);
  }
}

module.exports = { ArtifactGateway, ingestArtifact };
