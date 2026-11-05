import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createUsageLedger, jobSchema, type AgentRunOperationResult, type UsageJob } from "@app-planet/core";
import { createCheckpoints } from "../../apps/worker/src/jobs/checkpoint.ts";
import { createAgentRunOperations } from "../../apps/web/src/server/agent-runs.ts";
import { closeServerDatabasePool, createDatabaseSession } from "../../apps/web/src/server/database-session.ts";
import { sessionCookieName } from "../../apps/web/src/server/auth-principal.ts";
import { POST as httpStop } from "../../apps/web/src/app/api/v1/agent-runs/[id]/stop/route.ts";
import { createReviewActors, cleanupReviewActors } from "../support/specification-review-fixture.ts";
import {
  openControlPool, createOwnedSyntheticProject, createSyntheticAgentJob,
  loginSyntheticAccount, createSyntheticWorkerContext, closeSyntheticWorkerPool,
  type NativeAuthSession,
} from "../support/real-auth-fixture.ts";

// 真 Auth／隔離 DB。關聯 fixtures 由 control SQL 插入，只為驗證解析／取消；
// 沒有正式 Agent 計畫、快照、執行或 provider，不能作為產品資格證據。
let control: Pool;
let actors: Awaited<ReturnType<typeof createReviewActors>>;
let student: NativeAuthSession;
let other: NativeAuthSession;
let teacher: NativeAuthSession;
let admin: NativeAuthSession;
let policyId: string;
let baselineJob: string;
let baselineProject: string;
const ops = createAgentRunOperations();
const origin = process.env.APP_PLANET_APP_ORIGIN!;
const usage = { input_tokens: 10, cached_input_tokens: 0, output_tokens: 0, images: 0 };
const request = (actor = student) => new Request(`${origin}/internal-agent-core`, {
  headers: { cookie: `${sessionCookieName}=${actor.accessToken}` },
});
function runId(result: AgentRunOperationResult): string {
  if (result.outcome !== "created" && result.outcome !== "replayed") throw new Error("合成 Run 建立失敗");
  return result.operation.run_id;
}
async function project(account = actors.student) {
  return createOwnedSyntheticProject(account);
}
async function create(project_id: string, mode = "guided", key = randomUUID(), actor = student) {
  return ops.create(request(actor), { project_id, mode, instruction: "合成持久化意圖", idempotency_key: key });
}
async function fixtureJob(projectId: string, account = actors.student): Promise<UsageJob> {
  return createUsageLedger(createDatabaseSession(account.id).usage, {
    async authorize(_query, resource) { return resource === projectId; },
  }).reserve({ idempotencyKey: randomUUID(), policyId, estimateMicro: 30n, resourceId: projectId });
}
async function fixtureLink(run: string, job: UsageJob, projectId: string, owner = actors.student.id) {
  await control.query(
    "INSERT INTO app.agent_run_jobs(run_id,job_id,owner_id,project_id) VALUES($1,$2,$3,$4)",
    [run, job.id, owner, projectId],
  );
}
async function fixtureRunWithJob() {
  const p = await project();
  const run = runId(await create(p));
  const job = await fixtureJob(p);
  await fixtureLink(run, job, p);
  return { p, run, job };
}
async function jobRow(id: string) {
  return (await control.query(
    "SELECT state,cancel_requested,fence,effect_state,partial_refs FROM app.jobs WHERE id=$1", [id],
  )).rows[0];
}
async function usageState(job: UsageJob) {
  return (await control.query("SELECT state FROM app.usage_reservations WHERE id=$1", [job.reservation_id])).rows[0].state;
}
async function waitForLockBarrier(blocker: PoolClient) {
  const pid = (await blocker.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
  for (let attempt = 0; attempt < 200; attempt++) {
    const { rows } = await control.query(`SELECT pid FROM pg_stat_activity
      WHERE application_name='app-planet-web' AND $1::integer=ANY(pg_blocking_pids(pid))`, [pid]);
    if (rows.length > 0) return;
    await delay(10);
  }
  throw new Error("未觀察到 PostgreSQL 真鎖障壁");
}
async function lockedRevocation(
  projectId: string, operation: () => Promise<AgentRunOperationResult>,
  revoke: () => Promise<unknown>, restore: () => Promise<unknown>,
) {
  const blocker = await control.connect();
  let pending: Promise<AgentRunOperationResult> | undefined;
  try {
    await blocker.query("BEGIN");
    await blocker.query("SELECT id FROM app.projects WHERE id=$1 FOR UPDATE", [projectId]);
    pending = operation();
    await waitForLockBarrier(blocker);
    await revoke();
    await blocker.query("COMMIT");
    expect(await pending).toEqual({ outcome: "denied" });
  } finally {
    await blocker.query("ROLLBACK");
    blocker.release();
    if (pending) await pending;
    await restore();
  }
}

beforeAll(async () => {
  control = openControlPool();
  actors = await createReviewActors(control);
  [student, other, teacher, admin] = await Promise.all([
    actors.student, actors.otherStudent, actors.teacher, actors.admin,
  ].map(loginSyntheticAccount));
  baselineProject = await project();
  baselineJob = await createSyntheticAgentJob(control, actors.student);
  policyId = (await control.query("SELECT id FROM app.quota_policies WHERE model='synthetic-model'")).rows[0].id;
  if (process.env.APP_PLANET_TEST_MIGRATE_THROUGH === "0036") {
    const snapshot = async () => (await control.query(`SELECT
      (SELECT to_jsonb(j) FROM app.jobs j WHERE id=$1) AS job,
      (SELECT to_jsonb(r) FROM app.usage_reservations r WHERE id=(SELECT reservation_id FROM app.jobs WHERE id=$1)) AS usage,
      (SELECT to_jsonb(p) FROM app.projects p WHERE id=$2) AS project`, [baselineJob, baselineProject])).rows[0];
    const before = await snapshot();
    expect((await control.query("SELECT to_regclass('app.agent_runs') AS name")).rows[0].name).toBeNull();
    await control.query(await readFile(new URL("../../supabase/migrations/0037_agent_runs.sql", import.meta.url), "utf8"));
    expect(await snapshot()).toEqual(before);
    console.info("0036→0037：既存 project／Job／usage 完整列保留已驗證。");
  } else {
    expect((await control.query("SELECT to_regclass('app.agent_runs') AS name")).rows[0].name).toBe("app.agent_runs");
    console.info("新庫：0037 與所有現行 migrations 已套用。");
  }
  try {
    await createDatabaseSession(student.userId).write.runTransaction((q) => q.query(
      "SELECT app.create_agent_run($1::uuid,'guided','合成 SQL 權限控制',$2::uuid)",
      [baselineProject, randomUUID()],
    ));
  } catch (error) {
    const diagnostic = z.object({ code: z.string(), message: z.string() }).safeParse(error);
    if (diagnostic.success && /^permission denied for (table|function|schema) [a-z_]+$/.test(diagnostic.data.message)) {
      console.error("隔離 SQL 權限控制：", diagnostic.data.code, diagnostic.data.message);
    }
    throw new Error("隔離 Run SQL 權限控制失敗");
  }
});
afterAll(async () => {
  await closeServerDatabasePool();
  await closeSyntheticWorkerPool();
  if (actors) {
    const ids = [actors.student.id, actors.otherStudent.id];
    await control.query("DELETE FROM app.agent_run_create_receipts WHERE owner_id=ANY($1::uuid[])", [ids]);
    await control.query("DELETE FROM app.agent_run_jobs WHERE owner_id=ANY($1::uuid[])", [ids]);
    await control.query("DELETE FROM app.agent_runs WHERE owner_id=ANY($1::uuid[])", [ids]);
    await control.query(`DELETE FROM app.usage_audit WHERE reservation_id IN
      (SELECT id FROM app.usage_reservations WHERE subject_id=ANY($1::uuid[]))`, [ids]);
    await control.query("DELETE FROM app.jobs WHERE subject_id=ANY($1::uuid[])", [ids]);
    await control.query("DELETE FROM app.usage_reservations WHERE subject_id=ANY($1::uuid[])", [ids]);
    await control.query("DELETE FROM app.usage_totals WHERE subject_id=ANY($1::uuid[]) OR scope='pool'", [ids]);
    await control.query("DELETE FROM app.model_prices WHERE model='synthetic-model'");
    await control.query("DELETE FROM app.quota_policies WHERE id=$1", [policyId]);
    await control.query("DELETE FROM app.pool_limits WHERE pool='internal_ai'");
    await control.query("DELETE FROM app.budget_pools WHERE key='internal_ai'");
    await cleanupReviewActors(control, actors);
  }
  await control?.end();
});

describe("T064／T056 真 Auth＋隔離 PostgreSQL Run 持久化與停止子集", () => {
  it("保存 awaiting_approval／讀回，原鍵重試只回原 receipt；instruction 不落庫", async () => {
    const p = await project(), key = randomUUID();
    const created = await create(p, "auto", key);
    const run = runId(created);
    expect(created).toMatchObject({ outcome: "created", current: {
      run_id: run, project_id: p, mode: "auto", state: "awaiting_approval", jobs: [],
    } });
    expect(await ops.read(request(), { run_id: run })).toMatchObject({ outcome: "found", run: {
      run_id: run, state: "awaiting_approval", jobs: [],
    } });
    expect(await create(p, "auto", key)).toMatchObject({ outcome: "replayed", operation: created.outcome === "created" ? created.operation : {} });
    expect(await create(p, "guided", key)).toEqual({ outcome: "idempotency_conflict" });
    const row = (await control.query("SELECT * FROM app.agent_runs WHERE id=$1", [run])).rows[0];
    expect(row.approved_plan).toBeNull();
    expect(row.base_snapshot_id).toBeNull();
    expect(JSON.stringify(row)).not.toContain("合成持久化意圖");
    expect((await control.query("SELECT octet_length(request_digest) AS bytes FROM app.agent_run_create_receipts WHERE run_id=$1", [run])).rows[0].bytes).toBe(32);
  });
  it("同專案並行新鍵一勝，其餘 conflict；同鍵並行不重複", async () => {
    const p = await project();
    const results = await Promise.all(Array.from({ length: 6 }, () => create(p)));
    expect(results.filter((r) => r.outcome === "created")).toHaveLength(1);
    expect(results.filter((r) => r.outcome === "active_run_conflict")).toHaveLength(5);
    const p2 = await project(), key = randomUUID();
    const retries = await Promise.all(Array.from({ length: 6 }, () => create(p2, "guided", key)));
    expect(new Set(retries.map(runId)).size).toBe(1);
  });
  it("非本人與不存在同隱匿，teacher／admin 拒絕；不採 caller owner／Job", async () => {
    const p = await project(), run = runId(await create(p));
    expect(await ops.read(request(other), { run_id: run })).toEqual({ outcome: "not_found" });
    expect(await ops.stop(request(other), { run_id: run })).toEqual({ outcome: "not_found" });
    expect(await create(p, "guided", randomUUID(), other)).toEqual({ outcome: "not_found" });
    for (const actor of [teacher, admin]) {
      expect(await ops.read(request(actor), { run_id: run })).toEqual({ outcome: "denied" });
      expect(await ops.stop(request(actor), { run_id: run })).toEqual({ outcome: "denied" });
      expect(await create(p, "guided", randomUUID(), actor)).toEqual({ outcome: "denied" });
    }
    expect(await ops.stop(request(), { run_id: randomUUID() })).toEqual({ outcome: "not_found" });
    expect(await ops.create(request(), { project_id: p, mode: "auto", instruction: "合成",
      idempotency_key: randomUUID(), owner_id: actors.student.id })).toEqual({ outcome: "invalid_input" });
  });
  it("缺正式快照／批准／執行授權時 start unavailable，兩模式皆不建 Job 或轉 running", async () => {
    for (const mode of ["guided", "auto"]) {
      const p = await project(), run = runId(await create(p, mode));
      const before = (await control.query("SELECT count(*) FROM app.jobs")).rows[0].count;
      const approval = mode === "guided" ? { step_seq: 1 } : { approved_task_ids: [randomUUID()] };
      expect(await ops.start(request(), { run_id: run, approval, idempotency_key: randomUUID() }))
        .toEqual({ outcome: "unavailable", missing: [
          "pre_agent_snapshot", "agent_approval_evidence", "agent_execution_authorization",
        ] });
      expect((await control.query("SELECT count(*) FROM app.jobs")).rows[0].count).toBe(before);
      expect(await ops.read(request(), { run_id: run })).toMatchObject({ run: { state: "awaiting_approval", jobs: [] } });
      await expect(control.query("UPDATE app.agent_runs SET state='running' WHERE id=$1", [run])).rejects.toThrow();
      await expect(control.query("UPDATE app.agent_runs SET base_snapshot_id=$2,approved_plan='{}' WHERE id=$1", [run, randomUUID()])).rejects.toThrow();
      const wrong = mode === "guided" ? { approved_task_ids: [randomUUID()] } : { step_seq: 1 };
      expect(await ops.start(request(), { run_id: run, approval: wrong, idempotency_key: randomUUID() }))
        .toEqual({ outcome: "invalid_input" });
    }
  });
  it("最小 grants／FORCE RLS／固定 search_path，runtime 無通用 DML 或關聯 writer", async () => {
    for (const table of ["agent_runs", "agent_run_jobs", "agent_run_create_receipts"]) {
      const { rows } = await control.query(`SELECT relrowsecurity,relforcerowsecurity,
        has_table_privilege('authenticated',oid,'INSERT') AS ins,
        has_table_privilege('authenticated',oid,'SELECT') AS sel,
        has_table_privilege('service_role',oid,'INSERT') AS service_ins
        FROM pg_class WHERE oid=$1::regclass`, [`app.${table}`]);
      expect(rows[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true, ins: false, sel: false, service_ins: false });
    }
    expect((await control.query(`SELECT has_table_privilege('app_agent_run_executor','app.agent_run_jobs','INSERT') AS allowed`)).rows[0].allowed).toBe(false);
    const { rows } = await control.query(`SELECT proconfig FROM pg_proc
      WHERE pronamespace='app'::regnamespace AND proname IN ('create_agent_run','owned_agent_run','start_agent_run')`);
    expect(rows).toHaveLength(3);
    for (const row of rows) expect(row.proconfig).toEqual(["search_path=pg_catalog"]);
    await expect(createDatabaseSession(student.userId).write.runTransaction(
      (q) => q.query("SELECT * FROM app.agent_run_jobs"),
    )).rejects.toThrow();
    await expect(createDatabaseSession(student.userId).write.runTransaction(
      (q) => q.query("SET LOCAL ROLE app_agent_run_executor"),
    )).rejects.toThrow();
  });
  it("DB 強制 Run project／owner；拒絕跨帳號／專案／kind 與換綁", async () => {
    const p = await project(), run = runId(await create(p));
    await expect(control.query("INSERT INTO app.agent_runs(project_id,owner_id,mode) VALUES($1,$2,'auto')",
      [p, actors.otherStudent.id])).rejects.toThrow();
    const wrongProject = await project();
    const foreignProject = await project(actors.otherStudent);
    const crossProjectJob = await fixtureJob(wrongProject);
    const foreignJob = await fixtureJob(foreignProject, actors.otherStudent);
    await expect(fixtureLink(run, crossProjectJob, p)).rejects.toThrow("invalid_run_job");
    await expect(fixtureLink(run, foreignJob, p)).rejects.toThrow("invalid_run_job");
    const wrongKind = await fixtureJob(p);
    await control.query("UPDATE app.jobs SET kind='preview' WHERE id=$1", [wrongKind.id]);
    await expect(fixtureLink(run, wrongKind, p)).rejects.toThrow("invalid_run_job");
    const good = await fixtureJob(p);
    await fixtureLink(run, good, p);
    await expect(control.query("UPDATE app.agent_run_jobs SET job_id=$2 WHERE run_id=$1", [run, wrongKind.id]))
      .rejects.toThrow("immutable_run_job");
    await expect(control.query("UPDATE app.jobs SET resource_id=$2 WHERE id=$1", [good.id, wrongProject])).rejects.toThrow();
    await expect(control.query("UPDATE app.projects SET owner_id=$2 WHERE id=$1", [p, actors.otherStudent.id])).rejects.toThrow();
  });
  it("拒絕關聯時整筆 reserve 回滾，不留孤兒 Job／usage／audit／totals", async () => {
    const p = await project(), run = runId(await create(p));
    const snapshot = async () => (await control.query(`SELECT
      (SELECT count(*) FROM app.jobs) AS jobs,
      (SELECT count(*) FROM app.usage_reservations) AS reservations,
      (SELECT count(*) FROM app.usage_audit) AS audit,
      (SELECT jsonb_agg(to_jsonb(t) ORDER BY scope,subject_id,period_key) FROM app.usage_totals t) AS totals`)).rows[0];
    const before = await snapshot();
    const session = createDatabaseSession(student.userId);
    const reserveAndReject = () => session.usage.runTransaction(async (q) => {
        const { rows } = await q.query("SELECT * FROM app.usage_reserve($1::uuid,$2::uuid,30,$3::uuid)",
          [randomUUID(), policyId, p]);
        const job = z.array(jobSchema).length(1).parse(rows)[0];
        await q.query("INSERT INTO app.agent_run_jobs(run_id,job_id,owner_id,project_id) VALUES($1,$2,$3,$4)",
          [run, job.id, student.userId, p]);
        return job;
    });
    await expect(reserveAndReject()).rejects.toMatchObject({ code: "42501" });
    expect(await snapshot()).toEqual(before);
    expect(await ops.read(request(), { run_id: run })).toMatchObject({ run: { jobs: [] } });
    // control 複製已存在的合成資料，驗證真正 FK／trigger 失敗的整筆回滾；不是產品 reserve。
    const fixture = await control.connect();
    const reservation = randomUUID(), job = randomUUID();
    try {
      await fixture.query("BEGIN");
      await fixture.query(`INSERT INTO app.usage_reservations SELECT
        (jsonb_populate_record(NULL::app.usage_reservations, to_jsonb(r) ||
          jsonb_build_object('id',$2::uuid,'idempotency_key',$3::uuid))).*
        FROM app.usage_reservations r WHERE id=(SELECT reservation_id FROM app.jobs WHERE id=$1)`,
      [baselineJob, reservation, randomUUID()]);
      await fixture.query(`INSERT INTO app.jobs SELECT
        (jsonb_populate_record(NULL::app.jobs,to_jsonb(j) || jsonb_build_object(
          'id',$2::uuid,'reservation_id',$3::uuid,'idempotency_key',$4::uuid))).*
        FROM app.jobs j WHERE id=$1`, [baselineJob, job, reservation, randomUUID()]);
      await expect(fixture.query(
        "INSERT INTO app.agent_run_jobs(run_id,job_id,owner_id,project_id) VALUES($1,$2,$3,$4)",
        [run, job, student.userId, p],
      )).rejects.toThrow("invalid_run_job");
    } finally {
      await fixture.query("ROLLBACK");
      fixture.release();
    }
    expect(await snapshot()).toEqual(before);
    expect((await control.query("SELECT id FROM app.jobs WHERE id=$1", [job])).rows).toEqual([]);
  });
  it("真正 Run 只取消持久關聯的多筆 Job；Job ID 冒充 Run 不影響任何工作", async () => {
    const { p, run, job } = await fixtureRunWithJob();
    const second = await fixtureJob(p);
    await fixtureLink(run, second, p);
    const unrelated = await fixtureJob(p);
    const otherRun = await fixtureRunWithJob();
    expect(await ops.stop(request(), { run_id: unrelated.id })).toEqual({ outcome: "not_found" });
    expect((await jobRow(unrelated.id)).cancel_requested).toBe(false);
    expect(await ops.stop(request(), { run_id: run })).toMatchObject({ outcome: "stop_acknowledged", run: {
      state: "stopping", jobs: [{ cancel_requested: true }, { cancel_requested: true }],
    } });
    for (const id of [job.id, second.id]) {
      expect(await jobRow(id)).toMatchObject({ state: "queued", cancel_requested: true, fence: "0" });
    }
    expect((await jobRow(unrelated.id)).cancel_requested).toBe(false);
    expect((await jobRow(otherRun.job.id)).cancel_requested).toBe(false);
    expect(await usageState(job)).toBe("reserved");
  });
  it("同值 UUID 不隱含映射；明確關聯才有作用，跨 Run 不可重用 Job", async () => {
    const p = await project(), run = runId(await create(p));
    const sameValue = await fixtureJob(p);
    await control.query("UPDATE app.jobs SET id=$2 WHERE id=$1", [sameValue.id, run]);
    expect(await ops.stop(request(), { run_id: run })).toMatchObject({ run: { state: "stopped", jobs: [] } });
    expect((await jobRow(run)).cancel_requested).toBe(false);
    const p2 = await project(), job = await fixtureJob(p2);
    await control.query("INSERT INTO app.agent_runs(id,project_id,owner_id,mode) VALUES($1,$2,$3,'guided')",
      [job.id, p2, student.userId]);
    await fixtureLink(job.id, job, p2);
    expect(await ops.stop(request(), { run_id: job.id })).toMatchObject({ run: { state: "stopping" } });
    expect((await jobRow(job.id)).cancel_requested).toBe(true);
    const p3 = await project(), run3 = runId(await create(p3));
    await expect(fixtureLink(run3, job, p3)).rejects.toThrow();
  });
  it("無工作停止與原 receipt 重播分離；重複停止不倒退，終態可建立新 Run", async () => {
    const p = await project(), key = randomUUID(), run = runId(await create(p, "guided", key));
    const stopped = await ops.stop(request(), { run_id: run });
    expect(stopped).toMatchObject({ outcome: "stop_acknowledged", run: { state: "stopped", jobs: [] } });
    expect(await ops.stop(request(), { run_id: run })).toEqual(stopped);
    expect(await create(p, "guided", key)).toMatchObject({
      outcome: "replayed", operation: { state: "awaiting_approval" }, current: { state: "stopped" },
    });
    await expect(control.query("UPDATE app.agent_runs SET state='awaiting_approval' WHERE id=$1", [run]))
      .rejects.toThrow("invalid_run_transition");
    expect(await create(p)).toMatchObject({ outcome: "created" });
    expect(await ops.start(request(), { run_id: run, approval: { step_seq: 1 }, idempotency_key: randomUUID() }))
      .toEqual({ outcome: "state_conflict" });
    const failedProject = await project(), failed = runId(await create(failedProject));
    await control.query("UPDATE app.agent_runs SET state='failed' WHERE id=$1", [failed]);
    expect(await ops.stop(request(), { run_id: failed })).toMatchObject({ run: { state: "failed" } });
    await expect(control.query("UPDATE app.agent_runs SET state='stopping' WHERE id=$1", [failed]))
      .rejects.toThrow("invalid_run_transition");
  });
  it("真 DB 鎖障壁：建立與停止等待期間失權，鎖後拒絕且不改 Job", async () => {
    const p = await project();
    await lockedRevocation(p, () => create(p),
      () => control.query("UPDATE app.profiles SET status='disabled' WHERE id=$1", [student.userId]),
      () => control.query("UPDATE app.profiles SET status='approved' WHERE id=$1", [student.userId]));
    expect((await control.query("SELECT count(*) FROM app.agent_runs WHERE project_id=$1", [p])).rows[0].count).toBe("0");
    const fixture = await fixtureRunWithJob();
    await lockedRevocation(fixture.p, () => ops.stop(request(), { run_id: fixture.run }),
      () => control.query("UPDATE app.profiles SET role='teacher' WHERE id=$1", [student.userId]),
      () => control.query("UPDATE app.profiles SET role='student' WHERE id=$1", [student.userId]));
    expect((await jobRow(fixture.job.id)).cancel_requested).toBe(false);
    await lockedRevocation(fixture.p, () => ops.stop(request(), { run_id: fixture.run }),
      () => control.query("UPDATE app.schools SET approval_state='unconfirmed' WHERE id=$1", [actors.student.schoolId]),
      () => control.query("UPDATE app.schools SET approval_state='approved' WHERE id=$1", [actors.student.schoolId]));
    expect((await jobRow(fixture.job.id)).cancel_requested).toBe(false);
  });
  it("真鎖 barrier：完成先提交後 stop 不倒退 Job，不虛構 Run 完成或產物", async () => {
    const fixture = await fixtureRunWithJob();
    const blocker = await control.connect();
    let pending: Promise<AgentRunOperationResult> | undefined;
    try {
      await blocker.query("BEGIN");
      await blocker.query("SELECT id FROM app.jobs WHERE id=$1 FOR UPDATE", [fixture.job.id]);
      pending = ops.stop(request(), { run_id: fixture.run });
      await waitForLockBarrier(blocker);
      // 隔離 control 的完成 fixture；不是正式 provider 結果。
      await blocker.query("UPDATE app.jobs SET state='done' WHERE id=$1", [fixture.job.id]);
      await blocker.query("COMMIT");
      const result = await pending;
      expect(result).toMatchObject({ outcome: "stop_acknowledged", run: {
        state: "stopped", jobs: [{ state: "done", cancel_requested: false }],
      } });
      expect(await ops.stop(request(), { run_id: fixture.run })).toEqual(result);
      expect(await jobRow(fixture.job.id)).toMatchObject({ state: "done", cancel_requested: false });
      expect(JSON.stringify(result)).not.toMatch(/completed_parts|recovery|snapshot/);
    } finally {
      await blocker.query("ROLLBACK");
      blocker.release();
      if (pending) await pending;
    }
  });
  it("T010 真 Worker：停止先提交，checkpoint 終結；unknown／fencing 不被改寫", async () => {
    for (const inFlight of [false, true]) {
      const fixture = await fixtureRunWithJob();
      await control.query("UPDATE app.jobs SET run_after=now()+interval '1 day' WHERE state='queued'");
      await control.query("UPDATE app.jobs SET run_after=now() WHERE id=$1", [fixture.job.id]);
      const worker = createCheckpoints(createSyntheticWorkerContext(student.userId),
        { async authorize() { return true; } }, randomUUID(), 60_000);
      const claimed = await worker.claim();
      expect(claimed?.id).toBe(fixture.job.id);
      if (!claimed) throw new Error("合成 Worker 領取失敗");
      const active = inFlight ? await worker.save(claimed, "begin") : claimed;
      expect(await ops.stop(request(), { run_id: fixture.run })).toMatchObject({ run: {
        state: "stopping", jobs: [{ state: "leased", cancel_requested: true }],
      } });
      expect(await usageState(active)).toBe("reserved");
      const finished = await worker.save(active, inFlight ? "complete" : "done",
        inFlight ? randomUUID() : undefined, inFlight ? usage : undefined);
      expect(finished.state).toBe(inFlight ? "failed" : "cancelled");
      expect(await usageState(finished)).toBe(inFlight ? "unknown" : "released");
      const before = await jobRow(finished.id);
      expect(await ops.stop(request(), { run_id: fixture.run })).toMatchObject({ run: { state: "stopped" } });
      expect(await jobRow(finished.id)).toEqual(before);
      await expect(worker.save(active, "heartbeat")).rejects.toMatchObject({ code: "stale_lease" });
      if (inFlight) expect(await usageState(finished)).toBe("unknown");
    }
  });
  it("G-3 HTTP 仍關閉，不將 403 當作正式 200 驗收", async () => {
    const fixture = await fixtureRunWithJob();
    const response = await httpStop(new Request(`${origin}/api/v1/agent-runs/${fixture.run}/stop`, {
      method: "POST", headers: {
        cookie: `${sessionCookieName}=${student.accessToken}`, origin, "content-type": "application/json",
      }, body: "{}",
    }), { params: Promise.resolve({ id: fixture.run }) });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: "ai_not_open" });
    expect((await jobRow(fixture.job.id)).cancel_requested).toBe(false);
  });
});
