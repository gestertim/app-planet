import { describe, expect, it } from "vitest";
import {
  classifySnapshotProblem,
  isSnapshotOperationKey,
  snapshotCreateMode,
  trustedSnapshotCreateReceipt,
} from "../../apps/web/src/components/project/project-snapshots-panel.tsx";

const receipt = (overrides: Record<string, unknown> = {}) => ({
  id: "20000000-0000-4000-8000-000000000001",
  version_no: 1,
  created_at: "2026-11-07T00:00:00.000000Z",
  kind: "manual",
  immutable: false,
  content_hash: "a".repeat(64),
  message: null,
  changes: { added: ["index.html"], changed: [], removed: [] },
  ...overrides,
});

describe("§108 快照原操作識別格式", () => {
  it("接受 crypto.randomUUID() 產生的完整 8-4-4-4-12 識別，reload 後才能以原鍵恢復", () => {
    for (let index = 0; index < 32; index++) expect(isSnapshotOperationKey(crypto.randomUUID())).toBe(true);
    expect(isSnapshotOperationKey("E8E562AF-244E-4BAC-940E-F0687C1A7350")).toBe(true);
  });

  it("拒絕缺段、多段、非十六進位或含空白的資料", () => {
    for (const value of [
      "e8e562af-244e-4bac-f0687c1a7350",
      "e8e562af-244e-4bac-940e-940e-f0687c1a7350",
      "g8e562af-244e-4bac-940e-f0687c1a7350",
      " e8e562af-244e-4bac-940e-f0687c1a7350",
      "e8e562af-244e-4bac-940e-f0687c1a7350\n",
      "",
    ]) expect(isSnapshotOperationKey(value)).toBe(false);
  });
});
describe("§108 F-05：manual 快照建立的模式與成功收據", () => {
  it("只有本次新產生的 key 才是一般模式；沿用既有 key 一律 replay-only", () => {
    expect(snapshotCreateMode({ keyGeneratedForThisRequest: true })).toBe("initial");
    expect(snapshotCreateMode({ keyGeneratedForThisRequest: false })).toBe("replay_only");
  });

  it("replay-only 只接受合法 200；合法 DTO 的 201 不承認成功", () => {
    expect(trustedSnapshotCreateReceipt("replay_only", 200, receipt())).not.toBeNull();
    expect(trustedSnapshotCreateReceipt("replay_only", 201, receipt())).toBeNull();
  });

  it("一般模式接受首次 201 與同鍵重放 200", () => {
    expect(trustedSnapshotCreateReceipt("initial", 201, receipt())?.id).toBe(receipt().id);
    expect(trustedSnapshotCreateReceipt("initial", 200, receipt())?.id).toBe(receipt().id);
    expect(trustedSnapshotCreateReceipt("initial", 202, receipt())).toBeNull();
    expect(trustedSnapshotCreateReceipt("initial", 204, receipt())).toBeNull();
  });

  it.each([
    ["多餘欄位", receipt({ extra: true })],
    ["非 manual", receipt({ kind: "auto" })],
    ["immutable 與 manual 快照不一致", receipt({ immutable: true })],
    ["送出時未附 message 但回應帶 message", receipt({ message: "其他操作" })],
    ["非法 hash", receipt({ content_hash: "x" })],
    ["body 中斷", null],
  ])("不可信成功 body（%s）不清鍵", (_label, payload) => {
    for (const mode of ["initial", "replay_only"] as const) {
      for (const status of [200, 201]) {
        expect(trustedSnapshotCreateReceipt(mode, status, payload)).toBeNull();
      }
    }
  });
});

describe("快照 problem code 分類", () => {
  it("storage_limit 507 是確定拒絕，不歸入一般 5xx 未知結果", () => {
    expect(classifySnapshotProblem(507, "storage_limit")).toBe("storage_limit");
    expect(classifySnapshotProblem(503, "dependency_unavailable")).toBe("unknown");
    expect(classifySnapshotProblem(409, "operation_outcome_unrecoverable")).toBe("unrecoverable");
    expect(classifySnapshotProblem(400, "invalid_request")).toBe("rejected");
  });
});
