import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  createStudentLoginHandler, parseStudentLoginBody, readStudentLoginRuntime, requestStudentGrant,
} from "../../apps/web/src/server/auth/student.ts";
import { StudentLoginThrottle } from "../../apps/web/src/server/auth/student-throttle.ts";
import { clientSourceHeader, sourceProofHeader } from "../../apps/web/src/server/auth/staff.ts";
import type { AccountStatusRecord } from "../../apps/web/src/server/auth/account-status.ts";
import type { StudentLoginDependencies } from "../../apps/web/src/server/auth/student.ts";
import type { StudentCredential } from "../../apps/web/src/server/auth/student-lookup.ts";

const userId = randomUUID();
const proof = "a1".repeat(32);
const origin = "https://localhost:3443";
const input = { handle: "sim-test", login_code: "0123456789" };
const credential: StudentCredential = { student_id: userId, auth_email_alias: `ap-${randomUUID()}@example.invalid`, version: 1, state: "active" };
const env: NodeJS.ProcessEnv = {
  NODE_ENV: "test", APP_PLANET_ENV: "isolated-local-test", APP_PLANET_LOCAL_AUTH: "1",
  APP_PLANET_AUTH_ORIGIN: "http://127.0.0.1:54321", APP_PLANET_APP_ORIGIN: origin,
  APP_PLANET_AUTH_API_KEY: "public-test", APP_PLANET_DATABASE_URL: "postgresql://synthetic@127.0.0.1/app",
  APP_PLANET_STAFF_LOGIN_MODE: "isolated-local-test", APP_PLANET_STAFF_LOGIN_THROTTLE_BACKEND: "memory-single-process",
  APP_PLANET_STAFF_LOGIN_HMAC_SECRET: "b2".repeat(32), APP_PLANET_SOURCE_PROXY_PROOF: proof,
  APP_PLANET_STAFF_SESSION_MAX_AGE_SECONDS: "900", APP_PLANET_STUDENT_LOGIN_MODE: "isolated-local-test",
  APP_PLANET_STUDENT_AUTH_TTL_SECONDS: "600", APP_PLANET_STUDENT_LOGIN_ISOLATION_ID: randomUUID(),
  APP_PLANET_STUDENT_LOGIN_DATABASE_URL: "postgresql://app_student_login_runtime@127.0.0.1/app",
  APP_PLANET_STUDENT_DUMMY_ALIAS: `ap-${randomUUID()}@example.invalid`,
};
const record: AccountStatusRecord = {
  subject: userId, role: "student", status: "approved", deletion_state: "none", school_found: true,
  school_state: "approved", login_gate: true, public_deploy_gate: true, ai_call_gate: true, teacher_labels: [],
};
function request(body: unknown = input, headers: Record<string, string> = {}, source = "127.0.0.1") {
  return new Request(`${origin}/api/v1/auth/student/login`, { method: "POST",
    headers: { origin, "content-type": "application/json", [clientSourceHeader]: source, [sourceProofHeader]: proof, ...headers },
    body: typeof body === "string" ? body : body instanceof Uint8Array
      ? new Blob([new Uint8Array(body)]) : JSON.stringify(body) });
}
function provider(token: () => Response | Promise<Response> = () => Response.json({
  access_token: "unit.access.token", token_type: "bearer", expires_in: 600, refresh_token: "not-retained",
}), id = userId) {
  return vi.fn<typeof fetch>(async (url) => {
    const path = new URL(String(url)).pathname;
    if (path === "/auth/v1/token") return token();
    if (path === "/auth/v1/user") return Response.json({ id });
    if (path === "/auth/v1/logout") return new Response(null, { status: 204 });
    throw new Error("非預期測試路徑");
  });
}
function setup(options: StudentLoginDependencies = {}) {
  const fetchImpl = options.fetchImpl ?? provider();
  const lookup = options.lookup ?? vi.fn(async () => ({ outcome: "found" as const, credential: { ...credential } }));
  const readStatus = options.readStatus ?? vi.fn(async () => ({ outcome: "found" as const, record: { ...record } }));
  return { fetchImpl, lookup, readStatus, handler: createStudentLoginHandler({
    env, fetchImpl, lookup, readStatus, throttle: new StudentLoginThrottle(), ...options,
  }) };
}
async function problem(response: Response, status: number, code: string) {
  const body: unknown = await response.json();
  expect(response.status).toBe(status);
  expect(body).toMatchObject({ status, code, type: `/problems/${code}` });
  expect(response.headers.get("content-type")).toContain("application/problem+json");
  expect(response.headers.get("cache-control")).toContain("no-store");
  expect(response.headers.has("set-cookie")).toBe(false);
  expect(response.headers.has("location")).toBe(false);
  if (status === 429) expect(Number(response.headers.get("retry-after")) > 0).toBe(true);
}

describe("A-1 strict 輸入／F-01 登錄", () => {
  it("Unicode White_Space、ASCII 大小寫及碼分隔符正規化", () => {
    const parsed = parseStudentLoginBody({ handle: "\u2003SIM-TEST\u2003", login_code: "01-23 45\n6789" });
    expect(parsed.kind === "ok" && parsed.value.handle === input.handle && parsed.value.login_code === input.login_code).toBe(true);
  });
  it.each(["handle", "login_code"])("原始 %s 128 bytes 可用、129 bytes 為 400", async (key) => {
    const value = input[key as keyof typeof input];
    const boundary = { ...input, [key]: " ".repeat(128 - value.length) + value };
    expect(parseStudentLoginBody(boundary).kind).toBe("ok");
    const h = setup();
    await problem(await h.handler(request({ ...boundary, [key]: ` ${boundary[key as keyof typeof boundary]}` })), 400, "invalid_request");
    expect(h.fetchImpl).not.toHaveBeenCalled();
  });
  it("UTF-8 原始 byte 數而非 JS 字元數", async () => {
    await problem(await setup().handler(request({ ...input, handle: "\u2003".repeat(41) + input.handle })), 400, "invalid_request");
  });
  it.each([
    ["extra", { ...input, extra: true }, 422, "unknown_field"],
    ["missing", { handle: input.handle }, 400, "invalid_request"],
    ["number", { ...input, login_code: 123 }, 400, "invalid_request"],
    ["unicode", { ...input, handle: "學生帳號" }, 400, "invalid_request"],
    ["email", { ...input, handle: "someone@example.invalid" }, 400, "invalid_request"],
    ["internal-space", { ...input, handle: "sim test" }, 400, "invalid_request"],
    ["ambiguous", { ...input, login_code: "OOOOOOOOOO" }, 400, "invalid_request"],
    ["json", "{", 400, "invalid_request"],
    ["duplicate", '{"handle":"sim-test","handle":"sim-other","login_code":"0123456789"}', 400, "invalid_request"],
    ["utf8", new Uint8Array([0xff]), 400, "invalid_request"],
    ["body4097", " ".repeat(4097), 413, "payload_too_large"],
  ] as const)("%s HTTP／body.status／code", async (_label, body, status, code) => {
    await problem(await setup().handler(request(body)), status, code);
  });
  it("合法 JSON 4096 bytes 可用；4097 超限優先於欄位", async () => {
    const base = JSON.stringify(input);
    expect((await setup().handler(request(base + " ".repeat(4096 - base.length)))).status).toBe(200);
    await problem(await setup().handler(request(base + " ".repeat(4097 - base.length))), 413, "payload_too_large");
  });
  it("無 Content-Length 串流累計超限", async () => {
    const original = request();
    const body = new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(new TextEncoder().encode(" ".repeat(2048)));
      controller.enqueue(new TextEncoder().encode(" ".repeat(2049)));
      controller.close();
    } });
    const streamed = new Request(original.url, { method: "POST", headers: original.headers, body, duplex: "half" } as RequestInit);
    await problem(await setup().handler(streamed), 413, "payload_too_large");
  });
  it("非 JSON 415", async () => {
    await problem(await setup().handler(request(input, { "content-type": "text/plain" })), 415, "unsupported_media_type");
  });
});

describe("A-1 身分、即時資格與 cookie 前重讀", () => {
  it("固定 DTO 與 access-only 安全 cookie，兩次本人讀取", async () => {
    const h = setup();
    const response = await h.handler(request());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ account_status: "approved", landing: "home" });
    const cookie = response.headers.get("set-cookie") ?? "";
    expect(cookie.startsWith("__Host-app-planet-session=")).toBe(true);
    expect(["Path=/", "HttpOnly", "Secure", "SameSite=Strict", "Max-Age=600"].every((part) => cookie.includes(part))).toBe(true);
    expect(/Domain=|refresh/i.test(cookie)).toBe(false);
    expect(h.readStatus).toHaveBeenCalledTimes(2);
    expect(h.lookup).toHaveBeenCalledTimes(2);
  });
  it.each(["pending", "rejected", "disabled"] as const)("%s 正確碼 403", async (status) => {
    await problem(await setup({ readStatus: async () => ({ outcome: "found", record: { ...record, status } }) }).handler(request()), 403, "account_unavailable");
  });
  it.each(["marked", "purging", "purge_failed", "purged"] as const)("%s 正確碼 403", async (deletion_state) => {
    await problem(await setup({ readStatus: async () => ({ outcome: "found", record: { ...record, deletion_state } }) }).handler(request()), 403, "account_unavailable");
  });
  it.each(["withdrawn", "expired"] as const)("%s 非 AI 登入仍可用", async (school_state) => {
    expect((await setup({ readStatus: async () => ({ outcome: "found", record: { ...record, school_state, ai_call_gate: false, public_deploy_gate: false } }) }).handler(request())).status).toBe(200);
  });
  it.each([true, false])("unconfirmed／受控缺校 found=%s 403，不當故障", async (school_found) => {
    await problem(await setup({ readStatus: async () => ({ outcome: "found", record: {
      ...record, school_found, school_state: school_found ? "unconfirmed" : null, login_gate: false,
    } }) }).handler(request()), 403, "school_not_confirmed");
  });
  it("非學生異常映射不能取得學生 session", async () => {
    await problem(await setup({ readStatus: async () => ({ outcome: "found", record: { ...record, role: "teacher" } }) }).handler(request()), 401, "invalid_credentials");
  });
  it.each(["missing", "revoked"] as const)("%s 仍做 dummy Auth，不直接省略", async (kind) => {
    const auth = provider(() => Response.json({ error_code: "invalid_credentials" }, { status: 400 }));
    await problem(await setup({ fetchImpl: auth, lookup: async () => kind === "missing"
      ? { outcome: "missing" } : { outcome: "found", credential: { ...credential, state: "revoked" } } }).handler(request()), 401, "invalid_credentials");
    expect(auth).toHaveBeenCalledTimes(1);
    const init = auth.mock.calls[0]?.[1];
    const body = typeof init?.body === "string" ? JSON.parse(init.body) as { email?: string } : null;
    expect(body?.email === env.APP_PLANET_STUDENT_DUMMY_ALIAS).toBe(true);
  });
  it("dummy 意外有效 session 為依賴錯誤並嘗試 local logout", async () => {
    const h = setup({ lookup: async () => ({ outcome: "missing" }) });
    await problem(await h.handler(request()), 503, "dependency_unavailable");
    expect(h.fetchImpl).toHaveBeenCalledTimes(2);
  });
  it("受控local logout失敗僅記嘗試結果，不把拒絕改成成功或宣稱已撤銷", async () => {
    const base = provider();
    const fetchImpl = vi.fn<typeof fetch>(async (url, init) =>
      new URL(String(url)).pathname === "/auth/v1/logout" ? new Response(null, { status: 503 }) : base(url, init));
    const log = vi.spyOn(console, "info").mockImplementation(() => undefined);
    try {
      const h = setup({ fetchImpl, readStatus: async () => ({ outcome: "found", record: { ...record, status: "pending" } }) });
      await problem(await h.handler(request()), 403, "account_unavailable");
      expect(fetchImpl.mock.calls.some(([url]) => new URL(String(url)).pathname === "/auth/v1/logout")).toBe(true);
      expect(log.mock.calls.some(([message]) => typeof message === "string" &&
        JSON.parse(message).result === "unavailable")).toBe(true);
    } finally { log.mockRestore(); }
  });
  it.each(["lookup", "reader", "uuid", "reread", "status-reread", "malformed"] as const)("%s 故障 fail closed", async (kind) => {
    let lookupReads = 0, statusReads = 0;
    const h = setup({
      fetchImpl: provider(undefined, kind === "uuid" ? randomUUID() : userId),
      lookup: async () => {
        lookupReads++;
        if (kind === "lookup") throw new Error("受控故障");
        return { outcome: "found", credential: {
          ...credential, version: kind === "reread" && lookupReads === 2 ? 2 : kind === "malformed" ? 0 : 1,
        } };
      },
      readStatus: async () => {
        statusReads++;
        if (kind === "reader" || (kind === "status-reread" && statusReads === 2)) return { outcome: "unavailable" };
        return { outcome: "found", record };
      },
    });
    await problem(await h.handler(request()), 503, "dependency_unavailable");
  });
  it("發 cookie 前 revoked／alias／id 變更與 reader throw 均 503", async () => {
    for (const change of [{ state: "revoked" as const }, { auth_email_alias: `ap-${randomUUID()}@example.invalid` }, { student_id: randomUUID() }]) {
      let n = 0;
      const h = setup({ lookup: async () => ({ outcome: "found", credential: { ...credential, ...(++n === 2 ? change : {}) } }) });
      await problem(await h.handler(request()), 503, "dependency_unavailable");
    }
    await problem(await setup({ readStatus: async () => { throw new Error("受控 reader 故障"); } }).handler(request()), 503, "dependency_unavailable");
  });
  it.each([
    { status: "disabled" as const }, { role: "teacher" as const },
    { school_state: "unconfirmed" as const, login_gate: false },
  ])("本人資格在cookie前重讀變更為拒絕時明確503", async (change) => {
    let reads = 0;
    await problem(await setup({ readStatus: async () => ({ outcome: "found", record: {
      ...record, ...(++reads === 2 ? change : {}),
    } }) }).handler(request()), 503, "dependency_unavailable");
  });
});

describe("A-1 對稱 adapter 與非對稱不冒稱列舉通過", () => {
  for (const scenario of ["invalid", "throttled", "unavailable"] as const) {
    it(`已知錯碼／未知在相同 ${scenario} 上游結果相同`, async () => {
      const responses: Response[] = [];
      for (const known of [true, false]) {
        const token = () => scenario === "invalid" ? Response.json({ error_code: "invalid_credentials" }, { status: 400 })
          : scenario === "throttled" ? new Response(null, { status: 429, headers: { "retry-after": "13" } })
          : new Response(null, { status: 503 });
        const h = setup({ fetchImpl: provider(token), lookup: async () => known ? { outcome: "found", credential } : { outcome: "missing" } });
        responses.push(await h.handler(request()));
      }
      const expected = scenario === "invalid" ? [401, "invalid_credentials"] as const
        : scenario === "throttled" ? [429, "login_throttled"] as const : [503, "dependency_unavailable"] as const;
      const bodies = await Promise.all(responses.map(async (response) => {
        const body: Record<string, unknown> = await response.clone().json();
        delete body.request_id;
        return body;
      }));
      expect(bodies[0]).toEqual(bodies[1]);
      expect(responses[0]!.headers.get("retry-after")).toBe(responses[1]!.headers.get("retry-after"));
      for (const response of responses) await problem(response, expected[0], expected[1]);
    });
  }
  it("一側 provider 429／503 對照 invalid 為不等價，不用固定 sleep 偽裝", async () => {
    for (const failure of [429, 503]) {
      const known = await setup({ fetchImpl: provider(() => Response.json({ error_code: "invalid_credentials" }, { status: 400 })) }).handler(request());
      const unknown = await setup({ fetchImpl: provider(() => new Response(null, { status: failure })),
        lookup: async () => ({ outcome: "missing" }) }).handler(request());
      expect(known.status === unknown.status).toBe(false);
    }
  });
  it.each([60, 599, 601])("可信 grant expires_in=%s 不符合實際 600 設定時拒絕", async (expires_in) => {
    await problem(await setup({ fetchImpl: provider(() => Response.json({
      access_token: "unit.token", token_type: "bearer", expires_in,
    })) }).handler(request()), 503, "dependency_unavailable");
  });
  it.each(["redirect", "bad-json", "large", "bad-schema", "email-unconfirmed", "malformed-error"] as const)("%s 依賴為 503", async (kind) => {
    const token = () => kind === "redirect" ? new Response(null, { status: 302 })
      : kind === "bad-json" ? new Response("{", { headers: { "content-type": "application/json" } })
      : kind === "large" ? new Response(" ".repeat(65537), { headers: { "content-type": "application/json" } })
      : kind === "bad-schema" ? Response.json({})
      : kind === "email-unconfirmed" ? Response.json({ error_code: "email_not_confirmed" }, { status: 400 })
      : new Response("{", { status: 400, headers: { "content-type": "application/json" } });
    await problem(await setup({ fetchImpl: provider(token) }).handler(request()), 503, "dependency_unavailable");
  });
  it("timeout 不依賴 fetch adapter 配合 abort", async () => {
    const runtime = readStudentLoginRuntime(env)!;
    const grant = await requestStudentGrant(credential.auth_email_alias, input.login_code, runtime.auth,
      (() => new Promise<Response>(() => undefined)) as typeof fetch, 5);
    expect(grant.outcome).toBe("unavailable");
  });
  it("依賴503與上游429僅neutral；釋放預留後正確碼仍可成功", async () => {
    for (const upstream of [429, 503]) {
      let recovered = false;
      const auth = provider(() => recovered
        ? Response.json({ access_token: "unit.token", token_type: "bearer", expires_in: 600 })
        : new Response(null, { status: upstream }));
      const h = setup({ fetchImpl: auth });
      for (let n = 0; n < 6; n++) {
        await problem(await h.handler(request()), upstream, upstream === 429 ? "login_throttled" : "dependency_unavailable");
      }
      recovered = true;
      expect((await h.handler(request())).status).toBe(200);
      expect(auth).toHaveBeenCalledTimes(8);
    }
  });
  it.each(["", "-1", "3601", "NaN", "1.5"])("上游 Retry-After 不合法時隔離值60", async (retry) => {
    const response = await setup({ fetchImpl: provider(() => new Response(null, { status: 429, headers: { "retry-after": retry } })) }).handler(request());
    await problem(response.clone(), 429, "login_throttled");
    expect(response.headers.get("retry-after")).toBe("60");
  });
});

describe("A-1 同步配對／來源桶與啟用邊界", () => {
  it("已知／未知同來源同序列皆第6次429；A鎖不影響B同學生正確碼", async () => {
    for (const known of [true, false]) {
      let valid = false;
      const throttle = new StudentLoginThrottle();
      const h = setup({ throttle, fetchImpl: provider(() => valid
        ? Response.json({ access_token: "unit.token", token_type: "bearer", expires_in: 600 })
        : Response.json({ error_code: "invalid_credentials" }, { status: 400 })),
      lookup: async () => known ? { outcome: "found", credential } : { outcome: "missing" } });
      for (let n = 0; n < 5; n++) await problem(await h.handler(request()), 401, "invalid_credentials");
      await problem(await h.handler(request()), 429, "login_throttled");
      if (known) {
        valid = true;
        expect((await h.handler(request(input, {}, "127.0.0.2"))).status).toBe(200);
        await problem(await h.handler(request()), 429, "login_throttled");
      }
    }
  });
  it("同來源第61次429；不同配對與正確碼也不能繞過", async () => {
    const h = setup();
    for (let n = 0; n < 60; n++) expect((await h.handler(request({ ...input, handle: `sim-${n}` }))).status).toBe(200);
    await problem(await h.handler(request({ ...input, handle: "sim-new" })), 429, "login_throttled");
  });
  it("A配對已鎖時B仍受自身來源桶及上游限制", async () => {
    let mode: "valid" | "wrong" | "upstream" = "valid";
    const h = setup({ fetchImpl: provider(() => mode === "valid"
      ? Response.json({ access_token: "unit.token", token_type: "bearer", expires_in: 600 })
      : mode === "wrong" ? Response.json({ error_code: "invalid_credentials" }, { status: 400 })
      : new Response(null, { status: 429, headers: { "retry-after": "9" } })) });
    for (let n = 0; n < 60; n++) expect((await h.handler(request({ ...input, handle: `sim-${n}` }, {}, "127.0.0.2"))).status).toBe(200);
    mode = "wrong";
    for (let n = 0; n < 5; n++) await problem(await h.handler(request()), 401, "invalid_credentials");
    mode = "valid";
    await problem(await h.handler(request()), 429, "login_throttled");
    await problem(await h.handler(request(input, {}, "127.0.0.2")), 429, "login_throttled");
    mode = "upstream";
    const c = await h.handler(request(input, {}, "127.0.0.3"));
    await problem(c.clone(), 429, "login_throttled");
    expect(c.headers.get("retry-after")).toBe("9");
  });
  it("已知／未知相同並行五個在途預留，第六個在Auth前429", async () => {
    for (const known of [true, false]) {
      let release!: () => void;
      const held = new Promise<void>((resolve) => { release = resolve; });
      const auth = provider(async () => { await held; return Response.json({ error_code: "invalid_credentials" }, { status: 400 }); });
      const h = setup({ fetchImpl: auth, lookup: async () => known ? { outcome: "found", credential } : { outcome: "missing" } });
      const inflight = Array.from({ length: 5 }, () => h.handler(request()));
      try {
        await vi.waitFor(() => expect(auth).toHaveBeenCalledTimes(5));
        await problem(await h.handler(request()), 429, "login_throttled");
      } finally { release(); }
      for (const response of await Promise.all(inflight)) await problem(response, 401, "invalid_credentials");
      expect(auth).toHaveBeenCalledTimes(5);
    }
  });
  it("並行預留5次即滿；neutral釋放一次、成功重設；漸進30/60秒", () => {
    let now = 0;
    const throttle = new StudentLoginThrottle(() => now);
    const tickets = Array.from({ length: 5 }, () => throttle.reserve("pair", "source"));
    expect(tickets.every((ticket) => ticket.ok)).toBe(true);
    expect(throttle.reserve("pair", "source").ok).toBe(false);
    for (const ticket of tickets) if (ticket.ok) throttle.settle(ticket.ticket, "failure");
    let blocked = throttle.reserve("pair", "source");
    expect(!blocked.ok && blocked.retryAfterSeconds === 30).toBe(true);
    now = 30_001;
    for (let n = 0; n < 5; n++) {
      const next = throttle.reserve("pair", "source");
      expect(next.ok).toBe(true);
      if (next.ok) throttle.settle(next.ticket, "failure");
    }
    blocked = throttle.reserve("pair", "source");
    expect(!blocked.ok && blocked.retryAfterSeconds === 60).toBe(true);
    now = 90_002;
    const next = throttle.reserve("pair", "other-source");
    expect(next.ok).toBe(true);
    if (next.ok) throttle.settle(next.ticket, "success");
    expect(throttle.reserve("pair", "other-source").ok).toBe(true);
  });
  it("桶滿載 fail closed，過期清理後恢復", () => {
    let now = 0;
    const throttle = new StudentLoginThrottle(() => now);
    for (let n = 0; n < 5000; n++) {
      const ticket = throttle.reserve(`pair-${n}`, `source-${n}`);
      expect(ticket.ok).toBe(true);
      if (ticket.ok) throttle.settle(ticket.ticket, "neutral");
    }
    expect(throttle.reserve("overflow", "new").ok).toBe(false);
    now = 600_001;
    expect(throttle.reserve("fresh", "new").ok).toBe(true);
  });
  it.each(["NODE_ENV", "APP_PLANET_ENV", "APP_PLANET_STUDENT_LOGIN_MODE", "APP_PLANET_STUDENT_AUTH_TTL_SECONDS",
    "APP_PLANET_STUDENT_LOGIN_ISOLATION_ID", "APP_PLANET_STUDENT_LOGIN_DATABASE_URL", "APP_PLANET_STUDENT_DUMMY_ALIAS",
    "APP_PLANET_SOURCE_PROXY_PROOF", "APP_PLANET_STAFF_LOGIN_HMAC_SECRET"])("缺少 %s 503", async (key) => {
    await problem(await setup({ env: { ...env, [key]: undefined } }).handler(request()), 503, "dependency_unavailable");
  });
  it.each([
    { NODE_ENV: "production" }, { APP_PLANET_STUDENT_LOGIN_DATABASE_URL: "postgresql://postgres@localhost/app" },
    { APP_PLANET_STUDENT_LOGIN_DATABASE_URL: "postgresql://app_student_login_runtime@remote.invalid/app" },
    { APP_PLANET_APP_ORIGIN: "http://localhost:3443" },
  ])("不符環境拒絕", async (change) => {
    await problem(await setup({ env: { ...env, ...change } }).handler(request()), 503, "dependency_unavailable");
  });
  it("偽造來源proof／跨origin 403", async () => {
    await problem(await setup().handler(request(input, { [sourceProofHeader]: "00".repeat(32) })), 403, "forbidden");
    await problem(await setup().handler(request(input, { origin: "https://other.invalid" })), 403, "forbidden");
  });
});
