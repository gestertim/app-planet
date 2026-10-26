import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    reporters: ["verbose"],
    include: [
      "tests/integration/projects.test.ts",
      "tests/integration/project-create.test.ts",
      "tests/integration/project-classification.test.ts",
      "tests/integration/stage-drafts.test.ts",
      "tests/integration/stage-draft-save-controller.test.ts",
      "tests/integration/project-workspace.test.ts",
      "tests/integration/creation-flow-assessment.test.ts",
    ],
    fileParallelism: false,
    testTimeout: 15_000,
    hookTimeout: 30_000,
  },
});
