# 安全架構驗證結果：沙箱直連、預覽代理、A1／B2 成立條件（2026-10-21）

> **狀態**：驗證結果輸入；**不是** canonical Plan 的已批准設計、**不是**實作批准。A1（預覽主機名＋分區 cookie）與 B2（平台簽發每作品 grant）仍是「待驗證的候選方向」。
> 前置已核對：Git 根目錄 `C:/Users/geste/spec-kit/app-planet`；`.specify/feature.json` → `specs/001-app-planet-platform`；分支 `main`（未依分支名推斷功能目錄）。
> 前序文件：[決策摘要](../../security-architecture-decision-brief.md)、[本機 Spike 結果](./RESULTS.md)。

## 0. 結論總表

| # | 項目 | 狀態 | 一句話 |
| --- | --- | --- | --- |
| 1 | 沙箱直連（含沙箱內守門程序） | **查證完成；實測〔未執行〕** | 官方文件仍只寫「publicly accessible URL」、未見入站存取控制；實測需隔離 Vercel 測試環境，目前沒有 |
| 2 | works-edge 代理 HTML／WebSocket；撤銷與到期延遲 | **〔未執行〕** | 同上；延遲欄位全為「未量測」 |
| 3a | A1 分區 cookie（TLS） | **本機私有 TLS：通過；正式 TLS：〔未執行〕** | Chrome／Edge 155 通過；Safari、Firefox、學校管理政策、公開信任 TLS 未測 |
| 3b | B2 grant 更新／撤銷／到期／逐請求檢查 | **本機邏輯：通過；供應商推送機制與延遲：〔未執行〕** | 24／24 Node 測試通過 |

**未推翻任何架構前提，也未證明任何前提成立**：S-05（沙箱位址不可繞過）與「works-edge 可代理 WebSocket」仍是唯一阻擋點，狀態＝未驗證。

## 1. 隔離測試環境盤點（唯讀；未使用任何憑證）

| 檢查 | 結果 |
| --- | --- |
| 文件記載的環境 | quickstart §0／plan：dev／test／prod 的 Vercel Team、網域、沙箱**皆尚未建立** |
| Repo 內 `.vercel` 連結、專案環境變數名稱（VERCEL／SANDBOX／SUPABASE 等） | 無 |
| 本機工具 | `vercel` CLI 已安裝，且存在 CLI 本機登入資料目錄 |
| 測試網域 | 無已知的測試網域 |
| 判定 | **無已確認為「隔離測試」的環境。** 本機 CLI 的登入身分**未查詢、未使用**（無法確認不是正式或個人帳號；依指示不登入正式環境）。若教育者確認該登入屬於專用測試 Team，再告知即可使用 |

## 2. 項目 1：沙箱直連

**環境**：僅官方文件查證（2026-10-21 取得）；未建立沙箱。

| 查證事實 | 來源 |
| --- | --- |
| `sandbox.domain(port)`「resolves a publicly accessible URL」；僅需在建立時把埠列入 `ports`（至多 15）；全文未見入站驗證／存取控制說明 | https://vercel.com/docs/sandbox/sdk-reference |
| 防火牆（`networkPolicy`）**只管出站**；與預覽直連無關 | https://vercel.com/docs/sandbox/concepts/firewall |
| 沙箱提供「full root access」；`runCommand` 有 `sudo` 選項；SDK 有 `SandboxUser`（可用 Linux 使用者身分執行指令）；`sandbox.update({ ports })` 會**取代**目前暴露埠清單 | concepts、sdk-reference |
| 流量計費：對外暴露埠的請求與回應皆計費 → 被直連會產生費用 | https://vercel.com/docs/sandbox/pricing |

**結果**：**〔未執行〕。** 文件層面：**未見**可擋下直連的供應商機制，不得假設直連會失敗。守門程序可行性是設計假設，**未證明**；因學生程式在同一 VM，是否能移除／繞過取決於它的身分權限（root／sudo／可否 `kill`、改 `iptables`、占用埠），必須實測。

**測試清單（隔離測試環境核准後執行；全部使用合成程式）**

| 步驟 | 通過標準 |
| --- | --- |
| V1-a 建立沙箱（`ports:[3000, 3001]`），學生層 dev server 綁 `127.0.0.1:3000`；守門程序（root 擁有的二進位）綁 `0.0.0.0:3001`，只在帶正確上游權杖時轉送 | 建立成功 |
| V1-b 由**無憑證外部用戶端**（本機 `curl`、Node `https`、`wscat` 式握手；不經 works-edge）對 `domain(3001)` 與 `domain(3000)` 發出：`GET /`、子資源、`/ws` 升級、`/_work/data/v1/k` 的 GET／PUT／DELETE | **所有路徑皆 401／403／連線失敗**；任一 `200`／`101` ＝**阻擋** |
| V1-c 以學生層身分（非 root）嘗試：終止守門程序、改寫其二進位／設定、搶綁 `3001`、改防火牆、以 `sudo` 提權、修改 `/etc` 啟動項 | 全部失敗，或失敗後守門程序仍在；任何一項成功 ＝**阻擋** |
| V1-d 沙箱重啟／恢復（持久化預設開啟）後重做 V1-b | 守門程序先於學生程式啟動，不出現無守門空窗 |
| V1-e 撤銷時 `sandbox.update({ ports: [] })` 或 `stop()` 作為縱深防禦 | 之後直連皆失敗；記錄生效秒數 |

**失敗時被推翻的前提**：publishing §3.1／§3.4 的「沙箱預覽埠不可被繞過」。後果：works-edge 的所有預覽控制（A0／A1 皆然）都可被繞過，**不得宣稱 works-edge 保護預覽**，亦不得由我方自行更換供應商（交教育者決定）。

## 3. 項目 2：預覽代理與撤銷／到期延遲

**環境**：〔未執行〕。需要：測試 Team 內的最小 works-edge（Vercel Function，Fluid Compute＋WebSocket 公開 beta）、一個沙箱（Vite 類 dev server，含 HMR WebSocket）。官方文件僅說明 Functions 可**作為**WebSocket 伺服器、請求升級前會先執行 Middleware／Rewrites／Firewall；**未見**對外部上游代理 WebSocket 的說明，不得視為可行。

| 步驟 | 通過標準 | 實測延遲 |
| --- | --- | --- |
| V2-a 經 works-edge 代理 HTML、子資源、`/ws` 升級（HMR 往返） | 皆成功 | 未量測 |
| V2-b 撤銷（平台標記 `revoked`）後**新請求** | 於 ≤15 秒內全部 403（brief 判準 e） | 未量測 |
| V2-c 撤銷後**既有 WebSocket** | ≤15 秒內被 edge 關閉 | 未量測 |
| V2-d 到期（`expires_at`）後新請求與既有 WebSocket | 同 V2-b、V2-c | 未量測 |
| V2-e 單連線時限（300／800／1,800 秒）與到期時序 | 記錄連線被平台切斷時間；到期前需有重連策略 | 未量測 |
| 量測方式 | 每項 ≥30 次；平台端記錄撤銷時刻（單調時鐘）、用戶端記錄首次 403／close 事件；回報 p50／p95／最大 | — |

**失敗時被推翻的前提**：brief §2.3 判準 (f)——works-edge 無法代理 WebSocket 或撤銷後無法關閉既有 WebSocket → 預覽架構（A0／A1 皆然）須重議，不得退為「只靠 TTL」。

**本機基線（非 works-edge、非供應商）**：Node 層模擬已證明邏輯可行（[a.test.js](./a/a.test.js)；到期後既有 WS 於 recheck 前存活是已知缺口）。這**不能**替代 V2。

## 4. 項目 3a：A1 分區 cookie 的逐請求驗證

**環境（已執行，限本機）**：Node 24.19.0；**本機自簽 TLS**（以 SPKI 釘選讓瀏覽器信任；憑證含 `app.localhost`、`other.localhost`、`*.preview.localhost`），HTTPS＋`wss://`；Chrome **155.0.8059.84**、Edge **155.0.4283.62**（headless，CDP，每格新空白設定檔）。**這不是「正式 TLS」**（非公開信任鏈、無供應商網域、無 PSL）。證據：[results/tls-local-n30.json](./results/tls-local-n30.json)；程式：[a/tls-browser-check.js](./a/tls-browser-check.js)。

設定組：`default`、`incognito`、`block3p_pref`（`cookie_controls_mode=1`，封鎖第三方 cookie）、`phaseout_flag`（`--test-third-party-cookie-phaseout`）。Cookie：`__Host-Http-pv; Path=/; Secure; HttpOnly; SameSite=None; Partitioned`。每格 iframe 載入 HTML＋子資源＋資料 API＋`wss://`＋`localStorage`，並重新整理（只靠 cookie）。

| 瀏覽器／設定 | A1 iframe 完整流程（N=30） | 他站頂層內嵌同一網址（N=5） | 直接頂層導覽（N=5） | 控制組：`None; Secure` 無 Partitioned（N=3） |
| --- | --- | --- | --- | --- |
| Chrome 155／default | **30/30** | 0/5（被拒） | 0/5（被拒） | 3/3（第三方 cookie 允許） |
| Chrome 155／incognito | **30/30** | 0/5 | 0/5 | 3/3 |
| Chrome 155／封鎖第三方（pref） | **30/30** | 0/5 | 0/5 | **0/3（確認封鎖生效）** |
| Chrome 155／phaseout 旗標 | **30/30** | 0/5 | 0/5 | **0/3** |
| Edge 155／default | **30/30** | 0/5 | 0/5 | 3/3 |
| Edge 155／incognito | **30/30** | 0/5 | 0/5 | 3/3 |
| Edge 155／封鎖第三方（pref） | **30/30** | 0/5 | 0/5 | **0/3** |
| Edge 155／phaseout 旗標 | **30/30** | 0/5 | 0/5 | **0/3** |

- 其他控制組：A0（主機名即憑證）iframe 皆 3/3；`SameSite=Lax` 皆 0/3（再次證實不可用）。
- **無 cookie 的外部用戶端、洩漏主機名（經 TLS）**：A0＝HTML `200`、子資源 `200`、資料 GET `404`（已通過授權、無資料）／PUT `200`／DELETE `200`、WebSocket `101`；**A1＝全部 `403`、WebSocket `403`**（判準 c 通過）。
- `__Host-Http-` 前綴：瀏覽器端只接受符合規則的 `__Host-Http-good`；缺 `HttpOnly`、帶 `Domain`、`__Http-` 缺 `HttpOnly`、`__Host-` 帶 `Domain` 的 4 個壞 cookie **全被拒絕**（Chrome／Edge 155 在 4 組設定皆同）。
- 解讀：Chrome／Edge 155 在**封鎖第三方 cookie**時，Partitioned cookie 仍可用（控制組明確失敗而 A1 通過）。判準 (a)（本機兩款）、(c)、(d) 通過。

**〔未執行〕**：公開信任的正式 TLS 與萬用字元網域上的 `__Host-Http-`；Safari／iPadOS（需 ≥26.2）、Firefox（需 ≥141）、ChromeOS、學校實際管理政策（含企業政策封鎖）、瀏覽器擴充套件封鎖；教育者尚未定義目標瀏覽器×裝置清單，故判準 (a)(b) 的「清單內每格 ≥30 次」無法判定。可用的低成本正式 TLS 路徑：兩個 `*.vercel.app` 專案（PSL 上，屬不同站台）作為「平台頂層」與「預覽主機」，不需購買網域；但**隨機萬用字元主機名**（`{preview_id}.{preview_domain}`）仍須測試網域。

## 5. 項目 3b：B2 grant 更新／撤銷／到期／逐請求檢查

**環境（已執行，限本機）**：Node 層、確定性時鐘、合成作品 `w1`／`w2`／`w3`、預覽 `pv`；Ed25519 grant。證據：[b/b.test.js](./b/b.test.js)、[b/b2-renewal.test.js](./b/b2-renewal.test.js)（新增）；全部 24／24 通過（A 14、B 5、B2 新增 5）。

| 條件 | 結果 |
| --- | --- |
| grant 更新 | 平台於到期前重簽；新 grant 即可用；**舊 grant 不因更新而被撤銷，至自身 `exp` 才失效**（撤銷只能靠 epoch／`kid`／下架）；edge 竄改 `exp` 自行延長＝`401` |
| 推送失敗 | 逾 `exp` 全 `401`＝fail-closed，作品資料中斷，直到平台恢復推送（中斷時長＝推送失敗時長；可接受上限待教育者定） |
| 單作品撤銷 | epoch 遞增後，同一時刻舊 grant 即 `401`（判準 c，邏輯層 0 ms）；他作品不受影響；重簽後恢復 |
| 到期 | 逾 `exp` 一律 `401`；預覽 grant 以會話剩餘時間為上限；即使誤簽長效預覽 grant，平台逐請求查會話狀態仍 `410` |
| 平台端逐請求檢查 | grant 有效仍受 live（下架立即 `410`，不經 edge 快取）、配額（`413`）、每作品限流（`429`）、識別字與 key 格式（`400`）、`ops`（`403`）約束 |
| 25 小時後（沿用） | B0 外帶金鑰仍 `200`；B2 外帶 grant 全 `401` |

**〔未執行〕**：grant 推送／讀取機制（Edge Config／KV／環境變數／其他）與實際更新延遲；edge 是否因此需持有寫入憑證（判準 e）；edge 環境中確無任何簽署金鑰（判準 a，需檢視實際部署）；`kid` 輪替在真實部署的演練。

### 必須明寫的限制（不得省略）

1. **B2 不縮小 works-edge 正遭入侵時可觸及的 live 作品集合**：測試「edge 持有所有 live 作品 grant 時，可觸及集合＝全部 live 作品」（含跨校）與 B0 相同；B2 沒有分片。
2. **不能據此宣稱匿名作品資料已免於跨作品濫用**：公開作品的資料 API 本來就是匿名可讀寫；入侵 edge 者在 grant 有效期間，可對所有 live 作品讀寫刪。B2 僅縮小**能力**（無鑄造／延長／擴權）、**時間**（grant 逾時）、**撤銷粒度**（單作品 epoch）、**新作品與下架作品**。
3. A1 的 cookie 綁瀏覽器分區，**不是使用者身分**；無法阻擋持有該瀏覽器分區的人。

## 6. 隔離測試環境：設定、成本與測試清單（〔未建立；以下為待核准的計畫〕）

| 項目 | 內容 |
| --- | --- |
| 資源 | ① 專用測試 Vercel Team（與未來正式 Team 分開）；② 1 個沙箱供應商專案；③ works-edge 最小專案（Fluid Compute）；④（僅 V3 萬用字元主機名）1 個測試網域，使用 Vercel Nameservers |
| 成本上界（官方價目；2026-09-10 頁面） | Hobby：沙箱在額度內**不收費**（5 小時 Active CPU、420 GB-小時記憶體、5,000 次建立、20 GB 傳輸／月；超額暫停建立，不計費）。Pro：Active CPU $0.128／小時、記憶體 $0.0212／GB-小時、建立 $0.60／百萬次；本測試上限約 10 CPU-小時＋20 GB-小時 ≈ **US$2（不含 Pro 方案本身月費）**。網域費用依註冊商，**未查證** |
| 費用保護 | Spend Management 設上限；測試後刪除沙箱與專案；以計費頁面核對 |
| 金鑰 | 僅測試 Team 的受保護環境變數；**不得**提交、不得放入前端或日誌；不使用正式密鑰、不含兒童資料 |
| 執行順序 | V1（直連）→ 通過才做 V2（代理與延遲）→ V3（正式 TLS＋Safari／Firefox）→ B2 推送機制 |
| 資料 | 合成帳號、合成作品、合成 `preview_id`；日誌不記明文 `preview_id` |
| 回報 | 每項填入「環境、步驟、結果、通過／失敗」，並更新本檔「未執行」欄 |

## 7. 唯一的 Plan 定稿建議

> **〔2026-10-21 後續輪更正〕**本節的「先只執行 V1（沙箱直連）」屬舊方案（A0／A1 直連沙箱埠）的驗證順序，且「唯一」一詞不再成立：方案 X 之下的必要供應商驗證為五類（VC-1～VC-5），見 [RESULTS-preview-inbound-boundary.md](./RESULTS-preview-inbound-boundary.md) §5；β2 見 [RESULTS-beta2-call-path.md](./RESULTS-beta2-call-path.md)。以下原文保留作歷史。

**請教育者核准建立一個專用的隔離 Vercel 測試 Team（Hobby 即可，成本上界 $0；V3 萬用字元另需測試網域），先只執行 V1（沙箱直連）；在 V1 通過前，Plan 不得宣稱「works-edge 保護預覽」，A1／B2 僅保留為候選方向、不寫成已批准設計。**

理由：V1 是 A1 與 A0 的共同前提，成本最低、結果最具決定性；V1 失敗即不必投入 V2／V3。

## 8. 變更範圍與未執行聲明

- 新增：`a/tls-browser-check.js`、`b/b2-renewal.test.js`、`results/tls-local-n30.json`、本檔；小改：`a/edge-preview.js`（新增可選 `cookieName`，預設行為不變，24／24 測試通過）。
- **未**修改 canonical Plan、契約、quickstart 等；**未**執行 /speckit-tasks、/speckit-analyze、/speckit-implement；**未** commit／push；**未**動上層 AnywhereTalk repository。
- 本機清理：測試用憑證僅短暫建立於使用者個人憑證庫（`CurrentUser\My`），匯出至暫存目錄後即移除，未加入任何受信任根憑證；暫存目錄、測試瀏覽器程序與暫存設定檔已清除。
