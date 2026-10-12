# BLUEPRINT TRIỂN KHAI BRAIN P1 → P5 — "NÃO VẬN HÀNH" MLP-CPU CHO TMO

> **Phiên bản:** 0.11 — **DRAFT, ĐANG THẢO LUẬN.** Nền toán MLP (§4.1) **ĐÃ triển khai (2026-10-12 — src/lib/brain/ + test r84; hiệu đính hợp đồng API qua đợt FB-BRAIN-P1 cùng ngày)**; **BRAIN-P2 (§4.2) ĐÃ triển khai (2026-10-12 — `src/lib/brain/calibration-v3.ts` + `POST /api/brain/train` + cờ `calibration_v3` + test r85; hiệu đính 8 phát hiện qua đợt FB-BRAIN-P2 cùng ngày — r85 35/35)**: pipeline train Brain-A "V3" (MLP thay logistic, kế thừa nguyên vẹn pattern thăng cấp V2) + nút "Huấn luyện lại" sống trên panel Não vận hành + auto-train sau eval run; runtime vẫn mặc định OFF (cờ STORE > ENV > DEFAULT=off). **BRAIN-P3 (§4.3) ĐÃ triển khai (2026-10-12 — `src/lib/brain/brains/surrogate.ts` + `POST /api/brain/replay` + cờ `replay_eval` + test r86 45/45)**: Brain-B "Vọng" surrogate predictor — 3 MLP đầu-ra-riêng (success BCE / tokens+duration Huber log1p space) + replay-eval READ-ONLY kèm bootstrap CI + auto-train sau agent run + single-flight lock A7. Brain-B đang NGỦ đúng thiết kế (17/60 runs usable). **BRAIN-P4 (§4.4) ĐÃ triển khai (2026-10-12 — `src/lib/brain/brains/policy.ts` + `src/lib/brain/reward.ts` + `GET /api/brain/policy` + cờ `runtime_policy` + 3 cờ organ kill-switch + test r87)**: Brain-C "Lệnh" policy head — mixture π = λ·π_Q + (1−λ)·π_net (λ = max(n/K, 1−WilsonLB) — công thức tường minh) + composite reward R = w₁·Outcome* + w₂·Efficiency* + w₃·Quality* (chuẩn hóa từng thành phần, quality thiếu → renormalize; **LOG-ONLY từ v0.9 — đợt quan sát 1**) + steering 3 cơ quan từng cái một (model routing `llm.ts` · adaptation directives `workflow-engine.ts` · tuning-store đề xuất — mỗi organ kill-switch riêng `policy_organ_*`, mặc định off) + auto-train sau agent run + single-flight A7 wired cả 3 brain. Brain-C đang NGỦ đúng thiết kế (QEntry 1/30 · ArbiterVerdict 10/50). **Q1 (composite reward §3.1) USER ĐÃ CHỐT (2026-10-12): duyệt theo khuyến nghị — log-only 2 đợt quan sát trước khi tác động** (xem §8 dòng 2). Riêng **phần UI của P1 đã áp dụng sớm theo chỉ thị user (P/S, 2026-10-12)**: panel "Não vận hành" trên tab Database > Kiến trúc + model `BrainModel` + `/api/brain` + `src/lib/brain/registry.ts`. **BRAIN-UX (§9) ĐÃ triển khai (2026-10-12 — UX-1→UX-5 hoàn tất đúng thứ tự, gộp 1 commit `feat(BRAIN-UX)` kèm đợt fixbug FB-BRAIN-UX khép kết — hiệu đính doctrine #4, xem §9.10; 3 cờ UI `ui_brain_edit`/`ui_synapse_fx`/`ui_hitech` mặc định off; chi tiết: nhật ký hiệu đính 0.9→0.10 đầu file).** **BRAIN-LIVE (2026-10-12) ĐÃ triển khai:** panel "Não vận hành — MLP-CPU (BRAIN)" di chuyển sang **module Smolab → tab BRAIN** + não hiển thị THẬT từng nơ-ron (cap 256, Brain-A = 27 chấm) + điểm sáng theo activity thật (`GET /api/brain/activity` READ-ONLY, live poll 2.5s) + zoom/pan + dialog chỉnh tham số runtime tại chỗ (TuningParamDialog); cờ `ui_synapse_fx` mặc định chuyển **ON** (đài quan sát não — chi tiết: nhật ký hiệu đính 0.10→0.11 đầu file).**
> Được tạo theo chỉ thị user (2026-10-11): *"tạo một file .md lộ trình triển khai, cần triển khai những gì và triển khai như thế nào. Tuy nhiên chưa triển khai ngay mà vẫn cần thảo luận thêm."*
>
> **Nhật ký hiệu đính 0.10 → 0.11 (triển khai BRAIN-LIVE, 2026-10-12 — chỉ thị user nguyên văn: *"Phần Não vận hành — MLP-CPU (BRAIN)... các lớp giữa các bộ não tôi thấy chỉ mới dừng lại ở mức tượng trưng chứ chưa phải hiển thị thực, hiện thị thực là mỗi lớp có bao nhiêu nơ ron thì phải hiển thị đúng số điểm nơ ron đấy, cơ chế lan truyền tiến bằng các đường màu xanh, lan truyền ngược là các đường màu vàng và các đường này có hiệu ứng chuyển động theo hướng, khi agent vận hành, tư duy thì có các điểm sáng tương ứng với các nớ ron hoạt động truyền tới các nơ ron khác thế nào theo thực tế... Không gian thể hiện của hình ảnh các lớp não quá nhỏ... có thu to phóng nhỏ... phần Tham số runtime trong cột hành động khi bấm vào mũi tên thì lại chỉnh ở một ô bên trên, mất công lăn chuột lên... đúng ra có thể mở dialog để chỉnh và đóng lại... hãy di chuyển toàn bộ ô Não vận hành — MLP-CPU (BRAIN) về module Smolab và tạo thành 1 tab tên là BRAIN cho tôi"*):** **Di chuyển sang Smolab** — panel "Não vận hành — MLP-CPU (BRAIN)" di chuyển NGUYÊN VẸN từ tab Database > Kiến trúc sang **module Smolab → tab BRAIN** (`SMOLAB_TABS` thêm entry `brain` — icon BrainCircuit, màu amber, persistence `graphrag-smolab-tab` tự nhận; `BrainTabContent` mới `src/components/smolab/brain-tab.tsx` 924 dòng (hiệu đính FB-BRAIN-LIVE-R1-09: đo lại `wc -l` tại 16-b — bản gốc ghi "921" lệch 1 so đo 920 tại 15-d; 924 gồm 4 dòng fix FB-BRAIN-LIVE-R1-01 của 16-b) — copy nguyên trạng state machine panel cũ: poll 15s + drafts + train + console 3 tab + mobile bottom-sheet, không viết lại từ trí nhớ) · `neural-architecture-section.tsx` prune **1712 → 1125 dòng** (hiệu đính FB-BRAIN-LIVE-R1-09: đo lại `wc -l` — bản gốc ghi 1126 lệch 1; xóa toàn bộ state/JSX brain, sạch biến mồ côi — đồ thị 6 lớp + node inspector + Q-table + SAL GIỮ NGUYÊN tại tab Kiến trúc). **Hiển thị thật từng nơ-ron** — `stage-geometry.ts` `STAGE_LIMITS.maxDisplayNeurons` **8 → 256**: vẽ đúng từng unit — Brain-A 10→16→1 = **27 chấm thật** (live verify đếm circle trong svg = 27); nén đại diện CHỈ khi >256 (ngoài khoảng editor 1–256, nén đơn điệu đầu 0 cuối units−1); cột input planned dùng `activity.inputVector.length` khi có (bỏ nhãn '?'/'1-hot cfg' mù). **Màu lan truyền theo chỉ thị** — TIẾN = **emerald** `rgba(16,185,129,*)` (trước đây amber) · NGƯỢC = **yellow** `rgba(250,204,21,*)` (trước đây orange) — đúng chỉ thị "tiến xanh · ngược vàng"; dash animation `bs-flow`/`bs-flow-bwd` GIỮ NGUYÊN (chuyển động theo hướng vốn đã đúng — không sửa CSS); accent lifecycle nơ-ron vẫn amber, bản tĩnh fxOn=off chuyển marker xám trung tính. **Điểm sáng theo thực tế** — `GET /api/brain/activity` **READ-ONLY** (chỉ count/findFirst/findMany/findUnique — không create/update/delete; fail-open mọi nhánh, 400 chỉ cho query rác): `inputVector` one-hot THẬT từ run/eval gần nhất (kể cả dormant — surrogate/policy dựng lại vocab từ dữ liệu usable thật) + `activations` per-layer `[layer][unit]` khi có bản active (qua `mlp.forwardActivations` public mới — wrapper `forwardAll`, trả bản sao) + `agentRunInProgress` (count status='running') · live poll **2.5s** trong tab BRAIN (visibility-aware, fail-open — nút Live + chip "Agent nghỉ / ● Agent đang chạy") — nơ-ron sáng emerald theo |activation| chuẩn hóa per-layer (layer 0 = inputVector kể cả dormant), cạnh strokeOpacity theo |a_from × w| thật đọc tensor phẳng (chuẩn hóa per cặp cột, chỉ chế độ TIẾN, toàn 0 → không áp — không giả tín hiệu); não ngủ → chỉ cột input sáng (one-hot thật) + chú thích trung thực nguồn. **Zoom/pan** — viewBox zoom: nút −/%/+/**⤢ Vừa** (bước 1.25, clamp **0.5×–12×**) · wheel về **tâm con trỏ** (passive:false) · drag pan khi zoomed (nuốt click sau kéo >3px — pattern P3-B1) · đúp chạm = fit; "Không gian thể hiện quá nhỏ" giải quyết bằng stage tall (min-h 420px · xl 540px, flex-1 chiếm toàn bộ vùng giữa tab). **Dialog tham số runtime** — `TuningParamDialog` mới `src/components/smolab/tuning-param-dialog.tsx` + `parseTuningInput` thuần `src/lib/learning/tuning-input.ts` (không kéo Prisma vào client bundle — nhân bản CÓ CHỦ ĐÍCH `validateTuningInput`, parity đã verify): bấm **bút chì** tại cột Hành động → dialog chỉnh tại chỗ (number input min/max/step + enum segmented + khối warning amber + Về mặc định / Đóng / Lưu) — hết cảnh cuộn lên ô phía trên (phàn nàn user). **Cờ `ui_synapse_fx` default 'off' → 'on' (HIỆU ĐỊNH DOCTRINE)** — lý do ghi rõ tại `neural-types.ts`: chỉ thị user muốn THẤY hiệu ứng; sau đợt di chuyển cờ chỉ tác động tab BRAIN (đài quan sát não — hiệu ứng là nội dung chính, không phải trang trí); `ui_brain_edit`/`ui_hitech` giữ off; prefers-reduced-motion vẫn tắt animation ở tầng isAnimated. **Ghi nhận trung thực (honest gaps):** (a) head surrogate của activity poll cố định 'success' — BrainStage chưa expose prop head (comment trung thực trong code, mở đồng bộ 2 chiều khi cần); (b) calibration_v3 dormant KHÔNG trả inputVector — stats chuẩn hóa nằm trong trainMeta bản active, không có thì không chuẩn hóa đúng scale được (trả thô sẽ sai lệch) → stage fallback planned spec như cũ; (c) pan chưa clamp biên — kéo quá xa mất đồ thị, ⤢ Vừa/đúp chạm khôi phục; (d) top-edge resize handle Smolab che ~19px trên thanh tab (pre-existing — đề xuất FB-BRAIN-LIVE); (e) SOURCE_BADGE còn 2 nguồn (dialog export cho smolab + bản local của section — có chủ đích tránh dependency chéo database↔smolab, chú thích đồng bộ 2 chiều); (f) inputVector dormant surrogate/policy là one-hot THÔ 0/1 chưa chuẩn hóa (không có means/stds) — UI kèm nhãn nguồn. **Tests** — r92 mới (BRAIN-LIVE) **30 test / 285 expect / 6 nhóm** (hiệu đính 16-c R2-02: +4 expect pin wiring head-sync R1-01 → 289) (A forwardActivations 5 · B parseTuningInput 6 · C activity route 8 — gồm READ-ONLY pin count 5 bảng (hiệu đính 16-c R2-01: 16-b R1-07 thêm EvalCase vào snap — bản ghi 15-e sót "4 bảng") · D geometry bổ sung 4 · E source-scan wiring 5 · F flag default 2 — Task 15-e, tất định 285 expect qua 3 lần chạy) + pin updates từ 15-a: r89-E (kỳ vọng `ui_synapse_fx` 'on' mặc định — tách khỏi 2 cờ còn off) + r90-J (vẽ ĐÚNG units: 10/16/1 = 27 nơ-ron KHÔNG nén, height pin 324; >256 mới nén đơn điệu); gate sạch 15-a/15-c/15-d: tsc exit 0 · eslint exit 0 (toàn repo) · full suite **1370/1370 ×2** · live verify agent-browser (27 nơ-ron đếm được trong svg + dialog mở/đóng đúng contract + tab Kiến trúc mất panel brain nhưng GIỮ graph/inspector/Q/SAL + 0 lỗi console + persistence reload). **Hiệu đính qua đợt fixbug FB-BRAIN-LIVE khép kết 2 vòng (2026-10-12 — R1 audit độc lập 11 phát hiện + R2 verify + 2 mini; BUG2-200..210, biên bản fixbug.md):** head surrogate đồng bộ 2 CHIỀU qua `initialHead`/`onHeadChange` (honest gap (a) ĐÃ ĐÓNG — poll activity theo head đang xem) · pan clamp giữ ≥10% vùng nhìn ((c) ĐÃ ĐÓNG) · resize handle Smolab nhường hit-area cho tab bar ((d) ĐÃ ĐÓNG — chỉ bỏ `-bottom-2`) · vocab query dormant cache TTL 60s module-level ((i) ĐÃ ĐÓNG — TTL thay DISTINCT để giữ parity pipeline train) · dọn scaleV chết + import bezierTangentDeg chết + doc số dòng + r92 READ-ONLY pin đủ 5 bảng + stripComments string-aware + 4 expect pin wiring head (r92: 30 test / 289 expect) · gate khép: tsc/eslint/imports sạch + full suite **1400/1400 ×2** (65 file = 64 + r92). Honest gaps còn mở: (b) calibration_v3 dormant không inputVector (thiết kế trung thực) · (e) SOURCE_BADGE 2 nguồn (by-design) · (f) one-hot thô có nhãn nguồn · zoomAt chưa clamp biên (chuẩn map-UX, pan đã clamp).
>
> **Nhật ký hiệu đính 0.9 → 0.10 (triển khai BRAIN-UX §9, 2026-10-12 — USER CHỐT TOÀN BỘ §8 mục 7+8+9: *"Tôi chốt hết tất cả theo đề xuất. Tiến hành triển khai phần UI/UX"* → triển khai trọn §9 UX-1→UX-5 đúng thứ tự; **hiệu đính doctrine #4 (commit)**: phiên triển khai sandbox gián đoạn giữa chừng nên cả 5 giai đoạn + đợt fixbug FB-BRAIN-UX khép kết (3 vòng: R1 11 phát hiện fix 11/11 · R2 verify 11/12 + 2 phát hiện mới + weights-route policy unwrap ngoài scope · R3 mini khép — BUG2-185..199, biên bản fixbug.md) nằm chung 1 working tree đã xác minh (gate 4 tầng 1370/1370 ×2 liên tiếp) → gộp 1 commit `feat(BRAIN-UX)` thay vì 5 commit riêng — tách lịch sử lúc commit-time sẽ tạo commit trung gian fail test (pin TUNING_SPECS 19→25 chỉ đúng ở mốc cuối))):** **UX-1 Brain Studio** — `src/lib/brain/spec-schema.ts` (single-source doctrine #9 — client + server cùng rule `validateBrainDraft`) + model thứ 100 `BrainSpecDraft` (migration `20261012143000_add_brain_spec_draft`, additive) + `GET/PUT /api/brain/spec-draft` + editor lớp ẩn 0–6 × units 1–256 × menu 9 activation (softmax chỉ output đa lớp — audit B1) + bộ đếm tham số realtime (cảnh báo >100K, chặn >250K — điểm chặn thật `mlp.validateSpec`) + Lưu nháp / Phục hồi spec chuẩn / So sánh với bản active (diff) + cờ `ui_brain_edit` (TUNING_SPECS 20) + nút "Chọn não" thay grid 3 thẻ. GIỮ NGUYÊN bất biến §9.1-1: draft KHÔNG bao giờ chạm `BrainModel.active` (test r88-J pin). **UX-2 Training Console** — `src/components/database/training-console.tsx`: nhóm A siêu tham số (optimizer · lr thang log 1e-4→1 · epochs 50–5000 · batch 8–256 · L2 · patience · holdout 10–30% · clip 1–10 · seed) ghi vào draft; nhóm B λ từng đầu Brain-B (Σλ=1 tự động; **quyết định triển khai trung thực**: 3 head là 3 MLP RIÊNG → scale λᵢ×3 áp gradient head đó qua `FitOptions.lossScale` mới của mlp.ts — chia đều = 1.0/head = ĐÚNG hành vi trước UX-2, pin hồi quy r89; ghi chú Adam ~ trung hoà scale, tác dụng rõ với SGD; 2 đầu hồi quy đổi loss huber⇄mse được, success khóa BCE) + nhóm C composite reward override w₁w₂w₃ qua tuning-store `reward_w_outcome`/`reward_w_efficiency`/`reward_w_quality` (STORE›ENV›DEFAULT=1/3 — trùng `REWARD_WEIGHTS`, pin hồi quy r89; LOG-ONLY không đổi) + nút Huấn luyện gửi `useDraft` — draft vẫn đi ĐẦY ĐỦ cổng train→CV→thăng cấp (A1). Pipelines (calibration-v3/surrogate/policy) nhận `override?: BrainDraftSpec`; **quyết định về "tiến trình từng epoch"**: MLP nhỏ chạy ~giây — hiển thị QUỸ ĐẠO epoch đầy đủ (≤200 điểm downsample) SAU khi train xong thay vì stream realtime (over-engineering) — response train có `history` + `gradAbsMean` + `draftUsed`. **UX-3 Đường dây ánh sáng** — `src/lib/brain/stage-geometry.ts` (thuần; test r90: bezier · hit-target point-to-bezier · LOD 300 cạnh · lệch pha 0.37s · độ dày theo |gradient| · mũi tên tiếp tuyến) + `src/components/database/brain-stage.tsx` + `GET /api/brain/weights` (READ-ONLY, envelope đầy đủ cho inspector nơ-ron bias + |w| vào/ra TB + cạnh |w| — dữ liệu THẬT; chưa train → "không có bias/|w|", không trang trí suông) + mlp.ts `FitResult.gradAbsMean` (|gradient| trung bình từng lớp, tích lũy sau mean+L2+scale trước clip) persist vào trainMeta cả 3 pipeline + cờ `ui_synapse_fx` (TUNING_SPECS 21). Chế độ lan truyền NGƯỢC chỉ bật khi có gradAbsMean thật (đảo chiều + tông hổ phách + độ dày min-max 0.7–3.2); IntersectionObserver dừng ngoài viewport · prefers-reduced-motion → tĩnh có mũi tên · não ACTIVE hào quang thở 4s / NGỦ ánh sáng rất yếu tĩnh. **UX-4 Tái bố cục** — `neural-architecture-section.tsx`: dashboard 3 vùng (trái: Chọn não + ngưỡng thức tỉnh + phiên bản · giữa: sân khấu UX-3 + chú thích bất biến A1 · phải: Training Console + 2 tab Tham số runtime (25) + Nhật ký tinh chỉnh di chuyển từ dòng chảy chính); đồ thị hệ thống 6 lớp + node inspector + Q-table + SAL GIỮ NGUYÊN; <1024px console thành bottom-sheet (nút nổi ⚙, Esc đóng); lựa chọn não persist localStorage `tmo-brain-selected`; BrainCard/BrainArchDiagram xóa (thay bởi stage). **UX-5 Theme hi-tech** — `globals.css` tokens (`--ht-bg #05070D` · kính 2 mức · `@property --ht-angle`) + `[data-hitech='on']` CSS-driven toàn cục (không sửa từng component — rollout theo mô-đun sẽ làm đợt sau nếu user muốn): kính `.nc-panel` + vành sáng conic quay 6s (mask-xor; **hiệu đính triển khai**: inset 0 + padding 2px thay −1px vì 118 panel có clip-path chamfer cắt mất vành ngoài; `[data-slot='card'].nc-panel` cần override !important do rule `.dark` sẵn giữ background) + nút nhô `[data-slot='button']` gradient+inset+translateY ±1px + `pointer: coarse` tắt blur/spin + reduced-motion tắt mọi vòng lặp + nút `HiTechToggle` (sidebar dưới, localStorage tức thì + sync tuning `ui_hitech` (TUNING_SPECS 22) để audit, POST fail vẫn áp local — fail-open trình bày). Kèm CSS nợ UX-3 (`bs-flow` 2.4s · `bs-flow-bwd` · `bs-glow-active` thở 4s · `bs-glow-dormant`). **Tests r88–r91** — 79 test mới (r88 29 · r89 15 · r90 23 · r91 12; pattern round, DB-cô-lập) + pin update r87/r86/r81 (TUNING_SPECS 19→25, paramKeys 7→13 — đếm thật 13, Task 9 đếm nhầm 14); full suite **1370/1370 pass ×2 liên tiếp**. **Ghi nhận trung thực để đợt fixbug xử lý**: (a) `strokeWidthForGrad` JSDoc "Toàn 0 → 1.1" nhưng (0,[0,0]) thực đo 1.95 (nhánh hi≤lo trả trung vị min/max) — caller chặn qua hasBackData nên chưa tới UI; (b) nợ contrast TIỀN TỒN TẠI trước UX-5: stone-600 #57534e trên nền sâu = 2.64:1 (dưới cả AA large-text), stone-500 = 4.20 — không đổi màu chữ theo phạm vi UX-5, ghi Bug_v2; (c) nền sâu bị wallpaper user che một phần (bàn ở rollout theo mô-đun).
>
> **Nhật ký hiệu đính 0.8 → 0.9 (triển khai BRAIN-P4, 2026-10-12 — user chốt Q1 + duyệt triển khai cùng ngày):** §4.4 HOÀN TẤT — `src/lib/brain/brains/policy.ts` (Brain-C "Lệnh": MLP `D→32(tanh)→|A|(softmax)+crossEntropy` — cặp gộp sẵn có của nền toán P1, KHÔNG đụng mlp.ts) + đặc trưng `task-features` (agent one-hot + delegated — MỌI đặc trưng có TRƯỚC run, action=model là ĐẦU RA không bao giờ làm input; mode vector pca-128/mrl-512 chờ Q2 như P2/P3 — từ chối rõ ràng) + mục tiêu train **reward-weighted imitation qua replication** (mỗi mẫu nhân bản round((R+1)/2 × 8) bản — xấp xỉ rời rạc của weighted-CE Σwᵢ·(−log π(aᵢ|xᵢ)) vì mlp.ts không hỗ trợ sample-weight; R=−1 → 0 bản = không bắt chước; KHÔNG claim "học tránh" — ghi nhận thẳng trong JSDoc) + **λ công thức tường minh** (audit C2): `λ = 1 − min(clamp(n/K,0,1), wilsonLB(p̂,n))` với K=200, p̂ = success rate tập train — phần π_net bị chặn TRÊN bởi CẢ ramp số mẫu lẫn Wilson 95% lower bound ("chặn dưới Wilson CI" §4.4 = sàn của λ); thiếu dữ liệu → cả 2 ≈ 0 → λ→1 nghe Q nguyên vẹn (fail-open). HIỆU ĐỈNH: công thức literal §4.4 `λ = clamp(n/K,0,1)` mâu thuẫn nội tại (clamp TĂNG theo n trong khi §4.4 đòi λ GIẢM + thiếu dữ liệu λ→1) — triển khai theo 2 ý định tường minh "giảm dần khi dữ liệu lớn lên" + "thiếu dữ liệu → λ→1" + composite reward **LOG-ONLY** (`src/lib/brain/reward.ts` — R = w₁·Outcome* + w₂·Efficiency* + w₃·Quality*, mỗi thành phần chuẩn hóa trước khi nhân trọng số đúng audit C1: Outcome* ∈ {0,1} verdict/run-complete · Efficiency* = (median_model − tokens)/median_model kẹp [−1,1] · Quality* = faithfulness ∈ [0,1] — agent-run phase này KHÔNG có nguồn faithfulness → null → renormalize w₁+w₂, ghi nhận thẳng; trọng số khởi điểm 1/3 mỗi thành phần kèm chú thích nguồn — sweep dữ liệu chưa khả thi trên DB rỗng 0 run, `sweepRewardWeights()` đã có + report `GET /api/brain/policy`; reward ghi song song console + report mỗi run close, KHÔNG tham gia updateQ — W1/W2 giữ nguyên nhị phân ±1; "2 đợt quan sát" tính từ v0.9) + 5-fold CV stratified theo Outcome* so **π_Q đối chứng** (CE hold-out của mixture < CE π_Q — ngặt; π_Q = softmax(Q/τ) từ QEntry thật, τ runtime_model_tau) + cổng active kép (CV thắng NGẶT + đủ 3 ngưỡng §2: usable ≥ 30 · QEntry ≥ 30 · ArbiterVerdict ≥ 50) + steering 3 cơ quan: (1) model routing `maybeApplySoftmaxModelPolicy` llm.ts — mixture thay probs khi master + organ on + active (3 lớp fail-open, seed-pick giữ nguyên); (2) adaptation directives — advisory block vào systemBlocks workflow-engine (chỉ text, không đổi quyết định); (3) tuning-store — `buildTuningProposals()` ĐỀ XUẤT read-only qua report, người duyệt vẫn là user qua UI; **mỗi organ kill-switch độc lập `policy_organ_routing`/`policy_organ_adaptation`/`policy_organ_tuning`** (TUNING_SPECS 16–19, mặc định off) + cờ master `runtime_policy` (TUNING_SPECS thứ 16 — 4 cờ mới gắn node softmax-policy) + auto-train sau agent run (agent-goal-loop.ts — cạnh Brain-B) + `GET /api/brain/policy` (report READ-ONLY: trạng thái cờ/organ + active + λ + reward log-only gần đây + sweep + proposals) + test `r87`. Ghi chú phạm vi: inputMode vector chờ Q2; organ (2)(3) là LỚP ĐỀ XUẤT text/read-only — "chuyển hẳn" sang nghe brain chờ dữ liệu đối chứng đủ mạnh (đúng thiết kế từng bước); đặc trưng `delegated` tại 2 điểm wiring tạm impute false (tầng gọi không biết parentRunId — ghi nhận BUG2-168). **Hiệu đính qua 2 đợt fixbug cùng ngày (FB-BRAIN-P3 3 vòng · FB-BRAIN-P4 3 vòng — 20 phát hiện → BUG2-165..184, gate 1291/1291 PASS 2 lần liên tiếp):** đỉnh — nhãn Outcome* thống nhất 3 chỗ dùng (BUG2-166) · per-head fail-open THẬT + guard weights không-finite cửa nạp phát hiện lớp null-weight âm thầm tệ hơn NaN (BUG2-173) · λ công thức hiệu đính mâu thuẫn nội tại §4.4 (BUG2-175) · gate P3 không tái lập được root-cause kép: bun test = 1 process mọi file + set-tuning-không-reset (BUG2-165/169/182).
>
> **Nhật ký hiệu đính 0.7 → 0.8 (triển khai BRAIN-P3, 2026-10-12):** §4.3 HOÀN TẤT — `src/lib/brain/brains/surrogate.ts` (Brain-B "Vọng": 3 MLP đầu-ra-riêng — success `D→16(tanh)→1(sigmoid)+BCE` · tokens/duration `D→16(tanh)→1(linear)+Huber` trong log1p space, chọn phương án "3 model riêng" vì mlp.ts gắn 1 loss/mạng — không đụng nền toán đã fixbug) + đặc trưng `runs-features` (model one-hot + agent one-hot + delegated — MỌI đặc trưng có TRƯỚC khi run bắt đầu, cycles/tokens/duration là nhãn KHÔNG BAO GIỜ làm input) + 5-fold CV stratified fold-chung-3-đầu so baseline (success base-rate Brier — cổng active; tokens/duration median log1p MAE) + `POST /api/brain/replay` (READ-ONLY tuyệt đối: history bootstrap CI luôn chạy, ước lượng MLP chỉ khi cờ on + active + đầu thắng CV — per-head fail-open) + cờ `replay_eval` (TUNING_SPECS thứ 15, gắn node softmax-policy) + auto-train sau agent run (agent-goal-loop.ts) + **single-flight lock A7** (`src/lib/brain/train-lock.ts` — wired cho CẢ 2 brain) + test `r86` 45 test (SIGNAL 3 seed thắng NGẶT 0.185–0.191 vs base 0.232–0.250, AUC 0.75–0.78 kèm Hanley–McNeil CI kẹp [0,1]; NOISE thắng/thua theo seed 4/10 — pin seed 51 thua, cùng tinh thần FB-BRAIN-P2-R1-02; replay read-only pin count; stds full precision / stds=0 → null kế thừa FB-BRAIN-P2-R1-01). Ghi chú phạm vi: mode vector `pca-128`/`mrl-512`/`full-2048` chờ Q2 như P2; k-NN lịch sử (Qdrant) là mục TÙY CHỌN §5.4 — chưa làm đợt này; `strategy` của replay config chưa có cột trong AgentRunRecord (StrategyAdaptationLog còn 0 dòng) — lớp nhiệm vụ tạm dùng agentName.
>
> **Nhật ký hiệu đính 0.6 → 0.7 (đợt fixbug FB-BRAIN-P2, 2026-10-12):** rà soát độc lập vòng R1 trên toàn scope BRAIN-P2 (commit a97cd3f) — auditor mắt tươi 8 phát hiện (1 C·P3 + 7 P4), chấm chéo độc lập tái lập 8/8, fix toàn bộ + 7 test regression (r85 28→35): (R1-01 P3) `stds` chuẩn hóa lưu full precision — round5 từng ép cột near-constant (std ∈ (1e-12, 5e-6)) về 0 → (v−mean)/0 = ±∞/**NaN lan ra runtime confidence**; giờ `loadActiveV3` chặn stds ≤ 0 → null (fail-open về V2) · (R1-06) `dataLineage` §5.3 đầy đủ hơn: `evalRunIds` danh sách (hash sha256 khi > 50) + `EvalCase` đếm đúng case góp mẫu · (R1-03/04/05) hợp đồng chặt: `crossValidateV3` ném lỗi length-mismatch + folds phải nguyên ≥ 2, `applyV3Model` ném lỗi stats sai chiều/std 0/kết quả không hữu hạn (caller catch → null) · (R1-08) POST mode-sai trả telemetry số thật · (R1-02) đính chính claim test noise (gate V3<V2 là so-sánh-đối-chứng, không phải bất biến "tự chối noise" — thắng/thua theo seed) · (R1-07) 2 comment sai chi tiết sửa đúng (specJson nạp bằng `new MLP`; 193 tham số). Lưu ý còn lại ngoài scope: V2 `parseV2ModelJson` chia sẻ lỗ hổng storage-round5-stds — bàn đợt fixbug sau.

> **Nhật ký hiệu đính 0.5 → 0.6 (triển khai BRAIN-P2, 2026-10-12):** §4.2 HOÀN TẤT — `src/lib/brain/calibration-v3.ts` (train pipeline + 5-fold CV so V2 đối chứng train-lại-từng-fold + runtime apply fail-open) · cờ `calibration_v3` thêm vào TUNING_SPECS (tham số thứ 14 — chuỗi STORE > ENV > DEFAULT=off, gắn node Goal Loop) · chuỗi runtime `getCalibratedConfidence` V3→V2→V1→raw · `POST /api/brain/train` + `BRAIN_TRAINABLE_KEYS` (nút Huấn luyện lại chỉ sống cho brain có pipeline) · auto-train sau eval run (eval/runner.ts) · test r85 28 test (XOR quan hệ thật → V3 thắng CV rõ 0.11–0.14 vs 0.26; noise → không thắng; rollback/prune/fail-open mọi nhánh). Ghi chú phạm vi: phase này inputMode `features-10` (so sánh sạch cùng 10 đặc trưng V2) — mode vector `pca-128`/`mrl-512` vẫn chờ Q2 (§8 mục 3); V3 thua CV vẫn ghi bản vết audit `active=false` (không đụng bản active cũ).
>
> **Nhật ký hiệu đính 0.4 → 0.5 (đợt FB-BRAIN-P1 — giao thức fixbug sau triển khai P1, 2026-10-12):** đợt 13 phát hiện R1 (auditor độc lập) fix toàn bộ trong đó 3 mục đụng doc: (1) §4.1 ký hiệu interface optimizer `step(grads, params)` → **`step(params, grads)`** cho khớp code (FB-BRAIN-P1-R1-07); (2) nguyên tắc "chặn > 250K tham số" (§9.1-3) ghi rõ điểm thực thi tại **`validateSpec` — hằng `BRAIN_MAX_PARAMS = 250.000`** trong mlp.ts, mọi lối xây MLP đều bị chặn từ lớp toán (FB-BRAIN-P1-R1-08); (3) §9.2 badge tổng nhãn: làm rõ khi **MỌI nguồn đếm lỗi (current null hết) → ẨN badge**, không hiển thị "0 nhãn" — 0 chỉ có nghĩa khi đếm được và bằng 0 (FB-BRAIN-P1-R1-12).
>
> **Nhật ký hiệu đính 0.3 → 0.4 (chỉ thị user 2026-10-12 — trước khi triển khai):** §9.2 bổ sung yêu cầu **tổng nhãn vận hành tích lũy** hiển thị cạnh phải dòng tiêu đề panel Não vận hành (luôn hiện, cộng theo nguồn không trùng, fail-open — áp dụng sớm cùng ngày); §4.5 ghi nhận xác nhận user: **P5 để xa về sau, chỉ cần khi tự huấn luyện model riêng** — hiện chưa cần; user duyệt triển khai **BRAIN-P1** (§8 mục 1) — nền toán `mlp.ts` + `activations/losses/init/optimizers` + test `r84` (đã triển khai cùng ngày — 41/41 PASS).
>
> **Nhật ký hiệu đính 0.2 → 0.3 (góp ý UI/UX của user, 2026-10-12):** bổ sung **§9 BRAIN-UX — phase UI/UX cuối cùng** (đặt sau khi hoàn thành P1→P4 theo chỉ thị): UX-1 Brain Studio (nút chọn bộ não + chỉnh sửa kiến trúc: thêm/bớt lớp, số nơ-ron/lớp, menu activation mở rộng đủ 9 hàm sigmoid/linear/tanh/ReLU/Leaky ReLU/ELU/Swish/GELU/softmax) · UX-2 Training Console (chỉnh trọng số loss từng đầu ra + siêu tham số khối train + override composite reward qua tuning-store) · UX-3 "đường dây ánh sáng" bezier động hiển thị hướng lan truyền, click sửa được lớp/nơ-ron/cạnh · UX-4 tái bố cục tab Kiến trúc (giữ nguyên đồ thị hệ thống 6 lớp — phần user đánh giá tốt) · UX-5 theme dark-hi-tech toàn app (viền sáng chuyển động, nút nhô bóng, cờ `UI_HITECH`) · bảng mới `BrainSpecDraft` (additive — model 100) · test r88–r91 · §8 thêm mục chờ duyệt 7–9 · ghi chú chéo menu activation mở rộng vào §4.1.
>
> **Nhật ký hiệu đính 0.1 → 0.2 (audit 2 lượt — vai System & AI Architecture Auditor, 2026-10-12):** lượt 1 xác thực toàn bộ claim file:line / hằng số / đếm bảng — **khớp 100%** (đo lại live cùng ngày: AgentRunRecord=20, ArbiterVerdict=10, EvalResult=4, EvalCase=9, LessonRecord=25, EpisodeRecord=56, QEntry=1, StrategyAdaptationLog=0, KpiSnapshot=11, TuningParam=0; `stats/pca.ts` có sẵn; test kế tiếp đúng r84; đúng 98 model; đúng 9 nguyên tắc doctrine; `src/lib/embeddings.ts:46` đúng từng dòng). Lượt 2 bổ 12 điểm còn thiếu: A1 bất biến "1 bản active mỗi brain", A2 chính sách prune + ước lượng size weights, A3 kỷ luật migration (không db-push trần), A4 index `[brain, active]`, A5 cột `trainedAt`, A6 envelope weights numpy-đọc-được, A7 single-flight train lock, B1 softmax chỉ dùng lớp output, B2 early-stopping hold-out 15%, B3 ổn định số BCE/log-sum-exp, C1 chuẩn hóa thành phần composite reward, C2 công thức mixture policy — đã vá thẳng vào các mục tương ứng.
>
> **Nguồn gốc chuỗi thảo luận:**
> 1. Thẩm định cấp độ kiến trúc Level 0–3 (kết luận: **Level 1 — RL-Based Tuning**, không có ANN thật) — tab Database > Kiến trúc hiện hiển thị đồ thị hệ thống ẩn dụ, chưa có mạng nơ-ron vận hành.
> 2. Đề xuất "bộ não TMO" của user: *đóng băng LLM, tích lũy dữ liệu & bài học, một bộ não tự xây tự huấn luyện điều khiển hành vi các model khi gọi ra* — triết lý **LoRA-style** (freeze base + học phần điều chỉnh nhỏ), NHƯNG không sửa trọng số LLM (điều đó cần GPU backprop qua model tỷ tham số — ngoài hạ tầng hiện tại).
>
> **Quan hệ với blueprint khác:** KHÔNG thay thế `BLUEPRINT-STATS-LEARNING-P0-P6.md` (đã hoàn tất 100% — P0→P6 đều commit). BRAIN là **tầng kế tiếp**, tái sử dụng nguyên vẹn hạ tầng P0–P6: thư viện `src/lib/stats/`, `QEntry` + q-table, `StrategyAdaptationLog`, Wilson CI, pattern 5-fold CV + fail-open của `CalibrationModelV2`, tuning-store (STORE > ENV > DEFAULT), cron scheduler.
>
> **Doctrine giữ nguyên:** additive-only · fail-open · cờ mặc định OFF · hardcode từ dữ liệu · **không thêm DB/framework mới** (P1–P4 thuần TypeScript, không dependency ngoài) · 1 phase = 1 commit + quality-gate PASS · test theo pattern round (bắt đầu r84).

---

## 0. TÓM TẮT ĐIỀU HÀNH

| Phase | Việc | File chính | Effort | Cờ/Điểm dừng |
|---|---|---|---|---|
| **BRAIN-P1** | Nền toán MLP (lan truyền tiến/ngược, activation, loss, optimizer) + kho trọng số `BrainModel` + hiển thị **ANN thật** trên tab Kiến trúc | mới `src/lib/brain/{mlp,activations,losses,optimizers,init}.ts` · `prisma/schema.prisma` (+1 model) · `src/components/database/neural-architecture-section.tsx` (panel mới) | M | Không đổi hành vi runtime nào — thuần nền tảng + hiển thị. **HOÀN TẤT (2026-10-12): UI + `BrainModel` + `/api/brain` + `registry.ts` áp dụng sớm + nền toán 9 activation/4 loss/2 optimizer + test r84 41/41 PASS** |
| **BRAIN-P2** | **Brain-A** — Calibration V3: MLP 2 lớp thay logistic V2 khi thắng đối chứng CV | mới `src/lib/brain/calibration-v3.ts` · sửa `src/lib/calibration.ts` (điểm cắm runtime) | M | `CALIBRATION_V3=off`. **HOÀN TẤT (2026-10-12): train pipeline + 5-fold CV ngặt + cờ `calibration_v3` (TUNING_SPECS thứ 14) + `POST /api/brain/train` + auto-train sau eval run + test r85 35/35 (sau FB-BRAIN-P2)** |
| **BRAIN-P3** | **Brain-B** — Surrogate Predictor (dự đoán kết quả cấu hình KHÔNG chạy thật) + chế độ replay-eval | mới `src/lib/brain/brains/surrogate.ts` + `src/app/api/brain/replay/route.ts` | L | `REPLAY_EVAL=off` (chỉ đo/báo cáo). **HOÀN TẤT (2026-10-12): 3 MLP đầu-ra-riêng + CV fold-chung vs baseline + replay READ-ONLY bootstrap CI + auto-train sau agent run + A7 single-flight lock + test r86 45/45** |
| **BRAIN-P4** | **Brain-C** — Policy head theo đặc trưng nhiệm vụ + **composite reward** + chuyển dần cơ quan lái (directives / model routing / tuning) sang nghe brain | mới `src/lib/brain/brains/policy.ts` + reward ledger thống nhất · sửa `adaptation-engine.ts` / `llm.ts` (từng cơ quan một) | L | `RUNTIME_POLICY=off` · từng cơ quan có kill-switch về hành vi cũ. **HOÀN TẤT (2026-10-12): mixture π = λ·π_Q + (1−λ)·π_net (λ = 1−min(n/200, WilsonLB) — fail-open) + reward-weighted imitation qua replication + CV CE so π_Q + composite reward LOG-ONLY (reward.ts — đợt quan sát 1) + steering 3 cơ quan mỗi cái kill-switch `policy_organ_*` + auto-train sau agent run + A7 wired cả 3 brain + report GET /api/brain/policy + test r87** |
| **BRAIN-P5** | Biên giao tiếp GPU/Python (Keras/PyTorch sidecar, GCN trên Neo4J — đường lên Level 3) | mini-service python (dài hạn, **chỉ khi có GPU**) | XL | Ngoài phạm vi lộ trình này — chỉ chốt contract |
| **BRAIN-UX** (§9) | **Phase UI/UX cuối cùng** — Brain Studio (nút chọn não + sửa kiến trúc: thêm/bớt lớp, số nơ-ron, menu 9 activation) · Training Console (trọng số loss từng đầu ra + siêu tham số train) · đường dây ánh sáng động có hướng, click sửa được lớp/nơ-ron/cạnh · tái bố cục tab Kiến trúc · theme dark-hi-tech toàn app (viền sáng chuyển động, nút nhô bóng) | `neural-architecture-section.tsx` + mới `src/lib/brain/spec-schema.ts` · `BrainSpecDraft` (+1 model) · `globals.css` tokens | L (UX-1→UX-5) | `UI_BRAIN_EDIT` / `UI_SYNAPSE_FX` / `UI_HITECH` = off · **đặt SAU P1→P4 theo chỉ thị user (2026-10-12)** — UX-3/4/5 thuần trình bày, kéo sớm được theo chỉ thị · **HOÀN TẤT (2026-10-12): UX-1→UX-5 triển khai đủ — `spec-schema` + `BrainSpecDraft` (model 100) + `/api/brain/spec-draft` + `/api/brain/weights` + 3 component (`brain-studio`/`brain-stage`/`training-console`) + dashboard 3 vùng + theme hi-tech CSS-driven + tests r88–r91 (79 test); 3 cờ mặc định off** · **BRAIN-LIVE (2026-10-12): HOÀN TẤT — di chuyển sang Smolab tab BRAIN + não hiển thị thật từng nơ-ron (cap 256) + activity READ-ONLY live 2.5s + zoom/pan + dialog params (chỉ thị user; `ui_synapse_fx` mặc định chuyển ON — chi tiết nhật ký hiệu đính 0.10→0.11 đầu file)** |

**Thứ tự bắt buộc:** P1→P4 ✅ → **BRAIN-UX (§9) ✅ HOÀN TẤT 2026-10-12** → còn treo: P5 (dài hạn, chỉ khi có GPU). P5 độc lập (chỉ chốt giao tiếp trong P1–P4 để không làm lại).

---

## 1. KIẾN TRÚC ĐÍCH — BỘ NÃO TMO VÀ VAI TRÒ 3 KHO

```
┌────────────────────────────────────────────────────────────────────┐
│                         BỘ NÃO TMO (đích)                           │
├────────────────────────────────────────────────────────────────────┤
│ GIÁC QUAN (input)                                                  │
│   Qdrant: vector nemotron-3-embed-1b 2048-dim (chính)              │
│           + pilot 512-dim Matryoshka (P5-M1 stats blueprint)       │
│   SQLite: đặc trưng vận hành (model, strategy, tokens, cycles…)    │
├────────────────────────────────────────────────────────────────────┤
│ NÃO VẬN HÀNH — các MLP nhỏ train CPU (thuần TypeScript)           │
│   Brain-A "V3":  calibration độ tin KB (MLP thay logistic)         │
│   Brain-B "Vọng": surrogate dự đoán success/tokens/latency         │
│   Brain-C "Lệnh": policy chọn model/chiến lược theo nhiệm vụ       │
│   (mỗi brain: thức tỉnh theo ngưỡng mẫu, ngủ khi thiếu dữ liệu)    │
├────────────────────────────────────────────────────────────────────┤
│ NÃO THANH QUẤN (steering — tác động lên LLM ĐÓNG BĂNG)             │
│   = cơ quan ĐÃ CÓ: adaptation directives (8 chiến lược),           │
│     Q-advice badge/PLAN-hint, softmax(τ) model routing,            │
│     13 tham số runtime tuning-store                                │
│   → P4 chuyển dần các cơ quan này sang nghe Brain-B/C              │
├────────────────────────────────────────────────────────────────────┤
│ TRÍ NHỚ DÀI HẠN + HỒI GIAO                                         │
│   Neo4J: knowledge graph (95.587 nodes / 204.251 rels)             │
│   SQLite: Episodic log (nguyên liệu huấn luyện) + bảng BrainModel  │
│           (trọng số + spec + lineage sau train)                    │
└────────────────────────────────────────────────────────────────────┘
```

**Phân định vai trò (trả lời nguyên tắc "dùng 3 kho làm ANN"):** các kho **không tự thành mạng nơ-ron** — Qdrant là *giác quan* (vector đầu vào), Neo4J là *trí nhớ cấu trúc*, SQLite là *hồi giao* (log huấn luyện) và *nơi cất trọng số* (`BrainModel`). Mạng nơ-ron thật = ma trận W₁…Wₗ trong `src/lib/brain/mlp.ts`, train bằng gradient descent từ dữ liệu các kho đổ về SQLite.

**Định vị trung thực so với LoRA:** LoRA kỹ thuật = ΔW = B·A nhét vào lớp attention của LLM, học bằng backprop xuyên qua model — **không khả thi không GPU**. BRAIN = **learned adapter ngoài LLM**: tác động qua bề mặt giao tiếp (prompt/routing/retrieval/ngưỡng). Triết lý giống ("hành vi thích ứng, não gốc đóng băng"), tầng kỹ thuật khác — ghi rõ để không kỳ vọng sai.

---

## 2. BỐI CẢNH DỮ LIỆU (đo ngày 2026-10-11) & NGƯỠNG THỨC TỈNH

| Nguồn nhãn | Bảng | Hiện có | Ngưỡng thức tỉnh đề xuất |
|---|---|---|---|
| Kết cục run thật | `AgentRunRecord` | 20 | Brain-B cần ≥ 60 (đối chứng bootstrap CI) |
| Phán quyết trọng tài | `ArbiterVerdict` | 10 | reward composite cần ≥ 50 verdict |
| Eval KB retrieval | `EvalResult` / `EvalCase` | 4 / 9 | Brain-A cần ≥ 30 (kế thừa `MIN_TRAIN_SAMPLES_V2`) |
| Bài học / tập | `LessonRecord` / `EpisodeRecord` | 25 / 56 | tín hiệu tự giám sát, không chặn |
| Q-learning | `QEntry` | 1 | policy head chỉ thức tỉnh khi Q có ≥ 30 entry |
| Thích ứng chiến lược | `StrategyAdaptationLog` | 0 | (vòng mới bật, chưa phát sinh) |
| KPI | `KpiSnapshot` | 11 | giám sát, không huấn luyện trực tiếp |

**Nguyên tắc "thức tỉnh theo ngưỡng":** mọi brain sinh ra ở trạng thái **ngủ** (chưa đủ mẫu → hành vi y hệt hiện tại). Chỉ khi (a) đủ số mẫu ngưỡng, (b) thắng đối chứng qua CV có CI, (c) user bật cờ → mới tham gia runtime. Đây chính là *"dữ liệu và bài học dần dần tích lũy"* — không ai phải đợi, không restart, không rủi ro hồi quy.

> **Điểm quan trọng về kho tài liệu lớn:** nguồn tài liệu lớn của user sau ingestion trở thành (i) **nguyên liệu học truy hồi** (retrieval — đã chạy mỗi ngày), (ii) **nguyên liệu tự giám sát** cho Brain (P3 tùy chọn — xem §5.4), (iii) **ngữ cảnh đặc trưng** (embedding nhiệm vụ). Kho lớn KHÔNG tự sinh nhãn "thành/bại" — nhãn đó chỉ đến từ vận hành thật (verdict, kết cục run) — nên kho lớn đủ sớm nhưng brain vẫn thức tỉnh dần theo vận hành. Chi tiết vòng học trong tác vụ thật: §5.

---

## 3. BỐN QUYẾT ĐỊNH MỞ (thảo luận với user — CHƯA CHỐT)

### 3.1 — Q1: Hàm thưởng, lan truyền tiến/ngược, hàm tối ưu hóa có chưa?

**Sự thật hôm nay (file:line):**

| Thành phần | Trạng thái | Bằng chứng |
|---|---|---|
| **Hàm thưởng (RL)** | ✅ CÓ — dạng thô {+1, 0, −1} | `q-table.ts` (W1 `markSessionAdaptationOutcome` + W2 `resolveArbiterVerdicts` — reward chốt từ verdict trọng tài & kết cục run thật) |
| **Lan truyền tiến** | ✅ CÓ — 1 lớp (sigmoid logistic) | `calibration-multifeature.ts` (V2 runtime áp β qua sigmoid) + `softmaxPolicy()` (Boltzmann chọn model — là phép softmax chính tắc, không phải forward của mạng đã train) |
| **Lan truyền ngược** | ⚠️ CÓ — chỉ 1 lớp (đạo hàm log-loss, không phải backprop đa tầng) | `calibration-multifeature.ts` (mini-batch GD lr 0.05 × 1500 epoch) |
| **Hàm mất mát** | ✅ CÓ — 1 (log-loss + L2) | `calibration-multifeature.ts` |
| **Hàm tối ưu hóa** | ⚠️ CÓ — mini-batch GD thuần (không momentum, không Adam) | `calibration-train.ts` (lr 0.01 × 1000) / `calibration-multifeature.ts` (lr 0.05 × 1500) |

**BRAIN-P1 bổ sung đủ bộ chuẩn** (mục §4.1): đa lớp forward/backward (chain rule), menu activation (ReLU/tanh/sigmoid/softmax + đạo hàm), menu loss (BCE/MSE/Huber), **optimizers SGD+momentum (β=0.9) và Adam (β₁=0.9, β₂=0.999)**, khởi tạo He/Xavier có seed tất định, gradient clip, early stopping.

**Về "hàm thưởng" cho kiến trúc brain:** cần tách 2 chế độ học —
- **Supervised brain (A, B):** mục tiêu là *loss* trên nhãn (verdict/eval/kết cục) — không cần reward riêng.
- **RL brain (C):** reward có sẵn W1/W2 nhưng đang nhị phân thô. **BRAIN-P4 định nghĩa composite reward liền mạch:** `R = w₁·Outcome* + w₂·Efficiency* + w₃·Quality*` — **mỗi thành phần PHẢI chuẩn hóa trước khi nhân trọng số** (audit C1: tokens ~10³–10⁵ trong khi faithfulness 0–1 — nhân thẳng thì w vô nghĩa): `Outcome* ∈ {0,1}` (verdict/run-complete), `Efficiency* = (baseline − thực tế)/baseline` kẹp [−1,1] với baseline là trung vị theo model (hạ tầng Wilson/ANOVA P4-M2 đã có), `Quality* = faithfulness ∈ [0,1]`. Trọng số w khởi điểm từ sweep dữ liệu rồi hardcode kèm chú thích nguồn (doctrine #1). Reward mới chỉ ghi song song (log-only) ít nhất 2 đợt quan sát trước khi tham gia quyết định — đúng tiền lệ P6-M3.

**Trạng thái: CHỜ USER CHỐT** — khuyến nghị: duyệt P1 (thuần nền tảng, không đổi hành vi).

### 3.2 — Q2: NIM 2048-dim — đầu vào 512-dim pilot có phù hợp?

**Sự thật kỹ thuật:** model đang chạy là `nvidia/nemotron-3-embed-1b` (NIM, 2048-dim — `src/lib/embeddings.ts:46`). Model này **hỗ trợ Matryoshka Representation Learning** (tham số `dimensions` trong payload — `src/lib/embeddings.ts:48`; `input_type` query/passage — dòng 10–11; pilot đọc runtime qua `getTuningEnum` — dòng 25 & 50). Pilot P5-M1 (stats blueprint) đã dựng sẵn: dual-write bản truncate 512-dim vào collection pilot, **đường đọc vẫn 2048 cho tới khi recall đối chứng đạt** — hiện pilot mặc định OFF (`MATRYOSHKA_PILOT` off, `TuningParam` = 0 dòng).

**Đánh giá phù hợp cho BRAIN input:**
- ✅ **Phù hợp về kỹ thuật MRL**: 512 chiều đầu của vector MRL giữ phần lớn ngữ nghĩa — NVIDIA thiết kế đúng để truncate.
- ✅ **Bộ não cần ít trung thực hơn retrieval**: để phân loại "nhiệm vụ loại nào / cấu hình nào tốt", tín hiệu 512-dim đủ phân biệt; không cần độ phân giải ngữ nghĩa đầy đủ như tìm kiếm.
- ⚠️ **Rủi ro thật là overfit chứ không phải mất thông tin**: input 512 + hidden 32 ≈ 16–17K tham số trong khi mẫu hiện 20–56 → L2 mạnh + early stopping + CV bắt buộc (đã là pattern của V2).
- ⚠️ **Điều kiện tiên quyết**: pilot phải được bật và đối chứng recall 512 vs 2048 trước khi chọn 512 làm input mặc định (chính mục đích pilot).

**Khuyến nghị của blueprint:** input là **tham số spec của brain** (`inputMode`), 3 chế độ —
| inputMode | Nguồn | Khi nào dùng |
|---|---|---|
| `mrl-512` | truncate từ vector 2048 đang có (không gọi API thêm) | mặc định SAU khi pilot đối chứng đạt |
| `pca-128` | PCA fit trên kho vector chính (tái dùng `stats/pca.ts`), ma trận hệ số lưu trong `BrainModel.specJson` | lựa chọn an toàn khi pilot chưa đạt — nén có kiểm soát, không phụ thuộc MRL |
| `full-2048` | vector gốc | đối chứng ablation (đắt nhất, dễ overfit nhất) |

P2 bắt buộc chạy ablation cả 3 (cùng dữ liệu, cùng seed) — chọn mode bằng số, không bằng cảm tính.

**Trạng thái: CHỜ USER CHỐT** — khuyến nghị: `pca-128` làm mặc định tạm, `mrl-512` bật sau đối chứng pilot.

### 3.3 — Q3: Tích hợp LangChain, LangGraph, Keras được không?

**Đánh giá từng thư viện (nguyên tắc doctrine: "không thêm framework mới"):**

| Thư viện | Tích hợp? | Lý do / Cái đã có tương đương trong TMO |
|---|---|---|
| **LangChain** (JS) | ❌ KHÔNG khuyến nghị | Trùng lặp năng lực: orchestration đã có `agent-goal-loop` + `omega-orchestrator` + `master-orchestrator` + `workflow-engine` + code-team/research-team; retriever đã có `kb-routing/` (hybrid, rerank, MMR, intent-classifier); loader/splitter đã có `ingestion/` + `chunking.ts`; memory đã có memory-tiers + episodic. Thêm vào = 2 hệ song song cùng chức năng, tăng bề mặt phụ thuộc. |
| **LangGraph** (JS) | ❌ KHÔNG khuyến nghị (giữ làm tham chiếu thiết kế) | Graph state machine + checkpointing đã có tương đương: goal-loop checkpoints, `state-management/checkpoint-manager`, `session-resume`. |
| **Keras** (Python) | ⏸ KHÔNG bây giờ — mở cửa P5 | TS không chạy Keras trực tiếp. Con đường hợp lệ: **mini-service Python sidecar** (platform đã có hạ tầng python runtime build + container runner — `tests/python-runtime-build.sh` / `python-runtime-container.sh`). Chỉ có lý do khi có GPU để train mô-đun lớn (GCN Neo4J, LoRA thật). P1–P4 thiết kế ngay **biên giao tiếp tương thích**: `BrainModel` spec/weights serialize theo format numpy-đọc-được (JSON mảng phẳng + shape), để sidecar tương lai đọc/ghi thẳng mà không làm lại kho. |

**Kết luận khuyến nghị:** P1–P4 thuần TypeScript (thuận kiểm thử, tất định, không phụ thuộc); **không tích hợp 3 thư viện trên trong lộ trình này**; P5 chốt contract sidecar (REST: train/predict/export) — khi có GPU thì Keras/PyTorch cắm vào mà không sửa não TMO.

**Trạng thái: CHỜ USER CHỐT** — khuyến nghị: không tích hợp, mở biên giao tiếp P5.

### 3.4 — Q4: Học từ kho tài liệu lớn trong tác vụ thật — học truy hồi + tăng cường + sâu + ghi ngược + truy vết nguồn?

**CÂU TRẢ LỜI NGẮN: CÓ — và hạ tầng đã có ~70%, BRAIN bổ đúng phần khuyết.** Phân tích từng cơ chế trong 1 tác vụ thật:

| Cơ chế user hỏi | Hôm nay | BRAIN bổ sung |
|---|---|---|
| **Học truy hồi** (retrieval-augmented) | ✅ đủ: hybrid search + rerank + MMR + intent-classifier (`kb-routing/`), citation `[Source N]` → `document_id` → metadata (`query/route.ts:55-233`) | P3: đặc trưng retrieval (coverage, nDCG, số chunk) thành **input của brain** thay vì chỉ hiển thị |
| **Học tăng cường** | ✅ vòng W1/W2 → Q-update (fail-open, tức thì — "online nhẹ") | P4: composite reward liền mạch + policy head |
| **Học sâu** | ❌ chưa có | P2–P3: Brain-A/B train từ log thật (offline batch có CV gate) |
| **Ghi ngược tri thức** (writeback) | ✅ đủ: writeback vùng xám + review + reconcile + transactional-writeback + drift-heal (`kb-routing/writeback*.ts`); lessons/episodes tự ghi | P4: khi brain chốt *"cấu hình X tốt cho loại nhiệm vụ Y"* (đủ CI) → ghi `LessonRecord` kèm provenance |
| **Truy vết nguồn tri thức sử dụng** | ✅ một phần: citation trong câu trả lời; evidence-log của research-team | **P3 bổ `dataLineage` đầy đủ** (xem §5.3): chuỗi tác vụ → chunk → document → verdict → reward → mẫu huấn luyện → phiên bản brain — trả lời được *"não này học từ nguồn nào, bao nhiêu mẫu, kết quả CV bao nhiêu"* |

**Điểm thiết kế quan trọng (học trong tác vụ THẬT):**
- **Hai tốc độ, không trộn:** (1) *online nhẹ* trong hot path — Q-update + episodes/lessons (rẻ, tức thì, fail-open — đã chạy); (2) *offline batch* — retrain brain định kỳ qua cron scheduler sẵn có, thăng cấp qua CV gate. **KHÔNG deep-learning online trong đường nóng** (nguy cơ catastrophic forgetting + độ trễ + khó kiểm chứng — trái doctrine fail-open).
- **Kho tài liệu lớn đóng 3 vai:** ngữ cảnh retrieval (mỗi ngày), nguyên liệu tự giám sát cho brain (§5.4), nguồn đặc trưng embedding. Kho lớn cho phép brain "ngủ an toàn" lâu hơn về dữ liệu ngữ cảnh nhưng vẫn chỉ thức tỉnh theo nhãn vận hành thật.
- **Chu kỳ khép:** tác vụ → học truy hồi → LLM đóng băng → đánh giá → reward → online nhẹ + offline batch → brain thăng cấp → steering chu kỳ sau mạnh hơn. Đúng mô tả của user: *"dữ liệu và bài học dần dần tích lũy, các model khi được gọi ra sẽ vận hành qua một bộ não do chúng ta xây dựng và tùy chỉnh"*.

**Trạng thái: CHỜ USER CHỐT** — khuyến nghị: duyệt nguyên tắc 2 tốc độ + dataLineage.

---

## 4. CHI TIẾT TRIỂN KHAI TỪNG PHASE

### 4.1 BRAIN-P1 — NỀN TOÁN MLP + KHO TRỌNG SỐ + HIỂN THỊ ANN THẬT

**Mục tiêu:** từ ngày merge P1, câu *"ANN với các lớp, activation, loss, lan truyền, optimizer"* có câu trả lời bằng đồ vật thật — không còn là ẩn dụ.

**Tạo mới `src/lib/brain/` (thuần toán, KHÔNG import gì ngoài `@/lib/stats` — an toàn client bundle lẫn bun:test, đúng pattern `neural-layout.ts`):**

| File | Nội dung |
|---|---|
| `activations.ts` | relu, tanh, sigmoid, softmax + đạo hàm từng hàm (cho backward). **Ghi chú (audit B1): softmax chỉ dùng cho lớp output đa lớp — không đặt làm activation lớp ẩn** (không giữ tổng xác suất, gradient dễ lệch). **Mở rộng cho BRAIN-UX §9.2 (chỉ thị user 2026-10-12): thêm linear, Leaky ReLU (α=0.01 chỉnh được), ELU (α=1.0), Swish (β=1.0), GELU (xấp xỉ tanh) — đủ 9 hàm cho menu editor UX-1; spec mặc định các brain KHÔNG đổi** |
| `losses.ts` | BCE (log-loss), MSE, Huber + đạo hàm; tổng hợp `L2 regularizer`. **Ổn định số (audit B3):** sigmoid kẹp ε=1e–7 hai đầu trước log; softmax dùng log-sum-exp |
| `init.ts` | He (cho relu) / Xavier (tanh/sigmoid); seed tất định tái dùng pattern `deterministicSeed` của q-table |
| `optimizers.ts` | SGD+momentum (β=0.9), Adam (β₁=0.9, β₂=0.999, ε=1e-8) — interface thống nhất `step(params, grads)` (cập nhật in-place params theo grads; hiệu đính FB-BRAIN-P1-R1-07 — bản trước ghi ngược thứ tự) |
| `mlp.ts` | Lớp `MLP`: spec `{layers:[{units,activation}], loss, optimizer, lr, l2, seed}` · **forward** `aₗ = φ(Wₗ·aₗ₋₁ + bₗ)` · **backward** `δ_L = ∇_a L`, `δₗ = (Wₗ₊₁ᵀ δₗ₊₁) ⊙ φ′(zₗ)` · mini-batch shuffle theo seed (**Fisher–Yates tất định**) · gradient clip (norm 5) · early stopping (patience, **đo trên hold-out 15% tách từ tập train — không đụng fold CV — audit B2**) · `fit() / predict() / predictProba()` · serialize/deserialize weights theo **envelope `{dtype:'float64', shape:number[], data:number[]}` — numpy-đọc-được cho P5 (audit A6)** |

**Prisma (additive, +1 model — KHÔNG đụng 98 model cũ; schema ĐÃ áp dụng 2026-10-12 kèm UI sớm):**
```prisma
model BrainModel {
  id            String   @id @default(cuid())
  brain         String   // 'calibration_v3' | 'surrogate' | 'policy'
  version       Int
  inputMode     String   // 'mrl-512' | 'pca-128' | 'full-2048' | 'features-10'
  specJson      String   // layers/activation/loss/optimizer/lr/l2/seed + pcaMatrix nếu inputMode=pca-128
  weightsJson   String   // envelope {dtype:'float64', shape, data} — numpy-đọc-được (P5)
  trainMetaJson String   // n mẫu, khoảng thời gian dữ liệu, CV score + CI, Brier/MAE, trainedAt, dataLineage (§5.3)
  trainedAt     DateTime @default(now())  // audit A5 — cột hạng nhất cho liệt kê/sắp xếp
  active        Boolean  @default(false)   // chỉ 1 bản active mỗi brain
  createdAt     DateTime @default(now())

  @@unique([brain, version])
  @@index([brain, active])   // audit A4 — đúng pattern truy vấn panel /api/brain
}
```

**Ghi chú DB internals (audit lượt 2):**
- **A1 — bất biến "1 active mỗi brain":** Prisma/SQLite không khai báo được partial unique index → giữ ở tầng ứng dụng: transaction ngắn `updateMany({where:{brain}, data:{active:false}})` → `update({where:{id}, data:{active:true}})`; `@@unique([brain, version])` chặn phiên bản trùng ở tầng schema. Không `$transaction` dài (bài học BUG2-119).
- **A2 — size & prune:** ước lượng weightsJson ~200–400KB/bản (features-10/mrl-512) tới ~1.5MB (full-2048) — SQLite TEXT chịu được nhưng phải có chính sách prune sau mỗi lần train thành công: **giữ bản active + 5 bản mới nhất mỗi brain** (tiền lệ prune 500 của TuningChangeLog).
- **A3 — kỷ luật migration:** repo đã chuẩn hóa chuỗi migration (baseline `0_init`) — thêm model bằng **`prisma migrate dev --name add_brain_model`** tạo thư mục migration mới + apply, KHÔNG `db push` trần (làm lệch `_prisma_migrations`).
- **A7 — single-flight train lock:** nút UI + cron có thể trùng nhịp → giữ in-process mutex (cờ module) + ràng `@@unique([brain, version])` bắt đua ở DB; train luôn chạy NGOÀI request path (cron/nút bấm → job nền).

**UI — tab Kiến trúc thêm panel "Não vận hành" (ĐÃ ÁP DỤNG 2026-10-12 theo chỉ thị P/S user):** đọc `/api/brain` (GET) → 3 thẻ brain (A "V3" · B "Vọng" · C "Lệnh"), mỗi thẻ: đồ thị lớp theo spec (`inputMode → hidden + activation → output + loss`), thanh trạng thái **NGỦ / THỨC TỈNH / ACTIVE** theo ngưỡng mẫu §2 (đếm thật từ DB: EvalResult / AgentRunRecord / QEntry / ArbiterVerdict), inputMode kế hoạch, cờ phase, nút "Huấn luyện lại" (hiện tạm **tắt** kèm lý do — nền toán P1 chưa được duyệt; khi đủ mẫu + đã duyệt thì chạy batch, fail-open). Panel dùng đúng hạ tầng pan/zoom/font P3 đã có (đồ thị brain nhỏ — không cần pan). Registry single-source tại `src/lib/brain/registry.ts` (doctrine #9) — API và UI cùng import.

**Test:** `tests/r84-brain-math.test.ts` — thuần, DB-cô-lập theo pattern gate: (1) đạo hàm backward khớp **sai phân hữu hạn** (numerical gradient check, ngẫu nhiên 20 spec); (2) MLP học được bài toán tổng hợp đã biết đáp án (vd: XOR 2-2-1 — bài toán logistic 1 lớp KHÔNG giải được — chứng minh đa lớp có giá trị thật); (3) tất định: cùng seed + cùng dữ liệu → cùng weights bit-đối-bit; (4) optimizer: Adam hội tụ nhanh hơn GD thuần trên cùng bài; (5) serialize → deserialize → predict giống hệt.

**Điểm dừng an toàn:** không một dòng runtime nào đổi hành vi. Merge an toàn bất kỳ lúc nào.

### 4.2 BRAIN-P2 — BRAIN-A: CALIBRATION V3 (MLP thay logistic) — ☑ HOÀN TẤT 2026-10-12

> **Trạng thái triển khai:** `src/lib/brain/calibration-v3.ts` (train + CV + runtime) · cờ `calibration_v3` trong TUNING_SPECS · `POST /api/brain/train` · auto-train sau eval run (`src/lib/eval/runner.ts`) · nút "Huấn luyện lại" sống trên UI · test `tests/r85-brain-calibration-v3.test.ts` 35/35 PASS (28 gốc + 7 regression FB-BRAIN-P2). Ghi chú: (1) inputMode phase này `features-10` — mode vector chờ Q2; (2) V3 thua CV vẫn ghi BrainModel `active=false` làm vết audit (prune A2 giữ active + 5 mới nhất); (3) A7 single-flight lock chưa cần — train chỉ từ nút UI + hook sau eval run (không concurrent theo thiết kế); vào P3 khi thêm nguồn trigger; (4) sau FB-BRAIN-P2: `trainMetaJson.standardization.stds` lưu **full precision** (round5 từng làm cột near-constant → std 0 → NaN runtime) + `dataLineage.evalRunIds` lưu danh sách run (hash sha256 khi > 50) đúng §5.3 + `EvalCase` đếm đúng case góp mẫu.

- **Đầu vào:** 2 chế độ đối chứng: (a) `features-10` — đúng 10 đặc trưng của V2 (so sánh sạch cùng input); (b) `pca-128`/`mrl-512` — đầu vào vector (§3.2).
- **Kiến trúc khởi điểm:** `features-10: 10→16(tanh)→1(sigmoid)+BCE`; `pca/mrl: N→32(tanh)→1(sigmoid)+BCE`. Chọn bằng CV, không bằng cảm tính.
- **Quy trình thăng cấp — KẾ THỪA NGUYÊN VẸN pattern V2** (`calibration-multifeature.ts`): 5-fold CV stratified → chỉ thắng khi `cvBrier(V3) < cvBrier(V2)` (ngặt — bằng nhau không tính); V2 đối chứng được train lại trên cùng 4 fold mỗi lượt; dưới 30 mẫu → không train (ngủ); fail-open tuyệt đối — runtime KHÔNG BAO GIỜ tệ hơn tín hiệu thô.
- **Runtime:** `calibration.ts` đọc chuỗi V1 → V2 → V3 theo `active` + cờ `CALIBRATION_V3` (STORE > ENV > DEFAULT=off) — đúng chuỗi hiệu lực đang dùng.
- **Trigger train:** nút UI (P1) + cron định kỳ (scheduler sẵn có) — không tự train trong request path.
- **Test:** `tests/r85-brain-calibration-v3.test.ts` — CV gate, fail-open mọi nhánh, rollback `active=false`.

### 4.3 BRAIN-P3 — BRAIN-B: SURROGATE PREDICTOR + REPLAY-EVAL (BƯỚC LEO LEVEL 2) — ☑ HOÀN TẤT 2026-10-12

> **Trạng thái triển khai:** `src/lib/brain/brains/surrogate.ts` (train + CV + runtime apply + replay report) · cờ `replay_eval` trong TUNING_SPECS (tham số thứ 15, gắn node softmax-policy) · `POST /api/brain/replay` (READ-ONLY) + mở rộng `POST /api/brain/train` nhận `brain: 'surrogate'` · auto-train sau agent run (`src/lib/agent-goal-loop.ts` — hook cuối IIFE ghi metadata để train đọc được chính run vừa xong) · **single-flight lock A7** (`src/lib/brain/train-lock.ts` — wired cả `calibration_v3` lẫn `surrogate`) · nút "Huấn luyện lại" sống cho Brain-B qua `BRAIN_TRAINABLE_KEYS` · test `tests/r86-brain-surrogate.test.ts` 45/45 PASS. Ghi chú quyết định triển khai: (1) **3 MLP đầu-ra-riêng** thay 1 mạng 3 đầu ra — mlp.ts gắn MỘT loss/mạng, gộp sẽ phải đụng nền toán đã fixbug; (2) đầu ra hồi quy học trong **log1p space** + Huber (đo live: tokensUsed median 0 / max 169.567 — phân phối lệch mạnh), back-transform expm1 khi báo cáo; (3) đặc trưng phase này `runs-features` = model one-hot + agent one-hot + delegated — **MỌI đặc trưng có sẵn TRƯỚC khi run bắt đầu** (chống rò nhãn tuyệt đối: cycles/tokensUsed/toolCalls/toolFailures/durationMs là nhãn); (4) gate active = đầu success thắng NGẶT baseline base-rate Brier (đầu ra quyết định), 2 đầu hồi quy thua chỉ ẩn khỏi báo cáo (per-head fail-open); (5) baseline đối chứng tính từng fold trên tập train-fold (base-rate / median log1p) — không rò rỉ hold-out; (6) replay 2 khối tách bạch: `history` (đo lường thuần + bootstrap percentile CI tất định seed + Wilson — LUÔN chạy, kể cả cờ off) + `surrogate` (ước lượng MLP chỉ khi cờ on + active + đầu thắng CV); (7) unknown model lúc replay → one-hot toàn 0 — chính là đường "bootstrap action chưa thử" cho Q-advice. Ngưỡng: train ≥ 60 usable AgentRunRecord (§2) · runtime tin ≥ 40 · hiện 17/60 → NGỦ đúng thiết kế. Còn treo (không chặn): k-NN lịch sử Qdrant (§5.4 TÙY CHỌN) · mode vector chờ Q2 · `strategy` replay-config chưa có cột dữ liệu (lớp nhiệm vụ tạm dùng agentName).

- **Tập huấn luyện:** `AgentRunRecord` (model, cycles, tokensUsed, toolCalls, toolFailures, durationMs, complete, status) ⨯ `ArbiterVerdict` ⨯ `EvalResult` ⨯ đặc trưng nhiệm vụ (embedding inputMode + độ phức tạp context).
- **Đầu ra (đa đầu ra hoặc 3 model riêng — quyết định khi triển khai):** `P(success)`, `E[tokens]`, `E[durationMs]`.
- **Chế độ replay-eval:** API `POST /api/brain/replay` — chấm một cấu hình (model, strategy, lớp nhiệm vụ) **trên surrogate thay vì chạy thật**; báo cáo kèm khoảng tin cậy bootstrap. Dùng ngay cho: model-comparison (bổ trợ ANOVA P4-M2), Q-advice bootstrap các action chưa thử (giảm chi phí exploration), sweep cấu hình retrieval.
- **Đây là bước chuyển cấp khung thẩm định:** từ "mỗi ứng viên phải thực thi trực tiếp" (Level 1) sang "đánh giá hàng nghìn cấu hình trên replay" (Level 2) — không cần GPU, không cần framework ngoài.
- **Tùy chọn tự giám sát từ kho lớn (§3.4/Q4):** đặc trưng "tác vụ gần giống nào đã từng chạy" — ANN search trên Qdrant chính kho tìm run quá khứ tương tự → feature `k-NN stats` cho surrogate (không nhãn mới, chỉ tái dùng kho).
- **Test:** `tests/r86-brain-surrogate.test.ts` — CV chất lượng dự đoán (AUC/MAE kèm Wilson CI), replay không bao giờ ghi DB ngoài read-only, cờ OFF mặc định.

### 4.4 BRAIN-P4 — BRAIN-C: POLICY HEAD + COMPOSITE REWARD + STEERING — ☑ HOÀN TẤT 2026-10-12

> **Trạng thái triển khai:** `src/lib/brain/brains/policy.ts` (train + CV + runtime mixture) · `src/lib/brain/reward.ts` (composite reward LOG-ONLY + sweep) · `GET /api/brain/policy` (report READ-ONLY) · cờ `runtime_policy` + 3 cờ organ kill-switch (`policy_organ_routing`/`policy_organ_adaptation`/`policy_organ_tuning` — TUNING_SPECS 16–19) · auto-train sau agent run (agent-goal-loop.ts) · wiring organ-1 llm.ts + organ-2 workflow-engine.ts + organ-3 buildTuningProposals read-only · test `tests/r87-brain-policy.test.ts`. Chi tiết công thức + quyết định triển khai: nhật ký hiệu đính 0.8→0.9 (đầu file).

- **Composite reward (§3.1):** ledger tái dùng `StrategyAdaptationLog` + `ArbiterVerdict` + `AgentRunRecord` (không bảng trừ `RewardWeight` sweep nếu cần); **log-only 2 đợt quan sát** trước khi tham gia quyết định (tiền lệ P6-M3).
- **Policy head:** `π(a | đặc trưng nhiệm vụ)` — khởi điểm là **mixture an toàn** với công thức tường minh (audit C2): `π(a) = λ·π_Q(a) + (1−λ)·π_net(a)` trong đó `π_Q = softmax(Q/τ)` hiện có. *(HIỆU ĐỈNH v0.9 — FB-BRAIN-P4-R1-05: công thức literal dưới đây "λ = clamp(n samples/K, 0, 1) giảm dần khi dữ liệu lớn lên" tự mâu thuẫn nội tại — clamp TĂNG theo n trong khi λ phải GIẢM + "thiếu dữ liệu → λ→1" bất khả thi với clamp; triển khai theo 2 Ý ĐỊNH TƯỜNG MINH "λ giảm dần khi dữ liệu lớn lên" + "thiếu dữ liệu → λ→1 = nghe Q nguyên vẹn (fail-open)": `λ = 1 − min(clamp(n/K, 0, 1), wilsonLB(p̂, n))` — phần π_net bị chặn TRÊN bởi cả ramp số mẫu lẫn Wilson 95% lower bound của success rate ["chặn dưới Wilson CI" = sàn của λ].)* Tận dụng cờ `RUNTIME_POLICY` (off mặc định) song song `RUNTIME_MODEL_POLICY` cũ — không đụng đường chạy nóng khi chưa duyệt.
- **Chuyển cơ quan lái (từng cái một, mỗi cái kill-switch độc lập):** (1) model routing `llm.ts`; (2) adaptation directives — wiring thực tế tại `workflow-engine.ts` systemBlocks (consumer của `adaptation-engine.ts` — FB-BRAIN-P4-R1-05 đính chính file); (3) 13 tham số tuning-store — brain chỉ **đề xuất** giá trị vào change-log (P2 đã có audit trail), người duyệt vẫn là user qua UI cho tới khi có dữ liệu đối chứng đủ mạnh để tự động từng tham số.
- **Ghi ngược tri thức:** brain chốt "cấu hình X tốt cho loại nhiệm vụ Y" (đủ CI) → sinh `LessonRecord` kèm provenance đầy đủ (§5.3) — bài học do não sinh ra nằm cùng kho bài học do vận hành sinh ra, cùng cơ chế confidence/decay hiện có.
- **Test:** `tests/r87-brain-policy.test.ts` — mixture fallback, kill-switch từng cơ quan, reward log-only không tác động quyết định khi cờ off.

### 4.5 BRAIN-P5 — BIÊN GIAO TIẾP GPU/PYTHON (DÀI HẠN, NGOÀI PHẠM VI LỘ TRÌNH NÀY)

- **Chỉ chốt contract trong P1** (weights format numpy-đọc-được) để sidecar tương lai (Keras/PyTorch, mini-service Python — platform có runtime build sẵn) cắm vào mà không sửa não TMO.
- Các ứng viên khi có GPU: GCN encoder trên Neo4J (95.587 nodes) → đặc trưng đồ thị dùng chung; hypernetwork sinh trọng số (Level 3 thật); LoRA thật khi có model tự host.
- **Không triển khai, không hẹn thời điểm.**
- **Xác nhận user (2026-10-12):** P5 giữ xa về sau — chỉ cần khi tiến hành huấn luyện tạo **model riêng** cần GPU; giai đoạn hiện tại KHÔNG cần.**

---

## 5. HỌC TRONG VẬN HÀNH THẬT — VÒNG KÉP (trả lời chi tiết Q4)

### 5.1 Sơ đồ vòng học (đích sau P4)

```
TÁC VỤ THẬT
   │
   ├─(1) HỌC TRUY HỒI: hybrid search + rerank + MMR trên Qdrant/Neo4J
   │        └─ citation [Source N] → document_id (truy vết nguồn) ── đã có
   ├─(2) LLM ĐÓNG BĂNG thực thi (model do routing chọn)
   ├─(3) ĐÁNH GIÁ: arbiter verdict + eval (faithfulness, nDCG, coverage) ── đã có
   ├─(4) REWARD: W1/W2 (+ composite sau P4) ── đã có (P4 mở rộng)
   │
   ├─(5) ONLINE NHẸ (tức thì, fail-open — đã có): Q-update · episodes · lessons
   │
   └─(6) OFFLINE BATCH (cron — P2+): retrain Brain-A/B/C từ SQLite log
            └─ CV gate → thăng cấp BrainModel(active) → dataLineage ghi nguồn
                     └─(7) STEERING chu kỳ sau: directives / routing / tuning
                              nghe brain (P4, kill-switch từng cơ quan)
```

### 5.2 Nguyên tắc 2 tốc độ (KHÔNG học sâu online trong đường nóng)

Online chỉ những thứ rẻ + an toàn (Q bảng, episodes — đã chạy). Deep learning luôn offline batch + thăng cấp qua cổng CV. Lý do: catastrophic forgetting, độ trễ hot path, không kiểm chứng được — trái doctrine fail-open của dự án.

### 5.3 Provenance chain (dataLineage) — truy vết "não học từ nguồn nào"

Mỗi `BrainModel.trainMetaJson.dataLineage` lưu: khoảng thời gian dữ liệu · bảng nguồn + số dòng mỗi bảng · danh sách episodeId/evalId/verdictId (hash tổng nếu quá dài) · inputMode + PCA matrix hash · CV score + CI. Kết hợp citation sẵn có ở (1) → **truy vết trọn vòng**: *tài liệu gốc → chunk truy hồi → câu trả lời → phán quyết → reward → mẫu huấn luyện → phiên bản brain → quyết định steering*. Đây là điều kiện để bài học do não sinh ra (P4) được cộng đồng tin cậy — và là bằng chứng audit cho khung Level 0–3.

### 5.4 Vai trò kho tài liệu lớn (nguồn user)

(i) ngữ cảnh học truy hồi mỗi ngày — đã chạy; (ii) **nguyên liệu tự giám sát** cho brain: đặc trưng cấu trúc tài liệu (độ sâu heading, mật độ thực thể, domain) → dự đoán độ khó/độ tin — không cần nhãn; (iii) nguồn embedding đặc trưng nhiệm vụ; (iv) **k-NN lịch sử** cho surrogate (§4.3). Kho lớn cho brain "khởi động sớm" về đặc trưng, nhưng nhãn thành/bại vẫn chỉ đến từ vận hành thật — brain thức tỉnh dần, an toàn.

---

## 6. RỦI RO & GIẢI PHÁP

| Rủi ro | Giải pháp |
|---|---|
| Overfit trên dữ liệu nhỏ (20–56 mẫu) | L2 mặc định, early stopping, CV bắt buộc, ngưỡng thức tỉnh §2, UI luôn hiển thị n mẫu + CI cạnh mọi điểm số (không có điểm số trần trụi) |
| Concept drift (mô hình cũ lạc hậu) | Đối chứng định kỳ (cron), thua đối chứng → `active=false` tự động về bản cũ (fail-open) |
| Brain quyết định sai gây cascade | Kill-switch từng cơ quan (P4), Wilson CI dưới ngưỡng → não ngủ lại, mọi fallback về hành vi hiện tại |
| Chi phí CPU train | Chỉ offline qua cron + nút thủ công; forward mili-giây (16–100K tham số) chèn đường nóng không đáng kể |
| "Ảo giác hiệu năng" trên benchmark nhỏ | Bài toán tổng hợp P1 chỉ dùng test toán; mọi claim hiệu năng runtime phải kèm CI + n mẫu |
| weightsJson phình to / rác phiên bản cũ (audit A2) | Prune sau train: giữ active + 5 bản mới nhất mỗi brain; envelope dtype/shape cho sidecar P5 đọc trực tiếp |
| Train trùng nhịp (cron + nút UI cùng lúc — audit A7) | Single-flight in-process mutex + `@@unique([brain, version])` bắt đua; train luôn ngoài request path |
| Phụ thuộc Python/GPU lỡ hẹn | P1–P4 thuần TS độc lập hoàn toàn; P5 chỉ là biên mở |

---

## 7. DOCTRINE COMPLIANCE (đối chiếu 9 nguyên tắc BLUEPRINT-STATS-LEARNING)

1. Hardcode từ dữ liệu — composite reward weights chỉ định nghĩa bằng sweep, kèm chú thích nguồn. ✅
2. Đo trước đổi sau — brain nào cũng ngủ tới khi thắng đối chứng CV. ✅
3. Fail-open đo lường / fail-closed an toàn — mọi brain lỗi → fallback bản cũ; kill-switch từng cơ quan. ✅
4. 1 phase = 1 commit `feat(BRAIN-P{n})` + quality-gate PASS trước push. ✅
5. Schema chỉ additive — +1 model `BrainModel`, không đụng 98 model cũ. ✅
6. Test pattern round — r84→r87. ✅
7. Giao thức quan sát — mọi phát hiện vận hành append `Bug_v2.md` (BUG2-1XX). ✅
8. Cờ bật mặc định OFF — `CALIBRATION_V3` / `REPLAY_EVAL` / `RUNTIME_POLICY`. ✅
9. Single-source hằng số — spec brain duy nhất trong `BrainModel.specJson` + import lại. ✅

---

## 8. DANH SÁCH CHỜ USER CHỐT TRƯỚC KHI TRIỂN KHAI

| # | Quyết định | Khuyến nghị blueprint | Trạng thái |
|---|---|---|---|
| 1 | Duyệt BRAIN-P1 (nền toán + kho + UI — không đổi hành vi) | Triển khai trước, an toàn tuyệt đối | ☑ **HOÀN TẤT (2026-10-12): UI + `BrainModel` + `/api/brain` áp dụng sớm theo chỉ thị P/S · nền toán `mlp/activations/losses/init/optimizers` + test r84 41/41 PASS — không còn phần dở** |
| 1b | Duyệt BRAIN-P2 (Brain-A V3 — đã triển khai 2026-10-12) | Đã chạy đúng spec §4.2; runtime mặc định OFF chờ user bật cờ `calibration_v3` khi muốn | ☑ **HOÀN TẤT (2026-10-12): r85 35/35 PASS (hiệu đính FB-BRAIN-P2) — cờ `calibration_v3` mặc định off, chỉ user bật** |
| 1c | Duyệt BRAIN-P3 (Brain-B surrogate — đã triển khai 2026-10-12) | Đã chạy đúng spec §4.3; replay READ-ONLY mặc định chỉ đo/báo cáo, chờ user bật cờ `replay_eval` khi muốn thấy ước lượng MLP | ☑ **HOÀN TẤT (2026-10-12): r86 45/45 PASS — cờ `replay_eval` mặc định off; Brain-B NGỦ 17/60 runs (đúng ngưỡng thức tỉnh §2)** |
| 2 | Q1 — composite reward (P4) có đúng ý muốn? | log-only 2 đợt trước khi tác động | ☑ **USER CHỐT (2026-10-12): duyệt theo khuyến nghị — composite reward chuẩn hóa từng thành phần (§3.1), LOG-ONLY 2 đợt quan sát trước khi tham gia quyết định. Đợt quan sát 1 bắt đầu từ v0.9 (triển khai BRAIN-P4 — reward ghi song song console + report `GET /api/brain/policy`, updateQ giữ nguyên nhị phân ±1)** |
| 3 | Q2 — inputMode mặc định | `pca-128` tạm, `mrl-512` sau đối chứng pilot; ablation cả 3 bắt buộc | ☐ |
| 4 | Q3 — không tích hợp LangChain/LangGraph/Keras, mở biên P5 | Chấp nhận rủi ro trùng lặp → không tích hợp | ☐ |
| 5 | Q4 — nguyên tắc 2 tốc độ + dataLineage | Duyệt | ☐ |
| 6 | Thứ tự P2→P3→P4 cố định, P5 treo | Đồng ý | ☐ |
| 7 | Duyệt §9 BRAIN-UX — phase UI/UX đặt CUỐI CÙNG (sau P1→P4) theo chỉ thị 2026-10-12 | Đồng ý vị trí; UX-3/4/5 có thể kéo sớm theo chỉ thị riêng | ☑ **USER CHỐT (2026-10-12): "chốt hết tất cả theo đề xuất" — triển khai §9 trọn UX-1→UX-5 cùng ngày (v0.10)** |
| 8 | Mở rộng menu activation 4 → 9 hàm (bổ sung §4.1 — cần cho UX-1) | Duyệt — thuần thêm hàm + đạo hàm, không đổi spec mặc định | ☑ **HOÀN TẤT — menu 9 activation có sẵn từ BRAIN-P1 (`activations.ts`); UX-1 dùng đủ trong editor (test r88-F pin 9 mục đúng bảng §9.2)** |
| 9 | Theme dark-hi-tech toàn app (UX-5) — tokens + rollout theo mô-đun + cờ `UI_HITECH` | Duyệt | ☑ **HOÀN TẤT — UX-5 triển khai CSS-driven toàn cục + nút HiTechToggle; rollout sâu theo mô-đun để sau nếu user muốn (hiệu đính v0.10: wallpaper user che một phần nền sâu)** |

---

## 9. BRAIN-UX — PHASE UI/UX CUỐI CÙNG: "GIAO DIỆN NÃO" & THEME HI-TECH TOÀN APP — ☑ HOÀN TẤT 2026-10-12

**☑ HOÀN TẤT 2026-10-12 (UX-1→UX-5, blueprint v0.10) — chi tiết triển khai + quyết định trung thực xem nhật ký hiệu đính 0.9→0.10 đầu file.** **v0.11: nâng cấp BRAIN-LIVE theo chỉ thị user cùng ngày — tab BRAIN Smolab + não hiển thị thật (chi tiết nhật ký hiệu đính 0.10→0.11 đầu file).**

> Bổ sung theo góp ý UI/UX của user (2026-10-12). **Vị trí lộ trình: SAU khi hoàn thành P1→P4** — đúng chỉ thị *"riêng một phần UI/UX cuối cùng sau khi hoàn thành các Phase trước đó"*. UX-3/UX-4/UX-5 thuần trình bày (không đụng nền toán/runtime) nên có thể kéo sớm theo chỉ thị riêng — tiền lệ P1-UI đã áp dụng sớm 2026-10-12. Mục tiêu tổng: đưa panel "Não vận hành" + "Bảng điều khiển tham số" từ **read-only** (chỉ xem trạng thái) lên **interactive studio** (chọn − chỉnh − chạy − nhìn thấy dòng chảy).

### 9.0 Góp ý nguồn (2026-10-12) — 5 điểm, map thẳng vào giải pháp

| # | Góp ý user (nguyên ý) | Giải pháp |
|---|---|---|
| 1 | Não vận hành cần **nút bấm ra danh sách các bộ não để chọn**, chọn não nào hiển thị não đó; từng não phải **tinh chỉnh được**: thêm/bớt lớp, chọn thuật toán activation (sigmoid, linear, tanh, ReLU, Leaky ReLU, ELU, Swish, GELU) — *"hiện tại tôi thậm chí không thể chỉnh sửa số nơ-ron của một lớp"* | UX-1 (§9.2) |
| 2 | Bảng điều khiển tham số: **không chỉnh được trọng số loss từng đầu ra**, **không chỉnh được siêu tham số khối train** | UX-2 (§9.3) |
| 3 | Các lớp nối bằng **"đường dây ánh sáng uyển chuyển, thấy được hướng di chuyển"**; **lớp / nơ-ron / đường kết nối bấm vào chỉnh sửa được**; phong cách **hi-tech, nhiều ánh sáng, chuyển động, sinh động** | UX-3 (§9.4) |
| 4 | Tab Kiến trúc: kích thước / sắp xếp vị trí / bố cục **cần thiết kế lại** — TRỪ đồ thị kiến trúc neural (giữ nguyên, phần đang tốt) | UX-4 (§9.5) |
| 5 | Toàn app: **"màn hình gương công nghệ cao với viền sáng chuyển động"**, nút có **độ nổi độ bóng**, nhìn như **màn hình dark-hacker công nghệ cao cấp sang trọng** | UX-5 (§9.6) |

### 9.1 Nguyên tắc chắn (áp dụng cho toàn §9)

1. **Draft ≠ runtime:** mọi chỉnh sửa kiến trúc / loss / siêu tham số ghi vào **bản nháp** (`BrainSpecDraft`) — bản `active` chỉ đổi qua đường đã có: train → thắng đối chứng CV → thăng cấp (bất biến A1 + §5.2 giữ nguyên). Không có đường tắt "vẽ xong chạy ngay".
2. **Lớp đầu vào / đầu ra khoá theo vai trò:** input khoá theo `inputMode` (features-10=10 · pca-128=128 · mrl-512=512 · full-2048=2048), output khoá theo brain (A=1 · B=3 đầu ra · C=×\|A\|) — tránh chỉnh làm vỡ contract dữ liệu.
3. **Bộ đếm tham số hiển thị trực tiếp khi chỉnh sửa:** `params = Σ (unitsₗ × unitsₗ₋₁ + unitsₗ)` chạy realtime; cảnh báo > 100K (dễ overfit khi chỉ có 20–56 mẫu), **chặn > 250K** (ngân sách CPU). Điểm thực thi ở lớp toán: `validateSpec` (mlp.ts) chặn từ hằng `BRAIN_MAX_PARAMS = 250.000` — mọi lối xây MLP (constructor lẫn deserialize) đều bị chặn (hiệu đính FB-BRAIN-P1-R1-08); UX-1 hiển thị bộ đếm + cảnh báo là lớp trình bày phía trên.
4. **Không framework mới:** mọi hiệu ứng (kính, viền sáng chạy, ánh sáng, bóng nút) = CSS thuần + Tailwind tokens + keyframes — không thêm dependency nào (doctrine).
5. **Hiệu ứng luôn có chốt giảm tải:** `prefers-reduced-motion` → bản tĩnh (tiền lệ P2 neural-arch) · tab ẩn → dừng (tiền lệ poll 15s) · giới hạn số phần tử vẽ (LOD).

### 9.2 UX-1 — BRAIN STUDIO: chọn bộ não + chỉnh sửa kiến trúc

**Chọn não (thay grid 3 thẻ ngang hiện tại):** nút **"Chọn não"** mở danh sách 3 brain (A "V3" · B "Vọng" · C "Lệnh") — mỗi dòng hiện trạng thái NGỦ / THỨC TỈNH / ACTIVE + số mẫu hiện/tại-ngưỡng + inputMode; **chọn não nào sân khấu giữa hiển thị não đó** (đồ thị lớn UX-3 + editor). Danh sách thu gọn giữ vai trò tổng quan trạng thái (không mất thông tin so với 3 thẻ cũ).

**Dòng tiêu đề panel — tổng nhãn tích lũy (chỉ thị user 2026-10-12, áp dụng sớm):** cạnh phải dòng tiêu đề *"Não vận hành — MLP-CPU (BRAIN)"* **luôn hiển thị badge tổng số nhãn vận hành tích lũy** — cộng theo NGUỒN (khóa signal duy nhất, không đếm trùng khi nhiều brain cùng đọc một bảng) từ các nguồn nhãn: EvalResult + AgentRunRecord + QEntry + ArbiterVerdict — đúng định nghĩa "nguyên liệu dạy não" (§2 + Q&A kiến trúc não). Số liệu đã có sẵn trong `/api/brain` (`signals[].current`) — không thêm API. Fail-open: mất `/api/brain` → ẩn badge, không chặn panel; **khi MỌI nguồn đều null (đếm lỗi hết) → cũng ẩn badge — không hiển thị "0 nhãn"** vì 0 chỉ có nghĩa khi đếm được và bằng 0 (hiệu đính FB-BRAIN-P1-R1-12). Logic thuần tách tại `registry.computeLabelTotal` (pin test r84).

**Editor kiến trúc — mỗi lớp 1 hàng:**

| Thành phần | Điều khiển | Ràng buộc |
|---|---|---|
| Số nơ-ron mỗi lớp ẩn | stepper −/N/+ + nhập trực tiếp | 1–256/lớp · bộ đếm tham số chạy realtime (§9.1-3) |
| Activation mỗi lớp | dropdown 9 hàm (bảng dưới) | softmax chỉ hiện với lớp output đa lớp (audit B1) |
| Thêm / bớt lớp ẩn | nút "+ Thêm lớp ẩn" + thùng rác từng hàng | 0–6 lớp ẩn; ≥ 3 lớp → cảnh báo overfit kèm n mẫu hiện có |
| Lớp input / output | hiển thị + khoá (tooltip giải thích lý do) | §9.1-2 |

**Menu activation — mở rộng §4.1 từ 4 lên 9 hàm (đúng danh sách user yêu cầu):**

| Hàm | Công thức | Đạo hàm | Init | Ghi chú dùng |
|---|---|---|---|---|
| sigmoid | σ(x)=1/(1+e⁻ˣ) | σ(1−σ) | Xavier | đầu ra xác suất 0–1 (Brain-A output) |
| linear | f(x)=x | 1 | — | hồi quy giá trị thô (E[tokens], E[latency] của Brain-B) |
| tanh | (eˣ−e⁻ˣ)/(eˣ+e⁻ˣ) | 1−f² | Xavier | mặc định lớp ẩn các spec hiện tại |
| ReLU | max(0, x) | x>0 ? 1 : 0 | He | nhanh, chống bão hoà gradient; có thể chết đơn vị khi lr lớn |
| Leaky ReLU | max(αx, x) · α=0.01 chỉnh được | x>0 ? 1 : α | He | chống "chết đơn vị" của ReLU |
| ELU | x>0 ? x : α(eˣ−1) · α=1.0 chỉnh được | x>0 ? 1 : f+α | He | nhánh âm trơn, trung bình đầu ra ≈ 0 |
| Swish | x·σ(βx) · β=1.0 chỉnh được | σ(βx)·(1+βx·(1−σ(βx))) | He | mượt, mạnh trên mạng sâu |
| GELU | x·Φ(x) (xấp xỉ tanh) | x·φ(x)+Φ(x) | He | chuẩn transformer |
| softmax | eˣⁱ/Σⱼeˣʲ | dùng kèm cross-entropy | — | **CHỈ lớp output đa lớp** (audit B1 — không đặt lớp ẩn) |

**Lưu trữ & đối chiếu:** nháp lưu vào `BrainSpecDraft` (§9.7) — 1 nháp mỗi brain. Nút **"Lưu nháp"** · **"Phục hồi spec chuẩn"** (về mặc định `registry.ts`) · **"So sánh với bản active"** (diff lớp / activation / tham số / n mẫu / CV score từng bên). Rule validation viết **single-source tại `src/lib/brain/spec-schema.ts`**, client và server cùng import (doctrine #9).

**Cờ:** `UI_BRAIN_EDIT=off` mặc định — OFF: chỉ xem như hôm nay; ON: mở toàn bộ editor.

### 9.3 UX-2 — TRAINING CONSOLE: trọng số loss từng đầu ra + siêu tham số khối train

Thay bảng read-only hiện tại bằng bảng **chỉnh trực tiếp** — thêm cột "Giá trị" với editor inline đúng kiểu dữ liệu (số · enum · boolean), giữ nguyên cột nguồn STORE/ENV/DEFAULT, audit trail, nút reset. 3 nhóm:

- **Nhóm A — siêu tham số khối train** (ghi vào draft spec UX-1): optimizer {SGD+momentum, Adam} · lr (thang log 1e-4 → 1) · epochs 50–5000 · batch 8–256 · L2 λ 0–0.1 · patience 10–200 · hold-out 10–30% (mặc định 15 — audit B2) · grad-clip 1–10 (mặc định 5) · seed (mặc định tất định).
- **Nhóm B — trọng số loss TỪNG ĐẦU RA** (Brain-B đa đầu ra): λ_success · λ_tokens · λ_latency ∈ [0,1], chuẩn hoá Σλ=1 tự động (hiển thị %), mỗi đầu ra chọn loại loss {BCE, MSE, Huber}; công thức tổng hiển thị trực tiếp: `L = λ₁·BCE(success) + λ₂·Huber(tokens) + λ₃·Huber(latency)`. Brain đơn đầu ra (A) / softmax (C): chỉ chọn loại loss.
- **Nhóm C — composite reward (P4):** w₁ Outcome* · w₂ Efficiency* · w₃ Quality* — DEFAULT từ sweep kèm chú thích nguồn bắt buộc (doctrine #1); user override → **tuning-store STORE›ENV›DEFAULT + TuningChangeLog audit** (tiền lệ 13 tham số runtime); quy tắc log-only 2 đợt quan sát KHÔNG đổi.

**Nút "Huấn luyện"** (chỉ bật khi `trainingImplemented` + đủ mẫu ngưỡng): chạy batch ngoài request path (A7), hiển thị tiến trình từng epoch (loss train/hold-out) → kết quả CV + CI → thắng/thua đối chứng; mỗi lần chạy sinh `BrainModel` version+1 — thua đối chứng = bỏ, `active` giữ nguyên (fail-open).

### 9.4 UX-3 — ĐƯỜNG DÂY ÁNH SÁNG: kết nối động có hướng, bấm sửa được

- **Hình dáng "uyển chuyển":** cạnh = đường cong bezier (điểm điều khiển lệch vuông góc trung điểm giữa 2 nơ-ron), nét gradient sáng dần theo chiều đi — thay đường thẳng tĩnh hiện tại.
- **Thấy được hướng di chuyển:** animation nét đứt chạy dọc cạnh (`stroke-dasharray` + `stroke-dashoffset`, 2.4s linear infinite, **lệch pha theo từng cạnh** cho cảm giác dòng chảy chứ không nhấp nháy đồng loạt) + đầu mũi tên → chiều **lan truyền tiến** rõ ràng. Chế độ xem thứ hai khi có trainMeta: **lan truyền ngược** (đảo chiều + đổi tông hổ phách, độ dày theo |gradient| trung bình từng lớp — dữ liệu thật từ train, không trang trí suông).
- **Bấm để sửa (đúng góp ý: lớp, nơ-ron, đường kết nối đều bấm được):**
  - Bấm **nhãn cột lớp** → editor lớp đó (units + activation — UX-1).
  - Bấm **nơ-ron** → inspector: bias · |w| trung bình vào/ra (sau train) · activation; kèm stepper nhanh ±1 nơ-ron của lớp.
  - Bấm **cạnh** → inspector: 2 đầu nối · |w| (sau train) · tô sáng riêng đường đó; nút nhanh "Sửa 2 lớp hai đầu". *(Ghi chú trung thực: trọng số W do train sinh ra — không "vẽ tay" từng weight; chỉnh kiến trúc = chỉnh lớp / units / activation.)*
- **Hiệu năng & a11y:** LOD tối đa ~300 cạnh (quá thì sampling đại diện — tiền lệ mini-map); gộp frame bằng rAF; `IntersectionObserver` dừng animation ngoài viewport; `prefers-reduced-motion` → bản tĩnh có mũi tên; touch target ≥ 44px.
- **Sinh động nền (có nghĩa):** não ACTIVE có hào quang "thở" (pulse 4s ease-in-out); NGỦ = ánh sáng rất yếu, tĩnh — trạng thái thật chi phối trực quan, ánh sáng mang thông tin chứ không phải hiệu ứng vô nghĩa.

### 9.5 UX-4 — TÁI BỐ CỤC TAB KIẾN TRÚC (giữ nguyên đồ thị hệ thống 6 lớp)

Bố cục hiện tại xếp dọc toàn bộ card theo chiều rộng → trang dài, tỷ lệ khối chưa hợp lý. Chuyển sang **dashboard 3 vùng** (desktop ≥ 1280px):

```
┌──────────────────────────────────────────────────────────────┐
│ ĐỒ THỊ HỆ THỐNG 6 LỚP — GIỮ NGUYÊN (hero, pan/zoom P3)        │
├───────────┬──────────────────────────────────┬───────────────┤
│ THANH TRÁI │ SÂN KHẤU GIỮA (UX-3)             │ THANH PHẢI    │
│ Chọn não   │ Não đang chọn: đường dây ánh     │ Training      │
│ A / B / C  │ sáng + trạng thái + bộ đếm       │ Console (UX-2)│
│ + ngưỡng   │ tham số + nút Huấn luyện         │ + tab: Tham   │
│ thức tỉnh  │                                  │ số runtime ·  │
│ + phiên    │                                  │ Nhật ký       │
│ bản        │                                  │ (gộp từ dưới) │
└───────────┴──────────────────────────────────┴───────────────┘
<1024px: xếp dọc — đồ thị hệ thống → Não studio → console thành bottom-sheet (tiền lệ P2)
```

- Bảng 25 tham số runtime (13 gốc + 12 phase) + nhật ký tinh chỉnh rời khỏi dòng chảy chính → thành 2 tab trong thanh phải (rút ngắn rõ rệt chiều dài trang).
- Kích thước chữ giữ chuẩn P3 (+1px đã duyệt — không quay lại); khoảng cách chuẩn hoá `gap-4` / `p-4`; card cùng độ cao theo hàng; mọi nút chạm ≥ 44px mobile.

### 9.6 UX-5 — THEME DARK HI-TECH TOÀN APP: "màn hình kính viền sáng"

Ngôn ngữ thiết kế: **"màn hình kính công nghệ cao trong phòng tối"** — nền sâu gần đen, bề mặt kính mờ, vành sáng chạy quanh panel, nút nhô có bóng — dark-hacker sang trọng, ánh sáng phục vụ thông tin.

- **Tokens (CSS custom properties + Tailwind — không đổi tông hiện tại, tăng độ "sống"):** nền sâu `#05070D` · bề mặt kính 2 mức (trong suốt 4–8% + blur 8px, tối đa 1 lớp chồng) · điểm nhấn giữ bảng màu sẵn có (cy · hổ phách · ngọc · tím · hồng đá).
- **Viền sáng chuyển động:** vành sáng conic-gradient quay quanh viền panel (`@property --angle`, 6s linear infinite) — trình duyệt không hỗ trợ thì fallback viền tĩnh sáng.
- **Nút độ nổi độ bóng:** gradient dọc sáng→tối + inset highlight 1px mép trên + đổ bóng dưới; hover nhô 1px, active lún 1px, focus ring sáng rõ.
- **Chỉ animate transform / opacity / --angle** (GPU-composited, không reflow); không JS chạy vòng lặp cho trang trí.
- **Cờ `UI_HITECH=off` mặc định (doctrine #8):** bật/tắt bằng 1 nút trong UI (localStorage + tuning-store) — OFF trả về giao diện hiện tại nguyên vẹn (fail-open trình bày).
- **Khả năng tiếp cận:** chữ luôn nằm trên nền chắn đặc (không để glow xuyên qua chữ) · contrast ≥ 4.5:1 (quét tự động r91) · `prefers-reduced-motion` tắt mọi vòng lặp vô hạn · dark là mặc định (không làm theme sáng).
- **Rollout theo mô-đun, mỗi mô-đun 1 commit:** shell (header/nav/footer) → dashboard → Database (4 tab) → các mô-đun còn lại. Sticky-footer + bố cục flex dọc chuẩn giữ nguyên.

```css
/* Minh hoạ tokens — globals.css, KHÔNG thêm thư viện (doctrine #4) */
:root[data-hitech='on'] { --ht-bg: #05070d; --ht-glass: rgb(255 255 255 / .04); --ht-angle: 0deg; }
@property --ht-angle { syntax: '<angle>'; initial-value: 0deg; inherits: false; }
.glass-panel { background: var(--ht-glass); backdrop-filter: blur(8px); }
.glow-border::before { /* vành sáng chạy quanh viền panel */
  content: ''; position: absolute; inset: -1px; padding: 1px; border-radius: inherit; pointer-events: none;
  background: conic-gradient(from var(--ht-angle), transparent 0 72%, var(--ht-accent) 86%, transparent 100%);
  -webkit-mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);
  -webkit-mask-composite: xor; mask-composite: exclude;
  animation: ht-spin 6s linear infinite;
}
@keyframes ht-spin { to { --ht-angle: 360deg; } }
@media (prefers-reduced-motion: reduce) { .glow-border::before { animation: none; } }
```

### 9.7 SCHEMA & MIGRATION (additive — model thứ 100)

```prisma
model BrainSpecDraft {
  id        String   @id @default(cuid())
  brain     String   @unique  // 1 bản nháp mỗi brain ('calibration_v3' | 'surrogate' | 'policy')
  specJson  String   // layers[{units,activation}] · lossPerHead[{type,weight}] · optimizer · hyper{lr,epochs,batch,l2,patience,holdout,clip,seed}
  note      String?  // lý do chỉnh sửa — hiển thị trong diff
  updatedAt DateTime @updatedAt
  createdAt DateTime @default(now())
}
```

- Migration: `bun run db:migrate -- --name add_brain_spec_draft` (kỷ luật A3 — không `db push` trần; 99 → 100 model).
- **KHÔNG bảng mới cho override runtime** — tái dùng `TuningParam` (STORE›ENV›DEFAULT) + `TuningChangeLog` (audit + prune sẵn có).
- Luồng nháp → runtime giữ nguyên bất biến A1: draft → train (ngoài request path) → thắng CV → `BrainModel` version+1 `active` (giao dịch 2 bước hiện hữu).
- API mới: `GET/PUT /api/brain/spec-draft` — validate bằng `spec-schema.ts` (cùng rule client, single-source).

### 9.8 TEST (pattern round, DB-cô-lập)

| Round | Phạm vi |
|---|---|
| `r88` | spec validation (biên units 1–256 · chặn > 250K tham số · menu 9 activation đủ công thức + đạo hàm) · draft lưu / phục hồi / diff · KHÔNG bao giờ ghi đè bản active |
| `r89` | chuẩn hoá Σλ=1 tự động · chuỗi hiệu lực STORE›ENV›DEFAULT · mọi set/reset có audit trail |
| `r90` | reduced-motion → render tĩnh có mũi tên · tab ẩn → dừng rAF · LOD cắt cạnh đúng · hit-target cạnh/nơ-ron (point-to-bezier) chính xác |
| `r91` | quét contrast mọi cặp chữ/nền ≥ 4.5:1 · `UI_HITECH=off` → DOM không còn class hiệu ứng · no-regression snapshot các trang chính |

### 9.9 RỦI RO RIÊNG PHẦN UX & GIẢI PHÁP

| Rủi ro | Giải pháp |
|---|---|
| Hiệu ứng nặng làm tụt máy yếu / mobile | Budget 60fps (đo rAF counter); tụt < 45fps liền 2s → tự hạ cấp (tắt glow/blur); mobile giảm hiệu ứng (`pointer: coarse`) |
| Chỉnh spec tự do làm não xấu đi | Draft không chạm runtime; `active` chỉ qua CV; bộ đếm tham số + cảnh báo overfit (n mẫu vs params) ngay tại editor |
| Glow / kính làm mất khả năng đọc | Chữ luôn trên nền chắn đặc; quét contrast tự động r91 |
| `backdrop-filter` tốn GPU | Tối đa 1 lớp chồng; mobile dùng gradient đậm thay blur |
| Theme toàn app phình phạm vi | Rollout từng mô-đun — mỗi mô-đun 1 commit nhỏ; cờ tắt toàn cục 1 nút |
| Trạng thái chọn não / bảng gây rối | Mọi panel có "Về mặc định"; lựa chọn lưu localStorage |

### 9.10 THỨ TỰ, CỜ, EFFORT

| Giai đoạn | Việc | Phụ thuộc | Effort | Cờ (mặc định OFF) |
|---|---|---|---|---|
| UX-1 | Brain Studio — chọn não + sửa kiến trúc | P1 (nền toán để validate) | M | `UI_BRAIN_EDIT` |
| UX-2 | Training Console — loss từng đầu ra + siêu tham số | P1 + P3 (đa đầu ra Brain-B) | M | `UI_BRAIN_EDIT` |
| UX-3 | Đường dây ánh sáng động + bấm sửa được | P1-UI (đã có) | L | `UI_SYNAPSE_FX` |
| UX-4 | Tái bố cục tab Kiến trúc | — (thuần trình bày) | M | — |
| UX-5 | Theme hi-tech toàn app | — (thuần trình bày) | L | `UI_HITECH` |

**☑ UX-1→UX-5 đã triển khai 2026-10-12 (v0.10) — gộp 1 commit `feat(BRAIN-UX)` kèm đợt fixbug FB-BRAIN-UX khép kết 3 vòng (BUG2-185..199). Ghi chú doctrine #4: kế hoạch gốc “mỗi giai đoạn 1 commit `feat(BRAIN-UX{n})`” không thực hiện được trung thực — phiên triển khai bị gián đoạn giữa chừng, cả 5 giai đoạn nằm chung 1 working tree đã xác minh 1370/1370 ×2; tách 5 commit riêng lúc commit-time sẽ tạo commit trung gian fail test (pin TUNING_SPECS 19→25 chỉ đúng ở mốc cuối) nên gộp 1 commit, ghi rõ lý do tại đây.**

**Thứ tự mặc định: sau khi hoàn thành P1→P4** (chỉ thị user 2026-10-12). UX-3 / UX-4 / UX-5 không phụ thuộc nền toán — có thể kéo sớm theo chỉ thị riêng (tiền lệ P1-UI). Mỗi giai đoạn = 1 commit `feat(BRAIN-UX{n})` + quality-gate PASS trước push.

---

> **Ghi chú phiên bản 0.11:** tài liệu này là DRAFT để thảo luận — mọi con số effort/ngưỡng là ước lượng ban đầu, sẽ chốt lại theo từng phase. **Nền toán MLP + test r84 ĐÃ triển khai (2026-10-12, 41/41 PASS + hiệu đính FB-BRAIN-P1 — hợp đồng API chặt: guard input dimension, chặn options NaN, deserialize đủ cặp tensor, kiểm activationParams, trần 250K tham số tại validateSpec)**; Brain-A/B/C (P2–P4) chưa train thật. Đã áp dụng sớm theo chỉ thị user: (2026-10-12, P/S) phần UI hiển thị + kho `BrainModel` + `/api/brain` + `registry.ts`; (2026-10-12, góp ý UI/UX) **§9 BRAIN-UX** + badge tổng nhãn ở tiêu đề panel Não vận hành (§9.2). **BRAIN-UX §9 (UX-1→UX-5) ĐÃ triển khai 2026-10-12 — 1370/1370 tests (r84–r91). Brain-A/B/C vẫn NGỦ đúng thiết kế chờ dữ liệu (QEntry 1/30 · ArbiterVerdict 10/50 · runs ~17/60).** **BRAIN-LIVE (2026-10-12) ĐÃ triển khai: panel Não vận hành chuyển sang module Smolab → tab BRAIN + não hiển thị thật từng nơ-ron (cap 256, Brain-A 27 chấm) + activity READ-ONLY live 2.5s + zoom/pan + TuningParamDialog — `ui_synapse_fx` mặc định ON (chi tiết: nhật ký hiệu đính 0.10→0.11 đầu file).**
