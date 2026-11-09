import { randomUUID } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";

const driver = vi.hoisted(() => ({
  rows: [] as unknown[],
  fault: false,
  created: 0,
  sql: "",
  bound: [] as unknown[],
}));
vi.mock("pg", () => ({
  Pool: class {
    constructor() { driver.created++; }
    async query(sql: string, bound: unknown[]) {
      driver.sql = sql;
      driver.bound = bound;
      if (driver.fault) throw new Error("受控 driver 故障");
      return { rows: driver.rows };
    }
    async end() {}
  },
}));
import { closeStudentLookupPools, lookupStudentLogin } from "../../apps/web/src/server/auth/student-lookup.ts";

const env: NodeJS.ProcessEnv = {
  APP_PLANET_STUDENT_LOGIN_DATABASE_URL: "postgresql://app_student_login_runtime@localhost/synthetic",
};
const credential = {
  student_id: randomUUID(), auth_email_alias: `ap-${randomUUID()}@example.invalid`, version: 1, state: "active",
};
afterEach(async () => {
  await closeStudentLookupPools();
  driver.rows = [];
  driver.fault = false;
  driver.created = 0;
  driver.sql = "";
  driver.bound = [];
});

it("受控合法單列可用；handle只綁參數，不拼入SQL", async () => {
  driver.rows = [{ actor_valid: true, credentials: [{ ...credential }] }];
  const found = await lookupStudentLogin("sim-probe", env);
  expect(found.outcome === "found" && found.credential.student_id === credential.student_id).toBe(true);
  expect(driver.sql.includes("app.lookup_student_login($1::text)") && !driver.sql.includes("sim-probe")).toBe(true);
  expect(driver.bound.length === 1 && driver.bound[0] === "sim-probe").toBe(true);
});
it("成功查詢且json_agg為null才視為missing，與driver故障區分", async () => {
  driver.rows = [{ actor_valid: true, credentials: null }];
  expect((await lookupStudentLogin("sim-probe", env)).outcome).toBe("missing");
  driver.fault = true;
  expect((await lookupStudentLogin("sim-probe", env)).outcome).toBe("unavailable");
});
it.each([
  ["查詢無列", []],
  ["查詢多列", [{ actor_valid: true, credentials: null }, { actor_valid: true, credentials: null }]],
  ["actor不符", [{ actor_valid: false, credentials: [{ ...credential }] }]],
  ["credential空陣列", [{ actor_valid: true, credentials: [] }]],
  ["credential多列", [{ actor_valid: true, credentials: [{ ...credential }, { ...credential }] }]],
  ["credential壞版本", [{ actor_valid: true, credentials: [{ ...credential, version: 0 }] }]],
  ["credential壞alias", [{ actor_valid: true, credentials: [{ ...credential, auth_email_alias: "not-an-alias" }] }]],
  ["credential未知state", [{ actor_valid: true, credentials: [{ ...credential, state: "superseded" }] }]],
  ["credential額外欄位", [{ actor_valid: true, credentials: [{ ...credential, extra: true }] }]],
] as const)("%s一律unavailable，不取第一列或降級missing", async (_label, rows) => {
  driver.rows = [...rows];
  expect((await lookupStudentLogin("sim-probe", env)).outcome).toBe("unavailable");
});
it("沒有專用低權限連線即unavailable，不建立fallback pool", async () => {
  expect((await lookupStudentLogin("sim-probe", {})).outcome).toBe("unavailable");
  expect(driver.created).toBe(0);
});
