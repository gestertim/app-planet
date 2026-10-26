# 契約：審查、部署、公開入口、作品託管中介層；作品不得呼叫生成式 AI（Public AI Gateway 已取代、首版不適用）

**對應**：FR-013、024、025、032、037、039、040、048、049（**現行規則＝作品不得呼叫生成式 AI，見 §7**；原「受控公開 AI」條文已被取代）、~~050、053(f)~~（公開 AI 池與訪客高風險輸入，首版不適用）｜**研究**：[../research.md](../research.md) R-07、R-13｜**資料模型**：[../data-model.md](../data-model.md) §5、6｜**待決**：~~D-01、02~~（不再阻擋，保留為後續版本待決）、03、08、~~13~~（首版不適用）、~~16（β2 首版功能目標）~~（已被 D-23 取代；β2 另立 feature）｜通則見 [README.md](./README.md)

> **同步註記（2026-10-21 首版範圍決定；D-23 後續覆寫）**：首版學生作品只可採 **A／B 級**，公開作品僅 A／B；作品本身不得以生成式 AI 作為執行時功能。**§4 Public AI Gateway、§5 管理員公開 AI 控制**，以及 R-1 的 `public_ai` 非 `n/a` 取值、`c_public_ai_gate_not_passed`、§3 的 `{public_ai_gateway}` 與 C 級個資提示，均標示「已被取代・首版不適用」，**原文保留作歷史，不得實作、不列入驗收**；現行規則見新增的 **§7**。原註記所稱「§6 β2 維持不變」已被 D-23 取代：β2 學生伺服器公開執行另立 feature，不屬 MVP 實作或 Gate；MVP 保留 B2 Work Data API。B 級訪客識別／登入／帳號／可識別訪客資料之公開排除仍現行。本契約為設計層級，尚未實作、未驗證。

> **同步註記（2026-10-21 Plan 定稿前定點修正；現行設計，〔規劃，尚未實作、尚未驗證；教育者尚未批准〕）**：（1）預覽反向代理細節補強於 §3.1（每預覽獨立主機名、預覽續用憑證、前提判準）；（2）共用 `works_csp_policy` 新增 `form-action 'self'`、`base-uri 'self'` 並逐項核對流程，見新增 §3.2；（3）Work Data API 定為**同源**保留路徑 `/_work/data/v1/*`，由 works-edge 轉送、平台端處理，見新增 §3.3；§3 的「僅唯讀」同步改為現行定義。歷史原文保留，被取代處已標註。

> **歷史同步註記（2026-10-21 第九輪；已被 D-23 取代）**：（1）右側互動預覽曾採用 iframe、無 cookie 與「`preview_id` 主機名即憑證」設計；（2）曾記錄 works-edge 持有可簽署作品資料請求的專用 HMAC。以上僅保留批准歷史及當時推理，不是現行授權規則；**不得按舊設計實作**。現行唯一授權規則見 §3.7。

> **現行規則（D-23，2026-10-21；取代下方舊預覽授權與作品資料簽章設計）**：§3.7 為預覽授權 A1、Work Data API 授權 B2 與 X MVP 預覽的唯一現行規則。下方 §3.4 與 §3.5 的「hostname 即憑證／無 cookie」及 works-edge 持有可為所有作品簽章的資料 HMAC 均為**歷史方案，不得按其實作**。§3.6 的 X 建置／產物／更新規則仍現行；其授權、資料簽章與驗證描述如與 §3.7 不同，均由 §3.7 取代。MVP β2 學生伺服器公開執行與 M／W 不實作、不列入 Gate，另立 feature。

### 3.7 現行 MVP 預覽授權 A1、作品資料授權 B2 與方案 X（D-23；2026-10-21）

**狀態**：教育者已批准設計方向；尚未實作、尚未完成產品驗證。此節是本契約唯一現行授權規則，取代 §3.4／§3.5 的相關歷史文字。參數核定責任、時點與 fail-closed 規則見 [decision-register.md](../decision-register.md) D-23、PP-20～PP-27。

#### A1 預覽會話

1. **Origin 隔離不等於授權**：每個預覽仍使用獨立、不可預測的隨機主機名以隔離 origin；知道或猜到 hostname 本身不授予任何存取權。沒有有效會話的請求一律拒絕，不得採用「hostname 即憑證」回退。
2. **首次兌換**：平台只向已授權擁有者／教師簽發短效、一次性權杖，綁定一個預覽會話、主體、專案、產物與到期。兌換時原子消耗權杖，成功後移除 URL 權杖，設定 host-only cookie：`__Host-preview_session; Path=/; Secure; HttpOnly; SameSite=None; Partitioned`；不得設定 `Domain`，回應 `Cache-Control: no-store`、`Referrer-Policy: no-referrer`。Cookie 不儲存於文件或日誌。
3. **逐請求授權**：初始 HTML、所有子資源／Worker、重新整理、頁內導覽及 `/_work/data/v1/*` 每次請求均驗證 cookie 的分區／host-only／Secure／HttpOnly 屬性，並驗證伺服端會話為 active、未到期／撤銷、主體仍有效、教師綁定仍有效、帳號未停用、專案與 `artifact_id` 綁定正確。失敗時不傳送產物或資料；未知、未兌換、過期、撤銷及無效 cookie 使用一致的拒絕回應，不洩漏會話存在性。
4. **撤銷與失效上界**：教師解除綁定、擁有者或教師帳號停用、會話到期、管理員撤銷、專案／審查預覽終止等均更新伺服端狀態並拒絕後續請求。對已送出的預覽內容，失效最遲不得超過 PP-23 核定上界（含所有快取）；已載入瀏覽器的內容無法收回。TTL、撤銷上界未核定或不能保證時，不簽發／不續用會話或立即 fail-closed。
5. **不支援處理**：目標瀏覽器或學校政策不支援分區、Secure、HttpOnly、host-only cookie 或跨站 iframe 所需行為時，停止互動預覽並顯示「暫不支援互動預覽」。不退回 hostname 授權、不用未核准替代機制。正式 TLS、Safari／Firefox、學校裝置、跨站 iframe 及目標版本逐一實測；既有 Chrome／Edge 本機結果不得外推。
6. **資料最小化及殘餘風險**：會話 cookie 僅作會話憑證；伺服端只保存 cookie verifier/hash 與會話狀態，不保存明文 cookie；應用日誌只記會話識別雜湊。Cookie 防止 hostname 單獨授權，但不保證已載入內容可收回，也不取代產物隔離、CSP 或 Work Data API 的逐請求授權。

#### B2 Work Data API 授權

1. 平台以非對稱簽章簽發短效授權，claims 至少綁定單一 `listing_id`／作品、用途（讀／寫／刪等受核定操作）、`exp`、授權識別及 `revocation_version`。授權不得跨作品、跨用途或延長重放；works-edge 只持驗章所需公鑰及 `key_id`，**不持有任何可簽署作品資料授權的私鑰或全域資料 HMAC**。平台簽署主金鑰只存於平台伺服器端受保護設定，演算法採經核准的標準實作，不自製密碼學。
2. works-edge 即使成功驗證簽章，也不得據此跳過平台：**每筆資料請求**平台須重新確認作品仍為 live、授權的作品／用途／期限／撤銷版本有效，並重驗配額與限流，再執行受限資料操作。MVP 預覽 Work Data API 另以有效 A1 會話及 `preview_id` 隔離資料集授權；不得讀寫公開資料集。
3. **失敗即拒絕**：授權簽發／更新失敗、平台不可達、作品非 live、超過配額／限流、到期、撤銷版本不符、`key_id` 未知或簽章無效時，不提供或修改資料；不得使用過期授權、暫存資料、其他作品授權或成功形狀的預設值。
4. **撤銷及輪替**：作品停止／下架或授權撤銷即遞增版本；平台逐請求比對目前版本。金鑰輪替採明確 `key_id`，新舊公鑰僅於核定的過渡窗口同時驗證；到期即移除舊公鑰，疑似外洩可立即撤銷該 key id 並停止相關授權。輪替週期、過渡窗口及緊急操作責任由平台安全負責人提出、教育者於 Implementation Readiness Gate 前核定；未核定不得啟用資料寫入授權。
5. **誠實的殘餘風險**：作品綁定授權降低簽章權限，但若 works-edge 遭入侵且已持有所有上線作品的有效授權，攻擊者仍可能觸及那些作品的資料。B2 不代表完全阻止跨作品濫用；平台逐請求重驗、配額、限流、撤銷、稽核與告警仍為必要控制。

#### X 建置與 MVP 範圍

採 `ports: []` 建置→平台管理通道取回→檢查→保存不可變產物→works-edge 提供右側 iframe；更新採「儲存→重建→重載」，不提供 HMR／WebSocket 熱更新。沙箱不啟動供瀏覽器存取的預覽埠；產物超限、建置逾時、檢查失敗或授權無效皆不得服務，不覆蓋最後成功版本。β2 學生伺服器公開執行另立獨立 feature；M／W 不在 MVP 實作或 Gate。PP-20～PP-27 未核定時依 decision-register fail-closed。

## 1. 申請與審查

**2026-10-21 最新 MVP 現行補訂**：依 [spec.md](../spec.md) 最新 MVP Session，本契約僅涵蓋 A／不需執行學生伺服器程式的合格 B，保留平台 Work Data API。下方較早「β2 首版目標」、`b_restricted_runtime_pending`、預覽沙箱埠反向代理／WebSocket 的敘述**保留作歷史，已被本次決定取代**；以 §3.6、§6 現行補訂為準。M／W 不實作，β2 另 feature／Gate；其餘公開排除、無作品執行時 AI、授權、標頭與 HMAC 邊界維持。

R-1 對 `runtime_needs='restricted_server'` 的現行 blocker 為 `student_server_runtime_not_in_mvp`（不再產生 `b_restricted_runtime_pending`）；`can_submit=false`。R-2／R-6 與重試也必須伺服端重驗，回 `422 student_server_runtime_not_in_mvp`，不能靠隱藏 UI 阻擋。文案「MVP 不支援學生伺服器程式執行；後續獨立功能另訂」待適齡審閱，不承諾日期。

| # | 方法與路徑 | 能力／授權 | 輸入 | 回應 | 錯誤 | 冪等 |
| --- | --- | --- | --- | --- | --- | --- |
| R-1 | `GET /api/v1/projects/{id}/publish-status` | 擁有者 | — | `{ eligibility: { can_submit, blockers[] }, tier（僅 A｜B）, public_ai: "n/a"（首版固定；~~not_open｜on｜suspended~~ 已被取代・首版不適用）, versions: { working, requested, public } }`；`blockers` 固定碼：`tier_b_needs_visitor_identity`（顯示「首版不提供公開服務」及原因；**已批准排除，僅限需訪客登入、帳號或可識別訪客資料者**）、`student_server_runtime_not_in_mvp`（MVP 不執行需學生伺服器程式的作品；顯示後續獨立 feature 限制，不可提交／部署）、~~`b_restricted_runtime_pending`（β2 在 MVP 內待驗證）~~【已被 D-23 取代・歷史】、~~`c_public_ai_gate_not_passed`（顯示「公開 AI 尚未開放」，**不得出現「C 級已完整 Launch」**）~~【已被取代・首版不適用（2026-10-21 範圍決定）；原文保留作歷史】、`tier_not_supported`（`tier` 非 A／B，顯示「首版不支援需要作品執行時呼叫 AI 的 C 級作品」〔草案，待教育者／專業審閱〕；見 §7）、`school_public_deploy_paused`、`account_not_approved`、`policy_undecided`（其他尚未核定的政策） | — | — |
| R-2 | `POST /api/v1/projects/{id}/deploy-requests` | `submit_for_review`；擁有者 | `{ snapshot_id, ack: { version, accepted: true } }`；`ack` 須對應「發布前提示」版本（持連結者無須登入即可造訪、可能被轉傳、外部下載或截圖無法收回、noindex 非存取控制、作品不得含個人資料與密鑰）；**未確認不得送出** | `201`＋`state: pending_review`；快照轉 `submission`（不可變）；記錄 `content_hash` | `422 ack_required`；`422 tier_not_supported`；`409`（B 級排除、學校暫停、帳號非 approved；~~C 級關卡~~ 已被取代・首版不適用） | `Idempotency-Key` |
| R-3 | `GET /api/v1/review/queue` | 教師（僅其已綁定學生的申請）；管理員（全部） | — | 申請列表 | — | — |
| R-4 | `GET /api/v1/deploy-requests/{id}/review-bundle` | 具審查權限者 | — | **申請版**的藍圖、預覽（由 `submission` 快照建構，經審查預覽來源）、測試結果、變更、回饋；**不含目前工作預覽**；含可識別身分資料檢查清單 | `404`（無權限） | — |
| R-5 | `POST /api/v1/deploy-requests/{id}/decision` | 具審查權限者 | `{ decision: "approve"｜"return", reason?, reason_code?, pii_review: { work, files, images, text, settings }, runtime_ai_review: { code, dependencies, settings, outbound } }`；`approve` **必填** `pii_review` 全部項目，**且必填 `runtime_ai_review` 全部項目＝已核對無執行時生成式 AI 呼叫（2026-10-21，見 §7；Plan 提案，待教育者審閱）**；`return` 必填 `reason`，含執行時 AI 呼叫者 `reason_code=contains_runtime_ai_call` | `200`；`approve`→`approved`（**不等於部署成功**）；`return`→`returned`，學生可重讀理由 | `422 pii_review_incomplete`；`422 runtime_ai_review_incomplete`；`409` | `Idempotency-Key`；稽核 |
| R-6 | `POST /api/v1/deploy-requests/{id}/start` | 系統／審查者 | — | `202`＋job `deploying`；**開始前**：重驗 `account_gate(public_deploy)`、學校狀態、`snapshot.content_hash == request.content_hash` | `409 content_hash_mismatch`（拒絕部署並提示）；`403 public_deploy_paused` | 冪等：同 request 至多一個進行中的部署 |
| R-7 | `GET /api/v1/deploy-requests/{id}` | 擁有者／審查者 | — | `state`（尚未提交、待審查、退回修改、已批准、部署中、部署成功、部署失敗＋`stopped` 另見 §3）、`failure_code?`、`public_url`（**僅成功且對應批准版時才有**） | — | — |

**部署結果**：`succeeded` 才更新 `public_listings.live_deployment_id`；`failed`／`unknown`（逾時）→ **不顯示成功網址、保留舊公開版**，並排入核對工作；重試**不得部署未批准內容**（每次重試重驗雜湊與批准）。

## 2. 公開入口與生命週期（page 軸）

| # | 端點 | 授權 | 輸入 | 回應 | 備註 |
| --- | --- | --- | --- | --- | --- |
| U-1 | `POST /api/v1/listings/{id}/withdraw` | 作品擁有者（學生撤回） | `{}` | `200`；`page_state→stopped(student_withdrawn)`；`202` 非同步移除託管入口 | 稽核；可重新提交（新申請） |
| U-2 | `POST /api/v1/listings/{id}/takedown` | 有審查權限的教師／管理員 | `{ reason_code }` | 同上；`stopped(staff_takedown)` | 稽核 |
| U-3 | `GET /api/v1/listings/{id}` | 擁有者／審查者 | — | `page_state`、`page_stop_reason`（**分開標示**：學生撤回／教師管理員下架／帳號停用／學校核准狀態）、~~`ai_state`~~（首版不適用：作品無執行時 AI，欄位不回傳或固定為 `n/a`；原文保留作歷史）、停止時間；文案「恢復核准後不會自動公開，須重新審查及部署」依原因出現 | **停止後恢復公開的唯一路徑＝新的申請→審查→部署成功** |

> 學校撤回／失效、帳號停用、標記刪除造成的停止，由 [access-and-lifecycle.md](./access-and-lifecycle.md) §2、§4 的交易觸發，**不經 U-1／U-2**。

## 3. 作品託管中介層（Works Edge；獨立網域、獨立 Vercel Team；僅唯讀〔2026-10-21 現行定義：不持有資料庫憑證與 AI 金鑰、自身不存資料；額外轉送作品資料請求，見 §3.3。**第九輪更正**：works-edge 持有可簽署狀態查詢、預覽與作品資料轉送請求的專用 HMAC 金鑰，**不是「無憑證」**，見 §3.5〕）

| 項目 | 規定 |
| --- | --- |
| 位址 | `https://{public_slug}.{works_domain}/`；`works_domain` 為專用可註冊網域（**非平台主網域子網域**；PSL 登錄為上線待辦 K-06） |
| 請求處理 | 以 `Host` 取 `public_slug` → 查 **listing 狀態快取**（TTL＝PP-01，建議 ≤60 秒；快取未命中則查唯讀狀態端點 `GET {platform}/internal/works/{slug}/state`，HMAC 簽章，僅回 `{ page_state, deployment_id, artifact_ref, etag }`）→ `live` 才提供檔案；否則 `410 Gone`＋靜態說明頁（文字依停止原因：**學校核准、帳號、學生撤回、教師／管理員下架分開表述**；不洩漏學生身分） |
| 檔案來源 | 已核准部署的靜態產物（以 `content_hash` 驗證）；**不使用長效簽名 URL** |
| 標頭 | `X-Robots-Tag: noindex, nofollow`；`Content-Security-Policy`（`default-src 'self'`；`connect-src 'self'`〔首版**不含任何生成式 AI 端點**；~~`{public_ai_gateway}`~~ 已被取代・首版不適用，原文保留作歷史〕；`form-action 'self'`；`base-uri 'self'`（2026-10-21 新增；`form-action`、`base-uri`、`frame-ancestors` 不回退到 `default-src`，須明列）；`frame-ancestors 'none'`；整組取自共用 `works_csp_policy`，見 §3.2）；`Referrer-Policy: no-referrer`；`X-Content-Type-Options: nosniff`；`Cache-Control: public, max-age=0, must-revalidate`（不讓 CDN 長期保存已下架內容；作品資料路徑 §3.3 的回應改為 `no-store`）；`robots.txt` 禁止收錄；**不由平台設定任何 cookie** |
| 憑證權限 | 中介層**不持有**資料庫 service role 或任何資料庫連線憑證、AI 金鑰；**持有**三把**專用且彼此獨立**的 HMAC 金鑰（狀態查詢、預覽 §3.1／§3.4、作品資料請求 §3.3），用於簽署對平台內部端點的請求，以及「讀取已發布產物」的受限能力；與平台專案**不共用環境變數**。**HMAC 金鑰外洩或 works-edge 被入侵，可能影響所有作品資料集**；平台端逐請求重驗、受限 RPC、輪替與稽核的責任見 §3.5。 |
| 下架雙保險 | （i）狀態快取 TTL（上界可量測）＋（ii）託管供應商 API 移除網域／刪除部署（非同步）；實際延遲以 quickstart S-07 量測，**核定值待 D-08** |
| 訪客資料 | 不蒐集姓名、電郵、電話、帳號；一般存取日誌可能由託管供應商產生——**文件不得宣稱「無任何個資或日誌」**（FR-048） |
| 公開頁表現 | 不顯示作者暱稱（PD-10 建議未批准，預設不顯示）；不提供要求登入或個資的欄位；~~C 級 AI 輸入欄旁顯示個資提示（措辭待 D-13 審閱）~~【已被取代・首版不適用（2026-10-21 範圍決定）；原文保留作歷史；公開頁無 AI 輸入欄】 |

### 3.1 【歷史架構，預覽埠代理已被 X 取代】私人預覽頁的瀏覽器連線限制

| 項目 | 規定（設計提案；細節待 Tasks 展開） |
| --- | --- |
| 提供限制的層 | **Works Edge 的「預覽模式」**（同一個 works-edge 可部署單元，**不新增第四個單元**），掛在專用 `preview_domain`（與 `works_domain`、平台主網域皆不同的可註冊網域；沿用 research.md R-13 的預覽來源）。預覽請求一律經此層反向代理到沙箱預覽埠，**限制標頭由此層在回應離開時附加或覆寫**。**不由沙箱內的學生程式、開發伺服器或頁面內 `<meta>` 提供**：這些內容由學生控制，可省略或改寫標頭，不能作為限制來源 |
| 標頭 | 與 §3 公開頁取自**同一份 `works_csp_policy`**（`packages/core` 純函式；公開頁與預覽共用，避免兩份漂移；指令集見 §3.2）：`default-src 'self'`；`connect-src 'self'`（**不含任何生成式 AI 端點**）；`form-action 'self'`；`base-uri 'self'`；`frame-ancestors`（**公開頁＝`'none'`；預覽＝僅限設定中明確列出的平台 origin**，兩者由 `works_csp_policy` 的模式參數區分，見 §3.4；~~預覽預設 `'none'`~~ 已因 UX §9.1 右側互動預覽而取代）；另 `X-Content-Type-Options: nosniff`、`Referrer-Policy: no-referrer`、`X-Robots-Tag: noindex, nofollow`；預覽為私人內容，`Cache-Control: no-store`（與公開頁不同）；~~**不設任何 cookie**~~（原文保留作歷史；~~第八輪：不設任何平台 cookie，唯一例外為 host-only 預覽會話 cookie~~ **第九輪撤回該例外**：預覽模式**不設任何 cookie**，預覽會話改為 §3.4 的 `preview_id` 主機名機制）。上游已帶 `Content-Security-Policy` 者一律以平台版**覆寫**；所有回應（HTML、腳本、Worker 腳本、錯誤頁）皆附加 |
| 權杖與目標 | 沿用 projects-agent-sandbox E-3／§5：60 秒短時簽名權杖（**第九輪：一次性，僅供首次兌換**，見 §3.4），僅擁有者與被授權教師於**簽發當下**由平台確認，審查時綁申請版快照。權杖驗證與沙箱目標解析採與 §3 相同的「HMAC 簽章內部端點」模式（提案）；**瀏覽器不取得沙箱內部位址**；預覽模式與狀態查詢使用**不同的 HMAC 金鑰**；與公開模式相同，**不持有 service role／資料庫憑證／任何 AI 金鑰**，但**持有預覽專用 HMAC 金鑰**（§3.5）；不使用長效簽名 URL |
| 預覽來源與預覽會話（第九輪改寫；〔Plan 提案，尚未驗證；請教育者於定稿審閱時一併確認〕） | 每個預覽會話使用獨立主機名 `https://{preview_id}.{preview_domain}/`，一次性權杖兌換後以該主機名本身作為會話憑證，**不使用 cookie**；完整規定（嵌入、兌換、子資源、資料 API、過期、撤銷、殘餘風險）見 **§3.4**。~~（第八輪原文，已撤回）60 秒權杖只用於首次導覽的兌換；兌換成功後 works-edge 以 `302` 移除網址中的權杖，並發出 host-only（不帶 `Domain`）、`HttpOnly; Secure; SameSite=Lax` 的預覽會話 cookie……無此會話 cookie 或已過期者，所有預覽請求一律 `403`。~~ **撤回理由**：`preview_domain` 與平台為不同可註冊網域，右側預覽屬跨站 iframe；`SameSite=Lax` cookie 依規範不隨跨站 iframe 的導覽與子資源請求送出，改 `SameSite=None; Secure`（含 `Partitioned`）則取決於各瀏覽器的第三方 cookie／分割儲存政策，**尚未實測，不得當作可用** |
| 成立前提（〔尚未驗證；尚未實測〕） | 沙箱預覽埠**不可讓瀏覽器繞過預覽模式直接連線**（所選沙箱供應商的埠暴露方式與存取限制尚未查證，併入 quickstart S-05、V-53）。**判準**：自沙箱外、不帶權杖，以供應商提供的任何預覽位址／埠直接連線，**必須全部失敗**；任一可達（含公開可猜測的供應商預覽網址）即前提不成立；`startPreview` 回傳之供應商位址只交給 works-edge，**不得出現在瀏覽器可見的回應、網址或日誌**。**此前提目前不得寫成已通過**。前提無法成立時，本設計不成立：列出差異與影響交教育者決定，**不自行更換沙箱供應商或改採其他設計** |
| 限制的邊界（不宣稱保證） | `connect-src` 只約束頁面內的 `fetch`／XHR／WebSocket／EventSource／`sendBeacon`；**不涵蓋**頁面導覽（連結、`window.open`、`location`）、WebRTC 等其他途徑（**2026-10-21 起：表單提交另由 `form-action 'self'`、`<base>` 另由 `base-uri 'self'` 約束，見 §3.2；仍只是瀏覽器端限制**），也管不到使用者端瀏覽器擴充或本機網路路徑；標頭**不能偵測**原始碼含 AI 呼叫，只能使瀏覽器內的連線失敗。因此**不宣稱僅靠標頭即可攔截所有繞道**，仍須與環境層（無金鑰、無代理端點、出站封鎖）、Agent 層、審查層共同約束（7.9） |
| 尚未定案 | ~~預覽 UI 若需內嵌（`iframe`）於平台頁，`frame-ancestors` 的處理屬另案（預設比照 §3 為 `'none'`；UX 文件未定義內嵌）；此項不影響連線限制的等效性~~（第八輪原文；**第九輪已取代**：教育者已同意保留 UX §9.1 右側互動預覽，嵌入方式、`frame-ancestors` 與預覽會話見 §3.4；仍待教育者批准設計） |

### 3.2 共用 `works_csp_policy` 與表單／導航流程核對（2026-10-21 Plan 技術設計；〔規劃，尚未實作、尚未驗證；教育者尚未批准〕）

| 項目 | 規定 |
| --- | --- |
| 單一來源 | 公開頁（§3）與預覽（§3.1）的 CSP 一律由 `works_csp_policy`（`packages/core` 純函式）產生，兩處不各自手寫。**第九輪：函式以模式參數區分兩者的 `frame-ancestors`**（`mode: "public"`＝固定 `'none'`，此模式不接受任何 frame 來源參數；`mode: "preview"`＝取自部署設定的明確平台 origin 清單，缺失或格式不符則 fail-closed 為 `'none'`；細節與測試見 §3.4），其餘指令兩模式相同 |
| 現行指令集 | `default-src 'self'`；`connect-src 'self'`；`form-action 'self'`；`base-uri 'self'`；`frame-ancestors`（公開＝`'none'`；預覽＝僅明確的平台 origin，§3.4）。**不新增任何跨源來源（`connect-src`／`form-action`）、不使用萬用字元、不含任何生成式 AI 端點**；`connect-src 'self'` 已涵蓋 §3.3 的同源作品資料路徑 |
| 評估結論 | 依下表逐項核對，**未發現會阻斷已批准 A／B 功能的流程**，故採用 `form-action 'self'`、`base-uri 'self'`。**此結論以 §3.3 的同源設計為前提**：若 Work Data API 或 β2 端點改為跨源，原生表單提交與 `fetch` 都會被阻擋，須回到設計並由教育者審閱，不得默默縮減 B 級 |

| 流程（現行公開頁／私人預覽） | 對 `form-action`／`base-uri` 的影響 | 結論 |
| --- | --- | --- |
| A 級靜態頁互動：JS 事件、`localStorage`／IndexedDB、同頁或同源表單（含 `GET` 查詢列） | 同源，不受影響 | 保留 |
| B 級 β1 讀寫作品資料：`fetch`／XHR，或原生 `<form method="post">` 送往 `/_work/data/v1/*` | 同源（§3.3），不受影響 | 保留；此為採同源設計的原因之一 |
| B 級 β2 受限伺服器端端點 | 預留同源 `/_work/fn/v1/*`（§3.3）；路由與執行環境待 S-13 | 不受影響；若 S-13 結果要求跨源，須在 `connect-src` 與 `form-action` 明列專用主機名並回教育者審閱，**本輪不定案** |
| 向第三方提交表單（外部問卷、第三方登入、`mailto:` 表單） | 被阻擋 | 非已批准功能：FR-048 不蒐集可識別訪客資料、需訪客登入的 B 級首版不公開、沙箱與 β2 出站全封鎖；`<a href>`（含 `mailto:` 連結）不受影響 |
| 需訪客登入／帳號的 B 級於私人預覽 | 外部身分供應商的表單與重導被阻擋 | 預覽沙箱本即 `network:"none"`，外部登入本來就不可行；預覽仍可呈現同源介面，不是新增的功能損失 |
| 頁面導覽：連結、`window.open`、`location` | 兩指令皆不涵蓋 | 維持不受限，**不宣稱已攔截**（§3.1 邊界） |
| `<base>` | 僅同源 `href`；框架產生的同源 `<base href="/">` 或 `base` 路徑設定不受影響；指向外部者被阻擋 | 保留 |
| 預覽權杖兌換 | 由平台頁 iframe 以 `GET` 載入 `/_work/preview/redeem?t=…`（§3.4），套用的是載入後預覽文件的 CSP；不使用跨頁表單 `POST` | 不受影響 |
| 預覽於平台頁 iframe（含 `sandbox="allow-scripts allow-same-origin allow-forms allow-modals"`）內執行（第九輪） | 與 `form-action`／`base-uri` 無關；但 `sandbox` 不含 `allow-popups`、`allow-top-navigation`：`window.open`、`target="_blank"`、頂層導覽被擋；跨站 iframe 內作品自身的 `localStorage`／IndexedDB 受瀏覽器分割或封鎖政策影響，可能與公開頁（頂層）行為不同〔尚未實測〕 | 只記錄（V-53(j)、(o)）；若阻斷已批准 A／B 流程，記錄差異並交教育者決定，不默默縮減 B 級 |
| 410／停止說明頁、錯誤頁 | 靜態、無表單 | 不受影響 |
| 預覽開發伺服器的同源 WebSocket（熱更新） | 屬既有 `connect-src 'self'`，非本輪新增；`'self'` 是否涵蓋 `ws:`／`wss:` 依瀏覽器版本而異〔尚未驗證〕 | 只記錄結果（V-53）；若影響預覽體驗，交 Tasks 以同主機明確來源處理，不涉外部來源 |

**限制**：`form-action` 為瀏覽器端限制，不支援或被使用者端擴充改變的環境不保證生效；V-53 須記錄實測的瀏覽器與版本。

### 3.3 作品資料服務（Work Data API）的同源請求路徑（路徑現行；授權依 §3.7）

> **D-23 現行覆寫**：同源路徑 `/_work/data/v1/*`、保留前綴及平台受限資料操作仍為現行；本節舊版 Host-only／無 cookie 預覽授權及 works-edge 資料 HMAC 簽章列為**歷史**，不作實作依據。A1／B2 的唯一授權與信任規則見 §3.7。

| 項目 | 規定 |
| --- | --- |
| 決定 | Work Data API 採**同源**：公開頁與預覽頁一律呼叫**自己 origin** 下的保留路徑 `/_work/data/v1/*`，**不使用跨源、不為它新增 `connect-src`／`form-action` 來源**。取代 research.md R-07 第 7 點「`connect-src` 含經核定的 B 級 Work Data API／受限服務端端點」可能指向專用跨源來源的敘述（該原文保留作歷史） |
| 原先的衝突 | 原文件未定義 API 所在 origin：data-model §5.4 的 `work_data_stores` 屬平台資料庫；本契約 §3 規定 works-edge 不持有資料庫憑證且 `connect-src 'self'`；research R-07 第 7 點卻列「經核定的 Work Data API」。本節收斂為同一設計 |
| 路徑 | 公開：`https://{public_slug}.{works_domain}/_work/data/v1/*`；預覽：`https://{preview_id}.{preview_domain}/_work/data/v1/*`。`/_work/*` 為**保留前綴，路由優先於靜態檔與沙箱檔案**；除 `data/v1` 與預留的 `fn/v1` 外，`/_work/*` 回 `404`；其下**無任何 AI 路由**（§7.2）。作品程式以**相對路徑**呼叫，同一份程式於預覽與公開皆可運作（Agent 須告知，見 projects-agent-sandbox §3） |
| 轉送責任：works-edge | **路徑／協定摘要**：僅接受核准方法與 JSON，剝除不應轉送的用戶端標頭，不快取或保存作品資料，回應 `Cache-Control: no-store`。預覽每筆請求先依 §3.7 A1 驗證預覽 cookie／伺服端狀態；資料授權採 §3.7 B2。舊「只由 Host 授權」及「works-edge 以全域資料 HMAC 任意簽章」為歷史。 |
| 資料服務：平台 `apps/web` | 內部公開／預覽端點維持同源路徑映射；平台逐請求驗證作品 live 狀態、B2 單作品／用途授權、到期、撤銷版本、PP-26 配額及限流，再交由僅能存取作品資料表的受限 RPC。預覽另逐請求驗證 A1 會話並使用 `preview_id` 隔離資料集。平台不可達、授權更新失敗或政策未核定時均拒絕；端點不含 AI 路由。 |
| 讀寫授權 | **公開**：不要求訪客登入／識別；每筆操作仍須有效 B2 單一作品與用途授權及平台逐請求重驗。**預覽**：須具有效 A1 會話；資料落於預覽專用暫存命名空間，與公開資料集隔離，會話結束清除；不得以 hostname 單獨授權或觸及其他作品資料。 |
| 為何不採跨源 | 作品頁（不受信任的 JS）直連平台 origin 需開 CORS，並須在 `connect-src`／`form-action` 加入平台專用來源，擴大作品與平台的邊界，原生表單也將失效；訪客流量直接落在平台 Team，削弱 R-07 設獨立 works Team 的花費隔離。**同源不代表資料請求完全脫離平台用量**：請求仍會抵達平台端點，works-edge 的預先過濾與每作品配額只是限縮；實際請求量與費用〔尚未實測〕（V-53 記錄）。日後若須跨源，須明列專用主機名（不使用萬用字元）、說明驗證方式並回教育者審閱 |
| 與 works-edge 職責的一致性 | 「唯讀」的現行定義＝不持有資料庫憑證與 AI 金鑰、自身不存資料、不直接讀寫平台資料庫，**不是**不轉送寫入請求，也不是「無憑證」。works-edge 負責轉送作品資料請求；原「持專用資料 HMAC 金鑰」及「可對所有作品資料集讀寫」是歷史信任模型，已由 D-23／B2 取代：works-edge 不持有簽署私鑰／全域資料 HMAC，僅使用單作品、用途受限的有效授權；平台每次請求仍重驗作品 live、授權、配額與限流。殘餘風險是 works-edge 遭入侵且持有多個上線作品有效授權時，仍可能觸及那些作品；不得宣稱完全阻止跨作品濫用。更完整信任規則見 §3.7。 |
| β2 預留 | `/_work/fn/v1/*` 預留給 B 級受限伺服器端端點；路由目標與執行環境待 S-13 與教育者核定；瀏覽器端仍僅連同源。**本輪不決定 β2 執行環境** |
| 待展開（不在本輪定案） | 端點 schema、配額數值；訪客自由輸入內容可能含個資，作品資料的保存期限、下架後清除、內容審核規則尚未定義（FR-048 僅規範「不主動蒐集」）；訪客層級限流的實作（Vercel WAF／Rate Limiting 方案與費用未查證，R-07），目前平台端僅有每作品配額作底線 |

### 3.4 【歷史方案，已被 D-23／A1 取代】右側互動預覽的嵌入與預覽會話

| 項目 | 規定 |
| --- | --- |
| 要解決的衝突 | （1）UX §9.1 要求工作區右側互動預覽，而原 §3／§3.1 為 `frame-ancestors 'none'`；（2）`preview_domain` 與平台為不同可註冊網域，內嵌即**跨站 iframe**，原「host-only、`SameSite=Lax` 預覽會話 cookie」不可依賴：`SameSite=Lax` cookie 不隨跨站 iframe 的導覽與子資源請求送出；改 `SameSite=None; Secure`（含 `Partitioned`）則取決於各瀏覽器與版本的第三方 cookie／分割儲存政策，**尚未實測，不得當作可用**；Storage Access API 需使用者互動與瀏覽器許可，不適合 G4–6 且各瀏覽器不一，亦不採用。**本設計不使用任何 cookie，也不要求瀏覽器端儲存** |
| 嵌入方式 | 平台工作區右側面板以 `<iframe src="https://{preview_id}.{preview_domain}/_work/preview/redeem?t={一次性權杖}">` 嵌入（「放大」由平台版面放大同一 iframe，不另開來源）。iframe 屬性：`sandbox="allow-scripts allow-same-origin allow-forms allow-modals"`（**不含** `allow-top-navigation`、`allow-popups`，使學生程式不能導覽或接管平台頁；`allow-same-origin` 只讓預覽維持**自己**的 origin，使其 `localStorage` 與 §3.3 同源 `fetch` 可運作，預覽 origin 與平台 origin 不同，故不等於同源於平台；`allow-modals` 使初學者常用的 `alert`／`confirm` 可用）、`allow=""`（不授予任何瀏覽器權限）、`referrerpolicy="no-referrer"`。平台頁 CSP 的 `frame-src` 僅允許 `https://*.{preview_domain}`（萬用字元只用於平台自己的來源清單，不用於預覽的 `frame-ancestors`）。平台與預覽之間**不建立 `postMessage` 通道**，不傳遞任何憑證；預覽狀態（到期、版本）一律由平台頁向平台 API 取得 |
| 公開與預覽的 `frame-ancestors` | `works_csp_policy` 以模式參數區分：`mode: "public"`＝固定 `frame-ancestors 'none'`，**此模式的函式簽章不接受任何 frame 來源參數**；`mode: "preview"`＝`frame-ancestors {platform_frame_origins}`，值**只來自部署設定**的明確清單（預設一個：該環境平台的完整 `https://` origin；不得含 `*`、單獨 scheme（如 `https:`）、`data:`、`works_domain`／`preview_domain` 下任何主機，亦不得由請求內容、`Referer`、`Origin` 標頭或學生程式決定）；設定缺失、為空或格式不符時 **fail-closed 為 `'none'`**（預覽無法嵌入並顯示錯誤，不放寬、不改採其他來源）。其餘指令兩模式相同（§3.2）。預覽**不另送 `X-Frame-Options`**（無法表達來源清單，且會與 CSP 衝突）；預覽模式的所有回應（HTML、腳本、Worker、redeem 回應、`403`／`404` 說明頁）皆附此標頭；上游標頭一律覆寫。單元測試：公開模式永遠 `'none'`；預覽模式只輸出清單內來源；萬用字元與非 `https` 來源被拒 |
| 預覽會話的單位 | 一個「預覽會話」＝一個 `preview_id`：≥128 位元隨機（單一 DNS 標籤，≤63 字元）、**每次開啟簽發新值**、綁沙箱＋預覽版本（審查預覽＝申請版快照）＋授權主體＋到期。**主機名即憑證（capability）**：`https://{preview_id}.{preview_domain}/`；無 cookie、無 `Authorization`。同一沙箱可同時有多個會話，各自為不同 origin（預覽之間、與 `works_domain`、與平台皆不同源，使一位學生的預覽程式無法借教師瀏覽器讀取其他預覽）。平台資料庫保存 `preview_id` 的**雜湊**、狀態（`issued｜active｜expired｜revoked`）、授權主體、`expires_at`（欄位待 data-model 展開；〔尚未建立任何資料表〕） |
| 首次兌換 | （1）已登入的擁有者或被授權教師在平台頁觸發 E-3（以平台 session 授權；[projects-agent-sandbox.md](./projects-agent-sandbox.md) E-3）→ 平台建立會話（`issued`），回傳 `preview_id` 與 **60 秒、一次性**兌換權杖；（2）iframe 以 `GET` 載入 `/_work/preview/redeem?t=…`（此路徑僅預覽模式存在，為 §3.3 保留前綴 `/_work/*` 下的預覽專用例外；公開模式的該路徑仍回 `404`，且仍無任何 AI 路由）；（3）works-edge 以**預覽 HMAC 金鑰**簽章呼叫平台內部端點兌換：平台驗權杖（簽章、60 秒內、綁此 `preview_id`），**原子標記已使用**，會話轉 `active`，回 `{expires_at, 沙箱目標引用}`；重複使用、逾時、綁錯 `preview_id` 一律 `403`；（4）works-edge 回 `302 Location: /`（網址不含權杖；`Cache-Control: no-store`、`Referrer-Policy: no-referrer`），**不發任何 cookie**。未兌換（`issued`）的 `preview_id` 請求其他任何路徑一律 `403` |
| 子資源與重新整理 | 同一主機名下的所有請求（HTML、腳本、樣式、圖片、Worker、預覽開發伺服器 WebSocket、重新整理、頁內導覽）**不需權杖也不需 cookie**：works-edge 只以 `Host` 取得 `preview_id`，查平台內部「預覽會話狀態」端點（HMAC；回 `{state, expires_at, 沙箱目標引用}`；**短 TTL 快取**，數值待核定，建議不長於 PP-01），`active` 且未逾期才反向代理，否則 `403`。未知、未兌換、已過期、已撤銷的回應**不可區分**（同一 `403` 說明頁，不洩漏 `preview_id` 是否存在）；WebSocket 升級同此判斷 |
| 資料 API | §3.3 的 `/_work/data/v1/*` 與預覽同源，身分只由 `Host` 決定，works-edge 以資料金鑰簽章轉送；平台端**每次請求重驗**會話 `active`、未逾 `expires_at`、未撤銷（不使用 works-edge 快取）。資料命名空間以 `preview_id` 為鍵：**每個會話各自一份，會話結束即清除**；重新開啟＝新會話＝空白資料（此為設計後果，UX 須提示；教師審查時不得輸入真實個資）。不讀不寫任何公開作品資料 |
| 過期與延長 | 絕對到期 `expires_at`＝min(沙箱 `ttl_seconds`、預覽會話上限；上限數值待核定)。到期後平台資料請求立即拒絕，works-edge 於快取 TTL 內停止服務。**延長**：平台頁（已登入）呼叫平台 API 延長 `expires_at`（不得超過沙箱 TTL 與絕對上限），只更新伺服端狀態，**不經 iframe、不需瀏覽器端憑證**；平台頁於到期前提示，到期後顯示「預覽已結束」並提供「重新開啟」（簽發新 `preview_id`；編輯中草稿不受影響，E-2） |
| 撤銷 | 觸發：使用者關閉預覽或離開專案頁（盡力而為）；同一主體於同一專案開新預覽（預設撤銷其舊會話）；教師授權綁定解除；擁有者或教師帳號停用／刪除；專案刪除；審查決定或申請撤回（審查預覽）；沙箱 `destroy`／逾期（Worker 必呼叫）；管理員手動撤銷。效果：平台將會話標為 `revoked`；**資料 API 立即失效**；**靜態與沙箱內容於 works-edge 狀態快取 TTL 內失效**（上界＝TTL，實際延遲於 V-53(m) 量測）；沙箱 `destroy` 後內容無從服務。**不宣稱能遮斷已載入於瀏覽器的頁面內容** |
| 安全性質與殘餘風險（不宣稱已解決） | 取得有效 `preview_id` 者，在會話有效期間即可載入該預覽並讀寫其暫存資料（跨站 iframe 無可靠的瀏覽器憑證通道，故無法綁定瀏覽器身分）。曝險面：網路、學校 DNS 或代理日誌可見主機名（SNI）；學生程式可將自身 `location` 透過導覽送出（`connect-src` 不涵蓋導覽；該預覽內容本即學生自己的作品）。緩解：≥128 位元隨機；須先以一次性權杖兌換才啟用；短 TTL 且可撤銷；`no-referrer`、`no-store`、`noindex`；**應用日誌只記 `preview_id` 雜湊**；資料集逐會話隔離。**請教育者於定稿審閱時確認可接受此「主機名即憑證」的殘餘風險** |
| 前提與唯一阻擋點（〔尚未驗證；尚未實測〕） | 前提：（i）`preview_domain` 可在 works Team 啟用**萬用字元網域與涵蓋它的 TLS**（research.md：萬用字元網域須 Vercel Nameservers），使隨機 `preview_id` 主機名可解析；**不得為每個預覽單獨申請憑證**（避免經憑證透明度紀錄公開主機名）；（ii）「沙箱預覽埠不可被繞過」（§3.1、S-05）。**任一不成立即本設計不成立，為目前唯一的設計阻擋點**；此時列出差異與影響交教育者決定，不自行採用替代。可行替代（僅列出）：①固定單一預覽主機＋路徑前綴 `/{preview_id}/`：失去預覽間 origin 隔離，且與學生程式的絕對路徑衝突；②預覽網域改為平台主網域子網域並用同站 cookie：違反既有「預覽與平台為不同可註冊網域」的隔離要求，須修訂 research R-13；③右側僅顯示靜態快照、互動預覽另開視窗：改變 UX §9.1，教育者已要求保留，故不建議 |

### 3.6 MVP 方案 X（建置／產物／更新部分現行；授權部分依 §3.7）

本節 X 的建置、取回、檢查、不可變產物保存及「儲存→重建→重載 iframe」仍現行。原 §3.1 的沙箱預覽埠反向代理、WebSocket／HMR 與以沙箱 TTL 決定預覽到期均為歷史；預覽授權及 Work Data API 信任邊界一律依 §3.7，不依本節舊表格中的無 cookie／hostname 或全域 HMAC 描述。

| 面向 | 現行契約 |
| --- | --- |
| 建置與取回 | Sandbox `ports: []`；不啟動對外預覽埠。Worker 對快照建置，管理通道取回產物；限制出站、不注入平台或 AI 金鑰。建置成功、取回成功均不等於可服務。 |
| 入庫邊界 | 平台對整份產物核對 manifest／快照雜湊、路徑正規化、一般檔案型別、連結／絕對路徑／穿越／大小／檔數／重複路徑與 `/_work/*` 等保留路徑；任一不符整份拒絕，不部分發布。具體允許型別、檔案上限、壓縮／解壓限制與逾時需定稿前列明核定責任、實作前核定；不把 Spike 預設當已批准政策。 |
| 保存與綁定 | 平台先保存不可變的已驗證產物，再原子綁 `artifact_id＋snapshot_id＋content_hash`；只讓符合目前工作世代的結果成為新預覽，過時工作不能倒蓋新結果。審查預覽永遠綁申請版，不受工作預覽更新影響。 |
| 平台入口 | works-edge 預覽模式以有效會話查得平台產物引用，提供檔案；不回傳沙箱位址、Storage 直連 URL 或長效簽名 URL。所有 HTML／腳本／錯誤回應仍由平台覆寫安全標頭，產物無權改標頭、遮蔽保留端點或選定路由。 |
| 更新與錯誤 | E-3 回 job，UI 依 `queued／building／retrieving／validating／succeeded／failed／cancelled` 與目標／可見版本顯示；「儲存→重建→重載 iframe」，不支援開發伺服器 WebSocket／HMR。失敗保留檔案／草稿與最後成功預覽（若有）並標示舊版及原因／重試；沒有成功版本時不給假預覽。 |
| 授權與撤銷 | **歷史摘要；現行授權見 §3.7 A1。** 產物綁定與建置失敗保護仍依本節其他列；會話到期不由建置沙箱 TTL 決定。 |
| 資料與信任邊界 | **歷史摘要；現行 Work Data API 授權見 §3.7 B2。** `/_work/fn/v1/*` 在 MVP 不提供執行路由（404）；X 產物保存與資料 API 同源路徑仍保留。 |
| 必要驗證／殘餘風險 | VC-1／VC-2 未推翻 X，但正式授權、主機名憑證風險接受、萬用字元 TLS、跨區撤銷上界、目標瀏覽器、惡意產物、課堂 20 人尖峰與大產物延遲均未完成產品驗收；不能只列「埠不可繞過」為唯一阻擋點。依 quickstart S-05、V-53／V-56 驗證，不以本機 TTL 或單一 Chrome 代替。 |

### 3.5 【歷史信任模型，works-edge 全域資料 HMAC 已被 D-23／B2 取代】works-edge 的信任邊界與 HMAC 金鑰

| 項目 | 規定 |
| --- | --- |
| 準確描述 | works-edge **不是「無憑證」或「無憑證中介」**。它**持有**三把專用 HMAC 金鑰（狀態查詢、預覽、作品資料轉送；彼此獨立、與平台其他 HMAC 如登入節流 `pepper`、`safety_identifier` 皆不共用），用於簽署對平台內部端點的請求，以及讀取已發布產物的受限能力。它**不持有**：資料庫 service role 或任何資料庫連線憑證、AI 金鑰、平台 session 密鑰、部署憑證。**「沒有資料庫憑證」不等於「無法讀寫作品資料」**：持有資料金鑰者可經平台內部端點讀寫作品資料 |
| 金鑰外洩的影響（保留風險，不縮小） | **資料金鑰**：可對**任一 `live` 作品**的資料集簽署讀、寫、刪——**影響所有作品資料集**，含訪客可能自由輸入的內容（可能含個資；FR-048 僅規範不主動蒐集）；預覽資料另須知道有效的 `preview_id`（平台端驗證）。**狀態金鑰**：可探測任一 slug 的 `{page_state, deployment_id, artifact_ref, etag}`。**預覽金鑰**：對已知有效 `preview_id` 可查詢其狀態與沙箱目標引用；因兌換須一次性權杖，單憑金鑰不能啟用未兌換的會話。works-edge 被入侵（可執行任意程式）等同三把金鑰外洩，且可略過其自身的過濾規則直接簽署請求：**works-edge 的過濾不是平台端的安全前提** |
| 平台端責任 | （1）**逐請求重驗**：HMAC、時間戳窗口、Body 雜湊；slug／`preview_id` 只自路徑與簽章欄位取得並限制格式；**不信任 works-edge 傳來的狀態宣稱**，每次自行查 `live`／會話 `active` 與配額；（2）**受限 RPC**：專用低權限資料庫角色，僅能觸及作品資料表，不得讀取使用者、Auth、帳本、稽核或其他資料表，每次只接受單一 listing 或單一預覽會話範圍的參數；（3）**輪替**：三把金鑰各自獨立，支援新舊雙金鑰重疊期以免停機；定期輪替（週期待核定）與疑似外洩時立即輪替（程序與演練待 Tasks）；（4）**稽核與偵測**：每筆資料請求記錄 slug／`preview_id` 雜湊、方法、狀態碼、大小、時間（不記 Body、不記訪客 IP）；HMAC 失敗率、跨作品請求量暴增、窗口外時間戳、非預期來源時告警；（5）**配額與限流**：每作品配額底線（PP-19，未核定＝拒絕）只限縮爆炸半徑，**不能**阻止持金鑰者逐作品存取；（6）**重放**：時間戳窗口，並於 Tasks 評估 nonce；窗口內重放僅能重複同一請求 |
| 平台端不得 | 因請求來自 works-edge 即信任；於內部端點加入 AI 路由；把資料庫 service role 或 AI 金鑰放入 works-edge 環境變數；使三把金鑰互相共用或與 `apps/web` 其他 HMAC 共用 |
| 驗證 | quickstart V-53(f)（works-edge 環境變數清單）、(g)（逐請求重驗）與新增 (p)（金鑰輪替與外洩演練；合成資料；記錄「持資料金鑰可跨作品讀寫」為已知殘餘風險，**不得寫成已防住**）；全部〔尚未執行〕 |

## 4. Public AI Gateway（C 級受控公開 AI；平台網域；訪客無登入）【已被取代・首版不適用；原文保留作歷史】

> **【已被取代・首版不適用（2026-10-21 範圍決定）；原文保留作歷史】** 首版不建置 Public AI Gateway：不存在 `/public-ai/*` 路由、不注入閘道設定、不處理訪客輸入、不產生訪客高風險事件、不受理每作品／每訪客 AI 限流。下列全文（X-1、請求鏈、不變式 SC-017）**不再是現行契約或驗收承諾**；現行規則見 §7。

| # | 方法與路徑 | 授權／限流 | 輸入 | 回應 | 錯誤 |
| --- | --- | --- | --- | --- | --- |
| ~~X-1~~【歷史・首版不適用；不是現行契約】 | ~~`POST /public-ai/v1/{public_slug}/chat`~~ | ~~無使用者驗證。**授權＝`public_ai_allowed(listing)`**（data-model §5.3：作品 `live`、AI `on` 且無 hold、擁有者 `approved`、學校 `approved`、無管理員停用、預算有餘額、內容防護啟用）；**〔後續決定 2026-10-21〕另須 `duty_gate('public_c_ai').open`（有管理員值守；data-model §6.4）**；CORS 僅允許 `https://{public_slug}.{works_domain}`；限流：每訪客雜湊（`HMAC(pepper, IP)`，短 TTL，PP-08c）與每作品（PP-08c）~~ | ~~`{ messages[]（長度與回合數上限）, client_request_id }`；**不接受**附件、工具呼叫、任意模型名稱或系統提示覆寫~~ | ~~`text/event-stream`（同 ai-chat 的 `delta／block／support／done／error`，**但無 `partial` 的續傳**）~~ | ~~`503 public_ai_paused`（文字「這個作品的 AI 暫時休息」：涵蓋 hold、停用、達作品上限、池用盡；**〔後續決定 2026-10-21〕亦涵蓋非值守時段或值守設定未核定（內部原因碼 `off_duty`／`duty_unset` 等）**；**不區分細節以免洩漏營運資訊**，管理員另可在管理中心看到原因碼）；`429 rate_limited`；`404`（slug 不存在或非 live）；`422`（超長）~~ |

**請求鏈（固定順序；【歷史・首版不適用；不是現行契約】）**：~~授權（**含值守閘門；後續決定 2026-10-21，被擋者不扣額度、不呼叫分類器或模型**）→ 限流 → 輸入規則（個資樣式攔阻、長度）→ Moderation（文字）→ 求助／高風險分類 → **若高風險：回固定求助引導，不呼叫模型，建立最小事件（作品、時間、類別），通知平台管理員（站內）**；否則 → 預留額度（公開池＋作品上限；同一交易）→ 呼叫模型（`store:false`；`max_output_tokens` 上限；指定受限模型白名單）→ 輸出逐句 Moderation → 結算／釋放。~~

**不變式（SC-017 原文；【歷史・首版不適用】，現行不變式見 §7）**：~~金鑰 0 次出現在作品前端、作品檔、下載檔、日誌、回應（建置與發布掃描）；達作品上限或公開池上限後 0 件新增付費請求通過且 0 件動用創作池；管理員停用生效後 0 件新請求通過；**〔後續決定 2026-10-21〕非值守時段或無管理員值守時 0 件新增請求通過；**控制關卡未完成時 0 個作品被標示為「C 級已完整 Launch」。~~（其中「金鑰 0 次出現」的精神於首版保留為 §7 驗證項目（1）與 quickstart V-31；其餘不適用。）

## 5. 管理員公開 AI 控制【已被取代・首版不適用；原文保留作歷史】

> **【已被取代・首版不適用（2026-10-21 範圍決定）；原文保留作歷史】** 首版無公開 AI，K-1～K-4 不實作；K-3 的「七項控制驗證」不再是首版上線關卡（金鑰掃描的精神見 §7 不變式）。

| # | 端點 | 授權 | 行為 |
| --- | --- | --- | --- |
| K-1 | `POST /api/v1/admin/listings/{id}/public-ai/disable｜enable` | 管理員 | 單作品停用／啟用；立即生效（下一請求）；稽核；`enable` 仍受 §4 全部閘門限制 |
| K-2 | `POST /api/v1/admin/platform/public-ai/disable｜enable` | 管理員 | 全平台公開 AI 開關；稽核 |
| K-3 | `POST /api/v1/admin/platform/public-ai/gate-verification` | 管理員 | 記錄七項控制（授權、限流、預算、隔離、內容防護、停用、金鑰掃描）的驗證結果引用；**全部通過且教育者批准階段後**才允許任何作品 `ai_state=on`；此端點記錄「驗證事實」，**不代替教育者批准**。**〔後續決定 2026-10-21〕值守閘門不屬於七項控制，是獨立的開放前提（S-9 設定；未核定＝關閉）；七項全部通過仍不代表公開 AI 對訪客可用，且不改變 `ai_state`** |
| K-4 | `POST /api/v1/admin/listings/{id}/public-ai/test` | 管理員 | 已部署公開作品的 AI 測試：`purpose=admin_public_work_test`，計入公開池與該作品上限（**不得改用創作池**）；用盡則阻擋；沿用 §4 受控路徑，**不設旁路** |

## 6. 【歷史方案，已被 D-23 取代】B 級公開（D-16：β2 首版功能目標）
> **2026-10-21 最新 MVP 現行補訂**：本節下方 β2 首版批准與開放條件保留作歷史，**已被本次 MVP 範圍決定取代**。MVP 只公開不需執行學生伺服器程式的合格 B；Work Data API 由平台受限服務處理，不是學生 runtime，資料配額依 PP-26，未核定即拒絕。需 β2 者按 R-1／R-2／R-6 現行碼拒絕；不得以靜態頁假裝提供其伺服器功能。β2 的 JSON handler、M／W、runtime profile／gate／執行配額皆留後續獨立 feature 規格與 Gate；本 MVP 不建立、不啟用。其他訪客識別排除、審查／版本／下架／無 AI 規則維持。

> **歷史註記（D-23）**：本節保留 2026-10-21 首版範圍決定當時 β2 為首版目標的原文與批准歷史；其 MVP／首版公開執行適用範圍後被取代。學生伺服器公開執行另立 feature，不屬 MVP 實作或 Gate；本節不得作為 MVP Tasks 或驗收依據。MVP 現行採 X 與 B2，唯一現行規則見 §3.7。
**範圍**：β1＝靜態前端＋平台 Work Data API（較簡單作品）；β2＝每作品受限的伺服器端程式能力＋Work Data API（`runtime_kind=restricted_server`，B 級首版功能目標）。**已批准排除僅限 `needs_visitor_identity=true`**；其餘 B 級不得因先交付 β1 而被默默排除（以 `b_restricted_runtime_pending` 呈現並計入範圍追蹤，見 data-model §5.4）。

**β2 功能邊界（教育者 2026-10-21 後續決定，見 decision-register D-16）**：首版 β2＝**JSON 請求／回應處理＋Work Data API**；**不含** WebSocket、SSE、常駐程序、背景工作；仍保留時間、記憶體、出站、儲存、次數限制；**不得以靜態作品替代**。呼叫路徑首選為 RESULTS-beta2-call-path 的 M（待供應商驗證；W 僅在 M 被推翻後交教育者決定）。

**本契約目前保證（與配額數值無關）**：
1. `needs_visitor_identity=true` 者不可提交（R-1 blocker）。
2. 任何 B 級公開資源皆**不得持有平台憑證**、不得連到平台資料庫或內部網域；**出站預設全封鎖**；皆受配額與限流；費用歸基礎設施池並受監測（不歸公開 AI 池）。
3. **不得假設一般平台 Function 可安全執行不受信任的學生程式**：執行環境須通過 quickstart S-13（隔離、出站、時間、記憶體、儲存、請求次數、費用、供應商適用性）並經教育者核定（`platform_flags.restricted_runtime_gate`），之前 `restricted_server` 的部署一律被拒。
4. 每作品的 `work_runtime_profiles` 欄位**未設定＝fail-closed**（PP-19 未核定）。
5. 部署仍須審查、`content_hash` 驗證與下架雙保險（§3），B 級資源亦受 `listing.page_state` 即時控制（停止即不再服務）。

**待展開（β2 驗證後）**：~~Work Data API 的端點與授權模型~~（**請求路徑、轉送責任與讀寫授權已由 §3.3 定義〔2026-10-21；規劃，尚未實作、尚未驗證〕**；端點 schema 與配額數值仍待展開）、受限函式的呼叫契約。**若 β2 無法安全、可負擔交付：記錄證據與影響，退回教育者作範圍決定；本契約與 Plan 不自行縮減範圍。**

## 7. 作品不得呼叫生成式 AI（2026-10-21 首版範圍決定；現行規則，取代 §4～§5；Plan 提案，待教育者審閱，尚未實作）

**依據**：spec.md FR-049（現行規則）、Clarifications R1～R4、US 14 情境 15～17、AC-27。**範圍**：所有公開作品（A 級靜態頁；B 級 β1／β2）與其審查、部署。

| # | 規定 |
| --- | --- |
| 7.1 等級 | 公開作品僅 **A／B**；`tier` 非 A／B 之申請一律 `422 tier_not_supported`（R-1、R-2）。學生使用平台 AI 製作作品**不使作品升級為 C**。 |
| 7.2 靜態公開頁（Works Edge） | 公開靜態頁**不注入任何 AI 金鑰**；`connect-src` 不含任何生成式 AI 端點且僅限同源（含 §3.3 作品資料路徑，不列任何跨源來源）（§3）；平台**不提供**可供作品呼叫的 AI 代理端點（無 `/public-ai/*`，路徑回 `404`）。 |
| 7.3 B 級受限伺服器端環境（§6） | 與 §6 第 2 項一致：**不注入 AI 金鑰**（`env` 僅限非敏感、每作品專屬變數）、**不提供平台 AI 代理端點**、**出站不開放至生成式 AI 服務**（預設全封鎖，白名單不得列入生成式 AI 服務網域；亦不得以第三方 AI 外掛、代理或平台金鑰繞道）。β2 的其他能力與配額待驗證項目不變。 |
| 7.4 審查檢核項（R-4／R-5） | 審查者須核對**申請版**程式、依賴／附帶資源、設定檔與出站設定，確認無執行時生成式 AI 呼叫（前端直呼、服務端呼叫、內嵌第三方 AI 腳本／外掛、金鑰樣式字串）；`approve` 須填 `runtime_ai_review` 全部項目。**含執行時 AI 呼叫者退回修改（`reason_code=contains_runtime_ai_call`），不得批准、不得部署。** 自動掃描（金鑰樣式、已知 AI 服務網域與套件）只可作輔助，**不取代人工核對，也不能保證發現所有執行時 AI 呼叫**（清單無法列舉所有服務；混淆、動態組字串、間接載入可能漏判）；掃描規則待 Plan 研究。 |
| 7.5 平台額度 | 作品不得成為平台 AI 額度的消耗者：usage 契約的 `public_visitor`、`admin_public_work_test` 目的首版不開放（見 [usage-and-budget.md](./usage-and-budget.md)）。 |
| 7.6 學生端 | 學生要求作品自己呼叫 AI → 說明首版不支援 C 級作品並引導 A／B 設計；規則見 [projects-agent-sandbox.md](./projects-agent-sandbox.md) §3 與 US 14 情境 16。 |
| 7.7 維持不變 | **B 級 β2 受限伺服器端能力（§6）維持不變**；**B 級需要訪客登入、帳號或蒐集可識別訪客資料者，首版不提供公開服務（`tier_b_needs_visitor_identity`）維持**。 |
| 7.8 後續版本 | 後續若要加入學生 C 級作品，須另立功能與批准流程；本契約不預留、不承諾其交付，亦不寫成「首版內稍後交付」。 |
| 7.9 共同約束與草案狀態 | 公開資格由**作品分類（`tier`，R-1／R-2 `tier_not_supported`）、審查（R-4／R-5 `runtime_ai_review`）、部署（R-6 `content_hash` 比對與 §3 標頭）及受限執行資源（7.2、7.3：無金鑰、無代理端點、出站預設全封鎖）共同約束**，不依賴任何單一控制；`tier_not_supported` 只攔截宣告為 C 的申請，**無法偵測宣告 A／B 卻含 AI 呼叫者**，後者靠其餘三者。**判定依據是申請版作品內容，不是製作過程是否使用平台 AI**：學生用平台 AI 對話、輔助創作或 Coding Agent 編寫作品，不得被誤判為作品具有 C 級功能。`runtime_ai_review`、`reason_code=contains_runtime_ai_call`、`tier_not_supported`、`runtime_ai_unsupported`（暫名）、學生端說明與輔助掃描皆為**技術設計與驗證草案**（quickstart V-51～V-55）：**教育者未逐項批准、未實作、未測試**。**預覽頁瀏覽器端（2026-10-21 Plan 技術設計）**：預覽沙箱的出站限制（projects-agent-sandbox §5）管不到學生瀏覽器內的連線；預覽頁的等效 `connect-src` 限制由 **Works Edge 預覽模式**提供（§3.1），不由沙箱內學生程式提供。**此設計〔尚未實作、尚未驗證〕**：在 V-53 瀏覽器端案例取得結果、且「沙箱預覽埠不可被繞過」前提確認前，不得宣稱預覽「無 AI 途徑」已成立；標頭亦不保證攔截所有繞道（§3.1）。 |

**驗證項目（〔尚未執行〕；僅列契約層級，驗證步驟由 quickstart／Tasks 展開）**：（1）作品檔、下載檔、日誌、回應中 AI 金鑰 0 次出現；（2）公開環境與預覽沙箱的環境變數清單不含任何 AI 金鑰；（3）自 B 級受限環境對生成式 AI 服務網域的出站嘗試被拒；（4）含執行時 AI 呼叫的申請版於審查被退回且無法部署（`content_hash` 驗證沿用 R-6）；（5）`/public-ai/*` 不存在；（6）預覽頁在瀏覽器端對外部生成式 AI 端點的連線被阻擋，且標頭由 Works Edge 預覽模式提供、不被沙箱內程式覆蓋，沙箱埠無法繞過（§3.1、7.9；對應 V-53）；（7）`form-action 'self'`、`base-uri 'self'` 不阻斷 §3.2 已核對的 A／B 流程，並阻擋跨源表單與外部 `<base>`（對應 V-53）；（8）作品資料請求只經同源 `/_work/data/v1/*`，公開與預覽資料集互相隔離，平台端每次重驗 `live` 與配額，且不帶 cookie／授權標頭（§3.3；對應 V-53、V-28 第二種）；（9）**（第九輪）** 右側互動預覽以 iframe 嵌入且不使用 cookie 即可載入與續用、非清單來源嵌入被拒、公開頁永遠 `'none'`、兩個預覽互不可讀、會話過期與撤銷後失效（§3.4；對應 V-53(j)～(o)）；（10）**（第九輪）** works-edge 持有的僅為三把專用 HMAC 金鑰與產物唯讀能力，無資料庫憑證與 AI 金鑰；金鑰外洩的影響與平台端重驗、輪替、稽核（§3.5；對應 V-53(f)、(g)、(p)）。
