import { describe, expect, it } from "vitest";
import {
  buildJobAcceptedResponse,
  buildProblemJson,
  buildVersionConflictProblem,
  createProblemProducerPolicy,
  containsSensitiveText,
  idempotencyKeyReuseErrorCodeSchema,
} from "@app-planet/core";

const policy = { codes: ["school_not_confirmed", "idempotency_key_reuse", "version_conflict"] };

const baseProblem = () => ({
  type: "https://app-planet.invalid/problems/school-not-confirmed",
  title: "學校尚未確認",
  status: 403,
  code: "school_not_confirmed",
  instance: "/api/v1/projects",
  request_id: "opaque-request-0001",
  user_message_zh: "學校尚未確認，請聯絡老師。",
});

describe("T006 producer problem+json", () => {
  it("逐欄建構精確且凍結的 problem 物件，並捨棄未知欄位", () => {
    const result = buildProblemJson(
      { ...baseProblem(), stack: "at x (C:\\secret\\file.ts:1:1)", cause: new Error("SYNTHETIC") },
      policy,
    );
    expect(result).toEqual({ ok: true, data: baseProblem() });
    if (result.ok) {
      expect(Object.isFrozen(result.data)).toBe(true);
      expect(Object.keys(result.data)).not.toContain("stack");
    }
  });

  it("接受選填 detail，並保持必要欄位完整", () => {
    const result = buildProblemJson({ ...baseProblem(), detail: "請稍後再試。" }, policy);
    expect(result.ok && result.data.detail).toBe("請稍後再試。");
  });

  it.each([
    ["未登錄的錯誤碼", { code: "unregistered_code" }],
    ["SSE 專屬碼", { code: "stream_internal_error" }],
    ["缺少 request_id", { request_id: undefined }],
    ["空 request_id", { request_id: "" }],
    ["HTTP 狀態不是錯誤狀態", { status: 200 }],
    ["非整數狀態", { status: 403.5 }],
    ["訊息非中文", { user_message_zh: "School is not confirmed" }],
    ["instance 帶查詢字串", { instance: "/api/v1/projects?token=abc" }],
    ["訊息含 Bearer 憑證", { user_message_zh: "失敗 Bearer abcdefghijklmnop" }],
    ["detail 含堆疊", { detail: "\n    at run (/home/app/server.js:10:5)" }],
    ["request_id 含 JWT", { request_id: "eyJhbGciOi.eyJzdWIiOiIx.c2ln" }],
  ])("固定失敗：%s", (_name, patch) => {
    const result = buildProblemJson({ ...baseProblem(), ...patch }, policy);
    expect(result).toEqual({ ok: false, code: "invalid_problem_record" });
  });

  it("拒絕 accessor 欄位、非 plain 輸入與無效 policy，且不呼叫 getter", () => {
    let called = false;
    const trapped = { ...baseProblem() };
    Object.defineProperty(trapped, "title", {
      enumerable: true,
      get() {
        called = true;
        return "學校尚未確認";
      },
    });
    expect(buildProblemJson(trapped, policy).ok).toBe(false);
    expect(called).toBe(false);
    expect(buildProblemJson([baseProblem()], policy).ok).toBe(false);
    expect(buildProblemJson(baseProblem(), { codes: [] }).ok).toBe(false);
    expect(buildProblemJson(baseProblem(), { codes: ["web_search_failed"] }).ok).toBe(false);
    expect(createProblemProducerPolicy({ codes: ["school_not_confirmed"], extra: 1 }).ok).toBe(false);
  });
});

describe("T006 冪等重用與 If-Match 衝突", () => {
  it("idempotency_key_reuse 是作用域固定碼", () => {
    expect(idempotencyKeyReuseErrorCodeSchema.safeParse("idempotency_key_reuse").success).toBe(true);
    expect(idempotencyKeyReuseErrorCodeSchema.safeParse("idempotency_conflict").success).toBe(false);
  });

  const conflictInput = () => ({
    type: "https://app-planet.invalid/problems/version-conflict",
    title: "內容已被更新",
    instance: "/api/v1/projects/p1/stages/idea",
    request_id: "opaque-request-0002",
    user_message_zh: "內容已被更新，請查看最新版本後再儲存。",
    conflict: {
      current: { version: 8, content: { title: "新標題", secret_note: "SYNTHETIC-NOT-ALLOWED" } },
      submitted: { version: 7, content: { title: "我的標題" } },
    },
  });
  const rowPolicy = { resource: "row" as const, allowedContentFields: ["title"] };

  it("固定 409／version_conflict，並只回允許欄位的 current／submitted", () => {
    const result = buildVersionConflictProblem(conflictInput(), rowPolicy);
    expect(result).toEqual({
      ok: true,
      data: {
        type: "https://app-planet.invalid/problems/version-conflict",
        title: "內容已被更新",
        status: 409,
        code: "version_conflict",
        instance: "/api/v1/projects/p1/stages/idea",
        request_id: "opaque-request-0002",
        user_message_zh: "內容已被更新，請查看最新版本後再儲存。",
        conflict: {
          current: { version: 8, content: { title: "新標題" } },
          submitted: { version: 7, content: { title: "我的標題" } },
        },
      },
    });
  });

  it("輸入無法覆寫 status 與 code，DELETE 的 submitted content 可為 null", () => {
    const input = {
      ...conflictInput(),
      status: 400,
      code: "other",
      conflict: { ...conflictInput().conflict, submitted: { version: 7, content: null } },
    };
    const result = buildVersionConflictProblem(input, rowPolicy);
    expect(result.ok && result.data.status).toBe(409);
    expect(result.ok && result.data.code).toBe("version_conflict");
    expect(result.ok && result.data.conflict.submitted.content).toBeNull();
  });

  it("current content 不得為 null，版本須為整數，巢狀或敏感內容整筆拒絕", () => {
    const sideWith = (current: unknown, submitted: unknown = { version: 7, content: { title: "x" } }) => ({
      ...conflictInput(),
      conflict: { current, submitted },
    });
    expect(buildVersionConflictProblem(sideWith({ version: 8, content: null }), rowPolicy).ok).toBe(false);
    expect(buildVersionConflictProblem(sideWith({ version: 8.5, content: { title: "x" } }), rowPolicy).ok).toBe(false);
    expect(buildVersionConflictProblem(sideWith({ version: "8", content: { title: "x" } }), rowPolicy).ok).toBe(false);
    expect(buildVersionConflictProblem(sideWith({ version: 8, content: { title: { nested: 1 } } }), rowPolicy).ok).toBe(false);
    expect(buildVersionConflictProblem(sideWith({ version: 8, content: { title: "Bearer abcdefghijklmnop" } }), rowPolicy).ok).toBe(false);
    expect(buildVersionConflictProblem(conflictInput(), { resource: "row", allowedContentFields: [] }).ok).toBe(false);
  });

  it("file 衝突使用小寫 64 位 SHA-256 版本，二進位內容以 null 表示", () => {
    const hash = "a".repeat(64);
    const input = {
      ...conflictInput(),
      conflict: {
        current: { version: hash, content: null },
        submitted: { version: "b".repeat(64), content: "console.log('x')" },
      },
    };
    const result = buildVersionConflictProblem(input, { resource: "file", allowedContentFields: [] });
    expect(result.ok).toBe(true);
    const badHash = { ...input, conflict: { ...input.conflict, current: { version: hash.toUpperCase(), content: null } } };
    expect(buildVersionConflictProblem(badHash, { resource: "file", allowedContentFields: [] }).ok).toBe(false);
  });
});

describe("T006 202 Job 接受回應", () => {
  const snapshot = () => ({
    id: "9b2f4f9e-3b53-4b31-9a4a-6a43d0c8c111",
    kind: "agent",
    state: "queued",
    progress: { mode: "indeterminate" },
    started_at: null,
    updated_at: "2026-10-26T12:00:00Z",
    result: null,
    failure: null,
  });

  it("回 202、Location 指向 jobs/{id}，body 為 result／failure 皆 null 的 queued 快照", () => {
    const result = buildJobAcceptedResponse(snapshot());
    expect(result).toEqual({
      ok: true,
      data: {
        status: 202,
        headers: { location: "/api/v1/jobs/9b2f4f9e-3b53-4b31-9a4a-6a43d0c8c111" },
        body: snapshot(),
      },
    });
  });

  it.each([
    ["缺 result 鍵", (s: Record<string, unknown>) => (delete s.result, s)],
    ["缺 failure 鍵", (s: Record<string, unknown>) => (delete s.failure, s)],
    ["result 非 null", (s: Record<string, unknown>) => ({ ...s, result: { url: "https://x.invalid" } })],
    ["failure 非 null", (s: Record<string, unknown>) => ({ ...s, failure: { code: "x" } })],
    ["已成功狀態", (s: Record<string, unknown>) => ({ ...s, state: "succeeded", started_at: "2026-10-26T12:00:00Z" })],
    ["執行中狀態", (s: Record<string, unknown>) => ({ ...s, state: "running", started_at: "2026-10-26T12:00:00Z" })],
    ["queued 卻有開始時間", (s: Record<string, unknown>) => ({ ...s, started_at: "2026-10-26T11:00:00Z" })],
    ["+00:00 偏移時間", (s: Record<string, unknown>) => ({ ...s, updated_at: "2026-10-26T12:00:00+00:00" })],
    ["額外欄位", (s: Record<string, unknown>) => ({ ...s, internal_lease: "SYNTHETIC" })],
    ["非 UUID id", (s: Record<string, unknown>) => ({ ...s, id: "job-1" })],
  ])("固定失敗：%s", (_name, mutate) => {
    expect(buildJobAcceptedResponse(mutate(snapshot()))).toEqual({
      ok: false,
      code: "invalid_problem_record",
    });
  });
});

describe("R-12 遮蔽層種子字串", () => {
  it.each([
    "Bearer abcdefghijklmnop",
    "eyJhbGciOiJI.eyJzdWIiOiIx.SflKxwRJSM",
    "sb_secret_abcdefghijk",
    "sk-abcdefghijklmnop",
    "Set-Cookie: a=b",
    "authorization: x",
    "C:\\Users\\student\\notes.txt",
    "/home/app/server.js",
    "203.0.113.45",
    "2001:db8:0:0:0:0:0:1",
    "fe80::1",
    "\n    at handler (server.js:10:3)",
  ])("偵測：%s", (seed) => {
    expect(containsSensitiveText(seed)).toBe(true);
  });

  it.each(["opaque-request-0001", "學校尚未確認，請聯絡老師。", "12:30:45", "v1.2.3", "req_7f3a"])(
    "不誤判：%s",
    (text) => {
      expect(containsSensitiveText(text)).toBe(false);
    },
  );
});
