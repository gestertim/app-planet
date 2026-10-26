# 契約：專案、快照、Agent、沙箱與工作佇列

**對應**：FR-009～012、021、023、025、026、038、040、041（**另 FR-049 現行規則：作品不得呼叫生成式 AI**）｜**研究**：[../research.md](../research.md) R-05、R-06、R-13｜**資料模型**：[../data-model.md](../data-model.md) §4｜通則見 [README.md](./README.md)

> **同步註記（2026-10-21 首版範圍決定）**：首版學生作品等級僅 **A／B**；作品本身不得以生成式 AI 作為執行時功能。Agent 不得為作品加入 AI 金鑰、前端直接呼叫或服務端 AI 呼叫（見 §3 新增「作品不得呼叫生成式 AI」）；私人預覽沙箱**不提供**生成式 AI 途徑（§5 不變式）。平台 AI 對話與 Coding Agent（G-1）仍可使用，沿用學校核准、額度、內容安全與值守閘門。本契約為設計層級，尚未實作、未驗證。

## 1. 專案、階段與快照

**P-1 初始化補訂（2026-10-24 教育者明確批准）**：本文仍只有 `{ title, tier?: "A"｜"B" }`；新專案的 `stage` 固定「點子」、`row_version` 固定 0，僅由受控建立流程設定，不接受 caller 傳入上述欄位（即使值恰為「點子」／0 也不接受）。這不是既有資料允許值限制，不重設舊專案階段／版本、不加入全表版本非負約束；舊零／負版本仍可讀。owner 由可信主體、id／created_at 由可信 DB 產生的原要求不變。

**P-1 方案 B（2026-10-24 教育者明確選定；實作範圍見 readiness §41）**：先建立未分類點子，A/B 後續步驟才確認分類。本文保持 `{ title, tier?: "A" | "B" }`；缺省保存 `requested_tier=NULL`，明示 A／B 僅逐字保存為 `requested_tier`，不可作可信正式分類。新列固定 `classification_state="unconfirmed"`、`stage="點子"`、`row_version=0`，`tier` 與 `needs_visitor_identity` 均為 NULL；禁止 caller 指定 owner／角色／學校／id／時間／階段／版本／分類狀態／正式分類／確認證據。建立本身不授予預覽、提交、發布或部署資格。

本機隔離 migration 以 `classification_state="legacy_unverified"` 標示遷移前的歷史列，保留原 tier／boolean 值及舊七欄 DTO，不把 false 升格為已確認證據。新的具名 DTO 區分 `unconfirmed`、`confirmed` 與 `legacy_unverified`；舊介面遇無法表示的新列明確回 unsupported，不可靜默濾除或部分成功。§41 的建立子集當時未提供 confirmed 寫入；§43 另行批准並實作最小需求 revision、學生明確確認與失效受控交易，均非 HTTP handler 或一般服務上線授權。細節見 [readiness §41](../readiness-review.md) 與 [§43](../readiness-review.md)。

### 1.1 需求版本與分類確認

需求 DTO 為固定欄位 `{ description: string, runtime_needs: "static" | "work_data_api" | "restricted_server", runtime_ai_required: boolean }`；未知欄位、缺漏、錯型別、矛盾值拒絕。文字精確保存，不 trim、不排序、不正規化；相同內容沿用 revision，不同內容建立不可變的新 revision。保存／讀取只處理擁有者學生的當前需求；輸入不得帶 owner、確認者、權限 claim 或時間。

保存需求輸入含 `project_id`、`expected_row_version`、`expected_requirements_revision`、需求 DTO 與 UUID 冪等鍵；確認輸入另含明確 `tier: "A" | "B"`、必填 `needs_visitor_identity: boolean` 及 `requested_tier_acknowledgement`（`no_preference`／`matches`／`explicit_change`）。`row_version` 是 project row compare-and-swap 版本；需求 revision 是內容版本。兩者皆比對成功才可提交。requested_tier 不作權威分類；偏好不同時必須由學生在確認操作選 `explicit_change`，未明示即拒絕。

`unconfirmed` 的正式分類值與當前確認指標皆 NULL；`confirmed` 的確認證據綁定專案、當前 revision、精確需求快照、分類、擁有者學生與 DB 可信時間；`legacy_unverified` 保留舊值但不具確認證據。需求改變時，在同一交易內新增需求 revision、使舊確認退出 current、清空 tier／visitor／confirmation 指標、回到 unconfirmed 並更新 project row_version；舊證據不可改寫。確認與更新以 row lock／版本比較序列化。只有提交後才回成功。

重放依 COMMON 的 UUID、主體＋操作 scope 隔離與至少 24 小時規則；每次先重新授權再處理 key。同鍵異內容拒絕；同鍵同內容回原操作 receipt 並另解析當前分類，不重做確認，也不恢復過期／失效證據。資料庫直接 DML 對一般 actor 拒絕；寫入／證據／冪等均受最小權限及 FORCE RLS／窄用途受控函式保護。固定安全錯誤不得含 SQL、SQLSTATE、driver error、stack 或原始需求內容。此介面為本機 server／資料庫整合，不代表 HTTP／UI、真實 Auth 或後續操作獲准。

**§44 審閱修復的介面界線**：`readCurrentOwnedProjectClassificationSubset` 回三態的一般 DB DTO，不是 `TrustedProjectClassification`。只有 `resolveTrustedProjectClassification` 重新查詢並完整驗證當前確認後建構的六欄分類原物件，才通過 `hasTrustedProjectClassification`；receipt、一般 confirmed DTO、自組、spread／JSON 副本均不通過。WeakSet 只證明 resolver 產生來源，不表示 DB 狀態永遠有效，也不是即時撤銷／永久授權機制；每次需要當前資格時須重新 resolver。

舊七欄 `readOwnedProjectSubset`／`listOwnedProjectsSubset` 及只表示未分類／歷史狀態的 `readOwnedProjectWithClassificationSubset`／`listOwnedProjectsWithClassificationSubset`，對經完整需求／確認證據驗證的合法 confirmed 回 `unsupported_representation`。缺漏、非法或矛盾資料回安全 `failed/invalid_result`，不能僅憑 state 判為合法；列表先檢查所有列的有效性／ID 唯一性，再決定是否不支援，不部分回傳。完整 current DTO 不受此表示限制，建立冪等仍回建立當下 unconfirmed DTO。

需求保存／分類確認的 envelope、receipt 或 replay current 驗證失敗，是交易內部結果錯誤：服務須拋固定內部例外讓既有 adapter 回滾，再於交易外回 `failed/invalid_result`，不回傳輸入／SQL／driver error／stack。政策拒絕、版本衝突等正常業務結果仍正常返回；成功只在 COMMIT 後交付。不改 adapter 為猜測任意 failed 均須回滾。

| # | 方法與路徑 | 能力／授權 | 輸入 | 回應 | 錯誤 | 冪等／並行 |
| --- | --- | --- | --- | --- | --- | --- |
| P-1 | `POST /api/v1/projects` | `edit_saved_content` | `{ title, tier?: "A"｜"B" }`（首版僅 A／B；~~`"C"`~~【已被取代・首版不適用（2026-10-21 範圍決定）；原文保留作歷史】；`tier` 為其他值→`422 tier_not_supported`，文字「首版不支援需要作品執行時呼叫 AI 的 C 級作品」〔草案，待教育者／專業審閱〕；等級依需求，A／B 沿用 v5 定義，不因平台為 C 級而強迫升級，**使用平台 AI 製作不使作品升級為 C**） | `201` | `403` | `Idempotency-Key` |
| P-2 | `GET／PATCH /api/v1/projects/{id}` | 擁有者；已綁定教師唯讀（留稽核） | `PATCH`：欄位＋`If-Match` | `200` | `409` 並回雙方內容；`404` | `row_version` |
| P-3 | `PUT /api/v1/projects/{id}/stages/{stage}` | 擁有者學生；當下 edit／read gate＋owner | 未確認草稿子集 strict `{ content: { text: string } }`，不接受 state／owner；確認／批准仍走各自人工 RPC，非本子集 | 首建 `201`＋DTO／Location／ETag 0；更新 `200`＋DTO；重放 `200`＋原 operation／current_draft | `400 precondition_required／invalid_precondition`；`412 draft_already_exists`；`409 version_conflict`；`422 idempotency_key_reuse`；`401／403／404` 依既定隱匿 | UUID Idempotency-Key；首建單一 `If-None-Match: *`，更新單一 strong `If-Match`；詳 COMMON D-33 |
| P-4 | `PATCH /api/v1/projects/{id}/tasks/{tid}` | 擁有者 | `{ done }` | `200`（**真的寫入**，非僅提示） | `409` | `If-Match` |
| S-1 | `POST /api/v1/projects/{id}/snapshots` | 擁有者 | `{ kind: "manual", message? }`：以伺服器目前「已保存」檔案集建立；**不包含未保存的編輯器內容**（客戶端須先保存，見 §2） | `201`＋`{ version_no, content_hash }` | `409`；`507 storage_limit`（單專案容量上限，工程值） | `Idempotency-Key` |
| S-2 | `POST /api/v1/projects/{id}/restore` | 擁有者；`edit_saved_content` | `{ snapshot_id }` | **先**建立 `pre_restore` 快照並確認成功，**才**套用恢復；`200`＋`{ pre_restore_snapshot_id }`（可再找回） | `409 save_failed`：保存目前版本失敗→**不覆蓋現有工作**並說明原因與下一步 | `Idempotency-Key`；稽核 |
| S-3 | `GET /api/v1/projects/{id}/snapshots` | 擁有者／已綁定教師 | — | 版本名稱／識別碼、時間、變更摘要、`kind`、是否 `immutable` | — | — |

### 1.2 獨立階段草稿（§45；2026-10-24 本機有界子集）

這是 P-3 階段內容的**獨立未確認草稿**子集，不取代 P-3 使用者確認／人工批准契約，也不是 HTTP handler 或一般產品功能已開放。資料庫／server 介面：

| 操作 | 輸入 | 輸出與授權 |
| --- | --- | --- |
| `readOwnedStageDraftSubset` | strict `{ project_id: uuid, stage: 九步識別 }` | 當下 `read_saved_content`＋專案擁有者學生；`found/draft`、`not_found`、安全 denied／failed |
| `saveOwnedStageDraftSubset` | strict `{ project_id, stage, expected_row_version: null｜integer, content: { text: string } }`，另帶 UUID 操作鍵 | 當下 `edit_saved_content`（含衝突／重放所需 read 能力）＋專案擁有者學生；COMMIT 後 `saved/operation`；重放為 `replayed/operation/current_draft` |

資源鍵為 `(project_id, stage)`，首次 `expected_row_version=null` 代表預期尚無列，建立後版本固定 0；後續保存必帶目前 stage record 整數版本，成功 +1（同內容的新操作亦 +1）。不修改 project row_version 或 `projects.stage`。九步皆可保存各自草稿，**不能藉此跳過前置條件、執行該階段或宣稱完成**。本機 receipt／讀取 DTO 固定 `{ project_id, stage, row_version, state:"ai_draft", content_source:"student_input", content:{text}, approved_by:null, approved_at:null }`。沒有 HTTP ETag／If-Match 解析實作；未來 wire 層仍須遵 COMMON，不能以本機 null 首建語意推定 HTTP 缺標頭可以放行。

`ai_draft` 沿用既有未確認狀態名稱；**不能作為 AI 生成的來源標籤**。`content_source="student_input"` 由受控函式固定，只表明學生提交，不宣稱人工原創或 AI 生成；caller 不得指定狀態／來源／owner／時間／批准證據。內容 strict `{text:string}`，允許空字串及原始空白／Unicode，不 trim／正規化；拒絕 NUL／不成對 surrogate／未知欄位。不任意加長度限制，不渲染或執行內容，不宣稱已通過輸出消毒／內容安全審查。

同鍵作用域為可信主體＋`stage_draft_save_v1`＋UUID；指紋含 project、stage、預期版本及精確內容。所有本機保存操作均須鍵；這不把 COMMON POST 規則擴張為所有 HTTP PUT／PATCH。相同鍵同內容回原 receipt，異內容／目標／版本回 `conflict/idempotency_mismatch`。24 小時記錄只在過期同鍵重用時處理，不新增內容保存期限／歷史數量或排程。重放先以當下 DB 身分／能力／owner 重新授權，再分開讀當前草稿；舊 receipt 不是最新內容／版本。

版本不符回本機 `conflict/version_conflict`，限定 `{ current:{version,content}, submitted:{version,content} }`；首次已存在時 submitted version 為 null，預期更新但尚無列時 current version／content 為 null。僅回本次草稿欄位，不回其他階段、需求、分類、批准或他人內容；跨 owner 一律不提供衝突資訊。一般 actor 無直接 INSERT／UPDATE／DELETE 權；表 ENABLE／FORCE RLS，窄用途 NOLOGIN／NOBYPASSRLS writer 無 project UPDATE／批准欄位權限；SECURITY DEFINER 固定 `pg_catalog` search_path、限制 EXECUTE。

授權／冪等／資源鎖／版本比較／內容與版本寫入／receipt 記錄同一交易完成。結果 envelope、receipt 或 replay current 驗證失敗，服務拋固定內部例外讓 adapter 回滾，再於交易外回安全 `failed/invalid_result`；不透傳 Error／SQL／任意 meta，不正常 return failed 後 COMMIT。正常政策拒絕／版本衝突不覆寫草稿。DB 初始保存併發不重複，版本併發只有一個成功。

**權威邊界**：草稿不寫 `project_requirements`、不變更需求 revision、正式分類或確認證據；不供 trusted resolver 使用。權威需求只能經 §1.1 受控保存，改變仍須原子失效分類。本輪不建立分類確認、Checkpoint、批准、Final Pack 證據或任務／旅程／AI／預覽／發布資格。既有公開唯讀／建立／分類介面保持；新增 server 模組見 [stage-drafts.ts](../../apps/web/src/server/stage-drafts.ts)，共用 schema 由 core 入口新增匯出。完整本機實測及限制見 [readiness §45](../readiness-review.md)。

### 1.3 工作區唯讀恢復聚合（§46；2026-10-24 單批本機子集）

傳輸無關 `readOwnedProjectWorkspaceSubset(context, projectId)` 經 [projects 入口](../../apps/web/src/server/projects.ts) 匯出；只接受 UUID，不接受 caller owner／角色／學校／授權結論。沿用可信 `AuthorizationContext.runReadOnly`、非特權 authenticated actor、既有 RLS／逐欄 SELECT，單一參數化 SQL statement 內同時查詢當下 `read_saved_content`、owner、專案、當前需求／完整分類證據及 stage_records。READ COMMITTED 亦只有一個 statement snapshot，不將各獨立服務的多次讀取拼接；不新增權限、migration、DML、RPC 或 SECURITY DEFINER。

`found.workspace` 白名單：

| 欄位 | 精確內容 |
| --- | --- |
| `project` | `{ id, title, stage, created_at, row_version }`；保留歷史零／負 project 版本 |
| `requirements` | `null`（尚無需求），或 `{ revision, content:{description,runtime_needs,runtime_ai_required} }` |
| `classification` | `{ state:"unconfirmed"｜"confirmed"｜"legacy_unverified", requested_tier, tier, needs_visitor_identity }`；各態沿用 §1.1 的完整驗證及 null 語意 |
| `drafts` | 僅已存在的 `{stage,row_version,state,content_source,content:{text}}[]`，依既有九步順序排序；每階段至多一筆，不返回批准欄位 |

沒有某階段草稿＝陣列沒有該 stage，並非 `text=""`；已保存空字串／空白／Unicode 原文精確保留。不初始化或補寫內容。project row_version、需求 revision、各 stage row_version 分屬不同資源，不混用。必要確認證據只在服務內驗證，不回 owner／確認人／內部證據表／冪等／audit／任意 meta／SQL 或 driver error。

不存在與他人專案同回 `not_found`，不洩漏他人存在性；當下能力拒絕回 `denied/policy_denied`。合法無需求／無草稿仍為 found；資料缺漏（如 revision>0 但無當前需求）、矛盾／非法確認、非法 envelope／欄位、重複 stage 或草稿錯誤一律整份 `failed/invalid_result`，不得部分回傳。輸入／可信 context／依賴失敗分別為固定 invalid_input／invalid_context／dependency_failure。

confirmed 僅普通 DTO，不是 `TrustedProjectClassification`，不加入來源 WeakSet，也不是永久資格／操作授權；後續仍須當下重新呼叫既有 resolver。新交易讀回只是恢復資料準備，**不是登入登出恢復、HTTP／UI 或 E2E 驗收**。不修改 project stage／任何版本、需求、分類或草稿，不產生 user_confirmed／approved、旅程／Checkpoint／Final Pack 判定或下游資格。實作與本輪真實併發證據見 [readiness §46](../readiness-review.md)。

### 1.4 創作旅程唯讀評估（§49；2026-10-24 單批本機子集）

傳輸無關 `readOwnedProjectCreationFlowAssessmentSubset(context, { project_id, requested_stage })` 經 [projects 入口](../../apps/web/src/server/projects.ts) 匯出。caller 僅能提供 UUID 專案 ID 與九個正式階段之一；strict 輸入拒絕需求／分類／確認／草稿／owner／角色／能力／結論等附加欄位。server 沿用可信唯讀 `AuthorizationContext.runReadOnly`、非特權 authenticated actor、既有 `read_saved_content` gate／owner 查詢、RLS 與逐欄 SELECT；專案／需求／目前確認投影／必要完整確認 evidence／九步草稿均由同一個參數化 SQL statement 讀取，READ COMMITTED 亦不跨 statement 拼接。

server 先以既有 current-classification parser 驗證三態與 SQL 內完整關聯結果，再嚴格解析內部確認 evidence，核對目前 project、revision、需求逐欄原文、tier、visitor、requested tier／acknowledgement、確認者 owner 關聯與證據目標；草稿逐筆驗證 schema、project 與階段唯一性。只有完整合法資料才交給既有 `evaluateCreationFlow`。合法無需求／無草稿、`unconfirmed`、`legacy_unverified`、有效 A／B 與草稿沿原純函式規則處理；缺當前需求、確認矛盾、非法／重複資料或不合法 SQL envelope 一律整份 `failed/invalid_result`，不部分回傳。不存在／他人專案同回 `not_found`；政策拒絕、invalid input/context 與 dependency failure 維持固定安全結果。

成功白名單為 `{ outcome:"evaluated", snapshot:"single_statement", project_id, row_version, requirements_revision, assessment }`。`assessment.evidence_assurance` 維持 `structural_only`，`observed_drafts` 只含階段／狀態／來源，不含需求或草稿本文；不輸出 owner、確認 evidence／確認人、冪等、任意 meta、SQL 或 driver error。此結果只描述該次 DB statement snapshot，不是永久資格、批准來源、真實 Auth 或完整產品安全驗證；不建立 `TrustedProjectClassification`，不給 resolver 以外的操作授權。OD-12／未定階段仍 unsupported。`platform_ai_assisted_creation` 為不影響目前判斷的選填背景資訊；未提供時不補 `false`，也不由平台有 AI 或 `ai_draft` 推定。

§49 不新增 migration／grant／寫入 RPC、快取或持久化評估；不寫 project stage／版本、需求、分類、草稿或批准證據。沒有 HTTP／Server Action／UI／真實 Auth provider。實作、紅燈、實際 DB 併發及驗證結果見 [readiness §49](../readiness-review.md)。

## 2. 檔案與編輯（IDE）

**2026-10-21 最新 MVP 契約（現行，取代 E-3 及 §5 的沙箱預覽埠敘述）**：E-3 回 `202`＋建置 job；以已保存快照啟動 X（`ports: []` 建置→平台取回、檢查、保存產物），成功後才簽發／更新平台控制的預覽入口供右側 iframe 使用。job 回 `queued／building／retrieving／validating／succeeded／failed／cancelled`、目標快照、目前可見版本與失敗碼；保存成功不等於建置成功，無有效產物不得回可用預覽。60 秒一次性兌換與主機名會話仍為待定稿審閱的設計，非本次批准 X 即已驗收；會話綁產物而非沙箱，見 [publishing §3.6](./publishing-and-public-runtime.md#36-mvp-方案-x現行契約2026-10-21)、[data-model §4.4](../data-model.md)。

需學生伺服器程式（β2）時，不執行／不建立其公開 runtime；回 `422 student_server_runtime_not_in_mvp` 與範圍說明，Agent 可保留設計／檔案並提出合格替代，不以靜態頁宣稱功能已完成。平台 AI 與既有安全閘門維持。

| # | 端點 | 說明 |
| --- | --- | --- |
| E-1 | `GET／PUT /api/v1/projects/{id}/files/{path}` | `PUT` 帶 `If-Match`（檔案雜湊）；成功才回「已保存」；失敗 `409／503`，**客戶端保留草稿（本機持久化）並提供手動重試**，不顯示假成功；路徑正規化，**禁止 `..`、絕對路徑、符號連結、保留名**（路徑穿越測試）；單檔上限 PP-17；二進位檔走 Storage |
| E-2 | 狀態區分 | 回應與 UI 必須能區分「編輯草稿（客戶端）／已保存內容（伺服器）／預覽版本（對應 `snapshot_id`）」；預覽 URL 標示「私人預覽／尚未公開」與版本 |
| E-3 | `POST /api/v1/projects/{id}/preview` | `202`＋job：在沙箱建立預覽；回傳**預覽來源**（獨立網域，R-13）與 60 秒權杖；僅擁有者與被授權教師；**審查預覽改由 `submission` 快照建構**（見 publishing 契約）；**私人預覽不提供作品呼叫生成式 AI 的途徑**（§5 不變式；2026-10-21）；預覽頁的瀏覽器連線限制由 works-edge 預覽模式提供（publishing 契約 §3.1；〔尚未驗證〕）；**（2026-10-21；第九輪更正）預覽來源為每個預覽會話獨立主機名 `{preview_id}.{preview_domain}`（每次開啟簽發新 `preview_id`，≥128 位元隨機）；回應含 `preview_id`、`expires_at` 與 60 秒、一次性兌換權杖，右側預覽 iframe 以權杖兌換一次後，其餘請求只靠 `preview_id` 主機名，不使用 cookie（publishing 契約 §3.4；~~先前的 host-only 預覽會話 cookie~~ 已撤回，因 `preview_domain` 與平台為不同可註冊網域、內嵌屬跨站 iframe）；延長與撤銷為已登入的平台 API，不經 iframe；預覽中的作品資料一律以相對路徑 `/_work/data/v1/*` 同源呼叫，由預覽模式轉送平台、落在每會話獨立的暫存命名空間（§3.3；Agent 範本須使用此相對路徑，不寫死任何網域）** |

## 3. Agent

| # | 端點 | 能力／授權 | 輸入 | 回應 | 錯誤 | 備註 |
| --- | --- | --- | --- | --- | --- | --- |
| G-1 | `POST /api/v1/projects/{id}/agent-runs` | `ai_call`；擁有者 | `{ mode: "guided"｜"auto", instruction }` | `201`＋`{ run_id, state: "awaiting_approval", proposed_plan: { tasks[], impact } }` | `403 ai_not_open`；`403 ai_off_duty`（**後續決定 2026-10-21**：非值守時段或值守設定未核定；於預留額度前回應；Agent 執行中於下一重要步驟重新檢查）；`429` 額度（預留以**預計輪次上限**估算）；`409`（同專案已有進行中 run） | `auto`：**先呈現任務與影響並經確認**才執行；`guided`：每步解釋並確認 |
| G-2 | `POST /api/v1/agent-runs/{id}/approve` | 擁有者 | `{ approved_task_ids[] }`（`guided` 為逐步確認：`{ step_seq }`） | `202`＋job；**開始套用前先建立 `pre_agent` 快照**（建立失敗則不啟動） | `409` | 僅執行已批准任務；工具限白名單 |
| G-3 | `POST /api/v1/agent-runs/{id}/stop` | 擁有者 | `{}` | `200`；協作式取消（`cancel_requested`）；顯示**已完成／未完成**部分與恢復方式；不承諾外部費用可撤銷 | — | 冪等 |
| G-4 | `GET /api/v1/agent-runs/{id}` | 擁有者／已綁定教師 | — | `state`、已完成步驟、變更清單（對照快照差異）、測試結果、下一步 | — | **AI 完成修改≠測試或審核通過** |

**Agent 工具白名單**（`skills.tool_allowlist` ∩ 角色）：讀／寫授權專案檔案、受限建置與測試（沙箱）、啟動預覽、建立快照、提出部署申請（**不得批准或部署**）。**不得**：讀取平台環境、網路出站（沙箱預設全封鎖）、存取其他專案或使用者、修改權限／階段批准／審查狀態。外部內容與 Skill 內容視為**不受信任輸入**，不能提升權限或略過批准（FR-041；以提示注入測試集驗證）。

**作品不得呼叫生成式 AI（2026-10-21 首版範圍決定；FR-049、Clarifications R2；Plan 提案，待教育者審閱，尚未實作）**：
1. Agent **不得**為作品（A／B）加入 AI 金鑰、前端直接呼叫生成式 AI 服務、由作品伺服器端程式呼叫生成式 AI，也**不得**以繞道方式達成（利用平台金鑰、平台 AI 代理端點、第三方 AI 外掛／SDK／腳本、以 `agent-runs` 自身的 AI 能力代作品執行）。Agent 工具白名單不含任何「讓作品於執行時呼叫生成式 AI」的工具；此限制不影響 Agent 本身作為平台 AI 的使用。
2. **學生要求「讓我的作品自己呼叫 AI」**（於 `instruction` 或對話中）：該部分**不納入** `proposed_plan` 任務、不產生對應檔案變更；回應固定說明模板 `runtime_ai_unsupported`（學生可理解的文字：首版不支援需要作品執行時呼叫 AI 的 C 級作品，並引導改為**不依賴作品執行時 AI** 的 A／B 設計，例如預先準備的內容、規則式互動、由使用者自行輸入資料）〔草案，待教育者／專業審閱〕。其餘不涉及執行時 AI 的指示照常處理。此回應不是 `block`，也不是 `support`，**不建立安全事件**。
3. **變更後檢查（輔助）**：Agent 完成修改後，對變更清單檢查是否出現 AI 服務套件、已知 AI 服務網域或金鑰樣式字串；命中者標示於變更清單、提示學生移除，且不得提交申請；**此為輔助檢查，不取代發布審查的人工核對**（見 publishing 契約 §7.4；掃描規則待 Plan 研究）。
## 4. 測試結果

| # | 端點 | 說明 |
| --- | --- | --- |
| T-1 | `POST /api/v1/projects/{id}/snapshots/{sid}/test-runs` | `202`＋job：在沙箱對該快照執行；結果 `passed｜failed｜not_run｜needs_human` |
| T-2 | `GET /api/v1/projects/{id}/snapshots/{sid}/test-runs` | 每筆標示所測版本；**聚合函式不得把 `not_run`／`needs_human` 計為通過**；新快照不繼承舊結果 |

## 5. 沙箱轉接介面（`SandboxAdapter`；內部契約，供應商可替換）

| 方法 | 契約 |
| --- | --- |
| `create({ image, cpu, memory_mb, ttl_seconds, network: "none" ｜ { allow: [host|cidr] } , env: {} })` | 預設 `network:"none"`；**不注入平台密鑰**（`env` 僅限非敏感、每沙箱專屬變數）；`ttl_seconds` 硬上限（執行時間上限，PP 待核定）；回傳 `sandbox_id` |
| `writeFiles(sandbox_id, files[])`／`readFiles(sandbox_id, paths[])` | 路徑正規化；大小、數量、輸出量上限 |
| `exec(sandbox_id, cmd, { timeout_s, max_output_bytes })` | 輸出截斷並標記；逾時終止；回傳 exit code |
| `startPreview(sandbox_id, port)`【歷史，MVP 不呼叫】 | 原：取得短時預覽權杖，供應商位址只交 works-edge。**已被 X 取代**：不暴露任何埠，不提供沙箱預覽 URL；管理通道取回建置產物後依 publishing §3.6 提供平台預覽。 |
| `setNetworkPolicy(sandbox_id, policy)` | 僅允許明確清單；**阻擋私有網段、雲端 metadata、平台內部網域**（Vercel Sandbox 官方文字未見 metadata 字樣 → **實測 S-05 為阻擋 Readiness 項**） |
| `stop(sandbox_id)`／`destroy(sandbox_id)` | Worker 在完成、取消、逾期、帳號停用時清理；**stop 不是撤銷，不得作 destroy 的同義替代**，Vercel destroy 對應 delete。逾時需明確 kill/delete，不只 AbortSignal；清理失敗記錄並重試，不回報已清除。預覽授權撤銷另走平台會話／產物綁定，不依賴建置沙箱存亡。原語證據與後續 β2 研究見 research R-15，不表示產品清理已驗收。 |
| 資源與費用 | 每次執行時間、CPU／記憶體、輸出量、並行沙箱數（全域與每使用者）、每生每日沙箱分鐘（工程資源限制；研究 R-09） |
| 不變式 | 沙箱內程式**不可**取得 Supabase 金鑰、OpenAI 金鑰、部署憑證；沙箱與平台主介面**不同 origin**；沙箱逾期自動回收；**（2026-10-21 範圍決定）私人預覽沙箱不提供作品呼叫生成式 AI 的途徑：`env` 不含任何 AI 金鑰、不提供平台 AI 代理端點、`network` 預設 `"none"` 且 `{ allow }` 清單不得列入生成式 AI 服務網域；預覽中的作品若嘗試呼叫生成式 AI 服務，應失敗且不產生平台額度消耗（〔尚未驗證〕）** |

## 6. 工作佇列（`jobs`；內部契約）

| 動作 | 契約 |
| --- | --- |
| `enqueue(kind, payload, subject_id, school_id, idempotency_key)` | 寫入 `jobs`（同鍵不重複）；取得 `school_epoch` |
| `lease(worker_id, kinds[], lease_seconds)` | `FOR UPDATE SKIP LOCKED`；逾期租約可被回收；`attempts+1`；超過 `max_attempts`→`failed` |
| `heartbeat(job_id)` | 延長租約；回傳 `cancel_requested` |
| `checkpoint(job_id, step)` | **每個重要步驟前**：呼叫 `account_gate` 與比對 `school_epoch`；不通過→`stopped(reason)`，釋放預留，保留已完成部分 |
| `complete／fail／cancel` | 冪等；失敗碼為固定集合；取消後清理沙箱與暫存 |
| Worker 重啟 | 租約逾期後其他 Worker 接手；**步驟必須冪等**（以 `agent_steps(run_id, seq)` 唯一鍵） |
