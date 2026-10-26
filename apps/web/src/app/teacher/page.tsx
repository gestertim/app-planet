import { AppShell } from "@/components/app-shell";
import { ClosedAction } from "@/components/operation-state";

export default function TeacherPage() {
  return (
    <AppShell
      heading="教師工作台"
      subtitle="班級、學生綁定與作品檢視目前只展示空間配置，沒有連接學校或帳號資料。"
    >
      <section className="grid">
        <article className="card">
          <span className="sample-label">合成班級摘要</span>
          <h2>我的班級（示例）</h2>
          <p className="muted">尚未連接名冊；此處不含真實學生資料。</p>
          <span className="status">名冊服務｜尚未接通</span>
        </article>
        <article className="card">
          <span className="sample-label">合成名冊列</span>
          <div className="list-row">
            <div>
              <strong>學生樣例 A-01</strong>
              <div className="muted">合成識別碼，非真實帳號</div>
            </div>
            <span className="status">示範資料</span>
          </div>
          <div className="action-list">
            <ClosedAction label="檢視作品" />
            <ClosedAction label="提供回饋" />
          </div>
        </article>
      </section>
      <section className="card" style={{ marginTop: "1rem" }}>
        <h2>教師操作</h2>
        <p className="muted">學生綁定、核發帳號、審查與回饋均未接通，不會產生任何變更。</p>
        <div className="action-list">
          <ClosedAction label="綁定學生" />
          <ClosedAction label="核發帳號" />
          <ClosedAction label="審查作品" />
        </div>
      </section>
    </AppShell>
  );
}
