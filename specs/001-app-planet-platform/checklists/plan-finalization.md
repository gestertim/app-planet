# Plan 定稿審閱 Checklist：AI APP 超級創客｜App Planet 平台首版

**目的**：保留 D-23 前既有 31 項審閱問題與狀態，供教育者了解歷史文件風險；現行 A1／B2／X 需求品質依 [mvp-plan.md](./mvp-plan.md) 評估。
**建立日期**：2026-10-21
**功能**：[spec.md](../spec.md)；主要依據 [plan.md](../plan.md)、[contracts/publishing-and-public-runtime.md](../contracts/publishing-and-public-runtime.md)、[quickstart.md](../quickstart.md)、[decision-register.md](../decision-register.md)

> **D-23 現行覆寫（2026-10-21）**：本檔 31 項與全部未勾選狀態是既有審閱快照，**不重編、不改勾**。原 CHK001／CHK007～015 對「無 cookie hostname 授權」及「works-edge 全域資料 HMAC」的問題前提，與 CHK016～019／022 的沙箱預覽埠、HMR／WebSocket、沙箱 TTL 及 β2 首版條件，均是歷史問題，已由 [plan.md](../plan.md) D-23、[publishing 契約 §3.7](../contracts/publishing-and-public-runtime.md) A1／B2／X 覆蓋；不得按舊前提實作。新現行範圍依 [mvp-plan.md](./mvp-plan.md) 重評。此表不代表實作、產品驗證或 Gate 通過。

### D-23 現行覆寫對照（不改動既有 CHK 勾選）

| 舊 checklist 前提 | 現行規則 |
| --- | --- |
| `preview_id` hostname 本身是預覽憑證、無 cookie | 歷史；A1 要求一次性權杖兌換，後續每請求驗證分區 Secure／HttpOnly／host-only cookie 與伺服端狀態；不支援時 fail-closed。 |
| works-edge 持全域作品資料 HMAC、可為任意作品簽章 | 歷史；B2 使用平台私鑰簽發單作品／用途／短效／撤銷版本授權，私鑰不在 works-edge；平台每請求重驗。保留 works-edge 遭入侵且持有多作品有效授權的殘餘風險。 |
| 沙箱預覽埠代理、HMR／WebSocket、以沙箱 TTL 決定預覽到期 | 歷史；X 為 `ports: []`→取回／檢查／保存不可變產物→iframe，「儲存→重建→重載」。 |
| β2／M／W 為 MVP 或 MVP Gate 要求 | 歷史；β2 學生伺服器公開執行另立 feature，M／W 不在 MVP 實作或 Gate。 |
| Spike 預設值可作產品政策 | 不採用；產物上限、建置逾時、TTL／撤銷上界、目標瀏覽器及 20 人尖峰門檻依 D-23／PP-20～PP-27 核定，未核定 fail-closed。 |

**清單來源**：本清單依功能脈絡與需求由 `/speckit-checklist` 產生。
**審閱責任**：本清單為審閱者持有的需求品質紀錄；只有審閱者確認需求品質條件滿足時才能標 `[x]`。
**勾選語意**：`[x]` 只代表需求品質已審閱且滿足，不代表實作完成。

**本檔狀態（2026-10-21）**：所有項目由 `/speckit-checklist` 產生，**一律未勾選**；勾選權屬教育者／審閱者。行尾「文件現況」僅記錄 2026-10-21 閱讀所見，**不是通過判定**，且**不代表任何驗證已執行**。S-05、V-53 均尚未執行；S-13 β2 研究亦尚未執行，但已移至後續 feature，非 MVP Gate。

## 預覽主機名會話（publishing §3.4）

- [ ] CHK001 「取得有效 `preview_id` 主機名者，可在會話有效期內存取預覽及其暫存資料」是否被明列為**需教育者接受的設計取捨**，而非隱含於設計中？ [Clarity, Contract publishing §3.4「安全性質與殘餘風險」] 〔文件現況：已列，並要求教育者於定稿審閱確認；尚未批准〕
- [ ] CHK002 會話到期、延長與撤銷的觸發條件是否完整列舉？ [Completeness, Contract publishing §3.4「過期與延長」「撤銷」]
- [ ] CHK003 會話絕對上限、短 TTL 快取與撤銷後內容失效的時間界線是否已有核定數值？ [Measurability, Gap] 〔文件現況：上限與 TTL 數值「待核定」；V-53(m) 只量測不核定〕
- [ ] CHK004 「已載入於瀏覽器的頁面內容無法遮斷」是否被明確記為已知限制而非隱含保證？ [Clarity, Contract publishing §3.4「撤銷」]
- [ ] CHK005 未知、未兌換、已過期、已撤銷四種狀態的回應是否要求不可區分？ [Consistency, Contract publishing §3.4「子資源與重新整理」；quickstart V-53(g)]
- [ ] CHK006 預覽資料集與公開資料集的隔離及「會話結束即清除」是否在契約、data-model 與 UX 提示需求之間一致？ [Consistency, Contract §3.3／§3.4；data-model §5.4]
- [ ] CHK007 「不使用任何 cookie」的現行設計與已撤回的 cookie 版本是否在所有文件中以刪除線或撤回註記區分，無殘留現行敘述？ [Consistency, Conflict check] 〔文件現況：2026-10-21 全檔搜尋未見現行殘留〕
- [ ] CHK008 日誌與稽核不得記錄明文 `preview_id`（僅記雜湊）的要求是否涵蓋應用日誌以外的紀錄面（如託管供應商存取日誌、SNI）之殘餘風險表述？ [Coverage, Contract §3.4]

## works-edge 信任邊界與 HMAC 金鑰（publishing §3、§3.5）

- [ ] CHK009 「works-edge 的作品資料 HMAC 金鑰若外洩，可能波及所有 live 作品資料集」是否被明列為**需教育者接受的設計取捨**？ [Clarity, Contract publishing §3、§3.3、§3.5] 〔文件現況：已列；尚未批准〕
- [ ] CHK010 三把 HMAC 金鑰（狀態、預覽、作品資料）各自的權限與外洩影響是否分別描述，且各文件的「三把」計數一致？ [Consistency, Contract §3.5；plan.md] 〔文件現況：2026-10-21 搜尋計數一致〕
- [ ] CHK011 works-edge「不持有」的憑證（資料庫憑證、AI 金鑰、session 密鑰、部署憑證）與「持有」的能力是否在契約、plan、data-model 之間用語一致，無「無憑證」現行敘述？ [Consistency, Conflict check]
- [ ] CHK012 平台端責任（逐請求重驗、受限 RPC、輪替、稽核、配額、重放防護）是否各有可驗收的需求，而非只有原則？ [Measurability, Contract §3.5]
- [ ] CHK013 金鑰輪替週期、時間戳容許窗口、nonce 是否採用，是否已有核定值或明確標為待核定？ [Gap] 〔文件現況：皆待核定／待 Tasks 評估〕
- [ ] CHK014 「works-edge 被入侵等同三把金鑰同時外洩」的情境是否有對應的偵測與回應需求（告警門檻、處置責任人）？ [Coverage, Exception Flow, Gap]
- [ ] CHK015 作品資料中訪客自由輸入可能含個資的風險，是否與 FR-048「不主動蒐集」一致地標註保存、清除與內容審核規則尚未定義？ [Assumption, Spec FR-048；Contract §3.3「待展開」]

## 尚未執行的驗證條件（一律保持未通過）

- [ ] CHK016 S-05（沙箱出站阻擋與預覽埠不可繞過）是否明載通過判準（任一可達即前提不成立）且標示〔尚未實測〕？ [Measurability, quickstart S-05；Contract §3.1] 〔S-05：尚未執行〕
- [ ] CHK017 S-13（B 級 β2 隔離、配額與成本）是否明載通過判準、需另行授權 `dev` 資源之前提，且標示尚未執行？ [Measurability, quickstart S-13；decision-register D-16] 〔S-13：尚未執行〕
- [ ] CHK018 V-53 子項 (a)～(p) 是否各有可判定的預期結果，且整列狀態標示〔尚未執行〕？ [Measurability, quickstart V-53] 〔V-53：尚未執行〕
- [ ] CHK019 「萬用字元網域與涵蓋它的 TLS」是否被列為設計前提與唯一阻擋點，並寫明不成立時「列差異交教育者決定、不自行替代」？ [Dependency, Contract §3.4；quickstart V-53(n)] 〔尚未驗證；供應商條件僅有文件查證〕
- [ ] CHK020 目標瀏覽器與版本清單的核定責任與時點是否明定（Tasks 階段可訂明，但 V-53 執行前必須核定）？ [Gap, quickstart V-53(o)] 〔文件現況：清單尚未定義；V-53(o) 寫「教育者或 Tasks 核定後逐一實測」，未獨立寫成 V-53 的前置阻擋條件〕
- [ ] CHK021 「未列入清單的瀏覽器不得宣稱支援」是否與 UX、spec 的支援承諾一致？ [Consistency, Gap]
- [ ] CHK022 預覽於跨站 iframe 內的 `localStorage`／IndexedDB、`window.open`、`alert` 行為差異，是否規定「只記錄、若阻斷已批准流程交教育者決定」？ [Edge Case, Contract §3.2；V-53(j)]
- [ ] CHK023 成本相關未核定項（月度總目標、模型與供應商單價、亞太區價格、β2 單位成本）是否持續標示待核定，未被寫成已核定？ [Assumption, plan.md；requirements.md] 〔S-04、S-13、S-15 尚未執行〕

## 範圍與單一 Readiness Gate 一致性

- [ ] CHK024 「平台提供 AI 輔助創作、學生作品僅 A／B 級、作品執行時零 AI 途徑」是否在 spec FR-049、US 14、AC-27、SC-017 與 plan、契約 §7 之間一致？ [Consistency, Spec FR-049]
- [ ] CHK025 B 級 β2 屬首版目標（D-16）與「β2 隔離與配額尚待 S-13 驗證」是否同時、無衝突地呈現？ [Consistency, decision-register D-16；Contract §6]
- [ ] CHK026 D-21「單一 Readiness Gate」是否明載「任一範圍未就緒＝整體不就緒」且不被理解為 Gate 已執行？ [Clarity, decision-register D-21]
- [ ] CHK027 被取代的公開 C 級 AI 條文是否一律標示「已被取代・首版不適用」並保留原文，未留現行驗收承諾？ [Consistency, Conflict check]
- [ ] CHK028 學校同意／告知、供應商未成年人條件、ZDR、內容安全專業審閱、值守與備援、法務審查等上線條件是否維持「尚未取得／尚未核定」，未因範圍縮減而勾銷？ [Dependency, decision-register D-18～D-20；requirements.md]

## 狀態區分

- [ ] CHK029 「可提交 Plan 定稿審閱」「教育者已批准 Plan」「Checkpoint 已通過」「Readiness Gate 已通過」四種狀態是否在文件中被明確區分，且後三者無批准紀錄時不被宣告通過？ [Clarity, plan.md「Plan 定稿與 Checkpoint 條件評估」；decision-register 第 35 行]
- [ ] CHK030 「教育者已答覆（T0）」是否與「已批准 Plan」「已批准實作階段」明確區分？ [Clarity, decision-register「重要區分」]
- [ ] CHK031 本機無獨立批准紀錄檔、決策皆為「依交接指令轉錄」的限制，是否在文件中如實揭露而未被當作批准證據？ [Assumption, Traceability]

## Notes

- Mark items `[x]` only after review confirms the requirement-quality criterion is satisfied
- Leave items unchecked when they still require clarification, correction, or reviewer evaluation
- `/speckit-implement` reads checklist checkbox state as a gate and must not modify markers
- `checklists/requirements.md` has a separate built-in lifecycle maintained by `/speckit-specify` and `/speckit-clarify`
- 本檔 31 項；含可追溯標記者 31 項（100%）。
- 本檔不構成教育者批准、Checkpoint 通過或 Readiness Gate 通過，也不代表任何技術驗證已執行。
