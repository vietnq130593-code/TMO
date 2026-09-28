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
    const client = new PrismaClient({
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
