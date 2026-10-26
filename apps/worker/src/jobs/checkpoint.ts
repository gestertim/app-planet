import { z } from "zod";
import {
  jobSchema, UsageFailure, usageDatabaseCall,
  type MeteredUsage, type UsageContext, type UsageJob,
} from "../../../../packages/core/usage/ledger.ts";

export interface WorkerGate {
  // 正式 adapter 尚未接線；每次必須重驗 capability／duty／resource，不能信任入列快照。
  authorize(job: UsageJob): Promise<boolean>;
}
export type CheckpointOperation = "heartbeat" | "begin" | "complete" | "done" | "retry" | "unknown" | "stop" | "not_sent";

export function createCheckpoints(context: UsageContext, gate: WorkerGate, workerId: string, leaseMs: number) {
  z.uuid().parse(workerId);
  z.number().int().positive().max(2147483647).parse(leaseMs);
  return {
    async claim(): Promise<UsageJob | null> {
      return usageDatabaseCall(() => context.runTransaction(async (query) => {
        const { rows } = await query.query("SELECT * FROM app.job_claim($1::uuid,$2::integer)", [workerId, leaseMs]);
        const result = z.array(jobSchema).max(1).safeParse(rows);
        if (!result.success) throw new UsageFailure("invalid_result");
        return result.data[0] ?? null;
      }));
    },
    async save(job: UsageJob, operation: CheckpointOperation, ref: string | null = null, usage: MeteredUsage | null = null) {
      // 即使 gate 拒絕，也要進 DB 以 fence 判斷並安全終結；外部 unknown 不釋放。
      const allowed = await gate.authorize(job);
      return usageDatabaseCall(() => context.runTransaction(async (query) => {
        const { rows } = await query.query(
          "SELECT * FROM app.job_checkpoint($1::uuid,$2::uuid,$3::bigint,$4::text,$5::integer,$6::uuid,$7::jsonb)",
          [job.id, workerId, job.fence, allowed ? operation : "stop", leaseMs, ref, usage],
        );
        const result = z.array(jobSchema).length(1).safeParse(rows);
        if (!result.success) throw new UsageFailure("invalid_result");
        return result.data[0];
      }));
    },
  };
}
