import { z } from "zod";
import { projectClassificationCurrentSchema, projectRequirementsSchema } from "./project-classification.ts";
import { projectStageSchema, stageDraftDtoSchema } from "./stage-drafts.ts";
import { projectTaskDtoSchema } from "./project-tasks.ts";
import { utcInstantSchema } from "./common.ts";

export const savedProjectExportNotice = "本檔只包含已保存資料；未保存文字不包含。不代表作品已完成或獲批准；不是 snapshot、Final Pack、部署包或可還原備份。本輪不支援匯入或恢復。";
export const projectExportFilename = "app-planet-saved-project.json";
export const projectExportMaxBytes = 8 * 1024 * 1024;
const version = z.number().int().nonnegative().max(2147483647);
const current = projectClassificationCurrentSchema.shape;
const classificationSchema = z.strictObject({
  classification_state: current.classification_state,
  requested_tier: current.requested_tier,
  tier: current.tier,
  needs_visitor_identity: current.needs_visitor_identity,
  confirmation: current.confirmation,
  confirmation_validity: z.enum(["not_confirmed", "valid", "stale", "legacy_unverified"]),
});
const exportStageSchema = z.strictObject({
  stage: projectStageSchema,
  draft: stageDraftDtoSchema.pick({
    row_version: true, state: true, content_source: true, content: true,
  }).nullable(),
  confirmation: z.strictObject({
    row_version: version,
    confirmed_at: utcInstantSchema,
    source: z.literal("student_explicit_confirmation"),
    current: z.boolean(),
  }).nullable(),
});

export const projectExportSchema = z.strictObject({
  format_version: z.literal("app-planet.saved-project.v1"),
  saved_data_notice: z.literal(savedProjectExportNotice),
  read_at: utcInstantSchema,
  project: z.strictObject({ id: z.uuid(), title: z.string(), stage: projectStageSchema, row_version: version }),
  requirements: z.strictObject({ revision: version.positive(), content: projectRequirementsSchema }).nullable(),
  classification: classificationSchema,
  stages: z.array(exportStageSchema).length(projectStageSchema.options.length),
  tasks: z.array(projectTaskDtoSchema),
}).superRefine((value, ctx) => {
  const fail = () => ctx.addIssue({ code: "custom", message: "Inconsistent saved project export" });
  const c = value.classification;
  if (c.classification_state === "confirmed") {
    if (!value.requirements || !c.confirmation || c.tier === null || c.needs_visitor_identity === null ||
        c.confirmation.requirements_revision !== value.requirements.revision ||
        !["valid", "stale"].includes(c.confirmation_validity)) fail();
    if (c.confirmation_validity === "valid" && value.requirements &&
        (value.requirements.content.runtime_ai_required ||
          value.requirements.content.runtime_needs !== (c.tier === "A" ? "static" : "work_data_api"))) fail();
  } else if (c.classification_state === "unconfirmed") {
    if (c.confirmation !== null || c.tier !== null || c.needs_visitor_identity !== null ||
        c.confirmation_validity !== "not_confirmed") fail();
  } else if (value.requirements !== null || c.confirmation !== null || c.requested_tier !== null ||
      c.tier === null || c.needs_visitor_identity === null || c.confirmation_validity !== "legacy_unverified") fail();
  value.stages.forEach((item, index) => {
    if (item.stage !== projectStageSchema.options[index]) fail();
    if (item.confirmation && (!item.draft ||
        item.confirmation.row_version > item.draft.row_version ||
        item.confirmation.current && item.confirmation.row_version !== item.draft.row_version)) fail();
  });
  const ids = new Set<string>();
  value.tasks.forEach((task, index) => {
    if (task.project_id !== value.project.id || ids.has(task.id)) fail();
    ids.add(task.id);
    const previous = value.tasks[index - 1];
    if (previous && (previous.order > task.order ||
        previous.order === task.order && previous.id >= task.id)) fail();
  });
});
export type ProjectExport = z.infer<typeof projectExportSchema>;
