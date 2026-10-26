import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyWorkspaceCompatibility } from "./workspace-compat.ts";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const results = verifyWorkspaceCompatibility(root);
for (const result of results) {
  console.log(`${result.ok ? "ok" : "FAIL"} ${result.id}: ${result.detail}`);
}
process.exitCode = results.every((result) => result.ok) ? 0 : 1;
