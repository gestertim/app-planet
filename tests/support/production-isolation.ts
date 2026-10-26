const productionEnvironmentNames = new Set(["production", "prod"]);

// 只檢查名稱是否存在，不讀出或回傳任何值；這些名稱屬真實服務憑證，不得出現在合成測試程序。
export const realServiceCredentialNames = [
  "SUPABASE_SERVICE_ROLE_KEY",
  "SUPABASE_ACCESS_TOKEN",
  "OPENAI_API_KEY",
  "VERCEL_TOKEN",
  "E2B_API_KEY",
] as const;

export function findProductionTestEnvironmentViolations(
  environment: Readonly<Record<string, string | undefined>>,
): string[] {
  const violations: string[] = [];
  const target = environment.APP_PLANET_ENV?.trim().toLowerCase();
  if (target !== undefined && productionEnvironmentNames.has(target)) {
    violations.push("APP_PLANET_ENV");
  }
  for (const name of realServiceCredentialNames) {
    const value = environment[name];
    if (value !== undefined && value !== "") {
      violations.push(name);
    }
  }
  return violations;
}

export function assertNoProductionTestEnvironment(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): void {
  const violations = findProductionTestEnvironmentViolations(environment);
  if (violations.length > 0) {
    throw new Error(
      `合成測試不得在含正式環境或真實服務憑證的程序中執行：${violations.join("、")}。請移除這些環境變數後重試。`,
    );
  }
}
