/**
 * r143 — N3 PRE-CHECK EXPLICIT-PIN MODEL (trả nợ OBS-2 2026-10-21 — user duyệt)
 * =====================================================================================
 * GỐC RỂ (OBSERVE-PROTOCOL-2 N3 · G·P1): model pin explicit của job
 * (glm-5.3-flash) stall 300s MỖI CỬA SỔ BREAKER MỚI — sau khi breaker 10'
 * hết hạn, call kế phải stall 150-300s ĐỦ strike (2) mới trip lại → 3 cửa sổ
 * = 15' ĐỐT TRẮNG. F2 ladder chỉ cứu SAU stall; N3 pre-check TRƯỚC KHI call:
 * breaker mở / timeout-strike còn nóng (cửa sổ 30') / Q-history học-là-hỏng
 * (≥2 lượt, Q ≤ -0.15) → goal-loop BỎ QUA attempt model pin, ladder ngay.
 *
 *   A. decideExplicitModelPreSkip THUẦN — đủ mọi nhánh (breaker > strikes >
 *      q-history > ok; strike ngoài cửa sổ = ok; Q thiếu lượt/Q tốt = ok).
 *   B. getExplicitModelHealth HÀNH VI — đọc đúng 2 map globalThis (breaker +
 *      strikes) mà llm.ts dùng chung (tiền lệ breaker state Task 20).
 *   C. Source-scan wiring — 4 call-site goal-loop (main call / evaluator
 *      S3.2 / final-report S3.3 / CTO consult) + KHÔNG đụng đường chat user.
 * Tiền lệ: r132-r141 (helper thuần + source-scan).
 */

import { test, expect, describe, beforeAll, afterAll } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  getExplicitModelHealth,
  decideExplicitModelPreSkip,
  EXPLICIT_PRECHECK_Q_MIN_VISITS,
  EXPLICIT_PRECHECK_Q_MAX_Q,
} from '@/lib/llm'

const TMO = join(import.meta.dir, '..')
const read = (p: string) => readFileSync(join(TMO, p), 'utf-8')

// ── B fixtures: thao tác TRỰC TIẾP 2 map globalThis (cùng object module llm.ts giữ) ──
type BreakerMap = Map<string, { blockedUntil: number; reason: string; detectedAt: number }>
type StrikeMap = Map<string, number>
const g = globalThis as unknown as {
  __tmoModelBlockBreakers?: BreakerMap
  __tmoModelTimeoutStrikes?: StrikeMap
  __tmoModelTimeoutLastAt?: StrikeMap
}
const TEST_MODEL = 'nvidia/test-n3-precheck-model'
const NOW = Date.now()

describe('r143 — N3 pre-check explicit-pin model (OBS-2)', () => {
  describe('A. decideExplicitModelPreSkip (thuần)', () => {
    const baseHealth = {
      model: TEST_MODEL,
      breakerBlocked: false,
      timeoutStrikes: 0,
      lastTimeoutAt: null as number | null,
      strikeWindowMs: 30 * 60_000,
    }

    test('A1: breaker đang mở → skip, source breaker', () => {
      const d = decideExplicitModelPreSkip(
        { ...baseHealth, breakerBlocked: true, breakerRemainingMs: 123_000, breakerReason: 'TIMEOUT-BREAKER test' },
        null,
        NOW,
      )
      expect(d.skip).toBe(true)
      expect(d.source).toBe('breaker')
      expect(d.reason).toContain('circuit breaker')
    })

    test('A2: 1 timeout-strike CÒN NÓNG (trong cửa sổ 30\') → skip, source strikes', () => {
      const d = decideExplicitModelPreSkip(
        { ...baseHealth, timeoutStrikes: 1, lastTimeoutAt: NOW - 60_000 },
        null,
        NOW,
      )
      expect(d.skip).toBe(true)
      expect(d.source).toBe('strikes')
      expect(d.reason).toContain('timeout-strike')
    })

    test('A3: strike NGOÀI cửa sổ (31\' cũ) → OK cho thử lại (model có thể đã hồi)', () => {
      const d = decideExplicitModelPreSkip(
        { ...baseHealth, timeoutStrikes: 5, lastTimeoutAt: NOW - 31 * 60_000 },
        null,
        NOW,
      )
      expect(d.skip).toBe(false)
      expect(d.source).toBe('ok')
    })

    test('A4: strikes ≥1 nhưng lastTimeoutAt null (dữ liệu nửa vời) → OK (fail-open không skip oan)', () => {
      const d = decideExplicitModelPreSkip(
        { ...baseHealth, timeoutStrikes: 2, lastTimeoutAt: null },
        null,
        NOW,
      )
      expect(d.skip).toBe(false)
    })

    test('A5: Q-history xấu (đủ lượt + Q ≤ ngưỡng) → skip, source q-history', () => {
      const d = decideExplicitModelPreSkip(
        baseHealth,
        { q: EXPLICIT_PRECHECK_Q_MAX_Q, visits: EXPLICIT_PRECHECK_Q_MIN_VISITS },
        NOW,
      )
      expect(d.skip).toBe(true)
      expect(d.source).toBe('q-history')
    })

    test('A6: Q xấu nhưng CHƯA đủ lượt (1 visit) → OK (mẫu chưa đại diện)', () => {
      const d = decideExplicitModelPreSkip(baseHealth, { q: -0.9, visits: 1 }, NOW)
      expect(d.skip).toBe(false)
      expect(d.source).toBe('ok')
    })

    test('A7: Q đủ lượt nhưng TỐT (dương) → OK', () => {
      const d = decideExplicitModelPreSkip(baseHealth, { q: 0.25, visits: 5 }, NOW)
      expect(d.skip).toBe(false)
    })

    test('A8: Q null (chưa có dữ liệu / lookup fail-open) + không breaker/strike → OK', () => {
      const d = decideExplicitModelPreSkip(baseHealth, null, NOW)
      expect(d.skip).toBe(false)
    })

    test('A9: ưu tiên breaker > strikes > q-history (đủ cả 3 → breaker)', () => {
      const d = decideExplicitModelPreSkip(
        { ...baseHealth, breakerBlocked: true, breakerRemainingMs: 60_000, timeoutStrikes: 2, lastTimeoutAt: NOW },
        { q: -0.9, visits: 9 },
        NOW,
      )
      expect(d.source).toBe('breaker')
    })

    test('A10: ngưỡng pin công khai — 2 lượt / Q -0.15 (đối xứng mềm của reward -1)', () => {
      expect(EXPLICIT_PRECHECK_Q_MIN_VISITS).toBe(2)
      expect(EXPLICIT_PRECHECK_Q_MAX_Q).toBe(-0.15)
    })
  })

  describe('B. getExplicitModelHealth (đọc map globalThis — hành vi)', () => {
    beforeAll(() => {
      if (!g.__tmoModelBlockBreakers) g.__tmoModelBlockBreakers = new Map()
      if (!g.__tmoModelTimeoutStrikes) g.__tmoModelTimeoutStrikes = new Map()
      if (!g.__tmoModelTimeoutLastAt) g.__tmoModelTimeoutLastAt = new Map()
    })
    afterAll(() => {
      // Dọn sạch — không để fixture model ảnh hưởng test khác trong cùng process
      g.__tmoModelBlockBreakers!.delete(TEST_MODEL)
      g.__tmoModelTimeoutStrikes!.delete(TEST_MODEL)
      g.__tmoModelTimeoutLastAt!.delete(TEST_MODEL)
    })

    test('B1: model sạch → breakerBlocked false, 0 strikes, strikeWindowMs > 0', () => {
      g.__tmoModelBlockBreakers!.delete(TEST_MODEL)
      g.__tmoModelTimeoutStrikes!.delete(TEST_MODEL)
      g.__tmoModelTimeoutLastAt!.delete(TEST_MODEL)
      const h = getExplicitModelHealth(TEST_MODEL)
      expect(h.model).toBe(TEST_MODEL)
      expect(h.breakerBlocked).toBe(false)
      expect(h.timeoutStrikes).toBe(0)
      expect(h.lastTimeoutAt).toBeNull()
      expect(h.strikeWindowMs).toBeGreaterThan(0)
    })

    test('B2: breaker set trong map → blocked true + remaining giảm dần theo now', () => {
      g.__tmoModelBlockBreakers!.set(TEST_MODEL, {
        blockedUntil: Date.now() + 500_000,
        reason: 'r143 test breaker',
        detectedAt: Date.now(),
      })
      try {
        const h = getExplicitModelHealth(TEST_MODEL)
        expect(h.breakerBlocked).toBe(true)
        expect(h.breakerRemainingMs).toBeGreaterThan(400_000)
        expect(h.breakerRemainingMs).toBeLessThanOrEqual(500_000)
        expect(h.breakerReason).toBe('r143 test breaker')
        // Kết hợp decision — đúng chuỗi N3 end-to-end từ state thật
        const d = decideExplicitModelPreSkip(h, null)
        expect(d.skip).toBe(true)
        expect(d.source).toBe('breaker')
      } finally {
        g.__tmoModelBlockBreakers!.delete(TEST_MODEL)
      }
    })

    test('B3: breaker EXPIRED trong map → blocked false (tự coi như đóng)', () => {
      g.__tmoModelBlockBreakers!.set(TEST_MODEL, {
        blockedUntil: Date.now() - 1_000,
        reason: 'expired',
        detectedAt: Date.now() - 700_000,
      })
      try {
        const h = getExplicitModelHealth(TEST_MODEL)
        expect(h.breakerBlocked).toBe(false)
      } finally {
        g.__tmoModelBlockBreakers!.delete(TEST_MODEL)
      }
    })

    test('B4: strikes + lastAt nóng → health phản ánh + decision skip nguồn strikes', () => {
      g.__tmoModelBlockBreakers!.delete(TEST_MODEL)
      g.__tmoModelTimeoutStrikes!.set(TEST_MODEL, 1)
      g.__tmoModelTimeoutLastAt!.set(TEST_MODEL, Date.now() - 30_000)
      try {
        const h = getExplicitModelHealth(TEST_MODEL)
        expect(h.timeoutStrikes).toBe(1)
        expect(h.lastTimeoutAt).not.toBeNull()
        const d = decideExplicitModelPreSkip(h, null)
        expect(d.skip).toBe(true)
        expect(d.source).toBe('strikes')
      } finally {
        g.__tmoModelTimeoutStrikes!.delete(TEST_MODEL)
        g.__tmoModelTimeoutLastAt!.delete(TEST_MODEL)
      }
    })
  })

  describe('C. Source-scan wiring — 4 call-site goal-loop, KHÔNG đụng chat user', () => {
    test('C1: agent-goal-loop có helper preCheckExplicitPinnedModel + wiring đủ 4 site', () => {
      const src = read('src/lib/agent-goal-loop.ts')
      expect(src).toContain('async function preCheckExplicitPinnedModel')
      const sites = src.match(/preCheckExplicitPinnedModel\(/g) ?? []
      // 1 định nghĩa + ≥4 call-site (main-call / evaluator / final-report / CTO consult)
      expect(sites.length).toBeGreaterThanOrEqual(5)
      // Log trung thực N3 ở từng site
      expect(src).toContain('N3 pre-check')
    })

    test('C2: main-call wiring — skip → ladder phục vụ trực tiếp (mirror F2 comment)', () => {
      const src = read('src/lib/agent-goal-loop.ts')
      expect(src).toContain('main-call N3 pre-check')
      expect(src).toMatch(/n3Pre\.skip[\s\S]{0,450}attemptMainCall\('nvidia', mainCallLadderModel\)/)
    })

    test('C3: llm.ts export đủ bộ N3 (health getter + decision thuần + ngưỡng)', () => {
      const src = read('src/lib/llm.ts')
      expect(src).toContain('export function getExplicitModelHealth')
      expect(src).toContain('export function decideExplicitModelPreSkip')
      expect(src).toContain('export const EXPLICIT_PRECHECK_Q_MIN_VISITS')
      expect(src).toContain('export const EXPLICIT_PRECHECK_Q_MAX_Q')
    })

    test('C4: KHÔNG đụng đường chat user chọn model tay (R19 — indicator honesty tuyệt đối)', () => {
      // openclaw/chat route KHÔNG được gọi pre-check — user muốn lỗi rõ để tự chọn
      const chatRoute = read('src/app/api/openclaw/chat/route.ts')
      expect(chatRoute).not.toContain('preCheckExplicitPinnedModel')
      expect(chatRoute).not.toContain('decideExplicitModelPreSkip')
    })
  })
})
