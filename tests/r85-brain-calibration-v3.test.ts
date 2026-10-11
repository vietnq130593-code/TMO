/**
 * ROUND-85 TESTS — BRAIN-P2 · BRAIN-A "V3" CALIBRATION MLP (blueprint §4.2)
 *
 * Đo lường:
 *   A. buildV3Spec — pin kiến trúc khởi điểm 10→16(tanh)→1(sigmoid)+BCE
 *      (adam, seed 42): validateSpec chạy qua, paramCount = 193 (10·16+16 +
 *      16·1+1) xa trần BRAIN_MAX_PARAMS 250K; 2 lần build deep-equal.
 *   B. crossValidateV3 (thuần, không DB) — kỷ luật thăng cấp kế thừa V2:
 *      dữ liệu XOR CÓ QUAN HỆ THẬT (coverage XOR hallucination quyết định
 *      faithful; rawConfidence thuần nhiễm; answered độc lập — không rò rỉ
 *      nhãn) → MLP bắt được tương tác phi tuyến → improved=true trong khi
 *      brierV2 kẹt gần base-rate (logistic tuyến tính KHÔNG biểu diễn được
 *      XOR); dữ liệu TOÀN NOISE → improved=false (chống tự huyễn hoặc);
 *      lệch lớp (một lớp < 5) → null (không fallback CV thường).
 *   C. trainBrainCalibrationV3 (DB cô lập) — thiếu mẫu < 30 → trained=false
 *      (ngủ an toàn); inputMode vector 'mrl-512' → từ chối rõ (chờ Q2);
 *      XOR 150 mẫu → trained=true, active=true v1, BrainModel đầy đủ
 *      (specJson parse được, weightsJson deserialize + predict được,
 *      trainMeta nSamples/cvScore/brierV2/standardization 10 chiều/
 *      dataLineage); train lần 2 → v2, đúng 1 active (bất biến A1),
 *      weightsJson BIT-ĐỐI-BIT v1 (tất định theo seed); prune A2 giữ
 *      bản active + 5 mới nhất; noise train sau → bản mới active=false
 *      KHÔNG đụng bản active cũ (thua CV giữ nguyên現 trạng).
 *   D. Runtime fail-open mọi nhánh: cờ off (mặc định) → null kể cả khi có
 *      bản active; cờ on + active + đủ mẫu → số ∈ [0,1] dẫn đường
 *      getCalibratedConfidence; cờ on + rollback active=false → null;
 *      cờ on + weightsJson rách → null; cờ on + nSamples < 20 → null;
 *      applyV3Model thuần: đặc trưng thiếu impute 0 chuẩn hóa, clamp [0,1].
 *   E. Cờ calibration_v3 (STORE > ENV > DEFAULT=off): spec pin trong
 *      TUNING_SPECS (default off, enum [off|on], envKey CALIBRATION_V3);
 *      ENV 'on' thắng default; STORE thắng ENV; reset về default;
 *      BRAIN_TRAINABLE_KEYS/BRAIN_TRAINING_IMPLEMENTED pin.
 *   F. Chuỗi đầy đủ getCalibratedConfidence (V3→V2→V1→raw): V3 active +
 *      cờ on → đúng giá trị tryCalibrationV3; V3 deactive + V2-active
 *      (seed tay, hệ số biết trước → σ(2) = 0.880797…) → rơi đúng V2;
 *      không model nào → trả raw nguyên vẹn.
 *
 * Nguyên tắc test:
 * - DB-cô-lập (bunfig preload copy DB) — WIPE các bảng ảnh hưởng trước seed;
 *   tuning param calibration_v3 + env CALIBRATION_V3 dọn ở beforeAll VÀ
 *   afterAll (snapshot tuning-store là process-global — không rò ra file
 *   test khác).
 * - Mọi expected DẪN NGUỒN ĐƯỢC (comment công thức) — synthetic relation
 *   dựng bằng LCG deterministic (không Math.random — kết quả tái lập được).
 * - Số liệu chấm trước bằng smoke độc lập (XOR: cvBrierV3 ≈ 0.11–0.14 vs
 *   brierV2 ≈ 0.26 ở n=150/80/120 — 3 seed; noise: improved=false n=150/200).
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { db } from '@/lib/db'
import { MLP, validateSpec, BRAIN_MAX_PARAMS } from '@/lib/brain/mlp'
import {
  buildV3Spec,
  crossValidateV3,
  trainBrainCalibrationV3,
  tryCalibrationV3,
  loadActiveV3,
  applyV3Model,
  isCalibrationV3Enabled,
  MIN_TRAIN_SAMPLES_V3,
  MIN_RUNTIME_SAMPLES_V3,
  V3_INPUT_MODE,
  V3_SEED,
  type ActiveV3Model,
} from '@/lib/brain/calibration-v3'
import {
  FEATURE_NAMES,
  buildFeatureVector,
  type FeatureCtx,
} from '@/lib/calibration-multifeature'
import { getCalibratedConfidence } from '@/lib/calibration'
import {
  TUNING_SPECS,
} from '@/lib/learning/neural-types'
import {
  getTuningEnum,
  setTuningValue,
  resetTuningValue,
  refreshTuningSnapshot,
  validateTuningInput,
} from '@/lib/learning/tuning-store'
import {
  BRAIN_TRAINABLE_KEYS,
  BRAIN_TRAINING_IMPLEMENTED,
  BRAIN_VERSIONS_KEEP,
} from '@/lib/brain/registry'

// ==================== LCG deterministic (không Math.random) ====================

/** LCG — cùng chuỗi gọi luôn ra cùng số (test tái lập được) */
function lcg(seed: number): () => number {
  let s = seed
  return () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff
    return s / 0x7fffffff
  }
}

// ==================== SEED DATA (XOR quan hệ thật / noise) ====================

/**
 * Dựng ctx đặc trưng XOR: faithful ⟺ (coverage > 0.5) XOR hallucination,
 * 8% label noise; MỌI đặc trưng khác thuần nhiễm/độc lập (rawConfidence
 * noise, answered coin-flip KHÔNG rò rỉ nhãn, extractionF1 hằng) — V2
 * logistic không thể biểu diễn XOR → brierV2 kẹt gần base-rate; MLP 16
 * tanh bắt được (smoke: 0.11–0.14 vs 0.26 ở n = 150/80/120).
 */
function xorCtxs(n: number, seed: number): { ctxs: FeatureCtx[]; y: number[] } {
  const rand = lcg(seed)
  const ctxs: FeatureCtx[] = []
  const y: number[] = []
  for (let i = 0; i < n; i++) {
    const coverage = 0.15 + 0.7 * rand()
    const halluc = rand() < 0.5
    const xorVal = (coverage > 0.5) !== halluc
    const isFaithful = rand() < 0.92 ? xorVal : !xorVal
    ctxs.push({
      rawConfidence: 0.3 + 0.4 * rand(),
      coverage,
      answered: rand() < 0.5,
      retrievedChunks: 3 + Math.floor(8 * rand()),
      extractionF1: 0.5,
      hallucinationDetected: halluc,
      difficulty: 'medium',
      category: 'ml',
    })
    y.push(isFaithful ? 1 : 0)
  }
  return { ctxs, y }
}

/** Dựng ctx TOÀN NOISE (nhãn coin-flip độc lập mọi đặc trưng) */
function noiseCtxs(n: number, seed: number): { ctxs: FeatureCtx[]; y: number[] } {
  const rand = lcg(seed)
  const ctxs: FeatureCtx[] = []
  const y: number[] = []
  for (let i = 0; i < n; i++) {
    ctxs.push({
      rawConfidence: 0.3 + 0.4 * rand(),
      coverage: 0.15 + 0.7 * rand(),
      answered: rand() < 0.5,
      retrievedChunks: 3 + Math.floor(8 * rand()),
      extractionF1: 0.5,
      hallucinationDetected: rand() < 0.5,
      difficulty: 'medium',
      category: 'ml',
    })
    y.push(rand() < 0.5 ? 1 : 0)
  }
  return { ctxs, y }
}

/** WIPE toàn bộ bảng ảnh hưởng (trước seed + dọn sau test) */
async function wipeCalibrationTables(): Promise<void> {
  await db.evalResult.deleteMany({})
  await db.evalRun.deleteMany({})
  await db.evalCase.deleteMany({})
  await db.calibrationModelV2.deleteMany({})
  await db.calibrationModel.deleteMany({})
  await db.brainModel.deleteMany({ where: { brain: 'calibration_v3' } })
  await db.tuningParam.deleteMany({ where: { key: 'calibration_v3' } })
}

/** Seed EvalResult rows từ ctxs (cùng quy trình r77 — run + 2 case) */
async function seedEvalResults(ctxs: FeatureCtx[], y: number[]): Promise<void> {
  await db.evalResult.deleteMany({})
  await db.evalRun.deleteMany({})
  await db.evalCase.deleteMany({})
  const run = await db.evalRun.create({ data: { status: 'completed', caseCount: ctxs.length } })
  const aCase = await db.evalCase.create({
    data: { question: 'r85 q', expectedAnswer: 'r85 a', category: 'ml', difficulty: 'medium' },
  })
  const bCase = await db.evalCase.create({
    data: { question: 'r85 q2', expectedAnswer: 'r85 a2', category: 'security', difficulty: 'hard' },
  })
  const flip = lcg(777)
  for (let i = 0; i < ctxs.length; i++) {
    const c = ctxs[i]
    await db.evalResult.create({
      data: {
        runId: run.id,
        caseId: flip() < 0.5 ? aCase.id : bCase.id,
        answer: 'seed answer',
        rawConfidence: c.rawConfidence,
        faithfulnessMedian: y[i] === 1 ? 0.9 : 0.3, // > 0.7 = faithful
        coverage: c.coverage,
        answered: c.answered,
        retrievedChunks: c.retrievedChunks,
        extractionF1: c.extractionF1 ?? 0.5,
        hallucinationDetected: c.hallucinationDetected,
      },
    })
  }
}

// ==================== A. buildV3Spec — pin kiến trúc ====================

describe('r85 · A buildV3Spec — kiến trúc khởi điểm blueprint §4.2', () => {
  test('10→16(tanh)→1(sigmoid) + bce + adam + seed 42 — validateSpec chạy qua', () => {
    const spec = buildV3Spec()
    expect(spec.layers.length).toBe(3)
    expect(spec.layers[0].units).toBe(FEATURE_NAMES.length) // 10 đặc trưng V2
    expect(spec.layers[1]).toEqual({ units: 16, activation: 'tanh' })
    expect(spec.layers[2]).toEqual({ units: 1, activation: 'sigmoid' })
    expect(spec.loss).toBe('bce')
    expect(spec.optimizer).toBe('adam')
    expect(spec.seed).toBe(V3_SEED)
    expect(() => validateSpec(spec)).not.toThrow()
  })

  test('paramCount = 193 (10·16+16 + 16·1+1) — xa trần 250K', () => {
    // Tham số = Σ unitsₗ·unitsₗ₋₁ + unitsₗ = (160+16) + (16+1) = 193
    const mlp = new MLP(buildV3Spec())
    expect(mlp.paramCount()).toBe(193)
    expect(mlp.paramCount()).toBeLessThan(BRAIN_MAX_PARAMS)
  })

  test('thuần + tất định — 2 lần build deep-equal', () => {
    expect(buildV3Spec()).toEqual(buildV3Spec())
  })
})

// ==================== B. crossValidateV3 — CV gate (thuần) ====================

describe('r85 · B crossValidateV3 — kỷ luật thăng cấp 5-fold (kế thừa V2)', () => {
  test('XOR n=150: MLP bắt tương tác phi tuyến → improved=true, V2 kẹt gần base-rate', () => {
    const { ctxs, y } = xorCtxs(150, 42)
    const cv = crossValidateV3(ctxs.map(buildFeatureVector), y)
    expect(cv).not.toBeNull()
    // Smoke chấm trước: V3 ≈ 0.11–0.14; V2 ≈ 0.26 (base-rate ~0.25 — logistic
    // không biểu diễn được XOR); ngặt improved = cvBrier < brierV2
    expect(cv!.improved).toBe(true)
    expect(cv!.cvBrier).toBeLessThan(cv!.brierV2)
    expect(cv!.cvBrier).toBeLessThan(0.2)
    expect(cv!.brierV2).toBeGreaterThan(0.2)
    expect(cv!.foldBriers.length).toBe(5)
    // CI phải bao lấy điểm ước lượng
    expect(cv!.cvBrierCiLo).toBeLessThanOrEqual(cv!.cvBrier)
    expect(cv!.cvBrierCiHi).toBeGreaterThanOrEqual(cv!.cvBrier)
  })

  test('XOR n=80 (seed khác): vẫn thắng — không phải may một seed', () => {
    const { ctxs, y } = xorCtxs(80, 7)
    const cv = crossValidateV3(ctxs.map(buildFeatureVector), y)
    expect(cv!.improved).toBe(true)
  })

  test('TOÀN NOISE n=150: improved=false — không tự huyễn hoặc (pattern r77-D)', () => {
    const { ctxs, y } = noiseCtxs(150, 99)
    const cv = crossValidateV3(ctxs.map(buildFeatureVector), y)
    expect(cv).not.toBeNull()
    // Smoke chấm trước: cả 2 kẹt ~0.25-0.27, V3 KHÔNG thắng ngặt
    expect(cv!.improved).toBe(false)
  })

  test('lệch lớp (một lớp 4 mẫu < 5 fold) → null — KHÔNG fallback CV thường', () => {
    const { ctxs } = xorCtxs(40, 5)
    const X = ctxs.map(buildFeatureVector)
    const y = Array.from({ length: 40 }, (_, i) => (i < 4 ? 1 : 0)) // 4 positive < 5
    expect(crossValidateV3(X, y)).toBeNull()
  })
})

// ==================== C–D. DB PIPELINE + RUNTIME (tuần tự) ====================

describe('r85 · C-D trainBrainCalibrationV3 + runtime (DB cô lập)', () => {
  beforeAll(async () => {
    await wipeCalibrationTables()
    delete process.env.CALIBRATION_V3 // ENV dọn — flag hoàn toàn default
    await refreshTuningSnapshot()
  })
  afterAll(async () => {
    // Dọn tuning + env để không rò sang file test khác (snapshot process-global)
    await resetTuningValue('calibration_v3').catch(() => {})
    delete process.env.CALIBRATION_V3
    await refreshTuningSnapshot()
    await wipeCalibrationTables()
  })

  // ---- C1. Thiếu mẫu → ngủ an toàn ----
  test('C1 dưới 30 usable → trained=false (ngủ, không ghi DB)', async () => {
    const { ctxs, y } = xorCtxs(25, 11)
    await seedEvalResults(ctxs, y)
    const res = await trainBrainCalibrationV3()
    expect(res.trained).toBe(false)
    expect(res.version).toBeNull()
    expect(res.error).toContain('insufficient data')
    expect(res.usable).toBe(25)
    expect(MIN_TRAIN_SAMPLES_V3).toBe(30)
    expect(await db.brainModel.count({ where: { brain: 'calibration_v3' } })).toBe(0)
  })

  // ---- C2. inputMode vector → từ chối rõ (chờ Q2) ----
  test("C2 inputMode 'mrl-512' → trained=false với lý do chờ Q2", async () => {
    const res = await trainBrainCalibrationV3('mrl-512')
    expect(res.trained).toBe(false)
    expect(res.error).toContain('chưa hỗ trợ')
    expect(res.error).toContain('Q2')
    expect(V3_INPUT_MODE).toBe('features-10')
  })

  // ---- C3. XOR 150 → trained + active v1 đầy đủ ----
  test('C3 XOR 150 mẫu → trained=true, active=true v1, BrainModel đầy đủ', async () => {
    const { ctxs, y } = xorCtxs(150, 42)
    await seedEvalResults(ctxs, y)
    const res = await trainBrainCalibrationV3()
    expect(res.trained).toBe(true)
    expect(res.active).toBe(true) // XOR → CV thắng (smoke B1)
    expect(res.improved).toBe(true)
    expect(res.version).toBe(1)
    expect(res.sampleSize).toBe(150)
    expect(res.cvBrier!).toBeLessThan(res.brierV2!)
    expect(res.brierV2!).toBeGreaterThan(0.2)

    const row = await db.brainModel.findFirstOrThrow({ where: { brain: 'calibration_v3', version: 1 } })
    expect(row.inputMode).toBe('features-10')
    expect(row.active).toBe(true)
    expect(row.trainedAt).toBeInstanceOf(Date)
    // specJson parse → dựng lại mạng được; weightsJson deserialize + predict được
    const mlp = MLP.deserialize(JSON.parse(row.weightsJson))
    const meta = JSON.parse(row.trainMetaJson) as Record<string, unknown>
    expect(mlp.predictProba(new Array(10).fill(0))).toBeGreaterThanOrEqual(0)
    // trainMeta đầy đủ theo §4.2 + §5.3
    expect(meta.nSamples).toBe(150)
    expect(meta.metric).toBe('brier')
    expect(meta.improved).toBe(true)
    expect(typeof meta.cvScore).toBe('number')
    expect(typeof meta.brierV2).toBe('number')
    const std = meta.standardization as { means: number[]; stds: number[] }
    expect(std.means.length).toBe(10)
    expect(std.stds.length).toBe(10)
    expect(std.means.every((v: number) => Number.isFinite(v))).toBe(true)
    const lineage = meta.dataLineage as Record<string, unknown>
    expect(lineage.inputMode).toBe('features-10')
    expect((lineage.labelRule as string)).toContain('0.7')
    expect(Array.isArray(lineage.dateRange)).toBe(true)
    expect(lineage.tables).toMatchObject({ EvalResult: 150, EvalCase: 2 })
    // Đúng 1 bản active (bất biến A1)
    expect(await db.brainModel.count({ where: { brain: 'calibration_v3', active: true } })).toBe(1)
  })

  // ---- C4. Train lần 2 → v2, tất định bit-đối-bit, đúng 1 active ----
  test('C4 train lần 2 → v2, weightsJson BIT-ĐỐI-BIT v1 (seed tất định), đúng 1 active', async () => {
    const res = await trainBrainCalibrationV3()
    expect(res.trained).toBe(true)
    expect(res.version).toBe(2)
    expect(res.active).toBe(true)
    const rows = await db.brainModel.findMany({
      where: { brain: 'calibration_v3' },
      orderBy: { version: 'asc' },
    })
    expect(rows.length).toBe(2)
    expect(rows.filter(r => r.active).length).toBe(1)
    expect(rows[1].active).toBe(true)
    // Cùng seed + cùng dữ liệu → cùng weights bit-đối-bit (V3_SEED tất định)
    expect(rows[1].weightsJson).toBe(rows[0].weightsJson)
  })

  // ---- C5. Prune A2: giữ active + 5 mới nhất ----
  test('C5 prune A2 — tạo 6 bản tay v3..v8 rồi train → chỉ giữ 5 mới nhất', async () => {
    for (let v = 3; v <= 8; v++) {
      await db.brainModel.create({
        data: {
          brain: 'calibration_v3',
          version: v,
          inputMode: 'features-10',
          specJson: '{}',
          weightsJson: '{}',
          trainMetaJson: '{}',
          active: false,
        },
      })
    }
    expect(await db.brainModel.count({ where: { brain: 'calibration_v3' } })).toBe(8)
    const res = await trainBrainCalibrationV3()
    expect(res.version).toBe(9)
    expect(res.active).toBe(true)
    const rows = await db.brainModel.findMany({
      where: { brain: 'calibration_v3' },
      orderBy: { version: 'desc' },
    })
    // Giữ đúng BRAIN_VERSIONS_KEEP(5) bản mới nhất (v9 vừa active vừa mới
    // nhất — nằm trong 5); v1..v4 bị prune
    expect(rows.length).toBe(BRAIN_VERSIONS_KEEP)
    expect(rows.map(r => r.version)).toEqual([9, 8, 7, 6, 5])
    expect(rows.filter(r => r.active)).toEqual([rows[0]]) // v9 active duy nhất
  })

  // ---- C6. Noise train sau → bản mới thua KHÔNG đụng active cũ ----
  test('C6 noise train sau → v10 active=false, bản active XOR v9 GIỮ NGUYÊN', async () => {
    const { ctxs, y } = noiseCtxs(150, 99)
    await seedEvalResults(ctxs, y)
    const res = await trainBrainCalibrationV3()
    expect(res.trained).toBe(true)
    expect(res.active).toBe(false) // noise thua CV (B3)
    expect(res.improved).toBe(false)
    const actives = await db.brainModel.findMany({
      where: { brain: 'calibration_v3', active: true },
    })
    expect(actives.length).toBe(1)
    expect(actives[0].version).toBe(9) // bản XOR cũ giữ nguyên — thua không lật đổ
  })

  // ---- D1. Cờ mặc định off → tryCalibrationV3 null dù có active ----
  test('D1 cờ off (mặc định) → tryCalibrationV3 null kể cả khi có bản active', async () => {
    expect(isCalibrationV3Enabled()).toBe(false) // STORE trống + ENV dọn → default off
    expect(getTuningEnum('calibration_v3')).toBe('off')
    const out = await tryCalibrationV3(0.5)
    expect(out).toBeNull()
  })

  // ---- D2. Cờ on + active → V3 dẫn đường chuỗi ----
  test('D2 cờ on + active đủ mẫu → V3 dẫn đường getCalibratedConfidence', async () => {
    // Dữ liệu noise đang seed (C6) — nhưng active là bản XOR v9. Reset flag
    // off→on qua STORE (setTuningValue cập nhật snapshot tức thì)
    const entry = await setTuningValue('calibration_v3', 'on')
    expect(entry.effectiveValue).toBe('on')
    expect(isCalibrationV3Enabled()).toBe(true)
    const v3 = await tryCalibrationV3(0.5)
    expect(v3).not.toBeNull()
    expect(v3!).toBeGreaterThanOrEqual(0)
    expect(v3!).toBeLessThanOrEqual(1)
    // Chuỗi đầy đủ: getCalibratedConfidence phải TRẢ ĐÚNG giá trị V3 (dẫn đường)
    expect(await getCalibratedConfidence(0.5)).toBe(v3!)
    // loadActiveV3 nạp đúng bản active mới nhất
    const model = await loadActiveV3()
    expect(model).not.toBeNull()
    expect(model!.version).toBe(9)
    expect(model!.nSamples).toBeGreaterThanOrEqual(MIN_RUNTIME_SAMPLES_V3)
    expect(MIN_RUNTIME_SAMPLES_V3).toBe(20)
  })

  // ---- D3. Rollback active=false → V3 thoát chuỗi, V2 kế thừa ----
  test('D3 rollback active=false → tryCalibrationV3 null; chuỗi rơi đúng V2 (σ(2) tay)', async () => {
    await db.brainModel.updateMany({
      where: { brain: 'calibration_v3' },
      data: { active: false },
    })
    expect(await loadActiveV3()).toBeNull()
    expect(await tryCalibrationV3(0.5)).toBeNull() // cờ on nhưng hết bản active → fail-open
    // Seed V2-active tay (hệ số biết trước): β=[1,0…0], means=0, stds=1,
    // intercept=1.5 → applyV2Model({rawConfidence:0.5}) = σ(1.5 + 0.5) = σ(2)
    await db.calibrationModelV2.create({
      data: {
        id: 'default',
        featureNames: JSON.stringify(FEATURE_NAMES),
        means: JSON.stringify(new Array(10).fill(0)),
        stds: JSON.stringify(new Array(10).fill(1)),
        coefficients: JSON.stringify([1, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
        intercept: 1.5,
        oddsRatios: '{}',
        sampleSize: 100,
        active: true,
      },
    })
    // σ(2) = 1/(1+e⁻²) = 0.8807970779778823 — tính tay
    expect(await getCalibratedConfidence(0.5)).toBeCloseTo(0.8807970779778823, 12)
  })

  // ---- D4. weightsJson rách → null (fail-open, không throw) ----
  test('D4 cờ on + weightsJson RÁCH → loadActiveV3 null (không throw)', async () => {
    await db.calibrationModelV2.deleteMany({}) // bỏ V2 để đo riêng V3
    await db.brainModel.create({
      data: {
        brain: 'calibration_v3',
        version: 99,
        inputMode: 'features-10',
        specJson: '{}',
        weightsJson: '{"spec": not-json',
        trainMetaJson: JSON.stringify({
          nSamples: 100,
          standardization: { means: new Array(10).fill(0), stds: new Array(10).fill(1) },
        }),
        active: true,
      },
    })
    expect(await loadActiveV3()).toBeNull()
    expect(await tryCalibrationV3(0.7)).toBeNull()
    // Dọn bản rách
    await db.brainModel.deleteMany({ where: { brain: 'calibration_v3', version: 99 } })
  })

  // ---- D5. nSamples < 20 → null (ngưỡng runtime tin model) ----
  test('D5 cờ on + active + nSamples 10 (< 20) → null', async () => {
    await db.brainModel.create({
      data: {
        brain: 'calibration_v3',
        version: 98,
        inputMode: 'features-10',
        specJson: JSON.stringify(buildV3Spec()),
        weightsJson: JSON.stringify(new MLP(buildV3Spec()).serialize()),
        trainMetaJson: JSON.stringify({
          nSamples: 10, // dưới MIN_RUNTIME_SAMPLES_V3 = 20
          standardization: { means: new Array(10).fill(0), stds: new Array(10).fill(1) },
        }),
        active: true,
      },
    })
    expect(await loadActiveV3()).toBeNull()
    expect(await tryCalibrationV3(0.7)).toBeNull()
    await db.brainModel.deleteMany({ where: { brain: 'calibration_v3', version: 98 } })
  })

  // ---- D6. applyV3Model thuần: impute + clamp + tất định ----
  test('D6 applyV3Model — đặc trưng thiếu impute 0 chuẩn hóa, clamp [0,1], tất định', async () => {
    // Nạp lại bản active thật (mọi bản đã deactive ở D3 → dựng tay từ spec)
    const mlp = new MLP(buildV3Spec())
    const model: ActiveV3Model = {
      mlp,
      means: new Array(10).fill(0.4),
      stds: new Array(10).fill(0.2),
      nSamples: 100,
      version: 1,
    }
    const full = applyV3Model(model, {
      rawConfidence: 0.6, coverage: 0.8, answered: true, retrievedChunks: 5,
      extractionF1: 0.7, hallucinationDetected: false, difficulty: 'hard', category: 'ml',
    })
    const partial = applyV3Model(model, { rawConfidence: 0.6 })
    expect(full).toBeGreaterThanOrEqual(0)
    expect(full).toBeLessThanOrEqual(1)
    // 9 đặc trưng thiếu → chuẩn hóa 0 (mean) ≠ ctx đầy đủ → KẾT QUẢ KHÁC
    expect(full).not.toBe(partial)
    // Tất định — 2 lần áp cùng model + ctx → cùng giá trị
    expect(applyV3Model(model, { rawConfidence: 0.6 })).toBe(partial)
  })

  // ---- D7. Reset cờ → off lại (dọn trạng thái) ----
  test('D7 reset cờ → off — rollback bằng cờ không cần đụng DB', async () => {
    const entry = await resetTuningValue('calibration_v3')
    expect(entry.effectiveValue).toBe('off')
    expect(isCalibrationV3Enabled()).toBe(false)
    expect(await tryCalibrationV3(0.5)).toBeNull()
  })
})

// ==================== E. CỜ calibration_v3 (STORE > ENV > DEFAULT) ====================

describe('r85 · E cờ calibration_v3 — chuỗi hiệu lực + pin spec', () => {
  test('spec pin trong TUNING_SPECS: default off · enum [off|on] · envKey CALIBRATION_V3', () => {
    const spec = TUNING_SPECS.find(s => s.key === 'calibration_v3')
    expect(spec).toBeDefined()
    expect(spec!.default).toBe('off')
    expect(spec!.enumValues).toEqual(['off', 'on'])
    expect(spec!.envKey).toBe('CALIBRATION_V3')
    expect(spec!.type).toBe('enum')
    expect(typeof spec!.description).toBe('string')
  })

  test('validateTuningInput — trim + lowercase chuẩn hoá, giá trị lạ từ chối', () => {
    expect(validateTuningInput('calibration_v3', ' ON ')).toEqual({ ok: true, normalized: 'on' })
    expect(validateTuningInput('calibration_v3', 'Off')).toEqual({ ok: true, normalized: 'off' })
    expect(validateTuningInput('calibration_v3', 'maybe').ok).toBe(false)
  })

  test('ENV thắng default: CALIBRATION_V3=on (STORE trống) → getTuningEnum on', async () => {
    await db.tuningParam.deleteMany({ where: { key: 'calibration_v3' } })
    await refreshTuningSnapshot()
    process.env.CALIBRATION_V3 = 'on'
    expect(getTuningEnum('calibration_v3')).toBe('on')
    expect(isCalibrationV3Enabled()).toBe(true)
    // ENV giá trị lạ → về default off (envMap chuẩn hoá)
    process.env.CALIBRATION_V3 = 'yes'
    expect(getTuningEnum('calibration_v3')).toBe('off')
    delete process.env.CALIBRATION_V3
    expect(getTuningEnum('calibration_v3')).toBe('off')
  })

  test('STORE thắng ENV: set on khi env=off → on; reset → theo env lại', async () => {
    process.env.CALIBRATION_V3 = 'off'
    await setTuningValue('calibration_v3', 'on')
    expect(getTuningEnum('calibration_v3')).toBe('on') // STORE > ENV
    await resetTuningValue('calibration_v3')
    expect(getTuningEnum('calibration_v3')).toBe('off') // rơi về ENV=off
    delete process.env.CALIBRATION_V3
  })

  test('registry pin: BRAIN_TRAINABLE_KEYS = [calibration_v3], TRAINING_IMPLEMENTED = true', () => {
    expect(BRAIN_TRAINABLE_KEYS).toEqual(['calibration_v3'])
    expect(BRAIN_TRAINING_IMPLEMENTED).toBe(true)
  })
})

// ==================== F. CHUỖI ĐẦY ĐỦ V3→V2→V1→raw ====================

describe('r85 · F getCalibratedConfidence — chuỗi đầy đủ fail-open', () => {
  beforeAll(async () => {
    await wipeCalibrationTables()
    delete process.env.CALIBRATION_V3
    await refreshTuningSnapshot()
  })
  afterAll(async () => {
    await wipeCalibrationTables()
  })

  test('F1 không model nào + cờ off → trả raw NGUYÊN VẸN (fail-open tận gốc)', async () => {
    expect(await getCalibratedConfidence(0.42)).toBe(0.42)
    expect(await getCalibratedConfidence(0.99)).toBe(0.99)
  })

  test('F2 cờ on nhưng KHÔNG có bản active → vẫn trả raw (V3 không làm runtime tệ hơn)', async () => {
    await setTuningValue('calibration_v3', 'on')
    expect(await getCalibratedConfidence(0.42)).toBe(0.42) // không V3/V2/V1 → raw
    await resetTuningValue('calibration_v3')
  })

  test('F3 V1 có mẫu đủ + V3 off → chuỗi cũ V1 chạy đúng (σ tay)', async () => {
    // V1: intercept=1, coef=1 → σ(1 + 0.5) = σ(1.5) = 0.8175744761936437
    await db.calibrationModel.create({
      data: { id: 'default', intercept: 1, coef: 1, sampleSize: 50 },
    })
    expect(await getCalibratedConfidence(0.5)).toBeCloseTo(0.8175744761936437, 12)
    // V1 dưới ngưỡng mẫu → raw (đổi sampleSize = 5 < 20)
    await db.calibrationModel.update({ where: { id: 'default' }, data: { sampleSize: 5 } })
    expect(await getCalibratedConfidence(0.5)).toBe(0.5)
    await db.calibrationModel.deleteMany({})
  })
})
