import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sessionCookieName } from "../../apps/web/src/server/auth-principal.ts";
import { closeServerDatabasePool, createDatabaseSession } from "../../apps/web/src/server/database-session.ts";
import {
  productBindingHandlers,
  productFoundationHandlers,
  productProjectClassificationHandlers,
  productProjectHandlers,
  productTeacherResourceHandlers,
} from "../../apps/web/src/server/product-handlers.ts";
import {
  createSyntheticAuthAccount, deleteSyntheticAuthAccount, loginSyntheticAccount, openControlPool,
  type NativeAuthSession, type SyntheticAuthAccount,
} from "../support/real-auth-fixture.ts";

type Actor = SyntheticAuthAccount & { session: NativeAuthSession };
const origin = process.env.APP_PLANET_APP_ORIGIN!;
const accounts: Actor[] = [];
const projectIds: string[] = [];
const testConstraint = "teacher_resource_audit_failure";
let control: Pool;

async function actor(role: "student" | "teacher" | "admin" = "student"): Promise<Actor> {
  const account = await createSyntheticAuthAccount(control, "教師唯讀資源");
  if (role !== "student") await control.query("UPDATE app.profiles SET role=$2 WHERE id=$1", [account.id, role]);
  const result = { ...account, session: await loginSyntheticAccount(account) };
  accounts.push(result);
  return result;
}

function request(
  who: Actor,
  method: string,
  path: string,
  body?: unknown,
  extraHeaders: Record<string, string> = {},
): Request {
  return new Request(origin + path, {
    method,
    headers: {
      cookie: `${sessionCookieName}=${who.session.accessToken}`,
      origin,
      "sec-fetch-site": "same-origin",
      "content-type": "application/json",
      ...extraHeaders,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function makeProject(student: Actor, title: string) {
  const response = await productProjectHandlers.create(request(
    student, "POST", "/api/v1/projects", { title }, { "idempotency-key": randomUUID() },
  ));
  expect(response.status).toBe(201);
  const body: unknown = await response.json();
  if (!isRecord(body) || typeof body.id !== "string") throw new Error("project fixture response is invalid");
  projectIds.push(body.id);
  return body.id;
}

async function saveRequirements(student: Actor, project: string, version: number, revision: number, text: string) {
  return productProjectClassificationHandlers.save(
    request(student, "PUT", `/api/v1/projects/${project}/requirements`, {
      expected_requirements_revision: revision,
      requirements: { description: text, runtime_needs: "static", runtime_ai_required: false },
    }, { "if-match": `"${version}"`, "idempotency-key": randomUUID() }),
    { id: project },
  );
}

async function createContent(student: Actor, title: string) {
  const project = await makeProject(student, title);
  const saved = await saveRequirements(student, project, 0, 0, "正式保存的合成需求 café e\u0301");
  expect(saved.status).toBe(200);
  const confirmed = await productProjectClassificationHandlers.confirm(
    request(student, "POST", `/api/v1/projects/${project}/classification/confirmation`, {
      expected_requirements_revision: 1,
      tier: "A",
      needs_visitor_identity: false,
      requested_tier_acknowledgement: "no_preference",
    }, { "if-match": '"1"', "idempotency-key": randomUUID() }),
    { id: project },
  );
  expect(confirmed.status).toBe(200);
  const stageSaved = await productFoundationHandlers.saveStageDraft(
    request(student, "PUT", `/api/v1/projects/${project}/stages/Specification`, {
      content: { text: "已保存的 Specification 草稿 café e\u0301" },
    }, { "if-none-match": "*", "idempotency-key": randomUUID() }),
    project,
    "Specification",
  );
  expect(stageSaved?.status).toBe(201);
  const confirmation = await productProjectHandlers.confirmStage(
    request(student, "POST", `/api/v1/projects/${project}/stages/Specification/confirmation`, {
      expected_row_version: 0,
    }, { "idempotency-key": randomUUID() }),
    { projectId: project, stage: "Specification" },
  );
  expect(confirmation.status).toBe(201);
  const imported = await productProjectHandlers.importTasks(
    request(student, "POST", `/api/v1/projects/${project}/tasks`, {
      confirmed: true, tasks: [{ title: "已保存任務" }, { title: "第二個已保存任務" }],
    }, { "idempotency-key": randomUUID() }),
    { projectId: project },
  );
  expect(imported.status).toBe(201);
  const taskBody: unknown = await imported.json();
  if (!isRecord(taskBody) || !Array.isArray(taskBody.tasks) ||
      !isRecord(taskBody.tasks[0]) || typeof taskBody.tasks[0].id !== "string") {
    throw new Error("task fixture response is invalid");
  }
  const taskId = taskBody.tasks[0].id;
  const checked = await productProjectHandlers.patchTaskDone(
    request(student, "PATCH", `/api/v1/projects/${project}/tasks/${taskId}`, { done: true },
      { "if-match": '"0"' }),
    { projectId: project, taskId },
  );
  expect(checked.status).toBe(200);
  return project;
}

async function linkTeacherStudent(admin: Actor, teacher: Actor, student: Actor) {
  const response = await productBindingHandlers.create(
    request(admin, "POST", "/api/v1/admin/bindings", {
      teacher_id: teacher.id, student_id: student.id,
    }, { "idempotency-key": randomUUID() }),
  );
  expect(response.status).toBe(201);
  const body: unknown = await response.json();
  if (!isRecord(body) || typeof body.binding_id !== "string") throw new Error("binding fixture response is invalid");
  return body.binding_id;
}

async function snapshot(project: string) {
  return (await control.query(`SELECT
    (SELECT to_jsonb(p) FROM app.projects p WHERE p.id=$1) project,
    (SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY revision),'[]')
      FROM app.project_requirements r WHERE project_id=$1) requirements,
    (SELECT coalesce(jsonb_agg(to_jsonb(d) ORDER BY stage),'[]')
      FROM app.stage_records d WHERE project_id=$1) drafts,
    (SELECT coalesce(jsonb_agg(to_jsonb(c) ORDER BY stage,record_row_version),'[]')
      FROM app.stage_draft_confirmations c WHERE project_id=$1) confirmations,
    (SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY "order",id),'[]')
      FROM app.tasks t WHERE project_id=$1) tasks`, [project])).rows[0];
}

const resourceReaders = [
  { name: "projects", sql: "SELECT app.read_teacher_student_projects($1::uuid,nullif($2,'')::uuid,$3::integer) AS result" },
  { name: "project", sql: "SELECT app.read_teacher_project($1::uuid,$2::uuid) AS result" },
  { name: "stageDraft", sql: "SELECT app.read_teacher_stage_draft($1::uuid,$2::uuid,$3::text) AS result" },
  { name: "tasks", sql: "SELECT app.read_teacher_project_tasks($1::uuid,$2::uuid,nullif($3,'')::uuid,$4::integer) AS result" },
] as const;
type ResourceReader = typeof resourceReaders[number]["name"];

function readResource(name: ResourceReader, teacher: Actor, student: Actor, project: string) {
  const base = `/api/v1/teacher/students/${student.id}/projects`;
  const params = { studentId: student.id, projectId: project };
  if (name === "projects") return productTeacherResourceHandlers.projects(
    request(teacher, "GET", base), params,
  );
  if (name === "project") return productTeacherResourceHandlers.project(
    request(teacher, "GET", `${base}/${project}`), params,
  );
  if (name === "stageDraft") return productTeacherResourceHandlers.stageDraft(
    request(teacher, "GET", `${base}/${project}/stages/Specification`), { ...params, stage: "Specification" },
  );
  return productTeacherResourceHandlers.tasks(request(teacher, "GET", `${base}/${project}/tasks`), params);
}

async function resourceFixture(title: string) {
  const [admin, teacher, student] = await Promise.all([actor("admin"), actor("teacher"), actor()]);
  await control.query("UPDATE app.profiles SET school_id=$2 WHERE id=$1", [teacher.id, student.schoolId]);
  await control.query(`INSERT INTO app.teacher_school_memberships
    (id,teacher_id,school_id,state,created_by_aid,created_at)
    VALUES($1,$2,$3,'active',$4,clock_timestamp())`,
  [randomUUID(), teacher.id, student.schoolId, randomUUID()]);
  const project = await createContent(student, title);
  const binding = await linkTeacherStudent(admin, teacher, student);
  return { admin, teacher, student, project, binding };
}

async function bindingSnapshot(binding: string) {
  return (await control.query("SELECT * FROM app.teacher_student_bindings WHERE id=$1", [binding])).rows[0];
}

async function viewAudit(teacher: Actor, student: Actor, project: string) {
  return (await control.query(`SELECT e.* FROM app.audit_events e
    JOIN app.audit_identity_map actor ON actor.aid=e.actor_aid
    JOIN app.audit_identity_map subject ON subject.aid=e.subject_aid
    WHERE actor.account_id=$1 AND subject.account_id=$2 AND e.object_ref=$3
      AND e.action='teacher_view' AND e.object_type='project' AND e.result='ok'
    ORDER BY e.at,e.id`, [teacher.id, student.id, project])).rows;
}

async function expectResourceDenied(response: Response, student: Actor, project: string, title: string) {
  expect(response.status).toBe(404);
  const text = await response.text();
  expect(JSON.parse(text)).toMatchObject({ status: 404, code: "not_found" });
  const body: unknown = JSON.parse(text);
  expect(isRecord(body)).toBe(true);
  if (!isRecord(body)) throw new Error("拒絕回應不是 problem object。");
  expect(Object.keys(body).sort()).toEqual(
    ["type", "title", "status", "code", "instance", "request_id", "user_message_zh"].sort(),
  );
  // Problem instance 回顯原請求路徑；不是從受保護資料讀出的識別字或本文。
  expect(body.instance).toMatch(new RegExp(
    `^/api/v1/teacher/students(?:/${student.id}/projects(?:/${project}(?:/stages/Specification|/tasks)?)?)?$`,
  ));
  const { instance: _instance, ...problem } = body;
  const content = JSON.stringify(problem);
  for (const protectedValue of [student.id, project, title, "正式保存的合成需求",
    "已保存的 Specification 草稿", "已保存任務"]) {
    expect(content).not.toContain(protectedValue);
  }
  for (const field of ["items", "project", "requirements", "content", "stages", "tasks", "display_label"]) {
    expect(body).not.toHaveProperty(field);
  }
}

async function waitForBlockedReader(sql: string, blocker: number, since: Date) {
  for (let attempt = 0; attempt < 150; attempt++) {
    const readers = await control.query<{ pid: number; blockers: number[] }>(`SELECT pid,
      pg_blocking_pids(pid) AS blockers FROM pg_stat_activity
      WHERE application_name='app-planet-web' AND state='active' AND query=$1
        AND query_start >= $2 AND wait_event_type='Lock'`, [sql, since]);
    if (readers.rowCount) {
      expect(readers.rows).toHaveLength(1);
      const reader = readers.rows[0]!;
      expect(reader.pid).not.toBe(blocker);
      expect(reader.blockers).toContain(blocker);
      console.log(`E01LockBarrier reader=${reader.pid} blocker=${blocker} sql=${sql} verified`);
      return reader.pid;
    }
    await delay(20);
  }
  throw new Error("指定產品 reader 未被本輪解除 RPC 交易阻擋。");
}

async function removeTestData() {
  await closeServerDatabasePool();
  await control.query(`ALTER TABLE app.audit_events DROP CONSTRAINT IF EXISTS ${testConstraint}`);
  const ids = accounts.map((account) => account.id);
  if (projectIds.length) {
    await control.query("UPDATE app.projects SET classification_state='unconfirmed', tier=NULL, needs_visitor_identity=NULL, current_confirmation_id=NULL WHERE id=ANY($1::uuid[])", [projectIds]);
    for (const table of ["stage_draft_confirmations", "stage_draft_idempotency", "project_task_imports", "tasks",
      "stage_records",
      "project_classification_idempotency", "project_classification_confirmations",
      "project_requirements", "project_create_idempotency"]) {
      await control.query(`DELETE FROM app.${table} WHERE project_id=ANY($1::uuid[])`, [projectIds]);
    }
    await control.query(`DELETE FROM app.specification_decisions
      WHERE submission_id IN (SELECT id FROM app.specification_submissions WHERE project_id=ANY($1::uuid[]))`,
    [projectIds]);
    await control.query("DELETE FROM app.specification_submissions WHERE project_id=ANY($1::uuid[])", [projectIds]);
    await control.query("DELETE FROM app.projects WHERE id=ANY($1::uuid[])", [projectIds]);
  }
  if (ids.length) {
    await control.query("DELETE FROM app.binding_operation_receipts WHERE actor_id=ANY($1::uuid[])", [ids]);
    await control.query("DELETE FROM app.teacher_student_bindings WHERE teacher_id=ANY($1::uuid[]) OR student_id=ANY($1::uuid[])", [ids]);
    await control.query("DELETE FROM app.teacher_school_memberships WHERE teacher_id=ANY($1::uuid[])", [ids]);
    await control.query("DELETE FROM app.audit_events WHERE actor_aid IN (SELECT aid FROM app.audit_identity_map WHERE account_id=ANY($1::uuid[])) OR subject_aid IN (SELECT aid FROM app.audit_identity_map WHERE account_id=ANY($1::uuid[]))", [ids]);
    await control.query("DELETE FROM app.audit_identity_map WHERE account_id=ANY($1::uuid[])", [ids]);
    await control.query("DELETE FROM app.profiles WHERE id=ANY($1::uuid[])", [ids]);
    await control.query("DELETE FROM app.schools WHERE id=ANY($1::uuid[])", [accounts.map((account) => account.schoolId)]);
    for (const account of accounts) await deleteSyntheticAuthAccount(account);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function waitForLockWait(control: Pool) {
  for (let attempt = 0; attempt < 150; attempt++) {
    const waiting = await control.query(`SELECT 1 FROM pg_stat_activity
      WHERE application_name='app-planet-web' AND state='active'
        AND wait_event_type='Lock' AND query LIKE '%end_teacher_student_binding%'`);
    if (waiting.rowCount) return;
    await delay(20);
  }
  throw new Error("解除請求未進入預期的資料列鎖等待。");
}

beforeAll(() => {
  if (process.env.APP_PLANET_ENV !== "isolated-local-test" || process.env.NODE_ENV !== "test" ||
      process.env.APP_PLANET_LOCAL_AUTH !== "1" || !origin) {
    throw new Error("教師唯讀資源回歸只允許專用隔離 runner。");
  }
  control = openControlPool();
});

afterAll(async () => {
  try {
    await removeTestData();
    console.log("TeacherResourceCleanup=verified synthetic rows removed");
  } finally {
    await control.end();
  }
});

describe("T071／T072 真 Auth／DB／教師唯讀資源", () => {
  it.each(resourceReaders)("E-01 解除先持鎖：$name 等待正式 RPC 提交後拒絕且無成功稽核", async ({ name, sql }) => {
    const title = `E-01 ${name} 受保護合成專案`;
    const { admin, teacher, student, project, binding } = await resourceFixture(title);
    const allowed = await readResource(name, teacher, student, project);
    expect(allowed.status).toBe(200);
    expect(await allowed.text()).toContain(name === "stageDraft" ? "已保存的 Specification 草稿"
      : name === "tasks" ? "已保存任務" : title);
    const contentBefore = await snapshot(project);
    const auditBefore = await viewAudit(teacher, student, project);
    expect(auditBefore).toHaveLength(1);
    const endKey = randomUUID();
    const endReason = `E-01 ${name} 正式解除`;
    const ending = await control.connect();
    let pending: Promise<Response> | undefined;
    try {
      await ending.query("BEGIN ISOLATION LEVEL READ COMMITTED");
      await ending.query("SET LOCAL ROLE authenticated");
      await ending.query(
        "SELECT set_config('request.jwt.claim.sub',$1,true),set_config('request.jwt.claims',$2,true)",
        [admin.id, JSON.stringify({ sub: admin.id })],
      );
      const blocker = (await ending.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!.pid;
      const ended = await ending.query(`SELECT app.end_teacher_student_binding($1::uuid,$2::text,$3::uuid) AS result`,
        [binding, endReason, endKey]);
      expect(ended.rows[0].result).toMatchObject({ outcome: "ended", binding_id: binding, state: "ended" });
      await ending.query("RESET ROLE");
      expect((await ending.query("SELECT state FROM app.teacher_student_bindings WHERE id=$1", [binding]))
        .rows[0].state).toBe("ended");
      expect((await bindingSnapshot(binding)).state).toBe("active");
      const since = (await control.query<{ at: Date }>("SELECT clock_timestamp() AS at")).rows[0]!.at;
      pending = readResource(name, teacher, student, project);
      const readerPid = await waitForBlockedReader(sql, blocker, since);
      expect(await viewAudit(teacher, student, project)).toEqual(auditBefore);
      await ending.query("COMMIT");
      await expectResourceDenied(await pending, student, project, title);
      const committed = await bindingSnapshot(binding);
      expect(committed).toMatchObject({ state: "ended", end_reason: endReason });
      expect(committed.ended_at).not.toBeNull();
      expect(committed.ended_by_aid).not.toBeNull();
      expect((await control.query(`SELECT result FROM app.binding_operation_receipts
        WHERE actor_id=$1 AND operation_key=$2`, [admin.id, endKey])).rows[0].result)
        .toMatchObject({ outcome: "ended", binding_id: binding });
      expect(await viewAudit(teacher, student, project)).toEqual(auditBefore);
      expect(await snapshot(project)).toEqual(contentBefore);
      expect((await control.query("SELECT pg_blocking_pids($1) AS blockers", [readerPid])).rows[0].blockers)
        .not.toContain(blocker);
      console.log(`E01Result reader=${name} committed=ended response=404/not_found audit=unchanged content=unchanged`);
    } finally {
      try {
        await ending.query("ROLLBACK");
      } finally {
        ending.release();
        if (pending) await pending;
      }
    }
  }, 90_000);

  it("E-02 教師 marked：原合格名冊及所有既存資源拒絕，不增稽核或修改學生內容／綁定", async () => {
    const title = "E-02 教師刪除中受保護合成專案";
    const { teacher, student, project, binding } = await resourceFixture(title);
    const students = await productTeacherResourceHandlers.students(
      request(teacher, "GET", "/api/v1/teacher/students"),
    );
    expect(students.status).toBe(200);
    expect((await students.json()).items).toContainEqual(expect.objectContaining({ id: student.id }));
    for (const { name } of resourceReaders) {
      const allowed = await readResource(name, teacher, student, project);
      expect(allowed.status).toBe(200);
      expect(await allowed.text()).toContain(name === "stageDraft" ? "已保存的 Specification 草稿"
        : name === "tasks" ? "已保存任務" : title);
    }
    const contentBefore = await snapshot(project);
    const bindingBefore = await bindingSnapshot(binding);
    const auditBefore = await viewAudit(teacher, student, project);
    expect(auditBefore).toHaveLength(resourceReaders.length);
    await control.query("UPDATE app.profiles SET deletion_state='marked' WHERE id=$1", [teacher.id]);
    const marked = (await control.query("SELECT deletion_state FROM app.profiles WHERE id=$1", [teacher.id])).rows[0];
    expect(marked.deletion_state).toBe("marked");
    await expectResourceDenied(await productTeacherResourceHandlers.students(
      request(teacher, "GET", "/api/v1/teacher/students"),
    ), student, project, title);
    expect(await viewAudit(teacher, student, project)).toEqual(auditBefore);
    expect(await snapshot(project)).toEqual(contentBefore);
    expect(await bindingSnapshot(binding)).toEqual(bindingBefore);
    console.log("E02Result reader=students teacher=marked response=404/not_found audit=unchanged content=unchanged binding=unchanged");
    for (const { name } of resourceReaders) {
      await expectResourceDenied(await readResource(name, teacher, student, project), student, project, title);
      expect(await viewAudit(teacher, student, project)).toEqual(auditBefore);
      expect(await snapshot(project)).toEqual(contentBefore);
      expect(await bindingSnapshot(binding)).toEqual(bindingBefore);
      console.log(`E02Result reader=${name} teacher=marked response=404/not_found audit=unchanged content=unchanged binding=unchanged`);
    }
    expect((await control.query("SELECT deletion_state FROM app.profiles WHERE id=$1", [teacher.id])).rows[0])
      .toEqual(marked);
  }, 90_000);

  it("只讀有效綁定學生及其專案，逐項稽核；解除、資格失效與 audit failure 安全拒絕", async () => {
    const [admin, teacher, student, unboundTeacher, studentB, studentC] = await Promise.all([
      actor("admin"), actor("teacher"), actor(), actor("teacher"), actor(), actor(),
    ]);
    await control.query("UPDATE app.profiles SET school_id=$2 WHERE id=$1", [teacher.id, student.schoolId]);
    await control.query("UPDATE app.profiles SET school_id=$2 WHERE id=$1", [unboundTeacher.id, student.schoolId]);
    await control.query("UPDATE app.profiles SET school_id=$2 WHERE id=$1", [studentC.id, student.schoolId]);
    const membership = randomUUID();
    await control.query(`INSERT INTO app.teacher_school_memberships
      (id,teacher_id,school_id,state,created_by_aid,created_at)
      VALUES($1,$2,$3,'active',$4,clock_timestamp())`, [membership, teacher.id, student.schoolId, randomUUID()]);
    const unboundMembership = randomUUID();
    await control.query(`INSERT INTO app.teacher_school_memberships
      (id,teacher_id,school_id,state,created_by_aid,created_at)
      VALUES($1,$2,$3,'active',$4,clock_timestamp())`,
    [unboundMembership, unboundTeacher.id, student.schoolId, randomUUID()]);
    const project = await createContent(student, "教師唯讀真實專案");
    const secondProject = await makeProject(student, "第二個有效綁定專案");
    const hiddenProject = await makeProject(studentB, "另一位學生的專案");
    const binding = await linkTeacherStudent(admin, teacher, student);
    await linkTeacherStudent(admin, teacher, studentC);
    const base = `/api/v1/teacher/students/${student.id}/projects`;

    const studentsResponse = await productTeacherResourceHandlers.students(
      request(teacher, "GET", "/api/v1/teacher/students?limit=1"),
    );
    expect(studentsResponse.status).toBe(200);
    expect(studentsResponse.headers.get("cache-control")).toContain("no-store");
    const studentPageOne = await studentsResponse.json();
    expect(studentPageOne.items).toHaveLength(1);
    expect(studentPageOne.next_cursor).toBeTruthy();
    const studentPageTwo = await productTeacherResourceHandlers.students(
      request(teacher, "GET", `/api/v1/teacher/students?limit=1&after=${studentPageOne.next_cursor}`),
    );
    const studentPageTwoBody = await studentPageTwo.json();
    expect(studentPageTwoBody.items).toHaveLength(1);
    expect(studentPageTwoBody.items[0].id).not.toBe(studentPageOne.items[0].id);
    expect(studentPageTwoBody.next_cursor).toBeNull();
    expect(new Set([studentPageOne.items[0].id, studentPageTwoBody.items[0].id]))
      .toEqual(new Set([student.id, studentC.id]));

    const before = await snapshot(project);
    const projectResponse = await productTeacherResourceHandlers.project(
      request(teacher, "GET", `${base}/${project}`), { studentId: student.id, projectId: project },
    );
    expect(projectResponse.status).toBe(200);
    const detail = await projectResponse.json();
    expect(detail).toMatchObject({
      outcome: "found",
      project: { id: project, title: "教師唯讀真實專案" },
      classification: { state: "confirmed", tier: "A" },
      requirements: {
        revision: 1,
        content: { description: "正式保存的合成需求 café e\u0301" },
      },
      specification_review: "not_submitted",
    });
    expect(detail.tasks.items).toContainEqual(expect.objectContaining({ title: "已保存任務", done: true }));
    expect(detail.stages).toHaveLength(9);
    expect(detail.stages).toEqual(expect.arrayContaining([
      expect.objectContaining({ stage: "點子", saved: false }),
      expect.objectContaining({ stage: "A/B", saved: false }),
      expect.objectContaining({ stage: "Specification", saved: true, row_version: 0,
        student_confirmation: "current" }),
    ]));
    const stageResponse = await productTeacherResourceHandlers.stageDraft(
      request(teacher, "GET", `${base}/${project}/stages/Specification`),
      { studentId: student.id, projectId: project, stage: "Specification" },
    );
    expect(stageResponse.status).toBe(200);
    expect(await stageResponse.json()).toMatchObject({
      saved: true, row_version: 0, content: { text: "已保存的 Specification 草稿 café e\u0301" },
      student_confirmation: "current",
    });
    const tasksResponse = await productTeacherResourceHandlers.tasks(
      request(teacher, "GET", `${base}/${project}/tasks`),
      { studentId: student.id, projectId: project },
    );
    expect(tasksResponse.status).toBe(200);
    const taskItems = (await tasksResponse.json()).tasks.items;
    expect(taskItems).toEqual(expect.arrayContaining([
      expect.objectContaining({ title: "已保存任務", done: true }),
      expect.objectContaining({ title: "第二個已保存任務", done: false }),
    ]));
    const firstTaskPage = await productTeacherResourceHandlers.tasks(
      request(teacher, "GET", `${base}/${project}/tasks?limit=1`),
      { studentId: student.id, projectId: project },
    );
    const firstTaskPageBody = (await firstTaskPage.json()).tasks;
    expect(firstTaskPageBody.items).toHaveLength(1);
    expect(firstTaskPageBody.next_cursor).toBeTruthy();
    const secondTaskPage = await productTeacherResourceHandlers.tasks(
      request(teacher, "GET", `${base}/${project}/tasks?limit=1&after=${firstTaskPageBody.next_cursor}`),
      { studentId: student.id, projectId: project },
    );
    const secondTaskPageBody = (await secondTaskPage.json()).tasks;
    expect(secondTaskPageBody.items).toHaveLength(1);
    expect(secondTaskPageBody.items[0].id).not.toBe(firstTaskPageBody.items[0].id);
    expect(secondTaskPageBody.next_cursor).toBeNull();
    expect(await snapshot(project)).toEqual(before);
    const savedProjectState = (await control.query(
      "SELECT row_version,requirements_revision FROM app.projects WHERE id=$1", [project],
    )).rows[0];
    const revisedRequirements = await saveRequirements(
      student, project, savedProjectState.row_version, savedProjectState.requirements_revision,
      "更新後的正式需求 café",
    );
    expect(revisedRequirements.status).toBe(200);
    const revisedDraft = await productFoundationHandlers.saveStageDraft(
      request(student, "PUT", `${base}/${project}/stages/Specification`, {
        content: { text: "更新後的 Specification 草稿 café" },
      }, { "if-match": '"0"', "idempotency-key": randomUUID() }),
      project,
      "Specification",
    );
    expect(revisedDraft?.status).toBe(200);
    const revisedDetail = await productTeacherResourceHandlers.project(
      request(teacher, "GET", `${base}/${project}`), { studentId: student.id, projectId: project },
    );
    expect((await revisedDetail.json()).requirements).toMatchObject({
      revision: 2, content: { description: "更新後的正式需求 café" },
    });
    const revisedStage = await productTeacherResourceHandlers.stageDraft(
      request(teacher, "GET", `${base}/${project}/stages/Specification`),
      { studentId: student.id, projectId: project, stage: "Specification" },
    );
    expect(await revisedStage.json()).toMatchObject({
      row_version: 1, content: { text: "更新後的 Specification 草稿 café" },
      student_confirmation: "stale",
    });

    const projectList = await productTeacherResourceHandlers.projects(
      request(teacher, "GET", `${base}?limit=1`), { studentId: student.id },
    );
    expect(projectList.status).toBe(200);
    const firstProjectPage = await projectList.json();
    expect(firstProjectPage.items).toHaveLength(1);
    expect(firstProjectPage.next_cursor).toBeTruthy();
    const secondProjectPage = await productTeacherResourceHandlers.projects(
      request(teacher, "GET", `${base}?limit=1&after=${firstProjectPage.next_cursor}`),
      { studentId: student.id },
    );
    const secondProjectPageBody = await secondProjectPage.json();
    expect(secondProjectPageBody.items).toHaveLength(1);
    expect(secondProjectPageBody.items[0].id).not.toBe(firstProjectPage.items[0].id);
    expect(secondProjectPageBody.next_cursor).toBeNull();
    await expectProblem(await productTeacherResourceHandlers.project(
      request(teacher, "GET", `/api/v1/teacher/students/${studentB.id}/projects/${hiddenProject}`),
      { studentId: studentB.id, projectId: hiddenProject },
    ), 404, "not_found");
    await expectProblem(await productTeacherResourceHandlers.project(
      request(teacher, "GET", `${base}/${hiddenProject}`),
      { studentId: student.id, projectId: hiddenProject },
    ), 404, "not_found");
    await expectProblem(await productTeacherResourceHandlers.project(
      request(admin, "GET", `${base}/${project}`), { studentId: student.id, projectId: project },
    ), 404, "not_found");
    const unboundStudents = await productTeacherResourceHandlers.students(
      request(unboundTeacher, "GET", "/api/v1/teacher/students"),
    );
    expect((await unboundStudents.json()).items).toEqual([]);
    await expectProblem(await productTeacherResourceHandlers.students(
      request(student, "GET", "/api/v1/teacher/students"),
    ), 404, "not_found");
    const runtime = createDatabaseSession(teacher.id);
    await expect(runtime.write.runTransaction((query) =>
      query.query("SELECT app.teacher_resource_eligible($1::uuid)", [student.id])))
      .rejects.toMatchObject({ code: "42501" });
    await expect(runtime.write.runTransaction((query) =>
      query.query("UPDATE app.stage_records SET content=$2::jsonb WHERE project_id=$1",
        [project, JSON.stringify({ text: "unauthorized" })])))
      .rejects.toMatchObject({ code: "42501" });
    const directHidden = await runtime.write.runTransaction((query) =>
      query.query("SELECT app.read_teacher_project($1::uuid,$2::uuid) AS result", [studentB.id, hiddenProject]));
    const hiddenRow: unknown = directHidden.rows[0];
    const hiddenResult: unknown = isRecord(hiddenRow) ? hiddenRow.result : null;
    expect(isRecord(hiddenResult) ? hiddenResult.outcome : null).toBe("not_found");
    const rawRead = await runtime.write.runTransaction((query) =>
      query.query("SELECT content FROM app.stage_records WHERE project_id=$1", [project]));
    expect(rawRead.rows).toHaveLength(0);

    const auditRows = await control.query(`SELECT e.action,e.object_type,e.object_ref,e.result,e.meta,
      actor.account_id AS actor_id,subject.account_id AS subject_id
      FROM app.audit_events e
      JOIN app.audit_identity_map actor ON actor.aid=e.actor_aid
      JOIN app.audit_identity_map subject ON subject.aid=e.subject_aid
      WHERE actor.account_id=$1 AND e.object_ref=$2 ORDER BY e.at`, [teacher.id, project]);
    expect(auditRows.rows.length).toBeGreaterThanOrEqual(4);
    expect(auditRows.rows.every((row) => row.action === "teacher_view" && row.object_type === "project" &&
      row.result === "ok" && row.meta && Object.keys(row.meta).length === 0 &&
      row.actor_id === teacher.id && row.subject_id === student.id)).toBe(true);

    await control.query(`ALTER TABLE app.audit_events ADD CONSTRAINT ${testConstraint}
      CHECK (action <> 'teacher_view') NOT VALID`);
    const failedAudit = await productTeacherResourceHandlers.project(
      request(teacher, "GET", `${base}/${project}`), { studentId: student.id, projectId: project },
    );
    expect(failedAudit.status).toBe(503);
    expect(await failedAudit.text()).not.toContain("教師唯讀真實專案");
    await control.query(`ALTER TABLE app.audit_events DROP CONSTRAINT ${testConstraint}`);

    await control.query("UPDATE app.teacher_school_memberships SET state='ended',ended_at=clock_timestamp(),ended_by_aid=gen_random_uuid() WHERE id=$1", [membership]);
    await expectProblem(await productTeacherResourceHandlers.project(
      request(teacher, "GET", `${base}/${project}`), { studentId: student.id, projectId: project },
    ), 404, "not_found");
    await control.query(`INSERT INTO app.teacher_school_memberships(id,teacher_id,school_id,state,created_by_aid,created_at)
      SELECT gen_random_uuid(),teacher_id,school_id,'active',created_by_aid,clock_timestamp()
      FROM app.teacher_school_memberships WHERE id=$1`, [membership]);
    await control.query("UPDATE app.profiles SET status='disabled' WHERE id=$1", [teacher.id]);
    await expectProblem(await productTeacherResourceHandlers.project(
      request(teacher, "GET", `${base}/${project}`), { studentId: student.id, projectId: project },
    ), 404, "not_found");
    await control.query("UPDATE app.profiles SET status='approved' WHERE id=$1", [teacher.id]);
    await control.query("UPDATE app.profiles SET status='disabled' WHERE id=$1", [student.id]);
    await expectProblem(await productTeacherResourceHandlers.project(
      request(teacher, "GET", `${base}/${project}`), { studentId: student.id, projectId: project },
    ), 404, "not_found");
    await control.query("UPDATE app.profiles SET status='approved' WHERE id=$1", [student.id]);
    await control.query("UPDATE app.profiles SET deletion_state='marked' WHERE id=$1", [student.id]);
    await expectProblem(await productTeacherResourceHandlers.project(
      request(teacher, "GET", `${base}/${project}`), { studentId: student.id, projectId: project },
    ), 404, "not_found");
    await control.query("UPDATE app.profiles SET deletion_state='none' WHERE id=$1", [student.id]);
    await control.query("UPDATE app.schools SET approval_state='withdrawn' WHERE id=$1", [student.schoolId]);
    await expectProblem(await productTeacherResourceHandlers.project(
      request(teacher, "GET", `${base}/${project}`), { studentId: student.id, projectId: project },
    ), 404, "not_found");
    await control.query("UPDATE app.schools SET approval_state='approved' WHERE id=$1", [student.schoolId]);
    await control.query("UPDATE app.schools SET valid_until=clock_timestamp()-interval '1 second' WHERE id=$1", [student.schoolId]);
    expect((await (await productTeacherResourceHandlers.students(
      request(teacher, "GET", "/api/v1/teacher/students"),
    )).json()).items).toEqual([]);
    await control.query("UPDATE app.schools SET valid_until=NULL WHERE id=$1", [student.schoolId]);

    let releaseRead!: () => void;
    let readStarted!: () => void;
    const readBarrier = new Promise<void>((resolve) => { releaseRead = resolve; });
    const readEntered = new Promise<void>((resolve) => { readStarted = resolve; });
    const readTransaction = createDatabaseSession(teacher.id).write.runTransaction(async (query) => {
      const { rows } = await query.query("SELECT app.read_teacher_project($1::uuid,$2::uuid) AS result",
        [student.id, project]);
      readStarted();
      await readBarrier;
      const readRow: unknown = rows[0];
      return isRecord(readRow) ? readRow.result : null;
    });
    await readEntered;
    const ending = productBindingHandlers.end(
      request(admin, "DELETE", `/api/v1/admin/bindings/${binding}`, { end_reason: "整合測試解除" },
        { "idempotency-key": randomUUID() }),
      { id: binding },
    );
    try {
      await waitForLockWait(control);
    } finally {
      releaseRead();
    }
    const readResult: unknown = await readTransaction;
    expect(isRecord(readResult) ? readResult.outcome : null).toBe("found");
    const ended = await ending;
    expect(ended.status).toBe(200);
    await expectProblem(await productTeacherResourceHandlers.project(
      request(teacher, "GET", `${base}/${project}`), { studentId: student.id, projectId: project },
    ), 404, "not_found");

    const badQuery = await productTeacherResourceHandlers.students(
      request(teacher, "GET", "/api/v1/teacher/students?limit=51"),
    );
    expect(badQuery.status).toBe(400);
    expect(await badQuery.text()).not.toContain("教師唯讀真實專案");
  }, 180_000);
});

async function expectProblem(response: Response, status: number, code: string) {
  expect(response.status).toBe(status);
  const body: unknown = await response.json();
  expect(body).toMatchObject({ status, code });
}
