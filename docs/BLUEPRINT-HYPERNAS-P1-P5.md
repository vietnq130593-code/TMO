# BLUEPRINT TRIỂN KHAI HYBRID HYPERNAS P1 → P5 — "PHÒNG THÍ NGHIỆM TÌM KIẾN TRÚC NÃO" CHO TMO

> **Phiên bản:** 0.2.2 — **hiệu đính vị trí tab (Task 25): "Tìm kiếm" = tab
> thứ 6 SECTION 3 (slot 5 = "Quan sát" OBS-P3 tích hợp theo chỉ thị user
> 2026-10-13).** Kế thừa 0.2.1 — **§8 ĐÃ CHỐT 2026-10-13 (user: "theo đề xuất") —
> triển khai theo thứ tự Observation trước (chỉ thị user cùng ngày), HN-P1
> xếp hàng kế tiếp theo Q1.** *(Hiệu đính 0.2→0.2.1, Task 24 2026-10-13 —
> đợt FB-OBS R1-05: §9 "proposal.applied" → "proposal.apply" cho khớp 3 nguồn
> còn lại kinds.ts / OBS §C.2 / schema.prisma — doctrine #9 thống nhất
> kind-name. Không đổi thiết kế nào khác.)* Bổ sung cho
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
>
> **Nhật ký hiệu đính:**
> - **0.1 → 0.2 (2026-10-13, Task 22):** theo chỉ thị user *"xác định blueprint
>   đã bao gồm UI/UX chưa — nếu chưa thì bổ sung rồi review lại cả blueprint"* —
>   v0.1 CHƯA có section UI/UX (chỉ 4 chỗ nhắc rải rác §0/§4.2/§4.3/R7). **THÊM
>   §10 UI/UX đầy đủ** (7 nguyên tắc chắn · state machine 4 trạng thái · bảng
>   xếp hạng + 2 cấp nút áp dụng · panel predictor · API contract pin ·
>   responsive · copy chốt · test UI). **Review toàn văn — sửa 4 lỗi + 2 minh
>   hoạ:** (1) *[P1 — sai số học]* encoding "87 chiều" sai — loss one-hot 4×3 =
>   12 slot nhưng v0.1 chỉ chừa 3 slot [67..69]; tổng đúng = **96** — sửa 5 vị
>   trí + dải chỉ số mới (§3.1); (2) *[P2 — xung đột test ID]* r92/r93 đã bị
>   BRAIN-LIVE/BRAIN-TAB-3PHAN (Task 18) chiếm, r95 trùng dự phòng
>   BLUEPRINT-OBSERVATION r95–r98 → **đổi toàn bộ sang r100–r103**; (3) *[P3 —
>   robustness]* session "running" mồ côi khi pm2 restart → THÊM `heartbeatAt`
>   (§3.2) + GET tự mark failed khi stale > 60s (§4.2-2b); (4) *[P3 — API gap]*
>   enum có "cancelled" nhưng không có đường gọi → THÊM
>   `POST /api/brain/search/cancel` cooperative (§4.2-2c); (5) minh hoạ rõ 2 cấp
>   nút áp dụng (§4.2-4/§10.3); (6) M acquisition 96→128 tránh trùng số chiều
>   encoding (§4.3-3). Thêm Q7 (§8) + R7 liên kết §10.
> - **0.1 (2026-10-13, Task 21):** bản đầu — kiến trúc hybrid 3+1 lớp, bất biến
>   H1–H6, encoding, model 101/102, phase HN-P1→P5, 6 câu hỏi mở.
> - **0.2.1 (2026-10-13, Task 23):** §8 Q1–Q7 **CHỐT THEO KHUYẾN NGHỊ** (user:
>   "7 câu hỏi mở hãy theo đề xuất của bạn đi") — xem cột Trạng thái §8. Thứ tự
>   triển khai user chỉ định: BLUEPRINT-OBSERVATION trước, HN-P1 kế tiếp.
> - **0.2.2 (2026-10-13, Task 25):** hiệu đính theo chỉ thị user — tab
>   "Quan sát" (OBS-P3) tích hợp VÀO tab BRAIN › SECTION 3 thành tab console
>   thứ 5 → tab "Tìm kiếm" của HN-P2 chuyển thành tab **thứ 6** (cập nhật §4
>   HN-P2 · §8 Q7 · §10.1-4 "tab bar 6 nút" · 375px: 6 nút × ~62px). Không
>   đổi thiết kế search/encoding/API — chỉ vị trí tab.

---

## 0. TÓM TẮT ĐIỀU HÀNH

| Phase | Tên | Mục tiêu một câu | Artifacts | Cờ (mặc định) | Test |
|---|---|---|---|---|---|
| **HN-P1** | Nền search space | Encoding tất định ↔ BrainDraftSpec + bảng `BrainSearchRun(session)` + `BrainSearchCandidate` | `src/lib/brain/search-space.ts` · prisma model 101+102 | — (thuần lib) | r100 |
| **HN-P2** | Vòng search thật | Chạy N ứng viên train + 5-fold CV thật → bảng xếp hạng → **đề xuất** draft (user duyệt — A1 nguyên vẹn) | `src/lib/brain/search.ts` · `POST/GET /api/brain/search` + `POST /api/brain/search/cancel` · UI tab "Tìm kiếm" (SECTION 3 — thiết kế đầy đủ §10) | `brain_search` (off) | r101 |
| **HN-P3** | HyperNAS predictor | Hypernetwork MLP (tái dùng engine `mlp.ts`) học `(encoding → CV score)` từ lịch sử search → rank ứng viên mới không cần train (giảm Query Cost) | `src/lib/brain/hypernas.ts` · wired vào search loop · panel UI §10.4 | `brain_hypernas` (off) | r102 |
| **HN-P4** | *(mở, sau này)* SMASH-style generator | Hypernetwork sinh W tạm cho ứng viên để prefilter rẻ — CHỈ trong giai đoạn search, không thay train thật | `src/lib/brain/smash.ts` (dự kiến) | `brain_smash` (off) | r103 |
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
[67..78]   lossPerHead type one-hot 4 × 3 đầu = 12 slot (theo rule từng brain — phần KHÓA đặt vector cố định)
[79..81]   trọng số từng head (Σλ=1)
[82]       δ Huber (log-scale, 0 khi head≠huber)
[83..91]   hyper 9 trường chuẩn hoá về [0,1] theo min/max DRAFT_LIMITS
[92]       inputDim/2048 (0 khi chưa biết)
[93..95]   brainKey one-hot 3 (A/B/C)
```

- Chiều cố định **96** — predictor HN-P3 dùng trực tiếp làm input MLP.
  *(Hiệu đính v0.2: v0.1 ghi "87 chiều" là SAI SỐ HỌC — loss one-hot cần 4×3 =
  12 slot nhưng v0.1 chỉ chừa dải [67..69] = 3 slot; tổng đúng = 1+6+54+6+12+3
  +1+9+1+3 = **96**. Pin test r100 bắt buộc assert chiều 96 — sai số loại này
  đúng chỗ test bắt.)*
- Chuẩn hoá toàn bộ về [0,1] (hoặc one-hot) để MLP không bị chi phối thang đo.
- `encodeDraft(spec) → number[]` và `decodeDraft(vec) → BrainDraftSpec` — cặp
  đảo nhau, test bất động r100 (encode∘decode = identity trên sweep biên).
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
  /// v0.2: cập nhật sau MỖI ứng viên xong — GET thấy running mà stale > 60s
  /// → tự mark failed "worker chết (restart?)" — session mồ côi không treo vĩnh viễn (§4.2-2b)
  heartbeatAt   DateTime @default(now())
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
  encodingJson String  /// vector 96 chiều (§3.1) — input sẵn cho HN-P3
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
5. **Test r100** *(v0.2: đổi từ r92 — r92/r93 đã bị BRAIN-LIVE/BRAIN-TAB-3PHAN
   Task 18 chiếm, r95 trùng dự phòng BLUEPRINT-OBSERVATION r95–r98)*: bijective
   sweep (mỗi brain × biên DRAFT_LIMITS × activation 9 × loss hợp lệ × hidden
   0/1/3/6 lớp), sampler trong biên 1000 mẫu seed khác nhau, tất định same-seed,
   encode chiều **96** (đúng §3.1 — pin bắt lỗi đếm slot kiểu v0.1), decode lỗi
   friendly khi vector rác.

### 4.2 HN-P2 — Vòng search thật + đề xuất draft (cần brain awake)

**Files:** `src/lib/brain/search.ts` (mới) · `src/app/api/brain/search/route.ts`
(mới: POST khởi động / GET trạng thái + kết quả) · `src/app/api/brain/search/cancel/route.ts`
(mới — v0.2: v0.1 có status "cancelled" trong enum nhưng KHÔNG có đường gọi) ·
UI: tab console "Tìm kiếm" thứ 6 trong SECTION 3 tab BRAIN (`brain-tab.tsx`,
cạnh train/tuning/log/ref/observation — hiệu đính 0.2.2: slot 5 đã có tab
"Quan sát" OBS-P3 theo chỉ thị user) — **thiết kế UI/UX đầy đủ §10** (state machine 4
trạng thái, bảng xếp hạng + 2 cấp nút áp dụng, copy, a11y, responsive).

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
   update run progress + `heartbeatAt` (v0.2). Hết ngân sách/wall-time →
   status=done + summaryJson.
   **2b. Tự lành session mồ côi (v0.2):** pm2 restart giữa chừng → vòng nền chết,
   session kẹt "running" vĩnh viễn. GET thấy `status=running` mà `heartbeatAt`
   stale > 60s → mark failed kèm error "worker chết (restart?)" — không cần
   process-hook, không cần cron.
   **2c. Huỷ (v0.2):** `POST /api/brain/search/cancel {runId}` đặt cờ cancel
   trong memory (chung `globalThis` lock A7) — vòng nền kiểm tra cờ GIỮA 2 ứng
   viên (cooperative — không abort giữa train, an toàn H1) → status=cancelled +
   vẫn giữ mọi candidate đã chấm (kết quả một phần vẫn có giá trị xem).
   Idempotent: cancel session đã kết thúc → vẫn trả ok.
3. **beatActive:** so sánh cvScore ứng viên với bản active trên CÙNG fold + CÙNG
   data (pipeline hiện tại đã đối chứng active — tái dùng kết quả đối chứng đó).
   Ứng viên `beatActive=true` là bằng chứng đề xuất (Q3 §8).
4. **Đề xuất:** session done → UI hiển thị bảng xếp hạng (điểm CV + CI + params +
   thời gian) + **2 cấp nút áp dụng (minh hoạ rõ v0.2 — chi tiết §10.3):** nút
   **"Áp dụng đề xuất"** dùng ứng viên best `beatActive=true` — disabled kèm lý
   do khi không ứng viên nào thắng active; nút **"Áp dụng vào nháp"** từng hàng
   trong dialog chi tiết — LUÔN mở (nháp là không gian tự do, runtime vẫn chỉ
   lên qua A1; H2 nguyên vẹn vì cả 2 đều là nút user bấm và chỉ ghi
   `BrainSpecDraft`; user sau đó bấm Huấn luyện lại như hiện tại — đường cũ).
5. **Prune:** sau mỗi session done — xóa session cũ giữ 5/brain; xóa candidate
   giữ top-60/session.
6. **Cờ `brain_search`** (off mặc định, STORE > ENV > DEFAULT precedent `UI_*`):
   cờ chỉ bật HIỆN TAB "Tìm kiếm" trong UI (không gate route — route đã tự chặn
   bằng signals; R7). Lý do tách: tránh trạng thái "cờ on nhưng brain ngủ" vô
   nghĩa. Khi cờ on mà brain ngủ → tab vẫn hiện nhưng ở trạng thái S1 "chưa
   thức tỉnh" (§10.2) — trung thực hơn ẩn tab (user bật cờ mà không thấy gì sẽ
   tưởng lỗi).

**Test r101** *(v0.2: đổi từ r93 — lý do xem r100)*: bất biến "search KHÔNG BAO
GIỜ ghi BrainModel/active" (spy Prisma — tangent test đắt nhất đợt này) ·
single-flight 2 POST chồng nhau · chặn brain ngủ · tất định same-seed same-data
ra cùng bảng xếp hạng (data giả ≥ ngưỡng) · prune đúng cap · progress không
block API (đo event-loop delay < 200ms trong lúc chạy với candidates nhỏ) ·
cancel cooperative (huỷ giữa 2 ứng viên → status=cancelled + candidates giữ
nguyên) · session mồ côi heartbeat stale > 60s → GET mark failed · UI contract
(GET shape §10.5) pin · UI test §10.8.

### 4.3 HN-P3 — HyperNAS predictor (cần ≥ 2 session search cùng fingerprint)

**Files:** `src/lib/brain/hypernas.ts` (mới — chính là "hypernetwork" của hệ
thống: một MLP sinh **dự đoán điểm** cho kiến trúc khác, đúng nghĩa chức năng
weight-generating function `ENT_WGF_026` nhưng đầu ra là scalar thay vì W — xem
Q5 §8 cho hướng sinh W thật).

1. **Dữ liệu học:** mọi `BrainSearchCandidate` cùng `dataFingerprint` với data
   hiện tại của brain — mỗi candidate = 1 mẫu (encoding 96 chiều → cvScore).
   Ngưỡng cold-start: **< 40 mẫu → predictor KHÔNG dùng** (search thuần random —
   đúng hành vi cũ, không đổi). Nguồn ngưỡng: quy tắc thực dụng NAV (này tương
   đương MIN_TRAIN_SAMPLES_V2 = 30 của calibration + biên an toàn) — hardcode
   doctrine #1.
2. **Mô hình:** tái dùng engine `mlp.ts`: layers [96, 16 tanh, 8 tanh, 1 linear],
   loss huber (ổn định outlier score), adam, hold-out 15%, early-stopping — toàn
   bộ spec hợp lệ `validateSpec`. Predictor lưu ở đâu? **KHÔNG bảng mới** —
   retrain từ candidates mỗi lần cần (MLP nhỏ + ≤ vài trăm mẫu = < 1s) — triết lý
   "stateless helper" tránh DB phình thêm.
3. **Acquisition (wired vào search loop khi `brain_hypernas` on):** sinh M = 128
   ứng viên ngẫu nhiên (v0.2: đổi từ 96 — tránh trùng số "96 chiều" encoding
   gây đọc nhầm) → predictor chấm → chọn top-K = candidates/2 ứng viên
   ĐỦ ĐA DẠNG (thêm ε-greedy: 20% slot cho ứng viên ngẫu nhiên thuần — khám phá
   vs khai thác, đúng ATTRIBUTES node `NAS_003 Search Strategy`) → chỉ những
   ứng viên đó vào train thật. Query Cost giảm ~50% (MET_NAS_015).
4. **Đo chất lượng predictor:** Spearman rank correlation giữa dự đoán và score
   thật trên hold-out (tái dùng spearman precedent trong `policy.ts`) — hiển thị
   trong UI tab Tìm kiếm; < 0.3 → predictor tự coi "chưa đủ tin" → rơi về random
   (fail-open precedent toàn hệ).
5. **Cờ `brain_hypernas`** off mặc định.

**Test r102** *(v0.2: đổi từ r94)*: predictor train/predict shape + tất định ·
cold-start fail-open
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
| R1 | Search đốt CPU ảnh hưởng API cùng process | Cao | H3 budget + `setTimeout(0)` yield giữa ứng viên + single-flight + test r101 đo event-loop delay |
| R2 | Selection bias (winner's curse) | Cao | §5.1 — CI + nested hold-out khi đủ mẫu + runtime vẫn là phán xét cuối |
| R3 | Search trên data nhỏ → kết quả vô nghĩa | Cao | Chặn signals.ok (§1.3-3) — brain phải awake |
| R4 | Predictor học rác (fingerprint lẫn) | TB | §4.3-1 fingerprint + cold-start 40 + Spearman fail-open |
| R5 | Đề xuất bị hiểu nhầm là "máy quyết định" | TB | UI copy rõ "đề xuất — bạn duyệt" (§10.7 chốt sẵn); H2 bất biến + test tangent r101 |
| R6 | DB phình (candidates) | TB | Prune H5 (5 session/brain × top-60) — ước max ~2–3MB |
| R7 | UI tab BRAIN phức tạp hoá | TB | Tab "Tìm kiếm" ẩn khi cờ off — đúng pattern 3 cờ UI hiện có; state machine 4 trạng thái S1–S4 + bảng rút gọn mobile (§10) |

---

## 7. DOCTRINE COMPLIANCE (9 nguyên tắc BLUEPRINT-STATS-LEARNING)

1. Hardcode kèm nguồn — §4.1-3 mọi hằng số ghi nguồn. ✓
2. Fail-open tuyệt đối — predictor fail-open random (§4.3-4), search lỗi →
   status=failed + error, không đụng runtime. ✓
3. Không tự ý mở rộng phạm vi — không gian = DRAFT_LIMITS sẵn có, không phát
   minh. ✓
4. Commit trung thực theo working tree. ✓
5. (Nếu có DB write runtime thật) — không áp dụng: H1/H2 cấm ghi runtime. ✓
6. Test trước khi ship — r100–r102 mỗi phase (v0.2: đổi từ r92–r94). ✓
7. Đổi schema phải additive — model 101/102, không sửa 99/100. ✓
8. Cờ runtime mặc định off — brain_search/brain_hypernas off. ✓
9. Single-source — encoding/import từ spec-schema + registry, không nhân bản. ✓

---

## 8. DANH SÁCH CHỐT — **☑ TẤT CẢ 7 CÂU CHỐT THEO KHUYẾN NGHỊ 2026-10-13 (Task 23 — user: "theo đề xuất của bạn đi")**

| # | Câu hỏi | Khuyến nghị | Trạng thái chốt |
|---|---|---|---|
| Q1 | Triển khai HN-P1 ngay (thuần lib + test, không cần dữ liệu) hay chờ brain thức tỉnh? | **Triển khai HN-P1 ngay** — nền sẵn sàng, khi data đến là chạy được | ☑ CHỐT triển khai ngay — xếp sau BLUEPRINT-OBSERVATION theo chỉ thị user 2026-10-13 |
| Q2 | Ngân sách mặc định 24 ứng viên × 10 phút/session — hợp lý chưa? | 24 ứng viên ≈ 1–3 phút với MLP nhỏ — an toàn để mặc định | ☑ CHỐT mặc định 24 × 10 phút (H3) |
| Q3 | Cho phép nút **"Thăng cấp 1-click"** ứng viên `beatActive=true` (vẫn là nút user bấm, vẫn qua kiểm tra CV cùng fold) hay bắt buộc đi đường dài qua draft → train lại? | **Đường qua draft** (H2 nguyên vẹn) ở v0.1; xem xét 1-click sau vài session khi tin CV | ☑ CHỐT đường qua draft (H2) — 1-click chỉ xem xét SAU vài session thật |
| Q4 | Khi mẫu ≥ 100: chuyển nested hold-out (chính xác hơn, chậm hơn) — chốt trước hay để mặc định k-fold? | Để mặc định k-fold + CI; nested khi dữ liệu thật sự lớn | ☑ CHỐT k-fold + CI mặc định |
| Q5 | HN-P4 (SMASH sinh weights thật) có đáng làm không? | **Chờ** HN-P3 chạy ≥ 4 session + Spearman > 0.5 ổn định | ☑ CHỐT chờ — điều kiện mở ≥ 4 session + ρ > 0,5 ổn định |
| Q6 | Predictor HN-P3 riêng từng brain (khuyến nghị) hay multi-task chung (MET_NAS_013)? | Riêng từng brain — data còn nhỏ | ☑ CHỐT riêng từng brain |
| Q7 *(v0.2)* | Vị trí giao diện: tab "Tìm kiếm" ngay trong SECTION 3 tab BRAIN (khuyến nghị — đúng nguyên tắc "mọi giao diện mới nằm trong tab console", không thêm module mới) hay dialog riêng? | Tab trong SECTION 3 — cùng không gian làm việc với nháp + train, luồng duyệt liền tay (đã thiết kế sẵn §10 — chỉ cần user xác nhận) | ☑ CHỐT tab trong SECTION 3 — hiệu đính 0.2.2 (Task 25): slot 5 đã có tab "Quan sát" OBS-P3 → "Tìm kiếm" là tab **thứ 6** |

---

## 9. TÍCH HỢP GIAO THỨC QUAN SÁT (tham chiếu chéo)

Toàn bộ sự kiện search (session start/end, candidate evaluated, proposal apply)
phát **ObservationEvent** theo [BLUEPRINT-OBSERVATION-P1-P4.md](./BLUEPRINT-OBSERVATION-P1-P4.md)
§3 (kind `search.*`) — nhờ vậy giao thức quan sát V2 thấy được cả quá trình tìm
kiến trúc, đúng yêu cầu user "toàn cảnh… đến cấp độ xác định vấn đề tinh chỉnh
kiến trúc". Hai blueprint triển khai độc lập nhưng kind-name thống nhất từ v0.1
này để không phải đổi tên sau. Sự kiện `proposal.apply` (user bấm nút áp dụng
ở §10.3) cũng phát — nhờ vậy tab Quan sát thấy được cả hành động duyệt.

---

## 10. UI/UX — TAB "TÌM KIẾM KIẾN TRÚC" (HN-P2 + HN-P3) — bổ sung v0.2

> Bổ sung theo chỉ thị user 2026-10-13 (Task 22): v0.1 CHƯA có phần UI/UX
> (chỉ 4 chỗ nhắc rải rác §0/§4.2/§4.3/R7). §10 này thiết kế đầy đủ — cùng
> cấp chi tiết với §9 BRAIN-UX của
> [BLUEPRINT-BRAIN](./BLUEPRINT-BRAIN-P1-P5.md) (tiền lệ UX-1→UX-5). Mọi thiết
> kế dưới đây TUÂN THỦ nguyên tắc chắn §9.1 BRAIN-UX (draft ≠ runtime · khoá
> input/output · không framework mới · chốt giảm tải) — không nhắc lại.

### 10.1 Nguyên tắc chắn riêng tab Tìm kiếm (7 điều — mở rộng §9.1)

1. **Đề xuất ≠ quyết định:** mọi copy trong tab nói "đề xuất — bạn duyệt" (H2,
   R5). KHÔNG có chữ/nút nào có thể hiểu là "máy tự thay não". Tab không đụng
   `BrainModel`/active — pin tangent test r101.
2. **Single-source state:** tab đọc đúng state SECTION 3 sẵn có
   (`selectedBrainKey` + `draftsByBrain`/`savedDrafts`/`dirtyBrains` — UX-4
   lift-state precedent) — KHÔNG nhân bản state nháp riêng. Áp dụng vào nháp =
   gọi đúng `onDraftChange` của Studio; editor SECTION 1 nháy tới hàng thay đổi
   (tiền lệ `focusLayerSignal` UX-3).
3. **Hiện/ẩn theo cờ, không theo vòng đời:** tab ẩn hoàn toàn khi `brain_search`
   off (R7). Cờ on + brain ngủ → tab HIỆN nhưng thân là trạng thái S1 — không
   có đường "cờ on mà không thấy gì" để user tưởng lỗi.
4. **Mobile-first:** tab bar 6 nút giữ pattern `min-h-[44px] md:min-h-[32px]` +
   `text-[10px]` (label "Tìm kiếm" ≤ 10 ký tự — 375px: 6 nút × ~62px vẫn
   thoải mái; hiệu đính 0.2.2: 5 nút cũ + "Tìm kiếm"); bảng xếp hạng bọc
   `overflow-x-auto max-h-96 overflow-y-auto`
   (đúng pattern tab "Tham số runtime" hiện có).
5. **A11y:** `role=tab/tabpanel` + `aria-selected` theo tablist sẵn có ·
   progress `aria-live="polite"` (screen reader nghe được tiến độ) · nút chỉ-icon
   có `sr-only` · bảng có `caption sr-only`.
6. **Poll thích ứng — 2 tiền lệ có sẵn, không chế độ mới:** đang chạy session →
   GET 2,5s (`POLL_ACTIVITY_MS` precedent); idle → GET 15s (`POLL_NEURAL_MS`
   precedent). Tab trình duyệt ẩn → dừng hẳn, hiện lại fetch ngay
   (`visibilitychange` precedent). GET lỗi → giữ dữ liệu cũ + chip "mất kết
   nối, đang thử lại" — KHÔNG toast spam (contract 15-a precedent).
7. **Không dependency mới:** mọi hiệu ứng (thanh chạy, nháy hàng đề xuất, chip
   trạng thái) = CSS thuần + Tailwind tokens + keyframes (§9.1-4) +
   `prefers-reduced-motion` chốt (§9.1-5).

### 10.2 UX-6 — State machine 4 trạng thái của thân tab

| Trạng thái | Điều kiện | Nội dung |
|---|---|---|
| **S1 — Chưa thức tỉnh** | `signals.ok = false` (brain ngủ) | Chip "NGỦ" + thanh tiến độ mẫu `current/threshold` theo nguồn nhãn đúng brain (tái dùng `signals` từ `/api/brain` — không API mới) + 1 dòng "Tìm kiếm chỉ có nghĩa khi não đã thức tỉnh (đủ mẫu nhãn) — ngưỡng não này: {threshold}". Không nút chạy. |
| **S2 — Sẵn sàng** | awake, chưa có session chạy | Form: stepper số ứng viên 4–24 bước 4 (trần `SEARCH_MAX_CANDIDATES` = 24 — H3) · seed mặc định tự sinh tất định, HIỆN rõ, cho nhập lại "chạy lại cùng seed" (H4) · 1 dòng ngân sách "≈ 1–3 phút · tối đa 10 phút · ≤ 250K tham số/ứng viên" (H3) · nút primary **"Bắt đầu tìm kiếm"** (icon Play — precedent Training Console). Kết quả session GẦN NHẤT hiển thị phía dưới (nếu có — không che mất thông tin cũ). |
| **S3 — Đang chạy** | status=running | Thanh tiến độ kép: ứng viên `i/N` + % wall-time (max `SEARCH_MAX_WALL_MS`) · 1 dòng rolling log ứng viên gần nhất ("#7 · [128,64] tanh→relu · CV 0,142 · 1,8s") · nút **"Dừng"** (ghost) → `POST /api/brain/search/cancel` (§4.2-2c cooperative) · seed hiện để đối chiếu. `aria-live=polite`. |
| **S4 — Xong** | done / failed / cancelled | Bảng xếp hạng (UX-7) + khối đề xuất + panel predictor (UX-8 khi `brain_hypernas` on). Failed → khối lỗi + error + gợi ý "chạy lại cùng seed {seed} để tái hiện"; cancelled → banner "đã dừng lúc i/N — giữ N' ứng viên đã chấm". |

Chuyển trạng thái theo GET (poll §10.1-6) — không optimistic update: POST xong
đợi GET đầu tiên xác nhận `status=running` rồi mới vào S3 (tránh UI nói dối khi
route chặn 400 — toast đỏ hiện reason).

### 10.3 UX-7 — Bảng xếp hạng + 2 cấp nút áp dụng

**Bảng** (S4): cột `#` · `Kiến trúc` (chuỗi compact `[128,64] tanh·relu` — hàm
format đặt tại `search-space.ts`, dùng chung server/UI — single-source) ·
`Điểm CV` (số chính + `±CI` — bootstrap CI precedent surrogate) · `Tham số`
(`viNum` + % ngân sách 250K) · `Train` (ms) · badge `THẮNG ACTIVE` (amber, khi
`beatActive`). Sort mặc định cvScore desc (cột Float §3.2) — lần đầu không
multi-sort (đơn giản, thêm sau nếu cần). Hàng best `beatActive` viền amber +
nhãn "Đề xuất". ≤ 60 hàng (đã prune H5) — `max-h-96` scroll.

**Dialog chi tiết** (click hàng — precedent `tuning-param-dialog`): spec đầy đủ
bảng nhóm A/B giống Training Console · metrics đầy đủ + so sánh với active ·
nút **"Áp dụng vào nháp"**.

**2 cấp áp dụng (minh hoạ §4.2-4):**

| Nút | Vị trí | Điều kiện bật | Hành vi |
|---|---|---|---|
| **"Áp dụng đề xuất"** | khối đề xuất S4 | ≥ 1 ứng viên `beatActive` — disabled + lý do khi không ai thắng active | Ghi best `beatActive` vào nháp (qua dirty-guard) |
| **"Áp dụng vào nháp"** | dialog chi tiết từng hàng | LUÔN mở (nháp = không gian tự do; runtime vẫn chỉ lên qua A1) | Ghi spec ứng viên đó vào nháp (qua dirty-guard) |

**Dirty-guard:** khi nháp brain đang dirty (chưa lưu) → confirm dialog "Nháp
đang có chỉnh chưa lưu — áp dụng sẽ ghi đè bản trên màn hình. [Huỷ] [Ghi đè]" —
không âm thầm đè mất công việc (tiền đề trung thực FB-BRAIN-UX-R1-03: UI
không đụng bản người dùng đang sửa mà không hỏi).

**Sau áp:** toast "Đã ghi vào nháp — kiểm tra phần 1 · Lưu nháp · Huấn luyện
(A1)" + scroll tới SECTION 1 + nháy hàng editor (focusLayerSignal precedent) +
consoleTab giữ nguyên "Tìm kiếm" (user tự chuyển — không giật tab).

### 10.4 UX-8 — Panel HyperNAS predictor (chỉ khi `brain_hypernas` on)

Panel 1 dòng phía trên bảng (S4) + 3 chip trạng thái:

| Chip | Điều kiện | Copy |
|---|---|---|
| `CHƯA HỌC ĐƯỢC` (xám) | < 40 mẫu cùng fingerprint | "Predictor cần ≥ 40 ứng viên cùng snapshot dữ liệu — hiện {n}" |
| `ĐANG DÙNG` (xanh) | ρ Spearman ≥ 0,3 | "ρ {ρ} · học từ {n} ứng viên cùng fingerprint · giảm ~50% lượt train" |
| `TẠM THÔI` (vàng) | ρ < 0,3 → fail-open random | "Predictor chưa đủ tin (ρ {ρ} < 0,3) — vòng này chạy thuần ngẫu nhiên" |

ρ hiển thị 2 chữ số thập phân (dấu phẩy vi-VN). KHÔNG hiển thị "chính xác %" —
đây là rank correlation: nói thẳng nghĩa "đoán đúng thứ tự hạng" (mapping metric
`MET_NAS_024` / giảm `MET_NAS_015` — §4.3-3/4).

### 10.5 API contract — pin exact shape (test r101)

```ts
// GET /api/brain/search?brain=KEY&runId=<id>  — runId omit = session mới nhất của brain
interface SearchGetResponse {
  ok: true
  run: {
    id: string; brain: string
    status: 'running' | 'done' | 'failed' | 'cancelled'
    seed: number; candidatesMax: number
    progress: { done: number; total: number; elapsedMs: number; wallMsMax: number }
    summary?: { bestCandidateIdx: number | null; nBeatActive: number; durationMs: number }
    error?: string
    dataFingerprint: string // hover chip — đối chiếu Observation ledger (kind search.*)
  } | null // null = chưa có session nào (empty state S2)
  candidates: Array<{ // top theo prune H5 — rỗng khi chưa chấm xong ứng viên nào
    idx: number; archSummary: string
    cvScore: number; ciLow: number; ciHigh: number
    params: number; trainMs: number; beatActive: boolean
    spec: BrainDraftSpec // dialog chi tiết dùng luôn — không fetch thêm
  }>
}
// POST /api/brain/search { brain, candidates?, seed? } → { ok: true, runId } | 400 { ok: false, reason }
// POST /api/brain/search/cancel { runId } → { ok: true } // idempotent (§4.2-2c)
```

encoding 96 chiều KHÔNG trả về client (predictor chạy server-side) — tiết kiệm
payload + không lộ "nguyên liệu nội bộ" chưa cần ở UI.

### 10.6 Responsive & theme

- `≥ md`: bảng 6 cột đầy đủ. `< md`: rút còn 3 cột (`#` · `Kiến trúc` · `Điểm CV`
  + badge) — params/trainMs chuyển vào dialog chi tiết (giữ trên màn hình nhỏ
  đúng thông tin ra QUYẾT ĐỊNH).
- Theme: nguyên token SECTION 3 `nc-amber` — không theme mới (§9.1-4).
- Thanh tiến độ: `h-1.5` track `bg-stone-800` + fill `bg-amber-500/70` + pulse
  KHI đang chạy (reduced-motion → tĩnh).

### 10.7 Copy tiếng Việt chốt sẵn (chống hiểu nhầm "máy quyết định" — R5)

- Tab: **"Tìm kiếm"** · mô tả: "Phòng thí nghiệm tìm kiến trúc — chạy N ứng viên,
  train + kiểm định chéo thật, xếp hạng để bạn duyệt. Không tự thay não vận
  hành."
- Nút: "Bắt đầu tìm kiếm" / "Dừng" / "Áp dụng đề xuất" / "Áp dụng vào nháp"
- Empty (chưa có session): "Chưa có phiên nào — bấm Bắt đầu tìm kiếm"
- Failed: "Phiên lỗi: {error} — chạy lại cùng seed {seed} để tái hiện"
- Cancelled: "Đã dừng ở {i}/{N} — giữ {N'} ứng viên đã chấm"

### 10.8 Test UI (gộp trong r101/r102)

pin GET shape §10.5 · tab ẩn khi `brain_search` off · S1 copy hiển thị đúng
ngưỡng từ registry (không hardcode số) · progress có `aria-live` · bảng ≤ 60 hàng
+ bọc `max-h-96` · nút touch ≥ 44px mobile · dirty-guard confirm chỉ xuất hiện
khi dirty thật · 2 nút áp dụng đúng điều kiện bật bảng §10.3.

---

*Ngày soạn: 2026-10-13 · v0.1 Task 21 · hiệu đính v0.2 Task 22 (worklog
`/home/z/my-project/worklog.md`) · Bổ sung cho BLUEPRINT-BRAIN-P1-P5.md v0.12 —
mọi bất biến A1–A7 của brain giữ nguyên hiệu lực cho blueprint này.*
