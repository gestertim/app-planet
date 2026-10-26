# 契約：對話、工具與內容安全

**對應**：FR-001～008、016～022、026、031、053（**公開 C 級訪客相關部分【已被取代・首版不適用（2026-10-21 範圍決定）】**）｜**研究**：[../research.md](../research.md) R-04｜**資料模型**：[../data-model.md](../data-model.md) §3、6｜**待決**：D-14（通道與升級規則已於 2026-10-21 核定；**同日後續決定取代：不以轉交學校為必經步驟、升級計時改依 App 值守時段、新增學生 AI 值守閘門**；值守時段與名冊、邊界情境、郵件供應商、文案與法務／兒少保護專業審閱待決；~~訪客事件細節~~首版不適用）｜通則見 [README.md](./README.md)

> **同步註記（2026-10-21 首版範圍決定）**：本契約**保留**平台**學生** AI 的內容安全管線、求助分流、安全事件與通知、值守閘門（`duty_gate('student_ai')`、S-8～S-10）；**公開 C 級訪客**的輸入／輸出檢查、訪客高風險事件與其值守、通知一律標示「已被取代・首版不適用」並保留原文（見 S-1、S-3、S-4、S-10、§6）。值守契約只保留學生 AI。學生要求作品自己呼叫 AI 的說明規則見 §4。學生高風險事件仍由有效綁定教師（無則管理員）依 App 案件流程處理；法務與兒少保護專業審閱關卡不變。本契約為設計層級，尚未實作、未驗證。

## 1. 對話與訊息

| # | 方法與路徑 | 能力／授權 | 輸入 | 回應 | 錯誤 | 冪等／限流 |
| --- | --- | --- | --- | --- | --- | --- |
| H-1 | `POST /api/v1/conversations` | `edit_saved_content` | `{ skill_id? }` | `201`；**新對話不沿用其他對話脈絡**（FR-001） | `403` | `Idempotency-Key` |
| H-2 | `GET /api/v1/conversations?q=&cursor=` | `read_saved_content`；僅擁有者 | 搜尋、分頁（**可查找全部歷史**，不只最近紀錄） | 列表 | — | — |
| H-3 | `PATCH／DELETE /api/v1/conversations/{id}` | 擁有者 | 重新命名／刪除；刪除前由 UI 顯示影響；**另存專案與檔案庫不連帶刪除**（FR-022） | `200／204` | `404`；合法 validator 但版本不符 `409 version_conflict` | `If-Match`（單一 strong quoted `row_version`；格式與 conflict 本文依 COMMON） |
| H-4 | `POST /api/v1/conversations/{id}/messages` | `ai_call`（含學校閘門、帳號、額度、內容安全）；擁有者 | `{ text, attachment_ids[], skill_id?, tools: { web_search?: bool }, client_request_id }`（空白訊息拒收；長度上限 PP） | `200 text/event-stream`（見 §3）；訊息先以 `state=partial` 寫入，完成後 `complete`；`error` 終止後為 `failed`（保留已保存片段） | `403 ai_not_open`（學校撤回／失效）；`403 ai_off_duty`（**後續決定 2026-10-21**：非值守時段、值守設定未核定或名冊無主責／備援；於預留額度與呼叫模型之前回應；不使用 `ai_not_open`，兩者原因不同；文字「AI 目前不在開放時段」〔待審閱，不宣稱有人在線或 24 小時可用〕）；`403 school_not_confirmed`；`429 quota_daily_exhausted｜pool_creator_exhausted`（**區分原因**）；`429` 頻率／並行；`409`（同對話已有進行中生成） | `client_request_id` 即冪等鍵；限流：帳號、並行 |
| H-5 | `POST /api/v1/conversations/{id}/messages/{mid}/stop` | 擁有者 | `{}` | `200`；訊息標 `partial`，保留已完成內容；**預留釋放／結算**；不承諾已發生的外部費用可撤銷 | `404` | 冪等 |
| H-6 | `GET /api/v1/conversations/{id}` | 擁有者；已綁定教師（`teacher_can_view_student`，留稽核） | — | 對話與訊息；每則標示發話者與 Skill；還原 `last_skill_id` | `404` | — |
| H-7 | `POST /api/v1/conversations/{id}/handoff` 與 `…/handoff/{hid}/confirm｜cancel` | 擁有者；`ai_call` | 切換 Skill 時產生**由當前脈絡生成**的可編輯摘要；確認時**重新授權引用資料** | 摘要；`confirm` 後切換；`cancel` 後原對話、草稿與 Skill 不變 | `422`（引用已無權限者被排除並回報於 `excluded_refs[]`） | 冪等 |

## 2. 附件、檔案庫、圖像、網頁搜尋

| # | 端點 | 授權 | 行為與錯誤 |
| --- | --- | --- | --- |
| F-1 | `POST /api/v1/attachments`（建立上傳：回傳簽名上傳 URL ≤60 秒） | 擁有者 | 格式／大小／數量依設定值（PP-17，待核定）；超限 `422 file_limit_exceeded`（文字說明「上限依正式政策」，不沿用示範 10 MB）；上傳後 `scan_state: pending→clean｜rejected｜failed`；**處理中回報是否仍可送出及原因**；可移除、可重試 |
| F-2 | `GET /api/v1/library?q=` | 擁有者 | 空白狀態回傳 `items: []` 與 `empty_reason` |
| F-3 | `POST /api/v1/images`（`202`＋job） | `ai_call`＋學校閘門＋**值守閘門（`ai_off_duty`，後續決定 2026-10-21）**＋額度＋內容安全 | 狀態：`queued｜generating｜succeeded｜stopped｜failed`；**失敗或停止不建立成果項目**；成功後可預覽、存檔案庫、加入專案；提示詞先審、成品再審（R-04c） |
| F-4 | `POST /api/v1/images/{id}/stop` | 擁有者 | 冪等；釋放預留 |
| W-1 | 網頁搜尋：作為 H-4 的 `tools.web_search`（Responses API `web_search` 工具） | `ai_call` | 成功回答附**實際來源連結**；失敗回 `error` 事件與提示（SSE 碼 `web_search_failed`、`retryable: true`，2026-10-23 批准；送 `error` 即終止該次嘗試，**不自動改成不用搜尋繼續回答**），**不以固定示例冒充**；來源網域政策（`allowed_domains` 清單是否採用）屬設定，建議兒童情境預設啟用封鎖清單並審閱 |

## 3. 串流事件規格（H-4）

| 事件 | 載荷 | 說明 |
| --- | --- | --- |
| `delta` | `{ seq: integer, text: string }` | 已保存且通過輸出檢查的片段（以句為單位緩衝）；同一 assistant message 的 seq 自 1 遞增 |
| `block` | `{ category_group: "inappropriate", safe_alternative_key }` | 輸出或輸入被判不適齡：**不含被攔內容**；UI 顯示簡短不責備的替代引導（模板 key，文案待審閱）；訊息 `state=blocked` |
| `support` | `{ level: "support" ｜ "high_risk", template_key }` | **求助分流**（與 `block` 不同路徑）：顯示已審閱的固定模板；`high_risk` 另顯示即時求助方向；**不暗示老師已被通知** |
| `partial` | `{ saved_through_seq: integer }` | 停止或中斷；等於該保存快照最後片段 seq，無已保存片段為 `0` |
| `done` | `{ usage: { reserved: number \| "unknown", settled_display: number \| "unknown" } }` | 結束；數值僅代表確知的非負有限創作能量，不是金額；未知必須為 `"unknown"`，不可當零 |
| `error` | `{ code, user_message_zh, retryable }` | 使用 SSE 作用域受控固定碼（2026-10-23 批准，見 [COMMON「SSE `error` 專屬碼登錄」](./README.md)）：`web_search_failed`（true）、`safety_check_unavailable`（true）、`generation_failed`（暫時性 true；已知非暫時性或無法確認可重試 false）、`stream_internal_error`（false）；HTTP 回應碼不是 SSE 碼；終止事件；**不顯示假成功**；僅三鍵，不含 `usage` 或安全附加欄位 |

**中斷與續傳**：事件帶 `id`；斷線後 `GET …/messages/{mid}/events` 以 `Last-Event-ID` 重放已保存部分；Worker／函式逾時時訊息轉 `partial`，列出未完成項目與恢復選擇（FR-026）。

**H-4 wire 表示（D-26／D-27）**：沿用本節六種事件；以原生 SSE `event:` 寫事件名稱、`id:` 寫同一 message 事件串自 1 遞增的正整數十進位游標、`data:` 寫且只寫對應事件的 JSON payload，事件以空行結束。游標只在已檢查並保存的可重放事件分配，重放沿用原 id；游標與 `delta.seq` 分別計數。Last-Event-ID 僅限該 message；格式錯誤／超前／未曾發出回 `400 invalid_event_cursor`，有效但已不可重放回 `409 event_cursor_unavailable`；兩者以 problem+json 回應並先重驗授權。`done.usage` 依 COMMON D-27 型別；未知不轉成 0，不改寫重放中的歷史 usage。

每次生成嘗試最多有一個終止事件：正常結束為 `done`，明確停止／可回報中斷為 `partial`，可回報錯誤為 `error`；終止後不再送 `delta`。`block`／`support` 後接 `done`。`done` 僅表示串流正常結束，不表示未被攔截、通知已送達或帳本已完成結算。值守結束時在途操作與 `paused_off_duty` 狀態仍依 D-14 待決，不由上述 wire 規則推定。

**`error`／`partial` 的成因區分與保存（2026-10-23 批准）**：使用者停止、逾時或可回報中斷依上列用 `partial`（無片段時 `saved_through_seq: 0`）；供應商／生成端終止性失敗、搜尋工具失敗、串流建立後的輸出安全檢查暫時失敗與非預期內部失敗用 `error`。連線已斷不保證能送出任何終止事件，缺終止事件不得被讀成成功。`error` 之後 `messages.state` 為 `failed`：已檢查且已保存的片段保留可讀並明示未完成，不標 `complete`。`retryable` 不代表自動重試、不保證可安全重做、不授權再次扣額；使用者重送是新操作，須重新授權並通過原有閘門。保存並重放歷史終止事件：`done` 沿用原 id 與原 `usage`（不重新計算），安全的 `partial`／`error` 亦保存並沿用原 id；只保存可安全建構的事件，不保存未檢查內容；終止後重放已保存事件不算新增生成。**S4（串流中途閘門重驗失敗）仍依賴 D-14，不登錄、不以其他碼代替**。文案為草案，專業適齡／安全審閱完成前不上線。

## 4. 內容安全管線（所有**學生平台 AI** 入口共用；順序固定；首版無公開訪客入口）

```
輸入 ─▶ [規則：長度／格式／個資樣式攔阻] ─▶ [Moderation：文字＋圖片] ─▶ [求助分類器（小模型，嚴格 JSON）]
          │                                   │                              │
          ▼（阻擋）                           ▼（flagged）                    ▼（help_seeking / high_risk）
        400/422                       分流：不適齡 → block                  support（固定模板）＋建立事件＋通知
                                       正常 → 取得額度預留 → 呼叫模型（store:false、safety_identifier=HMAC）
                                                  │
                                        輸出串流 ─▶ [逐句 Moderation] ─▶ delta／block
```

| 規則 | 說明 |
| --- | --- |
| 分流不得混用 | 「求助」與「不適齡請求」使用**不同模板與事件路徑**；高風險求助**不呼叫模型生成輔導內容**（固定模板，避免未審閱的 AI 輔導語） |
| 失敗行為 | Moderation／分類器暫時失敗時：**fail-closed 於輸入**（暫停該次生成並顯示「暫時無法處理，請稍後再試」，不放行未檢查內容）；寫入非敏感的健康事件；不顯示假成功。**（2026-10-23）不批准延後或重排既有輸入安全檢查**；串流前輸入檢查失敗的 HTTP 呈現尚未決定；串流建立後的輸出安全檢查暫時失敗以 SSE `safety_check_unavailable` 回報 |
| 最小事件 | 事件只存類別、時間、對象（內部代號）、處理狀態；**不存輸入／輸出全文**；被攔輸入不保存原文 |
| 不承諾 | 畫面與文件**不承諾**全天監看、即時救援、零誤判，**也不宣稱平台提供即時救援**；**〔後續決定，2026-10-21〕也不宣稱免除可能適用的法定通報，不宣稱 24 小時有人處理或「有人在線」**；不暗示老師已被通知（除非 `safety_notifications` 確有站內紀錄且 `state` 為 `delivered`；**電郵送出不算**） |
| 值守閘門（後續決定 2026-10-21） | 學生 AI 入口在進入本管線**之前**先過 `duty_gate('student_ai')`（data-model §6.4）：被擋者不進分類器、不預留額度、不呼叫模型，回 `403 ai_off_duty`；因此**非值守時段不會產生新的求助偵測**，學生畫面須有固定文字提醒「遇到困難請找身邊可信任的大人」（**待專業審閱**；不暗示有人在線）。已通過閘門而在途的請求依 D-14 邊界情境第 4 列處理 |
| 供應商傳送 | 一律 `store:false`；送出 `safety_identifier=HMAC(pepper, 學生 aid)`；不送暱稱、不送電郵（本無）、不送 uuid 原值 |
| 作品執行時 AI 需求（2026-10-21 範圍決定；草案，待教育者／專業審閱） | 學生於對話或 Agent 指示中要求「讓我的作品自己呼叫 AI」→ 回固定說明模板 `runtime_ai_unsupported`：首版不支援需要作品執行時呼叫 AI 的 C 級作品，並引導改為不依賴作品執行時 AI 的 A／B 設計；**不是** `block`、**不是** `support`，不建立安全事件；Agent 的處理規則見 [projects-agent-sandbox.md](./projects-agent-sandbox.md) §3。平台 AI 對話本身（學生使用 AI 製作作品）不受影響，也不使作品升級為 C。 |

## 5. 安全事件與通知（站內為保證通道）

| # | 端點 | 授權 | 輸入 | 回應 | 備註 |
| --- | --- | --- | --- | --- | --- |
| S-1 | `GET /api/v1/safety/events?state=open` | **已綁定教師**（僅自己學生的事件）；管理員（全部學生事件；~~含訪客事件~~【首版不適用】） | 篩選 | 列表：`category`、`severity`、`at`、`subject label｜listing label`、`handling`；**不含對話內容** | ~~訪客事件**僅管理員**可見，且無訪客與學生識別~~【已被取代・首版不適用（2026-10-21 範圍決定）；原文保留作歷史；首版無訪客事件】 |
| S-2 | `POST /api/v1/safety/events/{id}/receive` | 收件者 | `{}` | `handling=received`；記錄接收者與時間 | 冪等 |
| S-3 | `POST /api/v1/safety/events/{id}/forward` | 收件者 | `{ forwarded_to: "school_contact", note_code? }` | `handling=forwarded`；記錄「已聯絡學校處理」與轉交結果的固定碼 | 冪等；**不含不必要的完整對話**；~~訪客事件由管理員記錄評估與聯絡結果（欄位〔D-14〕待決）。~~【訪客事件部分已被取代・首版不適用（2026-10-21 範圍決定）；原文保留作歷史】**〔後續決定取代，2026-10-21〕：`forward` 改為「選用的外部聯絡紀錄」（`forwarded_to` 為對象類別固定碼，不含個人聯絡資料），**不是必經步驟**，可略過直接 `close`（S-8）；原欄位值 `school_contact` 保留為其中一個類別；不得因未 `forward` 而阻擋結案或升級**。 |
| S-4 | 通知派發（內部事件） | 系統 | 高風險事件建立時（**同一交易**）：寫入 `safety_events` 與 `safety_notifications(state=delivered)`，使事件**立即**出現在收件者站內待處理列表；收件者＝已綁定且可接收的教師（無則管理員；~~訪客事件一律管理員~~【首版不適用，原文保留作歷史】）。**交易提交後**才同步嘗試輔助電郵（郵件服務未設定→`email_state=not_configured`） | **站內通知必達；電郵為輔助，失敗只記錄並提示管理員，不回滾事件、不影響站內列表**；`email_state=sent` **不改變** `state`／`handling`（**電郵送出≠已接收≠已轉交學校**） | 站內通知本文僅含 `類別、時間、對象代號、處理狀態、連結`；**不含對話**。**電郵本文僅「有一則待處理安全事件」與登入連結，不含類別、對象代號、對話〔Plan 提案：郵件供應商與資料處理條件尚未核對，待確認〕** |
| S-5 | 升級檢查（內部排程＋列表即時計算） | 系統 | 對 `state=delivered` 的通知計算 `app.handling_elapsed`（只計學校處理時段內時間，data-model §6.1） | 累計 ≥1 小時未確認→建立 `admin_escalated` 通知給管理員、原通知 `escalated`；原收件者已是管理員→僅標 `overdue_unacknowledged`；該校 `school_handling_windows.status=unset`→**不計時、不升級**，標 `no_handling_window` | 排程失敗不影響列表可見性；**不對外承諾任何時限**；測試見 quickstart V-44、V-46。**〔後續決定取代，2026-10-21〕計時改為 `app.duty_elapsed`（只計 App 核定值守時段，data-model §6.1「後續決定」、§6.4）；`school_handling_windows` 不實作，「未設定→不計時、不升級」改為「值守設定未核定→AI 閘門關閉，既有案件標 `no_duty_config`」；原收件者已是管理員→標 `overdue_unacknowledged` 並建立 `admin_backup` 通知給名冊備援（非原收件者；不設第三層，待核定）；電郵狀態不影響計時；測試見 V-46、V-50。原文保留作歷史** |
| S-6 | `PUT /api/v1/admin/schools/{id}/handling-window` | **僅管理員**（教師呼叫→`403`＋安全事件） | `{ windows[], holidays[], contact_window_label }`（**學校提供之內容**；不得含個人聯絡資料） | `200`；`status=provided`；寫稽核（舊值、新值、操作者、時間） | `Idempotency-Key`；Plan 不預設任何時段值。**〔後續決定取代，2026-10-21：本端點不實作，改由 S-9 維護 App 值守設定；原文保留作歷史〕** |
| S-7 | `GET /api/v1/admin/safety/attention` | 管理員 | — | 列出 `attention` 非空的事件：`email_failed`、`no_handling_window`〔後續決定取代為 `no_duty_config`〕、`escalated`、`overdue_unacknowledged`、`admin_backup_notified`、`carried_over`（僅類別／時間／狀態，不含對話） | 供管理員處理「電郵未送出」與「未設定處理時段」提示 |
| S-8 | `POST /api/v1/safety/events/{id}/close`（**新增，後續決定 2026-10-21**） | 收件者（處理者）或管理員 | `{ outcome_code }`（固定碼集合〔待核定〕；不含自由文字與對話） | `handling=closed`；記錄結案者與時間；通知 `state=closed` | 冪等；**不要求先 `forward`**；已 `closed` 者不可再改；稽核 |
| S-9 | `PUT /api/v1/admin/duty-settings`（**新增，取代 S-6**） | **僅管理員**（教師呼叫→`403`＋安全事件） | `{ weekly_windows[], holidays[], handover_rule_code?, roster[]（admin_aid、role、window_ref、effective_from／to）, approved_ref? }`；**Plan 不預設任何值**；`approved_ref` 只登錄「教育者已核定」的紀錄引用 | `200`；`status` 為 `drafted`（無 `approved_ref`）或 `educator_approved`（附 `approved_ref`）；寫稽核（舊值、新值、操作者、時間；僅內部代號） | `Idempotency-Key`；名冊人員須為有效已核准管理員；**未核定前 `duty_gate` 一律關閉**；本端點不代替教育者核定 |
| S-10 | `GET /api/v1/duty/state` | 已登入（學生／教師／管理員）；~~公開閘道另以內部呼叫~~【首版不適用：無公開 AI 閘道；值守契約只保留學生 AI】 | — | `{ student_ai_open: bool, reason_code }`（固定碼，data-model §6.4）；**不回傳名冊、人名、時段內容或「有人在線」字樣**；管理員另可取得完整值守設定 | 供學生端文字說明「AI 目前不在開放時段」與管理員列表提示；**不得用來宣稱即時處理** |

## 6. 公開 C 級訪客的內容安全【已被取代・首版不適用；原文保留作歷史】

> **【已被取代・首版不適用（2026-10-21 範圍決定）；原文保留作歷史】** 首版無公開 AI 與訪客輸入／輸出檢查、無訪客高風險事件、無公開 C 級值守；下列原文不再是現行契約或驗收承諾（原文所引用的 publishing 契約 §5 亦已標示被取代）。
見 [publishing-and-public-runtime.md](./publishing-and-public-runtime.md) §5：同一管線，但**高風險輸入不呼叫模型、僅建立最小事件並通知平台管理員**，且無訪客／教師對象。
