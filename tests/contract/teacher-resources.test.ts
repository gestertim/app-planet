import { describe, expect, it } from "vitest";
import {
  teacherProjectDetailSchema,
  teacherResourcePageQuerySchema,
  teacherStageDraftSchema,
  teacherStudentPageSchema,
} from "@app-planet/core";

const student = "a0000000-0000-4000-8000-000000000001";
const project = "a0000000-0000-4000-8000-000000000002";
const task = "a0000000-0000-4000-8000-000000000003";
const stamp = "2026-11-04T12:00:00.000Z";
const stages = ["點子", "A/B", "Specification", "Checkpoint", "Constitution",
  "UX/UI", "Specification Sync", "Technical Plan", "Final Pack"] as const;

describe("teacher read-only resource DTOs", () => {
  it("accepts bounded page parameters and rejects extra or invalid inputs", () => {
    expect(teacherResourcePageQuerySchema.parse({})).toEqual({ limit: 20 });
    expect(teacherResourcePageQuerySchema.parse({ after: student, limit: "50" }))
      .toEqual({ after: student, limit: 50 });
    expect(teacherResourcePageQuerySchema.safeParse({ after: "not-an-id" }).success).toBe(false);
    expect(teacherResourcePageQuerySchema.safeParse({ limit: "51" }).success).toBe(false);
    expect(teacherResourcePageQuerySchema.safeParse({ unexpected: true }).success).toBe(false);
  });

  it("requires a strict student whitelist and explicit pagination cursor", () => {
    const page = { outcome: "found", items: [{ id: student, display_label: "學生-a0000000" }], next_cursor: null };
    expect(teacherStudentPageSchema.parse(page)).toEqual(page);
    expect(teacherStudentPageSchema.safeParse({
      ...page, items: [{ ...page.items[0], email: "private@example.invalid" }],
    }).success).toBe(false);
  });

  it("distinguishes saved versions, current student confirmation, and manual Specification review", () => {
    const detail = {
      outcome: "found",
      project: { id: project, title: "合成專案", stage: "點子", row_version: 2, created_at: stamp },
      classification: {
        state: "confirmed", requested_tier: "A", tier: "A", needs_visitor_identity: false,
        confirmation: {
          id: task, requirements_revision: 1, confirmed_at: stamp,
          source: "student_explicit_confirmation", requested_tier_acknowledgement: "matches",
        },
      },
      requirements: {
        revision: 1,
        content: { description: "合成需求", runtime_needs: "static", runtime_ai_required: false },
      },
      stages: stages.map((stage, index) => ({
        stage, saved: index === 0, row_version: index === 0 ? 1 : null,
        student_confirmation: index === 0 ? "current" : "not_applicable",
        confirmed_at: index === 0 ? stamp : null,
      })),
      specification_review: "pending",
      tasks: { items: [{ id: task, title: "查看草稿", done: false, row_version: 0 }], next_cursor: null },
    };
    expect(teacherProjectDetailSchema.parse(detail)).toEqual(detail);
    expect(teacherProjectDetailSchema.safeParse({
      ...detail, stages: detail.stages.slice(1),
    }).success).toBe(false);
    expect(teacherProjectDetailSchema.safeParse({
      ...detail, tasks: { ...detail.tasks, items: [{ ...detail.tasks.items[0], owner_id: student }] },
    }).success).toBe(false);
  });

  it("supports real empty-stage state without treating it as complete", () => {
    const empty = {
      outcome: "found", project_id: project, stage: "UX/UI", saved: false, row_version: null,
      content: null, student_confirmation: "not_applicable", confirmed_at: null,
    };
    expect(teacherStageDraftSchema.parse(empty)).toEqual(empty);
    expect(teacherStageDraftSchema.safeParse({ ...empty, approved: true }).success).toBe(false);
  });
});
