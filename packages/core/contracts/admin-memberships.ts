import { z } from "zod";

export const membershipCreateSchema = z.object({ teacher_id: z.uuid(), school_id: z.uuid() }).strict();
export const membershipEndSchema = z.object({}).strict();
export const membershipIntentSchema = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("create"), key: z.uuid(), body: membershipCreateSchema }).strict(),
  z.object({ operation: z.literal("end"), key: z.uuid(), target: z.uuid(), body: membershipEndSchema }).strict(),
]);
export const membershipReceiptSchema = z.object({
  outcome: z.enum(["created", "ended", "replayed"]), operation: z.enum(["create", "end"]),
  membership_id: z.uuid(), teacher_id: z.uuid(), school_id: z.uuid(),
  state: z.enum(["active", "ended"]), operated_at: z.iso.datetime(),
}).strict().refine((value) => value.operation === "create"
  ? value.state === "active" && value.outcome !== "ended"
  : value.state === "ended" && value.outcome !== "created");
export const membershipCandidateSchema = z.object({
  id: z.uuid(), display_label: z.string().max(120), qualified: z.literal(true),
}).strict();
export const membershipRowSchema = z.object({
  id: z.uuid(), teacher_id: z.uuid(), school_id: z.uuid(), state: z.enum(["active", "ended"]),
  teacher_label: z.string().max(120), school_label: z.string().max(120),
}).strict();
export const membershipListSchema = z.discriminatedUnion("kind", [
  z.object({ outcome: z.literal("found"), kind: z.literal("teachers"),
    items: z.array(membershipCandidateSchema).max(20), next_cursor: z.uuid().nullable() }).strict(),
  z.object({ outcome: z.literal("found"), kind: z.literal("schools"),
    items: z.array(membershipCandidateSchema).max(20), next_cursor: z.uuid().nullable() }).strict(),
  z.object({ outcome: z.literal("found"), kind: z.literal("memberships"),
    items: z.array(membershipRowSchema).max(20), next_cursor: z.uuid().nullable() }).strict(),
]);
export const membershipQuerySchema = z.object({
  kind: z.enum(["teachers", "schools", "memberships"]), after: z.uuid().optional(),
}).strict();
export type MembershipIntent = z.infer<typeof membershipIntentSchema>;
export type MembershipReceipt = z.infer<typeof membershipReceiptSchema>;
export type MembershipCandidate = z.infer<typeof membershipCandidateSchema>;
export type MembershipRow = z.infer<typeof membershipRowSchema>;
export type MembershipList = z.infer<typeof membershipListSchema>;
