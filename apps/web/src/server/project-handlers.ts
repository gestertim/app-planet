import { z } from "zod";
import {
  projectTaskDoneBodySchema, projectTaskImportBodySchema, readStageDraftInputSchema,
  stageConfirmationBodySchema,
} from "@app-planet/core";
import { confirmOwnedStageDraft, readOwnedStageConfirmationStatus } from "./stage-draft-confirmations.ts";
import { authorizeCapability } from "./authorization.ts";
import {
  createRouteHandler,
  jsonResponse,
  problemResponse,
  readJsonBody,
  readRowIfMatch,
  rowEtag,
  versionConflictResponse,
  type RouteOptions,
} from "./http.ts";
import { readIdempotencyKey, runGuarded } from "./idempotency.ts";
import {
  createOwnedProjectSubset, readCurrentOwnedProjectClassificationSubset, replayOwnedProjectSubset,
} from "./projects.ts";
import {
  importOwnedProjectTasksSubset, listOwnedProjectTasksSubset, patchOwnedProjectTaskDoneSubset,
  readOwnedProjectTaskSubset,
} from "./project-tasks.ts";

const bodySchema = z.strictObject({ title: z.string(), tier: z.unknown().optional() });
type ProjectHandlerOptions = Pick<RouteOptions, "resolver" | "log" | "requireSameOrigin"> & {
  readonly beforeExecute?: (operation: "patch_project_task_done" | "import_project_tasks" | "confirm_stage_draft") => Promise<void>;
};

export const projectTaskConflictPolicy = {
  resource: "row",
  allowedContentFields: ["done"],
} as const;

export function createProjectHandlers(options: ProjectHandlerOptions) {
  const create = createRouteHandler(
    { ...options, route: "project_create", methods: ["POST"] },
    async ({ request, session, ...context }) => {
      const gate = await authorizeCapability(session.read, "edit_saved_content");
      if (gate.outcome !== "allowed") return problemResponse(
        gate.outcome === "denied" ? "forbidden" : "dependency_unavailable", context,
      );
      const key = readIdempotencyKey(request.headers);
      if (!key.ok) return problemResponse(key.code, context);
      const body = await readJsonBody(request, (value) => {
        const parsed = bodySchema.safeParse(value);
        return parsed.success ? parsed.data : null;
      }, 64 * 1024);
      if (!body.ok) return problemResponse(body.code, context);
      if (Object.hasOwn(body.data, "tier") && body.data.tier !== "A" && body.data.tier !== "B") {
        return problemResponse("tier_not_supported", context);
      }
      const result = await runGuarded(() => createOwnedProjectSubset(session.write, body.data, key.key));
      if (result.state === "unknown") return problemResponse("operation_outcome_unknown", context);
      switch (result.value.outcome) {
        case "created":
          return jsonResponse(201, result.value.project, context, {
            location: `/api/v1/projects/${result.value.project.id}`,
            etag: rowEtag(result.value.project.row_version),
          });
        case "denied": return problemResponse("forbidden", context);
        case "conflict": return problemResponse("idempotency_key_reuse", context);
        case "failed": return problemResponse(
          result.value.reason === "invalid_input" ? "invalid_request" : "operation_outcome_unknown", context,
        );
      }
    },
  );
  const recover = createRouteHandler(
    { ...options, route: "project_recovery", methods: ["POST"] },
    async ({ request, session, ...context }) => {
      const gate = await authorizeCapability(session.read, "edit_saved_content");
      if (gate.outcome !== "allowed") return problemResponse(
        gate.outcome === "denied" ? "forbidden" : "dependency_unavailable", context,
      );
      const key = readIdempotencyKey(request.headers);
      if (!key.ok) return problemResponse(key.code, context);
      const body = await readJsonBody(request, (value) => {
        const parsed = bodySchema.safeParse(value);
        return parsed.success ? parsed.data : null;
      }, 64 * 1024);
      if (!body.ok) return problemResponse(body.code, context);
      if (Object.hasOwn(body.data, "tier") && body.data.tier !== "A" && body.data.tier !== "B") {
        return problemResponse("tier_not_supported", context);
      }
      const result = await runGuarded(() => replayOwnedProjectSubset(session.write, body.data, key.key));
      if (result.state === "unknown") return problemResponse("operation_outcome_unknown", context);
      switch (result.value.outcome) {
        case "replayed":
          return jsonResponse(200, { outcome: "replayed", project: result.value.project }, context, {
            location: `/api/v1/projects/${result.value.project.id}`,
            etag: rowEtag(result.value.project.row_version),
          });
        case "unrecoverable": return problemResponse("operation_outcome_unrecoverable", context);
        case "denied": return problemResponse("forbidden", context);
        case "conflict": return problemResponse("idempotency_key_reuse", context);
        case "failed": return problemResponse(
          result.value.reason === "invalid_input" ? "invalid_request" : "operation_outcome_unknown", context,
        );
      }
    },
  );
  const read = createRouteHandler(
    { ...options, route: "project_read", methods: ["GET"], requireSameOrigin: false },
    async ({ session, routeParams, ...context }) => {
      const result = await readCurrentOwnedProjectClassificationSubset(session.read, routeParams.id);
      switch (result.outcome) {
        case "found": return jsonResponse(200, result.project, context, { etag: rowEtag(result.project.row_version) });
        case "not_found": return problemResponse("not_found", context);
        case "denied": return problemResponse("forbidden", context);
        case "failed": return problemResponse(
          result.reason === "invalid_input" ? "not_found" : "dependency_unavailable", context,
        );
      }
    },
  );
  const patchTaskDone = createRouteHandler(
    { ...options, route: "project_task_done_patch", methods: ["PATCH"] },
    async ({ request, session, routeParams, ...context }) => {
      const target = z.strictObject({ projectId: z.uuid(), taskId: z.uuid() }).safeParse(routeParams);
      if (!target.success) return problemResponse("not_found", context);
      const gate = await authorizeCapability(session.read, "edit_saved_content");
      if (gate.outcome !== "allowed") return problemResponse(
        gate.outcome === "denied" ? "forbidden" : "dependency_unavailable", context,
      );
      const current = await readOwnedProjectTaskSubset(session.read, {
        project_id: target.data.projectId,
        task_id: target.data.taskId,
      });
      if (current.outcome === "not_found") return problemResponse("not_found", context);
      if (current.outcome === "denied") return problemResponse("forbidden", context);
      if (current.outcome === "failed") return problemResponse(
        current.reason === "invalid_input" ? "not_found" : "dependency_unavailable", context,
      );

      const match = readRowIfMatch(request.headers);
      if (!match.ok) return problemResponse(match.code, context);
      const body = await readJsonBody(request, (value) => {
        const parsed = projectTaskDoneBodySchema.safeParse(value);
        return parsed.success ? parsed.data : null;
      }, 4 * 1024);
      if (!body.ok) return problemResponse(body.code, context);
      await options.beforeExecute?.("patch_project_task_done");
      const guarded = await runGuarded(() => patchOwnedProjectTaskDoneSubset(session.write, {
        project_id: target.data.projectId,
        task_id: target.data.taskId,
        expected_row_version: match.version,
        done: body.data.done,
      }));
      if (guarded.state === "unknown") return problemResponse("operation_outcome_unknown", context);

      switch (guarded.value.outcome) {
        case "saved":
          return jsonResponse(200, guarded.value.task, context, {
            etag: rowEtag(guarded.value.task.row_version),
          });
        case "conflict":
          return versionConflictResponse(guarded.value.conflict, projectTaskConflictPolicy, context);
        case "not_found":
          return problemResponse("not_found", context);
        case "denied":
          return problemResponse("forbidden", context);
        case "failed":
          return problemResponse(
            guarded.value.reason === "invalid_input" ? "invalid_request" : "operation_outcome_unknown",
            context,
          );
      }
    },
  );
  const importTasks = createRouteHandler(
    { ...options, route: "project_task_import", methods: ["POST"] },
    async ({ request, session, routeParams, ...context }) => {
      const target = z.strictObject({ projectId: z.uuid() }).safeParse(routeParams);
      if (!target.success) return problemResponse("not_found", context);
      const gate = await authorizeCapability(session.read, "edit_saved_content");
      if (gate.outcome !== "allowed") return problemResponse(
        gate.outcome === "denied" ? "forbidden" : "dependency_unavailable", context,
      );
      const key = readIdempotencyKey(request.headers);
      if (!key.ok) return problemResponse(key.code, context);
      const owned = await listOwnedProjectTasksSubset(session.read, { project_id: target.data.projectId });
      if (owned.outcome === "not_found") return problemResponse("not_found", context);
      if (owned.outcome === "denied") return problemResponse("forbidden", context);
      if (owned.outcome === "failed") return problemResponse(
        owned.reason === "invalid_input" ? "not_found" : "dependency_unavailable", context,
      );
      const body = await readJsonBody(request, (value) => {
        const parsed = projectTaskImportBodySchema.safeParse(value);
        return parsed.success ? parsed.data : null;
      }, 64 * 1024);
      if (!body.ok) return problemResponse(body.code, context);
      await options.beforeExecute?.("import_project_tasks");
      const guarded = await runGuarded(() => importOwnedProjectTasksSubset(session.write, {
        project_id: target.data.projectId,
        idempotency_key: key.key,
        titles: body.data.tasks.map((task) => task.title),
      }));
      if (guarded.state === "unknown") return problemResponse("operation_outcome_unknown", context);

      switch (guarded.value.outcome) {
        case "created":
          return jsonResponse(201, { outcome: "created", tasks: guarded.value.tasks }, context, {
            location: `/api/v1/projects/${target.data.projectId}`,
          });
        case "replayed":
          return jsonResponse(200, { outcome: "replayed", tasks: guarded.value.tasks }, context, {
            location: `/api/v1/projects/${target.data.projectId}`,
          });
        case "conflict":
          return problemResponse(
            guarded.value.reason === "tasks_already_exist" ? "task_list_already_exists" : "idempotency_key_reuse",
            context,
          );
        case "not_found": return problemResponse("not_found", context);
        case "denied": return problemResponse("forbidden", context);
        case "failed":
          return problemResponse(
            guarded.value.reason === "invalid_input" ? "invalid_request" : "operation_outcome_unknown",
            context,
          );
      }
    },
  );
  const stageTarget = z.strictObject({ projectId: z.uuid(), stage: z.string() });
  const readStageConfirmation = createRouteHandler(
    { ...options, route: "stage_confirmation_read", methods: ["GET"], requireSameOrigin: false },
    async ({ session, routeParams, ...context }) => {
      const parsed = stageTarget.safeParse(routeParams);
      const target = parsed.success
        ? readStageDraftInputSchema.safeParse({ project_id: parsed.data.projectId, stage: parsed.data.stage })
        : null;
      if (!target?.success) return problemResponse("not_found", context);
      const result = await readOwnedStageConfirmationStatus(session.read, target.data);
      switch (result.outcome) {
        case "found": return jsonResponse(200, result.status, context);
        case "not_found": return problemResponse("not_found", context);
        case "denied": return problemResponse("forbidden", context);
        case "failed": return problemResponse(
          result.reason === "invalid_input" ? "not_found" : "dependency_unavailable", context,
        );
      }
    },
  );
  const confirmStage = createRouteHandler(
    { ...options, route: "stage_confirmation_create", methods: ["POST"] },
    async ({ request, session, routeParams, ...context }) => {
      const parsed = stageTarget.safeParse(routeParams);
      const target = parsed.success
        ? readStageDraftInputSchema.safeParse({ project_id: parsed.data.projectId, stage: parsed.data.stage })
        : null;
      if (!target?.success) return problemResponse("not_found", context);
      const gate = await authorizeCapability(session.read, "edit_saved_content");
      if (gate.outcome !== "allowed") return problemResponse(
        gate.outcome === "denied" ? "forbidden" : "dependency_unavailable", context,
      );
      const key = readIdempotencyKey(request.headers);
      if (!key.ok) return problemResponse(key.code, context);
      const body = await readJsonBody(request, (value) => {
        const parsedBody = stageConfirmationBodySchema.safeParse(value);
        return parsedBody.success ? parsedBody.data : null;
      }, 4 * 1024);
      if (!body.ok) return problemResponse(body.code, context);
      await options.beforeExecute?.("confirm_stage_draft");
      const guarded = await runGuarded(() => confirmOwnedStageDraft(session.write, {
        ...target.data,
        expected_row_version: body.data.expected_row_version,
      }, key.key));
      if (guarded.state === "unknown") return problemResponse("operation_outcome_unknown", context);
      const result = guarded.value;
      switch (result.outcome) {
        case "confirmed":
          return jsonResponse(201, {
            outcome: result.outcome, confirmation: result.confirmation, current: result.current,
          }, context, {
            location: `/api/v1/projects/${target.data.project_id}/stages/${encodeURIComponent(target.data.stage)}/confirmation`,
          });
        case "replayed":
        case "already_confirmed":
          return jsonResponse(200, {
            outcome: result.outcome, confirmation: result.confirmation, current: result.current,
          }, context, { "idempotent-replay": "true" });
        case "conflict":
          return problemResponse(
            result.reason === "idempotency_mismatch" ? "idempotency_key_reuse"
              : result.reason === "no_draft" ? "stage_draft_not_saved" : "stage_confirmation_version_mismatch",
            context,
          );
        case "not_found": return problemResponse("not_found", context);
        case "denied": return problemResponse("forbidden", context);
        case "failed": return problemResponse(
          result.reason === "invalid_input" ? "invalid_request" : "operation_outcome_unknown", context,
        );
      }
    },
  );
  return { create, recover, read, patchTaskDone, importTasks, readStageConfirmation, confirmStage };
}
