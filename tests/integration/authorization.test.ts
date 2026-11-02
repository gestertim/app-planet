import { readFile } from "node:fs/promises";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  authorizeCapability,
  authorizeTeacherRelationship,
  type AuthorizationContext,
} from "../../apps/web/src/server/authorization.ts";
import { inspectConnection, localPools, syntheticContext } from "./authorization-context.ts";

const { control, authorization, parallelAuthorization } = localPools();
const id = (n: number) => `11000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const school = "21000000-0000-4000-8000-000000000001";
const allowed = { outcome: "allowed", scope: "account_capability" };
const denied = { outcome: "denied", reason: "policy_denied" };
const extraBinding = "31000000-0000-4000-8000-000000000099";
const capability = (n: number, name: string) =>
  authorizeCapability(syntheticContext(authorization, id(n)), name);
const relationship = (student: number) =>
  authorizeTeacherRelationship(syntheticContext(authorization, id(7)), id(student));

beforeAll(async () => {
  // 重用既有 pgTAP 的合成 fixture，不執行 TAP，也不改原檔；本輪需提交供兩條連線讀取。
  const fixture = await readFile(new URL("../../supabase/tests/account_gate.test.sql", import.meta.url), "utf8");
  const parts = fixture.split("SELECT extensions.no_plan();");
  if (parts.length !== 2 || !parts[0].startsWith("BEGIN;")) {
    throw new Error("合成 fixture 邊界不符，拒絕執行。");
  }
  await control.query(`${parts[0]}\nCOMMIT;`);
});

afterEach(async () => {
  await control.query("UPDATE app.profiles SET status = 'approved', deletion_state = 'none' WHERE id = $1", [id(1)]);
  await control.query("UPDATE app.profiles SET role = 'student' WHERE id = $1", [id(1)]);
  await control.query("UPDATE app.profiles SET status = 'approved', deletion_state = 'none' WHERE id = ANY($1::uuid[])", [[id(7), id(9)]]);
  await control.query("DELETE FROM app.teacher_student_bindings WHERE id = $1", [extraBinding]);
  await control.query("UPDATE app.schools SET approval_state = 'approved' WHERE id = $1", [school]);
  await control.query("UPDATE app.teacher_student_bindings SET state = 'active', ended_at = NULL, end_reason = NULL WHERE id = '31000000-0000-4000-8000-000000000001'");
});

afterAll(async () => {
  await Promise.all([control.end(), authorization.end(), parallelAuthorization.end()]);
});

describe("應用程式 → 當下 PostgreSQL → 授權", () => {
  it("授權連線為獨立非特權 actor，不能呼叫任意 account gate 或寫入", async () => {
    const client = await authorization.connect();
    try {
      const { rows } = await client.query(`
        SELECT current_user::text AS actor, rolsuper, rolbypassrls,
          (SELECT count(*)::int FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
            WHERE n.nspname='app' AND c.relowner=pg_roles.oid) AS owned
        FROM pg_roles WHERE rolname=current_user
      `);
      expect(rows).toEqual([{ actor: "app_authorization_test", rolsuper: false, rolbypassrls: false, owned: 0 }]);
      await client.query("SET ROLE authenticated");
      await expect(client.query("SELECT app.account_gate($1, 'login')", [id(1)])).rejects.toMatchObject({ code: "42501" });
      await expect(client.query("UPDATE app.profiles SET status='approved' WHERE id=$1", [id(1)])).rejects.toMatchObject({ code: "42501" });
      await client.query("RESET ROLE");
      process.stdout.write("actor=authenticated; session=app_authorization_test; super=false; bypassrls=false; app_owned=0; arbitrary_gate=denied; write=denied\n");
    } finally {
      client.release(true);
    }
  });

  it.each(["login", "read_saved_content", "edit_saved_content", "download_own_results", "submit_for_review", "public_deploy"])(
    "合法學生帳號能力 %s（不等於資源授權）", async (name) => {
      expect(await capability(1, name)).toEqual(allowed);
    },
  );

  it.each(["login", "read_saved_content", "public_deploy"])("unconfirmed 拒絕 %s", async (name) => {
    expect(await capability(2, name)).toEqual(denied);
  });

  it.each([3, 4])("withdrawn／expired 學生 %s 區分登入、內容與部署", async (n) => {
    expect(await capability(n, "login")).toEqual(allowed);
    expect(await capability(n, "read_saved_content")).toEqual(allowed);
    expect(await capability(n, "public_deploy")).toEqual(denied);
    expect(await relationship(n)).toEqual(denied);
  });

  it("缺 duty gate 的 ai_call 拒絕", async () => {
    expect(await capability(1, "ai_call")).toEqual(denied);
  });

  it.each(["disabled", "marked", "purging", "unconfirmed"])(
    "同一主體控制連線提交 %s 後，下一次立即拒絕", async (state) => {
      const context = syntheticContext(authorization, id(1));
      expect(await authorizeCapability(context, "login")).toEqual(allowed);
      if (state === "disabled") {
        await control.query("UPDATE app.profiles SET status = 'disabled' WHERE id = $1", [id(1)]);
      } else if (state === "unconfirmed") {
        await control.query("UPDATE app.schools SET approval_state = 'unconfirmed' WHERE id = $1", [school]);
      } else {
        await control.query("UPDATE app.profiles SET deletion_state = $1 WHERE id = $2", [state, id(1)]);
      }
      expect(await authorizeCapability(context, "login")).toEqual(denied);
      expect(await authorizeCapability(context, "read_saved_content")).toEqual(denied);
      expect(await relationship(1)).toEqual(denied);
    },
  );

  it.each([7, 8, 10])("教師 approved／pending／rejected %s 只有已定登入能力", async (n) => {
    expect(await capability(n, "login")).toEqual(allowed);
    expect(await capability(n, "read_saved_content")).toEqual(denied);
    expect(await authorizeTeacherRelationship(syntheticContext(authorization, id(n)), id(1)))
      .toEqual(n === 7 ? { outcome: "allowed", scope: "teacher_relationship" } : denied);
  });

  it("有效綁定只允許關係 predicate；未綁定拒絕；ended 提交立即拒絕", async () => {
    const context = syntheticContext(authorization, id(7));
    expect(await authorizeTeacherRelationship(context, id(1))).toEqual({
      outcome: "allowed", scope: "teacher_relationship",
    });
    expect(await relationship(11)).toEqual(denied);
    await control.query("UPDATE app.teacher_student_bindings SET state='ended', ended_at=now() WHERE id='31000000-0000-4000-8000-000000000001'");
    expect(await authorizeTeacherRelationship(context, id(1))).toEqual(denied);
  });

  it("同一 pool／socket 交替主體，不採信偽造角色或學校 claim，交易後無污染", async () => {
    const before = await authorization.connect();
    const initial = await inspectConnection(before);
    before.release();
    for (const n of [1, 2, 7, 2, 1]) {
      const context = syntheticContext(authorization, id(n), {
        claims: { role: "service_role", schoolApproval: "approved", accountStatus: "approved" },
      });
      expect(await authorizeCapability(context, "login")).toEqual(n === 2 ? denied : allowed);
      const client = await authorization.connect();
      try {
        const current = await inspectConnection(client);
        expect(current).toEqual({ ...initial, sub: null, claims: null });
      } finally { client.release(); }
    }
  });

  it.each([null, "", "invalid-uuid"])("匿名／缺少／無效主體 %j 不允許", async (subject) => {
    expect((await authorizeCapability(syntheticContext(authorization, subject), "login")).outcome).toBe("failed");
  });

  it("不存在的 profile、未知 capability、無效目標均不允許", async () => {
    expect(await capability(999, "login")).toEqual(denied);
    expect(await capability(1, "unknown")).toEqual({ outcome: "failed", reason: "invalid_input" });
    expect(await authorizeTeacherRelationship(syntheticContext(authorization, id(7)), "invalid"))
      .toEqual({ outcome: "failed", reason: "invalid_input" });
  });

  it("真實 SQL 故障不能放行，錯誤 socket 銷毀後下次可安全重連", async () => {
    const result = await authorizeCapability(syntheticContext(authorization, id(1), { fault: "sql" }), "login");
    expect(result).toEqual({ outcome: "failed", reason: "dependency_failure" });
    expect(JSON.stringify(result)).not.toMatch(/SELECT|SQLSTATE|stack|postgres:|password|rows|22012/i);
    expect(await capability(2, "login")).toEqual(denied);
    expect(await capability(1, "login")).toEqual(allowed);
  });

  it("已關閉的專用 pool 是依賴失敗，不回傳 driver error", async () => {
    const disposable = localPools();
    await Promise.all([
      disposable.control.end(), disposable.authorization.end(), disposable.parallelAuthorization.end(),
    ]);
    expect(await authorizeCapability(syntheticContext(disposable.authorization, id(1)), "login"))
      .toEqual({ outcome: "failed", reason: "dependency_failure" });
  });

  it("高權限控制連線即使有合成 claim 也不能成為授權 actor", async () => {
    expect(await authorizeCapability(syntheticContext(control, id(1)), "login"))
      .toEqual({ outcome: "failed", reason: "invalid_context" });
  });
});

describe("T008 角色／關係／即時失權補充案例（教師與管理員不是 owner）", () => {
  const teacherAllowed = { outcome: "allowed", scope: "teacher_relationship" };
  const visibleRows = (n: number, sql: string) =>
    syntheticContext(authorization, id(n)).runReadOnly(async (q) => (await q.query(sql)).rows);

  it.each(["disabled", "marked", "purging"])(
    "已綁定教師自身 %s：同一 context 下一次 login 與關係 predicate 立即拒絕", async (state) => {
      const context = syntheticContext(authorization, id(7));
      expect(await authorizeTeacherRelationship(context, id(1))).toEqual(teacherAllowed);
      if (state === "disabled") {
        await control.query("UPDATE app.profiles SET status='disabled' WHERE id=$1", [id(7)]);
      } else {
        await control.query("UPDATE app.profiles SET deletion_state=$1 WHERE id=$2", [state, id(7)]);
      }
      expect(await authorizeCapability(context, "login")).toEqual(denied);
      expect(await authorizeTeacherRelationship(context, id(1))).toEqual(denied);
    },
  );

  it.each(["pending", "rejected"])(
    "已有綁定列的教師被改為 %s：只保留受限入口 login，不得查看學生", async (status) => {
      await control.query("UPDATE app.profiles SET status=$1 WHERE id=$2", [status, id(7)]);
      expect(await capability(7, "login")).toEqual(allowed);
      expect(await capability(7, "read_saved_content")).toEqual(denied);
      expect(await relationship(1)).toEqual(denied);
    },
  );

  it("管理員只有已定的 login；不是教師、沒有學生能力，且在管理員身上的綁定列不產生教師關係", async () => {
    expect(await capability(9, "login")).toEqual(allowed);
    for (const name of ["read_saved_content", "edit_saved_content", "download_own_results",
      "submit_for_review", "public_deploy", "ai_call"]) {
      expect(await capability(9, name), name).toEqual(denied);
    }
    expect(await authorizeTeacherRelationship(syntheticContext(authorization, id(9)), id(1))).toEqual(denied);
    await control.query(`INSERT INTO app.teacher_student_bindings(
      id, teacher_id, student_id, state, created_by_aid, created_at
    ) VALUES ($1, $2, $3, 'active', '41000000-0000-4000-8000-000000000001', now())`,
      [extraBinding, id(9), id(1)]);
    expect(await authorizeTeacherRelationship(syntheticContext(authorization, id(9)), id(1))).toEqual(denied);
    expect(await visibleRows(9, "SELECT id::text FROM app.teacher_student_bindings")).toEqual([]);
  });

  it.each(["disabled", "marked", "purging"])("管理員 %s 後 login 立即拒絕", async (state) => {
    const context = syntheticContext(authorization, id(9));
    expect(await authorizeCapability(context, "login")).toEqual(allowed);
    if (state === "disabled") await control.query("UPDATE app.profiles SET status='disabled' WHERE id=$1", [id(9)]);
    else await control.query("UPDATE app.profiles SET deletion_state=$1 WHERE id=$2", [state, id(9)]);
    expect(await authorizeCapability(context, "login")).toEqual(denied);
  });

  it.each(["teacher", "admin"])(
    "學生 1 被改為 %s 角色後：不再具學生能力，也不再是可被查看的學生", async (role) => {
      expect(await relationship(1)).toEqual(teacherAllowed);
      await control.query("UPDATE app.profiles SET role=$1 WHERE id=$2", [role, id(1)]);
      expect(await capability(1, "read_saved_content")).toEqual(denied);
      expect(await capability(1, "edit_saved_content")).toEqual(denied);
      expect(await relationship(1)).toEqual(denied);
    },
  );

  it("資料隱藏：只有被關係 predicate 允許的綁定可見；他人 profile 與無關主體一律看不到", async () => {
    const bindings = "SELECT student_id::text FROM app.teacher_student_bindings ORDER BY 1";
    expect(await visibleRows(7, bindings)).toEqual([{ student_id: id(1) }]);
    for (const n of [1, 8, 9, 10, 11]) expect(await visibleRows(n, bindings), `主體 ${n}`).toEqual([]);
    expect(await visibleRows(7, "SELECT id::text FROM app.profiles ORDER BY 1")).toEqual([{ id: id(7) }]);
    expect(await visibleRows(1, "SELECT id::text FROM app.profiles ORDER BY 1")).toEqual([{ id: id(1) }]);
    expect(await visibleRows(9, "SELECT id::text FROM app.profiles ORDER BY 1")).toEqual([{ id: id(9) }]);
    await control.query("UPDATE app.profiles SET deletion_state='marked' WHERE id=$1", [id(1)]);
    expect(await visibleRows(7, bindings)).toEqual([]);
    expect(await visibleRows(1, "SELECT id::text FROM app.profiles")).toEqual([]);
  });

  it("單一 statement snapshot：關係 predicate 前提交學生停用，不沿用先前 allow", async () => {
    const base = syntheticContext(authorization, id(7));
    expect(await authorizeTeacherRelationship(base, id(1))).toEqual(teacherAllowed);
    let statements = 0;
    const changed: AuthorizationContext = {
      runReadOnly(operation) {
        return base.runReadOnly((query) => operation({
          async query(sql, values) {
            statements++;
            await control.query("UPDATE app.profiles SET status='disabled' WHERE id=$1", [id(1)]);
            return query.query(sql, values);
          },
        }));
      },
    };
    expect(await authorizeTeacherRelationship(changed, id(1))).toEqual(denied);
    expect(statements).toBe(1);
  });
});
