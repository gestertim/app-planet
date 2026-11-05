import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { setTimeout as delay } from "node:timers/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { productSpecificationReviewHandlers as review, productProjectClassificationHandlers as classification,
  productProjectHandlers as projects, productFoundationHandlers as foundation } from "../../apps/web/src/server/product-handlers.ts";
import { closeServerDatabasePool, createDatabaseSession } from "../../apps/web/src/server/database-session.ts";
import { sessionCookieName } from "../../apps/web/src/server/auth-principal.ts";
import { loginSyntheticAccount, openControlPool, type NativeAuthSession } from "../support/real-auth-fixture.ts";
import { cleanupReviewActors, createReviewActors } from "../support/specification-review-fixture.ts";
import { specificationStatusSchema, specificationListSchema, specificationReasonSchema, specificationReceiptSchema } from "@app-planet/core";

const origin = process.env.APP_PLANET_APP_ORIGIN!;
const control = openControlPool();
let actors: Awaited<ReturnType<typeof createReviewActors>>;
let student: NativeAuthSession, otherStudent: NativeAuthSession, teacher: NativeAuthSession, outsider: NativeAuthSession, admin: NativeAuthSession;
const params = (id: string) => ({ id });
function request(actor: NativeAuthSession | null, method: string, path: string, body?: unknown,
  key = randomUUID(), headers: Record<string, string> = {}) {
  return new Request(origin + path, { method, headers: {
    ...(actor ? { cookie: `${sessionCookieName}=${actor.accessToken}` } : {}),
    origin, "content-type": "application/json", "idempotency-key": key, ...headers,
  }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
async function status(id: string, actor = student) {
  const response = await review.read(request(actor, "GET", `/api/v1/projects/${id}/stages/Specification/submissions`), params(id));
  expect(response.status).toBe(200);
  return specificationStatusSchema.parse(await response.json());
}
async function setupProject(actor = student) {
  const create = await projects.create(request(actor, "POST", "/api/v1/projects", { title: "合成規格審查" }));
  expect(create.status).toBe(201);
  const id = (await create.json()).id as string;
  const saved = await classification.save(request(actor, "PUT", `/api/v1/projects/${id}/requirements`, {
    expected_requirements_revision: 0, requirements: { description: "正式需求", runtime_needs: "static", runtime_ai_required: false },
  }, randomUUID(), { "if-match": '"0"' }), params(id));
  expect(saved.status).toBe(200);
  const confirmed = await classification.confirm(request(actor, "POST", `/api/v1/projects/${id}/classification/confirmation`, {
    expected_requirements_revision: 1, tier: "A", needs_visitor_identity: false, requested_tier_acknowledgement: "no_preference",
  }, randomUUID(), { "if-match": '"1"' }), params(id));
  expect(confirmed.status).toBe(200);
  const draft = await foundation.saveStageDraft(request(actor, "PUT", `/api/v1/projects/${id}/stages/Specification`,
    { content: { text: "確切規格原文" } }, randomUUID(), { "if-none-match": "*" }), id, "Specification");
  expect(draft.status).toBe(201);
  return id;
}
async function submit(id: string, key = randomUUID(), body?: unknown, actor = student) {
  const e = (await status(id, actor)).evidence;
  return review.submit(request(actor, "POST", `/api/v1/projects/${id}/stages/Specification/submissions`, body ?? {
    expected_draft_version: e.draft_version, expected_requirements_revision: e.requirements_revision,
    expected_classification_id: e.classification_id,
  }, key), params(id));
}
const decide = (id: string, decision = "approved", reason: string | null = null, key = randomUUID(), actor = teacher) =>
  review.decide(request(actor, "POST", `/api/v1/teacher/specification-submissions/${id}/decision`,
    { decision, reason }, key), params(id));
async function submitted() {
  const id = await setupProject();
  const response = await submit(id);
  expect(response.status).toBe(200);
  return { id, submission: (await response.json()).submission_id as string };
}
const directDecision = async (submission: string, reason: string, key = randomUUID()) => {
  const result = await createDatabaseSession(teacher.userId).write.runTransaction((q) => q.query(
    "SELECT app.decide_specification($1::uuid,'returned',$2::text,$3::uuid) result", [submission, reason, key],
  ));
  return z.object({ result: z.union([specificationReceiptSchema,
    z.object({ outcome: z.enum(["invalid_input", "idempotency_conflict"]) }).strict()]) }).parse(result.rows[0]).result;
};
async function reviewSnapshot(id: string) {
  return (await control.query(`SELECT
    (SELECT to_jsonb(p) FROM app.projects p WHERE id=$1) project,
    (SELECT jsonb_agg(to_jsonb(d) ORDER BY d.stage) FROM app.stage_records d WHERE project_id=$1) drafts,
    (SELECT jsonb_agg(to_jsonb(s) ORDER BY s.sequence) FROM app.specification_submissions s WHERE project_id=$1) submissions,
    (SELECT jsonb_agg(to_jsonb(d) ORDER BY d.submission_id) FROM app.specification_decisions d
      JOIN app.specification_submissions s ON s.id=d.submission_id WHERE s.project_id=$1) decisions,
    (SELECT jsonb_agg(to_jsonb(a) ORDER BY a.id) FROM app.audit_events a WHERE object_ref=$1) audits`, [id])).rows[0];
}
const invalidReasons = [
  "\u3000", "\u00a0", " \u3000\u00a0 ", "\u1680", "\u2000\u200a", "\u2028\u2029", "\u202f", "\u205f", "\ufeff",
  "\t\r\n", "字\u0001", "字\u007f", "字\u0085", "字\u009f",
  "字".repeat(2001), " " + "字".repeat(1999) + " ", "😀".repeat(2000) + "字", " ".repeat(2000) + "字",
];
const validReasons = ["\u3000 請補充按鈕用途 \u00a0", " " + "字".repeat(1998) + " ",
  "😀".repeat(2000), "😀".repeat(1998) + "字 ", "😀".repeat(1000) + "字", "\u200b", "\u180e"];
async function waitForBlockedCall(functionName: "submit_specification" | "decide_specification" | "save_stage_draft") {
  for (let attempt = 0; attempt < 100; attempt++) {
    const { rows } = await control.query(`SELECT 1 FROM pg_stat_activity
      WHERE application_name='app-planet-web' AND wait_event_type='Lock' AND query LIKE $1`,
    [`%app.${functionName}(%`]);
    if (rows.length) return;
    await delay(20);
  }
  throw new Error(`synthetic lock barrier not reached: ${functionName}`);
}
beforeAll(async () => {
  actors = await createReviewActors(control);
  [student, otherStudent, teacher, outsider, admin] = await Promise.all(
    [actors.student, actors.otherStudent, actors.teacher, actors.outsider, actors.admin].map(loginSyntheticAccount));
});
afterAll(async () => {
  await closeServerDatabasePool();
  await cleanupReviewActors(control, actors);
  await control.end();
});
describe("Specification 真 Auth／HTTP／交易／持久失效", () => {
  it.runIf(process.env.APP_PLANET_TEST_MIGRATE_THROUGH === "0030")(
    "0030→0031：不合法歷史阻擋只報數量；合法歷史原文／關聯不變", async () => {
      const approved = await submitted(), returned = await submitted(), pending = await submitted();
      expect((await decide(approved.submission)).status).toBe(200);
      const reason = "\u3000 合法歷史理由 😀 \u00a0";
      expect((await directDecision(returned.submission, reason)).outcome).toBe("decided");
      const before = await Promise.all([reviewSnapshot(approved.id), reviewSnapshot(returned.id), reviewSnapshot(pending.id)]);
      const migration = await readFile(new URL("../../supabase/migrations/0031_specification_reason_boundary.sql", import.meta.url), "utf8");
      const client = await control.connect();
      try {
        await client.query("BEGIN");
        await client.query("SET LOCAL ROLE authenticated");
        await client.query("SELECT set_config('request.jwt.claim.sub',$1,true)", [teacher.userId]);
        expect((await client.query("SELECT app.decide_specification($1,'returned',$2,$3) result",
          [pending.submission, "\u3000", randomUUID()])).rows[0].result.outcome).toBe("decided");
        await client.query("RESET ROLE");
        const badBefore = (await client.query("SELECT to_jsonb(d) row FROM app.specification_decisions d WHERE submission_id=$1", [pending.submission])).rows;
        await client.query("SAVEPOINT before_upgrade");
        await expect(client.query(migration)).rejects.toMatchObject({
          message: "specification_reason_upgrade_blocked count=1",
        });
        await client.query("ROLLBACK TO SAVEPOINT before_upgrade");
        expect((await client.query("SELECT to_jsonb(d) row FROM app.specification_decisions d WHERE submission_id=$1",
          [pending.submission])).rows).toEqual(badBefore);
      } finally {
        // 只回滾本測試未提交的非法 seed，不修補或刪除持久歷史。
        await client.query("ROLLBACK");
        client.release();
      }
      await control.query(migration);
      expect(await Promise.all([reviewSnapshot(approved.id), reviewSnapshot(returned.id), reviewSnapshot(pending.id)])).toEqual(before);
      expect((await status(returned.id)).latest?.decision?.reason).toBe(reason);
      expect((await decide(pending.submission)).status).toBe(200);
      console.log("Upgrade0031=blocked_count_1_no_reason_output;synthetic_invalid_seed_rolled_back;legal_history_exactly_preserved");
    });
  it("有效綁定教師直呼 RPC：Unicode 空白／原文碼點超界／控制字元拒絕且無副作用", async () => {
    const { id, submission } = await submitted();
    const before = await reviewSnapshot(id);
    for (const reason of invalidReasons) {
      expect(specificationReasonSchema.safeParse(reason).success).toBe(false);
      expect(await directDecision(submission, reason)).toEqual({ outcome: "invalid_input" });
      expect(await reviewSnapshot(id)).toEqual(before);
    }
    for (const [index, reason] of validReasons.entries()) {
      const target = index === 0 ? submission : (await submitted()).submission;
      expect(specificationReasonSchema.safeParse(reason).success).toBe(true);
      const key = randomUUID();
      expect(await directDecision(target, reason, key)).toEqual({ outcome: "decided", submission_id: target });
      expect(await directDecision(target, reason, key)).toEqual({ outcome: "replayed", submission_id: target });
      expect(await directDecision(target, "不同原意圖", key)).toEqual({ outcome: "idempotency_conflict" });
      expect((await control.query("SELECT reason FROM app.specification_decisions WHERE submission_id=$1", [target])).rows).toEqual([{ reason }]);
      expect((await control.query(`SELECT count(*)::int n FROM app.audit_events a JOIN app.specification_submissions s
        ON a.object_ref=s.project_id WHERE s.id=$1 AND a.action='specification_returned'`, [target])).rows[0].n).toBe(1);
    }
    console.log(`ReasonRPC=invalid_${invalidReasons.length}_no_mutation;valid_${validReasons.length}_exact_original;codepoints_2000;replay_same_key`);
  });
  it("資料表 constraint 獨立拒絕非法理由，臨時 authenticated INSERT／helper 權限只存在回滾交易", async () => {
    const { id, submission } = await submitted();
    const before = await reviewSnapshot(id);
    const client = await control.connect();
    const insert = `INSERT INTO app.specification_decisions(submission_id,teacher_id,teacher_epoch,
      binding_id,binding_epoch,membership_id,membership_epoch,decision,reason,idempotency_key)
      VALUES($1,$2,0,$3,0,$4,0,'returned',$5,$6)`;
    try {
      await client.query("BEGIN");
      await client.query("GRANT INSERT ON app.specification_decisions TO authenticated");
      await client.query("GRANT EXECUTE ON FUNCTION app.specification_reason_valid(text) TO authenticated");
      await client.query(`CREATE POLICY test_reason_insert ON app.specification_decisions
        FOR INSERT TO authenticated WITH CHECK(teacher_id=auth.uid())`);
      await client.query("SET LOCAL ROLE authenticated");
      await client.query("SELECT set_config('request.jwt.claim.sub',$1,true)", [teacher.userId]);
      expect((await client.query("SELECT current_user AS role,auth.uid() AS subject")).rows[0])
        .toEqual({ role: "authenticated", subject: teacher.userId });
      for (const reason of invalidReasons) {
        await client.query("SAVEPOINT invalid_reason");
        await expect(client.query(insert, [submission, teacher.userId, actors.binding, actors.membership, reason, randomUUID()]))
          .rejects.toMatchObject({ code: "23514", constraint: "specification_decisions_reason_valid" });
        await client.query("ROLLBACK TO SAVEPOINT invalid_reason");
      }
      for (const reason of validReasons) {
        await client.query("SAVEPOINT valid_reason");
        await client.query(insert, [submission, teacher.userId, actors.binding, actors.membership, reason, randomUUID()]);
        await client.query("RESET ROLE");
        expect((await client.query("SELECT reason FROM app.specification_decisions WHERE submission_id=$1", [submission])).rows).toEqual([{ reason }]);
        await client.query("ROLLBACK TO SAVEPOINT valid_reason");
      }
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
    expect(await reviewSnapshot(id)).toEqual(before);
    for (const role of ["anon", "authenticated", "service_role"]) {
      expect((await control.query(`SELECT has_table_privilege($1,'app.specification_decisions','INSERT') AS dml,
        has_function_privilege($1,'app.specification_reason_valid(text)','EXECUTE') AS helper`, [role])).rows[0])
        .toEqual({ dml: false, helper: false });
    }
    expect((await control.query("SELECT proconfig FROM pg_proc WHERE oid='app.specification_reason_valid(text)'::regprocedure")).rows[0].proconfig)
      .toContain("search_path=pg_catalog");
    expect((await control.query("SELECT 1 FROM pg_policies WHERE policyname='test_reason_insert'")).rowCount).toBe(0);
    expect((await directDecision(submission, "後續合法決策")).outcome).toBe("decided");
    console.log("ReasonConstraint=independent_23514;legal_original_preserved;temporary_privileges_rolled_back;subsequent_RPC_succeeded");
  });
  it("學生 A 不能讀取或送審真實學生 B 的既存已提交專案；B 原文／版本／決策／稽核不變", async () => {
    expect(student.userId).not.toBe(otherStudent.userId);
    const id = await setupProject(otherStudent);
    const sent = await submit(id, randomUUID(), undefined, otherStudent);
    expect(sent.status).toBe(200);
    const submission = (await sent.json()).submission_id as string;
    expect((await decide(submission, "returned", "僅學生 B 可讀理由")).status).toBe(200);
    const own = await status(id, otherStudent);
    expect(own.latest).toMatchObject({ id: submission, specification: { text: "確切規格原文" },
      requirements: { description: "正式需求" }, decision: { reason: "僅學生 B 可讀理由" } });
    const before = await reviewSnapshot(id);
    const path = `/api/v1/projects/${id}/stages/Specification/submissions`;
    const denied = [
      await review.read(request(student, "GET", path), params(id)),
      await review.submit(request(student, "POST", path, {
        expected_draft_version: own.evidence.draft_version, expected_requirements_revision: own.evidence.requirements_revision,
        expected_classification_id: own.evidence.classification_id,
      }), params(id)),
    ];
    for (const response of denied) {
      expect(response.status).toBe(404);
      const raw = await response.text();
      for (const secret of ["確切規格原文", "正式需求", "僅學生 B 可讀理由", submission, own.evidence.classification_id!]) {
        expect(raw).not.toContain(secret);
      }
      expect(JSON.parse(raw)).not.toHaveProperty("evidence");
      expect(JSON.parse(raw)).not.toHaveProperty("latest");
    }
    expect(await reviewSnapshot(id)).toEqual(before);
    const resubmitted = await submit(id, randomUUID(), undefined, otherStudent);
    expect(resubmitted.status).toBe(200);
    expect((await decide((await resubmitted.json()).submission_id)).status).toBe(200);
    expect((await status(id, otherStudent)).latest?.state).toBe("approved");
    console.log("CrossStudent=distinct_native_auth_subjects;existing_B_saved_and_submitted;A_GET_POST_404_no_content;B_snapshot_unchanged;B_resubmit_approve_succeeded");
  });
  it("產品送審、列表、detail 稽核、批准／讀回，沒有學生階段確認前置", async () => {
    const { id, submission } = await submitted();
    const list = await review.list(request(teacher, "GET", "/api/v1/teacher/specification-submissions"));
    expect(list.status).toBe(200);
    expect(specificationListSchema.parse(await list.json()).items.map((item) => item.id)).toContain(submission);
    const detail = await review.detail(request(teacher, "GET", `/api/v1/teacher/specification-submissions/${submission}`), params(submission));
    expect(detail.status).toBe(200);
    expect((await detail.json()).submission.specification.text).toBe("確切規格原文");
    expect((await decide(submission)).status).toBe(200);
    expect((await status(id)).latest?.state).toBe("approved");
    expect((await control.query("SELECT stage FROM app.projects WHERE id=$1", [id])).rows[0].stage).toBe("點子");
    expect((await control.query("SELECT action FROM app.audit_events WHERE object_ref=$1 ORDER BY at", [id])).rows.map((r) => r.action))
      .toEqual(["specification_submitted", "teacher_view", "specification_approved"]);
  });
  it("退回理由、重新提交與不可改寫歷史", async () => {
    const { id, submission } = await submitted();
    expect((await decide(submission, "returned", "請說明按鈕用途")).status).toBe(200);
    expect((await status(id)).latest?.decision?.reason).toBe("請說明按鈕用途");
    expect((await submit(id)).status).toBe(200);
    expect((await status(id)).latest?.id).not.toBe(submission);
    await expect(control.query("UPDATE app.specification_submissions SET draft_version=draft_version WHERE id=$1", [submission])).rejects.toThrow();
    await expect(control.query("UPDATE app.specification_decisions SET reason='覆寫' WHERE submission_id=$1", [submission])).rejects.toThrow();
  });
  it("同鍵並行／異意圖與相反決策只有一筆成功；COMMIT 後原鍵 replay", async () => {
    const id = await setupProject(), key = randomUUID();
    const responses = await Promise.all([submit(id, key), submit(id, key)]);
    expect(responses.map((r) => r.status)).toEqual([200, 200]);
    const a = await responses[0].json(), b = await responses[1].json();
    expect(a.submission_id).toBe(b.submission_id);
    const k = randomUUID();
    const result = await Promise.all([decide(a.submission_id, "approved", null, k),
      decide(a.submission_id, "returned", "不同決定")]);
    expect(result.map((r) => r.status).sort()).toEqual([200, 409]);
    const state = (await status(id)).latest!;
    if (state.decision?.decision === "approved") {
      expect((await decide(a.submission_id, "approved", null, k)).status).toBe(200);
      expect((await decide(a.submission_id, "returned", "異意圖", k)).status).toBe(422);
    }
    expect((await control.query("SELECT count(*)::int n FROM app.specification_decisions WHERE submission_id=$1", [a.submission_id])).rows[0].n).toBe(1);
  });
  it("草稿修改、改回原文與舊 receipt 不恢復批准", async () => {
    const { id, submission } = await submitted(), key = randomUUID();
    expect((await decide(submission, "approved", null, key)).status).toBe(200);
    for (const [version, text] of [[0, "新內容"], [1, "確切規格原文"]] as const) {
      expect((await foundation.saveStageDraft(request(student, "PUT", `/api/v1/projects/${id}/stages/Specification`,
        { content: { text } }, randomUUID(), { "if-match": `"${version}"` }), id, "Specification")).status).toBe(200);
      expect((await status(id)).latest?.state).toBe("invalidated");
    }
    expect((await decide(submission, "approved", null, key)).status).toBe(200);
    expect((await status(id)).latest?.state).toBe("invalidated");
  });
  it.each(["teacher", "student", "school", "binding", "membership"] as const)("%s 失權／恢復後舊批准不復活", async (kind) => {
    const { id, submission } = await submitted();
    expect((await decide(submission)).status).toBe(200);
    const sql = kind === "teacher" || kind === "student"
      ? { table: "profiles", column: "status", bad: "disabled", good: "approved", id: actors[kind].id }
      : kind === "school" ? { table: "schools", column: "approval_state", bad: "withdrawn", good: "approved", id: actors.student.schoolId }
      : { table: kind === "binding" ? "teacher_student_bindings" : "teacher_school_memberships", column: "state",
        bad: "ended", good: "active", id: actors[kind] };
    if (kind === "membership") {
      await control.query("UPDATE app.teacher_school_memberships SET state='ended',ended_at=clock_timestamp(),ended_by_aid=gen_random_uuid() WHERE id=$1", [sql.id]);
    } else await control.query(`UPDATE app.${sql.table} SET ${sql.column}=$1 WHERE id=$2`, [sql.bad, sql.id]);
    const denied = await review.detail(request(teacher, "GET", `/api/v1/teacher/specification-submissions/${submission}`), params(submission));
    expect([401, 403, 404]).toContain(denied.status);
    if (kind !== "student") expect((await status(id)).latest?.state).toBe("invalidated");
    if (kind === "membership") {
      const nextMembership = randomUUID();
      await control.query(`INSERT INTO app.teacher_school_memberships(id,teacher_id,school_id,state,created_by_aid,created_at)
        SELECT $2,teacher_id,school_id,'active',created_by_aid,clock_timestamp()
        FROM app.teacher_school_memberships WHERE id=$1`, [sql.id, nextMembership]);
      actors.membership = nextMembership;
    } else await control.query(`UPDATE app.${sql.table} SET ${sql.column}=$1 WHERE id=$2`, [sql.good, sql.id]);
    expect((await status(id)).latest?.state).toBe("invalidated");
    expect((await decide(submission)).status).toBe(409);
  });
  it("未登入、冒充教師、非綁定與管理員、偽造證據與直接 DML／內部 RPC 均拒絕", async () => {
    const { id, submission } = await submitted();
    for (const actor of [null, student, outsider, admin]) {
      const response = await review.detail(request(actor, "GET", `/api/v1/teacher/specification-submissions/${submission}`), params(submission));
      expect([401, 403, 404]).toContain(response.status);
      expect(await response.text()).not.toContain("確切規格原文");
      const mutation = await review.decide(request(actor, "POST", `/api/v1/teacher/specification-submissions/${submission}/decision`,
        { decision: "approved", reason: null }), params(submission));
      expect([401, 403, 404]).toContain(mutation.status);
    }
    expect((await review.read(request(student, "GET", `/api/v1/projects/${randomUUID()}/stages/Specification/submissions`),
      params(randomUUID()))).status).toBe(404);
    expect((await submit(id, randomUUID(), { ...(await status(id)).evidence, approved: true })).status).toBe(400);
    const ctx = createDatabaseSession(actors.student.id);
    await expect(ctx.write.runTransaction((q) => q.query("SELECT app.specification_projection($1::uuid)", [submission]))).rejects.toThrow();
    await expect(ctx.write.runTransaction((q) => q.query("SELECT * FROM app.specification_submissions"))).rejects.toThrow();
    const direct = await ctx.write.runTransaction((q) => q.query("SELECT app.decide_specification($1::uuid,'approved',NULL,$2::uuid) result", [submission, randomUUID()]));
    expect(direct.rows[0]).toEqual({ result: { outcome: "not_found" } });
  });
  it("audit 故障使 submission 與 decision 整筆 rollback", async () => {
    const id = await setupProject();
    await control.query(`CREATE FUNCTION app.test_specification_audit_failure() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.action LIKE 'specification_%' THEN RAISE EXCEPTION 'synthetic failure'; END IF; RETURN NEW; END; $$`);
    await control.query(`CREATE TRIGGER test_specification_audit_failure BEFORE INSERT ON app.audit_events
      FOR EACH ROW EXECUTE FUNCTION app.test_specification_audit_failure()`);
    try {
      expect((await submit(id)).status).toBe(503);
      expect((await status(id)).latest).toBeNull();
    } finally {
      await control.query("DROP TRIGGER test_specification_audit_failure ON app.audit_events");
    }
    const submitted = await submit(id), sub = (await submitted.json()).submission_id as string;
    await control.query(`CREATE TRIGGER test_specification_audit_failure BEFORE INSERT ON app.audit_events
      FOR EACH ROW EXECUTE FUNCTION app.test_specification_audit_failure()`);
    try {
      expect((await decide(sub)).status).toBe(503);
      expect((await status(id)).latest?.state).toBe("pending");
    } finally {
      await control.query("DROP TRIGGER test_specification_audit_failure ON app.audit_events");
      await control.query("DROP FUNCTION app.test_specification_audit_failure()");
    }
  });
  it("需求更新／改回、重新分類及確認 ID 變更都使舊批准永久失效", async () => {
    const { id, submission } = await submitted();
    expect((await decide(submission)).status).toBe(200);
    for (const [version, revision, description] of [[2, 1, "更新需求"], [3, 2, "正式需求"]] as const) {
      expect((await classification.save(request(student, "PUT", `/api/v1/projects/${id}/requirements`, {
        expected_requirements_revision: revision, requirements: { description, runtime_needs: "static", runtime_ai_required: false },
      }, randomUUID(), { "if-match": `"${version}"` }), params(id))).status).toBe(200);
      expect((await status(id)).latest?.state).toBe("invalidated");
    }
    expect((await classification.confirm(request(student, "POST", `/api/v1/projects/${id}/classification/confirmation`, {
      expected_requirements_revision: 3, tier: "A", needs_visitor_identity: false, requested_tier_acknowledgement: "no_preference",
    }, randomUUID(), { "if-match": '"4"' }), params(id))).status).toBe(200);
    expect((await status(id)).latest?.state).toBe("invalidated");
    const newSubmission = (await (await submit(id)).json()).submission_id as string;
    expect((await decide(newSubmission)).status).toBe(200);
    expect((await classification.confirm(request(student, "POST", `/api/v1/projects/${id}/classification/confirmation`, {
      expected_requirements_revision: 3, tier: "A", needs_visitor_identity: false, requested_tier_acknowledgement: "no_preference",
    }, randomUUID(), { "if-match": '"5"' }), params(id))).status).toBe(200);
    expect((await status(id)).latest?.state).toBe("invalidated");
  });
  it("綁定解除後建立新關聯 ID，舊批准不復活", async () => {
    const { id, submission } = await submitted();
    expect((await decide(submission)).status).toBe(200);
    await control.query("UPDATE app.teacher_student_bindings SET state='ended' WHERE id=$1", [actors.binding]);
    const replacement = randomUUID();
    await control.query(`INSERT INTO app.teacher_student_bindings(id,teacher_id,student_id,state,created_by_aid,created_at)
      VALUES($1,$2,$3,'active',$4,now())`, [replacement, actors.teacher.id, actors.student.id, randomUUID()]);
    try {
      expect((await status(id)).latest?.state).toBe("invalidated");
      expect((await decide(submission)).status).toBe(409);
    } finally {
      await control.query("UPDATE app.teacher_student_bindings SET state='ended' WHERE id=$1", [replacement]);
      await control.query("UPDATE app.teacher_student_bindings SET state='active' WHERE id=$1", [actors.binding]);
    }
  });
  it("列表游標有下一頁且不漏列、不讓 outsider 用 cursor 取得內容", async () => {
    await submitted(); await submitted();
    let cursor = "0";
    const seen = new Set<string>();
    for (let pages = 0; pages < 50; pages++) {
      const response = await review.list(request(teacher, "GET", `/api/v1/teacher/specification-submissions?after=${cursor}&limit=1`));
      expect(response.status).toBe(200);
      const page = specificationListSchema.parse(await response.json());
      for (const item of page.items) { expect(seen.has(item.id)).toBe(false); seen.add(item.id); }
      if (!page.next_cursor) break;
      expect(BigInt(page.next_cursor)).toBeGreaterThan(BigInt(cursor));
      cursor = page.next_cursor;
    }
    const visible = await control.query(`SELECT s.id FROM app.specification_submissions s
      WHERE s.student_id=$1 AND NOT EXISTS(SELECT 1 FROM app.specification_decisions d WHERE d.submission_id=s.id)
      AND s.student_epoch=(SELECT specification_review_epoch FROM app.profiles WHERE id=$1)
      AND s.school_epoch=(SELECT specification_review_epoch FROM app.schools WHERE id=$2)
      AND EXISTS(SELECT 1 FROM app.projects p JOIN app.stage_records dr ON dr.project_id=p.id AND dr.stage='Specification'
        WHERE p.id=s.project_id AND p.current_confirmation_id=s.classification_id AND dr.row_version=s.draft_version)`,
    [actors.student.id, actors.student.schoolId]);
    expect([...seen].sort()).toEqual(visible.rows.map((row) => row.id).sort());
    const foreign = await review.list(request(outsider, "GET", `/api/v1/teacher/specification-submissions?after=0&limit=1`));
    expect((await foreign.json()).items).toEqual([]);
    expect((await review.list(request(teacher, "GET", "/api/v1/teacher/specification-submissions?after=1&after=2"))).status).toBe(400);
  });
  it.each(["submit", "decide"] as const)("%s 與草稿保存等鎖競態不批准舊證據", async (kind) => {
    const id = await setupProject();
    const sub = kind === "decide" ? (await (await submit(id)).json()).submission_id as string : null;
    const locker = await control.connect();
    await locker.query("BEGIN");
    await locker.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`${id}:Specification`]);
    let saving: Promise<Response> | undefined, writing: Promise<Response> | undefined;
    try {
      saving = foundation.saveStageDraft(request(student, "PUT", `/api/v1/projects/${id}/stages/Specification`,
        { content: { text: "並行新草稿" } }, randomUUID(), { "if-match": '"0"' }), id, "Specification");
      await waitForBlockedCall("save_stage_draft");
      writing = kind === "submit" ? submit(id) : decide(sub!);
      await waitForBlockedCall(kind === "submit" ? "submit_specification" : "decide_specification");
      await locker.query("COMMIT");
      expect((await saving).status).toBe(200);
      expect((await writing).status).toBe(409);
      if (sub) expect((await status(id)).latest?.state).toBe("invalidated");
      else expect((await status(id)).latest).toBeNull();
    } finally {
      await locker.query("ROLLBACK");
      locker.release();
      await Promise.all([saving, writing]);
    }
  });
  it.each(["teacher", "student", "school", "binding", "membership"] as const)(
    "審查等鎖期間 %s 失權，交易內重驗並拒絕決策", async (kind) => {
      const { id, submission } = await submitted();
      const mutation = kind === "teacher" || kind === "student"
        ? { table: "profiles", column: "status", bad: "disabled", good: "approved", id: actors[kind].id }
        : kind === "school" ? { table: "schools", column: "approval_state", bad: "withdrawn", good: "approved", id: actors.student.schoolId }
        : { table: kind === "binding" ? "teacher_student_bindings" : "teacher_school_memberships",
          column: "state", bad: "ended", good: "active", id: actors[kind] };
      const locker = await control.connect();
      await locker.query("BEGIN");
      let operation: Promise<Response> | undefined;
      try {
        if (kind === "membership") {
          await locker.query("UPDATE app.teacher_school_memberships SET state='ended',ended_at=clock_timestamp(),ended_by_aid=gen_random_uuid() WHERE id=$1", [mutation.id]);
        } else await locker.query(`UPDATE app.${mutation.table} SET ${mutation.column}=$1 WHERE id=$2`, [mutation.bad, mutation.id]);
        operation = decide(submission);
        await waitForBlockedCall("decide_specification");
        await locker.query("COMMIT");
        expect([403, 404, 409]).toContain((await operation).status);
        expect((await control.query("SELECT count(*)::int n FROM app.specification_decisions WHERE submission_id=$1",
          [submission])).rows[0].n).toBe(0);
      } finally {
        await locker.query("ROLLBACK");
        locker.release();
        await operation;
        if (kind === "membership") {
          const nextMembership = randomUUID();
          await control.query(`INSERT INTO app.teacher_school_memberships(id,teacher_id,school_id,state,created_by_aid,created_at)
            SELECT $2,teacher_id,school_id,'active',created_by_aid,clock_timestamp()
            FROM app.teacher_school_memberships WHERE id=$1`, [mutation.id, nextMembership]);
          actors.membership = nextMembership;
        } else await control.query(`UPDATE app.${mutation.table} SET ${mutation.column}=$1 WHERE id=$2`, [mutation.good, mutation.id]);
      }
      if (kind === "student" || kind === "school") expect((await status(id)).latest?.state).toBe("invalidated");
    });
  it("同決策同鍵並行只有一筆決策／稽核，submission 跨專案同鍵異意圖拒絕", async () => {
    const id = await setupProject(), key = randomUUID();
    const submitted = await submit(id, key), sub = (await submitted.json()).submission_id as string;
    const other = await setupProject();
    expect((await submit(other, key)).status).toBe(422);
    const decisionKey = randomUUID();
    const responses = await Promise.all([decide(sub, "approved", null, decisionKey), decide(sub, "approved", null, decisionKey)]);
    expect(responses.map((r) => r.status)).toEqual([200, 200]);
    expect((await control.query("SELECT count(*)::int n FROM app.audit_events WHERE object_ref=$1 AND action='specification_approved'", [id])).rows[0].n).toBe(1);
  });
  it("最小權限／固定 search_path／FORCE RLS／內部函式與角色不可直用", async () => {
    const { rows } = await control.query(`SELECT rolname,rolcanlogin,rolbypassrls,rolsuper FROM pg_roles WHERE rolname='app_specification_reviewer'`);
    expect(rows[0]).toMatchObject({ rolcanlogin: false, rolbypassrls: false, rolsuper: false });
    const tables = await control.query(`SELECT relrowsecurity,relforcerowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='app' AND c.relname IN ('specification_submissions','specification_decisions')`);
    expect(tables.rows).toEqual([{ relrowsecurity: true, relforcerowsecurity: true }, { relrowsecurity: true, relforcerowsecurity: true }]);
    for (const actor of ["anon", "authenticated", "service_role"]) {
      const result = await control.query(`SELECT
        has_table_privilege($1,'app.specification_submissions','INSERT') AS insert_allowed,
        has_table_privilege($1,'app.specification_decisions','UPDATE') AS update_allowed,
        has_function_privilege($1,'app.specification_projection(uuid)','EXECUTE') AS internal_allowed,
        pg_has_role($1,'app_specification_reviewer','MEMBER') AS member`, [actor]);
      expect(result.rows[0]).toEqual({ insert_allowed: false, update_allowed: false, internal_allowed: false, member: false });
    }
    const functions = await control.query(`SELECT proconfig FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='app' AND proname IN ('submit_specification','decide_specification','read_specification_review')`);
    expect(functions.rows).toHaveLength(3);
    for (const row of functions.rows) expect(row.proconfig).toContain("search_path=pg_catalog");
  });
  it("等鎖跨越學校有效時間後拒絕，延長期限不恢復舊提交", async () => {
    const id = await setupProject();
    await control.query("UPDATE app.schools SET valid_until=clock_timestamp()+interval '3 seconds' WHERE id=$1",
      [actors.student.schoolId]);
    const sub = (await (await submit(id)).json()).submission_id as string;
    expect(sub).toBeTruthy();
    const locker = await control.connect();
    let operation: Promise<Response> | undefined;
    await locker.query("BEGIN");
    await locker.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`${id}:Specification`]);
    try {
      operation = decide(sub);
      await waitForBlockedCall("decide_specification");
      for (let attempt = 0; attempt < 100; attempt++) {
        const { rows } = await control.query("SELECT clock_timestamp()>=valid_until expired FROM app.schools WHERE id=$1",
          [actors.student.schoolId]);
        if (rows[0].expired) break;
        await delay(50);
      }
      await locker.query("COMMIT");
      expect((await operation).status).toBe(404);
      expect((await status(id)).latest?.state).toBe("invalidated");
    } finally {
      await locker.query("ROLLBACK"); locker.release();
      await operation;
      await control.query("UPDATE app.schools SET valid_until=NULL WHERE id=$1", [actors.student.schoolId]);
    }
    expect((await status(id)).latest?.state).toBe("invalidated");
  });
});
