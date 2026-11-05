# 契約：學校核准、綁定、教師查看、帳號生命週期、複查與個資請求

**對應**：FR-014、015、036、046、047、052、054、056｜**資料模型**：[../data-model.md](../data-model.md) §1、2、7、9｜**待決**：~~D-01～06~~ D-03～06（D-01、D-02 因 C 級不在首版而不再阻擋，保留為後續版本待決）、D-09、D-10、D-15｜通則見 [README.md](./README.md)

> **同步註記（2026-10-21 首版範圍決定）**：首版所有公開作品（A／B 級）皆不含作品執行時 AI，因此**學校核准撤回／失效時，該校全部公開作品一併停止公開**（FR-047(d)；§2 第一列）；原「該校 C 級公開 AI 作品 `ai_state→suspended`＋`listing_ai_holds`」「`policy.c_page_during_school_withdrawal`（D-01）」「`policy.c_ai_after_school_restore`（D-02）」及 `restore` 回應中的「不得暗示公開 C 級作品 AI 已恢復」皆標示「已被取代・首版不適用」並保留原文作歷史；**`restore` 仍僅解除校級阻擋，不自動恢復任何公開頁面**（須新的申請→審查→部署）。上線關卡（學校同意／告知證據等）仍未取得。本契約為設計層級，尚未實作、未驗證。

## 1. 學校核准（僅平台管理員）

| # | 端點 | 授權 | 輸入 | 回應／行為 | 錯誤 | 冪等／稽核 |
| --- | --- | --- | --- | --- | --- | --- |
| L-1 | `POST /api/v1/admin/schools` | 管理員 | `{ label }` | `201`；`approval_state = unconfirmed` | `403`（非管理員，**寫安全事件**） | `Idempotency-Key`；稽核 |
| L-2 | `POST /api/v1/admin/schools/{id}/approval` | **僅管理員**（教師呼叫→`403`＋安全事件） | `{ action: "verify" ｜ "withdraw" ｜ "expire" ｜ "restore", doc_version_label?, doc_date?, reason_code }`；`restore` 與 `verify` **必填** `doc_version_label` | `200`＋新 `approval_state`、`approval_epoch`；交易內執行 §2 的連動；回傳**連動摘要**（受影響的作品數、申請數、進行中工作數） | `409`（非法轉移）；`422`（缺文件版本） | `Idempotency-Key`；稽核（操作者、時間、對象學校、被停止公開的作品清單）；**不含學生或家長個人資料** |
| L-3 | `GET /api/v1/admin/schools/{id}` | 管理員 | — | 狀態、文件版本資訊、最後變更；`valid_until`〔D-04，語意待決〕 | — | — |

**允許的轉移**：`unconfirmed→approved`（verify）；`approved→withdrawn`；`approved→expired`（人工或依 D-04 的判定）；`withdrawn｜expired→approved`（restore，須記錄文件版本與「重新核對供應商條件」）。其他轉移 `409`。**`restore` 僅解除校級阻擋**，回應文字須如此表述，不自動恢復任何公開頁面。~~**不得暗示公開 C 級作品 AI 已恢復**。~~【已被取代・首版不適用（2026-10-21 範圍決定）；原文保留作歷史；首版無 C 級公開 AI】

## 2. 學校狀態變更的連動（L-2 交易內；結果須可由 `jobs` 狀態查詢）

| 轉移 | 同步（交易內） | 非同步（工作，冪等、可重試） |
| --- | --- | --- |
| `→ withdrawn／expired` | `approval_epoch+1`；所有 `leased` 的 AI／Agent 工作標記 `cancel_requested`；新 AI 預留被拒；公開部署起點被拒；**該校全部公開作品（首版皆無作品執行時 AI；A／B 級）`page_state→stopped(school_approval_*)`**（原文為「該校非 AI 公開作品」，保留作歷史）；~~**該校 C 級公開 AI 作品 `ai_state→suspended`＋新增 `listing_ai_holds(reason='school_approval')`**；**C 級頁面依 `policy.c_page_during_school_withdrawal`（D-01）**（未設定：測試環境拒絕執行此分支並告警；正式環境 C 級公開 AI 本就不得上線）~~【已被取代・首版不適用（2026-10-21 範圍決定）；原文保留作歷史】 | 呼叫託管供應商 API 移除網域／刪除部署（雙保險）；清理預覽權杖；通知管理員（站內）；寫 `listing_stop_log` |
| `→ approved`（restore） | `approval_epoch+1`；**不改動任何 `page_state`**；~~依 `policy.c_ai_after_school_restore`（D-02）：`auto_release`→釋放 `school_approval` hold；`require_rereview_redeploy`→保留 hold~~【已被取代・首版不適用（2026-10-21 範圍決定）；原文保留作歷史；首版無 C 級 AI hold，停止公開的作品須新的申請→審查→部署才可恢復】 | — |
| `unconfirmed→approved` | `approval_epoch+1` | — |

**「立即」的語意**：AI 閘門在**下一次請求或下一個重要步驟**即生效（資料庫即時判定）；頁面停止的實際延遲＝下架時限（D-08，PP-01），**未核定前不得宣稱 SC-018 已驗收**。

## 3. 師生綁定與教師查看

### 教師學校歸屬管理（2026-11-05 §103 有界子集）

本輪明確批准既有 M1 管理員建立／結束能力接線，先前「僅模型、不建管理端點」為歷史批次限制，不改寫未決帳號／學校／保存政策。歸屬不是綁定或學校批准；教師登入仍不依歸屬。正式啟用、Gate／Q-AUTH 不變。

| 端點 | strict 輸入 | 成功／讀回 |
| --- | --- | --- |
| `GET /api/v1/admin/teacher-school-memberships?kind=teachers\|schools\|memberships&after?` | kind 必填、after 為 UUID；拒絕未知／重複鍵與自報資格／名額 | `200 {outcome:"found",kind,items,next_cursor}`；各資源按 UUID 升序，每頁最多 20 筆，next_cursor 為最後一筆 ID 或 null；工程分頁不是帳號／學校名額 |
| `POST /api/v1/admin/teacher-school-memberships` | `{teacher_id:UUID,school_id:UUID}`、UUID `Idempotency-Key` | `201` 原 receipt；同鍵同意圖 `200`＋`Idempotent-Replay:true`，不新建 |
| `DELETE /api/v1/admin/teacher-school-memberships/{id}` | 指定 membership UUID、strict `{}`、UUID `Idempotency-Key` | `200` 原結束 receipt；replay `200`＋同上 header，不影響其他或新 ID |

- 每請求可信 Auth `/auth/v1/user`，非特權 authenticated DB session；不解碼 JWT 授權、不信 caller role、不以 service_role 接線。讀取亦使用只做授權鎖的 read-write transaction（沒有資料異動），admin profile `FOR SHARE` 後重驗。建立／結束依 UUID key lock→profiles（UUID 排序）→school→pair lock→membership row lock，鎖保留至提交；目標資格鎖後再判斷。新增只支持已批准且 deletion_state=none 教師、approved 且按既有 valid_until 判定未到期學校；不合格學校 `409 membership_school_not_supported` 明示本輪目前不支援。結束為收權，目標後來失效仍可結束。
- candidates strict `{id,display_label,qualified:true}`，不複製 Auth email；memberships strict `{id,teacher_id,school_id,state,teacher_label,school_label}`，含 ended 歷史。receipt strict `{outcome:"created"|"ended"|"replayed",operation:"create"|"end",membership_id,teacher_id,school_id,state,operated_at}`，UTC 六位微秒；state 是原操作狀態，不是 current／授權／批准。UI 成功後 reload／GET 讀回 DB。
- `401` 無可信身分、`403 forbidden` 非當下有效 admin／來源不合法；`400` strict DTO／query／UUID key 格式、`413` 本文過大、`415` 媒體類型；`404` 指定 ID 不存在；`409 membership_exists`／`membership_ended`／`teacher_not_eligible`／`membership_school_not_supported`；`422 idempotency_key_reuse` 同鍵異意圖。Auth／查詢依賴故障 `503 dependency_unavailable`，異動提交未確認 `503 operation_outcome_unknown`，不回空成功。所有回應 no-store，不輸出通用帳號或 audit。
- 每 teacher／school 至多一個 active；ended 保留、不 DELETE／不改 active，重加新 ID。同鍵與異動／最小白名單 audit／receipt 同交易；audit 故障全部 rollback。replay 仍重驗 admin，舊 create receipt 即使已 ended 也只回原操作；延遲舊 end 不作用於新列。收權經既有 epoch 使舊 Specification 批准失效，不改原提交／決策，不自動結束 binding。重加後 reader 仍須全部現行資格，舊批准不復活。
- `/admin` 入口→`/admin/teacher-school-memberships`，選雙方、核對標籤／ID／讀取當下狀態、Dialog 明確確認；取消／Escape 不送出、焦點返回，hydration 前關閉操作。敏感連結 prefetch=false。未知結果只保留帳號 scope 下分頁原 key／body／target，明確原鍵重試，不自動換鍵／重送；共用既有 binding controller 的生命周期及完整意圖清理核對，舊 instance 晚到不得清除新操作。分頁 storage 並非正式保存／永久 journal。

**2026-11-04 D-34 有界實作**：Specification 的待審／詳情／決策沿 [專案契約的單階段審查](./projects-agent-sandbox.md#specification-單階段提交與教師審查d-3495)，必須同時有效帳號、學生學校、持久教師學校歸屬與師生綁定；不使用帳號批准 RPC，也不擴充 T-1／T-2 綁定管理入口。profiles／school／binding／membership 的審查專用世代保證資格恢復不復活舊批准，不代表完整帳號生命週期服務。新增 audit action 僅 specification_submitted／specification_approved／specification_returned，object_type=project、meta={}；詳情沿 teacher_view。理由與本文不進稽核。

| # | 端點 | 授權 | 輸入 | 回應／行為 | 錯誤 | 冪等／稽核 |
| --- | --- | --- | --- | --- | --- | --- |
| T-1 | `POST /api/v1/admin/bindings` | 管理員 | `{ teacher_id, student_id }` | `201`；學生端提示同步更新（不需重新整理；以 Realtime 或下次請求回傳 `teacher_notice`） | `409`（已存在）；`409 student_not_approved`（學生停用／刪除中不可綁定，〔工程假設〕） | `Idempotency-Key`；稽核 |
| T-2 | `DELETE /api/v1/admin/bindings/{id}` | 管理員 | `{ end_reason }` | `200`；**教師新的存取立即失效** | `404` | 稽核 |
| T-3 | `GET /api/v1/teacher/students` | 教師 | — | **僅**回傳已綁定且允許的學生；**停用當時已綁定且帳號仍停用**者以 `{ id, display_label, frozen: true }` 出現（不含任何專案資料），其餘學生不出現 | — | — |
| T-4 | `GET /api/v1/teacher/students/{id}/projects｜conversations｜files｜activity` | 教師＋`teacher_can_view_student` | 分頁參數 | 資料；每次開啟寫 `audit_events(action='teacher_view')`（PP-12 合併窗口；**不含內容**） | **無權限一律 `404`**（不洩漏學生是否存在）；停用凍結→`403 view_frozen`（僅對停用當時已綁定教師顯示凍結說明） | 稽核 |
| T-5 | `GET /api/v1/admin/audit/teacher-views?student_id&teacher_id` | 管理員 | 篩選 | 教師、學生代號（內部 id 顯示為 display_label）、時間；**不含對話全文** | — | — |

### T-5 管理員教師查看紀錄有界投影（2026-11-05 §99）

- 正式 GET 路徑不變；可個別／組合提供 UUID `teacher_id`、`student_id`，省略表示不限制該條件。未知鍵、重複鍵、空 UUID、非法 UUID／游標均拒絕；不接受 caller 自報角色。每次先經可信 Auth `/auth/v1/user`，DB 以管理員 profile 列 `FOR SHARE` 等待並重驗當下 `role=admin,status=approved,deletion_state=none`，資格鎖保留至交易結束。合法與非法篩選的非管理員均 `403`，缺可信 session `401`；只有有效管理員取得輸入錯誤 `400`。
- strict 成功 DTO 為 `{ outcome: "found", items: [{ teacher_label, student_label, viewed_at }], next_cursor: string|null }`；標籤只取當下 `profiles.display_label`，時間為 DB 原事件時間、UTC ISO 8601（保留六位微秒）。不回帳號 UUID、audit row、aid、object_ref、school、email、Auth metadata、學生內容或完整對照。`next_cursor` 只包含分頁必需的版本、原篩選及事件時間／唯一鍵位置的 opaque base64url 編碼，**不是授權憑證或秘密**；每頁重新驗權。
- `limit` 預設 20、1–50；這是查詢工程界線，不是教師名額或正式配額。依 `at DESC,id DESC` 唯一穩定排序，以 `limit+1` 判斷下一頁；`after` 保留微秒與原 teacher／student 篩選，不接受改換篩選沿用舊游標。沒有下一頁時明確 `next_cursor=null`。不承諾跨請求固定 snapshot；每次 page 的映射完整性核對、篩選與投影在同一 statement snapshot。
- `0035_admin_teacher_view_audit.sql` 僅新增窄用途 NOLOGIN／NOBYPASSRLS reader、欄位級 grants、限定 `teacher_view` 的 RLS、固定 `search_path=pg_catalog` 及單一受限 RPC。一般 authenticated 沒有 audit／identity map 通用 SELECT 或 reader role membership；無寫入／匯出／通用身分工具，不使用 service_role。
- 歷史查詢不核對目前 binding／membership／學生資格，解除／重綁不移除既存查看事件，也不恢復教師權限或 Specification 舊批准。`0034` 資源 reader 與既有 Specification 詳情的 `teacher_view` 均可被核對；不合併／去重，不實作 PP-12。
- **隔離的政策缺口**：現行清除規則會刪除 identity map，尚未核定該歷史列的 T-5 顯示／篩選語意。本輪不創造匿名標籤、不回 email／內部 UUID、不新增永久識別、不以 INNER JOIN 漏列。若任何 `teacher_view` 缺映射／有效 display_label，本輪所有 T-5 查詢明確回既有 `503 dependency_unavailable`（UI 無結果並可重試），不偽裝空清單；同一 statement 防止檢查後映射消失造成漏列。正常有效映射流程已完成。後續最少決定僅為：對照清除後歷史列允許的顯示方式，以及這些列在 UUID 篩選下的納入語意；本輪不決定保存／匿名化政策。
- `/admin` → `/admin/audit/teacher-views` 採 server-rendered GET，UUID 明列為查詢條件而非結果姓名；可查詢、清除、重試、下一頁／第一頁及 reload。頁面與 API 不共用快取；敏感入口 `prefetch=false`，分頁／篩選採原生導航。失敗／失權不保留先前結果，無 client 非同步 controller。

### T-1／T-2 有界產品實作補充（§96）

- 正式路徑與 body 不變。T-1 首次建立回 `201`；T-2 首次解除回 `200`。兩者皆需 UUID `Idempotency-Key`，同管理員共用鍵空間；相同鍵及完整原意圖 replay 回 `200`＋`Idempotent-Replay: true`。不同 teacher／student、不同 binding ID、不同解除理由或不同操作種類回 `422 idempotency_key_reuse`。未知結果只能用原鍵／本文／對象重試，不自動換鍵。
- 成功 DTO 為 `{ outcome: "created"|"ended"|"replayed", operation: "create"|"end", binding_id, state: "active"|"ended", operated_at }`。此為**原操作 receipt**（DB 時間），不是目前關係或目前審查資格；目前狀態須另作可信讀取。原建立鍵於解除後重放仍只回原 receipt，不重新建立；明確重綁使用新鍵及新 ID。
- 每次請求均由可信 Auth `/auth/v1/user` 確認主體，再查 DB 當下管理員 role／approved／deletion_state。T-1 鎖定必要 profiles（UUID 排序）、學生學校、教師有效持久 membership、師生關係，再重驗。教師與學生必須分別為當下有效、已批准、未停用且未刪除的 teacher／student；學生學校須 approved 且 valid_until 未到期，教師須有該校 active membership，不接受自報 school 或角色。未核准資格不自動變更。
- T-1 同對師生最多一個 active；不同鍵競爭只有一筆成功，另一筆 `409 binding_exists`。建立不合資格分別為 `409 teacher_not_eligible`、`student_not_approved`、`school_not_eligible`、`teacher_school_mismatch`、自綁 `invalid_binding_pair`；只有有效管理員可取得此原因，非管理員 `403`、不回候選／目標資料。
- T-2 是指定 ID 的 active→ended，保存 ended_by_aid／ended_at／end_reason，不 DELETE、不把 ended 改回 active。不同新鍵解除已 ended 的指定 ID 回 `409 binding_ended`；不存在 `404`。此子集不引入關係版本欄位：鎖後 active 狀態是單向 CAS 前置，舊 ID 絕不指向重綁的新 ID。解除仍要求有效管理員，但不因目標後來停用、學校或 membership 失效而阻擋收權。
- 原因驗證沿 `specificationReasonSchema`／`specification_reason_valid` 的固定 Unicode 空白與 C0／C1 控制字元拒絕、合法 scalar／原文保存。2000 Unicode 字元是**工程輸入防護上限，不是正式產品配額**。不改 0030／0031。理由只在業務資料／原意圖 receipt 保存；audit meta 不含理由。
- 狹用途 writer、FORCE RLS、最小 grants、固定 search_path 與受限 EXECUTE；一般 actor 不能寫 binding／receipt／audit 或執行 internal helper。receipt、關係異動、去識別 audit 同交易，audit 失敗整筆回滾。新增 audit 僅 binding_created／binding_ended，object_type=binding、object_ref=關聯 ID、actor_aid／subject_aid、DB 時間；meta 僅 `{from_state,to_state,teacher_aid}`。非管理員 HTTP 拒絕沿共用白名單 diagnostic（request_id／route／status／duration／error_code），不記本文或身分輸入。
- 最小候選與關係讀取用 `GET /api/v1/admin/bindings?kind=teachers|students|bindings&after?`；students 必須另提供 teacher_id、school_id。每頁固定最多 20 筆、next_cursor 為最後一筆 UUID，teachers 按 membership ID，其餘按 account／binding ID；穩定 keyset，不宣稱跨請求 snapshot。只回候選顯示標籤、必要 ID、角色／qualified、學校標籤與 ID，關係另回 teacher／student 最小標籤及 state；不回 email／handle／Auth／聯絡資訊。歷史關係清單保留 ended，供明確核對指定關聯；不是 T-3／T-4 完整名冊。
- 管理入口 `/admin`→`/admin/bindings`，先選教師學校歸屬、同校學生、核對並明確確認；解除需理由、影響說明與可取消確認。SSR／hydration 前停用；未知操作以 sessionStorage 綁可信工作階段 scope、保存原意圖，reload 只提供原鍵重試。失權隱藏資料，晚到本文不得清除未決紀錄；storage 寫入失敗不送出。
- 解除交易提交前教師可能仍可審；提交後新請求不能取得該關係的審查授權。鎖序與既有 Specification 決策一致，關係 epoch 自動遞增；舊批准永久失效，重綁新 ID 後須學生重新提交及教師重新明確審查。已送達內容不承諾收回，也不證明所有在途請求撤銷上界。
- 學生最小 A-4 `teacher_notice` 只投影目前有效 binding／教師／學生學校／持久 membership。產品資料請求回應後重新可信讀取 A-4，畫面不需手動 reload；事件僅要求重讀、不作授權證據。無 Realtime、郵件、通知保存或已讀追蹤；提示不等於完整資源權限或審查批准。
- **§97 數量與交易鎖補充**：A-4 完整投影所有當下有效教師標籤，不設 100 筆名額或靜默截斷；解除 RPC 在讀取指定 binding 前先取得該 ID 的交易 advisory lock，建立亦先鎖其新 ID，再依既有師生 pair 鎖序序列化，讓已取得新 ID 的重疊解除等待建立交易提交後再判斷。

### T-3／T-4 教師唯讀資源有界產品子集（2026-11-04 §98）

- 本輪只接通正常有效關係：教師／學生目前均為已批准、未停用且未刪除；binding active；教師對學生學校有 active 持久 membership；學生學校 approved 且 `valid_until` 未到期。每次讀取均由可信 Auth `/auth/v1/user` 確認主體，再於同一 DB 交易鎖定關係、重驗資格、讀取白名單資料並寫稽核；不改 `teacher_can_view_student` 的全平台語意。
- `GET /api/v1/teacher/students`、`GET /api/v1/teacher/students/{id}/projects`、教師專用專案詳情、逐階段草稿及分頁任務讀取，僅回最小 strict DTO。學生／專案以 UUID 穩定排序及 `after` 游標分頁，每頁 1–50；不靜默截斷、不宣稱跨請求 snapshot。九階段摘要不推導完成；詳細草稿分階段讀取；學生確認不是教師批准。
- 每次專案清單資源、專案詳情、階段草稿或任務開啟，在同一交易寫 `teacher_view`，`object_type='project'`、`object_ref=project_id`、actor／subject 為既有去識別代號、`meta={}`。不包含內容，也不實作 PP-12 合併窗口；稽核失敗整筆讀取回滾。教師敏感頁面連結停用 Next prefetch。
- 任一不符資格、錯角色、非本人有效綁定、跨學生 project ID 或關係解除後的新請求皆以 404 隱匿；資格／依賴故障不回空清單冒充無資料。新 reader 僅公開必要 RPC 給 `authenticated`，reader role 為 NOLOGIN／NOBYPASSRLS，不授予一般跨學生 SELECT 或 DML。
- 此為 T071–T075 的本輪有界子集，不改整項勾選、依賴或 Gate：停用當下綁定快照與 frozen／`view_frozen`、完整對話、附件／檔案下載、活動總表、教師回饋、T-5 管理稽核查詢、Realtime、其他階段批准，以及完整帳號生命週期仍未實作。學校 withdrawn／expired 等本輪未涵蓋狀態仍拒絕；不藉本輪改寫既有政策。細節及驗證記錄見 [readiness §98](../readiness-review.md#98-2026-11-04-t071t075-教師唯讀資源有界子集)。

## 4. 帳號生命週期（僅管理員）

| # | 端點 | 授權 | 輸入 | 回應／行為 | 錯誤 | 冪等／稽核 |
| --- | --- | --- | --- | --- | --- | --- |
| C-1 | `POST /api/v1/admin/accounts/{id}/disable` | 管理員 | `{ reason_code }` | `200`；交易內：`status=disabled`；**建立 `account_disable_events`＋`disable_binding_snapshots`**；`auth.admin` `ban`＋撤銷 refresh（**撤銷方式待 S-03 驗證**：官方 Admin signOut 需使用者有效 JWT；資料層以 `account_gate` 即時拒絕為準）；待審申請→`suspended`；取消該帳號進行中工作；其公開作品 `stopped(account_disabled)`；回應含「影響摘要」 | `409` | `Idempotency-Key`；稽核 |
| C-2 | `POST /api/v1/admin/accounts/{id}/restore/preview` | 管理員 | — | `200`＋`{ confirmation_id, impact: { data_retained: true, bindings_will_not_restore: n, public_works_will_not_restore: n, requires_review_to_republish: true } }` | `409`（非停用） | 寫 `destructive_confirmations.step1` |
| C-3 | `POST /api/v1/admin/accounts/{id}/restore` | 管理員 | `{ confirmation_id }`（須對應 C-2 且未逾時；**一次明確確認**） | `200`；`status=approved`；**結束 `account_disable_events`**；既有 `active` 綁定→`ended(restore_requires_rebind)`；解除 `ban`；**不恢復綁定與公開作品**；學生需有新的登入碼（若舊碼被停用流程撤銷，則重發） | `409`；`422 confirmation_missing` | `Idempotency-Key`；稽核（操作者、時間） |
| C-4 | `POST /api/v1/admin/accounts/{id}/delete/preview` | 管理員 | — | `200`＋`{ confirmation_id, impact_hash, impact: { access_stops_now, public_works_taken_down: n, pending_requests_invalidated: n, approved_undeployed_invalidated: n, data_scheduled_for_purge: true } }`（**不寫天數**，天數待核定 D-10） | — | `destructive_confirmations.step1` |
| C-5 | `POST /api/v1/admin/accounts/{id}/delete` | 管理員 | `{ confirmation_id, impact_hash }`（**二次確認**；`impact_hash` 須與當下重算相同，否則 `409 impact_changed` 重新確認） | `202`＋`Location: /api/v1/jobs/{purge_job_id}`；交易內：`deletion_state=marked`（立即不可存取）、公開作品 `stopped(account_deleted)`、申請 `invalidated`、取消工作；排入 `purge_jobs` | `422 second_confirmation_required`；`409` | `Idempotency-Key`；稽核 |
| C-6 | `GET /api/v1/admin/purge-jobs/{id}` | 管理員 | — | `state`、各步驟 `pending｜done｜failed`、`attempts`；**失敗時帳號仍不可存取** | — | — |
| C-7 | `POST /api/v1/admin/purge-jobs/{id}/retry` | 管理員 | — | `202` | `409`（非 failed） | 冪等；稽核 |
| C-8 | `GET /api/v1/admin/accounts/disabled` | 管理員 | — | 停用帳號清單與停用時間（供定期檢視，D-09）；**畫面不得顯示「N 天後自動刪除」** | — | — |

**不變式**：（1）無任何排程以天數自動刪除帳號（測試：掃描排程表只可能有「已標記刪除」的清除工作與保存期限清理工作）；（2）`mark_delete` 未完成二次確認不得執行；（3）清除失敗不恢復存取；（4）清除完成後 `audit_identity_map` 對照 0 筆殘留；（5）還原資料庫後須先重新套用 tombstone 再開放登入（data-model §9.4）。

## 5. 複查申請（帳號複查、作品複查；與個資請求分開）

| # | 端點 | 授權（逐次重驗；不授予任何學生資料） | 輸入 | 回應 | 錯誤 |
| --- | --- | --- | --- | --- | --- |
| V-1 | `POST /api/v1/review-requests` | 依 `kind` 與 data-model §2.3：被拒絕申請者本人／發起教師；**停用當時已綁定教師**（且對象仍 `disabled`）；有效學生（作品複查，對象為自己的作品版本且有退回／下架處置） | `{ kind, disposition_id, target_account_id? ｜ target_version_id?, reason (≤PP-13) }` | `201`＋`{ id, status:"open" }` | `403`（無資格；**不洩漏對象是否存在**）；`409 open_request_exists`（同處置已有未結申請）；`422`（過長）；`429`；〔D-05：學校撤回／失效造成的停止公開 → `422 not_reviewable`（預設）〕；〔D-09：標記刪除後 → 預設 `403`〕 |
| V-2 | `GET /api/v1/review-requests/mine` | 申請人 | — | 自己的申請列表：`status`、`reply`、時間；**僅這些欄位** | — |
| V-3 | `GET /api/v1/admin/review-requests?kind=account_review` | 管理員（帳號複查）；原審查權限的教師／管理員（作品複查，教師須對該版本審查範圍有權） | 篩選 | 申請列表 | `403` |
| V-4 | `POST /api/v1/admin/review-requests/{id}/reply` | 同 V-3 | `{ reply (≤長度) }` | `200`；`status=replied`；**不自動恢復任何權限或公開**（恢復須另走批准／審查／部署並留稽核） | `409` |

**受限寫入保證**：寫入只能經 `app.submit_review_request()`；RLS 禁止直接 `INSERT`；被拒絕／停用帳號無其他受保護能力（`account_gate` 全拒），唯有此入口與 `GET …/mine` 的白名單檢視。

## 6. 個資查閱／更正／刪除請求（與複查完全分開）

| # | 端點 | 授權 | 輸入 | 回應 | 備註 |
| --- | --- | --- | --- | --- | --- |
| P-1 | `POST /api/v1/admin/privacy-requests` | 管理員（代記錄經學校管道、經已綁定教師、無法登入者提出的請求） | `{ request_type, channel, requester_kind, subject_account_id?, requester_check, authority_check }`（`channel=bound_teacher` 時伺服器核對**有效綁定**；若學生已停用，**預設拒絕經凍結教師代提**〔D-15〕，改走學校管道） | `201` | **不觸發任何刪除** |
| P-2 | `POST /api/v1/privacy-requests/mine` | 教師（經管理中心提出自己的請求） | `{ request_type }` | `201` | 教師僅能 `GET …/mine` 自己的狀態與回覆；**不因此取得管理中心其他權限** |
| P-3 | `PATCH /api/v1/admin/privacy-requests/{id}` | 管理員 | `{ school_confirmed_action, reply, state }` | `200`；每步稽核 | 處理方式為刪除帳號時，由管理員另行發起 C-4／C-5（含二次確認）；帳號以外資料項目〔D-15〕 |
| P-4 | `GET /api/v1/admin/privacy-requests` | 管理員 | — | 列表（對象以內部代號顯示）；**不顯示不必要的個人資料** | 處理與保存期限待核定 |

**學生經學校既有管道提出**：不是平台端點（由學校轉交管理員，管理員以 P-1 記錄）。畫面明示「提出請求不會自動刪除資料」。
