import { describe, expect, it } from "vitest";
import {
  createTeacherSignupHandler, SignupRateLimiter, type IntentResult,
} from "../../apps/web/src/server/auth/teacher-signup.ts";

const origin = "https://localhost:3443";
const proof = "c3".repeat(32);
const env = {
  ...process.env, NODE_ENV: "test", APP_PLANET_ENV: "isolated-local-test", APP_PLANET_LOCAL_AUTH: "1",
  APP_PLANET_AUTH_ORIGIN: "http://127.0.0.1:54321", APP_PLANET_APP_ORIGIN: origin,
  APP_PLANET_AUTH_API_KEY: "public-test-key", APP_PLANET_DATABASE_URL: "postgresql://synthetic@127.0.0.1:5432/app",
  APP_PLANET_STAFF_LOGIN_MODE: "isolated-local-test", APP_PLANET_TEACHER_SIGNUP_MODE: "isolated-local-test",
  APP_PLANET_STAFF_LOGIN_THROTTLE_BACKEND: "memory-single-process", APP_PLANET_STAFF_LOGIN_HMAC_SECRET: "d4".repeat(32),
  APP_PLANET_SOURCE_PROXY_PROOF: proof, APP_PLANET_STAFF_SESSION_MAX_AGE_SECONDS: "900",
};

describe("§92 中性接受不是派送／建立帳號證明", () => {
  it.each(["created", "existing", "consumed", "in_flight"] as const)("%s 只回相同最小投影；非首次不得呼叫 Auth", async (outcome) => {
    const intent: IntentResult = outcome === "created"
      ? { outcome, intent: "00000000-0000-4000-8000-000000000001" } : { outcome };
    let calls = 0;
    const response = await createTeacherSignupHandler({
      env, limiter: new SignupRateLimiter(), registerIntent: async () => intent,
      fetchImpl: async () => { calls++; throw new TypeError("controlled unknown"); },
    })(new Request(`${origin}/api/v1/auth/teacher-signup`, {
      method: "POST", headers: {
        origin, "sec-fetch-site": "same-origin", "content-type": "application/json",
        "idempotency-key": "00000000-0000-4000-8000-000000000002",
        "x-app-planet-client-source": "127.0.0.1", "x-app-planet-source-proof": proof,
      },
      body: JSON.stringify({ email: "synthetic@example.invalid", password: "synthetic-only-9!",
        display_name: "合成教師", school_note: "合成任教說明" }),
    }));
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ status: "submitted" });
    const headers = Object.fromEntries(response.headers);
    expect(headers["x-request-id"]).toMatch(/^req_/);
    delete headers["x-request-id"];
    expect(headers).toEqual({ "cache-control": "no-store", "content-type": "application/json; charset=utf-8",
      "x-content-type-options": "nosniff" });
    expect(calls).toBe(outcome === "created" ? 1 : 0);
  });
});
