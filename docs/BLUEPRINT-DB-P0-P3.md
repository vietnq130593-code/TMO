# BLUEPRINT TRIỂN KHAI P0 → P3 — SỬA LỖI KIẾN TRÚC DATABASE TMO

> **Phiên bản:** 1.0 — Round-32
> **Nguồn gốc:** Kết quả rà soát kiến trúc DB 4 tầng tận tầng code (Round-31, 3 Explore subagents + tự kiểm chứng 7/7 phát hiện nghiêm trọng bằng đọc trực tiếp code)
> **Phạm vi:** 5 bug 🔴 P0 (phá chức năng thật) + 3 vấn đề P1 + 3 nợ kỹ thuật P2 + 4 hạng mục P3 (nợ dài hạn)
> **Trạng thái:** BLUEPRINT — chưa sửa dòng code nào. Mọi file:line dưới đây đã được kiểm chứng trực tiếp trên HEAD `5799d4d`.

---

## 0. TÓM TẮT ĐIỀU HÀNH

| ID | Mức | Vấn đề | File chính | Hệ quả nếu không sửa | Effort |
|----|------|--------|-------------|----------------------|--------|
| P0-1 | 🔴 Phá chức năng | db-backup `DB_PATH` suy đoán path, có nhánh trỏ scaffold DB | `storage/db-backup/route.ts:43-45` | Backup nhầm DB / restore đè mất DB thật | 1-2h |
| P0-2 | 🔴 Phá chức năng | `checkpointWal` gọi tagged-template → Prisma throw mọi lần → WAL không bao giờ checkpoint | `storage/db-backup/route.ts:57-72` | Backup chụp file thiếu dữ liệu trong `-wal` (cũ hơn thực tế, im lặng) | 0.5h |
| P0-3 | 🔴 Phá chức năng | Auto-learn point ID `al-...` không phải UUID → Qdrant 400 mọi upsert | `lib/auto-learn.ts:547` | Toàn bộ auto-learned knowledge không bao giờ được index vector | 0.5h |
| P0-4 | 🔴 Phá chức năng | Step 11 re-upsert payload tối thiểu → **wipe** metadata Step 4 + renumber `chunk_index` sai trên resume | `ingestion/process/route.ts:1969-2017` | Mất heading_path/token_count/domain; thứ tự chunk sai | 1-2h |
| P0-5 | 🔴 Phá chức năng | Resume tin "chunk tồn tại = đã embed" → doc zero-vector vĩnh viễn nhưng status `'indexed'` | `ingestion/process/route.ts:3815-3841` | Crash giữa Step 4-11 = doc chết không tự chữa, retrieval rác | 2-3h |
| P1-a | 🟠 Đáng sửa | dbQuery guard deny-list thiếu `REPLACE/VACUUM/ANALYZE/BEGIN` — bypass **ĐANG LIVE** (`ENABLE_DB_QUERY=true` `.env:453`) | `code-team/dev-tools.ts:5110-5218` | Agent ghi được vào DB "read-only" qua `REPLACE INTO`/`VACUUM` | 1h |
| P1-b | 🟠 Đáng sửa | Fulltext `entity_name_search` thiếu 2 label mới `Technology/Framework` (~8.800 node cloud), còn liệt kê 5 label đã bỏ | `lib/neo4j.ts:723` | Fuzzy entity resolution hỏng cho 2 label phổ biến nhất | 1-2h |
| P1-c | 🟠 Đáng sửa | Lesson credit assignment: phạt/thưởng dàn trải cả episode | `episodic-memory/lessons.ts:211-251` | Confidence lesson sai lệch tích lũy → auto-apply quyết sai | 2-3h |
| P2-a | 🟡 Nợ kỹ thuật | ToolMetric phình vô hạn (1 row/tool call, không TTL, không archival) | `lib/tool-metrics-recorder.ts` + schema L1052 | DB phình, analytics chậm dần (ALISTA rules.ts:585 tự nhận ra nhưng chưa triển khai) | 2-3h |
| P2-b | 🟡 Nợ kỹ thuật | `updateChunkDomains` scroll 1 trang 1000 + read-modify-write | `query/route.ts:1662-1688` | Doc >1000 chunk chỉ update domain một phần, im lặng | 0.5h |
| P2-c | 🟡 Nợ kỹ thuật | Không guard kích thước vector collection (đổi embed model dim = chết im lặng cả Qdrant lẫn Neo4j index) | `lib/qdrant.ts:139-209` | Đổi model embedding → mọi upsert 400, cùng lớp triệu chứng P0-3 | 1-2h |
| P3-a | 🟢 Dài hạn | `mapOutcome` dead ternary (cả 2 nhánh `'FAILURE'`) | `episodic-memory/recorder.ts:60` | Dead-code gây hiểu nhầm semantics (không đổi hành vi) | 0.25h |
| P3-b | 🟢 Dài hạn | Không có migrations workflow (chỉ `db push`) | `package.json` | Không biết schema nào chạy trên DB backup nào — restore drift im lặng | 3-4h |
| P3-c | 🟢 Dài hạn | Backup không có verify/round-trip drill, không có cron | `storage/db-backup/route.ts` | Tin tưởng mù quáng vào backup chưa từng được kiểm chứng | 2h |
| P3-d | 🟢 Dài hạn | RL-readiness: có ~70% hạ tầng reward, thiếu credit assignment + policy update + unified ledger | nhiều file | Không tận dụng được tín hiệu học đã thu thập | Roadmap |

**Tổng effort ước tính:** P0 ≈ 6-9h · P1 ≈ 4-6h · P2 ≈ 4-5.5h · P3 ≈ 7-9h + roadmap.

---

## 1. NGUYÊN TẮC THỰC THI (ÁP DỤNG CHO MỌI MỤC)

1. **Chuẩn verify 3 tầng giữa mỗi đợt** (không bỏ qua): `bunx tsc --noEmit` → `bun run lint` → `bun test` (253 test phải xanh) → E2E `POST /api/tools/execute` → agent-browser UI sạch 0 console error.
2. **Fail-open giữ nguyên** với mọi code nằm trên đường request agent (recorder, tool-metrics, auto-learn, episodic) — fix không được làm hỏng đường chính.
3. **Mỗi fix một commit riêng** có message `fix(P0-x): ...` — không trộn lẫn các mức để rollback độc lập.
4. **Sau mỗi đợt: push GitHub** (lớp PAT 3 tầng đã lưu sẵn — dùng `db/.github-token.json` hoặc credential store).
5. **Không đổi semantics đang vận hành** nếu không có chứng cứ — ví dụ P3-a giữ nguyên `'FAILURE'` (xem phân tích).
6. Mọi hằng số mới (labels, keywords, dim) **dẫn xuất từ một nguồn duy nhất** (ENTITY_LABELS, getEmbeddingDimension) — cấm hardcode lần thứ hai.

---

# PHẦN P0 — 5 BUG 🔴 PHÁ CHỨC NĂNG (làm ngay, đợt 1)

---

## P0-1 · db-backup backup sai DB — `DB_PATH` suy đoán path thay vì hỏi SQLite

### Triệu chứng & hệ quả
Endpoint `POST /api/storage/db-backup` có nhiệm vụ snapshot SQLite → R2, và restore đè ngược lại. Nếu backup đọc **file khác** file Prisma đang mở, hoặc restore ghi đè nhầm chỗ — thì toàn bộ "đai an toàn dữ liệu" này là ảo tưởng: backup về scaffold DB rỗng, restore thì **xóa sạch DB thật**.

### Root cause (đã kiểm chứng)
`src/app/api/storage/db-backup/route.ts:43-45`:
```ts
const DB_PATH = process.env.DATABASE_URL
  ? process.env.DATABASE_URL.replace(/^file:/, '').replace(/^\.\.\//, '/home/z/my-project/db/')
  : '/home/z/my-project/db/custom.db'
```
Ba khuyết điểm chồng nhau:
- **(a) Hardcode stale** `/home/z/my-project/db/` — di sản từ thời app còn nằm ở `my-project`. `.env:38` là `DATABASE_URL=file:../db/custom.db`; nếu chuỗi này đến tay route ở dạng raw (chưa được IIFE trong `db.ts` chuẩn hóa) thì rewrite cho ra `/home/z/my-project/db/db/custom.db` — **không tồn tại** (đã chạy thử: `missing`) → backup trả 404.
- **(b) Fallback trỏ scaffold**: nhánh default là `/home/z/my-project/db/custom.db` — chính là **DB của project scaffold** (đã xác nhận tồn tại, 1.7MB, schema User/Post). Kịch bản dính: shell sandbox xuất khẩu trap `DATABASE_URL=file:/home/z/my-project/db/custom.db` (file tồn tại!) → env-leak-guard trong `db.ts:61-73` theo policy "env kế thừa trỏ file tồn tại → GIỮ NGUYÊN" → cả app lẫn route backup mở **scaffold DB**. Hiện tại PM2 an toàn vì `pm2-start.sh` `unset DATABASE_URL` — nhưng mọi đường chạy thủ công (`bun run dev` từ shell) dính bẫy. Đây chính là lớp tai nạn đã từng xảy ra thật (round-1/18).
- **(c) Suy đoán thay vì hỏi**: path được đoán bằng chuỗi regex tại module-load-time, trong khi chính SQLite đang mở sẵn file và biết chính xác 100% path của nó.

### Thiết kế fix
**Nguyên tắc: hỏi SQLite path thật — không đoán.** SQLite có sẵn `PRAGMA database_list` trả về đúng file mà connection đang mở (row `main`, cột `file`).

```ts
/** Hỏi chính SQLite: file nào connection đang mở? (row 'main', cột 'file') */
async function resolveLiveDbPath(): Promise<string> {
  const rows = await db.$queryRawUnsafe<Array<{ name: string; file: string }>>(
    'PRAGMA database_list'
  )
  const main = rows.find(r => r.name === 'main')
  if (!main?.file) throw new Error('PRAGMA database_list không trả về file của DB main')
  return main.file // tuyệt đối, đúng 100% với file Prisma đang mở
}
```
Thay `const DB_PATH = ...` (module-level) bằng resolve **mỗi lần gọi** (route đã `force-dynamic`; PRAGMA rẻ như thường xuyên). Giữ fallback phòng khi PRAGMA fail: derive theo cùng logic `findProjectRoot()` của `db.ts` (schema-relative `prisma/../db/custom.db`), **kiêm tra path nằm trong project root** trước khi dùng:

```ts
function fallbackDbPath(): string | null {
  const raw = (process.env.DATABASE_URL || '').replace(/^file:/, '')
  const root = findProjectRoot() // cùng helper db.ts — export ra lib chung nếu cần
  const p = path.isAbsolute(raw) ? raw : path.resolve(path.join(root, 'prisma'), raw)
  return p.startsWith(root + path.sep) && fs.existsSync(p) ? p : null
}
```
Chốt chặn cuối (bắt buộc trước khi upload/restore):
```ts
// Trong POST handler, trước mọi upload/restore:
const livePath = await resolveLiveDbPath()
if (DB_PATH !== livePath) {
  return NextResponse.json(
    { error: `DB path mismatch: endpoint tính toán "${DB_PATH}" nhưng Prisma đang mở "${livePath}" — từ chối thao tác để tránh backup/restore nhầm DB` },
    { status: 500 }
  )
}
```
Xóa hoàn toàn hai chuỗi `/home/z/my-project/db/` khỏi file (grep lại sau khi sửa: 0 match).

### Các bước thực hiện
1. Sửa `route.ts`: thêm `resolveLiveDbPath()` + `fallbackDbPath()`, bỏ `DB_PATH` module-level, thêm bước verify mismatch (cả 3 hành động: backup L90-120, restore L154, và mọi chỗ dùng `DB_PATH`).
2. Restore path cũng phải qua cùng verify (restore ghi đè `DB_PATH` tại L154 — hiện đang `downloadFileFromR2(keyToRestore, DB_PATH)`).
3. Cập nhật comment header file (L18 đang ghi `/home/z/my-project/db/custom.db` — stale cùng lớp).

### Kiểm chứng
- Unit/scratch: gọi `resolveLiveDbPath()` trong app context → phải trả `/home/z/tmo-app/db/custom.db` (so với `lsof -p <pid> | grep custom.db`).
- E2E: `POST /api/storage/db-backup` → response `dbPath` = path thật; tải object về từ R2, `sqlite3 <file> "PRAGMA integrity_check; SELECT count(*) FROM sqlite_master;"` → 88+ bảng TMO (không phải 2-4 bảng scaffold).
- Choreo kịch bản trap: `DATABASE_URL=file:/home/z/my-project/db/custom.db` vào env rồi chạy endpoint (dev instance) → phải nhận 500 mismatch thay vì backup scaffold.

### Rủi ro & rollback
- Rủi ro: PRAGMA trả path empty với DB :memory: (không xảy ra với app — luôn file). Fallback đã phủ.
- Rollback: 1 commit revert, không dính schema/data.

---

## P0-2 · `checkpointWal` chết từ ngày sinh — tagged-template vào `$executeRawUnsafe`

### Triệu chứng & hệ quả
Mọi lần backup log `[DB-Backup] WAL checkpoint failed (non-fatal — snapshot may be slightly stale)` — tức **WAL chưa bao giờ được checkpoint thành công**. Prisma mở DB chế độ WAL (ghi trong comment L54-55 của chính file) → các commit mới nhất nằm trong `custom.db-wal`; backup chỉ đọc `custom.db` → **snapshot cũ hơn thực tế** mà vẫn trả 200 thành công. Với backup định kỳ (cron hằng ngày), mất trắng các commit từ lần checkpoint cuối (hoặc từ never).

### Root cause (đã kiểm chứng)
`route.ts:57-72`:
```ts
await (db.$executeRawUnsafe as unknown as (strings: TemplateStringsArray) => Promise<number>)`PRAGMA wal_checkpoint(TRUNCATE)`
```
Gọi **tagged template** `` db.$executeRawUnsafe`...` `` truyền `TemplateStringsArray` vào hàm nhận `string` → Prisma throw mọi lần. Comment L61-63 tự thừa nhận: *"gọi dạng tagged-template nên runtime nhận TemplateStringsArray (Prisma sẽ throw → catch bên dưới, giữ behavior gốc)"* — một fix đã được định vị đúng chỗ nhưng bị đóng băng "giữ behavior gốc" (tức là cố tình bảo tồn bug).

### Thiết kế fix
```ts
async function checkpointWal(): Promise<{ ok: boolean; busy: boolean }> {
  try {
    // $queryRawUnsafe vì PRAGMA trả RESULT SET (không phải affected-rows) —
    // $executeRawUnsafe sẽ throw "did not return a count" với PRAGMA có trả row.
    const rows = await db.$queryRawUnsafe<Array<{ wal: number; busy: number }>>(
      'PRAGMA wal_checkpoint(TRUNCATE)'
    )
    const busy = !!rows?.[0]?.busy
    if (busy) {
      // Có reader chặn checkpoint toàn phần — thử lại 1 lần sau 500ms
      await new Promise(r => setTimeout(r, 500))
      const retry = await db.$queryRawUnsafe<Array<{ busy: number }>>('PRAGMA wal_checkpoint(TRUNCATE)')
      if (retry?.[0]?.busy) {
        console.warn('[DB-Backup] WAL checkpoint busy 2 lần — snapshot có thể thiếu frame WAL cuối')
        return { ok: true, busy: true }
      }
    }
    console.log('[DB-Backup] WAL checkpointed')
    return { ok: true, busy: false }
  } catch (err) { /* giữ fail-open như cũ, log rõ hơn */ }
}
```
**Nâng cấp khuyến nghị (làm cùng commit, thay thế cách đọc file trực tiếp):** dùng `VACUUM INTO` để chụp snapshot nhất quán — tự gộp WAL, không phụ thuộc checkpoint, không khoá DB:
```ts
// Backup path:
const tmpSnapshot = path.join(os.tmpdir(), `tmo-backup-${Date.now()}.db`)
await db.$queryRawUnsafe(`VACUUM INTO '${tmpSnapshot.replaceAll(`'`, `''`)}'`) // escape quote
const buffer = await fs.readFile(tmpSnapshot)
await fs.unlink(tmpSnapshot).catch(() => {})
// … upload buffer như cũ
```
`VACUUM INTO` là cách backup chuẩn của SQLite (tạo file độc lập mới, nhất quán, không cần file đích tồn tại trước — trái ngược rollback `VACUUM TO`), tránh được cả lỗi torn-read lẫn chuyện checkpoint busy. Giữ `checkpointWal` như belt-and-braces (log thêm `busy` để theo dõi).

### Các bước thực hiện
1. Đổi call sang `$queryRawUnsafe('PRAGMA wal_checkpoint(TRUNCATE)')` (string thường) — xóa cast xấu và comment tự thú tội.
2. Thêm nhánh retry khi `busy=1`.
3. (Khuyến nghị) chuyển body backup sang `VACUUM INTO` + đọc file snapshot tạm.
4. Bổ sung response: `walCheckpointed: true/false, busy` để vận hành thấy được.

### Kiểm chứng
- Trước fix: log luôn xuất hiện "checkpoint failed". Sau fix: log "[DB-Backup] WAL checkpointed" + PRAGMA trả `{wal: N, busy: 0}`.
- Kiểm chứng snapshot tươi: ghi 1 row test → backup ngay (không chờ) → restore xuống tmp → đọc được row test (chứng tỏ WAL đã vào snapshot). Với `VACUUM INTO`: kiểm chứng tự động nhờ thiết kế.
- `PRAGMA integrity_check` trên file backup = `ok`.

### Rủi ro & rollback
- `VACUUM INTO` cần chỗ trống đĩa ~ kích thước DB (hiện 1.7MB — không vấn đề; đặt ở `/tmp`).
- Nếu Aura/Prisma driver chặn VACUUM INTO vì transaction đang mở (không xảy ra — Prisma autocommit), fallback đã có: đường checkpoint + readFile cũ vẫn còn.
- Rollback: revert 1 commit.

---

## P0-3 · Auto-learn point ID `al-...` → Qdrant 400 **mọi lần** — knowledge không bao giờ được index

### Triệu chứng & hệ quả
Mỗi lần auto-learn tổng hợp được bài học/sự kiện mới, log chỉ in `[AutoLearn] Failed to save chunk to Qdrant` (im lặng trong `warn`). Kết quả: **toàn bộ auto-learned knowledge từ trước đến nay không tồn tại trong collection vector** — không truy hồi được qua semantic search. Lớp "học" của hệ thống mất đúng nửa mà không ai hay (SQLite vẫn có `AutoLearnRecord`, nhìn UI tưởng đủ).

### Root cause (đã kiểm chứng)
`src/lib/auto-learn.ts:547`:
```ts
const pointId = `al-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
```
Qdrant chỉ chấp nhận point ID là **UUID hoặc unsigned integer**. `al-1759...-x7f2` là chuỗi tự do → Qdrant trả **400 Bad Request** với mọi upsert. `upsertChunks` (`lib/qdrant.ts:600-631`) nuốt error, trả `false` → `saveChunkToQdrant` trả `undefined` → `AutoLearnRecord.qdrantPointId` = null.

**Tiền lệ nội bộ đã fix đúng lớp lỗi này:** `episodic-memory/episode-store.ts:130-133` — comment ghi rõ *"FIX (E2E 2026-08-29): Qdrant point id phải là UUID — 'ep_...' bị 400 Bad Request. Deterministic UUID v5-style từ episodeId (crypto hash) để re-record cùng episode không nhân bản point"*. Tức codebase **đã từng trả giá** cho đúng lỗi này ở tầng episodes nhưng bỏ sót tầng auto-learn.

### Thiết kế fix
Theo đúng pattern đã chứng minh của episode-store:
1. Export `deterministicUuid(seed: string)` từ `episodic-memory/episode-store.ts:31` (hiện là private function) — hoặc chuyển vào `src/lib/uuid.ts` chung và import lại từ episode-store (giữ 2 call site cùng nguồn).
2. `auto-learn.ts:547`:
```ts
// Qdrant point id phải là UUID (ràng buộc Qdrant — xem episode-store.ts:130).
// Deterministic từ AutoLearnRecord id: re-save cùng record → upsert đè cùng point,
// không nhân bản. Định danh gốc giữ trong payload (auto_learn_id) cho đối chiếu.
const pointId = deterministicUuid(`al:${params.documentId}:${summaryHash}`)
```
(với `summaryHash` là hash nội dung đã có sẵn ở caller — hoặc chính `params.documentId` nếu mỗi record 1 id duy nhất.)
3. Thêm `auto_learn_id: params.documentId` vào payload (L557-573) để truy vết ngược từ Qdrant về record.

### Các bước thực hiện
1. Refactor `deterministicUuid` về module chung (touch 2 file: episode-store.ts import lại, không đổi hành vi).
2. Sửa `auto-learn.ts:547` + thêm payload field.
3. Nâng lỗi 400 lên cảnh báo rõ hơn trong `upsertChunks` (log kèm 1-2 point ID mẫu bị reject — giúp bắt lớp lỗi ID tương tự trong tương lai): sửa 1 dòng log trong `lib/qdrant.ts:627` thêm `chunks[0]?.id`.

### Kiểm chứng
- E2E: trigger 1 vòng auto-learn (hoặc gọi trực tiếp `saveChunkToQdrant` với vector dummy qua scratch route) → `upsertChunks` true → `GET /collections/tmo_chunks` point count +1 → retrieve point bằng ID trả về → payload đủ `auto_learned: true`.
- Re-trigger cùng record → count **không** tăng (deterministic ID đè).
- `bun test` — không test nào phụ thuộc format `al-` (grep xác nhận khi thực hiện).

### Rủi ro & rollback
- Không migration dữ liệu: các AutoLearnRecord cũ (qdrantPointId null) muốn index lại thì cần 1 lượt re-embed đơn giản (thêm endpoint `?action=reindex-autolearn` — **tùy chọn**, xếp vào P3-c nếu cần; DB local hiện trắng sau reset nên không gấp).
- Rollback: revert 1 commit.

---

## P0-4 · Step 11 re-upsert payload tối thiểu → **wipe** metadata Step 4 + renumber `chunk_index` sai

### Triệu chứng & hệ quả
Sau khi ingestion hoàn tất, các chunk trong Qdrant **mất trắng** `heading_path`, `token_count`, `domain`, `chapter`… — toàn bộ metadata giàu có được ghi ở Step 4. Retrieval phụ thuộc các field này (MMR diversification theo domain, hiển thị heading nguồn, token budget theo token_count) → suy giảm chất lượng không thể thấy từ UI. Trên resume, `chunk_index` bị renumber theo batch con → **thứ tự chunk sai** (`getChunksByDocument` sort theo `chunk_index` ở `qdrant.ts:683` — context ghép sai trật tự tài liệu).

### Root cause (đã kiểm chứng)
`src/app/api/ingestion/process/route.ts:1969-2017` — `generateAndSaveEmbeddings` mang một niềm tin SAI về semantics Qdrant (comment L1976-1978):
```ts
// Instead, we simply UPSERT chunks with real vectors, overwriting only the vector field.
// Qdrant's upsert is atomic and preserves any payload fields not explicitly overwritten.
```
**Sự thật:** Qdrant upsert **REPLACE toàn bộ point** khi payload được cung cấp. Ở L1994-1999, code upsert kèm payload tối thiểu:
```ts
payload: {
  document_id: documentId,
  chunk_index: i,          // ← i = index TRONG BATCH, không phải index trong document!
  content: chunk.content,
  created_at: new Date().toISOString(),
}
```
→ mọi field không nhắc (heading_path/token_count/domain — được ghi đầy đủ tại Step 4 fresh L2516-2536 và rebuild L2410-2424) bị **xóa**. Trên resume, `chunksNeedingEmbeddings` là tập con → `chunk_index: i` chạy lại từ 0 → renumber sai toàn bộ.

### Thiết kế fix
**Dùng đúng API Qdrant cho việc này: `updateVectors` — chỉ cập nhật vector, payload giữ nguyên tuyệt đối.** (Client `@qdrant/js-client-rest@^1.18.0` đã có sẵn.)

Thêm helper trong `src/lib/qdrant.ts` (ngay sau `upsertChunks`, cùng style batch/retry):
```ts
/**
 * Cập nhật CHỈ vector của các chunk point — payload giữ nguyên tuyệt đối.
 * Qdrant updateVectors không đụng payload (khác upsert = REPLACE toàn point).
 * Yêu cầu: point phải đã tồn tại (được upsert sẵn ở Step 4 với payload đầy đủ).
 */
export async function updateChunkVectors(
  points: Array<{ id: string; vector: number[] }>
): Promise<boolean> {
  try {
    const BATCH = 100
    for (let i = 0; i < points.length; i += BATCH) {
      const batch = points.slice(i, i + BATCH)
      await withQdrantRetry(async () => {
        await qdrant.updateVectors(COLLECTION_CHUNKS, {
          wait: true,
          points: batch.map(p => ({ id: p.id, vector: p.vector })),
        })
      })
    }
    lastQdrantError = null
    return true
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[Qdrant] updateChunkVectors error:', msg, '(sample id:', points[0]?.id, ')')
    lastQdrantError = msg
    return false
  }
}
```
Sửa `generateAndSaveEmbeddings` (`process/route.ts:1969-2017`):
```ts
async function generateAndSaveEmbeddings(chunks: Array<{ id: string; content: string }>, documentId: string): Promise<number> {
  if (chunks.length === 0) return 0
  try {
    const texts = chunks.map(c => c.content)
    const embeddingResults = await generateEmbeddingBatch(texts)
    const vectorPoints = []
    for (let i = 0; i < chunks.length; i++) {
      const emb = embeddingResults[i]
      if (emb?.vector && emb.vector.length === EMBEDDING_DIMENSION) {
        vectorPoints.push({ id: chunks[i].id, vector: emb.vector })
      }
    }
    if (vectorPoints.length > 0) {
      const ok = await updateChunkVectors(vectorPoints)   // ← CHỈ vector, không đụng payload
      if (!ok) {
        console.error(`[Process] updateChunkVectors returned false cho doc ${documentId} — chunks có thể còn zero-vector (P0-5 guard sẽ chặn 'indexed')`)
      }
    }
    return vectorPoints.length
  } catch (error) {
    console.error('[Process] Embedding batch error:', error)
    return 0
  }
}
```
Xóa: tham số `_skipDeletion` (đã chết), toàn bộ comment tin sai semantics, payload construction. `documentId` giữ cho log.

**Nhánh fallback phòng xa** (không bắt buộc, ghi chú trong code): nếu `updateVectors` fail vì point chưa tồn tại (luồng giả định nào đó của tương lai), fallback retrieve payload hiện có (`qdrant.retrieve(collection, { ids, with_payload: true })`) rồi upsert đày đủ field — không bao giờ tự bịa payload tối thiểu.

### Các bước thực hiện
1. Thêm `updateChunkVectors` vào `lib/qdrant.ts`.
2. Rewrite `generateAndSaveEmbeddings` như trên; cập nhật 2 call site (L3835 và chỗ còn lại nếu có — grep `generateAndSaveEmbeddings(`).
3. Cập nhật comment Step 11 tại L3792-3794 cho đúng semantics mới.

### Kiểm chứng
- E2E ingestion 1 tài liệu mẫu qua nút "Xử lý": sau khi xong, scroll vài point → payload **vẫn còn** `heading_path`, `token_count`, `domain` + vector thật (≠ 0) + `chunk_index` khớp Step 4.
- Resume case: pause giữa pipeline (dùng cơ chế pause sẵn có `isDocPaused`) → resume → chunk_index không đổi so với trước pause.
- `bun test` + `tsc` + `lint` xanh.

### Rủi ro & rollback
- Rủi ro duy nhất: gọi updateVectors với point chưa tồn tại (Qdrant bỏ qua ID lạ trong updateVectors — không tạo point mới). Mọi đường hiện tại đều upsert trước (Step 4 fresh/rebuild/resume) nên không xảy ra; guard P0-5 chặn hậu quả tàn dư.
- Rollback: revert 1 commit (helper mới không ai khác dùng).

---

## P0-5 · Resume tin "chunk tồn tại = đã embed" → doc zero-vector vĩnh viễn, status `'indexed'`

### Triệu chứng & hệ quả
Pipeline upsert chunk với **vector zero placeholder** ở Step 4 (`new Array(EMBEDDING_DIMENSION).fill(0)` — L2413 rebuild; fresh path tương tự ~L2516-2560) rồi mới sinh embedding thật ở Step 11. Nếu process chết/pause giữa hai bước (OOM, restart, user pause — đều đã xảy ra thật trong lịch sử vận hành), lần resume sau sẽ:
1. Coi **mọi** chunk hiện hữu là "đã embed" → sinh 0 embedding mới;
2. Trả `embeddingsSaved = savedChunks.length` (báo cáo ảo — L3840);
3. Đặt `status: 'indexed'` (L3849).

Kết quả: doc **vĩnh viễn zero-vector nhưng 'indexed'** — retrieval không bao giờ match (cosine 0), và mọi lần "Xử lý" sau đó đều skip vì `hasEmbeddingsData`/`'indexed'`. Không có đường tự chữa.

### Root cause (đã kiểm chứng)
`process/route.ts:3820-3832`:
```ts
const embeddedChunkIds = new Set<string>()
const allChunksForEmb = await getChunksByDocument(documentId, { limit: 10000 })
// Check which chunks have non-zero vectors (indicating real embeddings)   ← comment nói đúng ý
for (const chunk of allChunksForEmb) {
  embeddedChunkIds.add(chunk.id)   // ← code làm ngược lại: add TẤT CẢ, không kiểm vector!
}
```
`getChunksByDocument` (`qdrant.ts:640-693`) scroll với `with_payload: true` nhưng **không có `with_vector`** → vector không được trả về → code cũ muốn kiểm cũng không có dữ liệu, nên "giả định" luôn luôn. Kèm theo L3840 `: savedChunks.length` đếm ảo.

### Thiết kế fix (3 lớp, cùng commit)

**Lớp 1 — `getChunksByDocument` trả được vector** (`lib/qdrant.ts:640-693`):
```ts
export async function getChunksByDocument(
  documentId: string,
  options?: { limit?: number; withVector?: boolean }
): Promise<Array<{ id: string; payload: ChunkPayload; vector?: number[] }>> {
  // ... trong qdrant.scroll options:
  with_payload: true,
  with_vector: options?.withVector ?? false,
  // ... push: { id: String(p.id), payload: ..., vector: p.vector as number[] | undefined }
}
```
(Các caller hiện tại không truyền `withVector` → không đổi hành vi, không ảnh hưởng call site khác.)

**Lớp 2 — resume chỉ tin vector thật** (`process/route.ts:3820-3832`):
```ts
if (isResuming && !rebuiltChunksFromPdf) {
  const embeddedChunkIds = new Set<string>()
  const allChunksForEmb = await getChunksByDocument(documentId, { limit: 10000, withVector: true })
  const hasRealVector = (v?: number[]) => !!v && v.some(x => Math.abs(x) > 1e-9)
  for (const chunk of allChunksForEmb) {
    if (hasRealVector(chunk.vector)) embeddedChunkIds.add(chunk.id)  // chỉ vector THẬT
  }
  chunksNeedingEmbeddings = savedChunks.filter(c => !embeddedChunkIds.has(c.id))
  console.log(`[Process] Embeddings: ${embeddedChunkIds.size} vector thật, ${chunksNeedingEmbeddings.length} cần re-embed (zero-vector được phát hiện)`)
}
```
**Lớp 3 — guard "không bao giờ 'indexed' khi còn zero-vector"** (chống mọi biến thể tương lai, sau L3841):
```ts
// GUARD P0-5: đối chiếu sau cùng — doc còn bất kỳ zero-vector nào thì KHÔNG được 'indexed'
const verifyChunks = await getChunksByDocument(documentId, { limit: 10000, withVector: true })
const zeroVectorCount = verifyChunks.filter(c => !(c.vector ?? []).some(x => Math.abs(x) > 1e-9)).length
if (zeroVectorCount > 0) {
  console.error(`[Process] P0-5 GUARD: ${zeroVectorCount}/${verifyChunks.length} chunk vẫn zero-vector — giữ 'partial' thay vì 'indexed'`)
  await updateDocProgress(documentId, { status: 'partial' })
  // vẫn trả result kèm warning để UI thấy
} else {
  await updateDocProgress(documentId, { status: 'indexed' })
}
```
Và sửa L3840: khi `chunksNeedingEmbeddings.length === 0`, `embeddingsSaved` = số chunk có vector thật (biết được từ Lớp 2), không phải `savedChunks.length`.

### Các bước thực hiện
1. `qdrant.ts` — thêm option `withVector` (3 dòng).
2. `process/route.ts` — Lớp 2 thay block 3820-3832; Lớp 3 thay dòng 3849; sửa 3834-3840.
3. Grep các call site khác của `getChunksByDocument` xác nhận không vỡ type (thêm field tùy chọn — an toàn).

### Kiểm chứng
- Kịch bản crafted (scratch): upsert 3 point vào collection test (2 vector thật + 1 zero) → gọi logic mới → đúng 1 chunk vào `chunksNeedingEmbeddings`.
- E2E trọn vẹn nhất: cho 1 doc chạy tới giữa Step 4-11 (pause bằng API pause sẵn có) → verify Qdrant có zero-vector → resume → doc về `'indexed'`, **0** zero-vector còn lại, payload nguyên vẹn (cùng verify với P0-4).
- Guard: giả lập `updateChunkVectors` fail (tắt qdrant tạm) → doc phải dừng `'partial'`, log GUARD, không bao giờ `'indexed'`.

### Rủi ro & rollback
- Chi phí thêm: 1 scroll with_vector trên doc khi resume + 1 scroll verify cuối pipeline — rẻ (payload của 1 doc), chấp nhận được.
- `with_vector: true` làm response nặng hơn (vector 2048 × N chunk) — chỉ bật ở 2 điểm cần, các caller khác giữ nguyên.
- Rollback: revert 1 commit; không schema change.

---

# PHẦN P1 — 3 VẤN ĐỀ ĐÁNG SỬA (đợt 2)

---

## P1-a · dbQuery guard thiếu SELECT-prefix enforcement — write bypass **ĐANG LIVE**

### Triệu chứng & hệ quả
Tool `db_query` cho agent đọc SQLite "read-only" — nhưng deny-list hiện tại bỏ sót một loạt verb ghi thật của SQLite: **`REPLACE INTO`** (ghi đầy đủ!), **`VACUUM`** (rewrite toàn bộ file DB), **`ANALYZE`**, **`BEGIN/COMMIT/ROLLBACK/SAVEPOINT/RELEASE`**, **`REINDEX`**. `ENABLE_DB_QUERY=true` đang bật (**`.env:453`** — đã kiểm chứng) nên bất kỳ agent nào cũng có thể chạy ngay:
```sql
REPLACE INTO Todo (id, ...) VALUES (...)   -- GHI VÀO DB — đi qua guard hiện tại
VACUUM;                                     -- rewrite file DB — đi qua guard
```
Vì đây là công cụ an ninh (comment trong file tự ghi *"SECURITY-CRITICAL: never relax this guard without a separate audit"*), việc đảo ngược tư duy từ deny-list sang **allow-list + deny-list mở rộng** là bắt buộc.

### Root cause (đã kiểm chứng)
`src/lib/code-team/dev-tools.ts:5110-5218`:
- L5146-5149 `writeKeywords` thiếu: `REPLACE, VACUUM, ANALYZE, REINDEX, BEGIN, COMMIT, ROLLBACK, SAVEPOINT, RELEASE, MERGE`.
- Không có bước nào ép câu lệnh **bắt đầu** bằng token đọc (SELECT/WITH/EXPLAIN) — deny-list là lớp duy nhất.

### Thiết kế fix (allow-list + deny-list, 2 lớp phòng thủ)
```ts
// ---------- LỚP 1: ALLOW-LIST first-token ----------
// SQLite chỉ đọc qua 3 cửa: SELECT / WITH (CTE của SQLite luôn read-only —
// SQLite KHÔNG hỗ trợ data-modifying CTE như Postgres) / EXPLAIN (đi kèm
// deny-list dưới để chặn EXPLAIN INSERT...).
if (!/^\s*(SELECT|WITH|EXPLAIN)\b/i.test(stripped)) {
  return {
    success: false,
    error: 'SQL rejected by read-only guard: chỉ cho phép SELECT / WITH (CTE) / EXPLAIN',
    sql: rawSql.slice(0, 500),
  }
}

// ---------- LỚP 2: DENY-LIST mở rộng (word-boundary, như cũ) ----------
const writeKeywords = [
  'INSERT', 'UPDATE', 'DELETE', 'DROP', 'ALTER', 'TRUNCATE',
  'CREATE', 'GRANT', 'REVOKE', 'ATTACH', 'DETACH',
  // P1-a: các verb ghi của SQLite từng bị bỏ sót
  'REPLACE', 'VACUUM', 'ANALYZE', 'REINDEX',
  'BEGIN', 'COMMIT', 'ROLLBACK', 'SAVEPOINT', 'RELEASE',
  'MERGE', 'RETURNING',
]
```
(Giữ nguyên các check multi-statement L5136, PRAGMA L5164, wrap LIMIT L5181 — chúng vẫn đúng. `RETURNING` chặn nhánh `INSERT ... RETURNING` giả lập đọc.)

### Các bước thực hiện
1. Thêm allow-list check ngay sau strip comment (L5131-5133).
2. Mở rộng `writeKeywords`.
3. Mở rộng `tests/db-query-readonly-guard.test.ts` với các case: `REPLACE INTO`, `VACUUM`, `ANALYZE`, `BEGIN`, `REINDEX`, `WITH x AS (SELECT 1) SELECT * FROM x` (phải PASS), `EXPLAIN SELECT 1` (PASS), `PRAGMA query_plan` (PASS), `EXPLAIN INSERT INTO ...` (FAIL vì keyword), comment prefix `/* select */ DELETE ...` (FAIL).

### Kiểm chứng
- `bun test tests/db-query-readonly-guard.test.ts` — mọi case mới đúng kỳ vọng.
- E2E `POST /api/tools/execute` với `db_query` + `sql: "SELECT count(*) FROM Document"` → thành công; `sql: "REPLACE INTO Todo ..."` → bị chặn với thông báo allow-list.

### Rủi ro & rollback
- Nguy cơ sai hướng: false-positive chặn query đọc hợp lệ — allow-list 3 token phủ toàn bộ đường đọc của SQLite (SELECT/WITH/EXPLAIN); không đường đọc nào khác. Trường hợp `VALUES 1;` hiếm và không cần.
- Rollback: revert 1 commit; test file cũ vẫn phủ các case gốc.

---

## P1-b · Fulltext `entity_name_search` thiếu `Technology`/`Framework` — hỏng fuzzy resolution cho ~8.800 node cloud

### Triệu chứng & hệ quả
Sau redesign label (gộp `Tool+System → Technology`, tách `Framework`), 2 label mới trở thành 2 label **lớn nhất** trên cloud (~6.450 Technology + ~2.367 Framework nodes — kiểm đếm round-31) nhưng **không nằm trong fulltext index**. Mọi truy vấn fuzzy entity (`resolveEntityByFuzzyName` — dùng `CALL db.index.fulltext.queryNodes('entity_name_search', ...)` tại `neo4j.ts:1081`) không bao giờ match các node này → entity resolution/recall hỏng cho chính lớp node phổ biến nhất. Ngược lại, index vẫn liệt kê 5 label **đã bỏ** (Algorithm, Language, Tool, System, Technique).

### Root cause (đã kiểm chứng)
`src/lib/neo4j.ts:723`:
```cypher
CREATE FULLTEXT INDEX entity_name_search IF NOT EXISTS
FOR (n:Concept|Algorithm|Language|Tool|System|Technique|Vulnerability|Principle|Domain|Document|Person)
ON EACH [n.name]
```
so với chuẩn hiện hành `ENTITY_LABELS` (`neo4j.ts:33-36`):
```ts
export const ENTITY_LABELS = ['Concept', 'Technology', 'Framework', 'Vulnerability', 'Principle', 'Domain', 'Document', 'Person'] as const
```
Hai danh sách đã **lệch nhau vĩnh viễn** vì `IF NOT EXISTS` không bao giờ cập nhật định nghĩa index sẵn có trên Aura — boot hàng ngày "thành công" trong khi index vẫn là bản cũ.

### Thiết kế fix
**1) Dẫn xuất từ một nguồn duy nhất + giữ legacy để node cũ vẫn search được:**
```ts
// neo4j.ts — cạnh ENTITY_LABELS
/** Label legacy từ trước redesign 2026-08 — node cũ trên cloud vẫn mang các label này */
export const LEGACY_ENTITY_LABELS = ['Algorithm', 'Language', 'Tool', 'System', 'Technique'] as const
/** Fulltext index phủ cả label mới lẫn legacy (union — không để mất SearchAbility node cũ) */
export const FULLTEXT_INDEX_LABELS = [...ENTITY_LABELS, ...LEGACY_ENTITY_LABELS] as const
```
**2) Migration DROP + CREATE idempotent (bắt buộc — `IF NOT EXISTS` không đổi được index cũ):**
```ts
async function migrateFulltextIndex(session): Promise<void> {
  const LABELS = FULLTEXT_INDEX_LABELS.join('|')
  // Đọc định nghĩa hiện tại: SHOW INDEXES YIELD name, labelsOrTypes
  const info = await session.run(
    `SHOW INDEXES YIELD name, labelsOrTypes, type WHERE name = 'entity_name_search' RETURN labelsOrTypes, type`
  )
  const current = info.records[0]?.get('labelsOrTypes') as string[] | undefined
  const wanted = [...FULLTEXT_INDEX_LABELS].sort()
  if (current && JSON.stringify([...current].sort()) === JSON.stringify(wanted)) return // đã đúng
  if (current) {
    await session.run(`DROP INDEX entity_name_search`)   // chỉ index — không đụng data
    console.log('[Neo4j] Migrate fulltext: DROP index cũ (labels lệch chuẩn)')
  }
  await session.run(
    `CREATE FULLTEXT INDEX entity_name_search IF NOT EXISTS FOR (n:${LABELS}) ON EACH [n.name]`
  )
  console.log(`[Neo4j] Fulltext entity_name_search tạo mới với ${FULLTEXT_INDEX_LABELS.length} label (mới+legacy)`)
}
```
Gọi 1 lần trong ensureSchema (sau các CREATE INDEX thường) — tự phát hiện lệch và tự chữa mỗi boot (idempotent).

### Các bước thực hiện
1. Thêm 2 const + hàm migrate vào `neo4j.ts`; gọi trong ensureSchema.
2. Thay chuỗi hardcode ở L723 bằng `FULLTEXT_INDEX_LABELS.join('|')` (dòng hiện tại chỉ còn tác dụng khi index chưa tồn tại — giữ làm lớp thứ hai).
3. (Ghi chú vận hành) Migration chạy lúc boot — nếu có query fuzzy đang bay trong giây DROP→CREATE thì catch + retry 1 lần (cùng pattern fail-open của file).

### Kiểm chứng
- Sau boot: `CALL db.indexes() YIELD name, labelsOrTypes WHERE name='entity_name_search'` → đủ 13 label (8 mới + 5 legacy).
- Query sống: `CALL db.index.fulltext.queryNodes('entity_name_search', 'burp') YIELD node, score RETURN labels(node), node.name LIMIT 5` → phải thấy node `:Technology` (trước fix: không bao giờ).
- Đếm trước/sau: số node Technology/Framework match được qua index ≈ count label trên graph (6.450 + 2.367).
- Reboot lần 2: log KHÔNG còn "DROP index cũ" (idempotent chứng minh).

### Rủi ro & rollback
- `DROP INDEX` trên Aura an toàn với data (chỉ đánh index, rebuild nhanh cho ~96k nodes — giây đến chục giây). Cửa sổ DROP→CREATE ngắn; query fuzzy trong cửa sổ fail-open sẵn (catch + cảnh báo).
- Rollback: revert code → index giữ nguyên định nghĩa mới (vô hại cho code cũ — cũ chỉ bỏ sót kết quả, không break).

---

## P1-c · Lesson credit assignment — phạt/thưởng dàn trải cả episode

### Triệu chứng & hệ quả
Hệ lesson học từ kinh nghiệm (episodic memory nhịp 3 EVALUATE) hiện áp đặt kết cục **cả episode** lên **mọi lesson đã áp dụng**:
- FAILURE → mọi lesson applied bị `times_failed++` + confidence **−0.1**;
- SUCCESS → mọi lesson applied được `times_validated++` + confidence **+0.05**.

Nhưng "applied" thực chất chỉ nghĩa là **"được inject vào prompt"** (`preact.ts:157-159`: mọi lesson confidence ≥ 0.7 được *retrieve*). Một lesson về database bị trừ điểm vì run fail do lỗi parse LLM; một lesson sai được cộng điểm vì chạy trong episode thành công. Cơ chế `auto-apply` (ngưỡng 0.7) và `needsReview` (ngưỡng 0.4) — cả vòng đời lesson — vì vậy **lệch dần theo thời gian** theo độ nhiễu thay vì theo chất lượng thật. Đây cũng chính là khối thiếu "credit assignment" mà bản đánh giá RL (round-31) chỉ ra.

### Root cause (đã kiểm chứng)
- `episodic-memory/lessons.ts:211-251` — `validateAppliedLessons(appliedLessonIds, outcomeSuccess)`: duyệt từng id, cùng một phép +/- confidence cho tất cả.
- `episodic-memory/recorder.ts:268` — truyền nguyên `input.appliedLessonIds` (danh sách phẳng, không ngữ cảnh).
- `episodic-memory/preact.ts:157-159` — nguồn danh sách: mọi lesson được retrieve có confidence ≥ 0.7.
- `agent-goal-loop.ts:1782-1792` — goal-loop nhận từ preAct, không thêm tín hiệu nào.

### Thiết kế fix — Lớp 1: attribution theo ngữ cảnh lỗi (deterministic, không đổi kiến trúc)
Mở rộng hợp đồng `validateAppliedLessons` nhận thêm ngữ cảnh attribution (recorder đã có sẵn mọi dữ liệu này trong input của episode: ErrorOccurrence có rootCause + toolName, ToolMetric có tool thất bại):
```ts
export interface LessonAttribution {
  /** Tool names thất bại trong run (từ ToolMetric/error occurrences) */
  failedTools?: string[]
  /** Root cause code các lỗi (taxonomy B.3) */
  errorRootCauses?: string[]
  /** Từ khóa ngữ cảnh lỗi (message cắt ngắn) */
  errorKeywords?: string[]
}

export async function validateAppliedLessons(
  appliedLessonIds: string[],
  outcomeSuccess: boolean,
  attribution?: LessonAttribution
): Promise<ValidateLessonsResult> {
  // ...
  for (const id of appliedLessonIds.slice(0, 10)) {
    const rec = await findLessonRecordById(id)
    if (!rec) continue

    // P1-c: FAILURE → chỉ penalize lesson LIÊN QUAN ngữ cảnh lỗi.
    const related = outcomeSuccess ? true : isLessonRelatedToFailure(rec, attribution)
    //   - SUCCESS: lesson có mặt trong run thành công → bằng chứng yếu nhưng
    //     công bằng → validate như cũ.
    //   - FAILURE: lesson không khớp ngữ cảnh lỗi → chỉ đếm lần áp dụng
    //     (timesApplied++), KHÔNG đổi confidence/timesFailed.

    const confidence = !outcomeSuccess && !related
      ? rec.confidence  // không đổi — không quy tội oan
      : outcomeSuccess
        ? Math.min(0.99, rec.confidence + EPISODIC_THRESHOLDS.lessonValidateBoost)
        : Math.max(0, rec.confidence - EPISODIC_THRESHOLDS.lessonValidatePenalty)
    // ... timesValidated/timesFailed cũng theo `related`
  }
}

/** Khớp ngữ cảnh: token của triggerCondition/appliesTo đè lên dấu vết lỗi */
function isLessonRelatedToFailure(rec: LessonRecord, att?: LessonAttribution): boolean {
  if (!att) return true // không có dữ liệu attribution → giữ hành vi cũ (an toàn)
  const trace = new Set([
    ...(att.failedTools ?? []),
    ...(att.errorRootCauses ?? []),
    ...(att.errorKeywords ?? []),
  ].map(s => s.toLowerCase()))
  if (trace.size === 0) return true
  const lessonText = [rec.triggerCondition ?? '', ...(safeParseApplies(rec.appliesTo))]
    .join(' ').toLowerCase()
  const tokens = lessonText.split(/[^\p{L}\p{N}_]+/u).filter(t => t.length > 2)
  return tokens.some(t => [...trace].some(s => s.includes(t) || t.includes(s)))
}
```
Caller `recorder.ts:268` xây attribution từ dữ liệu sẵn có trong `RecordEpisodeInput` (errorOccurrence nodes: rootCause, toolName nếu có; thất bại tool từ tracker). `timesApplied` vẫn tăng cho mọi lesson applied (đếm lần dùng là thật).

**Lớp 2 — exercised tracking (đề xuất P3, KHÔNG làm ở P1):** đánh dấu per-lesson "thực sự được dùng" trong goal-loop khi action của chu kỳ khớp triggerCondition; truyền `Map<lessonId, exercised>` xuống recorder. Cần thêm wiring vòng goal-loop — để dành sau khi Lớp 1 chạy ổn.

### Các bước thực hiện
1. Thêm types + `isLessonRelatedToFailure` vào `lessons.ts`; đổi signature `validateAppliedLessons` (tham số thứ 3 optional → mọi caller cũ không vỡ).
2. `recorder.ts` xây attribution từ input episode (grep các field có sẵn trong `RecordEpisodeInput`/`ErrorOccurrenceNode` khi thực hiện — dùng đúng field thật, không bịa).
3. Log thêm 1 dòng: `[Episodic] Lesson attribution: ${related}/${applied} related — ${unrelated} không bị quy tội`.

### Kiểm chứng
- Unit test mới: lesson "khi sửa schema database" + run FAILURE với errorRootCauses `['LLM_PARSE_ERROR']` → confidence KHÔNG đổi; cùng lesson + failure chứa tool `db_query`/rootCause liên quan DB → bị −0.1.
- SUCCESS: cả 2 lesson đều +0.05 (giữ nguyên hành vi).
- E2E: 1 mission thật qua goal-loop → log attribution xuất hiện; lesson stats (UI/`getAutoLearnStats`) thay đổi hợp lý.

### Rủi ro & rollback
- Rủi_ro thuật toán: matching quá lỏng (mọi lesson đều "related") → giảm dần về hành vi cũ (không tệ hơn hiện tại); quá chặt → lesson ít được Validate lại → confidence đi ngang (chấp nhận: trung tính tốt hơn quy oan).
- `attribution` undefined → fallback hành vi cũ tuyệt đối (đã ghi trong code).
- Rollback: revert 1 commit.

---

# PHẦN P2 — 3 NỢ KỸ THUẬT (đợt 3)

---

## P2-a · ToolMetric phình vô hạn — archival + rollup theo pattern sweep sẵn có

### Hiện trạng & hệ quả
`ToolMetric` ghi **1 row cho mỗi tool execution** (choke-point `recordAgentActivity()` — mọi tool call của mọi agent chảy qua, fire-and-forget). Không TTL, không archival. Mission dài 45+ tool calls; hàng trăm mission/tuần → bảng phình không ngừng. Chính ALISTA đã tự viết rule (`alista/rules.ts:585`): *"SQLite DB size > 500MB → archive AgentRunRecord/ToolMetric >30 ngày sang table archive, VACUUM"* — hệ thống **nhận ra nợ nhưng chưa ai triển khai**. Phân tích round-31 cũng ghi nhận đây là 1 trong 2 điểm full-table transient.

### Thiết kế fix (đúng pattern sweep đã chứng minh trong `instrumentation-node.ts`)
**1) Schema — bảng rollup vĩnh viễn (nhỏ, giữ mãi):**
```prisma
/// P2-a: rollup hằng ngày của ToolMetric — raw giữ N ngày (env), rollup giữ vĩnh viễn.
model ToolMetricDaily {
  date          String   // "2026-10-05" (UTC) — id tự nhiên
  toolName      String
  agentRole     String
  calls         Int
  successCount  Int
  totalDurationMs BigInt
  topErrorTags  String   // JSON {"timeout":12,"parse_error":3} — top 10
  computedAt    DateTime @default(now())

  @@id([date, toolName, agentRole])
  @@index([toolName, date])
}
```
**2) Sweep trong `instrumentation-node.ts` (kề `sweepAgentRunTrails` L531-560, cùng khung guard globalThis + interval):**
```ts
// P2-a — TOOL METRIC RETENTION: rollup ngày đã qua → xóa raw quá hạn.
// Env TOOL_METRIC_RETENTION_DAYS (default 30, 0 = off). Chỉ rollup ngày
// HOÀN CHỈNH (date < hôm nay) để không đua với ghi mới. Fail-open tuyệt đối.
async function sweepToolMetrics(): Promise<void> {
  const retentionDays = Number(process.env.TOOL_METRIC_RETENTION_DAYS ?? 30)
  if (!Number.isFinite(retentionDays) || retentionDays <= 0) return
  try {
    const yesterday = new Date(Date.now() - 24 * 3600 * 1000).toISOString().slice(0, 10)
    // (a) Rollup mọi ngày < hôm nay CHƯA có row (LEFT JOIN style qua raw SQL
    //     hoặc 2 query Prisma: distinct dates thiếu → groupBy từng ngày).
    //     groupBy: date(strftime), toolName, agentRole
    //     → _count, _avg durationMs, sum success → upsert ToolMetricDaily
    // (b) deleteMany({ timestamp: { lt: cutoff } }) — sau khi rollup thành công
    // (c) log: "[ToolMetrics] retention: rollup N ngày, xóa M raw rows > X ngày"
  } catch (err) { /* fail-open — không chặn boot/interval */ }
}
const globalForTmr = globalThis as unknown as { __tmoToolMetricSweepStarted?: boolean }
if (!globalForTmr.__tmoToolMetricSweepStarted) {
  globalForTmr.__tmoToolMetricSweepStarted = true
  void ensureDbReady().then(() => sweepToolMetrics()).catch(() => {})
  const tmrTimer = setInterval(() => void sweepToolMetrics(), 6 * 60 * 60 * 1000)
  tmrTimer.unref?.()
}
```
**3) Analytics đọc 2 tầng:** `api/tools/analytics` + `api/metrics/overview` — range ≤ 7 ngày gần: đọc raw (như cũ); range xa: đọc `ToolMetricDaily`. (Sửa 2 route theo cùng công thức query — giữ response shape.)

### Các bước thực hiện
1. Schema + `bun run db:push` (88 → 89 bảng).
2. Sweep function + interval trong `instrumentation-node.ts`.
3. Cập nhật 2 analytics route đọc rollup cho range xa (grep `toolMetric.findMany/groupBy` trong 2 file).
4. `.env.example` + `.env`: `TOOL_METRIC_RETENTION_DAYS=30`.

### Kiểm chứng
- Chèn (scratch) 40 row ToolMetric mốc 40 ngày trước + 10 row hôm qua → chạy sweep 1 lần → rollup có ngày cũ, raw chỉ còn 10 + hôm nay; tổng calls khớp.
- Boot lại: sweep idempotent (không nhân rollup — `@@id` khóa).
- `bun test` + analytics endpoint vẫn trả shape cũ.

### Rủi ro & rollback
- Bảng trắng sau reset → sweep lần đầu gần như no-op — an toàn tuyệt đối cho thời điểm này.
- Rollup sai số (race ghi mới trong ngày đang rollup) — đã tránh bằng "chỉ ngày đã qua".
- Rollback: giữ nguyên bảng rollup (vô hại), tắt env = 0 là tắt sweep.

---

## P2-b · `updateChunkDomains` — scroll 1 trang 1000 + read-modify-write → đổi sang `setPayload` theo filter

### Hiện trạng & hệ quả
`src/app/api/query/route.ts:1662-1688`: đọc toàn bộ point **kèm vector** (`with_vector: true` — 2048 float × 1000 điểm về RAM), sửa payload rồi re-upsert:
- scroll `limit: 1000` **một trang** (không dùng follower cursor) → doc >1000 chunk chỉ được update domain **một phần im lặng**;
- read-modify-write mở cửa sổ race (chunk đổi giữa lúc đọc và ghi);
- tốn băng thông/RAM không cần thiết — trong khi việc cần làm chỉ là đổi 1 field payload của mọi point theo filter.

### Thiết kế fix
Qdrant có đúng API cho việc này — `setPayload` theo filter (atomic, server-side, không pagination, không vector). Tiền lệ nội bộ: `updateDocumentStatus` (`qdrant.ts:512-518`) đã dùng setPayload (theo points). Thêm helper:
```ts
/**
 * P2-b: cập nhật 1 field payload cho TOÀN BỘ chunk của document theo filter —
 * atomic server-side, không đọc vector về, không giới hạn 1000 điểm/trang.
 */
export async function setChunkPayloadByDocument(
  documentId: string,
  payload: Record<string, unknown>
): Promise<boolean> {
  try {
    await withQdrantRetry(() => qdrant.setPayload(COLLECTION_CHUNKS, {
      payload,
      filter: { must: [{ key: 'document_id', match: { value: documentId } }] },
      wait: true,
    }))
    return true
  } catch (err) {
    console.error('[Qdrant] setChunkPayloadByDocument error:', err instanceof Error ? err.message : String(err))
    return false
  }
}
```
`updateChunkDomains` gọn còn 3 dòng gọi helper với `{ domain: newDomain }`. Hai call site (L1561, L1611) không đổi.

### Kiểm chứng
- Doc test >1000 chunk: sau classify, scroll toàn trang (dùng getChunksByDocument đã paginate) → 100% point có domain mới (trước fix: chỉ 1000 đầu).
- Không có vector round-trip: quan sát network log / thời gian giảm rõ.
- Payload khác (heading_path…) nguyên vẹn (setPayload chỉ merge field đưa vào — semantics đúng như comment `qdrant.ts:509-510` đã ghi).

### Rủi ro & rollback
- setPayload theo filter cần Qdrant ≥ 1.1 (đang 1.13.2 — OK).
- Rollback: revert 1 commit; hàm cũ vẫn còn trong git history nếu cần.

---

## P2-c · Dim guard — bảo vệ collection khỏi đổi kích thước embedding

### Hiện trạng & hệ quả
- `qdrant.ts:29`: `EMBEDDING_DIMENSION = getEmbeddingDimension()` — **động** theo provider (`embeddings.ts:34` hardcode 2048 cho NVIDIA hiện hành).
- `initializeCollections` (L160-187) chỉ kiểm tra **tên** collection tồn tại — không kiểm tra `vectors.size` của collection sẵn có.
- `neo4j.ts:738-744`: vector index per-label hardcode `` `vector.dimensions`: 2048 ``.

Kịch bản chết im lặng: đổi `NVIDIA_EMBED_MODEL` sang model khác dim (1024/1536/3072) → collection cũ vẫn "tồn tại" với size 2048 → **mọi upsert 400** (đúng lớp triệu chứng P0-3 nhưng nguyên nhân khác) → `upsertChunks=false` nuốt lỗi → ingestion "thành công" mà không có vector nào được ghi. Không một dòng log FATAL nào.

### Thiết kế fix (guard + cảnh báo + remediation có kiểm soát)
**1) Qdrant guard trong `initializeCollections`:**
```ts
// P2-c: collection tồn tại nhưng sai dim = lỗi cấu hình im lặng — PHẢI lộ ra.
if (existingNames.has(COLLECTION_CHUNKS)) {
  const info = await qdrant.getCollection(COLLECTION_CHUNKS)
  const actualDim = (info.config?.params?.vectors as { size?: number })?.size
  if (actualDim !== EMBEDDING_DIMENSION) {
    const msg = `[Qdrant] DIM MISMATCH: collection '${COLLECTION_CHUNKS}' đang ${actualDim}-dim nhưng embedding provider hiện tại sinh ${EMBEDDING_DIMENSION}-dim. ` +
      `Mọi upsert sẽ bị 400. Remediation: (1) đặt lại model cũ, hoặc (2) TMO_QDRANT_ALLOW_DIM_RECREATE=1 rồi restart để drop+recreate collection (vector local sẽ re-embed qua nút Xử lý — Neo4j/R2 không bị ảnh hưởng).`
    console.error(msg)
    if (process.env.TMO_QDRANT_ALLOW_DIM_RECREATE === '1') {
      await qdrant.deleteCollection(COLLECTION_CHUNKS)
      // rơi xuống nhánh create bên dưới với dim mới
    } else {
      return { documents: result.documents, chunks: false, error: `dim-mismatch: ${actualDim} != ${EMBEDDING_DIMENSION}` }
    }
  }
}
```
Trả `chunks: false, error: ...` làm `/api/health` **đỏ ngay phần qdrant** (health đã đọc kết quả này) — đúng chỗ tận cùng vận hành nhìn thấy.
**2) Neo4j:** thay hardcode 2048 bằng import `getEmbeddingDimension()` từ embeddings (1 nguồn sự thật). Lưu ý runbook: index cũ 2048 trên cloud không tự đổi — nếu đổi model dim, phải DROP các `entity_embedding_*` + recreate (ghi vào remediation message tương tự).
**3) Health surfacing:** thêm 1 dòng vào qdrant health section: `dimExpected: EMBEDDING_DIMENSION, dimActual` (từ getCollection) — nhìn là biết ngay.

### Các bước thực hiện
1. Guard trong `initializeCollections` + env `TMO_QDRANT_ALLOW_DIM_RECREATE` (thêm vào `.env.example`, default không set).
2. `neo4j.ts:742` dùng dim từ nguồn chung (import — chú ý không tạo circular import: embeddings.ts không import neo4j).
3. Health line; docs: PLAYBOOK mục remediation đổi model embedding.

### Kiểm chứng
- Bình thường: boot sạch, không log guard, health xanh.
- Choreo: tạo collection test sai dim (scratch) → boot → health đỏ + log FATAL đúng nội dung; set env recreate → collection được recreate đúng dim mới.
- `bun test` xanh.

### Rủi ro & rollback
- Nhánh recreate **chỉ chạy khi env chủ ý set** — không thể tự drop dữ liệu ngoài ý muốn (chốt an toàn tuyệt đối).
- Rollback: revert 1 commit.

---

# PHẦN P3 — NỢ DÀI HẠN (đợt 4, chọn theo tuần tự)

---

## P3-a · `mapOutcome` dead ternary — dọn dead-code, KHÔNG đổi semantics

### Hiện trạng
`episodic-memory/recorder.ts:60`:
```ts
case 'error': return toolFailures > 0 ? 'FAILURE' : 'FAILURE'
```
Sinh ra từ commit gốc `4b46d20` (A6 episodic memory) — đã kiểm chứng bằng `git log -L`: đây là typo copy từ dòng `max_cycles` bên dưới (`toolFailures > 0 ? 'FAILURE' : 'PARTIAL'`), tồn tại nguyên đời mà không ai để ý.

### Quyết định thiết kế (có chứng cứ)
Hai lựa chọn: (i) bỏ ternary → `return 'FAILURE'` — giữ nguyên 100% hành vi đã vận hành từ đầu; (ii) đoán ý đồ cũ → `'PARTIAL'` khi 0 tool failures — **đổi hành vi** toàn bộ episodes 'error' không có tool failure.
**Chọn (i)**: semantics hiện tại ("run kết thúc bằng error = FAILURE") là hợp lý về mặt sản phẩm, toàn bộ lesson confidence đã "hiệu chuẩn" quanh nó suốt thời gian dài; không có chứng cứ nào nói ý đồ là PARTIAL. Fix thuần dọn dead-code + comment giải thích:
```ts
// 'error': run kết thúc bằng exception — FAILURE bất kể tool failures
// (ternary cũ toolFailures>0?'FAILURE':'FAILURE' là dead-code typo từ 4b46d20)
case 'error': return 'FAILURE'
```
Effort: 15 phút + verify chuẩn. Rollback: revert 1 commit.

## P3-b · Migrations workflow — hết "chỉ db push"

### Hiện trạng & rủi ro
`package.json` chỉ có `db:push` (`prisma db push`). 88 bảng, không có `prisma/migrations/` → không ai biết được **schema phiên bản nào đã chạy trên DB backup nào**. Sau khi P0-1/P0-2/P3-c làm backup/restore hoạt động trở lại, kịch bản "restore backup 3 tuần cũ lên code mới" sẽ tạo drift schema **im lặng** (Prisma client mới truy cột không tồn tại → lỗi runtime rải rác).

### Thiết kế
1. `prisma migrate dev --name baseline_v2_0_0` tạo baseline từ schema hiện hành trên DB trắng (an toàn vì DB local đang trắng sau reset — thời điểm lý tưởng).
2. Đổi script: `db:push` giữ cho môi trường scratch nhanh, thêm `db:migrate` = `prisma migrate deploy` (dùng khi khôi phục/production-like).
3. Quy ước round mới: mọi thay đổi schema (P2-a là cái đầu tiên) đi kèm migration file commit cùng PR — review được diff schema bằng diff migration.
4. Cập nhật PLAYBOOK + runbook khôi phục (round-30 runbook thêm bước `db:migrate` sau restore).

Effort: 3-4h (bao gồm thử restore-drift scenario). Rủi ro: quy trình mới bị quên — khắc phục bằng quy ước commit migration bắt buộc + lint guard nhẹ (script check: schema.prisma đổi mà migrations/ không có file mới → warn).

## P3-c · Backup verify + restore drill + cron

### Thiết kế
Sau khi P0-1/P0-2 làm backup ĐÚNG và ĐỦ MỚI:
1. **Verify nội tuyến**: sau mỗi backup, download lại object vừa upload (HEAD + so `sha256`), mở thử `PRAGMA integrity_check` (qua `sqlite3` CLI hoặc client tạm ở /tmp) → lưu kết quả vào response + log. Backup không qua verify = raise cảnh báo trong response (không fail toàn bộ).
2. **Cron hằng ngày**: mini-service `cron-scheduler` (port 3004) đã tồn tại — đăng ký job `POST /api/storage/db-backup` 03:00 lịch vực (timezone user Etc/GMT-7), kèm alert qua ALISTA nếu 2 ngày liên tiếp không có backup thành công.
3. **Restore drill**: script `scripts/restore-drill.sh` — restore bản latest xuống DB test (KHÔNG đè DB chạy), đếm bảng + integrity_check + so nhanh số row các bảng chính với DB chạy → log PASS/FAIL. Chạy thủ công mỗi lần chuẩn bị release lớn (không cron).
Effort: ~2h. Rủi ro:không đáng kể (đọc/thử trên bản sao).

## P3-d · RL-readiness roadmap (từ đánh giá round-31 — KHÔNG làm ngay, quyết từng phase)

**Đánh giá nền (round-31):** hạ tầng reward ~70% (12+ loại tín hiệu: ToolMetric success rate, lesson confidence ±, episodic outcome, ALISTA health, calibration logistic regression — mô hình ML thật duy nhất), thiếu: (1) unified reward ledger, (2) credit assignment (P1-c giải quyết 1 phần bài toán lesson), (3) policy update loop bền vững, (4) exploration. **Không** xây deep learning training pipeline — đúng hướng cho LLM agent là in-context learning + bandit, không phải fine-tune.

- **Phase A — RewardEvent ledger chuẩn hóa** (bảng `RewardEvent`: runId, episodeId, agentName, toolName, signal type, value −1..+1, attribution JSON, createdAt). Mọi nơi phát reward hiện rải rác ghi về 1 nơi → mới phân tích được. Sau P1-c, attribution có dữ liệu thật.
- **Phase B — Contextual bandit cho tool selection / lesson auto-apply**: thay ngưỡng cứng 0.7 auto-apply bằng hàm hậu nghiệm theo ngữ cảnh (feature: agent, task type, lỗi gần đây) — beta-binomial hoặc logistic (tái dùng khối calibration sẵn có).
- **Phase C — Offline eval harness**: replay episodes từ Neo4j + SQLite, đo counterfactual (nếu không áp lesson X thì outcome?) — cần ledger Phase A làm tiền đề.

Mỗi phase là 1 round riêng có E2E riêng; không chồng vào các đợt P0-P2.

---

# PHẦN KẾT — TRÌNH TỰ THỰC THI

## Dependency giữa các mục
```
P0-1 ──┐
P0-2 ──┴─ (cùng file db-backup — 1 commit chung được, hoặc 2 commit kề nhau)
P0-3 ──┐
P0-4 ──┼─ (cùng tầng vector Qdrant — verify chung 1 E2E ingestion trọn vẹn)
P0-5 ──┘
P1-a — độc lập (guard + test)
P1-b — độc lập (chạy migration trên cloud lúc boot)
P1-c — độc lập (sau này cấp dữ liệu cho P3-d Phase A)
P2-a — cần db push (schema mới) — chạy sau khi P0 xong để 1 lần push
P2-b — độc lập
P2-c — độc lập (nên làm sau P0-4 để chuẩn помощ nhận lỗi dim khi test)
P3-a — độc lập, 15 phút (xen vào bất kỳ đợt nào)
P3-b — nên làm TRƯỚC P2-a nếu chọn hướng migration (P2-a là migration đầu tiên)
P3-c — bắt buộc SAU P0-1/P0-2 (verify cái mình vừa sửa)
P3-d — roadmap, không lên lịch đợt này
```

## 4 đợt đề xuất (mỗi đợt khép kín: code → tsc/lint/test → E2E → agent-browser → commit+push)

| Đợt | Nội dung | Ngưỡng nghiệm thu |
|-----|----------|-------------------|
| **Đợt 1 — P0** | P0-1 → P0-5 (backup pair + vector trio) + P3-a (15 phút, tiện tay) | Backup E2E: backup→verify integrity→restore-drill PASS; ingestion E2E 1 tài liệu: payload đầy đủ + 0 zero-vector + status đúng; tsc/lint/253 test xanh |
| **Đợt 2 — P1** | P1-a + P1-b + P1-c | Guard test mới xanh + `REPLACE INTO` bị chặn E2E; `db.indexes()` đủ 13 label + query trả node Technology; lesson attribution unit test + log sống |
| **Đợt 3 — P2** | (P3-b nếu chọn migration) → P2-a + P2-b + P2-c | Sweep rollup đúng số; doc >1000 chunk domain đồng nhất; dim-mismatch choreo đỏ health đúng chỗ |
| **Đợt 4 — P3** | P3-c + P3-b (nếu chưa làm) + quyết P3-d Phase A | Restore drill PASS + cron backup chạy đêm + docs cập nhật |

## Định nghĩa "Hoàn thành" cho toàn bộ chương trình
1. 11/11 mục P0-P2 + P3-a/P3-b/P3-c merge, push GitHub, worklog cập nhật từng round.
2. `/api/health` xanh liên tục 24h sau đợt cuối; UI agent-browser 0 console error.
3. Một E2E "vàng" chứng minh chuỗi học còn nguyên vẹn: upload → process → resume giữa chừng → indexed (0 zero-vector) → query truy hồi chunk auto-learn (P0-3) → fuzzy entity trả node Technology (P1-b) → lesson attribution log đúng (P1-c).

---

*Tài liệu này là bản thiết kế thực thi — mọi con số dòng, đoạn code trích dẫn và hành vi "đã kiểm chứng" đều được đối chiếu trực tiếp với HEAD `5799d4d` trong round-32. Khi bắt đầu từng mục, agent thực thi đọc lại mục tương ứng + kiểm tra grep các call site được liệt kê trước khi sửa.*
