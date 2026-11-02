import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  authorizeCapability, authorizeTeacherRelationship, type AuthorizationContext,
} from "../../apps/web/src/server/authorization.ts";
import {
  listOwnedProjectsSubset,
  listOwnedProjectsWithClassificationSubset,
  readOwnedProjectSubset,
  readOwnedProjectWithClassificationSubset,
} from "../../apps/web/src/server/projects.ts";
import { inspectConnection, localPools, syntheticContext } from "./authorization-context.ts";

const { control, authorization, parallelAuthorization } = localPools();
const account = (n: number) => `51000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const school = (n: number) => `52000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const projectId = (n: number) => `61000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const migrationProjectId = (n: number) => `79000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const migrationOwner = "78000000-0000-4000-8000-000000000001";
const migrationPeers = [
  "78000000-0000-4000-8000-000000000002",
  "78000000-0000-4000-8000-000000000003",
];
const context = (n: number) => syntheticContext(authorization, account(n));
const list = (n: number, bound = 10) => listOwnedProjectsSubset(context(n), bound);
const read = (n: number, p = 1) => readOwnedProjectSubset(context(n), projectId(p));
const notFound = { outcome: "not_found" };
const denied = { outcome: "denied", reason: "policy_denied" };
const expected = (n: number) => ({
  id: projectId(n), title: `synthetic-project-${n}`, tier: n % 2 ? "A" : "B",
  needs_visitor_identity: n % 2 === 0, stage: "Specification",
  created_at: "2026-10-23T00:00:00.123456Z", row_version: n % 2 ? 0 : -1,
});

beforeAll(async () => {
  await control.query(`
    INSERT INTO app.schools(id,label,approval_state,approval_epoch,created_at,updated_at)
    VALUES ($1,'synthetic-project-school-a','approved',1,now(),now()),
           ($2,'synthetic-project-school-b','approved',1,now(),now())
  `, [school(1), school(2)]);
  for (const n of [1, 2, 3, 4, 5, 6]) {
    await control.query("INSERT INTO auth.users(id) VALUES ($1)", [account(n)]);
    await control.query(`
      INSERT INTO app.profiles(id,role,status,deletion_state,school_id,display_label,status_changed_at)
      VALUES ($1,$2,'approved','none',$3,'synthetic-project-actor',now())
    `, [account(n), n === 4 ? "teacher" : n === 5 ? "admin" : "student",
      n === 2 ? school(2) : school(1)]);
  }
  await control.query(`
    INSERT INTO app.teacher_student_bindings(id,teacher_id,student_id,state,created_by_aid,created_at)
    VALUES ('53000000-0000-4000-8000-000000000001',$1,$2,'active',
      '54000000-0000-4000-8000-000000000001',now())
  `, [account(4), account(1)]);
  for (let n = 1; n <= 10; n++) {
    const dto = expected(n);
    await control.query(`
      INSERT INTO app.projects(
        id,owner_id,title,tier,needs_visitor_identity,requested_tier,classification_state,
        stage,created_at,row_version
      )
      VALUES ($1,$2,$3,$4,$5,NULL,'legacy_unverified',$6,$7,$8)
    `, [dto.id, account(Math.ceil(n / 2)), dto.title, dto.tier,
      dto.needs_visitor_identity, dto.stage, dto.created_at, dto.row_version]);
  }
});

afterEach(async () => {
  await control.query("UPDATE app.profiles SET status='approved',deletion_state='none' WHERE id=$1", [account(1)]);
  await control.query("UPDATE app.schools SET approval_state='approved' WHERE id=$1", [school(1)]);
});
afterAll(async () => { await Promise.all([control.end(), authorization.end(), parallelAuthorization.end()]); });

describe("T051 應用程式 → 真實 PostgreSQL projects／RLS", () => {
  it("0009→0010 歷史列保留舊 DTO；新 DTO 明確標示 legacy_unverified 並維持同校／跨校隔離", async () => {
    expect(await readOwnedProjectSubset(
      syntheticContext(authorization, migrationOwner),
      migrationProjectId(1),
    )).toEqual({
      outcome: "found",
      project: {
        id: migrationProjectId(1),
        title: "synthetic-migration-A-visitor-true-negative",
        tier: "A",
        needs_visitor_identity: true,
        stage: "點子",
        created_at: "2026-10-01T01:02:03.000001Z",
        row_version: -11,
      },
    });
    const classified = await listOwnedProjectsWithClassificationSubset(
      syntheticContext(authorization, migrationOwner),
      10,
    );
    expect(classified.outcome).toBe("listed");
    if (classified.outcome !== "listed") throw new Error("未取得遷移後歷史列");
    expect(classified.projects).toHaveLength(6);
    expect(classified.projects.every((project) =>
      project.classification_state === "legacy_unverified" && project.requested_tier === null,
    )).toBe(true);
    expect(classified.projects.find((project) => project.id === migrationProjectId(2))).toMatchObject({
      tier: "A",
      needs_visitor_identity: false,
      row_version: 0,
    });
    for (const peer of migrationPeers) {
      expect(await readOwnedProjectWithClassificationSubset(
        syntheticContext(authorization, peer),
        migrationProjectId(1),
      )).toEqual(notFound);
      expect(await listOwnedProjectsWithClassificationSubset(
        syntheticContext(authorization, peer),
        10,
      )).toEqual({ outcome: "listed", projects: [] });
    }
  });

  it("兩個有效跨校學生各自兩專案；自己列表／單筆 DTO 精確投影", async () => {
    for (const n of [1, 2]) {
      expect(await authorizeCapability(context(n), "read_saved_content"))
        .toEqual({ outcome: "allowed", scope: "account_capability" });
      const result = await list(n);
      expect(result.outcome).toBe("listed");
      if (result.outcome !== "listed") throw new Error("未取得列表");
      expect(result.projects.sort((a, b) => a.id.localeCompare(b.id)))
        .toEqual([expected(n * 2 - 1), expected(n * 2)]);
      expect(await read(n, n * 2 - 1)).toEqual({ outcome: "found", project: expected(n * 2 - 1) });
    }
  });

  it("歷史列新介面標為 legacy_unverified，保留原 tier／false 與負版本", async () => {
    expect(await readOwnedProjectWithClassificationSubset(context(1), projectId(2)))
      .toEqual({
        outcome: "found",
        project: {
          id: projectId(2), title: "synthetic-project-2",
          classification_state: "legacy_unverified", requested_tier: null,
          tier: "B", needs_visitor_identity: true, stage: "Specification",
          created_at: "2026-10-23T00:00:00.123456Z", row_version: -1,
        },
      });
    const legacyList = await listOwnedProjectsWithClassificationSubset(context(1), 10);
    expect(legacyList.outcome).toBe("listed");
    if (legacyList.outcome !== "listed") throw new Error("未取得歷史列列表");
    expect(legacyList.projects.every((project) => project.classification_state === "legacy_unverified"))
      .toBe(true);
  });

  it("跨校不同帳號均有效，甲看不到乙；同校不同學生亦隔離", async () => {
    for (const n of [2, 3]) {
      expect(await authorizeCapability(context(n), "read_saved_content"))
        .toEqual({ outcome: "allowed", scope: "account_capability" });
      expect(await read(1, n * 2 - 1)).toEqual(notFound);
      expect(await read(n)).toEqual(notFound);
    }
    expect(await read(1, 999)).toEqual(await read(1, 3));
  });

  it("有界無排序子集、合法空列表與未知 profile 拒絕分離", async () => {
    const result = await list(1, 1);
    expect(result.outcome).toBe("listed");
    if (result.outcome !== "listed") throw new Error("未取得列表");
    expect(result.projects).toHaveLength(1);
    expect([projectId(1), projectId(2)]).toContain(result.projects[0].id);
    expect(await list(6)).toEqual({ outcome: "listed", projects: [] });
    expect(await list(999)).toEqual(denied);
    expect(await read(999)).toEqual(notFound);
  });

  it.each(["disabled", "marked", "purging", "unconfirmed"])(
    "同一 context 控制連線提交 %s 後，下一次列表／單筆與直接 RLS 立即拒絕", async (state) => {
      const same = context(1);
      expect((await readOwnedProjectSubset(same, projectId(1))).outcome).toBe("found");
      if (state === "disabled") {
        await control.query("UPDATE app.profiles SET status='disabled' WHERE id=$1", [account(1)]);
      } else if (state === "unconfirmed") {
        await control.query("UPDATE app.schools SET approval_state='unconfirmed' WHERE id=$1", [school(1)]);
      } else {
        await control.query("UPDATE app.profiles SET deletion_state=$1 WHERE id=$2", [state, account(1)]);
      }
      expect(await listOwnedProjectsSubset(same, 10)).toEqual(denied);
      expect(await readOwnedProjectSubset(same, projectId(1))).toEqual(notFound);
      expect(await same.runReadOnly(async (q) => (await q.query("SELECT id FROM app.projects")).rows)).toEqual([]);
    },
  );

  it.each(["withdrawn", "expired"])("%s 保留學生讀自己的保存內容", async (state) => {
    await control.query("UPDATE app.schools SET approval_state=$1 WHERE id=$2", [state, school(1)]);
    expect(await read(1)).toEqual({ outcome: "found", project: expected(1) });
    expect((await list(1)).outcome).toBe("listed");
    expect(await read(1, 3)).toEqual(notFound);
  });

  it.each([4, 5])("教師／管理員 %s 即使有自有 fixture 或關係允許仍無資料捷徑", async (n) => {
    expect(await authorizeCapability(context(n), "login")).toEqual({ outcome: "allowed", scope: "account_capability" });
    if (n === 4) {
      expect(await authorizeTeacherRelationship(context(n), account(1)))
        .toEqual({ outcome: "allowed", scope: "teacher_relationship" });
    }
    expect(await list(n)).toEqual(denied);
    expect(await read(n)).toEqual(notFound);
    expect(await read(n, n * 2 - 1)).toEqual(notFound);
    expect(await context(n).runReadOnly(async (q) => (await q.query("SELECT id FROM app.projects")).rows)).toEqual([]);
  });

  it.each([null, "", "invalid"])("未知／無效資料庫主體 %j 不放行", async (subject) => {
    const same = syntheticContext(authorization, subject);
    expect((await listOwnedProjectsSubset(same, 10)).outcome).toBe("failed");
    expect((await readOwnedProjectSubset(same, projectId(1))).outcome).toBe("failed");
  });

  it("非法 ID 與真實 SQL 故障不成功也不洩漏內部錯誤", async () => {
    expect(await readOwnedProjectSubset(context(1), "' OR 1=1 --"))
      .toEqual({ outcome: "failed", reason: "invalid_input" });
    const broken = syntheticContext(authorization, account(1), { fault: "sql" });
    for (const result of [await listOwnedProjectsSubset(broken, 10), await readOwnedProjectSubset(broken, projectId(1))]) {
      expect(result).toEqual({ outcome: "failed", reason: "dependency_failure" });
      expect(JSON.stringify(result)).not.toMatch(/SQLSTATE|SELECT|stack|password|22012|owner_id|postgres/i);
    }
    expect((await read(1)).outcome).toBe("found");
  });

  it("單一 statement snapshot：在實際查詢前提交停用，不能沿用先前 allow", async () => {
    const base = context(1);
    expect(await authorizeCapability(base, "read_saved_content"))
      .toEqual({ outcome: "allowed", scope: "account_capability" });
    let statements = 0;
    const changed: AuthorizationContext = {
      runReadOnly(operation) {
        return base.runReadOnly((query) => operation({
          async query(sql, values) {
            statements++;
            await control.query("UPDATE app.profiles SET status='disabled' WHERE id=$1", [account(1)]);
            return query.query(sql, values);
          },
        }));
      },
    };
    expect(await listOwnedProjectsSubset(changed, 10)).toEqual(denied);
    expect(statements).toBe(1);
  });

  it("非特權 actor 直接 SELECT（不帶 owner WHERE）仍受 RLS；不能自行寫入", async () => {
    const rows = await context(1).runReadOnly(async (q) => (await q.query("SELECT id::text FROM app.projects")).rows);
    expect(rows).toHaveLength(2);
    expect(rows).toEqual(expect.arrayContaining([{ id: projectId(1) }, { id: projectId(2) }]));
    const client = await authorization.connect();
    try {
      const actor = await client.query(`
        SELECT rolsuper,rolbypassrls,
          (SELECT count(*)::int FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
           WHERE n.nspname='app' AND c.relowner=r.oid) AS owned
        FROM pg_roles r WHERE rolname=current_user
      `);
      expect(actor.rows).toEqual([{ rolsuper: false, rolbypassrls: false, owned: 0 }]);
      await client.query("SET ROLE authenticated");
      await client.query("SELECT set_config('request.jwt.claim.sub',$1,false)", [account(1)]);
      await expect(client.query("UPDATE app.projects SET owner_id=$1 WHERE id=$2", [account(2), projectId(1)]))
        .rejects.toMatchObject({ code: "42501" });
      // 故意使用 READ WRITE，證明不是只被 READ ONLY 交易擋住。
      for (const sql of [
        "UPDATE app.projects SET owner_id=$1 WHERE id=$2",
        "UPDATE app.projects SET tier='B' WHERE owner_id=$1 AND id=$2",
        "UPDATE app.projects SET title='changed' WHERE owner_id=$1 AND id=$2",
        "INSERT INTO app.projects(id,owner_id,title,tier,needs_visitor_identity,stage,created_at,row_version) VALUES ($2,$1,'new','A',false,'Specification',now(),0)",
        "DELETE FROM app.projects WHERE owner_id=$1 AND id=$2",
        "SELECT app.account_gate($1,'read_saved_content') WHERE $2::uuid IS NOT NULL",
      ]) {
        await expect(client.query(sql, [account(1), projectId(1)])).rejects.toMatchObject({ code: "42501" });
      }
      process.stdout.write("projects actor: super=false; bypassrls=false; owned=0; direct-select=owner-only; owner/tier/title/insert/delete/arbitrary-gate=denied (read-write connection)\n");
    } finally { client.release(true); }
  });

  it("相同 pool／socket 交替兩位學生及偽造 claim，不污染主體與結果", async () => {
    const first = await authorization.connect();
    const initial = await inspectConnection(first);
    first.release();
    for (const n of [1, 2, 1, 2, 1]) {
      const same = syntheticContext(authorization, account(n), { claims: { role: "admin", schoolApproval: "approved" } });
      const result = await listOwnedProjectsSubset(same, 10);
      expect(result.outcome).toBe("listed");
      if (result.outcome !== "listed") throw new Error("未取得列表");
      expect(result.projects.map((p) => p.id).sort()).toEqual([projectId(n * 2 - 1), projectId(n * 2)]);
      const client = await authorization.connect();
      try { expect(await inspectConnection(client)).toEqual({ ...initial, sub: null, claims: null }); }
      finally { client.release(); }
    }
  });

  it("控制連線有合成主體仍非合法應用 actor", async () => {
    const invalid: AuthorizationContext = {
      async runReadOnly(operation) {
        const client = await control.connect();
        try {
          await client.query("BEGIN READ ONLY");
          await client.query("SELECT set_config('request.jwt.claim.sub',$1,true)", [account(1)]);
          return await operation(client);
        } finally { await client.query("ROLLBACK"); client.release(); }
      },
    };
    expect(await listOwnedProjectsSubset(invalid, 10)).toEqual({ outcome: "failed", reason: "invalid_context" });
  });

  it("DB 拒絕 C／非法階段／不存在 owner；版本零與負值不被擅自限制", async () => {
    await expect(control.query("UPDATE app.projects SET tier='C' WHERE id=$1", [projectId(1)]))
      .rejects.toMatchObject({ code: "23514" });
    await expect(control.query("UPDATE app.projects SET stage='idea' WHERE id=$1", [projectId(1)]))
      .rejects.toMatchObject({ code: "23514" });
    await expect(control.query("UPDATE app.projects SET owner_id=$1 WHERE id=$2", [account(999), projectId(1)]))
      .rejects.toMatchObject({ code: "23503" });
    expect(await read(1, 2)).toEqual({ outcome: "found", project: expected(2) });
  });

  it("catalog：RLS／FORCE、僅 SELECT policy、無版本／階段預設；草稿與任務表已建", async () => {
    const relation = await control.query(`
      SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid='app.projects'::regclass
    `);
    expect(relation.rows).toEqual([{ relrowsecurity: true, relforcerowsecurity: true }]);
    const policies = await control.query(`
      SELECT cmd FROM pg_policies
      WHERE schemaname='app' AND tablename='projects'
        AND roles @> ARRAY['authenticated']::name[]
    `);
    expect(policies.rows).toEqual([{ cmd: "SELECT" }]);
    const columns = await control.query(`
      SELECT column_name,column_default,is_nullable FROM information_schema.columns
      WHERE table_schema='app' AND table_name='projects' AND column_name IN ('row_version','stage')
      ORDER BY column_name
    `);
    expect(columns.rows).toEqual([
      { column_name: "row_version", column_default: null, is_nullable: "NO" },
      { column_name: "stage", column_default: null, is_nullable: "NO" },
    ]);
    expect((await control.query(`
      SELECT column_name,is_nullable FROM information_schema.columns
      WHERE table_schema='app' AND table_name='projects'
        AND column_name IN ('tier','needs_visitor_identity','requested_tier','classification_state')
      ORDER BY column_name
    `)).rows).toEqual([
      { column_name: "classification_state", is_nullable: "NO" },
      { column_name: "needs_visitor_identity", is_nullable: "YES" },
      { column_name: "requested_tier", is_nullable: "YES" },
      { column_name: "tier", is_nullable: "YES" },
    ]);
    expect((await control.query("SELECT to_regclass('app.stage_records')::text AS stages,to_regclass('app.tasks')::text AS tasks")).rows)
      .toEqual([{ stages: "app.stage_records", tasks: "app.tasks" }]);
    process.stdout.write("projects catalog: RLS=on; FORCE=on; SELECT policy only; row_version/stage defaults=none; stage_records=isolated drafts; tasks=present\n");
  });

  it.each(["點子", "A/B", "Specification", "Checkpoint", "Constitution", "UX/UI",
    "Specification Sync", "Technical Plan", "Final Pack"])("FR-009 正式階段 %s 可精確讀回", async (stage) => {
    try {
      await control.query("UPDATE app.projects SET stage=$1 WHERE id=$2", [stage, projectId(1)]);
      expect(await read(1)).toEqual({ outcome: "found", project: { ...expected(1), stage } });
    } finally {
      await control.query("UPDATE app.projects SET stage='Specification' WHERE id=$1", [projectId(1)]);
    }
  });
});
