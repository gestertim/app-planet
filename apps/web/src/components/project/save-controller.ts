import {
  projectStageSchema,
  readStageDraftInputSchema,
  saveStageDraftInputSchema,
  stageDraftContentSchema,
  stageDraftDtoSchema,
  stageDraftIdempotencyKeySchema,
  type SaveStageDraftInput,
  type StageDraftDto,
} from "@app-planet/core";
import type { StageDraftSaveResult } from "../../server/stage-drafts.ts";

export type StageDraftTarget = Readonly<{
  project_id: string;
  stage: (typeof projectStageSchema.options)[number];
}>;

export type StageDraftSaveRequest = Readonly<Omit<SaveStageDraftInput, "content"> & {
  content: Readonly<SaveStageDraftInput["content"]>;
  idempotency_key: string;
}>;

export type StageDraftSaveResponse = Readonly<{
  target: StageDraftTarget;
  result: StageDraftSaveResult;
}>;

export interface StageDraftSaveAdapter {
  save(request: StageDraftSaveRequest): Promise<StageDraftSaveResponse>;
}

type SubmittedOperation = Readonly<{
  request: StageDraftSaveRequest;
}>;

type ConflictDetails = Readonly<{
  current: Readonly<{ version: number | null; content: Readonly<{ text: string }> | null }>;
  submitted: Readonly<{ version: number | null; content: Readonly<{ text: string }> }>;
}>;

type SafeFailureReason =
  | "invalid_input"
  | "invalid_operation_key"
  | "invalid_response"
  | "outcome_unknown"
  | "save_rejected"
  | "policy_denied"
  | "project_not_found"
  | "draft_already_exists"
  | "idempotency_conflict";

export type StageDraftSaveOperationState =
  | Readonly<{ status: "idle" }>
  | Readonly<{ status: "saving"; submitted: SubmittedOperation }>
  | Readonly<{
      status: "saved";
      receipt: StageDraftDto;
      currentDraft: StageDraftDto;
    }>
  | Readonly<{
      status: "replayed";
      receipt: StageDraftDto;
      currentDraft: StageDraftDto | null;
    }>
  | Readonly<{
      status: "failed";
      reason: SafeFailureReason;
      retryable: boolean;
      submitted: SubmittedOperation | null;
    }>
  | Readonly<{
      status: "conflict";
      conflict: ConflictDetails;
      submitted: SubmittedOperation;
    }>;

export interface StageDraftEditorState {
  target: StageDraftTarget;
  confirmedDraft: StageDraftDto | null;
  editorText: string;
  dirty: boolean;
  operation: StageDraftSaveOperationState;
}

export type StageDraftSaveAttempt =
  | Readonly<{ outcome: "saved" | "replayed" }>
  | Readonly<{ outcome: "conflict" }>
  | Readonly<{ outcome: "failed"; reason: SafeFailureReason }>
  | Readonly<{ outcome: "not_dirty" }>
  | Readonly<{ outcome: "blocked"; reason: "saving" | "retry_required" | "conflict" }>;

export type StageDraftSwitchChoice =
  | "save_then_switch"
  | "keep_and_stay"
  | "discard_and_switch";

export type StageDraftSwitchResult =
  | Readonly<{ outcome: "switched" }>
  | Readonly<{ outcome: "kept" }>
  | Readonly<{ outcome: "superseded" }>
  | Readonly<{ outcome: "blocked"; reason: "saving" | "retry_required" | "conflict" | "save_failed" | "still_dirty" }>;

export interface StageDraftSaveControllerOptions {
  adapter: StageDraftSaveAdapter;
  initialTarget: StageDraftTarget;
  initialDraft?: StageDraftDto | null;
  createOperationKey?: () => string;
}

interface MutableResource {
  target: StageDraftTarget;
  confirmedDraft: StageDraftDto | null;
  editorText: string;
  operation: StageDraftSaveOperationState;
  pendingSave: Promise<StageDraftSaveAttempt> | null;
}

type ParsedResponse =
  | Readonly<{ kind: "saved"; operation: StageDraftDto }>
  | Readonly<{ kind: "replayed"; operation: StageDraftDto; currentDraft: StageDraftDto | null }>
  | Readonly<{ kind: "conflict"; conflict: ConflictDetails }>
  | Readonly<{ kind: "failed"; reason: SafeFailureReason; retryable: boolean }>;

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const idleOperation: StageDraftSaveOperationState = Object.freeze({ status: "idle" });

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function freezeTarget(target: StageDraftTarget): StageDraftTarget {
  return Object.freeze({ project_id: target.project_id.toLowerCase(), stage: target.stage });
}

function parseTarget(value: unknown): StageDraftTarget | null {
  if (!isRecord(value) || !hasExactKeys(value, ["project_id", "stage"])) return null;
  const parsed = readStageDraftInputSchema.safeParse({
    project_id: value.project_id,
    stage: value.stage,
  });
  return parsed.success ? freezeTarget(parsed.data) : null;
}

function targetKey(target: StageDraftTarget): string {
  return `${target.project_id.toLowerCase()}\u0000${target.stage}`;
}

function freezeDraft(value: unknown, target: StageDraftTarget): StageDraftDto | null {
  const parsed = stageDraftDtoSchema.safeParse(value);
  if (!parsed.success ||
      parsed.data.project_id.toLowerCase() !== target.project_id ||
      parsed.data.stage !== target.stage) return null;
  return Object.freeze({
    ...parsed.data,
    project_id: parsed.data.project_id.toLowerCase(),
    content: Object.freeze({ text: parsed.data.content.text }),
  });
}

function makeDraft(
  target: StageDraftTarget,
  version: number,
  text: string,
): StageDraftDto {
  return Object.freeze({
    project_id: target.project_id,
    stage: target.stage,
    row_version: version,
    state: "ai_draft",
    content_source: "student_input",
    content: Object.freeze({ text }),
    approved_by: null,
    approved_at: null,
  });
}

function freezeSubmission(request: StageDraftSaveRequest): SubmittedOperation {
  return Object.freeze({
    request: Object.freeze({
      ...request,
      content: Object.freeze({ text: request.content.text }),
    }),
  });
}

function freezeConflict(conflict: ConflictDetails): ConflictDetails {
  const current = Object.freeze({
    version: conflict.current.version,
    content: conflict.current.content
      ? Object.freeze({ text: conflict.current.content.text })
      : null,
  });
  return Object.freeze({
    current,
    submitted: Object.freeze({
      version: conflict.submitted.version,
      content: Object.freeze({ text: conflict.submitted.content.text }),
    }),
  });
}

function versionAndTextMatchKnownCurrent(
  candidate: StageDraftDto,
  current: StageDraftDto | null,
): boolean {
  if (!current) return true;
  if (candidate.row_version < current.row_version) return false;
  return candidate.row_version !== current.row_version ||
    candidate.content.text === current.content.text;
}

function parseCurrentDraft(
  value: unknown,
  target: StageDraftTarget,
  operation: StageDraftDto,
): StageDraftDto | null | undefined {
  if (!isRecord(value) || typeof value.outcome !== "string") return undefined;
  switch (value.outcome) {
    case "found": {
      if (!hasExactKeys(value, ["outcome", "draft"])) return undefined;
      const current = freezeDraft(value.draft, target);
      if (!current || current.row_version < operation.row_version) return undefined;
      if (current.row_version === operation.row_version &&
          current.content.text !== operation.content.text) return undefined;
      return current;
    }
    case "not_found":
      return hasExactKeys(value, ["outcome"]) ? null : undefined;
    case "denied":
      return hasExactKeys(value, ["outcome", "reason"]) && value.reason === "policy_denied"
        ? null
        : undefined;
    case "failed":
      return hasExactKeys(value, ["outcome", "reason"]) &&
        ["invalid_input", "invalid_context", "invalid_result", "dependency_failure", "version_exhausted"]
          .includes(String(value.reason))
        ? null
        : undefined;
    default:
      return undefined;
  }
}

function parseConflict(
  value: unknown,
  target: StageDraftTarget,
  request: StageDraftSaveRequest,
  knownCurrent: StageDraftDto | null,
): ConflictDetails | null {
  if (!isRecord(value) || !hasExactKeys(value, ["current", "submitted"]) ||
      !isRecord(value.current) || !isRecord(value.submitted) ||
      !hasExactKeys(value.current, ["version", "content"]) ||
      !hasExactKeys(value.submitted, ["version", "content"])) return null;

  const submittedContent = stageDraftDtoContent(value.submitted.content);
  if (!submittedContent ||
      value.submitted.version !== request.expected_row_version ||
      submittedContent.text !== request.content.text) return null;

  let currentVersion: number | null;
  let currentContent: Readonly<{ text: string }> | null;
  if (value.current.version === null && value.current.content === null) {
    if (request.expected_row_version === null || knownCurrent !== null) return null;
    currentVersion = null;
    currentContent = null;
  } else {
    const content = stageDraftDtoContent(value.current.content);
    if (!content || typeof value.current.version !== "number" ||
        !Number.isInteger(value.current.version) ||
        value.current.version < 0 || value.current.version > 2147483647 ||
        value.current.version === request.expected_row_version) return null;
    currentVersion = value.current.version;
    currentContent = Object.freeze({ text: content.text });
    if (knownCurrent && (
      currentVersion < knownCurrent.row_version ||
      (currentVersion === knownCurrent.row_version && currentContent.text !== knownCurrent.content.text)
    )) return null;
  }
  return freezeConflict({
    current: { version: currentVersion, content: currentContent },
    submitted: {
      version: request.expected_row_version,
      content: { text: submittedContent.text },
    },
  });
}

function stageDraftDtoContent(value: unknown): { text: string } | null {
  const parsed = stageDraftContentSchema.safeParse(value);
  return parsed.success ? { text: parsed.data.text } : null;
}

function parseResponse(
  value: unknown,
  submitted: SubmittedOperation,
  knownCurrent: StageDraftDto | null,
): ParsedResponse | null {
  const request = submitted.request;
  const target = { project_id: request.project_id.toLowerCase(), stage: request.stage };
  if (!isRecord(value) ||
      !hasExactKeys(value, ["target", "result"]) ||
      !isRecord(value.result)) return null;
  const responseTarget = parseTarget(value.target);
  if (!responseTarget || targetKey(responseTarget) !== targetKey(target)) return null;

  const result = value.result;
  switch (result.outcome) {
    case "saved":
    case "replayed": {
      const keys = result.outcome === "saved"
        ? ["outcome", "operation"]
        : ["outcome", "operation", "current_draft"];
      if (!hasExactKeys(result, keys)) return null;
      const operation = freezeDraft(result.operation, target);
      const expectedVersion = request.expected_row_version === null
        ? 0
        : request.expected_row_version + 1;
      if (!operation ||
          operation.content.text !== request.content.text ||
          operation.row_version !== expectedVersion) return null;
      if (result.outcome === "saved") {
        return versionAndTextMatchKnownCurrent(operation, knownCurrent)
          ? { kind: "saved", operation }
          : null;
      }
      const currentDraft = parseCurrentDraft(result.current_draft, target, operation);
      if (currentDraft === undefined ||
          (currentDraft && !versionAndTextMatchKnownCurrent(currentDraft, knownCurrent))) return null;
      return { kind: "replayed", operation, currentDraft };
    }
    case "conflict": {
      if (result.reason === "version_conflict" &&
          hasExactKeys(result, ["outcome", "reason", "conflict"])) {
        const conflict = parseConflict(result.conflict, target, request, knownCurrent);
        return conflict ? { kind: "conflict", conflict } : null;
      }
      if (result.reason === "idempotency_mismatch" &&
          hasExactKeys(result, ["outcome", "reason"])) {
        return { kind: "failed", reason: "idempotency_conflict", retryable: false };
      }
      if (result.reason === "draft_already_exists" && request.expected_row_version === null &&
          hasExactKeys(result, ["outcome", "reason"])) {
        return { kind: "failed", reason: "draft_already_exists", retryable: false };
      }
      return null;
    }
    case "failed":
      if (!hasExactKeys(result, ["outcome", "reason"]) ||
          !["invalid_input", "invalid_context", "invalid_result", "dependency_failure", "version_exhausted"]
            .includes(String(result.reason))) return null;
      return result.reason === "dependency_failure"
        ? { kind: "failed", reason: "outcome_unknown", retryable: true }
        : { kind: "failed", reason: "save_rejected", retryable: false };
    case "denied":
      return hasExactKeys(result, ["outcome", "reason"]) && result.reason === "policy_denied"
        ? { kind: "failed", reason: "policy_denied", retryable: false }
        : null;
    case "not_found":
      return hasExactKeys(result, ["outcome"])
        ? { kind: "failed", reason: "project_not_found", retryable: false }
        : null;
    default:
      return null;
  }
}

function defaultCreateOperationKey(): string {
  return globalThis.crypto.randomUUID();
}

export class StageDraftSaveController {
  private readonly resources = new Map<string, MutableResource>();
  private readonly listeners = new Set<() => void>();
  private readonly createOperationKey: () => string;
  private activeTarget: StageDraftTarget;
  private switchIntentSequence = 0;

  constructor(private readonly options: StageDraftSaveControllerOptions) {
    const initialTarget = parseTarget(options.initialTarget);
    if (!initialTarget) throw new TypeError("invalid_initial_target");
    this.createOperationKey = options.createOperationKey ?? defaultCreateOperationKey;
    this.activeTarget = initialTarget;
    const initialDraft = options.initialDraft
      ? freezeDraft(options.initialDraft, initialTarget)
      : null;
    if (options.initialDraft && !initialDraft) throw new TypeError("invalid_initial_draft");
    this.resources.set(targetKey(initialTarget), {
      target: initialTarget,
      confirmedDraft: initialDraft,
      editorText: initialDraft?.content.text ?? "",
      operation: idleOperation,
      pendingSave: null,
    });
  }

  getActiveTarget(): StageDraftTarget {
    return Object.freeze({ ...this.activeTarget });
  }

  getState(target?: StageDraftTarget): StageDraftEditorState {
    const resource = this.getResource(target ?? this.activeTarget);
    const confirmedDraft = resource.confirmedDraft;
    return Object.freeze({
      target: Object.freeze({ ...resource.target }),
      confirmedDraft,
      editorText: resource.editorText,
      dirty: confirmedDraft
        ? resource.editorText !== confirmedDraft.content.text
        : resource.editorText !== "",
      operation: resource.operation,
    });
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  edit(text: string, target?: StageDraftTarget): void {
    if (typeof text !== "string") throw new TypeError("invalid_editor_text");
    const resource = this.getResource(target ?? this.activeTarget);
    resource.editorText = text;
    this.emit();
  }

  async save(target?: StageDraftTarget): Promise<StageDraftSaveAttempt> {
    const resource = this.getResource(target ?? this.activeTarget);
    if (resource.operation.status === "saving") {
      return { outcome: "blocked", reason: "saving" };
    }
    if (resource.operation.status === "failed" && resource.operation.retryable) {
      return { outcome: "blocked", reason: "retry_required" };
    }
    if (resource.operation.status === "failed" && resource.operation.reason === "draft_already_exists") {
      return { outcome: "blocked", reason: "conflict" };
    }
    if (resource.operation.status === "conflict") {
      return { outcome: "blocked", reason: "conflict" };
    }

    const state = this.getState(resource.target);
    if (!state.dirty && resource.confirmedDraft) return { outcome: "not_dirty" };
    const parsedInput = saveStageDraftInputSchema.safeParse({
      ...resource.target,
      expected_row_version: resource.confirmedDraft?.row_version ?? null,
      content: { text: resource.editorText },
    });
    if (!parsedInput.success) {
      resource.operation = Object.freeze({
        status: "failed",
        reason: "invalid_input",
        retryable: false,
        submitted: null,
      });
      this.emit();
      return { outcome: "failed", reason: "invalid_input" };
    }
    const parsedKey = stageDraftIdempotencyKeySchema.safeParse(this.createOperationKey());
    if (!parsedKey.success) {
      resource.operation = Object.freeze({
        status: "failed",
        reason: "invalid_operation_key",
        retryable: false,
        submitted: null,
      });
      this.emit();
      return { outcome: "failed", reason: "invalid_operation_key" };
    }
    const request = Object.freeze({
      ...parsedInput.data,
      content: Object.freeze({ text: parsedInput.data.content.text }),
      idempotency_key: parsedKey.data,
    });
    return this.startSave(resource, freezeSubmission(request));
  }

  async retry(target?: StageDraftTarget): Promise<StageDraftSaveAttempt> {
    const resource = this.getResource(target ?? this.activeTarget);
    if (resource.operation.status !== "failed" ||
        !resource.operation.retryable ||
        !resource.operation.submitted) {
      return { outcome: "blocked", reason: "retry_required" };
    }
    return this.startSave(resource, resource.operation.submitted);
  }

  resolveConflict(action: "keep_local" | "use_current", target?: StageDraftTarget): void {
    const resource = this.getResource(target ?? this.activeTarget);
    if (resource.operation.status !== "conflict") return;
    if (action === "use_current") {
      resource.editorText = resource.confirmedDraft?.content.text ?? "";
    }
    resource.operation = idleOperation;
    this.emit();
  }

  compareExistingDraft(value: StageDraftDto, target?: StageDraftTarget): void {
    const resource = this.getResource(target ?? this.activeTarget);
    if (resource.operation.status !== "failed" ||
        resource.operation.reason !== "draft_already_exists" ||
        !resource.operation.submitted) throw new TypeError("no_existing_draft_conflict");
    const current = freezeDraft(value, resource.target);
    if (!current) throw new TypeError("invalid_current_draft");
    const submitted = resource.operation.submitted;
    resource.confirmedDraft = current;
    resource.operation = Object.freeze({
      status: "conflict",
      conflict: freezeConflict({
        current: { version: current.row_version, content: current.content },
        submitted: { version: null, content: submitted.request.content },
      }),
      submitted,
    });
    this.emit();
  }

  rejectCurrentAccess(reason: "policy_denied" | "project_not_found", target?: StageDraftTarget): void {
    const resource = this.getResource(target ?? this.activeTarget);
    resource.confirmedDraft = null;
    resource.operation = Object.freeze({ status: "failed", reason, retryable: false, submitted: null });
    this.emit();
  }

  async requestSwitch(
    target: StageDraftTarget,
    choice: StageDraftSwitchChoice,
  ): Promise<StageDraftSwitchResult> {
    const nextTarget = parseTarget(target);
    if (!nextTarget) return { outcome: "blocked", reason: "save_failed" };
    const intentSequence = ++this.switchIntentSequence;
    if (targetKey(nextTarget) === targetKey(this.activeTarget)) return { outcome: "switched" };
    const resource = this.getResource(this.activeTarget);
    const state = this.getState(resource.target);
    const hasConflict = resource.operation.status === "conflict";

    if (hasConflict) {
      if (choice === "keep_and_stay") return { outcome: "kept" };
      if (choice === "save_then_switch") return { outcome: "blocked", reason: "conflict" };
      resource.editorText = resource.confirmedDraft?.content.text ?? "";
      resource.operation = idleOperation;
      this.activate(nextTarget);
      return { outcome: "switched" };
    }

    if (!state.dirty) {
      this.activate(nextTarget);
      return { outcome: "switched" };
    }
    if (choice === "keep_and_stay") return { outcome: "kept" };
    if (choice === "discard_and_switch") {
      if (resource.operation.status === "saving") return { outcome: "blocked", reason: "saving" };
      resource.editorText = resource.confirmedDraft?.content.text ?? "";
      if (!(resource.operation.status === "failed" && resource.operation.retryable)) {
        resource.operation = idleOperation;
      }
      this.activate(nextTarget);
      return { outcome: "switched" };
    }

    let result: StageDraftSaveAttempt;
    if (resource.operation.status === "saving") {
      if (!resource.pendingSave) return { outcome: "blocked", reason: "saving" };
      result = await resource.pendingSave;
    } else {
      result = await this.save(resource.target);
    }
    if (intentSequence !== this.switchIntentSequence) return { outcome: "superseded" };
    if (result.outcome === "conflict") return { outcome: "blocked", reason: "conflict" };
    if (result.outcome === "failed") return { outcome: "blocked", reason: "save_failed" };
    if (result.outcome !== "saved" && result.outcome !== "replayed") {
      if (result.outcome === "blocked" && result.reason === "saving") {
        return { outcome: "blocked", reason: "saving" };
      }
      if (result.outcome === "blocked" && result.reason === "retry_required") {
        return { outcome: "blocked", reason: "retry_required" };
      }
      if (result.outcome === "blocked" && result.reason === "conflict") {
        return { outcome: "blocked", reason: "conflict" };
      }
      return { outcome: "blocked", reason: "still_dirty" };
    }
    if (this.getState(resource.target).dirty) return { outcome: "blocked", reason: "still_dirty" };
    this.activate(nextTarget);
    return { outcome: "switched" };
  }

  private async performSave(
    resource: MutableResource,
    submitted: SubmittedOperation,
  ): Promise<StageDraftSaveAttempt> {
    let adapterResponse: StageDraftSaveResponse;
    try {
      adapterResponse = await this.options.adapter.save(submitted.request);
    } catch {
      resource.operation = Object.freeze({
        status: "failed",
        reason: "outcome_unknown",
        retryable: true,
        submitted,
      });
      this.emit();
      return { outcome: "failed", reason: "outcome_unknown" };
    }

    const parsed = parseResponse(adapterResponse, submitted, resource.confirmedDraft);
    if (!parsed) {
      resource.operation = Object.freeze({
        status: "failed",
        reason: "invalid_response",
        retryable: true,
        submitted,
      });
      this.emit();
      return { outcome: "failed", reason: "invalid_response" };
    }

    switch (parsed.kind) {
      case "saved":
        resource.confirmedDraft = parsed.operation;
        resource.operation = Object.freeze({
          status: "saved",
          receipt: parsed.operation,
          currentDraft: parsed.operation,
        });
        this.emit();
        return { outcome: "saved" };
      case "replayed":
        resource.confirmedDraft = parsed.currentDraft;
        resource.operation = Object.freeze({
          status: "replayed",
          receipt: freezeDraft(parsed.operation, resource.target)!,
          currentDraft: parsed.currentDraft,
        });
        this.emit();
        return { outcome: "replayed" };
      case "conflict": {
        const { current } = parsed.conflict;
        resource.confirmedDraft = current.version === null || current.content === null
          ? null
          : makeDraft(resource.target, current.version, current.content.text);
        resource.operation = Object.freeze({
          status: "conflict",
          conflict: parsed.conflict,
          submitted,
        });
        this.emit();
        return { outcome: "conflict" };
      }
      case "failed":
        resource.operation = Object.freeze({
          status: "failed",
          reason: parsed.reason,
          retryable: parsed.retryable,
          submitted: parsed.retryable || parsed.reason === "draft_already_exists" ? submitted : null,
        });
        this.emit();
        return { outcome: "failed", reason: parsed.reason };
    }
  }

  private startSave(
    resource: MutableResource,
    submitted: SubmittedOperation,
  ): Promise<StageDraftSaveAttempt> {
    let resolvePending!: (result: StageDraftSaveAttempt) => void;
    let rejectPending!: (reason?: unknown) => void;
    const pendingSave = new Promise<StageDraftSaveAttempt>((resolve, reject) => {
      resolvePending = resolve;
      rejectPending = reject;
    });
    resource.pendingSave = pendingSave;
    resource.operation = Object.freeze({ status: "saving", submitted });
    this.emit();
    const saveResult = this.performSave(resource, submitted);
    void saveResult.then(resolvePending, rejectPending);
    const clearPending = () => {
      if (resource.pendingSave === pendingSave) resource.pendingSave = null;
    };
    void pendingSave.then(clearPending, clearPending);
    return pendingSave;
  }

  private getResource(targetValue: StageDraftTarget): MutableResource {
    const target = parseTarget(targetValue);
    if (!target) throw new TypeError("invalid_stage_draft_target");
    const key = targetKey(target);
    let resource = this.resources.get(key);
    if (!resource) {
      resource = {
        target,
        confirmedDraft: null,
        editorText: "",
        operation: idleOperation,
        pendingSave: null,
      };
      this.resources.set(key, resource);
    }
    return resource;
  }

  private activate(target: StageDraftTarget): void {
    this.activeTarget = target;
    this.emit();
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}
