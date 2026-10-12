/**
 * ROUND-86 TESTS — BRAIN-P3 · BRAIN-B "Vọng" SURROGATE + REPLAY-EVAL (blueprint §4.3)
 *
 * Đo lường:
 *   A. buildSurrogateSpecs — pin kiến trúc 3 đầu-ra-riêng (D→16(tanh)→1;
 *      success sigmoid+BCE · tokens/duration linear+Huber; adam seed 42):
 *      validateSpec chạy qua, paramCount = D·16+16+16+1+1; 2 lần build
 *      deep-equal; vocab/featureNames đúng thứ tự sorted + delegated cuối.
 *   B. crossValidateSurrogate (thuần, không DB) — kỷ luật thăng cấp:
 *      SIGNAL (model quyết định kết cục — alpha 80%/beta 30% success,
 *      tokens/duration tách hẳm 2 cụm) → đầu success thắng NGẶT baseline
 *      base-rate ở cả 3 seed 31/77/123 (smoke: brier 0.185–0.191 vs base
 *      0.232–0.250; AUC 0.75–0.78 kèm Hanley–McNeil CI kẹp [0,1]); 2 đầu
 *      hồi quy thắng rõ median baseline (MAE log ~0.09–0.12 vs 0.58–0.84).
 *      NOISE (model độc lập kết cục, cả 2 55%): gate cvBrier < base là
 *      SO-SÁNH-ĐỐI-CHỨNG, KHÔNG phải bất biến "tự chối noise" — thắng/thua
 *      theo seed (smoke 10 seed: 4 thắng — cùng tinh thần FB-BRAIN-P2-R1-02);
 *      pin seed 51 thua + chốt KHOẢNG quanh base-rate p̄(1−p̄) = 0.2475.
 *      Hợp đồng: length-mismatch 3 chiều → throw; folds 5.5/NaN/0/1 → null;
 *      folds=2 chạy được; lệch lớp (toàn success) → null.
 *   C. trainBrainSurrogate (DB cô lập) — thiếu mẫu < 60 → trained=false
 *      (ngủ, không ghi DB); inputMode vector 'mrl-512' → từ chối rõ (chờ Q2)
 *      + telemetry usable trung thực (số thật trong DB); SIGNAL 120 rows →
 *      trained=true active=true v1, BrainModel đầy đủ (specJson vocab,
 *      weightsJson 3 head envelope deserialize+predict, trainMeta heads/
 *      standardization stds FULL precision > 0/targetStats/baselines/
 *      dataLineage runIds §5.3); train lần 2 → v2 + đúng 1 active (A1) +
 *      weightsJson BIT-ĐỐI-BIT v1 (tất định seed); 6 lần train → prune A2
 *      giữ 5 bản mới nhất (v1 bị dọn); NOISE train sau → bản mới active
 *      =false KHÔNG đụng bản active cũ; single-flight A7: khóa đang giữ →
 *      trained=false "bỏ lệnh trùng".
 *   D. loadActiveSurrogate + applySurrogateHead — fail-open mọi nhánh:
 *      active → nạp đủ (version/nSamples/vocab/headImproved); alpha →
 *      pSuccess CAO, beta → pSuccess THẤP (quan hệ thật); tokens/duration
 *      theo cụm đúng chiều; rollback active=false → null; weightsJson rách
 *      → null; nSamples < 40 → null; stds=0 (corrupt) → null KHÔNG NaN
 *      (FB-BRAIN-P2-R1-01); applySurrogateHead hợp đồng: means sai chiều →
 *      throw, stds có 0 → throw.
 *   E. buildReplayReport + POST /api/brain/replay — READ-ONLY tuyệt đối
 *      (count mọi bảng liên quan KHÔNG đổi sau POST); flag off (mặc định)
 *      → surrogate.active vẫn báo TRUNG THỰC nhưng heads toàn null ("chỉ
 *      đo/báo cáo"); flag on + active + đầu thắng → heads.success.pSuccess
 *      khớp applySurrogateHead trực tiếp; rollback → active=false heads
 *      null; model LẠ chưa từng chạy → history n=0/rate null/CI null (không
 *      bịa số) nhưng ước lượng MLP vẫn tính được (bootstrap action chưa thử
 *      — đúng mục đích Q-advice); history khớp đúng số đếm từ mảng seed;
 *      bootstrap CI tất định (2 lần deep-equal); Wilson CI chứa successRate.
 *   F. Cờ replay_eval (STORE > ENV > DEFAULT=off) — spec pin trong
 *      TUNING_SPECS (enum off/on, envKey REPLAY_EVAL, node softmax-policy);
 *      NEURAL_NODES softmax-policy paramKeys có replay_eval; ENV 'on' thắng
 *      default; STORE thắng ENV; reset về default; BRAIN_TRAINABLE_KEYS =
 *      [calibration_v3, surrogate]; GET /api/brain → surrogate trainable
 *      đúng.
 *   G. A7 wiring cho Brain-A: acquireTrainLock('calibration_v3') →
 *      trainBrainCalibrationV3 trả busy (không phá hành vi P2), release →
 *      train chạy lại bình thường.
 *
 * Nguyên tắc test:
 * - DB-cô-lập (bunfig preload copy DB) — WIPE AgentRunRecord + BrainModel
 *   surrogate + TuningParam replay_eval trước seed; env REPLAY_EVAL dọn ở
 *   beforeAll VÀ afterAll (snapshot tuning-store process-global).
 * - Mọi expected DẪN NGUỒN ĐƯỢC (comment công thức/smoke) — synthetic data
 *   bằng LCG deterministic (không Math.random — tái lập được mọi môi trường).
 * - createdAt PHÂN TÁN mỗi row +1s (bài học flaky FB-BRAIN-P2-R2-02 —
 *   orderBy tie-break ổn định tuyệt đối).
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { db } from '@/lib/db'
import { MLP, validateSpec, type MlpSerialized } from '@/lib/brain/mlp'
import {
  buildSurrogateSpecs,
  buildSurrogateVocab,
  buildSurrogateFeatureRow,
  surrogateFeatureNames,
  crossValidateSurrogate,
  trainBrainSurrogate,
  loadActiveSurrogate,
  applySurrogateHead,
  buildReplayReport,
  toLogSpace,
  fromLogSpace,
  aucHanleyMcNeilCI,
  bootstrapCI,
  SURROGATE_MIN_TRAIN_SAMPLES,
  SURROGATE_MIN_RUNTIME_SAMPLES,
  SURROGATE_INPUT_MODE,
  SURROGATE_SEED,
  type SurrogateVocab,
  type ActiveSurrogate,
} from '@/lib/brain/brains/surrogate'
import { acquireTrainLock, releaseTrainLock, isTrainLocked } from '@/lib/brain/train-lock'
import { trainBrainCalibrationV3 } from '@/lib/brain/calibration-v3'
import { POST as trainRoutePOST } from '@/app/api/brain/train/route'
import { POST as replayRoutePOST } from '@/app/api/brain/replay/route'
import { GET as brainRouteGET } from '@/app/api/brain/route'
import {
  TUNING_SPECS,
  NEURAL_NODES,
} from '@/lib/learning/neural-types'
import {
  getTuningEnum,
  setTuningValue,
  resetTuningValue,
  refreshTuningSnapshot,
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

// ==================== SEED DATA (SIGNAL quan hệ thật / NOISE) ====================

/** 1 row AgentRunRecord hợp lệ cho pipeline Brain-B */
interface SeedRun {
  model: string
  agent: string | null
  delegated: boolean
  complete: boolean
  tokens: number
  durationMs: number
}

/**
 * Dựng synthetic runs:
 *  - signal=true: alpha 80% success / beta 30% · tokens alpha ~800–1200 vs
 *    beta ~4000–6000 · duration alpha ~1500–2000 vs beta ~5000–7500 — MLP
 *    one-hot học được per-model outcome trong khi baseline base-rate/median
 *    pooled mù hoàn toàn.
 *  - signal=false: cả 2 model 55% success + tokens/duration trùng phân bố —
 *    model ĐỘC LẬP kết cục (không có gì để học ngoài noise).
 */
function synthRuns(n: number, seed: number, signal: boolean): SeedRun[] {
  const rand = lcg(seed)
  const rows: SeedRun[] = []
  for (let i = 0; i < n; i++) {
    const model = rand() < 0.5 ? 'alpha' : 'beta'
    const pSuccess = signal ? (model === 'alpha' ? 0.8 : 0.3) : 0.55
    const tokens = signal
      ? (model === 'alpha' ? 800 + 400 * rand() : 4000 + 2000 * rand())
      : 2000 + 1000 * rand()
    const dur = signal
      ? (model === 'alpha' ? 1500 + 500 * rand() : 5000 + 2500 * rand())
      : 2000 + 1000 * rand()
    rows.push({
      model,
      agent: rand() < 0.8 ? 'Omega' : 'FORGE',
      delegated: rand() < 0.2,
      complete: rand() < pSuccess,
      tokens: Math.round(tokens),
      durationMs: Math.round(dur),
    })
  }
  return rows
}

/** WIPE bảng ảnh hưởng Brain-B (trước seed + dọn sau test) */
async function wipeSurrogateTables(): Promise<void> {
  await db.agentRunRecord.deleteMany({})
  await db.brainModel.deleteMany({ where: { brain: 'surrogate' } })
  await db.tuningParam.deleteMany({ where: { key: 'replay_eval' } })
}

/**
 * Seed AgentRunRecord rows từ mảng synthetic — createdAt phân tán mỗi row
 * +1s (tie-break orderBy ổn định — bài học FB-BRAIN-P2-R2-02); status/stop
 * reason mô phỏng thật (complete → completed/complete; ngược lại failed).
 */
async function seedAgentRuns(runs: SeedRun[], sessionId: string = 'r86-session'): Promise<void> {
  await db.agentRunRecord.deleteMany({})
  const base = Date.now() - runs.length * 1000
  for (let i = 0; i < runs.length; i++) {
    const r = runs[i]
    await db.agentRunRecord.create({
      data: {
        sessionId,
        runId: `run_r86_${i}`,
        agentName: r.agent,
        model: r.model,
        status: r.complete ? 'completed' : 'failed',
        stopReason: r.complete ? 'complete' : 'error',
        cycles: 1 + Math.floor(2 * (i % 3)),
        tokensUsed: r.tokens,
        toolCalls: 2,
        toolFailures: 0,
        durationMs: r.durationMs,
        complete: r.complete,
        startedAt: new Date(base + i * 1000),
        completedAt: new Date(base + i * 1000 + r.durationMs),
        createdAt: new Date(base + i * 1000),
        // delegated = parentRunId ≠ null
        parentRunId: r.delegated ? 'run_parent_r86' : null,
      },
    })
  }
}

// ==================== A. buildSurrogateSpecs — pin kiến trúc ====================

describe('r86 · A buildSurrogateSpecs — kiến trúc 3 đầu-ra-riêng blueprint §4.3', () => {
  const vocab: SurrogateVocab = { models: ['alpha', 'beta'], agents: ['FORGE', 'Omega'] }

  test('D=5 (2 model + 2 agent + delegated) → 16(tanh) → 1; 3 loss đúng vai; adam seed 42', () => {
    const specs = buildSurrogateSpecs(vocab)
    for (const spec of Object.values(specs)) {
      validateSpec(spec) // không throw
      expect(spec.layers.length).toBe(3)
      expect(spec.layers[0].units).toBe(5)
      expect(spec.layers[0].activation).toBe('linear') // hợp đồng dữ liệu — tiền lệ V3
      expect(spec.layers[1]).toEqual({ units: 16, activation: 'tanh' })
      expect(spec.layers[2].units).toBe(1)
      expect(spec.optimizer).toBe('adam')
      expect(spec.lr).toBe(0.01)
      expect(spec.l2).toBe(0.01)
      expect(spec.seed).toBe(SURROGATE_SEED)
      expect(SURROGATE_SEED).toBe(42)
    }
    expect(specs.success.layers[2].activation).toBe('sigmoid')
    expect(specs.success.loss).toBe('bce')
    expect(specs.tokens.layers[2].activation).toBe('linear')
    expect(specs.tokens.loss).toBe('huber')
    expect(specs.durationMs.layers[2].activation).toBe('linear')
    expect(specs.durationMs.loss).toBe('huber')
  })

  test('paramCount = 5·16+16 + 16·1+1 = 113 mỗi head (xa trần 250K)', () => {
    const specs = buildSurrogateSpecs(vocab)
    for (const spec of Object.values(specs)) {
      const mlp = new MLP(spec)
      expect(mlp.paramCount()).toBe(113)
    }
  })

  test('2 lần build deep-equal (tất định thuần)', () => {
    expect(buildSurrogateSpecs(vocab)).toEqual(buildSurrogateSpecs(vocab))
  })

  test('vocab + featureNames: model/agent sorted, delegated cuối cùng', () => {
    const names = surrogateFeatureNames(vocab)
    expect(names).toEqual(['model:alpha', 'model:beta', 'agent:FORGE', 'agent:Omega', 'delegated'])
    // Vocab từ ctx: sorted unique (tất định)
    const v2 = buildSurrogateVocab([
      { model: 'beta', agent: 'Omega', delegated: false },
      { model: 'alpha', agent: null, delegated: true },
      { model: 'beta', agent: 'FORGE', delegated: false },
    ])
    expect(v2).toEqual({ models: ['alpha', 'beta'], agents: ['FORGE', 'Omega'] })
    // Hàng đặc trưng: one-hot đúng vị trí + delegated
    const row = buildSurrogateFeatureRow({ model: 'beta', agent: 'FORGE', delegated: true }, v2)
    expect(row).toEqual([0, 1, 1, 0, 1])
    // Model lạ → khối one-hot toàn 0 (impute hợp đồng, không throw)
    const unknown = buildSurrogateFeatureRow({ model: 'gamma', agent: null, delegated: false }, v2)
    expect(unknown).toEqual([0, 0, 0, 0, 0])
  })

  test('log1p transform khớp tay: toLogSpace(999)=log(1000)≈6.9078; fromLogSpace ngược', () => {
    expect(toLogSpace(999)).toBeCloseTo(Math.log(1000), 12)
    expect(toLogSpace(0)).toBe(0)
    expect(fromLogSpace(toLogSpace(999))).toBeCloseTo(999, 9)
    expect(fromLogSpace(-5)).toBe(0) // kẹp ≥ 0 — expm1 âm vô nghĩa
    expect(fromLogSpace(toLogSpace(169567))).toBeCloseTo(169567, 6)
  })

  test('Hanley–McNeil CI: A±z·SE kẹp [0,1]; suy biến → NaN', () => {
    // smoke seed 31: AUC=0.7533 nPos=76 nNeg=44 → raw CI [0.4550, 1.0516]
    // → kẹp upper về 1
    const ci = aucHanleyMcNeilCI(0.7533, 76, 44)
    expect(ci.low).toBeCloseTo(0.4550, 3)
    expect(ci.high).toBe(1)
    expect(ci.low).toBeLessThanOrEqual(ci.high)
    // AUC 0.5 mẫu lớn → CI hẹp quanh 0.5 (A=0.5: Q1=1/3, Q2=1/2 →
    // SE=8.17e-3 → half-width ≈ 0.016, width ≈ 0.032 — kiểm bề rộng)
    const ci2 = aucHanleyMcNeilCI(0.5, 5000, 5000)
    expect(ci2.low).toBeGreaterThan(0.48)
    expect(ci2.high).toBeLessThan(0.52)
    expect(ci2.high - ci2.low).toBeLessThan(0.04)
    // Suy biến → NaN cả hai (fail-open)
    expect(aucHanleyMcNeilCI(0.7, 0, 10).low).toBeNaN()
    expect(aucHanleyMcNeilCI(1.5, 10, 10).low).toBeNaN()
    expect(aucHanleyMcNeilCI(Number.NaN, 10, 10).high).toBeNaN()
  })

  test('bootstrapCI tất định (seeded) + suy biến null', () => {
    const xs = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
    const a = bootstrapCI(xs, rs => rs.reduce((s, v) => s + v, 0) / rs.length, 200, 42)
    const b = bootstrapCI(xs, rs => rs.reduce((s, v) => s + v, 0) / rs.length, 200, 42)
    expect(a).toEqual(b) // cùng seed → cùng kết quả bit-đối-bit
    expect(a!.low).toBeLessThanOrEqual(6.5)
    expect(a!.high).toBeGreaterThanOrEqual(4.5)
    expect(a!.low).toBeLessThan(a!.high)
    expect(bootstrapCI([], () => 0)).toBeNull() // n=0 → null
    expect(bootstrapCI(xs, () => 0, 1, 42)).toBeNull() // replicates < 2 → null
  })
})

// ==================== B. crossValidateSurrogate (thuần — kỷ luật thăng cấp) ====================

describe('r86 · B crossValidateSurrogate — CV vs baseline đối chứng (blueprint §4.3)', () => {
  /** Chạy CV trên mảng synthetic (không DB) */
  function cvOf(runs: SeedRun[], folds?: number) {
    const ctxs = runs.map(r => ({ model: r.model, agent: r.agent, delegated: r.delegated }))
    const vocab = buildSurrogateVocab(ctxs)
    const X = ctxs.map(c => buildSurrogateFeatureRow(c, vocab))
    const yS: number[] = runs.map(r => (r.complete ? 1 : 0))
    const yT = runs.map(r => toLogSpace(r.tokens))
    const yD = runs.map(r => toLogSpace(r.durationMs))
    return crossValidateSurrogate(X, yS, yT, yD, vocab, folds !== undefined ? { folds } : {})
  }

  test('B1 SIGNAL 3 seed (31/77/123): success thắng NGẶT base-rate; AUC 0.7–0.85 kèm CI kẹp [0,1]', () => {
    // smoke chấm trước (cùng LCG, cùng seed — tái lập tuyệt đối):
    //   seed 31: brier 0.1878 vs base 0.2323 · AUC 0.7533 · nPos=76/nNeg=44
    //   seed 77: brier 0.1846 vs base 0.2500 · AUC 0.7785
    //   seed 123: brier 0.1907 vs base 0.2498 · AUC 0.7785
    for (const seed of [31, 77, 123]) {
      const cv = cvOf(synthRuns(120, seed, true))!
      expect(cv).not.toBeNull()
      expect(cv.success.improved).toBe(true)
      expect(cv.improved).toBe(true) // gate tổng = success (đầu ra quyết định)
      expect(cv.success.cvBrier).toBeLessThan(cv.success.brierBaseline)
      expect(cv.success.cvBrier).toBeGreaterThan(0.12)
      expect(cv.success.cvBrier).toBeLessThan(0.22)
      expect(cv.success.brierBaseline).toBeGreaterThan(0.22)
      expect(cv.success.brierBaseline).toBeLessThan(0.26)
      expect(cv.success.auc).not.toBeNull()
      expect(cv.success.auc!).toBeGreaterThan(0.7)
      expect(cv.success.auc!).toBeLessThan(0.85)
      expect(cv.success.aucCiLo).toBeGreaterThanOrEqual(0)
      expect(cv.success.aucCiHi).toBeLessThanOrEqual(1)
      expect(cv.success.aucCiLo!).toBeLessThanOrEqual(cv.success.auc!)
      expect(cv.success.aucCiHi!).toBeGreaterThanOrEqual(cv.success.auc!)
      expect(cv.success.foldBriers.length).toBe(5)
      expect(cv.folds).toBe(5)
      // Baseline base-rate ~ pooled variance: p̄·(1−p̄) xấp xỉ theo tỉ lệ
      // lớp thực tế của từng seed
    }
  })

  test('B2 SIGNAL: 2 đầu hồi quy thắng rõ median baseline (MAE log ~0.09–0.13 vs 0.55–0.85)', () => {
    // smoke seed 31: tokens mae 0.1062 vs 0.7397 · dur 0.0923 vs 0.5839
    const cv = cvOf(synthRuns(120, 31, true))!
    expect(cv.tokens.improved).toBe(true)
    expect(cv.tokens.cvMae).toBeLessThan(0.15)
    expect(cv.tokens.maeBaseline).toBeGreaterThan(0.5)
    expect(cv.durationMs.improved).toBe(true)
    expect(cv.durationMs.cvMae).toBeLessThan(0.15)
    expect(cv.durationMs.maeBaseline).toBeGreaterThan(0.5)
    // CI fold (meanCI) có mặt
    expect(cv.tokens.cvMaeCiLo).toBeLessThanOrEqual(cv.tokens.cvMae)
    expect(cv.tokens.cvMaeCiHi).toBeGreaterThanOrEqual(cv.tokens.cvMae)
  })

  test('B3 NOISE seed 51: thua đối chứng (gate là so-sánh, KHÔNG phải bất biến — thắng/thua theo seed)', () => {
    // smoke 10 seed noise (17..170): 4/10 thắng — gate là so-sánh-đối-chứng
    // thuần, không "tự chối noise" (cùng kết luận FB-BRAIN-P2-R1-02 cho
    // V3-vs-V2). Pin seed 51 cụ thể: brier 0.2439 vs base 0.2364 → thua.
    const cv = cvOf(synthRuns(120, 51, false))!
    expect(cv.success.improved).toBe(false)
    // Cả 2 kẹt quanh base-rate p̄(1−p̄) với p̄=0.55 → 0.2475
    expect(cv.success.cvBrier).toBeGreaterThan(0.22)
    expect(cv.success.cvBrier).toBeLessThan(0.27)
    expect(cv.success.brierBaseline).toBeGreaterThan(0.22)
    expect(cv.success.brierBaseline).toBeLessThan(0.27)
    // AUC ~ 0.5 (không có tín hiệu)
    expect(cv.success.auc!).toBeGreaterThan(0.3)
    expect(cv.success.auc!).toBeLessThan(0.7)
  })

  test('B4 hợp đồng length-mismatch → throw cả 3 chiều (kế thừa FB-BRAIN-P2-R1-03)', () => {
    const runs = synthRuns(20, 7, true)
    const ctxs = runs.map(r => ({ model: r.model, agent: r.agent, delegated: r.delegated }))
    const vocab = buildSurrogateVocab(ctxs)
    const X = ctxs.map(c => buildSurrogateFeatureRow(c, vocab))
    const yS: number[] = runs.map(r => (r.complete ? 1 : 0))
    const yT = runs.map(r => toLogSpace(r.tokens))
    const yD = runs.map(r => toLogSpace(r.durationMs))
    expect(() => crossValidateSurrogate(X.slice(1), yS, yT, yD, vocab)).toThrow(/phải bằng/)
    expect(() => crossValidateSurrogate(X, yS.slice(1), yT, yD, vocab)).toThrow(/phải bằng/)
    expect(() => crossValidateSurrogate(X, yS, yT, yD.slice(1), vocab)).toThrow(/phải bằng/)
  })

  test('B5 folds degenerate (5.5/NaN/0/1) → null; folds=2 chạy được', () => {
    const runs = synthRuns(120, 31, true)
    expect(cvOf(runs, 5.5)).toBeNull()
    expect(cvOf(runs, Number.NaN)).toBeNull()
    expect(cvOf(runs, 0)).toBeNull()
    expect(cvOf(runs, 1)).toBeNull()
    const cv2 = cvOf(runs, 2)
    expect(cv2).not.toBeNull()
    expect(cv2!.folds).toBe(2)
    expect(cv2!.success.foldBriers.length).toBe(2)
  })

  test('B6 lệch lớp (toàn success=1) → null (abort, KHÔNG fallback CV thường)', () => {
    const runs = synthRuns(60, 9, true).map(r => ({ ...r, complete: true }))
    expect(cvOf(runs)).toBeNull()
  })
})

// ==================== C. trainBrainSurrogate (DB cô lập) ====================

describe('r86 · C trainBrainSurrogate — pipeline đầy đủ (DB cô lập)', () => {
  beforeAll(async () => {
    await wipeSurrogateTables()
    delete process.env.REPLAY_EVAL
    await refreshTuningSnapshot()
  })
  // LƯU Ý: afterAll KHÔNG wipe bảng — D/E/F dùng tiếp trạng thái C đã dựng
  // (agent runs seed + BrainModel v10 active); janitor dọn cuối file nằm ở F
  afterAll(async () => {
    await resetTuningValue('replay_eval').catch(() => {})
    delete process.env.REPLAY_EVAL
    await refreshTuningSnapshot()
  })

  test('C1 dưới 60 usable → trained=false (ngủ an toàn, không ghi DB)', async () => {
    await seedAgentRuns(synthRuns(45, 11, true))
    const res = await trainBrainSurrogate()
    expect(SURROGATE_MIN_TRAIN_SAMPLES).toBe(60) // blueprint §2
    expect(res.trained).toBe(false)
    expect(res.version).toBeNull()
    expect(res.active).toBe(false)
    expect(res.error).toContain('insufficient data')
    expect(res.usable).toBe(45) // telemetry số thật
    expect(res.total).toBe(45)
    expect(await db.brainModel.count({ where: { brain: 'surrogate' } })).toBe(0)
  })

  test('C2 inputMode vector → từ chối rõ (chờ Q2) + telemetry trung thực', async () => {
    const res = await trainBrainSurrogate('mrl-512')
    expect(res.trained).toBe(false)
    expect(res.error).toContain('chưa hỗ trợ')
    expect(res.error).toContain('Q2')
    expect(res.usable).toBe(45) // SỐ THẬT trong DB — không phải 0 cứng (FB-BRAIN-P2-R1-08)
    expect(SURROGATE_INPUT_MODE).toBe('runs-features')
  })

  test('C3 row rác (model null / running) không lọt usable', async () => {
    // 45 usable có sẵn + 3 row rác → usable vẫn 45, total 48
    await db.agentRunRecord.create({
      data: { sessionId: 'r86', model: null, complete: true, tokensUsed: 100, durationMs: 500 },
    })
    await db.agentRunRecord.create({
      data: { sessionId: 'r86', model: 'alpha', complete: null, tokensUsed: 100, durationMs: 500 }, // running — không phải label
    })
    await db.agentRunRecord.create({
      data: { sessionId: 'r86', model: 'alpha', complete: true, tokensUsed: -5, durationMs: 500 }, // tokens âm → rác
    })
    const res = await trainBrainSurrogate()
    expect(res.trained).toBe(false)
    expect(res.usable).toBe(45)
    expect(res.total).toBe(48)
  })

  test('C4 SIGNAL 120 → trained=true active=true v1 + BrainModel đầy đủ', async () => {
    await seedAgentRuns(synthRuns(120, 31, true))
    const res = await trainBrainSurrogate()
    expect(res.trained).toBe(true)
    expect(res.active).toBe(true) // SIGNAL → CV thắng (smoke B1)
    expect(res.version).toBe(1)
    expect(res.sampleSize).toBe(120)
    expect(res.usable).toBe(120)
    expect(res.improved).toBe(true)
    expect(res.heads?.success.improved).toBe(true)

    const row = await db.brainModel.findFirstOrThrow({ where: { brain: 'surrogate', version: 1 } })
    expect(row.active).toBe(true)
    expect(row.inputMode).toBe('runs-features')

    // specJson: vocab đầy đủ + 3 head spec
    const specDoc = JSON.parse(row.specJson) as { vocab: SurrogateVocab; heads: Record<string, { layers: unknown[] }> }
    expect(specDoc.vocab.models.sort()).toEqual(['alpha', 'beta'])
    expect(specDoc.vocab.agents.sort()).toEqual(['FORGE', 'Omega'])
    for (const h of ['success', 'tokens', 'durationMs']) {
      expect(specDoc.heads[h].layers.length).toBe(3)
    }

    // weightsJson: 3 envelope numpy-đọc-được (audit A6) — deserialize + predict được
    const weights = JSON.parse(row.weightsJson) as {
      heads: Record<string, MlpSerialized>
    }
    for (const h of ['success', 'tokens', 'durationMs']) {
      const mlp = MLP.deserialize(weights.heads[h])
      expect(mlp.predict([0, 1, 0, 1, 0]).length).toBe(1)
      for (const t of weights.heads[h].tensors) {
        expect(t.envelope.dtype).toBe('float64')
        expect(t.envelope.data.length).toBe(t.envelope.shape.reduce((s, v) => s * v, 1))
      }
    }

    // trainMetaJson: đầy đủ các khóa hợp đồng
    const meta = JSON.parse(row.trainMetaJson) as Record<string, unknown>
    expect(meta.nSamples).toBe(120)
    expect(meta.inputMode).toBe('runs-features')
    expect(meta.metric).toBe('brier(success)')
    expect(meta.improved).toBe(true)
    const heads = meta.heads as Record<string, Record<string, unknown>>
    expect(heads.success.improved).toBe(true)
    expect(typeof heads.success.cvBrier).toBe('number')
    expect(typeof heads.tokens.cvMaeLog).toBe('number')
    expect(typeof heads.durationMs.cvMaeLog).toBe('number')
    // standardization: stds FULL precision > 0 mọi chiều (FB-BRAIN-P2-R1-01)
    const std = meta.standardization as { means: number[]; stds: number[] }
    expect(std.stds.length).toBe(5)
    expect(std.stds.every(v => v > 0)).toBe(true)
    const ts = meta.targetStats as Record<string, { mean: number; std: number }>
    expect(ts.tokens.std).toBeGreaterThan(0)
    expect(ts.durationMs.std).toBeGreaterThan(0)
    // baselines train-set
    const bl = meta.baselines as Record<string, number>
    expect(bl.successPrior).toBeGreaterThan(0.4)
    expect(bl.successPrior).toBeLessThan(0.7)
    // dataLineage §5.3
    const lineage = meta.dataLineage as Record<string, unknown>
    expect(lineage.tables).toEqual({ AgentRunRecord: 120 })
    // 120 runs > RUN_IDS_MAX (50) → lưu HASH chuỗi sha256 (không phải danh
    // sách — đúng chuỗi "hash tổng nếu quá dài" §5.3)
    expect(typeof lineage.runIds).toBe('string')
    expect(String(lineage.runIds)).toMatch(/^sha256:[0-9a-f]{16} \(120 runs\)$/)
    expect(lineage.runs).toBe(120)
    expect(lineage.flagKey).toBe('replay_eval')
    expect(lineage.labelRule).toContain('complete === true')
  })

  test('C5 train lần 2 → v2, đúng 1 active (A1), weightsJson BIT-ĐỐI-BIT v1 (tất định)', async () => {
    const v1 = await db.brainModel.findFirstOrThrow({ where: { brain: 'surrogate', version: 1 } })
    const res = await trainBrainSurrogate()
    expect(res.trained).toBe(true)
    expect(res.version).toBe(2)
    expect(res.active).toBe(true)
    // A1: chỉ 1 active
    const actives = await db.brainModel.findMany({ where: { brain: 'surrogate', active: true } })
    expect(actives.length).toBe(1)
    expect(actives[0].version).toBe(2)
    // Tất định: cùng dữ liệu + cùng seed → weights JSON trọn vẹn
    const v2 = await db.brainModel.findFirstOrThrow({ where: { brain: 'surrogate', version: 2 } })
    expect(v2.weightsJson).toBe(v1.weightsJson)
    expect(v2.specJson).toBe(v1.specJson)
  })

  test('C6 prune A2: 7 lần train (tổng cộng) → giữ 5 bản mới nhất (v1+v2 bị dọn), active là bản mới nhất', async () => {
    for (let i = 0; i < 4; i++) await trainBrainSurrogate() // v3..v6
    const res = await trainBrainSurrogate() // lần 7 → v7
    expect(res.version).toBe(7)
    expect(BRAIN_VERSIONS_KEEP).toBe(5)
    const rows = await db.brainModel.findMany({
      where: { brain: 'surrogate' },
      orderBy: { version: 'desc' },
      select: { version: true, active: true },
    })
    expect(rows.length).toBe(5) // giữ đúng 5 (active nằm trong 5 mới nhất)
    expect(rows.map(r => r.version)).toEqual([7, 6, 5, 4, 3]) // v1+v2 bị prune
    expect(rows[0].active).toBe(true)
    expect(rows.filter(r => r.active).length).toBe(1)
  })

  test('C7 NOISE train sau SIGNAL → bản mới active=false KHÔNG đụng bản active cũ', async () => {
    await seedAgentRuns(synthRuns(120, 51, false)) // thay dữ liệu bằng noise
    const res = await trainBrainSurrogate()
    expect(res.trained).toBe(true)
    expect(res.version).toBe(8)
    expect(res.active).toBe(false) // noise seed 51 thua (smoke B3)
    expect(res.improved).toBe(false)
    // Bản active cũ (v7) NGUYÊN VẸN — fail-open giữ hiện trạng
    const active = await db.brainModel.findFirstOrThrow({ where: { brain: 'surrogate', active: true } })
    expect(active.version).toBe(7)
    // Prune: 5 mới nhất v4..v8 (active v7 ∈ nhóm này) → 5 row
    expect(await db.brainModel.count({ where: { brain: 'surrogate' } })).toBe(5)
  })

  test('C8 single-flight A7: khóa đang giữ → trained=false "bỏ lệnh trùng"', async () => {
    expect(acquireTrainLock('surrogate')).toBe(true)
    expect(isTrainLocked('surrogate')).toBe(true)
    expect(acquireTrainLock('surrogate')).toBe(false) // lệnh 2 bị chặn
    const res = await trainBrainSurrogate()
    expect(res.trained).toBe(false)
    expect(res.error).toContain('single-flight')
    releaseTrainLock('surrogate')
    expect(isTrainLocked('surrogate')).toBe(false)
    // Sau release → train chạy lại bình thường (ghi v9 — noise tiếp nên
    // active=false, bản active v7 giữ nguyên)
    const res2 = await trainBrainSurrogate()
    expect(res2.trained).toBe(true)
    expect(res2.version).toBe(9)
  })

  test('C9 POST /api/brain/train { brain: surrogate } — 200 đầy đủ sau khi có dữ liệu', async () => {
    // Dữ liệu hiện là noise (C7) → bản vừa train C8 thua CV — route vẫn
    // 200 với đầy đủ chỉ số; trước đó seed lại SIGNAL cho sạch
    await seedAgentRuns(synthRuns(120, 31, true))
    const res = await trainRoutePOST(new Request('http://t/api/brain/train', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ brain: 'surrogate' }),
    }))
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.trained).toBe(true)
    expect(json.brain).toBe('surrogate')
    expect(json.active).toBe(true) // SIGNAL → thắng
    expect(json.heads.success.cvBrier).toBeLessThan(json.heads.success.brierBaseline)
    expect(json.heads.success.improved).toBe(true)
    expect(json.sampleSize).toBe(120)
    expect(json.version).toBe(10)
  })

  test('C10 POST /api/brain/train brain lạ → 400 (liệt kê supported)', async () => {
    const res = await trainRoutePOST(new Request('http://t/api/brain/train', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ brain: 'policy' }),
    }))
    expect(res.status).toBe(400)
    const json = await res.json()
    expect(json.error).toContain('policy')
    expect(json.supported).toContain('surrogate')
    expect(json.supported).toContain('calibration_v3')
  })
})

// ==================== D. RUNTIME LOAD + APPLY (fail-open) ====================

describe('r86 · D loadActiveSurrogate + applySurrogateHead — fail-open mọi nhánh', () => {
  beforeAll(async () => {
    delete process.env.REPLAY_EVAL
    await resetTuningValue('replay_eval').catch(() => {})
    await refreshTuningSnapshot()
  })
  afterAll(async () => {
    await resetTuningValue('replay_eval').catch(() => {})
    delete process.env.REPLAY_EVAL
    await refreshTuningSnapshot()
  })

  let model: ActiveSurrogate | null = null
  test('D1 nạp bản active (v10 sau C) — version/nSamples/vocab/headImproved đầy đủ', async () => {
    model = await loadActiveSurrogate()
    expect(model).not.toBeNull()
    expect(model!.version).toBe(10)
    expect(model!.nSamples).toBe(120)
    expect(SURROGATE_MIN_RUNTIME_SAMPLES).toBe(40) // 2/3 ngưỡng train 60
    expect(model!.headImproved.success).toBe(true) // SIGNAL thắng cả 3 đầu
    expect(model!.headImproved.tokens).toBe(true)
    expect(model!.headImproved.durationMs).toBe(true)
    expect(model!.vocab.models.sort()).toEqual(['alpha', 'beta'])
    expect(model!.means.length).toBe(5)
    expect(model!.stds.every(v => v > 0)).toBe(true)
  })

  test('D2 applySurrogateHead: alpha → pSuccess CAO (~0.8); beta → THẤP (~0.3); tokens/duration đúng cụm', () => {
    expect(model).not.toBeNull()
    const estAlpha = applySurrogateHead(model!, { model: 'alpha', agent: 'Omega', delegated: false })
    const estBeta = applySurrogateHead(model!, { model: 'beta', agent: 'Omega', delegated: false })
    // Quan hệ thật: alpha 80% / beta 30% (smoke CV AUC 0.75+ → ranh giữ được)
    expect(estAlpha.success).not.toBeNull()
    expect(estAlpha.success!).toBeGreaterThan(0.55)
    expect(estAlpha.success!).toBeLessThan(0.95)
    expect(estBeta.success!).not.toBeNull()
    expect(estBeta.success!).toBeLessThan(0.5)
    // Tokens: alpha ~800–1200 · beta ~4000–6000 (log1p học được ranh)
    expect(estAlpha.tokens).not.toBeNull()
    expect(estAlpha.tokens!).toBeGreaterThan(300)
    expect(estAlpha.tokens!).toBeLessThan(2200)
    expect(estBeta.tokens!).not.toBeNull()
    expect(estBeta.tokens!).toBeGreaterThan(2800)
    // Duration: alpha ~1500–2000 · beta ~5000–7500
    expect(estAlpha.durationMs!).not.toBeNull()
    expect(estAlpha.durationMs!).toBeLessThan(3000)
    expect(estBeta.durationMs!).not.toBeNull()
    expect(estBeta.durationMs!).toBeGreaterThan(3500)
    // Model lạ: vẫn tính được (one-hot 0 — bootstrap action chưa thử)
    const estUnknown = applySurrogateHead(model!, { model: 'gamma', agent: null, delegated: false })
    expect(estUnknown.success).not.toBeNull()
    expect(estUnknown.success!).toBeGreaterThanOrEqual(0)
    expect(estUnknown.success!).toBeLessThanOrEqual(1)
  })

  test('D3 hợp đồng throw: means sai chiều / stds có 0 (kế thừa FB-BRAIN-P2-R1-05)', () => {
    expect(model).not.toBeNull()
    const badDims: ActiveSurrogate = { ...model!, means: [0, 0, 0], stds: [1, 1, 1] }
    expect(() => applySurrogateHead(badDims, { model: 'alpha', agent: null, delegated: false })).toThrow(/chiều/)
    const badStds: ActiveSurrogate = { ...model!, stds: model!.stds.map((v, i) => (i === 0 ? 0 : v)) }
    expect(() => applySurrogateHead(badStds, { model: 'alpha', agent: null, delegated: false })).toThrow(/stds phải > 0/)
  })

  test('D4 rollback active=false → loadActiveSurrogate null', async () => {
    await db.brainModel.updateMany({ where: { brain: 'surrogate' }, data: { active: false } })
    expect(await loadActiveSurrogate()).toBeNull()
    // Phục hồi cho test sau
    await db.brainModel.updateMany({ where: { brain: 'surrogate', version: 10 }, data: { active: true } })
    expect((await loadActiveSurrogate())?.version).toBe(10)
  })

  test('D5 weightsJson rách → null (fail-open, không throw)', async () => {
    const row = await db.brainModel.findFirstOrThrow({ where: { brain: 'surrogate', version: 10 } })
    await db.brainModel.update({ where: { id: row.id }, data: { weightsJson: '{ not json' } })
    expect(await loadActiveSurrogate()).toBeNull()
    await db.brainModel.update({ where: { id: row.id }, data: { weightsJson: row.weightsJson } })
    expect((await loadActiveSurrogate())?.version).toBe(10)
  })

  test('D6 nSamples < 40 trong trainMeta → null (ngưỡng runtime tin)', async () => {
    const row = await db.brainModel.findFirstOrThrow({ where: { brain: 'surrogate', version: 10 } })
    const meta = JSON.parse(row.trainMetaJson) as Record<string, unknown>
    meta.nSamples = 30
    await db.brainModel.update({ where: { id: row.id }, data: { trainMetaJson: JSON.stringify(meta) } })
    expect(await loadActiveSurrogate()).toBeNull()
    await db.brainModel.update({ where: { id: row.id }, data: { trainMetaJson: row.trainMetaJson } })
    expect((await loadActiveSurrogate())?.version).toBe(10)
  })

  test('D7 stds=0 corrupt trong trainMeta → null KHÔNG NaN (FB-BRAIN-P2-R1-01)', async () => {
    const row = await db.brainModel.findFirstOrThrow({ where: { brain: 'surrogate', version: 10 } })
    const meta = JSON.parse(row.trainMetaJson) as { standardization: { stds: number[] } }
    meta.standardization.stds[0] = 0
    await db.brainModel.update({ where: { id: row.id }, data: { trainMetaJson: JSON.stringify(meta) } })
    const loaded = await loadActiveSurrogate()
    expect(loaded).toBeNull() // không phải model NaN — từ chối hẳn
    await db.brainModel.update({ where: { id: row.id }, data: { trainMetaJson: row.trainMetaJson } })
    expect((await loadActiveSurrogate())?.version).toBe(10)
  })
})

// ==================== E. REPLAY REPORT + ROUTE (READ-ONLY) ====================

describe('r86 · E buildReplayReport + POST /api/brain/replay — read-only + flag gating', () => {
  beforeAll(async () => {
    delete process.env.REPLAY_EVAL
    await resetTuningValue('replay_eval').catch(() => {})
    await refreshTuningSnapshot()
  })
  afterAll(async () => {
    await resetTuningValue('replay_eval').catch(() => {})
    delete process.env.REPLAY_EVAL
    await refreshTuningSnapshot()
  })

  test('E1 READ-ONLY tuyệt đối: POST replay không đổi count bảng nào', async () => {
    const before = {
      runs: await db.agentRunRecord.count(),
      brain: await db.brainModel.count(),
      tuning: await db.tuningParam.count(),
      verdicts: await db.arbiterVerdict.count(),
    }
    const res = await replayRoutePOST(new Request('http://t/api/brain/replay', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'alpha', agent: 'Omega', delegated: false }),
    }))
    expect(res.status).toBe(200)
    const after = {
      runs: await db.agentRunRecord.count(),
      brain: await db.brainModel.count(),
      tuning: await db.tuningParam.count(),
      verdicts: await db.arbiterVerdict.count(),
    }
    expect(after).toEqual(before)
  })

  test('E2 cờ OFF (mặc định): history đầy + surrogate.active trung thực + heads TOÀN NULL ("chỉ đo/báo cáo")', async () => {
    expect(getTuningEnum('replay_eval')).toBe('off')
    // Kỳ vọng đếm từ chính mảng seed (LCG tất định — không giả định 50/50)
    const alphaRuns = synthRuns(120, 31, true).filter(r => r.model === 'alpha')
    const report = await buildReplayReport({ model: 'alpha', agent: 'Omega', delegated: false })
    // History: đo lường thuần luôn chạy
    expect(report.history.nModelRuns).toBe(alphaRuns.length)
    expect(report.history.nModelSuccess).toBe(alphaRuns.filter(r => r.complete).length)
    expect(report.history.successRate).not.toBeNull()
    expect(report.history.successRate!).toBeGreaterThan(0.65) // alpha ~80% — không phải pooled 0.55
    expect(report.history.successRate!).toBeLessThan(0.95)
    expect(report.history.successCi!.low).toBeLessThanOrEqual(report.history.successRate!)
    expect(report.history.successCi!.high).toBeGreaterThanOrEqual(report.history.successRate!)
    expect(report.successWilson!.low).toBeLessThanOrEqual(report.history.successRate!)
    expect(report.successWilson!.high).toBeGreaterThanOrEqual(report.history.successRate!)
    // surrogate: trạng thái active trung thực (v10 active) nhưng heads khóa
    expect(report.flag.value).toBe('off')
    expect(report.surrogate.active).toBe(true)
    expect(report.surrogate.version).toBe(10)
    expect(report.surrogate.heads.success).toBeNull()
    expect(report.surrogate.heads.tokens).toBeNull()
    expect(report.surrogate.heads.durationMs).toBeNull()
    expect(report.disclaimer).toContain('KHÔNG tự thay quyết định')
  })

  test('E3 history khớp đúng số đếm từ mảng seed (tokens/duration median đúng cụm)', async () => {
    const runs = synthRuns(120, 31, true)
    const alphaRuns = runs.filter(r => r.model === 'alpha')
    const report = await buildReplayReport({ model: 'alpha', agent: null, delegated: false })
    expect(report.history.nModelRuns).toBe(alphaRuns.length)
    expect(report.history.nModelSuccess).toBe(alphaRuns.filter(r => r.complete).length)
    expect(report.history.successRate).toBeCloseTo(
      alphaRuns.filter(r => r.complete).length / alphaRuns.length, 10,
    )
    // Median tokens alpha ∈ [800, 1200] (log-space median ≈ giữa cụm)
    expect(report.history.tokensMedian).toBeGreaterThanOrEqual(700)
    expect(report.history.tokensMedian).toBeLessThanOrEqual(1400)
    expect(report.history.durationMedianMs).toBeGreaterThanOrEqual(1400)
    expect(report.history.durationMedianMs).toBeLessThanOrEqual(2100)
    // CI bootstrap của median cũng trong cụm
    expect(report.history.tokensCi!.low).toBeLessThanOrEqual(report.history.tokensCi!.high)
  })

  test('E4 bootstrap CI TẤT ĐỊNH: 2 lần gọi → deep-equal (trừ generatedAt)', async () => {
    const a = await buildReplayReport({ model: 'alpha', agent: 'Omega', delegated: false })
    const b = await buildReplayReport({ model: 'alpha', agent: 'Omega', delegated: false })
    expect({ ...a, generatedAt: undefined }).toEqual({ ...b, generatedAt: undefined })
    expect(a.bootstrap).toEqual({ replicates: 500, seed: 42 })
  })

  test('E5 cờ ON + active + đầu thắng CV → heads.success.pSuccess khớp applySurrogateHead', async () => {
    await setTuningValue('replay_eval', 'on')
    expect(getTuningEnum('replay_eval')).toBe('on')
    const active = await loadActiveSurrogate()
    expect(active).not.toBeNull()
    const direct = applySurrogateHead(active!, { model: 'alpha', agent: 'Omega', delegated: false })
    const report = await buildReplayReport({ model: 'alpha', agent: 'Omega', delegated: false })
    expect(report.flag.value).toBe('on')
    expect(report.surrogate.heads.success).not.toBeNull()
    expect(report.surrogate.heads.success!.pSuccess).toBeCloseTo(direct.success!, 12)
    expect(report.surrogate.heads.tokens).not.toBeNull()
    expect(report.surrogate.heads.tokens!.estimate).toBeCloseTo(direct.tokens!, 9)
    expect(report.surrogate.heads.durationMs).not.toBeNull()
    // Chất lượng CV đi kèm ước lượng (không có điểm số trần trụi)
    expect(report.surrogate.heads.success!.cvBrier).toBeLessThan(report.surrogate.heads.success!.brierBaseline)
    expect(typeof report.surrogate.heads.success!.auc).toBe('number')
    await resetTuningValue('replay_eval')
    expect(getTuningEnum('replay_eval')).toBe('off')
  })

  test('E6 cờ ON nhưng KHÔNG active (rollback) → active=false + heads null', async () => {
    await setTuningValue('replay_eval', 'on')
    await db.brainModel.updateMany({ where: { brain: 'surrogate' }, data: { active: false } })
    const report = await buildReplayReport({ model: 'alpha', agent: null, delegated: false })
    expect(report.flag.value).toBe('on')
    expect(report.surrogate.active).toBe(false)
    expect(report.surrogate.heads.success).toBeNull()
    // Phục hồi
    await db.brainModel.updateMany({ where: { brain: 'surrogate', version: 10 }, data: { active: true } })
    await resetTuningValue('replay_eval')
  })

  test('E7 model LẠ chưa từng chạy: history n=0/rate null/CI null — không bịa số; MLP vẫn ước lượng được', async () => {
    await setTuningValue('replay_eval', 'on')
    const report = await buildReplayReport({ model: 'kimi-k3-never-run', agent: 'Omega', delegated: false })
    expect(report.history.nModelRuns).toBe(0)
    expect(report.history.nModelSuccess).toBe(0)
    expect(report.history.successRate).toBeNull()
    expect(report.history.successCi).toBeNull()
    expect(report.history.tokensMedian).toBeNull()
    expect(report.history.tokensCi).toBeNull()
    expect(report.successWilson).toBeNull()
    // Bootstrap action chưa thử: ước lượng MLP tính được từ one-hot 0
    expect(report.surrogate.heads.success).not.toBeNull()
    expect(report.surrogate.heads.success!.pSuccess).toBeGreaterThanOrEqual(0)
    expect(report.surrogate.heads.success!.pSuccess).toBeLessThanOrEqual(1)
    await resetTuningValue('replay_eval')
  })

  test('E8 route: thiếu model → 400; body rác → 400', async () => {
    const noModel = await replayRoutePOST(new Request('http://t/api/brain/replay', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent: 'Omega' }),
    }))
    expect(noModel.status).toBe(400)
    const badJson = await replayRoutePOST(new Request('http://t/api/brain/replay', {
      method: 'POST',
      body: 'not-json',
    }))
    expect(badJson.status).toBe(400)
    // model rỗng sau trim → 400
    const blank = await replayRoutePOST(new Request('http://t/api/brain/replay', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: '   ' }),
    }))
    expect(blank.status).toBe(400)
  })
})

// ==================== F. CỜ replay_eval + REGISTRY (STORE > ENV > DEFAULT) ====================

describe('r86 · F cờ replay_eval + registry pins', () => {
  beforeAll(async () => {
    delete process.env.REPLAY_EVAL
    await resetTuningValue('replay_eval').catch(() => {})
    await refreshTuningSnapshot()
  })
  // Janitor cuối file: F5 đọc xong trạng thái C → dọn SẠCH toàn bộ bảng
  // ảnh hưởng (AgentRunRecord seed + BrainModel surrogate + tuning param)
  afterAll(async () => {
    await resetTuningValue('replay_eval').catch(() => {})
    delete process.env.REPLAY_EVAL
    await refreshTuningSnapshot()
    await wipeSurrogateTables()
  })

  test('F1 spec pin trong TUNING_SPECS: enum off/on, default off, envKey REPLAY_EVAL', () => {
    const spec = TUNING_SPECS.find(s => s.key === 'replay_eval')
    expect(spec).toBeDefined()
    expect(spec!.type).toBe('enum')
    expect(spec!.enumValues).toEqual(['off', 'on'])
    expect(spec!.default).toBe('off')
    expect(spec!.envKey).toBe('REPLAY_EVAL')
    expect(spec!.nodeId).toBe('softmax-policy')
    expect((spec!.warning ?? '').length).toBeGreaterThan(10)
    expect(TUNING_SPECS.length).toBe(15) // 14 (sau BRAIN-P2) + replay_eval
  })

  test('F2 NEURAL_NODES softmax-policy paramKeys gồm replay_eval (gắn đúng node)', () => {
    const node = NEURAL_NODES.find(n => n.id === 'softmax-policy')
    expect(node).toBeDefined()
    expect(node!.paramKeys).toContain('replay_eval')
    expect(node!.paramKeys).toContain('runtime_model_policy')
  })

  test('F3 BRAIN_TRAINABLE_KEYS = [calibration_v3, surrogate] + TRAINING_IMPLEMENTED', () => {
    expect(BRAIN_TRAINABLE_KEYS).toEqual(['calibration_v3', 'surrogate'])
    expect(BRAIN_TRAINING_IMPLEMENTED).toBe(true)
  })

  test('F4 ENV thắng default; STORE thắng ENV; reset về default', async () => {
    expect(getTuningEnum('replay_eval')).toBe('off') // DEFAULT
    process.env.REPLAY_EVAL = 'on'
    expect(getTuningEnum('replay_eval')).toBe('on') // ENV > DEFAULT
    process.env.REPLAY_EVAL = 'yes' // giá trị lạ → off (envMap chuẩn hoá)
    expect(getTuningEnum('replay_eval')).toBe('off')
    process.env.REPLAY_EVAL = 'off'
    await setTuningValue('replay_eval', 'on')
    expect(getTuningEnum('replay_eval')).toBe('on') // STORE > ENV
    await resetTuningValue('replay_eval')
    expect(getTuningEnum('replay_eval')).toBe('off') // rơi về ENV=off
    delete process.env.REPLAY_EVAL
    expect(getTuningEnum('replay_eval')).toBe('off')
  })

  test('F5 GET /api/brain → surrogate: trainable=true, flagTuningKey=repeat đúng', async () => {
    const res = await brainRouteGET()
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.trainingImplemented).toBe(true)
    const surrogate = json.brains.find((b: { key: string }) => b.key === 'surrogate')
    expect(surrogate).toBeDefined()
    expect(surrogate.trainable).toBe(true)
    expect(surrogate.flagTuningKey).toBe('replay_eval')
    expect(surrogate.flag).toBe('REPLAY_EVAL')
    expect(surrogate.lifecycle).toBe('active') // v9 active từ C
    expect(surrogate.models.length).toBeGreaterThan(0)
    // meta parse từ trainMeta: cvScore + brierBaseline (đối chứng base-rate)
    const active = surrogate.models.find((m: { active: boolean }) => m.active)
    expect(active).toBeDefined()
    expect(active.meta.nSamples).toBe(120)
    expect(active.meta.cvScore).toBeLessThan(active.meta.brierBaseline)
    expect(active.meta.improved).toBe(true)
  })
})

// ==================== G. A7 WIRING CHO BRAIN-A (không phá P2) ====================

describe('r86 · G single-flight A7 cho Brain-A (calibration_v3)', () => {
  test('G1 khóa đang giữ → trainBrainCalibrationV3 trả busy, không đụng DB', async () => {
    expect(acquireTrainLock('calibration_v3')).toBe(true)
    const res = await trainBrainCalibrationV3()
    expect(res.trained).toBe(false)
    expect(res.error).toContain('single-flight')
    releaseTrainLock('calibration_v3')
    // Sau release → pipeline P2 chạy lại như thường (kết quả theo DB hiện
    // trạng — đủ mẫu hay không là việc của nó, miễn không phải busy)
    const res2 = await trainBrainCalibrationV3()
    expect(res2.error ?? '').not.toContain('single-flight')
  })

  test('G2 2 brain khóa ĐỘC LẬP — giữ surrogate không chặn calibration_v3', () => {
    expect(acquireTrainLock('surrogate')).toBe(true)
    expect(acquireTrainLock('calibration_v3')).toBe(true) // vẫn chiếm được
    releaseTrainLock('surrogate')
    releaseTrainLock('calibration_v3')
    expect(isTrainLocked('surrogate')).toBe(false)
    expect(isTrainLocked('calibration_v3')).toBe(false)
  })
})
