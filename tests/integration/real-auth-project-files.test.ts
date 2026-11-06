import { randomUUID, createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { productProjectFileHandlers, productProjectHandlers } from "../../apps/web/src/server/product-handlers.ts";
import { closeServerDatabasePool } from "../../apps/web/src/server/database-session.ts";
import { sessionCookieName } from "../../apps/web/src/server/auth-principal.ts";
import {
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
let projectId: string;

function request(
  actor: NativeAuthSession,
  path: string,
  method = "GET",
  body?: unknown,
  headers: Record<string, string> = {},
) {
  return new Request(`${origin}${path}`, {
    method,
    headers: {
      cookie: `${sessionCookieName}=${actor.accessToken}`,
      origin,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function createProject(actor: NativeAuthSession): Promise<string> {
  const response = await productProjectHandlers.create(request(actor, "/api/v1/projects", "POST",
    { title: "原始碼與手動快照隔離驗收" }, { "idempotency-key": randomUUID() }));
  expect(response.status).toBe(201);
  const projectId = (await response.json()).id as string;
  expect(projectId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  const owner = await control.query("SELECT owner_id FROM app.projects WHERE id=$1", [projectId]);
  expect(owner.rows[0]?.owner_id).toBe(actor.userId);
  return projectId;
}

function put(
  actor: NativeAuthSession,
  path: string,
  content: string,
  precondition: { ifNoneMatch: "*" } | { ifMatch: string },
  key = randomUUID(),
  targetProjectId = projectId,
) {
  return productProjectFileHandlers.file(
    request(actor, `/api/v1/projects/${targetProjectId}/files/${path}`, "PUT", { content }, {
      "idempotency-key": key,
      ...("ifNoneMatch" in precondition
        ? { "if-none-match": "*" }
        : { "if-match": `"${precondition.ifMatch}"` }),
    }),
    { id: targetProjectId, path },
  );
}

async function snapshot(actor: NativeAuthSession, key = randomUUID(), targetProjectId = projectId) {
  return productProjectFileHandlers.snapshots(
    request(actor, `/api/v1/projects/${targetProjectId}/snapshots`, "POST", { kind: "manual" },
      { "idempotency-key": key }),
    { id: targetProjectId },
  );
}

beforeAll(async () => {
  if (process.env.APP_PLANET_ENV !== "isolated-local-test") throw Error("isolated runner required");
  control = openControlPool();
  actors = await createReviewActors(control);
  [student, otherStudent, teacher, admin] = await Promise.all(
    [actors.student, actors.otherStudent, actors.teacher, actors.admin].map(loginSyntheticAccount),
  );
  if (process.env.APP_PLANET_TEST_MIGRATE_THROUGH === "0040") {
    projectId = await createProject(student);
    const before = await control.query(
      "SELECT to_jsonb(p) AS project FROM app.projects p WHERE id=$1", [projectId],
    );
    await control.query(await readFile(new URL("../../supabase/migrations/0041_project_files_snapshots.sql", import.meta.url), "utf8"));
    const after = await control.query(
      "SELECT to_jsonb(p) AS project FROM app.projects p WHERE id=$1", [projectId],
    );
    expect(after.rows).toEqual(before.rows);
  } else {
    projectId = await createProject(student);
  }
});

afterAll(async () => {
  if (!control) return;
  await closeServerDatabasePool();
  await control.end();
});

describe("E-1／S-1／S-3 真 Auth、Route Handler 與隔離 PostgreSQL", () => {
  it("空專案由正式 API 建立 HTML／CSS／JavaScript，DB 保存原文與可信 bytes/hash", async () => {
    const empty = await productProjectFileHandlers.listFiles(
      request(student, `/api/v1/projects/${projectId}/files`), { id: projectId },
    );
    expect(empty.status).toBe(200);
    expect(await empty.json()).toEqual({ items: [] });

    const content = new Map([
      ["index.html", "<!doctype html>\r\n<h1>你好 🌍</h1>\r\n"],
      ["styles.css", "body { color: #123; }\r\n"],
      ["app.js", 'document.body.textContent = "文字而非預覽";\r\n'],
    ]);
    for (const [path, text] of content) {
      const created = await put(student, path, text, { ifNoneMatch: "*" });
      expect(created.status).toBe(201);
      const body = await created.json();
      expect(body).toMatchObject({
        path,
        bytes: new TextEncoder().encode(text).byteLength,
        hash: createHash("sha256").update(text, "utf8").digest("hex"),
      });
      const read = await productProjectFileHandlers.file(
        request(student, `/api/v1/projects/${projectId}/files/${path}`),
        { id: projectId, path },
      );
      expect(read.status).toBe(200);
      expect(read.headers.get("etag")).toBe(`"${body.hash}"`);
      expect(await read.json()).toMatchObject({ ...body, content: text });
    }

    const listed = await productProjectFileHandlers.listFiles(
      request(student, `/api/v1/projects/${projectId}/files`), { id: projectId },
    );
    expect((await listed.json()).items.map((item: { path: string }) => item.path))
      .toEqual(["app.js", "index.html", "styles.css"]);
    const stored = await control.query(`
      SELECT f.path, f.bytes, b.hash, convert_from(b.content,'UTF8') AS content
      FROM app.project_files f JOIN app.blobs b ON b.hash=f.blob_hash
      WHERE f.project_id=$1 ORDER BY f.path COLLATE "C"
    `, [projectId]);
    expect(stored.rows.map((row) => [row.path, row.bytes, row.content]))
      .toEqual([...content].sort(([left], [right]) => left < right ? -1 : 1)
        .map(([path, text]) => [path, new TextEncoder().encode(text).byteLength, text]));
  });

  it("If-None-Match 禁止覆蓋，If-Match 只接受目前 hash 並以原子 CAS 更新", async () => {
    const original = "<p>第一版</p>";
    const first = await put(student, "cas.html", original, { ifNoneMatch: "*" });
    const hash = (await first.json()).hash as string;
    const duplicate = await put(student, "cas.html", "不能覆蓋", { ifNoneMatch: "*" });
    expect(duplicate.status, JSON.stringify(await duplicate.clone().json())).toBe(412);
    const updated = await put(student, "cas.html", "<p>更新版</p>", { ifMatch: hash });
    expect(updated.status).toBe(200);
    expect((await updated.json()).hash).toBe(createHash("sha256").update("<p>更新版</p>").digest("hex"));
    const stale = await put(student, "cas.html", "舊 hash 不得覆蓋", { ifMatch: hash });
    expect(stale.status).toBe(409);
    const read = await productProjectFileHandlers.file(
      request(student, `/api/v1/projects/${projectId}/files/cas.html`),
      { id: projectId, path: "cas.html" },
    );
    expect((await read.json()).content).toBe("<p>更新版</p>");

    const lostResponseKey = randomUUID();
    const committed = await put(student, "lost-response.js", "已提交但客戶端未收到回應",
      { ifNoneMatch: "*" }, lostResponseKey);
    expect(committed.status).toBe(201);
    const replay = await productProjectFileHandlers.file(
      request(student, `/api/v1/projects/${projectId}/files/lost-response.js`, "PUT",
        { content: "已提交但客戶端未收到回應" }, {
          "idempotency-key": lostResponseKey,
          "if-none-match": "*",
          "idempotency-replay-only": "true",
        }),
      { id: projectId, path: "lost-response.js" },
    );
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({
      path: "lost-response.js",
      hash: createHash("sha256").update("已提交但客戶端未收到回應").digest("hex"),
    });
  });

  it("manual 快照只引用已保存完整檔案集；原鍵重放不增加版本，後續保存不改舊本文", async () => {
    const key = randomUUID();
    const created = await snapshot(student, key);
    expect(created.status).toBe(201);
    const first = await created.json();
    expect(first).toMatchObject({ version_no: 1, kind: "manual", immutable: false });
    const replay = await snapshot(student, key);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ id: first.id, version_no: 1 });
    const listed = await productProjectFileHandlers.snapshots(
      request(student, `/api/v1/projects/${projectId}/snapshots?limit=20`), { id: projectId },
    );
    expect(listed.status, JSON.stringify(await listed.clone().json())).toBe(200);
    expect((await listed.json()).items[0]).toMatchObject({ id: first.id, version_no: 1 });
    const reused = await productProjectFileHandlers.snapshots(
      request(student, `/api/v1/projects/${projectId}/snapshots`, "POST",
        { kind: "manual", message: "不同意圖" }, { "idempotency-key": key }),
      { id: projectId },
    );
    expect(reused.status).toBe(422);
    const file = await productProjectFileHandlers.snapshotFile(
      request(student, `/api/v1/projects/${projectId}/snapshots/${first.id}/files/index.html`),
      { id: projectId, snapshotId: first.id, path: "index.html" },
    );
    expect((await file.json()).content).toBe("<!doctype html>\r\n<h1>你好 🌍</h1>\r\n");

    const current = await control.query(
      "SELECT blob_hash FROM app.project_files WHERE project_id=$1 AND path='index.html'", [projectId],
    );
    await put(student, "index.html", "<!doctype html>\r\n<h1>新版本</h1>\r\n",
      { ifMatch: current.rows[0].blob_hash });
    const oldFile = await productProjectFileHandlers.snapshotFile(
      request(student, `/api/v1/projects/${projectId}/snapshots/${first.id}/files/index.html`),
      { id: projectId, snapshotId: first.id, path: "index.html" },
    );
    expect((await oldFile.json()).content).toBe("<!doctype html>\r\n<h1>你好 🌍</h1>\r\n");
    const manifest = await productProjectFileHandlers.snapshot(
      request(student, `/api/v1/projects/${projectId}/snapshots/${first.id}/manifest`),
      { id: projectId, snapshotId: first.id },
    );
    expect((await manifest.json()).files.map((entry: { path: string }) => entry.path))
      .toEqual(["app.js", "cas.html", "index.html", "lost-response.js", "styles.css"]);
  });

  it("並行新檔不互相覆蓋；並行快照由 DB 原子分配不同版本", async () => {
    const attempts = await Promise.all([
      put(student, "race.css", "a{}", { ifNoneMatch: "*" }),
      put(student, "race.css", "b{}", { ifNoneMatch: "*" }),
    ]);
    expect(attempts.map((result) => result.status).sort()).toEqual([201, 412]);
    const versions = await Promise.all([snapshot(student), snapshot(student)]);
    expect(versions.map((result) => result.status)).toEqual([201, 201]);
    const bodies = await Promise.all(versions.map((result) => result.json()));
    expect(new Set(bodies.map((body) => body.version_no)).size).toBe(2);
    expect(bodies.map((body) => body.version_no).sort((a: number, b: number) => a - b))
      .toEqual([2, 3]);
  });

  it("檔案 CAS 與 manual 快照並行時只讀到保存前或保存後的完整本文", async () => {
    const interleaveProject = await createProject(student);
    const original = "保存前完整原文";
    const created = await put(student, "index.html", original, { ifNoneMatch: "*" },
      randomUUID(), interleaveProject);
    const originalHash = (await created.json()).hash as string;
    const updatedContent = "保存後完整原文";
    const [updated, captured] = await Promise.all([
      put(student, "index.html", updatedContent, { ifMatch: originalHash }, randomUUID(), interleaveProject),
      snapshot(student, randomUUID(), interleaveProject),
    ]);
    expect(updated.status).toBe(200);
    expect(captured.status).toBe(201);
    const snapshotId = (await captured.json()).id as string;
    const capturedFile = await productProjectFileHandlers.snapshotFile(
      request(student, `/api/v1/projects/${interleaveProject}/snapshots/${snapshotId}/files/index.html`),
      { id: interleaveProject, snapshotId, path: "index.html" },
    );
    expect([original, updatedContent]).toContain((await capturedFile.json()).content);
    const current = await productProjectFileHandlers.file(
      request(student, `/api/v1/projects/${interleaveProject}/files/index.html`),
      { id: interleaveProject, path: "index.html" },
    );
    expect((await current.json()).content).toBe(updatedContent);
  });

  it("audit 故障會 rollback 檔案、blob、快照、receipt 與 audit", async () => {
    const rollbackProject = await createProject(student);
    const content = `synthetic rollback ${rollbackProject}`;
    const hash = createHash("sha256").update(content, "utf8").digest("hex");
    const createFailureTrigger = async () => {
      await control.query(`
        CREATE FUNCTION app.test_reject_project_file_audit() RETURNS trigger
        LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'synthetic_audit_failure'; END
        $$
      `);
      await control.query(`
        CREATE TRIGGER test_reject_project_file_audit
        BEFORE INSERT ON app.project_file_audit
        FOR EACH ROW EXECUTE FUNCTION app.test_reject_project_file_audit()
      `);
    };
    const removeFailureTrigger = async () => {
      await control.query("DROP TRIGGER IF EXISTS test_reject_project_file_audit ON app.project_file_audit");
      await control.query("DROP FUNCTION IF EXISTS app.test_reject_project_file_audit()");
    };

    await createFailureTrigger();
    try {
      const failedSaveKey = randomUUID();
      const failedSave = await put(student, "rollback.js", content, { ifNoneMatch: "*" }, failedSaveKey);
      expect(failedSave.status).toBe(503);
      expect(await control.query(
        "SELECT count(*)::int AS count FROM app.project_files WHERE project_id=$1", [rollbackProject],
      )).toMatchObject({ rows: [{ count: 0 }] });
      expect(await control.query(
        "SELECT count(*)::int AS count FROM app.blobs WHERE hash=$1", [hash],
      )).toMatchObject({ rows: [{ count: 0 }] });
      expect(await control.query(
        "SELECT count(*)::int AS count FROM app.project_file_receipts WHERE project_id=$1 AND idempotency_key=$2",
        [rollbackProject, failedSaveKey],
      )).toMatchObject({ rows: [{ count: 0 }] });

      await removeFailureTrigger();
      const saved = await put(student, "rollback.js", content, { ifNoneMatch: "*" });
      expect(saved.status).toBe(201);
      await createFailureTrigger();
      const failedSnapshotKey = randomUUID();
      const failedSnapshot = await snapshot(student, failedSnapshotKey, rollbackProject);
      expect(failedSnapshot.status).toBe(503);
      expect(await control.query(
        "SELECT count(*)::int AS count FROM app.snapshots WHERE project_id=$1", [rollbackProject],
      )).toMatchObject({ rows: [{ count: 0 }] });
      expect(await control.query(
        "SELECT count(*)::int AS count FROM app.snapshot_files sf JOIN app.snapshots s ON s.id=sf.snapshot_id WHERE s.project_id=$1",
        [rollbackProject],
      )).toMatchObject({ rows: [{ count: 0 }] });
      expect(await control.query(
        "SELECT count(*)::int AS count FROM app.snapshot_receipts WHERE project_id=$1 AND idempotency_key=$2",
        [rollbackProject, failedSnapshotKey],
      )).toMatchObject({ rows: [{ count: 0 }] });
      expect(await control.query(
        "SELECT count(*)::int AS count FROM app.project_file_audit WHERE project_id=$1 AND action='manual_snapshot_created'",
        [rollbackProject],
      )).toMatchObject({ rows: [{ count: 0 }] });
    } finally {
      await removeFailureTrigger();
    }
  });

  it("manual 快照容量剛好 16 MiB 可完整建立，超過即 507 且不部分保存", async () => {
    const capacityProject = await createProject(student);
    const content = "x".repeat(262_064);
    const hash = createHash("sha256").update(content, "utf8").digest("hex");
    await control.query(
      "INSERT INTO app.blobs(hash,bytes,content,created_at) VALUES($1,$2,convert_to($3,'UTF8'),now())",
      [hash, new TextEncoder().encode(content).byteLength, content],
    );
    const fileValues = Array.from({ length: 64 }, (_, index) =>
      `($1,'f${String(index + 1).padStart(3, "0")}.js',$2,262064,0,now(),now())`).join(",");
    await control.query(
      `INSERT INTO app.project_files(project_id,path,blob_hash,bytes,row_version,created_at,updated_at)
       VALUES ${fileValues}`,
      [capacityProject, hash],
    );
    const budget = await control.query(`
      SELECT sum(f.bytes::bigint + octet_length(f.path)::bigint + 64
        + length(f.bytes::text)::bigint + 3)::bigint AS bytes
      FROM app.project_files f WHERE f.project_id=$1
    `, [capacityProject]);
    expect(Number(budget.rows[0].bytes)).toBe(16_777_216);

    const exactSnapshot = await snapshot(student, randomUUID(), capacityProject);
    expect(exactSnapshot.status).toBe(201);
    const first = await exactSnapshot.json();
    expect(first.version_no).toBe(1);
    expect(await control.query(
      "SELECT count(*)::int AS count FROM app.snapshot_files WHERE snapshot_id=$1", [first.id],
    )).toMatchObject({ rows: [{ count: 64 }] });

    await control.query(`
      INSERT INTO app.project_files(project_id,path,blob_hash,bytes,row_version,created_at,updated_at)
      VALUES($1,'f065.js',$2,262064,0,now(),now())
    `, [capacityProject, hash]);
    const rejectedKey = randomUUID();
    const rejected = await snapshot(student, rejectedKey, capacityProject);
    expect(rejected.status).toBe(507);
    expect((await rejected.json()).code).toBe("storage_limit");
    expect(await control.query(
      "SELECT count(*)::int AS count FROM app.snapshots WHERE project_id=$1", [capacityProject],
    )).toMatchObject({ rows: [{ count: 1 }] });
    expect(await control.query(
      "SELECT count(*)::int AS count FROM app.snapshot_receipts WHERE project_id=$1 AND idempotency_key=$2",
      [capacityProject, rejectedKey],
    )).toMatchObject({ rows: [{ count: 0 }] });
    expect(await control.query(
      "SELECT count(*)::int AS count FROM app.project_file_audit WHERE project_id=$1 AND action='manual_snapshot_created'",
      [capacityProject],
    )).toMatchObject({ rows: [{ count: 1 }] });
  });

  it("他人、教師與管理員不能寫入學生檔案；教師僅能讀取有效綁定學生快照並留 audit", async () => {
    const forbiddenWrites = await Promise.all([otherStudent, teacher, admin].map((actor) =>
      put(actor, "staff.js", "不得寫入", { ifNoneMatch: "*" })));
    expect(forbiddenWrites.every((result) => result.status === 403 || result.status === 404)).toBe(true);

    const before = await control.query(
      "SELECT count(*)::int AS count FROM app.audit_events WHERE action='teacher_view'",
    );
    const read = await productProjectFileHandlers.teacherSnapshots(
      request(teacher, `/api/v1/teacher/students/${actors.student.id}/projects/${projectId}/snapshots`),
      { studentId: actors.student.id, projectId },
    );
    expect(read.status).toBe(200);
    const listed = await read.json();
    const snapshotId = listed.items[0].id as string;
    const manifest = await productProjectFileHandlers.teacherSnapshot(
      request(teacher, `/api/v1/teacher/students/${actors.student.id}/projects/${projectId}/snapshots/${snapshotId}/manifest`),
      { studentId: actors.student.id, projectId, snapshotId },
    );
    expect(manifest.status).toBe(200);
    const file = await productProjectFileHandlers.teacherSnapshotFile(
      request(teacher, `/api/v1/teacher/students/${actors.student.id}/projects/${projectId}/snapshots/${snapshotId}/files/index.html`),
      { studentId: actors.student.id, projectId, snapshotId, path: "index.html" },
    );
    expect(file.status).toBe(200);
    expect((await file.json()).content).toBe("<!doctype html>\r\n<h1>新版本</h1>\r\n");
    const crossStudent = await productProjectFileHandlers.teacherSnapshotFile(
      request(teacher, `/api/v1/teacher/students/${actors.otherStudent.id}/projects/${projectId}/snapshots/${snapshotId}/files/index.html`),
      { studentId: actors.otherStudent.id, projectId, snapshotId, path: "index.html" },
    );
    expect([403, 404]).toContain(crossStudent.status);
    const after = await control.query(
      "SELECT count(*)::int AS count FROM app.audit_events WHERE action='teacher_view'",
    );
    expect(after.rows[0].count).toBeGreaterThan(before.rows[0].count);

    await control.query("UPDATE app.teacher_student_bindings SET state='ended' WHERE id=$1", [actors.binding]);
    const revoked = await productProjectFileHandlers.teacherSnapshots(
      request(teacher, `/api/v1/teacher/students/${actors.student.id}/projects/${projectId}/snapshots`),
      { studentId: actors.student.id, projectId },
    );
    expect([403, 404]).toContain(revoked.status);
    const revokedContent = await productProjectFileHandlers.teacherSnapshotFile(
      request(teacher, `/api/v1/teacher/students/${actors.student.id}/projects/${projectId}/snapshots/${snapshotId}/files/index.html`),
      { studentId: actors.student.id, projectId, snapshotId, path: "index.html" },
    );
    expect([403, 404]).toContain(revokedContent.status);
  });

  it("路徑與 UTF-8 單檔上限於 handler／DB 拒絕，不寫入越界資料", async () => {
    const invalid = await productProjectFileHandlers.file(
      request(student, `/api/v1/projects/${projectId}/files/../escape.html`, "PUT", { content: "x" },
        { "idempotency-key": randomUUID(), "if-none-match": "*" }),
      { id: projectId, path: "../escape.html" },
    );
    expect(invalid.status).toBe(400);

    const underLimit = `${"a".repeat(262_132)}中文😀a`;
    expect(new TextEncoder().encode(underLimit).byteLength).toBe(262_143);
    const under = await put(student, "under-boundary.js", underLimit, { ifNoneMatch: "*" });
    expect(under.status).toBe(201);
    expect((await under.json()).bytes).toBe(262_143);
    const atLimit = `${"a".repeat(262_133)}中文😀a`;
    expect(new TextEncoder().encode(atLimit).byteLength).toBe(262_144);
    const accepted = await put(student, "boundary.js", atLimit, { ifNoneMatch: "*" });
    expect(accepted.status).toBe(201);
    expect((await accepted.json()).bytes).toBe(262_144);
    const overLimit = await put(student, "too-large.js", `${atLimit}a`, { ifNoneMatch: "*" });
    expect(overLimit.status).toBe(413);
    const absent = await control.query(
      "SELECT count(*)::int AS count FROM app.project_files WHERE project_id=$1 AND path='too-large.js'",
      [projectId],
    );
    expect(absent.rows[0].count).toBe(0);
  });
});
