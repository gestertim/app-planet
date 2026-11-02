import { z } from "zod";

const taskVersionSchema = z.number().int().min(0).max(2147483647);

export const projectTaskDoneBodySchema = z.strictObject({ done: z.boolean() });

export const projectTaskDtoSchema = z.strictObject({
  id: z.uuid(),
  project_id: z.uuid(),
  order: z.number().int().min(-2147483648).max(2147483647),
  title: z.string(),
  done: z.boolean(),
  row_version: taskVersionSchema,
});

export const readProjectTasksInputSchema = z.strictObject({ project_id: z.uuid() });

// 工程防護值（非產品配額；待教育者核定）：僅避免無界輸入。
export const projectTaskImportLimits = Object.freeze({ maxTasks: 50, maxTitleCodePoints: 200 });

const controlCharacter = /\p{Cc}/u;

export const projectTaskTitleSchema = z.string()
  .transform((value) => value.trim())
  .pipe(z.string()
    .refine((value) => value.length > 0, "title_required")
    .refine((value) => [...value].length <= projectTaskImportLimits.maxTitleCodePoints, "title_too_long")
    .refine((value) => !controlCharacter.test(value), "title_control_character"));

// 本人手動任務清單首次匯入：明確確認旗標＋有序標題；順序由陣列位置決定。
export const projectTaskImportBodySchema = z.strictObject({
  confirmed: z.literal(true),
  tasks: z.array(z.strictObject({ title: projectTaskTitleSchema }))
    .min(1).max(projectTaskImportLimits.maxTasks),
});

export const projectTaskImportResultSchema = z.strictObject({
  outcome: z.enum(["created", "replayed"]),
  tasks: z.array(projectTaskDtoSchema).min(1).max(projectTaskImportLimits.maxTasks),
});

export const projectTaskImportInputSchema = z.strictObject({
  project_id: z.uuid(),
  idempotency_key: z.uuid(),
  titles: z.array(projectTaskTitleSchema).min(1).max(projectTaskImportLimits.maxTasks),
});

export function parseManualTaskLines(text: string):
  | { ok: true; titles: string[] }
  | { ok: false; reason: "empty" | "too_many" | "title_too_long" | "control_character" } {
  const titles = text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0);
  if (titles.length === 0) return { ok: false, reason: "empty" };
  if (titles.length > projectTaskImportLimits.maxTasks) return { ok: false, reason: "too_many" };
  if (titles.some((title) => [...title].length > projectTaskImportLimits.maxTitleCodePoints)) {
    return { ok: false, reason: "title_too_long" };
  }
  if (titles.some((title) => controlCharacter.test(title))) return { ok: false, reason: "control_character" };
  return { ok: true, titles };
}

export const readProjectTaskInputSchema = readProjectTasksInputSchema.extend({
  task_id: z.uuid(),
});

export const patchProjectTaskDoneInputSchema = readProjectTaskInputSchema.extend({
  expected_row_version: taskVersionSchema,
  done: z.boolean(),
});

export const projectTaskConflictSchema = z.strictObject({
  current: z.strictObject({
    version: taskVersionSchema,
    content: projectTaskDoneBodySchema,
  }),
  submitted: z.strictObject({
    version: taskVersionSchema,
    content: projectTaskDoneBodySchema,
  }),
});

export type ProjectTaskDto = z.infer<typeof projectTaskDtoSchema>;
export type ProjectTaskImportInput = z.infer<typeof projectTaskImportInputSchema>;
export type PatchProjectTaskDoneInput = z.infer<typeof patchProjectTaskDoneInputSchema>;
