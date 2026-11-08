import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const readers = vi.hoisted(() => ({ principal: vi.fn(), list: vi.fn() }));
vi.mock("next/navigation", () => ({
  usePathname: () => "/student", useRouter: () => ({ refresh: vi.fn() }),
}));
vi.mock("../../apps/web/src/server/page-principal.ts", () => ({ resolvePagePrincipal: readers.principal }));
vi.mock("../../apps/web/src/server/projects.ts", () => ({ listCurrentOwnedProjectsSubset: readers.list }));
vi.mock("../../apps/web/src/components/student/creation-space.tsx", () => ({
  StudentCreationSpace: ({ children }: { children: React.ReactNode }) =>
    createElement("div", { "data-testid": "student-creation-space" }, children),
}));
vi.mock("../../apps/web/src/components/project/create-project-form.tsx", () => ({
  CreateProjectForm: () => createElement("p", null, "既有建立表單"),
}));
vi.mock("../../apps/web/src/components/auth/teacher-relationship-notice.tsx", () => ({
  TeacherRelationshipNotice: () => createElement("p", null, "既有教師關係提示"),
}));
const { default: StudentPage } = await vi.importActual<{
  default: () => Promise<React.ReactElement>;
}>("../../apps/web/src/app/student/page.tsx");

beforeEach(() => {
  vi.clearAllMocks();
  readers.principal.mockResolvedValue({ ok: true, session: { read: {} }, operationStorageScope: "scope" });
});

describe("學生入口保持可信讀取與初始遮蔽", () => {
  it.each(["unauthenticated", "dependency_failure"])("登入 %s 不讀清單或輸出創作入口", async (reason) => {
    readers.principal.mockResolvedValue({ ok: false, reason });
    const html = renderToStaticMarkup(await StudentPage());
    expect(readers.list).not.toHaveBeenCalled();
    expect(html).not.toContain("student-creation-space");
    expect(html).not.toContain("owned-project-list");
    expect(html).toContain('role="alert"');
  });
  it.each(["denied", "failed", "unsupported_representation"])("清單 %s 不是空清單", async (outcome) => {
    readers.list.mockResolvedValue({ outcome });
    const html = renderToStaticMarkup(await StudentPage());
    expect(html).not.toContain("student-creation-space");
    expect(html).not.toContain("owned-project-list");
    expect(html).not.toContain("目前沒有專案");
    expect(html).toContain(outcome === "denied" ? "沒有檢視專案的權限" : "不是空清單");
  });
  it("真空清單提供既有表單，不預造續作", async () => {
    readers.list.mockResolvedValue({ outcome: "listed", projects: [] });
    const html = renderToStaticMarkup(await StudentPage());
    expect(html).toContain("目前沒有專案");
    expect(html).toContain("既有建立表單");
    expect(html).toContain('hidden=""');
    expect(html).not.toContain("continue-project");
  });
  it("使用可信名稱與實際階段，缺摘要不造假", async () => {
    readers.list.mockResolvedValue({ outcome: "listed", projects: [{
      id: "10000000-0000-4000-8000-000000000001", title: "本人作品", stage: "Constitution",
      created_at: "2026-11-08T00:00:00Z", classification_state: "unconfirmed", tier: null,
    }] });
    const html = renderToStaticMarkup(await StudentPage());
    expect(html).toContain("實際階段：Constitution");
    expect(html).toContain("尚無可讀取的專案摘要");
    expect(html).toContain('href="/student/projects/10000000-0000-4000-8000-000000000001"');
    expect(html).toContain("六階段摘要映射尚未核定");
    expect(html).toContain('hidden=""');
  });
});
