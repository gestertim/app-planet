import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  agentRules: false,
  reactStrictMode: true,
  // 電郵驗證落點的 query 含一次性 token_hash；不寫入開發伺服器請求日誌。
  logging: { incomingRequests: { ignore: [/\/auth\/confirm(?:[?#]|$)/] } },
};

export default nextConfig;
