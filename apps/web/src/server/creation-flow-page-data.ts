import { z } from "zod";
import { projectStageSchema } from "@app-planet/core";
import type { AuthorizationContext } from "./authorization.ts";
import {
  readOwnedProjectCreationFlowAssessmentSubset,
  type OwnedProjectCreationFlowAssessmentResult,
} from "./projects.ts";

const selectionSchema = z.object({ requested_stage: projectStageSchema.optional() }).strict();
export type CreationFlowPageResult =
  | { outcome: "invalid_selection" }
  | OwnedProjectCreationFlowAssessmentResult;

export async function readCreationFlowPageData(
  context: AuthorizationContext,
  projectId: string,
  currentStage: string,
  searchParams: Record<string, string | string[] | undefined>,
): Promise<CreationFlowPageResult> {
  const parsed = selectionSchema.safeParse(searchParams);
  if (!parsed.success) return { outcome: "invalid_selection" };
  const stage = projectStageSchema.safeParse(parsed.data.requested_stage ?? currentStage);
  if (!stage.success) return { outcome: "invalid_selection" };
  return readOwnedProjectCreationFlowAssessmentSubset(context, {
    project_id: projectId,
    requested_stage: stage.data,
  });
}
