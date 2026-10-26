import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createUsageLedger, taipeiPeriodKeys, type UsageContext, type UsageJob,
} from "../../packages/core/usage/ledger.ts";
import { createCheckpoints } from "../../apps/worker/src/jobs/checkpoint.ts";
import { runOne } from "../../apps/worker/src/jobs/runner.ts";
import { localPools } from "./authorization-context.ts";

// 全部金額、政策、角色與 provider 都是合成 fixtures，沒有正式政策核定效力。
const local = localPools();
const control = local.control;
const actors = new Pool({
  host: "127.0.0.1", port: Number(process.env.APP_PLANET_PGTAP_PORT),
  database: "postgres", user: "app_usage_test",
  password: process.env.APP_PLANET_AUTHORIZATION_PASSWORD,
  max: 12, connectionTimeoutMillis: 5000, query_timeout: 8000,
});
const account = randomUUID();
const other = randomUUID();
const school = randomUUID();
const policy = randomUUID();
const usage = { input_tokens: 10, cached_input_tokens: 0, output_tokens: 0, images: 0 };
function context(role: "app_usage_executor" | "app_job_executor", subject = account): UsageContext {
  return {
    async runTransaction(operation) {
      const client = await actors.connect();
      let reusable = false;
      try {
        await client.query("BEGIN");
        await client.query(`SET LOCAL ROLE ${role}`);
        await client.query("SELECT set_config('request.jwt.claim.sub',$1,true)", [subject]);
        const result = await operation(client);
        await client.query("COMMIT");
        reusable = true;
        return result;
      } catch (error) {
        // 隔離合成測試的 SQL 診斷；沒有 provider／密鑰或真實內容。
        if (error instanceof Error) console.error("synthetic SQL failure:", error.message);
        throw error;
      } finally {
        client.release(!reusable);
      }
    },
  };
}
const ledger = (subject = account, allow = true) =>
  createUsageLedger(context("app_usage_executor", subject), { async authorize() { return allow; } });
const reserve = (key = randomUUID(), amount = 30n, subject = account) =>
  ledger(subject).reserve({ idempotencyKey: key, policyId: policy, estimateMicro: amount, resourceId: null });
const worker = (allow = true, lease = 2000) => createCheckpoints(
  context("app_job_executor"), { async authorize() { return allow; } }, randomUUID(), lease,
);
async function claimed(w = worker()) {
  const job = await w.claim();
  if (!job) throw new Error("預期合成工作可領取");
  return { w, job };
}
async function row(job: UsageJob) {
  return (await control.query("SELECT * FROM app.usage_reservations WHERE id=$1", [job.reservation_id])).rows[0];
}
async function totals() {
  return (await control.query("SELECT scope,reserved_micro,settled_micro FROM app.usage_totals ORDER BY scope")).rows;
}
async function complete(w: ReturnType<typeof worker>, job: UsageJob) {
  const active = await w.save(job, "begin");
  return w.save(active, "complete", randomUUID(), usage);
}

beforeAll(async () => {
  await control.query(`INSERT INTO app.schools(id,label,approval_state,approval_epoch,created_at,updated_at)
    VALUES ($1,'synthetic-usage-school','approved',1,now(),now())`, [school]);
  for (const id of [account, other]) {
    await control.query("INSERT INTO auth.users(id) VALUES ($1)", [id]);
    await control.query(`INSERT INTO app.profiles(id,role,status,deletion_state,school_id,status_changed_at)
      VALUES ($1,'student','approved','none',$2,now())`, [id, school]);
  }
});
beforeEach(async () => {
  await control.query(`TRUNCATE app.usage_audit,app.jobs,app.usage_reservations,app.usage_totals,
    app.model_prices,app.quota_policies,app.pool_limits,app.budget_pools`);
  await control.query("UPDATE app.profiles SET role='student',status='approved',deletion_state='none' WHERE id=ANY($1::uuid[])", [[account, other]]);
  await control.query("UPDATE app.schools SET approval_state='approved',approval_epoch=1,valid_until=NULL WHERE id=$1", [school]);
  await control.query("INSERT INTO app.budget_pools VALUES ('internal_ai','synthetic-creator')");
  await control.query(`INSERT INTO app.pool_limits VALUES
    ('internal_ai',date_trunc('month',now() AT TIME ZONE 'Asia/Taipei')::date,10000,$1)`, [randomUUID()]);
  await control.query(`INSERT INTO app.quota_policies VALUES
    ($1,'synthetic',$2,'student','learner_feature','synthetic-model','synthetic_step',
    'daily',10000,1000,100,3,true)`, [policy, randomUUID()]);
  await control.query(`INSERT INTO app.model_prices VALUES
    ('synthetic-model','2020-01-01Z',1000000,500000,2000000,7,
    'https://example.invalid/synthetic-price','2026-10-26')`);
});
afterAll(async () => {
  await Promise.all([actors.end(), control.end(), local.authorization.end(), local.parallelAuthorization.end()]);
});

describe("T009 真實 PostgreSQL 費用／Job 交易", () => {
  it("並行預留不超個人日上限，失敗者不留下 Job／費用", async () => {
    await control.query("UPDATE app.quota_policies SET limit_micro=100");
    const results = await Promise.allSettled(Array.from({ length: 12 }, () => reserve()));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(3);
    expect(await totals()).toEqual([
      { scope: "account", reserved_micro: "90", settled_micro: "0" },
      { scope: "pool", reserved_micro: "90", settled_micro: "0" },
    ]);
    expect((await control.query("SELECT count(*) FROM app.jobs")).rows[0].count).toBe("3");
  });
  it("跨帳號並行不超共享月池，不以個人檢查取代池鎖", async () => {
    await control.query("UPDATE app.pool_limits SET limit_micro=100");
    const results = await Promise.allSettled(Array.from({ length: 12 }, (_, i) => reserve(randomUUID(), 30n, i % 2 ? other : account)));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(3);
    expect((await totals()).find((r) => r.scope === "pool")?.reserved_micro).toBe("90");
  });
  it("同鍵並行重送只建一筆預留、一筆 Job、一筆 audit", async () => {
    const key = randomUUID();
    const jobs = await Promise.all(Array.from({ length: 8 }, () => reserve(key)));
    expect(new Set(jobs.map((j) => j.id)).size).toBe(1);
    const mutable = { idempotencyKey:key,policyId:policy,estimateMicro:30n,resourceId:null as string | null };
    const snapshotLedger = createUsageLedger(context("app_usage_executor"), {
      async authorize(_query, resource) {
        expect(resource).toBeNull();
        mutable.estimateMicro = 1000n;
        mutable.resourceId = randomUUID();
        await Promise.resolve();
        return true;
      },
    });
    expect((await snapshotLedger.reserve(mutable)).id).toBe(jobs[0].id);
    expect((await control.query("SELECT count(*) FROM app.usage_audit")).rows[0].count).toBe("1");
    await expect(reserve(key, 31n)).rejects.toMatchObject({ code: "idempotency_key_reuse" });
    await expect(reserve(key, 30n, other)).rejects.toMatchObject({ code: "idempotency_key_reuse" });
  });
  it("Job 插入失敗整筆回滾，包含個人／池累計與稽核", async () => {
    await control.query(`CREATE FUNCTION app.synthetic_fail_job() RETURNS trigger LANGUAGE plpgsql AS
      $$ BEGIN RAISE EXCEPTION 'synthetic failure'; END $$;
      CREATE TRIGGER synthetic_fail_job BEFORE INSERT ON app.jobs
      FOR EACH ROW EXECUTE FUNCTION app.synthetic_fail_job()`);
    try {
      await expect(reserve()).rejects.toMatchObject({ code: "dependency_failure" });
      expect(await totals()).toEqual([]);
      expect((await control.query("SELECT count(*) FROM app.usage_reservations")).rows[0].count).toBe("0");
      expect((await control.query("SELECT count(*) FROM app.usage_audit")).rows[0].count).toBe("0");
    } finally {
      await control.query("DROP TRIGGER synthetic_fail_job ON app.jobs; DROP FUNCTION app.synthetic_fail_job()");
    }
  });
  it("結算稽核寫入失敗，費用與狀態均回滾", async () => {
    const job = await reserve();
    const before = await totals();
    await control.query(`CREATE FUNCTION app.synthetic_fail_audit() RETURNS trigger LANGUAGE plpgsql AS
      $$ BEGIN IF NEW.action='settled' THEN RAISE EXCEPTION 'synthetic audit failure'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER synthetic_fail_audit BEFORE INSERT ON app.usage_audit
      FOR EACH ROW EXECUTE FUNCTION app.synthetic_fail_audit()`);
    try {
      await expect(control.query("SELECT app.usage_finish($1,'settled',$2)",[job.reservation_id,usage])).rejects.toThrow("synthetic audit failure");
      expect(await totals()).toEqual(before);
      expect((await row(job)).state).toBe("reserved");
    } finally {
      await control.query("DROP TRIGGER synthetic_fail_audit ON app.usage_audit; DROP FUNCTION app.synthetic_fail_audit()");
    }
  });
  it("重複結算／釋放冪等，互斥轉換拒絕", async () => {
    const first = await reserve();
    for (let i = 0; i < 2; i++) {
      await control.query("SELECT app.usage_finish($1,'settled',$2)", [first.reservation_id, usage]);
    }
    expect((await row(first)).settled_micro).toBe("10");
    await expect(control.query("SELECT app.usage_finish($1,'released')", [first.reservation_id])).rejects.toThrow("reservation_state_conflict");
    const second = await reserve();
    for (let i = 0; i < 2; i++) await control.query("SELECT app.usage_finish($1,'released')", [second.reservation_id]);
    expect((await row(second)).state).toBe("released");
    expect(await totals()).toEqual([
      { scope: "account", reserved_micro: "0", settled_micro: "10" },
      { scope: "pool", reserved_micro: "0", settled_micro: "10" },
    ]);
  });
  it("unknown 保持預留、不當零，不能任意釋放或當作已核對", async () => {
    const job = await reserve();
    await control.query("SELECT app.usage_finish($1,'unknown')", [job.reservation_id]);
    await control.query("SELECT app.usage_finish($1,'unknown')", [job.reservation_id]);
    await expect(control.query("SELECT app.usage_finish($1,'released')", [job.reservation_id])).rejects.toThrow("reconciliation_required");
    await expect(control.query("SELECT app.usage_finish($1,'settled',$2)", [job.reservation_id, usage])).rejects.toThrow("reconciliation_required");
    expect(await row(job)).toMatchObject({ state: "unknown", settled_micro: null });
    expect((await totals())[0].reserved_micro).toBe("30");
    expect((await control.query("SELECT amount_micro FROM app.usage_audit WHERE action='unknown'")).rows).toEqual([{ amount_micro: null }]);
  });
  it.each(["missing", "fractional"])("價格 %s 不猜價、不捏造捨入", async (mode) => {
    const job = await reserve();
    if (mode === "missing") await control.query("DELETE FROM app.model_prices");
    else await control.query("UPDATE app.model_prices SET input_micro_per_mtok=1");
    const result = await control.query("SELECT app.usage_finish($1,'settled',$2) AS state", [job.reservation_id, usage]);
    expect(result.rows[0].state).toBe("unknown");
    expect((await row(job)).settled_micro).toBeNull();
    expect((await totals())[0].reserved_micro).toBe("30");
  });
  it("依有效日期計價、cached 不重算，實際超估不截斷或隱藏費用", async () => {
    const job = await reserve(randomUUID(), 1n);
    await control.query(`INSERT INTO app.model_prices VALUES
      ('synthetic-model','2099-01-01Z',0,0,0,0,'https://example.invalid/future','2026-10-26')`);
    const actual = { input_tokens: 10, cached_input_tokens: 4, output_tokens: 2, images: 1 };
    await control.query("SELECT app.usage_finish($1,'settled',$2)", [job.reservation_id, actual]);
    expect((await row(job)).settled_micro).toBe("19");
    expect((await totals())[0]).toMatchObject({ reserved_micro: "0", settled_micro: "19" });
  });
  it("不完整、負數、分數 usage 拒絕，不把錯誤當零", async () => {
    const job = await reserve();
    for (const invalid of [{}, { ...usage, input_tokens: -1 }, { ...usage, output_tokens: 0.5 }, { ...usage, cached_input_tokens: 11 }]) {
      await expect(control.query("SELECT app.usage_finish($1,'settled',$2)", [job.reservation_id, invalid])).rejects.toThrow("invalid_usage");
    }
    expect((await row(job)).state).toBe("reserved");
  });
  it("月／年界在 Taipei 午夜切換，與資料庫週期一致", async () => {
    expect(taipeiPeriodKeys(new Date("2026-12-31T15:59:59.999Z"))).toEqual({ day: "2026-12-31", month: "2026-12-01" });
    expect(taipeiPeriodKeys(new Date("2026-12-31T16:00:00Z"))).toEqual({ day: "2027-01-01", month: "2027-01-01" });
    for (const [instant, day, month] of [
      ["2026-12-31T15:59:59.999Z","2026-12-31","2026-12-01"],
      ["2026-12-31T16:00:00Z","2027-01-01","2027-01-01"],
      ["2028-02-29T16:00:00Z","2028-03-01","2028-03-01"],
    ]) {
      const boundary = await control.query(`SELECT period_day::text AS day,period_month::text AS month
        FROM app.usage_period_keys($1::timestamptz)`,[instant]);
      expect(boundary.rows[0]).toEqual({day,month});
    }
    const job = await reserve();
    const sql = await control.query(`SELECT period_day::text AS day,period_month::text AS month
      FROM app.usage_reservations WHERE id=$1`, [job.reservation_id]);
    expect(sql.rows[0]).toEqual(taipeiPeriodKeys(new Date()));
  });
  it("舊週期預留結算仍更新原桶，不移到新桶", async () => {
    const job = await reserve();
    await control.query(`UPDATE app.usage_totals SET period_key=CASE WHEN scope='account'
      THEN '2025-12-31'::date ELSE '2025-12-01'::date END;
      UPDATE app.usage_reservations SET period_day='2025-12-31',period_month='2025-12-01'`);
    await control.query("SELECT app.usage_finish($1,'settled',$2)", [job.reservation_id, usage]);
    const next = await reserve();
    expect((await row(next)).state).toBe("reserved");
    expect((await control.query("SELECT count(*) FROM app.usage_totals")).rows[0].count).toBe("4");
  });
  it("可信設定缺失／停用、無資源授權、教師角色與失效學校 fail-closed", async () => {
    await expect(ledger(account, false).reserve({
      idempotencyKey: randomUUID(), policyId: policy, estimateMicro: 1n, resourceId: randomUUID(),
    })).rejects.toMatchObject({ code: "authorization_denied" });
    await control.query("UPDATE app.quota_policies SET enabled=false");
    await expect(reserve()).rejects.toMatchObject({ code: "policy_not_approved" });
    await control.query("UPDATE app.quota_policies SET enabled=true");
    await control.query("UPDATE app.schools SET approval_state='expired' WHERE id=$1", [school]);
    await expect(reserve()).rejects.toMatchObject({ code: "authorization_denied" });
    await control.query("UPDATE app.schools SET approval_state='approved' WHERE id=$1", [school]);
    await control.query("UPDATE app.profiles SET status='disabled' WHERE id=$1", [account]);
    await expect(reserve()).rejects.toMatchObject({ code: "authorization_denied" });
    for (const role of ["teacher","admin"]) {
      await control.query("UPDATE app.profiles SET role=$2,status='approved' WHERE id=$1",[account,role]);
      await expect(reserve()).rejects.toMatchObject({ code:"authorization_denied" });
    }
    expect(await totals()).toEqual([]);
  });
  it("取消不可跨帳號；即使重送既有鍵也要重驗當下資格", async () => {
    const key = randomUUID();
    const job = await reserve(key);
    expect(await ledger(other).cancel(job.id)).toBe(false);
    await control.query("UPDATE app.profiles SET status='disabled' WHERE id=$1", [account]);
    await expect(reserve(key)).rejects.toMatchObject({ code: "authorization_denied" });
  });
  it("RLS 與 ACL 不開直接表存取、不讓正式 session 採用合成政策", async () => {
    const tables = ["budget_pools","pool_limits","quota_policies","model_prices","usage_totals","usage_reservations","jobs","usage_audit"];
    for (const role of ["anon","authenticated","service_role","app_usage_executor","app_job_executor"]) {
      for (const table of tables) {
        const result = await control.query(`SELECT has_table_privilege($1,$2,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE') AS permitted`, [role, `app.${table}`]);
        expect(result.rows[0].permitted).toBe(false);
      }
    }
    await context("app_usage_executor").runTransaction(async (q) => {
      await expect(q.query("SELECT * FROM app.jobs")).rejects.toThrow("permission denied");
    });
    const client = await control.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('request.jwt.claim.sub',$1,true)", [account]);
      await expect(client.query("SELECT * FROM app.usage_reserve($1,$2,1,NULL)", [randomUUID(),policy])).rejects.toThrow("policy_not_approved");
    } finally { await client.query("ROLLBACK"); client.release(); }
  });
  it("頻率與並行的拒絕不消耗新額度", async () => {
    await control.query("UPDATE app.quota_policies SET max_concurrent=1");
    await reserve();
    await expect(reserve()).rejects.toMatchObject({ code: "concurrency_limited" });
    await control.query("UPDATE app.quota_policies SET max_concurrent=100,rate_per_min=1");
    await expect(reserve()).rejects.toMatchObject({ code: "rate_limited" });
    expect((await totals())[0].reserved_micro).toBe("30");
  });
});

describe("T010 真實租約、fencing 與 runner", () => {
  it("並行領取不重複，SKIP LOCKED 跳過已鎖列", async () => {
    const first = await reserve();
    const second = await reserve();
    const lock = await control.connect();
    try {
      await lock.query("BEGIN");
      await lock.query("SELECT id FROM app.jobs WHERE id=$1 FOR UPDATE", [first.id]);
      expect((await worker().claim())?.id).toBe(second.id);
    } finally { await lock.query("ROLLBACK"); lock.release(); }
    const jobs = await Promise.all(Array.from({ length: 8 }, () => worker().claim()));
    expect(jobs.filter(Boolean).map((j) => j!.id)).toEqual([first.id]);
  });
  it("租約到期重領增加 fence，舊 worker 晚到與心跳不能覆寫", async () => {
    await reserve();
    const a = await claimed();
    await control.query("UPDATE app.jobs SET lease_expires_at=now()-interval '1 second' WHERE id=$1", [a.job.id]);
    const b = await claimed();
    expect(BigInt(b.job.fence)).toBeGreaterThan(BigInt(a.job.fence));
    await expect(a.w.save(a.job,"heartbeat")).rejects.toMatchObject({ code: "stale_lease" });
    await expect(a.w.save(a.job,"begin")).rejects.toMatchObject({ code: "stale_lease" });
    expect((await b.w.save(b.job,"heartbeat")).state).toBe("leased");
  });
  it("開始外部操作後程序中斷／租約過期進 unknown，不能自動重做", async () => {
    await reserve();
    const a = await claimed();
    await a.w.save(a.job,"begin");
    await control.query("UPDATE app.jobs SET lease_expires_at=now()-interval '1 second'");
    expect(await worker().claim()).toBeNull();
    expect(await row(a.job)).toMatchObject({ state:"unknown",settled_micro:null });
    expect((await totals())[0].reserved_micro).toBe("30");
    await expect(a.w.save(a.job,"complete",randomUUID(),usage)).rejects.toMatchObject({ code:"stale_lease" });
  });
  it("已確認部分成果持久保存，中斷後只執行剩餘步驟並累計已知費用", async () => {
    await reserve();
    const a = await claimed();
    const partial = await complete(a.w,a.job);
    expect(partial.partial_refs).toHaveLength(1);
    await control.query("UPDATE app.jobs SET lease_expires_at=now()-interval '1 second'");
    let calls = 0;
    const result = await runOne(worker(), {
      stepCount: () => 2,
      async execute(job) {
        calls++;
        expect(job.checkpoint).toBe(1);
        return { outcome:"completed",ref:randomUUID(),usage };
      },
    }, 50);
    expect(calls).toBe(1);
    expect(result).toMatchObject({ state:"done",checkpoint:2,partial_refs:expect.arrayContaining(partial.partial_refs) });
    expect((await row(a.job)).settled_micro).toBe("20");
  });
  it("可靠未送出結果才可 retry，超過 max_attempts 不再領取", async () => {
    const job = await reserve();
    const adapter = { stepCount: () => 1, async execute() { return { outcome:"not_sent_retryable" as const }; } };
    expect((await runOne(worker(),adapter,50))?.state).toBe("queued");
    expect((await runOne(worker(),adapter,50))?.state).toBe("queued");
    expect((await runOne(worker(),adapter,50))?.state).toBe("failed");
    expect(await worker().claim()).toBeNull();
    expect((await row(job)).state).toBe("released");
  });
  it("不明外部結果與 adapter 例外都不走自動 retry", async () => {
    const job = await reserve();
    let calls = 0;
    const adapter = { stepCount: () => 1, async execute(): Promise<never> { calls++; throw new Error("synthetic provider interruption"); } };
    expect((await runOne(worker(),adapter,50))?.effect_state).toBe("unknown");
    expect(await runOne(worker(),adapter,50)).toBeNull();
    expect(calls).toBe(1);
    expect((await row(job)).state).toBe("unknown");
  });
  it.each(["account","epoch","unapproved_expiry_policy","adapter"])("重要步驟重驗 %s 拒絕繼續", async (change) => {
    await reserve();
    const a = await claimed(change === "adapter" ? worker(false) : worker());
    if (change === "account") await control.query("UPDATE app.profiles SET status='disabled' WHERE id=$1",[account]);
    if (change === "epoch") await control.query("UPDATE app.schools SET approval_epoch=2 WHERE id=$1",[school]);
    if (change === "unapproved_expiry_policy") await control.query("UPDATE app.schools SET valid_until=now()+interval '1 year' WHERE id=$1",[school]);
    expect((await a.w.save(a.job,"begin")).state).toBe("failed");
    expect((await row(a.job)).state).toBe("released");
  });
  it("in-flight 後 epoch 改變不綁結果，改為 unknown", async () => {
    await reserve();
    const a = await claimed();
    const active = await a.w.save(a.job,"begin");
    await control.query("UPDATE app.schools SET approval_epoch=2 WHERE id=$1",[school]);
    expect((await a.w.save(active,"complete",randomUUID(),usage)).effect_state).toBe("unknown");
    expect((await row(a.job)).state).toBe("unknown");
  });
  it("心跳與取消競態在下一 checkpoint 生效，不宣稱外部操作已終止", async () => {
    const job = await reserve();
    const a = await claimed();
    await a.w.save(a.job,"begin");
    await Promise.allSettled([a.w.save(a.job,"heartbeat"),ledger().cancel(job.id)]);
    const current = (await control.query("SELECT state FROM app.jobs WHERE id=$1",[job.id])).rows[0];
    if (current.state === "leased") await a.w.save(a.job,"heartbeat");
    expect((await row(job)).state).toBe("unknown");
  });
  it("結算與取消競態不重複扣費或釋放已知成果費用", async () => {
    const job = await reserve();
    const a = await claimed();
    const ready = await complete(a.w,a.job);
    await Promise.allSettled([a.w.save(ready,"done"),ledger().cancel(job.id)]);
    expect((await row(job)).state).toBe("settled");
    expect((await row(job)).settled_micro).toBe("10");
    expect((await totals())[0]).toMatchObject({ reserved_micro:"0",settled_micro:"10" });
  });
  it("runner 長步驟發出心跳，結束後停止計時器", async () => {
    const job = await reserve();
    const result = await runOne(worker(true,1000),{
      stepCount: () => 1,
      async execute() {
        const before = (await control.query("SELECT lease_expires_at FROM app.jobs WHERE id=$1",[job.id])).rows[0].lease_expires_at as Date;
        await new Promise((resolve) => setTimeout(resolve,80));
        const after = (await control.query("SELECT lease_expires_at FROM app.jobs WHERE id=$1",[job.id])).rows[0].lease_expires_at as Date;
        expect(after.getTime()).toBeGreaterThan(before.getTime());
        return { outcome:"completed",ref:randomUUID(),usage };
      },
    },10);
    expect(result?.state).toBe("done");
    expect((await row(job)).settled_micro).toBe("10");
  });
});
