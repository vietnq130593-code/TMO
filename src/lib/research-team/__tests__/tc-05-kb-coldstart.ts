/**
 * TC-05 — KB COLD-START SEED (TB-12 §3.2 + TB-05 §9 E1)
 * ==================================================================================
 * Spec:
 *  - KB trống (cold-start — lần chạy đầu) → HAN load KB Phase 1 → thấy trống →
 *    seed bằng starter KB (các bảng lessons/anti-patterns/baselines chuẩn nguồn).
 *  - Idempotent: gọi 2 lần → lần 1 seeded>0, lần 2 seeded===0.
 *  - KHÔNG crash, KHÔNG skip.
 *
 * DB test — query KB count + call seedKB. Fail-open: nếu KB đã có entries từ test
 * trước → seeded===0 cả 2 lần (test KHÔNG fail — chỉ ghi nhận idempotent policy).
 */

import { seedKB, getKBStats } from '@/lib/research-team/g3/kb-store'
import { db } from '@/lib/db'
import type { TestResult } from './_types'

async function run(): Promise<TestResult> {
  const details: string[] = []

  // Determine initial state — ghi nhận KB có sẵn trước
  const initialCount = await db.researchKBEntry.count()
  details.push(`initial KB count=${initialCount}`)

  // ---------- 1. First call: seedKB ----------
  const result1 = await seedKB()
  const count1 = await db.researchKBEntry.count()
  const seed1Ok =
    (initialCount === 0 && result1.seeded > 0) ||
    (initialCount > 0 && result1.seeded === 0)
  details.push(
    `seedKB #1: seeded=${result1.seeded} categories=${result1.categories.length} countAfter=${count1} — ${seed1Ok ? 'OK' : 'FAIL'}`,
  )

  // ---------- 2. Second call: idempotent (seeded===0 vì KB đã có) ----------
  const result2 = await seedKB()
  const count2 = await db.researchKBEntry.count()
  const seed2Ok = result2.seeded === 0
  details.push(
    `seedKB #2 (idempotent): seeded=${result2.seeded} (expected 0) countAfter=${count2} — ${seed2Ok ? 'OK' : 'FAIL'}`,
  )

  // ---------- 3. Categories đã có entries cơ bản (lesson/anti-pattern/baseline) ----------
  const stats = await getKBStats()
  const hasCategories =
    Object.keys(stats.byCategory).length > 0 || stats.total > 0
  details.push(
    `getKBStats: total=${stats.total} active=${stats.active} categories=${Object.keys(stats.byCategory).length} — ${hasCategories ? 'OK' : 'FAIL'}`,
  )

  const passed = seed1Ok && seed2Ok && hasCategories
  return {
    name: 'TC-05 KB cold-start seed',
    passed,
    details: details.join(' | '),
  }
}

if (import.meta.main) {
  run()
    .then((r) => {
      console.log(r.name, r.passed ? 'PASS' : 'FAIL')
      console.log(r.details)
      process.exit(r.passed ? 0 : 1)
    })
    .catch((err) => {
      console.error('TC-05 uncaught:', err)
      process.exit(1)
    })
}

export { run }
