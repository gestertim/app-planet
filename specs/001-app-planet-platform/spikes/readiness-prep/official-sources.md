# Readiness 官方查證摘記

**查證日期**：2026-10-22（+08:00）。方式為 `web_fetch` 唯讀取得公開官方頁面；未登入、未查帳戶、未送出專案內容或資料、未執行網頁中的安裝／註冊／購買指示。以下為限縮摘要，不是完整條款副本、法律意見或報價。頁面更新日期與本輪查證日期不同；動態價格及條款於資源申請前仍須再核對。

## 官方來源與查證結果

| ID | 官方來源／頁面日期（若有） | 本輪實際讀到的內容 | 未能據此證明的事項 |
| --- | --- | --- | --- |
| O01 | [OpenAI Under-18 guidance](https://developers.openai.com/api/docs/guides/safety-checks/under-18-api-guidance) | 處理未滿 13 歲或適用數位同意年齡兒童的個資前，要求先實施 API ZDR；要求適齡揭露／過濾、監測通報與高風險升級；最佳實務建議使用具最新安全保護的旗艦模型 | 學校同意是否充分、App Planet 是否符合、任何帳戶已開 ZDR、便宜候選模型已具兒童適用性；均未證實 |
| O02 | [OpenAI Data controls](https://developers.openai.com/api/docs/guides/your-data)（讀取開頭及後段） | 濫用監控預設可保留 30 天，另有法定等例外；ZDR／Modified Abuse Monitoring 須事先批准。組織及 Project 控制可能不同；`store:false` 不會自行啟用 ZDR。Responses／Chat Completions 可用但有能力／模型限制；`/v1/files`、Conversations、Agents／Assistants 等表列非 ZDR 適用；Moderations 表列無保留。圖像相容性須依列名模型；疑似 CSAM 圖像有保留人工審查例外。背景模式、hosted containers、prompt cache、第三方工具另有狀態／保留條件 | ZDR 是所有功能零保留的保證、MAM 可自動代替兒童 ZDR、附件／搜尋／圖像／Agent 已整體合規；均不能推論。Web Search 段談 HIPAA／BAA，不能當兒童條款通過證明 |
| O03 | [OpenAI Pricing](https://developers.openai.com/api/docs/pricing)（Standard 開頭） | 每百萬 tokens：`gpt-5.4-mini` 輸入／快取／輸出 $0.75／$0.075／$4.50；`gpt-6.1-sol` 短 context $2／$0.10／$10，長 context $4／$0.20／$15。新模型另有 cache write 計價欄 | 本研究未含長 context、cache write、圖片、搜尋及分類器等額外費用；不是完整 AI 月費或已選模型 |
| O04 | [GPT-5.3-Codex](https://developers.openai.com/api/docs/models/gpt-5.3-codex) | 輸入／快取／輸出每百萬 $1.75／$0.175／$14；支援 Responses，不支援 Chat Completions | 呼叫品質、輪次、快取命中率、兒童安全及帳戶資格；未實測 |
| O05 | [Vercel Sandbox pricing](https://vercel.com/docs/sandbox/pricing)；頁面 2026-09-10 | `iad1` Active CPU $0.128／vCPU-hour、佈建記憶體 $0.0212／GB-hour、建立 $0.60／百萬次；記憶體最少 1 分鐘計費。區域價不同。Pro 用量抵 Team 每月 $20 額度後按量計費；快照 $0.08／GB-month，其他儲存／流量另有條件；Pro session 上限表列 24 小時 | `hnd1`／`sin1` 同價、試用 Team 就有付費 Pro 限額、控制面／20 人已達標、支出提醒就是硬上限；均未證實。互動區域選單本輪未取得亞太價 |
| O06 | [Vercel Pro](https://vercel.com/docs/plans/pro-plan)（含 pricing 段）；頁面 2026-09-15 | 每 Team $20／月含 1 部署席位及 $20 用量額度；額外部署席位 $20／月。額度是 Team 共用，不能每專案重複抵扣；頁面價格不含適用稅 | 未選定／建立任何 Team，不使用試用或來源不明登入。兩 Team $40 只是設計中固定費量級，非付款授權 |
| O07 | [Supabase Pricing](https://supabase.com/pricing) | Pro 自 $25／組織月費，含 $10 compute credit；Micro $10、Small $15／專案月。各環境專案另計 compute；Pro 表列 8 GB DB／專案、100 GB Storage、超額另計；API requests unlimited 不等於儲存／流量／效能無限 | 不能把三環境當一專案 $25；不能把供應商內含配額直接當 PP-26 作品配額。帳戶／區域／DPA 尚未核定 |
| O08 | [Supabase Auth rate limits](https://supabase.com/docs/guides/auth/rate-limits)（含 forwarding 段） | Token endpoint 預設每 IP 150 次／5 分鐘、burst capacity 30，採 token bucket；不是全部登入端點通用的固定窗。`Sb-Forwarded-For` 要新式 secret key 並另啟用，新式 publishable 與舊 anon／service_role 不支援 | 30 位 NAT 學生在 App Planet 的登入／refresh 競爭已通過、真實專案已啟用 forwarding、PP-03 應採供應商預設；均未證實 |
| O09 | [Supabase Sessions](https://supabase.com/docs/guides/auth/sessions) | session 限期／單 session 屬 Pro 以上；設定在下次 refresh 檢查，實際期間可能加上 JWT 有效期；`session_id` 可對應 `auth.sessions`；官方不建議 JWT 低於 5 分鐘 | 不能以 ban／改密碼／session 設定推論舊 JWT 已於所有 BFF／RLS／Storage 路徑立即失效；S-03 仍需實測 |
| O10 | [Fly.io Resource Pricing](https://docs.fly.io/about/pricing)（由舊官方 URL 轉址） | `iad`／`ewr` shared-cpu-2x＋2 GB $13.39／30 天；依區域、秒數與月份天數變動。亞太出網 $0.04／GB，跨區私網 $0.015／GB；其他項另計 | 亞太 2 GB 同規格確價未取得；不把舊約 $17 粗估當官方報價或上界 |
| O11 | [E2B Pricing](https://e2b.dev/pricing) | Pro $150／月另加使用費；$0.000014／vCPU-second、$0.0000045／GiB-second，按佈建秒數計費；Pro 表列 100 並行。Hobby 額度與並行只作來源背景，不用於本產品核定 | 備援供應商未選定；可用性、兒童資料條款、區域與隔離未通過；不得因表價較低自動換供應商 |
| O12 | [Supabase DPA](https://supabase.com/legal/customer-resources/data-processing-addendum)；Version 1，2026-08-01 | 本輪確認公開 DPA 存在，讀取定義與適用 Agreement | **僅定位與摘讀，不是完整法務審查**；未取得本專案契約、兒童處理適用性、區域及分處理者結論 |
| O13 | [Vercel DPA](https://vercel.com/legal/dpa)；更新 2026-03-17、生效 2026-03-31 | Introduction 說明適用 Enterprise／Pro customer 的 processor 處理 | 不等於試用／任一 Team 已具本專案契約資格；兒童資料、Sandbox 日誌、資料落地仍待逐項審閱 |
| O14 | [Fly.io Privacy Statement](https://fly.io/legal/privacy-policy/)；生效 2026-09-24 | 公開說明網站／帳戶資料與 IP 等處理 | 本輪僅摘讀開頭；沒有證實 hosted workload 的兒童資料 DPA、區域、日誌保存或適用年齡 |
| O15 | [Vercel custom／wildcard domain](https://vercel.com/docs/domains/working-with-domains/add-a-domain)（含 wildcard 段）；頁面 2026-09-16 | wildcard TLS 可用 Vercel nameservers；不能換 nameservers 時官方另列 `_acme-challenge` 委派，但有證書續期／其他主機商干擾風險 | 比舊「必須 nameservers」描述多一官方選項；**本輪不修改已選網域／DNS 方案或架構**，只交資源申請時核定。沒有 DNS／TLS 已部署證據 |
| O16 | [Resend Pricing](https://resend.com/pricing) | Transactional Pro $20／月含 50,000 封、超額 $0.90／千封；Free 3,000／月且 100／日 | 僅 S-14 比較候選，不建帳、不採 Free 預設；資料落地／兒童資料條款／DPA／退信與投遞實測尚缺 |

## 失敗或不足的查證（明列，不補猜）

| 來源／方式 | 實際結果 | 後續最小工作 |
| --- | --- | --- |
| `web_fetch https://openai.com/api/pricing/` | HTTP 403；改讀 O03／O04 取得本輪實際採用價格 | 圖像／搜尋／完整模型費項本輪未重核；計價與模型選型前逐項補核，不直接搬舊價格 |
| `web_fetch https://openai.com/policies/services-agreement/`；另嘗試 raw | 轉文字只回標題；raw 開頭為 HTML，未取得可審閱條文本文 | 由法務取得適用版本全文及本專案協議；**本輪未重新證實**舊研究的條號／監護人同意引文，不將舊摘錄升格為當前法律結論 |
| `web_fetch https://aws.amazon.com/ses/pricing/` | 轉文字只讀到計費註腳，無可靠 outbound 主表價 | SES 暫列 S-14 比較對象，**不填單價**；補官方可讀價目／區域／sandbox 限制、DPA 與事件回報說明再比較 |
| O05 亞太選單、O10 亞太 2 GB | 靜態內容未取得所需精確數值 | 不登入既有帳戶；資源專項申請先附官方區域價／書面報價及全費項上界，未具備不得購買或實測 |

## 對候選政策的直接影響

- O05／O07 的供應商配額不是 PP-20／21／25／26 的產品政策；O08／O09 也不是 PP-03／04／22 的核定值。
- O01／O02 要求逐能力／模型及組織、Project 核對；只看 UI 一張「ZDR」截圖或 `store:false` 不足以完成學生 AI 啟用審閱。所需證據應遮蔽帳戶識別與設定秘密。
- [本機成本研究](./results.json) 僅採 O03～O07／O11 中明列單位，未計所有費項。定價不是教育者可接受的延遲、成本或兒童安全門檻。
- 本輪查證成本：未建立／變更資源、未呼叫供應商產品 API，新增供應商計費用量為 0；不推論既有帳戶的帳單或資源狀態。
