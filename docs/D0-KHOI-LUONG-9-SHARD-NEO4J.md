# BÁO CÁO D0 · ĐO KHỐI LƯỢNG 9 SHARD knowledge/ + TRIAL INGESTION NEO4J — QUYẾT ĐỊNH ĐỢT ÁNH XÀ CÒN LẠI

> Task R24-a — phase D0 blueprint EVO-NAO (§0.2 hàng D0, §9, §10 Q5/Q9 —
> [BLUEPRINT-EVO-NAO-P1-P5.md](./BLUEPRINT-EVO-NAO-P1-P5.md)). Số liệu ghi ngày
> **2026-10-17**, môi trường **sandbox AuraDB** (Neo4j Aura free-tier,
> `neo4j+s://6e688b02…` — 96.354 node / 205.809 rel trước D0, đo R22 cùng ngày).
> Nguồn số liệu: `scratch/r24-d0-measure.json` (đo chính 09:35–10:01 UTC + 5 phiên
> gap-fill 10:39→12:32 — 9/18 mẫu LLM thành công),
> `scratch/r24-d0-graph-stats.json` (before/after trial), `scratch/r24a-iterate.log`
> (biên niên trial), `dev.log`, truy vấn Cypher đối chứng.

---

## 0 · MỤC TIÊU + QUYẾT ĐỊNH

- **Q9 = CÓ (chốt 2026-10-16):** thêm phase D0 — ánh xạ 9 shard `knowledge/`
  (2,14 MB) vào Neo4j bằng ingestion sẵn có (LLM extraction + entity-resolver,
  additive merge H5).
- **Q5 (đề xuất, chưa chốt):** ingestion đầy đủ chạy trên máy **USER** (Neo4j
  Desktop ~53.742 node); sandbox AuraDB **đo khối lượng thật + ingestion THỬ 1
  shard nhỏ nhất** để ước node tăng TRƯỚC khi quyết đợt còn lại — trial này
  chính là bước "ước trước khi quyết" của Q5.
- **Shard thử = `SHD_NAS_EVOLUTION_002.TXT`** (nhỏ nhất 146 KB + ưu tiên cao
  nhất §9 — phục vụ trực tiếp đợt EVO cùng GEN_CAUSAL_HYPER_001).

## 1 · PHƯƠNG PHÁP ĐO

1. **Cấu trúc** (đo chính xác, không LLM): bytes/dòng trên file gốc; blocks đếm
   marker `^(?:- )?(NODE_ID|RULE_ID|DYNAMIC_ID|METRIC_ID):` theo cấu trúc 5 lớp
   của [KNOWLEDGE-PARTITION.md](../knowledge/KNOWLEDGE-PARTITION.md) (gộp cả
   dạng YAML-list `- NODE_ID:` của shard 001); tokens = `estimateTokenCount` lib
   (chars/4) trên text đã normalize đúng như route `.txt` mới.
2. **Chunks thật**: `chunkText` bản lib `pdf-parser.ts` domain `ml`
   (640 tokens/overlap 96 — đã đối chiếu trùng khớp cấu hình `DOMAIN_CONFIGS.ml`
   bản route-local trong process route; khác biệt duy nhất là 2 bản code copies,
   số chunks như nhau). Trang ảo = `max(1, round(tokens/1800))` — cùng công thức
   `syntheticPageCountForText` route R24-a (KPI `chunks_per_page` ∈ [0.3, 8]).
3. **Entity-rate mẫu (ƯỚC LƯỢNG)**: mỗi shard 2 chunk đại diện (đầu `#0` + giữa)
   → `callLLMSlot(-1, chunk, buildSystemPrompt('ml'), 'extraction', {maxTokens:
   16384})` — **đúng prompt extraction thật** (export từ process route, không
   copy), parse JSON + **orphan filter** (entity phải nằm trong ≥1 relationship)
   đúng pipeline. Retry 4 lần/backoff 8-16-24s, fail-open (skip + ghi nhận).
   **Mẫu 2 chunk/shard là ước lượng thô** — không thay thế extraction đầy đủ;
   hiệu chỉnh bằng trial thật ở §3.
4. **Trial 002**: upload `.TXT` qua `/api/ingestion/upload` (domain `ml`) →
   process async → đo `getGraphStats()` trước/sau + Cypher đếm merge
   (occurrence_count + created_at window — nhiều lượt reExtract làm occurrence
   phình, created_at là mốc tạo node chính xác) + SQLite LocalEntity/
   LocalRelationship count + wall-time từng bước từ dev.log/biên niên.

> Ghi chú môi trường đo: NVIDIA NIM `nvidia/nemotron-3-ultra-550b-a55b` (model
> extraction duy nhất theo R19 — không fallback) gặp **sóng 503/502 server_error
> kéo dài** gần như liên tục từ 10:30 tới quá 12:32 UTC (probe 12:19 + 12:32 vẫn
> FAIL fail-fast ~730ms; sóng ngắn 1–3 phút từng quan sát ở đợt đo chính 09:35
> và các cửa sổ gap-fill 10:39/12:16). Ảnh hưởng: 3 shard chưa có mẫu entity-rate
> (đánh dấu N/A), 3 shard chỉ 1/2 mẫu, trial phải chạy ~25 lượt — chi tiết §3.
> KHÔNG gặp lỗi 429 rate-limit — chỉ 503/502 + TIMEOUT-BREAKER (call hang).

## 2 · BẢNG ĐO 9 SHARD

| Shard | Bytes | Dòng | Blocks (N+R+D+M) | Est-tokens | Chunks (ml) | Trang ảo | Chunks/trang | Entity-rate mẫu/chunk | Est entities raw |
|---|---:|---:|---|---:|---:|---:|---:|---:|---:|
| SHD_GEN_CAUSAL_HYPER_001 | 208.622 | 3.569 | 308 (120+69+69+50) | 43.640 | 80 | 24 | 3,33 | 27,5 (2/2) | 2.200 |
| **SHD_NAS_EVOLUTION_002** | **146.037** | 2.945 | 253 (125+48+40+40) | 31.205 | **58** | 17 | 3,41 | 17,5 (2/2) | 1.015 |
| SHD_OPT_CONVEX_003 | 118.466 | 2.245 | 170 (83+32+20+35) | 25.056 | 46 | 14 | 3,29 | 25,5 (2/2) | 1.173 |
| SHD_SYS_DYNAMICS_004 | 150.228 | 2.981 | 232 (102+42+43+45) | 31.685 | 59 | 18 | 3,28 | N/A (sóng 503) | N/A |
| SHD_CORE_GRAPH_005 | 171.126 | 3.599 | 280 (140+70+70+0) | 36.246 | 67 | 20 | 3,35 | 15,0 (1/2 mẫu) | 1.005 |
| SHD_COMPLEXITY_006 | 337.669 | 6.037 | 500 (200+100+100+100) | 71.122 | 131 | 40 | 3,27 | 8,0 (1/2 mẫu) | 1.048 |
| SHD_DSL_007 | 355.852 | 6.440 | 500 (200+100+100+100) | 74.834 | 138 | 42 | 3,29 | 8,0 (1/2 mẫu) | 1.104 |
| SHD_GTH_008 | 349.702 | 5.934 | 500 (200+100+100+100) | 72.928 | 134 | 41 | 3,27 | N/A (sóng 503) | N/A |
| PSY-CORE-SCI-009 | 401.469 | 2.047 | 600 (300+100+100+100) | 84.428 | 155 | 47 | 3,30 | N/A (sóng 503) | N/A |
| **TỔNG** | **2.239.171** (2,14 MB) | 35.797 | 3.343 | 471.144 | **868** | 253 | ~3,3 | — | ~7.545 (6 shard có mẫu) |

- Blocks đếm được khớp cấu trúc khai báo KNOWLEDGE-PARTITION §2 (ví dụ 006/007/008
  đúng 500, 009 đúng 600, 005 đúng 280 và **không có METRIC** — quirk đã ghi).
  Tổng ~3.343 khối ≈ con số "~2.200 khối" của bản đồ là ước tính thấp cũ
  (009 thật có 600 khối + 001 format YAML-list đếm được 308).
- **`chunks_per_page` mọi shard ~3,3 ∈ [0.3, 8]** — công thức trang ảo 1800
  tokens giữ KPI P5-M4 đo được và PASS toàn bộ (không rơi "chưa đo được").
- **Entity-rate mẫu 8–27/chunk VƯỢT xa ngưỡng warn [0.2, 6]** của P5-M4 —
  không bất ngờ: shard là tri thức cấu trúc (mỗi block ~1 entity định nghĩa
  `ENTITY_NAME`), khác văn xuôi PDF mà ngưỡng này hiệu chuẩn. Trial thật cho
  entity_rate = 14,14 (WARN — xem §3); doc vẫn index bình thường vì severity
  'warn' không chặn (đúng thiết kế P5-M4).

## 3 · KẾT QUẢ THẬT — TRIAL SHD_NAS_EVOLUTION_002.TXT (sandbox AuraDB)

**Tiến trình** (UTC, 2026-10-17 — biên niên `r24a-iterate.log` + `dev.log`):

| Bước | Thời điểm | Wall-time | Ghi chú |
|---|---|---|---|
| Upload (POST, domain `ml`) | 10:00:24 | 377 ms (HTTP 200) | R2 backup `pdfs/` 146.037 B + `/tmp/theopus-uploads/` + Document row + Qdrant `theopus_documents` point; sha256 không trùng (không dính dup gate 409) |
| Pass fresh (async, 4 worker) | 10:00:24 → ~10:25 | ~25 phút | Sóng 503/502 NIM ngay từ đầu — "High LLM failure rate: 57/58 chunks returned empty" ở wave cuối; kết thúc `indexed` với 310 LocalEntity / 19 chunk có entities |
| Vòng reExtract (iterate.sh 14 pass + driver.sh + thủ công) | 10:25 → 11:55 | ~90 phút | ~24 lượt POST `reExtract=true` (chỉ extract lại chunk thiếu); mỗi pass MERGE additive, xóa đúng quan hệ của doc (H5 — không xóa node) |
| Hoàn tất (updatedAt cuối) | 11:57:36 | **tổng ~117 phút** | P5-M4 fail=0 warn=1; Supabase auto-backup fire-and-forget |

**Kết quả cuối** (SQLite, documentId `c46fdb42-4bc5-4cea-8822-635c3c8efb3e`):
- 58 chunks (domain ml, 640 token/overlap 96), **49/58 chunk có entities (84,5%)** — 9 chunk
  thiếu do NIM chết hoàn toàn ở các pass cuối ("9/10 chunks returned empty results");
  chạy lại reExtract khi NIM khỏe sẽ lấp nốt (MERGE additive, không mất dữ liệu).
- **820 LocalEntity, 683 LocalRelationship**; embeddings **58/58 chunk có vector thật**
  (2048d `nemotron-3-embed-1b` — embed model khỏe, chỉ extraction model bệnh).
- KPI P5-M4: `chunks_per_page` 58/17 = **3,41 ∈ [0.3, 8] PASS** (công thức trang ảo giữ
  đúng vai trò); `relationship_per_entity` 683/820 = **0,83 ∈ [0.2, 4] PASS**;
  `entity_rate` 820/58 = **14,14 NGOÀI [0.2, 6] → WARN** (severity warn không chặn —
  shard là tri thức cấu trúc, mỗi block ~1 entity `ENTITY_NAME` định nghĩa sẵn, khác
  văn xuôi PDF mà ngưỡng hiệu chuẩn).

**Neo4j** (before 09:10:44 → after 12:12:54 — `getGraphStats` + Cypher đối chứng):
- **96.354 → 96.762 node (+408)** · **205.809 → 206.970 rel (+1.161)**.
- Phân rã +408: **405 entity node MỚI** (đếm chính xác theo `created_at` window +
  CONTAINS của doc) + 1 node Document (upload) + 2 node hoạt động nền app
  (Episode/Session — openclaw logging, không phải trial).
- Footprint doc (lượt ghi cuối): **523 entity node dedup + 631 relationship + 523
  CONTAINS** (truy vấn trực tiếp đếm 522 — chênh 1 node ghi trùng).
- **MERGE vs MỚI: 405 mới (77,6%) / 117 merge vào node sẵn có (22,4%)** trên 522
  unique entity doc chạm — phân theo `created_at` window (occurrence_count không dùng
  được: ~25 lượt reExtract làm phình đa số node lên 14–19).
- +1.161 rel = 523 CONTAINS + **575 rel có `documentId`** (APPLIES_TO 157 · ENABLES 84
  · PART_OF 72 · DEPENDS_ON 70 · USES 68 · DOCUMENTED_IN 43 · CONTRASTS_WITH 38 ·
  MITIGATES 18 · CREATED_BY 7 · ALTERNATIVE_TO 6 · EXTENDS 4 · IMPLEMENTED_IN 3 ·
  RELATED_TO 3 · EXPLOITS 2) + ~63 rel hoạt động nền app (PART_OF_SESSION, PRODUCED…).
- Label delta (node mới): Concept +268 · Framework +37 · Domain +39 · Technology +21 ·
  Principle +23 · Document(entity) +14 · Person +2 · Vulnerability +1 (+ upload 1).
- Lỗi ghi nhận: **không có 429** — chỉ 503/502 server_error (fail-fast R19 2 key rồi
  dừng) + TIMEOUT-BREAKER (call hang) trong suốt 10:00–12:32.

**Đối chiếu ước lượng mẫu §2 → thực tế** (hệ số hiệu chỉnh cho §4): est raw 1.015 →
thực 820 local (×0,81) → 522 unique graph (×0,51) → 405 node mới (×0,78). Tức
**node mới ≈ raw × 0,40**.

**Ghi chú community-detect:** một job Leiden nền **TỰ KÍCH HOẠT một lần** trong cửa sổ
trial (log "Chưa có community embeddings — tự động chạy detection nền": TASK 52 compact
bỏ 9.972 isolated node → 84.659 node/203.092 cạnh, viết `communityId` cho 83.217/83.217
node + tái tạo collection `theopus_communities`) — D0 KHÔNG chủ động chạy (đúng ràng
buộc); job chỉ ghi property, không tạo/xóa node → không ảnh hưởng delta ở trên. Bằng
chứng empirical: Leiden 84K node chạy xong trên sandbox 4 GB/2 core (~5 phút, không
OOM) — nhưng communityId của node tạo sau job này chưa có, xem khuyến nghị §5.

## 4 · NGOẠI SUY 9 SHARD + QUOTA AURA FREE-TIER

Áp hệ số hiệu chỉnh từ trial 002 (raw ×0,51 → unique graph; ×0,78 → node mới; tức
**node mới ≈ raw × 0,40**). Shard chưa có mẫu (004/008/009) dùng **median entity-rate
16,3/chunk** của 6 shard có mẫu — ước lượng thô, ghi rõ nguồn:

| Shard | Chunks | Raw (nguồn) | Unique graph (×0,51) | Node mới (×0,40) |
|---|---:|---:|---:|---:|
| SHD_GEN_CAUSAL_HYPER_001 | 80 | 2.200 (mẫu 2/2) | ~1.130 | ~880 |
| **SHD_NAS_EVOLUTION_002** | **58** | **1.015 (mẫu)** | **522 (THỰC)** | **405 (THỰC)** |
| SHD_OPT_CONVEX_003 | 46 | 1.173 (mẫu 2/2) | ~600 | ~470 |
| SHD_SYS_DYNAMICS_004 | 59 | ~960 (median) | ~490 | ~385 |
| SHD_CORE_GRAPH_005 | 67 | 1.005 (mẫu 1/2) | ~520 | ~400 |
| SHD_COMPLEXITY_006 | 131 | 1.048 (mẫu 1/2) | ~540 | ~420 |
| SHD_DSL_007 | 138 | 1.104 (mẫu 1/2) | ~570 | ~440 |
| SHD_GTH_008 | 134 | ~2.180 (median) | ~1.120 | ~870 |
| PSY-CORE-SCI-009 | 155 | ~2.520 (median) | ~1.290 | ~1.010 |
| **TỔNG 9 shard** | **868** | **~13.200** | **~6.800** | **~5.270** |

- **8 shard còn lại ≈ +4.860 node mới** (điểm), khoảng tin cậy **+2.600 … +8.900**
  (thưa như 006 ~8/chunk … dày như 001 27,5/chunk). Mẫu 2 chunk/shard là ƯỚC LƯỢNG —
  005/006/007 chỉ 1 mẫu (chunk #0 là phần mở đầu shard, thường thưa entity hơn phần
  thân); số THỰC chỉ có ở 002.
- **Quota Aura free-tier (200K node / 400K relationship)**:
  - Node: 96.762 (48,4%) + ~4.860 → **~101.600 ≈ 50,8%** (kịch bản xấu ~106.300 = 53,2%).
  - Relationship: 206.970 (51,7%) + 810 chunk × ~19 rel/chunk ≈ +15.400 →
    **~222.400 ≈ 55,6%**.
  - **Kết luận: AN TOÀN quota** — ingest nốt 8 shard không đẩy Aura tới vùng nguy hiểm.
- **Token NIM**: mẫu đo tốn 6,3–10,0K token/chunk-call (~8,2K trung bình) → đủ 9 shard
  ≈ **~7,1M token extraction** (chưa tính lượt retry do sóng 503 — riêng trial 002 cần
  ~25 lượt chạy). Tổng NIM tiêu thụ cả ngày 2026-10-17 (đo + gap-fill + trial + embed +
  nền app) ~764K token (TokenTracker).

## 5 · KHUYẾN NGHỊ

1. **Ingest nốt 8 shard trên Aura sandbox: CÓ THỂ** — quota an toàn (~51% node / ~56%
   rel sau khi xong tất cả). Quota KHÔNG còn là lý do phải đợi máy user; lựa chọn máy
   user (Q5 gốc) giờ chỉ là ưu tiên vận hành.
2. **Thứ tự đề xuất** (002 ✅ xong): **GEN_CAUSAL_HYPER_001** (ưu tiên cao nhất §9 cho
   đợt EVO) → OPT_CONVEX_003 + CORE_GRAPH_005 (nhỏ) → SYS_DYNAMICS_004 →
   COMPLEXITY_006 / DSL_007 / GTH_008 (lớn) → PSY-CORE-SCI-009 chót (lớn nhất + domain
   psychology — tránh trộn cửa sổ phân loại).
3. **Điều kiện vận hành**: NIM extraction đang bệnh 503/502 kéo dài (10:30→12:32+ hôm
   nay, probe fail-fast ~730ms) — trial 002 cần ~25 lượt trong 117 phút. Trước mỗi
   shard: probe NIM (`scratch/r24a-nim-probe.ts`), chạy khi khỏe, dùng driver reExtract
   (`scratch/r24a-driver.sh` — pass tới khi đủ phủ chunk), kiểm quota sau mỗi shard lớn
   (`scratch/r24-d0-graph-stats.ts before`). NIM vẫn sóng → đợi máy user là phương án
   dự phòng hợp lệ nhưng KHÔNG còn bắt buộc.
4. **9 chunk thiếu của 002**: chạy lại reExtract khi NIM khỏe (1 lệnh POST, driver có
   sẵn) — MERGE additive, không mất dữ liệu, không xóa node (H5).
5. **Community-detect (Leiden) — ĐÃ CHẠY R39 (16:31 UTC 2026-10-18, user duyệt "1 đến 3")**:
   compact bỏ 10.518 isolated → Leiden 90.018 node/210.600 cạnh (47,8s) → **1.069 cụm
   thô → 351 cụm đạt ngưỡng ≥3 members** → viết communityId 88.582/88.582 node hợp lệ
   (0 skipped, bulk elementId chunk) → tái tạo theopus_communities 351/351 summary
   embed. Chất lượng: modularity 0,8329 · silhouette 0,8711 · DBI 3,31 (351 điểm/6
   domain). Tổng thời gian 166s. Node không có communityId = 10.518 isolated + 1.436
   thuộc cụm <3 members — đúng thiết kế, không phải lỗi. Hai lần chạy liên tiếp cho
   kết quả deterministic giống hệt (166s/157s). Script: `scripts/refresh-communities.ts`
   (pm2 wrapper `scratch/r39-communities.sh` — lưu ý pm2 autorestart exit-0: chạy 1-shot
   bằng lệnh trực tiếp hoặc `--max-restarts 0`).
6. **9 chunk × 3 shard N/A trong bảng mẫu** (004/008/009): không chặn quyết định (ngoại
   suy dùng median + khoảng tin cậy đã rộng); có thể đo bổ sung mẫu khi NIM khỏe nếu
   muốn thu hẹp khoảng.

## 6 · PHỤ LỤC — CỬA SỔ VẬN HÀNH D0

- **Code .txt additive (R24-a):** upload route chấp nhận `.txt` (case-insensitive
  + mime text/plain|application/octet-stream|"" — mọi check khác giữ nguyên:
  ≤50 MB, sha256 dup gate 409, R2 backup tiền tố `pdfs/`, Document row + Qdrant
  point); process route nhánh `.txt` đọc utf8 + synthetic pageCount (comment
  giải thích tại chỗ); `buildSystemPrompt` + `chunkText` export cho script đo
  (single-source, không copy prompt). Đường `.pdf` hành xử verbatim như trước —
  mọi call site cũ giờ qua `extractTextForDocument` với nhánh pdf giữ nguyên
  `extractPDFText`.
- **Defer community-detect (Leiden):** D0 KHÔNG chủ động chạy (ràng buộc task).
  Lưu ý empirical từ §3: job nền TỰ KÍCH HOẠT 1 lần trong trial đã chạy thành
  công trên sandbox 4 GB/2 core (84.659 node, ~5 phút, không OOM) — rủi ro OOM
  ước tính trước đó là thận trọng quá; vẫn giữ defer cho D0, chạy lại sau khi
  ingest đủ 9 shard (chờ user duyệt — §5).
- **Ràng buộc tôn trọng:** không xóa node đồ thị (H5) — pipeline chỉ ghi
  (MERGE) và xóa QUAN HỆ của chính doc khi re-extract (node giữ nguyên,
  occurrence_count tăng); không restart pm2/build/đổi port; không in secrets.
- **Artifact D0** (scratch/, chạy bằng `bun`, tự nạp `.env` từ cwd —
  `env -u DATABASE_URL` nếu shell có sẵn biến môi trường này):
  `r24-d0-measure.ts` (đo chính) · `r24-d0-measure-gapfill.ts` (gọi lại mẫu lỗi,
  ghi incremental — 5 phiên, lịch sử trong JSON) · `r24-d0-graph-stats.ts
  before|after <docId>` · `r24a-chunk-coverage.ts <docId>` · `r24a-nim-probe.ts`
  · `r24a-iterate.sh` / `r24a-driver.sh` (vòng reExtract chống sóng 503) · JSON:
  `r24-d0-measure.json`, `r24-d0-graph-stats.json` · log: `r24-d0-measure.log`,
  `r24a-iterate.log`, `r24-d0-gapfill.log`, `r24-d0-measure.attempt1-nim503.log`.
- **Gate D0:** eslint 8 file đổi = 0 lỗi · `tsc --noEmit` (max-old-space 1200) =
  0 lỗi · test r110 + 6 file ingestion (r76, r78-doc-dedup, r78-entity-nb,
  r78-fb7-regression, r78-pipeline-expectations, r81) = **163 pass / 0 fail**
  (1.038 expect) · KHÔNG viết test mới (D0 test = "—" theo task).

---

## 7 · R38 (2026-10-18) — RE-INGESTION SAU RESET · 9/9 SHARD HOÀN TẤT

**Bối cảnh.** Sandbox reset xóa sạch `qdrant-storage/` (theopus_chunks + theopus_documents → 0 điểm —
root cause 6 alert thế hệ 2 R36: eval-starvation, train-gate ×3 não, KB mù) trong khi Neo4j Aura cloud
(ngoài sandbox) và SQLite (cron DB-BACKUP 03:00 VN → R2, restore) sống nguyên. Đúng kịch bản thiết kế
sẵn: FIX #6 route process (khôi phục Qdrant doc point từ R2 `pdfs/`), nhánh upload `.txt` R24-a,
`reExtract` chỉ điền chunk thiếu (MERGE additive H5 — không xóa node).

**Trở ngại vận hành + xử lý.** Lõi extraction z-ai/glm-5.3-flash (R25) chuyển sang sóng hang:
timeout 196s, empty-content finish=none — 001 fail 80/80 chunks ngay pass đầu (11:05). Observation
protocol bắt live `model.failover` (tự chứng minh giá trị — đúng bệnh phải mổ). Probe độc lập:
nemotron-3-ultra-550b-a55b 1.75s OK (nghịch sóng với R25 sáng nay — hai model thay phiên khỏe/bệnh
trong ngày). Xử lý theo chính sách R25 tự ghi ("Khôi phục nemotron khi NIM khỏe lại"):
`EXTRACTION_MODEL=nvidia/nemotron-3-ultra-550b-a55b` trong `.env` + llm.ts đọc env lúc module load
(1 dòng + JSDoc R38) + pm2 restart 10:58 — extraction phục hồi ngay (5941-8720 tokens/call đều).

**Trình tự (đúng §5.2 + xếp nhóm rút wall-clock).** G1(001+002) → G2(003+005) → G3(004) →
G4(006+007+008) → G5(009 PSY chót). 002: plain POST → FIX #6 + chunk-rebuild (58/58 vector thật,
entities preserved) → reExtract pass lấp nốt 9 chunk thiếu §5.4 → covNew 58/58 (graph đủ phủ toàn
bộ chunk id hiện tại). 8 shard còn lại: upload → pipeline → driver verify real-vector từng doc.

**Kết quả per-shard** (driver verify bằng scroll with_vector — vector thật ≠ zero-vector, ROUND-34):

| Shard | Chunks kỳ vọng (§1) | Điểm thật Qdrant | Vector thật | Thời điểm DONE |
|---|---|---|---|---|
| 001 GEN_CAUSAL_HYPER | 80 | 80 | 80/80 | 11:21:28 |
| 002 NAS_EVOLUTION (+lấp 9 chunk §5.4) | 58 | 58 | 58/58 + covNew 58/58 | 11:29:49 |
| 003 OPT_CONVEX | 46 | 46 | 46/46 | 11:44:56 |
| 005 CORE_GRAPH | 67 | 67 | 67/67 | 11:49:56 |
| 004 SYS_DYNAMICS | 59 | 59 | 59/59 | 12:09:23 |
| 006 COMPLEXITY | 131 | 131 | 131/131 | ~13:00 (verify 13:03)
| 007 DSL | 138 | 138 | 138/138 | ~13:00 (verify 13:03)
| 008 GTH | 134 | 134 | 134/134 | ~13:00 (verify 13:03)
| 009 PSY-CORE-SCI | 155 | 155 | 155/155 | 13:51:29 |

(Ô _G4_/_G5_ điền khi driver khép — xem §7.1 tổng kết cuối.)

**Chứng minh đường KB sống** (search trực tiếp Qdrant 2048-dim, nemotron-3-embed-1b):
"neural architecture search evolution" → top-hit đúng SHD_NAS_EVOLUTION_002 (score 0.475);
"convex optimization duality" → đúng SHD_OPT_CONVEX_003 (0.423). Eval case security cũ (seed R33,
thời corpus PDF hacking) mismatch domain corpus mới → refusal đúng thiết kế (KB không phủ domain
đó) — cân eval case knowledge-domain ở đợt sau, không phải lỗi re-ingestion.

**Vận hành + bài học.** Driver chạy dưới pm2 (name `d0-driver`, script `scratch/r38-d0-run3.sh` +
`scratch/r38-coverage-new.ts` — commit kèm): per-doc subshell song song trong group, tự xử lý
error (PUT recover) / partial (reExtract), verify real-vector + covNew cho 002. Bài học: (a) đường
dẫn tương đối trong session shell trỏ nhầm chỗ — luôn tuyệt đối; (b) process nền trần trọi bị
kill vô hình giữa các tool call — pm2 là chỗ đứng đúng cho driver dài hạn; (c) probe model phải
đủ maxTokens cho model reasoning (glm đốt 16 tokens probe trước khi kịp trả lời).

### 7.1 · Tổng kết cuối (13:51:29 UTC 2026-10-18)

- **Qdrant**: theopus_chunks **868/868 điểm — 100% vector thật** (zero-vector=0, stamp model
  `nvidia/nemotron-3-embed-1b@2026-10-17`) · theopus_documents **9/9**. So khớp CHÍNH XÁC ước lượng
  §1 (868 chunks kỳ vọng — không thừa không thiếu).
- **Neo4j**: 96.970 → **103.119 nodes (+6.149)** · rels 205.809 → **215.249 (+9.440)** — toàn bộ qua
  MERGE additive H5 (re-extract idempotent, không xóa node; occurrence_count tăng).
- **Cơ sở dữ liệu 002**: 58/58 vector + covNew 58/58 — khoản "9 chunk thiếu" §5.4 đóng cửa vĩnh viễn.
- **Thời lượng**: 10:29 (khảo sát) → 13:51 (shard chót verify) ≈ 3.5 giờ, trong đó mất ~50 phút
  cho chẩn đoán + switch lõi extraction (glm hang) — thuần ingestion ~2.5 giờ cho 868 chunks.
- **Bài học thêm (d)**: deadline driver 45ph/doc với shard lớn (131-155 chunks) là chật — 3 shard G4
  xong server-side nhưng driver timeout trước (verify thủ công bù; may pm2 restart driver kịp
  verify lại toàn bộ). Lần sau scale deadline theo kỳ vọng chunks (≥0.5 phút/chunk).
- **Snapshot R2 ngay sau ingest** (đường khôi phục nhanh cho reset kế tiếp — xem lệnh ở §7.2).

### 7.2 · Vận hành cho reset sau này

```bash
# 1) Backup Qdrant → R2 (tar ~1-3s cho 868 chunks):
curl -X POST 'http://localhost:3000/api/storage/snapshot-full?store=qdrant' --max-time 300
# 2) Backup SQLite (để cron 03:00 VN tự lo, hoặc chủ động):
curl -X POST 'http://localhost:3000/api/storage/db-backup' --max-time 600
# 3) Khi sandbox reset: restore từ R2 (giây) thay vì re-ingest (giờ):
curl -X POST 'http://localhost:3000/api/storage/restore-full?store=qdrant' --max-time 300
```

### 7.3 · Hậu D0 R39 (16:20-17:00 UTC 2026-10-18) — user duyệt "1 đến 3"

Sau khi D0 §7.1 đóng, user duyệt 3 mục còn hở (nguyên văn: "Duyệt từ 1 đến 3 riêng 3
giữ nemotron vì lõi này trích xuất ổn định. GLM 5.3 Flash chủ yếu dùng để xử lý tác vụ
thôi"):

1. **Community-detect Leiden §5.5 — XONG** (kết quả đầy đủ ở §5 mục 5): 88.582/88.582
   node hợp lệ có communityId mới · theopus_communities 351 điểm xanh · Q=0,8329.
2. **Eval case knowledge-domain — XONG**: `scripts/seed-eval-knowledge.ts` seed 27
   case hand-crafted bám ENTITY_NAME/DESCRIPTION_SHORT thật của 9 shard (3/shard,
   category `knowledge`, source `d0_corpus`, difficulty e8/m13/h6) — lấp mismatch domain
   R38 (EvalCase cũ toàn programming/algorithm/ml + security → 100% refusal).
   **Kết quả run đầu sau seed (runId cmve1zdpd...): answered 23/27 (coverage 0,85) ·
   refusal 4 · recall@5 0,74 · nDCG@5 0,75 · MRR 0,73 · f1 0,70 · hallucination 0** —
   đường KB thật hoạt động (so với 0/27 trước seed). 4 refusal + faithfulness 0,42
   (judge nemotron chặt) là tín hiệu thật để tinh chỉnh query phrasing/case sau.
   Lưu ý vận hành: run đầu tiên 0/27 do answer model SBF (Zen) chết 404 từ sandbox +
   judge kimi-k3 EOL 410 — observation protocol bắt live model.failover ×2 + alert
   eval-starvation; chữa bằng env override thiết kế sẵn R4: EVAL_ANSWER_MODEL=
   glm-5.3-flash (lõi tác vụ R39) + EVAL_JUDGE_MODEL=nemotron-550b (cross-model) +
   EVAL_JUDGE_FALLBACK_MODEL=deepseek-v4.1-flash (xem khối .env R39).
3. **Chính sách lõi — USER CHỐT**: extraction = `nvidia/nemotron-3-ultra-550b-a55b`
   mặc định trong code (llm.ts R39 — env EXTRACTION_MODEL giữ làm pin tường minh +
   đường xoay khẩn cấp); `z-ai/glm-5.3-flash` chuyển hẳn sang agent/chat + xử lý tác vụ
   (vẫn NVIDIA_AGENT_MODELS[0]). Health route note cập nhật theo.

Ghi chú vận hành thêm: pm2 wrapper cho script 1-shot cần `--max-restarts 0` (exit 0 vẫn
bị pm2 autorestart — R39 dính 2 lần chạy thừa, may kết quả deterministic giống hệt).
