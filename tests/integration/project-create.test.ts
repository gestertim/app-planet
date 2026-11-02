import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { authorizeCapability } from "../../apps/web/src/server/authorization.ts";
import {
  createOwnedProjectSubset,
  listOwnedProjectsSubset,
  listOwnedProjectsWithClassificationSubset,
  readOwnedProjectSubset,
  readOwnedProjectWithClassificationSubset,
  type ProjectCreationContext,
} from "../../apps/web/src/server/projects.ts";
import {
  inspectConnection,
  localPools,
  syntheticContext,
  syntheticCreationContext,
} from "./authorization-context.ts";

const { control, authorization, parallelAuthorization } = localPools();
const account = (n: number) => `71000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const school = (n: number) => `72000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const key = (n: number) => `73000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const fixtureId = "74000000-0000-4000-8000-000000000001";
const title = "synthetic-create-request";
const denied = { outcome: "denied", reason: "policy_denied" };
const context = (n = 1) => syntheticCreationContext(authorization, account(n));
function rendezvous(participants: number) {
  let arrived = 0;
  let release!: () => void;
  const allArrived = new Promise<void>((resolve) => { release = resolve; });
  return async () => {
    arrived += 1;
    if (arrived === participants) release();
    await allArrived;
  };
}
const create = (n = 1, body: unknown = { title }, operationKey = key(1)) =>
  createOwnedProjectSubset(context(n), body, operationKey);
const replay = (
  n = 1,
  body: { title: string; tier?: "A" | "B" } = { title },
  operationKey = key(1),
  pool = authorization,
  synchronize?: () => Promise<void>,
) => syntheticCreationContext(pool, account(n), { synchronize }).runTransaction(async (query) => {
    const result = await query.query(`
      SELECT app.replay_unclassified_project($1::text,$2::text,$3::boolean,$4::uuid) AS result
    `, [body.title, body.tier ?? null, Object.hasOwn(body, "tier"), operationKey]);
    const row = result.rows[0];
    if (typeof row !== "object" || row === null || Array.isArray(row) || !("result" in row)) {
      throw new Error("缺少 replay-only DB 結果");
    }
    return row.result;
  });
const created = async (n: number, body: unknown, operationKey: string) => {
  const result = await create(n, body, operationKey);
  expect(result.outcome).toBe("created");
  if (result.outcome !== "created") throw new Error("預期本機建立成功");
  return result;
};
const ownedIds = [1, 2, 3, 4, 5, 6].map(account);
let original: unknown[];

async function saved() {
  return (await control.query(`
    SELECT id::text,owner_id::text,title,tier,needs_visitor_identity,
      requested_tier,classification_state,stage,created_at::text,row_version
    FROM app.projects WHERE owner_id=ANY($1::uuid[]) ORDER BY id
  `, [ownedIds])).rows;
}

async function idempotencyRows() {
  return (await control.query(`
    SELECT owner_id::text,operation_scope,idempotency_key::text,project_id::text,
      created_at,expires_at,response
    FROM app.project_create_idempotency
    WHERE owner_id=ANY($1::uuid[]) ORDER BY owner_id,operation_scope,idempotency_key
  `, [ownedIds])).rows;
}

async function removeCreatedRows() {
  await control.query("DELETE FROM app.project_create_idempotency WHERE owner_id=ANY($1::uuid[])", [ownedIds]);
  await control.query("DELETE FROM app.projects WHERE owner_id=ANY($1::uuid[]) AND id<>$2", [ownedIds, fixtureId]);
}

beforeAll(async () => {
  await control.query(`
    INSERT INTO app.schools(id,label,approval_state,approval_epoch,created_at,updated_at)
    VALUES ($1,'synthetic-create-school-a','approved',1,now(),now()),
           ($2,'synthetic-create-school-b','approved',1,now(),now())
  `, [school(1), school(2)]);
  for (const n of [1, 2, 3, 4, 5, 6]) {
    await control.query("INSERT INTO auth.users(id) VALUES ($1)", [account(n)]);
    await control.query(`
      INSERT INTO app.profiles(id,role,status,deletion_state,school_id,display_label,status_changed_at)
      VALUES ($1,$2,'approved','none',$3,'synthetic-create-actor',now())
    `, [account(n), n === 4 ? "teacher" : n === 5 ? "admin" : "student",
      n === 3 ? school(2) : school(1)]);
  }
  await control.query(`
    INSERT INTO app.projects(
      id,owner_id,title,tier,needs_visitor_identity,requested_tier,classification_state,
      stage,created_at,row_version
    )
    VALUES (
      $1,$2,'synthetic-preexisting-content','B',true,NULL,'legacy_unverified',
      'Final Pack','2026-10-23T00:00:00Z',-7
    )
  `, [fixtureId, account(1)]);
  original = await saved();
});

afterEach(async () => {
  await removeCreatedRows();
  await control.query("UPDATE app.profiles SET status='approved',deletion_state='none' WHERE id=$1", [account(1)]);
  await control.query("UPDATE app.schools SET approval_state='approved' WHERE id=$1", [school(1)]);
  expect(await saved()).toEqual(original);
  expect(await idempotencyRows()).toEqual([]);
});

afterAll(async () => {
  await Promise.all([control.end(), authorization.end(), parallelAuthorization.end()]);
});

describe("T051 方案 B：隔離本機 PostgreSQL 建立／唯讀", () => {
  it("COMMIT 後 response-loss 只走 replay-only，回原結果且專案仍只有一列", async () => {
    const initial = await created(1, { title }, key(22));
    const result = await replay(1, { title }, key(22));
    expect(result).toEqual({ outcome: "replayed", project: initial.project });
    expect((await control.query(
      "SELECT count(*)::int AS count FROM app.projects WHERE owner_id=$1 AND title=$2",
      [account(1), title],
    )).rows).toEqual([{ count: 1 }]);
  });

  it("receipt 到期、不存在或不完整時 replay-only 受控失敗且不增加專案", async () => {
    const initial = await created(1, { title }, key(23));
    await control.query(`
      UPDATE app.project_create_idempotency
      SET created_at=created_at-interval '25 hours', expires_at=expires_at-interval '25 hours'
      WHERE owner_id=$1 AND idempotency_key=$2
    `, [account(1), key(23)]);
    expect(await replay(1, { title }, key(23))).toEqual({ outcome: "unrecoverable" });
    expect(await replay(1, { title }, key(24))).toEqual({ outcome: "unrecoverable" });
    await control.query(`
      INSERT INTO app.project_create_idempotency (
        owner_id,operation_scope,idempotency_key,request_title,requested_tier,
        tier_was_provided,project_id,response,created_at,expires_at
      ) VALUES ($1,'project_create_v1',$2,$3,NULL,false,NULL,NULL,statement_timestamp(),
        statement_timestamp()+interval '24 hours')
    `, [account(1), key(25), title]);
    expect(await replay(1, { title }, key(25))).toEqual({ outcome: "unrecoverable" });
    expect((await control.query(
      "SELECT count(*)::int AS count FROM app.projects WHERE owner_id=$1",
      [account(1)],
    )).rows).toEqual([{ count: 2 }]);
    expect(initial.project.id).toBeTruthy();
  });

  it("原始 P-1 API 在 receipt 到期後仍保留同鍵可新建語意", async () => {
    const initial = await created(1, { title }, key(26));
    await control.query(`
      UPDATE app.project_create_idempotency
      SET created_at=created_at-interval '25 hours', expires_at=expires_at-interval '25 hours'
      WHERE owner_id=$1 AND idempotency_key=$2
    `, [account(1), key(26)]);
    const next = await created(1, { title }, key(26));
    expect(next.project.id).not.toBe(initial.project.id);
    expect((await control.query(
      "SELECT count(*)::int AS count FROM app.projects WHERE owner_id=$1 AND title=$2",
      [account(1), title],
    )).rows).toEqual([{ count: 2 }]);
  });

  it("不同帳號、失權及異意圖不會由 replay-only 新增或讀取資源", async () => {
    const initial = await created(1, { title, tier: "B" }, key(27));
    expect(await replay(2, { title, tier: "B" }, key(27))).toEqual({ outcome: "unrecoverable" });
    expect(await replay(1, { title: `${title}-other`, tier: "B" }, key(27)))
      .toEqual({ outcome: "idempotency_conflict" });
    await control.query("UPDATE app.profiles SET status='disabled' WHERE id=$1", [account(1)]);
    expect(await replay(1, { title, tier: "B" }, key(27))).toEqual({ outcome: "denied" });
    expect((await control.query("SELECT id::text FROM app.projects WHERE id=$1", [initial.project.id])).rows)
      .toEqual([{ id: initial.project.id }]);
  });

  it("原建立交易未提交時 recovery 等待同鍵鎖；提交後只回原結果，不建立第二列", async () => {
    const client = await authorization.connect();
    let transactionOpen = false;
    let recoveryFinished = false;
    try {
      await client.query("BEGIN ISOLATION LEVEL READ COMMITTED READ WRITE");
      transactionOpen = true;
      await client.query("SET LOCAL ROLE authenticated");
      await client.query("SELECT set_config('request.jwt.claim.sub',$1,true)", [account(1)]);
      const original = await client.query(
        "SELECT app.create_unclassified_project($1::text,NULL,false,$2::uuid) AS result",
        [`${title}-uncommitted`, key(28)],
      );
      expect(original.rows[0].result).toMatchObject({ outcome: "created" });

      const recovering = replay(1, { title: `${title}-uncommitted` }, key(28), parallelAuthorization)
        .then((result) => {
          recoveryFinished = true;
          return result;
        });
      let waiting = 0;
      for (let attempt = 0; attempt < 100 && waiting === 0; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        waiting = (await parallelAuthorization.query(`
          SELECT count(*)::int AS count FROM pg_stat_activity
          WHERE usename='app_authorization_test' AND wait_event_type='Lock'
            AND query LIKE '%replay_unclassified_project%'
        `)).rows[0].count;
      }
      expect(waiting).toBeGreaterThan(0);
      expect(recoveryFinished).toBe(false);
      expect((await control.query(
        "SELECT count(*)::int AS count FROM app.projects WHERE owner_id=$1 AND title=$2",
        [account(1), `${title}-uncommitted`],
      )).rows).toEqual([{ count: 0 }]);

      await client.query("COMMIT");
      transactionOpen = false;
      expect(await recovering).toMatchObject({
        outcome: "replayed", project: { title: `${title}-uncommitted` },
      });
      expect((await control.query(
        "SELECT count(*)::int AS count FROM app.projects WHERE owner_id=$1 AND title=$2",
        [account(1), `${title}-uncommitted`],
      )).rows).toEqual([{ count: 1 }]);
    } finally {
      if (transactionOpen) await client.query("ROLLBACK");
      client.release();
    }
  });

  it("鎖等待期間 receipt 到期後，重放以鎖取得後 DB 時間判定且不建立", async () => {
    const initial = await created(1, { title }, key(29));
    const holder = await control.connect();
    let transactionOpen = false;
    try {
      await holder.query("BEGIN");
      transactionOpen = true;
      await holder.query(`
        SELECT pg_advisory_xact_lock(pg_catalog.hashtextextended(
          $1::uuid::text || ':project_create_v1:' || $2::uuid::text, 0
        ))
      `, [account(1), key(29)]);
      await holder.query(`
        UPDATE app.project_create_idempotency
        SET created_at=created_at-interval '25 hours', expires_at=expires_at-interval '25 hours'
        WHERE owner_id=$1 AND idempotency_key=$2
      `, [account(1), key(29)]);
      const recovering = replay(1, { title }, key(29), parallelAuthorization);
      let waiting = 0;
      for (let attempt = 0; attempt < 100 && waiting === 0; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        waiting = (await parallelAuthorization.query(`
          SELECT count(*)::int AS count FROM pg_stat_activity
          WHERE usename='app_authorization_test' AND wait_event_type='Lock'
            AND query LIKE '%replay_unclassified_project%'
        `)).rows[0].count;
      }
      expect(waiting).toBeGreaterThan(0);
      await holder.query("COMMIT");
      transactionOpen = false;
      expect(await recovering).toEqual({ outcome: "unrecoverable" });
      expect((await holder.query(
        "SELECT count(*)::int AS count FROM app.projects WHERE id=$1",
        [initial.project.id],
      )).rows).toEqual([{ count: 1 }]);
      expect((await holder.query(
        "SELECT count(*)::int AS count FROM app.projects WHERE owner_id=$1 AND title=$2",
        [account(1), title],
      )).rows).toEqual([{ count: 1 }]);
    } finally {
      if (transactionOpen) await holder.query("ROLLBACK");
      holder.release();
    }
  });

  it("同鍵並行 recovery 全部回原 receipt，不新增專案", async () => {
    const initial = await created(1, { title }, key(30));
    const synchronize = rendezvous(8);
    const results = await Promise.all(Array.from({ length: 8 }, () =>
      replay(1, { title }, key(30), parallelAuthorization, synchronize)));
    expect(results).toEqual(Array.from({ length: 8 }, () => ({
      outcome: "replayed", project: initial.project,
    })));
    expect((await control.query(
      "SELECT count(*)::int AS count FROM app.projects WHERE owner_id=$1 AND title=$2",
      [account(1), title],
    )).rows).toEqual([{ count: 1 }]);
  });

  it.each([
    [{ title }, null],
    [{ title, tier: "A" }, "A"],
    [{ title, tier: "B" }, "B"],
  ])("成功建立點子，requested_tier 精確為 %s", async (body, requestedTier) => {
    expect(await authorizeCapability(syntheticContext(authorization, account(1)), "edit_saved_content"))
      .toEqual({ outcome: "allowed", scope: "account_capability" });
    const result = await created(1, body, key(1));
    expect(result.project).toMatchObject({
      title,
      requested_tier: requestedTier,
      classification_state: "unconfirmed",
      tier: null,
      needs_visitor_identity: null,
      stage: "點子",
      row_version: 0,
    });
    expect(result.project.created_at).toMatch(/Z$/);
    const savedRow = (await control.query(`
      SELECT owner_id::text,tier,needs_visitor_identity,requested_tier,classification_state,
        stage,row_version,created_at
      FROM app.projects WHERE id=$1
    `, [result.project.id])).rows[0];
    expect(savedRow).toMatchObject({
      owner_id: account(1), tier: null, needs_visitor_identity: null,
      requested_tier: requestedTier, classification_state: "unconfirmed",
      stage: "點子", row_version: 0,
    });
    const replay = await create(1, body, key(1));
    expect(replay).toEqual(result);
    expect((await control.query("SELECT count(*)::int AS count FROM app.projects WHERE id=$1", [
      result.project.id,
    ])).rows).toEqual([{ count: 1 }]);
    expect((await control.query(`
      SELECT count(*)::int AS count FROM app.project_create_idempotency
      WHERE owner_id=$1 AND operation_scope='project_create_v1' AND idempotency_key=$2
    `, [account(1), key(1)])).rows).toEqual([{ count: 1 }]);
  });

  it("新介面讀回學生自己的未分類列；舊七欄單筆／列表明確不支援且不部分回傳", async () => {
    const result = await created(1, { title, tier: "A" }, key(2));
    expect(await readOwnedProjectWithClassificationSubset(syntheticContext(authorization, account(1)), result.project.id))
      .toEqual({ outcome: "found", project: result.project });
    expect((await listOwnedProjectsWithClassificationSubset(syntheticContext(authorization, account(1)), 10))
      .outcome).toBe("listed");
    expect(await readOwnedProjectSubset(syntheticContext(authorization, account(1)), result.project.id))
      .toEqual({ outcome: "unsupported_representation" });
    expect(await listOwnedProjectsSubset(syntheticContext(authorization, account(1)), 10))
      .toEqual({ outcome: "unsupported_representation" });
  });

  it("schema 不允許未確認列帶正式分類，也不把歷史列改成 confirmed", async () => {
    const result = await created(1, { title }, key(21));
    await expect(control.query(`
      UPDATE app.projects SET tier='A',needs_visitor_identity=false WHERE id=$1
    `, [result.project.id])).rejects.toMatchObject({ code: "23514" });
    await expect(control.query(`
      UPDATE app.projects SET classification_state='confirmed' WHERE id=$1
    `, [fixtureId])).rejects.toMatchObject({ code: "23514" });
    expect((await control.query(`
      SELECT classification_state,tier,needs_visitor_identity
      FROM app.projects WHERE id=$1
    `, [fixtureId])).rows).toEqual([{
      classification_state: "legacy_unverified", tier: "B", needs_visitor_identity: true,
    }]);
  });

  it("同校及跨校其他有效學生皆不能讀取新專案", async () => {
    const result = await created(1, { title }, key(3));
    for (const n of [2, 3, 6]) {
      expect(await readOwnedProjectWithClassificationSubset(
        syntheticContext(authorization, account(n)), result.project.id,
      )).toEqual({ outcome: "not_found" });
    }
  });

  it.each([
    { owner_id: account(2) }, { role: "student" }, { school_id: school(2) },
    { id: fixtureId }, { created_at: "2026-10-24T00:00:00Z" },
    { tier: "A", needs_visitor_identity: false }, { needs_visitor_identity: false }, { stage: "點子" },
    { row_version: 0 }, { classification_state: "confirmed" }, { unknown: true },
  ])("偽造欄位／未知欄位不進交易：%j", async (extra) => {
    const unused: ProjectCreationContext = {
      runTransaction() { throw new Error("不得呼叫 DB"); },
    };
    expect(await createOwnedProjectSubset(unused, { title, ...extra }, key(4)))
      .toEqual({ outcome: "failed", reason: "invalid_input" });
  });

  it.each([4, 5])("教師／管理員 %s 的 login 允許不會授予學生建立權", async (n) => {
    expect((await authorizeCapability(syntheticContext(authorization, account(n)), "login")).outcome)
      .toBe("allowed");
    expect(await create(n, { title }, key(5))).toEqual(denied);
  });

  it.each(["pending", "rejected", "disabled"])("當下帳號狀態 %s 拒絕建立", async (status) => {
    await control.query("UPDATE app.profiles SET status=$1 WHERE id=$2", [status, account(1)]);
    expect(await create(1, { title }, key(6))).toEqual(denied);
  });

  it.each(["marked", "purging", "purge_failed", "purged"])("當下刪除狀態 %s 拒絕建立", async (state) => {
    await control.query("UPDATE app.profiles SET deletion_state=$1 WHERE id=$2", [state, account(1)]);
    expect(await create(1, { title }, key(7))).toEqual(denied);
  });

  it("學校未確認拒絕；withdrawn／expired 依 P-1 edit_saved_content 允許", async () => {
    await control.query("UPDATE app.schools SET approval_state='unconfirmed' WHERE id=$1", [school(1)]);
    expect(await create(1, { title }, key(8))).toEqual(denied);
    await control.query("UPDATE app.schools SET approval_state='withdrawn' WHERE id=$1", [school(1)]);
    const withdrawn = await created(1, { title: `${title}-withdrawn` }, key(9));
    expect(withdrawn.project.classification_state).toBe("unconfirmed");
    await control.query("UPDATE app.schools SET approval_state='expired' WHERE id=$1", [school(1)]);
    const expired = await created(1, { title: `${title}-expired` }, key(10));
    expect(expired.project.classification_state).toBe("unconfirmed");
  });

  it.each(["disabled", "marked", "unconfirmed"])("授權狀態提交後，同主體下一次立即拒絕：%s", async (state) => {
    const same = context(1);
    expect((await createOwnedProjectSubset(same, { title }, key(11))).outcome).toBe("created");
    if (state === "disabled") {
      await control.query("UPDATE app.profiles SET status='disabled' WHERE id=$1", [account(1)]);
    } else if (state === "unconfirmed") {
      await control.query("UPDATE app.schools SET approval_state='unconfirmed' WHERE id=$1", [school(1)]);
    } else {
      await control.query("UPDATE app.profiles SET deletion_state='marked' WHERE id=$1", [account(1)]);
    }
    expect(await createOwnedProjectSubset(same, { title }, key(11))).toEqual(denied);
  });

  it("JWT 中偽造角色／學校不改變 DB 主體與 owner", async () => {
    const forged = syntheticCreationContext(authorization, account(1), {
      claims: { role: "admin", school_id: school(2), schoolApproval: "approved" },
    });
    const result = await createOwnedProjectSubset(forged, { title }, key(12));
    expect(result.outcome).toBe("created");
    if (result.outcome !== "created") throw new Error("主體本人應可建立");
    expect((await control.query("SELECT owner_id::text FROM app.projects WHERE id=$1", [result.project.id])).rows)
      .toEqual([{ owner_id: account(1) }]);
  });

  it("同鍵同內容回原結果；同鍵不同內容拒絕且不覆寫", async () => {
    const initial = await created(1, { title, tier: "B" }, key(13));
    expect(await create(1, { title, tier: "B" }, key(13))).toEqual(initial);
    expect(await create(1, { title: `${title} `, tier: "B" }, key(13)))
      .toEqual({ outcome: "conflict", reason: "idempotency_mismatch" });
    expect(await create(1, { title, tier: "A" }, key(13)))
      .toEqual({ outcome: "conflict", reason: "idempotency_mismatch" });
    expect((await control.query(
      "SELECT count(*)::int AS count FROM app.projects WHERE owner_id=$1",
      [account(1)],
    )).rows[0].count).toBe(2);
    const entry = (await control.query(`
      SELECT created_at,expires_at,request_title,requested_tier,tier_was_provided
      FROM app.project_create_idempotency WHERE owner_id=$1 AND idempotency_key=$2
    `, [account(1), key(13)])).rows[0];
    expect(entry.expires_at.getTime() - entry.created_at.getTime()).toBe(24 * 60 * 60 * 1000);
    expect(entry).toMatchObject({ request_title: title, requested_tier: "B", tier_was_provided: true });
  });

  it("相同 UUID 跨主體各自隔離建立，不能讀取或取得對方結果", async () => {
    const first = await created(1, { title }, key(14));
    const second = await created(2, { title }, key(14));
    expect(second.project.id).not.toBe(first.project.id);
    expect((await control.query(
      "SELECT owner_id::text FROM app.projects WHERE id=$1",
      [second.project.id],
    )).rows).toEqual([{ owner_id: account(2) }]);
    expect((await control.query(`
      SELECT owner_id::text,project_id::text FROM app.project_create_idempotency
      WHERE idempotency_key=$1 ORDER BY owner_id
    `, [key(14)])).rows).toEqual([
      { owner_id: account(1), project_id: first.project.id },
      { owner_id: account(2), project_id: second.project.id },
    ]);
    expect(await readOwnedProjectWithClassificationSubset(
      syntheticContext(authorization, account(2)), first.project.id,
    )).toEqual({ outcome: "not_found" });
  });

  it("真實併發同鍵同內容只建立一列並回同一結果", async () => {
    const synchronize = rendezvous(8);
    const concurrent = await Promise.all(Array.from({ length: 8 }, () =>
      createOwnedProjectSubset(
        syntheticCreationContext(parallelAuthorization, account(1), { synchronize }),
        { title: `${title}-same` },
        key(15),
      )));
    expect(concurrent.every((result) => result.outcome === "created")).toBe(true);
    const projects = concurrent.map((result) => result.outcome === "created" ? result.project : null);
    expect(projects.every((project) => JSON.stringify(project) === JSON.stringify(projects[0]))).toBe(true);
    expect((await control.query(
      "SELECT count(*)::int AS count FROM app.projects WHERE owner_id=$1 AND title=$2",
      [account(1), `${title}-same`],
    )).rows).toEqual([{ count: 1 }]);
    expect((await control.query(`
      SELECT count(*)::int AS count FROM app.project_create_idempotency
      WHERE owner_id=$1 AND idempotency_key=$2
    `, [account(1), key(15)])).rows).toEqual([{ count: 1 }]);
  });

  it("真實併發同鍵不同本文最多一筆成功且不覆寫原結果", async () => {
    const synchronize = rendezvous(2);
    const outcomes = await Promise.all([
      createOwnedProjectSubset(
        syntheticCreationContext(parallelAuthorization, account(1), { synchronize }),
        { title: `${title}-left` },
        key(16),
      ),
      createOwnedProjectSubset(
        syntheticCreationContext(parallelAuthorization, account(1), { synchronize }),
        { title: `${title}-right` },
        key(16),
      ),
    ]);
    expect(outcomes.filter((result) => result.outcome === "created")).toHaveLength(1);
    expect(outcomes.filter((result) => result.outcome === "conflict")).toHaveLength(1);
    const inserted = (await control.query(
      "SELECT title FROM app.projects WHERE owner_id=$1 AND title IN ($2,$3)",
      [account(1), `${title}-left`, `${title}-right`],
    )).rows;
    expect(inserted).toHaveLength(1);
    const successful = outcomes.find((result) => result.outcome === "created");
    if (!successful || successful.outcome !== "created") throw new Error("併發成功結果缺漏");
    expect(inserted).toEqual([{ title: successful.project.title }]);
    expect((await control.query(`
      SELECT count(*)::int AS count FROM app.project_create_idempotency
      WHERE owner_id=$1 AND idempotency_key=$2 AND project_id=$3
    `, [account(1), key(16), successful.project.id])).rows).toEqual([{ count: 1 }]);
  });

  it("重放前重新授權；停用後不能重播既有結果", async () => {
    const initial = await created(1, { title }, key(17));
    await control.query("UPDATE app.profiles SET status='disabled' WHERE id=$1", [account(1)]);
    expect(await create(1, { title }, key(17))).toEqual(denied);
    expect((await control.query("SELECT id::text FROM app.projects WHERE id=$1", [initial.project.id])).rows)
      .toHaveLength(1);
  });

  it("寫入成功後故障造成完整回滾，pool 不殘留 principal／claim／transaction", async () => {
    const base = context(1);
    const failAfterWrite: ProjectCreationContext = {
      runTransaction(operation) {
        return base.runTransaction(async (query) => {
          await operation(query);
          throw new Error("synthetic post-write failure");
        });
      },
    };
    expect(await createOwnedProjectSubset(failAfterWrite, { title }, key(18)))
      .toEqual({ outcome: "failed", reason: "dependency_failure" });
    expect((await control.query("SELECT id FROM app.projects WHERE owner_id=$1 AND title=$2", [account(1), title]))
      .rows).toEqual([]);
    expect((await control.query(
      "SELECT idempotency_key FROM app.project_create_idempotency WHERE owner_id=$1 AND idempotency_key=$2",
      [account(1), key(18)],
    )).rows).toEqual([]);
    const client = await authorization.connect();
    try {
      expect(await inspectConnection(client)).toMatchObject({
        actor: "app_authorization_test", sub: null, claims: null,
      });
    } finally {
      client.release();
    }
  });

  it("受控角色、函式權限及 RLS 最小化；一般 READ WRITE actor 仍不能 DML", async () => {
    const role = (await control.query(`
      SELECT rolsuper,rolbypassrls,rolcanlogin FROM pg_roles WHERE rolname='app_project_writer'
    `)).rows;
    expect(role).toEqual([{ rolsuper: false, rolbypassrls: false, rolcanlogin: false }]);
    const functionInfo = (await control.query(`
      SELECT owner.rolname AS owner,p.prosecdef,p.proconfig,
        has_function_privilege('authenticated',p.oid,'EXECUTE') AS authenticated_execute,
        has_function_privilege('anon',p.oid,'EXECUTE') AS anon_execute,
        has_function_privilege('service_role',p.oid,'EXECUTE') AS service_execute
      FROM pg_proc p JOIN pg_roles owner ON owner.oid=p.proowner
      WHERE p.oid='app.create_unclassified_project(text,text,boolean,uuid)'::regprocedure
    `)).rows[0];
    expect(functionInfo).toMatchObject({
      owner: "app_project_writer", prosecdef: true,
      authenticated_execute: true, anon_execute: false, service_execute: false,
    });
    expect(functionInfo.proconfig).toContain("search_path=pg_catalog");
    const replayer = (await control.query(`
      SELECT owner.rolname AS owner,p.prosecdef,p.proconfig,
        has_function_privilege('authenticated',p.oid,'EXECUTE') AS authenticated_execute,
        has_function_privilege('anon',p.oid,'EXECUTE') AS anon_execute,
        has_function_privilege('service_role',p.oid,'EXECUTE') AS service_execute,
        has_table_privilege('app_project_replayer','app.projects','INSERT') AS project_insert,
        has_table_privilege('app_project_replayer','app.project_create_idempotency','INSERT') AS receipt_insert,
        has_table_privilege('app_project_replayer','app.project_create_idempotency','UPDATE') AS receipt_update,
        has_table_privilege('app_project_replayer','app.project_create_idempotency','DELETE') AS receipt_delete
      FROM pg_proc p JOIN pg_roles owner ON owner.oid=p.proowner
      WHERE p.oid='app.replay_unclassified_project(text,text,boolean,uuid)'::regprocedure
    `)).rows[0];
    expect(replayer).toMatchObject({
      owner: "app_project_replayer", prosecdef: true,
      authenticated_execute: true, anon_execute: false, service_execute: false,
      project_insert: false, receipt_insert: false, receipt_update: false, receipt_delete: false,
    });
    expect(replayer.proconfig).toContain("search_path=pg_catalog");
    const replaySource = (await control.query(`
      SELECT lower(pg_get_functiondef(
        'app.replay_unclassified_project(text,text,boolean,uuid)'::regprocedure
      )) AS definition
    `)).rows[0].definition as string;
    expect(replaySource).not.toContain("insert into app.projects");
    expect(replaySource).not.toContain("delete from app.project_create_idempotency");
    expect((await control.query(`
      SELECT has_function_privilege('authenticated',
          'app.lock_project_create_operation(uuid,uuid)','EXECUTE') AS actor_execute,
        has_function_privilege('anon','app.lock_project_create_operation(uuid,uuid)','EXECUTE') AS anon_execute,
        pg_has_role('authenticated','app_project_replayer','MEMBER') AS member,
        (SELECT NOT rolsuper AND NOT rolbypassrls AND NOT rolcanlogin
         FROM pg_roles WHERE rolname='app_project_replayer') AS role_safe
    `)).rows).toEqual([{
      actor_execute: false, anon_execute: false, member: false, role_safe: true,
    }]);
    expect((await control.query("SELECT pg_has_role('authenticated','app_project_writer','MEMBER') AS member"))
      .rows).toEqual([{ member: false }]);
    expect((await control.query(`
      SELECT c.relname,c.relrowsecurity,c.relforcerowsecurity
      FROM pg_class c
      WHERE c.oid IN ('app.projects'::regclass,'app.project_create_idempotency'::regclass)
      ORDER BY c.relname
    `)).rows).toEqual([
      { relname: "project_create_idempotency", relrowsecurity: true, relforcerowsecurity: true },
      { relname: "projects", relrowsecurity: true, relforcerowsecurity: true },
    ]);
    expect((await control.query(`
      SELECT has_table_privilege('authenticated','app.projects','INSERT') AS can_insert,
        has_table_privilege('authenticated','app.projects','UPDATE') AS can_update,
        has_table_privilege('authenticated','app.projects','DELETE') AS can_delete
    `)).rows).toEqual([{ can_insert: false, can_update: false, can_delete: false }]);

    const client = await authorization.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL READ COMMITTED READ WRITE");
      await client.query("SET LOCAL ROLE authenticated");
      await client.query("SELECT set_config('request.jwt.claim.sub',$1,true)", [account(1)]);
      const actor = (await client.query(`
        SELECT rolsuper,rolbypassrls,
          (SELECT count(*)::int FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
           JOIN pg_roles owner ON owner.oid=c.relowner
           WHERE n.nspname='app' AND owner.rolname IN (current_user,session_user)) AS owned
        FROM pg_roles WHERE rolname=current_user
      `)).rows;
      expect(actor).toEqual([{ rolsuper: false, rolbypassrls: false, owned: 0 }]);
      const directWrites: Array<{ sql: string; values: unknown[] }> = [
        {
          sql: "INSERT INTO app.projects(id,owner_id,title,requested_tier,classification_state,stage,created_at,row_version) VALUES (gen_random_uuid(),$1,'direct',NULL,'unconfirmed','點子',now(),0)",
          values: [account(1)],
        },
        { sql: "UPDATE app.projects SET owner_id=$1 WHERE id=$2", values: [account(1), key(19)] },
        { sql: "UPDATE app.projects SET title='changed' WHERE owner_id=$1", values: [account(1)] },
        { sql: "UPDATE app.projects SET requested_tier='B' WHERE owner_id=$1", values: [account(1)] },
        { sql: "UPDATE app.projects SET tier='A' WHERE owner_id=$1", values: [account(1)] },
        { sql: "UPDATE app.projects SET classification_state='legacy_unverified' WHERE owner_id=$1", values: [account(1)] },
        { sql: "UPDATE app.projects SET needs_visitor_identity=false WHERE owner_id=$1", values: [account(1)] },
        { sql: "DELETE FROM app.projects WHERE owner_id=$1", values: [account(1)] },
        { sql: "SELECT idempotency_key FROM app.project_create_idempotency", values: [] },
      ];
      for (const statement of directWrites) {
        await client.query("SAVEPOINT direct_write");
        await expect(client.query(statement.sql, statement.values)).rejects.toMatchObject({ code: "42501" });
        await client.query("ROLLBACK TO SAVEPOINT direct_write");
        await client.query("RELEASE SAVEPOINT direct_write");
      }
    } finally {
      try {
        await client.query("ROLLBACK");
      } catch (error) {
        client.release(true);
        throw error;
      }
      client.release();
    }
  });

  it("pool 交替主體／角色後不殘留 claim、role 或 transaction", async () => {
    for (const n of [1, 2, 4, 5, 1]) {
      const result = await create(n, { title: `${title}-pool` }, key(22));
      expect(result.outcome).toBe(n === 4 || n === 5 ? "denied" : "created");
      const client = await authorization.connect();
      try {
        expect(await inspectConnection(client)).toEqual({
          actor: "app_authorization_test",
          login: "app_authorization_test",
          sub: null,
          claims: null,
          pid: expect.any(Number),
        });
        await client.query("BEGIN READ WRITE");
        expect((await client.query("SELECT current_setting('transaction_read_only') AS readonly")).rows)
          .toEqual([{ readonly: "off" }]);
        await client.query("ROLLBACK");
      } finally {
        client.release();
      }
    }
  });

  it("一般 READ ONLY context 不能冒充受控寫入交易", async () => {
    const invalid: ProjectCreationContext = {
      async runTransaction(operation) {
        return syntheticContext(authorization, account(1)).runReadOnly((query) => operation({
          query(sql, values) { return query.query(sql, values?.map((value) => String(value))); },
        }));
      },
    };
    expect(await createOwnedProjectSubset(invalid, { title }, key(20)).then((result) => result.outcome))
      .toBe("failed");
  });
});
