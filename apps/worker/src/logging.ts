import {
  buildAuditRecordDto,
  buildDiagnosticLogDto,
  createAuditRecordPolicy,
  createDiagnosticLogPolicy,
  type AuditRecordDto,
  type DiagnosticLogDto,
  type DiagnosticLogPolicy,
  type AuditRecordPolicy,
} from "@app-planet/core";

// Worker 只負責把 core 的白名單 DTO 交給可信輸出端；沒有 sink 實作、保存、輪替或第三方監控，
// 這些仍屬未核定範圍。任何失敗只回固定碼，不帶輸入、錯誤訊息或堆疊，也不讓日誌失敗中斷 job。

export type WorkerLogFailureCode =
  | "invalid_log_record"
  | "invalid_audit_record"
  | "audit_sink_not_configured"
  | "log_sink_failed";

export type WorkerLogResult = { ok: true } | { ok: false; code: WorkerLogFailureCode };

export interface WorkerLoggerOptions {
  readonly diagnosticPolicy: unknown;
  readonly auditPolicy?: unknown;
  readonly diagnosticSink: (line: string) => void;
  readonly auditSink?: (record: AuditRecordDto) => void;
}

export interface WorkerLogger {
  readonly diagnostic: (input: unknown) => WorkerLogResult;
  // 錯誤紀錄與診斷紀錄同一白名單，但必須帶已登錄的 error_code；不接受 Error、message、stack 或 cause。
  readonly error: (input: unknown) => WorkerLogResult;
  readonly audit: (input: unknown) => WorkerLogResult;
}

export type CreateWorkerLoggerResult =
  | { ok: true; logger: WorkerLogger }
  | { ok: false; code: "invalid_log_policy" };

function emit(write: () => void): WorkerLogResult {
  try {
    write();
    return { ok: true };
  } catch {
    return { ok: false, code: "log_sink_failed" };
  }
}

export function createWorkerLogger(options: WorkerLoggerOptions): CreateWorkerLoggerResult {
  const diagnosticPolicy = createDiagnosticLogPolicy(options.diagnosticPolicy);
  const auditPolicy =
    options.auditPolicy === undefined ? null : createAuditRecordPolicy(options.auditPolicy);
  if (!diagnosticPolicy.ok || (auditPolicy !== null && !auditPolicy.ok)) {
    return { ok: false, code: "invalid_log_policy" };
  }

  const diagnosticRules: DiagnosticLogPolicy = diagnosticPolicy.policy;
  const auditRules: AuditRecordPolicy | null = auditPolicy === null ? null : auditPolicy.policy;

  const writeDiagnostic = (dto: DiagnosticLogDto): WorkerLogResult =>
    emit(() => options.diagnosticSink(JSON.stringify(dto)));

  const logger: WorkerLogger = Object.freeze({
    diagnostic(input: unknown): WorkerLogResult {
      const built = buildDiagnosticLogDto(input, diagnosticRules);
      return built.ok ? writeDiagnostic(built.data) : { ok: false, code: "invalid_log_record" };
    },
    error(input: unknown): WorkerLogResult {
      const built = buildDiagnosticLogDto(input, diagnosticRules);
      if (!built.ok || built.data.error_code === undefined) {
        return { ok: false, code: "invalid_log_record" };
      }
      return writeDiagnostic(built.data);
    },
    audit(input: unknown): WorkerLogResult {
      if (auditRules === null || options.auditSink === undefined) {
        return { ok: false, code: "audit_sink_not_configured" };
      }
      const built = buildAuditRecordDto(input, auditRules);
      if (!built.ok) {
        return { ok: false, code: "invalid_audit_record" };
      }
      const sink = options.auditSink;
      return emit(() => sink(built.data));
    },
  });
  return { ok: true, logger };
}
