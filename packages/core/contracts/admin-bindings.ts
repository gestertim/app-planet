import { z } from "zod";
import { specificationReasonSchema } from "./specification-review.ts";

export const bindingCreateSchema = z.object({ teacher_id: z.uuid(), student_id: z.uuid() }).strict();
export const bindingEndSchema = z.object({ end_reason: specificationReasonSchema }).strict();
export const bindingIntentSchema = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("create"), key: z.uuid(), body: bindingCreateSchema }).strict(),
  z.object({ operation: z.literal("end"), key: z.uuid(), target: z.uuid(), body: bindingEndSchema }).strict(),
]);
export const bindingReceiptSchema = z.object({
  outcome: z.enum(["created", "ended", "replayed"]), operation: z.enum(["create", "end"]),
  binding_id: z.uuid(), state: z.enum(["active", "ended"]), operated_at: z.iso.datetime(),
}).strict().refine((value) =>
  value.operation === "create"
    ? value.state === "active" && value.outcome !== "ended"
    : value.state === "ended" && value.outcome !== "created");
export const bindingCandidateSchema = z.object({
  id: z.uuid(), account_id: z.uuid(), label: z.string().max(120),
  role: z.enum(["teacher", "student"]), qualified: z.literal(true),
  school_id: z.uuid(), school_label: z.string().max(120),
}).strict();
export const bindingRowSchema = z.object({
  id: z.uuid(), teacher_id: z.uuid(), student_id: z.uuid(), state: z.enum(["active", "ended"]),
  teacher_label: z.string().max(120), student_label: z.string().max(120),
  school_id: z.uuid(), school_label: z.string().max(120),
}).strict();
export const bindingListSchema = z.discriminatedUnion("kind", [
  z.object({ outcome: z.literal("found"), kind: z.literal("teachers"),
    items: z.array(bindingCandidateSchema.extend({ role: z.literal("teacher") })).max(20),
    next_cursor: z.uuid().nullable() }).strict(),
  z.object({ outcome: z.literal("found"), kind: z.literal("students"),
    items: z.array(bindingCandidateSchema.extend({ role: z.literal("student") })).max(20),
    next_cursor: z.uuid().nullable() }).strict(),
  z.object({ outcome: z.literal("found"), kind: z.literal("bindings"),
    items: z.array(bindingRowSchema).max(20), next_cursor: z.uuid().nullable() }).strict(),
]);
export const bindingQuerySchema = z.object({
  kind: z.enum(["teachers", "students", "bindings"]), after: z.uuid().optional(),
  teacher_id: z.uuid().optional(), school_id: z.uuid().optional(),
}).strict().refine((value) => value.kind === "students"
  ? value.teacher_id !== undefined && value.school_id !== undefined
  : value.teacher_id === undefined && value.school_id === undefined);
export type BindingIntent = z.infer<typeof bindingIntentSchema>;
export type BindingReceipt = z.infer<typeof bindingReceiptSchema>;
export type BindingCandidate = z.infer<typeof bindingCandidateSchema>;
export type BindingRow = z.infer<typeof bindingRowSchema>;
export type BindingList = z.infer<typeof bindingListSchema>;
