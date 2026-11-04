import Link from "next/link";
import { OperationNotice } from "@/components/operation-state";

// 導覽能力只能由可信 server 提供；瀏覽器端不接受自報角色。未提供時導覽保持關閉。
export interface NavCapability {
  href: string;
  label: string;
  prefetch?: boolean;
}

export function AppShell({
  children,
  heading,
  subtitle,
  capabilities = [],
  authenticated = false,
  preview = true,
  logoutRedirect = "/",
}: Readonly<{
  children: React.ReactNode;
  heading: string;
  subtitle: string;
  capabilities?: readonly NavCapability[];
  authenticated?: boolean;
  preview?: boolean;
  logoutRedirect?: "/" | "/login";
}>) {
  return (
    <div className="page-shell">
      <header className="topbar">
        <Link className="brand" href="/">
          App <span>Planet</span>
        </Link>
        <span className="preview-tag">{authenticated ? "已驗證工作階段" : preview ? "本機合成介面預覽" : "未驗證工作階段"}</span>
      </header>
      <main className="main">
        <nav aria-label="功能導覽" className="navigation">
          {capabilities.length === 0 ? (
            <span className="muted">尚無可信身分，功能導覽未開放。</span>
          ) : (
            capabilities.map((item) => (
              <Link className="nav-link" href={item.href} key={item.href} prefetch={item.prefetch}>
                {item.label}
              </Link>
            ))
          )}
        </nav>
        <p className="eyebrow">Chat. Create. Launch.</p>
        <h1>{heading}</h1>
        <p className="muted">{subtitle}</p>
        <OperationNotice authenticated={authenticated} logoutRedirect={logoutRedirect} />
        {children}
        {!authenticated && preview && (
          <p className="footer-note">
            示範資料均為合成內容，不含真實學生資料。此原型不保存輸入，也不提供正式帳號、權限或服務。
          </p>
        )}
      </main>
    </div>
  );
}
