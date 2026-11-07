import { randomUUID, createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { productProjectFileHandlers, productProjectHandlers } from "../../apps/web/src/server/product-handlers.ts";
import { closeServerDatabasePool, createDatabaseSession } from "../../apps/web/src/server/database-session.ts";
import { sessionCookieName } from "../../apps/web/src/server/auth-principal.ts";
import {
  createReviewActors,
} from "../support/specification-review-fixture.ts";
import {
  loginSyntheticAccount,
  openControlPool,
  type NativeAuthSession,
} from "../support/real-auth-fixture.ts";
import { projectFilePathSchema } from "../../packages/core/contracts/project-files.ts";
import { projectFilePathCases } from "../support/project-file-path-cases.ts";

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

function recordField(value: unknown, field: string): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value) || !(field in value)) return undefined;
  return Reflect.get(value, field);
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
    await control.query(await readFile(new URL("../../supabase/migrations/0042_project_file_path_case.sql", import.meta.url), "utf8"));
  } else if (process.env.APP_PLANET_TEST_MIGRATE_THROUGH === "0041") {
    projectId = await createProject(student);
    const upgradeProject = await createProject(student);
    const content = "合法 0041 資料保持原文 😀";
    const saved = await put(student, "nested/Legacy.html", content, { ifNoneMatch: "*" }, randomUUID(), upgradeProject);
    expect(saved.status).toBe(201);
    const created = await snapshot(student, randomUUID(), upgradeProject);
    expect(created.status).toBe(201);
    const snapshotId = (await created.json()).id as string;
    const beforeFiles = await control.query(`
      SELECT f.path,f.blob_hash,f.bytes,b.content
      FROM app.project_files f JOIN app.blobs b ON b.hash=f.blob_hash
      WHERE f.project_id=$1 ORDER BY f.path COLLATE "C"
    `, [upgradeProject]);
    const beforeSnapshots = await control.query(`
      SELECT s.id,s.version_no,s.content_hash,s.manifest,s.kind,s.immutable,
        sf.path,sf.blob_hash,sf.bytes,b.content
      FROM app.snapshots s JOIN app.snapshot_files sf ON sf.snapshot_id=s.id
      JOIN app.blobs b ON b.hash=sf.blob_hash
      WHERE s.project_id=$1 ORDER BY s.version_no,sf.path COLLATE "C"
    `, [upgradeProject]);
    await control.query(await readFile(new URL("../../supabase/migrations/0042_project_file_path_case.sql", import.meta.url), "utf8"));
    expect((await control.query(`
      SELECT f.path,f.blob_hash,f.bytes,b.content
      FROM app.project_files f JOIN app.blobs b ON b.hash=f.blob_hash
      WHERE f.project_id=$1 ORDER BY f.path COLLATE "C"
    `, [upgradeProject])).rows).toEqual(beforeFiles.rows);
    expect((await control.query(`
      SELECT s.id,s.version_no,s.content_hash,s.manifest,s.kind,s.immutable,
        sf.path,sf.blob_hash,sf.bytes,b.content
      FROM app.snapshots s JOIN app.snapshot_files sf ON sf.snapshot_id=s.id
      JOIN app.blobs b ON b.hash=sf.blob_hash
      WHERE s.project_id=$1 ORDER BY s.version_no,sf.path COLLATE "C"
    `, [upgradeProject])).rows).toEqual(beforeSnapshots.rows);
    const restored = await productProjectFileHandlers.snapshotFile(
      request(student, `/api/v1/projects/${upgradeProject}/snapshots/${snapshotId}/files/nested/Legacy.html`),
      { id: upgradeProject, snapshotId, path: "nested/Legacy.html" },
    );
    expect(await restored.json()).toMatchObject({ path: "nested/Legacy.html", content });
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
    const manifestBody = await manifest.json();
    expect(manifestBody.files.map((entry: { path: string }) => entry.path))
      .toEqual(["app.js", "cas.html", "index.html", "lost-response.js", "styles.css"]);
    const canonical = [...manifestBody.files]
      .sort((left: { path: string }, right: { path: string }) =>
        Buffer.compare(Buffer.from(left.path, "utf8"), Buffer.from(right.path, "utf8")))
      .map((entry: { path: string; hash: string; bytes: number }) =>
        `${entry.path}\u0000${entry.hash}\u0000${entry.bytes}\n`).join("");
    const independentlyCalculatedHash = createHash("sha256").update(canonical, "utf8").digest("hex");
    expect(first.content_hash).toBe(independentlyCalculatedHash);
    const persistedHash = await control.query(
      "SELECT content_hash FROM app.snapshots WHERE id=$1 AND project_id=$2", [first.id, projectId],
    );
    expect(persistedHash.rows[0]?.content_hash).toBe(independentlyCalculatedHash);
    const refs = await control.query(`
      SELECT sf.path,sf.blob_hash,sf.bytes,octet_length(b.content)::int AS actual_bytes,
        convert_from(b.content,'UTF8') AS content
      FROM app.snapshot_files sf JOIN app.blobs b ON b.hash=sf.blob_hash
      WHERE sf.snapshot_id=$1 ORDER BY sf.path COLLATE "C"
    `, [first.id]);
    expect(refs.rows.map((row) => ({ path: row.path, hash: row.blob_hash, bytes: row.bytes })))
      .toEqual(manifestBody.files.map((entry: { path: string; hash: string; bytes: number }) =>
        ({ path: entry.path, hash: entry.hash, bytes: entry.bytes })));
    expect(refs.rows.every((row) => row.actual_bytes === row.bytes &&
      new TextEncoder().encode(row.content).byteLength === row.bytes)).toBe(true);
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

  // §108 F-08：所有操作與斷言都指向同一 rollbackProject，並以完整、穩定排序的資料快照比較。
  async function rollbackState(targetProjectId: string) {
    const rows = async (sql: string) => (await control.query(sql, [targetProjectId])).rows;
    return {
      project: await rows("SELECT to_jsonb(p) AS row FROM app.projects p WHERE p.id=$1"),
      files: await rows(`SELECT to_jsonb(f) AS row FROM app.project_files f
        WHERE f.project_id=$1 ORDER BY f.path COLLATE "C"`),
      blobs: await rows(`SELECT b.hash,b.bytes,encode(b.content,'hex') AS content_hex,b.created_at
        FROM app.blobs b WHERE b.hash IN (
          SELECT blob_hash FROM app.project_files WHERE project_id=$1
          UNION SELECT blob_hash FROM app.snapshot_files WHERE project_id=$1)
        ORDER BY b.hash COLLATE "C"`),
      fileReceipts: await rows(`SELECT to_jsonb(r) AS row FROM app.project_file_receipts r
        WHERE r.project_id=$1 ORDER BY r.idempotency_key`),
      snapshots: await rows(`SELECT to_jsonb(s) AS row FROM app.snapshots s
        WHERE s.project_id=$1 ORDER BY s.version_no,s.id`),
      snapshotFiles: await rows(`SELECT to_jsonb(sf) AS row FROM app.snapshot_files sf
        WHERE sf.project_id=$1 ORDER BY sf.snapshot_id,sf.path COLLATE "C"`),
      snapshotReceipts: await rows(`SELECT to_jsonb(r) AS row FROM app.snapshot_receipts r
        WHERE r.project_id=$1 ORDER BY r.idempotency_key`),
      audit: await rows(`SELECT to_jsonb(a) AS row FROM app.project_file_audit a
        WHERE a.project_id=$1 ORDER BY a.at,a.id`),
    };
  }
  const blobCount = async (hash: string) => (await control.query(
    "SELECT count(*)::int AS count FROM app.blobs WHERE hash=$1", [hash])).rows[0]?.count;
  const createAuditFailure = async () => {
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
  const removeAuditFailure = async () => {
    await control.query("DROP TRIGGER IF EXISTS test_reject_project_file_audit ON app.project_file_audit");
    await control.query("DROP FUNCTION IF EXISTS app.test_reject_project_file_audit()");
  };
  const sha = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

  it("保存稽核故障：非空既有檔 CAS 更新與新增檔都整筆 rollback，撤除後可正常保存", async () => {
    const rollbackProject = await createProject(student);
    const original = `<!doctype html>\r\n<h1>rollback 基準 ${rollbackProject} 😀</h1>\r\n`;
    const baselineKey = randomUUID();
    const baseline = await put(student, "index.html", original, { ifNoneMatch: "*" }, baselineKey, rollbackProject);
    expect(baseline.status).toBe(201);
    const baselineBody = await baseline.json();
    expect(baselineBody).toMatchObject({ path: "index.html", hash: sha(original), bytes: Buffer.byteLength(original) });
    const before = await rollbackState(rollbackProject);
    expect(before.files).toHaveLength(1);
    expect(before.files[0]?.row).toMatchObject({ path: "index.html", blob_hash: sha(original), bytes: Buffer.byteLength(original) });
    expect(before.blobs).toEqual([expect.objectContaining({
      hash: sha(original), content_hex: Buffer.from(original, "utf8").toString("hex"),
    })]);
    expect(before.fileReceipts.map((entry) => entry.row))
      .toEqual([expect.objectContaining({ idempotency_key: baselineKey, response: expect.anything() })]);
    expect(before.audit.map((entry) => entry.row))
      .toEqual([expect.objectContaining({ action: "file_created", content_hash: sha(original) })]);

    const updatedContent = `<!doctype html>\r\n<h1>故障中不得保存 ${rollbackProject}</h1>\r\n`;
    const addedContent = `/* 新增檔也不得保存 ${rollbackProject} */`;
    const failedUpdateKey = randomUUID();
    const failedCreateKey = randomUUID();
    await createAuditFailure();
    try {
      const failedUpdate = await put(student, "index.html", updatedContent,
        { ifMatch: sha(original) }, failedUpdateKey, rollbackProject);
      expect(failedUpdate.status).toBe(503);
      const failedCreate = await put(student, "added.js", addedContent,
        { ifNoneMatch: "*" }, failedCreateKey, rollbackProject);
      expect(failedCreate.status).toBe(503);
    } finally {
      await removeAuditFailure();
    }
    expect(await rollbackState(rollbackProject)).toEqual(before);
    expect(await blobCount(sha(updatedContent))).toBe(0);
    expect(await blobCount(sha(addedContent))).toBe(0);
    const read = await productProjectFileHandlers.file(
      request(student, `/api/v1/projects/${rollbackProject}/files/index.html`),
      { id: rollbackProject, path: "index.html" },
    );
    expect(await read.json()).toMatchObject({ content: original, hash: sha(original) });

    const recovered = await put(student, "index.html", updatedContent,
      { ifMatch: sha(original) }, randomUUID(), rollbackProject);
    expect(recovered.status).toBe(200);
    expect(await recovered.json()).toMatchObject({ hash: sha(updatedContent) });
    const after = await rollbackState(rollbackProject);
    expect(after.files[0]?.row).toMatchObject({ blob_hash: sha(updatedContent),
      row_version: (before.files[0]?.row as { row_version: number }).row_version + 1 });
    expect(after.audit.map((entry) => (entry.row as { action: string }).action))
      .toEqual(["file_created", "file_updated"]);
  });

  it("快照稽核故障：既有 manual 快照、引用、blob、receipt、audit 與已保存檔案逐項不變", async () => {
    const rollbackProject = await createProject(student);
    const v1Content = `body { content: "快照 v1 ${rollbackProject}"; }\r\n`;
    expect((await put(student, "styles.css", v1Content, { ifNoneMatch: "*" }, randomUUID(), rollbackProject)).status)
      .toBe(201);
    expect((await put(student, "app.js", "const 保留 = true;\r\n", { ifNoneMatch: "*" }, randomUUID(), rollbackProject))
      .status).toBe(201);
    const v1Key = randomUUID();
    const v1Response = await snapshot(student, v1Key, rollbackProject);
    expect(v1Response.status).toBe(201);
    const v1 = await v1Response.json();
    const v2Content = `body { content: "已保存但快照失敗 ${rollbackProject}"; }\r\n`;
    expect((await put(student, "styles.css", v2Content, { ifMatch: sha(v1Content) }, randomUUID(), rollbackProject))
      .status).toBe(200);
    const before = await rollbackState(rollbackProject);
    expect(before.snapshots.map((entry) => entry.row))
      .toEqual([expect.objectContaining({ id: v1.id, version_no: 1, content_hash: v1.content_hash })]);
    expect(before.snapshotFiles.map((entry) => (entry.row as { path: string }).path)).toEqual(["app.js", "styles.css"]);
    expect(before.snapshotFiles.find((entry) => (entry.row as { path: string }).path === "styles.css")?.row)
      .toMatchObject({ blob_hash: sha(v1Content) });
    expect(before.snapshotReceipts.map((entry) => entry.row))
      .toEqual([expect.objectContaining({ idempotency_key: v1Key, response: expect.anything() })]);
    expect(before.audit.filter((entry) => (entry.row as { action: string }).action === "manual_snapshot_created"))
      .toHaveLength(1);
    expect(before.blobs.map((entry) => entry.hash)).toEqual(expect.arrayContaining([sha(v1Content), sha(v2Content)]));

    const failedKey = randomUUID();
    await createAuditFailure();
    try {
      const failed = await snapshot(student, failedKey, rollbackProject);
      expect(failed.status).toBe(503);
    } finally {
      await removeAuditFailure();
    }
    const after = await rollbackState(rollbackProject);
    expect(after).toEqual(before);
    expect(after.snapshotReceipts.some((entry) => (entry.row as { idempotency_key: string }).idempotency_key === failedKey))
      .toBe(false);
    const oldFile = await productProjectFileHandlers.snapshotFile(
      request(student, `/api/v1/projects/${rollbackProject}/snapshots/${v1.id}/files/styles.css`),
      { id: rollbackProject, snapshotId: v1.id, path: "styles.css" },
    );
    expect(await oldFile.json()).toMatchObject({ content: v1Content, hash: sha(v1Content) });

    const recovered = await snapshot(student, randomUUID(), rollbackProject);
    expect(recovered.status).toBe(201);
    expect(await recovered.json()).toMatchObject({ version_no: 2 });
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

    const auditBeforeFailure = after.rows[0].count;
    await control.query(`
      CREATE FUNCTION app.test_reject_teacher_view_audit() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.action='teacher_view' THEN RAISE EXCEPTION 'synthetic_teacher_view_audit_failure'; END IF;
        RETURN NEW;
      END
      $$
    `);
    await control.query(`
      CREATE TRIGGER test_reject_teacher_view_audit
      BEFORE INSERT ON app.audit_events
      FOR EACH ROW EXECUTE FUNCTION app.test_reject_teacher_view_audit()
    `);
    try {
      const failedReads = await Promise.all([
        productProjectFileHandlers.teacherSnapshots(
          request(teacher, `/api/v1/teacher/students/${actors.student.id}/projects/${projectId}/snapshots`),
          { studentId: actors.student.id, projectId },
        ),
        productProjectFileHandlers.teacherSnapshot(
          request(teacher, `/api/v1/teacher/students/${actors.student.id}/projects/${projectId}/snapshots/${snapshotId}/manifest`),
          { studentId: actors.student.id, projectId, snapshotId },
        ),
        productProjectFileHandlers.teacherSnapshotFile(
          request(teacher, `/api/v1/teacher/students/${actors.student.id}/projects/${projectId}/snapshots/${snapshotId}/files/index.html`),
          { studentId: actors.student.id, projectId, snapshotId, path: "index.html" },
        ),
      ]);
      for (const failedRead of failedReads) {
        expect(failedRead.status).toBe(503);
        expect(await failedRead.text()).not.toContain("<h1>新版本</h1>");
      }
      const afterAuditFailure = await control.query(
        "SELECT count(*)::int AS count FROM app.audit_events WHERE action='teacher_view'",
      );
      expect(afterAuditFailure.rows[0]?.count).toBe(auditBeforeFailure);
    } finally {
      await control.query("DROP TRIGGER IF EXISTS test_reject_teacher_view_audit ON app.audit_events");
      await control.query("DROP FUNCTION IF EXISTS app.test_reject_teacher_view_audit()");
    }

    let releaseReader!: () => void;
    let readerReady!: () => void;
    const readerRelease = new Promise<void>((resolve) => { releaseReader = resolve; });
    const readerAcquired = new Promise<void>((resolve) => { readerReady = resolve; });
    let readerPid = 0;
    let readerResult: unknown;
    let readerFailure: unknown;
    const reader = createDatabaseSession(actors.teacher.id).write.runTransaction(async (query) => {
      const identity = await query.query("SELECT pg_backend_pid() AS pid");
      readerPid = Number(recordField(identity.rows[0], "pid"));
      const result = await query.query(
        "SELECT app.read_teacher_project_snapshots($1::uuid,$2::uuid,NULL,NULL,20,NULL,NULL) AS result",
        [actors.student.id, projectId],
      );
      readerResult = recordField(result.rows[0], "result");
      readerReady();
      await readerRelease;
    });
    void reader.catch((error: unknown) => {
      readerFailure = error;
      readerReady();
    });
    const revokeClient = await control.connect();
    let revokePid = 0;
    let revokeStarted = false;
    let revokeCompleted = false;
    let revocation: Promise<void> | null = null;
    let revokeFailure: unknown;
    try {
      await readerAcquired;
      if (readerFailure) throw readerFailure;
      await revokeClient.query("BEGIN");
      const revokeIdentity = await revokeClient.query("SELECT pg_backend_pid() AS pid");
      revokePid = Number(revokeIdentity.rows[0]?.pid);
      revokeStarted = true;
      revocation = revokeClient.query(
        "UPDATE app.teacher_student_bindings SET state='ended' WHERE id=$1", [actors.binding],
      ).then(() => { revokeCompleted = true; }, (error: unknown) => { revokeFailure = error; });
      let blockedByReader = false;
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline && !blockedByReader) {
        const blocking = await control.query(
          "SELECT pg_blocking_pids($1::integer) AS blockers", [revokePid],
        );
        blockedByReader = (blocking.rows[0]?.blockers as number[] | undefined)?.includes(readerPid) ?? false;
        if (!blockedByReader) await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(blockedByReader).toBe(true);
      expect(revokeCompleted).toBe(false);
      releaseReader();
      await reader;
      await revocation;
      if (revokeFailure) throw revokeFailure;
      await revokeClient.query("COMMIT");
      revokeStarted = false;
    } finally {
      releaseReader();
      await revocation;
      if (revokeStarted) await revokeClient.query("ROLLBACK");
      revokeClient.release();
    }
    expect(readerResult).toMatchObject({ outcome: "found" });
    const auditsBeforeDeniedReads = await control.query(
      "SELECT count(*)::int AS count FROM app.audit_events WHERE action='teacher_view'",
    );
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
    expect(await revokedContent.text()).not.toContain("<h1>新版本</h1>");
    const revokedManifest = await productProjectFileHandlers.teacherSnapshot(
      request(teacher, `/api/v1/teacher/students/${actors.student.id}/projects/${projectId}/snapshots/${snapshotId}/manifest`),
      { studentId: actors.student.id, projectId, snapshotId },
    );
    expect([403, 404]).toContain(revokedManifest.status);
    expect(await revokedManifest.text()).not.toContain("<h1>新版本</h1>");
    const auditsAfterDeniedReads = await control.query(
      "SELECT count(*)::int AS count FROM app.audit_events WHERE action='teacher_view'",
    );
    expect(auditsAfterDeniedReads.rows[0]?.count).toBe(auditsBeforeDeniedReads.rows[0]?.count);
  });

  // §108：反向鎖序。正式收權交易先持有 binding 列鎖且未提交，教師 reader 必須在 PostgreSQL 鎖上等待，
  // 收權 COMMIT 後該等待中的讀取必須拒絕；不以「收權提交後才發新請求」替代。
  it.each(["list", "manifest", "file"] as const)(
    "撤權先行 barrier（%s）：等待中的教師讀取在收權提交後拒絕且不留 teacher_view",
    async (kind) => {
      const bindingId = randomUUID();
      await control.query(`INSERT INTO app.teacher_student_bindings(id,teacher_id,student_id,state,created_by_aid,created_at)
        VALUES($1,$2,$3,'active',$4,now())`, [bindingId, actors.teacher.id, actors.student.id, randomUUID()]);
      const snapshotRow = await control.query(
        "SELECT id FROM app.snapshots WHERE project_id=$1 ORDER BY version_no DESC LIMIT 1", [projectId],
      );
      const snapshotId = snapshotRow.rows[0]?.id as string;
      const base = `/api/v1/teacher/students/${actors.student.id}/projects/${projectId}/snapshots`;
      const readOnce = () => kind === "list"
        ? productProjectFileHandlers.teacherSnapshots(request(teacher, base),
          { studentId: actors.student.id, projectId })
        : kind === "manifest"
          ? productProjectFileHandlers.teacherSnapshot(request(teacher, `${base}/${snapshotId}/manifest`),
            { studentId: actors.student.id, projectId, snapshotId })
          : productProjectFileHandlers.teacherSnapshotFile(request(teacher, `${base}/${snapshotId}/files/index.html`),
            { studentId: actors.student.id, projectId, snapshotId, path: "index.html" });
      const eligible = await readOnce();
      expect(eligible.status).toBe(200);
      expect(await eligible.text()).toContain(kind === "file" ? "<h1>新版本</h1>" : snapshotId);

      const teacherViews = async () => (await control.query(
        "SELECT count(*)::int AS count FROM app.audit_events WHERE action='teacher_view'",
      )).rows[0]?.count as number;
      const studentBefore = await rollbackState(projectId);
      const auditBefore = await teacherViews();
      const revokeClient = await control.connect();
      let open = false;
      let reader: Promise<Response> | null = null;
      try {
        await revokeClient.query("BEGIN");
        open = true;
        await revokeClient.query("SET LOCAL ROLE authenticated");
        await revokeClient.query(
          "SELECT set_config('request.jwt.claim.sub',$1,true),set_config('request.jwt.claims',$2,true)",
          [actors.admin.id, JSON.stringify({ sub: actors.admin.id })],
        );
        const revokePid = Number((await revokeClient.query("SELECT pg_backend_pid() AS pid")).rows[0]?.pid);
        const ended = await revokeClient.query(
          "SELECT app.end_teacher_student_binding($1::uuid,$2::text,$3::uuid) AS result",
          [bindingId, "合成解除理由", randomUUID()],
        );
        expect(ended.rows[0]?.result).toMatchObject({ outcome: "ended", binding_id: bindingId });

        reader = readOnce();
        let readerPid: number | null = null;
        const deadline = Date.now() + 5_000;
        while (readerPid === null && Date.now() < deadline) {
          const waiting = await control.query(`SELECT pid FROM pg_stat_activity
            WHERE wait_event_type='Lock' AND $1::integer=ANY(pg_blocking_pids(pid))
              AND query LIKE '%read_teacher_project_snapshots%'`, [revokePid]);
          readerPid = waiting.rowCount === 1 ? Number(waiting.rows[0]?.pid) : null;
          if (readerPid === null) await new Promise((resolve) => setTimeout(resolve, 20));
        }
        expect(readerPid, "reader 必須正在等待未提交的正式收權交易").not.toBeNull();
        const blockers = await control.query("SELECT pg_blocking_pids($1::integer) AS blockers", [readerPid]);
        expect(blockers.rows[0]?.blockers).toEqual([revokePid]);
        let settled = false;
        void reader.then(() => { settled = true; }, () => { settled = true; });
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(settled).toBe(false);

        await revokeClient.query("COMMIT");
        open = false;
      } finally {
        if (open) await revokeClient.query("ROLLBACK");
        revokeClient.release();
      }
      const denied = await reader!;
      expect([403, 404]).toContain(denied.status);
      const deniedBody = await denied.text();
      expect(deniedBody).not.toContain("<h1>新版本</h1>");
      const deniedJson = JSON.parse(deniedBody) as Record<string, unknown>;
      for (const protectedField of ["items", "files", "snapshot", "content", "hash", "next_cursor"]) {
        expect(deniedJson).not.toHaveProperty(protectedField);
      }
      expect(await teacherViews()).toBe(auditBefore);
      expect((await control.query(
        "SELECT state,end_reason FROM app.teacher_student_bindings WHERE id=$1", [bindingId],
      )).rows[0]).toEqual({ state: "ended", end_reason: "合成解除理由" });
      expect(await rollbackState(projectId)).toEqual(studentBefore);
    },
  );

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

  it("schema、HTTP handler 與受限 authenticated DB invocation 對保留名大小寫使用相同路徑規則", async () => {
    const pathProject = await createProject(student);
    const dbProject = await createProject(student);
    const session = createDatabaseSession(student.userId);
    for (const { path, current: valid } of projectFilePathCases) {
      expect(projectFilePathSchema.safeParse(path).success, path.slice(0, 40)).toBe(valid);
      // canonical 函式不授權 authenticated；規則以 owner 連線核對，受限呼叫走正式 write_project_file。
      const rule = await control.query("SELECT app.canonical_project_file_path($1) AS valid", [path]);
      expect(rule.rows[0]?.valid, path.slice(0, 40)).toBe(valid);
      const restricted = await session.write.runTransaction((query) => query.query(
        "SELECT current_user,app.write_project_file($1::uuid,$2::text,'x',NULL,'*',$3::uuid,false) AS result",
        [dbProject, path, randomUUID()],
      ));
      expect(restricted.rows[0], path.slice(0, 40)).toMatchObject({
        current_user: "authenticated",
        result: valid ? { outcome: "saved", created: true } : { outcome: "invalid_input" },
      });
      const route = await productProjectFileHandlers.file(
        request(student, `/api/v1/projects/${pathProject}/files/${path}`, "PUT", { content: "x" },
          { "idempotency-key": randomUUID(), "if-none-match": "*" }),
        { id: pathProject, path },
      );
      expect(route.status, path.slice(0, 40)).toBe(valid ? 201 : 400);
      if (!valid) {
        expect(await route.json()).toMatchObject({ code: "invalid_request", status: 400 });
      }
    }
    const expected = projectFilePathCases.filter((entry) => entry.current).map((entry) => entry.path)
      .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
    for (const target of [pathProject, dbProject]) {
      const stored = await control.query(
        "SELECT path FROM app.project_files WHERE project_id=$1 ORDER BY path COLLATE \"C\"", [target],
      );
      expect(stored.rows.map((row) => row.path)).toEqual(expected);
    }
  });

  it("超過一頁的 manual 快照 keyset 分頁無遺漏、無重複且排序穩定", async () => {
    const pagedProject = await createProject(student);
    const saved = await put(student, "index.html", "跨頁版本", { ifNoneMatch: "*" }, randomUUID(), pagedProject);
    expect(saved.status).toBe(201);
    for (let index = 0; index < 21; index++) {
      expect((await snapshot(student, randomUUID(), pagedProject)).status).toBe(201);
    }
    const pages: Array<{ items: Array<{ id: string; version_no: number }>; next_cursor: string | null }> = [];
    let cursor: string | null = null;
    do {
      const query = new URLSearchParams({ limit: "20" });
      if (cursor) query.set("cursor", cursor);
      const page = await productProjectFileHandlers.snapshots(
        request(student, `/api/v1/projects/${pagedProject}/snapshots?${query}`), { id: pagedProject },
      );
      expect(page.status).toBe(200);
      const parsed = await page.json();
      pages.push(parsed);
      cursor = parsed.next_cursor;
    } while (cursor);
    const all = pages.flatMap((page) => page.items);
    expect(pages.map((page) => page.items.length)).toEqual([20, 1]);
    expect(new Set(all.map((item) => item.id)).size).toBe(21);
    expect(all.map((item) => item.version_no)).toEqual(
      [...all.map((item) => item.version_no)].sort((left, right) => right - left),
    );
    expect(all.map((item) => item.version_no)).toEqual(Array.from({ length: 21 }, (_, index) => 21 - index));
  });
});
