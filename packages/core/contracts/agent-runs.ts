import { z } from "zod";
import { stageDraftContentSchema } from "./stage-drafts.ts";

export const agentRunIdSchema = z.uuid().transform((id) => id.toLowerCase()).brand<"AgentRunId">();
export const agentJobIdSchema = z.uuid().transform((id) => id.toLowerCase()).brand<"AgentJobId">();
export type AgentRunId = z.infer<typeof agentRunIdSchema>;
export type AgentJobId = z.infer<typeof agentJobIdSchema>;
export const agentRunStateSchema = z.enum([
  "awaiting_approval", "running", "stopping", "stopped", "completed", "failed",
]);
export const agentRunDtoSchema = z.strictObject({
  run_id: agentRunIdSchema,
  project_id: z.uuid(),
  mode: z.enum(["guided", "auto"]),
  state: agentRunStateSchema,
  jobs: z.array(z.strictObject({
    job_id: agentJobIdSchema,
    state: z.enum(["queued", "leased", "done", "failed", "cancelled"]),
    cancel_requested: z.boolean(),
  })),
}).refine((run) => new Set(run.jobs.map((job) => job.job_id)).size === run.jobs.length);
export type AgentRunDto = z.infer<typeof agentRunDtoSchema>;
export const createAgentRunRequestSchema = z.strictObject({
  project_id: z.uuid(),
  mode: z.enum(["guided", "auto"]),
  instruction: stageDraftContentSchema.shape.text.refine((text) => text.length > 0),
  idempotency_key: z.uuid(),
});
export const startAgentRunRequestSchema = z.strictObject({
  run_id: agentRunIdSchema,
  approval: z.union([
    z.strictObject({ step_seq: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) }),
    z.strictObject({ approved_task_ids: z.array(z.uuid()).min(1).refine(
      (ids) => new Set(ids.map((id) => id.toLowerCase())).size === ids.length,
    ) }),
  ]),
  idempotency_key: z.uuid(),
});
export const agentRunLookupSchema = z.strictObject({ run_id: agentRunIdSchema });
export const agentRunOperationResultSchema = z.union([
  z.strictObject({
    outcome: z.enum(["created", "replayed"]),
    operation: agentRunDtoSchema,
    current: agentRunDtoSchema,
  }),
  z.strictObject({
    outcome: z.enum(["found", "stop_acknowledged"]),
    run: agentRunDtoSchema,
  }),
  z.strictObject({
    outcome: z.literal("unavailable"),
    missing: z.tuple([
      z.literal("pre_agent_snapshot"),
      z.literal("agent_approval_evidence"),
      z.literal("agent_execution_authorization"),
    ]),
  }),
  z.strictObject({
    outcome: z.enum([
      "invalid_input", "not_found", "denied", "idempotency_conflict",
      "active_run_conflict", "state_conflict",
    ]),
  }),
]);
export type AgentRunOperationResult = z.infer<typeof agentRunOperationResultSchema>;

// 正式 G-3 成功契約；內部停止 acknowledgement 不是 HTTP 或產物／恢復成果。
export const agentRunStopHttpStatus = 200;
