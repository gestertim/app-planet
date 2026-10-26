# App Planet 跨文件、程式、測試與工程設定整體審閱報告

**性質**：唯讀審閱與報告；**不是** Checkpoint／Implementation Readiness Gate 的正式簽核，也不是 Analyze 重跑。本輪未修改產品程式、測試、正式契約、政策、授權指引、任務勾選，未 commit／push／部署，未操作上層 AnywhereTalk repository。
**審閱日期**：2026-10-22（+08:00，審閱起點約 23:41）。
**Git 根目錄**：`git rev-parse --show-toplevel` → `C:/Users/geste/spec-kit/app-planet`。
**啟用功能**：讀取 `.specify/feature.json` → `feature_directory = specs/001-app-planet-platform`（符合預期；未由分支名稱推斷。目前分支為 `main`）。
**Repository 狀態**：`main` **尚無任何 commit**（`git log` 回報 no commits yet），所有檔案皆為未追蹤。因此 `git diff` 無法呈現實作範圍；本輪以 `git ls-files --others --exclude-standard`＋檔案系統＋SHA-256 盤點，未將未追蹤檔視為不存在。
**未讀取**：`.env*`、密鑰／憑證（根目錄僅確認沒有 `.env*` 檔名）；`node_modules`、`.next` 等建置產物未被用來取代原始碼審閱。

---

> **追加複核（2026-10-23）**：本報告 §0～§10 為 2026-10-22 審閱當時的原始發現與證據，**依原樣保留，不覆寫**。其後教育者批准的修復與方案整理及對 F-01 過強推論的更正，見文末 **§11 追加複核註記**與 [readiness-review.md](./readiness-review.md) §26；2026-10-23 第二輪（待決方案補齊與 F-08 正文複核）見 **§12**與 readiness-review.md §27；2026-10-23 第三輪（教育者批准 D-06／UTC／SSE 後的同步與限定本機實作）見 **§13**與 readiness-review.md §28。下列摘要表與 §3 的「建議」不代表現行狀態。

## 0. 重要發現摘要（先看這裡）

沒有發現會使現行「關閉狀態」失效的缺陷；沒有發現已實作的未授權網路／服務／持久化路徑（限於本次檢查範圍）。以下為值得處理的項目，嚴重度採本報告自訂尺度：**中**＝與已記載的未決／不預設規則相牴觸，後續被消費時可能造成錯誤預設；**低**＝潛伏缺口、測試描述或文件過時；**資訊**＝僅供記錄。

| ID | 嚴重度 | 類別 | 摘要 | 位置 |
| --- | --- | --- | --- | --- |
| F-01 | **中** | 確定偏差（潛伏，尚無呼叫端） | 純函式 `decideCapability` 對教師／管理員的 `login` 一律依帳號狀態放行，**不看學校狀態**；等於把「未決 D-06」暫定為選項 (c)「不受學校狀態影響」，與資料模型「Plan 不預設值、fail-closed 預設」不符，且無測試或註記標示其暫定性。另：非學生角色的其他能力一律 `role_not_authorized`，契約無此矩陣。 | [account-gate.ts](../../packages/core/policy/account-gate.ts) L31–39、L58–60 |
| F-02 | 低 | 確認 R-02（實作缺口，潛伏） | Job 時間先後以 `Date.parse`（毫秒）比較，而 `z.iso.datetime()` 接受任意小數位；亞毫秒倒序被放行。契約要求「updated 不得早於 started」，未規定精度。 | [common.ts](../../packages/core/contracts/common.ts) L229–230、L317–319 |
| F-03 | 低 | 描述錯誤（測試）＋輕微契約缺漏 | R-03：測試案例名稱稱「拒絕非 canonical」，卻接受 `"01"`。D-26／COMMON／CHAT 只要求「正整數十進位」，**未要求 canonical**；實作符合契約文字，是測試名稱錯誤。前導零是否算「格式錯誤」契約未明示。 | [common.test.ts](../../tests/contract/common.test.ts) L612–618 |
| F-04 | 低 | 無法判定／契約缺漏 | 測試與 schema 把 `+00:00` 當非法（`z.iso.datetime()` 預設只收 `Z`），測試標題稱「非 UTC 時間」；契約僅寫「ISO 8601 UTC」，**找不到要求必須 `Z` 的條文**。`+00:00` 本身即 UTC。 | [common.test.ts](../../tests/contract/common.test.ts) L584–598；[common.ts](../../packages/core/contracts/common.ts) L229–230 |
| F-05 | 低 | 無法判定 | SSE `error` producer 白名單（`knownChatMessageErrorCodeSchema`）取自 H-4 的 **HTTP** 回應碼；CHAT 明載 `ai_off_duty` 等於「預留額度與呼叫模型之前」以 HTTP 403 回應，而 SSE 作用域的錯誤碼表契約並未另列。正向測試以 `ai_off_duty` 為 SSE error 範例。 | [common.ts](../../packages/core/contracts/common.ts) L162–168；[common.test.ts](../../tests/contract/common.test.ts) L630、L692 |
| F-06 | 低 | 設計取捨（已註記）＋命名風險 | `jobSnapshotCoreShapeSchema` 為 `.strict()` 且不含 `result`／`failure`；契約規定這兩鍵為**必填**，故契約合規的 wire 快照（含 `result: null, failure: null`）會被它拒絕（已實測）。程式註解與 readiness 有標示「部分形狀」，但它由公開入口匯出且名稱不含 partial 以外的警示；loose reader 與 strict producer schema 的命名分工不一致（producer 有 `Producer` 後綴，reader 無）。 | [common.ts](../../packages/core/contracts/common.ts) L211–324 |
| F-07 | 低 | 工程設定 | 測試檔不在任何 TypeScript 檢查範圍：core `tsconfig.json` 只含 `contracts/policy/index.ts`；web 只含 `apps/web`。`npm run typecheck` 通過**不代表**測試檔已型別檢查（已用 `--listFilesOnly` 證實）。臨時以相同嚴格選項對測試檔 ad-hoc 檢查為 0 錯誤，故目前只是缺常設檢查，不是現存錯誤。 | [core tsconfig](../../packages/core/tsconfig.json)；[web tsconfig](../../apps/web/tsconfig.json)；[vitest.config.ts](../../vitest.config.ts) |
| F-08 | 低 | 文件狀態（確認／修正 R-01） | `plan.md` L3、L16、L418 與 `tasks.md` L5 仍會被讀成現行狀態；其中 `tasks.md` 「所有程式路徑…尚未建立」**已與事實不符**（至少 5 個任務目的路徑已存在）。另：§17／§24／§25 的有界階段授權只記載於 `readiness-review.md`，`decision-register.md` 未登錄。 | 見 §4.1 |
| F-09 | 資訊 | 工程環境 | Next.js CLI 遙測目前為 **Enabled**（`next telemetry status`）。`next build`／`next dev` 可能對外送匿名遙測；這是工具層行為，不是產品程式碼；本輪未能驗證是否實際送出。 | 環境設定（非專案檔） |
| F-10 | 資訊 | 雜項 | `rowVersionSchema` 接受 `2**60`、`1e300`（SSE 序號則要求 `.safe()`）；契約只說「整數」。`z.uuid()` 對變體位元為 RFC 嚴格檢查（契約只寫 UUID）。空目錄 `packages/core/src/` 為先前 exports 修復的殘留；`apps/web/package.json` 無 `version`；`npm ls` 回報 2 個 extraneous（`@emnapi/runtime`、`@img/sharp-wasm32`，均在 lockfile 內，疑為 sharp 的平台選用依賴）。 | 見 §6.3 |
| F-11 | 資訊 | 環境說明 | 本次執行環境預載的專案指引摘要仍是 §25 修訂前版本（含「目前授權範圍僅限規劃文件整合」）；磁碟上 [copilot-instructions.md](../../.github/copilot-instructions.md)（2026-10-22 23:15 修改）已更新。本輪僅審閱／報告，兩版皆相容；以磁碟檔為準，不自行設定優先序。 | — |

**外部審閱線索結論**：R-01 **部分確認、部分修正**；R-02 **確認（潛伏缺口）**；R-03 **確認為測試描述錯誤，非實作偏差；並修正外部線索中「canonical」的隱含前提**（見 §4）。

---

## 1. 檔案版本與雜湊清單（審閱起點狀態）

SHA-256 在執行 `npm test`／`typecheck`／`build` 與臨時重現**之前**取得；命令結束後重新比對，**非 spike 檔案（含 lockfile）共 77 筆雜湊零差異**（無新增、無修改、無刪除）。命令只更新被 `.gitignore` 忽略的產物（`apps/web/.next/`、`*.tsbuildinfo`）。

> 下列「大小」為 bytes；「修改時間」為本機時區。`.github/skills/**`、`.specify/templates|scripts|workflows|integrations/**`（共 25 檔，Spec Kit 工具檔）已列入雜湊基準但本輪不審閱內容，未逐筆列出。`specs/001-app-planet-platform/spikes/**`（74 檔，歷史實測與原始結果）僅確認存在，未納入審閱範圍。

| 檔案 | 大小 | 修改時間 | SHA-256 |
| --- | ---: | --- | --- |
| `.github/copilot-instructions.md` | 2815 | 10-22T23:15:02 | `09a5c0062554ad2e99531239778b777dfbb23db9070fc8d4ce8bc0a2828a4101` |
| `.specify/memory/constitution.md` | 5553 | 10-20T09:26:05 | `0f77cda5ca610e62a18c55c3d9d2c2542440956355b6db742afe52218b0dfd74` |
| `.gitignore` | 84 | 10-22T10:32:24 | `62ed98473c06c163b0aa988198133b88b0b8a55996d260de258e84cfe6ef9beb` |
| `package.json` | 547 | 10-22T10:41:35 | `2a5a44eaa0ca8302e95bc9b60738d65027fe94f21e588fb2f8aac4cc7b8811c1` |
| `package-lock.json` | 109490 | 10-22T10:34:28 | `e227ae336bc7149e6f2a122f6f98d05f21eaa77f95c4fd0dbe11da41a3cb6dc4` |
| `vitest.config.ts` | 166 | 10-22T10:40:31 | `ac666b8eeb974e9e89e0e37ac6c0d93f10cfcc03b0aad519cdc34a76746837d3` |
| `packages/core/package.json` | 248 | 10-22T17:47:27 | `ccaf1a10f5c1e6b06110ea0bae63b3847bf4b9e64342334ed8f2b48b748e81d5` |
| `packages/core/tsconfig.json` | 320 | 10-22T17:48:45 | `8f016153d95843dc953f1290c18fb1111e8ea361ce115dda726a37594e0e54ba` |
| `packages/core/index.ts` | 83 | 10-22T17:48:45 | `4be7e995a98e44e13e61a6dd41e65deec0185bab93e1abb80a53d5ca48914ceb` |
| `packages/core/contracts/common.ts` | 10446 | 10-22T22:55:09 | `fe71b647a136a08d71f2b0076b9c8ab319682eda8b34fba81a7e266ea189bbd9` |
| `packages/core/policy/account-gate.ts` | 2546 | 10-22T17:48:45 | `ab4ed8ac7441e2a6ce5a86c53523a742662a578094a7cfd694f9114825ea7615` |
| `tests/contract/common.test.ts` | 26830 | 10-22T22:54:38 | `23d94151f5d476e7aa204d812b5346bdc0fb691e98268ba27cece9d0005c053e` |
| `apps/web/package.json` | 532 | 10-22T10:32:24 | `9d7381b0e2551f70f27e313bbfbb654017662e3ae3c1d06975a2d2409050fd31` |
| `apps/web/tsconfig.json` | 742 | 10-22T17:48:45 | `f8bdcd977e3658353b0985bfe1e7a7326a03f06e53688e976fa8a5d97c2e89f1` |
| `apps/web/next.config.ts` | 159 | 10-22T10:39:01 | `28d5c2f4e4fbe6f3a08d60fea4dc06c5dde8c898aec91c5e476cb9bbf2a5a3d4` |
| `apps/web/next-env.d.ts` | 295 | 10-22T11:12:30 | `1b59d4c6b83807db275d43f3cf2cc8e9323f465fab764eea091cc5becd5bad37` |
| `apps/web/postcss.config.mjs` | 101 | 10-22T10:32:24 | `7b299d3d3b16699ddda397c0b2373b3af4f25f8fc9ccc9b3d9e64ef083bc1c21` |
| `apps/web/src/app/layout.tsx` | 437 | 10-22T10:32:24 | `9b0d306f4704d84346fbfedafd9241a9aefbc4a8c97d9e58360d588055f34b78` |
| `apps/web/src/app/page.tsx` | 2210 | 10-22T10:32:24 | `0f663874eeec78a1757e6b6bf05702fb8aac54dd081fdf66abab44ac28c2ce24` |
| `apps/web/src/app/student/page.tsx` | 2025 | 10-22T17:47:09 | `0536ea48622e75c884863da61b78a241d263ccb37fa1f132e0da219807ae171b` |
| `apps/web/src/app/teacher/page.tsx` | 1754 | 10-22T10:40:30 | `a5d6cc7a5cf8da9c2740cd6074fabae6ba0dd26deb9f42de2a93e796c865ae1b` |
| `apps/web/src/app/admin/page.tsx` | 1726 | 10-22T10:40:30 | `87ccd2bced23e56ad295d2192bbb4b2abb23ec597fa5193ed4e3414a8c922512` |
| `apps/web/src/app/globals.css` | 3986 | 10-22T10:32:24 | `d9b567c2733326f8266778cead1c8b18ebb8750557cbc8b6b6c48c4378807bd3` |
| `apps/web/src/components/app-shell.tsx` | 1425 | 10-22T10:40:30 | `8e6f7680b05c509e00cd83e1a1708c4b36889978e747e43e21481175fb11e641` |
| `apps/web/src/components/operation-state.tsx` | 547 | 10-22T10:40:30 | `72093ec7df79e438033f1c488ee2c29a9b33403898d63d0a4b798838600421ca` |
| `specs/…/spec.md` | 220554 | 10-21T21:34:53 | `fb0489b18d2c893dfa034913099aeeb0a3d5b8f8b1d7fbc10101b450fa9791fc` |
| `specs/…/plan.md` | 131159 | 10-22T19:01:18 | `3af20564329c115847e0ba8276be5c12d5fc7c5a23478c963ad4377e4908a43c` |
| `specs/…/tasks.md` | 64111 | 10-22T22:54:05 | `3d35596be7522e190131dfcd5955eacc177f3120ead77329d03a24e7799edc42` |
| `specs/…/analysis-report.md` | 21262 | 10-22T08:53:19 | `cb10d5388de0b02a3f5c75154a4bdf0b3d080d1b149834d9eeeb76b119af1601` |
| `specs/…/readiness-review.md` | 237562 | 10-22T23:19:44 | `145f55ebe1b771a92589603a1ab61793d818a0936fc7df849fadc67a580db393` |
| `specs/…/decision-register.md` | 149940 | 10-22T19:13:35 | `ae7615b16d90f0bdcd56262d522bdcdb51b0d373c5dc4293b05d3bcfd1c8428f` |
| `specs/…/quickstart.md` | 77343 | 10-22T10:49:37 | `498a23601235e02fa2826dea23d9663a74c03575c94526f11642da506449da7b` |
| `specs/…/data-model.md` | 75721 | 10-22T19:13:11 | `46ecf39eecd4d3edce97dccbf8c30bb347910267c6fd6f8add7eaabc35cc21ef` |
| `specs/…/ux-ui-design.md` | 88783 | 10-21T23:04:06 | `35365165309acdb11e213f5409c978cbff02cc0a49bb1713d5eac2f79e51df13` |
| `specs/…/research.md` | 101270 | 10-21T21:34:53 | `bdcdffa7eb1932d37f838d31ed953b90cb3ccbf24e5d1953b67d86b266e0c8c5` |
| `specs/…/product-decisions.md` | 141942 | 10-21T21:25:13 | `6f2f96f8b2d7baba454764fb5e16ce51ae5a7934eb14a1a9b76dc652b8a5dae0` |
| `specs/…/security-architecture-decision-brief.md` | 22743 | 10-21T17:25:39 | `387a5ac64e6218d7f58bb82e7948e8e8b63ee5fd2550c2510252771d3ec1e587` |
| `specs/…/contracts/README.md`（COMMON） | 15838 | 10-22T19:12:50 | `8cbe2e3074242508bab34b8fcd8d04e55fb62e00d30a6c8be1f0fdf3b4018df9` |
| `specs/…/contracts/ai-chat-and-safety.md`（CHAT） | 18059 | 10-22T18:59:09 | `faa2f636199c0514bfa55d86cabd89e0ce489dcc8e961a702be22414746be34b` |
| `specs/…/contracts/auth-and-identity.md`（AUTH） | 9404 | 10-21T12:18:02 | `eff2fc87c529282eec56222f46f0f7486fec11f5d1f32fd38d166f630aa4beaf` |
| `specs/…/contracts/access-and-lifecycle.md`（LIFE） | 12773 | 10-21T12:17:56 | `a6cbcca0df04d6cc03c8a07fcc37f52fa5f209537d62ff2072df14e1796c5f84` |
| `specs/…/contracts/projects-agent-sandbox.md`（PROJ） | 13514 | 10-21T21:29:00 | `17af29f340d03778ca2bc6e5ae4805d9784b51051b6a76aeacbed7ba56305218` |
| `specs/…/contracts/publishing-and-public-runtime.md`（PUB） | 61963 | 10-21T23:09:59 | `efc1035c0612ebc5b0859555874933dcce8a949c2ba45390d4f9bce92769d5ce` |
| `specs/…/contracts/usage-and-budget.md`（BUD） | 8064 | 10-21T21:29:00 | `d7cc01f51e54a26fd2e5ed2d74f23adf2c30c2e2015f31a1b9c5ce1bcc305e4e` |
| `specs/…/checklists/requirements.md` | 38283 | 10-22T08:40:19 | `201b036d98358252bd73f968d01bbd7c98ce9ec0703746f8172b09d275b058a9` |
| `specs/…/checklists/mvp-plan.md` | 7427 | 10-21T22:32:34 | `49e71d2056b9e1efa746a60b71b7b11bd5bc64fe7f4bc6e757962f197f9de845` |
| `specs/…/checklists/plan-finalization.md` | 10856 | 10-21T23:04:46 | `5505b5cd1f91fa7ddcf05e27e3b9551269f4f9c5653c1f504ae71c89b958d96a` |
| `docs/App-Planet-Final-Copy-Paste-Pack-zh-TW.md` | 47707 | 10-21T15:49:45 | `4a5d7c450f3c8dac341a3bc6a005876b51de1832f2646758347cfe273bcf84c1` |

**版本號（`node_modules` 實際安裝，與 lockfile 一致）**：Node v24.19.0、npm 11.11.0；TypeScript 7.0.2、Vitest 4.1.12、Next 16.4.2、React／React DOM 19.3.1、Zod 4.6.7、Tailwind 4.3.3。

---

## 2. 實際審閱範圍、缺少資料與未驗證範圍

### 2.1 已審閱
- **指引／治理**：`.github/copilot-instructions.md`（全文）、`constitution.md`（相關條文與原則清單）、`spec.md`（G4–6、範圍決定、FR-042／FR-046／FR-047／FR-055、OD-13 與 Clarifications 批准紀錄的相關段落）。
- **規劃／決策**：`plan.md`（檔頭、批准紀錄、修訂紀錄）、`tasks.md`（檔頭、G0、T003～T015 相關列、勾選統計）、`analysis-report.md`（檔頭）、`readiness-review.md`（§0～1、§17、§18 標題、§24～§25 全文、§19／§22 對 D-06 的相關段落）、`decision-register.md`（D-06、D-23、D-24、D-25～D-30 全文及其前言）、`quickstart.md`（狀態、本機階段、啟動命令）、`data-model.md`（§2.1 判定表）。
- **契約**：COMMON（`contracts/README.md`）全文；CHAT §1／§3；AUTH A-1、A-10 與錯誤碼表。LIFE／PROJ／PUB／BUD 僅檢索與本輪發現有關的關鍵字，**未逐行審閱**。
- **程式**：`packages/core` 全部三個 `.ts`、`tests/contract/common.test.ts` 全文（723 行）、`apps/web` 全部 9 個 `.ts/.tsx`＋CSS（以關鍵字確認無外部資源）、所有 package／TS／Vitest／Next／PostCSS 設定與 lockfile 要點。
- **執行入口盤點**：`apps/web` 僅有 5 個靜態頁面（`/`、`/student`、`/teacher`、`/admin`、`/_not-found`）；沒有 Route Handler、`middleware`／`proxy`、server action（`use server`）、`"use client"`、表單／輸入、事件處理器、`fetch`／`XMLHttpRequest`／`WebSocket`／`EventSource`、`process.env`、cookie／storage、`next/font`、外部 `url()`／`@import`（僅 `@import "tailwindcss"`）、服務 SDK。**不存在** `apps/worker`、`apps/works-edge`、`supabase/` 目錄。

### 2.2 缺少資料／無法取得
- **沒有獨立的原始批准附件**：文件自身多處明載「無獨立簽核檔」「依交接指令轉錄」（`readiness-review.md` L11、L473；`decision-register.md` D-24；`spec.md` L907）。
- **交接轉錄僅部分可得**：本次可查的 session 紀錄只含部分使用者訊息片段（例如「已獲教育者批准的『本機基礎功能階段』」的後續核對訊息）；**查不到** D-25～D-30 各項「選 A」的原始選擇訊息，也查不到 §24／§25 授權的原始訊息。因此 D-25～D-30 的批准來源在本輪**無法獨立核實**（不推定未批准，也不補造）。

### 2.3 未驗證／未執行
- 沒有啟動 dev／preview 伺服器、沒有開瀏覽器；UI 僅靜態審閱＋建置產物路由清單（不審 `.next` 內容）。
- 沒有核對 LIFE／PROJ／PUB／BUD 的全部條文；沒有重跑 Analyze／Specify／Plan／Tasks。
- 沒有驗證 HTTP 標頭處理、DB、RLS、佇列、SSE 傳輸、權限端點等**尚未存在**的執行時行為。
- 沒有驗證 Next.js 遙測是否實際外送（F-09）。
- 沒有執行 `npm install`／`ci`／audit／任何供應商操作。

---

## 3. 發現詳情

### F-01（中）教師／管理員登入的未決 D-06 被純函式預設為「放行」
- **位置**：[account-gate.ts](../../packages/core/policy/account-gate.ts) L31–39（`login` 分支）、L58–60（非學生一律 `role_not_authorized`）、L78–90（`canAccessRoleHome`）。
- **依據**：
  - 資料模型 §2.1 註記（[data-model.md](./data-model.md) L124）：「教師在學校 `unconfirmed` 狀態下的登入與使用範圍〔待決 D-06〕…Plan 草案**不預設值**；fail-closed 預設僅限開發測試環境，且列入 Readiness 阻擋項」。
  - [decision-register.md](./decision-register.md) L193 D-06：三個候選 (a)／(b)／(c) 均「非決定」，須核定時點 T1。
  - [spec.md](./spec.md) L143：「教師是否可登入或發起核發未明示」。
- **重現（實測，合成輸入，`approved`＋`deletionState: none`）**：`role = teacher|admin` 搭配 `schoolApproval ∈ {null, "unconfirmed", "approved", "withdrawn"}` → `decideCapability(…, "login")` 皆 `{allowed:true}`；`canAccessRoleHome` 皆 `true`；同一 context 的 `ai_call`、`read_saved_content` 皆 `role_not_authorized`。
- **影響**：目前**沒有任何呼叫端**（web 僅用 `projectTierSchema`），故無執行時風險。但此純函式預定由伺服器與 Worker 共用（data-model §2、T008）；後來的呼叫端會把「教師在學校未確認時可登入」視為已核定行為。測試只釘住學生情境與 pending 教師，沒有任何測試標示教師／管理員 × 學校狀態是暫定行為。
- **附帶（契約缺漏，無法判定）**：資料模型 §2.1 判定表以學生為中心；教師／管理員對 `read_saved_content`、`edit_saved_content`、`ai_call` 等能力沒有定義，但 `spec.md` FR-042／FR-055(e) 明載管理員有付費 AI 測試操作與「管理員測試額度」。`role_not_authorized` 全拒屬 fail-closed、較安全，但**沒有契約依據**，且 `role_not_authorized` 不屬 AUTH／COMMON 公開碼（屬 D-29 所說本機 `AccessDecision.code` 作用域，這點是符合的）。
- **最小修復建議（不自行執行、不核定政策）**：
  1. 交教育者決定 D-06（選項 a／b／c），在核定前讓教師／管理員 × 學校 `unconfirmed` 走 fail-closed（或回傳明確的「政策未決」決定碼），**或**至少在程式註解與 readiness 紀錄標示「暫定」；
  2. 補教師／管理員 × 帳號狀態 × 學校狀態的案例表測試（沿用現有案例表風格），並以測試名稱標示「暫定／待 D-06」；
  3. 向教育者提出「非學生角色的能力矩陣」缺漏（至少管理員 `ai_call` 測試），避免日後由程式預設答案定案。

### F-02（低）Job 時間先後的精度缺口（R-02，已重現）
- **位置**：[common.ts](../../packages/core/contracts/common.ts) L229–230（`z.iso.datetime()`）、L317–319（`Date.parse` 比較）。
- **契約要求**：[COMMON](./contracts/README.md) L38「時間：ISO 8601 UTC」；Job 段 L45「`updated_at` … 有 started 時不得早於它；時間均為 ISO 8601 UTC」；[D-25](./decision-register.md) 第 3 點相同。**契約未規定小數秒精度，也未規定毫秒。**
- **重現**（以公開入口 `@app-planet/core` 的 `jobSnapshotCoreShapeSchema`；合成 Job：`kind=preview_build`、`state=building`、`progress={mode:"indeterminate"}`、`started_at` 需非 null）：

  | 案例 | started_at／updated_at | `Date.parse` 兩值 | 原生 `updated < started` | 公開 schema |
  | --- | --- | --- | --- | --- |
  | **R-02 主案例** | `…10:00:00.0009Z`／`…10:00:00.0001Z` | 皆 `1792663200000` | **false** | **success: true（被接受）** |
  | 6 位小數 | `.000900Z`／`.000100Z` | 皆 `…200000` | false | success: true |
  | 9 位小數 | `.999999999Z`／`.999000000Z` | 皆 `…200999` | false | success: true |
  | 毫秒倒序（對照） | `.001Z`／`.000Z` | `…200001`／`…200000` | true | success: false，訊息「更新時間不可早於開始時間」 |
  | 毫秒相等（對照） | `.000Z`／`.000Z` | 相同 | false | success: true |
  | 無小數秒 | `10:00:00Z`／`10:00:00Z` | 相同 | false | success: true |

  結論：**前置 schema（`z.iso.datetime()`）接受 4／6／9 位小數**，Date.parse 把它們截為相同毫秒，所以亞毫秒倒序被放行。這是**實作的比較精度小於其所接受的輸入精度**，使已寫入的「不得早於」規則在亞毫秒範圍不成立。
- **影響**：潛伏。資料庫 `timestamptz` 為微秒精度，未來 producer 若序列化微秒，可能出現 `updated < started` 卻被判合法的快照；目前沒有 producer。
- **最小修復選項（不核定精度政策）**：
  - **A（不改政策）**：因兩值都已被限制為 `Z` 結尾 ISO 格式，比較時改為「秒以前字串＋小數位補零至相同寬度的字串比較」（或用 BigInt／Temporal 等不丟精度的方式），並加入 §F-02 表中案例作回歸；
  - **B（需教育者／契約決定）**：在 COMMON 明定精度（如毫秒），並以 `z.iso.datetime({ precision: … })` 限縮輸入；
  - **C**：維持現狀，於契約與程式註解明確記載「先後比較僅保證毫秒」，並登記為已知限制。
  A 不需新政策、對現有合法輸入無破壞，是最小選項；B／C 涉及契約語意，須由教育者決定。

### F-03（低）SSE 游標測試名稱與內容不符（R-03）
- **位置**：[common.test.ts](../../tests/contract/common.test.ts) L612–618；[common.ts](../../packages/core/contracts/common.ts) L182–185。
- **事實**：案例名稱「接受正整數十進位游標並拒絕**非 canonical**、零或非文字值」，卻在接受清單放 `"01"`（以及 `"999999999999999999999999"`）；拒絕清單只有 `"0"`、`"-1"`、`"+1"`、`"1.0"`、`" 1"`、`1`。實測：`"1"`、`"01"`、`"001"`、`"20"` 通過；`"0"`、`"00"`、`"+1"`、`"1.0"`、`" 1"` 拒絕；400 位數字也通過。
- **契約文法**：
  - [D-26](./decision-register.md)（L535 起）：「`id: <正整數十進位文字>`」、id 在單一 message 事件串自 1 遞增、唯一。
  - [COMMON](./contracts/README.md) L34／L60 起：「`id:` 是…**正整數十進位游標**，自 1 起」。
  - [CHAT §3](./contracts/ai-chat-and-safety.md) L42：「`id:` 寫…自 1 遞增的**正整數十進位游標**」。
  - 三處**都沒有要求 canonical（無前導零）**。「canonical」只出現在 row `If-Match`（D-28：「無空白 canonical 十進位版本」），其作用域是 If-Match 標頭，**不得外推到 SSE 游標**。
- **判定**：實作（`/^\d+$/` 且含非零位數）與契約文字一致；**是測試描述錯誤**。**輕微契約缺漏**：`Last-Event-ID: 01` 屬「格式錯誤」（`400 invalid_event_cursor`）還是「合法格式但未曾發出」未明示；`sseNativeEventFieldsSchema`／`sseEventCursorSchema` 同時被用於 producer 輸出與 reader 輸入的語意，也未區分。
- **最小修復**：僅改測試名稱為「…拒絕零、符號、小數、空白與非文字值」，或在教育者確認「前導零不合法」後才另補 schema＋測試（需先補契約文字）。不需改程式。

### F-04（低）`+00:00` 被拒絕的依據（R-03 額外核對）
- **事實**：[common.test.ts](../../tests/contract/common.test.ts) L584 標題「拒絕**非 UTC 時間**…」，L595 的反例是 `2026-10-22T10:01:00+00:00`。實測 `+00:00`、`+08:00`、小寫 `z`、缺秒的 `…10:01Z` 皆被 schema 拒絕，錯誤訊息皆為「Invalid ISO datetime」（Zod 預設 `offset: false`，且程式沒有任何註解說明）。
- **依據核查**：COMMON L38 與 D-25 只寫「ISO 8601 UTC」；在 `decision-register.md`、`readiness-review.md` §24／§25 與契約中**找不到**「必須以 `Z` 結尾」或「拒絕 `+00:00`」的明文。`+00:00` 在 ISO 8601／RFC 3339 即為 UTC，故標題「非 UTC」對 `+00:00` 不正確。`+08:00` 若轉換可為合法 UTC 時刻，但「是否要求 wire 格式必須已是 UTC 表示（Z）」契約未說明。
- **判定**：**無法判定／契約缺漏**；現行 Z-only 是驗證函式預設值，不是已核定的產品規則。不可把此測試當作契約要求的證據。
- **最小修復**：契約補一句「wire 時間必須以 `Z` 表示」或「允許 `+00:00`」（由教育者／契約維護者決定）；之後調整 schema 或測試名稱。未補契約前，建議把該反例的測試名稱改為「目前 schema 只接受 `Z` 表示（暫定）」。

### F-05（低）SSE `error` producer 碼表的作用域（無法判定）
- **事實**：`knownChatMessageErrorCodeSchema` ＝ `ai_not_open｜ai_off_duty｜school_not_confirmed｜quota_daily_exhausted｜pool_creator_exhausted`，與 [CHAT H-4](./contracts/ai-chat-and-safety.md) L14 的 **HTTP 回應碼**列表一致；L14 同時註明 `ai_off_duty`「於預留額度與呼叫模型之前回應」。CHAT §3 L38 僅寫 SSE `error`「使用 CHAT／SSE 作用域受控固定碼」，**沒有另列 SSE 專屬碼表**。實測 `account_disabled`（COMMON 範例碼）在 SSE error 被拒；`ai_off_duty` 被接受。
- **風險**：串流開始後才發生的生成失敗（例如 W-1 網頁搜尋失敗、模型中斷）沒有可用的 SSE error 碼；而 H-4 回應前已回 HTTP 403 的碼被當作串流中事件。[D-29b](./decision-register.md) 也強調 HTTP／SSE／Job／內部碼是不同作用域。
- **判定**：契約缺漏（SSE 作用域碼表待補）；不是已確認的實作偏差。Readiness §24.2 已揭露它是「契約已明載的 CHAT 訊息錯誤碼子集」，揭露得當。
- **建議**：待端點契約補齊 SSE 碼表後再調整；此前保留，並在測試／註解註明「暫以 H-4 HTTP 碼為子集」。

### F-06（低）Job 核心形狀與契約必填鍵、命名分工
- **事實**：契約（COMMON L33、L47）規定快照所有鍵必填，含 `result`、`failure`（可為 null）。實測：契約形狀的 `queued` 快照 + `result:null, failure:null` → **被拒絕**；省略兩鍵 → 被接受。測試 L601 把 `{ ...valid, result: null }` 當反例並歸入「未定義的核心欄位」。
- **是否為缺陷**：程式註解（common.ts L295）、`readiness-review.md` §24.2 已明示「刻意不含 result／failure；不能冒充完整 Job DTO」，且 per-kind result 為已知未決，故**不判為偏差**。風險在於：它由公開入口匯出，名稱為 `jobSnapshotCoreShapeSchema`；第一個把它當 202／GET reader 的消費者會拒絕所有合規快照。
- **命名**：D-30 要求「現有 loose／strict schema 與未來 output schema 須命名分工」；現況 producer schema 有 `…ProducerPayloadSchema`，reader 的 loose schema（`sseBlockPayloadSchema`、`sseSupportPayloadSchema`、`sseErrorPayloadSchema`、`problemJsonSchema`）沒有 reader 標記，且 D-30 明載「目前 loose schema 不能安全當輸出防線」。
- **建議**：在 per-kind result 決策前，保持現況；考慮於註解／匯出別名標明 reader／producer／partial 的用途（屬命名，不改行為，需教育者准許才動程式）。

### F-07（低）測試檔未納入常設型別檢查
- **證據**：`tsc --listFilesOnly`：core 程式只有 `contracts/common.ts`、`policy/account-gate.ts`、`index.ts`；web 程式只有 `apps/web/**` 與 `.next/**` 生成型別及 core 的三個檔；**`tests/**` 兩者皆無**。Vitest 以 esbuild 轉譯，不做型別檢查；因此 `npm test` 與 `npm run typecheck` 皆不檢查測試檔型別。
- **補充**：臨時執行 `tsc --noEmit --strict --target es2022 --module nodenext --moduleResolution nodenext --allowImportingTsExtensions --skipLibCheck --types node tests/contract/common.test.ts` → 0 錯誤（單次 ad-hoc，未改任何設定、未留檔）。
- **建議**：新增 `tests/tsconfig.json`（或將 `tests` 納入現有 typecheck）作為常設檢查；屬工程設定變更，需另獲授權。

### F-08（低）文件狀態（見 §4.1 詳述）

### F-09（資訊）Next.js CLI 遙測
- `npx next telemetry status` → Enabled；環境變數 `NEXT_TELEMETRY_DISABLED` 未設。專案無任何關閉設定。這不是產品程式的網路呼叫，但 `quickstart.md` 與 readiness 的「未呼叫任何供應商服務」敘述未涵蓋工具層遙測。若教育者要求「零外送」，可在本機與 CI 設定 `NEXT_TELEMETRY_DISABLED=1` 或執行 `next telemetry disable`（屬環境設定，本輪未動）。

### F-10（資訊）雜項
- `rowVersionSchema`（common.ts L330）：`2**60`、`1e300` 皆通過；D-28 只說整數、D-26 只對序號要求「可無損表示」，故無偏差；若未來 row_version 以 JSON 數字傳輸，應補上限（需契約決定）。
- `idempotencyKeySchema = z.uuid()`：Zod 4 檢查版本與變體位元，因此「8-4-4-4-12 十六進位但變體位元非法」被拒（測試 L409 已涵蓋）；契約只寫「UUID」，這是合理但未被契約明載的嚴格度。
- `packages/core/src/`：空目錄（先前 exports 指向不存在的 `./src/index.ts` 的遺跡；目前 exports 已指向 `./index.ts`）。`apps/web/package.json` 無 `version` 欄位。`npm ls` 顯示 2 個 extraneous 選用依賴，皆在 lockfile 內；本輪不處理。
- 整個專案尚無 commit：lockfile、`.gitignore`、程式、文件都未納版控，沒有可回復的基準點（與「不 commit」的授權一致，只是事實記錄）。

---

## 4. 外部審閱線索 R-01～R-03 複核

### 4.1 R-01 現行狀態與歷史敘述 → **部分確認、部分修正**

| 位置（現文） | 判定 | 說明與精確修正建議（不修改原文、不改 checkbox） |
| --- | --- | --- |
| `plan.md` L3 狀態：「…Checkpoint／Readiness Gate 未通過，**未授權實作或上線**」 | **確認：仍會被當成現行狀態，且過寬** | 這是檔頭「狀態」欄，不是歷史快照。`readiness-review.md` §17／§24／§25 已記載有界本機例外（web 骨架、純函式、schema／測試）。建議改為：「…Checkpoint／Readiness Gate 未通過；**一般產品實作、服務接通、資源建立與上線未授權**；僅 `readiness-review.md` §17、§24、§25 明列的有界本機子集（本機骨架、schema／純函式、合成測試）獲例外授權，不代表 Gate 通過」。 |
| `plan.md` L16「…尚無階段實作批准」 | **歷史快照但未標示**；對「Readiness 準備授權」當時為真，之後被 §17 的「本機基礎功能階段授權」部分更新 | 建議句尾加：「（截至本紀錄；其後有界本機例外見 `readiness-review.md` §17／§24／§25，不構成階段實作或 Gate 通過）」。此段落位於「後續 Readiness 準備紀錄」下，有時間脈絡，但沒有後續指標。 |
| `plan.md` L418 修訂紀錄列：「…未執行本機 schema／測試實作」 | **明確的歷史列（§23 當時），但缺少被取代指標** | 列首已有日期與「D-25～D-30 決議文件同步」語境；建議附註「§24 其後獲例外授權並已完成本機子集」。 |
| `plan.md` L18「本輪範圍：僅產出 Plan 草案…未安裝依賴…」 | **明確歷史**（L14 已統一聲明 2026-10-21 紀錄保留為歷史快照） | 不需修改。 |
| `tasks.md` L5「**136 項全部未執行**」 | **字面可成立（0／136 已勾選）但語意過時** | 實際：§17 載明 T003、T004、T006、T008、T014、T015 的本機子集已執行（皆「部分執行，未結案」）。建議：「136 項**全部未勾選、無任何任務完整結案**；T003／T004／T006／T008／T014／T015 另有有界本機子集已執行，見 readiness-review §17／§24」。 |
| `tasks.md` L5「所有程式路徑均為…**規劃目的路徑，尚未建立**」 | **確認：已不符事實** | 現存：`packages/core/contracts/common.ts`、`tests/contract/common.test.ts`（T006）、`packages/core/policy/account-gate.ts`（T008）、`apps/web/src/components/app-shell.tsx`、`operation-state.tsx`（T014）；另有 `package.json`、`vitest.config.ts` 等（T003／T004）。其餘路徑（`apps/worker`、`apps/works-edge`、`supabase/`…）仍未建立。建議：「**多數**程式路徑尚未建立；已存在者限於 readiness-review §17／§24 所列本機子集」。 |
| `tasks.md` L8、G0 條 | **已有部分緩解** | L8 明說「136 項保持未勾選」並只談 Readiness 準備授權；G0 條提及 §24 的例外，但**未提 §17／§25**。建議在 G0 條補 §17、§25 指標。 |
| `readiness-review.md` L6／L11／§0 | **L11「未授權產品實作」屬 §0 當輪語境；L6 檔頭研究入口未列 §17～§25** | L6 已說明「§0～13 是先前輪次紀錄」；建議在 L6 的研究入口句尾補「最新本機階段紀錄見 §17、§24、§25」。§0「沒有任何 P1～P6 實作批准」目前仍為真（本機子集不是 P1～P6 階段）。 |
| 其他：`quickstart.md` L4 | **已正確** | 同時寫明本機階段與「正式驗證尚未執行」。 |

**額外發現**：§17／§24／§25 的有界授權**只**登錄於 `readiness-review.md` 與被其引用的 `copilot-instructions.md`；`decision-register.md` 沒有對應紀錄（其「Readiness 準備授權」段仍寫「未批准實作」）。依「不自行創造文件優先序」，本報告不判定誰優先，只指出：若決策登錄簿是教育者決策的單一索引，則本機階段授權缺少登錄（見 §5 追溯表的證據層級）。

### 4.2 R-02 → **確認（潛伏缺口）**
見 F-02。三層區分：
1. **原生時間比較**：`Date.parse` 把 `.0009Z` 與 `.0001Z` 都映射為 `1792663200000`，`updated < started` 為 false。
2. **實際 schema**：前置 `z.iso.datetime()` **接受**4／6／9 位小數，整體 `safeParse` 為成功（上表第一列）。
3. **契約要求**：要求 updated 不早於 started、時間為 ISO 8601 UTC；**未要求毫秒、也未限制小數位**。

### 4.3 R-03 → **確認為描述錯誤；修正線索的隱含前提**
見 F-03／F-04。D-26／COMMON／CHAT 對 SSE 游標只要求「正整數十進位」，沒有 canonical；不應把 row If-Match 的 canonical 規則套到 SSE 游標。`+00:00` 的 Z-only 行為沒有契約依據，是驗證函式預設值。

---

## 5. 追溯表：教育者批准 → 決策紀錄 → 契約／資料模型 → 程式 → 測試

**證據層級圖例**：
- **〔原始批准〕**：獨立簽核檔或原始訊息可供查驗——**本輪全部未找到**。
- **〔交接轉錄〕**：使用者訊息中轉述批准、並可在 session 紀錄查到——僅找到「本機基礎功能階段」等少數訊息的後續核對片段，**未查到 D-25～D-30、§24、§25 的原始選擇／授權訊息**。
- **〔Agent 自述〕**：由 Agent 撰寫、聲稱依教育者對話記錄的文件（決策登錄簿、readiness、spec Clarifications 等）。
- **無法獨立核實**＝只有〔Agent 自述〕，沒有前兩層。這**不等於未批准**，只表示本輪無法獨立證實。

| # | 需求／決策 | 批准證據（層級） | 決策紀錄／契約 | 程式 | 測試 | 判定 |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 平台 C 級；學生作品首版僅 A／B；作品執行時無 AI | spec Clarifications 2026-10-21 範圍決定（〔Agent 自述〕，文件載明「無獨立批准檔」）；無法獨立核實 | spec FR-049；COMMON 同步註記；D-23 | [projectTierSchema](../../packages/core/contracts/common.ts)（L18） | [L99–105](../../tests/contract/common.test.ts)（A／B 接受、C 拒絕） | 已確認程式與記載一致；批准無法獨立核實 |
| 2 | β2／M／W 移出 MVP；A1／B2／X | D-23／D-24：「教育者本次對話明確批准…不宣稱有獨立簽核檔」（〔Agent 自述〕） | D-23、D-24；COMMON「最新 MVP 適用性」段 | 無（正確未實作；無 B 級執行路徑） | 無 | 正確未實作；批准無法獨立核實 |
| 3 | 學校狀態 gate：`unconfirmed` 學生不得登入；撤回／失效仍可讀寫／提交；AI 與公開部署暫停 | spec L907：「本機無獨立批准紀錄檔，依交接指令轉錄」（〔Agent 自述／交接轉錄〕，原訊息未在 session 查到） | data-model §2.1（L110–126）；spec FR-046／047；AUTH A-1 | [account-gate.ts](../../packages/core/policy/account-gate.ts) L13–76 | [L107–240](../../tests/contract/common.test.ts)（含 expired 案例表） | **學生部分**程式與契約一致；批准無法獨立核實 |
| 4 | D-06 教師／管理員 × 學校未確認 | **未決**（無批准） | data-model L124；D-06 | account-gate L31–39、L58 **以預設定案** | 無案例 | **偏差（F-01）** |
| 5 | D-25 Job 共同欄位＋依 kind 狀態（部分形狀） | D-25：「教育者決議（2026-10-22）選定 A」（〔Agent 自述〕）；原始選擇訊息未查到，**無法獨立核實** | COMMON L43–58；data-model §4.2；D-25 | [jobSnapshotCoreShapeSchema](../../packages/core/contracts/common.ts) L206–324 | [L535–603](../../tests/contract/common.test.ts) | kind／state／progress／started 規則一致；F-02、F-06；per-kind result 正確保留未決 |
| 6 | D-26 SSE 原生欄位與兩種序號 | D-26 同上，無法獨立核實 | COMMON L60–74；CHAT §3 | [sseNativeEventFieldsSchema](../../packages/core/contracts/common.ts) L186、`sseEventCursorSchema` L182、各 payload schema | [L605–707](../../tests/contract/common.test.ts) | 一致；F-03（測試名稱）、F-05（error 碼作用域） |
| 7 | D-27 `done.usage` 數值或 `"unknown"` | D-27 同上，無法獨立核實 | COMMON／CHAT §3 | [doneUsageSchema](../../packages/core/contracts/common.ts) L141 | [L499–533](../../tests/contract/common.test.ts) | 一致 |
| 8 | D-28 If-Match（row canonical；file 小寫 SHA-256） | D-28 同上，無法獨立核實 | COMMON L32 | `rowIfMatchSchema` L90、`fileIfMatchSchema` L91、parse helpers | [L442–497](../../tests/contract/common.test.ts) | 一致；**不**外推到 SSE 游標（正確） |
| 9 | D-29a request id opaque；D-29b 分作用域碼表 | D-29a／b 同上，無法獨立核實 | COMMON L30 | `requestIdSchema` L68、`knownChatMessageErrorCodeSchema` L162 | [L292–299](../../tests/contract/common.test.ts)、[L435–440](../../tests/contract/common.test.ts)、[L700](../../tests/contract/common.test.ts) | request id 一致；碼表為子集、F-05 |
| 10 | D-30 輸入／producer／reader／adapter 分層 | D-30 同上，無法獨立核實 | COMMON L75 | strict producer／loose reader（L69、L110 起、L148 起） | [L664–706](../../tests/contract/common.test.ts) | 行為一致；命名分工見 F-06 |
| 11 | 未決：D-14（值守、`paused_off_duty`）、per-kind result、PP-20～27 | 皆**未批准**（decision-register 明載） | D-14；D-25 | `aiOnDuty` 只是布林輸入；`paused_off_duty` 不在 Job enum；無 result schema；無 PP 數值 | [L301–314](../../tests/contract/common.test.ts)（基礎列舉）、[L545–560](../../tests/contract/common.test.ts)（`leased`／`paused_off_duty` 對外 kind 拒絕） | **未被程式偷偷定案**（F-01 的 D-06 除外）；正確未實作 |
| 12 | 本機階段授權（§17 web 骨架；§24 schema；§25 核對） | §17：「教育者…明確批准」（〔Agent 自述〕；使用者後續訊息提及「已獲教育者批准的『本機基礎功能階段』」——〔交接轉錄，部分〕）；§24／§25：無法獨立核實 | readiness §17／§24／§25；tasks G0；指引 | web 骨架、core | 77 測試 | 範圍與其紀錄一致（程式僅限所列子集）；**未登錄於 decision-register（F-08）** |

---

## 6. 結論分類

### 6.1 已確認符合（本次檢查範圍內）
- **專案隔離**：根目錄、`feature.json`、無上層 repository 操作。
- **品牌／語言／對象**：`<html lang="zh-Hant">`、品牌 `App Planet`、`Chat. Create. Launch.`、介面全為繁體中文；UI 全標示「合成資料」「尚未開放」。
- **範圍**：`projectTierSchema` 僅 A／B；沒有 β2／M／W、作品執行時 AI、公開 AI、Work Data API、Sandbox、部署、通知、付費、上傳的任何程式路徑；沒有 Worker／works-edge／supabase 目錄。
- **關閉狀態**（靜態＋建置）：所有操作按鈕皆 `<button disabled>`，無 `onClick`、無表單；`/student`、`/teacher`、`/admin` 僅內部 `Link`；build 路由清單僅 5 個靜態頁（無 API／動態路由）；全專案原始碼無 `fetch`／`WebSocket`／`EventSource`／`process.env`／storage／cookie／SDK／server action／`use client`。限定表述：**本次檢查範圍未發現**非預期網路呼叫、服務 SDK 初始化或持久化路徑；不宣稱已證明完整安全。
- **D-25～D-30 與程式一致性**：D-27、D-28、D-29a、D-30 的 schema 範圍與契約條文一致（Readiness §25 的四項結論，本輪獨立重讀條文後同意）；`jobBaseStateSchema` 與完整 Job 分離；`paused_off_duty`／`leased` 被拒絕。
- **input／producer／reader／adapter 分離**：strict producer vs loose reader 行為與 D-30 一致（命名分工見 F-06）。
- **純函式的邊界**：`decideCapability`／`canAccessRoleHome` 只接受帳號狀態／刪除狀態／學校狀態／值守布林；沒有資源擁有者、師生綁定、session 撤銷輸入，也未宣稱處理它們（`AccessDecision` 僅帳號層碼）。
- **套件名稱匯入**：`vitest.config.ts` 無 alias／paths；core `tsconfig` 無 paths；web 只有 `@/*`；測試以 `@app-planet/core` 匯入，並以 `createRequire().resolve` 驗證解析到 `packages/core/index.ts`（L43–52）。`node_modules/@app-planet/core` 為指向 `packages/core` 的 Junction；Node 直接載入亦可解析（臨時重現時證實）。
- **工程設定一致性**：workspaces、`exports: { ".": "./index.ts" }`、web 依賴 `@app-planet/core: "*"`、lockfile（`packages/core`、`apps/web`、zod 4.6.7 等）一致；`npm ls` 無缺失／無效依賴。直接消費 TypeScript 原始碼的策略在 Vitest、`tsc`（NodeNext／bundler）與 `next build` 三處都實測可行（`next.config.ts` 未設 `transpilePackages`，但 Next 16.4.2 建置通過）。
- **啟動命令**：`quickstart.md` 的 `npm run dev`／`npm test`／`npm run typecheck`／`npm run build` 與根 `package.json` 一致（`dev` 本輪僅靜態核對，未啟動）。
- **指引一致**：磁碟版指引與 constitution 的授權語句一致，且明載歷史例外不是常設許可。

### 6.2 確定偏差
- **F-01**（D-06 預設定案；潛伏）。
- **F-02**（亞毫秒時間比較；潛伏）。
- **F-03**（測試名稱錯誤）、**F-08**（`tasks.md`「程式路徑尚未建立」與現況不符；`plan.md` L3 過寬；本機階段授權未登錄於 decision-register）。

### 6.3 無法判定
- **F-04**（`Z` 才合法？契約未明）、**F-05**（SSE error 碼作用域）、F-01 附帶的「非學生角色能力矩陣」、F-10 的 `rowVersion` 上限與 UUID 嚴格度。
- **D-25～D-30、§24／§25 的批准來源**：只有〔Agent 自述〕，**無法獨立核實**；不推定未批准。
- Next.js 遙測是否實際外送（F-09）。

### 6.4 正確未實作（不列為缺陷）
- 完整 MVP：真實登入、帳號核發、學校核准操作、AI／Agent、上傳、Sandbox、作品執行／部署、Work Data API、通知、付費、持久化、Worker、works-edge、supabase、Radix／Monaco／Playwright／pgTAP。
- D-14、per-kind result DTO、完整錯誤碼表、PP-20～27、完整 Job schema、If-Match 標頭 parser／409 conflict schema、SSE wire 編解碼。
- 任務 T001～T136 皆未勾選（0／136，已用腳本計數）；T003／T004／T006／T008／T014／T015 為「部分執行，未結案」，與 §17／§24 記載一致。
- 測試品質評估（供參）：77 項合成測試對 gate 的學生矩陣、expired 邊界、帳號／刪除狀態、問題 JSON 欄位型別、If-Match 邊界、usage、Job kind／progress／started、SSE payload 與額外欄位都有代表性覆蓋；缺口：教師／管理員 × 學校狀態、`download_own_results`、`rejected` 教師 `login`、Job 的 failed／cancelled／stopped 狀態與時間組合、亞毫秒與偏移時間、前導零游標。這些測試**只證明合成 schema／純函式行為**，不是任何未實作服務的驗收證據。

---

## 7. 命令、結果與證據限制

| 命令／動作 | 結果 |
| --- | --- |
| `git rev-parse --show-toplevel` | `C:/Users/geste/spec-kit/app-planet` |
| 讀取 `.specify/feature.json` | `feature_directory = specs/001-app-planet-platform` |
| `git status --porcelain=v1 -uall`、`git log` | 全部未追蹤；尚無 commit（77 筆非 spike＋74 筆 spike 路徑） |
| `npm test` | exit 0；Vitest 4.1.12；1 檔、**77／77 通過**（359 ms） |
| `npm run typecheck` | exit 0；core 與 web `tsc --noEmit` 皆通過 |
| `npm run build` | exit 0；Next.js 16.4.2（Turbopack）；編譯、TypeScript、靜態產生完成；路由：`/`、`/_not-found`、`/admin`、`/student`、`/teacher`（皆 ○ Static） |
| `tsc --noEmit --listFilesOnly`（core、web） | 證實測試檔不在任何型別檢查程式內（F-07） |
| ad-hoc `tsc` 對測試檔 | exit 0（單次、無設定變更） |
| `npm ls --depth=0 --workspaces --include-workspace-root` | exit 0；樹正確；2 個 extraneous 選用套件 |
| `npx next telemetry status` | Enabled（F-09） |
| 臨時重現 A（R-02／R-03）、B（F-01／F-05／F-06／F-10 探測） | 以 `node` 直接匯入 `@app-planet/core` 執行；結果見 F-01～F-06、F-10；**臨時檔已自專案移除**（確認 `Test-Path` 為 False；副本留在 `%TEMP%` 供使用者自行查驗，非專案檔） |
| 檔案雜湊前後比對 | 77 筆零差異；僅 `.gitignore` 內的 `.next`／`*.tsbuildinfo` 被重新產生 |
| session 紀錄查詢（唯讀） | 找到 20 筆較早的 app-planet session 摘要；查不到 D-25～D-30、§24、§25 的原始選擇／授權訊息 |

**臨時重現內容（精簡）**：對 `jobSnapshotCoreShapeSchema.safeParse({ id:"123e4567-e89b-42d3-a456-426614174000", kind:"preview_build", state:"building", progress:{mode:"indeterminate"}, started_at, updated_at })` 代入 F-02 表的各組時間；另對 `sseEventCursorSchema` 代入 `"1","01","001","0","00","20","+1","1.0"," 1"`；對 `decideCapability` 代入 `teacher|admin × schoolApproval ∈ {null,unconfirmed,approved,withdrawn} × {login, ai_call, read_saved_content}`。

**證據限制**：①測試通過只證明合成 schema 與純函式；②沒有可核實的原始批准附件；③未啟動伺服器／瀏覽器；④LIFE／PROJ／PUB／BUD 與 UX 文件僅局部檢索；⑤session 紀錄不完整；⑥「未發現」僅限本次檢查的檔案與關鍵字範圍。

---

## 8. 最小修復建議與優先順序（本輪**不執行**）

| 優先 | 項目 | 最小做法 | 需要的授權 |
| --- | --- | --- | --- |
| 1 | F-01 D-06 預設問題 | 先向教育者提出 D-06 與「非學生角色能力矩陣」；核定前教師／管理員 × 學校未確認 fail-closed 或標示暫定；補案例測試 | 程式／測試修改需另獲有界授權；D-06 由教育者核定 |
| 2 | F-08 文件狀態 | 依 §4.1 的精確文字修訂 `plan.md` L3／L16／L418、`tasks.md` L5 與 G0 條；在 `decision-register.md` 補登 §17／§24／§25 授權索引（不改批准內容） | 文件修訂授權；**不改 checkbox** |
| 3 | F-02 時間比較精度 | 選項 A（不丟精度的字串／BigInt 比較）＋回歸案例；或由教育者決定精度政策（B／C） | 程式／測試／（B 時）契約修改授權 |
| 4 | F-03、F-04 測試描述 | 改兩個測試名稱；`Z` 規則若要成為產品規則，先補契約文字 | 測試／契約修改授權 |
| 5 | F-07 測試型別檢查 | 將 `tests/**` 納入常設 `tsc`（新增 tests tsconfig 並接入 `typecheck`） | 工程設定授權 |
| 6 | F-05／F-06 | 待 SSE 碼表與 per-kind result 契約補齊後再調整；其間在註解標示暫定／partial | 隨後續契約決策 |
| 7 | F-09／F-10 | 視需要關閉 Next 遙測（環境）；其餘雜項可忽略 | 環境／工程設定 |

不建議的做法：不要在補契約前改 schema 以「看起來更嚴格」；不要因 row If-Match 的 canonical 而收緊 SSE 游標；不要把 77 項測試通過當成任何服務的驗收證據。

---

## 9. 原任務、關閉功能與 Gate 的真實狀態

- **任務**：`tasks.md` T001～T136 **0／136 已勾選**（腳本計數：未勾選 136、已勾選 0）。本輪未更動。T003／T004／T006／T008／T014／T015 只有 readiness §17／§24 所列的本機子集（部分執行，未結案）；T011／T012／T010／T007／T009 等其餘任務未執行。
- **關閉功能**（依程式與建置的靜態檢查，限於本次檢查範圍）：真實登入、帳號核發、學校核准、AI／Coding Agent、上傳、Sandbox、作品執行／公開部署、Work Data API 寫入、通知、付費、真實資料保存——**全部仍關閉**；沒有對應的執行入口。
- **Gate**：Checkpoint **未通過**；完整 MVP Readiness Gate **準備性評估未通過，教育者正式審議／簽核未執行**。本輪**不是**正式審議，也沒有批准 D-14、PP-20～27、D-06 或任何下一階段。
- **授權**：一般產品實作、服務接通、資源建立與上線仍受 G0／Gate／階段批准限制；§17／§24／§25 的有界本機例外不構成常設許可，也不得延伸。
- **正式產品驗收／上線條件**（四類正式測試、S-01～S-15、V-01～V-57、TL 證據）**均未執行**。

---

## 10. 交回 ChatGPT 複核：最小必要檔案（專案相對路徑）

1. `specs/001-app-planet-platform/review-report.md`（本報告）
2. `packages/core/contracts/common.ts`
3. `packages/core/policy/account-gate.ts`
4. `packages/core/index.ts`
5. `tests/contract/common.test.ts`
6. `specs/001-app-planet-platform/contracts/README.md`（COMMON）
7. `specs/001-app-planet-platform/contracts/ai-chat-and-safety.md`（CHAT）
8. `specs/001-app-planet-platform/contracts/auth-and-identity.md`（AUTH）
9. `specs/001-app-planet-platform/decision-register.md`（D-06、D-23～D-30）
10. `specs/001-app-planet-platform/data-model.md`（§2.1）
11. `specs/001-app-planet-platform/readiness-review.md`（§17、§24、§25）
12. `specs/001-app-planet-platform/plan.md`、`specs/001-app-planet-platform/tasks.md`（R-01／F-08）
13. `.github/copilot-instructions.md`
14. `package.json`、`vitest.config.ts`、`packages/core/package.json`、`packages/core/tsconfig.json`、`apps/web/package.json`、`apps/web/tsconfig.json`、`apps/web/next.config.ts`
15. 與關閉狀態有關的 UI 入口：`apps/web/src/components/operation-state.tsx`、`apps/web/src/components/app-shell.tsx`、`apps/web/src/app/student/page.tsx`

> 不含：`.env*`、密鑰、`node_modules`、`.next`／`*.tsbuildinfo`、`spikes/**`、真實學生資料、無關研究。上傳時請保留相對路徑。

---

## 11. 2026-10-23 追加複核註記（不覆寫 §0～§10 的歷史證據）

**性質**：記錄教育者 2026-10-23 批准的「審閱後最小修復與待決方案整理」對各發現的處置與複核更正。**批准證據註記**：VS Code 無法取得原始訊息，依教育者本次交接確認；不虛稱已讀原始附件、不補造連結、不倒填時間。執行紀錄、命令與結果見 [readiness-review.md](./readiness-review.md) §26；待批准方案見 [decision-register.md](./decision-register.md)「2026-10-23 審閱後待批准整理」。

| ID | 原狀態 | 2026-10-23 處置與複核註記 |
| --- | --- | --- |
| F-01 | 中；確定偏差（潛伏） | **未改程式、未核定 D-06；複核更正原敘述過強之處**：①「登入放行」不等於「所有功能不受限制」——純函式對 `approved` 教師／管理員只在 `login` 與 `canAccessRoleHome` 不看學校狀態，其餘能力一律 `role_not_authorized`，且沒有綁定輸入，**從不放行教師查看學生資料**；②**管理員**在學校未確認時辦理建校、核准、帳號準備是已明確允許（spec、D-06 已知欄），管理員登入放行不是偏差；真正的實質偏差只剩「**教師 × 學校 `unconfirmed` × `login`** 被隱含預設」；③非學生角色的能力矩陣缺漏（含管理員 `ai_call`）屬契約缺漏，非程式錯誤。已整理六件事的分開判定、最小處理選項（O1～O4）與推薦；**待教育者核定**。原 §3 F-01 的「最小修復建議」第 1 點「教師／管理員 × 學校 unconfirmed 走 fail-closed」不再適用於管理員。 |
| F-02 | 低；確認 R-02 | **已修復**：[common.ts](../../packages/core/contracts/common.ts) 以保留精度的 `compareUtcInstants`（整秒 `Date.parse`＋補零小數字串比較）取代 `Date.parse` 毫秒比較；採原 §3 的選項 A，未動接受範圍。修復前先寫 30 個新測試，**5 個失敗（亞毫秒逆序）、102 個通過**；修復後 107／107 通過。原 §3 F-02 表中案例皆已涵蓋。 |
| F-03 | 低；測試描述錯誤 | **已修正測試名稱**（不改 schema、`"01"` 仍接受、不設長度上限）。是否要求無前導零仍是契約缺漏，未處理。 |
| F-04 | 低；無法判定 | **只修正測試文字**（`+00:00` 案例標明「暫定只收 Z；+00:00 本身仍是 UTC」）；接受範圍未改。已整理「UTC 時刻／wire 必須 Z／允許 +00:00」三問題與選項 A～C，推薦 A；**待教育者決定**，暫行行為不是已批准政策。 |
| F-05 | 低；無法判定 | **未改程式、未新增碼**。已盤點 HTTP／SSE／Job／內部作用域，特別區分開串流前 HTTP 拒絕與串流後 `error` 事件；指出現行五碼是 HTTP 子集、SSE 專屬碼表為零；提出 SSE 登錄槽位與選項 A～D，推薦 A；**待教育者決定**。另發現 AUTH A-1（`account_unavailable`）與 AUTH §3／COMMON 例（`account_disabled`）對同類情境用碼不一致，列入全盤點待辦，未裁決。 |
| F-06 | 低 | 未處理；保留未決（命名分工）。 |
| F-07 | 低；工程設定 | **已修復**：新增 `tests/tsconfig.json` 與 `typecheck:tests`，接入根 `npm run typecheck`（core → web → tests）；以套件名稱匯入，無 paths／alias；負向探測證明測試檔型別錯誤會被擋；未新增或升級依賴、lockfile 雜湊不變；未發現既有測試型別問題。 |
| F-08 | 低；文件狀態 | **已同步**：plan.md（檔頭、後續 Readiness 準備紀錄、原始碼標題、修訂列）、tasks.md（檔頭狀態、G0）、quickstart.md（驗證命令與階段指標）、decision-register.md（本機階段授權索引、修訂列）、`.github/copilot-instructions.md`（歷史階段與本輪限定授權）、readiness-review.md（現行狀態索引、§26）。歷史快照保留並標示指向 §26.6；任務勾選、編號與批准內容未改。 |
| F-09 | 資訊 | 未處理（環境設定，本輪不修改遙測環境）。 |
| F-10／F-11 | 資訊 | 未處理；F-11 所指環境預載指引為舊版，以磁碟檔為準的結論不變。 |

**仍然成立的原結論**：§9 的任務（0／136 已勾選）、關閉功能與 Gate 狀態未因本輪改變；測試通過只證明合成 schema 與純函式；D-25～D-30 與各階段的原始批准訊息在 VS Code 仍無法獨立取得，依教育者交接確認，不推定未批准。

---

## 12. 2026-10-23 第二輪複核紀錄（待決方案補齊與 F-08 正文複核；不覆寫 §0～§11）

**性質**：僅文件。授權範圍與時序見 [readiness-review.md](./readiness-review.md) §27.1（先於其他修改記錄）；批准證據為本 session 的教育者指示，無簽核附件，不補造、不倒填。

| ID | 本輪處置 | 結果 |
| --- | --- | --- |
| F-01 | 補齊 D-06 (a) 逐項能力表（[decision-register.md](./decision-register.md) 4.1）：教師登入、受限首頁、查看自己申請狀態、發起核發、首次領碼、重發、查看學生資料、AI／審查／部署，加上既有否決的保留。 | **待批准／未採用**；未改 `account-gate.ts`。特別標明：`null`、`unconfirmed`、查詢失敗、教師未歸屬學校是四件不同的事；A-9 只引用綁定部分，D-06 的查看預設拒絕不會自動套用到重發；教師學校歸屬不假設單校（M0／M1／M2）。 |
| F-04 | 整理 UTC 選項 A 的可批准條文與適用範圍（4.3）。 | **待批准／未採用**；COMMON 正文、測試的「暫定」文字均未改。 |
| F-05 | 補齊 SSE 專屬錯誤登錄草案 S1、S2、S3、S5（4.2）；S4 保留為 D-14 相依。 | **待批准／未採用**；未改 schema、producer 或測試。 |
| F-08 | 複核 plan、tasks、quickstart、`.github/copilot-instructions.md` 正文（readiness §27.4）。 | 發現並最小修正 4 項確定偏差（見 §27.4）；歷史保留；任務與 Gate 狀態未動。 |

**前輪四項修復核對**：靜態核對 `compareUtcInstants`、游標與 `+00:00` 測試名稱、`typecheck` 串接與 `tests/tsconfig.json`、lockfile 雜湊與 §26.2 一致（readiness §27.3）；**未重跑測試／typecheck／build，不沿用 107／107 作為本輪結果**。

**本輪驗證與來源保留**：修改前後比對產品程式、測試、設定與 lockfile 的 SHA-256，差異為 0；實際修改僅 7 個文件（readiness §27.5）；任務仍 0／136 已勾選；Gate 未通過。

**仍然成立的原結論**：§9 的任務、關閉功能與 Gate 狀態未因本輪改變；D-06、UTC、SSE 新碼、D-14、PP 均未核定。

## 13. 2026-10-23 第三輪處理結果（教育者批准 D-06／UTC／SSE 後的同步與限定本機實作；不覆寫 §0～§12）

**性質**：文件同步＋限定本機純函式／schema／合成測試。授權範圍與時序見 [readiness-review.md](./readiness-review.md) §28.1（先於其他修改記錄）；批准證據為本 session 的教育者指示，無簽核附件，不補造、不倒填。原始發現（F-01、F-04、F-05 等）依原樣保留。

| ID | 本輪處理結果 | 狀態 |
| --- | --- | --- |
| F-01 | 教育者批准 D-06 (a)（教師歸屬 M1、重發 R-a）。`account-gate.ts` **未改**（既有學生／管理員／教師 `decideCapability` 行為不變，並以回歸案例固定）；新增 `policy/teacher-account-prep.ts`，把教師登入（不依賴學校查詢）、受限首頁、查看自己申請、發起核發、首次領碼、重發的帳號層政策以純函式表達，並讓「未歸屬／`unconfirmed`／查詢失敗／`null`」分開。「登入放行不等於所有功能不受限制」的更正維持成立：教師對學習資料、AI、審查、部署的能力仍一律 `role_not_authorized`。 | 已批准；文件已同步；純函式與合成測試已實作（結果見 readiness §28.4）；**資料層、端點、RLS、歸屬資料表未建立、未驗證** |
| F-04 | 教育者批准 UTC 選項 A。COMMON 時間列與 Job 快照段已補大寫 `Z` 規則；`utcInstantSchema` 命名同一規則；新增合成案例驗證接受大寫 `Z`、拒絕小寫 `z`／偏移／naive、不誤驗自由文字；`compareUtcInstants` 僅加上匯出（供期限比較），**未重構**；測試名稱的「暫定」已改為依 COMMON。小數秒位數／輸出寬度／資料庫精度仍未決。 | 已批准；已同步；已實作；端點／資料庫序列化未驗證 |
| F-05 | 教育者批准 SSE 專屬錯誤登錄（四碼）、S1-A、成因區分、`error`→`failed`、保存並重放歷史終止事件。`knownChatMessageErrorCodeSchema` 保留為 HTTP 作用域；`sseErrorProducerPayloadSchema` 改用 SSE 專屬登錄並驗證 `code`／`retryable` 配對；原測試以 `ai_off_duty` 作 SSE `error` 範例的缺陷已改正，並新增「HTTP 專屬碼在 SSE 被拒」案例。S4 仍依賴 D-14，未登錄。 | 已批准；已同步；schema 與純事件序列規則已實作；HTTP handler、producer、保存／重放服務、文案專業審閱**未完成** |
| F-02、F-03、F-06～F-10 | 本輪未處理，維持 §11／§12 的結論。 | 不變 |

**對原任務的影響**：T001～T136 仍 0 項已勾選；T006、T008、T015 增加子集，T011、T012、T045 僅相依標示。完整 Checkpoint／Readiness Gate 未通過，所有真實功能維持關閉。驗證結果、檔案清單與封裝見 readiness-review.md §28.4～§28.7。

## 14. 2026-10-23 SSE 訊息狀態誤判修復（追加，不覆寫原審閱歷史）

**授權與時序**：教育者於本 session 明確批准的有界本機純函式／合成測試／必要文件修正，先於其他專案修改記於 [readiness-review.md](./readiness-review.md) §29.1。新增測試後實際重現失敗，先記 §29.2，再修程式。未新增產品政策決策、未倒填批准或補造簽核附件。

| 項目 | 發現／處理 | 實際結果 |
| --- | --- | --- |
| 根因 | [sse-event-history.ts](../../packages/core/policy/sse-event-history.ts) 的歷史掃描合法接受 block／support；`deriveMessageState` 卻不檢查這些事件，只按終止事件映射。`block／support → done` 均回 `ok:true, state:complete, incomplete:false`，無終止時則猜測 partial。原註解不足以限制適用範圍。 | 與本機現況一致，沒有為符合交接摘要而製造差異；CHAT §3 既有 `block → blocked` 及「done 不代表未被攔截」仍為契約依據 |
| 最小修復 | 完整 `scanHistory` 成功後才檢查 block／support；有效歷史若包含任一事件，回 `{ ok: false, code: "unsupported_message_state_mapping" }`，不帶推測的 state／incomplete／片段結果。 | `DerivedMessageState` 增加本機失敗分支；不擴充 `MessageState`、不改 `SseSequenceErrorCode`／HTTP／SSE 錯誤登錄。非法歷史仍回原驗證碼，沒有被未支援碼掩蓋 |
| 合成回歸 | [sse-event-history.test.ts](../../tests/contract/sse-event-history.test.ts) 淨增 12 項：4 項已／未終止的 block／support 映射重現、7 種非法歷史驗證優先序；原單一接受案例拆為 2 個參數化案例，補原 id／payload 的驗證與重放。 | 修復前 38 項中 **4 失敗／34 通過**（exit 1）；修復後目標檔 **38／38 通過**（exit 0）。普通 done／partial／error／未終止映射、error 保存片段與終止後禁止新增等既有測試保持通過 |
| 本輪完整驗證 | `npm test`、`npm run typecheck`、`npm run build`，不是引用 §13 的歷史結果。 | **5 檔 238／238 通過**；core／web／tests 型別檢查 exit 0；Next.js build exit 0，僅靜態建置，未啟動服務；此 process 關閉 Next 遙測 |
| 公開入口與呼叫端 | [index.ts](../../packages/core/index.ts) 已有 `export *`，不需修改。[common.ts](../../packages/core/contracts/common.ts) 不變。搜尋全部 `apps`／`packages`／`tests` 的來源與匯入，只有此合成測試檔呼叫 helper；web 僅匯入作品等級 schema／type。 | 成功分支形狀不變；失敗分支 `code` 聯集增加本機未支援碼，屬可觀察的行為／型別範圍變更。未發現需遷移的產品呼叫端；未來窮舉處理失敗碼的呼叫端須處理新分支，不可當作完整狀態映射器 |
| 文件釐清 | [data-model.md](./data-model.md) §3 分開一般完成／CHAT 已有 blocked 契約與 helper 尚未支援範圍；程式註解、quickstart 補適用範圍與本機碼。治理文件只補 §29 階段引用；本登錄追加本節。 | 不改 CHAT／COMMON 契約，不補定 support 或組合優先序，不改既有批准；來源雜湊與封裝檢查見 readiness §29.5 |

**限制與未結案**：僅涉及 **T006／T015 部分範圍**，136 項任務仍全部未勾選，完整契約／gate／資料層／競態／日誌回歸等原範圍未完成。不實作完整 block／support 狀態映射，不決定 D-14／S4、安全處置／通知、重試、費用、保存期限或恢復政策。Checkpoint／完整 MVP Readiness Gate **未通過**，正式審議／簽核**未執行**，所有真實功能維持關閉。未新增／升級依賴，未建立 API、資料庫、migration、RLS、供應商資源或網路服務，未啟動預覽伺服器，未 commit／push／部署。

## 15. 2026-10-23 T095 公開訪客識別分類矛盾修復（追加，不覆寫歷史）

**授權與時序**：教育者本輪明確批准的有界本機修復，先記於 [readiness-review.md](./readiness-review.md) §31.1；新增矩陣後先執行目標測試，實際 3 項失敗／21 項通過，再修改 helper。這不是產品政策核定或常設許可。

| 項目 | 發現／修復 | 實際結果 |
| --- | --- | --- |
| 根因與依據 | `evaluateWorkEligibility` 只比較 tier 與 runtimeNeeds 的分類一致性，訪客識別限制只檢查公開 B。於是 tier A、static、public、需要訪客識別的輸入無拒絕原因。Spec v5 A 定義為前端優先／local-first，登入／權限屬 B 的需求類型；FR-048 與 data-model §5.4 將既定公開阻擋限定於 B。 | 修復前此公開 A 輸入回 `withinMvpSupport: true`；A1 沒有因此被視為公開情境。 |
| 最小修復與相容性 | 公開 B 仍回 `tier_b_needs_visitor_identity`；公開 A 的訪客識別需求回本機 `inconsistent_input`，不自動變 B、不增加 HTTP 錯誤碼。A1 維持不套用公開阻擋。沒有修改輸入、簽名、結果形狀、公開入口或既有合法成功案例。 | public A 回傳由 `true` 轉 `false`；public B 行為維持；所有 A1 矩陣案例及其他合法案例維持。搜尋 `apps`／`packages`／`tests`，產品端沒有 helper 呼叫者；測試仍由 `@app-planet/core` 匯入。 |
| 合成回歸 | 依契約建立 A／B × public／a1_preview × visitor identity true／false 八例；每列註明分類、依據與函式未驗證事項。另測公開 A 訪客識別與 runtime AI 同時成立、只改 tier 標籤不能放行。 | 修復前目標檔 24 項中 **3 失敗／21 通過**；修復後 **24／24 通過**。既有合法 A／B、A1、restricted_server、runtime AI、平台 AI、非法／缺漏輸入、多原因、輸入不變及結果限制測試保留。 |
| 本輪驗證與封裝 | 重新執行 `npm test`、`npm run typecheck`、`npm run build`；來源修改前後 SHA-256 依 readiness §31.1／§31.5 核對。 | 6 檔 **262／262 通過**；core／web／tests 型別檢查成功；Next.js 16.4.2 靜態建置成功，未啟動服務。未新增／升級依賴、未建立 API／資料庫／資源、未讀密鑰或真實兒童資料；專案外複核 ZIP entry／路徑／讀回雜湊驗證見 readiness §31.5。 |

**限制與未結案**：僅 T095 修復子集及 T091／T015 本輪合成測試子集；原任務依賴、正文與勾選不變，136 項仍全未勾選。未取得可信事實來源、服務端資格整合、登入／身分服務或 A1／B2 實際執行證據；預覽／提交／重試／部署重驗仍待後續授權。Checkpoint／完整 MVP Readiness Gate 未通過，正式審議／簽核未執行，真實功能維持關閉。

## 16. 2026-10-23 T007／T008 隔離資料庫實測追加（不覆寫 §0～§15 歷史）

本輪教育者批准、修改前 SHA-256 基線與範圍見 [readiness-review.md](./readiness-review.md) §34.1；結果與限制見 §34.2。修正 22＋1 處 SQLSTATE `throws_ok` 的參數、學生 `…0002` 的真實拒絕原因描述、獨立有效學生／批准學校／無 binding 案例，並補足 account-gate 學校 fixture 缺漏的 `updated_at`。兩份 migration 在官方 Supabase PostgreSQL 17.6 映像成功套用；pgTAP 1.3.3 的 identity/audit TAP 61／61、account-gate TAP 53／53，均有有效 plan、exit 0、零失敗。資料庫角色／RLS 斷言以非 owner、非 superuser、非 BYPASSRLS 的 `authenticated` actor 執行；audit append 分支以受限 writer role 執行。psql 控制連線負責 migration／合成 fixture，故不把控制連線誤稱為非 owner。這是 PostgreSQL 層級測試，不是完整 Supabase stack／Auth API／JWT 登入流程。

實際暴露並修正的 SQL 測試 fixture 問題為學校列少一個欄位值；測試 harness 另需暫時的 writer role／pgTAP schema 權限，已在專用資料庫中限定授予並撤銷，未放寬 migration 或 app table grants。`npm test` 7 個檔案 269／269 通過；`npm run typecheck` core／web／tests 通過。未改 `account-gate.ts`、公開匯出或產品政策，故未執行 build。交易 rollback 後合成 fixture 計數為 0；本輪 container、volume、network 與 CLI 初始化／快取已清理，保留無密鑰值的 Compose 設定及本機官方映像快取。ZIP 的逐檔來源雜湊、路徑安全與讀回驗證見其 `packaging-manifest.json`；整包大小及 SHA-256 於交付摘要提供。

**範圍仍有限**：T007／T008／T015 僅本機子集，原依賴保留、`tasks.md` 原任務均未勾選／結案；Q-SCHOOL、Checkpoint／完整 MVP Readiness Gate 未通過，正式審議／簽核未執行。未驗證完整 Supabase／Auth、產品接線、正式資料或上線；withdrawn／expired 教師查看、D-04、D-14、保存期限與未核定 PP 不作裁決。
