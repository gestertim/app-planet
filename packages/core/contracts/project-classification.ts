import { z } from "zod";

const projectUuidSchema = z.string().uuid();
const projectRowVersionSchema = z.number().int().min(-2147483648).max(2147483647);
const requirementsRevisionSchema = z.number().int().nonnegative().max(2147483647);

export const projectRequirementsSchema = z.object({
  description: z.string(),
  runtime_needs: z.enum(["static", "work_data_api", "restricted_server"]),
  runtime_ai_required: z.boolean(),
}).strict();

export const saveProjectRequirementsInputSchema = z.object({
  project_id: projectUuidSchema,
  expected_row_version: projectRowVersionSchema,
  expected_requirements_revision: requirementsRevisionSchema,
  requirements: projectRequirementsSchema,
}).strict();

export const confirmProjectClassificationInputSchema = z.object({
  project_id: projectUuidSchema,
  expected_row_version: projectRowVersionSchema,
  expected_requirements_revision: requirementsRevisionSchema,
  tier: z.enum(["A", "B"]),
  needs_visitor_identity: z.boolean(),
  requested_tier_acknowledgement: z.enum(["no_preference", "matches", "explicit_change"]),
}).strict();

export type ProjectRequirements = z.infer<typeof projectRequirementsSchema>;
export type SaveProjectRequirementsInput = z.infer<typeof saveProjectRequirementsInputSchema>;
export type ConfirmProjectClassificationInput =
  z.infer<typeof confirmProjectClassificationInputSchema>;

export const projectRequirementsBodySchema = z.object({
  expected_requirements_revision: requirementsRevisionSchema,
  requirements: projectRequirementsSchema,
}).strict();

export const projectClassificationBodySchema = confirmProjectClassificationInputSchema.omit({
  project_id: true,
  expected_row_version: true,
}).strict();

const publicConfirmationSchema = z.object({
  id: projectUuidSchema,
  requirements_revision: requirementsRevisionSchema.positive(),
  confirmed_at: z.string().datetime({ offset: true }),
  source: z.literal("student_explicit_confirmation"),
}).strict();

export const projectClassificationCurrentSchema = z.object({
  id: projectUuidSchema,
  row_version: projectRowVersionSchema,
  requirements_revision: requirementsRevisionSchema,
  requested_tier: z.enum(["A", "B"]).nullable(),
  classification_state: z.enum(["unconfirmed", "legacy_unverified", "confirmed"]),
  requirements: projectRequirementsSchema.nullable(),
  tier: z.enum(["A", "B"]).nullable(),
  needs_visitor_identity: z.boolean().nullable(),
  confirmation: publicConfirmationSchema.nullable(),
}).strict().superRefine((value, ctx) => {
  const consistent = value.classification_state === "confirmed"
    ? value.requirements !== null && value.requirements_revision > 0 &&
      value.confirmation?.requirements_revision === value.requirements_revision &&
      value.tier !== null && value.needs_visitor_identity !== null &&
      !value.requirements.runtime_ai_required &&
      value.requirements.runtime_needs === (value.tier === "A" ? "static" : "work_data_api")
    : value.classification_state === "unconfirmed"
      ? value.confirmation === null && value.tier === null && value.needs_visitor_identity === null &&
        (value.requirements_revision === 0 ? value.requirements === null : value.requirements !== null)
      : value.requirements_revision === 0 && value.requirements === null &&
        value.confirmation === null && value.requested_tier === null &&
        value.tier !== null && value.needs_visitor_identity !== null;
  if (!consistent) ctx.addIssue({ code: "custom", message: "Invalid current classification" });
});

export const projectClassificationReceiptSchema = z.discriminatedUnion("outcome", [
  z.object({
    outcome: z.literal("saved"),
    row_version: projectRowVersionSchema,
    requirements_revision: requirementsRevisionSchema.positive(),
    requirements: projectRequirementsSchema,
    changed: z.boolean(),
  }).strict(),
  z.object({
    outcome: z.literal("confirmed"),
    row_version: projectRowVersionSchema,
    requirements_revision: requirementsRevisionSchema.positive(),
    tier: z.enum(["A", "B"]),
    needs_visitor_identity: z.boolean(),
    confirmation: publicConfirmationSchema,
  }).strict(),
]);

export const projectClassificationResponseSchema = z.object({
  outcome: z.enum(["saved", "confirmed", "replayed"]),
  operation: projectClassificationReceiptSchema,
  current: projectClassificationCurrentSchema,
}).strict().superRefine((value, ctx) => {
  if (value.outcome !== "replayed" && value.outcome !== value.operation.outcome ||
      value.operation.outcome === "confirmed" &&
      value.operation.confirmation.requirements_revision !== value.operation.requirements_revision) {
    ctx.addIssue({ code: "custom", message: "Invalid operation receipt" });
  }
});

export type ProjectClassificationCurrent = z.infer<typeof projectClassificationCurrentSchema>;
export type ProjectClassificationResponse = z.infer<typeof projectClassificationResponseSchema>;
