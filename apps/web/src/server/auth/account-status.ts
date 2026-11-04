import { z } from "zod";
import type { AuthorizationContext } from "../authorization.ts";

// readiness §90：本人帳號狀態的唯一 server 讀取路徑（A-2 登入後判定、A-4 /me、角色頁）。
// 一律在已綁定可信主體的唯讀交易內呼叫 app.current_account_status()；不接受 caller 指定主體。

const roleSchema = z.enum(["student", "teacher", "admin"]);
const accountStatusSchema = z.enum(["pending", "approved", "rejected", "disabled"]);
const schoolStateSchema = z.enum(["unconfirmed", "approved", "withdrawn", "expired"]);

const statusRecordSchema = z.strictObject({
  subject: z.uuid(),
  role: roleSchema,
  status: accountStatusSchema,
  deletion_state: z.enum(["none", "marked", "purging", "purge_failed", "purged"]),
  school_found: z.boolean(),
  school_state: schoolStateSchema.nullable(),
  login_gate: z.boolean(),
  public_deploy_gate: z.boolean(),
  ai_call_gate: z.boolean(),
  teacher_labels: z.array(z.string().max(200).nullable()),
});

export type AccountStatusRecord = z.infer<typeof statusRecordSchema>;
export type AccountRole = z.infer<typeof roleSchema>;
export type AccountStatus = z.infer<typeof accountStatusSchema>;

export type AccountStatusRead =
  | { readonly outcome: "found"; readonly record: AccountStatusRecord }
  | { readonly outcome: "no_profile" }
  | { readonly outcome: "unavailable" };

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// 與 authorization.ts 相同的執行身分檢查：authenticated、唯讀、非 superuser／bypassrls、非 app 物件擁有者。
const statusQuery = `
  SELECT auth.uid()::text AS subject,
    (current_user = 'authenticated'
      AND current_setting('transaction_read_only') = 'on'
      AND NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_roles
        WHERE rolname IN (current_user, session_user) AND (rolsuper OR rolbypassrls)
      )
      AND NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_class AS relation
        JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
        JOIN pg_catalog.pg_roles AS actor ON actor.oid = relation.relowner
        WHERE namespace.nspname = 'app' AND actor.rolname IN (current_user, session_user)
      )
    ) AS actor_valid,
    app.current_account_status() AS status
`;

export async function readCurrentAccountStatus(
  context: AuthorizationContext,
  expectedSubject?: string,
): Promise<AccountStatusRead> {
  if (expectedSubject !== undefined && !uuid.test(expectedSubject)) return { outcome: "unavailable" };
  try {
    return await context.runReadOnly(async (query): Promise<AccountStatusRead> => {
      const { rows } = await query.query(statusQuery);
      if (rows.length !== 1 || typeof rows[0] !== "object" || rows[0] === null) {
        return { outcome: "unavailable" };
      }
      const row = rows[0] as Record<string, unknown>;
      if (typeof row.subject !== "string" || !uuid.test(row.subject) || row.actor_valid !== true) {
        return { outcome: "unavailable" };
      }
      const subject = row.subject.toLowerCase();
      if (expectedSubject !== undefined && subject !== expectedSubject.toLowerCase()) {
        return { outcome: "unavailable" };
      }
      if (row.status === null) return { outcome: "no_profile" };
      const parsed = statusRecordSchema.safeParse(row.status);
      if (!parsed.success || parsed.data.subject.toLowerCase() !== subject) {
        return { outcome: "unavailable" };
      }
      if (parsed.data.role !== "student" && (parsed.data.school_found || parsed.data.school_state !== null ||
          parsed.data.teacher_labels.length !== 0)) {
        return { outcome: "unavailable" };
      }
      return { outcome: "found", record: parsed.data };
    });
  } catch {
    // 不透傳 SQLSTATE、SQL 或 driver 訊息。
    return { outcome: "unavailable" };
  }
}

export type StaffLanding = "teacher_home" | "admin_home" | "account_status";

export type StaffLoginDecision =
  | { readonly kind: "session"; readonly accountStatus: "approved" | "pending" | "rejected"; readonly landing: StaffLanding }
  | { readonly kind: "deny"; readonly code: "invalid_credentials" | "account_unavailable" };

// A-2：只有教師／管理員可沿此入口取得產品 session。學生視同憑證未通過（不揭露帳號類型）；
// 停用與任何刪除狀態不發 session（data-model §2.1 login ✖；不細分原因）。
export function decideStaffLogin(record: AccountStatusRecord): StaffLoginDecision {
  if (record.role === "student") return { kind: "deny", code: "invalid_credentials" };
  if (record.deletion_state !== "none" || record.status === "disabled" || !record.login_gate) {
    return { kind: "deny", code: "account_unavailable" };
  }
  if (record.status === "approved") {
    return { kind: "session", accountStatus: "approved", landing: record.role === "admin" ? "admin_home" : "teacher_home" };
  }
  return { kind: "session", accountStatus: record.status, landing: "account_status" };
}

export const teacherNoticeScope = Object.freeze(["已保存的專案需求、階段草稿、學生確認狀態與任務"] as const);
export const unnamedTeacherLabel = "老師（未設定顯示名稱）";

export type SchoolGateView = {
  readonly state: z.infer<typeof schoolStateSchema>;
  readonly ai_available: boolean;
  readonly public_deploy_available: boolean;
  readonly reason_code?: "school_not_confirmed" | "ai_not_open";
};

export type MeView = {
  readonly role: AccountRole;
  readonly account_status: AccountStatus;
  readonly school_gate: SchoolGateView | null;
  readonly teacher_notice?: {
    readonly teachers: readonly { readonly display_label: string }[];
    readonly scope: readonly string[];
  };
};

export type MeProjection =
  | { readonly kind: "view"; readonly body: MeView }
  | { readonly kind: "problem"; readonly code: "account_unavailable" | "dependency_unavailable" };

// A-4 最小投影。受限狀態只回角色與帳號狀態；學校閘門只適用學生，教職員為 null（§3a.2：不以 null 證明任何學校事實）。
export function projectMe(record: AccountStatusRecord): MeProjection {
  if (record.deletion_state !== "none") return { kind: "problem", code: "account_unavailable" };
  if (record.status !== "approved") {
    return { kind: "view", body: { role: record.role, account_status: record.status, school_gate: null } };
  }
  if (record.role !== "student") {
    if (!record.login_gate) return { kind: "problem", code: "account_unavailable" };
    return { kind: "view", body: { role: record.role, account_status: "approved", school_gate: null } };
  }
  if (!record.school_found || record.school_state === null) return { kind: "problem", code: "dependency_unavailable" };
  const state = record.school_state;
  const reason = state === "unconfirmed"
    ? "school_not_confirmed"
    : state === "withdrawn" || state === "expired"
      ? "ai_not_open"
      : undefined;
  const schoolGate: SchoolGateView = {
    state,
    ai_available: record.ai_call_gate,
    public_deploy_available: record.public_deploy_gate,
    ...(reason ? { reason_code: reason } : {}),
  };
  const body: MeView = {
    role: "student",
    account_status: "approved",
    school_gate: schoolGate,
    ...(record.teacher_labels.length > 0
      ? {
          teacher_notice: {
            teachers: record.teacher_labels.map((label) => ({ display_label: label ?? unnamedTeacherLabel })),
            scope: [...teacherNoticeScope],
          },
        }
      : {}),
  };
  return { kind: "view", body };
}
