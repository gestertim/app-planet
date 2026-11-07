import type { Page } from "@playwright/test";

export type HoldRule = Readonly<{ method: string; pathSuffix: string; searchIncludes?: string }>;

// 僅測試 context 暫扣真回應本文，確認產品已進入 json()，並等待本文交回後排空 microtask。
export function installResponseHold() {
  const w = window as unknown as Record<string, unknown>;
  const original = window.fetch.bind(window);
  const state: Record<string, unknown> = {
    rule: null, matched: 0, status: 0, jsonCalled: false, jsonSettled: false, released: null, release: null,
  };
  w.__apHold = state;
  w.__apArmHold = (rule: HoldRule) => {
    let release: () => void = () => undefined;
    const released = new Promise<void>((resolve) => { release = resolve; });
    Object.assign(state, { rule, matched: 0, status: 0, jsonCalled: false, jsonSettled: false, released, release });
  };
  w.__apReleaseHold = () => (state.release as () => void)();
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const href = input instanceof Request ? input.url : String(input);
    const url = new URL(href, window.location.href);
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    const rule = state.rule as HoldRule | null;
    if (!rule || method !== rule.method || !url.pathname.endsWith(rule.pathSuffix) ||
        (rule.searchIncludes && !url.search.includes(rule.searchIncludes))) return original(input, init);
    state.rule = null;
    state.matched = (state.matched as number) + 1;
    const upstream = await original(input, init);
    const bytes = new Uint8Array(await upstream.arrayBuffer());
    state.status = upstream.status;
    const released = state.released as Promise<void>;
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        await released;
        controller.enqueue(bytes);
        controller.close();
      },
    }, { highWaterMark: 0 });
    const held = new Response(body, {
      status: upstream.status, statusText: upstream.statusText, headers: upstream.headers,
    });
    const nativeJson = held.json.bind(held);
    held.json = () => {
      state.jsonCalled = true;
      return nativeJson().finally(() => { state.jsonSettled = true; });
    };
    return held;
  };
}

export const armHold = (page: Page, rule: HoldRule) =>
  page.evaluate((value) => (window as unknown as { __apArmHold(rule: unknown): void }).__apArmHold(value), rule);
export const holdState = (page: Page) =>
  page.evaluate(() => {
    const state = (window as unknown as { __apHold: Record<string, unknown> }).__apHold;
    return { matched: state.matched as number, status: state.status as number,
      jsonCalled: state.jsonCalled as boolean, jsonSettled: state.jsonSettled as boolean };
  });
export const waitBodyAwaited = (page: Page) => page.waitForFunction(() =>
  (window as unknown as { __apHold: { jsonCalled: boolean } }).__apHold.jsonCalled === true, null, { timeout: 20_000 });
export async function releaseHoldAndDrain(page: Page) {
  await page.evaluate(() => (window as unknown as { __apReleaseHold(): void }).__apReleaseHold());
  await page.waitForFunction(() =>
    (window as unknown as { __apHold: { jsonSettled: boolean } }).__apHold.jsonSettled === true, null, { timeout: 20_000 });
  await page.evaluate(() => new Promise<void>((resolve) => { setTimeout(resolve, 0); }));
}
