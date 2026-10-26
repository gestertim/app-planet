import { randomBytes } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { Pool } from "pg";

const adminUrl = process.env.APP_PLANET_TEST_DB_ADMIN_URL;
if (!adminUrl) {
  console.error("缺少隔離 PostgreSQL setup 連線。");
  process.exit(1);
}

const appPassword = randomBytes(32).toString("hex");
const workerPassword = randomBytes(32).toString("hex");
const pool = new Pool({ connectionString: adminUrl, max: 1, connectionTimeoutMillis: 5_000 });
let migrationPrincipal;

try {
  const principalResult = await pool.query(`
    SELECT current_user AS name, rolsuper AS is_superuser
    FROM pg_roles WHERE rolname=current_user
  `);
  migrationPrincipal = principalResult.rows[0];
  const migrationDirectory = new URL("../supabase/migrations/", import.meta.url);
  const migrations = (await readdir(migrationDirectory))
    .filter((name) => /^\d+.*\.sql$/.test(name))
    .sort();
  if (migrations.length === 0) throw new Error("Isolated database migrations are missing.");
  for (const migration of migrations) {
    await pool.query(await readFile(new URL(migration, migrationDirectory), "utf8"));
  }

  const authPrivileges = await pool.query(`
    SELECT pg_get_userbyid(function_row.proowner) AS project_function_owner,
      has_schema_privilege(pg_get_userbyid(function_row.proowner),'auth','USAGE') AS owner_schema_usage,
      has_function_privilege(pg_get_userbyid(function_row.proowner),'auth.uid()','EXECUTE') AS owner_function_execute,
      has_schema_privilege('authenticated','auth','USAGE') AS authenticated_schema_usage,
      has_function_privilege('authenticated','auth.uid()','EXECUTE') AS authenticated_function_execute,
      (SELECT auth_namespace.nspacl::text FROM pg_namespace auth_namespace WHERE auth_namespace.nspname='auth')
        AS auth_schema_acl,
      pg_has_role(current_user,'supabase_admin','MEMBER') AS admin_member
    FROM pg_proc function_row
    JOIN pg_namespace namespace ON namespace.oid=function_row.pronamespace
    WHERE namespace.nspname='app' AND function_row.proname='create_unclassified_project'
  `);
  process.stderr.write(`Auth DB privilege check: ${JSON.stringify(authPrivileges.rows[0])}\n`);
  if (authPrivileges.rows[0]?.owner_schema_usage !== true ||
      authPrivileges.rows[0]?.owner_function_execute !== true) {
    throw new Error("Isolated database migration did not grant the Auth function permissions required by its owner.");
  }

  await pool.query(`
    CREATE ROLE app_usage_test LOGIN PASSWORD '${appPassword}'
      NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS
  `);
  await pool.query(`
    GRANT authenticated, app_usage_executor TO app_usage_test
      WITH ADMIN FALSE, INHERIT FALSE, SET TRUE
  `);
  await pool.query(`
    CREATE ROLE app_planet_worker_test LOGIN PASSWORD '${workerPassword}'
      NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS
  `);
  await pool.query(`
    GRANT app_job_executor TO app_planet_worker_test
      WITH ADMIN FALSE, INHERIT FALSE, SET TRUE
  `);
  const appUrl = new URL(adminUrl);
  appUrl.username = "app_usage_test";
  appUrl.password = appPassword;
  const workerUrl = new URL(adminUrl);
  workerUrl.username = "app_planet_worker_test";
  workerUrl.password = workerPassword;
  process.stdout.write(JSON.stringify({
    applicationDatabaseUrl: appUrl.toString(),
    workerDatabaseUrl: workerUrl.toString(),
  }));
} catch (error) {
  console.error("隔離 PostgreSQL migration／runtime role setup 失敗。");
  if (migrationPrincipal) {
    console.error(`migration principal: ${migrationPrincipal.name}; superuser=${migrationPrincipal.is_superuser}`);
  }
  if (error instanceof Error) console.error(error.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
