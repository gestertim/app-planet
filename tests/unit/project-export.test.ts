import { describe, expect, it, vi } from "vitest";
import { projectExportFilename, projectExportMaxBytes } from "@app-planet/core";
import { downloadSavedProject, type ExportDownloadTarget } from "../../apps/web/src/components/project/export-download.ts";
import { createProjectExportHandler } from "../../apps/web/src/server/project-export-handlers.ts";
import type { TrustedSession } from "../../apps/web/src/server/http.ts";
import { emptyExport } from "../fixtures/project-export.ts";

const data = emptyExport();
const response = (value: unknown = data) => new Response(JSON.stringify(value), {
  headers: { "content-type": "application/json; charset=utf-8",
    "content-disposition": `attachment; filename="${projectExportFilename}"` },
});
function target(): ExportDownloadTarget & { events: string[]; blobs: Blob[] } {
  const events: string[] = [];
  const blobs: Blob[] = [];
  return {
    events, blobs,
    createObjectURL: (blob) => { blobs.push(blob); events.push("create"); return "blob:test"; },
    revokeObjectURL: () => { events.push("revoke"); },
    download: (_url, filename) => { events.push(`download:${filename}`); },
  };
}
function handler(value: unknown, throws = false) {
  const session: TrustedSession = {
    read: { runReadOnly: async () => { throw Error("unexpected reader"); } },
    usage: { runTransaction: async () => { throw Error("unexpected usage"); } },
    write: { runTransaction: async (operation) => {
      if (throws) throw Error("private driver error");
      return operation({ query: async () => ({ rows: [{ result: value }] }) });
    } },
  };
  const logs: unknown[] = [];
  const run = createProjectExportHandler({ resolver: { resolve: async () => ({ ok: true, session }) },
    log: (event) => { logs.push(event); } });
  return { logs, run: () => run(new Request(`https://app.example/api/v1/projects/${data.project.id}/export`),
    { id: data.project.id }) };
}

describe("下載 HTTP 與 browser 傳輸", () => {
  it("固定安全檔名、UTF-8 bytes、no-store 與安全標頭", async () => {
    const { format_version: _format, saved_data_notice: _notice, ...db } = data;
    const { run, logs } = handler({ outcome: "found", data: db });
    const result = await run();
    expect(result.status).toBe(200);
    expect(result.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(result.headers.get("content-disposition")).toBe(`attachment; filename="${projectExportFilename}"`);
    expect(result.headers.get("cache-control")).toBe("no-store");
    expect(result.headers.get("x-content-type-options")).toBe("nosniff");
    expect(result.headers.get("referrer-policy")).toBe("no-referrer");
    const bytes = await result.arrayBuffer();
    expect(Number(result.headers.get("content-length"))).toBe(bytes.byteLength);
    expect(JSON.parse(new TextDecoder().decode(bytes))).toEqual(data);
    expect(JSON.stringify(logs)).not.toContain(data.project.title);
    expect(logs).toHaveLength(1);
  });
  it("DB／decoder 故障、非本人與超限全為 problem，沒有 attachment", async () => {
    for (const [value, status] of [
      [{ outcome: "not_found" }, 404], [{ outcome: "denied" }, 403],
      [{ outcome: "too_large" }, 413], [{ outcome: "found", data: {} }, 503],
      [{ outcome: "invalid_result" }, 503],
    ] as const) {
      const result = await handler(value).run();
      expect(result.status).toBe(status);
      expect(result.headers.get("content-type")).toBe("application/problem+json");
      expect(result.headers.get("content-disposition")).toBeNull();
    }
    expect((await handler(null, true).run()).status).toBe(503);
  });
  it("實際 UTF-8 8 MiB 界線含等於與多一 byte，不靠字元長度", async () => {
    const value = emptyExport();
    value.project.title = "";
    const base = Buffer.byteLength(JSON.stringify(value), "utf8");
    value.project.title = "x".repeat(projectExportMaxBytes - base);
    expect(Buffer.byteLength(JSON.stringify(value), "utf8")).toBe(projectExportMaxBytes);
    const { format_version: _format, saved_data_notice: _notice, ...db } = value;
    expect((await handler({ outcome: "found", data: db }).run()).status).toBe(200);
    value.project.title += "x";
    const { format_version: _otherFormat, saved_data_notice: _otherNotice, ...over } = value;
    const rejected = await handler({ outcome: "found", data: over }).run();
    expect(rejected.status).toBe(413);
    expect(rejected.headers.get("content-disposition")).toBeNull();
  });
  it("只從可信成功格式下載；釋放 URL，保留繁中／emoji／HTML-like 原文", async () => {
    const output = target();
    const fetcher = vi.fn<typeof fetch>(async () => response());
    await downloadSavedProject(data.project.id, new AbortController().signal, fetcher, output);
    expect(output.events).toEqual(["create", `download:${projectExportFilename}`, "revoke"]);
    expect(JSON.parse(await output.blobs[0].text())).toEqual(data);
    expect(fetcher.mock.calls[0][1]).toMatchObject({ method: "GET", cache: "no-store", credentials: "same-origin" });
  });
  it("HTTP problem、格式錯誤、非本人、UTF-8 故障、超限不產生成功檔案", async () => {
    const bad = [
      () => new Response('{"status":503}', { status: 503 }),
      () => response({ ...data, format_version: "unknown" }),
      () => response({ ...data, project: { ...data.project, id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" } }),
      () => new Response(new Uint8Array([0xff]), { headers: response().headers }),
      () => response({ ...data, project: { ...data.project, title: "x".repeat(projectExportMaxBytes) } }),
    ];
    for (const make of bad) {
      const output = target();
      await expect(downloadSavedProject(data.project.id, new AbortController().signal,
        async () => make(), output)).rejects.toThrow();
      expect(output.events).toEqual([]);
    }
  });
  it("卸載／舊請求不得下載；下載目標故障仍清理 URL", async () => {
    const controller = new AbortController();
    let resolve!: (value: Response) => void;
    const pending = new Promise<Response>((yes) => { resolve = yes; });
    const output = target();
    const work = downloadSavedProject(data.project.id, controller.signal, async () => pending, output);
    controller.abort();
    resolve(response());
    await expect(work).rejects.toThrow();
    expect(output.events).toEqual([]);
    const failing = target();
    failing.download = () => { throw Error("download failed"); };
    await expect(downloadSavedProject(data.project.id, new AbortController().signal,
      async () => response(), failing)).rejects.toThrow();
    expect(failing.events).toEqual(["create", "revoke"]);
  });
});
