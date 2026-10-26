# Tasks：AI APP 超級創客｜App Planet 現行 MVP

**2026-10-26 最新進度入口（§76）**：T009／T010 費用交易及 Worker 核心本機子集已有程式與真實 PostgreSQL 測試；T001／T002 全 Q 收斂與本批修正見各任務行後註記及 [readiness §76](./readiness-review.md)。下方較早長摘要是歷史產生／局部批次快照；不據其「尚未建立」否定現有 worker／測試。136 個任務仍全未完整結案，未勾選、不改原依賴；程式缺口與政策／外部阻擋分列，不統稱只差 T001。

**產生日期**：2026-10-22。**輸入**：[spec.md](./spec.md)、[plan.md](./plan.md)、[decision-register.md](./decision-register.md) D-23／D-24、[data-model.md](./data-model.md)、[contracts](./contracts/README.md)、[quickstart.md](./quickstart.md)、[ux-ui-design.md](./ux-ui-design.md)、[research.md](./research.md)。
**流程**：已執行本機 `setup-tasks.ps1 -Json`，FEATURE_DIR 與 `.specify/feature.json` 均為本目錄，使用其解析的 tasks-template；未以 Git 分支推斷。未發現 `.specify/extensions.yml`，before_tasks／after_tasks 無 hook 可執行。
**狀態**：以下 **136 項全部未勾選，無任何任務完整結案**；這不等於所有子集均未執行——T003、T004、T006、T008、T014、T015 另有有界本機子集已執行（部分執行，未結案；T004、T006、T015 於 2026-10-23 另有補強；T006、T008、T015 於 2026-10-23 另有 D-06／UTC／SSE 子集，T011、T012、T045 僅相依標示；T095 另有本輪核准的本機資格純函式子集，T091／T015 僅記本輪合成測試涉及範圍；T051／T050／T015／T006／T008／T095／T004 另有 2026-10-24 方案 B 本機子集，僅按 readiness §41 記錄實際部分成果），逐項見 [readiness-review.md](./readiness-review.md) §17、§24、§26.1、§28.1、§30.1–§30.6、§33.1–§33.4、§35.1–§35.2、§41。教育者只批准設計與任務基線及 Analyze，以及 readiness-review 明列的有界本機階段；未批准 Checkpoint、Implementation Readiness Gate 通過、一般產品實作、付費資源或上線。**多數**程式路徑尚為 Plan 結構下的規劃目的路徑、尚未建立；已存在者限於上述本機子集（`package.json`、`vitest.config.ts`、`tests/`、`packages/core/{index,contracts/common,policy/{account-gate,teacher-account-prep,sse-event-history,work-eligibility}}.ts`、`apps/web` 靜態骨架），`apps/worker`、`apps/works-edge` 仍未建立；`supabase/` 有 §33 migration／測試來源及 §35 單一本機 pgTAP runner，但這不等於完整 T004 設定或完整資料庫驗證。
**開發藍圖**：[development-roadmap.md](./development-roadmap.md) 依本檔原有 Phase／任務 ID 整理部分成果、缺項、跨區依賴、外部責任與可驗收階段；各任務正文及「依」欄仍是唯一任務與依賴權威。
**測試依據**：使用者要求四類驗證，Spec／契約要求權限、版本、費用及失敗測試，因此明列測試任務；先寫測試／確認預期失敗，再實作並在結案任務執行。寫了測試不代表已通過。

**2026-10-23 SSE 修復現況補充（不改任務正文／勾選）**：教育者本 session 另行批准 [readiness-review.md](./readiness-review.md) §29 的 G0 前有界本機子集：T006 的 SSE helper 回傳契約／適用範圍修復，及 T015 的對應合成回歸；不含端點、資料層、完整 block／support 映射或政策補定。T006／T015 仍僅部分執行，136 項全部未勾選、無任務完整結案。此引用補充下方 G0 的歷史階段索引，不代表 G0、Checkpoint 或完整 Gate 通過，也不延伸為後續開發許可。

**2026-10-23 T095 本機子集（不改任務正文／勾選）**：教育者本 session 另行批准 [readiness-review.md](./readiness-review.md) §30 的 G0 前本機作品範圍資格純函式、必要型別／公開匯出、合成測試與文件／驗證。T095 僅記主要部分實作；T091／T015 僅記本輪實際涉及的合成測試子集。T095 原依賴 T091、T051 均保留，未宣稱滿足；不含 `apps/web/src/server/publishing/eligibility.ts`、Route Handler、資料層或任何服務。本機「符合 MVP 支援範圍」不授予預覽、建置、資料存取或發布權。136 項仍全部未勾選，無任務結案；Checkpoint／完整 Gate 未通過，正式審議／簽核未執行，所有真實功能維持關閉。此例外不是常設許可。

**2026-10-23 T007／T008 本機資料子集（不改任務正文／依賴／勾選）**：教育者另行批准 [readiness-review.md](./readiness-review.md) §33 的隔離本機 migration、RLS 與合成 SQL 測試來源。T007 僅身分／學校／M1 歸屬／綁定／audit schema 與最小權限；T008 僅資料庫 account gate 與受限教師綁定判斷；T015 僅對應資料庫測試子集。Docker daemon 不可用，真實 PostgreSQL／RLS 未執行（`not_run`）；T004、T006、T007、T008、T010–T014 等依賴與 Q-SCHOOL 均未宣稱滿足。任務仍全部未勾選，真實 Auth、服務接線、完整資源授權與 Gate 維持關閉。此例外不是常設許可。

**2026-10-23 T004／T007／T008／T015 runner 子集（不改任務正文／依賴／勾選）**：本輪 §35 將 §34 已實測資料庫流程整理為 `npm run test:db` 單入口；兩份測試各自有效 TAP 61／61、53／53，not ok 與 SQL error 故障注入均非零退出並完成授權撤銷／資源清理，清理後正式入口重跑成功。T004 僅本機 DB 測試配置子集；T007／T008 僅現有 migration／RLS／account-gate 測試執行子集；T015 僅兩份 SQL 測試、parser、失敗與重跑子集。所有原依賴、Q-SCHOOL 及其他測試範圍保留；136 項仍全部未勾選，無任務結案。完整實際結果與證據見 [readiness-review.md](./readiness-review.md) §35.2；不是 Gate 通過或常設許可。

**2026-10-22 後續 Readiness 準備授權（不改任務狀態）**：教育者另授權 Gate 前研究、候選政策與證據盤點，成果見 [readiness-review.md](./readiness-review.md)。上方「只批准……Analyze」是產生任務時的授權快照；本次仍未批准 Checkpoint／Gate 通過、產品實作、政策數值、資源或上線。136 項保持未勾選，準備性工作不是 T001／T002 結案。

**2026-10-24 T051 方案 B 隔離本機子集（不改原任務正文／依賴／勾選）**：依 [readiness-review.md](./readiness-review.md) §41，教育者明確選定先建未分類點子並批准必要 migration、受控原子建立、冪等、擁有權隔離、新舊唯讀介面及 fail-closed 分類資格邊界。原 T051 依賴 T050、T039 保持；T051／T050／T015／T006／T008／T095／T004 僅記實際涉及子集。136 項仍全部未勾選；本輪部分成果不結案整條任務、不表示原依賴滿足或 Gate 通過。分類確認、需求 revision／失效、階段保存、版本衝突、HTTP／UI、真實 Auth／部署仍關閉；§41 完成即停止。

**2026-10-24 T051 分類確認後續子集（不改 136 項原任務正文／依賴／勾選）**：依 [readiness-review.md](./readiness-review.md) §43，僅記錄 T051 的最小需求 revision／保存、擁有者學生明確 A／B 與 visitor 確認、需求修改原子失效及可信 DB 讀取；T050／T015 的契約與真實 PostgreSQL 測試子集；T006／T008／T095 的 DTO／授權／可信來源邊界；T004 的必要 runner 階段。其餘任務內容與原依賴均未變，136 項保持未勾選，無任務結案；此子集不表示原依賴滿足、G0／Checkpoint／完整 Gate 通過或後續產品操作獲准。

**2026-10-24 T052 創作旅程本機純函式子集（不改 136 條任務正文／依賴／勾選）**：依 [readiness-review.md](./readiness-review.md) §47，僅記錄九步正式順序、已核定分類／草稿證據關聯、A／B 作品範圍與未定分支 unsupported 判斷；T050／T015、T006 僅本輪測試／型別子集。T052 原依賴 T051 保持，不宣稱已滿足 T051 完整範圍；T052 只記部分成果、不勾選整條，136 條仍全部未勾選。沒有旅程推進、HTTP／UI、資料保存、任務執行或操作授權；Gate／正式簽核狀態不變，本輪完成即停止。

**2026-10-26 T003／T004／T006／T007／T012／T013 Gate 前本機基礎實作（不改任務正文／依賴；僅在各任務行尾加進度註記，保持未勾選）**：依 [readiness-review.md](./readiness-review.md) §75，教育者授權的有界本機基礎實作。六項任務的本機程式、測試與配置已實作並驗證，但原依賴鏈尾端的 T001（Checkpoint／完整 Gate／階段授權）尚未取得，T002 亦未結案，因此**沒有任何任務勾選**；各行註記「實作完成」只表示該任務列明的本機範圍，不等於正式結案、Gate 通過或可啟用。`apps/worker`、`apps/works-edge` 現為僅配置的骨架（服務未實作）；`playwright.config.ts`、`supabase/config.toml`、`packages/core/contracts/works.ts`、`packages/core/policy/{works-csp,sensitive-text,plain-record}.ts`、`apps/worker/src/logging.ts` 已存在。136 項仍全部未勾選。

## 範圍、授權與共通規則

- MVP 完整範圍＝19 個故事、平台 AI 與完整創作流程、A／不需學生伺服器程式的合格 B（平台 Work Data API）。**不是 US1 單獨就構成產品 MVP**。
- A1＝一次性兌換＋host-only 分區 Secure／HttpOnly cookie＋伺服端逐請求驗證；hostname 只隔離 origin。B2＝平台非對稱簽署單作品／用途／期限／撤銷版本授權，edge 無簽署私鑰／全域資料 HMAC。X＝`ports: []` 建置→管理通道取回／整份檢查／保存不可變產物→iframe 重載，無 HMR／WebSocket。
- **不產生** β2／M／W runtime 任務、公開作品 AI Gateway／訪客 AI／公開 AI 池扣款或其專用 Gate。FR-050／AC-19 及 AC-20 的公開 AI 部分是歷史；未動用公開 AI 池不得轉入他池，非 AI 費用歸屬仍須驗。
- 每項 `來源 Rxx` 是下表可展開的 **FR／AC／SC＋Plan＋契約＋V／S** 完整來源集合，不是自創需求。任務描述再列其局部案例；資料模型／UX 亦依下表。共用任務可引用多個來源。`依` 列出直接先決任務，傳遞依賴也必須完成。
- **全域前置 G0（適用所有任務）**：本文件不是開工授權。文件核定／研究只可在另有明確授權的範圍內執行；產品工作（含程式、migration、依賴安裝、環境建立或供應商資源操作）開始之前，須有適用 Checkpoint／完整 MVP 單一 Readiness Gate 結論及教育者對該階段的明確批准。受 Gate 前實測條件阻擋的研究，必須另取限縮研究授權，不能以產品實作繞過；原 Tasks 產生時未執行，後續限縮準備授權見上方紀錄。**本機階段僅有教育者明確授權的有界子集例外（readiness-review.md §17、§19～§21、§24、§25 已完成；§26 為 2026-10-23 已完成的限定授權：Job 時間比較、測試描述、測試型別檢查與文件狀態同步；§27 為 2026-10-23 僅文件的待決方案補齊與正文複核，不涉及程式；§28 為 2026-10-23 的 D-06／UTC／SSE 決策同步與限定本機實作：帳號層帳號準備政策純函式、SSE 專屬登錄與事件序列純函式、UTC 合成驗證，不建立 migration、資料表或端點；§29 為 SSE 本機映射最小修復；§30 為 T095 作品範圍資格純函式／合成測試部分），詳見 [readiness-review.md](./readiness-review.md) §26.1／§26.6／§27.1／§28.1／§29.1／§30.1；各階段只涵蓋其列明的子集，不代表 G0、Checkpoint 或完整 MVP Readiness Gate 通過，不是常設許可，也不放行其他任務。**
- **G0／Q 時點澄清（2026-10-22）**：另獲授權的公開唯讀查證／本機合成研究可在 Gate 前形成 T002 的前置輸入，不以 T001 已完成為條件；T002 原依 T001 的產品階段核定／結案依賴保留。本輪不建立環境、不用供應商憑證；需新資源、研究 BFF／schema 或付款者另提專項授權。Readiness 審核完整 MVP 的政策／可行性及測試設計，不要求先完成 T127～T131 的實作後四類正式產品驗收；其完整通過證據仍是後續產品驗收／上線條件。各 Q 原 T1／Tn／TL 時點與所有阻擋行為不變，不構成分範圍放行。
- 各故事的獨立測試使用合成 fixtures／受控替身即可隔離驗證；**不能代替**最後四類正式整合測試、上線證據或供應商實測。各故事／P1～P6 只是交付與測試順序，無分範圍放行。
- 所有錯誤必須顯示固定碼與繁中下一步，維持草稿／已保存資料，不以廣泛 catch 或成功形狀預設值掩蓋；測試證據去敏，不讀出／保存任何密鑰或真實兒童個資。

## 來源索引與完整覆蓋（每項任務依來源鍵展開）

Plan「P1～P6」指既有交付階段，不是本檔故事優先度。契約縮寫：AUTH＝[auth-and-identity.md](./contracts/auth-and-identity.md)，LIFE＝[access-and-lifecycle.md](./contracts/access-and-lifecycle.md)，CHAT＝[ai-chat-and-safety.md](./contracts/ai-chat-and-safety.md)，PROJ＝[projects-agent-sandbox.md](./contracts/projects-agent-sandbox.md)，PUB＝[publishing-and-public-runtime.md](./contracts/publishing-and-public-runtime.md)，BUD＝[usage-and-budget.md](./contracts/usage-and-budget.md)，COMMON＝[README.md](./contracts/README.md)。V／S 均指 quickstart **現行**案例；不取被覆寫的 V-53 舊預期。

| 鍵／故事 | Spec FR（含所列子條文） | AC／SC | Plan／模型／UX | 契約 | V／S 驗證來源 | 主責任務 |
| --- | --- | --- | --- | --- | --- | --- |
| R00 共用基礎 | FR-026、033、035～045、046、049、055 | AC-11、12、14、16、25、27；SC-001、005、012～014、017、023 | Technical Context、憲章檢查、P1～P6、資料最小化；模型 §0～2、4.2、8；UX §2、12 | COMMON 全部通則；各契約共通授權／錯誤 | S-01～09、S-14～15；V-01～04、V-31、V-37～45、V-48、V-53、V-56～57 | T001～T015、T127～T136 |
| R01 US1 | FR-033、035～038、043、045 | AC-12、14；SC-001、010、013 | P1、設計摘要1～3；模型 §1～2；UX §11 | AUTH A-2～4／§4；LIFE T-1～2 | V-02、V-11～13、V-39；S-03 | T016～T020 |
| R02 US2 | FR-003、016、028～029、031 | AC-01、04；SC-002～005、013 | P2／P3；模型 §3～4；UX §3～5 | CHAT H-1／4／6；PROJ P-1～4 | V-21、V-51；S-11 | T038～T041 |
| R03 US3 | FR-001～008、021～022、026、031、034 | AC-02、11、15；SC-003～005、011～012 | P2；模型 §3；UX §6、12 | CHAT H-1～6、F-1～4、W-1、串流 | V-21、V-31、V-43／45；S-11 | T042～T049 |
| R04 US4 | FR-009、019、023、026、029、031、049 | AC-04、05、11、27；SC-004～005、017 | P3；模型 §4.1；UX §8～9.4 | PROJ P-1～4、E-1～2 | V-21、V-51；V-56 版本真實性 | T050～T055 |
| R05 US5 | FR-010～012、019～021、023、025～027、038～041、049 | AC-05、06、11、27；SC-003、005～007、012、017 | P4、D-23／X；模型 §4.2～4.4；UX §9 | PROJ E-1～3、G-1～4、§5～6；PUB §3.6～3.7／7 | V-22、V-31、V-52～53、V-56；S-04～05／11／15 | T056～T066 |
| R06 US6 | FR-012、025～026 | AC-07、08、11；SC-004～007 | P3／P4；模型 §4.1；UX §10 | PROJ S-1～3、T-1～2 | V-23～24、V-56 | T067～T070 |
| R07 US7 | FR-013、024～026、032、037～039、043、048～049 | AC-09～11、17、18、27；SC-005、008、012、015～017 | P5；模型 §5.1～5.2／5.5；UX §10 | PUB R-1～7、§2～3／7；PROJ E-3 審查快照 | V-25～29、V-31／36、V-54～57；S-07／10 | T084～T090 |
| R08 US8 | FR-014～015、036～038、043、052 | AC-12、14、22；SC-001、004、010、020 | P1／P5；模型 §1.6／2.2；UX §1.2、11 | LIFE T-1～5；PUB R-3～5 | V-11～15、V-25；S-12 | T071～T075 |
| R09 US9 | FR-015、033、035～036、038、043 | AC-12、14；SC-001、010、013 | P1／P2／P5；模型 §1～2、6；UX §11 | AUTH A-5～7；LIFE L／T；CHAT S-1／7／9 | V-06、V-11～12、V-39、V-44 | T076～T079 |
| R10 US10 | FR-016～020、026、031、041、044 | AC-03、11；SC-003～005、012 | P2／P3；模型 §3；UX §7 | CHAT H-6～7；PROJ 工具白名單 | V-21、V-31；S-11；交接案例依 US10.1～4 | T080～T083 |
| R11 US11 | FR-030、042～043、050（不動用／不轉池）、055 | AC-13、20（僅現行歸池）、25；SC-009、023 | P4／P6、R-08／09；模型 §8；UX §12 | BUD §1～4、Q-1～2、B-1～5 | V-37～42；S-04／15 | T107～T113 |
| R12 US12 | FR-027、031、034 | AC-05、15；SC-003、005、011 | P3／P6；模型無新增實體；UX §3、4、9.1、13 | COMMON 錯誤／狀態；PROJ E-2 | §2.7、V-21、V-53、V-56；S-11 | T114～T118 |
| R13 US13 | FR-035、038、043、045～047 | AC-12、16；SC-001、012、014、018 | P1、設計摘要1；模型 §1.1～1.2／2.1／4.3；UX §1.1、11 | LIFE L-1～3／§2；AUTH A-1／4 | V-01～08、V-29、V-48；S-03／09 | T021～T025 |
| R14 US14 | FR-013、032、038～040、043、048～049、050（不動用）、055(f) | AC-18、20（僅非 AI）、25、27；SC-001、009、012、015～017、023 | P5、D-23 A1／B2／X；模型 §4.4／5.4～5.5；UX §1.4、9.3～9.4、10 | PUB §3.2～3.3（未衝突部分）、§3.6～3.7／7；BUD 歸池 | V-28、V-31／36、V-51～57；S-05／07／10 | T091～T099 |
| R15 US15 | FR-035、038～039、043、045、051 | AC-12、21；SC-001、012、019 | P1、D-07a；模型 §1.5；UX §11 | AUTH A-1、A-5～9／§2 | V-09～10；S-01～03 | T026～T030 |
| R16 US16 | FR-013～015、035～038、043、052 | AC-12、14、22；SC-001、005、010、015、020 | P1／P5／P6；模型 §1.6／7／9～10；UX §11～12 | LIFE C-1～8；AUTH §2；PUB 停止公開 | V-13～18、V-29；S-03／07～08 | T100～T106 |
| R17 US17 | FR-003、020～021、026、038、043、046、053 | AC-11、16、23；SC-005、012、014、021 | P2、D-14／18；模型 §6.1／6.4；UX §1.1、11～12 | CHAT §3～5、S-1～5／7～10（後續覆寫）；BUD Q-2 | V-03～04、V-36、V-43～45、V-48／50；S-06／09／14 | T031～T037 |
| R18 US18 | FR-024、035、038、043、052、054 | AC-12、22、24；SC-001、012、020、022 | P1／P5；模型 §2.3／7；UX §11 | LIFE V-1～4；AUTH A-10 | V-14／19；S-03 | T119～T122 |
| R19 US19 | FR-038～039、043、052、054、056 | AC-12、22、24、26；SC-001、012、020、022、024 | P1／P6；模型 §7／9～10；UX §11 | LIFE P-1～4／C-4～5 | V-20、V-16～18；S-08 | T123～T126 |

**覆蓋界線**：FR-001～056 均在表中逐號或連續範圍涵蓋，FR-050 僅現行不動用／非 AI 歸池約束，不建立其歷史公開 AI 功能。AC-01～18、21～27 全覆蓋；AC-19 已被 AC-27 取代，AC-20 只驗現行非 AI 費用。SC-001～024 全覆蓋；SC-017 取現行版。V-30、V-32～35、V-46～47、V-49、S-13 的舊要求不計入 MVP 覆蓋率；V-47 的現行不執行阻擋取 V-28／55。V-53 採逐子案例適用表及 V-56／57。

## 待核定前置條件（本次不填值、不核定）

| 前置鍵 | 須取得的決定／證據、責任與原定時點 | 阻擋任務／未就緒行為 |
| --- | --- | --- |
| Q-AUTH | 技術負責人執行另獲授權的 S-01～03，教育者核定 D-07b～e／PP-02～04 登入碼與節流／session 政策；D-20 教職員註冊／重設欄位待核定，T1／P1 前 | T017～T019、T026～T030；失敗回報 D-07a，不自換 Auth；不以合成成功當產品可用 |
| Q-SCHOOL | D-03～06 的申請處置、核准有效期／失效判定、複查範圍、未確認學校教師能力；教育者 T1 核定 | T022～T025、T085、T090、T120；選項只於測試替身分別驗，正式未決分支拒絕，不以 α 測試預設作政策 |
| Q-SAFE | D-14 類別／結案碼、邊界情境與可接收條件 T1；PP-05b 值守／備援／交接 TL 前；S-06 評測樣本與準確度門檻、文案／案件法務與兒少保護專業審閱，由技術／專業者提案、教育者核定 | T032～T037、T045、T064；未核定值守不開學生 AI；分類器故障拒絕；未審閱文案不上線 |
| Q-DATA | D-09／10／15、PP-09～18：保存／清除／tombstone、附件限制、快照份數、稽核合併窗口、複查限速／期限、個資代提入口及非帳號資料處理；技術／隱私負責人提案，教育者依 T1／TL 核定 | T043～T044、T054、T072、T103～T106、T120～T126；未核定不啟用相應寫入／清理，不默認永久保存或自動刪除 |
| Q-X20 | PP-20：型別、單檔／總量、檔數、壓縮／解壓限制；依已知取回吞吐與惡意產物研究提出限制維度／邊界方案，候選數值**待核定、無預設**；技術負責人 Tasks 提案、教育者最遲 Gate 前核定 | T059～T062、T089、T129；未核定不接受／服務未經核定限制檢查的產物 |
| Q-X21 | PP-21：建置逾時與取消清理上限；依冷暖／取消／kill-delete 證據提案，數值**待核定**；教育者最遲 Gate 前核定 | T058、T060、T064、T129；逾時失敗／取消且不綁產物，清理未證實不回報完成 |
| Q-A12223 | PP-22 會話 TTL／絕對期限、PP-23 含所有快取的最大撤銷失效上界；安全／平台技術負責人提案，教育者最遲 Gate 前核定、正式驗收前驗證；數值**待核定** | T061～T063、T087、T092、T128；未核定不簽發／續用，不能保證上界即拒絕 |
| Q-BROWSER | PP-24 目標瀏覽器／完整版本／學校裝置／政策支援清單，技術負責人 Tasks 整理，教育者 V-53 前核定；§0.1①的每格 N／裝置數／執行方案**待核定**、執行前核定 | T062、T066、T118、T127；必要 cookie 不符或未知環境明示不支援，不退回 hostname |
| Q-PEAK | PP-25：20 人尖峰冷暖／大小產物端到端與分段延遲、排隊、錯誤率／費用；技術負責人提出各量測維度／成本重算方案，教育者尖峰驗收前核定，數值／輪數／持續時間／樣本量**待核定** | T129～T130、T133；未核定只報量測，不判通過或開課堂試行 |
| Q-B226 | PP-26：Work Data 儲存／請求／限流／費用配額；技術負責人 Tasks 提案單位、作用域與原子計數候選，教育者最遲 Gate 前核定；數值**待核定** | T092～T099、T131；未核定拒絕所有相關資料請求，不借 β2 配額 |
| Q-B227 | PP-27：簽章標準實作、key id 發布／撤銷、輪替週期／重疊窗口／緊急責任方案；平台安全負責人提案，教育者最遲 Gate 前核定；所有窗口／週期**待核定** | T093～T099、T131；未核定不啟用寫入，未知／撤銷 key、驗章或更新失敗拒絕，不把私鑰交 edge |
| Q-BUDGET | D-11／12、PP-06／08：個人與管理員測試額度、限流並行、模型／價格、對帳門檻；T1 提案／依原 TL 核定，成本降低 S-04／15 於 P2／P4 開工前回報；未核定不得自造硬上限 | T009、T045～T047、T064、T108～T113、T130；無額度政策不付費呼叫，其他用途拒絕；基礎設施僅估算監測，不擅加自動阻擋 |
| Q-HOST | D-17 候選供應商／實際方案／區域／Team／網域／郵件／PITR 各別核定及另行資源授權；S-05 隔離與 S-07 下架實測、D-08／PP-01 上界；教育者於原階段／建立前核定 | T005、T058、T089～T090、T127～T133；測試失敗呈報差異，不自行替換架構或建立付費 Pro |
| Q-TL | D-18／S-09 學校同意告知、供應商兒童條件／ZDR **啟用**佐證、法務／兒少保護與文案審閱、值守／備援、PSL；授權來源完整的 Skills（FR-044／OD-07）與指南 OD-08；教育者及適用專業責任人依原 Tn／TL 核定 | T039～T041、T082、T132～T136；不啟用學生帳號／學生 AI 或公開上線，`store:false` 不代替 ZDR |

PP-20～27 的候選目前是**政策維度、證據來源與 fail-closed 方案**，不是捏造數值；後續 T002 收斂具數值候選並送核定。每類矩陣樣本量、時間精度、觀察窗口／地區選樣等亦須先提案核定，未核定不得宣布正式驗收通過。

**候選與證據索引（2026-10-22）**：[readiness-review.md](./readiness-review.md) §2～5 列本輪候選、實際研究與未執行原因；數值證據不足仍寫「暫無可核定建議」。PP-24／25 分別於 V-53／尖峰驗收前核定，其餘六項 Gate 前核定；未移動任何期限，未核定任何 Q。

## Phase 1：Setup（P1～P6 共用準備；5 項）

- [ ] T001 在 `specs/001-app-planet-platform/plan.md` 登錄另行取得的 Checkpoint、單一 Readiness Gate 與階段授權引用；未取得不得啟動產品工作，不自行判通過。【來源 R00；依 G0】
  **〔§76：已搜尋原檢核／最新紀錄並同步 plan；只有準備性未通過，無正式通過／簽核。本批有界授權另列，不充當 Gate。完整結案仍缺適用前置與正式審議結論。〕**
- [ ] T002 在 `specs/001-app-planet-platform/decision-register.md` 整理所有 Q 前置的證據／候選與逐項核定紀錄，含另獲限縮研究授權後的 S-01～03、S-04／15、S-05／09／14 前置結果；未取得保留阻擋，不等待 T130 產品成本測試才補 P2／P4 開工條件；PP-20～27 待核定，不用 Spike 值。【來源 R00、R05、R14；依 T001】
  **〔§76：全部 14 個適用 Q 與 Gate 的 A～E 現況／原時點／責任／動作已集中於 decision-register；D-04(b)／D-05(a) 僅方向批准，D-03 描述差異不自行替換。正式 Supabase 未選，沿用未發出的詢證草稿。原依賴、外部／政策缺口及完整結案阻擋保留。〕**
- [ ] T003 在 `package.json`、`apps/web/package.json`、`apps/worker/package.json`、`apps/works-edge/package.json`、`packages/core/package.json` 建立非破壞 workspace 與 Node 24／Next 16／React 19／TypeScript 鎖定相容性驗證；保留既有檔案、不引入 ORM。【來源 R00；依 T001】 **〔§75 進度 2026-10-26：實作完成（本機範圍），未勾選。四個 workspace 已宣告（`apps/worker`、`apps/works-edge` 僅配置骨架，服務未實作）；各 manifest `engines` 為 Node 24；`scripts/workspace-compat.ts`（`npm run verify:workspaces`、`tests/unit/workspace-compat.test.ts`）驗證 Next 16／React 19／TypeScript 7 的宣告、安裝與鎖定檔一致、無 ORM、workspace 連結。剩餘結案條件：依賴 T001 未取得。〕**
- [ ] T004 在 `vitest.config.ts`、`playwright.config.ts`、`supabase/config.toml` 配置 Vitest／Playwright／pgTAP、型別檢查與合成 fixture 路徑，隔離單元／契約／資料庫／正式環境測試。【來源 R00；依 T003】 **〔§75 進度 2026-10-26：實作完成（本機範圍），未勾選。`vitest.config.ts` 分 unit／contract projects 並載入正式環境隔離守門（`tests/support/production-isolation.ts`）；`playwright.config.ts`＋`tests/e2e/shell.spec.ts`（本機 Edge channel 驗證，2／2 通過）；`supabase/config.toml`（僅 db、連接埠避開 CLI 預設，不含密鑰）；合成 fixture 路徑 `tests/fixtures/`；型別檢查涵蓋四個 workspace 與測試；pgTAP／隔離 PostgreSQL 沿用 `scripts/pgtap-local.ps1`。剩餘：依賴 T003 未結案（T001）；Playwright 內建 Chromium 需另下載，尚未執行（`APP_PLANET_E2E_CHANNEL` 可改用本機瀏覽器）。〕**
- [ ] T005 在 `apps/web/.env.example`、`apps/worker/.env.example`、`apps/works-edge/.env.example` 與 `specs/001-app-planet-platform/quickstart.md` 定義 dev／test／prod 分離、部署身分最小權限及 Q-HOST 資源申請／清理步驟，只列設定鍵，無值、不建立資源。【來源 R00；依 T002、T003；前置 Q-HOST】

## Phase 2：Foundational（所有故事的必要基礎；10 項）

- [ ] T006 在 `packages/core/contracts/common.ts`、`tests/contract/common.test.ts` 定義 Zod problem+json、request id、202 job、SSE、冪等與 If-Match 衝突 schema／測試，不洩漏內部或本文。【來源 R00；依 T004】 **〔§75 進度 2026-10-26：實作完成（本機契約範圍），未勾選。既有 reader schema 之外新增 producer 建構器：嚴格 problem+json（錯誤碼登錄由可信設定提供、拒絕 SSE 碼與敏感形狀）、`409 version_conflict` 的 `conflict` 結構（逐端點欄位投影）、`idempotency_key_reuse` 碼、`202` 只接受 queued 且 `result`／`failure` 為 null 的 Job 回應（Location 指向 jobs/{id}）；測試 `tests/contract/problem-producer.test.ts`。剩餘：各 kind 成功 `result`／`failure` 欄位待端點契約補齊；HTTP 串接屬 T011；依賴 T004 未結案。〕**
- [ ] T007 在 `supabase/migrations/0001_identity_audit.sql`、`supabase/tests/identity_audit.test.sql` 建立學校／profile／綁定／追加式 audit／代號對照與逐表 RLS，禁止自行改角色狀態，先驗跨帳號及不可 UPDATE／DELETE。【來源 R00、R01、R13；依 T004】 **〔§75 進度 2026-10-26：現有 schema 之驗證缺口已補，部分實作，未勾選。`0001_identity_audit.sql` 內容未改；`identity_audit.test.sql` 於隔離 PostgreSQL 由 61 擴充為 78／78 通過（逐表 INSERT／UPDATE／DELETE／TRUNCATE 權限為零、anon 不可讀、第二位學生跨帳號隔離、教師不可改綁定／角色／歸屬、教師不可讀稽核）。剩餘：`school_approval_records`／`school_transition` RPC、管理員改角色狀態 RPC、稽核其他 action 與 meta 白名單、清除時刪除對照屬待決（D-14、PP、完整非學生角色矩陣）或後續任務，未實作；依賴 T004 未結案。〕**
- [ ] T008 在 `packages/core/policy/account-gate.ts`、`apps/web/src/server/authorization.ts`、`supabase/migrations/0002_account_gate.sql` 以共用案例表落實即時帳號／角色／資源能力與教師凍結，JWT 僅辨識人；受限入口分離。【來源 R00、R01、R13、R16、R18；依 T006、T007；前置 Q-SCHOOL】
- [ ] T009 在 `supabase/migrations/0003_usage_jobs.sql`、`packages/core/usage/ledger.ts` 建立原子預留／結算／釋放／unknown 與 jobs 交易骨架、Taipei 週期鍵；無政策不呼叫模型，不建立公開 AI 池列。【來源 R00、R11；依 T007；前置 Q-BUDGET】
  **〔§76：本機核心已驗證：整數 micro-USD／bigint、受限 DB 政策來源、原子 Job＋預留／結算／釋放／unknown、冪等／回滾、Taipei 日月桶、ACL／RLS 與去敏 audit。全新庫及既有 0009～0012 後補 0003 均通過。部分完成、不勾選；程式仍缺 teacher／admin 完整授權、個別 quota override／調整、搜尋等未定價格維度與可信 provider usage／對帳核對路徑；分數 micro 無核定捨入時 unknown。不啟用正式政策、無正式 adapter／模型／公開池；Q-BUDGET、T007 原依賴保留，不統稱只差 T001。〕**
- [ ] T010 在 `apps/worker/src/jobs/runner.ts`、`apps/worker/src/jobs/checkpoint.ts` 實作租約／SKIP LOCKED／心跳／冪等／取消與重試，每重要步驟重驗 gate／school_epoch，保留部分成果與 unknown 核對。【來源 R00、R05、R17；依 T008、T009】
  **〔§76：本機 runner／checkpoint 與真實 DB 核心已驗證：SKIP LOCKED、租約／心跳／fence、同鍵 Job、取消／可靠未送出重試、持久 partial refs／已知 usage、中斷恢復、即時 account／school epoch 與必要注入式 capability／duty／resource gate。外部不明不重跑，unknown 保留預留；平台 fence 非外部終止證據。部分完成、不勾選；正式 worker 連線／可信 gate／provider／各 kind handler、off-duty 狀態與續跑規則、核對佇列 consumer 尚未實作，非 A-9 dispatcher；T008／T009 與 Q 原依賴保留。〕**
- [ ] T011 在 `apps/web/src/server/http.ts`、`apps/web/src/server/idempotency.ts` 串接 COMMON schema、狀態查詢、If-Match／同鍵不同內容拒絕，停用或降權拒絕不可由 UI 隱藏代替。【來源 R00；依 T006、T008、T009】
- [ ] T012 在 `packages/core/policy/logging.ts`、`apps/worker/src/logging.ts` 建立最小白名單稽核／錯誤紀錄與去敏，不記 Body、Cookie、Authorization、登入碼、原 IP 或原始 preview id。【來源 R00；依 T006、T007】 **〔§75 進度 2026-10-26：實作完成（本機範圍），未勾選。`packages/core/policy/logging.ts` 診斷 DTO 加 R-12 遮蔽層並新增稽核 DTO（action／object_type／meta 鍵由可信設定提供，meta 值僅整數或固定碼）；`policy/sensitive-text.ts` 為縱深防禦，不是完整去敏（登入碼格式未核定，不以樣式猜測）；`apps/worker/src/logging.ts` 只把白名單 DTO 交給注入的 sink，失敗只回固定碼。測試 `audit-and-worker-logging.test.ts`。剩餘：真實 sink／保存／輪替、稽核寫入資料庫的串接、依賴 T006／T007 未結案。〕**
- [ ] T013 在 `packages/core/contracts/works.ts`、`packages/core/policy/works-csp.ts` 定義 A1／B2／X 狀態／簽章 claims／產物 schema、public／preview CSP 模式與保留路由；缺來源清單為 none，明確禁 hostname 授權與全域資料 HMAC。【來源 R00、R05、R14；依 T006】 **〔§75 進度 2026-10-26：實作完成（本機契約範圍），未勾選。`contracts/works.ts`：A1 會話狀態、`__Host-preview_session` Set-Cookie 屬性、逐請求判斷（TTL 政策未核定即拒絕、對外一致拒絕）；B2 claims（單一 listing、用途、exp、授權識別、撤銷版本）與驗章後判斷（不自製密碼學、無全域資料 HMAC）；X 產物 manifest 驗證（限制為 PP-20 明確輸入、缺值拒絕）與綁定；works 狀態回應；保留路由（`/_work/*`、`data/v1`、`fn/v1` 404、預覽專用 redeem）；`policy/works-csp.ts` 的 public／preview 模式（預覽來源缺失或無效 fail-closed 為 `'none'`）。測試 `works.test.ts`、`works-csp.test.ts`。剩餘：實際簽章／驗章、works-edge 服務、PP-20～27 核定值、依賴 T006 未結案。〕**
- [ ] T014 在 `apps/web/src/components/app-shell.tsx`、`apps/web/src/components/operation-state.tsx` 建立 Tailwind／Radix 的繁中真實狀態殼、草稿／保存／失敗／離線提示及授權導覽，不含示範角色切換。【來源 R00、R12；依 T011】
- [ ] T015 在 `supabase/tests/account_gate.test.sql`、`tests/contract/foundations.test.ts` 執行完整 gate／跨帳號／冪等／租約／費用競態與日誌白名單回歸；確認基礎測試證據，不宣稱故事或 Gate 已通過。【來源 R00；依 T008、T010、T011、T012、T013、T014】
  **〔§76：新增 usage-worker 真實 DB 整合 31 項，沿用 authorization 29／projects 203、pgTAP 78／53／15；費用契約／manifest 修復及現有 unit／contract 共 705 項通過，typecheck／build／本機 Edge 通過。僅本批子集；完整 HTTP／真 Auth／角色／UI 及未定政策分支回歸未完成，原依賴與未勾狀態保留。T004 的 Edge 入口及 T013 manifest 修正屬本批併入子集，不替代正式瀏覽器矩陣。〕**

**§76 T007 責任對照（不擴張任務）**：0001 既有學校／profile／綁定／audit／對照及 RLS 屬 T007；學校核驗文件／`school_approval_records` 與 `school_transition`、epoch 變更交易屬 T022，傳播／取消／停止作品屬 T023；管理員批准／角色狀態受控 RPC 屬 T018 及各生命週期任務，不藉 T009 新增。既有 teacher_view audit 白名單未改；本批費用追加式去敏 audit 與 worker 平台 checkpoint 屬 T009／T010。T007 尚有相應原 schema／稽核缺口，沒有完整結案；既有 0001／0002／0009～0012 原檔保持，不重新編號。

**基礎完成條件**：T001～T015 全部完成及其外部前置滿足，才可進入故事工作。這是任務依賴，不是 Checkpoint／Readiness 放行。

## Phase 3：US1 註冊、批准與角色存取（P1；5 項）

**目標／獨立測試**：合成未登入／待審／拒絕／停用／三角色逐一直接呼叫，SC-001 全拒未授權、無自提權，畫面與資料層一致。

- [ ] T016 [P] [US1] 在 `tests/contract/auth-states.test.ts` 撰寫 AUTH A-2～4／bootstrap 與狀態×角色的拒絕測試，含背景降權及無 demo 操作。【來源 R01；依 T015】
- [ ] T017 [US1] 在 `apps/web/src/server/auth/staff.ts`、`apps/web/src/app/api/v1/auth/staff/login/route.ts` 實作教職員註冊／登入／登出／經核定重設、`me` 最小回應與狀態閘門。【來源 R01；依 T016；前置 Q-AUTH】
- [ ] T018 [US1] 在 `apps/worker/src/admin/bootstrap.ts`、`supabase/migrations/0004_staff_approval.sql` 實作受保護一次性管理員 bootstrap、申請角色不等於權限及批准／拒絕具名 RPC／稽核。【來源 R01；依 T017】
- [ ] T019 [US1] 在 `apps/web/src/app/(auth)/status/page.tsx`、`apps/web/src/app/(auth)/login/page.tsx` 實作待審／拒絕／停用／批准畫面及授權帳號區，不給受限者其他功能。【來源 R01；依 T018】
- [ ] T020 [US1] 在 `tests/e2e/account-states.spec.ts` 執行 T016 與狀態／直接 API／RLS 回歸，保存拒絕與稽核證據。【來源 R01；依 T019】

## Phase 4：US13 學校核准與學生 AI 閘門（P1；5 項）

**目標／獨立測試**：四種合成學校狀態＋有效帳號；未確認拒登入，撤回／失效仍可讀寫保存內容，但新 AI／部署拒絕、所有公開作品停止且恢復不自動公開。

- [ ] T021 [P] [US13] 在 `tests/contract/school-approval.test.ts` 撰寫 L-1～3 及 V-01～08，含教師越權、缺文件版本、人工失效與背景重要步驟；未決自動逾期不假設。【來源 R13；依 T015】
- [ ] T022 [US13] 在 `supabase/migrations/0005_school_approval.sql`、`apps/web/src/server/schools.ts` 實作核驗／撤回／失效／恢復交易、文件版本與 epoch，核定 D-04／06 後才啟用相應分支。【來源 R13；依 T021；前置 Q-SCHOOL】
- [ ] T023 [US13] 在 `apps/worker/src/jobs/school-change.ts` 串接停止作品、取消 AI／部署重要步驟、清理會話與稽核；恢復只解除校級阻擋，不自動恢復公開。【來源 R13；依 T022、T010】
- [ ] T024 [US13] 在 `apps/web/src/app/(admin)/admin/schools/page.tsx`、`apps/web/src/components/school-gate-notice.tsx` 建立管理員文件登錄與學生非 AI 可用說明，不設個別同意資料欄位。【來源 R13；依 T023】
- [ ] T025 [US13] 在 `tests/e2e/school-gates.spec.ts` 執行四狀態／撤回恢復／下載自有成果及直接／背景拒絕；公開入口正式時限結果留待 T090，不先判通過。【來源 R13；依 T024；前置 Q-SCHOOL】

## Phase 5：US15 登入碼核發與重發（P1；5 項）

**目標／獨立測試**：合成無個人電郵學生核發→批准→一次顯示→登入→重發，舊碼／舊 session 與無資格教師被拒；三個中斷點不造成兩碼皆無效。

- [ ] T026 [P] [US15] 在 `tests/contract/student-credentials.test.ts` 撰寫 A-1／5～9、V-09～10 與 S-01～03 的合成網域／同校 NAT／列舉／舊 session 驗證腳本，需另授權的實測不自動執行。【來源 R15；依 T015；前置 Q-AUTH】
- [ ] T027 [US15] 在 `supabase/migrations/0006_student_credentials.sql`、`apps/web/src/server/auth/student.ts` 實作 handle→內部合成識別、核發／管理員批准／一次領取，碼不進 URL／儲存／通知／日誌。【來源 R15；依 T026、T018、T022】
- [ ] T028 [US15] 在 `apps/web/src/server/auth/reissue.ts` 實作有效綁定教師／管理員重發、Auth 與 DB 失敗補償、session 版本阻擋及節流，任何殘留視窗依 S-03 呈報教育者，不宣稱已原子保證。【來源 R15；依 T027；前置 Q-AUTH】
- [ ] T029 [US15] 在 `apps/web/src/app/(auth)/student-login/page.tsx`、`apps/web/src/components/student-credential.tsx` 實作僅帳號＋登入碼、一次顯示／重發確認與不可區分錯誤，無學生姓名／聯絡欄位。【來源 R15；依 T028】
- [ ] T030 [US15] 在 `tests/e2e/student-credentials.spec.ts` 執行錯誤／舊碼／資格／三中斷／重送測試並核對 S-01～03 原始證據，若方案 A 未達條件回 D-07a，不更換供應商。【來源 R15；依 T029；前置 Q-AUTH】

## Phase 6：US17 內容安全、求助與 App 值守（P1；7 項）

**目標／獨立測試**：合成一般／不適齡／求助／高風險語料與注入時鐘；逐入口檢查、故障拒絕，值守被擋時不預留／不呼叫模型，事件可接收、處理、升級、直接結案。

- [ ] T031 [P] [US17] 在 `tests/contract/student-safety.test.ts` 撰寫 V-43～45／48／50、S-06／14 的合成評測與站內／電郵／主責備援失效案例，不建立訪客 AI 事件。【來源 R17；依 T015】
- [ ] T032 [US17] 在 `supabase/migrations/0007_safety_duty.sql`、`packages/core/policy/duty-gate.ts` 建立核定值守／假日／交接／備援及 `duty_elapsed`，每請求及 AI 重要步驟即時判斷；不實作 school_handling_windows。【來源 R17；依 T031；前置 Q-SAFE】
- [ ] T033 [US17] 在 `apps/web/src/server/ai/safety.ts`、`apps/worker/src/ai/safety.ts` 實作文字／圖片輸入與逐句輸出檢查、求助分流／固定高風險模板及故障拒絕，先值守再分類器／額度，`store:false` 不當 ZDR。【來源 R17；依 T032、T012；前置 Q-SAFE、Q-TL】
- [ ] T034 [US17] 在 `apps/web/src/server/safety/events.ts`、`apps/worker/src/jobs/safety-notifications.ts` 實作事件與站內通知同交易、有效教師否則管理員、電郵輔助失敗可見；寄出不當接收，不含全文。【來源 R17；依 T033；前置 Q-HOST】
- [ ] T035 [US17] 在 `apps/worker/src/jobs/safety-escalation.ts`、`apps/web/src/server/safety/handling.ts` 實作一值守小時升級、管理員備援、交接不歸零、在途／排隊停止及直接 close；待決邊界不自行選案。【來源 R17；依 T034；前置 Q-SAFE】
- [ ] T036 [US17] 在 `apps/web/src/app/(admin)/admin/safety/page.tsx`、`apps/web/src/components/safety-response.tsx` 建立待處理／接收／結果與值守未設定提示，使用審閱文案，無全天／即時救援承諾。【來源 R17；依 T035】
- [ ] T037 [US17] 在 `tests/e2e/safety-duty.spec.ts` 執行 T031、語料混淆矩陣與注入時鐘邊界／故障測試，分開記錄機制成功、準確度未核定及真實值守／文案未取得。【來源 R17；依 T036；前置 Q-SAFE】

## Phase 7：US2 首頁、Skills 入口與直接對話（P1；4 項）

**目標／獨立測試**：三卡＋不選 Skill 直接輸入四路徑，品牌正確、保留草稿附件，空專案與實際旅程不造假。

- [ ] T038 [P] [US2] 在 `tests/e2e/home-entry.spec.ts` 撰寫四路徑、三行品牌、最近專案／空狀態與旅程保存推導案例。【來源 R02；依 T015】
- [ ] T039 [US2] 在 `packages/core/skills/catalog.ts` 登錄三個 Skills 來源／授權／版本與可用能力，未取得標 pending_source、不臆造完整指引，缺必要來源保持阻擋。【來源 R02、R10；依 T038；前置 Q-TL】
- [ ] T040 [US2] 在 `apps/web/src/app/(student)/page.tsx`、`apps/web/src/server/home.ts` 實作 RAE／指定品牌、三卡起始引導、直接輸入、最近專案及真實階段摘要，不跳批准關卡。【來源 R02；依 T039、T019、T024】
- [ ] T041 [US2] 在 `tests/e2e/home-entry.spec.ts` 執行四路徑與草稿附件／旅程回歸，正式聊天整合隨 T049 重驗，不將導覽成功當 AI 成功。【來源 R02；依 T040、T049】

## Phase 8：US3 對話、四工具與草稿（P1；8 項）

**目標／獨立測試**：對話歷史／刪除、四工具、中文 IME、停止／中斷及跨工具草稿；真實來源／成果，不產生假成功。

- [ ] T042 [P] [US3] 在 `tests/contract/chat-tools.test.ts` 撰寫 H-1～6、F-1～4、W-1、SSE／續傳／停止與附件錯誤測試；超限、權限、離線不得掉草稿。【來源 R03；依 T015】
- [ ] T043 [US3] 在 `supabase/migrations/0008_conversations_files.sql`、`apps/web/src/server/conversations.ts` 建立對話／訊息／檔案庫 RLS、全部歷史分頁搜尋／改名／刪除與另存資源獨立生命週期。【來源 R03；依 T042；前置 Q-DATA】
- [ ] T044 [US3] 在 `apps/web/src/server/attachments.ts`、`apps/worker/src/jobs/scan-file.ts` 實作私有上傳／驗證／掃描／處理中可否送出、失敗重試／移除及檔案庫搜尋預覽，不服務未核可附件。【來源 R03；依 T043；前置 Q-DATA】
- [ ] T045 [US3] 在 `apps/web/src/server/ai/chat.ts`、`apps/web/src/app/api/v1/conversations/[id]/messages/route.ts` 實作授權後安全管線／預留／SSE、發話者與 Skill 版本、停止及 Last-Event-ID 已保存續傳。【來源 R03、R17；依 T044、T033、T009；前置 Q-BUDGET、Q-TL】
- [ ] T046 [US3] 在 `apps/worker/src/jobs/images.ts`、`apps/web/src/server/images.ts` 實作圖像模式／進度／停止／雙重安全檢查，成功才建立檔案庫成果／專案引用，unknown 費用進核對。【來源 R03；依 T045；前置 Q-HOST】
- [ ] T047 [US3] 在 `apps/web/src/server/ai/web-search.ts` 實作核定來源政策的真實網頁搜尋／處理狀態／來源連結，失敗回明確錯誤，不顯示固定示例。【來源 R03；依 T045；前置 Q-SAFE、Q-BUDGET】
- [ ] T048 [US3] 在 `apps/web/src/components/chat/composer.tsx`、`apps/web/src/components/chat/history.tsx` 實作固定順序「＋」、空白拒送、多行／IME、快捷鍵、模式取消、進度、草稿持久化／離頁選擇與刪除影響提示。【來源 R03；依 T044、T046、T047、T014】
- [ ] T049 [US3] 在 `tests/e2e/chat-tools.spec.ts` 執行四工具、空庫、搜尋無結果、部分輸出、刪除不連帶資源、離線恢復與 S-11，確認 0 假成功／靜默遺失。【來源 R03；依 T048、T037】

## Phase 9：US4 創作引導與七頁籤（P1；6 項）

**目標／獨立測試**：兩專案各階段保存再登入一致；七頁籤共用脈絡，草案／確認／人工批准分離，只有 A／B 選項。

- [ ] T050 [P] [US4] 在 `tests/contract/project-stages.test.ts` 撰寫 PROJ P-1～4、row_version 衝突、AI 不可批准、兩專案與 A／B 選項測試。【來源 R04；依 T015】
- [ ] T051 [US4] 在 `supabase/migrations/0009_projects_stages.sql`、`apps/web/src/server/projects.ts` 建立 project／stage_records／tasks 與獨立授權、階段修訂／確認／人工批准及真正任務保存，DB 拒絕 C。【來源 R04；依 T050、T039】
- [ ] T052 [US4] 在 `packages/core/policy/creation-flow.ts` 定義點子到 Final Pack 全步驟及級別需求判斷，旅程摘要不能跳 Constitution／Checkpoint／同步／任務／審查。【來源 R04；依 T051】
- [ ] T053 [US4] 在 `apps/web/src/app/(student)/projects/[id]/layout.tsx`、`apps/web/src/components/project/seven-tabs.tsx` 串接藍圖／設計／計畫／建立／測試／版本／發布共同脈絡與目前階段，不混學生作品配色與品牌。【來源 R04；依 T052】
- [ ] T054 [US4] 在 `apps/web/src/components/project/save-controller.tsx` 實作切專案／頁籤前保存、保留草稿或放棄選擇、409 衝突與重試，不讓 toast 冒充保存。【來源 R04；依 T053；前置 Q-DATA】
- [ ] T055 [US4] 在 `tests/e2e/project-stages.spec.ts` 執行兩專案／登出登入／七頁籤／失敗與人工批准測試；未串接的 IDE／測試／發布頁必須明示未就緒，待後續故事整合。【來源 R04；依 T054】

## Phase 10：US5 IDE、雙模式 Agent 與 X／A1 預覽（P2；11 項）

**目標／獨立測試**：同一合成修改在 guided／auto 的確認不同；重要修改前快照，可停止；X 各階段與版本正確、失敗保舊版，A1 無效 cookie 一律拒絕。

- [ ] T056 [P] [US5] 在 `tests/contract/agent-preview.test.ts` 撰寫 E-1～3／G-1～4、X 狀態機、A1 首次兌換、亂序／全階段故障與兩模式確認案例。【來源 R05；依 T015】
- [ ] T057 [US5] 在 `apps/web/src/components/ide/workspace.tsx`、`apps/web/src/server/project-files.ts` 實作 Monaco／檔案樹／If-Match 保存、路徑及大小檢查，區分草稿／保存／預覽版本並保護 IME。【來源 R05；依 T056、T055、T068；前置 Q-DATA】
- [ ] T058 [US5] 在 `apps/worker/src/sandbox/adapter.ts`、`apps/worker/src/sandbox/vercel.ts` 實作核定沙箱 adapter、`ports: []`／受限出站／無平台密鑰、kill/delete 逾時取消與可觀察清理，不呼叫 startPreview。【來源 R05；依 T057、T005；前置 Q-X21、Q-HOST、S-05 另授權實測條件】
- [ ] T059 [US5] 在 `apps/worker/src/preview/validate-artifact.ts` 實作管理通道產物整份驗證：正規化、穿越／符號連結／保留前綴、型別／大小／檔數／壓縮炸彈／manifest 雜湊；未核定／不可檢查即拒絕。【來源 R05；依 T058、T013；前置 Q-X20】
- [ ] T060 [US5] 在 `supabase/migrations/0011_preview_artifacts.sql`、`apps/worker/src/jobs/preview-build.ts` 建立 queued→building→retrieving→validating→保存→succeeded、私有不可變產物／快照雜湊及 generation 原子綁定，舊工作不倒蓋；排建置前套用學生伺服器執行與作品 AI 範圍阻擋，不將建置途徑當預覽 runtime。【來源 R05、R14；依 T059、T010、T095；前置 Q-X21】
- [ ] T061 [US5] 在 `apps/web/src/server/preview/sessions.ts`、`apps/works-edge/src/preview/redeem.ts` 實作單次權杖原子消耗、移除 URL 權杖及 A1 host-only 分區 cookie，伺服端只存 verifier／hash，未核定不簽發。【來源 R05、R14；依 T060、T013；前置 Q-A12223】
- [ ] T062 [US5] 在 `apps/works-edge/src/preview/serve.ts`、`apps/web/src/server/preview/authorize.ts` 實作 HTML／子資源／Worker／重載／資料每請求驗 cookie 與 live 權限／產物綁定、統一拒絕及 CSP；不支援環境明示拒絕、不回退 hostname。【來源 R05、R14；依 T061；前置 Q-BROWSER】
- [ ] T063 [US5] 在 `apps/web/src/server/preview/revoke.ts`、`apps/works-edge/src/preview/state-cache.ts` 接入解除綁定／停用／到期／審查結束等撤銷，證明含快取上界，平台不可達拒絕；不得以沙箱 TTL／destroy 代替授權失效。【來源 R05、R14；依 T062；前置 Q-A12223】
- [ ] T064 [US5] 在 `apps/worker/src/agent/run.ts`、`apps/worker/src/agent/tools.ts` 實作 guided 逐步確認／auto 批准任務集、pre_agent 快照、受限工具／重要步驟重驗／停止與費用 unknown，拒絕作品 AI 繞道且不可自行批准或部署。【來源 R05、R17；依 T060、T035、T051、T068；前置 Q-BUDGET、Q-SAFE】
- [ ] T065 [US5] 在 `apps/web/src/components/ide/preview-panel.tsx`、`apps/web/src/components/agent/run-panel.tsx` 串接保存→建置→iframe 重載、私人版次／排隊／失敗／保舊版／無舊版／重試／放大及 Agent 已完成未完成，無 HMR。【來源 R05；依 T063、T064】
- [ ] T066 [US5] 在 `tests/e2e/agent-preview.spec.ts` 執行雙模式／停止／保存及取回驗證保存各故障／亂序／不支援 cookie／無效會話，正式 TLS／跨區／尖峰不可由本機結果代替，交 T127～T130。【來源 R05；依 T065、T070；前置 Q-BROWSER】

## Phase 11：US6 測試真實性與版本恢復（P2；4 項）

**目標／獨立測試**：四種測試狀態綁快照；新快照不繼承通過；恢復前保存成功才覆蓋，可找回恢復前成果。

- [ ] T067 [P] [US6] 在 `tests/contract/snapshot-tests.test.ts` 撰寫 S-1～3／T-1～2、四狀態聚合／新版本與 pre_restore 保存失敗案例。【來源 R06；依 T015】
- [ ] T068 [US6] 在 `supabase/migrations/0010_snapshots_tests.sql`、`apps/web/src/server/snapshots.ts` 建立 blobs／manifest 雜湊／immutable submission、pre_agent／pre_restore 與先保存再恢復交易。【來源 R06、R05；依 T067、T051；前置 Q-DATA】
- [ ] T069 [US6] 在 `apps/worker/src/jobs/test-run.ts`、`apps/web/src/components/project/tests-versions.tsx` 實作沙箱測試 job／版本標示／四狀態聚合及恢復入口，不將 AI 完成當通過。【來源 R06；依 T068、T058】
- [ ] T070 [US6] 在 `tests/e2e/tests-restore.spec.ts` 執行 V-23～24 與保存故障、還原前成果找回、結果隔離，保存真實輸出／版本證據。【來源 R06；依 T069】

## Phase 12：US8 教師檢視與回饋（P2；5 項）

**目標／獨立測試**：有效／解除／停用綁定的三組教師直接讀專案、完整對話、檔案及紀錄；每次查看留稽核、回饋可重讀、學生告知同步。

- [ ] T071 [P] [US8] 在 `tests/contract/teacher-access.test.ts` 撰寫 T-1～5／V-11～15 與回饋重讀／權限凍結、停用快照資格但不可讀內容的案例。【來源 R08；依 T015】
- [ ] T072 [US8] 在 `apps/web/src/server/teacher/student-resources.ts`、`supabase/migrations/0012_teacher_feedback.sql` 實作逐請求綁定／凍結核對、查看稽核與回饋／審查理由保存，解除後資料處置依核定政策。【來源 R08；依 T071、T008、T051、T043；前置 Q-DATA】
- [ ] T073 [US8] 在 `apps/web/src/app/(teacher)/students/[id]/page.tsx` 實作授權學生專案／進度／完整對話／檔案／學習開發紀錄與回饋，凍結者只顯示允許資訊。【來源 R08；依 T072】
- [ ] T074 [US8] 在 `apps/web/src/components/teacher-visibility-notice.tsx` 串接綁定變更提示與 S-12 Realtime／請求重驗，不需刷新且不將提示當授權來源。【來源 R08；依 T073、T024】
- [ ] T075 [US8] 在 `tests/e2e/teacher-feedback.spec.ts` 執行回饋保存重讀／直接跨學生拒絕／解除立即失效／學生告知及查看稽核。【來源 R08；依 T074】

## Phase 13：US9 管理中心與稽核（P2；4 項）

**目標／獨立測試**：管理操作保存重讀且逐筆稽核；非管理員直接嘗試拒絕並有安全事件，不以任意角色切換模擬正式權限。

- [ ] T076 [P] [US9] 在 `tests/contract/admin-operations.test.ts` 撰寫管理批准／角色／綁定／安全列表與非管理員拒絕、稽核不可改測試。【來源 R09；依 T015】
- [ ] T077 [US9] 在 `apps/web/src/server/admin/accounts-bindings.ts` 實作具名批准／角色／綁定操作與每次即時授權、舊新值／操作者／時間稽核，停用中不給新綁定權限。【來源 R09；依 T076、T018、T022、T072】
- [ ] T078 [US9] 在 `apps/web/src/app/(admin)/admin/page.tsx`、`apps/web/src/app/(admin)/admin/audit/page.tsx` 整合申請／角色／綁定／帳號／安全事件／用量／個資請求入口與稽核篩選，僅依真實權限顯示。【來源 R09；依 T077、T036】
- [ ] T079 [US9] 在 `tests/e2e/admin-audit.spec.ts` 執行管理變更保存重讀／拒絕稽核，額度與生命週期後續分別由 T113／T106 完整重驗。【來源 R09；依 T078】

## Phase 14：US10 Skill 交接與續談（P2；4 項）

**目標／獨立測試**：實際脈絡摘要可改／確認／取消；撤權引用被排除且可見，重開還原最後 Skill，無靜默草稿遺失。

- [ ] T080 [P] [US10] 在 `tests/contract/skill-handoff.test.ts` 撰寫 H-7 確認時撤權／取消／最後 Skill 與外部提示注入不得提升權限測試。【來源 R10；依 T015】
- [ ] T081 [US10] 在 `apps/web/src/server/skills/handoff.ts`、`supabase/migrations/0013_handoffs.sql` 建立當前脈絡可編輯摘要、引用重新授權與 excluded_refs、last_skill 交易，取消不變更原狀態。【來源 R10；依 T080、T043、T045、T051、T039】
- [ ] T082 [US10] 在 `apps/web/src/components/chat/skill-handoff.tsx` 實作目標／需求／引用／階段／未決摘要確認取消及待取得來源提示，不冒稱具完整未授權指引。【來源 R10；依 T081；前置 Q-TL】
- [ ] T083 [US10] 在 `tests/e2e/skill-handoff.spec.ts` 執行 V-21 的交接／草稿延伸、撤權引用／續談／最後 Skill 與提示注入，S-11 IME 一併回歸。【來源 R10；依 T082、T049】

## Phase 15：US7 提交審查與版本部署（P2；7 項）

**目標／獨立測試**：v1 申請後改 v2，教師仍審 v1，僅 v1 可部署；未確認分享風險／未完成個資與作品 AI 檢查不得批准；失敗保舊公開版。

- [ ] T084 [P] [US7] 在 `tests/contract/deploy-review.test.ts` 撰寫 R-1～7、不可變雜湊／七狀態／退回與部署 unknown、分享提示／PII／runtime_ai_review 缺漏拒絕測試。【來源 R07；依 T015】
- [ ] T085 [US7] 在 `supabase/migrations/0014_deploy_requests.sql`、`apps/web/src/server/publishing/review.ts` 建立申請快照／學生確認／PII 與 AI 人工檢核、批准／退回保存及 D-03 核定轉移，未決不開始部署。【來源 R07；依 T084、T068、T072；前置 Q-SCHOOL】
- [ ] T086 [US7] 在 `apps/web/src/app/(student)/projects/[id]/publish/page.tsx`、`apps/web/src/app/(teacher)/reviews/[id]/page.tsx` 實作尚未提交至失敗完整狀態、申請版藍圖／變更／測試／回饋與風險提示，退回理由重讀。【來源 R07；依 T085】
- [ ] T087 [US7] 在 `apps/web/src/server/publishing/review-preview.ts` 以 submission 產物與 A1 簽發審查預覽，禁止取目前工作版，審查結束／撤回後撤銷而不污染公開資料。【來源 R07、R14；依 T085、T063；前置 Q-A12223】
- [ ] T088 [US7] 在 `apps/worker/src/jobs/deploy.ts` 實作批准雜湊重驗、分類資格／runtime_ai_review 阻擋、建置上傳核對與 unknown 重試；成功才切換公開指標，失敗保舊版且無成功網址。【來源 R07、R14；依 T087、T060、T095】
- [ ] T089 [US7] 在 `apps/works-edge/src/public/serve.ts` 實作單作品 origin／noindex／不列目錄、平台 CSP／保留路由、live 狀態及停止頁；授權外資源不可經產物直連繞過。【來源 R07；依 T088、T013；前置 Q-X20、Q-HOST】
- [ ] T090 [US7] 在 `tests/e2e/publishing.spec.ts` 執行 V-25～29／54、S-07 跨區下架與 S-10 origin／PSL 驗證，覆蓋學生撤回／教師管理員下架／學校撤回／停用／刪除與恢復不自動公開。【來源 R07；依 T089、T099、T106；前置 Q-HOST、Q-SCHOOL】

## Phase 16：US14 A／合格 B、B2 資料授權與範圍限制（P2；9 項）

**目標／獨立測試**：合成靜態 A、Work Data B 可依流程使用；訪客識別／學生伺服器／作品 AI 分別阻擋，B2 任何無效／更新失敗／超配額均無資料取得或修改。

- [ ] T091 [P] [US14] 在 `tests/contract/work-data.test.ts` 撰寫 V-28／51～57、A1 與 B2 區別／授權更新故障／逐請求 live／撤銷／key id／配額邊界與並行競爭測試。【來源 R14；依 T015】
- [ ] T092 [US14] 在 `supabase/migrations/0015_work_data.sql`、`apps/web/src/server/works/data-rpc.ts` 建立受限固定資料操作／儲存及原子計數、公開 listing 與 A1 每會話命名空間隔離、會話終止清理及保存政策；未核定即拒絕所有資料請求。【來源 R14；依 T091、T063；前置 Q-B226、Q-DATA】
- [ ] T093 [US14] 在 `apps/web/src/server/works/grants.ts`、`packages/core/contracts/work-grant.ts` 以核定標準實作簽署單作品／用途／exp／授權 id／revocation_version，平台受保護私鑰不交 edge，發布驗章公鑰與 key id。【來源 R14；依 T092；前置 Q-B227】
- [ ] T094 [US14] 在 `apps/works-edge/src/data/forward.ts`、`apps/web/src/server/works/authorize-data.ts` 串同源 `/_work/data/v1/*`，不轉送平台／學生 cookie，edge 驗章後平台仍每請求驗 live／用途／期限／撤銷版本／配額限流，A1 預覽另驗有效會話。【來源 R14；依 T093】
- [ ] T095 [US14] 在 `packages/core/policy/work-eligibility.ts`、`apps/web/src/server/publishing/eligibility.ts` 實作 A／合格 B、訪客識別阻擋及 `student_server_runtime_not_in_mvp`，預覽／提交／重試／部署皆重驗，不建立 β2 runtime。【來源 R14；依 T091、T051】
- [ ] T096 [US14] 在 `apps/web/src/server/works/key-rotation.ts`、`apps/works-edge/src/data/keyset.ts` 實作 key id 發布、核定重疊期／舊 key 退場、緊急撤銷與授權更新；平台不可達／更新失敗／未知 key 一律拒絕，不用過期或其他作品授權。【來源 R14；依 T094；前置 Q-B227】
- [ ] T097 [US14] 在 `apps/web/src/components/project/work-limitations.tsx`、`packages/core/skills/work-data-template.ts` 統一藍圖／Agent／預覽／發布／指南限制與同源資料範本；可保存學生伺服器設計檔案但不可執行，不把平台 AI 製作標 C。【來源 R14；依 T095、T039、T065】
- [ ] T098 [US14] 在 `tests/security/no-runtime-ai.test.ts` 建立 Agent／產物／公開／瀏覽器 CSP／路徑繞道與無 AI 金鑰注入測試，覆蓋 V-31／52～54；掃描僅輔助、不可代人工審查，無 HMR 成功要求。【來源 R14、R05；依 T096、T097、T058、T013】
- [ ] T099 [US14] 在 `tests/e2e/work-data.spec.ts` 執行 T091／T098、資料隔離／每請求拒絕與費用歸基礎設施池，記錄 edge 持多個有效作品授權的殘餘風險，不冒稱完全防跨作品；正式輪替矩陣交 T131。【來源 R14、R11；依 T098、T113；前置 Q-B226、Q-B227】

## Phase 17：US16 帳號停用、恢復與清除（P2；7 項）

**目標／獨立測試**：有綁定、作品與待審的合成帳號，停用凍結、恢復不復綁／公開；二次確認後才刪除，清除失敗仍拒絕，還原不復現已刪資料。

- [ ] T100 [P] [US16] 在 `tests/contract/account-lifecycle.test.ts` 撰寫 C-1～8、凍結／綁定快照、恢復一次確認、刪除二次確認／影響改變、清除故障與無天數自動刪除測試。【來源 R16；依 T015】
- [ ] T101 [US16] 在 `supabase/migrations/0016_account_lifecycle.sql`、`apps/web/src/server/accounts/disable.ts` 實作停用交易、綁定快照、立即 gate／session 資料層拒絕、暫停申請／取消工作與停止所有公開作品。【來源 R16；依 T100、T028、T077、T063、T085】
- [ ] T102 [US16] 在 `apps/web/src/server/accounts/restore-delete.ts` 實作恢復影響摘要一次確認、不復綁／公開，以及刪除影響 hash 二次確認、標記即拒絕及申請失效，狀態變動要求重確認。【來源 R16；依 T101】
- [ ] T103 [US16] 在 `apps/worker/src/jobs/purge-account.ts`、`apps/worker/src/jobs/retention.ts` 依核定政策逐步清主資料／Storage／產物與會話／Auth／稽核對照／其他可識別資源引用，記錄失敗重試，不按停用天數自動刪除。【來源 R16；依 T102、T092；前置 Q-DATA】
- [ ] T104 [US16] 在 `apps/web/src/app/(admin)/admin/accounts/[id]/lifecycle/page.tsx` 顯示停用／恢復摘要、二次刪除／確認過期與 purge 狀態／重試、停用定檢清單，不宣稱完全匿名或已清除未完成步驟。【來源 R16；依 T103】
- [ ] T105 [US16] 在 `apps/worker/src/admin/restore-backup.ts`、`specs/001-app-planet-platform/quickstart.md` 實作／記錄 S-08 還原後重套 tombstone，揭露 DB 備份不含 Storage、自然輪替窗口／PITR 未核定風險。【來源 R16、R19；依 T103；前置 Q-DATA、Q-HOST】
- [ ] T106 [US16] 在 `tests/e2e/account-lifecycle.spec.ts` 執行 V-13～18、停用後舊 JWT／後續背景拒絕、確認操作、清除失敗／重試／還原不復現，公開延遲交 T090 以核定值驗收。【來源 R16；依 T104、T105】

## Phase 18：US11 用量、額度與預算治理（P3；7 項）

**目標／獨立測試**：並行／重試無超額或重扣；未知顯未知；Taipei 換期、用途歸池及管理調整不回溯、無公開池挪用。

- [ ] T107 [P] [US11] 在 `tests/contract/usage-budget.test.ts` 撰寫 V-37～42、並行／重試／unknown、Taipei 日月邊界、調整只對後續與用途拒絕測試。【來源 R11；依 T015】
- [ ] T108 [US11] 在 `packages/core/pricing/model-prices.ts`、`supabase/migrations/0017_budget_policies.sql` 建立核定日額度／頻率／並行／管理員測試政策及有來源日期的價格資料，不猜價、不動公開 AI 池。【來源 R11；依 T107、T009；前置 Q-BUDGET】
- [ ] T109 [US11] 在 `apps/worker/src/jobs/reconcile-usage.ts` 完整接供應商實際 usage／Costs 核對 unknown、保留預留至確定、冪等結算，差異告警依核定 PP-06，不宣稱跨供應商硬上限。【來源 R11；依 T108、T010】
- [ ] T110 [US11] 在 `apps/web/src/server/budget/adjust.ts` 實作 B-1～3 僅管理員、舊新值／理由／時間稽核，個別及管理員測試額度調整不回溯預留。【來源 R11；依 T109、T077】
- [ ] T111 [US11] 在 `apps/web/src/components/usage-energy.tsx`、`apps/web/src/app/(admin)/admin/budget/page.tsx` 顯示真實用量／預留／期間／未知、不同超限原因及管理員測試歸池，無金額排行榜或催消耗。【來源 R11；依 T110】
- [ ] T112 [US11] 在 `apps/web/src/server/budget/infra-monitor.ts`、`apps/web/src/app/(admin)/admin/infra/page.tsx` 分開監測託管／資料庫／沙箱／Worker／Work Data 非 AI 費用；規劃值不是可用額度，無未核定自動限制或跨池抵銷。【來源 R11；依 T111；前置 Q-BUDGET】
- [ ] T113 [US11] 在 `tests/e2e/usage-budget.spec.ts` 執行 V-37～42／管理員用途與換期、並行重扣及閘門前零預留測試，已保存內容仍可讀寫，S-04／15 正式成本留 T130。【來源 R11；依 T112】

## Phase 19：US12 響應式、鍵盤與語言（P3；5 項）

**目標／獨立測試**：寬窄畫面僅鍵盤完成登入→對話→編輯→提交，對比符合 Spec，焦點／Esc／讀屏狀態可辨。

- [ ] T114 [P] [US12] 在 `tests/e2e/accessibility.spec.ts` 撰寫主要流程鍵盤／可取消彈窗 Esc／焦點回復／具名圖示／狀態朗讀與寬窄導覽測試。【來源 R12；依 T015】
- [ ] T115 [US12] 在 `apps/web/src/components/responsive-workspace.tsx` 實作可收合切換對話／程式／預覽與放大、窄畫面 Skills／專案／檔案庫／帳號入口，不硬擠三欄或隱藏工具。【來源 R12；依 T114、T065、T048】
- [ ] T116 [US12] 在 `apps/web/src/styles/tokens.css`、`apps/web/src/components/accessible-dialog.tsx` 依核定視覺方案修正正常／hover／focus／disabled 配色與焦點、4.5:1／3:1 對比，品牌與學生作品樣式分離，不照抄不合格參照色。【來源 R12；依 T115；前置教育者設計定案，來源 UX §3】
- [ ] T117 [US12] 在 `apps/web/src/components/operation-state.tsx`、`apps/web/src/components/ide/preview-panel.tsx` 完整標記進度／錯誤／不支援 cookie／舊版為可讀繁中與非顏色提示，文字須經適用審閱。【來源 R12；依 T116、T036】
- [ ] T118 [US12] 在 `tests/e2e/accessibility.spec.ts` 執行鍵盤／IME／焦點／對比與人工輔助工具驗證，列出目標版本與人工待確認，不將本機瀏覽器結果當 §0.1①正式驗收。【來源 R12；依 T117、T086；前置 Q-BROWSER】

## Phase 20：US18 帳號與作品複查（P3；4 項）

**目標／獨立測試**：拒絕者／發起教師／停用時綁定教師／有效作品擁有者分別提出；每處置一件未結，跨對象拒絕，回覆不自動恢復任何權限。

- [ ] T119 [P] [US18] 在 `tests/contract/review-requests.test.ts` 撰寫被拒／凍結教師資格、單一未結競態／跨對象／限長頻率及不自動恢復測試。【來源 R18；依 T015】
- [ ] T120 [US18] 在 `supabase/migrations/0018_review_requests.sql`、`apps/web/src/server/review-requests.ts` 建立唯一未結索引／受限 RPC／每次資格與對象核對、回覆保存，學校撤回／刪除後資格依核定而非預設。【來源 R18；依 T119、T101、T085；前置 Q-DATA、Q-SCHOOL】
- [ ] T121 [US18] 在 `apps/web/src/components/account-review.tsx`、`apps/web/src/components/project/work-review.tsx` 建立拒絕結果／教師受限入口及發布頁版本複查，停用學生無入口，受限教師只看申請與回覆。【來源 R18；依 T120】
- [ ] T122 [US18] 在 `tests/e2e/review-requests.spec.ts` 執行 V-14／19／單一未結競態、停用前已解除與停用後教師拒絕、回覆重讀與無自動恢復。【來源 R18；依 T121】

## Phase 21：US19 個資請求受理（P3；4 項）

**目標／獨立測試**：學生兩管道／教師自提／不能登入者的合成請求可記錄，提出不刪除；核對及與學校確認後回覆，和複查完全分開。

- [ ] T123 [P] [US19] 在 `tests/contract/privacy-requests.test.ts` 撰寫 P-1～4、四管道／凍結教師拒絕／教師僅見自身／無自動刪除與分開入口測試。【來源 R19；依 T015】
- [ ] T124 [US19] 在 `supabase/migrations/0019_privacy_requests.sql`、`apps/web/src/server/privacy-requests.ts` 建立最小請求／提出者與處理權限核對／學校確認／回覆及稽核，刪除帳號只能轉既有二次確認流程；其他資料處理未決則不執行。【來源 R19；依 T123、T102、T120；前置 Q-DATA】
- [ ] T125 [US19] 在 `apps/web/src/app/(admin)/admin/privacy/page.tsx`、`apps/web/src/components/privacy-request.tsx` 實作管理記錄／教師自提／核定代提入口及自身回覆，無法登入者沿學校管道由管理員記錄，不擴大教師管理權限。【來源 R19；依 T124】
- [ ] T126 [US19] 在 `tests/e2e/privacy-requests.spec.ts` 執行 V-20／權限與核對／不自動刪除／與複查分離，保存期限與時限未核定不判該指標通過。【來源 R19；依 T125、T122；前置 Q-DATA】

## Phase 22：Polish 與跨故事正式驗證（P6；10 項）

**正式測試共同前置**：相關故事實作及其測試完成、§0.1 的執行方案／樣本量經教育者核定、正式測試環境與資源另獲授權。每項保存原始值及失敗，不只成功彙總。

- [ ] T127 在 `tests/e2e/formal-preview-browser.spec.ts`、`specs/001-app-planet-platform/quickstart.md` 執行矩陣①：正式萬用字元 TLS／不同可註冊網域、核定瀏覽器版本／學校裝置／cookie 隱私組合、A1／CSP／放大／鍵盤／同源資料，逐格保存去敏證據與實收 N。【來源 R05、R12、R14；依 T066、T099、T118；前置 Q-BROWSER、Q-HOST、矩陣①樣本核定】
- [ ] T128 在 `tests/security/formal-preview-revocation.test.ts`、`specs/001-app-planet-platform/quickstart.md` 執行矩陣②：撤銷／自然到期×角色×跨區／PoP／快取狀態×所有資源，以交易提交／expires_at 到持續拒絕量測上界，含故障拒絕／時間誤差，不以 sandbox delete 返回代替。【來源 R05、R08、R14、R16；依 T127、T106、T075、T090；前置 Q-A12223、矩陣②樣本核定】
- [ ] T129 在 `tests/e2e/formal-preview-peak.spec.ts`、`specs/001-app-planet-platform/quickstart.md` 執行矩陣③：20 人各冷暖×大小×A／B／控制面背景負載，逐段及端到端 p50／p95／max、排隊／429／錯誤率分母與取消亂序證據，全部提交計數。【來源 R05、R11、R14；依 T127、T128；前置 Q-X20、Q-X21、Q-PEAK、Q-HOST】
- [ ] T130 在 `tests/contract/formal-cost-reconciliation.test.ts`、`specs/001-app-planet-platform/research.md` 以 T129 批次前後用量／入帳重建 S-04／15／V-42 三情境及每生／課堂單位成本，記錄抵扣／牌價／實付差別，對照核定費用門檻，不外推試用 Team、不挪池。【來源 R11、R05；依 T129、T113；前置 Q-BUDGET、Q-PEAK】
- [ ] T131 在 `tests/security/formal-work-data-rotation.test.ts`、`specs/001-app-planet-platform/quickstart.md` 執行矩陣④：B2 更新失敗／平台不可達／逐請求拒絕／陳舊 live／跨用途作品／到期撤銷／key id 輪替緊急撤銷／配額競態，驗前後資料雜湊及無效零讀寫，記錄 edge 多有效授權殘餘風險。【來源 R14、R11；依 T128、T099、T130；前置 Q-B226、Q-B227、矩陣④樣本核定】
- [ ] T132 在 `tests/e2e/full-mvp.spec.ts`、`specs/001-app-planet-platform/quickstart.md` 執行 19 故事串接完整 A／合格 B 旅程、權限／學生安全／資料與版本／配額／保存故障、惡意產物與無作品 AI 回歸，全部用合成資料，記錄 not_run／needs_human，不降低範圍以換通過。【來源 R00～R19；依 T020、T025、T030、T037、T041、T049、T055、T066、T070、T075、T079、T083、T090、T099、T106、T113、T118、T122、T126、T131】
- [ ] T133 在 `specs/001-app-planet-platform/quickstart.md`、`specs/001-app-planet-platform/plan.md` 匯總四矩陣逐格結果／原始證據索引、樣本缺失、核定值／實際值與剩餘阻擋；未核定只報值，未執行不勾通過，VC／本機／試用數據另列研究。【來源 R00、R05、R14；依 T132、T130；前置 Q-PEAK】
- [ ] T134 在 `specs/001-app-planet-platform/quickstart.md`、`specs/001-app-planet-platform/decision-register.md` 完成去敏營運手冊：權限撤銷／key 輪替事件／費用 unknown／清除失敗重試／備份還原／值守交接、S-08／09／14 與所有 TL 證據責任，未取得保持阻擋。【來源 R00、R11、R16、R17、R19；依 T133、T105、T037、T126；前置 Q-TL、Q-DATA】
- [ ] T135 在 `specs/001-app-planet-platform/analysis-report.md` 於後續實作結果回填後重跑跨文件覆蓋／依賴／憲章／單一 MVP Gate 分析及最小既有 lint／typecheck／測試驗證，記錄實際命令、失敗與人工待確認，不改 checklist 求通過。【來源 R00；依 T134】
- [ ] T136 在 `specs/001-app-planet-platform/plan.md` 提交完整現行 MVP 的單一產品驗收／上線審閱證據包；另核對既有 Readiness 與階段授權引用，所有必要未就緒＝整體未就緒，請教育者明確決定，不把這項當第二個 Readiness Gate 或自動上線批准。【來源 R00、R14；依 T135；前置全部適用 Q／TL 核定與正式證據】

## 依賴圖與執行順序

```text
G0（既有治理／另行階段授權，不在本次執行）
 └─ T001～T005 → T006～T015（共用基礎）
     ├─ US1 → US13 → US15
     ├─ US17 → US3 ─────────────┐
     ├─ US2來源／首頁 → US4 → US5（X／A1）↔ US6（見下列無循環依賴）
     ├─ US8 → US9 → US11
     └─ US10／US7／US14／US16／US12／US18／US19
          （跨故事前置以逐項「依」為準）
全故事完成 → 四類正式矩陣／成本與全程回歸 → 證據收斂 → 人工產品／上線審閱
```

圖中 US5／US6 是交錯實作而非任務環：先 US4 T051→US6 T068（亦依本故事 T067），再 US5 T057～T058；之後 US6 T069～T070，US5 T066 最後依 T070。US14 T095 的資格政策先於 US5 T060 排建置。US7／US14／US16 亦為前段解耦後整合：T085→T101→T103→T106；T095 可獨立於部署實作→T088→T089；T099→T090，沒有先依賴整個故事結案的循環。

### 故事完成所需的直接跨故事依賴

| 故事 | 直接跨故事先決（同故事序列與全域 T015 不重列） |
| --- | --- |
| US1 | 無；Q-AUTH 仍必要 |
| US13 | T010 共用工作 runner |
| US15 | US1 T018、US13 T022 |
| US17 | 共用 T009／T012；真實學生入口另由 US3 整合 |
| US2 | US1 T019、US13 T024；正式對話結案需 US3 T049 |
| US3 | US17 T033／T037 |
| US4 | US2 T039（來源，不依首頁結案） |
| US5 | US4 T051／T055、US17 T035、US6 T068／T070、US14 T095 |
| US6 | US4 T051、US5 T058 |
| US8 | US4 T051、US3 T043 |
| US9 | US1 T018、US13 T022、US8 T072、US17 T036 |
| US10 | US3 T043／T045／T049、US4 T051、US2 T039 |
| US7 | US6 T068、US8 T072、US5 T060／T063、US14 T095／T099、US16 T106 |
| US14 | US5 T058／T063／T065、US4 T051、US2 T039、US11 T113 |
| US16 | US15 T028、US9 T077、US5 T063、US7 T085、US14 T092 |
| US11 | US9 T077 |
| US12 | US5 T065、US3 T048、US17 T036、US7 T086 |
| US18 | US16 T101、US7 T085 |
| US19 | US16 T102、US18 T120／T122 |

所有後向數字引用都表示真正依賴，不能僅照文件行序連續跑：例如先 US11 T113 再 US14 T099，再完成 US7 T090。這不改變 P1→P2→P3 的優先規劃；P3 中被 P2 必需的共用能力可提前完成，**不減少任何故事或放行 Gate**。

### 平行機會與逐故事例子

所有 `[P]` 任務僅撰寫各自不同檔案的測試，**T015 完成且該任務 Q 前置已滿足後**才可並行；未標 `[P]` 的相關實作須依其「依」完成，不以多代理覆寫同檔。

| 故事 | 平行例（各自來源如上；不代表本次執行） |
| --- | --- |
| US1／US13／US15／US17 | T016、T021、T026、T031 可同批寫四個獨立契約測試；Q-AUTH 未滿足時 T026 留阻擋 |
| US2／US3／US4 | T038、T042、T050 可同批定義首頁、工具、階段測試；之後依來源／安全依賴分流 |
| US5／US6 | T056 與 T067 可平行；實作必須按 T068→T057→T058→T069→T070→T066，不可用故事結案相互等待 |
| US8／US9／US10 | T071、T076、T080 可同批寫教師／管理／交接測試；T077 須等 T072 |
| US7／US14／US16 | T084、T091、T100 可同批寫契約測試；部署、資料與清除依上述交錯圖整合 |
| US11／US12／US18／US19 | T107、T114、T119、T123 可同批寫測試；Q-DATA 未定前不開始清理／受限申請實作 |

## 交付策略與完成定義

1. 先完成治理前置／共用基礎，按故事優先度提供可獨立測試增量；來源、安全、預算與資料授權需先具備，不以 mocked UI 冒充成品。
2. US1 是最早可驗證增量，**不是可縮減交付的 MVP**。所有 19 故事（含 P3）、A1／B2／X、四類正式矩陣與既有上線條件皆必要；後續 β2 自有 feature／Gate，不加入此清單。
3. Readiness 是實作前的完整 MVP **單一**治理結論；產品驗證是在另授權實作／環境後依計畫執行。缺 Gate 前實測條件時先回報未就緒，另取限縮研究批准，不造成「先實作才取得實作批准」的循環。
4. 全部任務有可定位輸出與直接來源／依賴；結案須執行對應測試、保存證據與同步文件，**產出測試檔或品質 checklist 全勾均不算產品通過**。未知政策保持待核定，測試 not_run／needs_human 如實保留。
5. 本次只有 Tasks 起草與 Analyze 授權；不執行上述任何任務、不安裝依賴、不建立付費資源、不讀密鑰、不 commit／push。
