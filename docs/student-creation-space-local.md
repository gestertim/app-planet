# 學生創作空間：本機 UI 與導覽子集

## 2026-11-09 Reviewer F-01／F-02 最小修復

本輪以首輪已交付的 13 檔實際來源為 before，不以產品基礎 SHA 取代增量基準；沿用既有交接 worktree，保留原工作樹與展示。只修必要實作、直接測試及本節；API、migration、保存政策、任務／依賴、Gate／Q 均不變，不 commit、push、merge 或部署。

- F-01：只有本次確實套用、同帳號／專案／點子階段、尚未保存且 idle 的 dirty 草稿，才提供「放棄帶入」。控制器一旦離開該資格，立即永久清除該次放棄資格；點擊時另核對即時身分、目標、控制器狀態及同一交接憑據，舊入口不能清空其他編輯。拒絕帶入、採用目前內容、保存或放棄後的新編輯都不會重開入口。有效放棄仍只改記憶體，不寫 DB。
- F-02：確認「放棄草稿並離開」時，先同步撤銷交接及本來源自動導覽意圖，再清除首頁草稿、執行原 Link；取消對話框不撤銷。建立與 recovery 共用的成功分支仍確認結果／維持原操作紀錄語意，但在交接確認、`push`／`refresh` 前核對導覽意圖，來源尚未卸載也不會搶走目的地。撤銷不清除尚未確認的操作紀錄，不中止伺服器建立，不換鍵、不重建。

聚焦直接測試使用首輪原六檔；瀏覽器以隔離 Auth／PostgreSQL／Next HTTPS 執行：

```powershell
.\scripts\test-auth-local.ps1 -BrowserOnly -PortRangeStart 59000 -E2EFilter @(
  'real-auth-idea-handoff.spec.ts', 'real-auth-stage-draft.spec.ts', '--grep',
  '無作品首頁|首次建立已|建立回應抵達前|F-02|原生 Auth session setup 後'
)
npm run build
npm run typecheck
git diff --check
```

F-01 真瀏覽器覆蓋另一分頁先保存→原鍵查回拒絕帶入→精確修改／DB 原值、成功帶入後可放棄且不寫 DB、放棄後再編輯不重開入口，以及保存後再編輯→reload 讀回已保存原文。F-02 的建立與 recovery 各有受控障壁：真建立 COMMIT／扣住成功→先取消離頁保留原文→確認離頁／扣住原選目的頁→核對同一來源 DOM 仍連接與原操作紀錄仍在→釋放成功並確認回應抵達、已顯示建立結果且來源仍掛載→釋放目的頁→停在原選專案、零新專案導覽請求、建立僅一次；另以原鍵原本文查回同一建立結果，再進新專案確認沒有草稿復活。去敏障壁紀錄與實跑結果收於本輪交付，不把歷史驗證算成本輪結果。

## 2026-11-08 首頁點子帶入新專案（本輪有界增量）

依教育者本輪明確批准，從 `c4c283d8367d60d3f86e055eb90ba5803fc75e4e` 的獨立 worktree 接線；下方原 UI 批次紀錄保留為歷史。本批只涉及 T040／T041 的首頁交接與 T050／T051／T054、T006／T011／T014／T015 直接相依子項，不結案任何原任務或改變依賴、Q、Gate、人工批准及正式啟用狀態。

- 選引導卡或直接輸入後，須明確按「將點子帶入新專案」，再使用原「建立未分類點子」表單輸入名稱、選擇原 A/B 偏好並按「建立專案」。選卡／選帶入都不建立或保存；「取消帶入」保留首頁原文。未選帶入仍走原建立／refresh／詳情連結。
- `CreateProjectForm` 仍只送原 `{title,tier?}`／UUID 操作識別；沒有草稿 API 欄位。首次 201 或 replay-only recovery 200 經原 strict 回應、名稱及偏好驗證後，才把暫態交接綁到回傳的專案 ID，導覽到該專案的「點子」編輯器。未知結果只查原操作，不換鍵或重建；取消、卸載、失權後的晚到回應不能復活交接。
- 交接只存在當前文件的 JavaScript 記憶體，含可信 server 的帳號隔離 scope、原建立操作 key、原文及已確認專案 ID。原建立意圖儲存政策不改；草稿不進 URL、日誌、localStorage／sessionStorage 或新持久欄位。reload／新分頁不找回原文；查回訊息明示「查回專案不等於找回點子」。舊文件 `pagehide`、server 拒絕頁與既有 access-lost 關閉均清除交接。
- 只有可信頁面、完全相同帳號／新專案／點子階段及無既有保存內容、無另一筆編輯、無待處理操作的編輯器可消費交接。消費後立即移除，React effect 重跑及再次開啟不得重套；已保存的空草稿也不覆寫。拒絕覆寫時明示原因。讀取後其他分頁才寫入的競態仍由原 `If-None-Match: *`／版本控制拒絕，不自動改成更新。
- 帶入只呼叫原 controller 的 `edit`，顯示「未儲存」；不呼叫保存。學生可修改、放棄帶入，或按原「保存」；未知結果、版本衝突、失權遮蔽及原離頁守衛維持。本批成果止於點子已保存，不確認階段、正式分類或批准，不接 AI／登入碼。
- 原文不 trim／正規化／截斷，含換行、emoji、純空白與尾端空格；引導卡只在長度為零時放入起始提示。沿用 `stageDraftContentSchema` 的 PostgreSQL 字元驗證及既有保存本文 `JSON.stringify({content:{text}})` 的 **64 KiB UTF-8** 上限；不新增產品配額。
- 為避開共用展示占用的 Docker 埠，既有隔離 runner 增加選用 `-PortRangeStart`，預設仍為 55000，掃描窗口仍是 1290 埠；不停止其他容器或改動展示 worktree。

本輪驗證指令（Playwright 的參數是檔名正規表示式，不是 Windows 路徑）：

```powershell
npm run test:unit -- tests\unit\idea-draft-handoff.test.ts tests\unit\create-project-intent.test.ts tests\unit\protected-project-view.test.ts tests\unit\student-home-authorization.test.ts
npm run test:contract -- tests\contract\stage-draft-save-controller.test.ts tests\contract\stage-drafts.test.ts
.\scripts\test-auth-local.ps1 -BrowserOnly -PortRangeStart 57000 -E2EFilter real-auth-idea-handoff.spec.ts
npm run typecheck
npm run build
git diff --check
```

合成測試覆蓋帳號／操作／專案／階段綁定、一次消費、取消／晚到結果、既有空草稿／未保存編輯／未知操作拒絕、實際 65536-byte 邊界與非法字元。真瀏覽器使用隔離原生 Auth session setup、PostgreSQL 及 Next HTTPS；不是學生登入碼驗收。實跑結果、首次失敗、來源配對、去敏截圖與 ZIP 校驗值以本輪本機交付包為準；不把下方舊批次驗證當成本輪實跑。

## 原首頁 UI 批次紀錄（保留）

本批從 `51998ee833e306143daf8dfff4b37a9781f11a20` 的獨立 worktree 開發，依教育者 2026-11-08 本輪明確批准，只涵蓋 T040 的學生入口 UI／既有導覽，以及 T038／T041 直接對應測試。不是完整 US2 或正式聊天驗收。

## 操作與界線

- 可信學生工作階段進入 `/student` 後，仍先經伺服器本人資格與專案清單讀取，再沿用 `ProtectedProjectView` 初始遮蔽與重驗。
- 三卡與左欄三工具只選擇本頁草稿引導。空白時帶入可編輯起始提示；已有文字保留全文，並移動焦點至輸入框。未選卡也可直接輸入。
- 草稿不持久保存、不建立對話、不啟用 Skill、不送出請求。非空（包括只有空白字元）的草稿經品牌／返回首頁、本人專案、續作或剛建立專案連結離開前，使用既有 Radix Dialog 提供「留在本頁／放棄草稿並離開」。取消、Escape 或點遮罩保留原文，焦點回到觸發控制項；放棄後重送原控制項點擊，仍沿用 Next Link。建立表單成功只 refresh，不離頁，保存機制不改。
- 「我的專案」「創作空間」及跳到內容等同文件錨點不提示、不清稿。Ctrl／Meta／Shift 等新分頁操作、下載與非 `_self` 連結不會卸載本頁，不攔截。
- 重新載入／關閉分頁／瀏覽器返回及前進不在本輪確認保護範圍。未加入 `beforeunload` 或 Navigation API／history 攔截，避免原生提示延後既有登出的完整頁面導覽。真瀏覽器已驗證 reload 無提示且草稿為空；關閉分頁及瀏覽器歷史導覽未實測；離開後無持久恢復。
- 守衛只在創作空間 DOM 範圍捕捉連結，不攔截可信授權重驗／拒絕／登出流程。Dialog Portal 放在既有 `ProtectedProjectView` 的受保護容器內，因此初始遮蔽與重驗遮蔽也涵蓋對話框；已驗證草稿存在時停權遮蔽及登出無草稿提示。
- 「我的專案」連到同頁本人專案區，重用可信清單、建立表單、詳情連結與教師關係提示。最近建立的本人專案提供續作入口；階段原樣呈現，清單未提供摘要時明示缺少摘要。
- 六階段摘要映射尚未核定，暫不推導進度或批准。
- 新對話、檔案庫、附件、真正 Skill、送出與使用指南均標示「尚未開放」。專案內既有檔案／版本／build／publish 行為不變。
- 樣式只作用在學生入口的 CSS Module 容器，不修改共用 CSS 或教師／管理員／公開預覽頁。

## 驗證

- `npm run test:unit -- tests/unit/student-home-authorization.test.ts tests/unit/protected-project-view.test.ts`
- 以既有隔離 runner 執行：`powershell -NoProfile -ExecutionPolicy Bypass -File scripts/test-auth-local.ps1 -BrowserOnly -E2EFilter tests/auth-e2e/real-auth-home-entry.spec.ts`
- 選擇性設定 `APP_PLANET_UI_EVIDENCE_DIR` 可保存合成首屏、窄畫面、狀態與恢復結果截圖，以及瀏覽器實際載入的 CSS／SHA-256。不要設定到公開位置或使用真實學生資料。

瀏覽器案例使用隔離 Supabase Auth 的合成帳號 session setup，**不是學生登入碼驗收**。涵蓋真空清單、兩學生隔離、未登入、停用失權、初始無 JavaScript 遮蔽、DB 不可表示的時間值／隔離 DB 讀取權限撤回造成讀取失敗、鍵盤與四條草稿路徑，及從首頁進入檔案／版本區的真 HTTPS 保存、快照、恢復與 reload。首頁→專案及專案→建立 App 實際操作連結；版本頁沿用既有測試以其入口 URL 完整載入，不宣稱 SPA 跨頁籤重驗時序已驗收。隔離資源由原 runner 完整清理；fixture 資料不留在任何共用 DB。

文字採 UX 建議的深湖水綠 `#0E766D`，不使用參考圖較淺湖水綠承載一般文字；停用狀態仍可讀且有文字說明。布局由學生頁容器的 CSS 可用寬度決定：寬版保留 252px 左欄；850px 以下移到上方，所有入口保留，不新增收合操作。三卡使用 `auto-fit`／250px 最小寬度，自然轉成兩欄或一欄，主內容含 padding 最寬 1280px 並置中。頂列、表單操作與長文字可換行；不縮小文字、不固定整頁高度。確認框限制可用視窗高度，允許自然捲動。

本輪響應式真瀏覽器矩陣：1920×1080、1440×900、1280×720、1024×768、768×768、600×900、2560×1440；另以 720×450 CSS viewport 模擬 1440×900 的 200% 重排。後者不是桌面瀏覽器實際縮放驗收，不宣稱真 200% 縮放通過。完整矩陣、截圖與原始命令輸出交付於本輪審閱包。

## 未完成與治理

T039、T019、T024、T049 及原依賴保留；任務勾選、Q、Checkpoint／完整 Gate、正式簽核與正式啟用狀態均不變。未新增 API、migration、持久草稿、AI／歷史／額度或假保存狀態。本輪成果僅留本機，交 Reviewer；不 commit、push、merge、部署或接續其他任務。
