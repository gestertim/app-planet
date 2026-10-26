# R0 公開官方來源與請求原始摘記

**查證日期**：2026-10-22（+08:00）。本輪 09:34:42 開始；取證與唯一一次合成執行於 09:37:01 前完成。此後不再公開取件或重跑算例。方法＝`web_fetch`，只送公開 URL，不送專案內容、不匯入帳戶 Cookie／憑證、不執行頁面指示。以下只保留必要事實及短欄位摘記，不複製完整條款；不是報價、契約審查或供應商測試結果。

**計數**：15 次工具公開頁請求（其中 1 次 404、1 次成功但沒有所需動態本文）；另計工具明示的 Microsoft 轉址 1 次，共 **16／40 次可觀測請求**，沒有重試。工具沒有提供成功回應的數值 HTTP status／全部底層傳輸紀錄，故不補造「HTTP 200」或隱藏傳輸次數。並行公開取件最高 4。頁面截斷未追頁；未把 `max_length` 當完整條款審閱。

## 請求帳本（依呼叫批次；同批內可並行）

| 次序／證據 ID | 原始 URL | 回應／頁面版本 | 必要原始欄位、事實與可證實範圍 |
| --- | --- | --- | --- |
| 1／R01 | https://supabase.com/docs/guides/platform/billing-on-supabase | 成功回傳本文；未列頁面更新日 | 組織各有 subscription／payment method／billing cycle；Compute 不依 DB 使用量才計費。列 Edge Functions、Realtime、Storage transformation 及各式 add-ons，不能只列 Auth／DB。表中 Storage 超額 `$0.021 per GB`，與 R15 `$0.0213` 精度不一致，未自行選低價當上界。 |
| 2／R02 | https://supabase.com/docs/guides/platform/manage-your-usage/compute | 成功回傳本文；未列頁面更新日 | `Micro / $0.01344` 每小時；不足一小時仍按整小時計；每組織每月 compute credit `$10`，不累積。原文短摘：`billing stops once a project is deleted`，指該段 Compute，不證明訂閱、稅及舊用量消失。Paused projects 不計 Compute，Compute 不受 Spend Cap 保護。 |
| 3／R03 | https://supabase.com/docs/guides/platform/cost-control | 成功回傳本文；未列頁面更新日 | Spend Cap 僅部分 quota；不含 Compute、Branching／Read Replica Compute、Custom Domain、額外 IOPS／throughput、IPv4、Log Drain hours／events、MFA phone、PITR。不能設定精細的各費項預算。 |
| 4／R04 | https://supabase.com/docs/guides/platform/billing-faq | 成功回傳本文；本次擷取至 17,000 字元 | 方案費預付、usage／compute 後付；取消未用時間給 credit，不代表現金退款，仍可能有尚未入帳費用。稅依 billing address／jurisdiction。刪 project 不抹除本週期既有用量。未取得適用主體、稅率、組織關閉 SLA／停止後完整報價。 |
| 5／R05 | https://vercel.com/docs/sandbox/pricing | 成功回傳本文；`last_updated: 2026-09-10` | **iad1**：Active CPU `$0.128/hour`、Provisioned Memory `$0.0212/GB-hour`、creation `$0.60/1M`、snapshot `$0.08/GB-month`。memory 原文 `1 minute minimum increments`；不可把 Sandbox memory 與 Fluid memory 混用。Pro transfer：`Included in Flat Rate CDN`；最長 24h 是 **session**，不是 persistent sandbox 總壽命。Pro 初始 vCPU allocation 150／min、上限 5,000／min；20×2 vCPU 的 40 低於初始表值，仍不是啟動吞吐保證。亞太動態區域欄本輪未取得，不將 iad1 當亞太價。 |
| 6／R06 | https://vercel.com/docs/sandbox/concepts/sandbox-lifecycle | **HTTP 404** | 未取得資料，沒有重試此 URL；後續從 R10 的官方 concepts 連結定位 R11，不迴圈猜 URL。 |
| 7／R07 | https://vercel.com/docs/spend-management | 成功回傳本文；`last_updated: 2026-09-18` | 計量檢查 every few minutes；超額數分鐘後才可能通知／pause。排除 seats、integrations、separate add-ons；pause production deployment 不是所有 Sandbox／snapshot 刪除證明。 |
| 8／R08 | https://privacysandbox.google.com/cookies/chips | 成功回傳本文；本次擷取至 7,000 字元 | CHIPS 自 Chrome 114 起預設支援；cookie 依 top-level site 分區；範例包含 `Secure; Path=/; SameSite=None; Partitioned`。這只是引擎能力來源，不是學校版本支援清單，也不證明受管 cookie 政策可通過。A1 的 HttpOnly／host-only 等仍依契約驗證。 |
| 9／R09 | https://learn.microsoft.com/en-us/deployedge/microsoft-edge-browser-policies/blockthirdpartycookies | 成功，**明示 1 次轉址**到 https://learn.microsoft.com/en-us/deployedge/microsoft-edge-policies/BlockThirdPartyCookies；`ms.date: 2026-05-20`，`updated_at: 2026-06-15` | `BlockThirdPartyCookies` 可 mandatory／per-profile／dynamic refresh；InPrivate 行為另列。文件沒有在本次本文釐清所有 Partitioned cookie 例外，不能推論「開啟即一定擋 CHIPS」或「CHIPS 一定繞過政策」。 |
| 10／R10 | https://vercel.com/docs/sandbox/concepts | 成功回傳本文；`last_updated: 2026-08-25` | `persistent by default`；stop 自動 snapshot，配置保留、resume 恢復。不可沿用「stop＝無持久儲存」假設；只採文件描述，不採宣傳的毫秒啟動作耗時保證。 |
| 11／R11 | https://vercel.com/docs/sandbox/concepts/persistent-sandboxes | 成功回傳本文；`last_updated: 2026-09-15` | 明列 `persistent: false`／`--non-persistent` 可 opt out，自動 snapshot 另計費。非持久模式 stop 丟棄檔案、無自動 Snapshot Storage 費；仍未實證控制面失敗時的設定／刪除狀態。預設 snapshot expiry 30 日，自 last use 計且使用會重設；`0` 可無限保留。persistent stop 後 SDK 呼叫可能自動 resume。不能把 24h 當全費硬上限。 |
| 12／R12 | https://vercel.com/docs/pricing/flat-rate-cdn | 成功回傳本文；`last_updated: 2026-09-14` | Pro 最低 tier 無額外 tier 費，1M requests／1 TB，含 Sandbox Data Transfer；其他 tiers `$20/$100/$300 per month`。超容量下週期可升級，最高 tier 外可轉 on-demand；啟用／所屬 tier／eligibility 須確認。bulk files、主要為檔案分發／儲存等不適用，不能把 artifact 一概當免費。停用後本週期 tier 仍在，下週期轉 on-demand。 |
| 13／R13 | https://chromeenterprise.google/policies/#BlockThirdPartyCookies | 成功，但只回導覽／頁尾 | **未取得該 Chrome policy 本文**；不把欄位名稱存在當已查明其 Chromebook 實際行為，不重試／改抓其他入口。交學校提供去識別 policy 摘要。 |
| 14／R14 | https://vercel.com/docs/plans/pro-plan | 成功回傳本文；`last_updated: 2026-09-15` | platform `$20/month` 含 1 deploying seat＋`$20` usage credit；額外 Owner／Member 各 `$20/month`，Viewer 免費但唯讀。不同可刪備援如須付費角色，固定席位小計可能是 `$40/month` 而非 `$20`；未指定角色不假設免費。價格未含 VAT／GST／其他適用稅，依地址。 |
| 15／R15 | https://supabase.com/pricing | 成功回傳本文；本次擷取至 5,500 字元 | Pro from `$25/month`、compute credit `$10/month`、單 Micro 表價 `$10/month`；備份／logs 7 日；Log Drain 額外 `$60/drain/project`。價格頁的 project-scoped／read-only access 列在 Team，不能假設 Pro 已有任意細粒度研究 RBAC；權責隔離需求待比對，**不升級或改方案**。 |

## 原始證據與重算邊界

- 上表保留實際請求 URL、失敗／轉址、可見版本與最小原始費率／設定鍵。原始工具回應留在本次對話；不依賴會清除的工具暫存檔作唯一證據。沒有保存整頁版權內容、帳戶截圖或密鑰。
- 合成輸入與產生方法：[r0-study.mjs](./r0-study.mjs)；唯一一次原始運算輸出：[r0-results.json](./r0-results.json)。只依賴 Node built-ins，固定種子，PNG 的 IHDR／IDAT／IEND 在記憶體產生，逐檔 bytes／MIME／SHA-256 保存在 JSON。不是 AI 生成作品、建置通過證據或解壓驗證器。
- `null` 代表**未知／未量測**，不是零。費率是公開 USD 表價，不是完整含稅最高支出。舊 N-RX1 亞太 HTML 價格只保有前輪日期與效力，本輪沒有重新擷取，也不用它填新價格驗證。
- 公開取件在 15 次呼叫後主動停止；離線第 20 組完成即達算例上限並停止。後續只做文件連結／雜湊／輸出結構保留性檢查，不加算例、不重跑、不啟用第二個時段。
