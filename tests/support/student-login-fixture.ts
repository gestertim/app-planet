import { randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import { Client, type Pool } from "pg";
import type { SyntheticAuthAccount } from "./real-auth-fixture.ts";

export type SyntheticStudent = SyntheticAuthAccount & { handle: string };
const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

async function compensateStudentRows(control: Pool, account: SyntheticStudent): Promise<void> {
  // 不重用建立交易的連線；COMMIT 回應遺失不代表交易已回滾。
  const client = new Client(control.options);
  try {
    await client.connect();
    await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
    // 等待原交易真正結束，再以新 statement snapshot 判斷 COMMIT 結果。
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [account.schoolId]);
    const read = await client.query<{ school: boolean; profile: boolean; credential: boolean; owned: boolean }>(`SELECT
      EXISTS (SELECT 1 FROM app.schools WHERE id=$2) AS school,
      EXISTS (SELECT 1 FROM app.profiles WHERE id=$1) AS profile,
      EXISTS (SELECT 1 FROM app.student_login_credentials WHERE student_id=$1) AS credential,
      EXISTS (SELECT 1 FROM app.schools s JOIN app.profiles p ON p.school_id=s.id
        JOIN app.student_login_credentials c ON c.student_id=p.id
        WHERE p.id=$1 AND s.id=$2 AND p.handle=$3 AND c.auth_email_alias=$4) AS owned`,
    [account.id, account.schoolId, account.handle, account.email]);
    const row = read.rows[0];
    if (row.school || row.profile || row.credential) {
      if (row.owned !== true) throw new Error("學生 fixture 補償資源關聯無法確認。");
      for (const [text, values] of [
        ["DELETE FROM app.student_login_credentials WHERE student_id=$1 AND auth_email_alias=$2", [account.id, account.email]],
        ["DELETE FROM app.profiles WHERE id=$1 AND school_id=$2 AND handle=$3", [account.id, account.schoolId, account.handle]],
        ["DELETE FROM app.schools WHERE id=$1", [account.schoolId]],
      ] as const) {
        const deleted = await client.query(text, [...values]);
        if (deleted.rowCount !== 1) throw new Error("學生 fixture 補償刪除筆數不符。");
      }
    }
    await client.query("COMMIT");
  } finally {
    // 未提交的補償交易隨專用連線結束回滾，避免清理失敗變成部分刪除。
    await client.end();
  }
}

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
  const account = { id, email, password, schoolId, handle };
  const transaction: { state: "not_started" | "open" | "rolled_back" | "committed" | "unknown" } = { state: "not_started" };
  try {
    const client = await control.connect();
    let reusable = false;
    try {
      await client.query("BEGIN");
      transaction.state = "open";
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [schoolId]);
      await client.query(`INSERT INTO app.schools(id,label,approval_state,approval_epoch,created_at,updated_at)
        VALUES ($1,'合成隔離學校','approved',1,now(),now())`, [schoolId]);
      await client.query(`INSERT INTO app.profiles(id,role,status,deletion_state,school_id,handle,status_changed_at)
        VALUES ($1,'student','approved','none',$2,$3,now())`, [id, schoolId, handle]);
      await client.query("INSERT INTO app.student_login_credentials VALUES ($1,$2,1,'active')", [id, email]);
      transaction.state = "unknown";
      await client.query("COMMIT");
      transaction.state = "committed";
      reusable = true;
    } catch (error) {
      if (transaction.state === "open") {
        try {
          await client.query("ROLLBACK");
          transaction.state = "rolled_back";
          reusable = true;
        } catch {
          transaction.state = "unknown";
        }
      }
      throw error;
    } finally { client.release(!reusable); }
    const read = await control.query(`SELECT p.id=$1 AND c.student_id=$1 AND p.handle=$2
      AND c.auth_email_alias=$3 AND c.version=1 AND c.state='active' AS verified
      FROM app.profiles p JOIN app.student_login_credentials c ON c.student_id=p.id WHERE p.id=$1`, [id, handle, email]);
    if (read.rows.length !== 1 || read.rows[0].verified !== true) throw new Error("學生 fixture 提交後 UUID 關聯核對失敗。");
    return account;
  } catch (error) {
    const cleanupErrors: Error[] = [];
    const unconfirmedResources: string[] = [];
    if (transaction.state !== "not_started" && transaction.state !== "rolled_back") {
      try {
        await compensateStudentRows(control, account);
      } catch {
        cleanupErrors.push(new Error("學生 fixture DB 補償未能確認完成。"));
        unconfirmedResources.push(`app.student_login_credentials:${id}`, `app.profiles:${id}`, `app.schools:${schoolId}`);
      }
    }
    try {
      const { deleteSyntheticAuthAccount } = await import("./real-auth-fixture.ts");
      await deleteSyntheticAuthAccount(account);
    } catch {
      cleanupErrors.push(new Error("學生 fixture Auth 補償未能確認完成。"));
      unconfirmedResources.push(`auth.users:${id}`);
    }
    if (cleanupErrors.length > 0) {
      throw Object.assign(new AggregateError([error, ...cleanupErrors],
        "學生 fixture 建立失敗，補償尚未確認完成。", { cause: error }), {
        transactionState: transaction.state,
        unconfirmedResources,
      });
    }
    throw error;
  }
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
