import { describe, expect, it } from "vitest";
import {
  buildAuditRecordDto,
  buildDiagnosticLogDto,
  createAuditRecordPolicy,
  createDiagnosticLogPolicy,
} from "@app-planet/core";
import { createWorkerLogger } from "../../apps/worker/src/logging.ts";

const auditPolicyInput = {
  actions: ["teacher_view"],
  objectTypes: ["project", "conversation"],
  metaKeys: ["version", "count", "from_state", "to_state"],
};
const diagnosticPolicyInput = {
  routeIds: ["worker_job_run"],
  httpErrorCodes: ["job_lease_lost"],
};

const auditRecord = () => ({
  id: "11111111-1111-4111-8111-111111111111",
  at: "2026-10-26T12:00:00Z",
  actor_aid: "22222222-2222-4222-8222-222222222222",
  subject_aid: "33333333-3333-4333-8333-333333333333",
  action: "teacher_view",
  object_type: "project",
  object_ref: "44444444-4444-4444-8444-444444444444",
  school_id: "55555555-5555-4555-8555-555555555555",
  result: "ok",
  meta: { version: 3, from_state: "draft", to_state: "saved" },
});

describe("T012 稽核紀錄 DTO（data-model §1.4）", () => {
  it("逐欄建構精確、凍結的稽核 DTO，meta 只含白名單鍵與固定碼／整數", () => {
    const policy = createAuditRecordPolicy(auditPolicyInput);
    expect(policy.ok).toBe(true);
    const result = buildAuditRecordDto(auditRecord(), policy.ok ? policy.policy : null);
    expect(result).toEqual({ ok: true, data: auditRecord() });
    if (result.ok) {
      expect(Object.isFrozen(result.data)).toBe(true);
      expect(Object.isFrozen(result.data.meta)).toBe(true);
    }
  });

  it.each([
    ["未登錄 action", { action: "export_everything" }],
    ["未登錄 object_type", { object_type: "file" }],
    ["meta 含未登錄鍵", { meta: { nickname: "synthetic" } }],
    ["meta 值為自由文字", { meta: { to_state: "Hello World 暱稱" } }],
    ["meta 值為巢狀物件", { meta: { version: { n: 1 } } }],
    ["meta 值為小數", { meta: { count: 1.5 } }],
    ["缺少 subject_aid（需明確 null）", { subject_aid: undefined }],
    ["aid 非 UUID", { actor_aid: "student-nickname" }],
    ["時間含 +00:00 偏移", { at: "2026-10-26T12:00:00+00:00" }],
    ["result 非固定值", { result: "success" }],
  ])("固定失敗：%s", (_name, patch) => {
    const policy = createAuditRecordPolicy(auditPolicyInput);
    const input = { ...auditRecord(), ...patch };
    expect(buildAuditRecordDto(input, policy.ok ? policy.policy : null)).toEqual({
      ok: false,
      code: "invalid_audit_record",
    });
  });

  it("捨棄未列入白名單的額外頂層欄位（如 ip），輸出不含它們", () => {
    const policy = createAuditRecordPolicy(auditPolicyInput);
    const result = buildAuditRecordDto({ ...auditRecord(), ip: "203.0.113.9", password: "SYNTHETIC" }, policy.ok ? policy.policy : null);
    expect(result).toEqual({ ok: true, data: auditRecord() });
  });

  it("空 meta 白名單只接受空 meta（與目前 migration 的 meta = {} 一致）", () => {
    const policy = createAuditRecordPolicy({ ...auditPolicyInput, metaKeys: [] });
    expect(buildAuditRecordDto({ ...auditRecord(), meta: {} }, policy.ok ? policy.policy : null).ok).toBe(true);
    expect(buildAuditRecordDto(auditRecord(), policy.ok ? policy.policy : null).ok).toBe(false);
  });

  it("無效 policy 與 getter 欄位 fail-closed", () => {
    expect(createAuditRecordPolicy({ actions: [], objectTypes: ["project"], metaKeys: [] }).ok).toBe(false);
    expect(createAuditRecordPolicy({ ...auditPolicyInput, extra: true }).ok).toBe(false);
    const policy = createAuditRecordPolicy(auditPolicyInput);
    const trapped = auditRecord();
    let called = false;
    Object.defineProperty(trapped, "action", {
      enumerable: true,
      get() {
        called = true;
        return "teacher_view";
      },
    });
    expect(buildAuditRecordDto(trapped, policy.ok ? policy.policy : null).ok).toBe(false);
    expect(called).toBe(false);
  });
});

describe("T012 診斷日誌的 R-12 遮蔽層", () => {
  const policy = createDiagnosticLogPolicy(diagnosticPolicyInput);
  const rules = policy.ok ? policy.policy : null;
  const input = () => ({ request_id: "opaque-request-1", route: "worker_job_run", status_code: 500, duration: 3 });

  it.each([
    ["Bearer abcdefghijklmnop"],
    ["eyJhbGciOiJI.eyJzdWIiOiIx.SflKxwRJSM"],
    ["sb_secret_abcdefghijk"],
    ["sk-abcdefghijklmnop"],
    ["203.0.113.45"],
  ])("request_id 或 aid 含已知敏感形狀時整筆拒絕：%s", (seed) => {
    expect(buildDiagnosticLogDto({ ...input(), request_id: seed }, rules)).toEqual({ ok: false, code: "invalid_log_record" });
    expect(buildDiagnosticLogDto({ ...input(), aid: seed }, rules)).toEqual({ ok: false, code: "invalid_log_record" });
  });
});

describe("T012 Worker 日誌（apps/worker/src/logging.ts）", () => {
  const seeded = {
    authorization: "Bearer SYNTHETIC_FAKE_TOKEN_123456",
    cookie: "session=SYNTHETIC_FAKE_COOKIE",
    body: "SYNTHETIC_FAKE_DIALOGUE",
    loginCode: "SYNTHETIC-LOGIN-CODE",
    ip: "198.51.100.7",
    previewId: "synthetic-raw-preview-id",
  };

  function create() {
    const lines: string[] = [];
    const audits: unknown[] = [];
    const created = createWorkerLogger({
      diagnosticPolicy: diagnosticPolicyInput,
      auditPolicy: auditPolicyInput,
      diagnosticSink: (line) => lines.push(line),
      auditSink: (record) => audits.push(record),
    });
    if (!created.ok) {
      throw new Error("synthetic worker logger should be created");
    }
    return { logger: created.logger, lines, audits };
  }

  it("診斷與錯誤紀錄只輸出白名單欄位，種子敏感值不出現在輸出", () => {
    const { logger, lines } = create();
    const input = {
      request_id: "opaque-request-9",
      route: "worker_job_run",
      status_code: 500,
      duration: 42,
      aid: "synthetic-aid-1",
      error_code: "job_lease_lost",
      ...seeded,
      meta: { nested: seeded },
      error: new Error(seeded.authorization),
    };
    expect(logger.diagnostic(input)).toEqual({ ok: true });
    expect(logger.error(input)).toEqual({ ok: true });
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      expect(Object.keys(JSON.parse(line)).sort()).toEqual(
        ["aid", "duration", "error_code", "request_id", "route", "status_code"],
      );
      for (const value of Object.values(seeded)) {
        expect(line).not.toContain(value);
      }
    }
  });

  it("error 必須帶已登錄 error_code；未登錄 route／碼、缺欄位固定失敗且不寫出", () => {
    const { logger, lines } = create();
    const base = { request_id: "opaque-request-9", route: "worker_job_run", status_code: 500, duration: 1 };
    expect(logger.error(base)).toEqual({ ok: false, code: "invalid_log_record" });
    expect(logger.error({ ...base, error_code: "vendor_raw_code" })).toEqual({ ok: false, code: "invalid_log_record" });
    expect(logger.diagnostic({ ...base, route: "unregistered" })).toEqual({ ok: false, code: "invalid_log_record" });
    expect(logger.diagnostic({ route: "worker_job_run" })).toEqual({ ok: false, code: "invalid_log_record" });
    expect(lines).toEqual([]);
  });

  it("sink 拋錯時只回固定碼，不洩漏錯誤訊息，也不向 job 流程拋出", () => {
    const created = createWorkerLogger({
      diagnosticPolicy: diagnosticPolicyInput,
      diagnosticSink: () => {
        throw new Error("SYNTHETIC_SINK_SECRET");
      },
    });
    if (!created.ok) {
      throw new Error("synthetic worker logger should be created");
    }
    const result = created.logger.diagnostic({
      request_id: "opaque-request-9",
      route: "worker_job_run",
      status_code: 200,
      duration: 1,
    });
    expect(result).toEqual({ ok: false, code: "log_sink_failed" });
    expect(JSON.stringify(result)).not.toContain("SYNTHETIC_SINK_SECRET");
  });

  it("稽核紀錄只交給稽核 sink 的白名單 DTO；未設定 sink 時拒絕", () => {
    const { logger, audits } = create();
    expect(logger.audit({ ...auditRecord(), password: "SYNTHETIC" })).toEqual({ ok: true });
    expect(audits).toEqual([auditRecord()]);
    expect(logger.audit({ ...auditRecord(), action: "unknown_action" })).toEqual({ ok: false, code: "invalid_audit_record" });

    const withoutAudit = createWorkerLogger({ diagnosticPolicy: diagnosticPolicyInput, diagnosticSink: () => undefined });
    expect(withoutAudit.ok && withoutAudit.logger.audit(auditRecord())).toEqual({ ok: false, code: "audit_sink_not_configured" });
  });

  it("無效 policy 不建立 logger", () => {
    expect(createWorkerLogger({ diagnosticPolicy: { routeIds: [] }, diagnosticSink: () => undefined })).toEqual({
      ok: false,
      code: "invalid_log_policy",
    });
    expect(
      createWorkerLogger({ diagnosticPolicy: diagnosticPolicyInput, auditPolicy: { actions: [] }, diagnosticSink: () => undefined }),
    ).toEqual({ ok: false, code: "invalid_log_policy" });
  });
});
