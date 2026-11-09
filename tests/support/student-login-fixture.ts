import { randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import type { Pool } from "pg";
import type { SyntheticAuthAccount } from "./real-auth-fixture.ts";

export type SyntheticStudent = SyntheticAuthAccount & { handle: string };
const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export async function createSyntheticStudent(control: Pool): Promise<SyntheticStudent> {
  const email = `ap-${randomUUID()}@example.invalid`;
  // 32 等分字元集，每個 byte 的低五位均勻；不保存可還原登入碼。
  const password = [...randomBytes(10)].map((byte) => alphabet[byte & 31]).join("");
  const handle = `sim-${randomBytes(8).toString("hex")}`;
  const adminKey = process.env.APP_PLANET_TEST_AUTH_ADMIN_KEY;
  const origin = process.env.APP_PLANET_AUTH_ORIGIN;
  if (!adminKey || !origin) throw new Error("缺少學生合成 fixture 控制設定。");
  const response = await fetch(`${origin}/auth/v1/admin/users`, {
    method: "POST", redirect: "error", cache: "no-store", signal: AbortSignal.timeout(5_000),
    headers: { apikey: adminKey, authorization: `Bearer ${adminKey}`, "content-type": "application/json" },
    body: JSON.stringify({ email, password, email_confirm: true }),
  });
  const result = z.object({ id: z.uuid() }).safeParse(await response.json());
  if (!response.ok || !result.success) throw new Error("學生合成 Auth 建立失敗。");
  const id = result.data.id.toLowerCase();
  const schoolId = randomUUID();
  const client = await control.connect();
  try {
    await client.query("BEGIN");
    await client.query(`INSERT INTO app.schools(id,label,approval_state,approval_epoch,created_at,updated_at)
      VALUES ($1,'合成隔離學校','approved',1,now(),now())`, [schoolId]);
    await client.query(`INSERT INTO app.profiles(id,role,status,deletion_state,school_id,handle,status_changed_at)
      VALUES ($1,'student','approved','none',$2,$3,now())`, [id, schoolId, handle]);
    await client.query("INSERT INTO app.student_login_credentials VALUES ($1,$2,1,'active')", [id, email]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally { client.release(); }
  const read = await control.query(`SELECT p.id=$1 AND c.student_id=$1 AND p.handle=$2
    AND c.auth_email_alias=$3 AND c.version=1 AND c.state='active' AS verified
    FROM app.profiles p JOIN app.student_login_credentials c ON c.student_id=p.id WHERE p.id=$1`, [id, handle, email]);
  if (read.rows.length !== 1 || read.rows[0].verified !== true) throw new Error("學生 fixture 提交後 UUID 關聯核對失敗。");
  return { id, email, password, schoolId, handle };
}

export async function removeSyntheticStudent(control: Pool, account: SyntheticStudent): Promise<void> {
  await control.query("DELETE FROM app.student_login_credentials WHERE student_id=$1", [account.id]);
  for (const table of ["stage_draft_idempotency", "stage_records", "project_create_idempotency"]) {
    await control.query(`DELETE FROM app.${table} WHERE project_id IN (SELECT id FROM app.projects WHERE owner_id=$1)`, [account.id]);
  }
  await control.query("DELETE FROM app.projects WHERE owner_id=$1", [account.id]);
  await control.query("DELETE FROM app.profiles WHERE id=$1", [account.id]);
  await control.query("DELETE FROM app.schools WHERE id=$1", [account.schoolId]);
  const { deleteSyntheticAuthAccount } = await import("./real-auth-fixture.ts");
  await deleteSyntheticAuthAccount(account);
}
