import { z } from "zod";
import {
  accountStatusSchema,
  compareUtcInstants,
  deletionStateSchema,
  roleSchema,
  schoolApprovalSchema,
  utcInstantSchema,
  type AccessContext,
} from "../contracts/common.ts";
import { decideCapability } from "./account-gate.ts";

// D-06 (a)：有效教師可登入；學校未確認時僅使用受限的帳號準備範圍。
//
// 本檔的純函式只組合「已由資料層查得並傳入」的合成事實：不證明真實歸屬、發起者、綁定、
// 身分核對或期限，不接通任何登入、核發或資料來源。除登入外，缺少操作必需事實一律拒絕。
// 拒絕碼是本機碼，不是 HTTP 碼，也不是 SSE 碼；對外呈現（例如 not_found → 404）由端點決定。

const opaqueIdSchema = z.string().min(1);

export const accountLookupSchema = z.discriminatedUnion("lookup", [
  z
    .object({
      lookup: z.literal("ok"),
      userId: opaqueIdSchema,
      role: roleSchema,
      accountStatus: accountStatusSchema,
      deletionState: deletionStateSchema,
    })
    .strict(),
  z.object({ lookup: z.literal("failed") }).strict(),
]);

// 學校事實：state＝讀取成功；not_provided＝schoolApproval 為 null（不證明任何歸屬或核准）；
// lookup_failed＝查詢失敗（不得被填成 null 或 unconfirmed）。
export const schoolFactSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("state"), approval: schoolApprovalSchema }).strict(),
  z.object({ kind: z.literal("not_provided") }).strict(),
  z.object({ kind: z.literal("lookup_failed") }).strict(),
]);

export const teacherSchoolMembershipSchema = z
  .object({ schoolId: opaqueIdSchema, state: z.enum(["active", "ended"]) })
  .strict();

// M1：教師可多校；有效歸屬集合為 state=active 者。resolved 且集合為空＝未歸屬。
export const teacherAffiliationFactSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("not_provided") }).strict(),
  z.object({ kind: z.literal("lookup_failed") }).strict(),
  z
    .object({ kind: z.literal("resolved"), memberships: z.array(teacherSchoolMembershipSchema) })
    .strict(),
]);

export const schoolReadSchema = z
  .object({ schoolId: opaqueIdSchema, fact: schoolFactSchema })
  .strict();

export type AccountLookup = z.infer<typeof accountLookupSchema>;
export type SchoolFact = z.infer<typeof schoolFactSchema>;
export type TeacherAffiliationFact = z.infer<typeof teacherAffiliationFactSchema>;

export type TeacherPrepDenialCode =
  | "invalid_input"
  | "unknown_field"
  | "account_lookup_failed"
  | "account_unavailable"
  | "role_not_authorized"
  | "affiliation_lookup_failed"
  | "affiliation_not_provided"
  | "teacher_unaffiliated"
  | "school_not_in_affiliation"
  | "school_lookup_failed"
  | "school_state_not_provided"
  | "school_state_not_open"
  | "school_state_unspecified"
  | "not_found"
  | "not_initiator"
  | "not_bound"
  | "student_not_approved"
  | "student_school_unconfirmed"
  | "already_revealed"
  | "reveal_expired"
  | "identity_check_failed";

export type PrepDenial = { allowed: false; code: TeacherPrepDenialCode };

const deny = (code: TeacherPrepDenialCode): PrepDenial => ({ allowed: false, code });

type AccountOk = Extract<AccountLookup, { lookup: "ok" }>;
type AccountCheck = { ok: true; account: AccountOk } | { ok: false; denial: PrepDenial };

function parseAccount(input: unknown): AccountCheck {
  const parsed = accountLookupSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, denial: deny("invalid_input") };
  }
  if (parsed.data.lookup === "failed") {
    return { ok: false, denial: deny("account_lookup_failed") };
  }
  return { ok: true, account: parsed.data };
}

function toAccessContext(account: AccountOk): AccessContext {
  return {
    role: account.role,
    accountStatus: account.accountStatus,
    deletionState: account.deletionState,
    schoolApproval: null,
    aiOnDuty: false,
  };
}

// 帳號準備操作需要 approved 且未刪除的帳號；pending／rejected 只有受限狀態入口，不可操作。
function requireActiveAccount(
  input: unknown,
  roles: ReadonlyArray<AccountOk["role"]>,
): AccountCheck {
  const checked = parseAccount(input);
  if (!checked.ok) {
    return checked;
  }
  const { account } = checked;
  if (!roles.includes(account.role)) {
    return { ok: false, denial: deny("role_not_authorized") };
  }
  if (!decideCapability(toAccessContext(account), "login").allowed) {
    return { ok: false, denial: deny("account_unavailable") };
  }
  if (account.accountStatus !== "approved") {
    return { ok: false, denial: deny("account_unavailable") };
  }
  return checked;
}

function activeSchoolIds(affiliation: TeacherAffiliationFact): string[] | PrepDenial {
  if (affiliation.kind === "lookup_failed") {
    return deny("affiliation_lookup_failed");
  }
  if (affiliation.kind === "not_provided") {
    return deny("affiliation_not_provided");
  }
  return affiliation.memberships
    .filter((membership) => membership.state === "active")
    .map((membership) => membership.schoolId);
}

function requireAffiliatedSchool(
  affiliation: TeacherAffiliationFact,
  schoolId: string,
): PrepDenial | null {
  const active = activeSchoolIds(affiliation);
  if (!Array.isArray(active)) {
    return active;
  }
  if (active.length === 0) {
    return deny("teacher_unaffiliated");
  }
  return active.includes(schoolId) ? null : deny("school_not_in_affiliation");
}

// 學校讀取必須成功且帶有核准狀態；null 與查詢失敗各自拒絕，不被填成 unconfirmed。
function readSchoolState(fact: SchoolFact): PrepDenial | SchoolFactState {
  if (fact.kind === "lookup_failed") {
    return deny("school_lookup_failed");
  }
  if (fact.kind === "not_provided") {
    return deny("school_state_not_provided");
  }
  return { approval: fact.approval };
}
type SchoolFactState = { approval: z.infer<typeof schoolApprovalSchema> };
const isDenial = (value: PrepDenial | SchoolFactState): value is PrepDenial => "allowed" in value;

// ---------------------------------------------------------------------------
// D06-1 教師登入：不依賴學校查詢

export type TeacherLoginDecision =
  | { allowed: true; code: "allowed"; entry: "role_home" | "restricted_status" }
  | PrepDenial;

export function decideTeacherLogin(input: unknown): TeacherLoginDecision {
  const checked = parseAccount(input);
  if (!checked.ok) {
    return checked.denial;
  }
  const { account } = checked;
  if (account.role !== "teacher") {
    return deny("role_not_authorized");
  }
  const decision = decideCapability(toAccessContext(account), "login");
  if (!decision.allowed) {
    return deny("account_unavailable");
  }
  return {
    allowed: true,
    code: "allowed",
    entry: account.accountStatus === "approved" ? "role_home" : "restricted_status",
  };
}

// ---------------------------------------------------------------------------
// D06-2 受限首頁：不含任何學生學習資料

const teacherHomeInputSchema = z
  .object({
    account: z.unknown(),
    affiliation: teacherAffiliationFactSchema,
    schools: z.array(schoolReadSchema),
    hasRevealableCredential: z.boolean(),
  })
  .strict();

export type TeacherHomeSchoolEntry =
  | { school_id: string; status: "known"; approval: z.infer<typeof schoolApprovalSchema> }
  | { school_id: string; status: "not_provided" | "unavailable" };

export type TeacherHomeEntry = "own_requests" | "student_issuance_initiate" | "credential_first_reveal";

export type TeacherHomeResult =
  | {
      kind: "restricted_home";
      view: {
        account_status: "approved";
        affiliation: "resolved" | "unaffiliated" | "lookup_failed" | "not_provided";
        schools: TeacherHomeSchoolEntry[];
        entries: TeacherHomeEntry[];
      };
    }
  | { kind: "status_only"; account_status: "pending" | "rejected" }
  | { kind: "denied"; code: TeacherPrepDenialCode };

export function buildTeacherAccountHome(input: unknown): TeacherHomeResult {
  const parsed = teacherHomeInputSchema.safeParse(input);
  if (!parsed.success) {
    return { kind: "denied", code: "invalid_input" };
  }
  const login = decideTeacherLogin(parsed.data.account);
  if (!login.allowed) {
    return { kind: "denied", code: login.code };
  }
  const account = parseAccount(parsed.data.account);
  if (!account.ok) {
    return { kind: "denied", code: "invalid_input" };
  }
  if (login.entry === "restricted_status") {
    return {
      kind: "status_only",
      account_status: account.account.accountStatus as "pending" | "rejected",
    };
  }

  const { affiliation, schools, hasRevealableCredential } = parsed.data;
  const entries: TeacherHomeEntry[] = ["own_requests"];
  const entrySchools: TeacherHomeSchoolEntry[] = [];
  let affiliationState: "resolved" | "unaffiliated" | "lookup_failed" | "not_provided";

  if (affiliation.kind === "resolved") {
    const active = affiliation.memberships
      .filter((membership) => membership.state === "active")
      .map((membership) => membership.schoolId);
    affiliationState = active.length === 0 ? "unaffiliated" : "resolved";
    let canInitiate = false;
    for (const schoolId of active) {
      const read = schools.find((school) => school.schoolId === schoolId);
      if (read === undefined || read.fact.kind === "lookup_failed") {
        entrySchools.push({ school_id: schoolId, status: "unavailable" });
      } else if (read.fact.kind === "not_provided") {
        entrySchools.push({ school_id: schoolId, status: "not_provided" });
      } else {
        entrySchools.push({ school_id: schoolId, status: "known", approval: read.fact.approval });
        if (read.fact.approval === "unconfirmed" || read.fact.approval === "approved") {
          canInitiate = true;
        }
      }
    }
    if (canInitiate) {
      entries.push("student_issuance_initiate");
    }
  } else {
    affiliationState = affiliation.kind;
  }
  if (hasRevealableCredential) {
    entries.push("credential_first_reveal");
  }

  return {
    kind: "restricted_home",
    view: {
      account_status: "approved",
      affiliation: affiliationState,
      schools: entrySchools,
      entries,
    },
  };
}

// ---------------------------------------------------------------------------
// D06-3 查看自己發起的申請：僅最小狀態欄位（handle、note_for_user 尚未選定，不回傳）

const credentialFactSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("none") }).strict(),
  z.object({ state: z.literal("pending_reveal"), revealExpiresAt: utcInstantSchema }).strict(),
  z.object({ state: z.literal("active") }).strict(),
]);

// 資料列可帶其他欄位（loose）；輸出一律明確建構，不 spread 資料列（D-30）。
const issuanceRequestRowSchema = z.looseObject({
  studentId: opaqueIdSchema,
  displayLabel: z.string(),
  initiatedBy: opaqueIdSchema.nullable(),
  accountStatus: accountStatusSchema,
  deletionState: deletionStateSchema,
  credential: credentialFactSchema,
});

export type OwnIssuanceRequestView = {
  student_id: string;
  display_label: string;
  account_status: "pending" | "approved" | "rejected";
  credential_state: "pending_reveal" | "active" | null;
  reveal_expires_at: string | null;
};

const ownRequestInputSchema = z
  .object({ account: z.unknown(), request: z.unknown() })
  .strict();
const ownRequestListInputSchema = z
  .object({ account: z.unknown(), requests: z.array(z.unknown()) })
  .strict();

type RequestRow = z.infer<typeof issuanceRequestRowSchema>;

function projectOwnRequest(userId: string, row: RequestRow): OwnIssuanceRequestView | null {
  if (
    row.initiatedBy !== userId ||
    row.deletionState !== "none" ||
    row.accountStatus === "disabled"
  ) {
    return null;
  }
  return {
    student_id: row.studentId,
    display_label: row.displayLabel,
    account_status: row.accountStatus,
    credential_state: row.credential.state === "none" ? null : row.credential.state,
    reveal_expires_at:
      row.credential.state === "pending_reveal" ? row.credential.revealExpiresAt : null,
  };
}

export type OwnIssuanceRequestDecision =
  | { allowed: true; code: "allowed"; view: OwnIssuanceRequestView }
  | PrepDenial;

export function decideOwnIssuanceRequestView(input: unknown): OwnIssuanceRequestDecision {
  const parsed = ownRequestInputSchema.safeParse(input);
  if (!parsed.success) {
    return deny("invalid_input");
  }
  const checked = requireActiveAccount(parsed.data.account, ["teacher"]);
  if (!checked.ok) {
    return checked.denial;
  }
  const row = issuanceRequestRowSchema.safeParse(parsed.data.request);
  if (!row.success) {
    return deny("invalid_input");
  }
  const view = projectOwnRequest(checked.account.userId, row.data);
  return view === null ? deny("not_found") : { allowed: true, code: "allowed", view };
}

export type OwnIssuanceRequestListDecision =
  | { allowed: true; code: "allowed"; views: OwnIssuanceRequestView[] }
  | PrepDenial;

export function listOwnIssuanceRequests(input: unknown): OwnIssuanceRequestListDecision {
  const parsed = ownRequestListInputSchema.safeParse(input);
  if (!parsed.success) {
    return deny("invalid_input");
  }
  const checked = requireActiveAccount(parsed.data.account, ["teacher"]);
  if (!checked.ok) {
    return checked.denial;
  }
  const views: OwnIssuanceRequestView[] = [];
  for (const candidate of parsed.data.requests) {
    const row = issuanceRequestRowSchema.safeParse(candidate);
    if (!row.success) {
      return deny("invalid_input");
    }
    const view = projectOwnRequest(checked.account.userId, row.data);
    if (view !== null) {
      views.push(view);
    }
  }
  return { allowed: true, code: "allowed", views };
}

// ---------------------------------------------------------------------------
// D06-4 發起核發

const initiateBodySchema = z
  .object({
    handle: z.string().min(1),
    display_label: z.string().optional(),
    school_id: opaqueIdSchema,
    note: z.string().optional(),
  })
  .strict();

const initiateInputSchema = z
  .object({
    account: z.unknown(),
    body: z.unknown(),
    affiliation: teacherAffiliationFactSchema,
    targetSchool: schoolReadSchema,
  })
  .strict();

export type StudentIssuanceInitiateDecision =
  | {
      allowed: true;
      code: "allowed";
      initiatedBy: string;
      schoolId: string;
      mustStillEnforce: readonly string[];
    }
  | PrepDenial;

const initiateMustStillEnforce = [
  "admin_approval",
  "rate_limit",
  "idempotency_key",
  "affiliation_truth",
  "handle_unique",
  "real_name_pattern_check",
  "audit",
] as const;

export function decideStudentIssuanceInitiate(input: unknown): StudentIssuanceInitiateDecision {
  const parsed = initiateInputSchema.safeParse(input);
  if (!parsed.success) {
    return deny("invalid_input");
  }
  const checked = requireActiveAccount(parsed.data.account, ["teacher"]);
  if (!checked.ok) {
    return checked.denial;
  }

  const body = initiateBodySchema.safeParse(parsed.data.body);
  if (!body.success) {
    const unknownField = body.error.issues.some((issue) => issue.code === "unrecognized_keys");
    return deny(unknownField ? "unknown_field" : "invalid_input");
  }
  if (parsed.data.targetSchool.schoolId !== body.data.school_id) {
    return deny("invalid_input");
  }

  const affiliationDenial = requireAffiliatedSchool(parsed.data.affiliation, body.data.school_id);
  if (affiliationDenial !== null) {
    return affiliationDenial;
  }

  const school = readSchoolState(parsed.data.targetSchool.fact);
  if (isDenial(school)) {
    return school;
  }
  if (school.approval !== "unconfirmed" && school.approval !== "approved") {
    return deny("school_state_not_open");
  }

  return {
    allowed: true,
    code: "allowed",
    initiatedBy: checked.account.userId,
    schoolId: body.data.school_id,
    mustStillEnforce: initiateMustStillEnforce,
  };
}

// ---------------------------------------------------------------------------
// D06-5 首次領取登入碼：保留 A-8 全部條件；純函式不產生、不回傳登入碼

const revealInputSchema = z
  .object({
    account: z.unknown(),
    now: utcInstantSchema,
    student: z
      .object({
        schoolId: opaqueIdSchema,
        initiatedBy: opaqueIdSchema.nullable(),
        accountStatus: accountStatusSchema,
        deletionState: deletionStateSchema,
        credential: credentialFactSchema,
      })
      .strict(),
    affiliation: teacherAffiliationFactSchema,
    targetSchool: schoolReadSchema,
  })
  .strict();

export type FirstCredentialRevealDecision =
  | { allowed: true; code: "allowed"; mustStillEnforce: readonly string[] }
  | PrepDenial;

const revealMustStillEnforce = [
  "atomic_single_reveal",
  "idempotency_key",
  "no_store",
  "no_plaintext_in_logs",
  "audit",
] as const;

export function decideFirstCredentialReveal(input: unknown): FirstCredentialRevealDecision {
  const parsed = revealInputSchema.safeParse(input);
  if (!parsed.success) {
    return deny("invalid_input");
  }
  const checked = requireActiveAccount(parsed.data.account, ["teacher"]);
  if (!checked.ok) {
    return checked.denial;
  }
  const { student, now, affiliation, targetSchool } = parsed.data;

  if (student.initiatedBy !== checked.account.userId) {
    return deny("not_initiator");
  }
  if (
    student.accountStatus !== "approved" ||
    student.deletionState !== "none" ||
    student.credential.state === "none"
  ) {
    return deny("student_not_approved");
  }
  if (student.credential.state === "active") {
    return deny("already_revealed");
  }

  // 到期時刻起視為過期（fail-closed 工程假設；契約未明定邊界）；不延長、不重新顯示。
  const order = compareUtcInstants(now, student.credential.revealExpiresAt);
  if (order === null) {
    return deny("invalid_input");
  }
  if (order >= 0) {
    return deny("reveal_expired");
  }

  if (targetSchool.schoolId !== student.schoolId) {
    return deny("invalid_input");
  }
  const affiliationDenial = requireAffiliatedSchool(affiliation, student.schoolId);
  if (affiliationDenial !== null) {
    return affiliationDenial;
  }

  const school = readSchoolState(targetSchool.fact);
  if (isDenial(school)) {
    return school;
  }
  // withdrawn／expired 的領碼行為契約尚未明定：維持 fail-closed，不是新政策，也不擴大。
  if (school.approval !== "unconfirmed" && school.approval !== "approved") {
    return deny("school_state_unspecified");
  }

  return { allowed: true, code: "allowed", mustStillEnforce: revealMustStillEnforce };
}

// ---------------------------------------------------------------------------
// D06-6 重發登入碼：教師採 R-a（學生學校 unconfirmed 時拒絕）；管理員依既有規則

const reissueInputSchema = z
  .object({
    account: z.unknown(),
    student: z
      .object({
        accountStatus: accountStatusSchema,
        deletionState: deletionStateSchema,
        school: schoolFactSchema,
      })
      .strict(),
    bindingActive: z.boolean(),
    identityCheckPassed: z.boolean(),
  })
  .strict();

export type CredentialReissueDecision =
  | { allowed: true; code: "allowed"; mustStillEnforce: readonly string[] }
  | PrepDenial;

const reissueMustStillEnforce = [
  "binding_truth",
  "identity_check_truth",
  "atomic_reissue",
  "old_session_invalidation",
  "rate_limit",
  "idempotency_key",
  "audit",
] as const;

export function decideCredentialReissue(input: unknown): CredentialReissueDecision {
  const parsed = reissueInputSchema.safeParse(input);
  if (!parsed.success) {
    return deny("invalid_input");
  }
  const checked = requireActiveAccount(parsed.data.account, ["teacher", "admin"]);
  if (!checked.ok) {
    return checked.denial;
  }
  const { student, bindingActive, identityCheckPassed } = parsed.data;
  const isTeacher = checked.account.role === "teacher";

  // 先判斷綁定，未綁定教師不得由後續回應推知學生狀態。
  if (isTeacher && !bindingActive) {
    return deny("not_bound");
  }
  if (student.accountStatus !== "approved" || student.deletionState !== "none") {
    return deny("student_not_approved");
  }
  if (!identityCheckPassed) {
    return deny("identity_check_failed");
  }
  if (isTeacher) {
    const school = readSchoolState(student.school);
    if (isDenial(school)) {
      return school;
    }
    if (school.approval === "unconfirmed") {
      return deny("student_school_unconfirmed");
    }
  }
  return { allowed: true, code: "allowed", mustStillEnforce: reissueMustStillEnforce };
}
