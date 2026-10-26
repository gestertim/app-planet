import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  accessContextSchema,
  canAccessRoleHome,
  decideCapability,
  doneUsageSchema,
  eventCursorUnavailableErrorCodeSchema,
  fileIfMatchSchema,
  ifMatchRequiredErrorCodeSchema,
  idempotencyKeySchema,
  invalidEventCursorErrorCodeSchema,
  invalidIfMatchErrorCodeSchema,
  jobBaseStateSchema,
  jobSnapshotCoreShapeSchema,
  knownChatMessageErrorCodeSchema,
  parseFileIfMatch,
  parseRowIfMatch,
  problemJsonSchema,
  projectTierSchema,
  requestIdSchema,
  rowVersionSchema,
  rowIfMatchSchema,
  sseBlockPayloadSchema,
  sseBlockProducerPayloadSchema,
  sseDeltaProducerPayloadSchema,
  sseDoneProducerPayloadSchema,
  sseErrorPayloadSchema,
  sseErrorProducerPayloadSchema,
  sseEventNameSchema,
  sseEventCursorSchema,
  sseNativeEventFieldsSchema,
  ssePartialProducerPayloadSchema,
  sseSupportProducerPayloadSchema,
  sseSupportPayloadSchema,
  unknownFieldErrorCodeSchema,
  validateSseProducerPayload,
  type AccessContext,
} from "@app-planet/core";

describe("共用套件公開入口", () => {
  it("透過 workspace 套件解析到既有 TypeScript 公開入口", () => {
    const entry = createRequire(import.meta.url).resolve("@app-planet/core");
    expect(realpathSync(entry)).toBe(
      realpathSync(fileURLToPath(new URL("../../packages/core/index.ts", import.meta.url))),
    );
  });
});

const student = (overrides: Partial<AccessContext> = {}): AccessContext => ({
  role: "student",
  accountStatus: "approved",
  deletionState: "none",
  schoolApproval: "approved",
  aiOnDuty: true,
  ...overrides,
});

describe("accessContextSchema", () => {
  it("rejects student contexts that do not identify a school state", () => {
    expect(
      accessContextSchema.safeParse({
        role: "student",
        accountStatus: "approved",
        deletionState: "none",
        schoolApproval: null,
        aiOnDuty: true,
      }).success,
    ).toBe(false);
  });

  it("rejects unknown roles and account states", () => {
    expect(
      accessContextSchema.safeParse({
        ...student(),
        role: "owner",
      }).success,
    ).toBe(false);
    expect(
      accessContextSchema.safeParse({
        ...student(),
        accountStatus: "active",
      }).success,
    ).toBe(false);
  });

  it("rejects unmodeled fields rather than silently accepting personal data", () => {
    expect(
      accessContextSchema.safeParse({
        ...student(),
        studentName: "不應輸入的欄位",
      }).success,
    ).toBe(false);
  });
});

describe("projectTierSchema", () => {
  it("accepts only the A and B tiers in the current MVP", () => {
    expect(projectTierSchema.safeParse("A").success).toBe(true);
    expect(projectTierSchema.safeParse("B").success).toBe(true);
    expect(projectTierSchema.safeParse("C").success).toBe(false);
  });
});

describe("decideCapability", () => {
  it("allows pending staff to log in only to a restricted status view", () => {
    const pendingTeacher: AccessContext = {
      role: "teacher",
      accountStatus: "pending",
      deletionState: "none",
      schoolApproval: null,
      aiOnDuty: false,
    };

    expect(decideCapability(pendingTeacher, "login").allowed).toBe(true);
    expect(decideCapability(pendingTeacher, "read_saved_content")).toEqual({
      allowed: false,
      code: "account_unavailable",
    });
    expect(canAccessRoleHome(pendingTeacher, "teacher")).toBe(false);
  });

  it("blocks student login when school approval is unconfirmed", () => {
    expect(decideCapability(student({ schoolApproval: "unconfirmed" }), "login")).toEqual({
      allowed: false,
      code: "school_not_confirmed",
    });
  });

  it("allows saved content and review submission after withdrawal but blocks AI and deployment", () => {
    const withdrawn = student({ schoolApproval: "withdrawn" });

    expect(decideCapability(withdrawn, "login").allowed).toBe(true);
    expect(decideCapability(withdrawn, "read_saved_content").allowed).toBe(true);
    expect(decideCapability(withdrawn, "edit_saved_content").allowed).toBe(true);
    expect(decideCapability(withdrawn, "submit_for_review").allowed).toBe(true);
    expect(decideCapability(withdrawn, "ai_call")).toEqual({
      allowed: false,
      code: "ai_not_open",
    });
    expect(decideCapability(withdrawn, "public_deploy")).toEqual({
      allowed: false,
      code: "public_deploy_paused",
    });
  });

  describe("學校核准 expired 的政策邊界", () => {
    const cases = [
      ["login", { allowed: true, code: "allowed" }],
      ["read_saved_content", { allowed: true, code: "allowed" }],
      ["edit_saved_content", { allowed: true, code: "allowed" }],
      ["ai_call", { allowed: false, code: "ai_not_open" }],
      ["public_deploy", { allowed: false, code: "public_deploy_paused" }],
    ] as const;

    it.each(cases)("%s：對照學校已核准與核准失效的結果", (capability, expiredDecision) => {
      expect(decideCapability(student(), capability)).toEqual({
        allowed: true,
        code: "allowed",
      });
      expect(
        decideCapability(student({ schoolApproval: "expired" }), capability),
      ).toEqual(expiredDecision);
    });

    it.each(["pending", "rejected", "disabled"] as const)(
      "帳號 %s 不會因學校 expired 的例外取得能力",
      (accountStatus) => {
        for (const [capability] of cases) {
          expect(
            decideCapability(student({ accountStatus, schoolApproval: "expired" }), capability),
          ).toEqual({ allowed: false, code: "account_unavailable" });
        }
      },
    );

    it.each(["marked", "purging", "purge_failed", "purged"] as const)(
      "刪除狀態 %s 不會因學校 expired 的例外恢復存取",
      (deletionState) => {
        for (const [capability] of cases) {
          expect(
            decideCapability(student({ deletionState, schoolApproval: "expired" }), capability),
          ).toEqual({ allowed: false, code: "account_unavailable" });
        }
      },
    );

    it("未確認學校不適用 expired 的登入與保存內容例外", () => {
      for (const [capability] of cases) {
        expect(
          decideCapability(student({ schoolApproval: "unconfirmed" }), capability),
        ).toEqual({ allowed: false, code: "school_not_confirmed" });
      }
    });
  });

  it("keeps AI closed outside approved duty hours", () => {
    expect(decideCapability(student({ aiOnDuty: false }), "ai_call")).toEqual({
      allowed: false,
      code: "ai_off_duty",
    });
  });

  it("rejects disabled and deletion-marked accounts", () => {
    expect(decideCapability(student({ accountStatus: "disabled" }), "read_saved_content")).toEqual({
      allowed: false,
      code: "account_unavailable",
    });
    expect(decideCapability(student({ deletionState: "marked" }), "read_saved_content")).toEqual({
      allowed: false,
      code: "account_unavailable",
    });
  });

  it("fails closed for malformed capability input", () => {
    expect(decideCapability(student(), "run_sandbox")).toEqual({
      allowed: false,
      code: "invalid_input",
    });
  });
});

describe("canAccessRoleHome", () => {
  it("requires an approved matching role", () => {
    expect(canAccessRoleHome(student(), "student")).toBe(true);
    expect(canAccessRoleHome(student(), "teacher")).toBe(false);
    expect(canAccessRoleHome(student({ accountStatus: "pending" }), "student")).toBe(false);
  });

  it("學校 expired 不授予其他角色首頁，也不繞過帳號停用或刪除", () => {
    const expired = student({ schoolApproval: "expired" });

    expect(canAccessRoleHome(expired, "student")).toBe(true);
    expect(canAccessRoleHome(expired, "teacher")).toBe(false);
    expect(canAccessRoleHome(expired, "admin")).toBe(false);
    expect(canAccessRoleHome({ ...expired, accountStatus: "disabled" }, "student")).toBe(false);
    expect(canAccessRoleHome({ ...expired, deletionState: "marked" }, "student")).toBe(false);
  });
});

describe("problemJsonSchema：契約通則的錯誤形狀", () => {
  const problem = {
    type: "urn:app-planet:problem:school-not-confirmed",
    title: "學校核准尚未確認",
    status: 403,
    code: "school_not_confirmed",
    instance: "/api/v1/synthetic-operation",
    request_id: "synthetic-request",
    user_message_zh: "合成測試：請先確認學校核准狀態。",
  };

  it("接受必要欄位，以及選填的 detail 文字", () => {
    expect(problemJsonSchema.parse(problem)).toEqual(problem);
    const withDetail = { ...problem, detail: "合成測試說明" };
    expect(problemJsonSchema.parse(withDetail)).toEqual(withDetail);
  });

  it("拒絕缺少任一必要欄位", () => {
    for (const field of Object.keys(problem)) {
      const incomplete: Record<string, unknown> = { ...problem };
      delete incomplete[field];
      expect(problemJsonSchema.safeParse(incomplete).success, field).toBe(false);
    }
  });

  it("拒絕錯誤型別及未定義為可空的必要欄位", () => {
    for (const field of Object.keys(problem)) {
      const wrongType = field === "status" ? "403" : 403;
      expect(
        problemJsonSchema.safeParse({ ...problem, [field]: wrongType }).success,
        field,
      ).toBe(false);
      expect(
        problemJsonSchema.safeParse({ ...problem, [field]: null }).success,
        field,
      ).toBe(false);
    }
    expect(problemJsonSchema.safeParse({ ...problem, status: 403.5 }).success).toBe(false);
    expect(problemJsonSchema.safeParse({ ...problem, detail: 1 }).success).toBe(false);
    expect(problemJsonSchema.safeParse({ ...problem, detail: null }).success).toBe(false);
  });

  it("不將通則舉例的 code 當成封閉列舉", () => {
    expect(
      problemJsonSchema.safeParse({ ...problem, code: "synthetic_future_code" }).success,
    ).toBe(true);
  });
});

describe("requestIdSchema：非空 opaque 字串，不套用冪等鍵的 UUID 規則", () => {
  it("接受合成識別字串，拒絕非字串", () => {
    expect(requestIdSchema.parse("synthetic-request")).toBe("synthetic-request");
    for (const input of [undefined, null, 1, {}]) {
      expect(requestIdSchema.safeParse(input).success).toBe(false);
    }
  });
});

describe("jobBaseStateSchema：僅資料模型 §4.2 的基礎狀態", () => {
  it.each(["queued", "leased", "done", "failed", "cancelled"])(
    "接受基礎狀態 %s，不代表驗證狀態轉移或完整 job",
    (state) => {
      expect(jobBaseStateSchema.parse(state)).toBe(state);
    },
  );

  it("拒絕基礎列舉以外的值與錯誤型別", () => {
    for (const input of ["completed", "QUEUED", null, 1, {}]) {
      expect(jobBaseStateSchema.safeParse(input).success).toBe(false);
    }
  });
});

describe("SSE：事件名稱與既有相容 reader payload 子集", () => {
  it("接受 CHAT §3 的六種事件名稱，包含通則未列的 support", () => {
    for (const event of ["delta", "block", "support", "partial", "done", "error"]) {
      expect(sseEventNameSchema.parse(event)).toBe(event);
    }
    for (const event of ["complete", "DELTA", undefined, null, 1]) {
      expect(sseEventNameSchema.safeParse(event).success).toBe(false);
    }
  });

  it("接受 block 的固定類別與替代引導 key", () => {
    const payload = {
      category_group: "inappropriate",
      safe_alternative_key: "synthetic-alternative",
    };
    expect(sseBlockPayloadSchema.parse(payload)).toEqual(payload);
  });

  it("拒絕 block 缺欄位、非固定類別與錯誤 key 型別", () => {
    for (const payload of [
      { category_group: "inappropriate" },
      { safe_alternative_key: "synthetic-alternative" },
      { category_group: "support", safe_alternative_key: "synthetic-alternative" },
      { category_group: "inappropriate", safe_alternative_key: 1 },
      { category_group: "inappropriate", safe_alternative_key: null },
    ]) {
      expect(sseBlockPayloadSchema.safeParse(payload).success).toBe(false);
    }
  });

  it("接受 support 的兩種分流與模板 key", () => {
    for (const level of ["support", "high_risk"]) {
      const payload = { level, template_key: "synthetic-support" };
      expect(sseSupportPayloadSchema.parse(payload)).toEqual(payload);
    }
  });

  it("拒絕 support 缺欄位、未知分流與錯誤模板 key 型別", () => {
    for (const payload of [
      { level: "support" },
      { template_key: "synthetic-support" },
      { level: "blocked", template_key: "synthetic-support" },
      { level: "support", template_key: 1 },
      { level: "support", template_key: null },
    ]) {
      expect(sseSupportPayloadSchema.safeParse(payload).success).toBe(false);
    }
  });

  it("相容 reader 接受字串 code、繁中訊息與布林重試標記，不代表受控碼表（producer 白名單見 SSE 專屬登錄）", () => {
    for (const retryable of [true, false]) {
      const payload = {
        code: "synthetic_error",
        user_message_zh: "合成測試錯誤：尚未執行任何請求。",
        retryable,
      };
      expect(sseErrorPayloadSchema.parse(payload)).toEqual(payload);
    }
  });

  it("拒絕 error 缺欄位及錯誤型別，不將文字 false 轉為布林值", () => {
    for (const payload of [
      { user_message_zh: "合成測試", retryable: false },
      { code: "synthetic_error", retryable: false },
      { code: "synthetic_error", user_message_zh: "合成測試" },
      { code: 1, user_message_zh: "合成測試", retryable: false },
      { code: "synthetic_error", user_message_zh: 1, retryable: false },
      { code: "synthetic_error", user_message_zh: "合成測試", retryable: "false" },
      { code: "synthetic_error", user_message_zh: "合成測試", retryable: null },
    ]) {
      expect(sseErrorPayloadSchema.safeParse(payload).success).toBe(false);
    }
  });
});

describe("idempotencyKeySchema：僅 UUID 文字表示", () => {
  it("接受不同版本與大小寫，不限定範例 UUID 或強制轉小寫", () => {
    for (const key of [
      "123e4567-e89b-12d3-a456-426614174000",
      "123e4567-e89b-42d3-a456-426614174000",
      "01890f3e-7b4a-7cc1-9d64-123456789abc",
      "123E4567-E89B-42D3-A456-426614174000",
      "00000000-0000-0000-0000-000000000000",
    ]) {
      expect(idempotencyKeySchema.parse(key)).toBe(key);
    }
  });

  it("拒絕非 UUID 表示、額外前後綴與錯誤型別，不自動修剪", () => {
    for (const input of [
      "synthetic-key",
      "123e4567e89b42d3a456426614174000",
      "g23e4567-e89b-42d3-a456-426614174000",
      "123e4567-e89b-42d3-7456-426614174000",
      " 123e4567-e89b-42d3-a456-426614174000",
      "123e4567-e89b-42d3-a456-426614174000 ",
      undefined,
      null,
      1,
    ]) {
      expect(idempotencyKeySchema.safeParse(input).success).toBe(false);
    }
  });
});

describe("rowVersionSchema：版本數值，不是 If-Match 標頭解析器", () => {
  it("接受整數，不自行加入正值、起始版本或遞增規則", () => {
    for (const version of [-1, 0, 1, 2]) {
      expect(rowVersionSchema.parse(version)).toBe(version);
    }
  });

  it("拒絕非整數與非數值，不把 HTTP 標頭文字轉為版本", () => {
    for (const input of [1.5, "1", '"1"', 'W/"1"', "*", undefined, null, NaN, Infinity]) {
      expect(rowVersionSchema.safeParse(input).success).toBe(false);
    }
  });
});

describe("D-29a request id：保留 opaque 字串", () => {
  it("接受非 UUID 的非空合成識別字串，並拒絕空值", () => {
    expect(requestIdSchema.parse("opaque/request:synthetic")).toBe("opaque/request:synthetic");
    expect(requestIdSchema.safeParse("").success).toBe(false);
  });
});

describe("D-28 If-Match 純字串驗證", () => {
  it("接受 row canonical quoted decimal，包括契約未限制正負的整數版本", () => {
    for (const [tag, version] of [['"0"', "0"], ['"12"', "12"], ['"-3"', "-3"]]) {
      expect(rowIfMatchSchema.parse(tag)).toBe(tag);
      expect(parseRowIfMatch(tag)).toBe(version);
    }
  });

  it("拒絕非單一 strong quoted canonical row tag", () => {
    for (const value of [
      "7",
      'W/"7"',
      '"07"',
      '"-0"',
      '""',
      '"7", "8"',
      "*",
      '"7" ',
    ]) {
      expect(rowIfMatchSchema.safeParse(value).success, value).toBe(false);
      expect(parseRowIfMatch(value), value).toBeNull();
    }
  });

  it("接受該檔的小寫 64 位 SHA-256 strong quoted tag", () => {
    const hash = "a".repeat(64);
    expect(fileIfMatchSchema.parse(`"${hash}"`)).toBe(`"${hash}"`);
    expect(parseFileIfMatch(`"${hash}"`)).toBe(hash);
  });

  it("拒絕 file tag 的錯誤長度、大小寫、weak、wildcard 與多值", () => {
    for (const value of [
      `"${"a".repeat(63)}"`,
      `"${"A".repeat(64)}"`,
      `W/"${"a".repeat(64)}"`,
      "*",
      `"${"a".repeat(64)}", "${"b".repeat(64)}"`,
    ]) {
      expect(fileIfMatchSchema.safeParse(value).success, value).toBe(false);
      expect(parseFileIfMatch(value), value).toBeNull();
    }
  });

  it("只提供契約明列的作用域錯誤碼，不把它們當成完整碼表", () => {
    expect(ifMatchRequiredErrorCodeSchema.parse("if_match_required")).toBe("if_match_required");
    expect(invalidIfMatchErrorCodeSchema.parse("invalid_if_match")).toBe("invalid_if_match");
    expect(
      eventCursorUnavailableErrorCodeSchema.parse("event_cursor_unavailable"),
    ).toBe("event_cursor_unavailable");
    expect(invalidEventCursorErrorCodeSchema.parse("invalid_event_cursor")).toBe(
      "invalid_event_cursor",
    );
    expect(unknownFieldErrorCodeSchema.parse("unknown_field")).toBe("unknown_field");
    expect(invalidIfMatchErrorCodeSchema.safeParse("unregistered_code").success).toBe(false);
  });
});

describe("D-27 done.usage", () => {
  it("分別保留數值與字面值 unknown，不把 unknown 轉成零", () => {
    expect(doneUsageSchema.parse({ reserved: 0, settled_display: 1.25 })).toEqual({
      reserved: 0,
      settled_display: 1.25,
    });
    expect(doneUsageSchema.parse({ reserved: "unknown", settled_display: "unknown" })).toEqual({
      reserved: "unknown",
      settled_display: "unknown",
    });
  });

  it("拒絕負數、非有限值、null 與錯誤型別", () => {
    for (const invalid of [-1, Number.NaN, Number.POSITIVE_INFINITY, null, "0"]) {
      expect(
        doneUsageSchema.safeParse({ reserved: invalid, settled_display: 0 }).success,
        String(invalid),
      ).toBe(false);
    }
  });
});

const snapshotTimes = {
  started_at: "2026-10-22T10:00:00.000Z",
  updated_at: "2026-10-22T10:01:00.000Z",
};

const jobSnapshot = (kind: string, state: string, startedAt: string | null = null) => ({
  id: "123e4567-e89b-42d3-a456-426614174000",
  kind,
  state,
  progress: { mode: "indeterminate" },
  started_at: startedAt,
  updated_at: snapshotTimes.updated_at,
});

describe("D-25 Job 共用快照核心形狀（非完整 Job DTO）", () => {
  it.each([
    ["preview_build", "validating", snapshotTimes.started_at],
    ["image", "generating", snapshotTimes.started_at],
    ["agent", "running", snapshotTimes.started_at],
    ["deploy", "unknown", null],
    ["purge", "running", snapshotTimes.started_at],
    ["reconcile", "done", snapshotTimes.started_at],
  ])("接受已明定的 %s／%s 狀態", (kind, state, startedAt) => {
    expect(jobSnapshotCoreShapeSchema.safeParse(jobSnapshot(kind, state, startedAt)).success).toBe(
      true,
    );
  });

  it("拒絕不屬於 kind 的狀態與內部租約狀態", () => {
    for (const [kind, state] of [
      ["preview_build", "leased"],
      ["image", "cancelled"],
      ["agent", "awaiting_approval"],
      ["deploy", "done"],
      ["purge", "cancelled"],
      ["reconcile", "paused_off_duty"],
    ]) {
      expect(jobSnapshotCoreShapeSchema.safeParse(jobSnapshot(kind, state)).success).toBe(false);
    }
  });

  it("驗證 steps 範圍、整數及執行中／成功狀態的開始時間", () => {
    const active = jobSnapshot("agent", "running", snapshotTimes.started_at);
    expect(
      jobSnapshotCoreShapeSchema.safeParse({
        ...active,
        progress: { mode: "steps", completed: 2, total: 2 },
      }).success,
    ).toBe(true);
    for (const progress of [
      { mode: "steps", completed: 3, total: 2 },
      { mode: "steps", completed: 0, total: 0 },
      { mode: "steps", completed: 0.5, total: 2 },
      { mode: "unknown" },
    ]) {
      expect(jobSnapshotCoreShapeSchema.safeParse({ ...active, progress }).success).toBe(false);
    }
    expect(jobSnapshotCoreShapeSchema.safeParse(jobSnapshot("image", "generating")).success).toBe(
      false,
    );
    expect(jobSnapshotCoreShapeSchema.safeParse(jobSnapshot("purge", "done")).success).toBe(false);
  });

  it("拒絕 +00:00 偏移表示（UTC 決策 A：wire 必須以大寫 Z 結尾）、更新早於開始時間及未定義的核心欄位", () => {
    const valid = jobSnapshot("preview_build", "building", snapshotTimes.started_at);
    expect(
      jobSnapshotCoreShapeSchema.safeParse({
        ...valid,
        updated_at: "2026-10-22T09:59:00.000Z",
      }).success,
    ).toBe(false);
    expect(
      jobSnapshotCoreShapeSchema.safeParse({
        ...valid,
        updated_at: "2026-10-22T10:01:00+00:00",
      }).success,
    ).toBe(false);
    expect(
      jobSnapshotCoreShapeSchema.safeParse({ ...valid, internal_payload: {} }).success,
    ).toBe(false);
    expect(jobSnapshotCoreShapeSchema.safeParse({ ...valid, result: null }).success).toBe(false);
  });
});

describe("D-25 Job 時間先後：updated_at 不早於 started_at，保留 schema 接受的小數秒精度", () => {
  const withTimes = (startedAt: string, updatedAt: string) => ({
    ...jobSnapshot("preview_build", "building", startedAt),
    updated_at: updatedAt,
  });
  const accepts = (startedAt: string, updatedAt: string) =>
    jobSnapshotCoreShapeSchema.safeParse(withTimes(startedAt, updatedAt)).success;

  it("以公開 schema 重現：毫秒以下的逆序必須被拒絕", () => {
    const result = jobSnapshotCoreShapeSchema.safeParse(
      withTimes("2026-10-22T10:00:00.0009Z", "2026-10-22T10:00:00.0001Z"),
    );
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.path.join("."))).toEqual(["updated_at"]);
  });

  it.each([
    ["4 位小數", "2026-10-22T10:00:00.0009Z", "2026-10-22T10:00:00.0001Z"],
    ["6 位小數", "2026-10-22T10:00:00.000900Z", "2026-10-22T10:00:00.000100Z"],
    ["9 位小數", "2026-10-22T10:00:00.999999999Z", "2026-10-22T10:00:00.999000000Z"],
    ["毫秒", "2026-10-22T10:00:00.001Z", "2026-10-22T10:00:00.000Z"],
    ["不同小數位寬度", "2026-10-22T10:00:00.1000000001Z", "2026-10-22T10:00:00.1Z"],
  ])("拒絕逆序：%s", (_label, startedAt, updatedAt) => {
    expect(accepts(startedAt, updatedAt)).toBe(false);
  });

  it.each([
    ["4 位小數", "2026-10-22T10:00:00.0001Z", "2026-10-22T10:00:00.0009Z"],
    ["6 位小數", "2026-10-22T10:00:00.000100Z", "2026-10-22T10:00:00.000900Z"],
    ["不同小數位寬度", "2026-10-22T10:00:00.1Z", "2026-10-22T10:00:00.1000000001Z"],
    ["無小數秒到下一秒", "2026-10-22T10:00:00Z", "2026-10-22T10:00:01Z"],
  ])("接受正序：%s", (_label, startedAt, updatedAt) => {
    expect(accepts(startedAt, updatedAt)).toBe(true);
  });

  it.each([
    ["相同毫秒", "2026-10-22T10:00:00.000Z", "2026-10-22T10:00:00.000Z"],
    ["相同 4 位小數", "2026-10-22T10:00:00.0009Z", "2026-10-22T10:00:00.0009Z"],
    ["相同無小數秒", "2026-10-22T10:00:00Z", "2026-10-22T10:00:00Z"],
  ])("接受相等：%s", (_label, startedAt, updatedAt) => {
    expect(accepts(startedAt, updatedAt)).toBe(true);
  });

  it.each([
    ["1 位對 3 位", "2026-10-22T10:00:00.1Z", "2026-10-22T10:00:00.100Z"],
    ["3 位對 9 位", "2026-10-22T10:00:00.100Z", "2026-10-22T10:00:00.100000000Z"],
    ["9 位對 1 位", "2026-10-22T10:00:00.100000000Z", "2026-10-22T10:00:00.1Z"],
    ["無小數秒對零小數", "2026-10-22T10:00:00Z", "2026-10-22T10:00:00.000Z"],
    ["零小數對無小數秒", "2026-10-22T10:00:00.000000Z", "2026-10-22T10:00:00Z"],
  ])("接受不同小數位但同一時刻（雙向）：%s", (_label, startedAt, updatedAt) => {
    expect(accepts(startedAt, updatedAt)).toBe(true);
  });

  it.each([
    ["跨秒", "2026-10-22T10:00:00.9999999Z", "2026-10-22T10:00:01.0000001Z"],
    ["跨秒，小數大小相反", "2026-10-22T10:00:00.9Z", "2026-10-22T10:00:01.1Z"],
    ["跨日", "2026-10-22T23:59:59.9999999Z", "2026-10-23T00:00:00.0000001Z"],
    ["跨閏日", "2028-02-28T23:59:59.9999Z", "2028-02-29T00:00:00.0000Z"],
    ["跨年", "2026-12-31T23:59:59.9999999Z", "2027-01-01T00:00:00Z"],
  ])("跨邊界正序被接受：%s", (_label, startedAt, updatedAt) => {
    expect(accepts(startedAt, updatedAt)).toBe(true);
  });

  it.each([
    ["跨秒", "2026-10-22T10:00:01.0000001Z", "2026-10-22T10:00:00.9999999Z"],
    ["跨秒，小數大小相反", "2026-10-22T10:00:01.1Z", "2026-10-22T10:00:00.9Z"],
    ["跨日", "2026-10-23T00:00:00.0000001Z", "2026-10-22T23:59:59.9999999Z"],
    ["跨閏日", "2028-02-29T00:00:00.0000Z", "2028-02-28T23:59:59.9999Z"],
    ["跨年", "2027-01-01T00:00:00Z", "2026-12-31T23:59:59.9999999Z"],
    ["整秒對跨秒小數", "2026-10-22T10:00:01Z", "2026-10-22T10:00:00.9999999Z"],
  ])("跨邊界逆序被拒絕：%s", (_label, startedAt, updatedAt) => {
    expect(accepts(startedAt, updatedAt)).toBe(false);
  });

  it("沒有 started_at 時不比較先後，且不改變既有的執行中狀態要求", () => {
    expect(
      jobSnapshotCoreShapeSchema.safeParse(
        withTimes("2026-10-22T10:00:00Z", "2026-10-22T10:00:00Z"),
      ).success,
    ).toBe(true);
    expect(
      jobSnapshotCoreShapeSchema.safeParse({
        ...jobSnapshot("deploy", "unknown", null),
        updated_at: "2026-10-22T10:00:00.0001Z",
      }).success,
    ).toBe(true);
  });
});

describe("D-26 原生 SSE 欄位與 JSON payload 分層", () => {
  it("驗證原生 event／id／data 欄位，且不把 data 轉成 JSON wrapper", () => {
    const fields = { event: "delta", id: "1", data: '{"seq":1,"text":"合成片段"}' };
    expect(sseNativeEventFieldsSchema.parse(fields)).toEqual(fields);
    expect(sseNativeEventFieldsSchema.safeParse({ ...fields, payload: {} }).success).toBe(false);
  });

  it("接受任意位數的十進位正整數游標（含前導零與超大值），拒絕零、符號、小數、空白與非文字值", () => {
    for (const cursor of ["1", "01", "20", "999999999999999999999999"]) {
      expect(sseEventCursorSchema.parse(cursor)).toBe(cursor);
    }
    for (const cursor of ["0", "-1", "+1", "1.0", " 1", 1]) {
      expect(sseEventCursorSchema.safeParse(cursor).success).toBe(false);
    }
  });

  it.each([
    ["delta", { seq: 1, text: "合成片段" }],
    ["block", { category_group: "inappropriate", safe_alternative_key: "safe-key" }],
    ["support", { level: "high_risk", template_key: "support-key" }],
    ["partial", { saved_through_seq: 0 }],
    ["done", { usage: { reserved: 0, settled_display: "unknown" } }],
    [
      "error",
      {
        code: "stream_internal_error",
        user_message_zh: "合成錯誤提示",
        retryable: false,
      },
    ],
  ] as const)("接受 %s 對應的已登錄 payload", (event, payload) => {
    expect(validateSseProducerPayload(event, payload).success).toBe(true);
  });

  it("拒絕錯配 payload、超出安全整數範圍的片段序號及未登錄錯誤碼", () => {
    expect(
      validateSseProducerPayload("delta", {
        seq: Number.MAX_SAFE_INTEGER + 1,
        text: "合成片段",
      }).success,
    ).toBe(false);
    expect(validateSseProducerPayload("partial", { saved_through_seq: -1 }).success).toBe(false);
    expect(
      validateSseProducerPayload("done", {
        usage: { reserved: "unknown", settled_display: null },
      }).success,
    ).toBe(false);
    expect(
      validateSseProducerPayload("error", {
        code: "synthetic_unregistered_code",
        user_message_zh: "合成錯誤",
        retryable: false,
      }).success,
    ).toBe(false);
    expect(
      validateSseProducerPayload("block", { seq: 1, text: "不是 block payload" }).success,
    ).toBe(false);
  });

  it("producer payload 嚴格拒絕額外欄位；既有相容 reader 保留擴充欄位", () => {
    const block = {
      category_group: "inappropriate",
      safe_alternative_key: "safe-key",
      extension: "synthetic",
    };
    expect(sseBlockProducerPayloadSchema.safeParse(block).success).toBe(false);
    expect(sseBlockPayloadSchema.parse(block)).toEqual(block);

    const support = { level: "support", template_key: "support-key", extension: true };
    expect(sseSupportProducerPayloadSchema.safeParse(support).success).toBe(false);
    expect(sseSupportPayloadSchema.parse(support)).toEqual(support);

    expect(
      sseDeltaProducerPayloadSchema.safeParse({ seq: 1, text: "合成", extension: true }).success,
    ).toBe(false);
    expect(
      ssePartialProducerPayloadSchema.safeParse({ saved_through_seq: 0, extension: true })
        .success,
    ).toBe(false);
    expect(
      sseDoneProducerPayloadSchema.safeParse({
        usage: { reserved: 0, settled_display: 0 },
        extension: true,
      }).success,
    ).toBe(false);
    expect(
      sseErrorProducerPayloadSchema.safeParse({
        code: "generation_failed",
        user_message_zh: "合成",
        retryable: false,
        extension: true,
      }).success,
    ).toBe(false);
  });

  it("knownChatMessageErrorCodeSchema 只代表 H-4 開串流前的 HTTP 作用域碼，不是 SSE error 白名單", () => {
    expect(knownChatMessageErrorCodeSchema.parse("ai_off_duty")).toBe("ai_off_duty");
    expect(
      knownChatMessageErrorCodeSchema.safeParse("vendor_internal_failure").success,
    ).toBe(false);
    expect(
      validateSseProducerPayload("error", {
        code: "ai_off_duty",
        user_message_zh: "合成",
        retryable: false,
      }).success,
    ).toBe(false);
  });
});

describe("D-30 problem+json reader 擴充相容性", () => {
  it("保留相容 reader 的額外欄位，不將此行為視為 producer allowlist", () => {
    const problem = {
      type: "urn:app-planet:problem:school-not-confirmed",
      title: "學校核准尚未確認",
      status: 403,
      code: "school_not_confirmed",
      instance: "/api/v1/synthetic-operation",
      request_id: "opaque/synthetic-request",
      user_message_zh: "合成測試提示",
      extension: { source: "synthetic" },
    };
    expect(problemJsonSchema.parse(problem)).toEqual(problem);
  });
});
