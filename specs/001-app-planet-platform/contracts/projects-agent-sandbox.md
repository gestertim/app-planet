# 契約：專案、快照、Agent、沙箱與工作佇列

**對應**：FR-009～012、021、023、025、026、038、040、041（**另 FR-049 現行規則：作品不得呼叫生成式 AI**）｜**研究**：[../research.md](../research.md) R-05、R-06、R-13｜**資料模型**：[../data-model.md](../data-model.md) §4｜通則見 [README.md](./README.md)

> **同步註記（2026-10-21 首版範圍決定）**：首版學生作品等級僅 **A／B**；作品本身不得以生成式 AI 作為執行時功能。Agent 不得為作品加入 AI 金鑰、前端直接呼叫或服務端 AI 呼叫（見 §3 新增「作品不得呼叫生成式 AI」）；私人預覽沙箱**不提供**生成式 AI 途徑（§5 不變式）。平台 AI 對話與 Coding Agent（G-1）仍可使用，沿用學校核准、額度、內容安全與值守閘門。本契約為設計層級，尚未實作、未驗證。

## 1. 專案、階段與快照

### 本人已保存專案 JSON 下載（2026-11-05；T025 驗收子項）

`GET /api/v1/projects/{id}/export` 是使用者主動下載，不是 snapshot、Final Pack、部署包、批准證明或可還原備份。學生工作區共用 layout 提供「下載已保存資料」按鈕；不支援匯入或恢復，不因 SSR／hydration／Next prefetch 發出下載。

每次經可信 Auth `/auth/v1/user`，僅 DB 當下本人有效 student 且 `download_own_results` 成立可讀；teacher／admin 不得代下載，非本人／不存在（含有效 teacher／admin）404。未登入 401，學生待審／被拒／停用／刪除中、school unconfirmed 403；approved／withdrawn／expired 依現行能力可下載本人已保存內容，不因此放行 AI、公開或部署。0039 窄 `NOLOGIN`／`NOINHERIT`／`NOBYPASSRLS` reader 只取得必要欄位；authenticated 只可 EXECUTE，不擴充 owner RLS 或通用 SELECT／writer。

reader 使用 READ COMMITTED READ WRITE 交易**僅取得鎖、不改資料**，以 profile→school→project `FOR SHARE` 保護資格及 owner；`UPDATE(id)` 列鎖必要權限配 `WITH CHECK(false)`，不能修改任何列。等鎖後重驗 `download_own_results`；VOLATILE 函式內一個新 statement snapshot 同時投影全部資源與確認有效性。這不是跨 reader 拼裝，`read_at` 是鎖後該 statement 中 DB `clock_timestamp()` 的 UTC 時間，不宣稱 HTTP 抵達時或裝置保存時仍有資格；不承諾收回已傳至裝置的資料。

成功 200 `application/json; charset=utf-8`、固定 `Content-Disposition: attachment; filename="app-planet-saved-project.json"`（不含 title）、實際 UTF-8 bytes 的 Content-Length、`Cache-Control: no-store`、`X-Content-Type-Options: nosniff`、`Referrer-Policy: no-referrer` 與共用 request ID。失敗沿 COMMON `application/problem+json`，無 attachment；Auth／DB／decoder 故障 503 `dependency_unavailable`，不交付部分資料或成功空內容。

strict 格式由 `packages/core/contracts/project-export.ts` 定義，未知欄位一律拒絕：

| 欄位 | 本輪投影 |
| --- | --- |
| `format_version` | 固定 `app-planet.saved-project.v1` |
| `project` | 目前 `{id,title,stage,row_version}` |
| `requirements` | 目前正式保存 `{revision,content:{description,runtime_needs,runtime_ai_required}}`；沒有保存為 null |
| `classification` | 沿公開欄位 `classification_state,requested_tier,tier,needs_visitor_identity,confirmation`；confirmation 僅 `{id,requirements_revision,confirmed_at,source}` 或 null。`confirmation_validity` 為 `not_confirmed/valid/stale/legacy_unverified`，以同 statement 的精確內容／revision／owner／偏好證據判定 |
| `stages` | 九階段固定順序完整列出 `{stage,draft,confirmation}`。draft 為 `{row_version,state,content_source,content:{text}}` 或 null。每階段只保留最新學生確認的 `{row_version,confirmed_at,source,current}` 摘要或 null；current 依同 statement 的版本＋原文 hash，不輸出 hash、confirmed_by 或完整歷史 |
| `tasks` | 已保存的完整公開 `{id,project_id,order,title,done,row_version}`，依 order／id 排序；無保存為 []，不以手動匯入上限截斷既有任務 |
| `read_at,saved_data_notice` | DB UTC 讀取時間＋固定繁中「本檔只包含已保存資料」及用途限制 |

不包含 Auth／profile／school 私有資料、email／credential／receipt／冪等鍵、audit_identity_map／原始 audit／教師私人資料／完整歷史、聊天／附件／Agent Job／未保存輸入／原始碼或不存在產物。JSON 保留繁中、emoji、引號與 HTML-like 原文；不直接 `to_jsonb` 整列公開。

工程保護界線為 **8 MiB**，不是新產品配額：DB 在同 statement 先以 JSON escaped title／需求／草稿 bytes＋每草稿 2048、每任務 512、固定 4096 bytes 的保守組裝預算檢查，再聚合完整 JSON；HTTP／client 亦驗證實際 UTF-8 bytes。任何界線超限明確 413 `saved_export_too_large`，無截斷、漏任務／階段或省略本文；保守估算可能在實際檔案小於 8 MiB 時拒絕。已有各寫入端傳輸限制不變，超限 DB 測試僅使用隔離 fixture 插入不可變新 revision，不冒稱正常產品可寫入超限本文。

按鈕不導航或觸發離開；沿共用 guard 登錄辨識未保存／保存中／未知操作，提示只含讀取時已提交資料，既有編輯與原鍵操作全部保留，不自動保存／清除。fetch 成功、媒體型別、安全檔名、strict 格式及 project ID 皆符合後才建立 Blob／object URL，使用後釋放；卸載／舊頁請求取消，失敗留在頁面可重試。不經 localStorage／sessionStorage 保存匯出本文，不建立伺服器暫存檔、Storage 物件、公開 URL、Job、額外備份或匯出保存庫。FR-043／FR-014 的教師查看稽核不等同本人下載；本輪正式規則未要求本人下載新增稽核，reader 不寫 receipt／audit。

本輪僅 T025「下載自有成果」及 T011／T014／T015 必要 HTTP／授權／測試與工作區接線；原依賴、Q-SCHOOL／Q-DATA／Q-AUTH、136 項任務與 Gate／正式啟用均不變。實測、首次失敗及限制見 [readiness §104](../readiness-review.md#104-2026-11-05-t025-本人已保存專案資料下載有界實作)。

### P-2 本人學生重新命名（2026-11-05 有界子集）

`PATCH /api/v1/projects/{id}` 只接受 strict `{ title: string }`，沿用 P-1 正式名稱驗證及 DB constraint；原文保存，不 trim 或 Unicode 正規化，不接受 stage／tier／owner／school／row_version／批准或其他欄位。只允許當下本人學生；非本人／不存在（含 teacher／admin 對學生專案）隱匿為 404。每次經固定可信 Auth `/auth/v1/user`，DB 在鎖前及鎖等待後重驗主體、student、帳號 gate 與 owner；不以 receipt 當授權。

單一 strong canonical `If-Match` 沿 COMMON；缺失／非法各為 400 `if_match_required`／`invalid_if_match`。新操作原子 CAS 並令 row_version +1；舊版 409 `version_conflict`，僅投影 `conflict: { current: { version, content: { title } }, submitted: { version, content: { title } } }`。成功 200 `{ outcome: "saved"|"replayed", operation: { id, title, row_version }, current: { id, title, row_version } }`；ETag 只描述 current，operation 為原 receipt，不可倒蓋目前名稱。

本子集要求 UUID `Idempotency-Key`，主體＋`project_title_patch_v1`＋鍵隔離，完整意圖含專案、原文 title、原 If-Match；同鍵異意圖 422 `idempotency_key_reuse`。DB 異動與非秘密成功 receipt 同交易，沿既有 24 小時保存政策，不新增 TTL。原意圖重送先重新授權；有效同鍵同意圖只回原結果，不遞增版本。結果未知或 reload 後只可以原鍵／原本文／原版本加 `Idempotency-Replay-Only: true` 重試；此模式缺少／過期 receipt 回既有 `operation_outcome_unrecoverable`，絕不重新寫入或盲目換鍵。標頭只接受缺省或單一 `true`。沒有可信 receipt，不以目前名稱相同推定原交易成功。

改名不是需求修改、分類確認、學生確認或批准；正式分類證據依既有精確需求／revision／分類欄位，Specification 依草稿版本／需求 revision／分類 ID 及授權世代判定。title／project row_version 不在這些失效條件內，故本次只更新 title／row_version；不推進 stage、不改 receipt、草稿、任務或不可變提交／審查歷史。

學生工作區共用既有離開防護，提供明確保存／取消、雙方名稱衝突比對與再次保存或重新讀取；未知操作沿帳號／專案隔離 sessionStorage 保留原意圖，不增加持久本地草稿。未 hydration 前入口 disabled，無原生表單 POST；輸入競態、卸載／重入世代與紀錄所有權防止舊回應清除新操作。工作台與標頭經 server 重新讀取 DB，不把本地輸入冒充保存。完整本輪結果與限制見 [readiness §100](../readiness-review.md#100-2026-11-05-p-2-本人學生重新命名有界實作)；Gate／Q-AUTH／正式啟用及整項任務未變。

### Specification 單階段提交與教師審查（D-34／§95）

以下只覆蓋本輪已批准的 Specification 審查，取代較早「所有批准操作未開放」在此子集的描述；其他階段、通關規則與服務仍不因此開放。

| 方法／路徑 | 輸入／結果 |
| --- | --- |
| `GET /api/v1/projects/{id}/stages/Specification/submissions` | 本人學生可信 current evidence（保存版本／需求 revision／分類確認 ID）及 latest submission，無提交時 latest=null；state 為 pending／approved／returned／invalidated，歷史 decision 與目前 state 分開。 |
| `POST` 同上 | strict `{ expected_draft_version, expected_requirements_revision, expected_classification_id }`＋UUID `Idempotency-Key`。三項皆為 CAS，原文與身分／時間由 DB 取得，不接受 caller 內容或權限。成功 200 `{ outcome:"submitted"|"replayed", submission_id }`。 |
| `GET /api/v1/teacher/specification-submissions?after=0&limit=20` | 僅目前有效且未決的可審提交；依不可變提交 sequence 由舊到新，limit=1～50（工程分頁值），多一筆探測 next_cursor，不默默截斷。 |
| `GET /api/v1/teacher/specification-submissions/{id}` | 當下有效綁定教師的不可變提交詳情；含原 Specification、正式需求與分類證據，不冒充目前編輯內容；同交易寫入 `teacher_view` 去敏稽核，失敗不交付內容。 |
| `POST /api/v1/teacher/specification-submissions/{id}/decision` | strict `{ decision:"approved"|"returned", reason:null|string }`＋UUID key；批准 reason=null，退回必須有學生可讀理由。200 `{ outcome:"decided"|"replayed", submission_id }`；只能從尚未決策、有效證據建立一筆不可變決策。 |

退回理由防護上限 2000 字元、拒絕控制字元與只有空白；這是工程輸入界限，不是正式配額或內容品質門檻。沿用原草稿空字串與原文保存政策，不增加字數達標等完成規則。不要求其他八階段／學生階段確認；學生必須先保存並核對版本，再透過送審確認對話框明確送出。

兩種寫入皆先鎖原操作鍵，再以一致順序鎖 profiles（UUID 升冪）→school→適用 membership→binding→project→既有 Specification 草稿 advisory lock，等鎖後重驗身分、資格及確切證據。既有需求／分類以 project row lock、草稿以同一 advisory lock 序列化，無須重寫歷史 migration。submission／decision 唯一鍵本身保存原意圖與非秘密 receipt；同鍵異意圖 422、相反決策／舊版本／非可送審狀態 409，成功、必要 audit 與證據同交易。歷史不被新提交改寫，不新增 receipt 到期清除機制。

新增 `specification_review_epoch` 只供本輪持久失效：profiles 的 role／status／deletion_state／school_id、school 的 approval_state／approval_epoch／valid_until 變動，以及 binding／membership 生命週期變動，皆由 DB trigger 增加世代，caller 不能回設世代。提交保存學生／學校世代；決策另保存教師世代及確切 binding／membership ID＋世代。現在資格仍須有效，且世代／草稿版本／需求 revision／分類 ID 全部相符，才可呈現目前有效批准；舊 receipt 不變更任何 current。已到學校有效時間邊界亦拒絕，不新增期限值或管理服務。

可信 Auth 每請求重驗、非特權 actor、FORCE RLS、不可 LOGIN 的窄用途 writer、固定 search_path 與 EXECUTE 白名單沿用；一般 actor 不能直接 DML、讀取審查表或執行內部投影。不提供 service_role 產品捷徑。教師須有有效學校歸屬及師生綁定，無管理員代審；不可見詳情／決策統一 404、未登入 401／帳號拒絕 403，拒絕不回內容。讀取依賴故障 503；寫入結果未知 503 `operation_outcome_unknown`。傳輸輸入 16 KiB／回應 256 KiB，其他錯誤沿 COMMON。

客戶端只在 hydration 後明確操作；未知結果保留帳號／資源隔離 sessionStorage 的原 key／body／版本，不存批准旗標、不自動重送／改決定。狀態只能由 server＋DB 重讀，讀取競態有世代防護，失權安全關閉，共用離開防護保留。總覽與學生確認 DTO 對 Specification 改標 `separate_specification_review`，指向保存頁讀取獨立審查，不虛報「尚未取得」或把單階段批准當成完整旅程完成。

本輪 submission 是審查證據，不是 T068 作品版本／產物快照；不變更 `project.stage`，不授予 Checkpoint／Final Pack／Agent／預覽／發布。綁定管理產品入口仍未實作；隔離測試以合成 setup 建立持久關係，不是完整綁定 E2E。完整驗證與剩餘限制見 [readiness §95](../readiness-review.md#95-2026-11-04-t052-失權修正與-specification-教師審查)。

**P-1 初始化補訂（2026-10-24 教育者明確批准）**：本文仍只有 `{ title, tier?: "A"｜"B" }`；新專案的 `stage` 固定「點子」、`row_version` 固定 0，僅由受控建立流程設定，不接受 caller 傳入上述欄位（即使值恰為「點子」／0 也不接受）。這不是既有資料允許值限制，不重設舊專案階段／版本、不加入全表版本非負約束；舊零／負版本仍可讀。owner 由可信主體、id／created_at 由可信 DB 產生的原要求不變。

**P-1 方案 B（2026-10-24 教育者明確選定；實作範圍見 readiness §41）**：先建立未分類點子，A/B 後續步驟才確認分類。本文保持 `{ title, tier?: "A" | "B" }`；缺省保存 `requested_tier=NULL`，明示 A／B 僅逐字保存為 `requested_tier`，不可作可信正式分類。新列固定 `classification_state="unconfirmed"`、`stage="點子"`、`row_version=0`，`tier` 與 `needs_visitor_identity` 均為 NULL；禁止 caller 指定 owner／角色／學校／id／時間／階段／版本／分類狀態／正式分類／確認證據。建立本身不授予預覽、提交、發布或部署資格。

本機隔離 migration 以 `classification_state="legacy_unverified"` 標示遷移前的歷史列，保留原 tier／boolean 值及舊七欄 DTO，不把 false 升格為已確認證據。新的具名 DTO 區分 `unconfirmed`、`confirmed` 與 `legacy_unverified`；舊介面遇無法表示的新列明確回 unsupported，不可靜默濾除或部分成功。§41 的建立子集當時未提供 confirmed 寫入；§43 另行批准並實作最小需求 revision、學生明確確認與失效受控交易，均非 HTTP handler 或一般服務上線授權。細節見 [readiness §41](../readiness-review.md) 與 [§43](../readiness-review.md)。

### 1.1 需求版本與分類確認

**§93 本輪產品傳輸接線（2026-11-04）**：沿用下列現行交易，不改歷史 SQL。`GET /api/v1/projects/{id}/requirements` 回當前需求與分類；`PUT` 同一路徑保存正式需求，strict body `{ expected_requirements_revision, requirements: { description, runtime_needs, runtime_ai_required } }`。`POST /api/v1/projects/{id}/classification/confirmation` 明確確認，strict body `{ expected_requirements_revision, tier: "A"|"B", needs_visitor_identity: boolean, requested_tier_acknowledgement: "no_preference"|"matches"|"explicit_change" }`。兩種變更皆必填 UUID `Idempotency-Key` 及單一強 `If-Match: "<project row_version>"`；revision 由 body 對應 DB `expected_requirements_revision`，header 唯一對應 DB `expected_row_version`（含合法歷史 signed int32）；body 不接受重複 row version、project id、owner／角色／時間／批准等欄位。`If-None-Match` 不適用。

GET `200` current 固定白名單 `{ id, row_version, requirements_revision, requested_tier, classification_state, requirements, tier, needs_visitor_identity, confirmation }`；confirmation 僅 `{ id, requirements_revision, confirmed_at, source }`，不傳確認者身分。變更 `200` envelope `{ outcome: "saved"|"confirmed"|"replayed", operation, current }`；operation 是原提交 receipt，current 是提交後重新可信讀取的當前結果，二者版本可能不同；ETag 僅描述 current。一般 DTO／receipt 絕不是可信資格物件；資格操作仍須重新 `resolveTrustedProjectClassification`。同鍵重放不重做確認，舊 receipt 不恢復 current。

沿用每次 Auth `/user`→DB 當下 gate／owner、可信同來源變更檢查、no-store／problem+json 與去敏。非本人／不存在 `404`，資格拒絕 `403`、未登入 `401`；雙版本 stale `409 version_conflict`；同鍵異意圖 `422 idempotency_key_reuse`；缺需求 `409 project_requirements_missing`；分類矛盾／偏好未明示 `422 classification_inconsistent`／`classification_acknowledgement_required`；不支援 server／runtime AI 分別 `422 student_server_runtime_not_in_mvp`／`work_runtime_ai_not_in_mvp`。此類需求可如實保存但不能確認；visitor=true 沿用現有分類交易可記錄，公開資格仍由既有 qualification 判斷且不授權公開操作。

本文最大 64 KiB UTF-8，回應最大 256 KiB；輸入過大 `413`，非法本文／版本 `400`，媒體錯誤 `415`。讀取依賴故障 `503 dependency_unavailable`；提交結果、提交後讀取或回應驗證無法確認時 `503 operation_outcome_unknown`（回應超界則 `503 dependency_unavailable`，同樣不能推定未提交）。unknown 保留原 key／body／雙版本，禁止換意圖盲重試；沿用 COMMON 及既有 24 小時 receipt 規則，不提供永久 exactly-once／到期後恢復保證。UI pending 操作記錄使用帳號隔離 sessionStorage；不是持久草稿政策，storage 失敗停止送出並提示。未保存正式編輯仍只存在頁面記憶體。

需求 DTO 為固定欄位 `{ description: string, runtime_needs: "static" | "work_data_api" | "restricted_server", runtime_ai_required: boolean }`；未知欄位、缺漏、錯型別、矛盾值拒絕。文字精確保存，不 trim、不排序、不正規化；相同內容沿用 revision，不同內容建立不可變的新 revision。保存／讀取只處理擁有者學生的當前需求；輸入不得帶 owner、確認者、權限 claim 或時間。

保存需求輸入含 `project_id`、`expected_row_version`、`expected_requirements_revision`、需求 DTO 與 UUID 冪等鍵；確認輸入另含明確 `tier: "A" | "B"`、必填 `needs_visitor_identity: boolean` 及 `requested_tier_acknowledgement`（`no_preference`／`matches`／`explicit_change`）。`row_version` 是 project row compare-and-swap 版本；需求 revision 是內容版本。兩者皆比對成功才可提交。requested_tier 不作權威分類；偏好不同時必須由學生在確認操作選 `explicit_change`，未明示即拒絕。

`unconfirmed` 的正式分類值與當前確認指標皆 NULL；`confirmed` 的確認證據綁定專案、當前 revision、精確需求快照、分類、擁有者學生與 DB 可信時間；`legacy_unverified` 保留舊值但不具確認證據。需求改變時，在同一交易內新增需求 revision、使舊確認退出 current、清空 tier／visitor／confirmation 指標、回到 unconfirmed 並更新 project row_version；舊證據不可改寫。確認與更新以 row lock／版本比較序列化。只有提交後才回成功。

重放依 COMMON 的 UUID、主體＋操作 scope 隔離與至少 24 小時保存規則；每次先重新授權再處理 key。同鍵異內容拒絕；同鍵同內容回原操作 receipt 並另解析當前分類，不重做確認，也不恢復過期／失效證據。資料庫直接 DML 對一般 actor 拒絕；寫入／證據／冪等均受最小權限及 FORCE RLS／窄用途受控函式保護。固定安全錯誤不得含 SQL、SQLSTATE、driver error、stack 或原始需求內容。此介面為本機 server／資料庫整合，不代表 HTTP／UI、真實 Auth 或後續操作獲准。

**P-1 待確認結果恢復**：只有全新意圖的第一次嘗試使用 `POST /api/v1/projects`。任何結果未知、reload、重新驗證或重試一律使用 `POST /api/v1/projects/recovery`；此路徑只可回傳有效且完整的原 receipt，永不建立專案、刪除過期 receipt 或 fallback 至 P-1。兩路徑以相同 owner／`project_create_v1`／UUID 交易 advisory lock 序列化；恢復在鎖取得後重新檢查當下資格、精確本文／意圖及 receipt 到期，並在同一 DB 交易讀取結果。鎖等待期間原建立提交後才可回放；若原交易回滾／receipt 不存在、過期、不完整或結果不符，固定回 `409 operation_outcome_unrecoverable`，不宣稱原操作未執行。P-1 原 API 的到期後同鍵可新建語意維持不變，不能用來恢復未知操作。

**§44 審閱修復的介面界線**：`readCurrentOwnedProjectClassificationSubset` 回三態的一般 DB DTO，不是 `TrustedProjectClassification`。只有 `resolveTrustedProjectClassification` 重新查詢並完整驗證當前確認後建構的六欄分類原物件，才通過 `hasTrustedProjectClassification`；receipt、一般 confirmed DTO、自組、spread／JSON 副本均不通過。WeakSet 只證明 resolver 產生來源，不表示 DB 狀態永遠有效，也不是即時撤銷／永久授權機制；每次需要當前資格時須重新 resolver。

舊七欄 `readOwnedProjectSubset`／`listOwnedProjectsSubset` 及只表示未分類／歷史狀態的 `readOwnedProjectWithClassificationSubset`／`listOwnedProjectsWithClassificationSubset`，對經完整需求／確認證據驗證的合法 confirmed 回 `unsupported_representation`。缺漏、非法或矛盾資料回安全 `failed/invalid_result`，不能僅憑 state 判為合法；列表先檢查所有列的有效性／ID 唯一性，再決定是否不支援，不部分回傳。完整 current DTO 不受此表示限制，建立冪等仍回建立當下 unconfirmed DTO。

需求保存／分類確認的 envelope、receipt 或 replay current 驗證失敗，是交易內部結果錯誤：服務須拋固定內部例外讓既有 adapter 回滾，再於交易外回 `failed/invalid_result`，不回傳輸入／SQL／driver error／stack。政策拒絕、版本衝突等正常業務結果仍正常返回；成功只在 COMMIT 後交付。不改 adapter 為猜測任意 failed 均須回滾。

| # | 方法與路徑 | 能力／授權 | 輸入 | 回應 | 錯誤 | 冪等／並行 |
| --- | --- | --- | --- | --- | --- | --- |
| P-1 | `POST /api/v1/projects` | `edit_saved_content` | `{ title, tier?: "A"｜"B" }`（首版僅 A／B；~~`"C"`~~【已被取代・首版不適用（2026-10-21 範圍決定）；原文保留作歷史】；`tier` 為其他值→`422 tier_not_supported`，文字「首版不支援需要作品執行時呼叫 AI 的 C 級作品」〔草案，待教育者／專業審閱〕；等級依需求，A／B 沿用 v5 定義，不因平台為 C 級而強迫升級，**使用平台 AI 製作不使作品升級為 C**） | `201` | `403` | `Idempotency-Key` |
| P-1R | `POST /api/v1/projects/recovery` | `edit_saved_content`，再由 DB 驗證 owner／資源 | 與 P-1 完全相同的原本文及 UUID key；禁止新 key／改本文恢復 | `200 { outcome: "replayed", project }`，只回原建立結果 | `409 operation_outcome_unrecoverable`（缺少／過期／不完整／無法確認）；`422 idempotency_key_reuse`；`401／403`；`503` | DB 強制 replay-only；與 P-1 共用 owner＋scope＋key 交易鎖；任何分支皆不可 INSERT／刪除 receipt／fallback create |
| P-2 | `GET／PATCH /api/v1/projects/{id}` | 擁有者；已綁定教師唯讀（留稽核） | `PATCH`：欄位＋`If-Match` | `200` | `409` 並回雙方內容；`404` | `row_version` |
| P-3 | `PUT /api/v1/projects/{id}/stages/{stage}` | 擁有者學生；當下 edit／read gate＋owner | 未確認草稿子集 strict `{ content: { text: string } }`，不接受 state／owner；確認／批准仍走各自人工 RPC，非本子集 | 首建 `201`＋DTO／Location／ETag 0；更新 `200`＋DTO；重放 `200`＋原 operation／current_draft | `400 precondition_required／invalid_precondition`；`412 draft_already_exists`；`409 version_conflict`；`422 idempotency_key_reuse`；`401／403／404` 依既定隱匿 | UUID Idempotency-Key；首建單一 `If-None-Match: *`，更新單一 strong `If-Match`；詳 COMMON D-33 |
| P-4 | `PATCH /api/v1/projects/{id}/tasks/{tid}` | 擁有者 | `{ done }` | `200`（**真的寫入**，非僅提示） | `409` | `If-Match` |
| P-4I | `POST /api/v1/projects/{id}/tasks` | 擁有者（本人學生） | strict `{ confirmed: true, tasks: [{ title }] }` | `201` 首次建立／`200` 同次確認重放 | `409 task_list_already_exists`、`422 idempotency_key_reuse` | `Idempotency-Key`（UUID） |
| S-1 | `POST /api/v1/projects/{id}/snapshots` | 本人有效學生 | strict `{ kind: "manual", message? }`；以 DB 一致 snapshot 的完整已保存檔案集建立，不收 manifest／blob／owner／version_no | `201`＋snapshot DTO | `409 version_conflict`／`422 idempotency_key_reuse`／`507 storage_limit` | 必帶 UUID `Idempotency-Key`；同鍵同意圖回原 receipt，不新增版本 |
| S-2 | `POST /api/v1/projects/{id}/restore` | 本人有效學生；`edit_saved_content`；DB 依 profile→school→project 鎖序重驗 gate／owner／同專案目標 | strict `{ snapshot_id }`；UUID `Idempotency-Key` | 同一交易先建立完整 `pre_restore`，再以目標 manifest／blob 完整取代目前檔案集；`200`＋strict `{ pre_restore_snapshot_id }` | `409 save_failed`：pre_restore 保存失敗→不變更檔案；`409 operation_outcome_unrecoverable`；`422 idempotency_key_reuse`；其他依正式 problem registry | 原鍵同目標只回原 receipt；同鍵不同目標拒絕；未知結果須原鍵／原目標 replay-only，receipt 缺失／到期不可再次替換；replay-only 401／403／404 不證明首次交易未提交，保留原鍵／原目標／未知狀態並隱藏受保護內容，資格恢復後只以原操作確認原收據；首次確定拒絕與確定回滾維持原處理；去敏 audit |
| S-3 | `GET /api/v1/projects/{id}/snapshots` | 本人／沿既有資格與 binding 的教師唯讀 | 穩定游標分頁 | snapshot ID、`version_no`、時間、manifest 差異摘要、`kind`、模型 `immutable` 欄位 | 失權後新請求拒絕；教師讀取沿 `teacher_view` 稽核，稽核失敗不釋出內容 | `(version_no DESC, id DESC)` keyset；不靜默截斷 |
| S-3 | `GET /api/v1/projects/{id}/snapshots/{sid}/manifest` | 同上 | — | 該 snapshot 的唯讀 manifest 與 `content_hash` | 未授權／不存在隱匿；教師讀取沿 `teacher_view` 稽核 | 僅由已授權 project＋snapshot 引用讀取 |
| S-3 | `GET /api/v1/projects/{id}/snapshots/{sid}/files/{path}` | 同上 | canonical path | 該 snapshot 版本的 UTF-8 原文、SHA-256 與 byte count | 未授權／不存在隱匿；教師讀取沿 `teacher_view` 稽核 | 不接受裸 hash 查詢 |

**S-2 本輪隔離本機替換決定（2026-11-07）**：教育者明確批准本輪以目標快照的完整檔案集取代目前已保存檔案集：目標中存在的路徑恢復精確內容，目標中不存在的目前路徑移除；合法空目標恢復為空集合。必須先在同一 DB 交易建立並驗證完整 `pre_restore`；該快照、檔案替換、receipt 與 audit 一起提交，任一步失敗全部回滾，舊快照及 blob 引用保留。確認介面須明示完整替換；空目標須明示恢復後沒有檔案。未保存草稿、保存中或未知操作須先處理。本決定僅限本輪隔離本機實作與驗收，不核定保存期限、快照份數、自動清除或正式啟用；實作與驗收狀態見 [readiness §109](../readiness-review.md#109-2026-11-07-s-2-有界契約準備與檔案替換邊界)。

**P-4 task row（本批契約具體化）**：`{tid}` 是該專案持久化 `tasks.id`；讀取 DTO 僅含 `{ id, project_id, order, title, done, row_version }`。學生專案詳情由 server 讀取本人任務，不新增任務列表 HTTP API。PATCH body strict `{ done: boolean }`，不接受 caller 提供 owner／project／task 版本／批准狀態或其他欄位；更新帶 COMMON 的單一 strong quoted `If-Match: "<canonical row_version>"`。成功回 `200`＋更新後 task DTO 與新 ETag，`row_version` 原子遞增；合法舊版回 `409 version_conflict`，衝突只投影 `done` 欄位。不存在或 task 不屬於 URL 專案／本人時以 `404 not_found` 隱匿。這個勾選只表示使用者的任務勾選，不表示階段完成、教師批准、Agent 執行、測試通過、發布資格或 Gate 通過；本契約不定義 Skills／AI／Agent 的任務生成來源。

**P-4I 手動任務清單首次匯入（readiness §86 最小補充，一次性授權；非 Skills／AI 生成）**：本人學生在產品頁手動輸入任務清單（每行一項）、預覽並明確確認後，`POST /api/v1/projects/{id}/tasks` 經服務端授權（principal、帳號 gate、project owner；DB 寫入時再重驗）建立該專案的持久化任務，供 P-4 勾選。body strict `{ confirmed: true, tasks: [{ title }] }`（`confirmed` 必為 `true`；不接受 `id`／`owner_id`／`project_id`／`order`／`done`／`row_version`／批准欄位）；`title` 去頭尾空白後非空、至多 200 code points、不含控制字元，清單 1～50 項（**50／200 為工程防護值，待教育者核定，非產品配額**）。順序＝陣列位置（1..n）；task ID、owner、project 關聯、初始 `done=false`、`row_version=0` 由服務端控制，不寫 `done_snapshot_id`、批准或 Agent 狀態。必帶 `Idempotency-Key`（UUID）；同一事務寫入任務與一筆確認紀錄 `project_task_imports`（每專案至多一筆）。同 key＋同內容重送（含 COMMIT 後 response-loss）回 `200 {outcome:"replayed",tasks}`（目前任務，`done`／版本可能已變）、不新增；同 key 不同內容／不同專案回 `422 idempotency_key_reuse`；專案已有任務（含不同 key 的並行首次匯入）回 `409 task_list_already_exists`，不覆蓋、不改 `done`／版本。確認紀錄不過期，且「已有任務」守衛使到期後重新 create 不可能；未知結果只能以原 key／原內容重送。成功回 `201 {outcome:"created",tasks}`＋`Location`。不存在／非本人 `404`（隱匿），失權或非學生角色 `403`。本批僅首次匯入；批次取代、刪除、重排、重新生成不在範圍。匯入與勾選均不表示階段完成、教師批准、Final Pack、Agent 執行批准或部署授權。

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

**§94 產品接線（2026-11-04，有界批准）**：既有專案總覽新增「檢查目標階段」，server rendering 直接沿用下列可信 reader，無新增 HTTP endpoint。URL 只接受選填 `requested_stage` 九階段 enum；省略採目前階段，非法／重複／額外 caller 證據明確拒絕，不作 caller 授權結論。九個同源目標連結、A/B 與階段補齊連結、重新檢查均重新讀取，沿用共用離開防護與受保護畫面；不持久化評估，不改階段／任何版本。只投影 reader 真實結果與可讀文案，草稿觀察不推導學生確認、批准或完成；私人支援範圍不等於公開資格或操作權。評估失敗隱藏本次內容並提供重試；其他區塊為不同 DB snapshots，不合併宣稱完整通關。§49 下述無 UI／真 Auth 是歷史範圍，現行接線及本輪實測見 [readiness §94](../readiness-review.md#94-2026-11-04-t052-目標階段檢查與補齊入口有界產品接線)；不重開 §93／§93.4、不變更 SQL／授權，人工批准與推進規則仍待決。

傳輸無關 `readOwnedProjectCreationFlowAssessmentSubset(context, { project_id, requested_stage })` 經 [projects 入口](../../apps/web/src/server/projects.ts) 匯出。caller 僅能提供 UUID 專案 ID 與九個正式階段之一；strict 輸入拒絕需求／分類／確認／草稿／owner／角色／能力／結論等附加欄位。server 沿用可信唯讀 `AuthorizationContext.runReadOnly`、非特權 authenticated actor、既有 `read_saved_content` gate／owner 查詢、RLS 與逐欄 SELECT；專案／需求／目前確認投影／必要完整確認 evidence／九步草稿均由同一個參數化 SQL statement 讀取，READ COMMITTED 亦不跨 statement 拼接。

server 先以既有 current-classification parser 驗證三態與 SQL 內完整關聯結果，再嚴格解析內部確認 evidence，核對目前 project、revision、需求逐欄原文、tier、visitor、requested tier／acknowledgement、確認者 owner 關聯與證據目標；草稿逐筆驗證 schema、project 與階段唯一性。只有完整合法資料才交給既有 `evaluateCreationFlow`。合法無需求／無草稿、`unconfirmed`、`legacy_unverified`、有效 A／B 與草稿沿原純函式規則處理；缺當前需求、確認矛盾、非法／重複資料或不合法 SQL envelope 一律整份 `failed/invalid_result`，不部分回傳。不存在／他人專案同回 `not_found`；政策拒絕、invalid input/context 與 dependency failure 維持固定安全結果。

成功白名單為 `{ outcome:"evaluated", snapshot:"single_statement", project_id, row_version, requirements_revision, assessment }`。`assessment.evidence_assurance` 維持 `structural_only`，`observed_drafts` 只含階段／狀態／來源，不含需求或草稿本文；不輸出 owner、確認 evidence／確認人、冪等、任意 meta、SQL 或 driver error。此結果只描述該次 DB statement snapshot，不是永久資格、批准來源、真實 Auth 或完整產品安全驗證；不建立 `TrustedProjectClassification`，不給 resolver 以外的操作授權。OD-12／未定階段仍 unsupported。`platform_ai_assisted_creation` 為不影響目前判斷的選填背景資訊；未提供時不補 `false`，也不由平台有 AI 或 `ai_draft` 推定。

§49 不新增 migration／grant／寫入 RPC、快取或持久化評估；不寫 project stage／版本、需求、分類、草稿或批准證據。沒有 HTTP／Server Action／UI／真實 Auth provider。實作、紅燈、實際 DB 併發及驗證結果見 [readiness §49](../readiness-review.md)。

## 2. 檔案與編輯（IDE）

**2026-11-06 E-1／S-1／S-3 有界產品垂直流程**（本輪不開啟 E-2 預覽、E-3、Agent 或提交）：

- `GET /api/v1/projects/{id}/files` 列出本人專案已保存檔案；`GET /api/v1/projects/{id}/files/{path}` 讀取單一已保存檔案；`PUT` 同一路徑為新檔或 CAS 更新。每個 API 請求先由可信 Auth `/auth/v1/user` 驗證，再由 DB 在該次交易重驗角色／學校 gate／owner；僅本人有效學生可寫，教師／管理員不得寫學生檔案。S-3 教師讀取採既有 eligibility、membership、binding、school gate 與 `teacher_view` 稽核，不擴權其他 reader。
- canonical path 是相對 POSIX 路徑，最多 512 ASCII bytes，只允許 ASCII `[A-Za-z0-9._/-]`、副檔名 `.html`／`.css`／`.js`（小寫）；拒絕空／絕對／重複斜線、`.`／`..` segment、反斜線、`%` 編碼、控制字元、尾隨點／空白、Windows 保留名稱及其他副檔名。內容只存 UTF-8 原文 bytes，不改換行／Unicode；空檔案合法。單檔上限為 **262,144 UTF-8 bytes**，client／server／DB 都以實際 bytes 驗證。無檔案系統、symlink、外部引用或二進位上傳。
- 首建必須只有 `If-None-Match: *`，已存在回 `412`；更新必須只有單一 strong `If-Match: "<64 位小寫 SHA-256>"`，不符回 `409 version_conflict`，不覆寫。DB 自行計算 UTF-8 bytes／SHA-256；caller hash 僅用於比較，不作事實。保存、blob 引用、版本及其必要 receipt／audit 同交易。未知結果保留原鍵／原本文重試；不得換鍵或以目前同文推定成功。
- 工作區以 Monaco（隨 lockfile 安裝，不用執行時 CDN）與 DB 檔案樹編輯 HTML／CSS／JavaScript。內容只作文字，不執行、`eval`、載入 script 或 iframe 預覽。明確新增檔案後才開始空專案；UI 清楚區分編輯中草稿、DB 已保存 hash／版本、manual 快照，並標示「預覽尚未提供」。
- 草稿僅保存在 `sessionStorage`，鍵依可信帳號 scope／project／canonical path 隔離，只承諾同分頁 reload。資料永遠不可信、不含 token／cookie／秘密；保存失敗仍盡力保存草稿。reload 必先讀 server current 並比對，不得默默覆蓋任一方。storage 損壞／額度不足／不可用時明示恢復受限，不宣稱本機已保存；失權時隱藏受保護內容，不讀本機草稿。登出／換帳號不共用內容，只清理本功能鍵。保存中續編、切檔、切專案、離頁、IME 組字與晚到回應沿既有 controller／共用 `UnsavedChangesGuard` 處理，不新增攔截器。
- manual 快照由 `project_id` 列 `FOR UPDATE` 與同一交易序列化檔案保存／快照，取得一份完整且不會被並行保存切開的已提交檔案集；dirty 時先要求保存，不能把草稿混入。manifest 以 canonical path UTF-8 bytes 升冪排序；每列 canonical bytes 為 `path + NUL + lowercase_sha256 + NUL + decimal_byte_count + LF`，`content_hash = SHA-256(concat(rows))`。DB 原子分配 `version_no`，所有 blobs／manifest 引用同交易。快照工程容量防護值明定為 **16 MiB**，計算 `sum(file_bytes + UTF8(path)_bytes + 64 hash bytes + 2 NUL bytes + decimal(byte_count)_bytes + 1 LF byte)`；此值只防止單次快照過大，不是已核定產品配額。超限回 `507 storage_limit` 並完整回滾，禁止部分快照、舊版本覆寫、自動修剪或刪除。後續檔案更新不改舊 snapshot。
- 快照列表以 `(version_no DESC, id DESC)` keyset 穩定分頁；變更摘要只比較前一個可見版本與此版實際 manifest，回傳新增／修改／移除路徑，不使用生成式 AI。manual `immutable` 欄位照資料模型投影，不稱為 immutable submission／批准版本。快照沒有更新或刪除 API。§2「沒有 restore API」只記錄 2026-11-06 的 S-1 舊批次邊界；S-2 本輪另有 `POST /api/v1/projects/{id}/restore`，本人學生可恢復 manual／pre_restore，且 pre_restore 不列入教師列表、摘要、manifest 或檔案 reader。manifest 與快照檔案 API 由 project＋snapshot 引用授權，不提供 hash 存在性查詢。

**2026-10-21 最新 MVP 契約（現行，取代 E-3 及 §5 的沙箱預覽埠敘述）**：E-3 回 `202`＋建置 job；以已保存快照啟動 X（`ports: []` 建置→平台取回、檢查、保存產物），成功後才簽發／更新平台控制的預覽入口供右側 iframe 使用。job 回 `queued／building／retrieving／validating／succeeded／failed／cancelled`、目標快照、目前可見版本與失敗碼；保存成功不等於建置成功，無有效產物不得回可用預覽。60 秒一次性兌換與主機名會話仍為待定稿審閱的設計，非本次批准 X 即已驗收；會話綁產物而非沙箱，見 [publishing §3.6](./publishing-and-public-runtime.md#36-mvp-方案-x現行契約2026-10-21)、[data-model §4.4](../data-model.md)。

需學生伺服器程式（β2）時，不執行／不建立其公開 runtime；回 `422 student_server_runtime_not_in_mvp` 與範圍說明，Agent 可保留設計／檔案並提出合格替代，不以靜態頁宣稱功能已完成。平台 AI 與既有安全閘門維持。

| # | 端點 | 說明 |
| --- | --- | --- |
| E-1 | `GET /api/v1/projects/{id}/files`、`GET／PUT /api/v1/projects/{id}/files/{path}` | 本輪只支援 `.html`／`.css`／`.js`；新檔 `If-None-Match: *`、hash CAS 更新；262,144 UTF-8 bytes；路徑規則與授權依上方 2026-11-06 契約；不含二進位 Storage |
| E-2 | 狀態區分 | 本輪區分「編輯中草稿／DB 已保存版本／manual 快照／預覽尚未提供」；不提供 preview URL、執行或 iframe |
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
### 3.1 T064 持久操作子集（2026-11-05；非 G-1～G-4 成功接線）

`apps/web/src/server/agent-runs.ts` 的 `createAgentRunOperations` 每次經既有可信 Auth resolver，再以非特權 authenticated DB session 執行窄用途交易；不接受自報 owner／角色／時間／Job 歸屬。`create` 只保存 `{project_id,mode,instruction,idempotency_key}` 的 awaiting metadata，instruction 僅作請求 digest、不落本文；沒有 proposed_plan、模型或批准，因此**不是 G-1 成功回應**。原鍵同意圖回原 `operation` 與當下 `current`，異意圖 idempotency_conflict，同專案活動 Run conflict；兩種批准形狀仍分開。

`read／stop` 只收 `{run_id}`，先查 Run 的持久關聯，DB 鎖後重驗本人學生／project owner／account gate。不存在與非本人同 not_found；teacher／admin denied。只有關聯的 `queued／leased` Job 交給既有 T010 `job_cancel`；不以 Run UUID 當 Job UUID，不收 Job ID、不換綁、不啟動外部工作。無工作 awaiting→stopped；有活動 Job→stopping，僅表示 cancel_requested；終結由既有 Worker lease／fencing／重要步驟完成，之後重讀停止可將已無活動 Job 的 Run 設為 stopped。已 stopped／failed 不倒退；不把 Job done 推為 Run completed，不投影不存在的產物／恢復證據，不更改 unknown 費用。

`start` 只收 `{run_id,approval,idempotency_key}`（guided `{step_seq}`；auto `{approved_task_ids}`）；鎖後確認 Run／owner 後固定 unavailable，列明 `pre_agent_snapshot／agent_approval_evidence／agent_execution_authorization`。未有正式證據前，**Job 建立／Run→Job 關聯與 running 轉移分支不啟用**；本輪不存在可呼叫的 fixture／provider／快照繞過入口。內部 stop_acknowledged DTO 僅 Run metadata 及真 Job 的白名單狀態／取消旗標，並非 COMMON Job DTO 或 G-3 HTTP 成功本文。

**停止核心完成、G-3 HTTP 尚未驗收**：正式 G-3 成功契約仍為 200；HTTP 維持既有 ai_not_open 安全關閉（403 不是成功驗收）。G-1／G-2 及學生 Agent 按鈕不啟用。完整 G-3 已完成／未完成與恢復投影仍依 T068／agent_steps／保存產物證據，詳見 [readiness §102](../readiness-review.md)。

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


**§87 P-3C 學生階段確認（本機子集）**：`GET／POST /api/v1/projects/{id}/stages/{stage}/confirmation`；POST body strict `{expected_row_version}`＋必要 `Idempotency-Key`。201 confirmed；200 replayed／already_confirmed；409 `stage_draft_not_saved`／`stage_confirmation_version_mismatch`；422 `idempotency_key_reuse`；503 `operation_outcome_unknown`。確認不是教師／管理員批准或分類證據；批准規則未定，狀態固定 `manual_approval_unavailable`。DTO 見 `packages/core/contracts/stage-draft-confirmation.ts`。
