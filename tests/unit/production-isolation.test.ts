import { describe, expect, it } from "vitest";
import {
  assertNoProductionTestEnvironment,
  findProductionTestEnvironmentViolations,
} from "../support/production-isolation.ts";

describe("T004 正式環境測試隔離", () => {
  it("乾淨環境沒有違規，並且不修改輸入", () => {
    const environment = Object.freeze({ NODE_ENV: "test", APP_PLANET_ENV: "test" });
    expect(findProductionTestEnvironmentViolations(environment)).toEqual([]);
    expect(() => assertNoProductionTestEnvironment(environment)).not.toThrow();
  });

  it("拒絕正式環境標記與真實服務憑證名稱，且錯誤訊息只含名稱不含值", () => {
    const secretLookingValue = "synthetic-value-that-must-not-leak";
    const environment = {
      APP_PLANET_ENV: " Production ",
      OPENAI_API_KEY: secretLookingValue,
      SUPABASE_SERVICE_ROLE_KEY: secretLookingValue,
      VERCEL_TOKEN: "",
    };
    expect(findProductionTestEnvironmentViolations(environment)).toEqual([
      "APP_PLANET_ENV",
      "SUPABASE_SERVICE_ROLE_KEY",
      "OPENAI_API_KEY",
    ]);
    try {
      assertNoProductionTestEnvironment(environment);
      expect.unreachable("應拒絕含正式環境標記的程序");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).toContain("OPENAI_API_KEY");
      expect(message).not.toContain(secretLookingValue);
    }
  });

  it("目前測試程序本身沒有被注入正式環境或真實服務憑證", () => {
    expect(findProductionTestEnvironmentViolations(process.env)).toEqual([]);
  });
});
