import { randomBytes, randomUUID } from "node:crypto";
import { Pool, type PoolClient, type QueryResult } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createStudentLoginHandler, requestStudentGrant, readStudentLoginRuntime } from "../../apps/web/src/server/auth/student.ts";
import { lookupStudentLogin, closeStudentLookupPools } from "../../apps/web/src/server/auth/student-lookup.ts";
import { StudentLoginThrottle } from "../../apps/web/src/server/auth/student-throttle.ts";
import { clientSourceHeader, sourceProofHeader } from "../../apps/web/src/server/auth/staff.ts";
import { closeServerDatabasePool } from "../../apps/web/src/server/database-session.ts";
import { createSyntheticStudent, removeSyntheticStudent, type SyntheticStudent } from "../support/student-login-fixture.ts";
import { openControlPool } from "../support/real-auth-fixture.ts";

const proof = randomBytes(32).toString("hex");
const settings = { ...process.env, APP_PLANET_SOURCE_PROXY_PROOF: proof };
let control: Pool;
let runtime: Pool;
let student: SyntheticStudent;
const accounts: SyntheticStudent[] = [];
const appOrigin = process.env.APP_PLANET_APP_ORIGIN!;

function request(account = student, source = "127.0.0.41", wrong = false) {
  return new Request(`${appOrigin}/api/v1/auth/student/login`, { method: "POST",
    headers: { origin: appOrigin, "content-type": "application/json",
      [sourceProofHeader]: proof, [clientSourceHeader]: source },
    body: JSON.stringify({ handle: account.handle, login_code: wrong ? "0".repeat(10) : account.password }) });
}
function handler() {
  return createStudentLoginHandler({ env: settings, throttle: new StudentLoginThrottle() });
}
async function assertProblem(response: Response, status: number, code: string) {
  expect(response.status).toBe(status);
  expect(await response.json()).toMatchObject({ status, code });
  expect(response.headers.has("set-cookie")).toBe(false);
  expect(response.headers.get("cache-control")).toContain("no-store");
}
beforeAll(async () => {
  control = openControlPool();
  runtime = new Pool({ connectionString: process.env.APP_PLANET_STUDENT_LOGIN_DATABASE_URL,
    max: 1, connectionTimeoutMillis: 5000, query_timeout: 5000 });
  student = await createSyntheticStudent(control);
  accounts.push(student);
});
afterAll(async () => {
  for (const account of accounts) await removeSyntheticStudent(control, account);
  await Promise.all([runtime.end(), closeStudentLookupPools(), closeServerDatabasePool()]);
  await control.end();
});

describe("真隔離 Auth／DB A-1", () => {
  it("Auth admin 回傳 UUID 關聯、600 秒 grant、固定 DTO 與 cookie", async () => {
    const config = readStudentLoginRuntime(settings);
    expect(config !== null).toBe(true);
    const grant = await requestStudentGrant(student.email, student.password, config!.auth);
    expect(grant.outcome === "session" && grant.expiresIn === 600).toBe(true);
    const found = await lookupStudentLogin(student.handle.toUpperCase(), settings);
    expect(found.outcome === "found" && found.credential.student_id === student.id).toBe(true);
    const response = await handler()(request());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ account_status: "approved", landing: "home" });
    expect(response.headers.get("set-cookie")?.includes("Max-Age=600")).toBe(true);
    console.info(JSON.stringify({ check: "student-trusted-uuid-grant", uuidLink: true, expiresIn: 600, cookieMaxAge: 600 }));
  });
  it.each(["pending", "rejected", "disabled"] as const)("%s 正確碼403，錯碼401", async (status) => {
    await control.query("UPDATE app.profiles SET status=$2 WHERE id=$1", [student.id, status]);
    try {
      await assertProblem(await handler()(request()), 403, "account_unavailable");
      await assertProblem(await handler()(request(student, "127.0.0.41", true)), 401, "invalid_credentials");
    } finally { await control.query("UPDATE app.profiles SET status='approved' WHERE id=$1", [student.id]); }
  });
  it.each(["marked", "purging", "purge_failed", "purged"] as const)("%s 正確碼403、錯碼401", async (state) => {
    await control.query("UPDATE app.profiles SET deletion_state=$2 WHERE id=$1", [student.id, state]);
    try {
      await assertProblem(await handler()(request()), 403, "account_unavailable");
      await assertProblem(await handler()(request(student, "127.0.0.41", true)), 401, "invalid_credentials");
    } finally { await control.query("UPDATE app.profiles SET deletion_state='none' WHERE id=$1", [student.id]); }
  });
  it("unconfirmed 真 Auth／DB 403", async () => {
    await control.query("UPDATE app.schools SET approval_state='unconfirmed' WHERE id=$1", [student.schoolId]);
    try { await assertProblem(await handler()(request()), 403, "school_not_confirmed"); }
    finally { await control.query("UPDATE app.schools SET approval_state='approved' WHERE id=$1", [student.schoolId]); }
  });
  it.each(["teacher", "admin"] as const)("%s 經學生入口401，owner RLS 不投影其 credential", async (role) => {
    const account = await createSyntheticStudent(control);
    accounts.push(account);
    await control.query("UPDATE app.profiles SET role=$2 WHERE id=$1", [account.id, role]);
    expect((await lookupStudentLogin(account.handle, settings)).outcome).toBe("missing");
    await assertProblem(await handler()(request(account)), 401, "invalid_credentials");
  });
  it("未知／revoked 都走 dummy，非相同碼失效／A-9 證明", async () => {
    const unknown = { ...student, handle: `sim-${randomBytes(8).toString("hex")}` };
    await assertProblem(await handler()(request(unknown)), 401, "invalid_credentials");
    await control.query("UPDATE app.student_login_credentials SET state='revoked' WHERE student_id=$1", [student.id]);
    try { await assertProblem(await handler()(request()), 401, "invalid_credentials"); }
    finally { await control.query("UPDATE app.student_login_credentials SET state='active' WHERE student_id=$1", [student.id]); }
  });
  it("handle存在但無credential仍401，不使用profile推導alias", async () => {
    await control.query("DELETE FROM app.student_login_credentials WHERE student_id=$1", [student.id]);
    try { await assertProblem(await handler()(request()), 401, "invalid_credentials"); }
    finally { await control.query("INSERT INTO app.student_login_credentials VALUES ($1,$2,1,'active')", [student.id, student.email]); }
  });
  it("A配對五次錯碼後429；B同學生正確碼200且A仍429", async () => {
    const login = handler();
    for (let n = 0; n < 5; n++) await assertProblem(await login(request(student, "127.0.0.42", true)), 401, "invalid_credentials");
    await assertProblem(await login(request(student, "127.0.0.42")), 429, "login_throttled");
    expect((await login(request(student, "127.0.0.43"))).status).toBe(200);
    await assertProblem(await login(request(student, "127.0.0.42")), 429, "login_throttled");
  });
  it("真 provider 已知／dummy 小樣本分列，非對稱不宣稱正式列舉通過", async () => {
    const config = readStudentLoginRuntime(settings)!;
    const outcomes: Record<string, unknown>[] = [];
    for (const known of [true, false]) {
      const start = performance.now();
      const grant = await requestStudentGrant(known ? student.email : config.dummyAlias, "0".repeat(10), config.auth);
      outcomes.push({ kind: known ? "known-wrong" : "unknown-dummy", outcome: grant.outcome, elapsedMs: Math.round(performance.now() - start) });
      expect(["invalid", "throttled", "unavailable"].includes(grant.outcome)).toBe(true);
    }
    console.info(JSON.stringify({ check: "real-provider-dummy-sample", samples: outcomes,
      enumerationTimingPassed: false, formalS02Executed: false }));
  });
});

describe("真 PostgreSQL 最小權限／FORCE RLS", () => {
  it("僅四欄、受限角色、無直接／傳遞成員與 PUBLIC EXECUTE", async () => {
    const checks = await control.query(`
      SELECT
        (SELECT count(*)=4 FROM information_schema.columns WHERE table_schema='app' AND table_name='student_login_credentials') AS four_columns,
        NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname IN ('app_student_login_lookup_owner','app_student_login_runtime')
          AND (rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb OR rolreplication OR rolinherit)) AS safe_flags,
        (SELECT NOT rolcanlogin FROM pg_roles WHERE rolname='app_student_login_lookup_owner') AS owner_nologin,
        (SELECT rolcanlogin FROM pg_roles WHERE rolname='app_student_login_runtime') AS runtime_login,
        NOT EXISTS (SELECT 1 FROM pg_auth_members WHERE member IN
          (SELECT oid FROM pg_roles WHERE rolname IN ('app_student_login_lookup_owner','app_student_login_runtime'))) AS no_membership,
        NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
          WHERE n.nspname='app' AND c.relowner=(SELECT oid FROM pg_roles WHERE rolname='app_student_login_lookup_owner')) AS owner_not_table_owner,
        NOT EXISTS (SELECT 1 FROM pg_namespace WHERE nspowner=(SELECT oid FROM pg_roles WHERE rolname='app_student_login_lookup_owner')) AS owner_not_schema_owner,
        (SELECT bool_and(relrowsecurity AND relforcerowsecurity) FROM pg_class WHERE oid IN
          ('app.profiles'::regclass,'app.student_login_credentials'::regclass)) AS force_rls,
        NOT has_any_column_privilege('app_student_login_runtime','app.profiles','SELECT') AS runtime_no_profile,
        NOT has_table_privilege('app_student_login_runtime','app.student_login_credentials','SELECT,INSERT,UPDATE,DELETE,TRUNCATE') AS runtime_no_credentials,
        NOT has_column_privilege('app_student_login_lookup_owner','app.profiles','status','SELECT') AS owner_no_status,
        NOT has_column_privilege('app_student_login_lookup_owner','app.profiles','school_id','SELECT') AS owner_no_school,
        has_function_privilege('app_student_login_runtime','app.lookup_student_login(text)','EXECUTE') AS only_lookup,
        NOT EXISTS (SELECT 1 FROM pg_proc p, LATERAL aclexplode(p.proacl) acl
          WHERE p.oid='app.lookup_student_login(text)'::regprocedure AND acl.grantee=0 AND acl.privilege_type='EXECUTE') AS public_revoked,
        NOT has_schema_privilege('app_student_login_runtime','app','CREATE') AS no_create
    `);
    expect(Object.values(checks.rows[0]).every((value) => value === true)).toBe(true);
    for (const role of ["anon", "authenticated", "service_role", "app_usage_test"]) {
      const result = await control.query("SELECT has_function_privilege($1,'app.lookup_student_login(text)','EXECUTE') AS allowed", [role]);
      expect(result.rows[0].allowed).toBe(false);
    }
    console.info(JSON.stringify({ check: "student-db-least-privilege", ...checks.rows[0] }));
  });
  it("runtime 真連線無法 SELECT/DML/TRUNCATE/SET ROLE/控制操作", async () => {
    for (const sql of [
      "SELECT * FROM app.profiles", "SELECT * FROM app.student_login_credentials",
      "UPDATE app.student_login_credentials SET state='revoked'", "DELETE FROM app.student_login_credentials",
      "INSERT INTO app.student_login_credentials DEFAULT VALUES", "TRUNCATE app.student_login_credentials",
      "SELECT * FROM auth.users", "CREATE TABLE app.student_login_backdoor(id int)",
      "SET ROLE app_student_login_lookup_owner", "SET ROLE authenticated", "SET ROLE service_role", "SET ROLE supabase_admin",
      "SELECT app.current_account_status()",
    ]) {
      let denied = false;
      try { await runtime.query(sql); } catch (error) {
        denied = typeof error === "object" && error !== null && "code" in error && error.code === "42501";
      }
      expect(denied).toBe(true);
    }
  });
  it("owner 真 RLS 只見student，欄位外拒絕；不靠 caller GUC 解鎖", async () => {
    const client = await control.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL ROLE app_student_login_lookup_owner");
      await client.query("SELECT set_config('request.jwt.claim.sub',$1,true)", [randomUUID()]);
      const rows = await client.query("SELECT id,role FROM app.profiles");
      expect(rows.rows.length > 0 && rows.rows.every((row) => row.role === "student")).toBe(true);
      const credentials = await client.query("SELECT student_id FROM app.student_login_credentials");
      expect(credentials.rows.every((row) => rows.rows.some((profile) => profile.id === row.student_id))).toBe(true);
      await client.query("ROLLBACK");
      await client.query("BEGIN");
      await client.query("SET LOCAL ROLE app_student_login_lookup_owner");
      let denied = false;
      try { await client.query("SELECT status FROM app.profiles"); } catch (error) {
        denied = typeof error === "object" && error !== null && "code" in error && error.code === "42501";
      }
      expect(denied).toBe(true);
    } finally { await client.query("ROLLBACK"); client.release(); }
  });
  it("lookup 權限撤回時503，恢復權限後200，不 fallback", async () => {
    await control.query("REVOKE EXECUTE ON FUNCTION app.lookup_student_login(text) FROM app_student_login_runtime");
    try { await assertProblem(await handler()(request()), 503, "dependency_unavailable"); }
    finally { await control.query("GRANT EXECUTE ON FUNCTION app.lookup_student_login(text) TO app_student_login_runtime"); }
    expect((await handler()(request())).status).toBe(200);
  });
  it("runtime受限角色旗標被控制層故障注入破壞時503，復原後200", async () => {
    await control.query("ALTER ROLE app_student_login_runtime CREATEDB");
    try { await assertProblem(await handler()(request()), 503, "dependency_unavailable"); }
    finally { await control.query("ALTER ROLE app_student_login_runtime NOCREATEDB"); }
    expect((await handler()(request())).status).toBe(200);
  });
  it("既有學生學校 CHECK／FK 保留；真 DB 缺校案例不偽造", async () => {
    const constraints = await control.query(`SELECT count(*)::int AS n FROM pg_constraint
      WHERE conrelid='app.profiles'::regclass AND
      (conname='profiles_student_school_required' OR (contype='f' AND confrelid='app.schools'::regclass))`);
    expect(constraints.rows[0].n).toBe(2);
    console.info(JSON.stringify({ check: "missing-school", controlledReaderCovered: true, realDBMissingSchool: "not-executed-constraints-preserved" }));
  });
});

type FixtureQuery = {
  text: string;
  values?: unknown[];
  transaction: boolean;
  execute: () => Promise<QueryResult>;
};

function interceptFixturePool(
  pool: Pool,
  intercept: (query: FixtureQuery) => Promise<QueryResult>,
  onRelease?: (client: PoolClient, destroy?: boolean) => void,
): Pool {
  return new Proxy(pool, {
    get(target, key) {
      if (key === "connect") return async () => {
        const client = await target.connect();
        return new Proxy(client, {
          get(connection, member) {
            if (member === "release" && onRelease) return (destroy?: boolean) => onRelease(connection, destroy);
            if (member === "query") return (text: string, values?: unknown[]) =>
              intercept({ text, values, transaction: true, execute: () => connection.query(text, values) });
            const value = Reflect.get(connection, member, connection);
            return typeof value === "function" ? value.bind(connection) : value;
          },
        });
      };
      if (key === "query") return (text: string, values?: unknown[]) =>
        intercept({ text, values, transaction: false, execute: () => target.query(text, values) });
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

describe("A-1 fixture 失敗補償", () => {
  let witness: Pool;
  beforeAll(() => { witness = openControlPool(); });
  afterAll(async () => { await witness.end(); });

  async function counts(account: SyntheticStudent) {
    const result = await witness.query<{ auth: number; profiles: number; credentials: number; schools: number }>(`SELECT
      (SELECT count(*)::int FROM auth.users WHERE id=$1) AS auth,
      (SELECT count(*)::int FROM app.profiles WHERE id=$1) AS profiles,
      (SELECT count(*)::int FROM app.student_login_credentials WHERE student_id=$1) AS credentials,
      (SELECT count(*)::int FROM app.schools WHERE id=$2) AS schools`, [account.id, account.schoolId]);
    return result.rows[0];
  }

  async function profileSnapshot() {
    const result = await witness.query("SELECT to_jsonb(p) FROM app.profiles p WHERE id=$1", [student.id]);
    return JSON.stringify(result.rows);
  }

  it.each([
    "before_commit", "after_commit", "invalid_verification",
    "commit_response_lost", "commit_not_sent", "commit_in_flight", "rollback_failed",
    "auth_cleanup_failed", "db_cleanup_failed",
  ] as const)("%s：故障證據、補償結果與既有資料保護", async (point) => {
    const original = new Error(`受控 fixture ${point} 故障`);
    const observed: SyntheticStudent = { id: "", schoolId: "", handle: "", email: "", password: "" };
    const existing = await counts(student);
    const existingProfile = await profileSnapshot();
    const blockerId = randomUUID();
    let injected = false;
    let committed = false;
    let rolledBack = false;
    let rollbackFailed = false;
    let cleanupFailed = false;
    let cleanupWaitedForCommit = false;
    let delayedCommit: (() => Promise<QueryResult>) | undefined;
    let settlement: Promise<void> | undefined;
    const fetch = globalThis.fetch;
    const authFault = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      if (point === "auth_cleanup_failed" && init?.method === "DELETE" &&
          String(input).endsWith(`/auth/v1/admin/users/${observed.id}`)) {
        cleanupFailed = true;
        throw new Error("synthetic-cleanup-sensitive-marker");
      }
      return fetch(input, init);
    });
    const faulted = interceptFixturePool(control, async ({ text, values, transaction, execute }) => {
      if (text.startsWith("INSERT INTO app.schools") && typeof values?.[0] === "string") observed.schoolId = values[0];
      if (text.startsWith("INSERT INTO app.profiles") && typeof values?.[0] === "string" && typeof values[2] === "string") {
        observed.id = values[0];
        observed.handle = values[2];
      }
      if (text.startsWith("INSERT INTO app.student_login_credentials") && typeof values?.[1] === "string") {
        observed.email = values[1];
        if (point === "before_commit" || point === "rollback_failed") {
          await execute();
          injected = true;
          throw original;
        }
      }
      if (point === "rollback_failed" && text === "ROLLBACK") {
        rollbackFailed = true;
        throw new Error("受控 ROLLBACK 回應遺失");
      }
      if (point === "commit_not_sent" && text === "COMMIT") {
        injected = true;
        throw original;
      }
      if (point === "commit_in_flight" && text === "COMMIT") {
        delayedCommit = execute;
        injected = true;
        throw original;
      }
      if (!transaction && text.startsWith("SELECT p.id=$1")) {
        if (point === "db_cleanup_failed") {
          // 非 fixture 建立的參照必須阻擋補償，不得擴大刪除。
          await witness.query("INSERT INTO app.audit_identity_map(aid,account_id,created_at) VALUES ($1,$2,now())",
            [blockerId, observed.id]);
        }
        if (point === "invalid_verification") {
          const result = await execute();
          injected = true;
          return { ...result, rows: [{ verified: false }] };
        }
        if (["after_commit", "auth_cleanup_failed", "db_cleanup_failed"].includes(point)) {
          injected = true;
          throw original;
        }
      }
      const result = await execute();
      if (text === "ROLLBACK") rolledBack = true;
      if (text === "COMMIT") {
        committed = true;
        if (point === "commit_response_lost") {
          injected = true;
          throw original;
        }
      }
      return result;
    }, (client, destroy) => {
      if (!delayedCommit) { client.release(destroy); return; }
      const commit = delayedCommit;
      delayedCommit = undefined;
      settlement = (async () => {
        try {
          for (let attempt = 0; attempt < 50; attempt++) {
            const waiting = await witness.query<{ waiting: boolean }>(`SELECT EXISTS (
              SELECT 1 FROM pg_stat_activity WHERE datname=current_database()
                AND wait_event_type='Lock' AND wait_event='advisory'
                AND query='SELECT pg_advisory_xact_lock(hashtextextended($1,0))') AS waiting`);
            if (waiting.rows[0].waiting) { cleanupWaitedForCommit = true; break; }
            await new Promise((resolve) => setTimeout(resolve, 20));
          }
          await commit();
          committed = true;
        } finally { client.release(destroy); }
      })();
    });
    try {
      let failure: unknown;
      try { await createSyntheticStudent(faulted); } catch (error) { failure = error; }
      await settlement;
      expect(injected).toBe(true);
      expect(observed.id.length > 0 && observed.schoolId.length > 0 && observed.email.length > 0).toBe(true);
      expect(committed).toBe(!["before_commit", "commit_not_sent", "rollback_failed"].includes(point));
      expect(rolledBack).toBe(point === "before_commit");
      expect(rollbackFailed).toBe(point === "rollback_failed");
      expect(cleanupWaitedForCommit).toBe(point === "commit_in_flight");
      if (point === "invalid_verification") {
        expect(failure instanceof Error && failure.message === "學生 fixture 提交後 UUID 關聯核對失敗。").toBe(true);
      } else if (point === "auth_cleanup_failed" || point === "db_cleanup_failed") {
        if (!(failure instanceof AggregateError)) throw new Error("未回報補償複合錯誤。");
        expect(failure.cause === original && failure.errors[0] === original).toBe(true);
        expect(failure.errors.slice(1).map((error: unknown) => error instanceof Error ? error.message : "invalid"))
          .toEqual(point === "auth_cleanup_failed"
            ? ["學生 fixture Auth 補償未能確認完成。"]
            : ["學生 fixture DB 補償未能確認完成。", "學生 fixture Auth 補償未能確認完成。"]);
        expect("transactionState" in failure && failure.transactionState === "committed").toBe(true);
        expect("unconfirmedResources" in failure && failure.unconfirmedResources).toEqual(point === "auth_cleanup_failed"
          ? [`auth.users:${observed.id}`]
          : [`app.student_login_credentials:${observed.id}`, `app.profiles:${observed.id}`,
            `app.schools:${observed.schoolId}`, `auth.users:${observed.id}`]);
      } else {
        expect(failure === original).toBe(true);
      }
      const remaining = await counts(observed);
      expect(remaining).toEqual(point === "auth_cleanup_failed"
        ? { auth: 1, profiles: 0, credentials: 0, schools: 0 }
        : point === "db_cleanup_failed"
          ? { auth: 1, profiles: 1, credentials: 1, schools: 1 }
          : { auth: 0, profiles: 0, credentials: 0, schools: 0 });
      expect(cleanupFailed).toBe(point === "auth_cleanup_failed");
      expect(await counts(student)).toEqual(existing);
      expect(await profileSnapshot() === existingProfile).toBe(true);
      if (point === "db_cleanup_failed") {
        const blocker = await witness.query("SELECT count(*)::int AS n FROM app.audit_identity_map WHERE aid=$1 AND account_id=$2",
          [blockerId, observed.id]);
        expect(blocker.rows[0].n).toBe(1);
      }
      console.info(JSON.stringify({ check: "fixture-compensation", point, injected, committed, rolledBack,
        rollbackFailed, cleanupWaitedForCommit, originalPreserved: true, cleanupFailureReported: point.endsWith("cleanup_failed"),
        remaining, existingPreserved: true }));
    } finally {
      authFault.mockRestore();
      await settlement;
      if (point === "db_cleanup_failed" && observed.id) {
        await witness.query("DELETE FROM app.audit_identity_map WHERE aid=$1 AND account_id=$2", [blockerId, observed.id]);
      }
      if (observed.id && observed.schoolId) {
        await removeSyntheticStudent(control, observed);
        const remaining = await counts(observed);
        expect(remaining).toEqual({ auth: 0, profiles: 0, credentials: 0, schools: 0 });
        console.info(JSON.stringify({ check: "fixture-case-final-cleanup", point, remaining }));
      }
      expect(await counts(student)).toEqual(existing);
      expect(await profileSnapshot() === existingProfile).toBe(true);
    }
  });

  it("成功回傳契約與既有正常清理，獨立查詢無殘留", async () => {
    const account = await createSyntheticStudent(control);
    try {
      expect(Object.keys(account).sort()).toEqual(["email", "handle", "id", "password", "schoolId"]);
      expect(/^[0123456789ABCDEFGHJKMNPQRSTVWXYZ]{10}$/.test(account.password)).toBe(true);
      expect(await counts(account)).toEqual({ auth: 1, profiles: 1, credentials: 1, schools: 1 });
    } finally { await removeSyntheticStudent(control, account); }
    expect(await counts(account)).toEqual({ auth: 0, profiles: 0, credentials: 0, schools: 0 });
    expect(await counts(student)).toEqual({ auth: 1, profiles: 1, credentials: 1, schools: 1 });
    console.info(JSON.stringify({ check: "fixture-success-normal-cleanup", remaining: 0, existingPreserved: true }));
  });
});
