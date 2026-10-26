import { describe, expect, it } from "vitest";
import {
  knownChatMessageErrorCodeSchema,
  sseErrorCodeSchema,
  sseErrorPayloadSchema,
  sseErrorProducerPayloadSchema,
  sseErrorRegistry,
  validateSseProducerPayload,
} from "@app-planet/core";

const message = "合成錯誤提示（草案，非正式文案）";
const payload = (code: string, retryable: boolean, extra: Record<string, unknown> = {}) => ({
  code,
  user_message_zh: message,
  retryable,
  ...extra,
});

describe("D-29b／F-05 SSE 專屬錯誤登錄", () => {
  it("只登錄四個 SSE 作用域碼", () => {
    expect(sseErrorCodeSchema.options).toEqual([
      "web_search_failed",
      "safety_check_unavailable",
      "generation_failed",
      "stream_internal_error",
    ]);
  });

  it.each([
    ["web_search_failed", true],
    ["safety_check_unavailable", true],
    ["generation_failed", true],
    ["generation_failed", false],
    ["stream_internal_error", false],
  ])("接受 %s 搭配 retryable=%s", (code, retryable) => {
    expect(sseErrorProducerPayloadSchema.safeParse(payload(code, retryable)).success).toBe(true);
    expect(validateSseProducerPayload("error", payload(code, retryable)).success).toBe(true);
  });

  it.each([
    ["web_search_failed", false],
    ["safety_check_unavailable", false],
    ["stream_internal_error", true],
  ])("拒絕 %s 搭配 retryable=%s（碼與可重試標記配對錯誤）", (code, retryable) => {
    expect(sseErrorProducerPayloadSchema.safeParse(payload(code, retryable)).success).toBe(false);
    expect(validateSseProducerPayload("error", payload(code, retryable)).success).toBe(false);
  });

  it("generation_failed 的 retryable 為必填布林，不把文字或 null 轉為布林", () => {
    for (const retryable of ["true", "false", null, undefined, 1]) {
      expect(
        sseErrorProducerPayloadSchema.safeParse({
          code: "generation_failed",
          user_message_zh: message,
          retryable,
        }).success,
      ).toBe(false);
    }
  });

  it("registry 記錄每碼的 retryable 規則、沿用候選模板 key，且文案審閱狀態為草案", () => {
    expect(sseErrorRegistry).toEqual({
      web_search_failed: {
        retryable: "always",
        templateKey: "sse_error_web_search_failed",
        messageReview: "draft_unreviewed",
      },
      safety_check_unavailable: {
        retryable: "always",
        templateKey: "sse_error_safety_check_unavailable",
        messageReview: "draft_unreviewed",
      },
      generation_failed: {
        retryable: "transient_only",
        templateKey: "sse_error_generation_failed",
        messageReview: "draft_unreviewed",
      },
      stream_internal_error: {
        retryable: "never",
        templateKey: "sse_error_stream_internal",
        messageReview: "draft_unreviewed",
      },
    });
  });
});

describe("HTTP 專屬碼與 SSE 碼分開", () => {
  const httpCodes = [
    "ai_not_open",
    "ai_off_duty",
    "school_not_confirmed",
    "quota_daily_exhausted",
    "pool_creator_exhausted",
  ];

  it("H-4 開串流前的 HTTP 五碼仍屬 HTTP 作用域，但在 SSE error 被拒絕", () => {
    for (const code of httpCodes) {
      expect(knownChatMessageErrorCodeSchema.safeParse(code).success).toBe(true);
      expect(sseErrorCodeSchema.safeParse(code).success).toBe(false);
      for (const retryable of [true, false]) {
        expect(sseErrorProducerPayloadSchema.safeParse(payload(code, retryable)).success).toBe(false);
        expect(validateSseProducerPayload("error", payload(code, retryable)).success).toBe(false);
      }
    }
  });

  it("SSE 四碼不屬 HTTP 碼表", () => {
    for (const code of sseErrorCodeSchema.options) {
      expect(knownChatMessageErrorCodeSchema.safeParse(code).success).toBe(false);
    }
  });

  it("未知碼拒絕：供應商碼、內部碼、其他作用域碼與 S4（依賴 D-14）都不被其他碼取代或登錄", () => {
    for (const code of [
      "synthetic_unregistered_code",
      "rate_limit_exceeded",
      "context_length_exceeded",
      "invalid_credentials",
      "account_unavailable",
      "idempotency_key_reuse",
      "duty_unset",
      "price_missing",
      "stream_gate_revalidation_failed",
      "school_revoked_mid_stream",
      "internal_error",
      "",
    ]) {
      expect(sseErrorProducerPayloadSchema.safeParse(payload(code, false)).success).toBe(false);
      expect(sseErrorProducerPayloadSchema.safeParse(payload(code, true)).success).toBe(false);
    }
    expect(sseErrorCodeSchema.options).toHaveLength(4);
  });

  it("不透傳供應商文字作為 code，也不接受非字串 code", () => {
    for (const code of ["Upstream 502 Bad Gateway: <html>", null, 1, undefined]) {
      expect(sseErrorProducerPayloadSchema.safeParse(payload(code as string, false)).success).toBe(
        false,
      );
    }
  });
});

describe("SSE error 維持 code／user_message_zh／retryable 三鍵", () => {
  it("拒絕 usage、安全欄位、template_key 或任何額外欄位", () => {
    for (const extra of [
      { usage: { reserved: 0, settled_display: 0 } },
      { safety_label: "synthetic" },
      { category_group: "inappropriate" },
      { template_key: "sse_error_generation_failed" },
      { request_id: "synthetic" },
      { extension: true },
    ]) {
      expect(
        sseErrorProducerPayloadSchema.safeParse(payload("generation_failed", true, extra)).success,
      ).toBe(false);
    }
  });

  it("拒絕缺少任一鍵", () => {
    for (const key of ["code", "user_message_zh", "retryable"]) {
      const value: Record<string, unknown> = payload("generation_failed", true);
      delete value[key];
      expect(sseErrorProducerPayloadSchema.safeParse(value).success).toBe(false);
    }
  });

  it("相容 reader 不變：仍接受任意字串 code 與擴充欄位，不代表 producer 白名單", () => {
    const value = payload("synthetic_error", false, { extension: true });
    expect(sseErrorPayloadSchema.parse(value)).toEqual(value);
  });
});
