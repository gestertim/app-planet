import Link from "next/link";
import { AppShell } from "@/components/app-shell";
import { LogoutAction } from "@/components/logout-action";
import type { PageAccount } from "@/server/page-principal";

// 角色頁與狀態頁共用的拒絕畫面：不顯示任何角色內容或示意資料。
export function AccountGateNotice({ account, heading }: Readonly<{ account: PageAccount; heading: string }>) {
  if (account.kind === "signed_out") {
    return (
      <AppShell preview={false} heading={heading} subtitle="登入狀態由伺服器確認。">
        <div className="card" role="alert">
          <p>尚未登入，或登入已過期。請重新登入。</p>
          <Link className="button-link" href="/login">前往教職員登入</Link>
        </div>
      </AppShell>
    );
  }
  if (account.kind === "unavailable") {
    return (
      <AppShell preview={false} heading={heading} subtitle="登入狀態由伺服器確認。">
        <p className="card" role="alert">目前無法確認登入狀態；受保護內容不會顯示，請稍後重新載入。</p>
      </AppShell>
    );
  }
  return (
    <AppShell preview={false} heading={heading} subtitle="登入狀態由伺服器確認。">
      <div className="card" role="alert">
        <p>{account.kind === "account_unavailable"
          ? "帳號目前無法使用；受保護內容不會顯示。"
          : "目前帳號沒有這個頁面的權限；內容不會顯示。"}</p>
        {account.kind === "account" && <Link className="button-link" href="/account/status">查看我的帳號狀態</Link>}
        <LogoutAction redirectTo="/login" />
      </div>
    </AppShell>
  );
}
