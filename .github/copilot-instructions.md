# AI APP 超級創客｜App Planet — Copilot 專案指引

## 產品範圍

- 產品：**AI APP 超級創客｜App Planet**，面向 G4–6 的教育 AI Chatbot＋Web App 創作平台。
- 品牌標語：**Chat. Create. Launch.**
- 僅納入本產品已批准的規劃與修改；不得混入其他成人版、Roblox／原生行動版或其他專案的點數、規格與資產。
- 不自行更換已批准的技術棧；若發現差異，先列出具體衝突與影響，交由教育者決定。

## 繁體中文交付政策

- 所有溝通、規格、治理、設計、計畫、任務、README、檢查清單、分析、驗證及使用者介面，預設使用**繁體中文**。
- 例外：程式語法、識別字、API／設定鍵（config keys）、CLI 指令、檔案路徑，以及必要的正式技術名詞，維持原文。
- 指定品牌 **App Planet** 與 **Chat. Create. Launch.** 保留英文，不翻譯。

## 授權與階段門檻

- Checkpoint／完整 MVP Readiness Gate 尚未通過，教育者正式審議／簽核尚未執行。Tasks、Analyze 與適用的完整 Gate 仍須依序完成；通過 Gate 仍不等於取得實作授權。
- 一般產品實作、服務接通、建立資源及上線，仍須符合原有 G0、適用 Gate、前置條件，並取得教育者對該階段的明確批准。
- 已完成的歷史本機階段依 [readiness-review.md](../specs/001-app-planet-platform/readiness-review.md) 記錄：§17（本機基礎功能）、§19～§21、§24（schema／純函式／合成測試）、§25（schema 限制核對與本指引同步）、§26（審閱後最小修復）均已結束，不再提供授權；§27（2026-10-23）僅為文件的待決方案補齊與正文複核。§28（2026-10-23）依教育者明確批准，限定登錄並同步 D-06 (a)／M1／R-a、UTC 選項 A、SSE 專屬錯誤登錄（S1-A、成因區分、`error`→`failed`）的文件，並僅實作該節列明的本機純函式／schema／合成測試子集（帳號層帳號準備政策、SSE 專屬登錄與事件序列、`error`→訊息狀態映射、UTC 合成驗證）；不建立 migration、資料表、RLS、端點或任何服務，M1 僅為模型，真實登入／核發／歸屬操作維持關閉。D-14（含 S4）、PP、`handle`／`note_for_user`、管理員補發、完整非學生角色矩陣仍待決。§29（2026-10-23）限 SSE 本機映射修復，已結束，不提供後續授權。§30（2026-10-23）依本 session 教育者明確批准，僅授權本機 T095 作品範圍資格純函式、必要型別／公開匯出、合成測試與文件／驗證；T095 部分範圍，T091／T015 僅本輪涉及子集，原依賴未變，服務端資格、預覽／建置／資料／發布仍未實作。各階段只涵蓋其紀錄列明的本機子集，不代表 Gate 通過或一般產品工作獲准；§30 不是常設許可。
- 歷史階段批准不構成持續開放所有本機工作，§26～§30、§33 也不是常設例外；新增或延伸範圍不得只援引過往批准，須另有對應的明確階段授權，且不得繞過適用 Gate 與前置條件。
- 2026-10-23 本 session 另行明確批准的 SSE 最小修復見 [readiness-review.md](../specs/001-app-planet-platform/readiness-review.md) §29（補充上列已完成的 §28）：只限制本機 `deriveMessageState` 對含 block／support 的有效歷史回未支援映射，補合成回歸與必要文件，不擴充完整映射或對外錯誤碼。僅 T006／T015 部分範圍，任務不結案；所有真實功能仍關閉，Checkpoint／完整 Gate 未通過、正式審議／簽核未執行。§29 只適用本輪，不是常設本機開發許可。
- 2026-10-23 本 session 另行明確批准的 T007／T008 本機資料與授權子集見 [readiness-review.md](../specs/001-app-planet-platform/readiness-review.md) §33：僅依現行模型建立隔離本機 migration／RLS 與合成測試來源；不部署、不接 Auth／Route Handler、不使用真實資料。T007／T008／T015 均僅部分範圍且仍未勾選；Docker daemon 不可用，真實 PostgreSQL RLS 測試未執行；依賴／Q-SCHOOL、Checkpoint／完整 Gate 及正式審議狀態不變。§33 不是常設本機開發許可。
- 2026-10-24 本 session 明確批准的 T052 有界本機純函式子集見 [readiness-review.md](../specs/001-app-planet-platform/readiness-review.md) §47：只判斷九步旅程的明文證據／A-B 範圍，未定完成規則須 unsupported；T052 部分成果，T050／T015、T006 僅本輪涉及子集，T051 原依賴未變且不宣稱已滿足。無階段推進、服務／資料／UI／操作授權；Gate 與正式簽核狀態不變。§47 不是常設許可。
- 2026-10-24 本 session 另行明確批准的 T052 審閱缺陷 F-01／F-02 最小修復見 [readiness-review.md](../specs/001-app-planet-platform/readiness-review.md) §48：只補本機確認 evidence 的 project／tier／visitor 結構關聯並隔離 `unresolved_decisions` 共用陣列；T052、T050／T015、T006 僅本輪子集，T051 原依賴保留。無 DB／server／resolver／交易／HTTP／UI／階段推進／操作授權；輸入欄位關聯不證明來源、身分或 DB 現況。Gate／正式簽核及真實功能狀態不變；§48 不是常設許可。
- 2026-10-24 本 session 最新一次性授權見 [readiness-review.md](../specs/001-app-planet-platform/readiness-review.md) §49：僅創作旅程唯讀評估 server、同一 PostgreSQL statement snapshot 的證據組合、必要純函式整合及本機隔離 DB 回歸。T052／T051 與 T050／T015、T006／T008／T004 均僅本輪列明子集，T052→T051 原依賴保留；136 條任務正文／依賴／勾選不變。無 HTTP／UI／真實 Auth、寫入、階段推進、操作授權或常設許可；Checkpoint／完整 Gate 與正式簽核狀態不變。
- 2026-10-24 本 session 明確批准的 T054 F-01／F-02 最小修復見 [readiness-review.md](../specs/001-app-planet-platform/readiness-review.md) §52：僅修正取消／取代切換意圖後舊保存回應誤切換，以及 conflict 本文未沿用 strict `stageDraftContentSchema`；補本機 deferred-promise／合成回歸及必要模擬頁呼叫端。T054／T050／T015／T006 僅本輪實際涉及子集，原任務／依賴／未勾選狀態不變；不撤銷已送保存、不接真實保存或 DB／server／runner。Checkpoint／完整 Gate 未通過、正式簽核未執行，真實功能仍關閉；§52 為單批一次性授權，不是常設許可。
- 2026-10-24 本 session 最新一次性授權見 [readiness-review.md](../specs/001-app-planet-platform/readiness-review.md) §53：只允許 T054 保存控制器經 `tests/integration` 測試橋接至既有 server 與隔離 PostgreSQL，並驗證 COMMIT／response loss／冪等 replay、版本／切換競態及現有授權邊界。T051／T050／T015、T006／T008／T004 僅本輪列明部分，原依賴與 136 項任務未勾選狀態不變。無產品匯入路徑、HTTP／Server Action／真實 Auth／UI 保存或正式功能授權；Gate／簽核狀態不變，§53 非常設許可。
- 不得虛稱完成未執行的動作；回報時須區分「已驗證」與「尚未執行」。

## 專案保護

- 保留 `.git/`、`.github/`、`.specify/`、`.vscode/`、`specs/`、未提交修改與既有任務狀態。
- 不執行破壞性 scaffold；不重設、清空、覆蓋或重新初始化既有專案。
- 目前功能目錄不得由 Git 分支名稱推斷；一律以 `.specify/feature.json` 的 `feature_directory` 或環境變數 `SPECIFY_FEATURE_DIRECTORY` 為準，並在動工前核對。

## 密鑰與安全

- 不讀出、不提交密鑰（API keys、tokens、`.env` 內容）。
- 密鑰不得出現在前端程式、學生作品、文件或日誌；僅能存在於伺服器端的安全設定。
- 學生為 G4–6 兒童：不得在紀錄或文件中保存可識別個人身分的資料。
