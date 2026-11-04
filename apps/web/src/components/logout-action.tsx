"use client";

import { useEffect, useState } from "react";

export function LogoutAction({ redirectTo = "/" }: Readonly<{ redirectTo?: "/" | "/login" }> = {}) {
  const [message, setMessage] = useState<string | null>(null);
  // hydration 前按鈕沒有 handler；先停用，避免點擊後沒有任何登出請求。
  const [ready, setReady] = useState(false);
  useEffect(() => setReady(true), []);

  async function logout() {
    setMessage(null);
    try {
      const response = await fetch("/api/v1/auth/logout", {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
      });
      if (!response.ok) throw new Error("logout_not_confirmed");
      window.location.assign(redirectTo);
    } catch {
      setMessage("無法確認登出已完成；請稍後重試。");
    }
  }

  return (
    <div className="grid gap-2">
      <button className="min-h-10 rounded-lg border px-3 font-bold" onClick={() => void logout()} type="button"
        disabled={!ready}>
        登出
      </button>
      {message && <p role="alert">{message}</p>}
    </div>
  );
}
