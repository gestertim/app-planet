import { z } from "zod";

export const projectFileMaxBytes = 262_144;
export const projectFileExtensions = [".html", ".css", ".js"] as const;

function isCanonicalProjectPath(path: string): boolean {
  if (!path || path.length > 512 || path.startsWith("/") || path.includes("\\") || path.includes("%") ||
      path.includes("//") || !/^[A-Za-z0-9._/-]+$/.test(path)) return false;
  const segments = path.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === ".." ||
      segment.endsWith(".") || /[ .]$/.test(segment) ||
      /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(segment))) return false;
  return projectFileExtensions.some((extension) => path.endsWith(extension));
}

export const projectFilePathSchema = z.string().max(512)
  .refine(isCanonicalProjectPath, "檔案路徑不符合 canonical 規則");

function isWellFormedText(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code === 0) return false;
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index++;
    } else if (code >= 0xdc00 && code <= 0xdfff) return false;
  }
  return true;
}

export const projectFileContentSchema = z.string()
  .refine(isWellFormedText, "檔案內容不是有效 UTF-8 原文")
  .refine((value) => new TextEncoder().encode(value).byteLength <= projectFileMaxBytes,
    "原始碼單檔上限為 262,144 UTF-8 bytes");

export const projectFileWriteBodySchema = z.strictObject({ content: projectFileContentSchema });

export const projectFileDtoSchema = z.strictObject({
  path: projectFilePathSchema,
  hash: z.string().regex(/^[0-9a-f]{64}$/),
  bytes: z.number().int().min(0).max(projectFileMaxBytes),
  updated_at: z.string().regex(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/),
});

export const projectFileContentDtoSchema = projectFileDtoSchema.extend({
  content: z.string().refine(isWellFormedText),
});

export const projectFileListSchema = z.strictObject({
  items: z.array(projectFileDtoSchema),
});

export type ProjectFileDto = z.infer<typeof projectFileDtoSchema>;
export type ProjectFileContentDto = z.infer<typeof projectFileContentDtoSchema>;
