import { describe, expect, it } from "vitest";
import * as core from "@app-planet/core";
import { saveOwnedStageDraftSubset } from "../../apps/web/src/server/stage-drafts.ts";
import type { ProjectCreationContext } from "../../apps/web/src/server/projects.ts";

const id = "91000000-0000-4000-8000-000000000001";
const input = (text = " \t學生 🌍 e\u0301\r\n") => ({
  project_id: id, stage: "Specification", expected_row_version: null, content: { text },
});

describe("階段草稿 strict 契約", () => {
  it("首次保存、空草稿與 Unicode 原文精確保留", () => {
    for (const text of ["", " \t\n", input().content.text, "<script>alert(1)</script>"]) {
      expect(core.saveStageDraftInputSchema.parse(input(text))).toEqual(input(text));
    }
  });
  it("更新使用本階段草稿的整數版本", () => {
    expect(core.saveStageDraftInputSchema.parse({ ...input(), expected_row_version: 0 }))
      .toEqual({ ...input(), expected_row_version: 0 });
    for (const version of [-1, 0.1, "0", 2147483648, undefined]) {
      expect(core.saveStageDraftInputSchema.safeParse({ ...input(), expected_row_version: version }).success).toBe(false);
    }
  });
  it.each(["owner_id", "state", "approved_by", "approved_at", "content_source", "tier", "meta"])(
    "拒絕 caller 欄位 %s", (field) => {
      expect(core.saveStageDraftInputSchema.safeParse({ ...input(), [field]: "forged" }).success).toBe(false);
      expect(core.saveStageDraftInputSchema.safeParse({ ...input(), content: { text: "ok", [field]: "forged" } }).success).toBe(false);
    },
  );
  it.each(["\0", "\ud800", "\udfff", "ok\ud800tail"])("拒絕不可精確保存的文字 %j", (text) => {
    expect(core.saveStageDraftInputSchema.safeParse(input(text)).success).toBe(false);
  });
  it("只接受既有九步識別；內容來源與未確認狀態分開", () => {
    const stages = [
      "點子", "A/B", "Specification", "Checkpoint", "Constitution",
      "UX/UI", "Specification Sync", "Technical Plan", "Final Pack",
    ];
    for (const stage of stages) {
      expect(core.saveStageDraftInputSchema.safeParse({ ...input(), stage }).success).toBe(true);
    }
    expect(core.saveStageDraftInputSchema.safeParse({ ...input(), stage: "完成" }).success).toBe(false);
    expect(core.stageDraftDtoSchema.parse({
      project_id: id, stage: "Specification", content: { text: "人工提交" },
      row_version: 0, state: "ai_draft", content_source: "student_input",
      approved_by: null, approved_at: null,
    })).toMatchObject({ state: "ai_draft", content_source: "student_input" });
  });
  it("參數化 SQL，COMMIT 失敗時不交付成功，不洩漏 driver 錯誤", async () => {
    const text = "'; DELETE FROM app.projects; -- \n";
    let observed = false;
    const context: ProjectCreationContext = {
      async runTransaction(operation) {
        await operation({
          async query(sql, values) {
            observed = true;
            expect(sql).not.toContain(text);
            expect(values).toEqual([id, "Specification", null, text, id]);
            return { rows: [{
              subject: id, actor_valid: true,
              result: { outcome: "saved", operation: {
                project_id: id, stage: "Specification", row_version: 0, content: { text },
                state: "ai_draft", content_source: "student_input", approved_by: null, approved_at: null,
              } },
            }] };
          },
        });
        throw new Error("synthetic driver error with private SQL");
      },
    };
    expect(await saveOwnedStageDraftSubset(context, input(text), id))
      .toEqual({ outcome: "failed", reason: "dependency_failure" });
    expect(observed).toBe(true);
  });
});
