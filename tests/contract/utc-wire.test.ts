import { describe, expect, it } from "vitest";
import {
  compareUtcInstants,
  jobSnapshotCoreShapeSchema,
  sseDeltaProducerPayloadSchema,
  utcInstantSchema,
} from "@app-planet/core";

// UTC 決策 A：契約明定的時刻欄位，wire 值使用 ISO 8601 UTC，必須以大寫 Z 結尾；
// 不接受 +00:00 或其他偏移；不決定小數秒位數、輸出寬度或資料庫精度。
describe("UTC wire 規則（決策 A）", () => {
  it.each([
    "2026-10-23T02:55:01Z",
    "2026-10-23T02:55:01.1Z",
    "2026-10-23T02:55:01.100Z",
    "2026-10-23T02:55:01.000123456Z",
    "2028-02-29T00:00:00Z",
  ])("接受大寫 Z 結尾：%s", (value) => {
    expect(utcInstantSchema.safeParse(value).success).toBe(true);
  });

  it.each([
    ["小寫 z", "2026-10-23T02:55:01z"],
    ["+00:00 偏移", "2026-10-23T02:55:01+00:00"],
    ["-00:00 偏移", "2026-10-23T02:55:01-00:00"],
    ["+08:00 偏移", "2026-10-23T10:55:01+08:00"],
    ["無偏移（naive）", "2026-10-23T02:55:01"],
    ["無偏移含小數秒", "2026-10-23T02:55:01.123"],
    ["純日期", "2026-10-23"],
    ["空白分隔", "2026-10-23 02:55:01Z"],
    ["前後空白", " 2026-10-23T02:55:01Z "],
    ["不存在的日期", "2026-02-30T00:00:00Z"],
    ["非閏年 2 月 29 日", "2026-02-29T00:00:00Z"],
    ["非字串", 1761188101],
  ])("拒絕：%s", (_label, value) => {
    expect(utcInstantSchema.safeParse(value).success).toBe(false);
  });

  it("同一規則套用於 Job 快照時刻欄位：小寫 z、偏移與 naive 被拒絕", () => {
    const snapshot = (started_at: string, updated_at: string) => ({
      id: "123e4567-e89b-42d3-a456-426614174000",
      kind: "preview_build",
      state: "building",
      progress: { mode: "indeterminate" },
      started_at,
      updated_at,
    });
    expect(
      jobSnapshotCoreShapeSchema.safeParse(
        snapshot("2026-10-23T02:00:00Z", "2026-10-23T02:01:00.5Z"),
      ).success,
    ).toBe(true);
    for (const bad of [
      "2026-10-23T02:01:00z",
      "2026-10-23T02:01:00+00:00",
      "2026-10-23T10:01:00+08:00",
      "2026-10-23T02:01:00",
    ]) {
      expect(jobSnapshotCoreShapeSchema.safeParse(snapshot("2026-10-23T02:00:00Z", bad)).success).toBe(
        false,
      );
      expect(jobSnapshotCoreShapeSchema.safeParse(snapshot(bad, "2026-10-23T02:02:00Z")).success).toBe(
        false,
      );
    }
  });

  it("不誤驗自由文字：對話片段等內容中的任何時間樣式字串不受時刻規則檢查", () => {
    for (const text of [
      "會議在 2026-10-23T10:55:01+08:00 開始",
      "2026-10-23T02:55:01z",
      "2026-10-23",
      "放學後 3:30",
    ]) {
      expect(sseDeltaProducerPayloadSchema.safeParse({ seq: 1, text }).success).toBe(true);
    }
  });

  it("保留合法小數秒與不丟精度比較：字串不同不代表時刻不同", () => {
    expect(compareUtcInstants("2026-10-23T02:55:01.1Z", "2026-10-23T02:55:01.100Z")).toBe(0);
    expect(compareUtcInstants("2026-10-23T02:55:01Z", "2026-10-23T02:55:01.000Z")).toBe(0);
    expect(compareUtcInstants("2026-10-23T02:55:01.0009Z", "2026-10-23T02:55:01.0001Z")).toBe(1);
    expect(compareUtcInstants("2026-10-23T02:55:01.9999999Z", "2026-10-23T02:55:02Z")).toBe(-1);
  });

  it("比較函式對非 UTC Z 表示 fail-closed 回傳 null，不嘗試換算偏移", () => {
    for (const other of [
      "2026-10-23T02:55:01+00:00",
      "2026-10-23T10:55:01+08:00",
      "2026-10-23T02:55:01z",
      "2026-10-23T02:55:01",
      "not-a-time",
    ]) {
      expect(compareUtcInstants(other, "2026-10-23T02:55:01Z")).toBeNull();
      expect(compareUtcInstants("2026-10-23T02:55:01Z", other)).toBeNull();
    }
  });
});
