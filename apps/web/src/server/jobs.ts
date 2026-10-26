import { z } from "zod";
import { UsageFailure, usageDatabaseCall, type UsageContext } from "@app-planet/core";

// COMMON 狀態查詢的 server 端讀取：僅擁有者、當下帳號 gate 重驗；非擁有者與不存在一律 not_found。
// DB 的 jobs 列不等於 wire DTO。各 kind 的狀態名稱與成功 result 尚未全數核定，
// 這裡只對已核定對映的 kind 產生快照，其餘回 unsupported，不推測。

const rowSchema = z.object({
  job_id: z.uuid(),
  kind: z.string(),
  state: z.enum(["queued", "leased", "done", "failed", "cancelled"]),
  started_at: z.date().nullable(),
  updated_at: z.date(),
  failure_code: z.string().nullable(),
  checkpoint: z.number().int().nonnegative(),
  effect_state: z.enum(["ready", "in_flight", "unknown"]),
});

export type OwnedJobStatus =
  | { outcome: "found"; snapshot: Record<string, unknown>; failure: { code: string; user_message_zh: string } | null }
  | { outcome: "not_found" }
  | { outcome: "denied" }
  | { outcome: "unsupported" }
  | { outcome: "failed" };

// 只核定 agent 的狀態對映（queued／running／failed／cancelled）；成功終態沒有已定義 result，不在此產生。
const agentStates = { queued: "queued", leased: "running", failed: "failed", cancelled: "cancelled" } as const;

export async function readOwnedJobStatus(context: UsageContext, jobId: unknown): Promise<OwnedJobStatus> {
  const id = z.uuid().safeParse(jobId);
  if (!id.success) return { outcome: "not_found" };
  try {
    return await usageDatabaseCall(() => context.runTransaction(async (query): Promise<OwnedJobStatus> => {
      const { rows: actors } = await query.query(
        "SELECT current_user = 'app_usage_executor' AND auth.uid() IS NOT NULL AS valid",
      );
      if (!z.array(z.object({ valid: z.literal(true) })).length(1).safeParse(actors).success) {
        throw new UsageFailure("invalid_context");
      }
      const { rows } = await query.query("SELECT * FROM app.job_status($1::uuid)", [id.data.toLowerCase()]);
      if (rows.length === 0) return { outcome: "not_found" };
      const parsed = z.array(rowSchema).length(1).safeParse(rows);
      if (!parsed.success) throw new UsageFailure("invalid_result");
      const job = parsed.data[0];
      if (job.kind !== "agent" || job.state === "done") return { outcome: "unsupported" };
      const failed = job.state === "failed" || job.state === "cancelled";
      return {
        outcome: "found",
        snapshot: {
          id: job.job_id,
          kind: "agent",
          state: agentStates[job.state],
          progress: { mode: "indeterminate" },
          started_at: job.started_at?.toISOString() ?? null,
          updated_at: job.updated_at.toISOString(),
        },
        failure: failed
          ? {
              code: job.effect_state === "unknown" ? "reconciliation_required" : "job_not_completed",
              user_message_zh: job.effect_state === "unknown"
                ? "工作結果尚待核對，請不要重複送出，並詢問老師。"
                : "這項工作沒有完成，請稍後再試或詢問老師。",
            }
          : null,
      };
    }));
  } catch (error) {
    if (error instanceof UsageFailure && error.code === "authorization_denied") return { outcome: "denied" };
    return { outcome: "failed" };
  }
}
