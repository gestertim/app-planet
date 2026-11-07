import { Pool, type PoolClient } from "pg";
import type { UsageContext } from "@app-planet/core";
import type { AuthorizationContext } from "./authorization.ts";
import type { TrustedSession } from "./http.ts";
import type { ProjectCreationContext } from "./projects.ts";

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const poolKey = Symbol.for("app-planet.server-database-pool");
type PoolGlobal = typeof globalThis & { [poolKey]?: Pool };

function databaseUrl(env: NodeJS.ProcessEnv): string | null {
  const value = env.APP_PLANET_DATABASE_URL;
  if (!value) return null;
  try {
    const parsed = new URL(value);
    if (!["postgres:", "postgresql:"].includes(parsed.protocol) ||
        !parsed.hostname || !parsed.username || !parsed.password) return null;
    if (env.APP_PLANET_LOCAL_AUTH === "1" &&
        !["127.0.0.1", "localhost"].includes(parsed.hostname)) return null;
    return value;
  } catch {
    return null;
  }
}

function getPool(env: NodeJS.ProcessEnv): Pool | null {
  const connectionString = databaseUrl(env);
  if (!connectionString) return null;
  const global = globalThis as PoolGlobal;
  if (!global[poolKey]) {
    global[poolKey] = new Pool({
      connectionString,
      max: 8,
      connectionTimeoutMillis: 5_000,
      query_timeout: 8_000,
      application_name: "app-planet-web",
    });
  }
  return global[poolKey] ?? null;
}

async function inTransaction<T>(
  pool: Pool,
  subject: string | null,
  role: "authenticated" | "app_usage_executor" | "app_signup_intake",
  readOnly: boolean,
  operation: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  let reusable = false;
  let active = false;
  try {
    await client.query(`BEGIN ISOLATION LEVEL READ COMMITTED ${readOnly ? "READ ONLY" : "READ WRITE"}`);
    active = true;
    await client.query(`SET LOCAL ROLE ${role}`);
    if (subject !== null) {
      await client.query(
        "SELECT set_config('request.jwt.claim.sub', $1, true), set_config('request.jwt.claims', $2, true)",
        [subject, JSON.stringify({ sub: subject })],
      );
    }
    const result = await operation(client);
    await client.query("COMMIT");
    active = false;
    reusable = true;
    return result;
  } catch (error) {
    if (active) {
      try {
        await client.query("ROLLBACK");
        reusable = true;
      } catch {
        reusable = false;
      }
    }
    throw error;
  } finally {
    client.release(!reusable);
  }
}

export function createDatabaseSession(
  subject: string,
  env: NodeJS.ProcessEnv = process.env,
): TrustedSession {
  if (!uuidPattern.test(subject)) throw new TypeError("invalid_authenticated_subject");
  const pool = getPool(env);
  if (!pool) throw new DatabaseConfigurationUnavailableError();
  const normalizedSubject = subject.toLowerCase();
  const runReadOnly: AuthorizationContext["runReadOnly"] = (operation) =>
    inTransaction(pool, normalizedSubject, "authenticated", true, (client) => operation(client));
  const runWrite: ProjectCreationContext["runTransaction"] = (operation) =>
    inTransaction(pool, normalizedSubject, "authenticated", false, (client) => operation(client));
  const runUsage: UsageContext["runTransaction"] = (operation) =>
    inTransaction(pool, normalizedSubject, "app_usage_executor", false, (client) => operation(client));
  return Object.freeze({
    read: Object.freeze({ runReadOnly }),
    write: Object.freeze({ runTransaction: runWrite }),
    usage: Object.freeze({ runTransaction: runUsage }),
  });
}

export class DatabaseConfigurationUnavailableError extends Error {
  constructor() {
    super("database_configuration_unavailable");
    this.name = "DatabaseConfigurationUnavailableError";
  }
}

// readiness §92：未登入教師申請只可切換到 app_signup_intake，該角色僅能執行固定申請意圖函式；
// 不帶任何 subject／JWT claim，也不能指定帳號 UUID、角色或狀態。
export function runSignupIntake<T>(
  operation: (client: PoolClient) => Promise<T>,
  env: NodeJS.ProcessEnv = process.env,
): Promise<T> {
  const pool = getPool(env);
  if (!pool) return Promise.reject(new Error("database_configuration_unavailable"));
  return inTransaction(pool, null, "app_signup_intake", false, operation);
}

export async function closeServerDatabasePool(): Promise<void> {
  const global = globalThis as PoolGlobal;
  const pool = global[poolKey];
  if (!pool) return;
  delete global[poolKey];
  await pool.end();
}
