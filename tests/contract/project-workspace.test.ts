import { describe, expect, it } from "vitest";
import { readOwnedProjectWorkspaceSubset, hasTrustedProjectClassification } from "../../apps/web/src/server/projects.ts";
import type { AuthorizationContext } from "../../apps/web/src/server/authorization.ts";

const id = "a1000000-0000-4000-8000-000000000001";
const other = "a1000000-0000-4000-8000-000000000002";
const requirement = { description: " \t需求 🌍 e\u0301\r\n", runtime_needs: "static", runtime_ai_required: false };
const base = () => ({
  id, title: "合成工作區", stage: "點子", created_at: "2026-10-24T00:00:00.000000Z", row_version: 7,
  classification_state: "unconfirmed", requested_tier: null, tier: null, needs_visitor_identity: null,
  requirements_revision: 0, requirements: null, confirmation: null,
});
const confirmed = () => ({
  ...base(), classification_state: "confirmed", requirements_revision: 2, requirements: requirement,
  tier: "A", needs_visitor_identity: false,
  confirmation: {
    id: other, requirements_revision: 2, confirmed_by: id, confirmed_at: "2026-10-24T00:00:00Z",
    source: "student_explicit_confirmation", requested_tier_at_confirmation: null,
    requested_tier_acknowledgement: "no_preference", requirements_match: true,
  },
});
const draft = (stage = "Specification", text = "") => ({
  project_id: id, stage, row_version: 3, state: "ai_draft", content_source: "student_input",
  content: { text }, approved_by: null, approved_at: null,
});
const envelope = (project: unknown = base(), drafts: unknown = []) => ({
  subject: id, actor_valid: true, allowed: true, project, drafts,
});
function context(row: unknown, check?: (sql: string, values?: string[]) => void): AuthorizationContext {
  return {
    async runReadOnly(operation) {
      let calls = 0;
      const result = await operation({
        async query(sql, values) {
          calls++;
          check?.(sql, values);
          return { rows: [row] };
        },
      });
      expect(calls).toBe(1);
      return result;
    },
  };
}
const invalid = { outcome: "failed", reason: "invalid_result" };

describe("專案工作區唯讀聚合契約", () => {
  it("缺介面紅燈：新專案無需求／草稿是合法工作區，不初始化資料", async () => {
    const result = await readOwnedProjectWorkspaceSubset(context(envelope()), id);
    expect(result).toEqual({
      outcome: "found",
      workspace: {
        project: { id, title: "合成工作區", stage: "點子", created_at: base().created_at, row_version: 7 },
        requirements: null,
        classification: { state: "unconfirmed", requested_tier: null, tier: null, needs_visitor_identity: null },
        drafts: [],
      },
    });
  });
  it("已存空字串／空白／Unicode 與獨立版本精確保留，固定階段順序", async () => {
    const result = await readOwnedProjectWorkspaceSubset(context(envelope(
      { ...base(), requirements_revision: 2, requirements: requirement },
      [draft("Final Pack", " \t🌍 e\u0301\r\n"), draft("Specification"), draft("點子", "   ")],
    )), id.toUpperCase());
    expect(result.outcome).toBe("found");
    if (result.outcome !== "found") return;
    expect(result.workspace.project.row_version).toBe(7);
    expect(result.workspace.requirements).toEqual({ revision: 2, content: requirement });
    expect(result.workspace.drafts.map((d) => [d.stage, d.row_version, d.content.text]))
      .toEqual([["點子", 3, "   "], ["Specification", 3, ""], ["Final Pack", 3, " \t🌍 e\u0301\r\n"]]);
    expect(result.workspace.drafts[0]).toEqual({
      stage: "點子", row_version: 3, state: "ai_draft", content_source: "student_input", content: { text: "   " },
    });
  });
  it("confirmed 只回普通分類白名單，不暴露確認人／證據，原物件及副本均不可信", async () => {
    const result = await readOwnedProjectWorkspaceSubset(context(envelope(confirmed())), id);
    expect(result.outcome).toBe("found");
    if (result.outcome !== "found") return;
    expect(result.workspace.classification).toEqual({
      state: "confirmed", requested_tier: null, tier: "A", needs_visitor_identity: false,
    });
    for (const value of [result.workspace, result.workspace.classification,
      { ...result.workspace.classification }, JSON.parse(JSON.stringify(result.workspace.classification))]) {
      expect(hasTrustedProjectClassification(value)).toBe(false);
    }
    expect(JSON.stringify(result)).not.toMatch(/confirmed_by|confirmation|owner_id|requirements_match|meta/);
  });
  it("legacy_unverified 不推定確認，歷史負 project 版本仍保留", async () => {
    const result = await readOwnedProjectWorkspaceSubset(context(envelope({
      ...base(), classification_state: "legacy_unverified", tier: "B", needs_visitor_identity: true, row_version: -7,
    })), id);
    expect(result).toMatchObject({ outcome: "found", workspace: {
      project: { row_version: -7 }, requirements: null,
      classification: { state: "legacy_unverified", tier: "B", needs_visitor_identity: true },
    } });
  });
  it("不存在／他人專案與合法無需求／草稿明確區別", async () => {
    expect(await readOwnedProjectWorkspaceSubset(context(envelope(null)), id)).toEqual({ outcome: "not_found" });
    expect(await readOwnedProjectWorkspaceSubset(context({ ...envelope(null), allowed: false }), id))
      .toEqual({ outcome: "denied", reason: "policy_denied" });
  });
  it("只發一個參數化查詢，不接受 caller 授權物件", async () => {
    let observed = false;
    await readOwnedProjectWorkspaceSubset(context(envelope(), (sql, values) => {
      observed = true;
      expect(values).toEqual([id]);
      expect(sql).toContain("read_saved_content");
      expect(sql).toContain("app.stage_records");
      expect(sql).not.toContain(id);
    }), id);
    expect(observed).toBe(true);
    const never: AuthorizationContext = { async runReadOnly() { throw new Error("不應查詢"); } };
    for (const input of [null, "", "bad", `${id}'; SELECT 1;--`, { project_id: id, owner_id: id, role: "student" }]) {
      expect(await readOwnedProjectWorkspaceSubset(never, input)).toEqual({ outcome: "failed", reason: "invalid_input" });
    }
  });
  it.each([
    undefined, [], "invalid", { ...envelope(), drafts: null }, { ...envelope(), allowed: "true" },
    { ...envelope(), meta: "private" }, { ...envelope(), project: undefined },
    envelope({ ...base(), owner_id: id }), envelope({ ...base(), id: other }),
    envelope({ ...base(), requirements_revision: 1 }),
    envelope({ ...base(), requirements: requirement }),
    envelope({ ...confirmed(), requirements_revision: 3 }),
    envelope({ ...confirmed(), confirmation: { ...confirmed().confirmation, requirements_match: false } }),
    envelope({ ...confirmed(), confirmation: { ...confirmed().confirmation, meta: "private" } }),
    envelope({ ...base(), classification_state: "approved" }),
    envelope(base(), [draft(), draft()]),
    envelope(base(), [draft(), { ...draft("Final Pack"), row_version: -1 }]),
    envelope(base(), [{ ...draft(), project_id: other }]),
    envelope(base(), [{ ...draft(), state: "approved" }]),
    envelope(base(), [{ ...draft(), content_source: "ai" }]),
    envelope(base(), [{ ...draft(), content: { text: "ok", meta: "private" } }]),
    envelope(base(), [{ ...draft(), content: { text: "\ud800" } }]),
    envelope(base(), [{ ...draft(), meta: "private" }]),
    envelope(base(), [draft("不存在")]),
    { ...envelope(), allowed: false }, { ...envelope(null, [draft()]) },
  ])("非法 envelope／欄位／矛盾／重複階段全份拒絕 %#", async (row) => {
    expect(await readOwnedProjectWorkspaceSubset(context(row), id)).toEqual(invalid);
  });
  it.each([null, false, "true"])("不可信 actor context 拒絕 %s", async (actor_valid) => {
    expect(await readOwnedProjectWorkspaceSubset(context({ ...envelope(), actor_valid }), id))
      .toEqual({ outcome: "failed", reason: "invalid_context" });
  });
  it("SQL／COMMIT 故障固定安全失敗，沒有原始錯誤或部分資料", async () => {
    for (const commit of [false, true]) {
      const failing: AuthorizationContext = {
        async runReadOnly(operation) {
          if (commit) await context(envelope()).runReadOnly(operation);
          throw new Error("private SQL driver details");
        },
      };
      expect(await readOwnedProjectWorkspaceSubset(failing, id)).toEqual({ outcome: "failed", reason: "dependency_failure" });
    }
  });
  it("非法 rows 數量全份拒絕", async () => {
    for (const rows of [[], [envelope(), envelope()]]) {
      const ctx: AuthorizationContext = { async runReadOnly(op) { return op({ async query() { return { rows }; } }); } };
      expect(await readOwnedProjectWorkspaceSubset(ctx, id)).toEqual(invalid);
    }
  });
});
