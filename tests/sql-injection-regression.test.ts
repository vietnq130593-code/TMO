// ============================================================================
// TEST HỒI QUY — SQL INJECTION ÂM TÍNH + CHÍNH SÁCH SQL (P0-3)
// ============================================================================
//
// Mục đích: khóa lại bằng chứng máy cho 4 thuộc tính BẢO MẬT của lớp SQL:
//   1. Identifier (tên bảng/cột) không bind được → phải validate allow-list.
//   2. LIMIT phải là số nguyên trong [1, cap]  (LIMIT -1 = KHÔNG GIỚI HẠN).
//   3. Read-only guard phải mask literal/comment TRƯỚC khi quét keyword —
//      nếu quét chuỗi thô thì attacker giấu payload sau một string literal.
//   4. Log không được chứa dữ liệu nhạy cảm (literal đã bị thay bằng `?`).
//
// Cần đọc trước khi sửa:
//   - src/lib/sql-policy.ts (chính sách dùng chung, thuần — không cần DB)
//   - src/app/api/openclaw/knowledge/query/route.ts (API knowledge, dùng chính sách)
//   - src/lib/code-team/dev-tools.ts:5302+ (db_query — cùng chính sách)
//
// Chạy: bun test tests/sql-injection-regression.test.ts
// ============================================================================

import { describe, expect, test } from 'bun:test'
import {
  clampSqlLimit,
  enforceSqlLimit,
  isReadOnlySql,
  isSafeSqlIdentifier,
  maskSqlLiteralsAndComments,
  quoteSqlIdentifier,
  redactSqlForLog,
} from '../src/lib/sql-policy'

describe('sql-policy — identifier allow-list', () => {
  test('chấp nhận identifier hợp lệ', () => {
    for (const name of ['ToolMetric', 'AgentRunRecord', '_private', 't9']) {
      expect(isSafeSqlIdentifier(name)).toBe(true)
      expect(quoteSqlIdentifier(name)).toBe(`"${name}"`)
    }
  })

  test('TỪ CHỐI identifier mang payload injection (fail-closed, throw)', () => {
    const evil = [
      'T"; DROP TABLE ToolMetric; --',
      "t' UNION SELECT * FROM sqlite_master",
      't) UNION SELECT',
      '1 OR 1=1',
      '',
      'a'.repeat(65),
    ]
    for (const name of evil) {
      expect(isSafeSqlIdentifier(name)).toBe(false)
      expect(() => quoteSqlIdentifier(name)).toThrow()
    }
    // non-string cũng phải chặn (từ queryRawUnsafe có thể trả bất kỳ thứ gì)
    expect(isSafeSqlIdentifier(undefined)).toBe(false)
    expect(isSafeSqlIdentifier(123)).toBe(false)
  })
})

describe('sql-policy — clampSqlLimit', () => {
  test('ép về số nguyên trong [1, cap]', () => {
    expect(clampSqlLimit(50)).toBe(50)
    expect(clampSqlLimit(-1)).toBe(1)          // LIMIT -1 = KHÔNG GIỚI HẠN
    expect(clampSqlLimit(0)).toBe(1)
    expect(clampSqlLimit(999999, 100)).toBe(100)
    expect(clampSqlLimit(1.9)).toBe(1)         // floor
    expect(clampSqlLimit('abc')).toBe(100)     // fallback mặc định
    expect(clampSqlLimit(Number.NaN, 100)).toBe(100)
    expect(clampSqlLimit(Number.POSITIVE_INFINITY, 100)).toBe(100)
    expect(clampSqlLimit(Number.NEGATIVE_INFINITY, 100)).toBe(1)
  })
})

describe('sql-policy — read-only guard (SQLi ÂM TÍNH)', () => {
  test('chặn multi-statement ở MỌI vị trí', () => {
    const payloads = [
      'SELECT 1; DROP TABLE ToolMetric',
      "SELECT 1 FROM sqlite_master WHERE name='x'; DELETE FROM ToolMetric",
      'SELECT 1 /* c */; /* d */ DROP TABLE ToolMetric',
    ]
    for (const p of payloads) {
      const v = isReadOnlySql(p)
      expect(v.safe).toBe(false)
      expect(v.reason).toMatch(/multi-statement|write keyword|only SELECT/)
    }
  })

  test('chặn write/DDL dù payload nằm sau comment', () => {
    // LƯU Ý: keyword nằm TRONG comment là vô hại (`-- DROP\nSELECT 1` → sau mask
    // còn `SELECT 1`) và CỐ TÌNH cho qua — khớp với hành vi đã khoá ở
    // tests/db-query-readonly-guard.test.ts:69. Danh sách dưới đây chỉ gồm
    // payload có câu GHI THẬT sau comment.
    for (const p of [
      '/* SELECT */ DELETE FROM Todo',
      '-- lead\nDROP TABLE ToolMetric',
      'SELECT 1 --\n; DELETE FROM Todo',
      'SELECT 1 /* x */ ; /* y */ UPDATE Todo SET id = 1',
      '/* hide */ ; VACUUM INTO \'/tmp/steal.db\'',
    ]) {
      expect(isReadOnlySql(p).safe).toBe(false)
    }
  })

  test('chặn PRAGMA (trừ query_plan) + VACUUM/ATTACH', () => {
    for (const p of ['PRAGMA table_info(ToolMetric)', 'VACUUM INTO \'/tmp/x.db\'', 'ATTACH DATABASE \'/tmp/x.db\' AS z']) {
      expect(isReadOnlySql(p).safe).toBe(false)
    }
    expect(isReadOnlySql('PRAGMA query_plan').safe).toBe(true)
  })

  test('chặn empty / non-string', () => {
    expect(isReadOnlySql('').safe).toBe(false)
    expect(isReadOnlySql('   ').safe).toBe(false)
    expect(isReadOnlySql(undefined as unknown as string).safe).toBe(false)
  })

  test('CHO PHÉP đúng 3 cửa đọc', () => {
    expect(isReadOnlySql('SELECT * FROM sqlite_master').safe).toBe(true)
    expect(isReadOnlySql('WITH x AS (SELECT 1 AS v) SELECT * FROM x').safe).toBe(true)
    expect(isReadOnlySql('EXPLAIN SELECT 1 AS one').safe).toBe(true)
  })

  test('data-modifying CTE vẫn bị chặn (WITH không phải lá chắn)', () => {
    for (const p of [
      'WITH x AS (SELECT 1) INSERT INTO Todo VALUES (1)',
      'WITH x AS (SELECT 1) UPDATE Todo SET id = 1',
      'WITH x AS (SELECT 1) DELETE FROM Todo',
    ]) {
      expect(isReadOnlySql(p).safe).toBe(false)
    }
  })

  test('payload trong string literal bị mask — không lọt keyword guard (âm tính)', () => {
    // Nếu guard quét CHUỖI THÔ thì `DROP`/`;` trong literal có thể làm sai lệch
    // phân tích (và cũng làm addLimit bản cũ bỏ sót). Sau mask: literal → `?`.
    const masked = maskSqlLiteralsAndComments("SELECT name AS \"LIMIT\" FROM sqlite_master WHERE name='x; DROP TABLE T'")
    expect(masked).not.toContain('DROP')
    expect(masked).not.toContain('x; ')
    // câu này BẢN THÂN vô hại (literal là dữ liệu, không thực thi) → vẫn cho phép
    expect(isReadOnlySql("SELECT name FROM sqlite_master WHERE name='x; DROP TABLE T'").safe).toBe(true)
  })
})

describe('sql-policy — LIMIT cứng cho API knowledge', () => {
  test('luôn bọc subquery khi SELECT/WITH — không phụ thuộc có chữ LIMIT trong câu', () => {
    const bypass = enforceSqlLimit('SELECT name AS "LIMIT" FROM sqlite_master', 100, 100)
    expect(bypass).toBe('SELECT * FROM (SELECT name AS "LIMIT" FROM sqlite_master) sub LIMIT 100')
    // câu do người dùng tự đặt LIMIT 999999 vẫn bị cap
    expect(enforceSqlLimit('SELECT * FROM sqlite_master LIMIT 999999', 100, 100)).toContain('LIMIT 100')
  })

  test('cap cứng chặn limit vượt ngưỡng / âm', () => {
    expect(enforceSqlLimit('SELECT 1', 999999, 100)).toContain('LIMIT 100')
    expect(enforceSqlLimit('SELECT 1', -5, 100)).toContain('LIMIT 1')
  })

  test('bỏ dấu ; cuối trước khi bọc (nếu không sẽ vỡ cú pháp subquery)', () => {
    expect(enforceSqlLimit('SELECT 1;', 10, 100)).toBe('SELECT * FROM (SELECT 1) sub LIMIT 10')
  })

  test('EXPLAIN / PRAGMA không bọc (không trả row)', () => {
    expect(enforceSqlLimit('EXPLAIN SELECT 1', 10, 100)).toBe('EXPLAIN SELECT 1')
    expect(enforceSqlLimit('PRAGMA query_plan', 10, 100)).toBe('PRAGMA query_plan')
  })
})

describe('sql-policy — log không rò dữ liệu nhạy cảm', () => {
  test('literal bị thay bằng ? trong bản log', () => {
    const secret = 'SELECT * FROM AgentRunRecord WHERE sessionId = \'supersecret-token-123\''
    const logged = redactSqlForLog(secret)
    expect(logged).not.toContain('supersecret-token-123')
    expect(logged).toContain('?')
  })

  test('log bị cắt ngắn theo maxLen', () => {
    const long = `SELECT * FROM T WHERE x='${'a'.repeat(500)}'`
    expect(redactSqlForLog(long, 50).length).toBeLessThanOrEqual(51)
  })

  test('non-string không làm vỡ hàm log', () => {
    expect(typeof redactSqlForLog(undefined)).toBe('string')
    expect(typeof redactSqlForLog({ a: 1 })).toBe('string')
  })
})
