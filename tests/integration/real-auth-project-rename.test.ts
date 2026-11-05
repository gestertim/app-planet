import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { projectRenameResponseSchema } from "@app-planet/core";
import { PATCH as patchProjectTitle } from "../../apps/web/src/app/api/v1/projects/[id]/route.ts";
import { createAuthPrincipalResolver, sessionCookieName } from "../../apps/web/src/server/auth-principal.ts";
import { closeServerDatabasePool, createDatabaseSession } from "../../apps/web/src/server/database-session.ts";
import { createProjectRenameHandlers } from "../../apps/web/src/server/project-rename-handlers.ts";
import type { ProjectCreationContext, ProjectCreationQuery } from "../../apps/web/src/server/projects.ts";
import { productProjectClassificationHandlers as classification, productProjectHandlers as projects,
  productFoundationHandlers as foundation, productSpecificationReviewHandlers as review } from "../../apps/web/src/server/product-handlers.ts";
import {
  cleanupReviewActors,
  createReviewActors,
} from "../support/specification-review-fixture.ts";
import {
  loginSyntheticAccount,
  openControlPool,
  type NativeAuthSession,
} from "../support/real-auth-fixture.ts";

const origin = process.env.APP_PLANET_APP_ORIGIN!;
let control: Pool;
let actors: Awaited<ReturnType<typeof createReviewActors>>;
let student: NativeAuthSession;
let otherStudent: NativeAuthSession;
let teacher: NativeAuthSession;
let admin: NativeAuthSession;
const params = (id: string) => ({ params: Promise.resolve({ id }) });
type HeaderOverrides = Record<string, string | null | readonly string[]>;

function request(
  actor: NativeAuthSession | null,
  id: string,
  title: string,
  version: number,
  key = randomUUID(),
  replayOnly = false,
  extraHeaders: HeaderOverrides = {},
) {
  const headers = new Headers({
    ...(actor ? { cookie: `${sessionCookieName}=${actor.accessToken}` } : {}),
    origin,
    "sec-fetch-site": "same-origin",
    "content-type": "application/json",
    "if-match": `"${version}"`,
    "idempotency-key": key,
    ...(replayOnly ? { "idempotency-replay-only": "true" } : {}),
  });
  for (const [name, value] of Object.entries(extraHeaders)) {
    headers.delete(name);
    if (typeof value === "string") headers.set(name, value);
    else if (value !== null) for (const item of value) headers.append(name, item);
  }
  return new Request(`${origin}/api/v1/projects/${id}`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({ title }),
  });
}

async function rename(
  id: string,
  title: string,
  version: number,
  key = randomUUID(),
  actor = student,
  replayOnly = false,
  extraHeaders: HeaderOverrides = {},
) {
  return patchProjectTitle(request(actor, id, title, version, key, replayOnly, extraHeaders), params(id));
}

async function createProject(actor = student) {
  const response = await projects.create(new Request(`${origin}/api/v1/projects`, {
    method: "POST",
    headers: {
      cookie: `${sessionCookieName}=${actor.accessToken}`,
      origin,
      "content-type": "application/json",
      "idempotency-key": randomUUID(),
    },
    body: JSON.stringify({ title: "合成原始專案名稱" }),
  }));
  expect(response.status).toBe(201);
  return (await response.json()).id as string;
}

async function renameSnapshot(id: string) {
  const { rows } = await control.query(`SELECT to_jsonb(p) AS project,
    (SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY owner_id,idempotency_key),'[]')
      FROM app.project_rename_receipts r WHERE r.project_id=p.id) AS receipts
    FROM app.projects p WHERE p.id=$1`, [id]);
  expect(rows).toHaveLength(1);
  return rows[0];
}

async function expectRenameProblem(response: Response, id: string, status: number, code: string) {
  expect(response.status).toBe(status);
  expect(response.headers.get("etag")).toBeNull();
  const body = await response.json();
  expect(body).toMatchObject({ status, code, instance: `/api/v1/projects/${id}` });
  expect(Object.keys(body).sort()).toEqual([
    "code", "instance", "request_id", "status", "title", "type", "user_message_zh",
  ].sort());
  return body;
}

async function buildProjectEvidence(id: string) {
  const requirements = await classification.save(new Request(`${origin}/api/v1/projects/${id}/requirements`, {
    method: "PUT",
    headers: {
      cookie: `${sessionCookieName}=${student.accessToken}`,
      origin,
      "content-type": "application/json",
      "idempotency-key": randomUUID(),
      "if-match": '"0"',
    },
    body: JSON.stringify({
      expected_requirements_revision: 0,
      requirements: { description: "合成正式需求", runtime_needs: "static", runtime_ai_required: false },
    }),
  }), { id });
  expect(requirements.status).toBe(200);
  const confirmed = await classification.confirm(new Request(
    `${origin}/api/v1/projects/${id}/classification/confirmation`, {
      method: "POST",
      headers: {
        cookie: `${sessionCookieName}=${student.accessToken}`,
        origin,
        "content-type": "application/json",
        "idempotency-key": randomUUID(),
        "if-match": '"1"',
      },
      body: JSON.stringify({
        expected_requirements_revision: 1,
        tier: "A",
        needs_visitor_identity: false,
        requested_tier_acknowledgement: "no_preference",
      }),
    }), { id });
  expect(confirmed.status).toBe(200);

  const draft = await foundation.saveStageDraft(new Request(
    `${origin}/api/v1/projects/${id}/stages/Specification`, {
      method: "PUT",
      headers: {
        cookie: `${sessionCookieName}=${student.accessToken}`,
        origin,
        "content-type": "application/json",
        "idempotency-key": randomUUID(),
        "if-none-match": "*",
      },
      body: JSON.stringify({ content: { text: "合成規格內容" } }),
    }), id, "Specification");
  expect(draft.status).toBe(201);

  const tasks = await projects.importTasks(new Request(`${origin}/api/v1/projects/${id}/tasks`, {
    method: "POST",
    headers: {
      cookie: `${sessionCookieName}=${student.accessToken}`,
      origin,
      "content-type": "application/json",
      "idempotency-key": randomUUID(),
    },
    body: JSON.stringify({ confirmed: true, tasks: [{ title: "檢查畫面" }] }),
  }), { projectId: id });
  expect(tasks.status).toBe(201);

  const { rows } = await control.query(
    "SELECT row_version, requirements_revision, current_confirmation_id FROM app.projects WHERE id=$1",
    [id],
  );
  const submitted = await review.submit(new Request(
    `${origin}/api/v1/projects/${id}/stages/Specification/submissions`, {
      method: "POST",
      headers: {
        cookie: `${sessionCookieName}=${student.accessToken}`,
        origin,
        "content-type": "application/json",
        "idempotency-key": randomUUID(),
      },
      body: JSON.stringify({
        expected_draft_version: 0,
        expected_requirements_revision: rows[0].requirements_revision,
        expected_classification_id: rows[0].current_confirmation_id,
      }),
    }), { id });
  expect(submitted.status).toBe(200);
  const submissionId = (await submitted.json()).submission_id as string;
  const decision = await review.decide(new Request(
    `${origin}/api/v1/teacher/specification-submissions/${submissionId}/decision`, {
      method: "POST",
      headers: {
        cookie: `${sessionCookieName}=${teacher.accessToken}`,
        origin,
        "content-type": "application/json",
        "idempotency-key": randomUUID(),
      },
      body: JSON.stringify({ decision: "approved", reason: null }),
    }), { id: submissionId });
  expect(decision.status).toBe(200);
  return submissionId;
}

async function snapshot(id: string) {
  const { rows } = await control.query(`SELECT
    to_jsonb(p) AS project,
    (SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY revision),'[]') FROM app.project_requirements r
      WHERE r.project_id=p.id) requirements,
    (SELECT coalesce(jsonb_agg(to_jsonb(c) ORDER BY id),'[]') FROM app.project_classification_confirmations c
      WHERE c.project_id=p.id) confirmations,
    (SELECT coalesce(jsonb_agg(to_jsonb(d) ORDER BY stage),'[]') FROM app.stage_records d
      WHERE d.project_id=p.id) drafts,
    (SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY "order"),'[]') FROM app.tasks t
      WHERE t.project_id=p.id) tasks,
    (SELECT coalesce(jsonb_agg(to_jsonb(i) ORDER BY idempotency_key),'[]') FROM app.project_task_imports i
      WHERE i.project_id=p.id) task_imports,
    (SELECT coalesce(jsonb_agg(to_jsonb(s) ORDER BY sequence),'[]') FROM app.specification_submissions s
      WHERE s.project_id=p.id) submissions,
    (SELECT coalesce(jsonb_agg(to_jsonb(d) ORDER BY submission_id),'[]') FROM app.specification_decisions d
      JOIN app.specification_submissions s ON s.id=d.submission_id WHERE s.project_id=p.id) decisions,
    (SELECT coalesce(jsonb_agg(app.specification_submission_current(s.id) ORDER BY s.sequence),'[]')
      FROM app.specification_submissions s WHERE s.project_id=p.id) submission_current,
    (SELECT coalesce(jsonb_agg(app.specification_projection(s.id)->>'state' ORDER BY s.sequence),'[]')
      FROM app.specification_submissions s WHERE s.project_id=p.id) submission_states
    FROM app.projects p WHERE p.id=$1`, [id]);
  return rows[0];
}

async function waitForRenameLock() {
  for (let attempt = 0; attempt < 100; attempt++) {
    const { rows } = await control.query(`SELECT 1 FROM pg_stat_activity
      WHERE application_name='app-planet-web' AND wait_event_type='Lock'
        AND query LIKE '%app.patch_project_title(%'`);
    if (rows.length) return;
    await delay(20);
  }
  throw new Error("synthetic lock barrier not reached: patch_project_title");
}

beforeAll(async () => {
  if (process.env.APP_PLANET_ENV !== "isolated-local-test" || !origin) {
    throw new Error("isolated runner required");
  }
  control = openControlPool();
  actors = await createReviewActors(control);
  [student, otherStudent, teacher, admin] = await Promise.all([
    actors.student, actors.otherStudent, actors.teacher, actors.admin,
  ].map((account) => loginSyntheticAccount(account)));
});

afterAll(async () => {
  await closeServerDatabasePool();
  if (actors) {
    const ownerIds = [actors.student.id, actors.otherStudent.id];
    await control.query("DELETE FROM app.project_rename_receipts WHERE owner_id = ANY($1::uuid[])", [[
      actors.student.id, actors.otherStudent.id, actors.teacher.id, actors.admin.id, actors.outsider.id,
    ]]).catch(() => undefined);
    await control.query(`DELETE FROM app.project_task_imports WHERE project_id IN
      (SELECT id FROM app.projects WHERE owner_id=ANY($1::uuid[]))`, [ownerIds]);
    await control.query(`DELETE FROM app.tasks WHERE project_id IN
      (SELECT id FROM app.projects WHERE owner_id=ANY($1::uuid[]))`, [ownerIds]);
    await cleanupReviewActors(control, actors);
  }
  await control.end();
});

describe("本人專案標題 PATCH 真 Auth／HTTP／隔離 PostgreSQL", () => {
  it("F-01：有效 teacher／admin 對存在及不存在學生專案均為 404，專案與成功 receipt 不變", async () => {
    const id = await createProject();
    expect((await rename(id, "受保護已保存名稱", 0)).status).toBe(200);
    const before = await renameSnapshot(id);
    expect(before.receipts).toHaveLength(1);
    expect(before.receipts[0].response).not.toBeNull();
    for (const actor of [teacher, admin]) {
      for (const target of [id, randomUUID()]) {
        const body = await expectRenameProblem(
          await rename(target, "合法拒絕測試名稱", 1, randomUUID(), actor),
          target, 404, "not_found",
        );
        expect(JSON.stringify(body)).not.toContain("受保護已保存名稱");
        expect(await renameSnapshot(id)).toEqual(before);
      }
    }
  });

  it("E-01：本人既存專案直接 PATCH 拒絕缺失與非法 If-Match，不改專案或新增成功 receipt", async () => {
    const id = await createProject();
    const before = await renameSnapshot(id);
    const cases: { label: string; value: HeaderOverrides[string]; code: string }[] = [
      { label: "missing", value: null, code: "if_match_required" },
      { label: "weak", value: 'W/"0"', code: "invalid_if_match" },
      { label: "multiple", value: '"0", "1"', code: "invalid_if_match" },
      { label: "merged duplicates", value: ['"0"', '"1"'], code: "invalid_if_match" },
      { label: "unquoted", value: "0", code: "invalid_if_match" },
      { label: "wildcard", value: "*", code: "invalid_if_match" },
      { label: "illegal", value: '"abc"', code: "invalid_if_match" },
      { label: "leading zero", value: '"00"', code: "invalid_if_match" },
      { label: "signed", value: '"+0"', code: "invalid_if_match" },
      { label: "negative", value: '"-1"', code: "invalid_if_match" },
      { label: "decimal", value: '"0.0"', code: "invalid_if_match" },
      { label: "exponent", value: '"0e0"', code: "invalid_if_match" },
      { label: "overflow", value: '"2147483648"', code: "invalid_if_match" },
    ];
    for (const test of cases) {
      const response = await rename(id, "不得保存的合成名稱", 0, randomUUID(), student, false,
        { "if-match": test.value });
      await expectRenameProblem(response, id, 400, test.code);
      expect(await renameSnapshot(id), test.label).toEqual(before);
    }
    const valid = await rename(id, "合法 strong canonical 控制", 0);
    expect(valid.status).toBe(200);
    expect(valid.headers.get("etag")).toBe('"1"');
    expect(projectRenameResponseSchema.parse(await valid.json()).current)
      .toEqual({ id, title: "合法 strong canonical 控制", row_version: 1 });
    const after = await renameSnapshot(id);
    expect(after.receipts).toHaveLength(1);
    expect(after.receipts[0].response).not.toBeNull();
  });

  it("E-02 A：成功 receipt 後 disabled，以同可信 session 原完整意圖 replay-only 仍拒絕", async () => {
    const id = await createProject();
    const key = randomUUID(), title = "帳號失權前已保存名稱";
    expect((await rename(id, title, 0, key)).status).toBe(200);
    const before = await renameSnapshot(id);
    expect(before.receipts).toHaveLength(1);
    expect(before.receipts[0]).toMatchObject({
      owner_id: actors.student.id, idempotency_key: key, request_title: title,
      expected_row_version: 0, response: { id, title, row_version: 1 },
    });
    try {
      await control.query("UPDATE app.profiles SET status='disabled' WHERE id=$1", [actors.student.id]);
      const body = await expectRenameProblem(
        await rename(id, title, 0, key, student, true), id, 403, "forbidden",
      );
      expect(JSON.stringify(body)).not.toContain(title);
      expect(await renameSnapshot(id)).toEqual(before);
    } finally {
      await control.query("UPDATE app.profiles SET status='approved' WHERE id=$1", [actors.student.id]);
    }
    const replay = await rename(id, title, 0, key, student, true);
    expect(replay.status).toBe(200);
    expect(projectRenameResponseSchema.parse(await replay.json()).outcome).toBe("replayed");
    expect(await renameSnapshot(id)).toEqual(before);
  });

  it("E-02 B：獨立成功 receipt 後控制 fixture 改 owner，原 actor replay 404 且不復活權限", async () => {
    const id = await createProject();
    const key = randomUUID(), title = "owner 失權前已保存名稱";
    expect((await rename(id, title, 0, key)).status).toBe(200);
    const saved = await renameSnapshot(id);
    expect(saved.receipts).toHaveLength(1);
    expect(saved.receipts[0].response).toEqual({ id, title, row_version: 1 });
    await control.query("UPDATE app.projects SET owner_id=$2 WHERE id=$1", [id, actors.otherStudent.id]);
    const beforeReplay = await renameSnapshot(id);
    expect(beforeReplay.project.owner_id).toBe(actors.otherStudent.id);
    expect(beforeReplay.receipts).toEqual(saved.receipts);
    const body = await expectRenameProblem(
      await rename(id, title, 0, key, student, true), id, 404, "not_found",
    );
    expect(JSON.stringify(body)).not.toContain(title);
    expect(await renameSnapshot(id)).toEqual(beforeReplay);
  });

  it("F-01 拒絕回歸：未登入／無效 session、學生資格與依賴失敗不轉 404，自報角色不影響 DB 角色", async () => {
    const id = await createProject();
    const before = await renameSnapshot(id);
    await expectRenameProblem(await patchProjectTitle(
      request(null, id, "合法測試名稱", 0), params(id)), id, 401, "unauthenticated");
    const invalidSession = { ...student, accessToken: "invalid-session" };
    await expectRenameProblem(await rename(
      id, "合法測試名稱", 0, randomUUID(), invalidSession), id, 401, "unauthenticated");
    try {
      for (const state of [
        { status: "disabled", deletion: "none" },
        { status: "approved", deletion: "marked" },
        { status: "pending", deletion: "none" },
      ]) {
        await control.query("UPDATE app.profiles SET status=$2,deletion_state=$3 WHERE id=$1",
          [actors.student.id, state.status, state.deletion]);
        await expectRenameProblem(await rename(id, "合法測試名稱", 0, randomUUID(), student, false,
          { "x-role": "admin", "x-user-role": "teacher" }), id, 403, "forbidden");
        expect(await renameSnapshot(id)).toEqual(before);
      }
    } finally {
      await control.query("UPDATE app.profiles SET status='approved',deletion_state='none' WHERE id=$1",
        [actors.student.id]);
    }

    const resolver = createAuthPrincipalResolver();
    for (const failStatusOnly of [false, true]) {
      const handlers = createProjectRenameHandlers({
        requireSameOrigin: true,
        resolver: {
          async resolve(incoming) {
            const resolved = await resolver.resolve(incoming);
            if (!resolved.ok) return resolved;
            const original = resolved.session.read;
            return { ...resolved, session: { ...resolved.session, read: {
              runReadOnly: (operation) => original.runReadOnly((query) => operation({
                async query(text, values) {
                  if (!failStatusOnly || text.includes("app.current_account_status()")) {
                    throw new Error("synthetic P-2 read dependency failure");
                  }
                  return query.query(text, values);
                },
              })),
            } } };
          },
        },
      });
      await expectRenameProblem(await handlers.patch(
        request(teacher, id, "合法測試名稱", 0), { id }), id, 503, "dependency_unavailable");
      expect(await renameSnapshot(id)).toEqual(before);
    }
    await expectRenameProblem(await rename(id, "合法測試名稱", 0, randomUUID(), teacher, false,
      { "x-role": "student", "x-user-role": "student" }), id, 404, "not_found");
    expect(await renameSnapshot(id)).toEqual(before);
    const allowed = await rename(id, "可信學生角色正向控制", 0, randomUUID(), student, false,
      { "x-role": "admin", "x-user-role": "teacher" });
    expect(allowed.status).toBe(200);
  });

  it.runIf(process.env.APP_PLANET_TEST_MIGRATE_THROUGH === "0035")(
    "0035→0036 升級保留既有 project row 並可執行標題 PATCH", async () => {
      const id = await createProject();
      const before = await control.query("SELECT to_jsonb(p) project FROM app.projects p WHERE id=$1", [id]);
      const migration = await readFile(new URL("../../supabase/migrations/0036_project_title_patch.sql", import.meta.url), "utf8");
      await control.query(migration);
      expect((await control.query("SELECT to_jsonb(p) project FROM app.projects p WHERE id=$1", [id])).rows)
        .toEqual(before.rows);
      const response = await rename(id, "升級後標題", 0);
      expect(response.status).toBe(200);
      expect(projectRenameResponseSchema.parse(await response.json()).current)
        .toMatchObject({ id, title: "升級後標題", row_version: 1 });
      console.log("Upgrade0035to0036=existing project preserved and title patch verified");
    },
  );

  it("只改 title／row_version；requirements、classification、draft、task 與已核准 Specification 證據保持有效", async () => {
    const id = await createProject();
    const submissionId = await buildProjectEvidence(id);
    const before = await snapshot(id);
    expect(before.submission_current).toEqual([true]);
    expect(before.submission_states).toEqual(["approved"]);
    const originalVersion = before.project.row_version as number;
    const firstTitle = "  café e\u0301　";
    const firstKey = randomUUID();

    const saved = await rename(id, firstTitle, originalVersion, firstKey);
    expect(saved.status).toBe(200);
    expect(saved.headers.get("etag")).toBe(`"${originalVersion + 1}"`);
    const firstResponse = projectRenameResponseSchema.parse(await saved.json());
    expect(firstResponse).toEqual({
      outcome: "saved",
      operation: { id, title: firstTitle, row_version: originalVersion + 1 },
      current: { id, title: firstTitle, row_version: originalVersion + 1 },
    });

    const nextTitle = "較新的現行名稱";
    const next = await rename(id, nextTitle, originalVersion + 1);
    expect(next.status).toBe(200);
    const nextResponse = projectRenameResponseSchema.parse(await next.json());
    const replay = await rename(id, firstTitle, originalVersion, firstKey, student, true);
    expect(replay.status).toBe(200);
    expect(replay.headers.get("etag")).toBe(`"${originalVersion + 2}"`);
    expect(projectRenameResponseSchema.parse(await replay.json())).toEqual({
      outcome: "replayed",
      operation: { id, title: firstTitle, row_version: originalVersion + 1 },
      current: nextResponse.current,
    });

    const after = await snapshot(id);
    const omitRenameFields = (project: Record<string, unknown>) => {
      const { title: _title, row_version: _version, ...unchanged } = project;
      return unchanged;
    };
    expect(omitRenameFields(after.project)).toEqual(omitRenameFields(before.project));
    for (const field of ["requirements", "confirmations", "drafts", "tasks", "task_imports",
      "submissions", "decisions", "submission_current", "submission_states"] as const) {
      expect(after[field]).toEqual(before[field]);
    }
    expect(after.project.title).toBe(nextTitle);
    expect(after.project.row_version).toBe(originalVersion + 2);
    expect(after.submissions[0].id).toBe(submissionId);
    expect(after.submission_current).toEqual([true]);
    expect(after.submission_states).toEqual(["approved"]);
  });

  it("owner 隱匿、staff 唯讀、strict conflict、同鍵意圖綁定與 replay-only 到期防重寫", async () => {
    const id = await createProject();
    const otherId = await createProject(otherStudent);
    const sameOwnerOtherId = await createProject();
    const start = await control.query("SELECT to_jsonb(p) project FROM app.projects p WHERE id=$1", [id]);
    const hidden = await rename(id, "其他學生嘗試", 0, randomUUID(), otherStudent);
    expect(hidden.status).toBe(404);
    expect((await rename(id, "教師不可寫", 0, randomUUID(), teacher)).status).toBe(404);
    expect((await rename(id, "管理員不可寫", 0, randomUUID(), admin)).status).toBe(404);
    expect((await rename(otherId, "不同學生作品不可見", 0, randomUUID())).status).toBe(404);
    expect((await control.query("SELECT to_jsonb(p) project FROM app.projects p WHERE id=$1", [id])).rows)
      .toEqual(start.rows);

    const key = randomUUID();
    const firstTitle = "本人改名";
    expect((await rename(id, firstTitle, 0, key)).status).toBe(200);
    const mismatch = await rename(id, "同鍵不同標題", 0, key);
    expect(mismatch.status).toBe(422);
    expect((await rename(sameOwnerOtherId, "同鍵不同專案", 0, key)).status).toBe(422);

    const conflictKey = randomUUID();
    const conflict = await rename(id, "舊版本提交", 0, conflictKey);
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({
      code: "version_conflict",
      conflict: {
        current: { version: 1, content: { title: firstTitle } },
        submitted: { version: 0, content: { title: "舊版本提交" } },
      },
    });
    expect((await rename(id, "舊版本提交", 0, conflictKey, student, true)).status).toBe(409);

    const missingKey = randomUUID();
    const missingReplay = await rename(id, "不可建立的新意圖", 1, missingKey, student, true);
    expect(missingReplay.status).toBe(409);
    expect((await missingReplay.json()).code).toBe("operation_outcome_unrecoverable");

    const expiringKey = randomUUID();
    expect((await rename(id, "到期前保存", 1, expiringKey)).status).toBe(200);
    await control.query(`WITH expiry AS (SELECT clock_timestamp()-interval '25 hours' AS created)
      UPDATE app.project_rename_receipts receipt
      SET created_at=expiry.created, expires_at=expiry.created+interval '24 hours'
      FROM expiry WHERE receipt.owner_id=$1 AND receipt.idempotency_key=$2`,
    [actors.student.id, expiringKey]);
    const beforeExpiredReplay = await control.query(
      "SELECT title,row_version FROM app.projects WHERE id=$1", [id],
    );
    const expired = await rename(id, "到期前保存", 1, expiringKey, student, true);
    expect(expired.status).toBe(409);
    expect((await expired.json()).code).toBe("operation_outcome_unrecoverable");
    expect((await control.query("SELECT title,row_version FROM app.projects WHERE id=$1", [id])).rows)
      .toEqual(beforeExpiredReplay.rows);

    const invalidReplayFlag = await rename(id, "不可執行", 2, randomUUID(), student, false,
      { "idempotency-replay-only": "false" });
    expect(invalidReplayFlag.status).toBe(400);
  });

  it("相同 UUID 並行只 CAS 一次；不同意圖同版本僅一個成功", async () => {
    const id = await createProject();
    const key = randomUUID();
    const same = await Promise.all([
      rename(id, "同一個標題", 0, key),
      rename(id, "同一個標題", 0, key),
    ]);
    expect(same.map((response) => response.status).sort()).toEqual([200, 200]);
    const outcomes = await Promise.all(same.map(async (response) =>
      projectRenameResponseSchema.parse(await response.json()).outcome));
    expect(outcomes.sort()).toEqual(["replayed", "saved"]);
    expect((await control.query("SELECT row_version FROM app.projects WHERE id=$1", [id])).rows[0].row_version)
      .toBe(1);

    const different = await Promise.all([
      rename(id, "競爭標題甲", 1),
      rename(id, "競爭標題乙", 1),
    ]);
    expect(different.map((response) => response.status).sort()).toEqual([200, 409]);
    expect((await control.query("SELECT row_version FROM app.projects WHERE id=$1", [id])).rows[0].row_version)
      .toBe(2);
  });

  it("提交回應遺失後 replay-only 回原 operation 並另取 current；rollback 不留 receipt 或 project 更新", async () => {
    const id = await createProject();
    const resolver = createAuthPrincipalResolver();
    let loseNextCommitReply = true;
    const lostReplyHandlers = createProjectRenameHandlers({
      requireSameOrigin: true,
      resolver: {
        async resolve(request) {
          const resolved = await resolver.resolve(request);
          if (!resolved.ok) return resolved;
          const original = resolved.session.write;
          const write: ProjectCreationContext = {
            async runTransaction<T>(operation: (query: ProjectCreationQuery) => Promise<T>) {
              const value = await original.runTransaction(operation);
              if (loseNextCommitReply) {
                loseNextCommitReply = false;
                throw new Error("synthetic commit acknowledgement loss");
              }
              return value;
            },
          };
          return { ...resolved, session: { ...resolved.session, write } };
        },
      },
    });
    const key = randomUUID();
    const lost = await lostReplyHandlers.patch(request(student, id, "已提交但回應遺失", 0, key), { id });
    expect(lost.status).toBe(503);
    expect((await lost.json()).code).toBe("operation_outcome_unknown");
    expect((await rename(id, "目前的新標題", 1)).status).toBe(200);
    const replay = await rename(id, "已提交但回應遺失", 0, key, student, true);
    expect(replay.status).toBe(200);
    expect(projectRenameResponseSchema.parse(await replay.json())).toEqual({
      outcome: "replayed",
      operation: { id, title: "已提交但回應遺失", row_version: 1 },
      current: { id, title: "目前的新標題", row_version: 2 },
    });

    const rollbackId = await createProject();
    const rollbackKey = randomUUID();
    await expect(createDatabaseSession(actors.student.id).write.runTransaction(async (query) => {
      const result = await query.query(
        "SELECT app.patch_project_title($1::uuid,$2::text,$3::integer,$4::uuid,false) AS result",
        [rollbackId, "必須回滾", 0, rollbackKey],
      );
      expect(result.rows[0]).toMatchObject({ result: { outcome: "saved" } });
      throw new Error("synthetic transaction rollback");
    })).rejects.toThrow("synthetic transaction rollback");
    expect((await control.query("SELECT title,row_version FROM app.projects WHERE id=$1", [rollbackId])).rows)
      .toEqual([{ title: "合成原始專案名稱", row_version: 0 }]);
    expect((await control.query(
      "SELECT count(*)::int AS count FROM app.project_rename_receipts WHERE owner_id=$1 AND idempotency_key=$2",
      [actors.student.id, rollbackKey],
    )).rows[0].count).toBe(0);
  });

  it("鎖等待期間帳號失去資格後拒絕 PATCH，並核對 role、FORCE RLS、函式與欄位最小 grants", async () => {
    const id = await createProject();
    const lockClient = await control.connect();
    try {
      await lockClient.query("BEGIN");
      await lockClient.query("UPDATE app.profiles SET status='disabled' WHERE id=$1", [actors.student.id]);
      const pending = rename(id, "失權後不應保存", 0);
      await waitForRenameLock();
      await lockClient.query("COMMIT");
      const denied = await pending;
      expect(denied.status).toBe(403);
      expect((await control.query("SELECT title,row_version FROM app.projects WHERE id=$1", [id])).rows)
        .toEqual([{ title: "合成原始專案名稱", row_version: 0 }]);
      await control.query("UPDATE app.profiles SET status='approved' WHERE id=$1", [actors.student.id]);
    } finally {
      await lockClient.query("ROLLBACK").catch(() => undefined);
      lockClient.release();
    }

    const { rows } = await control.query(`SELECT
      writer_role.rolcanlogin, writer_role.rolinherit, writer_role.rolbypassrls,
      rel.relrowsecurity, rel.relforcerowsecurity,
      fn.prosecdef, fn.proconfig,
      pg_catalog.pg_get_userbyid(fn.proowner) AS function_owner,
      has_column_privilege('app_project_rename_writer','app.projects','title','UPDATE') AS update_title,
      has_column_privilege('app_project_rename_writer','app.projects','row_version','UPDATE') AS update_version,
      has_column_privilege('app_project_rename_writer','app.projects','owner_id','UPDATE') AS update_owner,
      has_column_privilege('app_project_rename_writer','app.project_rename_receipts','response','UPDATE') AS update_receipt_response,
      has_column_privilege('app_project_rename_writer','app.project_rename_receipts','request_title','UPDATE') AS update_receipt_intent,
      has_table_privilege('authenticated','app.project_rename_receipts','SELECT') AS authenticated_receipt_read,
      has_table_privilege('service_role','app.project_rename_receipts','SELECT') AS service_receipt_read
      FROM pg_catalog.pg_roles writer_role
      JOIN pg_catalog.pg_class rel ON rel.oid='app.project_rename_receipts'::regclass
      JOIN pg_catalog.pg_proc fn ON fn.oid='app.patch_project_title(uuid,text,integer,uuid,boolean)'::regprocedure
      WHERE writer_role.rolname='app_project_rename_writer'`);
    expect(rows[0]).toMatchObject({
      rolcanlogin: false, rolinherit: false, rolbypassrls: false,
      relrowsecurity: true, relforcerowsecurity: true,
      prosecdef: true, proconfig: ["search_path=pg_catalog"],
      function_owner: "app_project_rename_writer",
      update_title: true, update_version: true, update_owner: false,
      update_receipt_response: true, update_receipt_intent: false,
      authenticated_receipt_read: false, service_receipt_read: false,
    });
  });

  it("同一 authenticated actor 不能直接讀取 receipt table", async () => {
    await expect(createDatabaseSession(actors.student.id).read.runReadOnly((query) =>
      query.query("SELECT * FROM app.project_rename_receipts"))).rejects.toThrow();
  });
});
