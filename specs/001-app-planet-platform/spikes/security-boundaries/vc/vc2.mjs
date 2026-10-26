// VC-2：產物取回（受限出站）＋儲存→重建→取回→入庫→綁定→iframe 可見 延遲；入庫驗證；撤銷延遲（本機閘道）。合成資料。
// 供應商段：Vercel Sandbox（ports: [] / deny-all）。本機段：本機閘道＋本機瀏覽器（非 Vercel works-edge）。
import { Sandbox } from '@vercel/sandbox';
import http from 'node:http';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { writeFileSync, mkdirSync } from 'node:fs';
import { Readable } from 'node:stream';
import * as tar from 'tar';
import puppeteer from 'puppeteer-core';
import { REGION, stats, summarize, now, sleep } from './lib.mjs';

const require = createRequire(import.meta.url);
const { ingestArtifact } = require('C:/Users/geste/spec-kit/app-planet/specs/001-app-planet-platform/spikes/security-boundaries/c/artifact-gateway.js');
const PAR = Number(process.env.PAR || 8);
const N = Number(process.env.N || 30), NCOLD = Number(process.env.NCOLD || 10), TTL = 2000;
const out = { startedAt: new Date().toISOString(), region: REGION, N, NCOLD, ttlMs: TTL, errors: [] };
const save = () => { mkdirSync('results', { recursive: true }); writeFileSync('results/vc2-raw.json', JSON.stringify(out, null, 2)); };
const BASE = { ports: [], networkPolicy: 'deny-all', resources: { vcpus: 1 }, region: REGION, persistent: false };

const BUILD_JS = `
const fs = require('fs'); const crypto = require('crypto');
const v = fs.readFileSync('/work/src/version.txt', 'utf8').trim();
fs.rmSync('/work/dist', { recursive: true, force: true }); fs.mkdirSync('/work/dist/assets', { recursive: true });
fs.writeFileSync('/work/dist/index.html', '<!doctype html><meta charset=utf-8><link rel=stylesheet href=assets/style.css><title>app</title><body><h1 id=m>' + v + '</h1><script src=assets/app.js></script>');
fs.writeFileSync('/work/dist/assets/style.css', 'h1{color:#036}');
fs.writeFileSync('/work/dist/assets/app.js', 'document.title=' + JSON.stringify(v) + ';');
fs.writeFileSync('/work/dist/assets/data.json', JSON.stringify({ rows: Array.from({ length: 6000 }, (_, i) => ({ i, h: crypto.createHash('md5').update(String(i)).digest('hex') })) }));
`;
const PACK = `cd /work/dist && find . -mindepth 1 -printf '%P\\0' | tar --null --no-recursion -czf /tmp/dist.tgz -T -`;
const BUILD_CMD = `node /work/build.js && ${PACK}`;

async function parseTar(buf, { maxBytes = 20_000_000 } = {}) {
  const entries = []; let total = 0; let bad = null;
  await new Promise((resolve, reject) => {
    const p = new tar.Parser({ preservePaths: true });
    p.on('entry', (e) => {
      if (e.type === 'Directory') { e.resume(); return; }
      const chunks = []; e.on('data', (c) => { total += c.length; if (total > maxBytes) { bad = 'too-big'; e.resume(); return; } chunks.push(c); });
      e.on('end', () => entries.push({ path: e.path, type: e.type === 'File' ? 'file' : e.type.toLowerCase(), content: Buffer.concat(chunks) }));
    });
    p.on('end', resolve); p.on('error', reject); Readable.from(buf).pipe(p);
  });
  return { entries, bad };
}

// ---- 本機閘道（真實時鐘；授權狀態快取 TTL）與平台頁 ----
const state = { ttl: TTL, version: 0, files: null, revokedAt: null, cacheAt: 0, cacheOk: true };
const platformAuthorized = () => state.revokedAt === null;
const gateway = http.createServer((req, res) => {
  const t = Date.now();
  if (t - state.cacheAt >= state.ttl) { state.cacheOk = platformAuthorized(); state.cacheAt = t; }
  const h = { 'cache-control': 'no-store', 'content-security-policy': "default-src 'self'; frame-ancestors http://127.0.0.1:*", 'x-content-type-options': 'nosniff' };
  if (!state.cacheOk || !state.files) { res.writeHead(403, h).end('preview-unavailable'); return; }
  const key = (new URL(req.url, 'http://x').pathname === '/' ? 'index.html' : decodeURIComponent(new URL(req.url, 'http://x').pathname.slice(1))).toLowerCase();
  const f = state.files.get(key); if (!f) { res.writeHead(404, h).end(); return; }
  res.writeHead(200, { ...h, 'content-type': f.mime }).end(f.bytes);
});
await new Promise((r) => gateway.listen(0, '127.0.0.1', r));
const gwPort = gateway.address().port;
const platform = http.createServer((req, res) => {
  if (req.url.startsWith('/api/version')) { res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify({ version: state.version })); return; }
  res.writeHead(200, { 'content-type': 'text/html' }).end(`<!doctype html><iframe id=f style="width:600px;height:300px" src="http://127.0.0.1:${gwPort}/"></iframe><script>
let cur=${state.version};setInterval(async()=>{const r=await fetch('/api/version',{cache:'no-store'});const j=await r.json();if(j.version!==cur){cur=j.version;const f=document.getElementById('f');f.src='http://127.0.0.1:${gwPort}/?v='+cur;}},250);</script>`);
});
await new Promise((r) => platform.listen(0, '127.0.0.1', r));
const platPort = platform.address().port;
const browser = await puppeteer.launch({ executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', headless: true, userDataDir: 'C:\\Users\\geste\\.copilot\\session-state\\693b0c24-f0dc-4879-ab72-9de0f220ff26\\files\\vc\\chrome-profile', args: ['--no-sandbox', '--disable-gpu'] });
out.browser = await browser.version();
const page = await browser.newPage(); await page.goto(`http://127.0.0.1:${platPort}/`, { waitUntil: 'load' });

const ingestBind = async (tgz) => {
  const { entries, bad } = await parseTar(tgz);
  const r = bad ? { ok: false, why: bad } : ingestArtifact(entries);
  return r;
};
async function waitVisible(marker, timeoutMs = 15000) {
  const t0 = now();
  const frame = page.frames().find((f) => f.url().startsWith(`http://127.0.0.1:${gwPort}`));
  for (;;) {
    const fr = page.frames().find((f) => f.url().startsWith(`http://127.0.0.1:${gwPort}`));
    try { if (fr && (await fr.evaluate((m) => document.body && document.body.textContent.includes(m), marker))) return now() - t0; } catch { /* frame navigating */ }
    if (now() - t0 > timeoutMs) return null;
    await sleep(20);
  }
}

async function rebuildOnce(sb, i, { cold = false } = {}) {
  const marker = `V${i}-${crypto.randomBytes(4).toString('hex')}`;
  const T = {}; const c = stats.calls; const t0 = now();
  await sb.writeFiles([{ path: '/work/src/version.txt', content: Buffer.from(marker) }]); T.syncMs = now() - t0;
  let t = now(); const r = await sb.runCommand({ cmd: 'bash', args: ['-c', BUILD_CMD] }); if (r.exitCode !== 0) throw new Error('build failed ' + (await r.stderr()).slice(0, 100)); T.buildMs = now() - t;
  t = now(); const tgz = await sb.readFileToBuffer({ path: '/tmp/dist.tgz' }); T.fetchMs = now() - t; T.tgzBytes = tgz.length;
  t = now(); const ing = await ingestBind(tgz); if (!ing.ok) throw new Error('ingest rejected benign artifact: ' + ing.why); T.ingestMs = now() - t;
  t = now(); state.files = ing.files; state.version++; state.cacheAt = 0; const tBound = now(); 
  const vis = await waitVisible(marker); if (vis === null) throw new Error('iframe never showed marker');
  T.boundToVisibleMs = now() - tBound; T.sandboxPartMs = tBound - t0; T.e2eMs = now() - t0; T.calls = stats.calls - c;
  return T;
}
const FILES = (b) => [{ path: '/work/build.js', content: Buffer.from(BUILD_JS) }, { path: '/work/src/version.txt', content: Buffer.from('init') }];

// ---- A. 暖沙箱重建（編輯循環；N 次）----
{
  const t = now(); const sb = await Sandbox.create({ ...BASE, timeout: 600000 }); out.coldCreateMs = Math.round(now() - t);
  await sb.writeFiles(FILES());
  out.warm = [];
  for (let i = 0; i < N; i++) { try { out.warm.push({ i, ...(await rebuildOnce(sb, i)) }); } catch (e) { out.errors.push({ part: 'warm', i, e: String(e.message).slice(0, 200) }); } }
  await sb.stop();
  const f = (k) => summarize(out.warm.map((x) => x[k]));
  out.warmSummary = { n: out.warm.length, sync: f('syncMs'), build: f('buildMs'), fetch: f('fetchMs'), ingest: f('ingestMs'), sandboxPart: f('sandboxPartMs'), boundToVisible: f('boundToVisibleMs'), e2e: f('e2eMs'), tgzBytes: out.warm[0]?.tgzBytes };
  console.log('warm', JSON.stringify(out.warmSummary)); save();
}
// ---- B. 冷啟動（新建→首次建置→可見；NCOLD 次）----
out.cold = [];
for (let i = 0; i < NCOLD; i++) {
  try { const t0 = now(); const sb = await Sandbox.create({ ...BASE, timeout: 120000 }); const createMs = now() - t0; await sb.writeFiles(FILES()); const T = await rebuildOnce(sb, 1000 + i, { cold: true }); out.cold.push({ i, createMs, ...T, coldE2eMs: now() - t0 }); await sb.stop(); }
  catch (e) { out.errors.push({ part: 'cold', i, e: String(e.message).slice(0, 200) }); }
}
if (out.cold.length) { out.coldSummary = { n: out.cold.length, create: summarize(out.cold.map((x) => x.createMs)), coldE2e: summarize(out.cold.map((x) => x.coldE2eMs)) }; console.log('cold', JSON.stringify(out.coldSummary)); }
save();
// ---- C. 20 並行（僅供應商段，不含瀏覽器）× 3 輪 ----
{
  const sbs = await Promise.all(Array.from({ length: PAR }, async () => { const s = await Sandbox.create({ ...BASE, timeout: 300000 }); await s.writeFiles(FILES()); return s; }));
  const times = []; const fails = [];
  for (let round = 0; round < 3; round++) await Promise.all(sbs.map(async (sb, k) => { try { const t0 = now(); await sb.writeFiles([{ path: '/work/src/version.txt', content: Buffer.from(`R${round}-${k}`) }]); const r = await sb.runCommand({ cmd: 'bash', args: ['-c', BUILD_CMD] }); if (r.exitCode) throw new Error('build'); const tgz = await sb.readFileToBuffer({ path: '/tmp/dist.tgz' }); const ing = await ingestBind(tgz); if (!ing.ok) throw new Error('ingest'); times.push(now() - t0); } catch (e) { fails.push(String(e.message).slice(0, 100)); } }));
  await Promise.all(sbs.map((s) => s.stop().catch(() => {})));
  out.parallel20 = { sandboxes: PAR, rounds: 3, ok: times.length, failed: fails.length, failures: fails.slice(0, 5), sandboxPart: summarize(times) };
  console.log('parallel20', JSON.stringify(out.parallel20)); save();
}
// ---- D. 受限出站：deny-all 取回、registry-only、政策切換 ----
{
  out.egress = {};
  const sb = await Sandbox.create({ ...BASE, timeout: 300000 }); await sb.writeFiles(FILES());
  const sh = async (s) => { const r = await sb.runCommand({ cmd: 'bash', args: ['-c', s] }); return ((await r.stdout()) + (await r.stderr())).trim().replace(/\s+/g, ' ').slice(0, 240); };
  out.egress.denyAll_npm = await sh('cd /work && npm init -y >/dev/null 2>&1; timeout 20 npm install is-odd --no-audit --no-fund 2>&1 | tail -2; echo "exit=${PIPESTATUS[0]}"');
  out.egress.denyAll_retrieval = (await ingestBind(await (async () => { await sb.runCommand({ cmd: 'bash', args: ['-c', BUILD_CMD] }); return sb.readFileToBuffer({ path: '/tmp/dist.tgz' }); })())).ok ? 'retrieved+ingested' : 'rejected';
  const t = now(); try { await sb.update({ networkPolicy: { allow: ['registry.npmjs.org'] } }); out.egress.policyUpdateMs = Math.round(now() - t); out.egress.policyUpdate = 'ok'; } catch (e) { out.egress.policyUpdate = 'error: ' + String(e.message).slice(0, 160); }
  out.egress.registryOnly_npm = await sh('cd /work && timeout 40 npm install is-odd --no-audit --no-fund 2>&1 | tail -2; echo "exit=${PIPESTATUS[0]}"; ls node_modules 2>/dev/null | head -3');
  out.egress.registryOnly_example = await sh(`curl -s -m 6 -o /dev/null -w 'http=%{http_code}' https://example.com; echo " exit=$?"`);
  out.egress.registryOnly_github = await sh(`curl -s -m 6 -o /dev/null -w 'http=%{http_code}' https://github.com; echo " exit=$?"`);
  out.egress.registryOnly_vercelApi = await sh(`curl -s -m 6 -o /dev/null -w 'http=%{http_code}' https://api.vercel.com; echo " exit=$?"`);
  out.egress.registryOnly_imds = await sh(`curl -s -m 6 -o /dev/null -w 'http=%{http_code}' http://169.254.169.254; echo " exit=$?"`);
  const t2 = now(); try { await sb.update({ networkPolicy: 'deny-all' }); out.egress.backToDenyAllMs = Math.round(now() - t2); } catch (e) { out.egress.backToDenyAll = 'error: ' + String(e.message).slice(0, 160); }
  out.egress.afterDenyAll_npm = await sh('cd /tmp && rm -rf x && mkdir x && cd x && npm init -y >/dev/null 2>&1; timeout 20 npm install left-pad --no-audit --no-fund 2>&1 | tail -1; echo "exit=${PIPESTATUS[0]}"');
  out.egress.afterDenyAll_registry = await sh(`curl -s -m 6 -o /dev/null -w 'http=%{http_code}' https://registry.npmjs.org/; echo " exit=$?"`);
  out.egress.finalPolicy = JSON.stringify((await Sandbox.get({ name: sb.name, resume: false })).networkPolicy);
  await sb.stop(); console.log('egress', JSON.stringify(out.egress)); save();
}
// ---- E. 惡意／邊界產物：取回成功、入庫整份拒絕 ----
{
  const sb = await Sandbox.create({ ...BASE, timeout: 300000 }); await sb.writeFiles(FILES());
  const cases = {
    benign: `mkdir -p /w/o && cd /w/o && echo '<h1>ok</h1>' > index.html`,
    symlink: `mkdir -p /w/o && cd /w/o && echo x > index.html && ln -s /etc/passwd link.txt`,
    hardlink: `mkdir -p /w/o && cd /w/o && echo x > index.html && ln index.html hard.html`,
    dotdot: `mkdir -p /w/o && cd /w/o && echo x > index.html`,
    absolute: `mkdir -p /w/o && cd /w/o && echo x > index.html`,
    workPrefix: `mkdir -p /w/o/_work/data/v1 && cd /w/o && echo x > index.html && echo x > _work/data/v1/x.js`,
    disallowedType: `mkdir -p /w/o && cd /w/o && echo x > index.html && echo x > _headers && echo x > run.sh`,
    oversizeFile: `mkdir -p /w/o && cd /w/o && echo x > index.html && head -c 2000000 /dev/urandom > big.js`,
    manyFiles: `mkdir -p /w/o && cd /w/o && echo x > index.html && for i in $(seq 1 300); do echo $i > f$i.js; done`,
    caseDuplicate: `mkdir -p /w/o && cd /w/o && echo x > index.html && echo a > A.js && echo b > a.js`,
    noIndex: `mkdir -p /w/o && cd /w/o && echo x > other.html`,
    justUnderTotal: `mkdir -p /w/o && cd /w/o && echo x > index.html && for i in 1 2 3 4; do head -c 1200000 /dev/urandom | base64 -w0 | head -c 900000 > p$i.js; done`,
    justOverTotal: `mkdir -p /w/o && cd /w/o && echo x > index.html && for i in 1 2 3 4 5 6; do head -c 1200000 /dev/urandom | base64 -w0 | head -c 900000 > p$i.js; done`,
  };
  const pack = { default: `cd /w/o && find . -mindepth 1 -printf '%P\\0' | tar --null --no-recursion -czf /tmp/mal.tgz -T -`, dotdot: `cd /w/o && tar -czf /tmp/mal.tgz --transform 's,^index.html$,../escape.html,' index.html`, absolute: `cd /w/o && tar -P -czf /tmp/mal.tgz --transform 's,^index.html$,/tmp/abs.html,' index.html` };
  out.malicious = {};
  for (const [name, setup] of Object.entries(cases)) {
    try {
      const t0 = now(); await sb.runCommand({ cmd: 'bash', args: ['-c', `rm -rf /w /tmp/mal.tgz; ${setup}; ${pack[name] || pack.default}`] });
      const tgz = await sb.readFileToBuffer({ path: '/tmp/mal.tgz' }); const retrievedMs = now() - t0;
      const r = await ingestBind(tgz);
      out.malicious[name] = { retrieved: !!tgz, tgzBytes: tgz?.length, retrieveMs: Math.round(retrievedMs), accepted: r.ok, why: r.ok ? null : r.why };
    } catch (e) { out.malicious[name] = { error: String(e.message).slice(0, 160) }; }
  }
  await sb.stop(); console.log('malicious', JSON.stringify(out.malicious)); save();
}
// ---- F. 撤銷延遲（本機閘道；TTL=2000 ms 與 0）----
{
  const bytes = Buffer.from('<h1>x</h1>'); const files = new Map([['index.html', { bytes, mime: 'text/html' }]]);
  const get = () => new Promise((resolve) => http.get({ host: '127.0.0.1', port: gwPort, path: '/', agent: false }, (r) => { r.resume(); r.on('end', () => resolve(r.statusCode)); }).on('error', () => resolve(0)));
  out.revoke = { ttl2000: [], ttl0: [] };
  for (const [label, ttl] of [['ttl2000', TTL], ['ttl0', 0]]) {
    for (let i = 0; i < N; i++) {
      state.ttl = ttl; state.files = files; state.revokedAt = null; state.cacheAt = 0; await get(); // 暖快取
      await sleep(Math.floor(Math.random() * (ttl || 200))); // 隨機落在快取窗口內
      const t0 = now(); state.revokedAt = Date.now();
      let ms = null; while (now() - t0 < 6000) { if ((await get()) === 403) { ms = now() - t0; break; } await sleep(25); }
      out.revoke[label].push(ms);
    }
    if (ttl === 0) break;
  }
  const s2 = out.revoke.ttl2000.filter((x) => x !== null); out.revokeSummary = { ttl2000: summarize(s2), ttl2000_noDeny: out.revoke.ttl2000.filter((x) => x === null).length };
  console.log('revoke', JSON.stringify(out.revokeSummary));
}
out.apiCalls = { total: stats.calls, byStatus: stats.byStatus };
out.finishedAt = new Date().toISOString(); save();
await browser.close(); gateway.close(); platform.close();
console.log('errors', out.errors.length, JSON.stringify(out.errors.slice(0, 6)));
