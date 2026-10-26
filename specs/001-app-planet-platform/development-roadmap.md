# App Planet 開發藍圖

**功能目錄**：`specs/001-app-planet-platform`（依 `.specify/feature.json` 核對）  
**基準**：[tasks.md](./tasks.md) 原有 T001～T136，共 136 項；任務 ID、正文、直接依賴及未勾選狀態均由 `tasks.md` 維持，本文件只整理現況與可驗收階段，不另造任務系統。  
**現況**：Checkpoint／完整 MVP Readiness Gate 尚未通過，正式審議／簽核未執行；本文件不構成實作、服務整合、資源建立或上線授權，也不以任務勾選數或測試數推算產品完成百分比。

## 分類與執行規則

- **A｜§74 A-9 供應商詢證準備包、必要政策裁決清單與原任務缺口更新（文件準備，非任務結案）**：[readiness §74](./readiness-review.md#74-2026-10-26-a-9-供應商詢證準備包必要政策裁決清單與原任務缺口更新一次性文件授權先登錄) 先登錄一次性授權。專案外[主報告](../../../../AppPlanet-A9-VendorInquiry-20261026/report.md)含管理者一頁摘要、完整詢證草稿（**未送出**）、逐題回覆驗收表（全部「未取得」）、責任待填表（全部「待管理者指定」）、六組政策裁決項（建議未批准）與[原任務缺口更新](../../../../AppPlanet-A9-VendorInquiry-20261026/task-gap-update.md)。D-32 四原則維持已批准，M3 仍僅 §70 固定候選，不選 M2、不擴 M3、不接受殘留窗口；不新增決議 ID。供應商詢證**尚未執行**，需教育者另行明確批准、責任具名與資料最小化確認；供應商能力不足時維持不可啟用，並交政策授權者另審替代方向。

  **缺口更新摘要**：現行 tasks 的22個 Phase 與指定分組一致（T001～T005 至 T127～T136）；136 項全部未勾選且**不是零成果**——已有可追溯的局部子集（T003／T004、T006～T008、T012／T014／T015、T050～T054、T095 等，見 [缺口更新](../../../../AppPlanet-A9-VendorInquiry-20261026/task-gap-update.md)），但沒有任一任務結案，也不以測試數推算完成度。直接受 A-9／供應商終結能力阻擋者為 T028～T030（T027 部分關聯待另審）；以依賴欄傳遞依賴 T028 的另有 T090、T101～T106、T120～T122、T124～T126、T128～T136。**T026～T030 更正**：本路線圖原「原子核發／重發」用語不得解讀為跨 Auth／平台 DB 全面原子或恢復舊碼；依 D-32 為平台交易、受控暫停、可信外部結果、向前恢復與最多一次秘密輸出機會；M3 固定環境證據不等於產品採用或完整 session 驗收。另列最多三個**僅提案**的本機候選（T013 契約純函式、T095 伺服端資格唯讀子集、任務路徑／migration 編號差異登錄），均不執行、不保證可先做；migration 編號 0010～0012 與 T060／T068／T072 規劃重疊，留待日後另批處理，本批不改 tasks。

  **本批唯一推薦下一步**：管理者審閱並修訂詢證草稿、填責任待填表，經教育者另行明確批准後才由具名詢證聯絡者發出；上述本機候選不是優先建議。本批只四份治理文件，正式契約／tasks／產品唯讀；網路 GET、供應商聯絡、服務 HTTP、資源啟動、帳號建立均為0，產品 test／typecheck／build／DB runner／模擬／commit／push／部署均 not_run。G0／Checkpoint／完整 Gate 未過、正式審議／簽核未完成，真實功能關閉；交付即停止，非常設許可。

> 以下 §73 與更早各批次保留當時範圍、用量與下一步，不構成本批後的自動授權；§74 僅準備詢證、整理裁決項與缺口，不裁決已批准四原則。

- **A｜§73 A-9 可恢復性證據與啟用設計缺口盤點（文件研究，非任務結案）**：[readiness §73](./readiness-review.md#73-2026-10-26-a-9-可恢復性證據與啟用設計缺口盤點一次性文件授權先登錄) 先登錄一次性授權；[專案外主報告](../../../../AppPlanet-A9-Recoverability-20261026/report.md) 含供應商證據矩陣、全路徑／跨角色、D-32附屬最小恢復候選／故障矩陣、營運責任／正式驗收計畫與保護／封裝紀錄。四原則已批准，不重列待批；新增設計proposed、缺證blocked，不新增決議ID。6／20官方GET取得固定v2.196.0來源並逐blob核對；timeout不證handler終結、Transaction有deadline／commit競態、session刪列不證所有晚到登入／refresh／資料操作排空。未取得供應商可信原操作結果／terminal／無晚寫能力、完整路徑強制、具名責任與正式驗收；unknown持續暫停，不自動重發／解除。

  **最新唯一推薦下一批**：管理者主導供應商終結能力證據取得與必要政策裁決，另行教育者明確批准、責任具名與非秘密詢證／保存／交接安排才進入；不能滿足則記不可啟用，不轉M2、不擴M3。整體順序為「證據與設計→必要政策裁決→另批最小隔離研究／驗收→原治理Gate→明確階段實作批准→產品整合及正式驗收」，詳[分階段計畫](../../../../AppPlanet-A9-Recoverability-20261026/operations-acceptance.md)。每階段均列進入／證據／失敗停止／不能證明項；本批不執行模擬或研究。M3僅§70固定候選、未採用；schema／enum／API／HTTP／TTL／保存天數／恢復時限不核定。Storage已規劃、Realtime採用待決，不能因單hook外推覆蓋；跨角色／公開／在途與全部旁路仍需驗收。

  本批只四份治理文件，正式契約唯讀；136任務ID／正文／依賴／未勾選與原前置、Q-AUTH／Q-SCHOOL保持，無任務結案。產品／SQL／歷史來源不改；資源／帳號／服務HTTP0，產品實作／test／typecheck／build／DB runner／故障注入／模擬／歷史回歸／供應商聯絡／commit／push／部署均not_run。文件驗證不等於安全驗收。G0／Checkpoint／完整Gate未過、正式審議／簽核未完成，真實功能關閉；交付即停止，非後續常設許可。

> 以下 §72 與更早各批次保留當時範圍、用量與下一步，不構成本批後的自動授權；§73僅補研究與設計，不再裁決已批准四原則。

- **A｜§72 A-9 已批准契約原則的正式文件同步（文件成果，非任務結案）**：[readiness §72](./readiness-review.md#72-2026-10-26-a-9-已批准契約原則的正式文件同步一次性文件授權先登錄) 先登錄一次性批准，依 [D-32](./decision-register.md#d-32-a-9-已批准契約原則與必要正式文件同步2026-10-26台灣) 同步七組必要正文：AUTH A-9／§2、data-model §1.5、COMMON／A-8／A-9、S-01-5／V-10、spec／plan、治理。四原則已批准／已同步，不再全列待批：移除跨 Auth／平台 DB 強回滾，已套用只向前恢復；不存可還原碼、同鍵只非秘密 receipt、最多一次秘密輸出機會且可能零次交付；unknown 受控暫停，無可信 terminal／不再可能寫入證據不盲重發或解除；原則批准不等於啟用，unknown 可長期不收斂且無自動／未核定時限承諾。保留教師／管理員授權、核身／稽核、D-06(a)／M1／R-a 與 account／school／ownership gate，暫停不改 disabled／學校／師生關係。

  **仍待完成藍圖（僅提案、不執行）**：可審閱供應商操作結果／取消／冪等／不再可能寫入能力及託管升級支持→完整 session／全路徑、相依在途與解除證據、秘密輸出門閂／狀態／恢復設計→具名恢復主責／備援與支援安排、保存／清除／時限政策→逐階段故障、並行晚到及跨角色／委派正式驗收計畫→另批研究／驗收，仍依原任務前置、Tasks／Analyze、Checkpoint／完整 Gate 與階段批准評估產品實作。上述供應商能力、schema／enum／API／HTTP／錯誤碼、TTL／logout scope／最大撤銷時間／cache／在途／背景、journal 保存及服務時限均未核定。M3 僅固定環境候選、未產品採用／部署，M2／hold／journal／dispatcher 未實作；可恢復性或責任／驗收缺證即維持不可啟用。**不是 T026 或任何其他任務完整結案**，136 項正文／依賴／全未勾選不變。十文件之外與研究來源／產品／SQL／runner／package／lockfile不變；本批新驗收全部〔尚未執行〕，資源／帳號／服務 HTTP／官方下載0，產品測試／typecheck／build／DB runner／回歸／模擬 not_run。G0／Checkpoint／完整 Gate 未過、正式審議／簽核未執行、真實功能關閉，封裝後停止。

> **以下 §71 及更早各批次是歷史紀錄**：其「先裁決／正式正文未改／全部待批」不再適用 D-32 四原則；其餘候選證據、未批准設計與阻擋未被本次取代，不授權自動接續。

- **A｜§71 M3 導入前條件與 A-9 契約收斂（文件／固定來源靜態查證；非產品採用）**：[readiness §71](./readiness-review.md) 已先登錄教育者一次性 T026／實際 T008／T011 設計子集；[外部五份報告入口](../../../../AppPlanet-M3-A9-20261026T123500-19d711b0/m3-adoption-prerequisites-review.md)。12 份官方核心來源與 hash／短摘錄、固定 Auth tag／tree／7 blob 核對，區分完整有效性與兩欄存在性；託管 custom policy 支持／完整 migration／真正 refresh 與改碼底層仍缺證，M3 僅固定環境候選。**唯一下一步順序**：教育者先裁決 A-9 受控暫停／unknown／向前恢復／同鍵不重播秘密的精確草案→另批正式契約連動同步→管理者取得供應商支持與具名責任、另批固定來源缺口／timeout晚到與明確版本相容研究→完整 session／全路徑可信 principal／pool／舊 session／在途／回退設計驗收→依原任務前置、Tasks／Analyze、Checkpoint／完整 Gate 及明確階段批准才評估產品接線。DB fencing 不能取消在途 Auth，無可信終結證據時 unknown 不得自動重發／開入口；不假稱 exactly-once delivery。比較另一管理員維護鎖方案，未選為正式政策；可還原碼／換憑證不作捷徑。AUTH／spec／plan／data-model／contracts／quickstart 正文與136任務／依賴／未勾選保持；只四治理更新，產品／migration／runner／package／lockfile與§69／§70來源保護。資源啟動／帳號建立／服務HTTP0、官方唯讀GET12，SQL／測試／build／runner／離線回歸／供應商聯絡未執行。G0／Q-AUTH／Q-SCHOOL／Gate／正式簽核未滿足，真實功能關閉；封裝回報後停止。下列較早下一步為歷史，不構成自動實測／實作授權。

- **A｜§70 M3＋單一最小Auth SELECT policy（隔離研究完成；候選支持，非產品採用）**：[readiness §70](./readiness-review.md) 先登錄教育者一次性T026及T008／T011實際子集，原helper／hook／issuer getter／actor／owner／欄位grant不改；只有正常candidate新增精確reader／sub＋sid的單policy，兩個暫撤故障及B.status disabled／approved另有批准與分phase。run `fd1b24a3e43f` N01～N10完成、exit0、candidate_supported／adoption=not_approved：baseline誤拒獨立；真Auth三session正向、無外部session WHERE的reader各精確1列／跨session不可見、SQL形狀與3種HTTP負向、目前refresh追蹤、local logout／改碼後舊access兩輪拒絕及新／其他session成功、獨立account gate與恢復、兩個交易故障各rollback恢復、最終撤policy後原hook持續拒絕均取得證據。1／1stack、2／2建立、111／128HTTP、95.108秒、Mailpit三階段0、finally及獨立labels零殘留；語法／90＋22＋14離線回歸及46份實際被測來源保護，原始失敗與程序限制另存。外部成果 `C:\Users\geste\AppPlanet-M3-Policy-20261026T005800-7c2a904e`；產品驗證not_run、136任務整檔／依賴／未勾選不變。**後續不自動執行**：教育者審閱候選→另批Auth policy供應商migration相容／完整session條件與正式issuer-key-TTL-scope／窗口→調和A-9跨Auth／DBunknown及一次顯示response-loss契約→按原前置、Tasks／Analyze、Checkpoint／完整Gate及明確階段批准評估可信provider／cookie／交易／產品接線；多pool／在途／背景／其他服務與完整S系列另驗。不轉M2、不核定採用，Q-AUTH／Q-SCHOOL與G0／Gate／正式簽核／功能關閉不變，下方§69「待另批」保留當時歷史；封裝回報後停止。

- **A｜§69 Session 阻擋有界設計比較（文件完成；推薦未獲實測／採用授權）**：[readiness §69](./readiness-review.md) 先登錄教育者本批一次性文件批准；T026研究規劃及T008／T011實際信任邊界設計子集。外部比較包位於 `C:\Users\geste\AppPlanet-Session-Options-20261026T003454-259f7360`。M2＝登入時session_id×登入碼version不可變綁定；M3＝原生session存在性；C＝server每請求權威／可信交易強制責任，可配A／B、不等同M2。**唯一推薦下一批**為M3＋一條只對reader／精確sub＋sid列的最小Auth SELECT policy隔離研究，原helper／hook／owner／grant不改，不重做reader四層診斷；policy是新列可見性擴張，另批才可啟動。必要真Auth正向／baseline與candidate分開、local logout／改碼後舊access拒及新session可用／目前refresh／predicate負向／故障恢復／policy回退拒絕與清理；1stack／2建立／128HTTP／20分鐘均僅預算提案。M2另缺binding／journal／binder／fencing與跨Auth／DBunknown恢復，A-9強rollback／一次顯示response-loss衝突已列待決不改正文。既定server＋cookie入口不重開、不接產品，也不假設其他可達資料路徑已封；完整有效性、Storage／Realtime、pool／在途／正式TTL與窗口留後續。指定最新包／必要來源已核，§65完整raw／重算檔缺於包內只沿治理摘要列限制，不換未核驗包。220檔baseline、67歷史直接來源保護；資源啟動／帳號建立／服務HTTP皆0，產品test／typecheck／build／既有DB runner／離線回歸／任何實測／SQL／M2／M3實作全部not_run。136任務ID／正文／依賴／未勾選、Q-AUTH／Q-SCHOOL、G0／Checkpoint／完整Gate／簽核與真實功能關閉不變；封裝回報後停止。後續僅待教育者另批研究→必要政策／契約／信任邊界→原前置與完整Gate→明確階段實作批准，非接線放行。

- **A｜§68 最新一次性四層補證（已完成診斷，原 M3 仍不可用；封裝後停止）**：[readiness §68](./readiness-review.md) 已先登錄本批T026及T008／T011實際研究子集；來源改完整函式識別與Auth初始化後分階段基線，§67實際失敗fixture及明示metadata補充的同邏輯回歸、既有90／90與本批22／22／語法通過。run `890b6e214a9d` A／B同已驗簽session：控制綁定存在→同snapshot原reader成功零列／00000→真認證原helper=false／00000→原session-hook三路徑HTTP403／42501 session rejected；catalog前後未變、RLS啟用／實查零policy、reader非owner非BYPASSRLS，已支持本固定設計預設拒絕的具體根因。不是一般M3不可能，不回填§66／§67歷史，helper內部身分未直接監測。診斷completed、安全not_met、未批准採用、真實exit2；1／1stack、2／2建立、33／64HTTP、39.240秒，Mailpit三階段0，finally／獨立三類labels零殘留，敏感暫存移除。41份被測來源一致；產品／67既有直接來源重盤點、136任務整檔與原依賴／未勾選不變，產品驗證not_run。後續只提另批最小Auth policy之可信claims／敏感session／相容性／回退研究或M2設計，本輪不擴權、不實作新M3／M2或產品接線。下列§67「最新」為當時歷史快照；Q-AUTH／Q-SCHOOL與G0／Gate／簽核／功能關閉狀態不變。

- **A｜§67最新有界診斷（未完成，額度用盡後停止）**：[readiness §67](./readiness-review.md) 已先登錄T026／T008／T011實際研究子集。A／B真實登入／驗簽及issuer-only正向控制通過，catalog實查sessions RLS=true／FORCE=false／owner=research_auth、零policy；reader僅id／user_id讀、非owner／非BYPASSRLS、無其他角色切換。來源比對工具對`uid()`顯示名稱及初始化正文的不當假設觸發停止，process exit1；控制角色session綁定→reader→helper→session-hook HTTP均not_run，**根因inconclusive，不是已證明RLS誤拒**。1／1 stack、2／2建立、23／64 HTTP、28.532秒；finally及獨立labels零殘留、敏感暫存移除，Mailpit final not_run。僅提下一批另批相同權限唯讀補證，先修工具來源定位與初始化後基線／回歸；本批未修復或重跑、不擴權、不實作新M3／M2。無已驗證無擴權修復，Auth policy／owner／權限候選須另案審閱。136任務及原依賴不變、Q-AUTH／Q-SCHOOL未滿足、產品驗證not_run，G0／Gate／簽核及功能關閉狀態不變。

- **A｜§66結果（已按停止條件停止）**：[readiness §66.3～66.4](./readiness-review.md) 的最小欄位SELECT／非BYPASSRLS M3 helper誤拒有效E、新session及B2；原生sessions RLS啟用，完整pg_policy未盤點，僅能判本次方案不可用、一般M3可行性inconclusive。baseline原生列消失後舊access仍可讀的缺口已重現；相依事件／負向均blocked，不算M3通過。首套exit1、研究incomplete／安全not_met；1／2 stack、138／320 HTTP、5／10建立、84.384秒，finally與獨立零殘留。停止控制缺陷僅離線修復至90／90，被測版本89／89；第二套not_run、沒有兩套最終來源一致驗證。下一候選須另批唯讀Auth RLS／最小權限研究或M2比較，不先改權限、不轉做M2。產品導入仍缺正式政策／信任邊界／交易與回退／覆蓋驗收、原治理前置及明確階段批准。

- **A｜§65歷史研究與§66一次性M3候選研究（非產品採用）**：[readiness §65／§66](./readiness-review.md) 的T026／T008／T011部分範圍，原依賴及Q-AUTH／Q-SCHOOL不因此滿足。§65舊碼拒絕／新碼成功；更正為`/user`首次觀測拒絕約0.7～0.8秒（相對事件送出），refresh首次拒絕完成於事件回應後約1.8～2.4秒，非內部刪列時刻。rows殘留下界不套用gate稀疏取樣。第二套到期後A／B最後成功exp+24.1／24.4秒、首次拒絕exp+31.4／31.7秒；E最後成功exp+30.7秒、首次拒絕exp+45.7秒，成因及最大上界未知，不稱30秒固定寬限、不核定PP-04。C／D ban前DB已拒絕，無法單獨辨識ban資料層效果；local僅研究候選。§65保留exit1／2、372／600 HTTP、10／10建立、2／2 stack、917.7秒與清理證據。§66僅隔離M3研究、不轉M2；完整S系列、產品撤銷與接線、正式政策、重放等仍待。產品驗證not_run，136任務正文／依賴／未勾選不變，Gate未通過、正式簽核未執行、真實功能關閉。

- **A｜較早一次性研究（§64；已停止，非產品採用）**：[readiness §64](./readiness-review.md) 記錄四角色與research_rest真認證連線實際可用SET／SET LOCAL／set_config改GUC（00000），推翻只憑catalog SET=false的不可竄改假設；SQL證據未證明遠端HTTP可利用。專案外研究改為未公開設定表＋最小DEFINER getter，hook與actor仍INVOKER；後兩套全新資源各50案改寫／同hook、49案修改拒絕、4案fail-closed及JWT／actor／RLS／七寫入完整矩陣通過。第一套因setup session SET ROLE測試條件中止exit1、完整保留；補回歸至60/60後兩套exit0。3/3 stack、141/160 HTTP、6/6建立、388.066秒，finally與獨立零殘留；產品83檔hash與136任務不變，產品驗證not_run。§61～§63與baseline計分錯誤保留，§63「不能SET」由§64更正；Gate未過、簽核未執行、真實功能關閉，無後續產品授權。

- **A｜最新一次性研究（§62授權／§63結果；已停止，非政策核定）**：[readiness §62／§63](./readiness-review.md) 記錄T026研究子集、T008授權邊界及T011 HTTP路徑子集。41項舊回歸＋8項研究validator／hook測試共49/49；真實Auth A／B token通過研究validator。Baseline正確簽章錯issuer及缺／近似issuer可經直接PostgREST取得A資料；原run實際exit0但runner錯將securityGap計分為passed，原結果保留、獨立hash判讀為安全failed／語意exit2，修正後才啟動補強stack。PostgREST v16.1全域pre-request hook使錯／缺／近似issuer在測試表格及兩RPC均以HTTP403／42501政策拒絕；簽章／audience／expiry仍分別為原生401／PGRST301／PGRST303。A／B自有資料、跨帳號／匿名、HTTP actor、7項寫入拒絕／快照不變通過；研究validator與直接PostgREST結果分層。2/3 stack、6次分階段up、130/160 HTTP、4/6帳號、並行1、保守錨點至清理1,121.582秒；finally與獨立labels零殘留，無host ports／pull／產品改碼。產品issuer／BFF／hook均未接線或採用；Storage／Realtime、session撤銷、M2／M3、完整S-01～03及產品test／typecheck／build／既有DB runner not_run。136任務不變，Gate未通過、正式審議／簽核未執行；不接續產品工作。完整表格、來源差異、限制與候選建議見專案外複核包。

- **§61歷史一次性研究（已停止；安全缺口保留）**：[readiness §61](./readiness-review.md#61-2026-10-25-jwtrls-研究工具修復實際-actor-驗證與原矩陣續測一次性隔離本機批次) 記錄T026及T008子集的兩套原始實測：41/41回歸、兩組正確簽章錯issuer均取得A資料，兩次runner實際exit2；82/120 HTTP、4/6建立、123.037秒至末次清理，finally及獨立labels零殘留。§62／§63後續研究不改寫該歷史。

- **§60歷史一次性研究（研究未完整，額度用盡後停止；不倒填）**：[readiness §60.2](./readiness-review.md#602-實際結果缺口與停止2026-10-25額度用盡) 記錄教育者先行批准的 T026 研究子集及 T008 既有 gate／RLS 引用子集。3/3 stack starts、18/120 HTTP、2/6建立、374.816秒至最後清理；Auth readiness、A／B真實建立／登入與 claims 觀測、研究 schema／fixture成功。錯誤 actor catalog gate 於資料 HTTP前中止，實際 PostgREST actor、RLS、寫入／升權、四類 JWT 負向均 `not_run`；三次 finally 清理零殘留。finalizer與比對 gate 僅離線修正、合成／靜態24/24通過，沒有第四次驗證。主機publishing缺口仍在、產品未接線、136任務不結案；下方§59～§58為歷史。
- **§59 歷史一次性研究（已停止）**：[readiness §59](./readiness-review.md#59-2026-10-25-管理建立-http-500-最小重現研究工具修復與登入正向驗證一次性隔離本機批次) 記錄 T026 管理建立500最小重現、研究工具修復與真實登入正向；研究角色預設 `search_path=auth, public` 後，兩套全新資源建立／登入200且ID一致、Mailpit各階段0。3/3啟動、19/40 HTTP、3次建立／2次登入、192.626秒至清理；只證明單網域登入正向，不含JWT簽章／RLS／產品接線。

- **§58 一次性工作歷史（已停止）**：教育者另批容器內真實 Auth／JWT→RLS 最小隔離研究，先登錄授權再啟動。專案外唯一目錄、四快取 digest、無主機 ports、DB curl 經 stdin 向單一 internal network 服務名稱發送；傳輸合成末版 8/8，第二、三次 Auth／PostgREST／Mailpit readiness 各 200，actor／隔離查核 passed。但管理建立皆 HTTP 500，核心登入／JWT→RLS／S-01-4／S-03／窗口均 not_run。3/3啟動、12/200 HTTP、3次建立請求（0確認成功）、至末次finally233.671秒；清理與labels零殘留通過。歷史結果詳[readiness §58](./readiness-review.md#58-2026-10-25-容器內真實-authjwtrls-最小隔離研究一次性批准)。
- **A｜本輪已授權工作（已停止）**：[readiness §57](./readiness-review.md#57-2026-10-25-auth-migrationlistener-分層診斷與最小修復一次性本機批次) 是 T026 migration／listener 分層診斷子集；T015 測試／T008 邊界僅實際相依。2/3 啟動、10/30 HTTP、0 帳號、至末次清理 345.518 秒，沒有外部查閱。兩次 migration 完成事件、public migration 70／auth 0、9999 全介面 listener、容器 loopback／同網路 HTTP 200 重現；主機 Node／curl 全拒絕，active port mapping 空陣列、Windows listener 0，定位主機發布未建立，Docker 下層原因／修復仍未知。完整 readiness／完整成功重跑未達，不放寬 internal、不做無依據第三次。原七項＋五項合成 12/12 通過，每次 finally／獨立清理通過；第一次 readiness 超窗 2.597 秒保留，第二次 runner 預留時間修正後 45.524 秒。僅四文件及專案外研究來源變更，產品 test／typecheck／build／既有 DB runner not_run；不接登入／JWT／RLS／session／mail API／S 系列／provider／HTTP／UI 保存。
- **§56 診斷歷史（不倒填）**：[readiness-review.md](./readiness-review.md) §56 為另批隔離本機 Auth 啟動／健康診斷，3/3 次、HTTP 3/30、0 帳號、約 29 分 42 秒；migration `42501` 定位 public schema，uid owner 只由探針證實。最後僅 public CREATE／uid owner，Auth running 但 3 次 health 均 ECONNREFUSED，當時 migration 完成／listener／runtime readiness／成功重跑仍未證明，三次清理通過。[前置表 §10](./auth-wiring-preflight.md) 保留原結果，不以 §57 倒填。
- **§55 研究歷史（不倒填）**：單批方案 A 隔離研究僅取得 DB setup／啟動與 1 次 health 失敗，0 帳號；登入／JWT→RLS／mail API／S-03 未執行。舊 catch 的「傳輸失敗」涵蓋 fetch／本文／JSON，不能一律認定 fetch 根因。§54 文件-only、§55 失敗與 not_run 原紀錄保留，§56 沒有使其通過。
- **§56 用量補充／程序缺口**：上述本機 HTTP 為 3 次；加官方來源查閱 2 次操作，保守合計 5/30。官方查閱曾以 parallel 批次發出，工具 timeout 未揭露，不宣稱全批 HTTP 並行／timeout 完全合規；詳見 readiness §56.3，已停止外部查閱。
- **最近已接受本機子集（歷史，非持續授權）**：§53 僅新增 T054 測試來源 adapter，將 controller request 的 save body／UUID key 正確分離，接至既有 owned-draft server 與隔離 PostgreSQL；以既有 read service 初始化，驗證真實 commit、response loss／replay、衝突、競態與授權。§53 記有新增 18 個控制器 DB 案例及既有回歸通過；只有測試專用整合，不是產品接線、真實 Auth、瀏覽器保存或正式功能啟用。T054 主要整合子集，T051／T050／T015、T006／T008／T004 僅實際涉及部分；原依賴與 136 條任務未勾選狀態不變。§52 為 F-01／F-02 修復；§51 控制器／模擬；§50 T053 唯讀展示；§49 T052／T051 唯讀評估 server；§47～§48 純函式／修復。均不重做，不改 Q-DATA／保存期限／政策／Gate。
- **B｜未來候選工作**：下列 Tasks 原任務的後續執行，須先完成所需規格／待決事項、Tasks、Analyze、完整 MVP Readiness Gate，並另取得教育者針對階段的明確批准。除另有書面界定外，不得把本機純函式或合成測試擴大成服務整合。
- **C｜需補證／核定**：政策、外部證據、學校／供應商環境及費用等未具備事項，依 Tasks 原 Q／前置欄和 [readiness-review.md](./readiness-review.md) 原責任角色補齊；未核定即依現行契約維持拒絕／關閉。
- 表中「直接依賴」列主要跨工作區塊的任務 ID 和外部前置。區塊內每一條任務的完整直接依賴仍須逐項依 `tasks.md` 的「依」欄核對；不得將表中摘要當成取代或改寫依賴圖。
- `[P]` 只表示原任務可平行撰寫其獨立測試；依 Tasks 規則，T015 與該任務的 Q 前置未完成前，不得把標記解讀為可開始產品工作。

## 既有成果與尚缺範圍

**§60最新證據分層**：單網域 Auth A／B 原生管理建立／password登入及 token claims 觀測已成立；但 PostgREST actor 通路、資料端點、RLS、JWT負向／驗簽均未執行，不能據此宣稱資料隔離或完整S-01。批次已用盡3/3啟動額度並停止；研究runner尚需修正後另批才能再驗，這不授權任何新資源啟動或產品接線。

**Auth 下一必要候選（僅提案，不接續）**：另批前應先修正 §60 已定位的 runner actor catalog 比對（控制連線 `supabase_admin` 不等於 PostgREST 實際 session user），並修正 finalizer；未重新取得明確批准前不得啟動資源。若未來批准，須透過 PostgREST actor snapshot 證明真實 actor／角色切換，再執行原矩陣；不得把目前角色目錄查詢當作已測 RLS。§57 主機實際發布未建立、Docker 下層根因／修復及主機成功重跑仍未完成，與本輪容器內研究分開處理；不能放寬 internal／加網路或代理。現有應用服務不重做；T008 principal／交易 provider、T011 HTTP、T016～T020 教職員及 T027～T030 核發／登入／E2E 均未開放。Q-AUTH／Q-SCHOOL、G0／Checkpoint／完整 Gate 未通過及正式簽核未執行保持；以下較早「本輪」保留歷史語境。

| 原任務 | 可確認的既有部分成果 | 尚缺及不代表完成 |
| --- | --- | --- |
| T026／T008／T011 歷史生命週期研究（§65；§66更正） | 原始兩套來源／結果／失敗保留；rows與gate分列各自取樣下界，Auth的HTTP拒絕不等於精確刪列；到期後接受的成因與最大上界未知，不稱固定30秒寬限 | §65未驗M3；§66另批僅隔離可行性，不回填歷史、不採用產品或scope／PP政策；產品test／typecheck／build／既有DB runner not_run，任務未結案 |
| T026／T008 JWT→PostgREST→RLS 研究（§60） | Auth／PostgREST／Mailpit readiness、A／B真實建立／登入及claims觀測、研究schema／FORCE RLS／合成fixture成功；3/3 stack、18/120 HTTP、2次建立、374.816秒；清理零殘留 | runner錯誤比對setup session與PostgREST actor，在資料HTTP前停止；實際actor、RLS、跨帳號、匿名、寫入／升權、四類JWT負向均not_run；研究不完整，不結案、不授權重跑或產品接線 |
| T026 管理建立500／登入正向（§59） | 500同窗Auth／DB 42P01／identities與真正新連線namespace證據；一項search_path研究修復；兩套全新資源建立／登入200且ID一致／Mailpit各階段0；18/18合成、完整清理 | 僅單網域正向局部，完整S-01～03／JWT簽章／撤銷／資料RLS／生命週期／產品接線仍未驗；主機publishing不修，3次啟動額度用盡，不結案或續作 |
| T026 容器內最小研究（§58） | 傳輸 8/8、三服務 readiness／actor／runtime 隔離、實際 setup 42501／管理建立 500／probe exit 2、安全逐命令證據、三次 finally／獨立清理 | 3 次啟動額度用盡，研究驗收未達；無成功學生登入、真實 JWT／RLS／舊碼／生命週期／窗口；Mailpit 只有各次初始 0，不是整批零郵件；namespace 修正未驗，不結案或接線 |
| T026 migration／listener 診斷（§57） | 12/12 合成；兩次新資源 migration／listener／容器及同網路 HTTP 200；主機實際發布缺口；即時 runtime 隔離、完整清理及來源／命令證據 | 完整成功未達，Docker 下層原因／修復與主機 health 成功後完整重跑仍缺；第一輪超窗偏差保留，產品／S 系列不執行、不結案 |
| T026 啟動診斷（§56） | 分層／遮蔽合成 7/7、三次來源／命令／setup／container／日誌分類證據；public schema／uid owner 的具名權限重現與兩行研究修復；三次清理及獨立零殘留 | 最終 health 3 次無 HTTP，未達 readiness、runtime 成功隔離及清理後成功重跑未驗得；不啟動 PostgREST／帳號／登入／JWT／RLS／session／mail API，不結案任務 |
| T026 方案 A 隔離研究（§55） | 專案外完整候選研究來源、固定 digest／非秘密設定、實際 setup 與失敗 exit／health 證據；精確 labels 零殘留、listener 釋放、敏感設定銷毀與 ZIP | Auth readiness 失敗；S-01-1／4、JWT 四項／RLS、Mailpit 計數、S-03 事件／窗口均 `not_run`。沒有正向登入或產品接線；不結案任務、不通過 Gate、不核定 PP／M2／M3 |
| T054 草稿保存控制器（§51／§52／§53；本輪） | §51 傳輸無關控制器與合成模擬、§52 F-01／F-02 修復均保留；§53 只在 `tests/integration/stage-draft-save-controller.test.ts` 新增測試 adapter，使用既有 read／save server、可信測試 transaction context 及隔離 PostgreSQL，覆蓋 COMMIT／response loss／replay、版本衝突、編輯／切換競態、權限及 scope。runner 新增固定測試清單，結果與限制依 readiness §53 | 僅驗證應用服務整合；沒有產品保存接線、HTTP／Server Action／真實 Auth／瀏覽器 DB 寫入、持久化或正式功能啟用。Q-DATA／保存期限待決。T053 原依賴保留；T054／T051／T050／T015 等僅部分成果、不結案，136 項任務仍未勾選 |
| T053 學生工作區唯讀介面（§50；本輪） | 可重用唯讀展示元件、七個可鍵盤操作頁籤、九正式階段草稿摘要、分類／需求／評估安全文案、6 個本機展示情境及獨立路由；只用合成資料，與既有學生頁禁用操作相容 | 僅介面預覽，不連接工作區 server／登入／資料庫、不保存／恢復、沒有 IDE／測試執行／快照／發布結果；T053 依賴 T052 保留、T051／T052 任務不結案，T050／T015、T006、T004 僅 §50 子集；CheckPoint／完整 Gate 未通過、正式簽核未執行 |
| T052／T051 創作旅程唯讀評估 server（§49；本輪） | 單一 PostgreSQL statement snapshot 重查 `read_saved_content`／owner，組合 project 版本、當前需求 revision／原文、完整內部確認 evidence 與九步草稿；只將完整驗證資料交給既有純函式，回傳白名單 snapshot assessment。`platform_ai_assisted_creation` 改為不參與判斷的選填背景欄位，不設假預設。實測與差異見 readiness §49 | 僅本機唯讀子集，不是真實 Auth／HTTP／UI／永久資格／批准來源／操作授權；OD-12／階段完成規則仍 unsupported。T052／T051 及 T052→T051 原依賴均不結案；T050／T015、T006／T008／T004 僅本輪涉及子集，136 條任務維持未勾選 |
| T052 創作旅程判斷／審閱修復（§47～§48；歷史） | §47 既有旅程判斷不變；§48 增加 confirmation evidence 的 project／tier／visitor 欄位與逐項關聯驗證，並凍結 unresolved-decision 共用常數；修復前單案例紅燈，修復後目標 29／29、全體 471／471、型別檢查及停用 telemetry build 通過。詳細輸出以 readiness §48 為準 | §48 當時沒有 DB／server；該歷史限制由 §49 明列子集部分擴展，不互代結果。結構檢查不證明來源／身分／DB 現況；OD-12 等待決規則仍 unsupported。T052 部分成果，T051 原依賴保留；無階段推進或操作授權 |
| T051 工作區聚合（§46；歷史） | 傳輸無關唯讀白名單 DTO，單一 statement snapshot 聚合專案／當前需求／完整三態分類與九步已保存草稿；缺介面紅燈後目標 37／37、全體 442／442，真實 DB 新增 21 項與既有專案整合合計 162／162 通過，授權／pgTAP／migration 相容保留；型別與停用遙測 build 通過 | 只有資料恢復準備，不是登入登出恢復或 UI／E2E；confirmed 不成為可信分類來源或永久資格。無 migration／新 grant／寫入／階段推進／下游操作；原任務／依賴／Gate 不結案。封裝前 final-* 重跑與來源／清理證據以 readiness §46 及 manifest 為準 |
| T051 階段草稿（§45；歷史） | 新增獨立未確認草稿表、strict 原文 schema、保存／新交易讀回、自身版本／安全衝突、UUID 冪等與窄用途交易；新草稿真實 DB 37 項及既有專案／分類 104 項通過，12 次真寫入後回傳破壞完整回滾，原權限／pgTAP／型別／build 與 runner 故障回歸保留 | 只保存學生提交草稿，`ai_draft` 不代表 AI 生成；不寫權威需求、不產生分類／Checkpoint／批准／Final Pack 證據或階段推進。無 HTTP／UI／真實 Auth／登入恢復、T052～T055 或下游操作；T051 等僅子集，不結案或改依賴／Gate |
| T051 分類審閱修復（§44；歷史） | 修復 resolver 來源標記、confirmed 舊介面相容性及內部結果驗證回滾；目標契約 105／105、一般測試 390／390、真實 DB 專案整合 104／104、原 pgTAP／授權、型別與停用遙測 build 通過。10 個真寫入後結果破壞案例完整回滾，另覆蓋 replay；撤權／catalog／獨立零殘留已驗證 | 未改 SQL／schema／adapter／runner／清理或依賴，runner 故障情境本輪 not_run。來源標記不是永久資格；當前資格仍須重查 DB。無新產品功能，T051 與原依賴／Gate 不結案 |
| T051 分類確認（§43；歷史） | 新增最小需求 revision、學生明確確認／變更失效、可信分類讀取與受控 PostgreSQL 交易；當輪結果見 readiness §43.4；三項審閱缺陷的本輪補正見 §44 | T051 依賴 T050、T039 不變且未宣稱滿足；無 HTTP／UI、真實 Auth、完整 Specification／stage_records／tasks、旅程／Checkpoint 推進或任何預覽／發布操作。原任務未結案，完整產品 Gate／驗收未完成 |
| T051 建立子集（§41；歷史） | 新增 0010 migration、未分類／歷史未驗證 DTO、舊介面 unsupported 結果、窄用途受控原子建立／冪等及資格 fail-closed 邊界；目標契約 81／81、一般測試 366／366、型別與 build 通過 | Docker daemon 不可用；migration／RLS／直接 DML／真實併發／回滾與 PostgreSQL 全整合 `not_run`。未建立分類確認、revision／失效、階段／版本服務或 HTTP／UI／Auth；T051 仍只完成子集。實測與證據見 readiness §41 |
| T051 初始化同步（§40；歷史） | 正式規格／PROJ／模型／決策同步固定「點子」／0；建立缺漏型別與既有兩份測試期待移除 initial_stage／initial_row_version，不新增重複案例；兩個分類來源方案詳見 [決策登錄](./decision-register.md)，推薦案 A 仍待批准／未採用 | 明示 tier 只剩 visitor_identity_initialization；省略時另缺 omitted_tier。成功建立／寫入原子性／冪等仍 blocked／not_run；不改 0009、RLS、唯讀 DTO 或原依賴，沒有新可寫權限。本輪實測結果見 readiness §40.3，不以 §39 歷史通過替代 |
| T051 建立子集（§39；歷史） | [projects.ts](../../apps/web/src/server/projects.ts) 新增傳輸無關驗證／拒絕邊界；新單元 44／44、新 DB 拒絕 35／35，連同原唯讀 30、授權 29、pgTAP 61＋53、一般單元 369／369、型別及 build 通過；正常及 NotOk／SqlError 三次均撤銷／catalog 還原／零殘留 | **當時成功建立 blocked**：初始 stage、row_version、訪客識別欄位初始化及省略 tier 規則直接缺漏；本輪 §40 只解決前兩項。無 migration／寫入 RPC／可寫 context，不宣稱成功原子建立、成功冪等或新專案隔離驗收；T050／T039 等原依賴與 Gate 不變 |
| T003／T004／T006／T007／T012／T013（§75，最新） | 四個 workspace（`apps/worker`、`apps/works-edge` 僅配置骨架）與 Node 24／Next 16／React 19／TypeScript 7 相容性檢查；Vitest unit／contract projects、正式環境隔離守門、Playwright（本機 Edge 煙霧 2／2）、`supabase/config.toml`；COMMON producer problem+json／409 conflict／202 queued／冪等重用碼；identity／audit pgTAP 78／78；core＋worker 白名單日誌與稽核 DTO、R-12 遮蔽層；works A1／B2／X 契約、保留路由與 works CSP 模式。單元＋契約 695／695、typecheck／build 成功、DB 三情境與兩個故障注入符合預期、docker 零殘留 | 六項任務本機範圍實作完成，**全部仍未勾選**：T001 未取得（T003→T004→T006／T007→T012／T013 鏈）；`school_approval_records`／管理員 RPC／稽核 action 集合待決或後續；各 kind Job result 欄位、真實簽章／驗章、works-edge／Worker 服務、log sink、PP-20～27 核定值仍缺；Playwright 內建 Chromium 未下載。不是 Gate 通過，也不授權產品啟用 |
| T003／T004／T014 | 本機 npm workspace、core 套件入口、Vitest、tests 型別檢查設定、`apps/web` 靜態骨架及 §35 單一本機 PostgreSQL／pgTAP runner 已存在 | T004 僅完成本輪 DB 測試配置子集；完整 Web／Worker／works-edge／Playwright／正式環境隔離與部署設定仍缺（**§75 已補 workspace／Playwright／正式環境隔離／config.toml，見上列**） |
| T006 | `packages/core` 已有部分共用 schema／純函式；D-25～D-30、UTC、SSE 專屬事件序列、§29 狀態映射修復及 §32 診斷日誌 DTO／型別驗證的局部契約／測試子集已完成 | 完整 COMMON／HTTP／Job／SSE／冪等／競態與資料層範圍仍缺；§29 不再重做；§32 不等於完整 route／HTTP 錯誤碼登錄 |
| T007 | §33 新增本機 migration／pgTAP 來源，涵蓋 schools／profiles／M1 歸屬／bindings／audit／identity map 及直接權限限制；§34.2 歷史實測與 §35.2 重跑均兩份 migration 成功，identity/audit TAP 61／61 | 僅 Supabase PostgreSQL 映像層級；無管理寫入流程、正式資料遷移、保存／清除服務或完整 audit action 集合；T007 原任務未結案 |
| T008 | `account-gate.ts`／`teacher-account-prep.ts` 帳號層純函式與 §33 DB 子集保留；§37 新增 `apps/web/src/server/authorization.ts` 唯讀介面，經測試專用受限 actor 實際查詢既有 SQL gate：29／29 整合、原 account-gate 53／53；涵蓋提交後立即重判、pool 主體隔離及依賴失敗 | 尚無產品 Auth principal／交易 provider、HTTP／UI 或一般服務接線、真實登入／核發、完整資源授權／教師查看稽核／非學生矩陣；Q-SCHOOL 與 T006／T007 原依賴未宣稱滿足，T008 未結案 |
| T012 | §32 新增 `packages/core/policy/logging.ts` 本機診斷日誌白名單 DTO／建構、可信 route ID 與 HTTP 碼設定及輸出形狀驗證；不含 Worker 或其他 producer／sink | T012 原依賴 T006、T007 不變且不宣稱滿足；audit 寫入、身分對照、完整錯誤碼登錄、服務整合、保存／輪替及整體去敏仍缺 |
| T015 | 既有 core／政策子集、§32 日誌及 §35～§36 runner 證據回歸保留；§37 本輪單元／契約 285／285、應用程式 DB 整合 29／29、原 SQL TAP 114／114，紅燈整體非零且清理完成，typecheck／build 成功 | 僅本輪本機授權測試子集；T015 原文列出的完整跨帳號／資料層、競態、費用與產品 gate 測試仍缺，日誌子集不代表全系統去敏 |
| T051／T050（§38） | [projects migration](../../supabase/migrations/0009_projects_stages.sql) 僅 projects；[唯讀模組](../../apps/web/src/server/projects.ts) 使用同 statement gate／RLS owner，明確白名單子集 DTO。新單元 40 項、專案 DB 整合 30／30；既有授權 29／29、pgTAP 61＋53，全體一般單元 325／325，型別／建置通過；正常及既有 NotOk 故障均撤銷 verified／清理 complete | T051 依 T050、T039 與所有適用前置保留且未宣稱滿足；尚無產品建立／更新／刪除、stage_records／tasks、人工批准、版本更新／衝突、教師查看稽核、真實 Auth／principal provider、HTTP／UI 或正式保存；任務未結案 |
| T095（前輪） | §30 建立本機 helper；§31 修復公開 A＋訪客識別需求誤放行，目標測試先有 3 項失敗，再 24／24 通過；完整測試 262／262、型別檢查及建置通過 | T095 原依賴 T091、T051 不因前輪變更而完成；服務資格判斷、可信事實來源、預覽／提交／重試／部署重驗仍待後續授權 |
| 其餘 T001～T136 | 有治理、研究及設計成果時以其既有章節／研究證據為準 | `tasks.md` 全部任務仍未勾選；存在局部成果不等於任務完整結案。沒有證據的項目不得推定已完成 |

## A｜本輪授權工作與可驗收產物

| 範圍 | 原任務 ID | 直接依賴／前置 | 驗收產物 |
| --- | --- | --- | --- |
| §55 方案 A 單批隔離研究（已停止） | T026 研究子集；T008／T015 僅案例依據 | 教育者本次明確 Gate 前研究例外；原任務／Q／Gate 依賴不變，不擴張為產品授權 | 專案外來源／Compose／schema、固定映像／設定、health 失敗與各次 setup 失敗、逐案 not_run、用量／清理／來源差異／manifest ZIP；失敗不能以清理成功沖銷，後續須另批 |
| §52 T054 F-01／F-02 最小修復（本輪） | T054；T050／T015 僅直接回歸；T006 僅結果／型別相容；T004 沿用本機工具 | T053 原依賴與所有任務依賴保留；136 項任務／依賴／勾選不變 | deferred-promise 紅綠回歸驗證切換取消／取代後舊回應只更新來源資源；既有 `stageDraftContentSchema` 嚴格拒絕非法 conflict 並保留本地／確認版本。測試與 build 結果、瀏覽器及截圖限制依 readiness §52；無 DB／server／runner／真實保存 |
| §50 T053 學生工作區唯讀合成展示（本輪） | T053；T050／T015 僅目標測試；T052／T051 僅型別使用；T006 client 型別邊界；T004 沿用 runner | T053→T052 及 T052／T051 原依賴保留，不宣稱依賴已滿足；136 項任務／依賴／勾選不變 | 專用 `/student/workspace-preview`、七頁籤、九階段唯讀資料、多種合成狀態及目標測試；無登入／真實資料／保存／server 接線／產品操作，完整 E2E 尚未完成；實測與 ZIP 見 readiness §50 |
| §42 方案 B F-01／遷移相容／隔離 DB 重驗（本輪） | T051／T050／T015／T006／T008／T095 僅本輪範圍；T004 runner 子集 | 原依賴完全保留；僅補 F-01、0009→0010 舊資料升級實測及既有方案 B DB 回歸缺陷，不擴大政策 | migration compatibility 15／15、identity/audit 61／61、account-gate 53／53、授權整合 29／29、projects／建立整合 72／72；目標測試 81／81、`npm test` 366／366、typecheck 及停用遙測 build 通過。NotOk／SqlError 皆實際進入注入並以預期 exit 1 攔截；撤權、catalog 還原與精確 labels 零殘留 verified。詳見 readiness §42；136 任務未變、不結案，完成即停止 |
| §41 方案 B 建立子集（歷史） | T051／T050／T015／T006／T008／T095 僅當時範圍；T004 runner 子集 | 原依賴完全保留；DB runner、授權／catalog／label 清理及 DB 故障回歸在當時因 daemon 不可用而 `not_run` | 已實作 migration、受控原子建立／冪等、相容讀取及資格關閉；單元／型別/build 通過；DB 實測當時未完成。其歷史狀態與封裝見 readiness §41；後續 §42 結果不覆寫當時狀態 |
| §40 初始化同步／分類提案（歷史） | T051／T050／T015／T006 部分；T008／T095 核對／回歸 | 原依賴完全保留；分類方案未批准 | 固定初始化已登錄並移除兩個缺漏；來源六問及兩案、推薦但未採用；歷史測試狀態依 §40.3。成功建立仍 blocked，不作本輪方案 B 證據 |
| §39 學生專案建立隔離本機子集 | T051 已明定驗證／拒絕；T050／T015 測試、T006 本機型別、T008 重用、T004 固定配置 | 原依賴 T050、T039 及其他適用前置全部保留；§39.2 初始化契約直接阻擋成功建立，不以其他 G0 項目停止已批准拒絕實作 | createOwnedProjectSubset 的 failed／denied／blocked 明確分離；35 新 DB 拒絕案例、369 單元與全部原回歸通過、完整去敏證據及複核 ZIP。成功建立／寫入原子性及讀回仍 blocked／not_run，不是 T051 完整結案 |
| §38 學生專案唯讀資料／擁有權 | T051 資料／獨立授權子集；T050／T015 僅測試；T008 重用／回歸；T004 固定配置 | T051 原依賴 T050、T039；T050 依 T015；T015／T008 的全部原依賴、Q-SCHOOL 與 Gate 保留，不宣稱滿足 | `npm run test:projects:db` 固定執行兩份 pgTAP、§37 授權整合及新 projects 整合；325 單元／30 專案 DB／29 授權 DB／61＋53 pgTAP、型別／build 通過。精確 DTO、無排序有界列表、失敗清理、來源與封裝見 readiness §38；不接產品 |
| §37 應用程式唯讀授權／本機 DB 整合 | T008 主要部分；T004／T006／T015 僅配置／型別／測試子集 | T008 原依賴 T006／T007 及 Q-SCHOOL 不變，其他任務依賴不變且不宣稱滿足 | 新 server 模組、測試專用 pg adapter 與固定 runner hook；單元 16 項、DB 整合 29／29、原 pgTAP 114／114；npm test 285／285，typecheck／build 成功。實際身分／資料界線、紅燈、去敏證據與清理見 readiness §37；不接產品入口 |
| §36 完整去敏 stdout 證據修復 | T004／T015（測試工具與證據子集）；T007／T008 僅既有回歸 | 原依賴及 Q-SCHOOL 全部保留；僅 §36 單輪有界授權 | 命令序號分檔的完整去敏 stdout／stderr、衍生 `.derived.tap`／摘要索引；正常 61／61、53／53；not ok／SQL error 非零、撤銷 verified／清理 complete；未知行仍拒絕、遮蔽逐字比對、寫入失敗非零及合成清理探針。`npm test` 269／269、型別檢查成功。寫入故障探針不是完整 Docker 磁碟故障清理證明；詳見 readiness §36，原任務不結案 |
| §34 已實測資料庫流程的可重跑 runner | T004（DB 配置子集）、T007／T008／T015（migration／SQL 測試子集） | T004 原依賴 T003；T007 原依賴 T004；T008 原依賴 T006／T007／Q-SCHOOL；T015 原依賴 T008、T010–T014；全部保留、不宣稱滿足 | `npm run test:db` 單入口；固定 Supabase PostgreSQL 17.6.1.167／pgTAP 1.3.3；正常兩檔 TAP 61／61、53／53；not ok、SQL error 故障注入非零並撤銷／清理；清理後重跑成功；快照比對及專案外證據見 readiness §35.2。T004／T007／T008／T015 其餘內容仍缺 |
| T007／T008 本機資料與授權子集 | T007（schema／RLS 部分）、T008（account-gate／教師關係部分）、T015（SQL 測試來源與執行部分） | T007 原依賴 T004；T008 原依賴 T006、T007 並有 Q-SCHOOL；T015 原依賴 T008、T010–T014。均原樣保留、不宣稱滿足；僅依 readiness-review §34 G0 前單輪明確授權 | `0001`／`0002` migration 成功；兩份 pgTAP 61／61、53／53，限定 Supabase PostgreSQL 映像層級；`npm test` 269／269、型別檢查成功。非完整 Supabase／Auth；不含 Route Handler、管理 RPC 或資源資料服務；依賴不變、任務未結案 |
| T012 診斷日誌白名單本機子集 | T012（純函式部分）、T006（DTO／型別驗證部分）、T015（合成測試部分） | T012 原依賴 T006、T007 保留且不宣稱滿足；本輪只依 readiness-review §32 的 G0 前有界授權 | `packages/core/policy/logging.ts`、必要的 `packages/core/index.ts` 匯出、`tests/contract/logging.test.ts` 及必要文件；僅診斷 DTO／投影／形狀驗證，不接 Worker、Web 或 sink；實際命令、基線比較與複核 ZIP 見 readiness §32 |
| T095 範圍矛盾修復子集 | T095（修復部分）、T091／T015（本輪合成測試部分） | 原 T095 依賴 T091、T051 原樣保留、均不宣稱已滿足；本輪只依 readiness-review §31 的 G0 前有界授權 | `packages/core/policy/work-eligibility.ts`、既有 `packages/core/index.ts`、`tests/contract/work-eligibility.test.ts`；修復前 24 項有 3 項重現失敗，修復後 24／24 通過；完整 `npm test` 262／262、`npm run typecheck`、`npm run build` 通過。來源雜湊與複核 ZIP 見 readiness §31.5 |

## B｜未來候選工作（尚未取得實作授權）

以下保留 Tasks Phase 原順序及 ID；「候選交付」描述可驗收產物，不等於教育者已批准階段或已滿足所有外部前置。

| Tasks 區塊 | 原任務 ID | 部分成果／尚缺 | 直接依賴與主要外部阻擋 | 階段可驗收產物（須另授權） |
| --- | --- | --- | --- | --- |
| Phase 1 Setup | T001–T005 | 有本機 npm／core／web／Vitest 骨架與 §35 DB 測試配置子集；缺全域 Gate／階段記錄、完整工作區工具鏈、環境變數範本及核准部署拓樸 | G0；T002 依 T001、T003 依 T001、T004 依 T003、T005 依 T002／T003；Q-HOST | 核准且可重現的完整 workspace／CI／瀏覽器／資料庫設定；不含真實密鑰 |
| Phase 2 Foundational | T006–T015 | 有局部 schema／純函式；§34 歷史、§35 runner 均完成 T007／T008 migration 與 PostgreSQL 層 pgTAP 子集；仍缺完整契約、HTTP、Worker、sink、works schemas 與整合測試 | 核心序列 T006／T007→T008／T009→T010～T014→T015；Q-SCHOOL、Q-BUDGET；T007 仍依 T004 | 完整共用契約、資料基礎與可跑的權限／失敗回歸；原已結案 SSE 子集不重做；本機 PostgreSQL 結果不等於完整 Supabase／Auth 通過；日誌 helper 不代替 producer／audit／sink |
| Phase 3 US1 註冊／批准／角色存取 | T016–T020 | 只有靜態角色骨架與局部純函式；無真實認證、管理員核發或持久化 | T015→T016→T017→T018→T019→T020；Q-AUTH | 合成契約測試、服務／介面及正式帳號狀態端到端證據 |
| Phase 4 US13 學校核准與學生 AI 閘門 | T021–T025 | 帳號政策有局部測試；無學校狀態資料／撤回停止工作流 | T015→T021→T022→T023→T024→T025，且 T023 依 T010；Q-SCHOOL | 四狀態、核准撤回／恢復的資料、工作流程與 E2E 證據 |
| Phase 5 US15 登入碼核發／重發 | T026–T030 | 無真實學生憑證生命週期產品；有 §55～§70 隔離研究與 §72／D-32 契約同步（非產品） | T015、T018、T022→T027／T028→T029→T030；Q-AUTH、S-03 需呈報教育者；T028～T030 直接受 A-9／供應商終結能力阻擋 | 憑證契約、**重發（依 D-32：平台交易、受控暫停、可信外部結果、向前恢復、最多一次秘密輸出機會）**、登入流程與錯誤狀態驗收。〔§74 更正：本列原寫「原子核發／重發」，不得解讀為跨 Auth／平台 DB 全面原子或恢復舊碼保證；M3 固定環境證據不等於產品採用或完整 session 驗收〕 |
| Phase 6 US17 內容安全／求助／值守 | T031–T037 | 僅有規劃；學生 AI 值守及安全服務未建置 | T015→T031→T032→T033→T034→T035→T036→T037；T033 另依 T012；Q-SAFE、Q-TL、Q-HOST | 合成安全案例、值守／升級處理、管理檢視及正式安全測試證據 |
| Phase 7 US2 首頁／Skills／直接對話入口 | T038–T041 | 有靜態頁骨架；無已取證 Skills 與服務整合 | T015→T038→T039→T040→T041；T040 依 T019／T024，T041 依 T049；Q-TL | 可追溯 Skills 目錄、入口流程與與對話 E2E 連通證據 |
| Phase 8 US3 對話／四工具／草稿 | T042–T049 | 只存在 core 本機骨架；無聊天、附件、Worker 或 AI 服務 | T015→T042→T043→T044→T045→T046／T047→T048→T049；T045 依 T033／T009，T049 依 T037；Q-DATA、Q-BUDGET、Q-TL、Q-SAFE、Q-HOST | 安全的四工具聊天／附件／草稿、狀態錯誤處理及端到端證據 |
| Phase 9 US4 創作引導／階段 | T050–T055 | 僅部分成果：T051 專案／需求／分類／階段草稿資料與唯讀工作區聚合、授權子集（§39～§46）；T052 創作旅程判斷與唯讀評估 server（§47～§49）；T053 唯讀工作區介面（§50）；T054 草稿保存控制器與隔離 PostgreSQL 整合（§51～§53）。缺 T050／T055 完整驗收、階段轉換、產品保存／登出恢復接線與 E2E，所有任務仍未勾選 | T015→T050→T051→T052→T053→T054→T055；T051 依 T039；Q-DATA | 階段轉換、保存／登出恢復及合成與 E2E 證據 |
| Phase 10 US5 IDE／Agent／X 與 A1 預覽 | T056–T066 | 本輪只補 T095 政策純函式；沒有 IDE、Agent、Sandbox、產物、A1 服務 | T015、T051／T055、T068／T070、T035、T095；依任務順序 T057→T058→T059→T060→T061→T062→T063→T065→T066；T064 另依 T035／T051／T068；Q-X20、Q-X21、Q-HOST、Q-A12223、Q-BROWSER | X 產物安全建置、A1 會話及撤銷、受授權 Agent／預覽 E2E；不以本機政策結果代替安全驗收 |
| Phase 11 US6 測試真實性／版本恢復 | T067–T070 | 無快照／版本資料層與 Worker 測試服務 | T015→T067→T068→T069→T070；T068 依 T051、T069 依 T058 | 可驗證測試、不可變快照／回復流程及 E2E 證據 |
| Phase 12 US8 教師檢視／回饋 | T071–T075 | 教師帳號層有 §28 子集；學生資源授權與回饋服務缺 | T015→T071→T072→T073→T074→T075；T072 依 T008／T051／T043、T074 依 T024；Q-DATA | 僅綁定學生的資源讀取、回饋保存與拒絕越權測試 |
| Phase 13 US9 管理中心／稽核 | T076–T079 | 靜態管理頁骨架；沒有後端管理／稽核 | T015→T076→T077→T078→T079；T077 依 T018／T022／T072，T078 依 T036 | 管理變更、稽核紀錄、保存重讀及拒絕越權證據 |
| Phase 14 US10 Skill 交接／續談 | T080–T083 | 無經核准 Skills 來源及交接保存流程 | T015→T080→T081→T082→T083；T081 依 T043／T045／T051／T039，T083 依 T049；Q-TL | 有來源的 Skill 交接、最小必要保存與跨流程 E2E 證據 |
| Phase 15 US7 提交審查／版本部署 | T084–T090 | 無正式申請、人工審查、X 部署或公開入口 | T015、T068／T072、T063、T060、T095、T099、T106；主序列 T084→T085→T086／T087→T088→T089→T090；Q-SCHOOL、Q-A12223、Q-X20、Q-HOST | 審查快照、人工核可、hash 重驗、失敗保舊版及停止／恢復驗收 |
| Phase 16 US14 A／合格 B／B2／作品範圍 | T091–T099 | 本輪 T095 局部純函式；缺完整 work-data 契約測試、資料服務／授權／路由／輪替／安全與 E2E | T091 依 T015；T092 依 T091／T063；T093→T094→T096；T095 原依賴 T091／T051；T097 依 T095／T039／T065；T098→T099；Q-B226、Q-B227、Q-DATA | B2 平台資料服務及逐請求授權、使用限制一致性、安全測試與殘餘風險證據 |
| Phase 17 US16 停用／恢復／清除 | T100–T106 | 無完整帳號資料層、清除／復原工作 | T015、T028／T077／T063／T085／T092；T100→T101→T102→T103→T104／T105→T106；Q-DATA、Q-HOST | 依核定保留／清除政策執行、失敗可見及復原 E2E 證據 |
| Phase 18 US11 用量／額度／預算 | T107–T113 | 平台已有研究／模型草案但無計量／結算服務，數值仍待決 | T015、T009→T107→T108→T109→T110→T111→T112→T113；T109 依 T010、T110 依 T077；Q-BUDGET | 費用預留／結算／對帳、限流與合成及正式核對證據 |
| Phase 19 US12 響應式／鍵盤／語言 | T114–T118 | 只有靜態骨架，無全流程互動／輔助技術驗收 | T015、T065／T048／T036／T086；T114→T115→T116→T117→T118；Q-BROWSER | 全流程鍵盤、IME、焦點、響應式與核定瀏覽器 E2E 證據 |
| Phase 20 US18 帳號／作品複查 | T119–T122 | 無請求資料層及複查流程 | T015、T101／T085；T119→T120→T121→T122；Q-DATA、Q-SCHOOL | 受限複查申請、狀態轉移、權限與 E2E 證據 |
| Phase 21 US19 個資請求受理 | T123–T126 | 無受理資料表、管理流程及資料生命週期整合 | T015、T102／T120／T122；T123→T124→T125→T126；Q-DATA | 受理、追蹤、處理／回覆及去識別合成資料驗收 |
| Phase 22 Polish／跨故事正式驗證 | T127–T136 | 四類正式產品驗證均未執行；沒有完整 MVP 供全域回歸 | T127～T131 各自依賴之前相關故事／Q／核定樣本；T132 依全部故事 E2E 與 T131；T133→T134→T135→T136；Q-BROWSER、Q-HOST、Q-A12223、Q-X20／21、Q-PEAK、Q-B226／227、Q-BUDGET、Q-TL、Q-DATA | 四類正式矩陣與全 MVP 回歸；T133 封存、T134 運維／清理、T135 Analyze、T136 人工產品／上線審閱，逐項依任務與 Gate 證據驗收；不自動批准上線 |

## C｜待補證／核定事項與原責任角色

本表只摘要責任，不改動決策登錄的決策效力、原 Q 時點或教育者核定權。角色沒有具名指派的，仍是「角色未具名」，不可假定有人已承接。

| 待辦／證據 | 原責任角色與時點 | 未完成時的影響／涉及任務 |
| --- | --- | --- |
| T1／Gate 前政策、原核定時點與各 Q 阻擋行為 | 教育者核定；App Planet 管理員依 readiness §16 統籌缺證；其他角色依各政策原責任提供材料 | Gate 未就緒，不啟動一般產品工作；T001–T002、全域 G0 |
| Q-AUTH、Q-SCHOOL | 身分／學校權責與教育者核定；具體責任角色尚待確認 | 登入、核發、學校閘門及相關 E2E 不得宣稱完成；T017–T030 等 |
| Q-TL／學生 AI 安全值守／Skill 來源 | 教育者／App Planet 管理員取得適用證據；技術、兒少安全與專業審閱者需由教育者確認 | 未成年學生 AI 上線條件及有來源 Skills 未就緒；T033、T037、T039、T045、T080–T083、T134 |
| Q-DATA／保存、清除、隱私與資料模型 | 平台技術負責人提出設計；App Planet 管理員彙整缺證；教育者／適用法務或學校權責核定 | 資料表、讀寫、清除及受限申請採 fail-closed；T043–T044、T051、T054、T072、T092、T101–T105、T120、T124–T126、T134 |
| Q-BUDGET | 平台／財務技術負責人提出計量、費用證據；教育者核定適用政策 | 未核定不得產生未知費用／啟用相關用量；T009、T108–T113、T130 |
| Q-SAFE、Q-HOST、Q-BROWSER | 安全／技術負責人提出證據；學校提供受管裝置資訊；教育者核定必要支援範圍 | AI 安全、主機／網域與 A1 瀏覽器條件未證實時維持關閉；T005、T033–T037、T058、T062、T066、T089、T127 |
| Q-X20／Q-X21 | X 技術負責人提出有證據的產物上限、建置及清理方案；教育者於 Gate 前核定 | 未核定不接受不合規產物、不啟用相關建置；T058–T060、T064、T089、T129 |
| Q-A12223（PP-22／23） | 平台／安全技術負責人提出期限與可證明的失效上界；教育者於 Gate 前核定，正式驗收再驗證 | 未核定不得簽發／續用或服務 A1 預覽；T061–T063、T087、T092、T128 |
| Q-B226／Q-B227（PP-26／27） | 平台技術負責人提出 Work Data API 配額；平台安全負責人提出 key id 輪替／緊急撤銷方案；教育者核定 | 未核定拒絕相關資料請求，未核定不得啟用寫入授權；T092–T099、T131 |
| Q-PEAK（PP-25） | 技術負責人依核准樣本量測冷暖／併發／費用；教育者核定門檻 | 只報量測、不宣稱可支援課堂尖峰；T129–T130、T133 |
| 學校、供應商／ZDR、正式環境、付費及法務／兒少安全證據 | App Planet 管理員統籌取證；學校、供應商、法務／專業角色及付款／資源操作人依原權責提供；教育者作範圍／上線決定 | 不建立供應商資源、不讀密鑰、不測真實學生資料；完整 Gate／上線保持未通過 |
| D-14、D-06 等既有待決狀態 | 依決策登錄各項原責任與時點；D-06 已核定的子集不可因歷史「待決」快照而忽略，也不可擴大批准範圍 | D-14／PP 相關未決政策不由本藍圖補定；D-06 已核定子集維持其明確邊界 |

## 整合、正式驗證與上線順序

1. **先補齊治理與前置**：完成仍未完成的 Tasks／Analyze，對照憲章與現行 Spec／Plan／契約／決策，補齊原時點需要的政策與外部證據；取得完整 MVP Readiness Gate 結論及教育者對具體階段的明確批准。單一子集或測試通過不能取代此門檻。
2. **再依原依賴建置共用基礎與故事**：以 T001–T015 為共用基礎，逐故事執行 T016–T126。實際拓撲必須遵從 `tasks.md` 的逐任務直接依賴及其跨故事表；例如 T057 等待 T068、T070 等待 T069、T066 等待 T070；T099 等待 T113，不能只按 Phase 編號直線執行。
3. **D-23 的 A1／B2／X 不可互換**：預覽授權、公開資料授權及 X 產物建置各按現行契約驗證；平台 Worker／Work Data API 不代表學生伺服器 runtime。公開 B 訪客識別限制不得被擴大成所有 A1 私人預覽限制。作品級別／範圍純函式不授予執行、資料讀寫或發布權。
4. **服務整合之後才做正式驗收**：完成故事功能與必要前置後，依 T127–T131 分別執行核准瀏覽器／A1 撤銷／尖峰與費用／B2 更新、逐請求拒絕、輪替及配額矩陣；必須保存核准樣本、門檻及去敏證據，不用合成測試、Spike 或建置成功代替。
5. **完整回歸與人工上線審閱**：再完成 T132 全故事整合、T133 證據封存、T134 運維與清理、T135 最新 Analyze 及 T136 教育者人工產品／上線審閱；T136 不是第二個 Readiness Gate，也不會自動批准上線。
6. **所有未核定／無證據路徑保持 fail-closed**：依原契約不建立或啟用被排除的 β2 學生伺服器執行、M／W、作品 runtime AI 或其他已明確不屬 MVP 的能力；不得用計畫文件或本機測試暗示正式服務已存在。

## 本輪與後續執行邊界

- **歷史 A（§30）** 當時只到本機政策函式／合成測試，非持續授權；§33～§36、§37各有不同隔離DB／授權整合歷史邊界。最新一次性現況為上方A｜§67（Auth RLS／reader診斷因工具檢查停止，根因未定位），不構成持續授權，不改產品來源或任務狀態；§65原始生命週期結果及§66失敗／登錄時序偏差／exit1／89與90離線差異／第二套not_run仍保留。
- **後續 B** 是依原 Tasks 尋求批准的候選範圍，不表示排定日期、人力、階段批准或可先行施工。
- **需核定 C** 依原責任補證；不得忽略 D-06 已核定子集，也不得擅自補定 D-14／PP。
- 正式登入、核發、學校核准操作、AI／Coding Agent、上傳、Sandbox、作品執行／部署、Work Data API 寫入、通知、付費及真實資料保存維持關閉，直至對應 Gate／階段批准與正式驗收條件均具備。
