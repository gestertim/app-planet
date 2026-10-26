# VC-1～VC-3 供應商實測結果（Vercel Sandbox；2026-10-21）

> **狀態**：研究輸入（Plan 定稿前的可行性探針）；**不是** canonical Plan 的已批准設計、**不是**實作批准、**不是** Readiness Gate 的驗收（S-13／V-53 等仍〔未執行〕）。Plan 仍為草案。
> **前置已核對**：Git 根目錄 `C:/Users/geste/spec-kit/app-planet`；`.specify/feature.json` → `specs/001-app-planet-platform`（未依分支名推斷）。
> **授權依據**：[decision-register.md](../../decision-register.md) D-16「後續」決定（2026-10-21）：方案 X、路徑 M 為待驗證首選；授權一個專用、隔離的 Vercel Pro 測試 Team，僅用合成資料。**未使用**承載其他產品的 Hobby Team（全程以 `--scope app-planet-vc-test` 或該 Team 專案的 OIDC 權杖操作）。
> **數值標示**：「測試值」＝本次量測結果；「建議起始閾值」＝[RESULTS-beta2-call-path.md](./RESULTS-beta2-call-path.md) §4 的**未核定**建議；教育者尚未核定任何正式閾值，下列「對照」欄**只回報，不判通過／失敗**（除非判準本身不依賴數值）。

## 0. 先讀這幾點

| # | 結論 |
| --- | --- |
| 1 | **測試 Team 是「Pro 試用」，不是付費 Pro**：`plan=pro`、`status=trialing`、試用至 2026-11-04 10:48 UTC 且已排定取消；未輸入付款資料、**未付款**。供應商實際套用的是 **Hobby 級**限額（並行沙箱 10；控制面 1,000 rpm，規則名稱 `api-sandboxes-control-plane-hobby`；曾觸發 `Pro trial plan usage limit exceeded for Snapshots Storage` 402）。教育者／使用者於本輪選擇**不轉為付費 Pro**，因此**「Pro 限額」與「20 人並行」未量測**（見 §5、§7）。 |
| 2 | **VC-1**：**未觸發任何失敗判準**（無憑證直連、管理憑證外洩、自行建立路由皆未發生）。但 `ports: []` 沙箱沒有任何主機名，**無法對「未知的 system route」做窮舉探測**——此為方法上的限制，不是「已證明不存在」。 |
| 3 | **VC-2**：受限出站下取回產物成功；惡意產物 12 種全部被入庫驗證器整份拒絕。儲存→重建→iframe 可見 **p50 3.5 s／p95 4.3 s（N=30，暖沙箱）**。**取回頻寬偏低（≈0.2 MB/s）**：接近 5 MB 上限的產物取回要 12～18 s。 |
| 4 | **VC-3**：M 的**安全／隔離性質成立**（OIDC 專案隔離、`deny-all`、`delete` 可終止在途並拒絕新呼叫）；但**延遲偏高**：每請求新建 p50 3.5 s／p95 7.0 s；恢復 p50 8.1 s／p95 16.6 s；暖 p50 2.0 s／p95 2.6 s（全部**超過**未核定的建議起始閾值 3 s／1 s／1 s）。另有兩個**設計地雷**：`stop()` **不是**撤銷（同一控制代碼下一次呼叫會自動復活沙箱）；呼叫端 `AbortSignal` **不會**終止沙箱內程序。 |
| 5 | **是否推翻 X／M**：**X 未被推翻**；**M 未被硬性判準推翻**，但延遲（M-c）依建議起始閾值全面超標、控制面額度為 **Team 層級共用**（公開流量會與學生 Agent／建置共用）——兩者都需教育者核定閾值與（若要 Pro 數字）付費 Pro 重測，才能判定。**不啟動 W**。 |
| 6 | **費用**：Sandbox 牌價用量合計 **$0.42**，**實際應付 $0.00**（試用抵用）；每請求新建牌價 ≈ **$1.17／千次**（≈95% 為記憶體每 session 最低 1 分鐘），與帳單增量相符（§5）。Team 試用至 2026-11-04 10:48 UTC 並排定取消；未付款。 |

## 1. 環境與資源

| 項目 | 內容 |
| --- | --- |
| Team／專案 | 新建 `app-planet-vc-test`（CLI 建立）；專案 `vc-sandbox-test`（P1）、`vc-sandbox-test-2`（P2，僅供 OIDC 隔離與額度範圍測試）。 |
| 方案狀態 | `plan=pro`、`status=trialing`；試用期 2026-10-21 07:00 UTC～2026-11-04 10:48 UTC；`cancelation` 欄位＝試用結束時間（已排定取消）。 |
| 沙箱 | `@vercel/sandbox` 3.8.0；區域 `hnd1`；`resources.vcpus=1`（實際 2,287 MB 記憶體、64 GB 磁碟）；`ports: []`、`networkPolicy: 'deny-all'`、`persistent: false`（另有指定項）。預設 vcpus 為 2／4,096 MB（若不指定）。 |
| 測試端 | 本機 Windows、Node 24.19.0；Chrome 155 無頭（僅 VC-2 iframe）。對 `api.vercel.com` 的 REST 往返基線 **p50 273 ms／p95 308 ms／max 580 ms（N=20）**——所有延遲含此往返，**非**平台內網延遲。 |
| 資料 | 全為合成資料；未讀、未印、未提交任何金鑰；OIDC 權杖僅存於工作階段資料夾（已排除於本 repo）。 |
| 原始結果與腳本 | [vc/](./vc/)（`results/*.json`、`results/results-*-console.txt`；腳本 `vc*.mjs`、`lib.mjs`）。 |

## 2. VC-1：零暴露埠（`ports: []`）

**方法**：建立三個沙箱（hnd1）：控制組 `ports:[3000]`＋`deny-all`；受測組 `ports:[]`＋`deny-all`；補充組 `ports:[]`＋`allow-all`。三者內以 root 在 80／443／3000／5173／8080／23456／26661 啟動回傳 `CANARY` 的 HTTP 伺服器（含 WebSocket 升級回 101＋`WSCANARY` 幀）。外部以**不帶任何憑證**的 Node `https`／`http` 直連；另以 root 在 VM 內掃描憑證與控制面。原始：[vc1-raw.json](./vc/results/vc1-raw.json)、[vc1b-raw.json](./vc/results/vc1b-raw.json)、[vc1c-raw.json](./vc/results/vc1c-raw.json)。

| 檢查 | 實際結果 |
| --- | --- |
| 路由表 | 受測組與補充組：SDK `routes=[]`；REST `GET /v2/sandboxes/{name}` 的 `routes: []`（兩次）；`sandbox.domain(p)` 對 7 個埠全部丟出 `No route for port p`。控制組有 1 條 `https://sb-<12 碼>.vercel.run → 3000`（**不是**由沙箱 ID 或埠推導，不可猜）。 |
| 探針有效性（正對照） | 控制組主機：`GET /` → **200** `CANARY:control:3000:/`；WebSocket 升級 → **101**（含 `WSCANARY`）。 |
| 同主機的其他埠 | `:5173`、`:8080`、`:23456`、`:26661`（http／https）→ **全部逾時**（無路由）；`:80` https → `ECONNRESET`、http → `308`（轉 https）；`:443` → 200（即該主機的標準 HTTPS 埠＝同一條 3000 路由，非另一個沙箱埠）。 |
| 不存在主機基線 | `https://sb-doesnotexist00.vercel.run/` → **404 `SANDBOX_NOT_FOUND`**。 |
| 受測組：以可得識別碼推測主機名 | 64 個候選（`<name>`、`<sessionId>`、去前綴 sessionId、`sb-`前綴、`-<port>` 後綴 × 7 埠）＋2 次 WebSocket 升級：**65／66 回 404 `SANDBOX_NOT_FOUND`**；**1／66 回 200＝控制組主機本身**（我的識別碼清單誤含控制組子網域；**不是**受測組）。受測組 0 次命中。 |
| 無憑證管理 API | `GET /v2/sandboxes/{name}` 無權杖 → **403**。 |
| VM 內（root、`sudo ALL`；deny-all）憑證掃描 | 掃描所有行程 `environ`（只印名稱／長度／形狀）與 `/etc /root /home /vercel /run /opt /var/lib /tmp /usr/local /srv` 檔案內容：**`NO_FINDINGS`**（無 JWT 形狀、無 `VERCEL_*TOKEN`／`OIDC` 名稱、無憑證檔）。（第一次掃描被自身腳本文字誤報，已改以檔案載入並排除自身後重跑，見 `vc1b`。） |
| VM 內控制面 | `*:23456` 有監聽（`ss` 看不到行程）；對 `127.0.0.1:23456` 與 `169.254.0.2:23456` 的 14 個路徑 × GET／POST／PUT（42 次）**全部 404**；嘗試後路由表仍為 `[]`。`/run/vercel/share/init.sock` 權限 `0600 ubuntu`（未進一步探測協定）。 |
| VM 內出站（deny-all） | IMDS `169.254.169.254` exit 7、`api.vercel.com` exit 6（DNS 失敗）、`10.0.0.1` exit 28、`getent hosts api.vercel.com` exit 2：全部失敗。 |
| 補充（allow-all，**僅此組**） | 無憑證 `curl https://api.vercel.com/v2/sandboxes` → 403；`PATCH …/sandboxes/none {"ports":[3000]}` → 403 `missing authentication token`：沙箱內無憑證可用，亦無法自行建立路由。 |

**判定**：判準 (a)「無憑證可到任何路由」——**未觸發**；(b)「VM 內可取得管理憑證／自行建路由」——**未觸發**。
**限制（不得略過）**：① 受測組沒有主機名，外部探針只能對「可推導的名稱」與「同主機的其他埠」進行，**不能**證明不存在不可猜的 `system` route（REST `routes` 也不列出 system route）；② 僅單次、單一區域（hnd1）、單一映像（`universal`，sha256 見 [vc1-raw.json](./vc/results/vc1-raw.json)）；③ 23456 內部服務只探測了 HTTP 404；④ 這是 Plan 階段的可行性證據，Readiness Gate 仍須以正式映像／設定重跑並納入管線回歸。

## 3. VC-2：產物取回、重建延遲、撤銷

**範圍界定**：供應商段＝Vercel Sandbox 同步來源→建置→打包→管理通道取回；**本機段**＝本機閘道（真實時鐘、授權狀態快取 TTL）＋本機 Chrome iframe；**不是** Vercel works-edge，也未部署到 Vercel。iframe 重載由平台頁每 250 ms 輪詢 `/api/version` 觸發（不用 `postMessage`），因此「綁定→可見」含 ≤250 ms 的輪詢。原始：[vc2-raw.json](./vc/results/vc2-raw.json)（N=3 的試跑另存 `vc2-dryrun-n3.json`）。

### 3.1 延遲（單位 ms；N 為樣本數；**無教育者核定閾值，只回報**）

| 路徑 | N | 階段 | p50 | p95 | max |
| --- | --- | --- | --- | --- | --- |
| 暖沙箱重建（編輯循環） | 30 | 同步來源 `writeFiles` | 1,053 | 1,467 | 1,489 |
|  |  | 建置＋打包（`runCommand`） | 806 | 1,259 | 1,354 |
|  |  | 取回（`readFileToBuffer`，139 KB tgz） | 1,354 | 1,802 | 1,851 |
|  |  | 入庫驗證（本機） | 4 | 10 | 10 |
|  |  | **儲存→取回→入庫（供應商段合計）** | **3,264** | **4,173** | 4,175 |
|  |  | 綁定→iframe 可見（本機，含 ≤250 ms 輪詢） | 124 | 245 | 260 |
|  |  | **儲存→iframe 可見（端到端）** | **3,500** | **4,276** | 4,371 |
| 冷啟動（新建→首次建置→可見） | 10 | 沙箱建立 | 1,318 | 2,157 | 2,157 |
|  |  | 端到端 | **6,521** | **7,601** | 7,601 |
| 8 並行沙箱 × 3 輪（僅供應商段） | 24 | 儲存→取回→入庫 | 3,587 | 4,138 | 4,549 |

> **並行數只有 8、不是 20**：試用 Team 的並行沙箱上限為 10（§4.4），無法執行「課堂尖峰 20 人並行」。該項〔未量測〕。

**取回頻寬**（`readFileToBuffer`，不可壓縮的隨機資料）：2.0 MB tgz 9.4～9.8 s；2.7 MB 12.4 s；4.1 MB 18.0 s（≈0.2～0.23 MB/s）。已核准的上限（單檔 1 MB、總量 5 MB、200 檔）內，**取回時間可達 12～18+ s，會主導重建延遲**。可文字壓縮的真實前端產物通常遠小於此，但 Agent 產出含圖片的作品可能落在此區間。

### 3.2 受限出站

| 步驟 | 結果 |
| --- | --- |
| `deny-all` 下取回產物 | **成功**（管理通道不經沙箱出站）；入庫通過。 |
| `deny-all` 下 `npm install` | 逾時（`timeout 20` → exit 124）＝被封鎖。 |
| 切換為 `{allow:['registry.npmjs.org']}`（`sandbox.update`） | 成功，**1,419 ms**；`npm install is-odd` 成功（496 ms）；`example.com`、`github.com`、`api.vercel.com`、IMDS 全部失敗。 |
| 切回 `deny-all` | 成功，**988 ms**；`npm install` 再度逾時、registry 再度連不上；最終政策讀回 `"deny-all"`。 |

### 3.3 惡意／邊界產物（取回成功，再由入庫驗證器〔[c/artifact-gateway.js](./c/artifact-gateway.js) 的 `ingestArtifact`〕判定）

| 案例 | 取回 | 入庫結果 |
| --- | --- | --- |
| 良性 | ✔ | **接受** |
| 符號連結（→`/etc/passwd`）、硬連結 | ✔ | 拒絕 `not-regular-file` |
| 路徑 `../escape.html`、絕對路徑 `/tmp/abs.html` | ✔ | 拒絕 `bad-path` |
| `_work/data/v1/x.js` | ✔ | 拒絕 `reserved-prefix` |
| `_headers`、`.sh` | ✔ | 拒絕 `type-not-allowed` |
| 單檔 2 MB | ✔（9.8 s） | 拒絕 `file-too-large` |
| 300 檔 | ✔ | 拒絕 `file-count` |
| `A.js`／`a.js` | ✔ | 拒絕 `duplicate-path` |
| 無 `index.html` | ✔ | 拒絕 `no-index` |
| 總量略低於上限（≈3.6 MB 解壓、2.7 MB tgz） | ✔（12.4 s） | **接受** |
| 總量略高於上限（≈5.4 MB 解壓） | ✔（18.0 s） | 拒絕 `total-too-large` |

> 注意：驗證器的「單檔 1 MB／總量 5 MB／200 檔」是 Spike 預設，**不是**核定值。

### 3.4 撤銷延遲（**僅本機閘道；與供應商無關**）

| 授權快取 TTL | N | min | p50 | p95 | max | 備註 |
| --- | --- | --- | --- | --- | --- | --- |
| 2,000 ms | 30 | 32 | 870 | 1,952 | 1,982 | 全部 ≤ TTL（隨機落在快取窗口內）；0 次未拒絕 |
| 0 | 30 | 0.8 | 1.9 | 5.1 | 5.5 | 立即 |

撤銷＝解除產物綁定／授權狀態，**不依賴沙箱 `destroy`**；供應商段在撤銷路徑上無貢獻，故此數字不能外推到 works-edge 的跨區網路與快取行為（Readiness Gate 另測）。

**VC-2 判定（判準 c／d／e）**：(c) 未觸發；(d) 取回在 `deny-all` 可行；重建→可見延遲的「可接受值」**未核定**，只提供上表；(e) 本機撤銷延遲 ≤ TTL。**限制**：閘道與瀏覽器皆本機；N=30 暖／N=10 冷；單一區域；未測 20 並行。

## 4. VC-3：β2 呼叫路徑 M（每請求新建、恢復、暖）

**合成程式**：`/opt/fn/handler.js`（讀 JSON 請求檔、做 2×10⁵ 次迭代雜湊、輸出 JSON）＋ manifest；以「快照」預載（一次性建置，`createBase` 1,151 ms、`snapshot()` 1,460 ms）。**invoker**＝測試腳本（本機）；每請求步驟：`Sandbox.create`（`source:{type:'snapshot'}`、`ports:[]`、`deny-all`、`persistent:false`、1 vCPU）→`writeFiles`（請求）→`runCommand`（固定 argv）→讀 stdout→`stop`。原始：[vc3a-raw.json](./vc/results/vc3a-raw.json)。

### 4.1 延遲（ms；N=30／格；**建議起始閾值未核定，「對照」只作參考**）

| 路徑 | 到回應 p50 | p95 | max | 備註（API 呼叫數：到回應／含停止） | 對照建議起始閾值（未核定） |
| --- | --- | --- | --- | --- | --- |
| **每請求新建**（快照→新沙箱） | **3,512** | **6,959** | 7,098 | 3／4；`create` p50 1,433／p95 4,078；`stop` p50 2,981（不在回應路徑上） | 新建 p95 >3 s ＝**超出** |
| **恢復**（持久、具名；`get`→首次呼叫自動恢復→`stop` 自動快照） | **8,053** | **16,621** | 17,272 | 5／6；首次呼叫（含恢復）p50 6,419／p95 15,292；`stop`（含快照）p50 3,322 | 恢復 p95 >1 s ＝**超出** |
| **暖**（已執行；`writeFiles`＋`runCommand`） | **1,983** | **2,610** | 2,767 | 2／2；同一沙箱並行 10：牆鐘 2,829、單次 p50 2,044／p95 2,829 | 暖 p95 >1 s ＝**超出** |

- **意義**：各路徑延遲主要是供應商服務端時間，而非網路（REST 往返基線 273 ms）。若 invoker 部署在供應商內網或同區，可能降低**網路**部分，但沙箱建立／恢復／`runCommand` 的服務端時間不會因此消失——**這是推測，未驗證**。
- **新建路徑 vs 暖路徑**：新建只比暖多約 1.5 s（p50），但暖沙箱會跨請求共用狀態，破壞訪客間隔離（M-h）。
- **恢復路徑不建議**：每次 `stop` 都產生**完整快照（每份約 821 MB）**；30 次後累積 37 份（≈30 GB），並讓試用 Team 觸發快照儲存用量上限（402）。

### 4.2 OIDC 專案隔離（M-a／VC-3d）

以 **P2 的 OIDC 權杖**嘗試存取 **P1** 的資源；P1 權杖作為正對照（[vc3c2-raw.json](./vc/results/vc3c2-raw.json)；第一次嘗試 [vc3c-raw.json](./vc/results/vc3c-raw.json) 因「對 OIDC 權杖傳入顯式 `projectId`」不被接受且遇快照儲存 402，保留為紀錄但**不採用其結論**）。

| 嘗試（P2 權杖） | 結果 |
| --- | --- |
| `Sandbox.get(P1 具名沙箱)`；再 `readFile` | 404 `not found for this project`（讀不到 P1 的檔案） |
| 自 P1 快照建立沙箱；`Snapshot.get(P1 快照)` | 404 `Snapshot not found`／`Vercel Sandbox not found` |
| `Sandbox.list`／`Snapshot.list` | 各 0 筆（看不到 P1 的沙箱／快照） |
| REST 取 P1 沙箱（含 `teamId`；含 `projectId=P1`）；以 P1 session ID 讀檔 | 404／`Could not find project`／404 |
| 正對照（P1 權杖讀自己的沙箱檔案） | 成功 |

**結論**：OIDC 權杖依**專案**隔離沙箱與快照存取；同一 Team 的另一專案不可讀寫。M 以獨立「β2 執行」專案承載、不用 Team 級 access token 的設計**在此層成立**。**但控制面額度不是專案層級（§4.4）。**

### 4.3 停用／下架與在途呼叫終止（M-f／VC-3f；N=10／格，[vc3e-raw.json](./vc/results/vc3e-raw.json)）

在途呼叫＝`runCommand sleep 120`（或 `detached`）；2 s 後觸發撤銷動作。

| 動作 | 撤銷呼叫耗時 p50／p95 | 在途呼叫終止（自觸發起）p50／p95／max | 在途結果 | **之後的新呼叫（同一控制代碼）** |
| --- | --- | --- | --- | --- |
| `sandbox.stop()` | 2,942／4,073 | 2,942／4,073／4,073 | exit 143（SIGTERM） | **10／10 成功；狀態 `stopped`→`running`（自動復活）** |
| `command.kill('SIGKILL')` | 789／1,147 | 1,906／2,306／2,306 | exit 137 | 10／10 成功；沙箱**仍在執行** |
| `sandbox.delete()` | 698／1,050 | **6,002／6,466／6,466** | exit 143 | **10／10 拒絕（404）** |

重點發現：
1. **`stop()` 不是撤銷**：它終止在途程序，但任何持有控制代碼的後續 SDK 呼叫會**自動恢復**沙箱（`persistent:false` 亦然，狀態回到 `running`）。M 的 invoker 必須在撤銷時用 **`delete()`**（並在每次呼叫前重驗 `listing`）；僅 `stop()` 會在「檢查→呼叫」競態中留下復活風險。
2. 以 `delete()` 撤銷：在途呼叫自觸發起 p50 6.0 s／max 6.5 s 結束（遠小於建議 15 s，但**閾值未核定**）；刪除 API 本身 p50 0.7 s 回傳，**在途程序仍續跑約 5 s**。
3. **呼叫端 `AbortSignal` 不會終止沙箱內程序**：`runCommand({signal})` 在 2,002 ms 於客戶端中止，但沙箱內 `sleep` 仍在（`pgrep` ＝1）。invoker 的逾時**不能**等同終止；須靠 `kill`／`delete`／沙箱 `timeout`。
4. 沙箱層逾時有效：`timeout: 15000` → 於建立後約 17.8 s（2 s 輪詢粒度）狀態轉 `stopped`。
5. 記憶體：1 vCPU 沙箱可見 2,287 MB；程式配置 ≈6.4 GB → 被 OOM 終止（exit 137）。出站（自快照建立的 `deny-all` 沙箱）：`example.com`、`1.1.1.1`、IMDS、`api.vercel.com`、npm registry、`api.openai.com` **全部失敗**。

> 「下架後新請求不通過」的**平台側**部分（listing 狀態＋epoch＋grant）沿用本機 d/ 契約測試（46／46，屬本機）；本次只量測了供應商的終止原語，**未**量測端到端的「下架→新請求被拒」（含資料庫查詢與 works-edge 跨網路）〔未執行〕。

### 4.4 控制面限額與並行（**試用級＝Hobby 級；非 Pro**）

| 量測 | 結果 |
| --- | --- |
| 並行沙箱 | 30 個並行「每請求新建」：19 成功、**11 失敗 429 `Concurrency limit exceeded (10)`**。 |
| 控制面（唯讀）| 600 次 `GET /v2/sandboxes/{name}`（並行 60）全 200（3.4 s）；回應標頭 `x-ratelimit-limit: 1000`。 |
| 控制面（`fs/read` 突發，P1） | 1,350 次請求／15.9 s 中，**第 1,234 次起 429**；`Retry-After: 60`；規則 `api-sandboxes-control-plane-hobby`（「more than 1000」）；計數**連續回補**（約每秒十餘次），非整分鐘重置；65 s 後恢復 200。（[vc3d-p1-raw.json](./vc/results/vc3d-p1-raw.json)） |
| **額度範圍** | 同時以 **P2 權杖**每 400 ms 輪詢：P2 的 `x-ratelimit-remaining` 由 184→85→**0**，並在 P1 首次 429 後 45 ms 收到 **429**（[vc3d-p2-raw.json](./vc/results/vc3d-p2-raw.json)）。⇒ **額度以 Team 為單位，跨專案共用**。 |
| 429 期間的建立／執行 | 單次取樣：`Sandbox.create` 1,771 ms、`runCommand` 742 ms 皆成功（**只有一個樣本，不能推論額度分桶**）。 |
| 每請求控制面呼叫數 | 新建 3（到回應）＋1（停止）；暖 2。 |

**含意**：① 以「獨立專案」不能隔離控制面額度；若公開 β2 流量與學生 Agent／建置同 Team，匿名訪客可耗盡教學功能額度（RESULTS-beta2-call-path §1.3 的假設**成立**）；M-e 的緩解只剩「為 β2 另立 Team」（教育者尚未決定）。② 文件所載 Pro 值（10,000 並行／10,000 rpm）**未量測**。③ 每請求 3～4 次控制面呼叫，在 1,000 rpm 下約 250～330 請求／分（**Hobby 級**）；Pro 值須付費 Pro 重測。

### 4.5 費用與帳單對照

見 §5。

## 5. 實際費用與帳單對照

> 費率取自該 Team 的供應商費率表（`hnd1`、x86_64）：Active CPU $0.202／小時；佈建記憶體 $0.0334／GB‑小時；建立 $0.60／百萬次；資料傳輸 $0.16／GB。以下「effective」＝牌價用量；「billed」＝實際應付（試用抵用後）。

### 5.1 以用量紀錄對照模型（每請求新建；N=40；1 vCPU／2 GB；[vc3f-run1-raw.json](./vc/results/vc3f-run1-raw.json)）

| 項目 | 供應商逐筆用量計數（合計／每請求） | 模型（牌價） | 備註 |
| --- | --- | --- | --- |
| Active CPU | 41,626 ms／**1,041 ms** | $0.002336（$0.0000584／請求） | 模型先前假設 200 ms；實測**約 5 倍**（含 Node 啟動），但在總成本中僅約 5% |
| 沙箱存活時間 | 140,052 ms／3,501 ms | 若按實際時間：$0.002599；**若每 session 至少 1 分鐘：$0.044533（$0.0011133／請求）** | 見下方帳單增量：**1 分鐘最低計費成立** |
| 建立 | 40 次 | $0.000024 | 吻合 |
| 資料傳輸 | 入 196,605 B／出 113,213 B | $0.0000496 | 吻合 |
| **每請求合計** | — | **≈ $0.00117／請求＝ $1.17／千次**（10 萬次／月 ≈ $117；100 萬次／月 ≈ $1,174；牌價） | 其中 **≈95% 是記憶體 1 分鐘最低計費** |

與 [RESULTS-beta2-call-path.md](./RESULTS-beta2-call-path.md) §1.3 的算術模型（$0.71／千次，**iad1 費率**、CPU 200 ms）相比：**約 1.64 倍**，主因是 hnd1 費率較高（CPU $0.202 vs $0.128；記憶體 $0.0334 vs $0.0212）。**M-d（>2 倍）未觸發**；PP-19 每作品費用上限**未核定**，故無法判定「合格範例作品是否超出上限」。（更正註記：`vc3f-run1-raw.json`／`vc3f-raw.json` 的 `model.usd` 當時誤以 $0.00006／次計建立費，使其 `totalWithMin1Min` 偏高；正確為 $0.0000006／次，本節與 `vc3f.mjs` 已更正，原始計數未受影響。）

### 5.2 以 Team 帳單增量對照（`vercel usage`；牌價 USD）

供應商用量檢視**延遲約 30～60 分鐘**才更新（分次整批出現）。取兩次相鄰更新（含本次 N=40 批次）相減：

| 服務 | 更新前 | 更新後 | **增量** | 模型 |
| --- | --- | --- | --- | --- |
| Sandbox Active CPU | $0.028909 | $0.031299 | **+$0.002390** | $0.002336 |
| Sandbox Creations | $0.000136 | $0.000160 | **+$0.000024** | $0.000024（逐位吻合） |
| Sandbox Data Transfer | $0.006850 | $0.006901 | **+$0.000051** | $0.0000496 |
| Sandbox Provisioned Memory | $0.321495 | $0.368237 | **+$0.046742** | 1 分鐘最低 $0.044533；實際時間 $0.002599 |
| Snapshot Storage | $0.01296 | $0.01296 | 0 | — |

增量涵蓋同一區間內的少量其他活動（先前中斷的一次重跑與清理），記憶體多出的 ≈$0.0022 約等於 1～2 個 1 分鐘 session；**結論：模型與帳單相符（CPU ±2%、建立與傳輸吻合），且確認記憶體以每 session 最低 1 分鐘計費**。這只是 N=40、非 ≥1,000 請求的對帳（Readiness Gate 前須補足）。

### 5.3 本次實際花費

| 項目 | 金額（USD） |
| --- | --- |
| Sandbox 牌價用量合計（Active CPU 0.0313＋佈建記憶體 0.3682＋快照儲存 0.0130＋資料傳輸 0.0069＋建立 0.0002；更新截至 N=40 批次） | **$0.4196** |
| Pro 席位（試用期間按比例牌價） | $1.2903（**試用抵用，未應付**） |
| 牌價合計 | $1.7099 |
| **實際應付（billed）** | **$0.00** |

- 用量以 `vercel usage` 逐步監看，**未接近**「用盡 Pro 內含 US$20 用量抵用額」的情形（Sandbox 牌價用量約為其 2%），因此**沒有**因額度而提前停止。**注意**：用量檢視有 30～60 分鐘延遲，所以「逐步監看」是事後對照；各批次是以「每批次預估 <US$0.5」事先估算後才執行。
- Spend Management 未設定，亦**不視為**硬性上限。
- 本表只涵蓋至更新截止點；其後僅有清理（刪除）動作，預期可忽略，**但以供應商後續更新為準**。

## 6. 對判準的逐項對照

| 判準 | 結果 |
| --- | --- |
| 預覽 (a) `ports:[]` 外部無憑證可達任一路由 | **未觸發**（§2；限制見 §2） |
| 預覽 (b) VM 內取得管理憑證／自建路由 | **未觸發**（§2） |
| 預覽 (c) 惡意產物改變閘道標頭／遮蔽 `/_work/*`／路徑逃逸 | **未觸發**（§3.3；入庫驗證器整份拒絕 12 種） |
| 預覽 (d) 取回在 deny-all 不可行／延遲超出核定值 | 取回可行；**核定值不存在，無法判定**（§3.1） |
| 預覽 (e) 撤銷延遲 >TTL | **未觸發**（本機，§3.4；供應商不在撤銷路徑上） |
| M-a 零路由／VM 內憑證 | **未觸發**（同 (a)(b)） |
| M-b `deny-all` 下連得出去 | **未觸發**（§4.3、§3.2） |
| M-c 延遲（建議：新建 p95>3 s、恢復／暖 p95>1 s） | **三格皆超出建議起始閾值**；閾值**未核定→只回報，不判**（§4.1） |
| M-d 單位成本 >模型 2 倍 | **未觸發**：實測（牌價）≈ $1.17／千次 ≈ 先前模型的 1.64 倍（§5.1）；PP-19 未核定，無法判定單作品是否超出上限 |
| M-e 公開流量使控制面 429 並影響 Agent／建置 | **試用級已觀察到 Team 共用額度**；Pro 值未量測，無法判定改用獨立 Team 後是否足夠（§4.4） |
| M-f 撤銷後新請求／在途 >15 s | `delete()`：在途 max 6.5 s、新呼叫 10／10 拒絕（**通過建議值，閾值未核定**）；`stop()` **不能**作為撤銷（§4.3） |
| M-g 範例作品需長連線 | 教育者已明文排除 WebSocket／SSE／常駐／背景工作（D-16 後續決定）；不適用 |
| M-h 隔離↔費用 | 暖沙箱共用狀態、新建延遲高約 1.5 s；每請求新建牌價 ≈ $1.17／千次（§5.1） |

## 7. 剩餘 Plan 定稿阻擋項

1. **教育者核定閾值**：重建→可見延遲（目前測試值 p50 3.5 s／p95 4.3 s，取回頻寬 ≈0.2 MB/s）、β2 延遲（新建 p95 7.0 s、暖 p95 2.6 s、恢復 p95 16.6 s）、撤銷（建議 15 s）；PP-19 每作品請求／費用上限。**目前無任何核定閾值，故所有延遲「只回報不判通過」。**
2. **β2 延遲是否可接受**：三路徑在建議起始閾值下全部超標；若不可接受，M 的延遲（M-c）須由教育者決定「調整閾值」或「改評 W」。W 屬新增供應商（憲章：須交教育者決定）；本輪**未**啟動。
3. **控制面額度（M-e）**：試用級已證實額度**以 Team 共用**；Pro 的 10,000 並行／10,000 rpm 是否足夠、以及是否為 β2 另立 Team，**未量測／未決定**（需付費 Pro 重測，使用者本輪選擇不轉換）。
4. **未量測**：20 人並行（僅 8 並行）；≥1,000 次請求對帳（僅 N=40）；Pro 限額下的公開流量壓測；works-edge 在 Vercel 上的真實撤銷／重載（本機閘道替代）；端到端「下架→新請求被拒」（僅量測供應商原語）。
5. **設計修正項（會進 Plan／契約，待教育者批准後才改 canonical）**：撤銷必用 `delete()`（`stop()` 會被後續呼叫復活）；invoker 逾時須配合 `kill`／`delete`／沙箱 `timeout`（呼叫端 `AbortSignal` 不終止程序）；不採「恢復」路徑（每次 `stop` 一份 ≈821 MB 快照）；產物上限須顧及取回頻寬（或改以建置端壓縮／限制總量）；`system` route 的存在性只能由供應商書面確認或 Gate 前以正式設定再驗。
6. 既有未決阻擋項（本輪未處理）：VC-4（A1 目標瀏覽器與公開信任 TLS）、VC-5（B2 grant 推送機制）、CHK014 works-edge 入侵偵測等。

## 8. 清理與訂閱狀態

| 項目 | 狀態 |
| --- | --- |
| 沙箱／快照 | 已刪除（兩個專案皆 0 個沙箱、0 份未刪除快照；`wipe.mjs`、`cleanup.mjs` 回報） |
| 專案 | `vc-sandbox-test`、`vc-sandbox-test-2` 已刪除（`project ls` 回報 0 個專案）；Team 本身**保留**（未刪除，亦未動用其他 Team）。測試期間 CLI 預設 scope 被新 Team 取代，已以 `vercel switch` 還原為原本的 Team。 |
| 本機機密 | OIDC 權杖（`.env.local`）與 `.vercel` 連結檔僅存於工作階段資料夾，測試後已刪除；本 repo 內掃描無 JWT 形狀字串 |
| Team 訂閱 | `plan=pro`、`status=trialing`；試用結束 **2026-11-04 10:48 UTC**，`cancelation` 已排定同一時間；**未輸入付款資料、未付款、實際應付 $0.00**；牌價的 Pro 席位 $1.29 為試用抵用。為避免遺留續費，**建議使用者在 Vercel Billing 頁自行確認 Team 未綁定付款方式**（本輪未讀取付款資料）。若要保留 Team 作為日後重測，請勿在試用結束前轉為付費方案，除非要重測 Pro 限額。 |

## 9. 未執行／限制聲明

- 未執行 /speckit-tasks、/speckit-analyze、/speckit-implement；未 commit／push；未動上層 AnywhereTalk repository；canonical 中除決策紀錄與契約 §6 的能力邊界句外**未**修改（Plan 仍為草案）。
- **未量測**：付費 Pro 的限額、20 並行、≥1,000 次請求、works-edge、A1／B2、真實學生網路環境、跨區延遲、不可猜 `system` route。
- 所有延遲含本機到 `api.vercel.com` 的往返（p50 273 ms）；invoker 若部署在同區可能較低（未驗證）。
- 試用 Team 的限額與付費 Pro 不同；本檔所有「限額」數字僅適用於試用（Hobby 級）。
- 本機 46／46（d/d.test.js 等）**未**用來取代任何供應商結果。

## 10. 重跑方式

在 [vc/](./vc/) 安裝依賴（`@vercel/sandbox`、`puppeteer-core`、`tar`），以 `vercel link` 連結**專用測試專案**後 `vercel env pull .env.local`，再 `node --env-file=.env.local vc1.mjs`（其餘腳本同理；`vc3c2.mjs` 需 P1／P2 兩個專案分階段執行）。**切勿連結承載其他產品的專案或 Team。**腳本中的 Chrome 路徑、區域 `hnd1` 為本機測試設定。
