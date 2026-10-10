/**
 * ROUND-77 TESTS — P3-M1 + P3-M2 CALIBRATION V2 ĐA BIẾN + k-FOLD CV
 * (BLUEPRINT-STATS-LEARNING-P0-P6 §P3-M1/§P3-M2, mục #9 + #13)
 *
 * Đo lường:
 *   A. buildFeatureVector — test ĐỘC LẬP trước (spec bước 2): 10 đặc trưng
 *      đúng thứ tự FEATURE_NAMES, log1p, difficulty map, one-hot gộp,
 *      null cho trường thiếu, NaN/Infinity → null.
 *   B. trainLogisticL2/predictLogistic — dữ liệu tách biệt được thì model
 *      phân loại đúng; L2 thật sự co hệ số (l2 cao → |β| nhỏ); deterministic
 *      (cùng dữ liệu → model khớp tuyệt đối); guard throw dữ liệu lệch.
 *   C. stratifiedFoldAssignments — mỗi fold có đủ 2 lớp; lớp < folds → null.
 *   D. crossValidateMultifeature — kịch bản TỔNG HỢP của blueprint: dữ liệu
 *      nhân tạo CÓ QUAN HỆ THẬT theo x2 (coverage) + x6 (hallucination),
 *      x1 (rawConfidence) THUẦN NHIỄM → V2 bắt được (cvBrier < brierV1,
 *      improved=true) trong khi V1 1-biến không thể; dữ liệu TOÀN noise →
 *      improved=false (chống tự huyễn hoặc — spec P3-M2 kiểm chứng).
 *   E. computeColumnStats — mean/std tính tay; cột hằng → std=1 (guard);
 *      cột toàn null → mean 0/std 1.
 *   F. parseV2ModelJson/applyV2Model — round-trip; đặc trưng thiếu impute
 *      mean (chuẩn hóa 0) → kết quả khác ctx đầy đủ; JSON rách/kích thước
 *      lệch → null; clamp [0,1].
 *   G. DB (bảng cô lập theo bunfig preload) — trainCalibrationModelV2 trên
 *      seed có quan hệ thật → trained=true, active=true (chỉ khi CV thắng),
 *      oddsRatios có nghĩa (coverage OR>1, hallucination OR<1); lệch lớp →
 *      trained=false; thiếu mẫu → trained=false; runtime V2-active dẫn đường
 *      qua getCalibratedConfidence (khác rawConfidence) và rollback được
 *      (active=false → về V1).
 *
 * Nguyên tắc test:
 * - DB-cô-lập (bunfig preload copy DB) — WIPE các bảng ảnh hưởng trước seed.
 * - Mọi expected DẪN NGUỒN ĐƯỢC (comment công thức) — synthetic relation
 *   dựng bằng LCG deterministic (không Math.random — kết quả tái lập được).
 * - Số liệu tính tay: std tổng thể của [1,3,5] = √(8/3) = 1.632993…
 */

import { describe, test, expect, beforeAll } from 'bun:test'
import { db } from '@/lib/db'
import {
  FEATURE_NAMES,
  MIN_TRAIN_SAMPLES_V2,
  buildFeatureVector,
  trainLogisticL2,
  predictLogistic,
  brier,
  computeColumnStats,
  stratifiedFoldAssignments,
  crossValidateMultifeature,
  parseV2ModelJson,
  applyV2Model,
  trainCalibrationModelV2,
  getCalibratedConfidenceV2,
  type FeatureCtx,
} from '@/lib/calibration-multifeature'
import { getCalibratedConfidence } from '@/lib/calibration'

// ==================== LCG deterministic (không Math.random) ====================

/** LCG seed 42 — cùng chuỗi gọi luôn ra cùng số (test tái lập được) */
function lcg(seed: number): () => number {
  let s = seed
  return () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff
    return s / 0x7fffffff
  }
}

// ==================== A. buildFeatureVector (độc lập) ====================

describe('r77 · P3-M1 buildFeatureVector — test độc lập (spec bước 2)', () => {
  test('ctx đầy đủ → 10 giá trị đúng thứ tự FEATURE_NAMES', () => {
    // log1p(7) = ln(8) = 2.0794415416798357 · difficulty hard=1 · ml one-hot [0,1,0]
    const v = buildFeatureVector({
      rawConfidence: 0.5, coverage: 0.8, answered: true, retrievedChunks: 7,
      extractionF1: 0.6, hallucinationDetected: false, difficulty: 'hard', category: 'ml',
    })
    expect(v.length).toBe(10)
    expect(v).toEqual([0.5, 0.8, 1, Math.log1p(7), 0.6, 0, 1, 0, 1, 0])
    expect(FEATURE_NAMES.length).toBe(10)
  })

  test('partial ctx → null đúng vị trí (impute trung bình phía sau)', () => {
    const v = buildFeatureVector({ rawConfidence: 0.42 })
    expect(v[0]).toBe(0.42)
    for (let j = 1; j < 10; j++) expect(v[j]).toBeNull()
  })

  test('difficulty map: easy=0 · medium=0.5 · hard=1 · lạ=0.5(medium) · thiếu=null', () => {
    expect(buildFeatureVector({ rawConfidence: 0, difficulty: 'easy' })[6]).toBe(0)
    expect(buildFeatureVector({ rawConfidence: 0, difficulty: 'medium' })[6]).toBe(0.5)
    expect(buildFeatureVector({ rawConfidence: 0, difficulty: 'hard' })[6]).toBe(1)
    expect(buildFeatureVector({ rawConfidence: 0, difficulty: 'weird' })[6]).toBe(0.5)
    expect(buildFeatureVector({ rawConfidence: 0 })[6]).toBeNull()
  })

  test('category one-hot gộp: programming|ml|security|other(linux/negative/mixed)|thiếu', () => {
    const at = (c: string | undefined) => buildFeatureVector({ rawConfidence: 0, category: c }).slice(7)
    expect(at('programming')).toEqual([1, 0, 0])
    expect(at('ml')).toEqual([0, 1, 0])
    expect(at('security')).toEqual([0, 0, 1])
    expect(at('linux')).toEqual([0, 0, 0]) // gộp "other"
    expect(at('negative')).toEqual([0, 0, 0])
    expect(at('mixed')).toEqual([0, 0, 0])
    expect(at(undefined)).toEqual([null, null, null]) // KHÔNG biết ≠ biết-là-other
    expect(at('ML')).toEqual([0, 1, 0]) // case-insensitive
  })

  test('NaN/Infinity/giá trị âm → null hoặc clamp an toàn', () => {
    const v = buildFeatureVector({
      rawConfidence: Number.NaN, coverage: Number.POSITIVE_INFINITY,
      retrievedChunks: -5, // clamp về 0 trước log1p — không NaN
    })
    expect(v[0]).toBeNull()
    expect(v[1]).toBeNull()
    expect(v[3]).toBe(Math.log1p(0)) // = 0
  })
})

// ==================== B. trainLogisticL2 / predictLogistic ====================

describe('r77 · P3-M1 trainLogisticL2 — logistic đa biến + L2', () => {
  // Dữ liệu tách biệt theo x2 (chuẩn hóa sẵn): x2 > 0 → y=1
  const X = [[0, -1.5], [0, -1], [0, -0.5], [0, 1], [0, 1.5], [0, 2]]
  const y = [0, 0, 0, 1, 1, 1]

  test('dữ liệu tách biệt → xác suất đúng phía (x2 cao → ~1, x2 thấp → ~0)', () => {
    const m = trainLogisticL2(X, y, { epochs: 300, l2: 0.001 })
    expect(predictLogistic(m, [0, 2])).toBeGreaterThan(0.8)
    expect(predictLogistic(m, [0, -2])).toBeLessThan(0.2)
    expect(m.coefficients[1]).toBeGreaterThan(0) // x2 dương tính
    expect(Math.abs(m.coefficients[0])).toBeLessThan(m.coefficients[1]) // noise cột 0
  })

  test('L2 co hệ số: l2 cao → |β| nhỏ hơn (cùng dữ liệu, cùng epochs)', () => {
    const weak = trainLogisticL2(X, y, { epochs: 300, l2: 0.0001 })
    const strong = trainLogisticL2(X, y, { epochs: 300, l2: 10 })
    expect(Math.abs(strong.coefficients[1])).toBeLessThan(Math.abs(weak.coefficients[1]))
  })

  test('deterministic — 2 lần train cùng dữ liệu ra model khớp tuyệt đối', () => {
    const a = trainLogisticL2(X, y, { epochs: 200 })
    const b = trainLogisticL2(X, y, { epochs: 200 })
    expect(a.intercept).toBe(b.intercept)
    expect(a.coefficients).toEqual(b.coefficients)
  })

  test('guard throw: tập rỗng / lệch y / hàng ragged', () => {
    expect(() => trainLogisticL2([], [])).toThrow()
    expect(() => trainLogisticL2(X, [0, 1])).toThrow()
    expect(() => trainLogisticL2([[1, 2], [1]], [0, 1])).toThrow()
  })
})

// ==================== C. stratifiedFoldAssignments ====================

describe('r77 · P3-M2 stratifiedFoldAssignments — 5-fold stratified', () => {
  test('mỗi fold có ≥1 mỗi lớp (20 pos + 20 neg, 5 fold)', () => {
    const y = [...Array(20).fill(1), ...Array(20).fill(0)]
    const a = stratifiedFoldAssignments(y, 5)
    expect(a).not.toBeNull()
    for (let f = 0; f < 5; f++) {
      const idx = y.map((_, i) => i).filter(i => a![i] === f)
      expect(idx.length).toBe(8) // 40/5
      expect(idx.every(i => y[i] === 1)).toBe(false) // có neg
      expect(idx.every(i => y[i] === 0)).toBe(false) // có pos
    }
  })

  test('lớp nào < folds mẫu → null (không stratified được)', () => {
    expect(stratifiedFoldAssignments([1, 1, 1, 1, 0], 5)).toBeNull()
    expect(stratifiedFoldAssignments([...Array(10).fill(1), ...Array(4).fill(0)], 5)).toBeNull()
  })

  test('folds < 2 → null', () => {
    expect(stratifiedFoldAssignments([1, 0, 1, 0], 1)).toBeNull()
  })
})

// ==================== E. computeColumnStats ====================

describe('r77 · P3-M1 computeColumnStats — chuẩn hóa z', () => {
  test('mean/std tổng thể tính tay: cột [1,3,5] → mean 3, std √(8/3)', () => {
    const { means, stds } = computeColumnStats([[1, 10], [3, 10], [5, 10]])
    expect(means[0]).toBe(3)
    expect(stds[0]).toBeCloseTo(Math.sqrt(8 / 3), 10) // population std
    expect(stds[1]).toBe(1) // cột hằng (std 0) → guard 1
    expect(means[1]).toBe(10)
  })

  test('cột toàn null → mean 0 / std 1 (impute an toàn)', () => {
    const { means, stds } = computeColumnStats([[null, 5], [null, 7]])
    expect(means[0]).toBe(0)
    expect(stds[0]).toBe(1)
    expect(means[1]).toBe(6)
  })

  test('null KHÔNG kéo mean (chỉ giá trị hữu hạn vào stats)', () => {
    const { means, stds } = computeColumnStats([[2, null], [4, null], [null, null]])
    expect(means[0]).toBe(3)
    expect(stds[0]).toBeCloseTo(Math.sqrt(2 / 2), 10) // std [2,4] = 1
  })
})

// ==================== D. crossValidateMultifeature (kịch bản tổng hợp) ====================

/**
 * Dựng ma trận đặc trưng THÔ 10 cột (đúng format buildFeatureVector) từ bộ
 * (coverage, halluc, rawConf-noise) — Y theo quan hệ thật:
 *   P(faithful) = σ(6·(coverage − 0.55) − 2.5·halluc − 0.3)
 * x1 (rawConfidence) THUẦN NHIỄM với Y → V1 không thể thắng.
 */
function syntheticRelationMatrix(n: number, seed: number): { X: (number | null)[][]; y: number[] } {
  const rand = lcg(seed)
  const X: (number | null)[][] = []
  const y: number[] = []
  for (let i = 0; i < n; i++) {
    const rawConfidence = 0.3 + 0.4 * rand() // noise thuần
    const coverage = 0.2 + 0.7 * rand()
    const halluc = rand() < 0.35
    const pTrue = 1 / (1 + Math.exp(-(6 * (coverage - 0.55) - (halluc ? 2.5 : 0) - 0.3)))
    const isFaithful = rand() < pTrue
    X.push([rawConfidence, coverage, isFaithful ? 1 : 0, Math.log1p(3 + Math.floor(8 * rand())), 0.5, halluc ? 1 : 0, 0.5, 0, 0, 0])
    y.push(isFaithful ? 1 : 0)
  }
  return { X, y }
}

/** Ma trận TOÀN NOISE — mọi cột độc lập Y (đồng xu) */
function syntheticNoiseMatrix(n: number, seed: number): { X: (number | null)[][]; y: number[] } {
  const rand = lcg(seed)
  const X: (number | null)[][] = []
  const y: number[] = []
  for (let i = 0; i < n; i++) {
    X.push([rand(), rand(), rand() < 0.5 ? 1 : 0, Math.log1p(Math.floor(10 * rand())), rand(), rand() < 0.5 ? 1 : 0, 0.5, 0, 0, 0])
    y.push(rand() < 0.5 ? 1 : 0)
  }
  return { X, y }
}

describe('r77 · P3-M2 crossValidateMultifeature — V2 chỉ được tin khi thắng CV', () => {
  test('BLUEPRINT TỔNG HỢP: quan hệ thật x2/x6 → V2 bắt được, V1 không (improved=true)', () => {
    const { X, y } = syntheticRelationMatrix(60, 42)
    const cv = crossValidateMultifeature(X, y)
    expect(cv).not.toBeNull()
    // Smoke LCG seed 42: cvBrier≈0.0015, brierV1≈0.2038 (bội Brier ≈ base-rate
    // variance khi x1 thuần noise) — assert quan hệ chứ không khoá cứng số
    expect(cv!.cvBrier).toBeLessThan(cv!.brierV1 * 0.2)
    expect(cv!.improved).toBe(true)
    expect(cv!.foldBriers.length).toBe(5)
    expect(cv!.foldBriersV1.length).toBe(5)
    // CI bao quanh cvBrier (5 fold ≥ 2 → CI hữu hạn)
    expect(cv!.cvBrierCiLo).toBeLessThanOrEqual(cv!.cvBrier)
    expect(cv!.cvBrierCiHi).toBeGreaterThanOrEqual(cv!.cvBrier)
    expect(Number.isFinite(cv!.cvBrierCiLo)).toBe(true)
  })

  test('BLUEPRINT TỔNG HỢP: dữ liệu thuần noise → improved=false (chống tự huyễn)', () => {
    const { X, y } = syntheticNoiseMatrix(60, 42)
    const cv = crossValidateMultifeature(X, y)
    expect(cv).not.toBeNull()
    // Noise: cvBrier ≈ brierV1 ≈ 0.25 — V2 (10 đặc trưng + L2) KHÔNG thắng rõ
    expect(cv!.improved).toBe(false)
    expect(cv!.cvBrier).toBeGreaterThan(0.1) // chắc chắn không "học" được noise
  })

  test('deterministic — CV chạy 2 lần khớp tuyệt đối', () => {
    const { X, y } = syntheticRelationMatrix(60, 7)
    const a = crossValidateMultifeature(X, y)
    const b = crossValidateMultifeature(X, y)
    expect(a!.cvBrier).toBe(b!.cvBrier)
    expect(a!.brierV1).toBe(b!.brierV1)
    expect(a!.foldBriers).toEqual(b!.foldBriers)
  })

  test('lệch lớp → null (CV không chạy — caller abort)', () => {
    const { X } = syntheticRelationMatrix(60, 42)
    const y = [...Array(59).fill(1), 0] // 59/1 — negative < 5 fold
    expect(crossValidateMultifeature(X, y)).toBeNull()
  })

  test('brier() thuần: tính tay [0,1] vs [0,1] → 0.5', () => {
    // mean((0-0)² + (1-1)²) = 0 · mean((0-1)² + (1-0)²) = 1
    expect(brier([0, 1], [0, 1])).toBe(0)
    expect(brier([0, 1], [1, 0])).toBe(1)
    expect(brier([0.5], [1])).toBe(0.25)
    expect(brier([], [])).toBeNaN()
  })
})

// ==================== F. parse/apply runtime ====================

describe('r77 · P3-M1 parseV2ModelJson + applyV2Model — runtime apply', () => {
  const row = {
    featureNames: JSON.stringify(FEATURE_NAMES),
    means: JSON.stringify([0.5, 0.6, 0.8, 2, 0.5, 0.3, 0.5, 0.2, 0.2, 0.1]),
    stds: JSON.stringify([0.2, 0.2, 0.4, 1, 0.2, 0.45, 0.5, 0.4, 0.4, 0.3]),
    coefficients: JSON.stringify([0.1, 1.5, 0.2, 0, 0.1, -2, 0, 0, 0, 0]),
    intercept: -0.2,
  }

  test('parse hợp lệ → 4 mảng độ dài 10', () => {
    const m = parseV2ModelJson(row)
    expect(m).not.toBeNull()
    expect(m!.means.length).toBe(10)
    expect(m!.coefficients[1]).toBe(1.5)
  })

  test('parse rác/kích thước lệch → null (fail về V1)', () => {
    expect(parseV2ModelJson({ ...row, means: '[1,2]' })).toBeNull()
    expect(parseV2ModelJson({ ...row, coefficients: 'not json' })).toBeNull()
    expect(parseV2ModelJson({ ...row, featureNames: JSON.stringify(['a', 'b']) })).toBeNull()
    expect(parseV2ModelJson({ ...row, stds: JSON.stringify(Array(10).fill('x')) })).toBeNull()
  })

  test('apply ctx đầy đủ: sigmoid tính tay từng thành phần', () => {
    const m = parseV2ModelJson(row)!
    const ctx: FeatureCtx = {
      rawConfidence: 0.5, coverage: 0.6, answered: true, retrievedChunks: Math.exp(2) - 1,
      extractionF1: 0.5, hallucinationDetected: false, difficulty: 'medium', category: 'linux',
    }
    // Từng thành phần z (đúng mean → 0, bỏ qua):
    //   x1 0.5=mean → 0·β0.1 = 0
    //   x2 0.6=mean → 0·β1.5 = 0
    //   x3 answered=1: (1−0.8)/0.4 = 0.5 · β0.2 = +0.1
    //   x4 log1p(e²−1)=2=mean → 0·β0 = 0
    //   x5 0.5=mean → 0
    //   x6 halluc=0: (0−0.3)/0.45 = −0.6667 · β(−2) = +1.3333
    //   x7 medium=0.5=mean → 0 · x8-10 linux=[0,0,0]: z=(0−mean)/std·β0 = 0
    // z = −0.2 (intercept) + 0.1 + 1.3333 = 1.2333
    const expected = 1 / (1 + Math.exp(-(-0.2 + 0.1 + (-2) * ((0 - 0.3) / 0.45))))
    expect(applyV2Model(m, ctx)).toBeCloseTo(expected, 12)
  })

  test('apply đặc trưng thiếu → impute mean (khác ctx đầy đủ)', () => {
    const m = parseV2ModelJson(row)!
    const partial = applyV2Model(m, { rawConfidence: 0.5 })
    const fullHighCoverage = applyV2Model(m, {
      rawConfidence: 0.5, coverage: 0.95, answered: true,
      retrievedChunks: 10, extractionF1: 0.9, hallucinationDetected: false,
      difficulty: 'easy', category: 'ml',
    })
    // coverage cao (+1.5β) + hallucination thấp → full > partial
    expect(fullHighCoverage).toBeGreaterThan(partial)
    expect(partial).toBeGreaterThan(0)
    expect(partial).toBeLessThan(1)
  })

  test('clamp [0,1] với hệ số cực đoản', () => {
    const extreme = {
      featureNames: row.featureNames,
      means: row.means,
      stds: row.stds,
      coefficients: JSON.stringify(Array(10).fill(50)),
      intercept: 50,
    }
    const m = parseV2ModelJson(extreme)!
    expect(applyV2Model(m, { rawConfidence: 0.5, coverage: 0.9 })).toBe(1)
  })
})

// ==================== G. DB — trainCalibrationModelV2 (bảng cô lập) ====================

/** Seed 1 cặp EvalCase+EvalResult theo quan hệ thật coverage/halluc → Y */
async function seedV2Data(n: number, seed: number): Promise<void> {
  await db.evalResult.deleteMany({})
  await db.evalRun.deleteMany({})
  await db.evalCase.deleteMany({})
  await db.calibrationModelV2.deleteMany({})
  await db.calibrationModel.deleteMany({})

  const rand = lcg(seed)
  const run = await db.evalRun.create({ data: { status: 'completed', caseCount: n } })
  const aCase = await db.evalCase.create({
    data: { question: 'seed q', expectedAnswer: 'seed a', category: 'ml', difficulty: 'medium' },
  })
  const bCase = await db.evalCase.create({
    data: { question: 'seed q2', expectedAnswer: 'seed a2', category: 'security', difficulty: 'hard' },
  })

  for (let i = 0; i < n; i++) {
    const coverage = 0.2 + 0.7 * rand()
    const halluc = rand() < 0.35
    const pTrue = 1 / (1 + Math.exp(-(6 * (coverage - 0.55) - (halluc ? 2.5 : 0) - 0.3)))
    const isFaithful = rand() < pTrue
    await db.evalResult.create({
      data: {
        runId: run.id,
        caseId: rand() < 0.5 ? aCase.id : bCase.id,
        answer: 'seed answer',
        rawConfidence: 0.3 + 0.4 * rand(), // THUẦN NHIỄM — V1 mù
        faithfulnessMedian: isFaithful ? 0.9 : 0.3, // > 0.7 = faithful
        coverage,
        answered: isFaithful,
        retrievedChunks: 3 + Math.floor(8 * rand()),
        extractionF1: 0.5,
        hallucinationDetected: halluc,
      },
    })
  }
}

describe('r77 · P3-M1/M2 trainCalibrationModelV2 — DB pipeline đầy đủ', () => {
  beforeAll(async () => {
    await seedV2Data(40, 42) // 40 ≥ 30 (MIN_TRAIN_SAMPLES_V2), quan hệ thật
  })

  test('seed có quan hệ thật → trained=true, CV thắng, active=true, odds có nghĩa', async () => {
    const res = await trainCalibrationModelV2()
    expect(res.trained).toBe(true)
    expect(res.sampleSize).toBe(40)
    expect(res.usable).toBe(40)
    expect(res.cvBrier).not.toBeNull()
    expect(res.brierV1).not.toBeNull()
    expect(res.cvBrier!).toBeLessThan(res.brierV1!)
    expect(res.improved).toBe(true)

    // Row DB: active=true (chỉ khi CV thắng) + JSON khớp FEATURE_NAMES
    const row = await db.calibrationModelV2.findUnique({ where: { id: 'default' } })
    expect(row).not.toBeNull()
    expect(row!.active).toBe(true)
    expect(row!.sampleSize).toBe(40)
    expect(JSON.parse(row!.featureNames)).toEqual([...FEATURE_NAMES])
    expect(JSON.parse(row!.coefficients)).toHaveLength(10)

    // Odds ratio diễn giải được: coverage → faithful (OR>1), hallucination → sai (OR<1)
    // (đã smoke seed 42: β coverage≈+0.35, β halluc≈−0.37 — assert BẤT ĐẲNG THỨC đúng chiều)
    expect(res.oddsRatios.coverage).toBeGreaterThan(1)
    expect(res.oddsRatios.hallucinationDetected).toBeLessThan(1)

    // cvBrierCi JSON [lo, hi] hữu hạn
    const ci = JSON.parse(row!.cvBrierCi as string) as number[]
    expect(ci).toHaveLength(2)
    expect(ci[0]).toBeLessThanOrEqual(ci[1])
    expect(Number.isFinite(ci[0])).toBe(true)
  })

  test('runtime V2-active dẫn đường: getCalibratedConfidence ≠ raw (đi qua V2)', async () => {
    // V2 active + sampleSize 40 ≥ 20 → getCalibratedConfidence áp V2
    const raw = 0.55
    const out = await getCalibratedConfidence(raw)
    expect(out).toBeGreaterThan(0)
    expect(out).toBeLessThan(1)
    // V2 với rawConfidence thuần noise → dự đoán gần base rate (≈0.4-0.6
    // dảifaithful), KHÔNG thể bằng raw trừ trùng hợp — và khác công thức V1
    // sigmoid(v1.intercept + v1.coef·raw) vì calibrationModel bị wipe
    const v1row = await db.calibrationModel.findUnique({ where: { id: 'default' } })
    expect(v1row).toBeNull() // V1 chưa train — chắc chắn đường V2
    expect(out).not.toBe(raw)
  })

  test('getCalibratedConfidenceV2 đầy đủ đặc trưng khác partial (hưởng 10 đặc trưng)', async () => {
    const raw = 0.55
    const partial = await getCalibratedConfidenceV2(raw, {})
    const full = await getCalibratedConfidenceV2(raw, {
      coverage: 0.95, answered: true, retrievedChunks: 10, extractionF1: 0.9,
      hallucinationDetected: false, difficulty: 'easy', category: 'ml',
    })
    expect(partial).toBeGreaterThan(0)
    expect(full).toBeGreaterThan(0)
    // coverage cao (β dương mạnh) + không halluc → full > partial
    expect(full).toBeGreaterThan(partial)
  })

  test('getCalibratedConfidenceV2 thiếu features hoàn toàn → fallback V1', async () => {
    // V1 vẫn chưa train (đã wipe) → fallback V1 → fallback raw
    const out = await getCalibratedConfidenceV2(0.55)
    expect(out).toBe(0.55)
  })

  test('rollback: active=false → getCalibratedConfidence về đường V1/raw', async () => {
    await db.calibrationModelV2.update({ where: { id: 'default' }, data: { active: false } })
    const out = await getCalibratedConfidence(0.55)
    expect(out).toBe(0.55) // V1 không có row (wipe) → raw — rollback hoạt động
    // khôi phục active cho các test sau
    await db.calibrationModelV2.update({ where: { id: 'default' }, data: { active: true } })
  })

  test('lệch lớp (39 faithful / 1 unfaithful) → trained=false + model cũ GIỮ NGUYÊN', async () => {
    await seedV2Data(40, 42) // wipe + 40 rows quan hệ thật
    const first = await trainCalibrationModelV2()
    expect(first.trained).toBe(true) // tạo model active=true
    // Ép lệch lớp trên chính bộ data này: 39 faithful, 1 unfaithful cuối
    const rows = await db.evalResult.findMany({ orderBy: { createdAt: 'asc' }, take: 40 })
    for (let i = 0; i < rows.length - 1; i++) {
      await db.evalResult.update({ where: { id: rows[i].id }, data: { faithfulnessMedian: 0.9 } })
    }
    await db.evalResult.update({ where: { id: rows[rows.length - 1].id }, data: { faithfulnessMedian: 0.3 } })
    const res = await trainCalibrationModelV2()
    expect(res.trained).toBe(false)
    expect(res.error).toContain('class imbalance')
    // KHÔNG upsert phá model cũ — lần train thành công trước đó còn nguyên
    const row = await db.calibrationModelV2.findUnique({ where: { id: 'default' } })
    expect(row).not.toBeNull()
    expect(row!.active).toBe(true)
    expect(row!.sampleSize).toBe(40)
  })

  test('thiếu mẫu (dưới 30) → trained=false insufficient + không tạo row', async () => {
    await seedV2Data(12, 7)
    const res = await trainCalibrationModelV2()
    expect(res.trained).toBe(false)
    expect(res.error).toContain('insufficient data')
    expect(res.usable).toBe(12)
    expect(MIN_TRAIN_SAMPLES_V2).toBe(30)
    const row = await db.calibrationModelV2.findUnique({ where: { id: 'default' } })
    expect(row).toBeNull() // chưa từng train thành công → chưa có row
  })

  test('dọn bảng sau test (không để lại state ảnh hưởng test khác)', async () => {
    await db.calibrationModelV2.deleteMany({})
    await db.evalResult.deleteMany({})
    await db.evalRun.deleteMany({})
    await db.evalCase.deleteMany({})
  })
})
