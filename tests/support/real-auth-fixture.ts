import { randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import { Pool } from "pg";
import type { UsageContext } from "@app-planet/core";
import { createDatabaseSession } from "../../apps/web/src/server/database-session.ts";

export type SyntheticAuthAccount = {
  id: string;
  email: string;
  password: string;
  schoolId: string;
};

export type NativeAuthSession = {
  userId: string;
  accessToken: string;
  refreshToken: string;
};

const authOrigin = process.env.APP_PLANET_AUTH_ORIGIN;
const anonKey = process.env.APP_PLANET_AUTH_API_KEY;
const adminKey = process.env.APP_PLANET_TEST_AUTH_ADMIN_KEY;
const adminDatabaseUrl = process.env.APP_PLANET_TEST_DB_ADMIN_URL;
const appDatabaseUrl = process.env.APP_PLANET_DATABASE_URL;
let workerPool: Pool | null = null;

function requireTestSetting(value: string | undefined): string {
  if (!value) throw new Error("隔離原生 Auth 測試設定不完整。");
  return value;
}

export function openControlPool(): Pool {
  return new Pool({
    connectionString: requireTestSetting(adminDatabaseUrl),
    max: 4,
    connectionTimeoutMillis: 5_000,
    query_timeout: 8_000,
  });
}

async function authRequest(path: string, init: RequestInit): Promise<Response> {
  const response = await fetch(`${requireTestSetting(authOrigin)}${path}`, {
    ...init,
    cache: "no-store",
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    throw new Error(`隔離原生 Auth setup operation failed (HTTP ${response.status}).`);
  }
  return response;
}

export async function createSyntheticAuthAccount(
  control: Pool,
  label: string,
): Promise<SyntheticAuthAccount> {
  const email = `ap-${randomUUID()}@example.invalid`;
  const password = `${randomBytes(48).toString("base64url")}Aa9!`;
  const createResponse = await authRequest("/auth/v1/admin/users", {
    method: "POST",
    headers: {
      apikey: requireTestSetting(adminKey),
      authorization: `Bearer ${requireTestSetting(adminKey)}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ email, password, email_confirm: true }),
  });
  const created: unknown = await createResponse.json().catch(() => null);
  const createdUser = z.object({ id: z.uuid() }).safeParse(created);
  if (!createdUser.success) {
    throw new Error("隔離原生 Auth setup response invalid.");
  }
  const id = createdUser.data.id.toLowerCase();
  const schoolId = randomUUID();
  await control.query(`
    INSERT INTO app.schools(id,label,approval_state,approval_epoch,created_at,updated_at)
    VALUES ($1,$2,'approved',1,now(),now())
  `, [schoolId, `synthetic-${label}`]);
  await control.query(`
    INSERT INTO app.profiles(id,role,status,deletion_state,school_id,display_label,status_changed_at)
    VALUES ($1,'student','approved','none',$2,$3,now())
  `, [id, schoolId, `合成帳號${label}`]);
  return { id, email, password, schoolId };
}

export async function loginSyntheticAccount(account: SyntheticAuthAccount): Promise<NativeAuthSession> {
  const response = await authRequest("/auth/v1/token?grant_type=password", {
    method: "POST",
    headers: {
      apikey: requireTestSetting(anonKey),
      "content-type": "application/json",
    },
    body: JSON.stringify({ email: account.email, password: account.password }),
  });
  const body: unknown = await response.json().catch(() => null);
  if (typeof body !== "object" || body === null ||
      !("access_token" in body) || typeof body.access_token !== "string" ||
      !("refresh_token" in body) || typeof body.refresh_token !== "string" ||
      !("user" in body) || typeof body.user !== "object" || body.user === null ||
      !("id" in body.user) || typeof body.user.id !== "string" ||
      body.user.id.toLowerCase() !== account.id.toLowerCase()) {
    throw new Error("隔離原生 Auth login response invalid.");
  }
  return {
    userId: body.user.id.toLowerCase(),
    accessToken: body.access_token,
    refreshToken: body.refresh_token,
  };
}

export async function createOwnedSyntheticProject(account: SyntheticAuthAccount): Promise<string> {
  if (!appDatabaseUrl) throw new Error("隔離產品 DB 連線未設定。");
  const { rows } = await createDatabaseSession(account.id).write.runTransaction((query) =>
    query.query(
      "SELECT app.create_unclassified_project($1::text,NULL,false,$2::uuid) AS result",
      ["合成階段草稿驗收", randomUUID()],
    ));
  const result = rows[0];
  const created = z.object({
    outcome: z.literal("created"),
    project: z.object({ id: z.uuid() }),
  }).safeParse(typeof result === "object" && result !== null && "result" in result
    ? result.result
    : undefined);
  if (rows.length !== 1 || !created.success) {
    throw new Error("隔離產品 project fixture setup failed.");
  }
  return created.data.project.id.toLowerCase();
}

export async function createSyntheticAgentJob(
  control: Pool,
  account: SyntheticAuthAccount,
): Promise<string> {
  const { createUsageLedger } = await import("@app-planet/core");
  const policyId = randomUUID();
  await control.query("INSERT INTO app.budget_pools VALUES ('internal_ai','synthetic-creator')");
  await control.query(`
    INSERT INTO app.pool_limits VALUES
    ('internal_ai',date_trunc('month',now() AT TIME ZONE 'Asia/Taipei')::date,100000,$1)
  `, [randomUUID()]);
  await control.query(`
    INSERT INTO app.quota_policies VALUES
    ($1,'synthetic',$2,'student','learner_feature','synthetic-model','agent',
    'daily',10000,1000,100,3,true)
  `, [policyId, randomUUID()]);
  await control.query(`
    INSERT INTO app.model_prices VALUES
    ('synthetic-model','2020-01-01Z',1000000,500000,2000000,7,
    'https://example.invalid/synthetic-price','2026-10-26')
  `);
  const session = createDatabaseSession(account.id);
  const ledger = createUsageLedger(session.usage, {
    async authorize(_query, resource) { return resource === null; },
  });
  const job = await ledger.reserve({
    idempotencyKey: randomUUID(),
    policyId,
    estimateMicro: 30n,
    resourceId: null,
  });
  return job.id;
}

export function createSyntheticWorkerContext(subject: string): UsageContext {
  const workerUrl = requireTestSetting(process.env.APP_PLANET_TEST_WORKER_DATABASE_URL);
  workerPool ??= new Pool({
    connectionString: workerUrl, max: 1, connectionTimeoutMillis: 5_000, query_timeout: 8_000,
  });
  return {
    async runTransaction(operation) {
      const client = await workerPool!.connect();
      let reusable = false;
      try {
        await client.query("BEGIN");
        await client.query("SET LOCAL ROLE app_job_executor");
        await client.query("SELECT set_config('request.jwt.claim.sub',$1,true)", [subject]);
        const result = await operation(client);
        await client.query("COMMIT");
        reusable = true;
        return result;
      } catch (error) {
        try {
          await client.query("ROLLBACK");
          reusable = true;
        } catch {
          reusable = false;
        }
        throw error;
      } finally {
        client.release(!reusable);
      }
    },
  };
}

export async function deleteSyntheticAuthAccount(account: SyntheticAuthAccount): Promise<void> {
  const response = await fetch(`${requireTestSetting(authOrigin)}/auth/v1/admin/users/${account.id}`, {
    method: "DELETE",
    cache: "no-store",
    redirect: "error",
    headers: {
      apikey: requireTestSetting(adminKey),
      authorization: `Bearer ${requireTestSetting(adminKey)}`,
    },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok && response.status !== 404) {
    throw new Error("隔離原生 Auth test account cleanup failed.");
  }
}

export async function dropTestDatabaseRoles(control: Pool): Promise<void> {
  await control.query("DROP ROLE IF EXISTS app_planet_worker_test");
  await control.query("DROP ROLE IF EXISTS app_usage_test");
}

export async function closeSyntheticWorkerPool(): Promise<void> {
  const pool = workerPool;
  workerPool = null;
  await pool?.end();
}

// readiness §90：既有教職員登入驗收用合成帳號。只建立 Auth 使用者與（可選）平台 profile；
// 不建立學校、師生關係或任何真實資料。profile=false 代表「Auth 帳號存在但缺平台 profile」。
export type SyntheticStaffAccount = {
  id: string;
  email: string;
  password: string;
  role: "teacher" | "admin" | null;
};

export async function createSyntheticStaffAccount(
  control: Pool,
  label: string,
  options: {
    readonly role: "teacher" | "admin" | null;
    readonly status?: "pending" | "approved" | "rejected" | "disabled";
    readonly deletionState?: "none" | "marked" | "purging" | "purge_failed" | "purged";
  },
): Promise<SyntheticStaffAccount> {
  const email = `ap-staff-${randomUUID()}@example.invalid`;
  const password = `${randomBytes(48).toString("base64url")}Aa9!`;
  const createResponse = await authRequest("/auth/v1/admin/users", {
    method: "POST",
    headers: {
      apikey: requireTestSetting(adminKey),
      authorization: `Bearer ${requireTestSetting(adminKey)}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ email, password, email_confirm: true }),
  });
  const created: unknown = await createResponse.json().catch(() => null);
  const createdUser = z.object({ id: z.uuid() }).safeParse(created);
  if (!createdUser.success) throw new Error("隔離原生 Auth staff setup response invalid.");
  const id = createdUser.data.id.toLowerCase();
  if (options.role !== null) {
    await control.query(`
      INSERT INTO app.profiles(id,role,status,deletion_state,school_id,display_label,status_changed_at)
      VALUES ($1,$2::app.account_role,$3::app.account_status,$4::app.deletion_state,NULL,$5,now())
    `, [id, options.role, options.status ?? "approved", options.deletionState ?? "none", `合成教職員${label}`]);
  }
  return { id, email, password, role: options.role };
}

export async function deleteSyntheticStaffAccount(control: Pool, account: SyntheticStaffAccount): Promise<void> {
  await control.query("DELETE FROM app.profiles WHERE id=$1", [account.id]);
  const response = await fetch(`${requireTestSetting(authOrigin)}/auth/v1/admin/users/${account.id}`, {
    method: "DELETE",
    cache: "no-store",
    redirect: "error",
    headers: {
      apikey: requireTestSetting(adminKey),
      authorization: `Bearer ${requireTestSetting(adminKey)}`,
    },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok && response.status !== 404) throw new Error("隔離原生 Auth staff account cleanup failed.");
}
