import { projectStageSchema, savedProjectExportNotice } from "@app-planet/core";
export function emptyExport() {
  return {
    format_version: "app-planet.saved-project.v1",
    saved_data_notice: savedProjectExportNotice,
    read_at: "2026-11-05T03:00:00.000000Z",
    project: { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", title: '繁中 🚀 "<h1>"', stage: "點子", row_version: 0 },
    requirements: null,
    classification: { classification_state: "unconfirmed", requested_tier: null,
      tier: null, needs_visitor_identity: null, confirmation: null, confirmation_validity: "not_confirmed" },
    stages: projectStageSchema.options.map((stage) => ({ stage, draft: null, confirmation: null })),
    tasks: [],
  };
}
