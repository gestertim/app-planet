import Link from "next/link";
import { OperationNotice } from "@/components/operation-state";

const previews = [
  { href: "/student", label: "學生介面預覽" },
  { href: "/teacher", label: "教師介面預覽" },
  { href: "/admin", label: "管理員介面預覽" },
];

export function AppShell({
  children,
  heading,
  subtitle,
}: Readonly<{
  children: React.ReactNode;
  heading: string;
  subtitle: string;
}>) {
  return (
    <div className="page-shell">
      <header className="topbar">
        <Link className="brand" href="/">
          App <span>Planet</span>
        </Link>
        <span className="preview-tag">本機合成介面預覽</span>
      </header>
      <main className="main">
        <nav aria-label="介面預覽導覽" className="navigation">
          {previews.map((preview) => (
            <Link className="nav-link" href={preview.href} key={preview.href}>
              {preview.label}
            </Link>
          ))}
        </nav>
        <p className="eyebrow">Chat. Create. Launch.</p>
        <h1>{heading}</h1>
        <p className="muted">{subtitle}</p>
        <OperationNotice />
        {children}
        <p className="footer-note">
          示範資料均為合成內容，不含真實學生資料。此原型不保存輸入，也不提供正式帳號、權限或服務。
        </p>
      </main>
    </div>
  );
}
