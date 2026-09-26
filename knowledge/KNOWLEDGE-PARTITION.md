# PHÂN VÙNG TRI THỨC — BẢN ĐỒ 9 KNOWLEDGE SHARD

> **Mục đích:** File này là bản đồ phân vùng tri thức của 9 shard (2.24 MB, đặt tại `knowledge/`). Khi tiếp tục xây dựng / nâng cấp hệ thống TMO và cần thông tin thuộc các vùng tri thức này, tra file này để biết **đọc shard nào, tìm bằng từ khóa nào, theo cấu trúc nào** — tránh đọc mù cả file 100–400 KB.
>
> **Nguồn:** GitHub repo `nguyenquocviety2c-code/AGI` (private), tải ngày 2026-09-26, bit-perfect theo git blob SHA-1.
> **Cập nhật:** 2026-09-26 (Task 17 — phân tích cấu trúc toàn bộ 9 file).

---

## 0. CÁCH DÙNG (3 bước)

1. **Tra §1 Bảng tra nhanh** → xác định shard chứa vùng tri thức cần.
2. **Tra §6 Hướng dẫn tìm kiếm** → dùng grep/tìm theo tên entity hoặc theo ID prefix.
3. **Đọc khối cần thiết** — mỗi khối (block) độc lập, có ID ổn định (NODE_ID / RULE_ID / DYNAMIC_ID / METRIC_ID), không cần đọc cả file.

Ngôn ngữ nội dung: **song ngữ Việt–Anh** (tên entity tiếng Anh, mô tả/quan hệ tiếng Việt). Trích dẫn trong thiết kế/agent prompt được khuyến khích ghi kèm ID (ví dụ `CPX_ENT_013 Emergence`) vì ID ổn định qua các version.

---

## 1. BẢNG TRA NHANH: NHU CẦU → SHARD (ROUTING)

| Khi cần thông tin về… | Đọc shard | Từ khóa đại diện |
|---|---|---|
| **Nhân quả AI (Causal AI)** — SCM, intervention, counterfactual, back-door/front-door, collider, instrumental variable, identifiability, deconfounding, NOTEARS | `SHD_GEN_CAUSAL_HYPER_001.TXT` | Structural Causal Models, Counterfactuals, Back-door Criterion, Potential Outcomes, ACE |
| **Hypernetworks / generative weights** — mạng sinh trọng số, latent code điều khiển SCM, neural SCM | `SHD_GEN_CAUSAL_HYPER_001.TXT` | Hypernetworks, Weight-generating Functions, Neural SCM, Latent Space |
| **Lý thuyết thông tin** — entropy, KL, mutual information, transfer entropy, information bottleneck, MDL | `SHD_GEN_CAUSAL_HYPER_001.TXT` (+ `SHD_DSL_007` cho ứng dụng ML) | Shannon Entropy, KL-Divergence, Information Bottleneck, Attentive Transfer Entropy |
| **Generative models** — VAE/ELBO, GAN, normalizing flows, autoregressive flows | `SHD_GEN_CAUSAL_HYPER_001.TXT` | VAEs, ELBO, Normalizing Flows, Encoder & Decoder |
| **Tự động thiết kế kiến trúc (AutoML/NAS)** — DARTS, supernet, search space/strategy, RL-based NAS, differentiable NAS | `SHD_NAS_EVOLUTION_002.TXT` | Search Space, DARTS, Supernet, Gradient-based NAS, Performance Estimation |
| **Tối ưu hóa (Optimization)** — convex, hàm mục tiêu, ràng buộc, Lagrange/shadow price, gradient descent, local minimum, heuristic/meta-heuristic | `SHD_OPT_CONVEX_003.TXT` | Objective Function, Lagrange Multipliers, Hessian, Feasible Region |
| **Điều khiển & tự chủ (Control/Autonomy)** — active inference, free energy (VFE/EFE), Markov blanket, Lyapunov, NMPC, feedback, ổn định, causal loop | `SHD_SYS_DYNAMICS_004.TXT` | Active Inference, Variational Free Energy, Markov Blanket, Lyapunov Function, NMPC |
| **Đồ thị & mạng (Graph/Network Science)** — DAG, graph-centric, state-space, stock-flow, knowledge graph, basin of attraction | `SHD_CORE_GRAPH_005.TXT` | DAG, Stock, Flow, State-Space, C-component, Basin of Attraction |
| **Hệ phức tạp & trồi hiện (Complexity/Emergence)** — emergence, edge of chaos, phase transition, scale-free, small-world, fractal, power-law, self-organization | `SHD_COMPLEXITY_006.TXT` | Emergence, Edge of Chaos, Phase Transition, Scale-free Networks, Power-law |
| **Khoa học dữ liệu & động lực học máy (ML/DSL)** — Bayesian inference, prior/posterior, overfitting, regularization, backprop, embedding, bias-variance | `SHD_DSL_007.TXT` | Bayesian Inference, Bias-Variance, Regularization, Embedding Space, Hyperparameters |
| **Lý thuyết trò chơi & multi-agent** — Nash, dominant strategy, mixed strategy, mechanism design, payoff, information set, common knowledge | `SHD_GTH_008.TXT` | Nash Equilibrium, Best Response, Mixed Strategy, Payoff Matrix, Mechanism Design |
| **Tâm lý học & hành vi** — decision-making, cognitive bias, motivation, metacognition, System 1/2, learned helplessness, peak-end rule | `PSY-CORE-SCI-009.TXT` | Maximizer/Satisficer, Anchoring, Framing, Sunk Cost Fallacy, Metacognition, System 1 |
| **Đo lường/đánh giá hệ thống** — metric định lượng cho bất kỳ domain trên | shard tương ứng, **layer METRIC** (xem §3) | MET_<prefix>_### |

**Quy tắc ưu tiên khi nhiều shard cùng nhắc một khái niệm** (DAG, Latent Variables, Heuristics xuất hiện ở nhiều shard): dùng shard **chuyên sâu nhất** theo bảng trên; các shard khác chỉ nhắc lại ở mức liên kết (`POTENTIAL_LINKAGE`).

---

## 2. TỔNG QUAN 9 SHARD

| # | File | Domain | ENT | RULE | DYN | MET | SEM | Ghi chú |
|---|------|--------|----:|-----:|----:|----:|----:|----------|
| 1 | `SHD_GEN_CAUSAL_HYPER_001.TXT` | Causal AI / Deep Learning | 70 | 1 | 69 | 0 | 50 | Shard gốc, format YAML riêng (xem §4.1) |
| 2 | `SHD_NAS_EVOLUTION_002.TXT` | AutoML / Architecture Engineering | 90 | 48 | 40 | 40 | 35 | |
| 3 | `SHD_OPT_CONVEX_003.TXT` | Mathematical Optimization | 60 | 32 | 20 | 35 | 20 | +5 khối FRM (frameworks) |
| 4 | `SHD_SYS_DYNAMICS_004.TXT` | Control Theory / Cybernetics / Autonomy | 72 | 42 | 43 | 45 | 30 | Dùng prefix SDA_ENT (trùng tên với #5 — xem §8) |
| 5 | `SHD_CORE_GRAPH_005.TXT` | Graph Theory / Knowledge Engineering / Network Science | 70 | 70 | 70 | 0 | 70 | Shard nền tảng (ROOT NEXUS), cũng dùng SDA_ENT |
| 6 | `SHD_COMPLEXITY_006.TXT` | Complexity Science / Chaos / Statistical Mechanics | 100 | 100 | 100 | 100 | 100 | Đầy đủ 5 lớp nhất |
| 7 | `SHD_DSL_007.TXT` | Machine Learning / Bayesian Statistics / Neural Architectures | 100 | 100 | 100 | 100 | 100 | |
| 8 | `SHD_GTH_008.TXT` | Game Theory / Mechanism Design / Multi-Agent Systems | 100 | 100 | 100 | 100 | 100 | |
| 9 | `PSY-CORE-SCI-009.TXT` | Behavioral Psychology / Cognitive Neuroscience / Social Psych | 200 | 100 | 100 | 100 | 100 | Format 1 dòng, có EXPERT_REFERENCE (xem §4.9) |

Tổng: ~2,200 khối tri thức. (ENT=thực thể, RULE=quy tắc, DYN=chuỗi nhân quả, MET=metric, SEM=ngữ nghĩa — định nghĩa ở §3.)

---

## 3. CẤU TRÚC 5 LỚP PHỔ QUÁT (mọi shard dùng chung)

Mỗi shard là một **đồ thị tri thức nhiều lớp** — cùng một domain được mô tả ở 5 "độ sâu" khác nhau. Khi tra cứu, chọn lớp theo câu hỏi mình cần trả lời:

| Lớp | Trả lời câu hỏi | Khối & ID | Các trường chính |
|---|---|---|---|
| **L1 — ENTITIES** | "Nó **là gì**?" | `NODE_ID: <PFX>_ENT_###` + `ENTITY_NAME` | `SPECIALIST_DOMAIN`, `DESCRIPTION_SHORT`, `INTRA_LAYER_LINKS:` (`TARGET_NODE`, `RELATION`, `POTENTIAL_LINKAGE`) |
| **L2 — RULES** | "**Quy luật** nào chi phối?" | `RULE_ID: RUL_<PFX>_###` | `RULE_NAME`, `LOGICAL_ASSERTION` (hoặc `STRATEGIC_ASSERTION` ở GTH), `SPECIALIST_SUPERVISOR`, `INTRA_RULE_RELATION` |
| **L3 — DYNAMICS** | "Vì sao / **cơ chế** nào?" | `DYNAMIC_ID: DYN_<PFX>_###` | `CAUSAL_CHAIN` ("Nếu… thì…, dẫn đến…"), `LOOP_TYPE` (Reinforcing / Balancing / Linear), `NODES_INVOLVED`, `POTENTIAL_CONNECTIONS` |
| **L4 — SEMANTICS** | "**Hiểu sâu** / so sánh với gì?" | `NODE_ID: SEM_<PFX>_###` | `SEMANTIC_DESCRIPTION`, `ANALOGY_STRUCTURE` (`CONCEPT`, `SIMILAR_TO`, `SIMILARITY_ASPECT`, `DIFFERENCE_ASPECT`) |
| **L5 — METRICS** | "**Đo** bằng gì?" | `METRIC_ID: MET_<PFX>_###` | `METRIC_NAME`, `CALCULATION_LOGIC` (hoặc `EVALUATION_LOGIC`), `SIGNIFICANCE_LEVEL`, `INTER-METRIC_DEPENDENCY` |

* Vị trí layer marker không đồng nhất giữa các file (ví dụ GTH để SEM ở `layer_3:`) — **định vị theo ID prefix của khối, không theo số layer**.
* `<PFX>` = tiền tố shard: `CPX` (Complexity), `DSL`, `GTH`, `NAS`, `OPT`, `SDA`/`GRA` (xem §8), `SEM_` + mã shard (SEM_CPX, SEM_GRA, SEM_DSL, SEM_GTH, SEM_NAS, SEM_OPT, SEM_SDA, SEM_MOT cho PSY).

---

## 4. CHI TIẾT TỪNG SHARD

### 4.1 `SHD_GEN_CAUSAL_HYPER_001.TXT` — Generative Causal Graph Neural Hypernetworks
- **Domain:** Causal AI / Deep Learning · **Là shard GỐC** của cây shard (NAS + OPT neo vào nó) · architect "Mr. Architect".
- **Nội dung:** nền tảng nhân quả hoàn chỉnh — đồ thị nhân quả (DAG, collider, skeleton, Markov equivalence, adjustment sets, IV), suy luận nhân quả (potential outcomes, ACE, back-door/front-door, g-computation, identifiability), generative (VAE/ELBO, GAN, normalizing flows, hypernetworks sinh trọng số cho Neural SCM), lý thuyết thông tin nhân quả (transfer entropy, attentive transfer entropy, MDL, information bottleneck), coding theory (Hamming, trellis, channel capacity, turbo codes), MCMC, VC dimension.
- **⚠️ Format riêng (KHÔNG theo 5 lớp chuẩn):** YAML-list `- DYNAMIC_ID: "DYN_..."` / `- NODE_ID: ENT_<SUB>_0xx` xen kẽ; entity ID mang mã lĩnh vực con (ENT_VC, ENT_SYN, ENT_MCMC, ENT_TUR…); **50 khối SEM** cũng theo format list (`- NODE_ID: SEM_<mã-lĩnh-vực>_###` — SEM_SCM, SEM_HYP, SEM_IB, SEM_NAD, SEM_LLM… dùng `ANALOGY_HUB` với SIMILAR_TO/ASPECT/DIFFERENT_IN). Metadata chỉ có `layer: 1` đơn lẻ.
- **ID đặc trưng:** `DYN_HYPER_WEIGHT_STEERING`, `DYN_ACYCLICITY_SELF_CORRECTION`, `DYN_ELBO_REFINEMENT_LOOP`, `DYN_BACKDOOR_DECONFOUNDING_FLOW`, `ENT_VC_061`.

### 4.2 `SHD_NAS_EVOLUTION_002.TXT` — Neural Architecture Search
- **Domain:** AutoML / Architecture Engineering · parent: GEN_CAUSAL_HYPER_001 · status Seed_Phase.
- **Nội dung:** toàn bộ pipeline NAS — search space (macro/micro/hierarchical/chain, cell-based: normal/reduction cell), search strategy (RL, evolutionary, gradient-based/DARTS), performance estimation, DAG operators (node/edge), evaluation/retraining, exploration–exploitation tradeoff.
- **ID đặc trưng:** `NAS_001 Neural Architecture Search (NAS)`, `SEM_NAS_###`.

### 4.3 `SHD_OPT_CONVEX_003.TXT` — Convex Optimization
- **Domain:** Mathematical Optimization / Computational Science · parent: GEN_CAUSAL_HYPER_001.
- **Nội dung:** quy trình tối ưu hóa — objective/feasible region/decision variables/constraints, Lagrange (shadow prices), gradient/Hessian, local minimum, heuristic & meta-heuristic, Bayesian hook (prior/likelihood/posterior), và **5 khối framework** (`OPT_FRM_###`) tổng hợp áp dụng.
- **⚠️ Quirk:** marker layer gõ nhầm `layers_3:`/`layers_4:` (có "s"); một số RULE mang ID `RUL_NAS_###`.

### 4.4 `SHD_SYS_DYNAMICS_004.TXT` — System Dynamics & Autonomy
- **Domain:** Control Theory / Cybernetics / Autonomous Systems · parent: OPT_CONVEX_003.
- **Nội dung:** **Active Inference (Friston)** là xương sống — internal/external states (μ/η), Markov blanket, VFE/EFE, solenoidal/dissipative flow, NESS; điều khiển cổ điển — feedback, Lyapunov stability, NMPC, causal loop diagram, actuators; kiến trúc tự chủ — Structural Prior (Π), Multi-Regime Evaluator (L), Persistent Memory (M).
- **ID đặc trưng:** `SDA_ENT_001 Internal States (μ)`, `SEM_SDA_###`.

### 4.5 `SHD_CORE_GRAPH_005.TXT` — Graph-Centric Paradigm
- **Domain:** Graph Theory / Knowledge Engineering / Network Science · **shard nền tảng "ROOT NEXUS_SYSTEM"**.
- **Nội dung:** tư duy đồ thị hệ thống — stock/flow/auxiliary/delay (system dynamics), master equation, state-space, C-component, latent variables, heuristic function, feedback controller, fixed point/basin of attraction/limit cycle, stability margin, can thiệp (Agent Action/Intervention/Policy).
- **⚠️ Quirk:** dùng prefix `SDA_ENT_###` **trùng** với SYS_DYNAMICS_004 nhưng nội dung khác (SDA_ENT_001 ở đây = "Stock", ở SYS_DYNAMICS = "Internal States (μ)") — khi trích dẫn LUÔN ghi kèm tên file. Có nhóm ID phụ `SDA_L1_###`. Không có layer METRIC.

### 4.6 `SHD_COMPLEXITY_006.TXT` — Complexity & Emergent Dynamics
- **Domain:** Complexity Science / Chaos Theory / Statistical Mechanics · parent: SHD_CORE_GRAPH (ghi "000" — xem §8).
- **Nội dung:** đầy đủ nhất 5 lớp — mạng phức tạp (small-world, scale-free, hubs, preferential attachment), fractal/self-similarity, heavy-tail/power-law, emergence, edge of chaos, phase transition, critical thresholds, entropy, feedback loops, agents.
- **Metric nổi bật:** `MET_CPX_001 Kolmogorov Complexity`, MDL…

### 4.7 `SHD_DSL_007.TXT` — Data Science & Learning Dynamics
- **Domain:** Machine Learning / Bayesian Statistics / Neural Architectures · parent: SHD_CORE_GRAPH (ghi "000").
- **Nội dung:** động lực học học máy — Bayesian (prior/likelihood/posterior, Gaussian), huấn luyện (loss, backprop, gradient descent, hyperparameters), bệnh lý mô hình (overfitting/underfitting, regularization), biểu diễn (feature vector, embedding space, weights).
- **Semantic mẫu:** `SEM_DSL_001` Bias-Variance Tradeoff với analogy "điều chỉnh dây đàn nhạc cụ".

### 4.8 `SHD_GTH_008.TXT` — Game Theory & Strategic Interaction
- **Domain:** Strategic Logic / Mechanism Design / Multi-Agent Systems · parent: SHD_CORE_GRAPH (ghi "000").
- **Nội dung:** lý thuyết trò chơi đầy đủ — players/actions/outcomes/payoff, information set, extensive form, pure/mixed strategy, dominant strategy, best response, Nash equilibrium, expected utility, belief update, common knowledge, mechanism design. **Rất phù hợp cho thiết kế multi-agent coordination của TMO.**
- **Quirk:** RULE dùng `STRATEGIC_ASSERTION`, METRIC dùng `EVALUATION_LOGIC` (khác tên trường các shard khác); SEM đặt ở `layer_3:`.

### 4.9 `PSY-CORE-SCI-009.TXT` — Fundamental & Behavioral Psychology
- **Domain:** behavioral-psychology, cognitive-neuroscience, social-psychology, developmental-stages, personality-theory.
- **Nội dung:** 200 thực thể tâm lý/hành vi — quyết định (Maximizer/Satisficer, paradox of choice, opportunity cost, regret), bias nhận thức (anchoring, framing, availability, sunk cost, confirmation bias), động lực & cảm xúc (SEM_MOT_*), xã hội (social comparison, learned helplessness), tư duy (critical thinking, metacognition, System 1/2).
- **⚠️ Format riêng:** khối **1 dòng compact** (mọi trường trên cùng một dòng, ngăn cách bằng khoảng trắng) + trường độc quyền **`EXPERT_REFERENCE`** (Barry Schwartz, Herbert Simon…) — grep theo `ENTITY_NAME: <tên>` vẫn hoạt động nhưng cần đọc cả dòng dài.

---

## 5. ĐỒ THỊ LIÊN KẾT GIỮA CÁC SHARD (`parent_link`)

```
PSY-CORE-SCI-009 (tâm lý — corpus độc lập, không parent)

SHD_CORE_GRAPH_005  ← ROOT NEXUS_SYSTEM (nền tảng cấu trúc)
 ├── SHD_COMPLEXITY_006   (đồ thị → mạng phức tạp)   [parent ghi "SHD_CORE_GRAPH_000"]
 ├── SHD_DSL_007          (đồ thị → dữ liệu/vector)  [parent ghi "SHD_CORE_GRAPH_000"]
 └── SHD_GTH_008          (đồ thị → điều phối MAS)   [parent ghi "SHD_CORE_GRAPH_000"]

SHD_GEN_CAUSAL_HYPER_001 (nhân quả sinh hypernetwork)
 ├── SHD_NAS_EVOLUTION_002 (nhân quả → tự thiết kế kiến trúc)
 └── SHD_OPT_CONVEX_003    (nhân quả → tối ưu hội tụ)
      └── SHD_SYS_DYNAMICS_004 (tối ưu → điều khiển ổn định/autonomy)
```

Hai nhánh + một corpus: **(A)** nhánh cấu trúc/đồ thị → phức tạp/DSL/game theory; **(B)** nhánh nhân quả → NAS/optimization → system dynamics; **(C)** tâm lý học hành vi.

---

## 6. HƯỚNG DẪN TÌM KIẾM

### 6.1 Tìm theo TÊN khái niệm (cách nhanh nhất)
```bash
cd /home/z/tmo-app/knowledge
# Tìm entity ở mọi shard (xem số dòng để đọc quanh đó):
grep -n "ENTITY_NAME:.*Nash Equilibrium" *.TXT
# Tìm trong một shard:
grep -n "Emergence" SHD_COMPLEXITY_006.TXT
```
Sau đó đọc vùng quanh dòng đó (mỗi khối ~8–12 dòng, ngăn cách bởi `---` hoặc dòng trống).

### 6.2 Tìm theo LOẠI câu hỏi (ID prefix)
```bash
grep -n "^CAUSAL_CHAIN:" SHD_COMPLEXITY_006.TXT   # mọi cơ chế nhân quả
grep -n "^RULE_ID:" SHD_GTH_008.TXT               # mọi quy tắc
grep -n "^METRIC_ID:" SHD_COMPLEXITY_006.TXT      # mọi metric đo lường
grep -n "NODE_ID: SEM_" SHD_DSL_007.TXT           # mọi semantic/analogies
```

### 6.3 Tìm qua ID đã trích (định vị tuyệt đối)
ID là duy nhất trong shard → `grep -n "CPX_ENT_013" SHD_COMPLEXITY_006.TXT`.

### 6.4 Quan hệ giữa khối
- Trong shard: đọc `INTRA_LAYER_LINKS` / `INTRA_RULE_RELATION` / `INTRA_DYNAMIC_RELATION` / `INTER-METRIC_DEPENDENCY` trong khối hiện tại → theo `TARGET_*` sang khối đích.
- Liên shard: `parent_link` trong metadata (§5) + các liên kết `POTENTIAL_LINKAGE` nhắc tên khối ở shard khác.

### 6.5 Khi nạp cho agent (RAG/context)
- Một khối ENT trung bình ~600–900 ký tự → nạp nguyên khối (kèm ID + tên file nguồn) là vừa vặn cho context window.
- Không nạp cả file vào prompt (118–400 KB/file). Dùng §1 để chọn shard, §6.1–6.2 để chọn khối.

---

## 7. TAXONOMY `SPECIALIST_DOMAIN` (phân vai chuyên gia gắn trên mỗi khối)

`SCIENTIST` · `ENGINEER` · `SYSTEMS` / `SYSTEMS THINKER` · `DATA` / `DATA SCIENTIST` · `STRATEGIST` · `PSYCHOLOGIST` · `CREATIVE` · (hiếm) `ARCHITECT`, `MACHINE`

Mỗi thực thể/quy tắc/chuỗi nhân quả được gán vai chuyên gia "sở hữu" khối đó — tương thích khái niệm đội ngũ multi-agent chuyên gia (đáng chú ý khi map sang roster agents của TMO). Lưu ý casing không đồng nhất (`Scientist` vs `SCIENTIST` ở NAS) — normalize khi cần thống kê.

---

## 8. QUIRKS & LƯU Ý CHẤT LƯỢNG DỮ LIỆU

1. **Trùng prefix `SDA_ENT_`** giữa CORE_GRAPH_005 và SYS_DYNAMICS_004 (khác nội dung) → khi trích dẫn luôn kèm tên file; hai shard có nội dung giao nhau ở chủ đề stock/flow/feedback (CORE_GRAPH là "graph thinking", SYS_DYNAMICS là "active inference/control" — phần giao nhỏ).
2. **`parent_link` ghi `SHD_CORE_GRAPH_000`** nhưng file thực tế là `SHD_CORE_GRAPH_005` (quirk đặt tên gốc, không phải lỗi tải).
3. **GEN_CAUSAL_HYPER_001** là shard gốc, format YAML-list không theo chuẩn 5 lớp, không có METRIC layer; một số entity ID nằm ngoài dãy tuần tự (ENT_*_061…).
4. **PSY-CORE-SCI-009** khối 1 dòng + EXPERT_REFERENCE; tên file dùng **gạch ngang** (bản gốc user), 8 file SHD dùng gạch dưới.
5. **OPT_CONVEX_003** marker `layers_3:`/`layers_4:` gõ thừa "s"; có 5 khối `OPT_FRM_###` (frameworks) riêng; một số RULE mang ID `RUL_NAS_###`.
6. **GTH_008** đổi tên trường RULE/METRIC (`STRATEGIC_ASSERTION`, `EVALUATION_LOGIC`).
7. Một số `LOGICAL_ASSERTION` có ký tự lỗi font tiếng Việt rải rác (vd "ệ thống" mất chữ) — nội dung vẫn hiểu được; nếu trích xuất tự động cần làm sạch.
8. Dấu ngoặc `[…]` cuối CAUSAL_CHAIN/DESCRIPTION là **citation markers** [1], [1-3]… — tham chiếu nội bộ corpus, không có bibliography đi kèm trong 9 file này.

---

*Sinh tự động từ phân tích cấu trúc 9 shard — Task 17, 2026-09-26. Nếu shard được cập nhật version, chạy lại phân tích để làm mới bản đồ.*
