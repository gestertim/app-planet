import { describe, expect, it } from "vitest";
import {
  projectRenameBodySchema,
  projectRenameCurrentSchema,
  projectRenameResponseSchema,
} from "@app-planet/core";

const id = "71000000-0000-4000-8000-000000000001";

describe("本人專案標題 PATCH 契約", () => {
  it("只接受 strict title 本文並保留原始字串，不 trim 或正規化 Unicode", () => {
    const title = "  cafe\u0301　";
    expect(projectRenameBodySchema.parse({ title })).toEqual({ title });
    for (const body of [null, [], {}, { title: 1 }, { title: null }, { title, id }, { title, tier: "A" }]) {
      expect(projectRenameBodySchema.safeParse(body).success).toBe(false);
    }
  });

  it("current 僅有 UUID、原文 title 與非負 int32 row_version", () => {
    expect(projectRenameCurrentSchema.parse({ id, title: "標題", row_version: 0 }))
      .toEqual({ id, title: "標題", row_version: 0 });
    for (const current of [
      { id, title: "標題", row_version: -2147483649 },
      { id, title: "標題", row_version: 2147483648 },
      { id, title: "標題", row_version: 1.5 },
      { id, title: "標題", row_version: 1, stage: "點子" },
    ]) {
      expect(projectRenameCurrentSchema.safeParse(current).success).toBe(false);
    }
  });

  it("成功 envelope 只輸出指定 operation/current 欄位", () => {
    const current = { id, title: "新標題", row_version: 8 };
    expect(projectRenameResponseSchema.parse({
      outcome: "replayed", operation: current, current,
    })).toEqual({ outcome: "replayed", operation: current, current });
    expect(projectRenameResponseSchema.safeParse({
      outcome: "saved", operation: current, current, extra: true,
    }).success).toBe(false);
  });
});
