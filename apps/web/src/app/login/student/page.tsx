import Link from "next/link";
import { AppShell } from "@/components/app-shell";
import { StudentLoginForm } from "@/components/auth/student-login-form";

export const dynamic = "force-dynamic";
export default function StudentLoginPage() {
  return (
    <AppShell preview={false} heading="學生登入" subtitle="Chat. Create. Launch.">
      <StudentLoginForm />
      <p><Link href="/login">教職員登入</Link></p>
    </AppShell>
  );
}
