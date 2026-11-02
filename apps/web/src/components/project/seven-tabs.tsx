"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const tabs = [
  { key: "blueprint", label: "我的藍圖", href: "" },
  { key: "design", label: "畫面設計", href: "/design" },
  { key: "plan", label: "創作計畫", href: "/plan" },
  { key: "build", label: "建立 App", href: "/build" },
  { key: "test", label: "測試", href: "/test" },
  { key: "versions", label: "版本", href: "/versions" },
  { key: "publish", label: "發布", href: "/publish" },
] as const;

function activeWorkspaceTab(pathname: string, basePath: string): string {
  const normalized = pathname.replace(/\/+$/, "");
  if (normalized === basePath) return "blueprint";
  if (normalized.startsWith(`${basePath}/stages/`)) {
    const rawStage = normalized.slice(`${basePath}/stages/`.length);
    let stage = rawStage;
    try { stage = decodeURIComponent(rawStage); } catch { return "blueprint"; }
    return stage === "UX/UI" ? "design" : stage === "Technical Plan" ? "plan" : "blueprint";
  }
  const suffix = normalized.slice(basePath.length + 1).split("/")[0];
  return tabs.some((tab) => tab.href.slice(1) === suffix) ? suffix : "blueprint";
}

export function SevenTabs({ projectId }: Readonly<{ projectId: string }>) {
  const pathname = usePathname() ?? "";
  const basePath = `/student/projects/${projectId}`;
  const active = activeWorkspaceTab(pathname, basePath);
  return <nav className="project-workspace-tabs" aria-label="專案工作區七頁籤" data-testid="project-workspace-tabs">
    <ul>
      {tabs.map((tab) => {
        const href = `${basePath}${tab.href}`;
        return <li key={tab.key}>
          <Link
            href={href}
            prefetch={false}
            aria-current={active === tab.key ? "page" : undefined}
            data-tab={tab.key}
          >
            {tab.label}
          </Link>
        </li>;
      })}
    </ul>
    <p>九階段是創作步驟；七頁籤是工作區區域。兩者用途不同，彼此不合併完成狀態。</p>
  </nav>;
}
