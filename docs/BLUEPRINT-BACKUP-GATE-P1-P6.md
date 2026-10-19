# BLUEPRINT BACKUP-GATE P1-P6 — ĐỘ BỀN LƯU TRỮ + KHÉP CHẶT LƯỚI KIỂM (v0.1)

> **Phiên bản:** 0.1 — 2026-10-19. Directive user: *"Gom điểm yêu cầu cải thiện cũng như các việc treo còn lại, nếu việc nhiều thì viết blueprint trước, nếu không thì có thể triển khai luôn."* — gom xong có 6 việc (5 việc code + 1 nhóm quyết định treo) → theo đúng quy tắc user đưa ra: viết blueprint trước, triển khai sau khi duyệt.
> **Phương pháp:** mọi việc gom từ 4 nguồn có ghi chép: (1) kết luận W3-REGTEST-1 (8b chờ tín hiệu, BUG2-304 chờ duyệt); (2) 2 mục GHI-NHẬN-KHÔNG-làm của đợt REQ-AUDIT (91dadae); (3) 4 điểm yếu trong đánh giá 7 lớp regression test (phiên 2026-10-19); (4) BUG2-304 (Bug_v2 306 entries). Mọi con số trong blueprint ĐO LIVE ngày 2026-10-19 kèm đường tái hiện — không số tự khai.
> **Ký hiệu:** P1–P6 = 6 vấn đề · S1–S6 = giải pháp map 1-1 · W1–W2 = 2 wave triển khai.

---

## 0. TÓM TẮT — BẢNG 6 VIỆC

| # | Việc | Nguồn phát hiện | Mức | Wave | Effort | Khuyến nghị |
|---|---|---|---|---|---|---|
| **P1/S1** | Backup Qdrant chỉ snapshot 1/6 collection — `theopus_documents`/`agent_memory`/`task_context` mất vĩnh viễn sau reset | BUG2-304 (W3-8c, 44578f9) | **P2 — rủi ro mất dữ liệu thật** | W1 | ~1,5h | **Làm ngay — ưu tiên cao nhất** |
| **P2/S2** | Quality gate không có coverage — dòng code mới không có test sẽ không bị phát hiện | Đánh giá regression (phiên 2026-10-19) | P3 | W1 | ~1h | Làm (ratchet theo baseline, không bar tuyệt đối) |
| **P3/S3** | 13 e2e + 34 scratch verify chạy thủ công — không có tầng nào giữa "unit mock" và "e2e cần LLM sống" | Đánh giá regression | P3 | W2 | ~1,5h | Làm ở mức smoke read-only (KHÔNG fake e2e) |
| **P4/S4** | Gate PASS dù build chưa hề chạy (skipBuild local) — verdict "được phép push/merge" dễ tin nhầm | Biên bản REQ-AUDIT (OOM exit 137) | P3 | W2 | ~30m | Làm (minh bạch hóa skip, không cố chữa OOM) |
| **P5/S5** | Branch protection GitHub bật thủ công — không có gì kiểm tra | Comment quality-gate.yml | P4 | W2 | ~30m | Làm (script warn-only) |
| **P6/§7** | 3 quyết định treo: gộp poller Smolab · micro-cache stats · 8b NIM utility | REQ-AUDIT-1-FIX + W3-REGTEST-1 | — | — | 0 | Chốt tại §7: 2 mục TỪ CHỐI, 1 mục giữ chờ tín hiệu |

---

## 1. BỐI CẢNH — 4 NGUỒN GOM

1. **W3-REGTEST-1 (commit 44578f9):** khi restore 8c phát hiện `backupQdrantToR2` (qdrant-snapshot.ts:143) hardcode đúng 1 collection `theopus_chunks` — tar R2 `latest.tar` 27.193.856 B không chứa collection nào khác. Đo live 2026-10-19 19:02: `theopus_documents`=0 (D0 §7.1 từng verify 9/9 lúc 13:51 18-10) · `agent_memory`=0 · `task_context`=1 · episodes 134 · communities 348. Ghi BUG2-304, chờ duyệt.
2. **Đánh giá regression test (phiên 2026-10-19):** 7 lớp phòng thủ hoạt động tốt (gate 2036/0 · isolation 2 tầng · hooks+CI · source-scan · audit fail-closed · Bug_v2 + fixbug R1/R2 · baseline drift) nhưng 4 điểm yếu: không coverage · e2e/verify ngoài gate · build skip mù · branch protection thủ công.
3. **Đợt REQ-AUDIT (91dadae) ghi nhận KHÔNG-làm chờ user:** gộp 3 poller Smolab (15s+30s+30s thành 1 interval) · micro-cache `/api/query?action=stats`.
4. **W3-8b:** NIM utility backup cho Zen 403 — kết luận giữ fail-open chờ tín hiệu thực đo (rule P6 alerts).

Đường tái hiện mọi số: `curl -s localhost:6333/collections/<name> | jq .result.points_count` · `curl -s 'localhost:3000/api/storage/snapshot-full'` · `bun test --coverage` (verified bun 1.3.14: `--coverage`, `--coverage-reporter=lcov|text`, `--coverage-dir`) · `sqlite3 db/custom.db 'SELECT COUNT(*) FROM Document'` (=0).

---

## 2. SÁU VẤN ĐỀ (P1–P6) — hiện tượng → bằng chứng → gốc rễ

### P1. Backup Qdrant hẹp 1/6 collection — mất dữ liệu vĩnh viễn mỗi reset (BUG2-304, mức P2)

| | |
|---|---|
| **Hiện tượng** | Reset sandbox #3 xóa sạch Qdrant; restore từ R2 (`restore-full?store=qdrant&date=latest`) hồi đúng 868/868 chunks trong 2,3s — nhưng `theopus_documents` (9/9 lúc D0 §7.1) về 0 vĩnh viễn: tar chỉ chứa snapshot của `theopus_chunks`. |
| **Bằng chứng** | `backupQdrantToR2` (qdrant-snapshot.ts:143) chỉ 1 vòng `getChunksCollection()`; `restoreQdrantFromR2` (:330) cũng chỉ 1 collection. GET snapshot-full: R2 có đúng 3 tar (latest + 20261018 + 20260824) — cả 3 chỉ chunks. SQLite `Document` = 0 (mất cùng reset — backup R2 chỉ snapshot Qdrant, không đụng bảng SQL này). |
| **Gốc rễ** | Thiết kế backup viết cho đúng use-case D0 (corpus chunks) rồi không mở rộng khi hệ thống thêm collection sống (agent_memory — `memory` module, task_context — S2 artifact store W1 FB-EE). Không có inventory "collection nào cần bảo vệ" → mỗi collection mới là một lỗ hổng mới âm thầm. |
| **Đối tượng cần bảo vệ** | `theopus_chunks` (corpus tĩnh — REPLACE an toàn) · `theopus_documents` (metadata ingestion — REPLACE an toàn nếu backup tươi) · `agent_memory` (SỐNG — ghi liên tục; restore cũ = XÓA data mới → phải restoreIfEmpty) · `task_context` (sống nhẹ, 1 điểm hiện tại — restoreIfEmpty). **Không đưa vào:** `theopus_episodes` (sống, tích lũy — restore cũ phá episode mới; tar phình theo thời gian) · `theopus_communities` (tái sinh được bằng `refresh-communities` Leiden). |

### P2. Gate không có coverage — lưới regression có lỗ theo dòng code

| | |
|---|---|
| **Hiện tượng** | Quality gate 5 stage (type_check → lint → imports → tests → build) chỉ biết "93 file test pass" — không biết "dòng code mới có test chạm tới chưa". Người viết tính năng có thể quên regression test và gate vẫn PASS (tiêu chí dừng fixbug "đã có regression" là kỷ luật thủ công, không được ép buộc bằng máy). |
| **Bằng chứng** | quality-gate.mjs không tham chiếu coverage; bun 1.3.14 ĐÃ hỗ trợ `--coverage` (verified live: `bun test tests/bridge-state.test.ts --coverage` → bảng %Funcs/%Lines + lcov). 254k LOC / 93 file test = mật độ thấp — rủi ro tụt coverage là thật nhưng đo được. |
| **Gốc rễ** | Gate sinh trước khi bun có coverage ổn định; chưa có baseline nên không đặt được ngưỡng hợp lý (đặt số tuyệt đối vô căn cứ sẽ chặn giả). |

### P3. E2E + verify script ngoài gate — "tầng giữa" trống

| | |
|---|---|
| **Hiện tượng** | 13 e2e (đa số `*-send.ts` cần stack sống + LLM thật + chờ job chạy xong) và 34 scratch verify chạy thủ công bằng lệnh riêng. Gate chỉ chạy unit (mock). Không có tầng nào kiểm **contract HTTP thật** (route + DB thật + không LLM) — lỗi route 500, schema response sai, regress poll-cache… chỉ bắt được khi operator nhớ chạy tay. |
| **Bằng chứng** | Phân loại 13 e2e (rg POST/PUT/DELETE): 10/13 chứa thao tác đút prompt (mutate) — đúng dạng không thể đưa vào gate; 3 verify thuần read. Đã có tiền lệ smoke thật trong PLAYBOOK (browser smoke từng đợt fixbug) nhưng không script hóa. |
| **Gốc rễ** | E2e được viết cho nghiệm thu round cụ thể (gắn LLM/stack) — không ai tách lớp "contract read-only" ra làm stage tự động. |

### P4. Gate PASS dù build chưa chạy — verdict dễ tin nhầm

| | |
|---|---|
| **Hiện tượng** | Build stage OOM trên box 4GB (exit 137, precedent REQ-AUDIT: stop pm2 + 2.430MB available vẫn chết ở "Creating an optimized production build") → operator dùng `.quality-gate.local skipBuild=true`. Gate in `⊘ SKIP build` rồi verdict cuối vẫn là **"PASS toàn bộ — được phép push/merge"** — không ai nhắc build CHƯA HỀ chạy. Lần phát hành chính thức nếu quên bật CI thì lỗi build lọt tới prod. |
| **Bằng chứng** | quality-gate.mjs summary: chỉ in dòng `PASS/SKIP/FAIL` từng stage; verdict không nhắc skip. CI GitHub chạy full gate — nhưng "local PASS" và "CI PASS" là 2 kết luận khác nhau mà cùng 1 câu chữ. |
| **Gốc rễ** | Cơ chế skip được thêm cho máy yếu (đúng) nhưng không phân biệt "PASS có build" với "PASS thiếu build" ở verdict. KHÔNG cố chữa OOM: box 4GB là giới hạn môi trường (254k LOC cần >2,4GB để build) — CI có RAM riêng, việc cố ép build local là tối ưu sai chỗ. |

### P5. Branch protection bật thủ công — không có gì kiểm tra

| | |
|---|---|
| **Hiện tượng** | quality-gate.yml comment "khuyến nghị làm 1 lần bằng tay: Require status checks" — nếu quên bật, `--no-verify` local + push trực tiếp lên main không bị GitHub chặn; CI vẫn chạy nhưng chỉ là thông tin, không phải hàng rào. |
| **Bằng chứng** | Không có gh CLI trên box; remote `mirror` chứa PAT trong URL (đã có token dùng được cho REST API). Không script nào GET `/repos/.../branches/main/protection`. |
| **Gốc rễ** | Việc bật là 1-time setting thuộc về người — thiếu lớp "kiểm tra đã bật chưa + nhắc bước làm". |

### P6. 3 quyết định treo — cần chốt một lần cho xong

Gộp poller Smolab (REQ-AUDIT ghi nhận không-làm) · micro-cache stats (dito) · 8b NIM utility (W3 kết luận chờ tín hiệu). Chi tiết + quyết định tại §7 — không sinh code.

---

## 3. NGUYÊN TẮC THIẾT KẾ

1. **Backup mặc định đủ rộng — restore mặc định đủ hẹp.** Mọi collection tĩnh/living được backup; restore chỉ REPLACE collection tĩnh, collection sống chỉ restore khi đang RỖNG (restoreIfEmpty) — không bao giờ restore cũ đè data mới.
2. **Coverage là ratchet, không phải bar.** Chỉ chặn TỤT so baseline đo được; không đặt ngưỡng tuyệt đối vô căn cứ. Nâng baseline là hành vi chủ ý (lệnh riêng + ghi nhận), không tự động trượt lên khi code đổi.
3. **Gate chỉ kết luận những gì nó đo; mọi skip phải in rõ ở verdict.** "PASS thiếu build" phải khác "PASS đủ build" — không được để cùng một câu "được phép push/merge".
4. **Không fake e2e để đếm.** Smoke chỉ là contract read-only thật (GET vào app đang chạy); e2e cần LLM sống nằm ngoài gate mãi mãi — trung thực hơn là gạt tên.
5. **Mọi số trong blueprint đo live kèm đường tái hiện** (đã liệt kê §1).

---

## 4. GIẢI PHÁP (S1–S6, map 1-1)

### S1. Multi-collection Qdrant backup/restore (fix P1) — W1, ~1,5h

**S1.1 Nới rộng backup:**
- `QDRANT_BACKUP_COLLECTIONS` (env, mặc định `theopus_chunks,theopus_documents,agent_memory,task_context` — episodes/communities loại, lý do §2-P1 bảng đối tượng).
- `backupQdrantToR2` vòng for qua danh sách; mỗi collection một cặp key: `backups/qdrant/<collection>/{YYYYMMDD-HHMMSS}.tar` + `backups/qdrant/<collection>/latest.tar`.
- **Compat legacy:** `theopus_chunks` tiếp tục ghi THÊM key gốc `backups/qdrant/{date}.tar|latest.tar` (D0 §7.2 + tar cũ vẫn restore được; R2 dư 27MB/chunk-backup — chấp nhận, ghi chú trong code kèm mốc gỡ sau 2 chu kỳ backup).
- Lỗi 1 collection (vd agent_memory chưa tồn tại) → skip-graceful + log, KHÔNG fail cả batch (fail-open như write-through S1 FB-EE).

**S1.2 Restore per-collection + policy:**
- `findBackupKey(collection, date)`: tìm trong prefix per-collection; `theopus_chunks` fallback legacy root (tar cũ).
- Policy mới — hàm thuần export (unit-test được):
  `restoreDecision(collection, currentPoints): 'replace' | 'skip'` — chunks/documents → luôn `replace`; agent_memory/task_context → `currentPoints === 0 ? 'replace' : 'skip'` + log rõ lý do skip ("bảo vệ N điểm mới, backup chậm hơn data").
- `restoreQdrantFromR2` vòng for theo policy; tổng hợp per-collection vào response (đã có shape `results.qdrant` — mở rộng thành mảng, giữ trường cũ `restoredPoints` cho chunks để không phá UI/docs cũ).

**S1.3 Backfill `theopus_documents` (9 điểm đã mất — trước khi backup lần đầu):**
- Nguồn: 9 file `knowledge/SHD_*.TXT` còn nguyên trên repo + `chunking.ts` cùng tham số D0 (ml 640/96) → đếm chunks per file → `upsertDocument(id, payload)` theo đúng `DocumentPayload` có sẵn (qdrant.ts:435) — KHÔNG cần LLM/embedding (collection payload-only). Script 1 lần `scripts/backfill-qdrant-documents.ts` (~60 dòng).
- Rủi ro: payload fields phải khớp type `DocumentPayload` + payload-index đã tạo (qdrant.ts:250-262); nếu khớp không đủ → ghi nhận thiếu sót trong Bug_v2, không bịa field.

**S1.4 Regression r124** (pattern r123):
- Nhóm A source-scan: env default 4 collection · vòng for trong backup · per-collection key layout · legacy fallback chunks · policy branch restoreIfEmpty · skip-graceful.
- Nhóm B unit: `restoreDecision` 4 case (chunks thay · documents thay · memory rỗng thay · memory 5 điểm skip) · `findBackupKey` mock listR2Objects (per-collection hit, legacy fallback, miss→null).

**Verify nghiệm thu:** (1) chạy backup → R2 list đủ 4×2 key mới + legacy chunks; (2) xóa thử `theopus_documents` (đang 0 — vô hại) → restore → 9 điểm backfill; (3) giả lập "memory có data": upsert 2 điểm test vào agent_memory → restore → policy skip + 2 điểm còn nguyên; (4) restore dùng tar CŨ (root latest.tar 18-10) vẫn hồi 868 chunks.

### S2. Coverage ratchet trong gate (fix P2) — W1, ~1h

- Bên trong stage `tests` (chạy 1 lần, không chạy đôi): `bun test --coverage --coverage-reporter=lcov,text --coverage-dir=.quality-gate-coverage` (cùng DATABASE_URL test cô lập + preload hiện có).
- Parser lcov nhỏ (~60 dòng trong quality-gate.mjs hoặc module riêng): tổng hợp `LF:`/`LH:` toàn bộ file → `pct = LH/LF`.
- Baseline `scripts/coverage-baseline.json` `{ "lines": <pct> }` — sinh lần đầu bằng `--coverage-init` (ghi rõ trong comment cách tái hiện); sau đó **FAIL nếu `pct < baseline − 1,0 điểm%`**; pass nếu ngang/tăng. Chỉ store tổng — per-file tạo nhiễu (v0.1 không làm, ghi §8).
- Nâng/hạ baseline: lệnh chủ ý `--coverage-update-baseline` + bắt buộc ghi entry Bug_v2 khi hạ (audit được).
- KPI verify: hạ thủ công baseline −2đ% → gate FAIL; đưa về đúng → PASS.

### S3. Smoke contract read-only (fix P3) — W2, ~1,5h

- Thư mục mới `tests/smoke/` (bun test thường, KHÔNG preload DB-copy — đọc qua HTTP app thật): `/api/health` healthy + pointCount chunks > 0 · `/api/query?action=stats` shape đúng (totalDocuments/totalEntities/graphEntities) · `/api/agents?enabled=true` mảng + không trùng id · `/api/storage/snapshot-full` GET có qdrantBackups + currentQdrantPoints ≥ 0 · `/` HTML có title. Toàn bộ GET — 0 mutation (bài học Task 54).
- Stage mới `smoke` trong quality-gate: probe `/api/health` timeout 2s → **không reachable → SKIP** (reason "app không chạy — smoke bỏ qua (CI: app không có trong runner)") → local operator có smoke mỗi lần gate; CI GitHub tự SKIP đúng thiết kế.
- Regression r125: source-scan (stage smoke tồn tại + probe trước khi chạy) + 3 unit cho helper chọn skip.

### S4. Minh bạch hóa build-skip (fix P4) — W2, ~30m

- Verdict cuối in phân biệt: build PASS → "PASS đủ 5 stage"; build SKIP → dòng vàng rõ ràng **"BUILD CHƯA CHẠY (skip local) — CI GitHub sẽ chạy; KHÔNG kết luận build-được từ lần chạy này"** kèm lệnh tái hiện `TMO_REQUIRE_BUILD=1 bun scripts/quality-gate.mjs`.
- `TMO_REQUIRE_BUILD=1` (env) → SKIP build bị tính **FAIL** — dùng cho đợt phát hành/verify chính thức (đã có flag precedent `TMO_GATE_SKIP_BUILD` ngược chiều).
- KHÔNG cố chữa OOM 4GB (nguyên tắc §3-3); ghi rõ trong help.

### S5. Kiểm tra branch protection (fix P5) — W2, ~30m

- `scripts/check-branch-protection.mjs`: PAT parse từ remote URL (redact khi log — không in token) hoặc `GITHUB_TOKEN`; `GET /repos/vietnq130593-code/TMO/branches/main/protection`.
- 200 → kiểm `required_status_checks.contexts` chứa `quality-gate` + `enforce_admins.enabled` → in trạng thái; 404/403 → in 5 bước bật tay (Settings→Branches→Add rule main→Require status checks→chọn quality-gate→Require branches up to date).
- **Warn-only mặc định** (exit 0); `--strict` → exit 1 khi chưa bật — gắn vào PLAYBOOK checklist phát hành. R125 gộp 3 unit source-scan cho S4+S5 (giảm rác file test).

### S6. Chốt 3 quyết định treo → xem §7 (0 code)

---

## 5. LỘ TRÌNH TRIỂN KHAI

| Wave | Nội dung | Lý do thứ tự | Effort |
|---|---|---|---|
| **W1 — An toàn dữ liệu + lưới** | S1 (multi-collection backup + backfill documents + r124) · S2 (coverage ratchet) | S1 chặn mất dữ liệu thật (P2) — cao nhất mọi mục; S2 lấp lỗ lưới trước khi thêm stage khác | ~2,5h |
| **W2 — Tự động hóa còn lại** | S3 (smoke) · S4 (build minh bạch) · S5 (branch protection) + r125 | Sau khi lưới chắc; 3 việc nhỏ độc lập | ~2,5h |

---

## 6. KPI NGHIỆM THU

| KPI | Cách đo | Mục tiêu |
|---|---|---|
| Backup phủ đủ | R2 list sau backup | ≥4 collection × 2 key (dated + latest) + legacy chunks còn |
| Restore đúng policy | Thực hiện §4-S1 verify (1)-(4) | 4/4 kịch bản đúng — riêng memory-đang-có-data phải skip + data nguyên vẹn |
| Documents hồi sinh | pointCount sau backfill | 9/9 (theo 9 file knowledge/) |
| Coverage chặn tụt | Hạ baseline −2đ% thử | Gate FAIL; hồi đúng → PASS; thời gian stage tests tăng ≤ +15% |
| Smoke 2 trạng thái | Local (app chạy) / CI (không chạy) | PASS / SKIP — không FAIL giả, không PASS giả |
| Build verdict phân biệt | TMO_REQUIRE_BUILD=1 + skipBuild=true | Exit 1 + dòng cảnh báo; =0 → PASS kèm cảnh báo skip |
| Branch protection | Chạy script | In đúng trạng thái thật (200/404) + hướng dẫn đủ 5 bước |

---

## 7. ANTI-GOALS / QUYẾT ĐỊNH CHỐT (KHÔNG LÀM — có điều kiện reopen)

1. **Gộp 3 poller Smolab → TỪ CHỐI.** Lý do (đã cân nhắc ở REQ-AUDIT): 3 interval riêng tốn ~2 req/30s khi tab HIỂN THỊ — FIX1 (hidden gate) đã chặn phần lớn lãng phí (tab ẩn); gộp chạm 3 file component = diff churn lớn hơn lợi ích đo được. **Reopen khi:** composition request mới cho thấy cụm Smolab đứng top bảng.
2. **Micro-cache `/api/query?action=stats` → TỪ CHỐI.** Stats cần tươi NGAY sau khi user thao tác (ingest/delete) — TTL cache sẽ phục vụ số cũ đúng lúc người dùng đang chờ kết quả hành động của mình. **Reopen khi:** thiết kế được invalidate theo action (như FIX2 đã làm cho 9 mutation) mà không tăng phức tạp đáng kể.
3. **8b NIM utility → GIỮ fail-open, KHÔNG thêm bây giờ.** Điều kiện kích hoạt (đã có rule sẵn): P6 observation alerts bắt 403 lặp ≥2 lần/24h trên utility-core. Khi kích hoạt: thêm 1 model NIM vào pool utility — effort ~30m (pool key NIM sẵn có từ R39). Thêm bây giờ = tối ưu mù khi chưa có bằng chứng tần suất thật.
4. **KHÔNG cố ép `next build` chạy trên box 4GB** (S4 chỉ minh bạch hóa, không chữa OOM — §3-3).
5. **KHÔNG đưa e2e cần LLM/stack sống vào gate** (§3-4) · KHÔNG đặt coverage bar tuyệt đối (§3-2) · KHÔNG đổi concurrency/SUBAGENT caps (giữ nguyên mọi anti-goal của EXECUTION-EFFICIENCY).

---

## 8. ĐIỂM GÃY CẦN CẨN THẬN (triển khai phải đối chiếu từng điểm)

1. **Restore REPLACE bằng tar CŨ:** per-collection key mới phải fallback legacy root cho chunks — nếu quên, "No backup found" sẽ giết đường hồi phục 868 chunks đã chứng minh (2,3s).
2. **Race restoreIfEmpty:** agent có thể ghi điểm mới trong cửa sổ 2s giữa lúc đọc pointCount và upload snapshot — chấp nhận + log (cửa hẹp; trường xấu vẫn còn 1 bản data trong backup).
3. **Coverage baseline nhảy khi thêm/xóa test/file lớn** — chỉ được cập nhật chủ ý qua `--coverage-update-baseline` + entry Bug_v2 khi hạ; không tự trượt.
4. **`bun test --coverage` trên full suite chưa đo RAM/thời gian** — triển khai S2 phải thí điểm 1 lần trước khi bật mặc định; nếu tăng >15% thời gian hoặc gây OOM thì tách `--stage=coverage` opt-in và ghi quyết định (không im lặng).
5. **Smoke không được mutation** — review từng test theo bài học Task 54 (test từng cướp cờ isActive); chỉ GET + assert shape.
6. **PAT không được in ra log** (S5) — parse remote xong redact ngay; script fail-close khi không có token (in hướng dẫn, exit 0 warn-only).
7. **Tar backup giờ chứa data sống (agent_memory)** — R2 là object storage riêng tư nhưng review lại chính sách retention nếu agent_memory phình (hiện 0 điểm — an toàn; ghi theo dõi trong Bug_v2 khi mở).

---

## 9. LỊCH SỬ HIỆU ĐÍNH

- **0.1 (2026-10-19):** bản đầu — gom 6 việc từ 4 nguồn (W3-REGTEST-1 · đánh giá regression 7 lớp · REQ-AUDIT ghi nhận · BUG2-304); mọi số đo live 2026-10-19; S1.3 backfill thêm sau khi phát hiện SQLite `Document`=0 (nguồn duy nhất còn: 9 file `knowledge/SHD_*.TXT` trên repo).
