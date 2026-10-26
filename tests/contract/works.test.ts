import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  buildPreviewSessionSetCookie,
  classifyWorksRoute,
  decideArtifactServe,
  decidePreviewRequest,
  evaluateVerifiedWorkDataAuthorization,
  previewRedeemResponseHeaders,
  previewSessionStateSchema,
  validateArtifactManifest,
  workDataAuthorizationSchema,
  worksStateResponseSchema,
} from "@app-planet/core";

const validManifest = () =>
  JSON.parse(
    readFileSync(new URL("../fixtures/works/artifact-manifest.valid.json", import.meta.url), "utf8"),
  ) as { files: Array<Record<string, unknown>> };

describe("T013 A1 預覽會話", () => {
  it("只有四種會話狀態", () => {
    expect(previewSessionStateSchema.options).toEqual(["issued", "active", "expired", "revoked"]);
  });

  it("Set-Cookie 固定 __Host- 前綴、Path=/、Secure、HttpOnly、SameSite=None、Partitioned，且沒有 Domain", () => {
    const result = buildPreviewSessionSetCookie("SyntheticOpaqueSessionValue_123-abc");
    expect(result).toEqual({
      ok: true,
      setCookie:
        "__Host-preview_session=SyntheticOpaqueSessionValue_123-abc; Path=/; Secure; HttpOnly; SameSite=None; Partitioned",
    });
    expect(result.ok && result.setCookie).not.toMatch(/Domain/i);
    expect(previewRedeemResponseHeaders).toEqual({ "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" });
  });

  it.each(["", "a b", "a;b", "a=b", "a,b", "值", "a\r\nSet-Cookie: x=y", 42, null])(
    "拒絕可注入屬性或標頭的 cookie 值：%s",
    (value) => {
      expect(buildPreviewSessionSetCookie(value)).toEqual({ ok: false, code: "invalid_cookie_value" });
    },
  );

  const facts = () => ({
    ttlPolicyApproved: true,
    sessionState: "active",
    expiresAt: "2026-10-26T12:30:00Z",
    now: "2026-10-26T12:00:00Z",
    principalValid: true,
    teacherBindingValid: true,
    accountActive: true,
    artifactBindingValid: true,
  });

  it("所有條件成立才允許", () => {
    expect(decidePreviewRequest(facts())).toEqual({ outcome: "allow" });
  });

  it.each([
    ["TTL／撤銷上界政策未核定", { ttlPolicyApproved: false }, "policy_not_approved"],
    ["未兌換 issued", { sessionState: "issued" }, "session_not_active"],
    ["已撤銷", { sessionState: "revoked" }, "session_not_active"],
    ["狀態標為過期", { sessionState: "expired" }, "session_not_active"],
    ["找不到會話", { sessionState: "unknown" }, "session_not_active"],
    ["時間剛好到期", { now: "2026-10-26T12:30:00.000Z" }, "session_expired"],
    ["已過期", { now: "2026-10-26T12:30:00.001Z" }, "session_expired"],
    ["沒有到期時間", { expiresAt: null }, "session_expired"],
    ["主體失效", { principalValid: false }, "principal_invalid"],
    ["教師綁定失效", { teacherBindingValid: false }, "teacher_binding_invalid"],
    ["帳號停用", { accountActive: false }, "account_inactive"],
    ["產物綁定不符", { artifactBindingValid: false }, "artifact_binding_invalid"],
  ])("拒絕：%s", (_name, patch, reason) => {
    expect(decidePreviewRequest({ ...facts(), ...patch })).toEqual({ outcome: "denied", internalReason: reason });
  });

  it("缺欄位、額外欄位、錯型別與 +00:00 時間都 fail-closed，不補預設值", () => {
    const missing: Record<string, unknown> = { ...facts() };
    delete missing.ttlPolicyApproved;
    for (const input of [
      missing,
      { ...facts(), extra: true },
      { ...facts(), principalValid: "true" },
      { ...facts(), now: "2026-10-26T12:00:00+00:00" },
      null,
    ]) {
      expect(decidePreviewRequest(input)).toEqual({ outcome: "denied", internalReason: "invalid_facts" });
    }
  });

  it("對外只有 allow／denied：各種拒絕結果不含可區分會話存在性的欄位", () => {
    const denials = [{ sessionState: "unknown" }, { sessionState: "revoked" }, { sessionState: "issued" }].map((patch) =>
      decidePreviewRequest({ ...facts(), ...patch }),
    );
    expect(new Set(denials.map((decision) => decision.outcome))).toEqual(new Set(["denied"]));
  });
});

describe("T013 B2 作品資料授權 claims", () => {
  const listing = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const authorization = () => ({
    key_id: "key-2026-a",
    claims: {
      listing_id: listing,
      purpose: "read",
      exp: "2026-10-26T12:05:00Z",
      authorization_id: "auth-0001",
      revocation_version: 4,
    },
  });
  const expectation = () => ({
    trustedKeyIds: ["key-2026-a"],
    allowedPurposes: ["read", "write"],
    now: "2026-10-26T12:00:00Z",
    listingId: listing,
    purpose: "read",
    listingLive: true,
    currentRevocationVersion: 4,
  });

  it("claims 必須綁單一 listing、用途、exp、授權識別與撤銷版本，並拒絕額外欄位", () => {
    expect(workDataAuthorizationSchema.safeParse(authorization()).success).toBe(true);
    const wide = { ...authorization(), claims: { ...authorization().claims, listing_ids: [listing] } };
    expect(workDataAuthorizationSchema.safeParse(wide).success).toBe(false);
    for (const key of ["listing_id", "purpose", "exp", "authorization_id", "revocation_version"] as const) {
      const claims: Record<string, unknown> = { ...authorization().claims };
      delete claims[key];
      expect(workDataAuthorizationSchema.safeParse({ ...authorization(), claims }).success).toBe(false);
    }
  });

  it("全部條件成立才允許；不含任何簽署或全域資料 HMAC 相關能力", () => {
    expect(evaluateVerifiedWorkDataAuthorization(authorization(), expectation())).toEqual({ outcome: "allow" });
  });

  it.each([
    ["用途集合未核定（空）", { allowedPurposes: [] }, "purposes_not_approved"],
    ["未知 key id", { trustedKeyIds: ["key-2026-b"] }, "unknown_key_id"],
    ["沒有任何可信 key", { trustedKeyIds: [] }, "unknown_key_id"],
    ["作品非 live", { listingLive: false }, "listing_not_live"],
    ["跨作品", { listingId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" }, "listing_mismatch"],
    ["用途不在核定集合", { allowedPurposes: ["write"] }, "purpose_not_allowed"],
    ["跨用途", { purpose: "write" }, "purpose_mismatch"],
    ["剛好到期", { now: "2026-10-26T12:05:00Z" }, "expired"],
    ["撤銷版本落後", { currentRevocationVersion: 5 }, "revoked"],
    ["撤銷版本超前", { currentRevocationVersion: 3 }, "revoked"],
  ])("拒絕：%s", (_name, patch, reason) => {
    expect(evaluateVerifiedWorkDataAuthorization(authorization(), { ...expectation(), ...patch })).toEqual({
      outcome: "denied",
      internalReason: reason,
    });
  });

  it("缺值、錯型別或無法比較的時間一律拒絕，不使用預設值", () => {
    const { allowedPurposes: _omitted, ...incomplete } = expectation();
    for (const [auth, exp] of [
      [authorization(), incomplete],
      [authorization(), { ...expectation(), now: "tomorrow" }],
      [{ ...authorization(), claims: { ...authorization().claims, exp: "2026-10-26T12:05:00+00:00" } }, expectation()],
      [null, expectation()],
      [authorization(), undefined],
    ] as const) {
      expect(evaluateVerifiedWorkDataAuthorization(auth, exp)).toEqual({ outcome: "denied", internalReason: "invalid_input" });
    }
  });
});

describe("T013 方案 X 產物", () => {
  const limits = () => ({
    maxFiles: 10,
    maxFileBytes: 10_000,
    maxTotalBytes: 20_000,
    allowedMediaTypes: ["text/html", "text/javascript", "text/css"],
  });

  it.each([
    ["assets", "assets/app.js"],
    ["assets/app.js", "assets"],
    ["ASSETS", "assets/App.js"],
    ["Assets/app.js", "ASSETS"],
  ])("拒絕檔案／目錄前綴碰撞 %s / %s", (first, second) => {
    const entry = validManifest().files[0];
    expect(validateArtifactManifest({ files: [
      { ...entry, path: first }, { ...entry, path: second },
    ] }, limits())).toMatchObject({ ok: false, reason: "path_duplicate" });
  });

  it("相鄰名稱不是目錄前綴碰撞", () => {
    const entry = validManifest().files[0];
    expect(validateArtifactManifest({ files: [
      { ...entry, path: "assets" }, { ...entry, path: "assets-extra/app.js" },
    ] }, limits())).toMatchObject({ ok: true });
  });

  it("以固定合成 fixture 驗證合法 manifest，回傳彙總而不含路徑", () => {
    expect(validateArtifactManifest(validManifest(), limits())).toEqual({ ok: true, fileCount: 3, totalBytes: 7400 });
  });

  it("限制屬未核定政策：缺少或不完整時整份拒絕", () => {
    for (const input of [undefined, {}, { ...limits(), allowedMediaTypes: [] }, { maxFiles: 10, maxFileBytes: 1, maxTotalBytes: 1 }, { ...limits(), maxFiles: 0 }]) {
      expect(validateArtifactManifest(validManifest(), input)).toEqual({ ok: false, code: "artifact_rejected", reason: "limits_not_approved" });
    }
  });

  const withFiles = (mutate: (files: Array<Record<string, unknown>>) => unknown) => {
    const manifest = validManifest();
    const result = mutate(manifest.files);
    return result === undefined ? manifest : result;
  };

  it.each([
    ["絕對路徑", (f: Array<Record<string, unknown>>) => ((f[0]!.path = "/index.html"), undefined), "path_invalid"],
    ["路徑穿越", (f: Array<Record<string, unknown>>) => ((f[1]!.path = "assets/../../secret.js"), undefined), "path_invalid"],
    ["點段", (f: Array<Record<string, unknown>>) => ((f[1]!.path = "./assets/app.js"), undefined), "path_invalid"],
    ["反斜線", (f: Array<Record<string, unknown>>) => ((f[1]!.path = "assets\\app.js"), undefined), "path_invalid"],
    ["磁碟機代號", (f: Array<Record<string, unknown>>) => ((f[1]!.path = "C:/app.js"), undefined), "path_invalid"],
    ["空段（雙斜線）", (f: Array<Record<string, unknown>>) => ((f[1]!.path = "assets//app.js"), undefined), "path_invalid"],
    ["控制字元", (f: Array<Record<string, unknown>>) => ((f[1]!.path = "assets/a\u0000.js"), undefined), "path_invalid"],
    ["非 NFC", (f: Array<Record<string, unknown>>) => ((f[1]!.path = "assets/e\u0301.js"), undefined), "path_invalid"],
    ["_work 保留路徑", (f: Array<Record<string, unknown>>) => ((f[1]!.path = "_work/data/v1/x.js"), undefined), "path_reserved"],
    ["_WORK 大小寫變體", (f: Array<Record<string, unknown>>) => ((f[1]!.path = "_WORK/x.js"), undefined), "path_reserved"],
    ["重複路徑", (f: Array<Record<string, unknown>>) => ((f[2]!.path = "assets/app.js"), undefined), "path_duplicate"],
    ["大小寫重複路徑", (f: Array<Record<string, unknown>>) => ((f[2]!.path = "ASSETS/APP.JS"), undefined), "path_duplicate"],
    ["符號連結", (f: Array<Record<string, unknown>>) => ((f[1]!.kind = "symlink"), undefined), "entry_not_regular_file"],
    ["目錄項目", (f: Array<Record<string, unknown>>) => ((f[1]!.kind = "directory"), undefined), "entry_not_regular_file"],
    ["單檔過大", (f: Array<Record<string, unknown>>) => ((f[1]!.bytes = 10_001), undefined), "file_too_large"],
    ["總量過大", (f: Array<Record<string, unknown>>) => ((f[0]!.bytes = 9_999), (f[1]!.bytes = 9_999), (f[2]!.bytes = 9_999), undefined), "total_too_large"],
    ["不允許的型別", (f: Array<Record<string, unknown>>) => ((f[1]!.media_type = "application/x-msdownload"), undefined), "media_type_not_allowed"],
    ["雜湊格式錯誤", (f: Array<Record<string, unknown>>) => ((f[1]!.content_hash = "ABC"), undefined), "manifest_invalid"],
    ["負數大小", (f: Array<Record<string, unknown>>) => ((f[1]!.bytes = -1), undefined), "manifest_invalid"],
    ["空 manifest", (f: Array<Record<string, unknown>>) => (f.length = 0, undefined), "empty_manifest"],
  ])("整份拒絕：%s", (_name, mutate, reason) => {
    expect(validateArtifactManifest(withFiles(mutate), limits())).toEqual({ ok: false, code: "artifact_rejected", reason });
  });

  it("檔數超限與額外欄位整份拒絕", () => {
    expect(validateArtifactManifest(validManifest(), { ...limits(), maxFiles: 2 })).toEqual({
      ok: false,
      code: "artifact_rejected",
      reason: "too_many_files",
    });
    const extra = withFiles((f) => ((f[0]!.storage_ref = "s3://internal/bucket/key"), undefined));
    expect(validateArtifactManifest(extra, limits())).toEqual({ ok: false, code: "artifact_rejected", reason: "manifest_invalid" });
  });

  const record = () => ({
    id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    snapshot_id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    content_hash: "4".repeat(64),
    manifest_hash: "5".repeat(64),
    validated_at: "2026-10-26T11:00:00Z",
    bytes: 7400,
    file_count: 3,
  });
  const binding = () => ({
    artifact_id: record().id,
    snapshot_id: record().snapshot_id,
    content_hash: record().content_hash,
  });

  it("只有已驗證記錄且 artifact／snapshot／content_hash 全相符才可服務；內部 storage_ref 不被接受", () => {
    expect(decideArtifactServe(record(), binding())).toEqual({ outcome: "allow" });
    for (const patch of [{ artifact_id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee" }, { snapshot_id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee" }, { content_hash: "6".repeat(64) }]) {
      expect(decideArtifactServe(record(), { ...binding(), ...patch })).toEqual({ outcome: "denied", internalReason: "binding_mismatch" });
    }
    const unvalidated: Record<string, unknown> = record();
    delete unvalidated.validated_at;
    expect(decideArtifactServe(unvalidated, binding())).toEqual({ outcome: "denied", internalReason: "invalid_input" });
    expect(decideArtifactServe({ ...record(), storage_ref: "s3://internal" }, binding())).toEqual({ outcome: "denied", internalReason: "invalid_input" });
  });
});

describe("T013 公開入口狀態查詢", () => {
  const live = () => ({
    page_state: "live",
    deployment_id: "ffffffff-ffff-4fff-8fff-ffffffffffff",
    artifact_ref: "artifact-ref-0001",
    etag: "\"etag-0001\"",
  });

  it("live 必須同時帶部署與產物引用；stopped 不得帶任何服務引用", () => {
    expect(worksStateResponseSchema.safeParse(live()).success).toBe(true);
    expect(worksStateResponseSchema.safeParse({ ...live(), artifact_ref: null }).success).toBe(false);
    expect(worksStateResponseSchema.safeParse({ ...live(), deployment_id: null }).success).toBe(false);
    expect(worksStateResponseSchema.safeParse({ ...live(), page_state: "stopped" }).success).toBe(false);
    expect(
      worksStateResponseSchema.safeParse({ ...live(), page_state: "stopped", deployment_id: null, artifact_ref: null }).success,
    ).toBe(true);
    expect(worksStateResponseSchema.safeParse({ ...live(), page_state: "paused" }).success).toBe(false);
    expect(worksStateResponseSchema.safeParse({ ...live(), storage_ref: "s3://x" }).success).toBe(false);
  });
});

describe("T013 保留路由", () => {
  it.each([
    ["public", "/_work/data/v1/items", { kind: "work_data" }],
    ["preview", "/_work/data/v1/items", { kind: "work_data" }],
    ["public", "/_work/data/v1", { kind: "work_data" }],
    ["preview", "/_work/preview/redeem", { kind: "preview_redeem" }],
    ["public", "/_work/preview/redeem", { kind: "not_found", reason: "preview_only" }],
    ["public", "/_work/fn/v1/anything", { kind: "not_found", reason: "function_routes_not_in_mvp" }],
    ["preview", "/_work/fn/v1", { kind: "not_found", reason: "function_routes_not_in_mvp" }],
    ["public", "/_work/ai/v1/chat", { kind: "not_found", reason: "reserved_prefix" }],
    ["public", "/_work", { kind: "not_found", reason: "reserved_prefix" }],
    ["public", "/_work/", { kind: "not_found", reason: "reserved_prefix" }],
    ["preview", "/_work/preview/redeem/extra", { kind: "not_found", reason: "reserved_prefix" }],
    ["public", "/_work/data/v2/x", { kind: "not_found", reason: "reserved_prefix" }],
    ["public", "/_work/data", { kind: "not_found", reason: "reserved_prefix" }],
    ["public", "/", { kind: "artifact" }],
    ["public", "/assets/app.js", { kind: "artifact" }],
    ["preview", "/work/data/v1/items", { kind: "artifact" }],
  ] as const)("%s %s", (mode, path, expected) => {
    expect(classifyWorksRoute(mode, path)).toEqual(expected);
  });

  it.each([
    "/_WORK/data/v1/x",
    "/%5Fwork/fn/v1/x",
    "/%5fWork/ai/x",
    "//_work/secret",
    "///_work/secret",
    "/_work%2Fsecret",
    "/assets/../_work/secret",
  ])("編碼、大小寫與重複斜線不能繞過保留前綴：%s", (path) => {
    const decision = classifyWorksRoute("public", path);
    expect(decision.kind).not.toBe("artifact");
  });

  it.each(["", "relative/path", "/a?x=1", "/a#frag", "/bad%zz", "/a%00b", "/a%5Cb", 42, null])(
    "無效路徑一律 404：%s",
    (path) => {
      expect(classifyWorksRoute("public", path)).toEqual({ kind: "not_found", reason: "invalid_path" });
    },
  );
});
