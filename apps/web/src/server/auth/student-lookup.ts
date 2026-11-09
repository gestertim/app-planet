import { Pool } from "pg";
import { z } from "zod";

export const studentCredentialSchema = z.strictObject({
  student_id: z.uuid(),
  auth_email_alias: z.string().regex(/^ap-[0-9a-f-]{36}@example[.]invalid$/),
  version: z.number().int().positive(),
  state: z.enum(["active", "revoked"]),
});
export type StudentCredential = z.infer<typeof studentCredentialSchema>;
export type StudentLookup =
  | { readonly outcome: "found"; readonly credential: StudentCredential }
  | { readonly outcome: "missing" }
  | { readonly outcome: "unavailable" };
const pools = new Map<string, Pool>();

export async function lookupStudentLogin(handle: string, env: NodeJS.ProcessEnv): Promise<StudentLookup> {
  const url = env.APP_PLANET_STUDENT_LOGIN_DATABASE_URL;
  if (!url) return { outcome: "unavailable" };
  let pool = pools.get(url);
  if (!pool) {
    pool = new Pool({ connectionString: url, max: 4, connectionTimeoutMillis: 5_000,
      query_timeout: 5_000, statement_timeout: 5_000 });
    pools.set(url, pool);
  }
  try {
    const { rows } = await pool.query(`
      SELECT current_user = 'app_student_login_runtime' AND session_user = current_user
        AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles
          WHERE rolname=current_user AND (rolsuper OR rolbypassrls OR rolinherit
            OR rolcreatedb OR rolcreaterole OR rolreplication OR NOT rolcanlogin))
        AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members
          WHERE member=(SELECT oid FROM pg_catalog.pg_roles WHERE rolname=current_user))
        AS actor_valid, (
          SELECT pg_catalog.jsonb_agg(pg_catalog.to_jsonb(c))
          FROM app.lookup_student_login($1::text) c
        ) AS credentials
    `, [handle]);
    if (rows.length !== 1 || rows[0].actor_valid !== true) return { outcome: "unavailable" };
    if (rows[0].credentials === null) return { outcome: "missing" };
    const parsed = z.array(studentCredentialSchema).length(1).safeParse(rows[0].credentials);
    return parsed.success
      ? { outcome: "found", credential: parsed.data[0]! }
      : { outcome: "unavailable" };
  } catch {
    return { outcome: "unavailable" };
  }
}

export async function closeStudentLookupPools(): Promise<void> {
  await Promise.all([...pools.values()].map((pool) => pool.end()));
  pools.clear();
}
