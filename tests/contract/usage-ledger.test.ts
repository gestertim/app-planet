import { describe, expect, it } from "vitest";
import { taipeiPeriodKeys, usageSchema } from "@app-planet/core";

describe("費用輸入與 Taipei 邊界", () => {
  it.each([
    ["2026-10-31T15:59:59.999Z","2026-10-31","2026-10-01"],
    ["2026-10-31T16:00:00Z","2026-11-01","2026-11-01"],
    ["2028-02-29T16:00:00Z","2028-03-01","2028-03-01"],
  ])("%s 以台北日曆換期", (instant,day,month) => {
    expect(taipeiPeriodKeys(new Date(instant))).toEqual({day,month});
  });
  it("無效時間明示失敗", () => {
    expect(() => taipeiPeriodKeys(new Date("invalid"))).toThrow("invalid_input");
  });
  it("拒絕負值、cached 大於 input 與超出 JS 精度的 usage", () => {
    for (const input of [
      { input_tokens:-1,cached_input_tokens:0,output_tokens:0,images:0 },
      { input_tokens:1,cached_input_tokens:2,output_tokens:0,images:0 },
      { input_tokens:2**53,cached_input_tokens:0,output_tokens:0,images:0 },
    ]) expect(usageSchema.safeParse(input).success).toBe(false);
  });
});
