/**
 * r139 — W2/S3+S4 TÁCH WORKER (BLUEPRINT-R17BC v0.2 — REVIEW-1 P0-4/P0-5, P1-3/P1-6)
 * =====================================================================================
 * User duyệt triển khai ngay 2026-10-20. Kiểm chứng W2:
 *   A. processRole 'api'|'worker' (S4): mọi observation event mang process phát
 *      — behavioral 2 vai trên DB isolated.
 *   B. P2002-seq transient (P0-5 — ĐIỀU KIỆN CẦN split): `ObservationEvent_seq_key`
 *      nằm trong họ transient; P2002 bảng KHÁC vẫn fail cứng (hẹp đúng tên).
 *   C. Seq-collision dưới concurrency: 10 observeEvent song song → đủ 10 rows
 *      (writeOne retry tx-mới-đọc-lại-MAX an toàn khi chưa commit).
 *   D. Source-scan topology split: glwMode gate 2 nhánh (split log + else giữ
 *      nguyên chuỗi boot gốc), worker.ts mirror chain + SHADOW + TMO_PROCESS_ROLE
 *      trước import, heart-thread ping/pong + exit(1) + vòng sự kiện riêng,
 *      ecosystem app 3 (bun, 0 port, watchdog riêng), inline-fallback minh thị.
 * Tiền lệ: r126/r132 (source-scan) + r137/r138 (DB-isolated behavioral).
 */

import { test, expect, describe, beforeAll, afterAll } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { db, isTransientSqliteError } from '@/lib/db'
import { observeEvent, isObsLedgerEnabled } from '@/lib/observation/ledger'
import { readEnvFileKey, readNumEnv } from '@/lib/worker-env'

const TMO = join(import.meta.dir, '..')
const read = (p: string) => readFileSync(join(TMO, p), 'utf-8')

describe('r139 — W2 tách worker (S3+S4)', () => {
  // Bật ledger bằng cơ chế ENV như r95-B — KHÔNG phụ thuộc thứ tự file trong
  // cùng process (bun test trộn file tùy ý — tiền lệ r95 :118); restore sau.
  const hadObsLedger = process.env.OBS_LEDGER
  beforeAll(() => {
    process.env.OBS_LEDGER = 'on'
  })
  afterAll(() => {
    if (hadObsLedger === undefined) delete process.env.OBS_LEDGER
    else process.env.OBS_LEDGER = hadObsLedger
    delete process.env.TMO_PROCESS_ROLE
  })

  /** Poll row theo rowKey tới 3s — writeOne là nền async, lần đầu warm-up pool. */
  async function waitForEvent(rowKey: string) {
    const deadline = Date.now() + 3000
    for (;;) {
      const row = await db.observationEvent.findFirst({ where: { rowKey } })
      if (row || Date.now() > deadline) return row
      await new Promise(r => setTimeout(r, 200))
    }
  }

  // ============ A. processRole (S4) ============
  // Warm-up: isObsLedgerEnabled() false cho tới khi tuning-store nạp xong DB
  // (hành vi CÓ SẲN của ledger — lời gọi đầu process bị rơi nếu bắn ngay).
  async function warmupLedger(): Promise<void> {
    const deadline = Date.now() + 4000
    // eslint-disable-next-line no-constant-condition
    while (true) {
      if (isObsLedgerEnabled()) return
      if (Date.now() > deadline) throw new Error('warmupLedger: isObsLedgerEnabled không true sau 4s')
      await new Promise(r => setTimeout(r, 150))
    }
  }

  test('A1. Mặc định không đặt env → event mang processRole "api" (inline hôm nay đúng là api)', async () => {
    delete process.env.TMO_PROCESS_ROLE
    await warmupLedger()
    const marker = `r139-a1-${Date.now().toString(36)}`
    observeEvent({ actor: 'system', kind: 'db.write', table: 'Test', rowKey: marker, summary: `r139 A1 ${marker}`, payload: { marker } })
    // writeOne async nền; lần ĐẦU trong process trả chi phí warm-up pool — poll tối đa 3s
    const row = await waitForEvent(marker)
    expect(row).toBeTruthy()
    const payload = JSON.parse(String(row!.payloadJson)) as { processRole?: string }
    expect(payload.processRole).toBe('api')
  })

  test('A2. Đặt TMO_PROCESS_ROLE=worker → event mang "worker" (phân biệt 2 process khi split)', async () => {
    process.env.TMO_PROCESS_ROLE = 'worker'
    const marker = `r139-a2-${Date.now().toString(36)}`
    await warmupLedger()
    observeEvent({ actor: 'system', kind: 'db.write', table: 'Test', rowKey: marker, summary: `r139 A2 ${marker}`, payload: { marker } })
    const row = await waitForEvent(marker)
    expect(row).toBeTruthy()
    const payload = JSON.parse(String(row!.payloadJson)) as { processRole?: string }
    expect(payload.processRole).toBe('worker')
  })

  // ============ B. P2002-seq transient (P0-5 — hẹp đúng tên constraint) ============
  test('B1. P2002 tên constraint ObservationEvent_seq_key → transient (retry)', () => {
    expect(isTransientSqliteError(new Error('Unique constraint failed on the constraint: `ObservationEvent_seq_key`'))).toBe(true)
  })

  test('B2. P2002 bảng KHÁC (QEntry) vẫn fail cứng — hẹp đúng tên, không mở toàn họ P2002', () => {
    expect(isTransientSqliteError(new Error('Unique constraint failed on the constraint: `QEntry_stateKey_actionKey_key`'))).toBe(false)
  })

  // ============ C. Seq-collision dưới concurrency (điều kiện cần split) ============
  test('C1. 10 observeEvent song song → đủ 10 rows (tx mới đọc lại MAX khi va @unique seq)', async () => {
    const sfx = Date.now().toString(36)
    for (let i = 0; i < 10; i++) {
      observeEvent({ actor: 'system', kind: 'db.write', table: 'Test', rowKey: `r139-c1-${sfx}-${i}`, summary: `r139 C1 ${i}`, payload: { i } })
    }
    await new Promise(r => setTimeout(r, 900)) // cho drain + retry nếu va seq
    const rows = await db.observationEvent.count({ where: { rowKey: { contains: `r139-c1-${sfx}` } } })
    expect(rows).toBe(10)
  })

  // ============ D. Source-scan topology split ============
  describe('r139 D — source-scan topology (P0-4/P1-3/P1-6)', () => {
    test('D1. instrumentation glwMode: split → API KHÔNG start; else → chuỗi boot GỐC giữ nguyên (chống divergence inline)', () => {
      const node = read('src/instrumentation-node.ts')
      expect(node).toContain("const glwMode = (process.env.GOAL_LOOP_WORKER_MODE || 'inline').trim().toLowerCase()")
      expect(node).toContain('process API KHÔNG start goal-loop worker')
      // nhánh else giữ NGUYÊN chuỗi boot cũ (recoverPending + start + catch fail-open)
      expect(node).toContain('[instrumentation] GoalLoopWorker boot recovery')
    })
    test('D2. worker.ts: mirror chain + SHADOW inline + TMO_PROCESS_ROLE=worker TRƯỚC import', () => {
      const w = read('scripts/worker.ts')
      // processRole phải nằm TRƯỚC mọi import (event sớm nhất cũng mang đúng vai)
      const roleIdx = w.indexOf("process.env.TMO_PROCESS_ROLE = 'worker'")
      const firstImportIdx = w.indexOf('import os from')
      expect(roleIdx).toBeGreaterThan(-1)
      expect(roleIdx).toBeLessThan(firstImportIdx)
      expect(w).toContain("MODE !== 'split'")
      expect(w).toContain('SHADOW MODE')
      expect(w).toContain('goalLoopWorker.recoverPending()')
      expect(w).toContain('goalLoopWorker.start()')
      expect(w).toContain('recoverPending')
    })
    test('D3. worker-heart-thread.ts: ping/pong + exit(1) + vòng sự kiện RIÊNG (P1-3)', () => {
      const t = read('scripts/worker-heart-thread.ts')
      expect(t).toContain("from 'node:worker_threads'")
      expect(t).toContain("postMessage('ping')")
      expect(t).toContain("'pong'")
      expect(t).toContain('process.exit(1)')
      expect(t).toContain('WORKER_HEART_MOVEMENT_MS')
    })
    test('D4. ecosystem app 3 theopus-worker: bun interpreter, 0 port (env không có PORT — không mở HttpWatchdog), watchdog riêng, backstop 1400M', () => {
      const e = read('ecosystem.config.cjs')
      expect(e).toContain("name: 'theopus-worker'")
      expect(e).toContain("script: 'scripts/worker.ts'")
      expect(e).toContain('interpreter: ') // bun
      expect(e).toContain("max_memory_restart: '1400M'")
      // 0 port: block worker (từ name tới cuối file) KHÔNG khai PORT — không mở HttpWatchdog
      const workerBlock = e.slice(e.indexOf("name: 'theopus-worker'"))
      expect(workerBlock).not.toContain('PORT:')
    })
    test('D5. db.ts: ObservationEvent_seq_key trong họ transient + comment điều kiện cần split', () => {
      const d = read('src/lib/db.ts')
      expect(d).toContain("'ObservationEvent_seq_key',")
      expect(d).toContain('ĐIỀU KIỆN CẦN cho split')
    })
    test('D6. ledger writeOne: processRole mặc định api — không đè processRole caller tự khai', () => {
      const l = read('src/lib/observation/ledger.ts')
      expect(l).toContain("process.env.TMO_PROCESS_ROLE")
      expect(l).toContain("?? 'api'")
    })
    test('D7. Inline-fallback minh thị (P1-6): chat route guard giữ nguyên — split KHÔNG đổi đường fallback', () => {
      const chat = read('src/app/api/openclaw/chat/route.ts')
      expect(chat).toContain('rơi xuống chạy INLINE như cũ')
      expect(chat).toContain('DOUBLE-RUN')
    })
    test('D8. .env.example: docs GOAL_LOOP_WORKER_MODE + WORKER_* (default inline)', () => {
      const envx = read('.env.example')
      expect(envx).toContain('# GOAL_LOOP_WORKER_MODE=split')
      expect(envx).toContain('# WORKER_MEM_WATCHDOG_MB=1000')
      expect(envx).toContain('# WORKER_HEART_MOVEMENT_MS=120000')
    })
  })

  // ============ E. FB-W2-R1 regression (env defaults sống) + ops đo KPI ============
  describe('r139 E — FB-W2-R1-01 regression + ops write-queue', () => {
    // readNumEnv ưu tiên process.env — chặn rò rỉ env của test process
    const EKEYS = ['WORKER_MEM_WATCHDOG_MB', 'WORKER_HEART_MOVEMENT_MS', 'WORKER_MEM_CHECK_INTERVAL_MS', 'WORKER_STATS_LOG_MS'] as const
    const savedEnv: Record<string, string | undefined> = {}
    beforeAll(() => {
      for (const k of EKEYS) {
        savedEnv[k] = process.env[k]
        delete process.env[k]
      }
    })
    afterAll(() => {
      for (const k of EKEYS) {
        if (savedEnv[k] === undefined) delete process.env[k]
        else process.env[k] = savedEnv[k]
      }
    })

    test('E1. FB-W2-R1-01: key VẮNG (không .env, không process.env) → DEFAULT đúng — không còn dính floor (v1: "" không nullish → Number("")=0 → 1000MB thành 300MB, 120s thành 30s trên worker THẬT)', () => {
      const root = mkdtempSync(join(tmpdir(), 'r139-e1-')) // thư mục trống — không có .env
      try {
        expect(readNumEnv(root, 'WORKER_MEM_WATCHDOG_MB', 1000, 300)).toBe(1000)
        expect(readNumEnv(root, 'WORKER_HEART_MOVEMENT_MS', 120_000, 30_000)).toBe(120_000)
        expect(readNumEnv(root, 'WORKER_MEM_CHECK_INTERVAL_MS', 30_000, 10_000)).toBe(30_000)
        expect(readNumEnv(root, 'WORKER_STATS_LOG_MS', 300_000, 60_000)).toBe(300_000)
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    })

    test('E2. .env có giá trị → dùng (777); key rỗng "KEY=" → coi như vắng → default; rác "abc" → default (isFinite — NaN không giết watchdog); dưới floor → floor', () => {
      const root = mkdtempSync(join(tmpdir(), 'r139-e2-'))
      try {
        writeFileSync(
          join(root, '.env'),
          [
            'WORKER_MEM_WATCHDOG_MB=777',
            'WORKER_HEART_MOVEMENT_MS=',
            'WORKER_MEM_CHECK_INTERVAL_MS=abc',
            'WORKER_STATS_LOG_MS=50',
            '# WORKER_HEART_MOVEMENT_MS=120000',
          ].join('\n'),
        )
        expect(readNumEnv(root, 'WORKER_MEM_WATCHDOG_MB', 1000, 300)).toBe(777)
        expect(readNumEnv(root, 'WORKER_HEART_MOVEMENT_MS', 120_000, 30_000)).toBe(120_000) // rỗng = vắng; dòng comment không tính
        expect(readNumEnv(root, 'WORKER_MEM_CHECK_INTERVAL_MS', 30_000, 10_000)).toBe(30_000) // rác = default
        expect(readNumEnv(root, 'WORKER_STATS_LOG_MS', 300_000, 60_000)).toBe(60_000) // 50 < floor 60s → floor
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    })

    test('E3. readEnvFileKey: vắng → undefined (nullish — ?? default sống); có → giá trị; strip quote', () => {
      const root = mkdtempSync(join(tmpdir(), 'r139-e3-'))
      try {
        writeFileSync(join(root, '.env'), 'GOAL_LOOP_WORKER_MODE="split"\nWORKER_MEM_WATCHDOG_MB=900\n')
        expect(readEnvFileKey(root, 'GOAL_LOOP_WORKER_MODE_VANG')).toBeUndefined()
        expect(readEnvFileKey(root, 'GOAL_LOOP_WORKER_MODE')).toBe('split')
        expect(readEnvFileKey(root, 'WORKER_MEM_WATCHDOG_MB')).toBe('900')
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    })

    test('E4. process.env ĐỦ ƯU TIÊN hơn .env file (pm2 override vẫn thắng)', () => {
      const root = mkdtempSync(join(tmpdir(), 'r139-e4-'))
      try {
        writeFileSync(join(root, '.env'), 'WORKER_MEM_WATCHDOG_MB=900\n')
        process.env.WORKER_MEM_WATCHDOG_MB = '650'
        try {
          expect(readNumEnv(root, 'WORKER_MEM_WATCHDOG_MB', 1000, 300)).toBe(650)
        } finally {
          delete process.env.WORKER_MEM_WATCHDOG_MB
        }
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    })

    test('E5. worker.ts nạp helper mới (readNumEnv — hết công thức Math.max(300, Number(?? …)) chết default) + log stats write-queue chu kỳ (KPI #3/#9 ở process worker)', () => {
      const w = read('scripts/worker.ts')
      expect(w).toContain("from '../src/lib/worker-env'")
      expect(w).not.toContain('Math.max(300, Number(') // công thức v1 chết default
      expect(w).toContain("readNumEnv(ROOT, 'WORKER_MEM_WATCHDOG_MB', 1000, 300)")
      expect(w).toContain("readNumEnv(ROOT, 'WORKER_HEART_MOVEMENT_MS', 120_000, 30_000)")
      expect(w).toContain('write-queue stats')
    })

    test('E6. worker-heart-thread chặn NaN (rác → default 120s — không cho Math.max(NaN) giết watchdog im lặng)', () => {
      const t = read('scripts/worker-heart-thread.ts')
      expect(t).toContain('Number.isFinite')
    })

    test('E7. Route ops /api/observation/write-queue READ-ONLY (getWriteQueueStats thuần in-memory — KPI #3/#9 live ở process API) + .gitignore exception 2 script worker (chống mất khi clone — bài học matryoshka FB-Đợt7-R5)', () => {
      const route = read('src/app/api/observation/write-queue/route.ts')
      expect(route).toContain('getWriteQueueStats')
      expect(route).not.toContain('export async function POST')
      const gi = read('.gitignore')
      expect(gi).toContain('!/scripts/worker.ts')
      expect(gi).toContain('!/scripts/worker-heart-thread.ts')
    })

    test('E8. FB-W2-R3-01: worker.ts CHỐNG TIÊM NHẦM DATABASE_URL — .env TMO là nguồn sự thật DUY NHẤT, guard chạy TRƯỚC import db-setup (pilot 2026-10-20: pm2 --update-env tiêm env shell sandbox my-project → worker nối nhầm DB rỗng, sweep 0 job + claim im lặng mãi — phát hiện bằng /proc/<pid>/environ)', () => {
      const w = read('scripts/worker.ts')
      expect(w).toContain("readEnvFileKey(ROOT, 'DATABASE_URL')")
      expect(w).toContain('CHỐNG TIÊM NHẦM')
      expect(w).toContain('process.env.DATABASE_URL = envFileDb')
      // guard PHẢI nằm trước import db-setup — db.ts đọc env lúc module-load
      const guardIdx = w.indexOf("readEnvFileKey(ROOT, 'DATABASE_URL')")
      const dbSetupIdx = w.indexOf("await import('../src/lib/db-setup')")
      expect(guardIdx).toBeGreaterThan(-1)
      expect(dbSetupIdx).toBeGreaterThan(-1)
      expect(guardIdx).toBeLessThan(dbSetupIdx)
    })

    test('E9. Instrumentation chẩn đoán TẠM pilot đã gỡ SẠCH khỏi goal-loop-worker (không sót TMO_WORKER_TICK_DEBUG/tick-debug/tickDbgCount — chẩn đoán xong phải trả code về sạch)', () => {
      const g = read('src/lib/goal-loop-worker.ts')
      expect(g).not.toContain('TMO_WORKER_TICK_DEBUG')
      expect(g).not.toContain('tick-debug')
      expect(g).not.toContain('tickDbgCount')
    })
  })
})
