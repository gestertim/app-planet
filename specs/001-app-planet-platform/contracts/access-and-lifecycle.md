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

| # | 端點 | 授權 | 輸入 | 回應／行為 | 錯誤 | 冪等／稽核 |
| --- | --- | --- | --- | --- | --- | --- |
| T-1 | `POST /api/v1/admin/bindings` | 管理員 | `{ teacher_id, student_id }` | `201`；學生端提示同步更新（不需重新整理；以 Realtime 或下次請求回傳 `teacher_notice`） | `409`（已存在）；`409 student_not_approved`（學生停用／刪除中不可綁定，〔工程假設〕） | `Idempotency-Key`；稽核 |
| T-2 | `DELETE /api/v1/admin/bindings/{id}` | 管理員 | `{ end_reason }` | `200`；**教師新的存取立即失效** | `404` | 稽核 |
| T-3 | `GET /api/v1/teacher/students` | 教師 | — | **僅**回傳已綁定且允許的學生；**停用當時已綁定且帳號仍停用**者以 `{ id, display_label, frozen: true }` 出現（不含任何專案資料），其餘學生不出現 | — | — |
| T-4 | `GET /api/v1/teacher/students/{id}/projects｜conversations｜files｜activity` | 教師＋`teacher_can_view_student` | 分頁參數 | 資料；每次開啟寫 `audit_events(action='teacher_view')`（PP-12 合併窗口；**不含內容**） | **無權限一律 `404`**（不洩漏學生是否存在）；停用凍結→`403 view_frozen`（僅對停用當時已綁定教師顯示凍結說明） | 稽核 |
| T-5 | `GET /api/v1/admin/audit/teacher-views?student_id&teacher_id` | 管理員 | 篩選 | 教師、學生代號（內部 id 顯示為 display_label）、時間；**不含對話全文** | — | — |

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
