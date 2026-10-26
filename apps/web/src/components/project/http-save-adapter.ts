import { z } from "zod";
import type { StageDraftDto } from "@app-planet/core";
import {
  problemJsonSchema,
  stageDraftContentSchema,
  stageDraftDtoSchema,
  versionConflictErrorCodeSchema,
} from "@app-planet/core";
import type { SaveSignal } from "../operation-presentation.ts";
import type {
  StageDraftSaveAdapter,
  StageDraftSaveRequest,
  StageDraftSaveResponse,
  StageDraftTarget,
} from "./save-controller.ts";

// 以 fetch 實作 StageDraftSaveAdapter：只送 Idempotency-Key／前置條件／內容，
// 不攜帶任何自報的 subject、role 或 school；身分由 server 端 session 決定。
export interface HttpSaveAdapterOptions {
  buildUrl(target: StageDraftTarget): string;
  fetchImpl?: typeof fetch;
  isOnline?: () => boolean;
  extraHeaders?: Readonly<Record<string, string>>;
  timeoutMs?: number;
}

export interface HttpSaveAdapter extends StageDraftSaveAdapter {
  readonly signal: SaveSignal;
}

const versionSchema = z.union([
  z.number().int().min(0).max(2_147_483_647),
  z.string().regex(/^(0|[1-9][0-9]{0,9})$/).transform(Number),
]);
const conflictSideSchema = z.strictObject({
  version: versionSchema,
  content: stageDraftContentSchema,
});
const conflictProblemSchema = problemJsonSchema.extend({
  code: versionConflictErrorCodeSchema,
  status: z.literal(409),
  conflict: z.strictObject({
    current: conflictSideSchema,
    submitted: conflictSideSchema,
  }),
}).strict();

function parseOperation(
  value: unknown,
  request: StageDraftSaveRequest,
): StageDraftDto | null {
  const parsed = stageDraftDtoSchema.safeParse(value);
  if (!parsed.success ||
      parsed.data.project_id.toLowerCase() !== request.project_id.toLowerCase() ||
      parsed.data.stage !== request.stage ||
      parsed.data.row_version !== (request.expected_row_version === null ? 0 : request.expected_row_version + 1) ||
      parsed.data.content.text !== request.content.text) return null;
  return parsed.data;
}

function parseCurrentDraft(
  value: unknown,
  operation: StageDraftDto,
  request: StageDraftSaveRequest,
): StageDraftDto | null | undefined {
  if (value === null) return null;
  const current = stageDraftDtoSchema.safeParse(value);
  if (!current.success ||
      current.data.project_id.toLowerCase() !== request.project_id.toLowerCase() ||
      current.data.stage !== request.stage ||
      current.data.row_version < operation.row_version ||
      (current.data.row_version === operation.row_version &&
        current.data.content.text !== operation.content.text)) return undefined;
  return current.data;
}

export function createHttpSaveAdapter(options: HttpSaveAdapterOptions): HttpSaveAdapter {
  let signal: SaveSignal = "none";
  const run = options.fetchImpl ?? ((input, init) => fetch(input, init));
  const online = options.isOnline ?? (() => typeof navigator === "undefined" || navigator.onLine !== false);

  return {
    get signal() { return signal; },
    async save(request: StageDraftSaveRequest): Promise<StageDraftSaveResponse> {
      signal = "none";
      const target: StageDraftTarget = { project_id: request.project_id, stage: request.stage };
      const respond = (result: StageDraftSaveResponse["result"]): StageDraftSaveResponse => ({ target, result });
      if (!online()) {
        signal = "unreachable";
        throw new Error("offline");
      }
      let response: Response;
      try {
        response = await run(options.buildUrl(target), {
          method: "PUT",
          credentials: "same-origin",
          cache: "no-store",
          headers: {
            ...options.extraHeaders,
            "content-type": "application/json",
            "idempotency-key": request.idempotency_key,
            ...(request.expected_row_version === null
              ? { "if-none-match": "*" }
              : { "if-match": `"${request.expected_row_version}"` }),
          },
          body: JSON.stringify({ content: { text: request.content.text } }),
          signal: AbortSignal.timeout(options.timeoutMs ?? 15_000),
        });
      } catch {
        // 連線中斷或逾時：COMMIT 是否發生未知，交由控制器保留原操作與鍵。
        signal = "unreachable";
        throw new Error("unreachable");
      }
      const body: unknown = await response.json().catch(() => null);

      if (response.status === 200 || response.status === 201) {
        if (response.headers.get("idempotent-replay") === "true") {
          if (response.status !== 200) throw new Error("invalid_response");
          const replay = z.strictObject({
            operation: z.unknown(),
            current_draft: z.unknown(),
          }).safeParse(body);
          if (!replay.success) throw new Error("invalid_response");
          const operation = parseOperation(replay.data.operation, request);
          if (!operation) throw new Error("invalid_response");
          const current = parseCurrentDraft(replay.data.current_draft, operation, request);
          if (current === undefined) throw new Error("invalid_response");
          return respond({
            outcome: "replayed", operation,
            current_draft: current ? { outcome: "found", draft: current } : { outcome: "not_found" },
          });
        }
        if (response.status !== (request.expected_row_version === null ? 201 : 200)) {
          throw new Error("invalid_response");
        }
        const operation = parseOperation(body, request);
        if (!operation) throw new Error("invalid_response");
        return respond({ outcome: "saved", operation });
      }
      if (response.ok) throw new Error("invalid_response");
      const problem = problemJsonSchema.safeParse(body);
      const code = problem.success ? problem.data.code : "";
      if (response.status === 401) { signal = "session_expired"; return respond({ outcome: "denied", reason: "policy_denied" }); }
      if (response.status === 403) return respond({ outcome: "denied", reason: "policy_denied" });
      if (response.status === 404) return respond({ outcome: "not_found" });
      if (response.status === 409 && code === "version_conflict") {
        const parsed = conflictProblemSchema.safeParse(body);
        if (!parsed.success) throw new Error("invalid_response");
        const conflict = parsed.data.conflict;
        if (request.expected_row_version === null ||
            conflict.current.version <= request.expected_row_version ||
            conflict.submitted.version !== request.expected_row_version ||
            conflict.submitted.content.text !== request.content.text) {
          throw new Error("invalid_response");
        }
        return respond({
          outcome: "conflict", reason: "version_conflict",
          conflict: {
            current: { version: conflict.current.version, content: { text: conflict.current.content.text } },
            submitted: { version: conflict.submitted.version, content: { text: conflict.submitted.content.text } },
          },
        });
      }
      if (response.status === 412 && code === "draft_already_exists") {
        if (request.expected_row_version !== null) throw new Error("invalid_response");
        return respond({ outcome: "conflict", reason: "draft_already_exists" });
      }
      if (response.status === 422 && code === "idempotency_key_reuse") {
        return respond({ outcome: "conflict", reason: "idempotency_mismatch" });
      }
      if (response.status === 400 || response.status === 413 || response.status === 415) {
        return respond({ outcome: "failed", reason: "invalid_input" });
      }
      if (code === "dependency_unavailable") signal = "dependency_unavailable";
      // 5xx 與其他情況一律視為結果未確認，可用同一鍵重試。
      return respond({ outcome: "failed", reason: "dependency_failure" });
    },
  };
}
