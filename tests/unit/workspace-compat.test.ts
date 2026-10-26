import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { verifyWorkspaceCompatibility } from "../../scripts/workspace-compat.ts";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));

describe("T003 workspace 與 Node 24／Next 16／React 19／TypeScript 鎖定相容性", () => {
  it("目前專案所有相容性檢查通過", () => {
    const results = verifyWorkspaceCompatibility(root);
    expect(results.filter((result) => !result.ok)).toEqual([]);
    expect(results.map((result) => result.id)).toEqual(
      expect.arrayContaining([
        "workspaces_declared",
        "node_engines",
        "framework_next",
        "framework_react",
        "framework_typescript",
        "lockfile_workspaces",
        "no_orm",
        "workspace_links",
      ]),
    );
  });

  it("非 Node 24 執行環境會被拒絕，而不是被略過", () => {
    const results = verifyWorkspaceCompatibility(root, "22.12.0");
    expect(results.find((result) => result.id === "node_runtime")?.ok).toBe(false);
  });

  it("找不到專案根 manifest 時明確失敗", () => {
    const results = verifyWorkspaceCompatibility(resolve(root, "tests", "fixtures"));
    expect(results).toEqual([
      { id: "root_manifest", ok: false, detail: "找不到可解析的根 package.json" },
    ]);
  });
});
