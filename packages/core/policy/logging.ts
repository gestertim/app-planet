import { z } from "zod";
import { sseErrorCodeSchema, utcInstantSchema } from "../contracts/common.ts";
import {
  hasNoAccessors,
  hasOnlyAllowedDataProperties,
  isPlainRecord,
} from "./plain-record.ts";
import { containsSensitiveText } from "./sensitive-text.ts";

const identifierSchema = z.string().regex(/^[a-z][a-z0-9_]*$/);
// request_id／aid 為 opaque 字串：除非空外，另拒絕已知敏感形狀（R-12 遮蔽層）；格式本身不證明安全。
const opaqueLogIdSchema = z
  .string()
  .min(1)
  .refine((value) => !containsSensitiveText(value), "含已知敏感形狀");
const sseErrorCodes: ReadonlySet<string> = new Set(sseErrorCodeSchema.options);

const diagnosticLogPolicySchema = z
  .object({
    routeIds: z.array(identifierSchema),
    httpErrorCodes: z.array(identifierSchema),
  })
  .strict();

const diagnosticLogInputSchema = z.object({
  request_id: opaqueLogIdSchema,
  route: identifierSchema,
  status_code: z.number().int().min(100).max(599),
  duration: z.number().finite().nonnegative(),
  aid: opaqueLogIdSchema.optional(),
  error_code: identifierSchema.optional(),
});

const diagnosticLogDtoSchema = z
  .object({
    request_id: opaqueLogIdSchema,
    route: identifierSchema,
    status_code: z.number().int().min(100).max(599),
    duration: z.number().finite().nonnegative(),
    aid: opaqueLogIdSchema.optional(),
    error_code: identifierSchema.optional(),
  })
  .strict();

export interface DiagnosticLogPolicy {
  readonly routeIds: readonly string[];
  readonly httpErrorCodes: readonly string[];
}

export interface DiagnosticLogDto {
  readonly request_id: string;
  readonly route: string;
  readonly status_code: number;
  readonly duration: number;
  readonly aid?: string;
  readonly error_code?: string;
}

export type DiagnosticLogFailure = {
  ok: false;
  code: "invalid_log_record";
};

export type CreateDiagnosticLogPolicyResult =
  | { ok: true; policy: DiagnosticLogPolicy }
  | DiagnosticLogFailure;

export type BuildDiagnosticLogDtoResult =
  | { ok: true; data: DiagnosticLogDto }
  | DiagnosticLogFailure;

export type ValidateDiagnosticLogDtoResult = { ok: true } | DiagnosticLogFailure;

const fail = (): DiagnosticLogFailure => ({ ok: false, code: "invalid_log_record" });

function parsePolicy(policy: unknown): DiagnosticLogPolicy | null {
  if (
    !isPlainRecord(policy) ||
    !hasOnlyAllowedDataProperties(policy, ["routeIds", "httpErrorCodes"])
  ) {
    return null;
  }
  const parsed = diagnosticLogPolicySchema.safeParse(policy);
  if (!parsed.success || parsed.data.httpErrorCodes.some((code) => sseErrorCodes.has(code))) {
    return null;
  }
  return parsed.data;
}

function isAllowed(
  value: string | undefined,
  allowlist: readonly string[],
): value is string {
  return value === undefined || allowlist.includes(value);
}

function validateInputFields(input: unknown) {
  if (
    !isPlainRecord(input) ||
    !hasNoAccessors(input, [
      "request_id",
      "route",
      "status_code",
      "duration",
      "aid",
      "error_code",
    ])
  ) {
    return null;
  }
  return diagnosticLogInputSchema.safeParse(input);
}

// policy 僅可由可信應用程式設定，不可直接取自請求或供應商資料。
export function createDiagnosticLogPolicy(input: unknown): CreateDiagnosticLogPolicyResult {
  const policy = parsePolicy(input);
  if (policy === null) {
    return fail();
  }
  return {
    ok: true,
    policy: Object.freeze({
      routeIds: Object.freeze([...policy.routeIds]),
      httpErrorCodes: Object.freeze([...policy.httpErrorCodes]),
    }),
  };
}

export function validateDiagnosticLogDto(
  input: unknown,
  policyInput: unknown,
): ValidateDiagnosticLogDtoResult {
  const policy = parsePolicy(policyInput);
  if (
    policy === null ||
    !isPlainRecord(input) ||
    !hasOnlyAllowedDataProperties(input, [
      "request_id",
      "route",
      "status_code",
      "duration",
      "aid",
      "error_code",
    ]) ||
    !hasNoAccessors(input, [
      "request_id",
      "route",
      "status_code",
      "duration",
      "aid",
      "error_code",
    ])
  ) {
    return fail();
  }
  const parsed = diagnosticLogDtoSchema.safeParse(input);
  if (
    !parsed.success ||
    !policy.routeIds.includes(parsed.data.route) ||
    !isAllowed(parsed.data.error_code, policy.httpErrorCodes)
  ) {
    return fail();
  }
  return { ok: true };
}

export function buildDiagnosticLogDto(
  input: unknown,
  policyInput: unknown,
): BuildDiagnosticLogDtoResult {
  const policy = parsePolicy(policyInput);
  const parsed = validateInputFields(input);
  if (
    policy === null ||
    parsed === null ||
    !parsed.success ||
    !policy.routeIds.includes(parsed.data.route) ||
    !isAllowed(parsed.data.error_code, policy.httpErrorCodes)
  ) {
    return fail();
  }

  const data: DiagnosticLogDto = Object.freeze({
    request_id: parsed.data.request_id,
    route: parsed.data.route,
    status_code: parsed.data.status_code,
    duration: parsed.data.duration,
    ...(parsed.data.aid === undefined ? {} : { aid: parsed.data.aid }),
    ...(parsed.data.error_code === undefined ? {} : { error_code: parsed.data.error_code }),
  });

  const validated = validateDiagnosticLogDto(data, policy);
  return validated.ok ? { ok: true, data } : fail();
}

// ---- 追加式業務稽核紀錄 DTO（data-model §1.4）----
// 與診斷日誌不同：稽核列只存固定碼、內部識別與白名單 meta。這裡只建構／驗證 DTO，
// 不寫資料庫；action／object_type／meta 鍵由可信應用程式設定提供，不內建未核定的碼表。

const auditMetaValueSchema = z.union([z.number().int(), identifierSchema]);

const auditPolicySchema = z
  .object({
    actions: z.array(identifierSchema).min(1),
    objectTypes: z.array(identifierSchema).min(1),
    metaKeys: z.array(identifierSchema),
  })
  .strict();

const auditRecordFieldsSchema = {
  id: z.uuid(),
  at: utcInstantSchema,
  actor_aid: z.uuid(),
  subject_aid: z.uuid().nullable(),
  action: identifierSchema,
  object_type: identifierSchema,
  object_ref: z.uuid().nullable(),
  school_id: z.uuid().nullable(),
  result: z.enum(["ok", "denied", "failed"]),
  meta: z.record(identifierSchema, auditMetaValueSchema),
};
const auditRecordInputSchema = z.object(auditRecordFieldsSchema);
const auditRecordDtoSchema = z.object(auditRecordFieldsSchema).strict();
const auditRecordKeys = Object.keys(auditRecordFieldsSchema);

export interface AuditRecordPolicy {
  readonly actions: readonly string[];
  readonly objectTypes: readonly string[];
  readonly metaKeys: readonly string[];
}

export interface AuditRecordDto {
  readonly id: string;
  readonly at: string;
  readonly actor_aid: string;
  readonly subject_aid: string | null;
  readonly action: string;
  readonly object_type: string;
  readonly object_ref: string | null;
  readonly school_id: string | null;
  readonly result: "ok" | "denied" | "failed";
  readonly meta: Readonly<Record<string, string | number>>;
}

export type AuditRecordFailure = { ok: false; code: "invalid_audit_record" };
export type CreateAuditRecordPolicyResult =
  | { ok: true; policy: AuditRecordPolicy }
  | AuditRecordFailure;
export type BuildAuditRecordDtoResult = { ok: true; data: AuditRecordDto } | AuditRecordFailure;

const auditFail = (): AuditRecordFailure => ({ ok: false, code: "invalid_audit_record" });

function parseAuditPolicy(policy: unknown): AuditRecordPolicy | null {
  if (
    !isPlainRecord(policy) ||
    !hasOnlyAllowedDataProperties(policy, ["actions", "objectTypes", "metaKeys"])
  ) {
    return null;
  }
  const parsed = auditPolicySchema.safeParse(policy);
  return parsed.success ? parsed.data : null;
}

export function createAuditRecordPolicy(input: unknown): CreateAuditRecordPolicyResult {
  const policy = parseAuditPolicy(input);
  if (policy === null) {
    return auditFail();
  }
  return {
    ok: true,
    policy: Object.freeze({
      actions: Object.freeze([...policy.actions]),
      objectTypes: Object.freeze([...policy.objectTypes]),
      metaKeys: Object.freeze([...policy.metaKeys]),
    }),
  };
}

export function buildAuditRecordDto(
  input: unknown,
  policyInput: unknown,
): BuildAuditRecordDtoResult {
  const policy = parseAuditPolicy(policyInput);
  if (
    policy === null ||
    !isPlainRecord(input) ||
    !hasNoAccessors(input, auditRecordKeys) ||
    !isPlainRecord(input.meta) ||
    !hasOnlyAllowedDataProperties(input.meta, policy.metaKeys)
  ) {
    return auditFail();
  }
  const parsed = auditRecordInputSchema.safeParse(input);
  if (
    !parsed.success ||
    !policy.actions.includes(parsed.data.action) ||
    !policy.objectTypes.includes(parsed.data.object_type)
  ) {
    return auditFail();
  }

  const data = Object.freeze({
    id: parsed.data.id,
    at: parsed.data.at,
    actor_aid: parsed.data.actor_aid,
    subject_aid: parsed.data.subject_aid,
    action: parsed.data.action,
    object_type: parsed.data.object_type,
    object_ref: parsed.data.object_ref,
    school_id: parsed.data.school_id,
    result: parsed.data.result,
    meta: Object.freeze({ ...parsed.data.meta }),
  });
  return auditRecordDtoSchema.safeParse(data).success ? { ok: true, data } : auditFail();
}
