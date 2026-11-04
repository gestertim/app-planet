# 介面契約索引與通則

**功能目錄**：`specs/001-app-planet-platform`｜**計畫**：[../plan.md](../plan.md)｜**資料模型**：[../data-model.md](../data-model.md)｜**待決**：[../decision-register.md](../decision-register.md)
**狀態**：Plan 草案。本目錄描述平台對使用者與對外系統暴露的介面（HTTP／RPC／事件），為**設計層級契約**；不含實作程式、不含 migration。實際 Zod 契約將位於 `packages/core/contracts`（見 plan.md 專案結構），由 Tasks 階段展開。

> **同步註記（2026-10-21 首版範圍決定，已寫入 spec.md Clarifications 最後一節與 FR-049）**：首版學生作品**只可採 A／B 級，不開發 C 級作品**；作品本身不得以生成式 AI 作為執行時功能，私人預覽與公開部署都不提供作品呼叫生成式 AI 的途徑。平台仍為 C｜AI-Powered：學生平台 AI 對話、輔助創作與 Coding Agent 維持（含學校核准、額度、內容安全與學生 AI 值守閘門）。**Public AI Gateway、管理員公開 AI 控制、公開 AI 池與每作品上限、每訪客限流、訪客高風險事件**等契約章節標示「已被取代・首版不適用」，原文保留作歷史；**B 級 β2 受限伺服器端能力（D-16）維持不變**。學校核准撤回涵蓋該校全部公開作品。本次同步僅更新文件，**尚未實作、未驗證**；Plan 仍待教育者審閱。後續若要加入學生 C 級作品，須另立功能與批准流程。

## 契約檔案

**2026-11-04 §93 有界產品接線**：T051 正式需求 GET／PUT 與明確分類 POST 的路徑、雙版本映射、strict body、receipt／current、大小與錯誤界線見 [PROJ §1.1](./projects-agent-sandbox.md#11-需求版本與分類確認)。只擴展本輪已批准的 HTTP／學生工作區子集；較早「僅本機、無 HTTP」仍是歷史紀錄，不是本輪限制。Gate／Q-AUTH／正式啟用不變。

**2026-10-21 最新 MVP 適用性（現行）**：下表及較早同步註記中「β2 維持首版」已被教育者本次決定取代，保留歷史。MVP 保留平台 AI、創作流程、A／不需學生伺服器程式的合格 B（含平台 Work Data API）。β2 移至後續獨立 feature，另 spec／Gate，M／W 不實作。預覽採 X：`ports: []` 建置→平台取回／檢查／保存→平台入口提供 iframe；更新為儲存→重建→重載，須顯示失敗，不代理沙箱埠。現行細節見 [projects-agent-sandbox.md](./projects-agent-sandbox.md) E-3／§5、[publishing-and-public-runtime.md](./publishing-and-public-runtime.md) §3.6／§6。產品驗收未完成，Gate 未執行。

HTTP 通則的「公開訪客端點僅靜態」補正：合格 B 另有同源 `/_work/data/v1/*`，由平台內部受限資料服務處理，非學生程式執行；未核定配額即拒絕。`student_server_runtime_not_in_mvp` 為現行範圍阻擋碼，不再回 `b_restricted_runtime_pending` 暗示首版內交付。

**T051 隔離本機例外（2026-10-24）**：[PROJ 契約](./projects-agent-sandbox.md#11-需求版本與分類確認)與 [readiness §43](../readiness-review.md) 定義最小需求版本、擁有者學生明確分類確認、當前證據解析及需求修改原子失效。僅有本機 server／資料庫子集，不新增 HTTP／RPC 對外 endpoint，不改 COMMON 的版本衝突、UUID 冪等、主體／操作作用域隔離及至少 24 小時規則；權限仍須 DB 即時重驗，confirmed 不授予任何預覽或發布操作資格。`student_server_runtime_not_in_mvp` 為現行範圍阻擋碼，不再回 `b_restricted_runtime_pending` 暗示首版內交付。

| 檔案 | 範圍 | 主要規格依據 |
| --- | --- | --- |
| [auth-and-identity.md](./auth-and-identity.md) | 登入、登入碼核發／重發、工作階段、學校閘門回應、受限（被拒絕／停用）入口（**依賴 D-07a：已選首選驗證方案 A，附實測條件 S-01～S-03，尚未執行**） | FR-035、038、045、046、051 |
| [access-and-lifecycle.md](./access-and-lifecycle.md) | 學校核准、師生綁定、教師查看與稽核、帳號停用／恢復／刪除、複查、個資請求（**2026-10-21：學校核准撤回涵蓋該校全部公開作品；C 級公開 AI 的 hold／恢復說明已標示歷史**） | FR-014、015、036、046、047、052、054、056 |
| [ai-chat-and-safety.md](./ai-chat-and-safety.md) | 對話串流與停止、工具、內容安全流程、安全事件與通知（**D-14：站內列表為保證通道、電郵為輔助、處理時段內 1 小時未確認即升級；學校處理時段待學校提供**；**後續決定 2026-10-21 取代：不以轉交學校為必經步驟、計時改依 App 值守時段（S-9）、新增 `ai_off_duty` 值守閘門與 S-8～S-10；值守設定尚未核定**）；**2026-10-21 範圍決定：保留學生 AI 的內容安全、值守、求助分流；公開 C 級訪客輸入／輸出檢查與訪客事件標示不適用於首版（已被取代・首版不適用）** | FR-001～008、016～021、053 |
| [projects-agent-sandbox.md](./projects-agent-sandbox.md) | 專案、快照、版本恢復、測試、Agent、沙箱轉接介面、工作佇列（**2026-10-21：作品等級 A／B；Agent 不得為作品加入 AI 金鑰、前端直呼或服務端 AI 呼叫；私人預覽沙箱不提供生成式 AI 途徑**） | FR-009～012、021、023、025、040、049（現行規則） |
| [publishing-and-public-runtime.md](./publishing-and-public-runtime.md) | 申請與審查、部署、公開入口、下架、作品託管中介層、**B 級受限伺服器端能力（D-16：β2 為功能目標，配額與隔離待驗證；維持不變）**、**§7 作品不得呼叫生成式 AI（2026-10-21 新增）**；~~Public AI Gateway~~（§4～§5 已被取代・首版不適用，原文保留作歷史） | FR-013、024、032、048、049（現行規則）；~~050~~（首版不適用） |
| [usage-and-budget.md](./usage-and-budget.md) | 用量預留／結算、額度與預算池、管理員調整與歸池、監測與對帳（**2026-10-21：公開 AI 池與每作品上限為「原規劃、首版不動用」，不自動轉入他池；創作池與基礎設施池維持**） | FR-030、042、055；~~050~~（公開 AI 池與每作品上限，首版不動用） |

## 通則（所有契約適用）

| 項目 | 規定 |
| --- | --- |
| 傳輸 | HTTPS；API 位於 `/api/v1/…`（Next.js Route Handlers）；公開作品中介層位於獨立網域（見 publishing 契約）；~~與 Public AI Gateway~~（首版不適用）；資料庫函式（RPC）以 `app.` 為前綴，僅供伺服器端與 RLS 內部使用 |
| 驗證 | 使用者 API：Supabase session cookie（`@supabase/ssr`）；僅辨識 `auth.uid()`，**授權以資料庫即時判定為準**（data-model §0、§2）。服務間：HMAC 簽章＋時間戳（僅 Worker 與公開中介層使用）。公開訪客端點：無使用者驗證，僅以作品與限流鍵識別（首版僅作品託管中介層的靜態檔案；~~Public AI Gateway 訪客端點~~ 首版不適用） |
| 授權 | 每個端點註明「能力」（data-model §2.1 的 capability）與資料列權限；拒絕時回 `403`（已登入）或 `401`（未登入），**不洩漏他人資料是否存在**（資源不存在與無權限皆回 `404` 的端點另註明） |
| 錯誤格式 | `application/problem+json`：`{ type, title, status, code, detail?, instance, request_id, user_message_zh }`。`request_id` 是伺服器產生的非空 opaque 字串，不含個資／憑證／路徑本文；不是冪等鍵、工作 id、學生代號或 SSE 游標。`code` 為依端點／傳輸作用域受控登錄的固定碼（如 `school_not_confirmed`、`ai_not_open`、`ai_off_duty`（值守閘門，2026-10-21 後續決定）、`quota_daily_exhausted`、`pool_creator_exhausted`、~~`pool_public_exhausted`、`work_cap_reached`~~（首版不適用）、`account_disabled`）；producer 不得透傳供應商／內部任意碼，`user_message_zh` 為安全建構的繁體中文文字（**措辭待審閱者不上線**）；不回傳堆疊、內部代號、SQL。新增碼不得改變既有狀態、權限、重試或結算語意。 **SSE `error` 事件的碼另有專屬登錄（見下方「SSE `error` 專屬碼登錄」），不與本列的 HTTP 碼共用。** |
| 冪等 | 所有會改變狀態或扣額的 `POST` 必須帶 `Idempotency-Key`（UUID，每次使用者操作產生一次）；相同鍵＋相同內容 → 回原結果，**登入碼秘密回應除外**（見下方 D-32 明示例外）；相同鍵＋不同內容 → `422 idempotency_key_reuse`；鍵保存期限 ≥ 24 小時（工程值，不等於新 journal 保存政策） |
| 並行衝突 | 可編輯 row resource 回傳整數 `row_version`，更新帶恰好一個 strong quoted `If-Match`：row 使用無空白 canonical 十進位版本（如 `"7"`），file 使用該檔小寫 64 位 SHA-256（如 `"…"`）；不接受裸值、weak tag、多值／重複標頭或 `*`。缺標頭回 `400 if_match_required`，格式不符回 `400 invalid_if_match`；授權／資源隱匿規則先處理；合法版本不符仍回既定 `409 version_conflict`，不得靜默覆蓋或改為 `412／428`。409 保留本表 problem+json 必填欄位，並以 `conflict: { current: { version, content }, submitted: { version, content } }` 限定回傳本端點允許讀寫且本次涉及的欄位；DELETE 的 submitted content 為 null，二進位檔不回傳 bytes。冪等鍵仍按既定 UUID／同鍵重放規則處理，If-Match 與冪等互不取代。 |
| 狀態查詢 | 長時間操作（Agent、圖像、部署、清除、核對）一律回 `202` 與 `Location: /api/v1/jobs/{id}`；`202` 與後續 `GET` 共用 `{ id, kind, state, progress, started_at, updated_at, result, failure }` 安全快照；**不以輪詢結果推定成功**。各 kind 狀態與欄位關係見下方 Job 快照規則；此 wire DTO 不等於資料庫 `jobs` 列。 |
| 串流 | Server-Sent Events；H-4 沿用六事件 `delta`、`block`、`support`、`partial`、`done`、`error`（CHAT §3）；原生 `event:`、`id:`、`data:` 欄位，`data:` 為與事件名相符的 JSON payload。`id:` 是同一 message 事件串的正整數十進位游標，自 1 起；`delta.seq` 是已保存且通過檢查的文字片段序號，兩者分開計數。以 `Last-Event-ID` 只續傳同一 message 的已保存事件；停止＝`POST …/stop`（冪等）。 |
| 限流 | 每端點標示限流鍵（帳號、帳號×IP 雜湊、IP 雜湊、~~作品×訪客雜湊~~〔公開 AI 每訪客限流，首版不適用〕）；超限回 `429` 與 `Retry-After`；**限流鍵只用 HMAC 雜湊，不存原始 IP** |
| 日誌 | 僅白名單欄位（data-model／research R-12）；請求與回應本文、`Authorization`、`Set-Cookie`、登入碼一律不記錄 |
| 版本相容 | 契約變更須更新本目錄並於 plan.md 修訂紀錄記載；破壞性變更須走規格同步 |
| 時間 | **（2026-10-23 教育者批准，選項 A）** 本契約的時間 wire 值使用 ISO 8601 UTC，必須以大寫 Z 結尾；不接受 +00:00 或其他偏移表示。適用契約明定的時刻欄位（例：Job 的 `started_at`／`updated_at`、`reveal_expires_at`）；不套用純日期、作品／對話自由內容、HTTP-date（如 `Retry-After`）或資料庫內部表示。不決定小數秒位數、輸出寬度或資料庫精度；合法小數秒表示保留，比較不得丟精度（`.1Z` 與 `.100Z` 為同一時刻，不得以字串相等或排序比較時刻）。週期語意（日額度、值守時段等）仍以 `Asia/Taipei` 在伺服器端計算 |
| 無障礙與語言 | 錯誤與狀態文字皆有繁體中文 `user_message_zh`；不以顏色作為唯一資訊（由 UI 層落實） |

**登入碼秘密回應的明示冪等例外（2026-10-26；〔已批准／已同步〕）**：依 [D-32(2)(3)](../decision-register.md#d-32-a-9-已批准契約原則與必要正式文件同步2026-10-26台灣)，AUTH A-8／A-9 同鍵同內容仍須在當下重驗合法身分、角色與目標資格；只回最小非秘密 receipt／操作狀態，不重播登入碼、不再次執行 Auth，不將秘密存入通用結果快取。首次原請求最多一次伺服器秘密輸出機會，輸出門閂消耗後不重播；可能零次交付，不保證恰好一次送達。receipt 不等於授權、成功或已送達，應如實區分未完成／unknown／完成；最終狀態、API／HTTP／錯誤碼映射仍待設計，不自動套通用 Job 的 `202`／路徑。同鍵異內容沿既有 `422 idempotency_key_reuse`；新鍵或鍵到期不能繞同目標未結操作。unknown 缺可信終結證據時不重發、不解除暫停。A-8 僅同步秘密重播原則，不重設核發流程或擴大領碼權。此例外不改一般非秘密結果的冪等規則，也不核定 journal schema／儲存期限。

**If-Match 操作交互（D-28）**：GET 與成功更新回應應提供該資源版本的 `ETag`，客戶端更新原樣帶回單一 strong quoted 值。成功更新的 row version 必須改變且不得重用；初始值／正值限制未另定，同內容檔案可維持同一 hash。對原本要求冪等鍵的操作，冪等內容指紋包含目標、方法、允許的本文與 `If-Match`；同一操作重送須先重驗目前身分／權限，再回原結果（登入碼秘密回應依上列明示例外），即使目前版本已更新也不把原成功改報 `409`。409 後人工合併視為新操作；只有原端點要求冪等鍵時才使用新鍵，不把 POST 的既定規則擴張為所有 PUT／PATCH。

### 階段草稿首次 HTTP 保存補充（D-33；僅 P-3 未確認草稿子集）

本節為 [D-33](../decision-register.md#d-33-階段草稿首次-http-保存2026-10-27本-session-明確批准) 明確批准的端點特例；不改其他端點原有 `if_match_required`／`invalid_if_match` 或 409 行為。所有保存需 UUID `Idempotency-Key`，本文 strict `{ content: { text: string } }`，不接受 state／owner／角色。

| 意圖 | 唯一前置條件（另一標頭不得提供） | DB expected_row_version | 成功 | 回應版本／標頭 |
| --- | --- | --- | --- | --- |
| 首次建立 | `If-None-Match: *` | null | 201 Created＋完整草稿 DTO | row_version=0；`Location: /api/v1/projects/{id}/stages/{stage}`（參數 URL 編碼）；`ETag: "0"` |
| 更新 | 單一強 `If-Match: "n"`（canonical、0～2147483647） | n | 200＋完整草稿 DTO | row_version=n+1；ETag 為新版本；`"0"` 不可建立不存在草稿 |
| 原成功重放 | 原操作同鍵／同本文／同目標／同前置條件 | 原 null 或 n，不互換 | 200＋`{ operation, current_draft }` | `Idempotent-Replay: true`；ETag 只對應 current_draft，null 時不送；不回 201／不重做建立 |

新操作兩種標頭都缺→400 `precondition_required`；並存、不支持值、重複／多值→400 `invalid_precondition`。`If-Match: *` 仍禁止，If-None-Match 僅單一 `*`，不接受 ETag 或清單。新鍵首建遇既有草稿→412 `draft_already_exists`（「草稿已存在；本地內容仍保留，請重新載入並比對」），不覆寫且不保留失敗 receipt／audit。合法更新版本不符仍 409 `version_conflict`；不存在／非 owner 沿 404 隱匿；失效／停用／降權依既定 401／403 拒絕，不回目標本文。

處理順序為合法格式解析、當下帳號／目標授權，再於同交易辨識既有鍵意圖，最後才判斷新操作的存在性／版本。相同鍵改本文、目標或首建／更新條件→422 `idempotency_key_reuse`；格式與授權不能被 replay 略過。原首建已成功不因現有資料而改報 412；operation 永遠是原 receipt，current_draft 為當下有權讀取的目前 DTO，草稿已不存在可為 null，不以 receipt 充當 current、不復活資料。UI 分別呈現原操作與目前版本；不確定結果只以原鍵原本文重試。沿用既有 receipt、資源鎖／唯一約束、DB 即時重驗與交易回滾，不新增 journal／run／快照模型；非 Agent 成功 result 契約。

**P-1 建立冪等等同性（COMMON 通則的本機具體化；readiness §41）**：作用域為可信主體＋`project_create_v1` 建立操作＋UUID 操作鍵。本文比對 title 的 UTF-8 位元組與 tier 是否提供及其值；不 trim、不正規化、不補 tier，也不把省略欄位換成其他語意。相同鍵與相同本文重放原建立結果；不同本文回本機衝突結果，不覆寫原列。冪等紀錄與專案同一交易提交／回滾，重放前以當下 `edit_saved_content` 重新授權；併發衝突由唯一鍵序列化。紀錄 expires_at 至少 24 小時，僅在過期同鍵重用時刪除，不新增永久保存政策或排程清理。這只記錄資料層契約，不新增 HTTP handler／正式 HTTP 錯誤碼；P-1 已有 HTTP 草案映射不代表本輪實作。

### Job 快照與狀態（D-25）

快照所有鍵均必填；`id` 為 UUID 工作資源識別字串，`kind` 為下表受控值。`progress` 採 `{ mode: "indeterminate" }` 或 `{ mode: "steps", completed, total }`；steps 必須為整數、`total > 0` 且 `0 ≤ completed ≤ total`，只能計已確認的實際步驟，不以進度推定成功或把租約重取算新完成。`started_at` 必填、可為 `null`；未實際開始為 null，開始後保留第一次開始時間；下表執行中狀態必須非 null，已開始後重排或終態保留首次時間。`updated_at` 必填且非 null，表示已提交快照的最後更新時間；有 started 時不得早於它。時間均為 ISO 8601 UTC，wire 必須以大寫 Z 結尾（見通則「時間」）。

`result` 與 `failure` 均為必填欄位，可為 null。非終態兩者皆 null；成功態須有該 kind 的安全結果且 `failure: null`；`failed`／`cancelled`／圖像 `stopped` 須 `result: null` 並提供固定碼及 `user_message_zh`，可有經授權的 `partial_refs`。部署 `unknown` 表示結果待核對，`result: null`，不得更新成功網址或推定可安全重跑；failure 可為 null 或安全固定失敗物件。取消旗標只表示提出取消，不能冒充取消終態；須符合該工作既定協作式停止／清理條件。

| 對外 `kind` | 對外 `state` | 必須有 `started_at` 的執行中狀態 |
| --- | --- | --- |
| `preview_build` | `queued`、`building`、`retrieving`、`validating`、`succeeded`、`failed`、`cancelled` | `building`、`retrieving`、`validating` |
| `image` | `queued`、`generating`、`succeeded`、`stopped`、`failed` | `generating` |
| `agent` | `queued`、`running`、`succeeded`、`failed`、`cancelled`；G-1 `awaiting_approval` 是 run 建立狀態，不是 Job | `running` |
| `deploy` | `queued`、`deploying`、`succeeded`、`failed`、`cancelled`、`unknown` | `deploying` |
| `purge` | `queued`、`running`、`done`、`failed` | `running` |
| `reconcile` | `queued`、`running`、`done`、`failed`、`cancelled` | `running` |

狀態只在對應業務事實成立時轉移；例如 preview 只有產物驗證及保存完成才 `succeeded`，image 只有核可成果保存才 `succeeded`，purge 只有清除步驟完成才 `done`。內部 `leased` 不直接輸出為業務狀態，內部 `done` 不單獨證明業務成功。D-14 的 `paused_off_duty`、在途／出隊、Agent 步驟及恢復仍待決，不在以上狀態列舉中採用。每 kind 的安全 `result` 欄位仍須在端點契約補齊；不得用任意 JSON 或 `unknown` 冒充已完成 DTO。

### SSE H-4 事件 payload 與游標（D-26、D-27）

每個可重放事件以 `id: <正整數十進位>`、`event: <六種事件名>`、`data: <該事件 JSON>` 編碼並以空行結束；游標在單一 message 事件串內自 1 遞增，只於已檢查且保存的事件分配，重放沿用原 id。`delta` payload 為 `{ seq: integer, text: string }`，seq 對該 assistant message 已保存／通過輸出檢查的片段自 1 遞增；`partial.saved_through_seq` 必須等於同一保存快照最後片段 seq，沒有片段為 0。游標與片段序號互不替代。

| `event:` | `data:` JSON payload |
| --- | --- |
| `delta` | `{ seq, text }` |
| `block` | `{ category_group: "inappropriate", safe_alternative_key }` |
| `support` | `{ level: "support" \| "high_risk", template_key }` |
| `partial` | `{ saved_through_seq }` |
| `done` | `{ usage: { reserved: number \| "unknown", settled_display: number \| "unknown" } }` |
| `error` | `{ code, user_message_zh, retryable }` |

`reserved`／`settled_display` 只有確知的非負有限數值才可用數字表示；不確定用 `"unknown"`，不得當零或金額。`block`／`support` 後以 `done` 結束；正常完成、partial 與 error 是互斥終止事件，終止後不再送 delta。`done` 只表示串流正常結束，不表示內容未被攔、通知已送達或費用已結算。Last-Event-ID 只適用同一 message；無標頭時續傳 GET 從首個已保存事件重放；格式錯誤／超前／未曾發出的游標回 `400 invalid_event_cursor`，已有效但不可重放回 `409 event_cursor_unavailable`。兩者使用 problem+json，授權仍須先重驗；保存期限沿用既有資料保存政策，不新增 SSE retention。

### SSE `error` 專屬碼登錄（D-26、D-29b；2026-10-23 教育者批准）

SSE `error` 的 `code` 只能使用下列 SSE 作用域碼；HTTP 回應碼（`ai_not_open`、`ai_off_duty`、`school_not_confirmed`、`quota_daily_exhausted`、`pool_creator_exhausted`，H-4 於 `200 text/event-stream` 之前回應）**不是** SSE 碼，不得出現在 `error` 事件。未知碼拒絕，不透傳供應商文字或內部碼；`error` 維持 `code`、`user_message_zh`、`retryable` 三鍵，不增加 `usage` 或安全附加欄位。

| `code` | 語意 | `retryable` | 模板 key（候選；文案為草案） |
| --- | --- | --- | --- |
| `web_search_failed` | 暫時性搜尋工具失敗；送 `error` 即終止，不自動改成不用搜尋繼續回答 | `true` | `sse_error_web_search_failed` |
| `safety_check_unavailable` | 串流建立後的輸出安全檢查暫時失敗；fail-closed，不放行未檢查內容 | `true` | `sse_error_safety_check_unavailable` |
| `generation_failed` | 已確認為供應商／生成端終止性錯誤；明確暫時性 `true`，已知非暫時性或無法確認可重試 `false`；不能只因 `retryable:false` 就改稱內部錯誤 | `true`／`false` | `sse_error_generation_failed` |
| `stream_internal_error` | 無法歸入已知分類的非預期內部失敗 | `false` | `sse_error_stream_internal` |

規則：(1) `error` 是終止事件，與 `done`／`partial` 互斥，之後不得再新增任何事件；終止後重放已保存事件不算新增生成。(2) 以成因區分 `error` 與 `partial`：使用者停止、逾時或可回報中斷用 `partial`（無片段時 `saved_through_seq:0`）；供應商／生成端終止性失敗用 `error`；連線已斷不保證能送出任何終止事件。(3) `retryable` 不代表自動重試、不保證可安全重做、不授權再次扣額；新操作須重新授權並通過原有閘門。(4) `error` 後 `messages.state` 為 `failed`（見 [data-model §3](../data-model.md)）。(5) 只保存並重放可安全建構的事件（含安全的 `partial`／`error`，沿用原 id；歷史 `done` 的 `usage` 不重新計算）；不保存未檢查內容。(6) 不新增 retention、重試次數、費用或恢復政策。(7) **S4（串流中途閘門重驗失敗）仍依賴 D-14，不登錄、不以其他碼代替**；串流前輸入檢查失敗的 HTTP 呈現尚未決定。(8) 文案為草案，教育者與專業適齡／安全審閱完成前不上線。

### 額外欄位責任（D-30）

固定輸入物件（含巢狀固定物件）未知欄位拒絕並回 `422 unknown_field`；明定自由內容欄位不套此規則。既有 AUTH 學生帳號 API 未知欄位 `422` 規則不變。Producer 必須逐角色／端點／事件建構並驗證輸出允許欄位，不可直接 spread DB row、供應商物件或 loose parse 結果；已知文字欄位亦須安全建構。Reader 驗證已知必要欄位後，可保留或忽略擴充欄位，但不得自動呈現、回顯、保存至業務列／日誌或轉送。Adapter 僅投影明確支援欄位；必要欄位缺失或錯型別須明確失敗，不補空值或成功形狀。輸入驗證、producer 白名單與內容去敏／日誌遮蔽互不取代。

## 契約的「已批准／待決」標示
端點行為若依賴〔待決 D-xx〕，於該列標示；**待決項目的行為以設定值呈現，不得硬編碼預設答案**。
