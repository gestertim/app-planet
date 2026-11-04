import { z } from "zod";

const version = z.number().int().min(0).max(2147483647);
export const staffReviewBodySchema = z.strictObject({ decision: z.enum(["approved", "rejected"]) });
export const pendingTeacherSchema = z.strictObject({
  id: z.uuid(),
  display_label: z.string().nullable(),
  status: z.literal("pending"),
  row_version: version,
  // readiness §92：教師申請的學校／任教說明，僅供管理員審核的未受信任內容；不是學校歸屬或核准。
  school_note: z.string().max(200).nullable(),
});
export const pendingTeachersPageSchema = z.strictObject({
  items: z.array(pendingTeacherSchema).max(50),
  next_cursor: z.uuid().nullable(),
});
export const staffReviewResultSchema = z.strictObject({
  id: z.uuid(), status: z.enum(["approved", "rejected"]), row_version: version,
});
export type PendingTeacher = z.infer<typeof pendingTeacherSchema>;
