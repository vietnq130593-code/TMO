/**
 * ROUND-76 TESTS — P1-M1 VERDICT SCORECARD (BLUEPRINT-STATS-LEARNING-P0-P6)
 *
 * Đo lường: computeVerdictScorecard(windowDays) — confusion matrix của lời
 * tuyên bố "complete" (predicted = verdict.complete, actual = runComplete)
 * + precision/recall/f1/specificity + AUC-PR/Brier/ECE + phân tầng byAgent +
 * nhóm forcedDowngrade (fpWithoutGuard = verdict bị verify-guard hạ mà run
 * KHÔNG complete → guard đã chặn 1 FP).
 *
 * Nguyên tắc test:
 * - DB-cô-lập (bunfig preload copy DB): WIPE ArbiterVerdict trong bản copy
 *   trước khi seed — dữ liệu production copy không được phép làm bẩn ma trận.
 * - Mọi expected DẪN NGUỒN ĐƯỢC (comment công thức) — tính tay độc lập.
 *
 * Ma trận seed (6 verdict, cửa sổ 30 ngày):
 *   v1 OMEGA     complete=T runComplete=T conf=0.90  → TP   (không downgrade)
 *   v2 OMEGA     complete=T runComplete=T conf=0.85  → TP
 *   v3 CATALYST  complete=T runComplete=F conf=0.95  → FP   (downgrade=T — guard chặn FP)
 *   v4 SENTINEL  complete=F runComplete=T conf=0.30  → FN   (downgrade=T — guard mất TP)
 *   v5 SENTINEL  complete=F runComplete=F conf=0.20  → TN
 *   v6 SENTINEL  complete=F runComplete=F conf=0.40  → TN
 *   → cm = { tp:2, fp:1, fn:1, tn:2 }; precision = recall = f1 = 2/3 ≈ 0.6667;
 *     specificity = 2/3 ≈ 0.6667.
 *   Brier = (0.01 + 0.0225 + 0.9025 + 0.49 + 0.04 + 0.16)/6 = 1.625/6
 *          = 0.270833… → 0.2708
 *   AUC-PR (step-wise, thresholds 0.95→0.2): 0.5·⅓ + ⅔·⅓ + 0 + 0.6·⅓ + 0
 *          = 1/6 + 2/9 + 1/5 = 53/90 = 0.58888… → 0.5889
 *   ECE (10 bins): b9{avg .925 rate .5 n2}·2/6 + |.85−1|/6 + |.3−1|/6
 *          + |.2−0|/6 + |.4−0|/6 = .141667+.025+.116667+.033333+.066667
 *          = 0.383333… → 0.3833
 *   v7 (40 ngày trước, ngoài cửa sổ 30): complete=T runComplete=T → TP khi
 *          windowDays=60: cm={tp:3,fp:1,fn:1,tn:2}, P=R=F1=0.75.
 */

import { describe, test, expect, beforeAll } from 'bun:test'
import { db } from '@/lib/db'
import { computeVerdictScorecard } from '@/lib/eval/verdict-scorecard'

const NOW = new Date()
const OLD = new Date(Date.now() - 40 * 24 * 3600 * 1000) // ngoài cửa sổ 30 ngày

interface SeedVerdict {
  agentName: string
  cycle: number
  complete: boolean
  confidence: number
  runComplete: boolean
  forcedDowngrade?: boolean
  createdAt: Date
}

function outcomeFor(v: { complete: boolean; runComplete: boolean }): 'confirmed' | 'refuted' {
  return v.complete === v.runComplete ? 'confirmed' : 'refuted'
}

async function seed(rows: SeedVerdict[]): Promise<void> {
  for (const v of rows) {
    await db.arbiterVerdict.create({
      data: {
        sessionId: 'test-r76-scorecard',
        agentName: v.agentName,
        cycle: v.cycle,
        complete: v.complete,
        confidence: v.confidence,
        verified: true,
        forcedDowngrade: v.forcedDowngrade ?? false,
        outcome: outcomeFor(v),
        runComplete: v.runComplete,
        runStopReason: v.runComplete ? 'complete' : 'max_cycles',
        outcomeAt: v.createdAt,
        createdAt: v.createdAt,
      },
    })
  }
}

/** 6 verdict trong cửa sổ (bảng ở đầu file) */
function coreSix(): SeedVerdict[] {
  return [
    { agentName: 'OMEGA', cycle: 1, complete: true, confidence: 0.9, runComplete: true, createdAt: NOW },
    { agentName: 'OMEGA', cycle: 2, complete: true, confidence: 0.85, runComplete: true, createdAt: NOW },
    { agentName: 'CATALYST', cycle: 1, complete: true, confidence: 0.95, runComplete: false, forcedDowngrade: true, createdAt: NOW },
    { agentName: 'SENTINEL', cycle: 1, complete: false, confidence: 0.3, runComplete: true, forcedDowngrade: true, createdAt: NOW },
    { agentName: 'SENTINEL', cycle: 2, complete: false, confidence: 0.2, runComplete: false, createdAt: NOW },
    { agentName: 'SENTINEL', cycle: 3, complete: false, confidence: 0.4, runComplete: false, createdAt: NOW },
  ]
}

describe('r76 · P1-M1 verdict scorecard', () => {
  beforeAll(async () => {
    // WIPE trong bản copy cô lập — ma trận phải deterministic theo seed
    await db.arbiterVerdict.deleteMany({})
  })

  test('zero-state: bảng trống → n=0 + note "chờ dữ liệu", KHÔNG throw', async () => {
    const sc = await computeVerdictScorecard(30)
    expect(sc.n).toBe(0)
    expect(sc.tp + sc.fp + sc.fn + sc.tn).toBe(0)
    expect(sc.precision).toBe(0)
    expect(sc.aucPr).toBeNull()
    expect(sc.ece).toBeNull()
    expect(sc.byAgent).toEqual([])
    expect(sc.forcedDowngrade).toEqual({ n: 0, fpWithoutGuard: 0 })
    expect(sc.note).toBeTruthy()
    expect(sc.note).toContain('chờ dữ liệu')
  })

  test('confusion matrix + precision/recall/f1/specificity khớp tính tay', async () => {
    await seed(coreSix())
    const sc = await computeVerdictScorecard(30)
    expect(sc.n).toBe(6)
    expect(sc.tp).toBe(2)
    expect(sc.fp).toBe(1)
    expect(sc.fn).toBe(1)
    expect(sc.tn).toBe(2)
    // 2/3 = 0.666666… → round4 = 0.6667
    expect(sc.precision).toBe(0.6667)
    expect(sc.recall).toBe(0.6667)
    expect(sc.f1).toBe(0.6667)
    expect(sc.specificity).toBe(0.6667)
    expect(sc.note).toBeUndefined()
  })

  test('aucPr/brier/ece khớp công thức tính tay', async () => {
    const sc = await computeVerdictScorecard(30)
    // Brier = 1.625/6 = 0.270833… → 0.2708
    expect(sc.brier).toBe(0.2708)
    // AUC-PR = 53/90 = 0.58888… → 0.5889 (positive thật tồn tại → không null)
    expect(sc.aucPr).toBe(0.5889)
    // ECE = 0.383333… → 0.3833
    expect(sc.ece).toBe(0.3833)
  })

  test('phân tầng byAgent + forcedDowngrade.fpWithoutGuard', async () => {
    const sc = await computeVerdictScorecard(30)
    expect(sc.byAgent.length).toBe(3)
    const byName = new Map(sc.byAgent.map(a => [a.agentName, a]))
    // SENTINEL: v4(FN) v5(TN) v6(TN) → tp=0 → precision=f1=0
    const sentinel = byName.get('SENTINEL')!
    expect(sentinel.n).toBe(3)
    expect(sentinel.precision).toBe(0)
    expect(sentinel.f1).toBe(0)
    // OMEGA: 2 TP → precision=f1=1
    const omega = byName.get('OMEGA')!
    expect(omega.n).toBe(2)
    expect(omega.precision).toBe(1)
    expect(omega.f1).toBe(1)
    // CATALYST: 1 FP → precision=f1=0
    const catalyst = byName.get('CATALYST')!
    expect(catalyst.n).toBe(1)
    expect(catalyst.precision).toBe(0)
    expect(catalyst.f1).toBe(0)
    // v3 (downgrade, run KHÔNG complete) = FP bị guard chặn; v4 (downgrade,
    // run complete) = TP bị guard đánh mất → chỉ v3 tính là fpWithoutGuard
    expect(sc.forcedDowngrade.n).toBe(2)
    expect(sc.forcedDowngrade.fpWithoutGuard).toBe(1)
  })

  test('windowDays lọc đúng: 30 ngày bỏ v7, 60 ngày gồm v7', async () => {
    await seed([
      { agentName: 'OMEGA', cycle: 9, complete: true, confidence: 0.88, runComplete: true, createdAt: OLD },
    ])
    const sc30 = await computeVerdictScorecard(30)
    expect(sc30.n).toBe(6) // v7 (40 ngày) bị loại
    const sc60 = await computeVerdictScorecard(60)
    expect(sc60.n).toBe(7) // v7 vào → TP thứ 3
    expect(sc60.tp).toBe(3)
    expect(sc60.fp).toBe(1)
    expect(sc60.fn).toBe(1)
    expect(sc60.tn).toBe(2)
    // P = 3/4, R = 3/4, F1 = 2·(3/4)²/(3/2) = 3/4
    expect(sc60.precision).toBe(0.75)
    expect(sc60.recall).toBe(0.75)
    expect(sc60.f1).toBe(0.75)
  })

  test('clamp windowDays: 0 → 1 ngày (vẫn thấy 6 verdict hôm nay), 10000 → 365', async () => {
    const sc0 = await computeVerdictScorecard(0)
    expect(sc0.n).toBe(6) // kẹp về 1 ngày — 6 verdict seed ở NOW
    const scBig = await computeVerdictScorecard(10_000)
    expect(scBig.n).toBe(7) // kẹp 365 — gồm v7 (40 ngày trước)
  })
})
