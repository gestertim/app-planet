"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  useTransition,
} from "react";
import { usePathname, useRouter } from "next/navigation";
import type { WorkEligibilityContext } from "@app-planet/core";
import type { WorkLimitationsState } from "./work-limitations-state.ts";

type ProjectAccessContextValue = Readonly<{
  close: (message?: string) => void;
  reportScope: (
    projectId: string,
    purpose: WorkEligibilityContext,
    state: WorkLimitationsState,
    resultId: string,
    requestId: string | null,
    accountScope: string | null,
  ) => void;
  beginScopeRecheck: () => void;
}>;

const noClose = () => undefined;
const noScopeReport = () => undefined;
const noScopeRecheck = () => undefined;
const ProjectAccess = createContext<ProjectAccessContextValue>({
  close: noClose,
  reportScope: noScopeReport,
  beginScopeRecheck: noScopeRecheck,
});

export const useProjectAccessLost = () => useContext(ProjectAccess).close;
export const useProjectScopeResult = () => useContext(ProjectAccess).reportScope;
export const useProjectScopeRecheck = () => useContext(ProjectAccess).beginScopeRecheck;

function scopePagePath(projectId: string, purpose: WorkEligibilityContext): string {
  return `/student/projects/${encodeURIComponent(projectId)}/${purpose === "a1_preview" ? "build" : "publish"}`;
}

function isScopePage(pathname: string): boolean {
  return /^\/student\/projects\/[^/]+\/(?:build|publish)\/?$/.test(pathname);
}

export function ProtectedProjectView({ revision, projectId, accountScope, children }: Readonly<{
  revision: string;
  projectId?: string;
  accountScope?: string;
  children: React.ReactNode;
}>) {
  const pathname = usePathname() ?? "";
  const router = useRouter();
  const content = useRef<HTMLDivElement>(null);
  const status = useRef<HTMLParagraphElement>(null);
  const navigation = useRef({ pathname, epoch: 0 });
  const expectedRequest = useRef<string | null | undefined>(undefined);
  if (navigation.current.pathname !== pathname) {
    navigation.current = { pathname, epoch: navigation.current.epoch + 1 };
    expectedRequest.current = "";
  }
  const navigationEpoch = navigation.current.epoch;
  const [checking, setChecking] = useState(true);
  const [closedState, setClosedState] = useState<{
    projectId: string | null;
    epoch: number;
    message: string | null;
  } | null>(null);
  const [scopeResult, setScopeResult] = useState<{
    epoch: number;
    pathname: string;
    revision: string;
    requestId: string | null;
  } | null>(null);
  const lastScopeResultIds = useRef(new Map<string, string>());
  const [, startTransition] = useTransition();

  const close = useCallback((message?: string) => {
    if (navigation.current.pathname !== pathname ||
        navigation.current.epoch !== navigationEpoch) return;
    setClosedState({
      projectId: projectId ?? null,
      epoch: navigationEpoch,
      message: message ?? null,
    });
  }, [navigationEpoch, pathname, projectId]);

  const beginScopeRecheck = useCallback(() => {
    if (navigation.current.pathname !== pathname ||
        navigation.current.epoch !== navigationEpoch || !isScopePage(pathname)) return;
    const requestId = crypto.randomUUID();
    expectedRequest.current = requestId;
    setScopeResult(null);
    if (status.current) status.current.hidden = false;
    if (content.current) content.current.hidden = true;
    const url = new URL(window.location.href);
    // 僅關聯當次重驗；伺服器仍逐次執行原授權讀取，nonce 不提供權限。
    url.searchParams.set("__scope_request", requestId);
    startTransition(() => router.replace(`${url.pathname}${url.search}${url.hash}`, { scroll: false }));
  }, [navigationEpoch, pathname, router]);

  const reportScope = useCallback((
    reportedProjectId: string,
    purpose: WorkEligibilityContext,
    state: WorkLimitationsState,
    resultId: string,
    requestId: string | null,
    reportedAccountScope: string | null,
  ) => {
    if (navigation.current.pathname !== pathname ||
        navigation.current.epoch !== navigationEpoch ||
        !projectId || reportedProjectId !== projectId ||
        scopePagePath(reportedProjectId, purpose) !== pathname) return;
    if (state.kind === "access_closed") {
      setClosedState({
        projectId: reportedProjectId,
        epoch: navigationEpoch,
        message: null,
      });
      return;
    }
    if (reportedAccountScope !== accountScope ||
        (expectedRequest.current !== undefined && requestId !== expectedRequest.current)) return;
    const resultPath = scopePagePath(reportedProjectId, purpose);
    if (!resultId || lastScopeResultIds.current.get(resultPath) === resultId) return;
    lastScopeResultIds.current.set(resultPath, resultId);
    expectedRequest.current = requestId;
    const url = new URL(window.location.href);
    if (requestId !== null && url.searchParams.get("__scope_request") === requestId) {
      url.searchParams.delete("__scope_request");
      window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
    }
    if (state.kind !== "unavailable") {
      setClosedState((current) =>
        current?.projectId === reportedProjectId ? null : current);
    }
    setScopeResult({
      epoch: navigationEpoch,
      pathname,
      revision,
      requestId,
    });
  }, [accountScope, navigationEpoch, pathname, projectId, revision]);

  useEffect(() => { setChecking(false); }, [revision]);

  useEffect(() => {
    const refresh = () => {
      if (isScopePage(pathname)) beginScopeRecheck();
      else {
        setChecking(true);
        startTransition(() => router.refresh());
      }
    };
    const pageShow = (event: PageTransitionEvent) => {
      if (event.persisted) refresh();
    };
    const maskBeforeSuspension = () => {
      if (!isScopePage(pathname)) return;
      expectedRequest.current = "";
      setScopeResult(null);
      if (status.current) status.current.hidden = false;
      if (content.current) content.current.hidden = true;
    };
    const visibility = () => {
      if (document.visibilityState === "hidden") maskBeforeSuspension();
      else refresh();
    };
    const timer = window.setInterval(refresh, 15_000);
    window.addEventListener("focus", refresh);
    window.addEventListener("pageshow", pageShow);
    window.addEventListener("pagehide", maskBeforeSuspension);
    document.addEventListener("visibilitychange", visibility);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", refresh);
      window.removeEventListener("pageshow", pageShow);
      window.removeEventListener("pagehide", maskBeforeSuspension);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [beginScopeRecheck, pathname, router]);

  const activeClosedState = closedState &&
    (closedState.projectId !== null
      ? closedState.projectId === projectId
      : closedState.epoch === navigation.current.epoch)
    ? closedState
    : null;
  const scopeResultCurrent = scopeResult?.epoch === navigation.current.epoch &&
    scopeResult.pathname === pathname && scopeResult.revision === revision &&
    scopeResult.requestId === expectedRequest.current;
  const checkingScope = isScopePage(pathname) && !scopeResultCurrent;
  const hidden = activeClosedState !== null || checking || checkingScope;

  return <ProjectAccess.Provider value={{ close, reportScope, beginScopeRecheck }}>
    <p ref={status} role="status" hidden={!hidden}>正在重新確認存取權限；專案資料暫時隱藏。</p>
    {activeClosedState && <p role="alert" className="card" data-testid="project-workspace-closed">
      無法確認存取權限；受保護專案資料已隱藏。請重新載入確認。
      {activeClosedState.message && <span> {activeClosedState.message}</span>}
    </p>}
    <div ref={content} hidden={hidden}>{children}</div>
  </ProjectAccess.Provider>;
}
