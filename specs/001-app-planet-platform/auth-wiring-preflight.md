# Auth／principal 接線前置核對與唯一最小批次

**最新一次性文件準備（2026-10-26；readiness §74／D-32研究附記，非啟用）**：[授權與基線](./readiness-review.md#74-2026-10-26-a-9-供應商詢證準備包必要政策裁決清單與原任務缺口更新一次性文件授權先登錄) 已先登錄；專案外[詢證草稿](../../../../AppPlanet-A9-VendorInquiry-20261026/vendor-inquiry-draft.md)（**未送出**；VQ-01～VQ-23，自訂policy／升級／版本映像另列、不混同操作終結）、[管理者一頁摘要](../../../../AppPlanet-A9-VendorInquiry-20261026/admin-one-page-summary.md)、[逐題回覆驗收表](../../../../AppPlanet-A9-VendorInquiry-20261026/response-acceptance-matrix.md)（供應商一般能力說明／具版本契約或技術證據／每次原操作可歸屬證據三層分開，收到回答前全部「未取得」）、[責任待填表](../../../../AppPlanet-A9-VendorInquiry-20261026/responsibility-fill-form.md)（全部「待管理者指定」）與[政策裁決清單](../../../../AppPlanet-A9-VendorInquiry-20261026/policy-decision-list.md)（建議未批准）。本節不新增證據，也不改變上段 §73 的接線前缺口：供應商終結能力證據**尚未取得**、實際詢證**尚未執行**；接線前仍須具名責任、政策裁決與供應商能力證據，缺證即維持不可啟用。D-32四原則維持已批准，M3仍只§70固定候選，不選M2、不擴M3、不接受殘留窗口；T028～T030直接受此阻擋，其餘任務依賴關係見[缺口更新](../../../../AppPlanet-A9-VendorInquiry-20261026/task-gap-update.md)。無接線、無服務、無聯絡供應商。

**上一次一次性文件盤點（2026-10-26；readiness §73／D-32研究附記，非啟用）**：[授權與基線](./readiness-review.md#73-2026-10-26-a-9-可恢復性證據與啟用設計缺口盤點一次性文件授權先登錄) 已先登錄；[主報告](../../../../AppPlanet-A9-Recoverability-20261026/report.md)、[證據矩陣](../../../../AppPlanet-A9-Recoverability-20261026/recoverability-evidence.md)、[全路徑／跨角色](../../../../AppPlanet-A9-Recoverability-20261026/trust-boundaries.md)、[最小恢復候選](../../../../AppPlanet-A9-Recoverability-20261026/recovery-design.md)、[責任／驗收計畫](../../../../AppPlanet-A9-Recoverability-20261026/operations-acceptance.md) 均在專案外。四項契約原則仍已批准，不重新待批；設計候選維持proposed，缺證分支blocked，不增政策決議或產品接線。

本批6／20次官方唯讀GET補到固定Auth v2.196.0的UpdatePassword、真正refresh service、Transaction、API及timeout middleware、refresh model，逐檔blob對已核tree；未取得完整依賴鏈／build provenance。timeout分支不等待handler完成，Transaction明列deadline／commit競態，故timeout／斷線／程序退出／lease／平台rollback／目前密碼可登入均不能單獨證明原操作未套用或不再晚寫。UpdatePassword(nil)刪session列不代表所有並行登入／refresh已終結；refresh CheckValidity呼叫點也不代表每條資料服務完整有效性。

接線前仍缺：可歸屬原操作的可信結果與terminal／無晚寫、相依在途終結、舊session全路徑資料阻擋、平台可靠完成、當下重新授權與門閂、具名主責／備援與正式驗收。供應商查詢／取消完成／冪等能力未建立，不斷言完全不存在；若不能提供或完整替代設計不能證明，unknown可能無法安全收斂並持續暫停。M3仍只§70固定候選，未產品採用／部署；不擴reader、不轉M2。

盤點包含登入／重登／refresh／登出／管理改碼、cookie／JWT／issuer／audience／key、PostgREST表與RPC、account／school／owner、service-role／直接DB／pool／claims、worker／委派／在途、Storage（私人bucket已規劃）、Realtime（teacher_notice可選方案，採用待決）、A1／B2與公開作品／恢復查詢。既有account gate沒有D-32 hold，測試syntheticContext不驗JWT，單hook不覆蓋其他服務。學生底線暫停已批；教師獨立檢視／管理員窄恢復／公開作品／跨角色細節仍待決，不偷換disabled或變更學校／師生關係。

**唯一推薦下一批**：管理者主導的供應商終結能力證據取得與必要政策裁決，先另獲教育者批准、責任具名及非秘密詢證／保存／交接安排；不直接接產品或自動執行隔離研究。後續依「證據與設計→必要政策裁決→另批研究／驗收→原治理Gate→明確階段實作批准→產品整合及正式驗收」。本批只四治理文件；產品／正式契約／tasks及歷史來源保護比較另附；產品test／typecheck／build／DB runner／流程模擬／故障注入／歷史研究回歸、供應商聯絡／commit／push／部署全not_run，服務啟動／帳號／服務HTTP0。G0／Checkpoint／完整MVP Gate未過，正式審議／簽核未完成，真實功能持續關閉；完成交付即停止。

> 以下 §72 與更早批次是各批歷史紀錄；其中官方GET0／缺底層等是當時範圍，不代表本批數量或宣稱本批已補齊所有證據。D-32四原則維持現行，新增設計未獲正式採用。

**2026-10-26 現行狀態（D-32／§72；四原則已批准、已同步，流程不可啟用）**：[readiness §72](./readiness-review.md#72-2026-10-26-a-9-已批准契約原則的正式文件同步一次性文件授權先登錄) 先登錄本 session 一次性正式文件授權；[D-32](./decision-register.md#d-32-a-9-已批准契約原則與必要正式文件同步2026-10-26台灣) 已正式取代跨 Auth／平台 DB 強回滾及所有失敗舊碼可用承諾。Auth 已確認套用只向前恢復；不存明文／可還原碼，同鍵當下重驗資格只回非秘密 receipt／狀態、不重播秘密、不再次執行 Auth；一次顯示最多一次伺服器秘密輸出機會，可能零次交付。unknown 不回成功、不保證舊碼可用，至少暫停目標學生身分的受保護資料、新產品登入與平台 refresh。無可審閱原操作 terminal 或不再可能寫入的可靠證據，不盲重發／解暫停；timeout／租約到期／DB generation／人工按鈕單獨不足。解除另須相依在途可信終結、舊 session 資料阻擋與平台完成證據；receipt 不授權。

**已同步不等於完成設計／實作／啟用**：七組必要正文已同步至 AUTH／COMMON／模型／驗收／spec／plan／治理，四原則不再全部列待批。M3 仍為固定環境 candidate_supported、adoption=not_approved，Auth custom policy 未獲正式部署批准；M2／hold／journal／dispatcher 未實作。供應商 terminal／取消／冪等與託管／升級支持、完整 session／全路徑可恢復性證據、具名主責／備援與支援安排、正式驗收仍缺；最終 schema／enum／欄位／API／HTTP／錯誤碼（舊 502 不涵蓋所有分支）、TTL／logout scope／最大撤銷時間／cache／在途與背景／跨角色／保存天數／恢復時限未核定。unknown 可長期不能安全收斂，不承諾自動恢復或未核定時限；未具名、未核定維持啟用阻擋。

保留 server＋session cookie 基線、教師／管理員原授權、核身／稽核、D-06(a)／M1／R-a、account／school／ownership gate。暫停不等於 disabled、不改學校或師生關係；最小狀態／恢復入口須當下合法授權。教師獨立合法檢視、公開作品、跨角色／委派／背景不足細節列待決，啟用前補全路徑設計，不自行擴權。下一批只提案：先補供應商／固定來源缺口與可恢復性設計、具名營運責任及正式驗收計畫，再另批有界研究；不能直接接線。136 任務及依賴／未勾選不變，無任務結案；產品 test／typecheck／build／DB runner／流程模擬／歷史回歸均 not_run，資源／帳號／服務 HTTP／官方下載皆0。G0／Checkpoint／完整 Gate 未過、正式審議／簽核未執行、真實功能關閉；封裝後停止。

> **以下 §71 及更早「最新／下一批」均為歷史快照**：「舊承諾有效／正文未改／全部待批」只描述當時，不再作 D-32 四原則的現行狀態；其候選證據與其餘缺證仍有效，不改寫歷史研究或失敗。

**最新文件收斂（2026-10-26；§71，未採用／未接線）**：[readiness §71](./readiness-review.md) 已先登錄本 session 教育者一次性「M3 導入前條件與 A-9 契約收斂」。[外部主報告](../../../../AppPlanet-M3-A9-20261026T123500-19d711b0/m3-adoption-prerequisites-review.md)、[session 條件矩陣](../../../../AppPlanet-M3-A9-20261026T123500-19d711b0/auth-session-condition-matrix.md)、[A-9 提案](../../../../AppPlanet-M3-A9-20261026T123500-19d711b0/a9-reissue-contract-proposal.md)、[唯一下一步](../../../../AppPlanet-M3-A9-20261026T123500-19d711b0/recommended-next-step.md)、[來源索引](../../../../AppPlanet-M3-A9-20261026T123500-19d711b0/evidence-source-index.md) 已分開既有實測、固定 tag 靜態查證與待決／缺證。12 份核心官方來源（含 tag tree）唯讀取得；GoTrue v2.196.0 的 Session.CheckValidity 與兩欄存在性不同，refresh wrapper 委派後的真正 service／UpdatePassword 底層／完整 migration 尚未取得，不假稱全部追完。託管文件明示 managed objects 可變，未取得支持本 custom policy／升級保留的證據；PostgreSQL 17／PostgREST v16 文件不是固定 binary 實測。M3 仍僅 §70 固定環境候選。

**本批唯一推薦是先裁決契約，不再重跑基本 policy 矩陣**：提案 A 為目標帳號受控 hold、journal／單一未結操作、Auth 結果 unknown 不盲重試、已確認套用後僅重試 DB finalize、同鍵只回非秘密 receipt／不重播碼；回應遺失後重新核身且原外部操作可信終結後才新受控重發。DB generation／fencing 不能取消在途 Auth；沒有 terminal／quiescence 證據就持續 hold、升級未具名管理者，不保證自動或限時恢復。hold／journal／dispatcher、完整入口與舊 session／並行登入／refresh 阻擋都只是新增待批設計，不是現有 M3 已提供，不偷換成 M2。AUTH A-9／§2、data-model §1.5、quickstart S-01-5、spec／plan／COMMON 正文未改、舊承諾仍有效；替換文字與時限／scope／TTL／cache／在途政策全部待決。

指定 §70 ZIP、manifest／CRC／逐檔／loose 相符，46 份 run 快照 hash 核對；policy 原始 CRLF 1285 bytes／591c5716… 與 run 相符，歷史 1252 bytes／84427018… 是 LF 正規化口徑，原始來源未改。專案 220 檔與 §70／§69 目錄 520／206 檔前後保護盤點；僅四治理可變，136 任務／依賴／未勾選與 Q-AUTH／Q-SCHOOL 不變。服務啟動／帳號建立／服務 HTTP＝0，官方唯讀 GET＝12；產品 test／typecheck／build、SQL／runner／離線回歸、服務探測／供應商聯絡皆 not_run。既定 server＋cookie、可信 principal／DB 交易與 pool／account／school／owner／所有可達路徑責任仍在，測試 context 絕非 provider。G0／Checkpoint／完整 Gate 未過、正式簽核未執行、真實功能關閉；封裝回報後停止。下方較早「最新／下一批」均保留為歷史，未構成後續授權。

**最新隔離研究（2026-10-26；§70，候選支持但未採用／未批准接線）**：[readiness §70](./readiness-review.md) 先登錄教育者一次性「M3＋單一最小Auth SELECT policy」及兩個暫撤故障、B.status回歸授權。只在外部 `C:\Users\geste\AppPlanet-M3-Policy-20261026T005800-7c2a904e` 建研究來源；原helper／hook／issuer getter／actor／owner／欄位grant不改，policy與§69草圖逐字相同。run `fd1b24a3e43f` N01～N10完成、真實exit0、candidate_supported／adoption=not_approved。baseline已知誤拒獨立列phase；candidate A1／A2／B1三路徑成功；原reader無外部session WHERE時各僅精確1列，10組SQL形狀／錯配負向零列，錯JSON22P02另列；三種研究簽發HTTP負向共9次由原hook403／42501拒絕，前後B1有效。SQL fixture不是驗簽、HTTP原helper拒絕不直接證明policy predicate已被走到；helper內角色依DEFINER語意推論而非直接監測。

A2目前refresh先成功且同sub／sid，原始access保留；local logout後A1、管理改碼後A2原access均兩輪三路徑拒絕，交錯其他／新session有效控制。兩個事件後目前refresh均400 refresh_token_not_found；舊碼400 invalid_credentials、新碼A3真登入成功。B.disabled仍session綁定／user200，rows200空集合、gate=false，actor成功不授資源權；approved COMMIT後B1原access恢復。暫DROP原helper=false／00000、獨立暫REVOKE兩欄42501，各rollback後catalog／B1三路徑恢復；最終撤policy並COMMIT後user仍200、資料全拒／reader零列，原hook不退issuer-only。正常candidate／故障／恢復／回退分開，不隱藏額外批准的狀態變動。

1／1stack、2／2建立、111／128HTTP、95.108秒、readiness23.333秒、峰值並行1；Mailpit三階段0，finally／獨立labels三類0、敏感暫存移除。語法與90＋22＋14離線通過，46份被測來源一致；啟動前兩項工具失敗、初始Git硬timeout程序偏差及實測後唯讀摘要錯誤均保留，非首次全綠。僅四治理文件變更，產品／既有來源／67歷史直接來源與136任務整檔／依賴／未勾選不變；產品test／typecheck／build／既有DB runner not_run。此結果不核定TTL／scope／最大撤銷窗口、不代表完整session有效性／S系列／供應商migration相容或M3產品採用；A-9跨Auth／DB回滾與response-loss、正式政策、在途／背景／其他服務、可信provider／BFF／cookie仍待另批。Q-AUTH／Q-SCHOOL、G0／Checkpoint／完整Gate未滿足，正式審議／簽核未執行，真實功能關閉；下方§69「待另批」為當時歷史，僅其限定研究已獲§70批准，產品採用仍未批准。

**最新文件比較（2026-10-26；§69，非實測／採用授權）**：[readiness §69](./readiness-review.md) 已先登錄教育者一次性「Session 阻擋方案有界設計比較與推薦」。外部主報告為 `C:\Users\geste\AppPlanet-Session-Options-20261026T003454-259f7360\session-blocking-options-review.md`。M2 沿 data-model §1.5 原定義＝登入時不可變的 session_id×student_credentials.version；M3＝原生 session 存在性（既有研究另核 sub 綁定）；C＝伺服器每請求 session 核對／可信 DB 交易責任，可配 A／B，不等同 M2。伺服器＋session cookie 為既定入口，不重開、不接產品；直接瀏覽器→PostgREST 未獲批准，不能僅因走 BFF 就推論其他可達路徑已封。

**下一批唯一推薦，仍待另批**：M3＋單一 `auth.sessions AS PERMISSIVE FOR SELECT TO session_guard_reader` policy，列範圍只限已驗簽 sub＋session_id 精確對應；保留原 reader 的 id／user_id 欄位 SELECT、非 owner／非 BYPASSRLS／無新增會員，原 helper／issuer-first hook 不改。policy 本身是新的 Auth 列可見性擴張，不是原設計已可用；DEFINER 中有效角色為 reader，policy 不能誤綁 authenticated；GUC 不是不可偽造憑證。套用／移除由既有受控 setup／表 owner 權限執行，不授 reader DDL。新 policy、敏感可見性、Auth migration 相容性與暫撤欄位讀權的故障研究均須另批；不以 owner／BYPASSRLS／額外欄位包裝為最小 policy。

推薦只驗固定環境真 Auth 正向、baseline／candidate 分開、三資料路徑、local logout／改碼後舊 access 拒絕與新／其他 session 可用、目前 refresh、predicate 負向、故障／恢復／drop-policy 拒絕與清理。預算**提案**為 1 stack／2 次合成帳號建立／128 全部 HTTP／20 分鐘、並行1／HTTP≤20秒／DB5000與1500ms，不是本批或下一批已可用額度。正常 candidate 前後有效控制失敗即 blocked；同交易暫撤權限只證 SQL 故障，不冒稱跨連線 HTTP。回退保留 session hook拒絕，不得回 issuer-only 資料放行；Storage／Realtime、完整有效性、pool／在途與完整 S 系列留後續。

M2 若後續研究，尚需不可變 binding／受控新登入 binder／操作 journal 與 fencing、精確權限／migration／清除方案；不能以舊 access 讀 current version 補成新 binding。A-9「外部 Auth 已成功但 DB 失敗仍整體回滾舊碼有效」及無可還原碼下 response-loss 一次顯示恢復存在具體契約衝突，已列待決，不修改 AUTH／data-model／quickstart 正文。兩機制均需獨立 account／school／owner gate、每請求權威與可信 principal、pool 清理及其他資料路徑覆蓋；不核定 cache TTL、殘留上界或在途政策。§65完整兩套raw run及§66連結的重算檔未含指定最新ZIP，該部分只沿用治理更正摘要，不聲稱本批逐案重算；§66／§68直接raw／來源與67份歷史直接來源hash已核對。

本批僅 T026 研究規劃與實際 T008／T011 信任邊界設計子集，只同步四治理文件；220檔專案修改前基線及歷史來源保護、治理原文／差異、主張索引／矩陣與ZIP見上述外部目錄。資源啟動／帳號建立／服務HTTP皆0；產品test／typecheck／build／既有DB runner／離線回歸、任何 SQL／policy／migration／Docker／Auth／DB實測、M2／M3實作、provider／BFF／cookie／HTTP／UI全部not_run。136任務ID／正文／依賴／全部未勾選、Q-AUTH／Q-SCHOOL不變。G0／Checkpoint／完整Gate未通過，正式審議／簽核未執行，真實功能關閉；下方§68及較早「最新」均保留歷史，封裝回報後停止。

**最新結果（2026-10-26；§68 四層補證完成，原 M3 仍不可用，未批准接線）**：[readiness §68](./readiness-review.md) 先登錄本輪一次性 T026／T008／T011 實際研究子集，再修專案外來源。修復完整 namespace／proname／identity argument types＋本 DB OID 定位、研究逐字來源及 Auth 初始化後基線分類；§67 原始失敗 catalog fixture、90／90 既有及22／22本批回歸與語法通過。舊 fixture 缺的 catalog metadata 明示補充來源／合成 OID，不冒稱舊批直接採得；新 live 直接取 catalog。uid 實存 setup、Auth readiness、研究安裝前、診斷前後五階段；初始化後四階段穩定，只定位差異階段，不歸因特定 migration 或宣稱語意等價。

run `890b6e214a9d` 的 A／B 均：控制角色確認精確 session／sub 綁定存在→同一 READ ONLY／REPEATABLE READ snapshot 原 reader SELECT成功零列／00000→research_rest 真認證依原會員切 authenticated 呼叫原 helper=false／00000→原 issuer-first session-hook 真實 HTTP rows／gate／actor全部403／42501 session rejected。Auth user及issuer-only正向／跨帳號匿名／actor非特權與INVOKER／錯issuer控制通過；token均有效。完整catalog前後相同：sessions RLS=true／FORCE=false、owner=research_auth、實查零policy，reader非owner／非BYPASSRLS、原欄位／schema讀權及會員不變。證據相互支持本固定設計因零適用policy的RLS預設拒絕而誤拒有效session；不是所有M3不可能或已找到無擴權修復。helper內部身分只由catalog／DEFINER語意推論，SQLclaims與HTTP不是同一通路／snapshot，不倒填§66／§67。

**診斷completed、原M3不可用、安全not_met、採用not_approved、真實process exit2**（啟動前已定義，非安全通過）。1／1stack、2／2建立、33／64HTTP、峰值並行1、首次資源至finally39.240秒、readiness22.607秒；Mailpit三階段均0。首次DB readiness exit2後間隔成功，非權限拒絕；finally down exit0、獨立labels三類各0、敏感暫存移除。41個啟動前被測來源與最後來源相同；220專案檔／85產品保護檔／67既有直接來源重盤點，僅四治理文件變更，136任務整檔／依賴／未勾選不變。產品test／typecheck／build／既有DB runner本輪not_run。後續僅提另批最小Auth policy風險／相容性／回退研究或M2設計，不改權限／新M3／M2或產品；下方較早「最新」保留歷史快照。G0／Checkpoint／完整Gate未過、正式簽核未執行、真實功能關閉，封裝回報後停止。

**最新補充（2026-10-25；§64一次性研究已停止，非接線批准）**：[readiness §64](./readiness-review.md) 已實測四角色及research_rest真認證可SET／SET LOCAL／set_config改寫app.expected_issuer（00000），即使catalog無SET權限；§63不可竄改主張由此更正，原歷史保留。SQL改寫／同hook失守不是已證明HTTP遠端可利用。研究修復為PostgREST未公開設定表＋最小NOLOGIN SELECT-only owner的固定search_path DEFINER getter；hook／actor維持INVOKER，不擴大資料權限。後兩套全新資源各50案改寫後正錯同hook驗證、49案修改路徑拒絕、4案fail-closed及完整issuer／actor／RLS／七寫入矩陣通過，實際exit0；第一套因setup session角色切換測試條件中止exit1並保留，補離線回歸至60/60。總3套、141 HTTP、6建立、保守記帳388.109秒，三次finally／獨立零殘留。產品來源及136任務不變；產品test／typecheck／build／既有DB runner not_run。產品採用、正式issuer／audience／key治理及任何接線仍須另批准；G0／Gate未過、正式簽核未執行、真實功能關閉。

**最新結果（2026-10-25；§61研究完成但安全未全通過）**：[readiness §61](./readiness-review.md#61-2026-10-25-jwtrls-研究工具修復實際-actor-驗證與原矩陣續測一次性隔離本機批次) 已先登錄本輪一次性授權。舊版actor gate／finalizer兩項直接紅燈重現，修正版41/41離線回歸通過；兩套全新資源實際HTTP actor、A／B預期owner／marker、跨帳號／匿名隔離與7項寫入升權拒絕／前後快照均通過。四類JWT中簽章竄改／錯audience／明確過期被拒，**錯issuer在正確簽章下兩次仍HTTP200取得A資料**，安全需求failed，不加BFF／hook掩蓋。每組前後有效控制均成功；2/3 stack、82/120 HTTP、4/6建立，首次啟動至最後清理123.037秒。兩次實際process exit2（研究完成但安全缺口）、finally與獨立labels零殘留；主機publishing仍未解決。136任務／原依賴／未結案及G0／Gate／正式簽核狀態不變，產品功能關閉，本批結束、不構成接線批准。

**歷史結果（2026-10-25；§60已停止，不倒填）**：[readiness §60.2](./readiness-review.md#602-實際結果缺口與停止2026-10-25額度用盡) 已觀察兩個合成 Auth 帳號真實建立／登入200及 JWT claims；三次 stack 啟動額度用盡，研究 schema／fixture 安裝後，錯誤的 setup actor 比對 gate 在資料 HTTP 前中止。PostgREST 實際 actor、RLS、寫入及 JWT 負向均未執行，不能稱安全通過；主機publishing缺口仍未修復。§54～§59 原結果保留歷史語境，無持續授權。

**歷史日期**：2026-10-25（+08:00）。**§60歷史結果（不是§61現況）**：§60 實際 Auth／PostgREST readiness 均成功；A／B 建立及真實登入各200，ID相符，觀察到 `HS256`／issuer／audience／300秒 TTL claims（解碼不等於驗簽）。共3/3 stack、18 HTTP、2建立請求，374.816秒至最後清理；研究schema與fixture成功。runner把setup控制連線 `session_user=supabase_admin` 誤判為 PostgREST actor 不符，尚未呼叫資料API／actor snapshot；因此RLS、寫入與JWT負向均`not_run`。finally清理零殘留，無第四次額度；主機publishing缺口仍未解決，詳§14。§54～§59及§7～§13原紀錄保留各自歷史；G0、Checkpoint／完整 MVP Readiness Gate 未通過、正式審議／簽核未執行；136 條任務／原依賴／未勾選狀態不變。

## 1. 結論與已決事項

**§61證據更新**：本機L1的真實Auth token→PostgREST actor→RLS已有兩套新資源正向／隔離證據，但錯issuer接受構成明確安全缺口；完整S-01～03、原生300秒生命週期、session撤銷、供應商環境及產品接線仍未驗證。下列各歷史列的「尚未執行」依其原時點保留，不以本輪局部成果倒填完整S系列。研究完成不是產品接線批准，不能因本輪actor／RLS通過便解除原有Gate。

**§54 當時唯一推薦：「方案 A 最小真實 Auth／JWT→RLS 隔離研究」**，原定只取得 S-01／S-03 局部原始證據，不直接寫產品 principal provider 或接學生保存。§55～§58 均已停止／清理；§58 另批改用容器內服務名稱、沒有主機 ports，三服務 readiness 200 不代表登入成功，也沒有修復 §57 的主機拒絕。後續診斷／續測仍需另批，不能把「映像已快取／容器 running／啟動 exit 0」當成完整研究通過。

| 層級 | 權威依據／目前可說的結論 | 不能外推 |
| --- | --- | --- |
| 已批准設計 | [D-19／D-24／D-07a](./decision-register.md)、[plan §2 學生登入](./plan.md)、[research R-01](./research.md)：Supabase Auth＋PostgreSQL；方案 A＝BFF 將 handle 對應不可投遞合成電郵，以系統核發登入碼作密碼；學生沒有電郵／電話／自設密碼欄位 | D-07a 只是附 S-01～03 條件的首選；不是登入、參數、資源或上線批准。D-24 後來批准設計／Tasks 基線，優先於舊段落「Plan 尚待批准」 |
| 已批准角色政策 | [AUTH §3a／§4](./contracts/auth-and-identity.md)、[D-06 最新批准列](./decision-register.md)：教師受限帳號準備 (a)、多校 M1、教師重發 R-a；管理員受控非公開 bootstrap；角色／綁定由管理員核定 | 舊 D-06「教師是否可登入未明示」是歷史，不能重新送選；M1 已有本機 schema，不代表管理操作或真實歸屬已建立 |
| 已有實測證據 | [readiness §34～§53](./readiness-review.md)、[授權整合來源](../../tests/integration/authorization.test.ts)、[控制器 DB 橋接](../../tests/integration/stage-draft-save-controller.test.ts)：真實 PostgreSQL actor、當下狀態／owner／RLS、版本／冪等／回滾及 pool 清理；§53 記有授權 29、Projects 203 等歷史結果 | 合成 Auth 列及可設定 claim 不驗簽、不簽發 session，不是 S-01～03。本輪未重跑，歷史計數不當本輪成果 |
| 已有公開文件／合成研究 | [O08／O09](./spikes/readiness-prep/official-sources.md)、[原始 results.json](./spikes/readiness-prep/results.json)、[study.mjs](./spikes/readiness-prep/study.mjs)：官方 forwarding／session 限制、離線 NAT 算例 | 原始結果明載無網路／帳戶／憑證、S 系列未通過；固定窗 20 對 30 的算例不等於 Auth 30 人登入 |
| 尚未執行 | [quickstart §1.1](./quickstart.md)：S-01～03；本機完整 Auth 實測、供應商 dev 與正式環境驗證均無可採用的通過證據 | 本機 PostgreSQL 映像含 auth schema，不表示已有 GoTrue／API／JWT 實測 |
| 歷史／未採用 | [research R-01](./research.md) B 自驗碼＋magiclink、C 第三方 IdP 只作 A 失敗後備選；D 匿名登入不適用。較早 β2／公開 C 級方案已移出本 MVP；[RA1](./readiness-review.md#122-條件式-ra1先學生登入-s-01s-03暫緩資源批准) 為未批准的供應商研究申請 | 本次本機研究不取代或自動批准 RA1；不重開供應商／MVP 選擇 |

**不需另做已決政策的選擇**：沿用 Supabase、方案 A、D-06 (a)／M1／R-a、管理員核定及學校 gate。M2／M3 仍只是待 S-03 比較的工程候選，不先定案。本機研究本身不需新產品政策；產品登入前仍需原有待核定政策，並非「沒有待決」。

## 2. S-01／S-02／S-03 原文與證據分層

以下五欄**逐字摘自 [quickstart §1](./quickstart.md)**，不是先前摘要的推測；逐子案例以同檔 §1.1 為準。

| 編號 | 目的 | 方法 | 成功條件 | 原時點／失敗處置 |
| --- | --- | --- | --- | --- |
| S-01 | 方案 A：合成電郵相容性＋重發後舊登入碼失效（合成資料；設計見 §1.1） | 在 `dev` 專案以管理 API 建立使用合成網域電郵的測試使用者並登入；重發後以舊碼登入 | 建立與登入成功；不寄出任何郵件；重發後舊碼 100% 失敗、新碼成功 | P1；若失敗→改用可行網域；仍失敗→提報方案 B／C（D-07a，交教育者重新決定） |
| S-02 | 方案 A：同校共用網路下的節流＋登入錯誤不洩漏帳號是否存在（合成資料；設計見 §1.1） | 驗證 `Sb-Forwarded-For` 啟用條件與效果；模擬 30 位同校 NAT 學生同時登入；量測未知帳號／錯誤碼／舊碼的回應差異 | 不因共用出口 IP 而互相被限速；BFF 節流（帳號×IP 雜湊）有效；各錯誤情境回應與耗時不可區分 | P1；PP-03 數值提案的依據 |
| S-03 | 方案 A：舊 access token／session 的資料層阻擋（停用、標記刪除、重發；合成資料；設計見 §1.1） | 登入→停用／標記刪除／重發→以**舊 access token** 呼叫各受保護端點與直接資料查詢；驗證 refresh | 停用／刪除：全部被 RLS／閘門拒絕，refresh 失敗；重發：舊 session 被拒，或如實回報殘留視窗 | P1（FR-038、SC-001） |

- **共同失敗分流原文**（quickstart §1.1）：「任一案失敗：先嘗試在方案 A 內修正（例如改用其他候選網域）；仍無法修正→**D-07a 重開，列出方案 B／C 與影響（research.md R-01）交教育者重新決定；不自行改採、不自行更換 Auth 供應商**」。
- S-01-1～5 還包含 `.invalid`／`.test`／`.example`、兩種格式正規化、handle 唯一對應及 Auth API／DB／冪等重送三中斷點。只改 Auth 密碼成功，不等於跨 Auth／DB 補償原子性通過。
- S-02-1～6 要新式 secret key＋啟用 forwarding（非 publishable／舊 anon／service_role）、高權限 client 不沿用使用者 session、30／30 NAT 在 60 秒成功、惡意輸錯不永久鎖定、HMAC 鍵；四類錯誤**各 ≥200 次**，本文／狀態／標頭一致，p50／p95 時差容許值須**執行前訂定**。未核定不得判通過；PP-03 建議 IP 每分鐘 20 次可能擋 30 人，須回報而非偷改。
- S-03-1～4 要 BFF、PostgREST／RPC、Storage 簽名 URL、採用時 Realtime 及 refresh；重發比較 M2（session_id×憑證版本）／M3（auth.sessions 存在性），測改密碼是否終止 session；10 分／5 分是研究候選，不是已核定 PP-04。

| 證據層 | 本輪狀態 | 可證明／必須保留的限制 |
| --- | --- | --- |
| L0 本機 PostgreSQL claim 測試 | 歷史已執行；本輪 `not_run` | 在測試指定主體下 DB policy／應用服務行為；不含 token 接受／驗簽／refresh |
| L1 隔離本機真實 Auth＋JWT＋資料 API | §55 已嘗試隔離 setup／啟動；health 失敗，登入與資料 API 案例 `not_run` | 尚無真實 create／password login／update／ban／refresh 或驗簽→RLS 證據；不等於產品 BFF／provider／Storage／Realtime，也不代表託管設定支援 |
| L2 供應商專用 dev | S-01～03 完整研究尚未執行 | quickstart 的原執行前置仍是另批供應商 dev；forwarding、金鑰種類、託管限流／郵件／session 設定需該環境證據，本機成功不能勾完 |
| L3 供應商正式環境＋產品路徑 | 尚未執行 | 另需批准的部署、設定、完整入口／各資料路徑、學校／帳號／運維及正式驗收；不要求下一批把全部 Gate 做完 |

## 3. 實際信任鏈與可沿用模組

```text
學生 handle＋登入碼／教職員 email＋password
  → [未有產品 BFF／Supabase cookie-session 驗證]
  → [未有產品「已驗證 principal」建構；不可只 decode JWT 或信 request body]
  → [未有產品可信 transaction provider；不可沿用任意 subject 的測試工廠]
  → 每次交易 SET LOCAL authenticated／主體（必須先驗證身分）
  → DB 當下 account_gate＋資源 owner／RLS＋受控寫入函式
  → 既有傳輸無關應用服務
  → [未有產品 HTTP／Server Action adapter]
  → [現有唯讀展示／記憶體保存模擬；不是產品保存 UI]
```

| 現存邊界 | 來源／可重用項目 | 仍缺 |
| --- | --- | --- |
| 授權介面 | [authorization.ts](../../apps/web/src/server/authorization.ts) `AuthorizationContext.runReadOnly`／`authorizeCapability`／`authorizeTeacherRelationship` | 介面假定 context 可信；TS 結構型別不是不可偽造的身分證明。結果 scope 只有帳號能力或關係 predicate，非資源權限 |
| 測試專用交易 | [authorization-context.ts](../../tests/integration/authorization-context.ts) `syntheticContext`／`syntheticCreationContext` | 直接 `set_config` sub／claims；無驗簽、session 或憑證版本驗證。**不得被產品匯入／直接改名當 provider** |
| actor／role／claim | [runner](../../scripts/pgtap-local.ps1)、[temporary-grants.sql](../../supabase/tests/harness/temporary-grants.sql)：測試 LOGIN `app_authorization_test`，非 superuser／owner／BYPASSRLS；控制連線為 fixture／migration；交易內 SET LOCAL ROLE authenticated、local claim | 產品連線擁有人、最小 grant、pool／失敗處理與驗證後綁定須另設計／測試；測試暫授不是正式產品權限。service_role／postgres 不能當應用 actor |
| 交易生命週期 | 測試唯讀 READ COMMITTED READ ONLY；寫入用 [ProjectCreationContext](../../apps/web/src/server/projects.ts) READ WRITE；COMMIT 後才回成功、ROLLBACK 或銷毀 socket、local claim 不外洩 | 可沿用契約與既有 pool-cleanliness 案例，不直接沿用測試任意主體入口；產品 provider 需驗證失敗零 SQL、跨請求交替、角色污染、連線／提交故障 |
| DB 當下政策 | [0002](../../supabase/migrations/0002_account_gate.sql)、[0009～0012](../../supabase/migrations/)：profile role／status／deletion_state、學校 gate、owner、受控寫入與冪等 replay 重新授權 | 0002 不檢查 session_id／憑證版本；重發後仍 approved 的舊 session 不能靠此自動拒絕 |
| 可沿用應用服務 | [projects.ts](../../apps/web/src/server/projects.ts)、[project-classification.ts](../../apps/web/src/server/project-classification.ts)、[stage-drafts.ts](../../apps/web/src/server/stage-drafts.ts)、[project-workspace.ts](../../apps/web/src/server/project-workspace.ts)、[creation-flow-assessment.ts](../../apps/web/src/server/creation-flow-assessment.ts) | 已有子集毋須重做；HTTP/session 邊界未接。confirmed／structural_only 不是身分、永久資格或下游批准 |
| 控制器橋接 | [§53 測試](../../tests/integration/stage-draft-save-controller.test.ts) 拆 strict body 與獨立 UUID key，經既有 server 真實保存 | 只在測試來源；[save-controller.ts](../../apps/web/src/components/project/save-controller.ts)／模擬頁不發真實保存請求 |

§37 建立授權介面；§38 唯讀 owner；§39 當時建立成功受契約缺漏阻擋；§40 先核初始化、§41 另批未分類建立、§42 修復及遷移相容；§43～44 需求／分類與回滾修復；§45 草稿；§46 聚合；§47～48 純評估／結構修復；§49 唯讀 DB 評估；§50 合成 UI；§51～52 控制器／修復；§53 測試橋接。**每節只擴張明列的本機子集，沒有任何一節批准真實產品 Auth 或 principal provider**。§39／§40 舊建立阻擋已被後續解決，不能拿來阻擋本次 Auth；同理後續 DB 通過也沒有解除 Auth 缺口。

## 4. 舊 session 必須分三層判讀

依 [AUTH §2](./contracts/auth-and-identity.md)、[LIFE §3～4](./contracts/access-and-lifecycle.md)、[FR-036／038／051／052](./spec.md)、[data-model §1.5](./data-model.md)：

| 事件 | Auth／token 本身 | DB 當下 gate／RLS | session／憑證版本額外條件與目前缺證 |
| --- | --- | --- | --- |
| 登出／撤銷 | A-3 撤銷目前 refresh token；官方舊 access token 可活到到期。Admin signOut 需要有效使用者 JWT，不能猜有按 user id 全撤銷 API | 若帳號狀態未變，現行 gate 不因 logout 而拒絕舊 JWT | 必測 refresh／session 撤銷與舊 access 各路徑，不以 refresh 失敗當作 JWT 立即失效 |
| 停用 | ban＋refresh 撤銷方式待 S-03；不可由 ban 成功推論所有 token 都不被接受 | status=disabled 後下一次受保護操作拒絕；歷史合成 DB 證據已有 | 尚缺真實舊 JWT 到 BFF／資料 API／Storage／採用時 Realtime，以及 refresh 實測；教師凍結快照／恢復不自動綁定另屬生命週期流程 |
| 標記刪除／清除失敗 | 尚缺真實 token／refresh 行為 | deletion_state 從 marked 起拒絕，purging／purge_failed 不恢復權限；還原須先套 tombstone | 不等於 Auth user 立即物理刪除；不為研究開啟產品刪除或還原程序 |
| 角色改變／綁定結束 | 有效舊 JWT 可能仍被 Auth 接受，JWT 中 role／school 不是產品權限依據 | 每次查 DB role／有效綁定；學生變教師／管理員不能沿用保存權；已結束 binding 不得新查看 | 歷史測試有不同角色、偽造 claim 及 ended binding；**不能宣稱真實登入期間動態降權全路徑已測** |
| 重發 | 管理端改密碼令舊碼失效不代表舊 access／refresh 全撤銷 | 帳號仍 approved，現行 gate 沒有憑證版本判斷，可能繼續允許 | M2／M3 待測，未選定／未實作；若無法拒絕須量殘留窗口，交教育者決定是否接受，不暗認 PP-04＝10 分 |
| 學校撤回／失效 | 學生按既定規則仍可登入 | 自有非 AI 內容仍可讀編輯；AI／新部署拒絕；unconfirmed 則學生不得登入 | 不把撤回當停用或當全面登出；真實學校核驗／操作仍未開放 |

## 5. 直接 Auth 前置表（不搬入整份 Gate）

**分類只代表補齊方法，不代表已獲執行批准**：A＝有依據可由後續工程完成；B＝另批隔離本機 Auth 實測；C＝教育者／管理者／外部責任人補決策或證據。每列最後一欄區分下一研究批次與產品接線。

| 分類／原 ID | 權威來源與目前狀態 | 已有證據／適用限制 | 真正缺少產物 | 隔離本機／合成可完成？ | 需資源／密鑰／政策／責任人 | 對下一批的直接影響 |
| --- | --- | --- | --- | --- | --- | --- |
| A1 T008；依 T006／T007、Q-SCHOOL | [COMMON 驗證](./contracts/README.md)、[§37](./readiness-review.md)、現存 context 介面 | DB 身分下的服務已測；主體仍合成 | 驗證 session→principal 的 server-only 模組、可信 RO／RW provider、最小產品 DB actor／grant、pool／故障測試；principal 不接受 body owner／role | provider 工程及拒絕測試可本機；須先有 B1 真實 token 證據；產品部署不可只靠合成 | 後續工程批准；將來管理者安全供給產品 Auth／DB 設定，不由 agent 取密鑰 | 不把此工程包入下一研究；研究結果決定版本／session 驗證所需欄位 |
| A2 T011；依 T006／T008／T009 | [tasks](./tasks.md)、[COMMON](./contracts/README.md) | strict body／UUID、版本／replay 子集已存在，無 HTTP | cookie-session 邊界、CSRF／來源防護、401／403／404 安全映射、problem+json、If-Match／狀態／冪等接線與測試；檢查 T009 適用部分 | 可本機工程／合成；產品仍需真實 principal | 另批工程、正式 cookie／origin 設定 | 不是下一研究的依賴，不需為測 JWT 就建立產品 HTTP／UI |
| A3 T016～T020；依鏈 T015→T016→T017→T018→T019→T020 | [AUTH A-2～4／§4](./contracts/auth-and-identity.md)、[tasks](./tasks.md) | 靜態角色殼／合成狀態與 DB 拒絕；無真實 staff auth | 狀態×角色測試、教職員 auth／me、受控 bootstrap／批准稽核、受限畫面／E2E | 可做本機工程子集；註冊／重設仍有 C3 | Q-AUTH、D-20／D-17；管理者核定角色與首位管理員 | 不因學生研究順便做 staff／bootstrap；研究帳號不是產品管理員 |
| A4 T027／T028；依 T026＋T018＋T022，T028→T027 | [AUTH A-5～9](./contracts/auth-and-identity.md)、[data-model §1.5](./data-model.md) | 只有資料模型／設計，不是憑證服務 | handle 對應、批准／首次領取、Auth×DB 補償／冪等、重發／session 版本／節流與稽核 | 可研究局部，完整產品還需 B／C、T018／T022 適用依賴 | 原 Q-AUTH、管理／學校流程及另批工程 | 研究不建立 `0006_student_credentials.sql`，不繞依賴先上核發 |
| B1 T026；依 T015、Q-AUTH；S-01 局部／S-03 局部 | [quickstart §1.1](./quickstart.md)、[R-01](./research.md) | 只有官方條件與 L0 DB；真實 Auth `not_run` | GoTrue 真實 create／login／改密碼／ban／refresh、JWT 驗簽→PostgREST RLS 原始去敏證據與舊 token 殘留 | **可作下一最小批次**；工具／映像已在，不代表 stack 互通已驗 | 只需另批本機研究／臨時研究 secrets；無雲端／付款／產品政策 | 先縮小最關鍵的不確定性；不結案 S-01／S-03 或 T026 |
| B2 S-01-2～5／T026～T028 | [quickstart](./quickstart.md)、[AUTH 重發原子性](./contracts/auth-and-identity.md) | 候選格式／唯一性／補償設計，未測 Auth×DB | 研究 BFF／handle mapping、兩格式正規化、一次顯示、三中斷點／同鍵重送 | 可另批局部研究；不能以裸改密碼代替 | 研究程式批准；產品格式／交付／期限另屬 C1 | 不塞進 B1；B1 若舊碼不能失效即阻擋後續，失敗依 A 內修正流程 |
| B3 S-03 M2／M3；T008／T028 | [data-model §1.5](./data-model.md)、[AUTH §2.5](./contracts/auth-and-identity.md) | account gate 不查憑證版本；候選未決 | session_id 實際來源／存在性、版本綁定、每次拒絕與失效競態研究；再對 BFF／Storage／Realtime 補測 | 候選局部可；託管可讀性與全路徑須 L2／產品證據 | 另批研究；若殘留不能消除，由教育者接受或拒絕 | B1 只觀察原生行為，不先選 M2／M3 或修改既有 RLS |
| C1 Q-AUTH；D-07b～e／PP-02～04；S-02 | [decision-register](./decision-register.md)、[quickstart §1.1](./quickstart.md) | 建議而非核定；L1 算例顯示 20 次桶與 30 NAT 衝突 | 碼格式／效期／首次交付／期限、節流與 session 政策；S-02 執行前時差門檻；完整 NAT／防列舉證據後提案 | 可本機比較候選，不可自行核定；託管 forwarding 不能由本機替代 | 教育者／技術負責人；供應商 dev 啟用新 secret forwarding 由管理者 | **不阻擋只測 primitive 的 B1**；阻擋產品登入／完整 S-02 判通過 |
| C2 Q-SCHOOL；D-03～06；T022～T025；T008 | [tasks Q](./tasks.md)、[D-06 最新批准](./decision-register.md)、[LIFE](./contracts/access-and-lifecycle.md) | D-06 (a)／M1／R-a 已定；D-03～05 與剩餘教師／管理員分支未全定 | 適用校級操作／期限／複查政策、withdrawn／expired 教師核發／領碼、完整非學生矩陣等仍待；handle／note_for_user、管理員過期補發未定 | 既定學生四校態可合成；未決分支只能拒絕 | 教育者；正式核准文件由學校／管理者提供核驗 | 不阻擋 B1 合成學生政策測試；不開學校操作或重問 D-06 已決部分；保留 T008 前置 |
| C3 D-20／D-17；Q-AUTH；T017～T019 | [D-20](./decision-register.md)、[R-01 教職員](./research.md) | 電郵＋密碼與 bootstrap 方向已定；註冊欄位／重設、SMTP 未定 | 欄位／重設政策、郵件服務選定／投遞及適用條款證據 | Mailpit 可驗本機不外寄；不證正式 SMTP | 教育者／營運／郵件資源擁有人 | 不阻擋 B1；Coding Agent 不創建首位正式管理員、不登入成人信箱 |
| C4 S-01～03 完整 dev；RA1／D-17／D-18 | [quickstart 前置](./quickstart.md)、[readiness §12.2／§16.3](./readiness-review.md) | 官網 O08／O09 不證本專案已啟用；RA1 費用總上界／角色證據仍缺 | 專用 dev 的核准、擁有人／備援／最小執行權、適用方案／設定、secret key 安全供給、完整費用停止線與清理／對帳證據 | **不可用本機取代**；也不是 B1 必需 | 成人資源／付款管理者、教育者、供應商支援；agent 不代取帳戶／密鑰 | 不為 B1 建 dev；若後續申請完整 S 系列須補此列，不能借既有雲端資源 |
| C5 FR-045～047／Q-SCHOOL、適用 Q-TL | [spec](./spec.md)、[LIFE L-1～3](./contracts/access-and-lifecycle.md) | 平台不收個別家長同意，僅校級狀態／版本；真實證據未取得 | 正式學校同意／必要告知（含教師可見範圍與資料庫／託管兒童資料處理）、管理者人工核驗；真實帳號批准 | 合成可驗拒絕；不可代造真實文件／核准 | 學校窗口、管理者、教育者／法務 | 不阻擋 B1；阻擋「可由真實登入學生使用」。AI 專屬 ZDR／值守仍關閉，但不列為本批非 AI 研究的新阻擋 |

T029 依 T028，T030 依 T029 且有 Q-AUTH；T027 另依 T018／T022，不因編號連續或 T051 本機服務可用而直接開工。T015 及完整 Phase 原依賴保留；B1 若獲准，只是明確研究例外，不是宣稱任務依賴已滿足。Q-DATA／保存期限仍未核定，阻擋正式保存開放，但不要求這一研究批次先完成全部資料治理／AI／預覽／部署 Gate。

## 6. 唯讀工具與隔離盤點（本輪實際觀察）

- `Get-Command`：Node／npm／Docker／Supabase CLI／Git／PowerShell 可用；主機 `psql` 不存在（未安裝）。Node `v24.19.0`、npm `11.11.0`、Docker `29.7.2`、Compose `v5.3.1`、Supabase CLI `2.117.0`；`docker info --format '{{.ServerVersion}}'` 成功，daemon 可回應。
- `docker image ls`／僅針對四個已知 tag 的 `image inspect`：本機已有 PostgreSQL `17.6.1.167`、GoTrue `v2.196.0`、PostgREST `v16.1`、Mailpit `v1.30.2`。digest 留在複核包盤點 JSON；另一版 GoTrue 也存在，不能隨意混用。只讀映像 metadata，沒有下載或啟動。
- `supabase init/start/stop/status --help` 只讀命令說明，**沒有執行 init／start／status／stop**。CLI 印出可更新版本提示；未更新，未登入或查詢任何帳戶／專案。不得執行 `status` 輸出本機 keys 或用 `stop --all`。
- 專案沒有 `supabase\config.toml`；[現有 Compose](../../supabase/pgtap.local.compose.yml) 只有 DB，不能直接拿來測 Auth。產品 manifests／lockfile 沒有 Supabase SDK／SSR 套件；[Next 設定](../../apps/web/next.config.ts) 不是 Auth 接線設定。
- **可行性結論**：具備隔離真實 Auth 研究的工具與快取素材；Compose、版本互通、mail capture、研究 schema／角色與 JWT 設定**尚未建立／驗證**。不是「完整 Auth stack 已驗證可用」。下一批需自行限於 loopback／獨立 internal network、唯一 labels／volume／port，任何映像或必要能力不足即停，不自行下載／安裝或改用雲端。

## 7. 唯一推薦批次的可審閱執行草案（本輪不執行）

### 7.1 目標、邊界與待批資源

**目標**：取得真實 Auth 簽發／驗簽與舊碼、舊 access／refresh 在原生 Auth／研究 RLS 下的分層證據，為日後 T008 provider 及 T028 session 機制提供依據。只對應 **T026 研究腳本子集、S-01-1／4、S-03 原生生命週期與直接資料路徑子集**；T008／T015 只作研究案例依據，不接現存產品服務。S-01-2（兩完整格式）／3／5、S-02 全部、S-03 全路徑／M2／M3 比較仍 `not_run`。

**預計檔案**（僅未來批准後建立，現在不存在）：專案外唯一 scratch 目錄中的 `compose.auth-research.yml`、`auth-research.mjs`、`research-schema.sql`、`run-local-auth.ps1`；另更新本前置文件／readiness 結果。不改產品、測試框架／現有 runner、migration／權限、package manifests、控制器或服務。Node 既有 `fetch`／`crypto` 足夠研究呼叫，不先安裝 SDK。研究 schema 可複製既定 gate 語意並標記來源 hash，不改原 SQL；研究 DB role 不是產品 grant。

**依賴與隔離**：沿用 D-07a／AUTH／COMMON／現有 gate 已決語意；取得單批 Gate 前研究例外。四個已快取固定 digest 映像＋獨立 internal Docker network、命名 volume、未占用的 `127.0.0.1` API／Mailpit ports；DB 只在該 network、不對主機發布。資料 API 驗簽角色限 authenticated；admin Auth／DB 控制連線只研究 setup／狀態變更，不能當學生正向測試。禁止 host network、Docker socket 掛載、外部 SMTP、外寄郵件、雲端及產品資料。

**需另批准的精確動作**：建立上述研究檔與研究 schema／RLS／actor；啟動／健康檢查／呼叫並清理該批容器、network、volume；只在記憶體／受 ACL 保護的暫存設定產生本機一次性 keys／碼／tokens（不讀現有 `.env` 或產品 secrets、不把值寫日誌／命令參數／ZIP）；以研究 TTL **300 秒**觀察到期（非 PP-04 政策）。建議操作上限：45 分鐘、最多 6 個存活合成帳號、Auth＋資料請求合計 ≤200、並行 ≤2、單次 timeout 30 秒、不自動重試；達任一上限即停新請求。這些全是**待批准研究上限**，不是本輪已授權資源。

### 7.2 命令框架與先後步驟

下列為後續 runner 應實現的命令框架，**不宣稱不存在的檔案已可執行**。先審核研究檔／設定及 cleanup，再執行。`$work` 是專案外新建的明確目錄，`$project` 是本輪唯一 `appplanet-authresearch-<隨機runid>`；不得指向產品或別人的 Compose。全部 native 命令須檢查 exit code，失敗仍進 finally 清理。

```powershell
# 僅未來另批後；先建立並審核 research compose／runner／schema。
$compose = Join-Path $work 'compose.auth-research.yml'
docker compose -p $project -f $compose config --quiet
# 不印完整 config（可能展開研究 secrets）；先逐一核對本機 image digest。
# config 非零即停；此時尚未建立資源。
if ($LASTEXITCODE -ne 0) { throw '研究設定未通過。' }
# runner 先驗 loopback ports／獨立 network／volume／labels／禁止掛載／無外寄。
$caseFailed = $false
$cleanupFailed = $false
try {
    docker compose -p $project -f $compose up -d --pull never --wait --wait-timeout 120
    if ($LASTEXITCODE -ne 0) { throw '研究 stack 未健康。' }
    # runner 先做健康／actor／驗簽／mail 預檢，不輸出敏感本文。
    node (Join-Path $work 'auth-research.mjs')
    if ($LASTEXITCODE -ne 0) { throw '研究案例失敗。' }
} catch {
    $caseFailed = $true
    Write-Error '研究失敗；依 case ID 查看去敏結果。' -ErrorAction Continue
} finally {
    # 包含啟動一半的失敗；不使用 --all／prune／--rmi。
    docker compose -p $project -f $compose down --volumes --remove-orphans
    if ($LASTEXITCODE -ne 0) { $cleanupFailed = $true }
    $containers = @(docker ps -aq --filter "label=com.docker.compose.project=$project")
    if ($LASTEXITCODE -ne 0 -or $containers.Count -ne 0) { $cleanupFailed = $true }
    $volumes = @(docker volume ls -q --filter "label=com.docker.compose.project=$project")
    if ($LASTEXITCODE -ne 0 -or $volumes.Count -ne 0) { $cleanupFailed = $true }
    $networks = @(docker network ls -q --filter "label=com.docker.compose.project=$project")
    if ($LASTEXITCODE -ne 0 -or $networks.Count -ne 0) { $cleanupFailed = $true }
    # 另以 runner 驗 listeners 釋放並銷毀本批暫存 secrets。
}
if ($caseFailed -or $cleanupFailed) { throw '研究或清理未通過，不得報成功。' }
```

1. 保存研究來源 hash、工具／固定 digest、設定的**非秘密**白名單與 case matrix。若版本不相容、缺映像、bound address 不是 loopback 或發現外寄／非預期掛載，停止，不自行安裝、pull 或接其他資源。GoTrue／PostgREST 使用同批驗簽設定及正確 issuer／audience；研究 runner 不以自行 decode／手塞 claim 代替真實 token。
2. Admin API 建立隨機 uuid 合成電郵，依序試保留網域 `.invalid`／`.test`／`.example`，`email_confirm:true`，研究固定格式隨機碼，不設真實 SMTP。正向測試由 password login 取得真實 access／refresh；只在記憶體留存，去敏結果記 case ID／HTTP 狀態／布林斷言／耗時，不輸出識別值。Mailpit 觀察寄信事件 **0**；外網被隔離只是另一防線，不能以「沒有送達真信箱」冒充「沒有寄信事件」。
3. PostgREST 以真實 bearer token 驗簽→研究 `auth.uid()`／當下 gate／owner RLS，學生 A 可讀自身合成列、學生 B 及匿名不可讀；無權限資料依 RLS 可為空集合，與預期 HTTP 拒絕分開斷言。篡改簽章、錯 issuer／audience、過期及匿名不得取得 protected data；正向讀必須先成立，避免全拒絕的假通過。研究管理查詢只看觀察快照，不代替 token 路徑。
4. 分開建立各事件的 session A（避免 refresh rotation 互相污染）：(a) logout／撤銷目前 refresh；(b) ban＋研究 profile disabled；(c) 標記刪除＋ban；(d) 管理端改碼 A→B；(e) profile role student→teacher。分別記錄 Auth 接受舊 access 與否、舊 refresh 結果、原 access 走資料 API 的可見列／gate。Auth「仍接受 token」不是測試框架成功或失敗的替身，需和 DB 拒絕分開記錄；refresh 只嘗試該 case 的當前 token。
5. 改碼後舊碼重新登入必須 **100% 失敗、新碼成功**；每個主張列實際嘗試數，不只報百分比。重發情境 profile 仍 approved，若原生舊 access／refresh 還可用，記「已重現缺口」，不偷偷加 M2／M3 或填「S-03 通過」。存活窗口從事件提交時點起、以單調計時與 JWT exp 對照，包含最後成功／首次拒絕與取樣間隔；建議每 30 秒一次，至 300 秒到期後再一個確認點，計入 200 次總量。
6. DB 停用／marked／角色改變提交後，下一次資料請求必須依既定政策拒絕；role claim 即使未變也不能保留保存能力。另驗研究學校 unconfirmed 拒絕、withdrawn／expired 自有非 AI 內容沿既定允許。沒有真實 BFF 就**不宣稱學生登入 gate 已保證「不建立 session」**，這仍是後續產品前置。
7. 各 case 結果固定為 passed／failed／not_run／manual_review；觀察性測項可記 observed，但不得把觀察到殘留視窗改判需求通過。任何預期失敗未發生、正向不成立、timeout、資料／secret 洩漏、資源不足或清理錯誤，批次非零退出；環境不可用記 not_run。可交付有效的失敗／限制證據，不強求每項變綠。
8. finally 精確 project labels 清除研究容器／volume／network，確認各為零、loopback listeners 釋放、記憶體 tokens／研究暫存 secrets 銷毀。不得刪快取映像或操作其他 stack；不用廣域遞迴刪除。只刪已解析且屬本批的具名暫存設定／研究資料，保留去敏結果及來源供複核；研究 volume 不能進 ZIP。

### 7.3 驗收與研究後停止線

研究批次成功＝隔離與清理可驗、真實登入正向成立、錯 token 不得取得資料、舊碼全失效／新碼成功、當下 DB 狀態／角色拒絕成立，且 Auth／DB／session 三層觀察與限制完整。**舊 session 殘留可作為研究發現，但不能作為 S-03 需求成功；清理成功也不能沖銷測試失敗。**

可重用的來源／hash、去敏逐案狀態／計數／時間、設定與映像版本、mail 0、獨立 actor／資料前後證據、資源零殘留及 manifest 應形成下一批交付。完整 S-01／S-02／S-03 維持未結案；託管 forwarding／30 人 NAT、跨 Auth／DB 補償、M2／M3、BFF／cookie／Storage／Realtime、產品 provider 與 HTTP／UI 仍未執行。研究結束即停，不能自動接 T027／T028 或學生保存。

## 8. 本輪文件交付口徑

本輪只核對／整理必要四份文件；工具盤點、來源差異／雜湊、文件引用與封裝完整性可驗證。`npm test`／typecheck／build／DB runner／完整 Auth／供應商環境／UI 均 `not_run`，不挪用 §53 當新執行。ZIP 納入直接契約／決策／研究原文、既有 authorization／交易 adapter／相關測試與設定，既有測試來源只作複核，非本輪已執行證據。

## 9. §55 單批實際執行結果（取代「尚待批准執行」的現況，保留 §54 歷史）

**來源與資源**：專案外唯一研究目錄 `C:\Users\geste\AppPlanet-AuthResearch-20261024-2344-d16bf226`；project `appplanet-authresearch-20261024-d16bf226`。建立 Compose、Node runner、PowerShell 入口、研究 schema 與展開的 gate 副本；原始 `0002_account_gate.sql` SHA-256＝`b7153c295e4ccbc480eb412cf2259e040838cca609a9b099c5a604ea4c472c23`，前兩函式逐字副本 hash＝`5fc025cf987de689a5bf3516ca59f3ac6429ac4613812628353f174133401f56`。**展開 schema 尚未執行，不能稱產品 migration 或研究 RLS 整合完成。**

**實際結果**：啟動前曾因 Windows PowerShell ACL cmdlet 不可載入而停止（無資源／無 keys）；改用既有 PowerShell 7 嚴格核對 ACL 後，兩次 DB setup 非零停止（第一次未保留 SQLSTATE，第二次 `42501`）。保留各次原始去敏結果、被測 runner 與清理證據，未掩蓋為通過。後依既有 DB runner 的 prior art，僅將研究控制連線改用 `supabase_admin`，在全新研究 DB 完成 setup。這是研究 setup 修正，非產品權限變更；未重設累計時間。最終 `start-auth-mail` exit 0，但唯一 `GET /health` 在約 72 ms 內傳輸失敗、無 HTTP 狀態；立即中止，無 HTTP 自動重試。未保留敏感服務日誌／response，**無足夠證據判定確切 Auth 啟動或版本互通根因**，不猜測為 token、網域或 RLS 問題。

| 項目 | 狀態 | 可核對結論 |
| --- | --- | --- |
| 固定映像、靜態 Compose、ACL／port 預檢 | `passed`（最終預檢） | 四 digest 已在快取；internal 唯一 network、精確 volume、loopback、DB 不發布、logging none、無外部 SMTP／bind／socket／其他 stack 引用；未 pull／安裝 |
| 原生 DB setup | `observed` | PostgreSQL 實際回報 17.6；最終獨立 DB／研究 Auth actor setup exit 0；先前 setup 失敗仍保留 |
| Auth readiness | `failed` | 唯一 health 傳輸失敗；容器啟動命令成功不等於服務健康，未重試 |
| S-01-1／4；真實登入、舊碼 | `not_run` | 建立／登入／舊碼／新碼嘗試均 0，不報 100%；無正向自有資料讀取 |
| JWT 簽章／issuer／audience／expiration；A/B/anon RLS | `not_run` | 未啟動 PostgREST、未取得 Auth token；不宣稱四項驗證或全拒絕成功 |
| S-03 原生事件／DB gate／殘留窗口 | `not_run` | logout／disabled＋ban／marked＋ban／改碼／role 變動均未到達；無最後成功／首次拒絕，無上下界可採用 |
| Mailpit 郵件事件 | `not_run` | 未呼叫 mail API，事件數未知，**不是 0**；無外寄設定不是「零事件」證據 |
| 清理／listener／暫存 secrets | `passed` | 每次中止均 finally 清理；精確 labels container／volume／network 各 0，三 port 不可連且可重新 bind；三具名敏感 env 檔與目錄已刪除 |

**實際用量**：整批 1／200 HTTP 請求（Auth health 1，資料／mail 0），峰值並行 1／2、帳號 0／6；最早資源啟動至最終清理約 277.7 秒（4 分 38 秒，含 setup 修正間隔），未到 45 分鐘上限。DB／Docker／ACL 命令另有逐命令 exit／耗時，不以排除 health／mail 規避請求總量。研究 TTL 設定為 300 秒但未取得任何實際簽發 TTL 證據；不是 PP-04。

**停止與下一步（僅提案）**：另批最小健康／啟動診斷，先取得可去敏的啟動失敗分類、必要執行期版本及 isolation／port readiness 證據，再決定是否另批同方案 A 的未執行案例。不得先做 M2／M3、接受殘留窗口、選 B／C、產品 provider／BFF／cookie、HTTP／UI／保存、Storage／Realtime。產品 test／typecheck／build／既有 DB runner 均 `not_run`。來源差異／封裝與獨立清理驗證見 readiness §55.2～§55.3 與專案外證據包；所有任務／Gate／正式簽核及真實功能關閉狀態不變。

## 10. §56 有界啟動診斷結果（2026-10-25；已停止）

教育者另批本機 Auth 啟動／health 診斷，只有 T026 研究環境子集；不重跑 §55 完整研究。新目錄 `C:\Users\geste\AppPlanet-AuthDiagnostic-20261025-0011-dbf19f2d`，3 個新 project，僅 DB／Auth／Mailpit 的原快取 digest。受限 json-file 日誌在記憶體先遮蔽、再輸出固定分類／SQLSTATE；7 個合成分類／遮蔽測試通過，HTTP status 不再因本文／JSON 失敗遺失。

- **嘗試 1**：setup exit 0，Auth exit 1；migration／權限錯誤 `42501`，HTTP 0。
- **嘗試 2**：具名 actor SQL 證實既存 schema CREATE／uid replace 權限不足；授研究 DB CREATE 與 uid owner 修復仍無效，Auth 再 exit 1。啟動證據定位為 public schema 權限拒絕，HTTP 0。
- **嘗試 3**：以具名 public 建表／uid replace 探針重現 `42501` 後，只授研究 actor `CREATE ON SCHEMA public` 並修 `auth.uid()` owner；不授 DB CREATE，維持 NOSUPERUSER／NOBYPASSRLS。Auth 觀察點 running，但 60 秒窗口內 3 次 health 全為 `ECONNREFUSED`、status null，未得 HTTP 200；啟動日誌無內容，剩餘原因未知。不能稱 migrations 完成或 listener 可用。
- **驗收未達成**：成功時 runtime isolation、health 版本／形狀及成功後清理重跑皆未驗得。3/3 啟動用盡，本機 HTTP 3 次＋官方來源 GET 查閱 2 次，保守 5/30（查閱工具內部 timeout／redirect 未揭露），帳號 0、本機並行 1，累計首次啟動至末次清理約 29 分 42 秒；不再重啟。
- **清理通過**：每次 finally down／volumes／network、labels 零殘留、ports bind 與敏感檔移除；獨立 runner 再查三個 project 九項 labels、TCP／bind／敏感目錄均通過。詳見 [readiness §56.2～§56.3](./readiness-review.md) 與原始安全證據。
- **限制不變**：S-01～03、JWT／RLS／session、Mailpit API／事件數皆 not_run／未知，產品 test／typecheck／build／DB runner not_run（產品來源未改）。§55 的 catch 標籤保留為歷史，不將其一律推為 fetch 失敗或倒填根因。下一候選僅另批 migration 進度／DB 活動與 listener／port 診斷，不接產品 Auth 或原研究。
- **程序缺口**：兩次官方查閱曾以 parallel 工具批次發出、工具 timeout 未揭露，不能宣稱全批 HTTP 並行／timeout 完全符合上限；詳見 readiness §56.3。已停止查閱，沒有外送本機設定／憑證。

## 11. §57 migration／listener 分層診斷結果（2026-10-25；已停止）

本輪新授權、預算及實證見 [readiness §57](./readiness-review.md#57-2026-10-25-auth-migrationlistener-分層診斷與最小修復一次性本機批次)。只做 T026 研究環境子集，T015 診斷測試／T008 邊界為實際相依；原任務與依賴不變。沿用 §56 第三次兩行最小 setup，不增加 DB CREATE／superuser／BYPASSRLS。

- **兩次全新資源重現**：catalog 先確認 migration 表／version 欄型別；public 70 筆（69 筆符合安全識別白名單），auth 0；users／sessions 出現，使用者 0。Auth info 受限日誌投影有時間／服務／步驟與 migration_complete／auth_listening，PID 1 存活、`[::]:9999` LISTEN。DB 活動快照未看到 research_auth 連線／lock wait，不推論整段啟動從無活動。
- **HTTP 路徑對照**：兩次合計容器 loopback 3/3、同 internal network 3/3 HTTP 200，皆符合 GoTrue v2.196.0 health 形狀；Windows Node 3 次＋curl.exe 1 次全拒絕、status null。不是以 TCP 或 running 代替 HTTP。
- **直接阻擋及未知**：第二次 HostConfig.PortBindings 有 loopback 設定，但 Auth `NetworkSettings.Ports["9999/tcp"]=[]`、Mailpit `["8025/tcp"]=[]`，Windows Auth 埠 listener count 0。證實本輪主機發布未實際建立；Docker Engine／Desktop 為何未建立仍未知，不將 internal flag／版本缺陷當已證實根因。不改 DB／JWT、不放寬網路、不新增代理，不做第三次無依據啟動。
- **測試與用量**：保留原七項並新增五項，兩輪啟動前均 12/12 合成測試通過。2/3 啟動、10/30 HTTP、並行 1、0 帳號、首次啟動至末次清理 345.518 秒；每次 finally 及獨立 labels／ports／敏感檔查核通過。第一輪 readiness 122.597 秒，超窗 2.597 秒如實保留；第二輪 runner 預留診斷時間並只做一輪，45.524 秒。原始第二輪 stopReason「readiness_window_exhausted」只是 runner 通用標籤，不代表實際耗盡窗口。
- **驗收／停止**：部分定位，完整成功未達；容器內 readiness 清理後已重現，但主機 readiness 修復與完整成功重跑未完成。無外部查閱／pull／安裝，產品來源／migration／既有 runner／依賴不改；產品 test／typecheck／build／既有 DB runner、登入／JWT／RLS／session／mail 事件／S-01～03、PostgREST／provider／HTTP／UI 保存皆 not_run。四份文件、每次被測來源、差異、安全分層證據及 manifest 另包；不倒填 §55／§56，不 commit／push／部署。G0／Checkpoint／完整 Gate 與正式簽核狀態不變；後續仍須另批。

## 12. §58 容器內最小隔離研究（2026-10-25；額度用盡後停止）

**批准與邊界**：[readiness §58.1](./readiness-review.md#581-研究來源修改與資源啟動前的明確授權登錄) 先於研究來源及資源登錄本次明確批准；主要 T026、S-01-1／4、S-03 原生／直接資料子集。沒有因一般 Gate 未通過而停成計畫，但實際研究被 setup／runner 錯誤阻斷，不能把候選程式當實證。

| 項目 | 實際結果／分類 | 不可外推 |
| --- | --- | --- |
| 傳輸合成 | 前兩版 7/7、末版 8/8 passed；stdin、固定目的、無重試／redirect、HTTP／JSON／timeout 分類、白名單、請求／帳號／時間／啟動上限 | 不等於真實密碼／token 傳輸已完成；實際敏感管理 bearer 只經 stdin，無原始回應證據 |
| 拓樸／readiness | DB 內既有 curl 直接至 `http://auth:9999`／`http://rest:3000`／`http://mail:8025`；單一 internal network、專屬 volume、無主機 ports／bind mount；第二、三次三服務 HTTP 200 | 新拓樸，不證明 Windows publishing 修好；HTTP 僅隔離研究，不替代產品 HTTPS／BFF |
| issuer／aud／TTL | 設定 `http://auth:9999`、`authenticated`、HS256、300 秒 | 尚無真正學生 access token；實際簽發 claims／TTL／issuer 驗證均 not_run，不能聲稱 issuer 接受或拒絕 |
| 最小 setup／actor | public CREATE／uid owner 保留；FK 第一次 42501，第二次既有 setup actor 補建成功；authenticated／anon／research_rest 非 owner／superuser／BYPASSRLS，亦無 DB CREATE | 不修改產品 grant／RLS；不把空資料 readiness 當 RLS 正向控制 |
| S-01-1 | 第二次三網域管理建立各 HTTP 500（環境／研究錯誤）；登入 0 次；未得成功候選 | 不判網域不相容，不報通過；建立實際是否有部分副作用未量測，僅 0 個確認成功 |
| S-01-4／JWT→RLS／S-03／學校／窗口 | 全部 not_run；舊碼／新碼／舊 access／refresh／直接資料與 RPC 正負向實際嘗試均 0 | 不報成功率、即刻撤銷、殘留窗口或完整 JWT／S 系列通過；研究原生行為未知 |
| Mailpit | 第二、三次各自初始 `total=0`（passed） | 第二次建立請求後與最終計數 not_run，不能說整批零郵件 |
| 第三次阻擋 | Auth namespace 探針 exit 2、非 timeout／spawn error、無可用 SQLSTATE；作為硬前置導致 runner 中止（failed） | `search_path` 假設修正未進管理建立比較；根因仍未證實，不能寫成修復成功 |
| 用量／清理 | 3/3 啟動、12/200 HTTP、並行 1；3 次建立請求保守占用 3/6 帳號額度；至末次 finally 約 233.671 秒；各 finally 完成，三 project 獨立 labels 零殘留、敏感目錄不存在 | ports 釋放不適用；帳號不是「成功建立 3 個」；啟動額度用盡後不再啟動 |

**未滿足／needs_human**：真實登入正向控制與 JWT／舊 session 安全需求均無足夠證據；沒有新窗口可供教育者接受，M2／M3 未研究或授權。下一候選僅在另批後先修研究診斷控制流程，取得管理建立 500 的最小安全分類、確認 namespace／連線，成功後才續原案例；不要先修主機 publishing 或接產品。產品來源與 136 任務不變，產品 test／typecheck／build／既有 DB runner、S-01-2／3／5、S-02、完整 S-03、供應商環境、Storage／Realtime／BFF 均 not_run。證據／來源差異／封裝以 readiness §58 與複核包為準。

## 13. §59 管理建立500修復與登入正向實證（2026-10-25；單批完成後停止）

- **實際根因**：本輪baseline真正research_auth新連線預設`"$user", public`，無法解析users；管理建立500的同窗Auth／DB均`42P01`／undefined relation identities。控制連線SET ROLE仍帶auth路徑，不能冒充角色登入預設。只加`ALTER ROLE research_auth SET search_path = auth, public`後，兩次全新資源能解析users／identities，管理建立200、真實password登入200且ID一致。此為本研究設定錯配的對照證據，不倒填§58每個歷史500的確切relation，也不是保留網域不相容。
- **探針修復**：psql真正TCP新連線明確經stdin提供本輪密碼；分開連線／認證、SQL、解析失敗，非必要diagnostic_failed不硬中止、不冒稱業務passed。Auth實際限定設定核對db／5432／research_auth／auth_research／namespace auth及本輪密碼一致；未直接觀測Auth池內session或測錯密碼安全。
- **逐次結果**：a1建立500、登入not_run、Mailpit初始0／失敗後0、users控制計數0；a2與a3各建立200／登入200、回應基本形狀／ID一致，Mailpit初始／建立後／登入後均0。tokens只在記憶體，無簽章／撤銷安全主張。a3為清理後全新資源成功重跑，不是同DB續用。
- **診斷／限制**：受限Auth／DB錯誤日誌先遮蔽再白名單，只存命令／HTTP時間窗、SQLSTATE、固定分類與relation；安全request ID／事件內時間未取得、原文不保存。unknown SQLSTATE保留代碼、不透傳任意文字。18/18末版合成與靜態通過；初版16/16工具摘要及來源保留，但其逐項TAP被同名末版覆寫，此缺口明列於readiness。
- **用量／隔離／清理**：3/3啟動、19/40 HTTP、3/3建立請求（2成功）、2/3登入、並行1、至末次finally192.626秒。三固定快取digest、單一internal network／專屬volume、無主機ports／外寄／產品掛載／PostgREST／app表／FK；既有public CREATE／uid owner保留，不加superuser／BYPASSRLS／DB CREATE／grant。三次finally與獨立九項labels零殘留、敏感暫存移除；port釋放不適用，無pull／安裝／外查。
- **仍未驗／停止**：只T026及S-01-1單網域正向局部，完整S-01～03、JWT負向／資料RLS／改碼／session／生命週期／M2／M3／產品principal／BFF／HTTP／UI／保存／供應商dev仍not_run；產品test／typecheck／build／既有DB runner不執行。主機publishing缺口獨立保留。136任務／依賴／未結案不變；G0／Checkpoint／完整Gate未過、正式簽核未執行、產品關閉；不再啟動或接續工程。

## 14. §60 真實 JWT→PostgREST→RLS 批次結果（2026-10-25；已停止）

- **完成的研究前置**：專案外隔離 stack；Auth／PostgREST／Mailpit readiness 成功；Auth migration 後才建立研究 schema／FORCE RLS／fixture。`research_auth` 新密碼連線的 `search_path=auth, public`、非 superuser／非 BYPASSRLS、無 database CREATE。A／B 皆真實建立與 password 登入200、登入ID與建立ID一致；Mailpit初始／建立／登入後事件數皆0。
- **真實 Auth token claims 觀測**：A／B皆觀察 `HS256`、issuer=`http://auth:9999`、audience=`authenticated`、`exp-iat=300`秒、sub對應建立ID、role=`authenticated`、`token_type=bearer`；只在記憶體解析，無 token／email／完整 claims 證據。這不是簽章驗證。
- **安全控制與停止原因**：研究 schema／兩個合成 fixture 已建立。setup 控制 catalog 查得 `research_rest` 非 superuser／非 BYPASSRLS／非 schema或table owner、無直接 `account_gate` EXECUTE；authenticated 具 SELECT 與限定 gate EXECUTE、無 saved_rows DML。錯誤的 runner gate 把 setup 連線 `session_user=supabase_admin` 當成應是 `research_rest`，於 actor/data HTTP 前判 failed；所以 PostgREST 真實 session、`authenticated`／`anon`切換尚未驗證。A／B資料正向、跨帳號、匿名、學生寫入／升權與四類 JWT 負向及有效控制全部 `not_run`。不得將角色目錄查詢推論成實際 PostgREST 通路或 RLS通過。
- **診斷、用量與清理**：前次研究 SQL只保存SQLSTATE `42501`，未能定位語句；本次分步執行研究 SQL成功，不推斷前次確切根因。3/3 stack starts、7 staged Compose `up`、18/120 HTTP、2/6建立、並行1、首次啟動至最後清理374.816秒；三次 stack finally 均 labels零殘留、敏感暫存移除、host ports不適用。pre-start及修正後研究合成／靜態測試24/24通過；finalizer錯誤與錯誤 actor 比對已離線修正，但修正後 runner 未重新實測，且無第四次啟動額度。
- **狀態**：研究批次未完整完成；T026／T008僅本輪研究子集，不結案或勾選。主機publishing缺口未修。產品 Auth／principal／HTTP／UI／保存接線、產品測試／typecheck／build／既有 DB runner 均 `not_run`；136任務／依賴／未結案、Gate及簽核狀態不變。本次批准已耗盡，無持續授權。

## 2026-10-25 issuer 信任邊界研究結果（readiness §62／§63；非產品接線）

本輪一次性授權與路徑範圍見[readiness-review.md §62](./readiness-review.md)；結果及完整路徑表見§63與專案外 `trust-boundary-and-options.md`。T026研究子集、T008帳號／資源授權邊界及T011 HTTP路徑子集依現行`tasks.md`核對；不結案、不改136項任務／依賴／狀態。上一輪ZIP hash核對一致，原41項直接回歸41/41；新增validator／hook實際邏輯測試後，離線49/49通過。

- **Baseline** `ee6680101298`：真實Auth A／B及actor/RLS控制成立；正確研究key簽章、只改issuer仍HTTP 200讀回A資料，兩個RPC亦接受；缺／近似issuer同樣被接受，前後有效控制通過。原JSON保留runner實際exit 0及`safetyRequirements=passed`，但檔內已記錄`securityGap`。獨立、hash錨定評估判定安全失敗、語意應exit 2；確認是baseline runner將已觀察的安全缺口誤計為通過。原結果未改寫；計分缺陷在補強stack啟動前修正並重新離線驗證。
- **PostgREST v16.1補強** `117af5d06013`：研究用global `PGRST_DB_PRE_REQUEST` hook從PostgreSQL固定啟動設定取得issuer，使用PostgREST已驗簽claims精確比較。真實Auth A／B資料、匿名／跨帳號RLS、actor snapshot、七項寫入拒絕／快照不變均passed。錯／缺／近似issuer於資料表及`actor_snapshot`／`current_account_gate`皆HTTP 403、SQLSTATE `42501`、固定安全錯誤，明確分類為**已驗簽後issuer政策拒絕**；簽章竄改為原生HTTP 401 `PGRST301`，錯audience／過期為原生HTTP 401 `PGRST303`。各負向案前後有效控制皆passed。
- **validator分層**：研究Node `crypto` validator在真實Auth A／B token上passed，且拒絕錯簽章、issuer、audience及過期案例；不接產品server。hook為`SECURITY INVOKER`，沒有改RLS／grant或提升actor權限；研究各角色不能SET固定issuer設定。
- **用量與限制**：保守45分鐘錨點至末次清理1,121.582秒；2/3 stack、6次分階段up、130/160 HTTP、4/6帳號、並行1。兩次finally與獨立labels均零殘留，無host ports／pull／依賴變更。主機publishing不在本次修復範圍。產品test／typecheck／build／既有DB runner、Storage／Realtime、session撤銷／殘留窗口、M2／M3及完整S-01～03均`not_run`。

這是研究證據與候選方案，不是正式issuer、直接資料存取政策或新架構決策；沒有產品程式接線或任何安全政策採用。產品維持server＋cookie設計、直接瀏覽器PostgREST不推定批准；任何導入均須另行明確批准。G0、Checkpoint／完整MVP Readiness Gate未通過，正式審議／簽核未執行，真實功能繼續關閉。

## 15. §65 舊碼失效與原生 session 生命週期研究結果（2026-10-25；一次性，已停止，非產品接線）

授權、範圍、預算與停止條件見 [readiness-review.md §65](./readiness-review.md)；分層結果見 §65.4。僅 T026 研究及 T008／T011 實際子集；136 項任務 ID／正文／依賴／未結案狀態不變，不宣稱 Q-AUTH／Q-SCHOOL／依賴或 Gate 滿足。

- **直接觀測（GoTrue v2.196.0、PostgREST v16.1、§64 受保護 issuer 設定表＋getter＋hook；TTL 300 秒僅研究設定）**：
  - **§66 證據更正**：管理端改碼後舊碼400 `invalid_credentials`／新碼200；`/user` 首次觀測拒絕相對事件送出約0.7～0.8秒；目前 refresh 首次拒絕完成於事件回應後約1.8～2.4秒，**不是內部session刪除精確時刻**。rows 仍成功的事件後下界約314.7秒，不能套用 gate：A gate下界18.189251／18.138403秒，B gate下界15.722461／16.017259秒，各僅3次取樣。詳見 readiness §65.4／§66.2 與原始run逐案時間。
  - 原生 logout（明確 `scope=local`）：撤銷目前 session（refresh 400、Auth `/user` 拒絕）；同帳號第二 session 不受影響；資料層與改碼相同殘留。logout 成功不代表 access 立即失效。
  - 平台停用（`app.profiles.status='disabled'`）／標記刪除（`deletion_state='marked'`）：DB gate 與 RLS 於事件回應後第一個探測（約 0.6～1.3 秒內）拒絕，資料列為空集合（**資料未取得／RLS 過濾**，不是 HTTP 401／403）；此時 Auth 層仍接受 `/user`、refresh 與正確碼登入。Auth ban 另使 `/user`、refresh、正確碼登入皆 `user_banned`；兩個系統操作非原子，分層計時。
  - **到期後接受僅觀測現象**：第二套 A／B 最後成功exp+24.1／24.4秒、首次拒絕exp+31.4／31.7秒；E 最後成功exp+30.7秒、首次拒絕exp+45.7秒。成因與最大上界未證，不稱固定30秒寬限、不直接核定PP-04；未干預到期後refresh可取得新access。
  - **因果／政策限制更正**：C／D ban前DB已因平台狀態拒絕，無法單獨辨識ban資料層效果；`scope=local`僅已測候選，未核定正式logout政策。§65原始run／exit／失敗保留，非本輪新實測。
- **安全要求與限制**：必要步驟皆符合預期，資料層缺口為改碼後舊 access（`A.rows`／`A.gate`）；這是缺口回報，不實作 M2／M3、不接受窗口、不改政策。兩套 exit 為 1（第一套研究未完成：原生到期與計分判讀缺陷，保留原結果並另做獨立重評估）與 2（第二套研究完成、有安全缺口）；兩套被測來源差異限 5 個研究檔，第二套不回填第一套。
- **用量與清理**：HTTP 372／600、建立 10／10、2／2 stack、並行 1、917.7 秒；finally 與獨立 labels 零殘留，Mailpit 0 事件。產品 test／typecheck／build／既有 DB runner `not_run`；產品來源、migration、RLS、grant、依賴與 lockfile 未改。
- **§65 當時未驗／待決**：M2／M3、產品撤銷、重放與完整 refresh reuse、Storage／Realtime、其他版本／演算法、Auth soft／hard delete、產品管理流程、PP-04／窗口是否接受及正式logout scope。§66另批僅研究M3候選，不補定政策、不回填§65。G0、Checkpoint／完整Gate未通過，正式簽核未執行，真實功能關閉。

## 16. §66 M3隔離研究中止（非產品採用）

詳見[readiness §66.3～66.4](./readiness-review.md)。issuer-first PostgREST hook後，以已驗簽sub＋session_id比對原生sessions同一列；專用NOLOGIN／非superuser／非BYPASSRLS helper只讀id／user_id，無公開任意session RPC，原ownership／account gate不變，不保護直接SQL或其他服務。

首套 `6e0551244d32` baseline重現A0／B0原生列消失後舊access三路徑仍成功；但啟用M3後有效E的表格／gate／actor皆403／42501，無法保留有效session。原生sessions RLS=true；本次欄位SELECT方案不可用，與可見性限制一致但未完整盤點pg_policy，不宣稱所有M3不可能。新session／B2也被誤拒，D負向及C回歸均不能計通過。

runner未即時停止相依請求，原118筆保留、獨立重評為14 passed／3 failed／101 blocked。五項真實research_rest→authenticated權限拒絕42501有獨立證據；撤權／rollback恢復命令exit3，完整故障恢復inconclusive。首套process exit1、研究incomplete／安全not_met；最後只補離線停止控制90／90（首套被測89／89），不重啟、不放權、不轉M2；第二套not_run，無兩套同來源通過。

用量1／2 stack、138／320 HTTP、5／10建立、峰值並行1、finally84.350秒（落盤84.384秒）；精確finally及獨立labels均零殘留、敏感暫存移除。Mailpit初始／建立後0、最終not_run。產品驗證not_run、四文件以外來源及136任務保持原狀。下一批僅可另批RLS／最小權限研究或M2比較，不授權產品導入；G0／Gate／簽核／真實功能關閉狀態不變。

## 17. §67 Auth RLS／reader 診斷中止（2026-10-25；非根因證明）

教育者一次性批准及先行登錄見 [readiness §67](./readiness-review.md)，僅 T026／T008／T011 實際研究子集。前包 hash、manifest、67 個直接來源與原 run 33 個快照均核對相符；先登錄才修改研究來源／啟動資源。啟動前保留90／90、本批6／6離線通過，不是產品測試。

run `f0f22e9e42ee` 的 A／B 真實登入／驗簽／Auth `/user`、issuer-only 自有 rows／gate／actor、跨帳號／匿名空集合、actor非特權／INVOKER及錯issuer403／42501均通過。catalog實查：PostgreSQL17.6／GoTrue v2.196.0，sessions owner=research_auth、RLS=true／FORCE=false、**pg_policy及pg_policies均0條**；reader非owner／非BYPASSRLS，只有id／user_id欄位SELECT與必要schema USAGE，無他角色會員或SET ROLE路徑。helper原owner=reader／DEFINER／search_path=pg_catalog，原helper／hook正文比對相符；這不是實際helper呼叫身分證據。

工具把`uid()`顯示名誤配研究schema來源，且初始化後uid正文與setup不是逐字相同（離線SQL詞彙相同、僅大小寫／空白差異），因此來源檢查失敗即停止。原生migration逐階段來源未保存，不猜測改寫來源。**process exit1、診斷incomplete／根因inconclusive／安全not_met／未批准採用**。控制角色session綁定SELECT、reader精確predicate、真認證helper、session-hook啟用後HTTP三路徑、前後catalog比較及Mailpit final全部not_run／blocked；不以issuer-only成功或§66結果補值，不把零policy直接當本批已證明根因。

1／1 stack、2／2建立、23／64 HTTP、並行1、finally28.532秒；down exit0、獨立container／volume／network各0、敏感暫存移除。Mailpit初始／建立後0、final not_run。38個啟動前來源與最後來源相同，未修工具再重跑，無第二套。本批只同步四治理文件、產品及136任務保持原狀，產品test／typecheck／build／既有DB runner not_run。下一批僅建議另批同權限唯讀補證；Auth policy／owner／權限方案需另案最小權限及供應商相容性審議，不擴權、不做新M3／M2。§66原始偏差／失敗／89與90／第二套not_run保留；G0／Gate／簽核及真實功能關閉狀態不變。
