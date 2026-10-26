# MVP Plan 定稿審閱 Checklist：AI APP 超級創客｜App Planet

**目的**：依文件證據審閱現行 MVP 的需求完整性、清晰度、一致性、可衡量性與追溯；不是產品測試、上線安全認證或 Gate 判定。
**建立日期**：2026-10-21
**功能**：[spec.md](../spec.md) 最新 MVP Session；[plan.md](../plan.md)「MVP 現行基線」。
**產生方式**：本次 `/speckit-checklist`，新增檔案，未覆蓋既有 checklist。
**深度／對象／時點**：標準深度、聚焦高影響範圍與證據界線；供教育者於 Plan 定稿前審閱。使用者已明確指定範圍，無需重問。
**本輪評估方式（D-23，2026-10-21）**：依使用者要求，逐項檢查本功能文件，只在文件本身已明確記載且跨文件一致時標 `[x]`。`[x]` 僅代表文件品質有可追溯證據，不代表教育者另行簽核、已實作、已測試、產品驗收、Plan 定稿、Checkpoint 或 Gate 通過。VC-1～VC-3 不重跑，亦不作為產品驗收證據。

## 需求完整性

- [x] CHK001 MVP 能做、不能做及可見限制是否完整涵蓋平台 AI、創作流程、A／合格 B、後續 β2、訪客識別與作品執行時 AI，且未將子集合冒稱完整 B 級？ [Completeness, Spec 最新 MVP Session／FR-048／049；Plan D-23]
- [x] CHK002 需學生伺服器程式的作品在藍圖、Agent、私人預覽、發布及指南中的限制說明是否齊全，並明確區分「可保存設計／檔案」與「不能執行／公開」？ [Coverage, UX §9.3；Spec US 14 情境 13／17]
- [x] CHK003 儲存、建置、取回、檢查、產物保存、版本綁定與重載的必要狀態及責任是否都有文件定義？ [Completeness, Plan D-23／X；data-model §4.4；publishing §3.6／3.7]

## 需求清晰度

- [x] CHK004 「採 X」是否明確排除沙箱預覽埠反向代理、HMR／WebSocket 與 MVP 學生伺服器執行，而不誤解為右側僅剩不可互動圖片？ [Clarity, Spec FR-010；UX §9.3；publishing §3.6／3.7]
- [x] CHK005 「已保存」「建置成功」「目前預覽版本」「審查批准」「部署成功」是否有互不混淆的定義？ [Clarity, Spec FR-010／013／024／026；UX §9.3／10]
- [x] CHK006 A1／B2／X 的批准範圍、主機名不授權、簽章金鑰隔離及 B2 殘餘風險是否清楚分開，且未暗示全部細節與數值均已批准？ [Clarity, Plan D-23；publishing §3.7]

## 跨文件一致性與歷史

- [x] CHK007 spec→UX→Plan→模型→契約→驗收是否一致採用 A／不需學生伺服器程式的合格 B，且 β2 不再是 MVP 開放或 Gate 條件？ [Consistency, Plan D-23；decision-register；quickstart V-28／V-47／V-55]
- [x] CHK008 原「首版 A／B 含 β2、單一 Gate」批准歷史與原編號是否保留，且被取代的適用範圍可辨識，不會誤讀為從未批准或仍須交付？ [Traceability, decision-register D-16／21／23；Plan Checkpoint]
- [x] CHK009 `student_server_runtime_not_in_mvp` 的適用性是否跨 UI、預覽與發布契約一致，並明確取代舊「首版內尚在驗證」暗示？ [Consistency, UX §9.3；projects E-3；publishing §1／6；data-model §5.4；quickstart V-28]
- [x] CHK010 平台 Work Data API 與後續 β2 執行資源是否分清，MVP 資料配額／保存／清除缺口未因 β2 移出而遺漏？ [Consistency, D-23／PP-26；data-model §5.4；publishing §3.3／3.7]

## 驗收品質與可衡量性

- [x] CHK011 產物型別、大小、檔數、壓縮／解壓限制、建置逾時與清理期限是否明列核定責任、時點與未核定時的 fail-closed，而非沿用 Spike 預設？ [Measurability, D-23／PP-20／21；publishing §3.6／3.7]
- [x] CHK012 預覽會話 TTL、撤銷失效上界與逐請求授權是否可客觀驗收，且明列待核定項、責任、時點與未核定行為？ [Measurability, D-23／PP-22／23；publishing §3.7；quickstart V-53／57]
- [x] CHK013 冷／暖與大小產物的端到端延遲、排隊、錯誤率及 20 人尖峰門檻是否明列核定安排，不把單一 p95 當全部體驗？ [Measurability, D-23／PP-25；quickstart V-56]
- [x] CHK014 A／合格 B 可公開、需訪客識別者被阻擋、需學生伺服器程式者於 MVP 零件執行／部署等判準，是否與 SC-016／AC-18 及對應情境一致？ [Acceptance Criteria, Spec SC-016／AC-18；quickstart V-28]

## 例外、恢復與邊界情境

- [x] CHK015 各建置階段失敗、沒有成功預覽、保留舊預覽、重試及亂序完成的需求是否齊全，且不允許假成功或倒蓋新版本？ [Coverage, Exception／Recovery, UX §9.3；data-model §4.4；V-56]
- [x] CHK016 建置沙箱清理與已保存產物授權撤銷是否分離，並涵蓋解除教師權限、停用、到期、審查結束及已載入內容不可收回？ [Edge Case, publishing §3.6／3.7；data-model §4.4]
- [x] CHK017 工作預覽、申請版審查預覽與公開版的版本／資料隔離要求是否完整，沒有因重建或重新開啟而汙染公開資料？ [Coverage, Spec FR-024／025；data-model §4.4／5.4；publishing §3.3／3.7]

## 非功能需求與證據界線

- [x] CHK018 VC-1 的未知路由限制、VC-2 本機 iframe／撤銷與 8 並行、大產物延遲，是否都被如實描述，未提升成正式預覽或課堂驗收通過？ [Assumption, research R-15；RESULTS-vc1-vc3 §2～3]
- [x] CHK019 M 約 7 秒新建 p95、試用 Team Hobby 級限額、跨專案共享控制面與 N=40 成本限制是否清楚，未宣稱可接受或代表付費 Pro？ [Clarity, research R-15；RESULTS-vc1-vc3 §4～5]
- [x] CHK020 β2／M／W 與 VC-3 stop、逾時及恢復研究是否明列為後續獨立 feature，而非 MVP 實作或 Gate 承諾？ [Consistency, research R-15；decision-register D-23]
- [x] CHK021 目標瀏覽器／版本、跨站儲存、無障礙錯誤提示與課堂尖峰的支援承諾是否明定核定責任及時點，未驗證版本不得宣稱支援？ [Non-Functional, D-23／PP-24／25；UX §9.3；quickstart V-53／56]

## 依賴、治理與未決事項

- [x] CHK022 MVP 的一個完整範圍 Gate 與後續 β2 的獨立 Gate 是否明確分開，且「任一 MVP 必要項未就緒＝整體不就緒」未被分範圍放行取代？ [Dependency, D-21／23；Plan MVP 現行基線]
- [x] CHK023 Plan 可提交審閱、Plan 已批准、Checkpoint、Readiness、實作授權與上線條件是否分別表達，無證據者未宣稱完成？ [Clarity, Plan 定稿與 Checkpoint 評估；D-23]
- [x] CHK024 學校證據、未成年人供應商條件／ZDR、法務／兒少保護／文案審閱、值守備援、政策數值與預算核定等未完成條件是否維持，沒有因限縮範圍而被勾銷？ [Dependency, D-14／18；Plan Readiness／上線條件；requirements checklist]

## 備註

- 本檔 24 項，皆完成文件證據重評；24 項均有直接文件證據支持其需求品質狀態。所有產品驗證仍未執行；未核定政策仍為 fail-closed。
- `/speckit-implement` 讀取 checklist 狀態但不得修改勾選；本輪未執行該流程。
- [requirements.md](./requirements.md) 有獨立內建生命週期；[plan-finalization.md](./plan-finalization.md) 的既有編號與勾選狀態保留。
- 本檔不構成 Plan 批准、Checkpoint／Gate 通過、實作或上線授權。
