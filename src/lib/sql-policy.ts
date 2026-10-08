/**
 * SQL POLICY — chính sách dùng chung cho mọi call site SQL (src/lib/sql-policy.ts)
 *
 * THUẦN (pure): không import DB, không side-effect → test được không cần mở SQLite.
 * Ba việc:
 *   1. Identifier (tên bảng/cột) không thể bind placeholder → PHẢI validate allow-list rồi quote.
 *   2. LIMIT phải là SỐ NGUYÊN trong [1, cap] — `LIMIT -1` nghĩa là KHÔNG GIỚI HẠN trong SQLite.
 *   3. Read-only guard + redact log: mask literal/comment trước khi quét keyword,
 *      nếu không attacker giấu `; DROP` sau một string literal sẽ lọt.
 */
export const SQL_IDENTIFIER_MAX_LEN = 64
const IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

/** True nếu `name` là identifier SQL hợp lệ (chữ/số/gạch dưới, không bắt đầu bằng số). */
export function isSafeSqlIdentifier(name: unknown): name is string {
  return (
    typeof name === 'string' &&
    name.length > 0 &&
    name.length <= SQL_IDENTIFIER_MAX_LEN &&
    IDENTIFIER_RE.test(name)
  )
}

/** Quote identifier sau khi validate — throw nếu không hợp lệ (fail-closed). */
export function quoteSqlIdentifier(name: unknown): string {
  if (!isSafeSqlIdentifier(name)) {
    throw new Error(`Unsafe SQL identifier rejected: ${String(name).slice(0, 80)}`)
  }
  return `"${name}"`
}

export const SQL_LIMIT_MIN = 1
export const SQL_LIMIT_MAX = 1000
export const SQL_LIMIT_DEFAULT = 100

/** Ép `value` về số nguyên trong [1, cap]; NaN/Infinity/non-number → fallback. */
export function clampSqlLimit(
  value: unknown,
  cap: number = SQL_LIMIT_MAX,
  fallback: number = SQL_LIMIT_DEFAULT,
): number {
  const capN = Math.max(SQL_LIMIT_MIN, Math.min(SQL_LIMIT_MAX, Math.floor(Number(cap)) || SQL_LIMIT_MAX))
  const n = typeof value === 'number' ? value : Number(value)
  // NaN → fallback mặc định. ±Infinity phải ép về cap/min TƯỚNG ỨNG chứ không
  // được rơi về fallback: `LIMIT -1`/Infinity nghĩa là "không giới hạn" ở SQLite.
  if (Number.isNaN(n)) return Math.min(Math.max(fallback, SQL_LIMIT_MIN), capN)
  if (n === Number.POSITIVE_INFINITY) return capN
  if (n === Number.NEGATIVE_INFINITY) return SQL_LIMIT_MIN
  const i = Math.floor(n)
  if (i < SQL_LIMIT_MIN) return SQL_LIMIT_MIN
  if (i > capN) return capN
  return i
}

/**
 * Scanner 1 lượt: bỏ comment (dạng `--` và dạng khối mở bằng slash-*) rồi thay MỌI
 * literal/identifier có quote
 * bằng `?`. Dùng chung cho keyword-scan, multi-statement detect và redact log.
 * Vì literal bị nuốt trọn, comment chứa dấu `'` không thể phá vỡ phân tích.
 */
export function maskSqlLiteralsAndComments(sql: string): string {
  let out = ''
  let i = 0
  const n = sql.length
  while (i < n) {
    const ch = sql[i]
    if (ch === '-' && sql[i + 1] === '-') {
      while (i < n && sql[i] !== '\n') i++
      out += ' '
      continue
    }
    if (ch === '/' && sql[i + 1] === '*') {
      i += 2
      while (i < n && !(sql[i] === '*' && sql[i + 1] === '/')) i++
      i += 2
      out += ' '
      continue
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      const q = ch
      out += '?'
      i++
      while (i < n) {
        if (sql[i] === q) {
          if (sql[i + 1] === q) { i += 2; continue }
          i++
          break
        }
        i++
      }
      continue
    }
    out += ch
    i++
  }
  return out
}

export const SQL_FORBIDDEN_KEYWORDS = [
  'INSERT', 'UPDATE', 'DELETE', 'DROP', 'ALTER', 'TRUNCATE', 'CREATE', 'GRANT', 'REVOKE',
  'ATTACH', 'DETACH', 'REPLACE', 'VACUUM', 'ANALYZE', 'REINDEX', 'BEGIN', 'COMMIT',
  'ROLLBACK', 'SAVEPOINT', 'RELEASE', 'MERGE', 'RETURNING',
  // P0-3: load_extension() nạp .so/.dylib tùy ý — là "đọc" về hình thức nhưng
  // thực thi code ngoài tiến trình. Chặn như write.
  'LOAD_EXTENSION',
] as const

const ALLOWED_FIRST_TOKENS = new Set(['SELECT', 'WITH', 'EXPLAIN'])

export function firstSqlToken(maskedSql: string): string {
  const m = maskedSql.trim().match(/^([A-Za-z_]+)/)
  return m ? m[1].toUpperCase() : ''
}

export function stripTrailingSemicolon(sql: string): string {
  return sql.trim().replace(/;+\s*$/, '')
}

/** Guard read-only 2 lớp (deny-list keyword + allow-list first token), fail-closed. */
export function isReadOnlySql(sql: unknown): { safe: boolean; reason?: string } {
  if (typeof sql !== 'string' || !sql.trim()) return { safe: false, reason: 'SQL query is empty' }
  const masked = maskSqlLiteralsAndComments(sql)
  if (/;\s*\S/.test(masked)) {
    return { safe: false, reason: 'multi-statement queries are not allowed' }
  }
  const upper = masked.toUpperCase()
  if (/\bPRAGMA\b/.test(upper) && !/\bQUERY_PLAN\b/.test(upper)) {
    return { safe: false, reason: 'PRAGMA statements are not allowed (except PRAGMA query_plan)' }
  }
  for (const kw of SQL_FORBIDDEN_KEYWORDS) {
    if (new RegExp(`\\b${kw}\\b`).test(upper)) {
      return { safe: false, reason: `write keyword "${kw}" is not allowed` }
    }
  }
  const token = firstSqlToken(masked)
  const ok = ALLOWED_FIRST_TOKENS.has(token) || (token === 'PRAGMA' && /\bQUERY_PLAN\b/.test(upper))
  if (!ok) {
    return { safe: false, reason: 'only SELECT / WITH (CTE) / EXPLAIN / PRAGMA query_plan are allowed' }
  }
  return { safe: true }
}

/**
 * Ép LIMIT cứng bằng CÁCH BỌC subquery (KHÔNG nối chuỗi vào cuối câu của người dùng —
 * cách cũ bị bypass bằng chữ "LIMIT" nằm trong string literal).
 * EXPLAIN / PRAGMA query_plan không trả row → không bọc.
 */
export function enforceSqlLimit(sql: string, limit?: number, cap?: number): string {
  const n = clampSqlLimit(limit, cap ?? SQL_LIMIT_MAX, SQL_LIMIT_DEFAULT)
  const body = stripTrailingSemicolon(sql)
  const token = firstSqlToken(maskSqlLiteralsAndComments(body))
  if (token === 'SELECT' || token === 'WITH') {
    return `SELECT * FROM (${body}) sub LIMIT ${n}`
  }
  return body
}

/** Bản log an toàn: literal đã bị thay bằng `?` → không rò dữ liệu nhạy cảm ra log. */
export function redactSqlForLog(sql: unknown, maxLen = 200): string {
  const masked = maskSqlLiteralsAndComments(typeof sql === 'string' ? sql : String(sql))
    .replace(/\s+/g, ' ')
    .trim()
  return masked.length > maxLen ? `${masked.slice(0, maxLen)}…` : masked
}
