import { AppShell } from "@/components/app-shell";
import { ClosedAction } from "@/components/operation-state";

export default function AdminPage() {
  return (
    <AppShell
      heading="管理員工作台"
      subtitle="學校核准、帳號與平台設定的版位預覽；目前沒有管理權限或寫入服務。"
    >
      <section className="grid">
        <article className="card">
          <span className="sample-label">合成學校資料</span>
          <h2>示範學校（虛構）</h2>
          <p className="muted">此狀態僅示意未確認畫面，不代表任何真實學校狀態。</p>
          <span className="status">未確認｜畫面示例</span>
          <div className="action-list">
            <ClosedAction label="核准學校" />
            <ClosedAction label="變更核准狀態" />
          </div>
        </article>
        <article className="card">
          <span className="sample-label">平台狀態</span>
          <h2>管理功能尚未接通</h2>
          <p className="muted">沒有連接使用者、稽核、通知、用量或資料保存服務。</p>
          <span className="status">本機展示｜不寫入資料</span>
        </article>
      </section>
      <section className="card" style={{ marginTop: "1rem" }}>
        <h2>管理操作</h2>
        <p className="muted">本機原型不核發帳號、不調整預算、不發送通知，也不保存真實資料。</p>
        <div className="action-list">
          <ClosedAction label="核發學生帳號" />
          <ClosedAction label="調整用量" />
          <ClosedAction label="傳送通知" />
        </div>
      </section>
    </AppShell>
  );
}
