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
| A-4 | `GET /api/v1/me` | 已登入（含待審核、已拒絕、已停用者可呼叫，但回傳僅限狀態） | 無 | `{ role, account_status, school_gate: { state, ai_available, public_deploy_available, reason_code? }, teacher_notice?: { teachers: [{display_label}], scope: ["專案","檔案","完整對話","學習／開發紀錄"] } }` | `401` | — | 即時 |
| A-5 | `POST /api/v1/admin/students` | 管理員或教師（發起核發）；教師僅能為自己發起（教師另受 §3a 條件限制） | `{ handle, display_label?, school_id, note? }`（**不得含真實姓名、電郵、電話欄位**；伺服器對 handle 與備註做真名／聯絡資料樣式檢查並提示，無法保證，故仍須管理員審核） | `201`＋`{ student_id, account_status: "pending" }`（此時**尚無登入碼**） | `409 handle_taken`；`422`；`403` | `Idempotency-Key`；教師每日發起上限（工程值） | `GET /api/v1/admin/students/{id}` |
| A-6 | `POST /api/v1/admin/students/{id}/approve` | **管理員** | `{}` | `200`＋`{ credential: { state: "pending_reveal", reveal_expires_at } }`；批准後產生登入碼，依 A-8 的最多一次秘密輸出機會處理（不保證送達；不改核發流程） | `409`（非 `pending`）；`403` | `Idempotency-Key`；稽核 | — |
| A-7 | `POST /api/v1/admin/students/{id}/reject` | **管理員** | `{ reason_code, note_for_user? }` | `200` | — | 同上 | — |
| A-8 | `POST /api/v1/admin/students/{id}/credential/reveal` | 管理員，或**發起核發的教師**（僅限首次領取期限內；教師另受 §3a 條件限制） | `{}` | `200`＋`{ login_code }`（**最多一次伺服器秘密輸出機會，可能零次交付**；`Cache-Control: no-store`；之後回 `410 already_revealed`）；`state`→`active` | `410`；`403`；`409`（尚未批准）；不新增回應映射 | `Idempotency-Key`：同鍵同內容仍當下重驗資格，只回最小非秘密 receipt／狀態，不再顯示明文；「已顯示」不作送達證明；稽核不含明文。只同步秘密重播原則，不改核發流程／領碼權 | — |
| A-9 | `POST /api/v1/students/{id}/credential/reissue` | **已綁定教師**（`teacher_can_view_student` 的綁定部分）或**管理員**；未綁定教師 → `403`（不洩漏學生存在）；教師另受 §3a 的 R-a 限制；須合法核對身分 | `{ identity_check: "verified_in_person" ｜ …固定碼 }` | 保留成功回應草案 `200`＋`{ login_code }`，僅在 Auth 套用已確認、相依在途可信終結、舊 session 資料阻擋及平台完成提交有證據時成立；成功新碼生效、舊碼**立即失效**。之後才有最多一次秘密輸出機會，可能零次交付；不保證人已持碼 | 保留既有 `403`／學生非 `approved` 的 `409`；未送出／可靠確認未套用、已套用後平台失敗、unknown 分支見 §2。舊 `502 reissue_failed` 不足以表達所有分支，**最終 HTTP／錯誤碼映射尚待設計**，不一律套用、不新增碼 | `Idempotency-Key`；同鍵同內容當下重驗資格，只回最小非秘密 receipt／狀態，不重播碼、不再次執行 Auth；異內容依 COMMON 拒絕；新鍵不得繞過同目標未結操作；限流（每學生每小時 N 次，工程值）與稽核保留 | 僅合法授權者的最小非秘密狀態／恢復需求；路徑及映射待設計，receipt 不授權 |
| A-10 | `POST /api/v1/review-requests` 與 `GET /api/v1/review-requests/mine` | 受限入口：被拒絕者、發起教師、停用當時已綁定教師（詳見 [access-and-lifecycle.md](./access-and-lifecycle.md) §5） | — | — | — | — | — |

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
