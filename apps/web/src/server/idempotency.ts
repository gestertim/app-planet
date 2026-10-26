import { createHash } from "node:crypto";
import { idempotencyKeySchema } from "@app-planet/core";

// COMMON：會改變狀態或扣額的 POST 必須帶 UUID Idempotency-Key。鍵的保存、作用域與同鍵異意圖拒絕由
// 資料庫約束／交易負責（P-1／stage_draft_save_v1／usage_reserve）；本模組不保留程序記憶體狀態，
// 也不核定新的 TTL 或解鎖政策。

export type IdempotencyKeyResult =
  | { readonly ok: true; readonly key: string }
  | { readonly ok: false; readonly code: "idempotency_key_required" | "invalid_idempotency_key" };

export function readIdempotencyKey(headers: Headers): IdempotencyKeyResult {
  const raw = headers.get("idempotency-key");
  if (raw === null) return { ok: false, code: "idempotency_key_required" };
  // 重複標頭會被 Headers 以逗號合併，因此不會通過 UUID 檢查。
  const parsed = idempotencyKeySchema.safeParse(raw);
  return parsed.success
    ? { ok: true, key: parsed.data.toLowerCase() }
    : { ok: false, code: "invalid_idempotency_key" };
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "number") {
    if (typeof value === "number" && !Number.isFinite(value)) throw new TypeError("non_finite");
    return JSON.stringify(value);
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (typeof value === "object" && value !== undefined) {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalize(record[key])}`).join(",")}}`;
  }
  throw new TypeError("unsupported_value");
}

export interface IntentParts {
  readonly method: string;
  // 已解析的目標（路徑參數），不含 query string 或原始 URL。
  readonly target: Readonly<Record<string, string>>;
  // If-Match 與冪等互不取代，兩者都進指紋。
  readonly ifMatch: string | null;
  // 只放端點允許的本文欄位；不 trim／正規化，字串逐位元保留。
  readonly allowedBody: unknown;
}

// 供客戶端判斷「同一意圖」與伺服器端比對；只保存雜湊，不保存請求本文。
export function intentFingerprint(parts: IntentParts): string {
  const canonical = canonicalize([
    "app-planet-intent-v1", parts.method.toUpperCase(), parts.target, parts.ifMatch, parts.allowedBody,
  ]);
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

// D-32：登入碼等秘密回應不可套用一般重播；只回最小非秘密 receipt。
export type ReplayPolicy = "plain_result" | "secret_receipt_only";

export function selectReplayPayload<TResult, TReceipt>(
  policy: ReplayPolicy,
  stored: { readonly result: TResult; readonly receipt: TReceipt },
): TResult | TReceipt {
  return policy === "plain_result" ? stored.result : stored.receipt;
}

export type GuardedOutcome<T> =
  | { readonly state: "completed"; readonly value: T }
  // 交易可能已提交；不得當失敗盲目重做。只能以同一鍵重送，由資料庫重放或回報原結果。
  | { readonly state: "unknown" };

// 任何非業務結果的例外（連線中斷、COMMIT 未確認、回應解析失敗）都視為結果不確定。
export async function runGuarded<T>(operation: () => Promise<T>): Promise<GuardedOutcome<T>> {
  try {
    return { state: "completed", value: await operation() };
  } catch {
    return { state: "unknown" };
  }
}
