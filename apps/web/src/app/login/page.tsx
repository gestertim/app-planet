import Link from "next/link";
import { AppShell } from "@/components/app-shell";
import { StaffLoginForm } from "@/components/auth/staff-login-form";

export const dynamic = "force-dynamic";

export default function StaffLoginPage() {
  return (
    <AppShell preview={false} heading="教職員登入" subtitle="使用既有的教師或管理員帳號登入；登入狀態由伺服器確認。">
      <StaffLoginForm />
      <p><Link href="/login/student">學生登入</Link></p>
      <p className="footer-note">
        還沒有教師帳號？<Link href="/signup">申請教師帳號</Link>（需電郵驗證與管理員審核）。
        本頁不提供管理員註冊、學生註冊或重設密碼。目前僅在隔離本機測試環境啟用。
      </p>
    </AppShell>
  );
}
