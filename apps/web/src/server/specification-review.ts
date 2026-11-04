import { z } from "zod";
import {
  specificationDecisionSchema, specificationDetailSchema, specificationListSchema,
  specificationQuerySchema, specificationReceiptSchema, specificationStatusSchema, specificationSubmitSchema,
} from "@app-planet/core";
import type { AuthorizationContext, AuthorizationQuery } from "./authorization.ts";
import type { ProjectCreationContext } from "./projects.ts";
import { actorSql, record, validActor } from "./stage-drafts.ts";

const failureSchema = z.object({
  outcome: z.enum(["denied", "not_found", "invalid_input", "idempotency_conflict", "version_conflict", "evidence_missing"]),
}).strict();
type Failure = z.infer<typeof failureSchema> | { outcome: "dependency_failure" };
type Context = { read: AuthorizationContext; write: ProjectCreationContext };

async function run<T>(
  context: Context, write: boolean, sql: string, values: string[], schema: z.ZodType<T>,
): Promise<T | Failure> {
  const execute = async (query: AuthorizationQuery) => {
    const { rows } = await query.query(`WITH actor AS MATERIALIZED (SELECT ${actorSql(!write)})
      SELECT actor.*, CASE WHEN actor.actor_valid AND actor.subject IS NOT NULL THEN ${sql}
      ELSE jsonb_build_object('outcome','invalid_context') END AS result FROM actor`, values);
    if (rows.length !== 1 || !record(rows[0]) || !validActor(rows[0])) throw new Error("invalid_review_actor");
    const parsed = z.union([schema, failureSchema]).safeParse(rows[0].result);
    if (!parsed.success) throw new Error("invalid_review_result");
    return parsed.data;
  };
  try {
    return write ? await context.write.runTransaction(execute) : await context.read.runReadOnly(execute);
  } catch {
    // 固定去敏失敗；寫入 caller 必須視為結果未知，不能推定未提交。
    return { outcome: "dependency_failure" };
  }
}
export function readSpecificationStatus(context: Context, projectId: string) {
  if (!z.uuid().safeParse(projectId).success) return Promise.resolve({ outcome: "not_found" } as const);
  return run(context, false, "app.read_specification_status($1::uuid)", [projectId], specificationStatusSchema);
}
export function listSpecificationReviews(context: Context, input: unknown) {
  const parsed = specificationQuerySchema.safeParse(input);
  if (!parsed.success) return Promise.resolve({ outcome: "invalid_input" } as const);
  return run(context, false, "app.list_specification_reviews($1::bigint,$2::integer)",
    [parsed.data.after, parsed.data.limit], specificationListSchema);
}
export function readSpecificationReview(context: Context, submissionId: string) {
  if (!z.uuid().safeParse(submissionId).success) return Promise.resolve({ outcome: "not_found" } as const);
  return run(context, true, "app.read_specification_review($1::uuid)", [submissionId], specificationDetailSchema);
}
export function submitSpecification(context: Context, projectId: string, input: unknown, key: string) {
  const parsed = specificationSubmitSchema.safeParse(input);
  if (!parsed.success || !z.uuid().safeParse(projectId).success || !z.uuid().safeParse(key).success) {
    return Promise.resolve({ outcome: "invalid_input" } as const);
  }
  return run(context, true, "app.submit_specification($1::uuid,$2::integer,$3::integer,$4::uuid,$5::uuid)",
    [projectId, String(parsed.data.expected_draft_version), String(parsed.data.expected_requirements_revision),
      parsed.data.expected_classification_id, key], specificationReceiptSchema);
}
export function decideSpecification(context: Context, submissionId: string, input: unknown, key: string) {
  const parsed = specificationDecisionSchema.safeParse(input);
  if (!parsed.success || !z.uuid().safeParse(submissionId).success || !z.uuid().safeParse(key).success) {
    return Promise.resolve({ outcome: "invalid_input" } as const);
  }
  return run(context, true, "app.decide_specification($1::uuid,$2::text,nullif($3::text,''),$4::uuid)",
    [submissionId, parsed.data.decision, parsed.data.reason ?? "", key], specificationReceiptSchema);
}
