import Link from "next/link";
import { AppShell } from "@/components/app-shell";
import { TeacherRelationshipNotice } from "@/components/auth/teacher-relationship-notice";
import { StudentCreationSpace } from "@/components/student/creation-space";
import { CreateProjectForm } from "@/components/project/create-project-form";
import { ProtectedProjectView } from "@/components/project/protected-project-view";
import { resolvePagePrincipal } from "@/server/page-principal";
import { listCurrentOwnedProjectsSubset } from "@/server/projects";

export const dynamic = "force-dynamic";

export default async function StudentPage() {
  const principal = await resolvePagePrincipal();
  if (!principal.ok) return <AppShell preview={false} heading="學生工作台" subtitle="登入狀態由伺服器確認。">
    <p role="alert" className="card">{principal.reason === "unauthenticated"
      ? "尚未登入或工作階段已失效；請使用核准的登入流程。"
      : "目前無法確認登入狀態；受保護資料不會顯示。"}</p>
  </AppShell>;
  const result = await listCurrentOwnedProjectsSubset(principal.session.read);
  if (result.outcome !== "listed") return <AppShell preview={false} heading="學生工作台" subtitle="專案資料未載入。">
    <p role="alert" className="card">{result.outcome === "denied"
      ? "目前帳號沒有檢視專案的權限；受保護資料已隱藏。"
      : "專案服務暫時無法確認；不是空清單，請稍後重新載入。"}</p>
  </AppShell>;
  const projects = result.projects.toSorted((a, b) => b.created_at.localeCompare(a.created_at) || a.id.localeCompare(b.id));
  return <ProtectedProjectView revision={crypto.randomUUID()}>
    <StudentCreationSpace key={principal.operationStorageScope}>
      <TeacherRelationshipNotice />
      <section className="card" data-testid="owned-project-list">
        <h2>我的專案</h2>
        <p>只顯示伺服器確認屬於目前帳號的專案。下方可建立自己的新專案。</p>
        {projects.length === 0 ? <p>目前沒有專案。可以從下方建立表單開始創作。</p> : <ul>{projects.map((project) =>
          <li key={project.id}>
            <Link prefetch={false} href={`/student/projects/${project.id}`}>{project.title}</Link>
            <span> — {project.stage}／{project.classification_state === "confirmed"
              ? `已確認 ${project.tier}` : project.classification_state === "unconfirmed" ? "未分類" : "歷史分類未驗證"}</span>
          </li>)}</ul>}
      </section>
      {projects.length > 0 && <section className="card" data-testid="continue-project">
        <h2>繼續我的創作</h2>
        <h3>{projects[0].title}</h3>
        <p>實際階段：{projects[0].stage}。尚無可讀取的專案摘要。</p>
        <Link prefetch={false} href={`/student/projects/${projects[0].id}`}>繼續創作：{projects[0].title}</Link>
      </section>}
      <section className="card"><h2>創作旅程</h2>
        <p>六階段摘要映射尚未核定，暫不顯示推導進度；請進入專案查看實際保存紀錄。這不代表任何階段已批准。</p>
      </section>
      <CreateProjectForm key={principal.operationStorageScope} storageScope={principal.operationStorageScope} />
    </StudentCreationSpace>
  </ProtectedProjectView>;
}
