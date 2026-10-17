# BLUEPRINT TRIỂN KHAI EVO-NAO P1 → P5 + BRAIN-D "TRI THỨC" CHO TMO

> **Phiên bản 0.3 — TÁI TẠO SAU CONTAINER RESET (2026-10-17, task R20).**
> Bản v0.2 (386 dòng — sản phẩm chuỗi phiên Q&A kiến trúc não → Brain-D design → review kỹ sư) **MẤT theo sandbox reset vì chưa kịp commit/push GitHub**. Bản này tái tạo từ tri thức phiên kèm **2 quyết định user đã duyệt TRƯỚC reset, giữ nguyên hiệu lực:**
> - **Q7 = phương án (b)** — D3 kèm cả **chế độ vận dụng** (không chỉ tinh chỉnh tham số truy xuất);
> - **Q9 = CÓ** — thêm phase **D0** ánh xạ 9 shard `knowledge/` vào Neo4j (Neo4j là LÕI KB).
>
> **Bài học reset (NÂNG LÊN DOCTRINE):** mọi mốc triển khai phải **commit + dual-push GitHub NGAY khi hoàn thành** — đợt EVO-P1..P4 + FB-CAUSAL (r103) + SMGI-canary (r104) đã viết xong trên sandbox cũ nhưng không push nên mất sạch. Từ v0.3: gate "hoàn thành" của mọi task PHẢI gồm `git push` cả 2 kho (origin + mirror).
>
> Bổ sung cho [BLUEPRINT-BRAIN-P1-P5.md](./BLUEPRINT-BRAIN-P1-P5.md) (P1→P4 hoàn tất — 3 brain A/B/C đã sống) và [BLUEPRINT-HYPERNAS-P1-P5.md](./BLUEPRINT-HYPERNAS-P1-P5.md) (HN-P1 hoàn tất — search space 96 chiều đã sống ở main).

---

## 0. TÓM TẮT ĐIỀU HÀNH

### 0.1 Chuỗi phase EVO (tiến hoá kiến trúc não)

| Phase | Tên | Mục tiêu một câu | Artifacts | Cờ (mặc định) | Test | Trạng thái |
|---|---|---|---|---|---|---|
| **EVO-P0** | Nền & đối chứng | Benchmark tất định + fixtures tái lập để mọi ứng viên so với Brain-C active (MLP chuỗi) trên cùng dữ liệu | `src/lib/brain/evo/benchmark.ts` + fixtures | — (thuần lib) | r105 | Chưa triển khai |
| **EVO-P1** | Encoding additive 144 | Mở search space 96→144: thêm slot block kiến trúc (layer-type/ tham số/ MoE) — **additive, không phá HN-P1** | `search-space.ts` (mở rộng) | — (thuần lib) | r105 | **ĐÃ TỪNG làm — MẤT theo reset → viết lại** |
| **EVO-P2** | Block engine thuần TS | Block chạy được trên CPU: attention 1-head causal + selective SSM (N=8–16), seq ≤512 | `src/lib/brain/evo/blocks.ts` | — (thuần lib) | r106 | **ĐÃ TỪNG làm — MẤT → viết lại** |
| **EVO-P3** | Micro-MoE | MoE nhẹ k=2–4 experts + aux loss 0.01 (chỉ khi ≥2K mẫu) | `src/lib/brain/evo/moe.ts` | — (thuần lib) | r107 | **ĐÃ TỪNG làm — MẤT → viết lại** |
| **EVO-P4** | Evolve runner | Vòng tiến hoá: sinh ứng viên từ encoding → train → chấm benchmark → ghi BrainSearchCandidate | `src/lib/brain/evolve.ts` + `POST /api/brain/evolve` | `brain_evolve` (OFF) | r108 | **ĐÃ TỪNG làm — MẤT → viết lại** |
| **EVO-P5** | GPU sidecar | Tùy chọn: mini-service GPU khi CPU không kịp (chỉ benchmark ngoài runtime) | `mini-services/evo-gpu/` | — | r109 | Chưa triển khai |

### 0.2 Chuỗi phase BRAIN-D "Tri Thức" (não thứ 4 — dùng KB để LÀM, không chỉ trả lời)

| Phase | Tên | Mục tiêu một câu | Artifacts | Cờ (mặc định) | Test | Trạng thái |
|---|---|---|---|---|---|---|
| **D0** | Ánh xạ knowledge/ → Neo4j | Đưa 9 shard tài liệu gốc (2.2MB) vào đồ thị lõi bằng ingestion sẵn có (entity-resolver + LLM extraction) — additive, merge không đè | đo khối lượng + chạy ingestion theo đợt shard | — | — | Chưa triển khai (duyệt Q9) |
| **D1** | LOG-ONLY | Bảng `KbConsultLog` ghi MỌI lượt KB consult: ai hỏi, cấu hình truy xuất, nguồn nào trả, kết quả top, tốn bao nhiêu, chạy run nào → nối Outcome* | prisma model + instrumentation `kb-access.ts` + `workflow-engine.ts` | `kb_consult_log` (ON) | r110 | **ĐANG TRIỂN KHAI (task hiện hành — sự cố reset ngắt giữa chừng trước khi viết dòng nào)** |
| **D2** | Baseline đối chứng | Report: heuristic CỨNG hiện tại đạt mức nào trên log thật (≥100 log) — trả lời "não có hơn heuristic không?" bằng dữ liệu | script report + docs | — | r111 | Chưa triển khai |
| **D3** | Policy head 3 tầng | `brain/brains/knowledge.ts` — hành động gồm **chế độ vận dụng** (Q7=(b)) + tham số truy xuất + meta | brain D + kill-switch 2 cờ | `runtime_knowledge` (OFF) + `knowledge_organ_strategy` | r112 | Chưa triển khai (cần D2 + ≥300 log có Outcome*) |
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

- `evolve.ts`: vòng sinh ứng viên (mutation + crossover trong encoding 144, tôn trọng ngân sách H3 ≤24 ứng viên/10 phút) → train (gate A1) → chấm benchmark EVO-P0 → ghi `BrainSearchCandidate` (không giữ weights — H6).
- `POST /api/brain/evolve`: khởi động/dừng/hỏi trạng thái; **cờ `brain_evolve` mặc định OFF**; route chỉ điều phối search ngoài runtime.

### 4.6 EVO-P5 — GPU sidecar (chưa triển khai)

Mini-service độc lập port riêng (`mini-services/evo-gpu/`) chạy benchmark ngoài runtime khi CPU không kịp; KHÔNG bao giờ đụng đường runtime của app (H1).

---

## 5. UI EVO-U1..U5 (phác tái tạo — chốt chi tiết khi tới phase UI; theo precedent §10 HYPERNAS)

> Ghi chú trung thực: chi tiết U1–U5 của v0.2 mất theo reset. Khung dưới tái tạo theo cùng convention tab BRAIN SECTION 3 (6 tab console precedent 0.2.2 HYPERNAS):

- **U1** — Tab "Tiến hoá" (thứ 7) trong BRAIN › SECTION 3: trạng thái vòng evolve (running/paused), ngân sách đã dùng/limit 10 phút.
- **U2** — Bảng ứng viên BrainSearchCandidate + 2 cấp nút áp dụng (đề xuất → áp dụng) theo precedent bảng xếp hạng HN-P2.
- **U3** — Xem encoding 144 của 1 ứng viên dạng thanh phân vùng theo vùng §4.2 (màu theo vùng).
- **U4** — Biểu đồ Pareto CV-score × params × p95-latency; ứng viên bị H7 chặn hiển thị nhãn rõ.
- **U5** — Kill-switch UI: 2 cờ `brain_evolve` + kill-switch toàn cục cùng 1 panel, kèm audit TuningChangeLog.

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

1. **BRAIN-D1 LOG-ONLY** — triển khai NGAY (không phụ thuộc não thức tỉnh; chính là công cụ TẠO dữ liệu train cho D3 — triết lý "quan sát trước, hành động sau", tiền đề reward.ts).
2. **Blueprint v0.3** (file này) — phản ánh Q7=(b)/Q9=D0.
3. **D0** — đo khối lượng 9 shard trước, ingestion theo đợt (có thể tách nhiều đợt theo shard).
4. **EVO-P1..P4 viết lại** theo thứ tự §4 (khung benchmark P0 trước).
5. **D2 → D3 → D4** theo ngưỡng log.
6. **MỖI MỐC: commit + dual-push NGAY** (doctrine reset — xem phần đầu file).

---

## 8. BRAIN-D "TRI THỨC" — NÃO THỨ 4 (thiết kế chốt, chưa triển khai)

> **Yêu cầu gốc của user (2026-10-16, định nghĩa North Star):** *"Brain-D mang lại khả năng SỬ DỤNG dữ liệu, tri thức trong KB để THỰC HIỆN CÁC TÁC VỤ chứ không đơn thuần là trả lời."*
> Brain-D không phải search-engine更好的 — nó là **policy head quyết định CÁCH dùng KB trong từng tác vụ**: nạp context gì, duyệt đồ thị thế nào, bỏ qua KB khi nào.

### 8.1 D1 — LOG-ONLY (đang triển khai)

**Bảng `KbConsultLog` (prisma, additive):**

| Trường | Kiểu | Ghi chú |
|---|---|---|
| id | String @id | uuid |
| createdAt | DateTime | mặc định now |
| taskType | String? | từ workflow-engine (loại tác vụ đang chạy) |
| intent | String? | intent-classifier (nhãn intent KB) |
| queryText | String? | câu hỏi/truy vấn đã rewrite |
| retrievalConfigJson | String | cấu hình truy xuất: nguồn bật, topK, trọng số hybrid BM25+RRF, MMR λ, rerank on/off, độ sâu traversal |
| sourcesJson | String | nguồn nào trả: neo4j / qdrant:chunks / qdrant:communities / qdrant:memories + số hit từng nguồn |
| topResultsJson | String | top-K kết quả: id, source, score rút gọn (≤4KB, truncate + flag) |
| tokensUsed | Int | token tiêu tốn (embedding + rerank + synthesis) |
| latencyMs | Int | thời gian truy xuất |
| runId | String? | nối AgentRunRecord → **Outcome\*** (tín hiệu reward tương lai: thành công/tokens/thời gian run) |
| sessionId | String? | phiên chat |

**Instrumentation (LOG-ONLY — KHÔNG chặn):**
- `kb-routing/kb-access.ts`: bọc hàm truy xuất — đo latency/tokens/sources/topK, ghi log sau khi xong; **try/catch toàn bộ, lỗi ghi-log không bao giờ làm hỏng truy xuất**;
- `code-team/workflow-engine.ts`: bọc điểm gọi KB — truyền thêm taskType + intent vào log;
- Cờ `kb_consult_log` trong tuning-store (mặc định **ON**) — tắt được khi cần đo hiệu năng thuần.

**Ngưỡng nghĩa:** D1 bắt đầu "có dữ liệu" ≥100 log → D2; ≥300 log có Outcome* → D3.

### 8.2 D2 — Baseline đối chứng

Script report trên KbConsultLog thật: heuristic CỨNG hiện tại (pipeline 4 lớp cố định) đạt mức nào — phân phối latency/tokens theo intent, tỷ lệ nguồn trúng, tương quan kết quả↔Outcome*. Đầu ra: docs report + bộ số liệu đối chứng cho D3 phải thắng (gate A1 tương tự).

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

Mở encoding §4 thêm vùng head Brain-D (sau vùng dự phòng) — kiến trúc knowledge head do evolve tìm thay vì hand-tune. Chỉ khởi động khi EVO-P1..P4 + D3 đều sống.

---

## 9. KB 4 LỚP — NEO4J LÀ LÕI (đính chính user 2026-10-16, giữ nguyên)

| Lớp | Vai trò | Hiện trạng |
|---|---|---|
| **1. Neo4j GraphRAG — LÕI** | Đồ thị tri thức ~53.742 node; 8 ENTITY_LABELS: Concept/Technology/Framework/Vulnerability/Principle/Domain/Document/Person + cộng đồng Leiden + node Episode/Lesson | Lõi suy luận (structured-subgraph/traversal-plan của D3 bám vào đây) |
| **2. Qdrant vector** | 3 collection: chunks / communities / memories | **Local user: KHÔNG trống** (populate thật) — D1 sẽ log kết quả thật |
| **3. `kb-routing/` pipeline** | 4 lớp heuristic CỨNG: intent-classifier → kb-access (4 nguồn song song + hybrid BM25+RRF + MMR + cross-encoder rerank) → writeback → synthesis | Đối chứng cho D2; fail-open target của D3 |
| **4. `knowledge/` 9 shard (2.2MB)** | Tài liệu GỐC — nguồn sự thật cuối: SHD_GEN_CAUSAL_HYPER_001 · SHD_NAS_EVOLUTION_002 · SHD_OPT_CONVEX_003 · SHD_SYS_DYNAMICS_004 · SHD_CORE_GRAPH_005 · SHD_COMPLEXITY_006 · SHD_DSL_007 · SHD_GTH_008 · PSY-CORE-SCI-009 | **CHƯA ánh xạ vào Neo4j → D0 xử lý** |

**D0 (duyệt Q9):** đo khối lượng từng shard (đếm entity/type tiềm năng bằng extraction mẫu) → ingestion theo đợt shard bằng ingestion sẵn có (LLM extraction + entity-resolver merge theo ngưỡng tương đồng — **additive H5, không drop node cũ**); ưu tiên shard giá trị cao nhất trước (NAS_EVOLUTION_002 + GEN_CAUSAL_HYPER_001 phục vụ trực tiếp đợt EVO).

---

## 10. CÂU HỎI MỞ Q1–Q9 (Q7/Q9 ĐÃ CHỐT — Q1–Q6/Q8 còn mở)

| # | Câu hỏi | Trạng thái |
|---|---|---|
| Q1–Q6 | Các câu hỏi mở cấp phase (chi tiết văn bản gốc mất theo reset — **tái xác định khi tới từng phase**, ghi lại vào đây khi chốt) | Mở |
| **Q7** | D3 có kèm chế độ vận dụng hay chỉ tinh chỉnh tham số truy xuất? | **CHỐT = (b)** kèm cả 3 chế độ vận dụng (context-block/structured-subgraph/traversal-plan) — 2026-10-16 |
| Q8 | Tín hiệu Outcome* cho D3 dùng gì: Outcome* run (thành công/tokens/thời gian) hay citation-counting (kết quả KB có được dùng trong câu trả lời)? | Mở — **đề xuất mức 1** (Outcome* trực tiếp, đơn giản đo được từ D1 runId) trước khi cân nhắc mức 2 |
| **Q9** | Có thêm D0 ánh xạ 9 shard `knowledge/` vào Neo4j không? | **CHỐT = CÓ** — D0 vào §8/§9, đo khối lượng trước, tách đợt được — 2026-10-16 |

---

## 11. NHẬT KÝ HIỆU ĐINH

- **0.3 (2026-10-17, task R20):** TÁI TẠO SAU RESET. Từ v0.2 mất: giữ toàn bộ thiết kế đã chốt + 2 quyết định duyệt trước reset (Q7=(b), Q9=D0); cập nhật cột trạng thái trung thực (EVO-P1..P4 "đã từng làm — mất → viết lại"); nâng "commit + dual-push mỗi mốc" lên doctrine; bổ sung §1 định tính mất mát qua GitHub PAT; đánh dấu §5 UI + Q1–Q6 là phần chi tiết mất (phác tái tạo, chốt lại khi tới phase). Kế thừa kết quả review v0.2 (vai kỹ sư AI/kiến trúc sư): encoding additive bijective mỗi vùng · bảng phụ thuộc D0 · kill-switch naming chuẩn 2 cờ D3.
- **0.2 (2026-10-16 — MẤT theo reset):** bản 386 dòng sau review: bổ sung §8 BRAIN-D 4 phase, §9 bảng KB 4 lớp với Neo4j là LÕI (đính chính user), §10 Q1–Q9, rào H7/H8.
- **0.1 (2026-10-16 — MẤT):** bản đầu từ chuỗi Q&A kiến trúc não (3 câu kiến trúc + 4 câu vai trò) — phases EVO-P0..P5, encoding 96→144, block engine, UI EVO-U1..U5.
