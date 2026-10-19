# BLUEPRINT BACKUP-GATE P1-P6 — ĐỘ BỀN LƯU TRỮ + KHÉP CHẶT LƯỚI KIỂM (v0.2)

> **Phiên bản:** 0.2 — 2026-10-19 (review v0.1→v0.2 theo directive user "Vào vai kỹ sư AI tiến hành review lại file" — đối chiếu toàn bộ tuyên bố với code HEAD + đo live; **15 hiệu đính**, cấu trúc P/S/W giữ nguyên; 3 lỗi thực sự: glob nguồn backfill sai 8/9 · lý do loại `theopus_episodes` sai logic dưới chính sách restoreIfEmpty · S5 hardcode 1/2 remote — chi tiết §9). Bản 0.1 — 2026-10-19: gom 6 việc theo directive "nhiều việc → viết blueprint trước".
> **Phương pháp:** mọi việc gom từ 4 nguồn có ghi chép: (1) kết luận W3-REGTEST-1 (8b chờ tín hiệu, BUG2-304 chờ duyệt); (2) 2 mục GHI-NHẬN-KHÔNG-làm của đợt REQ-AUDIT (91dadae); (3) 4 điểm yếu trong đánh giá 7 lớp regression test (phiên 2026-10-19); (4) BUG2-304 (Bug_v2 306 entries). Mọi con số ĐO LIVE ngày 2026-10-19 kèm đường tái hiện — không số tự khai.
> **Ký hiệu:** P1–P6 = 6 vấn đề · S1–S6 = giải pháp map 1-1 · W1–W2 = 2 wave triển khai.

---

## 0. TÓM TẮT — BẢNG 6 VIỆC

| # | Việc | Nguồn phát hiện | Mức | Wave | Effort | Khuyến nghị |
|---|---|---|---|---|---|---|
| **P1/S1** | Backup Qdrant chỉ snapshot 1/6 collection — `theopus_documents`/`agent_memory`/`task_context` mất vĩnh viễn sau reset | BUG2-304 (W3-8c, 44578f9) | **P2 — rủi ro mất dữ liệu thật** | W1 | ~2h | **Làm ngay — ưu tiên cao nhất** |
| **P2/S2** | Quality gate không có coverage — regression trong file đã-test không bị phát hiện (giới hạn: file chưa-test xem §4-S2) | Đánh giá regression (phiên 2026-10-19) | P3 | W1 | ~1h | Làm (ratchet theo baseline, không bar tuyệt đối) |
| **P3/S3** | 13 e2e + 34 scratch verify chạy thủ công — không có tầng nào giữa "unit mock" và "e2e cần LLM sống" | Đánh giá regression | P3 | W2 | ~1,5h | Làm ở mức smoke read-only (KHÔNG fake e2e) |
| **P4/S4** | Gate PASS dù build chưa hề chạy (skipBuild local) — verdict "được phép push/merge" dễ tin nhầm | Biên bản REQ-AUDIT (OOM exit 137) | P3 | W2 | ~30m | Làm (minh bạch hóa skip, không cố chữa OOM) |
| **P5/S5** | Branch protection GitHub bật thủ công — không có gì kiểm tra (2 remote — phải kiểm cả hai) | Comment quality-gate.yml | P4 | W2 | ~30m | Làm (script warn-only) |
| **P6/§7** | 3 quyết định treo: gộp poller Smolab · micro-cache stats · 8b NIM utility | REQ-AUDIT-1-FIX + W3-REGTEST-1 | — | — | 0 | Chốt tại §7: 2 mục TỪ CHỐI, 1 mục giữ chờ tín hiệu |

---

## 1. BỐI CẢNH — 4 NGUỒN GOM + ĐƯỜNG TÁI HIỆN

1. **W3-REGTEST-1 (commit 44578f9):** khi restore 8c phát hiện `backupQdrantToR2` (qdrant-snapshot.ts:143) hardcode đúng 1 collection `theopus_chunks` — tar R2 `latest.tar` 27.193.856 B không chứa collection nào khác. Đo live 2026-10-19 19:02: `theopus_documents`=0 (D0 §7.1 từng verify 9/9 lúc 13:51 18-10) · `agent_memory`=0 · `task_context`=1 · episodes 134 · communities 348. Ghi BUG2-304, chờ duyệt.
2. **Đánh giá regression test (phiên 2026-10-19):** 7 lớp phòng thủ hoạt động tốt (gate 2036/0 · isolation 2 tầng · hooks+CI · source-scan · audit fail-closed · Bug_v2 + fixbug R1/R2 · baseline drift) nhưng 4 điểm yếu: không coverage · e2e/verify ngoài gate · build skip mù · branch protection thủ công.
3. **Đợt REQ-AUDIT (91dadae) ghi nhận KHÔNG-làm chờ user:** gộp 3 poller Smolab (15s+30s+30s thành 1 interval) · micro-cache `/api/query?action=stats`.
4. **W3-8b:** NIM utility backup cho Zen 403 — kết luận giữ fail-open chờ tín hiệu thực đo (rule P6 alerts).

**Đường tái hiện mọi số (bổ sung v0.2):** `curl -s localhost:6333/collections/<name>` · `curl -s 'localhost:3000/api/storage/snapshot-full'` · `bun test --coverage` (bun 1.3.14: `--coverage`, `--coverage-reporter=lcov|text`, `--coverage-dir`; **không có flag "sources"** — bảng chỉ liệt kê file được import bởi test) · `sqlite3 db/custom.db 'SELECT COUNT(*) FROM Document'` (=0) · `ls knowledge/*.TXT` (=9: 8 `SHD_*` + 1 `PSY-CORE-SCI-009.TXT`) · `git remote -v` (2 remote: `mirror`→vietnq130593-code/TMO + `origin`→nguyenquocviety2c-code/TMO) · `git check-ignore scripts/coverage-baseline.json` (trúng `/scripts/*` :82) · `git ls-files scripts/ | wc -l` (=44 — scripts/* chỉ track 44 file được re-include riêng).

---

## 2. SÁU VẤN ĐỀ (P1–P6) — hiện tượng → bằng chứng → gốc rễ

### P1. Backup Qdrant hẹp 1/6 collection — mất dữ liệu vĩnh viễn mỗi reset (BUG2-304, mức P2)

| | |
|---|---|
| **Hiện tượng** | Reset sandbox #3 xóa sạch Qdrant; restore từ R2 (`restore-full?store=qdrant&date=latest`) hồi đúng 868/868 chunks trong 2,3s — nhưng `theopus_documents` (9/9 lúc D0 §7.1) về 0 vĩnh viễn: tar chỉ chứa snapshot của `theopus_chunks`. |
| **Bằng chứng** | `backupQdrantToR2` (qdrant-snapshot.ts:143) chỉ 1 vòng `getChunksCollection()`; `restoreQdrantFromR2` (:330) cũng chỉ 1 collection. GET snapshot-full: R2 có đúng 3 tar (latest + 20261018 + 20260824) — cả 3 chỉ chunks. SQLite `Document` = 0 (mất cùng reset — backup R2 chỉ snapshot Qdrant, không đụng bảng SQL này). **Nguồn backfill còn duy nhất: `ls knowledge/*.TXT` = 9 file (8 `SHD_*.TXT` + 1 `PSY-CORE-SCI-009.TXT` — glob `SHD_*` BẮT 8/9, v0.1 viết sai).** |
| **Gốc rễ** | Thiết kế backup viết cho đúng use-case D0 (corpus chunks) rồi không mở rộng khi hệ thống thêm collection sống (agent_memory — `memory` module, task_context — S2 artifact store W1 FB-EE). Không có inventory "collection nào cần bảo vệ" → mỗi collection mới là một lỗ hổng mới âm thầm. |
| **Đối tượng cần bảo vệ (v0.2 sửa)** | **Backup 5 collection:** `theopus_chunks` (corpus tĩnh — REPLACE an toàn) · `theopus_documents` (metadata ingestion — REPLACE an toàn nếu backup tươi) · `agent_memory` (sống — restoreIfEmpty) · `task_context` (sống nhẹ — restoreIfEmpty) · `theopus_episodes` (sống — **dữ liệu LỊCH SỬ không tái sinh được** — restoreIfEmpty; v0.1 loại với lý do "restore cũ phá episode mới" — **SAI LOGIC**: dưới restoreIfEmpty không tồn tại cửa "phá data mới" vì chỉ restore khi rỗng; lý do thật của việc cân nhắc loại là tar phình theo thời gian — đã giải bằng size guard §4-S1.1). **Không đưa vào:** `theopus_communities` — tái sinh được bằng `scripts/refresh-communities.ts` (Leiden recompute), không cần backup. |

### P2. Gate không có coverage — lưới regression có lỗ theo dòng code

| | |
|---|---|
| **Hiện tượng** | Quality gate 5 stage (type_check → lint → imports → tests → build) chỉ biết "93 file test pass" — không biết "dòng code mới có test chạm tới chưa". |
| **Bằng chứng** | quality-gate.mjs không tham chiếu coverage; bun 1.3.14 ĐÃ hỗ trợ `--coverage` (verified live: `bun test tests/bridge-state.test.ts --coverage` → bảng %Funcs/%Lines + lcov — **bảng chỉ liệt kê đúng 1 file `src/lib/bridge-state.ts`, không liệt kê 254k LOC còn lại** → bun chỉ đếm file được IMPORT bởi test; `bun test --help` không có flag nào mở rộng nguồn). |
| **Gốc rễ** | Gate sinh trước khi bun có coverage ổn định; chưa có baseline nên không đặt được ngưỡng hợp lý (đặt số tuyệt đối vô căn cứ sẽ chặn giả). **Giới hạn căn bản (v0.2 ghi rõ):** ratchet chỉ bảo vệ file ĐÃ được import bởi ≥1 test; module hoàn toàn mới chưa-test KHÔNG làm tụt pct — lớp bảo vệ cho trường hợp đó là quy tắc fixbug "mọi fix kèm regression" (r123/r124 source-scan), coverage không thay thế được (xem §4-S2). |

### P3. E2E + verify script ngoài gate — "tầng giữa" trống

| | |
|---|---|
| **Hiện tượng** | 13 e2e + 34 scratch verify chạy thủ công. Gate chỉ chạy unit (mock). Không có tầng nào kiểm **contract HTTP thật** (route + DB thật + không LLM). |
| **Bằng chứng** | Phân loại chuẩn v0.2 (đếm lại tay từng file): **9/13 e2e gửi prompt (mutate — cần LLM sống)** + **4/13 read-only** (e2e-cov-verify, e2e-unc-verify, e2e2-verify, e2e-verify-artifacts — file cuối là thuần đọc; v0.1 đếm "10/13" do rg bắt nhầm dòng *comment* "POST 200 sau 3.2 phút… Script này CHỈ ĐỌC" trong e2e-verify-artifacts:3). Đã có tiền lệ smoke thật trong PLAYBOOK (browser smoke từng đợt fixbug) nhưng không script hóa. |
| **Gốc rễ** | E2e được viết cho nghiệm thu round cụ thể (gắn LLM/stack) — không ai tách lớp "contract read-only" ra làm stage tự động. |

### P4. Gate PASS dù build chưa chạy — verdict dễ tin nhầm

| | |
|---|---|
| **Hiện tượng** | Build stage OOM trên box 4GB (exit 137, precedent REQ-AUDIT) → operator dùng `.quality-gate.local skipBuild=true`. Gate in `⊘ SKIP build` rồi verdict cuối vẫn là **"PASS toàn bộ — được phép push/merge"**. |
| **Bằng chứng** | quality-gate.mjs summary chỉ in dòng PASS/SKIP/FAIL từng stage; verdict không nhắc skip. `.quality-gate.local` **gitignored (:229) + untracked** → CI không bao giờ thấy file này, CI luôn chạy full 5 stage (workflow env hiện chỉ `NEXT_TELEMETRY_DISABLED` + `CI=true`). |
| **Gốc rễ** | Cơ chế skip đúng cho máy yếu nhưng không phân biệt "PASS có build" với "PASS thiếu build" ở verdict. KHÔNG cố chữa OOM: box 4GB là giới hạn môi trường — CI có RAM riêng. |

### P5. Branch protection bật thủ công — không có gì kiểm tra

| | |
|---|---|
| **Hiện tượng** | quality-gate.yml comment "khuyến nghị làm 1 lần bằng tay: Require status checks" — nếu quên bật, `--no-verify` local + push trực tiếp lên main không bị GitHub chặn. |
| **Bằng chứng** | **2 remote (v0.2):** `git remote -v` → `mirror` = github.com/vietnq130593-code/TMO **+** `origin` = github.com/nguyenquocviety2c-code/TMO — hai tài khoản GitHub khác nhau; v0.1 hardcode slug của mirror = chỉ kiểm 1/2 repo — nếu CI thực sự chạy trên repo origin thì kết luận "đã bật protection" là SAI cho repo đó. Không có gh CLI trên box; PAT nằm trong URL cả hai remote (redact khi log). |
| **Gốc rễ** | Việc bật là 1-time setting thuộc về người — thiếu lớp "kiểm tra đã bật chưa + nhắc bước làm" và thiếu nhận thức đa-remote. |

### P6. 3 quyết định treo — cần chốt một lần cho xong

Gộp poller Smolab (REQ-AUDIT ghi nhận không-làm) · micro-cache stats (dito) · 8b NIM utility (W3 kết luận chờ tín hiệu). Chi tiết + quyết định tại §7 — không sinh code.

---

## 3. NGUYÊN TẮC THIẾT KẾ

1. **Backup mặc định đủ rộng — restore mặc định đủ hẹp.** Mọi collection tĩnh/lịch-sử được backup; restore chỉ REPLACE collection tĩnh, collection sống chỉ restore khi đang RỖNG (restoreIfEmpty) — không bao giờ restore cũ đè data mới; có lối thoát `force` duy nhất cho disaster-recovery có chủ ý.
2. **Coverage là ratchet, không phải bar.** Chỉ chặn TỤT so baseline đo được; không đặt ngưỡng tuyệt đối vô căn cứ. Nâng baseline là hành vi chủ ý (lệnh riêng + ghi nhận), không tự động trượt.
3. **Gate chỉ kết luận những gì nó đo; mọi skip phải in rõ ở verdict.** "PASS thiếu build" phải khác "PASS đủ build".
4. **Không fake e2e để đếm.** Smoke chỉ là contract read-only thật; e2e cần LLM sống nằm ngoài gate mãi mãi.
5. **Mọi số trong blueprint đo live kèm đường tái hiện; mọi giới hạn đo lường phải ghi trong blueprint** (coverage import-only §2-P2) — không để hiện thực khác spec.

---

## 4. GIẢI PHÁP (S1–S6, map 1-1)

### S1. Multi-collection Qdrant backup/restore (fix P1) — W1, ~2h

**S1.1 Nới rộng backup (v0.2: 5 collection + size guard):**
- `QDRANT_BACKUP_COLLECTIONS` (env, mặc định `theopus_chunks,theopus_documents,agent_memory,task_context,theopus_episodes` — v0.2 thêm episodes, lý do §2-P1; communities loại — tái sinh bằng refresh-communities).
- **Size guard** `QDRANT_BACKUP_MAX_POINTS` (env, mặc định 5000): collection vượt ngưỡng → skip collection đó trong lần backup đó + warn (không fail batch) — chặn tar phình vô hạn cho collection sống (episodes/agent_memory là dữ liệu tích lũy).
- `backupQdrantToR2` vòng for qua danh sách; mỗi collection một cặp key: `backups/qdrant/<collection>/{YYYYMMDD-HHMMSS}.tar` + `backups/qdrant/<collection>/latest.tar`.
- **Compat legacy:** `theopus_chunks` tiếp tục ghi THÊM key gốc `backups/qdrant/{date}.tar|latest.tar` (D0 §7.2 + tar cũ vẫn restore được; R2 dư ~27MB/lần chunks-backup — chấp nhận). **Điều kiện gỡ dual-write (v0.2 cụ thể hóa):** (a) ≥2 lần backup per-collection thành công liên tiếp (đọc từ GET list), (b) docs D0 §7.2 đã cập nhật curl sang key per-collection; gỡ = xóa nhánh dual-write trong code — **root keys cũ trên R2 KHÔNG xóa** (giữ làm đường hồi phục cuối).
- Lỗi 1 collection (chưa tồn tại / vượt guard) → skip-graceful + log, KHÔNG fail cả batch.

**S1.2 Restore per-collection + policy + force (v0.2 thêm force):**
- `findBackupKey(collection, date)`: tìm trong prefix per-collection; riêng `theopus_chunks` fallback legacy root (tar cũ).
- Policy — hàm thuần export (unit-test được): `restoreDecision(collection, currentPoints): 'replace' | 'skip'` — chunks/documents → luôn `replace`; memory/task_context/episodes → `currentPoints === 0 ? 'replace' : 'skip'` + log rõ lý do skip.
- **`force=1` (v0.2):** query param trên restore-full, mặc định 0. force → bỏ policy (replace mọi collection trong scope) + log warning rõ "force restore — ghi đè N điểm đang sống". Lý do tồn tại: kịch bản disaster-recovery khi data sống BỊ HỎNG (corrupt nhưng KHÔNG rỗng) — policy skip sẽ chặn vĩnh viễn đường hồi phục, đánh mất ý nghĩa tồn tại của backup.
- **GET snapshot-full cập nhật (v0.2 thêm):** `listQdrantBackups` (qdrant-snapshot.ts:444) hiện list phẳng prefix `backups/qdrant/` — với key per-collection, list sẽ TRỘN các collection + nhiều `latest.tar` trùng tên không phân biệt được. Sửa: mỗi entry thêm field `collection` (parse từ key; root → `theopus_chunks` legacy) + GET route (route :160) response thêm `byCollection` (giữ `qdrantBackups` phẳng cũ cho compat UI) + `currentQdrantPoints` bổ sung map per-collection (giữ trường cũ = chunks).
- `restoreQdrantFromR2` vòng for theo policy; response mở rộng per-collection (giữ trường cũ `restoredPoints` = chunks cho compat).

**S1.3 Backfill `theopus_documents` (9 điểm đã mất — trước khi backup lần đầu) — v0.2 spec hóa từ code:**
- **Nguồn (v0.2 sửa glob):** `knowledge/*.TXT` = **9 file** (8 `SHD_*.TXT` + 1 `PSY-CORE-SCI-009.TXT` — glob v0.1 `SHD_*` bắt 8/9; KPI 9/9 không bao giờ đạt nếu theo v0.1).
- **Payload spec đầy đủ (từ `DocumentPayload` qdrant.ts:397 — bắt buộc: title, domain, status, processing_steps, processing_percent, created_at, updated_at):** `title` = tên file · `domain` = `'ml'` (D0 upload .TXT dùng domain ml — D0 doc :33/:45; DocumentDomain pdf-parser.ts:16) · `status` = `'indexed'` (giá trị cuối pipeline; **phải nằm trong union 9 giá trị** — đặt sai giá trị = vô hình ở UI Documents, pattern BUG2-291) · `processing_steps` = `[]` · `processing_percent` = 100 · `file_path` = `knowledge/<file>` · `created_at/updated_at` = ISO (index payload `status|domain|created_at|updated_at` đã tạo sẵn :250-262) · `page_count` synthetic theo quy ước .txt (process route :668 — 1 trang ≈ 1800 tokens) — tùy chọn.
- **ID:** deterministic `doc-shd-<slug-tên-file>` (collection đang rỗng — không đụng dữ liệu nào; truy vấn sau này filter theo payload, không theo id).
- **KHÔNG cần chunking (v0.2 bỏ):** `DocumentPayload` KHÔNG có trường chunk_count (rg xác nhận — chunkCount chỉ xuất hiện trong log/route, không nằm trong payload Qdrant); v0.1 yêu cầu "chunking 640/96 đếm chunk" là thừa và dễ khiến người triển khai tưởng phải tái chạy chunker. Script ~60 dòng giữ nguyên ước lượng.

**S1.4 Regression r124** (pattern r123):
- Nhóm A source-scan: env default 5 collection · vòng for trong backup · per-collection key layout · legacy fallback chunks · policy branch restoreIfEmpty · skip-graceful + size guard · force param mặc định 0.
- Nhóm B unit: `restoreDecision` 5 case (chunks thay · documents thay · memory rỗng thay · memory 5 điểm skip · force=1 → thay cả khi 5 điểm) · `findBackupKey` mock listR2Objects (per-collection hit, legacy fallback, miss→null).

**Verify nghiệm thu (v0.2 cập nhật):** (1) chạy backup → R2 list đủ 5×2 key mới + legacy chunks; (2) backfill → pointCount documents 9/9; (3) giả lập "memory có data": upsert 2 điểm test vào agent_memory → restore → policy skip + 2 điểm nguyên; **(3b) cùng kịch bản + `force=1` → replace + log warning ghi đè;** (4) restore dùng tar CŨ (root latest.tar 18-10) vẫn hồi 868 chunks; (5) GET snapshot-full hiển thị `byCollection` đúng grouping.

### S2. Coverage ratchet trong gate (fix P2) — W1, ~1h

- Bên trong stage `tests` (chạy 1 lần): `bun test --coverage --coverage-reporter=lcov,text --coverage-dir=.quality-gate-coverage` (cùng DATABASE_URL test cô lập + preload hiện có).
- Parser lcov (~60 dòng): tổng hợp `LF:`/`LH:` toàn bộ file trong lcov → `pct = LH/LF`.
- **Baseline (v0.2 đổi vị trí):** `tests/coverage-baseline.json` — **KHÔNG đặt scripts/** (check-ignore trúng `.gitignore:82 /scripts/*` — scripts/* chỉ track 44 file được re-include riêng; baseline đặt scripts/ = không commit = mất theo box reset, lặp lại đúng pattern BUG2-290 backfill-script). `tests/` đã track đầy đủ (r103/r123 precedent). Thêm `.quality-gate-coverage/` vào .gitignore (hiện chỉ có `/coverage` :14).
- **FAIL nếu `pct < baseline − 1,0 điểm%`**; pass nếu ngang/tăng. Nâng/hạ baseline: lệnh chủ ý `--coverage-update-baseline` + bắt buộc entry Bug_v2 khi hạ.
- **Giới hạn ghi rõ (v0.2):** ratchet chỉ bảo vệ file được import bởi ≥1 test (bằng chứng §2-P2) — module mới hoàn toàn chưa-test không làm tụt pct; lớp bảo vệ cho module mới là quy tắc fixbug "mọi fix kèm regression test" (source-scan) — coverage là lớp 2 chứ không thay thế lớp 1.
- KPI verify: hạ thủ công baseline −2đ% → gate FAIL; hồi đúng → PASS; thời gian stage tests tăng ≤ +15% (thí điểm 1 lần trước khi bật mặc định — §8).

### S3. Smoke contract read-only (fix P3) — W2, ~1,5h

- Thư mục `tests/smoke/`: `/api/health` healthy + pointCount chunks > 0 · `/api/query?action=stats` shape đúng · `/api/agents?enabled=true` mảng + không trùng id · `/api/storage/snapshot-full` GET có qdrantBackups + byCollection (S1.2) · `/` HTML có title. Toàn bộ GET — 0 mutation (bài học Task 54).
- **Preload (v0.2 sửa văn bản):** bunfig `[test].preload` là TOÀN CỤC cho mọi `bun test` — tests/smoke/ vẫn nạp db-isolation-preload (KHÔNG thể loại trừ per-directory và KHÔNG cần: preload copy DB ra /tmp vô hại với smoke vì smoke chỉ fetch HTTP). Lợi ích giữ nguyên: tai nạn Task 54 được chống ở mọi thư mục test.
- Stage mới `smoke`: **probe /api/health tối đa 3 lần × 2s (v0.2 — single-shot 2s có thể SKIP giả khi next dev đang recompile; cold đo được 640-722ms nhưng route nặng hơn)** → không reachable sau 3 lần → SKIP (reason "app không chạy"); smoke test fetch timeout 10s/test.

### S4. Minh bạch hóa build-skip (fix P4) — W2, ~30m

- Verdict cuối phân biệt: build PASS → "PASS đủ stage"; build SKIP → dòng vàng **"BUILD CHƯA CHẠY (skip local) — CI GitHub sẽ chạy; KHÔNG kết luận build-được từ lần chạy này"** + lệnh tái hiện `TMO_REQUIRE_BUILD=1 bun scripts/quality-gate.mjs`.
- `TMO_REQUIRE_BUILD=1` → SKIP build bị tính **FAIL** (flag ngược chiều `TMO_GATE_SKIP_BUILD` precedent).
- **CI (v0.2 thêm):** workflow quality-gate.yml bổ sung env `TMO_REQUIRE_BUILD: '1'` — belt-and-braces (CI đã luôn full vì .quality-gate.local gitignored + untracked, nhưng khai báo tường minh chống tương lai).

### S5. Kiểm tra branch protection đa-remote (fix P5) — W2, ~30m

- `scripts/check-branch-protection.mjs` (v0.2): **kiểm TẤT CẢ remote push** (hiện 2: mirror vietnq130593-code/TMO + origin nguyenquocviety2c-code/TMO — 2 tài khoản GitHub khác nhau) — parse từng URL lấy PAT (redact ngay, không in token), `GET /repos/<slug>/branches/main/protection` từng repo.
- 200 → kiểm `required_status_checks.contexts` chứa `quality-gate` + `enforce_admins.enabled`; 404/403 → in 5 bước bật tay. Báo cáo per-repo (repo này bật / repo kia chưa).
- **Warn-only mặc định** (exit 0); `--strict` → exit 1 khi bất kỳ repo nào chưa bật. Gắn vào PLAYBOOK checklist phát hành.

### S6. Chốt 3 quyết định treo → xem §7 (0 code)

---

## 5. LỘ TRÌNH TRIỂN KHAI

| Wave | Nội dung | Lý do thứ tự | Effort |
|---|---|---|---|
| **W1 — An toàn dữ liệu + lưới** | S1 (5-collection backup + force + GET grouping + backfill 9/9 + r124) · S2 (coverage ratchet, baseline tại tests/) | S1 chặn mất dữ liệu thật (P2) — cao nhất mọi mục; S2 lấp lỗ lưới trước khi thêm stage khác | ~3h |
| **W2 — Tự động hóa còn lại** | S3 (smoke + probe 3×2s) · S4 (build minh bạch + CI env) · S5 (branch protection 2 remote) + r125 | Sau khi lưới chắc; 3 việc nhỏ độc lập | ~2,5h |

---

## 6. KPI NGHIỆM THU (v0.2 cập nhật)

| KPI | Cách đo | Mục tiêu |
|---|---|---|
| Backup phủ đủ | R2 list sau backup | ≥5 collection × 2 key (dated + latest) + legacy chunks còn |
| GET grouping đúng | GET snapshot-full | `byCollection` hiện đủ 5 collection; entry có field `collection` |
| Restore đúng policy | §4-S1 verify (1)-(5) | 5/5 kịch bản — riêng memory-đang-có-data skip + data nguyên; force=1 thay + warning |
| Documents hồi sinh | pointCount sau backfill | 9/9 theo glob `knowledge/*.TXT` (8 SHD + 1 PSY) |
| Coverage chặn tụt | Hạ baseline −2đ% thử | Gate FAIL; hồi đúng → PASS; stage tests tăng ≤ +15% |
| Smoke 2 trạng thái | Local (app chạy) / CI (không chạy) | PASS / SKIP sau probe 3×2s — không FAIL giả, không PASS giả |
| Build verdict phân biệt | TMO_REQUIRE_BUILD=1 + skipBuild=true | Exit 1 + cảnh báo; =0 → PASS kèm cảnh báo skip |
| Branch protection | Chạy script | Báo cáo đúng trạng thái từng remote (2 repo), PAT redact |

---

## 7. ANTI-GOALS / QUYẾT ĐỊNH CHỐT (KHÔNG LÀM — có điều kiện reopen)

1. **Gộp 3 poller Smolab → TỪ CHỐI.** 3 interval riêng tốn ~2 req/30s khi tab HIỂN THỊ — FIX1 (hidden gate) đã chặn phần lớn lãng phí (tab ẩn); gộp chạm 3 file component = diff churn lớn hơn lợi ích đo được. **Reopen khi:** composition request mới cho thấy cụm Smolab đứng top bảng.
2. **Micro-cache `/api/query?action=stats` → TỪ CHỐI.** Stats cần tươi NGAY sau khi user thao tác (ingest/delete) — TTL cache sẽ phục vụ số cũ đúng lúc người dùng đang chờ kết quả hành động của mình. **Reopen khi:** thiết kế được invalidate theo action (như FIX2 đã làm cho 9 mutation) mà không tăng phức tạp đáng kể.
3. **8b NIM utility → GIỮ fail-open, KHÔNG thêm bây giờ.** Điều kiện kích hoạt (rule sẵn): P6 observation alerts bắt 403 lặp ≥2 lần/24h trên utility-core. Khi kích hoạt: thêm 1 model NIM vào pool utility — effort ~30m (pool NIM sẵn từ R39). Thêm bây giờ = tối ưu mù khi chưa có bằng chứng tần suất thật.
4. **KHÔNG cố ép `next build` chạy trên box 4GB** (S4 chỉ minh bạch hóa).
5. **KHÔNG đưa e2e cần LLM/stack sống vào gate** · KHÔNG đặt coverage bar tuyệt đối · KHÔNG đổi concurrency/SUBAGENT caps (giữ mọi anti-goal của EXECUTION-EFFICIENCY) · **KHÔNG backup `theopus_communities`** (tái sinh bằng refresh-communities — v0.2 thêm lý do đúng thay vì lý do sai của episodes).

---

## 8. ĐIỂM GÃY CẦN CẨN THẬN (triển khai phải đối chiếu từng điểm — v0.2 mở rộng)

1. **Restore REPLACE bằng tar CŨ:** per-collection key mới phải fallback legacy root cho chunks — nếu quên, "No backup found" sẽ giết đường hồi phục 868 chunks đã chứng minh (2,3s).
2. **Race restoreIfEmpty:** agent có thể ghi điểm mới trong cửa sổ ~2s giữa lúc đọc pointCount và upload snapshot — chấp nhận + log (cửa hẹp; trường xấu vẫn còn 1 bản data trong backup).
3. **`force=1` là dao 2 lưỡi (v0.2):** force + collection sống = ghi đè MẤT data mới có chủ ý — phải in warning rõ + không bao giờ default. §7-không-làm không thêm force cho backup thường.
4. **Payload status phải nằm trong union 9 giá trị** (S1.3) — đặt giá trị ngoài union (`'done'`…) = documents vô hình ở UI Documents — pattern lặp BUG2-291 (union thiếu `final_report`).
5. **Baseline coverage tự trượt** — chỉ được cập nhật chủ ý qua `--coverage-update-baseline` + entry Bug_v2 khi hạ; đặt sai chỗ (scripts/) = mất theo box reset (pattern BUG2-290) — v0.2 đã đổi sang tests/.
6. **`bun test --coverage` trên full suite chưa đo RAM/thời gian** — thí điểm 1 lần trước khi bật mặc định; nếu tăng >15% thời gian hoặc OOM thì tách `--stage=coverage` opt-in (không im lặng).
7. **Smoke không được mutation** — chỉ GET + assert shape (Task 54); probe 3×2s chống SKIP giả khi dev server đang recompile.
8. **PAT không được in ra log (S5)** — parse 2 remote xong redact ngay; fail-close khi không có token (in hướng dẫn, exit 0 warn-only).
9. **Tar backup giờ chứa data sống (agent_memory + episodes)** — size guard 5000 điểm chặn phình vô hạn; theo dõi retention trong Bug_v2 khi collection sống lớn dần.
10. **Legacy dual-write gỡ sai lúc = gãy compat D0 §7.2** — chỉ gỡ khi ≥2 backup per-collection thành công + docs D0 §7.2 cập nhật sang key mới; root keys cũ KHÔNG xóa khỏi R2.
11. **GET snapshot-full compat:** giữ `qdrantBackups` phẳng + `currentQdrantPoints` cũ (UI/docs đang đọc) — chỉ THÊM `byCollection`/per-collection map, không đổi tên trường cũ.

---

## 9. LỊCH SỬ HIỆU ĐÍNH

- **0.2 (2026-10-19, review theo directive user "Vào vai kỹ sư AI tiến hành review lại"):** đối chiếu toàn bộ tuyên bố v0.1 với code HEAD (grep/sed đúng dòng) + đo live; cấu trúc P/S/W ĐÚNG — không phát hiện nào làm đổ chẩn đoán; **15 hiệu đính, 3 lỗi thực sự:**
  1. **Glob nguồn backfill SAI:** `SHD_*.TXT` = 8/9 file — file thứ 9 là `PSY-CORE-SCI-009.TXT` (ls + đếm live); theo v0.1, backfill 8/9 documents và KPI 9/9 không bao giờ đạt → S1.3 đổi glob `knowledge/*.TXT`.
  2. **Lý do loại `theopus_episodes` SAI LOGIC:** "restore cũ phá episode mới" không tồn tại dưới restoreIfEmpty (chỉ restore khi rỗng) — lý do thật là tar phình theo thời gian, đã giải bằng size guard; episodes là lịch sử không tái sinh được → đưa vào mặc định backup (5 collection), communities giữ loại với lý do đúng (tái sinh refresh-communities).
  3. **S5 hardcode 1/2 remote:** `git remote -v` có 2 remote khác tài khoản (mirror→vietnq130593-code/TMO, origin→nguyenquocviety2c-code/TMO) — kiểm 1 repo có thể kết luận SAI cho repo còn lại → S5 kiểm tất cả remote push, báo cáo per-repo.
  4. S1.3 spec hóa `DocumentPayload` đầy đủ từ code (9 trường bắt buộc; domain='ml' theo D0; status phải trong union 9 giá trị — BUG2-291 pattern); **bỏ yêu cầu chunking 640/96** — payload không có trường chunk_count (rg chứng minh), v0.1 yêu cầu thừa.
  5. S1.2 thêm `force=1` cho disaster-recovery (data sống hỏng nhưng không rỗng — policy skip sẽ chặn vĩnh viễn đường hồi phục).
  6. S1.2 thêm cập nhật GET snapshot-full + listQdrantBackups (list phẳng sẽ trộn collection, `latest.tar` trùng tên) — byCollection + field `collection` + per-collection point map.
  7. S1.1 thêm size guard `QDRANT_BACKUP_MAX_POINTS` (default 5000) — điều kiện tồn tại để đưa episodes/agent_memory vào backup an toàn.
  8. S1.1 cụ thể hóa điều kiện gỡ legacy dual-write (≥2 backup per-collection thành công + docs D0 §7.2 cập nhật; root keys cũ không xóa).
  9. S2 baseline đổi vị trí scripts/ → `tests/coverage-baseline.json` (check-ignore trúng `/scripts/*` :82 — pattern BUG2-290 lặp lại; scripts/* chỉ track 44 file re-include riêng).
  10. S2 ghi rõ giới hạn import-only (bằng chứng: chạy 1 test file → bảng chỉ 1 file; help không có flag sources) — ratchet không bảo vệ module chưa-test; lớp 1 là quy tắc fixbug regression.
  11. S3 sửa "KHÔNG preload" — bunfig preload toàn cục, không loại trừ per-directory được, và vô hại cho smoke.
  12. S3 probe 3×2s thay single-shot 2s (chống SKIP giả khi next dev recompile — cold đo 640-722ms nhưng route nặng hơn).
  13. S4 thêm CI workflow env `TMO_REQUIRE_BUILD: '1'` (belt-and-braces; .quality-gate.local gitignored:229 + untracked → CI đã luôn full).
  14. P3 đếm lại e2e: 9/13 mutate + 4/13 read-only (v0.1 "10/13" do rg bắt nhầm comment "POST 200…" trong e2e-verify-artifacts:3 — file thuần đọc).
  15. Effort S1 1,5h→2h (thêm GET route + force + guard + episodes); W1 tổng ~3h; KPI §6 cập nhật 5/5 kịch bản + hàng GET grouping; §8 mở rộng 7→11 điểm.
- **0.1 (2026-10-19):** bản đầu — gom 6 việc từ 4 nguồn (W3-REGTEST-1 · đánh giá regression 7 lớp · REQ-AUDIT ghi nhận · BUG2-304); mọi số đo live; S1.3 backfill thêm sau khi phát hiện SQLite `Document`=0.
