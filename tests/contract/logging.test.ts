import { describe, expect, it } from "vitest";
import {
  buildDiagnosticLogDto,
  createDiagnosticLogPolicy,
  validateDiagnosticLogDto,
} from "@app-planet/core";

const policyResult = createDiagnosticLogPolicy({
  routeIds: ["synthetic_sign_in", "synthetic_profile_read"],
  httpErrorCodes: ["school_not_confirmed"],
});

if (!policyResult.ok) {
  throw new Error("Invalid synthetic diagnostic logging policy");
}

const policy = policyResult.policy;

const validMetadata = () => ({
  request_id: "opaque-request-7f3a",
  route: "synthetic_sign_in",
  status_code: 401,
  duration: 12.5,
});

describe("診斷日誌白名單建構", () => {
  it("由合法合成 metadata 逐欄建構精確 DTO", () => {
    const result = buildDiagnosticLogDto(
      {
        ...validMetadata(),
        aid: "synthetic-aid-0042",
        error_code: "school_not_confirmed",
      },
      policy,
    );

    expect(result).toEqual({
      ok: true,
      data: {
        request_id: "opaque-request-7f3a",
        route: "synthetic_sign_in",
        status_code: 401,
        duration: 12.5,
        aid: "synthetic-aid-0042",
        error_code: "school_not_confirmed",
      },
    });
    if (result.ok) {
      expect(validateDiagnosticLogDto(result.data, policy)).toEqual({ ok: true });
    }
  });

  it("捨棄額外與巢狀敏感欄位，不帶入錯誤或供應商物件", () => {
    const nestedSecret = Object.freeze({
      Authorization: "Bearer SYNTHETIC_FAKE_TOKEN",
      Cookie: "session=SYNTHETIC_FAKE_COOKIE",
      conversation: "SYNTHETIC_FAKE_DIALOGUE",
    });
    const metadata = Object.freeze({
      ...validMetadata(),
      request_body: {
        login_code: "SYNTHETIC_FAKE_LOGIN_CODE",
        password: "SYNTHETIC_FAKE_PASSWORD",
        jwt: "SYNTHETIC_FAKE_JWT",
        api_key: "SYNTHETIC_FAKE_API_KEY",
      },
      response_body: { file_contents: "SYNTHETIC_FAKE_WORK" },
      headers: { "Set-Cookie": "SYNTHETIC_FAKE_COOKIE" },
      raw_ip: "SYNTHETIC_FAKE_IP",
      preview_id: "SYNTHETIC_FAKE_PREVIEW_ID",
      error: new Error("SYNTHETIC_FAKE_ERROR_MESSAGE", { cause: "SYNTHETIC_FAKE_CAUSE" }),
      provider_response: { nestedSecret },
      meta: { nestedSecret },
    });

    const result = buildDiagnosticLogDto(metadata, policy);

    expect(result).toEqual({
      ok: true,
      data: {
        request_id: "opaque-request-7f3a",
        route: "synthetic_sign_in",
        status_code: 401,
        duration: 12.5,
      },
    });
    if (result.ok) {
      expect(result.data).not.toBe(metadata);
      expect(result.data).not.toHaveProperty("meta");
      expect(Object.values(result.data)).not.toContain(nestedSecret);
    }
  });

  it("必要欄位缺漏或錯型別時回固定失敗", () => {
    const missingRequestId: Record<string, unknown> = { ...validMetadata() };
    delete missingRequestId.request_id;

    for (const input of [
      missingRequestId,
      { ...validMetadata(), status_code: "401" },
      { ...validMetadata(), duration: Number.NaN },
      { ...validMetadata(), aid: null },
    ]) {
      expect(buildDiagnosticLogDto(input, policy)).toEqual({
        ok: false,
        code: "invalid_log_record",
      });
    }
  });

  it("只接受可信設定的 route ID，不接受原始 URL、查詢字串或未登錄路由", () => {
    expect(
      buildDiagnosticLogDto({ ...validMetadata(), route: "/api/v1/me?token=SYNTHETIC" }, policy),
    ).toEqual({ ok: false, code: "invalid_log_record" });
    expect(
      buildDiagnosticLogDto({ ...validMetadata(), route: "synthetic_sign_in?account=x" }, policy),
    ).toEqual({ ok: false, code: "invalid_log_record" });
    expect(
      buildDiagnosticLogDto({ ...validMetadata(), route: "synthetic_unknown_route" }, policy),
    ).toEqual({ ok: false, code: "invalid_log_record" });
  });

  it("只接受可信設定的 HTTP 錯誤碼，不透傳供應商文字或 SSE 碼", () => {
    expect(
      buildDiagnosticLogDto({ ...validMetadata(), error_code: "school_not_confirmed" }, policy).ok,
    ).toBe(true);
    expect(
      createDiagnosticLogPolicy({
        routeIds: ["synthetic_sign_in"],
        httpErrorCodes: ["generation_failed"],
      }),
    ).toEqual({ ok: false, code: "invalid_log_record" });

    for (const error_code of [
      "Upstream 502: SYNTHETIC_FAKE_PROVIDER_RESPONSE",
      "generation_failed",
    ]) {
      expect(buildDiagnosticLogDto({ ...validMetadata(), error_code }, policy)).toEqual({
        ok: false,
        code: "invalid_log_record",
      });
    }
  });

  it("接受非 UUID opaque request ID，但不替來源內容背書", () => {
    const result = buildDiagnosticLogDto(
      { ...validMetadata(), request_id: "opaque-synthetic-request-A7" },
      policy,
    );

    expect(result.ok).toBe(true);
  });

  it("失敗結果不回顯非法值或驗證細節，輸入保持不變且不保留巢狀參照", () => {
    const metadata = Object.freeze({
      ...validMetadata(),
      route: "SYNTHETIC_FAKE_RAW_ROUTE?token=NOT_A_REAL_SECRET",
      meta: Object.freeze({ nested: Object.freeze({ value: "SYNTHETIC_FAKE_VALUE" }) }),
    });
    const result = buildDiagnosticLogDto(metadata, policy);

    expect(result).toEqual({ ok: false, code: "invalid_log_record" });
    expect(Object.keys(metadata)).toContain("meta");
    expect(validateDiagnosticLogDto({ ...validMetadata(), unexpected: metadata.meta }, policy)).toEqual({
      ok: false,
      code: "invalid_log_record",
    });
    expect(validateDiagnosticLogDto(new Error("SYNTHETIC_FAKE_ERROR"), policy)).toEqual({
      ok: false,
      code: "invalid_log_record",
    });

    const dtoWithHiddenField = { ...validMetadata() };
    Object.defineProperty(dtoWithHiddenField, "hidden", {
      value: "SYNTHETIC_FAKE_VALUE",
    });
    expect(validateDiagnosticLogDto(dtoWithHiddenField, policy)).toEqual({
      ok: false,
      code: "invalid_log_record",
    });
  });
});
