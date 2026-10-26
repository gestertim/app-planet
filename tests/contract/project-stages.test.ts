import { describe, expect, it } from "vitest";
import type { AuthorizationContext } from "../../apps/web/src/server/authorization.ts";
import {
  listOwnedProjectsSubset,
  listOwnedProjectsWithClassificationSubset,
  readOwnedProjectSubset,
  readOwnedProjectWithClassificationSubset,
} from "../../apps/web/src/server/projects.ts";

const subject = "51000000-0000-4000-8000-000000000001";
const project = {
  id: "61000000-0000-4000-8000-000000000001",
  title: "合成專案", tier: "A", needs_visitor_identity: false,
  stage: "Specification", created_at: "2026-10-23T00:00:00.123456Z", row_version: 0,
};
const withLegacyClassification = (value: unknown): unknown => {
  if (typeof value !== "object" || value === null || Array.isArray(value) ||
      "classification_state" in value) return value;
  return { ...value, classification_state: "legacy_unverified", requested_tier: null };
};
const envelope = (projects: unknown = [project]) => ({
  subject, actor_valid: true, allowed: true,
  projects: Array.isArray(projects) ? projects.map(withLegacyClassification) : projects,
});
const context = (rows: unknown[]): AuthorizationContext => ({
  async runReadOnly(operation) { return operation({ async query() { return { rows }; } }); },
});
const failed = (reason: string) => ({ outcome: "failed", reason });
const confirmed = {
  ...project, classification_state: "confirmed", requested_tier: null,
  requirements_revision: 1,
  requirements: { description: "synthetic", runtime_needs: "static", runtime_ai_required: false },
  confirmation: {
    id: "61000000-0000-4000-8000-000000000002", requirements_revision: 1,
    confirmed_by: subject, confirmed_at: project.created_at,
    source: "student_explicit_confirmation", requested_tier_at_confirmation: null,
    requested_tier_acknowledgement: "no_preference", requirements_match: true,
  },
};

async function readAllRepresentations(value: unknown) {
  return Promise.all([
    readOwnedProjectSubset(context([envelope([value])]), project.id),
    readOwnedProjectWithClassificationSubset(context([envelope([value])]), project.id),
    listOwnedProjectsSubset(context([envelope([value])]), 10),
    listOwnedProjectsWithClassificationSubset(context([envelope([value])]), 10),
  ]);
}

describe("T050／T015 專案唯讀子集（不含階段寫入／衝突）", () => {
  it("F-02 完整合法 confirmed 對四個無法表示它的介面回 unsupported_representation", async () => {
    expect(await readAllRepresentations(confirmed)).toEqual(
      Array.from({ length: 4 }, () => ({ outcome: "unsupported_representation" })),
    );
  });

  it.each([
    { classification_state: "unknown" }, { classification_state: undefined },
    { tier: null }, { tier: "C" }, { needs_visitor_identity: undefined },
    { requested_tier: undefined }, { requirements_revision: 0 }, { requirements_revision: undefined },
    { requirements: null }, { requirements: { ...confirmed.requirements, runtime_needs: "work_data_api" } },
    { confirmation: null }, { confirmation: { ...confirmed.confirmation, requirements_match: false } },
    { confirmation: { ...confirmed.confirmation, requirements_revision: 2 } },
    { confirmation: { ...confirmed.confirmation, confirmed_by: undefined } },
    { confirmation: { ...confirmed.confirmation, requested_tier_acknowledgement: "matches" } },
  ])("F-02 confirmed 非法／缺漏／矛盾仍為 invalid_result：%j", async (change) => {
    expect(await readAllRepresentations({ ...confirmed, ...change }))
      .toEqual(Array.from({ length: 4 }, () => failed("invalid_result")));
  });

  it("F-02 unsupported 不得掩蓋列表其他非法列、重複或單筆錯誤 ID", async () => {
    for (const values of [[confirmed, { ...project, tier: "C" }], [confirmed, confirmed]]) {
      expect(await listOwnedProjectsSubset(context([envelope(values)]), 10)).toEqual(failed("invalid_result"));
      expect(await listOwnedProjectsWithClassificationSubset(context([envelope(values)]), 10))
        .toEqual(failed("invalid_result"));
    }
    expect(await readOwnedProjectSubset(context([envelope([confirmed])]), subject))
      .toEqual(failed("invalid_result"));
    expect(await readOwnedProjectWithClassificationSubset(context([envelope([confirmed])]), subject))
      .toEqual(failed("invalid_result"));
  });

  it("逐欄投影白名單，不傳出 owner 或內部欄位", async () => {
    expect(await readOwnedProjectSubset(context([envelope([
      { ...project, owner_id: subject, secret: "internal" },
    ])]), project.id)).toEqual({ outcome: "found", project });
  });

  it.each([-2147483648, -1, 0, 2147483647])("版本 %s 不自行限制正值或初始值", async (row_version) => {
    expect(await listOwnedProjectsSubset(context([envelope([{ ...project, row_version }])]), 2))
      .toEqual({ outcome: "listed", projects: [{ ...project, row_version }] });
  });

  it("合法空列表不同於拒絕與失敗", async () => {
    expect(await listOwnedProjectsSubset(context([envelope([])]), 2))
      .toEqual({ outcome: "listed", projects: [] });
    expect(await listOwnedProjectsSubset(context([{ ...envelope([]), allowed: false }]), 2))
      .toEqual({ outcome: "denied", reason: "policy_denied" });
    expect(await readOwnedProjectSubset(context([{ ...envelope([]), allowed: false }]), project.id))
      .toEqual({ outcome: "not_found" });
    expect(await readOwnedProjectSubset(context([envelope([])]), project.id))
      .toEqual({ outcome: "not_found" });
  });

  it("舊七欄列表遇到未分類新列須明確回報不支援，不能當成一般錯誤", async () => {
    const unclassified = {
      ...project,
      tier: null,
      needs_visitor_identity: null,
      requested_tier: "A",
      classification_state: "unconfirmed",
    };
    expect(await listOwnedProjectsSubset(context([envelope([unclassified])]), 2))
      .toEqual({ outcome: "unsupported_representation" });
  });

  it("新介面逐欄表示未分類 requested tier，正式分類保持 null", async () => {
    const unclassified = {
      ...project,
      tier: null,
      needs_visitor_identity: null,
      requested_tier: "B",
      classification_state: "unconfirmed",
    };
    const expected = {
      id: project.id, title: project.title, requested_tier: "B",
      classification_state: "unconfirmed", tier: null, needs_visitor_identity: null,
      stage: project.stage, created_at: project.created_at, row_version: 0,
    };
    expect(await listOwnedProjectsWithClassificationSubset(context([envelope([unclassified])]), 2))
      .toEqual({ outcome: "listed", projects: [expected] });
    expect(await readOwnedProjectWithClassificationSubset(context([envelope([unclassified])]), project.id))
      .toEqual({ outcome: "found", project: expected });
  });

  it("新介面保留歷史 tier／boolean 原值並明示尚無確認證據", async () => {
    expect(await listOwnedProjectsWithClassificationSubset(context([envelope()]), 2))
      .toEqual({
        outcome: "listed",
        projects: [{
          id: project.id, title: project.title, requested_tier: null,
          classification_state: "legacy_unverified", tier: "A", needs_visitor_identity: false,
          stage: project.stage, created_at: project.created_at, row_version: 0,
        }],
      });
  });

  it("列表混有新表示時舊介面不部分成功，且新介面拒絕不一致的未分類資料", async () => {
    const unclassified = {
      ...project,
      id: "61000000-0000-4000-8000-000000000002",
      tier: null,
      needs_visitor_identity: null,
      requested_tier: null,
      classification_state: "unconfirmed",
    };
    expect(await listOwnedProjectsSubset(context([envelope([project, unclassified])]), 2))
      .toEqual({ outcome: "unsupported_representation" });
    expect(await listOwnedProjectsWithClassificationSubset(context([envelope([{
      ...unclassified, tier: "A",
    }])]), 2)).toEqual(failed("invalid_result"));
  });

  it.each([[], [envelope(null)], [envelope({})], [envelope(), envelope()],
    [{ ...envelope(), allowed: "true" }]].map((rows) => [rows]))("非法 envelope 不可成功：%j", async (rows) => {
    expect(await listOwnedProjectsSubset(context(rows), 2)).toEqual(failed("invalid_result"));
  });

  it.each([null, "", "bad"])("無效主體 %j 不可成功", async (invalid) => {
    expect(await listOwnedProjectsSubset(context([{ ...envelope(), subject: invalid }]), 2))
      .toEqual(failed("invalid_context"));
  });

  it("無效 actor 不可成功", async () => {
    expect(await listOwnedProjectsSubset(context([{ ...envelope(), actor_valid: false }]), 2))
      .toEqual(failed("invalid_context"));
    expect(await listOwnedProjectsSubset(context([{}]), 2)).toEqual(failed("invalid_context"));
  });

  it.each([
    { id: "bad" }, { title: null }, { tier: "C" }, { needs_visitor_identity: "false" },
    { stage: "idea" }, { created_at: "2026-10-23T00:00:00+00:00" },
    { created_at: "2026-02-30T00:00:00Z" }, { row_version: 1.5 }, { row_version: 2147483648 },
    { row_version: undefined },
  ])("必要欄位錯型別／缺漏／非法值拒絕：%j", async (change) => {
    expect(await listOwnedProjectsSubset(context([envelope([{ ...project, ...change }])]), 2))
      .toEqual(failed("invalid_result"));
  });

  it("單筆不接受錯誤 ID 或多筆；列表不接受超量／重複", async () => {
    expect(await readOwnedProjectSubset(context([envelope()]), subject)).toEqual(failed("invalid_result"));
    expect(await readOwnedProjectSubset(context([envelope([project, project])]), project.id))
      .toEqual(failed("invalid_result"));
    expect(await listOwnedProjectsSubset(context([envelope([project, project])]), 1))
      .toEqual(failed("invalid_result"));
    expect(await listOwnedProjectsSubset(context([envelope([project, project])]), 2))
      .toEqual(failed("invalid_result"));
  });

  it.each([0, -1, 1.5, NaN, Infinity, "2", null, 2147483648])("非法 bound %j 不呼叫 DB", async (bound) => {
    const unused: AuthorizationContext = { runReadOnly() { throw new Error("must not query"); } };
    expect(await listOwnedProjectsSubset(unused, bound)).toEqual(failed("invalid_input"));
  });

  it.each(["bad", "' OR true --", null, 1])("非法 ID %j 不呼叫 DB", async (id) => {
    const unused: AuthorizationContext = { runReadOnly() { throw new Error("must not query"); } };
    expect(await readOwnedProjectSubset(unused, id)).toEqual(failed("invalid_input"));
  });

  it("同一 statement 使用參數化 bound／ID 與 gate／資料投影", async () => {
    let calls = 0;
    const inspected: AuthorizationContext = {
      async runReadOnly(operation) {
        return operation({
          async query(sql, values) {
            calls++;
            expect(values).toEqual(["1", project.id]);
            expect(sql).not.toContain(project.id);
            expect(sql).toContain("app.current_account_gate('read_saved_content')");
            expect(sql).toContain("app.projects");
            expect(sql).not.toMatch(/SELECT\s+\*/i);
            return { rows: [envelope()] };
          },
        });
      },
    };
    expect((await readOwnedProjectSubset(inspected, project.id)).outcome).toBe("found");
    expect(calls).toBe(1);
  });

  it("查詢與交易錯誤只回安全失敗，不回成功空列表", async () => {
    const broken: AuthorizationContext = {
      async runReadOnly() { throw new Error("SELECT password SQLSTATE 22012 stack"); },
    };
    expect(await listOwnedProjectsSubset(broken, 2)).toEqual(failed("dependency_failure"));
    expect(await readOwnedProjectSubset(broken, project.id)).toEqual(failed("dependency_failure"));
  });
});
