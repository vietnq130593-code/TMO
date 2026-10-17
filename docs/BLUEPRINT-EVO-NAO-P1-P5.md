# BLUEPRINT TRIỂN KHAI EVO-NAO P1 → P5 + BRAIN-D "TRI THỨC" CHO TMO

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
| **EVO-P0** | Nền & đối chứng | Benchmark tất định + fixtures tái lập để mọi ứng viên so với Brain-C active (MLP chuỗi) trên cùng dữ liệu | `src/lib/brain/evo/benchmark.ts` + fixtures | — (thuần lib) | r105 * | **ĐÃ TỪNG làm (chức năng) — MẤT → viết lại** |
| **EVO-P1** | Encoding additive 144 | Mở search space 96→144: thêm slot block kiến trúc (layer-type/ tham số/ MoE) — **additive, không phá HN-P1** | `search-space.ts` (mở rộng) | — (thuần lib) | r105 | **ĐÃ TỪNG làm — MẤT theo reset → viết lại** |
| **EVO-P2** | Block engine thuần TS | Block chạy được trên CPU: attention 1-head causal + selective SSM (N=8–16), seq ≤512 | `src/lib/brain/evo/blocks.ts` | — (thuần lib) | r106 | **ĐÃ TỪNG làm — MẤT → viết lại** |
| **EVO-P3** | Micro-MoE | MoE nhẹ k=2–4 experts + aux loss 0.01 (chỉ khi ≥2K mẫu) | `src/lib/brain/evo/moe.ts` | — (thuần lib) | r107 | **ĐÃ TỪNG làm — MẤT → viết lại** |
| **EVO-P4** | Evolve runner | Vòng tiến hoá: sinh ứng viên từ encoding → train → chấm benchmark → ghi BrainSearchCandidate | `src/lib/brain/evolve.ts` + `POST /api/brain/evolve` | `brain_evolve` (OFF) | r108 | **ĐÃ TỪNG làm — MẤT → viết lại** |
| **EVO-P5** | GPU sidecar | Tùy chọn: mini-service GPU khi CPU không kịp (chỉ benchmark ngoài runtime) | `mini-services/evo-gpu/` | — | r109 | Chưa triển khai (Q6 — cân nhắc hoãn) |

\* **Hiệu đính 0.5 (F1):** trạng thái "Chưa triển khai" cũ của P0 tự mâu thuẫn với P1..P4 "ĐÃ TỪNG làm — MẤT" (P4 chấm ứng viên trên benchmark → chức năng benchmark phải từng tồn tại); nhưng §1 không liệt kê `benchmark.ts` trong sổ mất → P0 từng sống DẠNG CHỨC NĂNG (nhúng trong evolve.ts mất), chưa chắc có artifact riêng. Khi viết lại: tách artifact chuẩn `benchmark.ts`; r105 = test chung P0+P1 (benchmark + encoding 1 file) — đặt lại số nếu tách file.

### 0.2 Chuỗi phase BRAIN-D "Tri Thức" (não thứ 4 — dùng KB để LÀM, không chỉ trả lời)

| Phase | Tên | Mục tiêu một câu | Artifacts | Cờ (mặc định) | Test | Trạng thái |
|---|---|---|---|---|---|---|
| **D0** | Ánh xạ knowledge/ → Neo4j | Đưa 9 shard tài liệu gốc (2.2MB) vào đồ thị lõi bằng ingestion sẵn có (entity-resolver + LLM extraction) — additive, merge không đè | đo khối lượng + chạy ingestion theo đợt shard | — | — | **ĐO + TRIAL 002 HOÀN TẤT (R24-a)** — 868 chunk/9 shard · trial thật +408 node/+1.161 rel (22,4% merge) · quota an toàn (~51% sau 9 shard) — 8 shard còn lại chờ user quyết theo [report D0](./D0-KHOI-LUONG-9-SHARD-NEO4J.md) |
| **D1** | LOG-ONLY | Bảng `KbConsultLog` ghi MỌI lượt KB consult: ai hỏi, cấu hình truy xuất, nguồn nào trả, kết quả top, tốn bao nhiêu, chạy run nào → nối Outcome* | prisma model + instrumentation `kb-access.ts` + `consult-log.ts`/`consult-context.ts` + fallback/graph wrapper | `kb_consult_log` (ON) | r110 | **HOÀN TẤT R20 (4394507) + rà soát FB-BRAIN-D1 R21 (BUG2-269..276 fix + migration bù + corpus mở fallback/graph)** |
| **D2** | Baseline đối chứng | Report: heuristic CỨNG hiện tại đạt mức nào trên log thật (≥100 log) — trả lời "não có hơn heuristic không?" bằng dữ liệu | script report + docs | — | r111 | Chưa triển khai |
| **D3** | Policy head 3 tầng | `brain/brains/knowledge.ts` — hành động gồm **chế độ vận dụng** (Q7=(b)) + tham số truy xuất + meta | brain D + kill-switch 2 cờ + **UI topology §8.5 (phần activity)** | `runtime_knowledge` (OFF) + `knowledge_organ_strategy` | r112 | Chưa triển khai (cần D2 + ≥300 log có Outcome*; **UI ghost topology §8.5 mốc (a) ĐÃ SỐNG R24-b — r114**; mốc (b) activity kèm D3) |
| **D4** | Vào NAS/EVO space | Kiến trúc knowledge head do evolve.ts tìm (không hand-tune) | mở encoding §4 | — | r113 | Chưa triển khai (cần EVO-P1..P4 + D3 sống) |

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

### 4.6 EVO-P5 — GPU sidecar (chưa triển khai)

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

`brain/brains/knowledge.ts` — đầu vào là (taskType, intent, embedding câu lệnh, trạng thái KB, lịch sử consult gần đây); đầu ra hành động 3 tầng:

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
└───────────────────┘        ┌──────────┐        └─
                             │ 16 tanh  │
                             └──────────┘
```

- **Spec khởi điểm (ghost):** input ≈ 2048 + ~30 chiều cfg (taskType hash-bucket · intent 1-hot 4 · trạng thái KB · lịch sử consult — chốt đếm chính thức khi D3) → trunk 2 lớp ẩn 32/16 tanh (tiền lệ Brain-C 32 tanh) → 3 cụm đầu ra. Tổng tham số khởi điểm ~67K — trong trần 250K (`BRAIN_MAX_PARAMS`), chừa dư địa cho D4 evolve nở kiến trúc.
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
| **Q2** | **Ngân sách H3 (≤24 ứng viên/10 phút) giữ nguyên cho EVO?** Block engine đắt hơn MLP thuần (attention O(L²), SSM scan tuần tự) — 24 ứng viên block có thể không vừa 10 phút trên CPU box 4GB | EVO-P1/P4 | Giữ 24/10' nhưng đo thêm per-candidate budget (đặt H3 theo **số ứng viên × thời gian**, chặn sớm ứng viên quá đắt — đo p95 từ P2 benchmark) |
| **Q3** | **Crossover giữ hay chỉ mutation?** Crossover 2 cha trong encoding 144 vẫn tất định (seed chọn cha) nhưng sinh không gian khám phá ít đa dạng hơn ở vùng block mới (chưa có lịch sử tốt để lai) | EVO-P4 | Vòng đầu: 80% mutation / 20% crossover; adaptive theo tỷ lệ thắng (crossover tăng khi corpus ứng viên thắng đủ dày) |
| **Q4** | **MoE dưới ngưỡng 2K mẫu: tắt hẳn khỏi search space hay để động?** Tắt hẳn = encoding mọi ứng viên decode về không-MoE (đỡ tính toán, mất khả năng khám phá sớm); động = decode valid nhưng skip khi train (giữ "dấu vết" khám phá trong corpus) | EVO-P3 | Động (slot vẫn sampled + ghi vào candidate kèm cờ `moeSkipped`) — corpus D2/D4 sau này thấy được "hệ thống đã từng thử gì" |
| **Q5** | **D0 chạy trên hạ tầng Neo4j nào?** Máy user có Neo4j Desktop local (đồ thị ~53.742 node đang sống, 2026-10-16); sandbox AuraDB cloud **đã nối lại thành công R22** (96.354 node / 205.809 quan hệ — đo 2026-10-17; free-tier Aura ~200K node → đã dùng ~48% quota, D0 ingestion thêm node cần cân nhắc quota) | D0 | Ingestion chạy trên máy USER (script + hướng dẫn kèm commit — precedent warm-start); sandbox đo khối lượng shard THẬT (đếm entity mẫu — nay khả thi vì Aura đã sống) + chạy ingestion THỬ trên 1 shard nhỏ để ước node tăng trước khi quyết |
| **Q6** | **EVO-P5 GPU sidecar có đáng làm?** Box hiện 4GB/2 core CPU; user chưa xác nhận có GPU; benchmark EVO-P0..P4 thiết kế CPU-first — sidecar chỉ có giá trị khi search space mở rộng vượt CPU | EVO-P5 | **Hoãn vô hạn định (mở)** — chỉ khởi động khi EVO-P4 thực tế chứng minh CPU không kịp (đo wall-time thật ≥ 2× ngân sách) — tránh xây hạ tầng không ai dùng |
| **Q7** | D3 có kèm chế độ vận dụng hay chỉ tinh chỉnh tham số truy xuất? | **CHỐT = (b)** kèm cả 3 chế độ vận dụng (context-block/structured-subgraph/traversal-plan) — 2026-10-16 | — |
| **Q8** | Tín hiệu Outcome* cho D3 dùng gì: Outcome* run (thành công/tokens/thời gian) hay citation-counting (kết quả KB có được dùng trong câu trả lời)? | D3 | Mở — **đề xuất mức 1** (Outcome* trực tiếp, đơn giản đo được từ D1 runId) trước khi cân nhắc mức 2 |
| **Q9** | Có thêm D0 ánh xạ 9 shard `knowledge/` vào Neo4j không? | **CHỐT = CÓ** — D0 vào §8/§9, đo khối lượng trước, tách đợt được — 2026-10-16 | — |

---

## 11. NHẬT KÝ HIỆU ĐINH

- **0.6.1 (2026-10-18, task R25):** TRIỂN KHAI §5 UI + 2 fix ngoài blueprint theo user report. **(1) Tab "Tiến hoá" SỐNG (R25-c):** evolve-tab.tsx + ui-helpers.ts + r115 (18 test) + r93 pin 4→5 tab (nút hiện theo cờ brain_evolve — default off đúng kill-switch design; user bật qua U5 switch hoặc Tham số runtime) — live-verify app thật: E2 form (stepper 4-24 bước 4 + seed tự sinh/đè + ngân sách) → E3 (tiến độ kép + Dừng) → E4 (8 ứng viên thật 154s seed tự sinh hash(runId) — bảng + Pareto SVG + dialog chi tiết + encoding viewer 5 vùng + ghi chú editor v2 cho block candidate). **(2) R25-a (user report "không thấy layers/editor khi chọn não"):** root cause = cờ ui_brain_edit default off sau nhiều lần DB reset (KHÔNG phải HyperNAS tự tuỳ chỉnh — evolve chỉ ĐỀ XUẤT theo H2) → default 'on' (pin r92 update) + chế độ CHỈ XEM vẫn hiển thị đầy đủ chuỗi lớp planned (trước đây chỉ 1 dòng chữ). **(3) R25-b (user report "báo lỗi liên tục, NIM đổi model"):** probe trực tiếp catalog NIM — kimi-k3 EOL 410 (2026-10-15), GLM 5.3/5.3-flash ĐĂNG KÝ LẠI (id z-ai/*), nemotron-550b 503 quá tải liên tục, DS v4.1 sống nhưng reasoning chậm ~135s. Fix llm.ts: NVIDIA_AGENT_MODELS mới (glm-5.3-flash chính + ds-v4.1-flash + glm-5.3 + nemotron-550b) + extraction core MẶC ĐỊNH glm-5.3-flash (khôi phục nemotron bằng env EXTRACTION_MODEL — ghi chú callLLMSlot) + **BUG CODE thật: reasoning models trả content=null + reasoning_content khi hết max_tokens → code cũ xếp 'empty_response' → trip breaker oan "model HANG" → sửa: status 'length_exceeded' + retry cùng model 1 lần max_tokens ×2 (cap 32768)** + slow-model timeout 600s khái quát hoá (isSlowNimModel: glm-5.3 + ds-v4.1; env NIM_SLOW_MODEL_TIMEOUT_MS, tương thích KIMI_K3_TIMEOUT_MS cũ) + EOL_NIM_MODELS (kimi-k3 → lỗi rõ ràng kèm hướng dẫn) + 14 AgentProfile migrate nemotron→glm-5.3-flash + dropdowns UI (smolab/code-tab/agent-constants/token-usage/agents badge) + verify E2E thật: 7+ call thành công 34-41K tokens kèm native tool_calls, 1 timeout transient tự hồi phục. Lưu ý vận hành: .env sandbox LLM_TIMEOUT_MS 150s→240s (điểm nghẽn 37K-token call).
- **0.6 (2026-10-17, task R24):** TRIỂN KHAI 3 MỐC THEO §7. **(1) D0 (R24-a):** hỗ trợ .txt additive trong pipeline ingestion (upload+process, đường .pdf nguyên vẹn) + đo 9 shard (2.239.171 B / 35.797 dòng / 3.343 block / 868 chunk ml 640/96 — entity-rate mẫu 6/9 shard vì NIM sóng 503) + trial THẬT SHD_NAS_EVOLUTION_002 (58 chunk → 820 LocalEntity/683 LocalRelationship → +408 node/+1.161 rel; 405 node mới/117 merge 22,4%; 117 phút gồm ~25 lượt reExtract vì NIM bệnh) → khuyến nghị: ingest nốt 8 shard trên Aura AN TOÀN quota (~101.600 node ≈ 50,8% / rel ~55,6% sau 9 shard) — [report](./D0-KHOI-LUONG-9-SHARD-NEO4J.md). **(2) §8.5 mốc (a) ghost UI (R24-b):** não thứ 4 'Tri Thức' trong BRAIN_REGISTRY + geometry headGroup additive (r90 pins không đổi) + 2 cờ #33/#34 (nodeId softmax-policy... kb-access cho 2 cờ D — hiệu đính: 2 cờ kill-switch D gắn node kb-access) + signals kbLogsTotal/kbLogsWithOutcome + topology 3 cụm amber/cyan/fuchsia (desktop cạnh nhau, <md xếp dọc) + chip "DỰ KIẾN — CHƯA HỌC" + λ Brain-C precedent — browser-verify đủ (r114 20 test). Bảo vệ encoding 96: BRAIN_KEY_ORDER chuyển nguồn BRAIN_REGISTRY → BRAIN_TRAINABLE_KEYS (registry 4 não mà slot [93..95] chỉ 3 — tránh out-of-bounds vỡ r100). **(3) EVO-P0..P4 (R24-c):** benchmark.ts (fixtures TỪ DỮ LIỆU THẬT backup R2 10-11/10-15 qua feature builder thật từng não — A: EvalResult n=4 + EvalCase; B: AgentRunRecord usable n=13 (84 row, 53 không ghi model); C: imitation 31 run 7 model; kèm dataFingerprint — Q1 thỏa "không fake") + search-space mở rộng 144 (pad96 F4 · repair one-hot F8 · sampler 50% identity · mutate Box-Muller · crossover; canonical = sau lượng tử hoá — vòng 2 ổn định) + blocks.ts/dense.ts/block-types.ts (attention causal + selective SSM + gated + FFN-mlp; NUMERICAL GRADIENT CHECK từng loại <1e-3 — r106) + moe.ts (E=k+1, aux 0.01 load-balance, Q4 moeSkipped <2K) + evolve.ts (seed hash(runId) F7 · 80/20 mutation/crossover Q3 · H3 wall 10' · heartbeat + stale-sweep 60s · beatActive so active re-score cùng fixture · H7 p95 > 2× MLP-chuỗi) + routes GET/POST + cancel (reason pin F6 + 'invalid_seed' additive — từ chối rõ hơn kẹp im lặng) + cờ #35 brain_evolve (OFF) + #36 brain_search_global (kill toàn cục, F10 đặt tên sớm). **Bug thật bắt được khi live-verify:** MlpBlock 1 lớp d→e·d ĐỔI chiều token (vỡ flatten gradSeq — sửa thành FFN 2 lớp d→e·d→d) + cache EvoDense của MoE expert/router bị ghi đè giữa các token (backward dùng sai input — sửa replay forward theo token). Gates: tsc 0 · eslint 0 · check:imports PASS · 548 test pass (r105-r108 mới 49 + pins cập nhật 34→36) · live-verify app thật: policy 8 ứng viên 47s + surrogate 4 ứng viên [attn1h·128]→[mlp·×3] cv 0,43-0,48.

- **0.5 (2026-10-17, task R23):** REVIEW KIẾN TRÚC TOÀN DIỆN (đối chiếu code từng claim) + BỔ SUNG §8.5 THEO YÊU CẦU USER. **Sửa 9 lỗi (F1–F9):** (F1) §0.1 EVO-P0 "Chưa triển khai" tự mâu thuẫn với P1..P4 "đã từng làm — mất" (P4 cần benchmark) + r105 trùng P0/P1 → ghi trung thực "chức năng từng có, artifact riêng chưa chắc"; (F2) §5.1-4 baseline tab bar 7 nút liệt kê tên tab THIẾT KẾ HYPERNAS chưa từng triển khai (SECTION 3 thực tế 4 tab sau Task 26; HN-P2/P3 UI mất theo reset — `/api/brain/search` không còn) → sửa baseline trung thực + lộ trình 4→5→7 nút; (F3) E1 không phân biệt được với "mất kết nối" (cùng biểu hiện GET lỗi) → thêm quy tắc 404=E1; (F4) U3 thiếu compat encoding 96-dim legacy (BrainSearchCandidate.encodingJson HN-P1) + crossover cha 96×144 cần quy tắc pad-0 → thêm cả hai; (F5) "prune H5" gây hiểu nhầm xóa DB (H5 là additive không xóa) → làm rõ chỉ hiển thị ≤60 hàng/vòng, DB giữ toàn bộ; (F6) POST /api/brain/evolve 400 reason chưa pin → pin 4 giá trị 'flag_off'|'already_running'|'invalid_brain'|'invalid_candidates'; (F7) "seed tự sinh tất định" mâu thuẫn từ ngữ → hash(runId); (F8) thiếu repair one-hot cho mutation/crossover encoding 144 (ràng buộc 1 hot/block) → thêm §4.5; (F9) nút "Áp dụng đề xuất" thiếu gate editor v2 khi best là block → thêm điều kiện. **Bổ sung §8.5 UI topology diagram Brain-D trong tab BRAIN** (yêu cầu user — tab BRAIN chưa thấy topology Brain-D): ghost topology hiển thị NGAY từ D1 (não thứ 4 trong BRAIN_REGISTRY + topology 3 cụm đầu ra ĐỒNG THỜI — khác tab-head precedent Brain-B vì 3 tầng là MỘT quyết định + tiến độ thức tỉnh kép ≥100/≥300 + 2 cờ kill-switch + mixture λ Brain-C precedent), activity UI kèm D3; mở rộng stage-geometry additive (headGroup), không route mới (GET /api/brain thêm 2 signals). Verify kèm: organ-1/2/3 · POLICY_SEED · BRAIN_MAX_PARAMS · holdout 15% · 9 activations · 8 ENTITY_LABELS · KbConsultLog 16 cột · 3 collection Qdrant (theopus_chunks/theopus_communities/agent_memory_512) · draft/dirty state — đều khớp code.

- **0.4.1 (2026-10-17, task R22):** HIỆU ĐINH NHỎ SAU REVIEW. Cấu hình lại phòng (R2 + Neo4j Aura + NIM 4 keys — verify thật: R2 list 15 objects, Neo4j ping 96.354 node/205.809 rel/23 label, NIM 4/4 HTTP 200, r110 21/21 pass) + review v0.4 đối chiếu code: mọi claim trạng thái đều khớp (migration/mô hình/cờ #32/denseThreshold+sourcesEnabled/fallback+graph corpus/EVO folder vắng đúng như khai báo "MẤT → viết lại"). Sửa duy nhất số liệu §9/Q5: đồ thị AuraDB 96.354 node (đo R22) thay vì chỉ ghi ~53.742 node máy user; Q5 bổ sung trạng thái quota ~48%. Không thay đổi thiết kế.
- **0.4 (2026-10-17, task R21):** HIỆU ĐINH SAU FB-BRAIN-D1. (1) **§5 UI EVO-U1..U5 dựng lại ĐẦY ĐỦ** theo convention precedent HYPERNAS §10 (7 nguyên tắc · state machine 5 trạng thái E1–E5 · bảng + 2 cấp nút · encoding viewer 144 · Pareto + khu vực chặn H7 · kill-switch panel · API contract pin · copy chốt) — đánh dấu rõ "tái tạo, chốt cuối khi tới EVO-P4"; (2) **§10 Q1–Q6 tái tạo** từ tri thức phiên kèm đề xuất mặc định + ghi nguồn trung thực (cần user chốt khi tới phase); (3) §0.2 D1 → HOÀN TẤT (R20 4394507 + FB-BRAIN-D1 R21); (4) §8.1 cập nhật corpus sau 8 fix BUG2-269..276 (migration bù + byte-cap + denseThreshold/sourcesEnabled + fallback/graph wrapper + ALS undefined + empty-query + doc trung thực tokensUsed); (5) §1 bổ sung dòng R21.
- **0.3 (2026-10-17, task R20):** TÁI TẠO SAU RESET. Từ v0.2 mất: giữ toàn bộ thiết kế đã chốt + 2 quyết định duyệt trước reset (Q7=(b), Q9=D0); cập nhật cột trạng thái trung thực (EVO-P1..P4 "đã từng làm — mất → viết lại"); nâng "commit + dual-push mỗi mốc" lên doctrine; bổ sung §1 định tính mất mát qua GitHub PAT; đánh dấu §5 UI + Q1–Q6 là phần chi tiết mất (phác tái tạo, chốt lại khi tới phase). Kế thừa kết quả review v0.2 (vai kỹ sư AI/kiến trúc sư): encoding additive bijective mỗi vùng · bảng phụ thuộc D0 · kill-switch naming chuẩn 2 cờ D3.
- **0.2 (2026-10-16 — MẤT theo reset):** bản 386 dòng sau review: bổ sung §8 BRAIN-D 4 phase, §9 bảng KB 4 lớp với Neo4j là LÕI (đính chính user), §10 Q1–Q9, rào H7/H8.
- **0.1 (2026-10-16 — MẤT):** bản đầu từ chuỗi Q&A kiến trúc não (3 câu kiến trúc + 4 câu vai trò) — phases EVO-P0..P5, encoding 96→144, block engine, UI EVO-U1..U5.
