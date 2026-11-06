import {
  canonicalSnapshotManifest,
  projectFileContentDtoSchema,
  projectFileListSchema,
  projectFilePathSchema,
  projectSnapshotFileSchema,
  projectSnapshotListSchema,
  projectSnapshotManifestSchema,
  snapshotCursorSchema,
  type ProjectFileContentDto,
  type ProjectFileDto,
  type ProjectSnapshotDto,
  type SnapshotCursor,
} from "@app-planet/core";
import { createHash } from "node:crypto";
import type { TrustedSession } from "./http.ts";

type Query = Parameters<TrustedSession["write"]["runTransaction"]>[0] extends (query: infer T) => unknown ? T : never;
type ReadResult<T> =
  | { readonly outcome: "found"; readonly value: T }
  | { readonly outcome: "not_found" | "denied" | "invalid_input" | "too_large" | "already_exists"
      | "conflict" | "idempotency_key_reuse" | "unrecoverable" | "storage_limit" | "dependency_failure" };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function call<T>(
  session: TrustedSession,
  sql: string,
  values: string[],
  parse: (value: unknown) => T | null,
): Promise<ReadResult<T>> {
  try {
    return await session.write.runTransaction(async (query: Query): Promise<ReadResult<T>> => {
      const { rows } = await query.query(sql, values);
      if (rows.length !== 1 || !isRecord(rows[0]) || !Object.hasOwn(rows[0], "result")) {
        return { outcome: "dependency_failure" };
      }
      const result = rows[0].result;
      if (!isRecord(result) || typeof result.outcome !== "string") return { outcome: "dependency_failure" };
      if (result.outcome === "not_found" || result.outcome === "denied" ||
          result.outcome === "invalid_input" || result.outcome === "too_large" ||
          result.outcome === "already_exists" || result.outcome === "idempotency_key_reuse" ||
          result.outcome === "unrecoverable" || result.outcome === "storage_limit") {
        return { outcome: result.outcome };
      }
      if (result.outcome === "conflict") return { outcome: "conflict" };
      const parsed = parse(result);
      return parsed === null ? { outcome: "dependency_failure" } : { outcome: "found", value: parsed };
    });
  } catch {
    return { outcome: "dependency_failure" };
  }
}

export async function listOwnedProjectFiles(
  session: TrustedSession, projectId: string,
): Promise<ReadResult<ProjectFileDto[]>> {
  if (!isUuid(projectId)) return { outcome: "not_found" };
  return call(session, "SELECT app.read_project_files($1::uuid,NULL) AS result", [projectId],
    (value) => {
      if (!isRecord(value) || value.outcome !== "found") return null;
      const parsed = projectFileListSchema.safeParse({ items: value.items });
      return parsed.success ? parsed.data.items : null;
    });
}

export async function readOwnedProjectFile(
  session: TrustedSession, projectId: string, path: string,
): Promise<ReadResult<ProjectFileContentDto>> {
  if (!isUuid(projectId) || !projectFilePathSchema.safeParse(path).success) return { outcome: "not_found" };
  return call(session, "SELECT app.read_project_files($1::uuid,$2::text) AS result", [projectId, path],
    (value) => {
      if (!isRecord(value) || value.outcome !== "found") return null;
      const parsed = projectFileContentDtoSchema.safeParse(value.file);
      return parsed.success ? parsed.data : null;
    });
}

export async function writeOwnedProjectFile(
  session: TrustedSession,
  input: Readonly<{
    project_id: string; path: string; content: string; if_match: string | null;
    if_none_match: string | null; idempotency_key: string; replay_only: boolean;
  }>,
): Promise<ReadResult<Readonly<{ outcome: "saved" | "replayed"; created: boolean; file: ProjectFileDto }>>> {
  if (!isUuid(input.project_id) || !projectFilePathSchema.safeParse(input.path).success ||
      !/^[0-9a-f-]{36}$/i.test(input.idempotency_key)) return { outcome: "invalid_input" };
  return call(session,
    "SELECT app.write_project_file($1::uuid,$2::text,$3::text,nullif($4,'')::text,nullif($5,'')::text,$6::uuid,$7::boolean) AS result",
    [input.project_id,input.path,input.content,input.if_match ?? "",input.if_none_match ?? "",
      input.idempotency_key,String(input.replay_only)],
    (value) => {
      if (!isRecord(value) || (value.outcome !== "saved" && value.outcome !== "replayed") ||
          typeof value.created !== "boolean") return null;
      const parsed = projectFileContentDtoSchema.omit({ content: true }).safeParse(value.file);
      return parsed.success
        ? { outcome: value.outcome, created: value.created, file: parsed.data }
        : null;
    });
}

export async function createOwnedManualSnapshot(
  session: TrustedSession,
  input: Readonly<{ project_id: string; message: string | null; idempotency_key: string; replay_only: boolean }>,
): Promise<ReadResult<ProjectSnapshotDto & { readonly replayed: boolean }>> {
  if (!isUuid(input.project_id) || !/^[0-9a-f-]{36}$/i.test(input.idempotency_key)) {
    return { outcome: "invalid_input" };
  }
  return call(session,
    "SELECT app.create_manual_project_snapshot($1::uuid,nullif($2,'')::text,$3::uuid,$4::boolean) AS result",
    [input.project_id,input.message ?? "",input.idempotency_key,String(input.replay_only)],
    (value) => {
      if (!isRecord(value) || (value.outcome !== "created" && value.outcome !== "replayed")) return null;
      const parsed = projectSnapshotListSchema.shape.items.element.safeParse(value.snapshot);
      return parsed.success ? { ...parsed.data, replayed: value.outcome === "replayed" } : null;
    });
}

export async function listOwnedProjectSnapshots(
  session: TrustedSession, projectId: string, cursor: SnapshotCursor | null, limit: number,
): Promise<ReadResult<ReturnType<typeof projectSnapshotListSchema.parse>>> {
  if (!isUuid(projectId) || !Number.isInteger(limit) || limit < 1 || limit > 50) {
    return { outcome: "invalid_input" };
  }
  return call(session,
    "SELECT app.read_project_snapshots($1::uuid,nullif($2,'')::integer,nullif($3,'')::uuid,$4::integer) AS result",
    [projectId,cursor?.version_no.toString() ?? "",cursor?.id ?? "",String(limit)],
    (value) => {
      if (!isRecord(value) || value.outcome !== "found") return null;
      const next = value.next === null ? null : snapshotCursorSchema.safeParse(value.next);
      if (value.next !== null && (!next || !next.success)) return null;
      const nextCursor = value.next === null ? null
        : Buffer.from(JSON.stringify((next as { success: true; data: SnapshotCursor }).data)).toString("base64url");
      const parsed = projectSnapshotListSchema.safeParse({ items: value.items, next_cursor: nextCursor });
      return parsed.success ? parsed.data : null;
    });
}

export async function readOwnedProjectSnapshot(
  session: TrustedSession, projectId: string, snapshotId: string, path: string | null,
): Promise<ReadResult<unknown>> {
  if (!isUuid(projectId) || !isUuid(snapshotId) ||
      (path !== null && !projectFilePathSchema.safeParse(path).success)) return { outcome: "not_found" };
  return call(session,
    "SELECT app.read_project_snapshot($1::uuid,$2::uuid,nullif($3,'')::text) AS result",
    [projectId,snapshotId,path ?? ""],
    (value) => {
      if (!isRecord(value) || value.outcome !== "found") return null;
      const parsed = path === null
        ? projectSnapshotManifestSchema.safeParse({ snapshot: value.snapshot, files: value.files })
        : projectSnapshotFileSchema.safeParse(value.file);
      return parsed.success ? parsed.data : null;
    });
}

export async function listTeacherProjectSnapshots(
  session: TrustedSession,
  input: Readonly<{ student_id: string; project_id: string; cursor: SnapshotCursor | null; limit: number }>,
): Promise<ReadResult<ReturnType<typeof projectSnapshotListSchema.parse>>> {
  if (!isUuid(input.student_id) || !isUuid(input.project_id) ||
      !Number.isInteger(input.limit) || input.limit < 1 || input.limit > 50) return { outcome: "invalid_input" };
  return call(session,
    "SELECT app.read_teacher_project_snapshots($1::uuid,$2::uuid,nullif($3,'')::integer,nullif($4,'')::uuid,$5::integer,NULL,NULL) AS result",
    [input.student_id,input.project_id,input.cursor?.version_no.toString() ?? "",
      input.cursor?.id ?? "",String(input.limit)],
    (value) => parseSnapshotPage(value));
}

export async function readTeacherProjectSnapshot(
  session: TrustedSession,
  input: Readonly<{ student_id: string; project_id: string; snapshot_id: string; path: string | null }>,
): Promise<ReadResult<unknown>> {
  if (!isUuid(input.student_id) || !isUuid(input.project_id) || !isUuid(input.snapshot_id) ||
      (input.path !== null && !projectFilePathSchema.safeParse(input.path).success)) {
    return { outcome: "not_found" };
  }
  return call(session,
    "SELECT app.read_teacher_project_snapshots($1::uuid,$2::uuid,NULL,NULL,NULL,$3::uuid,nullif($4,'')::text) AS result",
    [input.student_id,input.project_id,input.snapshot_id,input.path ?? ""],
    (value) => {
      if (!isRecord(value) || value.outcome !== "found") return null;
      const parsed = input.path === null
        ? projectSnapshotManifestSchema.safeParse({ snapshot: value.snapshot, files: value.files })
        : projectSnapshotFileSchema.safeParse(value.file);
      return parsed.success ? parsed.data : null;
    });
}

export function decodeSnapshotCursor(value: string | null): SnapshotCursor | null | "invalid" {
  if (value === null || value === "") return null;
  if (!/^[A-Za-z0-9_-]{1,256}$/.test(value)) return "invalid";
  try {
    const parsed = snapshotCursorSchema.safeParse(JSON.parse(Buffer.from(value, "base64url").toString("utf8")));
    return parsed.success ? parsed.data : "invalid";
  } catch {
    return "invalid";
  }
}

function parseSnapshotPage(value: unknown): ReturnType<typeof projectSnapshotListSchema.parse> | null {
  if (!isRecord(value) || value.outcome !== "found") return null;
  const next = value.next === null ? null : snapshotCursorSchema.safeParse(value.next);
  if (value.next !== null && (!next || !next.success)) return null;
  const nextCursor = value.next === null ? null
    : Buffer.from(JSON.stringify((next as { success: true; data: SnapshotCursor }).data)).toString("base64url");
  const parsed = projectSnapshotListSchema.safeParse({ items: value.items, next_cursor: nextCursor });
  return parsed.success ? parsed.data : null;
}

export function snapshotContentHash(entries: Parameters<typeof canonicalSnapshotManifest>[0]): string {
  return createHash("sha256").update(canonicalSnapshotManifest(entries), "utf8").digest("hex");
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}
