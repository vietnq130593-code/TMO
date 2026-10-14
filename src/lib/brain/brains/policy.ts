/**
 * BRAIN-P4 · BRAIN-C "Lệnh" — POLICY HEAD + COMPOSITE REWARD + STEERING
 * (blueprint §4.4 — Q1 user chốt 2026-10-12, blueprint v0.9)
 * ============================================================================
 *
 * Não thứ ba của panel "Não vận hành": π(a | đặc trưng nhiệm vụ) — chọn
 * model theo đặc trưng nhiệm vụ qua MIXTURE AN TOÀN (công thức tường minh
 * audit C2):
 *
 *   π(a) = λ·π_Q(a) + (1−λ)·π_net(a)
 *     π_Q  = softmax(Q/τ) hiện có (q-table.ts — W1/W2 học nhị phân ±1,
 *            updateQ KHÔNG đổi)
 *     λ    = 1 − min( clamp(n/K, 0, 1), wilsonLB(p̂, n) )
 *            — n = số mẫu train bản active, K = POLICY_LAMBDA_K (200),
 *              p̂ = success rate (mean Outcome*) tập train
 *            — phần π_net (1−λ) bị chặn TRÊN bởi CẢ ramp số mẫu lẫn Wilson
 *              95% LOWER BOUND của success rate ("chặn dưới Wilson CI"
 *              §4.4 — hiểu là SÀN của λ = 1 − wilsonLB): thiếu dữ liệu →
 *              ramp≈0 và wilsonLB≈0 → λ→1 = nghe Q nguyên vẹn (fail-open);
 *              dữ liệu lớn + kết quả tốt → λ giảm dần.
 *            — HIỆU ĐỈNH blueprint v0.9: công thức literal §4.4
 *              "λ = clamp(n/K, 0, 1)" mâu thuẫn nội tại (clamp TĂNG theo n
 *              trong khi §4.4 đòi λ GIẢM + thiếu dữ liệu λ→1) — triển khai
 *              theo 2 Ý ĐỊNH TƯỜNG MINH "giảm dần khi dữ liệu lớn lên" +
 *              "thiếu dữ liệu → λ→1", ghi nhận thẳng ở nhật ký 0.8→0.9.
 *
 * KIẾN TRÚC (inputMode 'task-features' — phase này; mode vector pca-128/
 * mrl-512 chờ quyết định mở Q2 blueprint §3.2, từ chối rõ ràng):
 *   MLP D→32(tanh)→|A|(softmax) + crossEntropy (cặp gộp sẵn có của nền
 *   toán P1: δ = p − y — KHÔNG đụng mlp.ts đã fixbug). D = agent one-hot +
 *   delegated (MỌI đặc trưng có TRƯỚC run — action=model là ĐẦU RA, không
 *   bao giờ làm input); |A| = vocab model (action space).
 *
 * MỤC TIÊU TRAIN — reward-weighted imitation qua REPLICATION (quyết định
 * triển khai ghi nhận thẳng, blueprint v0.9 nhật ký 0.8→0.9): mỗi mẫu được
 * nhân bản round((R+1)/2 × SCALE) bản (R = composite reward §3.1 ∈ [−1,1])
 * — xấp xỉ rời rạc (độ hạt 1/(2·SCALE)) của weighted-CE Σᵢ wᵢ·(−log π(aᵢ|xᵢ))
 * vì mlp.ts không hỗ trợ sample-weight. R=−1 → 0 bản = không bắt chước.
 * KHÔNG claim "học tránh hành động xấu" — mẫu xấu chỉ bị giảm/loại khỏi
 * bắt chước, không có gradient âm (đúng honesty doctrine).
 *
 * CỔNG ACTIVE (kép — ngặt):
 *   (1) 5-fold CV stratified theo Outcome* so π_Q ĐỐI CHỨNG: CE hold-out
 *       của mixture < CE π_Q (ngặt — bằng nhau không tính);
 *   (2) đủ 3 ngưỡng thức tỉnh §2: usable AgentRunRecord ≥ 30 · QEntry
 *       ≥ 30 · ArbiterVerdict ≥ 50.
 *
 * STEERING — 3 cơ quan, TỪNG CÁI MỘT, mỗi cái kill-switch độc lập (cờ
 * tuning-store, mặc định off; master `runtime_policy` + organ
 * `policy_organ_routing`/`policy_organ_adaptation`/`policy_organ_tuning`):
 *   (1) model routing — maybeMixModelProbs() đổi softmax probs thành
 *       mixture trong maybeApplySoftmaxModelPolicy (llm.ts) khi 3 lớp
 *       fail-open đều qua (master + organ + active); seed-pick giữ nguyên;
 *   (2) adaptation directives — buildPolicyAdvisoryBlock() advisory TEXT
 *       vào systemBlocks (workflow-engine) — KHÔNG đổi quyết định;
 *   (3) tuning-store — buildTuningProposals() ĐỀ XUẤT read-only qua report
 *       GET /api/brain/policy; người duyệt vẫn là user qua UI (change-log
 *       audit P2 chỉ ghi khi user áp dụng — brain không tự ghi).
 *
 * COMPOSITE REWARD — LOG-ONLY (Q1 chốt): reward tham gia QUA training của
 * brain ngủ + report; KHÔNG tham gia updateQ (W1/W2 nhị phân ±1 giữ nguyên)
 * và KHÔNG tác động quyết định nào cho tới khi user bật cờ sau ≥ 2 đợt quan
 * sát (đợt 1 = v0.9). Chi tiết reward: src/lib/brain/reward.ts.
 *
 * Ghi DB: bảng BrainModel (brain='policy' — không migration mới):
 *   - specJson  : PolicySpecDoc { inputMode, vocab{agents}, actionVocab
 *                 {models}, spec: MlpSpec, featureNames }
 *   - weightsJson: { mlp: MlpSerialized } (envelope numpy-đọc-được A6)
 *   - trainMetaJson: nSamples, successRate, lambda, CV CE mixture vs π_Q,
 *                 standardization (stds FULL precision — bài học
 *                 FB-BRAIN-P2-R1-01), reward weights + replicateScale,
 *                 qScores snapshot + tau, dataLineage §5.3
 *
 * Bất biến giữ nguyên từ P2/P3: A1 (1 active — updateMany tắt cũ trước khi
 * ghi active mới) · A2 prune (active + 5 mới nhất) · A7 single-flight lock
 * (train-lock.ts) · tất định theo seed (r87 pin) · orderBy createdAt asc
 * TIE-BREAK id asc (bài học flaky FB-BRAIN-P2-R2-02).
 */

import { createHash } from 'node:crypto'
import { db } from '@/lib/db'
import { MLP, type MlpSerialized, type MlpSpec, type FitResult, type FitOptions, type EpochStat } from '../mlp'
import { acquireTrainLock, releaseTrainLock } from '../train-lock'
// OBS-P1 hook (§C.3 đợt 1) — brain.train start/end (static — không chu trình)
import { observeBrainTrain } from '@/lib/observation/ledger'
// Task 26-BE — train-progress bus (đài quan sát v2; train-progress chỉ import
// type từ ../registry — không chu trình)
import { trainProgressStart, trainProgressEnd } from '../train-progress'
import type { BrainDraftSpec } from '../spec-schema'
import { BRAIN_VERSIONS_KEEP } from '../registry'
// OBS-P2 hook (§C.3 đợt 2) — vết suy diễn organ policy_mixture (không chu trình)
import { traceInference } from '@/lib/observation/trace'
import { computeColumnStats, stratifiedFoldAssignments } from '@/lib/calibration-multifeature'
import { meanCI, wilsonCI } from '@/lib/stats'
import { getTuningEnum, getTuningNumber } from '@/lib/learning/tuning-store'
import { softmaxPolicy } from '@/lib/learning/q-table'
import {
  REWARD_WEIGHTS,
  collectRewardLedger,
  computeRunReward,
  outcomeFromEvidence,
  resolveRewardWeightsFromTuning,
  type VerdictTally,
} from '../reward'

// ==================== CONFIG ====================

/**
 * Số mẫu AgentRunRecord usable tối thiểu để train Brain-C — blueprint §2
 * "policy head chỉ thức tỉnh khi Q có ≥ 30 entry" (mẫu = run có nhãn kết
 * cục; song song 2 ngưỡng nguồn khác bên dưới).
 */
export const POLICY_MIN_TRAIN_SAMPLES = 30

/** Số mẫu để runtime TIN mixture (2/3 ngưỡng train — cùng tỉ lệ P2/P3). */
export const POLICY_MIN_RUNTIME_SAMPLES = 20

/** Ngưỡng QEntry (toàn bảng) — blueprint §2 "policy head cần Q ≥ 30 entry". */
export const POLICY_MIN_Q_ENTRIES = 30

/** Ngưỡng ArbiterVerdict (toàn bảng) — blueprint §2 "reward composite cần ≥ 50 verdict". */
export const POLICY_MIN_VERDICTS = 50

/** Mode đầu vào duy nhất của phase này (mode vector chờ Q2 — xem header). */
export const POLICY_INPUT_MODE = 'task-features'

/** Kiểm tra inputMode hợp lệ của Brain-C (mode lạ → lỗi rõ ràng, không im lặng). */
export function isSupportedPolicyInputMode(mode: string): boolean {
  return mode === POLICY_INPUT_MODE
}

/** Seed tất định Brain-C — cùng dữ liệu → cùng weights bit-đối-bit (r87). */
export const POLICY_SEED = 42

/** Số fold CV — trùng CV_FOLDS V2/V3/B (5-fold stratified theo Outcome*). */
const POLICY_FOLDS = 5

/**
 * K của λ ramp — λ_n = clamp(n/K, 0, 1): tại 200 mẫu train, π_net được hết
 * phần ramp của mình (phần Wilson vẫn chặn thêm — xem policyLambda).
 */
export const POLICY_LAMBDA_K = 200

/**
 * Hệ số replication cho reward-weighted imitation — mỗi mẫu nhân bản
 * round((R+1)/2 × 8) bản ∈ {0..8} (độ hạt 1/16 trên (R+1)/2 ∈ [0,1]).
 */
export const POLICY_REPLICATE_SCALE = 8

const POLICY_LR = 0.01
const POLICY_L2 = 0.01
const POLICY_EPOCHS = 500
const POLICY_PATIENCE = 50
const POLICY_BATCH = 32

// ==================== VOCAB + FEATURE (thuần — test trực tiếp được) ====================

/** Vocab đặc trưng nhiệm vụ (học từ dữ liệu train — lưu trong specJson). */
export interface PolicyVocab {
  agents: string[]
}

/** Vocab hành động — action space = model đã chạy trong dữ liệu train. */
export interface PolicyActionVocab {
  models: string[]
}

/** Bối cảnh nhiệm vụ — MỌI trường có sẵn TRƯỚC khi run bắt đầu (chống rò nhãn). */
export interface PolicyFeatureCtx {
  /** tên agent (Omega / FORGE / …) — proxy "lớp nhiệm vụ" */
  agent: string | null
  /** true khi là delegation (parentRunId ≠ null) — biết ngay lúc spawn */
  delegated: boolean
}

/** Danh sách tên đặc trưng (thứ tự CHÍNH XÁC bằng buildPolicyFeatureRow). */
export function policyFeatureNames(vocab: PolicyVocab): string[] {
  return [...vocab.agents.map(a => `agent:${a}`), 'delegated']
}

/** Dựng vocab đặc trưng từ danh sách ctx (sorted unique — tất định). */
export function buildPolicyVocab(ctxs: readonly PolicyFeatureCtx[]): PolicyVocab {
  return {
    agents: [...new Set(ctxs.map(c => c.agent).filter((a): a is string => typeof a === 'string'))].sort(),
  }
}

/** Dựng vocab hành động từ danh sách model (sorted unique không rỗng — tất định). */
export function buildPolicyActionVocab(models: readonly string[]): PolicyActionVocab {
  return { models: [...new Set(models.filter(m => typeof m === 'string' && m !== ''))].sort() }
}

/**
 * Dựng 1 hàng đặc trưng: agent one-hot + delegated. Agent không có trong
 * vocab (lạ) → khối one-hot toàn 0 — giá trị 0 là NUMBER nên chuẩn hóa thành
 * (0−mean)/std, KHÔNG phải "impute về mean" (nhánh về-mean chỉ cho null —
 * FB-BRAIN-P3-R1-10 cùng hiệu đính như surrogate.ts). Hợp đồng rõ, không throw.
 * Thuần — không đụng DB.
 */
export function buildPolicyFeatureRow(
  ctx: PolicyFeatureCtx,
  vocab: PolicyVocab,
): (number | null)[] {
  const row: (number | null)[] = []
  for (const a of vocab.agents) row.push(ctx.agent === a ? 1 : 0)
  row.push(ctx.delegated ? 1 : 0)
  return row
}

// ==================== SPEC + REPLICATION (thuần) ====================

/**
 * Xây MlpSpec của Brain-C: D→32(tanh)→|A|(softmax) + crossEntropy —
 * kiến trúc layer ẩn 32 giữ nguyên booked planned registry (lớp input D
 * động theo vocab phase này, đúng tiền lệ surrogate). Thuần, xuất cho test
 * pin kiến trúc (r87-A).
 * BRAIN-UX §9.2 — override (tùy chọn từ BrainSpecDraft): thay LỚP ẨN +
 * optimizer/lr/l2/seed; input D động + output ×|A| softmax + CE KHÓA (hợp
 * đồng pipeline §9.1-2). Không truyền = ĐÚNG spec gốc.
 */
export function buildPolicySpec(
  featureDim: number,
  actionCount: number,
  override?: BrainDraftSpec,
): MlpSpec {
  if (!Number.isInteger(featureDim) || featureDim < 1) {
    throw new Error(`buildPolicySpec: featureDim phải là số nguyên ≥ 1 (nhận ${featureDim})`)
  }
  if (!Number.isInteger(actionCount) || actionCount < 2) {
    throw new Error(`buildPolicySpec: actionCount phải là số nguyên ≥ 2 (nhận ${actionCount}) — policy 1 hành động vô nghĩa`)
  }
  const base = buildPolicySpecDefault(featureDim, actionCount)
  if (!override) return base
  return {
    ...base,
    layers: [
      base.layers[0], // input khóa D động (vocab nhiệm vụ)
      // BRAIN-TAB-3PHAN (18-d): truyền α/β + δ Huber từ draft — engine hỗ trợ
      // sẵn từ BRAIN-P1 (activations.ts/losses.ts), giờ mới lộ UI. Conditional
      // spread để KHÔNG tạo key undefined (pin r87-A/r88: layers[1] toEqual
      // {units, activation} khi draft mặc định không có params). Loss
      // crossEntropy → không lossParams.
      ...override.hidden.map(h => ({ units: h.units, activation: h.activation, ...(h.activationParams ? { activationParams: h.activationParams } : {}) })),
      base.layers[base.layers.length - 1], // output khóa ×|A| softmax + CE
    ],
    optimizer: override.hyper.optimizer,
    lr: override.hyper.lr,
    l2: override.hyper.l2,
    seed: override.hyper.seed,
  }
}

function buildPolicySpecDefault(featureDim: number, actionCount: number): MlpSpec {
  return {
    // Lớp input: activation bị bỏ qua ở forward (hợp đồng dữ liệu) nhưng
    // validateSpec yêu cầu tên hợp lệ → 'linear' (tiền lệ V3/r84).
    layers: [
      { units: featureDim, activation: 'linear' },
      { units: 32, activation: 'tanh' },
      { units: actionCount, activation: 'softmax' },
    ],
    loss: 'crossEntropy',
    optimizer: 'adam',
    lr: POLICY_LR,
    l2: POLICY_L2,
    seed: POLICY_SEED,
  }
}

/**
 * BRAIN-UX §9.3 nhóm A — FitOptions từ draft hoặc hằng số gốc (đúng pattern
 * calibration-v3.draftFitOptions; policy đơn head — không lossScale).
 */
function policyDraftFitOpts(override: BrainDraftSpec | undefined): FitOptions {
  if (!override) return { epochs: POLICY_EPOCHS, batchSize: POLICY_BATCH, patience: POLICY_PATIENCE }
  return {
    epochs: override.hyper.epochs,
    batchSize: override.hyper.batch,
    patience: override.hyper.patience,
    holdOutRatio: override.hyper.holdout,
    clipNorm: override.hyper.clip,
  }
}

/**
 * Số bản nhân của 1 mẫu theo reward — thuần: round((R+1)/2 × scale) kẹp
 * [0, scale]. R hữu hạn ngoài [−1,1] kẹp về biên; R NaN/±∞ → 0 bản (mẫu
 * vô nghĩa không được vào imitation — hợp đồng tử tế với caller truyền thô;
 * FB-BRAIN-P4-R1-12: ±∞ là "hữu hạn-sai" chứ không "ngoài biên" — về 0 bản).
 */
export function replicateCount(reward: number, scale: number = POLICY_REPLICATE_SCALE): number {
  if (!Number.isFinite(scale) || scale < 1 || !Number.isInteger(scale)) {
    throw new Error(`replicateCount: scale phải là số nguyên ≥ 1 (nhận ${scale})`)
  }
  if (!Number.isFinite(reward)) return 0
  const r = Math.min(1, Math.max(-1, reward))
  return Math.max(0, Math.min(scale, Math.round(((r + 1) / 2) * scale)))
}

// ==================== λ MIXTURE (thuần — công thức tường minh audit C2) ====================

/**
 * λ của mixture π = λ·π_Q + (1−λ)·π_net — THUẦN, công thức tường minh:
 *
 *   λ = 1 − min( clamp(n/K, 0, 1), wilsonLB(p̂, n) )
 *
 *   net ramp  = clamp(n/K, 0, 1)   — phần π_net lớn dần theo số mẫu
 *                (K = POLICY_LAMBDA_K; §4.4 "giảm dần khi dữ liệu lớn lên"
 *                — áp cho λ = 1 − ramp)
 *   wilsonLB  = Wilson 95% lower bound của success rate đã quan sát —
 *               phần π_net KHÔNG được vượt bằng chứng thống kê ("chặn dưới
 *               Wilson CI" §4.4 = sàn của λ: λ ≥ 1 − wilsonLB)
 *   Lấy MIN (kỷ luật bảo thủ): ràng buộc NGẶT hơn thắng — dữ liệu ít →
 *   cả hai ≈ 0 → λ = 1 (nghe Q nguyên vẹn); kết quả tốt + n lớn → λ giảm.
 *   n ≤ 0 / p̂ vô hiệu / wilsonLB NaN → λ = 1 (fail-open tuyệt đối).
 */
export function policyLambda(
  nSamples: number,
  successRate: number,
  K: number = POLICY_LAMBDA_K,
): number {
  if (!Number.isFinite(nSamples) || nSamples <= 0 || !Number.isFinite(successRate)) return 1
  const k = Number.isFinite(K) && K > 0 ? K : POLICY_LAMBDA_K
  const netRamp = Math.min(1, Math.max(0, nSamples / k))
  const p = Math.min(1, Math.max(0, successRate))
  const ci = wilsonCI(p, Math.floor(nSamples))
  const wilsonLb = Number.isFinite(ci.low) && ci.low > 0 ? ci.low : 0
  const netShare = Math.min(netRamp, wilsonLb)
  return Math.min(1, Math.max(0, 1 - netShare))
}

// ==================== 5-FOLD CV — MIXTURE vs π_Q ĐỐI CHỨNG ====================

export interface PolicyCvOutcome {
  /** CE hold-out trung bình của MIXTURE qua các fold. */
  cvCeMixture: number
  cvCeMixtureCiLo: number
  cvCeMixtureCiHi: number
  /** CE hold-out của π_Q đối chứng (softmax(Q/τ) — không train). */
  ceBaseline: number
  /** cvCeMixture < ceBaseline (NGẶT — bằng nhau không tính). */
  improved: boolean
  folds: number
  foldCes: number[]
  foldCesQ: number[]
  /** λ từng fold (tính trên tập train-fold — chống rò hold-out). */
  foldLambdas: number[]
}

/**
 * 5-fold CV so mixture với π_Q đối chứng (thuần, không DB).
 *
 * Hợp đồng ném lỗi (kế thừa FB-BRAIN-P2-R1-03): 4 mảng X/actions/rewards/
 * outcomeLabels phải CÙNG chiều dài — lệch là lỗi lập trình caller → throw.
 * Trả null khi: folds không nguyên ≥ 2 (FB-BRAIN-P2-R1-04) hoặc không gán
 * fold stratified được (một lớp Outcome* < folds mẫu — caller abort, không
 * fallback) hoặc qScores sai chiều action vocab.
 *
 * Mỗi fold: input stats tính CHỈ trên 4 fold train (chống rò hold-out) →
 * nhân bản mẫu theo reward (replicateCount) → fit π_net → λ tính từ tập
 * train-fold → CE mixture vs CE π_Q trên hold-out (ε = 1e−7 kẹp log).
 */
export function crossValidatePolicy(
  X: (number | null)[][],
  actions: number[],
  rewards: number[],
  outcomeLabels: number[],
  qScores: number[],
  vocab: PolicyVocab,
  actionCount: number,
  opts: { folds?: number; tau?: number; override?: BrainDraftSpec } = {},
): PolicyCvOutcome | null {
  const n = X.length
  if (actions.length !== n || rewards.length !== n || outcomeLabels.length !== n) {
    throw new Error(
      `crossValidatePolicy: X.length (${n}) phải bằng actions (${actions.length}) / rewards (${rewards.length}) / outcomeLabels (${outcomeLabels.length}) — lỗi lập trình caller`,
    )
  }
  if (qScores.length !== actionCount) {
    throw new Error(
      `crossValidatePolicy: qScores (${qScores.length}) phải đúng ${actionCount} chiều action vocab — lỗi lập trình caller`,
    )
  }
  const folds = opts.folds ?? POLICY_FOLDS
  if (!Number.isInteger(folds) || folds < 2) return null
  const assign = stratifiedFoldAssignments(outcomeLabels, folds)
  if (!assign) return null

  const tau = Number.isFinite(opts.tau ?? Number.NaN) ? (opts.tau as number) : getTuningNumber('runtime_model_tau')
  const qProbs = softmaxPolicy(qScores, tau)
  if (qProbs.length !== actionCount || qProbs.reduce((s, v) => s + v, 0) <= 0) return null

  const d = policyFeatureNames(vocab).length
  const spec = buildPolicySpec(d, actionCount, opts.override)
  const fitOpts = policyDraftFitOpts(opts.override)

  const foldCes: number[] = []
  const foldCesQ: number[] = []
  const foldLambdas: number[] = []
  const EPS = 1e-7

  for (let f = 0; f < folds; f++) {
    const trainIdx: number[] = []
    const holdIdx: number[] = []
    for (let i = 0; i < n; i++) (assign[i] === f ? holdIdx : trainIdx).push(i)
    if (trainIdx.length === 0 || holdIdx.length === 0) return null

    // ── Stats TẬP TRAIN fold (chống rò rỉ hold-out) ──
    const { means, stds } = computeColumnStats(trainIdx.map(i => X[i]))
    const stdRow = (row: (number | null)[]) =>
      row.map((v, j) => (typeof v === 'number' && Number.isFinite(v) ? (v - means[j]) / stds[j] : 0))
    const trainStd = trainIdx.map(i => stdRow(X[i]))
    const holdStd = holdIdx.map(i => stdRow(X[i]))

    // ── Reward-weighted imitation: nhân bản mẫu train theo reward ──
    // (bản đồ gốc→hàng-chuẩn-hóa tách rõ để không nhầm index — mỗi mẫu nhân
    // round((R+1)/2 × SCALE) bản, target = one-hot action)
    const trainStdByOrig = new Map<number, number[]>()
    trainIdx.forEach((orig, k) => trainStdByOrig.set(orig, trainStd[k]))
    const repX: number[][] = []
    const repY: number[][] = []
    for (const i of trainIdx) {
      const a = actions[i]
      if (!Number.isInteger(a) || a < 0 || a >= actionCount) {
        throw new Error(`crossValidatePolicy: actions[${i}]=${a} ngoài action vocab [0,${actionCount}) — lỗi lập trình caller`)
      }
      const copies = replicateCount(rewards[i])
      const y = new Array<number>(actionCount).fill(0)
      y[a] = 1
      const row = trainStdByOrig.get(i) as number[]
      for (let c = 0; c < copies; c++) {
        repX.push(row)
        repY.push(y)
      }
    }

    // ── Fit π_net trên tập nhân bản ──
    const mlp = new MLP(spec)
    mlp.fit(repX, repY, fitOpts)

    // ── λ từ tập TRAIN fold (n + p̂ train-fold — không nhìn hold-out) ──
    const pTrain = trainIdx.reduce((s, i) => s + outcomeLabels[i], 0) / trainIdx.length
    const lambda = policyLambda(trainIdx.length, pTrain)
    foldLambdas.push(lambda)

    // ── CE hold-out: mixture vs π_Q ──
    let ceMix = 0
    let ceQ = 0
    for (let k = 0; k < holdIdx.length; k++) {
      const a = actions[holdIdx[k]]
      const net = mlp.predict(holdStd[k])
      let mix = lambda * qProbs[a] + (1 - lambda) * net[a]
      mix = Math.min(1 - EPS, Math.max(EPS, mix))
      ceMix += -Math.log(mix)
      const qp = Math.min(1 - EPS, Math.max(EPS, qProbs[a]))
      ceQ += -Math.log(qp)
    }
    foldCes.push(ceMix / holdIdx.length)
    foldCesQ.push(ceQ / holdIdx.length)
  }

  const avg = (xs: number[]) => xs.reduce((s, v) => s + v, 0) / xs.length
  const ci = meanCI(foldCes)
  return {
    cvCeMixture: avg(foldCes),
    cvCeMixtureCiLo: ci.low,
    cvCeMixtureCiHi: ci.high,
    ceBaseline: avg(foldCesQ),
    improved: avg(foldCes) < avg(foldCesQ), // NGẶT — bằng nhau không tính
    folds,
    foldCes,
    foldCesQ,
    foldLambdas,
  }
}

// ==================== TRAIN (DB) ====================

export interface PolicyTrainResult {
  /** true khi đã ghi BrainModel (kể cả bản thua CV — vết audit). */
  trained: boolean
  version: number | null
  /** CHỈ true khi thắng π_Q CV (ngặt) — bản ghi active. */
  active: boolean
  sampleSize: number
  improved: boolean
  /** CV chi tiết — null khi không train. */
  cv: PolicyCvOutcome | null
  usable: number
  total: number
  qEntries: number
  verdicts: number
  error?: string
  /** BRAIN-UX §9.3 — quỹ đạo epoch (hiển thị sau khi train xong). */
  history?: EpochStat[]
  /** BRAIN-UX §9.4 — |gradient| trung bình từng lớp. */
  gradAbsMean?: number[]
  /** BRAIN-UX — train từ bản nháp UX-2 (provenance). */
  draftUsed?: boolean
}

/** Làm tròn 5 chữ số lẻ cho JSON lưu DB (đủ đọc, gọn — cùng V3/B). */
function round5(v: number): number {
  return Math.round(v * 100000) / 100000
}

/** Chuẩn hóa 1 hàng theo stats tập train: null/không hữu hạn → 0 (= mean). */
function standardizeRow(row: (number | null)[], means: number[], stds: number[]): number[] {
  return row.map((v, j) =>
    typeof v === 'number' && Number.isFinite(v) ? (v - means[j]) / stds[j] : 0,
  )
}

/**
 * Đọc ledger (AgentRunRecord + ArbiterVerdict + baseline median) → 5-fold CV
 * mixture vs π_Q → fit π_net cuối trên toàn dữ liệu (nhân bản theo reward)
 * → ghi BrainModel brain='policy'. KHÔNG throw khi thiếu dữ liệu
 * (trained=false + error); lỗi DB thật sự → throw (caller bọc fail-open).
 * Single-flight A7: train trùng nhịp của cùng brain → trained=false.
 */
export async function trainBrainPolicy(
  inputMode: string = POLICY_INPUT_MODE,
  override?: BrainDraftSpec,
): Promise<PolicyTrainResult> {
  if (!acquireTrainLock('policy')) {
    return {
      trained: false, version: null, active: false, sampleSize: 0, improved: false,
      cv: null, usable: 0, total: 0, qEntries: 0, verdicts: 0,
      error: 'single-flight (A7): train khác của brain policy đang chạy — bỏ lệnh trùng',
    }
  }
  // OBS-P1 hook (§C.3 đợt 1 — brain.train start/end; bỏ lệnh trùng A7 không phát)
  observeBrainTrain('policy', 'start', { inputMode, useDraft: override != null })
  // Task 26-BE — train-progress bus (đài quan sát v2): start SAU lock (bỏ lệnh
  // trùng A7 — cùng tiền lệ observeBrainTrain), TRƯỚC mọi query của hàm
  // Locked; end ở mọi lối ra (done/failed). Additive — không đụng logic train.
  trainProgressStart('policy', null)
  const t0 = Date.now()
  try {
    const result = await trainBrainPolicyLocked(inputMode, override)
    observeBrainTrain('policy', 'end', {
      inputMode, useDraft: override != null, durationMs: Date.now() - t0, result,
    })
    // 26-BE: trained=false là "ngủ an toàn" (thiếu dữ liệu/lệch lớp) — done +
    // reason, KHÔNG phải failed; summary điền gì có sẵn (history/gradAbsMean
    // chỉ tồn tại khi trained — không chế tạo). finalLoss = trainLoss epoch
    // CUỐI của history (PolicyTrainResult không mang finalTrainLoss riêng).
    trainProgressEnd(
      'policy',
      true,
      {
        epochsRun: result.history?.length ?? null,
        finalLoss: result.history && result.history.length > 0
          ? result.history[result.history.length - 1].trainLoss
          : null,
        gradAbsMean: result.gradAbsMean ?? null,
      },
      result.trained ? null : result.error ?? 'ngủ an toàn (không đủ dữ liệu)',
    )
    return result
  } catch (err) {
    observeBrainTrain('policy', 'end', {
      inputMode, useDraft: override != null, durationMs: Date.now() - t0, error: err,
    })
    trainProgressEnd('policy', false) // throw → failed (bus fail-open)
    throw err
  } finally {
    releaseTrainLock('policy')
  }
}

async function trainBrainPolicyLocked(
  inputMode: string,
  override?: BrainDraftSpec,
): Promise<PolicyTrainResult> {
  // ── Đếm 2 nguồn ngưỡng §2 (telemetry trung thực — đếm TRƯỚC khi chặn) ──
  // R4-ĐIỀU TRA: Q signal = SUM(visits) (số lần updateQ) — không phải row
  // count (deadlock: không gian trạng thái nhỏ 1 state × ~3 model ≈ 3 row
  // mãi mãi < 30 — xem countQLearningSignal). Bối cảnh đủ kinh nghiệm học
  // 30 lần là thức tỉnh được đúng tinh thần blueprint §2.
  const [qEntryCount, verdictCount] = await Promise.all([
    import('@/lib/learning/q-table').then(m => m.countQLearningSignal()),
    db.arbiterVerdict.count(),
  ])

  const { rows, verdicts, baselines } = await collectRewardLedger()

  const notTrained = (error: string): PolicyTrainResult => ({
    trained: false, version: null, active: false, sampleSize: 0, improved: false,
    cv: null, usable: rows.length, total: rows.length, qEntries: qEntryCount,
    verdicts: verdictCount, error,
  })

  // Từ chối mode chưa hỗ trợ — kiểm SAU khi đếm để telemetry trung thực
  // (FB-BRAIN-P2-R1-08)
  if (!isSupportedPolicyInputMode(inputMode)) {
    return notTrained(
      `inputMode '${inputMode}' chưa hỗ trợ phase BRAIN-P4 (chỉ '${POLICY_INPUT_MODE}' — mode vector pca-128/mrl-512 chờ quyết định Q2 blueprint §3.2)`,
    )
  }

  if (qEntryCount < POLICY_MIN_Q_ENTRIES) {
    return notTrained(
      `insufficient Q data: only ${qEntryCount} QEntry rows (need ${POLICY_MIN_Q_ENTRIES}+ — blueprint §2 policy head) — ngủ an toàn`,
    )
  }
  if (verdictCount < POLICY_MIN_VERDICTS) {
    return notTrained(
      `insufficient verdict data: only ${verdictCount} ArbiterVerdict rows (need ${POLICY_MIN_VERDICTS}+ — blueprint §2 composite reward) — ngủ an toàn`,
    )
  }
  if (rows.length < POLICY_MIN_TRAIN_SAMPLES) {
    return notTrained(
      `insufficient data: only ${rows.length} usable AgentRunRecord rows (need ${POLICY_MIN_TRAIN_SAMPLES}+) — ngủ an toàn, chạy thêm agent run trước`,
    )
  }

  // ── Vocab + đặc trưng + nhãn + reward ──
  const ctxs: PolicyFeatureCtx[] = rows.map(r => ({ agent: r.agentName, delegated: r.delegated }))
  const vocab = buildPolicyVocab(ctxs)
  const actionVocab = buildPolicyActionVocab(rows.map(r => r.model))
  if (actionVocab.models.length < 2) {
    return notTrained(
      `action space quá nhỏ: ${actionVocab.models.length} model (cần ≥ 2 — policy 1 hành động vô nghĩa) — ngủ an toàn`,
    )
  }
  const actionIndex = new Map(actionVocab.models.map((m, i) => [m, i]))
  const X = ctxs.map(c => buildPolicyFeatureRow(c, vocab))
  const actions = rows.map(r => actionIndex.get(r.model) as number)
  // Nhãn Outcome* (verdict-aware — reward.ts outcomeFromEvidence): DÙNG
  // THỐNG NHẤT cho stratification CV + p̂ của λ + reward (FB-BRAIN-P4-R1-01:
  // bản trước stratify/p̂ theo complete thô trong khi reward theo Outcome*
  // → 2 nguồn nhãn lệch nhau trong 1 lần train khi có verdict refuted).
  const outcomeStars = rows.map(r => outcomeFromEvidence(r.complete === 1, verdicts.get(r.sessionId) ?? null))
  const outcomeLabels = outcomeStars
  const rewards = rows.map(r => {
    const tally: VerdictTally | undefined = verdicts.get(r.sessionId)
    const rr = computeRunReward(r, tally ?? null, baselines, resolveRewardWeightsFromTuning())
    // Mẫu không hợp được reward (vd thiếu baseline model) → R = 0 trung tính
    // (không bỏ mẫu — kết cục vẫn là nhãn stratification; imitation weight
    // = (0+1)/2 = nửa — trung tính đúng nghĩa)
    return rr ? rr.reward : 0
  })

  // ── π_Q đối chứng: Q thật từ bảng (stateKey agent-runtime, τ runtime) ──
  const { agentRuntimeStateKey, getQAdvice } = await import('@/lib/learning/q-table')
  const stateKey = agentRuntimeStateKey()
  const advice = await getQAdvice(stateKey, actionVocab.models)
  const qByAction = new Map(advice.map(a => [a.action, a.q]))
  const qScores = actionVocab.models.map(m => qByAction.get(m) ?? 0)
  const tau = getTuningNumber('runtime_model_tau')

  // ── CV TRƯỚC khi tin model (kỷ luật V2/V3/B) ──
  // BRAIN-UX §9.2 — CV đánh giá kiến trúc draft khi có override
  const cv = crossValidatePolicy(X, actions, rewards, outcomeLabels, qScores, vocab, actionVocab.models.length, override ? { tau, override } : { tau })
  if (!cv) {
    return notTrained(
      `class imbalance: cần ≥${POLICY_FOLDS} mẫu MỖI lớp Outcome* cho ${POLICY_FOLDS}-fold stratified CV — complete=${outcomeLabels.filter(v => v === 1).length}/incomplete=${outcomeLabels.filter(v => v === 0).length}`,
    )
  }

  // ── Model cuối trên TOÀN BỘ dữ liệu (stats full-data — đúng V3/B) ──
  const d = policyFeatureNames(vocab).length
  const spec = buildPolicySpec(d, actionVocab.models.length, override)
  const fitOpts = policyDraftFitOpts(override)
  const { means, stds } = computeColumnStats(X)
  const Xstd = X.map(row => standardizeRow(row, means, stds))

  const repX: number[][] = []
  const repY: number[][] = []
  rows.forEach((r, i) => {
    const copies = replicateCount(rewards[i])
    const y = new Array<number>(actionVocab.models.length).fill(0)
    y[actions[i]] = 1
    for (let c = 0; c < copies; c++) {
      repX.push(Xstd[i])
      repY.push(y)
    }
  })
  const mlp = new MLP(spec)
  const fit: FitResult = mlp.fit(repX, repY, fitOpts)

  // p̂ = mean Outcome* (đúng header + changelog — FB-BRAIN-P4-R1-01)
  const successRate = outcomeStars.reduce<number>((s, v) => s + v, 0) / outcomeStars.length
  const lambdaFull = policyLambda(rows.length, successRate)

  // Version mới = max + 1
  const maxRow = await db.brainModel.aggregate({
    where: { brain: 'policy' },
    _max: { version: true },
  })
  const version = (maxRow._max.version ?? 0) + 1

  // Bất biến A1: tắt active cũ TRƯỚC khi ghi bản active mới (không
  // $transaction BUG2-119; gãy giữa chừng → không còn active → mixture rơi
  // nhánh π_Q thuần — hướng an toàn)
  if (cv.improved) {
    await db.brainModel.updateMany({
      where: { brain: 'policy', active: true },
      data: { active: false },
    })
  }

  // Provenance chain §5.3 (kế thừa pattern V3/B)
  const dateFrom = rows.length > 0
    ? rows.reduce((m, r) => (r.createdAt < m ? r.createdAt : m), rows[0].createdAt)
    : null
  const dateTo = rows.length > 0
    ? rows.reduce((m, r) => (r.createdAt > m ? r.createdAt : m), rows[0].createdAt)
    : null
  const runIdList = Array.from(new Set(rows.map(r => r.runId))).sort()
  const RUN_IDS_MAX = 50
  const lineageRunIds: string[] | string = runIdList.length <= RUN_IDS_MAX
    ? runIdList
    : `sha256:${createHash('sha256').update(runIdList.join('\n')).digest('hex').slice(0, 16)} (${runIdList.length} runs)`

  const trainMeta = {
    nSamples: rows.length,
    successRate: round5(successRate),
    lambda: round5(lambdaFull),
    lambdaK: POLICY_LAMBDA_K,
    inputMode: POLICY_INPUT_MODE,
    metric: 'ce(mixture vs π_Q)',
    // Trường tiêu chuẩn của panel /api/brain (parseTrainMeta) — cổng active.
    // LƯU Ý tên trường: panel dùng chung 'brierBaseline' cho mọi brain — với
    // policy đây là CE của π_Q đối chứng (không phải Brier) — cùng hợp đồng
    // hiển thị "baseline đối chứng", giữ tên trường cho tương thích panel.
    cvScore: round5(cv.cvCeMixture),
    cvScoreCiLow: round5(cv.cvCeMixtureCiLo),
    cvScoreCiHigh: round5(cv.cvCeMixtureCiHi),
    brierBaseline: round5(cv.ceBaseline),
    improved: cv.improved,
    vocab,
    actionVocab,
    featureNames: policyFeatureNames(vocab),
    // stds GIỮ FULL precision — KHÔNG round5 (bài học FB-BRAIN-P2-R1-01)
    standardization: { means: means.map(round5), stds: stds.slice() },
    reward: {
      weights: REWARD_WEIGHTS,
      replicateScale: POLICY_REPLICATE_SCALE,
      objective: 'reward-weighted imitation qua replication — KHÔNG học tránh (xem policy.ts header)',
      stats: {
        mean: round5(rewards.reduce((s, v) => s + v, 0) / rewards.length),
        min: round5(Math.min(...rewards)),
        max: round5(Math.max(...rewards)),
      },
    },
    qBaseline: {
      stateKey,
      tau: round5(tau),
      scores: qScores.map(round5),
    },
    fit: {
      epochsRun: fit.epochsRun,
      bestEpoch: fit.bestEpoch,
      stoppedEarly: fit.stoppedEarly,
      finalTrainLoss: Number.isFinite(fit.finalTrainLoss) ? round5(fit.finalTrainLoss) : null,
    },
    // BRAIN-UX §9.4 — |gradient| trung bình từng lớp (chế độ lan truyền
    // ngược UX-3 — dữ liệu thật) + provenance draft UX-2
    gradAbsMean: fit.gradAbsMean.map(round5),
    draftUsed: Boolean(override),
    dataLineage: {
      tables: {
        AgentRunRecord: rows.length,
        ArbiterVerdict: Array.from(verdicts.values()).reduce((s, t) => s + t.confirmed + t.refuted, 0),
        QEntry: qEntryCount,
      },
      runs: runIdList.length,
      runIds: lineageRunIds,
      dateRange: dateFrom && dateTo ? [dateFrom.toISOString(), dateTo.toISOString()] : null,
      labelRule: 'Outcome* = verdict refuted→0 / confirmed∧complete→1 / fallback complete (reward.ts outcomeFromEvidence — DÙNG CHUNG cho stratification CV, p̂ λ, reward — FB-BRAIN-P4-R1-01) · reward composite §3.1 (quality null → renormalize)',
      inputMode: POLICY_INPUT_MODE,
      baseline: 'π_Q = softmax(Q/τ) từ QEntry thật (stateKey agent-runtime, τ runtime_model_tau)',
      flagKey: 'runtime_policy',
    },
  }

  // specJson: document vocab + action vocab + spec (single-source)
  const specDoc = { inputMode: POLICY_INPUT_MODE, vocab, actionVocab, spec, featureNames: policyFeatureNames(vocab) }
  // weightsJson: envelope numpy-đọc-được (audit A6)
  const weightsDoc = { mlp: mlp.serialize() satisfies MlpSerialized }

  await db.brainModel.create({
    data: {
      brain: 'policy',
      version,
      inputMode: POLICY_INPUT_MODE,
      specJson: JSON.stringify(specDoc),
      weightsJson: JSON.stringify(weightsDoc),
      trainMetaJson: JSON.stringify(trainMeta),
      active: cv.improved,
    },
  })

  // Prune A2: giữ active + N bản mới nhất (fail-open)
  await prunePolicyVersions()

  return {
    trained: true,
    version,
    active: cv.improved,
    sampleSize: rows.length,
    improved: cv.improved,
    cv,
    usable: rows.length,
    total: rows.length,
    qEntries: qEntryCount,
    verdicts: verdictCount,
    // BRAIN-UX §9.3/§9.4 — quỹ đạo epoch + |gradient| từng lớp + draft UX-2
    history: fit.history,
    gradAbsMean: fit.gradAbsMean.map(round5),
    draftUsed: Boolean(override),
  }
}

/** Prune phiên bản policy (A2) — giữ MỌI bản active + N mới nhất. */
async function prunePolicyVersions(): Promise<void> {
  try {
    const rows = await db.brainModel.findMany({
      where: { brain: 'policy' },
      orderBy: { version: 'desc' },
      select: { id: true, version: true, active: true },
    })
    const keep = new Set<string>()
    rows.forEach((r, i) => {
      if (r.active || i < BRAIN_VERSIONS_KEEP) keep.add(r.id)
    })
    const drop = rows.filter(r => !keep.has(r.id))
    if (drop.length > 0) {
      await db.brainModel.deleteMany({ where: { id: { in: drop.map(r => r.id) } } })
    }
  } catch (err) {
    console.warn('[Brain-C] prune failed (fail-open):', err instanceof Error ? err.message : String(err))
  }
}

// ==================== RUNTIME LOAD (fail-open) ====================

/** Model Brain-C active đã nạp từ DB (π_net + stats + vocab + λ). */
export interface ActivePolicy {
  version: number
  nSamples: number
  successRate: number
  vocab: PolicyVocab
  actionVocab: PolicyActionVocab
  mlp: MLP
  means: number[]
  stds: number[]
  /** λ = 1 − min(clamp(n/K,0,1), wilsonLB(p̂,n)) — tính lúc load (r87 pin công thức; FB-BRAIN-P4-R1-02 sửa JSDoc cũ ghi thiếu "1−"). */
  lambda: number
  /** Chất lượng CV từ trainMeta — hiển thị kèm mixture. */
  cv: { cvCeMixture: number; ceBaseline: number }
}

/**
 * Nạp bản policy active từ BrainModel — MỌI nhánh không áp được trả null
 * (không có bản active / trainMeta rách / standardization sai chiều hoặc
 * std ≤ 0 / weightsJson rách / nSamples dưới ngưỡng runtime / vocab.action
 * < 2). stds ≤ 0 → null (FB-BRAIN-P2-R1-01).
 */
export async function loadActivePolicy(): Promise<ActivePolicy | null> {
  try {
    const row = await db.brainModel.findFirst({
      where: { brain: 'policy', active: true, inputMode: POLICY_INPUT_MODE },
      orderBy: { version: 'desc' },
      select: { version: true, specJson: true, weightsJson: true, trainMetaJson: true },
    })
    if (!row) return null

    const meta = JSON.parse(row.trainMetaJson) as Record<string, unknown>
    const num = (v: unknown): number | null =>
      typeof v === 'number' && Number.isFinite(v) ? v : null
    const nSamples = num(meta.nSamples)
    const successRate = num(meta.successRate)
    if (nSamples === null || nSamples < POLICY_MIN_RUNTIME_SAMPLES || successRate === null) return null

    // Vocab (specJson) — đúng dạng
    const specDoc = JSON.parse(row.specJson) as {
      vocab?: unknown
      actionVocab?: unknown
      spec?: unknown
    }
    const vocabRaw = specDoc.vocab as PolicyVocab | undefined
    const okAgents = vocabRaw && Array.isArray(vocabRaw.agents) && vocabRaw.agents.every(a => typeof a === 'string')
    if (!okAgents) return null
    const vocab: PolicyVocab = { agents: (vocabRaw as PolicyVocab).agents }
    const actionRaw = specDoc.actionVocab as PolicyActionVocab | undefined
    const okActions =
      actionRaw && Array.isArray(actionRaw.models) && actionRaw.models.every(m => typeof m === 'string')
    if (!okActions || (actionRaw as PolicyActionVocab).models.length < 2) return null
    const actionVocab: PolicyActionVocab = { models: (actionRaw as PolicyActionVocab).models }

    // Standardization stats — đúng D chiều, mọi giá trị hữu hạn, stds > 0
    const d = policyFeatureNames(vocab).length
    const std = meta.standardization as { means?: unknown; stds?: unknown } | undefined
    const okArr = (v: unknown): v is number[] =>
      Array.isArray(v) && v.length === d && v.every(x => typeof x === 'number' && Number.isFinite(x))
    const okStds =
      Array.isArray(std?.stds) && (std.stds as unknown[]).length === d
      && (std.stds as unknown[]).every(x => typeof x === 'number' && Number.isFinite(x) && x > 0)
    if (!std || !okArr(std.means) || !okArr(std.stds) || !okStds) return null

    // MLP deserialize (throw → catch → null — fail-open)
    const weightsDoc = JSON.parse(row.weightsJson) as { mlp?: MlpSerialized }
    if (!weightsDoc.mlp) return null
    // FB-BRAIN-P3-R1-08 (phần storage — cùng guard như surrogate): JSON không
    // lưu được NaN (→ null) — weights rách thành null → weight-0 âm thầm.
    // Chặn ở cửa nạp: MỌI giá trị envelope phải finite, vi phạm → null.
    const allWeightsFinite = (m: MlpSerialized): boolean =>
      m.tensors.every(t => Array.isArray(t.envelope?.data) && t.envelope.data.every(v => Number.isFinite(v)))
    if (!allWeightsFinite(weightsDoc.mlp)) return null
    const mlp = MLP.deserialize(weightsDoc.mlp)

    // Kiểm input dim khớp vocab + output dim khớp action vocab (weightsJson/
    // specJson từ 2 nguồn phải cùng kiến trúc — lệch là DB rách)
    if (mlp.getSpec().layers[0].units !== d) return null
    if (mlp.getSpec().layers[mlp.getSpec().layers.length - 1].units !== actionVocab.models.length) return null

    return {
      version: row.version,
      nSamples,
      successRate,
      vocab,
      actionVocab,
      mlp,
      means: std.means,
      stds: std.stds,
      lambda: policyLambda(nSamples, successRate),
      cv: {
        cvCeMixture: num(meta.cvScore) ?? Number.NaN,
        ceBaseline: num(meta.brierBaseline) ?? Number.NaN,
      },
    }
  } catch {
    return null // fail-open — mọi lỗi nạp → mixture rơi nhánh π_Q thuần
  }
}

// ==================== RUNTIME MIXTURE (thuần + organ wiring) ====================

/** Kết quả áp mixture cho danh sách ứng viên (thứ tự GIỮ NGUYÊN candidates). */
export interface PolicyMixtureResult {
  /** Phân phối mixture trên candidates (tổng = 1). */
  probs: number[]
  /** λ dùng (0..1) — 1 = thuần π_Q. */
  lambda: number
  /** Phần π_net đóng góp hiệu dụng (1−λ sau xét action lạ). */
  netShare: number
  version: number
}

/**
 * Áp mixture π = λ·π_Q + (1−λ)·π_net cho danh sách ứng viên — THUẦN.
 *
 * Hợp đồng ném lỗi (kế thừa FB-BRAIN-P2-R1-05): means/stds phải đúng D
 * chiều VÀ stds > 0 mọi chiều — vi phạm → throw; caller bọc try/catch →
 * giữ π_Q nguyên vẹn (fail-open KHÔNG đổi).
 *
 * Ứng viên ngoài action vocab (model lạ): π_net không nói được → phần net
 * chỉ phân cho ứng viên ĐÃ BIẾT (renormalize trong tập biết); không ứng
 * viên nào biết → probs = π_Q nguyên vẹn (netShare = 0). π_Q đầu vào phải
 * đã chuẩn hóa (softmaxPolicy) — tổng 0 (rác) → throw rõ ràng.
 */
export function applyPolicyMixture(
  active: ActivePolicy,
  qProbs: number[],
  candidates: readonly string[],
  ctx: PolicyFeatureCtx,
): PolicyMixtureResult {
  const tMix = Date.now() // OBS-P2 — đo latency vết suy diễn (chỉ dùng khi trộn THẬT)
  const d = policyFeatureNames(active.vocab).length
  if (active.means.length !== d || active.stds.length !== d) {
    throw new Error(
      `applyPolicyMixture: means/stds phải đúng ${d} chiều (nhận ${active.means.length}/${active.stds.length}) — ActivePolicy hỏng`,
    )
  }
  if (!active.stds.every(v => v > 0)) {
    throw new Error('applyPolicyMixture: stds phải > 0 mọi chiều — chia 0 tạo ±∞/NaN (FB-BRAIN-P2-R1-01)')
  }
  if (qProbs.length !== candidates.length) {
    throw new Error(
      `applyPolicyMixture: qProbs (${qProbs.length}) phải cùng chiều candidates (${candidates.length}) — lỗi lập trình caller`,
    )
  }
  const qSum = qProbs.reduce((s, v) => s + v, 0)
  if (!(qSum > 0) || !qProbs.every(v => Number.isFinite(v) && v >= 0)) {
    throw new Error('applyPolicyMixture: qProbs phải là phân phối hợp lệ (tổng > 0, mọi phần tử ≥ 0 hữu hạn)')
  }

  const actionIndex = new Map(active.actionVocab.models.map((m, i) => [m, i]))
  const knownIdx: Array<{ cand: number; vocab: number }> = []
  candidates.forEach((c, i) => {
    const vi = actionIndex.get(c)
    if (vi !== undefined) knownIdx.push({ cand: i, vocab: vi })
  })

  const lambda = Math.min(1, Math.max(0, active.lambda))
  // Không ứng viên biết / λ = 1 → π_Q nguyên vẹn (renormalize chống float drift)
  if (knownIdx.length === 0 || lambda >= 1) {
    return {
      probs: qProbs.map(v => v / qSum),
      lambda,
      netShare: 0,
      version: active.version,
    }
  }

  // π_net trên hàng đặc trưng đã chuẩn hóa
  const raw = buildPolicyFeatureRow(ctx, active.vocab)
  const x = raw.map((v, j) =>
    typeof v === 'number' && Number.isFinite(v) ? (v - active.means[j]) / active.stds[j] : 0,
  )
  const net = active.mlp.predict(x)
  const knownMass = knownIdx.reduce((s, k) => s + (net[k.vocab] ?? 0), 0)
  if (!Number.isFinite(knownMass) || knownMass <= 0) {
    // π_net không đặt khối lượng nào lên ứng viên biết → nghe Q (fail-open)
    return {
      probs: qProbs.map(v => v / qSum),
      lambda,
      netShare: 0,
      version: active.version,
    }
  }

  const out = qProbs.map(v => (lambda * v) / qSum)
  const netShare = 1 - lambda
  for (const k of knownIdx) {
    out[k.cand] += netShare * ((net[k.vocab] ?? 0) / knownMass)
  }
  const outSum = out.reduce((s, v) => s + v, 0)
  if (!(outSum > 0) || !out.every(v => Number.isFinite(v) && v >= 0)) {
    return {
      probs: qProbs.map(v => v / qSum),
      lambda,
      netShare: 0,
      version: active.version,
    }
  }
  // OBS-P2 hook (§C.3 đợt 2 — organ policy_mixture): vết suy diễn Brain-C khi
  // π_net trộn thật với π_Q (fire-and-forget — KHÔNG đụng phân phối trả về)
  traceInference({
    brain: 'policy',
    organ: 'policy_mixture',
    modelVersion: active.version,
    input: x,
    output: out,
    latencyMs: Date.now() - tMix,
  })
  return { probs: out.map(v => v / outSum), lambda, netShare, version: active.version }
}

// ==================== CỜ (STORE > ENV > DEFAULT=off — tuning store) ====================

/** Cờ master RUNTIME_POLICY — chỉ user bật (mặc định off, điểm dừng §4.4). */
export function isRuntimePolicyEnabled(): boolean {
  try {
    return getTuningEnum('runtime_policy') === 'on'
  } catch {
    return false // key lạ/DB lỗi → off (fail-open)
  }
}

/** 3 cơ quan steering — mỗi cái kill-switch độc lập (blueprint §4.4). */
export type PolicyOrgan = 'routing' | 'adaptation' | 'tuning'

const POLICY_ORGAN_FLAG_KEY: Record<PolicyOrgan, string> = {
  routing: 'policy_organ_routing',
  adaptation: 'policy_organ_adaptation',
  tuning: 'policy_organ_tuning',
}

export function isPolicyOrganEnabled(organ: PolicyOrgan): boolean {
  try {
    return getTuningEnum(POLICY_ORGAN_FLAG_KEY[organ]) === 'on'
  } catch {
    return false
  }
}

// ==================== ORGAN 1 — MODEL ROUTING (llm.ts) ====================

/**
 * ORGAN 1 wiring cho maybeApplySoftmaxModelPolicy (llm.ts): khi master
 * `runtime_policy` + organ `policy_organ_routing` đều on VÀ có bản active
 * (3 lớp fail-open) → trộn π_net vào probs. Mọi nhánh khác → null (caller
 * giữ probs π_Q nguyên vẹn — hành vi y hệt trước P4). Lỗi → null (fail-open).
 */
export async function maybeMixModelProbs(
  qProbs: number[],
  candidates: readonly string[],
  ctx: PolicyFeatureCtx,
): Promise<PolicyMixtureResult | null> {
  if (!isRuntimePolicyEnabled() || !isPolicyOrganEnabled('routing')) return null
  try {
    const active = await loadActivePolicy()
    if (!active) return null
    return applyPolicyMixture(active, qProbs, candidates, ctx)
  } catch {
    return null // fail-open — giữ π_Q
  }
}

// ==================== ORGAN 2 — ADAPTATION DIRECTIVES (advisory text) ====================

/**
 * ORGAN 2 wiring cho systemBlocks (workflow-engine): advisory TEXT đề xuất
 * model theo mixture — KHÔNG đổi quyết định nào (chỉ dòng chữ vào system
 * prompt để agent tham khảo, đúng tinh thần "chuyển từng bước"). Trả ''
 * khi: master/organ off · không active · không tính được mixture.
 */
export async function buildPolicyAdvisoryBlock(ctx: PolicyFeatureCtx): Promise<string> {
  if (!isRuntimePolicyEnabled() || !isPolicyOrganEnabled('adaptation')) return ''
  try {
    const active = await loadActivePolicy()
    if (!active) return ''
    const { getQAdvice, softmaxPolicy, agentRuntimeStateKey } = await import('@/lib/learning/q-table')
    const tau = getTuningNumber('runtime_model_tau')
    const advice = await getQAdvice(agentRuntimeStateKey(), active.actionVocab.models)
    const qByAction = new Map(advice.map(a => [a.action, a.q]))
    const qScores = active.actionVocab.models.map(m => qByAction.get(m) ?? 0)
    const qProbs = softmaxPolicy(qScores, tau)
    const mix = applyPolicyMixture(active, qProbs, active.actionVocab.models, ctx)
    const ranked = active.actionVocab.models
      .map((m, i) => ({ m, p: mix.probs[i] }))
      .sort((a, b) => b.p - a.p)
      .slice(0, 3)
      .map((r, i) => `${i + 1}. ${r.m} (π=${r.p.toFixed(2)})`)
      .join(' · ')
    return (
      `\n\n--- ĐỀ XUẤT BRAIN-C "Lệnh" (policy head v${active.version} — advisory, không bắt buộc) ---\n` +
      `- Mixture π = ${mix.lambda.toFixed(2)}·π_Q + ${mix.netShare.toFixed(2)}·π_net đề xuất model: ${ranked}\n` +
      `- CV: CE mixture ${active.cv.cvCeMixture.toFixed(4)} vs π_Q ${active.cv.ceBaseline.toFixed(4)} (n=${active.nSamples})\n` +
      `--- HẾT ĐỀ XUẤT BRAIN-C ---`
    )
  } catch {
    return '' // fail-open — không advisory
  }
}

// ==================== ORGAN 3 — TUNING-STORE ĐỀ XUẤT (read-only) ====================

/** 1 đề xuất tham số tuning do Brain-C sinh (chỉ ĐỀ XUẤT — user duyệt qua UI). */
export interface PolicyTuningProposal {
  key: string
  currentValue: string
  proposedValue: string
  rationale: string
  evidence: string
}

/**
 * ORGAN 3 (blueprint §4.4 "(3) 13 tham số tuning-store — brain chỉ đề xuất
 * giá trị vào change-log, người duyệt vẫn là user qua UI"): DANH SÁCH ĐỀ
 * XUẤT read-only — KHÔNG ghi TuningParam/TuningChangeLog (audit trail chỉ
 * sinh khi user áp dụng qua UI đúng P2). Trả [] khi organ off.
 *
 * Đề xuất phase này (dẫn nguồn được, không đoán mò):
 *  - runtime_model_policy off → 'softmax' khi Q ≥ 30 entry (π_Q chỉ có hiệu
 *    lực khi đường softmax sống — mixture cần nền đó);
 *  - runtime_policy off → 'on' khi có bản active thắng CV (brain tự đề xuất
 *    bật chính nó sau khi qua cổng — user vẫn quyết định).
 */
export async function buildTuningProposals(): Promise<PolicyTuningProposal[]> {
  if (!isPolicyOrganEnabled('tuning')) return []
  const proposals: PolicyTuningProposal[] = []
  try {
    // R4-ĐIỀU TRA — cùng signal SUM(visits) như train gate (nhất quán đề xuất)
    const qCount = await import('@/lib/learning/q-table').then(m => m.countQLearningSignal())
    const modelPolicy = getTuningEnum('runtime_model_policy')
    if (modelPolicy !== 'softmax' && qCount >= POLICY_MIN_Q_ENTRIES) {
      proposals.push({
        key: 'runtime_model_policy',
        currentValue: modelPolicy,
        proposedValue: 'softmax',
        rationale: 'Q đã có dữ liệu học (≥ 30 entry) nhưng đường softmax đang off — π_Q không tham gia chọn model; bật để Q và mixture Brain-C có hiệu lực.',
        evidence: `QEntry=${qCount} (ngưỡng §2: ${POLICY_MIN_Q_ENTRIES})`,
      })
    }
    const active = await loadActivePolicy()
    if (active && !isRuntimePolicyEnabled()) {
      proposals.push({
        key: 'runtime_policy',
        currentValue: 'off',
        proposedValue: 'on',
        rationale: 'Brain-C có bản active đã thắng π_Q qua CV — đề xuất bật cờ master để mixture tham gia (organ kill-switch vẫn chặn từng cơ quan).',
        evidence: `v${active.version}: CE mixture ${active.cv.cvCeMixture.toFixed(4)} < π_Q ${active.cv.ceBaseline.toFixed(4)} · n=${active.nSamples} · λ=${active.lambda.toFixed(2)}`,
      })
    }
  } catch {
    return proposals // fail-open — trả những gì tính được
  }
  return proposals
}
