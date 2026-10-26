import { z } from "zod";

export interface UsageQuery {
  query(text: string, values?: unknown[]): Promise<{ rows: unknown[] }>;
}
export interface UsageContext {
  runTransaction<T>(operation: (query: UsageQuery) => Promise<T>): Promise<T>;
}
export interface UsageAuthorization {
  // 由可信 server adapter 在同一交易重驗帳號、學校、resource 與 duty；無正式預設 adapter。
  authorize(query: UsageQuery, resource: string | null): Promise<boolean>;
}
export const jobSchema = z.object({
  id: z.uuid(),
  reservation_id: z.uuid(),
  subject_id: z.uuid(),
  school_id: z.uuid(),
  school_epoch: z.string().regex(/^\d+$/),
  resource_id: z.uuid().nullable(),
  kind: z.string(),
  state: z.enum(["queued", "leased", "done", "failed", "cancelled"]),
  lease_owner: z.uuid().nullable(),
  fence: z.string().regex(/^\d+$/),
  checkpoint: z.number().int().nonnegative(),
  attempts: z.number().int().nonnegative(),
  effect_state: z.enum(["ready", "in_flight", "unknown"]),
  partial_refs: z.array(z.uuid()),
  cancel_requested: z.boolean(),
});
export type UsageJob = z.infer<typeof jobSchema>;
export const usageSchema = z.strictObject({
  input_tokens: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  cached_input_tokens: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  output_tokens: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  images: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
}).refine((usage) => usage.cached_input_tokens <= usage.input_tokens);
export type MeteredUsage = z.infer<typeof usageSchema>;

export class UsageFailure extends Error {
  constructor(readonly code: string) { super(code); this.name = "UsageFailure"; }
}
const databaseCodes = new Set([
  "invalid_input", "authorization_denied", "policy_not_approved", "idempotency_key_reuse",
  "rate_limited", "concurrency_limited", "quota_daily_exhausted", "pool_creator_exhausted",
  "stale_lease", "reconciliation_required", "invalid_usage", "reservation_state_conflict",
  "effect_already_started", "invalid_checkpoint", "effect_not_complete",
]);
export async function usageDatabaseCall<T>(operation: () => Promise<T>): Promise<T> {
  try { return await operation(); }
  catch (error) {
    if (error instanceof UsageFailure) throw error;
    const message = error instanceof Error ? error.message : "";
    throw new UsageFailure(databaseCodes.has(message) ? message : "dependency_failure");
  }
}

export function taipeiPeriodKeys(instant: Date): { day: string; month: string } {
  if (!Number.isFinite(instant.getTime())) throw new UsageFailure("invalid_input");
  const date = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Taipei", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(instant);
  return { day: date, month: `${date.slice(0, 7)}-01` };
}

const requestSchema = z.strictObject({
  idempotencyKey: z.uuid(), policyId: z.uuid(),
  estimateMicro: z.bigint().positive().max(BigInt("9223372036854775807")),
  resourceId: z.uuid().nullable(),
});
export function createUsageLedger(context: UsageContext, authorization: UsageAuthorization) {
  return {
    async reserve(input: z.infer<typeof requestSchema>): Promise<UsageJob> {
      const parsed = requestSchema.safeParse(input);
      if (!parsed.success) throw new UsageFailure("invalid_input");
      const request = parsed.data;
      return usageDatabaseCall(() => context.runTransaction(async (query) => {
        const { rows: actors } = await query.query(
          "SELECT current_user = 'app_usage_executor' AND auth.uid() IS NOT NULL AS valid",
        );
        if (!z.array(z.object({ valid: z.literal(true) })).length(1).safeParse(actors).success) {
          throw new UsageFailure("invalid_context");
        }
        if (!await authorization.authorize(query, request.resourceId)) throw new UsageFailure("authorization_denied");
        const { rows } = await query.query(
          "SELECT * FROM app.usage_reserve($1::uuid,$2::uuid,$3::bigint,$4::uuid)",
          [request.idempotencyKey, request.policyId, request.estimateMicro.toString(), request.resourceId],
        );
        const result = z.array(jobSchema).length(1).safeParse(rows);
        if (!result.success) throw new UsageFailure("invalid_result");
        return result.data[0];
      }));
    },
    async cancel(jobId: string): Promise<boolean> {
      if (!z.uuid().safeParse(jobId).success) throw new UsageFailure("invalid_input");
      return usageDatabaseCall(() => context.runTransaction(async (query) => {
        const { rows } = await query.query("SELECT app.job_cancel($1::uuid) AS cancelled", [jobId]);
        return z.array(z.object({ cancelled: z.boolean() })).length(1).parse(rows)[0].cancelled;
      }));
    },
  };
}
