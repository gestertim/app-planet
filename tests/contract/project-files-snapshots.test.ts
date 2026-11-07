import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  canonicalSnapshotManifest,
  createManualSnapshotBodySchema,
  fileIfMatchSchema,
  projectFileContentSchema,
  projectFilePathSchema,
  projectSnapshotDtoSchema,
} from "@app-planet/core";
import { snapshotContentHash } from "../../apps/web/src/server/project-files.ts";
import { legacyOnlyPathCases, projectFilePathCases } from "../support/project-file-path-cases.ts";

describe("專案原始碼與 manual 快照契約", () => {
  it("只接受 canonical 相對 POSIX 路徑與支援副檔名，並限制 512 ASCII bytes", () => {
    expect(projectFilePathSchema.safeParse("index.html").success).toBe(true);
    expect(projectFilePathSchema.safeParse("src/main.js").success).toBe(true);
    expect(projectFilePathSchema.safeParse("src/CONSOLE.js").success).toBe(true);
    expect(projectFilePathSchema.safeParse("src/Auxiliary.css").success).toBe(true);
    expect(projectFilePathSchema.safeParse(`${"a/".repeat(253)}x.html`).success).toBe(true);
    for (const path of [
      "", "/index.html", "src//main.js", "../index.html", "src/./main.css",
      "src\\main.js", "%2e%2e/index.html", "CON.js", "con.js",
      "folder/AUX.css", "nested/folder/Aux.css", "nested/prn.html",
      "index.HTML", `${"a/".repeat(253)}xx.html`,
    ]) expect(projectFilePathSchema.safeParse(path).success, path).toBe(false);
  });

  it("§108 共用路徑案例：schema 與現行規則一致", () => {
    for (const entry of projectFilePathCases) {
      expect(projectFilePathSchema.safeParse(entry.path).success, `${entry.note}:${entry.path.slice(0, 40)}`)
        .toBe(entry.current);
    }
    expect(legacyOnlyPathCases.map((entry) => entry.path)).toEqual(expect.arrayContaining(["con.js", "Aux.css"]));
  });

  it("以 UTF-8 bytes 計算 262,143／262,144／262,145 邊界，含繁中與 emoji", () => {
    const atLimitMinusOne = `${"a".repeat(262_133)}中文😀`;
    const atLimit = `${atLimitMinusOne}a`;
    const overLimit = `${atLimit}a`;
    expect(new TextEncoder().encode(atLimitMinusOne).byteLength).toBe(262_143);
    expect(new TextEncoder().encode(atLimit).byteLength).toBe(262_144);
    expect(new TextEncoder().encode(overLimit).byteLength).toBe(262_145);
    expect(projectFileContentSchema.safeParse("").success).toBe(true);
    expect(projectFileContentSchema.safeParse(atLimitMinusOne).success).toBe(true);
    expect(projectFileContentSchema.safeParse(atLimit).success).toBe(true);
    expect(projectFileContentSchema.safeParse(overLimit).success).toBe(false);
    expect(projectFileContentSchema.safeParse("\ud800").success).toBe(false);
  });

  it("If-Match 僅接受單一 strong lowercase SHA-256 entity tag", () => {
    const hash = "a".repeat(64);
    expect(fileIfMatchSchema.safeParse(`"${hash}"`).success).toBe(true);
    for (const value of [`W/"${hash}"`, `"${hash}", "${hash}"`, hash, `"${"A".repeat(64)}"`]) {
      expect(fileIfMatchSchema.safeParse(value).success, value).toBe(false);
    }
  });

  it("manual request 不接受 caller manifest；manifest hash 與 DB canonical row bytes 一致", () => {
    expect(createManualSnapshotBodySchema.safeParse({ kind: "manual" }).success).toBe(true);
    expect(createManualSnapshotBodySchema.safeParse({
      kind: "manual", manifest: [{ path: "index.html", hash: "a".repeat(64), bytes: 0 }],
    }).success).toBe(false);
    const entries = [
      { path: "z.js", hash: "b".repeat(64), bytes: 7 },
      { path: "index.html", hash: "a".repeat(64), bytes: 0 },
    ] as const;
    const canonical = "index.html\u0000" + "a".repeat(64) + "\u00000\n" +
      "z.js\u0000" + "b".repeat(64) + "\u00007\n";
    expect(canonicalSnapshotManifest(entries)).toBe(canonical);
    expect(snapshotContentHash(entries)).toBe(createHash("sha256").update(canonical, "utf8").digest("hex"));
  });

  it("manual immutable 欄位只接受正式 DTO 布林投影，不推定 submission 或批准", () => {
    const snapshot = {
      id: "00000000-0000-4000-8000-000000000001",
      version_no: 1,
      created_at: "2026-11-06T00:00:00.000000Z",
      kind: "manual",
      immutable: false,
      content_hash: "a".repeat(64),
      message: null,
    };
    expect(projectSnapshotDtoSchema.omit({ changes: true }).safeParse(snapshot).success).toBe(true);
    expect(projectSnapshotDtoSchema.omit({ changes: true }).safeParse({
      ...snapshot, kind: "submission", approved: true,
    }).success).toBe(false);
  });
});
