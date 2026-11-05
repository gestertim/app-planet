import { projectExportFilename, projectExportMaxBytes } from "@app-planet/core";
import { createRouteHandler, jsonResponse, problemResponse, type RouteOptions } from "./http.ts";
import { readSavedProjectExport } from "./project-export.ts";

export function createProjectExportHandler(options: Pick<RouteOptions, "resolver" | "log">) {
  return createRouteHandler({ ...options, route: "saved_project_export", methods: ["GET"] },
    async ({ session, routeParams, ...context }) => {
      const result = await readSavedProjectExport(session.write, routeParams.id);
      switch (result.outcome) {
        case "not_found": return problemResponse("not_found", context);
        case "denied": return problemResponse("forbidden", context);
        case "too_large": return problemResponse("saved_export_too_large", context);
        case "failed": return problemResponse(result.reason === "invalid_input"
          ? "invalid_request" : "dependency_unavailable", context);
        case "found": {
          const bytes = Buffer.byteLength(JSON.stringify(result.data), "utf8");
          if (bytes > projectExportMaxBytes) return problemResponse("saved_export_too_large", context);
          return jsonResponse(200, result.data, context, {
            "content-disposition": `attachment; filename="${projectExportFilename}"`,
            "content-length": String(bytes),
            "referrer-policy": "no-referrer",
          });
        }
      }
    });
}
