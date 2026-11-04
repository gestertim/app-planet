import type { Metadata } from "next";
import { cookies } from "next/headers";
import { AppShell } from "@/components/app-shell";
import { EmailVerifyPanel } from "@/components/auth/email-verify-panel";
import { readVerifyCookie, verifyCookieName } from "@/server/auth/teacher-signup";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { referrer: "no-referrer" };

export default async function EmailVerifyPage() {
  const store = await cookies();
  const raw = store.get(verifyCookieName)?.value;
  // 只判斷是否有格式正確的待確認連結；值本身不輸出到頁面。
  const hasPendingLink = raw !== undefined && readVerifyCookie(`${verifyCookieName}=${raw}`) !== null;
  return (
    <AppShell preview={false} heading="教師申請電郵驗證" subtitle="確認電郵後，帳號仍需平台管理員審核。">
      <EmailVerifyPanel hasPendingLink={hasPendingLink} />
    </AppShell>
  );
}
