import { bootstrapFirstAdmin } from "./bootstrap.ts";

if (process.argv.length !== 3) {
  console.error("用法：node apps\\worker\\src\\admin\\bootstrap-cli.ts <既有待審教師 UUID>");
  process.exitCode = 1;
} else {
  try {
    const outcome = await bootstrapFirstAdmin(process.argv[2]!);
    console.info(JSON.stringify({ outcome }));
    if (outcome !== "completed" && outcome !== "already_completed") process.exitCode = 1;
  } catch {
    console.error("bootstrap 未確認完成；請核對隔離設定與執行權限，只以同一目標重試。");
    process.exitCode = 1;
  }
}
