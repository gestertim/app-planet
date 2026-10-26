import { projectTierSchema, type ProjectTier } from "@app-planet/core";
import Link from "next/link";
import { AppShell } from "@/components/app-shell";
import { ClosedAction } from "@/components/operation-state";

const sampleProjectTier: ProjectTier = projectTierSchema.parse("A");

export default function StudentPage() {
  return (
    <AppShell
      heading="學生工作台"
      subtitle="以清楚的狀態提示協助你知道哪些內容只是展示、哪些功能尚未開放。"
    >
      <section className="grid">
        <article className="card">
          <span className="sample-label">合成資料</span>
          <h2>今天的創作空間</h2>
          <p className="muted">目前沒有連線至學生帳號或作品資料。</p>
          <p>
            <Link className="nav-link" href="/student/workspace-preview">
              開啟工作區介面預覽
            </Link>
          </p>
          <p>
            <Link className="nav-link" href="/student/save-flow-simulation">
              開啟保存流程模擬
            </Link>
          </p>
          <div className="action-list">
            <ClosedAction label="開始 AI 對話" />
            <ClosedAction label="建立作品" />
          </div>
        </article>
        <article className="card" data-project-tier={sampleProjectTier}>
          <span className="sample-label">合成作品卡片</span>
          <h2>校園植物觀察（示例）</h2>
          <p className="muted">這是介面展示用的虛構標題，並未建立或保存作品。</p>
          <span className="status">示範內容｜未連接作品服務</span>
          <div className="action-list">
            <ClosedAction label="開啟編輯器" />
            <ClosedAction label="互動預覽" />
          </div>
        </article>
      </section>
      <section aria-labelledby="student-actions" className="card" style={{ marginTop: "1rem" }}>
        <h2 id="student-actions">尚未開放的功能</h2>
        <p className="muted">本機階段不會上傳檔案、執行作品、呼叫 AI 或公開部署。</p>
        <div className="action-list">
          <ClosedAction label="上傳檔案" />
          <ClosedAction label="執行作品" />
          <ClosedAction label="發布作品" />
        </div>
      </section>
    </AppShell>
  );
}
