import { z } from "zod";
import {
  projectExportSchema, savedProjectExportNotice, type ProjectExport,
} from "@app-planet/core";
import type { ProjectCreationContext } from "./projects.ts";

const dbResultSchema = z.discriminatedUnion("outcome", [
  z.strictObject({ outcome: z.literal("found"), data: z.record(z.string(), z.unknown()) }),
  z.strictObject({ outcome: z.enum(["denied", "not_found", "too_large", "invalid_input", "invalid_result"]) }),
]);
export type SavedProjectExportResult =
  | { outcome: "found"; data: ProjectExport }
  | { outcome: "denied" | "not_found" | "too_large" }
  | { outcome: "failed"; reason: "invalid_input" | "invalid_result" | "dependency_failure" };

export async function readSavedProjectExport(
  context: ProjectCreationContext, projectId: unknown,
): Promise<SavedProjectExportResult> {
  const id = z.uuid().safeParse(projectId);
  if (!id.success) return { outcome: "failed", reason: "invalid_input" };
  try {
    return await context.runTransaction(async (query): Promise<SavedProjectExportResult> => {
      const { rows } = await query.query("SELECT app.read_saved_project_export($1::uuid) AS result", [id.data]);
      if (rows.length !== 1) return { outcome: "failed", reason: "invalid_result" };
      const row = z.strictObject({ result: dbResultSchema }).safeParse(rows[0]);
      if (!row.success) return { outcome: "failed", reason: "invalid_result" };
      const result = row.data.result;
      if (result.outcome === "found") {
        const data = projectExportSchema.safeParse({
          ...result.data, format_version: "app-planet.saved-project.v1", saved_data_notice: savedProjectExportNotice,
        });
        return data.success && data.data.project.id === id.data.toLowerCase()
          ? { outcome: "found", data: data.data } : { outcome: "failed", reason: "invalid_result" };
      }
      if (result.outcome === "invalid_input" || result.outcome === "invalid_result") {
        return { outcome: "failed", reason: result.outcome };
      }
      return { outcome: result.outcome };
    });
  } catch {
    return { outcome: "failed", reason: "dependency_failure" };
  }
}
