import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const readers = vi.hoisted(() => ({
  students: vi.fn(),
  project: vi.fn(),
  session: vi.fn(),
}));

vi.mock("../../apps/web/src/server/teacher-page-access.ts", () => ({
  resolveTeacherPageSession: readers.session,
}));
vi.mock("../../apps/web/src/server/teacher-resources.ts", () => ({
  readTeacherStudents: readers.students,
  readTeacherProject: readers.project,
}));

const { default: TeacherStudentsPage } = await vi.importActual<{
  default: (props: {
    searchParams: Promise<Record<string, string | string[] | undefined>>;
  }) => Promise<React.ReactElement>;
}>("../../apps/web/src/app/teacher/students/page.tsx");
const { default: TeacherProjectPage } = await vi.importActual<{
  default: (props: {
    params: Promise<{ studentId: string; projectId: string }>;
  }) => Promise<React.ReactElement>;
}>("../../apps/web/src/app/teacher/students/[studentId]/projects/[projectId]/page.tsx");

beforeEach(() => {
  vi.clearAllMocks();
  readers.session.mockResolvedValue({ outcome: "ready", session: {} });
  readers.students.mockResolvedValue({ outcome: "dependency_failure" });
  readers.project.mockResolvedValue({ outcome: "dependency_failure" });
});

describe("教師唯讀頁面讀取失敗", () => {
  it("學生名冊顯示保留分頁參數的鍵盤可操作重試連結", async () => {
    const html = renderToStaticMarkup(await TeacherStudentsPage({
      searchParams: Promise.resolve({ after: "10000000-0000-4000-8000-000000000001", limit: "10" }),
    }));

    expect(readers.students).toHaveBeenCalledOnce();
    expect(html).toContain("目前無法讀取學生名冊");
    expect(html).toContain("href=\"/teacher/students?after=10000000-0000-4000-8000-000000000001&amp;limit=10\"");
    expect(html).toContain("重新讀取學生名冊");
  });

  it("專案權限重新確認失敗時隱藏內容並提供重新讀取連結", async () => {
    const html = renderToStaticMarkup(await TeacherProjectPage({
      params: Promise.resolve({
        studentId: "10000000-0000-4000-8000-000000000001",
        projectId: "20000000-0000-4000-8000-000000000002",
      }),
    }));

    expect(readers.project).toHaveBeenCalledOnce();
    expect(html).toContain("目前無法重新確認專案權限");
    expect(html).toContain("href=\"/teacher/students/10000000-0000-4000-8000-000000000001/projects/20000000-0000-4000-8000-000000000002\"");
    expect(html).toContain("重新確認專案權限");
  });
});
