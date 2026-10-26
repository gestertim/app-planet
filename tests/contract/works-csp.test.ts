import { describe, expect, it } from "vitest";
import { buildWorksCsp } from "@app-planet/core";

const base = "default-src 'self'; connect-src 'self'; form-action 'self'; base-uri 'self'";
const excluded = ["works.example.test", "preview.example.test"];
const preview = (platformFrameOrigins?: readonly string[], excludedFrameDomains: readonly string[] | null = excluded) => ({
  mode: "preview" as const,
  ...(platformFrameOrigins === undefined ? {} : { platformFrameOrigins }),
  ...(excludedFrameDomains === null ? {} : { excludedFrameDomains }),
});

describe("T013 works_csp_policy", () => {
  it("公開模式固定 frame-ancestors 'none'，不受任何額外 frame 來源參數影響", () => {
    const expected = { policy: `${base}; frame-ancestors 'none'`, frameAncestors: "none", failClosed: false };
    expect(buildWorksCsp({ mode: "public" })).toEqual(expected);
    const widened = { mode: "public", platformFrameOrigins: ["https://app.example.test"] } as unknown as Parameters<typeof buildWorksCsp>[0];
    expect(buildWorksCsp(widened)).toEqual(expected);
  });

  it("預覽模式只輸出可信設定中的明確 https 平台 origin，其餘指令與公開模式相同", () => {
    expect(buildWorksCsp(preview(["https://app.example.test", "https://admin.example.test:8443"]))).toEqual({
      policy: `${base}; frame-ancestors https://app.example.test https://admin.example.test:8443`,
      frameAncestors: "origins",
      failClosed: false,
    });
  });

  it("預覽 origin 去除重複並保留設定順序", () => {
    const result = buildWorksCsp(preview(["https://b.example.test", "https://a.example.test", "https://b.example.test"]));
    expect(result.policy.endsWith("frame-ancestors https://b.example.test https://a.example.test")).toBe(true);
  });

  const failClosed = { policy: `${base}; frame-ancestors 'none'`, frameAncestors: "none", failClosed: true };
  it.each([
    ["缺少清單", undefined],
    ["空清單", []],
    ["萬用字元", ["*"]],
    ["萬用字元子網域", ["https://*.example.test"]],
    ["單獨 scheme", ["https:"]],
    ["data scheme", ["data:"]],
    ["http origin", ["http://app.example.test"]],
    ["帶路徑", ["https://app.example.test/path"]],
    ["尾端斜線", ["https://app.example.test/"]],
    ["含 userinfo", ["https://user:pass@app.example.test"]],
    ["預設連接埠寫明", ["https://app.example.test:443"]],
    ["大寫主機", ["https://APP.example.test"]],
    ["works_domain 下的主機", ["https://x.works.example.test"]],
    ["preview_domain 本身", ["https://preview.example.test"]],
    ["IP 字面值", ["https://203.0.113.9"]],
    ["IPv6 字面值", ["https://[::1]"]],
    ["夾帶指令注入", ["https://app.example.test; script-src *"]],
    ["夾帶空白第二來源", ["https://app.example.test https://evil.example.test"]],
    ["任一項不合法即整份退回", ["https://app.example.test", "*"]],
    ["非字串", [42 as unknown as string]],
  ])("預覽設定無效時 fail-closed 為 'none'：%s", (_name, origins) => {
    expect(buildWorksCsp(preview(origins))).toEqual(failClosed);
  });

  it("預覽缺少 works／preview 網域排除清單時無法驗證，fail-closed", () => {
    expect(buildWorksCsp(preview(["https://app.example.test"], null))).toEqual(failClosed);
    expect(buildWorksCsp(preview(["https://app.example.test"], []))).toEqual(failClosed);
    expect(buildWorksCsp(preview(["https://app.example.test"], ["Works.Example.Test"]))).toEqual(failClosed);
  });

  it("未知模式 fail-closed，且所有輸出都不含萬用字元與 AI 端點", () => {
    expect(buildWorksCsp({ mode: "other" } as unknown as Parameters<typeof buildWorksCsp>[0])).toEqual(failClosed);
    for (const result of [buildWorksCsp({ mode: "public" }), buildWorksCsp(preview(["https://app.example.test"]))]) {
      expect(result.policy).not.toContain("*");
      expect(result.policy).not.toMatch(/openai|anthropic|gateway/i);
      expect(result.policy).toContain("form-action 'self'");
      expect(result.policy).toContain("base-uri 'self'");
    }
  });
});
