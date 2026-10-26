import { z } from "zod";
import { compareUtcInstants, utcInstantSchema } from "./common.ts";
import type { WorksCspMode } from "../policy/works-csp.ts";
import { containsSensitiveText } from "../policy/sensitive-text.ts";

// PUB §3.7（D-23）的 A1 預覽會話、B2 Work Data API 授權與方案 X 產物契約，只含 schema 與純判斷。
// 不簽章、不驗章、不簽發權杖、不處理請求；TTL／撤銷上界／配額／key 輪替／產物限制屬未核定政策（PP-20～PP-27），
// 全部由呼叫端以明確輸入提供，缺值一律拒絕，未核定功能維持關閉。

const sha256HexSchema = z.string().regex(/^[0-9a-f]{64}$/);
const opaqueIdSchema = z
  .string()
  .min(1)
  .refine((value) => !containsSensitiveText(value), "含已知敏感形狀");

// ---- A1 預覽會話 ----

export const previewSessionStateSchema = z.enum(["issued", "active", "expired", "revoked"]);
export type PreviewSessionState = z.infer<typeof previewSessionStateSchema>;

export const previewSessionCookieName = "__Host-preview_session";
export const previewSessionCookieAttributes = Object.freeze([
  "Path=/",
  "Secure",
  "HttpOnly",
  "SameSite=None",
  "Partitioned",
] as const);
// 兌換成功回應必須帶的標頭；cookie 不設 Domain。
export const previewRedeemResponseHeaders = Object.freeze({
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
} as const);

const cookieValuePattern = /^[A-Za-z0-9_-]+$/;

export type BuildPreviewSessionCookieResult =
  | { ok: true; setCookie: string }
  | { ok: false; code: "invalid_cookie_value" };

// 值只能是不可猜測的會話識別（base64url 字元）；熵與長度由簽發端負責，這裡不宣稱可驗證。
export function buildPreviewSessionSetCookie(value: unknown): BuildPreviewSessionCookieResult {
  if (typeof value !== "string" || !cookieValuePattern.test(value)) {
    return { ok: false, code: "invalid_cookie_value" };
  }
  return {
    ok: true,
    setCookie: [`${previewSessionCookieName}=${value}`, ...previewSessionCookieAttributes].join("; "),
  };
}

export const previewRequestFactsSchema = z.strictObject({
  ttlPolicyApproved: z.boolean(),
  sessionState: z.union([previewSessionStateSchema, z.literal("unknown")]),
  expiresAt: utcInstantSchema.nullable(),
  now: utcInstantSchema,
  principalValid: z.boolean(),
  teacherBindingValid: z.boolean(),
  accountActive: z.boolean(),
  artifactBindingValid: z.boolean(),
});
export type PreviewRequestFacts = z.infer<typeof previewRequestFactsSchema>;

export type PreviewDenyReason =
  | "invalid_facts"
  | "policy_not_approved"
  | "session_not_active"
  | "session_expired"
  | "principal_invalid"
  | "teacher_binding_invalid"
  | "account_inactive"
  | "artifact_binding_invalid";

// 對外一律只有 allow／denied：未知、未兌換、過期、撤銷與無效 cookie 不可區分（不洩漏會話存在性）；
// internalReason 只供去敏診斷，不得放進回應。
export type PreviewRequestDecision =
  | { outcome: "allow" }
  | { outcome: "denied"; internalReason: PreviewDenyReason };

export function decidePreviewRequest(factsInput: unknown): PreviewRequestDecision {
  const parsed = previewRequestFactsSchema.safeParse(factsInput);
  if (!parsed.success) {
    return { outcome: "denied", internalReason: "invalid_facts" };
  }
  const facts = parsed.data;
  if (!facts.ttlPolicyApproved) {
    return { outcome: "denied", internalReason: "policy_not_approved" };
  }
  if (facts.sessionState !== "active") {
    return { outcome: "denied", internalReason: "session_not_active" };
  }
  const order = facts.expiresAt === null ? null : compareUtcInstants(facts.now, facts.expiresAt);
  if (order === null || order >= 0) {
    return { outcome: "denied", internalReason: "session_expired" };
  }
  if (!facts.principalValid) {
    return { outcome: "denied", internalReason: "principal_invalid" };
  }
  if (!facts.teacherBindingValid) {
    return { outcome: "denied", internalReason: "teacher_binding_invalid" };
  }
  if (!facts.accountActive) {
    return { outcome: "denied", internalReason: "account_inactive" };
  }
  if (!facts.artifactBindingValid) {
    return { outcome: "denied", internalReason: "artifact_binding_invalid" };
  }
  return { outcome: "allow" };
}

// ---- B2 Work Data API 授權 claims（驗章由標準實作負責，不在此自製密碼學）----

export const workDataKeyIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);

export const workDataClaimsSchema = z.strictObject({
  listing_id: z.uuid(),
  purpose: z.string().regex(/^[a-z][a-z0-9_]*$/),
  // 依 COMMON 時間通則使用 UTC ISO 8601（Z）；token 外層編碼由簽章標準實作決定。
  exp: utcInstantSchema,
  authorization_id: opaqueIdSchema,
  revocation_version: z.number().int().nonnegative(),
});
export type WorkDataClaims = z.infer<typeof workDataClaimsSchema>;

export const workDataAuthorizationSchema = z.strictObject({
  key_id: workDataKeyIdSchema,
  claims: workDataClaimsSchema,
});
export type WorkDataAuthorization = z.infer<typeof workDataAuthorizationSchema>;

export const workDataExpectationSchema = z.strictObject({
  trustedKeyIds: z.array(workDataKeyIdSchema),
  // 受核定的用途集合；未核定（空）不得啟用任何資料授權。
  allowedPurposes: z.array(z.string().regex(/^[a-z][a-z0-9_]*$/)),
  now: utcInstantSchema,
  listingId: z.uuid(),
  purpose: z.string().regex(/^[a-z][a-z0-9_]*$/),
  listingLive: z.boolean(),
  currentRevocationVersion: z.number().int().nonnegative(),
});

export type WorkDataDenyReason =
  | "invalid_input"
  | "purposes_not_approved"
  | "unknown_key_id"
  | "listing_not_live"
  | "listing_mismatch"
  | "purpose_not_allowed"
  | "purpose_mismatch"
  | "expired"
  | "revoked";

export type WorkDataAuthorizationDecision =
  | { outcome: "allow" }
  | { outcome: "denied"; internalReason: WorkDataDenyReason };

const denied = (internalReason: WorkDataDenyReason): WorkDataAuthorizationDecision => ({
  outcome: "denied",
  internalReason,
});

// 平台每筆資料請求都要重驗；通過本函式不代表可跳過配額、限流與受限 RPC。
export function evaluateVerifiedWorkDataAuthorization(
  authorizationInput: unknown,
  expectationInput: unknown,
): WorkDataAuthorizationDecision {
  const authorization = workDataAuthorizationSchema.safeParse(authorizationInput);
  const expectation = workDataExpectationSchema.safeParse(expectationInput);
  if (!authorization.success || !expectation.success) {
    return denied("invalid_input");
  }
  const { key_id: keyId, claims } = authorization.data;
  const expected = expectation.data;
  if (expected.allowedPurposes.length === 0) {
    return denied("purposes_not_approved");
  }
  if (!expected.trustedKeyIds.includes(keyId)) {
    return denied("unknown_key_id");
  }
  if (!expected.listingLive) {
    return denied("listing_not_live");
  }
  if (claims.listing_id !== expected.listingId) {
    return denied("listing_mismatch");
  }
  if (!expected.allowedPurposes.includes(claims.purpose)) {
    return denied("purpose_not_allowed");
  }
  if (claims.purpose !== expected.purpose) {
    return denied("purpose_mismatch");
  }
  const order = compareUtcInstants(expected.now, claims.exp);
  if (order === null || order >= 0) {
    return denied("expired");
  }
  if (claims.revocation_version !== expected.currentRevocationVersion) {
    return denied("revoked");
  }
  return { outcome: "allow" };
}

// ---- 方案 X：不可變產物 ----

export const artifactRecordSchema = z.strictObject({
  id: z.uuid(),
  snapshot_id: z.uuid(),
  content_hash: sha256HexSchema,
  manifest_hash: sha256HexSchema,
  validated_at: utcInstantSchema,
  bytes: z.number().int().nonnegative(),
  file_count: z.number().int().nonnegative(),
});
export type ArtifactRecord = z.infer<typeof artifactRecordSchema>;

export const artifactManifestEntrySchema = z.strictObject({
  path: z.string(),
  kind: z.enum(["file", "symlink", "directory", "other"]),
  bytes: z.number().int().nonnegative(),
  content_hash: sha256HexSchema,
  media_type: z.string().min(1),
});
export const artifactManifestSchema = z.strictObject({
  files: z.array(artifactManifestEntrySchema),
});
export type ArtifactManifest = z.infer<typeof artifactManifestSchema>;

// 檔案型別／大小／檔數屬 PP-20，未核定：必須全部由呼叫端明確提供，不使用 Spike 預設值。
export const artifactLimitsSchema = z.strictObject({
  maxFiles: z.number().int().positive(),
  maxFileBytes: z.number().int().positive(),
  maxTotalBytes: z.number().int().positive(),
  allowedMediaTypes: z.array(z.string().min(1)).min(1),
});
export type ArtifactLimits = z.infer<typeof artifactLimitsSchema>;

export type ArtifactRejectionReason =
  | "limits_not_approved"
  | "manifest_invalid"
  | "empty_manifest"
  | "too_many_files"
  | "file_too_large"
  | "total_too_large"
  | "path_invalid"
  | "path_reserved"
  | "path_duplicate"
  | "entry_not_regular_file"
  | "media_type_not_allowed";

export type ArtifactValidationResult =
  | { ok: true; fileCount: number; totalBytes: number }
  | { ok: false; code: "artifact_rejected"; reason: ArtifactRejectionReason };

const reject = (reason: ArtifactRejectionReason): ArtifactValidationResult => ({
  ok: false,
  code: "artifact_rejected",
  reason,
});

function isNormalizedRelativePath(path: string): boolean {
  if (path === "" || path.startsWith("/") || path !== path.normalize("NFC")) {
    return false;
  }
  if (/[\u0000-\u001f\u007f\\:]/.test(path)) {
    return false;
  }
  return path.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

// 任一不符整份拒絕，不部分接受；回傳只含固定原因碼，不帶路徑或內容。
export function validateArtifactManifest(
  manifestInput: unknown,
  limitsInput: unknown,
): ArtifactValidationResult {
  const limits = artifactLimitsSchema.safeParse(limitsInput);
  if (!limits.success) {
    return reject("limits_not_approved");
  }
  const manifest = artifactManifestSchema.safeParse(manifestInput);
  if (!manifest.success) {
    return reject("manifest_invalid");
  }
  const { files } = manifest.data;
  if (files.length === 0) {
    return reject("empty_manifest");
  }
  if (files.length > limits.data.maxFiles) {
    return reject("too_many_files");
  }

  const seen = new Set<string>();
  const directories = new Set<string>();
  let totalBytes = 0;
  for (const entry of files) {
    if (entry.kind !== "file") {
      return reject("entry_not_regular_file");
    }
    if (!isNormalizedRelativePath(entry.path)) {
      return reject("path_invalid");
    }
    if (entry.path.split("/")[0]?.toLowerCase() === "_work") {
      return reject("path_reserved");
    }
    const folded = entry.path.toLowerCase();
    const segments = folded.split("/");
    const parents = segments.slice(0, -1).map((_, index) => segments.slice(0, index + 1).join("/"));
    if (seen.has(folded) || directories.has(folded) || parents.some((parent) => seen.has(parent))) {
      return reject("path_duplicate");
    }
    seen.add(folded);
    for (const parent of parents) directories.add(parent);
    if (entry.bytes > limits.data.maxFileBytes) {
      return reject("file_too_large");
    }
    if (!limits.data.allowedMediaTypes.includes(entry.media_type)) {
      return reject("media_type_not_allowed");
    }
    totalBytes += entry.bytes;
    if (totalBytes > limits.data.maxTotalBytes) {
      return reject("total_too_large");
    }
  }
  return { ok: true, fileCount: files.length, totalBytes };
}

export const artifactBindingSchema = z.strictObject({
  artifact_id: z.uuid(),
  snapshot_id: z.uuid(),
  content_hash: sha256HexSchema,
});
export type ArtifactBinding = z.infer<typeof artifactBindingSchema>;

export type ArtifactServeDenyReason = "invalid_input" | "binding_mismatch";

// 建置成功／取回成功都不等於可服務：只有已驗證保存的產物記錄且綁定三項完全相符才可服務。
export function decideArtifactServe(
  recordInput: unknown,
  bindingInput: unknown,
): { outcome: "allow" } | { outcome: "denied"; internalReason: ArtifactServeDenyReason } {
  const record = artifactRecordSchema.safeParse(recordInput);
  const binding = artifactBindingSchema.safeParse(bindingInput);
  if (!record.success || !binding.success) {
    return { outcome: "denied", internalReason: "invalid_input" };
  }
  const matches =
    record.data.id === binding.data.artifact_id &&
    record.data.snapshot_id === binding.data.snapshot_id &&
    record.data.content_hash === binding.data.content_hash;
  return matches
    ? { outcome: "allow" }
    : { outcome: "denied", internalReason: "binding_mismatch" };
}

// ---- 公開入口狀態查詢（PUB §3：GET {platform}/internal/works/{slug}/state）----

export const worksPageStateSchema = z.enum(["live", "stopped"]);
export const worksStateResponseSchema = z
  .strictObject({
    page_state: worksPageStateSchema,
    deployment_id: z.uuid().nullable(),
    artifact_ref: opaqueIdSchema.nullable(),
    etag: opaqueIdSchema,
  })
  .superRefine((state, ctx) => {
    const hasServingRefs = state.deployment_id !== null || state.artifact_ref !== null;
    if (state.page_state === "live" && (state.deployment_id === null || state.artifact_ref === null)) {
      ctx.addIssue({ code: "custom", message: "live 必須同時有部署與產物引用", path: ["page_state"] });
    }
    if (state.page_state === "stopped" && hasServingRefs) {
      ctx.addIssue({ code: "custom", message: "stopped 不得帶服務引用", path: ["page_state"] });
    }
  });
export type WorksStateResponse = z.infer<typeof worksStateResponseSchema>;

// ---- 保留路由（PUB §3.3）----

export type WorksRouteDecision =
  | { kind: "work_data" }
  | { kind: "preview_redeem" }
  | { kind: "artifact" }
  | {
      kind: "not_found";
      reason: "reserved_prefix" | "function_routes_not_in_mvp" | "preview_only" | "invalid_path";
    };

const reservedPrefix = "_work";

// 傳入的是 URL pathname（不含 query／fragment）。`/_work/*` 為保留前綴，路由優先於靜態檔與沙箱檔案：
// 先做一次百分比解碼並合併重複斜線、以不分大小寫比對，避免編碼或大小寫繞過；含 dot segment、
// 無效編碼、編碼後的反斜線／NUL 一律視為無效路徑。除 data/v1 與預覽專用 redeem 外全部 404，其下沒有任何 AI 路由。
export function classifyWorksRoute(mode: WorksCspMode, pathname: unknown): WorksRouteDecision {
  if (typeof pathname !== "string" || !pathname.startsWith("/") || /[?#]/.test(pathname)) {
    return { kind: "not_found", reason: "invalid_path" };
  }
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return { kind: "not_found", reason: "invalid_path" };
  }
  if (/[\\\u0000]/.test(decoded) || decoded.includes("?") || decoded.includes("#")) {
    return { kind: "not_found", reason: "invalid_path" };
  }
  const segments = decoded.split("/").filter((segment) => segment !== "");
  if (segments.some((segment) => segment === "." || segment === "..")) {
    return { kind: "not_found", reason: "invalid_path" };
  }

  if (segments[0]?.toLowerCase() !== reservedPrefix) {
    return { kind: "artifact" };
  }
  const area = segments[1]?.toLowerCase();
  const version = segments[2]?.toLowerCase();
  if (area === "data" && version === "v1") {
    return { kind: "work_data" };
  }
  if (area === "fn" && version === "v1") {
    return { kind: "not_found", reason: "function_routes_not_in_mvp" };
  }
  if (area === "preview" && version === "redeem" && segments.length === 3) {
    return mode === "preview"
      ? { kind: "preview_redeem" }
      : { kind: "not_found", reason: "preview_only" };
  }
  return { kind: "not_found", reason: "reserved_prefix" };
}
