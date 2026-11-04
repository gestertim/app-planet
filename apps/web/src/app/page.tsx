import Link from "next/link";

const roles = [
  {
    href: "/student",
    title: "學生介面",
    description: "查看合成作品卡片與 AI／創作操作的關閉狀態。",
  },
  {
    href: "/teacher",
    title: "教師介面",
    description: "需以已核准教師帳號登入；班級清單仍為示意，名冊服務尚未接通。",
  },
  {
    href: "/admin",
    title: "管理員介面",
    description: "需以已核准管理員帳號登入；學校狀態與管理操作仍為示意。",
  },
];

export default function HomePage() {
  return (
    <div className="page-shell">
      <header className="topbar">
        <Link className="brand" href="/">
          App <span>Planet</span>
        </Link>
        <span className="preview-tag">本機合成介面預覽</span>
      </header>
      <main className="main">
        <section className="hero">
          <p className="eyebrow">Chat. Create. Launch.</p>
          <h1>讓好奇心，成為下一個作品。</h1>
          <p>
            這是 App Planet 的本機介面骨架。請選擇要預覽的角色畫面；這些連結只開啟合成介面，不會登入或切換真實身分。
          </p>
        </section>
        <div className="notice" role="status">
          <strong>目前是本機原型</strong>
          尚未連接帳號、學校、AI、檔案或作品服務。下方資料全為合成示例，所有會改變資料或呼叫外部服務的操作均維持「尚未開放」。
        </div>
        <section aria-label="角色介面預覽" className="grid">
          {roles.map((role) => (
            <article className="card role-card" key={role.href}>
              <span className="sample-label">合成畫面</span>
              <h2>{role.title}</h2>
              <p className="muted">{role.description}</p>
              <Link className="button-link" href={role.href}>
                開啟介面預覽
              </Link>
            </article>
          ))}
        </section>
        <section aria-label="教職員登入" className="card" style={{ marginTop: "1rem" }}>
          <h2>教職員登入</h2>
          <p className="muted">既有教師或管理員帳號可由此登入；目前僅在隔離本機測試環境啟用。</p>
          <Link className="button-link" href="/login">
            前往教職員登入
          </Link>
        </section>
        <p className="footer-note">
          原型不保存資料、不使用密鑰、不建立供應商資源，也不提供學生帳號或正式操作。
        </p>
      </main>
    </div>
  );
}
