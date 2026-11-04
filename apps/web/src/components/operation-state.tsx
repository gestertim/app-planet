import type { OperationPresentation } from "./operation-presentation";
import { LogoutAction } from "./logout-action";

export function OperationNotice({
  authenticated = false,
  logoutRedirect = "/",
}: Readonly<{ authenticated?: boolean; logoutRedirect?: "/" | "/login" }>) {
  if (authenticated) {
    return (
      <div className="notice" role="status">
        <strong>伺服器已驗證登入</strong>
        每次讀取與保存仍會重新檢查登入狀態、帳號資格及作品權限。
        <LogoutAction redirectTo={logoutRedirect} />
      </div>
    );
  }
  return (
    <div className="notice" role="status">
      <strong>本機原型，功能尚未開放</strong>
      此頁只展示合成資料與介面狀態，不是登入後的正式畫面；不連接資料庫、AI、上傳或部署服務，任何操作都不會寫入資料。
    </div>
  );
}

export function ClosedAction({ label }: Readonly<{ label: string }>) {
  return (
    <button className="closed-action" disabled type="button">
      {label}｜尚未開放
    </button>
  );
}

// 狀態橫幅：固定碼＋繁中下一步；只有 kind="saved" 才會宣稱已保存。
export function OperationStatusBanner({ presentation }: Readonly<{ presentation: OperationPresentation }>) {
  return (
    <div
      id="operation-status"
      aria-live="polite"
      className={`operation-banner operation-${presentation.tone}`}
      data-code={presentation.code}
      data-kind={presentation.kind}
      role="status"
    >
      <strong>{presentation.title}</strong>
      <span className="operation-code">（{presentation.code}）</span>
      <p>{presentation.nextStep}</p>
      {presentation.savedVersion !== null && <p>已確認版本 {presentation.savedVersion}。</p>}
    </div>
  );
}
