import { defineConfig } from "vitest/config";

// readiness §92：教師申請整合測試只在 -TeacherSignup 隔離 runner（signup／電郵確認／郵件接收器開啟）納入。
const teacherSignup = process.env.APP_PLANET_TEACHER_SIGNUP_MODE === "isolated-local-test"
  ? ["tests/integration/real-auth-teacher-signup.test.ts"]
  : [];
const bindingsUpgrade = process.env.APP_PLANET_TEST_MIGRATE_THROUGH === "0031"
  ? ["tests/integration/real-auth-bindings-upgrade.test.ts"] : [];

export default defineConfig({
  test: {
    environment: "node",
    setupFiles: ["tests/support/setup-isolation.ts"],
    reporters: ["verbose"],
    include: ["tests/integration/real-auth-admin-schools.test.ts", "tests/integration/real-auth-project-export.test.ts", "tests/integration/real-auth-admin-memberships.test.ts", ...bindingsUpgrade, "tests/integration/real-auth-agent-runs.test.ts", "tests/integration/real-auth-project-rename.test.ts", "tests/integration/real-auth-teacher-view-audit.test.ts", "tests/integration/real-auth-admin-bindings.test.ts", "tests/integration/real-auth-specification-review.test.ts", "tests/integration/real-auth-teacher-resources.test.ts", "tests/integration/real-auth-routes.test.ts", "tests/integration/real-auth-project-classification.test.ts", "tests/integration/real-auth-project-files.test.ts", "tests/integration/real-auth-creation-flow.test.ts", "tests/integration/real-auth-task-import.test.ts", "tests/integration/real-auth-stage-confirmation.test.ts", "tests/integration/real-auth-stage-overview.test.ts", "tests/integration/real-auth-staff-login.test.ts", "tests/integration/real-auth-staff-approval.test.ts", ...teacherSignup],
    fileParallelism: false,
    testTimeout: 90_000,
    hookTimeout: 120_000,
  },
});
