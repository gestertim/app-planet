import { z } from "zod";
import { projectStageSchema, stageDraftContentSchema } from "./stage-drafts.ts";
import { projectRequirementsSchema } from "./project-classification.ts";

const uuid = z.uuid();
const cursorSchema = uuid.nullable();
const timestampSchema = z.string().datetime({ offset: true });

export const teacherResourcePageQuerySchema = z.strictObject({
  after: uuid.optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

export const teacherStudentDtoSchema = z.strictObject({
  id: uuid,
  display_label: z.string().min(1).max(120),
});

export const teacherStudentPageSchema = z.strictObject({
  outcome: z.literal("found"),
  items: z.array(teacherStudentDtoSchema).max(50),
  next_cursor: cursorSchema,
});

export const teacherProjectListItemSchema = z.strictObject({
  id: uuid,
  title: z.string().min(1),
  stage: projectStageSchema,
  classification_state: z.enum(["unconfirmed", "legacy_unverified", "confirmed"]),
});

export const teacherProjectPageSchema = z.strictObject({
  outcome: z.literal("found"),
  items: z.array(teacherProjectListItemSchema).max(50),
  next_cursor: cursorSchema,
});

const teacherProjectTaskSchema = z.strictObject({
  id: uuid,
  title: z.string().min(1),
  done: z.boolean(),
  row_version: z.number().int().nonnegative().max(2147483647),
});

const teacherTaskPageSchema = z.strictObject({
  items: z.array(teacherProjectTaskSchema).max(50),
  next_cursor: uuid.nullable(),
});

const teacherProjectConfirmationSchema = z.strictObject({
  id: uuid,
  requirements_revision: z.number().int().positive().max(2147483647),
  confirmed_at: timestampSchema,
  source: z.literal("student_explicit_confirmation"),
  requested_tier_acknowledgement: z.enum(["no_preference", "matches", "explicit_change"]),
});

const teacherProjectClassificationSchema = z.discriminatedUnion("state", [
  z.strictObject({
    state: z.literal("unconfirmed"),
    requested_tier: z.enum(["A", "B"]).nullable(),
    tier: z.null(),
    needs_visitor_identity: z.null(),
    confirmation: z.null(),
  }),
  z.strictObject({
    state: z.literal("legacy_unverified"),
    requested_tier: z.null(),
    tier: z.enum(["A", "B"]),
    needs_visitor_identity: z.boolean(),
    confirmation: z.null(),
  }),
  z.strictObject({
    state: z.literal("confirmed"),
    requested_tier: z.enum(["A", "B"]).nullable(),
    tier: z.enum(["A", "B"]),
    needs_visitor_identity: z.boolean(),
    confirmation: teacherProjectConfirmationSchema,
  }),
]);

export const teacherStageSummarySchema = z.strictObject({
  stage: projectStageSchema,
  saved: z.boolean(),
  row_version: z.number().int().nonnegative().max(2147483647).nullable(),
  student_confirmation: z.enum(["not_applicable", "not_confirmed", "current", "stale"]),
  confirmed_at: timestampSchema.nullable(),
});

export const teacherProjectDetailSchema = z.strictObject({
  outcome: z.literal("found"),
  project: z.strictObject({
    id: uuid,
    title: z.string().min(1),
    stage: projectStageSchema,
    row_version: z.number().int().nonnegative().max(2147483647),
    created_at: timestampSchema,
  }),
  classification: teacherProjectClassificationSchema,
  requirements: z.strictObject({
    revision: z.number().int().positive().max(2147483647),
    content: projectRequirementsSchema,
  }).nullable(),
  stages: z.array(teacherStageSummarySchema).length(9),
  specification_review: z.enum(["not_submitted", "pending", "approved", "returned", "invalidated"]),
  tasks: teacherTaskPageSchema,
});

export const teacherStageDraftSchema = z.strictObject({
  outcome: z.literal("found"),
  project_id: uuid,
  stage: projectStageSchema,
  saved: z.boolean(),
  row_version: z.number().int().nonnegative().max(2147483647).nullable(),
  content: stageDraftContentSchema.nullable(),
  student_confirmation: z.enum(["not_applicable", "not_confirmed", "current", "stale"]),
  confirmed_at: timestampSchema.nullable(),
});

export const teacherTaskPageResultSchema = z.strictObject({
  outcome: z.literal("found"),
  tasks: teacherTaskPageSchema,
});

export type TeacherStudentPage = z.infer<typeof teacherStudentPageSchema>;
export type TeacherProjectPage = z.infer<typeof teacherProjectPageSchema>;
export type TeacherProjectDetail = z.infer<typeof teacherProjectDetailSchema>;
export type TeacherStageDraft = z.infer<typeof teacherStageDraftSchema>;
export type TeacherTaskPageResult = z.infer<typeof teacherTaskPageResultSchema>;
