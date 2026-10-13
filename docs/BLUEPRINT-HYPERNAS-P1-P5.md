# BLUEPRINT TRIỂN KHAI HYBRID HYPERNAS P1 → P5 — "PHÒNG THÍ NGHIỆM TÌM KIẾN TRÚC NÃO" CHO TMO

> **Phiên bản:** 0.1 — **DRAFT, CHƯA TRIỂN KHAI — chờ user chốt §8.** Bổ sung cho
> [BLUEPRINT-BRAIN-P1-P5.md](./BLUEPRINT-BRAIN-P1-P5.md) (v0.12, P1→P4 đã hoàn tất):
> sau khi 3 brain A/B/C + editor draft + tab BRAIN 3 phần đã sống, phase tiếp theo
> là **tự động hoá việc LỰA CHỌN kiến trúc** — đúng vai trò *Neural Predictors /
> HyperNAS* trong kho knowledge `SHD_NAS_EVOLUTION_002.TXT` (node `NAS_025
> Hypernetwork` — "mạng nơ-ron phụ trợ sinh trọng số cho mạng mục tiêu"; metric
> `MET_NAS_015 Query Cost`, `MET_NAS_024 Training MSE`) và `SHD_GEN_CAUSAL_HYPER_001.TXT`
> (`ENT_HYP_025 Hypernetworks / Weight-generators`).
>
> **Câu hỏi gốc của user (2026-10-13):** "database có cấu trúc HyperNAS không —
> có thể căn chỉnh thông số loại cấu trúc này không" → điều tra Task 19 (worklog):
> **KHÔNG có** — HyperNAS mới chỉ là khái niệm trong knowledge; engine hiện tại là
> MLP chuỗi học trọng số trực tiếp. User sau đó yêu cầu **review kiến trúc hybrid
> khớp hoàn toàn nền hiện tại + viết blueprint triển khai** (Task 21 — file này).

---

## 0. TÓM TẮT ĐIỀU HÀNH

| Phase | Tên | Mục tiêu một câu | Artifacts | Cờ (mặc định) | Test |
|---|---|---|---|---|---|
| **HN-P1** | Nền search space | Encoding tất định ↔ BrainDraftSpec + bảng `BrainSearchRun(session)` + `BrainSearchCandidate` | `src/lib/brain/search-space.ts` · prisma model 101+102 | — (thuần lib) | r92 |
| **HN-P2** | Vòng search thật | Chạy N ứng viên train + 5-fold CV thật → bảng xếp hạng → **đề xuất** draft (user duyệt — A1 nguyên vẹn) | `src/lib/brain/search.ts` · `POST/GET /api/brain/search` · UI tab "Tìm kiếm" (SECTION 3 tab BRAIN) | `brain_search` (off) | r93 |
| **HN-P3** | HyperNAS predictor | Hypernetwork MLP (tái dùng engine `mlp.ts`) học `(encoding → CV score)` từ lịch sử search → rank ứng viên mới không cần train (giảm Query Cost) | `src/lib/brain/hypernas.ts` · wired vào search loop | `brain_hypernas` (off) | r94 |
| **HN-P4** | *(mở, sau này)* SMASH-style generator | Hypernetwork sinh W tạm cho ứng viên để prefilter rẻ — CHỈ trong giai đoạn search, không thay train thật | `src/lib/brain/smash.ts` (dự kiến) | `brain_smash` (off) | r95 |
| **HN-P5** | *(mở, sau này)* Biên Python/GPU | Đồng bộ với BRAIN-P5 — search không gian lớn hơn (supernet/DARTS) trên GPU | sidecar | — | — |

**Rào cản dữ liệu (thống nhất BRAIN blueprint §2):** search chỉ có ý nghĩa khi brain
**ĐÃ THỨC TỈNH** (đủ mẫu ngưỡng). Hiện tại cả 3 brain đang NGỦ (0 mẫu — DB deploy mới
2026-10-13). **HN-P1 triển khai được ngay (thuần lib + test, không cần dữ liệu);
HN-P2/P3 chỉ BẬT ĐƯỢC trên brain awake** — route chặn bằng `signals.ok` (registry),
không cần cờ mới để chặn.

**Tiến độ:** ☐ HN-P1 ☐ HN-P2 ☐ HN-P3 ☐ HN-P4 ☐ HN-P5 — tất cả CHƯA triển khai.

---

## 1. KIẾN TRÚC ĐÍCH — HYBRID 3+1 LỚP KHỚP HOÀN TOÀN NỀN HIỆN TẠI

### 1.1 Nguyên tắc bất biến (mở rộng từ BRAIN blueprint — mọi phase phải tuân)

- **H1 — Runtime bất khả xâm phạm:** 3 brain A/B/C vẫn là MLP engine cũ
  (`mlp.ts`), runtime vẫn tiêu thụ `BrainModel` active + envelope weights cũ,
  bất biến A1 (train → thắng 5-fold CV đối chứng → thăng cấp) **không đổi một chữ**,
  3 organ kill-switch giữ nguyên. HyperNAS KHÔNG BAO GIỜ chạy trong đường suy
  diễn runtime.
- **H2 — Search chỉ đề xuất:** sản phẩm duy nhất của search là **candidate ranking
  + 1 đề xuất draft**. Việc áp dụng vào `BrainSpecDraft` là hành động user bấm nút;
  việc lên runtime vẫn đi ĐÚNG đường cũ (train → CV → thăng cấp). Không có đường
  tắt auto-promote. (Xem Q3 §8 — user có thể chốt cho phép thăng cấp 1-click, nhưng
  đó vẫn là nút user bấm.)
- **H3 — Ngân sách CPU:** mỗi session ≤ `SEARCH_MAX_CANDIDATES` (mặc định 24) ứng
  viên, ≤ `SEARCH_MAX_WALL_MS` (mặc định 10 phút), mỗi ứng viên ≤ `BRAIN_MAX_PARAMS`
  (250K — trần sẵn có `mlp.validateSpec`). Tiền lệ: single-flight A7.
- **H4 — Tất định:** toàn bộ random (sampler, shuffle) qua `makeRng` với seed;
  cùng seed + cùng dữ liệu + cùng danh sách ứng viên → cùng bảng xếp hạng
  bit-đối-bit (tiền lệ test r84-3 của mlp.ts).
- **H5 — DB additive:** model 101 (`BrainSearchRun`) + 102 (`BrainSearchCandidate`)
  — model thứ 101/102, không đụng 100 model cũ (tiền lệ BrainSpecDraft model 100).
  Prune giữ `SEARCH_SESSIONS_KEEP = 5` session mới nhất/brain (tiền lệ
  `BRAIN_VERSIONS_KEEP = 5` + cap `TUNING_CHANGE_LOG_CAP`).
- **H6 — Không lưu weights trong search:** candidate chỉ lưu spec + metrics.
  Lý do an toàn: `mlp.ts` tất định bit-đối-bit theo (seed, data) → lúc thăng cấp
  train lại cùng seed là ra đúng weights đó — không cần đường ghi `BrainModel` mới,
  loại bỏ hẳn rủi ro search ghi nhầm vào bảng runtime (H1 tự động giữ).

### 1.2 Bốn lớp (đúng thiết kế đã review — xem §1.3)

```
┌──────────────────────────────────────────────────────────────────────────┐
│ LỚP VẬN HÀNH (GIỮ NGUYÊN 100%)                                            │
│   Brain-A V3 · Brain-B Vọng · Brain-C Lệnh — MLP engine cũ                │
│   BrainModel active · A1 gate · organ kill-switch · /api/brain/*          │
│   ↳ HyperNAS KHÔNG chạm lớp này bằng bất kỳ cách nào                      │
├──────────────────────────────────────────────────────────────────────────┤
│ LỚP 1 — NAS-LITE SEARCH (HN-P1+P2)                                        │
│   Không gian = ĐÚNG không gian draft sẵn có (0–6 lớp × 1–256 units ×      │
│   9 activation + α/β × 4 loss + δ × 9 hyper — DRAFT_LIMITS spec-schema)   │
│   Mỗi ứng viên: train thật + 5-fold CV thật (tái dùng pipeline từng brain) │
│   Sản phẩm: bảng xếp hạng + đề xuất draft — user duyệt (H2)               │
├──────────────────────────────────────────────────────────────────────────┤
│ LỚP 2 — HYPERNAS PREDICTOR (HN-P3)                                        │
│   Hypernetwork = chính MLP engine mlp.ts: input encoding kiến trúc        │
│   → output CV score dự đoán. Học từ (encoding, score) thật của Lớp 1.     │
│   Vai trò: rank ứng viên KHÔNG train → giảm Query Cost (MET_NAS_015).     │
│   Không đụng runtime — chỉ thông minh hoá phòng thí nghiệm.               │
├──────────────────────────────────────────────────────────────────────────┤
│ LỚP 3 — SMASH GENERATOR (HN-P4 — MỞ, SAU KHI P3 CHỨNG MINH GIÁ TRỊ)       │
│   H(encoding) sinh W tạm → prefilter rẻ → chỉ top-K vào train thật.       │
│   Ứng viên thắng vẫn train bằng engine cũ (H1).                           │
└──────────────────────────────────────────────────────────────────────────┘
```

### 1.3 REVIEW KIẾN TRÚC — 3 điểm SỬA so với bản thảo thảo luận đầu (2026-10-13)

Bản thảo đầu (câu trả lời Task 20) có 3 điểm chưa chặt — đã hiệu đính trong
blueprint này, ghi rõ để đối chiếu:

1. **BỎ ý lưu weights trong bảng search** (bản thảo: "BrainSearchRun lưu candidate").
   Lưu weights (200KB–1.5MB/ứng viên × 24 ứng viên × nhiều session) vừa phình DB
   vừa mở đường ghi nhầm runtime. **Sửa (H6):** chỉ lưu spec + metrics; thăng cấp
   = train lại cùng seed (tất định bit-đối-bit của `mlp.ts` bảo đảm). Đổi được vì
   engine đã có kỷ luật tất định từ BRAIN-P1.
2. **THÊM data-fingerprint chống drift cho Lớp 2** (bản thảo không có). CV score
   của ứng viên phụ thuộc TẬP DỮ LIỆU — khi data mới chảy vào, score cũ hết giá trị
   triệt để. **Sửa:** mỗi candidate ghi `dataFingerprint` = SHA-256 của (nSamples,
   inputMode, hash chuỗi id mẫu theo thứ tự sort); predictor HN-P3 **chỉ học từ
   mẫu cùng fingerprint với data hiện tại**, hoặc nếu < 40 mẫu cùng fingerprint →
   cold-start lại random (đúng hành vi NAS literature: predictor phải retrain khi
   distribution đổi).
3. **THÊM điều kiện kích hoạt search = brain awake** (bản thảo chỉ nói "khi dữ liệu
   đủ" chung chung). **Sửa:** route chặn bằng `signals.ok` hiện có trong registry —
   search trên brain ngủ là vô nghĩa thống kê (0 mẫu) và đốt CPU vô ích.

Điểm GIỮ NGUYÊN sau khi review: (a) không gian search = đúng `DRAFT_LIMITS` —
không phát minh không gian mới, mọi ràng buộc validate `validateBrainDraft` tái
sử dụng 100%; (b) pipeline train + CV của từng brain (calibration-v3.ts /
surrogate.ts / policy.ts) dùng nguyên bản — search chỉ là vòng lặp gọi chúng;
(c) mọi giao diện mới nằm trong tab console SECTION 3 tab BRAIN (không thêm
module mới).

---

## 2. HIỆN TRẠNG & BẰNG CHỨNG CODE (đo 2026-10-13)

| Thành phần | Hiện trạng | Nguồn |
|---|---|---|
| Engine MLP | Thuần TS, 9 activation, 4 loss, SGD+momentum & Adam, He/Xavier tất định, mini-batch Fisher–Yates, clip norm, early-stopping hold-out 15% | `src/lib/brain/mlp.ts` (+ activations/losses/init/optimizers) |
| Không gian draft | 0–6 lớp ẩn × units 1–256 × 9 activation (softmax cấm hidden — audit B1) + α/β + δ Huber + 9 hyper | `src/lib/brain/spec-schema.ts` `DRAFT_LIMITS` |
| Bảng brain DB | `BrainModel` (model 99, active, envelope float64) · `BrainSpecDraft` (model 100, 1 nháp/brain) | `prisma/schema.prisma` |
| Pipeline train + CV | 3 brain đầy đủ: A 5-fold Brier đối chứng V2 · B 3 MLP đầu riêng + bootstrap CI · C 5-fold CE | `src/lib/brain/{calibration-v3,brains/surrogate,brains/policy}.ts` |
| Dữ liệu | **0 mẫu** cả 3 nguồn (EvalResult/AgentRunRecord/QEntry+ArbiterVerdict) — DB deploy mới | `bun:sqlite` đếm 2026-10-13 |
| HyperNAS | **KHÔNG tồn tại** — chỉ khái niệm trong knowledge shards | Task 19 worklog |

Kích thước không gian search (ước tính thô, chỉ để hình dung): tổ hợp rời rạc
≈ (7 số lớp) × 256^6 (units) × 8^6 (activation hidden) × … — **vô cùng lớn**;
vì vậy chiến lược mẫu (§4.2) quan trọng hơn không gian tuyệt đối — đúng tinh thần
`NAS_002 Search Space` + `NAS_003 Search Strategy` trong shard.

---

## 3. THIẾT KẾ CHI TIẾT — ENCODING (nền cho mọi phase)

### 3.1 Vector encoding ứng viên (fixed-length, tất định, bijective)

Mọi candidate biểu diễn bằng 1 vector số thực cố định chiều (kèm decode ngược
đúng `BrainDraftSpec` — **bijective** trong biên `DRAFT_LIMITS`):

```
[0]        nLayers/6                                        (0–1)
[1..6]     units từng lớp /256 (pad 0 khi thiếu)            (0–1)
[7..60]    activation one-hot 9 × 6 vị trí lớp (pad 0-vector)
[61..66]   α hoặc β từng lớp (log-scale, 0 khi không dùng)  (~0–1)
[67..69]   lossPerHead type one-hot 4 × 3 đầu (theo rule từng brain — phần KHÓA đặt vector cố định)
[70..72]   trọng số từng head (Σλ=1)
[73]       δ Huber (log-scale, 0 khi head≠huber)
[74..82]   hyper 9 trường chuẩn hoá về [0,1] theo min/max DRAFT_LIMITS
[83]       inputDim/2048 (0 khi chưa biết)
[84..86]   brainKey one-hot 3 (A/B/C)
```

- Chiều cố định **87** — predictor HN-P3 dùng trực tiếp làm input MLP.
- Chuẩn hoá toàn bộ về [0,1] (hoặc one-hot) để MLP không bị chi phối thang đo.
- `encodeDraft(spec) → number[]` và `decodeDraft(vec) → BrainDraftSpec` — cặp
  đảo nhau, test bất động r92 (encode∘decode = identity trên sweep biên).
- Lớp bị khóa theo `BRAIN_DRAFT_RULES` (loss A/C, output units…) encoding đặt
  giá trị cố định — không tạo ảo tưởng "tìm được" phần hợp đồng khóa.

### 3.2 Bảng DB mới (model 101 + 102 — additive)

```prisma
/// HN-P1 (blueprint HyperNAS §3.2) — 1 phiên chạy search của 1 brain.
/// KHÔNG BAO GIỜ ghi BrainModel/active (bất biến H1/H2). Model thứ 101.
model BrainSearchRun {
  id            String   @id @default(cuid())
  brain         String   /// khớp BRAIN_REGISTRY
  status        String   @default("running") /// running|done|failed|cancelled
  seed          Int      /// seed tất định toàn session
  /// SHA-256 (nSamples, inputMode, sorted-sample-ids) — chống drift (§1.3-2)
  dataFingerprint String
  inputMode     String
  candidatesMax Int      /// ngân sách H3
  wallMsMax     Int
  /// tổng kết khi done: best candidate id, top-5 score, durationMs, nCandidates
  summaryJson   String?
  error         String?
  startedAt     DateTime @default(now())
  finishedAt    DateTime?
  createdAt     DateTime @default(now())

  @@index([brain, createdAt])
}

/// HN-P1 — 1 ứng viên đã đánh giá trong 1 session. KHÔNG lưu weights (H6).
/// Model thứ 102. Prune theo session cha (H5).
model BrainSearchCandidate {
  id          String   @id @default(cuid())
  runId       String
  /// thứ tự sinh trong session (0-based) — tất định theo seed
  idx         Int
  specJson    String   /// BrainDraftSpec normalized (đúng format BrainSpecDraft.specJson)
  encodingJson String  /// vector 87 chiều (§3.1) — input sẵn cho HN-P3
  /// metrics thật: cvScore + CI, nSamples, params, trainMs, improvedVsActive
  metricsJson String
  /// true khi ứng viên này thắng bản active trên CÙNG fold (bằng chứng H2/Q3)
  beatActive  Boolean  @default(false)
  createdAt   DateTime @default(now())

  @@unique([runId, idx])
  @@index([runId, cvSortKey: desc]) /// cvSortKey materialise từ metricsJson — xem xét thêm cột Float cvScore thay index expression (SQLite) — CHỐT khi triển khai
}
```

*(Ghi chú: SQLite/Prisma không hỗ trợ expression index như trên — khi triển khai
thêm cột `cvScore Float` thật + `@@index([runId, cvScore(sort: Desc)])`. Ghi ở
đây để nhớ quyết định.)*

---

## 4. CHI TIẾT TRIỂN KHAI TỪNG PHASE

### 4.1 HN-P1 — Nền search space (thuần lib, không cần dữ liệu)

**Files:** `src/lib/brain/search-space.ts` (mới, thuần hằng số + toán — an toàn
client bundle lẫn bun:test, doctrine #9 single-source: import `DRAFT_LIMITS`,
`BRAIN_DRAFT_RULES`, `validateBrainDraft` từ spec-schema).

1. `encodeDraft` / `decodeDraft` (§3.1) + property bijective.
2. `sampleCandidate(rng, brain)`: sinh `BrainDraftSpec` ngẫu nhiên **trong biên** —
   sinh thô → `validateBrainDraft` (kèm `inputUnits` ước tính từ DB do caller
   truyền) → nếu lỗi validate (trần tham số…) → sinh lại (bounded retry 20 lần,
   hết → dùng `defaultDraftFor`). Tỷ lệ ứng viên bị loại được ghi metrics.
3. Hằng số: `SEARCH_MAX_CANDIDATES = 24`, `SEARCH_MAX_WALL_MS = 600_000`,
   `SEARCH_SESSIONS_KEEP = 5`, `SEARCH_CANDIDATES_KEEP = 60`/session (top-N +
   best) — hardcode kèm nguồn (doctrine #1: §0 bảng phase + H3).
4. Prisma model 101 + 102 + `bun run db:push`.
5. **Test r92:** bijective sweep (mỗi brain × biên DRAFT_LIMITS × activation 9 ×
   loss hợp lệ × hidden 0/1/3/6 lớp), sampler trong biên 1000 mẫu seed khác nhau,
   tất định same-seed, encode chiều 87, decode lỗi friendly khi vector rác.

### 4.2 HN-P2 — Vòng search thật + đề xuất draft (cần brain awake)

**Files:** `src/lib/brain/search.ts` (mới) · `src/app/api/brain/search/route.ts`
(mới: POST khởi động / GET trạng thái + kết quả) · UI: tab console "Tìm kiếm"
mới trong SECTION 3 tab BRAIN (`brain-tab.tsx`, cạnh train/tuning/log/ref).

**Luồng:**

1. **POST /api/brain/search** `{brain, candidates?, seed?}` — chặn nếu: brain không
   trong `BRAIN_TRAINABLE_KEYS` · `signals.ok = false` (chưa thức tỉnh) · session
   đang chạy (single-flight — global lock precedent A7, sống sót hot-reload qua
   `globalThis`). Tạo `BrainSearchRun` (status=running) → trả runId ngay.
2. **Vòng nền** (async trong process, `setTimeout(0)` yield giữa các ứng viên để
   không block event loop API — CPU churn H3): với i ∈ [0, candidates):
   `sampleCandidate` → train + 5-fold CV **bằng đúng pipeline brain đó** (gọi
   hàm train sẵn có với `useDraft` mechanism — tái sử dụng 100%, không viết lại
   CV) → ghi `BrainSearchCandidate` (spec + encoding + metrics + beatActive) →
   update run progress. Hết ngân sách/wall-time → status=done + summaryJson.
3. **beatActive:** so sánh cvScore ứng viên với bản active trên CÙNG fold + CÙNG
   data (pipeline hiện tại đã đối chứng active — tái dùng kết quả đối chứng đó).
   Ứng viên `beatActive=true` là bằng chứng đề xuất (Q3 §8).
4. **Đề xuất:** session done → UI hiển thị bảng xếp hạng (điểm CV + CI + params +
   thời gian) + nút **"Áp dụng ứng viên vào nháp"** (chỉ ghi `BrainSpecDraft` —
   đúng nghĩa H2; user sau đó bấm Huấn luyện lại như hiện tại → A1 đường cũ).
   Nút disabled + lý do khi không ứng viên nào thắng active.
5. **Prune:** sau mỗi session done — xóa session cũ giữ 5/brain; xóa candidate
   giữ top-60/session.
6. **Cờ `brain_search`** (off mặc định, STORE > ENV > DEFAULT precedent `UI_*`):
   cờ chỉ bật NÚT trong UI (không gate route — route đã tự chặn bằng signals).
   Lý do tách: tránh trạng thái "cờ on nhưng brain ngủ" vô nghĩa.

**Test r93:** bất biến "search KHÔNG BAO GIỜ ghi BrainModel/active" (spy Prisma —
tangent test đắt nhất đợt này) · single-flight 2 POST chồng nhau · chặn brain ngủ ·
tất định same-seed same-data ra cùng bảng xếp hạng (data giả ≥ ngưỡng) · prune
đúng cap · progress không block API (đo event-loop delay < 200ms trong lúc chạy
với candidates nhỏ) · UI contract (GET shape) pin.

### 4.3 HN-P3 — HyperNAS predictor (cần ≥ 2 session search cùng fingerprint)

**Files:** `src/lib/brain/hypernas.ts` (mới — chính là "hypernetwork" của hệ
thống: một MLP sinh **dự đoán điểm** cho kiến trúc khác, đúng nghĩa chức năng
weight-generating function `ENT_WGF_026` nhưng đầu ra là scalar thay vì W — xem
Q5 §8 cho hướng sinh W thật).

1. **Dữ liệu học:** mọi `BrainSearchCandidate` cùng `dataFingerprint` với data
   hiện tại của brain — mỗi candidate = 1 mẫu (encoding 87 chiều → cvScore).
   Ngưỡng cold-start: **< 40 mẫu → predictor KHÔNG dùng** (search thuần random —
   đúng hành vi cũ, không đổi). Nguồn ngưỡng: quy tắc thực dụng NAV (này tương
   đương MIN_TRAIN_SAMPLES_V2 = 30 của calibration + biên an toàn) — hardcode
   doctrine #1.
2. **Mô hình:** tái dùng engine `mlp.ts`: layers [87, 16 tanh, 8 tanh, 1 linear],
   loss huber (ổn định outlier score), adam, hold-out 15%, early-stopping — toàn
   bộ spec hợp lệ `validateSpec`. Predictor lưu ở đâu? **KHÔNG bảng mới** —
   retrain từ candidates mỗi lần cần (MLP nhỏ + ≤ vài trăm mẫu = < 1s) — triết lý
   "stateless helper" tránh DB phình thêm.
3. **Acquisition (wired vào search loop khi `brain_hypernas` on):** sinh M = 96
   ứng viên ngẫu nhiên → predictor chấm → chọn top-K = candidates/2 ứng viên
   ĐỦ ĐA DẠNG (thêm ε-greedy: 20% slot cho ứng viên ngẫu nhiên thuần — khám phá
   vs khai thác, đúng ATTRIBUTES node `NAS_003 Search Strategy`) → chỉ những
   ứng viên đó vào train thật. Query Cost giảm ~50% (MET_NAS_015).
4. **Đo chất lượng predictor:** Spearman rank correlation giữa dự đoán và score
   thật trên hold-out (tái dùng spearman precedent trong `policy.ts`) — hiển thị
   trong UI tab Tìm kiếm; < 0.3 → predictor tự coi "chưa đủ tin" → rơi về random
   (fail-open precedent toàn hệ).
5. **Cờ `brain_hypernas`** off mặc định.

**Test r94:** predictor train/predict shape + tất định · cold-start fail-open
(< 40 mẫu) · acquisition tất định theo seed · Spearman đúng công thức (pin hồi
quy với bảng tay) · không bao giờ ghi DB khi retrain (stateless — spy) · encoding
fingerprint khác nhau không lẫn mẫu.

### 4.4 HN-P4 — SMASH-style generator (MỞ — chỉ triển khai khi HN-P3 chứng minh)

Hypernetwork H thật sự sinh weights: `H(encoding) → {W₁..Wₗ}` chunked per-layer
(Linear head từng lớp — kỹ thuật memory-bank SMASH tránh double-backprop). CHỈ
dùng prefilter: H sinh W tạm → forward 1 pass trên hold-out → ước score → chọn
top-K vào train thật. **Rủi ro cao** (H xấu → chọn lệch toàn bộ), **lợi ích chưa
chứng minh** so với HN-P3 → điểm dừng: chỉ mở khi (a) HN-P3 chạy ≥ 4 session,
(b) Spearman predictor ổn định > 0.5, (c) user chốt Q5 §8.

### 4.5 HN-P5 — Biên Python/GPU (MỞ — đồng bộ BRAIN-P5)

Search không gian lớn (supernet, DARTS differentiable — node `NAS_026 alpha`,
metric `MET_NAS_014 Discretization Error Gap`, `MET_NAS_023 Hessian λ_max`) cần
GPU → sidecar Python (weightsJson envelope numpy-đọc-được đã sẵn từ BRAIN-P1 A6).
Không thiết kế chi tiết ở v0.1.

---

## 5. VÒNG DỮ LIỆU & VẤN ĐỀ THỐNG KÊ (phải nói thẳng)

1. **Winner's curse (selection bias):** chọn max của N cvScore ước lượng → score
   của ứng viên thắng bị lệch lạc ĐỈNH (optimistic). Giảm nhẹ: k-fold CV trung
   bình đã giảm variance; **báo cáo kèm CI** (bootstrap precedent surrogate.ts);
   khi mẫu ≥ 100 → chuyển nested hold-out (mở §8 Q4). Đánh giá THẬT cuối cùng
   vẫn là vận hành runtime (eval run / replay) — search chỉ là gợi ý.
2. **Drift dữ liệu:** fingerprint (§1.3-2) tách lịch sử search theo snapshot dữ
   liệu. Data đổi → predictor cold-start lại — trung thực hơn là học từ phân phối
   cũ.
3. **Nhãn metric so sánh chéo brain:** mỗi brain có metric riêng (Brier / MAE /
   CE) — candidates KHÔNG so chéo brain; predictor HN-P3 train **riêng từng
   brain** (encoding có brain one-hot chỉ để phòng tương lai multi-task —
   node `MET_NAS_013 Task Affinity`; v0.1 KHÔNG dùng chung).

---

## 6. RỦI RO & GIẢI PHÁP

| # | Rủi ro | Mức | Giải pháp |
|---|---|---|---|
| R1 | Search đốt CPU ảnh hưởng API cùng process | Cao | H3 budget + `setTimeout(0)` yield giữa ứng viên + single-flight + test r93 đo event-loop delay |
| R2 | Selection bias (winner's curse) | Cao | §5.1 — CI + nested hold-out khi đủ mẫu + runtime vẫn là phán xét cuối |
| R3 | Search trên data nhỏ → kết quả vô nghĩa | Cao | Chặn signals.ok (§1.3-3) — brain phải awake |
| R4 | Predictor học rác (fingerprint lẫn) | TB | §4.3-1 fingerprint + cold-start 40 + Spearman fail-open |
| R5 | Đề xuất bị hiểu nhầm là "máy quyết định" | TB | UI copy rõ "đề xuất — bạn duyệt"; H2 bất biến + test tangent r93 |
| R6 | DB phình (candidates) | TB | Prune H5 (5 session/brain × top-60) — ước max ~2–3MB |
| R7 | UI tab BRAIN phức tạp hoá | TB | Tab "Tìm kiếm" ẩn khi cờ off — đúng pattern 3 cờ UI hiện có |

---

## 7. DOCTRINE COMPLIANCE (9 nguyên tắc BLUEPRINT-STATS-LEARNING)

1. Hardcode kèm nguồn — §4.1-3 mọi hằng số ghi nguồn. ✓
2. Fail-open tuyệt đối — predictor fail-open random (§4.3-4), search lỗi →
   status=failed + error, không đụng runtime. ✓
3. Không tự ý mở rộng phạm vi — không gian = DRAFT_LIMITS sẵn có, không phát
   minh. ✓
4. Commit trung thực theo working tree. ✓
5. (Nếu có DB write runtime thật) — không áp dụng: H1/H2 cấm ghi runtime. ✓
6. Test trước khi ship — r92–r94 mỗi phase. ✓
7. Đổi schema phải additive — model 101/102, không sửa 99/100. ✓
8. Cờ runtime mặc định off — brain_search/brain_hypernas off. ✓
9. Single-source — encoding/import từ spec-schema + registry, không nhân bản. ✓

---

## 8. DANH SÁCH CHỜ USER CHỐT TRƯỚC KHI TRIỂN KHAI

| # | Câu hỏi | Khuyến nghị |
|---|---|---|
| Q1 | Triển khai HN-P1 ngay (thuần lib + test, không cần dữ liệu) hay chờ brain thức tỉnh? | **Triển khai HN-P1 ngay** — nền sẵn sàng, khi data đến là chạy được |
| Q2 | Ngân sách mặc định 24 ứng viên × 10 phút/session — hợp lý chưa? | 24 ứng viên ≈ 1–3 phút với MLP nhỏ — an toàn để mặc định |
| Q3 | Cho phép nút **"Thăng cấp 1-click"** ứng viên `beatActive=true` (vẫn là nút user bấm, vẫn qua kiểm tra CV cùng fold) hay bắt buộc đi đường dài qua draft → train lại? | **Đường qua draft** (H2 nguyên vẹn) ở v0.1; xem xét 1-click sau vài session khi tin CV |
| Q4 | Khi mẫu ≥ 100: chuyển nested hold-out (chính xác hơn, chậm hơn) — chốt trước hay để mặc định k-fold? | Để mặc định k-fold + CI; nested khi dữ liệu thật sự lớn |
| Q5 | HN-P4 (SMASH sinh weights thật) có đáng làm không? | **Chờ** HN-P3 chạy ≥ 4 session + Spearman > 0.5 ổn định |
| Q6 | Predictor HN-P3 riêng từng brain (khuyến nghị) hay multi-task chung (MET_NAS_013)? | Riêng từng brain — data còn nhỏ |

---

## 9. TÍCH HỢP GIAO THỨC QUAN SÁT (tham chiếu chéo)

Toàn bộ sự kiện search (session start/end, candidate evaluated, proposal applied)
phát **ObservationEvent** theo [BLUEPRINT-OBSERVATION-P1-P4.md](./BLUEPRINT-OBSERVATION-P1-P4.md)
§3 (kind `search.*`) — nhờ vậy giao thức quan sát V2 thấy được cả quá trình tìm
kiến trúc, đúng yêu cầu user "toàn cảnh… đến cấp độ xác định vấn đề tinh chỉnh
kiến trúc". Hai blueprint triển khai độc lập nhưng kind-name thống nhất từ v0.1
này để không phải đổi tên sau.

---

*Ngày soạn: 2026-10-13 · Task 21 (worklog `/home/z/my-project/worklog.md`) ·
Bổ sung cho BLUEPRINT-BRAIN-P1-P5.md v0.12 — mọi bất biến A1–A7 của brain giữ
nguyên hiệu lực cho blueprint này.*
