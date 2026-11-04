import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CREATION_FLOW_STAGES } from "@app-planet/core";
import { createAuthPrincipalResolver, sessionCookieName } from "../../apps/web/src/server/auth-principal.ts";
import { closeServerDatabasePool } from "../../apps/web/src/server/database-session.ts";
import { createProjectHandlers } from "../../apps/web/src/server/project-handlers.ts";
import { readCreationFlowPageData } from "../../apps/web/src/server/creation-flow-page-data.ts";
import { PUT } from "../../apps/web/src/app/api/v1/projects/[id]/requirements/route.ts";
import { POST } from "../../apps/web/src/app/api/v1/projects/[id]/classification/confirmation/route.ts";
import {
  createSyntheticAuthAccount, deleteSyntheticAuthAccount, loginSyntheticAccount, openControlPool,
  type NativeAuthSession, type SyntheticAuthAccount,
} from "../support/real-auth-fixture.ts";

const origin = process.env.APP_PLANET_APP_ORIGIN!;
let control: Pool;
let owner: SyntheticAuthAccount;
let other: SyntheticAuthAccount;
let session: NativeAuthSession;
let otherSession: NativeAuthSession;
let projectId: string;
function request(path: string, method = "GET", body?: unknown, version = 0, key = randomUUID(), actor = session) {
  return new Request(`${origin}${path}`, { method, headers: {
    cookie: `${sessionCookieName}=${actor.accessToken}`, origin, "content-type": "application/json",
    "if-match": `"${version}"`, "idempotency-key": key,
  }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
async function principal(actor = session) {
  const resolved = await createAuthPrincipalResolver().resolve(request("/", "GET", undefined, 0, randomUUID(), actor));
  if (!resolved.ok) throw new Error("synthetic principal unavailable");
  return resolved;
}
async function read(query: Record<string, string | string[]> = {}, actor = session) {
  return readCreationFlowPageData((await principal(actor)).session.read, projectId, "點子", query);
}
async function versions() {
  return (await control.query("SELECT stage,row_version,requirements_revision FROM app.projects WHERE id=$1", [projectId])).rows[0];
}
beforeAll(async () => {
  control = openControlPool();
  owner = await createSyntheticAuthAccount(control, "FlowOwner");
  other = await createSyntheticAuthAccount(control, "FlowOther");
  session = await loginSyntheticAccount(owner);
  otherSession = await loginSyntheticAccount(other);
  const response = await createProjectHandlers({ resolver: createAuthPrincipalResolver(), requireSameOrigin: true })
    .create(request("/api/v1/projects", "POST", { title: "合成目標階段檢查" }));
  expect(response.status).toBe(201);
  projectId = (await response.json()).id;
});
afterAll(async () => {
  try {
    await closeServerDatabasePool();
    if (projectId) {
      await control.query(`UPDATE app.projects SET classification_state='unconfirmed',tier=NULL,
        needs_visitor_identity=NULL,current_confirmation_id=NULL WHERE id=$1`, [projectId]);
      for (const table of ["project_classification_idempotency", "project_classification_confirmations",
        "project_requirements", "project_create_idempotency", "projects"]) {
        await control.query(`DELETE FROM app.${table} WHERE ${table === "projects" ? "id" : "project_id"}=$1`, [projectId]);
      }
    }
    for (const account of [owner, other]) {
      await control.query("DELETE FROM app.profiles WHERE id=$1", [account.id]);
      await control.query("DELETE FROM app.schools WHERE id=$1", [account.schoolId]);
      await deleteSyntheticAuthAccount(account);
    }
    console.log("CreationFlowCleanup=synthetic accounts and owned rows removed");
  } finally { await control.end(); }
});
describe("真 Auth／DB 目標階段產品投影", () => {
  it("九個真 requested_stage、正式保存／確認／修改／舊 receipt，不寫階段或版本", async () => {
    const before = await versions();
    for (const [index, stage] of CREATION_FLOW_STAGES.entries()) {
      const value = await read({ requested_stage: stage });
      expect(value).toMatchObject({ outcome: "evaluated", snapshot: "single_statement",
        assessment: { requested_stage: stage, requested_stage_prerequisites: CREATION_FLOW_STAGES.slice(0, index),
          classification_assessment: { outcome: "missing_evidence" }, observed_drafts: [] } });
    }
    expect(await versions()).toEqual(before);
    const requirements = { description: "從產品交易保存的正式需求", runtime_needs: "static", runtime_ai_required: false };
    const params = { params: Promise.resolve({ id: projectId }) };
    const save = (version: number, revision: number, description: string) => PUT(request(
      `/api/v1/projects/${projectId}/requirements`, "PUT",
      { expected_requirements_revision: revision, requirements: { ...requirements, description } }, version), params);
    expect((await save(0, 0, requirements.description)).status).toBe(200);
    const key = randomUUID();
    const confirmBody = { expected_requirements_revision: 1, tier: "A", needs_visitor_identity: false,
      requested_tier_acknowledgement: "no_preference" };
    const confirm = () => POST(request(`/api/v1/projects/${projectId}/classification/confirmation`,
      "POST", confirmBody, 1, key), params);
    expect((await confirm()).status).toBe(200);
    const confirmedVersion = await versions();
    expect(await read({ requested_stage: "Technical Plan" })).toMatchObject({ outcome: "evaluated",
      assessment: { classification_assessment: { outcome: "satisfied", tier: "A", requirements_revision: 1 },
        work_scope_assessment: { outcome: "satisfied" }, stage_assessment: { outcome: "unsupported" } } });
    expect(await versions()).toEqual(confirmedVersion);
    expect((await save(2, 1, "修改需求")).status).toBe(200);
    const changed = await versions();
    expect((await confirm()).status).toBe(200);
    expect(await read()).toMatchObject({ outcome: "evaluated", requirements_revision: 2,
      assessment: { classification_assessment: { outcome: "missing_evidence" },
        work_scope_assessment: { outcome: "missing_evidence" } } });
    expect(await versions()).toEqual(changed);
    expect(changed).toEqual({ stage: "點子", row_version: 3, requirements_revision: 2 });
  });
  it("URL 自報／重複目標拒絕，跨帳號／撤權與依賴故障不回資料", async () => {
    const before = await versions();
    expect(await read({ requested_stage: "Final Pack", approved: "true" })).toEqual({ outcome: "invalid_selection" });
    expect(await read({ requested_stage: ["點子", "Final Pack"] })).toEqual({ outcome: "invalid_selection" });
    expect(await read({}, otherSession)).toEqual({ outcome: "not_found" });
    const boundPrincipal = await principal();
    await control.query("UPDATE app.profiles SET status='disabled' WHERE id=$1", [owner.id]);
    try {
      expect(await readCreationFlowPageData(boundPrincipal.session.read, projectId, "點子", {}))
        .toEqual({ outcome: "denied", reason: "policy_denied" });
    } finally { await control.query("UPDATE app.profiles SET status='approved' WHERE id=$1", [owner.id]); }
    expect(await readCreationFlowPageData({ runReadOnly: async () => { throw new Error("isolated dependency failure"); } },
      projectId, "點子", {})).toEqual({ outcome: "failed", reason: "dependency_failure" });
    const anonymous = await createAuthPrincipalResolver().resolve(new Request(`${origin}/`));
    expect(anonymous).toMatchObject({ ok: false, reason: "unauthenticated" });
    expect(await versions()).toEqual(before);
  });
  it("真正 Auth 服務故障與 DB SELECT 撤權均安全失敗，復原後重新讀取", async () => {
    const before = await versions();
    const container = process.env.APP_PLANET_TEST_AUTH_CONTAINER;
    if (!container || !/^supabase_auth_app-planet-auth-[a-f0-9]{12}$/.test(container)) {
      throw new Error("缺少本輪專屬 Auth 容器");
    }
    try {
      execFileSync("docker", ["pause", container], { stdio: "ignore" });
      expect(await createAuthPrincipalResolver().resolve(request("/")))
        .toMatchObject({ ok: false, reason: "dependency_unavailable" });
    } finally { execFileSync("docker", ["unpause", container], { stdio: "ignore" }); }
    const boundPrincipal = await principal();
    try {
      await control.query("REVOKE SELECT ON app.stage_records FROM authenticated");
      expect(await readCreationFlowPageData(boundPrincipal.session.read, projectId, "點子", {}))
        .toEqual({ outcome: "failed", reason: "dependency_failure" });
    } finally { await control.query("GRANT SELECT ON app.stage_records TO authenticated"); }
    expect(await read()).toMatchObject({ outcome: "evaluated" });
    expect(await versions()).toEqual(before);
  });
});
