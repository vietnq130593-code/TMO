/**
 * r118 — EVO Q2 + Q3 + OBSERVATION (task 31-e — 2026-10-18)
 * ============================================================================
 *
 * Khép 3 finding audit vòng 31:
 *  - 31-c A.5 Q2 PARTIAL → per-candidate budget early-stop: sinh ứng viên
 *    xong RỒI bỏ chấm khi wall-clock vượt ngân sách run (shouldAbandonCandidate
 *    + buildAbandonedCandidateRow — THUẦN, đồng hồ tiêm ngoài `now`).
 *  - 31-c A.5 Q3 PARTIAL → adaptive crossover: adaptiveCrossoverRate theo độ
 *    dày corpus thắng (pastWinners) — mutation share = 1 − crossover.
 *  - 31-a kinds search.* 0 call-site → observation payload builders thuần
 *    (evo/observe.ts — kind 'search.session' phase start/end + 'search.candidate').
 *
 * THUẦN — KHÔNG query DB (import module thì được — precedent r116 import
 * evolve.ts; không gọi hàm đụng DB). H4: chuỗi SINH ứng viên không phụ thuộc
 * đồng hồ — chỉ quyết định CHẤM/BỎ CHẤM đọc now() (xem comment evolve.ts).
 */

import { describe, expect, test } from 'bun:test'
import {
  adaptiveCrossoverRate,
  adaptiveMutationRate,
  shouldAbandonCandidate,
  CROSSOVER_RATE_BASE,
  CROSSOVER_RATE_HIGH,
  CROSSOVER_RATE_MID,
  CROSSOVER_WINNERS_HIGH,
  CROSSOVER_WINNERS_MID,
  MUTATION_RATE_END,
  MUTATION_RATE_START,
} from '../src/lib/brain/evo/smart-search'
import {
  buildEvoCandidate,
  buildEvoSessionEnd,
  buildEvoSessionStart,
} from '../src/lib/brain/evo/observe'
import { buildAbandonedCandidateRow, EVO_NOTE_CANDIDATE_BUDGET_EXCEEDED } from '../src/lib/brain/evolve'
import { SEARCH_MAX_WALL_MS } from '../src/lib/brain/search-space'
import { OBS_PAYLOAD_MAX_BYTES } from '../src/lib/observation/ledger'

// ==================== Q3 — adaptiveCrossoverRate ====================

describe('r118 · Q3 adaptiveCrossoverRate — biên theo corpus thắng (§10 Q3)', () => {
  test('A biên pin: 0/7 → 0,2 · 8/23 → 0,4 · 24+ → 0,6', () => {
    expect(adaptiveCrossoverRate(0)).toBe(0.2)
    expect(adaptiveCrossoverRate(7)).toBe(0.2)
    expect(adaptiveCrossoverRate(8)).toBe(0.4)
    expect(adaptiveCrossoverRate(23)).toBe(0.4)
    expect(adaptiveCrossoverRate(24)).toBe(0.6)
    expect(adaptiveCrossoverRate(1_000)).toBe(0.6)
  })

  test('B hằng số pin + base = 1 − 0,8 (Q3 mặc định vòng đầu GIỮ NGUYÊN 80/20 của R26 — corpus trống → chuỗi sinh không đổi)', () => {
    expect(CROSSOVER_WINNERS_MID).toBe(8)
    expect(CROSSOVER_WINNERS_HIGH).toBe(24)
    expect(CROSSOVER_RATE_BASE).toBe(0.2)
    expect(CROSSOVER_RATE_MID).toBe(0.4)
    expect(CROSSOVER_RATE_HIGH).toBe(0.6)
    // mặc định vòng đầu: 80% mutation / 20% crossover (thay EVO_MUTATION_RATE 0,8 cố định)
    expect(1 - CROSSOVER_RATE_BASE).toBe(0.8)
  })

  test('C phòng thủ: âm/NaN/∞ → base 0,2 (số vô lý fail-open về mặc định "vòng đầu" an toàn)', () => {
    expect(adaptiveCrossoverRate(-5)).toBe(0.2)
    expect(adaptiveCrossoverRate(Number.NaN)).toBe(0.2)
    expect(adaptiveCrossoverRate(Number.POSITIVE_INFINITY)).toBe(0.2)
  })

  test('D bất biến PHẦN CHIA: mutation share = 1 − crossover, tổng đúng 1 ở mọi tầng; adaptiveMutationRate (STRENGTH) không đổi', () => {
    for (const w of [0, 8, 24, 500]) {
      const cr = adaptiveCrossoverRate(w)
      const mr = 1 - cr
      expect(cr + mr).toBe(1)
      expect([0.8, 0.6, 0.4]).toContain(mr)
    }
    // 2 trục độc lập: STRENGTH giữ nguyên pin r116 (0,15 → 0,06)
    expect(MUTATION_RATE_START).toBe(0.15)
    expect(MUTATION_RATE_END).toBe(0.06)
    expect(adaptiveMutationRate(0, 8)).toBeCloseTo(0.15, 10)
    expect(adaptiveMutationRate(7, 8)).toBeCloseTo(0.06, 10)
  })
})

// ==================== Q2 — shouldAbandonCandidate ====================

describe('r118 · Q2 shouldAbandonCandidate — quyết định bỏ chấm per-candidate', () => {
  test('E biên strict `>`: đúng ngân sách vẫn chấm, vượt 1ms mới bỏ', () => {
    expect(shouldAbandonCandidate(0, SEARCH_MAX_WALL_MS)).toBe(false)
    expect(shouldAbandonCandidate(SEARCH_MAX_WALL_MS, SEARCH_MAX_WALL_MS)).toBe(false)
    expect(shouldAbandonCandidate(SEARCH_MAX_WALL_MS + 1, SEARCH_MAX_WALL_MS)).toBe(true)
    expect(shouldAbandonCandidate(10 * SEARCH_MAX_WALL_MS, SEARCH_MAX_WALL_MS)).toBe(true)
  })

  test('F fail-safe an toàn: elapsed NaN/âm → KHÔNG bỏ chấm (tiếp tục bình thường); ∞ → bỏ; budget 0 + elapsed 1 → bỏ', () => {
    expect(shouldAbandonCandidate(Number.NaN, SEARCH_MAX_WALL_MS)).toBe(false)
    expect(shouldAbandonCandidate(-1, SEARCH_MAX_WALL_MS)).toBe(false)
    expect(shouldAbandonCandidate(Number.POSITIVE_INFINITY, SEARCH_MAX_WALL_MS)).toBe(true)
    expect(shouldAbandonCandidate(1, 0)).toBe(true)
    expect(shouldAbandonCandidate(0, 0)).toBe(false)
  })

  test('G ngân sách wired = H3 run budget (SEARCH_MAX_WALL_MS 10 phút — helper được gọi với đúng ngân sách run)', () => {
    expect(SEARCH_MAX_WALL_MS).toBe(600_000)
  })

  test('H kịch bản FAKE CLOCK (tiêm `now` như evolve.ts): ứng viên 100s/cái → 6 ứng viên chấm, ứng viên #6 bỏ chấm, vòng DỪNG ở đó', () => {
    let clock = 1_700_000_000_000 // mốc giả — không dùng Date.now thật
    const startedAtMs = clock
    const perCandidateMs = 100_000
    const processed: Array<{ idx: number; abandoned: boolean }> = []
    for (let i = 0; i < 8; i++) {
      clock += perCandidateMs // train/score của ứng viên i tốn 100s (đồng hồ giả)
      const abandoned = shouldAbandonCandidate(clock - startedAtMs, SEARCH_MAX_WALL_MS)
      processed.push({ idx: i, abandoned })
      if (abandoned) break // evolve.ts dừng ngay sau ứng viên bỏ chấm ĐẦU TIÊN
    }
    // 6×100s = 600s không vượt (strict >); 700s mới vượt
    expect(processed).toEqual([
      { idx: 0, abandoned: false },
      { idx: 1, abandoned: false },
      { idx: 2, abandoned: false },
      { idx: 3, abandoned: false },
      { idx: 4, abandoned: false },
      { idx: 5, abandoned: false },
      { idx: 6, abandoned: true },
    ])
    expect(processed.length).toBe(7) // #7 không được sinh — vòng đã dừng
  })
})

// ==================== Q2 — buildAbandonedCandidateRow ====================

describe('r118 · Q2 buildAbandonedCandidateRow — hàng ứng viên bỏ chấm (honest)', () => {
  const row = buildAbandonedCandidateRow({
    idx: 6,
    encoding: [0.1, 0.2, 0.3],
    archSummary: 'MLP[16] (thuần MLP)',
    spec: { head: { hidden: [] } },
    elapsedMs: 700_123,
    budgetMs: SEARCH_MAX_WALL_MS,
  })

  test('I shape contract §5.7: mọi trường số 0, cờ false, abandoned true, encoding/spec/idx nguyên vẹn (UI không đổi)', () => {
    expect(row.idx).toBe(6)
    expect(row.archSummary).toBe('MLP[16] (thuần MLP)') // decode rẻ vẫn chạy — arch trung thực
    expect(row.cvScore).toBe(0) // schema Float non-null → 0 + note (KHÔNG phải điểm thật)
    expect(row.ciLow).toBe(0)
    expect(row.ciHigh).toBe(0)
    expect(row.params).toBe(0)
    expect(row.trainMs).toBe(0)
    expect(row.p95LatencyMs).toBe(0)
    expect(row.beatActive).toBe(false)
    expect(row.blockedH7).toBe(false)
    expect(row.moeSkipped).toBe(false)
    expect(row.abandoned).toBe(true)
    expect(row.encoding).toEqual([0.1, 0.2, 0.3])
    expect(row.spec).toEqual({ head: { hidden: [] } })
  })

  test('J note trung thực: tiền tố pin candidate_budget_exceeded + nêu elapsed/trần + cvScore 0 không phải điểm thật', () => {
    expect(EVO_NOTE_CANDIDATE_BUDGET_EXCEEDED).toBe('candidate_budget_exceeded')
    expect(row.note).toBeDefined()
    expect(row.note!.startsWith(EVO_NOTE_CANDIDATE_BUDGET_EXCEEDED)).toBe(true)
    expect(row.note!).toContain('700s') // elapsed đã làm tròn giây
    expect(row.note!).toContain('10 phút') // trần ngân sách H3
    expect(row.note!).toContain('KHÔNG phải điểm thật')
  })

  test('K thuần + tất định: cùng input → cùng row bit-đối-bit (H4 — không đọc đồng hồ bên trong)', () => {
    const again = buildAbandonedCandidateRow({
      idx: 6,
      encoding: [0.1, 0.2, 0.3],
      archSummary: 'MLP[16] (thuần MLP)',
      spec: { head: { hidden: [] } },
      elapsedMs: 700_123,
      budgetMs: SEARCH_MAX_WALL_MS,
    })
    expect(again).toEqual(row)
  })
})

// ==================== OBSERVATION — payload builders (HyperNAS §9) ====================

describe('r118 · observation builders — search.session / search.candidate (kinds.ts §C.2)', () => {
  test('L session START: payload phase/brain/runId/nCandidates/seed/budgetMs + summary 1 dòng có não + seed + ngân sách', () => {
    const evt = buildEvoSessionStart({
      brain: 'policy',
      runId: 'evo_test_123',
      nCandidates: 8,
      seed: 2026,
      budgetMs: SEARCH_MAX_WALL_MS,
    })
    expect(evt.payload).toEqual({
      phase: 'start',
      brain: 'policy',
      runId: 'evo_test_123',
      nCandidates: 8,
      seed: 2026,
      budgetMs: 600_000,
    })
    expect(evt.summary).not.toContain('\n')
    expect(evt.summary).toContain('policy')
    expect(evt.summary).toContain('2026')
    expect(evt.summary).toContain('10 phút')
  })

  test('M candidate ĐÃ CHẤM: cvScore number, abandoned false, KHÔNG có key note khi không có note; summary có #idx + CV', () => {
    const evt = buildEvoCandidate({
      brain: 'surrogate',
      runId: 'evo_test_123',
      idx: 2,
      archSummary: '[attn1h·128]→MLP[206,1]',
      cvScore: 0.4712,
      beatActive: true,
      blockedH7: false,
      moeSkipped: false,
      abandoned: false,
      params: 191_000,
      p95LatencyMs: 0.28,
    })
    expect(evt.payload.cvScore).toBe(0.4712)
    expect(evt.payload.abandoned).toBe(false)
    expect(evt.payload.params).toBe(191_000)
    expect('note' in evt.payload).toBe(false) // key vắng hoàn toàn (không undefined lơ lửng)
    expect(evt.summary).toContain('#2')
    expect(evt.summary).toContain('0.471')
    expect(evt.summary).toContain('thắng active')
    expect(evt.summary).not.toContain('\n')
  })

  test('N candidate BỎ CHẤM Q2 / LỖI CHẤM: cvScore null + note + summary nói rõ; KHÔNG giả điểm', () => {
    const abandoned = buildEvoCandidate({
      brain: 'policy',
      runId: 'evo_test_123',
      idx: 6,
      archSummary: 'MLP[12] (thuần MLP)',
      cvScore: null,
      beatActive: false,
      blockedH7: false,
      moeSkipped: false,
      abandoned: true,
      params: null,
      p95LatencyMs: null,
      note: 'candidate_budget_exceeded — bỏ chấm theo ngân sách H3/Q2',
    })
    expect(abandoned.payload.cvScore).toBe(null)
    expect(abandoned.payload.abandoned).toBe(true)
    expect(abandoned.payload.params).toBe(null)
    expect(abandoned.payload.note).toContain(EVO_NOTE_CANDIDATE_BUDGET_EXCEEDED)
    expect(abandoned.summary).toContain('BỎ CHẤM')

    const scoreError = buildEvoCandidate({
      brain: 'policy',
      runId: 'evo_test_123',
      idx: 3,
      archSummary: '(lỗi decode/score)',
      cvScore: null,
      beatActive: false,
      blockedH7: false,
      moeSkipped: false,
      abandoned: false,
      params: null,
      p95LatencyMs: null,
      note: 'score_error: vector rác',
    })
    expect(scoreError.payload.cvScore).toBe(null)
    expect(scoreError.summary).toContain('lỗi chấm')
  })

  test('O session END (reuse kind search.session + field phase — convention observeBrainTrain): đủ trạng thái + note tùy chọn', () => {
    const done = buildEvoSessionEnd({
      brain: 'policy',
      runId: 'evo_test_123',
      status: 'done',
      candidatesMax: 8,
      nScored: 7,
      nAbandoned: 1,
      bestCandidateIdx: 3,
      nBeatActive: 2,
      nBlockedH7: 1,
      durationMs: 701_234,
      note: 'budget_exceeded — dừng sớm theo H3',
    })
    expect(done.payload.phase).toBe('end')
    expect(done.payload.status).toBe('done')
    expect(done.payload.nScored).toBe(7)
    expect(done.payload.nAbandoned).toBe(1)
    expect(done.payload.bestCandidateIdx).toBe(3)
    expect(done.payload.note).toContain('budget_exceeded')
    expect(done.summary).toContain('7/8')
    expect(done.summary).toContain('1 bỏ (Q2)')
    expect(done.summary).toContain('xong')

    // note tùy chọn — KHÔNG có key khi không truyền
    const cancelled = buildEvoSessionEnd({
      brain: 'policy',
      runId: 'evo_test_123',
      status: 'cancelled',
      candidatesMax: 8,
      nScored: 3,
      nAbandoned: 0,
      bestCandidateIdx: null,
      nBeatActive: 0,
      nBlockedH7: 0,
      durationMs: 45_000,
    })
    expect('note' in cancelled.payload).toBe(false)
    expect(cancelled.summary).toContain('đã dừng')
    expect(cancelled.summary).not.toContain('bỏ (Q2)')
  })

  test('P hợp đồng 4KB ledger: mọi payload thực tế (kể cả note dài) < OBS_PAYLOAD_MAX_BYTES — không rơi vào truncate', () => {
    const longNote =
      'candidate_budget_exceeded — bỏ chấm theo ngân sách H3/Q2: elapsed 700s vượt trần 10 phút trước khi train; cvScore 0 KHÔNG phải điểm thật'
    const payloads = [
      buildEvoSessionStart({ brain: 'calibration_v3', runId: 'evo_x', nCandidates: 24, seed: 2_147_483_647, budgetMs: SEARCH_MAX_WALL_MS }).payload,
      buildEvoCandidate({
        brain: 'surrogate',
        runId: 'evo_x',
        idx: 23,
        archSummary: '[attn1h·128]→[ssm·16·N8]→[gated·0.9]→[mlp·×3]→MLP[206,1] (thuần MLP phần đầu)',
        cvScore: null,
        beatActive: false,
        blockedH7: false,
        moeSkipped: true,
        abandoned: true,
        params: null,
        p95LatencyMs: null,
        note: longNote,
      }).payload,
      buildEvoSessionEnd({
        brain: 'policy',
        runId: 'evo_x',
        status: 'done',
        candidatesMax: 24,
        nScored: 23,
        nAbandoned: 1,
        bestCandidateIdx: 17,
        nBeatActive: 9,
        nBlockedH7: 2,
        durationMs: 599_999,
        note: longNote,
      }).payload,
    ]
    for (const p of payloads) {
      const bytes = Buffer.byteLength(JSON.stringify(p), 'utf8')
      expect(bytes).toBeLessThan(OBS_PAYLOAD_MAX_BYTES)
    }
  })
})
