"use client";

import { createContext, useCallback, useContext, useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";

const AccessLost = createContext<() => void>(() => undefined);
export const useProjectAccessLost = () => useContext(AccessLost);

export function ProtectedProjectView({ revision, children }: Readonly<{
  revision: string;
  children: React.ReactNode;
}>) {
  const router = useRouter();
  const [checking, setChecking] = useState(true);
  const [closed, setClosed] = useState(false);
  const [, startTransition] = useTransition();
  const close = useCallback(() => setClosed(true), []);
  useEffect(() => { setChecking(false); }, [revision]);
  useEffect(() => {
    const refresh = () => {
      setChecking(true);
      startTransition(() => router.refresh());
    };
    const visibility = () => {
      if (document.visibilityState === "hidden") setChecking(true);
      else refresh();
    };
    const timer = window.setInterval(refresh, 15_000);
    window.addEventListener("focus", refresh);
    window.addEventListener("pageshow", refresh);
    document.addEventListener("visibilitychange", visibility);
    refresh();
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", refresh);
      window.removeEventListener("pageshow", refresh);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [router]);
  return <AccessLost.Provider value={close}>
    {closed ? <p role="alert" className="card">無法確認存取權限；受保護專案資料已隱藏。請重新載入確認。</p> : <>
      {checking && <p role="status">正在重新確認存取權限；專案資料暫時隱藏。</p>}
      <div hidden={checking}>{children}</div>
    </>}
  </AccessLost.Provider>;
}
