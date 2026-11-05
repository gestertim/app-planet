import { z } from "zod";

const uuid = z.uuid().transform((value) => value.toLowerCase());
export const teacherViewAuditPositionSchema = z.strictObject({
  at: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/)
    .datetime({ precision: 6 }),
  id: uuid,
});
export const teacherViewAuditCursorSchema = z.strictObject({
  v: z.literal(1),
  teacher_id: uuid.nullable(),
  student_id: uuid.nullable(),
  position: teacherViewAuditPositionSchema,
});
export const teacherViewAuditQuerySchema = z.strictObject({
  teacher_id: uuid.optional(),
  student_id: uuid.optional(),
  after: z.string().min(1).max(1024).regex(/^[A-Za-z0-9_-]+$/).optional(),
  limit: z.string().regex(/^[1-9]\d?$/).transform(Number).pipe(z.number().int().max(50)).default(20),
});
export const teacherViewAuditItemSchema = z.strictObject({
  teacher_label: z.string().refine((value) => value.trim().length > 0),
  student_label: z.string().refine((value) => value.trim().length > 0),
  viewed_at: teacherViewAuditPositionSchema.shape.at,
});
export const teacherViewAuditPageSchema = z.strictObject({
  outcome: z.literal("found"),
  items: z.array(teacherViewAuditItemSchema).max(50),
  next_cursor: z.string().min(1).max(1024).regex(/^[A-Za-z0-9_-]+$/).nullable(),
});
export type TeacherViewAuditPage = z.infer<typeof teacherViewAuditPageSchema>;
