import { Pool } from "pg";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const outcomes = ["completed", "already_completed", "consumed", "existing_admin", "invalid_target", "unavailable"] as const;
export type BootstrapOutcome = typeof outcomes[number];

export async function bootstrapFirstAdmin(target: string, env: NodeJS.ProcessEnv = process.env): Promise<BootstrapOutcome> {
  if (!uuid.test(target)) throw new Error("bootstrap_invalid_target");
  if (env.APP_PLANET_BOOTSTRAP_MODE !== "isolated-local-test" || env.APP_PLANET_LOCAL_AUTH !== "1" ||
      env.NODE_ENV !== "test" || env.APP_PLANET_ENV !== "isolated-local-test" ||
      !uuid.test(env.APP_PLANET_BOOTSTRAP_ISOLATION_ID ?? "")) throw new Error("bootstrap_isolation_required");
  const rawUrl = env.APP_PLANET_BOOTSTRAP_DATABASE_URL;
  if (!rawUrl) throw new Error("bootstrap_configuration_required");
  const url = new URL(rawUrl);
  if (!["postgres:", "postgresql:"].includes(url.protocol) || !["localhost", "127.0.0.1"].includes(url.hostname) ||
      !url.password || !url.username || url.search || url.hash) throw new Error("bootstrap_isolation_required");
  const pool = new Pool({ connectionString: rawUrl, max: 1, connectionTimeoutMillis: 5_000, query_timeout: 15_000 });
  try {
    const client = await pool.connect();
    let reusable = false;
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL ROLE app_bootstrap_executor");
      await client.query("SELECT set_config('app.bootstrap_isolation_id',$1,true)", [env.APP_PLANET_BOOTSTRAP_ISOLATION_ID]);
      const { rows } = await client.query<{ result: { outcome: unknown } }>(
        "SELECT app.bootstrap_first_admin($1::uuid) AS result", [target.toLowerCase()],
      );
      const outcome = rows[0]?.result?.outcome;
      if (!outcomes.some((allowed) => allowed === outcome)) throw new Error("bootstrap_invalid_result");
      await client.query("COMMIT");
      reusable = true;
      return outcome as BootstrapOutcome;
    } finally {
      // 不確定提交一律銷毀連線；呼叫者只能以相同目標重試，DB 的持久紀錄判定結果。
      client.release(!reusable);
    }
  } finally {
    await pool.end();
  }
}
