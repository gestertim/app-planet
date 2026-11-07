"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";
import { useProjectScopeRecheck } from "./protected-project-view.tsx";

let lastObservedPathname: string | null = null;

function isScopePage(pathname: string): boolean {
  return /^\/student\/projects\/[^/]+\/(?:build|publish)\/?$/.test(pathname);
}

export function WorkspaceScopeRefresh() {
  const pathname = usePathname() ?? "";
  const beginScopeRecheck = useProjectScopeRecheck();

  useEffect(() => {
    const previousPathname = lastObservedPathname;
    lastObservedPathname = pathname;
    if (previousPathname !== null && previousPathname !== pathname && isScopePage(pathname)) {
      beginScopeRecheck();
    }
  }, [beginScopeRecheck, pathname]);

  return null;
}
