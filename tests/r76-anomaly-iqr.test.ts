/**
 * ROUND-76 TESTS — P1-M3 IQR ANOMALY DETECTOR (BLUEPRINT-STATS-LEARNING-P0-P6
 * §P1-M3, mục #4 — DA.pdf §Outlier Detection)
 *
 * Đo lường: scanToolMetricAnomalies — Tukey fence per (toolName, agentRole)
 * trên cửa sổ lookback, chỉ ghi điểm ngoài bound TRONG 24H QUA, n≥20 mới
 * tính bounds, idempotent theo (kind, tool, role, value, giờ), prune >30 ngày.
 *
 * Nguyên tắc test:
 * - DB-cô-lập (bunfig preload copy): WIPE ToolMetric + MetricAnomaly trong
 *   bản copy — dữ liệu production copy không được phép làm bẩn xác suất.
 * - Seed DỰNG SẴN có quantile tính tay: 25 call [1000..3400] step 100 +
 *   1 call 90000 (n=26 ≥ 20):
 *     quantile type-7 trên 26 giá trị: q1 = x[6] + 0.25·(x[7]−x[6])
 *       = 1600 + 25 = 1625; q3 = x[18] + 0.75·(x[19]−x[18]) = 2800 + 75 = 2875
 *     iqr = 1250 → high = 2875 + 1.5·1250 = 4750 < 90000 → ĐÚNG 1 anomaly
 *     score = (90000 − 2875)/1250 = 69.7
 * - Nhóm nhỏ (n=6 < 20) có 1 điểm cực đoan → 0 anomaly (chống nhiễu LLN).
 * - Điểm cực đoan NGOÀI 24h qua → đóng góp bounds nhưng KHÔNG được ghi mới.
 */

import { describe, test, expect, beforeAll } from 'bun:test'
import { db } from '@/lib/db'
import { scanToolMetricAnomalies } from '@/lib/learning/anomaly-detector'

const NOW = Date.now()

const TOOL_MAIN = 'r76_test_iqr_tool' // nhóm chính n=26
const TOOL_SMALL = 'r76_test_small_group' // nhóm n=6 — dưới ngưỡng 20
const TOOL_OLD = 'r76_test_old_outlier' // điểm cực đoan ngoài 24h
const ROLE = 'TEST_R76'

async function seedCall(toolName: string, durationMs: number, timestamp: Date): Promise<void> {
  await db.toolMetric.create({
    data: {
      toolName,
      sessionId: 'test-r76-anomaly',
      agentRole: ROLE,
      success: true,
      exitCode: 0,
      durationMs,
      errorTag: null,
      timestamp,
    },
  })
}

describe('r76 · P1-M3 IQR anomaly detector', () => {
  beforeAll(async () => {
    await db.toolMetric.deleteMany({})
    await db.metricAnomaly.deleteMany({})

    // Nhóm chính: 25 call thường [1000..3400] + 1 call 90000 (bây giờ)
    for (let i = 0; i < 25; i++) {
      await seedCall(TOOL_MAIN, 1000 + i * 100, new Date(NOW - 60_000))
    }
    await seedCall(TOOL_MAIN, 90_000, new Date(NOW - 30_000))

    // Nhóm nhỏ: 5 call thường + 1 cực đoan — n=6 < 20 → bỏ qua
    for (let i = 0; i < 5; i++) {
      await seedCall(TOOL_SMALL, 1000 + i * 100, new Date(NOW - 50_000))
    }
    await seedCall(TOOL_SMALL, 500_000, new Date(NOW - 40_000))

    // Nhóm điểm cũ: 25 call thường + 1 cực đoan 3 NGÀY TRƯỚC (ngoài 24h)
    for (let i = 0; i < 25; i++) {
      await seedCall(TOOL_OLD, 2000 + i * 100, new Date(NOW - 3 * 24 * 3600 * 1000 - 3600_000))
    }
    await seedCall(TOOL_OLD, 800_000, new Date(NOW - 3 * 24 * 3600 * 1000))
  })

  test('bắt đúng 1 anomaly tool_duration_high với bound/score tính tay', async () => {
    const result = await scanToolMetricAnomalies(7)
    expect(result.error).toBeUndefined()
    expect(result.scanned).toBe(58) // 26 + 6 + 26

    const main = result.byTool.find((t) => t.toolName === TOOL_MAIN)
    expect(main).toBeDefined()
    expect(main!.n).toBe(26)
    expect(main!.anomalies).toBe(1)

    const rows = await db.metricAnomaly.findMany({ where: { toolName: TOOL_MAIN } })
    expect(rows.length).toBe(1)
    expect(rows[0].kind).toBe('tool_duration_high')
    expect(rows[0].agentRole).toBe(ROLE)
    expect(rows[0].value).toBe(90_000)
    // high = q3 + 1.5·iqr = 2875 + 1875 = 4750 — bound < value (kiểm chứng blueprint)
    expect(rows[0].bound).toBe(4750)
    // score = (90000 − 2875)/1250 = 69.7
    expect(Math.abs(rows[0].score - 69.7)).toBeLessThan(1e-9)
  })

  test('nhóm nhỏ (n<20) bị bỏ qua — 0 anomaly cho TOOL_SMALL', async () => {
    const result = await scanToolMetricAnomalies(7)
    const small = result.byTool.find((t) => t.toolName === TOOL_SMALL)
    expect(small).toBeDefined()
    expect(small!.n).toBe(6)
    expect(small!.anomalies).toBe(0)
    const rows = await db.metricAnomaly.findMany({ where: { toolName: TOOL_SMALL } })
    expect(rows.length).toBe(0)
  })

  test('điểm cực đoan NGOÀI 24h chỉ đóng góp bounds — KHÔNG ghi anomaly mới', async () => {
    const result = await scanToolMetricAnomalies(7)
    const old = result.byTool.find((t) => t.toolName === TOOL_OLD)
    expect(old).toBeDefined()
    expect(old!.anomalies).toBe(0)
    const rows = await db.metricAnomaly.findMany({ where: { toolName: TOOL_OLD } })
    expect(rows.length).toBe(0)
  })

  test('idempotent: scan lần 2 KHÔNG nhân bản anomaly (khử trùng theo khoá)', async () => {
    const before = await db.metricAnomaly.count({ where: { toolName: TOOL_MAIN } })
    expect(before).toBe(1)
    const second = await scanToolMetricAnomalies(7)
    expect(second.anomalies).toBe(0) // không có điểm MỚI nào
    const after = await db.metricAnomaly.count({ where: { toolName: TOOL_MAIN } })
    expect(after).toBe(1) // đúng 1 — không nhân bản
  })

  test('prune: anomaly cũ hơn 30 ngày bị dọn khi scan', async () => {
    await db.metricAnomaly.create({
      data: {
        kind: 'tool_duration_high',
        toolName: 'r76_test_prune',
        agentRole: ROLE,
        value: 999,
        bound: 100,
        score: 9,
        sessionId: null,
        observedAt: new Date(NOW - 40 * 24 * 3600 * 1000), // 40 ngày — quá hạn 30
      },
    })
    const result = await scanToolMetricAnomalies(7)
    expect(result.pruned).toBeGreaterThanOrEqual(1)
    const leftover = await db.metricAnomaly.findMany({ where: { toolName: 'r76_test_prune' } })
    expect(leftover.length).toBe(0)
    // Anomaly chính vẫn còn nguyên (trong hạn)
    const main = await db.metricAnomaly.count({ where: { toolName: TOOL_MAIN } })
    expect(main).toBe(1)
  })
})
