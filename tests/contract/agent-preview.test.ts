import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  agentRunDtoSchema, agentRunIdSchema, agentJobIdSchema, agentRunLookupSchema,
  agentRunOperationResultSchema, agentRunStateSchema, agentRunStopHttpStatus,
  createAgentRunRequestSchema, startAgentRunRequestSchema,
  type AgentRunId, type AgentJobId,
} from "@app-planet/core";

describe("T056 Agent Run 持久核心契約（不是 G-1～G-4 成功接線）", () => {
  it("Run／Job 有不同 DTO 欄位與 branded 型別，即使 UUID 同值也不是映射", () => {
    const id = randomUUID();
    const run: AgentRunId = agentRunIdSchema.parse(id);
    const job: AgentJobId = agentJobIdSchema.parse(id);
    // @ts-expect-error Run ID 不可作為 Job ID。
    const invalid: AgentJobId = run;
    expect(invalid).toBe(job);
    expect(agentRunLookupSchema.safeParse({ job_id: id }).success).toBe(false);
    expect(agentRunDtoSchema.safeParse({ id, kind: "agent", state: "queued" }).success).toBe(false);
    expect(agentRunDtoSchema.safeParse({
      run_id: id, project_id: randomUUID(), mode: "guided", state: "awaiting_approval", jobs: [],
    }).success).toBe(true);
  });
  it("只接受正式狀態，停止回執不編造產物／費用／HTTP 成功", () => {
    for (const state of ["awaiting_approval", "running", "stopping", "stopped", "completed", "failed"]) {
      expect(agentRunStateSchema.safeParse(state).success).toBe(true);
    }
    for (const state of ["queued", "cancelled", "succeeded", "paused_off_duty"]) {
      expect(agentRunStateSchema.safeParse(state).success).toBe(false);
    }
    const run = { run_id: randomUUID(), project_id: randomUUID(), mode: "auto", state: "stopping",
      jobs: [{ job_id: randomUUID(), state: "leased", cancel_requested: true }] };
    expect(agentRunOperationResultSchema.safeParse({ outcome: "stop_acknowledged", run }).success).toBe(true);
    expect(agentRunOperationResultSchema.safeParse({
      outcome: "stop_acknowledged", run, provider_stopped: true, usage_released: true,
    }).success).toBe(false);
    expect(agentRunDtoSchema.safeParse({ ...run, completed_parts: ["假產物"] }).success).toBe(false);
  });
  it("建立不能提交 owner／時間／批准；guided 與 auto 保留不同批准形狀", () => {
    const create = { project_id: randomUUID(), mode: "auto", instruction: "合成操作",
      idempotency_key: randomUUID() };
    expect(createAgentRunRequestSchema.safeParse(create).success).toBe(true);
    for (const field of ["owner_id", "role", "created_at", "approved_plan", "base_snapshot_id", "job_id"]) {
      expect(createAgentRunRequestSchema.safeParse({ ...create, [field]: randomUUID() }).success).toBe(false);
    }
    for (const approval of [{ step_seq: 1 }, { approved_task_ids: [randomUUID()] }]) {
      expect(startAgentRunRequestSchema.safeParse({
        run_id: randomUUID(), approval, idempotency_key: randomUUID(),
      }).success).toBe(true);
    }
    expect(startAgentRunRequestSchema.safeParse({
      run_id: randomUUID(), approval: { job_id: randomUUID() }, idempotency_key: randomUUID(),
    }).success).toBe(false);
  });
  it("unsupported／unavailable 不能冒充成功；正式 G-3 仍為 200", async () => {
    expect(agentRunStopHttpStatus).toBe(200);
    const source = await readFile(new URL(
      "../../specs/001-app-planet-platform/contracts/projects-agent-sandbox.md", import.meta.url), "utf8");
    expect(source).toMatch(/\| G-3 \|[^\n]*`200`/);
    const handler = await readFile(new URL(
      "../../apps/web/src/server/foundation-handlers.ts", import.meta.url), "utf8");
    const stop = handler.slice(handler.indexOf("const stopAgentRun ="));
    expect(stop).toContain('problemResponse("ai_not_open"');
    expect(stop).not.toContain("ledger.cancel");
    expect(agentRunOperationResultSchema.safeParse({
      outcome: "unavailable",
      missing: ["pre_agent_snapshot", "agent_approval_evidence", "agent_execution_authorization"],
    }).success).toBe(true);
    expect(agentRunOperationResultSchema.safeParse({ outcome: "completed", result: {} }).success).toBe(false);
  });
});
