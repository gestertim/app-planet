import { projectExportFilename, projectExportMaxBytes, projectExportSchema } from "@app-planet/core";
import { readBoundedJson } from "./bounded-json.ts";

export interface ExportDownloadTarget {
  createObjectURL(blob: Blob): string;
  revokeObjectURL(url: string): void;
  download(url: string, filename: string): void;
}
const browserTarget: ExportDownloadTarget = {
  createObjectURL: (blob) => URL.createObjectURL(blob),
  revokeObjectURL: (url) => URL.revokeObjectURL(url),
  download: (url, filename) => {
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    document.body.append(anchor);
    try { anchor.click(); } finally { anchor.remove(); }
  },
};

export async function downloadSavedProject(
  projectId: string, signal: AbortSignal,
  fetchImpl: typeof fetch = fetch, target: ExportDownloadTarget = browserTarget,
): Promise<void> {
  const response = await fetchImpl(`/api/v1/projects/${encodeURIComponent(projectId)}/export`, {
    method: "GET", cache: "no-store", credentials: "same-origin", redirect: "error",
    headers: { accept: "application/json" }, signal,
  });
  if (!response.ok || response.status !== 200 ||
      response.headers.get("content-type")?.toLowerCase() !== "application/json; charset=utf-8" ||
      response.headers.get("content-disposition") !== `attachment; filename="${projectExportFilename}"`) {
    await response.body?.cancel();
    throw new Error("下載未取得可信成功回應");
  }
  const parsed = projectExportSchema.safeParse(await readBoundedJson(response, projectExportMaxBytes));
  if (!parsed.success || parsed.data.project.id !== projectId) throw new Error("下載格式不符");
  signal.throwIfAborted();
  const blob = new Blob([JSON.stringify(parsed.data)], { type: "application/json; charset=utf-8" });
  if (blob.size > projectExportMaxBytes) throw new Error("下載超過界線");
  const url = target.createObjectURL(blob);
  try {
    signal.throwIfAborted();
    target.download(url, projectExportFilename);
  } finally {
    target.revokeObjectURL(url);
  }
}
