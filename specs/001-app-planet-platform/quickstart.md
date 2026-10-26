# 快速驗證指南（Quickstart）：AI APP 超級創客｜App Planet 平台首版

### §80 真實本機 Auth、產品路由與頁面驗收（一次性本機子集）

Node 24、Docker／Supabase CLI 及 Microsoft Edge 可用時，由專案根目錄執行：

```powershell
npm run test:auth:local
npm run test:foundations
```

第一個命令建立唯一隔離 Supabase Auth／PostgreSQL stack、合成帳號與 session，套用原 migrations，執行真實 Next Route Handler 整合及 HTTPS Edge 頁面流程，最後清理 stack。只重跑瀏覽器層可用 `npm run test:auth:local -- -BrowserOnly`；它仍會建立／清理同一隔離 stack。原生 Auth email password provider 僅在此測試 stack 開啟，top-level signup 仍關閉；匿名 signup 實測 HTTP 422。瀏覽器測試由 setup 透過原生 Auth 建立 session，並非 A-1 產品登入碼 UI；不代表正式 issuer／TTL／scope 決策或產品啟用。Auth `/user` 只證明當次 access-token 驗證結果，不證明所有 session 條件、最大撤銷窗口或在途操作均已終結。

草稿與 Job 路由及差異、真實驗收結果與任務缺口見 [readiness §80](./readiness-review.md)。工作狀態取消實作回 202，但 G-3 契約目前寫 200；此規格差異未由測試替政策決定。

### §79 階段草稿首建 HTTP 驗收（D-33；本機限定）

現行契約見 [COMMON D-33](./contracts/README.md#階段草稿首次-http-保存補充d-33僅-p-3-未確認草稿子集) 與 [P-3](./contracts/projects-agent-sandbox.md)：首次 `If-None-Match: *`（DB null）→201／版本 0／Location／ETag；更新 `If-Match: "n"`→200／n+1；原鍵原意圖重放→200／原 receipt＋current（非再建／412）；新鍵首建已存在→412。缺前置／非法為端點專用 400，版本衝突仍 409，同鍵異意圖 422；不得把 null 當成 0。其他端點錯誤規則不改。

重現受影響案例及完整回歸（每層硬 timeout，合成資料）：

```powershell
node scripts\bounded.mjs 180 first-save-unit node node_modules\vitest\vitest.mjs run tests\unit\http-save-adapter.test.ts tests\unit\operation-presentation.test.ts tests\contract\stage-draft-save-controller.test.ts
node scripts\bounded.mjs 900 first-save-http-db powershell -NoProfile -ExecutionPolicy Bypass -File scripts\pgtap-local.ps1 -Scenario Usage
node scripts\bounded.mjs 1200 first-save-foundations cmd /d /c npm run test:foundations
```

Edge 真實 React→fetch→共用 handler→隔離 PostgreSQL 覆蓋無初稿／空稿首建、保存期間續編、雙視窗首建碰撞、412 保留與明確重新載入／Radix 比對、COMMIT 後丟回應原鍵重試、原 receipt／較新 current 分離、畸形 201／replay、失權隱藏資料；不以 mock／page.route.fulfill 取代成功流程。fixture 先以 DB owner/read gate 確認合法專案，沒有草稿回 null，不合成版本 0。重讀僅測試宿主 callback，未新增產品 GET 或測試登入。無 migration，既有 0012 不改；模型無矛盾故 data-model 不改。實際 exit／分層數／清理與來源保護見 [readiness §79](./readiness-review.md)。

§79 當時正式 principal／Next Route Handler／Auth 仍關閉；本狀態已由後續 §80 有界子集更新。Agent 成功 result 仍 unsupported，五欄 receipt 僅 T064／T068 待實作方向，無 run／快照模型。T011／T014／T015 尚未完整結案，原依賴、checklist／G0／Checkpoint／完整 Gate／簽核狀態不變。

### §78 T011／T014／T015 基礎整合回歸（2026-10-26；不啟用產品）

於專案根目錄執行單一命令（Node 24、已安裝 Edge、可用的本機 Docker）：

```powershell
npm run test:foundations
```

依序執行 workspace 相容性、typecheck、production build、unit、contract，以及 `Usage` 隔離 PostgreSQL 情境。最後一層包含 pgTAP、Authorization／Projects／Usage Worker／HTTP foundation 整合和 Edge 真實瀏覽器保存測試；各 layer 失敗會停止並傳遞非零 exit。命令分別列出各 Vitest suite 測試數及 pgTAP assertions，不把 aggregate 與其子測試重複相加。各子命令設有硬 timeout；Usage runner finally 撤銷測試 grant 並清理隔離 Docker 資源。

Edge 測試由測試專用 React/Vite host 載入共用產品 editor 與 fetch adapter；初始草稿透過 harness 專用 fixture transport 與既有 owner/read gate 從隔離 PostgreSQL 讀取，保存則走共用 handler 並寫入同一 DB。測試 server 控制 HttpOnly 合成 session。這不是正式 Next Route Handler、真實 Auth 或產品啟用；server 正式 resolver 仍 fail-closed。§78 當時首次 HTTP 草稿建立語意與 Agent 成功 `result` DTO 尚未完成（首建缺口現依 §79 補齊，Agent 維持 unsupported），不能將此子集視為完整 T011／T014／T015、Gate 或產品驗收通過。詳細狀態及各項數量見 [readiness-review.md §78](./readiness-review.md)；任務維持未勾選，Gate／簽核狀態不變。

### §76 本機費用／Worker 與 Edge 重現入口（不啟用產品）

於專案根目錄執行（Node 24、既有本機 Docker／PostgreSQL 映像、已安裝 Edge）：

```powershell
node scripts\bounded.mjs 900 usage-fresh powershell -NoProfile -ExecutionPolicy Bypass -File scripts\pgtap-local.ps1 -Scenario Usage
node scripts\bounded.mjs 900 usage-upgrade powershell -NoProfile -ExecutionPolicy Bypass -File scripts\pgtap-local.ps1 -Scenario Usage -UsageUpgrade
npm run test:e2e:edge
node scripts\bounded.mjs 120 regression node node_modules\vitest\vitest.mjs run
node scripts\bounded.mjs 180 typecheck cmd /d /c npm run typecheck
$env:NEXT_TELEMETRY_DISABLED='1'
node scripts\bounded.mjs 240 build cmd /d /c npm run build
```

`Usage` 沿用原 runner：全新 DB 依 0001→0002→0003→0009→0010→0011→0012→0020→0021；`UsageUpgrade` 先建原 0001／0002／0009～0012 及六筆歷史資料，再按 0003→0020→0021 順序補 migration，驗證相同授權／Projects／費用／Worker 測試；既有 migration 不搬移、不改寫。0003 只依賴 0001／0002，resource 由可信 adapter 授權，不提早 FK 到 0009；0021 僅在鎖定所需 account／school 欄位授權 `postgres`，不授 runtime role 權限。須由具必要權限的隔離 `supabase_admin` 套用以授出 auth.uid 最小權限，再把表／函式 owner 固定 postgres；不授 authenticated／service_role 新入口。每個 child command 硬上限 180 秒，外層 900 秒；finally 撤權／清理及去敏 run-summary 保留真實失敗／exit。測試 actor 僅隔離 runner 建立／刪除。

`npm run test:e2e:edge` 固定 `msedge`、180 秒硬上限、單 worker；實測 2／2。這是**本機 Microsoft Edge**，不是 Playwright 內建 Chromium 已驗證，也不核定 PP-24 正式矩陣。Edge 啟動的 webServer 有 120 秒 readiness 上限，測試 30 秒上限，結束由 Playwright 清理。`bounded.mjs` 的逾時自測 exit 124，不偽裝成功；預設證據放忽略的 `test-results\batch`，可用 `APP_PLANET_BATCH_EVIDENCE` 指定本批非秘密證據目錄。

政策／金額／provider 全是明示合成 fixture；正式路徑沒有默認 allow gate 或測試 provider。正式政策不能由 reserve caller 傳入數值核准，須受限 DB 設定且有批准引用；尚無正式 loader／Auth／paid provider。無價格、無核定分數 micro 捨入、外部逾時／失聯均保持 unknown；未提供可信核對結論時不提供任意釋放或自動重做入口。完整範圍與缺口見 [tasks](./tasks.md) §76 註記及 [readiness](./readiness-review.md) §76。

**功能目錄**：`specs/001-app-planet-platform`｜**計畫**：[plan.md](./plan.md)｜**資料模型**：[data-model.md](./data-model.md)｜**契約**：[contracts/](./contracts/README.md)｜**待決**：[decision-register.md](./decision-register.md)
**狀態（2026-10-24）**：Plan 已批准作為設計與 Tasks 基線（[D-24](./decision-register.md)），不是產品驗收批准。**正式產品驗證尚未執行**（未建立外部環境、未建立付費資源、未讀取密鑰）。本 session 最新一次性 T054 測試整合子集見 [readiness-review.md](./readiness-review.md) §53；隔離 PostgreSQL Projects runner 已包含 18 個經 controller 測試 adapter 呼叫既有 server 的案例，但不接產品路徑、真實 Auth、瀏覽器或正式功能。§52 F-01／F-02 修復與 §51 控制器／合成模擬為既有成果；§50 是 T053 唯讀合成展示，§49 為 T052／T051 唯讀評估 server／隔離 DB 子集，§47～§48 為保留的純函式／修復子集，§41～§46 均為各自歷史子集，不互代測試結果。G0、學生創作旅程 Checkpoint、完整 MVP Readiness Gate 未通過，正式審議／簽核未執行；一般產品工作與真實功能仍關閉。
**本指南不包含**：真實 Auth／產品資料服務／瀏覽器草稿保存、產品 server 接線、完整 E2E 或部署；readiness §41～§53 都是各自明列的一次性本機子集，不代表一般實作授權。T051／T052／T053／T054 僅部分成果、原依賴不變；不重做 §43～§46 已驗收的分類、草稿與工作區唯讀資料整合。

### T054 §52 F-01／F-02 最小修復（一次性本機子集）

保存操作與切換意圖分離：每個有效新切換要求都更新意圖序號。等待保存期間選「保留並暫不切換」、返回目前資源或選擇其他目標，舊 continuation 回傳 `superseded` 而不啟用舊目標；已送出的 adapter 操作仍依原規則更新其來源 `(project_id, stage)` 資源，未宣稱 DB 回滾。同目標的新 `save_then_switch` 共用該資源既有 pending save；保存中新增編輯仍維持 dirty 並阻擋切換。新本機結果分支僅擴充 `StageDraftSwitchResult`，已更新模擬頁呼叫端；不改 server result type／HTTP 錯誤碼。

conflict 的 `current`／`submitted` 均改用 core 既有 strict `stageDraftContentSchema`；非法文字、錯型別與未知欄位固定回 `invalid_response`，保留 confirmed draft／版本及本地 editor，無法透過 `use_current` 採用。合法空字串、空白、Unicode 與換行仍保留原文。

實際結果：修復前目標回歸 18 項中 4 項紅燈（切換取消／取代與非法 conflict 重現）；修復後目標 18／18、`npm test` 16 檔／497 項、`npm run typecheck` 與停用 telemetry 的 `npm run build` 均通過。production 模擬頁實際操作取消後留在 A 並確認合成版本、正常保存後切換及保存中繼續編輯；操作均為合成 adapter，不是 DB 保存。**可封裝的桌面截圖 `not_run`**：整合瀏覽器截圖匯出產生錯誤拼貼／裁切，不能辨識全關鍵區域；另行啟動的本機桌面瀏覽器未能建立可用視窗／CDP。詳細命令、輸出、瀏覽器證據與限制依 [readiness-review.md](./readiness-review.md) §52.4 及專案外複核包。DB／server／runner 回歸 `not_run`。

### T054 §51 草稿保存控制器與獨立模擬（一次性本機子集）

從學生工作台選「開啟保存流程模擬」，或開啟 `/student/save-flow-simulation`。頁面明示只有記憶體與合成 adapter；重新整理會清除內容，操作按鈕均以「模擬」命名，手動選擇成功、失敗／結果不確定、衝突或 receipt／current 重播。不會呼叫登入、HTTP、Server Action 或 DB；T053 唯讀工作區預覽維持原樣。

控制器依 `(project_id, stage)` 隔離資源。最近確認的草稿與 row version、編輯器文字、dirty、提交中的不可變本文／預期版本／UUID 操作鍵及操作狀態各自保留。首次送出 `expected_row_version=null`，成功版本 0；更新帶草稿自身版本，成功後 +1。文字依既有 strict `{text:string}` 保存原文，不 trim／正規化。保存中可繼續編輯，舊回應只確認當次提交，不清除後續編輯。

adapter 為傳輸無關介面，不建立 fetch 或服務連線。結果不確定時可明確以同操作鍵和同快照重試；不可換 payload 沿用舊鍵，也不自動重試。`replayed.operation` 是原操作 receipt，`current_draft` 另行驗證且不以舊 receipt 回退版本。409 保留 `current`／`submitted`，不自動合併／覆寫；須明確選擇保留本地並以 current 版本重試，或採用 current。切換有未保存內容時須選「保存後切換／保留並暫不切換／放棄後切換」；保存失敗、衝突或仍有新修改不切換，放棄僅由明確選擇執行。

§51 實際結果：目標測試 1 檔／12 測試、`npm test` 16 檔／491 測試、`npm run typecheck`、停用 Next telemetry 的 `npm run build` 均成功；最終模擬路由瀏覽器操作及 127.0.0.1 HTTP 200 核對完成。DB／runner regression `not_run`（本輪沒有修改 DB／server／runner）。完整去敏輸出、exit metadata、瀏覽器截圖／操作紀錄、來源差異及複核 ZIP 依 [readiness-review.md](./readiness-review.md) §51.4 與專案外交付包查閱。

T054／T050／T015、T006、T004 僅本輪子集，T053 原依賴保留；不結案 T054／T051～T053。Q-DATA、保存期限、PP 與其他待決政策不變；真實保存、Auth、HTTP／DB／server、確認／批准、旅程推進、AI／Agent、預覽／提交／發布／部署仍關閉，Checkpoint／完整 Gate 未通過且正式簽核未執行。

### T054 §53 測試專用 adapter 至隔離 PostgreSQL（一次性本機子集）

僅在 `tests/integration/stage-draft-save-controller.test.ts` 透過測試來源 adapter 接線：先用既有 `readOwnedStageDraftSubset` 實際讀回資料，再建立控制器；保存時將 controller request 拆成 strict `{ project_id, stage, expected_row_version, content }` 與獨立 `idempotency_key`，分別傳入既有 `saveOwnedStageDraftSubset(context, input, idempotencyKey)`。context 由既有測試 helper 固定綁定 actor，交易仍由 server 與測試 helper 管理；未由 request、owner 欄位或前端角色推導主體。沒有 HTTP、Server Action、登入入口或產品匯入；合成 fixture 只由控制連線建立／清理，實際保存由非特權 server 路徑完成。

真實隔離 PostgreSQL 驗證涵蓋首次版本 0、server 讀回版本更新與 project／需求／分類／確認 evidence 快照不變、COMMIT 後延遲回應時 dirty 編輯保留、真衝突不覆寫、COMMIT 後丟棄回應並以原 UUID／快照重試的冪等 replay、receipt 與較新 current 分離、保存完成但回應未交付時取消／取代切換意圖、同校／跨校他人及教師／管理員拒絕、帳號停用／刪除標記／學校限制後保存及 replay 重新拒絕、withdrawn／expired 延續既有能力政策、project／stage 隔離及 9 個非特權 pool sockets 無 role／claim／transaction 殘留。測試透過獨立交易讀回／控制快照確認；COMMIT 後 response loss 與既有 COMMIT 前回滾回歸分開處理。

實測：新增控制器 DB 目標 18 項通過；同一 `npm run test:projects:db` run `ecc3092a1afa4a159ae78c41b5e36a19` 含既有授權 29 項、Projects integration 203 項、pgTAP 61／53／15 及 migration 相容性。暫時 grants 撤銷與 catalog 復原、只限該 run 專用 Compose labels 的 container／volume／network 清理結果依 readiness §53.3；runner／撤權／清理故障注入 `not_run`（本輪只加固定來源／測試清單，未改控制流程）。正式產品登入、瀏覽器保存及 UI 不在測試範圍；桌面截圖 `not_run` 保留 §52 歷史記錄，不重做瀏覽器驗收。

T054 為主要整合子集；T051／T050／T015、T006／T008／T004 僅本輪實際部分，依賴保留，136 項任務未勾選且不結案。Checkpoint／完整 Gate 未通過，正式簽核未執行；此測試結果不代表產品功能啟用或常設授權。

### T053 §50 學生工作區唯讀合成介面（一次性本機預覽）

啟動既有本機 web app 後開啟 `/student/workspace-preview`。頁面可切換情境 A／B／C 與拒絕／錯誤／找不到專案案例；七頁籤支援方向鍵及 Home／End。九個正式階段、目前階段及其已保存草稿各自呈現，不代表頁籤與階段映射；情境切換只更新記憶體中的展示狀態，不切換登入、讀取 DB 或持久化資料。

所有樣例均標示「合成資料／介面預覽，未連接登入或資料服務」。草稿只用純文字呈現；`student_input` 只代表提交來源，`ai_draft` 不顯示為 AI 生成。缺證據、未定規則、legacy、拒絕、讀取錯誤與不存在各自使用安全文案。保存、確認、批准、AI、建立／執行、測試、版本恢復、預覽、提交、發布與部署均禁用。真實資料接線、登入、T054 真實保存整合及完整 E2E 尚未完成；T051／T052 原依賴與任務狀態不變，Checkpoint／完整 Gate 未通過、正式簽核未執行。實際驗證與瀏覽器證據依 readiness §50 續記。

### T052／T051 §49 創作旅程唯讀評估 server（2026-10-24；一次性本機子集）

[projects 入口](../../apps/web/src/server/projects.ts) 匯出 `readOwnedProjectCreationFlowAssessmentSubset(context, { project_id, requested_stage })`。caller 只提交專案 ID 與正式階段；沿用可信唯讀交易與既有 gate／owner/RLS，以單一 SQL statement snapshot 讀取專案、需求 revision／原文、完整確認 evidence 與九步已保存草稿。server 內部完整驗證確認關聯，再呼叫 core `evaluateCreationFlow`；成功回傳該次 `snapshot:"single_statement"` 的專案 ID／row_version／requirements revision／assessment。需求／草稿本文與確認人不公開；普通評估不是 TrustedProjectClassification 或操作資格。無新 migration／grant／寫入／快取；未定階段維持 unsupported。

`platform_ai_assisted_creation` 已核對為僅傳入目前不使用的 eligibility 背景欄位；因此改為可省略且不影響評估，未提供時不填 `false`，不由平台能力或 `ai_draft` 推定。平台 AI 輔助不使作品成為 C 的回歸保留。完整命令、紅燈、真實 DB 併發／清理與封裝證據以 [readiness §49](./readiness-review.md) 為準；T051／T052 與其依賴均不結案。

### T052 §47 創作旅程與階段前置條件（歷史子集）／§48 F-01、F-02 最小修復（2026-10-24；一次性本機子集）

[core 純函式](../../packages/core/policy/creation-flow.ts) 經 core 入口匯出 `evaluateCreationFlow`、strict `creationFlowInputSchema`、九步順序及明確判斷聯集。輸入只接受具名專案／目前階段、當前需求 revision、分類確認、九步已保存草稿與平台 AI 輔助事實；不接受 caller 指定 `approved`／`complete`／`canAdvance`。檢查專案、需求版本／快照、確認目標、草稿所屬專案與重複 stage；目前 `projects.stage` 和草稿只作描述性事實。

輸出分開描述前置清單、目前分類確認、作品 A／B/runtime 範圍及指定階段判斷。有效分類確認只滿足分類規則；不宣稱點子／其他階段完成。只保存草稿不等於學生確認或教師／管理員批准；分類確認不補 Specification、Checkpoint、Constitution、Specification Sync、批准任務範圍或審查。OD-12 六階段映射／完成規則及尚無契約的批准／同步／任務／審查證據，回明確 unsupported；缺少目前確認、無效／矛盾／跨專案或 revision 的證據分別回 missing／invalid。平台 AI 輔助不使作品成為 C，作品 runtime AI／首版不支援範圍不放行；範圍結果不授予預覽、資料、AI 或發布操作權。

純函式只檢查 DTO 形狀／關聯／一致性，不能證明學生或人工批准者身分、真實來源或資料庫最新狀態；未來可信 server adapter 仍須重新查詢並驗證。沒有 DB／HTTP／UI／資料保存／階段推進／操作授權。

§48 依現行分類確認資料模型，新增 confirmation evidence 必要欄位 `project_id`、`tier`、`needs_visitor_identity`，並比對外層專案／classification 正式值；既有 revision、精確需求快照、requested tier 與 acknowledgement 驗證不變。缺欄位／型別錯誤遭 strict schema 拒絕，關聯不一致回 `invalid_evidence`。`unresolved_decisions` 改用凍結共用常數，避免回傳值可污染後續呼叫。這只改本機 `CreationFlowInput` 型別相容性：呼叫端需提供新的確認欄位；未找到產品呼叫端，現有使用限合成測試。輸出型別及資料庫／服務介面不變；不證明確認來源、確認者身分或 DB 當前狀態，也不能防止呼叫端同時偽造全部一致欄位。

§48 首輪修復前 F-02 單案例實測紅燈；修復後目標 29／29、一般測試 471／471、`npm run typecheck` 與停用 Next telemetry 的 build 通過。完整終測命令／輸出、雜湊及複核 ZIP 以 [readiness §48](./readiness-review.md) 為準。DB／runner `not_run`；不宣稱 T052 結案或 Gate 通過。

### T051 §46 工作區唯讀恢復資料整合（2026-10-24；歷史一次性本機子集）

§46 當輪授權／實測以 [readiness §46](./readiness-review.md) 為準；上方 §44 與下方 §45 亦為歷史快照，不互代結果。[projects 入口](../../apps/web/src/server/projects.ts) 新增 `readOwnedProjectWorkspaceSubset(context, projectId)` 與 `OwnedProjectWorkspaceDto`／`OwnedProjectWorkspaceReadResult`；[聚合服務](../../apps/web/src/server/project-workspace.ts) 沿用可信唯讀交易，單一參數化 statement 同時取得 DB 當下 gate／owner 與完整資料，無新 migration／grant／RPC／adapter 控制流程。

成功只回 `{project,requirements,classification,drafts}` 工作區：專案基本資料／自身 row_version、當前需求 revision／原文或 null、完整驗證的一般三態分類、依九步排序的已保存草稿及各自版本／狀態／來源／原文。缺少某 stage 代表未保存，不補空稿；空字串是已保存內容。非法 envelope／欄位／矛盾／重複階段全份拒絕，不暴露 owner／內部證據／任意 meta／SQL。普通 confirmed 及副本均不通過來源守衛，後續資格必須重新 resolver。

```powershell
npm test -- tests\contract\project-workspace.test.ts
npm test
npm run typecheck
npm run test:projects:db
$env:NEXT_TELEMETRY_DISABLED = "1"; npm run build
```

本輪已保存缺介面紅燈 37／37，實作後目標 37／37、一般測試 442／442；真實 DB 第二輪專案整合 162／162（含本輪 21 項）、原授權 29／29、pgTAP 61＋53＋15 及三段 migration 相容通過，typecheck／停用遙測 build 通過。首輪唯一失敗為新增測試錯寫既有 resolver outcome，修正為 `trusted`，未改 resolver。真實併發以 advisory wait 在查詢 statement pending 期間提交原子需求／分類失效／草稿更新，讀回完整舊 snapshot，下一交易讀到完整新 snapshot；不是 mock 或靜態 SQL 推論。真實缺需求／矛盾證據、SQL 後破壞結果全份失敗、讀前後全表快照相同、九個 pool sockets 無 role／claim／交易殘留均已覆蓋。

文件同步後封裝前再以 final-* 命令重跑並核對來源穩定，實際 exit code／完整去敏輸出／最終 DB run 與資源清理以複核包 result.json／run-summary.json／packaging-manifest.json 為準。runner 僅來源與固定測試清單增加，控制流程／撤權／清理未改；本輪 NotOk／SqlError／ParserSelfTest／EvidenceSelfTest／EvidenceWriteFailure 為 not_run，不挪用歷史結果。新交易讀回不代表登入登出恢復或 S-01～03；HTTP／UI／真實 Auth／其他下游功能及待決政策仍關閉，任務／依賴／Gate／簽核狀態不變。

### T051 §45 獨立未確認階段草稿（2026-10-24；歷史一次性本機子集）

公開 core 入口新增 [strict 草稿 schema](../../packages/core/contracts/stage-drafts.ts)；[server 草稿服務](../../apps/web/src/server/stage-drafts.ts) 另行匯出 `readOwnedStageDraftSubset(context,{project_id,stage})` 與 `saveOwnedStageDraftSubset(context,{project_id,stage,expected_row_version,content:{text}},uuidKey)`，沿用既有傳輸無關 context／交易 adapter。首次 expected version 為 null，成功版本 0；更新帶目前草稿版本並 +1。九步可分別保存，不改 project stage／row_version 或需求／分類。沒有 HTTP／UI 或真實 Auth provider。

每次用當下 DB 能力與 owner；withdrawn／expired 保留非 AI 讀寫能力，停用／刪除／學校未確認拒絕。狀態 `ai_draft` 僅為未確認草稿，固定提交來源 `student_input`，不是 AI 生成宣告；批准欄位 NULL。草稿不是權威需求或分類確認、Checkpoint、批准、Final Pack 證據。重放回原 `operation` 並另回 `current_draft`；不得把舊 operation 當最新內容。版本衝突回本次草稿的安全雙方版本／內容。保存不代表可用 AI、預覽、提交或發布；本輪不渲染／執行內容或宣稱輸出消毒。

驗證命令（僅本機合成資料）：

```powershell
npm test -- tests\contract\stage-drafts.test.ts
npm test
npm run typecheck
npm run test:projects:db
$env:NEXT_TELEMETRY_DISABLED = "1"; npm run build
```

完整 DB 入口保留舊 migration 相容、原 pgTAP／授權／建立／唯讀／分類及 §44 回滾，新增 0011→0012 全欄位相容、草稿權限快照／併發／冪等／回滾。一般測試 405／405、專案整合 141／141（含草稿 37 項）、授權 29／29、pgTAP 61＋53＋15、typecheck 與停用遙測 build 已通過。12 個真寫入後只破壞 envelope／receipt 的案例，由產品驗證觸發完整回滾；另驗 replay current、COMMIT 失敗不回成功、pool 角色／claim／交易乾淨。首次完整 DB 的唯一失敗為舊 catalog 仍斷言 stage_records 不存在，已更新為本輪獨立草稿存在、tasks 仍不存在，其他斷言未放寬。runner 修改後重跑 NotOk／SqlError（預期 exit 1）、ParserSelfTest／EvidenceSelfTest（exit 0）、EvidenceWriteFailure（預期 exit 1）；不是把負向退出計為一般成功。完整去敏輸出、run ID、來源雜湊、獨立清理與 ZIP 以 [readiness §45](./readiness-review.md) 及封裝 manifest 為準。

「新 context／新交易讀回」不代表真實登入／登出恢復、S-01～03、HTTP／UI 或完整 T055 已驗證。原任務／依賴與 Gate 狀態不變，正式面向維持關閉，完成後停止。

**2026-10-22 後續 Gate 前準備研究（不改下方產品測試狀態）**：本輪已另獲限縮授權，實際執行官方公開頁面查證與無密鑰、無網路的本機合成算例，命令／環境／輸入／結果及未執行研究原因見 [readiness-review.md](./readiness-review.md) §4、[原始結果](./spikes/readiness-prep/results.json)。S-01～03、S-04／15、現行 X S-05、S-07 等完整實測未因此完成；需要新環境／網域／密鑰／產品程式者仍待專項或階段授權。既有「本輪只核對文件」是較早輪次紀錄，保留歷史。

**現行預覽／資料授權（D-23）**：A1 與 B2 取代任何舊的無 cookie／hostname 即憑證、works-edge 全域資料 HMAC 描述；驗收依 V-53、V-56、V-57，所有正式驗證仍〔尚未執行〕。β2 學生伺服器公開執行及 M／W 移至後續獨立 feature，不屬 MVP 實作或 Gate。
**D-23 覆寫 V-53 舊案例**：V-53 長列保留的舊子案例中，「不使用 cookie／無 `Set-Cookie`／不帶 cookie 即成功」、hostname 決定授權、works-edge 持全域 HMAC、沙箱 TTL／`destroy` 決定預覽撤銷、β2 runtime，以及 HMR／WebSocket 成功要求均為歷史，不得按舊內容實作或驗收。現行 A1／B2 依 V-57；X、CSP 與作品執行時零 AI 途徑依 V-53／V-56。瀏覽器名單由教育者核定，Tasks 整理，V-53 前完成核定；未知或不支援環境 fail-closed。
**修訂紀錄／同步註記（2026-10-21，教育者首版範圍決定；D-23 後續覆寫）**：首版學生作品僅 A／B 級，公開 C 級受控 AI 已被取代・首版不適用（canonical：spec.md Clarifications「Session 2026-10-21（首版範圍決定…）」、FR-049、AC-27）。§2.4（V-30、V-32～V-35）、V-49 及相關公開池／訪客／公開 C 級值守驗證已標示取代並保留原文；**V-31（金鑰樣式掃描）、V-36（不當宣稱掃描）延續為首版現行（範圍調整；第六輪核對）**；新增 §2.8（V-51～V-57，**全部〔尚未執行〕**，為技術設計驗證草案，教育者未逐項批准）；學生平台 AI 與值守（V-03、V-04、V-43～V-48、V-50 學生部分）及 S-01～S-03 維持。早期「β2 為首版目標」、S-13／V-47 β2 執行驗收已由 D-23 取代，改為後續獨立 feature；V-28／V-55 僅保留 MVP 的不支援阻擋驗收。學生端文案為草案，待教育者／專業審閱。

### T051 §42 本機驗證摘要（一次性子集）

本次依 readiness §42 先在 0009 schema 建立明確合成舊列、保存遷移前快照，再套用 0010；遷移相容 pgTAP 15／15、identity/audit 61／61、account-gate 53／53，應用授權整合 29／29、projects／建立整合 72／72。目標契約測試 81／81、完整 `npm test` 366／366、`npm run typecheck` 通過。`npm run test:projects:db` 完整 exit 0，無非預期 skip、SQL error 或 TAP failure；NotOk／SqlError 故障注入則各以預期 exit 1 攔截且完成撤權與清理。§41 當時的 `not_run` 保留為歷史，並非本輪結果。

本輪修改 migration、測試／runner 與治理文件；為涵蓋 migration 變更而使用停用遙測的 `npm run build`，production build、TypeScript 與靜態頁生成均成功。上述本機測試不是正式產品驗收，不改變 T051 未結案、原任務依賴、G0／Checkpoint／完整 Gate 或服務關閉狀態；逐項命令、run ID、差異、完整去敏證據及封裝位置見 readiness §42。

### T051 §43 需求版本與 A/B 分類確認（2026-10-24；一次性本機子集）

`npm run test:projects:db` 完整成功（run `832d4979797449999dad70f22f801632`）：0010／0011 遷移相容、分類歷史列未升格、pgTAP identity／audit 61／61、account gate 53／53、project migration compatibility 15／15、授權整合及分類應用程式整合均通過；暫時授權撤銷 verified、cleanup complete。`npm test` 11 個檔案／373 項通過；`npm run typecheck` core／web／tests 通過；停用遙測 `npm run build` production build、TypeScript 與靜態頁生成成功。NotOk／SqlError 故障回歸依預期各以 exit 1 被偵測，temporary grant revocation verified、cleanup complete。實作前的分類 schema 紅燈及所有完整去敏輸出、exit code、來源雜湊、Docker／catalog 清理與 ZIP 見 readiness §43。

這僅是隔離本機 PostgreSQL 與合成資料的受控資料層驗證；沒有真實 Auth、正式 DB／學生資料或雲端服務，也不代表 T051 結案、原依賴滿足或完整產品驗收。HTTP／UI、預覽、提交、發布與部署維持關閉。

### T051 §44 A/B 分類確認三項審閱修復（2026-10-24；一次性本機子集）

本輪先保存契約紅燈 1／61 失敗、真實 DB 應用專案紅燈 15／104 失敗，再修復可信來源守衛、合法 confirmed 的舊介面不支援表示、結果驗證失敗仍提交。修復後目標契約 105／105、全體 `npm test` 390／390、core／web／tests typecheck 與停用遙測 build 通過。完整 `npm run test:projects:db` run `d67dc9be59294fbd8b9672a27cc8cad6` 通過：原遷移相容、pgTAP 61＋53＋15、授權 29／29、專案／建立／分類 104／104。10 個需求保存／分類確認結果破壞案例均先執行真 SQL、在同交易觀察寫入，再由服務驗證觸發回滾；獨立控制快照全部還原，pool 無殘留，移除 wrapper 後正常操作成功。另有兩個 replay current 驗證失敗案例。

一般 current DTO 不能通過可信守衛；只有 resolver 建構的分類原物件通過，來源標記不是永久資格，需求修改後必須重查 DB。四個舊單筆／列表介面對完整合法 confirmed 回 `unsupported_representation`，非法資料仍 `failed/invalid_result`，不靜默漏列；建立冪等回應不變。詳見 [直接契約 §1.1](./contracts/projects-agent-sandbox.md#11-需求版本與分類確認)。

本輪紅／綠兩個 DB run 均撤權 verified、catalog 位元組相同、cleanup complete，獨立查詢各自 labels 的 container／volume／network 均 0。runner／adapter／migration／Compose／清理未改，NotOk／SqlError 等 runner 故障情境 **not_run**。完整去敏輸出、首次驗證工具失敗及後續成功、來源差異、含必要鎖檔的 ZIP 位置與限制見 readiness §44；T051／Gate／服務關閉狀態不變，完成即停止。

## 本機基礎功能階段（2026-10-22；不代表產品驗收）

本機原型使用已批准的 Next.js／React／TypeScript／Tailwind／Zod 技術基線，不連接 Supabase、OpenAI、Worker、Sandbox 或任何供應商服務。所有角色頁只供合成介面預覽；不登入、不寫入、不保存資料，未接通操作明確顯示「尚未開放」。此階段測試不會改變上方正式產品 Spike、情境、Readiness 或上線驗收的「尚未執行／未通過」狀態。實際結果記於 [readiness-review.md](./readiness-review.md) §17；其後本機階段與現行狀態見 §17～§28（現行摘要 §28.7）。

在專案根目錄執行：

```powershell
npm install
npm run dev
```

預設僅綁定本機 `127.0.0.1:3000`。需要指定其他連接埠時，可執行 `npm run dev -- --port 4317`。本機驗證命令（`npm run typecheck` 依序檢查 `packages/core`、`apps/web` 與 `tests/**/*.ts`；測試檔另由 `npm run typecheck:tests` 單獨執行，使用 `tests/tsconfig.json`，以套件名稱 `@app-planet/core` 匯入，不使用 paths／alias）：

```powershell
npm test
npm run typecheck
npm run build
```

### T007／T008 隔離本機資料庫測試（2026-10-23；已完成限定 PostgreSQL 層驗證）

來源位於 `supabase/migrations/0001_identity_audit.sql`、`0002_account_gate.sql`、`supabase/tests/` 及無密鑰值的 [本機 Compose 設定](../../supabase/pgtap.local.compose.yml)。使用官方 Supabase PostgreSQL 17.6 映像（pgTAP 1.3.3），僅將資料庫埠綁定 localhost；migration 依序成功，`identity_audit.test.sql` 61／61、`account_gate.test.sql` 53／53，兩份 TAP plan／exit code 均有效。`npm test` 為 269／269，`npm run typecheck` 成功。詳見 [readiness-review.md](./readiness-review.md) §34.2。

這是 Supabase PostgreSQL 映像層級的資料庫驗證，不是完整 Supabase stack；`auth.users`、`auth.uid()` 與角色來自映像初始化，但測試直接插入合成 Auth 列並設定合成 claim，沒有 Auth API、登入、JWT 簽發或 S-01～03 流程。RLS 斷言以 `authenticated` 執行；psql 控制連線只負責 migration／合成 fixture 與交易回滾。這不代表 T004、T007、T008 或 T015 完成。

§34 當次測試後已移除其 container、volume 與 network；該段未建立 `supabase/config.toml`。其執行紀錄及 `not_run` 均為歷史狀態；本節 §35 提供另經明確授權的單一本機重跑入口。密碼／JWT 每次執行產生，不寫入檔案、shell history、報告或封裝；本機 SQL 結果不替代正式 Auth／產品驗收。

### §40 新專案初始化同步／分類來源（2026-10-24；先前輪次歷史）

授權／基線先登錄 [readiness §40.1](./readiness-review.md)，規則與分類來源六問／兩案見 [decision-register](./decision-register.md)「2026-10-24 T051 初始化決議與分類來源提案」。已批准新專案只由受控流程固定 stage=「點子」／row_version=0；caller 即使傳同值仍拒絕。舊資料與負／零版本讀取不變，不改 migration／RLS／唯讀 DTO，不新增未使用 helper 或寫入權限。

本機 createOwnedProjectSubset 已移除 initial_stage／initial_row_version 的未決判斷；明示 A／B 仍因 visitor_identity_initialization blocked，省略 tier 時另有 omitted_tier，**沒有 created／成功寫入路徑**。未找到現成可信分類來源；案 A 建立前獨立確認紀錄（推薦）、案 B 建立後未分類點子，都「待批准／未採用」。不得把提案當作已採用 nullable／pending、新服務、必填 tier 或 default false。

該輪次的測試及決策只適用當時範圍；較新方案 B 決策與結果見 readiness §41，不以本節歷史取代：

```powershell
npm test -- tests\contract\project-create.test.ts tests\contract\project-stages.test.ts
npm run test:projects:db
npm test
npm run typecheck
$env:NEXT_TELEMETRY_DISABLED="1"; npm run build
```

DB／交易／runner 本輪無修改，故其獨立故障注入回歸列 not_run（不重做既有拒絕邊界）；完整 DB 入口仍執行原 pgTAP、授權、專案唯讀及建立拒絕回歸。成功建立讀回、原子交易／冪等、四種服務資格整合均 blocked／not_run。136 項任務不勾選、不改依賴；G0／Checkpoint／完整 Gate 未通過，正式簽核未執行，本輪到此停止。

### §39 學生專案建立驗證／拒絕邊界（2026-10-24；以下保留歷史）

本輪明確授權、逐項契約核對、直接缺漏及完整驗證見 [readiness §39](./readiness-review.md#39-2026-10-24-學生專案建立隔離本機子集gate-前有界例外)；不變更下方歷史結果或正式產品驗收狀態。重跑本輪子集（專用本機 Docker／合成資料，不讀 .env）：

```powershell
npm test -- tests\contract\project-create.test.ts tests\contract\project-stages.test.ts
npm run test:projects:db
npm test
npm run typecheck
$env:NEXT_TELEMETRY_DISABLED="1"; npm run build
# runner 改動的適用故障回歸；預期 exit 1，但撤銷 verified／清理 complete。
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\pgtap-local.ps1 -Scenario NotOk
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\pgtap-local.ps1 -Scenario SqlError
```

實測：目標 84／84；一般單元 369／369；完整 DB 入口依序執行原 pgTAP 61＋53、授權 29、原專案唯讀 30＋新建立拒絕邊界 35；型別及停用遙測建置成功。正常及兩次故障均 catalog 還原、撤銷 verified、清理 complete，並以唯一 labels 獨立核對零殘留。完整原始去敏輸出、紅燈、來源雜湊與清理證據另存專案外複核包，不以本段摘要替代。

[createOwnedProjectSubset](../../apps/web/src/server/projects.ts) 接受 `(context, input, idempotencyKey)`；本文只有必填文字 title、選填 A／B tier，UUID 操作鍵獨立傳入；額外 owner／角色／學校／id／created_at／stage／row_version／needs_visitor_identity 等皆 invalid_input。可信唯讀 context 每次查 DB 的 P-1 `edit_saved_content`，不是 read_saved_content／login；withdrawn／expired 通過該能力，但與 approved 一樣因缺必要初始化而明確 blocked。拒絕為 denied；輸入、context、DB 結果或依賴錯誤為 failed；**不存在 created 或成功 DTO**，不回原始 SQL／driver／stack。

**直接阻擋／未執行**：初始 stage、row_version、needs_visitor_identity 建立來源，以及省略 tier 的處理未定（模型 §4.1、PROJ P-1）；不接受 caller 補值，不從 fixture 推定。因此本輪沒有新增 migration、可寫 context／RPC／DML grant；成功建立後讀回／跨帳號隔離、成功冪等及真正寫入原子性均 blocked／not_run。既有唯讀 fixture 的 RLS 通過不能代替這些成功驗收。P-1 冪等本身已有明文，不另送審；無明文要求建立時產生 stage_records／tasks／audit，不另造關聯阻擋。既有列表／單筆介面及 DTO 相容，依賴／鎖檔原樣。

本輪已完成已明定的驗證／拒絕，不是另一份未執行計畫，也不是成功建立功能完成。T051、136 項任務及 checklist 均不結案，T050／T039 原依賴、G0／Checkpoint／完整 Gate 未通過狀態保留；真實 Auth、HTTP／UI、階段保存、版本更新／衝突及所有其他真實功能仍關閉；停止本輪，不自行接續。

### §38 學生專案唯讀資料／擁有權（2026-10-23；T051 子集；以下保留歷史）

授權／基線先記於 [readiness §38.1](./readiness-review.md#381-授權來源基線與驗收先記錄後修改其他來源)，實際驗證及封裝見 §38.2～§38.3。在本專案根目錄重跑（不讀 `.env`，不接受遠端 DB URL）：

```powershell
npm run test:projects:db
npm test
npm run typecheck
npm run build
# 可選：既有固定故障情境，預期 exit 1，但撤銷 verified／清理 complete。
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\pgtap-local.ps1 -Scenario NotOk
```

`test:projects:db` 每次唯一隔離本機 DB，套用 `0001`、`0002`、[0009 projects 子集](../../supabase/migrations/0009_projects_stages.sql)，依序完整執行原兩份 pgTAP、§37 授權整合及 [projects 整合](../../tests/integration/projects.test.ts)，任一步失敗整體非零；不跳過舊測試。原 `test:db`／`test:authorization:db` 入口保留。一般 `npm test` 排除 integration，不需要 Docker。本輪最終實際結果：一般單元 325／325（新增 40）、專案 DB 30／30、授權 DB 29／29、pgTAP 61／61＋53／53，型別及建置成功。

[projects.ts](../../apps/web/src/server/projects.ts) 提供 `listOwnedProjectsSubset(context, maximumRows)`／`readOwnedProjectSubset(context, projectId)`；只接受 §37 可信交易介面，合成 principal 僅 [測試 adapter](../../tests/integration/authorization-context.ts)。DTO 只含 `id,title,tier,needs_visitor_identity,stage,created_at,row_version`；不回 owner 或學校／帳號資料。列表必須明示正整數 `maximumRows`（PostgreSQL int 範圍），沒有預設產品額度、排序保證、總數／頁碼／游標，不可把有限結果當完整目錄。`listed` 空列表、`denied` 與 `failed` 區分；單筆他人／不存在／政策拒絕同回 `not_found`；錯誤與無效上下文回安全 `failed`，不洩漏 SQL／SQLSTATE／driver／stack。

三次 DB run（含開發中初次與最終正常、既有 NotOk 故障）均撤銷 verified、清理 complete，catalog 前後相同及本輪 labels 零殘留另行核對。完整 stdout／stderr 與摘要由入口輸出的 Evidence 目錄保存；不是只有衍生 TAP。首次紅燈是尚無模組的 import 失敗；開發中單元參數化案例寫法錯誤及修正紀錄也保留，不冒稱最終全綠前未曾失敗。

**界線**：`0009` 檔名沿 T051 規劃，現階段僅 projects，未建立 stage_records／tasks，不是完整 P-1～4 或正式資料保存。無 HTTP／登入／UI、產品建立／更新／刪除、階段／任務寫入、人工批准、版本更新／衝突或教師查看稽核。T051 原依賴 T050、T039 及其他前置、原任務／checklist 勾選不變，完整 Gate 未通過、正式簽核未執行；下一批須另行批准，不自行接續。

### §37 應用程式唯讀授權／本機 DB 整合（2026-10-23；T008 部分）

在 Windows 專案根目錄執行：

```powershell
npm run test:authorization:db
npm test
npm run typecheck
npm run build
```

第一個命令使用既有 runner 的固定 `Authorization` 階段，仍先執行兩份 migration、原 identity/audit 及 account-gate pgTAP，再執行 [應用程式 DB 整合測試](../../tests/integration/authorization.test.ts)。不接受遠端 URL、任意 SQL 或 shell hook；需要既有 Docker Desktop／Compose、Node.js／npm，依專案 lockfile 安裝的 `pg`／`@types/pg` 僅供開發測試。一般 `npm test` 排除整合路徑，無需 Docker；不要直接執行 integration Vitest，缺少 runner 執行期環境會明確失敗。

[authorization.ts](../../apps/web/src/server/authorization.ts) 提供 `authorizeCapability(context, capability)` 及 `authorizeTeacherRelationship(context, studentId)`。`context.runReadOnly` 是可信 server 交易提供者的介面，不是 request／URL 輸入，也不是登入驗證器；本輪沒有產品 Auth provider。合成 claim 設定僅位於 [測試 adapter](../../tests/integration/authorization-context.ts)，不得移入產品或當成「指定 user id」入口；本輪 SQL 直接讀 DB 事實，不以既有純函式的輸入物件代替資料庫。

runner 每次以 stdin 設定隨機測試 actor 密碼，透過子程序執行期環境傳遞，並加入既有去敏界線；不寫檔、不印憑證。fixture／migration 控制連線為 `postgres`，另外建立 `app_authorization_test` LOGIN、NOINHERIT、NOSUPERUSER、NOBYPASSRLS、無 app 物件 ownership 的授權連線，只可 SET 為 `authenticated`，不使用 service_role。每次判斷取單一連線，以 READ COMMITTED READ ONLY 交易、SET LOCAL ROLE／local claim 執行；提交後自動還原，任一步失敗銷毀 socket，不歸還可能污染的連線。pool max=1 的交替主體測試逐次確認同一 backend PID、原角色及空 claim；不快取允許結果。測試後刪除專用 actor，再進既有權限撤銷、catalog 比對與 container／volume／network 清理；應用程式測試失敗使 runner 非零（已以缺少模組紅燈驗證）。

結果為 `allowed`（僅 `account_capability` 或 `teacher_relationship`）、`denied/policy_denied`、`failed`（`invalid_input`／`invalid_context`／`dependency_failure`／`invalid_result`）。SQL false 僅作一般拒絕；無主體、錯誤 actor／非唯讀上下文、必要結果缺漏、SQL 例外或 pool 失效均不允許，不回 SQLSTATE、SQL、stack、原始列或 driver error。不新增 HTTP／SSE 碼或日誌 sink。學生 login 不代表建立 session；教師 pending／rejected 的 login 通過僅保留受限狀態入口，不能存取學生內容。教師 predicate 通過不是取得任何學習資料，學生 capability 通過也不證明作品／對話／檔案 ownership。

本輪最終實測：應用程式 DB 整合 **29／29**、pgTAP **61／61＋53／53**，一般單元／契約 **285／285**（新增授權單元 16 項），typecheck／build 成功；完整去敏輸出、角色／權限與清理見 [readiness-review.md](./readiness-review.md) §37.2。這些是 PostgreSQL／應用程式授權測試，不代表 JWT 簽章、Auth API、真實登入、S-01～03、完整 T008、Q-SCHOOL 或 Gate 已通過。未決分支與真實功能維持原關閉界線。

### §35 隔離本機 pgTAP runner（2026-10-23；T004／T007／T008／T015 子集）

在 Windows 專案根目錄執行唯一正式入口：

```powershell
npm run test:db
```

需要既有 Node.js／npm 專案環境、Windows PowerShell 5.1+、已安裝且正在執行的 Docker Desktop／Docker Compose plugin。runner 不要求本機安裝 `psql`、`pg_prove` 或 Supabase CLI，不新增 npm 依賴，不呼叫雲端 API。Compose 保持既有官方映像 `public.ecr.aws/supabase/postgres:17.6.1.167`，每次產生隨機專案識別、container／volume／network、未占用的 loopback 埠與執行期測試憑證；啟動後以 Docker 實際 port binding 確認只綁定 `127.0.0.1`。資源碰撞／埠占用即失敗，不接管既有資源。

runner 先確認全新 DB 的 `app` schema 尚不存在、`auth.users` 為空、映像原生 Supabase roles、`auth.uid()` 與 pgTAP 版本符合預期，再依序套用兩份 migration、執行兩個 SQL 測試。測試專用授權置於 [harness SQL](../../supabase/tests/harness/) 並與產品 migration 分離；只暫時授予控制角色 `postgres` 所需的 `SET ROLE app_audit_writer` 選項，保存並還原既有 role option；只對欠缺權限的測試角色授予 `extensions`／實際使用的 pgTAP assertion 權限。授權前、授權中、撤銷後均輸出 catalog 快照；撤銷後完整比對角色／函式／schema／app 資料表有效權限，app table 權限不得變動。

每次執行在專案外建立不覆寫的獨立證據目錄：`$env:LOCALAPPDATA\Temp\AppPlanet-pgtap-<時間戳>-<唯一識別碼>`。自 [readiness-review.md](./readiness-review.md) §36 起，每次命令（含 pgTAP 與 snapshot）的 stdout／stderr 取得後，先以 `Protect-Output` 替換本次已知測試憑證，再於 TAP 判讀前保存為 `commands\<四位命令序號>-<安全命令名>.stdout.txt`／`.stderr.txt`。重複命令名仍各自保留；空輸出保存為 0-byte 檔。成功、not ok、未知行、SQL error 與非零 exit 共用此路徑，不 Trim、選行、重排或只留 TAP。合成 claim、診斷、未知行與原有空白／行序因此保留；請勿將任意真實資料交給此本機 runner。

**文字證據限制**：子程序 stdout／stderr 由 .NET `Process` 的 StreamReader 以 UTF-8（BOM 偵測、無效序列 replacement fallback）解碼，遮蔽後寫成 UTF-8 無 BOM。這是**完整去敏解碼文字**，不是原始位元組備份；無法回復解碼損失或已遮蔽值。`Protect-Output` 僅替換本輪已知測試憑證，不偵測所有個資／密鑰；未遮蔽內容不另行落盤。stdout／stderr 各自保留行序，未宣稱可重建兩串流的交錯時間順序。

`run-summary.json` 是衍生索引，記錄 `command_id`、命令名／執行檔、exit code、`stdout_file`／`stderr_file`、各串流保存狀態／證據錯誤、每份測試對應命令及 `derived_tap_file`、工具／映像、來源 SHA-256、授權撤銷與精確清理結果。`*.derived.tap` 是**過濾後的衍生資料**：成功為解析出的 assertion／plan，失敗為候選 assertion／plan，可能不含診斷／未知行，不能拿它代替完整 stdout；`permissions\*.tsv` 是由完整 snapshot stdout 正規化後的衍生快照。§35 舊 `*.tap` 仍只是歷史過濾結果，不追溯改稱完整原始證據。

任一串流寫入失敗會記入摘要並使 runner 非零退出；另一串流仍嘗試保存。正常階段立即中止判讀並進入既有 `finally`；清理期間的命令證據錯誤明確記錄，但仍使用記憶體中的命令結果進行撤銷、label 核對與移除，最後仍失敗。若儲存整體不可用，摘要本身也可能無法寫入，此時 stderr 明確報錯且非零退出，不宣稱證據完整。

預設命令只有在兩份測試各自 plan／編號完整、psql exit 為 0、無 SQL error／TAP 失敗、臨時授權撤銷與權限快照還原成功，且本次專用 container／volume／network 均已移除並查核後，才回傳 **exit 0**。其他任何前置、migration、SQL、TAP、撤銷或清理錯誤均為 **非零退出**；失敗原因與清理錯誤分開記錄。僅在強制終止／當機造成 `finally` 無法執行時，依該次證據 `run-summary.json` 的資源識別值手動復原：先逐一核對 labels 精確符合該次 project／service，再只刪除核對相符的單一 container、volume、network；不使用 Compose 全域清理、`prune` 或刪除其他資源。

可選的安全故障驗證只接受固定情境，不接受任意 SQL／DB URL：`powershell -NoProfile -ExecutionPolicy Bypass -File scripts\pgtap-local.ps1 -Scenario NotOk`（外部暫存 SQL 副本注入單一 `not ok`，預期 runner 非零）及 `-Scenario SqlError`（固定 `SELECT 1 / 0`，預期 psql 非零）；兩者均須完成撤銷及清理。`-Scenario ParserSelfTest` 不啟動資料庫，合成檢查 parser 拒絕空白／缺 plan／plan mismatch／重複 plan 或編號／Bail out／not ok／skip-all／TODO／SQL error／psql 非零，且接受有效連續 plan。

`-Scenario EvidenceSelfTest` 不啟動 DB，透過真實合成子程序及同一 `Invoke-Captured` 路徑，在判讀前讀回證據逐字比對：有效 TAP、not ok／`#` 診斷／plan、唯一未知行 `APPPLANET_UNRECOGNIZED_36` 及前後內容、已知假憑證遮蔽、SQL error、空輸出與非零 exit；也涵蓋同名命令、CRLF／LF、空白與繁中。有效輸出通過，其他情境仍由未放寬的 parser 拒絕；合成假憑證不記入報告或命令參數證據。`-Scenario EvidenceWriteFailure` 預期非零：只在本輪專用暫存目錄建立同名空目錄阻擋 stdout 寫入，於 finally 再以合成清理子程序阻擋 stderr 寫入，確認錯誤仍記錄且清理可繼續；刪除的只是兩個本次空目錄，不改系統權限或他人檔案。此合成探針**未證明磁碟故障下的完整 Docker 清理**，Docker 正常／not ok／SQL error 的實跑結果另列 §36。

**驗證層級界線**：這只驗證官方 Supabase PostgreSQL 映像提供的 PostgreSQL／RLS／pgTAP 層。`auth.users`、`auth.uid()`、roles 由映像初始化；fixture 是直接插入的合成 Auth 列，claim 是合成值，不代表完整 Supabase stack、Auth API、登入、JWT 簽發、正式學校核准或產品驗收。RLS／audit 斷言由 SQL 測試實際 `SET LOCAL ROLE authenticated`／`app_audit_writer` 執行；psql 控制連線只負責 migration、fixture 與測試授權，不描述為 RLS actor。T004／T007／T008／T015 均只完成本輪所列子集，其他產品功能保持關閉。實際正常／故障注入／清理後重跑結果見 [readiness-review.md](./readiness-review.md) §35.2。

**SSE 本機 helper 限制（2026-10-23）**：從 `@app-planet/core` 匯出的 `deriveMessageState` 不是六事件的完整訊息狀態映射器。完整歷史驗證成功後，若含 `block` 或 `support`，回 `{ ok: false, code: "unsupported_message_state_mapping" }`；呼叫端必須先處理 `ok: false`，不得自行回退為 complete／partial／failed。此為本機 API 碼，不是 HTTP／SSE 錯誤碼；CHAT 的 `block → blocked` 不變，合法事件仍可加入、驗證與重放。其餘映射與保存片段規則不變；support 完整映射、組合優先序未由本輪補定。最新有界修復與驗證見 [readiness-review.md](./readiness-review.md) §29，補充上方 §28.7 的現況；不代表產品驗收、G0 或 Gate 通過，不延伸授權至其他本機或服務工作，也不授權啟動預覽伺服器。

**作品範圍資格本機 helper（T095 子集；2026-10-23）**：`@app-planet/core` 的 `evaluateWorkEligibility` 只判斷明確輸入是否落在 MVP 支援範圍：A 對應靜態作品，B 對應平台 Work Data API；公開 B 的訪客識別限制只在 `public` 情境套用，不擴大到 A1 私人預覽；`restricted_server` 與作品 runtime AI 需求拒絕。必要事實缺漏、未知欄位、非法值及矛盾分類均拒絕，不自動降級或預設布林值。平台 AI 協助製作與作品 runtime AI 是不同輸入。這個純函式只驗證輸入形狀，不證明來源真實；未來呼叫端必須從可信的伺服器端事實組合輸入，並在預覽／提交／重試／部署各自重新驗證。所有結果碼僅供本機範圍判斷，未定義新的 HTTP 映射；「符合 MVP 支援範圍」不代表准許預覽、建置、資料讀寫、發布或 Gate 通過。授權與實際測試狀態見 [readiness-review.md](./readiness-review.md) §30，T095 原依賴未改、任務未結案。

**診斷日誌白名單 helper（T012 子集；2026-10-23）**：`@app-planet/core` 匯出 `createDiagnosticLogPolicy`、`buildDiagnosticLogDto` 與 `validateDiagnosticLogDto`。可信程式碼才可建立 policy 的 route ID／HTTP 錯誤碼清單，不得由請求本文或供應商回應建立；policy 也拒絕現行 SSE 專屬錯誤碼。本輪只接受可信設定的 HTTP 錯誤碼子集，不代表完整登錄。builder 只明確投影 `request_id`、受控 `route`、HTTP `status_code`、數值 `duration`，以及選填 `aid`／已設定的 HTTP `error_code`；缺漏、錯型別、未登錄值或不支援物件一律回固定 `{ ok: false, code: "invalid_log_record" }`，不回顯輸入或驗證細節。未知欄位（包括巢狀 body、headers、Error、provider response 與 meta）不進 DTO；輸出 DTO 另行驗證白名單形狀。request ID／aid 的非空格式不證明內容不含個資或憑證，producer 須保證可信來源與安全內容；route ID／錯誤碼設定也由可信程式管理，且本輪不宣稱完整路由或錯誤碼登錄。此 helper 是純本機資料建構，不呼叫 console、不寫檔、不讀環境、不連網，沒有輸出 sink；不建立追加式 audit 或 `aid` 與真實身分對照。服務整合、保存／輪替、供應商日誌與全系統去敏仍未完成。授權與實際驗證見 [readiness-review.md](./readiness-review.md) §32；T012 原依賴未變、任務未結案。

## 0. 前置條件（執行驗證前）

### 2026-10-21 最新 MVP 驗證適用表（取代較早 β2 與沙箱埠預覽假設）

本指南仍是**產品驗證計畫，未執行**；另有已執行的研究 VC-1～VC-3，見 [research.md](./research.md) R-15 與 [結果](./spikes/security-boundaries/RESULTS-vc1-vc3.md)。「本輪未執行」不抹除既有實測；Spike 不等於下列產品驗收通過。本輪只核對證據及同步文件。

| 原編號（保留） | MVP 現行驗證／狀態 |
| --- | --- |
| S-05 | 改驗 X 的 `ports: []`、受限出站、管理通道取回與無瀏覽器可達沙箱入口；不再呼叫 `startPreview` 或測反向代理埠。VC-1／VC-2 為部分證據，未知路由不能窮舉；完整產品條件未完成。 |
| S-13 | β2 隔離／配額／成本移至後續獨立 feature，原列保留研究，不是 MVP Gate 條件。VC-3 已量測部分原語，**S-13 完整驗收未完成**；不實作 M／W，不升級付費 Pro。 |
| V-28、V-47、V-55 | A／不需學生伺服器程式的合格 B 按批准版本部署；Work Data API 同源且有配額；需訪客識別者阻擋。需 β2 者在 MVP 預覽／公開**0 件執行、0 件部署**，回 `student_server_runtime_not_in_mvp` 並顯示後續獨立功能限制，非首版內「尚在驗證、尚未開放」。下方原 β2 開放判準保留為被取代歷史。〔未執行〕 |
| V-53 | X 產物入口、CSP、跨 origin、A1 分區 cookie／伺服端會話、撤銷與瀏覽器條件；B2 授權及 Works Data API 逐請求重驗依 V-57。原執行範圍中的 β2 runtime、沙箱預覽埠反向代理與 WebSocket／HMR 成功要求均為**歷史，不得按舊條文實作**。目標瀏覽器／版本須由教育者於測試前核定；不支援必要 cookie 行為時 fail-closed 顯示「暫不支援互動預覽」。〔未執行〕 |
| V-56（新增） | X 完整更新、失敗與量測，見下表；涵蓋 FR-010／026／040、AC-05／11。〔未執行〕 |
| V-57（新增） | A1／B2 授權、撤銷與金鑰輪替；依本指南新增案例表。〔未執行〕 |

**V-56：方案 X 產品驗收計畫（非本輪執行）**

| 案例 | 預期／所需證據 |
| --- | --- |
| 保存→排隊→建置→取回→檢查→保存產物→綁定→iframe 重載 | 全鏈綁同一快照／雜湊；UI 分別呈現已保存、建置中與成功版本；iframe 只取平台入口，不可見供應商沙箱 URL；不使用 HMR。 |
| 保存、建置、取回、驗證、保存產物各階段注入失敗；並行亂序完成 | 明示失敗階段、原因／重試；0 件假成功或未驗證產物服務；草稿／已保存內容不丟失；保留舊預覽且標版本；無舊預覽時明示；舊工作不倒蓋較新成功綁定。 |
| 惡意路徑、連結、保留 `/_work/*`、型別／大小／檔數超界、manifest 雜湊不符 | 整份拒絕且不綁定；不可改入口標頭或遮蔽平台路由；測試採正式核定的邊界值，而不是直接採 Spike 的 1 MB／5 MB／200 檔。 |
| A1 預覽會話：host-only 分區 Secure／HttpOnly cookie、解除教師綁定、停用、到期／撤銷、跨區快取 | 不帶有效 cookie（即使知道 hostname）一律拒絕；各資源、重新整理與 Work Data API 均驗證伺服端狀態；撤銷在 PP-23 核定上界內生效；已載入內容不承諾收回。正式數據不能沿用本機撤銷 p95 1,952 ms。 |
| B2 Work Data API 授權：單作品／用途、短效、撤銷版本、授權更新故障、金鑰輪替 | 平台每請求重驗 live 狀態、簽章授權、撤銷版本、配額與限流；簽署私鑰不在 works-edge；授權更新失敗一律拒絕；驗證作品範圍隔離並記錄 works-edge 入侵且持多作品有效授權的殘餘風險。 |
| 核定目標瀏覽器／版本×一般／封鎖第三方 cookie／隱私模式／學校裝置 | 右側互動、重載、放大、導覽、同源資料 API 與錯誤提示；記錄跨站儲存／對話框限制並回 UX；未列版本或不支援必要 cookie 行為時顯示「暫不支援互動預覽」，不回退 hostname 授權。 |
| 課堂規劃尖峰 20 人、大小產物、冷／暖重建 | 分段與端到端 p50／p95／max、錯誤率、排隊、Team 控制面競爭及費用；門檻先經教育者核定，未核定只回報、不判通過、不宣稱可支援 20 人；未達門檻不就緒。VC-2 的 8 並行不能替代；不以試用 Team 外推付費 Pro。資源建立須另獲授權。 |

**V-57 A1／B2 驗收案例（非本輪執行）**

| 案例 | 預期／所需證據 |
| --- | --- |
| A1 首次兌換與後續請求 | 短效一次性權杖只能兌換一次；兌換後 URL 不含權杖；確認 `__Host-` cookie 設定 `Secure; HttpOnly; SameSite=None; Partitioned; Path=/` 且無 `Domain`。不帶 cookie、錯誤分區、失效或偽造 cookie，即使提供正確 hostname，HTML、子資源、重新整理與 Work Data API 皆不得取得內容。 |
| A1 權限撤銷 | 教師解除綁定、帳號停用、到期及手動撤銷後，重試所有端點；無請求可超出 PP-23 核定上界。狀態快取、跨區與錯誤回應一併量測；已載入頁面內容不可收回的限制明示。 |
| A1 fail-closed | 對分區 cookie／跨站 iframe 不支援或被學校政策封鎖的目標環境，顯示「暫不支援互動預覽」；不得降級為 hostname 即憑證。未核定 TTL／撤銷上界／瀏覽器清單時，不簽發會話或不開放該支援範圍。 |
| B2 資料授權與金鑰 | 授權篡改、跨作品／用途重用、過期、撤銷版本過舊、未知 key id、簽署金鑰輪替與更新失敗皆拒絕；平台逐請求重驗作品 live 狀態、授權、配額與限流。私鑰不得出現在 works-edge 設定／產物／日誌；公鑰僅驗章。 |
| B2 殘餘風險 | 以演練記錄 works-edge 遭入侵且已持多個上線作品有效授權時可觸及的資料範圍；不得將結果描述為 B2 完全阻止跨作品濫用。 |

MVP 只有涵蓋完整現行範圍的一個 Readiness Gate；後續 β2 另 Gate。2026-10-21「本輪不執行 Tasks／Analyze」保留為歷史；2026-10-22 已授權文件收尾、Tasks 與 Analyze，不執行 Implement／Gate，原有上線條件不變。

### 0.1 四類正式驗證矩陣（2026-10-22；V-56／V-57 現行展開）

**與實作前 Gate 的分界（2026-10-22）**：以下四類結果需產品端點實作後取得，屬 T127～T131 的正式產品驗收及後續上線條件；Readiness 檢查完整測試設計、責任、核定安排與 Gate 前適用可行性，**不要求先完成這四類結果才批准實作**。單一 Gate 完整範圍、各矩陣內容、原 PP-20～27 核定時點與 fail-closed 均不變，不另開子範圍 Gate。本輪四類正式測試仍全部未執行。

以下全為**已定義的測試設計，產品測試全部〔尚未執行〕**。正式環境建立、資源使用與測試執行須另取得適用授權；本表不授權建立資源。技術負責人提出測試方案與候選政策，**教育者核定**；Tasks 只整理提案，不可自行批准。任何待核定數值均無預設值，不借用 Spike 數字。

**共同證據規則**：依環境、案例、版本與執行批次保存去敏的設定摘要、合成 seed、案例／失敗清單、時間戳及原始量測、彙總公式、樣本實收數與缺失原因；記錄程式／產物雜湊、供應商實際方案／區域、目標瀏覽器完整版本與裝置政策。HAR、截圖、錄影及日誌須先遮蔽 cookie、權杖、Authorization、URL 查詢憑證與供應商憑證；不保存真實兒童資料、明文會話或密鑰。證據保存位置由執行任務記錄，保存期限依 D-10 待核定，不預設永久。

| 類別／來源 | 測試環境與合成資料 | 樣本量與分層 | 量測起訖點 | 應保存的證據 | 通過門檻、核定者及時點 | 失敗／未核定時 fail-closed |
| --- | --- | --- | --- | --- | --- | --- |
| ① 正式 TLS、跨站 iframe／分區 cookie；V-53(a)～(l)、(n)～(o)，V-56／V-57 A1；FR-010、039、040；AC-05、15、27；SC-005、011、012、017 | 經另行授權的隔離 `test` web／works-edge，使用實際不同可註冊網域與有效萬用字元 TLS；不是 localhost／自簽憑證替代。PP-24 核定的瀏覽器／完整版本（包含 Safari／Firefox 目標的決定，不假定支援）、OS、學校受管裝置／網路政策，逐格測預設、封鎖第三方 cookie、隱私模式。合成學生／已綁定教師、兩個不同 origin 預覽、靜態 A／Work Data B、錯誤與偽造會話 | 每個核定瀏覽器×OS×裝置政策×隱私設定×角色×流程／拒絕類型逐格覆蓋；每格重複次數、裝置台數與總 N **待核定**；技術負責人於執行前提案，教育者核定；未測格不宣稱支援 | 從使用者觸發預覽及簽發／兌換開始，記錄 TLS／cookie 設定與每次 HTML、子資源、重載、頁內導覽、放大及資料請求，到對應版本可互動或可及的拒絕提示；另記無／錯分區／偽造 cookie 請求發送到拒絕完成 | 去敏 cookie 屬性檢查（不存值）、憑證／DNS 結果、網路／CSP 拒絕紀錄、逐格 UI／鍵盤證據、跨 origin 儲存及對話框限制；用版本雜湊對照，不以供應商頁面代替實測 | PP-24 支援名單：教育者於 V-53 執行前核定；樣本方案執行前核定。既定判準：無效會話即使 hostname 正確也 **0 件取得內容／資料**；支援格流程符合 V-56／57；必要 cookie 被阻擋則明示不支援、不判為成功支援。效能數值依 PP-25 **待核定** | 未列版本、TLS／必要分區 cookie 或跨站行為不符時不簽發／不續用該預覽、顯示「暫不支援互動預覽」，不降級 hostname 授權或改架構；保留編輯草稿 |
| ② 會話撤銷、到期與邊緣快取上界；V-53(m)、V-56／V-57 A1；FR-014、038、040、052；AC-05、12、22；SC-001、005、020 | 正式 TLS 的 `test` web／works-edge、核定目標瀏覽器；實際跨區／PoP 與冷／暖／陳舊快取，注入平台不可達、狀態查詢失敗與時鐘偏差。合成 owner／teacher／兩個隔離會話，覆蓋解除綁定、擁有者或教師停用／刪除、關閉、專案刪除、審查結束／申請撤回、手動撤銷、新預覽取代、自然到期 | 每個撤銷觸發×角色×地區／PoP×快取狀態×HTML／子資源／Worker／重載／資料 API 逐格覆蓋；地區清單、重複次數與總 N **待核定**，執行前由技術／安全負責人提案、教育者核定 | 撤銷以平台權威狀態交易提交時間 t0，到每條路徑最後一次允許回應／首次及持續拒絕 t1；到期以伺服端 expires_at 為 t0。同步記錄時鐘誤差、請求間隔／觀察窗口（皆 **待核定**），含傳輸中請求與跨區快取；不得用 sandbox destroy API 返回當撤銷完成 | 去敏權限／epoch 交易時間、快取設定／命中狀態、每請求開始與回應時間／拒絕碼、p50／p95／max 與最壞上界計算；注入故障與恢復證據；明示已載入內容不可收回 | PP-22 TTL、PP-23 最大失效上界（含所有快取）由平台／安全負責人提案、教育者於 Gate 前核定，正式驗收前驗證；所有路徑 **0 件超出核定上界仍獲內容／資料**；量測精度／樣本方案亦須執行前核定。數值均 **待核定** | TTL／上界未核定不簽發／續用；狀態不可驗或無法保證上界即拒絕服務；不延長快取、不依賴沙箱 TTL 或銷毀；已保存產物也須拒絕存取 |
| ③ 20 人尖峰、冷暖／大小產物、排隊／錯誤率／費用；V-56、S-04／S-15、V-42；FR-010、026、040、042、055；AC-05、11、13、25；SC-005、009、023 | 經批准方案與區域的隔離 `test` web／worker／works-edge／資料庫／產物儲存，與實際供應商控制面整合；記錄 Team 的付費／試用與實際限制，不將試用 Team 當付費 Pro。合成 **20 位**學生同時保存／建置／互動預覽，靜態 A／Work Data B；PP-20 合法大小邊界、接近上限及超限產物，故障／取消／亂序工作 | 20 人是既有規劃尖峰，不是已核定可接受能力；冷／暖×小／大×A／B 各格均跑 20 人同時負載；輪數、間隔、持續時間、每格 N、小／大大小分界及混合背景負載 **待核定**。技術負責人於尖峰驗收前提出並由教育者核定 | 用戶保存觸發→保存確認→排隊開始／出隊→建置→取回→驗證→保存產物→版本綁定→iframe 對應版本可互動；各段及端到端 p50／p95／max；錯誤率分母含全部提交工作（失敗／取消／限流另列，不只成功者）。費用從批次前用量快照到批次後供應商入帳／對帳完成，觀察延遲窗口 **待核定** | 每工作合成 request id／雜湊、分段時間、排隊長度、429／逾時／失敗與取消分布、成功及失敗樣本數、取回吞吐、控制面競爭、實際用量與單價日期／帳單差額／試用抵扣分開；可重算每次、每生及課堂費用 | PP-20／21 最遲 Gate 前核定；PP-25 延遲、錯誤率、排隊與費用及樣本方案由教育者於尖峰驗收前核定；**均待核定**。既定：0 件假成功、未檢查產物服務或亂序倒蓋；未核定只回報量測，不判通過 | 超限整份拒絕；逾時／取消不綁產物，按核定 PP-21 清理並明示失敗／重試，保留草稿與最後成功預覽。未達／未核定 PP-25 不宣稱支援 20 人、不開放課堂試行；不挪用未動用公開 AI 池、不自動增加預算或降級功能 |
| ④ B2 更新、逐請求拒絕、輪替與配額；V-57 B2、V-53(f)～(g)、(p)、V-56；FR-038～043、048；AC-12、18、25、27；SC-001、009、012、016、023 | 正式 `test` works-edge→web 受限 Work Data RPC，配合 A1 預覽隔離命名空間；只用合成 A／B 兩作品、多授權與合成內容。注入更新／簽發失敗、平台不可達、陳舊 live 快取、授權篡改、跨作品／用途、過期／重放／撤銷版本錯誤；模擬 key id 發布、重疊期／退場及緊急撤銷；works-edge 多有效授權入侵演練，不保存私鑰 | 每個讀／寫／刪用途×兩作品×公開／預覽×有效／無效授權×輪替前中後逐格覆蓋，配額測核定界線下／等於／超過及並行競爭；重複次數、並行數、總 N／重放與時鐘偏差窗口 **待核定**，平台安全負責人提案、教育者於執行前核定 | 從授權簽發／更新嘗試或輪替／撤銷提交開始，至每筆資料請求平台重驗及交易提交／拒絕完成；配額從同批次前計數到並行完成後原子計數／費用對帳；觀察舊授權最後允許與停止時間，不能以 edge 驗章成功代替平台重驗 | 去敏 claims／key id（無授權原值）、當時 live／revocation_version、每請求決策碼、資料前後雜湊、配額計數／費用、輪替發布及緊急撤銷稽核／告警；額外記錄 edge 已持多作品有效授權可觸及範圍，不冒稱完全防跨作品濫用 | PP-26 儲存／請求／限流／費用配額與 PP-27 輪替週期、重疊窗口、緊急責任由平台／安全負責人提案、教育者最遲 Gate 前核定；樣本方案執行前核定，數值 **待核定**。既定：每筆平台重驗；無效／非 live／超額／更新失敗 **0 件資料取得或修改**；簽署私鑰／全域資料 HMAC **0 件在 works-edge** | 更新／平台／驗章失敗、未知／撤銷 key id、到期／版本不符皆拒絕；配額未核定拒絕所有相關資料請求；輪替政策未核定不啟用寫入授權；不沿用過期授權、其他作品授權、暫存資料或成功形狀預設值 |

**證據不可替代**：VC-1～VC-3、本機 Chrome／Edge／TLS／iframe／撤銷數據、8 並行與試用 Team 的控制面／費用資料只可作研究輸入，不能填入本表的正式通過結果。四類共同狀態＝**已定義／數值與樣本方案待核定／尚未執行**；非數值的既定拒絕規則維持，不另開 A1／B2／X 架構選擇。

| 前置 | 說明 | 狀態 |
| --- | --- | --- |
| 教育者階段批准 | 憲章與專案指引：通過 Readiness Gate 仍須教育者明確批准實作階段 | 尚未取得 |
| 環境分離 | `dev`／`test`／`prod` 各自獨立的 Supabase 專案、Vercel Team／專案、OpenAI Project；**測試與開發資料一律為合成資料，不含真實兒童資料或個資** | 尚未建立 |
| 設定變數清單 | 僅列**名稱**於 `.env.example`（例：`SUPABASE_URL`、`SUPABASE_PUBLISHABLE_KEY`、`SUPABASE_SECRET_KEY`〔伺服器端〕、`OPENAI_API_KEY_INTERNAL`、`OPENAI_API_KEY_PUBLIC`（**2026-10-21 範圍決定：公開 AI 已被取代・首版不適用；預覽與公開環境不注入任何 AI 金鑰，首版不建立此項；原名稱保留作歷史**）、`LOG_PEPPER`、`WORKS_STATE_HMAC_KEY`、`SANDBOX_PROVIDER_TOKEN`、`WORKER_DB_URL`）；**不含值**；密鑰只存於 Vercel／Fly／Supabase 的受保護設定 | 尚未建立 |
| 工具鏈 | Node.js 24 LTS、套件管理員鎖檔、Supabase CLI（migration 與 pgTAP）、Playwright、Vitest | **本輪未安裝** |
| 回復步驟 | 每個環境保留「還原前快照／資料庫還原＋重新套用刪除 tombstone」程序；部署採「失敗保留舊版」 | 設計於 data-model §9.4，尚未演練 |

## 1. 技術查證與可行性驗證（Spike；先於相關階段；結果須回報教育者）

| # | 目的 | 作法（摘要） | 通過標準 | 阻擋什麼 |
| --- | --- | --- | --- | --- |
| S-01 | 方案 A：合成電郵相容性＋重發後舊登入碼失效（合成資料；設計見 §1.1） | 在 `dev` 專案以管理 API 建立使用合成網域電郵的測試使用者並登入；重發後以舊碼登入 | 建立與登入成功；不寄出任何郵件；重發後舊碼 100% 失敗、新碼成功 | P1；若失敗→改用可行網域；仍失敗→提報方案 B／C（D-07a，交教育者重新決定） |
| S-02 | 方案 A：同校共用網路下的節流＋登入錯誤不洩漏帳號是否存在（合成資料；設計見 §1.1） | 驗證 `Sb-Forwarded-For` 啟用條件與效果；模擬 30 位同校 NAT 學生同時登入；量測未知帳號／錯誤碼／舊碼的回應差異 | 不因共用出口 IP 而互相被限速；BFF 節流（帳號×IP 雜湊）有效；各錯誤情境回應與耗時不可區分 | P1；PP-03 數值提案的依據 |
| S-03 | 方案 A：舊 access token／session 的資料層阻擋（停用、標記刪除、重發；合成資料；設計見 §1.1） | 登入→停用／標記刪除／重發→以**舊 access token** 呼叫各受保護端點與直接資料查詢；驗證 refresh | 停用／刪除：全部被 RLS／閘門拒絕，refresh 失敗；重發：舊 session 被拒，或如實回報殘留視窗 | P1（FR-038、SC-001） |
| S-04 | 沙箱與 Worker 成本實測 | 以合成專案與腳本化學生行為（建置、測試、預覽）跑 1 個上課日規模；記錄每次 CPU／記憶體／時間／建立次數 | 以官方單價重算 [research.md](./research.md) R-09 的基礎設施池表，更新三情境；產出「每生每日沙箱分鐘」建議配額 | P4；D-12（降低單位成本的比較實測見 S-15） |
| S-05 | 沙箱出站阻擋 | 在沙箱內嘗試連線：`169.254.169.254`、RFC1918 範圍、`localhost`、平台內部網域、任意外部網站、允許清單內的 npm registry；**（2026-10-21 補列，預覽入口方向）另自沙箱外、不帶權杖，以 `startPreview` 取得的供應商預覽位址與任何其他可得的預覽網址／埠直接連線，確認瀏覽器無法繞過 works-edge 預覽模式（publishing 契約 §3.1 成立前提）** | 前四類**全部失敗**、清單外失敗、清單內成功；**預覽入口方向：所有繞過 works-edge 的直連嘗試必須全部失敗，任一可達即 §3.1 前提不成立（結果〔尚未實測〕，不得寫成已通過）** | P4（Readiness 阻擋；FR-040；預覽前提併入 V-53(c)） |
| S-06 | 內容安全評測 | 以**合成**語料（不使用真實兒童資料）建立評測集：不適齡請求、一般求助、高風險求助、中文口語與錯字、提示注入；量測 Moderation＋分類器的漏判／誤判 | 產出混淆矩陣；**不宣稱零誤判**；門檻與人工覆核流程交教育者／專業審閱（D-14） | P2 |
| S-07 | 下架延遲量測 | 在 `test` 作品託管環境對多個地區／快取狀態量測：狀態改為 `stopped` 後到入口回 410 的時間分佈（p50／p95／最大） | 回報實測值；與 PP-01 目標比較；**由教育者核定可接受上限（D-08）**，未核定前不宣稱 SC-015／018／020 通過 | P5 |
| S-08 | 還原演練 | 還原備份到暫存專案→執行「重新套用刪除」→驗證已清除帳號不復現；驗證 Storage 物件不在備份內的行為 | 已 purge 的帳號 0 筆殘留；流程文件化 | P1／P6 |
| S-09 | 供應商條款與 ZDR 啟用佐證查證（文件作業） | 依 D-18 清單逐項取得書面條款／申請結果／OpenAI 組織 Data Retention 設定的啟用佐證（不含密鑰） | 取得結論並由法務／教育者核定；**目前尚未取得已啟用 ZDR 的佐證，啟用關卡未通過；`store:false` 不能代替**；未完成前學生 AI 功能維持關閉 | TL |
| S-10 | 作品網域隔離 | 兩個作品子網域互相嘗試讀取 localStorage／寫共用 cookie；PSL 登錄前後比較 | 無法讀取對方儲存；cookie 干擾僅限已知範圍；PSL 狀態記錄 | P5（K-06） |
| S-11 | 中文輸入法與編輯器 | 在 Monaco 與對話輸入框以中文輸入法組字、Enter、Shift+Enter | 組字期間 Enter 不誤送；換行保留 | P2／P3（SC-003） |
| S-12 | Supabase Realtime／綁定提示即時性 | 綁定／解除後學生端提示更新延遲 | 不需重新整理；記錄延遲 | P1（US 8） |
| S-13 | **B 級受限伺服器端能力（β2）隔離、配額與成本驗證**（D-16；合成作品；需教育者另行授權建立 `dev` 資源） | 以合成「不受信任」學生伺服器程式（惡意迴圈、記憶體耗盡、嘗試連線 `169.254.169.254`／RFC1918／平台內部網域／任意外部網站／**生成式 AI 服務網域與平台 AI 代理端點（2026-10-21 範圍決定補列）**、嘗試讀取環境變數與平台憑證、過量請求、寫入超量資料）在候選執行環境（Plan 候選：沿用隔離沙箱類 microVM 按需執行；其他候選如隔離型邊緣執行平台〔**尚未查證**〕；**一般平台 Function 僅在實測證明足夠隔離前不得採用**）逐項測試；量測冷啟動、單位成本（每千次請求、每作品每月）、與下架（停止服務）延遲 | 逾時、記憶體、儲存、請求數**100% 被強制**；出站**全部失敗**；0 件取得平台憑證或資料庫；下架後新請求 0 件通過（延遲回報）；單位成本可由實測重建；結果**標示通過／失敗**。**未通過或成本不可負擔→記錄證據與影響，退回教育者作範圍決定，不自行縮減範圍** | P5 5b（D-16；PP-19 數值提案的依據） |
| S-14 | 通知郵件供應商比較與寄送驗證（D-14、D-17；文件作業＋合成寄送） | 文件比較：可用性、資料處理（兒童資料、DPA、資料落地）、費用、寄送失敗回報；經教育者另行授權後，以合成電郵與合成事件驗證「同步嘗試寄送、失敗仍留站內列表並提示管理員」 | 產出比較表交教育者；**未選定供應商前，輔助電郵視為不可寄送（`email_state=not_configured`）**，不得宣稱 D-14 的輔助郵件可用 | P2；TL（供應商條款） |
| S-15 | **D-12 成本降低比較實測**（擴充 S-04；合成課堂情境） | 以**同一合成課堂情境**（~~A／B／C~~ 首版 A／B 已批准功能各至少完成一件作品流程；【已被取代・首版不適用（2026-10-21 範圍決定）】首版無 C 級作品流程）比較：① Agent 模型（`gpt-5.3-codex`、`gpt-5.4-mini`、`gpt-6.1-sol` 等）與每任務呼叫輪次；② 沙箱規格（2 vCPU／4 GB 對 1 vCPU／2 GB）與使用分鐘、活躍 CPU 比例；③ 排隊／並行上限對尖峰 20 人的等待時間；④ 候選沙箱供應商費用（Vercel Sandbox 對 E2B，含亞太區域費率）；記錄每方案的單位成本與課堂**完成率**（教學可用性） | 產出比較表：每方案的月度成本（以 R-09 公式重建）與「~~A／B／C~~ 首版 A／B 已批准功能是否仍可完成」；**不核定任何額度或配額**；公開 C 級 AI 池 US$150 為原規劃、首版不動用，**不納入比較範圍，也不得用它宣稱創作池或基礎設施池的超額已被抵銷**；**若無法兼顧教學可用性與初始規劃值，結論交教育者決定是否調高預算或調整試行規模** | P2（模型與輪次）／P4（沙箱）開工前（D-12） |

### 1.1 S-01～S-03 合成資料驗證設計（D-07a 方案 A 的實測條件；**全部〔尚未執行〕**，本節只是設計，不是結果）

**D-07a 狀態＝已選首選驗證方案，附實測條件**（教育者 2026-10-21）。本節三個 Spike 通過，**只代表方案 A 的技術可行性獲得證據**，不等於已批准登入碼長度／效期／限速數值、付費資源或 Plan 定稿。

| 通則 | 內容 |
| --- | --- |
| 執行前置 | ① 教育者另行授權執行 Spike 並建立 `dev` 供應商專案（**本輪未授權、未建立**）；② 僅用合成資料：帳號如 `sim-s-001`、合成登入碼由測試腳本隨機產生、用後銷毀、合成電郵為 `<隨機 uuid>@<候選網域>`；**不使用真實學生、教師、學校資料或真實電郵**；③ 不設自訂 SMTP、以 `email_confirm=true` 建立，確保不寄信；④ 模擬來源 IP 一律使用文件保留位址（RFC 5737：192.0.2.0/24、198.51.100.0/24、203.0.113.0/24）；⑤ 密鑰只存在受保護設定，結果紀錄不含密鑰、登入碼明文、JWT、原始 IP |
| 結果記錄 | 每案標示「通過／失敗／未執行／待人工確認」、日期、環境、套件與供應商設定版本、證據摘要（不含上列敏感內容） |
| 失敗分流 | 任一案失敗：先嘗試在方案 A 內修正（例如改用其他候選網域）；仍無法修正→**D-07a 重開，列出方案 B／C 與影響（research.md R-01）交教育者重新決定；不自行改採、不自行更換 Auth 供應商** |

**S-01 合成電郵相容性＋重發後舊登入碼失效**

| 案例 | 步驟 | 通過標準 |
| --- | --- | --- |
| S-01-1 候選網域 | 依序以 `.invalid`、`.test`、`.example`（RFC 2606 保留網域，不可能有真實信箱）建立合成電郵使用者（`email_confirm:true`、密碼＝合成登入碼）並 `signInWithPassword`。若全部被拒，才向教育者提案專用網域（需購買網域＝付費資源，未授權） | 至少一個候選建立與登入成功；記錄採用網域；Auth 郵件寄送事件 0 筆 |
| S-01-2 密碼規則 | 設定最小長度＝碼長、不強制字元類型；以候選格式（10 字元 Base32 含連字號與大小寫正規化；5 詞格式）建立 | 皆被接受；正規化前後一致；長度上限檢查生效 |
| S-01-3 唯一對應 | 同一 handle 重複核發；handle 大小寫差異；合成電郵碰撞 | 第二次被拒（`409 handle_taken`）；一個 handle 對應唯一合成電郵 |
| S-01-4 重發後舊碼失效 | 碼 A 登入成功→重發為碼 B→以碼 A 登入→以碼 B 登入 | A 100% 失敗、B 成功；管理畫面、日誌、稽核、通知 0 處含 A 或 B 明文 |
| S-01-5 重發中斷 | 依下方逐階段驗收，涵蓋 Auth 前失敗、明確未套用、套用後 DB 失敗、外部 unknown、DB 完成回應遺失、reveal 前後 crash、重送及並行晚到（對應 V-10） | 分驗 Auth 接受何碼／人是否持碼／舊新 session 資料權／狀態暫停與恢復前提／同鍵不重播；unknown 不宣稱舊碼可用。**全部〔尚未執行〕** |

<a id="s-01-5-staged"></a>
**S-01-5／V-10 逐階段驗收（2026-10-26；D-32 必要同步）**

依 [D-32](./decision-register.md#d-32-a-9-已批准契約原則與必要正式文件同步2026-10-26台灣)／[AUTH §2](./contracts/auth-and-identity.md#2-登入流程不變式需有自動化測試)，下表是驗收要求，**每案均〔尚未執行〕**。文件同步、歷史 §70 直接改碼結果或關鍵字出現都不能算本表通過；供應商能力／正式設計不足時標 blocked，不假裝已有 terminal／取消／冪等能力。不得在此文件保存實際碼、token／claims／session 原值。

| 階段／故障 | Auth 密碼層接受何碼、平台知道什麼 | 人是否持有可用碼 | 舊／新 session 的產品資料權 | 操作狀態、暫停與恢復前提 | 同鍵／輸出驗收 |
| --- | --- | --- | --- | --- | --- |
| Auth 前失敗 | 證明本操作尚未送出；DB 準備 COMMIT 回應遺失先查狀態，不把它當從未送出 | 原碼是否仍持有另記，不推定外部獨立操作沒改碼 | 未有暫停時仍依原 gate；已提交暫停不任意放行 | 可信未送出、無相依在途、平台狀態及獨立 gate 核對後才可清理 | 同鍵查最小非秘密狀態，不能另鍵繞未結操作 |
| 可靠確認未套用 | 原操作 terminal 證明未改密碼，不用任意 5xx 代替；舊碼可驗仍須控制證據 | 分別記原持碼與實際可驗，不保證全域未變 | 暫停內兩者拒；解除另驗相依在途／舊 session 阻擋要求及平台完成 | 可終止／清理本操作，不回重發成功；新操作另核身與重驗授權 | 非秘密 receipt；不重打同一 Auth 操作 |
| Auth 已套用、DB 完成失敗 | 可信已套用證據；舊碼拒、新碼可驗與平台完成分開 | 新碼可能只在記憶體或已遺失 | 暫停內兩者拒，不因 Auth 成功開資料 | 只向前恢復平台 DB，不重送 Auth／回滾外部密碼；解除要全部證據 | 同鍵不重播；碼遺失依核准條件重新核身與新操作 |
| 外部 unknown：實際已套用／未套用兩種同觀測 | 分案控制實際狀態，但平台不能由相同 timeout 推論；不能宣稱舊碼有效 | 可能無人持有可用碼，與 Auth 有可驗密碼分開 | 目標學生身分的受保護資料、新產品登入、平台 refresh 均維持暫停；原生 token 不授權 | 不回成功、不盲重發；缺原操作可信 terminal 或不再可能寫入證據持續暫停，可能長期不收斂 | 只非秘密 unknown／處理狀態；新鍵不能繞過 |
| DB 完成、回應遺失 | 核對 Auth 已套用與 DB 完成提交證據；成功舊碼拒、新碼可驗 | DB 完成不代表人收到碼，可能零交付 | 舊 session 阻擋獨立驗；新 session 只有在解除條件與 account／school／ownership 均成立才可用 | 同鍵查已提交狀態，不把 response loss 當 Auth 未套用；無碼走核准恢復 | 不重播碼、不再次執行 Auth，receipt 仍當下重驗資格 |
| reveal 門閂前／後 crash（各分案） | 按最後可信階段記錄，不由程序重啟猜成功 | 門閂後送出前 crash 仍可零次交付；送出後不等於人看見 | 未完成仍暫停；完成後舊拒／新依獨立 gate，不以輸出判權 | 驗門閂先消耗後輸出、最多一次機會；記憶體遺失不可還原原碼 | 重送只非秘密狀態；不得以 ACK／「已顯示」保證恰好一次送達 |
| 同鍵同內容／異內容重送、改權限與新鍵 | 不產生第二 Auth 意圖，內容／主體／目標作用域不得混淆 | 不再次取得原碼 | 重送仍重驗當下授權與暫停，不以 receipt 授權 | 同鍵異內容沿既有拒絕；權限撤回不得見不該見狀態；新鍵／鍵到期不得繞未結操作 | 秘密不進一般結果 cache；不重播、至多一次機會 |
| 並行晚到改碼／登入／refresh、停用／標記刪除 | DB generation 只能擋過期 DB 提交，不能證明 late Auth 不再寫入；分驗晚到覆寫風險 | 平台預期碼與人所持碼都須對照，不猜最終密碼 | 暫停須涵蓋目標學生所有受保護路徑；停用／刪除／學校／ownership 獨立拒絕不被重發解除 | 相依在途可信終結＋舊 session 阻擋＋平台完成證據齊備才解除；timeout／租約／人工按鈕單獨不足 | 不以新鍵或人工重送繞過；供應商能力未證明即 blocked |

每案還須核對合法已綁定教師／管理員核身、R-a、稽核去敏、未受影響帳號控制。教師獨立合法檢視、公開作品、背景／跨角色委派、在途排序、TTL／logout scope／最大撤銷時間／cache、保存／清除及責任／時限仍待完整設計與另批驗收，本表不替其定案。可恢復性證據、具名主責／備援與支援安排未齊不得啟用；不承諾自動恢復或未核定服務時限。

**S-02 同校共用網路節流＋登入錯誤不洩漏帳號是否存在**

| 案例 | 步驟 | 通過標準 |
| --- | --- | --- |
| S-02-1 IP 轉送 | 在 `dev` 啟用 IP 轉送設定；BFF 以 secret key 帶 `Sb-Forwarded-For`（模擬來源 IP）呼叫登入；對照組為未轉送 | 啟用後 Supabase 側限速以模擬來源 IP 計；對照組重現「全校共用 BFF 出口 IP」風險；secret key 呼叫隔離於單一伺服器模組，且**不在該高權限 client 上沿用使用者 session**（官方：publishable 與舊版金鑰不支援轉送） |
| S-02-2 同校共用網路 | 30 位合成學生共用同一模擬出口 IP，60 秒內各以正確碼登入一次；對照 30 個不同 IP | 30／30 成功，未被 Supabase 或 BFF 的 IP 桶阻擋；若 PP-03 建議的「IP 雜湊每分鐘 20 次」會擋下，**回報並提出調整建議，不自行改值** |
| S-02-3 惡意輸錯 | IP-A 對學生 X 連續輸錯至進入節流；X 從 IP-B 以正確碼登入；X 從 IP-A 登入 | IP-B 成功；IP-A 依漸進延遲被延後但**非永久硬鎖**；`429` 帶 `Retry-After` |
| S-02-4 節流鍵內容 | 檢查 `login_throttle` 與 BFF 日誌 | 只有 HMAC 鍵；無原始 IP、帳號字串、登入碼 |
| S-02-5 不洩漏帳號是否存在 | 各 ≥200 次樣本：未知 handle、已知 handle 錯誤碼、已被取代的舊碼、停用帳號的錯誤碼；比較狀態碼、本文、標頭、耗時分佈（p50／p95）；比較相同嘗試次數下 `429` 的觸發時點 | 狀態碼、本文、標頭一致；耗時差異低於**執行前訂定的容許值**（本設計不先定數值）；`429` 觸發時點一致 |
| S-02-6 供應商處理的來源 IP | 記錄轉送的 IP 流向與保留位置 | 登錄為供應商處理的個資（plan.md「資料最小化規則」），納入條款核對 |

**S-03 舊 access token／session 的資料層阻擋**

| 案例 | 步驟 | 通過標準 |
| --- | --- | --- |
| S-03-1 停用 | 取得 session A（access＋refresh）→管理員停用（`ban_duration`＋`status=disabled`）→以 A 的**舊 access token**：(a) 呼叫各受保護 BFF 端點；(b) 直接以 PostgREST／RPC 查詢；(c) 申請 Storage 簽名 URL；(d)（若採用）Realtime 訂閱；並嘗試 refresh | (a)～(d) 全部被拒；refresh 失敗 |
| S-03-2 標記刪除 | 同 S-03-1，改為標記刪除 | 同上 |
| S-03-3 重發 | session A（舊碼）→重發→以舊 access token 與 refresh 重試 (a)～(c)；評估候選機制：M2（`session_id` 與登入碼版本綁定）、M3（`auth.sessions` 存在性）；並測管理端改密碼是否終止既有 session | 舊 session 於資料層被拒；**若皆不可行，量測殘留視窗並回報，由教育者決定是否接受（不隱含接受）** |
| S-03-4 殘留視窗 | 在 PP-04 建議值（10 分）與官方建議下限（5 分）量測舊 access token 實際可用時間 | 記錄實測值，供 PP-04 提案 |

## 2. 端到端驗證情境（對應 AC；使用合成帳號與合成資料）

> 所有情境結果須如實標示：**通過／失敗／未執行／待人工確認**（憲章 VIII）。

### 2.1 學校核准、登入與 AI 閘門（AC-16、AC-21；SC-014、018、019）

| # | 步驟 | 預期 |
| --- | --- | --- |
| V-01 | 建立四所學校，狀態分別為 `unconfirmed`、`approved`、`withdrawn`、`expired`（`expired` 以人工轉態；**D-04 未決，不測自動逾期**），各有一名已批准學生 | — |
| V-02 | 四位學生以正確登入碼登入 | `unconfirmed`：被拒、無 session、顯示文字說明；其餘可登入；用錯碼登入皆得相同的一般錯誤 |
| V-03 | `approved` 學生：送出對話、生成圖像、網頁搜尋、啟動 Agent | 成功（受額度與內容安全約束） |
| V-04 | `withdrawn`／`expired` 學生：同上四項（含**直接呼叫 API**與**背景工作重試**） | 一律被伺服器端拒絕（`ai_not_open`）；進行中的背景工作於下一重要步驟停止；已保存內容可讀可編輯、可下載自己成果；「發布」顯示「新的公開部署暫停中」 |
| V-05 | 管理員撤回某校核准；該校有：公開作品（首版全為不含作品執行時 AI 者）、待審申請、已批准未部署申請〔**2026-10-21 範圍決定：原「公開 C 級作品（測試用 AI 閘門旗標模擬）」與「C 級頁面依 D-01 `keep_public`／`stop_public` 各測一次」已被取代・首版不適用；原文保留作歷史：~~公開 C 級作品（測試環境以測試用 AI 閘門旗標模擬）；C 級 AI 暫停；C 級頁面行為依 D-01 設定值分別以 `keep_public`／`stop_public` 各測一次~~**〕 | 該校**全部**公開作品**立即**進入 `stopped(school_approval_withdrawn)`；新公開部署被擋；稽核含操作者、時間、學校、作品清單；待審／已批准申請依 D-03 的 α／β 各測一次。**〔尚未執行〕** |
| V-06 | 教師嘗試登錄／恢復核准 | `403`＋安全事件；0 次成功 |
| V-07 | 管理員 `restore`（記錄文件版本） | 校級阻擋解除；**所有既已 `stopped` 的作品維持 stopped**；~~C 級 AI 依 D-02 設定值：`auto_release`（hold 釋放）或 `require_rereview_redeploy`（hold 保留至新部署成功）各測一次；畫面文字不暗示 C 級 AI 已自動恢復~~【已被取代・首版不適用（2026-10-21 範圍決定）；原文保留作歷史；D-02 保留為後續版本待決】。**〔尚未執行〕** |
| V-08 | 未附文件版本的 `restore` | 被拒（`422`） |
| V-09 | 學生登入碼：重發後以舊碼登入；查詢管理畫面、日誌、稽核、通知是否含原碼；未綁定教師重發；連續錯誤登入（方案 A 端到端；技術前提見 S-01、S-02） | 舊碼 100% 失效；原碼 0 處可見；未綁定教師被拒；限速生效且不洩漏帳號存在 |
| V-10 | 執行 [S-01-5 逐階段矩陣](#s-01-5-staged) 全部故障與競態；分驗 Auth 密碼層、人持碼、舊新 session 資料權、非秘密狀態／暫停與恢復、同鍵秘密例外（含 S-03-3） | 成功後舊碼拒、新碼可驗；已套用後只向前恢復；unknown 不回成功、不保證舊碼可用、缺可信終結證據不重發／解暫停；輸出最多一次機會、可能零次交付；同鍵不重播秘密。舊 session 資料阻擋獨立驗，殘留量測不等於接受或解除暫停。**全部〔尚未執行〕** |

### 2.2 教師權限、停用凍結與複查（AC-12、22、24；SC-001、020、022）

| # | 步驟 | 預期 |
| --- | --- | --- |
| V-11 | 已綁定／未綁定教師各自以直接呼叫存取學生專案、對話、檔案 | 已綁定可；未綁定一律 `404`；每次開啟寫稽核（不含內容） |
| V-12 | 管理員解除綁定後教師立即再存取 | 新的存取立即被拒；管理員可於稽核核對先前查看紀錄 |
| V-13 | 停用學生；已綁定教師嘗試查看專案／對話 | 被拒（`view_frozen`）；教師列表顯示「已停用——查看已凍結」；**停用當時綁定快照存在** |
| V-14 | 停用當時已綁定教師提出帳號複查；停用前已解除綁定的教師、停用後才綁定的教師、其他教師提出 | 僅第一種成功；成功者**只能**讀複查狀態與回覆，0 次取得學生資料；同一處置第二件被拒；超長或過頻被拒 |
| V-15 | 管理員恢復帳號（先預覽影響摘要，一次明確確認） | 資料保留；**綁定與舊公開作品不自動恢復**；教師仍被拒，直到管理員重新綁定；未確認不執行；操作者與時間已記錄 |
| V-16 | 刪除帳號：只做第一步確認 → 試圖啟動；再完成二次確認 | 第一步不啟動；二次確認後立即不可存取、公開作品下架、待審與已批准未部署申請失效；`purge_jobs` 完成；**排程表中無任何「停用滿 N 天自動刪除」** |
| V-17 | 模擬清除失敗 | 帳號仍不可存取；失敗可見、可重試；重試後完成 |
| V-18 | 清除完成後檢查稽核 | `audit_identity_map` 對照 0 筆殘留；稽核列中對外公開代號 0 筆；文件與畫面 0 處「完全匿名」；`object_ref` 無法解析到任何資料列 |
| V-19 | 被拒絕的教師／教師核發被拒的學生帳號提出複查；學生對退回／下架的作品版本提出作品複查 | 依 FR-054；複查**不自動恢復**任何權限或公開；學校撤回造成的停止公開**無作品複查入口**（D-05 預設） |
| V-20 | 個資請求：學生（學校管道＋綁定教師代提）、教師（管理中心）、無法登入者（學校管道）；停用學生經**凍結教師**代提 | 管理員皆可記錄並核對；**提出不觸發任何刪除**；與複查入口／紀錄分開；經凍結教師代提被拒（D-15 預設）；請求紀錄 0 件含不必要個資 |

### 2.3 創作、版本與審查部署（AC-01～AC-11、AC-17、AC-18；SC-002～008、015、016）

| # | 步驟 | 預期 |
| --- | --- | --- |
| V-21 | 首頁三卡＋直接輸入；草稿與附件在切換工具／開關選單／⌘K／離頁時保護；中文組字 Enter | 四條路徑皆可開始；0 件草稿遺失；0 次誤送 |
| V-22 | 兩種 Agent 模式執行同一修改並中途停止 | 行為實際不同；修改前有 `pre_agent` 快照；停止後顯示已完成／未完成與恢復方式；保存失敗不顯示假成功 |
| V-23 | 測試結果：部分 `not_run`／`needs_human`；新快照 | 不被標為通過；每筆標示版本；新快照不繼承舊結果 |
| V-24 | 恢復版本：保存目前版本成功／失敗兩種 | 成功才恢復且可找回；失敗不覆蓋 |
| V-25 | 提交 v1 後編輯成 v2；教師審查；批准；啟動部署 | 教師看到 v1 預覽與測試；僅 v1 可部署；內容雜湊不符時拒絕；「已批准」≠部署成功 |
| V-26 | 模擬部署失敗與逾時（結果不明） | 不顯示成功網址；舊公開版保留；進核對工作 |
| V-27 | 發布前提示未確認時送出；審查未完成可識別資料檢查時批准 | 兩者皆被拒 |
| V-28 | 需訪客登入／識別的 B 級；不需學生伺服器程式且使用平台 Work Data API 的合格 B 級；需學生伺服器程式的 B 級；A 級 | 第一種阻擋並顯示「首版不提供公開服務」；第二、四種依審查流程可公開，資料 API 同源且須 B2 授權與 PP-26 配額；第三種於 MVP 私人預覽與公開均 **0 件執行／部署**，回 `student_server_runtime_not_in_mvp` 並顯示後續獨立 feature 限制，不使用 `b_restricted_runtime_pending`。〔尚未執行〕 |
| V-29 | 下架／撤回後開啟公開網址；帳號停用、標記刪除、學校撤回各一次 | 平台控制入口停止存取（延遲量測見 S-07）；原因分開標示 |

### 2.4 公開 C 級受控 AI（AC-19、20；SC-017）〔【已被取代・首版不適用（2026-10-21 範圍決定）；原文保留作歷史】**V-30、V-32～V-35 不再是現行驗證情境**；**V-31、V-36 的核心檢查延續為首版現行（範圍調整，見各列）**；首版驗證另見 §2.8〕

> 本節 V-30、V-32～V-35 為歷史原文：首版學生作品僅 A／B，無公開 C 級 AI，故不驗證公開 AI 的七項控制、每作品上限、公開池、管理員公開 AI 開關、訪客高風險輸入與個資樣式；其結果欄一律不適用，**不得計入通過或覆蓋率**；SC-017、AC-19／AC-20 的公開 AI 部分同樣已被取代（見 spec.md）。**逐點對應首版**：V-30（七項控制閘門）→ 無對應（七項控制首版不建立）；V-32（每作品上限／公開池／並行）→ 公開池不適用，學生個人額度與創作池的並行與重試壓力改見 V-37；V-33（停用公開 AI）→ 無對應（首版無公開 AI 開關）；V-34（管理員測試公開作品 AI）→ 不適用，管理員內部測試歸創作池見 V-40；V-35（訪客高風險輸入）→ 不適用，學生高風險輸入見 V-43／V-44／V-50。**V-31（金鑰樣式掃描）與 V-36（文件與畫面不當宣稱掃描）仍適用於首版**（plan.md P5 退出條件與 K-21 引用 V-31、V-36），僅移除「公開 AI」前提。

| # | 步驟 | 預期 |
| --- | --- | --- |
| ~~V-30~~ | 七項控制未全數驗證時嘗試公開 AI | 被阻止；發布頁顯示「公開 AI 尚未開放」；0 個作品被標示「C 級已完整 Launch」（~~**後續決定：值守閘門是七項以外的獨立開放前提，另測 V-49**~~：V-49 亦已被取代・首版不適用） |
| V-31（首版現行；範圍調整） | 掃描學生作品前端、建置產物、下載檔、日誌、回應，以及預覽與 B 級受限環境的環境變數與設定中的金鑰樣式（AI 與其他金鑰；僅用合成作品）；**輔助掃描，不能保證發現所有金鑰或所有執行時 AI 呼叫**，與 V-52～V-54 的環境、審查檢查合併判讀 | 0 件；結果須標示掃描規則版本與涵蓋範圍，**不得寫成「已證明無任何 AI 呼叫」** |
| ~~V-32~~ | 逼近並超過每作品上限；超過公開池上限；並行同時請求 | 僅該作品被拒（`503 public_ai_paused`）；公開池用盡時全部被拒；0 件超額；**學生創作額度與創作池 0 變動** |
| ~~V-33~~ | 管理員停用單作品／全平台公開 AI | 下一請求即被拒；稽核 |
| ~~V-34~~ | 管理員測試已部署公開作品 AI | 計入公開池與該作品上限；池或上限用盡時被擋；**不得改用創作池** |
| ~~V-35~~ | 訪客輸入不適齡、高風險、含個資樣式 | 不適齡：替代引導；高風險：**固定求助引導、不呼叫模型**、建立僅含作品／時間／類別的事件並通知管理員、**不保存輸入全文**、不暗示已通知老師；個資樣式：攔阻或警示（D-13） |
| V-36（首版現行；範圍調整） | 掃描公開頁（A／B 級）、學生／教師／管理員畫面與文件是否出現「無任何個資或日誌」、「全天監看」、「即時救援」、「零誤判」、「24 小時有人處理」、「免除法定通報」，或把 C 級作品寫成「稍後開放」「分階段交付」（FR-048、FR-053、FR-049） | 0 處 |

### 2.5 預算與用量（AC-13、25；SC-009、023）

| # | 步驟 | 預期 |
| --- | --- | --- |
| V-37 | 並行與重試壓力逼近個人日額度、創作池（~~公開池~~ 已被取代・首版不適用；原規劃 US$150 首版不動用，不得作為額外額度或抵銷來源） | 0 超額、0 重複扣額；結果不明進核對；顯示值與伺服器一致；**創作池用盡不得改動用其他池（含未動用的公開池）** |
| V-38 | 模擬 Asia/Taipei 每日 00:00 與每月 1 日 00:00 邊界（以注入時鐘） | 換期正確；先前被阻擋的操作於換期後可再進行 |
| V-39 | 管理員調整個人額度／池分配／上限；非管理員嘗試 | 100% 記錄舊值／新值／理由／操作者／時間；僅影響後續預留；非管理員被拒並留安全事件 |
| V-40 | 管理員付費 AI 測試：`admin_internal_test`、~~`admin_public_work_test`~~（已被取代・首版不適用，無公開作品 AI）、其他用途 | `admin_internal_test` 依用途歸創作池並受額度；~~`admin_public_work_test` 歸公開池~~；**其他用途被拒（D-12 未決）** |
| V-41 | 基礎設施池估算與監測頁；達規劃值情境（模擬） | 僅顯示估算與差距；**目前無任何預設處置**（D-12 未決：不自動告警、不限制、不阻擋）；候選處置各自的行為待教育者核定後才建立測試案例；**不阻擋登入、已保存內容與已公開作品**（此為已批准的「基礎設施池僅估算與監測」） |
| V-42 | **可重現成本測算** | 依 R-09 的公式與單價，以 S-04 實測值重建三情境表；與帳本對帳（差異 >PP-06 告警）；**不宣稱保證不超支** |

### 2.6 內容安全（AC-23；SC-021）

| # | 步驟 | 預期 |
| --- | --- | --- |
| V-43 | 學生對話、圖像、Agent 各送：不適齡、一般求助、高風險求助 | 三類走**不同**回應路徑；不適齡內容不顯示且不重述；高風險顯示即時求助方向（固定、已審閱模板）；事件僅含類別／時間／對象／狀態 |
| V-44 | 高風險事件通知路由（D-14）：有可接收綁定教師／無綁定教師／電郵寄送失敗／電郵未設定／電郵送出成功 | 有→立即出現在該教師站內待處理列表；無→改派管理員；**電郵失敗→事件仍在站內列表、記錄失敗、管理員列表提示**；電郵未設定→`email_state=not_configured` 並提示；**電郵送出成功後 `handling` 仍為 `open`（不視為已接收或已轉交學校）**；可記錄接收與轉交；通知與事件 0 件含完整對話；電郵本文 0 件含類別、對象代號或對話；**〔後續決定取代，2026-10-21〕**「可記錄接收與轉交」改為「接收、處理、結案（`close`）」，`forward` 為選用外部聯絡紀錄，**不要求 `forward` 即可結案**（見 V-50） |
| V-45 | Moderation／分類器暫時故障 | 輸入 fail-closed，不放行未檢查內容；不顯示假成功 |
| V-46 | **〔後續決定取代，2026-10-21：升級計時改依 App 值守時段，改測 V-48～V-50；本列為第三輪原設計，保留作歷史，不再作為驗收依據；「該校 `school_handling_windows` 未設定」案例由 V-48 的「值守未設定」取代〕** **處理時段計時與升級**（D-14；**僅用合成時段與合成事件**）：時段內建立／時段外建立／跨假日／教師 1 處理時段小時內確認／逾時未確認／原收件者為管理員逾時／該校 `school_handling_windows` 未設定 | 時段內：自建立起計時；時段外：下一時段開始才計時；假日不計時；1 小時內確認→不升級；逾時→建立 `admin_escalated` 並於管理員列表標示「已升級」；管理員逾時→僅標示「逾時未確認」不改派；未設定→**不計時、不升級**，標示「該校尚未設定處理時段」；排程故障時列表仍可即時顯示逾時；**畫面 0 處對學生或訪客顯示處理時限或全天監看／即時救援承諾** |
| ~~V-47~~【歷史／β2 首版目標已被 D-23 取代；編號保留】 | ~~B 級受限伺服器端能力的發布資格與範圍追蹤（D-16；依賴 S-13 結果）~~ | ~~未通過→「尚在驗證、尚未開放」；通過後可部署~~。MVP 現行阻擋依 V-28 的 `student_server_runtime_not_in_mvp`；此舊案例不得實作或納入 MVP Gate。 |
| V-48 | **學生 AI 值守閘門**（D-14 後續決定；**僅用合成值守時段**與注入時鐘）：值守設定 `unset`／`drafted`／`educator_approved`；時段內有主責＋備援／時段內缺備援／時段外／假日；名冊人員被停用；教師與管理員自己的 AI（待核定項只測 Plan 提案行為並標示「待核定」） | 非 `educator_approved`、時段外、假日、缺主責或備援：學生對話／圖像／網頁搜尋／Agent **100% 被伺服器端拒絕（`ai_off_duty`）**，且**被擋者 0 次預留額度、0 次呼叫分類器或模型**；登入、已保存內容讀寫、下載自己成果、非 AI 功能**仍可用**；名冊人員被停用後**下一個請求即關閉**（不依賴排程）；畫面 0 處宣稱「有人在線」「24 小時」「即時處理」；值守設定未核定時，管理員畫面**不得顯示 AI 閘門為可啟用** |
| ~~V-49~~ | ~~**公開 C 級 AI 值守閘門**（D-14 後續決定；七項控制已以測試旗標模擬通過）：有管理員值守／無管理員值守／值守未設定；頁面狀態 `live`、`stopped` 各一~~ 【已被取代・首版不適用（2026-10-21 範圍決定）；原文保留作歷史；首版對應：學生 AI 值守閘門見 V-48；`duty_gate('public_c_ai')`、`503 public_ai_paused` 首版不建立，不是 Gate 阻擋項】 | ~~無管理員值守或未設定：訪客新增請求被拒（`503 public_ai_paused`，內部原因碼為值守類），**不扣池、不呼叫模型、不建立事件**；**`ai_state` 與 `page_state` 不被值守改變**（頁面不因此停止公開；也不因頁面公開而視為 AI 開放）；有管理員值守時其他閘門（上限、停用、學校）仍各自生效；0 個作品因此被標示為「C 級已完整 Launch」~~ |
| V-50 | **案件通知狀態機與邊界情境**（**2026-10-21 範圍決定：其中公開訪客事件／訪客串流／訪客事件逾時之處，即 ① 的「訪客事件」、④ 的「公開訪客串流」與整個 ⑤，已被取代・首版不適用，原文保留作歷史；學生事件部分維持**；D-14 後續決定；**合成事件與合成值守時段；以下為最小方案的測試，政策待教育者核定，結果須標示「待核定」**）：① 原收件者為管理員（含學生事件無合適教師、訪客事件）逾 1 個值守小時；② 電郵 `failed`／`not_configured`；③ 值守交接（時段切換、名冊更換）；④ 時段結束時在途（單一對話回合、Agent、排隊中、結束後才產生的高風險事件、公開訪客串流）；⑤ 訪客事件逾時；⑥ 不 `forward` 直接 `close`；⑦ 非值守時段建立的事件於下一時段才開始累計 | ① 不改派非管理員；標 `overdue_unacknowledged` 並置頂；名冊備援（非原收件者）收到 `admin_backup` 通知；備援逾時不再往上；② 事件與站內通知仍在、`email_state` 記錄失敗、管理員列表文字提示；**`handling` 與計時不受電郵影響**；③ 未確認案件不消失、已累計值守時間不歸零、新值守管理員看見未結清單、名冊變更有稽核；④ 在途單一回合跑完但不開新回合；Agent 於下一重要步驟停止並保留已完成內容；排隊者被擋後標 `paused_off_duty`、預留全額釋放、**不自動續跑**；結束後產生的事件照常指派並標 `carried_over`，計時不回溯；公開串流同單一回合；⑤ 訪客事件同①，計時 0 處使用作品所屬學校；⑥ 可直接 `close`，不得因未 `forward` 而被擋；⑦ 下一個值守時段開始才計時；任何情境 0 處對學生或訪客顯示處理時限、即時救援或免除法定通報的宣稱 |

### 2.7 可及性與響應式（AC-15；SC-011）〔使用 Playwright＋人工〕
鍵盤完成「登入→對話→編輯→提交」；彈窗焦點、Esc、焦點回復；寬窄畫面切換；對比 4.5:1／3:1；狀態不只靠顏色。**瀏覽器與無障礙實測：尚未執行。**

### 2.8 首版 A／B 驗證情境（2026-10-21 範圍決定；取代 §2.4；對應 AC-27、SC-017 現行規則、US 4 情境 7、US 5 情境 9、US 14 情境 15～17）〔全部〔尚未執行〕〕

**V-53 長表閱讀閘門（2026-10-22）**：下方 V-53 原長列保留作歷史追溯，**不是可直接照跑的測試清單**；其子案例適用性逐項見本節「V-53 長列逐子案例適用表」。相反舊語句不得作預期結果。現行驗收只取未衝突的 CSP／隔離需求及 V-56／V-57、§0.1 四類矩陣；不得執行 S-13／β2 或 HMR 成功驗收。

> 本節為**驗證計畫**，**無任何一項已執行或已驗證**（無環境、無依賴、無付費資源、無密鑰）。僅用合成帳號與合成資料；學生端文案為草案，待教育者／專業審閱，文案審閱前結果欄不得標示為通過。實作與任何付費資源仍須待 Tasks、Analyze、Implementation Readiness Gate 與教育者階段批准。**V-51～V-55 與其所驗證的技術設計（`runtime_ai_review`、`tier_not_supported`、`runtime_ai_unsupported`、學生端說明、輔助掃描）皆為草案，教育者未逐項批准、未實作、未測試。** **輔助掃描不能保證發現所有執行時 AI 呼叫**；公開資格由作品分類、審查、部署與受限執行資源**共同**約束；平台 AI 協助學生編寫作品不得被誤判為作品具有 C 級功能（判定依據是申請版作品內容）。若任一案例顯示草案做法無法支持規則，須記錄差異與影響交教育者決定，**不自行宣稱已解決**。

| # | 步驟 | 預期 | 狀態 |
| --- | --- | --- | --- |
| V-51 | 學生端 A／B 選項：在藍圖頁與創作引導「作品等級」步驟檢視可選項、說明文字，並以鍵盤與滑鼠嘗試操作；使用平台 AI 對話／Coding Agent 製作作品後再檢視等級 | 選項**只有 A、B 兩項**；0 個可選、可聚焦、可點擊或預設選取的 C；C 只出現在說明文字「首版不支援需要作品執行時呼叫 AI 的 C 級作品」；A／B 描述與 v5 定義一致；使用平台 AI 製作**不使作品升級為 C** | 〔尚未執行〕 |
| V-52 | 學生要求「讓我的作品自己呼叫 AI」：分別在一般對話與 Coding Agent（引導學習、自動開發兩模式）提出；亦嘗試以繞道方式要求（利用平台金鑰、代理端點、第三方 AI 外掛、前端直接呼叫） | 回覆清楚說明首版不支援 C 級作品，並引導改為不依賴作品執行時 AI 的 A／B 設計；Agent **0 次**加入金鑰、前端直接呼叫或服務端 AI 呼叫，**0 次**以繞道方式達成；不出現「稍後開放」「分階段交付」；產出檔案與設定經掃描 0 件含 AI 金鑰樣式或對生成式 AI 服務的呼叫；說明文案為草案，待審閱 | 〔尚未執行〕 |
| V-53 **長列歷史標記（先讀，適用緊接的原列）** | 原列保留歷史，**不可直接照跑**：**(e) 同源 WebSocket 熱更新＝歷史**；**(f) works-edge 持三把／全域資料 HMAC＝歷史**；**(g) 身分只由 Host 決定＝歷史**；**(h)、(j) 無 Set-Cookie／無 cookie 即成功＝歷史**；**(j) WebSocket 成功／所有隱私設定結果相同＝歷史**；**(m) 沙箱 destroy／TTL 決定預覽撤銷＝歷史**；**(o) Tasks 自行核定瀏覽器＝歷史**；**(p) 三把 HMAC 與全域資料金鑰輪替＝歷史**；主列 β2／S-13 雙環境＝歷史 | 現行 A1／B2／X 僅依 V-56／V-57、§0.1 及本節逐子案例適用表；未衝突 CSP／隔離檢查延續。**歷史項不建立實作／驗收任務，不計入 MVP 通過率。** | **歷史標記；現行產品測試尚未執行** |
| V-53 | 預覽與公開環境無 AI 金鑰與出站：在私人預覽沙箱與 B 級受限伺服器端環境（依賴 S-13 候選環境）檢查環境變數、設定與可呼叫端點，並嘗試從作品程式連線生成式 AI 服務與平台 AI 代理端點 | 兩種環境**0 個** AI 金鑰注入；**無**平台 AI 代理端點可供作品呼叫；出站至生成式 AI 服務**全部失敗**；預覽標示「私人預覽／尚未公開」並加註作品不能呼叫 AI（草案文案）；公開頁不含 AI 輸入欄或「AI 暫停」說明；**〔Plan 技術設計，見 plan.md 重點設計摘要第 4 項、publishing 契約 §3.1、§7.9〕另測瀏覽器端**：預覽經 Works Edge 預覽模式提供與公開頁同一份 CSP。案例：（a）預覽頁與公開頁（A 級靜態、B 級）於學生／訪客瀏覽器內對外部生成式 AI 端點的 `fetch`／XHR／WebSocket 被瀏覽器（`connect-src`）阻擋，且阻擋不依賴沙箱出站規則；（b）沙箱內程式刻意不送、或送出寬鬆的 `Content-Security-Policy`（含頁面 `<meta>`）時，抵達瀏覽器的回應標頭仍是平台版；HTML、腳本、Worker 腳本與錯誤頁皆帶標頭；（c）繞道嘗試——不帶權杖、過期權杖、直接以沙箱位址／埠連線——全部失敗；（d）**只記錄、不宣稱攔截**：頁面導覽（連結、`window.open`、`location`）、WebRTC 等 `connect-src`／`form-action` 未涵蓋途徑的實際結果；**〔2026-10-21 Plan 定點修正；publishing 契約 §3.2、§3.3，以下 (e)～(i) 同為〔尚未執行〕〕**（e）**`form-action 'self'`／`base-uri 'self'` 與流程核對**（公開頁、預覽各測，記錄瀏覽器與版本）：A 級同源互動與同源表單（`GET`、`POST`）、B 級對 `/_work/data/v1/*` 的原生表單 `POST`、同源 `<base href="/">`、預覽權杖兌換、停止說明頁皆**正常**；跨源 `<form action>`（僅用合成網域）與外部 `<base href>` 被瀏覽器 CSP **阻擋**；預覽開發伺服器同源 WebSocket 熱更新結果只記錄；**無任何已批准 A／B 流程被阻斷**，若有，記錄差異並交教育者決定，不默默縮減 B 級；（f）**Work Data API 同源路徑**：公開與預覽皆以相對路徑讀寫；瀏覽器開發者工具確認請求只到自身 origin、`connect-src` 無新增來源；`/_work/` 下其他路徑回 `404` 且無 AI 路由；請求帶的 `Cookie`／`Authorization` 於平台端點**不存在**；works-edge 環境變數清單**僅含**三把專用 HMAC 金鑰與已發布產物的唯讀能力，**無**資料庫憑證與 AI 金鑰（**不是**「無憑證」；publishing 契約 §3.5）；（g）**授權與隔離**：作品 A 頁面無法藉改路徑或 `Host` 讀寫作品 B 資料集（身分只由 `Host` 決定）；HMAC 無效、時間戳逾窗、Body 被改的請求被平台端拒絕；作品下架（`stopped`）後資料請求於平台端**立即**被拒，即使 works-edge 狀態快取仍為 `live`（記錄 TTL 窗口結果）；配額未核定或超量一律拒絕；預覽未兌換、已過期、已撤銷或未知 `preview_id` 一律回同一 `403`、預覽資料集與公開資料集互不可見、預覽結束後暫存資料清除；（h）**預覽會話憑證**（第九輪改寫；~~原：cookie 為 host-only、`HttpOnly`、`Secure`、`SameSite=Lax`~~，已撤回）：兌換後網址不含權杖、回應**無** `Set-Cookie`；同一教師瀏覽器開兩個預覽，其一的程式讀不到另一預覽內容（不同 origin；細項見 (l)）；（i）**用量只記錄**：轉送請求量、平台端點延遲與平台 Team 用量／費用歸屬，不核定任何配額。**〔2026-10-21 第九輪；publishing 契約 §3.4、§3.5；以下 (j)～(p) 同為〔尚未執行〕，不得寫成已通過〕**（j）**右側互動預覽載入與續用**（跨站 iframe：平台頁與 `preview_domain` 為不同可註冊網域；合成帳號與合成作品）：平台工作區右側 iframe（`sandbox="allow-scripts allow-same-origin allow-forms allow-modals"`、`allow=""`、`referrerpolicy="no-referrer"`）以一次性權杖兌換後載入成功；網址不含權杖、無 `Set-Cookie`；其後重新整理、頁內導覽、子資源、預覽 WebSocket、「放大」、`/_work/data/v1/*` 讀寫**皆不需權杖與 cookie** 即成功；平台 API 延長後會話續用；重複使用、逾時、綁錯 `preview_id` 的權杖皆 `403`；於「預設設定」「第三方 cookie 全封鎖」「隱私瀏覽」各組合下結果相同（本設計不使用 cookie，須以實測確認而非假設）；`window.open`、`target="_blank"`、`alert`、跨站 iframe 內 `localStorage`／IndexedDB 的實際行為只記錄；（k）**未授權網站嵌入遭拒**：以合成、不在清單內的 origin 頁面嵌入預覽 → 被瀏覽器依 `frame-ancestors` 拒絕；公開作品頁被任何 origin（含平台 origin）嵌入皆被拒；預覽的 redeem、`403`、錯誤頁亦帶 `frame-ancestors`；平台 origin 清單缺失或格式不符時 fail-closed 為 `'none'`；公開模式與預覽模式的標頭只有 `frame-ancestors` 不同；`works_csp_policy` 單元測試：公開模式不接受 frame 來源參數、預覽模式拒萬用字元與非 `https` 來源；（l）**兩個預覽互不可讀**：同一教師瀏覽器同時開預覽 A、B（不同 `preview_id`）：A 的程式無法讀取 B 的 DOM、`localStorage`、IndexedDB，對 B 的 origin 發 `fetch` 被 `connect-src` 擋下，A 的資料 API 讀不到 B 或公開作品的資料；預覽程式無法存取平台頁 DOM，`window.top.location` 導覽被 `sandbox` 擋下；（m）**預覽會話失效**：到期、各撤銷觸發（關閉預覽、授權解除、帳號停用、專案刪除、沙箱 `destroy`、新預覽取代舊預覽）後，資料 API 於平台端**立即**拒絕，靜態與沙箱內容於 works-edge 狀態快取 TTL 內改為 `403`；**量測並記錄實際延遲**；未知、未兌換、已過期、已撤銷的回應不可區分；已載入頁面的行為只記錄；（n）**萬用字元網域與 TLS**：隨機 `preview_id` 主機名可解析、憑證涵蓋、長度符合 DNS 規則，且不需為單一預覽申請憑證（記錄供應商條件；research 僅記「萬用字元網域須 Vercel Nameservers」，**尚未驗證**）；（o）**目標瀏覽器與版本實測**：文件**尚未定義**目標瀏覽器與版本清單，須由教育者或 Tasks 核定後逐一實測；結果表至少記錄瀏覽器、版本、作業系統、隱私設定與 (j)～(m) 的結果；未列入清單者不得宣稱支援；（p）**HMAC 輪替與外洩演練**（合成資料）：三把金鑰各自輪替，重疊期後舊金鑰被拒；以資料金鑰簽署跨作品請求，**記錄哪些被拒、哪些成功**（成功者即「持資料金鑰可跨作品讀寫」的已知殘餘風險，不得寫成已防住）；稽核記錄與異常告警可見且不含 Body 與訪客 IP（沙箱預覽埠不可被繞過）尚未驗證；結果取得前不得宣稱預覽「無 AI 途徑」已成立，且不得宣稱僅靠標頭即可攔截所有繞道** | 〔尚未執行〕 |
| V-54 | 審查退回含 AI 呼叫的作品：提交一件含執行時 AI 呼叫的合成申請版（程式、附帶資源或設定各一種態樣）；教師／管理員審查 | 審查清單含「是否含執行時呼叫生成式 AI」核對項；含者**只能退回修改**，不得批准或部署；退回理由保存且學生可重讀；修改移除呼叫後可重新申請；退回不改變學生的平台 AI 使用權；**另以明碼、混淆、動態組字串、第三方腳本各一合成態樣記錄審查與輔助掃描的偵測結果（只記錄偵測率，不宣稱零漏判；若偵測能力不足以支持「含者必退回」，列差異交教育者決定）**；另提交一件「由平台 AI 協助編寫、實際不含任何執行時 AI 呼叫」的合成作品，確認**不被誤判**為 C 級或被退回 | 〔尚未執行〕 |
| ~~V-55~~【歷史／β2 MVP 驗證已被 D-23 取代；編號保留】 | ~~確認 β2 首版範圍與 S-13／V-47 驗證不變~~ | ~~依舊 β2 首版目標檢驗~~。MVP 不實作、不 Gate β2；另立 feature 後重新定義驗收。此列不計入本 MVP Gate。 | 不適用於 MVP |

保留並**不受本次範圍決定影響**的驗證：學生平台 AI（V-03、V-04、V-43～V-45）、學生 AI 值守閘門（V-48）、案件通知（V-44、V-50 學生事件部分）、學校核准與登入（V-01～V-10）、**V-31（金鑰樣式掃描）、V-36（不當宣稱掃描）**、S-01～S-03 與 S-05～S-15。

#### V-53 長列逐子案例適用表（原編號及相反舊文保留；2026-10-22）

本表是上方長表的**強制適用性標記**；「歷史」不是未執行但仍須完成的任務，而是**不得按該舊預期實作／驗收**。以下全部產品驗證尚未執行。

| 原子案例 | 歷史內容（不執行、不計入 MVP 通過率） | 現行驗收及追溯 |
| --- | --- | --- |
| V-53 主列／(a)～(b) | 主列「私人預覽沙箱與 B 級受限伺服器端環境（依賴 S-13）」的雙環境執行要求為**歷史**；不能以 β2 為 MVP 前置。 | X 建置沙箱／不可變產物入口／公開 A、合格 B 及瀏覽器 CSP 仍須驗證；(a) 外部 WebSocket 被 CSP 阻擋與 (b) 上游寬鬆標頭不可覆蓋平台標頭維持，不代表提供 HMR。V-56、publishing §3.6／3.7／7。 |
| V-53(c) | 「沙箱預覽埠反向代理」與只驗「不帶權杖」即推定無 cookie 續用的前提為**歷史**。 | S-05／X 驗零暴露埠與無可繞過入口；兌換權杖無效拒絕，後續即使 hostname 正確但 cookie 無效也拒絕；V-57 A1。 |
| V-53(d) | 無新增歷史授權要求；保留「只記錄、不宣稱攔截」限制。 | 導覽／WebRTC 實際行為如實記錄，不宣稱 CSP 可攔全部繞道；阻斷核准流程交教育者決定。 |
| V-53(e) | 「預覽開發伺服器同源 WebSocket 熱更新結果只記錄」屬**歷史／MVP 不提供**，不是成功要求。 | A／合格 B 同源表單、`form-action`／`base-uri`、兌換及停止頁維持；X 只測儲存→重建→iframe 重載，V-56。 |
| V-53(f) | 「works-edge 僅含三把專用 HMAC」、可為全域資料簽章的資料 HMAC 及據此假定請求無任何授權，均為**歷史**。 | 不把學生／平台 session cookie 原樣轉送；A1 先驗預覽 cookie，B2 以單作品／用途簽章授權轉送，簽署私鑰不在 edge；V-57。其餘同源相對路徑與保留前綴仍驗。 |
| V-53(g) | 「身分只由 Host 決定」及以全域資料 HMAC 作跨作品資料授權為**歷史**。 | Host 僅路由／隔離，不授權；逐請求驗 A1 或 B2、live、用途、期限、撤銷版本、配額；下架資料即拒絕，不採 edge live 快取放行。保留預覽／公開資料隔離，V-57。 |
| V-53(h) | 「回應無 Set-Cookie」及已撤回的 `SameSite=Lax` cookie 規格均為**歷史**。 | 兌換後 URL 無權杖但須設定 `__Host-preview_session; Secure; HttpOnly; SameSite=None; Partitioned; Path=/`，無 Domain；V-57 A1；跨預覽不可讀仍驗。 |
| V-53(i) | 「用量只記錄、不核定任何配額」若被解讀為免配額可啟用，該解讀為**歷史／禁止**。 | 量測任務仍不替教育者核定；PP-26 未核定即拒絕。費用／配額依 V-56／57、§0.1③④。 |
| V-53(j) | 「無 Set-Cookie」「皆不需權杖與 cookie 即成功」「各第三方 cookie／隱私組合結果相同（本設計不使用 cookie）」以及「預覽 WebSocket 成功」逐項均為**歷史**。 | 首次兌換後，各 HTML／子資源／重載／導覽／放大／資料 API 須有效 A1 cookie 與伺服端狀態；必要 cookie 不支援時明示不支援並拒絕；無 HMR／WebSocket。V-56／57、§0.1①。 |
| V-53(k) | 無相反授權要求；此案例不構成「frame-ancestors 可替代 cookie 授權」。 | 未授權嵌入被擋、公開 `'none'`、預覽僅設定清單、缺設定 fail-closed 及錯誤頁標頭均維持。 |
| V-53(l) | 無相反授權要求；跨 origin 不可讀不代表 hostname 已授權。 | 兩個預覽與平台 DOM／儲存／資料隔離、禁止 top navigation 維持，並加上錯誤分區 cookie 拒絕；V-57。 |
| V-53(m) | 「沙箱 destroy／沙箱 TTL 決定預覽撤銷／到期」「靜態與沙箱內容只按舊快取 TTL 失效」為**歷史**。 | X 產物已保存後不隨建置沙箱銷毀；撤銷依伺服端會話／權限及 PP-22／23 核定上界（含快取）。解除綁定、停用、審查結束、到期等分開驗；已載入內容不可收回。V-57 A1、§0.1②。 |
| V-53(n) | 無相反授權要求；正式萬用字元 TLS 仍未驗證，不能以本機 TLS 代替。 | 保留 DNS／憑證涵蓋與不逐會話申請憑證檢查；§0.1①。 |
| V-53(o) | 「教育者或 Tasks 核定」中由 Tasks 自行核定支援清單的權限為**歷史／禁止**。 | Tasks 整理、教育者於 V-53 前核定 PP-24；樣本／版本／裝置／設定逐格記錄，不外推未測環境；§0.1①。 |
| V-53(p) | 「三把 HMAC 各自輪替」「持全域資料 HMAC 可跨作品讀寫」及「沙箱預覽埠不可繞過」的舊組合前提為**歷史**。 | B2 驗非對稱簽章、key id、核定重疊窗口、緊急撤銷、更新失敗與平台逐請求拒絕；其餘服務簽章依現行契約驗。記錄 edge 持多作品有效授權的殘餘風險，不宣稱完全防跨作品。X 不暴露預覽埠；V-57、§0.1④。 |

## 3. 驗證與規格對照（AC 層級；FR／SC 層級的覆蓋表見 [tasks.md](./tasks.md)）

| AC | 驗證 | AC | 驗證 |
| --- | --- | --- | --- |
| AC-01、02、03、04 | V-21（及 Tasks 階段 UI 案例） | AC-16 | V-01～V-08；S-01～S-03 |
| AC-05、06 | V-22；S-11 | AC-17 | V-27、V-29 |
| AC-07、08 | V-23、V-24 | AC-18 | V-28、V-47；S-13 |
| AC-09、10 | V-25、V-26 | AC-19 | ~~V-30～V-36；S-05；S-07；後續決定：V-49~~【V-30、V-32～V-35、V-49 已被取代・首版不適用；公開 AI 部分不再驗證。**V-31、V-36 延續為首版現行**；S-05（沙箱出站阻擋）、S-07（下架延遲）仍屬現行 Spike；首版對應見 V-51～V-55】 |
| AC-11 | V-22、V-24（保存失敗） | AC-20 | ~~V-32、V-34~~【已被取代・首版不適用】 |
| AC-12 | V-11～V-13；S-03 | AC-21 | V-09、V-10；S-01～S-03 |
| AC-13 | V-37、V-38 | AC-22 | V-13、V-15～V-18 |
| AC-14 | V-12、V-39（稽核） | AC-23 | ~~V-35~~、V-43～V-46；S-06；S-14；**後續決定：V-48、V-50**（V-35、V-49 與 V-50 的訪客事件部分已被取代・首版不適用） |
| AC-15 | §2.7 | AC-24 | V-14、V-19 |
| — | — | AC-25 | V-39～V-42 |
| — | — | AC-26 | V-20 |
| — | — | AC-27（2026-10-21 範圍決定） | V-51～V-57〔尚未執行〕；V-47／S-13 為 β2 後續 feature 歷史研究，非 MVP Gate |

## 4. 驗證狀態（如實）

| 項目 | 狀態 |
| --- | --- |
| **本指南所列全部 Spike（S-01～S-15）與情境（V-01～V-57）** | **尚未執行**（本輪僅規劃）；V-30、V-32～V-35、V-49 與部分 V-05／V-07／V-37／V-40／V-50 為已被取代・首版不適用（原文保留作歷史，不計入覆蓋）；**V-31、V-36 延續為首版現行（範圍調整），亦尚未執行**；新增首版 A／B 情境 V-51～V-57 亦**尚未執行**，且其所驗證的技術設計為草案、教育者未逐項批准；**D-07a 的實測條件 S-01～S-03 亦尚未執行**，方案 A 為「已選首選驗證方案，附實測條件」，不是已驗證可上線；**S-13（β2 後續 feature 研究）、S-14（郵件供應商）、S-15（成本降低比較）亦尚未執行** |
| 首版範圍決定（2026-10-21）同步：§0、§1（S-15）、§2.1（V-05、V-07）、§2.4、§2.5、§2.6（V-49、V-50）、§2.8（新增）、§3、§4 的文字與 spec.md 交叉核對 | **已執行（人工閱讀與搜尋；僅文件）**；所有對應驗證情境**尚未執行**，規格／Plan 文字更新不等於已驗證或已實作 |
| 新增 §2.8 學生端文案與說明（A／B 選項、「不支援 C 級作品」說明） | **草案，待教育者／專業審閱；尚未審閱** |
| 第六輪殘留逐點核對（S-15、V-30～V-37、V-49；2026-10-21，僅文件） | **已執行（人工閱讀與搜尋）**：S-15、V-37 補明公開池不納入／不得抵銷；V-30、V-32～V-35、V-49 確認為歷史並補首版對應；V-31、V-36 改為首版現行；V-53、V-54 補「瀏覽器端」與「偵測率、不誤判」草案案例；**全部對應驗證尚未執行** |
| 第九輪 Plan 定稿前定點修正（2026-10-21，僅文件）：右側互動預覽的 iframe 嵌入、`frame-ancestors` 公開／預覽區分、無 cookie 的預覽會話（`preview_id` 主機名）；works-edge HMAC 信任邊界更正；V-53 修改 (f)～(h) 並新增 (j)～(p)（嵌入與續用、未授權嵌入、預覽互不可讀、會話失效、萬用字元網域與 TLS、目標瀏覽器與版本實測、HMAC 輪替與外洩演練） | **已執行（人工閱讀與搜尋）**；**(j)～(p) 與修改後的 (f)～(h) 全部〔尚未執行〕**：跨站 iframe 載入與續用、非清單來源嵌入被拒、預覽互不可讀、會話失效延遲、萬用字元網域與 TLS、目標瀏覽器清單（**尚未定義**）與版本實測、HMAC 輪替皆**未取得結果**，不得寫成已通過 |
| 第八輪 Plan 定稿前定點修正（2026-10-21，僅文件）：S-05 補預覽入口繞過測試；V-53 補 (e)～(i)（`form-action`／`base-uri`、Work Data API 同源路徑、授權與隔離、預覽續用憑證、用量記錄）；V-28 第二種指向同源資料路徑 | **已執行（人工閱讀與搜尋）**；**全部對應驗證尚未執行**；「沙箱預覽埠不可被繞過」前提、同源資料路徑的隔離與用量、`form-action`／`base-uri` 的瀏覽器實測結果**皆未取得**，不得寫成已通過 |
| 供應商價格與能力 | 已於 2026-10-21 查證官方頁面（research.md；第二輪重新核對 OpenAI、Supabase、Vercel、Fly；第三輪重新核對 Vercel Sandbox 價格與區域、Fly 價格頁、E2B 價格頁，仍有「待複核」項目）；實測校正**尚未執行** |
| 成本模型 | 情境推估已計算並標示敏感假設；**實測重建尚未執行** |
| 法務、學校契約、供應商兒童資料條款、ZDR 啟用佐證 | **尚未執行／未取得**（OpenAI 帳戶未核對） |
| 文案專業審閱 | **尚未審閱** |
| App 值守時段、假日、交接與備援名單（D-14 後續決定；取代學校處理時段）；邊界情境；案件流程的法務與兒少保護專業審閱 | **尚未核定／尚未審閱**；V-48～V-50 只能以合成時段執行，真實驗收待核定；**不得宣稱 24 小時有人處理** |

### §41 T051 方案 B：隔離本機未分類點子建立子集（2026-10-24；一次性）

本輪教育者明確選定方案 B，授權及停止邊界見 [readiness-review.md §41](./readiness-review.md)。新列保存 `requested_tier`（省略即 `NULL`），正式 `tier`／`needs_visitor_identity` 為 `NULL`，`classification_state="unconfirmed"`、stage「點子」、`row_version=0`。歷史資料保留原 tier／boolean 與七欄讀取，遷移後標示 `legacy_unverified`，不把舊 `false` 當確認證據。新 DTO 可表示兩種狀態；舊七欄介面遇未分類列明確回報不支援，而不是濾除或部分成功。

本機建立只透過窄用途交易函式；當下 `edit_saved_content` 在交易內重驗，owner／id／時間由 DB 決定；主體與建立作用域分隔 UUID 冪等結果，本文按 title UTF-8 位元組及 tier 有無／值比對，保留至少 24 小時。它不是 Auth／HTTP 接線，也不授予預覽、提交、發布或部署資格。分類確認、revision／失效、階段保存、版本更新／衝突及資格操作服務均未建立。

本輪命令結果：

| 命令 | 結果 |
| --- | --- |
| `npm test -- tests\contract\project-create.test.ts tests\contract\project-stages.test.ts` | 成功，2 個檔案／81 測試通過 |
| `npm test` | 成功，10 個檔案／366 測試通過 |
| `npm run typecheck` | 成功；core、web、tests 三組檢查通過 |
| `$env:NEXT_TELEMETRY_DISABLED="1"; npm run build` | 成功；production build、TypeScript、靜態頁生成通過 |
| `npm run test:projects:db` | 已呼叫但 `not_run`：Docker daemon pipe 不存在，runner 在容器建立前停止；pgTAP、權限、建立／併發／回滾及 catalog 檢查均未執行 |
| `powershell ... pgtap-local.ps1 -Scenario NotOk`／`-Scenario SqlError` | 已呼叫但兩者均 `not_run`：同一 Docker daemon 前置失敗，未進入故障情境 |

資料庫環境未啟動，故無暫時授權可撤銷，runner 記錄 `Revocation=not_attempted`、`Cleanup=not_needed` 且未列出建立的 container／volume／network；Docker labels 零殘留、角色／權限快照及 catalog 還原無法獨立驗證，維持 `not_run`，不得填成通過。完整去敏命令輸出、exit code、來源雜湊與封裝資訊見 readiness §41 及本輪外部證據包。136 條任務／依賴／勾選未因局部成果變更；T051 僅完成本輪子集，G0／Checkpoint／完整 Gate 未通過、正式審議／簽核未執行。
