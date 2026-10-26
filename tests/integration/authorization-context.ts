import { Pool, type PoolClient } from "pg";
import type { AuthorizationContext } from "../../apps/web/src/server/authorization.ts";
import type { ProjectCreationContext } from "../../apps/web/src/server/projects.ts";

// 僅測試：不驗 JWT 簽章，不得匯入產品登入或 HTTP 路徑。
export function syntheticContext(
  pool: Pool,
  subject: string | null,
  options: { claims?: Record<string, unknown>; fault?: "sql" } = {},
): AuthorizationContext {
  return {
    async runReadOnly(operation) {
      const client = await pool.connect();
      let reusable = false;
      try {
        await client.query("BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY");
        await client.query("SET LOCAL ROLE authenticated");
        await client.query(
          "SELECT set_config('request.jwt.claim.sub', $1, true), set_config('request.jwt.claims', $2, true)",
          [subject ?? "", JSON.stringify({ ...options.claims, sub: subject })],
        );
        const result = await operation(options.fault === "sql" ? {
          async query() { return client.query("SELECT 1 / 0"); },
        } : client);
        await client.query("COMMIT");
        reusable = true;
        return result;
      } finally {
        // 失敗（包括 COMMIT）時銷毀專用 socket，不把不確定交易歸還池。
        client.release(!reusable);
      }
    },
  };
}

export function syntheticCreationContext(
  pool: Pool,
  subject: string | null,
  options: { claims?: Record<string, unknown>; synchronize?: () => Promise<void> } = {},
): ProjectCreationContext {
  return {
    async runTransaction(operation) {
      const client = await pool.connect();
      let reusable = false;
      let transactionStarted = false;
      try {
        await client.query("BEGIN ISOLATION LEVEL READ COMMITTED READ WRITE");
        transactionStarted = true;
        await client.query("SET LOCAL ROLE authenticated");
        await client.query(
          "SELECT set_config('request.jwt.claim.sub', $1, true), set_config('request.jwt.claims', $2, true)",
          [subject ?? "", JSON.stringify({ ...options.claims, sub: subject })],
        );
        await options.synchronize?.();
        const result = await operation(client);
        await client.query("COMMIT");
        transactionStarted = false;
        reusable = true;
        return result;
      } catch (error) {
        if (transactionStarted) {
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
    },
  };
}

export function localPools() {
  const port = Number(process.env.APP_PLANET_PGTAP_PORT);
  const controlPassword = process.env.APP_PLANET_PGTAP_POSTGRES_PASSWORD;
  const authorizationPassword = process.env.APP_PLANET_AUTHORIZATION_PASSWORD;
  if (!Number.isInteger(port) || port < 1 || port > 65535 ||
      !controlPassword || !authorizationPassword ||
      process.env.APP_PLANET_AUTHORIZATION_RUN !== "isolated-runner") {
    throw new Error("整合測試只能由隔離本機 runner 啟動。");
  }
  const config = {
    host: "127.0.0.1", port, database: "postgres", max: 1,
    connectionTimeoutMillis: 5_000, query_timeout: 5_000,
  };
  return {
    control: new Pool({ ...config, user: "postgres", password: controlPassword }),
    authorization: new Pool({
      ...config, user: "app_authorization_test", password: authorizationPassword,
    }),
    parallelAuthorization: new Pool({
      ...config, max: 8, user: "app_authorization_test", password: authorizationPassword,
    }),
  };
}

export async function inspectConnection(client: PoolClient) {
  const result = await client.query(`
    SELECT current_user::text AS actor, session_user::text AS login,
      nullif(current_setting('request.jwt.claim.sub', true), '') AS sub,
      nullif(current_setting('request.jwt.claims', true), '') AS claims,
      pg_backend_pid() AS pid
  `);
  return result.rows[0];
}
