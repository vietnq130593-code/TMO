/**
 * r142 — BUG2-316 HERMETIC TEST SUITE (trả nợ 2026-10-21 — user duyệt)
 * =====================================================================================
 * GỐC RỂ (§7.10 phiên, A/B 9-run matrix + forensics): request-time self-heal
 * ensureDbReady spawn `prisma db push` trên DB test GIỮA CHỪNG 111-112 file
 * chạy song song → DDL đụng bảng đang dùng (TuningChangeLog "biến mất thoáng")
 * + cascade SQLITE_BUSY/P2024 5s → đúng tập "20 failures, 10 unique" OBS-2 N4
 * + gate đỏ/xanh thất thường theo cửa sổ scheduling.
 *
 * FIX: guard BUN_TEST tại entry ensureDbReady — dưới `bun test` (bun tự set
 * env BUN_TEST), TOÀN BỘ tầng self-heal (probe CLI + db push/generate spawn)
 * TẮT. DB test đã được chuẩn bị TRƯỚC bởi preload (/tmp copy) hoặc
 * quality-gate (db/.quality-gate-test.db).
 *
 *   A. HÀNH VI (đúng nghĩa — chạy ngay trong bun test, BUN_TEST tự set):
 *      ensureDbReady({force:true}) trả ok + reason nhắc BUN_TEST + NHANH
 *      (proxy "không spawn CLI": probe migrate diff thật mất ≥1-2s).
 *   B. Source-scan: guard đứng TRƯỚC mọi tầng probe/spawn trong ensureDbReady
 *      (entry) — không phải chỉ che 1 nhánh runSetup.
 *   C. Boot-path pin: instrumentation (boot) vẫn gọi ensureDbReady bình thường
 *      (guard chỉ phụ thuộc env BUN_TEST — app runtime không bao giờ có).
 * Tiền lệ: r126/r132/r139/r140/r141 (behavioral + source-scan).
 */

import { test, expect, describe } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ensureDbReady } from '@/lib/db-setup'

const TMO = join(import.meta.dir, '..')
const read = (p: string) => readFileSync(join(TMO, p), 'utf-8')

describe('r142 — BUG2-316 hermetic test suite (guard test-runner cho ensureDbReady)', () => {
  test('A1: dưới bun test — ensureDbReady({force:true}) trả ok, KHÔNG migrate, reason nêu guard BUG2-316', async () => {
    // bun 1.3.14: BUN_TEST KHÔNG được set trong process.env — marker CHÍNH là
    // NODE_ENV==='test' (bun test tự set, đo live) + TMO_TEST_DB_ISOLATED
    // (preload cách ly set). Pin tiền điều kiện: ít nhất 1 marker phải có.
    const marker = process.env.NODE_ENV === 'test' || Boolean(process.env.BUN_TEST) || process.env.TMO_TEST_DB_ISOLATED === '1'
    expect(marker).toBe(true)

    const result = await ensureDbReady({ force: true })
    expect(result.ok).toBe(true)
    expect(result.migrated).toBe(false)
    expect(result.reason).toContain('BUG2-316')
    expect(result.reason).toContain('TEST-RUNNER guard')
  })

  test('A2: guard NHANH — proxy không spawn CLI (probe migrate diff thật ≥1s; guard ~0ms)', async () => {
    const t0 = Date.now()
    await ensureDbReady({ force: true })
    const dt = Date.now() - t0
    // Guard trả ngay (<2s dư biên độ CI; spawn CLI probe thật luôn >1-2s)
    expect(dt).toBeLessThan(2000)
  })

  test('A3: lặp lại + không force → cùng guard (cache path không chạy — guard đứng trước cache)', async () => {
    const a = await ensureDbReady()
    const b = await ensureDbReady({ force: true })
    for (const r of [a, b]) {
      expect(r.ok).toBe(true)
      expect(r.migrated).toBe(false)
      expect(r.reason).toContain('BUG2-316')
    }
  })

  test('B1: source-scan — guard test-runner đứng TRƯỚC in-flight check trong ensureDbReady', () => {
    const src = read('src/lib/db-setup.ts')
    const fnStart = src.indexOf('export async function ensureDbReady')
    expect(fnStart).toBeGreaterThan(0)
    const body = src.slice(fnStart)
    const guardPos = body.indexOf('isTestRunnerContext()')
    const inflightPos = body.indexOf('__tmoDbSetupInFlight')
    expect(guardPos).toBeGreaterThan(-1)
    expect(inflightPos).toBeGreaterThan(guardPos) // guard TRƯỚC mọi tầng dedup/probe/spawn
  })

  test('B2: source-scan — guard return TRƯỚC khi runSetup xuất hiện (spawn không thể tới được dưới test)', () => {
    const src = read('src/lib/db-setup.ts')
    const fnStart = src.indexOf('export async function ensureDbReady')
    const fnEnd = src.indexOf('\n}', fnStart)
    const body = src.slice(fnStart, fnEnd)
    const guardReturnPos = body.indexOf('return {', body.indexOf('isTestRunnerContext()'))
    const runSetupPos = body.indexOf('runSetup()')
    expect(guardReturnPos).toBeGreaterThan(-1)
    expect(runSetupPos).toBeGreaterThan(guardReturnPos)
  })

  test('B3: marker triple-check đúng như đo live (NODE_ENV=test chính + BUN_TEST dự phòng + preload marker)', () => {
    const src = read('src/lib/db-setup.ts')
    expect(src).toContain("process.env.NODE_ENV === 'test'")
    expect(src).toContain('process.env.BUN_TEST')
    expect(src).toContain("process.env.TMO_TEST_DB_ISOLATED === '1'")
  })

  test('C1: boot-path pin — instrumentation vẫn gọi ensureDbReady (guard chỉ theo marker test-runner)', () => {
    const src = read('src/instrumentation-node.ts')
    expect(src).toContain('ensureDbReady')
    // App runtime marker: ecosystem set NODE_ENV=development cho app + worker
    // (chính là trạng thái KHÔNG khớp guard → self-heal sống đầy đủ)
    const eco = read('ecosystem.config.cjs')
    expect(eco).toContain("NODE_ENV: 'development'")
  })
})
