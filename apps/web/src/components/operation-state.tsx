export function OperationNotice() {
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
