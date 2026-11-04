import { createHash, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeServerDatabasePool } from "../../apps/web/src/server/database-session.ts";
import { createAuthPrincipalResolver, sessionCookieName } from "../../apps/web/src/server/auth-principal.ts";
import { readOwnedProjectStageOverviewSubset } from "../../apps/web/src/server/creation-flow-assessment.ts";
import { PUT as saveDraftRoute } from "../../apps/web/src/app/api/v1/projects/[id]/stages/[stage]/route.ts";
import { POST as confirmRoute } from "../../apps/web/src/app/api/v1/projects/[id]/stages/[stage]/confirmation/route.ts";
import {
  closeSyntheticWorkerPool, createOwnedSyntheticProject, createSyntheticAuthAccount,
  deleteSyntheticAuthAccount, loginSyntheticAccount, openControlPool,
  type NativeAuthSession, type SyntheticAuthAccount,
} from "../support/real-auth-fixture.ts";

const appOrigin = process.env.APP_PLANET_APP_ORIGIN!;
const accounts: SyntheticAuthAccount[] = [];
const projectIds: string[] = [];
let control!: Pool;
let owner: SyntheticAuthAccount;
let other: SyntheticAuthAccount;
let ownerSession: NativeAuthSession;
let otherSession: NativeAuthSession;

function req(path: string, method: string, session: NativeAuthSession, headers: Record<string, string>, body?: unknown) {
  const h = new Headers({ ...headers, origin: appOrigin, cookie: `${sessionCookieName}=${session.accessToken}` });
  if (body !== undefined) h.set("content-type", "application/json");
  return new Request(`${appOrigin}${path}`, { method, headers: h, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
const stagePath = (p: string, s: string) => `/api/v1/projects/${p}/stages/${encodeURIComponent(s)}`;
const save = (p: string, s: string, text: string, version: number | null, session = ownerSession) =>
  saveDraftRoute(req(stagePath(p, s), "PUT", session, {
    "idempotency-key": randomUUID(),
    ...(version === null ? { "if-none-match": "*" } : { "if-match": `"${version}"` }),
  }, { content: { text } }), { params: Promise.resolve({ id: p, stage: s }) });
const confirm = (p: string, s: string, version: number) =>
  confirmRoute(req(`${stagePath(p, s)}/confirmation`, "POST", ownerSession, { "idempotency-key": randomUUID() },
    { expected_row_version: version }), { params: Promise.resolve({ id: p, stage: s }) });

async function overview(project: string, session: NativeAuthSession = ownerSession) {
  const principal = await createAuthPrincipalResolver().resolve(
    new Request(`${appOrigin}/`, { headers: { cookie: `${sessionCookieName}=${session.accessToken}` } }));
  if (!principal.ok) throw new Error("principal");
  return readOwnedProjectStageOverviewSubset(principal.session.read, project);
}
const states = async (project: string) => {
  const r = await overview(project);
  if (r.outcome !== "found") throw new Error(`not found: ${JSON.stringify(r)}`);
  return Object.fromEntries(r.items.map((i) => [i.stage, i.state]));
};
const newProject = async () => { const id = await createOwnedSyntheticProject(owner); projectIds.push(id); return id; };

beforeAll(async () => {
  control = openControlPool();
  owner = await createSyntheticAuthAccount(control, "OverviewOwner");
  other = await createSyntheticAuthAccount(control, "OverviewOther");
  accounts.push(owner, other);
  ownerSession = await loginSyntheticAccount(owner);
  otherSession = await loginSyntheticAccount(other);
});

afterAll(async () => {
  try {
    await control.query("DROP TRIGGER IF EXISTS test_fail_overview ON app.stage_records");
    await control.query("DROP FUNCTION IF EXISTS app.test_fail_overview()");
    await closeServerDatabasePool();
    await closeSyntheticWorkerPool();
    if (projectIds.length) {
      await control.query("DELETE FROM app.stage_draft_confirmations WHERE project_id=ANY($1::uuid[])", [projectIds]);
      await control.query("DELETE FROM app.stage_draft_idempotency WHERE project_id=ANY($1::uuid[])", [projectIds]);
      await control.query("DELETE FROM app.stage_records WHERE project_id=ANY($1::uuid[])", [projectIds]);
      await control.query("DELETE FROM app.project_create_idempotency WHERE project_id=ANY($1::uuid[])", [projectIds]);
      await control.query("DELETE FROM app.projects WHERE id=ANY($1::uuid[])", [projectIds]);
    }
    for (const account of accounts) {
      await control.query("DELETE FROM app.profiles WHERE id=$1", [account.id]);
      await control.query("DELETE FROM app.schools WHERE id=$1", [account.schoolId]);
      await deleteSyntheticAuthAccount(account);
    }
  } finally {
    await control.end();
  }
});

describe("九階段總覽（真 Auth → 單一 snapshot → 隔離 PostgreSQL）", () => {
  it("無稿 → 未確認 → 確認有效 → 再保存失效 → 改回相同文字不復活；九階段順序固定", async () => {
    const p = await newProject();
    const first = await overview(p);
    expect(first.outcome).toBe("found");
    if (first.outcome !== "found") return;
    expect(first.items.map((i) => i.stage)).toEqual([
      "點子", "A/B", "Specification", "Checkpoint", "Constitution", "UX/UI", "Specification Sync", "Technical Plan", "Final Pack"]);
    expect(first.items.every((i) => i.state === "no_draft" &&
      i.approval === (i.stage === "Specification" ? "separate_specification_review" : "manual_approval_unavailable"))).toBe(true);
    expect(first.completion_judgment).toMatch(/unsupported_rules_undecided|missing_classification_evidence/);

    expect((await save(p, "Specification", "第一版", null)).status).toBe(201);
    expect((await states(p)).Specification).toBe("unconfirmed");
    expect((await confirm(p, "Specification", 0)).status).toBe(201);
    expect((await states(p)).Specification).toBe("confirmed_current");
    expect((await save(p, "Specification", "第二版", 0)).status).toBe(200);
    expect((await states(p)).Specification).toBe("confirmation_stale");
    expect((await save(p, "Specification", "第一版", 1)).status).toBe(200);
    expect((await states(p)).Specification).toBe("confirmation_stale");
    expect((await states(p)).Checkpoint).toBe("no_draft");
    const after = await control.query("SELECT stage,classification_state,current_confirmation_id FROM app.projects WHERE id=$1", [p]);
    expect(after.rows).toEqual([{ stage: "點子", classification_state: "unconfirmed", current_confirmation_id: null }]);
    expect((await control.query(
      "SELECT count(*)::int n FROM app.stage_records WHERE project_id=$1 AND (state<>'ai_draft' OR approved_by IS NOT NULL)", [p])).rows[0].n).toBe(0);
  });

  it("兩個專案狀態互不影響；跨帳號／錯專案不洩漏", async () => {
    const a = await newProject();
    const b = await newProject();
    await save(a, "點子", "A 稿", null);
    await save(b, "點子", "B 稿", null);
    await confirm(a, "點子", 0);
    expect((await states(a)).點子).toBe("confirmed_current");
    expect((await states(b)).點子).toBe("unconfirmed");
    const foreign = await overview(a, otherSession);
    expect(["not_found", "denied"]).toContain(foreign.outcome);
    expect(JSON.stringify(foreign)).not.toMatch(/A 稿|confirmed_current/);
    expect((await overview(randomUUID())).outcome).not.toBe("found");
    expect((await overview("not-a-uuid")).outcome).toBe("failed");
  });

  it("DB 故障回 failed，不是空專案", async () => {
    const p = await newProject();
    await save(p, "點子", "x", null);
    await control.query(`CREATE OR REPLACE FUNCTION app.test_fail_overview() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'x'; END $$`);
    const broken = { runReadOnly: async () => { throw new Error("db down"); } } as never;
    expect(await readOwnedProjectStageOverviewSubset(broken, p)).toMatchObject({ outcome: "failed" });
    expect(createHash("sha256").update("x").digest("hex")).toHaveLength(64);
  });
});
