import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { Pool, type PoolClient } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { bootstrapFirstAdmin } from "../../apps/worker/src/admin/bootstrap.ts";
import { createTeacherReviewHandlers } from "../../apps/web/src/server/admin/teacher-review.ts";
import { createMeHandler } from "../../apps/web/src/server/auth/me.ts";
import { createAuthPrincipalResolver, sessionCookieName } from "../../apps/web/src/server/auth-principal.ts";
import { closeServerDatabasePool, createDatabaseSession } from "../../apps/web/src/server/database-session.ts";
import type { TrustedPrincipalResolver } from "../../apps/web/src/server/http.ts";
import {
  createSyntheticAuthAccount, createSyntheticStaffAccount,
  deleteSyntheticAuthAccount, deleteSyntheticStaffAccount, loginSyntheticAccount, openControlPool,
  type SyntheticAuthAccount, type SyntheticStaffAccount,
} from "../support/real-auth-fixture.ts";

// 真實隔離 PostgreSQL／原生 Auth；HTTP 層以 Request 直接呼叫產品 handler factory，
// 不是 TCP／proxy／瀏覽器驗收。只有明確標示的故障注入包裝 transaction，不替代 DB 或 Auth。
type Decision = "approved" | "rejected";
type ReviewResult = { id: string; status: Decision; row_version: number };
type RpcResult = { outcome: string; result?: ReviewResult };
type Profile = {
  role: string; status: string; deletion_state: string; school_id: string | null; row_version: number;
};
type Page = { items: { id: string; display_label: string; school_note: string | null; status: string; row_version: number }[]; next_cursor: string | null };
type StaffOptions = Parameters<typeof createSyntheticStaffAccount>[2];

const origin = process.env.APP_PLANET_APP_ORIGIN!;
const staff: SyntheticStaffAccount[] = [];
const students: SyntheticAuthAccount[] = [];
const auditFailureConstraint = "staff_approval_regression_audit_failure";
let control: Pool;
let runtime: Pool;

async function newStaff(options: Partial<StaffOptions> = {}): Promise<SyntheticStaffAccount> {
  const account = await createSyntheticStaffAccount(control, "審核回歸", {
    role: "teacher", status: "pending", ...options,
  });
  staff.push(account);
  return account;
}

async function newStudent(): Promise<SyntheticAuthAccount> {
  const account = await createSyntheticAuthAccount(control, "審核回歸");
  students.push(account);
  return account;
}

async function newAdmin(): Promise<SyntheticStaffAccount> {
  const account = await newStaff();
  expect(await bootstrapFirstAdmin(account.id)).toBe("completed");
  return account;
}

async function tokenFor(account: SyntheticStaffAccount | SyntheticAuthAccount): Promise<string> {
  // fixture 的登入只使用 email/password；不讀、不輸出原生 Auth response 或憑證。
  return (await loginSyntheticAccount({ ...account, schoolId: "schoolId" in account ? account.schoolId : "" })).accessToken;
}

function request(path: string, token?: string, init: RequestInit = {}): Request {
  const headers = new Headers({
    origin, "sec-fetch-site": "same-origin", "content-type": "application/json",
  });
  if (token) headers.set("cookie", `${sessionCookieName}=${token}`);
  new Headers(init.headers).forEach((value, key) => headers.set(key, value));
  return new Request(`${origin}${path}`, { ...init, headers });
}

function reviewRequest(
  target: string, token: string, decision: Decision = "approved", key = randomUUID(),
  version = 0, headers: HeadersInit = {},
): Request {
  return request(`/api/v1/admin/teachers/${target}/review`, token, {
    method: "POST",
    headers: { "idempotency-key": key, "if-match": `"${version}"`, ...Object.fromEntries(new Headers(headers)) },
    body: JSON.stringify({ decision }),
  });
}

async function httpReview(
  target: string, token: string, decision: Decision = "approved", key = randomUUID(), version = 0,
): Promise<Response> {
  return createTeacherReviewHandlers().review(reviewRequest(target, token, decision, key, version), { id: target });
}

async function problem(response: Response, status: number, code: string): Promise<void> {
  expect(response.status).toBe(status);
  expect(response.headers.get("content-type")).toContain("application/problem+json");
  expect(response.headers.get("cache-control")).toContain("no-store");
  expect(response.headers.has("set-cookie")).toBe(false);
  const body: unknown = await response.json();
  expect(body).toMatchObject({ status, code });
  // 錯誤只可使用固定公開 DTO，不回傳 SQL／Auth 原始錯誤。
  expect(Object.keys(body as object).sort()).toEqual([
    "code", "instance", "request_id", "status", "title", "type", "user_message_zh",
  ]);
}

async function profile(id: string): Promise<Profile | undefined> {
  return (await control.query<Profile>(
    "SELECT role,status,deletion_state,school_id,row_version FROM app.profiles WHERE id=$1", [id],
  )).rows[0];
}

async function rpc(
  actor: string, target: string, decision: Decision = "approved", key = randomUUID(), version = 0,
): Promise<RpcResult> {
  const { rows } = await createDatabaseSession(actor).write.runTransaction((query) =>
    query.query(
      "SELECT app.review_pending_teacher($1::uuid,$2::text,$3::integer,$4::uuid) AS result",
      [target, decision, version, key],
    ));
  return (rows[0] as { result: RpcResult }).result;
}

async function receiptCount(actor: string, key?: string): Promise<number> {
  const { rows } = await control.query<{ count: number }>(
    "SELECT count(*)::integer AS count FROM app.staff_review_receipts WHERE actor_id=$1 AND ($2::uuid IS NULL OR operation_key=$2)",
    [actor, key ?? null],
  );
  return rows[0]!.count;
}

async function audits(target: string) {
  return (await control.query<{
    action: string; actor_account: string; subject_account: string; object_type: string;
    object_ref: string | null; school_id: string | null; result: string;
    meta: { from_status: string; to_status: string; row_version: number; operation_id: string };
  }>(`
    SELECT event.action,actor.account_id AS actor_account,subject.account_id AS subject_account,
      event.object_type,event.object_ref,event.school_id,event.result,event.meta
    FROM app.audit_events AS event
    JOIN app.audit_identity_map AS actor ON actor.aid=event.actor_aid
    JOIN app.audit_identity_map AS subject ON subject.aid=event.subject_aid
    WHERE subject.account_id=$1 ORDER BY event.at,event.id
  `, [target])).rows;
}

async function bootstrapRecordCount(): Promise<number> {
  return (await control.query<{ count: number }>("SELECT count(*)::integer AS count FROM app.first_admin_bootstrap")).rows[0]!.count;
}

function bootstrapCli(target: string): Promise<{ exitCode: number; outcome: string | null; safeError: boolean }> {
  return new Promise((done) => {
    execFile(process.execPath, [resolve("apps", "worker", "src", "admin", "bootstrap-cli.ts"), target], {
      env: process.env, timeout: 20_000, maxBuffer: 8_192,
    }, (error, stdout, stderr) => {
      let outcome: string | null = null;
      try {
        const body: unknown = JSON.parse(stdout);
        if (typeof body === "object" && body !== null && Object.keys(body).length === 1 &&
            "outcome" in body && typeof body.outcome === "string") outcome = body.outcome;
      } catch { /* CLI 失敗時只檢查固定安全訊息，不輸出原始 stdout／stderr。 */ }
      done({
        exitCode: error ? typeof error.code === "number" ? error.code : -1 : 0,
        outcome,
        safeError: stderr.trim() === "bootstrap 未確認完成；請核對隔離設定與執行權限，只以同一目標重試。",
      });
    });
  });
}

async function withAuditFailure<T>(operation: () => Promise<T>): Promise<T> {
  // 本測試檔由隔離 runner 串行執行；NOT VALID 不重查既有紀錄，只令新 audit append 失敗。
  await control.query(`ALTER TABLE app.audit_events ADD CONSTRAINT ${auditFailureConstraint}
    CHECK (action NOT IN ('first_admin_bootstrap','teacher_approved','teacher_rejected')) NOT VALID`);
  try {
    return await operation();
  } finally {
    await control.query(`ALTER TABLE app.audit_events DROP CONSTRAINT ${auditFailureConstraint}`);
  }
}

async function waitForLock(pid: number, blockerPid: number): Promise<void> {
  const deadline = performance.now() + 6_000;
  while (performance.now() < deadline) {
    const { rows } = await control.query<{ waiting: boolean }>(`
      SELECT EXISTS (
        SELECT 1 FROM pg_stat_activity
        WHERE pid=$1 AND wait_event_type='Lock' AND $2=ANY(pg_blocking_pids(pid))
      ) AS waiting
    `, [pid, blockerPid]);
    if (rows[0]!.waiting) return;
  }
  throw new Error("未觀察到預期的 PostgreSQL 鎖等待。");
}

beforeAll(async () => {
  if (process.env.APP_PLANET_ENV !== "isolated-local-test" || process.env.NODE_ENV !== "test" ||
      process.env.APP_PLANET_BOOTSTRAP_MODE !== "isolated-local-test" ||
      process.env.APP_PLANET_LOCAL_AUTH !== "1" || !origin) {
    throw new Error("教師審核回歸只允許專用隔離 runner。");
  }
  control = openControlPool();
  runtime = new Pool({
    connectionString: process.env.APP_PLANET_DATABASE_URL, max: 3,
    connectionTimeoutMillis: 5_000, query_timeout: 15_000,
  });
  const { rows } = await control.query<{ ready: boolean }>(`
    SELECT EXISTS (SELECT 1 FROM app.staff_approval_local_config
      WHERE singleton AND isolation_id=$1::uuid AND receipt_ttl_seconds=86400)
      AND NOT EXISTS (SELECT 1 FROM app.first_admin_bootstrap)
      AND NOT EXISTS (SELECT 1 FROM app.profiles WHERE role='admin') AS ready
  `, [process.env.APP_PLANET_BOOTSTRAP_ISOLATION_ID]);
  expect(rows[0]!.ready).toBe(true);
});

afterEach(async () => {
  if (!control) return;
  const ids = [...staff, ...students].map((account) => account.id);
  const failures: unknown[] = [];
  // 不吞掉清理錯誤；Vitest 分別保留測試本身與 hook 的結果。
  try {
    await control.query(`ALTER TABLE app.audit_events DROP CONSTRAINT IF EXISTS ${auditFailureConstraint}`);
    await closeServerDatabasePool();
    if (ids.length) {
      const client = await control.connect();
      try {
        await client.query("BEGIN");
        await client.query("DELETE FROM app.staff_review_receipts WHERE actor_id=ANY($1::uuid[]) OR target_id=ANY($1::uuid[])", [ids]);
        await client.query("DELETE FROM app.first_admin_bootstrap WHERE target_id=ANY($1::uuid[])", [ids]);
        await client.query(`DELETE FROM app.audit_events WHERE actor_aid IN
          (SELECT aid FROM app.audit_identity_map WHERE account_id=ANY($1::uuid[]))
          OR subject_aid IN (SELECT aid FROM app.audit_identity_map WHERE account_id=ANY($1::uuid[]))`, [ids]);
        await client.query("DELETE FROM app.audit_identity_map WHERE account_id=ANY($1::uuid[])", [ids]);
        await client.query("COMMIT");
      } catch {
        await client.query("ROLLBACK");
        throw new Error("教師審核回歸資料清理失敗。");
      } finally {
        client.release();
      }
    }
    for (const account of staff) {
      try { await deleteSyntheticStaffAccount(control, account); } catch { failures.push("staff"); }
    }
    for (const account of students) {
      try {
        await control.query("DELETE FROM app.profiles WHERE id=$1", [account.id]);
        await control.query("DELETE FROM app.schools WHERE id=$1", [account.schoolId]);
        await deleteSyntheticAuthAccount(account);
      } catch { failures.push("student"); }
    }
  } catch {
    failures.push("database");
  } finally {
    staff.length = 0;
    students.length = 0;
  }
  if (failures.length) throw new Error("教師審核回歸清理未完成；不得將此輪標為通過。");
});

afterAll(async () => {
  await closeServerDatabasePool();
  await runtime?.end();
  await control?.end();
});

describe("first-admin bootstrap：專用 LOGIN → SECURITY DEFINER → 真實隔離 PostgreSQL", () => {
  it("實際 CLI 使用專用 LOGIN 完成／replay，消耗與輸入錯誤回非零且不輸出敏感錯誤", async () => {
    const target = await newStaff();
    const other = await newStaff();
    expect(await bootstrapCli(target.id)).toEqual({ exitCode: 0, outcome: "completed", safeError: false });
    expect(await bootstrapCli(target.id)).toEqual({ exitCode: 0, outcome: "already_completed", safeError: false });
    expect(await bootstrapCli(other.id)).toEqual({ exitCode: 1, outcome: "consumed", safeError: false });
    expect(await bootstrapCli("invalid-target")).toEqual({ exitCode: 1, outcome: null, safeError: true });
    expect(await audits(target.id)).toHaveLength(1);
    expect(await bootstrapRecordCount()).toBe(1);
  });

  it("只將 pending teacher bootstrap 一次；同目標 replay 不重複 audit，消耗後停權也不重開", async () => {
    const target = await newStaff();
    const other = await newStaff();
    expect(await bootstrapFirstAdmin(target.id)).toBe("completed");
    const original = await profile(target.id);
    expect(original).toMatchObject({ role: "admin", status: "approved", school_id: null, row_version: 1 });
    expect(await bootstrapFirstAdmin(target.id)).toBe("already_completed");
    expect(await bootstrapFirstAdmin(other.id)).toBe("consumed");
    expect(await profile(target.id)).toEqual(original);
    const events = await audits(target.id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      action: "first_admin_bootstrap", actor_account: target.id, subject_account: target.id,
      object_type: "account", object_ref: null, school_id: null, result: "ok",
      meta: { from_status: "pending", to_status: "approved", row_version: 1 },
    });
    const record = (await control.query<{ operation_id: string; target_id: string }>(
      "SELECT operation_id,target_id FROM app.first_admin_bootstrap",
    )).rows[0]!;
    expect(record).toEqual({ operation_id: events[0]!.meta.operation_id, target_id: target.id });
    await control.query("UPDATE app.profiles SET status='disabled' WHERE id=$1", [target.id]);
    expect(await bootstrapFirstAdmin(other.id)).toBe("consumed");
    expect(await bootstrapFirstAdmin(target.id)).toBe("already_completed");
    expect((await profile(target.id))!.status).toBe("disabled");
    expect(await audits(target.id)).toHaveLength(1);
    expect(await bootstrapRecordCount()).toBe(1);
  });

  it("無 bootstrap 紀錄但已有 admin 時拒絕，不以缺少紀錄重新開放", async () => {
    const admin = await newAdmin();
    const target = await newStaff();
    // 隔離控制故障前置：模擬遺失紀錄，不直接建立 approved admin。
    await control.query("DELETE FROM app.first_admin_bootstrap WHERE target_id=$1", [admin.id]);
    expect(await bootstrapFirstAdmin(target.id)).toBe("existing_admin");
    await control.query("UPDATE app.profiles SET status='disabled' WHERE id=$1", [admin.id]);
    expect(await bootstrapFirstAdmin(target.id)).toBe("existing_admin");
    expect(await bootstrapRecordCount()).toBe(0);
    expect((await profile(target.id))!.status).toBe("pending");
    expect(await audits(target.id)).toHaveLength(0);
  });

  it("首位 admin 的 profile／Auth 刪除後 singleton 仍持久消耗；同目標可確認、其他目標不可重開", async () => {
    const admin = await newAdmin();
    const other = await newStaff();
    const before = (await control.query(
      "SELECT target_id,operation_id,completed_at FROM app.first_admin_bootstrap",
    )).rows;
    expect(before).toHaveLength(1);
    // 依 fixture 清理順序先移除本測試 audit／identity FK，再刪 profile／原生 Auth；
    // 此處刻意保留 durable singleton，afterEach 才清除此測試的 bootstrap 紀錄。
    await control.query(`DELETE FROM app.audit_events WHERE actor_aid IN
      (SELECT aid FROM app.audit_identity_map WHERE account_id=$1)
      OR subject_aid IN (SELECT aid FROM app.audit_identity_map WHERE account_id=$1)`, [admin.id]);
    await control.query("DELETE FROM app.audit_identity_map WHERE account_id=$1", [admin.id]);
    await deleteSyntheticStaffAccount(control, admin);
    expect(await profile(admin.id)).toBeUndefined();
    expect((await control.query("SELECT id FROM auth.users WHERE id=$1", [admin.id])).rowCount).toBe(0);
    expect(await bootstrapFirstAdmin(other.id)).toBe("consumed");
    expect(await bootstrapFirstAdmin(admin.id)).toBe("already_completed");
    expect((await control.query(
      "SELECT target_id,operation_id,completed_at FROM app.first_admin_bootstrap",
    )).rows).toEqual(before);
    expect(await profile(other.id)).toMatchObject({ role: "teacher", status: "pending", row_version: 0 });
    expect(await audits(other.id)).toHaveLength(0);
    expect((await control.query("SELECT 1 FROM app.audit_identity_map WHERE account_id=$1", [admin.id])).rowCount).toBe(0);
  });

  it("兩個不同目標競爭 singleton，只有一個完成且只有一筆 audit", async () => {
    const targets = await Promise.all([newStaff(), newStaff()]);
    const results = await Promise.all(targets.map((target) => bootstrapFirstAdmin(target.id)));
    expect([...results].sort()).toEqual(["completed", "consumed"]);
    for (const [index, target] of targets.entries()) {
      expect((await profile(target.id))!.role).toBe(results[index] === "completed" ? "admin" : "teacher");
      expect(await audits(target.id)).toHaveLength(results[index] === "completed" ? 1 : 0);
    }
    expect(await bootstrapRecordCount()).toBe(1);
  });

  it("拒絕缺少 profile／Auth、已刪除 Auth、學生、非 pending 與標記刪除教師", async () => {
    const missing = await newStaff({ role: null });
    const marked = await newStaff({ deletionState: "marked" });
    const authDeleted = await newStaff();
    await control.query("UPDATE auth.users SET deleted_at=now() WHERE id=$1", [authDeleted.id]);
    const student = await newStudent();
    const invalid = [missing.id, marked.id, authDeleted.id, student.id, randomUUID()];
    for (const status of ["approved", "rejected", "disabled"] as const) {
      invalid.push((await newStaff({ status })).id);
    }
    for (const id of invalid) {
      expect(await bootstrapFirstAdmin(id)).toBe("invalid_target");
      expect(await audits(id)).toHaveLength(0);
    }
    expect(await bootstrapRecordCount()).toBe(0);
  });

  it("隔離標記或設定不符時關閉；專用 LOGIN 只能切換 bootstrap executor", async () => {
    const target = await newStaff();
    expect(await bootstrapFirstAdmin(target.id, {
      ...process.env, APP_PLANET_BOOTSTRAP_ISOLATION_ID: randomUUID(),
    })).toBe("unavailable");
    let refused = false;
    try { await bootstrapFirstAdmin(target.id, { ...process.env, APP_PLANET_BOOTSTRAP_MODE: "production" }); }
    catch { refused = true; }
    expect(refused).toBe(true);
    const pool = new Pool({ connectionString: process.env.APP_PLANET_BOOTSTRAP_DATABASE_URL, max: 1 });
    try {
      const { rows } = await pool.query<{ memberships: string[]; superuser: boolean; bypass: boolean }>(`
        SELECT (SELECT coalesce(array_agg(role.rolname ORDER BY role.rolname),'{}'::name[])
          FROM pg_auth_members AS membership JOIN pg_roles AS role ON role.oid=membership.roleid
          WHERE membership.member=(SELECT oid FROM pg_roles WHERE rolname=current_user))::text[] AS memberships,
          rolsuper AS superuser,rolbypassrls AS bypass FROM pg_roles WHERE rolname=current_user
      `);
      expect(rows[0]).toEqual({ memberships: ["app_bootstrap_executor"], superuser: false, bypass: false });
    } finally { await pool.end(); }
    expect((await profile(target.id))!.status).toBe("pending");
  });

  it("bootstrap writer 可鎖 Auth 列但 WITH CHECK false 阻止實際寫入；新 audit action 拒絕 JSON null／自由文字", async () => {
    const admin = await newAdmin();
    const target = await newStaff();
    const actorAid = (await control.query<{ aid: string }>(
      "SELECT aid FROM app.audit_identity_map WHERE account_id=$1", [admin.id],
    )).rows[0]!.aid;
    const subjectAid = randomUUID();
    const client = await control.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "INSERT INTO app.audit_identity_map(aid,account_id,created_at) VALUES ($1,$2,clock_timestamp())",
        [subjectAid, target.id],
      );
      await client.query("SET LOCAL ROLE app_bootstrap_writer");
      expect((await client.query<{ allowed: boolean }>(
        "SELECT has_column_privilege(current_user,'auth.users','id','UPDATE') AS allowed",
      )).rows[0]!.allowed).toBe(true);
      expect((await client.query("SELECT id FROM auth.users WHERE id=$1 FOR SHARE", [target.id])).rowCount).toBe(1);
      await client.query("SAVEPOINT auth_write_denial");
      let authWriteCode: string | undefined;
      try {
        await client.query("UPDATE auth.users SET id=id WHERE id=$1", [target.id]);
      } catch (error) {
        authWriteCode = (error as { code?: string }).code;
      } finally {
        await client.query("ROLLBACK TO SAVEPOINT auth_write_denial");
      }
      expect(authWriteCode).toBe("42501");
      expect((await client.query("SELECT id FROM auth.users WHERE id=$1", [target.id])).rowCount).toBe(1);
      for (const action of ["first_admin_bootstrap", "teacher_approved", "teacher_rejected"]) {
        const valid = {
          from_status: "pending", to_status: action === "teacher_rejected" ? "rejected" : "approved",
          row_version: 1, operation_id: randomUUID(),
        };
        const insert = (meta: unknown) => client.query(`
          INSERT INTO app.audit_events(id,at,actor_aid,subject_aid,action,object_type,result,meta)
          VALUES ($1,clock_timestamp(),$2,$3,$4,'account','ok',$5::jsonb)
        `, [randomUUID(), actorAid, subjectAid, action, JSON.stringify(meta)]);
        // 先證明同角色／同 action 的合法形狀確實可 append，避免以 ACL 拒絕誤判約束成功。
        await client.query("SAVEPOINT valid_audit_shape");
        expect((await insert(valid)).rowCount).toBe(1);
        await client.query("ROLLBACK TO SAVEPOINT valid_audit_shape");
        const invalid: unknown[] = [
          null,
          "synthetic-free-text",
          ...Object.keys(valid).map((field) => ({ ...valid, [field]: null })),
          { ...valid, note: "synthetic-free-text" },
        ];
        for (const meta of invalid) {
          await client.query("SAVEPOINT invalid_audit_shape");
          let failure: { code?: string; constraint?: string } | undefined;
          try {
            await insert(meta);
          } catch (error) {
            const rejected = error as { code?: string; constraint?: string };
            failure = { code: rejected.code, constraint: rejected.constraint };
          } finally {
            await client.query("ROLLBACK TO SAVEPOINT invalid_audit_shape");
          }
          expect(failure).toEqual({ code: "23514", constraint: "audit_events_staff_shape" });
        }
      }
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
    expect(await profile(target.id)).toMatchObject({ role: "teacher", status: "pending", row_version: 0 });
    expect(await audits(target.id)).toHaveLength(0);
    expect(await audits(admin.id)).toHaveLength(1);
    expect((await control.query("SELECT 1 FROM app.audit_identity_map WHERE account_id=$1", [target.id])).rowCount).toBe(0);
  });

  it("bootstrap audit append 失敗會回滾 profile、identity map 與 singleton；原目標可安全重試", async () => {
    const target = await newStaff();
    await withAuditFailure(async () => {
      let failed = false;
      try { await bootstrapFirstAdmin(target.id); } catch { failed = true; }
      expect(failed).toBe(true);
    });
    expect(await profile(target.id)).toMatchObject({ role: "teacher", status: "pending", row_version: 0 });
    expect(await bootstrapRecordCount()).toBe(0);
    expect(await audits(target.id)).toHaveLength(0);
    expect((await control.query("SELECT 1 FROM app.audit_identity_map WHERE account_id=$1", [target.id])).rowCount).toBe(0);
    expect(await bootstrapFirstAdmin(target.id)).toBe("completed");
  });
});

describe("教師審核：真實 DB、原生 Auth /user → handler → RPC", () => {
  it("approve／reject 原子保存、最小 audit、版本與 /me；不改 role／school", async () => {
    const admin = await newAdmin();
    const adminToken = await tokenFor(admin);
    for (const decision of ["approved", "rejected"] as const) {
      const target = await newStaff();
      const targetToken = await tokenFor(target);
      const before = (await profile(target.id))!;
      const key = randomUUID();
      const response = await httpReview(target.id, adminToken, decision, key);
      expect(response.status).toBe(200);
      expect(response.headers.get("etag")).toBe('"1"');
      expect(response.headers.get("cache-control")).toContain("no-store");
      expect(await response.json()).toEqual({ id: target.id, status: decision, row_version: 1 });
      expect(await profile(target.id)).toEqual({ ...before, status: decision, row_version: 1 });
      const events = await audits(target.id);
      expect(events).toEqual([{
        action: decision === "approved" ? "teacher_approved" : "teacher_rejected",
        actor_account: admin.id, subject_account: target.id, object_type: "account",
        object_ref: null, school_id: null, result: "ok",
        meta: { from_status: "pending", to_status: decision, row_version: 1, operation_id: key },
      }]);
      expect(await receiptCount(admin.id, key)).toBe(1);
      const me = await createMeHandler()(request("/api/v1/me", targetToken));
      expect(me.status).toBe(200);
      expect(await me.json()).toEqual({ role: "teacher", account_status: decision, school_gate: null });
      const receipt = (await control.query<{ ttl: number }>(
        "SELECT extract(epoch FROM expires_at-clock_timestamp())::float8 AS ttl FROM app.staff_review_receipts WHERE actor_id=$1 AND operation_key=$2",
        [admin.id, key],
      )).rows[0]!;
      expect(receipt.ttl).toBeGreaterThan(86_300);
      expect(receipt.ttl).toBeLessThanOrEqual(86_400);
    }
  });

  it("受限 actor、自審、學生／無 profile／刪除目標與非 pending 狀態均不修改資料", async () => {
    const admin = await newAdmin();
    const adminToken = await tokenFor(admin);
    const target = await newStaff();
    const student = await newStudent();
    const missing = await newStaff({ role: null });
    const marked = await newStaff({ deletionState: "marked" });
    const actors = [student, missing, marked];
    for (const status of ["pending", "approved", "rejected", "disabled"] as const) {
      actors.push(await newStaff({ status }));
    }
    for (const actor of actors) {
      expect((await rpc(actor.id, target.id)).outcome).toBe("denied");
      const token = await tokenFor(actor);
      await problem(await httpReview(target.id, token), 403, "forbidden");
      await problem(await createTeacherReviewHandlers().list(request("/api/v1/admin/teachers", token)), 403, "forbidden");
      expect(await receiptCount(actor.id)).toBe(0);
    }
    await problem(await httpReview(admin.id, adminToken), 403, "forbidden");
    for (const id of [student.id, missing.id, marked.id, randomUUID()]) {
      await problem(await httpReview(id, adminToken), 404, "not_found");
    }
    for (const status of ["approved", "rejected", "disabled"] as const) {
      const invalid = await newStaff({ status });
      await problem(await httpReview(invalid.id, adminToken), 409, "teacher_review_conflict");
      expect((await profile(invalid.id))!.status).toBe(status);
      expect(await audits(invalid.id)).toHaveLength(0);
    }
    // 非本人 admin 只作交易內負向故障前置，必定 ROLLBACK；正常 admin 仍一律經 bootstrap。
    const client = await control.connect();
    try {
      await client.query("BEGIN");
      await client.query("UPDATE app.profiles SET role='admin',status='approved' WHERE id=$1", [target.id]);
      await bindActor(client, admin.id);
      const result = await client.query<{ result: RpcResult }>(
        "SELECT app.review_pending_teacher($1,'approved',0,$2) AS result", [target.id, randomUUID()],
      );
      expect(result.rows[0]!.result.outcome).toBe("invalid_target");
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
    expect(await profile(target.id)).toMatchObject({ role: "teacher", status: "pending", row_version: 0 });
    expect(await audits(target.id)).toHaveLength(0);
    expect(await receiptCount(admin.id)).toBe(0);
  });

  it("authenticated 不能直接 UPDATE、存取 receipts 或執行 bootstrap；PUBLIC／anon／service_role 無 RPC 權限", async () => {
    const admin = await newAdmin();
    const target = await newStaff();
    const acl = await control.query<{ allowed: boolean }>(`
      SELECT has_function_privilege(role_name,signature,'EXECUTE') AS allowed
      FROM unnest(ARRAY['anon','service_role']) AS role_name
      CROSS JOIN unnest(ARRAY[
        'app.bootstrap_first_admin(uuid)','app.list_pending_teachers(uuid)',
        'app.review_pending_teacher(uuid,text,integer,uuid)'
      ]) AS signature
    `);
    expect(acl.rows.every((row) => row.allowed === false)).toBe(true);
    expect((await control.query<{ allowed: boolean }>(
      "SELECT has_function_privilege('authenticated','app.bootstrap_first_admin(uuid)','EXECUTE') AS allowed",
    )).rows[0]!.allowed).toBe(false);
    const publicAcl = await control.query<{ allowed: boolean }>(`
      SELECT EXISTS (
        SELECT 1 FROM pg_proc AS proc
        CROSS JOIN LATERAL aclexplode(coalesce(proc.proacl,acldefault('f',proc.proowner))) AS acl
        WHERE proc.oid=ANY(ARRAY[
          'app.bootstrap_first_admin(uuid)'::regprocedure,
          'app.list_pending_teachers(uuid)'::regprocedure,
          'app.review_pending_teacher(uuid,text,integer,uuid)'::regprocedure
        ]::oid[]) AND acl.grantee=0 AND acl.privilege_type='EXECUTE'
      ) AS allowed
    `);
    expect(publicAcl.rows[0]!.allowed).toBe(false);
    const membership = await runtime.query<{ bootstrap: boolean; reviewer: boolean; writer: boolean }>(`
      SELECT pg_has_role(current_user,'app_bootstrap_executor','MEMBER') AS bootstrap,
        pg_has_role(current_user,'app_staff_reviewer','MEMBER') AS reviewer,
        pg_has_role(current_user,'app_bootstrap_writer','MEMBER') AS writer
    `);
    expect(membership.rows[0]).toEqual({ bootstrap: false, reviewer: false, writer: false });
    const client = await runtime.connect();
    try {
      for (const sql of [
        "UPDATE app.profiles SET status='approved' WHERE id=$1",
        "UPDATE app.profiles SET role='admin' WHERE id=$1",
        "SELECT * FROM app.staff_review_receipts WHERE actor_id=$1",
        "SELECT app.bootstrap_first_admin($1)",
      ]) {
        await client.query("BEGIN");
        await bindActor(client, admin.id);
        let changed = false;
        try {
          const result = await client.query(sql, [target.id]);
          changed = (result.rowCount ?? 0) > 0;
        } catch (error) {
          expect((error as { code?: string }).code).toBe("42501");
        } finally { await client.query("ROLLBACK"); }
        expect(changed).toBe(false);
      }
    } finally { client.release(); }
    expect(await profile(target.id)).toMatchObject({ role: "teacher", status: "pending", row_version: 0 });
  });

  it("等待 actor row lock 後重新授權：以 pg_stat_activity／pg_blocking_pids 確認等待，不使用 sleep", async () => {
    const admin = await newAdmin();
    const target = await newStaff();
    const blocker = await control.connect();
    const reviewer = await runtime.connect();
    let pending: Promise<{ rows: { result: RpcResult }[] }> | undefined;
    try {
      await blocker.query("BEGIN");
      const blockerPid = (await blocker.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!.pid;
      await blocker.query("UPDATE app.profiles SET status='disabled' WHERE id=$1", [admin.id]);
      await reviewer.query("BEGIN");
      await bindActor(reviewer, admin.id);
      const reviewerPid = (await reviewer.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!.pid;
      pending = reviewer.query<{ result: RpcResult }>(
        "SELECT app.review_pending_teacher($1,'approved',0,$2) AS result", [target.id, randomUUID()],
      );
      // 立即註冊 rejection handler，清理仍 await 原 promise，不留下未處理的 rejection。
      void pending.catch(() => undefined);
      await waitForLock(reviewerPid, blockerPid);
      await blocker.query("COMMIT");
      expect((await pending).rows[0]!.result.outcome).toBe("denied");
      await reviewer.query("COMMIT");
    } finally {
      await blocker.query("ROLLBACK");
      await pending?.catch(() => undefined);
      await reviewer.query("ROLLBACK");
      blocker.release();
      reviewer.release();
    }
    expect(await profile(target.id)).toMatchObject({ status: "pending", row_version: 0 });
    expect(await receiptCount(admin.id)).toBe(0);
    expect(await audits(target.id)).toHaveLength(0);
  });

  it("同目標並行 approve／reject 只有一個 winner；舊版本不覆寫也不新增 receipt", async () => {
    const admin = await newAdmin();
    const target = await newStaff();
    const keys = [randomUUID(), randomUUID()];
    const results = await Promise.all([
      rpc(admin.id, target.id, "approved", keys[0]),
      rpc(admin.id, target.id, "rejected", keys[1]),
    ]);
    expect(results.map((result) => result.outcome).sort()).toEqual(["reviewed", "version_conflict"]);
    const winner = results.find((result) => result.outcome === "reviewed")!;
    expect(await profile(target.id)).toMatchObject({ status: winner.result!.status, row_version: 1 });
    expect(await audits(target.id)).toHaveLength(1);
    expect(await receiptCount(admin.id)).toBe(1);
    expect((await rpc(admin.id, target.id, "approved")).outcome).toBe("version_conflict");
    const untouched = await newStaff();
    expect((await rpc(admin.id, untouched.id, "approved", randomUUID(), 1)).outcome).toBe("version_conflict");
    expect(await profile(untouched.id)).toMatchObject({ status: "pending", row_version: 0 });
    expect(await receiptCount(admin.id)).toBe(1);
  });

  it("同 key 同 intent／target／version replay；不同意圖、目標或版本均拒絕，replay 仍檢查當下資格", async () => {
    const admin = await newAdmin();
    const token = await tokenFor(admin);
    const target = await newStaff();
    const other = await newStaff();
    const key = randomUUID();
    const first = await httpReview(target.id, token, "approved", key);
    expect(first.status).toBe(200);
    const result: unknown = await first.json();
    const replay = await httpReview(target.id, token, "approved", key);
    expect(replay.status).toBe(200);
    expect(replay.headers.get("idempotent-replay")).toBe("true");
    expect(await replay.json()).toEqual(result);
    for (const [id, decision, version] of [
      [target.id, "rejected", 0], [other.id, "approved", 0], [target.id, "approved", 1],
    ] as const) {
      await problem(await httpReview(id, token, decision, key, version), 422, "idempotency_key_reuse");
    }
    await control.query("UPDATE app.profiles SET status='disabled' WHERE id=$1", [admin.id]);
    await problem(await httpReview(target.id, token, "approved", key), 403, "forbidden");
    expect(await receiptCount(admin.id, key)).toBe(1);
    expect(await audits(target.id)).toHaveLength(1);
    expect(await profile(other.id)).toMatchObject({ status: "pending", row_version: 0 });
  });

  it("同 key 並行重送只完成一次，另一個從持久 receipt replay", async () => {
    const admin = await newAdmin();
    const target = await newStaff();
    const key = randomUUID();
    const results = await Promise.all([
      rpc(admin.id, target.id, "approved", key),
      rpc(admin.id, target.id, "approved", key),
    ]);
    expect(results.map((result) => result.outcome).sort()).toEqual(["replayed", "reviewed"]);
    expect(results[0]!.result).toEqual(results[1]!.result);
    expect(await profile(target.id)).toMatchObject({ status: "approved", row_version: 1 });
    expect(await audits(target.id)).toHaveLength(1);
    expect(await receiptCount(admin.id, key)).toBe(1);
  });

  it("audit append 失敗時 profile／identity map／receipt 全數回滾，同 key 之後可成功", async () => {
    const admin = await newAdmin();
    const token = await tokenFor(admin);
    const target = await newStaff();
    const key = randomUUID();
    await withAuditFailure(async () => {
      await problem(await httpReview(target.id, token, "approved", key), 503, "operation_outcome_unknown");
    });
    expect(await profile(target.id)).toMatchObject({ status: "pending", row_version: 0 });
    expect(await receiptCount(admin.id, key)).toBe(0);
    expect(await audits(target.id)).toHaveLength(0);
    expect((await control.query("SELECT 1 FROM app.audit_identity_map WHERE account_id=$1", [target.id])).rowCount).toBe(0);
    expect((await httpReview(target.id, token, "approved", key)).status).toBe(200);
    expect(await audits(target.id)).toHaveLength(1);
  });

  it("receipt 到期以隔離時間前置驗證：不重播過期結果、不重複審核，其他 receipt 不受影響", async () => {
    const admin = await newAdmin();
    const first = await newStaff();
    const second = await newStaff();
    const oldKey = randomUUID();
    const liveKey = randomUUID();
    expect((await rpc(admin.id, first.id, "approved", oldKey)).outcome).toBe("reviewed");
    expect((await rpc(admin.id, second.id, "rejected", liveKey)).outcome).toBe("reviewed");
    await control.query(
      "UPDATE app.staff_review_receipts SET expires_at=clock_timestamp()-interval '1 second' WHERE actor_id=$1 AND operation_key=$2",
      [admin.id, oldKey],
    );
    expect((await rpc(admin.id, first.id, "approved", oldKey)).outcome).toBe("version_conflict");
    expect(await receiptCount(admin.id, oldKey)).toBe(0);
    expect((await rpc(admin.id, second.id, "rejected", liveKey)).outcome).toBe("replayed");
    expect(await receiptCount(admin.id, liveKey)).toBe(1);
    expect(await audits(first.id)).toHaveLength(1);
    expect(await audits(second.id)).toHaveLength(1);
  });

  it("pending 清單 UUID keyset 每頁最多 50、穩定排序、不重複、不暴露 Auth 或學校欄位", async () => {
    const admin = await newAdmin();
    const token = await tokenFor(admin);
    const pending: SyntheticStaffAccount[] = [];
    for (let offset = 0; offset < 53; offset += 6) {
      pending.push(...await Promise.all(Array.from({ length: Math.min(6, 53 - offset) }, () => newStaff())));
    }
    await newStaff({ deletionState: "marked" });
    await newStaff({ status: "approved" });
    await newStaff({ status: "rejected" });
    const handlers = createTeacherReviewHandlers();
    const first = await handlers.list(request("/api/v1/admin/teachers", token));
    expect(first.status).toBe(200);
    const page = await first.json() as Page;
    expect(Object.keys(page).sort()).toEqual(["items", "next_cursor"]);
    expect(page.items).toHaveLength(50);
    const expected = pending.map((account) => account.id).sort();
    expect(page.items.map((item) => item.id)).toEqual(expected.slice(0, 50));
    expect(page.next_cursor).toBe(expected[49]);
    for (const item of page.items) {
      expect(Object.keys(item).sort()).toEqual(["display_label", "id", "row_version", "school_note", "status"]);
      expect(item).toMatchObject({ status: "pending", row_version: 0 });
    }
    const second = await handlers.list(request(`/api/v1/admin/teachers?after=${page.next_cursor}`, token));
    expect(second.status).toBe(200);
    const tail = await second.json() as Page;
    expect(tail.items.map((item) => item.id)).toEqual(expected.slice(50));
    expect(tail.next_cursor).toBeNull();
    const last = await handlers.list(request(`/api/v1/admin/teachers?after=${expected[52]}`, token));
    expect(await last.json()).toEqual({ items: [], next_cursor: null });
    for (const query of ["after=invalid", "limit=500", `after=${expected[0]}&after=${expected[1]}`]) {
      await problem(await handlers.list(request(`/api/v1/admin/teachers?${query}`, token)), 400, "invalid_request");
    }
  });

  it("拒絕 spoof principal／role、跨來源、未知欄位與缺少或不合法的條件標頭", async () => {
    const admin = await newAdmin();
    const target = await newStaff();
    const teacher = await newStaff({ status: "approved" });
    const token = await tokenFor(admin);
    const teacherToken = await tokenFor(teacher);
    const handlers = createTeacherReviewHandlers();
    const spoof = { "x-user-id": admin.id, "x-actor-id": admin.id, "x-role": "admin", "x-school-id": randomUUID() };
    await problem(await handlers.review(reviewRequest(target.id, teacherToken, "approved", randomUUID(), 0, spoof), { id: target.id }), 403, "forbidden");
    await problem(await handlers.list(request("/api/v1/admin/teachers", undefined, { headers: spoof })), 401, "unauthenticated");
    await problem(await handlers.review(reviewRequest(target.id, token, "approved", randomUUID(), 0, {
      origin: "https://foreign.example.invalid", "sec-fetch-site": "cross-site",
    }), { id: target.id }), 403, "forbidden");
    await problem(await handlers.review(request(`/api/v1/admin/teachers/${target.id}/review`, token, {
      method: "POST", headers: { "idempotency-key": randomUUID(), "if-match": '"0"' },
      body: JSON.stringify({ decision: "approved", actor_id: admin.id, role: "admin" }),
    }), { id: target.id }), 422, "unknown_field");
    for (const [name, value, code] of [
      ["idempotency-key", null, "idempotency_key_required"],
      ["idempotency-key", "not-a-uuid", "invalid_idempotency_key"],
      ["if-match", null, "if_match_required"],
      ["if-match", 'W/"0"', "invalid_if_match"],
      ["if-match", '"-1"', "invalid_if_match"],
      ["if-none-match", "*", "invalid_if_match"],
    ] as const) {
      const input = reviewRequest(target.id, token);
      if (value === null) input.headers.delete(name);
      else input.headers.set(name, value);
      await problem(await handlers.review(input, { id: target.id }), 400, code);
    }
    expect(await profile(target.id)).toMatchObject({ status: "pending", row_version: 0 });
    expect(await receiptCount(admin.id)).toBe(0);
    expect(await audits(target.id)).toHaveLength(0);
  });

  it("Auth 實際連線失敗、DB 設定不可用與隔離 config 關閉時 fail closed", async () => {
    const admin = await newAdmin();
    const target = await newStaff();
    const token = await tokenFor(admin);
    const authDown = createTeacherReviewHandlers(createAuthPrincipalResolver({
      ...process.env, APP_PLANET_AUTH_ORIGIN: "http://127.0.0.1:1",
    }));
    await problem(await authDown.list(request("/api/v1/admin/teachers", token)), 503, "dependency_unavailable");
    await problem(await authDown.review(reviewRequest(target.id, token), { id: target.id }), 503, "dependency_unavailable");
    const dbDown = createTeacherReviewHandlers(createAuthPrincipalResolver({
      ...process.env, APP_PLANET_DATABASE_URL: "",
    }));
    await problem(await dbDown.list(request("/api/v1/admin/teachers", token)), 503, "dependency_unavailable");
    await problem(await dbDown.review(reviewRequest(target.id, token), { id: target.id }), 503, "dependency_unavailable");
    // 真實 TCP 連線失敗，而非以假的 DB context 代替查詢。
    const unreachable = new URL(process.env.APP_PLANET_DATABASE_URL!);
    unreachable.hostname = "127.0.0.1";
    unreachable.port = "1";
    await closeServerDatabasePool();
    try {
      const connectionDown = createTeacherReviewHandlers(createAuthPrincipalResolver({
        ...process.env, APP_PLANET_DATABASE_URL: unreachable.toString(),
      }));
      await problem(await connectionDown.list(request("/api/v1/admin/teachers", token)), 503, "dependency_unavailable");
      await problem(await connectionDown.review(reviewRequest(target.id, token), { id: target.id }), 503, "operation_outcome_unknown");
    } finally {
      await closeServerDatabasePool();
    }
    const client = await control.connect();
    try {
      await client.query("BEGIN");
      await client.query("DELETE FROM app.staff_approval_local_config");
      await bindActor(client, admin.id);
      const list = await client.query<{ result: RpcResult }>("SELECT app.list_pending_teachers(NULL) AS result");
      expect(list.rows[0]!.result.outcome).toBe("unavailable");
      const review = await client.query<{ result: RpcResult }>(
        "SELECT app.review_pending_teacher($1,'approved',0,$2) AS result", [target.id, randomUUID()],
      );
      expect(review.rows[0]!.result.outcome).toBe("unavailable");
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
    expect(await profile(target.id)).toMatchObject({ status: "pending", row_version: 0 });
    expect(await receiptCount(admin.id)).toBe(0);
  });

  it("真實 COMMIT 後注入 response loss，原 key 重試回 replay，沒有第二次更新或 audit", async () => {
    const admin = await newAdmin();
    const target = await newStaff();
    const token = await tokenFor(admin);
    const key = randomUUID();
    const actualResolver = createAuthPrincipalResolver();
    let committed = false;
    const responseLoss: TrustedPrincipalResolver = {
      async resolve(input) {
        const principal = await actualResolver.resolve(input);
        if (!principal.ok) return principal;
        return {
          ...principal,
          session: {
            ...principal.session,
            write: {
              async runTransaction(operation) {
                const result = await principal.session.write.runTransaction(operation);
                // 此點已由產品 database-session 執行真實 COMMIT；只丟失提交後的回傳。
                if (!committed) {
                  committed = true;
                  throw new Error("隔離提交後回應遺失。");
                }
                return result;
              },
            },
          },
        };
      },
    };
    const handler = createTeacherReviewHandlers(responseLoss);
    await problem(await handler.review(reviewRequest(target.id, token, "approved", key), { id: target.id }),
      503, "operation_outcome_unknown");
    expect(committed).toBe(true);
    expect(await profile(target.id)).toMatchObject({ status: "approved", row_version: 1 });
    expect(await receiptCount(admin.id, key)).toBe(1);
    const retry = await httpReview(target.id, token, "approved", key);
    expect(retry.status).toBe(200);
    expect(retry.headers.get("idempotent-replay")).toBe("true");
    expect(await retry.json()).toEqual({ id: target.id, status: "approved", row_version: 1 });
    expect(await audits(target.id)).toHaveLength(1);
    expect(await profile(target.id)).toMatchObject({ status: "approved", row_version: 1 });
  });
});

async function bindActor(client: PoolClient, actor: string): Promise<void> {
  await client.query("SET LOCAL ROLE authenticated");
  await client.query(
    "SELECT set_config('request.jwt.claim.sub',$1,true),set_config('request.jwt.claims',$2,true)",
    [actor, JSON.stringify({ sub: actor })],
  );
}
