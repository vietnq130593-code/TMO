# TB-10 — DIRECTED READING & RESEARCH ARTIFACT MAP — ĐỌC NGHIÊN CỨU THÔNG MINH

> 🎯 **TECHNICAL BLUEPRINT — AI RESEARCH TEAM (DUAL MISSION: M1 KAGGLE + M2 SYSTEM RESEARCH TMO)**
> Source of Truth: `upload/ai-team-workflow.md` — section "🎯 CƠ CHẾ DIRECTED READING + RESEARCH ARTIFACT MAP — ĐỌC NGHIÊN CỨU THÔNG MINH" (dòng 3780–4287) + tham chiếu ngang (dòng 543–601, 4428–4511)
> Tập blueprint: 13 file (TB-00 → TB-12) — file này thuộc **nhóm C — Protocols ngang**
> Version: 1.2 | Ngày: 2026-08-31 (review + fix — Task 9, 10-e) | Author: Mr. Robot (Z.ai Code) — Task ID 8-h
>
> ⚠️ Quy tắc số 1 (TB-00 §5): nguồn là Single Source of Truth — TB-10 MÔ RỘNG để triển khai được, KHÔNG thay đổi thiết kế nguồn. `[SRC]` = giữ nguyên ý nguồn · `[EXT]` = mở rộng mới, không mâu thuẫn nguồn · `[Q]` = câu hỏi mở.

---

## §0. MỤC ĐÍCH & PHẠM VI

`[TB-10 §0 ← template TB-00 §4]` `[EXT]`

- **Mục đích:** biến section Directed Reading của nguồn (~508 dòng) thành **giao thức vận hành** cho cách cả team đọc artifacts: 3 lớp thông tin, chiến lược 4 bước, format Research Artifact Map (M1 + M2), Dynamic Artifact Chain, chiến lược đọc theo group (LISMA/HAN/KING/SIVIL/BELI), quy ước status artifact M2 + quy trình cập nhật map.
- **Vấn đề giải quyết:** worklog chỉ là BẢN ĐỀ XUẤT — không cho biết artifact nào quan trọng, code nào có leakage risk, file/log nào chứa evidence. Đọc toàn bộ artifacts → overwhelm, miss bug, tốn token. Chỉ đọc worklog → làm việc trên giấy. **Directed Reading = đường giữa: Map → code selective → protocol → fix → verify.**
- **Đối tượng đọc:** (1) kỹ sư triển khai cơ chế này vào TMO; (2) cả 5 agents — LISMA/HAN tiêu thụ map nhiều nhất, SIVIL/BELI tạo map mỗi khi hoàn thành part, KING đọc map để DECIDE; (3) user — review thiết kế (1 file = 1 review unit).
- **Phạm vi (bao gồm):** cả 2 mission — **M1** (format `artifact:type:metric_impact`; chain raw_data → submit) và **M2** (format `file:type:relevance:status`; chain source_code → PROPOSAL, POC trong Workspace); 5-khối map chuẩn trong worklog; quy ước status M2; quy trình cập nhật map append-only; Module Map TMO gợi ý cho audit M2; error/edge khi map thiếu/sai/lớn.
- **Phạm vi (KHÔNG bao gồm):** JD + Instructions từng engine → TB-03/04/05/06 · decompose part → TB-07 · worklog schema chuẩn toàn team → TB-09 (map LÀ 1 khối của worklog — schema gốc ở đó, TB-10 chỉ định nghĩa khối map) · Knowledge Base → TB-08 · Proposal Schema + SELF-DIRECTION → TB-11 · mã nguồn TMO + hạ tầng PM2/Qdrant — dừng ở ranh giới "runtime contract".

| File liên quan | Quan hệ với TB-10 |
|---|---|
| TB-03 (G1) | SIVIL/BELI: TẠO map khi hoàn thành part; ĐỌC map của part trước khi bắt đầu part mới |
| TB-04 (G2) | LISMA: đọc theo Leakage/Bug Locations (M1) / Suspect Locations (M2) — người tiêu thụ map #1 |
| TB-05 (G3) | HAN: đọc theo Metric Impact Chain (M1) / Impact Chain (M2); cập nhật map sau optimize |
| TB-06 / TB-07 | KING: chỉ đọc Worklog + Artifact Map (KHÔNG đọc code trừ ESCALATE / verify claim); cấp Lớp 1 Research Protocol khi DECOMPOSE; Decision Log ghi pivot |
| TB-09 | Worklog + Handoff — nơi map "sống"; map là khối bắt buộc khi handoff |
| TB-11 | Chain M2 kết thúc ở PROPOSAL — mọi claim truy evidence ngược về map |
| TB-12 | E2E playbooks đối soát cơ chế đọc (token budget, ưu tiên, checkpoint) |

---

## §1. DIRECTED READING — ĐỌC NGHIÊN CỨU THÔNG MINH

`[TB-10 §1 ← nguồn dòng 3782–3835, 3878–3913, 4214–4233]` `[SRC]`

### 1.1 🎯 Nguyên tắc gốc: đọc CHỌN LỌC — không đọc hết

```
┌────────────────────────────────────────────────────────┐
│  THÔNG TIN MÀ WORKLOG CUNG CẤP:                       │
│  ✅ "Đã tạo feature pipeline — xử lý missing + encode" │
│  ✅ "CV score cải thiện 0.006"                         │
│  ✅ (M2) "Đã audit xong module memory"                 │
│  ❌ KHÔNG CHO BIẾT:                                   │
│  → Feature nào quan trọng nhất? (importance ranking)  │
│  → Code nào có data leakage risk?                     │
│  → Notebook nào cần đọc, cái nào bỏ qua?              │
│  → Artifact nào ảnh hưởng metric nhiều nhất?          │
│  → Dataset nào đã clean, cái nào chưa?                │
│  → (M2) File/log nào chứa evidence cho finding?       │
└────────────────────────────────────────────────────────┘
```

> **Worklog = BẢN ĐỀ XUẤT · Artifact = THỰC TẾ.** Review/Fix/Optimize phải làm trên THỰC TẾ, không phải trên ĐỀ XUẤT. `[SRC dòng 3801–3802]`

Directed Reading = phương pháp đọc của research team: **không đọc hết** mọi artifact, cũng không chỉ đọc mô tả — mà đọc THEO CHỈ ĐIỂM từ Artifact Map theo chuỗi **Artifact → Impact → Action**. `[SRC dòng 3826]` Diễn giải thành 3 câu hỏi liên tiếp cho từng artifact (đây là gì? ảnh hưởng metric/evidence bao nhiêu? tôi cần làm gì tiếp?) là phần mở rộng `[EXT diễn giải]` của TB-10.

### 1.2 Code Location Map (Code Team) vs Research Artifact Map (Research Team)

```
┌──────────────────────────────────────────────────────────────┐
│  CODE TEAM — CODE LOCATION MAP                               │
│  Cấu trúc: STATIC — code đã viết, bug ở vị trí cố định      │
│  Format: file:line:issue  (vd: service.ts:45:Null check thiếu)│
│  Đọc: File → Line → Fix      Nature: Xây dựng — biết output  │
├──────────────────────────────────────────────────────────────┤
│  RESEARCH TEAM — RESEARCH ARTIFACT MAP                       │
│  Cấu trúc: DYNAMIC — mỗi bước tạo artifact mới              │
│  Format (M1): artifact:type:metric_impact                    │
│  Ví dụ: target_encoding:feature:CV -0.006                    │
│  Format (M2): file:type:relevance:status                     │
│  Ví dụ: src/lib/memory.ts:source:core-target:audited         │
│  Đọc: Artifact → Impact → Action                             │
│  Nature: Thí nghiệm — KHÔNG biết trước kết quả              │
│  Chain M1: raw_data → clean_data → features → models        │
│            → preds → submit                                  │
│  Chain M2: source_code → analysis_report → findings         │
│            → proposal → POC                                  │
│  Mỗi bước tạo artifact mới, mỗi artifact có metric impact    │
└──────────────────────────────────────────────────────────────┘
```

| Tiêu chí | Code Location Map | Research Artifact Map |
|---|---|---|
| Cấu trúc | Tĩnh (code đã tồn tại) | Động (mỗi bước tạo artifact mới) |
| Format | `file:line:issue` | M1: `artifact:type:metric_impact` · M2: `file:type:relevance:status` |
| Cách đọc | File → Line → Fix | **Artifact → Impact → Action** |
| Bản chất | Xây dựng — biết rõ output cần gì | Thí nghiệm — kết quả chỉ biết sau khi chạy |

### 1.3 Chiến lược Directed Reading — 4 bước (Research Version)

| Bước | Đọc gì | Lớp thông tin | Quy tắc chọn lọc | Token |
|---|---|---|---|---|
| **1. Đọc ARTIFACT MAP TRƯỚC** | Map từ G trước | Lớp 2 | Map là BẢN ĐỒ — cho biết code/nb/log nào CẦN đọc, cái nào BỎ QUA; artifact nào có vấn đề, loại issue nào, metric impact bao nhiêu | ~1–2K (nhẹ) |
| **2. Đọc CODE/NB/LOG THEO CHỈ ĐIỂM** | Chỉ artifacts được Map đánh dấu | Lớp 3 — selective | Chỉ đọc functions/classes có metric impact; M2: chỉ đọc file/log chứa evidence cho findings liên quan; KHÔNG đọc artifacts hoàn thành tốt (✅ trong Map); KHÔNG đọc notebooks EDA nếu chỉ là visualization | ~3–6K |
| **3. ĐỌC RESEARCH PROTOCOL ĐỂ VERIFY** | Phần Protocol liên quan | Lớp 1 | So artifact/code với hypothesis gốc; chỉ đọc phần Protocol liên quan đến artifacts đang xét | ~1–2K (nhẹ) |
| **4. FIX/OPTIMIZE + VERIFY + UPDATE MAP** | — | Tạo Lớp 2 mới cho G sau | Sửa code / tối ưu pipeline / (M2) hoàn thiện findings; M1: chạy CV, so sánh metric trước/sau; M2: xác minh evidence lần cuối, update finding status; cập nhật worklog + Artifact Map | ~2–4K |

> **TỔNG TOKEN: ~7–14K** — vừa trong budget đọc của G2/G3 (G2 ~4–8K, G3 ~6–10K — chi tiết §5). `[SRC dòng 3884–3911]`

### 1.4 Vì sao hiệu quả — so sánh 3 phương pháp đọc

| Phương pháp | Token đọc | Token sửa | Chất lượng |
|---|---|---|---|
| Đọc TOÀN BỘ artifacts + notebooks + data | 8–12K | 2–4K | Thấp (overwhelm → miss leak) |
| Đọc CHỈ worklog (không đọc code/data) | 1–2K | 2–4K | Rất thấp (không thấy bug thực tế) |
| **DIRECTED READING** (Map → code → protocol → fix → verify metric) | **3–5K** | **4–6K** | **CAO NHẤT** (focus đúng artifact, đủ context) |

> Đọc toàn bộ tốn token ~2,4–2,7× (nguồn: 8–12K vs 3–5K) nhưng chất lượng THẤP HƠN — ngữ liệu quá lớn làm agent "choáng" và bỏ sót bug CRITICAL (data leakage). Đọc có chỉ điểm từ Map = đúng mục tiêu, đủ ngữ cảnh, còn dư budget cho phần sửa. `[SRC dòng 4214–4233]`

---

## §2. 3 LỚP THÔNG TIN G2/G3 CẦN ĐỂ LÀM ĐÚNG VIỆC (RESEARCH VERSION)

`[TB-10 §2 ← nguồn dòng 3837–3876]` `[SRC]`

```
┌──────────────────────────────────────────────────────────┐
│  LỚP 1: RESEARCH PROTOCOL (từ TL)        → NORTH STAR   │
│  LỚP 2: WORKLOG + ARTIFACT MAP (G trước) → CONTEXT +    │
│                                              BẢN ĐỒ     │
│  LỚP 3: GROUND TRUTH (artifact thật)     → THỨ CẦN     │
│                                              SỬA/TỐI ƯU │
│  THIẾU BẤT KỲ LỚP NÀO = LÀM SAI VIỆC                     │
└──────────────────────────────────────────────────────────┘
```

| Lớp | Ai cấp | Nội dung M1 | Nội dung M2 | Đọc lúc nào | Trả lời câu hỏi |
|---|---|---|---|---|---|
| **L1 — Research Protocol** | TL (KING) — sinh khi DECOMPOSE, là trường trong task .md (TB-07 §3) | Hypotheses cần kiểm tra; Success criteria (CV score < bao nhiêu); CV strategy + metric chính thức; Decision Gates (khi nào pivot) | + **System Audit Charter** — phạm vi audit | Bước 3 (verify hypothesis) — chỉ đọc phần liên quan đến artifacts đang xét | "Tôi đang test gì? Đâu là đúng/sai so với hypothesis?" |
| **L2 — Worklog + Artifact Map** | G trước (G1→G2→G3; hoặc part trước cùng group) | G trước tạo artifact nào? Metric impact? Hypothesis nào confirmed/rejected? Artifact nào cần đọc / bỏ qua? Có data leakage không? | + File/log nào chứa evidence cho finding | Bước 1 — LUÔN trước khi đọc code/nb/log | "Focus vào đâu? Artifact nào quan trọng?" |
| **L3 — Ground Truth** | Mọi G khi làm part của mình | Code + Notebooks + Data: code thực sự viết thế nào; feature importance ranking; data distributions sau transform; model training logs + CV results | Source Code + Docs + Logs + Config + UI: code memory/execution/thinking chạy thế nào; logs nói gì về hành vi thực; config đang set gì; UI hiển thị gì cho user | Bước 2 — selective theo chỉ điểm từ Map | "Thực tế là gì? — đây mới là thứ cần sửa/tối ưu" |

**Ranh giới Live / Workspace cho Lớp 3 (M2)** `[SRC dòng 558–559 + EXT từ TB-02]`:

- **Live System** (TMO đang chạy): nguồn evidence CHÍNH của M2 — source code, docs, `.env.example`, dev.log, PM2 logs, health check API đều đọc được; **CHỈ ĐỌC**.
- **Workspace** (bản clone user mở): bản đồng bộ với Live — code đọc được từ cả hai; artifact do team tạo trong M2 (audit report, findings, POC) sống ở Workspace; **mọi chỉnh sửa / chạy thử chỉ trong Workspace**.

| Thiếu lớp | Hệ quả `[SRC dòng 3871–3874]` |
|---|---|
| Lớp 1 | Không biết hypothesis nào đang test → fix/optimize lệch North Star |
| Lớp 2 | Không biết artifact nào quan trọng → đọc mù, tốn token, miss bug |
| Lớp 3 | Chỉ tối ưu trên giấy (theo worklog), không trên thực tế |

`[EXT]` Liên kết 4 bước (§1.3) ↔ 3 lớp: Bước 1 = Lớp 2 (map) → Bước 2 = Lớp 3 (ground truth) → Bước 3 = Lớp 1 (protocol) → Bước 4 = tạo lại Lớp 2 cho G sau. Vòng này lặp qua từng part và qua G1 → G2 → G3 — mỗi vòng map cập nhật dần thành full chain (§4).

---

## §3. RESEARCH ARTIFACT MAP — FORMAT & FIELD SPEC

`[TB-10 §3 ← nguồn dòng 3818–3834, 3915–3984]` `[SRC + EXT field spec]`

**Định nghĩa:** Research Artifact Map = khối **BẮT BUỘC** trong worklog của mỗi G — bản đồ chỉ đường cho G sau: artifact nào cần đọc / bỏ qua, metric impact (M1) hay relevance + evidence (M2), dependencies, reading strategy, hypothesis status. `[SRC dòng 3917]`

### 3.1 Format ID dòng artifact — M1: `artifact:type:metric_impact`

| Field | Ý nghĩa | Giá trị ví dụ | Ghi chú |
|---|---|---|---|
| `artifact` | Tên file artifact (snake_case, trùng tên file .py/.csv/.ipynb) | `target_encoding` | path đầy đủ nằm ở cột Artifact của bảng chain — ID giữ ngắn |
| `type` | Vai trò trong pipeline | `feature`, `data`, `dataset`, `code`, `model`, `preds`, `submit` | TB-00 §1.4 dùng `feature` cho target_encoding; bảng chain ví dụ (§3.4) dùng `Code`/`Dataset`/`Notebook`/`Data`/`Config` — quy ước [EXT]: type ở ID = loại CHUẨN hóa, cột Type bảng chain = loại MÔ TẢ (không bắt buộc đồng bộ từng chữ) |
| `metric_impact` | Tác động lên metric chính | `CV -0.006`, `CV: 0.131→0.125`, `Runtime: 45→22 min`, `—` | delta âm hướng tốt (CV càng thấp càng tốt); `❌ Worsen` nếu làm metric tệ đi; `—` = artifact không đo trực tiếp |

Ví dụ ID chuẩn (TB-00 §1.4): `target_encoding:feature:CV -0.006`

### 3.2 Format ID dòng artifact — M2: `file:type:relevance:status`

| Field | Ý nghĩa | Giá trị ví dụ | Ghi chú |
|---|---|---|---|
| `file` | Đường dẫn file (tương đối trong repo TMO hoặc Workspace) | `src/lib/memory.ts` | [EXT] prefix `LIVE:` / `WS:` ở cột riêng để phân biệt 2 nguồn (Q4) |
| `type` | Loại artifact | `source`, `log`, `report`, `config`, `ui`, `doc`, `poc` | |
| `relevance` | Mức liên quan đến mission | `core-target`, `evidence-source`, `baseline`, `output` (nguồn — output ← "G1 output" ví dụ dòng 3970); `context` `[EXT — do map dựng §7.2]` | mapping theo module → xem §8 |
| `status` | Trạng thái xử lý artifact | `planned`, `reading`, `audited`, `evidence-attached`, `superseded` | quy ước đầy đủ ở §9 `[EXT]` |

Ví dụ ID chuẩn (TB-00 §1.4): `src/lib/memory.ts:source:core-target:audited`

### 3.3 Cấu trúc khối map chuẩn trong worklog `[SRC cấu trúc từ 2 ví dụ nguồn 3919–3956, 3960–3984 + EXT tổng quát hóa]`

| # | Khối | Nội dung bắt buộc | Áp cho |
|---|---|---|---|
| 1 | **Artifact Chain** | Bảng: Artifact \| Type \| Metric Impact (M1) / Relevance (M2) \| Status \| G-sau-nên-đọc? | M1 + M2 |
| 2 | **Issues chi tiết** | Bảng: # \| Artifact \| Location \| Type \| Severity \| Mô tả — mỗi issue trỏ đúng file / function / line | M1 + M2 |
| 3 | **Metric Impact Summary (M1)** / **Findings & Evidence (M2)** | M1: Change \| CV Before \| CV After \| Delta \| Verdict — M2: Finding \| Evidence (file:line / log excerpt) \| Severity \| Đề xuất | M1 / M2 |
| 4 | **Reading Strategy cho G sau** | Danh sách ưu tiên theo dấu 🔴 → 🟠 → 🟡; ghi rõ cả danh sách KHÔNG cần đọc | M1 + M2 |
| 5 | **Hypothesis + Dependencies** | Hypothesis nào confirmed / rejected / pending; artifact dựa trên artifact nào | M1 + M2 `[SRC quy tắc 1 — dòng 4242–4247]` |

### 3.4 Ví dụ nguồn M1 — G1 Worklog (Feature Engineering) `[SRC dòng 3919–3955 — giữ cấu trúc + số liệu]`

#### Artifact Chain:
| Artifact | Type | Metric Impact | Status | G2 nên đọc? |
|---|---|---|---|---|
| train_clean.csv | Dataset | — | ✅ Done | ❌ Bỏ qua |
| test_clean.csv | Dataset | — | ✅ Done | ❌ Bỏ qua |
| missing_handler.py | Code | CV: base→0.132 | ✅ Done | ❌ Bỏ qua |
| log_transform.py | Code | CV: 0.132→0.131 | ⚠️ Done | ✅ Đọc Line 18 |
| target_encoding.py | Code | CV: 0.131→0.125 | ⚠️ Done | ✅ Đọc ALL |
| interaction_feats.py | Code | CV: 0.125→0.124 | ✅ Done | ❌ Bỏ qua |
| domain_feats.py | Code | CV: 0.124→0.125 | ❌ Worsen | ✅ Đọc ALL |
| feature_importance.csv | Data | — | ✅ Done | ✅ Đọc ranking |

#### Issues chi tiết:
| # | Artifact | Location | Type | Severity | Mô tả |
|---|---|---|---|---|---|
| 1 | target_encoding.py | fit() | Data Leak | 🔴 CRITICAL | Encoding dùng toàn bộ dataset |
| 2 | log_transform.py | Line 18 | Edge Case | 🟡 MEDIUM | Log(0) không xử lý |
| 3 | domain_feats.py | ALL | Logic | 🟠 HIGH | Features làm WORSE — cần review |

#### Metric Impact Summary:
| Change | CV Before | CV After | Delta | Verdict |
|---|---|---|---|---|
| Missing handling | 0.134 | 0.132 | -0.002 | ✅ Worth |
| Log transform | 0.132 | 0.131 | -0.001 | ✅ Worth |
| Target encoding | 0.131 | 0.125 | -0.006 | ✅ BEST |
| Interaction feats | 0.125 | 0.124 | -0.001 | ✅ Worth |
| Domain feats | 0.124 | 0.125 | +0.001 | ❌ WORSEN |

#### Reading Strategy cho G2:
1. 🔴 Ưu tiên ĐẦU: target_encoding.py — Data Leakage (CRITICAL!)
2. 🟠 Ưu tiên 2: domain_feats.py — Review logic (HIGH)
3. 🟡 Ưu tiên 3: log_transform.py — Edge case (MEDIUM)
4. ❌ KHÔNG CẦN ĐỌC: missing_handler.py, interaction_feats.py, train/test_clean.csv
5. ✅ NÊN ĐỌC: feature_importance.csv — Understand feature ranking

### 3.5 Ví dụ nguồn M2 — G1 Worklog (Memory Audit) `[SRC dòng 3960–3984]`

#### Artifact Chain:
| Artifact | Type | Relevance | Status | G2 nên đọc? |
|---|---|---|---|---|
| memory-system.ts | Source | Core target | ✅ Audited | ✅ Đọc ALL |
| qdrant-client.ts | Source | Core target | ✅ Audited | ✅ Đọc collections |
| neo4j.ts | Source | Core target | ✅ Audited | ✅ Đọc connection |
| dev.log (last 500) | Log | Evidence source | ✅ Scanned | ✅ Đọc warnings |
| health-check output | Log | Baseline | ✅ Captured | ❌ Bỏ qua |
| audit-report.md | Report | G1 output | ✅ Done | ✅ Đọc findings |

#### Issues chi tiết:
| # | Artifact | Location | Type | Severity | Mô tả |
|---|---|---|---|---|---|
| 1 | neo4j.ts | Line 45 | Config Issue | 🟠 HIGH | DB name hardcoded sai |
| 2 | dev.log | Multiple | Performance | 🔴 CRITICAL | 121s requests khi key fail |

#### Findings & Evidence:
| # | Finding | Evidence | Severity | Đề xuất |
|---|---|---|---|---|
| 1 | Chat latency 121s | dev.log + key-pool retry path | 🔴 HIGH | Fail-fast |
| 2 | Vector search trống | Qdrant 0/52 docs | 🟠 MEDIUM | Re-ingest pipeline |

> **Khác biệt M1 vs M2 trong map:** M1 đo bằng **metric impact** (CV score trước → sau); M2 đo bằng **relevance + evidence** (file:line, log excerpt). Mọi finding M2 BẮT BUỘC kèm evidence — không evidence = không được ghi vào report (nguồn dòng 601, 4486). `[SRC]`

---

## §4. DYNAMIC ARTIFACT CHAIN — BẢN CHẤT ĐẶC QUYẾT CỦA RESEARCH TEAM

`[TB-10 §4 ← nguồn dòng 4134–4168]` `[SRC — box giữ cấu trúc nguyên bản]`

```
┌──────────────────────────────────────────────────────────────┐
│  DYNAMIC ARTIFACT CHAIN — RESEARCH TEAM ĐẶC QUYẾT           │
│                                                               │
│  Code Team: Code đã tồn tại → Location Map tĩnh              │
│  Research Team: Mỗi bước TẠO artifact mới → Map động        │
│                                                               │
│  Part 1 (EDA / M2: Audit):                                    │
│  M1: raw_data ──▶ eda_notebooks ──▶ insights.md              │
│  M2: source_code ──▶ audit_report ──▶ findings.md            │
│                                                               │
│  Part 2 (Feature Engineering / M2: Diagnose):                │
│  M1: raw_data + insights ──▶ features_pipeline ──▶ feat_data │
│  M2: findings ──▶ root_cause_report ──▶ evidence_map         │
│  MỚI (M2): root_cause_report, evidence_map                   │
│                                                               │
│  Part 3 (Model Building / M2: Design):                        │
│  M1: feat_data ──▶ trained_models ──▶ cv_results ──▶ preds   │
│  M2: evidence ──▶ options_design ──▶ POC (Workspace)         │
│                                                               │
│  Part 4 (Ensemble & Submit / M2: Propose):                    │
│  M1: preds + trained_models ──▶ ensemble ──▶ submission.csv  │
│  M2: options + POC ──▶ PROPOSAL ──▶ SELF-DIRECTION           │
│                                                               │
│  NGUYÊN TẮC QUAN TRỌNG:                                      │
│  ├── Mỗi G phải UPDATE Artifact Map khi tạo artifact mới      │
│  ├── Artifacts cũ KHÔNG bị xóa — giữ cho audit/reproduce     │
│  ├── Artifact Map phải tracking FULL chain                   │
│  │   M1: từ raw_data → submission                           │
│  │   M2: từ source_code → PROPOSAL                          │
│  └── Nếu pivot → Artifact Map giúp biết quay lại từ đâu       │
└──────────────────────────────────────────────────────────────┘
```

5 quy tắc vận hành suy từ nguyên tắc trên `[EXT — không mâu thuẫn box nguồn]`:

| # | Quy tắc | Vì sao |
|---|---|---|
| D1 | Mỗi artifact mới → **entry MỚI** (append cuối bảng chain), KHÔNG ghi đè entry cũ | Map là lịch sử — G sau cần biết artifact từng tồn tại + kết quả từng phiên bản |
| D2 | Artifact cũ bị thay thế → giữ nguyên entry, đánh dấu `superseded` + trỏ entry thay thế | "giữ cho audit/reproduce" (nguồn) — không mất khả năng truy vết |
| D3 | Map tracking FULL chain kể cả nhánh FAIL (`❌ Worsen`, `❌ Removed`) | Failure là dữ liệu nghiên cứu — tránh lặp hướng đã sai |
| D4 | Chain M2 phân biệt 2 nguồn: `LIVE:` (đọc từ Live System) vs `WS:` (tạo/chỉnh trong Workspace) | Evidence lấy ở Live — nguồn thật; POC/report tạo ở Workspace (TB-02) |
| D5 | POC (M2) luôn ở Workspace — entry đánh dấu rõ `WS:` + "KHÔNG áp lên Live" | M2 chỉ chẩn đoán + đề xuất; áp sau khi Proposal APPROVED |

`[EXT]` **Pivot workflow dùng map:** khi KING DECIDE = PIVOT → KING đọc lại map → xác định artifact cuối cùng còn VALID theo Research Protocol mới → part mới bắt đầu TỪ artifact đó (không quay về raw_data) → entry part cũ giữ nguyên + ghi nhãn `pivot-point` tại entry của artifact cuối VALID (quyết định tương ứng được ghi vào Decision Log — TB-06 §13). Đây chính là ý "Map giúp biết quay lại từ đâu" của nguồn dòng 4166.

---

## §5. CHIẾN LƯỢC ĐỌC THEO GROUP — AI ĐỌC GÌ, THEO CHIẾN LƯỢC NÀO

`[TB-10 §5 ← nguồn dòng 3986–4043, 4235–4284]` `[SRC]`

### 5.1 LISMA (G2) — đọc THEO LEAKAGE/BUG LOCATIONS (M1) / SUSPECT LOCATIONS (M2)

| Khía cạnh | M1 — Kaggle | M2 — System Research |
|---|---|---|
| Đọc | data flow, leakage paths, logic flow, edge cases | stack traces, log warnings, error paths, fail-open paths, config mismatch |
| Tìm | data leakage, logic bugs, incorrect CV, target leakage in features, overfitting signals | root cause, integration issues, config bugs |
| Sửa | làm pipeline **CHẠY ĐÚNG + AN TOÀN** (sửa trực tiếp) | **chẩn đoán + đề xuất fix trong proposal** — KHÔNG apply |
| Chiến lược đọc | theo Leakage/Bug Locations từ Artifact Map → chỉ đọc artifacts có issues → focus data flow: fit/transform order → check train/test split trước mọi transform | theo Suspect Locations từ map → **check error paths TRƯỚC happy paths** |
| Token | ~4–8K (selective reading) | ~4–8K |
| Priority #1 | **DATA LEAKAGE** | **SYSTEM SAFETY** |

### 5.2 HAN (G3) — đọc THEO METRIC IMPACT CHAIN (M1) / IMPACT CHAIN (M2)

| Khía cạnh | M1 — Kaggle | M2 — System Research |
|---|---|---|
| Đọc | feature importance, model behavior, CV strategy, pipeline efficiency, ensemble potential | component → dependencies → user-facing effect |
| Tìm | unnecessary features, suboptimal hyperparams, improvement opportunities, redundancy, feature interaction opportunities | upgrade opportunities, pattern áp dụng được |
| Tối ưu | làm pipeline **CHẠY TỐT NHẤT (metric)** | proposal items + verification plan |
| Chiến lược đọc | theo Metric Impact Chain: đọc feature_importance.csv → xác định top features; model training logs → hiểu behavior; CV strategy → verify trustworthiness; artifact chain → tìm optimization opportunities | theo Impact Chain: đọc theo chuỗi component → dependencies → user-facing effect để tìm **điểm đòn bẩy** |
| Token | ~6–10K (wider reading, nhưng vẫn selective) | ~6–10K |
| Priority #1 | **METRIC IMPROVEMENT** | **ĐÒN BẨY HỆ THỐNG** |

### 5.3 Cùng 1 artifact — 2 lối đọc khác nhau `[SRC dòng 4030–4041]`

| Artifact | G2 (LISMA) đọc thấy | G3 (HAN) đọc thấy |
|---|---|---|
| target_encoding.py | "Fit trên toàn dataset → Leak!" | "5-fold encoding stable hơn" |
| feature_importance.csv | "Có feature nào leak??" | "Top-60 đủ, 120 bottom xóa" |
| dev.log (M2) | "121s request = retry path lỗi" | "6.2s sau config = baseline mới" |

> G2: **SỬA LỖI AN TOÀN** (safety fix) / M2: **CHẨN ĐOÁN ĐÚNG** — G3: **TỐI ƯU METRIC** (metric improvement) / M2: **ĐỀ XUẤT TỐT**. `[SRC dòng 4040–4041]`

### 5.4 KING (TL) — đọc CHỈ Worklog + Artifact Map, KHÔNG đọc code

- TL **KHÔNG đọc code trực tiếp** — chỉ 2 ngoại lệ: **ESCALATE**, hoặc **claim thiếu evidence cần verify** (đối chiếu TB-06: bảng "TL đọc code khi nào?" 8 dòng + TL CODE READING PRINCIPLES). `[SRC dòng 4270–4275]`
- TL dựa vào map để hiểu artifact chain; dùng **metric journey (M1) / evidence map (M2)** để quyết định **PIVOT/CONTINUE** — không đoán mò theo cảm tính.
- Lớp 1 (Research Protocol) do chính TL tạo khi DECOMPOSE → khi verify, TL so kết quả trong map với Protocol mình đã viết.

### 5.5 SIVIL / BELI (G1) — đọc map từ group/part trước

- Quy tắc 2 (§5.6) áp cho **MỌI G**, gồm cả G1: khi BẮT ĐẦU part → đọc Artifact Map **TRƯỚC** khi đọc code/notebooks/logs; chỉ đọc artifacts đánh dấu cần đọc; bỏ qua artifacts đánh dấu bỏ qua. `[SRC dòng 4249–4253]`
- Thực tế M1: BELI làm Part 2 (Feature Engineering) đọc `insights.md` + EDA notebooks do Part 1 của chính G1-SA tạo (ví dụ full chain §6.1 — dòng 6: "insights.md | G1-SIVIL | Input cho G1-BELI").
- Thực tế M2: part sau tiêu thụ artifact part trước — Part 2 (Diagnose) đọc `findings.md` từ Part 1 (Audit); Part 3 (Design) đọc `evidence_map` từ Part 2; Part 4 đọc `options + POC`. `[SRC dòng 4143–4158]`

### 5.6 6 quy tắc bắt buộc cho tất cả G agents `[SRC dòng 4237–4283 — đủ 6 điều]`

| # | Quy tắc | Chi tiết bắt buộc |
|---|---|---|
| 1 | Mỗi G khi **HOÀN THÀNH** → PHẢI ghi Research Artifact Map | chỉ rõ: artifact nào cần đọc / bỏ qua · metric impact (M1) / relevance + evidence (M2) · dependencies · reading strategy ưu tiên cho G sau · hypothesis confirmed/rejected/pending |
| 2 | Mỗi G khi **BẮT ĐẦU** → PHẢI đọc Artifact Map | đọc map TRƯỚC code/nb/logs · chỉ đọc artifacts ✅ · bỏ qua ❌ · theo thứ tự ưu tiên 🔴 → 🟠 → 🟡 |
| 3 | G2 đọc theo Leakage/Bug Locations (M1) / Suspect Locations (M2) | focus artifacts có issues, data flow, fit/transform · chiến lược: selective, safety-first · Priority #1: DATA LEAKAGE / SYSTEM SAFETY |
| 4 | G3 đọc theo Metric Impact Chain (M1) / Impact Chain (M2) | focus feature importance, model behavior, CV strategy · chiến lược: wider, metric-driven · Priority #1: METRIC / ĐÒN BẨY HỆ THỐNG |
| 5 | TL đọc chỉ Worklog + Artifact Map | KHÔNG đọc code trừ ESCALATE / claim thiếu evidence cần verify · dựa vào map + metric journey / evidence map để DECIDE |
| 6 | Mỗi artifact mới → **UPDATE MAP NGAY** | dynamic chain · map tracking FULL chain (M1: raw_data → submission; M2: source_code → PROPOSAL → SELF-DIRECTION) · pivot → map cho biết quay lại từ đâu |

---

## §6. VÍ DỤ M1 — RESEARCH ARTIFACT MAP FULL CHAIN QUA 3 GROUPS (HOUSE PRICES)

`[TB-10 §6 ← nguồn dòng 4045–4132, 4170–4212]` `[SRC — giữ cấu trúc + số liệu nguyên văn]`

### 6.1 Complete Artifact Chain — map sau khi G3 xong `[SRC dòng 4175–4211]`

| # | Artifact | Created By | Type | Metric Impact | Status |
|---|---|---|---|---|---|
| 1 | train.csv | TL | Raw Data | — | ✅ Source |
| 2 | test.csv | TL | Raw Data | — | ✅ Source |
| 3 | eda_missing.ipynb | G1-SA01 | Notebook | — | ✅ Info only |
| 4 | eda_distribution.ipynb | G1-SA02 | Notebook | — | ✅ Info only |
| 5 | eda_correlation.ipynb | G1-SA03 | Notebook | — | ✅ Info only |
| 6 | insights.md | G1-SIVIL | Document | — | ✅ Input cho G1-BELI |
| 7 | missing_handler.py | G1-BELI | Code | CV: 0.134→0.132 | ✅ Done |
| 8 | log_transform.py | G1-BELI | Code | CV: 0.132→0.131 | ✅ Fixed by G2 |
| 9 | target_encoding.py | G1-BELI | Code | CV: 0.131→0.125 | ✅ Fixed by G2, Optimized by G3 |
| 10 | interaction_feats.py | G1-BELI | Code | CV: 0.125→0.124 | ✅ Done |
| 11 | domain_feats.py | G1-BELI | Code | CV: 0.124→0.125 | ❌ Removed by G3 |
| 12 | feature_importance.csv | G1-BELI | Data | — | ✅ Updated by G3 |
| 13 | train_feat.csv | G1→G2 | Dataset | — | ✅ Clean |
| 14 | test_feat.csv | G1→G2 | Dataset | — | ✅ Clean |
| 15 | selected_features.txt | G3 | Config | CV: 180→72 feats | ✅ G3 output |
| 16 | pipeline_v2.py | G3 | Code | Runtime: 45→22 min | ✅ G3 output |

#### Metric Journey:
| Stage | CV Score | Features | Runtime | Key Event |
|---|---|---|---|---|
| Baseline | 0.134 | 79 | — | Raw features |
| After G1 | 0.124 | 180 | 45 min | +101 features |
| After G2 | 0.127 | 180 | 45 min | Fixed leakage (honest score) |
| After G3 | 0.121 | 72 | 22 min | Feature selection + optimization |

#### Dependencies (cho Part 3 — Model Building):
| Artifact | Depends On | Part 3 cần? |
|---|---|---|
| train_feat.csv | missing_handler, log_transform, target_encoding | ✅ Primary input |
| test_feat.csv | Same as above | ✅ Primary input |
| selected_features.txt | feature_importance.csv | ✅ Feature list |
| pipeline_v2.py | All feature code | ✅ Apply transforms |
| feature_importance.csv | Trained model | ✅ Reference |
| domain_feats.py | — | ❌ Removed |

> **Điểm giảng dạy:** CV 0.124 (sau G1) → 0.127 (sau G2) là score "tệ đi" nhưng là **honest score** — sau khi fix leakage. Map ghi rõ điều này để KING không hiểu nhầm G2 làm kết quả tệ; verdict ở Metric Impact Summary (§3.4) luôn là câu chuyện 2 chiều. `[SRC số liệu + EXT diễn giải]`

### 6.2 Directed Reading thực tế — G2 (LISMA) sửa Data Leakage `[SRC dòng 4045–4131 — rút gọn, giữ đủ 4 bước + số liệu]`

**Bước 1 — đọc Artifact Map (từ G1):** ❌ bỏ qua 4 artifacts (train_clean.csv, test_clean.csv, missing_handler.py, interaction_feats.py); ✅ cần đọc 3: target_encoding.py (🔴 CRITICAL — Data Leak), domain_feats.py (🟠 HIGH — Worsen metric), log_transform.py (🟡 MEDIUM — Edge case); 📊 nên đọc 1: feature_importance.csv (understand ranking). Ưu tiên: 🔴 trước → 🟠 → 🟡.

**Bước 2 — đọc code selective (3 files, tổng ~570 tokens):**

| File | Bug tìm thấy | Fix |
|---|---|---|
| target_encoding.py | `groupby(col)[target].mean()` dùng TOÀN BỘ dataset (TRAIN + TEST) → **CRITICAL — Data Leakage** | Split trước, fit trên train only |
| domain_feats.py | `TotalBsmtSF` có NaN → `TotalSF` NaN → **HIGH — NaN propagation** | fillna trước khi tạo domain features |
| log_transform.py | `np.log(0)` = -inf → **MEDIUM — Edge case** | `np.log1p()` hoặc clip + shift |

**Bước 3 — đọc Research Protocol (chỉ phần Feature Engineering, ~200 tokens):** "MUST: Fit trên train only, transform trên test" → xác nhận target_encoding.py **VIOLATES** constraint; "AVOID: One-hot encoding cho features > 10 cats"; "SHOULD: Log transform skewed features".

**Bước 4 — fix + verify + update map cho G3:**
- Fix 3 bug theo severity: CRITICAL → HIGH → MEDIUM; verify từng fix bằng CV score.
- **Before fix: CV 0.125 (leaked → optimistic) — After fix: CV 0.127 (honest score — lower but real).**

| Artifact (G2 cập nhật) | Status | G3 nên đọc? |
|---|---|---|
| target_encoding.py | ✅ Fixed | ✅ Đọc (optimize — K-Fold) |
| domain_feats.py | ✅ Fixed | ✅ Đọc (review usefulness) |
| log_transform.py | ✅ Fixed | ❌ Bỏ qua |
| feature_importance.csv | ⚠️ Stale | ✅ Re-compute |

- G3 Reading Strategy do G2 để lại: ✅ đọc feature_importance.csv (feature selection) + target_encoding.py (K-Fold encoding) + domain_feats.py (review usefulness) + interaction_feats.py (check redundancy); ❌ bỏ qua missing_handler.py, log_transform.py.
- **TỔNG TOKEN G2 sử dụng: ~5–6K** — thay vì 10–12K nếu đọc toàn bộ artifacts.

---

## §7. VÍ DỤ M2 — AUDIT MEMORY + CASE "CHAT TMO CHẬM 121S"

`[TB-10 §7 ← nguồn dòng 3958–3984 (map Memory Audit), 4428–4511 (workflow chat 121s)]` `[SRC + EXT minh họa]`

### 7.1 Map Memory Audit (nguồn) — phân tích cấu trúc

Map M2 ở §3.5 (G1 audit memory) minh họa các quy ước M2: `relevance` = "Core target" cho file source thuộc phạm vi audit, "Evidence source" cho log, "Baseline" cho health-check output, "G1 output" cho report do G tạo; Issues luôn gắn Location cụ thể (`neo4j.ts Line 45`); Findings & Evidence bắt buộc kèm evidence (`dev.log + key-pool retry path`, `Qdrant 0/52 docs`).

### 7.2 Case "Hệ thống chat của TMO chậm" — Research Artifact Map qua 4 parts `[EXT — map dựng theo workflow nguồn 4430–4511, toàn bộ số liệu nguyên văn]`

**Bối cảnh `[SRC]`:** user yêu cầu "Hệ thống chat của TMO chậm, nghiên cứu và đề xuất khắc phục" → KING CLASSIFY: signals M2 (hệ thống, TMO, chậm, đề xuất khắc phục) → mission M2 (confidence cao) → TRIAGE: Phạm vi 3 (LLM pipeline + key pool + fail-open paths) + Suy luận 3 (cần đọc logs + code tìm root cause) + Rủi ro 2 (ảnh hưởng trải nghiệm user) = **8 → COMPLEX (Tier 3)** → DECOMPOSE 4 parts: Part 1 Audit (COMPLEX) · Part 2 Root cause (MEDIUM) · Part 3 Options (COMPLEX) · Part 4 Proposal & Verification Plan (MEDIUM).

#### Artifact Map — Part 1 (Audit hiện trạng — G1: SIVIL dispatch 6 sub-agents):

| Artifact | Type | Relevance | Status | Ai đọc tiếp |
|---|---|---|---|---|
| LIVE: dev.log — latency patterns (phát hiện requests 121s) | log | evidence-source | evidence-attached | SA-01 scan → LISMA (warnings) → HAN (baseline mới) |
| LIVE: API route /api/query — query pipeline | source | core-target | audited | SA-02 → LISMA (error paths) |
| LIVE: service-key-pool — LLM key rotation logic | source | core-target | audited | SA-03 → LISMA (retry path) → HAN (impact chain) |
| LIVE: LLM client — retry + timeout behavior | source | core-target | audited | SA-04 → LISMA |
| LIVE: neo4j/qdrant clients — connection handling | source | context | audited | SA-05 |
| LIVE: health check — service status hiện tại | log | baseline | evidence-attached | SA-06 |
| WS: audit-report.md (BELI tổng hợp) | report | output | evidence-attached | LISMA + KING (CP1) |

Audit Report (BELI) tóm tắt `[SRC nguyên văn]`: "Chat request mất 121s khi LLM key trả 401 → pipeline retry lần lượt qua các key không hợp lệ rồi mới fail-open. Không có fail-fast, không có timeout ngắn, key pool không có health check."

#### Artifact Map — Part 2 (Chẩn đoán root cause — LISMA đọc theo Suspect Locations):

| Artifact | Type | Relevance | Status | Ghi chú |
|---|---|---|---|---|
| WS: root-cause-report.md | report | output | evidence-attached | 3 root causes `[SRC]`: (1) retry mù quáng khi 401 — 4xx không retry được · (2) key pool không health check · (3) không timeout cho LLM calls. Đề xuất: fail-fast + timeout + key health check. KHÔNG sửa code TMO |
| WS: evidence-map.md | report | output | evidence-attached | mỗi root cause kèm file:line + log excerpt |
| LIVE: key-pool retry path | source | core-target | evidence-attached | LISMA verify lỗi (logs) ↔ code |

#### Artifact Map — Part 3 (Thiết kế options — HAN đọc theo Impact Chain: key pool → LLM calls → user latency):

| Artifact | Type | Relevance | Status | Ghi chú |
|---|---|---|---|---|
| WS: options-design.md | report | output | evidence-attached | `[SRC]`: Option A — fail-fast + timeout (effort S, tác động lớn) · Option B — key health check + circuit breaker (effort M) · Option C — response cache (effort L, cần benchmark). Recommendation: A+B ngay; C để khi có benchmark. Mỗi option kèm Verification Plan (deferred) |
| WS: POC fail-fast patch | poc | core-target | audited | POC minh họa chạy trong **Workspace** — KHÔNG áp lên Live (xem D5 §4) |

#### Artifact Map — Part 4 (Proposal & Verification Plan — KING FINALIZE):

| Artifact | Type | Relevance | Status | Ghi chú |
|---|---|---|---|---|
| WS: PROPOSAL (P-YYYYMMDD-NNN) | report | output | evidence-attached | `[SRC 4494–4508]`: Problem = chat latency 121s khi LLM key fail (evidence: dev.log + key-pool code path) · Root Cause = retry mù + không health check + không timeout · Options A/B/C · Recommendation A+B — Expected impact: 121s → < 10s · Risk & Rollback: config-level change, rollback = revert env · Verification: (a) NGAY — so latency log trước/sau + manual test "gửi 1 câu hỏi khi 1 key cố tình sai"; (b) DEFERRED — benchmark A/B (p50/p95 chat latency, acceptance p95 < 10s) → Route thẳng SELF-DIRECTION, Status SUBMITTED |

> **Chain M2 của case này:** `source_code (dev.log + 5 module) → audit_report → findings/root_cause_report + evidence_map → options_design + POC (Workspace) → PROPOSAL → SELF-DIRECTION` — đúng khung Dynamic Artifact Chain §4. KING dùng map tại 3 checkpoint `[SRC 4485–4488]`: CP1 "Audit đủ evidence? (mỗi finding có file:line + log)" · CP2 "Root cause khớp code ↔ logs? (LISMA verify)" · CP3 "Mỗi option có trade-offs + verification plan?". Toàn bộ mission M2 KHÔNG sửa file nào của TMO — output duy nhất là Proposal; implementation + benchmark là thao tác riêng sau APPROVED. `[SRC dòng 4511]`

---

## §8. [EXT] MODULE MAP TMO CHO AUDIT M2 — BẢNG GỢI Ý THƯ MỤC NGUỒN

`[TB-10 §8 ← mở rộng từ nguồn dòng 543–558 (Module Map 8 module + "đọc gì" + nguồn được phép đọc M2) + quan sát repo TMO tại worklog Task 1–3]` `[EXT + Q]`

> ⚠️ **CẢNH BÁO — BẢNG GỢI Ý:** cột Module + "Đọc gì" lấy từ nguồn (dòng 547–556); cột **"Vị trí gợi ý"** do TB-10 bổ sung từ quan sát repo Theopusflashlite v2.0.0 (Next.js 16 + Prisma + PM2 + Qdrant) ghi tại worklog Task 1–3. Đường dẫn cụ thể **CẦN XÁC MINH LẠI khi cài cơ chế research team vào TMO thật** — cấu trúc repo có thể đổi giữa các phiên bản (Q5 §13).

| Module | Đọc gì (nguồn) | Vị trí gợi ý `[EXT + Q]` | Artifact type hay gặp trong map |
|---|---|---|---|
| SA-01 Memory Architecture | memory system — Qdrant/Neo4j/SQLite coordination, embedding pipeline | `src/lib/` (memory, qdrant-client, neo4j) + `src/app/api/` | source |
| SA-02 Execution Pipeline | API routes, query pipeline, workflow thực thi | `src/app/api/**` (vd route /api/query) | source |
| SA-03 Thinking Process | agent instructions, reasoning strategy, research protocol | `src/lib/` (instructions/prompts) + docs trong repo | source, doc |
| SA-04 Tools & Agents Roster | MCP tools, agent configs, model-to-role mapping | MCP configs + agent configs trong repo | config |
| SA-05 UI/UX | app pages, components, UX flow | `src/app/**` (pages) + `src/components/**` | ui, source |
| SA-06 Services Integration | R2, Supabase, Neo4j, Qdrant, LLM key pool | `src/lib/` + `src/app/api/` (service-key-pool) | source |
| SA-07 Performance | dev.log, PM2 logs, latency measurements, token usage | log runtime theo `ecosystem.config.cjs` (dev.log) + PM2 logs | log |
| SA-08 Config & Deployment | .env, ecosystem config, health check | `.env.example` + `ecosystem.config.cjs` + health check API | config, log |

**Nguồn được phép đọc (M2)** `[SRC dòng 558]`: source code, README, docs, `.env.example`, dev.log, PM2 logs, health check API. **KHÔNG được phép** `[SRC dòng 559]`: sửa bất kỳ file nào của TMO — mọi thay đổi chỉ nằm trong PROPOSAL.

`[EXT]` Cách dùng bảng này khi tạo map M2: mỗi sub-agent SA của SIVIL nhận 1 module → các file nó đọc trở thành entry `LIVE:` với relevance theo bảng → SIVIL tổng hợp thành khối Artifact Chain (Q6: SA có ghi entry riêng hay chỉ SIVIL tổng hợp).

---

## §9. [EXT] QUY ƯỚC STATUS ARTIFACT M2 — 5 TRẠNG THÁI

`[TB-10 §9 ← chuẩn hóa các status rời rạc trong ví dụ nguồn (✅ Audited / ✅ Scanned / ✅ Captured / ✅ Done — dòng 3966–3971)]` `[EXT + Q]`

| Status | Ý nghĩa | Ai đặt | Điều kiện vào trạng thái |
|---|---|---|---|
| `planned` | artifact nằm trong kế hoạch audit nhưng chưa tồn tại / chưa ai đọc | SIVIL khi decompose; bất kỳ G khi ghi kế hoạch | entry được tạo TRƯỚC khi artifact tồn tại (E1 §11) |
| `reading` | đang được 1 G đọc / khảo sát | G đang đọc | bắt đầu đọc file |
| `audited` | đã đọc xong, ghi nhận cấu trúc / vấn đề | G đọc | kết thúc khảo sát 1 file |
| `evidence-attached` | đã có finding trỏ vào artifact (file:line / log excerpt) | G tìm thấy finding | finding được ghi vào Findings & Evidence |
| `superseded` | bị entry thay thế (file đổi / audit lại) | entry mới cùng `file` | quy tắc D2 §4 |

Quy tắc chuyển trạng thái:

```
planned ──▶ reading ──▶ audited ──▶ evidence-attached
               │                        │
               │ (dừng giữa chừng:      ▼
               │  giữ `reading` +     superseded
               │  note lý do)        (khi có entry thay thế)
```

- Mọi chuyển trạng thái theo kiểu **append-only**: entry cũ giữ status cũ; thông tin "đã chuyển" nằm ở entry mới hoặc dòng update ghi kèm (D1/D2 §4).
- Ánh xạ status trong ví dụ nguồn → quy ước 5 mức `[EXT]`: `✅ Scanned` (log) → `audited` · `✅ Captured` (baseline) → `evidence-attached` · `✅ Done` (report của G) → `evidence-attached` (report luôn gắn findings) · các dấu mô tả `⚠️` (Done but needs attention), `❌ Worsen`, `❌ Removed` giữ nguyên ngữ nghĩa mô tả, không ép về 5 mức.
- `[Q1]` Có cần thêm trạng thái `stale` (như `feature_importance.csv ⚠️ Stale` ở ví dụ M1 — dòng 4120) cho M2, hay gộp vào `superseded`?

---

## §10. [EXT] QUY TRÌNH CẬP NHẬT MAP — AI GHI, KHI NÀO GHI, GHI GÌ

`[TB-10 §10 ← hợp thức hóa quy tắc 1 + 6 của nguồn (dòng 4242–4247, 4277–4282) + cấu trúc 2 ví dụ nguồn]` `[EXT]`

### 10.1 Ai ghi

| Ai | Ghi gì |
|---|---|
| Mỗi G (SIVIL/BELI/LISMA/HAN) | map cho part mình vừa hoàn thành — đủ 5 khối (§3.3). Sub-agents của SIVIL: findings của SA được SIVIL TỔNG HỢP thành 1 map duy nhất của G1 `[Q6]` |
| TL (KING) | KHÔNG ghi artifact research; ghi entry `planned` khi DECOMPOSE sinh kế hoạch audit (nếu muốn khóa kế hoạch đọc trước); quyết định pivot ghi vào Decision Log (TB-06 §13) — phần map do G nhận part mới cập nhật |

### 10.2 Khi nào ghi

- **NGAY khi tạo artifact** (quy tắc 6 — nguồn dòng 4277): mỗi batch code/report/POC/dataset hoàn tất → append entry ngay, KHÔNG đợi hết part.
- **Bắt buộc tại mốc handoff part/group** — map là khối bắt buộc của worklog handoff (TB-09); handoff thiếu map = vi phạm hợp đồng 7 dòng giữa các khối.
- **Sau khi verify** (Bước 4 §1.3): cập nhật status finding / metric trước-sau ngay khi có kết quả CV hoặc xác minh evidence.

### 10.3 Ghi gì — entry MỚI, KHÔNG sửa entry cũ (chỉ đánh dấu superseded)

| Tình huống | Cách làm ĐÚNG | Cách làm SAI |
|---|---|---|
| Tạo artifact mới | append entry mới cuối bảng chain | ghi đè entry cũ |
| File đổi nội dung (phiên bản v2) | entry mới + entry cũ đánh `superseded` + trỏ `→ entry mới` | xóa entry cũ |
| G sau sửa artifact của G trước (G2 fix bug G1) | M1: cập nhật CỘT STATUS entry gốc theo quy ước nguồn ("✅ Fixed by G2") `[SRC ví dụ §6.1]`; M2: entry mới nếu FILE thay đổi — `[Q3]` | xóa lịch sử entry |
| Finding mới trỏ vào artifact cũ | giữ nguyên entry, nâng status lên `evidence-attached` (M2) | tạo entry trùng `file` |
| Artifact bỏ (removed) | giữ entry + status `❌ Removed` (M1) / `superseded` (M2) — KHÔNG xóa | xóa entry |

> Nguồn cho phép cập nhật cột Status của entry gốc (ví dụ M1: "✅ Fixed by G2", "✅ Updated by G3", "❌ Removed by G3" — §6.1); TB-10 áp nguyên quy ước đó cho M1. Riêng M2 theo dõi bằng entry mới + `superseded` khi FILE đổi (không phải khi status đổi) — vì file M2 có 2 bản LIVE/WS cần truy vết riêng (D4). `[Q3]`

### 10.4 Template entry nhanh (dùng khi append)

```yaml
artifact: <tên file M1 / đường dẫn file M2 (kèm LIVE: hoặc WS: ở cột nguồn)>
type: <M1: data|feature|code|model|preds|submit — M2: source|log|report|config|ui|doc|poc>
created_by: <agent hoặc part>
metric_impact: <M1: CV before→after hoặc Runtime hoặc —>
relevance: <M2: core-target|evidence-source|context|baseline|output>
status: <M2: planned|reading|audited|evidence-attached|superseded>
read_next: <G sau nên đọc? ✅/❌ + vùng đọc: ALL / Line 18 / ranking / collections...>
depends_on: <artifact khác trong chain>
hypothesis: <confirmed / rejected / pending — kèm id hypothesis của Protocol>
```

---

## §11. ERROR & EDGE CASES

`[TB-10 §11 ← suy từ nguyên tắc nguồn + chuẩn TB-00 §4 (N+2) — mở rộng không mâu thuẫn]` `[EXT]`

| # | Tình huống | Phát hiện thế nào | Xử lý |
|---|---|---|---|
| E1 | **Artifact thiếu (chưa tồn tại)** — kế hoạch part đòi artifact chưa ai tạo | map thiếu entry cho artifact được `depends_on` trỏ tới | ghi entry `planned` + đánh dấu blocker trong map; nếu artifact thuộc trách nhiệm part/group TRƯỚC → coi như chain đứt → E2 |
| E2 | **Chain đứt** — thiếu artifact trung gian (vd Part 3 cần `train_feat.csv` mà map dừng ở `insights.md`) | đối chiếu bảng Dependencies vs Artifact Chain ở Bước 1 (đọc map) | G hiện KHÔNG tự bịa artifact thiếu → **ESCALATE KING**; KING DECIDE: giao lại part thiếu (task .md mini) hoặc pivot từ artifact cuối VALID |
| E3 | **Map quá lớn** (nhiều part × nhiều SA × nhiều file — chain hàng trăm entry) | đếm entry khi Bước 1 | rank theo relevance + severity: chỉ đọc sâu top (core-target + 🔴); phần còn lại mức scan-qua; Reading Strategy phải phản ánh ranking — `[Q2]` ngưỡng chính thức (đề xuất > 60 entries) |
| E4 | **Evidence conflict Live ↔ Workspace** — code Live khác code Workspace cùng 1 file | so 2 bản khi verify (POC chạy ở Workspace nhưng evidence lấy ở Live) | **ưu tiên Live System** — là nguồn thật đang chạy; ghi chú lệch version vào entry (D4); Workspace lệch nhiều → ESCALATE để đồng bộ lại clone |
| E5 | **Map không cập nhật sau pivot** — KING đã pivot nhưng map không có nhãn pivot-point | Metric Journey lệch với Research Protocol hiện hành | KING ghi pivot vào Decision Log; G nhận part mới bổ sung `pivot-point` tại artifact cuối VALID ngay khi bắt đầu (§4) |
| E6 | **Hypothesis status thiếu** — map không nói artifact nào confirmed/rejected/pending | checklist AC-8 (§12) | thiếu = thiếu field bắt buộc của khối map (quy tắc 1) → trả về G ghi map bổ sung TRƯỚC khi G sau bắt đầu đọc |
| E7 | **Artifact stale** — artifact mô tả pipeline đã đổi (vd feature_importance.csv sau khi fix leak) | map đánh `⚠️ Stale` như ví dụ nguồn dòng 4120 | G tạo đánh dấu "re-compute" trong Reading Strategy; KHÔNG dùng stale làm input cho quyết định — `[Q7]` KING có thể giao task mini re-compute qua DECIDE |
| E8 | **M2 evidence chỉ tồn tại ở Workspace** (không tái hiện được ở Live) | finding không trỏ được file:line/log ở Live | hạ độ tin cậy finding; tìm evidence Live tương đương (log runtime, health check); nếu không có → finding chỉ vào Proposal kèm nhãn độ tin cậy thấp |
| E9 | **2 sub-agents mâu thuẫn về cùng 1 artifact** (cùng `file`, severity/kết luận khác) | 2 findings trỏ cùng entry | SIVIL dùng protocol mâu thuẫn SA của TB-03 §5: điều tra arbitrator → vẫn mâu thuẫn → ESCALATE KING kèm 2 interpretation |
| E10 | **Workspace chưa mở khi M2 cần POC** — user chưa mở bản clone, part Design/Propose cần chạy POC | map có entry POC `WS:` (D5 §4) nhưng không có nơi chạy; liên quan E4 (bản Live ↔ WS) + E8 | evidence vẫn chạy (đọc Live System); POC hoãn + Proposal đánh cờ `POC-NEEDS-WORKSPACE` (quy ước TB-02 §6; xử lý chi tiết: TB-06 §14 E7 + TB-07 §9 E7) |

---

## §12. ACCEPTANCE CRITERIA — CHECKLIST VERIFY

`[TB-10 §12 ← chuẩn TB-00 §4 (N+3)]` `[EXT]`

- [ ] **AC-1** Mọi worklog handoff G → G sau đều có khối Research Artifact Map đủ 5 phần (§3.3: chain, issues, metric-impact/findings-evidence, reading strategy, hypothesis+dependencies).
- [ ] **AC-2** Format ID đúng TB-00 §1.4: M1 `artifact:type:metric_impact` (vd `target_encoding:feature:CV -0.006`); M2 `file:type:relevance:status` (vd `src/lib/memory.ts:source:core-target:audited`).
- [ ] **AC-3** Mọi entry M1 có metric impact rõ (hoặc `—`); mọi entry M2 có relevance + status thuộc 5 mức §9.
- [ ] **AC-4** Reading Strategy cho G sau có thứ tự ưu tiên 🔴 → 🟠 → 🟡 VÀ danh sách "KHÔNG cần đọc".
- [ ] **AC-5** Mỗi G khi bắt đầu part: đọc map TRƯỚC code (Bước 1) — worklog của G đó ghi nhận "đã đọc map của G trước".
- [ ] **AC-6** LISMA đọc theo Leakage/Bug (M1) / Suspect Locations (M2) — error paths trước happy paths; HAN đọc theo Metric Impact Chain / Impact Chain; KING chỉ đọc Worklog + Map (trừ ESCALATE / verify claim thiếu evidence).
- [ ] **AC-7** Token đọc mỗi G nằm trong budget: G2 ~4–8K, G3 ~6–10K, tổng 4 bước ~7–14K (không có G nào đọc toàn bộ artifacts).
- [ ] **AC-8** Map ghi hypothesis status (confirmed/rejected/pending) cho từng artifact thử nghiệm.
- [ ] **AC-9** Artifact cũ KHÔNG bị xóa; thay thế = `superseded` + trỏ entry mới; chain tracking FULL (M1: raw_data → submission; M2: source_code → PROPOSAL).
- [ ] **AC-10** Map tracking cả nhánh FAIL (`❌ Worsen` / `❌ Removed`) — không mất lịch sử thí nghiệm.
- [ ] **AC-11** Mọi finding M2 trong map kèm evidence (file:line / log excerpt) — không evidence = không được ghi (nguồn dòng 601).
- [ ] **AC-12** Entry M2 phân biệt nguồn `LIVE:` vs `WS:`; POC chỉ tồn tại ở `WS:` và map ghi rõ "KHÔNG áp lên Live".
- [ ] **AC-13** Map có bảng Dependencies ("depends on") cho part kế tiếp + mỗi entry mới có trường `depends_on`.
- [ ] **AC-14** E2E đối soát (TB-12): chạy 2 kịch bản House Prices (M1) + chat 121s (M2) — map xuất hiện đủ ở cả 3 mốc handoff G1→G2→G3 + KING đọc được map để chốt CP1/CP2/CP3 và DECIDE.

---

## §13. OPEN QUESTIONS & PHỤ THUỘC

`[TB-10 §13 ← chuẩn TB-00 §4 (N+4)]` `[Q]`

| # | Câu hỏi mở | Ảnh hưởng | Đề xuất mặc định (khi user chưa chốt) |
|---|---|---|---|
| Q1 | Thêm trạng thái `stale` riêng cho artifact M2, hay gộp vào `superseded`? | §9 | gộp vào `superseded` + note "stale, cần re-compute" |
| Q2 | Ngưỡng "map quá lớn" (E3) — bao nhiêu entry thì bắt buộc rank + chỉ đọc sâu top? | §11 E3 | > 60 entries |
| Q3 | M1: cập nhật cột status entry gốc ("Fixed by G2") như ví dụ nguồn, hay cũng chuyển hẳn sang append + superseded cho đồng bộ với M2? | §10.3 | M1 theo ví dụ nguồn (cột status); M2 append + superseded |
| Q4 | Prefix `LIVE:`/`WS:` đặt trong ID dòng hay ở cột riêng trong bảng chain? | §3.2, §7.2 | cột riêng — giữ ID dòng ngắn gọn |
| Q5 | Bảng Module Map §8: ai xác minh đường dẫn trên TMO thật và khi nào (lúc cài đặt research team, hay từng mission M2)? | §8 | kỹ sư triển khai xác minh 1 lần lúc cài + cập nhật bảng khi repo đổi |
| Q6 | Sub-agent của SIVIL có ghi entry trực tiếp vào map hay chỉ SIVIL tổng hợp findings của SAs thành 1 map G1? | §10.1 | SIVIL tổng hợp 1 map duy nhất (tránh trùng lặp entry) |
| Q7 | KING có được giao task mini "re-compute stale artifact" như 1 part đơn giản (SIMPLE/Tier 1)? | §11 E7 | có — qua DECIDE + task .md mini cho G sở hữu artifact |
| Q8 | Map M1 có cần thêm cột Relevance tương đương M2 để G3 rank ưu tiên đọc khi chain dài? | §3 | không — metric impact + severity đã đủ tín hiệu rank |

**Phụ thuộc chéo:** TB-09 (khối map trong worklog schema + handoff) · TB-06 §13 Decision Log (pivot-point) · TB-03 §5 (protocol mâu thuẫn SA — dùng cho E9) · TB-11 (Proposal truy evidence ngược về map) · TB-12 (2 kịch bản E2E đối soát AC-14).

---

## PHỤ LỤC A — TRACEABILITY MATRIX

`[TB-10 Phụ lục A ← chuẩn TB-00 §4]`

| Nguồn (ai-team-workflow.md) | Nội dung nguồn | Section TB-10 | Mức |
|---|---|---|---|
| 3780–3782 | tên section + vấn đề "G2/G3 cần đọc ARTIFACT THẬT" | §0, §1.1 | SRC |
| 3784–3803 | box thông tin worklog cung cấp / không cho biết; "Worklog = BẢN ĐỀ XUẤT, Artifact = THỰC TẾ" | §1.1 | SRC |
| 3805–3835 | Code Location Map vs Research Artifact Map; 2 format ID; 2 chain M1/M2; Artifact → Impact → Action | §1.2, §3.1, §3.2, §4 | SRC |
| 3837–3876 | 3 lớp thông tin (Research Protocol / Worklog + Map / Ground Truth M1+M2); thiếu lớp = làm sai việc | §2 | SRC |
| 3878–3913 | chiến lược Directed Reading 4 bước + token từng bước + tổng 7–14K | §1.3 | SRC |
| 3915–3956 | yêu cầu map trong worklog mỗi G + ví dụ M1 Feature Engineering (chain 8 / issues 3 / metric 5 / strategy 5) | §3.3, §3.4 | SRC |
| 3958–3984 | ví dụ M2 Memory Audit (chain 6 / issues 2 / findings 2) | §3.5, §7.1 | SRC |
| 3986–4043 | G2 vs G3 — chiến lược đọc khác nhau + ví dụ 3 artifact + token 4–8K / 6–10K | §5.1, §5.2, §5.3 | SRC |
| 4045–4131 | ví dụ Directed Reading G2 sửa Data Leakage — 4 bước + update map cho G3 + token 5–6K | §6.2 | SRC |
| 4134–4168 | Dynamic Artifact Chain (Part 1–4 M1/M2 + 5 nguyên tắc quan trọng) | §4 (box nguyên bản) | SRC |
| 4170–4212 | ví dụ full chain 16 artifacts qua 3 groups + Metric Journey + Dependencies | §6.1 | SRC |
| 4214–4233 | bảng so sánh hiệu quả 3 phương pháp đọc (token + chất lượng) | §1.4 | SRC |
| 4235–4284 | 6 quy tắc bắt buộc cho tất cả G agents (ghi map / đọc map / G2 / G3 / TL / update ngay) | §5.4, §5.5, §5.6, §10 | SRC |
| 543–561 | Module Map M2 — 8 module + "đọc gì" + nguồn được phép đọc M2 + KHÔNG được sửa | §8 | SRC (module) + EXT (vị trí đường dẫn) |
| 558–559 | Ranh giới Live System / Workspace cho Lớp 3 M2 — Live = nguồn evidence CHỈ ĐỌC; WS = nơi tạo/chỉnh artifact + POC | §2 | SRC |
| 601, 4486 | "mỗi finding BẮT BUỘC có evidence" + KING verify ở checkpoint | §3.5, §7.2, §11 E8 | SRC |
| 4428–4511 | ví dụ M2 workflow "chat TMO chậm" — triage 8 điểm COMPLEX, 4 parts, 6 SA, 3 root causes, options A/B/C, proposal + SELF-DIRECTION | §7.2 | SRC (workflow + số liệu) + EXT (map dựng) |
| — | field spec 2 format; 5 khối map chuẩn; quy tắc D1–D5 + pivot-point; status 5 mức M2; quy trình cập nhật append-only; E1–E10; AC-1–14; Q1–Q8 | §3, §4, §9, §10, §11, §12, §13 | EXT |
| — | stale/LIVE-WS prefix/ngưỡng map lớn/ai ghi map/Module Map cần xác minh | §8, §9, §11, §13 | Q |

> **Kết thúc TB-10.** File tiếp theo theo build order TB-00 §3: TB-08 (Knowledge Capture) và TB-09 (RWV Loop & Handoff — nơi map "sống" trong worklog schema) → TB-11 → TB-12. Tracker TB-00 §6: đánh TB-10 ✅ khi user duyệt.
