/**
 * ROUND-77 TESTS — P2-M1 THRESHOLD SWEEP (BLUEPRINT-STATS-LEARNING-P0-P6)
 *
 * Đo lường: buildSweepReport (phần thuần — bảng điểm/F1/AUC/khuyến nghị/mốc
 * cố định) + sweepEvaluatorThresholds (ArbiterVerdict resolved — CÙNG NGUỒN
 * P1-M1) + sweepKbConfidence (EvalResult.rawConfidence × faithfulnessMedian>0.7).
 *
 * Nguyên tắc test:
 * - DB-cô-lập (bunfig preload copy DB): WIPE ArbiterVerdict + EvalResult
 *   trong bản copy trước khi seed — dữ liệu production copy không được phép
 *   làm bẩn bảng điểm.
 * - Mọi expected DẪN NGUỒN ĐƯỢC (comment công thức) — tính tay độc lập.
 *
 * Case thuần A (6 mẫu): scores=[.9,.8,.7,.6,.5,.4], actuals=[T,T,F,T,F,F]
 *   positives=3, negatives=3. Bảng điểm (threshold giảm dần):
 *     .9: tp=1 fp=0 → P=1,   R=⅓,   F1=0.5
 *     .8: tp=2 fp=0 → P=1,   R=⅔,   F1=0.8
 *     .7: tp=2 fp=1 → P=⅔,   R=⅔,   F1=⅔
 *     .6: tp=3 fp=1 → P=.75, R=1,   F1=6/7≈0.8571
 *     .5: tp=3 fp=2 → P=.6,  R=1,   F1=0.75
 *     .4: tp=3 fp=3 → P=.5,  R=1,   F1=⅔
 *   AUC-ROC (neo gốc (0,0) chèn): ⅓·⅔ + ⅓·1 + ⅓·1 = 8/9 ≈ 0.8889
 *   AUC-PR (step): 1·⅓ + 1·⅓ + ⅔·0 + ¾·⅓ + 0 + 0 = 11/12 ≈ 0.9167
 *   max_f1 → t=.6 (0.8571) | precision≥.9 → t=.8 (nhỏ nhất đạt) | recall≥.9 → t=.6 (lớn nhất đạt)
 *
 * Case thuần D (tie-break max_f1): scores=[.9,.6,.5,.3], actuals=[T,F,F,T]
 *   positives=2. t=.9: tp=1 fp=0 → P=1, R=½, F1=⅔; t=.6: tp=1 fp=1 → P=½,R=½,F1=½;
 *   t=.5: tp=1 fp=2 → P=⅓,R=½,F1=0.4; t=.3: tp=2 fp=2 → P=½,R=1,F1=⅔.
 *   f1 đỉnh TIE ⅔ tại t=.9 (P=1) và t=.3 (P=½) → tie-break precision cao hơn → t=.9.
 *
 * Seed evaluator (6 verdict cửa sổ 30 ngày — CÙNG ma trận r76-verdict-scorecard):
 *   conf=[.90,.85,.95,.30,.20,.40], runComplete=[T,T,F,T,F,F] → positives=3
 *   AUC-PR = 53/90 ≈ 0.5889 — PHẢI KHỚP computeVerdictScorecard(30).aucPr
 *   (kiểm chứng blueprint "AUC khớp P1-M1 — cùng nguồn").
 *   max_f1 → t=.30 (P=.6,R=1,F1=.75); precision≥.9 KHÔNG đạt (P max ⅔) → vắng;
 *   recall≥.9 → t=.30 (lớn nhất trong {.30,.20} đạt R=1).
 *
 * Seed KB (5 EvalResult): raw=[.9,.8,.7,.6,.4],
 *   faith=[.9,.9,.7,.8,.2] → actual=[T,T,F,T,F] (ranh giới: faith=.7 KHÔNG
 *   > .7 → F — pin ngữ nghĩa Y calibration-train.ts:71). positives=3, negatives=2.
 *     .9: P=1,R=⅓,F1=.5 | .8: P=1,R=⅔,F1=.8 | .7: P=⅔,R=⅔,F1=⅔
 *     .6: P=¾,R=1,F1=6/7 | .4: P=.6,R=1,F1=.75
 *   AUC-ROC: ½·⅔ + ½·1 = ⅚ ≈ 0.8333 | AUC-PR: ⅓+⅓+¼ = 11/12 ≈ 0.9167
 */

import { describe, test, expect, beforeAll } from 'bun:test'
import { db } from '@/lib/db'
import {
  buildSweepReport,
  sweepEvaluatorThresholds,
  sweepKbConfidence,
} from '@/lib/eval/threshold-sweep'
import { computeVerdictScorecard } from '@/lib/eval/verdict-scorecard'

const NOW = new Date()
const OLD = new Date(Date.now() - 40 * 24 * 3600 * 1000) // ngoài cửa sổ 30 ngày

// ==================== PHẦN THUẦN — buildSweepReport ====================

describe('r77 · P2-M1 buildSweepReport (thuần)', () => {
  test('Case A: bảng điểm + F1 + AUC + 3 khuyến nghị khớp tính tay', () => {
    const r = buildSweepReport(
      'evaluator_confidence',
      [0.9, 0.8, 0.7, 0.6, 0.5, 0.4],
      [true, true, false, true, false, false],
    )
    expect(r.n).toBe(6)
    expect(r.positives).toBe(3)
    expect(r.note).toBeUndefined()

    // Bảng điểm: 1 điểm cho MỖI score duy nhất, threshold giảm dần
    expect(r.points.length).toBe(6)
    expect(r.points.map((p) => p.threshold)).toEqual([0.9, 0.8, 0.7, 0.6, 0.5, 0.4])
    const byT = new Map(r.points.map((p) => [p.threshold, p]))
    expect(byT.get(0.9)).toMatchObject({ precision: 1, recall: 0.3333, f1: 0.5, tpr: 0.3333, fpr: 0 })
    expect(byT.get(0.8)).toMatchObject({ precision: 1, recall: 0.6667, f1: 0.8, tpr: 0.6667, fpr: 0 })
    expect(byT.get(0.7)).toMatchObject({ precision: 0.6667, recall: 0.6667, f1: 0.6667, tpr: 0.6667, fpr: 0.3333 })
    expect(byT.get(0.6)).toMatchObject({ precision: 0.75, recall: 1, f1: 0.8571, tpr: 1, fpr: 0.3333 })
    expect(byT.get(0.5)).toMatchObject({ precision: 0.6, recall: 1, f1: 0.75, tpr: 1, fpr: 0.6667 })
    expect(byT.get(0.4)).toMatchObject({ precision: 0.5, recall: 1, f1: 0.6667, tpr: 1, fpr: 1 })

    // AUC-ROC = 8/9 = 0.8888… → 0.8889; AUC-PR = 11/12 = 0.9166… → 0.9167
    expect(r.aucRoc).toBe(0.8889)
    expect(r.aucPr).toBe(0.9167)

    // 3 khuyến nghị
    const byC = new Map(r.recommended.map((x) => [x.criterion, x]))
    expect(byC.get('max_f1')).toMatchObject({ threshold: 0.6, precision: 0.75, recall: 1, f1: 0.8571 })
    // precision ≥ 0.9 đạt tại t=.9 và t=.8 → chọn NHỎ NHẤT (max recall trong ràng buộc)
    expect(byC.get('precision_gte_0.9')).toMatchObject({ threshold: 0.8, precision: 1, recall: 0.6667, f1: 0.8 })
    // recall ≥ 0.9 đạt tại t=.6/.5/.4 → chọn LỚN NHẤT (max precision trong ràng buộc)
    expect(byC.get('recall_gte_0.9')).toMatchObject({ threshold: 0.6, precision: 0.75, recall: 1, f1: 0.8571 })
  })

  test('Case A: mốc cố định 0.05..0.95 — đủ 19 mốc, chứa 0.1..0.9, khớp tính tay', () => {
    const r = buildSweepReport(
      'kb_confidence',
      [0.9, 0.8, 0.7, 0.6, 0.5, 0.4],
      [true, true, false, true, false, false],
    )
    expect(r.fixedMarks.length).toBe(19)
    expect(r.fixedMarks[0].threshold).toBe(0.05)
    expect(r.fixedMarks[18].threshold).toBe(0.95)
    // chứa đủ mốc 0.1..0.9 (kiểm chứng blueprint §P2-M1)
    const marks = new Set(r.fixedMarks.map((m) => m.threshold))
    for (const m of [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9]) {
      expect(marks.has(m)).toBe(true)
    }
    const byM = new Map(r.fixedMarks.map((m) => [m.threshold, m]))
    // 0.95 > max score → không dự đoán gì → P=R=F1=0
    expect(byM.get(0.95)).toMatchObject({ precision: 0, recall: 0, f1: 0 })
    // 0.85: chỉ score .9 → tp=1 fp=0
    expect(byM.get(0.85)).toMatchObject({ precision: 1, recall: 0.3333, f1: 0.5 })
    // 0.65: {.9,.8,.7} → tp=2 fp=1
    expect(byM.get(0.65)).toMatchObject({ precision: 0.6667, recall: 0.6667, f1: 0.6667 })
    // 0.55: {.9,.8,.7,.6} → tp=3 fp=1
    expect(byM.get(0.55)).toMatchObject({ precision: 0.75, recall: 1, f1: 0.8571 })
    // 0.3: tất cả → tp=3 fp=3
    expect(byM.get(0.3)).toMatchObject({ precision: 0.5, recall: 1, f1: 0.6667 })
  })

  test('Case D: max_f1 TIE ⅔ ở t=.9 (P=1) và t=.3 (P=½) → precision cao hơn thắng', () => {
    const r = buildSweepReport('evaluator_confidence', [0.9, 0.6, 0.5, 0.3], [true, false, false, true])
    expect(r.positives).toBe(2)
    const byC = new Map(r.recommended.map((x) => [x.criterion, x]))
    expect(byC.get('max_f1')).toMatchObject({ threshold: 0.9, precision: 1, recall: 0.5, f1: 0.6667 })
    // precision ≥ .9: chỉ t=.9 (P=1); recall ≥ .9: chỉ t=.3 (R=1)
    expect(byC.get('precision_gte_0.9')).toMatchObject({ threshold: 0.9 })
    expect(byC.get('recall_gte_0.9')).toMatchObject({ threshold: 0.3, precision: 0.5, f1: 0.6667 })
  })

  test('0 positive thật → aucPr null + recommended rỗng + note (precision/f1 vô nghĩa)', () => {
    const r = buildSweepReport('kb_confidence', [0.9, 0.5], [false, false])
    expect(r.n).toBe(2)
    expect(r.positives).toBe(0)
    expect(r.aucPr).toBeNull()
    expect(r.recommended).toEqual([])
    expect(r.note).toContain('0/2')
    // AUC-ROC vẫn định nghĩa (đường cong dưới đường chéo)
    expect(typeof r.aucRoc).toBe('number')
  })

  test('rỗng → zero-state n=0 + note, KHÔNG throw', () => {
    const r = buildSweepReport('kb_confidence', [], [])
    expect(r.n).toBe(0)
    expect(r.aucPr).toBeNull()
    expect(r.aucRoc).toBeNull()
    expect(r.points).toEqual([])
    expect(r.fixedMarks).toEqual([])
    expect(r.recommended).toEqual([])
    expect(r.note).toContain('chờ dữ liệu')
  })

  test('length mismatch → throw (lỗi lời gọi, không phải dữ liệu)', () => {
    expect(() => buildSweepReport('kb_confidence', [0.5], [true, false])).toThrow()
  })

  test('không mutate đầu vào (scores/actuals giữ nguyên)', () => {
    const scores = [0.9, 0.5, 0.5]
    const actuals = [true, false, true]
    buildSweepReport('kb_confidence', scores, actuals)
    expect(scores).toEqual([0.9, 0.5, 0.5])
    expect(actuals).toEqual([true, false, true])
  })
})

// ==================== DB — sweepEvaluatorThresholds / sweepKbConfidence ====================

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

async function seedVerdicts(rows: SeedVerdict[]): Promise<void> {
  for (const v of rows) {
    await db.arbiterVerdict.create({
      data: {
        sessionId: 'test-r77-sweep',
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

/** 6 verdict trong cửa sổ 30 ngày — cùng ma trận r76-verdict-scorecard */
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

async function seedKb(rows: Array<{ raw: number; faith: number }>): Promise<void> {
  const run = await db.evalRun.create({
    data: { status: 'completed', caseCount: rows.length, processedCount: rows.length, startedAt: NOW },
  })
  for (const [i, r] of rows.entries()) {
    await db.evalResult.create({
      data: {
        runId: run.id,
        caseId: `r77-case-${i}`,
        answer: 'seed',
        rawConfidence: r.raw,
        faithfulnessMedian: r.faith,
        createdAt: NOW,
      },
    })
  }
}

describe('r77 · P2-M1 sweep trên DB', () => {
  beforeAll(async () => {
    // WIPE trong bản copy cô lập — bảng điểm phải deterministic theo seed
    await db.arbiterVerdict.deleteMany({})
    await db.evalResult.deleteMany({})
    await db.evalRun.deleteMany({})
  })

  test('zero-state: ArbiterVerdict trống → n=0 + note, KHÔNG throw', async () => {
    const r = await sweepEvaluatorThresholds(30)
    expect(r.target).toBe('evaluator_confidence')
    expect(r.n).toBe(0)
    expect(r.aucPr).toBeNull()
    expect(r.aucRoc).toBeNull()
    expect(r.recommended).toEqual([])
    expect(r.note).toContain('chờ dữ liệu')
  })

  test('zero-state: EvalResult trống → n=0 + note, KHÔNG throw', async () => {
    const r = await sweepKbConfidence()
    expect(r.target).toBe('kb_confidence')
    expect(r.n).toBe(0)
    expect(r.recommended).toEqual([])
    expect(r.note).toContain('chờ dữ liệu')
  })

  test('evaluator: bảng điểm + AUC-PR 53/90 + khuyến nghị khớp tính tay', async () => {
    await seedVerdicts(coreSix())
    const r = await sweepEvaluatorThresholds(30)
    expect(r.n).toBe(6)
    expect(r.positives).toBe(3)

    // Bảng điểm tại score quan sát được (threshold giảm dần)
    expect(r.points.map((p) => p.threshold)).toEqual([0.95, 0.9, 0.85, 0.4, 0.3, 0.2])
    const byT = new Map(r.points.map((p) => [p.threshold, p]))
    expect(byT.get(0.95)).toMatchObject({ precision: 0, recall: 0, f1: 0 }) // chỉ FP (CATALYST)
    expect(byT.get(0.9)).toMatchObject({ precision: 0.5, recall: 0.3333, f1: 0.4 })
    expect(byT.get(0.85)).toMatchObject({ precision: 0.6667, recall: 0.6667, f1: 0.6667 })
    expect(byT.get(0.4)).toMatchObject({ precision: 0.5, recall: 0.6667, f1: 0.5714 })
    expect(byT.get(0.3)).toMatchObject({ precision: 0.6, recall: 1, f1: 0.75 })
    expect(byT.get(0.2)).toMatchObject({ precision: 0.5, recall: 1, f1: 0.6667 })

    // AUC-ROC = 2/9 + 1/3 = 5/9 = 0.5555… → 0.5556
    expect(r.aucRoc).toBe(0.5556)
    // AUC-PR = 1/6 + 2/9 + 1/5 = 53/90 = 0.5888… → 0.5889
    expect(r.aucPr).toBe(0.5889)

    const byC = new Map(r.recommended.map((x) => [x.criterion, x]))
    expect(byC.get('max_f1')).toMatchObject({ threshold: 0.3, precision: 0.6, recall: 1, f1: 0.75 })
    // precision ≥ 0.9 KHÔNG đạt (P max = ⅔) → tiêu chí vắng mặt
    expect(byC.has('precision_gte_0.9')).toBe(false)
    // recall ≥ 0.9 đạt tại {.3,.2} → chọn lớn nhất .3
    expect(byC.get('recall_gte_0.9')).toMatchObject({ threshold: 0.3 })
  })

  test('evaluator: AUC-PR KHỚP computeVerdictScorecard (cùng nguồn P1-M1)', async () => {
    const [sweep, sc] = await Promise.all([sweepEvaluatorThresholds(30), computeVerdictScorecard(30)])
    expect(sweep.aucPr).toBe(sc.aucPr)
    expect(sweep.n).toBe(sc.n)
  })

  test('evaluator: windowDays lọc đúng (30 loại v7, 60 gồm v7)', async () => {
    await seedVerdicts([
      { agentName: 'OMEGA', cycle: 9, complete: true, confidence: 0.88, runComplete: true, createdAt: OLD },
    ])
    const r30 = await sweepEvaluatorThresholds(30)
    expect(r30.n).toBe(6)
    const r60 = await sweepEvaluatorThresholds(60)
    expect(r60.n).toBe(7) // v7 (40 ngày, TP conf=.88) vào cửa sổ
  })

  test('kb: bảng điểm + AUC + khuyến nghị khớp tính tay; ranh giới faith=.7 → F', async () => {
    await db.evalResult.deleteMany({})
    await db.evalRun.deleteMany({})
    // r3 faith=.7: KHÔNG > .7 → actual=false (pin ngữ nghĩa Y calibration)
    await seedKb([
      { raw: 0.9, faith: 0.9 },
      { raw: 0.8, faith: 0.9 },
      { raw: 0.7, faith: 0.7 },
      { raw: 0.6, faith: 0.8 },
      { raw: 0.4, faith: 0.2 },
    ])
    const r = await sweepKbConfidence()
    expect(r.target).toBe('kb_confidence')
    expect(r.n).toBe(5)
    expect(r.positives).toBe(3)

    expect(r.points.map((p) => p.threshold)).toEqual([0.9, 0.8, 0.7, 0.6, 0.4])
    const byT = new Map(r.points.map((p) => [p.threshold, p]))
    expect(byT.get(0.9)).toMatchObject({ precision: 1, recall: 0.3333, f1: 0.5 })
    expect(byT.get(0.8)).toMatchObject({ precision: 1, recall: 0.6667, f1: 0.8 })
    expect(byT.get(0.7)).toMatchObject({ precision: 0.6667, recall: 0.6667, f1: 0.6667 })
    expect(byT.get(0.6)).toMatchObject({ precision: 0.75, recall: 1, f1: 0.8571 })
    expect(byT.get(0.4)).toMatchObject({ precision: 0.6, recall: 1, f1: 0.75 })

    // AUC-ROC = ⅓ + ½ = ⅚ = 0.8333…; AUC-PR = ⅓ + ⅓ + ¼ = 11/12 = 0.9167
    expect(r.aucRoc).toBe(0.8333)
    expect(r.aucPr).toBe(0.9167)

    const byC = new Map(r.recommended.map((x) => [x.criterion, x]))
    expect(byC.get('max_f1')).toMatchObject({ threshold: 0.6, f1: 0.8571 })
    expect(byC.get('precision_gte_0.9')).toMatchObject({ threshold: 0.8 })
    expect(byC.get('recall_gte_0.9')).toMatchObject({ threshold: 0.6 })
  })

  test('kb: mốc cố định khớp tay trên seed DB', async () => {
    const r = await sweepKbConfidence()
    const byM = new Map(r.fixedMarks.map((m) => [m.threshold, m]))
    // 0.95: không dự đoán gì
    expect(byM.get(0.95)).toMatchObject({ precision: 0, recall: 0, f1: 0 })
    // 0.65: {.9,.8,.7} → tp=2 fp=1
    expect(byM.get(0.65)).toMatchObject({ precision: 0.6667, recall: 0.6667 })
    // 0.35: tất cả → tp=3 fp=2
    expect(byM.get(0.35)).toMatchObject({ precision: 0.6, recall: 1 })
  })
})
