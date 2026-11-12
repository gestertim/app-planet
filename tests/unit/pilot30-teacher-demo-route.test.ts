import { afterEach, describe, expect, it, vi } from "vitest";
import type { ComponentType, ReactElement } from "react";

vi.mock("next/navigation", () => ({
  notFound: () => { throw new Error("PILOT30_DEMO_NOT_FOUND"); },
}));

const { default: Pilot30TeacherDemoPage } = await vi.importActual<{
  default: () => ReactElement;
}>("../../apps/web/src/app/pilot30/teacher-demo/page.tsx");
const { TeacherDemo } = await vi.importActual<{
  TeacherDemo: ComponentType;
}>("../../apps/web/src/components/pilot30-teacher-demo.tsx");

afterEach(() => vi.unstubAllEnvs());

describe("Pilot30 教師示範伺服器入口", () => {
  it("開關未啟用或非 development 時回 404，不渲染示範頁", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("PILOT30_TEACHER_DEMO_ENABLED", "");
    expect(() => Pilot30TeacherDemoPage()).toThrow("PILOT30_DEMO_NOT_FOUND");

    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("PILOT30_TEACHER_DEMO_ENABLED", "true");
    expect(() => Pilot30TeacherDemoPage()).toThrow("PILOT30_DEMO_NOT_FOUND");
  });

  it("只有明確啟用且在 development 才渲染教師示範", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("PILOT30_TEACHER_DEMO_ENABLED", "true");
    const page = Pilot30TeacherDemoPage();
    expect(page.type).toBe(TeacherDemo);
  });
});
