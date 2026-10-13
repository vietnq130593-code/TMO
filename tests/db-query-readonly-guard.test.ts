// ============================================================================
// TEST SUITE — db_query READ-ONLY GUARD + FEATURE FLAG (Phase 3.5)
// ============================================================================
//
// Mục đích: db_query là công cụ NGUY HIỂNG — cho phép agent đọc SQLite buffer
// layer. Chốt chặn write/DDL là thuộc tính BẢO MẬT, không phải tiện ích.
// Test này khoá hành vi đó lại bằng bằng chứng máy, tránh một lần refactor
// nới lỏng guard mà không ai nhận ra.
//
// Cần đọc trước khi sửa:
//   - src/lib/code-team/dev-tools.ts:4903 (dbQuery + READ-ONLY GUARD)
//   - src/lib/code-team/tool-executor.ts:2540 (guard cờ ENABLE_DB_QUERY)
//   - src/lib/feature-flags.ts:79 (ENABLE_DB_QUERY default 'false')
//
// Chạy: cd /home/z/tmo-app && bun test tests/db-query-readonly-guard.test.ts
// ============================================================================

// Task 33 (§0b lượt 2 — 2026-10-13): TỪ CHỐI chạy khi DB chưa được cô lập.
// Bản cũ ép DATABASE_URL thẳng file:/home/z/tmo-app/db/custom.db (DB
// PRODUCTION của app) — mọi lượt `bun test` chạy từ cwd NGOÀI project
// (bunfig preload không nạp → TMO_TEST_DB_ISOLATED không set) ghi fixture
// thẳng DB thật. Bằng chứng đo thật: 3 dòng test-lesson-* trong
// LessonRecord production (13:28:34 sau restore) — auto-learn thật còn
// validate + phát learn.episode bẩn vào ledger (2026-10-13). Đường hợp lệ
// duy nhất: `bun test` từ project root — preload (tests/db-isolation-preload.ts)
// copy DB sang /tmp + set TMO_TEST_DB_ISOLATED=1. Ngoài đường đó → fail NGAY
// (doctrine fail-loud Task 54), tuyệt đối không ghi DB production.
if (process.env.TMO_TEST_DB_ISOLATED !== '1') {
  throw new Error(
    '[DB-ISOLATION] Test từ chối chạy trên DB production. Chạy `bun test` từ thư mục gốc tmo-app — bunfig.toml [test].preload sẽ cô lập DB (copy /tmp). Xem tests/db-isolation-preload.ts.',
  )
}

import { describe, expect, test } from 'bun:test'
import { dbQuery } from '../src/lib/code-team/dev-tools'

// ---------- helper ----------
const errOf = (r: any): string => String(r?.error ?? '')

describe('db_query — read-only guard', () => {
  test('reject multi-statement (chèn ; phía sau)', async () => {
    const r: any = await dbQuery({ sql: 'SELECT 1; DROP TABLE sqlite_master' })
    expect(r.success).toBe(false)
    expect(errOf(r)).toContain('multi-statement')
  })

  test('reject mọi write/DDL keyword', async () => {
    const banned = [
      'INSERT',
      'UPDATE',
      'DELETE',
      'DROP',
      'ALTER',
      'TRUNCATE',
      'CREATE',
      'GRANT',
      'REVOKE',
      'ATTACH',
      'DETACH',
    ]
    for (const kw of banned) {
      const r: any = await dbQuery({ sql: `${kw} something` })
      expect(r.success).toBe(false)
      expect(errOf(r)).toContain(`write keyword "${kw}"`)
    }
  })

  test('reject PRAGMA trừ query_plan', async () => {
    const blocked: any = await dbQuery({ sql: 'PRAGMA table_info(users)' })
    expect(blocked.success).toBe(false)
    expect(errOf(blocked)).toContain('PRAGMA statements are not allowed')

    // query_plan là ngoại lệ read-only được chủ đích cho phép
    const allowed: any = await dbQuery({ sql: 'PRAGMA query_plan' })
    expect(errOf(allowed)).not.toContain('PRAGMA statements are not allowed')
  })

  test('strip comment trước khi check — comment không lừa được guard', async () => {
    const withLineComment: any = await dbQuery({ sql: '-- DROP\nSELECT 1' })
    expect(errOf(withLineComment)).not.toContain('write keyword')

    // keyword giấu sau comment block phải bị reject
    const hidden: any = await dbQuery({ sql: 'SELECT 1 /* x */; /* y */ DROP TABLE t' })
    expect(hidden.success).toBe(false)
  })

  test('reject sql rỗng / không phải string', async () => {
    const empty: any = await dbQuery({ sql: '' })
    expect(empty.success).toBe(false)
    expect(errOf(empty)).toContain('sql (string) is required')
  })

  test('SELECT hợp lệ KHÔNG bị guard chặn', async () => {
    const r: any = await dbQuery({ sql: 'SELECT 1 AS one' })
    // Chỉ assert guard không chặn — không phụ thuộc DB có bảng nào
    expect(errOf(r)).not.toContain('rejected by read-only guard')
  })
})

describe('db_query — read-only guard chặn tiêm chú thích', () => {
  test('comment dạng -- che keyword phải vẫn bị nhận diện keyword thật phía sau', async () => {
    // `-- DROP` chỉ là comment (bị strip) nên SELECT 1 hợp lệ
    const r: any = await dbQuery({ sql: '-- DROP\nSELECT 1 AS one' })
    expect(r.success).not.toBe(false)
  })
})

// ============================================================================
// ROUND-32 P1-a — LỖ HỔNG BYPASS ĐÃ LIVE: deny-list cũ bỏ sót REPLACE/VACUUM/
// ANALYZE/BEGIN/... (ENABLE_DB_QUERY=true) + thiếu allow-list first-token.
// Khoá chặt lại bằng bằng chứng máy — không được nới lỏng mà không audit riêng.
// ============================================================================
describe('db_query — P1-a: deny-list mở rộng + allow-list first-token', () => {
  test('reject các verb GHI từng bypass deny-list cũ', async () => {
    const bypassCases: Array<[string, string]> = [
      // [sql, keyword kỳ vọng trong thông báo lỗi]
      ['REPLACE INTO Todo (id, title) VALUES (1, \'x\')', 'REPLACE'],
      ['VACUUM', 'VACUUM'],
      ['VACUUM INTO \'/tmp/steal.db\'', 'VACUUM'],
      ['ANALYZE', 'ANALYZE'],
      ['REINDEX', 'REINDEX'],
      ['BEGIN IMMEDIATE', 'BEGIN'],
      ['BEGIN TRANSACTION', 'BEGIN'],
      ['COMMIT', 'COMMIT'],
      ['ROLLBACK', 'ROLLBACK'],
      ['SAVEPOINT sp1', 'SAVEPOINT'],
      ['RELEASE sp1', 'RELEASE'],
    ]
    for (const [sql, kw] of bypassCases) {
      const r: any = await dbQuery({ sql })
      expect(r.success).toBe(false)
      expect(errOf(r)).toContain(`write keyword "${kw}"`)
    }
  })

  test('reject mọi câu KHÔNG bắt đầu bằng SELECT/WITH/EXPLAIN (allow-list)', async () => {
    // Verb lạ / tương lai không nằm trong deny-list vẫn phải chết ở allow-list
    const weird = [
      'VALUES (1)',            // SQLite cho phép đứng đầu — không phải cửa đọc
      'FOOBAR FROM sqlite_master', // verb không tồn tại — vẫn chặn (fail-closed)
      'attach_test something', // không phải token cho phép
    ]
    for (const sql of weird) {
      const r: any = await dbQuery({ sql })
      expect(r.success).toBe(false)
      expect(errOf(r)).toContain('chỉ cho phép SELECT / WITH (CTE) / EXPLAIN / PRAGMA query_plan')
    }
  })

  test('comment prefix lừa allow-list phải bị strip trước khi check', async () => {
    // `/* SELECT */ DELETE...` — comment bị strip, chữ thật đứng đầu là DELETE
    const r: any = await dbQuery({ sql: '/* SELECT */ DELETE FROM Todo' })
    expect(r.success).toBe(false)
    // DELETE là deny-list keyword — lỗi phải nhắc đúng keyword, không phải allow-list
    expect(errOf(r)).toContain('write keyword "DELETE"')
  })

  test('cửa đọc HỢP LỆ đi qua guard: WITH (CTE) + EXPLAIN', async () => {
    // WITH luôn read-only trong SQLite (không có data-modifying CTE)
    const cte: any = await dbQuery({ sql: 'WITH x AS (SELECT 1 AS v) SELECT * FROM x' })
    expect(errOf(cte)).not.toContain('rejected by read-only guard')

    // EXPLAIN + deny verb vẫn bị chặn (EXPLAIN INSERT → keyword INSERT)
    const explainOk: any = await dbQuery({ sql: 'EXPLAIN SELECT 1 AS one' })
    expect(errOf(explainOk)).not.toContain('rejected by read-only guard')
    const explainBad: any = await dbQuery({ sql: 'EXPLAIN INSERT INTO Todo VALUES (1)' })
    expect(explainBad.success).toBe(false)
    expect(errOf(explainBad)).toContain('write keyword "INSERT"')
  })

  // ROUND-35 (C-5): SQLite CÓ hỗ trợ data-modifying CTE (WITH ... INSERT từ
  // 3.8.3) — comment cũ trong dev-tools tin sai "WITH luôn read-only". Phòng
  // thủ thật = deny-list chạy TRƯỚC. Test này khoá lỗ: nếu ai nới allow-list
  // hoặc đổi thứ tự lớp, WITH-INSERT phải chết ở deny keyword.
  test('ROUND-35: WITH ... INSERT/UPDATE/DELETE (data-modifying CTE) vẫn bị deny-list chặn', async () => {
    const wIns: any = await dbQuery({ sql: 'WITH x AS (SELECT 1) INSERT INTO Todo VALUES (1)' })
    expect(wIns.success).toBe(false)
    expect(errOf(wIns)).toContain('write keyword "INSERT"')

    const wUpd: any = await dbQuery({ sql: 'WITH x AS (SELECT 1) UPDATE Todo SET id = 1' })
    expect(wUpd.success).toBe(false)
    expect(errOf(wUpd)).toContain('write keyword "UPDATE"')

    const wDel: any = await dbQuery({ sql: 'WITH x AS (SELECT 1) DELETE FROM Todo' })
    expect(wDel.success).toBe(false)
    expect(errOf(wDel)).toContain('write keyword "DELETE"')
  })

  test('PRAGMA query_plan vẫn được phép qua cả 2 lớp (regression P1-a)', async () => {
    const r: any = await dbQuery({ sql: 'PRAGMA query_plan' })
    expect(errOf(r)).not.toContain('PRAGMA statements are not allowed')
    expect(errOf(r)).not.toContain('chỉ cho phép SELECT')
  })

  // ROUND-35 (C-5): LIMIT-wrap giờ detect trên SQL ĐÃ STRIP comment + wrap cả
  // WITH — bản cũ test regex trên rawSql nên `/* c */ SELECT ...` và
  // `WITH ... SELECT ...` qua guard nhưng KHÔNG được wrap → chạy không LIMIT
  // (fetch toàn bảng). Khoá bằng: chạy trên sqlite_master (luôn > 100 rows —
  // 89 bảng + index hệ thống, không phụ thuộc dữ liệu app), đếm row ≤ limit.
  test('ROUND-35: comment-prefix SELECT và WITH đều được LIMIT-wrap (không chạy unlimited)', async () => {
    // comment prefix: allow-list thấy SELECT (sau strip) → phải wrap như SELECT thường
    const c: any = await dbQuery({ sql: '/* lead comment */ SELECT * FROM sqlite_master' })
    expect(errOf(c)).not.toContain('rejected by read-only guard')
    expect(c.success).toBe(true)
    expect(Array.isArray(c.rows)).toBe(true)
    expect(c.rows.length).toBeLessThanOrEqual(100) // default limit phải được áp (bản cũ wrap=false → toàn bảng > 100)

    // WITH: qua allow-list → cũng phải được wrap
    const w: any = await dbQuery({ sql: 'WITH x AS (SELECT * FROM sqlite_master) SELECT * FROM x' })
    expect(w.success).toBe(true)
    expect(Array.isArray(w.rows)).toBe(true)
    expect(w.rows.length).toBeLessThanOrEqual(100)
  })
})
