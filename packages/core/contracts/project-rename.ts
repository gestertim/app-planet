import { z } from "zod";

export const projectRenameBodySchema = z.strictObject({
  title: z.string(),
});

export const projectRenameCurrentSchema = z.strictObject({
  id: z.uuid(),
  title: z.string(),
  row_version: z.number().int().min(-2147483648).max(2147483647),
});

export const projectRenameResponseSchema = z.strictObject({
  outcome: z.enum(["saved", "replayed"]),
  operation: projectRenameCurrentSchema,
  current: projectRenameCurrentSchema,
});

export type ProjectRenameCurrent = z.infer<typeof projectRenameCurrentSchema>;
export type ProjectRenameResponse = z.infer<typeof projectRenameResponseSchema>;
