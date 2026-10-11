/**
 * r80-metrics-raw-tx-pin — FB-P6-R3-01 (fixbug P6 vòng R3, mức P3·C5)
 *
 * Pin cho FB-P6-R1-C-02: resolveArbiterVerdictsDetailed ĐƯỜNG RAW (client
 * stale — không có delegate arbiterVerdict) phải chạy 2 lệnh UPDATE trong
 * MỘT $transaction array-form (bản trước 2 lệnh rời → crash/giữa chừng để
 * lại resolve nửa vời). Revert fix → txCalls=0 → test FAIL.
 *
 * Kỹ thuật: PrismaClient RIÊNG TƯ (dependency-injection param `client` của
 * resolveArbiterVerdictsDetailed — additive) — KHÔNG đụng db dùng chung của
 * process (bài học H7-v1: bun test 1 process, mock.module '@/lib/db' của
 * adaptation-engine.test.ts khiến r79 cầm Proxy dùng chung — mutate property
 * trên đó nhiễm lan cả r76/r77). Trên instance riêng: descriptor arbiterVerdict
 * (own-data, configurable — đã probe) được save → undefined (ép raw-path) →
 * restore CHÍNH XÁC trong finally; spy $transaction cũng save/restore descriptor.
 */

import { describe, expect, test } from 'bun:test'
import { randomUUID } from 'crypto'
import { PrismaClient } from '@prisma/client'

import { resolveArbiterVerdictsDetailed } from '@/lib/metrics-db'

describe('r80 · FB-P6-R3-01 — raw-path resolveArbiterVerdictsDetailed: 2 lệnh raw trong MỘT $transaction', () => {
  test('client stale → đúng 1 $transaction array-2-phần-tử, counts confirmed/refuted đúng', async () => {
    const client = new PrismaClient()
    const sessionId = `test-r80-${randomUUID().slice(0, 8)}`
    try {
      // Gieo 2 verdict pending: 1 khớp runComplete (→confirmed), 1 ngược (→refuted)
      await client.arbiterVerdict.create({ data: { sessionId, cycle: 1, complete: true, confidence: 0.8, verified: true } })
      await client.arbiterVerdict.create({ data: { sessionId, cycle: 2, complete: false, confidence: 0.8, verified: true } })

      // Bọc client trong Proxy CỦA TEST (PrismaClient tự thân đã là Proxy với
      // descriptor own-data giả — value undefined — nên defineProperty/spy
      // property trên nó KHÔNG hoạt động ổn định, bài học H7-v1/v2):
      //   - arbiterVerdict → undefined (ép nhánh raw "client stale")
      //   - $transaction → spy đếm + hình dạng tham số, uỷ quyền bản thật
      let txCalls = 0
      let txArgShape = ''
      const staleClient = new Proxy(client, {
        get(target, prop, _receiver) {
          if (prop === 'arbiterVerdict') return undefined
          if (prop === '$transaction') {
            return (arg: unknown) => {
              txCalls++
              txArgShape = Array.isArray(arg) ? `array-${(arg as unknown[]).length}` : typeof arg
              return target.$transaction(arg as never)
            }
          }
          const v = Reflect.get(target, prop, target)
          return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v
        },
      }) as unknown as typeof client

      const { total, confirmed, refuted } = await resolveArbiterVerdictsDetailed(
        sessionId, true, 'max_cycles', staleClient,
      )
      expect(total).toBe(2)
      expect(confirmed).toBe(1)
      expect(refuted).toBe(1)
      // FB-P6-R1-C-02 pin: bản 2-lệnh-rời sẽ KHÔNG qua $transaction → txCalls=0
      expect(txCalls).toBe(1)
      expect(txArgShape).toBe('array-2')
      // Idempotent — resolve lần 2 không còn pending (transaction thứ 2 update 0 row)
      const again = await resolveArbiterVerdictsDetailed(sessionId, true, 'max_cycles', staleClient)
      expect(again.total).toBe(0)
      expect(txCalls).toBe(2) // vẫn đi qua $transaction — chỉ là 2 lệnh 0-row
    } finally {
      await client.$disconnect()
    }
  })
})
