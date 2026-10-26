import { z } from "zod";
import {
  hasNoAccessors,
  hasOnlyAllowedDataProperties,
  isPlainRecord,
} from "../policy/plain-record.ts";
import { containsSensitiveText } from "../policy/sensitive-text.ts";

export const roleSchema = z.enum(["student", "teacher", "admin"]);
export const accountStatusSchema = z.enum(["pending", "approved", "rejected", "disabled"]);
export const deletionStateSchema = z.enum([
  "none",
  "marked",
  "purging",
  "purge_failed",
  "purged",
]);
export const schoolApprovalSchema = z.enum([
  "unconfirmed",
  "approved",
  "withdrawn",
  "expired",
]);
export const projectTierSchema = z.enum(["A", "B"]);
export const capabilitySchema = z.enum([
  "login",
  "read_saved_content",
  "edit_saved_content",
  "download_own_results",
  "ai_call",
  "submit_for_review",
  "public_deploy",
]);

export const accessContextSchema = z
  .object({
    role: roleSchema,
    accountStatus: accountStatusSchema,
    deletionState: deletionStateSchema,
    schoolApproval: schoolApprovalSchema.nullable(),
    aiOnDuty: z.boolean(),
  })
  .strict()
  .superRefine((context, ctx) => {
    if (context.role === "student" && context.schoolApproval === null) {
      ctx.addIssue({
        code: "custom",
        message: "學生狀態必須帶有學校核准狀態",
        path: ["schoolApproval"],
      });
    }
  });

export type Role = z.infer<typeof roleSchema>;
export type Capability = z.infer<typeof capabilitySchema>;
export type ProjectTier = z.infer<typeof projectTierSchema>;
export type AccessContext = z.infer<typeof accessContextSchema>;

export type AccessDecision =
  | { allowed: true; code: "allowed" }
  | {
      allowed: false;
      code:
        | "invalid_input"
        | "account_unavailable"
        | "school_not_confirmed"
        | "role_not_authorized"
        | "ai_not_open"
        | "ai_off_duty"
        | "public_deploy_paused";
    };

// problem+json 是相容 reader；額外欄位保留，不代表 producer 可直接轉送。
export const requestIdSchema = z.string().min(1);
export const problemJsonSchema = z.looseObject({
  type: z.string(),
  title: z.string(),
  status: z.number().refine(Number.isInteger, "HTTP 狀態必須為整數"),
  code: z.string(),
  detail: z.string().optional(),
  instance: z.string(),
  request_id: requestIdSchema,
  user_message_zh: z.string(),
});

export const ifMatchRequiredErrorCodeSchema = z.literal("if_match_required");
export const invalidIfMatchErrorCodeSchema = z.literal("invalid_if_match");
export const versionConflictErrorCodeSchema = z.literal("version_conflict");
export const invalidEventCursorErrorCodeSchema = z.literal("invalid_event_cursor");
export const eventCursorUnavailableErrorCodeSchema = z.literal("event_cursor_unavailable");
export const unknownFieldErrorCodeSchema = z.literal("unknown_field");

const canonicalRowIfMatchPattern = /^"(?:0|-?[1-9]\d*)"$/;
const fileIfMatchPattern = /^"[0-9a-f]{64}"$/;

export const rowIfMatchSchema = z.string().regex(canonicalRowIfMatchPattern);
export const fileIfMatchSchema = z.string().regex(fileIfMatchPattern);

export function parseRowIfMatch(value: string): string | null {
  const result = rowIfMatchSchema.safeParse(value);
  return result.success ? result.data.slice(1, -1) : null;
}

export function parseFileIfMatch(value: string): string | null {
  const result = fileIfMatchSchema.safeParse(value);
  return result.success ? result.data.slice(1, -1) : null;
}

// data-model §4.2 的基礎列舉，不是完整 job；paused_off_duty 仍待核定。
export const jobBaseStateSchema = z.enum(["queued", "leased", "done", "failed", "cancelled"]);

// CHAT §3 補充通則的 support；僅驗證名稱與下列 payload，不組裝 SSE 傳輸封套。
export const sseEventNameSchema = z.enum(["delta", "block", "support", "partial", "done", "error"]);

// 下列 loose schema 僅供相容 reader；不是 producer 的輸出白名單。
export const sseBlockPayloadSchema = z.looseObject({
  category_group: z.literal("inappropriate"),
  safe_alternative_key: z.string(),
});
export const sseSupportPayloadSchema = z.looseObject({
  level: z.enum(["support", "high_risk"]),
  template_key: z.string(),
});
export const sseErrorPayloadSchema = z.looseObject({
  code: z.string(),
  user_message_zh: z.string(),
  retryable: z.boolean(),
});

const strictSseBlockPayloadSchema = z
  .object({
    category_group: z.literal("inappropriate"),
    safe_alternative_key: z.string(),
  })
  .strict();
const strictSseSupportPayloadSchema = z
  .object({
    level: z.enum(["support", "high_risk"]),
    template_key: z.string(),
  })
  .strict();

export const doneUsageValueSchema = z.union([
  z.number().finite().nonnegative(),
  z.literal("unknown"),
]);
export const doneUsageSchema = z
  .object({
    reserved: doneUsageValueSchema,
    settled_display: doneUsageValueSchema,
  })
  .strict();

export const sseDeltaProducerPayloadSchema = z
  .object({
    seq: z.number().int().safe().min(1),
    text: z.string(),
  })
  .strict();
export const sseBlockProducerPayloadSchema = strictSseBlockPayloadSchema;
export const sseSupportProducerPayloadSchema = strictSseSupportPayloadSchema;
export const ssePartialProducerPayloadSchema = z
  .object({
    saved_through_seq: z.number().int().safe().min(0),
  })
  .strict();

export const knownChatMessageErrorCodeSchema = z.enum([
  "ai_not_open",
  "ai_off_duty",
  "school_not_confirmed",
  "quota_daily_exhausted",
  "pool_creator_exhausted",
]);

// 這是 H-4 在 `200 text/event-stream` 之前回應的 HTTP 作用域碼，不是 SSE error 的白名單。
// SSE 作用域碼另見 sseErrorCodeSchema；S4（串流中途閘門重驗失敗）依賴 D-14，尚未登錄。
export const sseErrorCodeSchema = z.enum([
  "web_search_failed",
  "safety_check_unavailable",
  "generation_failed",
  "stream_internal_error",
]);
export type SseErrorCode = z.infer<typeof sseErrorCodeSchema>;

// 模板 key 為候選；文案仍是草案，教育者與專業適齡／安全審閱完成前不上線。
export const sseErrorRegistry = {
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
} as const satisfies Record<
  SseErrorCode,
  {
    retryable: "always" | "transient_only" | "never";
    templateKey: string;
    messageReview: "draft_unreviewed";
  }
>;

export const sseErrorProducerPayloadSchema = z
  .object({
    code: sseErrorCodeSchema,
    user_message_zh: z.string(),
    retryable: z.boolean(),
  })
  .strict()
  .superRefine((payload, ctx) => {
    const rule = sseErrorRegistry[payload.code].retryable;
    if (
      (rule === "always" && !payload.retryable) ||
      (rule === "never" && payload.retryable)
    ) {
      ctx.addIssue({
        code: "custom",
        message: "錯誤碼與 retryable 配對不符",
        path: ["retryable"],
      });
    }
  });
export const sseDoneProducerPayloadSchema = z
  .object({
    usage: doneUsageSchema,
  })
  .strict();

export const sseEventCursorSchema = z
  .string()
  .regex(/^\d+$/)
  .refine((cursor) => /[1-9]/.test(cursor), "事件游標必須為正整數");
export const sseNativeEventFieldsSchema = z
  .object({
    event: sseEventNameSchema,
    id: sseEventCursorSchema,
    data: z.string(),
  })
  .strict();

export function validateSseProducerPayload(event: SseEventName, payload: unknown) {
  switch (event) {
    case "delta":
      return sseDeltaProducerPayloadSchema.safeParse(payload);
    case "block":
      return sseBlockProducerPayloadSchema.safeParse(payload);
    case "support":
      return sseSupportProducerPayloadSchema.safeParse(payload);
    case "partial":
      return ssePartialProducerPayloadSchema.safeParse(payload);
    case "done":
      return sseDoneProducerPayloadSchema.safeParse(payload);
    case "error":
      return sseErrorProducerPayloadSchema.safeParse(payload);
  }
}

const progressSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("indeterminate") }).strict(),
  z
    .object({
      mode: z.literal("steps"),
      completed: z.number().int().min(0),
      total: z.number().int().positive(),
    })
    .strict()
    .refine((progress) => progress.completed <= progress.total, {
      message: "已完成步驟不可大於總步驟",
      path: ["completed"],
    }),
]);

// 契約明定的時刻欄位：ISO 8601 UTC，必須以大寫 Z 結尾；不接受 +00:00 或其他偏移。
// 不限制小數秒位數；不適用於純日期、自由內容、HTTP-date 或資料庫內部表示。
export const utcInstantSchema = z.iso.datetime();

const jobSnapshotFields = {
  id: z.uuid(),
  progress: progressSchema,
  started_at: utcInstantSchema.nullable(),
  updated_at: utcInstantSchema,
};

const jobSnapshotByKindSchema = z.discriminatedUnion("kind", [
  z
    .object({
      ...jobSnapshotFields,
      kind: z.literal("preview_build"),
      state: z.enum([
        "queued",
        "building",
        "retrieving",
        "validating",
        "succeeded",
        "failed",
        "cancelled",
      ]),
    })
    .strict(),
  z
    .object({
      ...jobSnapshotFields,
      kind: z.literal("image"),
      state: z.enum(["queued", "generating", "succeeded", "stopped", "failed"]),
    })
    .strict(),
  z
    .object({
      ...jobSnapshotFields,
      kind: z.literal("agent"),
      state: z.enum(["queued", "running", "succeeded", "failed", "cancelled"]),
    })
    .strict(),
  z
    .object({
      ...jobSnapshotFields,
      kind: z.literal("deploy"),
      state: z.enum(["queued", "deploying", "succeeded", "failed", "cancelled", "unknown"]),
    })
    .strict(),
  z
    .object({
      ...jobSnapshotFields,
      kind: z.literal("purge"),
      state: z.enum(["queued", "running", "done", "failed"]),
    })
    .strict(),
  z
    .object({
      ...jobSnapshotFields,
      kind: z.literal("reconcile"),
      state: z.enum(["queued", "running", "done", "failed", "cancelled"]),
    })
    .strict(),
]);

const runningJobStates = new Set([
  "building",
  "retrieving",
  "validating",
  "generating",
  "running",
  "deploying",
]);

const utcInstantPattern = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d+))?Z$/;

// 整秒部分交給 Date.parse（整數毫秒，無精度損失）；小數秒補零到同寬後以數字字串比較，
// 因此 ".1"、".100"、無小數秒與 ".000" 的等價表示不會被誤判。
export function compareUtcInstants(left: string, right: string): number | null {
  const leftMatch = utcInstantPattern.exec(left);
  const rightMatch = utcInstantPattern.exec(right);
  if (leftMatch === null || rightMatch === null) {
    return null;
  }

  const leftSecond = Date.parse(`${leftMatch[1]}Z`);
  const rightSecond = Date.parse(`${rightMatch[1]}Z`);
  if (Number.isNaN(leftSecond) || Number.isNaN(rightSecond)) {
    return null;
  }
  if (leftSecond !== rightSecond) {
    return leftSecond < rightSecond ? -1 : 1;
  }

  const width = Math.max(leftMatch[2]?.length ?? 0, rightMatch[2]?.length ?? 0);
  const leftFraction = (leftMatch[2] ?? "").padEnd(width, "0");
  const rightFraction = (rightMatch[2] ?? "").padEnd(width, "0");
  if (leftFraction === rightFraction) {
    return 0;
  }
  return leftFraction < rightFraction ? -1 : 1;
}

// 此為部分快照形狀，不含尚未定義完整安全欄位的 result／failure。
export const jobSnapshotCoreShapeSchema = jobSnapshotByKindSchema.superRefine((job, ctx) => {
  if (runningJobStates.has(job.state) && job.started_at === null) {
    ctx.addIssue({
      code: "custom",
      message: "執行中的工作必須有開始時間",
      path: ["started_at"],
    });
  }

  if (
    (job.state === "succeeded" || job.state === "done") &&
    job.started_at === null
  ) {
    ctx.addIssue({
      code: "custom",
      message: "成功完成的工作必須有開始時間",
      path: ["started_at"],
    });
  }

  if (job.started_at !== null) {
    const order = compareUtcInstants(job.updated_at, job.started_at);
    if (order === null || order < 0) {
      ctx.addIssue({
        code: "custom",
        message: order === null ? "更新時間與開始時間無法比較" : "更新時間不可早於開始時間",
        path: ["updated_at"],
      });
    }
  }
});

// 通則指定 UUID；沿用 Zod 的 UUID 格式驗證，不指定單一版本或轉換大小寫。
export const idempotencyKeySchema = z.uuid();
export const rowVersionSchema = z.number().refine(Number.isInteger, "版本必須為整數");

export type ProblemJson = z.infer<typeof problemJsonSchema>;
export type JobBaseState = z.infer<typeof jobBaseStateSchema>;
export type JobSnapshotCoreShape = z.infer<typeof jobSnapshotCoreShapeSchema>;
export type SseEventName = z.infer<typeof sseEventNameSchema>;
export type SseBlockPayload = z.infer<typeof sseBlockPayloadSchema>;
export type SseSupportPayload = z.infer<typeof sseSupportPayloadSchema>;
export type SseErrorPayload = z.infer<typeof sseErrorPayloadSchema>;
export type DoneUsage = z.infer<typeof doneUsageSchema>;

// ---- T006：producer 端 problem+json、409 衝突、202 Job 接受與冪等重用 ----
// 這些建構器逐欄讀取可信輸入並輸出嚴格形狀（D-30）；通過不證明內容安全，字串另經 R-12 遮蔽層拒絕已知敏感形狀。

export const idempotencyKeyReuseErrorCodeSchema = z.literal("idempotency_key_reuse");

const httpErrorCodeIdentifierSchema = z.string().regex(/^[a-z][a-z0-9_]*$/);
const hanCharacterPattern = /\p{Script=Han}/u;
const safeTextSchema = z
  .string()
  .min(1)
  .refine((text) => !containsSensitiveText(text), "文字含已知敏感形狀");

const problemProducerOutputSchema = z.strictObject({
  type: safeTextSchema,
  title: safeTextSchema,
  status: z.number().int().min(400).max(599),
  code: httpErrorCodeIdentifierSchema,
  detail: safeTextSchema.optional(),
  instance: safeTextSchema.refine((value) => !/[?#]/.test(value), "instance 不含查詢字串"),
  request_id: requestIdSchema.refine((value) => !containsSensitiveText(value), "request_id 含已知敏感形狀"),
  user_message_zh: safeTextSchema.refine((text) => hanCharacterPattern.test(text), "需為繁體中文訊息"),
});

const problemProducerInputKeys = [
  "type",
  "title",
  "status",
  "code",
  "detail",
  "instance",
  "request_id",
  "user_message_zh",
] as const;

export type ProblemProducerOutput = z.infer<typeof problemProducerOutputSchema>;
export type ProblemProducerPolicy = { readonly codes: readonly string[] };
export type ProducerFailure = { ok: false; code: "invalid_problem_record" };
export type BuildProblemJsonResult = { ok: true; data: ProblemProducerOutput } | ProducerFailure;
export type CreateProblemProducerPolicyResult =
  | { ok: true; policy: ProblemProducerPolicy }
  | ProducerFailure;

const producerFailure = (): ProducerFailure => ({ ok: false, code: "invalid_problem_record" });
const sseCodeSet: ReadonlySet<string> = new Set(sseErrorCodeSchema.options);

// 錯誤碼登錄只能由可信應用程式設定提供；不內建完整碼表，也不接受 SSE 專屬碼。
export function createProblemProducerPolicy(input: unknown): CreateProblemProducerPolicyResult {
  if (!isPlainRecord(input) || !hasOnlyAllowedDataProperties(input, ["codes"])) {
    return producerFailure();
  }
  const parsed = z
    .strictObject({ codes: z.array(httpErrorCodeIdentifierSchema).min(1) })
    .safeParse(input);
  if (!parsed.success || parsed.data.codes.some((code) => sseCodeSet.has(code))) {
    return producerFailure();
  }
  return { ok: true, policy: Object.freeze({ codes: Object.freeze([...new Set(parsed.data.codes)]) }) };
}

function readProblemFields(input: unknown) {
  if (!isPlainRecord(input) || !hasNoAccessors(input, problemProducerInputKeys)) {
    return null;
  }
  return Object.fromEntries(
    problemProducerInputKeys
      .filter((key) => input[key] !== undefined)
      .map((key) => [key, input[key]]),
  );
}

export function buildProblemJson(input: unknown, policyInput: unknown): BuildProblemJsonResult {
  const policy = createProblemProducerPolicy(policyInput);
  const fields = readProblemFields(input);
  if (!policy.ok || fields === null) {
    return producerFailure();
  }
  const parsed = problemProducerOutputSchema.safeParse(fields);
  if (!parsed.success || !policy.policy.codes.includes(parsed.data.code)) {
    return producerFailure();
  }
  return { ok: true, data: Object.freeze(parsed.data) };
}

const sha256HexSchema = z.string().regex(/^[0-9a-f]{64}$/);
const conflictPrimitiveSchema = z.union([
  safeTextSchema.or(z.literal("")),
  z.number().finite(),
  z.boolean(),
  z.null(),
]);

export type VersionConflictResource = "row" | "file";
export type VersionConflictPolicy = {
  readonly resource: VersionConflictResource;
  // row 端點明列「本端點允許讀寫且本次涉及」的欄位；file 端點不使用。
  readonly allowedContentFields: readonly string[];
};
export type VersionConflictBody = ProblemProducerOutput & {
  readonly code: "version_conflict";
  readonly status: 409;
  readonly conflict: {
    readonly current: { readonly version: number | string; readonly content: unknown };
    readonly submitted: { readonly version: number | string; readonly content: unknown };
  };
};
export type BuildVersionConflictResult =
  | { ok: true; data: VersionConflictBody }
  | ProducerFailure;

function buildConflictSide(
  side: unknown,
  policy: VersionConflictPolicy,
  contentMayBeNull: boolean,
): { version: number | string; content: unknown } | null {
  if (!isPlainRecord(side) || !hasNoAccessors(side, ["version", "content"])) {
    return null;
  }
  const version =
    policy.resource === "row"
      ? rowVersionSchema.safeParse(side.version)
      : sha256HexSchema.safeParse(side.version);
  if (!version.success) {
    return null;
  }

  const content = side.content;
  if (content === null) {
    return contentMayBeNull || policy.resource === "file"
      ? { version: version.data, content: null }
      : null;
  }
  if (policy.resource === "file") {
    // 二進位檔不回傳 bytes；此處只接受已安全建構的文字或 null。
    return typeof content === "string" && !containsSensitiveText(content)
      ? { version: version.data, content }
      : null;
  }
  if (!isPlainRecord(content) || !hasNoAccessors(content, policy.allowedContentFields)) {
    return null;
  }
  const projected: Record<string, string | number | boolean | null> = {};
  for (const field of policy.allowedContentFields) {
    if (content[field] === undefined) {
      continue;
    }
    const value = conflictPrimitiveSchema.safeParse(content[field]);
    if (!value.success) {
      return null;
    }
    projected[field] = value.data;
  }
  return { version: version.data, content: Object.freeze(projected) };
}

export function buildVersionConflictProblem(
  input: unknown,
  policyInput: unknown,
): BuildVersionConflictResult {
  const policy = z
    .strictObject({
      resource: z.enum(["row", "file"]),
      allowedContentFields: z.array(z.string().regex(/^[a-z][a-z0-9_]*$/)),
    })
    .safeParse(policyInput);
  if (
    !policy.success ||
    !isPlainRecord(input) ||
    !hasNoAccessors(input, [...problemProducerInputKeys, "conflict"]) ||
    (policy.data.resource === "row" && policy.data.allowedContentFields.length === 0)
  ) {
    return producerFailure();
  }
  const conflict = input.conflict;
  if (!isPlainRecord(conflict) || !hasNoAccessors(conflict, ["current", "submitted"])) {
    return producerFailure();
  }
  const current = buildConflictSide(conflict.current, policy.data, false);
  const submitted = buildConflictSide(conflict.submitted, policy.data, true);
  const fields = readProblemFields({ ...input, code: "version_conflict", status: 409 });
  if (current === null || submitted === null || fields === null) {
    return producerFailure();
  }
  const parsed = problemProducerOutputSchema.safeParse(fields);
  if (!parsed.success) {
    return producerFailure();
  }
  return {
    ok: true,
    data: Object.freeze({
      ...parsed.data,
      code: "version_conflict" as const,
      status: 409 as const,
      conflict: Object.freeze({ current: Object.freeze(current), submitted: Object.freeze(submitted) }),
    }),
  };
}

const jobAcceptedBodyKeys = ["id", "kind", "state", "progress", "started_at", "updated_at", "result", "failure"];

export type JobAcceptedResponse = {
  readonly status: 202;
  readonly headers: { readonly location: string };
  readonly body: JobSnapshotCoreShape & { readonly result: null; readonly failure: null };
};
export type BuildJobAcceptedResult = { ok: true; data: JobAcceptedResponse } | ProducerFailure;

// 202 只代表「已接受」：快照必須是尚未開始的 queued，result／failure 兩鍵都必須明確為 null，
// 不以輪詢或成功形狀預設值暗示完成。各 kind 的成功 result 欄位尚未定義，因此這裡不處理終態。
export function buildJobAcceptedResponse(input: unknown): BuildJobAcceptedResult {
  if (!isPlainRecord(input) || !hasOnlyAllowedDataProperties(input, jobAcceptedBodyKeys)) {
    return producerFailure();
  }
  if (!Object.hasOwn(input, "result") || !Object.hasOwn(input, "failure") || input.result !== null || input.failure !== null) {
    return producerFailure();
  }
  const { result: _result, failure: _failure, ...snapshotFields } = input;
  const snapshot = jobSnapshotCoreShapeSchema.safeParse(snapshotFields);
  if (!snapshot.success || snapshot.data.state !== "queued" || snapshot.data.started_at !== null) {
    return producerFailure();
  }
  return {
    ok: true,
    data: Object.freeze({
      status: 202 as const,
      headers: Object.freeze({ location: `/api/v1/jobs/${snapshot.data.id}` }),
      body: Object.freeze({ ...snapshot.data, result: null, failure: null }),
    }),
  };
}
