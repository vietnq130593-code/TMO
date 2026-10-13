/**
 * ROUND-87 TESTS — BRAIN-P4 · BRAIN-C "Lệnh" POLICY HEAD + COMPOSITE REWARD
 * (blueprint §4.4 + §3.1 — Q1 user chốt 2026-10-12, blueprint v0.9)
 *
 * Đo lường:
 *   A. buildPolicySpec/replicateCount — pin kiến trúc D→32(tanh)→|A|(softmax)
 *      + crossEntropy + adam seed 42: validateSpec qua, paramCount =
 *      D·32+32+32·|A|+|A|; 2 lần build deep-equal; hợp đồng featureDim
 *      <1 / actionCount <2 → throw; replicateCount bảng thật (R=1→8, 0→4,
 *      −1→0, NaN→0, kẹp biên, scale vô hiệu → throw).
 *   B. policyLambda — pin CÔNG THỨC λ = 1 − min(clamp(n/K,0,1), wilsonLB):
 *      n≤0/NaN → 1; n=40 p̂≈0.55 → 1−min(0.2, wilsonLB) (derivable bằng
 *      wilsonCI trực tiếp trong test); n=200 p̂=0.9 → λ < 0.2 (dữ liệu lớn
 *      + kết quả tốt → π_net được tin); λ GIẢM dần theo n (n=40 > λ(n=200)).
 *   C. crossValidatePolicy (thuần) — SIGNAL (action quyết định bởi agent:
 *      OMEGA→alpha thắng 80%, FORGE→beta 30%) → mixture thắng π_Q uniform
 *      NGẶT (CE < ln 2); hợp đồng: length-mismatch 4 mảng → throw; qScores
 *      sai chiều → throw; folds 5.5/NaN/0/1 → null; folds=2 chạy được;
 *      lệch lớp Outcome* → null.
 *   D. trainBrainPolicy (DB cô lập) — telemetry trung thực mọi nhánh từ chối
 *      (Q < 30 / verdicts < 50 / runs < 30 / mode 'pca-128' chờ Q2); SIGNAL
 *      đủ điều kiện → trained=true active=true v1 (BrainModel đầy đủ:
 *      specJson vocab/actionVocab, weightsJson envelope, trainMeta λ/CV/
 *      reward/qBaseline/standardization stds FULL precision > 0/dataLineage
 *      runIds §5.3); train lần 2 cùng dữ liệu → v2 + đúng 1 active (A1) +
 *      weightsJson BIT-ĐỐI-BIT (tất định seed); 6 lần train → prune A2 giữ
 *      5 mới nhất; single-flight A7: khóa đang giữ → trained=false.
 *   E. loadActivePolicy + applyPolicyMixture — fail-open mọi nhánh (không
 *      active → null; nSamples < 20 → null; stds=0 corrupt → null
 *      FB-BRAIN-P2-R1-01; weightsJson rách → null); SIGNAL: OMEGA → mixture
 *      rank alpha > beta (quan hệ thật), probs tổng 1; hợp đồng throw:
 *      qProbs sai chiều / toàn-0; action lạ → π_Q nguyên vẹn (netShare 0);
 *      mixture known+unknown: unknown chỉ giữ phần λ·π_Q.
 *   F. GET /api/brain/policy — READ-ONLY TUYỆT ĐỐI (count 6 bảng không đổi);
 *      flag off mặc định + organs off + proposals []; organ tuning on +
 *      active → proposals đủ 2 mục (runtime_model_policy=softmax khi Q ≥ 30
 *      · runtime_policy=on khi có bản active) — KHÔNG ghi TuningParam/
 *      TuningChangeLog; reward block: weights 1/3, mode log-only, sweep
 *      infeasible trên dữ liệu ít.
 *   G. Composite reward (reward.ts) — normalizeEfficiency (kẹp [−1,1],
 *      baseline ≤0 → null); compositeReward renormalize khi quality null
 *      (derivable tay: outcome=1, eff=0.5, w đều 1/3 → R=0.75); outcome
 *      ngoài {0,1} → null; eff ngoài [−1,1] → null; outcomeFromEvidence
 *      (refuted ưu tiên → 0; confirmed∧complete → 1; fallback complete);
 *      logCompositeRewardForRun READ-ONLY (count không đổi, KHÔNG tạo
 *      QEntry — updateQ giữ nguyên W2 nhị phân); sweepRewardWeights
 *      (<6 mẫu → infeasible + equal weights; 2-model signal → feasible,
 *      weights tổng 1, correlation > 0.5, tất định 2 lần deep-equal);
 *      spearmanRank pin tay (perfect → 1, đảo → −1, tie average-rank →
 *      1.5/√3 ≈ 0.866).
 *   H. Cờ + kill-switch organs — TUNING_SPECS 25 mục (PIN UPDATE Task 11:
 *      BRAIN-UX §9 +6 key), 4 cờ mới pin đủ
 *      (enum off/on, default off, envKey, node softmax-policy); NEURAL_NODES
 *      softmax-policy paramKeys đủ 13 (PIN UPDATE Task 11); ENV 'on' thắng default; STORE thắng
 *      ENV; reset về default; BRAIN_TRAINABLE_KEYS đủ 3; GET /api/brain →
 *      policy trainable; maybeMixModelProbs/buildPolicyAdvisoryBlock/
 *      buildTuningProposals kill-switch off → null/''/[] (hành vi y hệt P3).
 *
 * Nguyên tắc test:
 * - DB-cô-lập (bunfig preload copy DB) — WIPE AgentRunRecord + QEntry +
 *   ArbiterVerdict + BrainModel policy + TuningParam 4 cờ P4 trước seed;
 *   env RUNTIME_POLICY/POLICY_ORGAN_* dọn ở beforeAll VÀ afterAll (snapshot
 *   tuning-store process-global).
 * - Mọi expected DẪN NGUỒN ĐƯỢC (comment công thức/smoke) — synthetic data
 *   bằng LCG deterministic (không Math.random).
 * - createdAt PHÂN TÁN mỗi row +1s (bài học flaky FB-BRAIN-P2-R2-02).
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { db } from '@/lib/db'
import { MLP, validateSpec } from '@/lib/brain/mlp'
import {
  buildPolicySpec,
  buildPolicyVocab,
  buildPolicyActionVocab,
  buildPolicyFeatureRow,
  policyFeatureNames,
  policyLambda,
  replicateCount,
  crossValidatePolicy,
  trainBrainPolicy,
  loadActivePolicy,
  applyPolicyMixture,
  maybeMixModelProbs,
  buildPolicyAdvisoryBlock,
  buildTuningProposals,
  isRuntimePolicyEnabled,
  isPolicyOrganEnabled,
  POLICY_INPUT_MODE,
  POLICY_MIN_TRAIN_SAMPLES,
  POLICY_MIN_Q_ENTRIES,
  POLICY_MIN_VERDICTS,
  POLICY_MIN_RUNTIME_SAMPLES,
  POLICY_SEED,
  POLICY_LAMBDA_K,
  POLICY_REPLICATE_SCALE,
  type PolicyVocab,
} from '@/lib/brain/brains/policy'
import { acquireTrainLock, releaseTrainLock } from '@/lib/brain/train-lock'
import {
  REWARD_WEIGHTS,
  normalizeEfficiency,
  compositeReward,
  outcomeFromEvidence,
  computeRunReward,
  logCompositeRewardForRun,
  sweepRewardWeights,
  spearmanRank,
  collectTokenBaselines,
} from '@/lib/brain/reward'
import { qLearningUpdate } from '@/lib/learning/q-table'
import { wilsonCI } from '@/lib/stats'
import { POST as trainRoutePOST } from '@/app/api/brain/train/route'
import { GET as policyReportGET } from '@/app/api/brain/policy/route'
import { GET as brainRouteGET } from '@/app/api/brain/route'
import { TUNING_SPECS, NEURAL_NODES } from '@/lib/learning/neural-types'
import {
  getTuningEnum,
  setTuningValue,
  resetTuningValue,
  refreshTuningSnapshot,
} from '@/lib/learning/tuning-store'
import {
  BRAIN_TRAINABLE_KEYS,
  BRAIN_TRAINING_IMPLEMENTED,
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

// ==================== SEED DATA ====================

/** 1 row AgentRunRecord hợp lệ cho pipeline Brain-C */
interface SeedRun {
  model: string
  agent: string | null
  delegated: boolean
  complete: boolean
  tokens: number
}

/**
 * Dựng synthetic runs cho BRAIN-C:
 *  - signal=true: AGENT quyết định action + kết cục — OMEGA chạy 'alpha'
 *    (80% complete), FORGE chạy 'beta' (30% complete); tokens cố định 1000
 *    cho mọi run → median từng model = 1000 → Efficiency* = 0 tuyệt đối →
 *    reward R = Outcome*·(1/3)/(2/3) = 0.5·Outcome* (derivable tay) —
 *    π_net học mapping agent→action trong khi π_Q (Q=0 seeded) uniform mù.
 *  - signal=false: action độc lập agent (50/50), cả 2 model 55% — không có
 *    gì để học ngoài noise (CE mixture ≈ CE π_Q — theo seed, cùng tinh thần
 *    FB-BRAIN-P2-R1-02).
 */
function synthRuns(n: number, seed: number, signal: boolean): SeedRun[] {
  const rand = lcg(seed)
  const rows: SeedRun[] = []
  for (let i = 0; i < n; i++) {
    const agent = rand() < 0.5 ? 'OMEGA' : 'FORGE'
    const model = signal ? (agent === 'OMEGA' ? 'alpha' : 'beta') : rand() < 0.5 ? 'alpha' : 'beta'
    const pSuccess = signal ? (agent === 'OMEGA' ? 0.8 : 0.3) : 0.55
    rows.push({
      model,
      agent,
      delegated: rand() < 0.2,
      complete: rand() < pSuccess,
      tokens: 1000,
    })
  }
  return rows
}

/** WIPE bảng ảnh hưởng Brain-C (trước seed + dọn sau test) */
async function wipePolicyTables(): Promise<void> {
  await db.agentRunRecord.deleteMany({})
  await db.qEntry.deleteMany({})
  await db.arbiterVerdict.deleteMany({})
  await db.brainModel.deleteMany({ where: { brain: 'policy' } })
  await db.tuningParam.deleteMany({
    where: { key: { in: ['runtime_policy', 'policy_organ_routing', 'policy_organ_adaptation', 'policy_organ_tuning'] } },
  })
}

/**
 * Seed AgentRunRecord rows — createdAt phân tán mỗi row +1s (tie-break
 * orderBy ổn định — bài học FB-BRAIN-P2-R2-02).
 */
async function seedAgentRuns(runs: SeedRun[], sessionIdPrefix = 'r87-run-session'): Promise<string[]> {
  await db.agentRunRecord.deleteMany({})
  const sessionIds: string[] = []
  const base = Date.now() - runs.length * 1000
  for (let i = 0; i < runs.length; i++) {
    const r = runs[i]
    const sessionId = `${sessionIdPrefix}-${i}`
    sessionIds.push(sessionId)
    await db.agentRunRecord.create({
      data: {
        sessionId,
        runId: `run_r87_${i}`,
        agentName: r.agent,
        model: r.model,
        status: r.complete ? 'completed' : 'failed',
        stopReason: r.complete ? 'complete' : 'error',
        cycles: 1 + (i % 3),
        tokensUsed: r.tokens,
        toolCalls: 2,
        toolFailures: 0,
        durationMs: 5000,
        complete: r.complete,
        startedAt: new Date(base + i * 1000),
        completedAt: new Date(base + i * 1000 + 5000),
        createdAt: new Date(base + i * 1000),
        parentRunId: r.delegated ? 'run_parent_r87' : null,
      },
    })
  }
  return sessionIds
}

/**
 * Seed QEntry (ngưỡng §2 ≥ 30) — MỖI row một (stateKey, actionKey) duy nhất
 * (ràng buộc @@unique) — qValue=0 → π_Q = softmax(0/τ) uniform khi đọc qua
 * getQAdvice (entry thiếu → q=0 — đúng tinh thần "chưa có dữ liệu → uniform
 * prior" q-table).
 */
async function seedQEntries(n: number): Promise<void> {
  await db.qEntry.deleteMany({})
  for (let i = 0; i < n; i++) {
    await db.qEntry.create({
      data: { stateKey: `q-state-r87-${i}`, actionKey: i % 2 === 0 ? 'alpha' : 'beta', qValue: 0, visits: 1 },
    })
  }
}

/** Seed ArbiterVerdict (ngưỡng §2 ≥ 50) trên session RIÊNG — không dính
 *  session của run (outcome run giữ fallback complete boolean — tách bạch
 *  để đo đúng hành vi mỗi nhánh). */
async function seedVerdicts(n: number): Promise<void> {
  await db.arbiterVerdict.deleteMany({})
  for (let i = 0; i < n; i++) {
    await db.arbiterVerdict.create({
      data: {
        sessionId: `r87-verdict-session-${i}`,
        cycle: 1,
        complete: true,
        confidence: 0.8,
        verified: true,
        outcome: i % 3 === 0 ? 'refuted' : 'confirmed',
      },
    })
  }
}

// ==================== SETUP / TEARDOWN ====================

const P4_FLAG_KEYS = ['runtime_policy', 'policy_organ_routing', 'policy_organ_adaptation', 'policy_organ_tuning'] as const
const P4_ENV_KEYS = ['RUNTIME_POLICY', 'POLICY_ORGAN_ROUTING', 'POLICY_ORGAN_ADAPTATION', 'POLICY_ORGAN_TUNING'] as const

beforeAll(async () => {
  for (const k of P4_ENV_KEYS) delete process.env[k]
  await refreshTuningSnapshot()
  await wipePolicyTables()
})

afterAll(async () => {
  for (const k of P4_ENV_KEYS) delete process.env[k]
  for (const k of P4_FLAG_KEYS) await resetTuningValue(k).catch(() => {})
  await refreshTuningSnapshot()
  await wipePolicyTables()
})

// ==================== A. buildPolicySpec + replicateCount ====================

describe('r87 · A buildPolicySpec + replicateCount — kiến trúc blueprint §4.4', () => {
  test('A1 D=3 (2 agent + delegated) → 32(tanh) → |A|=2(softmax) + crossEntropy + adam seed 42', () => {
    const spec = buildPolicySpec(3, 2)
    validateSpec(spec) // không throw
    expect(spec.layers.length).toBe(3)
    expect(spec.layers[0]).toEqual({ units: 3, activation: 'linear' }) // hợp đồng dữ liệu — tiền lệ V3
    expect(spec.layers[1]).toEqual({ units: 32, activation: 'tanh' })
    expect(spec.layers[2]).toEqual({ units: 2, activation: 'softmax' })
    expect(spec.loss).toBe('crossEntropy')
    expect(spec.optimizer).toBe('adam')
    expect(spec.lr).toBe(0.01)
    expect(spec.l2).toBe(0.01)
    expect(spec.seed).toBe(POLICY_SEED)
    expect(POLICY_SEED).toBe(42)
  })

  test('A2 paramCount = 3·32+32 + 32·2+2 = 194 (xa trần 250K BRAIN_MAX_PARAMS)', () => {
    const mlp = new MLP(buildPolicySpec(3, 2))
    expect(mlp.paramCount()).toBe(194)
  })

  test('A3 2 lần build deep-equal (tất định thuần)', () => {
    expect(buildPolicySpec(3, 2)).toEqual(buildPolicySpec(3, 2))
  })

  test('A4 hợp đồng: featureDim < 1 / actionCount < 2 → throw rõ ràng', () => {
    expect(() => buildPolicySpec(0, 2)).toThrow(/featureDim/)
    expect(() => buildPolicySpec(1.5, 2)).toThrow(/featureDim/)
    expect(() => buildPolicySpec(3, 1)).toThrow(/actionCount/)
    expect(() => buildPolicySpec(3, 0)).toThrow(/actionCount/)
  })

  test('A5 vocab + featureNames + hàng đặc trưng: agent sorted, delegated cuối; one-hot đúng vị trí', () => {
    const vocab = buildPolicyVocab([
      { agent: 'OMEGA', delegated: false },
      { agent: null, delegated: true },
      { agent: 'FORGE', delegated: false },
    ])
    expect(vocab).toEqual({ agents: ['FORGE', 'OMEGA'] })
    expect(policyFeatureNames(vocab)).toEqual(['agent:FORGE', 'agent:OMEGA', 'delegated'])
    expect(buildPolicyFeatureRow({ agent: 'OMEGA', delegated: true }, vocab)).toEqual([0, 1, 1])
    expect(buildPolicyFeatureRow({ agent: 'THƯ_KÝ_LẠ', delegated: false }, vocab)).toEqual([0, 0, 0])
    // Action vocab: sorted unique, lọc rỗng
    expect(buildPolicyActionVocab(['beta', 'alpha', 'beta', ''])).toEqual({ models: ['alpha', 'beta'] })
  })

  test('A6 replicateCount bảng thật: R=1→8 · 0→4 · −1→0 · 0.25→5 · NaN→0 · kẹp biên · scale vô hiệu throw', () => {
    expect(POLICY_REPLICATE_SCALE).toBe(8)
    expect(replicateCount(1)).toBe(8) // round((1+1)/2·8) = 8
    expect(replicateCount(0)).toBe(4) // round(0.5·8)
    expect(replicateCount(-1)).toBe(0) // không bắt chước
    expect(replicateCount(0.25)).toBe(5) // round(0.625·8) = 5
    expect(replicateCount(2)).toBe(8) // kẹp biên trên
    expect(replicateCount(-5)).toBe(0) // kẹp biên dưới
    expect(replicateCount(Number.NaN)).toBe(0) // NaN → 0 bản
    expect(replicateCount(0.5, 4)).toBe(3) // round(0.75·4)
    expect(() => replicateCount(0, 0)).toThrow(/scale/)
    expect(() => replicateCount(0, 1.5)).toThrow(/scale/)
  })
})

// ==================== B. policyLambda — pin công thức ====================

describe('r87 · B policyLambda — λ = 1 − min(clamp(n/K,0,1), wilsonLB(p̂,n))', () => {
  test('B1 thiếu dữ liệu → λ=1 (nghe Q nguyên vẹn — fail-open)', () => {
    expect(policyLambda(0, 0.9)).toBe(1)
    expect(policyLambda(-5, 0.9)).toBe(1)
    expect(policyLambda(Number.NaN, 0.9)).toBe(1)
    expect(policyLambda(40, Number.NaN)).toBe(1)
    expect(policyLambda(Number.POSITIVE_INFINITY, 0.9)).toBe(1)
  })

  test('B2 n=40, p̂=0.55 → λ = 1 − min(40/200, wilsonLB) — DERIVABLE bằng wilsonCI trực tiếp', () => {
    const wilsonLb = wilsonCI(0.55, 40).low // độc lập cùng công thức
    const expected = 1 - Math.min(40 / POLICY_LAMBDA_K, wilsonLb)
    expect(policyLambda(40, 0.55)).toBeCloseTo(expected, 12)
    // wilsonLB(0.55, 40) ≈ 0.398 > ramp 0.2 → min là ramp → λ = 0.8
    expect(wilsonLb).toBeGreaterThan(0.2)
    expect(policyLambda(40, 0.55)).toBeCloseTo(0.8, 12)
  })

  test('B3 n=200 p̂=0.9 → λ < 0.2 (dữ liệu lớn + kết quả tốt → tin π_net)', () => {
    // ramp = 1; wilsonLB(0.9,200) ≈ 0.8506 → λ ≈ 0.1494
    const wilsonLb = wilsonCI(0.9, 200).low
    expect(policyLambda(200, 0.9)).toBeCloseTo(1 - Math.min(1, wilsonLb), 12)
    expect(policyLambda(200, 0.9)).toBeLessThan(0.2)
  })

  test('B4 λ GIẢM dần khi dữ liệu lớn lên (p̂ giữ nguyên — đúng ý định §4.4)', () => {
    const l40 = policyLambda(40, 0.9)
    const l100 = policyLambda(100, 0.9)
    const l200 = policyLambda(200, 0.9)
    expect(l100).toBeLessThan(l40)
    expect(l200).toBeLessThan(l100)
  })

  test('B5 kết quả kém → λ cao hơn (Wilson chặn phần π_net)', () => {
    // cùng n: p̂=0.3 → wilsonLB thấp hơn → net share nhỏ hơn → λ lớn hơn
    expect(policyLambda(200, 0.3)).toBeGreaterThan(policyLambda(200, 0.9))
  })

  test('B6 K vô hiệu → về default 200; output luôn kẹp [0,1]', () => {
    expect(policyLambda(100, 0.9, 0)).toBeCloseTo(policyLambda(100, 0.9), 12)
    expect(policyLambda(100, 0.9, Number.NaN)).toBeCloseTo(policyLambda(100, 0.9), 12)
    expect(policyLambda(1000, 1)).toBeLessThanOrEqual(1)
    expect(policyLambda(1000, 1)).toBeGreaterThanOrEqual(0)
  })
})

// ==================== C. crossValidatePolicy (thuần) ====================

describe('r87 · C crossValidatePolicy — kỷ luật thăng cấp mixture vs π_Q', () => {
  const vocab: PolicyVocab = { agents: ['FORGE', 'OMEGA'] }
  const d = policyFeatureNames(vocab).length // = 3

  /** Dựng mảng CV từ SeedRun (features theo vocab + action theo actionVocab). */
  function toCvArrays(runs: SeedRun[]) {
    const actionVocab = buildPolicyActionVocab(runs.map(r => r.model))
    const actionIndex = new Map(actionVocab.models.map((m, i) => [m, i]))
    const X = runs.map(r => buildPolicyFeatureRow({ agent: r.agent, delegated: r.delegated }, vocab))
    const actions = runs.map(r => actionIndex.get(r.model) as number)
    const outcomeLabels = runs.map(r => (r.complete ? 1 : 0))
    // Reward derivable: tokens=1000=median mỗi model → eff=0 → quality null
    // → R = outcome·(1/3)/(2/3) = 0.5·outcome (đúng synthRuns)
    const rewards = runs.map(r => (r.complete ? 0.5 : 0))
    const qScores = actionVocab.models.map(() => 0)
    return { X, actions, rewards, outcomeLabels, qScores, actionCount: actionVocab.models.length }
  }

  test('C1 SIGNAL (agent quyết định action + kết cục) → mixture thắng π_Q uniform NGẶT (CE < ln 2)', () => {
    const runs = synthRuns(40, 31, true)
    const { X, actions, rewards, outcomeLabels, qScores, actionCount } = toCvArrays(runs)
    const cv = crossValidatePolicy(X, actions, rewards, outcomeLabels, qScores, vocab, actionCount, { tau: 0.5 })
    expect(cv).not.toBeNull()
    // π_Q = softmax([0,0]/0.5) = uniform → CE_Q = ln 2 ≈ 0.6931 mọi mẫu
    expect(Math.log(2)).toBeCloseTo(0.6931, 3)
    expect(cv!.ceBaseline).toBeCloseTo(Math.log(2), 6)
    expect(cv!.improved).toBe(true)
    expect(cv!.cvCeMixture).toBeLessThan(cv!.ceBaseline)
    expect(cv!.folds).toBe(5)
    expect(cv!.foldCes).toHaveLength(5)
    expect(cv!.foldCesQ).toHaveLength(5)
    // λ từng fold từ tập train (~32 mẫu): 1 − min(32/200, wilsonLB) ∈ (0.7, 0.95)
    for (const lambda of cv!.foldLambdas) {
      expect(lambda).toBeGreaterThan(0.5)
      expect(lambda).toBeLessThanOrEqual(1)
    }
  })

  test('C2 SIGNAL 3 seed khác nhau (31/77/123) đều thắng — quan hệ thật không phải may 1 seed', () => {
    for (const seed of [31, 77, 123]) {
      const runs = synthRuns(40, seed, true)
      const { X, actions, rewards, outcomeLabels, qScores, actionCount } = toCvArrays(runs)
      const cv = crossValidatePolicy(X, actions, rewards, outcomeLabels, qScores, vocab, actionCount, { tau: 0.5 })
      expect(cv).not.toBeNull()
      expect(cv!.improved).toBe(true)
    }
  })

  test('C3 hợp đồng: 4 mảng length-mismatch → throw; qScores sai chiều → throw', () => {
    const runs = synthRuns(20, 7, true)
    const { X, actions, rewards, outcomeLabels, actionCount } = toCvArrays(runs)
    expect(() =>
      crossValidatePolicy(X.slice(1), actions, rewards, outcomeLabels, [0, 0], vocab, actionCount, {}),
    ).toThrow(/X.length/)
    expect(() =>
      crossValidatePolicy(X, actions, rewards.slice(1), outcomeLabels, [0, 0], vocab, actionCount, {}),
    ).toThrow(/X.length/)
    expect(() =>
      crossValidatePolicy(X, actions, rewards, outcomeLabels, [0, 0], vocab, actionCount + 1, {}),
    ).toThrow(/qScores/)
    expect(() =>
      crossValidatePolicy(X, actions, rewards, outcomeLabels, [0], vocab, actionCount, {}),
    ).toThrow(/qScores/)
  })

  test('C4 folds degenerate → null (5.5/NaN/0/1); folds=2 chạy được', () => {
    const runs = synthRuns(40, 31, true)
    const { X, actions, rewards, outcomeLabels, qScores, actionCount } = toCvArrays(runs)
    expect(crossValidatePolicy(X, actions, rewards, outcomeLabels, qScores, vocab, actionCount, { folds: 5.5 })).toBeNull()
    expect(crossValidatePolicy(X, actions, rewards, outcomeLabels, qScores, vocab, actionCount, { folds: Number.NaN })).toBeNull()
    expect(crossValidatePolicy(X, actions, rewards, outcomeLabels, qScores, vocab, actionCount, { folds: 0 })).toBeNull()
    expect(crossValidatePolicy(X, actions, rewards, outcomeLabels, qScores, vocab, actionCount, { folds: 1 })).toBeNull()
    const cv2 = crossValidatePolicy(X, actions, rewards, outcomeLabels, qScores, vocab, actionCount, { folds: 2 })
    expect(cv2).not.toBeNull()
    expect(cv2!.folds).toBe(2)
  })

  test('C5 lệch lớp Outcome* (toàn complete) → null (stratified không gán được fold)', () => {
    const runs: SeedRun[] = Array.from({ length: 20 }, (_, i) => ({
      model: i % 2 === 0 ? 'alpha' : 'beta',
      agent: i % 2 === 0 ? 'OMEGA' : 'FORGE',
      delegated: false,
      complete: true, // toàn 1 — một lớp
      tokens: 1000,
    }))
    const { X, actions, rewards, outcomeLabels, qScores, actionCount } = toCvArrays(runs)
    expect(crossValidatePolicy(X, actions, rewards, outcomeLabels, qScores, vocab, actionCount, {})).toBeNull()
  })

  test('C6 tất định: cùng dữ liệu → CV deep-equal', () => {
    const runs = synthRuns(30, 99, true)
    const { X, actions, rewards, outcomeLabels, qScores, actionCount } = toCvArrays(runs)
    const a = crossValidatePolicy(X, actions, rewards, outcomeLabels, qScores, vocab, actionCount, { tau: 0.5 })
    const b = crossValidatePolicy(X, actions, rewards, outcomeLabels, qScores, vocab, actionCount, { tau: 0.5 })
    expect(a).toEqual(b)
  })
})

// ==================== D. trainBrainPolicy (DB cô lập) ====================

describe('r87 · D trainBrainPolicy — cổng active kép + bất biến A1/A2/A7', () => {
  test('D1 DB trống → trained=false, telemetry trung thực (Q/verdicts/runs = 0 thật)', async () => {
    await wipePolicyTables()
    const result = await trainBrainPolicy()
    expect(result.trained).toBe(false)
    expect(result.active).toBe(false)
    expect(result.qEntries).toBe(0)
    expect(result.verdicts).toBe(0)
    expect(result.usable).toBe(0)
    expect(result.error).toContain('Q data')
    expect(await db.brainModel.count({ where: { brain: 'policy' } })).toBe(0)
  })

  test('D2 đủ Q + verdicts nhưng thiếu runs (< 30) → từ chối nhắc runs', async () => {
    await wipePolicyTables()
    await seedQEntries(35)
    await seedVerdicts(55)
    await seedAgentRuns(synthRuns(10, 5, true))
    const result = await trainBrainPolicy()
    expect(result.trained).toBe(false)
    expect(result.qEntries).toBe(35)
    expect(result.verdicts).toBe(55)
    expect(result.usable).toBe(10)
    expect(result.error).toContain('AgentRunRecord')
  })

  test('D3 inputMode vector pca-128 → từ chối rõ (chờ Q2) + telemetry số thật', async () => {
    await wipePolicyTables()
    await seedQEntries(35)
    await seedVerdicts(55)
    await seedAgentRuns(synthRuns(40, 31, true))
    const result = await trainBrainPolicy('pca-128')
    expect(result.trained).toBe(false)
    expect(result.error).toContain('pca-128')
    expect(result.qEntries).toBe(35) // FB-BRAIN-P2-R1-08 — telemetry trung thực
    expect(result.usable).toBe(40)
    expect(POLICY_INPUT_MODE).toBe('task-features')
  })

  test('D4 SIGNAL đủ điều kiện → trained=true active=true v1 + BrainModel đầy đủ', async () => {
    await wipePolicyTables()
    const runs = synthRuns(40, 31, true)
    await seedQEntries(35)
    await seedVerdicts(55)
    await seedAgentRuns(runs)
    const result = await trainBrainPolicy()
    expect(result.trained).toBe(true)
    expect(result.active).toBe(true)
    expect(result.improved).toBe(true)
    expect(result.version).toBe(1)
    expect(result.sampleSize).toBe(40)
    expect(result.qEntries).toBe(35)
    expect(result.verdicts).toBe(55)
    expect(result.cv).not.toBeNull()
    expect(result.cv!.improved).toBe(true)
    expect(POLICY_MIN_TRAIN_SAMPLES).toBe(30)
    expect(POLICY_MIN_Q_ENTRIES).toBe(30)
    expect(POLICY_MIN_VERDICTS).toBe(50)

    const row = await db.brainModel.findFirst({ where: { brain: 'policy', version: 1 } })
    expect(row).not.toBeNull()
    expect(row!.active).toBe(true)
    expect(row!.inputMode).toBe('task-features')
    const specDoc = JSON.parse(row!.specJson) as {
      vocab: PolicyVocab
      actionVocab: { models: string[] }
      spec: { layers: Array<{ units: number; activation: string }> }
    }
    expect(specDoc.vocab.agents).toEqual(['FORGE', 'OMEGA'])
    expect(specDoc.actionVocab.models).toEqual(['alpha', 'beta'])
    expect(specDoc.spec.layers[1]).toEqual({ units: 32, activation: 'tanh' })
    const meta = JSON.parse(row!.trainMetaJson) as Record<string, unknown>
    // λ = 1 − min(40/200, wilsonLB(p̂,40)) — derivable từ p̂ của chính dữ liệu seed
    const pHat = runs.filter(r => r.complete).length / runs.length
    const expectedLambda = policyLambda(40, pHat)
    expect(meta.lambda).toBeCloseTo(expectedLambda, 4)
    expect(meta.metric).toBe('ce(mixture vs π_Q)')
    expect(meta.improved).toBe(true)
    // stds FULL precision > 0 (bài học FB-BRAIN-P2-R1-01)
    const std = (meta.standardization as { stds: number[] }).stds
    expect(std.every((v: number) => v > 0)).toBe(true)
    // dataLineage §5.3 — runIds danh sách
    const lineage = meta.dataLineage as { runIds: string[]; tables: Record<string, number> }
    expect(lineage.runIds).toHaveLength(40)
    expect(lineage.tables.AgentRunRecord).toBe(40)
    // reward weights + qBaseline snapshot
    const rewardMeta = meta.reward as { weights: { outcome: number }; replicateScale: number }
    expect(rewardMeta.weights.outcome).toBeCloseTo(1 / 3, 12)
    expect(rewardMeta.replicateScale).toBe(POLICY_REPLICATE_SCALE)
    const qBase = meta.qBaseline as { tau: number; scores: number[] }
    expect(qBase.scores).toEqual([0, 0])
  })

  test('D5 train lần 2 cùng dữ liệu → v2, đúng 1 active (A1), weightsJson BIT-ĐỐI-BIT (tất định)', async () => {
    const v1 = await db.brainModel.findFirst({ where: { brain: 'policy', version: 1 } })
    const result = await trainBrainPolicy()
    expect(result.trained).toBe(true)
    expect(result.version).toBe(2)
    expect(result.active).toBe(true)
    const activeRows = await db.brainModel.findMany({ where: { brain: 'policy', active: true } })
    expect(activeRows).toHaveLength(1) // A1
    expect(activeRows[0].version).toBe(2)
    const v2 = await db.brainModel.findFirst({ where: { brain: 'policy', version: 2 } })
    expect(v2!.weightsJson).toBe(v1!.weightsJson) // tất định seed 42
  })

  test('D6 prune A2: 6 lần train → chỉ giữ 5 bản mới nhất (v1 bị dọn, mọi bản active giữ)', async () => {
    for (let i = 0; i < 4; i++) {
      const r = await trainBrainPolicy()
      expect(r.trained).toBe(true)
    }
    const rows = await db.brainModel.findMany({ where: { brain: 'policy' }, orderBy: { version: 'asc' } })
    expect(rows).toHaveLength(5) // 6 train → prune về 5
    expect(rows.map(r => r.version)).toEqual([2, 3, 4, 5, 6]) // v1 bị dọn
    expect(rows.filter(r => r.active)).toHaveLength(1)
  })

  test('D7 single-flight A7: khóa đang giữ → trained=false "bỏ lệnh trùng"', async () => {
    expect(acquireTrainLock('policy')).toBe(true)
    const result = await trainBrainPolicy()
    expect(result.trained).toBe(false)
    expect(result.error).toContain('single-flight')
    releaseTrainLock('policy')
    const after = await trainBrainPolicy()
    expect(after.trained).toBe(true)
  })

  test('D9 regression FB-BRAIN-P4-R1-01: verdict refuted gắn session run → successRate theo Outcome* KHÔNG theo complete', async () => {
    await wipePolicyTables()
    const runs = synthRuns(40, 31, true)
    const sessionIds = await seedAgentRuns(runs)
    await seedQEntries(35)
    await seedVerdicts(55)
    // Gắn verdict REFUTED lên 5 session có run COMPLETE → Outcome* của chúng
    // phải = 0 (refuted thắng mọi chiều — reward.ts outcomeFromEvidence) dù
    // complete vẫn true. Bản trước (R1-01) stratify/p̂ theo complete thô →
    // 2 nguồn nhãn lệch nhau trong 1 lần train.
    const nComplete = runs.filter(r => r.complete).length
    const completeSessions = sessionIds.filter((_, i) => runs[i].complete).slice(0, 5)
    expect(completeSessions.length).toBe(5) // đủ 5 session complete để gắn
    for (const sid of completeSessions) {
      await db.arbiterVerdict.create({
        data: { sessionId: sid, cycle: 1, complete: true, confidence: 0.9, verified: true, outcome: 'refuted' },
      })
    }
    const result = await trainBrainPolicy()
    expect(result.trained).toBe(true)
    const row = await db.brainModel.findFirst({ where: { brain: 'policy', version: result.version! } })
    const meta = JSON.parse(row!.trainMetaJson) as { successRate: number }
    // DERIVABLE: mean Outcome* = (nComplete − 5)/40 — KHÔNG PHẢI nComplete/40
    expect(meta.successRate).toBeCloseTo((nComplete - 5) / 40, 4)
    expect(meta.successRate).not.toBeCloseTo(nComplete / 40, 4)
  })

  test('D8 route POST /api/brain/train brain=policy — 200 đầy đủ CV; brain lạ vẫn 400', async () => {
    const res = await trainRoutePOST(new Request('http://t/api/brain/train', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ brain: 'policy' }),
    }))
    expect(res.status).toBe(200)
    const body = await res.json() as Record<string, unknown>
    expect(body.brain).toBe('policy')
    expect(body.trained).toBe(true)
    expect((body.cv as Record<string, unknown>).improved).toBe(true)

    const bad = await trainRoutePOST(new Request('http://t/api/brain/train', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ brain: 'brain-không-tồn-tại' }),
    }))
    expect(bad.status).toBe(400)
    const badBody = await bad.json() as { supported: string[] }
    expect(badBody.supported).toContain('policy')
  })
})

// ==================== E. loadActivePolicy + applyPolicyMixture ====================

describe('r87 · E loadActivePolicy + applyPolicyMixture — fail-open + hợp đồng', () => {
  test('E1 nạp bản active: đủ trường + λ đúng công thức từ nSamples/successRate', async () => {
    const active = await loadActivePolicy()
    expect(active).not.toBeNull()
    expect(active!.nSamples).toBe(40)
    expect(active!.version).toBeGreaterThan(0)
    expect(active!.vocab.agents).toEqual(['FORGE', 'OMEGA'])
    expect(active!.actionVocab.models).toEqual(['alpha', 'beta'])
    const expectedLambda = policyLambda(active!.nSamples, active!.successRate)
    expect(active!.lambda).toBeCloseTo(expectedLambda, 12)
  })

  test('E2 SIGNAL: OMEGA → mixture rank alpha > beta; FORGE → beta > alpha (quan hệ thật)', async () => {
    const active = await loadActivePolicy()
    expect(active).not.toBeNull()
    const qProbs = [0.5, 0.5] // π_Q uniform (Q=0)
    const omega = applyPolicyMixture(active!, qProbs, ['alpha', 'beta'], { agent: 'OMEGA', delegated: false })
    expect(omega.probs.reduce((s, v) => s + v, 0)).toBeCloseTo(1, 9)
    expect(omega.probs[0]).toBeGreaterThan(omega.probs[1]) // alpha > beta
    expect(omega.lambda).toBeLessThan(1)
    const forge = applyPolicyMixture(active!, qProbs, ['alpha', 'beta'], { agent: 'FORGE', delegated: true })
    expect(forge.probs[1]).toBeGreaterThan(forge.probs[0]) // beta > alpha
  })

  test('E3 hợp đồng throw: qProbs sai chiều candidates / toàn-0', async () => {
    const active = await loadActivePolicy()
    expect(active).not.toBeNull()
    // 1 prob vs 2 candidates → mismatch chiều → throw
    expect(() => applyPolicyMixture(active!, [0.5], ['alpha', 'beta'], { agent: 'OMEGA', delegated: false })).toThrow(/qProbs/)
    // phân phối toàn-0 (rác) → throw
    expect(() => applyPolicyMixture(active!, [0, 0], ['alpha', 'beta'], { agent: 'OMEGA', delegated: false })).toThrow(/qProbs/)
  })

  test('E4 action lạ (ngoài action vocab) → π_Q nguyên vẹn (netShare 0)', async () => {
    const active = await loadActivePolicy()
    expect(active).not.toBeNull()
    const mixed = applyPolicyMixture(active!, [0.7, 0.3], ['gamma-model-lạ', 'delta-lạ'], { agent: 'OMEGA', delegated: false })
    expect(mixed.netShare).toBe(0)
    expect(mixed.probs[0]).toBeCloseTo(0.7, 9)
    expect(mixed.probs[1]).toBeCloseTo(0.3, 9)
  })

  test('E5 mixture known+unknown: unknown chỉ giữ phần λ·π_Q, known nhận thêm phần net', async () => {
    const active = await loadActivePolicy()
    expect(active).not.toBeNull()
    // alpha đã học (OMEGA mapping) + gamma lạ
    const mixed = applyPolicyMixture(active!, [0.5, 0.5], ['alpha', 'gamma-lạ'], { agent: 'OMEGA', delegated: false })
    expect(mixed.netShare).toBeGreaterThan(0)
    expect(mixed.probs[0]).toBeGreaterThan(0.5) // alpha được cộng phần net
    expect(mixed.probs[1]).toBeLessThan(0.5) // gamma chỉ còn λ·0.5 (đã renormalize)
    expect(mixed.probs.reduce((s, v) => s + v, 0)).toBeCloseTo(1, 9)
  })

  test('E6 fail-open: không active → null; nSamples < 20 → null; stds=0 → null; weightsJson rách → null', async () => {
    // a) Không bản active
    await db.brainModel.deleteMany({ where: { brain: 'policy' } })
    expect(await loadActivePolicy()).toBeNull()
    // b) nSamples dưới ngưỡng runtime
    await seedQEntries(35)
    await seedVerdicts(55)
    await seedAgentRuns(synthRuns(40, 31, true))
    const r = await trainBrainPolicy()
    expect(r.trained).toBe(true)
    expect(POLICY_MIN_RUNTIME_SAMPLES).toBe(20)
    const good = await db.brainModel.findFirst({ where: { brain: 'policy', active: true } })
    const meta = JSON.parse(good!.trainMetaJson) as Record<string, unknown>
    meta.nSamples = 19 // falsify dưới ngưỡng
    await db.brainModel.update({ where: { id: good!.id }, data: { trainMetaJson: JSON.stringify(meta) } })
    expect(await loadActivePolicy()).toBeNull()
    // c) stds=0 corrupt (FB-BRAIN-P2-R1-01 — std 0 từng lọt vì "finite")
    meta.nSamples = 40
    const std = meta.standardization as { stds: number[] }
    std.stds = std.stds.map(() => 0)
    await db.brainModel.update({ where: { id: good!.id }, data: { trainMetaJson: JSON.stringify(meta) } })
    expect(await loadActivePolicy()).toBeNull()
    // d) weightsJson rách
    await db.brainModel.update({ where: { id: good!.id }, data: { weightsJson: '{không-phải-json' } })
    expect(await loadActivePolicy()).toBeNull()
    // e) khôi phục lại bản tốt cho các nhóm sau
    await wipePolicyTables()
    await seedQEntries(35)
    await seedVerdicts(55)
    await seedAgentRuns(synthRuns(40, 31, true))
    const again = await trainBrainPolicy()
    expect(again.trained).toBe(true)
    expect(again.active).toBe(true)
  })
})

// ==================== F. GET /api/brain/policy — READ-ONLY ====================

describe('r87 · F GET /api/brain/policy — report READ-ONLY + organ-3 proposals', () => {
  test('F1 READ-ONLY TUYỆT ĐỐI — count 6 bảng không đổi sau GET', async () => {
    const before = {
      runs: await db.agentRunRecord.count(),
      q: await db.qEntry.count(),
      verdicts: await db.arbiterVerdict.count(),
      brain: await db.brainModel.count(),
      tuning: await db.tuningParam.count(),
      tuningLog: await db.tuningChangeLog.count(),
    }
    const res = await policyReportGET()
    expect(res.status).toBe(200)
    const after = {
      runs: await db.agentRunRecord.count(),
      q: await db.qEntry.count(),
      verdicts: await db.arbiterVerdict.count(),
      brain: await db.brainModel.count(),
      tuning: await db.tuningParam.count(),
      tuningLog: await db.tuningChangeLog.count(),
    }
    expect(after).toEqual(before)
  })

  test('F2 flag off mặc định + organs off + proposals [] + reward log-only block', async () => {
    for (const k of P4_FLAG_KEYS) await resetTuningValue(k).catch(() => {})
    await refreshTuningSnapshot()
    const res = await policyReportGET()
    expect(res.status).toBe(200)
    const body = await res.json() as {
      flag: { value: string; organs: Record<string, string> }
      reward: { mode: string; weights: Record<string, number>; sweep: { feasible: boolean; reason: string; correlation: number | null }; recent: unknown[] }
      proposals: unknown[]
      active: { version: number; lambda: { value: number } } | null
    }
    expect(body.flag.value).toBe('off')
    expect(body.flag.organs).toEqual({ routing: 'off', adaptation: 'off', tuning: 'off' })
    expect(body.proposals).toEqual([]) // organ tuning off → kill-switch
    expect(body.reward.mode).toBe('log-only')
    expect(body.reward.weights.outcome).toBeCloseTo(1 / 3, 12)
    // Dữ liệu SIGNAL 40 runs / 2 model (alpha~80%, beta~30%) — cả 2 model đủ
    // ≥ 3 mẫu ở cả 2 nửa thời gian → sweep KHẢ THI (2 model đối chứng)
    expect(body.reward.sweep.feasible).toBe(true)
    expect(body.reward.sweep.correlation).toBeGreaterThan(0.5)
    expect(body.reward.recent.length).toBeGreaterThan(0)
    expect(body.active).not.toBeNull() // có bản active từ nhóm E
    expect(body.active!.lambda.value).toBeLessThan(1)
  })

  test('F3 organ tuning on + active + master off → proposals đủ 2 mục, KHÔNG ghi bảng nào', async () => {
    await setTuningValue('policy_organ_tuning', 'on')
    await refreshTuningSnapshot()
    const before = {
      tuning: await db.tuningParam.count(),
      tuningLog: await db.tuningChangeLog.count(),
    }
    const res = await policyReportGET()
    expect(res.status).toBe(200)
    const body = await res.json() as { proposals: Array<{ key: string; proposedValue: string; evidence: string }> }
    // Q=35 ≥ 30 + runtime_model_policy off → đề xuất softmax
    // active tồn tại + runtime_policy off → đề xuất on
    const keys = body.proposals.map(p => p.key)
    expect(keys).toContain('runtime_model_policy')
    expect(keys).toContain('runtime_policy')
    const modelPolicy = body.proposals.find(p => p.key === 'runtime_model_policy')!
    expect(modelPolicy.proposedValue).toBe('softmax')
    expect(modelPolicy.evidence).toContain('35')
    const runtime = body.proposals.find(p => p.key === 'runtime_policy')!
    expect(runtime.proposedValue).toBe('on')
    const after = { tuning: await db.tuningParam.count(), tuningLog: await db.tuningChangeLog.count() }
    expect(after.tuning).toBe(before.tuning) // proposal KHÔNG ghi TuningParam
    expect(after.tuningLog).toBe(before.tuningLog) // KHÔNG ghi TuningChangeLog
    await resetTuningValue('policy_organ_tuning').catch(() => {})
    await refreshTuningSnapshot()
  })

  test('F4 kill-switch organ tuning off → proposals [] (master on cũng vậy)', async () => {
    await setTuningValue('runtime_policy', 'on')
    await refreshTuningSnapshot()
    const res = await policyReportGET()
    const body = await res.json() as { proposals: unknown[] }
    expect(body.proposals).toEqual([]) // organ off thắng — kill-switch độc lập
    await resetTuningValue('runtime_policy').catch(() => {})
    await refreshTuningSnapshot()
  })
})

// ==================== G. Composite reward (reward.ts) ====================

describe('r87 · G composite reward — chuẩn hóa + renormalize + log-only + sweep', () => {
  test('G1 normalizeEfficiency: kẹp [−1,1]; baseline ≤ 0 / NaN / actual âm → null', () => {
    expect(normalizeEfficiency(500, 1000)).toBe(0.5) // (1000−500)/1000
    expect(normalizeEfficiency(2000, 1000)).toBe(-1) // kẹp biên dưới
    expect(normalizeEfficiency(0, 1000)).toBe(1) // kẹp biên trên
    expect(normalizeEfficiency(1000, 0)).toBeNull()
    expect(normalizeEfficiency(1000, -5)).toBeNull()
    expect(normalizeEfficiency(Number.NaN, 1000)).toBeNull()
    expect(normalizeEfficiency(-100, 1000)).toBeNull()
  })

  test('G2 compositeReward: renormalize khi quality null — DERIVABLE TAY (R=0.75)', () => {
    // outcome=1, eff=0.5, quality=null, w đều 1/3:
    // R = (1·⅓ + 0.5·⅓)/(⅓+⅓) = 1.5/2 = 0.75
    const r = compositeReward({ outcome: 1, efficiency: 0.5, quality: null })
    expect(r).not.toBeNull()
    expect(r!.reward).toBeCloseTo(0.75, 12)
    expect(r!.weightsUsed.outcome).toBeCloseTo(0.5, 12)
    expect(r!.weightsUsed.efficiency).toBeCloseTo(0.5, 12)
    expect(r!.weightsUsed.quality).toBe(0)
    // Đủ 3 thành phần: R = (1 + 0.5 + 0.5)/3 = 2/3
    const full = compositeReward({ outcome: 1, efficiency: 0.5, quality: 0.5 })
    expect(full!.reward).toBeCloseTo(2 / 3, 12)
    // Chỉ outcome: R = outcome
    const only = compositeReward({ outcome: 0, efficiency: null, quality: null })
    expect(only!.reward).toBe(0)
  })

  test('G3 compositeReward guard: outcome ngoài {0,1} → null; eff ngoài [−1,1] → null; quality ngoài [0,1] → null; weights rác → null', () => {
    expect(compositeReward({ outcome: 0.5, efficiency: null, quality: null })).toBeNull()
    expect(compositeReward({ outcome: 1, efficiency: 1.5, quality: null })).toBeNull()
    expect(compositeReward({ outcome: 1, efficiency: null, quality: 1.2 })).toBeNull()
    expect(compositeReward({ outcome: 1, efficiency: null, quality: null }, { outcome: -1, efficiency: 0, quality: 0 })).toBeNull()
    expect(compositeReward({ outcome: 1, efficiency: null, quality: null }, { outcome: 0, efficiency: 0, quality: 0 })).toBeNull()
  })

  test('G4 outcomeFromEvidence: refuted ưu tiên → 0; confirmed∧complete → 1; fallback complete', () => {
    expect(outcomeFromEvidence(true, { confirmed: 2, refuted: 1 })).toBe(0) // refuted thắng mọi chiều
    expect(outcomeFromEvidence(true, { confirmed: 2, refuted: 0 })).toBe(1)
    expect(outcomeFromEvidence(false, { confirmed: 2, refuted: 0 })).toBe(0) // confirmed nhưng run hỏng
    expect(outcomeFromEvidence(true, null)).toBe(1) // fallback
    expect(outcomeFromEvidence(false, null)).toBe(0)
  })

  test('G5 computeRunReward: tokens=median → eff=0 → R = 0.5·outcome (renormalize w₁=w₂)', async () => {
    const baselines = new Map([['alpha', 1000]])
    const good = computeRunReward({ complete: 1, tokensUsed: 1000, model: 'alpha' }, { confirmed: 1, refuted: 0 }, baselines)
    expect(good!.components.efficiency).toBe(0)
    expect(good!.reward).toBeCloseTo(0.5, 12)
    const bad = computeRunReward({ complete: 0, tokensUsed: 1000, model: 'alpha' }, null, baselines)
    expect(bad!.reward).toBe(0)
    // Model không có baseline → eff null → R = outcome
    const noBase = computeRunReward({ complete: 1, tokensUsed: 500, model: 'beta-lạ' }, null, baselines)
    expect(noBase!.components.efficiency).toBeNull()
    expect(noBase!.reward).toBe(1)
  })

  test('G6 logCompositeRewardForRun LOG-ONLY — KHÔNG ghi bảng nào, KHÔNG tạo QEntry (W2 giữ nhị phân)', async () => {
    const before = {
      runs: await db.agentRunRecord.count(),
      q: await db.qEntry.count(),
      verdicts: await db.arbiterVerdict.count(),
      brain: await db.brainModel.count(),
    }
    const result = await logCompositeRewardForRun({
      model: 'alpha',
      agentName: 'OMEGA',
      complete: true,
      tokensUsed: 800,
      confirmed: 1,
      refuted: 0,
    })
    expect(result).not.toBeNull() // có baseline alpha (median từ ledger seed)
    expect(result!.components.quality).toBeNull() // agent-run không có nguồn faithfulness
    const after = {
      runs: await db.agentRunRecord.count(),
      q: await db.qEntry.count(),
      verdicts: await db.arbiterVerdict.count(),
      brain: await db.brainModel.count(),
    }
    expect(after).toEqual(before)
    // updateQ giữ nguyên nhị phân ±1 — pin công thức q-learning không đổi
    expect(qLearningUpdate(0, 1, 0)).toBeCloseTo(0.1, 12) // 0 + 0.1·(1+0−0)
    expect(qLearningUpdate(0, -1, 0)).toBeCloseTo(-0.1, 12)
    expect(qLearningUpdate(0, 0, 0)).toBe(0)
  })

  test('G7 spearmanRank: perfect → 1; đảo → −1; tie average-rank → 1.5/√3 ≈ 0.866 (DERIVABLE TAY)', () => {
    expect(spearmanRank([1, 2, 3], [10, 20, 30])).toBeCloseTo(1, 12)
    expect(spearmanRank([1, 2, 3], [30, 20, 10])).toBeCloseTo(-1, 12)
    // ranks a = [1.5, 1.5, 3], b = [1, 2, 3] → ρ = 1.5/√(1.5·2) = 1.5/√3
    expect(spearmanRank([1, 1, 2], [1, 2, 3])).toBeCloseTo(1.5 / Math.sqrt(3), 12)
    expect(spearmanRank([1], [2])).toBe(Number.NaN) // n < 2
    expect(spearmanRank([1, 1], [1, 1])).toBe(Number.NaN) // rank hằng
  })

  test('G8 sweepRewardWeights: < 6 mẫu → infeasible + equal weights; 2-model signal → feasible + tất định', () => {
    // a) Ít mẫu
    const few = sweepRewardWeights([
      { model: 'alpha', outcome: 1, efficiency: 0, quality: null },
      { model: 'beta', outcome: 0, efficiency: 0, quality: null },
    ])
    expect(few.feasible).toBe(false)
    expect(few.weights.outcome).toBeCloseTo(1 / 3, 12)
    expect(few.reason).toContain('< 6')
    // b) 1 model duy nhất → infeasible
    const one = sweepRewardWeights(
      Array.from({ length: 10 }, () => ({ model: 'alpha', outcome: 1, efficiency: 0, quality: null })),
    )
    expect(one.feasible).toBe(false)
    // c) 2 model tín hiệu rõ (alpha thắng 0.9, beta 0.2, ổn định qua 2 nửa)
    const samples = [] as Array<{ model: string; outcome: number; efficiency: number | null; quality: null }>
    const rand = lcg(777)
    for (let i = 0; i < 20; i++) {
      samples.push({ model: 'alpha', outcome: rand() < 0.9 ? 1 : 0, efficiency: 0, quality: null })
      samples.push({ model: 'beta', outcome: rand() < 0.2 ? 1 : 0, efficiency: 0, quality: null })
    }
    const sweep = sweepRewardWeights(samples)
    expect(sweep.feasible).toBe(true)
    expect(sweep.nModels).toBe(2)
    expect(sweep.correlation).toBeGreaterThan(0.5)
    const total = sweep.weights.outcome + sweep.weights.efficiency + sweep.weights.quality
    expect(total).toBeCloseTo(1, 12)
    // Tất định — 2 lần deep-equal
    expect(sweepRewardWeights(samples)).toEqual(sweep)
  })

  test('G9 collectTokenBaselines: median đúng theo model; model 1 row → median chính nó', async () => {
    const rows = [
      { model: 'alpha', tokensUsed: 1000 },
      { model: 'alpha', tokensUsed: 2000 },
      { model: 'alpha', tokensUsed: 3000 },
      { model: 'beta', tokensUsed: 500 },
    ]
    const baselines = await collectTokenBaselines(rows as never)
    expect(baselines.get('alpha')).toBe(2000) // median [1000,2000,3000]
    expect(baselines.get('beta')).toBe(500)
    expect(baselines.has('gamma')).toBe(false)
  })
})

// ==================== H. Cờ + kill-switch organs ====================

describe('r87 · H cờ P4 + kill-switch — TUNING_SPECS/NEURAL_NODES/route/registry', () => {
  test('H1 TUNING_SPECS 29 mục; 4 cờ P4 pin đủ trường', () => {
    // PIN UPDATE (r88-r91 task, Task 11 worklog): 19 → 25 — BRAIN-UX §9
    // (UX-1/2) thêm 6 key: ui_brain_edit/ui_synapse_fx/ui_hitech (cờ trình
    // bày) + reward_w_outcome/efficiency/quality (UX-2 nhóm C — blueprinted
    // §9.3, neural-types.ts 'BRAIN-UX §9' block).
    // PIN UPDATE (Task 23 OBS-P1 2026-10-13): 25 → 29 — thêm 4 cờ quan sát
    // V2 (obs_ledger/obs_brain_trace/obs_impact/ui_observation).
    expect(TUNING_SPECS).toHaveLength(29)
    const keys = TUNING_SPECS.map(s => s.key)
    for (const k of P4_FLAG_KEYS) expect(keys).toContain(k)
    for (const key of P4_FLAG_KEYS) {
      const spec = TUNING_SPECS.find(s => s.key === key)!
      expect(spec.type).toBe('enum')
      expect(spec.enumValues).toEqual(['off', 'on'])
      expect(spec.default).toBe('off')
      expect(spec.nodeId).toBe('softmax-policy')
    }
    const envByFlag: Record<string, string> = {
      runtime_policy: 'RUNTIME_POLICY',
      policy_organ_routing: 'POLICY_ORGAN_ROUTING',
      policy_organ_adaptation: 'POLICY_ORGAN_ADAPTATION',
      policy_organ_tuning: 'POLICY_ORGAN_TUNING',
    }
    for (const [flag, env] of Object.entries(envByFlag)) {
      expect(TUNING_SPECS.find(s => s.key === flag)!.envKey).toBe(env)
    }
  })

  test('H2 NEURAL_NODES softmax-policy paramKeys đủ 13 tham số', () => {
    const node = NEURAL_NODES.find(n => n.id === 'softmax-policy')
    expect(node).not.toBeNull()
    // PIN UPDATE (r88-r91 task, Task 11 worklog): 7 → 13 — BRAIN-UX §9 thêm
    // 6 key TUNING_SPECS đều gắn node softmax-policy (3 cờ UI + 3 trọng số
    // reward_w_*). Đếm thật tại neural-types.ts paramKeys node softmax-policy
    // (worklog Task 9 ghi "14" — đếm lại là 13, pin theo số đo).
    expect(node!.paramKeys).toEqual([
      'runtime_model_policy',
      'runtime_model_tau',
      'replay_eval',
      'runtime_policy',
      'policy_organ_routing',
      'policy_organ_adaptation',
      'policy_organ_tuning',
      'reward_w_outcome',
      'reward_w_efficiency',
      'reward_w_quality',
      'ui_brain_edit',
      'ui_synapse_fx',
      'ui_hitech',
    ])
  })

  test('H3 chuỗi hiệu lực: ENV on thắng default; STORE thắng ENV; reset về default', async () => {
    delete process.env.RUNTIME_POLICY
    await refreshTuningSnapshot()
    expect(getTuningEnum('runtime_policy')).toBe('off') // default
    process.env.RUNTIME_POLICY = 'on'
    await refreshTuningSnapshot()
    expect(getTuningEnum('runtime_policy')).toBe('on') // ENV thắng default
    await setTuningValue('runtime_policy', 'off')
    await refreshTuningSnapshot()
    expect(getTuningEnum('runtime_policy')).toBe('off') // STORE thắng ENV
    await resetTuningValue('runtime_policy')
    await refreshTuningSnapshot()
    expect(getTuningEnum('runtime_policy')).toBe('on') // ENV lại hiệu lực
    delete process.env.RUNTIME_POLICY
    await refreshTuningSnapshot()
    expect(getTuningEnum('runtime_policy')).toBe('off')
  })

  test('H4 BRAIN_TRAINABLE_KEYS đủ 3 + GET /api/brain → policy trainable', async () => {
    expect(BRAIN_TRAINABLE_KEYS).toEqual(['calibration_v3', 'surrogate', 'policy'])
    expect(BRAIN_TRAINING_IMPLEMENTED).toBe(true)
    const res = await brainRouteGET()
    expect(res.status).toBe(200)
    const body = await res.json() as { brains: Array<{ key: string; trainable: boolean; lifecycle: string }> }
    const policy = body.brains.find(b => b.key === 'policy')
    expect(policy).not.toBeNull()
    expect(policy!.trainable).toBe(true)
    // Có bản active từ nhóm E → lifecycle 'active'
    expect(policy!.lifecycle).toBe('active')
  })

  test('H5 kill-switch organ routing: flags off → maybeMixModelProbs null (hành vi y hệt P3)', async () => {
    for (const k of P4_FLAG_KEYS) await resetTuningValue(k).catch(() => {})
    await refreshTuningSnapshot()
    expect(isRuntimePolicyEnabled()).toBe(false)
    expect(isPolicyOrganEnabled('routing')).toBe(false)
    // Master off
    expect(await maybeMixModelProbs([0.5, 0.5], ['alpha', 'beta'], { agent: 'OMEGA', delegated: false })).toBeNull()
    // Master on nhưng organ off → vẫn null (kill-switch độc lập)
    await setTuningValue('runtime_policy', 'on')
    await refreshTuningSnapshot()
    expect(isRuntimePolicyEnabled()).toBe(true)
    expect(await maybeMixModelProbs([0.5, 0.5], ['alpha', 'beta'], { agent: 'OMEGA', delegated: false })).toBeNull()
    // Master + organ on + active → mixture sống
    await setTuningValue('policy_organ_routing', 'on')
    await refreshTuningSnapshot()
    const mixed = await maybeMixModelProbs([0.5, 0.5], ['alpha', 'beta'], { agent: 'OMEGA', delegated: false })
    expect(mixed).not.toBeNull()
    expect(mixed!.probs.reduce((s, v) => s + v, 0)).toBeCloseTo(1, 9)
    await resetTuningValue('runtime_policy').catch(() => {})
    await resetTuningValue('policy_organ_routing').catch(() => {})
    await refreshTuningSnapshot()
  })

  test('H6 kill-switch organ adaptation: off → buildPolicyAdvisoryBlock rỗng; on + master → có block', async () => {
    for (const k of P4_FLAG_KEYS) await resetTuningValue(k).catch(() => {})
    await refreshTuningSnapshot()
    expect(await buildPolicyAdvisoryBlock({ agent: 'OMEGA', delegated: false })).toBe('')
    await setTuningValue('runtime_policy', 'on')
    await setTuningValue('policy_organ_adaptation', 'on')
    await refreshTuningSnapshot()
    const block = await buildPolicyAdvisoryBlock({ agent: 'OMEGA', delegated: false })
    expect(block).toContain('ĐỀ XUẤT BRAIN-C')
    expect(block).toContain('π =')
    await resetTuningValue('runtime_policy').catch(() => {})
    await resetTuningValue('policy_organ_adaptation').catch(() => {})
    await refreshTuningSnapshot()
  })

  test('H7 kill-switch organ tuning: off → buildTuningProposals [] (dù master on + active)', async () => {
    for (const k of P4_FLAG_KEYS) await resetTuningValue(k).catch(() => {})
    await refreshTuningSnapshot()
    expect(await buildTuningProposals()).toEqual([])
    await setTuningValue('runtime_policy', 'on')
    await refreshTuningSnapshot()
    expect(await buildTuningProposals()).toEqual([]) // organ off thắng master
    await resetTuningValue('runtime_policy').catch(() => {})
    await refreshTuningSnapshot()
  })
})
