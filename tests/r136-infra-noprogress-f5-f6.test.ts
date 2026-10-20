/**
 * r136 — F5 NO-PROGRESS PHÂN BIỆT CHU KỲ INFRA-ERROR + F6 MAX-ATTEMPTS (OBS P9/P7)
 * =====================================================================================
 * User duyệt fix F1-F6 theo biên bản quan sát OBSERVE-PROTOCOL-1 (FINAL)
 * 2026-10-20.
 *
 * F5 (P9): no_progress fingerprint KHÔNG phân biệt "chu kỳ rỗng do infra
 * error" (0 tool call + LLM fail — model pin bị breaker chặn: "chu kỳ 2 kết
 * thúc (error, 0 tool calls)" job Omega cmvghpzbv…kn6dj1) với "chu kỳ làm
 * việc không tiến triển" → chu kỳ infra bị ĐẾM no_progress → job bị cắt
 * no_progress khi việc còn dở. Fix: cycleInfraError bỏ qua cả tăng lẫn reset
 * noProgressCount (trung lập với detector); stall brake CI-1 GIỮ đếm (phanh
 * chống chạy vô hạn khi provider chết thật sự).
 *
 * F6 (P7): GOAL_LOOP_MAX_ATTEMPTS 2 → 5 — môi trường 153 restarts pm2 làm 2
 * job user chết "mồ côi sau crash — vượt số lần thử tối đa (2)" chỉ vì
 * attempts cạn sau 2 lần restart hạ tầng.
 * Phong cách: source-scan (tiền lệ r124-r131) + đọc .env (tiền lệ r130 B4).
 */

import { test, expect, describe } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const TMO = join(import.meta.dir, '..')
const read = (p: string) => readFileSync(join(TMO, p), 'utf-8')
const goalLoop = read('src/lib/agent-goal-loop.ts')
const durable = read('src/lib/goal-loop-durable-types.ts')

describe('r136 A — F5: fingerprint bỏ qua chu kỳ infra-error', () => {
  test('A1. cycleInfraError = LLM fail VÀ 0 tool call trong chu kỳ (đúng định nghĩa "chu kỳ rỗng")', () => {
    expect(goalLoop).toContain('const cycleInfraError = cycleHadLlmError && cycleToolEvents.length === 0')
  })

  test('A2. Fingerprint chỉ đếm khi trùng chu kỳ trước VÀ KHÔNG phải infra-error', () => {
    expect(goalLoop).toContain('if (cycle > 1 && fp === prevFingerprint && !cycleInfraError) {')
  })

  test('A3. Chu kỳ infra-error KHÔNG reset noProgressCount (trung lập — không cung cấp bằng chứng nào)', () => {
    expect(goalLoop).toContain('} else if (!cycleInfraError) {')
  })

  test('A4. prevFingerprint vẫn cập nhật mọi chu kỳ (chu kỳ làm việc kế so đúng)', () => {
    expect(goalLoop).toContain('prevFingerprint = fp')
  })

  test('A5. cycleToolEvents hoist dùng chung — stall brake CI-1 vẫn đếm infra chu kỳ (phanh vô hạn giữ nguyên)', () => {
    // chỉ MỘT khai báo (hoist) — không còn khai báo trùng ở stall brake
    const n = (goalLoop.match(/const cycleToolEvents = evidence\.filter\(e => e\.cycle === cycle && e\.kind === 'tool'\)/g) || []).length
    expect(n).toBe(1)
    expect(goalLoop).toContain('prevCycleFailureSigs')
  })

  test('A6. Stall brake ngưỡng giữ nguyên (không nới lỏng phanh chống vô hạn)', () => {
    expect(goalLoop).toContain('stallCycles >= STALL_CYCLE_LIMIT')
  })
})

describe('r136 B — F6: GOAL_LOOP_MAX_ATTEMPTS 2 → 5', () => {
  test('B1. Code default 5 (clone không .env cũng an toàn trong môi trường restart nhiều)', () => {
    expect(durable).toContain("intEnvWithDefault('GOAL_LOOP_MAX_ATTEMPTS', 5)")
  })

  test('B2. .env máy này ghi 5', () => {
    const env = readFileSync(join(TMO, '.env'), 'utf-8')
    expect(env).toMatch(/^GOAL_LOOP_MAX_ATTEMPTS=5$/m)
  })

  test('B3. .env KHÔNG còn =2 (chống drift ngược về giá trị cũ)', () => {
    const env = readFileSync(join(TMO, '.env'), 'utf-8')
    expect(env).not.toMatch(/^GOAL_LOOP_MAX_ATTEMPTS=2$/m)
  })

  test('B4. Orphan sweep logic dùng GOAL_LOOP_MAX_ATTEMPTS đúng (r126-A2.4 không hồi quy)', () => {
    const worker = read('src/lib/goal-loop-worker.ts')
    expect(worker).toContain('if (row.attempts < GOAL_LOOP_MAX_ATTEMPTS) {')
  })
})
