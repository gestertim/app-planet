import { defineConfig } from "vitest/config";

// 隔離層級：unit／contract 為純合成、不連線；隔離 PostgreSQL 整合測試由
// vitest.authorization.config.ts／vitest.projects.config.ts 經 scripts/pgtap-local.ps1 執行；
// 瀏覽器測試由 playwright.config.ts 負責；pgTAP 由 supabase/tests 與同一 runner 負責。
export default defineConfig({
  resolve: {
    alias: {
      "@": new URL("./apps/web/src", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"),
      "server-only": new URL("./node_modules/next/dist/compiled/server-only/empty.js", import.meta.url)
        .pathname.replace(/^\/([A-Za-z]:)/, "$1"),
    },
  },
  test: {
    environment: "node",
    setupFiles: ["tests/support/setup-isolation.ts"],
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          include: ["tests/unit/**/*.test.ts"],
        },
      },
      {
        extends: true,
        test: {
          name: "contract",
          include: ["tests/contract/**/*.test.ts"],
        },
      },
    ],
  },
});
