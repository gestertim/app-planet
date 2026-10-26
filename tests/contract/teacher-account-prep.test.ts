import { describe, expect, it } from "vitest";
import {
  buildTeacherAccountHome,
  canAccessRoleHome,
  decideCapability,
  decideCredentialReissue,
  decideFirstCredentialReveal,
  decideOwnIssuanceRequestView,
  decideStudentIssuanceInitiate,
  decideTeacherLogin,
  listOwnIssuanceRequests,
  type AccessContext,
} from "@app-planet/core";

// 全部為合成事實：純函式只組合已傳入的事實，不證明真實歸屬、發起者、綁定、身分核對或期限。
const teacher = (overrides: Record<string, unknown> = {}) => ({
  lookup: "ok",
  userId: "teacher-a",
  role: "teacher",
  accountStatus: "approved",
  deletionState: "none",
  ...overrides,
});

const approvedSchool = (approval: string) => ({ kind: "state", approval });
const notProvided = { kind: "not_provided" } as const;
const lookupFailed = { kind: "lookup_failed" } as const;

const resolved = (...memberships: Array<[string, "active" | "ended"]>) => ({
  kind: "resolved",
  memberships: memberships.map(([schoolId, state]) => ({ schoolId, state })),
});

const deletionStates = ["marked", "purging", "purge_failed", "purged"] as const;

describe("D-06 教師登入：不依賴學校查詢", () => {
  it("approved 教師登入進入角色首頁，pending／rejected 只進受限狀態入口", () => {
    expect(decideTeacherLogin(teacher())).toEqual({
      allowed: true,
      code: "allowed",
      entry: "role_home",
    });
    for (const accountStatus of ["pending", "rejected"]) {
      expect(decideTeacherLogin(teacher({ accountStatus }))).toEqual({
        allowed: true,
        code: "allowed",
        entry: "restricted_status",
      });
    }
  });

  it("disabled 與所有刪除狀態一律拒絕", () => {
    expect(decideTeacherLogin(teacher({ accountStatus: "disabled" }))).toEqual({
      allowed: false,
      code: "account_unavailable",
    });
    for (const deletionState of deletionStates) {
      for (const accountStatus of ["approved", "pending", "rejected"]) {
        expect(decideTeacherLogin(teacher({ deletionState, accountStatus }))).toEqual({
          allowed: false,
          code: "account_unavailable",
        });
      }
    }
  });

  it("帳號／身分查詢失敗一律拒絕，不當成任何帳號狀態", () => {
    expect(decideTeacherLogin({ lookup: "failed" })).toEqual({
      allowed: false,
      code: "account_lookup_failed",
    });
  });

  it("登入輸入不接受學校事實：學校查詢失敗、null、unconfirmed 都不是登入判定輸入", () => {
    for (const school of [lookupFailed, notProvided, approvedSchool("unconfirmed")]) {
      expect(decideTeacherLogin(teacher({ school })).allowed).toBe(false);
      expect(decideTeacherLogin(teacher({ school })).code).toBe("invalid_input");
    }
    expect(decideTeacherLogin(teacher())).toMatchObject({ allowed: true });
  });

  it("與既有 decideCapability('login') 對所有帳號／刪除狀態一致，不重做規則", () => {
    for (const accountStatus of ["pending", "approved", "rejected", "disabled"] as const) {
      for (const deletionState of ["none", ...deletionStates] as const) {
        const context: AccessContext = {
          role: "teacher",
          accountStatus,
          deletionState,
          schoolApproval: null,
          aiOnDuty: false,
        };
        expect(decideTeacherLogin(teacher({ accountStatus, deletionState })).allowed).toBe(
          decideCapability(context, "login").allowed,
        );
      }
    }
  });

  it("非教師角色與畸形輸入 fail-closed", () => {
    expect(decideTeacherLogin(teacher({ role: "student" }))).toEqual({
      allowed: false,
      code: "role_not_authorized",
    });
    expect(decideTeacherLogin(teacher({ role: "admin" }))).toEqual({
      allowed: false,
      code: "role_not_authorized",
    });
    expect(decideTeacherLogin(teacher({ role: "owner" }))).toEqual({
      allowed: false,
      code: "invalid_input",
    });
    expect(decideTeacherLogin(null)).toEqual({ allowed: false, code: "invalid_input" });
    expect(decideTeacherLogin(teacher({ userId: "" })).code).toBe("invalid_input");
  });
});

describe("D-06 受限首頁", () => {
  const home = (overrides: Record<string, unknown> = {}) =>
    buildTeacherAccountHome({
      account: teacher(),
      affiliation: resolved(["school-a", "active"], ["school-b", "active"], ["school-c", "ended"]),
      schools: [
        { schoolId: "school-a", fact: approvedSchool("unconfirmed") },
        { schoolId: "school-b", fact: lookupFailed },
        { schoolId: "school-c", fact: approvedSchool("approved") },
      ],
      hasRevealableCredential: false,
      ...overrides,
    });

  it("只呈現帳號狀態、可取得的學校狀態、自己申請入口與符合條件的帳號準備入口", () => {
    expect(home()).toEqual({
      kind: "restricted_home",
      view: {
        account_status: "approved",
        affiliation: "resolved",
        schools: [
          { school_id: "school-a", status: "known", approval: "unconfirmed" },
          { school_id: "school-b", status: "unavailable" },
        ],
        entries: ["own_requests", "student_issuance_initiate"],
      },
    });
  });

  it("首頁不含學生專案、對話、檔案、活動等學習資料鍵", () => {
    const result = home({ hasRevealableCredential: true });
    expect(result.kind).toBe("restricted_home");
    const serialized = JSON.stringify(result);
    for (const key of ["project", "conversation", "file", "activity", "student_id", "login_code"]) {
      expect(serialized).not.toContain(key);
    }
    expect(result).toMatchObject({
      view: { entries: ["own_requests", "student_issuance_initiate", "credential_first_reveal"] },
    });
  });

  it("學校讀取失敗明示不可取得，不填成 unconfirmed 或其他預設值，也不開放需學校資料的入口", () => {
    const result = home({
      affiliation: resolved(["school-b", "active"]),
      schools: [{ schoolId: "school-b", fact: lookupFailed }],
    });
    expect(result).toEqual({
      kind: "restricted_home",
      view: {
        account_status: "approved",
        affiliation: "resolved",
        schools: [{ school_id: "school-b", status: "unavailable" }],
        entries: ["own_requests"],
      },
    });
  });

  it("缺少該校讀取結果同樣呈現為不可取得，不虛構預設值", () => {
    const result = home({ affiliation: resolved(["school-a", "active"]), schools: [] });
    expect(result).toMatchObject({
      view: { schools: [{ school_id: "school-a", status: "unavailable" }], entries: ["own_requests"] },
    });
  });

  it("null、未歸屬、查詢失敗各自分開表達", () => {
    const nullState = home({
      affiliation: resolved(["school-a", "active"]),
      schools: [{ schoolId: "school-a", fact: notProvided }],
    });
    expect(nullState).toMatchObject({
      view: {
        schools: [{ school_id: "school-a", status: "not_provided" }],
        entries: ["own_requests"],
      },
    });

    const unaffiliated = home({ affiliation: resolved(["school-z", "ended"]), schools: [] });
    expect(unaffiliated).toMatchObject({
      view: { affiliation: "unaffiliated", schools: [], entries: ["own_requests"] },
    });

    const affiliationFailed = home({ affiliation: lookupFailed, schools: [] });
    expect(affiliationFailed).toMatchObject({
      view: { affiliation: "lookup_failed", schools: [], entries: ["own_requests"] },
    });

    const affiliationNull = home({ affiliation: notProvided, schools: [] });
    expect(affiliationNull).toMatchObject({
      view: { affiliation: "not_provided", schools: [], entries: ["own_requests"] },
    });
  });

  it("withdrawn／expired 的歸屬學校可見狀態，但不提供發起入口（暫不開放）", () => {
    for (const approval of ["withdrawn", "expired"]) {
      expect(
        home({
          affiliation: resolved(["school-a", "active"]),
          schools: [{ schoolId: "school-a", fact: approvedSchool(approval) }],
        }),
      ).toMatchObject({
        view: {
          schools: [{ school_id: "school-a", status: "known", approval }],
          entries: ["own_requests"],
        },
      });
    }
  });

  it("pending／rejected 只得狀態入口，disabled／刪除／查詢失敗拒絕，且不洩漏學校資料", () => {
    for (const accountStatus of ["pending", "rejected"]) {
      expect(home({ account: teacher({ accountStatus }) })).toEqual({
        kind: "status_only",
        account_status: accountStatus,
      });
    }
    expect(home({ account: teacher({ accountStatus: "disabled" }) })).toEqual({
      kind: "denied",
      code: "account_unavailable",
    });
    expect(home({ account: teacher({ deletionState: "marked" }) })).toEqual({
      kind: "denied",
      code: "account_unavailable",
    });
    expect(home({ account: { lookup: "failed" } })).toEqual({
      kind: "denied",
      code: "account_lookup_failed",
    });
    expect(home({ account: teacher({ role: "student" }) })).toEqual({
      kind: "denied",
      code: "role_not_authorized",
    });
    expect(home({ affiliation: "bad" })).toEqual({ kind: "denied", code: "invalid_input" });
  });

  it("canAccessRoleHome 為 true 不代表可讀學生資料：教師對任何學校狀態的學習資料能力仍一律拒絕", () => {
    for (const schoolApproval of [null, "unconfirmed", "approved", "withdrawn", "expired"] as const) {
      const context: AccessContext = {
        role: "teacher",
        accountStatus: "approved",
        deletionState: "none",
        schoolApproval,
        aiOnDuty: true,
      };
      expect(canAccessRoleHome(context, "teacher")).toBe(true);
      for (const capability of [
        "read_saved_content",
        "edit_saved_content",
        "download_own_results",
        "ai_call",
        "submit_for_review",
        "public_deploy",
      ]) {
        expect(decideCapability(context, capability)).toEqual({
          allowed: false,
          code: "role_not_authorized",
        });
      }
    }
  });
});

describe("D-06 查看自己發起的申請", () => {
  const row = (overrides: Record<string, unknown> = {}) => ({
    studentId: "student-1",
    displayLabel: "合成暱稱",
    initiatedBy: "teacher-a",
    accountStatus: "pending",
    deletionState: "none",
    credential: { state: "none" },
    ...overrides,
  });

  it("只回傳自己發起申請的最小狀態欄位，不含 handle、note_for_user、登入碼或學習資料", () => {
    const result = decideOwnIssuanceRequestView({
      account: teacher(),
      request: row({
        accountStatus: "approved",
        credential: { state: "pending_reveal", revealExpiresAt: "2026-10-26T02:00:00Z" },
        handle: "synthetic-handle",
        noteForUser: "合成退件說明",
        login_code: "SYNTHETIC",
        projects: [{ id: "p1" }],
      }),
    });
    expect(result).toEqual({
      allowed: true,
      code: "allowed",
      view: {
        student_id: "student-1",
        display_label: "合成暱稱",
        account_status: "approved",
        credential_state: "pending_reveal",
        reveal_expires_at: "2026-10-26T02:00:00Z",
      },
    });
  });

  it("尚無憑證與已啟用憑證的欄位表達", () => {
    expect(decideOwnIssuanceRequestView({ account: teacher(), request: row() })).toMatchObject({
      view: { account_status: "pending", credential_state: null, reveal_expires_at: null },
    });
    expect(
      decideOwnIssuanceRequestView({
        account: teacher(),
        request: row({ accountStatus: "approved", credential: { state: "active" } }),
      }),
    ).toMatchObject({
      view: { credential_state: "active", reveal_expires_at: null },
    });
  });

  it("非本人發起（其他教師、管理員）一律 not_found，不洩漏存在", () => {
    for (const initiatedBy of ["teacher-b", "admin-1", null]) {
      expect(
        decideOwnIssuanceRequestView({ account: teacher(), request: row({ initiatedBy }) }),
      ).toEqual({ allowed: false, code: "not_found" });
    }
  });

  it("學生被停用或標記刪除後，不依發起關係顯示", () => {
    for (const patch of [
      { accountStatus: "disabled" },
      { deletionState: "marked" },
      { deletionState: "purged" },
    ]) {
      expect(
        decideOwnIssuanceRequestView({ account: teacher(), request: row(patch) }),
      ).toEqual({ allowed: false, code: "not_found" });
    }
  });

  it("學校狀態不影響讀取自己的申請狀態（輸入也不接受學校事實）", () => {
    expect(
      decideOwnIssuanceRequestView({ account: teacher(), request: row() }).allowed,
    ).toBe(true);
    expect(
      decideOwnIssuanceRequestView({
        account: teacher(),
        request: row(),
        school: lookupFailed,
      }),
    ).toEqual({ allowed: false, code: "invalid_input" });
  });

  it("教師帳號層條件：pending／rejected／disabled／刪除／查詢失敗皆拒絕", () => {
    for (const patch of [
      { accountStatus: "pending" },
      { accountStatus: "rejected" },
      { accountStatus: "disabled" },
      { deletionState: "marked" },
    ]) {
      expect(
        decideOwnIssuanceRequestView({ account: teacher(patch), request: row() }),
      ).toEqual({ allowed: false, code: "account_unavailable" });
    }
    expect(
      decideOwnIssuanceRequestView({ account: { lookup: "failed" }, request: row() }),
    ).toEqual({ allowed: false, code: "account_lookup_failed" });
  });

  it("列表只含自己發起的申請並保留順序", () => {
    const result = listOwnIssuanceRequests({
      account: teacher(),
      requests: [
        row({ studentId: "s1" }),
        row({ studentId: "s2", initiatedBy: "teacher-b" }),
        row({ studentId: "s3", accountStatus: "disabled" }),
        row({ studentId: "s4" }),
      ],
    });
    expect(result).toMatchObject({ allowed: true });
    expect(
      result.allowed ? result.views.map((view) => view.student_id) : null,
    ).toEqual(["s1", "s4"]);
    expect(
      listOwnIssuanceRequests({ account: teacher({ accountStatus: "disabled" }), requests: [] }),
    ).toEqual({ allowed: false, code: "account_unavailable" });
  });

  it("期限欄位必須為大寫 Z 的 UTC 表示", () => {
    for (const revealExpiresAt of [
      "2026-10-26T02:00:00+00:00",
      "2026-10-26T02:00:00z",
      "2026-10-26T02:00:00",
    ]) {
      expect(
        decideOwnIssuanceRequestView({
          account: teacher(),
          request: row({ accountStatus: "approved", credential: { state: "pending_reveal", revealExpiresAt } }),
        }),
      ).toEqual({ allowed: false, code: "invalid_input" });
    }
  });
});

describe("D-06 發起核發", () => {
  const body = (overrides: Record<string, unknown> = {}) => ({
    handle: "synthetic-handle",
    display_label: "合成暱稱",
    school_id: "school-b",
    note: "合成備註",
    ...overrides,
  });
  const initiate = (overrides: Record<string, unknown> = {}) =>
    decideStudentIssuanceInitiate({
      account: teacher(),
      body: body(),
      affiliation: resolved(["school-a", "active"], ["school-b", "active"]),
      targetSchool: { schoolId: "school-b", fact: approvedSchool("unconfirmed") },
      ...overrides,
    });

  it("有效歸屬內、學校 unconfirmed／approved 皆可發起；initiated_by 由伺服器身分決定", () => {
    for (const approval of ["unconfirmed", "approved"]) {
      expect(
        initiate({ targetSchool: { schoolId: "school-b", fact: approvedSchool(approval) } }),
      ).toMatchObject({
        allowed: true,
        code: "allowed",
        initiatedBy: "teacher-a",
        schoolId: "school-b",
      });
    }
  });

  it("管理員批准、限流、冪等與其他原條件不豁免", () => {
    const result = initiate();
    expect(result.allowed).toBe(true);
    if (result.allowed) {
      expect(result.mustStillEnforce).toEqual(
        expect.arrayContaining([
          "admin_approval",
          "rate_limit",
          "idempotency_key",
          "affiliation_truth",
          "handle_unique",
          "real_name_pattern_check",
        ]),
      );
    }
  });

  it("請求本文自帶 initiated_by 或任何未知欄位一律拒絕（unknown_field），不取用", () => {
    for (const extra of [
      { initiated_by: "teacher-b" },
      { initiatedBy: "teacher-b" },
      { email: "synthetic@example.invalid" },
    ]) {
      expect(initiate({ body: body(extra) })).toEqual({ allowed: false, code: "unknown_field" });
    }
  });

  it("缺少必要欄位或型別錯誤拒絕為 invalid_input", () => {
    expect(initiate({ body: { handle: "h" } })).toEqual({ allowed: false, code: "invalid_input" });
    expect(initiate({ body: body({ school_id: 1 }) })).toEqual({
      allowed: false,
      code: "invalid_input",
    });
    expect(initiate({ body: "text" })).toEqual({ allowed: false, code: "invalid_input" });
  });

  it("自由文字備註中的任何時間字串不受 UTC 規則檢查", () => {
    expect(initiate({ body: body({ note: "2026-10-23T10:00:00+08:00 開班" }) }).allowed).toBe(true);
  });

  it("M1 跨校歸屬：只有有效歸屬集合內的學校可發起，已結束的歸屬不算", () => {
    const affiliation = resolved(["school-a", "active"], ["school-b", "ended"], ["school-c", "active"]);
    expect(
      initiate({
        affiliation,
        body: body({ school_id: "school-c" }),
        targetSchool: { schoolId: "school-c", fact: approvedSchool("approved") },
      }).allowed,
    ).toBe(true);
    expect(initiate({ affiliation })).toEqual({ allowed: false, code: "school_not_in_affiliation" });
    expect(
      initiate({
        body: body({ school_id: "school-z" }),
        targetSchool: { schoolId: "school-z", fact: approvedSchool("approved") },
      }),
    ).toEqual({ allowed: false, code: "school_not_in_affiliation" });
  });

  it("未歸屬、歸屬查詢失敗與歸屬未提供各自拒絕，且碼不同", () => {
    expect(initiate({ affiliation: resolved() })).toEqual({
      allowed: false,
      code: "teacher_unaffiliated",
    });
    expect(initiate({ affiliation: resolved(["school-b", "ended"]) })).toEqual({
      allowed: false,
      code: "teacher_unaffiliated",
    });
    expect(initiate({ affiliation: lookupFailed })).toEqual({
      allowed: false,
      code: "affiliation_lookup_failed",
    });
    expect(initiate({ affiliation: notProvided })).toEqual({
      allowed: false,
      code: "affiliation_not_provided",
    });
  });

  it("目標學校查詢失敗不是 unconfirmed；null 不證明任何核准", () => {
    expect(initiate({ targetSchool: { schoolId: "school-b", fact: lookupFailed } })).toEqual({
      allowed: false,
      code: "school_lookup_failed",
    });
    expect(initiate({ targetSchool: { schoolId: "school-b", fact: notProvided } })).toEqual({
      allowed: false,
      code: "school_state_not_provided",
    });
  });

  it("withdrawn／expired 暫不開放", () => {
    for (const approval of ["withdrawn", "expired"]) {
      expect(
        initiate({ targetSchool: { schoolId: "school-b", fact: approvedSchool(approval) } }),
      ).toEqual({ allowed: false, code: "school_state_not_open" });
    }
  });

  it("學校事實與請求的 school_id 不一致視為缺少必要事實", () => {
    expect(
      initiate({ targetSchool: { schoolId: "school-a", fact: approvedSchool("approved") } }),
    ).toEqual({ allowed: false, code: "invalid_input" });
    expect(initiate({ targetSchool: undefined })).toEqual({ allowed: false, code: "invalid_input" });
  });

  it("教師帳號層：pending／rejected／disabled／刪除／查詢失敗皆拒絕；管理員不適用本教師政策", () => {
    for (const patch of [
      { accountStatus: "pending" },
      { accountStatus: "rejected" },
      { accountStatus: "disabled" },
      { deletionState: "marked" },
    ]) {
      expect(initiate({ account: teacher(patch) })).toEqual({
        allowed: false,
        code: "account_unavailable",
      });
    }
    expect(initiate({ account: { lookup: "failed" } })).toEqual({
      allowed: false,
      code: "account_lookup_failed",
    });
    expect(initiate({ account: teacher({ role: "student" }) }).code).toBe("role_not_authorized");
    expect(initiate({ account: teacher({ role: "admin" }) }).code).toBe("role_not_authorized");
  });
});

describe("D-06 首次領取登入碼（保留 A-8 全部條件）", () => {
  const reveal = (overrides: Record<string, unknown> = {}) =>
    decideFirstCredentialReveal({
      account: teacher(),
      now: "2026-10-23T03:00:00Z",
      student: {
        schoolId: "school-b",
        initiatedBy: "teacher-a",
        accountStatus: "approved",
        deletionState: "none",
        credential: { state: "pending_reveal", revealExpiresAt: "2026-10-26T03:00:00Z" },
      },
      affiliation: resolved(["school-a", "active"], ["school-b", "active"]),
      targetSchool: { schoolId: "school-b", fact: approvedSchool("unconfirmed") },
      ...overrides,
    });
  const withStudent = (patch: Record<string, unknown>) =>
    reveal({
      student: {
        schoolId: "school-b",
        initiatedBy: "teacher-a",
        accountStatus: "approved",
        deletionState: "none",
        credential: { state: "pending_reveal", revealExpiresAt: "2026-10-26T03:00:00Z" },
        ...patch,
      },
    });

  it("發起教師、學生已批准、期限內、歸屬內；學校 unconfirmed 不單獨阻擋帳號準備", () => {
    expect(reveal()).toMatchObject({ allowed: true, code: "allowed" });
    expect(
      reveal({ targetSchool: { schoolId: "school-b", fact: approvedSchool("approved") } }).allowed,
    ).toBe(true);
  });

  it("純函式不產生也不回傳登入碼；一次性顯示、冪等與日誌去敏仍須資料層強制", () => {
    const result = reveal();
    expect(JSON.stringify(result)).not.toMatch(/login_code|loginCode/);
    expect(result.allowed && result.mustStillEnforce).toEqual(
      expect.arrayContaining(["atomic_single_reveal", "idempotency_key", "no_plaintext_in_logs"]),
    );
  });

  it("非發起教師（即使已綁定）拒絕", () => {
    expect(withStudent({ initiatedBy: "teacher-b" })).toEqual({
      allowed: false,
      code: "not_initiator",
    });
    expect(withStudent({ initiatedBy: null })).toEqual({ allowed: false, code: "not_initiator" });
  });

  it("學生尚未批准、已停用或標記刪除拒絕；憑證尚無或已啟用分別處理", () => {
    expect(withStudent({ accountStatus: "pending" }).code).toBe("student_not_approved");
    expect(withStudent({ accountStatus: "disabled" }).code).toBe("student_not_approved");
    expect(withStudent({ deletionState: "marked" }).code).toBe("student_not_approved");
    expect(withStudent({ credential: { state: "none" } }).code).toBe("student_not_approved");
    expect(withStudent({ credential: { state: "active" } })).toEqual({
      allowed: false,
      code: "already_revealed",
    });
  });

  it("過期拒絕，不自動延長、不重新顯示、不回傳新期限", () => {
    const expired = reveal({ now: "2026-10-26T03:00:01Z" });
    expect(expired).toEqual({ allowed: false, code: "reveal_expired" });
    expect(Object.keys(expired).sort()).toEqual(["allowed", "code"]);
  });

  it("到期時刻起視為過期（fail-closed 工程假設，契約未明定邊界）；等價小數秒不被誤判", () => {
    const expiresAt = (value: string) => ({
      credential: { state: "pending_reveal", revealExpiresAt: value },
    });
    expect(withStudent(expiresAt("2026-10-26T03:00:00Z")).allowed).toBe(true);
    expect(reveal({ now: "2026-10-26T03:00:00Z" }).code).toBe("reveal_expired");
    expect(
      reveal({ now: "2026-10-23T03:00:00.100Z", student: studentWith(expiresAt("2026-10-23T03:00:00.1Z")) })
        .code,
    ).toBe("reveal_expired");
    expect(
      reveal({ now: "2026-10-23T03:00:00.0999Z", student: studentWith(expiresAt("2026-10-23T03:00:00.1Z")) })
        .allowed,
    ).toBe(true);
  });

  it("now 與期限只接受大寫 Z 的 UTC 表示，不接受 +00:00、小寫 z 或無偏移", () => {
    for (const now of ["2026-10-23T03:00:00+00:00", "2026-10-23T03:00:00z", "2026-10-23T03:00:00"]) {
      expect(reveal({ now })).toEqual({ allowed: false, code: "invalid_input" });
    }
    expect(
      withStudent({
        credential: { state: "pending_reveal", revealExpiresAt: "2026-10-26T03:00:00+08:00" },
      }),
    ).toEqual({ allowed: false, code: "invalid_input" });
  });

  it("領取時仍須目標學校有效歸屬：跨校、已結束、未歸屬、查詢失敗與未提供分開拒絕", () => {
    expect(reveal({ affiliation: resolved(["school-a", "active"]) }).code).toBe(
      "school_not_in_affiliation",
    );
    expect(reveal({ affiliation: resolved(["school-b", "ended"]) }).code).toBe(
      "teacher_unaffiliated",
    );
    expect(reveal({ affiliation: resolved() }).code).toBe("teacher_unaffiliated");
    expect(reveal({ affiliation: lookupFailed }).code).toBe("affiliation_lookup_failed");
    expect(reveal({ affiliation: notProvided }).code).toBe("affiliation_not_provided");
  });

  it("所需學校資料取得失敗時拒絕；withdrawn／expired 未明定，維持 fail-closed 而不擴大", () => {
    expect(reveal({ targetSchool: { schoolId: "school-b", fact: lookupFailed } }).code).toBe(
      "school_lookup_failed",
    );
    expect(reveal({ targetSchool: { schoolId: "school-b", fact: notProvided } }).code).toBe(
      "school_state_not_provided",
    );
    for (const approval of ["withdrawn", "expired"]) {
      expect(
        reveal({ targetSchool: { schoolId: "school-b", fact: approvedSchool(approval) } }),
      ).toEqual({ allowed: false, code: "school_state_unspecified" });
    }
    expect(
      reveal({ targetSchool: { schoolId: "school-a", fact: approvedSchool("approved") } }).code,
    ).toBe("invalid_input");
  });

  it("教師帳號層條件拒絕", () => {
    expect(reveal({ account: teacher({ accountStatus: "pending" }) }).code).toBe(
      "account_unavailable",
    );
    expect(reveal({ account: teacher({ accountStatus: "disabled" }) }).code).toBe(
      "account_unavailable",
    );
    expect(reveal({ account: { lookup: "failed" } }).code).toBe("account_lookup_failed");
    expect(reveal({ account: teacher({ role: "student" }) }).code).toBe("role_not_authorized");
  });

  function studentWith(patch: Record<string, unknown>) {
    return {
      schoolId: "school-b",
      initiatedBy: "teacher-a",
      accountStatus: "approved",
      deletionState: "none",
      credential: { state: "pending_reveal", revealExpiresAt: "2026-10-26T03:00:00Z" },
      ...patch,
    };
  }
});

describe("D-06 教師重發登入碼（R-a）與管理員既有行為", () => {
  const reissue = (overrides: Record<string, unknown> = {}) =>
    decideCredentialReissue({
      account: teacher(),
      student: { accountStatus: "approved", deletionState: "none", school: approvedSchool("approved") },
      bindingActive: true,
      identityCheckPassed: true,
      ...overrides,
    });
  const studentWithSchool = (school: unknown, patch: Record<string, unknown> = {}) => ({
    accountStatus: "approved",
    deletionState: "none",
    school,
    ...patch,
  });

  it("已綁定教師、學生已批准、身分核對通過，學校 approved／withdrawn／expired 依 A-9 允許", () => {
    for (const approval of ["approved", "withdrawn", "expired"]) {
      expect(reissue({ student: studentWithSchool(approvedSchool(approval)) })).toMatchObject({
        allowed: true,
        code: "allowed",
      });
    }
  });

  it("R-a：學生學校 unconfirmed 時拒絕教師重發，管理員不受影響", () => {
    const student = studentWithSchool(approvedSchool("unconfirmed"));
    expect(reissue({ student })).toEqual({ allowed: false, code: "student_school_unconfirmed" });
    expect(reissue({ student, account: teacher({ userId: "admin-1", role: "admin" }), bindingActive: false })).toMatchObject({
      allowed: true,
    });
  });

  it("教師需要學校資料：查詢失敗與 null 拒絕且不被填成 unconfirmed；管理員不需要", () => {
    expect(reissue({ student: studentWithSchool(lookupFailed) })).toEqual({
      allowed: false,
      code: "school_lookup_failed",
    });
    expect(reissue({ student: studentWithSchool(notProvided) })).toEqual({
      allowed: false,
      code: "school_state_not_provided",
    });
    const admin = teacher({ userId: "admin-1", role: "admin" });
    for (const school of [lookupFailed, notProvided]) {
      expect(
        reissue({ account: admin, student: studentWithSchool(school), bindingActive: false }).allowed,
      ).toBe(true);
    }
  });

  it("無有效綁定的教師拒絕（發起者而無綁定不足），且先於學生狀態判斷，不洩漏學生是否存在", () => {
    expect(reissue({ bindingActive: false })).toEqual({ allowed: false, code: "not_bound" });
    expect(
      reissue({
        bindingActive: false,
        student: studentWithSchool(approvedSchool("approved"), { accountStatus: "pending" }),
      }),
    ).toEqual({ allowed: false, code: "not_bound" });
  });

  it("學生非 approved 或已標記刪除拒絕；身分核對未通過拒絕", () => {
    expect(
      reissue({ student: studentWithSchool(approvedSchool("approved"), { accountStatus: "pending" }) }),
    ).toEqual({ allowed: false, code: "student_not_approved" });
    expect(
      reissue({ student: studentWithSchool(approvedSchool("approved"), { deletionState: "marked" }) })
        .code,
    ).toBe("student_not_approved");
    expect(reissue({ identityCheckPassed: false })).toEqual({
      allowed: false,
      code: "identity_check_failed",
    });
  });

  it("管理員依既有規則：仍須帳號有效、學生已批准、身分核對通過", () => {
    const admin = teacher({ userId: "admin-1", role: "admin" });
    expect(reissue({ account: admin, bindingActive: false }).allowed).toBe(true);
    expect(reissue({ account: { ...admin, accountStatus: "disabled" } }).code).toBe(
      "account_unavailable",
    );
    expect(
      reissue({
        account: admin,
        student: studentWithSchool(approvedSchool("approved"), { accountStatus: "disabled" }),
      }).code,
    ).toBe("student_not_approved");
    expect(reissue({ account: admin, identityCheckPassed: false }).code).toBe(
      "identity_check_failed",
    );
  });

  it("原子性、舊 session 失效、限流與冪等仍須資料層強制，純函式不宣稱已驗證", () => {
    const result = reissue();
    expect(result.allowed && result.mustStillEnforce).toEqual(
      expect.arrayContaining([
        "binding_truth",
        "identity_check_truth",
        "atomic_reissue",
        "old_session_invalidation",
        "rate_limit",
        "idempotency_key",
      ]),
    );
  });

  it("帳號查詢失敗與非教師／管理員角色拒絕", () => {
    expect(reissue({ account: { lookup: "failed" } }).code).toBe("account_lookup_failed");
    expect(reissue({ account: teacher({ role: "student" }) }).code).toBe("role_not_authorized");
  });
});

describe("D-06 既有學生與管理員政策無回歸", () => {
  const context = (overrides: Partial<AccessContext>): AccessContext => ({
    role: "student",
    accountStatus: "approved",
    deletionState: "none",
    schoolApproval: "approved",
    aiOnDuty: true,
    ...overrides,
  });

  it("unconfirmed 學校的學生：登入與所有學習資料／AI／審查／部署能力維持關閉，帳號準備不開放它們", () => {
    for (const capability of [
      "login",
      "read_saved_content",
      "edit_saved_content",
      "download_own_results",
      "ai_call",
      "submit_for_review",
      "public_deploy",
    ]) {
      expect(decideCapability(context({ schoolApproval: "unconfirmed" }), capability)).toEqual({
        allowed: false,
        code: "school_not_confirmed",
      });
    }
    expect(canAccessRoleHome(context({ schoolApproval: "unconfirmed" }), "student")).toBe(false);
  });

  it("學生 null 學校狀態仍為 invalid_input", () => {
    expect(decideCapability({ ...context({}), schoolApproval: null }, "login")).toEqual({
      allowed: false,
      code: "invalid_input",
    });
  });

  it("管理員：approved 可登入並進入首頁，不看學校狀態；pending／rejected 僅受限狀態；disabled／刪除拒絕", () => {
    for (const schoolApproval of [null, "unconfirmed", "approved", "withdrawn", "expired"] as const) {
      const admin = context({ role: "admin", schoolApproval });
      expect(decideCapability(admin, "login")).toEqual({ allowed: true, code: "allowed" });
      expect(canAccessRoleHome(admin, "admin")).toBe(true);
      expect(decideCapability(admin, "read_saved_content")).toEqual({
        allowed: false,
        code: "role_not_authorized",
      });
    }
    for (const accountStatus of ["pending", "rejected"] as const) {
      const admin = context({ role: "admin", accountStatus, schoolApproval: null });
      expect(decideCapability(admin, "login").allowed).toBe(true);
      expect(canAccessRoleHome(admin, "admin")).toBe(false);
    }
    expect(decideCapability(context({ role: "admin", accountStatus: "disabled" }), "login").code).toBe(
      "account_unavailable",
    );
    expect(decideCapability(context({ role: "admin", deletionState: "marked" }), "login").code).toBe(
      "account_unavailable",
    );
  });
});
