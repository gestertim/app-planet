'use strict';
// works-edge 預覽模式模擬。mode='host'＝現行方案（主機名即憑證）；mode='cookie'＝方案 A1（主機名＋分區 cookie，逐請求驗證）
const http = require('http');
const net = require('net');
const { sha256 } = require('../lib/util');

const FORBIDDEN_BODY = 'preview-unavailable';
class PreviewEdge {
  constructor({ platform, clock, upstream, upstreamToken = null, mode = 'host', stateTtlMs = 15_000, frameAncestors = 'https://app.platform.test', domain = 'preview.test',   cookieAttrs = 'SameSite=None; Secure; Partitioned', cookieName = 'pv' }) {
      Object.assign(this, { platform, clock, upstream, upstreamToken, mode, stateTtlMs, frameAncestors, cookieAttrs, cookieName });
    this.hostRe = new RegExp(`^([a-z2-7]{26})\\.${domain.replace(/\./g, '\\.')}(?::\\d+)?$`);
    this.cache = new Map();
    this.sockets = new Set(); // { id, cookie, socket }
    this.log = []; // 僅記雜湊；不記查詢字串
    this.requireCookie = mode === 'cookie';
  }

  start() {
    this.server = http.createServer((q, s) => this.handle(q, s).catch(() => s.writeHead(500).end()));
    this.server.on('upgrade', (q, sock, head) => this.upgrade(q, sock, head));
    return new Promise((r) => this.server.listen(0, '127.0.0.1', () => { this.port = this.server.address().port; r(this); }));
  }

  close() { this.sockets.forEach((e) => e.socket.destroy()); this.server.close(); }

  idOf(req) { const m = this.hostRe.exec(req.headers.host || ''); return m && m[1]; }

  cookieOf(req) {
    const m = new RegExp(`(?:^|;\\s*)${this.cookieName}=([^;]+)`).exec(req.headers.cookie || '');
    return m ? m[1] : null;
  }

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

  deny(res, id, status = 403) {
    this.log.push({ pid: id ? sha256(id).slice(0, 12) : null, status });
    res.writeHead(status, this.headers({ 'content-type': 'text/plain' })).end(FORBIDDEN_BODY);
  }

  async handle(req, res) {
    const id = this.idOf(req);
    const url = new URL(req.url, 'http://x');
    if (!id) return this.deny(res, null);

    if (url.pathname === '/_work/preview/redeem') {
      const r = this.platform.redeem(id, url.searchParams.get('t'));
      if (!r) return this.deny(res, id);
      this.log.push({ pid: sha256(id).slice(0, 12), status: 302 });
      const h = this.headers({ location: '/' });
      if (this.mode === 'cookie') h['set-cookie'] = `${this.cookieName}=${r.cookie}; Path=/; HttpOnly; ${this.cookieAttrs}`;
      res.writeHead(302, h).end();
      return;
    }

    const cookie = this.cookieOf(req);
    if (url.pathname.startsWith('/_work/data/v1/')) {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const r = this.platform.data(id, cookie, { requireCookie: this.requireCookie }, req.method,
        url.pathname.slice('/_work/data/v1/'.length), Buffer.concat(chunks).toString() || undefined);
      if (r.status === 403) return this.deny(res, id);
      res.writeHead(r.status, this.headers({ 'content-type': 'text/plain' })).end(r.body || '');
      return;
    }
    if (url.pathname.startsWith('/_work/')) return this.deny(res, id, 404);

    if (!this.authorize(id, cookie)) return this.deny(res, id);
    const headers = { ...req.headers, host: 'sandbox.internal' };
    delete headers.cookie; delete headers.authorization;
    if (this.upstreamToken) headers['x-upstream-token'] = this.upstreamToken;
    const up = http.request({ host: '127.0.0.1', port: this.upstream.port, path: req.url, method: req.method, headers }, (ur) => {
      this.log.push({ pid: sha256(id).slice(0, 12), status: ur.statusCode });
      res.writeHead(ur.statusCode, this.headers({ 'content-type': ur.headers['content-type'] || 'text/plain' }));
      ur.pipe(res);
    });
    up.on('error', () => this.deny(res, id, 502));
    req.pipe(up);
  }

  upgrade(req, socket, head) {
    const id = this.idOf(req);
    const cookie = this.cookieOf(req);
    if (!id || !this.authorize(id, cookie)) {
      this.log.push({ pid: id ? sha256(id).slice(0, 12) : null, status: 403, ws: true });
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      return;
    }
    const up = net.connect(this.upstream.port, '127.0.0.1', () => {
      const h = { ...req.headers, host: 'sandbox.internal' };
      delete h.cookie; delete h.authorization;
      if (this.upstreamToken) h['x-upstream-token'] = this.upstreamToken;
      up.write(`GET ${req.url} HTTP/1.1\r\n${Object.entries(h).map(([k, v]) => `${k}: ${v}`).join('\r\n')}\r\n\r\n`);
      if (head && head.length) up.write(head);
      up.pipe(socket); socket.pipe(up);
    });
    const entry = { id, cookie, socket };
    this.sockets.add(entry);
    const drop = () => { this.sockets.delete(entry); up.destroy(); socket.destroy(); };
    socket.on('close', drop); socket.on('error', drop); up.on('error', drop);
  }

  // 已建立的 WebSocket 不會自行重驗；須由此週期檢查（間隔即撤銷上界之一）
  recheck() {
    this.cache.clear();
    for (const e of [...this.sockets]) {
      if (!this.platform.state(e.id, e.cookie, { requireCookie: this.requireCookie }).ok) e.socket.destroy();
    }
  }
}

module.exports = { PreviewEdge, FORBIDDEN_BODY };
