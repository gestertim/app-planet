import { z } from "zod";

export const createIntentSchema = z.strictObject({
  v: z.literal(3),
  key: z.uuid(),
  payload: z.strictObject({ title: z.string(), tier: z.enum(["A", "B"]).optional() }),
});
export type CreateIntent = z.infer<typeof createIntentSchema>;

export type ParsedStoredIntent =
  | { kind: "intent"; intent: CreateIntent }
  | { kind: "unusable"; reason: "legacy" | "invalid"; operationId: string | null };

export interface StoredIntentSources {
  session: string | null;
  local: string | null;
}

export type ResolvedStoredIntent =
  | { kind: "empty" }
  | { kind: "intent"; intent: CreateIntent; sources: StoredIntentSources }
  | { kind: "unusable"; reason: "legacy" | "invalid" | "conflict"; operationIds: string[] };

export interface IntentStorage {
  getItem(key: string): string | null;
  removeItem(key: string): void;
}

const previousSchema = z.strictObject({
  v: z.literal(2),
  key: z.uuid(),
  payload: z.strictObject({ title: z.string() }),
  started_server_ms: z.number().int().min(Date.UTC(2020, 0, 1)).max(Date.UTC(2100, 0, 1)),
});
const legacySchema = z.strictObject({ key: z.uuid(), payload: z.strictObject({ title: z.string() }) });

export function parseStoredIntent(raw: string): ParsedStoredIntent {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { kind: "unusable", reason: "invalid", operationId: null };
  }
  const current = createIntentSchema.safeParse(value);
  if (current.success) return { kind: "intent", intent: current.data };
  const previous = previousSchema.safeParse(value);
  if (previous.success) {
    return {
      kind: "intent",
      intent: { v: 3, key: previous.data.key, payload: previous.data.payload },
    };
  }
  const legacy = legacySchema.safeParse(value);
  if (legacy.success) return { kind: "unusable", reason: "legacy", operationId: legacy.data.key };
  const key = typeof value === "object" && value !== null && "key" in value ? z.uuid().safeParse(value.key) : null;
  return { kind: "unusable", reason: "invalid", operationId: key?.success ? key.data : null };
}

export function resolveStoredIntents(
  sessionRaw: string | null,
  localRaw: string | null,
): ResolvedStoredIntent {
  if (sessionRaw === null && localRaw === null) return { kind: "empty" };

  const parsed = [sessionRaw, localRaw]
    .filter((raw): raw is string => raw !== null)
    .map(parseStoredIntent);
  const operationIds = parsed.flatMap((entry) =>
    entry.kind === "intent" ? [entry.intent.key] : entry.operationId ? [entry.operationId] : []);
  const unusable = parsed.find((entry) => entry.kind === "unusable");
  if (unusable) return { kind: "unusable", reason: unusable.reason, operationIds };

  const intents = parsed.flatMap((entry) => entry.kind === "intent" ? [entry.intent] : []);
  const selected = intents[0];
  if (!selected || intents.some((entry) =>
    entry.key !== selected.key || entry.payload.title !== selected.payload.title ||
    entry.payload.tier !== selected.payload.tier)) {
    return { kind: "unusable", reason: "conflict", operationIds };
  }
  return { kind: "intent", intent: selected, sources: { session: sessionRaw, local: localRaw } };
}

export function removeIntentIfUnchanged(
  storage: IntentStorage,
  key: string,
  expectedRaw: string | null,
): boolean {
  if (storage.getItem(key) !== expectedRaw) return false;
  if (expectedRaw !== null) storage.removeItem(key);
  return storage.getItem(key) === null;
}

export type IntentClearResult = "cleared" | "changed" | "failed";

// 只清除「本次操作快照」所對應的兩個儲存位置；任一位置已被替換或讀寫失敗即保留紀錄。
export function clearIntentSnapshot(
  session: IntentStorage,
  local: IntentStorage,
  key: string,
  sources: StoredIntentSources,
): IntentClearResult {
  try {
    return removeIntentIfUnchanged(session, key, sources.session) &&
      removeIntentIfUnchanged(local, key, sources.local)
      ? "cleared"
      : "changed";
  } catch {
    return "failed";
  }
}

export function shortOperationId(key: string | null): string {
  return key ? key.slice(0, 8) : "未知";
}
