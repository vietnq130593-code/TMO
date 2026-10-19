/**
 * R125 TESTS — W2 GATE KHÉP CHẶT (BLUEPRINT-BACKUP-GATE S2 coverage ratchet ·
 * S3 smoke read-only · S4 build verdict · S5 branch protection).
 *
 * Phạm vi regression (pattern r123/r124: nhóm A source-scan + nhóm B unit):
 *   A. Source-scan:
 *      - quality-gate.mjs: coverage flags bun --coverage · import coverage-ratchet ·
 *        TMO_REQUIRE_BUILD=1 (skip → FAIL) · verdict dòng "BUILD CHƯA CHẠY" ·
 *        stage smoke probe 3 lần × 2s.
 *      - tests/smoke/contract-read-only.test.ts: 0 MUTATION (không POST/PUT/
 *        PATCH/DELETE — bài học Task 54) + skipIf TMO_SMOKE_STAGE.
 *      - CI workflow: TMO_REQUIRE_BUILD '1'.
 *      - check-branch-protection.mjs: PAT redact (redactUrl) — token không in.
 *      - .gitignore: .quality-gate-coverage/ + re-include 3 script mới.
 *      - tests/coverage-baseline.json tồn tại + có pct hợp lệ (không tự trượt).
 *   B. Unit — pure logic từ scripts/coverage-ratchet.mjs (import an toàn, file
 *      tách riêng khỏi quality-gate.mjs nên KHÔNG kích hoạt gate):
 *      - parseLcovTotals: tổng LF/LH nhiều file, bỏ dòng nhiễu.
 *      - coveragePct: LF=0 → null; làm tròn 2 chữ số.
 *      - evaluateRatchet: no-baseline / no-data / FAIL tụt >1đ% / PASS tại
 *        biên −1,0đ% / PASS tăng + gợi ý nâng baseline.
 *      - readBaseline + baselineJsonContent: đọc/ghi JSON chuẩn hóa.
 */

import { describe, test, expect } from 'bun:test'
import { readFileSync, writeFileSync, mkdtempSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const read = (p: string): string => readFileSync(p, 'utf8')

// Pure logic — import từ coverage-ratchet.mjs (tách riêng để test không chạy gate)
const {
  parseLcovTotals,
  coveragePct,
  evaluateRatchet,
  readBaseline,
  baselineJsonContent,
  RATCHET_TOLERANCE_PCT,
} = await import('../scripts/coverage-ratchet.mjs')

// ==================== A. SOURCE-SCAN — gate + smoke + CI + S5 ====================

describe('R125 A1 · quality-gate.mjs — coverage ratchet + smoke + build verdict', () => {
  const gate = 'scripts/quality-gate.mjs'

  test('A1.1: stage coverage (opt-in) chạy bun --coverage + 2 reporter flag riêng (bun 1.3.14 không nhận comma)', () => {
    const src = read(gate)
    expect(src).toContain("name: 'coverage'")
    expect(src).toMatch(/default:\s*false/) // opt-in — không chạy mặc định (§8-6)
    expect(src).toContain("'--coverage'")
    expect(src).toContain("'--coverage-reporter=text'")
    expect(src).toContain("'--coverage-reporter=lcov'")
    expect(src).toMatch(/--coverage-dir=/)
    // KHÔNG IM LẶNG: summary in đường chạy chủ ý khi coverage không chạy
    expect(src).toMatch(/KHÔNG chạy lần này[\s\S]{0,250}--stage=coverage|--stage=coverage[\s\S]{0,250}KHÔNG chạy lần này/)
  })

  test('A1.1b: stage tests KHÔNG kèm coverage (giữ hành vi cũ — thí điểm +109% quá ngưỡng)', () => {
    const src = read(gate)
    // trong stage tests: args ['test'] thuần — không coverage flag
    const testsStage = src.slice(src.indexOf("name: 'tests'"), src.indexOf("name: 'coverage'"))
    expect(testsStage).toContain("args: ['test']")
    expect(testsStage).not.toContain("'--coverage'")
  })

  test('A1.2: import pure logic từ coverage-ratchet.mjs (không nhúng trong gate)', () => {
    expect(read(gate)).toContain("from './coverage-ratchet.mjs'")
  })

  test('A1.3: flags baseline chủ ý --coverage-init / --coverage-update-baseline', () => {
    const src = read(gate)
    expect(src).toContain("'--coverage-init'")
    expect(src).toContain("'--coverage-update-baseline'")
    // hạ baseline phải nhắc Bug_v2 (không tự trượt)
    expect(src).toMatch(/HẠ baseline[\s\S]{0,120}Bug_v2/)
  })

  test('A1.4: TMO_REQUIRE_BUILD=1 — skip build bị tính FAIL (S4)', () => {
    const src = read(gate)
    expect(src).toContain("TMO_REQUIRE_BUILD === '1'")
    // skip không còn vô điều kiện
    expect(src).toContain('skipBuild && !requireBuild')
  })

  test('A1.5: verdict phân biệt — dòng vàng BUILD CHƯA CHẠY + lệnh tái hiện', () => {
    const src = read(gate)
    expect(src).toContain('BUILD CHƯA CHẠY')
    expect(src).toContain('TMO_REQUIRE_BUILD=1 bun scripts/quality-gate.mjs')
    // verdict PASS đủ stage phải khác PASS có SKIP
    expect(src).toContain('PASS đủ')
  })

  test('A1.6: stage smoke — probe /api/health tối đa 3 lần × 2s, không reachable → SKIP', () => {
    const src = read(gate)
    expect(src).toContain("name: 'smoke'")
    expect(src).toMatch(/attempt <= 3/)
    expect(src).toContain('AbortSignal.timeout(2000)')
    expect(src).toContain("'app không chạy") // SKIP reason
  })

  test('A1.7: smoke stage chạy bun test testssmoke với TMO_SMOKE_STAGE=1', () => {
    const src = read(gate)
    expect(src).toContain("'test', 'tests/smoke'")
    expect(src).toContain("TMO_SMOKE_STAGE: '1'")
  })
})

describe('R125 A2 · tests/smoke — 0 mutation (bài học Task 54)', () => {
  const smokeFile = 'tests/smoke/contract-read-only.test.ts'

  test('A2.1: smoke chỉ GET — KHÔNG có method POST/PUT/PATCH/DELETE', () => {
    const src = read(smokeFile)
    expect(src).not.toContain("method: 'POST'")
    expect(src).not.toContain("method: 'PUT'")
    expect(src).not.toContain("method: 'PATCH'")
    expect(src).not.toContain("method: 'DELETE'")
    expect(src).not.toMatch(/\bfetch\([^)]*,\s*\{\s*method:/) // không override method nào
  })

  test('A2.2: skipIf TMO_SMOKE_STAGE — full suite không phụ thuộc app chạy', () => {
    const src = read(smokeFile)
    expect(src).toContain('describe.skipIf')
    expect(src).toContain("TMO_SMOKE_STAGE === '1'")
    // fetch timeout 10s/test
    expect(src).toContain('TIMEOUT_MS = 10_000')
  })

  test('A2.3: smoke assert byCollection (S1.2) + compat qdrantBackups', () => {
    const src = read(smokeFile)
    expect(src).toContain('byCollection')
    expect(src).toContain('qdrantBackups')
    expect(src).toContain('currentQdrantPointsByCollection')
  })
})

describe('R125 A3 · CI + baseline + .gitignore', () => {
  test('A3.1: CI workflow khai báo TMO_REQUIRE_BUILD 1 (belt-and-braces)', () => {
    expect(read('.github/workflows/quality-gate.yml')).toContain("TMO_REQUIRE_BUILD: '1'")
  })

  test('A3.2: baseline tests/coverage-baseline.json tồn tại + pct hợp lệ (không tự trượt)', () => {
    expect(existsSync('tests/coverage-baseline.json')).toBe(true)
    const raw = JSON.parse(read('tests/coverage-baseline.json'))
    expect(Number.isFinite(Number(raw.pct))).toBe(true)
    expect(Number(raw.pct)).toBeGreaterThan(0)
  })

  test('A3.3: .gitignore — .quality-gate-coverage/ + re-include 3 script mới (pattern BUG2-290)', () => {
    const src = read('.gitignore')
    expect(src).toContain('.quality-gate-coverage/')
    expect(src).toContain('!/scripts/backfill-documents-qdrant.ts')
    expect(src).toContain('!/scripts/coverage-ratchet.mjs')
    expect(src).toContain('!/scripts/check-branch-protection.mjs')
  })

  test('A3.4: BUG2-305 — layer8.test.ts import bun:test trực tiếp (không guard vitest TLA)', () => {
    // Bản cũ `await import('vitest').catch(() => null)` (vitest không cài) —
    // chạy thường pass nhờ global describe, nhưng --coverage instrumentation
    // làm TLA hỏng → stage coverage FAIL cả file. Guard chống regression.
    // (Assert theo PATTERN CODE — comment ghi lịch sử fix được phép nhắc vitest.)
    const src = read('src/lib/communication/__tests__/layer8.test.ts')
    expect(src).toContain("from 'bun:test'")
    expect(src).not.toContain('const vitest =') // không còn biến guard vitest
    expect(src).not.toMatch(/=\s*\(vitest\s*\|\|\s*\{\}\)/) // không còn destructure-from-null
    expect(src).not.toMatch(/\bvi\./) // vi đã bỏ khỏi destructure (không dùng)
  })
})

describe('R125 A4 · S5 check-branch-protection — PAT redact + đa remote', () => {
  const s5 = 'scripts/check-branch-protection.mjs'

  test('A4.1: có hàm redactUrl — PAT không bao giờ in ra output', () => {
    const src = read(s5)
    expect(src).toContain('function redactUrl')
    expect(src).toContain("'$1***@'") // token bị thay bằng *** ngay khi parse
  })

  test('A4.2: token chỉ dùng trong header Authorization — không đưa vào log/console', () => {
    const src = read(s5)
    expect(src).toContain('Bearer ${token}')
    // KHÔNG có console nào in token thô
    expect(src).not.toMatch(/console\.\w+\([^)]*\$\{token\}/)
    expect(src).not.toMatch(/console\.\w+\([^)]*parsed\.token/)
  })

  test('A4.3: kiểm TẤT CẢ remote push (không hardcode 1 repo — L3 review v0.2)', () => {
    const src = read(s5)
    expect(src).toContain("git remote -v")
    expect(src).toContain(`endsWith('(push)')`)
    // --strict exit 1; mặc định warn-only
    expect(src).toContain("'--strict'")
  })

  test('A4.4: kiểm cấu hình protection — required checks + enforce admins', () => {
    const src = read(s5)
    expect(src).toContain('required_status_checks')
    expect(src).toContain('enforce_admins')
    expect(src).toContain('/branches/')
  })
})

// ==================== B. UNIT — coverage-ratchet pure logic ====================

describe('R125 B1 · parseLcovTotals — tổng LF/LH', () => {
  test('tổng hợp nhiều file, bỏ dòng nhiễu', () => {
    const lcov = [
      'TN:',
      'SF:src/lib/a.ts',
      'LF:10',
      'LH:8',
      'end_of_record',
      'SF:src/lib/b.ts',
      'LF:5',
      'LH:5',
      'DA:1,1',
      'end_of_record',
    ].join('\n')
    expect(parseLcovTotals(lcov)).toEqual({ lf: 15, lh: 13 })
  })

  test('chuỗi rỗng / không có LF → 0/0 (no-data)', () => {
    expect(parseLcovTotals('')).toEqual({ lf: 0, lh: 0 })
    expect(parseLcovTotals('SF:x.ts\nDA:1,2\n')).toEqual({ lf: 0, lh: 0 })
  })

  test('LF/LH không phải số → bỏ qua không cộng (chống NaN)', () => {
    expect(parseLcovTotals('LF:abc\nLH:3\nLF:4')).toEqual({ lf: 4, lh: 3 })
  })
})

describe('R125 B2 · coveragePct', () => {
  test('LF=0 → null (không phán xét)', () => {
    expect(coveragePct({ lf: 0, lh: 0 })).toBeNull()
    expect(coveragePct({ lf: -1, lh: 0 })).toBeNull()
  })

  test('tính % làm tròn 2 chữ số', () => {
    expect(coveragePct({ lf: 200, lh: 100 })).toBe(50)
    expect(coveragePct({ lf: 300, lh: 200 })).toBe(66.67)
    expect(coveragePct({ lf: 7, lh: 7 })).toBe(100)
  })
})

describe('R125 B3 · evaluateRatchet — ratchet không bar', () => {
  test('chưa có baseline → no-baseline (không phán xét, hướng dẫn --coverage-init)', () => {
    const v = evaluateRatchet(50, null)
    expect(v.status).toBe('no-baseline')
    expect(v.message).toContain('--coverage-init')
  })

  test('current không đo được → no-data (không fail giả)', () => {
    expect(evaluateRatchet(null, 50).status).toBe('no-data')
    expect(evaluateRatchet(NaN, 50).status).toBe('no-data')
  })

  test('tụt 2đ% (> tolerance 1đ%) → FAIL (KPI §6: hạ baseline thử phải bị chặn)', () => {
    const v = evaluateRatchet(48, 50, 1.0)
    expect(v.status).toBe('fail')
    expect(v.message).toContain('Bug_v2')
  })

  test('tụt ĐÚNG 1đ% → PASS (biên tolerance — không fail giả)', () => {
    expect(evaluateRatchet(49, 50, 1.0).status).toBe('pass')
  })

  test('tụt 1.01đ% → FAIL (vượt biên)', () => {
    expect(evaluateRatchet(48.99, 50, 1.0).status).toBe('fail')
  })

  test('tăng → PASS + gợi ý nâng baseline chủ ý (không tự nâng)', () => {
    const v = evaluateRatchet(55, 50)
    expect(v.status).toBe('pass')
    expect(v.message).toContain('--coverage-update-baseline')
  })

  test('ngang baseline → PASS giữ ratchet', () => {
    expect(evaluateRatchet(50, 50).status).toBe('pass')
  })

  test('hằng số tolerance = 1.0đ%', () => {
    expect(RATCHET_TOLERANCE_PCT).toBe(1.0)
  })
})

describe('R125 B4 · readBaseline / baselineJsonContent — đọc/ghi chuẩn hóa', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'r125-baseline-'))
  const file = join(tmp, 'coverage-baseline.json')

  test('file chưa có → null; JSON hỏng → null; pct không phải số → null', () => {
    expect(readBaseline({ existsSync: () => false } as never, file)).toBeNull()
    writeFileSync(file, 'not json')
    expect(readBaseline({ existsSync: () => true, readFileSync: () => 'not json' } as never, file)).toBeNull()
    writeFileSync(file, JSON.stringify({ pct: 'abc' }))
    expect(readBaseline({ existsSync: () => true, readFileSync: () => JSON.stringify({ pct: 'abc' }) } as never, file)).toBeNull()
  })

  test('ghi → đọc lại đúng pct/lh/lf (roundtrip)', () => {
    writeFileSync(file, baselineJsonContent({ pct: 61.23, lh: 6100, lf: 9945 }))
    const b = readBaseline(
      { existsSync: () => true, readFileSync: () => readFileSync(file, 'utf8') } as never,
      file
    )
    expect(b?.pct).toBe(61.23)
    expect(b?.lh).toBe(6100)
    expect(b?.lf).toBe(9945)
    expect(typeof b?.updatedAt).toBe('string')
    // note quy tắc không tự trượt nằm trong file ("CHỈ cập nhật chủ ý")
    expect(read(file)).toContain('CHỈ cập nhật')
  })

  test('baselineJsonContent parse được JSON + có ghi giới hạn import-only', () => {
    const parsed = JSON.parse(baselineJsonContent({ pct: 50, lh: 5, lf: 10 }))
    expect(parsed.pct).toBe(50)
    expect(parsed._note).toContain('import-only')
  })
})
// (tmp dir trong os.tmpdir — OS tự dọn, không rmSync trong describe body: câu
// lệnh ngoài test() chạy NGAY khi đăng ký describe → xóa dir trước khi test chạy)
