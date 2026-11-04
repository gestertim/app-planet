import { createHash, randomBytes, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import http, { type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bootstrapFirstAdmin } from "../../apps/worker/src/admin/bootstrap.ts";
import { createTeacherReviewHandlers } from "../../apps/web/src/server/admin/teacher-review.ts";
import { sessionCookieName } from "../../apps/web/src/server/auth-principal.ts";
import { closeServerDatabasePool, createDatabaseSession } from "../../apps/web/src/server/database-session.ts";
import {
  SignupRateLimiter,
  createEmailConfirmLandingHandler,
  createTeacherSignupHandler,
  createTeacherSignupVerifyHandler,
  registerSignupIntent,
  verifyCookieName,
} from "../../apps/web/src/server/auth/teacher-signup.ts";
import { POST as signupRoute } from "../../apps/web/src/app/api/v1/auth/teacher-signup/route.ts";
import { POST as resendRoute } from "../../apps/web/src/app/api/v1/auth/teacher-signup/resend/route.ts";
import { DELETE as verifyCancel, POST as verifyRoute } from "../../apps/web/src/app/api/v1/auth/teacher-signup/verify/route.ts";
import { GET as confirmLanding } from "../../apps/web/src/app/auth/confirm/route.ts";
import { POST as staffLogin } from "../../apps/web/src/app/api/v1/auth/staff/login/route.ts";
import { GET as getMe } from "../../apps/web/src/app/api/v1/me/route.ts";
import { createTrustedSourceProxy } from "../../scripts/trusted-source-proxy.mjs";
import {
  createSyntheticStaffAccount, deleteSyntheticStaffAccount, openControlPool, type SyntheticStaffAccount,
} from "../support/real-auth-fixture.ts";
import {
  deleteMailFor, expectNoNewMail, messageIdsFor, startMailReceiver, stopMailReceiver, waitForNewMail,
} from "../support/test-mailbox.ts";

// readiness §92：真實隔離 Auth（signup＋電郵確認開啟）＋PostgreSQL＋Mailpit＋產品 Route Handler。
// 教師帳號一律經產品申請建立；驗證一律使用郵件接收器中的真實驗證信。管理員前置沿用正式 bootstrap。
// 本檔不輸出信件內容、驗證連結、token、密碼或 cookie。
const appOrigin = process.env.APP_PLANET_APP_ORIGIN!;
const authOrigin = process.env.APP_PLANET_AUTH_ORIGIN!;
const anonKey = process.env.APP_PLANET_AUTH_API_KEY!;
const adminAuthKey = process.env.APP_PLANET_TEST_AUTH_ADMIN_KEY!;
const previousProof = process.env.APP_PLANET_SOURCE_PROXY_PROOF;
const fixtureStaff: SyntheticStaffAccount[] = [];
const signupEmails = new Set<string>();
let control!: Pool;
let adapter!: Server;
let proxy!: Server;
let proxyPort = 0;
let admin!: SyntheticStaffAccount;
let adminToken = "";
let sourceOctet = 60;

type Applicant = { email: string; password: string; display_name: string; school_note: string };
type Reply = { status: number; headers: http.IncomingHttpHeaders; text: string; json: () => unknown };

function nextSource(): string {
  sourceOctet += 1;
  return `127.0.0.${sourceOctet}`;
}

function applicant(label: string): Applicant {
  const value = {
    email: `ap-signup-${randomUUID()}@example.invalid`,
    password: `${randomBytes(24).toString("base64url")}Aa9!`,
    display_name: `合成申請${label}`,
    school_note: `合成學校／任教說明${label}`,
  };
  signupEmails.add(value.email);
  return value;
}

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

async function route(request: Request): Promise<Response> {
  const path = new URL(request.url).pathname;
  const key = `${request.method} ${path}`;
  switch (key) {
    case "POST /api/v1/auth/teacher-signup": return signupRoute(request);
    case "POST /api/v1/auth/teacher-signup/resend": return resendRoute(request);
    case "POST /api/v1/auth/teacher-signup/verify": return verifyRoute(request);
    case "DELETE /api/v1/auth/teacher-signup/verify": return verifyCancel(request);
    case "GET /auth/confirm": return confirmLanding(request);
    case "POST /api/v1/auth/staff/login": return staffLogin(request);
    case "GET /api/v1/me": return getMe(request);
    default: return new Response("not found", { status: 404 });
  }
}

function startAdapter(): Promise<number> {
  adapter = http.createServer((incoming, outgoing) => {
    void (async () => {
      const response = await route(await toRequest(incoming));
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
  return new Promise((resolve) => adapter.listen(0, "127.0.0.1", () => resolve((adapter.address() as AddressInfo).port)));
}

function call(
  method: string, path: string,
  options: { body?: unknown; cookie?: string; source?: string; headers?: Record<string, string> } = {},
): Promise<Reply> {
  const payload = options.body === undefined ? undefined : JSON.stringify(options.body);
  return new Promise((resolve, reject) => {
    const outgoing = http.request({
      host: "127.0.0.1", port: proxyPort, method, path,
      localAddress: options.source ?? "127.0.0.1",
      headers: {
        origin: appOrigin, "sec-fetch-site": "same-origin",
        ...(payload === undefined ? {} : { "content-type": "application/json", "content-length": Buffer.byteLength(payload) }),
        ...(options.cookie ? { cookie: options.cookie } : {}),
        ...options.headers,
      },
      timeout: 30_000,
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

function signup(person: Applicant, key = randomUUID(), source = nextSource(), extra: Record<string, unknown> = {}) {
  return call("POST", "/api/v1/auth/teacher-signup", {
    body: { ...person, ...extra }, source, headers: { "idempotency-key": key },
  });
}

function problemOf(reply: Reply): string {
  expect(reply.headers["content-type"]).toMatch(/^application\/problem\+json/);
  expect(reply.headers["cache-control"]).toContain("no-store");
  return (reply.json() as { code: string }).code;
}

function expectNeutral(reply: Reply, person?: Applicant): void {
  expect(reply.status).toBe(202);
  expect(reply.json()).toEqual({ status: "submitted" });
  expect(reply.headers["cache-control"]).toContain("no-store");
  expect(reply.headers["set-cookie"]).toBeUndefined();
  if (person) expect(reply.text).not.toContain(person.password);
}

async function login(person: { email: string; password: string }): Promise<Reply> {
  return call("POST", "/api/v1/auth/staff/login", { body: { email: person.email, password: person.password }, source: nextSource() });
}

function sessionToken(reply: Reply): string {
  const cookie = (reply.headers["set-cookie"] ?? [])[0]!;
  expect(cookie).toMatch(/^__Host-app-planet-session=[A-Za-z0-9._~-]+; Path=\/; HttpOnly; Secure; SameSite=Strict; Max-Age=\d+$/);
  return /^__Host-app-planet-session=([^;]+);/.exec(cookie)![1]!;
}

async function me(token: string): Promise<unknown> {
  return (await call("GET", "/api/v1/me", { cookie: `${sessionCookieName}=${token}` })).json();
}

type VerifyOutcome = { landing: Reply; verify: Reply };

async function openLink(pathAndQuery: string): Promise<{ landing: Reply; cookie: string | null }> {
  const landing = await call("GET", pathAndQuery, { source: nextSource() });
  expect(landing.status).toBe(303);
  expect(landing.headers.location).toBe("/signup/verify");
  expect(landing.headers["cache-control"]).toContain("no-store");
  expect(landing.headers["referrer-policy"]).toBe("no-referrer");
  const set = (landing.headers["set-cookie"] ?? [])[0]!;
  const match = new RegExp(`^${verifyCookieName}=([0-9a-f]{40,128}); Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=600$`).exec(set);
  return { landing, cookie: match ? `${verifyCookieName}=${match[1]}` : null };
}

async function verifyLink(pathAndQuery: string): Promise<VerifyOutcome> {
  const opened = await openLink(pathAndQuery);
  expect(opened.cookie).not.toBeNull();
  const verify = await call("POST", "/api/v1/auth/teacher-signup/verify", { cookie: opened.cookie!, source: nextSource() });
  expect(verify.text).not.toContain(opened.cookie!.split("=")[1]!);
  return { landing: opened.landing, verify };
}

function expectCookieCleared(reply: Reply): void {
  expect(reply.headers["set-cookie"]).toEqual([`${verifyCookieName}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`]);
}

async function authUser(email: string): Promise<{ id: string; confirmed: boolean } | null> {
  const { rows } = await control.query<{ id: string; confirmed: boolean }>(
    "SELECT id::text, email_confirmed_at IS NOT NULL AS confirmed FROM auth.users WHERE lower(email)=lower($1)", [email],
  );
  expect(rows.length).toBeLessThanOrEqual(1);
  return rows[0] ?? null;
}

async function profileOf(id: string) {
  return (await control.query<{
    role: string; status: string; deletion_state: string; school_id: string | null; handle: string | null;
    display_label: string; initiated_by: string | null; row_version: number;
  }>("SELECT role,status,deletion_state,school_id,handle,display_label,initiated_by,row_version FROM app.profiles WHERE id=$1", [id])).rows[0];
}

const emailHash = (email: string) => createHash("sha256").update(email.toLowerCase(), "utf8").digest();

async function intents(email: string) {
  return (await control.query<{ consumed: boolean; account_id: string | null }>(
    "SELECT consumed_at IS NOT NULL AS consumed, account_id::text FROM app.teacher_signup_intents WHERE email_sha256=$1 ORDER BY created_at",
    [emailHash(email)],
  )).rows;
}

async function applicationOf(id: string) {
  return (await control.query<{ school_note: string }>(
    "SELECT school_note FROM app.teacher_applications WHERE account_id=$1", [id],
  )).rows;
}

async function listPending(): Promise<{ id: string; display_label: string; school_note: string | null }[]> {
  const response = await createTeacherReviewHandlers().list(new Request(`${appOrigin}/api/v1/admin/teachers`, {
    headers: { origin: appOrigin, "sec-fetch-site": "same-origin", cookie: `${sessionCookieName}=${adminToken}` },
  }));
  expect(response.status).toBe(200);
  return ((await response.json()) as { items: { id: string; display_label: string; school_note: string | null }[] }).items;
}

async function review(target: string, decision: "approved" | "rejected", version = 0): Promise<Response> {
  return createTeacherReviewHandlers().review(new Request(`${appOrigin}/api/v1/admin/teachers/${target}/review`, {
    method: "POST",
    headers: {
      origin: appOrigin, "sec-fetch-site": "same-origin", "content-type": "application/json",
      cookie: `${sessionCookieName}=${adminToken}`, "idempotency-key": randomUUID(), "if-match": `"${version}"`,
    },
    body: JSON.stringify({ decision }),
  }), { id: target });
}

async function reviewRpc(target: string): Promise<string> {
  const { rows } = await createDatabaseSession(admin.id).write.runTransaction((query) => query.query(
    "SELECT app.review_pending_teacher($1::uuid,'approved',0,$2::uuid) AS result", [target, randomUUID()],
  ));
  return (rows[0] as { result: { outcome: string } }).result.outcome;
}

async function closedOrigin(): Promise<string> {
  const server = http.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return `http://127.0.0.1:${port}`;
}

function directRequest(path: string, init: RequestInit & { cookie?: string } = {}): Request {
  const headers = new Headers(init.headers);
  headers.set("origin", appOrigin);
  headers.set("sec-fetch-site", "same-origin");
  headers.set("x-app-planet-client-source", "127.0.0.250");
  headers.set("x-app-planet-source-proof", process.env.APP_PLANET_SOURCE_PROXY_PROOF!);
  if (init.cookie) headers.set("cookie", init.cookie);
  return new Request(`${appOrigin}${path}`, { ...init, headers });
}

async function nativeSignup(email: string, data: Record<string, unknown>): Promise<number> {
  const response = await fetch(`${authOrigin}/auth/v1/signup`, {
    method: "POST", cache: "no-store", redirect: "error",
    headers: { apikey: anonKey, "content-type": "application/json" },
    body: JSON.stringify({ email, password: `${randomBytes(24).toString("base64url")}Aa9!`, data }),
    signal: AbortSignal.timeout(15_000),
  });
  await response.body?.cancel();
  return response.status;
}

describe("§92 修正聚焦", () => {
  it("同鍵派送資格只核發一次；舊 120 秒及過期不能解鎖異鍵", async () => {
    const person = applicant("派送資格");
    const input = { email: person.email, password: person.password, displayName: person.display_name, schoolNote: person.school_note };
    const key = randomUUID();
    const first = await registerSignupIntent(key, input, process.env);
    const second = await registerSignupIntent(key, input, process.env);
    await control.query(`UPDATE app.teacher_signup_intents SET created_at=clock_timestamp()-interval '2 hours',
      expires_at=clock_timestamp()-interval '1 hour' WHERE operation_key=$1`, [key]);
    const other = await registerSignupIntent(randomUUID(), input, process.env);
    expect(first.outcome).toBe("created");
    expect(second.outcome).toBe("in_flight");
    expect(other.outcome).toBe("in_flight");
  });

  it("新鍵 in-flight 與未知 email 的 HTTP 投影相同", async () => {
    const held = applicant("中性在途");
    await registerSignupIntent(randomUUID(), {
      email: held.email, password: held.password, displayName: held.display_name, schoolNote: held.school_note,
    }, process.env);
    const fresh = applicant("中性未知");
    const project = async (person: Applicant) => {
      const response = await createTeacherSignupHandler({ limiter: new SignupRateLimiter() })(directRequest(
        "/api/v1/auth/teacher-signup", { method: "POST",
          headers: { "content-type": "application/json", "idempotency-key": randomUUID() }, body: JSON.stringify(person) },
      ));
      const headers = Object.fromEntries(response.headers);
      delete headers["x-request-id"];
      return { status: response.status, headers, body: await response.json() };
    };
    expect(await project(held)).toEqual(await project(fresh));
  });

  it("原生公開 signup 不得改寫產品未驗證申請的原憑證", async () => {
    const person = applicant("原生改密碼");
    expectNeutral(await signup(person));
    const firstMail = await waitForNewMail(person.email, [], appOrigin);
    await control.query("UPDATE auth.users SET confirmation_sent_at=clock_timestamp()-interval '5 seconds' WHERE email=$1", [person.email]);
    const other = { ...person, password: `${randomBytes(24).toString("base64url")}Zz9!` };
    const response = await fetch(`${authOrigin}/auth/v1/signup`, {
      method: "POST", headers: { apikey: anonKey, "content-type": "application/json" },
      body: JSON.stringify({ email: other.email, password: other.password }),
    });
    await response.body?.cancel();
    const mail = response.ok ? await waitForNewMail(person.email, [firstMail.id], appOrigin) : firstMail;
    expect((await verifyLink(mail.pathAndQuery)).verify.status).toBe(200);
    const originalAccepted = (await login(person)).status === 200;
    const replacementAccepted = (await login(other)).status === 200;
    console.info(`NativeCredentialCheck status=${response.status} originalAccepted=${originalAccepted} replacementAccepted=${replacementAccepted}`);
    expect({ originalAccepted, replacementAccepted }).toEqual({ originalAccepted: true, replacementAccepted: false });
  });

  it.each([true, false])("不同密碼競態 sameKey=%s：barrier、逾期、程序重啟都不取得第二次派送", async (sameKey) => {
    const person = applicant("持久競態");
    const other = { ...person, password: `${randomBytes(24).toString("base64url")}Xx9!` };
    const key = randomUUID();
    let enter!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((resolve) => { enter = resolve; });
    const released = new Promise<void>((resolve) => { release = resolve; });
    let calls = 0;
    const delayed: typeof fetch = async (url, init) => {
      if (String(url).endsWith("/signup")) {
        calls++;
        const locker = await control.connect();
        try {
          await locker.query("BEGIN");
          await locker.query("LOCK TABLE auth.users IN SHARE MODE");
          const pid = (await locker.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!.pid;
          const upstream = fetch(url, init);
          const deadline = Date.now() + 5_000;
          for (;;) {
            const blocked = await control.query<{ waiting: boolean }>(
              "SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE $1::int=ANY(pg_blocking_pids(pid))) AS waiting", [pid]);
            if (blocked.rows[0]!.waiting) break;
            if (Date.now() > deadline) throw new Error("未觀察到真 Auth 等待本輪 DB barrier");
            await new Promise<void>((resolve) => setImmediate(resolve));
          }
          enter();
          await released;
          await locker.query("COMMIT");
          return await upstream;
        } finally { await locker.query("ROLLBACK"); locker.release(); }
      }
      return fetch(url, init);
    };
    const send = (handler: ReturnType<typeof createTeacherSignupHandler>, body: Applicant, operation: string) =>
      handler(directRequest("/api/v1/auth/teacher-signup", { method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": operation }, body: JSON.stringify(body) }));
    const handler = createTeacherSignupHandler({ fetchImpl: delayed, limiter: new SignupRateLimiter() });
    const first = send(handler, person, key);
    try {
      await Promise.race([entered, first.then(() => { throw new Error("Auth 請求未停在預期 barrier"); })]);
      expect((await authUser(person.email))).toBeNull();
      expect((await send(handler, other, sameKey ? key : randomUUID())).status).toBe(202);
      expect(calls).toBe(1);
      await control.query(`UPDATE app.teacher_signup_intents SET created_at=clock_timestamp()-interval '2 hours',
        expires_at=clock_timestamp()-interval '1 hour' WHERE operation_key=$1`, [key]);
      // 真新 Node 程序，沒有原 server 的 process memory；只輸出去敏計數及 HTTP status。
      const childScript = `
        import {createTeacherSignupHandler} from './apps/web/src/server/auth/teacher-signup.ts';
        import {closeServerDatabasePool} from './apps/web/src/server/database-session.ts';
        let input=''; for await (const chunk of process.stdin) input+=chunk;
        const {url,headers,body}=JSON.parse(input); let calls=0;
        const response=await createTeacherSignupHandler({fetchImpl:async(...args)=>{calls++;return fetch(...args);}})(
          new Request(url,{method:'POST',headers,body:JSON.stringify(body)}));
        process.stdout.write(JSON.stringify({status:response.status,calls}));
        await closeServerDatabasePool();`;
      const childEnv = { ...process.env };
      for (const name of Object.keys(childEnv)) {
        if (name.startsWith("APP_PLANET_TEST_") || name.startsWith("APP_PLANET_BOOTSTRAP_")) delete childEnv[name];
      }
      const child = spawn(process.execPath, ["--experimental-transform-types", "--input-type=module", "-e", childScript],
        { env: childEnv, windowsHide: true, stdio: "pipe", timeout: 15_000 });
      const output: Buffer[] = [];
      child.stdout.on("data", (chunk: Buffer) => output.push(chunk));
      child.stderr.resume();
      const done = new Promise<number | null>((resolve, reject) => {
        child.on("error", reject); child.on("close", resolve);
      });
      const retry = directRequest("/api/v1/auth/teacher-signup", { method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": randomUUID() } });
      child.stdin.end(JSON.stringify({ url: retry.url, headers: Object.fromEntries(retry.headers), body: other }));
      expect(await done).toBe(0);
      expect(JSON.parse(Buffer.concat(output).toString("utf8"))).toEqual({ status: 202, calls: 0 });
      expect((await send(handler, other, key)).status).toBe(202);
      expect(calls).toBe(1);
    } finally { release(); await first; }
    expect((await first).status).toBe(202);
    const user = (await authUser(person.email))!;
    expect(await applicationOf(user.id)).toHaveLength(1);
    expect(await profileOf(user.id)).toEqual(expect.objectContaining({ display_label: person.display_name, role: "teacher", status: "pending" }));
    expect(await intents(person.email)).toHaveLength(1);
    const mail = await waitForNewMail(person.email, [], appOrigin);
    expect((await verifyLink(mail.pathAndQuery)).verify.status).toBe(200);
    expect({ original: (await login(person)).status === 200, replacement: (await login(other)).status === 200 })
      .toEqual({ original: true, replacement: false });
    console.info(`DispatchBarrier=auth.users-share-lock observedBlocked=true sameKey=${sameKey} authCalls=${calls} accounts=1 profiles=1 applications=1 originalAccepted=true replacementAccepted=false restartCalls=0`);
  });

  it.each(["lost", "malformed", "cleanup"] as const)("真 Auth 驗證 %s：驗證事實與回應／撤銷結果分離", async (fault) => {
    const person = applicant(`驗證${fault}`);
    expectNeutral(await signup(person));
    const mail = await waitForNewMail(person.email, [], appOrigin);
    const opened = await openLink(mail.pathAndQuery);
    let verifyCalls = 0;
    const fetchImpl: typeof fetch = async (url, init) => {
      if (String(url).includes("/logout") && fault === "cleanup") return new Response(null, { status: 503 });
      const response = await fetch(url, init);
      if (String(url).endsWith("/verify")) {
        verifyCalls++;
        expect(response.status).toBe(200);
        if (fault !== "cleanup") {
          await response.body?.cancel();
          if (fault === "lost") throw new TypeError("controlled verify response loss");
          return Response.json({ unexpected: true });
        }
      }
      return response;
    };
    const response = await createTeacherSignupVerifyHandler({ fetchImpl, limiter: new SignupRateLimiter() })(directRequest(
      "/api/v1/auth/teacher-signup/verify", { method: "POST", cookie: opened.cookie! }));
    expect(verifyCalls).toBe(1);
    expect((await authUser(person.email))!.confirmed).toBe(true);
    if (fault === "cleanup") {
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ status: "verified", session_cleanup: "unknown" });
      expect(response.headers.getSetCookie()).toEqual([`${verifyCookieName}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`]);
    } else {
      expect(response.status).toBe(503);
      expect(((await response.json()) as { code: string }).code).toBe("verification_outcome_unknown");
      expect(response.headers.get("set-cookie")).toBeNull();
    }
    expect((await login(person)).status).toBe(200);
  });

  it("未驗證憑證守衛拒絕改寫但不阻擋真實電郵確認", async () => {
    const person = applicant("憑證守衛");
    expectNeutral(await signup(person));
    const user = (await authUser(person.email))!;
    await expect(control.query("UPDATE auth.users SET encrypted_password=encrypted_password || 'x' WHERE id=$1", [user.id]))
      .rejects.toMatchObject({ code: "P0001" });
    const mail = await waitForNewMail(person.email, [], appOrigin);
    expect((await verifyLink(mail.pathAndQuery)).verify.status).toBe(200);
    expect((await login(person)).status).toBe(200);
  });

  it("等價新操作：未知、已驗證、未驗證、在途的 HTTP 狀態／本文／標頭完全相同", async () => {
    const verified = applicant("回應已驗證");
    const unverified = applicant("回應未驗證");
    for (const person of [verified, unverified]) expectNeutral(await signup(person));
    const mail = await waitForNewMail(verified.email, [], appOrigin);
    expect((await verifyLink(mail.pathAndQuery)).verify.status).toBe(200);
    const held = applicant("回應在途");
    await registerSignupIntent(randomUUID(), { email: held.email, password: held.password,
      displayName: held.display_name, schoolNote: held.school_note }, process.env);
    const states = [applicant("回應未知"), verified, unverified, held];
    const replies = [];
    let calls = 0;
    for (const person of states) {
      const response = await createTeacherSignupHandler({ limiter: new SignupRateLimiter(), fetchImpl: async (url, init) => {
        if (String(url).endsWith("/signup")) calls++;
        return fetch(url, init);
      } })(directRequest("/api/v1/auth/teacher-signup", { method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": randomUUID() }, body: JSON.stringify(person) }));
      const headers = Object.fromEntries(response.headers);
      delete headers["x-request-id"];
      replies.push({ status: response.status, body: await response.json(), headers });
    }
    for (const reply of replies) expect(reply).toEqual(replies[0]);
    expect(calls).toBe(1);
    expect(await authUser(held.email)).toBeNull();
  });
});

async function deleteAuthUser(id: string): Promise<void> {
  const response = await fetch(`${authOrigin}/auth/v1/admin/users/${id}`, {
    method: "DELETE", cache: "no-store", redirect: "error",
    headers: { apikey: adminAuthKey, authorization: `Bearer ${adminAuthKey}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok && response.status !== 404) throw new Error("隔離 Auth 申請帳號清理失敗。");
}

beforeAll(async () => {
  if (process.env.APP_PLANET_ENV !== "isolated-local-test" || process.env.NODE_ENV !== "test" ||
      process.env.APP_PLANET_TEACHER_SIGNUP_MODE !== "isolated-local-test" ||
      process.env.APP_PLANET_LOCAL_AUTH !== "1" || !appOrigin) {
    throw new Error("教師申請整合測試只允許 -TeacherSignup 隔離 runner。");
  }
  process.env.APP_PLANET_SOURCE_PROXY_PROOF = randomBytes(32).toString("hex");
  control = openControlPool();
  if (process.env.APP_PLANET_TEST_MIGRATE_THROUGH === "0028") {
    const legacy = [applicant("舊未結"), applicant("舊過期"), applicant("舊完成")];
    const keys = legacy.map(() => randomUUID());
    for (const [index, person] of legacy.entries()) {
      const intent = await registerSignupIntent(keys[index]!, { email: person.email, password: person.password,
        displayName: person.display_name, schoolNote: person.school_note }, process.env);
      expect(intent.outcome).toBe("created");
      if (index === 2 && intent.outcome === "created") {
        const response = await fetch(`${authOrigin}/auth/v1/signup`, { method: "POST",
          headers: { apikey: anonKey, "content-type": "application/json" },
          body: JSON.stringify({ email: person.email, password: person.password, data: { app_planet_signup_intent: intent.intent } }) });
        expect(response.status).toBe(200);
        await response.body?.cancel();
      }
    }
    await control.query(`UPDATE app.teacher_signup_intents SET created_at=clock_timestamp()-interval '2 hours',
      expires_at=clock_timestamp()-interval '1 hour' WHERE operation_key=$1`, [keys[1]]);
    const before = (await control.query("SELECT * FROM app.teacher_signup_intents WHERE operation_key=ANY($1::uuid[]) ORDER BY operation_key", [keys])).rows;
    await control.query(await readFile(new URL("../../supabase/migrations/0029_teacher_signup_dispatch.sql", import.meta.url), "utf8"));
    const after = (await control.query("SELECT * FROM app.teacher_signup_intents WHERE operation_key=ANY($1::uuid[]) ORDER BY operation_key", [keys])).rows;
    expect(after.map(({ dispatch_state: _state, ...row }) => row)).toEqual(before);
    for (const [index, person] of legacy.entries()) {
      const input = { email: person.email, password: person.password, displayName: person.display_name, schoolNote: person.school_note };
      expect((await registerSignupIntent(keys[index]!, input, process.env)).outcome).toBe(index === 2 ? "consumed" : "in_flight");
      expect((await registerSignupIntent(randomUUID(), input, process.env)).outcome).toBe(index === 2 ? "existing" : "in_flight");
    }
    const mail = await waitForNewMail(legacy[2]!.email, [], appOrigin);
    const hash = new URL(mail.pathAndQuery, appOrigin).searchParams.get("token_hash");
    const response = await createTeacherSignupVerifyHandler({ limiter: new SignupRateLimiter() })(directRequest(
      "/api/v1/auth/teacher-signup/verify", { method: "POST", cookie: `${verifyCookieName}=${hash}` }));
    expect(response.status).toBe(200);
    console.info("Upgrade0028To0029 preservedRows=3 legacyUnknownBlocked=2 completedReplay=1 realConfirmation=1");
  }
  const { rows } = await control.query<{ ready: boolean }>(`
    SELECT EXISTS (SELECT 1 FROM app.teacher_signup_local_config)
      AND NOT EXISTS (SELECT 1 FROM app.first_admin_bootstrap)
      AND NOT EXISTS (SELECT 1 FROM app.profiles WHERE role='admin') AS ready`);
  expect(rows[0]!.ready).toBe(true);
  const adapterPort = await startAdapter();
  proxy = createTrustedSourceProxy({
    upstream: { origin: `http://127.0.0.1:${adapterPort}` }, proof: process.env.APP_PLANET_SOURCE_PROXY_PROOF,
  }) as Server;
  await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  proxyPort = (proxy.address() as AddressInfo).port;
  // 管理員前置：正式 bootstrap（管理員不經教師申請流程）。
  admin = await createSyntheticStaffAccount(control, "SignupAdmin", { role: "teacher", status: "pending" });
  fixtureStaff.push(admin);
  expect(await bootstrapFirstAdmin(admin.id)).toBe("completed");
  const adminLogin = await login(admin);
  expect(adminLogin.status).toBe(200);
  adminToken = sessionToken(adminLogin);
});

afterAll(async () => {
  const errors: unknown[] = [];
  try {
    await new Promise<void>((resolve) => (proxy ? proxy.close(() => resolve()) : resolve()));
    await new Promise<void>((resolve) => (adapter ? adapter.close(() => resolve()) : resolve()));
    await closeServerDatabasePool();
    if (!control) return;
    try { await startMailReceiver(); } catch (error) { errors.push(error); }
    const emails = [...signupEmails];
    const { rows } = await control.query<{ id: string }>(
      "SELECT id::text FROM auth.users WHERE lower(email)=ANY($1::text[])", [emails.map((email) => email.toLowerCase())],
    );
    const ids = [...rows.map((row) => row.id), ...fixtureStaff.map((account) => account.id)];
    const client = await control.connect();
    try {
      await client.query("BEGIN");
      await client.query("DELETE FROM app.teacher_applications WHERE account_id=ANY($1::uuid[])", [ids]);
      await client.query("DELETE FROM app.teacher_signup_intents WHERE email_sha256=ANY($1::bytea[])", [emails.map(emailHash)]);
      await client.query("DELETE FROM app.staff_review_receipts WHERE actor_id=ANY($1::uuid[]) OR target_id=ANY($1::uuid[])", [ids]);
      await client.query("DELETE FROM app.first_admin_bootstrap WHERE target_id=ANY($1::uuid[])", [ids]);
      await client.query(`DELETE FROM app.audit_events WHERE actor_aid IN
        (SELECT aid FROM app.audit_identity_map WHERE account_id=ANY($1::uuid[]))
        OR subject_aid IN (SELECT aid FROM app.audit_identity_map WHERE account_id=ANY($1::uuid[]))`, [ids]);
      await client.query("DELETE FROM app.audit_identity_map WHERE account_id=ANY($1::uuid[])", [ids]);
      await client.query("DELETE FROM app.profiles WHERE id=ANY($1::uuid[])", [rows.map((row) => row.id)]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      errors.push(error);
    } finally {
      client.release();
    }
    for (const row of rows) {
      try { await deleteAuthUser(row.id); } catch (error) { errors.push(error); }
    }
    for (const account of fixtureStaff) {
      try { await deleteSyntheticStaffAccount(control, account); } catch (error) { errors.push(error); }
    }
    try { await deleteMailFor(emails); } catch (error) { errors.push(error); }
    const left = await control.query<{ n: number }>(`SELECT
      (SELECT count(*) FROM auth.users WHERE lower(email)=ANY($1::text[]))
      + (SELECT count(*) FROM app.teacher_signup_intents WHERE email_sha256=ANY($2::bytea[]))
      + (SELECT count(*) FROM app.first_admin_bootstrap) AS n`,
    [emails.map((email) => email.toLowerCase()), emails.map(emailHash)]);
    if (Number(left.rows[0]!.n) !== 0) errors.push(new Error("教師申請整合測試仍有殘留資料。"));
  } catch (error) {
    errors.push(error);
  } finally {
    await control?.end();
    if (previousProof === undefined) delete process.env.APP_PLANET_SOURCE_PROXY_PROOF;
    else process.env.APP_PLANET_SOURCE_PROXY_PROOF = previousProof;
  }
  if (errors.length) throw new Error("教師申請整合測試清理失敗。", { cause: errors[0] });
});

describe("T017 教師申請→真實電郵驗證→待審→§91 審核（真實隔離 Auth＋PostgreSQL＋Mailpit）", () => {
  const approvedPerson = applicant("批准");
  const rejectedPerson = applicant("拒絕");

  it("正常申請：固定 teacher／pending、未驗證不可登入／不可批准、真實信件驗證後待審、批准後取得教師工作台", async () => {
    const reply = await signup(approvedPerson);
    expectNeutral(reply, approvedPerson);
    const user = await authUser(approvedPerson.email);
    expect(user).not.toBeNull();
    expect(user!.confirmed).toBe(false);
    expect(await profileOf(user!.id)).toEqual({
      role: "teacher", status: "pending", deletion_state: "none", school_id: null, handle: null,
      display_label: approvedPerson.display_name, initiated_by: null, row_version: 0,
    });
    expect(await applicationOf(user!.id)).toEqual([{ school_note: approvedPerson.school_note }]);
    expect(await intents(approvedPerson.email)).toEqual([{ consumed: true, account_id: user!.id }]);

    const early = await login(approvedPerson);
    expect(early.status).toBe(403);
    expect(problemOf(early)).toBe("email_not_verified");
    expect(early.headers["set-cookie"]).toBeUndefined();
    expect(await reviewRpc(user!.id)).toBe("not_eligible");
    const httpReview = await review(user!.id, "approved");
    expect(httpReview.status).toBe(409);
    expect(((await httpReview.json()) as { code: string }).code).toBe("teacher_not_verified");
    expect((await listPending()).map((item) => item.id)).not.toContain(user!.id);
    expect((await profileOf(user!.id))!.status).toBe("pending");

    const mail = await waitForNewMail(approvedPerson.email, [], appOrigin);
    expect(mail.subject).toContain("App Planet");
    expect(mail.pathAndQuery).toMatch(/^\/auth\/confirm\?token_hash=[0-9a-f]{40,128}&type=signup$/);
    const { verify } = await verifyLink(mail.pathAndQuery);
    expect(verify.status).toBe(200);
    expect(verify.json()).toEqual({ status: "verified" });
    expectCookieCleared(verify);
    expect((await authUser(approvedPerson.email))!.confirmed).toBe(true);
    expect((await profileOf(user!.id))!.status).toBe("pending");

    const pendingLogin = await login(approvedPerson);
    expect(pendingLogin.status).toBe(200);
    expect(pendingLogin.json()).toEqual({ account_status: "pending", landing: "account_status" });
    expect(await me(sessionToken(pendingLogin))).toEqual({ role: "teacher", account_status: "pending", school_gate: null });

    const listed = (await listPending()).find((item) => item.id === user!.id);
    expect(listed).toEqual(expect.objectContaining({
      display_label: approvedPerson.display_name, school_note: approvedPerson.school_note,
    }));
    const approved = await review(user!.id, "approved");
    expect(approved.status).toBe(200);
    const teacherLogin = await login(approvedPerson);
    expect(teacherLogin.json()).toEqual({ account_status: "approved", landing: "teacher_home" });
    const { rows: audit } = await control.query<{ action: string; meta: Record<string, unknown> }>(`
      SELECT e.action,e.meta FROM app.audit_events e JOIN app.audit_identity_map m ON m.aid=e.subject_aid
      WHERE m.account_id=$1`, [user!.id]);
    expect(audit).toHaveLength(1);
    expect(audit[0]!.action).toBe("teacher_approved");
    const auditText = JSON.stringify(audit);
    for (const secret of [approvedPerson.email, approvedPerson.school_note, approvedPerson.display_name]) {
      expect(auditText).not.toContain(secret);
    }

    // 已使用連結重放：無效並清除暫存；不改變狀態。
    const replay = await verifyLink(mail.pathAndQuery);
    expect(replay.verify.status).toBe(400);
    expect(problemOf(replay.verify)).toBe("verification_link_invalid");
    expectCookieCleared(replay.verify);
    expect((await profileOf(user!.id))!.status).toBe("approved");
  });

  it("拒絕流程：驗證後由管理員拒絕，教師只得受限狀態", async () => {
    expectNeutral(await signup(rejectedPerson), rejectedPerson);
    const user = (await authUser(rejectedPerson.email))!;
    const mail = await waitForNewMail(rejectedPerson.email, [], appOrigin);
    expect((await verifyLink(mail.pathAndQuery)).verify.status).toBe(200);
    expect((await review(user.id, "rejected")).status).toBe(200);
    const reply = await login(rejectedPerson);
    expect(reply.json()).toEqual({ account_status: "rejected", landing: "account_status" });
    expect(await me(sessionToken(reply))).toEqual({ role: "teacher", account_status: "rejected", school_gate: null });
  });

  it("重送／重複申請：同鍵不重建、異內容同鍵拒絕、既有帳號（已批准／已拒絕／未驗證／缺 profile）不被重設或接管", async () => {
    const approvedUser = (await authUser(approvedPerson.email))!;
    const knownMail = await messageIdsFor(approvedPerson.email);
    const fresh = applicant("同鍵");
    const key = randomUUID();
    expectNeutral(await signup(fresh, key), fresh);
    const freshMail = await waitForNewMail(fresh.email, [], appOrigin);
    expectNeutral(await signup(fresh, key), fresh);
    const reuse = await signup({ ...fresh, school_note: "不同說明" }, key);
    expect(reuse.status).toBe(422);
    expect(problemOf(reuse)).toBe("idempotency_key_reuse");
    expect(await expectNoNewMail(fresh.email, [freshMail.id])).toBe(0);
    expect(await intents(fresh.email)).toHaveLength(1);
    const takeover = { ...approvedPerson, password: `${randomBytes(24).toString("base64url")}Zz8!`, display_name: "改名嘗試", school_note: "覆寫嘗試" };
    expectNeutral(await signup(takeover), takeover);
    expectNeutral(await signup(approvedPerson), approvedPerson);
    expect(await expectNoNewMail(approvedPerson.email, knownMail)).toBe(0);
    expect((await intents(approvedPerson.email)).filter((row) => row.consumed)).toEqual([{ consumed: true, account_id: approvedUser.id }]);
    expect(await profileOf(approvedUser.id)).toEqual(expect.objectContaining({
      role: "teacher", status: "approved", display_label: approvedPerson.display_name, row_version: 1,
    }));
    expect(await applicationOf(approvedUser.id)).toEqual([{ school_note: approvedPerson.school_note }]);
    expect((await login(takeover)).status).toBe(401);
    expect((await login(approvedPerson)).status).toBe(200);
    expect((await control.query("SELECT 1 FROM app.profiles WHERE id=$1", [approvedUser.id])).rowCount).toBe(1);

    const rejectedUser = (await authUser(rejectedPerson.email))!;
    expectNeutral(await signup({ ...rejectedPerson, display_name: "重新申請嘗試" }));
    expect(await profileOf(rejectedUser.id)).toEqual(expect.objectContaining({ status: "rejected", display_label: rejectedPerson.display_name }));

    // 既有 Auth 帳號但缺平台 profile：不自動補成 pending，也不進審核清單。
    const orphan = await createSyntheticStaffAccount(control, "Orphan", { role: null });
    fixtureStaff.push(orphan);
    const orphanApplicant = { email: orphan.email, password: orphan.password, display_name: "補建嘗試", school_note: "補建嘗試" };
    expectNeutral(await signup(orphanApplicant));
    expect(await profileOf(orphan.id)).toBeUndefined();
    expect((await listPending()).map((item) => item.id)).not.toContain(orphan.id);

    // 既有未驗證申請：再次申請不改密碼、顯示名稱或說明，只可能重寄驗證信。
    const unverified = applicant("未驗證重送");
    expectNeutral(await signup(unverified), unverified);
    const unverifiedUser = (await authUser(unverified.email))!;
    const firstMail = await waitForNewMail(unverified.email, [], appOrigin);
    const second = { ...unverified, password: `${randomBytes(24).toString("base64url")}Yy7!`, display_name: "覆寫名稱" };
    expectNeutral(await signup(second), second);
    expect(await profileOf(unverifiedUser.id)).toEqual(expect.objectContaining({ status: "pending", display_label: unverified.display_name }));
    expect(await applicationOf(unverifiedUser.id)).toEqual([{ school_note: unverified.school_note }]);
    const latest = await waitForNewMail(unverified.email, [firstMail.id], appOrigin, 10_000).catch(() => firstMail);
    expect((await verifyLink(latest.pathAndQuery)).verify.status).toBe(200);
    expect((await login(second)).status).toBe(401);
    expect((await login(unverified)).json()).toEqual({ account_status: "pending", landing: "account_status" });
    expect((await control.query("SELECT 1 FROM app.teacher_applications WHERE account_id=$1", [unverifiedUser.id])).rowCount).toBe(1);
  });

  it("並行申請：不同密碼同 email 異鍵／同鍵只派送一次且恰一個原密碼可登入", async () => {
    for (const sameKey of [false, true]) {
      const person = applicant(sameKey ? "並行同鍵" : "並行異鍵");
      const key = randomUUID();
      const candidates = [person, { ...person, password: `${randomBytes(24).toString("base64url")}Bb8!` },
        { ...person, password: `${randomBytes(24).toString("base64url")}Cc7!` }];
      let calls = 0;
      let winner = -1;
      const handler = createTeacherSignupHandler({ limiter: new SignupRateLimiter(), fetchImpl: async (url, init) => {
        if (String(url).endsWith("/signup")) {
          calls++;
          const input: unknown = JSON.parse(String(init?.body));
          if (typeof input === "object" && input !== null && "password" in input) {
            winner = candidates.findIndex((candidate) => candidate.password === input.password);
          }
        }
        return fetch(url, init);
      } });
      const replies = await Promise.all(candidates.map((candidate) => handler(directRequest("/api/v1/auth/teacher-signup", {
        method: "POST", headers: { "content-type": "application/json", "idempotency-key": sameKey ? key : randomUUID() },
        body: JSON.stringify(candidate),
      }))));
      for (const reply of replies) expect(reply.status).toBe(202);
      expect(calls).toBe(1);
      expect(winner).toBeGreaterThanOrEqual(0);
      const user = (await authUser(person.email))!;
      expect(await profileOf(user.id)).toEqual(expect.objectContaining({ role: "teacher", status: "pending" }));
      expect(await applicationOf(user.id)).toHaveLength(1);
      expect((await intents(person.email)).filter((row) => row.consumed)).toEqual([{ consumed: true, account_id: user.id }]);
      const mail = await waitForNewMail(person.email, [], appOrigin);
      expect((await verifyLink(mail.pathAndQuery)).verify.status).toBe(200);
      const accepted = [];
      for (const candidate of candidates) accepted.push((await login(candidate)).status === 200);
      expect(accepted).toEqual(candidates.map((_candidate, index) => index === winner));
      console.info(`ConcurrentDifferentPasswords sameKey=${sameKey} authCalls=${calls} accounts=1 profiles=1 applications=1 acceptedPasswords=1 dispatchedCredentialPreserved=true`);
    }
  });

  it("越權：自報身分欄位、原生 signup、偽造意圖、admin 已確認建立與受限 DB 角色都不能取得 teacher／admin 或批准資格", async () => {
    const person = applicant("越權");
    for (const extra of [
      { role: "admin" }, { status: "approved" }, { user_id: randomUUID() }, { school_id: randomUUID() },
      { email_confirmed: true }, { verified: true }, { app_planet_signup_intent: randomUUID() },
    ]) {
      const reply = await signup(person, randomUUID(), nextSource(), extra);
      expect(reply.status).toBe(422);
      expect(problemOf(reply)).toBe("unknown_field");
    }
    expect(await intents(person.email)).toEqual([]);
    expect(await authUser(person.email)).toBeNull();

    // 直接呼叫原生 signup：自報 role／status／verified 一律忽略，只留下無 profile 的 Auth 帳號。
    const native = applicant("原生");
    expect(await nativeSignup(native.email, { role: "admin", status: "approved", email_confirmed: true, user_id: admin.id })).toBe(200);
    const nativeUser = (await authUser(native.email))!;
    expect(nativeUser.confirmed).toBe(false);
    expect(await profileOf(nativeUser.id)).toBeUndefined();
    const nativeMail = await waitForNewMail(native.email, [], appOrigin);
    expect((await verifyLink(nativeMail.pathAndQuery)).verify.status).toBe(200);
    const nativeLogin = await call("POST", "/api/v1/auth/staff/login", {
      body: { email: native.email, password: "wrong-password-0" }, source: nextSource(),
    });
    expect(nativeLogin.status).toBe(401);
    expect(await profileOf(nativeUser.id)).toBeUndefined();
    expect((await listPending()).map((item) => item.id)).not.toContain(nativeUser.id);

    // 偽造／他人意圖選擇子：觸發器拒絕，Auth 帳號整筆回滾。
    const forged = applicant("偽造意圖");
    expect(await nativeSignup(forged.email, { app_planet_signup_intent: randomUUID() })).toBeGreaterThanOrEqual(500);
    expect(await authUser(forged.email)).toBeNull();
    const owner = applicant("他人意圖");
    const ownerKey = randomUUID();
    const client = await control.connect();
    let intent = "";
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL ROLE app_signup_intake");
      intent = ((await client.query<{ result: { intent: string } }>(
        "SELECT app.register_teacher_signup_intent($1::uuid,$2,$3,$4) AS result",
        [ownerKey, owner.email, owner.display_name, owner.school_note],
      )).rows[0]!.result.intent);
      await client.query("COMMIT");
    } finally {
      client.release();
    }
    expect(await nativeSignup(forged.email, { app_planet_signup_intent: intent })).toBeGreaterThanOrEqual(500);
    expect(await authUser(forged.email)).toBeNull();
    // admin API 以 email_confirm=true 帶正確意圖：已確認帳號不可進入申請流程。
    const adminCreate = await fetch(`${authOrigin}/auth/v1/admin/users`, {
      method: "POST", cache: "no-store", redirect: "error",
      headers: { apikey: adminAuthKey, authorization: `Bearer ${adminAuthKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        email: owner.email, password: owner.password, email_confirm: true, user_metadata: { app_planet_signup_intent: intent },
      }),
      signal: AbortSignal.timeout(15_000),
    });
    await adminCreate.body?.cancel();
    expect(adminCreate.ok).toBe(false);
    expect(await authUser(owner.email)).toBeNull();
    expect(await intents(owner.email)).toEqual([{ consumed: false, account_id: null }]);

    // 受限 DB 角色：intake 只能執行固定意圖函式；一般 authenticated 讀不到申請／意圖。
    for (const [role, sql] of [
      ["app_signup_intake", "SELECT 1 FROM app.teacher_signup_intents"],
      ["app_signup_intake", "INSERT INTO app.profiles(id,role,status,deletion_state,display_label,status_changed_at) VALUES (gen_random_uuid(),'admin','approved','none','x',now())"],
      ["app_signup_intake", "SELECT 1 FROM app.teacher_applications"],
      ["authenticated", "SELECT 1 FROM app.teacher_applications"],
      ["authenticated", "SELECT 1 FROM app.teacher_signup_intents"],
      ["authenticated", "SELECT app.register_teacher_signup_intent(gen_random_uuid(),'a@example.invalid','x','y')"],
    ] as const) {
      const session = await control.connect();
      try {
        await session.query("BEGIN");
        await session.query(`SET LOCAL ROLE ${role}`);
        await expect(session.query(sql)).rejects.toMatchObject({ code: "42501" });
      } finally {
        await session.query("ROLLBACK").catch(() => undefined);
        session.release();
      }
    }
  });

  it("故障：郵件服務中斷、Auth 不可達、平台設定缺失、response-loss 都不跳過驗證、不盲目重建", async () => {
    const outage = applicant("郵件中斷");
    const key = randomUUID();
    await stopMailReceiver();
    let down: Reply;
    try {
      down = await signup(outage, key);
    } finally {
      await startMailReceiver();
    }
    expectNeutral(down);
    expect(await authUser(outage.email)).toBeNull();
    expect(await intents(outage.email)).toEqual([{ consumed: false, account_id: null }]);
    expectNeutral(await signup(outage, key), outage);
    expect(await authUser(outage.email)).toBeNull();
    expectNeutral(await signup(outage, randomUUID()), outage);
    expect(await authUser(outage.email)).toBeNull();

    // Auth 不可達：意圖保留未使用，不建立帳號。
    const unreachable = applicant("Auth中斷");
    const env = { ...process.env, APP_PLANET_AUTH_ORIGIN: await closedOrigin() };
    const handler = createTeacherSignupHandler({ env, limiter: new SignupRateLimiter() });
    const failed = await handler(directRequest("/api/v1/auth/teacher-signup", {
      method: "POST", headers: { "content-type": "application/json", "idempotency-key": randomUUID() },
      body: JSON.stringify(unreachable),
    }));
    expect(failed.status).toBe(202);
    expect(await failed.json()).toEqual({ status: "submitted" });
    expect(await authUser(unreachable.email)).toBeNull();

    // response-loss：Auth 已建立帳號但回應遺失；以同鍵重試只回中性結果，不再呼叫 Auth、不重建。
    const lost = applicant("回應遺失");
    const lostKey = randomUUID();
    let authCalls = 0;
    const lossy: typeof fetch = async (input, init) => {
      const response = await fetch(input, init);
      if (String(input).endsWith("/auth/v1/signup")) {
        authCalls += 1;
        await response.body?.cancel();
        throw new TypeError("simulated response loss");
      }
      return response;
    };
    const lossyHandler = createTeacherSignupHandler({ fetchImpl: lossy, limiter: new SignupRateLimiter() });
    const lostReply = await lossyHandler(directRequest("/api/v1/auth/teacher-signup", {
      method: "POST", headers: { "content-type": "application/json", "idempotency-key": lostKey },
      body: JSON.stringify(lost),
    }));
    expect(lostReply.status).toBe(202);
    expect(authCalls).toBe(1);
    const lostUser = (await authUser(lost.email))!;
    expect(await profileOf(lostUser.id)).toEqual(expect.objectContaining({ status: "pending" }));
    const lostMail = await waitForNewMail(lost.email, [], appOrigin);
    const replacement = { ...lost, password: `${randomBytes(24).toString("base64url")}Dd6!` };
    const retried = await lossyHandler(directRequest("/api/v1/auth/teacher-signup", {
      method: "POST", headers: { "content-type": "application/json", "idempotency-key": lostKey },
      body: JSON.stringify(replacement),
    }));
    expect(retried.status).toBe(202);
    expect((await lossyHandler(directRequest("/api/v1/auth/teacher-signup", {
      method: "POST", headers: { "content-type": "application/json", "idempotency-key": randomUUID() },
      body: JSON.stringify(replacement),
    }))).status).toBe(202);
    expect(authCalls).toBe(1);
    expect(await expectNoNewMail(lost.email, [lostMail.id])).toBe(0);
    expect((await control.query("SELECT 1 FROM app.teacher_applications WHERE account_id=$1", [lostUser.id])).rowCount).toBe(1);
    expect((await verifyLink(lostMail.pathAndQuery)).verify.status).toBe(200);
    expect({ original: (await login(lost)).status === 200, replacement: (await login(replacement)).status === 200 })
      .toEqual({ original: true, replacement: false });
    console.info("SignupResponseLoss committed=true sameAndNewKeyAuthCalls=1 applications=1 originalAccepted=true replacementAccepted=false");

    // 平台申請設定缺失：入口關閉，不呼叫 Auth。
    const closed = applicant("設定缺失");
    await control.query("DELETE FROM app.teacher_signup_local_config");
    try {
      const reply = await signup(closed);
      expect(reply.status).toBe(503);
      expect(problemOf(reply)).toBe("dependency_unavailable");
    } finally {
      await control.query("INSERT INTO app.teacher_signup_local_config VALUES (true,3600)");
    }
    expect(await authUser(closed.email)).toBeNull();

    // 隔離模式未啟用：所有入口關閉。
    const disabledEnv = { ...process.env, APP_PLANET_TEACHER_SIGNUP_MODE: "" };
    const disabled = await createTeacherSignupHandler({ env: disabledEnv })(directRequest("/api/v1/auth/teacher-signup", {
      method: "POST", headers: { "content-type": "application/json", "idempotency-key": randomUUID() },
      body: JSON.stringify(applicant("關閉")),
    }));
    expect(disabled.status).toBe(503);
    const landingClosed = createEmailConfirmLandingHandler(disabledEnv)(
      new Request(`${appOrigin}/auth/confirm?token_hash=${"a".repeat(56)}&type=signup`),
    );
    expect(landingClosed.headers.get("set-cookie")).toContain("Max-Age=0");
  });

  it("驗證連結：竄改／未知／重放／取消／上游不明／逾期都可理解地回到驗證狀態，逾期後可重寄完成", async () => {
    for (const path of [
      `/auth/confirm?token_hash=${"a".repeat(56)}&type=signup&redirect_to=https%3A%2F%2Fevil.example`,
      `/auth/confirm?token_hash=${"a".repeat(56)}&type=recovery`,
      `/auth/confirm?token_hash=${"A".repeat(56)}&type=signup`,
      "/auth/confirm?type=signup",
    ]) {
      const opened = await openLink(path);
      expect(opened.cookie).toBeNull();
      expect(opened.landing.headers["set-cookie"]![0]).toContain("Max-Age=0");
    }
    const none = await call("POST", "/api/v1/auth/teacher-signup/verify", { source: nextSource() });
    expect(none.status).toBe(400);
    expect(problemOf(none)).toBe("verification_link_invalid");
    const unknownLink = await verifyLink(`/auth/confirm?token_hash=${randomBytes(28).toString("hex")}&type=signup`);
    expect(unknownLink.verify.status).toBe(400);
    expect(problemOf(unknownLink.verify)).toBe("verification_link_invalid");

    const person = applicant("連結");
    expectNeutral(await signup(person), person);
    const mail = await waitForNewMail(person.email, [], appOrigin);
    const opened = await openLink(mail.pathAndQuery);
    const cancel = await call("DELETE", "/api/v1/auth/teacher-signup/verify", { cookie: opened.cookie!, source: nextSource() });
    expect(cancel.status).toBe(204);
    expectCookieCleared(cancel as Reply);
    expect((await authUser(person.email))!.confirmed).toBe(false);

    // 上游結果不明：保留短期 cookie，不清除、不宣稱成功；恢復後同一連結可完成。
    const reopened = await openLink(mail.pathAndQuery);
    const env = { ...process.env, APP_PLANET_AUTH_ORIGIN: await closedOrigin() };
    const unknown = await createTeacherSignupVerifyHandler({ env, limiter: new SignupRateLimiter() })(
      directRequest("/api/v1/auth/teacher-signup/verify", { method: "POST", cookie: reopened.cookie! }),
    );
    expect(unknown.status).toBe(503);
    expect(((await unknown.json()) as { code: string }).code).toBe("verification_outcome_unknown");
    expect(unknown.headers.get("set-cookie")).toBeNull();
    expect((await authUser(person.email))!.confirmed).toBe(false);
    const done = await call("POST", "/api/v1/auth/teacher-signup/verify", { cookie: reopened.cookie!, source: nextSource() });
    expect(done.status).toBe(200);
    expect((await authUser(person.email))!.confirmed).toBe(true);

    // 逾期（隔離 OTP 期限 120 秒；非正式政策）：真實等待後連結無效，經產品重寄取得新信後完成。
    const late = applicant("逾期");
    expectNeutral(await signup(late), late);
    const lateMail = await waitForNewMail(late.email, [], appOrigin);
    const expiry = Number(process.env.APP_PLANET_TEST_AUTH_OTP_EXPIRY_SECONDS);
    expect(expiry).toBe(120);
    await new Promise((resolve) => setTimeout(resolve, (expiry + 5) * 1000));
    const expired = await verifyLink(lateMail.pathAndQuery);
    expect(expired.verify.status).toBe(400);
    expect(problemOf(expired.verify)).toBe("verification_link_invalid");
    expect((await authUser(late.email))!.confirmed).toBe(false);
    const resent = await call("POST", "/api/v1/auth/teacher-signup/resend", { body: { email: late.email }, source: nextSource() });
    expectNeutral(resent);
    const fresh = await waitForNewMail(late.email, [lateMail.id], appOrigin);
    expect((await verifyLink(fresh.pathAndQuery)).verify.status).toBe(200);
    expect((await authUser(late.email))!.confirmed).toBe(true);
  }, 240_000);

  it("中性回應與限流：未知／既有帳號結果一致；重寄與申請依 email／來源限流", async () => {
    const unknownEmail = `ap-unknown-${randomUUID()}@example.invalid`;
    signupEmails.add(unknownEmail);
    const resendUnknown = await call("POST", "/api/v1/auth/teacher-signup/resend", { body: { email: unknownEmail }, source: nextSource() });
    const resendApproved = await call("POST", "/api/v1/auth/teacher-signup/resend", { body: { email: approvedPerson.email }, source: nextSource() });
    for (const reply of [resendUnknown, resendApproved]) expectNeutral(reply);
    expect(resendUnknown.text).toBe(resendApproved.text);
    expect(await expectNoNewMail(unknownEmail, [])).toBe(0);
    expect(await authUser(unknownEmail)).toBeNull();

    const forged = await call("POST", "/api/v1/auth/teacher-signup/resend", {
      body: { email: unknownEmail }, source: nextSource(),
      headers: { "x-forwarded-for": "198.51.100.7", "x-app-planet-client-source": "10.0.0.1", "x-app-planet-source-proof": "ab".repeat(32) },
    });
    expectNeutral(forged);
    const limited = await call("POST", "/api/v1/auth/teacher-signup/resend", { body: { email: unknownEmail }, source: nextSource() });
    expectNeutral(limited);
    const throttled = await call("POST", "/api/v1/auth/teacher-signup/resend", { body: { email: unknownEmail }, source: nextSource() });
    expect(throttled.status).toBe(429);
    expect(problemOf(throttled)).toBe("signup_throttled");
    expect(Number(throttled.headers["retry-after"])).toBeGreaterThan(0);

    const person = applicant("限流");
    for (let attempt = 0; attempt < 5; attempt += 1) expectNeutral(await signup(person));
    const blocked = await signup(person);
    expect(blocked.status).toBe(429);
    expect(problemOf(blocked)).toBe("signup_throttled");

    // 繞過 proxy 直連（無 proof）一律拒絕。
    const direct = await createTeacherSignupHandler()(new Request(`${appOrigin}/api/v1/auth/teacher-signup`, {
      method: "POST",
      headers: { origin: appOrigin, "content-type": "application/json", "idempotency-key": randomUUID() },
      body: JSON.stringify(applicant("直連")),
    }));
    expect(direct.status).toBe(403);
  });
});
