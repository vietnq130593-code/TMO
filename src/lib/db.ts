import { PrismaClient } from '@prisma/client'

// ==================== PORTABILITY CHECK (2026-08-31) ====================
// Nếu DATABASE_URL dùng đường dẫn TUYỆT ĐỐI (vd: file:/home/z/tmo-app/db/custom.db
// hoặc file:C:/Users/.../db/custom.db), việc copy thư mục app sang vị trí khác
// sẽ KHÔNG mang theo dữ liệu — bản copy vẫn đọc/ghi DB ở vị trí CŨ.
// Khuyến nghị: dùng đường dẫn TƯƠNG ĐỐI `file:../db/custom.db` (tương đối với
// prisma/schema.prisma) để bản copy tự dùng file DB riêng của nó.
(function warnIfAbsoluteDbPath() {
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
})()

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined
  sqlitePragmasApplied: boolean | undefined
}

export const db =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
  })

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
      await db.$queryRawUnsafe('PRAGMA busy_timeout=5000')
      await db.$queryRawUnsafe('PRAGMA synchronous=NORMAL')
      await db.$queryRawUnsafe('PRAGMA cache_size=-64000')
      await db.$queryRawUnsafe('PRAGMA temp_store=MEMORY')
      console.log('[DB] SQLite PRAGMAs applied: WAL, busy_timeout=5000, synchronous=NORMAL, cache_size=64MB, temp_store=MEMORY')
    } catch (err) {
      console.warn('[DB] SQLite PRAGMA setup error (non-critical):', err instanceof Error ? err.message : String(err))
    }
  }
  applyPragmas()
}
