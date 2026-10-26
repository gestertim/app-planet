# 安全邊界 Spike 結果（2026-10-21；本機、合成資料）

> 範圍：僅供教育者定案「預覽存取」與「作品資料授權」兩個安全邊界。**非產品程式、非實作批准**；Plan 仍為草案，Checkpoint 與 Readiness Gate 均未通過。
> 本檔區分「**已執行（本機）**」與「**未驗證**」。本機結果**不代表**供應商網域、TLS、供應商沙箱、各瀏覽器或學校網路條件通過。
> 決策摘要見 [../../security-architecture-decision-brief.md](../../security-architecture-decision-brief.md)。

## 環境

| 項目 | 值 |
| --- | --- |
| OS | Microsoft Windows NT 10.0.26200.0 |
| Node.js | v24.19.0（僅內建模組：`http`、`net`、`crypto`、`node:test`；未安裝任何套件） |
| 真實瀏覽器 | VS Code 內建瀏覽器（Electron 43.7.7／Chromium 150.0.7871.250），經 `*.localhost`、純 HTTP；**非** Safari、Firefox、Edge 正式版、Chromebook |
| 資料 | 全為合成：`w1`…`w5`、`p1`、學校 `S1`／`S2`、合成 cookie／權杖／金鑰；無真實兒童資料、無正式密鑰、無供應商帳號 |

## 重現指令

```powershell
cd specs\001-app-planet-platform\spikes\security-boundaries
node --test a/a.test.js b/b.test.js          # Node 層：A 14 項、B 5 項
node a/browser-server.js                      # 真實瀏覽器 Spike 伺服器（另需瀏覽器開啟，見下）
```

## 一、任務 A（預覽）— Node 層（19 項中的 14 項；全部通過）

模擬：沙箱預覽埠（HTTP＋WebSocket echo）、平台預覽會話（只存 `preview_id` 雜湊）、works-edge 預覽模式（HTML／子資源／資料 API／WebSocket 升級、狀態快取、WebSocket 週期重驗）。`host`＝現行方案 A0；`cookie`＝方案 A1。

| 案例 | 預期 | 實際 |
| --- | --- | --- |
| 授權用戶：HTML、子資源、重新整理、資料 API、WebSocket（兩種模式） | 全部成功；網址不含權杖；`no-store`／`no-referrer`／`frame-ancestors`；沙箱端收不到 cookie／Authorization | 如預期 |
| 未知、未兌換、錯權杖、錯綁、權杖重用、權杖逾時（兩種模式） | 全為 `403` 且回應內容完全相同；日誌不含明文 `preview_id` 與權杖 | 如預期 |
| 預覽間隔離（兩種模式） | B 的主機名讀不到 A 的資料；cookie 模式下 B 的 cookie 不能用於 A 的主機名 | 如預期 |
| **主機名洩漏（無 cookie 的另一用戶端）** | A0：HTML、子資源、資料讀／寫／刪、WebSocket 全成功；A1：全 `403` | A0 `{html:200,js:200,dataGet:200,dataPut:200,dataDel:200,ws:101}`；A1 全 `403/403` — 如預期 |
| 到期 | 新請求、資料 API、新 WebSocket 皆拒絕；**既有 WebSocket 在 recheck 前仍存活**（已知缺口），recheck 後關閉 | 如預期 |
| 撤銷 | 資料 API 立即 `403`；快取內 HTML／子資源在 TTL 內仍 `200`（＝撤銷上界），TTL 後 `403` | `[403, 200, 200(TTL-1ms), 403]` — 如預期 |
| 偽造 Host＋他人 cookie（A1） | `403` | 如預期 |
| S-05 前提（邏輯模擬） | 上游無權杖＝直連 `200`（edge 控制全被繞過）；上游權杖＝直連 `401` | 如預期（**只證明邏輯**；供應商實際行為未驗證） |

修正紀錄（工具問題，非設計結論）：首次執行撤銷案例失敗，因測試時鐘含真實流逝時間，TTL-1ms 邊界被實際耗時越過；改為確定性時鐘後通過。

## 二、任務 A — 本機真實瀏覽器（Chromium 150／Electron；HTTP；`*.localhost`）

做法：`node a/browser-server.js` 後，用內建瀏覽器開 `http://app.localhost:4100/embed?v=E1…E5`（平台頁，含 `sandbox="allow-scripts allow-same-origin allow-forms allow-modals"` iframe，預覽在 `{id}.preview.localhost:<port>`，與平台跨站）；再以 `http://other.localhost:4100/frame?u=…`（另一頂層站台，測試時暫列入 `frame-ancestors`）與直接導覽驗證 cookie 分區。學生頁腳本以相對路徑測子資源、資料 API、WebSocket、`localStorage`，並嘗試對平台 `app.localhost` 發出帶憑證的 `fetch`。

| 變體 | 說明 | iframe 內 HTML／子資源／資料 API／WS／localStorage | 另一頂層站台內嵌同一網址 | 直接頂層導覽 |
| --- | --- | --- | --- | --- |
| E1 | A0 主機名即憑證 | 全成功（`sub:200,data:200,ws:echo,ls:1`） | （未測；無 cookie 可分區） | （未測；Node 層已證實無憑證即可） |
| E2 | A1：`SameSite=None; Secure; Partitioned` | 全成功 | **`403`（preview-unavailable）** | **`403`** |
| E3 | 對照：host-only `SameSite=Lax` | **`403`**（cookie 未隨跨站 iframe 送出） | `403` | `403` |
| E4 | 對照：`SameSite=None; Secure`（無 Partitioned） | 全成功 | 成功 | 成功（此瀏覽器允許第三方 cookie） |
| E5 | A2：同站子網域＋`SameSite=Lax` | 全成功 | — | — |

- 另觀察：`frame-ancestors` 在瀏覽器**確實擋下** `other.localhost` 的內嵌（`Framing … violates … frame-ancestors`）；但它只約束瀏覽器內嵌，對無瀏覽器的用戶端與直接導覽無任何作用（A0 洩漏案例 `200`）。
- 另觀察：學生頁對平台 `app.localhost` 的帶憑證 `fetch` 被 CSP `connect-src 'self'` 擋下（平台端 `/csrf-log` 為 `[]`），故 E5 的「同站帶平台 cookie」風險在此測試中被 CSP 擋住；**這只是單一防線，且未涵蓋導覽類請求**。
- 解讀限制：E2 成功與 E4 成功並存，表示此瀏覽器預設允許第三方 cookie，**E2 通過不證明在「封鎖第三方 cookie」設定下仍可用**；該設定（Chrome 無痕、使用者／管理員政策、Safari ITP、Firefox ETP）**未測**。

## 三、任務 B — 授權模型（Node 層；5 項全部通過）

每格於全新合成世界執行（S1：`w1`、`w2`、已下架 `w4`、預覽 `p1`；S2：`w3`）。欄位：R:w1 R:w2 R:w3 R:w4(下架) W:w1 W:w3 D:w1 D:w3 R:p1。`✔`＝成功；`✖`＝平台拒絕；`·`＝攻擊者不知 `preview_id`。預期值於執行前寫入測試，**全部與實際相同**。

| 方案／情境 | 結果 |
| --- | --- |
| B0 現行｜works-edge 遭入侵 | `✔✔✔✖✔✔✔✔✔` |
| B0｜單一金鑰外洩 | `✔✔✔✖✔✔✔✔·` |
| B0｜單一已簽名請求外洩（重放） | `✔✖✖✖✖✖✖✖·` |
| B1（主金鑰在 edge）｜works-edge 遭入侵 | `✔✔✔✖✔✔✔✔✔` |
| B1｜主金鑰外洩 | `✔✔✔✖✔✔✔✔·` |
| B1｜單一作品衍生金鑰外洩（w1） | `✔✖✖✖✔✖✔✖·` |
| B2 每作品 grant｜works-edge 遭入侵（持有全部 grant） | `✔✔✔✖✔✔✔✔✔`（grant 範圍內） |
| B2｜平台簽署私鑰外洩（平台層事故） | `✔✔✔✖✔✔✔✔·` |
| B2｜單一作品 grant 外洩（w1） | `✔✖✖✖✔✖✔✖·` |
| B3 每校金鑰｜S1 分片 edge 遭入侵 | `✔✔✖✖✔✖✔✖✔` |
| B3｜S1 校金鑰外洩 | `✔✔✖✖✔✖✔✖·` |

其他已執行案例：

- **入侵結束後殘存能力**：25 小時後，B0 外帶的金鑰對舊作品與入侵後新建作品皆 `200`；B2 外帶的 grant 皆 `401`（grant 24 小時到期；入侵後新作品無 grant）。
- **平台端獨立檢查（global／derived／school 三種 HMAC 方案）**：竄改 Body `401`、重放 `401`、過期時間戳 `401`、路徑穿越字元 `400`、配額 `413`、持金鑰仍被每作品限流 `429`、下架立即 `410`（不經 edge 快取）。
- **B2 grant**：唯讀 grant 不可寫 `403`；跨作品 `403`；非平台私鑰簽署 `401`；竄改 claims `401`；未知 kid `401`；逾時 `401`。
- **輪替／撤銷**：B0 重疊期新舊皆可、退役後舊金鑰失效但**所有作品同時受影響**；B1 單一衍生金鑰在 epoch 遞增後失效，但主金鑰持有者嘗試 epoch 1…5 即命中（`401,200,401,401,401`）＝**撤銷被繞過**；B2 epoch 遞增只撤銷單一作品、kid 輪替撤銷全部舊 grant、edge 無法自行簽新 grant；B3 退役 S1 校金鑰不影響 S2。

已知設計差異（非缺陷，已列入決策摘要）：B2 grant 為 bearer，無 Body 雜湊與 nonce（HMAC 方案有）；依賴 edge→平台的 TLS。

## 四、未驗證（本機無法模擬；不得當作通過）

| 項目 | 原因 | 後續實測方法 |
| --- | --- | --- |
| 供應商網域、萬用字元 TLS、`preview_domain` 與 PSL 行為 | 無供應商帳號、無真實網域 | 測試網域＋Vercel 測試 Team，以 `*.preview.<test-domain>` 重做第二節全部案例 |
| Vercel Sandbox 預覽位址是否可被繞過（S-05） | 官方文件稱 `sandbox.domain()` 為「publicly accessible URL」，未見存取控制說明；本機只模擬邏輯 | 於測試沙箱取得位址，自無憑證的外部網路直連；並測上游權杖（沙箱內守門程序）是否可行 |
| works-edge（Vercel）能否代理 WebSocket 至外部上游、連線上限 | 文件只說明 Functions 可**作為** WebSocket 伺服器（beta，最長 300／800／1,800 秒）；未見「對外部上游代理 WebSocket」說明 | 在測試 Team 部署最小 edge，對沙箱 dev server（HMR）實測升級、撤銷後關閉、連線時限 |
| Safari（含 iPadOS）、Firefox、正式版 Edge、ChromeOS | 本機僅 Chromium 150（Electron） | 目標瀏覽器清單（教育者定義）× 第二節矩陣，每格重複 ≥30 次 |
| 封鎖第三方 cookie（使用者／管理員政策、無痕、ITP、ETP）下 Partitioned cookie | 本機瀏覽器預設允許第三方 cookie | 在學校實際 Chromebook／iPad 與管理政策下重做 E2 |
| `__Host-Http-` 前綴＋HttpOnly 的實際行為 | 本機 HTTP、測試 cookie 未用前綴 | 於正式 TLS 網域驗證前綴被接受且 JS 讀不到 |
| 供應商請求日誌是否記錄預覽主機名、能否關閉 | 無法登入供應商 | 於測試 Team 查日誌設定與保留 |
| 預覽 recheck／狀態快取的實際延遲 | 本機用確定性時鐘 | 於測試環境量測撤銷到拒絕的 p50／p95／最大值 |
| B2 grant 的推送／讀取機制（Edge Config／KV／部署環境變數）與更新延遲 | 未選定、未接觸供應商 | 測試 Team 實作最小推送，量測更新延遲與 edge 是否需寫入憑證 |
| 學生程式以導覽（`location`）外送主機名 | 本機未針對此項測試 | 瀏覽器中以 sandbox 屬性組合重做 |
