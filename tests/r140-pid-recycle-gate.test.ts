/**
 * r140 — DEBT-R17BC PID-RECYCLING GATE (trả nợ follow-up pilot W2 2026-10-20)
 * =====================================================================================
 * Bối cảnh: pilot W2 phát hiện pid Linux tái chế đánh lừa isWorkerPidAlive
 * (probe chết → pid 32463 được process khác tái sử dụng → orphan sweep SKIP
 * requeue nhầm → job mồ côi kẹt 'running' tới trần STALE-AGE 12h). fixbug.md
 * FB-W2 "phát hiện phụ (1)" ghi nợ follow-up — trả bằng gate phụ
 * heartbeat-staleness tại sweep:
 *   A. Helper thuần isPidRecycleSuspect — mọi nhánh quyết định (không DB).
 *   B. Source-scan wiring: sweep SKIP chỉ khi pid sống VÀ heartbeat đủ tươi;
 *      nhánh nghi tái chế rơi xuống requeue (không continue); ngưỡng mặc định
 *      = GOAL_LOOP_STALL_PREEMPT_MS (30' > trần LLM 8').
 * Tiền lệ: r126/r132/r139 (source-scan) — helper thuần không cần DB.
 */

import { test, expect, describe } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { GOAL_LOOP_STALL_PREEMPT_MS, isPidRecycleSuspect } from '@/lib/goal-loop-durable-types'

const TMO = join(import.meta.dir, '..')
const read = (p: string) => readFileSync(join(TMO, p), 'utf-8')

describe('r140 — pid-recycling gate (DEBT-R17BC)', () => {
  // ============ A. Helper thuần isPidRecycleSuspect ============
  test('A1. pid CHẾT → không nghi (đường requeue thường tự xử — gate không can thiệp)', () => {
    expect(isPidRecycleSuspect(false, 10 * 60_000)).toBe(false)
    expect(isPidRecycleSuspect(false, 11 * 60 * 60_000)).toBe(false)
  })

  test('A2. pid sống + heartbeat tươi (15s throttle / 60s / 14 phút) → TIN pid (chống double-run thật R18 gate 1 giữ nguyên)', () => {
    expect(isPidRecycleSuspect(true, 15_000)).toBe(false)
    expect(isPidRecycleSuspect(true, 60_000)).toBe(false)
    expect(isPidRecycleSuspect(true, 14 * 60_000)).toBe(false)
  })

  test('A3. pid sống + heartbeat 8 phút (trần LLM call) → vẫn TIN pid (job lành không bị requeue nhầm)', () => {
    expect(isPidRecycleSuspect(true, 8 * 60_000)).toBe(false)
  })

  test('A4. pid sống + heartbeat stale đúng ngưỡng STALL_PREEMPT → NGHI tái chế (requeue giữ checkpoint)', () => {
    expect(isPidRecycleSuspect(true, GOAL_LOOP_STALL_PREEMPT_MS)).toBe(true)
  })

  test('A5. pid sống + heartbeat stale 2x ngưỡng (case pilot: mồ côi kẹt từ phiên trước) → NGHI', () => {
    expect(isPidRecycleSuspect(true, GOAL_LOOP_STALL_PREEMPT_MS * 2)).toBe(true)
  })

  test('A6. pid sống + heartbeat chưa từng ghi (null/undefined — row legacy) → TIN pid (bảo thủ, không phạt khi thiếu tín hiệu)', () => {
    expect(isPidRecycleSuspect(true, null)).toBe(false)
    expect(isPidRecycleSuspect(true, undefined)).toBe(false)
  })

  test('A7. giá trị rác (NaN / âm do clock skew) → TIN pid (fail-safe về hành vi cũ)', () => {
    expect(isPidRecycleSuspect(true, Number.NaN)).toBe(false)
    expect(isPidRecycleSuspect(true, -5_000)).toBe(false)
  })

  test('A8. threshold tùy chỉnh hoạt động cả 2 chiều (ops siết/nới được)', () => {
    expect(isPidRecycleSuspect(true, 60_000, 30_000)).toBe(true)
    expect(isPidRecycleSuspect(true, 60_000, 120_000)).toBe(false)
  })

  test('A9. threshold ≤ 0 → TẮT gate (đồng bộ ngữ nghĩa "0 = tắt" của họ GOAL_LOOP_ preempt/starve)', () => {
    expect(isPidRecycleSuspect(true, 10 * 60 * 60_000, 0)).toBe(false)
    expect(isPidRecycleSuspect(true, 10 * 60 * 60_000, -1)).toBe(false)
  })

  // ============ B. Source-scan wiring trong sweep ============
  describe('r140 B — source-scan wiring orphan sweep', () => {
    const w = read('src/lib/goal-loop-worker.ts')
    const t = read('src/lib/goal-loop-durable-types.ts')

    test('B1. sweep tính pidAlive + pidSuspectRecycled TẠI CHỖ gate pid (heartbeatAgeMs đã có sẵn từ trước GATE 1)', () => {
      expect(w).toContain('const pidAlive = Boolean(')
      expect(w).toContain('const pidSuspectRecycled = isPidRecycleSuspect(pidAlive, heartbeatAgeMs)')
    })

    test('B2. nhánh SKIP chỉ chạy khi pid sống VÀ KHÔNG nghi tái chế (bảo vệ double-run thật giữ nguyên)', () => {
      expect(w).toContain('if (pidAlive && !pidSuspectRecycled) {')
      // dòng log skip cũ giữ nguyên semantics — không đổi hợp đồng R18 gate 1
      expect(w).toContain('còn sống (process khác đang chạy — không requeue-đè, R18 gate)')
    })

    test('B3. nhánh nghi tái chế KHÔNG continue — rơi xuống requeue giữ checkpoint (hết kẹt tới trần 12h)', () => {
      expect(w).toContain('if (pidSuspectRecycled) {')
      expect(w).toContain('pid nghi bị Linux tái chế (DEBT-R17BC) → requeue giữ checkpoint thay vì SKIP')
    })

    test('B4. helper xuất từ durable-types với ngưỡng mặc định GOAL_LOOP_STALL_PREEMPT_MS (env tune được như họ GOAL_LOOP_*)', () => {
      expect(t).toContain('export function isPidRecycleSuspect')
      expect(t).toContain('thresholdMs: number = GOAL_LOOP_STALL_PREEMPT_MS')
      // default 30' (1800000) pin tại nguồn — xa hơn trần LLM 8' theo thiết kế preempt
      expect(t).toContain("intEnvWithDefault('GOAL_LOOP_STALL_PREEMPT_MS', 1800000)")
    })

    test('B5. isWorkerPidAlive thuần pid-probe GIỮ NGUYÊN (gate nằm ở tầng quyết định, không đổi semantics probe)', () => {
      expect(w).toContain('private isWorkerPidAlive(pid: number | null | undefined): boolean')
    })
  })
})
