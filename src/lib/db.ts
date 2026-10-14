import { PrismaClient } from '@prisma/client'
import fs from 'fs'
import path from 'path'

// ==================== DATABASE_URL RESOLUTION (TASK 55 — 2026-09-28) ====================
// 2 lớp giải quyết 2 sự cố vận hành THẬT (đã gặp trong sandbox):
//
// (1) ENV LEAK GUARD — shell sandbox xuất DATABASE_URL của project KHÁC
//     (vd file:/home/z/my-project/db/custom.db — file KHÔNG tồn tại); bun
//     không override env đã set bằng .env → mọi process chạy từ shell mở nhầm
//     DB chết (Error code 14: CANTOPEN). pm2-start.sh đã `unset DATABASE_URL`
//     cho app; guard này bảo vệ thêm đường `bun run dev` thủ công + script.
//     Chính sách: env kế thừa trỏ file TỒN TẠI → GIỮ NGUYÊN (override chủ đích
//     của người dùng — 12-factor; /tmp test DB của tests/db-isolation-preload
//     cũng tự nhiên an toàn vì file tồn tại). Trỏ file KHÔNG tồn tại → ưu tiên
//     DATABASE_URL trong .env của project này (nguồn sự thật cho project).
//
// (2) RELATIVE → ABSOLUTE — Prisma CLI (db push / migrate) resolve `file:`
//     tương đối theo prisma/schema.prisma, nhưng CLIENT runtime resolve theo
//     CWD → `file:../db/custom.db` từ CWD=/home/z/tmo-app trỏ /home/z/db/...
//     (không tồn tại) → CANTOPEN. Chuẩn hóa về schema-relative tuyệt đối —
//     chạy đúng từ BẤT KỲ CWD nào (scripts, bun test, pm2 start mới, next dev).
let __dbUrlWasRelative = false

function findProjectRoot(): string {
  let root = process.cwd()
  for (let i = 0; i < 6 && !fs.existsSync(path.join(root, 'prisma', 'schema.prisma')); i++) {
    root = path.dirname(root)
  }
  return root
}

/** Đọc DATABASE_URL= từ file .env (bỏ qua comment; strip quote). '' = không khai báo. */
function readEnvFileDatabaseUrl(envPath: string): string {
  if (!fs.existsSync(envPath)) return ''
  try {
    const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/)
    let value = ''
    for (const line of lines) {
      const m = line.match(/^\s*(?:export\s+)?DATABASE_URL\s*=\s*(.*)$/)
      if (m) {
        let v = m[1].trim()
        v = v.replace(/\s+#.*$/, '').trim() // strip trailing comment
        if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
          v = v.slice(1, -1)
        }
        value = v
      }
    }
    return value
  } catch {
    return ''
  }
}

(function resolveDatabaseUrl() {
  const inherited = (process.env.DATABASE_URL || '').trim()
  const envUrl = readEnvFileDatabaseUrl(path.join(findProjectRoot(), '.env'))

  // ---- Lớp 1: env leak guard ----
  if (envUrl && inherited) {
    const inheritedPath = inherited.match(/^file:(.+)$/)?.[1]?.trim()
    if (inheritedPath) {
      const inheritedAbs = path.isAbsolute(inheritedPath)
        ? inheritedPath
        : path.resolve(process.cwd(), inheritedPath)
      if (!fs.existsSync(inheritedAbs)) {
        console.warn(
          `[DB] ⚠️ DATABASE_URL kế thừa từ môi trường ("${inherited}") trỏ file KHÔNG tồn tại — ưu tiên .env của project: "${envUrl}"`,
        )
        process.env.DATABASE_URL = envUrl
      }
    }
  } else if (envUrl && !inherited) {
    process.env.DATABASE_URL = envUrl
  }

  // ---- Lớp 2: chuẩn hóa tương đối → tuyệt đối (schema-relative) ----
  const url = process.env.DATABASE_URL || ''
  const m = url.match(/^file:(.+)$/)
  if (m) {
    const rawPath = m[1].trim()
    const isAbsolute =
      rawPath && (rawPath.startsWith('/') || rawPath.startsWith('\\') || /^[A-Za-z]:[\\/]/.test(rawPath))
    if (rawPath && !isAbsolute) {
      const resolved = path.resolve(path.join(findProjectRoot(), 'prisma'), rawPath)
      __dbUrlWasRelative = true // cho warnIfAbsoluteDbPath dưới — không cảnh báo nhầm
      process.env.DATABASE_URL = `file:${resolved}`
      console.log(`[DB] DATABASE_URL tương đối chuẩn hóa: ${url} → file:${resolved} (schema-relative)`)
    }
  }
})(); // <- semicolon BẮT BUỘC: IIFE sau này sẽ bị nối chuỗi thành call trên undefined

// ==================== PORTABILITY CHECK (2026-08-31) ====================
// Nếu DATABASE_URL (.env gốc) dùng đường dẫn TUYỆT ĐỐI (vd: file:/home/z/tmo-app/db/custom.db
// hoặc file:C:/Users/.../db/custom.db), việc copy thư mục app sang vị trí khác
// sẽ KHÔNG mang theo dữ liệu — bản copy vẫn đọc/ghi DB ở vị trí CŨ.
// Khuyến nghị: dùng đường dẫn TƯƠNG ĐỐI `file:../db/custom.db` (tương đối với
// prisma/schema.prisma) để bản copy tự dùng file DB riêng của nó.
// (TASK 55: URL tương đối được normalize ở trên — cảnh báo dưới chỉ dành cho
// trường hợp .env gốc THỰC SỰ tuyệt đối do người dùng tự viết.)
(function warnIfAbsoluteDbPath() {
  if (__dbUrlWasRelative) return // .env gốc là tương đối (đúng khuyến nghị) — im lặng
  const url = process.env.DATABASE_URL || ''
  const m = url.match(/^file:(\/|\\|[A-Za-z]:[\\/])/)
  if (m) {
    console.warn(
      `[DB] ⚠️ DATABASE_URL đang dùng đường dẫn TUYỆT ĐỐI: "${url.replace(/([/\\])[^/\\]+$/, '$1...')}"` +
      ` — nếu copy thư mục app sang chỗ khác, bản copy VẪN trỏ về DB cũ. ` +
      `Đổi thành 'file:../db/custom.db' (tương đối) để DB đi kèm theo thư mục. ` +
      `Lưu ý: stop app trước khi copy (WAL mode — dữ liệu mới nhất có thể nằm trong custom.db-wal).`
    )
  }
})();

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined
  sqlitePragmasApplied: boolean | undefined
}

// ==================== SQLITE BUSY_TIMEOUT — P-NEW-1 GỐC CƠ CHẾ (R15) ====================
// Quan sát gốc R11 §8.3 (51 lỗi dev.log): cụm "Socket timeout (the database
// failed to respond to a query within the configured timeout)" tập trung
// ĐÚNG lúc run-close ghi bùng nổ. Live-probe R15 (bun + @prisma/client 6.19):
//   URL không param → PRAGMA busy_timeout = 5000 (ms) — ĐÚNG con số
//   "transaction timeout 5000ms" của quan sát R11; URL ?socket_timeout=15
//   → PRAGMA busy_timeout = 15000 (đơn vị param là GIÂY, engine nhân 1000).
// FIX 3 tầng (R15): (1) URL param socket_timeout cho MỌI connection pool
// (PRAGMA raw $queryRawUnsafe chỉ ảnh hưởng connection thực thi nó — không
// đủ trong pool nhiều connection); (2) tầng R14 giảm nguồn contention
// (sub-agent pool=1 + OC-CLI semaphore + user-run priority);
// (3) withSqliteRetry giữ làm lưới an toàn. REOPEN nếu "Socket timeout"
// tái xuất dưới tải thật — bước kế tiếp khi đó: write-queue architecture.
// Env override: SQLITE_BUSY_TIMEOUT_S (giây, 1..120, mặc định 15).
const SQLITE_BUSY_TIMEOUT_S = (() => {
  const raw = parseInt(process.env.SQLITE_BUSY_TIMEOUT_S || '', 10)
  return Number.isFinite(raw) && raw >= 1 && raw <= 120 ? raw : 15
})()

/** Thêm ?socket_timeout=N cho URL file: (SQLite) — không đụng URL đã có sẵn
 *  socket_timeout do user tự cấu hình; URL không phải file: trả nguyên bản. */
function urlWithSqliteBusyTimeout(url: string): string {
  if (!url.startsWith('file:')) return url
  if (/[?&]socket_timeout=/.test(url)) return url
  const sep = url.includes('?') ? '&' : '?'
  return `${url}${sep}socket_timeout=${SQLITE_BUSY_TIMEOUT_S}`
}

export const db =
  globalForPrisma.prisma ??
  (() => {
    // FIX prisma:error P2025 (user report): Prisma client in prisma:error ra
    // console cho MỌI lỗi query — kể cả P2025 "No record was found for an
    // update/delete" mà app chủ ĐỢI như control-flow (todo_write/upsert các
    // nơi đều .catch(() => null) khi agent truyền id không tồn tại). Chuyển
    // 'error' sang event emitter và LỌC đúng họ P2025 (record not found) —
    // im lặng vì caller đã xử lý; MỌI lỗi khác (connection, SQL, P2002...)
    // vẫn in prisma:error như cũ. 'warn' giữ stdout (dev only) như trước.
    // P-NEW-1 (R15): datasources.url scope socket_timeout CHỈ cho client —
    // process.env.DATABASE_URL giữ nguyên để Prisma CLI (db push qua
    // db-setup.ts:229 inherit env) không phải ăn param lạ.
    const resolvedUrl = (process.env.DATABASE_URL || '').trim()
    const client = new PrismaClient({
      ...(resolvedUrl ? { datasources: { db: { url: urlWithSqliteBusyTimeout(resolvedUrl) } } } : {}),
      log: [
        ...(process.env.NODE_ENV === 'development'
          ? [{ emit: 'stdout' as const, level: 'warn' as const }]
          : []),
        { emit: 'event' as const, level: 'error' as const },
      ],
    })
    client.$on('error', (e) => {
      // Họ P2025: "No record was found for an update" /
      // "An operation failed because it depends on one or more records that
      //  were required but not found." — luồng CÓ DỰ KIẾN, caller tự xử lý.
      if (
        /\bno record was found\b/i.test(e.message) ||
        /records? that (were |was )?required but not found/i.test(e.message)
      ) {
        return
      }
      console.error('prisma:error', e.message)
    })
    return client
  })()

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = db

// Apply SQLite PRAGMA optimizations once per process
// These run asynchronously — first query will wait for them implicitly
// WAL mode allows concurrent reads during writes (prevents SQLITE_BUSY)
// busy_timeout retries lock acquisition instead of failing immediately
if (!globalForPrisma.sqlitePragmasApplied) {
  globalForPrisma.sqlitePragmasApplied = true
  const applyPragmas = async () => {
    try {
      // Use $queryRawUnsafe for PRAGMAs that return values,
      // $executeRawUnsafe for those that don't return results.
      // SQLite PRAGMA SET statements (with =) don't return rows,
      // but Prisma still sometimes rejects them with $executeRawUnsafe.
      // Safest approach: use $queryRawUnsafe which handles both cases.
      await db.$queryRawUnsafe('PRAGMA journal_mode=WAL')
      // P-NEW-1 (R15): đồng bộ với URL param — connection raw này cũng được
      // 15s (URL đã lo phần pool; PRAGMA raw ở đây giữ nhất quán + log rõ)
      await db.$queryRawUnsafe(`PRAGMA busy_timeout=${SQLITE_BUSY_TIMEOUT_S * 1000}`)
      await db.$queryRawUnsafe('PRAGMA synchronous=NORMAL')
      await db.$queryRawUnsafe('PRAGMA cache_size=-64000')
      await db.$queryRawUnsafe('PRAGMA temp_store=MEMORY')
      console.log(`[DB] SQLite PRAGMAs applied: WAL, busy_timeout=${SQLITE_BUSY_TIMEOUT_S * 1000} (P-NEW-1 R15 — URL socket_timeout=${SQLITE_BUSY_TIMEOUT_S}s áp mọi connection pool), synchronous=NORMAL, cache_size=64MB, temp_store=MEMORY`)
    } catch (err) {
      console.warn('[DB] SQLite PRAGMA setup error (non-critical):', err instanceof Error ? err.message : String(err))
    }
  }
  applyPragmas()
}

// ==================== SQLITE TRANSIENT RETRY (Task 33 — 2026-10-13, §0b lượt 2) ====================
//
// QUAN SÁT GỐC RỄ (đo thật trong dev.log, 51 lỗi): các cụm "Socket timeout
// (the database failed to respond to a query within the configured timeout)"
// tập trung ĐÚNG các thời điểm run-close ghi bùng nổ — metrics + verdict
// resolve + QEntry + token persist + auto-train + auto-learn + ledger đồng
// thời. SQLite 1 writer: hàng đợi vượt timeout query engine → lỗi. Hành vi
// ĐÚNG với lock tạm thời là RETRY, không phải bỏ cuộc.
//
// Thiệt hại đã đo khi KHÔNG retry: (1) updateQ mất vĩnh viễn tín hiệu
// Q-learning (QEntry=0 → Brain-C "Lệnh" đứt nguồn — không dirty-state như
// TokenTracker); (2) persistAgentRunRecord đóng run fail → row kẹt
// 'running' tới khi orphan-sweep 30' (sub_1791916072938_2); (3) TokenTracker
// retry có sẵn nhưng isTransientDbError (llm.ts) thiếu pattern này.
//
// Các đường critical bọc qua withSqliteRetry: updateQ (q-table) ·
// updateLatestAgentRunRecord + resolveArbiterVerdictsDetailed (metrics-db).
// llm.ts isTransientDbError DELEGATE xuống isTransientSqliteError.

/** Họ lỗi SQLite/Prisma tạm thời — retry được (lock/contention/timeout).
 * Xuất riêng để llm.ts + q-table.ts dùng chung (single source — doctrine #9). */
const TRANSIENT_SQLITE_PATTERNS: readonly string[] = [
  'Unable to open',
  'SQLITE_BUSY',
  'SQLITE_CANTOPEN',
  'Error code 14',
  'database is locked',
  'Connection is closed',
  'prepared statement failed',
  // Task 33: họ socket-timeout của Prisma query engine (SQLite connector) —
  // message chuẩn "Socket timeout (the database failed to respond...)" +
  // P2024 "Timed out fetching a new connection...".
  'Socket timeout',
  'Timed out fetching',
  // Task 33 (tiếp — ledger run.end bị mất): $transaction hết hạn dưới contention
  // — "Transaction API error: Transaction already closed: A commit cannot be
  // executed on an expired transaction." Retry = transaction mới hoàn toàn.
  'expired transaction',
]

export function isTransientSqliteError(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  const msg = err.message || ''
  return TRANSIENT_SQLITE_PATTERNS.some(p => msg.includes(p))
}

/** Dòng đầu message lỗi đã trim — log không còn "trông rỗng" khi message
 * multiline bắt đầu bằng \n (đo thật: `[QTable] updateQ(...) failed: ` trống
 * vì message Prisma bắt đầu bằng xuống dòng). */
export function firstErrLine(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err)
  return (msg.split('\n').find(l => l.trim()) || '').trim().slice(0, 200)
}

/**
 * Chạy op với retry backoff cho lỗi SQLite tạm thời (Task 33). Mặc định 3 thử
 * thêm (tổng 4 lần, delay 400ms → 1.2s → 3.6s) — đủ hấp thụ cụm ghi run-close
 * (đo thật: cửa sổ contention dài vài giây). Lỗi KHÔNG tạm thời (validation,
 * constraint...) ném nguyên trạng ngay. Hết retry → ném lỗi gốc cho caller tự
 * xử lý theo doctrine từng đường (fail-open ở caller, không nuốt ở đây).
 * op phải IDEMPOTENT (chạy lại an toàn — đọc-tính-ghi hoặc update theo id).
 */
export async function withSqliteRetry<T>(
  op: () => Promise<T>,
  opts: { retries?: number; baseDelayMs?: number; label?: string } = {},
): Promise<T> {
  const retries = opts.retries ?? 3
  const baseDelayMs = opts.baseDelayMs ?? 400
  let lastErr: unknown
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await op()
    } catch (err) {
      lastErr = err
      if (!isTransientSqliteError(err) || attempt === retries) break
      const delay = baseDelayMs * Math.pow(3, attempt) // 400ms → 1.2s → 3.6s
      console.warn(
        `[DB] ${opts.label ?? 'op'} transient SQLite (lần ${attempt + 1}/${retries}) — retry sau ${delay}ms: ${firstErrLine(err)}`,
      )
      await new Promise(resolve => setTimeout(resolve, delay))
    }
  }
  throw lastErr
}
