# BLUEPRINT TRIỂN KHAI EVO-NAO P1 → P5 + BRAIN-D "TRI THỨC" CHO TMO

> **Phiên bản 0.9 — RÀ SOÁT TOÀN BỘ BLUEPRINT + 6 CHIỀU TỔNG QUAN CORPUS + D2 TOOLING + Q2/Q3 ĐÓNG + OBSERVATION CHO EVO (2026-10-18, task R31).**
> User: "thêm vài chiều tổng quan corpus đi + nếu còn blueprint chưa triển khai thì triển khai". **(1) Corpus dims (§8.3/§8.5.2):** input Brain-D mở rộng cfg ~30 → **~36** — +6 chiều đếm corpus log-scale (`corpus-dims.ts` single-source: graphNodes/lessons/episodes/chunks/communities/memories); /api/brain thêm `corpusOverview` đếm thật Neo4j COUNT-store O(1) + Qdrant count exact (cache 60s, fail-open từng nguồn) → UI SECTION 1 grid 6 ô (r121 12 test + r114 hiệu đính pin label). **(2) D2 TOOLING HOÀN TẤT (31-d):** `scripts/d2-baseline-report.ts` + `d2-stats.ts` thuần (r117 31 test) + report thật corpus 40 log (p50 206ms/p95 1.019ms · entities 93,8% hit > communities 52,9% > chunks 17,6% — **chunks trống 14/17 = tín hiệu cho D3 policy** · r(hits↔success) −0,271) → `docs/REPORT-D2-BASELINE-KB.md` + `docs/D2-BASELINE.json` cho gate A1 của D3 — chỉ còn chờ ≥100 log để số liệu đủ sức thống kê. **(3) Q2 đóng (31-e):** per-candidate budget — ứng viên vẫn SINH đúng chuỗi seed (H4 stream bất biến) nhưng train/score bị bỏ khi vượt wall budget → ghi row + note `candidate_budget_exceeded` + `abandoned:true`; đồng hồ inject `now()` (r118). **(4) Q3 đóng (31-e):** `adaptiveCrossoverRate(pastWinners)` — 0,2 base · ≥8 thắng → 0,4 · ≥24 → 0,6 (đếm beatActive quá khứ lúc start, tất định theo DB). **(5) HYPERNAS §9 sống lại qua EVO (31-e):** kinds `search.session`/`search.candidate` phát từ evolve.ts (evo/observe.ts fail-open, flag obs_ledger) — `proposal.apply` còn mở (đường apply sống client-side). **(6) Migration bù 5 bảng trôi (main):** DebtLedger/ObservationEvent/BrainInferenceTrace/BrainSearchRun/BrainSearchCandidate — idempotent IF NOT EXISTS, verify fresh-deploy + diff rỗng (audit 31-a/b phát hiện; 6 model audit nghi ngờ còn lại dùng @@map đã có trong 0_init). Chi tiết: §11 mục 0.9.
> **Phiên bản 0.8 — UI/UX ĐIỂM CV + BRAIN-D BẤM ĐƯỢC + TRIỂN KHAI NGAY + BỎ ĐỐI CHỨNG ACTIVE (2026-10-18, task R27).**
> User report 4 điểm trong 1 tin nhắn: (a) "UI/UX điểm CV các hạt + chữ nhìn to, lệch kích thước so với xung quanh" — đo DOM: số liệu 14px giữa console 9–11px → hạ 11,5px semibold + nhãn 9,5px + bar 6px + bỏ bớt ô; (b) "Brain D không bấm vào xem điểm CV được" — nút D disabled cứng → ghost BẤM ĐƯỢC, panel tiến độ D2/D3 thật + ẩn form chạy vô nghĩa; (c) "HyperNAS tính ra số lớp + nơ-ron tối ưu thì có triển khai luôn không, có hiện trong Đài quan sát não không" — nút "Triển khai luôn" mới ở E2 (kiến trúc suggestArch) + E4 (ứng viên tốt nhất): ghi nháp → train → ÁP DỤNG active ngay (chuỗi saveDraft R7 + specOverride mới); Đài quan sát não hiển thị kiến trúc mới (verify thật Brain-B "8 tanh"); (d) "bỏ phần đánh giá model sử dụng đi" — hiểu là khối Đối chứng active: bỏ ô/badge/cột/legend/cổng hasBeater, Pareto front đổi sang TOÀN BỘ ứng viên, chặn H7 (latency) giữ nguyên; server vẫn tính beatActive để audit. Câu "kết hợp các bộ não thành 1" — KHÔNG làm (input space/hợp đồng đầu ra/ngưỡng thức tỉnh 4 não khác nhau — chi tiết §11 0.8), hướng "1 quyết định 1 forward" đã có ở Brain-D §8.3. Chi tiết đầy đủ: §11 mục 0.8.
> **Phiên bản 0.7 — SMART SEARCH R26 + HIỆU ĐINH TRẠNG THÁI (2026-10-18, task R26).**
> User hỏi (2026-10-18): (a) EVO-P0..P4 triển khai hết chưa; (b) "NAS có cơ chế tính toán xác định số lớp/số nơ-ron hiệu quả chưa"; (c) thông báo Brain-D chưa vào search space (D4 §8.4) + tab Tiến hoá thiếu nút lùi chọn lại não + "UI/UX điểm CV xấu". **(b) trả lời bằng code mới §4.6 EVO-P4.1 SMART SEARCH:** `evo/smart-search.ts` — suggestArch (bộ ước lượng giải tích: số lớp theo độ giàu mẫu · kim tự tháp hình học in→out · hệ số co giãn √(n/(in+out)) · trần dung lượng ~50 tham số/mẫu với lặp co √(cap/P)) làm HẠT GIỐNG ứng viên #0 + cha chọn theo GIẢI ĐẤU tournament k=3 (thay uniform) + mutation rate thích ứng 0,15→0,06 — r116 (15 test); GET evolve kèm `suggestion` hiển thị ở form E2 (cơ chế tính hiển thị cho user). **(a) hiệu đính §0.1:** P0..P4 trạng thái cũ "MẤT → viết lại" lỗi thời — đã HOÀN TẤT R24-c + UI R25-c. **(c) UI R26:** hàng đổi não đích NGAY trong tab (4 nút A/B/C/D — D disabled kèm tooltip D4) · thông báo D4 có tiến độ thật (2 thanh KbConsultLog từ signals /api/brain) · điểm CV nâng cấp toàn diện (bar trực quan + CI đầy đủ thay ± nửa khoảng + metric grid 4 ô thay dòng mono dài + Pareto gridlines 5 vạch kèm nhãn + miền Y đệm sàn span 0,08 + nhãn #idx trên front + sửa legend "thắng CV"→"thắng active") — r115 +5 test (padDomain/cvBarTone). Lưu ý trung thực H4: cùng seed cho CÙNG chuỗi trong cùng phiên bản — chuỗi R26 khác R24-c vì thuật toán sinh đổi (hạt giống #0 không tiêu thụ rng).
> **Phiên bản 0.6 — TRIỂN KHAI D0 + §8.5 MỐC (a) + EVO-P0..P4 VIẾT LẠI (2026-10-17, task R24).**
> Ba mốc theo §7 chạy trọn trong R24: **D0** (đo 9 shard + trial ingestion SHD_NAS_EVOLUTION_002 thật vào Aura: +408 node/+1.161 rel, quota an toàn — report [D0-KHOI-LUONG-9-SHARD-NEO4J.md](./D0-KHOI-LUONG-9-SHARD-NEO4J.md)) · **§8.5 mốc (a)** ghost UI topology Brain-D trong tab BRAIN (não thứ 4 + tiến độ thức tỉnh kép đếm thật KbConsultLog + 2 cờ kill-switch #33/#34 — test r114) · **EVO-P0..P4 viết lại hoàn tất** (benchmark fixtures từ DỮ LIỆU THẬT backup R2 + encoding 144 + block engine có numerical gradient check + micro-MoE + evolve runner + POST/GET /api/brain/evolve + cờ #35/#36 — tests r105–r108). Fix bug thật 2 cái trong quá trình live-verify: MlpBlock FFN 2 lớp giữ chiều token + cache EvoDense ghi đè giữa các token của MoE (r106 gradient check bắt được).
> **Phiên bản 0.5 — REVIEW KIẾN TRÚC TOÀN DIỆN + BỔ SUNG §8.5 UI TOPOLOGY BRAIN-D (2026-10-17, task R23).**
> Review v0.4.1 tìm & sửa **9 lỗi thiết kế** (F1–F9, chi tiết §11) — đáng chú ý nhất: 2 tham chiếu "tiền lệ HN" trong §5 trỏ thiết kế CHƯA TỪNG triển khai (HN-P2/P3 UI mất theo reset chưa dựng lại) và E1 không thể phân biệt với "mất kết nối". Bổ sung **§8.5 — UI topology diagram Brain-D trong tab BRAIN** (yêu cầu user 2026-10-17: tab BRAIN chưa thấy topology Brain-D): ghost topology hiển thị ngay từ D1, 3 cụm đầu ra đồng thời, tiến độ thức tỉnh kép.
> **0.4.1 (2026-10-17, task R22):** cấu hình lại phòng sau khi sandbox mất toàn bộ credentials (.env về placeholder) — R2 (bucket `themagnumopus`, 15 backup objects) + Neo4j Aura (`neo4j+s://6e688b02…`, user/db `6e688b02`) + NIM 4/4 key HTTP 200 + review v0.4 đối chiếu code (r110 21/21 pass). Duy nhất 1 điểm số liệu sửa: §9/Q5 số đo đồ thị — không thay đổi thiết kế nào.
> Dựng lại 2 phần chi tiết ĐÃ MẤT của v0.2 (386 dòng — mất theo sandbox reset vì chưa kịp commit/push GitHub): **§5 UI EVO-U1..U5** (tái tạo đầy đủ theo convention precedent [BLUEPRINT-HYPERNAS-P1-P5.md](./BLUEPRINT-HYPERNAS-P1-P5.md) §10) + **§10 Q1–Q6** (tái tạo từ tri thức phiên — mỗi câu đánh dấu cần user chốt khi tới phase). Đồng thời cập nhật trung thực §0.2/§8.1 sau khi D1 HOÀN TẤT (R20, commit 4394507) + rà soát fixbug FB-BRAIN-D1 (R21 — 8 phát hiện BUG2-269..276 đã fix, chi tiết [Bug_v2.md](../Bug_v2.md)).
> Bản v0.3 (251 dòng) tái tạo sau reset giữ nguyên 2 quyết định user duyệt TRƯỚC reset, hiệu lực không đổi:
> - **Q7 = phương án (b)** — D3 kèm cả **chế độ vận dụng** (không chỉ tinh chỉnh tham số truy xuất);
> - **Q9 = CÓ** — thêm phase **D0** ánh xạ 9 shard `knowledge/` vào Neo4j (Neo4j là LÕI KB).
>
> **Bài học reset (DOCTRINE từ v0.3):** mọi mốc triển khai phải **commit + dual-push GitHub NGAY khi hoàn thành** — đợt EVO-P1..P4 + FB-CAUSAL (r103) + SMGI-canary (r104) đã viết xong trên sandbox cũ nhưng không push nên mất sạch. Từ v0.3: gate "hoàn thành" của mọi task PHẢI gồm `git push` cả 2 kho (origin + mirror).
>
> Bổ sung cho [BLUEPRINT-BRAIN-P1-P5.md](./BLUEPRINT-BRAIN-P1-P5.md) (P1→P4 hoàn tất — 3 brain A/B/C đã sống) và [BLUEPRINT-HYPERNAS-P1-P5.md](./BLUEPRINT-HYPERNAS-P1-P5.md) (HN-P1 hoàn tất — search space 96 chiều đã sống ở main).

---

## 0. TÓM TẮT ĐIỀU HÀNH

### 0.1 Chuỗi phase EVO (tiến hoá kiến trúc não)

| Phase | Tên | Mục tiêu một câu | Artifacts | Cờ (mặc định) | Test | Trạng thái |
|---|---|---|---|---|---|---|
| **EVO-P0** | Nền & đối chứng | Benchmark tất định + fixtures tái lập để mọi ứng viên so với Brain-C active (MLP chuỗi) trên cùng dữ liệu | `src/lib/brain/evo/benchmark.ts` + fixtures | — (thuần lib) | r105 * | **HOÀN TẤT (R24-c viết lại — fixtures dữ liệu thật backup R2; hiệu đính 0.7 từ "MẤT → viết lại" lỗi thời)** |
| **EVO-P1** | Encoding additive 144 | Mở search space 96→144: thêm slot block kiến trúc (layer-type/ tham số/ MoE) — **additive, không phá HN-P1** | `search-space.ts` (mở rộng) | — (thuần lib) | r105 | **HOÀN TẤT (R24-c — hiệu đính 0.7)** |
| **EVO-P2** | Block engine thuần TS | Block chạy được trên CPU: attention 1-head causal + selective SSM (N=8–16), seq ≤512 | `src/lib/brain/evo/blocks.ts` | — (thuần lib) | r106 | **HOÀN TẤT (R24-c — grad-check <1e-3; hiệu đính 0.7)** |
| **EVO-P3** | Micro-MoE | MoE nhẹ k=2–4 experts + aux loss 0.01 (chỉ khi ≥2K mẫu) | `src/lib/brain/evo/moe.ts` | — (thuần lib) | r107 | **HOÀN TẤT (R24-c — hiệu đính 0.7)** |
| **EVO-P4** | Evolve runner | Vòng tiến hoá: sinh ứng viên từ encoding → train → chấm benchmark → ghi BrainSearchCandidate | `src/lib/brain/evolve.ts` + `POST /api/brain/evolve` | `brain_evolve` (OFF) | r108 | **HOÀN TẤT (R24-c) + UI R25-c + SMART SEARCH R26 (§4.6 — hạt giống suggestArch + tournament + adaptive rate, r116) + R31: Q2 per-candidate budget + Q3 adaptive crossover + observation events (r118)** |
| **EVO-P5** | GPU sidecar | Tùy chọn: mini-service GPU khi CPU không kịp (chỉ benchmark ngoài runtime) | `mini-services/evo-gpu/` | — | r109 | Chưa triển khai (Q6 — cân nhắc hoãn) |

\* **Hiệu đính 0.5 (F1):** trạng thái "Chưa triển khai" cũ của P0 tự mâu thuẫn với P1..P4 "ĐÃ TỪNG làm — MẤT" (P4 chấm ứng viên trên benchmark → chức năng benchmark phải từng tồn tại); nhưng §1 không liệt kê `benchmark.ts` trong sổ mất → P0 từng sống DẠNG CHỨC NĂNG (nhúng trong evolve.ts mất), chưa chắc có artifact riêng. Khi viết lại: tách artifact chuẩn `benchmark.ts`; r105 = test chung P0+P1 (benchmark + encoding 1 file) — đặt lại số nếu tách file.

### 0.2 Chuỗi phase BRAIN-D "Tri Thức" (não thứ 4 — dùng KB để LÀM, không chỉ trả lời)

| Phase | Tên | Mục tiêu một câu | Artifacts | Cờ (mặc định) | Test | Trạng thái |
|---|---|---|---|---|---|---|
| **D0** | Ánh xạ knowledge/ → Neo4j | Đưa 9 shard tài liệu gốc (2.2MB) vào đồ thị lõi bằng ingestion sẵn có (entity-resolver + LLM extraction) — additive, merge không đè | đo khối lượng + chạy ingestion theo đợt shard | — | — | **ĐO + TRIAL 002 HOÀN TẤT (R24-a)** — 868 chunk/9 shard · trial thật +408 node/+1.161 rel (22,4% merge) · quota an toàn (~51% sau 9 shard) — 8 shard còn lại chờ user quyết theo [report D0](./D0-KHOI-LUONG-9-SHARD-NEO4J.md) |
| **D1** | LOG-ONLY | Bảng `KbConsultLog` ghi MỌI lượt KB consult: ai hỏi, cấu hình truy xuất, nguồn nào trả, kết quả top, tốn bao nhiêu, chạy run nào → nối Outcome* | prisma model + instrumentation `kb-access.ts` + `consult-log.ts`/`consult-context.ts` + fallback/graph wrapper | `kb_consult_log` (ON) | r110 | **HOÀN TẤT R20 (4394507) + rà soát FB-BRAIN-D1 R21 (BUG2-269..276 fix + migration bù + corpus mở fallback/graph)** |
| **D2** | Baseline đối chứng | Report: heuristic CỨNG hiện tại đạt mức nào trên log thật (≥100 log) — trả lời "não có hơn heuristic không?" bằng dữ liệu | script report + docs | — | r117 | **TOOLING HOÀN TẤT (R31-31d):** `scripts/d2-baseline-report.ts` + `src/lib/kb-routing/d2-stats.ts` (thuần) + report thật + `docs/D2-BASELINE.json` (gate A1 của D3) — corpus hiện 40/100 log; chạy lại khi ≥100 để số liệu đủ sức thống kê |
| **D3** | Policy head 3 tầng | `brain/brains/knowledge.ts` — hành động gồm **chế độ vận dụng** (Q7=(b)) + tham số truy xuất + meta | brain D + kill-switch 2 cờ + **UI topology §8.5 (phần activity)** | `runtime_knowledge` (OFF) + `knowledge_organ_strategy` | r112 | Chưa triển khai (cần D2 + ≥300 log có Outcome*; **UI ghost topology §8.5 mốc (a) ĐÃ SỐNG R24-b — r114**; mốc (b) activity kèm D3) |
| **D4** | Vào NAS/EVO space | Kiến trúc knowledge head do evolve.ts tìm (không hand-tune) | mở encoding §4 | — | r113 | Chưa triển khai — **nhánh EVO-P1..P4 ĐÃ SỐNG (R24-c, hiệu đính 0.7)**; chỉ còn chờ D3 (cần ≥300 log có Outcome*). UI tab Tiến hoá hiển thị tiến độ thật 2 signals (R26) |

---

## 1. BỐI CẢNH — SỰ KIỆN RESET & KHOẢNG MẤT MÁT (định tính qua GitHub PAT, 2026-10-17)

Sandbox reset lần nữa; `/home/z/tmo-app` bị xóa. Định tính bằng PAT trên **cả 2 tài khoản** (`nguyenquocviety2c-code` + `vietnq130593-code`, 8 repo, mọi branch, code-search):

**MẤT vĩnh viễn (không có trên bất kỳ repo nào):**
- Bản v0.2 của file này (386 dòng) — thiết kế trung tâm đợt EVO-NAO + BRAIN-D;
- Toàn bộ triển khai sau R19 (HEAD `00da3f3`, 15/10 08:04 UTC): **FB-CAUSAL** (r103) + **SMGI-canary** (r104) + **EVO-P1..P4** (encoding 144, block engine, micro-MoE, evolve.ts, `/api/brain/evolve`, cờ `brain_evolve`) + HN-P2/P3 nếu đã làm;
- 3 entry worklog não (Q&A-NAO-3C, BLUEPRINT-EVO-NAO, BRAIN-D-BLUEPRINT);
- DB sandbox (không thể phục hồi từ git — đúng như runbook `docs/recovery/RESTORE-TMO.md`).

**Không mất gì:** BRAIN-D1 — phiên trước kết thúc ngay khi mới bắt tay (đọc schema) → chưa có dòng code nào để mất.

**An toàn ở main `00da3f3` (đã clone lại về `/home/z/tmo-app`):** lõi não Brain-A/B/C (`calibration-v3.ts`, `brains/policy.ts`, `brains/surrogate.ts`, `reward.ts`), engine MLP (`mlp.ts`, `optimizers.ts`, `losses.ts`, `activations.ts`, `spec-schema.ts`, `registry.ts`, `train-lock.ts`, `train-progress.ts`), **HN-P1** (`search-space.ts` + prisma `BrainSearchRun`/`BrainSearchCandidate`), tests r84–r102, 5 blueprint cũ, knowledge shards, runbook khôi phục.

**Bối cảnh môi trường user (xác nhận 2026-10-16):** TMO chạy trên máy **local** của user, tại đó **Qdrant KHÔNG trống** (vector đã populate thật) → log D1 tại local sẽ có kết quả nguồn vector thật ngay từ đầu.

**Cập nhật R21 (2026-10-17):** đợt FB-BRAIN-D1 phát hiện + fix 8 bug (BUG2-269..276) — nghiêm trọng nhất: **thiếu migration** KbConsultLog (máy user `db:deploy` sẽ không có bảng → corpus chết im lặng — đã bù migration `20261017060000_add_kb_consult_log`) + corpus mở rộng phủ fallback dense-only + graph-query (Chi tiết Bug_v2.md).

---

## 2. KIẾN TRÚC 3 NÃO HIỆN TẠI — ĐỀU DORMANT (số đo live DB trước reset)

| Não | Tên | Vai trò | Điểm gắn runtime | Cờ | Số đo thức tỉnh |
|---|---|---|---|---|---|
| **Brain-A** | "V3" | Calibration confidence | `kb-routing/kb-access.ts` → `getCalibratedConfidence()` (import `@/lib/calibration`) | `CALIBRATION_V3` | EvalResult=0 |
| **Brain-B** | "Vọng" | Surrogate P(success)/E[tokens]/E[duration] | registry + `brains/surrogate.ts` | `REPLAY_EVAL` | AgentRunRecord=0 |
| **Brain-C** | "Lệnh" | Policy mixture π = λ·π_Q + (1−λ)·π_net; λ = 1−min(n/200, WilsonLB) | organ-1 chọn model (`llm.ts` `maybeMixModelProbs`) · organ-2 advisory system-prompt (`code-team/workflow-engine.ts`) · organ-3 reward LOG-ONLY | `RUNTIME_POLICY` | QEntry visits=0 · ArbiterVerdict=0 · BrainModel=0 |

Nguyên tắc thiết kế giữ nguyên: **rawConfidence tách riêng khỏi calibrated confidence** (chống feedback-loop); brain chỉ được bật cờ khi điều kiện thức tỉnh đạt (đếm thật từ DB, fail-open).

**Lớp học quanh não (đã sống, không thuộc scope blueprint này):** Lesson engine (`episodic-memory/lessons.ts`, merge Jaccard ≥0.55, pattern ≥3 escalate) · `agent-brain.ts` PRE-ACT · Layer 9 adaptation · Q-table · ArbiterVerdict → composite reward.

---

## 3. ENGINE MLP CỐT LÕI (nguyên vẹn ở main — không phải làm lại)

- `mlp.ts`: tất định **bit-đối-bít** (seed cố định POLICY_SEED=42 cho policy head), early-stop holdout 15%, L2, gradient clip 5.
- Gate A1: bản mới chỉ được active khi **5-fold CV thắng đối chứng** (baseline = bản active hiện tại, hoặc heuristic majority cho bản đầu).
- `BRAIN_MAX_PARAMS = 250.000` — trần tham số mọi draft.
- `DRAFT_LIMITS` (spec-schema): 0–6 lớp ẩn × 1–256 units × 9 activation.
- Mọi inference runtime có **fail-open**: lỗi brain → rơi về heuristic cũ, không chặn pipeline.

---

## 4. KHÔNG GIAN TÌM KIẾM — HN-P1 (96 chiều, ĐÃ SỐNG) → EVO-P1 (ADDITIVE 144 chiều)

### 4.1 HN-P1 — encoding 96 chiều (sống ở main, KHÔNG đụng vào)

Đối chiếu [BLUEPRINT-HYPERNAS-P1-P5.md](./BLUEPRINT-HYPERNAS-P1-P5.md) §3.1: slot spec MLP hiện hành (layers/units/activations/loss/regularization) — bất biến, mọi ứng viên HN đều decode về `BrainDraftSpec` hợp lệ.

### 4.2 EVO-P1 — mở rộng additive 96 → 144 (VIẾT LẠI)

Nguyên tắc **ADDITIVE — BIJECTIVE TRONG MỖI VÙNG**: 96 chiều đầu giữ nguyên nghĩa HN-P1 (ứng viên thuần MLP decode y hệt trước); các block mới chỉ kích hoạt khi slot layer-type ≠ 0. Không có chiều nào đổi nghĩa ⇒ không phá tính tương thích dữ liệu/seed đã có.

| Vùng | Chỉ số | Nội dung |
|---|---|---|
| HN-P1 (giữ nguyên) | [0..95] | spec MLP chuỗi hiện hành |
| **Slot layer-type** | [96..113] | one-hot 3 block × 6 loại: `identity` · `MLP` · `attention-causal-1head` · `selective-SSM` · `micro-MoE` · `gated-residual` |
| **Tham số block** | [114..131] | 6 thông số/block: headDim (32/64/128) · SSM state N (8/16) · expansion rate (1–4) · MoE k (2–4) · dropout (0–0.3) · residual scale (0.5–2.0) |
| **MoE toàn cục** | [132..135] | k experts · router temperature · aux loss weight (0.01) · gating top-1/top-2 |
| **Dự phòng** | [136..143] | reserved 0 — cho tương lai (recursive hybrid, weight-sharing…) |

### 4.3 EVO-P2 — Block engine thuần TS (VIẾT LẠI)

- `blocks.ts`: mỗi block là 1 class implement forward + backward chuẩn; **CPU-first** — seq ≤512.
- `attention-causal-1head`: 1 head duy nhất, mask causal, O(L²) chấp nhận được ở L≤512; không multi-head, không flash attention.
- `selective-SSM`: state N=8–16 kiểu Mamba-lite (selective gate theo input), scan tuần tự O(L·N).
- Toàn bộ tất định (không dùng GPU/non-deterministic kernel) — giữ H4.

### 4.4 EVO-P3 — Micro-MoE (VIẾT LẠI)

- k=2–4 experts MLP nhỏ, router linear top-k; **aux loss 0.01 chống sập router** — chỉ bật khi tập train ≥2K mẫu (dưới ngưỡng thì MoE off khỏi search space).

### 4.5 EVO-P4 — Evolve runner + route (VIẾT LẠI)

- `evolve.ts`: vòng sinh ứng viên (mutation + crossover trong encoding 144, tôn trọng ngân sách H3 ≤24 ứng viên/10 phút) → train (gate A1) → chấm benchmark EVO-P0 → ghi `BrainSearchCandidate` (không giữ weights — H6). Toán tử di truyền PHẢI kèm **repair one-hot** (slot layer-type [96..113] sau mutation/crossover được re-sample về đúng 1 hot/block) — decode LUÔN ra ứng viên valid, không có "ứng viên hỏng" trong corpus (khác cờ `moeSkipped` Q4 — repair trả về encoding hợp lệ nên không cần ghi vết). **Crossover cha 96-dim (HN-P1 legacy) × cha 144-dim hợp lệ** nhờ additive: pad 0 lên 96→144 (vùng block toàn 0 = thuần MLP) — quy tắc pad pin tại evolve.ts (F4/0.5).
- `POST /api/brain/evolve`: khởi động/dừng/hỏi trạng thái; **cờ `brain_evolve` mặc định OFF**; route chỉ điều phối search ngoài runtime.

### 4.6 EVO-P4.1 — SMART SEARCH (R26): cơ chế TÍNH kích thước kiến trúc

Trước R26 vòng evolve sinh ứng viên thiên về ngẫu nhiên (#0 sample thuần; cha mutation/crossover chọn ĐỒNG DẪN uniform). User hỏi "NAS có cơ chế tính toán xác định số lớp/số nơ-ron hiệu quả chưa?" — trả lời bằng 3 mảnh trong `evo/smart-search.ts` (thuần + tất định H4):

- **`suggestArch` — bộ ước lượng giải tích** từ dữ liệu THẬT fixture (nSamples · inputDim · outputDim · ngân sách): số lớp ẩn L = <100 mẫu → 1 · <1000 → 2 · else 3; chiều rộng **kim tự tháp hình học** w_j = in·(out/in)^((j+1)/(L+1)) co dần về outputDim; **hệ số co giãn theo dữ liệu** √(n/(in+out)) kẹp [0,5..2]; **trần dung lượng** cap = min(250K, max(1500, 50·n)) — vượt thì LẶP co √(cap/P) tối đa 8 vòng (P ~ w² khi nhiều lớp, ~ w·(in+out) khi 1 lớp — một lần √ không đủ), dừng khi đạt cap hoặc mọi width chạm sàn 8 (dims I/O khổng lồ thì trung thực THÔNG BÁO vượt cap, không hạ sàn suy biến). Rationale tiếng Việt đầy đủ trả về cho UI.
- **Tích hợp vòng (evolve.ts):** ứng viên **#0 = hạt giống suggestArch** (hyper = default draft, blocks toàn identity — khởi đầu thuần MLP đã tính) thay sample ngẫu nhiên; cha mutation/crossover chọn theo **GIẢI ĐẤU tournament k=3** (bốc 3, lấy cvScore cao nhất — vòng sau khai thác vùng điểm cao); **mutation rate thích ứng** 0,15 → 0,06 tuyến tính theo tiến độ (khám phá sớm — khai thác muộn).
- **GET /api/brain/evolve kèm `suggestion`** (additive — knowledge không fixture thì không có): form E2 hiển thị kiến trúc gợi ý in→hidden→out + rationale + cơ chế tournament — user NHÌN THẤY cơ chế tính, không phải hộp đen.
- **H4 trung thực:** cùng seed + cùng fixture vẫn tái hiện bit-đối-bít TRONG CÙNG PHIÊN BẢN — chuỗi R26 khác R24-c (hạt giống #0 không tiêu thụ rng; tournament/adaptive đổi đường rng). Ghi nhận ở changelog, không âm thầm.
- Test r116 (15): bảng ngưỡng L + kim tự tháp đơn điệu + bất biến cap (đạt cap HOẶC chạm sàn) + tournament tất định + khai thác > uniform + rate biên/đơn điệu + hạt giống encode 144 hợp lệ decode thuần MLP + GET suggestion contract (policy đủ trường / knowledge undefined).

### 4.7 EVO-P5 — GPU sidecar (chưa triển khai)

Mini-service độc lập port riêng (`mini-services/evo-gpu/`) chạy benchmark ngoài runtime khi CPU không kịp; KHÔNG bao giờ đụng đường runtime của app (H1).

---

## 5. UI EVO-U1..U5 — TAB "TIẾN HOÁ" (đi kèm EVO-P4) — ĐÃ TRIỂN KHAI R25 (0.6.1)

> **Ghi nguồn trung thực:** chi tiết U1–U5 của v0.2 MẤT theo reset; v0.3 chỉ còn 5 dòng phác. Bản dưới tái tạo 2026-10-17 (v0.4) theo **cùng convention đã chốt** cho tab console SECTION 3 (precedent 0.2.2 HYPERNAS — tab bar 6 nút; EVO thêm nút thứ 7) — mọi nguyên tắc chắn §10.1 HYPERNAS áp dụng nguyên văn. **TRIỂN KHAI 2026-10-18 (R25-c):** tab "Tiến hoá" sống trên app — component `evolve-tab.tsx` (982 dòng) + `evo/ui-helpers.ts` thuần (302 dòng) + test r115 (18 test pin zone-split 96/144 biên literal, pure-MLP detection, Pareto front, state machine E1–E4) + r93 pin update 4→5 tab. Lệch thiết kế tham chiếu (có lý do): (a) E4 thêm nút "Chạy vòng mới" mở lại form E2 — §5.2 "vòng gần nhất hiển thị phía dưới" nay là form mở lại được chứ không chỉ 1 chiều; (b) prober probe glm-5.3-flash + extraction (kimi-k3 EOL — xem changelog); (c) dialog dùng shadcn Dialog có sẵn thay expandable row.

### 5.1 Nguyên tắc chắn riêng tab Tiến hoá (kế thừa 7 điều §10.1 HYPERNAS, điểm khác biệt ghi rõ)

1. **Đề xuất ≠ quyết định** (H2): mọi copy nói "đề xuất — bạn duyệt"; KHÔNG có chữ/nút nào hiểu là "máy tự thay não". Tab không đụng `BrainModel`/active.
2. **Single-source state:** tái dùng state SECTION 3 (`selectedBrainKey` + draft/dirty pattern) — không nhân bản state nháp.
3. **Hiện/ẩn theo cờ `brain_evolve`** (mặc định OFF — tab ẩn hoàn toàn khi off; cờ on + chưa đủ điều kiện → thân là trạng thái E1, không có đường "cờ on mà không thấy gì").
4. **Mobile-first:** baseline THỰC TẾ của SECTION 3 hôm nay = **4 tab** (Training Console · Tham số runtime · Nhật ký tinh chỉnh · Hàm & công thức — Task 26). Lộ trình: EVO-P4 thêm "Tiến hoá" → **5 nút**; khi HN-P2/P3 UI dựng lại theo HYPERNAS §10 (thêm "Tìm kiếm" + bộ tên console thiết kế đó) → đích **7 nút** — 375px: 7 nút × ~53px, label "Tiến hoá" 7 ký tự vẫn vừa (bậc trung gian 5–6 nút càng thoáng). Giữ pattern `min-h-[44px] md:min-h-[32px]` + `text-[10px]`; mọi bảng bọc `overflow-x-auto max-h-96 overflow-y-auto`. (Hiệu đính 0.5 — F2: bản trước liệt kê "Hiện trạng · Thống kê · Thay đổi · Tham số học · Tìm kiếm" là tên THIẾT KẾ HYPERNAS §10 chưa từng triển khai — HN-P2/P3 UI mất theo reset, xem §1.)
5. **A11y:** `role=tab/tabpanel` + `aria-selected` · progress `aria-live="polite"` · nút icon có `sr-only` · bảng `caption sr-only`.
6. **Poll thích ứng:** đang chạy vòng evolve → GET 2,5s (`POLL_ACTIVITY_MS` precedent); idle → 15s (`POLL_NEURAL_MS`); tab ẩn → dừng; **GET HTTP 404 (route chưa deploy) → E1 "CHƯA SẴN SÀNG" — KHÔNG phải mất kết nối**; lỗi khác (5xx/network) → giữ dữ liệu cũ + chip "mất kết nối" (không toast spam). (Hiệu đính 0.5 — F3: thiếu quy tắc này thì E1 và mất kết nối cùng biểu hiện "GET lỗi", UI không phân biệt được.)
7. **Không dependency mới:** hiệu ứng = CSS thuần + Tailwind tokens + keyframes + `prefers-re-reduced-motion`.

### 5.2 U1 — Tab "Tiến hoá": state machine 5 trạng thái thân tab

| Trạng thái | Điều kiện | Nội dung |
|---|---|---|
| **E1 — Chưa đủ điều kiện** | `brain_evolve` on nhưng EVO-P0..P4 chưa sống (GET `/api/brain/evolve` → **404** / benchmark chưa có fixtures) | Chip "CHƯA SẴN SÀNG" + dòng "Cần hoàn thành EVO-P0→P4 (xem blueprint §4) — tab sẽ tự kích hoạt khi hạ tầng sống". Không nút chạy. (Không có trạng thái "ngủ vì thiếu mẫu" như HN — evolve chấm benchmark tất định, không cần brain thức tỉnh.) |
| **E2 — Sẵn sàng** | hạ tầng sống, chưa có vòng chạy | Form: stepper số ứng viên 4–24 bước 4 (trần H3) · chọn não đích (A/B/C — evolve tìm kiến trúc thay thế cho não nào) · seed mặc định = hash(runId) — tất định theo từng vòng, HIỆN rõ, cho nhập lại đè (H4 — chạy lại cùng seed tái hiện bit-đối-bít) · dòng ngân sách "≈ 1–3 phút · tối đa 10 phút · ≤ 24 ứng viên · ≤ 250K tham số" · nút primary **"Bắt đầu tiến hoá"**. Vòng GẦN NHẤT hiển thị phía dưới nếu có. |
| **E3 — Đang chạy** | status=running | Thanh tiến độ kép: ứng viên `i/N` + % wall-time (≤10 phút H3) · rolling log ứng viên gần nhất ("#7 · MLP+attn1h+SSM · CV 0,164 · 2,4s") · nút **"Dừng"** (ghost) → `POST /api/brain/evolve/cancel` (cooperative — precedent HN §4.2-2c) · seed hiện để đối chiếu. |
| **E4 — Xong** | done / failed / cancelled | Bảng ứng viên (U2) + khối đề xuất + Pareto (U4). Failed → khối lỗi + "chạy lại cùng seed {seed} để tái hiện" (H4). Cancelled → banner "đã dừng lúc i/N — giữ N' ứng viên đã chấm". |
| **E5 — Chặn H7** | có ứng viên block-engine thắng CV nhưng chưa qua cổng latency | Khu vực riêng (xem U4) — ứng viên "thắng điểm nhưng chưa đủ nhanh để chạy runtime" hiển thị rõ, KHÔNG trộn với đề xuất chính. |

Chuyển trạng thái theo GET poll — không optimistic update (POST xong đợi GET xác nhận `running` rồi mới vào E3 — tránh UI nói dối khi route chặn 400).

### 5.3 U2 — Bảng ứng viên + 2 cấp nút áp dụng (precedent UX-7 HN)

**Bảng:** cột `#` · `Kiến trúc` (chuỗi compact — hàm format đặt tại `evo/blocks.ts` dùng chung server/UI, single-source; vd `[attn1h·64] → [ssm·N16] → MLP[128,64]`) · `Điểm CV` (số chính + ±CI bootstrap) · `Tham số` (viNum + % ngân sách 250K) · `p95 lat` (ms — đo benchmark inference) · badge `THẮNG ACTIVE` (amber) + badge `CHẶN H7` (đỏ nhạt — khi thắng CV nhưng p95 > 2× MLP chuỗi). Sort mặc định cvScore desc. Hiển thị ≤ 60 hàng mới nhất MỖI VÒNG — `max-h-96` scroll; **DB giữ toàn bộ hàng mọi vòng (H5 additive — không xóa)**. (Hiệu đính 0.5 — F5: bỏ cách ghi "prune H5" gây hiểu nhầm xóa DB.)

**Dialog chi tiết** (click hàng): spec đầy đủ bảng nhóm (giống Training Console) · metrics + so sánh active · **preview encoding 144 thanh phân vùng (U3)** · nút "Áp dụng vào nháp".

**2 cấp áp dụng:**

| Nút | Vị trí | Điều kiện bật | Hành vi |
|---|---|---|---|
| **"Áp dụng đề xuất"** | khối đề xuất E4 | ≥ 1 ứng viên `beatActive` VÀ qua H7 VÀ **editor v2 đã sống** (best có thể là block candidate — cùng điều kiện nút hàng, xem Lưu ý decode) | Ghi best vào nháp (qua dirty-guard confirm — precedent HN) |
| **"Áp dụng vào nháp"** | dialog từng hàng | LUÔN mở (nháp = không gian tự do; runtime chỉ lên qua A1 + H7) | Ghi spec ứng viên vào nháp |

**Lưu ý decode:** ứng viên có block (attention/SSM/MoE) decode về draft **định dạng mới** (không phải `BrainDraftSpec` MLP thuần) — nút "Áp dụng vào nháp" chỉ khả dụng khi SECTION 1 editor hỗ trợ hiển thị block ( milestone EVO-P4 UI); trước đó dialog hiển thị spec read-only + dòng "Kiến trúc block cần editor v2 (kèm EVO-P4)". Đây là lý do EVO-P4 gồm cả editor mở rộng.

### 5.4 U3 — Encoding viewer 144 chiều (thanh phân vùng theo vùng §4.2)

- 1 hàng ngang `h-3` chia 5 đoạn theo vùng: HN-P1 [0..95] (xám đậm) · layer-type [96..113] (amber) · tham số block [114..131] (cam) · MoE toàn cục [132..135] (vàng) · dự phòng [136..143] (xám nhạt).
- Mỗi đoạn: độ sáng theo "mức kích hoạt" (giá trị chuẩn hoá 0–1 của slot trong encoding); hover tooltip hiện chi tiết slot (id vùng, chỉ số, giá trị decode, nghĩa).
- Ứng viên thuần MLP → 3 đoạn EVO tối đen + chip "thuần MLP (tương thích HN-P1)" — nhìn 1 giây biết ứng viên có block hay không.
- **Compat 2 độ dài (F4/0.5):** hàng legacy HN-P1 có `encodingJson` 96-dim → viewer chỉ vẽ vùng [0..95] + chip "96-dim (HN-P1 — không vùng block)"; 144-dim → đủ 5 vùng. Vùng [0..95] không đổi nghĩa (§4.2) nên cùng hàm vẽ được cả hai.
- Đặt trong dialog chi tiết U2 (không phải tab riêng — tiết kiệm không gian).

### 5.5 U4 — Biểu đồ Pareto CV-score × params × p95-latency

- Scatter (SVG thuần — không lib mới): trục X = params (log), trục Y = cvScore, kích thước điểm ∝ p95 latency (legend giải thích), màu: xám (thua active) · amber (thắng CV) · đỏ nhạt viền (CHẶN H7 — p95 > 2× baseline).
- Đường Pareto front (nét đứt amber) trên tập "thắng CV" — user thấy ngay trade-off điểm/tham số/độ trễ.
- Khu vực E5 (chặn H7): danh sách rút gọn bên dưới chart + dòng giải thích "Ứng viên thắng điểm CV nhưng chậm hơn 2× bản MLP chuỗi — không đề xuất áp runtime (rào H7); dùng cho phân tích/offline".
- `< md`: chart ẩn, thay bằng bảng 3 cột (top Pareto front).

### 5.6 U5 — Kill-switch panel: 2 cờ + audit 1 chỗ

- Panel cuối tab: cờ `brain_evolve` (search on/off) + kill-switch toàn cục mọi não search — **đặt tên `brain_search_global`** (áp chung HN-search + EVO). LƯU Ý (0.5): `brain_search` là cờ HN-P2 theo HYPERNAS §10 — cả 2 cờ CHƯA tồn tại trong code (HN-P2/P3 mất theo reset, `/api/brain/search` không còn) → dựng lại cùng đợt viết lại HN-P2, đặt tên ngay từ đầu tránh đổi key sau (tuning key đổi = mất giá trị user). Cùng 1 khối, toggle qua tuning-store (ghi TuningChangeLog audit — precedent §10 HYPERNAS).
- Hiển thị trạng thái 2 cờ + 5 dòng audit mới nhất (ai đổi, khi nào, giá trị cũ→mới).
- Copy chốt: "Tắt evolve không mất dữ liệu đã chấm — bảng ứng viên vẫn xem được."

### 5.7 API contract (pin khi triển khai — test r108)

```ts
// GET /api/brain/evolve?brain=KEY&runId=<id> — runId omit = vòng mới nhất
interface EvolveGetResponse {
  ok: true
  run: {
    id: string; brain: string
    status: 'running' | 'done' | 'failed' | 'cancelled'
    seed: number; candidatesMax: number
    progress: { done: number; total: number; elapsedMs: number; wallMsMax: number }
    summary?: { bestCandidateIdx: number | null; nBeatActive: number; nBlockedH7: number; durationMs: number }
    error?: string
  } | null
  candidates: Array<{
    idx: number; archSummary: string        // format chung server/UI (single-source)
    cvScore: number; ciLow: number; ciHigh: number
    params: number; trainMs: number; p95LatencyMs: number
    beatActive: boolean; blockedH7: boolean
    encoding: number[]                      // 144 — U3 viewer dùng (KHÁC HN: EVO cần hiển thị encoding)
    spec: unknown                           // draft mới định dạng block — schema chốt ở EVO-P2
  }>
}
// POST /api/brain/evolve { brain, candidates?, seed? } → { ok: true, runId } | 400 { ok: false, reason }
//   reason PIN (0.5 — client hiển thị đúng từng lỗi): 'flag_off' (cờ brain_evolve off)
//   | 'already_running' (một vòng chạy một lần) | 'invalid_brain' (ngoài A/B/C)
//   | 'invalid_candidates' (ngoài 4–24 bước 4)
// POST /api/brain/evolve/cancel { runId } → { ok: true } // idempotent
```

Khác HN-P2 contract đúng 2 chỗ (có lý do): (1) `encoding` TRẢ VỀ client (U3 viewer cần — HN ẩn vì predictor server-side); (2) thêm `p95LatencyMs` + `blockedH7` (rào H7 riêng của EVO).

### 5.8 Copy tiếng Việt chốt sẵn

- Tab: **"Tiến hoá"** · mô tả: "Phòng thí nghiệm tiến hoá kiến trúc — sinh ứng viên (MLP + attention/SSM/MoE), train + kiểm định chéo thật, xếp hạng để bạn duyệt. Không tự thay não vận hành."
- Nút: "Bắt đầu tiến hoá" / "Dừng" / "Áp dụng đề xuất" / "Áp dụng vào nháp"
- Empty: "Chưa có vòng tiến hoá nào — bấm Bắt đầu tiến hoá"
- Failed: "Vòng lỗi: {error} — chạy lại cùng seed {seed} để tái hiện"
- H7: "Thắng điểm nhưng chậm hơn 2× bản MLP chuỗi — giữ lại để phân tích, không áp runtime"

---

## 6. RÀO AN TOÀN BẤT BIẾN H1–H8 + KILL-SWITCH

| # | Bất biến | Nguyên tắc |
|---|---|---|
| **H1** | Runtime bất khả xâm phạm | Không bao giờ chạy block mới (attention/SSM/MoE) trong đường runtime production tới khi qua cổng H7 |
| **H2** | Search chỉ đề xuất | Ứng viên chỉ thành `BrainSearchCandidate` + nút áp dụng; không tự thay brain active |
| **H3** | Ngân sách | ≤24 ứng viên/10 phút (CPU box 4GB, 2 core) |
| **H4** | Tất định | Bit-đối-bít, seed cố định, không kernel non-deterministic |
| **H5** | DB additive | Không xóa/đè dữ liệu cũ; ingestion D0 merge (resolver), không drop node |
| **H6** | Không lưu weights ứng viên | Chỉ spec + metrics lưu lại; weights bị vứt sau đánh giá |
| **H7** | Cổng block runtime | Block attention/SSM chỉ được chạy runtime khi **thắng CV đối chứng** VÀ **p95 latency ≤ 2× bản MLP chuỗi** |
| **H8** | Không thoái bộ | Bản mới không được tệ hơn 3 tiêu chí CV của bản active (cvScore · Brier/đối chứng · tính tất định) |

**Kill-switch 2 lớp:** cờ tuning per-feature (`brain_evolve`, `runtime_knowledge`, `knowledge_organ_strategy`…) + kill-switch toàn cục mọi não search. **Fail-open mọi nhánh:** lỗi evolve/inference → fallback heuristic, pipeline không bao giờ chết vì não.

---

## 7. PHỤ THUỘC & THỨ TỰ TRIỂN KHAI (ĐÃ DUYỆT 2026-10-16 — GIỮ NGUYÊN)

```
D1 LOG-ONLY ──(≥100 log)──► D2 baseline ──(≥300 log có Outcome*)──► D3 policy head ──► D4 (cần EVO-P1..P4)
D0 (đo khối lượng + ingestion Neo4j)  ── song song với D1, độc lập
EVO-P0→P4 (viết lại phần MẤT)         ── độc lập D1/D2; D4 cần cả hai nhánh
```

1. **BRAIN-D1 LOG-ONLY** — ✅ **HOÀN TẤT (R20 + FB-BRAIN-D1 R21)** — không phụ thuộc não thức tỉnh; chính là công cụ TẠO dữ liệu train cho D3 (triết lý "quan sát trước, hành động sau", tiền đề reward.ts).
2. **Blueprint v0.5** (file này) — phản ánh Q7=(b)/Q9=D0 + tái tạo §5/Q1–Q6 + trạng thái D1 + §8.5 UI topology Brain-D.
3. **D0** — ✅ **HOÀN TẤT phần đo + trial (R24-a)**: 9 shard 868 chunk · trial 002 thật +408 node/+1.161 rel trên Aura · quota an toàn. 8 shard còn lại: chờ user duyệt theo khuyến nghị report (thứ tự 001 → 003/005 → 004 → 006/007/008 → 009, probe NIM trước). **UI ghost topology §8.5 mốc (a): ✅ HOÀN TẤT (R24-b — r114).**
4. **EVO-P1..P4 viết lại** — ✅ **HOÀN TẤT (R24-c)**: benchmark P0 (fixtures dữ liệu thật) → encoding 144 → blocks → MoE → evolve + routes + 2 cờ; tests r105–r108 + live-verify.
5. **D2 → D3 → D4** theo ngưỡng log.
6. **MỖI MỐC: commit + dual-push NGAY** (doctrine reset — xem phần đầu file).

---

## 8. BRAIN-D "TRI THỨC" — NÃO THỨ 4 (D1 xong; D2–D4 thiết kế chốt, chưa triển khai)

> **Yêu cầu gốc của user (2026-10-16, định nghĩa North Star):** *"Brain-D mang lại khả năng SỬ DỤNG dữ liệu, tri thức trong KB để THỰC HIỆN CÁC TÁC VỤ chứ không đơn thuần là trả lời."*
> Brain-D không phải search-engine tốt hơn — nó là **policy head quyết định CÁCH dùng KB trong từng tác vụ**: nạp context gì, duyệt đồ thị thế nào, bỏ qua KB khi nào.

### 8.1 D1 — LOG-ONLY (HOÀN TẤT R20 + rà soát R21)

**Bảng `KbConsultLog` (prisma, additive) — đã sống + có migration `20261017060000_add_kb_consult_log`:**

| Trường | Kiểu | Ghi chú |
|---|---|---|
| id | String @id | uuid |
| createdAt | DateTime | mặc định now — index |
| taskType | String? | 'chat' · 'tool:<tên>' · 'smart-kb' · 'kb-fallback-dense' · 'graph-query' · NULL (caller không bọc — eval/redteam) — index |
| intent | String? | intent-classifier (casual/meta/procedural/factual) |
| queryText | String? | câu hỏi/Cypher đã dùng — rút gọn 2.000 **byte** UTF-8, ranh giới ký tự (R21 fix) |
| retrievalConfigJson | String | cấu hình HIỆU LỰC: {topK, minImportance, embeddingOverride, hybrid, mmr, rerank, **denseThreshold** (tham số duy nhất biến thiên — red-team delta), **sourcesEnabled**} (R21 fix) |
| sourcesJson | String | nguồn + số hit: {chunks, entities, memories, communities, errors?} hoặc {graphRecords, graphError?} / {pipelineError} |
| topResultsJson | String | top-K: id, source, score, denseScore? (≤4.000 **byte** truncate + flag — R21 fix) |
| confidence / rawConfidence | Float? | SAU calibration (Brain-A) + raw heuristic TÁCH RIÊNG (chống feedback-loop) |
| step2Used | Boolean? | D1 v1 để NULL |
| tokensUsed | Int | **D1 v1 LUÔN 0** — API embed/rerank chưa trả usage; D2 dùng latencyMs làm chiều hiệu năng chính (R21 chốt) |
| latencyMs | Int | thời gian truy xuất |
| runId | String? | nối AgentRunRecord → **Outcome\*** — index |
| sessionId / agentId | String? | phiên chat / agent |

**Phạm vi corpus D1-v1 (trung thực sau R21):** MỌI lượt `searchUserKB` (choke point — chat/agent tools/eval/redteam đều qua) + MỌI lượt rơi vào **fallback dense-only** (searchUserKB throw → row `kb-fallback-dense` kèm lý do) + MỌI **agentGraphQuery** Cypher (`graph-query` — corpus cho D3 structured-subgraph/traversal-plan). **Ngoài corpus (ghi nhận):** kết quả chi tiết của fallback (hits/minScore — nằm ở diagnostics tool), `searchModelKnowledge` (chưa có production caller), writeback LAYER 3 — instrument thêm khi D3 cần.

**Instrumentation (LOG-ONLY — KHÔNG chặn):** `kb-access.ts` searchUserKB (điểm choke duy nhất, capture per-source errors từ allSettled) · `consult-context.ts` ALS truyền ngữ cảnh (merge shallow lọc undefined — R21 fix) · `consult-log.ts` writer never-throw (warn throttle 60s, cap theo byte) · tool-executor + chat route + runSmartKB wrap ALS. **Cờ `kb_consult_log`** trong tuning-store (mặc định **ON** — #32, node kb-access #24, edges e38–e42).

**Ngưỡng nghĩa:** D1 bắt đầu "có dữ liệu" ≥100 log → D2; ≥300 log có Outcome* → D3.

### 8.2 D2 — Baseline đối chứng

Script report trên KbConsultLog thật: heuristic CỨNG hiện tại (pipeline 4 lớp cố định) đạt mức nào — phân phối latency theo intent (chiều tokens trống D1-v1 — dùng latencyMs), tỷ lệ nguồn trúng (kể cả nguồn tắt vs trống vs lỗi — sourcesEnabled), tương quan kết quả↔Outcome*. Đầu ra: docs report + bộ số liệu đối chứng cho D3 phải thắng (gate A1 tương tự).

### 8.3 D3 — Policy head 3 tầng action space (Q7 = PHƯƠNG ÁN (b) — kèm CHẾ ĐỘ VẬN DỤNG)

`brain/brains/knowledge.ts` — đầu vào là (taskType, intent, embedding câu lệnh, trạng thái KB, lịch sử consult gần đây, **tổng quan corpus ×6 — R31: graphNodes/lessons/episodes/chunks/communities/memories log-scale, định nghĩa `corpus-dims.ts`, số đếm thật từ `/api/brain` corpusOverview**); đầu ra hành động 3 tầng:

**Tầng 1 — Chế độ vận dụng (CÁCH KB được DÙNG để làm tác vụ — trái tim Q7=(b)):**
1. `context-block` — đóng gói tri thức truy xuất thành khối context nạp thẳng cho agent (mặc định, tương đương hành vi hôm nay);
2. `structured-subgraph` — xuất subgraph Neo4j có cấu trúc (nodes+edges+labels JSON) cho agent lập luận trên đồ thị;
3. `traversal-plan` — sinh kế hoạch duyệt multi-hop (bắt đầu từ node nào, mở quan hệ gì, dừng khi nào) để agent TỰ đi từng bước bằng tool — dùng khi câu hỏi cần suy luận chuỗi dài trên đồ thị.

**Tầng 2 — Tham số truy xuất:** nguồn bật/tắt (neo4j/qdrant:chunks/communities/memories) · topK · trọng số hybrid BM25+RRF · MMR λ · cross-encoder rerank on/off · độ sâu traversal.

**Tầng 3 — Meta:** `skip` (bỏ hẳn KB — task không cần) · `writeback` (ghi episode/lesson vào KB sau run).

**An toàn:** kill-switch 2 cờ `runtime_knowledge` (OFF mặc định) + `knowledge_organ_strategy`; mixture λ ramp như Brain-C (bắt đầu 100% heuristic, nhường dần khi dữ liệu đủ); **fail-open về heuristic CỨNG mọi nhánh lỗi**; train chỉ trên KbConsultLog có Outcome*.

### 8.4 D4 — Vào NAS/EVO space

Mở encoding §4 thêm vùng head Brain-D (sau vùng dự phòng [136..143] — vùng mới [144..) khi mở rộng tiếp) — kiến trúc knowledge head do evolve tìm thay vì hand-tune. Chỉ khởi động khi EVO-P1..P4 + D3 đều sống.

### 8.5 UI — TOPOLOGY DIAGRAM BRAIN-D TRONG TAB BRAIN (bổ sung 0.5 — yêu cầu user 2026-10-17)

> **Bối cảnh:** tab BRAIN (Smolab — 3 SECTION dọc: Chọn não & kiến trúc · Đài quan sát não · Bảng thông số) hôm nay chỉ có 3 não A/B/C trong `BRAIN_REGISTRY` (`src/lib/brain/registry.ts` — single-source doctrine #9); Brain-D "Tri Thức" chưa có chỗ đứng trong UI dù D1 đã sống (node `kb-access` trong đồ thị 23 node tab Kiến trúc Database mới chỉ ghi chú "nhà tương lai của Brain-D"). Nguyên tắc nền: **topology hiển thị NGAY từ D1 dưới dạng ghost (spec khởi điểm + tiến độ thức tỉnh) — không đợi D3 có model** — precedent: A/B/C hiển thị `planned.layers` + chip NGỦ khi dormant (lifecycle badge brain-studio.tsx).

**8.5.1 Nơi đặt — mặc lại đúng 3 SECTION có sẵn, không cấu trúc mới:**

| SECTION | Thêm gì cho Brain-D |
|---|---|
| 1 · Chọn não & kiến trúc | Nút thứ 4 trong segmented selector (grid 1/2/4 cột theo breakpoint) — key `knowledge`, tên "Tri Thức", dot lifecycle như A/B/C; khối "Thức tỉnh khi đủ mẫu" hiển thị **thanh tiến độ KÉP**: log tổng (ngưỡng ≥100 → D2) + log có Outcome* (ngưỡng ≥300 → D3) — đếm thật từ `KbConsultLog`; badge 2 cờ `runtime_knowledge` + `knowledge_organ_strategy` |
| 2 · Đài quan sát não | BrainStage vẽ topology 3 cụm đầu ra (8.5.2); trước D3 chỉ có chế độ kiến trúc — chip "DỰ KIẾN — CHƯA HỌC" (không có weights/activity); sau D3 bật activity như A/B/C |
| 3 · Bảng thông số | như não khác: Training Console (nút train chỉ bật khi THỨC) · Tham số runtime (2 cờ) · Nhật ký tinh chỉnh · Hàm & công thức |

**8.5.2 Hình topology — 3 CỤM ĐẦU RA ĐỒNG THỜI (khác precedent tab-head Brain-B):**

Brain-B "Vọng" dùng 3 TAB đầu ra (`SurrogateHead` success/tokens/durationMs — brain-stage.tsx) vì đó là 3 MLP RIÊNG, 3 lần train riêng. Brain-D ngược lại: **3 tầng action space là MỘT quyết định** (một forward pass ra cả 3 tầng cùng lúc — §8.3) → vẽ ĐỒNG THỜI 3 cụm cạnh nhau, KHÔNG dùng tab:

```text
input                         trunk chung                      3 cụm đầu ra (một quyết định)
┌───────────────────┐        ┌──────────┐        ┌─ Tầng 1 · Chế độ vận dụng (amber) — 3 unit softmax
│ taskType 1-hot    │        │          │        │    context-block · structured-subgraph · traversal-plan
│ intent 1-hot ×4   │───────▶│ 32 tanh  │───────▶├─ Tầng 2 · Tham số truy xuất (cyan) — 9 unit
│ embedding ×2048   │        │          │        │    4 nguồn on/off · topK · trọng số hybrid · MMR λ · rerank · độ sâu
│ trạng thái KB     │        └────┬─────┘        ├─ Tầng 3 · Meta (fuchsia) — 2 unit sigmoid
│ lịch sử consult   │─────────────┘─────────────▶│    skip · writeback
│ tổng quan corpus  │        ┌──────────┐        └─
│   ×6 (R31)        │        │ 16 tanh  │
└───────────────────┘        └──────────┘
```

- **Spec khởi điểm (ghost):** input ≈ 2048 + **~36 chiều cfg** (taskType hash-bucket · intent 1-hot 4 · trạng thái KB · lịch sử consult · **6 CHIỀU TỔNG QUAN CORPUS R31** — graphNodes/lessons/episodes/chunks/communities/memories theo log₁₀(1+v) `corpusDimScaled`, số đếm thật Neo4j COUNT-store + Qdrant count cache 60s — chốt đếm chính thức khi D3) → trunk 2 lớp ẩn 32/16 tanh (tiền lệ Brain-C 32 tanh) → 3 cụm đầu ra. Tổng tham số khởi điểm ~67K — trong trần 250K (`BRAIN_MAX_PARAMS`), chừa dư địa cho D4 evolve nở kiến trúc. **Lý do 6 chiều corpus (R30→R31):** Brain-D không nạp NỘI DUNG KB (nó là policy head quyết CÁCH dùng KB trước khi truy xuất — nội dung đi vào AGENT context); 6 chiều là TÍN HIỆU ĐẦU ĐU cho policy biết corpus giàu/nghèo nguồn nào để chọn nguồn + chế độ vận dụng — bằng chứng giá trị từ D2 baseline R31: chunks trống 14/17 + r(hits↔success) −0,271 → policy cần BIẾT trước khi bật nguồn.
- **Mở rộng stage-geometry ADDITIVE:** `buildStageLayout` hiện vẽ cột tuần tự 1 chuỗi đầu ra → `StageColumn` thêm trường nhóm `headGroup?: 'mode' | 'retrieval' | 'meta'` (cột cùng nhóm dính nhau, 3 nhóm cách nhau bởi khe + label nhóm + màu accent amber/cyan/fuchsia); mọi công thức toạ độ giữ nguyên — chỉ thêm khoảng cách nhóm. Test geometry mở rộng theo precedent stage-geometry thuần (r90-style).
- **Mixture λ hiển thị** như Brain-C: dòng "λ = 1 − min(n/200, WilsonLB)" + chip "% heuristic vs não" (bắt đầu 100% heuristic — §8.3).
- **Legend/tooltip:** hover cụm → tooltip giải thích tầng (copy §8.3); hover unit đầu ra → tên chế độ/tham số tương ứng (map tĩnh từ spec — không cần API mới).

**8.5.3 API & dữ liệu (không route mới):**

- `GET /api/brain` thêm signals cho `knowledge`: `kb_logs_total` (→ ngưỡng D2 ≥100) + `kb_logs_with_outcome` (→ ngưỡng D3 ≥300) — đếm thật `KbConsultLog` (COUNT + COUNT WHERE runId NOT NULL — index sẵn 3 cột). `BRAIN_REGISTRY` thêm `BrainSpec` key `knowledge`: `flagTuningKey: 'runtime_knowledge'`, `trainable: false` (đến D3), lifecycle tính như A/B/C theo 2 signals trên.
- Ghost topology = `planned.layers` mở rộng nhóm đầu ra — client render thuần từ registry (tiền lệ planned A/B/C), không fetch thêm.

**8.5.4 Rào & nguyên tắc:** không dependency mới (SVG/tokens có sẵn) · a11y đúng §5.1-5 (role/aria-live/sr-only) · mobile-first (stage co theo `NEURAL_DESKTOP_BREAKPOINT`; 3 cụm đầu ra xếp dọc `<md` — surrogate 3 đầu đã xử lý pattern tương tự) · kill-switch 2 cờ hiển thị ngay SECTION 1 (đổi qua tuning-store, audit Nhật ký tinh chỉnh) · **tab BRAIN không đụng `BrainModel`/active** — topology là HIỂN THỊ, mọi áp dụng vẫn qua A1/H7 như §6.

**8.5.5 Triển khai 2 mốc:** (a) **ghost UI** — ✅ **HOÀN TẤT R24-b (test r114, browser-verify 4 mục)**: nút não thứ 4 + topology 3 cụm + tiến độ kép đếm thật + 2 cờ badge; (b) **activity UI** (weights/đài quan sát nơ-ron như A/B/C) — kèm D3 (r112). Không mốc nào chặn đường runtime.

---

## 9. KB 4 LỚP — NEO4J LÀ LÕI (đính chính user 2026-10-16, giữ nguyên)

| Lớp | Vai trò | Hiện trạng |
|---|---|---|
| **1. Neo4j GraphRAG — LÕI** | Đồ thị tri thức — **AuraDB sandbox: 96.354 node / 205.809 quan hệ / 23 label (đo trực tiếp R22, 2026-10-17, sau khi nối lại phòng)**; máy user local Neo4j Desktop ~53.742 node (số liệu 2026-10-16). 8 ENTITY_LABELS: Concept/Technology/Framework/Vulnerability/Principle/Domain/Document/Person + cộng đồng Leiden + node Episode/Lesson | Lõi suy luận (structured-subgraph/traversal-plan của D3 bám vào đây) |
| **2. Qdrant vector** | 3 collection: chunks / communities / memories | **Local user: KHÔNG trống** (populate thật) — D1 sẽ log kết quả thật |
| **3. `kb-routing/` pipeline** | 4 lớp heuristic CỨNG: intent-classifier → kb-access (4 nguồn song song + hybrid BM25+RRF + MMR + cross-encoder rerank) → writeback → synthesis | Đối chứng cho D2; fail-open target của D3 |
| **4. `knowledge/` 9 shard (2.2MB)** | Tài liệu GỐC — nguồn sự thật cuối: SHD_GEN_CAUSAL_HYPER_001 · SHD_NAS_EVOLUTION_002 · SHD_OPT_CONVEX_003 · SHD_SYS_DYNAMICS_004 · SHD_CORE_GRAPH_005 · SHD_COMPLEXITY_006 · SHD_DSL_007 · SHD_GTH_008 · PSY-CORE-SCI-009 | **CHƯA ánh xạ vào Neo4j → D0 xử lý** |

**D0 (duyệt Q9):** đo khối lượng từng shard (đếm entity/type tiềm năng bằng extraction mẫu) → ingestion theo đợt shard bằng ingestion sẵn có (LLM extraction + entity-resolver merge theo ngưỡng tương đồng — **additive H5, không drop node cũ**); ưu tiên shard giá trị cao nhất trước (NAS_EVOLUTION_002 + GEN_CAUSAL_HYPER_001 phục vụ trực tiếp đợt EVO).

---

## 10. CÂU HỎI MỞ Q1–Q9 (Q7/Q9 CHỐT — Q1–Q6 TÁI TẠO v0.4)

> **Ghi nguồn trung thực:** văn bản chi tiết Q1–Q6 của v0.2 mất theo reset. Bảng dưới tái tạo 2026-10-17 từ tri thức phiên (nội dung thảo luận kiến trúc não + ràng buộc vận hành đã biết) — **mỗi câu cần user chốt khi tới phase tương ứng**; ghi lại kết luận vào đây khi chốt.

| # | Câu hỏi (tái tạo v0.4 — chốt khi tới phase) | Phase liên quan | Đề xuất mặc định |
|---|---|---|---|
| **Q1** | **Benchmark EVO-P0 dùng dữ liệu nào?** Mỗi não có nguồn nhãn khác nhau (A: EvalResult · B: AgentRunRecord · C: QEntry+ArbiterVerdict). Ứng viên EVO chấm trên benchmark nào để CÔNG BẲNG với Brain-C active? | EVO-P0 | Fixtures tất định tái lập từ snapshot dữ liệu thật từng não + báo cáo kèm fingerprint (đúng convention HN `dataFingerprint`) — không phát sinh dữ liệu fake |
| **Q2** | **Ngân sách H3 (≤24 ứng viên/10 phút) giữ nguyên cho EVO?** Block engine đắt hơn MLP thuần (attention O(L²), SSM scan tuần tự) — 24 ứng viên block có thể không vừa 10 phút trên CPU box 4GB | EVO-P1/P4 | Giữ 24/10' nhưng đo thêm per-candidate budget (đặt H3 theo **số ứng viên × thời gian**, chặn sớm ứng viên quá đắt — đo p95 từ P2 benchmark) — **ĐÃ TRIỂN KHAI R31 (r118): `shouldAbandonCandidate` bỏ train/score khi vượt wall budget, row + note `candidate_budget_exceeded` + `abandoned:true`; H4 giữ: chuỗi SINH ứng viên vẫn tất định theo seed, chỉ scoring bị cắt** |
| **Q3** | **Crossover giữ hay chỉ mutation?** Crossover 2 cha trong encoding 144 vẫn tất định (seed chọn cha) nhưng sinh không gian khám phá ít đa dạng hơn ở vùng block mới (chưa có lịch sử tốt để lai) | EVO-P4 | Vòng đầu: 80% mutation / 20% crossover; adaptive theo tỷ lệ thắng (crossover tăng khi corpus ứng viên thắng đủ dày) — **ĐÃ TRIỂN KHAI R31 (r118): `adaptiveCrossoverRate(pastWinners)` 0,2 base · ≥8 beatActive quá khứ → 0,4 · ≥24 → 0,6; corpus rỗng giữ đúng chuỗi 80/20 của R26 (H4 cùng phiên bản)** |
| **Q4** | **MoE dưới ngưỡng 2K mẫu: tắt hẳn khỏi search space hay để động?** Tắt hẳn = encoding mọi ứng viên decode về không-MoE (đỡ tính toán, mất khả năng khám phá sớm); động = decode valid nhưng skip khi train (giữ "dấu vết" khám phá trong corpus) | EVO-P3 | Động (slot vẫn sampled + ghi vào candidate kèm cờ `moeSkipped`) — corpus D2/D4 sau này thấy được "hệ thống đã từng thử gì" |
| **Q5** | **D0 chạy trên hạ tầng Neo4j nào?** Máy user có Neo4j Desktop local (đồ thị ~53.742 node đang sống, 2026-10-16); sandbox AuraDB cloud **đã nối lại thành công R22** (96.354 node / 205.809 quan hệ — đo 2026-10-17; free-tier Aura ~200K node → đã dùng ~48% quota, D0 ingestion thêm node cần cân nhắc quota) | D0 | Ingestion chạy trên máy USER (script + hướng dẫn kèm commit — precedent warm-start); sandbox đo khối lượng shard THẬT (đếm entity mẫu — nay khả thi vì Aura đã sống) + chạy ingestion THỬ trên 1 shard nhỏ để ước node tăng trước khi quyết |
| **Q6** | **EVO-P5 GPU sidecar có đáng làm?** Box hiện 4GB/2 core CPU; user chưa xác nhận có GPU; benchmark EVO-P0..P4 thiết kế CPU-first — sidecar chỉ có giá trị khi search space mở rộng vượt CPU | EVO-P5 | **Hoãn vô hạn định (mở)** — chỉ khởi động khi EVO-P4 thực tế chứng minh CPU không kịp (đo wall-time thật ≥ 2× ngân sách) — tránh xây hạ tầng không ai dùng |
| **Q7** | D3 có kèm chế độ vận dụng hay chỉ tinh chỉnh tham số truy xuất? | **CHỐT = (b)** kèm cả 3 chế độ vận dụng (context-block/structured-subgraph/traversal-plan) — 2026-10-16 | — |
| **Q8** | Tín hiệu Outcome* cho D3 dùng gì: Outcome* run (thành công/tokens/thời gian) hay citation-counting (kết quả KB có được dùng trong câu trả lời)? | D3 | Mở — **đề xuất mức 1** (Outcome* trực tiếp, đơn giản đo được từ D1 runId) trước khi cân nhắc mức 2 |
| **Q9** | Có thêm D0 ánh xạ 9 shard `knowledge/` vào Neo4j không? | **CHỐT = CÓ** — D0 vào §8/§9, đo khối lượng trước, tách đợt được — 2026-10-16 | — |

---

## 11. NHẬT KÝ HIỆU ĐINH

- **0.9 (2026-10-18, task R31):** RÀ SOÁT TOÀN BỘ BLUEPRINT + 6 CHIỀU TỔNG QUAN CORPUS + D2 TOOLING + Q2/Q3 ĐÓNG + OBSERVATION CHO EVO. User: "thêm vài chiều tổng quan corpus đi + nếu còn blueprint chưa triển khai hoặc chưa triển khai hết thì hãy triển khai". **(1) Audit toàn cảnh (3 agent đọc 8 blueprint + 4 implementation plan + 12 doc planning):** BRAIN P1–P4 + STATS 22/22 + OBSERVATION 4/4 + SMOLAB/ALISTA/research-team ~100% ĐÃ triển khai; HYPERNAS HN-P1 sống, HN-P2/P4 SUPERSEDED bởi EVO (encoding 96 là nền của 144, evolve.ts thay search runner — KHÔNG dựng lại), HN-P3 (predictor học) hoãn theo dữ liệu (32 candidate < 40 cold-start), HN-P5/BRAIN-P5 hoãn theo Q6; D3/D4 DATA-BLOCKED (15/300 log Outcome*). **(2) 6 chiều tổng quan corpus (§8.3/§8.5.2 — user chốt):** `src/lib/brain/corpus-dims.ts` (thuần — type + CORPUS_DIMS 6 mục thứ tự cố định + `corpusDimScaled` log₁₀(1+v) fail-open) + `corpus-overview.ts` (server: Neo4j COUNT-store O(1) ×3 + Qdrant count exact ×3, cache 60s, fail-open từng nguồn) + `/api/brain` gắn `corpusOverview` additive CHỈ cho knowledge + UI SECTION 1 grid 6 ô (typography console 9–11,5px precedent R27) — r121 12 test (A log-scale · B thứ tự dims · C wiring pins registry/spec-schema/route/UI) + r114 hiệu đính 2 pin label 'cfg ~30'→'cfg ~36'. **(3) D2 TOOLING (31-d):** `scripts/d2-baseline-report.ts` (env-guard chống shell leak DATABASE_URL — bắt được bẫy thật: shell có DATABASE_URL trỏ DB khác) + `src/lib/kb-routing/d2-stats.ts` thuần (percentile nội suy · summarizeLatency · parser fail-open · classifySourceOutcome 5 nhánh · correlateOutcome Pearson fail-open n<3/variance-0) — r117 31 test; report THẬT corpus 40 log: latency p50 206,5ms/p95 1.019,6ms · nguồn entities 93,8% hit > communities 52,9% > chunks 17,6% (trống 14/17) ≈ memories 18,8% · graph Cypher 87% · calibrated≡raw 0/17 lệch (CalibrationModel chưa train) · r(conf↔success) 0,090 (n=7) · r(hits↔success) −0,271 (n=30) · r(latency↔success) 0,082 — CẢNH BÁO MỎNG đầu report (40/100 D2, 30/300 D3); output `docs/REPORT-D2-BASELINE-KB.md` + `docs/D2-BASELINE.json` (thresholds d2Min 100/d3Min 300 — D3 gate A1 load đối chứng). **(4) Q2 đóng (31-e):** per-candidate budget — generate-then-abandon: ứng viên luôn SINH (H4 stream bất biến theo seed), vượt wall budget thì bỏ train/score → row + note `candidate_budget_exceeded` + `abandoned:true` trong metricsJson (cvScore Float non-null theo schema → 0 + note trung thực precedent score_error); đồng hồ inject `now?: () => number` (precedent rng). **(5) Q3 đóng (31-e):** `adaptiveCrossoverRate(pastWinners)` 0,2/0,4/0,6 theo ngưỡng 8/24 beatActive quá khứ — corpus rỗng giữ ĐÚNG chuỗi 80/20 R26. **(6) Observation cho EVO (31-e — HYPERNAS §9 sống lại):** `evo/observe.ts` phát `search.session` (start/end) + `search.candidate` (idx/archSummary/cvScore|abandoned/notes) fail-open theo cờ obs_ledger; `proposal.apply` CÒN MỞ (đường apply sống client-side brain-tab — Wired sau khi có caller server-side). **(7) Migration bù 5 bảng trôi (main):** `20261018120000_add_5_drifted_models` — DebtLedger/ObservationEvent/BrainInferenceTrace/BrainSearchRun/BrainSearchCandidate idempotent IF NOT EXISTS; verify: diff sau thêm = RỖNG · fresh-deploy 5/5 bảng + journal · P3005 trên DB-pushed là guard chuẩn Prisma (doctrine deploy = DB tươi, R21 precedent). Audit 31-b báo 11 model — hiệu đính 6/11 dùng @@map snake_case có sẵn trong 0_init (pending_edits/neo4j_checkpoint_diffs/self_direction_proposals/proposal_steps/opus_settings/self_direction_settings) — diff authority của prisma chỉ còn 5. **(8) DB-P3-c đóng nốt (31-f):** cron backup SQLite hằng ngày 03:00 VN (executor 'DB-BACKUP' trong tick ALISTA 60s — đã ĐĂNG KÝ + chạy thật backup 17MB lên R2 lúc verify) + ALISTA rule backup-freshness ≤2 ngày + `scripts/restore-drill.sh` (diễn tập KHÔNG đụng DB sống — PASS thật: integrity ok + 5/5 bảng row-count khớp) — r119. **(9) Pill trạng thái agent (31-g — AGENT-STATUS-DISPLAY-STANDARD doc đứng cũ nhất chưa triển khai):** 5 trạng thái ACTIVE/IDLE/BUSY/ERROR/OFFLINE cạnh tên agent ở header Smolab chat (`agent-status.ts` thuần mapToAgentStatus + `agent-status-pill.tsx` — màu theo doc, a11y aria-live, mobile short-label) — r120 19 test. **(10) .gitignore re-include 3 script có giá trị nghiệm thu** (d2-baseline-report/seed-daily-backup-cron/restore-drill — tiền lệ matryoshka từng mất qua clone). Gates R31: eslint 0 · tsc 0 · r105–r108 + r114–r121 = 133+62+94+12 pass vùng đổi · live-verify browser corpus grid 6 ô Brain-D + /api/brain corpusOverview số thật. **Còn mở (trung thực):** D3 (15/300) · D4 · HN-P3 predictor (32/40 rows) · editor v2 block-candidate (M–L) · proposal.apply observation · refresh fixtures A/B trên máy user (4/13 mẫu) · 8 shard D0 còn lại chờ user.
- **0.8 (2026-10-18, task R27):** UI/UX ĐIỂM CV + BRAIN-D BẤM ĐƯỢC + TRIỂN KHAI NGAY + BỎ ĐỐI CHỨNG ACTIVE (4 user report 1 tin nhắn). **(1) Typography điểm CV (user report "chữ to vãi đái, lệch kích thước so với xung quanh" — đo DOM xác nhận số liệu 14px giữa console 9–11px):** khối đề xuất metric grid số liệu `text-sm` 14px → `text-[11.5px] font-semibold` (nổi bật bằng trọng lượng + màu, không bằng cỡ chữ) · nhãn 9px uppercase → 9,5px tăng tương phản · bar CV h-1 4px → h-1.5 6px (đọc được trên nền tối) · cell p-1.5 → p-2 · dialog đồng bộ cùng chuẩn — VLM so sánh trước/sau xác nhận "hoà nhập hoàn hảo với hệ thống chữ console 9-11px". **(2) Brain-D bấm được (user report "Brain D không bấm vào xem điểm CV được" — nút D disabled cứng):** nút D trong hàng Não đích chuyển từ `disabled` + cursor-not-allowed sang ghost style (border-dashed) BẤM ĐƯỢC — bấm → chọn Brain-D (đồng bộ SECTION 1) → panel D hiển thị tiến độ thức tỉnh thật D2 (23/100) / D3 (15/300) + lý do chưa có điểm CV (chưa vào search space D4 §8.4); đồng thời ẨN form stepper/seed/nút chạy vô nghĩa với não ngoài search space (trước đây vẫn render disable). **(3) Triển khai luôn (user hỏi "HyperNAS tính ra số lớp + nơ-ron tối ưu thì có triển khai luôn không, có hiện trong Đài quan sát não không"):** nút mới ở 2 chỗ — (a) hộp "Cơ chế tính kích thước theo dữ liệu" form E2 (triển khai kiến trúc suggestArch tính sẵn) + (b) khối đề xuất E4 (triển khai ứng viên tốt nhất) — 1 nút chạy chuỗi saveDraft R27: ghi nháp → PUT spec-draft → TỰ ĐỘNG train force → ÁP DỤNG active ngay; saveDraft nhận `specOverride` mới (state draft vừa onDraftChange chưa flush — setState async — nên caller truyền thẳng bản đã validate). Sau train xong refreshNonce làm BrainStage refetch weights → **Đài quan sát não SECTION 2 hiển thị kiến trúc mới** (live-verify thật: deploy suggestion 9→8·tanh→3 cho Brain-B → đài hiện "8 tanh" · editor sync 8 · train nói thật "insufficient data: only 6/60 — ngủ an toàn" đúng fail-safe). **(4) Bỏ "đánh giá model đang sử dụng" (user chỉ thị "bỏ phần đánh giá model sử dụng đi vì chả cần thiết đâu" — hiểu là khối Đối chứng active: chấm lại bản active cùng fixture + badge THẮNG ACTIVE + cổng hasBeater):** metric grid 4 ô → 3 ô (Điểm CV/Tham số/p95 — bỏ ô Đối chứng active) · bảng ứng viên bỏ cột Trạng thái (THẮNG ACTIVE) — chặn H7 (an toàn LATENCY, không phải đối chứng model) vẫn hiện: màu rose + "· H7" tại p95 + khu vực Chặn H7 giữ nguyên · dialog bỏ ô "So với active" · Pareto `paretoFront` đổi语义 front TOÀN BỘ ứng viên (bỏ lọc beatActive) + màu điểm emerald=tốt nhất vòng / stone=ứng viên / rose=chặn H7 + legend bỏ cặp thua/thắng active · `cvBarTone` 2 tầng (bỏ amber beatActive) · bỏ cổng hasBeater của "Vào nháp/Triển khai luôn" (đủ: không H7 + thuần MLP + ≤250K). **Server GIỮ NGUYÊN beatActive** trong response + DB (audit) — chỉ UI không hiển thị. **(5) Câu "kết hợp các bộ não thành 1" — KHÔNG triển khai, trả lời trung thực:** 4 não có không gian đầu vào khác nhau (features-10 / 1-hot cfg / task-features / kb-features ~2078 chiều) + hợp đồng đầu ra khác nhau (sigmoid / 3 head hồi quy / softmax |A| / 3 cụm 14 unit) + nguồn dữ liệu + ngưỡng thức tỉnh riêng (A 30 EvalResult · B 60 AgentRun · C 30 Q+50 Verdict · D 100+300 KbLog) — gộp 1 MLP đồng nghĩa nối thẳng input thưa ~2100 chiều vào mọi tác vụ, cột sống sống chung ép 1 não thiếu dữ liệu kéo cả cụm (vi phạm thiết kế ngủ an toàn §2); điều ĐANG đúng hướng "1 bộ não" là Brain-D (1 trunk chung 2 lớp + 3 cụm đầu ra MỘT quyết định một forward — §8.3). r115 hiệu đính 2 test (J: paretoFront toàn ứng viên · V: cvBarTone 2 tầng). Gates: eslint 0 · tsc 0 · r115 22/22 + r116 15/15 + r108 10/10 pass (full-suite 37 fail có sẵn từ trước — DB-contention flaky, verify stash-trước/sau giống hệt) · live-verify browser desktop + mobile 390px + 0 console error.
- **0.7 (2026-10-18, task R26):** SMART SEARCH + HIỆU ĐINH TRẠNG THÁI + UI/UX THEO 3 USER REPORT. **(1) Kiểm tra EVO-P0..P4 (user hỏi "triển khai hết chưa"):** ĐÃ ĐỦ — r105-r108 + r115 = 82 test pass (P0 benchmark + P1 encoding 144 + P2 blocks + P3 MoE + P4 runner/routes/cờ + UI tab Tiến hoá); P5 GPU sidecar tiếp tục hoãn theo Q6 (chỉ khởi động khi CPU thực tế không kịp). Hiệu đính §0.1: trạng thái cũ "MẤT → viết lại" sau R24-c lỗi thời → "HOÀN TẤT". **(2) Cơ chế tính số lớp/số nơ-ron (user hỏi "NAS có cơ chế tính toán hiệu quả hơn chưa" — trước R26 CHƯA, vòng evolve thiên ngẫu nhiên):** triển khai §4.6 EVO-P4.1 SMART SEARCH — `evo/smart-search.ts`: suggestArch (L theo độ giàu mẫu <100→1 · <1000→2 · else 3; kim tự tháp hình học w_j = in·(out/in)^((j+1)/(L+1)); dataScale √(n/(in+out)) kẹp [0,5..2]; trần 50 tham số/mẫu với LẶP co √(cap/P) ≤8 vòng — bug thật bắt được khi test: 1 lần √ không đủ vì P ~ w·(in+out) khi 1 lớp) làm hạt giống ứng viên #0 + tournament k=3 thay uniform + adaptive rate 0,15→0,06; GET evolve thêm `suggestion` additive (r116 15 test; r115 +5 test padDomain/cvBarTone). H4 trung thực: cùng seed vẫn bit-đối-bít trong cùng phiên bản — chuỗi R26 khác R24-c. **(3) UI tab Tiến hoá (user report: "chọn não xong không có nút lùi" + "UI/UX điểm CV xấu" + thông báo D4):** (a) hàng "Não đích" 4 nút A·V3/B·Vọng/C·Lệnh/D·Tri Thức NGAY trong tab (D disabled + tooltip D4 §8.4; đồng bộ selectBrain SECTION 1 — single-source giữ nguyên) — không phải cuộn lên SECTION 1 nữa; (b) thông báo Brain-D thay 1 dòng chữ khô bằng chuỗi phụ thuộc EVO ✅ → D2 → D3 → D4 + 2 thanh tiến độ THẬT từ signals /api/brain (kbLogsTotal/100 · kbLogsWithOutcome/300 — prop mới signals từ brain-tab); (c) điểm CV toàn diện: bảng dùng bar trực quan (emerald=best vòng · amber=thắng active · stone) + CI đầy đủ [lo..hi] thay "± nửa khoảng" gây hiểu lầm + tooltip giải thích thang 0..1 cao hơn tốt hơn; khối đề xuất metric grid 4 ô (CV+bar/Tham số/p95/Đối chứng) thay 1 dòng mono dài; Pareto: gridlines 5 vạch kèm nhãn giá trị + miền Y padDomain (đệm 18%, sàn span 0,08 chống "mọi điểm nhìn như nhau", kẹp [0..1]) + nhãn #idx trên điểm front (≤8) + legend sửa "thắng CV"→"thắng active" (màu amber gắn beatActive — nhãn cũ sai ngữ nghĩa); dialog CV có bar; mobile Pareto thêm CI. Gates: eslint 0 · tsc 0 · 259 test pass (86 EVO files + 173 pins r93/r100/r110/r114) · live-verify browser.
- **0.6.1 (2026-10-18, task R25):** TRIỂN KHAI §5 UI + 2 fix ngoài blueprint theo user report. **(1) Tab "Tiến hoá" SỐNG (R25-c):** evolve-tab.tsx + ui-helpers.ts + r115 (18 test) + r93 pin 4→5 tab (nút hiện theo cờ brain_evolve — default off đúng kill-switch design; user bật qua U5 switch hoặc Tham số runtime) — live-verify app thật: E2 form (stepper 4-24 bước 4 + seed tự sinh/đè + ngân sách) → E3 (tiến độ kép + Dừng) → E4 (8 ứng viên thật 154s seed tự sinh hash(runId) — bảng + Pareto SVG + dialog chi tiết + encoding viewer 5 vùng + ghi chú editor v2 cho block candidate). **(2) R25-a (user report "không thấy layers/editor khi chọn não"):** root cause = cờ ui_brain_edit default off sau nhiều lần DB reset (KHÔNG phải HyperNAS tự tuỳ chỉnh — evolve chỉ ĐỀ XUẤT theo H2) → default 'on' (pin r92 update) + chế độ CHỈ XEM vẫn hiển thị đầy đủ chuỗi lớp planned (trước đây chỉ 1 dòng chữ). **(3) R25-b (user report "báo lỗi liên tục, NIM đổi model"):** probe trực tiếp catalog NIM — kimi-k3 EOL 410 (2026-10-15), GLM 5.3/5.3-flash ĐĂNG KÝ LẠI (id z-ai/*), nemotron-550b 503 quá tải liên tục, DS v4.1 sống nhưng reasoning chậm ~135s. Fix llm.ts: NVIDIA_AGENT_MODELS mới (glm-5.3-flash chính + ds-v4.1-flash + glm-5.3 + nemotron-550b) + extraction core MẶC ĐỊNH glm-5.3-flash (khôi phục nemotron bằng env EXTRACTION_MODEL — ghi chú callLLMSlot) + **BUG CODE thật: reasoning models trả content=null + reasoning_content khi hết max_tokens → code cũ xếp 'empty_response' → trip breaker oan "model HANG" → sửa: status 'length_exceeded' + retry cùng model 1 lần max_tokens ×2 (cap 32768)** + slow-model timeout 600s khái quát hoá (isSlowNimModel: glm-5.3 + ds-v4.1; env NIM_SLOW_MODEL_TIMEOUT_MS, tương thích KIMI_K3_TIMEOUT_MS cũ) + EOL_NIM_MODELS (kimi-k3 → lỗi rõ ràng kèm hướng dẫn) + 14 AgentProfile migrate nemotron→glm-5.3-flash + dropdowns UI (smolab/code-tab/agent-constants/token-usage/agents badge) + verify E2E thật: 7+ call thành công 34-41K tokens kèm native tool_calls, 1 timeout transient tự hồi phục. Lưu ý vận hành: .env sandbox LLM_TIMEOUT_MS 150s→240s (điểm nghẽn 37K-token call).
- **0.6 (2026-10-17, task R24):** TRIỂN KHAI 3 MỐC THEO §7. **(1) D0 (R24-a):** hỗ trợ .txt additive trong pipeline ingestion (upload+process, đường .pdf nguyên vẹn) + đo 9 shard (2.239.171 B / 35.797 dòng / 3.343 block / 868 chunk ml 640/96 — entity-rate mẫu 6/9 shard vì NIM sóng 503) + trial THẬT SHD_NAS_EVOLUTION_002 (58 chunk → 820 LocalEntity/683 LocalRelationship → +408 node/+1.161 rel; 405 node mới/117 merge 22,4%; 117 phút gồm ~25 lượt reExtract vì NIM bệnh) → khuyến nghị: ingest nốt 8 shard trên Aura AN TOÀN quota (~101.600 node ≈ 50,8% / rel ~55,6% sau 9 shard) — [report](./D0-KHOI-LUONG-9-SHARD-NEO4J.md). **(2) §8.5 mốc (a) ghost UI (R24-b):** não thứ 4 'Tri Thức' trong BRAIN_REGISTRY + geometry headGroup additive (r90 pins không đổi) + 2 cờ #33/#34 (nodeId softmax-policy... kb-access cho 2 cờ D — hiệu đính: 2 cờ kill-switch D gắn node kb-access) + signals kbLogsTotal/kbLogsWithOutcome + topology 3 cụm amber/cyan/fuchsia (desktop cạnh nhau, <md xếp dọc) + chip "DỰ KIẾN — CHƯA HỌC" + λ Brain-C precedent — browser-verify đủ (r114 20 test). Bảo vệ encoding 96: BRAIN_KEY_ORDER chuyển nguồn BRAIN_REGISTRY → BRAIN_TRAINABLE_KEYS (registry 4 não mà slot [93..95] chỉ 3 — tránh out-of-bounds vỡ r100). **(3) EVO-P0..P4 (R24-c):** benchmark.ts (fixtures TỪ DỮ LIỆU THẬT backup R2 10-11/10-15 qua feature builder thật từng não — A: EvalResult n=4 + EvalCase; B: AgentRunRecord usable n=13 (84 row, 53 không ghi model); C: imitation 31 run 7 model; kèm dataFingerprint — Q1 thỏa "không fake") + search-space mở rộng 144 (pad96 F4 · repair one-hot F8 · sampler 50% identity · mutate Box-Muller · crossover; canonical = sau lượng tử hoá — vòng 2 ổn định) + blocks.ts/dense.ts/block-types.ts (attention causal + selective SSM + gated + FFN-mlp; NUMERICAL GRADIENT CHECK từng loại <1e-3 — r106) + moe.ts (E=k+1, aux 0.01 load-balance, Q4 moeSkipped <2K) + evolve.ts (seed hash(runId) F7 · 80/20 mutation/crossover Q3 · H3 wall 10' · heartbeat + stale-sweep 60s · beatActive so active re-score cùng fixture · H7 p95 > 2× MLP-chuỗi) + routes GET/POST + cancel (reason pin F6 + 'invalid_seed' additive — từ chối rõ hơn kẹp im lặng) + cờ #35 brain_evolve (OFF) + #36 brain_search_global (kill toàn cục, F10 đặt tên sớm). **Bug thật bắt được khi live-verify:** MlpBlock 1 lớp d→e·d ĐỔI chiều token (vỡ flatten gradSeq — sửa thành FFN 2 lớp d→e·d→d) + cache EvoDense của MoE expert/router bị ghi đè giữa các token (backward dùng sai input — sửa replay forward theo token). Gates: tsc 0 · eslint 0 · check:imports PASS · 548 test pass (r105-r108 mới 49 + pins cập nhật 34→36) · live-verify app thật: policy 8 ứng viên 47s + surrogate 4 ứng viên [attn1h·128]→[mlp·×3] cv 0,43-0,48.

- **0.5 (2026-10-17, task R23):** REVIEW KIẾN TRÚC TOÀN DIỆN (đối chiếu code từng claim) + BỔ SUNG §8.5 THEO YÊU CẦU USER. **Sửa 9 lỗi (F1–F9):** (F1) §0.1 EVO-P0 "Chưa triển khai" tự mâu thuẫn với P1..P4 "đã từng làm — mất" (P4 cần benchmark) + r105 trùng P0/P1 → ghi trung thực "chức năng từng có, artifact riêng chưa chắc"; (F2) §5.1-4 baseline tab bar 7 nút liệt kê tên tab THIẾT KẾ HYPERNAS chưa từng triển khai (SECTION 3 thực tế 4 tab sau Task 26; HN-P2/P3 UI mất theo reset — `/api/brain/search` không còn) → sửa baseline trung thực + lộ trình 4→5→7 nút; (F3) E1 không phân biệt được với "mất kết nối" (cùng biểu hiện GET lỗi) → thêm quy tắc 404=E1; (F4) U3 thiếu compat encoding 96-dim legacy (BrainSearchCandidate.encodingJson HN-P1) + crossover cha 96×144 cần quy tắc pad-0 → thêm cả hai; (F5) "prune H5" gây hiểu nhầm xóa DB (H5 là additive không xóa) → làm rõ chỉ hiển thị ≤60 hàng/vòng, DB giữ toàn bộ; (F6) POST /api/brain/evolve 400 reason chưa pin → pin 4 giá trị 'flag_off'|'already_running'|'invalid_brain'|'invalid_candidates'; (F7) "seed tự sinh tất định" mâu thuẫn từ ngữ → hash(runId); (F8) thiếu repair one-hot cho mutation/crossover encoding 144 (ràng buộc 1 hot/block) → thêm §4.5; (F9) nút "Áp dụng đề xuất" thiếu gate editor v2 khi best là block → thêm điều kiện. **Bổ sung §8.5 UI topology diagram Brain-D trong tab BRAIN** (yêu cầu user — tab BRAIN chưa thấy topology Brain-D): ghost topology hiển thị NGAY từ D1 (não thứ 4 trong BRAIN_REGISTRY + topology 3 cụm đầu ra ĐỒNG THỜI — khác tab-head precedent Brain-B vì 3 tầng là MỘT quyết định + tiến độ thức tỉnh kép ≥100/≥300 + 2 cờ kill-switch + mixture λ Brain-C precedent), activity UI kèm D3; mở rộng stage-geometry additive (headGroup), không route mới (GET /api/brain thêm 2 signals). Verify kèm: organ-1/2/3 · POLICY_SEED · BRAIN_MAX_PARAMS · holdout 15% · 9 activations · 8 ENTITY_LABELS · KbConsultLog 16 cột · 3 collection Qdrant (theopus_chunks/theopus_communities/agent_memory_512) · draft/dirty state — đều khớp code.

- **0.4.1 (2026-10-17, task R22):** HIỆU ĐINH NHỎ SAU REVIEW. Cấu hình lại phòng (R2 + Neo4j Aura + NIM 4 keys — verify thật: R2 list 15 objects, Neo4j ping 96.354 node/205.809 rel/23 label, NIM 4/4 HTTP 200, r110 21/21 pass) + review v0.4 đối chiếu code: mọi claim trạng thái đều khớp (migration/mô hình/cờ #32/denseThreshold+sourcesEnabled/fallback+graph corpus/EVO folder vắng đúng như khai báo "MẤT → viết lại"). Sửa duy nhất số liệu §9/Q5: đồ thị AuraDB 96.354 node (đo R22) thay vì chỉ ghi ~53.742 node máy user; Q5 bổ sung trạng thái quota ~48%. Không thay đổi thiết kế.
- **0.4 (2026-10-17, task R21):** HIỆU ĐINH SAU FB-BRAIN-D1. (1) **§5 UI EVO-U1..U5 dựng lại ĐẦY ĐỦ** theo convention precedent HYPERNAS §10 (7 nguyên tắc · state machine 5 trạng thái E1–E5 · bảng + 2 cấp nút · encoding viewer 144 · Pareto + khu vực chặn H7 · kill-switch panel · API contract pin · copy chốt) — đánh dấu rõ "tái tạo, chốt cuối khi tới EVO-P4"; (2) **§10 Q1–Q6 tái tạo** từ tri thức phiên kèm đề xuất mặc định + ghi nguồn trung thực (cần user chốt khi tới phase); (3) §0.2 D1 → HOÀN TẤT (R20 4394507 + FB-BRAIN-D1 R21); (4) §8.1 cập nhật corpus sau 8 fix BUG2-269..276 (migration bù + byte-cap + denseThreshold/sourcesEnabled + fallback/graph wrapper + ALS undefined + empty-query + doc trung thực tokensUsed); (5) §1 bổ sung dòng R21.
- **0.3 (2026-10-17, task R20):** TÁI TẠO SAU RESET. Từ v0.2 mất: giữ toàn bộ thiết kế đã chốt + 2 quyết định duyệt trước reset (Q7=(b), Q9=D0); cập nhật cột trạng thái trung thực (EVO-P1..P4 "đã từng làm — mất → viết lại"); nâng "commit + dual-push mỗi mốc" lên doctrine; bổ sung §1 định tính mất mát qua GitHub PAT; đánh dấu §5 UI + Q1–Q6 là phần chi tiết mất (phác tái tạo, chốt lại khi tới phase). Kế thừa kết quả review v0.2 (vai kỹ sư AI/kiến trúc sư): encoding additive bijective mỗi vùng · bảng phụ thuộc D0 · kill-switch naming chuẩn 2 cờ D3.
- **0.2 (2026-10-16 — MẤT theo reset):** bản 386 dòng sau review: bổ sung §8 BRAIN-D 4 phase, §9 bảng KB 4 lớp với Neo4j là LÕI (đính chính user), §10 Q1–Q9, rào H7/H8.
- **0.1 (2026-10-16 — MẤT):** bản đầu từ chuỗi Q&A kiến trúc não (3 câu kiến trúc + 4 câu vai trò) — phases EVO-P0..P5, encoding 96→144, block engine, UI EVO-U1..U5.
