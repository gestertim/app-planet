# B 級 β2 呼叫路徑研究（方案 X 之下）：架構結論與 Spike 結果（2026-10-21）

> **狀態**：研究輸入；**不是** canonical Plan 的已批准設計、**不是**實作批准。下列路徑 M 與替代 W 皆為「待教育者選定」的候選。
> **前置已核對**：Git 根目錄 `C:/Users/geste/spec-kit/app-planet`；`.specify/feature.json` → `specs/001-app-planet-platform`（未依分支名推斷）。以磁碟現行檔案為準。
> **前提（教育者已批准的本輪方向）**：方案 X＝Vercel Sandbox 不暴露連接埠；建置產物由管理通道取回；預覽由平台控制的閘道提供。保留平台 AI、學生作品 A／B、B 級 β2（D-16 首版功能目標）、右側互動預覽、單一 Readiness Gate。不重開 A0／A1、B0／B2 比較。
> 前序：[RESULTS-preview-inbound-boundary.md](./RESULTS-preview-inbound-boundary.md)（§3 曾寫「β2 …一次一答…未驗證」）、[RESULTS-vercel-validation.md](./RESULTS-vercel-validation.md)。
> **〔2026-10-21 後續更新〕**教育者決定（[decision-register.md](../../decision-register.md) D-16「後續」）：β2 能力邊界＝JSON 請求／回應處理＋Work Data API（不含 WebSocket、SSE、常駐程序、背景工作；時間／記憶體／出站／儲存／次數限制保留）；M 為待驗證首選，W 只在 M 被推翻後交教育者；授權專用測試 Team 跑 VC-1～VC-3。§6 第 2、5 項因此已有答覆；供應商結果見 [RESULTS-vc1-vc3.md](./RESULTS-vc1-vc3.md)。**本檔其餘文字為實測前的設計與起始建議，未改動。**

## 0. 結論

| 問題 | 判斷 |
| --- | --- |
| 「管理通道逐次呼叫」是否成立？ | **條件成立（設計層）；供應商實測〔未執行〕**。安全邊界成立（訪客不可達學生程式、入站授權在平台程式內、撤銷即時）；功能涵蓋「請求／回應式」β2；**延遲、單位成本、控制面額度沒有任何供應商實測，且費用隨請求數線性放大**，不能寫成「已成立」。 |
| 推薦 β2 路徑 | **M：平台側 invoker 以管理通道逐次呼叫；每次請求在全新、非持久、`ports: []`、`deny-all` 的沙箱內執行已核准的處理程式**（§2）。 |
| 若 M 的判準（§4）任一成立 | **只提一個替代 W：Cloudflare Workers for Platforms**（§5）。W 需新增供應商，屬憲章「須交教育者決定」，**本輪不採用、不評估其他替代**。 |
| 能否覆蓋首版 β2 範圍 | **能覆蓋：** 請求／回應式 JSON 伺服器端處理（含透過平台代為讀寫的作品資料）。**不能覆蓋：** WebSocket／SSE／長連線即時伺服器、處理程式自行持久狀態、任何出站。教育者尚未定義 β2 能力清單，這是**待決差異，不得默默縮減**（§6）。 |
| 是否以靜態作品取代 β2 | **否。** 每次請求執行學生的伺服器端程式碼（本機 Spike 以合成程式驗證呼叫契約）。 |

## 1. 逐項核對

### 1.1 訪客不得直連學生可控沙箱，也不得取得管理憑證

| 項目 | M 的做法 | 證據等級 |
| --- | --- | --- |
| 訪客路徑 | 訪客 → works-edge（`/_work/fn/v1/*`）→ 平台側 invoker → 管理通道 → 沙箱。沙箱 `ports: []`，works-edge 與訪客都沒有任何沙箱位址 | 結構：本機 Spike ✔（invoker 無出站連線程式碼；channel `ports=[]`）。**Vercel「零路由」＝〔未驗證〕（VC-1）** |
| 管理憑證所在 | 只在 invoker。官方：SDK 以 OIDC token（專案範圍，部署在 Vercel 時自動管理）或 access token（需 team／project ID，權限＝有 Team 存取）認證。**M 應使用獨立「β2 執行」Vercel 專案的 OIDC**，不使用 team 級 access token，使入侵 invoker 的爆炸半徑限於 β2 沙箱，不含學生 Agent／建置沙箱。〔[authentication](https://vercel.com/docs/sandbox/concepts/authentication)〕 | 設計；OIDC 是否按專案隔離沙箱存取＝**〔未驗證〕（VC-3d）** |
| works-edge 不持有管理憑證 | 契約 §6 第 2 項（B 級公開資源不得持有平台憑證）與 B2 原則（edge 不持有簽署金鑰）一致：edge 只持有 `ops:['invoke']` 的 grant，不能自己叫沙箱 | 本機 ✔（edge 物件僅 `hosts{workId,grant}` 與 invoker 參照） |
| 沙箱內取得憑證 | 處理程式環境不注入任何憑證；`env` 僅合成非敏感值 | 本機子行程 ✔（環境中無平台側憑證）；**VM 內檔案／環境／metadata 是否有管理憑證＝〔未驗證〕（VC-1b、VC-3d）** |

### 1.2 呼叫身分、作品範圍、允許操作、資料與金鑰隔離

| 控制 | 本機 Spike 結果（合成；46／46 通過，含既有 35 項） |
| --- | --- |
| 身分 | 訪客匿名；呼叫者是「持有 grant 的 works-edge」。grant＝Ed25519、綁 `{work, ops, epoch, exp}`；竄改 `exp`、逾期、epoch 遞增皆 `401` |
| 作品範圍 | 作品 A 的 grant 呼叫作品 B → `403`；缺 `invoke` → `403` |
| 允許操作 | 只能呼叫 manifest（取自已核准部署）宣告的函式名；**命令由 manifest 固定，訪客只提供 JSON 本文**；naive 負對照（命令由訪客決定）下訪客可改跑別的程式 → 證明此測試有鑑別力 |
| 資料 | 處理程式只收到 `{request, data}`：`data` 僅含 manifest 宣告的讀取鍵；不轉送標頭、IP、cookie。輸出的 `writes` 只能寫 manifest 宣告的鍵，經 Work Data API 同樣的配額／格式檢查，**全有或全無**（超額 `413` 並還原）；跨作品鍵、未宣告鍵 → `502` 且不落地 |
| 輸出不受信任 | 非 JSON、非法狀態碼（含 3xx）、超大輸出 → `502`；學生指定的標頭（`set-cookie`、CSP）一律不採用；回應標頭由 works-edge 決定 |
| 金鑰 | 見 1.1；Spike 另發現並修正一項缺陷：初版接受 `302`，現限 `2xx／4xx` |
| 限制 | 逾時 → `504`；輸出爆量、記憶體耗盡 → `502`；行程確已結束（本機 `process.kill(pid,0)` 檢查） |

### 1.3 延遲、並行、冷啟動、逾時、費用、限流

官方事實（2026-10-21 取得；[pricing](https://vercel.com/docs/sandbox/pricing)、[concepts](https://vercel.com/docs/sandbox/concepts)、[persistence](https://vercel.com/docs/sandbox/concepts/persistent-sandboxes)）與模型（[d/cost-model.js](./d/cost-model.js)；**純算術，不是報價或量測**）：

| 面向 | 官方文字／數字 | 對 M 的含意 |
| --- | --- | --- |
| 冷啟動／延遲 | 「Milliseconds」啟動、自快照恢復「even faster」；**無任何呼叫往返、建立或恢復的延遲數字** | **全部〔未量測〕**；教育者也尚未核定延遲閾值（§4 提供起始建議供核定） |
| 費用單位 | Pro：Active CPU $0.128／小時；佈建記憶體 $0.0212／GB-小時，**以 1 分鐘為最小計費增量**；建立 $0.60／百萬次；每 vCPU 含 2 GB | **每請求新建沙箱（1 vCPU／2 GB、Active CPU 200 ms 假設）≈ $0.000714／次＝每千次 ≈ $0.71**；10 萬次／月 ≈ $71；100 萬次／月 ≈ $714。主要來自記憶體最低 1 分鐘（「最小增量適用於每個 session」是**我的解讀，待帳單驗證**） |
| 暖沙箱替代 | 同規格常駐＝每作品約 $30.5／月（記憶體，720 小時） | **不採**：即使低流量也有固定成本，且共用沙箱失去訪客間隔離（處理程式有 root／sudo 時可跨請求保存狀態） |
| 並行 | Pro 並行沙箱 10,000；Hobby 10 | 並行不是瓶頸；Hobby 並行僅 10，不適合公開 β2 |
| 建立速率 | vCPU 配置：Pro 起始 150／分、每分鐘 +500、上限 5,000；閒置 10 分鐘後回到起始 | 閒置後的突發：1 vCPU 每請求，起始約 **150 次新建／分**（**〔未驗證〕：新建、恢復、`runCommand` 是否都計入**） |
| 控制面額度 | 「running commands or reading files」用固定每分鐘額度：Hobby 1,000、Pro 10,000、Enterprise 100,000 rpm；刪除 20 次／秒 | 每請求若 3 次管理呼叫（建立＋執行＋停止，**假設**）→ 上限約 **3,333 請求／分**。**官方未載明額度是否以 Team 為單位**；若是，公開流量與學生 Agent／建置共用同一額度＝**匿名訪客可耗盡教學功能的額度** |
| 逾時 | 預設 5 分鐘；單 session Pro 24 小時；可設 `timeout`；`runCommand` 可帶 `signal` | 逾時可由 invoker 與沙箱兩層強制（invoker 層本機 ✔；沙箱層〔未驗證〕） |
| 限流 | Vercel 無「每作品」概念 | 每作品速率、每作品／全域並行由 invoker 自行強制（本機 ✔；PP-19 數值**未核定**） |
| 公開流量 | 費用歸基礎設施池（$200，已知在基準沙箱用量下不足，見 R-09 結論 3） | M 把公開匿名流量直接轉成沙箱費用；**需 PP-19 每作品費用／請求上限，並在 invoker 先擋** |

### 1.4 停用、下架、撤銷後立即拒絕新請求

| 情境 | 本機結果 | 真實環境 |
| --- | --- | --- |
| 下架／撤銷 | 每次重驗 `listing` 狀態（不經快取）；`epoch` 隨下架遞增 → 舊 grant `401`；即使重簽新 grant，狀態檢查仍 `410`；**無 TTL** | 平台資料庫查詢延遲〔未量測〕 |
| 在途呼叫 | `revoke` 後在途處理程式被終止（本機 <300 ms，遠小於 400 ms 自然結束）；結果不回傳、寫入不套用（`410`） | 需供應商端 `kill`／`sandbox.stop()` 的實際耗時（VC-3f）；**既有 5 分鐘預設 timeout 不能當作撤銷機制** |
| `restricted_runtime_gate` 未開／無 `work_runtime_profiles` | `503` fail-closed | — |
| 縱深防禦 | 撤銷時另呼叫 `destroy`；刪除額度 20 次／秒 | 待驗證 |

### 1.5 是否滿足 B 級 β2 功能目標

β2＝「每作品受限的伺服器端程式能力（時間、記憶體、出站、儲存、次數配額）＋Work Data API」（D-16；FR-048）。

| 能力 | M | 備註 |
| --- | --- | --- |
| 請求／回應式伺服器端處理（JSON） | ✔（設計層；本機合成驗證） | 語言／執行環境取決於沙箱映像（官方支援自訂映像），**不限 Node**（〔未驗證〕） |
| Work Data API 讀寫 | ✔（宣告式：讀取鍵預取、寫入鍵經 invoker 套用） | **不能在處理程式執行中任意讀寫其他鍵**；若要「邊執行邊查詢」，需 invoker 經 stdio 做 RPC 代理（stdin 可開、可串流；**〔未驗證〕**，併入 VC-3） |
| 時間／記憶體／輸出／次數配額 | ✔（invoker＋沙箱兩層） | 數值 PP-19〔未核定〕 |
| 出站 | 預設全封鎖（D-16；`deny-all`） | 一致；實際封鎖〔未驗證〕（S-13） |
| WebSocket、SSE、長連線／即時伺服器 | **✘** | 逐次呼叫無長連線；**需教育者決定 β2 是否必含**（§6） |
| 處理程式跨請求的記憶體／檔案狀態 | **✘（刻意）** | 持久資料走 Work Data API；這是訪客間隔離的代價 |
| 背景工作、排程 | ✘ | 非 FR-048 明文；待教育者確認 |

## 2. 推薦路徑 M（細節）

1. **部署**：審查通過、`content_hash` 驗證後，Worker 以管理通道把已核准程式與 manifest（函式名、argv、讀／寫鍵、逾時、輸出與記憶體上限）寫入快照；`ports: []`、`networkPolicy: deny-all`、`persistent: false`。
2. **呼叫**：works-edge 收到 `/_work/fn/v1/<fn>`，附 `invoke` grant 轉給 invoker（**平台側服務，不是 works-edge**；建議為獨立「β2 執行」專案的 Function，使用該專案 OIDC）。invoker 依 §1.2 檢查後，自快照建立沙箱、`runCommand`（固定 argv、`stdin` 傳入 JSON）、取 stdout、驗證、套用寫入、`stop`／`destroy`。
3. **撤銷**：下架時平台呼叫 invoker `revoke`（改狀態、遞增 epoch、終止在途、`destroy`）。
4. **仍需教育者決定**：invoker 的承載（Vercel Function 或 Worker 主機）、是否為 β2 另立 Team（隔離控制面額度；屬建立付費資源，**本輪未建立**）、PP-19。

## 3. 本機 Spike（合成資料；本機模型**不能**冒充供應商實測）

程式：[d/fn-invoker.js](./d/fn-invoker.js)、[d/d.test.js](./d/d.test.js)、[d/handlers/](./d/handlers/)、[d/cost-model.js](./d/cost-model.js)；沿用既有 `DataPlatform`／`Clock`。指令：`node --test c/c.test.js a/a.test.js b/b.test.js b/b2-renewal.test.js d/d.test.js`（Node 24.19.0、Windows）。

| 預期 | 實際 |
| --- | --- |
| 功能、資料最小化、身分／範圍、固定命令、憑證不入處理程式、輸出不受信任、逾時／輸出／記憶體、速率／並行、撤銷（含在途）、結構 | **新增 11 項全通過；合計 46／46** |
| 測試能抓到錯誤 | 初版接受 `302` 被測試抓到並修正；撤銷後舊 grant 回 `401`（epoch）而非 `410` 屬正確行為，測試改為「舊 grant `401`、重簽後 `410`」 |
| 本機延遲（Node 子行程啟動＋JSON 往返，N=30） | p50 66.7 ms、p95 81.7 ms、max 94.3 ms（[results/fn-local-latency.json](./results/fn-local-latency.json)）。**這只是下界**，不含網路、管理 API、沙箱建立／恢復 |
| 費用／配額 | 只有算術模型（§1.3），無量測 |

**這些結果不證明**：Vercel 零路由、VM 內無管理憑證、`deny-all` 實際封鎖、microVM 隔離強度、任何延遲／費用／控制面額度、`runCommand` 逐次往返行為、`kill` 與 `stop` 的實際耗時。本機子行程在 Windows 上會自動補上 `PATH` 等系統環境變數（與憑證無關，測試只檢查憑證類內容）。

## 4. 推翻 M 的判準（任一成立即推翻對應部分；閾值為**我的起始建議，待教育者核定**，批准文件中尚無數值）

| # | 判準 |
| --- | --- |
| M-a | `ports: []` 時外部無憑證可達任何路由（VC-1）；或 VM 內可取得管理憑證、自行建立路由（VC-1b／3d） |
| M-b | `deny-all` 下處理程式能連任何外部／內部目標（S-13 既有判準） |
| M-c | 延遲：新建路徑 p95 >（建議）3 s，或恢復／暖路徑 p95 >（建議）1 s（每格 N≥30）；閾值未核定前**只回報，不判通過** |
| M-d | 單位成本實測 > 模型 2 倍，或使任一合格範例作品超出教育者核定的每作品月費用上限（PP-19） |
| M-e | 公開流量壓測使控制面 `429`／額度耗盡並影響學生 Agent／建置，且改用獨立 Team 後仍不足 |
| M-f | 撤銷後新請求 >15 s 仍通過，或在途呼叫 >15 s 仍存活（沿用 brief 判準 e） |
| M-g | 任一教育者認可的 β2 範例作品必須使用長連線／即時伺服器（→ M 不涵蓋；**交教育者決定**，不自動換供應商） |
| M-h | 訪客間隔離要求下，每請求新建的費用超過上限；退到暖沙箱則隔離不足 |

## 5. 唯一替代 W：Cloudflare Workers for Platforms（僅在 M 被推翻時啟用）

| 項目 | 內容 |
| --- | --- |
| 入站驗證所在 | **平台自有的 dynamic dispatch Worker**：官方稱它是「entry point for all requests」，在客戶程式執行前做驗證、限流、請求檢查；用戶 Worker 經 dispatch namespace binding 被它呼叫。學生程式不能修改 dispatch Worker。〔[How it works](https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/how-workers-for-platforms-works/)〕 |
| 隔離與出站 | namespace 內預設 untrusted 模式（無 `request.cf`、快取互不共用）〔[isolation](https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/reference/worker-isolation/)〕；Outbound Worker 攔截所有 `fetch()`，並在啟用時停用 `connect()` TCP，可全數拒絕〔[outbound](https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/configuration/outbound-workers/)〕 |
| 逐請求限制 | 由 dispatch Worker 設 `cpuMs` 與 `subRequests`；超過即例外〔[custom limits](https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/configuration/custom-limits/)〕；每次呼叫 CPU 最多 30 秒；時長不計費 |
| 費用（2026-10-21 官方頁） | $25／月（含 2,000 萬請求、6,000 萬 CPU ms、1,000 scripts）；超額 $0.30／百萬請求、$0.02／百萬 CPU ms、$0.02／script〔[pricing](https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/reference/pricing/)〕。模型：10 萬次／月（10 ms CPU）＝$25；100 萬次＝$25（均在額度內）。對照 M：$71／$714 |
| 撤銷 | dispatch Worker 每次查平台狀態（同 M）；另可刪除 user Worker |
| 與 M 的差異（**待教育者決定**） | ① **新增供應商 Cloudflare**（現批准棧無；研究僅在 R-05 列 Sandbox SDK／Containers、R-07 列 Pages／R2／Workers for Platforms 為候選，且 R-07 註明 WfP 對學生程式的適用性「未研究」）；② 執行環境是 Workers（JavaScript／Wasm），**不是任意 Node／Python 程序**，Agent 產出的 β2 程式需符合 Workers 相容性；③ 兒童資料條款、區域（亞太）、延遲：**未查證**；④ 單一 Worker 的記憶體上限、是否可用 WebSocket／Durable Objects 於 WfP：**本輪未查證**；⑤ 「namespace 內 user Worker 不可由公網直達」官方頁面只描述經 dispatch 呼叫，**未明文保證**，須實測（VC-3a′） |
| 為何只提 W、不提 E2B | E2B 在先前 RESULTS（Y）以供應商邊緣權杖保護**常駐的學生伺服器**；其費用依佈建時間（R-05）、權杖在 VM 內是否可讀〔未驗證〕，且仍是「學生伺服器在公開網址上」的模型。W 的入站在平台程式內、按請求計費，與 M 同為「平台控制呼叫」模型，只是換掉費用與執行層。此為我的判斷，E2B 的 β2 適用性**未評估** |

## 6. 待教育者決定（本輪不代為決定）

1. 選 β2 路徑：**M**（推薦；沿用已批准供應商，先以 VC-3 驗證）或 **W**（M 被推翻時；新增供應商）。
2. β2 能力清單：是否必含 WebSocket／SSE／長連線即時伺服器（M 不涵蓋）。
3. 延遲閾值與 PP-19（每作品請求／費用上限）；M 的起始建議見 §4。
4. 訪客間隔離政策：每請求新建（推薦，費用較高）或暖沙箱（便宜，隔離弱）。
5. 是否授權建立隔離測試 Team／專案（VC-1～VC-3 前置）；以及是否為 β2 另立 Team。

## 7. 對 canonical 的待修位置（教育者選定後才改；本輪**未**修改）

[contracts/publishing-and-public-runtime.md](../../contracts/publishing-and-public-runtime.md) §6「待展開：受限函式的呼叫契約」；[quickstart.md](../../quickstart.md) S-13（L34；增加呼叫路徑量測列）；[data-model.md](../../data-model.md) §5.4（L244–251；`work_runtime_profiles` 增函式 manifest 欄位，若選定）；[decision-register.md](../../decision-register.md) D-16（L362–373）、PP-19（L461）；[research.md](../../research.md) R-07 第 5 點（β2 執行環境研究要點）；[plan.md](../../plan.md) L322（`/_work/fn/v1/*` 待 S-13 與教育者核定）、K-14；[checklists/plan-finalization.md](../../checklists/plan-finalization.md) CHK017、CHK023、CHK025。

## 8. 未執行聲明

未建立任何付費資源、Team 或沙箱；未登入任何供應商、未使用密鑰或兒童資料（Spike 的「管理憑證」為字串 `synthetic-admin-token-not-a-secret`）；未執行 /speckit-tasks、/speckit-analyze、/speckit-implement；未 commit／push；未動上層 AnywhereTalk repository。僅讀取 Vercel Sandbox 與 Cloudflare Workers for Platforms 的官方文件頁面。
