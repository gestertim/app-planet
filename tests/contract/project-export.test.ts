import { describe, expect, it } from "vitest";
import { projectExportSchema } from "@app-planet/core";
import { emptyExport } from "../fixtures/project-export.ts";

describe("本人已保存資料下載 strict 格式", () => {
  it("明示未保存，完整九階段，不發明內容，UTF-8 原文往返", () => {
    const value = emptyExport();
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(new TextEncoder().encode(JSON.stringify(value)));
    expect(projectExportSchema.parse(JSON.parse(decoded))).toEqual(value);
    expect(projectExportSchema.safeParse({ ...value, email: "not-exported" }).success).toBe(false);
    expect(projectExportSchema.safeParse({ ...value, project: { ...value.project, owner_id: value.project.id } }).success).toBe(false);
    expect(projectExportSchema.safeParse({ ...value, stages: value.stages.slice(1) }).success).toBe(false);
    expect(projectExportSchema.safeParse({ ...value, stages: Array(9).fill(value.stages[0]) }).success).toBe(false);
    expect(projectExportSchema.safeParse({ ...value, format_version: "unknown" }).success).toBe(false);
  });

  it("禁止秘密、歷史／receipt、非本人任務與不一致確認", () => {
    const value = emptyExport();
    for (const key of ["receipt", "audit", "profile", "chat", "attachments", "agent_jobs", "files"]) {
      expect(projectExportSchema.safeParse({ ...value, [key]: {} }).success).toBe(false);
    }
    expect(projectExportSchema.safeParse({ ...value, tasks: [{
      id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", project_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      order: 0, title: "任務", done: true, row_version: 1,
    }] }).success).toBe(false);
    expect(projectExportSchema.safeParse({ ...value, stages: value.stages.map((s, i) => i ? s : {
      ...s, confirmation: { row_version: 0, confirmed_at: value.read_at, source: "student_explicit_confirmation", current: true },
    }) }).success).toBe(false);
  });
});
