import { capabilitySchema } from "@app-planet/core";

export interface AuthorizationQuery {
  query(text: string, values?: string[]): Promise<{ rows: unknown[] }>;
}

// 可信 server adapter 必須提供已綁定驗證主體的單一唯讀交易，完成／失敗後清除上下文。
// 本輪沒有真實 Auth provider；合成 claim 的建立與切換僅在 tests/integration。
export interface AuthorizationContext {
  runReadOnly<T>(operation: (query: AuthorizationQuery) => Promise<T>): Promise<T>;
}

export type AuthorizationResult =
  | { outcome: "allowed"; scope: "account_capability" | "teacher_relationship" }
  | { outcome: "denied"; reason: "policy_denied" }
  | { outcome: "failed"; reason: "invalid_input" | "invalid_context" | "dependency_failure" | "invalid_result" };

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const contextProjection = `
  SELECT auth.uid()::text AS subject,
    (current_user = 'authenticated'
      AND current_setting('transaction_read_only') = 'on'
      AND NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_roles
        WHERE rolname IN (current_user, session_user) AND (rolsuper OR rolbypassrls)
      )
      AND NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_class AS relation
        JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
        JOIN pg_catalog.pg_roles AS actor ON actor.oid = relation.relowner
        WHERE namespace.nspname = 'app' AND actor.rolname IN (current_user, session_user)
      )
    ) AS actor_valid,
`;

async function decide(
  context: AuthorizationContext,
  gate: "capability" | "relationship",
  parameter: string,
): Promise<AuthorizationResult> {
  try {
    return await context.runReadOnly(async (query): Promise<AuthorizationResult> => {
      const sql = gate === "capability"
        ? `${contextProjection} app.current_account_gate($1::text) AS allowed`
        : `${contextProjection} app.teacher_can_view_student($1::uuid) AS allowed`;
      const { rows } = await query.query(sql, [parameter]);
      if (rows.length !== 1 || typeof rows[0] !== "object" || rows[0] === null) {
        return { outcome: "failed", reason: "invalid_result" };
      }
      const row = rows[0];
      if (!("subject" in row) || typeof row.subject !== "string" || !uuid.test(row.subject) ||
          !("actor_valid" in row) || row.actor_valid !== true) {
        return { outcome: "failed", reason: "invalid_context" };
      }
      if (!("allowed" in row) || typeof row.allowed !== "boolean") {
        return { outcome: "failed", reason: "invalid_result" };
      }
      return row.allowed
        ? { outcome: "allowed", scope: gate === "capability" ? "account_capability" : "teacher_relationship" }
        : { outcome: "denied", reason: "policy_denied" };
    });
  } catch {
    // 明確依賴失敗；不透傳 SQLSTATE、SQL、driver error 或 stack，也不接日誌 sink。
    return { outcome: "failed", reason: "dependency_failure" };
  }
}

export async function authorizeCapability(
  context: AuthorizationContext,
  capability: unknown,
): Promise<AuthorizationResult> {
  const parsed = capabilitySchema.safeParse(capability);
  if (!parsed.success) {
    return { outcome: "failed", reason: "invalid_input" };
  }
  return decide(context, "capability", parsed.data);
}

export async function authorizeTeacherRelationship(
  context: AuthorizationContext,
  studentId: unknown,
): Promise<AuthorizationResult> {
  if (typeof studentId !== "string" || !uuid.test(studentId)) {
    return { outcome: "failed", reason: "invalid_input" };
  }
  return decide(context, "relationship", studentId);
}
