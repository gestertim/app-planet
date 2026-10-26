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
