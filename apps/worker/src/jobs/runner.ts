import { usageSchema, UsageFailure, type MeteredUsage, type UsageJob } from "../../../../packages/core/usage/ledger.ts";
import { createCheckpoints } from "./checkpoint.ts";

export interface StepAdapter {
  stepCount(job: UsageJob): number;
  execute(job: UsageJob, signal: AbortSignal): Promise<
    | { outcome: "completed"; ref: string; usage: MeteredUsage }
    | { outcome: "not_sent_retryable" }
    | { outcome: "unknown" }
  >;
}

// 沒有正式 provider 預設；只接受明確注入的 adapter，不匯入 Auth／AI／郵件／Sandbox。
export async function runOne(
  checkpoints: ReturnType<typeof createCheckpoints>,
  adapter: StepAdapter,
  heartbeatMs: number,
): Promise<UsageJob | null> {
  if (!Number.isSafeInteger(heartbeatMs) || heartbeatMs < 1) throw new UsageFailure("invalid_input");
  let job = await checkpoints.claim();
  if (!job) return null;
  const count = adapter.stepCount(job);
  if (!Number.isSafeInteger(count) || count < job.checkpoint) throw new UsageFailure("invalid_adapter");
  while (job.checkpoint < count && job.state === "leased") {
    job = await checkpoints.save(job, "begin");
    if (job.state !== "leased") return job;
    const controller = new AbortController();
    let heartbeatFailure: unknown;
    let heartbeat = Promise.resolve();
    let pending = false;
    const timer = setInterval(() => {
      if (pending || heartbeatFailure) return;
      pending = true;
      heartbeat = checkpoints.save(job!, "heartbeat").then((current) => {
        job = current;
        if (current.state !== "leased") controller.abort();
      }).catch((error: unknown) => {
        heartbeatFailure = error;
        controller.abort();
      }).finally(() => { pending = false; });
    }, heartbeatMs);
    let result: Awaited<ReturnType<StepAdapter["execute"]>>;
    try {
      result = await adapter.execute(job, controller.signal);
    } catch {
      // 送出後例外沒有可靠未送出證據；不可套用一般 retry。
      result = { outcome: "unknown" };
    } finally {
      clearInterval(timer);
      await heartbeat;
    }
    if (heartbeatFailure) throw new UsageFailure("lease_or_heartbeat_failure");
    if (job.state !== "leased") return job;
    if (result.outcome === "unknown") return checkpoints.save(job, "unknown");
    if (result.outcome === "not_sent_retryable") {
      job = await checkpoints.save(job, "not_sent");
      return job.state === "leased" ? checkpoints.save(job, "retry") : job;
    }
    const usage = usageSchema.safeParse(result.usage);
    if (!usage.success) return checkpoints.save(job, "unknown");
    job = await checkpoints.save(job, "complete", result.ref, usage.data);
  }
  return job.state === "leased" ? checkpoints.save(job, "done") : job;
}
