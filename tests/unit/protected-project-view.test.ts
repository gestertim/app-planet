import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({
  slots: [] as unknown[],
  cursor: 0,
  pathname: "/student/projects/project/build",
  refresh: vi.fn(),
  replace: vi.fn(),
  effects: [] as Array<() => void>,
}));

vi.mock("next/navigation", () => ({
  usePathname: () => harness.pathname,
  useRouter: () => ({ refresh: harness.refresh, replace: harness.replace }),
}));

vi.mock("react", async (importOriginal) => {
  const react = await importOriginal<typeof import("react")>();
  return {
    ...react,
    useRef: <T>(initial: T) => {
      const index = harness.cursor++;
      harness.slots[index] ??= { current: initial };
      return harness.slots[index];
    },
    useState: <T>(initial: T) => {
      const index = harness.cursor++;
      if (!(index in harness.slots)) harness.slots[index] = initial;
      return [harness.slots[index], (next: T | ((current: T) => T)) => {
        const current = harness.slots[index] as T;
        harness.slots[index] = typeof next === "function"
          ? (next as (current: T) => T)(current) : next;
      }];
    },
    useCallback: <T>(callback: T) => callback,
    useEffect: (effect: () => void) => harness.effects.push(effect),
    useTransition: () => [false, (operation: () => void) => operation()],
  };
});

import { ProtectedProjectView } from "../../apps/web/src/components/project/protected-project-view.tsx";

// 直接呼叫產品 Provider 的接收 callback；只控制 React hook 儲存與路由，
// 不模擬／複製 reportScope 的判斷，也不把框架捨棄回應當成接收邊界驗證。
function render(revision: string) {
  harness.cursor = 0;
  harness.effects.length = 0;
  const tree = ProtectedProjectView({
    revision, projectId: "project", accountScope: "account", children: null,
  });
  harness.effects[0]!();
  return tree.props.value;
}

describe("受保護工作區的實際結果接收邊界", () => {
  afterEach(() => vi.unstubAllGlobals());
  beforeEach(() => {
    harness.slots.length = 0;
    harness.cursor = 0;
    harness.refresh.mockClear();
    harness.replace.mockClear();
    vi.stubGlobal("window", {
      location: { href: "https://localhost/student/projects/project/build#file=index.html" },
      history: { state: {}, replaceState: vi.fn() },
    });
  });

  it("本次重驗等待中，首次抵達的較早正向結果不能解除遮蔽", () => {
    const earlier = render("initial-layout");
    earlier.beginScopeRecheck();
    const oldRequest = new URL(harness.replace.mock.calls.at(-1)![0], "https://localhost")
      .searchParams.get("__scope_request");
    earlier.beginScopeRecheck();
    const currentRequest = new URL(harness.replace.mock.calls.at(-1)![0], "https://localhost")
      .searchParams.get("__scope_request");
    expect(currentRequest).not.toBe(oldRequest);
    const current = render("earlier-response-layout");
    const before = harness.slots.slice();
    current.reportScope("project", "a1_preview", { kind: "within_scope" }, "first-late-result", oldRequest, "account");
    expect(harness.slots).toEqual(before);
    window.location.href = `https://localhost/student/projects/project/build?keep=1&__scope_request=${currentRequest}#file=index.html`;
    current.reportScope("project", "a1_preview", { kind: "outside_scope", blockers: [] },
      "current-result", currentRequest, "account");
    expect(harness.slots).not.toEqual(before);
    expect(harness.replace.mock.calls.at(-1)![0]).toContain("#file=index.html");
    expect(window.history.replaceState).toHaveBeenCalledWith(
      window.history.state, "", "/student/projects/project/build?keep=1#file=index.html",
    );
  });

  it("不同帳號與用途的正向結果不可採納；同專案可信拒絕仍可關閉父層", () => {
    const boundary = render("initial-layout");
    boundary.beginScopeRecheck();
    const requestId = new URL(harness.replace.mock.calls.at(-1)![0], "https://localhost")
      .searchParams.get("__scope_request");
    const before = harness.slots.slice();
    boundary.reportScope("project", "a1_preview", { kind: "within_scope" }, "other-account", requestId, "other");
    boundary.reportScope("project", "public", { kind: "within_scope" }, "other-purpose", requestId, "account");
    expect(harness.slots).toEqual(before);
    boundary.reportScope("project", "a1_preview", { kind: "access_closed" }, "denied", requestId, null);
    expect(harness.slots).not.toEqual(before);
  });
});
