import { randomBytes, randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { Pool } from "pg";

const adminUrl = process.env.APP_PLANET_TEST_DB_ADMIN_URL;
if (!adminUrl) {
  console.error("缺少隔離 PostgreSQL setup 連線。");
  process.exit(1);
}

const appPassword = randomBytes(32).toString("hex");
const workerPassword = randomBytes(32).toString("hex");
const bootstrapPassword = randomBytes(32).toString("hex");
const studentPassword = randomBytes(32).toString("hex");
const pool = new Pool({ connectionString: adminUrl, max: 1, connectionTimeoutMillis: 5_000 });
let migrationPrincipal;

try {
  const principalResult = await pool.query(`
    SELECT current_user AS name, rolsuper AS is_superuser
    FROM pg_roles WHERE rolname=current_user
  `);
  migrationPrincipal = principalResult.rows[0];
  const migrationDirectory = new URL("../supabase/migrations/", import.meta.url);
  // 僅升級驗收使用：先套用到指定編號（含），其餘 migration 由測試自行套用。
  const through = process.env.APP_PLANET_TEST_MIGRATE_THROUGH;
  if (through !== undefined && !/^\d{4}$/.test(through)) throw new Error("APP_PLANET_TEST_MIGRATE_THROUGH 必須是四位數字。");
  const migrations = (await readdir(migrationDirectory))
    .filter((name) => /^\d+.*\.sql$/.test(name))
    .filter((name) => through === undefined || name.slice(0, 4) <= through)
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
  if (through === undefined || through >= "0027") {
    const isolationId = process.env.APP_PLANET_BOOTSTRAP_ISOLATION_ID;
    if (process.env.APP_PLANET_ENV !== "isolated-local-test" ||
        !/^[0-9a-f-]{36}$/.test(isolationId ?? "")) throw new Error("缺少教師審核隔離設定。");
    await pool.query("INSERT INTO app.staff_approval_local_config VALUES (true,$1::uuid,86400)", [isolationId]);
    await pool.query(`
      CREATE ROLE app_bootstrap_test LOGIN PASSWORD '${bootstrapPassword}'
        NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS
    `);
    await pool.query("GRANT app_bootstrap_executor TO app_bootstrap_test WITH ADMIN FALSE, INHERIT FALSE, SET TRUE");
  }
  if (through === undefined || through >= "0028") {
    // readiness §92：教師申請意圖只經受限 intake 角色；入口設定只在 -TeacherSignup 隔離 runner 建立。
    await pool.query("GRANT app_signup_intake TO app_usage_test WITH ADMIN FALSE, INHERIT FALSE, SET TRUE");
    if (process.env.APP_PLANET_TEACHER_SIGNUP_MODE === "isolated-local-test") {
      await pool.query("INSERT INTO app.teacher_signup_local_config VALUES (true,3600)");
    }
  }
  const appUrl = new URL(adminUrl);
  appUrl.username = "app_usage_test";
  appUrl.password = appPassword;
  const workerUrl = new URL(adminUrl);
  workerUrl.username = "app_planet_worker_test";
  workerUrl.password = workerPassword;
  const bootstrapUrl = new URL(adminUrl);
  bootstrapUrl.username = "app_bootstrap_test";
  bootstrapUrl.password = bootstrapPassword;
  let studentLoginSettings = {};
  if (process.env.APP_PLANET_STUDENT_LOGIN_MODE === "isolated-local-test") {
    if (through !== undefined || process.env.APP_PLANET_STUDENT_AUTH_TTL_SECONDS !== "600") {
      throw new Error("學生登入不可混用歷史升級或不符 TTL 的 runner。");
    }
    await pool.query(`ALTER ROLE app_student_login_runtime PASSWORD '${studentPassword}'`);
    const studentUrl = new URL(adminUrl);
    studentUrl.username = "app_student_login_runtime";
    studentUrl.password = studentPassword;
    const alias = `ap-${randomUUID()}@example.invalid`;
    const adminKey = process.env.APP_PLANET_TEST_AUTH_ADMIN_KEY;
    const authOrigin = process.env.APP_PLANET_AUTH_ORIGIN;
    if (!adminKey || !authOrigin) throw new Error("缺少隔離 Auth 控制設定。");
    const response = await fetch(`${authOrigin}/auth/v1/admin/users`, {
      method: "POST", cache: "no-store", redirect: "error", signal: AbortSignal.timeout(5_000),
      headers: { apikey: adminKey, authorization: `Bearer ${adminKey}`, "content-type": "application/json" },
      body: JSON.stringify({ email: alias, password: randomBytes(48).toString("base64url"), email_confirm: true }),
    });
    const body = await response.json();
    if (!response.ok || typeof body?.id !== "string" ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(body.id)) {
      throw new Error("隔離 dummy Auth 建立失敗。");
    }
    studentLoginSettings = { studentLoginDatabaseUrl: studentUrl.toString(), studentDummyAlias: alias };
    process.stderr.write("StudentDummyVerified=no-product-profile\n");
  }
  process.stdout.write(JSON.stringify({
    applicationDatabaseUrl: appUrl.toString(),
    workerDatabaseUrl: workerUrl.toString(),
    ...studentLoginSettings,
    ...(through === undefined || through >= "0027" ? { bootstrapDatabaseUrl: bootstrapUrl.toString() } : {}),
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
