import { z } from "zod";

// 只作工程輸入防護；不正規化名稱、不推定學校身分或名稱唯一。
export const schoolLabelSchema = z.string().refine((value) => value.trim().length > 0 && !value.includes("\0"));
export const schoolCreateSchema = z.object({ label: schoolLabelSchema }).strict();
export const schoolQuerySchema = z.object({ after: z.uuid().optional() }).strict();
export const schoolIntentSchema = z.object({
  operation: z.literal("create"), key: z.uuid(), body: schoolCreateSchema,
}).strict();
export const schoolSummarySchema = z.object({
  id: z.uuid(), label: z.string(),
  approval_state: z.enum(["unconfirmed", "approved", "withdrawn", "expired"]),
  approval_epoch: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  valid_until: z.iso.datetime().nullable(),
}).strict();
export const schoolDetailSchema = z.object({
  outcome: z.literal("found"), school: schoolSummarySchema.extend({
    current_doc_version: z.string().nullable(),
    verification_history: z.literal("not_available"), last_change: z.null(),
  }).strict(),
}).strict();
export const schoolListSchema = z.object({
  outcome: z.literal("found"), items: z.array(schoolSummarySchema).max(20),
  next_cursor: z.uuid().nullable(),
}).strict().refine((value) => value.items.every((item, index, items) =>
  index === 0 || items[index - 1]!.id.toLowerCase() < item.id.toLowerCase())
  && (value.next_cursor === null || (value.items.length === 20
    && value.next_cursor.toLowerCase() === value.items.at(-1)!.id.toLowerCase())));
export const schoolReceiptSchema = z.object({
  outcome: z.enum(["created", "replayed"]), operation: z.literal("create"),
  school_id: z.uuid(), label: schoolLabelSchema,
  approval_state: z.literal("unconfirmed"), approval_epoch: z.literal(0),
  valid_until: z.null(), current_doc_version: z.null(), operated_at: z.iso.datetime(),
}).strict();
export type SchoolIntent = z.infer<typeof schoolIntentSchema>;
export type SchoolReceipt = z.infer<typeof schoolReceiptSchema>;
export type SchoolList = z.infer<typeof schoolListSchema>;
export type SchoolDetail = z.infer<typeof schoolDetailSchema>;
