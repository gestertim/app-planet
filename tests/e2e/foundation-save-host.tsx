import { createRoot } from "react-dom/client";
import { z } from "zod";
import { readStageDraftInputSchema, stageDraftDtoSchema } from "@app-planet/core";
import { StageDraftEditor } from "../../apps/web/src/components/project/stage-draft-editor.tsx";
import "../../apps/web/src/app/globals.css";

const fixtureSchema = z.strictObject({
  draft: stageDraftDtoSchema.nullable(),
  target: readStageDraftInputSchema,
  hasTrustedPrincipal: z.literal(true),
});
const root = createRoot(document.getElementById("root")!);

async function mountEditor(): Promise<void> {
  const fixtureUrl = new URL("/__test__/fixture", window.location.href);
  fixtureUrl.search = window.location.search;
  const response = await fetch(fixtureUrl, { cache: "no-store" });
  if (!response.ok) throw new Error(`測試伺服器無法提供合成草稿（HTTP ${response.status}）。`);
  const fixture = fixtureSchema.parse(await response.json());
  root.render(
    <div className="page-shell">
      <header className="topbar">
        <a className="brand" href="/">App <span>Planet</span></a>
        <span className="preview-tag">隔離 Edge 整合測試宿主</span>
      </header>
      <main className="main">
        <p className="eyebrow">Chat. Create. Launch.</p>
        <h1>階段草稿保存</h1>
        <StageDraftEditor
          target={fixture.target}
          initialDraft={fixture.draft}
          hasTrustedPrincipal={fixture.hasTrustedPrincipal}
          readCurrentDraft={async () => {
            const currentResponse = await fetch(fixtureUrl, { cache: "no-store", signal: AbortSignal.timeout(15_000) });
            if (currentResponse.status === 401 || currentResponse.status === 403) {
              return { outcome: "denied", reason: "policy_denied" };
            }
            if (currentResponse.status === 404) return { outcome: "not_found" };
            if (!currentResponse.ok) throw new Error(`HTTP ${currentResponse.status}`);
            const current = fixtureSchema.parse(await currentResponse.json());
            if (!current.draft) throw new Error("目前沒有草稿");
            return { outcome: "found", draft: current.draft };
          }}
        />
      </main>
    </div>,
  );
}

void mountEditor().catch((error: unknown) => {
  root.render(
    <main role="alert">
      {error instanceof Error ? error.message : "測試編輯器初始化失敗。"}
    </main>,
  );
});
