import { z } from "zod";
import {
  createUsageLedger,
  readStageDraftInputSchema,
  stageDraftContentSchema,
} from "@app-planet/core";
import { authorizeCapability, type AuthorizationContext } from "./authorization.ts";
import {
  closedPrincipalResolver,
  createRouteHandler,
  jobAcceptedResponse,
  jobSnapshotResponse,
  jsonResponse,
  problemResponse,
  readJsonBody,
  readStageDraftPrecondition,
  rowEtag,
  usageFailureProblem,
  versionConflictResponse,
  type LogSink,
  type TrustedPrincipalResolver,
} from "./http.ts";
import { readIdempotencyKey, runGuarded } from "./idempotency.ts";
import { readOwnedJobStatus } from "./jobs.ts";
import {
  readOwnedStageDraftSubset,
  saveOwnedStageDraftSubset,
} from "./stage-drafts.ts";
import type { ProjectCreationContext } from "./projects.ts";

const saveBody = z.strictObject({ content: stageDraftContentSchema });
const jobBody = z.strictObject({
  policy_id: z.uuid(),
  estimate_micro: z.string().regex(/^[1-9][0-9]{0,15}$/),
});

export interface FoundationHandlerOptions {
  readonly resolver?: TrustedPrincipalResolver;
  readonly log?: LogSink;
  readonly requireSameOrigin?: boolean;
  readonly beforeExecute?: (operation: "save_stage_draft" | "create_job" | "cancel_job") => Promise<void>;
}

export interface FoundationHandlers {
  getStageDraft(request: Request, projectId: string, stage: string): Promise<Response>;
  saveStageDraft(request: Request, projectId: string, stage: string): Promise<Response>;
  createJob(request: Request): Promise<Response>;
  getJob(request: Request, jobId: string): Promise<Response>;
  cancelJob(request: Request, jobId: string): Promise<Response>;
  stopAgentRun(request: Request, runId: string): Promise<Response>;
}

export const stageDraftConflictPolicy = {
  resource: "row",
  allowedContentFields: ["text"],
} as const;

export function createFoundationHandlers(options: FoundationHandlerOptions = {}): FoundationHandlers {
  const resolver = options.resolver ?? closedPrincipalResolver;
  const requireSameOrigin = options.requireSameOrigin ?? false;

  const getDraft = createRouteHandler(
    { route: "stage_draft_read", methods: ["GET"], resolver, log: options.log },
    async ({ session, routeParams, ...context }) => {
      const target = readStageDraftInputSchema.safeParse({
        project_id: routeParams.projectId,
        stage: routeParams.stage,
      });
      if (!target.success) return problemResponse("not_found", context);
      const gate = await authorizeCapability(session.read, "read_saved_content");
      if (gate.outcome === "denied") return problemResponse("forbidden", context);
      if (gate.outcome === "failed") return problemResponse("dependency_unavailable", context);
      const result = await readOwnedStageDraftSubset(session.read, target.data);
      switch (result.outcome) {
        case "found":
          return jsonResponse(200, result.draft, context, {
            etag: rowEtag(result.draft.row_version),
          });
        case "not_found":
          return problemResponse("not_found", context);
        case "denied":
          return problemResponse("forbidden", context);
        case "failed":
          return problemResponse(
            result.reason === "invalid_input" ? "invalid_request" : "dependency_unavailable",
            context,
          );
      }
    },
  );

  const saveDraft = createRouteHandler(
    { route: "stage_draft_save", methods: ["PUT"], resolver, log: options.log, requireSameOrigin },
    async ({ request, session, routeParams, ...context }) => {
      const target = readStageDraftInputSchema.safeParse({
        project_id: routeParams.projectId,
        stage: routeParams.stage,
      });
      const gate = await authorizeCapability(session.read, "edit_saved_content");
      if (gate.outcome === "denied") return problemResponse("forbidden", context);
      if (gate.outcome === "failed") return problemResponse("dependency_unavailable", context);
      if (!target.success) return problemResponse("not_found", context);
      const key = readIdempotencyKey(request.headers);
      if (!key.ok) return problemResponse(key.code, context);
      const match = readStageDraftPrecondition(request.headers);
      if (!match.ok) return problemResponse(match.code, context);
      const body = await readJsonBody(request, (value) => {
        const parsed = saveBody.safeParse(value);
        return parsed.success ? parsed.data : null;
      }, 64 * 1024);
      if (!body.ok) return problemResponse(body.code, context);
      await options.beforeExecute?.("save_stage_draft");
      const guarded = await runGuarded(() => saveOwnedStageDraftSubset(session.write, {
        ...target.data,
        expected_row_version: match.version,
        content: body.data.content,
      }, key.key));
      if (guarded.state === "unknown") return problemResponse("operation_outcome_unknown", context);

      switch (guarded.value.outcome) {
        case "saved":
          return jsonResponse(match.version === null ? 201 : 200, guarded.value.operation, context, {
            etag: rowEtag(guarded.value.operation.row_version),
            ...(match.version === null ? {
              location: `/api/v1/projects/${encodeURIComponent(target.data.project_id)}/stages/${encodeURIComponent(target.data.stage)}`,
            } : {}),
          });
        case "replayed": {
          if (guarded.value.current_draft.outcome === "denied") return problemResponse("forbidden", context);
          if (guarded.value.current_draft.outcome === "failed") return problemResponse("operation_outcome_unknown", context);
          const current = guarded.value.current_draft.outcome === "found"
            ? guarded.value.current_draft.draft
            : null;
          return jsonResponse(200, { operation: guarded.value.operation, current_draft: current }, context, {
            ...(current ? { etag: rowEtag(current.row_version) } : {}),
            "idempotent-replay": "true",
          });
        }
        case "conflict":
          if (guarded.value.reason === "idempotency_mismatch") {
            return problemResponse("idempotency_key_reuse", context);
          }
          if (guarded.value.reason === "draft_already_exists") {
            return problemResponse("draft_already_exists", context);
          }
          if (match.version === null && guarded.value.conflict.current.version !== null) {
            return problemResponse("draft_already_exists", context);
          }
          if (guarded.value.conflict.current.version === null) return problemResponse("not_found", context);
          return versionConflictResponse(guarded.value.conflict, stageDraftConflictPolicy, context);
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

  const createJob = createRouteHandler(
    { route: "job_create", methods: ["POST"], resolver, log: options.log, requireSameOrigin },
    async ({ request, session, ...context }) => {
      const key = readIdempotencyKey(request.headers);
      if (!key.ok) return problemResponse(key.code, context);
      const body = await readJsonBody(request, (value) => {
        const parsed = jobBody.safeParse(value);
        return parsed.success ? parsed.data : null;
      }, 4 * 1024);
      if (!body.ok) return problemResponse(body.code, context);
      await options.beforeExecute?.("create_job");
      const ledger = createUsageLedger(session.usage, {
        async authorize(_query, resource) { return resource === null; },
      });
      let reserved;
      try {
        reserved = await ledger.reserve({
          idempotencyKey: key.key,
          policyId: body.data.policy_id,
          estimateMicro: BigInt(body.data.estimate_micro),
          resourceId: null,
        });
      } catch (error) {
        const code = usageFailureProblem(error);
        return problemResponse(
          code === "dependency_unavailable" ? "operation_outcome_unknown" : code,
          context,
        );
      }
      const status = await readOwnedJobStatus(session.usage, reserved.id);
      if (status.outcome !== "found") return problemResponse("operation_outcome_unknown", context);
      return status.snapshot.state === "queued"
        ? jobAcceptedResponse({ ...status.snapshot, result: null, failure: null }, context)
        : jobSnapshotResponse(status.snapshot, status.failure, context);
    },
  );

  const getJob = createRouteHandler(
    { route: "job_status", methods: ["GET"], resolver, log: options.log },
    async ({ session, routeParams, ...context }) => {
      const status = await readOwnedJobStatus(session.usage, routeParams.jobId);
      switch (status.outcome) {
        case "found":
          return jobSnapshotResponse(status.snapshot, status.failure, context);
        case "not_found":
          return problemResponse("not_found", context);
        case "denied":
          return problemResponse("forbidden", context);
        case "unsupported":
          return problemResponse("job_result_unavailable", context);
        case "failed":
          return problemResponse("dependency_unavailable", context);
      }
    },
  );

  const cancelJob = createRouteHandler(
    { route: "job_cancel", methods: ["POST"], resolver, log: options.log, requireSameOrigin },
    async ({ session, routeParams, ...context }) => {
      const id = z.uuid().safeParse(routeParams.jobId);
      if (!id.success) return problemResponse("not_found", context);
      await options.beforeExecute?.("cancel_job");
      const ledger = createUsageLedger(session.usage, {
        async authorize(_query, resource) { return resource === null; },
      });
      try {
        const accepted = await ledger.cancel(id.data);
        if (!accepted) return problemResponse("not_found", context);
      } catch (error) {
        return problemResponse(usageFailureProblem(error), context);
      }
      return new Response(null, {
        status: 202,
        headers: {
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
          "x-request-id": context.requestId,
          location: `/api/v1/jobs/${id.data}`,
        },
      });
    },
  );

  // G-3 以正式 Agent Run ID 為識別，目前沒有 agent_runs 或 Run→Job 持久化關聯。
  // 不把 Run ID 當 Job ID、不查詢也不取消任何 Job；通過來源／身分檢查後一律關閉。
  const stopAgentRun = createRouteHandler(
    { route: "agent_run_stop", methods: ["POST"], resolver, log: options.log, requireSameOrigin },
    async ({ routeParams, ...context }) => {
      if (!z.uuid().safeParse(routeParams.runId).success) return problemResponse("not_found", context);
      return problemResponse("ai_not_open", context);
    },
  );

  return {
    getStageDraft: (request, projectId, stage) =>
      getDraft(request, { projectId, stage }),
    saveStageDraft: (request, projectId, stage) =>
      saveDraft(request, { projectId, stage }),
    createJob,
    getJob: (request, jobId) => getJob(request, { jobId }),
    cancelJob: (request, jobId) => cancelJob(request, { jobId }),
    stopAgentRun: (request, runId) => stopAgentRun(request, { runId }),
  };
}
