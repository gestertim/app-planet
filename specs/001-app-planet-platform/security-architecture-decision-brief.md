# 安全架構決策摘要：私人預覽存取與作品資料授權

**日期**：2026-10-21　**對象**：教育者（一次定案）　**狀態**：**決策輸入；非 canonical Plan 的已批准設計、非實作批准**
**範圍**：僅 (A) 私人預覽存取、(B) 作品資料授權。不重議產品範圍（平台自身提供 AI；首版學生作品僅 A／B，β2 在範圍內；單一 Readiness Gate）。
**文件現況**：Plan 仍為草案；Checkpoint 與 Readiness Gate 均未通過。**以下以磁碟現行檔案為準**（見 §5 對照位置）。
**證據**：本機 Spike 與結果見 [spikes/security-boundaries/RESULTS.md](./spikes/security-boundaries/RESULTS.md)。**本機結果不代表供應商網域、TLS、供應商沙箱、各瀏覽器或學校網路條件通過**；未驗證項目見 §4。

---

## 0. 先看這四點

1. **`frame-ancestors`、CSP、難猜主機名都不是使用者身分驗證。** Spike：`frame-ancestors` 在瀏覽器擋下他站內嵌，但對非瀏覽器用戶端與直接導覽毫無作用；現行方案下只有主機名的用戶端可載入 HTML／子資源、讀寫刪暫存資料、連 WebSocket（Node 層實測）。
2. **預覽的「沙箱位址可被繞過」前提文件上已有疑慮。** Vercel Sandbox 官方文件稱 `sandbox.domain()` 回傳「publicly accessible URL」，我**未在該文件看到存取控制機制**（不等於不存在；尚未實測）。此前提不成立時，A 的任何方案在 edge 的控制都可被繞過（見 §2.4）。
3. **works-edge 對 Vercel WebSocket 的代理能力未見官方說明。** 文件僅說明 Functions 可**作為** WebSocket 伺服器（公開 beta，自 2026-06-22；單連線上限 300 秒預設／Pro 800 秒／beta 1,800 秒）；「代理到外部沙箱 dev server」未見說明，須實測。
4. **公開作品的資料 API 本來就是匿名可讀寫（§3.3）。** 對 `live` 作品，入侵 works-edge 並**沒有**多出「機密性」權限；金鑰/權杖設計真正改變的是：跨作品批次與刪除、略過 edge 過濾、預覽與非 live 資料、入侵後的持續性、撤銷粒度。若教育者要求作品資料「僅作者／教師可讀」，需另設由平台 session 授權、**不經 works-edge** 的讀取路徑（本決策不處理）。

---

## 1. 查證來源（官方；查證日 2026-10-21）

| # | 事實 | 來源 |
| --- | --- | --- |
| S1 | CHIPS：`Partitioned` cookie 依「頂層站台」分區，須 `Secure`，建議 `__Host` 前綴 | MDN〈CHIPS〉https://developer.mozilla.org/en-US/docs/Web/Privacy/Guides/Third-party_cookies/Partitioned_cookies |
| S2 | `Partitioned` 支援：Chrome 114、Firefox 141、Safari 26.2（Safari 18.4 曾加入、18.5 移除）；`SameSite=Lax` 預設在 Safari 不適用 | MDN browser-compat-data `http/headers/Set-Cookie.json`（main 分支，查證日取得） |
| S3 | 第三方 cookie 現況：Chrome 預設不封鎖（僅無痕或使用者設定）；Firefox 預設 Total Cookie Protection；Safari 預設 ITP，僅能以 Storage Access API 逐框放行；擴充功能也可封鎖 | MDN〈Third-party cookies〉https://developer.mozilla.org/en-US/docs/Web/Privacy/Guides/Third-party_cookies |
| S4 | iframe `sandbox`：與嵌入頁同源時不宜同時給 `allow-scripts`＋`allow-same-origin`；若被在新分頁開啟，沙箱即失效，內容應放獨立 origin | MDN〈iframe〉https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/iframe |
| S5 | `frame-ancestors` 只規範哪些父頁可內嵌（frame／iframe／object／embed） | MDN https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy/frame-ancestors |
| S6 | 「站台」＝可註冊網域（Public Suffix List 項＋前一段）；`SameSite` cookie 只送往同站 | MDN Glossary〈Site〉https://developer.mozilla.org/en-US/docs/Glossary/Site |
| S7 | `__Host-` 前綴：須 `Secure`、不得有 `Domain`、`Path=/`，等同把 origin 當安全邊界；不支援前綴的瀏覽器會直接接受 | MDN〈Set-Cookie〉https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Set-Cookie |
| S8 | WebSocket 握手為 HTTP 升級請求，可帶 `Cookie` 等標頭；常以反向代理先行處理 | MDN〈Writing WebSocket servers〉https://developer.mozilla.org/en-US/docs/Web/API/WebSockets_API/Writing_WebSocket_servers |
| S9 | Vercel Sandbox：`sandbox.domain(port)`「resolves a publicly accessible URL」；`ports` 至多 15 | https://vercel.com/docs/sandbox/sdk-reference |
| S10 | Vercel Functions WebSocket：公開 beta（2026-06-22 起）、需 Fluid Compute、連線隨函式最長執行時間關閉；Routing Middleware／Rewrites／Firewall 在升級前執行 | https://vercel.com/kb/guide/do-vercel-serverless-functions-support-websocket-connections （last_updated 2026-10-01） |
| S11 | Vercel 外部 rewrite 可作反向代理；**文件未提 WebSocket 升級** | https://vercel.com/docs/routing/rewrites |
| S12 | 萬用字元網域：`*.acme.com`；需 Vercel nameservers 或委派 `_acme-challenge` | https://vercel.com/docs/domains/working-with-domains/add-a-domain |

**未查證（不得當作事實）**：Safari／Firefox 在實機的 Partitioned cookie 行為；管理政策封鎖第三方 cookie 是否也影響 Partitioned cookie；Vercel 請求日誌是否記錄完整主機名；瀏覽器 WebSocket 建構式不能自訂標頭（一般知識，本次未重新擷取）。

---

## 2. 任務 A：私人預覽存取

### 2.1 現行方案（A0）的實際後果

現行：`https://{preview_id}.{preview_domain}/`，≥128 位元、一次性權杖兌換、無 cookie、每次請求由 works-edge 以 `Host` 查會話狀態（publishing §3.4）。

**主機名洩漏後（Spike 實測，Node 層）**：持有者（任何網路位置、無任何身分）在會話有效期內可：載入 HTML 與所有子資源（可檢視學生作品原始碼）；對 `/_work/data/v1/*` 讀、寫、刪該會話暫存資料；建立 WebSocket 到沙箱開發伺服器（可能暴露沙箱內專案檔案、耗用沙箱 CPU 與費用）。**不能**：存取其他預覽（資料集與 origin 皆獨立）、公開作品資料、平台、學生帳號、延長會話（延長只能由已登入的平台 API）。

**可能的洩漏途徑**：學校／ISP DNS、代理、防火牆日誌與 TLS SNI（主機名明文）；託管供應商請求日誌（是否記錄主機名未查證）；瀏覽器擴充、DevTools、螢幕分享；學生程式以導覽外送自身 `location`（`connect-src` 不涵蓋導覽；`sandbox` 不含 `allow-top-navigation`／`allow-popups` 可擋一部分，本機未針對此項測試）；在新分頁直接開啟時 iframe `sandbox` 不適用（S4）。`Referer` 由 `no-referrer` 抑制。萬用字元憑證可避免憑證透明度公開主機名（S12，未實測）。

### 2.2 候選架構比較

| 方案 | 安全邊界 | 右側互動 iframe／HTML／子資源／WebSocket／重新整理 | 實作複雜度 | 營運成本 | 尚需驗證的前提 |
| --- | --- | --- | --- | --- | --- |
| **A0 現行：主機名即憑證** | 持有主機名者即可存取；**無逐請求授權**；邊界＝名稱保密＋短 TTL＋撤銷 | 全相容（不依賴任何瀏覽器儲存）；重新整理與 WS 皆可（Node 層、Chromium 實測 E1） | 低 | 低（edge 狀態查詢已在設計內） | 萬用字元 TLS；沙箱埠不可繞過；Vercel 上 WS 代理；日誌是否洩漏主機名 |
| **A1：主機名＋分區 cookie，逐請求驗證** | 需**同時**持有主機名**與**該瀏覽器於該頂層站台分區內的會話 cookie（`__Host-Http-`、`HttpOnly`、`Secure`、`SameSite=None`、`Partitioned`；綁定 `preview_id`）；HTML、子資源、資料 API、WS 握手每次驗證。仍非「使用者身分」：cookie 綁瀏覽器分區，不是人 | 實測（Chromium 150）：iframe 內全成功；他頂層站台內嵌與直接導覽皆 `403`；Lax 對照在跨站 iframe `403`（證實不可用）。**瀏覽器門檻**：Chrome／Edge ≥114、Firefox ≥141、Safari ≥26.2（S2）；較舊 iPadOS／Safari 不支援 | 中（Set-Cookie、逐請求驗證、不支援瀏覽器的 UX） | 低～中（多一個 cookie 比對；狀態查詢本來就有） | Safari／Firefox 實機；**學校管理政策封鎖第三方 cookie 時是否仍可**（未驗證，可能決定成敗）；正式 TLS 網域上 `__Host-Http-` 前綴；擴充套件封鎖 |
| **A2：同站預覽（平台可註冊網域的子網域）＋host-only cookie** | 逐請求 cookie 驗證；但與平台**同站**：學生 JS 與平台共享站台（cookie 覆寫／同站請求帶平台 cookie） | 相容性最好（第一方）；Chromium 實測 E5 可用 | 中 | 低 | **違反 research R-13「預覽與平台為不同可註冊網域」**；Spike：學生頁對平台的帶憑證 `fetch` 被 CSP 擋下，但這只是單一防線且不涵蓋導覽；若將預覽網域登錄 PSL 則變成跨站而失去此方案的優勢（S6） |
| ~~A3：Service Worker 加 `Authorization`~~ | 不採 | WebSocket 握手無法經此加標頭（一般知識，未在本次查證）；學生可解除註冊；Safari 分區行為不明 | 高 | — | 不納入 |
| ~~A4：右側只放靜態快照／另開視窗~~ | 不採 | 改變 UX §9.1；教育者已要求保留右側互動預覽 | — | — | 不納入 |

### 2.3 推薦：A1（附明確降級規則）；備案：A0 加固

**推薦 A1**：把「洩漏主機名＝直接可用」降為「洩漏主機名單獨無用」，且不改變跨站隔離。**降級規則（須教育者決定）**：不支援 Partitioned cookie 的瀏覽器**不得靜默退回 A0**（攻擊者可偽稱該瀏覽器），應顯示「此瀏覽器暫不支援預覽」；或由教育者明確接受該類裝置走 A0 加固並記錄殘餘風險。

**推翻 A1 的判準**（於正式 TLS 網域，教育者定義的目標瀏覽器×裝置清單，每格 ≥30 次）：
- (a) 右側 iframe 載入 HTML＋子資源＋WebSocket＋重新整理的成功率低於 100%（任一裝置）。
- (b) 在**學校實際使用的管理政策**（含封鎖第三方 cookie）下失敗，且影響裝置占比 >5%（教育者核定閾值）。
- (c) 無 cookie 的用戶端以洩漏主機名取得任何 `200`（HTML／子資源／資料 API／WS）。
- (d) cookie 在他頂層站台內嵌或直接導覽時被送出。
- (e) 撤銷後新請求拒絕時間 >15 秒，或既有 WebSocket >15 秒仍存活。
- (f) works-edge 在 Vercel 上無法代理 WS 至沙箱，或撤銷後無法關閉既有 WS。
任一成立 → A1 推翻，退到 A0 加固或重議架構。

### 2.4 兩案共同前提（任一不成立，edge 的所有控制皆可被繞過）

沙箱預覽位址（S9：公開可達）不可被瀏覽器繞過 edge 直連。Spike 只證明邏輯：上游若無權杖，直連 `200`；有上游權杖，直連 `401`。**建議實測**「沙箱內守門程序要求 edge 帶上游權杖」是否可行（學生程式與守門程序同 VM，只能防止外人，不防學生本人，後者為其自身作品）。供應商實際行為：**未驗證**。

### 2.5 若選 A0（維持主機名）：必須明訂的硬性規定（建議值待教育者核定）

| 項目 | 規定 |
| --- | --- |
| **預覽不得放入** | 學生／教師真實姓名、學校與班級名稱、座號／學號、電郵、電話、地址、照片、人臉、語音、平台 uid／帳號、對話全文、教師審查意見原文、任何真實兒童資料。預覽暫存資料（`/_work/data/v1`）僅限合成測試字串 |
| **教師審查輸入限制** | 審查預覽中只可輸入平台提供的「範例資料」或明顯合成字串（UI 固定提示並提供一鍵填入）；單一值 ≤200 字元、整個會話暫存資料 ≤64 KB（建議）；**審查結論與回饋一律寫在平台頁，不寫入預覽內**；預覽資料隨會話結束清除 |
| **有效期** | 單次絕對有效 ≤30 分鐘；僅能由已登入平台頁延長，累計 ≤2 小時；平台頁離開／關閉預覽即撤銷；同一主體開新預覽即撤銷舊預覽 |
| **撤銷上界** | 資料 API：即時（平台每次重驗）；HTML／子資源：≤15 秒（edge 狀態快取 TTL，比公開頁 PP-01 的 60 秒更短）；既有 WebSocket：≤15 秒（週期重驗，**否則會一直存活**，Spike 已證實此缺口）；已載入瀏覽器的內容無法收回 |
| **日誌** | 應用日誌只記 `preview_id` 雜湊、不記查詢字串（Node 層驗證）；託管供應商日誌是否含主機名＝**未驗證**，未確認前視為「主機名可能出現在日誌」 |
| **洩漏的處置** | 偵測到洩漏即由平台撤銷該會話（無須等 TTL）；事件記稽核（不含學生資料） |

---

## 3. 任務 B：作品資料授權

### 3.1 候選方案比較

| 方案 | 安全邊界（works-edge 持有什麼） | 右側互動預覽相容性 | 實作複雜度 | 營運成本 | 尚需驗證的前提 |
| --- | --- | --- | --- | --- | --- |
| **B0 現行**：edge 持單一資料 HMAC 金鑰 | edge 能簽署**任一作品**的請求；入侵 edge＝全作品；無逾時，需被發現並輪替 | 相容（edge 只轉送） | 低 | 低 | 平台端逐請求重驗（已設計）；偵測與輪替流程（CHK014 尚缺） |
| **B1**：由主金鑰衍生每作品金鑰，**主金鑰仍在 edge** | **不縮小**：入侵 edge＝取得主金鑰＝同 B0；撤銷（epoch 遞增）被主金鑰持有者繞過（Spike：嘗試 epoch 1…5 即命中）。僅「單一衍生金鑰外洩」縮小為單一作品 | 相容 | 低～中 | 低 | — （僅列出為對照，不作為選項） |
| **B2：平台簽發每作品授權（grant）；edge 只持有 grant，不持有任何簽署金鑰** | edge 無法鑄造、延長、擴權；grant 含 `{kid, 作品, ops, epoch, exp}`，用 Ed25519 由**平台私鑰**簽署，平台以公鑰驗證；預覽 grant 於兌換時簽發、綁 `preview_id` 與會話到期 | 相容（預覽 grant 隨會話；edge 轉送機制不變） | 中（簽發／推送／驗證；grant 更新機制） | 低～中（定期重簽；推送服務） | grant 推送／讀取機制（Edge Config／KV／部署環境變數）及更新延遲；edge 是否需寫入憑證；`kid` 輪替流程 |
| **B3：每校一把金鑰，只交給該校的 edge 分片；主金鑰僅平台持有** | 入侵一個分片＝僅該校作品；金鑰不逾時 | 相容（預覽網域亦需分片，或預覽另用 B2） | 高（每校一個 edge 專案與網域；URL 結構改變） | 中～高（每校部署、網域、監控） | 每校萬用字元子網域與專案數／費用；路由層若集中則又成單點 |

### 3.2 作品資料可被讀／寫／刪的範圍（Spike 實測；`✔`＝成功）

欄位：作品 w1（S1）、w2（S1）、w3（S2）、w4（已下架）、預覽 p1（已知 id）。

| 方案 | works-edge 遭入侵 | 單一金鑰外洩 | 單一作品權杖外洩 |
| --- | --- | --- | --- |
| **B0** | w1／w2／w3 讀寫刪 ✔、w4 ✖（下架）、p1 ✔（僅限入侵期間經過 edge 而被看見的 id）；**金鑰不逾時，直到輪替** | 同左（單一金鑰＝全域）；p1 無從嘗試 | 無作品權杖。單一已簽請求外洩：僅能在 60 秒窗口內重放該請求（讀 w1） |
| **B1** | 同 B0；**撤銷被繞過** | 主金鑰＝同 B0；單一衍生金鑰＝僅該作品讀寫刪，至 epoch 遞增 | 同上（單一作品） |
| **B2** | **作品集合與 B0 相同**（w1／w2／w3、grant 範圍內讀寫刪；w4 ✖）；但：不能鑄造、延長、擴權、不能碰入侵後新建作品；grant 逾時即失效（**25 小時後 B0 外帶金鑰仍 `200`，B2 外帶 grant 全 `401`**） | edge 不持有金鑰；**平台簽署私鑰外洩＝平台層事故**（可偽造任何 live 作品 grant；以 `kid` 輪替收拾） | 僅該作品、僅 grant 內 ops，至 `exp` 或該作品 epoch 遞增 |
| **B3** | 僅該校（w1／w2）；跨校 `403`；金鑰不逾時 | 同左（該校） | 無（校金鑰即單位） |

**誠實結論**：B2 並未縮小「入侵 edge 時可觸及的 live 作品集合」（與 B0 相同），也不改變公開資料匿名可讀（§0 第 4 點）。它縮小的是：**能力**（無鑄造、可按作品限縮 ops）、**時間**（grant 逾時；B0 金鑰無逾時）、**撤銷粒度**（單作品 epoch；B1 做不到）、**新作品與下架作品**。只有 B3 縮小「集合」，代價高，且只有在資料之後變成非匿名時才有實質意義。

### 3.3 平台端必須獨立檢查（所有方案；Spike 已逐項驗證）

不信任 edge 傳來的任何狀態宣稱。每次請求：簽章／grant 驗證（含 `kid`、`exp`、`epoch`）→ 作品識別字只取自路徑且格式限制 → grant 作品＝路徑作品、`ops` 含此操作 → **自行查 live／會話 active（不經 edge 快取）** → 每作品配額與限流（持金鑰也不可無限讀寫；Spike：持金鑰第 6 次起 `429`）→ 大小與鍵格式 → 受限 RPC 僅能觸及單一作品資料表。HMAC 方案另驗 Body 雜湊、時間窗口、nonce 重放（B2 grant 為 bearer，無此三項，依賴 TLS，為已知取捨）。

### 3.4 輪替與撤銷

| 方案 | 輪替 | 撤銷單一作品 | 撤銷全部 |
| --- | --- | --- | --- |
| B0 | 雙金鑰重疊 → 退役舊金鑰（Spike 通過） | 只有下架（`live`＝false）；無憑證層撤銷 | 輪替＝所有作品同時受影響 |
| B1 | 同 B0 | epoch 遞增（對主金鑰持有者無效） | 輪替主金鑰 |
| B2 | 簽署金鑰 `kid` 雙重疊 → 重簽 grant → 退役舊 `kid`；edge 不需配合持有新金鑰 | epoch 遞增（Spike：他作品不受影響）；下架時同步遞增 | 退役 `kid` |
| B3 | 以校＋版本輪替 | 校內無細粒度 | 退役該校金鑰（Spike：不影響他校） |

### 3.5 推薦：B2；選項 B3（僅在資料變成非匿名時）

**推薦 B2**（grant 有效期上限建議 ≤24 小時、目標 ≤6 小時，數值待核定；預覽 grant ≤ 會話到期）。注意：**把主金鑰衍生為每作品金鑰但仍交給 works-edge 不算縮小**（B1，Spike 已證實撤銷被繞過）。

**推翻 B2 的判準**：
- (a) edge 環境變數、記憶體傾印或部署設定中發現任何可簽署 grant 或資料請求的金鑰（含主金鑰）。
- (b) grant 逾時後仍有任一請求成功；或跨作品／超出 `ops` 的任一請求成功。
- (c) 單作品 epoch 遞增後，舊 grant 在 ≥1 秒後仍成功。
- (d) 以入侵 edge 的方式送出惡意請求時，平台端 live／配額／限流任一檢查被略過。
- (e) grant 推送／更新機制在測試 Team 中需要 edge 持有寫入憑證，或更新延遲使 grant 過期造成作品資料中斷超過教育者可接受的時間（fail-closed 為預設）。

---

## 4. 未驗證項目（本機無法模擬；詳細方法見 RESULTS.md §四）

供應商網域與萬用字元 TLS；Vercel Sandbox 預覽位址是否可繞過（S-05）；Vercel 上 works-edge 的 WebSocket 代理與連線時限；Safari／Firefox／正式版 Edge／ChromeOS；封鎖第三方 cookie 政策下的 Partitioned cookie；`__Host-Http-` 於正式 TLS；供應商日誌是否含主機名；實際撤銷延遲（p50／p95／最大）；B2 grant 推送機制；學生程式以導覽外送主機名。

## 5. 將來若教育者定案，需修改的位置（僅列；本次**未**修改任何 canonical 檔案）

| 檔案 | 位置 |
| --- | --- |
| [contracts/publishing-and-public-runtime.md](./contracts/publishing-and-public-runtime.md) | §3.1「預覽來源與預覽會話」「成立前提」列；§3.3「轉送責任：works-edge」「資料服務」「讀寫授權」「與 works-edge 職責的一致性」列；§3.4「預覽會話的單位」「首次兌換」「子資源與重新整理」「資料 API」「過期與延長」「撤銷」「安全性質與殘餘風險」「前提與唯一阻擋點」列；§3.5 全節（準確描述、金鑰外洩影響、平台端責任、驗證） |
| [plan.md](./plan.md) | 第 90、101、106 行（架構圖與「第九輪更正」）；第 142 行（預覽反向代理補強）；第 322 行（定點修正彙整列） |
| [data-model.md](./data-model.md) | 第 250 行（`work_data_stores` 列與預覽暫存命名空間；若選 B2 另需 grant／epoch／`kid` 欄位；A1 需會話 cookie 雜湊欄位） |
| [contracts/projects-agent-sandbox.md](./contracts/projects-agent-sandbox.md) | 第 25 行（E-3）；第 56 行（`startPreview`） |
| [research.md](./research.md) | R-13（第 413 行）；作品資料服務列（第 418 行） |
| [quickstart.md](./quickstart.md) | S-05（第 26 行）；V-53（第 175 行，(m)、(p) 及新增項） |
| [decision-register.md](./decision-register.md) | D-08（第 217 行）；PP-01（第 443 行；預覽另設更短 TTL 時） |
| [checklists/plan-finalization.md](./checklists/plan-finalization.md) | CHK001、CHK008、CHK009、CHK010、CHK011、CHK014、CHK016、CHK022 |

---

## 6. 結尾：請教育者在兩個方案中擇一

| | **方案甲（建議）** | **方案乙（保守）** |
| --- | --- | --- |
| 預覽（A） | **A1**：主機名＋分區 cookie 逐請求驗證；不支援的瀏覽器顯示「暫不支援預覽」 | **A0 加固**：維持主機名；採 §2.5 全部硬性規定（含 ≤15 秒撤銷、WS 週期重驗） |
| 作品資料（B） | **B2**（每作品 grant，edge 不持簽署金鑰） | **B2**（同左） |
| 取得的好處 | 洩漏主機名單獨無用；入侵 edge 後的持續性與能力受限 | 無瀏覽器相容性風險；現在即可運作 |
| 接受的風險 | 可能有學校裝置／政策不支援；需 Safari／Firefox／管理政策實測 | 主機名洩漏＝在 ≤30 分鐘內任何人可存取該預覽與其暫存資料 |
| B3 | 僅當作品資料日後變成非匿名、且要求「單校外洩不波及他校」時再議 | 同左 |

**兩案共同的剩餘風險**：沙箱預覽位址是否可繞過 edge（S-05，文件稱公開可達）；Vercel 上 WebSocket 代理（beta、連線時限、未見代理說明）；公開作品資料匿名可讀寫，其保存／清除與個資規則尚未定義（publishing §3.3「待展開」）；works-edge 被入侵的偵測與回應（CHK014）。

**尚未完成的實測**：§4 全部。**本次僅完成**：本機合成 Spike（Node 層 19 項通過；Chromium 150 的 Cookie 與 iframe 行為），**未**在任何供應商網域、TLS、Safari／Firefox、學校裝置上驗證。
