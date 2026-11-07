import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { productProjectFileHandlers, productProjectHandlers } from "../../apps/web/src/server/product-handlers.ts";
import { closeServerDatabasePool, createDatabaseSession } from "../../apps/web/src/server/database-session.ts";
import { sessionCookieName } from "../../apps/web/src/server/auth-principal.ts";
import { createReviewActors } from "../support/specification-review-fixture.ts";
import { loginSyntheticAccount, openControlPool, type NativeAuthSession } from "../support/real-auth-fixture.ts";
import { projectFilePathSchema } from "../../packages/core/contracts/project-files.ts";
import { legacyOnlyPathCases, projectFilePathCases } from "../support/project-file-path-cases.ts";

// readiness §108 F-06：在 0041 實際舊規則下建立歷史路徑，0042 必須整筆阻擋且不揭露路徑或學生資料。
const origin = process.env.APP_PLANET_APP_ORIGIN!;
let control: Pool;
let actors: Awaited<ReturnType<typeof createReviewActors>>;
let student: NativeAuthSession;

function request(path: string, method = "GET", body?: unknown, headers: Record<string, string> = {}) {
  return new Request(`${origin}${path}`, {
    method,
    headers: {
      cookie: `${sessionCookieName}=${student.accessToken}`,
      origin,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function databaseState() {
  const rows = async (sql: string) => (await control.query(sql)).rows;
  const constraints = await rows(`
    SELECT c.conrelid::regclass::text AS relation,c.conname,c.convalidated,pg_get_constraintdef(c.oid) AS definition
    FROM pg_constraint c
    WHERE c.conrelid IN ('app.project_files'::regclass,'app.snapshot_files'::regclass)
    ORDER BY 1,2`);
  const migrationTable = await rows("SELECT to_regclass('supabase_migrations.schema_migrations')::text AS name");
  return {
    canonicalFunction: (await rows(
      "SELECT pg_get_functiondef('app.canonical_project_file_path(text)'::regprocedure) AS definition",
    ))[0].definition as string,
    constraints,
    migrations: migrationTable[0].name
      ? await rows("SELECT version FROM supabase_migrations.schema_migrations ORDER BY version")
      : null,
    projects: await rows("SELECT to_jsonb(t) AS row FROM app.projects t ORDER BY id"),
    blobs: await rows("SELECT hash,bytes,encode(content,'hex') AS content FROM app.blobs ORDER BY hash"),
    projectFiles: await rows("SELECT to_jsonb(t) AS row FROM app.project_files t ORDER BY project_id,path COLLATE \"C\""),
    fileReceipts: await rows("SELECT to_jsonb(t) AS row FROM app.project_file_receipts t ORDER BY to_jsonb(t)::text"),
    snapshots: await rows("SELECT to_jsonb(t) AS row FROM app.snapshots t ORDER BY id"),
    snapshotFiles: await rows("SELECT to_jsonb(t) AS row FROM app.snapshot_files t ORDER BY snapshot_id,path COLLATE \"C\""),
    snapshotReceipts: await rows("SELECT to_jsonb(t) AS row FROM app.snapshot_receipts t ORDER BY to_jsonb(t)::text"),
    audit: await rows("SELECT to_jsonb(t) AS row FROM app.project_file_audit t ORDER BY to_jsonb(t)::text"),
  };
}

beforeAll(async () => {
  if (process.env.APP_PLANET_ENV !== "isolated-local-test" ||
      process.env.APP_PLANET_TEST_MIGRATE_THROUGH !== "0041" ||
      process.env.APP_PLANET_TEST_ILLEGAL_PATH_HISTORY !== "1") throw Error("isolated 0041 illegal-history runner required");
  control = openControlPool();
  actors = await createReviewActors(control);
  student = await loginSyntheticAccount(actors.student);
});

afterAll(async () => {
  if (!control) return;
  await closeServerDatabasePool();
  await control.end();
});

describe("F-06 0041→0042 歷史非法路徑升級阻擋", () => {
  it("0041 舊規則接受的大小寫保留名歷史資料使 0042 整筆失敗，只揭露數量且無部分套用", async () => {
    const legacyDefinition = (await control.query(
      "SELECT pg_get_functiondef('app.canonical_project_file_path(text)'::regprocedure) AS definition",
    )).rows[0].definition as string;
    expect(legacyDefinition).not.toContain("upper(");
    const created = await productProjectHandlers.create(request("/api/v1/projects", "POST",
      { title: "歷史路徑升級阻擋" }, { "idempotency-key": randomUUID() }));
    expect(created.status).toBe(201);
    const projectId = (await created.json()).id as string;
    const legal = await productProjectFileHandlers.file(
      request(`/api/v1/projects/${projectId}/files/index.html`, "PUT", { content: "合法 0041 內容 😀" },
        { "idempotency-key": randomUUID(), "if-none-match": "*" }),
      { id: projectId, path: "index.html" },
    );
    expect(legal.status).toBe(201);

    const session = createDatabaseSession(student.userId);
    expect(legacyOnlyPathCases.length).toBeGreaterThanOrEqual(7);
    // canonical 函式依 0041 授權不開放 authenticated；規則本身以 owner 連線核對，受限呼叫走正式 write_project_file。
    const dbProject = (await (await productProjectHandlers.create(request("/api/v1/projects", "POST",
      { title: "歷史路徑受限呼叫" }, { "idempotency-key": randomUUID() }))).json()).id as string;
    for (const entry of projectFilePathCases) {
      const legacy = await control.query("SELECT app.canonical_project_file_path($1) AS valid", [entry.path]);
      expect(legacy.rows[0]?.valid, `${entry.note}:${entry.path.slice(0, 40)}`).toBe(entry.legacy0041);
      expect(projectFilePathSchema.safeParse(entry.path).success).toBe(entry.current);
      if (entry.legacy0041 && entry.current) continue;
      const restricted = await session.write.runTransaction((query) => query.query(
        "SELECT current_user,app.write_project_file($1::uuid,$2::text,'x',NULL,'*',$3::uuid,false) AS result",
        [dbProject, entry.path, randomUUID()],
      ));
      expect(restricted.rows[0]).toMatchObject({
        current_user: "authenticated",
        result: entry.legacy0041 ? { outcome: "saved", created: true } : { outcome: "invalid_input" },
      });
    }
    for (const entry of legacyOnlyPathCases) {
      const http = await productProjectFileHandlers.file(
        request(`/api/v1/projects/${projectId}/files/${entry.path}`, "PUT", { content: "x" },
          { "idempotency-key": randomUUID(), "if-none-match": "*" }),
        { id: projectId, path: entry.path },
      );
      expect(http.status).toBe(400);
      const direct = await session.write.runTransaction((query) => query.query(
        "SELECT app.write_project_file($1::uuid,$2::text,$3::text,NULL,'*',$4::uuid,false) AS result",
        [projectId, entry.path, `/* ${entry.note} */`, randomUUID()],
      ));
      expect(direct.rows[0]).toMatchObject({ result: { outcome: "saved", created: true } });
    }
    const snapshot = await session.write.runTransaction((query) => query.query(
      "SELECT app.create_manual_project_snapshot($1::uuid,NULL,$2::uuid,false) AS result", [projectId, randomUUID()],
    ));
    expect(snapshot.rows[0]).toMatchObject({ result: { outcome: "created" } });
    const legacyPaths = legacyOnlyPathCases.map((entry) => entry.path);
    const referenced = await control.query(`
      SELECT (SELECT count(*)::int FROM app.project_files WHERE project_id=$1 AND path=ANY($2)) AS files,
        (SELECT count(*)::int FROM app.snapshot_files sf JOIN app.snapshots s ON s.id=sf.snapshot_id
          WHERE s.project_id=$1 AND sf.path=ANY($2)) AS snapshot_files
    `, [projectId, legacyPaths]);
    expect(referenced.rows[0]).toEqual({ files: legacyPaths.length, snapshot_files: legacyPaths.length });

    const before = await databaseState();
    const migration = await readFile(new URL("../../supabase/migrations/0042_project_file_path_case.sql", import.meta.url), "utf8");
    const client = await control.connect();
    let failure: Record<string, unknown> | undefined;
    try {
      try {
        await client.query(migration);
      } catch (error) {
        failure = error as Record<string, unknown>;
      }
      await client.query("ROLLBACK");
      expect((await client.query("SELECT txid_current_if_assigned() AS txid")).rows[0].txid).toBeNull();
    } finally {
      client.release();
    }
    expect(failure).toBeDefined();
    const exposed = ["message", "detail", "hint", "where", "internalQuery"]
      .map((field) => String(failure?.[field] ?? "")).join("\n");
    expect(failure?.message).toBe(
      `0042 migration blocked: ${legacyPaths.length * 2} project file paths and ${legacyPaths.length} snapshot file paths violate canonical rules`,
    );
    for (const path of legacyPaths) expect(exposed).not.toContain(path);
    for (const sensitive of [projectId, dbProject, student.userId, actors.student.email, "Aux", "Prn"]) {
      expect(exposed).not.toContain(sensitive);
    }

    const after = await databaseState();
    expect(after).toEqual(before);
    expect(after.canonicalFunction).toBe(legacyDefinition);
    const stillLegacy = await control.query("SELECT app.canonical_project_file_path('con.js') AS valid");
    expect(stillLegacy.rows[0].valid).toBe(true);
  });
});
