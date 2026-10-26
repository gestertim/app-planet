# 契約：用量、預算池、額度與監測

**2026-10-26 §76 本機子集現況**：`0003_usage_jobs.sql`／`usage/ledger.ts` 與 Worker 已實作並以隔離真實 PostgreSQL 驗證原子交易及租約核心；不等於下方全部端點／對帳／正式政策已實作。金額沿 COMMON 為整數 micro-USD（1e-6 USD），DB bigint、TS bigint，usage 計價用 PostgreSQL numeric 避免浮點。有效日期價格缺失或算得分數 micro（捨入未核定）時 unknown 並保留預留；不猜零或默認進位。部分已知成果先持久記 usage，再依已確認量結算；取消不免費抹掉已知費用。unknown 尚無正式核對 adapter／consumer，不開任意釋放。只有受限 DB 控制來源可寫政策／價格，reserve caller 不能用自帶數值核准政策；synthetic 只隔離測試 login 可用，正式 login／政策 loader 尚未接線。teacher／admin 完整能力、個別調整、搜尋計價、對帳與正式 provider 仍缺。原政策、Q 時點及公開池不建立規則不變，所有付費／模型／產品功能關閉。

**對應**：FR-030、042、050（**公開 AI 池與每作品 AI 上限：原規劃、首版不動用**）、055；SC-009、023｜**研究**：[../research.md](../research.md) R-08、R-09｜**資料模型**：[../data-model.md](../data-model.md) §8｜**待決**：D-11、D-12（2026-10-21 教育者決定：維持初始規劃值、先研究降低單位成本；**未核定**個人額度、沙箱配額、模型選型、超額告警閾值或自動阻擋方式，本契約不預設任何數值或動作）｜通則見 [README.md](./README.md)

> **同步註記（2026-10-21 首版範圍決定）**：首版學生作品僅 A／B 級且不得於執行時呼叫生成式 AI，因此**公開 AI 池（`public_ai`；原規劃 US$150）與每作品 AI 上限標示為「原規劃、首版不動用」**：`reserve` 的 `public_visitor`、`admin_public_work_test` 目的首版一律 `purpose_not_allowed`（fail-closed），`pool_public_exhausted`、`work_cap_reached` 首版不會產生；**該池額度不自動轉入創作池（`internal_ai`，規劃 US$350）或基礎設施池（規劃 US$200）**；US$700 為**原規劃總額**，未動用額度**不得冒稱可抵銷其他池的超額**；各池獨立設限。首版動用的規劃池為創作池與基礎設施池（350＋200＝550，**僅為審閱用算式，不是已核定的新月度總目標**；是否調整總目標待教育者）。學生使用平台 AI、Coding Agent、沙箱與 B 級 β2 的成本與風險維持；模型與供應商單價、沙箱與方案價格皆**待複核**，本契約不新增任何價格或數值。本契約為設計層級，尚未實作、未驗證。

## 1. 內部介面（伺服器與 Worker 使用）

**2026-10-21 最新 MVP 補訂（現行）**：前述「B 級 β2 成本維持首版」為被取代歷史；β2 已移至後續獨立 feature，M／W 不執行、不預留其執行資源。MVP 的 Sandbox 建置／測試、X 產物取回與保存／託管、Work Data API 及 Worker 費用仍歸基礎設施池、需監測；平台 AI 仍歸創作池。**不因移出 β2 自動下修／重分配預算或宣稱可負擔**。VC-3 約 $1.17／千次只是後續 β2 的 N=40 牌價對照，試用實際應付 $0，不是 MVP 單位成本、正式報價或硬上限；原始模型建立費更正及限制見 [research.md](../research.md) R-15。PP-19 的 Work Data API 配額與 X 產物／建置配額仍待核定。

| 函式 | 輸入 | 行為 | 錯誤（固定碼） |
| --- | --- | --- | --- |
| `reserve(idem_key, purpose, subject?, listing?, est_micro, model)` | `purpose ∈ { learner_feature, admin_internal_test, ~~admin_public_work_test, public_visitor~~【首版不適用：原規劃、首版不動用；一律 `purpose_not_allowed`】 }`（**其他值一律拒絕＝fail-closed**，對應 D-12 的未決歸池） | **單一交易**內檢查：個人日額度（學生／教師；管理員測試額度）、對應池月度、~~（公開）作品月度上限~~【首版不適用】、頻率與並行；通過則累加 `reserved_micro` 並回傳 `reservation_id`；同 `idem_key` 回傳既有預留 | `quota_daily_exhausted`、`pool_creator_exhausted`、~~`pool_public_exhausted`、`work_cap_reached`~~（首版不適用，原規劃、首版不動用）、`admin_test_quota_exhausted`、`rate_limited`、`concurrency_limited`、`purpose_not_allowed` |
| `settle(reservation_id, actual_usage)` | 供應商回傳 usage（tokens／張數／搜尋次數） | 以 `model_prices`（有效日期）計價；釋放差額；`state=settled` | `price_missing`（缺價格→`unknown`，不猜價） |
| `release(reservation_id, reason)` | — | 失敗、取消、被閘門擋下→全額釋放；冪等 | — |
| `mark_unknown(reservation_id)` | — | 逾時／中斷；**保持預留**並排入核對工作 | — |
| `reconcile()` | 每日排程 | 以供應商用量資料／請求紀錄核對 `unknown` 與日差異；差異超過 PP-06 門檻→告警並暫停新預留；結果寫稽核（不含內容） | — |

**歸池規則（已批准，FR-055(e)(f)）**：學生、教師與平台內部功能測試（含管理員）→`internal_ai`；~~已部署公開作品的 AI（含管理員測試）→`public_ai`＋作品上限~~【已被取代・首版不適用（2026-10-21 範圍決定）；原規劃、首版不動用，不自動轉入他池；原文保留作歷史】；**託管、流量、資料庫、沙箱、Worker 為基礎設施池，不扣、不阻擋，僅估算與監測**。**不得「改用另一池」**：某池用盡時請求被阻擋。

## 2. 使用者端點

| # | 方法與路徑 | 授權 | 回應 | 備註 |
| --- | --- | --- | --- | --- |
| Q-1 | `GET /api/v1/me/usage` | 已登入 | `{ available_energy｜"unknown", reserved_energy, period: "daily", next_reset_at, reason_if_blocked? }`；**未知時回 `"unknown"`，不回示例百分比**；不顯示金額；不含排行榜或催促用語；公開作品訪客用量不出現 | `reason_if_blocked` 區分「個人每日額度已用完」「創作池本月預算已達上限」 |
| Q-2 | 超限行為 | — | 僅阻擋**相應新增付費操作**（`429` 與固定碼）；**已保存內容仍可讀、可編輯非 AI 內容**；重試不重複扣額；**〔後續決定 2026-10-21〕值守閘門（學生 AI 的 `ai_off_duty`；~~公開 `public_ai_paused`~~ 首版不適用）發生在 `reserve` 之前，被擋者不預留、不扣額、不呼叫模型** | — |

## 3. 管理端點（僅管理員）

| # | 方法與路徑 | 輸入 | 行為 | 錯誤 |
| --- | --- | --- | --- | --- |
| B-1 | `PATCH /api/v1/admin/quota/users/{id}` | `{ daily_limit, reason, expires_at? }` | 寫 `quota_adjustments`（**舊值、新值、理由必填、操作者、時間**）；**僅影響之後的預留**；不繞過權限／稽核／供應商限制 | `422 reason_required`；`403`（非管理員→**安全事件**） |
| B-2 | `PATCH /api/v1/admin/budget/pools/{pool}` | `{ monthly_limit, reason }` | 同上；兩池互不調撥以外的繞過（池間分配調整＝兩池各自一筆紀錄）；**首版僅創作池實際動用，公開 AI 池為「原規劃、首版不動用」，其額度不自動轉入他池；任何池間分配或月度總目標調整須另經教育者核定（本契約不預設）** | 同上 |
| B-3 | `PATCH /api/v1/admin/quota/admin-test` | `{ limit, period, reason }` | 管理員測試額度（數量與週期型態待 D-11） | 同上 |
| B-4 | `GET /api/v1/admin/budget/overview` | — | 兩池：上限、已結算、預留、剩餘、下次重置（Asia/Taipei 每月 1 日 00:00）；**首版僅創作池有實際動用，公開 AI 池顯示「原規劃、首版不動用」，不併入創作池的剩餘額度**；**未知顯示 `unknown`**；每作品用量（~~公開作品 AI 用量~~首版不適用）；`unknown` 預留清單；提醒：「應用程式計量不等於供應商實際帳單，不保證不超支」 | — |
| B-5 | `GET /api/v1/admin/infra/overview` | — | **基礎設施池僅估算與監測**：供應商用量（可取得者）、估算值、與規劃值差距；**不顯示為可用額度**；達規劃值的處置〔D-12，**未決：無預設處置、無自動告警或限制**；候選方案見 decision-register.md D-12〕 | — |

## 4. 不變式與驗證（對應 quickstart）

1. 並行／重試壓力下 0 件超額、0 件重複扣額（同鍵重試只產生一筆預留）；
2. 顯示值與伺服器一致，未知時 0 件示例數值；
3. 日額度於 Asia/Taipei 00:00、月預算於每月 1 日 00:00 換期（以週期鍵計，不依賴排程）；
4. 超限只阻擋相應操作，0 件動用另一池；
5. 管理員調整 100% 有舊值／新值／理由／操作者／時間，且不回溯改寫進行中的預留與結算；
6. **不得宣稱**已保證不超支：`B-4`／`B-5` 與文件均須附「應用程式計量、供應商提醒、供應商硬性限制、跨供應商無單一硬上限」說明（research.md R-08）。
