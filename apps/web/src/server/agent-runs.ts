import { z } from "zod";
import {
  agentRunLookupSchema,
  agentRunOperationResultSchema,
  createAgentRunRequestSchema,
  startAgentRunRequestSchema,
  type AgentRunOperationResult,
} from "@app-planet/core";
import { createAuthPrincipalResolver } from "./auth-principal.ts";
import type { TrustedPrincipalResolver } from "./http.ts";

export class AgentRunFailure extends Error {
  constructor(readonly code: "unauthenticated" | "invalid_context" | "invalid_result" | "dependency_failure") {
    super(code);
    this.name = "AgentRunFailure";
  }
}

// 傳輸無關操作；每次重新向可信 Auth 解析，不接受 caller 的 owner／角色／Job ID。
export function createAgentRunOperations(resolver: TrustedPrincipalResolver = createAuthPrincipalResolver()) {
  async function execute(request: Request, sql: string, values: unknown[]): Promise<AgentRunOperationResult> {
    try {
      const principal = await resolver.resolve(request);
      if (!principal.ok) {
        if (principal.reason === "unauthenticated") throw new AgentRunFailure("unauthenticated");
        if (principal.reason === "account_disabled") return { outcome: "denied" };
        throw new AgentRunFailure("dependency_failure");
      }
      return await principal.session.write.runTransaction(async (query) => {
        const { rows: context } = await query.query(
          "SELECT current_user='authenticated' AND auth.uid() IS NOT NULL AS valid",
        );
        if (!z.array(z.strictObject({ valid: z.literal(true) })).length(1).safeParse(context).success) {
          throw new AgentRunFailure("invalid_context");
        }
        const { rows } = await query.query(sql, values);
        const parsed = z.array(z.strictObject({ result: agentRunOperationResultSchema })).length(1).safeParse(rows);
        if (!parsed.success) throw new AgentRunFailure("invalid_result");
        return parsed.data[0].result;
      });
    } catch (error) {
      if (error instanceof AgentRunFailure) throw error;
      throw new AgentRunFailure("dependency_failure");
    }
  }
  return {
    async create(request: Request, input: unknown): Promise<AgentRunOperationResult> {
      const parsed = createAgentRunRequestSchema.safeParse(input);
      if (!parsed.success) return { outcome: "invalid_input" };
      const value = parsed.data;
      return execute(request, "SELECT app.create_agent_run($1::uuid,$2::text,$3::text,$4::uuid) AS result",
        [value.project_id, value.mode, value.instruction, value.idempotency_key]);
    },
    async read(request: Request, input: unknown): Promise<AgentRunOperationResult> {
      const parsed = agentRunLookupSchema.safeParse(input);
      if (!parsed.success) return { outcome: "invalid_input" };
      return execute(request, "SELECT app.owned_agent_run($1::uuid,false) AS result", [parsed.data.run_id]);
    },
    async stop(request: Request, input: unknown): Promise<AgentRunOperationResult> {
      const parsed = agentRunLookupSchema.safeParse(input);
      if (!parsed.success) return { outcome: "invalid_input" };
      return execute(request, "SELECT app.owned_agent_run($1::uuid,true) AS result", [parsed.data.run_id]);
    },
    async start(request: Request, input: unknown): Promise<AgentRunOperationResult> {
      const parsed = startAgentRunRequestSchema.safeParse(input);
      if (!parsed.success) return { outcome: "invalid_input" };
      const value = parsed.data;
      return execute(request, "SELECT app.start_agent_run($1::uuid,$2::jsonb,$3::uuid) AS result",
        [value.run_id, JSON.stringify(value.approval), value.idempotency_key]);
    },
  };
}
