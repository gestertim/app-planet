import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeServerDatabasePool, createDatabaseSession } from "../../apps/web/src/server/database-session.ts";
import { createAuthPrincipalResolver, sessionCookieName } from "../../apps/web/src/server/auth-principal.ts";
import { createProjectHandlers } from "../../apps/web/src/server/project-handlers.ts";
import { POST as importTasksRoute } from "../../apps/web/src/app/api/v1/projects/[id]/tasks/route.ts";
import { PATCH as patchProjectTaskDone } from "../../apps/web/src/app/api/v1/projects/[id]/tasks/[tid]/route.ts";
import { listOwnedProjectTasksSubset } from "../../apps/web/src/server/project-tasks.ts";
import {
  closeSyntheticWorkerPool,
  createOwnedSyntheticProject,
  createSyntheticAuthAccount,
  deleteSyntheticAuthAccount,
  loginSyntheticAccount,
  openControlPool,
  type NativeAuthSession,
  type SyntheticAuthAccount,
} from "../support/real-auth-fixture.ts";

const appOrigin = process.env.APP_PLANET_APP_ORIGIN!;
const accounts: SyntheticAuthAccount[] = [];
const projectIds: string[] = [];
let control!: Pool;
let owner: SyntheticAuthAccount;
let other: SyntheticAuthAccount;
let ownerSession: NativeAuthSession;
let otherSession: NativeAuthSession;

function request(path: string, method: string, session: NativeAuthSession | undefined,
  headers: Record<string, string>, body?: unknown, rawBody?: string): Request {
  const requestHeaders = new Headers(headers);
  if (session) requestHeaders.set("cookie", `${sessionCookieName}=${session.accessToken}`);
  if (!requestHeaders.has("origin")) requestHeaders.set("origin", appOrigin);
  if (body !== undefined || rawBody !== undefined) requestHeaders.set("content-type", "application/json");
  return new Request(`${appOrigin}${path}`, {
    method, headers: requestHeaders,
    ...(rawBody !== undefined ? { body: rawBody } : body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

const importPath = (projectId: string) => `/api/v1/projects/${projectId}/tasks`;
const confirmed = (...titles: string[]) => ({ confirmed: true, tasks: titles.map((title) => ({ title })) });

function importTasks(projectId: string, session: NativeAuthSession | undefined, body: unknown,
  key: string | null = randomUUID(), rawBody?: string): Promise<Response> {
  return importTasksRoute(
    request(importPath(projectId), "POST", session, key === null ? {} : { "idempotency-key": key }, body, rawBody),
    { params: Promise.resolve({ id: projectId }) },
  );
}

async function newProject(account = owner): Promise<string> {
  const id = await createOwnedSyntheticProject(account);
  projectIds.push(id);
  return id;
}

const taskRows = async (projectId: string) => (await control.query(
  `SELECT "order", title, done, row_version, done_snapshot_id FROM app.tasks WHERE project_id=$1 ORDER BY "order"`,
  [projectId])).rows;
const importRows = async (projectId: string) => (await control.query(
  "SELECT owner_id, idempotency_key, request_hash, task_ids, source FROM app.project_task_imports WHERE project_id=$1",
  [projectId])).rows;
const noSideEffects = async (projectId: string) => {
  expect(await taskRows(projectId)).toEqual([]);
  expect(await importRows(projectId)).toEqual([]);
};

async function expectProjectUntouched(projectId: string) {
  expect((await control.query(
    "SELECT stage,row_version,classification_state,current_confirmation_id FROM app.projects WHERE id=$1",
    [projectId])).rows).toEqual([{
    stage: "點子", row_version: 0, classification_state: "unconfirmed", current_confirmation_id: null,
  }]);
  expect((await control.query("SELECT count(*)::int AS n FROM app.stage_records WHERE project_id=$1", [projectId]))
    .rows[0].n).toBe(0);
}

beforeAll(async () => {
  control = openControlPool();
  owner = await createSyntheticAuthAccount(control, "ImportOwner");
  other = await createSyntheticAuthAccount(control, "ImportOther");
  accounts.push(owner, other);
  ownerSession = await loginSyntheticAccount(owner);
  otherSession = await loginSyntheticAccount(other);
});

afterAll(async () => {
  try {
    await control.query("DROP TRIGGER IF EXISTS test_fail_tasks ON app.tasks");
    await control.query("DROP TRIGGER IF EXISTS test_fail_imports ON app.project_task_imports");
    await control.query("DROP FUNCTION IF EXISTS app.test_fail_import()");
    await closeServerDatabasePool();
    await closeSyntheticWorkerPool();
    if (projectIds.length) {
      await control.query("DELETE FROM app.project_task_imports WHERE project_id=ANY($1::uuid[])", [projectIds]);
      await control.query("DELETE FROM app.tasks WHERE project_id=ANY($1::uuid[])", [projectIds]);
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

describe("本人手動任務清單首次匯入（真 Auth → Route Handler → 隔離 PostgreSQL）", () => {
  it("未確認、strict body 與非法輸入皆回 4xx 且無任何副作用", async () => {
    const project = await newProject();
    const bad: unknown[] = [
      { tasks: [{ title: "a" }] },
      { confirmed: false, tasks: [{ title: "a" }] },
      { confirmed: "true", tasks: [{ title: "a" }] },
      { confirmed: true },
      { confirmed: true, tasks: [] },
      { confirmed: true, tasks: [{ title: "a" }], owner_id: owner.id },
      { confirmed: true, tasks: [{ title: "a" }], project_id: randomUUID() },
      { confirmed: true, tasks: [{ title: "a", done: true }] },
      { confirmed: true, tasks: [{ title: "a", id: randomUUID() }] },
      { confirmed: true, tasks: [{ title: "a", row_version: 5 }] },
      { confirmed: true, tasks: [{ title: "   " }] },
      { confirmed: true, tasks: [{ title: "含\n換行" }] },
      { confirmed: true, tasks: [{ title: "含\u0000空字元" }] },
      { confirmed: true, tasks: [{ title: "x".repeat(201) }] },
      { confirmed: true, tasks: Array.from({ length: 51 }, (_, index) => ({ title: `t${index}` })) },
      { confirmed: true, tasks: [{ title: 1 }] },
      { confirmed: true, tasks: ["a"] },
      [], null, "x",
    ];
    for (const body of bad) {
      expect((await importTasks(project, ownerSession, body)).status).toBe(400);
    }
    expect((await importTasks(project, ownerSession, undefined, randomUUID(), "{壞json")).status).toBe(400);
    expect((await importTasks(project, ownerSession, confirmed("a"), null)).status).toBe(400);
    expect((await importTasks(project, ownerSession, confirmed("a"), "not-a-uuid")).status).toBe(400);
    expect((await importTasksRoute(
      request(importPath(project), "POST", ownerSession, { "idempotency-key": randomUUID(), origin: "https://evil.example" }, confirmed("a")),
      { params: Promise.resolve({ id: project }) },
    )).status).toBeGreaterThanOrEqual(400);
    expect((await importTasks(project, ownerSession, confirmed("a"), randomUUID(), JSON.stringify(confirmed("a")) + " ".repeat(70_000))).status)
      .toBe(413);
    expect((await importTasks(project, undefined, confirmed("a"))).status).toBe(401);
    await noSideEffects(project);
    await expectProjectUntouched(project);
  });

  it("首次確認建立：服務端控制 ID／owner／版本，初始 done=false、版本 0，不寫批准／證據欄位", async () => {
    const project = await newProject();
    const key = randomUUID();
    const response = await importTasks(project, ownerSession, confirmed("  第一項  ", "第二項", "第三項"), key);
    expect(response.status).toBe(201);
    expect(response.headers.get("location")).toBe(`/api/v1/projects/${project}`);
    const body = await response.json();
    expect(body.outcome).toBe("created");
    expect(body.tasks.map((task: { order: number; title: string; done: boolean; row_version: number; project_id: string }) =>
      [task.order, task.title, task.done, task.row_version, task.project_id]))
      .toEqual([[1, "第一項", false, 0, project], [2, "第二項", false, 0, project], [3, "第三項", false, 0, project]]);
    expect(await taskRows(project)).toEqual([
      { order: 1, title: "第一項", done: false, row_version: 0, done_snapshot_id: null },
      { order: 2, title: "第二項", done: false, row_version: 0, done_snapshot_id: null },
      { order: 3, title: "第三項", done: false, row_version: 0, done_snapshot_id: null },
    ]);
    const imports = await importRows(project);
    expect(imports).toHaveLength(1);
    expect(imports[0]).toMatchObject({ owner_id: owner.id, idempotency_key: key, source: "student_manual" });
    expect(imports[0].task_ids).toEqual(body.tasks.map((task: { id: string }) => task.id));
    expect(imports[0].request_hash).toMatch(/^[0-9a-f]{64}$/);
    await expectProjectUntouched(project);
    for (const table of ["agent_runs", "jobs"]) {
      const exists = (await control.query("SELECT to_regclass($1)::text AS name", [`app.${table}`])).rows[0].name;
      if (exists) expect((await control.query(`SELECT count(*)::int AS n FROM app.${table}`)).rows[0].n).toBe(0);
    }
    const read = await listOwnedProjectTasksSubset(createDatabaseSession(owner.id).read, { project_id: project });
    expect(read).toMatchObject({ outcome: "listed", tasks: [{ title: "第一項" }, { title: "第二項" }, { title: "第三項" }] });
  });

  it("同次確認重送／response-loss 恢復只重放原結果；異內容同鍵、換鍵再匯入均拒絕且不覆蓋 done／版本", async () => {
    const project = await newProject();
    const key = randomUUID();
    const first = await importTasks(project, ownerSession, confirmed("甲", "乙"), key);
    expect(first.status).toBe(201);
    const created = await first.json();
    const taskId = created.tasks[0].id as string;

    const checked = await patchProjectTaskDone(
      request(`${importPath(project)}/${taskId}`, "PATCH", ownerSession, { "if-match": '"0"' }, { done: true }),
      { params: Promise.resolve({ id: project, tid: taskId }) },
    );
    expect(checked.status).toBe(200);
    expect(await checked.json()).toMatchObject({ id: taskId, done: true, row_version: 1 });
    const stale = await patchProjectTaskDone(
      request(`${importPath(project)}/${taskId}`, "PATCH", ownerSession, { "if-match": '"0"' }, { done: false }),
      { params: Promise.resolve({ id: project, tid: taskId }) },
    );
    expect(stale.status).toBe(409);

    const replay = await importTasks(project, ownerSession, confirmed("甲", "乙"), key);
    expect(replay.status).toBe(200);
    const replayed = await replay.json();
    expect(replayed.outcome).toBe("replayed");
    expect(replayed.tasks.map((task: { id: string }) => task.id)).toEqual(created.tasks.map((task: { id: string }) => task.id));
    expect(replayed.tasks[0]).toMatchObject({ done: true, row_version: 1 });

    expect((await importTasks(project, ownerSession, confirmed("甲", "丙"), key)).status).toBe(422);
    expect((await importTasks(project, ownerSession, confirmed("乙", "甲"), key)).status).toBe(422);
    const another = await importTasks(project, ownerSession, confirmed("全新"), randomUUID());
    expect(another.status).toBe(409);
    expect((await another.json()).code).toBe("task_list_already_exists");
    const sameBodyNewKey = await importTasks(project, ownerSession, confirmed("甲", "乙"), randomUUID());
    expect(sameBodyNewKey.status).toBe(409);
    expect(await taskRows(project)).toEqual([
      { order: 1, title: "甲", done: true, row_version: 1, done_snapshot_id: null },
      { order: 2, title: "乙", done: false, row_version: 0, done_snapshot_id: null },
    ]);
    expect((await importRows(project))).toHaveLength(1);
  });

  it("同一 key 用在另一個專案被拒絕；已有非匯入任務時新匯入被拒絕且資料不變", async () => {
    const first = await newProject();
    const second = await newProject();
    const key = randomUUID();
    expect((await importTasks(first, ownerSession, confirmed("甲"), key)).status).toBe(201);
    expect((await importTasks(second, ownerSession, confirmed("甲"), key)).status).toBe(422);
    await noSideEffects(second);

    const withExisting = await newProject();
    await control.query(`INSERT INTO app.tasks (project_id,"order",title,done,row_version) VALUES ($1,1,'既有',true,4)`, [withExisting]);
    const rejected = await importTasks(withExisting, ownerSession, confirmed("新的"));
    expect(rejected.status).toBe(409);
    expect(await taskRows(withExisting)).toEqual([
      { order: 1, title: "既有", done: true, row_version: 4, done_snapshot_id: null },
    ]);
    expect(await importRows(withExisting)).toEqual([]);
  });

  it("跨帳號、跨專案、teacher／admin 角色均拒絕，且無副作用", async () => {
    const project = await newProject();
    expect((await importTasks(project, otherSession, confirmed("越權"))).status).toBe(404);
    expect((await importTasks(randomUUID(), ownerSession, confirmed("不存在"))).status).toBe(404);
    expect((await importTasks("not-a-uuid", ownerSession, confirmed("壞 ID"))).status).toBe(404);
    for (const role of ["teacher", "admin"]) {
      await control.query("UPDATE app.profiles SET role=$2 WHERE id=$1", [other.id, role]);
      const response = await importTasks(project, otherSession, confirmed(`${role} 冒充`));
      expect([403, 404]).toContain(response.status);
    }
    await control.query("UPDATE app.profiles SET role='student' WHERE id=$1", [other.id]);
    await noSideEffects(project);
  });

  it("handler 檢查後帳號失權：DB 仍拒絕，不寫入", async () => {
    const project = await newProject();
    const revoking = createProjectHandlers({
      resolver: createAuthPrincipalResolver(),
      requireSameOrigin: true,
      beforeExecute: async () => {
        await control.query("UPDATE app.profiles SET status='disabled' WHERE id=$1", [owner.id]);
      },
    });
    try {
      const response = await revoking.importTasks(
        request(importPath(project), "POST", ownerSession, { "idempotency-key": randomUUID() }, confirmed("失權")),
        { projectId: project },
      );
      expect(response.status).toBe(403);
    } finally {
      await control.query("UPDATE app.profiles SET status='approved' WHERE id=$1", [owner.id]);
    }
    await noSideEffects(project);
  });

  it("不同分頁並行首次匯入：只成功一份、不重複、不互相覆蓋；同鍵並行只一次建立", async () => {
    const project = await newProject();
    const results = await Promise.all(Array.from({ length: 6 }, (_, index) =>
      importTasks(project, ownerSession, confirmed(`分頁${index}-甲`, `分頁${index}-乙`))));
    const statuses = results.map((response) => response.status).sort();
    expect(statuses).toEqual([201, 409, 409, 409, 409, 409]);
    const rows = await taskRows(project);
    expect(rows).toHaveLength(2);
    expect(rows[0].title.endsWith("-甲") && rows[1].title.endsWith("-乙") &&
      rows[0].title.split("-")[0] === rows[1].title.split("-")[0]).toBe(true);
    expect(await importRows(project)).toHaveLength(1);

    const sameKeyProject = await newProject();
    const key = randomUUID();
    const same = await Promise.all(Array.from({ length: 4 }, () =>
      importTasks(sameKeyProject, ownerSession, confirmed("同鍵甲", "同鍵乙"), key)));
    expect(same.map((response) => response.status).sort()).toEqual([200, 200, 200, 201]);
    expect(await taskRows(sameKeyProject)).toHaveLength(2);
    expect(await importRows(sameKeyProject)).toHaveLength(1);
  });

  it("寫入中途故障整筆 rollback，不留半份清單或確認紀錄", async () => {
    await control.query(`
      CREATE FUNCTION app.test_fail_import() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF TG_TABLE_NAME = 'tasks' AND NEW."order" = 2 THEN RAISE EXCEPTION 'synthetic task failure'; END IF;
        IF TG_TABLE_NAME = 'project_task_imports' THEN RAISE EXCEPTION 'synthetic import failure'; END IF;
        RETURN NEW;
      END $$`);
    try {
      const midTasks = await newProject();
      await control.query("CREATE TRIGGER test_fail_tasks BEFORE INSERT ON app.tasks FOR EACH ROW EXECUTE FUNCTION app.test_fail_import()");
      const failedTasks = await importTasks(midTasks, ownerSession, confirmed("一", "二", "三"));
      expect(failedTasks.status).toBe(503);
      await noSideEffects(midTasks);
      await control.query("DROP TRIGGER test_fail_tasks ON app.tasks");

      const lateImport = await newProject();
      await control.query("CREATE TRIGGER test_fail_imports BEFORE INSERT ON app.project_task_imports FOR EACH ROW EXECUTE FUNCTION app.test_fail_import()");
      const failedImport = await importTasks(lateImport, ownerSession, confirmed("一", "二"));
      expect(failedImport.status).toBe(503);
      await noSideEffects(lateImport);
      await control.query("DROP TRIGGER test_fail_imports ON app.project_task_imports");

      const retry = await importTasks(lateImport, ownerSession, confirmed("一", "二"));
      expect(retry.status).toBe(201);
    } finally {
      await control.query("DROP TRIGGER IF EXISTS test_fail_tasks ON app.tasks");
      await control.query("DROP TRIGGER IF EXISTS test_fail_imports ON app.project_task_imports");
      await control.query("DROP FUNCTION IF EXISTS app.test_fail_import()");
    }
  });

  it("權限與目錄：authenticated 不可直接寫入／讀取匯入表；受控 writer 為 NOLOGIN／NOBYPASSRLS", async () => {
    const project = await newProject();
    const session = createDatabaseSession(owner.id);
    await expect(session.write.runTransaction((query) =>
      query.query(`INSERT INTO app.tasks (project_id,"order",title) VALUES ($1,1,'直接寫入')`, [project])))
      .rejects.toThrow();
    await expect(session.write.runTransaction((query) =>
      query.query("SELECT * FROM app.project_task_imports"))).rejects.toThrow();
    await expect(session.write.runTransaction((query) =>
      query.query(`UPDATE app.tasks SET title='x' WHERE project_id=$1`, [project]))).rejects.toThrow();
    await noSideEffects(project);

    const catalog = (await control.query(`
      SELECT r.rolcanlogin, r.rolbypassrls, r.rolsuper,
        p.prosecdef, pg_get_userbyid(p.proowner) AS owner,
        has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth_exec,
        has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_exec,
        has_function_privilege('public', p.oid, 'EXECUTE') AS public_exec,
        c.relrowsecurity, c.relforcerowsecurity
      FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace AND n.nspname='app'
      JOIN pg_roles r ON r.oid=p.proowner
      JOIN pg_class c ON c.relname='project_task_imports' AND c.relnamespace=n.oid
      WHERE p.proname='import_owned_project_tasks'`)).rows;
    expect(catalog).toEqual([{
      rolcanlogin: false, rolbypassrls: false, rolsuper: false, prosecdef: true,
      owner: "app_project_task_importer", auth_exec: true, anon_exec: false, public_exec: false,
      relrowsecurity: true, relforcerowsecurity: true,
    }]);
  });
});
