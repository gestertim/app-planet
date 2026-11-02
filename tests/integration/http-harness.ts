import http from "node:http";
import type { AddressInfo } from "node:net";
import { Readable } from "node:stream";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { createServer as createViteServer, type ViteDevServer } from "vite";
import type { UsageContext } from "@app-planet/core";
import type { AuthorizationContext } from "../../apps/web/src/server/authorization.ts";
import { readOwnedStageDraftSubset } from "../../apps/web/src/server/stage-drafts.ts";
import { readOwnedProjectWithClassificationSubset } from "../../apps/web/src/server/projects.ts";
import {
  closedPrincipalResolver,
  type LogSink,
  type TrustedPrincipalResolver,
  type TrustedSession,
} from "../../apps/web/src/server/http.ts";
import { createFoundationHandlers } from "../../apps/web/src/server/foundation-handlers.ts";
import type { ProjectCreationContext } from "../../apps/web/src/server/projects.ts";

export interface HarnessSessionFactory {
  read(subject: string): AuthorizationContext;
  write(subject: string): ProjectCreationContext;
  usage(subject: string): UsageContext;
}

export interface HarnessFaults {
  dropResponseAfterHandler?: boolean;
  malformedSuccessResponse?: boolean;
  beforeExecute?: (operation: "save_stage_draft" | "create_job" | "cancel_job") => Promise<void>;
}

export interface Harness {
  readonly url: string;
  readonly logs: unknown[];
  readonly faults: HarnessFaults;
  register(token: string, subject: string): void;
  issueBrowserSession(subject: string): string;
  close(): Promise<void>;
}

export async function startHarness(
  sessions: HarnessSessionFactory,
  options: { productResolver?: boolean; browserHost?: boolean } = {},
): Promise<Harness> {
  const tokens = new Map<string, string>();
  const logs: unknown[] = [];
  const faults: HarnessFaults = {};
  const vite: ViteDevServer | null = options.browserHost
    ? await createViteServer({
        configFile: false,
        root: process.cwd(),
        appType: "custom",
        logLevel: "error",
        esbuild: { jsxInject: "import React from 'react'" },
        resolve: { alias: { "next/navigation": resolve(process.cwd(), "tests/support/next-navigation-stub.ts") } },
        optimizeDeps: { entries: ["tests/e2e/foundation-save-host.tsx"], include: ["@radix-ui/react-dialog"] },
        server: { middlewareMode: true, hmr: false },
      })
    : null;
  if (vite) {
    // 冷快取時先預熱宿主與依賴預打包，避免首個瀏覽器案例的 5 秒斷言被 Vite 首次最佳化吃掉。
    await vite.transformRequest("/tests/e2e/foundation-save-host.tsx");
    await vite.waitForRequestsIdle();
  }
  const log: LogSink = (record) => { logs.push(record); };
  const testResolver: TrustedPrincipalResolver = {
    async resolve(request) {
      const cookie = request.headers.get("cookie")
        ?.split(";")
        .map((part) => part.trim())
        .find((part) => part.startsWith("app-planet-test-session="))
        ?.slice("app-planet-test-session=".length);
      const token = request.headers.get("x-test-principal") ?? cookie ?? null;
      const subject = token === null ? undefined : tokens.get(token);
      if (subject === undefined) return { ok: false, reason: "unauthenticated" };
      const session: TrustedSession = {
        read: sessions.read(subject),
        write: sessions.write(subject),
        usage: sessions.usage(subject),
      };
      return { ok: true, session };
    },
  };
  const handlers = createFoundationHandlers({
    resolver: options.productResolver ? closedPrincipalResolver : testResolver,
    log,
    beforeExecute: async (operation) => faults.beforeExecute?.(operation),
  });

  const route = (request: Request): Promise<Response> => {
    const path = new URL(request.url).pathname;
    const contractDraft = /^\/api\/v1\/projects\/([^/]+)\/stages\/([^/]+)$/.exec(path);
    if (contractDraft) {
      return handlers.saveStageDraft(
        request,
        decodeURIComponent(contractDraft[1]),
        decodeURIComponent(contractDraft[2]),
      );
    }
    const draft = /^\/test\/projects\/([^/]+)\/stages\/([^/]+)\/draft$/.exec(path);
    if (draft) {
      return handlers.saveStageDraft(
        request,
        decodeURIComponent(draft[1]),
        decodeURIComponent(draft[2]),
      );
    }
    if (path === "/test/jobs" || path === "/api/v1/jobs") return handlers.createJob(request);
    const cancel = /^\/test\/jobs\/([^/]+)\/cancel$/.exec(path);
    if (cancel) return handlers.cancelJob(request, decodeURIComponent(cancel[1]));
    const stopRun = /^\/api\/v1\/agent-runs\/([^/]+)\/stop$/.exec(path);
    if (stopRun) return handlers.stopAgentRun(request, decodeURIComponent(stopRun[1]));
    const job = /^\/(?:test|api\/v1)\/jobs\/([^/]+)$/.exec(path);
    if (job) return handlers.getJob(request, decodeURIComponent(job[1]));
    return Promise.resolve(new Response("not found", { status: 404 }));
  };

  const server = http.createServer(async (incoming, outgoing) => {
    try {
      const path = new URL(incoming.url ?? "/", "http://127.0.0.1").pathname;
      if (options.browserHost && path === "/__test__/save-editor" && incoming.method === "GET") {
        outgoing.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        outgoing.end(`<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>App Planet 基礎保存整合</title></head><body><div id="root"></div><script type="module" src="/tests/e2e/foundation-save-host.tsx"></script></body></html>`);
        return;
      }
      if (options.browserHost && path === "/__test__/fixture" && incoming.method === "GET") {
        const fixtureUrl = new URL(incoming.url ?? "/", "http://127.0.0.1");
        const cookieHeader = incoming.headers.cookie;
        const token = typeof cookieHeader === "string"
          ? cookieHeader.split(";").map((part) => part.trim())
            .find((part) => part.startsWith("app-planet-test-session="))
            ?.slice("app-planet-test-session=".length)
          : undefined;
        const subject = token === undefined ? undefined : tokens.get(token);
        const projectId = fixtureUrl.searchParams.get("project_id");
        const stage = fixtureUrl.searchParams.get("stage");
        if (subject === undefined) {
          outgoing.writeHead(401, { "cache-control": "no-store" });
          outgoing.end();
          return;
        }
        if (projectId === null || stage === null) {
          outgoing.writeHead(400, { "cache-control": "no-store" });
          outgoing.end();
          return;
        }
        const draft = await readOwnedStageDraftSubset(sessions.read(subject), {
          project_id: projectId,
          stage,
        });
        if (draft.outcome === "denied") {
          outgoing.writeHead(403, { "cache-control": "no-store" });
          outgoing.end();
          return;
        }
        const project = draft.outcome === "not_found"
          ? await readOwnedProjectWithClassificationSubset(sessions.read(subject), projectId)
          : null;
        if (project && project.outcome !== "found") {
          outgoing.writeHead(404, { "cache-control": "no-store" });
          outgoing.end();
          return;
        }
        if (draft.outcome !== "found" && draft.outcome !== "not_found") {
          outgoing.writeHead(500, { "cache-control": "no-store" });
          outgoing.end();
          return;
        }
        outgoing.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        outgoing.end(JSON.stringify({
          draft: draft.outcome === "found" ? draft.draft : null,
          target: { project_id: projectId, stage },
          hasTrustedPrincipal: true,
        }));
        return;
      }
      if (vite && !path.startsWith("/api/v1/") && !path.startsWith("/test/")) {
        vite.middlewares(incoming, outgoing, (error?: Error) => {
          if (!error || outgoing.writableEnded) return;
          outgoing.writeHead(500, { "cache-control": "no-store" });
          outgoing.end();
        });
        return;
      }
      const headers = new Headers();
      for (let i = 0; i < incoming.rawHeaders.length; i += 2) {
        headers.append(incoming.rawHeaders[i], incoming.rawHeaders[i + 1]);
      }
      const hasBody = incoming.method !== "GET" && incoming.method !== "HEAD";
      const request = new Request(`http://127.0.0.1${incoming.url ?? "/"}`, {
        method: incoming.method,
        headers,
        body: hasBody ? (Readable.toWeb(incoming) as ReadableStream) : undefined,
        duplex: "half",
      } as RequestInit);
      let response = await route(request);
      if (faults.malformedSuccessResponse && request.method === "PUT" && (response.status === 200 || response.status === 201) &&
          response.headers.get("content-type")?.includes("application/json")) {
        const payload: unknown = await response.json();
        if (response.headers.get("idempotent-replay") === "true" &&
            typeof payload === "object" && payload !== null && !Array.isArray(payload)) {
          response = new Response(JSON.stringify({
            ...payload,
            current_draft: { outcome: "found", draft: { row_version: "malformed" } },
          }), { status: 200, headers: response.headers });
        } else if (typeof payload === "object" && payload !== null && !Array.isArray(payload)) {
          response = new Response(JSON.stringify({ ...payload, row_version: "malformed" }), {
            status: response.status,
            headers: response.headers,
          });
        }
      }
      if (faults.dropResponseAfterHandler) {
        incoming.socket.destroy();
        return;
      }
      outgoing.writeHead(response.status, Object.fromEntries(response.headers));
      outgoing.end(Buffer.from(await response.arrayBuffer()));
    } catch {
      incoming.socket.destroy();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    logs,
    faults,
    register(token, subject) { tokens.set(token, subject); },
    issueBrowserSession(subject) {
      const token = randomUUID();
      tokens.set(token, subject);
      return token;
    },
    async close() {
      try {
        await vite?.close();
      } finally {
        await new Promise<void>((resolve, reject) => {
          server.closeAllConnections();
          server.close((error) => error ? reject(error) : resolve());
        });
        console.info("HARNESS_CLOSED", JSON.stringify({ port, listening: server.listening, pid: process.pid }));
      }
    },
  };
}
