# Specification Quality Checklist: AI APP 超級創客｜App Planet 平台首版

**Purpose**: Validate specification completeness and quality before proceeding to planning
**Created**: 2026-10-20
**Feature**: [spec.md](../spec.md)

> **2026-10-22 後續狀態（不改任何勾選）**：教育者已批准現行 MVP Technical Plan 作為設計與 Tasks 基線，見 [plan.md](../plan.md)「2026-10-22 教育者批准紀錄」及 [decision-register.md](../decision-register.md) D-24；先前「當時尚未批准／未執行 Tasks、Analyze」是保留的歷史快照。此次已起草 [tasks.md](../tasks.md)，並將 Analyze 的實際文件分析結果記於 [analysis-report.md](../analysis-report.md)。舊合併項「Plan 教育者審閱、Tasks、Analyze、Implementation Readiness Gate」維持未勾選：前三者有後續紀錄，**Checkpoint、Readiness Gate 仍未通過／未執行**。品質勾選不是產品驗收；產品測試尚未執行，政策數值未因此核定。

> **2026-10-21 最新 MVP 同步（僅文件）**：教育者已批准保留平台 AI、創作流程、A／不需學生伺服器程式的合格 B，採 X 產物式預覽；β2 公開執行移至後續獨立 feature／Gate，M／W 不實作。下方各輪「β2 首版維持／尚在驗證」與「首版 A／B 含 β2 的單一 Gate」是歷史判定，**已被本次範圍決定取代，不作現行未勾選理由**；其餘政策缺口、原編號與 `[x]`／`[ ]` 結果全部保留，**本輪不重新評分、不新增勾選**。X 正式授權撤銷／瀏覽器／課堂尖峰、MVP 配額／延遲門檻及既有政策數值仍未完成；VC 探針不代表產品達標、安全上線或 Gate 通過。現行需求品質另由 `/speckit-checklist` 審閱，以 [plan.md](../plan.md)「MVP 現行基線」追溯；較早紀錄中的 13/16 不作本輪統計，原表結果以磁碟最新勾選為準。

## Content Quality

- [x] No implementation details (languages, frameworks, APIs)
- [x] Focused on user value and business needs
- [x] Written for non-technical stakeholders
- [x] All mandatory sections completed

## Requirement Completeness

- [x] No [NEEDS CLARIFICATION] markers remain
- [ ] Requirements are testable and unambiguous
- [ ] Success criteria are measurable（**第九輪重新評估：由已勾選改為未勾選**。SC-001～024 多數已有 0／100% 的可計數敘述，但下列條文仍含**未定義的數值或時限**，不得僅以註記視為通過：SC-015、SC-020（下架／撤回「正式時限」，D-08 待核定）、SC-019（登入限速、碼長、效期）、SC-021（自動檢查準確度門檻、1 個值守小時須待值守時段核定）、SC-022、SC-024（處理與保存期限）、SC-023（額度、管理員測試額度、限流數量）。SC-017 現行版為可計數標準；待上列數值核定、各 SC 皆可獨立驗收後才可再勾選）
- [x] Success criteria are technology-agnostic (no implementation details)
- [x] All acceptance scenarios are defined（註，勾選不變：2026-10-21 範圍決定後，AC-19、AC-20 的公開 AI 部分與 US 14 情境 4～12、14 為**已被取代・首版不適用**之歷史；現行驗收為 US 14 情境 15～17、AC-27）
- [x] Edge cases are identified（註，勾選不變：2026-10-21 新增兩項邊界；原有公開 C 級相關邊界已加註歷史）
- [ ] Scope is clearly bounded
- [x] Dependencies and assumptions identified

## Feature Readiness

- [ ] All functional requirements have clear acceptance criteria
- [x] User scenarios cover primary flows
- [ ] Feature meets measurable outcomes defined in Success Criteria（**第九輪重新評估：由已勾選改為未勾選**。此項的字面意義是「功能已達成成功標準」：**尚未實作、尚未量測任何成果，因此無可驗收的達成證據**；且 SC-015、019～024 的數值／時限尚未核定，缺可驗收數值。先前加註「僅規格層級」不能使其視為通過。待實作且依核定數值完成驗證後才可勾選）
- [x] No implementation details leak into specification

## 首版範圍決定同步核對（2026-10-21；**僅文件層級**，不代表任何實作或實測）

> 以下勾選只代表「文件內容經本輪搜尋／腳本核對相符」；未勾選者為尚未取得、尚未執行或不在本輪核對範圍。

- [x] 首版範圍決定已寫入 spec.md canonical：Clarifications 最後一節（含 R1～R11）、FR-049（現行規則＋歷史原文）、US 14 情境 15～17、AC-27、SC-017 均查得（以 grep／檢視核對；僅文件）
- [x] 規格與契約已涵蓋「作品無執行時 AI 途徑」（**僅文件層級**）：spec.md FR-049、US 14 情境 16、AC-27；contracts/publishing-and-public-runtime.md §7（含 §3 CSP 與 §6 對照）、contracts/projects-agent-sandbox.md §3 與 §5 不變式。**環境未注入金鑰、出站被拒、審查退回、Agent 回應規則均尚未實作、尚未驗證**
- [ ] 作品無執行時 AI 途徑的實際驗證（預覽沙箱與公開環境環境變數無 AI 金鑰、對生成式 AI 服務出站被拒、含執行時 AI 呼叫的申請版審查退回且無法部署、Agent 對「讓作品呼叫 AI」的回應）：**尚未實作、尚未執行**
- [x] contracts/ 七個檔案已同步首版範圍（文件層級）：被取代章節（publishing §4～§5、ai-chat §6、公開 AI 池與每作品上限、公開 `public_ai` 狀態與訪客事件等）已標示「已被取代・首版不適用」並保留原文；新增現行規則（publishing §7、projects §3）；各檔頂端有同步註記。以關鍵字掃描（C 級、公開 AI、訪客、US$、Gateway、`public_ai`、`ai_state`）後逐行判讀：未標示者皆為現行一致文字或位於已標示章節內
- [x] 其餘文件（plan.md、data-model.md、research.md、quickstart.md、decision-register.md、product-decisions.md、ux-ui-design.md、docs/ 交付包）已同步首版範圍（**第九輪；文件層級**）：以人工閱讀本輪指定殘留點（見下一項），並以關鍵字掃描（`public_ai`、`public_c_ai`、公開池、公開 C 級、訪客事件／訪客 AI、5a／5b／5c、D-21、「理由未附」等）逐行判讀全部上列文件；未標示者皆為現行一致文字，或位於已標示「已被取代・首版不適用／歷史」的章節、刪除線或各輪歷史紀錄內（spec.md 早期 Clarifications Session 由檔內總註記涵蓋）。**這是人工閱讀與搜尋，不是自動化驗證**；契約所引用的 data-model §5.3、§6.4 與 quickstart 對應驗證步驟已核對更新
- [x] B 級 β2 受限伺服器端能力（FR-048、D-16）與 B 級訪客登入／帳號／蒐集可識別訪客資料之公開排除，於契約中維持不變（publishing §6、§7.7；文件層級）；**β2 的隔離與各項配額仍待驗證與核定**
- [x] 公開 AI 池（原規劃 US$150）與每作品上限於契約標示「原規劃、首版不動用」，不自動轉入創作池或基礎設施池；US$700 標示為原規劃總額、550 僅為審閱用算式（usage-and-budget.md；文件層級）。**月度總目標是否調整、模型與供應商單價、方案價格皆待核定／待複核**
- [x] 編號連續性（第九輪以腳本重新核對，僅文件）：spec.md 的 FR-001～056、US 1～19、SC-001～024、OD-01～015 無缺號，`NEEDS CLARIFICATION` 0 個，供應商／框架名稱僅「React」「Monaco」各 1 處（A 級定義舉例與修訂紀錄中的說明）；全部文件的 FR／SC／AC／OD 引用 0 個超出現有最大編號（FR-056、SC-024、AC-27、OD-15），quickstart 的 V-xx 引用最大 V-55、S-xx 最大 S-15；decision-register 範圍的 D-xx 引用最大 D-22（ux-ui-design.md 另有自有差異編號 D-23～D-28，與 decision-register 的 D-xx 為不同編號系統，plan.md 的 D-27 引用即指該文件）
- [x] 上線關卡未因取消學生 C 級作品而勾銷（文件層級）：spec.md R9 與各契約同步註記均未把下列事項寫成已符合
- [ ] 學校同意／告知證據：**尚未取得**
- [ ] 第三方 AI 供應商的未成年人服務條件：**尚未取得**
- [ ] 零資料保留（ZDR）適用性的啟用佐證：**尚未取得**
- [ ] 內容安全（含學生求助文案專業審閱）：**尚未完成**
- [ ] 值守與備援設定（值守時段、假日、交接、備援名單）：**尚未核定**
- [ ] 法務／契約審查與兒少保護專業審閱：**尚未執行**
- [ ] Plan 教育者審閱、Tasks、Analyze、Implementation Readiness Gate：**尚未執行**；Plan 仍待教育者審閱，不得視為已批准實作
- [x] 殘留逐點核對（第九輪；**僅文件層級**）：quickstart S-15、V-30、V-32～V-35、V-37、V-49；contracts/publishing-and-public-runtime.md X-1；data-model.md `public_ai_allowed`、`duty_gate('public_c_ai')`——逐點判定「原用途→首版是否適用→修訂→對應需求／驗收」，被取代者僅保留歷史、不是首版有效契約、可執行條件或 Gate 阻擋項；V-31、V-36 經核對為首版現行（plan.md P5 退出條件與 K-21 引用）。另修正 spec.md US 11 與 US 15 情境 11 殘留、data-model `no_admin_on_duty`、D-14 標題殘留
- [x] D-21 以「完整首版 A／B 範圍採單一 Readiness Gate」文件收斂（第九輪；**僅文件層級**）：不採 5a／5b 分別放行提案；**不表示 Gate 已執行或通過，也不表示任何實作範圍已獲批准**
- [x] 範圍變更理由以教育者原意記錄（第九輪；**僅文件層級**）：「平台仍提供 AI 輔助創作；首版學生只需建立 A／B 級作品，不需開發具有執行時 AI 功能的 C 級作品。」，未補寫其他動機
- [ ] 技術設計草案（`runtime_ai_review`、`tier_not_supported`、`runtime_ai_unsupported`、學生端說明、輔助掃描、V-51～V-55）：**教育者尚未逐項批准、尚未實作、尚未測試**；輔助掃描不能保證發現所有執行時 AI 呼叫
- [ ] 預覽頁瀏覽器端連線限制（等效 `connect-src`）：**技術設計已定（works-edge 預覽模式，publishing 契約 §3.1）、尚未實作、尚未驗證**（plan.md 重點設計摘要第 4 項、publishing 契約 §7.9、quickstart V-53）；**2026-10-21 定點修正補記**：共用 `works_csp_policy` 新增 `form-action 'self'`、`base-uri 'self'`（§3.2），Work Data API 定為同源 `/_work/data/v1/*`（§3.3）；「沙箱預覽埠不可被繞過」前提〔S-05、V-53(c)〕與上述各項驗證 V-53(e)～(i) 皆〔尚未實測〕，仍未勾選；**第九輪補記**：右側互動預覽改以 iframe 嵌入（`frame-ancestors`：公開＝`'none'`、預覽＝明確平台 origin），預覽會話改為不使用 cookie 的 `preview_id` 主機名機制（publishing 契約 §3.4），works-edge 信任邊界更正為「持專用 HMAC 金鑰、不持資料庫憑證與 AI 金鑰」（§3.5）；V-53(j)～(p) 皆〔尚未實測〕，目標瀏覽器清單尚未定義
- [ ] 成本推估實測重建與 B 級 β2 實際成本（S-04、S-13、S-15）：**尚未執行**；情境值仍為推估，高情境創作池 $720／$721 的取整差已說明（research.md R-09），未改任何價格

## Notes

- 驗證為 AI 自我審查（第 1 輪通過），不代表教育者已批准規格。
- 無 [NEEDS CLARIFICATION] 標記：使用者已明確列出的未定案項目（註冊／登入方法與同意流程、首位管理員、教師可見資料、綁定政策、額度、上傳限制、保存期限、作品受眾與下架、量化營運目標、Skills 指引來源）以 Assumptions 的「待決事項」OD-01–OD-07 記錄，需求以「依正式政策」表述，且不套用原型數值；請於 `/speckit-clarify` 逐項決定。
- FR-001–FR-034 沿用使用者正式編號；FR-035–FR-045 由帳號／權限／安全約束拆出，供追溯。AC-01–AC-15 於 Success Criteria 的對照表對應故事與需求。
- 成功標準 SC-001–SC-013 為行為性、可驗證標準；量化營運目標尚未定案（OD-06），未自行杜撰數值。
- 「RAE」依專案文件 UX-01 解讀為品牌字樣標誌；瀏覽器視覺驗證尚未執行。
- 本階段僅為規劃文件；未授權產品程式實作或付費資源。
- 第 2 輪修正後重新檢查（2026-10-20）：16/16 → 13/16。三項取消勾選：「Requirements are testable and unambiguous」（附件格式與大小、保存期限、下架時限、額度數值、重置時區尚未定案）、「Scope is clearly bounded」（無同意流程、教師可見完整對話、公開網址三項為待教育者批准的範圍／隱私決策）、「All functional requirements have clear acceptance criteria」（FR-005、FR-022、FR-030、FR-042、FR-043 缺可驗收數值或期限）。
- 決策建議整理（2026-10-20）：新增 `product-decisions.md`，並於 spec.md 補 OD-09（A/B/C 定義缺口）、OD-10（內容安全）；上列三項仍為未勾選，未重新評分；備註中的「OD-01–OD-07」現為 OD-01–OD-10。
- ⑤ UX/UI 同步（2026-10-20）：已新增 `ux-ui-design.md` 並將新增行為寫回 spec.md；新增 OD-08（使用指南內容待定）。上列三項勾選狀態不變（待決事項與三項待批准決策仍未解除）；本次未重新評分，亦不代表教育者批准。
- 第二輪規劃修正（2026-10-20，實際檢查結果）：依教育者指示修正八項（v5 A/B/C 定義、B/C 公開範圍拆為 PD-15、批准紀錄判讀、稽核識別性表述、申訴入口位置、停用與自動刪除拆為 PD-16、內容安全與求助、六階段與版本狀態）。spec.md 僅修改 Assumptions 與 OD-04、05、09、10，新增 OD-11、OD-12；**未改動任何 FR／US／AC／SC 文字與編號**。逐項重新核對後仍為 **13/16**，三項未勾選維持：「Requirements are testable and unambiguous」（數值與時限仍待定）、「Scope is clearly bounded」（三項待批准決策，加上 B/C 公開範圍 PD-15 與帳號生命週期 PD-16 待決）、「All functional requirements have clear acceptance criteria」（FR-005、022、030、042、043 仍缺可驗收數值或期限）。「A/B/C 無定義」缺口已由教育者提供的 v5 定義補上，但不足以令上述三項改為勾選，未為維持分數而調整任何項目。
- 先前批准的判讀：本機無批准紀錄檔，僅視為「先前批准尚未匯入本機佐證」；不推定其涵蓋後續新增政策，憲章採納日期維持 TODO。缺少佐證項目見 product-decisions.md PD-14。備註中的「OD-01–OD-07」現為 OD-01–OD-14。
- **第三輪批准同步（2026-10-20，實際檢查結果）**：教育者以「採用上述建議 批准首版排除」明確批准 PD-01 ①②③ 與 PD-15 範圍（僅限該範圍；本機無獨立批准檔，依交接指令轉錄）。spec.md 新增 FR-046～FR-050、US 13～14、AC-16～AC-20、SC-014～SC-017、OD-13～OD-14，修訂 FR-013、014、045 與 US 7、8；**既有編號未重編**。編號現況：FR-001～FR-050、US 1～14、AC-01～AC-20、SC-001～SC-017、OD-01～OD-14。逐項重新核對後仍為 **13/16**，三項未勾選維持，**未為提高分數而調整任何項目**：
  - 「Requirements are testable and unambiguous」維持未勾選：下架時限、公開 AI／預算的金額與限流、重置規則、附件限制、保存期限、額度數值等仍待核定；PD-01、PD-15 已決定，不代表這些數值也完成。
  - 「Scope is clearly bounded」維持未勾選：PD-01、PD-15 的範圍爭議已解除，但 PD-16（帳號停用與自動刪除）、PD-04（申訴入口是否納入首版）、PD-11（內容安全）與 OD-13（學校核准撤回連動、非 AI 功能是否受閘門影響）仍可能改變範圍或資料模型。
  - 「All functional requirements have clear acceptance criteria」維持未勾選：FR-005、022、030、042、043 仍缺數值或期限；新增 FR-046、047 的證據型態與撤回連動、FR-050 的數值、FR-013 的下架時限也尚未可完整驗收（FR-050 的停止／恢復行為已寫成可驗收規則，數值除外）。
  - 「Success criteria are measurable」維持勾選，但 SC-015（下架時限）、SC-017（數值門檻）須待核定後才能實際驗收，已於條文標註。其餘勾選項目經重新核對仍成立（新增內容未使用 [NEEDS CLARIFICATION]、未寫入供應商名稱或程式技術）。
- 憲章：核對憲章 IX「不得藉由分階段交付而**未經批准**縮減已核准需求」，已批准的 B 級首版排除不違反，憲章不修訂（版本 1.0.0；`RATIFICATION_DATE` 仍為 TODO，未補）。交付包第 80、372、503 行已加註已批准的例外。
- **第四輪六組決策同步（2026-10-21，實際檢查結果）**：教育者 2026-10-20～21 對 OD-13 學校核准、PD-03／PD-16、PD-07、PD-11、PD-04、PD-06／PD-12 逐項「採用」並補充（本機無獨立批准檔，依交接指令轉錄；PD-01、PD-15 原批准範圍不變）。spec.md **新增** FR-051～FR-055、US 15～18、AC-21～AC-25、SC-018～SC-023、OD-15，並於原編號內修訂 FR-030、035、042、045、046、047、049、050、US 11、13、OD-01、03、04、05、06、10、11、13、14；**既有編號未重編**。編號連續性已以腳本核對：FR-001～FR-055（55 項無缺號）、US 1～18、AC-01～AC-25、SC-001～SC-023、OD-01～OD-15；`NEEDS CLARIFICATION` 標記 0 個；spec.md 內未出現供應商或框架名稱。備註中的「OD-01–OD-07」現為 OD-01–OD-15。逐項重新核對後仍為 **13/16**，三項未勾選維持，**未為提高分數而調整任何項目**：
  - 「Requirements are testable and unambiguous」維持未勾選：下架時限、停用帳號檢視頻率與最長保留期限、主資料／備份清除天數、稽核保存期限、登入碼碼長與效期、登入限速、通知時限、複查處理與保存期限、個人每日額度／每作品上限／每分鐘請求數／並行數量、附件限制等仍待核定；六組決策已採用，不代表這些數值也完成。
  - 「Scope is clearly bounded」維持未勾選：原先阻擋此項的 PD-16、PD-04、PD-11 範圍問題已由教育者決定，但仍有明確未決的範圍問題——**學校核准撤回時既有非 AI 公開作品是否下架**（OD-13，不得以帳號停用規則推定）、「未確認／無紀錄／失效」狀態下非 AI 功能是否可用、公開 C 級作品訪客高風險輸入的處理（OD-10）、個資查閱／更正／刪除請求管道（OD-15，新增）、公開作品託管資源費用歸屬（OD-14）。
  - 「All functional requirements have clear acceptance criteria」維持未勾選：FR-005、022、042、043 仍缺數值或期限；新增 FR-051（碼長、效期、限速）、FR-052（天數、頻率）、FR-053（通知時限、通道）、FR-054（處理與保存時限）、FR-055（額度數量）的行為已寫成可驗收規則，但數值與時限待核定；FR-047 的「非 AI 公開作品是否下架」為未決，不納入驗收。
  - 「Success criteria are measurable」維持勾選，但 SC-015、SC-020（下架時限）、SC-017、SC-019、SC-023（數值待核定）須待核定後才能完整驗收；SC-021 的自動檢查準確度門檻未定義，不得據此宣稱無誤判。其餘勾選項目經重新核對仍成立。
  - 憲章：本輪決策與憲章無衝突（未涉及原則移除或重新定義），**不修訂憲章**（版本 1.0.0；`RATIFICATION_DATE` 仍為 TODO，未補）。
- **第五輪補充決策同步（2026-10-21，實際檢查結果）**：教育者 2026-10-21 明確採用八項補充決策（學校核准撤回／失效連動、學校未確認時學生不得登入、學生帳號停用的教師權限凍結與受限帳號複查、公開 C 級訪客高風險輸入、管理員付費 AI 依用途歸池、基礎設施費用歸池、個資請求受理管道、帳號刪除／恢復確認；本機無獨立批准檔，依交接指令轉錄；既有批准範圍不變）。spec.md 新增 FR-056、US 19、AC-26、SC-024，並於原編號內修訂 FR-014、015、035、036、042、046、047、049(e)、050、052、053、054、055、US 8、11、13～18、SC-014、018、020～023、OD-03、04、06、10、11、13、14、15；product-decisions.md 新增 PD-18；**既有編號未重編**。**已執行的核對（腳本與搜尋，僅文件）**：FR-001～FR-056（56 項，無缺號、無重複）、US 1～19、AC-01～AC-26、SC-001～SC-024、OD-01～OD-15 皆連續；四份文件中的 FR／US／AC／SC／OD 引用 0 個超出現有最大編號；`NEEDS CLARIFICATION` 標記 0 個；表格無被空行截斷（ux-ui-design.md 第 82 行為既有的兩個獨立表格）；已搜尋並加註先前「非 AI 公開作品是否下架」「向管理員反映」「設計建議（二次確認）」「管理員付費操作歸屬未明示」「託管費用歸屬」等舊表述，歷史文字保留。備註：先前第四輪備註寫「spec.md 內未出現供應商或框架名稱」並不精確——spec.md 的 A 級定義（教育者提供的 v5 定義）含一處「React」字樣，屬等級定義的舉例而非實作要求，本輪未新增任何供應商或框架名稱，該項勾選維持。備註中的「OD-01–OD-07」現為 OD-01–OD-15。逐項重新核對後仍為 **13/16**，三項未勾選維持，**未為提高分數而調整任何項目**：
  - 「Requirements are testable and unambiguous」維持未勾選：原有的數值與時限（下架時限、清除天數、保存期限、登入碼碼長與效期、登入限速、通知時限、複查與個資請求處理期限、個人每日額度／每作品上限／每分鐘請求數／並行數量、附件限制）仍待核定；本輪新增的待核定項目：核准有效期限與逾期判定方式、管理員測試額度數量與週期、停用時綁定紀錄保存期限、基礎設施池規劃值達到時的處置。八項決策已採用，不代表這些項目也完成。
  - 「Scope is clearly bounded」維持未勾選：本輪解決了「撤回後既有非 AI 公開作品是否下架」「未確認／失效狀態下的學生登入」「管理員付費 AI 歸池」「託管費用歸屬」「個資請求管道」「公開 C 級訪客高風險輸入的原則」；但仍有教育者尚未明示的範圍問題：撤回期間該校 C 級作品除 AI 以外的頁面是否維持公開、恢復後其 AI 是否須重新審查／部署、撤回期間待審與已批准未部署申請的處置、停止公開是否納入作品複查、未確認狀態下教師與管理員的使用範圍、帳號標記刪除後是否仍可複查、家長／監護人的個資請求途徑、其他非功能測試的管理員付費 AI 歸屬。
  - 「All functional requirements have clear acceptance criteria」維持未勾選：FR-005、022、042、043 仍缺數值或期限；FR-056 的行為已有 AC-26、SC-024，但處理與保存期限待核定；FR-047 的停止公開時限（OD-05）、FR-052 的天數與頻率、FR-053 的通知時限、FR-054 的處理時限、FR-055 的額度數量仍待核定。
  - 「Success criteria are measurable」維持勾選，但 SC-015、SC-018、SC-020（時限）、SC-017、SC-019、SC-023（數值）、SC-024（期限）須待核定後才能完整驗收；SC-021 的自動檢查準確度門檻未定義，不得據此宣稱無誤判。其餘勾選項目經重新核對仍成立。
  - 憲章：本輪決策與憲章無衝突，**不修訂憲章**（版本 1.0.0；`RATIFICATION_DATE` 仍為 TODO，未補）。交付包（docs/ 下的 Final Copy-Paste Pack）本輪不在同步範圍，未修改。
- **第六輪 Technical Plan 決定同步（2026-10-21，實際檢查結果）**：教育者逐項決定 Plan D-14（高風險事件通知通道與升級規則）、D-16（B 級完整首版功能目標），並對 D-12／D-17／D-19 作技術規劃決定（本機無獨立批准檔，依交接指令轉錄）。spec.md **僅於原編號內補充**：Clarifications 新增一節、FR-048、FR-053(d)(e)、US 14（情境 2 補充、新增情境 13）、US 17（情境 5 修訂、新增情境 10）、OD-09、OD-10、SC-021 備註；**未新增、未重編任何 FR／US／AC／SC／OD**。**已執行的核對（腳本與搜尋，僅文件）**：FR-001～FR-056（56 項）、US 1～19、AC-01～AC-26、SC-001～SC-024、OD-01～OD-15 皆連續且無缺號；各文件中的 FR／SC／OD／AC／US／PD／D／PP／K／S／V 引用 0 個超出現有定義範圍（decision-register 現有 D-01～D-21、PP-01～PP-19，plan K-01～K-19，quickstart S-01～S-15、V-01～V-47）；spec.md `NEEDS CLARIFICATION` 標記 0 個；本輪新增的 spec.md 文字未寫入供應商、框架或技術架構名稱（僅既有 A 級定義的「React」舉例）。逐項重新核對後仍為 **13/16**，三項未勾選維持，**未為提高分數而調整任何項目**：
  - 「Requirements are testable and unambiguous」維持未勾選：原有數值與時限仍待核定；本輪新增的待核定項目：學校處理時段／假日／窗口（FR-053 的「1 個處理時段小時」須待學校提供時段才可驗收）、「可接收」判定細則、原收件者為管理員時逾時的處置、B 級受限伺服器端能力的各項配額。教育者決定通道與升級規則，不代表這些項目也完成。
  - 「Scope is clearly bounded」維持未勾選：D-16 澄清了 B 級的功能目標與排除界線（排除僅限需訪客識別者），但該能力的可交付性尚未驗證，可能退回教育者作範圍決定；另 D-01／D-02（C 級作品在學校撤回／恢復的行為）、學校未確認狀態下教師／管理員範圍、帳號標記刪除後是否可複查等仍未決定。
  - 「All functional requirements have clear acceptance criteria」維持未勾選：FR-005、022、042、043 仍缺數值或期限；FR-053 的升級驗收依賴學校處理時段；FR-048 的 B 級資格驗收依賴未核定的配額；其餘期限／數量見第五輪。
  - 「Success criteria are measurable」維持勾選，但 SC-021 的通知時限驗收須待學校處理時段、SC-016 的 B 級驗收須待配額與能力驗證；其餘勾選項目經重新核對仍成立。
  - 憲章：本輪決策與憲章無衝突，**不修訂憲章**（版本 1.0.0；`RATIFICATION_DATE` 仍為 TODO，未補）。
- **第七輪 D-14 後續決定同步（2026-10-21，實際檢查結果）**：教育者對 D-14 作出取代同日先前「轉交學校／依學校處理時段計時」的最新決定（App 案件處理、值守方案 A、升級計時改依 App 值守時段；本機無獨立批准檔，依交接指令轉錄）。spec.md **僅於原編號內補充**：Clarifications 新增一節；FR-049(g)、FR-053(d)(e)(g)；US 14（新增情境 14）、US 17（引言與情境 5、10 加註，新增情境 11、12）；Edge Cases、Key Entities、SC-017、SC-021、OD-10 補充；**未新增、未重編任何 FR／US／AC／SC／OD**。**已執行的核對（腳本與搜尋，僅文件）**：FR-001～FR-056（56 項）、US 1～19、SC-001～SC-024、OD-01～OD-15、AC-01～AC-26 仍連續且無缺號；spec.md `NEEDS CLARIFICATION` 標記 0 個；本輪新增的 spec.md 文字未寫入供應商、框架、資料表或 API 名稱。**未執行**：瀏覽器與無障礙實測、任何自動化需求驗證、Tasks、Analyze、Implement。逐項依證據重新核對後仍為 **13/16**，三項未勾選維持，**未為提高分數而調整任何項目**，且**未新增任何勾選**：
  - 「Requirements are testable and unambiguous」維持未勾選：原有數值與時限仍待核定；本輪新增的待核定項目：**實際值守時段、假日、交接與備援名單**（FR-053 的「1 個值守小時」與 FR-049(g)、FR-053(g) 的開放條件須待值守設定核定才可驗收）、五類邊界情境（原收件者已是管理員、電郵失敗、值守交接、時段結束時在途請求、訪客事件逾時）的政策、「值守」是名冊指派或須實際簽到、教師與管理員測試是否受閘門限制。決策已作出，不代表這些項目也完成。
  - 「Scope is clearly bounded」維持未勾選：新增一項範圍問題——**值守限制使 C 級（及學生 AI）僅在值守時段可用，是否仍符合「完整首版」的 C 級交付定義，待教育者決定（decision-register.md D-22）**；另 D-01／D-02、學校未確認狀態下教師／管理員範圍、帳號標記刪除後是否可複查等原有未決仍在。本規格**不自行縮減**其他已批准能力。
  - 「All functional requirements have clear acceptance criteria」維持未勾選：FR-005、022、042、043 仍缺數值或期限；FR-053 的升級驗收原依賴學校處理時段、**現依賴尚未核定的 App 值守時段**；FR-049(g) 的可用性驗收同樣依賴值守設定；其餘期限／數量見先前各輪。
  - 「Success criteria are measurable」維持勾選，但 SC-017、SC-021 新增的「非值守時段 0 件新增請求通過」與「1 個值守小時」須待值守時段核定後才能完整驗收；SC-021 的準確度門檻仍未定義，不得據此宣稱無誤判。其餘勾選項目（含「Edge cases are identified」「All acceptance scenarios are defined」，已隨新增情境與邊界項目重新核對）仍成立。
  - 憲章：本輪決策與憲章無衝突，**不修訂憲章**（版本 1.0.0；`RATIFICATION_DATE` 仍為 TODO，未補）。憲章 IX（不得未經批准縮減已核准需求）：D-22 即為避免自行縮減而交教育者審閱。
- **第八輪首版範圍決定同步（2026-10-21，實際檢查結果，僅文件層級）**：教育者決定首版學生作品僅限 A／B 級、不開發 C 級作品，取代先前 PD-15／FR-049「受控公開 C 級作品 AI 為完整首版目標」的批准範圍（本機無獨立批准檔，依交接指令轉錄；理由未另附，本文件不編造動機，僅記錄可核對的效果）。**既有各輪備註（第三～第七輪）中涉及公開 C 級作品 AI、公開 AI 池、訪客高風險輸入、C 級值守、D-01／D-02／D-22／OD-10／OD-14 公開 C 級部分的敘述，一律保留為歷史，狀態為「已被取代・首版不適用」，不再是現行未勾選理由或驗收承諾；以本輪為準。** 本輪：（1）原 16 項勾選**未改變**（仍 **13/16**）；僅於「All acceptance scenarios are defined」「Edge cases are identified」「Success criteria are measurable」「Feature meets measurable outcomes」四項加註，**未新增也未取消任何原有勾選**；（2）新增「首版範圍決定同步核對」一節（文件層級），其中已勾 7 項（範圍已寫入 spec.md、規格／契約已涵蓋作品無執行時 AI 途徑〔僅文件〕、contracts 已同步、B 級 β2 與訪客識別排除維持、公開 AI 池不動用且不轉入他池、編號連續性、上線關卡未勾銷〔文件層級〕；皆為文件內容核對，無任何實作或實測），未勾選項為尚未實作／尚未執行／不在核對範圍者；（3）**未勾選維持的三項原有項目**，依證據重述現行理由：
  - 「Requirements are testable and unambiguous」維持未勾選：下架時限、清除天數、保存期限、登入碼碼長與效期、登入限速、通知時限、複查與個資請求處理期限、個人每日額度、每分鐘請求數、並行數量、附件限制、**實際值守時段與備援名單**、B 級 β2 各項配額、模型與供應商單價（待複核）、月度總目標是否調整仍待核定；**公開 AI 池金額、每作品上限、每訪客限流等數值已因範圍決定而不適用（歷史）**。
  - 「Scope is clearly bounded」維持未勾選：D-01／D-02（C 級作品於學校撤回／恢復）、D-22（值守對 C 級完整首版可用性）、OD-10 公開訪客部分、D-13／OD-14（公開 AI 與訪客個資）已因範圍決定**不再阻擋或結案**（保留為歷史／後續版本待決），**不計入現行未決**；但仍有：B 級 β2 的可交付性尚未驗證、學校未確認狀態下教師／管理員使用範圍、帳號標記刪除後是否可複查、家長／監護人個資請求途徑、創作池／基礎設施池／月度總目標是否調整、後續是否另立功能加入學生 C 級作品（本功能不承諾）。**此項理由取自先前各輪核對結果與 spec.md「本節仍未決」；本輪未對這些未決項逐項重新查證，故不改勾選。**
  - 「All functional requirements have clear acceptance criteria」維持未勾選：FR-005、022、042、043 仍缺數值或期限；FR-053 學生 AI 升級驗收依賴尚未核定的 App 值守時段；FR-048 的 B 級驗收依賴未核定配額；FR-049 現行規則已有驗收（US 14 情境 15～17、AC-27、SC-017），**FR-050 的公開 AI 池與每作品上限、FR-053(f) 為歷史、不再計入現行驗收**。
  - 「Success criteria are measurable」維持勾選：SC-017 改寫版為可計數標準；SC-021 的自動檢查準確度門檻仍未定義，不得據此宣稱無誤判；SC-015、018、020（時限）與 SC-019、023（數值）、SC-024（期限）仍待核定後才能完整驗收。
  - 憲章：此縮減為教育者明確批准的範圍變更，對憲章 IX 屬已經批准的縮減，**不修憲**（版本 1.0.0；`RATIFICATION_DATE` 仍為 TODO）。
- **本次驗證的範圍與限制（第八輪）**：**已執行**——以 grep／檢視核對 spec.md 的範圍決定相關段落存在；以腳本核對 spec.md 編號連續（FR 1～56、US 1～19、AC 1～27、SC 1～24、OD 1～15）、`NEEDS CLARIFICATION` 0 個、未出現供應商或框架名稱（僅既有 A 級定義的「React」舉例）；以關鍵字掃描與逐行判讀核對 contracts/ 七個檔案；以腳本核對上述兩份文件的引用編號未超出現有最大編號、粗體與刪除線成對。**未執行／限制**——未核對 plan.md、data-model.md、research.md、quickstart.md、decision-register.md、product-decisions.md、ux-ui-design.md 與 docs/（其他編輯者負責，待主編跨檔核對）；未重新評分第一～第七輪其餘未註記的 9 項已勾選項目的語意（僅以腳本抽驗：無 `NEEDS CLARIFICATION`、編號連續、未新增供應商或框架名稱，確認範圍決定未使其失效；這不是逐項重新審閱）；未進行瀏覽器與無障礙實測；未實作任何程式、未建立資源、未執行 Tasks／Analyze／Implement；**契約內容為設計層級文件，尚未實作、未驗證**；專業審閱（法務、兒少保護、文案）與學校證據皆未取得。
- 仍未執行：法規、學校契約、第三方 AI 供應商條件（含未成年人服務條件與零資料保留適用條件）審查；學校核准的實際證據；~~訪客輸入個資的處理方式（OD-14）~~（首版不適用，2026-10-21 範圍決定）；學生求助文案的專業審閱（~~訪客求助文案~~首版不適用）；身分驗證供應商對「帳號＋系統核發登入碼」的支援研究；初始規劃值（US$700 為原規劃總額，公開 AI 池 US$150 首版不動用；1 校 100 名學生）的驗證與供應商報價／硬性支出限制查證；瀏覽器與無障礙實測；Plan、Tasks、Analyze、Implementation Readiness Gate。本輪僅為文件同步。
- 仍未執行：法規、學校契約、第三方 AI 供應商條件（含未成年人服務條件、零資料保留適用條件）審查；瀏覽器與無障礙實測；Plan、Tasks、Analyze、Implementation Readiness Gate。本輪僅為文件同步。
- **第九輪重新評估與統計（2026-10-21，實際檢查結果，僅文件層級）**：先前各輪「13/16」是舊的原 16 項統計，**已被本輪取代，不得再用 13/16 代表已擴充的整份清單**。本輪逐項重評後：「Success criteria are measurable」與「Feature meets measurable outcomes」由已勾選改為**未勾選**（理由見各項；缺可驗收數值、且尚無任何實作成果，不能只靠「規格層級」註記視為通過）；其餘項目重評後維持，**未為提高比例而勾選任何項目**。**統計（分母／已勾選／未勾選）**：①原 16 項（Content Quality 4＋Requirement Completeness 8＋Feature Readiness 4）＝**16／11／5**（原 13／3 → 11／5）；②「首版範圍決定同步核對」節（第八輪起累計）原 16 項（7 勾選、9 未勾）→ 本輪因「其餘文件同步」由未勾改為已勾，並新增 6 項（3 已勾、3 未勾），現為 **22／11／11**；③**全表＝38／22／16**（本輪前為 32／20／12）。已勾選者皆僅代表文件層級核對；未勾選者為尚未取得、尚未執行、尚未核定或尚無可驗收數值。Plan 仍為草案、Checkpoint 未通過；未執行 Tasks、Analyze、Implement。
- **Plan 定稿前定點檢查（2026-10-21，唯讀核對；僅文件層級）**：重讀 plan.md、quickstart.md、publishing 契約 §3～§3.5、decision-register.md（D-21）、spec.md 編號與本檔；**未發現需修正的互相矛盾句子，未修改任何規劃文件**。腳本重新核對：spec.md 的 FR 1～56、SC 1～24、AC 1～27、OD 1～15 無缺號，`NEEDS CLARIFICATION` 0 個；本檔勾選統計仍為 **38／22／16**，**未新增、未取消任何勾選**。「works-edge 三把 HMAC 金鑰」在各檔計數一致；cookie 版預覽會話與「無憑證」說法僅以刪除線或撤回註記出現。**S-05、S-13、V-53（含 (n) 萬用字元網域與 TLS、(o) 目標瀏覽器清單〔尚未定義〕、(p) HMAC 輪替與外洩演練）皆〔尚未執行〕，上列未勾選項目維持未通過**。另新增 [plan-finalization.md](./plan-finalization.md)（31 項，全部未勾選，供教育者審閱預覽主機名會話、HMAC 信任邊界、驗證條件與狀態區分的需求品質）。「教育者已批准 Plan」「Checkpoint 已通過」「Readiness Gate 已通過」皆無批准紀錄，不宣告。
