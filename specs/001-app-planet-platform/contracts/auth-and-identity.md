# 契約：登入、登入碼與工作階段

**對應**：FR-035、038、045、046、051｜**研究**：[../research.md](../research.md) R-01｜**資料模型**：[../data-model.md](../data-model.md) §1.3、1.5、2.1｜通則見 [README.md](./README.md)

> **2026-10-26 現行契約修訂〔四原則已批准／已同步〕**：依 [D-32](../decision-register.md#d-32-a-9-已批准契約原則與必要正式文件同步2026-10-26台灣)／[readiness §72](../readiness-review.md#72-2026-10-26-a-9-已批准契約原則的正式文件同步一次性文件授權先登錄)，撤除跨 Auth／平台 DB 強回滾，維持不存可還原碼、同鍵非秘密 receipt、最多一次秘密輸出機會、unknown 受控暫停及啟用阻擋。這不是 M3／M2 或 hold／journal／dispatcher 採用與實作批准；最終狀態／API／HTTP／錯誤碼映射待設計，流程尚未實作、不可啟用。下方較早「規則不變」僅指其當時首版範圍同步，不否定本次修訂。

> **D-07a 狀態：已選首選驗證方案（方案 A），附實測條件**（教育者 2026-10-21；**不是已驗證可上線**）。本契約 A-1、A-8、A-9 與下方不變式皆以方案 A 為設計前提：學生輸入的帳號由伺服器端對應至**不代表真實學生電郵的合成電郵**後代為登入，並做帳號×網路來源節流；學生畫面仍只有帳號與登入碼。**S-01～S-03（[quickstart.md](../quickstart.md) §1.1）全部〔尚未執行〕**；通過前，登入碼長度／效期／限速數值（D-07b～e，T1）一律不核定。若驗證失敗，改採方案 B／C 須由教育者重新決定，本契約屆時改版；**不自行更換 Auth 供應商**。

> **同步註記（2026-10-21 首版範圍決定）**：本契約的登入、登入碼與工作階段規則**不變**。首版學生作品僅 A／B 級且無作品執行時 AI；學校核准撤回／失效（§3 `ai_not_open`、`public_deploy_paused`）時，該校**全部公開作品**一併停止公開（見 [access-and-lifecycle.md](./access-and-lifecycle.md) §2）；學生登入、已保存內容與非 AI 功能的規則不受影響。`ai_off_duty` 值守閘門僅適用學生平台 AI；公開 C 級訪客 AI 相關閘門不適用於首版。上線關卡（學校同意／告知證據、供應商條件等）仍未取得。本契約為設計層級，尚未實作、未驗證。

## 1. 端點

| # | 方法與路徑 | 能力／授權 | 輸入 | 成功回應 | 錯誤 | 冪等／限流 | 狀態查詢 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| A-1 | `POST /api/v1/auth/student/login` | 無（未登入）；伺服器端：查 `profiles.handle`→合成電郵→`signInWithPassword` | `{ handle, login_code }`（`login_code` 去除空白、連字號、轉大寫後驗證；長度上限檢查） | `200`＋session cookie；`{ account_status: "approved", landing: "home" }` | 憑證未通過（含未知帳號）→ `401 invalid_credentials`（**同一訊息、同樣耗時**）；憑證通過但學校 `unconfirmed`→ `403 school_not_confirmed`（**不建立 session**；`user_message_zh` 例：「學校尚未完成啟用，暫時無法使用 App Planet，請洽學校」，措辭待審閱）；帳號 `disabled`／標記刪除→ `403 account_unavailable`（不細分原因）；節流中→ `429 login_throttled` | 限流鍵：帳號雜湊×IP 雜湊、IP 雜湊（PP-03，待核定）；不需冪等鍵；**日誌不得含 `login_code`** | 無 |
| A-2 | `POST /api/v1/auth/staff/login` | 無 | `{ email, password }` | `200`＋cookie；回傳 `account_status` 以決定導向（待審核／已拒絕／已批准／已停用的專屬畫面） | `401 invalid_credentials`；`429` | 限流同上（IP×帳號雜湊）；Supabase 另有 IP 限速 | 無 |
| A-3 | `POST /api/v1/auth/logout` | 已登入 | 無 | `204`；撤銷目前 refresh token | — | 冪等 | 無 |
| A-4 | `GET /api/v1/me` | 已登入（含待審核、已拒絕、已停用者可呼叫，但回傳僅限狀態） | 無 | `{ role, account_status, school_gate: { state, ai_available, public_deploy_available, reason_code? }, teacher_notice?: { teachers: [{display_label}], scope: ["已保存的專案需求、階段草稿、學生確認狀態與任務"] } }` | `401` | — | 即時 |
| A-5 | `POST /api/v1/admin/students` | 管理員或教師（發起核發）；教師僅能為自己發起（教師另受 §3a 條件限制） | `{ handle, display_label?, school_id, note? }`（**不得含真實姓名、電郵、電話欄位**；伺服器對 handle 與備註做真名／聯絡資料樣式檢查並提示，無法保證，故仍須管理員審核） | `201`＋`{ student_id, account_status: "pending" }`（此時**尚無登入碼**） | `409 handle_taken`；`422`；`403` | `Idempotency-Key`；教師每日發起上限（工程值） | `GET /api/v1/admin/students/{id}` |
| A-6 | `POST /api/v1/admin/students/{id}/approve` | **管理員** | `{}` | `200`＋`{ credential: { state: "pending_reveal", reveal_expires_at } }`；批准後產生登入碼，依 A-8 的最多一次秘密輸出機會處理（不保證送達；不改核發流程） | `409`（非 `pending`）；`403` | `Idempotency-Key`；稽核 | — |
| A-7 | `POST /api/v1/admin/students/{id}/reject` | **管理員** | `{ reason_code, note_for_user? }` | `200` | — | 同上 | — |
| A-8 | `POST /api/v1/admin/students/{id}/credential/reveal` | 管理員，或**發起核發的教師**（僅限首次領取期限內；教師另受 §3a 條件限制） | `{}` | `200`＋`{ login_code }`（**最多一次伺服器秘密輸出機會，可能零次交付**；`Cache-Control: no-store`；之後回 `410 already_revealed`）；`state`→`active` | `410`；`403`；`409`（尚未批准）；不新增回應映射 | `Idempotency-Key`：同鍵同內容仍當下重驗資格，只回最小非秘密 receipt／狀態，不再顯示明文；「已顯示」不作送達證明；稽核不含明文。只同步秘密重播原則，不改核發流程／領碼權 | — |
| A-9 | `POST /api/v1/students/{id}/credential/reissue` | **已綁定教師**（`teacher_can_view_student` 的綁定部分）或**管理員**；未綁定教師 → `403`（不洩漏學生存在）；教師另受 §3a 的 R-a 限制；須合法核對身分 | `{ identity_check: "verified_in_person" ｜ …固定碼 }` | 保留成功回應草案 `200`＋`{ login_code }`，僅在 Auth 套用已確認、相依在途可信終結、舊 session 資料阻擋及平台完成提交有證據時成立；成功新碼生效、舊碼**立即失效**。之後才有最多一次秘密輸出機會，可能零次交付；不保證人已持碼 | 保留既有 `403`／學生非 `approved` 的 `409`；未送出／可靠確認未套用、已套用後平台失敗、unknown 分支見 §2。舊 `502 reissue_failed` 不足以表達所有分支，**最終 HTTP／錯誤碼映射尚待設計**，不一律套用、不新增碼 | `Idempotency-Key`；同鍵同內容當下重驗資格，只回最小非秘密 receipt／狀態，不重播碼、不再次執行 Auth；異內容依 COMMON 拒絕；新鍵不得繞過同目標未結操作；限流（每學生每小時 N 次，工程值）與稽核保留 | 僅合法授權者的最小非秘密狀態／恢復需求；路徑及映射待設計，receipt 不授權 |
| A-10 | `POST /api/v1/review-requests` 與 `GET /api/v1/review-requests/mine` | 受限入口：被拒絕者、發起教師、停用當時已綁定教師（詳見 [access-and-lifecycle.md](./access-and-lifecycle.md) §5） | — | — | — | — | — |

> **§90 實作投影註記（隔離本機子集，不改上表語意）**：教職員無學校歸屬時，A-4 以 `school_gate: null` 表示不適用，不填造學校狀態，也不輸出 `teacher_notice`；`pending`／`rejected`／`disabled` 的 A-4 只回 `{ role, account_status, school_gate: null }`，標記刪除則拒絕。A-2 對 `disabled`、標記刪除與缺 profile 回 `403 account_unavailable`，不發 cookie（依 §3a(1) 維持拒絕），由登入頁顯示專屬停用畫面；學生經 A-2 回 `401 invalid_credentials`。節流與 TTL 為 [readiness-review.md](../readiness-review.md) §90 的隔離測試值，非 PP 核定。
> **§96 關係提示補充**：A-4 的學生 teacher_notice 重驗當下有效師生綁定、教師／學生帳號、學生學校核准／有效期限及持久教師學校歸屬。學生產品請求回應後，畫面另行可信讀取 A-4 更新最小提示，不需手動重新載入；只描述該次讀到的關係，不宣稱即時推播、完整資源查看已開放或階段已批准。空關係明確顯示沒有符合資格教師；讀取失敗隱藏先前提示。詳見 [T-1／T-2 補充](./access-and-lifecycle.md#t-1t-2-有界產品實作補充96)。
> **§97 關係數量補充**：`teacher_notice.teachers` 是符合當下資格的完整標籤投影，不設教師數量名額、不截斷；回應仍只含本人最小 DTO 與教師顯示標籤，不含關係 ID 或他人帳號識別。產品提示標示本次完整投影筆數。

> **§98 教師唯讀範圍補充**：本輪提示只描述產品已接通的已保存正式需求、九階段草稿／學生確認狀態及任務；不代表完整對話、附件／檔案、學習活動或教師回饋功能已開放，也不代表任何階段已批准。權限仍由每次資源請求的可信 Auth 與資料庫關係重新判定，提示不是授權依據。

## 2. 登入流程不變式（需有自動化測試）

1. **不洩漏帳號是否存在**：未知 `handle`、錯誤碼、已被取代的舊碼、（停用或標記刪除帳號的）錯誤碼，回應本文、狀態碼、標頭、耗時分佈需不可區分（未知帳號仍執行等價的雜湊與 Auth 呼叫耗時）；**節流本身也不得洩漏**：節流桶以 `HMAC(handle)` 為鍵，不論帳號是否存在，相同嘗試次數下同時進入 `429`（S-02）。
2. **學校閘門順序**：先驗證憑證，**通過後**才檢查 `account_gate('login')`；`unconfirmed` → 不建立 session。`withdrawn`／`expired` → 可登入（FR-046(2)）。
3. **登入碼不留存**：登入碼不寫入日誌、稽核、通知、錯誤追蹤、URL、瀏覽器儲存；回應含登入碼的端點一律 `no-store`；前端不得把登入碼放進 URL 或 `localStorage`。
4. **重發原子性與分階段恢復（D-32(1)(3)）**：原子性僅限平台 DB 內可共同提交的版本、稽核及非秘密操作狀態，不包含外部 Auth transaction。未送出或可靠確認未套用：本操作未改外部憑證，可依證據終止／清理；不保證獨立操作未改舊碼，解除暫停仍須第 5 項證據。已確認套用：只向前恢復平台完成狀態，不重送 Auth、不承諾回滾外部密碼。unknown（含送出／回應遺失而不能判定是否套用）：不回成功、不保證舊碼可用、不盲重送。可信終結須為可審閱的原操作結果，或不再可能寫入的可靠證據；timeout、租約到期、DB generation 或人工按鈕單獨均不足。缺證持續暫停，unknown 可能長期不能安全收斂。**成功後舊碼登入必須 100% 失敗**，與舊 session 資料阻擋分開驗；逐階段驗收見 [S-01-5／V-10](../quickstart.md#s-01-5-staged)，全部〔尚未執行〕。
5. **停用／刪除／重發後的舊 session 與暫停（D-32(3)(4)）**：停用或標記刪除：`account_gate` 立即拒絕；同時 `ban`；access token 殘存期間**所有資料存取仍被 RLS 拒絕**（S-03，舊 JWT 的受保護端點及直接資料查詢須被拒）。重發暫停不是 `disabled`，不改帳號／學校狀態或師生關係；account／school／ownership gate 獨立保留。未完成流程須有受控暫停設計，unknown 時至少暫停以目標學生身分執行的受保護資料操作、新產品登入及平台 refresh，即使原生 Auth 核發 token 亦不授產品資料權。最小非秘密狀態／恢復入口只供當下合法授權者。解除前須同時有**相依在途操作已可信終結、舊 session 資料阻擋、平台完成狀態**的證據，不能只因改碼成功、DB generation 或等待時間放行。教師獨立合法檢視、公開作品、跨角色／委派與背景細節未核定，啟用前須補全路徑設計；不自行擴權或關閉其他角色。M2／M3 仍是候選，撤銷方式與完整有效性待 S-03／另批驗收；若無法阻擋或有殘留須回報教育者，不隱含接受、不得據此解除本次暫停。沒有可恢復性證據、具名主責／備援與支援安排、完整設計及正式驗收，不可啟用；不承諾自動恢復或未核定服務時限。
6. **學生端不含**電郵、電話、自設密碼欄位；API 不接受這些欄位（未知欄位 → `422`）；合成電郵不得出現在任何回應、畫面、日誌或稽核。

**秘密輸出與恢復（D-32(2)）**：一次顯示不是恰好一次送達；輸出門閂須先於秘密輸出消耗，crash／回應遺失可能零次交付。只留最小非秘密狀態，不將碼存入一般冪等結果快取；receipt 不是授權或人已看見的證據。記憶體秘密遺失後不能恢復原碼，只能在取得原操作可信終結／不再可能寫入證據並符合核准恢復條件後，重新核身、當下重驗授權及啟動新操作；不得用新鍵繞未結操作。這是設計要求，不指定門閂 schema、journal 表、dispatcher 或新端點。

## 3. 學校閘門回應碼（供全站共用）

| `code` | 情境 | 學生端文字（措辭待審閱） |
| --- | --- | --- |
| `school_not_confirmed` | 學校未確認／無紀錄（學生登入或任何受保護呼叫） | 學校尚未完成啟用，暫時無法使用（不進入任何功能） |
| `ai_off_duty` | 學生 `ai_call` 時 App 值守閘門關閉（非值守時段、值守設定未核定、名冊無主責／備援；**後續決定 2026-10-21**） | AI 目前不在開放時段（登入、已保存內容與非 AI 功能仍可使用；不宣稱有人在線）〔措辭待審閱〕 |
| `ai_not_open` | 學校 `withdrawn`／`expired`，AI 呼叫被擋 | AI 功能尚未開放（已保存內容仍可查看與編輯） |
| `public_deploy_paused` | 學校 `withdrawn`／`expired`，新公開部署暫停 | 新的公開部署暫停中 |
| `account_disabled` | 帳號停用（僅在已知帳號且憑證通過後才可能顯示給本人；受限入口除外） | 帳號目前無法使用 |

## 3a. 教師在學校「未確認」時的受限帳號準備範圍（D-06 (a)；2026-10-23 教育者批准）

> 本節只規範**教師**；學生規則（§2、§3）與管理員既有範圍不變，不擴充成完整管理員能力矩陣。純函式（`packages/core/policy/teacher-account-prep.ts`）只組合已由資料層查得並傳入的合成事實，**不證明**真實歸屬、發起者、綁定、身分核對或期限；這些必須由資料層與端點強制（尚未建立）。

1. **登入（A-2）**：有效教師可登入，**不依賴學校查詢**。帳號／身分查詢失敗一律拒絕；`disabled`、標記刪除維持拒絕；`pending`／`rejected` 維持既有受限狀態入口，不取得正常角色首頁。
2. **學校事實分開表達**：「未歸屬任何學校」「學校 `unconfirmed`」「學校查詢失敗」與「`schoolApproval: null`」是四件不同的事。`null` 不證明任何歸屬或核准；學校查詢失敗不得被填成 `null` 或 `unconfirmed` 後放行需要學校資料的能力。
3. **受限首頁（A-4）**：只呈現帳號狀態、可取得的學校狀態、自己的申請狀態與符合條件的帳號準備入口；**不含**學生專案、對話、檔案、活動等學習資料。學校資料讀取失敗時明示不可取得，不顯示虛構預設值。`canAccessRoleHome` 為 `true` 只代表殼層可進入，不代表可讀學生資料。
4. **查看自己申請**：僅 `initiated_by` 為自己的核發申請；僅回傳最小狀態欄位（`student_id`、`display_label`、`account_status`、`credential_state`、`reveal_expires_at`）；不含登入碼、他人（含其他教師、管理員）發起的申請或任何學習資料；無權限查詢回 **`404`**。`handle` 與 `note_for_user` **尚未選定，不加入回傳欄位**，保留待決。
5. **發起核發（A-5）**：教師 `approved`、未標記刪除；目標 `school_id` 在教師**有效歸屬集合**內（M1，見 [data-model §1.3a](../data-model.md)）；目標學校讀取成功且為 `unconfirmed` 或 `approved`；`withdrawn`／`expired` 暫不開放。`initiated_by` 由伺服器依 session 身分寫入，**不得由請求本文帶入**（未知欄位 `422 unknown_field`）。管理員批准、限流、冪等鍵與 A-5 其他條件不豁免。
6. **首次領取登入碼（A-8）**：保留 A-8 全部條件；領取當下仍須目標學校在教師有效歸屬內且所需資料成功取得；學校 `unconfirmed` 不單獨阻擋帳號準備。期限屆滿一律拒絕，**不自動延長、不重新顯示**；管理員過期補發流程另定。不擴大學校 `withdrawn`／`expired` 時尚未明定的領碼行為。
7. **教師重發（A-9，R-a）**：學生所屬學校 `unconfirmed` 時**拒絕教師重發**；其餘有效綁定（只是發起者而無綁定不足）、身分核對、原子性與舊 session 條件依 A-9。管理員依既有規則，不與教師一起阻擋。
8. **不因帳號準備而開放**：`unconfirmed` 學校的學生學習資料、AI、審查與部署。

## 4. 首位管理員 bootstrap（非公開端點）
- 不提供任何 HTTP 端點；以一次性、受保護環境執行的程序（輸入：指定帳號的內部 id；不含任何密鑰值）將 `role='admin'`、`status='approved'` 寫入，並寫稽核。重複執行不得新增第二位（需現任管理員經 UI 核定）。
- 任何公開註冊路徑（教師／管理員自行註冊）建立的帳號 `role` 只能是 `pending` 的申請角色，**不等於權限**；`role='admin'` 的設定僅限管理員 RPC。

### 本輪 T018 既有待審教師子集（readiness §91；不新增 A 編號）

- `GET /api/v1/admin/teachers?after={uuid}`：只供當下 approved、`deletion_state=none` 的 admin；strict query（僅可省略或單一 after UUID）。回 `200 {items:[{id,display_label,status:"pending",row_version}],next_cursor:uuid|null}`；依 id 升冪，每頁最多 50 列，以第 51 列判斷是否有下一頁，不宣稱跨頁 snapshot。無 email、school、Auth 全使用者或學生資料。每列版本以強 ETag `"n"` 供該列審核使用，不以整頁版本替代列版本。
- `POST /api/v1/admin/teachers/{id}/review`：同一可信 session／DB 當下 admin 授權、同來源；strict `{decision:"approved"|"rejected"}`，無自由文字拒絕原因，無 actor／role／school 欄位。UUID `Idempotency-Key`、單一 strong `If-Match: "n"` 必填，禁止 If-None-Match。只轉移未刪除 pending teacher；不操作自己、student／admin、不改角色／歸屬／憑證。
- 成功 `200 {id,status:"approved"|"rejected",row_version}`＋新 `ETag`；同鍵原意圖重送 `200`、`Idempotent-Replay:true`、原結果／ETag。指紋等同性為可信 actor＋固定本路徑／POST 操作＋target＋decision＋原版本；DB receipt、版本遞增、狀態、audit 同交易。重放先當下重驗 admin；已成功不因目標現況改報衝突。無永久 exactly-once 承諾；隔離 receipt TTL=86400 秒，由受保護隔離設定提供，非正式 PP；到期再試仍須 pending／原版本，不會再次轉移已審核帳號。
- 錯誤：401 `unauthenticated`；403 `forbidden`（含跨來源與失權）；400 `invalid_request`／COMMON 缺鍵或版本碼；422 `unknown_field`／`idempotency_key_reuse`；404 `not_found`（不合法目標）；409 `teacher_review_conflict`（非 pending 或版本已變）；503 `dependency_unavailable`（讀取／未啟用依賴）、`operation_outcome_unknown`（交易／提交／回應未確認）。所有回應 no-store；錯誤 problem+json、既有安全標頭。UI 未知結果／401／403 保留本頁原鍵與意圖，只可原鍵重試，不自動改決策或換鍵；關頁前須核對，非持久恢復政策。
- `0027` 提供窄用途 RPC，writer 為 NOLOGIN／NOBYPASSRLS、固定 search_path、明列 EXECUTE。審核先以 actor＋key、target 的交易 advisory locks 序列化，再依 UUID 順序鎖 actor／target；等鎖後重驗。actor 的 share lock 保留至提交，target 再排他鎖；不宣稱終結所有跨服務在途操作。
- bootstrap 僅受保護非 HTTP CLI，唯一操作輸入為既有 pending teacher UUID；須本機隔離模式、loopback 專用連線、同一隔離 UUID 的 DB guard。DB `app_bootstrap_executor` 與 web runtime 無成員關係；一般 authenticated／anon／service_role 無 EXECUTE。全域交易鎖＋永久 singleton 完成紀錄，先驗舊紀錄與任何既有 admin，拒絕學生／不合法／缺資料；同目標只回已完成，不重寫 audit。首位 admin 停用／刪除不重開；沒有補造舊環境原始證據或第二管理員後門。
- 稽核沿用 `audit_identity_map`／`audit_events`，固定 `first_admin_bootstrap`／`teacher_approved`／`teacher_rejected`，只記 aid、DB 時間及白名單 `from_status,to_status,row_version,operation_id`；不記 display_label、原帳號 UUID、email、IP、本文或任何秘密。批准不代表學校核准、綁定或 AI 開放。

### 本輪 T017 教師註冊申請＋電郵驗證子集（readiness §92；D-20／PD-07 教師申請部分；不新增 A 編號）

- **啟用**：僅 `APP_PLANET_ENV`＝`APP_PLANET_TEACHER_SIGNUP_MODE`＝`isolated-local-test`，並沿用 §90 的 loopback／可信來源 proxy／HMAC 設定；缺任一即 503 `dependency_unavailable`。所有端點 no-store、同來源、拒絕 query string，錯誤為 problem+json。
- `POST /api/v1/auth/teacher-signup`：UUID `Idempotency-Key` 必填；strict 本文只容 `{email,password,display_name,school_note}`（≤4096 bytes），其他鍵（含 role／status／user_id／school_id／email_confirmed）回 422 `unknown_field`。email ≤254；密碼 ≥8 字元、≤72 UTF-8 bytes、不 trim／不轉換；顯示名稱 NFC＋trim 後 1～40 字、說明 1～200 字，拒絕控制／雙向／零寬字元（DB 同一檢查）。這些是工程防護值，非正式保存／配額政策。
  - 新申請、同鍵重送、既有帳號、同 email 在途／unknown 一律 `202 {status:"submitted"}`，HTTP 狀態／本文／標頭相同（每請求 request_id 除外），不揭露帳號存在、UUID、角色或派送狀態。202 僅中性接受，不確認帳號建立、寄信、送達或驗證。既有與未結申請不再次 signup，也不自動重寄；重寄僅走明確 resend 入口。不宣稱耗時分佈不可區分。
  - 同鍵異內容仍回 422 `idempotency_key_reuse`；DB 無法確認回 503 `signup_outcome_unknown`，不得視為未派送；過期／衝突／unknown 的 UI 保留原鍵及非秘密意圖，不因改欄位換鍵。輸入檢查在派送前拒絕；上游拒絕不再形成 email 存在性回應差異。限流在查存在性前一致計數，429 `signup_throttled`＋`Retry-After`。不新增恢復查詢端點，沒有 email 查詢或帳號投影；reload／新分頁不解除 server 的同目標未結限制。
- `POST /api/v1/auth/teacher-signup/resend`：strict `{email}`；一律中性 202，不揭露帳號；限流同上。不是一般郵件平台或密碼重設。
- `GET /auth/confirm`：驗證信唯一目的地（固定 Auth site_url，caller 不可指定 redirect）。只接受 `type=signup` 與格式正確的 token hash；放入 `__Host-app-planet-signup-verify`（HttpOnly、Secure、SameSite=Strict、Path=/、Max-Age 600）後 303 到 `/signup/verify`，不在落點消耗（防郵件掃描器預開）。無效值清除 cookie。
- `POST /api/v1/auth/teacher-signup/verify`：只接受受信任 Auth `/verify` 的合法 200 JSON（正確 MIME／UTF-8、≤64 KiB、完整 session 欄位及 access token 格式、user UUID／email／權威 `email_confirmed_at`）；不解碼 JWT、不採 metadata。非法 200 或回應遺失→503 `verification_outcome_unknown`，保留恢復 cookie、不宣告成功。可解析 token 即嘗試 local scope 撤銷；合法驗證且撤銷可確認→`200 {status:"verified"}`，撤銷不可確認→`200 {status:"verified",session_cleanup:"unknown"}` 並提示限制；兩者清驗證 cookie，但均不設登入 cookie、不交出 token、不自動登入／批准。無 cookie／無效／過期／已使用 400 `verification_link_invalid`（清 cookie）；限流 429。上游可能已完成驗證但回應遺失，再按不保證恢復，須引導嘗試登入。`DELETE` 只取消本頁確認並清 cookie，不證明上游未驗證。秘密不入本文、殘留 URL、日誌或稽核。
- **持久派送（0029 升級）**：尚無意圖表示尚未取得資格；`register_teacher_signup_intent` 在受限交易以 operation／email advisory lock 原子登記 `dispatch_unknown`，只有該次 COMMIT 後的 `created` 回應取得唯一派送資格。同鍵並行只回看原列；異鍵被同 email 未結列阻擋。已核對既有 Auth 而未送出者記 `not_applied`；`completed` 僅由 Auth INSERT 同交易建立 profile／申請後寫入。Auth HTTP 200／429 不作完成證據。0028 所有未消耗列（含過期）升級為 unknown；不清除、以時間解鎖或重新派送。可能零次派送而永久安全停止；不保存密碼或秘密佇列，保存政策仍待核定。
- **身分與資料**：伺服器只用受限 `app_signup_intake` RPC 及公開 anon key。Auth INSERT 觸發器核對隨機選擇子、email 雜湊、尚未消耗的 `dispatch_unknown` 及未確認身分，同交易建立固定 teacher＋pending profile 與申請；已取得派送資格不因途中過期拒絕可信提交。其他 metadata 一律忽略；原生無選擇子 signup 只留無平台權限 Auth 帳號。未驗證平台申請的密碼變更由 DB UPDATE 守衛拒絕（含已派送目標的競態），不影響首次 INSERT、寄信／重寄及電郵確認；不覆寫既有 profile 或補建 missing profile。既有確認 token 守衛保留。不承諾跨服務全面原子性，不防禦所有 Auth／DB 管理權操作。
- **批准前置**：電郵已驗證只取自 Auth `auth.users.email_confirmed_at`（DB 端）與 `/auth/v1/user`（登入端），不接受 query／表單／storage／metadata 宣告。未驗證：登入回 403 `email_not_verified` 且不發 session；不列入 `GET /api/v1/admin/teachers`；`review_pending_teacher` 回 `not_eligible`→409 `teacher_not_verified`。清單每列加 `school_note`（未受信任內容，畫面 escaping），不開放 email 或 Auth 全使用者查詢。驗證後不自動批准，不建立學校、歸屬或綁定。
