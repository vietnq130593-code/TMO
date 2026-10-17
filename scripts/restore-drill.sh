#!/usr/bin/env bash
# ============================================================================
# restore-drill.sh — TMO SQLite Restore Drill
# (BLUEPRINT-DB-P0-P3 §P3-c, task 31-f — "Restore drill: script
#  scripts/restore-drill.sh — restore bản latest xuống DB test (KHÔNG đè DB
#  chạy), đếm bảng + integrity_check + so nhanh số row các bảng chính với DB
#  chạy → log PASS/FAIL. Chạy thủ công mỗi lần chuẩn bị release lớn")
# ============================================================================
#
# MỤC ĐÍCH
#   Chứng minh bản backup SQLite trên Cloudflare R2 THẬT SỰ khôi phục được:
#     (1) tìm + tải artifact backup MỚI NHẤT về BẢN SAO TẠM trong $TMPDIR
#     (2) PRAGMA integrity_check trên bản sao tạm
#     (3) so row-count 5 bảng chính giữa bản backup và DB ĐANG CHẠY
#         (AgentRunRecord, EvalResult, KbConsultLog, BrainModel, QEntry —
#         prisma/schema.prisma, không @@map nên tên bảng = tên model)
#     (4) in báo cáo PASS/FAIL rõ ràng kèm số liệu
#
# BẢO ĐẢM AN TOÀN (tuyệt đối — không bao giờ phá DB chạy thật)
#   - KHÔNG gọi ?action=restore, KHÔNG ghi đè db/custom.db.
#   - Backup chỉ được tải về file TẠM (mktemp trong $TMPDIR).
#   - Mọi query trên DB sống mở READ-ONLY ({readonly:true} của bun:sqlite).
#   - File tạm + script tạm luôn được dọn bằng trap EXIT (kể cả khi lỗi).
#   - Script tự từ chối nếu path bản sao tạm trùng path DB sống.
#
# CÁCH CHẠY (bun tự nạp .env của project cho credentials R2):
#   cd /home/z/tmo-app && bash scripts/restore-drill.sh
#   (hoặc ./scripts/restore-drill.sh — đã chmod +x)
#   Exit code: 0 = PASS, 1 = FAIL.
#
# CƠ CHẾ (không phát minh gì mới)
#   - Artifact backup nằm trên R2 bucket theo prefix backups/sqlite/ — đúng
#     R2_PREFIX của src/app/api/storage/db-backup/route.ts (custom-<ISO>.db
#     history + custom.db latest pointer + pre-restore-<ts>.db).
#   - Download qua @aws-sdk/client-s3 (dependency sẵn của app — cùng cấu hình
#     client như src/lib/r2-storage.ts: region 'auto', R2_ENDPOINT).
#   - Sandbox không có sqlite3 CLI → dùng bun:sqlite (built-in của bun).
#   - Path DB sống resolve từ DATABASE_URL trong .env theo đúng chuẩn hoá của
#     db.ts/db-backup route (file: tương đối tính theo <root>/prisma) — KHÔNG
#     tin DATABASE_URL kế thừa từ shell (bẫy env-leak, tiền lệ d2-baseline).
# ============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
ENV_FILE="$PROJECT_ROOT/.env"

# ---------- 1. Resolve path DB SỐNG từ .env (không tin env shell) ----------
LIVE_DB=""
if [[ -f "$ENV_FILE" ]]; then
  RAW="$(grep -E '^[[:space:]]*(export[[:space:]]+)?DATABASE_URL[[:space:]]*=' "$ENV_FILE" | tail -1 | cut -d= -f2- | sed -e 's/#.*$//' -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'\$//")"
  RAW="${RAW#file:}"
  if [[ -n "$RAW" ]]; then
    if [[ "$RAW" = /* ]]; then
      LIVE_DB="$RAW"
    else
      LIVE_DB="$PROJECT_ROOT/prisma/$RAW"
    fi
  fi
fi
if [[ -z "$LIVE_DB" ]]; then LIVE_DB="$PROJECT_ROOT/db/custom.db"; fi
if [[ ! -f "$LIVE_DB" ]]; then
  echo "FAIL: không tìm thấy DB sống tại: $LIVE_DB (kiểm tra DATABASE_URL trong .env)"
  exit 1
fi

# ---------- 2. File tạm (trap dọn dẹp luôn chạy, kể cả lỗi) ----------
TMP_COPY="$(mktemp "${TMPDIR:-/tmp}/tmo-restore-drill-XXXXXX.db")"
TMP_BUN="$PROJECT_ROOT/.restore-drill-tmp.ts"
cleanup() {
  rm -f "$TMP_COPY" "$TMP_BUN"
}
trap cleanup EXIT
if [[ "$(cd "$(dirname "$TMP_COPY")" && pwd)/$(basename "$TMP_COPY")" == "$LIVE_DB" ]]; then
  echo "FAIL: bản sao tạm trùng path DB sống — từ chối chạy (safety guard)"
  exit 1
fi

# ---------- 3. Chương trình drill (bun:sqlite + @aws-sdk/client-s3) ----------
cat > "$TMP_BUN" <<'BUN_EOF'
// Sinh bởi scripts/restore-drill.sh (task 31-f, P3-c) — file TẠM, bị xoá sau chạy.
import { S3Client, ListObjectsV2Command, GetObjectCommand } from '@aws-sdk/client-s3'
import { Database } from 'bun:sqlite'
import { writeFileSync } from 'node:fs'

const LIVE_DB = process.argv[2]
const TMP_COPY = process.argv[3]
const PREFIX = 'backups/sqlite/' // R2_PREFIX của src/app/api/storage/db-backup/route.ts
const KEY_TABLES = ['AgentRunRecord', 'EvalResult', 'KbConsultLog', 'BrainModel', 'QEntry'] // prisma/schema.prisma

const fmtMb = (n: number) => `${(n / 1024 / 1024).toFixed(2)} MB`
const fail = (msg: string): never => {
  console.log(`\nPHÁN ĐOÁN: FAIL — ${msg}`)
  process.exit(1)
}

// --- R2 client (mirror src/lib/r2-storage.ts getS3Client) ---
const accessKeyId = process.env.R2_ACCESS_KEY_ID || ''
const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY || ''
const endpoint = process.env.R2_ENDPOINT || ''
const bucket = process.env.R2_BUCKET_NAME || 'themagnumopus'
if (!accessKeyId || !secretAccessKey || !endpoint) {
  fail('R2 chưa cấu hình (thiếu R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY / R2_ENDPOINT trong .env).')
}
const s3 = new S3Client({ region: 'auto', endpoint, credentials: { accessKeyId, secretAccessKey }, forcePathStyle: false })

console.log('=== TMO RESTORE DRILL (BLUEPRINT-DB-P0-P3 §P3-c) ===')
console.log(`DB sống (chỉ đọc)  : ${LIVE_DB}`)
console.log(`Bản sao tạm        : ${TMP_COPY} (KHÔNG bao giờ đụng DB sống)`)

// --- (1) Tìm artifact backup mới nhất ---
let newest: { key: string; lastModified: Date; size: number } | null = null
try {
  const listed = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: PREFIX, MaxKeys: 500 }))
  for (const o of listed.Contents || []) {
    if (!o.Key || !o.Key.endsWith('.db')) continue
    const lm = o.LastModified || new Date(0)
    if (!newest || lm > newest.lastModified) newest = { key: o.Key, lastModified: lm, size: o.Size || 0 }
  }
} catch (err) {
  fail(`không list được R2 prefix ${PREFIX}: ${err instanceof Error ? err.message : String(err)}`)
}
if (!newest) fail(`không có artifact .db nào trong ${PREFIX} — chưa từng backup?`)

// --- (2) Tải về bản sao tạm ---
try {
  const got = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: newest.key }))
  const bytes = Buffer.from(await got.Body!.transformToByteArray())
  writeFileSync(TMP_COPY, bytes)
  console.log(`Artifact backup    : ${newest.key} (${fmtMb(newest.size)}, ${newest.lastModified.toISOString()} — ${((Date.now() - newest.lastModified.getTime()) / 3600_000).toFixed(1)}h tuổi)`)
  console.log(`Đã tải về          : ${TMP_COPY} (${fmtMb(bytes.length)})`)
  if (bytes.length < 100 || bytes.subarray(0, 16).toString('binary') !== 'SQLite format 3\0') {
    fail('buffer tải về không phải file SQLite hợp lệ (magic header sai).')
  }
} catch (err) {
  fail(`tải artifact thất bại: ${err instanceof Error ? err.message : String(err)}`)
}

// --- (3) PRAGMA integrity_check trên BẢN SAO TẠM ---
const backupDb = new Database(TMP_COPY, { readonly: true })
const integrity = backupDb.query('PRAGMA integrity_check').all() as Array<{ integrity_check: string }>
const integrityOk = integrity.length === 1 && integrity[0].integrity_check === 'ok'
console.log(`Integrity check    : ${integrity.map(r => r.integrity_check).join('; ') || '(trống)'}`)

// --- (4) Row-count 5 bảng chính: backup vs DB sống (READ-ONLY) ---
const liveDb = new Database(LIVE_DB, { readonly: true })
const rows: Array<{ table: string; backup: number | null; live: number | null }> = []
for (const t of KEY_TABLES) {
  const count = (db: Database): number | null => {
    try {
      const r = db.query(`SELECT COUNT(*) AS n FROM "${t}"`).get() as { n: number | bigint } | null
      return r ? Number(r.n) : null
    } catch {
      return null // bảng không tồn tại
    }
  }
  rows.push({ table: t, backup: count(backupDb), live: count(liveDb) })
}
backupDb.close()
liveDb.close()

console.log('\nBảng (row-count)   |        Backup |     DB sống |   Δ(live−backup)')
console.log('--------------------+--------------+-------------+----------------')
let missingBackup = 0
let missingLive = 0
for (const r of rows) {
  const b = r.backup === null ? 'KHÔNG CÓ' : String(r.backup)
  const l = r.live === null ? 'KHÔNG CÓ' : String(r.live)
  const d = r.backup !== null && r.live !== null ? String(r.live - r.backup) : '—'
  console.log(`${r.table.padEnd(19)} | ${b.padStart(12)} | ${l.padStart(11)} | ${d.padStart(16)}`)
  if (r.backup === null) missingBackup++
  if (r.live === null) missingLive++
}

// --- (5) Phán đoán ---
if (!integrityOk) fail(`PRAGMA integrity_check không 'ok' trên bản sao backup — bản backup HỎNG, không dùng để restore được.`)
if (missingBackup > 0) fail(`${missingBackup}/${KEY_TABLES.length} bảng chính KHÔNG có trong bản backup — backup không đầy đủ để khôi phục.`)
if (missingLive > 0) fail(`${missingLive}/${KEY_TABLES.length} bảng chính KHÔNG có trong DB sống — so sánh không thực hiện được.`)

// Cảnh báo thông tin (không FAIL): live < backup = có dữ liệu bị xoá sau lúc backup
// (prune/sweep xoá row cũ là bình thường); backup quá cũ > 48h → cron 03:00 đáng ngờ.
const staleHours = (Date.now() - newest.lastModified.getTime()) / 3600_000
const warnings: string[] = []
for (const r of rows) {
  if (r.backup !== null && r.live !== null && r.live < r.backup) {
    warnings.push(`${r.table}: DB sống ÍT HƠN backup ${r.backup - r.live} row (dữ liệu bị xoá sau lúc backup — kiểm tra prune/sweep nếu ngoài ý muốn)`)
  }
}
if (staleHours > 48) warnings.push(`backup đã ${staleHours.toFixed(1)}h tuổi (> 48h ngưỡng P3-c) — cron 03:00 VN có thể chưa chạy/failed, xem ALISTA rule db:backup_stale_sqlite`)

console.log('')
for (const w of warnings) console.log(`CẢNH BÁO: ${w}`)
console.log(`\nPHÁN ĐOÁN: PASS — backup mới nhất (${newest.key}) khôi phục được: integrity_check ok + đủ ${KEY_TABLES.length}/${KEY_TABLES.length} bảng chính, row-count đọc được cả 2 phía.`)
process.exit(0)
BUN_EOF

# ---------- 4. Chạy drill (cwd = project root để bun nạp .env) ----------
cd "$PROJECT_ROOT"
bun "$TMP_BUN" "$LIVE_DB" "$TMP_COPY"
