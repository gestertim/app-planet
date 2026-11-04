import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAuthPrincipalResolver, sessionCookieName } from "../../apps/web/src/server/auth-principal.ts";
import { closeServerDatabasePool } from "../../apps/web/src/server/database-session.ts";
import { createProjectHandlers } from "../../apps/web/src/server/project-handlers.ts";
import { createProjectClassificationHandlers } from "../../apps/web/src/server/project-classification-handlers.ts";
import { GET, PUT } from "../../apps/web/src/app/api/v1/projects/[id]/requirements/route.ts";
import { POST } from "../../apps/web/src/app/api/v1/projects/[id]/classification/confirmation/route.ts";
import { resolveTrustedProjectClassification } from "../../apps/web/src/server/project-classification.ts";
import { createDatabaseSession } from "../../apps/web/src/server/database-session.ts";
import {
  createSyntheticAuthAccount, deleteSyntheticAuthAccount, loginSyntheticAccount, openControlPool,
  type SyntheticAuthAccount, type NativeAuthSession,
} from "../support/real-auth-fixture.ts";

const origin = process.env.APP_PLANET_APP_ORIGIN!;
let control: Pool;
let owner: SyntheticAuthAccount;
let other: SyntheticAuthAccount;
let session: NativeAuthSession;
let otherSession: NativeAuthSession;
const ids: string[] = [];
const requirements = { description: "  合成正式需求 café e\u0301  ", runtime_needs: "static", runtime_ai_required: false } as const;
const path = (id: string, confirm = false) => `/api/v1/projects/${id}/${confirm ? "classification/confirmation" : "requirements"}`;
function request(id: string, method: string, body?: unknown, version = 0, key = randomUUID(), actor = session, extra: Record<string, string> = {}) {
  return new Request(`${origin}${path(id, method === "POST")}`, {
    method, headers: {
      cookie: `${sessionCookieName}=${actor.accessToken}`, origin,
      "content-type": "application/json", "if-match": `"${version}"`, "idempotency-key": key, ...extra,
    }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
const context = (id: string) => ({ params: Promise.resolve({ id }) });
const save = (id: string, version: number, revision: number, value: unknown = requirements, key = randomUUID(), actor = session) =>
  PUT(request(id, "PUT", { expected_requirements_revision: revision, requirements: value }, version, key, actor), context(id));
const confirm = (id: string, version: number, revision: number, tier = "A", visitor = false, ack = "matches", key = randomUUID(), actor = session) =>
  POST(request(id, "POST", { expected_requirements_revision: revision, tier,
    needs_visitor_identity: visitor, requested_tier_acknowledgement: ack }, version, key, actor), context(id));
async function read(id: string, actor = session) {
  const response = await GET(request(id, "GET", undefined, 0, randomUUID(), actor), context(id));
  return { status: response.status, body: await response.json() };
}
async function project() {
  const handlers = createProjectHandlers({ resolver: createAuthPrincipalResolver(), requireSameOrigin: true });
  const response = await handlers.create(new Request(`${origin}/api/v1/projects`, {
    method: "POST", headers: { cookie: `${sessionCookieName}=${session.accessToken}`, origin,
      "content-type": "application/json", "idempotency-key": randomUUID() },
    body: JSON.stringify({ title: "合成正式需求產品驗收", tier: "A" }),
  }));
  expect(response.status).toBe(201);
  const id = (await response.json()).id as string;
  ids.push(id);
  return id;
}
async function snapshot(id: string) {
  return (await control.query(`SELECT
    (SELECT to_jsonb(p) FROM app.projects p WHERE id=$1) project,
    (SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY revision),'[]') FROM app.project_requirements r WHERE project_id=$1) requirements,
    (SELECT coalesce(jsonb_agg(to_jsonb(c) ORDER BY id),'[]') FROM app.project_classification_confirmations c WHERE project_id=$1) confirmations,
    (SELECT coalesce(jsonb_agg(to_jsonb(i) ORDER BY operation_scope,idempotency_key),'[]') FROM app.project_classification_idempotency i WHERE project_id=$1) receipts`,
  [id])).rows[0];
}
beforeAll(async () => {
  control = openControlPool();
  owner = await createSyntheticAuthAccount(control, "FormalOwner");
  other = await createSyntheticAuthAccount(control, "FormalOther");
  session = await loginSyntheticAccount(owner);
  otherSession = await loginSyntheticAccount(other);
});
afterAll(async () => {
  try {
    await control.query("DROP TRIGGER IF EXISTS test_classification_failure ON app.project_classification_confirmations");
    await control.query("DROP TRIGGER IF EXISTS test_requirements_failure ON app.project_requirements");
    await control.query("DROP FUNCTION IF EXISTS app.test_classification_failure()");
    await closeServerDatabasePool();
    if (ids.length) {
      await control.query(`UPDATE app.projects SET classification_state='unconfirmed',tier=NULL,
        needs_visitor_identity=NULL,current_confirmation_id=NULL WHERE id=ANY($1::uuid[])`, [ids]);
      for (const table of ["project_classification_idempotency", "project_classification_confirmations",
        "project_requirements", "project_create_idempotency", "projects"]) {
        await control.query(`DELETE FROM app.${table} WHERE ${table === "projects" ? "id" : "project_id"}=ANY($1::uuid[])`, [ids]);
      }
    }
    for (const account of [owner, other]) {
      await control.query("DELETE FROM app.profiles WHERE id=$1", [account.id]);
      await control.query("DELETE FROM app.schools WHERE id=$1", [account.schoolId]);
      await deleteSyntheticAuthAccount(account);
    }
    console.log("FormalClassificationCleanup=verified synthetic rows removed");
  } finally { await control.end(); }
});
describe("T051 真 Auth／Route Handler／隔離 DB", () => {
  it("首次／同內容／修改／改回原文 revision、明確確認、失效及原 receipt replay", async () => {
    const id = await project();
    const firstKey = randomUUID();
    const first = await save(id, 0, 0, requirements, firstKey);
    expect(first.status).toBe(200);
    expect(first.headers.get("cache-control")).toBe("no-store");
    expect((await first.json()).current).toMatchObject({ requirements, row_version: 1, requirements_revision: 1 });
    expect((await save(id, 1, 1)).status).toBe(200);
    expect((await read(id)).body).toMatchObject({ row_version: 1, requirements_revision: 1 });
    const confirmationKey = randomUUID();
    const response = await confirm(id, 1, 1, "A", false, "matches", confirmationKey);
    expect(response.status).toBe(200);
    const originalReceipt = (await response.json()).operation;
    const evidence = (await snapshot(id)).confirmations;
    expect(evidence).toHaveLength(1);
    expect(evidence[0]).toMatchObject({
      requirements_description: requirements.description, requirements_revision: 1,
      confirmed_by: owner.id, source: "student_explicit_confirmation",
    });
    expect((await resolveTrustedProjectClassification(createDatabaseSession(owner.id).read, id)).outcome).toBe("trusted");
    await save(id, 2, 1, { ...requirements, description: "第二版" });
    await save(id, 3, 2);
    expect((await read(id)).body).toMatchObject({ row_version: 4, requirements_revision: 3,
      classification_state: "unconfirmed", confirmation: null, requirements });
    const replay = await confirm(id, 1, 1, "A", false, "matches", confirmationKey);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ outcome: "replayed", operation: originalReceipt,
      current: { classification_state: "unconfirmed", requirements_revision: 3 } });
    expect((await snapshot(id)).confirmations).toEqual(evidence);
    expect((await resolveTrustedProjectClassification(createDatabaseSession(owner.id).read, id)).outcome).toBe("unconfirmed");
    expect((await save(id, 0, 0, requirements, firstKey)).status).toBe(200);
    expect((await read(id)).body.row_version).toBe(4);
    const db = await snapshot(id);
    expect(db.requirements.map((row: { revision: number }) => row.revision)).toEqual([1, 2, 3]);
    expect(db.project.stage).toBe("點子");
    console.log("FormalDBEvidence=revision1,2,3 row_version4 current_null original_confirmation_immutable owner_verified");
  });
  it("雙版本 stale／缺版本／重複来源拒絕，未改寫", async () => {
    const id = await project();
    await save(id, 0, 0);
    const before = await snapshot(id);
    expect((await save(id, 0, 1)).status).toBe(409);
    expect((await save(id, 1, 0)).status).toBe(409);
    const body = { expected_requirements_revision: 1, requirements, expected_row_version: 99 };
    expect((await PUT(request(id, "PUT", body, 1), context(id))).status).toBe(400);
    const missing = request(id, "PUT", { expected_requirements_revision: 1, requirements }, 1);
    missing.headers.delete("if-match");
    expect((await PUT(missing, context(id))).status).toBe(400);
    expect(await snapshot(id)).toEqual(before);
  });
  it("同鍵異意圖與並行同鍵重送只產生一 revision／確認", async () => {
    const id = await project();
    const key = randomUUID();
    const responses = await Promise.all([save(id, 0, 0, requirements, key), save(id, 0, 0, requirements, key)]);
    expect(responses.map((r) => r.status)).toEqual([200, 200]);
    expect((await save(id, 0, 0, { ...requirements, description: "異意圖" }, key)).status).toBe(422);
    const confirmationKey = randomUUID();
    const confirmed = await Promise.all([confirm(id, 1, 1, "A", false, "matches", confirmationKey),
      confirm(id, 1, 1, "A", false, "matches", confirmationKey)]);
    expect(confirmed.map((r) => r.status)).toEqual([200, 200]);
    const db = await snapshot(id);
    expect(db.requirements).toHaveLength(1);
    expect(db.confirmations).toHaveLength(1);
    expect(db.project.row_version).toBe(2);
  });
  it("保存／確認競態：不確認錯 revision，只有一個版本勝者", async () => {
    const id = await project();
    await save(id, 0, 0);
    const results = await Promise.all([
      save(id, 1, 1, { ...requirements, description: "競態新需求" }), confirm(id, 1, 1),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    const db = await snapshot(id);
    if (db.project.requirements_revision === 2) {
      expect(db.project.current_confirmation_id).toBeNull();
      expect(db.confirmations).toHaveLength(0);
    } else {
      expect(db.confirmations).toHaveLength(1);
      expect(db.confirmations[0].requirements_revision).toBe(1);
    }
  });
  it("B／visitor／偏好明示；不支援需求可保存但不能確認", async () => {
    const id = await project();
    await save(id, 0, 0, { ...requirements, runtime_needs: "work_data_api" });
    expect((await confirm(id, 1, 1, "B", false, "matches")).status).toBe(422);
    expect((await confirm(id, 1, 1, "A")).status).toBe(422);
    const missingVisitor = request(id, "POST", { expected_requirements_revision: 1,
      tier: "B", requested_tier_acknowledgement: "explicit_change" }, 1);
    expect((await POST(missingVisitor, context(id))).status).toBe(400);
    expect((await confirm(id, 1, 1, "B", true, "explicit_change")).status).toBe(200);
    expect((await read(id)).body).toMatchObject({ tier: "B", needs_visitor_identity: true });
    for (const value of [
      { ...requirements, runtime_needs: "restricted_server" },
      { ...requirements, runtime_ai_required: true },
    ]) {
      const current = (await read(id)).body;
      expect((await save(id, current.row_version, current.requirements_revision, value)).status).toBe(200);
      const saved = (await read(id)).body;
      expect(saved.requirements).toEqual(value);
      expect((await confirm(id, saved.row_version, saved.requirements_revision)).status).toBe(422);
      expect((await read(id)).body.classification_state).toBe("unconfirmed");
    }
  });
  it("非 owner／跨帳號／非學生／失權／school gate 皆拒絕且不洩漏", async () => {
    const id = await project();
    await save(id, 0, 0);
    expect((await read(id, otherSession)).status).toBe(404);
    expect((await save(id, 1, 1, requirements, randomUUID(), otherSession)).status).toBe(404);
    expect((await confirm(id, 1, 1, "A", false, "matches", randomUUID(), otherSession)).status).toBe(404);
    for (const role of ["teacher", "admin"]) {
      await control.query("UPDATE app.profiles SET role=$1 WHERE id=$2", [role, other.id]);
      expect((await save(id, 1, 1, requirements, randomUUID(), otherSession)).status).toBe(403);
    }
    await control.query("UPDATE app.profiles SET role='student' WHERE id=$1", [other.id]);
    for (const status of ["disabled", "rejected", "pending"]) {
      await control.query("UPDATE app.profiles SET status=$1 WHERE id=$2", [status, owner.id]);
      expect([401, 403]).toContain((await confirm(id, 1, 1)).status);
    }
    await control.query("UPDATE app.profiles SET status='approved' WHERE id=$1", [owner.id]);
    for (const gate of ["unconfirmed", "withdrawn", "expired"]) {
      await control.query("UPDATE app.schools SET approval_state=$1 WHERE id=$2", [gate, owner.schoolId]);
      expect((await save(id, 1, 1)).status).toBe(gate === "unconfirmed" ? 403 : 200);
    }
    await control.query("UPDATE app.schools SET approval_state='approved' WHERE id=$1", [owner.schoolId]);
    expect((await read(id)).body.classification_state).toBe("unconfirmed");
    expect((await PUT(request(id, "PUT", { expected_requirements_revision: 1, requirements }, 1,
      randomUUID(), session, { origin: "https://invalid.example" }), context(id))).status).toBe(403);
  });
  it.each(["requirements", "confirmation"] as const)("真 DB %s 中途故障整筆 rollback，固定去敏 unknown", async (kind) => {
    const id = await project();
    await save(id, 0, 0);
    const before = await snapshot(id);
    await control.query(`CREATE OR REPLACE FUNCTION app.test_classification_failure() RETURNS trigger
      LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'synthetic transaction failure'; END$$`);
    const table = kind === "requirements" ? "project_requirements" : "project_classification_confirmations";
    const trigger = kind === "requirements" ? "test_requirements_failure" : "test_classification_failure";
    try {
      await control.query(`CREATE TRIGGER ${trigger} BEFORE INSERT ON app.${table}
        FOR EACH ROW EXECUTE FUNCTION app.test_classification_failure()`);
      const response = kind === "requirements"
        ? await save(id, 1, 1, { ...requirements, description: "不能提交" }) : await confirm(id, 1, 1);
      expect(response.status).toBe(503);
      expect(response.headers.get("content-type")).toContain("application/problem+json");
      expect(JSON.stringify(await response.json())).not.toMatch(/SQL|stack|synthetic transaction|不能提交/);
      expect(await snapshot(id)).toEqual(before);
    } finally { await control.query(`DROP TRIGGER IF EXISTS ${trigger} ON app.${table}`); }
  });
  it("歷史 requirements／classification 即使控制連線也不可 UPDATE", async () => {
    const id = await project();
    await save(id, 0, 0);
    await confirm(id, 1, 1);
    const before = await snapshot(id);
    await expect(control.query("UPDATE app.project_requirements SET description='覆寫' WHERE project_id=$1", [id])).rejects.toThrow();
    await expect(control.query("UPDATE app.project_classification_confirmations SET tier='B' WHERE project_id=$1", [id])).rejects.toThrow();
    expect(await snapshot(id)).toEqual(before);
  });
  it("真正 Auth 故障拒絕；只暫停本輪指定 Auth 容器", async () => {
    const container = process.env.APP_PLANET_TEST_AUTH_CONTAINER;
    if (!container || !/^supabase_auth_app-planet-auth-[a-f0-9]{12}$/.test(container)) throw new Error("缺少本輪隔離 Auth 容器");
    const id = await project();
    try {
      execFileSync("docker", ["pause", container], { stdio: "ignore" });
      expect((await read(id)).status).toBe(503);
    } finally { execFileSync("docker", ["unpause", container], { stdio: "ignore" }); }
  });
  it("DB dependency 故障不可回成功，after-Auth gate 在真正 DB 執行", async () => {
    const id = await project();
    const resolver = createAuthPrincipalResolver();
    const handlers = createProjectClassificationHandlers({ resolver, requireSameOrigin: true });
    try {
      await control.query("REVOKE EXECUTE ON FUNCTION app.save_project_requirements(uuid,integer,integer,text,text,boolean,uuid) FROM authenticated");
      const response = await handlers.save(request(id, "PUT", { expected_requirements_revision: 0, requirements }), { id });
      expect(response.status).toBe(503);
      expect((await read(id)).body.requirements_revision).toBe(0);
    } finally {
      await control.query("GRANT EXECUTE ON FUNCTION app.save_project_requirements(uuid,integer,integer,text,text,boolean,uuid) TO authenticated");
    }
  });
});
