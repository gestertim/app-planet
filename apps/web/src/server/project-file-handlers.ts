import {
  createManualSnapshotBodySchema,
  fileIfMatchSchema,
  projectFileMaxBytes,
  projectFilePathSchema,
  projectFileWriteBodySchema,
  restoreProjectSnapshotBodySchema,
} from "@app-planet/core";
import { authorizeCapability } from "./authorization.ts";
import {
  createRouteHandler,
  hasTrustedSameOrigin,
  jsonResponse,
  problemResponse,
  readJsonBody,
  type RouteOptions,
} from "./http.ts";
import { readIdempotencyKey, runGuarded } from "./idempotency.ts";
import {
  createOwnedManualSnapshot,
  decodeSnapshotCursor,
  listOwnedProjectFiles,
  listOwnedProjectSnapshots,
  readOwnedProjectFile,
  readOwnedProjectSnapshot,
  readTeacherProjectSnapshot,
  listTeacherProjectSnapshots,
  restoreOwnedProjectSnapshot,
  writeOwnedProjectFile,
} from "./project-files.ts";

type Options = Pick<RouteOptions, "resolver" | "log"> & {
  readonly requireSameOrigin?: boolean;
};

function isReplayOnly(request: Request): boolean | null {
  const value = request.headers.get("idempotency-replay-only");
  return value === null ? false : value === "true" ? true : null;
}

type QueryResult<T> =
  | { outcome: "found"; value: T }
  | { outcome: "not_found" | "denied" | "invalid_input" | "too_large" | "already_exists"
      | "conflict" | "idempotency_key_reuse" | "unrecoverable" | "storage_limit" | "save_failed"
      | "dependency_failure" };

function sendResult<T>(result: QueryResult<T>,
  context: Parameters<typeof problemResponse>[1]) {
  if (result.outcome === "found") return jsonResponse(200, result.value, context);
  if (result.outcome === "not_found") return problemResponse("not_found", context);
  if (result.outcome === "denied") return problemResponse("forbidden", context);
  if (result.outcome === "invalid_input") return problemResponse("invalid_request", context);
  return problemResponse("dependency_unavailable", context);
}

function parsePage(request: Request) {
  const url = new URL(request.url);
  if ([...url.searchParams.keys()].some((key) => url.searchParams.getAll(key).length !== 1)) return null;
  const allowed = new Set(["cursor", "limit"]);
  if ([...url.searchParams.keys()].some((key) => !allowed.has(key))) return null;
  const limitRaw = url.searchParams.get("limit") ?? "20";
  if (!/^(?:[1-9]|[1-4]\d|50)$/.test(limitRaw)) return null;
  const cursor = decodeSnapshotCursor(url.searchParams.get("cursor"));
  if (cursor === "invalid") return null;
  return { cursor, limit: Number(limitRaw) };
}

function hasEncodedPath(request: Request): boolean {
  return /%[0-9a-f]{2}/i.test(new URL(request.url).pathname) || new URL(request.url).pathname.includes("%");
}

export function createProjectFileHandlers(options: Options) {
  const listFiles = createRouteHandler({ ...options, requireSameOrigin: false, route: "project_files_list", methods: ["GET"] },
    async ({ request, session, routeParams, ...context }) => {
      if (new URL(request.url).search) return problemResponse("invalid_request", context);
      const gate = await authorizeCapability(session.read, "read_saved_content");
      if (gate.outcome !== "allowed") return problemResponse(
        gate.outcome === "denied" ? "forbidden" : "dependency_unavailable", context,
      );
      const result = await listOwnedProjectFiles(session, routeParams.id ?? "");
      return result.outcome === "found"
        ? jsonResponse(200, { items: result.value }, context)
        : sendResult(result, context);
    });

  const file = createRouteHandler({ ...options, requireSameOrigin: false, route: "project_file", methods: ["GET", "PUT"] },
    async ({ request, session, routeParams, ...context }) => {
      const projectId = routeParams.id ?? "";
      const path = routeParams.path ?? "";
      if (new URL(request.url).search || hasEncodedPath(request) ||
          !projectFilePathSchema.safeParse(path).success) {
        return problemResponse("invalid_request", context);
      }
      if (request.method === "GET") {
        const gate = await authorizeCapability(session.read, "read_saved_content");
        if (gate.outcome !== "allowed") return problemResponse(
          gate.outcome === "denied" ? "forbidden" : "dependency_unavailable", context,
        );
        const result = await readOwnedProjectFile(session, projectId, path);
        if (result.outcome === "found") return jsonResponse(200, result.value, context, {
          etag: `"${result.value.hash}"`,
        });
        return sendResult(result, context);
      }

      if (!hasTrustedSameOrigin(request)) return problemResponse("forbidden", context);
      const gate = await authorizeCapability(session.read, "edit_saved_content");
      if (gate.outcome !== "allowed") return problemResponse(
        gate.outcome === "denied" ? "forbidden" : "dependency_unavailable", context,
      );
      const ifMatchHeader = request.headers.get("if-match");
      const ifNoneMatch = request.headers.get("if-none-match");
      if ((ifMatchHeader === null) === (ifNoneMatch === null)) {
        return problemResponse(ifMatchHeader === null ? "precondition_required" : "invalid_precondition", context);
      }
      let ifMatch: string | null = null;
      if (ifMatchHeader !== null) {
        if (!fileIfMatchSchema.safeParse(ifMatchHeader).success) return problemResponse("invalid_if_match", context);
        ifMatch = ifMatchHeader.slice(1, -1);
      } else if (ifNoneMatch !== "*") return problemResponse("invalid_precondition", context);
      const key = readIdempotencyKey(request.headers);
      if (!key.ok) return problemResponse(key.code, context);
      const replayOnly = isReplayOnly(request);
      if (replayOnly === null) return problemResponse("invalid_request", context);
      const body = await readJsonBody(request, (value) => {
        if (typeof value === "object" && value !== null && !Array.isArray(value) &&
            "content" in value && typeof value.content === "string" &&
            new TextEncoder().encode(value.content).byteLength > projectFileMaxBytes) {
          return { too_large: true as const };
        }
        const parsed = projectFileWriteBodySchema.safeParse(value);
        return parsed.success ? parsed.data : null;
      }, 1_600_000);
      if (!body.ok) return problemResponse(body.code, context);
      if ("too_large" in body.data) return problemResponse("payload_too_large", context);
      const writeBody = projectFileWriteBodySchema.safeParse(body.data);
      if (!writeBody.success) return problemResponse("invalid_request", context);
      const result = await runGuarded(() => writeOwnedProjectFile(session, {
        project_id: projectId, path, content: writeBody.data.content, if_match: ifMatch,
        if_none_match: ifNoneMatch === "*" ? "*" : null,
        idempotency_key: key.key, replay_only: replayOnly,
      }));
      if (result.state === "unknown") return problemResponse("operation_outcome_unknown", context);
      switch (result.value.outcome) {
        case "found": return jsonResponse(
          result.value.value.outcome === "saved" && result.value.value.created ? 201 : 200,
          result.value.value.file, context, { etag: `"${result.value.value.file.hash}"` });
        case "not_found": return problemResponse("not_found", context);
        case "denied": return problemResponse("forbidden", context);
        case "invalid_input": return problemResponse("invalid_request", context);
        case "too_large": return problemResponse("payload_too_large", context);
        case "already_exists": return problemResponse("file_already_exists", context);
        case "conflict": return problemResponse("version_conflict", context);
        case "idempotency_key_reuse": return problemResponse("idempotency_key_reuse", context);
        case "unrecoverable": return problemResponse("operation_outcome_unrecoverable", context);
        default: return problemResponse("dependency_unavailable", context);
      }
    });

  const snapshots = createRouteHandler({ ...options, requireSameOrigin: false, route: "project_snapshots", methods: ["GET", "POST"] },
    async ({ request, session, routeParams, ...context }) => {
      if (request.method === "GET") {
        const page = parsePage(request);
        if (!page) return problemResponse("invalid_request", context);
        const gate = await authorizeCapability(session.read, "read_saved_content");
        if (gate.outcome !== "allowed") return problemResponse(
          gate.outcome === "denied" ? "forbidden" : "dependency_unavailable", context,
        );
        return sendResult(await listOwnedProjectSnapshots(session, routeParams.id ?? "", page.cursor, page.limit), context);
      }

      if (!hasTrustedSameOrigin(request)) return problemResponse("forbidden", context);
      const gate = await authorizeCapability(session.read, "edit_saved_content");
      if (gate.outcome !== "allowed") return problemResponse(
        gate.outcome === "denied" ? "forbidden" : "dependency_unavailable", context,
      );
      const key = readIdempotencyKey(request.headers);
      if (!key.ok) return problemResponse(key.code, context);
      const replayOnly = isReplayOnly(request);
      if (replayOnly === null) return problemResponse("invalid_request", context);
      const body = await readJsonBody(request, (value) => {
        const parsed = createManualSnapshotBodySchema.safeParse(value);
        return parsed.success ? parsed.data : null;
      }, 8 * 1024);
      if (!body.ok) return problemResponse(body.code, context);
      const result = await runGuarded(() => createOwnedManualSnapshot(session, {
        project_id: routeParams.id ?? "", message: body.data.message ?? null,
        idempotency_key: key.key, replay_only: replayOnly,
      }));
      if (result.state === "unknown") return problemResponse("operation_outcome_unknown", context);
      switch (result.value.outcome) {
        case "found": {
          const { replayed, ...snapshotDto } = result.value.value;
          return jsonResponse(replayed ? 200 : 201, snapshotDto, context, {
            location: `/api/v1/projects/${routeParams.id}/snapshots/${snapshotDto.id}`,
          });
        }
        case "not_found": return problemResponse("not_found", context);
        case "denied": return problemResponse("forbidden", context);
        case "invalid_input": return problemResponse("invalid_request", context);
        case "idempotency_key_reuse": return problemResponse("idempotency_key_reuse", context);
        case "unrecoverable": return problemResponse("operation_outcome_unrecoverable", context);
        case "storage_limit": return problemResponse("storage_limit", context);
        default: return problemResponse("dependency_unavailable", context);
      }
    });

  const restore = createRouteHandler({ ...options, requireSameOrigin: true, route: "project_snapshot_restore", methods: ["POST"] },
    async ({ request, session, routeParams, ...context }) => {
      if (!hasTrustedSameOrigin(request)) return problemResponse("forbidden", context);
      const gate = await authorizeCapability(session.read, "edit_saved_content");
      if (gate.outcome !== "allowed") return problemResponse(
        gate.outcome === "denied" ? "forbidden" : "dependency_unavailable", context,
      );
      const key = readIdempotencyKey(request.headers);
      if (!key.ok) return problemResponse(key.code, context);
      const replayOnly = isReplayOnly(request);
      if (replayOnly === null) return problemResponse("invalid_request", context);
      const body = await readJsonBody(request, (value) => {
        const parsed = restoreProjectSnapshotBodySchema.safeParse(value);
        return parsed.success ? parsed.data : null;
      }, 8 * 1024);
      if (!body.ok) return problemResponse(body.code, context);
      const result = await runGuarded(() => restoreOwnedProjectSnapshot(session, {
        project_id: routeParams.id ?? "", snapshot_id: body.data.snapshot_id,
        idempotency_key: key.key, replay_only: replayOnly,
      }));
      if (result.state === "unknown") return problemResponse("operation_outcome_unknown", context);
      switch (result.value.outcome) {
        case "found":
          return jsonResponse(200, {
            pre_restore_snapshot_id: result.value.value.pre_restore_snapshot_id,
          }, context);
        case "not_found": return problemResponse("not_found", context);
        case "denied": return problemResponse("forbidden", context);
        case "invalid_input": return problemResponse("invalid_request", context);
        case "idempotency_key_reuse": return problemResponse("idempotency_key_reuse", context);
        case "unrecoverable": return problemResponse("operation_outcome_unrecoverable", context);
        case "save_failed": return problemResponse("save_failed", context);
        default: return problemResponse("dependency_unavailable", context);
      }
    });

  const snapshot = createRouteHandler({ ...options, requireSameOrigin: false, route: "project_snapshot_read", methods: ["GET"] },
    async ({ request, session, routeParams, ...context }) => {
      if (new URL(request.url).search) return problemResponse("invalid_request", context);
      const gate = await authorizeCapability(session.read, "read_saved_content");
      if (gate.outcome !== "allowed") return problemResponse(
        gate.outcome === "denied" ? "forbidden" : "dependency_unavailable", context,
      );
      return sendResult(await readOwnedProjectSnapshot(session, routeParams.id ?? "",
        routeParams.snapshotId ?? "", null), context);
    });
  const snapshotFile = createRouteHandler({ ...options, requireSameOrigin: false, route: "project_snapshot_file", methods: ["GET"] },
    async ({ request, session, routeParams, ...context }) => {
      const path = routeParams.path ?? "";
      if (new URL(request.url).search || hasEncodedPath(request) ||
          !projectFilePathSchema.safeParse(path).success) {
        return problemResponse("invalid_request", context);
      }
      const gate = await authorizeCapability(session.read, "read_saved_content");
      if (gate.outcome !== "allowed") return problemResponse(
        gate.outcome === "denied" ? "forbidden" : "dependency_unavailable", context,
      );
      return sendResult(await readOwnedProjectSnapshot(session, routeParams.id ?? "",
        routeParams.snapshotId ?? "", path), context);
    });

  const teacherSnapshots = createRouteHandler({ ...options, requireSameOrigin: false, route: "teacher_project_snapshots", methods: ["GET"] },
    async ({ request, session, routeParams, ...context }) => {
      const page = parsePage(request);
      if (!page) return problemResponse("invalid_request", context);
      return sendResult(await listTeacherProjectSnapshots(session, {
        student_id: routeParams.studentId ?? "", project_id: routeParams.projectId ?? "",
        cursor: page.cursor, limit: page.limit,
      }), context);
    });
  const teacherSnapshot = createRouteHandler({ ...options, requireSameOrigin: false, route: "teacher_project_snapshot", methods: ["GET"] },
    async ({ request, session, routeParams, ...context }) => {
      if (new URL(request.url).search) return problemResponse("invalid_request", context);
      return sendResult(await readTeacherProjectSnapshot(session, {
        student_id: routeParams.studentId ?? "", project_id: routeParams.projectId ?? "",
        snapshot_id: routeParams.snapshotId ?? "", path: null,
      }), context);
    });
  const teacherSnapshotFile = createRouteHandler({ ...options, requireSameOrigin: false, route: "teacher_project_snapshot_file", methods: ["GET"] },
    async ({ request, session, routeParams, ...context }) => {
      const path = routeParams.path ?? "";
      if (new URL(request.url).search || hasEncodedPath(request) ||
          !projectFilePathSchema.safeParse(path).success) {
        return problemResponse("invalid_request", context);
      }
      return sendResult(await readTeacherProjectSnapshot(session, {
        student_id: routeParams.studentId ?? "", project_id: routeParams.projectId ?? "",
        snapshot_id: routeParams.snapshotId ?? "", path,
      }), context);
    });
  return { listFiles, file, snapshots, restore, snapshot, snapshotFile,
    teacherSnapshots, teacherSnapshot, teacherSnapshotFile };
}
