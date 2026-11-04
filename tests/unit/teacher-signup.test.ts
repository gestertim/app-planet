import { describe, expect, it, vi } from "vitest";
import {
  SignupRateLimiter,
  clearVerifyCookie,
  createEmailConfirmLandingHandler,
  createTeacherSignupHandler,
  createTeacherSignupResendHandler,
  createTeacherSignupVerifyHandler,
  normalizeSignupText,
  parseResendBody,
  parseTeacherSignupBody,
  readTeacherSignupRuntime,
  readVerifyCookie,
  requestAuthSignup,
  requestAuthVerify,
  teacherSignupIsolatedTestPolicy,
  verifyCookie,
  verifyCookieName,
  type IntentResult,
  type TeacherSignupInput,
} from "../../apps/web/src/server/auth/teacher-signup.ts";
import { clientSourceHeader, requestPasswordGrant, sourceProofHeader } from "../../apps/web/src/server/auth/staff.ts";
import type { AuthConfiguration } from "../../apps/web/src/server/auth-principal.ts";

// readiness §92：教師申請／驗證 server 的合成單元測試；不連 Auth／DB，不使用真實帳號或信件。
const proof = "c3".repeat(32);
const appOrigin = "https://localhost:3443";
const tokenHash = "ab".repeat(28);
const env = Object.freeze({
  NODE_ENV: "test",
  APP_PLANET_ENV: "isolated-local-test",
  APP_PLANET_LOCAL_AUTH: "1",
  APP_PLANET_AUTH_ORIGIN: "http://127.0.0.1:54321",
  APP_PLANET_APP_ORIGIN: appOrigin,
  APP_PLANET_AUTH_API_KEY: "public-test-key",
  APP_PLANET_DATABASE_URL: "postgresql://synthetic@127.0.0.1:5432/app",
  APP_PLANET_STAFF_LOGIN_MODE: "isolated-local-test",
  APP_PLANET_STAFF_LOGIN_THROTTLE_BACKEND: "memory-single-process",
  APP_PLANET_STAFF_LOGIN_HMAC_SECRET: "d4".repeat(32),
  APP_PLANET_SOURCE_PROXY_PROOF: proof,
  APP_PLANET_STAFF_SESSION_MAX_AGE_SECONDS: "900",
  APP_PLANET_TEACHER_SIGNUP_MODE: "isolated-local-test",
}) as unknown as NodeJS.ProcessEnv;
const authConfig: AuthConfiguration = {
  authOrigin: "http://127.0.0.1:54321", authApiKey: "public-test-key", appOrigin, localHttp: true,
};
const person = {
  email: "teacher@example.invalid", password: "  Pass word 9! ", display_name: "王老師", school_note: "合成國小 五年級導師",
};

function request(path: string, init: { method?: string; body?: unknown; headers?: Record<string, string>; source?: string } = {}) {
  return new Request(`${appOrigin}${path}`, {
    method: init.method ?? "POST",
    headers: {
      origin: appOrigin, "sec-fetch-site": "same-origin", "content-type": "application/json",
      [clientSourceHeader]: init.source ?? "127.0.0.1", [sourceProofHeader]: proof,
      ...init.headers,
    },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
}

function signupRequest(body: unknown = person, key = "8f9c0a3e-5d2b-4c1a-9e7f-112233445566", source?: string) {
  return request("/api/v1/auth/teacher-signup", { body, headers: { "idempotency-key": key }, ...(source ? { source } : {}) });
}

function fakeAuth(status = 200, json: unknown = { id: "00000000-0000-4000-8000-000000000001" }) {
  const calls: { path: string; body: Record<string, unknown> }[] = [];
  const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(String(input));
    expect(url.origin).toBe("http://127.0.0.1:54321");
    expect(init?.redirect).toBe("error");
    calls.push({ path: url.pathname + url.search, body: JSON.parse(String(init?.body ?? "{}")) });
    if (url.pathname === "/auth/v1/logout") return new Response(null, { status: 204 });
    return Response.json(json, { status });
  });
  return { fetchImpl, calls };
}

const created = (): Promise<IntentResult> => Promise.resolve({ outcome: "created", intent: "3b0c6f8e-1a2b-4c3d-8e9f-001122334455" });

async function code(response: Response): Promise<string> {
  expect(response.headers.get("content-type")).toMatch(/^application\/problem\+json/);
  expect(response.headers.get("cache-control")).toContain("no-store");
  return ((await response.json()) as { code: string }).code;
}

describe("teacher signup isolated runtime", () => {
  it("只在明確隔離模式與完整職員登入隔離設定下啟用", () => {
    expect(readTeacherSignupRuntime(env).ok).toBe(true);
    for (const patch of [
      { APP_PLANET_TEACHER_SIGNUP_MODE: undefined }, { APP_PLANET_TEACHER_SIGNUP_MODE: "production" },
      { APP_PLANET_ENV: "production" }, { NODE_ENV: "production" }, { APP_PLANET_AUTH_ORIGIN: "https://auth.example.com" },
      { APP_PLANET_STAFF_LOGIN_MODE: undefined },
    ]) {
      expect(readTeacherSignupRuntime({ ...env, ...patch } as NodeJS.ProcessEnv).ok).toBe(false);
    }
  });

  it("設定缺失時三個入口與落點都關閉，且不呼叫 Auth 或 DB", async () => {
    const closed = { ...env, APP_PLANET_TEACHER_SIGNUP_MODE: "" } as NodeJS.ProcessEnv;
    const auth = fakeAuth();
    const register = vi.fn(created);
    expect(await code(await createTeacherSignupHandler({ env: closed, fetchImpl: auth.fetchImpl, registerIntent: register })(signupRequest())))
      .toBe("dependency_unavailable");
    expect(await code(await createTeacherSignupResendHandler({ env: closed, fetchImpl: auth.fetchImpl })(
      request("/api/v1/auth/teacher-signup/resend", { body: { email: person.email } })))).toBe("dependency_unavailable");
    expect(await code(await createTeacherSignupVerifyHandler({ env: closed, fetchImpl: auth.fetchImpl })(
      request("/api/v1/auth/teacher-signup/verify", { headers: { cookie: `${verifyCookieName}=${tokenHash}` } })))).toBe("dependency_unavailable");
    const landing = createEmailConfirmLandingHandler(closed)(new Request(`${appOrigin}/auth/confirm?token_hash=${tokenHash}&type=signup`));
    expect(landing.headers.get("set-cookie")).toBe(clearVerifyCookie);
    expect(auth.fetchImpl).not.toHaveBeenCalled();
    expect(register).not.toHaveBeenCalled();
  });
});

describe("teacher signup strict DTO", () => {
  it("只接受四個欄位；身分／權限自報欄位一律 unknown_field", () => {
    for (const key of ["role", "status", "user_id", "school_id", "email_confirmed", "verified", "redirect_to", "app_planet_signup_intent", "data"]) {
      expect(parseTeacherSignupBody({ ...person, [key]: "x" })).toEqual({ kind: "unknown_field" });
    }
    expect(parseResendBody({ email: person.email, redirect_to: "https://evil.example" })).toEqual({ kind: "unknown_field" });
  });

  it("密碼逐位元保留；顯示名稱／說明 NFC＋trim 後限長並拒絕控制／雙向格式字元", () => {
    const parsed = parseTeacherSignupBody({ ...person, display_name: "  王老師  " });
    expect(parsed).toEqual({ kind: "ok", value: {
      email: person.email, password: person.password, displayName: "王老師", schoolNote: person.school_note,
    } satisfies TeacherSignupInput });
    expect(normalizeSignupText("a".repeat(40), 40)).toBe("a".repeat(40));
    expect(normalizeSignupText("a".repeat(41), 40)).toBeNull();
    expect(normalizeSignupText("😀".repeat(40), 40)).toBe("😀".repeat(40));
    for (const bad of ["", "   ", "a\u0000b", "a\nb", "a\u202Eb", "a\u200Bb", "a\uFEFFb", "a\u2066b"]) {
      expect(normalizeSignupText(bad, 40)).toBeNull();
    }
    for (const patch of [
      { email: "not-an-email" }, { email: `${"a".repeat(250)}@x.io` }, { password: "short7!" },
      { password: "é".repeat(37) }, { display_name: "x".repeat(41) }, { school_note: "x".repeat(201) },
      { display_name: 7 }, { school_note: null },
    ]) {
      expect(parseTeacherSignupBody({ ...person, ...patch })).toEqual({ kind: "invalid" });
    }
    expect(parseTeacherSignupBody({ email: person.email, password: person.password, display_name: "x" })).toEqual({ kind: "invalid" });
    expect(parseTeacherSignupBody([])).toEqual({ kind: "invalid" });
  });
});

describe("teacher signup handler", () => {
  it("中性 202：只把四欄位與伺服器選擇子送 Auth；不送 redirect、role、status 或 verified", async () => {
    const auth = fakeAuth();
    const register = vi.fn(created);
    const response = await createTeacherSignupHandler({ env, fetchImpl: auth.fetchImpl, registerIntent: register, limiter: new SignupRateLimiter() })(signupRequest());
    expect(response.status).toBe(202);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(response.headers.get("set-cookie")).toBeNull();
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({ status: "submitted" });
    expect(text).not.toContain(person.password);
    expect(register).toHaveBeenCalledOnce();
    expect((register.mock.calls[0] as unknown[])[1]).toEqual({ email: person.email, password: person.password, displayName: "王老師", schoolNote: person.school_note });
    expect(auth.calls).toEqual([{ path: "/auth/v1/signup", body: {
      email: person.email, password: person.password, data: { app_planet_signup_intent: "3b0c6f8e-1a2b-4c3d-8e9f-001122334455" },
    } }]);
  });

  it("既有／已使用意圖不再呼叫 Auth；其他意圖結果對應受控問題碼", async () => {
    const cases: [IntentResult | { outcome: "unknown" }, number, string | null][] = [
      [{ outcome: "consumed" }, 202, null],
      [{ outcome: "expired" }, 409, "signup_operation_expired"],
      [{ outcome: "idempotency_key_reuse" }, 422, "idempotency_key_reuse"],
      [{ outcome: "invalid_input" }, 400, "invalid_request"],
      [{ outcome: "unavailable" }, 503, "dependency_unavailable"],
      [{ outcome: "unknown" }, 503, "signup_outcome_unknown"],
      [{ outcome: "in_flight" }, 202, null],
    ];
    for (const [result, status, problem] of cases) {
      const auth = fakeAuth();
      const response = await createTeacherSignupHandler({
        env, fetchImpl: auth.fetchImpl, registerIntent: async () => result, limiter: new SignupRateLimiter(),
      })(signupRequest());
      expect(response.status).toBe(status);
      if (problem) expect(await code(response)).toBe(problem);
      expect(auth.fetchImpl).not.toHaveBeenCalled();
    }
  });

  it("既有 Auth 帳號：不呼叫 signup 或自動重寄，回相同中性 202", async () => {
    const auth = fakeAuth(429, { msg: "rate limited" });
    const response = await createTeacherSignupHandler({
      env, fetchImpl: auth.fetchImpl, registerIntent: async () => ({ outcome: "existing" }), limiter: new SignupRateLimiter(),
    })(signupRequest());
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ status: "submitted" });
    expect(auth.calls).toEqual([]);
  });

  it("上游 200／429 中性；400／422 輸入拒絕；5xx、逾時與網路錯誤為結果不明", async () => {
    const input = { email: person.email, password: person.password, displayName: "x", schoolNote: "y" };
    for (const [status, expected] of [[200, "accepted"], [429, "accepted"], [400, "rejected_input"], [422, "rejected_input"],
      [500, "unknown"], [502, "unknown"], [403, "unknown"]] as const) {
      expect(await requestAuthSignup(input, "i", authConfig, fakeAuth(status, { msg: "upstream detail" }).fetchImpl)).toBe(expected);
    }
    expect(await requestAuthSignup(input, "i", authConfig, vi.fn<typeof fetch>(async () => { throw new TypeError("down"); }))).toBe("unknown");
    const auth = fakeAuth(500, { msg: "Database error saving new user" });
    const response = await createTeacherSignupHandler({ env, fetchImpl: auth.fetchImpl, registerIntent: created, limiter: new SignupRateLimiter() })(signupRequest());
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ status: "submitted" });
  });

  it("拒絕跨站、無來源證明、query、缺冪等鍵與未知欄位；均不登記意圖", async () => {
    const register = vi.fn(created);
    const handler = createTeacherSignupHandler({ env, fetchImpl: fakeAuth().fetchImpl, registerIntent: register, limiter: new SignupRateLimiter() });
    const cross = signupRequest();
    const crossHeaders = new Headers(cross.headers);
    crossHeaders.set("origin", "https://evil.example");
    expect(await code(await handler(new Request(cross.url, { method: "POST", headers: crossHeaders, body: JSON.stringify(person) }))))
      .toBe("forbidden");
    const noProof = new Headers(signupRequest().headers);
    noProof.delete(sourceProofHeader);
    expect(await code(await handler(new Request(`${appOrigin}/api/v1/auth/teacher-signup`, { method: "POST", headers: noProof, body: JSON.stringify(person) }))))
      .toBe("forbidden");
    expect(await code(await handler(new Request(`${appOrigin}/api/v1/auth/teacher-signup?redirect_to=x`, {
      method: "POST", headers: signupRequest().headers, body: JSON.stringify(person),
    })))).toBe("invalid_request");
    expect(await code(await handler(request("/api/v1/auth/teacher-signup", { body: person })))).toBe("idempotency_key_required");
    expect(await code(await handler(signupRequest({ ...person, role: "admin" })))).toBe("unknown_field");
    expect(register).not.toHaveBeenCalled();
  });

  it("依來源與 email 的 HMAC 鍵限流；第 6 次同 email 回 429 與 Retry-After", async () => {
    const limiter = new SignupRateLimiter();
    const handler = createTeacherSignupHandler({ env, fetchImpl: fakeAuth().fetchImpl, registerIntent: created, limiter });
    for (let index = 0; index < teacherSignupIsolatedTestPolicy.signupEmailLimit; index += 1) {
      expect((await handler(signupRequest(person, `8f9c0a3e-5d2b-4c1a-9e7f-${String(index).padStart(12, "0")}`, `127.0.0.${index + 2}`))).status).toBe(202);
    }
    const blocked = await handler(signupRequest(person, "8f9c0a3e-5d2b-4c1a-9e7f-999999999999", "127.0.0.99"));
    expect(blocked.status).toBe(429);
    expect(await code(blocked)).toBe("signup_throttled");
    expect(Number(blocked.headers.get("retry-after"))).toBeGreaterThan(0);
  });
});

describe("signup rate limiter", () => {
  it("所有鍵未超限才一起計數；視窗到期後重置；桶數上限 fail-closed", () => {
    let now = 0;
    const limiter = new SignupRateLimiter(1_000, 3, () => now);
    expect(limiter.take([{ key: "a", limit: 1 }, { key: "b", limit: 5 }]).ok).toBe(true);
    expect(limiter.take([{ key: "a", limit: 1 }, { key: "b", limit: 5 }])).toEqual({ ok: false, retryAfterSeconds: 1 });
    expect(limiter.take([{ key: "b", limit: 2 }]).ok).toBe(true);
    expect(limiter.take([{ key: "c", limit: 1 }, { key: "d", limit: 1 }]).ok).toBe(false);
    now = 1_000;
    expect(limiter.take([{ key: "a", limit: 1 }]).ok).toBe(true);
  });
});

describe("resend handler", () => {
  it("未知、既有、上游錯誤一律相同中性結果；只送 type=signup 與 email", async () => {
    const bodies: string[] = [];
    for (const status of [200, 422, 429, 500]) {
      const auth = fakeAuth(status, { msg: "upstream" });
      const response = await createTeacherSignupResendHandler({ env, fetchImpl: auth.fetchImpl, limiter: new SignupRateLimiter() })(
        request("/api/v1/auth/teacher-signup/resend", { body: { email: person.email } }));
      expect(response.status).toBe(202);
      bodies.push(await response.text());
      expect(auth.calls).toEqual([{ path: "/auth/v1/resend", body: { type: "signup", email: person.email } }]);
    }
    expect(new Set(bodies).size).toBe(1);
  });
});

describe("email confirm landing", () => {
  const land = (query: string) => createEmailConfirmLandingHandler(env)(new Request(`${appOrigin}/auth/confirm${query}`));

  it("只把合法 token_hash 移入短期 HttpOnly cookie，303 到固定不含秘密的頁面", () => {
    const response = land(`?token_hash=${tokenHash}&type=signup`);
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/signup/verify");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("set-cookie")).toBe(
      `${verifyCookieName}=${tokenHash}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${teacherSignupIsolatedTestPolicy.verifyCookieMaxAgeSeconds}`);
    expect(response.headers.get("location")).not.toContain(tokenHash);
  });

  it("caller 指定 redirect、錯誤 type、重複參數、大寫或過短 hash 一律清除並導回固定頁", () => {
    for (const query of [
      `?token_hash=${tokenHash}&type=signup&redirect_to=https%3A%2F%2Fevil.example`, `?token_hash=${tokenHash}&type=recovery`,
      `?token_hash=${tokenHash}&token_hash=${tokenHash}&type=signup`, `?token_hash=${tokenHash.toUpperCase()}&type=signup`,
      "?token_hash=abc&type=signup", `?token=${tokenHash}&type=signup`, "",
    ]) {
      const response = land(query);
      expect(response.headers.get("location")).toBe("/signup/verify");
      expect(response.headers.get("set-cookie")).toBe(clearVerifyCookie);
    }
  });

  it("cookie 讀取只接受唯一且格式正確的值", () => {
    expect(readVerifyCookie(`${verifyCookieName}=${tokenHash}`)).toBe(tokenHash);
    expect(readVerifyCookie(`a=1; ${verifyCookieName}=${tokenHash}`)).toBe(tokenHash);
    expect(readVerifyCookie(`${verifyCookieName}=${tokenHash}; ${verifyCookieName}=${tokenHash}`)).toBeNull();
    expect(readVerifyCookie(`${verifyCookieName}=zz`)).toBeNull();
    expect(readVerifyCookie(null)).toBeNull();
    expect(verifyCookie(tokenHash)).toContain("HttpOnly; Secure; SameSite=Strict");
  });
});

describe("verify handler", () => {
  const verifyRequest = (cookie?: string, method = "POST") =>
    request("/api/v1/auth/teacher-signup/verify", { method, headers: cookie ? { cookie } : {} });

  it("成功：以 POST token_hash 驗證、立即撤銷上游 session、不回傳 token 並清除 cookie", async () => {
    const auth = fakeAuth(200, validSession);
    const response = await createTeacherSignupVerifyHandler({ env, fetchImpl: auth.fetchImpl, limiter: new SignupRateLimiter() })(
      verifyRequest(`${verifyCookieName}=${tokenHash}`));
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({ status: "verified" });
    expect(text).not.toMatch(/synthetic\.verify|refresh|ab{2}/);
    expect(response.headers.get("set-cookie")).toBe(clearVerifyCookie);
    expect(auth.calls.map((call) => call.path)).toEqual(["/auth/v1/verify", "/auth/v1/logout?scope=local"]);
    expect(auth.calls[0]!.body).toEqual({ type: "signup", token_hash: tokenHash });
  });

  const validSession = {
    access_token: "synthetic.verify.token", refresh_token: "r", token_type: "bearer", expires_in: 3600,
    user: { id: "00000000-0000-4000-8000-000000000001", email: "teacher@example.invalid", email_confirmed_at: "2026-11-03T00:00:00Z" },
  };

  describe("§92 Auth 200 fail-closed", () => {
    const malformed: [string, () => Response][] = [
      ["empty", () => new Response(null, { headers: { "content-type": "application/json" } })],
      ["empty object", () => Response.json({})],
      ["unexpected object", () => Response.json({ unexpected: true })],
      ["missing identity", () => Response.json({ ...validSession, user: {} })],
      ["metadata is not confirmation", () => Response.json({ ...validSession, user: { ...validSession.user, email_confirmed_at: null, user_metadata: { verified: true } } })],
      ["invalid token", () => Response.json({ ...validSession, access_token: "not a token" })],
      ["missing session", () => Response.json({ user: validSession.user })],
      ["wrong token type", () => Response.json({ ...validSession, token_type: "other" })],
      ["non JSON", () => new Response(JSON.stringify(validSession), { headers: { "content-type": "text/plain" } })],
      ["lookalike MIME", () => new Response(JSON.stringify(validSession), { headers: { "content-type": "application/json-fake" } })],
      ["wrong charset", () => new Response(JSON.stringify(validSession), { headers: { "content-type": "application/json; charset=iso-8859-1" } })],
      ["invalid UTF8", () => new Response(new Uint8Array([0xc3, 0x28]), { headers: { "content-type": "application/json" } })],
      ["oversized", () => Response.json({ ...validSession, padding: "x".repeat(65_536) })],
      ["truncated", () => new Response('{"access_token":', { headers: { "content-type": "application/json" } })],
      ["interrupted", () => new Response(new ReadableStream({ start(controller) { controller.error(new TypeError("interrupted")); } }),
        { headers: { "content-type": "application/json" } })],
    ];
    it.each(malformed)("%s 不宣告 verified、不以成功語意清除恢復 cookie", async (_name, makeResponse) => {
      const fetchImpl: typeof fetch = async (url) => String(url).includes("/logout")
        ? new Response(null, { status: 204 }) : makeResponse();
      const response = await createTeacherSignupVerifyHandler({ env, fetchImpl, limiter: new SignupRateLimiter() })(
        request("/api/v1/auth/teacher-signup/verify", { headers: { cookie: `${verifyCookieName}=${tokenHash}` } }),
      );
      expect(await code(response)).toBe("verification_outcome_unknown");
      expect(response.headers.get("set-cookie")).toBeNull();
    });

    it("body timeout 受界線中止且不宣告成功", async () => {
      vi.useFakeTimers();
      try {
        const result = requestAuthVerify(tokenHash, authConfig, async () => new Response(new ReadableStream(),
          { headers: { "content-type": "application/json" } }));
        await vi.advanceTimersByTimeAsync(teacherSignupIsolatedTestPolicy.authTimeoutMs + 1);
        expect(await result).toBe("unknown");
      } finally { vi.useRealTimers(); }
    });

    it("合法身分事實與撤銷失敗分開回報，不發 session cookie 或 token", async () => {
      const fetchImpl: typeof fetch = async (url) => String(url).includes("/logout")
        ? new Response(null, { status: 503 }) : Response.json(validSession);
      const response = await createTeacherSignupVerifyHandler({ env, fetchImpl, limiter: new SignupRateLimiter() })(
        request("/api/v1/auth/teacher-signup/verify", { headers: { cookie: `${verifyCookieName}=${tokenHash}` } }),
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ status: "verified", session_cleanup: "unknown" });
      expect(response.headers.getSetCookie()).toEqual([clearVerifyCookie]);
    });
  });

  it("無效／已用／逾期清除 cookie；上游不明保留 cookie；節流回 429；無 cookie 不呼叫 Auth", async () => {
    const run = async (status: number | "throw", cookie: string | null = `${verifyCookieName}=${tokenHash}`) => {
      const fetchImpl = status === "throw"
        ? vi.fn<typeof fetch>(async () => { throw new TypeError("down"); })
        : fakeAuth(status, { error_code: "otp_expired", msg: "Email link is invalid or has expired" }).fetchImpl;
      const response = await createTeacherSignupVerifyHandler({ env, fetchImpl, limiter: new SignupRateLimiter() })(verifyRequest(cookie ?? undefined));
      return { response, fetchImpl, text: await response.clone().text() };
    };
    for (const status of [400, 401, 403, 404, 422]) {
      const { response, text } = await run(status);
      expect(await code(response)).toBe("verification_link_invalid");
      expect(response.headers.get("set-cookie")).toBe(clearVerifyCookie);
      expect(text).not.toMatch(/otp_expired|Email link/);
    }
    for (const status of [500, 503, "throw"] as const) {
      const { response } = await run(status);
      expect(await code(response)).toBe("verification_outcome_unknown");
      expect(response.headers.get("set-cookie")).toBeNull();
    }
    expect(await code((await run(429)).response)).toBe("signup_throttled");
    const missing = await run(200, null);
    expect(await code(missing.response)).toBe("verification_link_invalid");
    expect(missing.fetchImpl).not.toHaveBeenCalled();
    expect(await requestAuthVerify(tokenHash, authConfig, fakeAuth(200, { unexpected: true }).fetchImpl)).toBe("unknown");
  });

  it("DELETE 取消只清除 cookie，不呼叫 Auth", async () => {
    const auth = fakeAuth();
    const response = await createTeacherSignupVerifyHandler({ env, fetchImpl: auth.fetchImpl })(
      verifyRequest(`${verifyCookieName}=${tokenHash}`, "DELETE"));
    expect(response.status).toBe(204);
    expect(response.headers.get("set-cookie")).toBe(clearVerifyCookie);
    expect(auth.fetchImpl).not.toHaveBeenCalled();
  });
});

describe("staff login email verification mapping", () => {
  it("只有上游 error_code=email_not_confirmed 才對應未驗證；其他 400 仍是一般憑證失敗", async () => {
    const input = { email: person.email, password: person.password };
    expect(await requestPasswordGrant(input, authConfig, vi.fn<typeof fetch>(async () =>
      Response.json({ error_code: "email_not_confirmed", msg: "Email not confirmed" }, { status: 400 }))))
      .toEqual({ outcome: "email_not_confirmed" });
    expect(await requestPasswordGrant(input, authConfig, vi.fn<typeof fetch>(async () =>
      Response.json({ error_code: "invalid_credentials" }, { status: 400 })))).toEqual({ outcome: "invalid" });
    expect(await requestPasswordGrant(input, authConfig, vi.fn<typeof fetch>(async () =>
      Response.json({ email_not_confirmed: true }, { status: 400 })))).toEqual({ outcome: "invalid" });
  });
});
