import { randomBytes, randomUUID } from "node:crypto";
import http, { type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeServerDatabasePool, createDatabaseSession } from "../../apps/web/src/server/database-session.ts";
import { sessionCookieName } from "../../apps/web/src/server/auth-principal.ts";
import { POST as staffLogin } from "../../apps/web/src/app/api/v1/auth/staff/login/route.ts";
import { GET as getMe } from "../../apps/web/src/app/api/v1/me/route.ts";
import { POST as logout } from "../../apps/web/src/app/api/v1/auth/logout/route.ts";
import { GET as getProject } from "../../apps/web/src/app/api/v1/projects/[id]/route.ts";
import { listCurrentOwnedProjectsSubset } from "../../apps/web/src/server/projects.ts";
import { createTrustedSourceProxy } from "../../scripts/trusted-source-proxy.mjs";
import {
  createOwnedSyntheticProject,
  createSyntheticAuthAccount,
  createSyntheticStaffAccount,
  deleteSyntheticAuthAccount,
  deleteSyntheticStaffAccount,
  loginSyntheticAccount,
  openControlPool,
  type SyntheticAuthAccount,
  type SyntheticStaffAccount,
} from "../support/real-auth-fixture.ts";

// readiness §90：真實隔離 Auth＋PostgreSQL＋產品 Route Handler。所有請求經 runner 同型的可信來源 proxy，
// 以不同 loopback localAddress 區分來源；不是學生登入碼（S-02）驗收。
const appOrigin = process.env.APP_PLANET_APP_ORIGIN!;
const staff: SyntheticStaffAccount[] = [];
const students: SyntheticAuthAccount[] = [];
const projectIds: string[] = [];
let control!: Pool;
let adapter!: Server;
let proxy!: Server;
let proxyPort = 0;
let adapterPort = 0;
let teacher!: SyntheticStaffAccount;
let admin!: SyntheticStaffAccount;
let pending!: SyntheticStaffAccount;
let rejected!: SyntheticStaffAccount;
let disabled!: SyntheticStaffAccount;
let deleted!: SyntheticStaffAccount;
let noProfile!: SyntheticStaffAccount;
let changing!: SyntheticStaffAccount;
let student!: SyntheticAuthAccount;
let studentProject = "";
let sourceOctet = 30;
const previousProof = process.env.APP_PLANET_SOURCE_PROXY_PROOF;

function nextSource(): string {
  sourceOctet += 1;
  return `127.0.0.${sourceOctet}`;
}

type Reply = { status: number; headers: http.IncomingHttpHeaders; text: string; json: () => unknown };

async function toRequest(incoming: IncomingMessage): Promise<Request> {
  const chunks: Buffer[] = [];
  for await (const chunk of incoming) chunks.push(chunk as Buffer);
  const headers = new Headers();
  for (let index = 0; index < incoming.rawHeaders.length; index += 2) {
    headers.append(incoming.rawHeaders[index]!, incoming.rawHeaders[index + 1]!);
  }
  const body = chunks.length ? Buffer.concat(chunks) : undefined;
  return new Request(`${appOrigin}${incoming.url}`, {
    method: incoming.method,
    headers,
    ...(body && incoming.method !== "GET" && incoming.method !== "HEAD" ? { body } : {}),
  });
}

function startAdapter(): Promise<void> {
  adapter = http.createServer((incoming, outgoing) => {
    void (async () => {
      const request = await toRequest(incoming);
      const path = new URL(request.url).pathname;
      const response = path === "/api/v1/auth/staff/login" && request.method === "POST"
        ? await staffLogin(request)
        : path === "/api/v1/me" && request.method === "GET"
          ? await getMe(request)
          : path === "/api/v1/auth/logout" && request.method === "POST"
            ? await logout(request)
            : new Response("not found", { status: 404 });
      const headers: Record<string, string | string[]> = {};
      response.headers.forEach((value, name) => { if (name !== "set-cookie") headers[name] = value; });
      const cookies = response.headers.getSetCookie();
      if (cookies.length) headers["set-cookie"] = cookies;
      outgoing.writeHead(response.status, headers);
      outgoing.end(Buffer.from(await response.arrayBuffer()));
    })().catch(() => {
      outgoing.writeHead(500);
      outgoing.end();
    });
  });
  return new Promise((resolve) => adapter.listen(0, "127.0.0.1", () => {
    adapterPort = (adapter.address() as AddressInfo).port;
    resolve();
  }));
}

function call(
  port: number,
  method: string,
  path: string,
  options: { body?: unknown; cookie?: string; source?: string; headers?: Record<string, string> } = {},
): Promise<Reply> {
  const payload = options.body === undefined ? undefined : JSON.stringify(options.body);
  return new Promise((resolve, reject) => {
    const outgoing = http.request({
      host: "127.0.0.1",
      port,
      method,
      path,
      localAddress: options.source ?? "127.0.0.1",
      headers: {
        origin: appOrigin,
        "sec-fetch-site": "same-origin",
        ...(payload === undefined ? {} : { "content-type": "application/json", "content-length": Buffer.byteLength(payload) }),
        ...(options.cookie ? { cookie: `${sessionCookieName}=${options.cookie}` } : {}),
        ...options.headers,
      },
      timeout: 20_000,
    }, (incoming) => {
      const chunks: Buffer[] = [];
      incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
      incoming.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve({ status: incoming.statusCode ?? 0, headers: incoming.headers, text, json: () => JSON.parse(text) });
      });
      incoming.on("error", reject);
    });
    outgoing.on("timeout", () => outgoing.destroy(new Error("request timeout")));
    outgoing.on("error", reject);
    outgoing.end(payload);
  });
}

const viaProxy = (method: string, path: string, options: Parameters<typeof call>[3] = {}) =>
  call(proxyPort, method, path, options);

async function login(account: { email: string; password: string }, source = nextSource()): Promise<Reply> {
  return viaProxy("POST", "/api/v1/auth/staff/login", { body: { email: account.email, password: account.password }, source });
}

function sessionCookie(reply: Reply): string {
  const cookies = reply.headers["set-cookie"] ?? [];
  expect(cookies).toHaveLength(1);
  const cookie = cookies[0]!;
  expect(cookie).toMatch(/^__Host-app-planet-session=[A-Za-z0-9._~-]+; Path=\/; HttpOnly; Secure; SameSite=Strict; Max-Age=\d+$/);
  expect(cookie).not.toMatch(/domain=/i);
  const maxAge = Number(/Max-Age=(\d+)$/.exec(cookie)![1]);
  expect(maxAge).toBeGreaterThan(0);
  expect(maxAge).toBeLessThanOrEqual(60);
  const token = /^__Host-app-planet-session=([^;]+);/.exec(cookie)![1]!;
  expect(reply.text).not.toContain(token);
  return token;
}

function problemOf(reply: Reply): string {
  expect(reply.headers["content-type"]).toMatch(/^application\/problem\+json/);
  expect(reply.headers["set-cookie"]).toBeUndefined();
  return (reply.json() as { code: string }).code;
}

beforeAll(async () => {
  process.env.APP_PLANET_SOURCE_PROXY_PROOF = randomBytes(32).toString("hex");
  control = openControlPool();
  teacher = await createSyntheticStaffAccount(control, "T", { role: "teacher" });
  admin = await createSyntheticStaffAccount(control, "A", { role: "admin" });
  pending = await createSyntheticStaffAccount(control, "P", { role: "teacher", status: "pending" });
  rejected = await createSyntheticStaffAccount(control, "R", { role: "admin", status: "rejected" });
  disabled = await createSyntheticStaffAccount(control, "D", { role: "teacher", status: "disabled" });
  deleted = await createSyntheticStaffAccount(control, "X", { role: "teacher", deletionState: "marked" });
  noProfile = await createSyntheticStaffAccount(control, "N", { role: null });
  changing = await createSyntheticStaffAccount(control, "C", { role: "teacher" });
  staff.push(teacher, admin, pending, rejected, disabled, deleted, noProfile, changing);
  student = await createSyntheticAuthAccount(control, "S");
  students.push(student);
  studentProject = await createOwnedSyntheticProject(student);
  projectIds.push(studentProject);
  await startAdapter();
  proxy = createTrustedSourceProxy({
    upstream: { origin: `http://127.0.0.1:${adapterPort}` },
    proof: process.env.APP_PLANET_SOURCE_PROXY_PROOF,
  }) as Server;
  await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  proxyPort = (proxy.address() as AddressInfo).port;
});

afterAll(async () => {
  const errors: unknown[] = [];
  try {
    await new Promise<void>((resolve) => (proxy ? proxy.close(() => resolve()) : resolve()));
    await new Promise<void>((resolve) => (adapter ? adapter.close(() => resolve()) : resolve()));
    await closeServerDatabasePool();
    if (!control) return;
    if (projectIds.length) {
      await control.query("DELETE FROM app.stage_draft_idempotency WHERE project_id=ANY($1::uuid[])", [projectIds]);
      await control.query("DELETE FROM app.stage_records WHERE project_id=ANY($1::uuid[])", [projectIds]);
      await control.query("DELETE FROM app.tasks WHERE project_id=ANY($1::uuid[])", [projectIds]);
      await control.query("DELETE FROM app.project_create_idempotency WHERE project_id=ANY($1::uuid[])", [projectIds]);
      await control.query("DELETE FROM app.projects WHERE id=ANY($1::uuid[])", [projectIds]);
    }
    for (const account of staff) {
      try { await deleteSyntheticStaffAccount(control, account); } catch (error) { errors.push(error); }
    }
    for (const account of students) {
      await control.query("DELETE FROM app.profiles WHERE id=$1", [account.id]);
      await control.query("DELETE FROM app.schools WHERE id=$1", [account.schoolId]);
      await deleteSyntheticAuthAccount(account);
    }
  } catch (error) {
    errors.push(error);
  } finally {
    await control?.end();
    if (previousProof === undefined) delete process.env.APP_PLANET_SOURCE_PROXY_PROOF;
    else process.env.APP_PLANET_SOURCE_PROXY_PROOF = previousProof;
  }
  if (errors.length) throw new Error("教職員登入整合測試清理失敗。", { cause: errors[0] });
});

describe("A-2／A-4 既有教職員登入：真實隔離 Auth → 可信來源 proxy → Route Handler → PostgreSQL", () => {
  it("teacher 與 admin 經產品登入取得受保護 cookie、/me 最小投影、登出後拒絕並可重新登入", async () => {
    for (const [account, role, landing] of [[teacher, "teacher", "teacher_home"], [admin, "admin", "admin_home"]] as const) {
      const first = await login(account);
      expect(first.status).toBe(200);
      expect(first.headers["cache-control"]).toContain("no-store");
      expect(first.json()).toEqual({ account_status: "approved", landing });
      const token = sessionCookie(first);
      const me = await viaProxy("GET", "/api/v1/me", { cookie: token });
      expect(me.status).toBe(200);
      expect(me.headers["cache-control"]).toContain("no-store");
      expect(me.json()).toEqual({ role, account_status: "approved", school_gate: null });
      const out = await viaProxy("POST", "/api/v1/auth/logout", { cookie: token });
      expect(out.status).toBe(204);
      expect(out.headers["set-cookie"]?.[0]).toMatch(/Max-Age=0/);
      expect((await viaProxy("GET", "/api/v1/me", { cookie: token })).status).toBe(401);
      expect((await viaProxy("GET", "/api/v1/me")).status).toBe(401);
      const again = await login(account);
      expect(again.status).toBe(200);
      const second = sessionCookie(again);
      expect(second).not.toBe(token);
      expect((await viaProxy("GET", "/api/v1/me", { cookie: second })).json()).toMatchObject({ role });
      await viaProxy("POST", "/api/v1/auth/logout", { cookie: second });
    }
  });

  it("student 不能經 A-2 取得產品 session，既有學生 session 的 /me 行為保留", async () => {
    const denied = await login(student);
    expect(denied.status).toBe(401);
    expect(problemOf(denied)).toBe("invalid_credentials");
    const session = await loginSyntheticAccount(student);
    const me = await viaProxy("GET", "/api/v1/me", { cookie: session.accessToken });
    expect(me.status).toBe(200);
    const gates = await control.query<{ school_state: string; ai: boolean; deploy: boolean }>(
      `SELECT school.approval_state AS school_state,
        app.account_gate(profile.id, 'ai_call') AS ai,
        app.account_gate(profile.id, 'public_deploy') AS deploy
       FROM app.profiles AS profile JOIN app.schools AS school ON school.id=profile.school_id
       WHERE profile.id=$1::uuid`, [student.id],
    );
    expect(gates.rows).toHaveLength(1);
    expect(gates.rows[0]).toMatchObject({ school_state: "approved", ai: false });
    expect(me.json()).toEqual({
      role: "student",
      account_status: "approved",
      school_gate: {
        state: "approved",
        ai_available: gates.rows[0]?.ai,
        public_deploy_available: gates.rows[0]?.deploy,
      },
    });
    expect((me.json() as { school_gate: object }).school_gate).not.toHaveProperty("reason_code");
    const detail = await getProject(new Request(`${appOrigin}/api/v1/projects/${studentProject}`, {
      headers: { cookie: `${sessionCookieName}=${session.accessToken}` },
    }), { params: Promise.resolve({ id: studentProject }) });
    expect(detail.status).toBe(200);
  });

  it("/me 只以可信學校狀態投影原因，不以 AI gate false 推導值守原因", async () => {
    const session = await loginSyntheticAccount(student);
    try {
      for (const [state, reason] of [
        ["unconfirmed", "school_not_confirmed"],
        ["withdrawn", "ai_not_open"],
        ["expired", "ai_not_open"],
        ["approved", undefined],
      ] as const) {
        await control.query("UPDATE app.schools SET approval_state=$1, updated_at=now() WHERE id=$2",
          [state, student.schoolId]);
        const facts = await control.query<{ state: string; ai: boolean; deploy: boolean }>(
          `SELECT school.approval_state AS state, app.account_gate(profile.id,'ai_call') AS ai,
            app.account_gate(profile.id,'public_deploy') AS deploy
           FROM app.profiles AS profile JOIN app.schools AS school ON school.id=profile.school_id
           WHERE profile.id=$1::uuid`, [student.id],
        );
        expect(facts.rows).toHaveLength(1);
        expect(facts.rows[0]).toMatchObject({ state, ai: false });
        const me = await viaProxy("GET", "/api/v1/me", { cookie: session.accessToken });
        expect(me.status).toBe(200);
        expect(me.json()).toEqual({
          role: "student", account_status: "approved",
          school_gate: {
            state, ai_available: false, public_deploy_available: facts.rows[0]?.deploy,
            ...(reason === undefined ? {} : { reason_code: reason }),
          },
        });
        if (reason === undefined) {
          expect((me.json() as { school_gate: object }).school_gate).not.toHaveProperty("reason_code");
        }
        console.info(JSON.stringify({
          check: "me-school-reason",
          db: facts.rows[0],
          httpStatus: me.status,
          schoolGate: (me.json() as { school_gate: object }).school_gate,
        }));
      }
    } finally {
      await control.query("UPDATE app.schools SET approval_state='approved', updated_at=now() WHERE id=$1",
        [student.schoolId]);
      await viaProxy("POST", "/api/v1/auth/logout", { cookie: session.accessToken });
    }
  });

  it("待審／拒絕只取得本人最小狀態；停用、刪除、缺 profile 不發 cookie", async () => {
    for (const [account, status, role] of [[pending, "pending", "teacher"], [rejected, "rejected", "admin"]] as const) {
      const reply = await login(account);
      expect(reply.status).toBe(200);
      expect(reply.json()).toEqual({ account_status: status, landing: "account_status" });
      const token = sessionCookie(reply);
      const me = await viaProxy("GET", "/api/v1/me", { cookie: token });
      expect(me.json()).toEqual({ role, account_status: status, school_gate: null });
      // 受限狀態可見不等於一般資料可用。
      const project = await getProject(new Request(`${appOrigin}/api/v1/projects/${studentProject}`, {
        headers: { cookie: `${sessionCookieName}=${token}` },
      }), { params: Promise.resolve({ id: studentProject }) });
      expect([403, 404]).toContain(project.status);
      // problem+json 的 instance 只回放請求路徑；不得含專案內容欄位。
      const body = await project.json() as Record<string, unknown>;
      for (const key of Object.keys(body)) {
        expect(["type", "title", "status", "code", "instance", "request_id", "user_message_zh", "retryable"]).toContain(key);
      }
      const listed = await listCurrentOwnedProjectsSubset(createDatabaseSession(account.id).read);
      if (listed.outcome === "listed") expect(listed.projects).toEqual([]);
      await viaProxy("POST", "/api/v1/auth/logout", { cookie: token });
    }
    for (const account of [disabled, deleted, noProfile]) {
      const reply = await login(account);
      expect(reply.status).toBe(403);
      expect(problemOf(reply)).toBe("account_unavailable");
    }
  });

  it("錯誤密碼與未知帳號同為 401 且不揭露上游訊息或帳號存在", async () => {
    const wrong = await login({ email: teacher.email, password: `${teacher.password}x` });
    const unknown = await login({ email: `ap-unknown-${randomUUID()}@example.invalid`, password: "Unknown-Account 1!" });
    for (const reply of [wrong, unknown]) {
      expect(reply.status).toBe(401);
      expect(problemOf(reply)).toBe("invalid_credentials");
      expect(reply.text).not.toMatch(/invalid_grant|Invalid login credentials|not found|error_description/i);
    }
    const strip = (reply: Reply) => {
      const body = reply.json() as Record<string, unknown>;
      delete body.request_id;
      return body;
    };
    expect(strip(wrong)).toEqual(strip(unknown));
  });

  it("背景角色／狀態變更在下一次受保護請求重新判斷", async () => {
    const reply = await login(changing);
    const token = sessionCookie(reply);
    expect((await viaProxy("GET", "/api/v1/me", { cookie: token })).json()).toMatchObject({ role: "teacher", account_status: "approved" });
    await control.query("UPDATE app.profiles SET role='admin', status_changed_at=now() WHERE id=$1", [changing.id]);
    expect((await viaProxy("GET", "/api/v1/me", { cookie: token })).json()).toEqual({
      role: "admin", account_status: "approved", school_gate: null,
    });
    await control.query("UPDATE app.profiles SET status='disabled', status_changed_at=now() WHERE id=$1", [changing.id]);
    expect((await viaProxy("GET", "/api/v1/me", { cookie: token })).json()).toEqual({
      role: "admin", account_status: "disabled", school_gate: null,
    });
    await control.query("UPDATE app.profiles SET deletion_state='marked', status_changed_at=now() WHERE id=$1", [changing.id]);
    const gone = await viaProxy("GET", "/api/v1/me", { cookie: token });
    expect(gone.status).toBe(403);
    expect((gone.json() as { code: string }).code).toBe("account_unavailable");
    await control.query(
      "UPDATE app.profiles SET role='teacher', status='approved', deletion_state='none', status_changed_at=now() WHERE id=$1",
      [changing.id],
    );
    await viaProxy("POST", "/api/v1/auth/logout", { cookie: token });
  });

  it("/me 只回本人；caller 指定的使用者識別一律無效", async () => {
    const token = sessionCookie(await login(teacher));
    const forged = await viaProxy("GET", `/api/v1/me?user_id=${admin.id}`, {
      cookie: token, headers: { "x-user-id": admin.id, "x-role": "admin" },
    });
    expect(forged.json()).toEqual({ role: "teacher", account_status: "approved", school_gate: null });
    await viaProxy("POST", "/api/v1/auth/logout", { cookie: token });
  });

  it("可信來源：繞過 proxy 或偽造 proof 被拒；proxy 剝除 caller 自帶來源與轉送標頭", async () => {
    const direct = await call(adapterPort, "POST", "/api/v1/auth/staff/login", {
      body: { email: teacher.email, password: teacher.password },
    });
    expect(direct.status).toBe(403);
    const forgedDirect = await call(adapterPort, "POST", "/api/v1/auth/staff/login", {
      body: { email: teacher.email, password: teacher.password },
      headers: { "x-app-planet-client-source": "127.0.0.1", "x-app-planet-source-proof": "ab".repeat(32) },
    });
    expect(forgedDirect.status).toBe(403);
    // 經 proxy：偽造的來源／proof／XFF 被剝除，來源以實際 loopback 位址計。
    const source = nextSource();
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const reply = await viaProxy("POST", "/api/v1/auth/staff/login", {
        body: { email: teacher.email, password: "Wrong-Password 1!" },
        source,
        headers: { "x-forwarded-for": `198.51.100.${attempt}`, "x-app-planet-client-source": `10.0.0.${attempt}`,
          "x-app-planet-source-proof": "cd".repeat(32) },
      });
      expect(reply.status).toBe(401);
    }
    const locked = await viaProxy("POST", "/api/v1/auth/staff/login", {
      body: { email: teacher.email, password: teacher.password },
      source,
      headers: { "x-forwarded-for": "203.0.113.9" },
    });
    expect(locked.status).toBe(429);
    expect(problemOf(locked)).toBe("login_throttled");
    expect(Number(locked.headers["retry-after"])).toBeGreaterThan(0);
    const otherSource = await login(teacher);
    expect(otherSource.status).toBe(200);
    await viaProxy("POST", "/api/v1/auth/logout", { cookie: sessionCookie(otherSource) });
    const crossSite = await viaProxy("POST", "/api/v1/auth/staff/login", {
      body: { email: teacher.email, password: teacher.password },
      source: nextSource(),
      headers: { origin: "https://evil.example.invalid", "sec-fetch-site": "cross-site" },
    });
    expect(crossSite.status).toBe(403);
    const unknownField = await viaProxy("POST", "/api/v1/auth/staff/login", {
      body: { email: teacher.email, password: teacher.password, role: "admin" },
      source: nextSource(),
    });
    expect(unknownField.status).toBe(422);
    expect(problemOf(unknownField)).toBe("unknown_field");
  });

  it("缺隔離設定、Auth 故障與 DB 故障均 fail-closed 且不發 cookie", async () => {
    const mode = process.env.APP_PLANET_STAFF_LOGIN_MODE;
    delete process.env.APP_PLANET_STAFF_LOGIN_MODE;
    try {
      const reply = await login(teacher);
      expect(reply.status).toBe(503);
      expect(problemOf(reply)).toBe("dependency_unavailable");
    } finally {
      process.env.APP_PLANET_STAFF_LOGIN_MODE = mode;
    }

    const authOrigin = process.env.APP_PLANET_AUTH_ORIGIN;
    const closed = http.createServer();
    await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", resolve));
    const closedPort = (closed.address() as AddressInfo).port;
    await new Promise<void>((resolve) => closed.close(() => resolve()));
    process.env.APP_PLANET_AUTH_ORIGIN = `http://127.0.0.1:${closedPort}`;
    try {
      const reply = await login(teacher);
      expect(reply.status).toBe(503);
      expect(problemOf(reply)).toBe("dependency_unavailable");
    } finally {
      process.env.APP_PLANET_AUTH_ORIGIN = authOrigin;
    }

    await control.query("REVOKE EXECUTE ON FUNCTION app.current_account_status() FROM authenticated");
    try {
      const reply = await login(teacher);
      expect(reply.status).toBe(503);
      expect(problemOf(reply)).toBe("dependency_unavailable");
    } finally {
      await control.query("GRANT EXECUTE ON FUNCTION app.current_account_status() TO authenticated");
    }
    const recovered = await login(teacher);
    expect(recovered.status).toBe(200);
    await viaProxy("POST", "/api/v1/auth/logout", { cookie: sessionCookie(recovered) });
  });
});
