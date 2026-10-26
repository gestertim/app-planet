# 資料模型：AI APP 超級創客｜App Planet 平台首版

**功能目錄**：`specs/001-app-planet-platform`（依 `.specify/feature.json`）｜**計畫**：[plan.md](./plan.md)｜**研究**：[research.md](./research.md)｜**規格**：[spec.md](./spec.md)｜**UX/UI**：[ux-ui-design.md](./ux-ui-design.md)
**狀態**：Plan 草案（AI 起草；尚未取得教育者批准）。欄位為設計層級，**不是 migration**；實作須待 Tasks／Analyze／Readiness Gate 與教育者階段批准。

> 標記：〔已批准〕＝來源為 spec.md 已記錄的教育者決策；〔待決 D-xx〕＝見 [decision-register.md](./decision-register.md)，**不得當作定案**；〔參數 PP-xx〕＝政策數值，建議值待核定；〔技術決定〕＝本 Plan 的工程選擇（可被教育者否決）。

> **T051 有界例外（2026-10-24）**：僅 [readiness-review.md](./readiness-review.md) §41 批准的本機隔離子集已新增 migration；不等於 Plan／完整資料模型通過 Gate、正式服務授權或一般部署許可。

> **首版範圍決定同步（2026-10-21；僅修訂文件，未建立任何資料表、未實作）**：教育者決定首版學生作品**只可採 A／B 級、不開發 C 級作品**，作品本身不得以生成式 AI 作為執行時功能（canonical：spec.md Clarifications「Session 2026-10-21（首版範圍決定…）」與 FR-049）。本檔因此：（1）作品等級列舉僅 `A`｜`B`（C 不納入首版資料列舉，保留歷史註記）；（2）公開作品 AI 用量、每作品上限、公開 AI 池、訪客事件等實體與欄位標示 **「首版不建立」**，並保留原文作歷史；（3）學校核准撤回於首版涵蓋該校**全部**公開作品（皆不含作品執行時 AI）；（4）學生平台 AI 的用量、創作池、值守閘門、稽核與 B 級 β2（§5.4）**保留**；（5）新增 §5.5「審查檢核：作品含執行時 AI 呼叫」所需資料項（規劃描述）。統一標示格式：`【已被取代・首版不適用（2026-10-21 範圍決定）；原文保留作歷史】`。**C 級作品不是「首版內稍後交付」；後續須另立功能與批准流程。**

> **D-23 現行覆寫**：上段中的 B 級 β2「首版保留」是當時的範圍紀錄，學生伺服器公開執行已改為後續獨立 feature；MVP 仍有 B2 Work Data API（非 β2 runtime），依 §5.4 現行模型。平台 AI 仍屬首版能力。

## 0. 通則

| 項目 | 決定（〔技術決定〕） | 理由 |
| --- | --- | --- |
| 資料庫 | Supabase PostgreSQL（已批准技術基線）；所有表開啟 RLS；預設全拒絕 | 憲章 V；FR-038 |
| 主鍵 | `uuid`（`gen_random_uuid()`）；不使用可推測序號作為對外代號 | 防列舉 |
| 時間 | `timestamptz`；週期以 `Asia/Taipei` 計：`period_day = (now() AT TIME ZONE 'Asia/Taipei')::date`、`period_month = date_trunc('month', …)`；週期鍵由資料庫函式 `app.taipei_day()` 產生，不由客戶端傳入 | FR-042、FR-055；教育者已決定時區與時點 |
| 金額 | 一律以整數 **micro-USD**（1e-6 美元）儲存；顯示給學生的是「創作能量」而非金額 | 避免浮點；PD-06 |
| 授權判定 | 以「資料庫即時查詢」為準，**不把角色、帳號狀態、學校狀態放進 JWT 當授權依據**；JWT 僅用於辨識 `auth.uid()` | Supabase 官方：access token 到期前無法撤銷（見 research.md R-02）；FR-038 要求即時驗證 |
| 稽核代號 | 稽核列只存 `actor_aid`／`subject_aid`（每帳號一個隨機代號），對照表 `audit_identity_map` 與稽核分離；清除主資料時刪除對照 | FR-052(e)、PD-03(a)；**不稱完全匿名** |
| 刪除語意 | 見 §9；「標記刪除」為帳號生命週期旗標，不是帳號狀態值 | spec.md Key Entities |
| 內容大小 | 原始碼文字檔存 PostgreSQL（`blobs`），二進位附件存 Supabase Storage 私人 bucket | Supabase 備份不含 Storage 物件本身（R-02）；原始碼隨資料庫備份／PITR 才可恢復；**同時使「清除」只需刪資料列與物件**〔技術決定〕 |

## 1. 身分、學校與帳號

### 1.1 `schools`（學校核准紀錄的主體）〔已批准：FR-046、047〕

| 欄位 | 型別／約束 | 說明 |
| --- | --- | --- |
| `id` | uuid PK | |
| `label` | text | 學校顯示名稱（機構名稱，非個資） |
| `approval_state` | enum：`unconfirmed`（未確認／無紀錄）、`approved`、`withdrawn`、`expired` | 預設 `unconfirmed`；**「無紀錄」以「有列但 `unconfirmed`」表示**（建校即建列），避免「查不到＝未確認」與「查詢失敗」混淆；查詢失敗一律 fail-closed |
| `approval_epoch` | bigint，每次狀態轉移 +1 | 供 Worker／公開閘道快速偵測校級狀態變更（見 §4.3） |
| `valid_until` | timestamptz NULL 〔保留欄位；待決 D-04〕 | **NULL＝尚未決定有效期語意，不自動轉態**；是否自動轉 `expired`、提醒方式、判定時點未決，欄位存在不代表政策已定 |
| `current_doc_version` | text NULL | 目前核准對照的文件版本識別（教育者／學校提供的版本標籤，非文件內容） |
| `created_at`, `updated_at` | timestamptz | |

**約束**：`approval_state` 只能經 RPC `app.school_transition()` 變更；僅 `role = admin` 且帳號 `approved` 可呼叫（RLS＋函式內檢查）；教師呼叫一律拒絕並寫安全事件（US 13 情境 3）。

### 1.2 `school_approval_records`（追加式；僅管理員可寫）

`id`、`school_id`、`action`（`register`｜`verify`｜`withdraw`｜`expire`｜`restore`）、`from_state`、`to_state`、`doc_version_label`、`doc_date`、`reason_code`（固定碼，非自由文字）、`actor_aid`、`created_at`、`epoch_after`。
- 不含學生或家長個人資料（FR-047）；不含證明檔（是否附證明檔未決，OD-13(3)，不預設）。
- `restore` 必須帶 `doc_version_label`（FR-047(e)：未記錄文件版本不得恢復）——以 `CHECK (action <> 'restore' OR doc_version_label IS NOT NULL)` 與函式雙重強制。
- 「重新核對供應商條件」以 `reason_code = 'vendor_terms_rechecked'` 搭配記錄，**不代表平台判斷合規**。

### 1.3 `profiles`

| 欄位 | 型別／約束 | 說明 |
| --- | --- | --- |
| `id` | uuid PK = `auth.users.id` | |
| `role` | enum：`student`、`teacher`、`admin` | 只能由管理員經 RPC 設定；使用者不可更新（欄位級 RLS＋觸發器擋下） |
| `status` | enum：`pending`、`approved`、`rejected`、`disabled` | FR-035 四種狀態；**不含 `deleted`** |
| `deletion_state` | enum：`none`、`marked`、`purging`、`purge_failed`、`purged` | 標記刪除旗標；`marked` 起一律視為不可存取（§9） |
| `school_id` | uuid NULL FK → `schools` | 學生必填（`CHECK (role <> 'student' OR school_id IS NOT NULL)`）；教師與管理員可為空。**教師的學校歸屬不以此單值欄位表達**：採 M1（見 §1.3a，D-06 (a) 教育者 2026-10-23 批准），此欄位對教師不作歸屬判斷依據 |
| `handle` | citext NULL UNIQUE | 僅學生：登入用「帳號」（匿名暱稱，禁止真實姓名；核發畫面提示，UX 已規劃） |
| `display_label` | text | 畫面顯示名稱（學生＝暱稱；不複製進稽核） |
| `initiated_by` | uuid NULL | 發起核發的教師／管理員 |
| `status_changed_at` | timestamptz | |

**學生電郵／電話**：`auth.users` 內為不可投遞的合成電郵（§1.5），`profiles` 不存任何電郵或電話。教師／管理員的電郵只存在 `auth.users`，不複製。

### 1.3a 教師—學校有效歸屬（M1；D-06 (a)，教育者 2026-10-23 批准）〔僅模型與規則；**不是 migration、不建資料表、不建 RLS 或管理端點**〕

| 表（候選名稱） | 重點欄位 | 說明 |
| --- | --- | --- |
| `teacher_school_memberships` | `id`、`teacher_id`（教師 `profiles.id`）、`school_id`、`state`（`active`｜`ended`）、`created_by_aid`、`created_at`、`ended_at NULL`、`ended_by_aid NULL` | 教師可同時歸屬多所學校（**不假設單一學校**）；**只能由管理員建立／結束**，教師不能自行加入；結束不刪列。`UNIQUE (teacher_id, school_id) WHERE state = 'active'`（主鍵／索引屬一般工程設計，可於實作時調整，**不得順帶新增角色、管理流程或使用者政策**） |

**規則**：(1) 教師的**有效歸屬集合**＝`state = 'active'` 的 `school_id`；`ended` 不計。(2) 歸屬只用於帳號準備範圍：發起核發的目標學校須在集合內（AUTH A-5）；首次領取登入碼時目標學校仍須在集合內（A-8）；歸屬**不等於**可查看學生資料（仍須 §2.2 的有效綁定與學校條件）。(3) 以下四種情況必須分開，不得互相填補：**未歸屬**（集合為空）、學校 `unconfirmed`（資料事實）、**查詢失敗**（執行期錯誤，fail-closed）、`schoolApproval: null`（呼叫端未提供，不證明任何歸屬或核准）。(4) 教師登入不依賴歸屬或學校查詢（§2.1）。(5) 真實歸屬的建立、結束、真偽與稽核由資料層與管理端點負責，**尚未建立**；真實歸屬與核發操作維持關閉。M0（單值）、M2（不開放發起）未採用。

### 1.4 `audit_identity_map` 與 `audit_events`

| 表 | 欄位 | 說明 |
| --- | --- | --- |
| `audit_identity_map` | `aid uuid PK`、`account_id uuid UNIQUE FK`、`created_at` | 稽核代號 → 帳號。**清除主資料時刪除此列**（FR-052(e)）；僅管理員（服務端）可讀 |
| `audit_events` | `id`、`at`、`actor_aid`、`subject_aid NULL`、`action`（固定碼）、`object_type`、`object_ref uuid NULL`、`school_id NULL`、`result`（`ok`｜`denied`｜`failed`）、`meta jsonb`（**白名單鍵**：版本號、狀態轉移、數量；禁止文字內容） | 追加式；無 UPDATE／DELETE 權限（僅保存期限排程可刪）；**不存**暱稱、登入碼、對話全文、檔案內容、完整 IP |

**再識別風險登錄（FR-052(e)「檢查其他資源代號」；〔技術決定〕）**：

> **首版稽核同步（2026-10-21）**：首版稽核涵蓋學生平台 AI、學校核准、帳號生命週期、審查與部署（含 §5.5 審查檢核 `review_ai_runtime_check`〔規劃〕）等；~~公開作品 AI 的停用／恢復／限額調整與訪客事件相關稽核動作~~【已被取代・首版不適用（2026-10-21 範圍決定）；首版不建立；原文保留作歷史】。稽核 `meta` 白名單與「不存內容」規則不變。

| 稽核列中的識別資訊 | 清除後是否仍可連回學生 | 處理 |
| --- | --- | --- |
| `actor_aid`／`subject_aid` | 對照刪除後不可由系統連回 | 刪除 `audit_identity_map` 列 |
| `object_ref`（專案、對話、申請、公開項目的內部 uuid） | 對應資料列於清除時一併刪除；孤兒 uuid 不再可解析 | 清除工作含「刪除該帳號擁有資源」；驗收：清除後以 `object_ref` 查詢不到任何資料列 |
| 對外公開代號（公開網址 slug、部署網址） | **可能**因已公開於網路而被外部連回作品 | **禁止寫入稽核**，稽核只存內部 `listing_id`；若現有資料已含，清除工作須遮蔽 |
| `school_id`＋時間＋動作 | 試行規模僅 1 校 100 生，**組合資訊仍可能被知情者推斷** | 無法消除；因此文件與畫面不得稱「完全匿名」，僅稱「已移除代號→帳號對照」 |
| `meta` 內容 | 白名單限制 | CI 檢查 `meta` 鍵白名單；測試掃描禁止暱稱出現 |

### 1.5 學生登入憑證與節流〔已批准：FR-051；D-07a＝已選首選驗證方案（方案 A），附實測條件 S-01～S-03，尚未執行；碼長／效期／數值待決 D-07b～e〕

> 本節欄位為**方案 A 的設計**。方案 A 若驗證失敗，改採 B／C 須由教育者重新決定，屆時本節會改動（B 需自有登入碼雜湊表；C 更換 Auth）。**不是已驗證可上線。**

| 表 | 欄位 | 說明 |
| --- | --- | --- |
| `student_credentials` | `student_id`、`version int`、`state`（`pending_reveal`｜`active`｜`superseded`｜`revoked`）、`issued_by_aid`、`issued_at`、`reveal_expires_at NULL`、`revealed_at NULL`、`auth_email_alias text`（**不代表真實學生電郵的合成電郵**，僅服務端可讀） | **不存登入碼明文或可還原形式**。登入碼雜湊由 Supabase Auth 以密碼形式保管（採方案 A，見 research.md R-01）；本表只追蹤版本與狀態。`(student_id) WHERE state IN ('pending_reveal','active')` 唯一只約束平台 DB 的追蹤列，不證明外部 Auth 密碼狀態或 unknown 時人持有可用碼；本次不選定新 schema |
| `login_throttle` | `bucket_key bytea`（`HMAC(pepper, ip‖handle)`／`HMAC(pepper, ip)`／`HMAC(pepper, handle)`）、`window_start`、`fail_count`、`blocked_until` | 不存原始 IP 與帳號字串；`pepper` 為服務端密鑰（定期輪替）；列保存 24 小時後清除〔參數 PP-07〕 |

- **一次性顯示（reveal-once；D-32(2)，已批准／已同步）**：最多一次伺服器秘密輸出機會，不保證恰好一次送達，crash／response-loss 可能零次交付。輸出門閂須先消耗再嘗試秘密輸出；門閂不是「人已看見」證據。回應 `Cache-Control: no-store`；日誌、稽核、通知、錯誤追蹤不得含碼。相同鍵同內容當下重驗資格，只回最小非秘密 receipt／狀態，不重播原碼、不再次執行 Auth；receipt 不授權。一般冪等 cache 不得保存秘密或可還原碼；同鍵異內容依 COMMON 拒絕，新鍵不得繞同目標未結操作。A-8 僅同步秘密重播原則，核發流程／領碼權不擴張。
- **重發分階段恢復（D-32(1)(3)）**：保留成功後舊版 `superseded`／新版生效與稽核；原子性只限平台 DB 內可共同提交的版本、稽核與非秘密操作狀態，不含外部 `auth.admin.updateUserById` transaction。未送出／可靠確認未套用時，只依證據清理本操作，不泛稱舊碼必可用；已確認套用只向前恢復平台完成狀態，不重送 Auth、不承諾外部密碼回滾。unknown 不回成功、不保證舊碼可用，持續受控暫停，不盲重發。可信終結須為可審閱原操作結果或不再可能寫入的可靠證據，timeout／租約到期／DB generation／人工按鈕單獨不足。**成功後密碼層舊碼拒絕與舊 session 資料阻擋分開驗**，不假設改密碼即撤銷全部 session／refresh。
- **最小非秘密狀態需求，不是新 schema 決定**：流程須可觀察地保存必要操作階段、合法主體／目標與鍵作用域、非秘密結果／證據參照、暫停與一次輸出門閂，支援同目標未結操作控制及向前恢復；不得存秘密、完整 Auth 回應、token／claims／session 原值。尚未選定 journal 表名、schema、enum、欄位、儲存期限、權限或 dispatcher 實作；COMMON 至少 24 小時不是本次 journal 保存天數核定。
- **暫停／恢復與啟用（D-32(3)(4)）**：unknown 至少暫停以目標學生身分執行的受保護資料操作、新產品登入與平台 refresh；最小狀態／恢復入口仍須當下合法授權。解除前須有相依在途可信終結、舊 session 資料阻擋及平台完成證據，account／school／ownership gate 仍獨立，不改 `profiles.status`、學校或師生關係。記憶體秘密遺失後不能恢復原碼；只能依核准恢復條件，在原操作可信終結／不再可能寫入後重新核身、新操作。unknown 可長期不能安全收斂；可恢復性、具名主責／備援與支援安排、全路徑設計及正式驗收不足即不可啟用，不承諾自動恢復或未核定時限。跨角色、教師獨立檢視、公開作品、在途／背景委派細節仍待決。

本節修訂依 [D-32](./decision-register.md#d-32-a-9-已批准契約原則與必要正式文件同步2026-10-26台灣)／[readiness §72](./readiness-review.md#72-2026-10-26-a-9-已批准契約原則的正式文件同步一次性文件授權先登錄)；以下 M2／M3 是既有候選，不是本次採用或實作批准。M3 §70 僅固定環境 candidate_supported，非完整有效性／託管支持證據。

> 以下候選段的「未查到，待實測」為原始設計時證據狀態，後續僅由 §70 固定環境研究補充，未升為產品採用。「殘留視窗回報」仍保留待教育者決定，不等於接受，更不能取代本次可信終結／舊 session 阻擋／平台完成的解除條件或允許 unknown 自動解除。
- **舊 access token／session 的資料層阻擋〔候選設計，待 S-03 驗證，不是定案〕**：停用與標記刪除已由 `account_gate`（讀 `profiles.status`、`deletion_state`）即時擋下；**重發不改變 `profiles.status`，現行 `account_gate` 不會擋下以舊碼取得的 session**。候選機制：（M2）登入時記錄 `session_id`（JWT 內 `session_id` claim，官方載明對應 `auth.sessions` 主鍵）與當時 `student_credentials.version` 的對照，RLS／函式於每次判定時比對是否仍為目前有效版本；（M3）直接以 `session_id` 判斷 `auth.sessions` 列是否仍存在（RLS 能否可靠讀取與據以拒絕：**未查到，待實測**）。若皆不可行，殘留視窗＝access token 剩餘有效期（≤PP-04），須如實回報教育者決定是否接受。

### 1.6 師生綁定與停用快照〔已批准：FR-014、036、052(a-2)、054(a)〕

| 表 | 欄位 | 說明 |
| --- | --- | --- |
| `teacher_student_bindings` | `id`、`teacher_id`、`student_id`、`state`（`active`｜`ended`）、`created_by_aid`、`created_at`、`ended_at NULL`、`ended_by_aid NULL`、`end_reason`（`admin_unbind`｜`student_deleted`｜`teacher_disabled`…固定碼） | 多對多（PD-08 建議，未批准，為預設；不設名額）。`UNIQUE (teacher_id, student_id) WHERE state='active'` |
| `account_disable_events` | `id`、`subject_id`（被停用帳號）、`disabled_at`、`disabled_by_aid`、`restored_at NULL`、`restored_by_aid NULL`、`marked_deleted_at NULL` | 每次停用一列；恢復時填 `restored_at`（事件關閉） |
| `disable_binding_snapshots` | `disable_event_id`、`teacher_id`、`binding_id`、`PRIMARY KEY (disable_event_id, teacher_id)` | **停用當時**已綁定教師的凍結快照，與停用寫入同一交易（`app.disable_account()`）。**只用於核對複查資格，不授予任何查看權限**（FR-052(a-2)）。保存期限〔待決 D-09，PP-14〕 |

**不修改綁定列**：停用時不把 `active` 綁定改成 `ended`；凍結由授權函式 `app.teacher_can_view_student()` 檢查 `student.status = 'approved'` 達成。這樣：（a）「停用當時的綁定紀錄保留」自然成立；（b）恢復後「不自動恢復綁定」須由管理員**明確重新綁定**——恢復 RPC 在同一交易中將該生所有既有 `active` 綁定轉為 `ended`（`end_reason = 'restore_requires_rebind'`），再由管理員建立新綁定列；（c）教師權限不會因恢復「悄悄復活」。

## 2. 授權規則（資料層）

以下為 RLS／RPC 共同使用的純函式，**同一份規則由 `packages/core/policy` 以 TypeScript 實作供伺服器與 Worker 重新檢查**（雙實作須由同一組案例表驅動測試，防止漂移）。

### 2.1 `app.account_gate(account_id, capability)` 判定表

〔已批准〕欄位以 spec.md FR-035／046／047／052 為準。學校狀態只適用 `role = student`。✔＝允許；✖＝拒絕；「—」＝不適用。

| 能力（capability） | 帳號 `pending` | `rejected` | `disabled` | `marked_deleted` | `approved`＋學校 `unconfirmed` | `approved`＋學校 `approved` | `approved`＋學校 `withdrawn`／`expired` |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `login`（建立工作階段） | 僅教師／管理員（看狀態與登出）；學生帳號於批准前尚無登入碼 | 僅教師／管理員申請者（看結果）；遭拒學生帳號無登入碼 | ✖ | ✖ | **✖（學生；憑證通過後仍拒絕，不建立工作階段）** | ✔ | ✔ |
| `read_saved_content` | ✖ | ✖ | ✖ | ✖ | ✖ | ✔ | ✔ |
| `edit_saved_content`（非 AI） | ✖ | ✖ | ✖ | ✖ | ✖ | ✔ | ✔ |
| `download_own_results` | ✖ | ✖ | ✖ | ✖ | ✖ | ✔ | ✔ |
| `ai_call`（對話／圖像／網頁搜尋／Coding Agent） | ✖ | ✖ | ✖ | ✖ | ✖ | ✔（另受額度、內容安全） | **✖（立即；含背景工作下一個重要步驟）** |
| `submit_for_review` | ✖ | ✖ | ✖（待審暫停處理） | ✖ | ✖ | ✔ | ✔（提交可保存；**公開部署暫停**，見 §5.3；教育者未決 D-03） |
| `public_deploy`（新的公開部署） | ✖ | ✖ | ✖ | ✖ | ✖ | ✔ | **✖（暫停）** |

> 教師與管理員不受學校 AI 閘門影響（閘門以「所屬學校的**學生**」為對象）；**〔後續決定，2026-10-21〕學生的 `ai_call` 另受 §6.4 值守閘門（`duty_gate('student_ai')`）限制，非值守時段或值守設定未核定時被拒（`ai_off_duty`），此閘門不影響 `login`、`read_saved_content`、`edit_saved_content`、`download_own_results`**；**教師在學校 `unconfirmed` 狀態下（D-06 (a)，教育者 2026-10-23 批准；取代原 `policy.teacher_scope_when_school_unconfirmed` 待決）**：有效教師可登入，**登入不依賴學校或歸屬查詢**（帳號／身分查詢失敗一律拒絕；`disabled`、刪除狀態拒絕；`pending`／`rejected` 只有受限狀態入口）；學校未確認時僅可使用受限的帳號準備範圍（見 AUTH §3a：受限首頁、查看自己發起的申請、為有效歸屬內學校發起核發、首次領取登入碼；重發於學生學校 `unconfirmed` 時拒絕教師，R-a），**不開放該校學生的學習資料、AI、審查與部署**。學校讀取失敗不得填成 `null`／`unconfirmed` 後放行需要學校資料的能力；管理員既有允許範圍不變，不擴充成完整管理員能力矩陣。教師歸屬見 §1.3a（M1）。

**實作規則**：`account_gate` 為 `STABLE SECURITY DEFINER`，依 `profiles`、`schools` 即時查詢；錯誤或缺資料一律回傳 `deny`；`reason_code`（固定碼）用於學生端文字說明與稽核，**對外回應不洩漏其他學生或帳號是否存在**。

### 2.2 教師查看學生資料

```
teacher_can_view_student(teacher, student) =
      teacher.role = 'teacher' AND teacher.status = 'approved' AND teacher.deletion_state = 'none'
  AND student.status = 'approved'              -- 停用即凍結
  AND student.deletion_state = 'none'
  AND EXISTS (active binding(teacher, student))
  AND school_policy_allows_teacher_view(student.school_id)   -- 見下
```

- `school_policy_allows_teacher_view`：學校 `approved`／`withdrawn`／`expired` 時允許（規格未限制撤回／失效期間教師對已保存內容的查看；〔工程假設，低風險；待教育者確認〕）；`unconfirmed` 時**拒絕**（D-06 (a)，教育者 2026-10-23 批准：帳號準備不開放該校學生的學習資料；亦因該校學生本身無法登入）。
- 每次「開啟學生資料」寫 `audit_events(action='teacher_view')`，粒度為「開啟一位學生的一類資源」（專案／對話／檔案／紀錄），同一教師、同一學生、同一資源類型 N 分鐘內合併為一筆〔參數 PP-12〕；稽核不含內容。管理員可於管理中心核對（FR-014）。
- 回饋、審查理由屬學生學習紀錄；解除綁定後教師端不可見，學生可見（PD-05 建議，未批准，不構成規則）。

### 2.3 受限複查資格（不授予任何學生資料權限）

| 複查類型 | 提出資格函式 | 說明 |
| --- | --- | --- |
| 帳號複查：被拒絕的教師／管理員申請者 | `requester = subject AND subject.status = 'rejected'` | 只可寫一件申請、讀自己的狀態與回覆 |
| 帳號複查：教師核發而被拒的學生帳號 | `requester = subject.initiated_by AND subject.status = 'rejected'` | 發起教師代提 |
| 帳號複查：停用帳號 | `EXISTS (disable_binding_snapshots s JOIN account_disable_events e ON …WHERE e.subject_id = subject AND e.restored_at IS NULL AND s.teacher_id = requester) AND subject.status = 'disabled'`（每次提交與讀取逐次重驗） | **只有停用當時已綁定者**；停用前已解除綁定者、停用後才綁定者皆拒絕（停用中本不允許新綁定，〔工程假設〕）；標記刪除後是否仍可複查〔待決 D-09〕，預設 fail-closed 拒絕 |
| 作品複查 | `requester = version.owner AND owner.status = 'approved'`，且對象版本有對應的「退回」或「下架」處置事件 | 停用帳號無入口（學生無法登入）；**因學校撤回／失效而停止公開者暫不提供入口**（〔待決 D-05〕，沿用 FR-054 現行範圍） |

## 3. 對話與內容

| 表 | 重點欄位 | 備註 |
| --- | --- | --- |
| `conversations` | `id`、`owner_id`、`title`、`last_skill_id`、`row_version int`、`created_at`、`deleted_at NULL` | 擁有者單一；重新開啟還原最後 Skill（FR-031）；`row_version` 僅支援既有 CHAT H-3 對話 PATCH／DELETE 的 If-Match，不套用至 messages 或其他資料列 |
| `messages` | `id`、`conversation_id`、`seq`、`author_kind`（`user`｜`assistant`｜`system`）、`skill_id`、`skill_version`、`content text`、`state`（`complete`｜`partial`｜`blocked`｜`failed`）、`safety_label`（固定碼 NULL）、`client_request_id`（冪等） | `blocked`：**不保存被攔截的原文**，只存類別（最小化；FR-053(c)）。求助訊息屬學生發言，保留於對話（教師依 PD-01② 可見）；安全事件不複製內文 |
| `attachments`／`library_files` | `id`、`owner_id`、`storage_path`、`mime`、`bytes`、`scan_state`（`pending`｜`clean`｜`rejected`｜`failed`）、`derived_from` | 私人 bucket；路徑 `{owner_id}/{id}`；格式／大小上限〔待決，PP-17／PD-02 建議〕 |
| `skills` | `id`、`name`、`version`、`source_ref`、`source_status`（`available`｜`pending_source`）、`tool_allowlist text[]` | `pending_source` 的 Skill 只開放已具來源的能力（FR-044；OD-07 待取得） |
| `handoffs` | `id`、`conversation_id`、`from_skill`、`to_skill`、`summary jsonb`、`refs jsonb`、`state`（`draft`｜`confirmed`｜`cancelled`） | 引用資料於確認時重新授權（FR-018） |

**契約上的 `messages.state` 與 SSE 終止事件（D-26、D-29b；2026-10-23 教育者批准；同日 §29 釐清）**：H-4 先以 `partial` 寫入，**一般完成情境**在 `done` 後為 `complete`；使用者停止、逾時或可回報中斷維持 `partial`；**`error` 終止後為 `failed`**——已檢查且已保存的片段保留可讀，明示未完成，不標 `complete`。無終止事件（例如連線已斷、尚無法確認）不得被讀成成功。以上一般映射不能覆蓋 [CHAT §3](./contracts/ai-chat-and-safety.md) 已有的 **`block → blocked`**：`done` 只表示串流正常結束，不表示未被攔截，`block → done` 不能據此改標 `complete`。`support` 的完整訊息狀態映射與 block／其他事件組合的完整優先序本輪不決定。

**本機 helper 的適用範圍（非產品契約變更）**：[deriveMessageState](../../packages/core/policy/sse-event-history.ts) 僅處理不含 block／support 的有效歷史：普通 `done → complete`、`partial → partial`、`error → failed`、無終止事件 → `partial`。先完整驗證歷史；格式、序號、終止規則等錯誤仍回原有驗證碼；有效歷史若含 block 或 support（無論是否已終止），明確回 `{ ok: false, code: "unsupported_message_state_mapping" }`，不提供推測的 state／incomplete／片段結果，也不稱為 `invalid_history`。此碼僅屬本機純函式 API，不是 HTTP／SSE 對外錯誤碼，不撤銷或改寫 CHAT 的 `block → blocked`，不禁止合法事件加入／驗證／重放。完整 block／support 訊息狀態映射尚未在 helper 實作；授權、重現及驗證見 [readiness-review.md](./readiness-review.md) §29。

**事件保存與重放責任**：只保存可安全建構（已通過檢查、payload 符合登錄 schema）的事件，不保存未檢查內容；游標只在已保存事件分配；保存歷史 `done`（`usage` 沿用原值，不重新計算）以及安全的 `partial`／`error`，重放沿用原 id；終止後重放已保存事件不算新增生成，也不得新增任何事件。不新增 retention、重試次數、費用或恢復政策（保存期限沿用既有資料保存政策）。事件表／欄位名稱尚未設計，**不建立資料表**。

## 4. 專案、版本與 Agent

### 4.1 專案與版本

**§46 唯讀聚合（2026-10-24 單批本機子集）**：不新增／變更任何持久資料、migration、RLS、grant 或版本；單一參數化 statement snapshot 讀取現有 projects、當前 project_requirements／完整確認證據與 stage_records，只投影 [PROJ §1.3](./contracts/projects-agent-sandbox.md#13-工作區唯讀恢復聚合46-2026-10-24-單批本機子集) 工作區 DTO。需求為 null 或含自身 revision 的內容；drafts 僅列出已保存階段，缺少不補空稿，原始空字串與 Unicode 不變；各資源版本不可混用。確認證據只在內部驗證，不回 owner／確認人或內部表，普通 confirmed 不進可信來源集合。不表示後續操作／登入恢復／完整任務已完成，授權與本輪驗證見 [readiness §46](./readiness-review.md)。

**§49 創作旅程唯讀評估（2026-10-24 單批本機子集）**：沿用既有資料表與讀取權限；在同一 SQL statement snapshot 重新檢查 `read_saved_content`／owner，取得 project row_version、當前 requirements revision／內容、完整分類確認投影／內部關聯 evidence 與九步 `stage_records`。server 僅把完整驗證結果交給 `evaluateCreationFlow`，回傳該次 snapshot 的專案 ID／版本／revision／assessment；不保存或快取結果，不寫入任何表、不新增 migration／grant／RPC／資料欄位／resolver 標記。確認／需求／草稿本文及確認人只供內部比對，不進公開評估 DTO。缺當前需求、證據關聯矛盾及非法／重複資料全份 fail-closed；詳細介面與限制見 [PROJ §1.4](./contracts/projects-agent-sandbox.md#14-創作旅程唯讀評估49-2026-10-24-單批本機子集) 及 [readiness §49](./readiness-review.md)。

**§45 隔離本機獨立草稿（2026-10-24 教育者核定）**：`0012_stage_drafts.sql` 只新增階段草稿／冪等表與受限 writer，不修改已驗證舊 migration。內容 strict `{ text: string }`，空字串／空白／Unicode 原文保留，拒絕 NUL／不成對 surrogate／未知欄位。九步皆可各自保存，不受目前 project stage 限制；這不是階段已達成、可執行或完成。首次 stage row_version 固定 0，更新帶預期版本並 +1（同內容新操作也 +1），不是 projects 的版本；不改 project stage／row_version／需求 revision／分類證據。首次預期版本為 null，唯一鍵與受控資源鎖避免重複建立。`ai_draft` 是本輪沿用的未確認狀態名稱，`student_input` 只表示學生提交來源，不推論人工原創或 AI 生成。草稿不是權威需求、分類／Checkpoint／批准／Final Pack 證據；權威需求仍由 §43 服務處理與失效。

| 表 | 重點欄位 | 備註 |
| --- | --- | --- |
| `projects` | `id`、`owner_id`、`requested_tier A｜B｜NULL`、`classification_state`（`unconfirmed`｜`confirmed`｜`legacy_unverified`）、可信正式 `tier A｜B｜NULL`、`needs_visitor_identity boolean｜NULL`、`requirements_revision`、`current_confirmation_id`、`stage`、`created_at` | P-1 新列 `unconfirmed` 時正式分類皆 NULL；只有受控交易可建立與目前需求 revision 相符的 `confirmed`。歷史列原值保留並標 `legacy_unverified`，不因 false／tier 值自動確認。 |
| `project_requirements` | `project_id`、`revision`、`description`、`runtime_needs`、`runtime_ai_required`、`created_by`、`created_at` | 只保存分類所需的固定最小需求欄位；每專案 revision 遞增且不可變，不擴充完整 Specification、`stage_records` 或 tasks。 |
| `project_classification_confirmations` | 專案／需求 revision 與需求快照、`requested_tier_at_confirmation`、明示差異回覆、A／B、visitor boolean、`confirmed_by`、`confirmed_at`、`source` | 追加式不可變證據；可信確認綁定確切需求內容／revision、當下擁有者學生及 DB 時間。舊證據保留作歷史，不因重放恢復資格。 |
| `project_classification_idempotency` | `owner_id`、`operation_scope`、`idempotency_key uuid`、請求本文、操作回應、`created_at`、`expires_at` | 主體與操作 scope 隔離，至少 24 小時；重放前重驗授權。原操作回應與另外解析的當前分類分開。 |
| `project_create_idempotency` | `owner_id`、`operation_scope`、`idempotency_key uuid`、本文比對資料、`project_id`、原始建立 DTO、`created_at`、`expires_at` | 僅建立操作、主體與 scope 複合唯一；expires_at 至少建立後 24 小時。過期 key 僅在同鍵重用時交易內移除，不設永久保存政策或定時清理。 |
| `stage_records` | `(project_id, stage)` 複合 PK；`stage`（九步）、`state`（完整模型：`ai_draft`｜`user_confirmed`｜`approved`）、`content_source`、`content jsonb`、`row_version int`、`approved_by`、`approved_at`、DB `created_at`／`updated_at` | 草案／確認／批准三態分開（FR-019）；本機 §45 僅建立未確認草稿子集，state 固定 `ai_draft`、來源固定 `student_input`、批准欄位 NULL，不提供確認／批准寫入。狀態名稱不證明 AI 生成。 |
| `stage_draft_idempotency` | `(owner_id, operation_scope, idempotency_key uuid)` 複合 PK；`project_id`、`request_payload jsonb`、`response jsonb`、`created_at`／`expires_at` | §45 草稿保存 scope `stage_draft_save_v1`；至少 24 小時、重放重新授權；原操作 receipt 與當前草稿分開，不定草稿保存期限／歷史數量或排程。 |
| `blobs` | `hash text PK`（SHA-256）、`bytes int`、`content bytea` | 內容定址；文字原始碼去重；單檔上限〔PP-17〕 |
| `snapshots` | `id`、`project_id`、`version_no`、`kind`（`auto`｜`manual`｜`pre_agent`｜`pre_restore`｜`submission`）、`manifest jsonb`（路徑→hash）、`content_hash`（整個 manifest 的雜湊）、`immutable bool`、`created_by` | `submission` 版本 `immutable=true`，由觸發器禁止更新／刪除（專案存續期間）；一般快照保留份數〔PP-18，PD-03 建議 30 份未批准〕 |
| `tasks` | `project_id`、`order`、`title`、`done bool`、`done_snapshot_id NULL` | 任務更新必須真正寫入（FR-023） |
| `test_runs` | `id`、`snapshot_id`、`status`（`passed`｜`failed`｜`not_run`｜`needs_human`）、`detail jsonb` | **綁定快照**；`not_run`／`needs_human` 不得以任何路徑被聚合成 `passed`（SC-006）；聚合函式以案例表測試 |

**P-1 新專案初始化（2026-10-24；本輪採方案 B）**：受控流程固定 `stage="點子"`、`row_version=0`、`classification_state="unconfirmed"`；省略 tier 時 `requested_tier=NULL`，明示 A／B 精確保存為 requested_tier；可信 `tier` 與 `needs_visitor_identity` 均 NULL。caller 不可指定這些欄位、owner、id 或時間。未分類建立不授予預覽／提交／發布／部署資格。歷史 `0001`／`0002`／`0009` 不修改；`0010_projects_unclassified_create.sql` 將原資料標為 `legacy_unverified`。本輪 §43 新增的 `0011_project_requirements_classification.sql` 才提供確認資料模型／受控確認寫入，保留 0010 已驗證內容，不新增全表 row_version 非負限制；舊九階段與負／零版本維持讀取相容。

**需求版本與確認證據（§43；一次性本機子集）**：`projects.row_version` 控制專案列更新與並行衝突；`requirements_revision` 只識別不可變需求內容版本，內容實質不同才遞增，兩者不可互代。需求原文不 trim／正規化；相同內容不建新 revision。需求變更交易須保存下一 revision、清除當前 `tier`／visitor／confirmation 指標、將狀態改回 `unconfirmed`、遞增 row_version 並保留舊確認證據。`confirmed` 必須對應當前 revision 與逐位元相同需求快照；`legacy_unverified` 不可當作 confirmed。新分類 DTO 明確表達三種狀態；舊七欄介面維持可表示歷史列的相容性，不能表示新列時明確回 unsupported。T095 純函式不負責證據來源或操作授權；確認也不授予預覽、提交、發布或部署資格。其他保存、全階段旅程及政策仍依原 Gate。

**衝突處理**：`conversations`、`projects`、`stage_records`、`tasks` 帶 `row_version int`，更新採樂觀並行（`WHERE row_version = :n`）；衝突回 `409` 並回傳雙方內容（Edge Case：多處編輯不靜默覆蓋）。成功更新的 row version 必須改變且不得重用；除上述新專案及 §45 階段草稿固定初值外，本模型不另定其他資源初值或全表正值限制。其他資料列不因此新增版本欄位；檔案更新仍使用該檔 SHA-256 hash，不使用 row version。

### 4.2 Agent 與工作佇列

| 表 | 重點欄位 | 備註 |
| --- | --- | --- |
| `agent_runs` | `id`、`project_id`、`owner_id`、`mode`（`guided`｜`auto`）、`state`（`awaiting_approval`｜`running`｜`stopping`｜`stopped`｜`completed`｜`failed`）、`base_snapshot_id`、`approved_plan jsonb` | `auto` 先呈現任務與影響，經確認才可 `running`（FR-011）；開始套用前必須有 `pre_agent` 快照 |
| `agent_steps` | `run_id`、`seq`、`kind`、`tool`、`args_digest`、`state`、`result_ref` | 工具白名單由 `skills.tool_allowlist` 與角色決定 |
| `jobs` | `id`、`kind`、`payload jsonb`、`state`（`queued`｜`leased`｜`done`｜`failed`｜`cancelled`）、`lease_owner`、`lease_expires_at`、`attempts`、`max_attempts`、`run_after`、`idempotency_key UNIQUE`、`subject_id`、`school_id`、`school_epoch`、`cancel_requested bool` | `SELECT … FOR UPDATE SKIP LOCKED` 領取；租約＋心跳；每個「重要步驟」前 Worker 呼叫 `account_gate`（§2.1）並比對 `school_epoch`；**〔後續決定，2026-10-21〕學生 AI 類工作另於重要步驟前呼叫 `duty_gate('student_ai')`（§6.4）；被擋時 `state` 可為 `paused_off_duty`（新增值；不自動續跑，待核定；D-14 尚未決定，不能視為 D-25 對外已採用狀態）**；`cancel_requested` 為協作式取消旗標。此資料表列為內部工作佇列，不等於 COMMON D-25 的對外 Job 快照 DTO。 |

### 4.3 學校狀態變更的即時性機制〔技術決定〕

`schools.approval_epoch` 於每次轉移 +1。Worker 領取工作時記錄 `school_epoch`；每個重要步驟（呼叫模型前、套用檔案變更前、寫入結果前）重新查詢 `account_gate` 與目前 epoch：不同或不允許 → 停止、釋放預留（§8）、將 `agent_runs` 設為 `stopped(reason=school_gate)`，並保留已完成部分。已送出到 OpenAI 而尚未回傳的串流請求以 `AbortController` 取消；結果不明的預留進入 `unknown` 核對（§8）。**這是「下一個重要步驟」語意的實作，不承諾毫秒級中止正在進行的供應商呼叫**。

### 4.4 MVP 建置、產物與預覽綁定（2026-10-21 現行設計；僅文件，未建立資料表）

依 [spec.md](./spec.md) 最新 MVP Session、[publishing 契約 §3.6](./contracts/publishing-and-public-runtime.md) 與 D-23。方案 X 的產物綁定不依沙箱存活；A1 預覽以 host-only 分區 cookie 與伺服端會話驗證，hostname 不構成授權。

| 概念／欄位 | 規則與狀態 |
| --- | --- |
| `preview_builds` | `id, project_id, snapshot_id, content_hash, generation, job_id, state, failure_code, artifact_id, created_at, completed_at`；`queued→building→retrieving→validating→succeeded`，任一階段可 `failed`／`cancelled`。產物驗證與保存完成前不可 succeeded；錯誤明示，不把保存成功或取回成功當整個建置成功。 |
| `preview_artifacts` | `id, snapshot_id, content_hash, manifest_hash, storage_ref, validated_at, bytes, file_count`；不可變、私有保存，僅平台核可產物可入庫；內部 `storage_ref` 不作瀏覽器可直接存取的 URL。產物大小／數量／型別政策 PP-20 未核定；Spike 上限不是正式值，未核定不得接受／服務未檢查產物。 |
| A1 預覽會話／綁定 | `preview_id_hash, project_id, principal_aid, artifact_id, snapshot_id, content_hash, state (issued／active／expired／revoked), token_used_at, expires_at, revoked_at, revocation_version`；cookie 僅含不可猜測的會話識別值，資料庫只存 verifier/hash，不存明文。簽發 `__Host-preview_session` 時設定 `Path=/; Secure; HttpOnly; SameSite=None; Partitioned` 且不設 `Domain`。hostname 只定位 origin，不作授權。所有請求均查伺服端會話與目前權限；TTL／撤銷上界依 PP-22／23，未核定不簽發。每次成功更新採 `generation` 比對，只能綁最新可接受工作，舊工作不得倒蓋新版本。 |
| 失敗與恢復 | 建置失敗不改已保存檔案、草稿或最後成功綁定；UI 可讀失敗原因、目標與目前可見版本。重試建立新工作（同操作冪等），審查仍鎖 submission 快照，不跟工作預覽漂移。 |
| 撤銷與清理 | 到期／關閉／解除教師權限／停用／刪除／審查結束等依契約撤銷會話與存取綁定；每個靜態與資料 API 請求逐次重驗，失效上界含邊緣快取、依 PP-23。TTL／撤銷上界未核定或無法保證即不簽發／不服務。銷毀建置沙箱**不會自動刪除平台已保存產物**，不得當撤銷。產物保留／孤兒清理期限待 D-10 核定；先拒絕存取，再按政策清理，不宣稱已載入內容可收回。 |

## 5. 審查、部署與公開狀態

### 5.1 `deploy_requests`（申請狀態機）〔已批准：FR-024、032〕

欄位：`id`、`project_id`、`snapshot_id`（必為 `kind='submission'`、`immutable`）、`content_hash`、`tier_at_submission`、`state`、`student_ack_version`、`student_ack_at`（發布前提示確認，**未確認不得寫入 `pending_review`**）、`pii_review jsonb`（審查清單各項結果：作品、檔案、圖像、文字、設定）、`reviewer_id`、`reason`（退回理由，限長）、`created_at`、`decided_at`。

```
not_submitted ──submit──▶ pending_review ──approve──▶ approved ──start──▶ deploying ──ok──▶ succeeded
                              │                                     │          └─fail/unknown─▶ failed
                              └──return──▶ returned ──(student edits → new snapshot → new request)
 pending_review/approved ──(account disabled/marked_deleted)──▶ suspended / invalidated
```

- `approved → deploying`：開始前比對 `snapshot.content_hash == request.content_hash`，不符即拒絕（Edge Case）。
- 提交前再檢：`account_gate(submit_for_review)`、`projects.tier`／`needs_visitor_identity`（B 級排除）、~~C 級的「公開 AI 控制關卡」旗標（§6.3）~~【已被取代・首版不適用（2026-10-21 範圍決定）；原文保留作歷史】、**作品含執行時 AI 呼叫的審查檢核（§5.5）**。
- **帳號停用**：`pending_review` 暫停處理（`suspended`，不刪除）；**標記刪除**：`pending_review`／`approved`（未部署）→ `invalidated`（FR-052(d)）。
- **學校核准撤回／失效**：新公開部署暫停（`deploying` 起點被閘門擋下）；**撤回期間待審與已批准未部署申請的處置〔待決 D-03〕**：資料模型把兩個選項都支援——選項 α 保持原狀態但 `start` 被擋；選項 β 轉 `suspended` 並於恢復後須重新核對。Plan 草案不選。

### 5.2 `deployments`、`public_listings`、`listing_holds`

| 表 | 重點欄位 | 備註 |
| --- | --- | --- |
| `deployments` | `id`、`request_id`、`snapshot_id`、`content_hash`、`runtime_kind`（`static`｜`restricted_server`；~~`controlled_ai`~~【已被取代・首版不適用（2026-10-21 範圍決定）；首版不建立此值；原文保留作歷史】）、`state`（`queued`｜`building`｜`uploading`｜`verifying`｜`succeeded`｜`failed`｜`unknown`）、`artifact_ref`、`started_at`、`finished_at` | `unknown`（逾時／結果不明）→ 進核對工作，**不顯示成功網址** |
| `public_listings` | `id`、`project_id`、`public_slug`（高熵隨機，不含暱稱／專案名；PD-10 建議）、`live_deployment_id NULL`、`page_state`（`live`｜`stopped`）、`page_stop_reason NULL`、`page_stopped_at`、~~`ai_state`（`n/a`｜`off`｜`on`｜`suspended`）、`ai_enabled_at NULL`~~【`ai_state`、`ai_enabled_at`：已被取代・首版不適用（2026-10-21 範圍決定）；**首版不建立**（首版所有公開作品皆不含作品執行時 AI；若為相容保留欄位則固定為 `n/a`，不得為 `on`）；原文保留作歷史】 | **一個作品同時只有一個公開入口**；部署成功才更新 `live_deployment_id`（FR-025／032）；失敗保留舊值 |
| `listing_stop_log` | `id`、`listing_id`、`axis`（`page`；~~`ai`~~【首版不建立】）、`reason`（見下表）、`actor_aid`、`at`、`policy_basis` | 追加式；稽核對應 |
| ~~`listing_ai_holds`~~【**首版不建立**；已被取代・首版不適用（2026-10-21 範圍決定）；原文保留作歷史】 | `id`、`listing_id`、`reason`、`created_at`、`released_at NULL`、`released_by_aid`、`release_basis` | **可釋放的 AI 暫停**（§5.3） |

**停止原因碼（page 軸）**：`student_withdrawn`、`staff_takedown`、`account_disabled`、`account_deleted`、`school_approval_withdrawn`、`school_approval_expired`、（~~`c_page_policy_stop`，僅當 D-01 選「停止」時使用~~【已被取代・首版不適用（2026-10-21 範圍決定）；首版不使用；原文保留作歷史】）。**原因分開標示**，畫面文字不得合併成一個「已停止」（UX 1.3）。

### 5.3 公開狀態模型（要求 1 的核心）

**【首版範圍決定（2026-10-21）】首版現行：公開狀態只有 `page` 軸**——所有公開作品皆為 A／B 級、皆不含作品執行時 AI，故下列 `ai` 軸、`listing_ai_holds`、`public_ai_allowed` 閘道與 D-01／D-02 的 C 級參數**首版不建立、不適用**（原文保留作歷史；D-01、D-02 不再阻擋 Plan 的 P5 或上線，保留為後續版本待決）。**學校核准撤回／失效**：該校**全部**公開作品 `live→stopped(school_approval_*)`（FR-047(d)；涵蓋 A 級與合格 B 級，含 β2 作品）；**恢復核准後不自動 live**，須重新審查與部署；解除校級阻擋不改動任何 `page_state`。下方兩軸模型與事件表為歷史原文：

將「是否提供頁面」與「是否提供公開 AI」拆成兩條軸，並把「解除校級阻擋」與「公開 C 級作品恢復訪客 AI」建模為**兩個不同事件**：

```
學校層（schools.approval_state）          解除校級阻擋 = withdrawn/expired → approved（管理員 restore，需文件版本）
   │ 只提供「學校是否具 AI／部署資格」          └─ 僅改變 account_gate 結果；不直接改任何 listing
   ▼
作品層（public_listings）
   page_state:  live ──stop(reason)──▶ stopped ──（新批准部署成功）──▶ live
   ai_state:    on  ──hold──▶ suspended ──release(條件)──▶ on
```

| 事件 | page 軸（頁面） | ai 軸（公開 AI） | 依據／狀態 |
| --- | --- | --- | --- |
| 學生撤回／教師管理員下架 | `live→stopped`（`student_withdrawn`／`staff_takedown`）；重新公開須新申請 | ~~AI 同時不可呼叫（因 page 停止，閘道比對 `live`）~~【首版不適用】 | 〔已批准〕FR-013、~~049(a)~~（首版 049 改寫，ai 軸不適用） |
| 帳號停用 | `live→stopped(account_disabled)`；**恢復不自動 live** | 同上 | 〔已批准〕FR-052 |
| 帳號標記刪除 | `live→stopped(account_deleted)`；之後清除 | 同上 | 〔已批准〕 |
| **學校核准撤回／失效**：非 AI（A、B、無 AI 的 C）作品【**2026-10-21 首版現行：涵蓋該校全部公開作品（A、合格 B 級；首版無 C 級、無含作品執行時 AI 者）**；歷史原文列舉「A、B、無 AI 的 C」】 | `live→stopped(school_approval_*)`；**恢復核准後不自動 live**，須重新審查與部署 | n/a | 〔已批准〕FR-047(d)、US 13 情境 9 |
| ~~**學校核准撤回／失效**：C 級公開 AI 作品 — **AI**~~【已被取代・首版不適用（2026-10-21 範圍決定）；原文保留作歷史】 | — | `on→suspended`（立即；新增 `listing_ai_holds(reason='school_approval')`） | 〔已批准〕FR-047(a)、049(a)（歷史） |
| ~~**學校核准撤回／失效**：C 級公開 AI 作品 — **頁面**~~【已被取代・首版不適用；D-01 不再阻擋 P5 或上線，保留為後續版本待決，本輪不要求選案；原文保留作歷史】 | **〔待決 D-01；兩案待教育者決定，核定時點＝P5 開工前（非 T0）〕** 由參數 `policy.c_page_during_school_withdrawal ∈ {keep_public, stop_public}` 決定；**Plan 不預設**；未設定＝fail-closed：C 級公開 AI 不得上線；**不阻擋 Plan 定稿，阻擋 P5 5c 開工與 C 級公開上線，Readiness Gate 標示「5c 範圍不就緒」**（歷史原文，首版不適用；該參數首版不建立） | — | 規格明示「不預設」（歷史） |
| **解除校級阻擋**（管理員 `restore` 並記錄文件版本） | **不改動任何 `page_state`**（已 `stopped` 者維持 stopped；**首版現行**） | ~~**不自動釋放 hold**：由參數 `policy.c_ai_after_school_restore ∈ {auto_release, require_rereview_redeploy}` 決定〔待決 D-02；教育者尚未決定，Plan 不預設 AI 恢復條件；核定時點＝P5 開工前，非 T0〕。`auto_release`：restore 交易內釋放 `school_approval` hold；`require_rereview_redeploy`：hold 保留，直到該作品有**新的、經審查批准且部署成功**的部署才釋放；未設定＝hold 保留（fail-closed）~~【ai 軸已被取代・首版不適用；D-02 不再阻擋、保留為後續版本待決；原文保留作歷史】 | 〔歷史〕規格明示「恢復僅解除校級阻擋，不等於 C 級 AI 自動恢復」 |
| ~~公開 C 級作品恢復訪客 AI 的其他條件~~【已被取代・首版不適用；原文保留作歷史】 | — | 無論 D-02 結果，`ai_state='on'` 還須同時滿足：作品仍 `live`、擁有者帳號 `approved`、學校 `approved`、無管理員停用（作品／全平台）、公開池與每作品上限有餘額、內容防護啟用（§6.3） | FR-049、050（歷史） |

~~**閘道每次請求即時評估**（不依賴排程或快取傳播）：`public_ai_allowed(listing) = listing.page_state='live' AND ai_state='on' AND no unreleased ai_holds AND owner_gate AND school_state='approved' AND NOT admin_kill(listing) AND NOT admin_kill(global) AND budget_available AND safety_enabled AND duty_gate('public_c_ai').open`（**〔後續決定，2026-10-21〕新增末項：公開 C 級 AI 須有管理員值守；見 §6.4**）。因此「AI 立即停止」不依賴部署平台的傳播延遲~~【**已被取代・首版不適用（2026-10-21 範圍決定）；首版不建立公開 AI 閘道，作品環境亦不提供 AI 途徑（§5.5）；原文保留作歷史**】；**頁面（首版現行）**：靜態資產的停止延遲由下架時限〔待決 D-08〕與公開託管選擇決定（research.md R-07）。

### 5.4 B 級資料服務與後續 β2 研究模型

**2026-10-21 最新 MVP 現行規則**：`projects.runtime_needs` 可記錄 `static／work_data_api／restricted_server` 作需求分類，但 MVP `deployments.runtime_kind` 只接受 `static／work_data_api`；`restricted_server` 回 `student_server_runtime_not_in_mvp`，不建立或啟用對應部署、runtime profile、runtime gate 或學生伺服器執行用量表。需訪客識別者仍回 `tier_b_needs_visitor_identity`。宣告不等於批准，Work Data API 不能執行學生程式，也不能存取平台其他資料。

**MVP 現行資料模型（D-23／B2）**：保留 `work_data_stores` 及平台資料服務所需的儲存／請求計量，MVP Work Data API 的資料大小、請求、限流與費用配額依 PP-26，未核定即拒絕。平台簽發的資料授權綁單一 `listing_id`、用途、短效 `expires_at`、`key_id` 與 `revocation_version`；平台私鑰留在平台伺服器端受保護設定，works-edge 只取得驗章公鑰，不得持有全域資料簽章 HMAC／私鑰。每次資料請求平台重新核對作品 live 狀態、授權、撤銷版本、配額與限流；更新失敗一律拒絕。金鑰輪替須可按 `key_id` 管理與緊急撤銷，輪替時間／重疊窗口待教育者核定；未核定不得啟用資料寫入授權。預覽以 A1 會話隔離暫存、結束清除；公開資料保存／清除與自由輸入內容審核規則仍待核定。works-edge 遭入侵且持有多個上線作品有效授權時仍可能觸及那些作品，不宣稱 B2 完全阻止跨作品濫用。§4.4 定義 X 的建置與產物綁定。

**下表與其後「發布資格」原文保留為歷史研究**：其中 `work_runtime_profiles`、`work_runtime_usage` 的學生程式執行欄位、`restricted_runtime_gate`、`runtime_kind='restricted_server'`、`b_restricted_runtime_pending` 以及「β2 為首版目標」均已被 D-23 取代，**MVP 不建立、不啟用**；後續獨立 β2 feature 另訂模型及 Gate。表中 Work Data API 的路徑可供參考，但其 HMAC 授權敘述已被 B2 取代，以本節現行規則為準。

| 表／欄位 | 說明 |
| --- | --- |
| `projects.runtime_needs`（`static`｜`work_data_api`｜`restricted_server`） | 作品在建置／審查時**宣告**的執行需求；`static` 與 `work_data_api`＝β1 範圍（靜態前端＋平台作品資料服務，不執行學生伺服器程式）；`restricted_server`＝β2 範圍。**宣告本身不代表已核准**；審查者須核對 |
| `work_runtime_profiles(listing_id PK, timeout_ms, memory_mb, egress_policy, storage_bytes, req_per_min, req_per_month, cost_cap_micro, profile_version, approved_by_aid, approved_at)` | 每作品的受限資源包絡（PP-19）。**所有數值欄位預設 NULL＝未核定＝fail-closed**：未設定的作品不得取得受限伺服器能力；`egress_policy` 預設全封鎖；此表**不持有、不引用**平台憑證 |
| `work_data_stores(listing_id PK, bytes_used, bytes_quota)` 與 `work_runtime_usage(listing_id, period_month, requests, cpu_ms, cost_micro)` | 作品資料服務與執行用量計量；**費用歸基礎設施池並受監測，不歸公開 AI 池**（FR-055(f)；公開 AI 池首版不建立，此處維持：β2 費用歸基礎設施池）；週期鍵由 `app.taipei_month()` 產生。**（2026-10-21 Plan 定點修正；〔規劃，尚未建立任何資料表〕）請求路徑與處理者**：作品資料由平台 `apps/web` 內部端點（`/internal/works/…/data/v1/*`，HMAC）經僅能存取作品資料表的受限 RPC 處理，works-edge 只轉送、無資料庫憑證（但持專用 HMAC 金鑰；外洩可能影響所有作品資料集，publishing 契約 §3.3、§3.5）；公開作品使用本列以 `listing_id` 為鍵的資料集；**預覽（尚無 listing）另用以 `preview_id` 為鍵的隔離暫存命名空間（第九輪：`preview_id` 為每個預覽會話各自的值，會話結束即清除，不跨會話保留），隨預覽結束／TTL 清除，不得讀寫公開資料集**；資料紀錄表結構、請求數配額（PP-19）與訪客自由輸入內容的保存／清除規則待 Tasks 展開、尚未核定 |
| `deployments.runtime_kind='restricted_server'` | 既有欄位值；部署管線僅在 `work_runtime_profiles` 已核定、`platform_flags.restricted_runtime_gate.verified=true`（S-13 通過且教育者核定）時才接受 |

**歷史發布資格（已被 D-23 取代；原文保留）**：~~`runtime_needs='restricted_server'` 且 gate 未通過或 profile 未核定→`b_restricted_runtime_pending`（顯示「尚在驗證、尚未開放」；不是排除、不是不符資格；記入範圍追蹤）。若 β2 無法交付，退回教育者決定。~~ **MVP 現行**：需學生伺服器程式者預覽與公開均回 `student_server_runtime_not_in_mvp`，0 件執行／部署；需訪客識別的公開 B 仍回 `tier_b_needs_visitor_identity`。作品資料僅依上述 B2 授權進入平台 Work Data API。

### 5.5 審查檢核：作品含執行時 AI 呼叫（FR-049 現行規則、FR-024；2026-10-21 範圍決定；〔規劃描述，尚未實作、尚未建立任何資料表〕）

首版學生作品不得以生成式 AI 作為執行時功能（私人預覽與公開部署皆然）。除「環境不提供途徑」（研究見 research.md R-05a、R-07 6a：不注入 AI 金鑰、無平台 AI 代理端點、出站不含生成式 AI 服務）外，審查須核對申請版是否含執行時 AI 呼叫，含者退回修改、不得部署。所需資料項（規劃；欄位名稱與型別為設計層級，待 Tasks／contracts 定義）：

| 資料項 | 說明 |
| --- | --- |
| `deploy_requests.ai_runtime_check jsonb`（規劃新增） | 審查檢核結果：`checklist_version`；`items`（固定碼逐項結果：無 AI 供應商金鑰樣式、無對生成式 AI 服務的呼叫或 SDK、無前端直接呼叫、無作品服務端 AI 呼叫、無經平台代理或第三方 AI 外掛的繞道）；`result`（`pass`｜`fail`｜`not_run`）；`scanned_content_hash`（必須等於該申請版 `snapshot.content_hash`，檢核對象為申請版快照，不是目前工作版本）；`fail_codes`（固定碼集合，**不含作品內容或原始碼片段**）；`reviewer_id`；`checked_at` |
| 狀態轉換約束 | `pending_review → approved` 須 `ai_runtime_check.result='pass'` 且 `scanned_content_hash == content_hash`；`not_run`、缺漏或雜湊不符一律不得 `approved`（fail-closed）；`fail` → 走既有 `return`，退回理由使用固定碼；`approved → deploying` 開始前沿用 `content_hash` 比對（§5.1）。檢核不取代人工審查，自動掃描為輔助，**不宣稱可完全偵測**，須搭配環境不提供途徑的雙重防線 |
| `deploy_requests.pii_review jsonb`（既有） | 審查清單項目可增列一項「作品不含執行時 AI 呼叫」的人工確認；是否合併於 `pii_review` 或維持獨立欄位，待 contracts 決定 |
| `work_runtime_profiles.egress_policy`（既有，§5.4） | 預設全封鎖；核定時須驗證**不含生成式 AI 服務網域**；未核定者 fail-closed（沿用 §5.4） |
| 發布資格 blocker | 規劃新增一個 blocker 碼（暫名 `runtime_ai_call_detected`；名稱與訊息待 contracts R-1 定義）：檢核 `fail` 時發布頁顯示「首版不支援作品自己呼叫 AI，請改為不依賴作品執行時 AI 的設計」（**學生端文案為草案，待教育者／專業審閱**）；**不是**排除 B 級，亦不改變 `tier` |
| 稽核 | `audit_events.action` 新增固定碼（暫名 `review_ai_runtime_check`）；`meta` 僅用既有白名單鍵（結果、版本號、失敗碼數量），**禁止作品內容、金鑰樣式命中的原文**（FR-052(e)、憲章 VI） |

**不建立**：作品執行時 AI 的用量表、訪客事件、公開 AI 限流或預算（§6.2、§8 已標示首版不適用）。後續若要加入學生 C 級作品，須另立功能與批准流程，不在本檔預留欄位或階段。

## 6. 內容安全、通知與~~公開 AI 控制~~【公開 AI 控制：已被取代・首版不適用（2026-10-21 範圍決定）；首版僅保留學生安全事件、通知與 AI 值守閘門；原文保留作歷史】

### 6.1 `safety_events`、`safety_notifications`、`school_handling_windows`〔已批准：FR-053；D-14 通道與升級規則已核定（2026-10-21）；**後續決定（2026-10-21）取代：不以轉交學校為必經步驟，`school_handling_windows` 由 §6.4 App 值守設定取代**；類別集合、文案審閱待決〕

> **後續決定取代說明**：本節下表與段落為第三輪原設計，**保留作歷史**並於各處標註「後續決定取代」；新設計見本節末「後續決定」與 §6.4。實作時以後續決定為準，不得實作 `school_handling_windows`。

| 表 | 欄位 | 說明 |
| --- | --- | --- |
| `safety_events` | `id`、`at`、`source`（`student`；~~`public_visitor`~~【訪客事件：已被取代・首版不適用（2026-10-21 範圍決定）；**首版不建立**，首版無公開訪客 AI，故無訪客輸入事件；原文保留作歷史】）、`category`（固定碼集合〔待決 D-14〕）、`severity`（`general`｜`high_risk`）、`subject_id NULL`（學生事件才有；~~**訪客事件必為 NULL**~~）、~~`listing_id NULL`（訪客事件）~~【訪客事件相關欄位：首版不建立；原文保留作歷史】、`school_id`（事件所屬學校：學生事件取學生所屬學校；~~訪客事件取作品擁有者所屬學校〔設計假設，待確認〕~~【首版不適用】；僅供處理時段計時，不是識別資料）、`conversation_id NULL`、`handling`（`open`｜`received`｜`forwarded`｜`closed`）、`handled_by NULL`、`handled_at NULL`、`attention`（集合：`escalated`｜`email_failed`｜`no_handling_window`｜`overdue_unacknowledged`；供管理員列表置頂與文字標示，**不是處理狀態**） | **不含輸入／輸出全文**；~~訪客事件僅 `作品、時間、類別、處理狀態`（FR-053(f)），無訪客識別、無綁定教師對象~~【FR-053(f) 訪客事件：已被取代・首版不適用（2026-10-21 範圍決定）；原文保留作歷史】。`conversation_id` 僅供有權者回到對話脈絡（教師本就可查看），不是複製內容。**〔後續決定取代〕**`school_id` **不再用於計時**（僅保留為事件脈絡）；`handling` 另記 `closed_at`、`outcome_code`（處理結果固定碼，集合待核定；不含內容）；`attention` 集合增加 `no_duty_config`（值守設定未核定／未設定，取代 `no_handling_window`）、`admin_backup_notified`、`carried_over`（跨值守時段承接）。原文保留作歷史 |
| `safety_notifications` | `id`、`event_id`、`recipient_id`、`assignment_kind`（`bound_teacher`｜`admin_no_receivable_teacher`｜~~`admin_visitor_event`~~【首版不建立】｜`admin_escalated`）、`state`（**僅站內**：`delivered`＝已出現在收件者站內待處理列表｜`received`｜`forwarded`｜`escalated`＝已被改派／升級給管理員、本列終結）、`delivered_at`、`received_at`、`forwarded_at`、`handling_clock_started_at NULL`、`escalated_at NULL`、`email_state`（`not_configured`｜`sent`｜`failed`）、`email_attempted_at NULL`、`email_failure_code NULL`（固定碼，不含內容） | 高風險學生求助 → 收件者＝「已綁定且可接收的教師」，無則管理員；**事件與站內通知於同一交易建立**（站內通知必達，不因電郵失敗回滾）；`forwarded` 代表「已聯絡學校處理」的記錄動作；**`email_state='sent'` 永不改變 `state` 或 `safety_events.handling`**（電郵送出≠已接收≠已轉交）；電郵失敗時寫 `email_state='failed'`、`attention += email_failed`，並出現在管理員列表；**畫面不對學生或訪客顯示處理時限承諾**。**取代先前的 `queued`／`failed`／`escalate_after` 設計**：電郵屬輔助通道，狀態與站內通知分開。**〔後續決定取代，2026-10-21〕**`assignment_kind` 增加 `admin_backup`（備援管理員被通知）；`state` 增加 `closed`；`forwarded` 改為**選用的外部聯絡紀錄**（非必經步驟，可略過直接 `closed`）；`handling_clock_started_at` 語意改為「首次進入值守時段而開始累計的時間點」（累計值見 `app.duty_elapsed`）。原文保留作歷史 |
| `school_handling_windows`〔**後續決定取代（2026-10-21）：不實作，改用 §6.4 `duty_settings`／`duty_roster`**；以下為第三輪原設計，保留作歷史；PP-05b；學校尚待提供，不編造〕 | `school_id PK`、`status`（`unset`｜`provided`）、`timezone`（預設 `Asia/Taipei`）、`windows`（每週時段集合；`provided` 時才有值）、`holidays`（日期集合）、`contact_window_label`（學校聯絡窗口的**標籤**，不存個人聯絡資料；實際聯絡方式由營運流程管理）、`version`、`updated_by_aid`、`updated_at` | 僅管理員可寫（稽核）。`unset`（預設）時：**不計時、不自動升級**，事件仍在站內列表並標示 `no_handling_window`〔fail-visible 預設，待教育者確認；替代案：未設定時直接指派管理員〕。開發與測試僅用合成時段 |

**升級規則（PP-05a，已核定；〔後續決定取代，2026-10-21〕計時改依 §6.4 App 值守時段，見本節末「後續決定」；以下為第三輪原文，保留作歷史）**：函式 `app.handling_elapsed(notification, now)` 只累計落在該校 `windows`（扣除 `holidays`）內的時間；通知建立時若在時段內即開始計時，否則於下一個時段開始時計時（`handling_clock_started_at`）。累計 **≥ 1 小時**且 `state='delivered'`（未確認）→ 排程工作建立 `admin_escalated` 通知給管理員、原列 `state='escalated'`、`attention += escalated`；確認＝收件者呼叫 `receive`。**原收件者已是管理員**而逾時：不改派他人，僅 `attention += overdue_unacknowledged`〔設計預設，教育者尚未決定是否另有第二層升級〕。排程失敗或遲到時，管理員列表以 `at` 與 `handling_elapsed` 即時計算顯示，不依賴排程才可見。

**「可接收的教師」定義〔工程假設，待確認 D-14〕**：綁定 `active`、教師 `approved`；無則改派管理員。站內列表永遠可達，故不再以「有可用通道」判定；電郵通道失敗不影響收件者資格。**通道不可用（電郵寄送失敗或未設定）時事件保持 `open` 並出現在管理中心待處理列表**（**不依賴單一通道**）。

**後續決定（2026-10-21；取代上列 `school_handling_windows` 與「該校 windows」計時；FR-053(g)）**

- **指派**：學生事件＝有效綁定且可接收的教師（工程假設：綁定 `active`、教師 `approved`；細則待核定）；無則 `admin_no_receivable_teacher`。~~訪客事件＝`admin_visitor_event`。~~【已被取代・首版不適用；原文保留作歷史；學生高風險事件仍由有效綁定教師（無則管理員）依 App 案件流程處理】站內列表顯著標示；電郵僅輔助，`email_state='sent'` 不改變 `state`／`handling`。
- **案件流程由 App 完成**：分派（`delivered`）→ 確認（`receive`）→ 處理 → 結案（`close`，記 `outcome_code`）；逾時升級與稽核皆在 App 內。**「通知／轉交學校」不是必經步驟**：`forward` 只記錄選用的外部聯絡（對象類別固定碼，不含個人聯絡資料與對話）。**不得以任何欄位或畫面宣稱緊急救援，或宣稱免除可能適用的法定通報**；法務與兒少保護專業審閱為上線關卡（非資料模型可解決）。
- **通知狀態機**（站內通知 `safety_notifications.state`；與電郵狀態、事件 `handling` 各自獨立，電郵永不推進狀態）：

```
建立（與事件同一交易）
   └─▶ delivered ──receive──▶ received ──close──▶ closed
          │                      └─forward（選用，可略過）─▶ forwarded ──close──▶ closed
          ├─ 值守累計 ≥ 1 小時仍為 delivered（原收件者非管理員）──▶ escalated（本列終結）
          │      └─ 同一交易建立 admin_escalated 通知（state=delivered，重新計時）
          └─ 值守累計 ≥ 1 小時仍為 delivered（原收件者已是管理員）──▶ 仍為 delivered；
                 attention += overdue_unacknowledged；建立 admin_backup 通知給名冊備援（須非原收件者）
                 └─ admin_backup 通知逾時：僅持續置頂標示，不再往上（最小方案，待核定）
```
- **計時**：`app.duty_elapsed(notification, now)`（取代 `app.handling_elapsed`）只累計落在**已核定的 `duty_settings.weekly_windows`（扣除 `holidays`）內**的時間；建立時不在值守時段者，於下一個值守時段開始才計；**跨值守時段保留已累計時間，不歸零**；累計 ≥ 1 小時（參數；待核定）且 `state='delivered'` 才觸發升級。已寫入 `escalated_at` 者不因設定版本變更而回溯改寫。排程失敗或遲到時，管理員列表以 `delivered_at` 與 `duty_elapsed` 即時計算顯示，不依賴排程才可見。**電郵狀態不啟動、暫停或重置計時。**
- **未設定值守**：不再是「不計時、不升級」；而是 §6.4 閘門關閉，學生 AI ~~與公開 C 級 AI~~【公開 C 級 AI：首版不適用】的新增請求被拒。**已存在的未結案件**仍可見，且以 `attention += no_duty_config` 提示管理員。
- **邊界情境**（原收件者已是管理員、電郵失敗、值守交接、時段結束時在途請求、~~訪客事件逾時~~【首版不適用】）的最小可驗收方案與待核定處：見 decision-register.md D-14「邊界情境與最小可驗收方案」；**為 AI 草擬提案，非已批准政策**。

### 6.2 ~~公開 AI 與預算相關~~【已被取代・首版不適用（2026-10-21 範圍決定）；**首版不建立** `public_ai_settings`、每作品／每訪客限流與 `public_ai_global_disabled`；學生平台 AI 的預算見 §8；原文保留作歷史】
見 §8；**【歷史原文】**公開 AI 設定：`public_ai_settings(listing_id PK, per_work_cap_micro, per_visitor_rate, per_work_rate, admin_disabled bool, disabled_by_aid, disabled_at)`；全平台開關：`platform_flags(key PK, value jsonb, updated_by_aid, updated_at)`（`public_ai_global_disabled` 等）。數值〔待決 D-11／D-13〕。

### 6.3 ~~「C 級公開 AI 控制關卡」旗標~~【已被取代・首版不適用（2026-10-21 範圍決定）；**首版不建立** `platform_flags.public_ai_gate`；原文保留作歷史；後續若另立功能加入學生 C 級作品須重新設計】
**【歷史原文】**`platform_flags.public_ai_gate = {authorization, rate_limit, budget, isolation, content_safety, kill_switch, key_scan}`：七項控制全部 `verified=true`（附驗證紀錄引用）且教育者批准階段後，`public_listings.ai_state` 才可設為 `on`；否則發布頁顯示「公開 AI 尚未開放」，**不得出現「C 級已完整 Launch」**（FR-049、US 14 情境 4）。~~**〔後續決定，2026-10-21〕七項控制的定義與數量不變；公開 AI 另有一個獨立前提——§6.4 的值守閘門（`public_c_ai`）：非值守時段或值守設定未核定時，**不改變 `ai_state`**，僅讓新增請求被拒。**~~【已被取代・首版不適用：`public_c_ai` 閘門範圍首版不建立，見 §6.4】

### 6.4 App 值守設定與 AI 值守閘門〔D-14 後續決定（2026-10-21）；PP-05b；FR-053(g)、~~FR-049(g)~~【FR-049(g) 公開 C 級值守：首版不適用；學生 AI 值守保留】；**實際時段、假日、交接與備援名單尚未核定，Plan 不編造任何數值**〕

| 表 | 欄位 | 說明 |
| --- | --- | --- |
| `duty_settings` | 單列（全平台）：`status`（`unset`｜`drafted`｜`educator_approved`）、`timezone`（預設 `Asia/Taipei`〔待核定〕）、`weekly_windows`（每週值守時段集合；`unset` 時為空）、`holidays`（日期集合）、`handover_rule`（交接規則的固定碼，內容待核定）、`version`、`approved_ref`（教育者核定紀錄的引用，不含個人資料）、`approved_at`、`updated_by_aid`、`updated_at` | 僅管理員可寫並留稽核；**`status≠educator_approved` ＝ AI 閘門關閉**。`approved_ref` 只登錄「教育者已核定」這個事實，**系統與 Plan 不代替教育者核定**。開發與測試僅用合成時段 |
| `duty_roster` | `id`、`settings_version`、`window_ref`、`role`（`primary`｜`backup`）、`admin_aid`（有效且已核准的管理員內部代號）、`effective_from`、`effective_to NULL`、`updated_by_aid`、`updated_at` | **不存姓名與聯絡方式**；人員被停用或撤銷核准時該列**即時**視為無效；每次變更寫稽核（FR-043）；教師是否可列名冊〔待核定〕 |

**閘門函式**：`app.duty_gate(scope, now)` → `{ open bool, reason_code }`；`scope ∈ { student_ai }`（~~`public_c_ai`~~【首版不適用；原文保留作歷史】）；`STABLE SECURITY DEFINER`，**即時查詢、不依賴排程**；錯誤或缺資料一律 `open=false`。`reason_code`（固定碼）：`duty_unset`｜`duty_not_approved`｜`off_duty`｜`no_primary`｜`no_backup`｜~~`no_admin_on_duty`~~【僅為已被取代的 `public_c_ai` 範圍所用，首版不使用；保留作歷史】｜`open`。
- `student_ai` ＝ `status='educator_approved'` ∧ `now` 落在 `weekly_windows` 且非 `holidays` ∧ 該時段 `roster` 有有效的 `primary` 與 `backup`（為不同管理員）。
- ~~`public_c_ai` ＝ 同上 ∧ 至少一位有效管理員於該時段值守（是否另要求備援管理員〔待核定〕）。~~【已被取代・首版不適用（2026-10-21 範圍決定）；原文保留作歷史；公開 C 級 AI 在首版所需的管理員值守已移除】
- 「值守」＝名冊指派，**不是即時在線證明**；是否另須上線簽到〔`policy.duty_requires_checkin`，待核定，Plan 不預設〕。

**套用位置**：`ai_call`（對話、圖像、網頁搜尋、Coding Agent）在 §2.1 的學校閘門通過後**另**檢查 `duty_gate('student_ai')`；~~公開 AI 閘道的 `public_ai_allowed` 加入 `duty_gate('public_c_ai')`（§5.3、contracts/publishing-and-public-runtime.md X-1）~~【首版不適用】。閘門在**預留額度與呼叫分類器／模型之前**判斷，被擋者不扣額度、不呼叫模型；**登入、已保存內容、非 AI 功能與公開頁面不受影響**；**不寫入 `page_state`、`ai_state`**（此二者屬學校核准與 D-01／D-02 的範圍，不得混用）。教師與管理員自己的 AI 使用、~~管理員測試公開作品 AI~~【首版不適用】是否受此閘門限制，見 decision-register.md D-14「共同前提」（Plan 提案：沿用學生對象；管理員測試受限；**待核定**）。

**在途請求（最小方案，待核定）**：已通過閘門者允許跑完，之後不得開新回合；Agent／背景工作於下一個重要步驟重新檢查；排隊請求出隊時重新判斷，被擋者標 `paused_off_duty`（`jobs.state` 的新值；全額釋放預留、不自動續跑）。詳見 D-14 邊界情境第 4 列。

## 7. 複查、個資請求（兩者分開）

| 表 | 重點欄位 | 備註 |
| --- | --- | --- |
| `review_requests` | `id`、`kind`（`account_review`｜`work_review`）、`disposition_id`（對應處置事件：拒絕事件、停用事件、退回／下架事件的 id）、`target_account_id NULL`、`target_version_id NULL`、`requester_id`、`requester_basis`（`self_rejected`｜`initiating_teacher`｜`frozen_bound_teacher`｜`student_owner`）、`reason text`（長度上限〔PP-13〕）、`status`（`open`｜`replied`）、`handler_id`、`reply text`、`created_at`、`replied_at` | `UNIQUE (kind, disposition_id) WHERE status='open'` 落實「每次處置至多一件未結申請」；狀態值集合為建議（PD-04：待處理／已回覆）；處理時限、保存期限〔待決 D-10〕 |
| `privacy_requests` | `id`、`request_type`（`access`｜`correct`｜`delete`）、`channel`（`school_channel`｜`bound_teacher`｜`admin_center`）、`requester_kind`（`student`｜`teacher`｜`cannot_login`）、`subject_account_id NULL`、`requester_check`（固定碼）、`authority_check`（固定碼）、`school_confirmed_action`（固定碼，如 `none_yet`｜`delete_account`｜`other`）、`reply`、`state`、`recorded_by_aid`、時間 | **僅存處理所需最少資訊**；提出請求**不觸發任何刪除**（只有管理員另啟 `account_delete` 流程）；與 `review_requests` 不共用表、不共用入口；處理／保存期限、代提入口位置、帳號以外資料項目〔待決 D-15〕 |

**受限寫入授權（FR-054(e)）**：以 RPC `app.submit_review_request()` 為唯一寫入口；RLS 禁止直接 `INSERT`。函式逐次檢查 §2.3 資格＋對象狀態＋未結唯一性＋長度，並寫稽核；限速使用 `rate_limit` 通用桶（每帳號、每處置）〔PP-13〕。被拒絕或停用的帳號沒有受保護能力，只能呼叫此 RPC 與「讀取自己的申請」檢視。

## 8. 用量、預算池與計量〔已批准分池；數量待決 D-11、D-12〕

### 8.1 表

| 表 | 重點欄位 | 備註 |
| --- | --- | --- |
| `budget_pools` | `key`（`internal_ai`＝學生／教師創作池；~~`public_ai`＝公開 C 級池~~【已被取代・首版不適用（2026-10-21 範圍決定）；**首版不建立** `public_ai` 池列，原規劃 US$150 為「原規劃、首版不動用」，不自動轉入 `internal_ai` 或基礎設施池；原文保留作歷史】）、`label` | **基礎設施池不是閘門池**（只估算與監測，不阻擋；其達規劃值的處置〔待決 D-12〕**未決，無預設處置**，候選方案見 decision-register.md D-12）；不建立對應的扣款表，避免誤用為硬上限 |
| `pool_limits` | `pool`、`period_month`、`limit_micro`、`updated_by_aid`、`updated_at` | 月度上限；每月 1 日 00:00 Asia/Taipei 換新期（以 `period_month` 鍵，不需排程重置） |
| `quota_policies` | `scope`（`student_default`｜`teacher_default`｜`admin_test`；~~`per_work_cap`~~【每作品 AI 上限：已被取代・首版不適用；首版不建立；原文保留作歷史】）、`period`、`limit_micro`、`rate_per_min`、`max_concurrent` | 所有數值〔待決 D-11〕；個別覆寫表 `quota_overrides(user_id, scope, limit_micro, expires_at NULL)` |
| `quota_adjustments` | `id`、`scope`、`target_ref`、`old_value`、`new_value`、`reason text NOT NULL`、`actor_aid`、`at` | 每次調整一列（FR-055(b)）；**新值只影響之後的預留** |
| `usage_totals` | `(pool, period_key)` PK、`reserved_micro`、`settled_micro`；另 `(subject_id, period_day)` 的個人日總計與 ~~`(listing_id, period_month)` 的作品月總計~~【公開作品 AI 月總計：首版不建立；原文保留作歷史】 | 預留以單列 `UPDATE … WHERE reserved+settled+:amount <= limit RETURNING` 原子完成，避免競態 |
| `usage_reservations` | `id`、`idempotency_key UNIQUE`、`pool`、`purpose`（`learner_feature`｜`admin_internal_test`；~~`admin_public_work_test`｜`public_visitor`~~【公開作品 AI 測試與訪客用途：已被取代・首版不適用（2026-10-21 範圍決定）；首版不建立，`listing_id` 欄位亦不使用；原文保留作歷史】）、`subject_id NULL`、`listing_id NULL`、`est_micro`、`settled_micro NULL`、`state`（`reserved`｜`settled`｜`released`｜`unknown`）、`provider`、`provider_request_id NULL`、`model`、`created_at`、`settled_at` | **`purpose` 無對應者一律拒絕（fail-closed）**：管理員的「其他非功能測試付費 AI 操作」歸池〔待決 D-12〕，Plan 草案不預設歸入任何池 |
| `model_prices` | `model`、`effective_from`、`input_micro_per_mtok`、`cached_input_micro_per_mtok`、`output_micro_per_mtok`、`image_micro_per_unit`、`source_url`、`verified_on` | 價格表為資料，不寫死在程式；來源必須有查證日期 |

### 8.2 預留 → 執行 → 結算 → 釋放（FR-042）

1. **預留**：以保守上限估算（輸入 tokens＋`max_output_tokens`×單價）；在同一交易內同時檢查：個人日額度（學生／管理員測試額度）、對應預算池月度、~~（公開）每作品月度上限~~【首版不適用】；任一不足 → 拒絕並回傳**原因碼**（個人日額度／創作池月度／~~公開池月度／作品上限~~【首版不適用】／管理員測試額度），學生端文字區分三種原因（UX 12.1）。
2. **執行**：呼叫供應商時帶 `idempotency_key`（對應 `usage_reservations.idempotency_key`）；客戶端重試以同一鍵 → 回傳既有結果，不重複扣額。
3. **結算**：以供應商回傳的實際 usage 計價；差額釋放。
4. **釋放**：失敗、取消、被閘門擋下 → 全額釋放；
5. **結果不明**（逾時、連線中斷、Worker 逾期）→ `unknown`：保持預留（不超額）並排入核對工作，以供應商 Usage／Costs 資料或請求紀錄核對後轉 `settled` 或 `released`；**不直接全額退款**。
6. **管理員調整**：只影響調整後新建立的預留；進行中的預留與結算不被追溯改寫（Edge Case）。

## 9. 帳號生命週期與清除〔已批准：FR-052；天數待決 D-09、D-10〕

### 9.1 狀態

```
pending ─approve─▶ approved ─disable─▶ disabled ─restore(明確確認)─▶ approved
   │                  │                   │
   └──reject──▶ rejected                   └─ mark_delete(二次確認) ─▶ [deletion_state=marked] ─▶ purging ─▶ purged
                      └─ mark_delete(二次確認) ──────────────────────────┘                          └─▶ purge_failed ─retry─▶ purging
```

`deletion_state ≥ marked` 時，`account_gate` 對一切能力回 `deny`（包含 `login`），**即使清除失敗仍維持不可存取**（FR-052(d)）。

### 9.2 二次確認與明確確認（資料層證據）

| 表 | 欄位 | 說明 |
| --- | --- | --- |
| `destructive_confirmations` | `id`、`action`（`restore`｜`mark_delete`）、`subject_id`、`actor_id`、`impact_snapshot jsonb`（影響摘要：公開作品數、待審數、已批准未部署數、綁定數…）、`impact_hash`、`step1_at`、`step2_at NULL`、`expires_at` | `restore`：`step1`（顯示摘要並明確確認）即完成；`mark_delete`：必須 `step2_at` 非空且 `impact_hash` 與當下重算相同（影響範圍變動需重新確認），才可呼叫 `app.mark_delete()`。確認的具體 UI 形式屬 UX 設計（未批准），本表只保證「兩步皆已記錄」 |

### 9.3 排程清除工作（`purge_jobs`）

`id`、`subject_aid`、`state`（`queued`｜`running`｜`done`｜`failed`）、`steps jsonb`（每步：`pending`｜`done`｜`failed` 與錯誤碼）、`attempts`、`started_at timestamptz NULL`、`finished_at timestamptz NULL`。尚未實際開始時 `started_at` 為 null；開始後記錄首次開始時間。未終結時 `finished_at` 為 null，`done`／`failed` 終態時非 null。步驟：（1）撤銷 Auth 工作階段並 `ban`、（2）停止並取消該帳號 Worker 工作、（3）公開作品下架（若尚未）、（4）刪除擁有的資源列（對話、訊息、附件、專案、快照、blobs 引用、申請、複查、個資請求中的個人欄位…）、（5）刪除 Storage 物件、（6）刪除 Vercel／公開託管中的對應部署與網域、（7）`auth.admin.deleteUser`、（8）**刪除 `audit_identity_map` 對照**、（9）寫入 `deletion_tombstones`。每步冪等，失敗可重試；`purge_failed` 保持帳號不可存取。

### 9.4 備份與還原

| 項目 | 設計（〔技術決定〕；天數〔待決 D-10〕） |
| --- | --- |
| 備份來源 | 只使用 Supabase 平台備份（Pro：每日備份保留 7 天；PITR 為付費加購；**備份不含 Storage 物件本身**，R-02）。**首版不建立自管匯出或額外備份**——若日後要建立，須先納入同一清除窗口並回報教育者 |
| 備份清除 | 以備份自然輪替為「備份清除」機制：備份清除天數 ≈ 供應商備份保留天數（以官方文件為準，目前記載 7 天；若加購 PITR 則依其保留天數）；官方**未提供選擇性清除單一使用者備份資料**的機制（R-02），因此**不得承諾提前從備份移除** |
| 還原時重新套用刪除 | `deletion_tombstones(subject_id uuid PK, purged_at)`：清除完成時寫入；**保存天數 ≥ 備份保留窗口＋緩衝**〔PP-11〕後清除；任何資料庫還原／PITR 後，**必須先執行「重新套用刪除」腳本**（依 tombstone 重新清除）才可重新開放登入。tombstone 為隨機 uuid，無對照可回到人，但仍屬假名資料，**不稱匿名** |
| Storage | Storage 物件不在供應商備份中；刪除即實際刪除（受供應商內部實作限制，**官方未說明刪除後的實體清除時程**，列為上線前待查證） |

## 10. 保存期限參數（全部為待核定；程式以設定值處理，**不得預設永久保存，也不得自行填成正式政策**）

| 參數 | 對應 | 本 Plan 的「建議值」（僅供教育者決定；非政策） |
| --- | --- | --- |
| PP-09 停用帳號檢視頻率 | D-09 | 每學期結束與每月例行檢視（建議） |
| PP-10 停用帳號最長保留 | D-09 | 建議以「學校結案或 12 個月，取先到者」提交教育者（建議） |
| PP-11 主資料清除天數／tombstone 保存 | D-10 | 主資料 ≤30 天（沿用 PD-04 建議，未批准）；tombstone＝備份窗口＋7 天 |
| PP-14 停用時綁定快照保存 | D-09 | 隨停用事件；於帳號恢復、刪除清除，或停用最長保留屆滿時刪除（建議） |
| PP-15 稽核事件保存 | D-10 | 1 年（PD-03 建議，未批准） |
| PP-16 安全事件／複查／個資請求保存 | D-10、D-14、D-15 | 各自待核定；建議與稽核同一期限以簡化（待核定） |
| PP-07 登入節流桶保存 | — | 24 小時（工程值） |

## 11. 修訂紀錄（本次同步）

| 日期 | 變更 | 內容 | 狀態 |
| --- | --- | --- | --- |
| 2026-10-23 | D-06 (a)／M1、`error`→`failed`、事件保存重放責任、UTC 同步 | 新增 §1.3a 教師—學校有效歸屬（M1，候選表 `teacher_school_memberships`；僅模型與規則）；§1.3 `school_id` 對教師不作歸屬依據；§2.1 註以 D-06 (a) 取代待決參數；§2.2 學校 `unconfirmed` 對教師查看學生資料拒絕；§3 補 `messages.state`（`error`→`failed`）與事件保存／重放責任。時間欄位 wire 規則見 COMMON（大寫 Z）。**未建立資料表／migration／RLS／端點**。 | 文件已同步；**未實作資料層、未驗證；不是 migration** |
| 2026-10-22 | D-25～D-30 文件同步 | conversation 欄位補既有 H-3 要求的 `row_version int`，明示版本控制範圍與 file hash 區分；標記內部 `jobs` 與對外 Job DTO 分層；明示 purge 時間欄位 null 關係。未建立資料表／migration，D-14 `paused_off_duty` 仍待決。 | 文件已同步；未實作／未驗證 |
| 2026-10-21 | **首版範圍決定後續殘留逐點核對（第六輪；僅文件）** | 逐點核對 `public_ai_allowed`（§5.3：已刪除線＋標示被取代，首版不建立公開 AI 閘道）與 `duty_gate('public_c_ai')`（§6.4：scope 僅 `student_ai`；`public_c_ai` 條目與「套用位置」引用已刪除線；§6.3 內文殘留的 `public_c_ai` 句改刪除線；`reason_code` `no_admin_on_duty` 標示僅屬被取代範圍、首版不使用）；**未新增或移除任何欄位、表或編號，未建立任何資料表** | 文件已修訂；**未實作、未驗證；不是 migration** |
| 2026-10-21 | **首版範圍決定同步：學生作品限 A／B 級；公開 C 級 AI 實體與欄位首版不建立** | 依 spec.md Clarifications「Session 2026-10-21（首版範圍決定…）」與 FR-049：（1）檔頭新增同步說明；（2）§4.1 `projects.tier` 僅 `A`｜`B`（C 保留歷史註記）；（3）§5.1 提交前再檢改為審查檢核（§5.5），移除 C 級控制關卡旗標；（4）§5.2 `runtime_kind='controlled_ai'`、`public_listings.ai_state／ai_enabled_at`、`listing_ai_holds`、`listing_stop_log.axis='ai'`、`c_page_policy_stop` 標示首版不建立；（5）§5.3 首版現行只有 page 軸，學校核准撤回／失效涵蓋該校全部公開作品，C 級 AI／頁面列與 D-01、D-02 參數、`public_ai_allowed` 標示已被取代；（6）新增 §5.5 審查檢核「作品含執行時 AI 呼叫」所需資料項（規劃描述）；（7）§6 的 `public_visitor` 訪客事件、`admin_visitor_event`、§6.2 `public_ai_settings`、§6.3 `public_ai_gate`、§6.4 `public_c_ai` 值守閘門標示首版不適用，學生 AI 值守保留；（8）§8 `budget_pools.public_ai`、`per_work_cap`、作品月總計、`admin_public_work_test`／`public_visitor` 用途與公開池／作品上限原因碼標示首版不建立；（9）§1.4 補稽核同步說明。**保留既有章節編號與原文歷史，未新增任何價格或數值；未建立任何資料表**；Plan 仍待教育者審閱 | 文件已修訂；**未實作、未驗證；不是 migration** |
