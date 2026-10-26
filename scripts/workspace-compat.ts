import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";

export interface CompatCheck {
  readonly id: string;
  readonly ok: boolean;
  readonly detail: string;
}

type Json = Record<string, unknown>;

const requiredWorkspaces = ["apps/web", "apps/worker", "apps/works-edge", "packages/core"] as const;
const requiredNodeRange = ">=24 <25";
const ormPackages = new Set([
  "prisma",
  "@prisma/client",
  "drizzle-orm",
  "typeorm",
  "sequelize",
  "sequelize-typescript",
  "mikro-orm",
  "@mikro-orm/core",
  "objection",
  "bookshelf",
]);

function readJson(path: string): Json | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Json)
      : null;
  } catch {
    return null;
  }
}

function record(value: unknown): Record<string, string> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
}

function major(version: string | undefined): number | null {
  const match = /(\d+)\.\d+\.\d+/.exec(version ?? "") ?? /(\d+)/.exec(version ?? "");
  return match === null ? null : Number(match[1]);
}

function check(id: string, ok: boolean, detail: string): CompatCheck {
  return { id, ok, detail };
}

export function verifyWorkspaceCompatibility(
  rootInput: string,
  nodeVersion: string = process.versions.node,
): CompatCheck[] {
  const root = resolve(rootInput);
  const results: CompatCheck[] = [];
  const rootManifest = readJson(join(root, "package.json"));
  if (rootManifest === null) {
    return [check("root_manifest", false, "找不到可解析的根 package.json")];
  }

  const declared = Array.isArray(rootManifest.workspaces)
    ? rootManifest.workspaces.filter((item): item is string => typeof item === "string")
    : [];
  const missing = requiredWorkspaces.filter((workspace) => !declared.includes(workspace));
  const extra = declared.filter((workspace) => !(requiredWorkspaces as readonly string[]).includes(workspace));
  results.push(
    check(
      "workspaces_declared",
      missing.length === 0 && extra.length === 0,
      `缺少：${missing.join(",") || "無"}；未預期：${extra.join(",") || "無"}`,
    ),
  );

  const manifests = new Map<string, Json>();
  for (const workspace of declared) {
    const manifest = readJson(join(root, workspace, "package.json"));
    if (manifest !== null) {
      manifests.set(workspace, manifest);
    }
  }
  const names = [...manifests.values()].map((manifest) => manifest.name);
  results.push(
    check(
      "workspace_manifests",
      manifests.size === declared.length &&
        new Set(names).size === names.length &&
        names.every((name) => typeof name === "string" && name.startsWith("@app-planet/")),
      `已解析 ${manifests.size}/${declared.length} 個 workspace manifest，名稱需唯一且屬 @app-planet/`,
    ),
  );

  const nodeRanges = [rootManifest, ...manifests.values()].map((manifest) => record(manifest.engines).node);
  results.push(
    check(
      "node_engines",
      nodeRanges.every((range) => range === requiredNodeRange),
      `所有 manifest 的 engines.node 必須為 ${requiredNodeRange}`,
    ),
  );
  results.push(
    check("node_runtime", major(nodeVersion) === 24, `目前 Node ${nodeVersion}；需為 Node 24 主版本`),
  );

  const coreDependents = declared.filter((workspace) => workspace.startsWith("apps/"));
  results.push(
    check(
      "core_dependency",
      coreDependents.every(
        (workspace) => record(manifests.get(workspace)?.dependencies)["@app-planet/core"] === "*",
      ) &&
        Object.keys(record(manifests.get("packages/core")?.dependencies)).every(
          (name) => !name.startsWith("@app-planet/"),
        ),
      "各 app 以 workspace 版本 * 相依 @app-planet/core；core 不相依任何 app",
    ),
  );

  const webDeps = record(manifests.get("apps/web")?.dependencies);
  const installed = (name: string): string | undefined => {
    const manifest = readJson(join(root, "node_modules", name, "package.json"));
    return typeof manifest?.version === "string" ? manifest.version : undefined;
  };
  const rootDev = record(rootManifest.devDependencies);
  const frameworks: ReadonlyArray<[string, string | undefined, number]> = [
    ["next", webDeps.next, 16],
    ["react", webDeps.react, 19],
    ["react-dom", webDeps["react-dom"], 19],
    ["typescript", rootDev.typescript, 7],
  ];
  for (const [name, declaredRange, expectedMajor] of frameworks) {
    const installedVersion = installed(name);
    results.push(
      check(
        `framework_${name}`,
        major(declaredRange) === expectedMajor && major(installedVersion) === expectedMajor,
        `${name} 宣告 ${declaredRange ?? "無"}、已安裝 ${installedVersion ?? "無"}；需為 ${expectedMajor}.x`,
      ),
    );
  }

  const lock = readJson(join(root, "package-lock.json"));
  const lockPackages = (lock?.packages ?? {}) as Record<string, Json>;
  const lockedWorkspaces = Array.isArray(lockPackages[""]?.workspaces)
    ? (lockPackages[""].workspaces as unknown[])
    : [];
  results.push(
    check(
      "lockfile_workspaces",
      lock?.lockfileVersion === 3 &&
        declared.every(
          (workspace) =>
            lockedWorkspaces.includes(workspace) &&
            lockPackages[workspace]?.name === manifests.get(workspace)?.name,
        ),
      "package-lock.json 為 lockfileVersion 3，且逐一記錄每個 workspace 與名稱",
    ),
  );
  const lockedFrameworks = frameworks.every(
    ([name, , expectedMajor]) => major(String(lockPackages[`node_modules/${name}`]?.version)) === expectedMajor,
  );
  results.push(check("lockfile_frameworks", lockedFrameworks, "鎖定檔中的 Next／React／React DOM／TypeScript 主版本相符"));

  const allDeps = [rootManifest, ...manifests.values()].flatMap((manifest) => [
    ...Object.keys(record(manifest.dependencies)),
    ...Object.keys(record(manifest.devDependencies)),
  ]);
  const lockedNames = Object.keys(lockPackages).map((key) => key.replace(/^.*node_modules\//, ""));
  const orms = [...new Set([...allDeps, ...lockedNames])].filter((name) => ormPackages.has(name));
  results.push(check("no_orm", orms.length === 0, `未引入 ORM；偵測到：${orms.join(",") || "無"}`));

  const links = [...manifests.entries()].every(([workspace, manifest]) => {
    const link = join(root, "node_modules", String(manifest.name));
    return existsSync(link) && realpathSync(link) === realpathSync(join(root, workspace));
  });
  results.push(check("workspace_links", links, "node_modules/@app-planet/* 皆連到對應 workspace 目錄"));

  return results;
}
