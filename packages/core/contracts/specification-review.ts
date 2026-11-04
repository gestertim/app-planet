import { z } from "zod";
import { projectRequirementsSchema } from "./project-classification.ts";
import { stageDraftContentSchema } from "./stage-drafts.ts";

const version = z.number().int().min(0).max(2147483647);
export const specificationSubmitSchema = z.object({
  expected_draft_version: version,
  expected_requirements_revision: version.min(1),
  expected_classification_id: z.uuid(),
}).strict();
// 工程輸入防護上限，不是正式配額；不接受控制字元或只有空白的退回理由。
export const specificationReasonSchema = stageDraftContentSchema.shape.text.max(2000).refine(
  (value) => value.trim().length > 0 && !/[\u0000-\u001f\u007f-\u009f]/u.test(value),
);
export const specificationDecisionSchema = z.discriminatedUnion("decision", [
  z.object({ decision: z.literal("approved"), reason: z.null() }).strict(),
  z.object({ decision: z.literal("returned"), reason: specificationReasonSchema }).strict(),
]);
export const specificationSubmissionSchema = z.object({
  id: z.uuid(), project_id: z.uuid(), title: z.string(), draft_version: version,
  requirements_revision: version.min(1), classification_id: z.uuid(),
  specification: stageDraftContentSchema, requirements: projectRequirementsSchema,
  classification: z.object({ tier: z.enum(["A", "B"]), needs_visitor_identity: z.boolean() }).strict(),
  submitted_at: z.iso.datetime(),
  state: z.enum(["pending", "approved", "returned", "invalidated"]),
  decision: z.object({
    decision: z.enum(["approved", "returned"]), reason: z.string().nullable(), decided_at: z.iso.datetime(),
  }).strict().nullable(),
}).strict();
export const specificationStatusSchema = z.object({
  outcome: z.literal("found"), project_id: z.uuid(),
  evidence: z.object({
    draft_version: version.nullable(), requirements_revision: version, classification_id: z.uuid().nullable(),
  }).strict(),
  latest: specificationSubmissionSchema.nullable(),
}).strict();
export const specificationDetailSchema = z.object({
  outcome: z.literal("found"), submission: specificationSubmissionSchema,
}).strict();
export const specificationListSchema = z.object({
  outcome: z.literal("found"),
  items: z.array(specificationSubmissionSchema.pick({
    id: true, project_id: true, title: true, draft_version: true, submitted_at: true,
  })).max(50),
  next_cursor: z.string().regex(/^[1-9]\d{0,18}$/).nullable(),
}).strict();
export const specificationQuerySchema = z.object({
  after: z.string().regex(/^(0|[1-9]\d{0,18})$/).refine((value) => BigInt(value) <= BigInt("9223372036854775807")).default("0"),
  limit: z.string().regex(/^(?:[1-9]|[1-4]\d|50)$/).default("20"),
}).strict();
export const specificationReceiptSchema = z.object({
  outcome: z.enum(["submitted", "decided", "replayed"]), submission_id: z.uuid(),
}).strict();
export type SpecificationSubmit = z.infer<typeof specificationSubmitSchema>;
export type SpecificationDecision = z.infer<typeof specificationDecisionSchema>;
export type SpecificationSubmission = z.infer<typeof specificationSubmissionSchema>;
export type SpecificationStatus = z.infer<typeof specificationStatusSchema>;
export type SpecificationList = z.infer<typeof specificationListSchema>;
