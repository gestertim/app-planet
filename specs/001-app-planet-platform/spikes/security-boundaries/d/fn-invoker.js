'use strict';
// β2 候選 M（管理通道逐次呼叫）最小模擬：合成資料；非產品程式；非供應商環境。
// 結構：訪客 → works-edge（只持有 invoke grant）→ FnInvoker（平台側，持有管理通道）→ 沙箱內的學生處理程式。
// 訪客與 works-edge 都沒有沙箱位址；沙箱 `ports: []`。處理程式只收到 JSON，輸出也被當作不受信任的資料驗證。
const crypto = require('crypto');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');
const { buildRequest } = require('../b/platform-data');

const KEY_RE = /^[a-z0-9_-]{1,32}$/;
const FN_RE = /^[a-z][a-z0-9_-]{0,31}$/;

// 本機「管理通道」替身：每次呼叫在全新子行程執行處理程式。
// 與真實沙箱的差異：沒有 microVM、沒有防火牆、沒有 root；只用來驗證「呼叫契約」而非隔離強度。
class LocalChannel {
  constructor({ adminToken }) {
    this.adminToken = adminToken; // 只存在平台側；絕不傳給子行程
    this.ports = []; // 對應沙箱 ports: []
    this.spawned = 0;
  }

  run({ argv, stdin, timeoutMs, maxOutputBytes, memMb = 64 }) {
    this.spawned++;
    const env = process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot } : {};
    const child = spawn(process.execPath, [`--max-old-space-size=${memMb}`, ...argv], {
      env, cwd: path.join(__dirname, 'handlers'), stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true,
    });
    const out = { chunks: [], bytes: 0 };
    const state = { timedOut: false, truncated: false, killed: false };
    const kill = () => { if (!state.killed) { state.killed = true; child.kill('SIGKILL'); } };
    const done = new Promise((resolve) => {
      const timer = setTimeout(() => { state.timedOut = true; kill(); }, timeoutMs);
      child.stdout.on('data', (d) => {
        out.bytes += d.length;
        if (out.bytes > maxOutputBytes) { state.truncated = true; kill(); } else out.chunks.push(d);
      });
      child.stdin.on('error', () => {});
      child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout: Buffer.concat(out.chunks).toString(), ...state, pid: child.pid }); });
    });
    child.stdin.end(stdin);
    return { done, kill, pid: child.pid };
  }
}

class FnInvoker {
  constructor({ platform, clock, channel, naive = false, gateOpen = true, limits = {} }) {
    Object.assign(this, { platform, clock, channel, naive, gateOpen });
    this.limits = { ratePerMin: 20, perWorkConcurrency: 2, globalConcurrency: 4, bodyBytes: 4096, ...limits };
    this.manifests = new Map(); // workId -> { fns: { name: { argv, reads, writes, timeoutMs, maxOutputBytes } } }（取自已核准的部署）
    this.hits = new Map();
    this.inflight = new Map(); // workId -> Set<{kill}>
    this.total = 0;
    this.metrics = { rejected: {}, ok: 0 };
  }

  register(workId, manifest) { this.manifests.set(workId, manifest); }

  mintInvokeGrant(workId, { ttlMs = 6 * 3600_000, ops = ['invoke'] } = {}) {
    const w = this.platform.works.get(workId);
    return this.platform.mintGrantWithPrivateKey(this.platform.grantPriv,
      { kid: 'g1', id: workId, ops, epoch: w.epoch, exp: this.clock.now() + ttlMs });
  }

  verifyGrant(grant, workId) {
    const [c, s] = String(grant || '').split('.');
    if (!c || !s) return 401;
    let claims;
    try { claims = JSON.parse(Buffer.from(c, 'base64url').toString()); } catch (_) { return 401; }
    const k = this.platform.grantKeys.get(claims.kid);
    if (!k || k.status === 'retired') return 401;
    if (!crypto.verify(null, Buffer.from(c), k.pub, Buffer.from(s, 'base64url'))) return 401;
    if (claims.exp <= this.clock.now()) return 401;
    if (claims.id !== workId) return 403;
    const w = this.platform.works.get(workId);
    if (!w || claims.epoch !== w.epoch) return 401;
    if (!Array.isArray(claims.ops) || !claims.ops.includes('invoke')) return 403;
    return 0;
  }

  reject(status, why) { this.metrics.rejected[why] = (this.metrics.rejected[why] || 0) + 1; return { status, body: JSON.stringify({ error: why }) }; }

  live(workId) { const w = this.platform.works.get(workId); return !!w && (w.state === 'live' || w.state === 'active'); }

  // 平台下架／撤銷入口：改狀態並立即終止在途呼叫
  revoke(workId) {
    this.platform.takeDown(workId);
    for (const h of this.inflight.get(workId) || []) h.kill();
  }

  dataGrant(workId, ops) {
    const w = this.platform.works.get(workId);
    return this.platform.mintGrantWithPrivateKey(this.platform.grantPriv,
      { kid: 'g1', id: workId, ops, epoch: w.epoch, exp: this.clock.now() + 60_000 });
  }

  data(workId, method, key, body) {
    const ops = method === 'GET' ? ['read'] : ['write', 'delete'];
    const auth = { scheme: 'grant', grants: { [workId]: this.dataGrant(workId, ops) } };
    return this.platform.handle(buildRequest(this.platform, auth, { method, id: workId, key, body }));
  }

  async invoke({ grant, workId, fn, body }) {
    if (!this.gateOpen) return this.reject(503, 'restricted_runtime_gate_closed');
    const manifest = this.manifests.get(workId);
    if (!manifest) return this.reject(503, 'runtime_profile_missing');
    const g = this.verifyGrant(grant, workId);
    if (g) return this.reject(g, g === 401 ? 'grant_invalid' : 'grant_scope');
    if (!this.live(workId)) return this.reject(410, 'listing_not_live'); // 每次重驗，不經快取
    if (!FN_RE.test(fn || '') || !manifest.fns[fn]) return this.reject(404, 'fn_not_declared');
    const spec = manifest.fns[fn];
    if (Buffer.byteLength(body || '') > this.limits.bodyBytes) return this.reject(413, 'body_too_large');
    let input;
    try { input = body ? JSON.parse(body) : {}; } catch (_) { return this.reject(400, 'body_not_json'); }

    const now = this.clock.now();
    const hits = (this.hits.get(workId) || []).filter((t) => now - t < 60_000);
    if (hits.length >= this.limits.ratePerMin) return this.reject(429, 'rate_limited');
    const set = this.inflight.get(workId) || new Set();
    if (set.size >= this.limits.perWorkConcurrency) return this.reject(429, 'work_concurrency');
    if (this.total >= this.limits.globalConcurrency) return this.reject(503, 'global_concurrency');
    hits.push(now); this.hits.set(workId, hits);
    this.inflight.set(workId, set);

    const reads = {};
    for (const key of spec.reads || []) {
      const r = this.data(workId, 'GET', key);
      if (r.status === 200) reads[key] = r.body;
    }
    // 命令由已核准的 manifest 決定；訪客只能提供 JSON 本文。naive 模式（負對照）讓訪客決定命令。
    const argv = this.naive ? [String((input && input.argv) || spec.argv[0])] : spec.argv;
    const handle = this.channel.run({ argv, stdin: JSON.stringify({ request: input, data: reads }), timeoutMs: spec.timeoutMs, maxOutputBytes: spec.maxOutputBytes, memMb: spec.memMb });
    set.add(handle); this.total++;
    let r;
    try { r = await handle.done; } finally { set.delete(handle); this.total--; }

    if (!this.live(workId)) return this.reject(410, 'revoked_in_flight'); // 在途結果不回傳、不套用
    if (r.timedOut) return this.reject(504, 'handler_timeout');
    if (r.truncated) return this.reject(502, 'handler_output_too_large');
    if (r.code !== 0) return this.reject(502, 'handler_failed');
    let out;
    try { out = JSON.parse(r.stdout); } catch (_) { return this.reject(502, 'handler_output_not_json'); }
    if (!out || !Number.isInteger(out.status) || !((out.status >= 200 && out.status <= 299) || (out.status >= 400 && out.status <= 499)) || typeof out.body === 'undefined') return this.reject(502, 'handler_output_invalid');
    const writes = Array.isArray(out.writes) ? out.writes : [];
    if (writes.length > (spec.writes || []).length) return this.reject(502, 'handler_writes_invalid');
    for (const w of writes) {
      if (!w || !KEY_RE.test(w.key) || !(spec.writes || []).includes(w.key) || typeof w.value !== 'string') return this.reject(502, 'handler_writes_invalid');
    }
    const before = new Map();
    for (const w of writes) before.set(w.key, this.data(workId, 'GET', w.key));
    const applied = [];
    for (const w of writes) {
      const res = this.data(workId, 'PUT', w.key, w.value);
      if (res.status !== 200) {
        for (const k of applied) { // 全有或全無
          const old = before.get(k);
          if (old.status === 200) this.data(workId, 'PUT', k, old.body); else this.data(workId, 'DELETE', k);
        }
        return this.reject(res.status === 413 ? 413 : 502, 'data_write_rejected');
      }
      applied.push(w.key);
    }
    const text = typeof out.body === 'string' ? out.body : JSON.stringify(out.body);
    this.metrics.ok++;
    return { status: out.status, body: text };
  }
}

// works-edge 的 /_work/fn/v1/* 端：只持有 invoke grant、不持有簽署金鑰與管理憑證，也不轉送訪客標頭／IP／cookie
class FnEdge {
  constructor({ invoker, hosts }) { Object.assign(this, { invoker, hosts }); } // hosts: host -> { workId, grant }

  start() {
    this.server = http.createServer(async (req, res) => {
      const reply = (status, body) => res.writeHead(status, {
        'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
        'referrer-policy': 'no-referrer',
      }).end(body);
      try {
        const h = this.hosts[req.headers.host];
        const u = new URL(req.url, 'http://x');
        const m = /^\/_work\/fn\/v1\/([^/]+)$/.exec(u.pathname);
        if (!h || !m || req.method !== 'POST') return reply(404, '{"error":"not_found"}');
        const chunks = []; let size = 0;
        for await (const c of req) { size += c.length; if (size > 8192) return reply(413, '{"error":"body_too_large"}'); chunks.push(c); }
        const r = await this.invoker.invoke({ grant: h.grant, workId: h.workId, fn: m[1], body: Buffer.concat(chunks).toString() });
        return reply(r.status, r.body);
      } catch (_) { return reply(500, '{"error":"internal"}'); }
    });
    return new Promise((r) => this.server.listen(0, '127.0.0.1', () => { this.port = this.server.address().port; r(this); }));
  }

  close() { this.server.close(); }
}

module.exports = { FnInvoker, FnEdge, LocalChannel };
