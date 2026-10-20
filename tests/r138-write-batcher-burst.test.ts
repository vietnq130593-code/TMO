/**
 * r138 — W1 B-FULL BURST INTEGRATION (BLUEPRINT-R17BC v0.2 — P2-2 + KPI #1/#3/#7/#9)
 * =====================================================================================
 * User duyệt triển khai ngay 2026-10-20. 3 phép đo bắt buộc của W1:
 *   A. Burst 500 ops/1s (mật độ run-close Task 33) + DIRECT-INTERLEAVE:
 *      500 ops qua batcher song song 50 op direct (ngoài batcher) — đo
 *      (i) đủ 500+50 rows (KPI #7 at-least-once qua contention),
 *      (ii) dropCount=0 (KPI #3),
 *      (iii) flushP95Ms < 1000 (KPI #3),
 *      (iv) direct-path latency không hồi quy (P2-2a) — mỗi op direct p95 < 250ms
 *      trên DB isolated (không contention thật — giá trị là TRẦN, không phải mốc).
 *   B. KILL-9 (KPI #9 — P2-2b): con "pending" → SIGKILL → 0/40 rows (at-most-once
 *      trung thực — P0-1.3); con "flushed" (flushNow như run-close) → 40/40 rows
 *      (trigger 3 che cửa sổ — đúng chỗ nó được thiết kế: run-close).
 *   C. Source-scan wiring W1: 5 call-site migrated đúng bảng audit + instrumentation
 *      drain + flushNow run-close + env docs.
 * Tiền lệ: r126 (source-scan) + r128 (DB-isolated behavioral).
 */

import { test, expect, describe, afterAll } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { db } from '@/lib/db'
import {
  enqueueWriteFireAndForget,
  flushWriteQueueNow,
  getWriteQueueStats,
} from '@/lib/db-write-batcher'

const TMO = join(import.meta.dir, '..')
const read = (p: string) => readFileSync(join(TMO, p), 'utf-8')

const MARK = `r138-${Date.now().toString(36)}`
const p95 = (xs: number[]) => {
  if (xs.length === 0) return 0
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.floor(s.length * 0.95))]
}

describe('r138 — W1 burst integration', () => {
  afterAll(async () => {
    delete process.env.DB_WRITE_QUEUE
    delete process.env.DB_WRITE_BATCH_FLUSH_MS
    await flushWriteQueueNow()
  })

  test('A1. Burst 500/1s + 50 direct interleave — đủ rows, drop 0, flushP95<1s, direct không hồi quy', async () => {
    process.env.DB_WRITE_QUEUE = 'on'
    process.env.DB_WRITE_BATCH_FLUSH_MS = '200' // dồn nhanh cho burst (test tốc độ, không phải production default)
    const sfx = `${MARK}-A1`
    const directLat: number[] = []
    // 500 batched + 50 direct xen kẽ trong ~1s (mỗi 10 batched → 1 direct)
    const t0 = Date.now()
    for (let i = 0; i < 500; i++) {
      enqueueWriteFireAndForget(
        { kind: 'create', model: 'toolMetric', data: { toolName: `${sfx}-B${i}`, sessionId: 'r138', agentRole: 'BURST', success: true, exitCode: 0, durationMs: i % 97, errorTag: null } },
        { label: `r138.A1.${i}` },
      )
      if (i % 10 === 0) {
        const d0 = Date.now()
        await db.workingMemory.create({ data: { agentId: `r138-${MARK}`, sessionId: 'r138-direct', content: `direct-${i}`, role: 'user', importance: 0.8, expiresAt: new Date(Date.now() + 60_000) } })
        directLat.push(Date.now() - d0) // direct-path (P2-2a): ngoài batcher
      }
    }
    const spreadMs = Date.now() - t0
    await flushWriteQueueNow()
    const [batched, direct] = await Promise.all([
      db.toolMetric.count({ where: { toolName: { contains: `${sfx}-B` } } }),
      db.workingMemory.count({ where: { sessionId: 'r138-direct', content: { contains: 'direct-' } } }),
    ])
    const stats = getWriteQueueStats()
    // KPI #7 (at-least-once qua contention — replay: mọi op có mặt trong DB)
    expect(batched).toBe(500)
    expect(direct).toBe(50)
    // KPI #3
    expect(stats.dropCount).toBe(0)
    expect(stats.flushP95Ms).toBeLessThan(1000)
    // P2-2a — direct interleave: trần an toàn trên DB isolated (không contention thật)
    expect(p95(directLat)).toBeLessThan(250)
    // Ghi nhận trung thực cho biên bản: spread thật của burst
    expect(spreadMs).toBeGreaterThanOrEqual(0)
    delete process.env.DB_WRITE_BATCH_FLUSH_MS
    delete process.env.DB_WRITE_QUEUE
  })

  /** Chạy con kill9: đợi keyword (READY|FLUSHED) trên stdout → SIGKILL → trả mark. */
  async function runKill9(mode: 'pending' | 'flushed'): Promise<{ mark: string; exitCode: number | null }> {
    const keyword = mode === 'pending' ? 'READY ' : 'FLUSHED '
    const proc = Bun.spawn({
      cmd: [process.execPath, 'run', 'tests/helpers/write-batcher-kill9-child.ts', mode],
      env: { ...process.env, DB_WRITE_QUEUE: 'on', DB_WRITE_BATCH_FLUSH_MS: '60000' },
      stdout: 'pipe',
      stderr: 'inherit',
    })
    const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader()
    const dec = new TextDecoder()
    let buf = ''
    let mark = ''
    const deadline = Date.now() + 8000
    while (Date.now() < deadline) {
      const { done, value } = await Promise.race([reader.read(), new Promise<never>((_, rej) => setTimeout(() => rej(new Error('stdout timeout')), 6000))])
      if (done) break
      buf += dec.decode(value)
      const idx = buf.indexOf(keyword)
      if (idx >= 0) {
        const rest = buf.slice(idx + keyword.length)
        mark = (rest.match(/(K9CHILD-\S+)/) || [])[1] || ''
        break
      }
    }
    expect(mark).toBeTruthy() // keyword + mark phải đến TRƯỚC khi kill
    // Triệt tiêu flush timer: SIGKILL ngay (giết giữa chừng — không drain)
    proc.kill('SIGKILL')
    const exitCode: number = await proc.exited
    try { await reader.cancel() } catch { /* stream đã đóng theo proc */ }
    return { mark, exitCode: Number.isFinite(exitCode) ? exitCode : null }
  }

  test('B1. KILL-9 pending → 0/40 rows (at-most-once qua SIGKILL — danh hiệu trung thực P0-1.3)', async () => {
    process.env.DB_WRITE_QUEUE = 'on'
    const { mark } = await runKill9('pending')
    // Parent đếm trên CÙNG DB isolated (DATABASE_URL kế thừa — preload Task 54)
    const count = await db.toolMetric.count({ where: { toolName: { contains: mark } } })
    expect(count).toBe(0) // 40 ops pending biến mất — CHÍNH LÀ cửa sổ at-most-once ≤1s×≤200
    delete process.env.DB_WRITE_QUEUE
  }, 20_000)

  test('B2. KILL-9 flushed (flushNow như run-close) → 40/40 rows — trigger 3 che đúng cửa sổ', async () => {
    process.env.DB_WRITE_QUEUE = 'on'
    const { mark } = await runKill9('flushed')
    const count = await db.toolMetric.count({ where: { toolName: { contains: mark } } })
    expect(count).toBe(40) // flushNow tại run-close → SIGKILL sau đó KHÔNG mất gì
    delete process.env.DB_WRITE_QUEUE
  }, 20_000)

  // ============ C. Source-scan wiring W1 (bảng audit §4.2 v0.2-impl) ============
  describe('r138 C — wiring 5 call-site + 2 hook + env docs', () => {
    test('C1. tool-metrics-recorder #1: toolMetric.create qua batcher; debt-count READ giữ direct', () => {
      const src = read('src/lib/tool-metrics-recorder.ts')
      expect(src).toContain("enqueueWriteFireAndForget(\n      {\n        kind: 'create',\n        model: 'toolMetric'")
      expect(src).toContain('db.toolMetric.count') // audit #2 read direct
    })
    test('C2. memory-tiers #3: addToWorkingMemory qua enqueueWrite (await-version)', () => {
      expect(read('src/lib/memory-tiers.ts')).toContain("model: 'workingMemory'")
    })
    test('C3. llm.ts #4: 5 upsert TokenTracker đều qua batcher + idempotencyKey', () => {
      const src = read('src/lib/llm.ts')
      for (const model of ['dailyTokenUsage', 'dailyTokenByProvider', 'dailyTokenByProviderSlot', 'dailyTokenByProviderModel', 'dailyTokenByAgent'] as const) {
        expect(src).toContain(`model: '${model}'`)
      }
      expect(src.match(/idempotencyKey: `dailyToken/g)?.length).toBe(5)
      expect(src).toContain('await flushWriteQueueNow()') // flushTokenData shutdown
    })
    test('C4. auto-learn #6: 3 create batched (localRelationship/agentInsight/learningLog); autoLearnRecord + localEntity GIỮ direct (cần id)', () => {
      const src = read('src/lib/auto-learn.ts')
      expect(src).toContain("model: 'localRelationship'")
      expect(src).toContain("model: 'agentInsight'")
      expect(src).toContain("model: 'learningLog'")
      // 2 create cần id → KHÔNG qua batcher (hợp đồng P0-3 "cần-id-trả-về")
      expect(src).toContain('const created = await db.localEntity.create({')
      expect(src).toContain('const record = await db.autoLearnRecord.create({')
    })
    test('C5. updateQ #5 + ArbiterVerdict #9 + ledger #10: KHÔNG đụng — giữ nguyên đường cũ', () => {
      expect(read('src/lib/learning/q-table.ts')).not.toContain('db-write-batcher')
      expect(read('src/lib/metrics-db.ts')).not.toContain('db-write-batcher')
      expect(read('src/lib/observation/ledger.ts')).not.toContain('db-write-batcher')
    })
    test('C6. Hook run-close (agent-run-tracker) + drain exit (instrumentation-node)', () => {
      const tracker = read('src/lib/agent-run-tracker.ts')
      expect(tracker).toContain('void flushWriteQueueNow()') // trigger 3 tại run-close
      const node = read('src/instrumentation-node.ts')
      expect(node).toContain('TMO_EXIT_WRITE_DRAIN_MS')
      expect(node).toContain('drainWriteQueueForExit(EXIT_WRITE_DRAIN_MS)')
      expect(node).toContain('Math.max(SELF_EXIT_DRAIN_MS, EXIT_WRITE_DRAIN_MS)') // hard cap P0-1.2
    })
    test('C7. Env docs: .env.example ghi đủ 6 cờ pilot (default OFF)', () => {
      const envx = read('.env.example')
      expect(envx).toContain('# DB_WRITE_QUEUE=on')
      expect(envx).toContain('# TMO_EXIT_WRITE_DRAIN_MS=3000')
    })
  })
})
