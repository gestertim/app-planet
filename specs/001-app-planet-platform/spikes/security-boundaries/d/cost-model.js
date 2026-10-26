'use strict';
// 官方單價（2026-10-21 取得；iad1；Pro）的純算術模型。不是報價、不是量測；「假設」欄位皆須供應商實測（V-β2c）。
// 來源：Vercel Sandbox pricing（last_updated 2026-09-10）；Cloudflare Workers for Platforms pricing（last_updated 2026-04-21）。
const P = {
  cpuHr: 0.128, memGbHr: 0.0212, createPerM: 0.60, memMinBillSec: 60, memGbPerVcpu: 2,
  controlPlaneRpm: { pro: 10_000, hobby: 1_000 }, vcpuAllocPerMin: { proStart: 150, proMax: 5_000 },
  wfp: { monthly: 25, includedReq: 20e6, perMReq: 0.30, includedCpuMs: 60e6, perMCpuMs: 0.02 },
};

// 每次請求建立一個全新（非持久）沙箱的單價；memory 以 1 分鐘為最小計費單位（官方：Provisioned Memory billed in 1 minute minimum increments）
function freshPerRequest({ vcpu = 1, activeCpuMs = 200, wallSec = 2 } = {}) {
  const memGb = vcpu * P.memGbPerVcpu;
  const memCost = memGb * (Math.max(wallSec, P.memMinBillSec) / 3600) * P.memGbHr;
  const cpuCost = (activeCpuMs / 3600_000) * P.cpuHr;
  const createCost = P.createPerM / 1e6;
  return { memCost, cpuCost, createCost, total: memCost + cpuCost + createCost };
}

// 每作品常駐一個暖沙箱（共用於多個訪客）：只算記憶體；以每月運作小時估
const warmPerWork = ({ vcpu = 1, hoursPerMonth = 720 } = {}) => vcpu * P.memGbPerVcpu * hoursPerMonth * P.memGbHr;

const wfpMonthly = ({ requests, cpuMsPerReq = 10 }) => P.wfp.monthly
  + Math.max(0, requests - P.wfp.includedReq) / 1e6 * P.wfp.perMReq
  + Math.max(0, requests * cpuMsPerReq - P.wfp.includedCpuMs) / 1e6 * P.wfp.perMCpuMs;

// 控制面額度：每次請求對管理通道的呼叫數（假設：建立＋執行＋停止＝3；暖沙箱＝1）
const maxReqPerMinByControlPlane = (callsPerReq, plan = 'pro') => Math.floor(P.controlPlaneRpm[plan] / callsPerReq);

module.exports = { P, freshPerRequest, warmPerWork, wfpMonthly, maxReqPerMinByControlPlane };

if (require.main === module) {
  const f = freshPerRequest();
  const fmt = (n) => `$${n.toFixed(6)}`;
  console.log('每請求新建沙箱（1 vCPU／2 GB；假設 Active CPU 200 ms；記憶體最低 1 分鐘）');
  console.log(' 記憶體', fmt(f.memCost), 'CPU', fmt(f.cpuCost), '建立', fmt(f.createCost), '合計', fmt(f.total), `→ 每千次 $${(f.total * 1000).toFixed(3)}`);
  for (const n of [10_000, 100_000, 1_000_000]) console.log(` ${n.toLocaleString()} 次／月：Vercel 新建沙箱 $${(f.total * n).toFixed(2)}；Cloudflare WfP（10 ms CPU）$${wfpMonthly({ requests: n }).toFixed(2)}`);
  console.log(`暖沙箱常駐（每作品、1 vCPU／2 GB、720 小時）：$${warmPerWork().toFixed(2)}／月（記憶體費，不含 CPU）`);
  console.log('控制面上限（Pro，10,000 rpm／team，假設每次請求 3 次管理呼叫）：', maxReqPerMinByControlPlane(3), '次／分（與 Agent、建置共用）');
  console.log('新建沙箱 vCPU 配置率（Pro 起始 150／分；1 vCPU 每請求）：', P.vcpuAllocPerMin.proStart, '次／分起，之後每分鐘 +500 至', P.vcpuAllocPerMin.proMax);
}
