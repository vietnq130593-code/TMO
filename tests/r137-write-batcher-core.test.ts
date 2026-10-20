/**
 * r137 — W1/S1 DB WRITE BATCHER CORE (BLUEPRINT-R17BC v0.2 · REVIEW-1 P0-1/2/3, P1-1/2/5)
 * =====================================================================================
 * User duyệt "Nâng lên đi... tiến hành triển khai blueprint ngay" 2026-10-20.
 * Kiểm chứng hợp đồng lõi của src/lib/db-write-batcher.ts:
 *   A. Type-guard RMW (P0-3): SetOp chứa increment/decrement → TypeError TẠI
 *      ENQUEUE — không vào hàng đợi; fire-and-forget không crash (lên tiếng).
 *   B. OFF-mode pass-through identical (flag đọc ĐỘNG — đổi mode trong cùng
 *      process test, preload Task 54).
 *   C. ON-mode coalesce CHỈ set-semantics: last-wins đúng hợp đồng + đếm
 *      coalescedOps (P0-3 an toàn theo hướng cho phép).
 *   D. FIFO + at-least-once qua flushNow (trigger 3 — P0-1.1).
 *   E. drainWriteQueueForExit (trigger 4 — P0-1.2): pendingLeft=0 khi DB sống.
 *   F. OFF-mode fire-and-forget fail → warn log-only (delta duy nhất — fixbug).
 *   G. Source-scan các hợp đồng không thể đo hành vi trong 1 process khỏe:
 *      bound RETAINED_MAX=2 + drop-oldest reject BatchDroppedError (P1-1),
 *      flush 2 pha per-op salvage (P0-2), holdMs autosplit (P1-5).
 * Tiền lệ: r126 (source-scan) + r128 (DB-isolated behavioral).
 */

import { test, expect, describe, beforeAll, afterAll } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { db } from '@/lib/db'
import {
  enqueueWrite,
  enqueueWriteFireAndForget,
  flushWriteQueueNow,
  drainWriteQueueForExit,
  getWriteQueueStats,
  isWriteQueueEnabled,
} from '@/lib/db-write-batcher'

const TMO = join(import.meta.dir, '..')
const read = (p: string) => readFileSync(join(TMO, p), 'utf-8')
const batcherSrc = read('src/lib/db-write-batcher.ts')

const MARK = `r137-${Date.now().toString(36)}`

describe('r137 — DB Write Batcher core (W1/S1)', () => {
  beforeAll(() => {
    // Mặc định sạch cho file khác trong cùng process (bun test chung 1 pid)
    delete process.env.DB_WRITE_QUEUE
  })
  afterAll(async () => {
    delete process.env.DB_WRITE_QUEUE
    await flushWriteQueueNow() // không để sót queue giữa các file
  })

  // ============ A. Type-guard RMW (P0-3) ============
  test('A1. SetOp chứa increment → TypeError TẠI ENQUEUE (enqueueWrite)', () => {
    expect(() =>
      enqueueWrite({
        kind: 'upsert',
        model: 'toolMetric',
        where: { id: 'x' },
        create: {},
        // update?: unknown nhận mọi payload — guard RUNTIME deep-scan mới là điểm thử (P0-3)
        update: { visits: { increment: 1 } },
      }),
    ).toThrow(TypeError)
  })

  test('A2. Deep-scan bắt RMW ở CẤP LỒNG SÂU (nested payload), không chỉ tầng đầu', () => {
    expect(() =>
      enqueueWrite({
        // data?: unknown — guard runtime mới là điểm thử (P0-3)
        kind: 'update',
        model: 'toolMetric',
        where: { id: 'x' },
        data: { meta: { counters: { tokens: { multiply: 2 } } } },
      }),
    ).toThrow(/multiply/)
  })

  test('A3. Fire-and-forget vi phạm guard → KHÔNG crash, LÊN TIẾNG (lỗi lập trình không nuốt im)', () => {
    const errs: string[] = []
    const orig = console.error
    console.error = (...a: unknown[]) => { errs.push(String(a[0])) }
    try {
      expect(() => {
        enqueueWriteFireAndForget({
          // data?: unknown — guard runtime mới là điểm thử (P0-3)
          kind: 'create', model: 'toolMetric', data: { ok: 1, n: { decrement: 3 } },
        })
      }).not.toThrow()
    } finally {
      console.error = orig
    }
    expect(errs.some(e => e.includes('RMW'))).toBe(true)
  })

  // ============ B. OFF-mode pass-through identical (đọc động) ============
  test('B1. OFF (mặc định): enqueueWrite commit NGAY (không hàng đợi) — hành vi hôm nay', async () => {
    expect(isWriteQueueEnabled()).toBe(false)
    const n0 = await db.toolMetric.count({ where: { toolName: `${MARK}-B1` } })
    await enqueueWrite({ kind: 'create', model: 'toolMetric', data: { toolName: `${MARK}-B1`, sessionId: 'r137', agentRole: 'TEST', success: true, exitCode: 0, durationMs: 1, errorTag: null } }, { label: 'r137.B1' })
    const n1 = await db.toolMetric.count({ where: { toolName: `${MARK}-B1` } })
    expect(n1 - n0).toBe(1) // commit tức thì — pass-through, không đợi flush
  })

  // ============ C. ON-mode coalesce set-only (last-wins đúng hợp đồng) ============
  test('C1. 3 upsert cùng idempotencyKey → 1 row GIÁ TRỊ CUỐI + coalescedOps=2', async () => {
    process.env.DB_WRITE_QUEUE = 'on'
    expect(isWriteQueueEnabled()).toBe(true)
    const key = `r137-c1-${Date.now().toString(36)}`
    const mk = (tokens: number) => enqueueWriteFireAndForget(
      {
        kind: 'upsert', model: 'dailyTokenUsage',
        where: { date: key }, update: { tokens }, create: { date: key, tokens },
        idempotencyKey: `dailyTokenUsage|${key}`,
      },
      { label: 'r137.C1' },
    )
    mk(11); mk(22); mk(33) // last-wins hợp lệ: SET tuyệt đối, giá trị sau đè trước
    await flushWriteQueueNow()
    const row = await db.dailyTokenUsage.findUnique({ where: { date: key } })
    expect(row?.tokens).toBe(33)
    expect(getWriteQueueStats().coalescedOps).toBeGreaterThanOrEqual(2)
    delete process.env.DB_WRITE_QUEUE
  })

  test('C2. KHÔNG khai key → KHÔNG coalesce (2 rows riêng — FIFO an toàn)', async () => {
    process.env.DB_WRITE_QUEUE = 'on'
    const sfx = Date.now().toString(36)
    enqueueWriteFireAndForget({ kind: 'create', model: 'toolMetric', data: { toolName: `${MARK}-C2a-${sfx}`, sessionId: 'r137', agentRole: 'TEST', success: true, exitCode: 0, durationMs: 1, errorTag: null } }, { label: 'r137.C2a' })
    enqueueWriteFireAndForget({ kind: 'create', model: 'toolMetric', data: { toolName: `${MARK}-C2b-${sfx}`, sessionId: 'r137', agentRole: 'TEST', success: true, exitCode: 0, durationMs: 1, errorTag: null } }, { label: 'r137.C2b' })
    await flushWriteQueueNow()
    expect(await db.toolMetric.count({ where: { toolName: { contains: `${MARK}-C2` } } })).toBe(2)
    delete process.env.DB_WRITE_QUEUE
  })

  // ============ D. at-least-once qua flushNow (trigger 3) ============
  test('D1. 25 ops → flushWriteQueueNow → 25 rows đủ, dropCount=0, waiter resolve', async () => {
    process.env.DB_WRITE_QUEUE = 'on'
    const sfx = Date.now().toString(36)
    let resolved = 0
    for (let i = 0; i < 25; i++) {
      enqueueWrite({ kind: 'create', model: 'toolMetric', data: { toolName: `${MARK}-D1-${sfx}-${i}`, sessionId: 'r137', agentRole: 'TEST', success: true, exitCode: 0, durationMs: i, errorTag: null } }, { label: `r137.D1.${i}` })
        .then(() => { resolved += 1 })
    }
    await flushWriteQueueNow()
    await new Promise(r => setTimeout(r, 30)) // để microtask waiter chạy
    expect(await db.toolMetric.count({ where: { toolName: { contains: `${MARK}-D1-${sfx}` } } })).toBe(25)
    expect(resolved).toBe(25)
    expect(getWriteQueueStats().dropCount).toBe(0)
    delete process.env.DB_WRITE_QUEUE
  })

  // ============ E. drainWriteQueueForExit (trigger 4) ============
  test('E1. drain bound: 15 ops pending → pendingLeft=0 sau drain (DB sống)', async () => {
    process.env.DB_WRITE_QUEUE = 'on'
    const sfx = Date.now().toString(36)
    for (let i = 0; i < 15; i++) {
      enqueueWriteFireAndForget({ kind: 'create', model: 'toolMetric', data: { toolName: `${MARK}-E1-${sfx}-${i}`, sessionId: 'r137', agentRole: 'TEST', success: true, exitCode: 0, durationMs: i, errorTag: null } }, { label: `r137.E1.${i}` })
    }
    const res = await drainWriteQueueForExit(2500)
    expect(res.pendingLeft).toBe(0)
    expect(await db.toolMetric.count({ where: { toolName: { contains: `${MARK}-E1-${sfx}` } } })).toBe(15)
    delete process.env.DB_WRITE_QUEUE
  })

  // ============ F. OFF-mode fire-and-forget fail → warn log-only (delta duy nhất) ============
  test('F1. P2025 (non-transient) → warn 1 dòng, KHÔNG throw, KHÔNG thêm DB write khác', async () => {
    delete process.env.DB_WRITE_QUEUE
    const warns: string[] = []
    const orig = console.warn
    console.warn = (...a: unknown[]) => { warns.push(String(a[0])) }
    try {
      enqueueWriteFireAndForget(
        { kind: 'update', model: 'toolMetric', where: { id: 'r137-khong-ton-tai-xyz' }, data: { toolName: `${MARK}-F1` } },
        { label: 'r137.F1' },
      )
      await new Promise(r => setTimeout(r, 150))
    } finally {
      console.warn = orig
    }
    expect(warns.some(w => w.includes('r137.F1') && w.includes('pass-through'))).toBe(true)
  })

  // ============ G. Source-scan — hợp đồng không thể đo hành vi trong process khỏe ============
  describe('r137 G — source-scan hợp đồng (P0-2, P1-1, P1-5)', () => {
    test('G1. Bound RETAINED_MAX=2 + drop batch CŨ nhất + MỖI op 1 debt (P0-2/P1-1)', () => {
      expect(batcherSrc).toContain('const RETAINED_MAX = 2')
      expect(batcherSrc).toContain('Drop batch cũ nhất')
      expect(batcherSrc).toContain('BatchDroppedError')
      expect(batcherSrc).toContain("state.retained.shift()")
    })
    test('G2. Flush 2 pha: pha 1 batch tx → pha 2 per-op salvage; poison → debt + loại, không chặn op lành (P0-2)', () => {
      expect(batcherSrc).toContain('salvageSplits')
      expect(batcherSrc).toContain('Poison op')
      expect(batcherSrc).toMatch(/Pha 1 fail.*→ salvage per-op/)
    })
    test('G3. holdMs autosplit halve/double (P1-5) + 8 số stats', () => {
      expect(batcherSrc).toContain('HOLD_TARGET_MS')
      expect(batcherSrc).toMatch(/Math\.max\(25, Math\.floor\(state\.chunkSize \/ 2\)\)/)
      expect(batcherSrc).toContain('poisonCount')
      expect(batcherSrc).toContain('lastHoldMs')
    })
    test('G4. Danh hiệu bền trung thực — KHÔNG tuyên crash-proof (P0-1.3)', () => {
      expect(batcherSrc).toContain('at-most-once')
      expect(batcherSrc).toContain('KHÔNG tuyên "crash-proof"')
    })
    test('G5. Retry ownership: batcher là chủ, raw fn không tự withSqliteRetry (P1-2)', () => {
      expect(batcherSrc).toContain('chủ sở hữu retry')
      // raw fn trong applyOp KHÔNG bọc withSqliteRetry
      const rawApply = batcherSrc.match(/if \(op\.kind === 'raw'\) \{\s*await op\.fn\(c\)\s*return/)
      expect(rawApply).toBeTruthy()
    })
  })
})
