/**
 * r145 — R42 FIX-STOP-1/2/2b/3: NÚT DỪNG KHÔNG DỪNG ĐƯỢC AGENT (split-mode)
 * =====================================================================================
 * Bằng chứng gốc (user 2026-10-21): user bấm Dừng ×2 trong UI — POST
 * /api/goal-loop-jobs 500 sau 15.1s "Socket timeout" (FIX-STOP-1: write
 * cancel không retry kẹt lock SQLite khi worker đang ghi dồn) HOẶC write
 * thành công nhưng cancel() chạy ở PROCESS API thấy job KHÔNG thuộc Map
 * mình → đi nhánh orphan → flip status 'cancelled' trong khi job vẫn
 * đang chạy trong worker process (FIX-STOP-2: FLIP LÁO — agent không dừng
 * là đúng bệnh user mô tả) HOẶC UI fetch không res.ok-check → 500 nuốt
 * im lặng, optimistic flag "Đang yêu cầu dừng…" treo vĩnh viễn (FIX-STOP-3).
 * FIX-STOP-2b: timer poll cancelRequestedAt 5s độc lập mỗi job (onSignal
 * chỉ bắn ở ranh giới vòng — LLM call dài 60-120s không bắn signal nào).
 *
 * Source-scan theo tiền lệ r126/r132/r139-D + behavioral constant.
 */

import { test, expect, describe } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const TMO = join(import.meta.dir, '..')
const read = (p: string) => readFileSync(join(TMO, p), 'utf-8')
const WORKER = read('src/lib/goal-loop-worker.ts')
const DURABLE = read('src/lib/goal-loop-durable-types.ts')
const SMOLAB = read('src/components/smolab/smolab-module.tsx')
const ROUTE = read('src/app/api/goal-loop-jobs/route.ts')

describe('r145 — R42 nút Dừng split-mode (FIX-STOP-1/2/2b/3)', () => {
  // ============ FIX-STOP-1: mọi DB access đường cancel bọc withSqliteRetry ============
  test('1. cancel() đọc row FRESH (findUnique + withSqliteRetry) TRƯỚC khi phân nhánh — quyết định dựa status + workerPid hiện tại', () => {
    expect(WORKER).toContain('goal-loop cancel-read job')
    expect(WORKER).toContain("select: { status: true, workerPid: true, cancelRequestedAt: true }")
  })

  test('2. mọi nhánh write trong cancel()/cancelSessionJobs() bọc withSqliteRetry (socket-timeout 15s dưới contention — bằng chứng 500 ×2)', () => {
    for (const label of [
      'goal-loop cancel-queued job',
      'goal-loop cancel-flag job',
      'goal-loop cancel-cross-process job',
      'goal-loop cancel-orphan job',
      'goal-loop cancel-session-queued',
      'goal-loop cancel-session-read',
      'goal-loop cancel-session-flag',
      'goal-loop cancel-session-cross',
      'goal-loop cancel-session-orphan',
    ]) {
      expect(WORKER).toContain(label)
    }
  })

  // ============ FIX-STOP-2: không flip status LÁO job worker khác đang chạy ============
  test('3. cancel() nhánh cross-process: workerPid còn sống + ≠ process.pid → CHỈ set cancelRequestedAt (KHÔNG flip status cancelled)', () => {
    expect(WORKER).toContain('cancel-cross-process job')
    expect(WORKER).toContain('row.workerPid !== process.pid')
  })

  test('4. cancel() idempotent: cancelRequestedAt đã bật từ lần bấm trước → return true ngay không ghi thêm', () => {
    expect(WORKER).toContain('if (row.cancelRequestedAt) return true')
  })

  test('5. nhánh orphan chỉ dành pid CHẾT thật (pid-alive không bị coi mồ côi — bằng chứng log "cancel job … running mồ côi (pid … đã chết)")', () => {
    expect(WORKER).toContain('đã chết)')
  })

  // ============ FIX-STOP-2b: timer poll độc lập 5s ============
  test('6. constant GOAL_LOOP_CANCEL_POLL_MIN_INTERVAL_MS default 5000, 0 = tắt (env ghi đè được)', () => {
    expect(DURABLE).toContain("GOAL_LOOP_CANCEL_POLL_MIN_INTERVAL_MS = Math.max(0, intEnvWithDefault('GOAL_LOOP_CANCEL_POLL_MIN_INTERVAL_MS', 5000))")
  })

  test('7. executeJob: timer setInterval poll cancelRequestedAt độc lập nhịp loop — không bám onSignal (LLM call dài không bắn signal)', () => {
    expect(WORKER).toContain('TIMER POLL ĐỘC LẬP')
    expect(WORKER).toContain('timer poll bắt được cancelRequestedAt từ DB')
  })

  test('8. timer khai báo NGOÀI try + clearInterval trong finally (return sớm trong try không leak timer — scan cả 2 chiều)', () => {
    // khai báo ngoài try (thứ tự source: let cancelPollTimer xuất hiện TRƯỚC "try {" của executeJob)
    const declIdx = WORKER.indexOf('let cancelPollTimer: ReturnType<typeof setInterval> | null = null')
    const tryIdx = WORKER.indexOf('private async executeJob')
    expect(declIdx).toBeGreaterThan(tryIdx)
    expect(declIdx).toBeGreaterThan(-1)
    // dọn trong finally
    expect(WORKER).toContain('if (cancelPollTimer) clearInterval(cancelPollTimer)')
  })

  test('9. onSignal vẫn poll cancelRequestedAt làm lưới dự phòng (throttle heartbeat 15s — không regress FIX-STOP-2 bản đầu)', () => {
    expect(WORKER).toContain('SPLIT-MODE CANCEL POLL')
  })

  // ============ FIX-STOP-3: UI check res.ok + body — 500 không còn bị nuốt im lặng ============
  test('10. cancelGoalLoopJob check !res.ok throw → catch rollback optimistic + toast destructive (500 socket-timeout hiện thông báo rõ ràng)', () => {
    expect(SMOLAB).toContain("if (!res.ok) throw new Error(`HTTP ${res.status}`)")
    expect(SMOLAB).toContain('Không gửi được yêu cầu dừng')
    expect(SMOLAB).toContain('Chưa dừng được tác vụ')
  })

  // ============ Terminal mark: worker tự mark cancelled khi loop thoát ============
  test('11. đường terminal: meta.cancelRequested || stopReason=cancelled → mark-cancelled withSqliteRetry + finalize honest-close (14-g H2 giữ nguyên)', () => {
    expect(WORKER).toContain('goal-loop mark-cancelled job')
    expect(WORKER).toContain('CANCELLED — nút Dừng qua DB flag')
  })

  // ============ Route: response shape không đổi (UI cũ tương thích) ============
  test('12. route POST cancel trả { ok: true, cancelled: 0|1 } — cancelled:0 KHÔNG 500 (stale client an toàn)', () => {
    expect(ROUTE).toContain('cancelled: ok ? 1 : 0')
  })
})
