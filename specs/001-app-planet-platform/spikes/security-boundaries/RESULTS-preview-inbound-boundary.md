# 私人預覽入站邊界：架構結論與 Spike 結果（2026-10-21）

> **狀態**：研究輸入；**不是** canonical Plan 的已批准設計、**不是**實作批准。下列候選皆為「待教育者決定」。
> **前置已核對**：Git 根目錄 `C:/Users/geste/spec-kit/app-planet`；`.specify/feature.json` → `specs/001-app-planet-platform`（未依分支名推斷）。以磁碟現行檔案為準。
> **教育者已批准的本輪方向**：不建立 Pro／Hobby 測試 Team、不使用承載其他產品的 Hobby Team；保留右側互動預覽、平台 AI、作品 A／B、B 級 β2、單一 Readiness Gate；A1／B2 的本機成果保留但**尚非定稿批准**。
> **〔2026-10-21 後續更新〕**教育者後續決定（見 [decision-register.md](../../decision-register.md) D-16「後續」）：授權**一個專用、隔離的 Vercel Pro 測試 Team**（僅合成資料；不得用承載其他產品的 Hobby Team），並以 X／M 為待驗證首選。上列「不建立 … 測試 Team」為當時狀態，**已被此後續決定取代**（原文保留作歷史）。VC-1～VC-3 已於該 Team 執行，結果見 [RESULTS-vc1-vc3.md](./RESULTS-vc1-vc3.md)；§5 表「現況」欄已更新，其餘章節為執行前的歷史敘述。

## 1. 官方查證：四件不同的事（查證日 2026-10-21）

| 面向 | 官方文件所述 | 不能據此推論 |
| --- | --- | --- |
| ① 管理 API 認證 | SDK／REST 以 Vercel OIDC token 或 access token（含 team／project ID）認證；REST `GET /v2/sandboxes/{name}` 為 bearer token。〔[authentication](https://vercel.com/docs/sandbox/concepts/authentication)、[REST](https://vercel.com/docs/rest-api/sandboxes/get-a-named-sandbox)〕 | 這只保護「建立／管理／讀寫沙箱」的操作，**不是**瀏覽器訪客連到暴露埠的授權 |
| ② 暴露埠的訪客存取 | `ports` 至多 15；`sandbox.domain()`「resolves a publicly accessible URL」；Concepts：「Exposed ports are accessible via a public URL, so be mindful of what services you run」；REST 的 route 描述為「public route」、`url`＝「A public URL to access the corresponding port」；另有 `system:true`（保留供內部使用）的 route；changelog 記載 8080 已開放為 ingress、原控制埠移至 23456。〔[sdk-reference](https://vercel.com/docs/sandbox/sdk-reference)、[concepts](https://vercel.com/docs/sandbox/concepts)、[changelog](https://vercel.com/changelog/port-8080-is-now-available-in-vercel-sandboxes)〕 | **全部文件均未見對暴露埠的入站驗證／存取控制選項**（不等於不存在；未實測）。`system` route 是否可由外部到達：**未查證** |
| ③ 出站防火牆 | 「Network firewall allows users to restrict **egress** traffic」；模式 `allow-all`／`deny-all`／user-defined（domain、CIDR）。〔[firewall](https://vercel.com/docs/sandbox/concepts/firewall)〕 | 只管沙箱往外；**與訪客如何進來無關**，不能當入站保護 |
| ④ 沙箱內權限 | 「full root access」；`runCommand` 有 `sudo`；Isolation 章節說明系統特權行程以 `sudo` 執行、受 microVM 邊界隔離；`SandboxUser` 可建 Linux 使用者；`sandbox.update({ports})` 會取代整份埠清單（此為 API 操作，需①的憑證）。〔[concepts](https://vercel.com/docs/sandbox/concepts)、[sdk-reference](https://vercel.com/docs/sandbox/sdk-reference)〕 | microVM 邊界隔離的是「沙箱對外」，**不是**沙箱內的學生對沙箱內守門程序；Linux 使用者隔離也不能當作 sudo 學生的邊界 |

另：文件稱 WebSocket 連到沙箱公開網址「可能被關閉」，建議客戶端自動重連（concepts）。沙箱內檔案可由 SDK 的 `fs`（`node:fs/promises` 相容）讀寫，屬①的管理通道。

## 2. 結論：Vercel Sandbox 在「私人互動預覽」用途上的限制

1. **以「暴露埠＋公開網址」提供預覽，文件層面無法滿足條件**：該 URL 公開，未見入站授權選項；入站授權不能交給②（不存在）、③（只管出站）、④（學生可 root）。
2. **同沙箱守門程序不是邊界**：學生具 root／sudo，可停掉守門程序並在同一公開埠改綁自己的伺服器（本機負對照已重現，§4）。
3. **Vercel Sandbox 仍可用於「無入站」的角色**：建置、測試、Agent 執行（`ports` 不宣告、`networkPolicy` 封鎖出站），由平台以①的管理通道取回檔案。此用法是否真的「無任何公開路由」＝**未驗證**（`system` route、控制埠 23456）。

## 3. 兩個候選（皆保留右側互動預覽）

| 項目 | **X：零暴露埠＋產物式預覽（推薦）** | **Y：供應商強制的入站權杖＋閘道代理** |
| --- | --- | --- |
| 做法 | 沙箱只建置，`ports: []`；Worker 以管理通道讀出建置產物 → 平台入庫驗證（路徑／型別／大小／保留前綴）→ works-edge 預覽模式只服務**平台保存的位元組** | 換用具「公開網址需帶供應商權杖」的沙箱（官方文件查到：E2B `allowPublicTraffic:false`＋`e2b-traffic-access-token` 標頭；已是 research R-05 的備選）。works-edge 代理並加權杖 |
| 入站授權所在 | **平台控制的閘道**。沒有任何學生行程接收訪客流量，也（待 V1 確認）沒有公開路由 | **供應商邊緣**驗證權杖（文件：「before any request reaches the services inside」）；權杖是否在 VM 內可讀＝**未驗證** |
| HTML／子資源 | 閘道直接回；標頭、CSP、內容類型只由閘道決定 | 閘道代理到供應商網址，附權杖與平台標頭 |
| 同源資料 API | 同現行 §3.3（`/_work/data/v1/*`，保留前綴優先；產物含 `_work/` 即整份拒絕） | 同現行 §3.3 |
| WebSocket／更新 | **不提供 WS**；替代：儲存或 Agent 一步完成 →重建→新版本綁定→平台頁由平台 API 取得版本號並重載 iframe（不需 `postMessage`）。重建延遲＝**未量測** | 可代理 HMR WS；但 works-edge 在 Vercel 上代理 WS 仍**未驗證**，且撤銷後須主動關閉既有 WS（既有缺口） |
| 重新整理 | 同主機名，無長連線，無狀態 | 同 A 方案，須重驗 |
| 撤銷 | 資料 API 立即；內容 ≤ 授權快取 TTL；**無殘留長連線**；撤銷＝解除產物綁定（不依賴沙箱 `destroy`） | TTL＋WS 週期重驗＋sandbox destroy；權杖外洩後除 destroy 外是否可輪替＝**未查證** |
| 預覽間隔離 | 每會話獨立 origin＋各自產物綁定與資料集（本機已驗） | 每沙箱獨立權杖與主機名；仍須每會話獨立 origin |
| B 級 β2 | **X 只涵蓋 A 與 β1**（瀏覽器端＋Work Data API）。β2 需要「回應請求的學生程式」。**〔2026-10-21 補〕**β2 路徑研究已獨立成篇：[RESULTS-beta2-call-path.md](./RESULTS-beta2-call-path.md)——推薦 **M（管理通道逐次呼叫：平台側 invoker＋每請求新建、`ports: []`、`deny-all` 的沙箱）**，條件成立（設計層；延遲／費用／控制面額度〔未量測〕）；M 被推翻時**唯一**替代為 W（Cloudflare Workers for Platforms，新增供應商，待教育者決定）。本列「Y 天然涵蓋 β2」的舊敘述不再作為 β2 備援（E2B 的 β2 適用性未評估） | **天然涵蓋**（同一權杖機制可保護 fn 呼叫），但等於為 β2 更換供應商；**β2 的替代方向以 RESULTS-beta2-call-path.md §5 為準** |
| 代價／風險 | 失去 dev server 熱更新；產物型別受限；入庫驗證器成為新的安全元件；Vercel「零路由」假設待驗 | **更換已批准供應商**（憲章：須交教育者決定）；價格、區域、兒童資料條款、權杖是否在 VM 內可見＝**未查證** |

**推薦 X**。理由見 §6；Y 為 X 的 V1 實測失敗，或教育者要求 β2 必須有即時學生伺服器時的替代方向（其供應商評估仍須另行進行，本輪未做）。

## 4. 本機最小驗證（合成資料；已執行）

程式：[c/artifact-gateway.js](./c/artifact-gateway.js)、[c/c.test.js](./c/c.test.js)；沿用既有 `PreviewPlatform`、`Clock`。指令：`node --test c/c.test.js a/a.test.js b/b.test.js b/b2-renewal.test.js`（Node 層；**非**供應商環境、**非**瀏覽器）。

| 結果 | 內容 |
| --- | --- |
| **35／35 通過**（既有 24＋新增 11） | |
| 負對照 ✔ | 同 VM 守門程序＋具 root 的學生程式：守門程序存在時外部 `401`；學生停掉它並改綁同埠後，**無權杖請求 `200`** → 入站授權不可放在學生可控的 VM 內 |
| X 功能 ✔ | HTML、子資源、重新整理、同源資料 API 可用（host／cookie 兩種授權模式皆測）；A1 模式下洩漏主機名＋無 cookie → `403`（A0 為 `200`，既有已知性質） |
| 惡意產物 ✔ | `..`、絕對路徑、符號連結、`_work/` 前綴、`_headers`／`.sh` 等型別、超大檔、大小寫重複、缺 `index.html`、檔案數上限：**整份拒絕** |
| 閘道主權 ✔ | 產物內 `<meta>` CSP 不影響回應標頭；內容類型由副檔名決定；不能遮蔽 `/_work/*` |
| 無長連線 ✔ | WebSocket 升級一律被拒；撤銷：資料 API 立即、內容 ≤ TTL（TTL＝0 時立即）、到期／未兌換／未知主機名皆 `403` |
| 隔離／更新 ✔ | A 的 cookie 與資料不能用於 B；重建後綁定新版本，重新整理即得新內容 |
| 結構 ✔ | 閘道不持有上游、原始碼無出站連線呼叫 |

**這些結果不證明**：Vercel 的埠暴露／路由行為、供應商 TLS 與萬用字元網域、真實瀏覽器 iframe 行為、重建延遲、Agent／建置在 `ports: []` 下可完整取回產物。

## 5. 能推翻 X 的判準；必要的供應商驗證清單（**更正**：V1′ 不是唯一必要的供應商實測）

> **更正（2026-10-21）**：本節與 §7 先前稱「V1′ 是唯一必要的供應商實測」，**此表述錯誤**。V1′ 只回答「Vercel 沙箱在 `ports: []` 下是否真的沒有可達的公開路由」（判準 a、b、d 前半），**不回答**重建延遲與撤銷（d 後半、e）、β2 呼叫路徑、A1 瀏覽器與正式 TLS、B2 grant 更新。下表分列五類必要驗證，並區分「Plan 定稿前」與「Readiness Gate 前」各需什麼證據。**全部〔未執行〕**；VC-1～VC-3 需隔離測試 Team／專案，**教育者尚未批准建立**。

**判準（任一成立即推翻對應部分）**
- (a) Vercel 沙箱在 `ports: []` 下，外部無憑證可到達**任何**路由（含 `system` route、23456）。→ X 在 Vercel 上推翻，轉 Y 評估。
- (b) 沙箱內（root）可取得管理憑證（環境變數、檔案、metadata）或自行建立路由。→ 同上。
- (c) 任一惡意產物被入庫後改變閘道標頭、遮蔽 `/_work/*`、或路徑逃逸。（本機：未發生）
- (d) 取回產物在 `deny-all`／僅 registry 允許清單下不可行，或重建→可見延遲超出教育者可接受值（**閾值未核定**）。
- (e) 內容撤銷延遲 > 授權快取 TTL（既有 V-53(m)）。
- (f) 任一 A／B 範例作品必須依賴即時伺服器才能互動（若屬 β2 → 改走 [RESULTS-beta2-call-path.md](./RESULTS-beta2-call-path.md)）。

**分階段驗證清單（本機結果不能替代；「通過標準」沿用既有判準，數值未核定者只回報、不判通過）**

| 編號 | 驗證項 | 通過標準／判準 | **Plan 定稿前**需取得的證據（決定架構方向用） | **Readiness Gate 前**需取得的證據（驗收用） | 現況 |
| --- | --- | --- | --- | --- | --- |
| VC-1 | **零暴露埠（原 V1′）** | 判準 (a)(b)：`ports: []`＋`deny-all` 下，REST `routes` 列表與自沙箱外無憑證對 80／443／3000／5173／8080／23456 及 `system` route 的 HTTP／WebSocket 探測**全部失敗**；VM 內（root）無管理憑證且不能建立路由 | 一次完整通過的紀錄（路由列表、探測輸出、VM 內檢查輸出；合成程式）。**任一探測成功＝X 在 Vercel 上推翻，須回報教育者** | 以**正式建置映像與正式 `networkPolicy`** 在正式專案設定上重跑；納入部署管線回歸（映像、SDK、設定變更後重跑），結果歸檔 | 〔2026-10-21 已執行；結果見 [RESULTS-vc1-vc3.md](./RESULTS-vc1-vc3.md) §2：未觸發 (a)(b)；無法窮舉未知 `system` route；僅 Plan 階段證據，Gate 前須重跑〕 |
| VC-2 | **產物取回與重建延遲** | 判準 (c)(d)(e)：`deny-all`（其後僅 registry）下以管理通道取回產物成功；入庫驗證器拒絕惡意產物；儲存→建置→取回→入庫→綁定→重載的端到端延遲在教育者核定值內；撤銷延遲 ≤ 授權快取 TTL | 合成產物取回成功（含大小／檔數邊界、符號連結）；端到端延遲 N≥10 的 p50／p95，**供教育者核定可接受值**（目前無閾值） | N≥30，目標區域（亞太）、課堂尖峰 20 人並行下的 p50／p95／max；對照教育者核定閾值判定；撤銷延遲 p50／p95／max（V-53(m)） | 本機入庫驗證 ✔（c/c.test.js）；〔2026-10-21 已執行供應商段；結果見 [RESULTS-vc1-vc3.md](./RESULTS-vc1-vc3.md) §3：暖沙箱 N=30 儲存→iframe 可見 p50 3.5 s／p95 4.3 s；閘道與瀏覽器為本機；20 並行〔未量測〕〕 |
| VC-3 | **β2 呼叫路徑（M；或 M 被推翻後的 W）** | 見 [RESULTS-beta2-call-path.md](./RESULTS-beta2-call-path.md) §4（M-a～M-h）與 S-13：零路由、VM 內無管理憑證、出站 `deny-all`、新建／恢復／暖路徑延遲、帳單對帳、控制面額度、`kill`／`stop` 耗時、撤銷 | **可行性探針**：單一合成處理程式，量測新建／恢復／暖三路徑延遲（每格 N≥30 的 p50／p95）、≥1,000 次請求後的帳單對帳、OIDC 專案範圍是否隔離沙箱、`kill`／`stop` 耗時；用來**選定 M 或 W** 並提供 PP-19 起始值依據 | S-13 全項（隔離、出站、時間、記憶體、儲存、請求數、費用、下架延遲）；公開流量壓測（控制面 `429` 不影響學生 Agent／建置）；PP-19 核定後的配額 100% 強制；撤銷 ≤15 s（p50／p95／max，N≥30） | 本機呼叫契約 ✔（d/d.test.js，46／46）；〔2026-10-21 已執行供應商段；結果見 [RESULTS-vc1-vc3.md](./RESULTS-vc1-vc3.md) §4：新建 p50 3.5 s／p95 7.0 s、OIDC 專案隔離成立、`delete` 可終止在途；**限額為試用（Hobby）級，Pro 值〔未量測〕**；本機 46／46 不替代供應商結果〕 |
| VC-4 | **A1 目標瀏覽器與正式 TLS**（僅當教育者選 A1） | 既有 brief §2.3 判準 (a)～(f)；無 cookie 者以洩漏主機名不得取得任何 `200` | **決策與清單**：教育者決定 A0／A1，並核定目標瀏覽器×裝置清單（CHK020）。最低證據：在**公開信任 TLS**（可用兩個 `*.vercel.app` 專案作頂層站與預覽站）上，Safari ≥26.2、Firefox ≥141 實機與一組學校管理政策各至少一次 A1 iframe 完整流程的成功／失敗紀錄 | 清單內每格 N≥30；正式萬用字元網域上的 `__Host-Http-` 與 `{preview_id}` 隨機主機名；管理政策／擴充套件封鎖；ChromeOS／iPadOS；判準 (a)～(f) 逐項判定 | 本機私有 TLS：Chrome／Edge 155 ✔（[RESULTS-vercel-validation.md](./RESULTS-vercel-validation.md) §4）；其餘〔未執行〕 |
| VC-5 | **B2 grant 更新**（僅當教育者選 B2；含 β2 的 `invoke` grant） | brief §3.5 判準 (a)～(e)；edge 不需寫入憑證；更新延遲不造成作品資料中斷超過核定值 | **機制選定**：在候選推送機制（Edge Config／KV／部署環境變數）中選定一種，最小實測證明 edge 不需寫入憑證，並量測一次更新→生效延遲（N≥10） | 在實際部署檢視 edge 環境**無任何**簽署金鑰（判準 a）；`kid` 輪替演練；推送失敗 fail-closed 的實測時長並由教育者核定上限；epoch 遞增後舊 grant 失效 ≤1 s（N≥30） | 本機邏輯 ✔（b/*.test.js）；供應商推送機制〔未執行〕 |

**與既有編號的關係**：VC-1 取代舊稱「V1′」；VC-3 併入 quickstart S-13；VC-4 併入 V-53(n)(o)；VC-5 對應 CHK014 之外的 B2 阻擋項。canonical 文件**尚未**依此修改（§8）。

## 6. 對照教育者的兩個必須解決點

- **學生可控埠有公開網址**：X 不宣告任何埠；訪客只連平台閘道。Y 以供應商邊緣權杖取代「無路由」。兩者都不把②當作保護。
- **同沙箱守門程序不可靠**：X 與 Y 皆無沙箱內守門程序；入站授權分別位於平台閘道與供應商邊緣（Y 的「邊緣在 VM 外執行」為**未驗證**）。

## 7. 阻擋 Plan 定稿的證據（全部〔未執行〕；細項見 §5 表）

1. **VC-1**（X 的「零路由」假設）——現無測試 Team，**目前無法執行**；未通過前不得宣稱預覽入站已受保護。
2. **VC-2**：取回與重建延遲，以及「儲存→重建→重載」UX 是否可接受（無即時熱更新）。
3. **VC-3**：β2 呼叫路徑可行性探針（M 或 W）；教育者尚須選定路徑。**不再寫成「V1′ 之外無其他必要供應商實測」**。
4. **VC-4**（若選 A1）：目標瀏覽器清單的核定與公開 TLS 上的最低證據。
5. **VC-5**（若選 B2）：grant 推送機制選定與最小實測；works-edge 入侵偵測（CHK014）維持原阻擋狀態。

## 8. 將來 canonical 需修改的精確位置（本輪**未**修改任何 canonical 檔案；僅在教育者批准後）

| 檔案 | 位置（行號為 2026-10-21 現況） |
| --- | --- |
| [plan.md](../../plan.md) | L96 架構圖「Worker ──▶ 沙箱」旁補「產物入庫」；L99 works-edge「預覽模式」敘述（不再反向代理沙箱）；L106「作品（預覽沙箱…）」句；L133「預覽在獨立來源」；L140 (a)(e)「反向代理至沙箱預覽埠／成立前提」；L142「預覽反向代理補強」(a)–(e)；L195 P4 條件的 S-05；L260 K-03；L341 之後新增一輪紀錄（核准後） |
| [contracts/publishing-and-public-runtime.md](../../contracts/publishing-and-public-runtime.md) | L35 §3 標題括號；L52「提供限制的層」；L54「權杖與目標」（「沙箱目標解析」「沙箱目標引用」）；L55–L56「預覽來源與預覽會話」「成立前提」；L91「轉送責任」(2)；L106「預覽會話的單位」（綁沙箱→綁產物版本）；L107「首次兌換」（回傳值）；L108「子資源與重新整理」（刪 WS、改服務產物）；L110「過期與延長」（沙箱 TTL 不再決定預覽到期）；L111「撤銷」（`destroy` 句）；L112「安全性質與殘餘風險」；L113「前提與唯一阻擋點」；§3.5（L115 起）預覽金鑰描述 |
| [contracts/projects-agent-sandbox.md](../../contracts/projects-agent-sandbox.md) | L25 E-3；L56 `startPreview(sandbox_id, port)` → 改為「建置並取回預覽產物」（無埠、無位址） |
| [research.md](../../research.md) | L413 R-13「私人預覽」列；R-05（L454 一帶）若教育者選 Y |
| [quickstart.md](../../quickstart.md) | L26 S-05（預覽入口方向）改為 VC-1（原稱 V1′）；L34 S-13（β2 呼叫路徑，併入 VC-3 與 [RESULTS-beta2-call-path.md](./RESULTS-beta2-call-path.md) §4）；L175 V-53 (c)(e)(j)(m)(n) 及新增產物入庫案例 |
| [data-model.md](../../data-model.md) | L250 `work_data_stores` 列：預覽暫存命名空間旁新增預覽產物綁定（版本、雜湊）；A1 時另需 cookie 雜湊欄位 |
| [decision-register.md](../../decision-register.md) | D-08（L217）、PP-01（L443，預覽另設 TTL 時）；新增預覽授權方案與 β2 呼叫路徑決策列 |
| [checklists/plan-finalization.md](../../checklists/plan-finalization.md) | CHK001、CHK008、CHK014、CHK016（L15、L22、L31、L36） |

## 9. 未執行聲明

未建立任何付費資源或測試 Team；未登入任何供應商、未使用正式密鑰或兒童資料；未執行 /speckit-tasks、/speckit-analyze、/speckit-implement；未 commit／push；未動上層 AnywhereTalk repository。新增檔案僅限 `spikes/security-boundaries/c/` 與本檔。E2B 僅查證其 [public URL](https://docs.e2b.dev/network/public-url.md) 與 [restrict public access](https://docs.e2b.dev/network/restrict-public-access.md) 兩頁。
**〔2026-10-21 後續輪補記〕**新增 `d/`（β2 呼叫契約本機 Spike）、`results/fn-local-latency.json` 與 [RESULTS-beta2-call-path.md](./RESULTS-beta2-call-path.md)；修正 §3 β2 列與 §5／§7 的「V1′ 是唯一必要」表述。仍未建立任何資源；§5 全部驗證項維持〔未執行〕。
