import { z } from "zod";
import { projectFilePathSchema } from "./project-files.ts";

export const projectSnapshotMessageSchema = z.string().max(1024)
  .refine((value) => !value.includes("\u0000") &&
    !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value) &&
    new TextEncoder().encode(value).byteLength <= 4096);

export const createManualSnapshotBodySchema = z.strictObject({
  kind: z.literal("manual"),
  message: projectSnapshotMessageSchema.optional(),
});

export const snapshotCursorSchema = z.strictObject({
  version_no: z.number().int().positive(),
  id: z.uuid(),
});

export const snapshotManifestEntrySchema = z.strictObject({
  path: projectFilePathSchema,
  hash: z.string().regex(/^[0-9a-f]{64}$/),
  bytes: z.number().int().min(0).max(262_144),
});

export const snapshotChangeSummarySchema = z.strictObject({
  added: z.array(projectFilePathSchema),
  changed: z.array(projectFilePathSchema),
  removed: z.array(projectFilePathSchema),
});

export const projectSnapshotDtoSchema = z.strictObject({
  id: z.uuid(),
  version_no: z.number().int().positive(),
  created_at: z.string().regex(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/),
  kind: z.literal("manual"),
  immutable: z.boolean(),
  content_hash: z.string().regex(/^[0-9a-f]{64}$/),
  message: projectSnapshotMessageSchema.nullable(),
  changes: snapshotChangeSummarySchema,
});

export const projectSnapshotListSchema = z.strictObject({
  items: z.array(projectSnapshotDtoSchema),
  next_cursor: z.string().nullable(),
});

export const projectSnapshotManifestSchema = z.strictObject({
  snapshot: projectSnapshotDtoSchema.omit({ changes: true }),
  files: z.array(snapshotManifestEntrySchema),
});

export const projectSnapshotFileSchema = snapshotManifestEntrySchema.extend({
  content: z.string(),
});

export type CreateManualSnapshotBody = z.infer<typeof createManualSnapshotBodySchema>;
export type SnapshotCursor = z.infer<typeof snapshotCursorSchema>;
export type SnapshotManifestEntry = z.infer<typeof snapshotManifestEntrySchema>;
export type ProjectSnapshotDto = z.infer<typeof projectSnapshotDtoSchema>;

export function canonicalSnapshotManifest(entries: readonly SnapshotManifestEntry[]): string {
  return [...entries]
    .sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0)
    .map((entry) => `${entry.path}\u0000${entry.hash}\u0000${entry.bytes}\n`)
    .join("");
}
