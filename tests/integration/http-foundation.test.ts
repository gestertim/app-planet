import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { Pool } from "pg";
import { chromium, expect as expectPage, type Browser } from "@playwright/test";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { UsageContext } from "@app-planet/core";
import { createOwnedProjectSubset } from "../../apps/web/src/server/projects.ts";
import { saveOwnedStageDraftSubset } from "../../apps/web/src/server/stage-drafts.ts";
import { createCheckpoints } from "../../apps/worker/src/jobs/checkpoint.ts";
import { localPools, syntheticContext, syntheticCreationContext } from "./authorization-context.ts";
import { startHarness, type Harness } from "./http-harness.ts";
import { StageDraftSaveController } from "../../apps/web/src/components/project/save-controller.ts";
import { createHttpSaveAdapter } from "../../apps/web/src/components/project/http-save-adapter.ts";
import { presentSaveState } from "../../apps/web/src/components/operation-presentation.ts";

// 全部資料為合成；測試身分只存在於 http-harness（測試專用），不屬於產品路由。
const { control, parallelAuthorization, authorization } = localPools();
const actors = new Pool({
  host: "127.0.0.1", port: Number(process.env.APP_PLANET_PGTAP_PORT),
  database: "postgres", user: "app_usage_test",
  password: process.env.APP_PLANET_AUTHORIZATION_PASSWORD,
  max: 12, connectionTimeoutMillis: 5000, query_timeout: 8000,
});
const actor = (n: number) => `b7000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const school = (n: number) => `b7100000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const SECRET_TEXT = "SYNTHETIC-SECRET-DRAFT-BODY-7731";
const TOKEN = (n: number) => `synthetic-token-${n}-DO-NOT-LOG`;
const policy = randomUUID();
const projects = new Set<string>();
let harness: Harness;
let edgeBrowser: Browser | null = null;

function usageContext(subject: string): UsageContext {
  return {
    async runTransaction(operation) {
      const client = await actors.connect();
      let reusable = false;
      try {
        await client.query("BEGIN");
        await client.query("SET LOCAL ROLE app_usage_executor");
        await client.query("SELECT set_config('request.jwt.claim.sub',$1,true)", [subject]);
        const result = await operation(client);
        await client.query("COMMIT");
        reusable = true;
        return result;
      } finally {
        client.release(!reusable);
      }
    },
  };
}
function workerContext(): UsageContext {
  return {
    async runTransaction(operation) {
      const client = await actors.connect();
      let reusable = false;
      try {
        await client.query("BEGIN");
        await client.query("SET LOCAL ROLE app_job_executor");
        await client.query("SELECT set_config('request.jwt.claim.sub',$1,true)", [actor(1)]);
        const result = await operation(client);
        await client.query("COMMIT");
        reusable = true;
        return result;
      } finally {
        client.release(!reusable);
      }
    },
  };
}

const headers = (n: number, extra: Record<string, string> = {}) => ({
  "x-test-principal": TOKEN(n), "content-type": "application/json", ...extra,
});
const draftUrl = (projectId: string, stage = "Specification") =>
  `${harness.url}/test/projects/${projectId}/stages/${stage}/draft`;
const put = (projectId: string, n: number, text: string, extra: Record<string, string> = {}) =>
  fetch(draftUrl(projectId), {
    method: "PUT", headers: headers(n, extra), body: JSON.stringify({ content: { text } }),
  });
const postJob = (n: number, key: string, estimate = "30", extra: Record<string, string> = {}) =>
  fetch(`${harness.url}/test/jobs`, {
    method: "POST", headers: headers(n, { "idempotency-key": key, ...extra }),
    body: JSON.stringify({ policy_id: policy, estimate_micro: estimate }),
  });
const cancelJob = (n: number, id: string) =>
  fetch(`${harness.url}/test/jobs/${id}/cancel`, { method: "POST", headers: headers(n) });

async function seedProject(n = 1, withDraft = true): Promise<string> {
  const created = await createOwnedProjectSubset(
    syntheticCreationContext(authorization, actor(n)), { title: "synthetic-http-foundation" }, randomUUID(),
  );
  if (created.outcome !== "created") throw new Error("合成專案建立失敗");
  projects.add(created.project.id);
  if (!withDraft) return created.project.id;
  const first = await saveOwnedStageDraftSubset(syntheticCreationContext(authorization, actor(n)),
    { project_id: created.project.id, stage: "Specification", expected_row_version: null, content: { text: "v0" } },
    randomUUID());
  if (first.outcome !== "saved") throw new Error("合成草稿建立失敗");
  return created.project.id;
}

async function openEdgeEditor(projectId: string, withDraft = true) {
  if (!edgeBrowser) throw new Error("Edge 瀏覽器未啟動");
  const context = await edgeBrowser.newContext();
  const token = harness.issueBrowserSession(actor(1));
  await context.addCookies([{
    name: "app-planet-test-session",
    value: token,
    url: harness.url,
    httpOnly: true,
    sameSite: "Strict",
  }]);
  const page = await context.newPage();
  await page.goto(`${harness.url}/__test__/save-editor?project_id=${encodeURIComponent(projectId)}&stage=Specification`);
  await expectPage(page.getByLabel("階段草稿文字")).toBeVisible();
  if (withDraft) await expectPage(page.getByTestId("confirmed-server-draft")).toHaveText("伺服器版本 0：v0");
  else await expectPage(page.getByTestId("confirmed-server-draft")).toHaveCount(0);
  return { context, page };
}
async function draftRows(projectId: string) {
  return (await control.query(
    "SELECT row_version,content FROM app.stage_records WHERE project_id=$1 AND stage='Specification'", [projectId],
  )).rows;
}
async function jobCounts() {
  const q = async (t: string) => Number((await control.query(`SELECT count(*) FROM app.${t}`)).rows[0].count);
  return { jobs: await q("jobs"), reservations: await q("usage_reservations"), audit: await q("usage_audit") };
}
async function problem(response: Response) {
  expect(response.headers.get("content-type")).toContain("application/problem+json");
  expect(response.headers.get("cache-control")).toBe("no-store");
  const body = await response.json() as Record<string, unknown>;
  expect(body.request_id).toBe(response.headers.get("x-request-id"));
  expect(JSON.stringify(body)).not.toMatch(/SELECT|INSERT|stack|\bat\s.+\(|127\.0\.0\.1|postgres|password/i);
  return body;
}

beforeAll(async () => {
  harness = await startHarness({
    read: (s) => syntheticContext(parallelAuthorization, s),
    write: (s) => syntheticCreationContext(parallelAuthorization, s),
    usage: usageContext,
  }, { browserHost: true });
  for (const n of [1, 2]) {
    await control.query(`INSERT INTO app.schools(id,label,approval_state,approval_epoch,created_at,updated_at)
      VALUES ($1,'synthetic-http-school','approved',1,now(),now())`, [school(n)]);
  }
  for (const n of [1, 2, 3]) {
    await control.query("INSERT INTO auth.users(id) VALUES ($1)", [actor(n)]);
    await control.query(`INSERT INTO app.profiles(id,role,status,deletion_state,school_id,display_label,status_changed_at)
      VALUES ($1,'student','approved','none',$2,'synthetic-http-actor',now())`, [actor(n), school(n === 3 ? 2 : 1)]);
    harness.register(TOKEN(n), actor(n));
  }
  edgeBrowser = await chromium.launch({ channel: "msedge", headless: true, timeout: 30_000 });
});
beforeEach(async () => {
  harness.faults.dropResponseAfterHandler = false;
  harness.faults.malformedSuccessResponse = false;
  harness.faults.beforeExecute = undefined;
  harness.logs.length = 0;
  await control.query(`TRUNCATE app.usage_audit,app.jobs,app.usage_reservations,app.usage_totals,
    app.model_prices,app.quota_policies,app.pool_limits,app.budget_pools`);
  await control.query("INSERT INTO app.budget_pools VALUES ('internal_ai','synthetic-creator')");
  await control.query(`INSERT INTO app.pool_limits VALUES
    ('internal_ai',date_trunc('month',now() AT TIME ZONE 'Asia/Taipei')::date,100000,$1)`, [randomUUID()]);
  await control.query(`INSERT INTO app.quota_policies VALUES
    ($1,'synthetic',$2,'student','learner_feature','synthetic-model','agent',
    'daily',10000,1000,100,3,true)`, [policy, randomUUID()]);
  await control.query(`INSERT INTO app.model_prices VALUES
    ('synthetic-model','2020-01-01Z',1000000,500000,2000000,7,
    'https://example.invalid/synthetic-price','2026-10-26')`);
});
afterEach(async () => {
  const ids = [...projects];
  if (ids.length) {
    await control.query("DELETE FROM app.stage_draft_idempotency WHERE project_id=ANY($1::uuid[])", [ids]);
    await control.query("DELETE FROM app.stage_records WHERE project_id=ANY($1::uuid[])", [ids]);
    await control.query("DELETE FROM app.project_create_idempotency WHERE project_id=ANY($1::uuid[])", [ids]);
    await control.query("DELETE FROM app.projects WHERE id=ANY($1::uuid[])", [ids]);
    projects.clear();
  }
  await control.query("UPDATE app.profiles SET role='student',status='approved',deletion_state='none' WHERE id=ANY($1::uuid[])",
    [[1, 2, 3].map(actor)]);
  await control.query("UPDATE app.schools SET approval_state='approved' WHERE id=ANY($1::uuid[])", [[school(1), school(2)]]);
});
afterAll(async () => {
  try {
    const browser = edgeBrowser;
    const closeResults = await Promise.allSettled([
      edgeBrowser?.close(),
      harness.close(),
    ]);
    edgeBrowser = null;
    const closeFailure = closeResults.find((result) => result.status === "rejected");
    if (closeFailure?.status === "rejected") throw closeFailure.reason;
    expect(browser?.isConnected()).toBe(false);
    console.info("EDGE_CLOSED", JSON.stringify({ pid: process.pid, connected: browser?.isConnected() }));
    for (const table of ["usage_audit", "jobs", "usage_reservations", "usage_totals", "model_prices", "quota_policies", "pool_limits", "budget_pools"]) {
      await control.query(`DELETE FROM app.${table}`);
    }
    for (const n of [1, 2, 3]) {
      await control.query("DELETE FROM app.profiles WHERE id=$1", [actor(n)]);
      await control.query("DELETE FROM auth.users WHERE id=$1", [actor(n)]);
    }
    await control.query("DELETE FROM app.schools WHERE id=ANY($1::uuid[])", [[school(1), school(2)]]);
    const idle = await control.query(`SELECT count(*)::int AS n FROM pg_stat_activity
      WHERE datname='postgres' AND state LIKE 'idle in transaction%'`);
    expect(idle.rows[0].n).toBe(0);
  } finally {
    await Promise.all([actors.end(), authorization.end(), parallelAuthorization.end(), control.end()]);
    console.info("DB_POOLS_CLOSED", JSON.stringify({
      pid: process.pid,
      connections: [actors, authorization, parallelAuthorization, control].map((pool) => pool.totalCount),
    }));
  }
});

describe("T011 可信 principal 與授權邊界（真實 HTTP + PostgreSQL）", () => {
  it("無／未知身分一律 401 problem+json，Body／Header 自報 subject 與 role 不被採信", async () => {
    const projectId = await seedProject();
    const attempts: Array<Record<string, string>> = [
      {}, { "x-test-principal": "unknown-token" },
      { "x-subject": actor(1), "x-role": "admin", "x-school-id": school(1) },
    ];
    for (const extra of attempts) {
      const response = await fetch(draftUrl(projectId), {
        method: "PUT",
        headers: { "content-type": "application/json", "idempotency-key": randomUUID(), "if-match": "\"0\"", ...extra },
        body: JSON.stringify({ content: { text: "x" }, subject: actor(1), role: "admin" }),
      });
      expect(response.status).toBe(401);
      expect((await problem(response)).code).toBe("unauthenticated");
    }
    expect(await draftRows(projectId)).toMatchObject([{ row_version: 0, content: { text: "v0" } }]);
  });
  it("產品解析器預設關閉：即使帶測試 token 也 401，且 apps/web 不含測試身分入口", async () => {
    const closed = await startHarness({
      read: () => { throw new Error("不應建立 session"); },
      write: () => { throw new Error("不應建立 session"); },
      usage: () => { throw new Error("不應建立 session"); },
    }, { productResolver: true });
    try {
      closed.register(TOKEN(1), actor(1));
      const response = await fetch(`${closed.url}/test/jobs/${randomUUID()}`, { headers: headers(1) });
      expect(response.status).toBe(401);
      expect((await problem(response)).code).toBe("unauthenticated");
    } finally {
      await closed.close();
    }
    const walk = (dir: string): string[] => readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      if (name === "node_modules" || name === ".next") return [];
      return statSync(path).isDirectory() ? walk(path) : /\.(ts|tsx)$/.test(name) ? [path] : [];
    });
    const offenders = walk("apps/web/src").filter((file) => {
      const text = readFileSync(file, "utf8");
      return /x-test-principal|syntheticContext|syntheticCreationContext|app_usage_test|app_authorization_test/.test(text);
    });
    expect(offenders).toEqual([]);
  });
  it("跨帳號與不存在專案同樣 404；停用與降權後即使重送既有鍵也重新拒絕", async () => {
    const projectId = await seedProject();
    const stranger = await put(projectId, 3, "x", { "idempotency-key": randomUUID(), "if-match": "\"0\"" });
    expect(stranger.status).toBe(404);
    const missing = await put(randomUUID(), 1, "x", { "idempotency-key": randomUUID(), "if-match": "\"0\"" });
    expect(missing.status).toBe(404);
    expect(await draftRows(projectId)).toMatchObject([{ row_version: 0 }]);

    const key = randomUUID();
    const ok = await put(projectId, 1, "v1", { "idempotency-key": key, "if-match": "\"0\"" });
    expect(ok.status).toBe(200);
    for (const change of [
      "UPDATE app.profiles SET status='disabled' WHERE id=$1",
      "UPDATE app.profiles SET role='teacher' WHERE id=$1",
      "UPDATE app.profiles SET status='pending' WHERE id=$1",
    ]) {
      await control.query("UPDATE app.profiles SET role='student',status='approved' WHERE id=$1", [actor(1)]);
      await control.query(change, [actor(1)]);
      const replay = await put(projectId, 1, "v1", { "idempotency-key": key, "if-match": "\"0\"" });
      expect([403, 404]).toContain(replay.status);
      const body = await problem(replay);
      expect(JSON.stringify(body)).not.toContain("v1");
    }
    expect(await draftRows(projectId)).toMatchObject([{ row_version: 1, content: { text: "v1" } }]);
  });
});

describe("§79 首次 HTTP 保存契約與原子性", () => {
  const createHeaders = (key = randomUUID()) => ({ "idempotency-key": key, "if-none-match": "*" });
  async function sideEffects(projectId: string) {
    return {
      drafts: await draftRows(projectId),
      receipts: (await control.query(
        "SELECT request_payload,response FROM app.stage_draft_idempotency WHERE project_id=$1", [projectId],
      )).rows,
      usage: await jobCounts(),
    };
  }

  it("首建 201／Location／ETag 0，更新 200／版本 1；If-Match 0 不能建立", async () => {
    const projectId = await seedProject(1, false);
    expect((await put(projectId, 1, "not-create", {
      "idempotency-key": randomUUID(), "if-match": "\"0\"",
    })).status).toBe(404);
    expect((await sideEffects(projectId)).receipts).toEqual([]);
    const created = await put(projectId, 1, "first", createHeaders());
    expect(created.status).toBe(201);
    expect(created.headers.get("location")).toBe(`/api/v1/projects/${projectId}/stages/Specification`);
    expect(created.headers.get("etag")).toBe("\"0\"");
    expect(await created.json()).toMatchObject({
      project_id: projectId, stage: "Specification", row_version: 0, content: { text: "first" },
      state: "ai_draft", content_source: "student_input", approved_by: null, approved_at: null,
    });
    const updated = await put(projectId, 1, "second", {
      "idempotency-key": randomUUID(), "if-match": "\"0\"",
    });
    expect(updated.status).toBe(200);
    expect(updated.headers.get("etag")).toBe("\"1\"");
    expect(await updated.json()).toMatchObject({ row_version: 1, content: { text: "second" } });
  });

  it("不同鍵 8 路首建只有一次 201，其餘 412，失敗無 receipt／audit 副作用", async () => {
    const projectId = await seedProject(1, false);
    const responses = await Promise.all(Array.from({ length: 8 }, (_, i) =>
      put(projectId, 1, `first-${i}`, createHeaders())));
    expect(responses.map((r) => r.status).sort()).toEqual([201, ...Array(7).fill(412)]);
    const before = await sideEffects(projectId);
    expect(before.drafts).toHaveLength(1);
    expect(before.receipts).toHaveLength(1);
    for (const response of responses.filter((r) => r.status === 412)) {
      expect((await problem(response)).code).toBe("draft_already_exists");
    }
    const exists = await put(projectId, 1, "must-not-overwrite", createHeaders());
    expect(exists.status).toBe(412);
    expect(await sideEffects(projectId)).toEqual(before);
  });

  it("同鍵 8 路首建一次 201，其餘 200 replay，首建意圖 null 不混用 0", async () => {
    const projectId = await seedProject(1, false);
    const key = randomUUID();
    const responses = await Promise.all(Array.from({ length: 8 }, () =>
      put(projectId, 1, "same-first", createHeaders(key))));
    expect(responses.map((r) => r.status).sort()).toEqual([...Array(7).fill(200), 201]);
    for (const replay of responses.filter((r) => r.status === 200)) {
      expect(replay.headers.get("idempotent-replay")).toBe("true");
      expect(await replay.json()).toMatchObject({
        operation: { row_version: 0 }, current_draft: { row_version: 0 },
      });
    }
    const effects = await sideEffects(projectId);
    expect(effects.receipts).toHaveLength(1);
    expect(effects.receipts[0].request_payload.expected_row_version).toBeNull();
    const otherTarget = await seedProject(1, false);
    for (const [id, text, precondition] of [
      [projectId, "changed", { "if-none-match": "*" }],
      [otherTarget, "same-first", { "if-none-match": "*" }],
      [projectId, "same-first", { "if-match": "\"0\"" }],
    ] as const) {
      const mismatch = await put(id, 1, text, { "idempotency-key": key, ...precondition });
      expect(mismatch.status).toBe(422);
      expect((await problem(mismatch)).code).toBe("idempotency_key_reuse");
    }
    expect(await sideEffects(projectId)).toEqual(effects);
    expect(await draftRows(otherTarget)).toEqual([]);
  });

  it("首建 COMMIT 後 response loss、較新 current 與刪除後 replay 不重建／不捏造 ETag", async () => {
    const projectId = await seedProject(1, false);
    const key = randomUUID();
    harness.faults.dropResponseAfterHandler = true;
    await expect(put(projectId, 1, "original-first", createHeaders(key))).rejects.toThrow();
    harness.faults.dropResponseAfterHandler = false;
    const replay = await put(projectId, 1, "original-first", createHeaders(key));
    expect(replay.status).toBe(200);
    expect(replay.headers.get("idempotent-replay")).toBe("true");
    expect(await replay.json()).toMatchObject({ operation: { row_version: 0 }, current_draft: { row_version: 0 } });
    await put(projectId, 1, "newer", { "idempotency-key": randomUUID(), "if-match": "\"0\"" });
    const newer = await put(projectId, 1, "original-first", createHeaders(key));
    expect(newer.headers.get("etag")).toBe("\"1\"");
    expect(await newer.json()).toMatchObject({
      operation: { row_version: 0, content: { text: "original-first" } },
      current_draft: { row_version: 1, content: { text: "newer" } },
    });
    await control.query("DELETE FROM app.stage_records WHERE project_id=$1", [projectId]);
    const deleted = await put(projectId, 1, "original-first", createHeaders(key));
    expect(deleted.status).toBe(200);
    expect(deleted.headers.has("etag")).toBe(false);
    expect(await deleted.json()).toMatchObject({ operation: { row_version: 0 }, current_draft: null });
    expect(await draftRows(projectId)).toEqual([]);
  });

  it("缺漏／並存／非法／重複多值前置即使是已成功鍵仍拒絕，無副作用", async () => {
    const projectId = await seedProject(1, false);
    const key = randomUUID();
    expect((await put(projectId, 1, "first", createHeaders(key))).status).toBe(201);
    const before = await sideEffects(projectId);
    const cases: Array<[Record<string, string>, string]> = [
      [{}, "precondition_required"],
      [{ "if-match": "\"0\"", "if-none-match": "*" }, "invalid_precondition"],
      ...["\"0\"", "W/\"0\"", "*, *", "*, \"0\"", ""].map((value) =>
        [{ "if-none-match": value }, "invalid_precondition"] as [Record<string, string>, string]),
      ...["*", "\"0\", \"0\"", "\"2147483648\""].map((value) =>
        [{ "if-match": value }, "invalid_precondition"] as [Record<string, string>, string]),
    ];
    for (const [extra, code] of cases) {
      const response = await put(projectId, 1, "first", { "idempotency-key": key, ...extra });
      expect(response.status).toBe(400);
      expect((await problem(response)).code).toBe(code);
    }
    for (const name of ["if-match", "if-none-match"]) {
      const duplicate = new Headers(headers(1, { "idempotency-key": key }));
      duplicate.append(name, name === "if-match" ? "\"0\"" : "*");
      duplicate.append(name, name === "if-match" ? "\"0\"" : "*");
      const response = await fetch(draftUrl(projectId), {
        method: "PUT", headers: duplicate, body: JSON.stringify({ content: { text: "first" } }),
      });
      expect(response.status).toBe(400);
      expect((await problem(response)).code).toBe("invalid_precondition");
    }
    expect(await sideEffects(projectId)).toEqual(before);
  });

  it("首建及重放重新授權：跨帳號／不存在隱匿，失效／停用／降權不洩漏", async () => {
    const projectId = await seedProject(1, false);
    const key = randomUUID();
    expect((await put(projectId, 1, SECRET_TEXT, createHeaders(key))).status).toBe(201);
    for (const id of [projectId, randomUUID()]) {
      const denied = await put(id, 3, SECRET_TEXT, createHeaders(key));
      expect(denied.status).toBe(404);
      expect(JSON.stringify(await problem(denied))).not.toContain(SECRET_TEXT);
    }
    for (const change of [
      "UPDATE app.profiles SET status='disabled' WHERE id=$1",
      "UPDATE app.profiles SET role='teacher' WHERE id=$1",
    ]) {
      try {
        await control.query(change, [actor(1)]);
        const denied = await put(projectId, 1, SECRET_TEXT, createHeaders(key));
        expect(denied.status).toBe(403);
        expect(JSON.stringify(await problem(denied))).not.toContain(SECRET_TEXT);
      } finally {
        await control.query("UPDATE app.profiles SET role='student',status='approved' WHERE id=$1", [actor(1)]);
      }
    }
    const expired = await fetch(draftUrl(projectId), {
      method: "PUT", headers: { "content-type": "application/json", ...createHeaders(key) },
      body: JSON.stringify({ content: { text: SECRET_TEXT } }),
    });
    expect(expired.status).toBe(401);
    expect(JSON.stringify(await problem(expired))).not.toContain(SECRET_TEXT);
    harness.faults.beforeExecute = async () => {
      await control.query("UPDATE app.profiles SET status='disabled' WHERE id=$1", [actor(1)]);
    };
    const changedAfterGate = await put(projectId, 1, SECRET_TEXT, createHeaders(key));
    expect(changedAfterGate.status).toBe(403);
    expect(await draftRows(projectId)).toMatchObject([{ row_version: 0 }]);
  });

  it("receipt 寫入時故障整筆回滾，再用原鍵首建正確成功", async () => {
    const projectId = await seedProject(1, false);
    const key = randomUUID();
    const before = await sideEffects(projectId);
    await control.query(`CREATE FUNCTION app.test_first_save_fault() RETURNS trigger
      LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic receipt failure'; END $$`);
    await control.query(`CREATE TRIGGER test_first_save_fault BEFORE UPDATE ON app.stage_draft_idempotency
      FOR EACH ROW EXECUTE FUNCTION app.test_first_save_fault()`);
    try {
      const failed = await put(projectId, 1, "atomic", createHeaders(key));
      expect(failed.status).toBe(503);
      expect((await problem(failed)).code).toBe("operation_outcome_unknown");
      expect(await sideEffects(projectId)).toEqual(before);
    } finally {
      await control.query("DROP TRIGGER test_first_save_fault ON app.stage_draft_idempotency");
      await control.query("DROP FUNCTION app.test_first_save_fault()");
    }
    expect((await put(projectId, 1, "atomic", createHeaders(key))).status).toBe(201);
    expect((await sideEffects(projectId)).receipts).toHaveLength(1);
  });

  it("首建 DB 重驗 handler 後撤權；舊 receipt 在 owner 改變後不洩漏／不復活", async () => {
    const projectId = await seedProject(1, false);
    const key = randomUUID();
    harness.faults.beforeExecute = async () => {
      await control.query("UPDATE app.profiles SET status='disabled' WHERE id=$1", [actor(1)]);
    };
    const denied = await put(projectId, 1, SECRET_TEXT, createHeaders(key));
    expect(denied.status).toBe(403);
    expect((await sideEffects(projectId)).receipts).toHaveLength(0);
    expect(await draftRows(projectId)).toEqual([]);
    harness.faults.beforeExecute = undefined;
    await control.query("UPDATE app.profiles SET status='approved' WHERE id=$1", [actor(1)]);
    expect((await put(projectId, 1, SECRET_TEXT, createHeaders(key))).status).toBe(201);
    await control.query("UPDATE app.projects SET owner_id=$2 WHERE id=$1", [projectId, actor(3)]);
    const before = await sideEffects(projectId);
    const replay = await put(projectId, 1, SECRET_TEXT, createHeaders(key));
    expect(replay.status).toBe(404);
    expect(JSON.stringify(await problem(replay))).not.toContain(SECRET_TEXT);
    expect(await sideEffects(projectId)).toEqual(before);
  });

  it("空本文為合法首建，Location 正確編碼含斜線的正式階段", async () => {
    const projectId = await seedProject(1, false);
    const response = await fetch(
      `${harness.url}/api/v1/projects/${projectId}/stages/${encodeURIComponent("UX/UI")}`, {
        method: "PUT", headers: headers(1, createHeaders()), body: JSON.stringify({ content: { text: "" } }),
      });
    expect(response.status).toBe(201);
    expect(response.headers.get("location")).toBe(`/api/v1/projects/${projectId}/stages/UX%2FUI`);
    expect(response.headers.get("etag")).toBe("\"0\"");
    expect(await response.json()).toMatchObject({ stage: "UX/UI", row_version: 0, content: { text: "" } });
  });
});

describe("T011 冪等與 If-Match", () => {
  it("缺少／格式錯誤的 Idempotency-Key 與 If-Match 回固定碼，且不寫入", async () => {
    const projectId = await seedProject();
    const key = randomUUID();
    const cases: Array<[Record<string, string>, number, string]> = [
      [{ "if-match": "\"0\"" }, 400, "idempotency_key_required"],
      [{ "idempotency-key": "not-a-uuid", "if-match": "\"0\"" }, 400, "invalid_idempotency_key"],
      [{ "idempotency-key": key }, 400, "precondition_required"],
      [{ "idempotency-key": key, "if-match": "W/\"0\"" }, 400, "invalid_precondition"],
      [{ "idempotency-key": key, "if-match": "0" }, 400, "invalid_precondition"],
      [{ "idempotency-key": key, "if-match": "*" }, 400, "invalid_precondition"],
      [{ "idempotency-key": key, "if-match": "\"0\", \"1\"" }, 400, "invalid_precondition"],
      [{ "idempotency-key": key, "if-match": "\"01\"" }, 400, "invalid_precondition"],
    ];
    for (const [extra, status, code] of cases) {
      const response = await put(projectId, 1, "x", extra);
      expect({ code: (await problem(response)).code, status: response.status }).toEqual({ code, status });
    }
    expect(await draftRows(projectId)).toMatchObject([{ row_version: 0, content: { text: "v0" } }]);
  });
  it("同鍵同意圖重放只寫一次；同鍵異本文／異 If-Match 回 422", async () => {
    const projectId = await seedProject();
    const key = randomUUID();
    const first = await put(projectId, 1, "v1", { "idempotency-key": key, "if-match": "\"0\"" });
    expect(first.status).toBe(200);
    expect(first.headers.get("etag")).toBe("\"1\"");
    const replay = await put(projectId, 1, "v1", { "idempotency-key": key, "if-match": "\"0\"" });
    expect(replay.status).toBe(200);
    expect(replay.headers.get("idempotent-replay")).toBe("true");
    const different = await put(projectId, 1, "v1-changed", { "idempotency-key": key, "if-match": "\"0\"" });
    expect(different.status).toBe(422);
    expect((await problem(different)).code).toBe("idempotency_key_reuse");
    expect((await draftRows(projectId))).toMatchObject([{ row_version: 1, content: { text: "v1" } }]);
  });
  it("8 個同鍵並行只產生一次寫入", async () => {
    const projectId = await seedProject();
    const key = randomUUID();
    const responses = await Promise.all(Array.from({ length: 8 }, () =>
      put(projectId, 1, "concurrent", { "idempotency-key": key, "if-match": "\"0\"" })));
    expect(responses.map((r) => r.status)).toEqual(Array(8).fill(200));
    expect(await draftRows(projectId)).toMatchObject([{ row_version: 1, content: { text: "concurrent" } }]);
  });
  it("並行不同鍵同一 If-Match：一方 200、其餘 409，且 409 只含約定欄位", async () => {
    const projectId = await seedProject();
    const responses = await Promise.all(Array.from({ length: 4 }, (_, i) =>
      put(projectId, 1, `writer-${i}`, { "idempotency-key": randomUUID(), "if-match": "\"0\"" })));
    const statuses = responses.map((r) => r.status).sort();
    expect(statuses).toEqual([200, 409, 409, 409]);
    const conflict = await problem(responses.find((r) => r.status === 409)!.clone());
    expect(conflict.code).toBe("version_conflict");
    const detail = conflict.conflict as Record<string, unknown>;
    expect(Object.keys(detail).sort()).toEqual(["current", "submitted"]);
    const current = detail.current as { version: string; content: Record<string, unknown> };
    expect(Object.keys(current.content)).toEqual(["text"]);
    expect(await draftRows(projectId)).toHaveLength(1);
    expect((await draftRows(projectId))[0].row_version).toBe(1);
  });
  it("409 對失去資格者不揭露目前內容；有資格者可保留自己提交的草稿欄位", async () => {
    const projectId = await seedProject();
    await put(projectId, 1, SECRET_TEXT, { "idempotency-key": randomUUID(), "if-match": "\"0\"" });
    const stale = await put(projectId, 3, "mine", { "idempotency-key": randomUUID(), "if-match": "\"0\"" });
    expect(stale.status).toBe(404);
    expect(JSON.stringify(await problem(stale))).not.toContain(SECRET_TEXT);
  });
  it("COMMIT 後 response loss：同鍵重送不重複寫入", async () => {
    const projectId = await seedProject();
    const key = randomUUID();
    harness.faults.dropResponseAfterHandler = true;
    await expect(put(projectId, 1, "lost", { "idempotency-key": key, "if-match": "\"0\"" })).rejects.toThrow();
    harness.faults.dropResponseAfterHandler = false;
    expect(await draftRows(projectId)).toMatchObject([{ row_version: 1, content: { text: "lost" } }]);
    const retry = await put(projectId, 1, "lost", { "idempotency-key": key, "if-match": "\"0\"" });
    expect(retry.status).toBe(200);
    expect(retry.headers.get("idempotent-replay")).toBe("true");
    expect(await draftRows(projectId)).toMatchObject([{ row_version: 1 }]);
  });
  it("依賴故障回 503 固定碼，不是 200，亦不外洩 SQL／連線資訊", async () => {
    const projectId = await seedProject();
    await control.query("ALTER TABLE app.stage_records DISABLE TRIGGER ALL").catch(() => undefined);
    await control.query("ALTER TABLE app.stage_records DISABLE ROW LEVEL SECURITY");
    await control.query("ALTER TABLE app.stage_records RENAME TO stage_records_hidden");
    try {
      const response = await put(projectId, 1, "x", { "idempotency-key": randomUUID(), "if-match": "\"0\"" });
      expect(response.status).toBeGreaterThanOrEqual(500);
      expect(response.status).not.toBe(200);
      const body = await problem(response);
      expect(["operation_outcome_unknown", "dependency_unavailable", "internal_error"]).toContain(body.code);
    } finally {
      await control.query("ALTER TABLE app.stage_records_hidden RENAME TO stage_records");
      await control.query("ALTER TABLE app.stage_records ENABLE ROW LEVEL SECURITY");
      await control.query("ALTER TABLE app.stage_records ENABLE TRIGGER ALL").catch(() => undefined);
    }
    expect(await draftRows(projectId)).toMatchObject([{ row_version: 0 }]);
  });
  it("413 / 415 / 405 / 400 本文錯誤皆為固定 problem+json", async () => {
    const projectId = await seedProject();
    const base = { "idempotency-key": randomUUID(), "if-match": "\"0\"" };
    const large = await fetch(draftUrl(projectId), {
      method: "PUT", headers: headers(1, base), body: JSON.stringify({ content: { text: "a".repeat(80 * 1024) } }),
    });
    expect(large.status).toBe(413);
    await problem(large);
    const media = await fetch(draftUrl(projectId), {
      method: "PUT", headers: { ...headers(1, base), "content-type": "text/plain" }, body: "x",
    });
    expect(media.status).toBe(415);
    await problem(media);
    const method = await fetch(draftUrl(projectId), { method: "DELETE", headers: headers(1, base) });
    expect(method.status).toBe(405);
    expect(method.headers.get("allow")).toBe("PUT");
    await problem(method);
    const extra = await fetch(draftUrl(projectId), {
      method: "PUT", headers: headers(1, base), body: JSON.stringify({ content: { text: "x" }, role: "admin" }),
    });
    expect(extra.status).toBe(400);
    await problem(extra);
    expect(await draftRows(projectId)).toMatchObject([{ row_version: 0 }]);
  });
  it("日誌只含白名單欄位，不含 token、草稿本文、冪等鍵或錯誤內文", async () => {
    const projectId = await seedProject();
    const key = randomUUID();
    await put(projectId, 1, SECRET_TEXT, { "idempotency-key": key, "if-match": "\"0\"" });
    await put(projectId, 1, SECRET_TEXT, { "idempotency-key": key, "if-match": "\"7\"" });
    await fetch(draftUrl(projectId), { method: "PUT", headers: { "content-type": "application/json" }, body: "{}" });
    const serialized = JSON.stringify(harness.logs);
    expect(harness.logs.length).toBeGreaterThan(0);
    for (const forbidden of [SECRET_TEXT, TOKEN(1), key, projectId, actor(1), "postgres"]) {
      expect(serialized).not.toContain(forbidden);
    }
  });
});

describe("T011 Job 接受／查詢（費用預留與入列原子一致）", () => {
  it("202 + Location + queued 快照；同鍵並行只留一筆 Job／預留／audit", async () => {
    const key = randomUUID();
    const responses = await Promise.all(Array.from({ length: 8 }, () => postJob(1, key)));
    expect(responses.map((r) => r.status).sort()).toEqual(Array(8).fill(202));
    const body = await responses[0]!.json() as { id: string; state: string; result: null; failure: null };
    expect(responses[0]!.headers.get("location")).toBe(`/api/v1/jobs/${body.id}`);
    expect(body).toMatchObject({ state: "queued", result: null, failure: null });
    expect(await jobCounts()).toEqual({ jobs: 1, reservations: 1, audit: 1 });
  });
  it("同鍵不同預估 422；額度用盡 429 且不留殘列", async () => {
    const key = randomUUID();
    expect((await postJob(1, key, "30")).status).toBe(202);
    const different = await postJob(1, key, "31");
    expect(different.status).toBe(422);
    expect((await problem(different)).code).toBe("idempotency_key_reuse");
    await control.query("UPDATE app.quota_policies SET limit_micro=40");
    const exhausted = await postJob(1, randomUUID(), "30");
    expect(exhausted.status).toBe(429);
    await problem(exhausted);
    expect(await jobCounts()).toEqual({ jobs: 1, reservations: 1, audit: 1 });
  });
  it("Job 入列失敗整筆回滾，回應不為 202 也不洩漏內部診斷", async () => {
    await control.query(`CREATE FUNCTION app.synthetic_fail_job() RETURNS trigger LANGUAGE plpgsql AS
      $$ BEGIN RAISE EXCEPTION 'synthetic-job-insert-failure'; END $$`);
    await control.query("CREATE TRIGGER synthetic_fail_job BEFORE INSERT ON app.jobs FOR EACH ROW EXECUTE FUNCTION app.synthetic_fail_job()");
    try {
      const response = await postJob(1, randomUUID());
      expect(response.status).toBe(503);
      const body = await problem(response);
      expect(JSON.stringify(body)).not.toContain("synthetic-job-insert-failure");
    } finally {
      await control.query("DROP TRIGGER synthetic_fail_job ON app.jobs");
      await control.query("DROP FUNCTION app.synthetic_fail_job()");
    }
    expect(await jobCounts()).toEqual({ jobs: 0, reservations: 0, audit: 0 });
    const totals = await control.query("SELECT count(*)::int AS n FROM app.usage_totals WHERE reserved_micro<>0");
    expect(totals.rows[0].n).toBe(0);
  });
  it("停用帳號建立 Job 回 403 且不入列；缺 Idempotency-Key 回 400", async () => {
    await control.query("UPDATE app.profiles SET status='disabled' WHERE id=$1", [actor(1)]);
    const denied = await postJob(1, randomUUID());
    expect([401, 403]).toContain(denied.status);
    await problem(denied);
    await control.query("UPDATE app.profiles SET status='approved' WHERE id=$1", [actor(1)]);
    const missing = await fetch(`${harness.url}/test/jobs`, {
      method: "POST", headers: headers(1), body: JSON.stringify({ policy_id: policy, estimate_micro: "30" }),
    });
    expect(missing.status).toBe(400);
    expect((await problem(missing)).code).toBe("idempotency_key_required");
    expect(await jobCounts()).toEqual({ jobs: 0, reservations: 0, audit: 0 });
  });
  it("狀態查詢：owner 可見 queued→running；跨帳號 404；完成但 result 未定義時回 503 而非冒充成功", async () => {
    const created = await postJob(1, randomUUID());
    const { id } = await created.json() as { id: string };
    const status = (n: number) => fetch(`${harness.url}/test/jobs/${id}`, { headers: headers(n) });
    const queued = await status(1);
    expect(queued.status).toBe(200);
    expect(queued.headers.get("cache-control")).toBe("no-store");
    expect(await queued.json()).toMatchObject({ id, kind: "agent", state: "queued", result: null, failure: null });
    expect((await status(2)).status).toBe(404);
    expect((await status(3)).status).toBe(404);

    const worker = createCheckpoints(workerContext(), { async authorize() { return true; } }, randomUUID(), 5000);
    const job = await worker.claim();
    expect(job).not.toBeNull();
    const running = await status(1);
    expect(await running.json()).toMatchObject({ state: "running", result: null, failure: null });

    await control.query("UPDATE app.jobs SET state='done' WHERE id=$1", [id]);
    const done = await status(1);
    expect(done.status).toBe(503);
    expect((await problem(done)).code).toBe("job_result_unavailable");
  });
  it("HTTP取消的 Job 經 Worker 完成狀態轉換，查詢不含內部原因", async () => {
    const created = await postJob(1, randomUUID());
    const { id } = await created.json() as { id: string };
    expect((await cancelJob(1, id)).status).toBe(202);
    const worker = createCheckpoints(workerContext(), { async authorize() { return true; } }, randomUUID(), 5000);
    expect(await worker.claim()).toBeNull();
    const response = await fetch(`${harness.url}/test/jobs/${id}`, { headers: headers(1) });
    expect(response.status).toBe(200);
    const body = await response.json() as { state: string; failure: { code: string } };
    expect(body.state).toBe("cancelled");
    expect(typeof body.failure.code).toBe("string");
    expect(JSON.stringify(body)).not.toMatch(/SELECT|stack|postgres/i);
  });
  it("HTTP取消 queued Job：跨帳號／停用拒絕；重複取消只由 Worker 釋放一次", async () => {
    const created = await postJob(1, randomUUID());
    const { id } = await created.json() as { id: string };
    expect((await cancelJob(2, id)).status).toBe(404);
    await control.query("UPDATE app.profiles SET status='disabled' WHERE id=$1", [actor(1)]);
    const disabled = await cancelJob(1, id);
    expect(disabled.status).toBe(403);
    await problem(disabled);
    await control.query("UPDATE app.profiles SET status='approved' WHERE id=$1", [actor(1)]);

    expect((await cancelJob(1, id)).status).toBe(202);
    expect((await cancelJob(1, id)).status).toBe(202);
    expect(await control.query("SELECT state,cancel_requested FROM app.jobs WHERE id=$1", [id]))
      .toMatchObject({ rows: [{ state: "queued", cancel_requested: true }] });
    const worker = createCheckpoints(workerContext(), { async authorize() { return true; } }, randomUUID(), 5000);
    expect(await worker.claim()).toBeNull();
    expect(await control.query("SELECT state FROM app.jobs WHERE id=$1", [id]))
      .toMatchObject({ rows: [{ state: "cancelled" }] });
    expect(await control.query(`SELECT r.state FROM app.usage_reservations r
      JOIN app.jobs j ON j.reservation_id=r.id WHERE j.id=$1`, [id]))
      .toMatchObject({ rows: [{ state: "released" }] });
    expect((await cancelJob(1, id)).status).toBe(404);
    expect(await control.query("SELECT count(*)::int AS count FROM app.usage_audit"))
      .toMatchObject({ rows: [{ count: 2 }] });
    const status = await fetch(`${harness.url}/test/jobs/${id}`, { headers: headers(1) });
    expect(await status.json()).toMatchObject({ state: "cancelled", result: null });
  });
  it("HTTP取消保留已確認部分成果並依Worker核心結算", async () => {
    const created = await postJob(1, randomUUID());
    const { id } = await created.json() as { id: string };
    const worker = createCheckpoints(workerContext(), { async authorize() { return true; } }, randomUUID(), 5000);
    const claimed = await worker.claim();
    expect(claimed?.id).toBe(id);
    const active = await worker.save(claimed!, "begin");
    const partial = await worker.save(active, "complete", randomUUID(), {
      input_tokens: 2, cached_input_tokens: 0, output_tokens: 1, images: 0,
    });
    expect(partial.checkpoint).toBe(1);
    expect((await cancelJob(1, id)).status).toBe(202);
    const stopped = await worker.save(partial, "begin");
    expect(stopped).toMatchObject({ state: "cancelled", checkpoint: 1, partial_refs: [expect.any(String)] });
    expect(await control.query(`SELECT r.state,r.settled_micro FROM app.usage_reservations r
      JOIN app.jobs j ON j.reservation_id=r.id WHERE j.id=$1`, [id]))
      .toMatchObject({ rows: [{ state: "settled", settled_micro: expect.any(String) }] });
    expect(await control.query("SELECT count(*)::int AS count FROM app.usage_audit WHERE action='settled'"))
      .toMatchObject({ rows: [{ count: 1 }] });
    const status = await fetch(`${harness.url}/test/jobs/${id}`, { headers: headers(1) });
    expect(await status.json()).toMatchObject({ state: "cancelled", result: null });
  });
  it("in-flight取消不謊稱外部終止，不把未知費用釋放或當作零", async () => {
    const created = await postJob(1, randomUUID());
    const { id } = await created.json() as { id: string };
    const worker = createCheckpoints(workerContext(), { async authorize() { return true; } }, randomUUID(), 5000);
    const claimed = await worker.claim();
    expect(claimed?.id).toBe(id);
    const active = await worker.save(claimed!, "begin");
    expect((await cancelJob(1, id)).status).toBe(202);
    const result = await worker.save(active, "complete", randomUUID(), {
      input_tokens: 2, cached_input_tokens: 0, output_tokens: 1, images: 0,
    });
    expect(result).toMatchObject({ state: "failed", effect_state: "unknown" });
    expect(await control.query(`SELECT r.state,r.settled_micro FROM app.usage_reservations r
      JOIN app.jobs j ON j.reservation_id=r.id WHERE j.id=$1`, [id]))
      .toMatchObject({ rows: [{ state: "unknown", settled_micro: null }] });
    expect(await control.query("SELECT reserved_micro FROM app.usage_totals WHERE scope='account' AND subject_id=$1", [actor(1)]))
      .toMatchObject({ rows: [{ reserved_micro: "30" }] });
    const status = await fetch(`${harness.url}/test/jobs/${id}`, { headers: headers(1) });
    expect(await status.json()).toMatchObject({
      state: "failed",
      failure: { code: "reconciliation_required" },
      result: null,
    });
  });
  it("取消與租約到期競態由Worker fence裁決，舊租約不能覆寫", async () => {
    const created = await postJob(1, randomUUID());
    const { id } = await created.json() as { id: string };
    const worker = createCheckpoints(workerContext(), { async authorize() { return true; } }, randomUUID(), 5000);
    const oldLease = await worker.claim();
    expect(oldLease?.id).toBe(id);
    await control.query("UPDATE app.jobs SET lease_expires_at=now()-interval '1 second' WHERE id=$1", [id]);
    expect((await cancelJob(1, id)).status).toBe(202);
    expect(await worker.claim()).toBeNull();
    await expect(worker.save(oldLease!, "heartbeat")).rejects.toMatchObject({ code: "stale_lease" });
    expect(await control.query("SELECT state FROM app.jobs WHERE id=$1", [id]))
      .toMatchObject({ rows: [{ state: "cancelled" }] });
    expect(await control.query(`SELECT r.state FROM app.usage_reservations r
      JOIN app.jobs j ON j.reservation_id=r.id WHERE j.id=$1`, [id]))
      .toMatchObject({ rows: [{ state: "released" }] });
  });
});

describe("T014 UI 保存流程 × 真實 HTTP + PostgreSQL（控制器經 HTTP adapter）", () => {
  async function flow(token = TOKEN(1), options: { online?: () => boolean } = {}) {
    const projectId = await seedProject();
    const row = (await control.query(
      "SELECT state,content_source FROM app.stage_records WHERE project_id=$1 AND stage='Specification'", [projectId],
    )).rows[0];
    const keys: string[] = [];
    let calls = 0;
    const adapter = createHttpSaveAdapter({
      buildUrl: (t) => draftUrl(t.project_id, t.stage),
      extraHeaders: { "x-test-principal": token },
      isOnline: options.online,
      fetchImpl: (input, init) => {
        calls += 1;
        keys.push(new Headers(init?.headers).get("idempotency-key") ?? "");
        return fetch(input, init);
      },
    });
    const target = { project_id: projectId, stage: "Specification" as const };
    const controller = new StageDraftSaveController({
      adapter, initialTarget: target,
      initialDraft: {
        project_id: projectId, stage: "Specification", row_version: 0, state: row.state,
        content_source: row.content_source, content: { text: "v0" }, approved_by: null, approved_at: null,
      },
    });
    const view = (connectivity: "online" | "offline" = "online") => presentSaveState({
      operation: controller.getState().operation, dirty: controller.getState().dirty,
      connectivity, signal: adapter.signal, hasTrustedPrincipal: true,
    });
    return { projectId, controller, adapter, view, keys, calls: () => calls };
  }

  it("server 確認成功後才顯示已保存；未保存時只顯示未保存", async () => {
    const f = await flow();
    expect(f.view().kind).toBe("unmodified");
    f.controller.edit("v1");
    expect(f.view().kind).toBe("unsaved");
    const attempt = await f.controller.save();
    expect(attempt.outcome).toBe("saved");
    expect(f.view()).toMatchObject({ kind: "saved", savedVersion: 1 });
    expect(await draftRows(f.projectId)).toMatchObject([{ row_version: 1, content: { text: "v1" } }]);
  });
  it("版本衝突：保留本地草稿並顯示衝突，不覆寫對方版本", async () => {
    const f = await flow();
    const other = await put(f.projectId, 1, "other-writer", { "idempotency-key": randomUUID(), "if-match": "\"0\"" });
    expect(other.status).toBe(200);
    f.controller.edit("my-local-draft");
    expect((await f.controller.save()).outcome).toBe("conflict");
    expect(f.view().kind).toBe("conflict");
    expect(f.controller.getState().editorText).toBe("my-local-draft");
    expect(await draftRows(f.projectId)).toMatchObject([{ row_version: 1, content: { text: "other-writer" } }]);
  });
  it("登入失效（401）：保留草稿、隱藏 server 資料、不寫入", async () => {
    const f = await flow("expired-token");
    f.controller.edit("draft-while-expired");
    await f.controller.save();
    expect(f.view()).toMatchObject({ kind: "denied", code: "unauthenticated", hideServerData: true });
    expect(f.controller.getState().editorText).toBe("draft-while-expired");
    expect(await draftRows(f.projectId)).toMatchObject([{ row_version: 0, content: { text: "v0" } }]);
  });
  it("降權後保存被拒（forbidden）：保留草稿並隱藏 server 資料", async () => {
    const f = await flow();
    await control.query("UPDATE app.profiles SET status='disabled' WHERE id=$1", [actor(1)]);
    f.controller.edit("after-disable");
    await f.controller.save();
    expect(f.view()).toMatchObject({ kind: "denied", hideServerData: true });
    expect(f.controller.getState().editorText).toBe("after-disable");
  });
  it("response loss：結果待確認、不自動失敗；重試沿用同一鍵且只寫一次", async () => {
    const f = await flow();
    f.controller.edit("lost-response");
    harness.faults.dropResponseAfterHandler = true;
    await f.controller.save();
    harness.faults.dropResponseAfterHandler = false;
    expect(f.view()).toMatchObject({ kind: "outcome_unknown", canRetry: true });
    expect(await draftRows(f.projectId)).toMatchObject([{ row_version: 1, content: { text: "lost-response" } }]);
    expect((await f.controller.retry()).outcome).toMatch(/saved|replayed/);
    expect(f.view().kind).toBe("saved");
    expect(f.calls()).toBe(2);
    expect(f.keys[0]).toBe(f.keys[1]);
    expect(await draftRows(f.projectId)).toMatchObject([{ row_version: 1 }]);
  });
  it("離線：不送出請求、保留草稿、可在恢復後以同一操作重試", async () => {
    let online = false;
    const f = await flow(TOKEN(1), { online: () => online });
    f.controller.edit("offline-draft");
    await f.controller.save();
    expect(f.calls()).toBe(0);
    expect(f.view("offline")).toMatchObject({ kind: "offline", canRetry: true });
    expect(f.controller.getState().editorText).toBe("offline-draft");
    online = true;
    await f.controller.retry();
    expect(f.view().kind).toBe("saved");
    expect(await draftRows(f.projectId)).toMatchObject([{ row_version: 1, content: { text: "offline-draft" } }]);
  });
});

describe("T014 Edge 真實 React → HTTP → 隔離 PostgreSQL", () => {
  const banner = (page: import("@playwright/test").Page) => page.locator(".operation-banner");

  it("首次空狀態未保存，真實 201 後才確認版本 0；保存期間續編仍 dirty", async () => {
    const projectId = await seedProject(1, false);
    const { context, page } = await openEdgeEditor(projectId, false);
    let release!: () => void;
    let entered!: () => void;
    const wait = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { entered = resolve; });
    harness.faults.beforeExecute = async () => { entered(); await wait; };
    try {
      await expectPage(banner(page)).toHaveAttribute("data-kind", "unsaved");
      const editor = page.getByLabel("階段草稿文字");
      await editor.fill("首次提交");
      await page.getByRole("button", { name: "保存", exact: true }).click();
      await started;
      await expectPage(banner(page)).toHaveAttribute("data-kind", "saving");
      await expectPage(page.getByTestId("confirmed-server-draft")).toHaveCount(0);
      await editor.fill("首建期間續編");
      release();
      await expectPage(banner(page)).toHaveAttribute("data-kind", "unsaved");
      await expectPage(page.getByTestId("confirmed-server-draft")).toHaveText("伺服器版本 0：首次提交");
      await expectPage(editor).toHaveValue("首建期間續編");
      expect(await draftRows(projectId)).toMatchObject([{ row_version: 0, content: { text: "首次提交" } }]);
    } finally {
      release();
      harness.faults.beforeExecute = undefined;
      await context.close();
    }
  });

  it("兩個真實 React 同時首建：一個 201／一個 412；本地保留並明確重新載入比對後才可更新", async () => {
    const projectId = await seedProject(1, false);
    const a = await openEdgeEditor(projectId, false);
    const b = await openEdgeEditor(projectId, false);
    try {
      await a.page.getByLabel("階段草稿文字").fill("視窗甲");
      await b.page.getByLabel("階段草稿文字").fill("視窗乙");
      const responses = [a.page.waitForResponse((r) => r.request().method() === "PUT"),
        b.page.waitForResponse((r) => r.request().method() === "PUT")];
      await Promise.all([a.page, b.page].map((p) => p.getByRole("button", { name: "保存", exact: true }).click()));
      const [ra, rb] = await Promise.all(responses);
      expect([ra.status(), rb.status()].sort()).toEqual([201, 412]);
      const loser = ra.status() === 412 ? a : b;
      const local = ra.status() === 412 ? "視窗甲" : "視窗乙";
      await expectPage(banner(loser.page)).toHaveAttribute("data-code", "draft_already_exists");
      await expectPage(banner(loser.page)).toContainText("草稿已存在");
      await expectPage(loser.page.getByLabel("階段草稿文字")).toHaveValue(local);
      await expectPage(loser.page.getByRole("button", { name: "保存", exact: true })).toBeDisabled();
      expect(await draftRows(projectId)).toHaveLength(1);
      await loser.page.getByRole("button", { name: "重新載入／比對" }).click();
      const dialog = loser.page.getByRole("dialog");
      await expectPage(dialog).toBeVisible();
      await expectPage(dialog.getByRole("region", { name: "本次提交內容" })).toContainText(local);
      await loser.page.keyboard.press("Escape");
      await expectPage(dialog).not.toBeVisible();
      await expectPage(loser.page.getByRole("button", { name: "查看版本衝突說明" })).toBeFocused();
      await loser.page.getByRole("button", { name: "查看版本衝突說明" }).click();
      await dialog.getByRole("button", { name: "保留本地，採用目前版本作為更新基準" }).click();
      await loser.page.getByRole("button", { name: "保存", exact: true }).click();
      await expectPage(banner(loser.page)).toHaveAttribute("data-kind", "saved");
      expect(await draftRows(projectId)).toMatchObject([{ row_version: 1, content: { text: local } }]);
    } finally {
      await Promise.all([a.context.close(), b.context.close()]);
    }
  });

  it("首建 response loss 原鍵原 payload 重試；原 receipt 與較新 current 分開呈現", async () => {
    const projectId = await seedProject(1, false);
    const { context, page } = await openEdgeEditor(projectId, false);
    const requests: Array<{ key: string | undefined; body: string | null }> = [];
    page.on("request", (r) => {
      if (r.method() === "PUT") requests.push({ key: r.headers()["idempotency-key"], body: r.postData() });
    });
    try {
      await page.getByLabel("階段草稿文字").fill("原首建");
      harness.faults.dropResponseAfterHandler = true;
      await page.getByRole("button", { name: "保存", exact: true }).click();
      await expectPage(banner(page)).toHaveAttribute("data-kind", "outcome_unknown");
      harness.faults.dropResponseAfterHandler = false;
      expect(await draftRows(projectId)).toMatchObject([{ row_version: 0 }]);
      expect((await put(projectId, 1, "別處新版", {
        "idempotency-key": randomUUID(), "if-match": "\"0\"",
      })).status).toBe(200);
      await page.getByLabel("階段草稿文字").fill("本地續編");
      await page.getByRole("button", { name: "使用原操作鍵重試" }).click();
      await expectPage(page.getByTestId("operation-receipt")).toContainText("原操作版本 0：原首建");
      await expectPage(page.getByTestId("confirmed-server-draft")).toHaveText("伺服器版本 1：別處新版");
      await expectPage(page.getByLabel("階段草稿文字")).toHaveValue("本地續編");
      await expectPage(banner(page)).toHaveAttribute("data-kind", "unsaved");
      expect(requests).toHaveLength(2);
      expect(requests[1]).toEqual(requests[0]);
      expect(await draftRows(projectId)).toMatchObject([{ row_version: 1, content: { text: "別處新版" } }]);
    } finally {
      harness.faults.dropResponseAfterHandler = false;
      await context.close();
    }
  });

  it("畸形 201／replay 不顯示已保存，原鍵重試恢復真實首建 receipt", async () => {
    const projectId = await seedProject(1, false);
    const { context, page } = await openEdgeEditor(projectId, false);
    try {
      harness.faults.malformedSuccessResponse = true;
      await page.getByLabel("階段草稿文字").fill("畸形首建回應");
      await page.getByRole("button", { name: "保存", exact: true }).click();
      await expectPage(banner(page)).toHaveAttribute("data-kind", "outcome_unknown");
      await expectPage(page.getByTestId("confirmed-server-draft")).toHaveCount(0);
      expect(await draftRows(projectId)).toMatchObject([{ row_version: 0 }]);
      await page.getByRole("button", { name: "使用原操作鍵重試" }).click();
      await expectPage(banner(page)).toHaveAttribute("data-kind", "outcome_unknown");
      harness.faults.malformedSuccessResponse = false;
      await page.getByRole("button", { name: "使用原操作鍵重試" }).click();
      await expectPage(banner(page)).toHaveAttribute("data-kind", "saved");
      await expectPage(page.getByTestId("confirmed-server-draft")).toContainText("版本 0");
    } finally {
      harness.faults.malformedSuccessResponse = false;
      await context.close();
    }
  });

  it("首建失權不寫入；已保存後失權隱藏 server 與 receipt", async () => {
    const projectId = await seedProject(1, false);
    const { context, page } = await openEdgeEditor(projectId, false);
    try {
      await page.getByLabel("階段草稿文字").fill("首次保存後失權");
      await page.getByRole("button", { name: "保存", exact: true }).click();
      await expectPage(banner(page)).toHaveAttribute("data-kind", "saved");
      await control.query("UPDATE app.profiles SET status='disabled' WHERE id=$1", [actor(1)]);
      await page.getByLabel("階段草稿文字").fill("不應保存");
      await page.getByRole("button", { name: "保存", exact: true }).click();
      await expectPage(banner(page)).toHaveAttribute("data-kind", "denied");
      await expectPage(page.getByTestId("confirmed-server-draft")).toHaveCount(0);
      await expectPage(page.getByTestId("operation-receipt")).toHaveCount(0);
      expect(await draftRows(projectId)).toMatchObject([{ row_version: 0, content: { text: "首次保存後失權" } }]);
    } finally {
      await context.close();
    }
  });

  it("保存等待期間不顯示已保存；後續編輯不改寫已提交快照", async () => {
    const projectId = await seedProject();
    const { context, page } = await openEdgeEditor(projectId);
    let enteredResolve!: () => void;
    let releaseResolve!: () => void;
    const entered = new Promise<void>((resolve) => { enteredResolve = resolve; });
    const released = new Promise<void>((resolve) => { releaseResolve = resolve; });
    let held = false;
    harness.faults.beforeExecute = async (operation) => {
      if (operation !== "save_stage_draft" || held) return;
      held = true;
      enteredResolve();
      await released;
    };
    try {
      const editor = page.getByLabel("階段草稿文字");
      await editor.fill("已提交快照");
      await page.getByRole("button", { name: "保存", exact: true }).click();
      await entered;
      await expectPage(banner(page)).toHaveAttribute("data-kind", "saving");
      await expectPage(banner(page)).not.toContainText("已保存");
      await editor.fill("保存期間的後續編輯");
      releaseResolve();
      await expectPage(banner(page)).toHaveAttribute("data-kind", "unsaved");
      await expectPage(banner(page)).toContainText("已確認版本 1");
      await expectPage(page.getByTestId("confirmed-server-draft")).toContainText("已提交快照");
      await expectPage(editor).toHaveValue("保存期間的後續編輯");
      expect(await draftRows(projectId)).toMatchObject([
        { row_version: 1, content: { text: "已提交快照" } },
      ]);
    } finally {
      releaseResolve();
      harness.faults.beforeExecute = undefined;
      await context.close();
    }
  });

  it("並行 If-Match 衝突保留本地草稿；Radix 對話框支援 Esc 並回復焦點", async () => {
    const projectId = await seedProject();
    const { context, page } = await openEdgeEditor(projectId);
    let enteredResolve!: () => void;
    let releaseResolve!: () => void;
    const entered = new Promise<void>((resolve) => { enteredResolve = resolve; });
    const released = new Promise<void>((resolve) => { releaseResolve = resolve; });
    let held = false;
    harness.faults.beforeExecute = async (operation) => {
      if (operation !== "save_stage_draft" || held) return;
      held = true;
      enteredResolve();
      await released;
    };
    try {
      const editor = page.getByLabel("階段草稿文字");
      await editor.fill("瀏覽器本地草稿");
      await page.getByRole("button", { name: "保存", exact: true }).click();
      await entered;
      const competitor = await fetch(
        `${harness.url}/api/v1/projects/${projectId}/stages/Specification`,
        {
          method: "PUT",
          headers: headers(1, { "idempotency-key": randomUUID(), "if-match": "\"0\"" }),
          body: JSON.stringify({ content: { text: "另一個已提交版本" } }),
        },
      );
      expect(competitor.status).toBe(200);
      releaseResolve();
      await expectPage(banner(page)).toHaveAttribute("data-kind", "conflict");
      await expectPage(editor).toHaveValue("瀏覽器本地草稿");

      const trigger = page.getByRole("button", { name: "查看版本衝突說明" });
      await trigger.click();
      await expectPage(page.getByRole("dialog")).toBeVisible();
      await page.keyboard.press("Escape");
      await expectPage(page.getByRole("dialog")).toHaveCount(0);
      await expectPage(trigger).toBeFocused();
      expect(await draftRows(projectId)).toMatchObject([
        { row_version: 1, content: { text: "另一個已提交版本" } },
      ]);
    } finally {
      releaseResolve();
      harness.faults.beforeExecute = undefined;
      await context.close();
    }
  });

  it("COMMIT 後 response-loss 與畸形 replay 不顯示已保存；重試沿用同鍵且只寫一次", async () => {
    const projectId = await seedProject();
    const { context, page } = await openEdgeEditor(projectId);
    const keys: string[] = [];
    page.on("request", (request) => {
      if (request.url().includes(`/api/v1/projects/${projectId}/stages/Specification`)) {
        const key = request.headers()["idempotency-key"];
        if (key) keys.push(key);
      }
    });
    try {
      await page.getByLabel("階段草稿文字").fill("瀏覽器重試草稿");
      harness.faults.dropResponseAfterHandler = true;
      await page.getByRole("button", { name: "保存", exact: true }).click();
      await expectPage(banner(page)).toHaveAttribute("data-kind", "outcome_unknown");
      expect(await draftRows(projectId)).toMatchObject([
        { row_version: 1, content: { text: "瀏覽器重試草稿" } },
      ]);

      harness.faults.dropResponseAfterHandler = false;
      harness.faults.malformedSuccessResponse = true;
      await page.getByRole("button", { name: "使用原操作鍵重試" }).click();
      await expectPage(banner(page)).toHaveAttribute("data-kind", "outcome_unknown");

      harness.faults.malformedSuccessResponse = false;
      await page.getByRole("button", { name: "使用原操作鍵重試" }).click();
      await expectPage(banner(page)).toHaveAttribute("data-kind", "saved");
      expect(new Set(keys).size).toBe(1);
      expect(keys).toHaveLength(3);
      expect(await draftRows(projectId)).toMatchObject([
        { row_version: 1, content: { text: "瀏覽器重試草稿" } },
      ]);
    } finally {
      harness.faults.dropResponseAfterHandler = false;
      harness.faults.malformedSuccessResponse = false;
      await context.close();
    }
  });

  it("瀏覽器離線保留草稿並恢復重試；登入失效、停用或降權後隱藏 server 內容", async () => {
    const offlineProject = await seedProject();
    const offline = await openEdgeEditor(offlineProject);
    try {
      await offline.context.setOffline(true);
      await offline.page.getByLabel("階段草稿文字").fill("真實離線草稿");
      await offline.page.getByRole("button", { name: "保存", exact: true }).click();
      await expectPage(banner(offline.page)).toHaveAttribute("data-kind", "offline");
      await expectPage(offline.page.getByLabel("階段草稿文字")).toHaveValue("真實離線草稿");
      expect(await draftRows(offlineProject)).toMatchObject([
        { row_version: 0, content: { text: "v0" } },
      ]);
      await offline.context.setOffline(false);
      await offline.page.getByRole("button", { name: "使用原操作鍵重試" }).click();
      await expectPage(banner(offline.page)).toHaveAttribute("data-kind", "saved");
      expect(await draftRows(offlineProject)).toMatchObject([
        { row_version: 1, content: { text: "真實離線草稿" } },
      ]);
    } finally {
      await offline.context.close();
    }

    const expiredProject = await seedProject();
    const expired = await openEdgeEditor(expiredProject);
    try {
      await expired.context.clearCookies();
      await expired.page.getByLabel("階段草稿文字").fill("登入失效草稿");
      await expired.page.getByRole("button", { name: "保存", exact: true }).click();
      await expectPage(banner(expired.page)).toHaveAttribute("data-code", "unauthenticated");
      await expectPage(expired.page.getByTestId("confirmed-server-draft")).toHaveCount(0);
      await expectPage(expired.page.getByLabel("階段草稿文字")).toHaveCount(0);
      await expectPage(expired.page.getByText("v0", { exact: false })).toHaveCount(0);
      expect(await draftRows(expiredProject)).toMatchObject([
        { row_version: 0, content: { text: "v0" } },
      ]);
    } finally {
      await expired.context.close();
    }

    for (const update of [
      { role: "student", status: "disabled" },
      { role: "teacher", status: "approved" },
    ]) {
      const deniedProject = await seedProject();
      const denied = await openEdgeEditor(deniedProject);
      try {
        await control.query("UPDATE app.profiles SET role=$2,status=$3 WHERE id=$1",
          [actor(1), update.role, update.status]);
        await denied.page.getByLabel("階段草稿文字").fill("資格失效草稿");
        await denied.page.getByRole("button", { name: "保存", exact: true }).click();
        await expectPage(banner(denied.page)).toHaveAttribute("data-code", "forbidden");
        await expectPage(denied.page.getByTestId("confirmed-server-draft")).toHaveCount(0);
        await expectPage(denied.page.getByLabel("階段草稿文字")).toHaveCount(0);
        await expectPage(denied.page.getByText("v0", { exact: false })).toHaveCount(0);
        expect(await draftRows(deniedProject)).toMatchObject([
          { row_version: 0, content: { text: "v0" } },
        ]);
      } finally {
        await control.query("UPDATE app.profiles SET role='student',status='approved' WHERE id=$1", [actor(1)]);
        await denied.context.close();
      }
    }
  }, 60_000);
});
