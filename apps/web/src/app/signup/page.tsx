import type { Metadata } from "next";
import Link from "next/link";
import { AppShell } from "@/components/app-shell";
import { TeacherSignupForm, TeacherSignupResendForm } from "@/components/auth/teacher-signup-form";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { referrer: "no-referrer" };

export default function TeacherSignupPage() {
  return (
    <AppShell preview={false} heading="教師帳號申請" subtitle="填寫申請、完成電郵驗證，再等待平台管理員審核。">
      <TeacherSignupForm />
      <TeacherSignupResendForm />
      <p className="footer-note">
        已有帳號？<Link href="/login">前往登入</Link>。本頁不提供管理員註冊、學生註冊或重設密碼；
        目前僅在隔離本機測試環境啟用。
      </p>
    </AppShell>
  );
}
