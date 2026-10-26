// 共用工具：fetch 計數（控制面呼叫次數、429、限額標頭）、統計、合成 β2 處理程式
export const REGION = 'hnd1';
export const stats = { calls: 0, byStatus: {}, byHost: {}, rl: [], log: [] };

const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input.url;
  const t = performance.now();
  const res = await realFetch(input, init);
  stats.calls++;
  stats.byStatus[res.status] = (stats.byStatus[res.status] || 0) + 1;
  const h = new URL(url).host; stats.byHost[h] = (stats.byHost[h] || 0) + 1;
  const rl = {};
  for (const [k, v] of res.headers) if (/ratelimit|retry-after/i.test(k)) rl[k] = v;
  if (Object.keys(rl).length && stats.rl.length < 400) stats.rl.push({ status: res.status, path: new URL(url).pathname.replace(/\/[^/]*[A-Za-z0-9]{8,}[^/]*/g, '/:id'), method: init?.method || 'GET', ...rl });
  stats.log.push({ m: init?.method || 'GET', p: new URL(url).pathname.replace(/sbx_[A-Za-z0-9]+/g, 'sbx_*').replace(/cmd_[A-Za-z0-9]+/g, 'cmd_*'), s: res.status, ms: Math.round(performance.now() - t) });
  return res;
};
export const callsSince = (n) => stats.calls - n;

export function pct(a, p) { const s = [...a].sort((x, y) => x - y); if (!s.length) return null; const i = Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1); return s[Math.max(0, i)]; }
export function summarize(a) { const s = a.map((x) => Math.round(x)); return { n: s.length, min: Math.min(...s), p50: pct(s, 50), p95: pct(s, 95), max: Math.max(...s), mean: Math.round(s.reduce((x, y) => x + y, 0) / s.length) }; }
export const now = () => performance.now();
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const HANDLER = `
// 合成 β2 處理程式：讀取 JSON 請求、做小量運算、輸出 JSON（不含任何真實資料）
const fs = require('fs');
const req = JSON.parse(fs.readFileSync(process.argv[2] || '/tmp/req.json', 'utf8'));
let h = 0; for (let i = 0; i < 2e5; i++) h = (h * 31 + i) | 0;
process.stdout.write(JSON.stringify({ status: 200, body: { echo: req.fn, n: req.n, h }, writes: { 'score/last': req.n } }));
`;
export const MANIFEST = { fn: 'score', argv: ['node', '/opt/fn/handler.js', '/tmp/req.json'], reads: [], writes: ['score/last'], timeoutMs: 5000 };
