import { z } from "zod";

export const projectStageSchema = z.enum([
  "點子", "A/B", "Specification", "Checkpoint", "Constitution",
  "UX/UI", "Specification Sync", "Technical Plan", "Final Pack",
]);
const draftVersionSchema = z.number().int().min(0).max(2147483647);
const savedTextSchema = z.string().refine((text) => {
  if (text.includes("\0")) return false;
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = text.charCodeAt(++i);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return false;
    }
  }
  return true;
}, "文字必須可精確保存至 PostgreSQL");

export const stageDraftContentSchema = z.object({ text: savedTextSchema }).strict();
export const readStageDraftInputSchema = z.object({
  project_id: z.string().uuid(),
  stage: projectStageSchema,
}).strict();
export const saveStageDraftInputSchema = readStageDraftInputSchema.extend({
  expected_row_version: draftVersionSchema.nullable(),
  content: stageDraftContentSchema,
}).strict();
export const stageDraftDtoSchema = readStageDraftInputSchema.extend({
  row_version: draftVersionSchema,
  state: z.literal("ai_draft"),
  content_source: z.literal("student_input"),
  content: stageDraftContentSchema,
  approved_by: z.null(),
  approved_at: z.null(),
}).strict();
export const stageDraftIdempotencyKeySchema = z.string().uuid();
export type StageDraftDto = z.infer<typeof stageDraftDtoSchema>;
export type SaveStageDraftInput = z.infer<typeof saveStageDraftInputSchema>;
