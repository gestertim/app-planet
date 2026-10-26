import { describe, expect, it } from "vitest";
import {
  buildVersionConflictProblem,
  type StageDraftDto,
} from "@app-planet/core";
import { createHttpSaveAdapter } from "../../apps/web/src/components/project/http-save-adapter.ts";
import type { StageDraftSaveRequest } from "../../apps/web/src/components/project/save-controller.ts";

const target = {
  project_id: "95000000-0000-4000-8000-000000000001",
  stage: "Specification" as const,
};
const draft = (text: string, version: number): StageDraftDto => ({
  ...target,
  row_version: version,
  state: "ai_draft",
  content_source: "student_input",
  content: { text },
  approved_by: null,
  approved_at: null,
});
const request: StageDraftSaveRequest = {
  ...target,
  expected_row_version: 0,
  content: { text: "submitted" },
  idempotency_key: "95000000-0000-4000-8000-000000000002",
};

function adapter(body: unknown, status = 200, replay = false) {
  return createHttpSaveAdapter({
    buildUrl: () => "/api/v1/projects/95000000-0000-4000-8000-000000000001/stages/Specification",
    fetchImpl: async () => new Response(JSON.stringify(body), {
      status,
      headers: replay ? { "idempotent-replay": "true" } : undefined,
    }),
  });
}

describe("HTTP stage-draft adapter response contracts", () => {
  it("首建只送 If-None-Match，驗證 201 完整版本 0 DTO", async () => {
    let sent: Headers | undefined;
    const first = createHttpSaveAdapter({
      buildUrl: () => "/draft",
      fetchImpl: async (_url, init) => {
        sent = new Headers(init?.headers);
        return new Response(JSON.stringify(draft("submitted", 0)), { status: 201 });
      },
    });
    await expect(first.save({ ...request, expected_row_version: null })).resolves.toMatchObject({
      result: { outcome: "saved", operation: draft("submitted", 0) },
    });
    expect(sent?.get("if-none-match")).toBe("*");
    expect(sent?.has("if-match")).toBe(false);
  });

  it("首建／更新不混用成功 status，202 與畸形 201 保持未確認", async () => {
    const first = { ...request, expected_row_version: null };
    for (const [body, status, input] of [
      [{ row_version: 0 }, 201, first],
      [draft("submitted", 1), 201, first],
      [draft("submitted", 0), 200, first],
      [draft("submitted", 1), 201, request],
      [draft("submitted", 0), 202, first],
    ] as const) {
      await expect(adapter(body, status).save(input)).rejects.toThrow("invalid_response");
    }
  });

  it("首建 replay 接受原版本 0 與較新 current，不接受畸形 receipt", async () => {
    const first = { ...request, expected_row_version: null };
    await expect(adapter({
      operation: draft("submitted", 0), current_draft: draft("newer", 2),
    }, 200, true).save(first)).resolves.toMatchObject({
      result: { outcome: "replayed", operation: draft("submitted", 0),
        current_draft: { outcome: "found", draft: draft("newer", 2) } },
    });
    await expect(adapter({
      operation: { row_version: 0 }, current_draft: draft("newer", 2),
    }, 200, true).save(first)).rejects.toThrow("invalid_response");
  });

  it("412 是明確存在衝突，不能冒充版本衝突或換鍵更新", async () => {
    await expect(adapter({
      type: "/problems/draft_already_exists", title: "草稿已存在", status: 412,
      code: "draft_already_exists", instance: "/draft", request_id: `req_${"a".repeat(32)}`,
      user_message_zh: "請重新載入並比對，本地內容仍保留。",
    }, 412).save({ ...request, expected_row_version: null })).resolves.toMatchObject({
      result: { outcome: "conflict", reason: "draft_already_exists" },
    });
  });

  it("accepts a strict, target-correlated saved DTO", async () => {
    await expect(adapter(draft("submitted", 1)).save(request)).resolves.toMatchObject({
      target,
      result: { outcome: "saved", operation: draft("submitted", 1) },
    });
  });

  it("rejects malformed or unrelated success DTOs", async () => {
    const wrongTarget = { ...draft("submitted", 1), project_id: "95000000-0000-4000-8000-000000000003" };
    const malformed = { ...draft("submitted", 1), approved_by: "student" };
    await expect(adapter({ ...draft("submitted", 1), row_version: 7 }).save(request)).rejects.toThrow("invalid_response");
    await expect(adapter(wrongTarget).save(request)).rejects.toThrow("invalid_response");
    await expect(adapter(malformed).save(request)).rejects.toThrow("invalid_response");
  });

  it("does not turn a malformed replay current_draft into not_found", async () => {
    await expect(adapter({
      operation: draft("submitted", 1),
      current_draft: { outcome: "found", draft: { ...draft("server", 2), row_version: "invalid" } },
    }, 200, true).save(request)).rejects.toThrow("invalid_response");
    await expect(adapter({
      operation: draft("submitted", 1),
      current_draft: null,
    }, 200, true).save(request)).resolves.toMatchObject({
      result: { outcome: "replayed", current_draft: { outcome: "not_found" } },
    });
  });

  it("validates full conflict shape, versions, and submitted content", async () => {
    const built = buildVersionConflictProblem({
      type: "/problems/version_conflict",
      title: "版本衝突",
      status: 409,
      instance: "/api/v1/projects/95000000-0000-4000-8000-000000000001/stages/Specification",
      request_id: `req_${"a".repeat(32)}`,
      user_message_zh: "內容已被更新。",
      conflict: {
        current: { version: 1, content: { text: "server" } },
        submitted: { version: 0, content: { text: "submitted" } },
      },
    }, { resource: "row", allowedContentFields: ["text"] });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    await expect(adapter(built.data, 409).save(request)).resolves.toMatchObject({
      result: {
        outcome: "conflict",
        conflict: {
          current: { version: 1, content: { text: "server" } },
          submitted: { version: 0, content: { text: "submitted" } },
        },
      },
    });
    await expect(adapter({
      ...built.data,
      conflict: {
        ...built.data.conflict,
        current: { version: 1, content: { text: "server" }, secret: "unexpected" },
      },
    }, 409).save(request)).rejects.toThrow("invalid_response");
  });
});
