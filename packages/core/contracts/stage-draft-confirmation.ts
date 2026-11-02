import { z } from "zod";
import { projectStageSchema } from "./stage-drafts.ts";

// 學生對「已保存草稿確切版本」的明確確認；不是教師／管理員批准、Checkpoint 或分類證據。
export const stageConfirmationBodySchema = z.strictObject({
  expected_row_version: z.number().int().min(0).max(2147483647),
});
export const stageConfirmationReceiptSchema = z.strictObject({
  project_id: z.string().uuid(),
  stage: projectStageSchema,
  row_version: z.number().int().min(0).max(2147483647),
  content_hash: z.string().regex(/^[0-9a-f]{64}$/),
  confirmed_at: z.string().min(1),
});
export const stageConfirmationStatusSchema = z.strictObject({
  project_id: z.string().uuid(),
  stage: projectStageSchema,
  state: z.enum(["no_draft", "unconfirmed", "confirmed_current", "confirmation_stale"]),
  draft_row_version: z.number().int().min(0).max(2147483647).nullable(),
  latest_confirmation: stageConfirmationReceiptSchema.nullable(),
  approval: z.literal("manual_approval_unavailable"),
});
export const stageConfirmationResultSchema = z.strictObject({
  outcome: z.enum(["confirmed", "replayed", "already_confirmed"]),
  confirmation: stageConfirmationReceiptSchema,
  current: z.boolean(),
});
export type StageConfirmationReceipt = z.infer<typeof stageConfirmationReceiptSchema>;
export type StageConfirmationStatus = z.infer<typeof stageConfirmationStatusSchema>;
export type StageConfirmationResult = z.infer<typeof stageConfirmationResultSchema>;
