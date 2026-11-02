import { describe, expect, it } from "vitest";
import {
  parseManualTaskLines,
  parseRowIfMatch,
  projectTaskImportBodySchema,
  projectTaskImportResultSchema,
  patchProjectTaskDoneInputSchema,
  projectTaskConflictSchema,
  projectTaskDoneBodySchema,
  projectTaskDtoSchema,
} from "@app-planet/core";

const projectId = "61000000-0000-4000-8000-000000000001";
const taskId = "62000000-0000-4000-8000-000000000001";
const task = {
  id: taskId,
  project_id: projectId,
  order: 0,
  title: "合成持久化任務",
  done: false,
  row_version: 0,
};

describe("T050／PROJ P-4 本人任務 done 契約子集", () => {
  it("只接受 strict { done: boolean }，不接受 caller 管理版本、owner 或批准狀態", () => {
    expect(projectTaskDoneBodySchema.safeParse({ done: true }).success).toBe(true);
    expect(projectTaskDoneBodySchema.safeParse({ done: false }).success).toBe(true);
    for (const body of [
      { done: true, owner_id: projectId },
      { done: true, project_id: projectId },
      { done: true, row_version: 9 },
      { done: true, approved: true },
      { done: 1 },
      {},
    ]) {
      expect(projectTaskDoneBodySchema.safeParse(body).success).toBe(false);
    }
  });

  it("task DTO 綁定真實 project/task ID 與非負 row_version", () => {
    expect(projectTaskDtoSchema.safeParse(task).success).toBe(true);
    expect(projectTaskDtoSchema.safeParse({ ...task, project_id: "not-a-uuid" }).success).toBe(false);
    expect(projectTaskDtoSchema.safeParse({ ...task, row_version: -1 }).success).toBe(false);
    expect(projectTaskDtoSchema.safeParse({ ...task, unapproved: true }).success).toBe(false);
  });

  it("PATCH server input 必須含路徑目標與 expected version，無多餘權限欄位", () => {
    expect(patchProjectTaskDoneInputSchema.safeParse({
      project_id: projectId,
      task_id: taskId,
      expected_row_version: 0,
      done: true,
    }).success).toBe(true);
    expect(patchProjectTaskDoneInputSchema.safeParse({
      project_id: projectId,
      task_id: taskId,
      expected_row_version: 0,
      done: true,
      owner_id: projectId,
    }).success).toBe(false);
  });

  it("If-Match 僅接受 strong quoted canonical row version，合法舊版衝突 DTO 限於 done", () => {
    expect(parseRowIfMatch('"0"')).toBe("0");
    expect(parseRowIfMatch('"-1"')).toBe("-1");
    for (const value of ["0", 'W/"0"', '"00"', '"0", "1"', "*"]) {
      expect(parseRowIfMatch(value)).toBeNull();
    }
    expect(projectTaskConflictSchema.safeParse({
      current: { version: 1, content: { done: true } },
      submitted: { version: 0, content: { done: false } },
    }).success).toBe(true);
    expect(projectTaskConflictSchema.safeParse({
      current: { version: 1, content: { done: true, title: "不可回傳" } },
      submitted: { version: 0, content: { done: false } },
    }).success).toBe(false);
  });
  it("T050 手動匯入 body 為 strict、需明確 confirmed:true，且 caller 不可帶 ID／owner／版本／done", () => {
    const ok = { confirmed: true, tasks: [{ title: " 第一項 " }, { title: "第二項" }] };
    const parsed = projectTaskImportBodySchema.parse(ok);
    expect(parsed.tasks.map((item) => item.title)).toEqual(["第一項", "第二項"]);
    const bad: unknown[] = [
      { tasks: ok.tasks }, { confirmed: false, tasks: ok.tasks }, { confirmed: true, tasks: [] },
      { ...ok, owner_id: "x" }, { ...ok, project_id: projectId },
      { confirmed: true, tasks: [{ title: "a", done: true }] },
      { confirmed: true, tasks: [{ title: "a", id: taskId }] },
      { confirmed: true, tasks: [{ title: "   " }] },
      { confirmed: true, tasks: [{ title: "a\nb" }] },
      { confirmed: true, tasks: [{ title: "x".repeat(201) }] },
      { confirmed: true, tasks: Array.from({ length: 51 }, () => ({ title: "a" })) },
    ];
    for (const body of bad) expect(projectTaskImportBodySchema.safeParse(body).success).toBe(false);
  });

  it("T050 手動匯入結果只含 created／replayed 與正式任務 DTO", () => {
    expect(projectTaskImportResultSchema.safeParse({ outcome: "created", tasks: [task] }).success).toBe(true);
    expect(projectTaskImportResultSchema.safeParse({ outcome: "replayed", tasks: [task] }).success).toBe(true);
    expect(projectTaskImportResultSchema.safeParse({ outcome: "other", tasks: [task] }).success).toBe(false);
    expect(projectTaskImportResultSchema.safeParse({ outcome: "created", tasks: [] }).success).toBe(false);
  });

  it("parseManualTaskLines 只做逐行拆分，不解析草稿語意；空白行略過，超限明確拒絕", () => {
    expect(parseManualTaskLines(" 甲 \r\n\r\n乙\n")).toEqual({ ok: true, titles: ["甲", "乙"] });
    expect(parseManualTaskLines("  \n ")).toEqual({ ok: false, reason: "empty" });
    expect(parseManualTaskLines(Array.from({ length: 51 }, () => "a").join("\n"))).toEqual({ ok: false, reason: "too_many" });
    expect(parseManualTaskLines("x".repeat(201))).toEqual({ ok: false, reason: "title_too_long" });
    expect(parseManualTaskLines("a\u0007b")).toEqual({ ok: false, reason: "control_character" });
  });
});
