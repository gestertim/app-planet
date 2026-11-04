import { describe, expect, it } from "vitest";
import {
  decideStaffLogin,
  projectMe,
  readCurrentAccountStatus,
  unnamedTeacherLabel,
  type AccountStatusRecord,
} from "../../apps/web/src/server/auth/account-status.ts";
import { createMeHandler } from "../../apps/web/src/server/auth/me.ts";
import type { AuthorizationContext } from "../../apps/web/src/server/authorization.ts";
import { problemResponse, type PrincipalResolution, type TrustedSession } from "../../apps/web/src/server/http.ts";

const subject = "b7000000-0000-4000-8000-0000000000bb";

function record(overrides: Partial<AccountStatusRecord> = {}): AccountStatusRecord {
  return {
    subject,
    role: "teacher",
    status: "approved",
    deletion_state: "none",
    school_found: false,
    school_state: null,
    login_gate: true,
    public_deploy_gate: false,
    ai_call_gate: false,
    teacher_labels: [],
    ...overrides,
  };
}

function contextReturning(row: Record<string, unknown> | null, error?: Error): AuthorizationContext {
  return {
    async runReadOnly(operation) {
      if (error) throw error;
      return operation({ query: async () => ({ rows: row === null ? [] : [row] }) } as never);
    },
  } as AuthorizationContext;
}

function sessionFor(context: AuthorizationContext): TrustedSession {
  return { read: context, write: {} as never, usage: {} as never };
}

describe("A-2 staff login decision", () => {
  it("issues sessions only to teacher/admin and routes by DB role and status", () => {
    expect(decideStaffLogin(record())).toEqual({ kind: "session", accountStatus: "approved", landing: "teacher_home" });
    expect(decideStaffLogin(record({ role: "admin" }))).toEqual({ kind: "session", accountStatus: "approved", landing: "admin_home" });
    expect(decideStaffLogin(record({ status: "pending" }))).toEqual({ kind: "session", accountStatus: "pending", landing: "account_status" });
    expect(decideStaffLogin(record({ status: "rejected" }))).toEqual({ kind: "session", accountStatus: "rejected", landing: "account_status" });
    expect(decideStaffLogin(record({ role: "student", school_found: true, school_state: "approved" })))
      .toEqual({ kind: "deny", code: "invalid_credentials" });
    expect(decideStaffLogin(record({ status: "disabled", login_gate: false }))).toEqual({ kind: "deny", code: "account_unavailable" });
    for (const deletion of ["marked", "purging", "purge_failed", "purged"] as const) {
      expect(decideStaffLogin(record({ deletion_state: deletion }))).toEqual({ kind: "deny", code: "account_unavailable" });
    }
    expect(decideStaffLogin(record({ login_gate: false }))).toEqual({ kind: "deny", code: "account_unavailable" });
  });
});

describe("A-4 /me minimal projection", () => {
  it("returns only role and account status for restricted accounts", () => {
    for (const status of ["pending", "rejected", "disabled"] as const) {
      expect(projectMe(record({ status, login_gate: status !== "disabled" }))).toEqual({
        kind: "view", body: { role: "teacher", account_status: status, school_gate: null },
      });
    }
  });

  it("does not fabricate school gates or teacher notices for staff", () => {
    expect(projectMe(record({ role: "admin" }))).toEqual({
      kind: "view", body: { role: "admin", account_status: "approved", school_gate: null },
    });
  });

  it("projects the student school gate and teacher notice from DB facts only", () => {
    const student = record({
      role: "student", school_found: true, school_state: "approved", public_deploy_gate: true,
      teacher_labels: ["王老師", null],
    });
    expect(projectMe(student)).toEqual({
      kind: "view",
      body: {
        role: "student",
        account_status: "approved",
        school_gate: { state: "approved", ai_available: false, public_deploy_available: true },
        teacher_notice: {
          teachers: [{ display_label: "王老師" }, { display_label: unnamedTeacherLabel }],
          scope: ["已保存的專案需求、階段草稿、學生確認狀態與任務"],
        },
      },
    });
    expect(projectMe(record({ role: "student", school_found: true, school_state: "unconfirmed" })))
      .toMatchObject({ body: { school_gate: { reason_code: "school_not_confirmed" } } });
    for (const school_state of ["withdrawn", "expired"] as const) {
      expect(projectMe(record({ role: "student", school_found: true, school_state })))
        .toMatchObject({ body: { school_gate: { reason_code: "ai_not_open" } } });
    }
    expect(projectMe(record({ role: "student", school_found: false, school_state: null })))
      .toEqual({ kind: "problem", code: "dependency_unavailable" });
    expect(projectMe(record({ deletion_state: "marked" }))).toEqual({ kind: "problem", code: "account_unavailable" });
  });

  it("omits an unproven duty reason while preserving the approved-school AI denial", () => {
    const projection = projectMe(record({ role: "student", school_found: true, school_state: "approved" }));
    expect(projection.kind).toBe("view");
    if (projection.kind !== "view") throw new Error("Expected self view");
    expect(projection.body.school_gate).toEqual({
      state: "approved", ai_available: false, public_deploy_available: false,
    });
    expect(projection.body.school_gate).not.toHaveProperty("reason_code");
  });
});

describe("self status reader", () => {
  const valid = { subject, actor_valid: true, status: record() };

  it("accepts only the bound subject, a valid actor and the fixed projection", async () => {
    expect(await readCurrentAccountStatus(contextReturning(valid), subject)).toEqual({ outcome: "found", record: record() });
    expect(await readCurrentAccountStatus(contextReturning({ ...valid, status: null }))).toEqual({ outcome: "no_profile" });
    const unavailable = [
      contextReturning({ ...valid, actor_valid: false }),
      contextReturning({ ...valid, subject: "not-a-uuid" }),
      contextReturning(null),
      contextReturning({ ...valid, status: { ...record(), extra: "field" } }),
      contextReturning({ ...valid, status: { ...record(), status: "unknown" } }),
      contextReturning({ ...valid, status: record({ subject: "b7000000-0000-4000-8000-0000000000cc" }) }),
      contextReturning({ ...valid, status: record({ school_found: true }) }),
      contextReturning({ ...valid, status: record({ teacher_labels: ["x"] }) }),
      contextReturning(valid, new Error("SQLSTATE 42501 secret detail")),
    ];
    for (const context of unavailable) {
      expect(await readCurrentAccountStatus(context)).toEqual({ outcome: "unavailable" });
    }
    expect(await readCurrentAccountStatus(contextReturning(valid), "b7000000-0000-4000-8000-0000000000cc"))
      .toEqual({ outcome: "unavailable" });
  });

  it.each([0, 100, 101])("A-4 keeps the complete %i-label teacher projection", async (count) => {
    const labels = Array.from({ length: count }, (_, index) => `教師標籤-${index + 1}`);
    const status = record({
      role: "student", school_found: true, school_state: "approved", teacher_labels: labels,
    });
    const result = await readCurrentAccountStatus(contextReturning({ subject, actor_valid: true, status }));
    expect(result).toMatchObject({ outcome: "found", record: { teacher_labels: labels } });
    if (result.outcome !== "found") throw new Error("Expected student status.");
    const projected = projectMe(result.record);
    expect(projected.kind).toBe("view");
    if (projected.kind !== "view") throw new Error("Expected student view.");
    if (count === 0) {
      expect(projected.body.teacher_notice).toBeUndefined();
    } else {
      expect(projected.body.teacher_notice?.teachers.map((teacher) => teacher.display_label)).toEqual(labels);
    }
  });
});

describe("GET /api/v1/me handler", () => {
  const request = () => new Request("https://localhost:3443/api/v1/me", { method: "GET" });
  const resolverFor = (resolution: PrincipalResolution) => ({ resolve: async () => resolution });

  it("returns the self projection with no-store and per-cookie variance", async () => {
    const handler = createMeHandler(resolverFor({ ok: true, session: sessionFor(contextReturning({
      subject, actor_valid: true, status: record({ status: "pending" }),
    })) }));
    const response = await handler(request());
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(response.headers.get("vary")?.toLowerCase()).toContain("cookie");
    expect(await response.json()).toEqual({ role: "teacher", account_status: "pending", school_gate: null });
  });

  it("maps missing session, missing profile, deletion and DB failure to problem responses", async () => {
    const cases: [PrincipalResolution, number, string][] = [
      [{ ok: false, reason: "unauthenticated" }, 401, "unauthenticated"],
      [{ ok: true, session: sessionFor(contextReturning({ subject, actor_valid: true, status: null })) }, 403,
        "account_unavailable"],
      [{ ok: true, session: sessionFor(contextReturning({
        subject, actor_valid: true, status: record({ deletion_state: "purging", login_gate: false }),
      })) }, 403, "account_unavailable"],
      [{ ok: true, session: sessionFor(contextReturning(null, new Error("db down"))) }, 503, "dependency_unavailable"],
    ];
    for (const [resolution, status, code] of cases) {
      const response = await createMeHandler(resolverFor(resolution))(request());
      expect(response.status, code).toBe(status);
      expect(response.headers.get("content-type")).toMatch(/^application\/problem\+json/);
      expect((await response.json() as { code: string }).code).toBe(code);
    }
    const post = await createMeHandler(resolverFor({ ok: false, reason: "unauthenticated" }))(
      new Request("https://localhost:3443/api/v1/me", { method: "POST" }));
    expect(post.status).toBe(405);
  });
});

describe("staff login problem registry", () => {
  it("uses problem+json with fixed statuses for the new codes", async () => {
    const context = { requestId: "00000000-0000-4000-8000-000000000000", instance: "/api/v1/auth/staff/login" };
    for (const [code, status] of [
      ["invalid_credentials", 401], ["login_throttled", 429], ["account_unavailable", 403], ["unknown_field", 422],
    ] as const) {
      const response = problemResponse(code, context);
      expect(response.status).toBe(status);
      expect(response.headers.get("content-type")).toMatch(/^application\/problem\+json/);
      expect(response.headers.get("cache-control")).toContain("no-store");
      const body = await response.json() as Record<string, unknown>;
      expect(body).toMatchObject({ status, code, instance: context.instance });
      expect(JSON.stringify(body)).not.toMatch(/token|password|exists|找不到帳號/i);
    }
  });
});
