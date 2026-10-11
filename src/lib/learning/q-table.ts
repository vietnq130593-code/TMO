/**
 * P6-M2 · TABULAR Q-LEARNING — QEntry + updateQ/getQAdvice
 * (BLUEPRINT-STATS-LEARNING-P0-P6 §P6-M2, mục #15 — DL.pdf §Q-Table +
 * §Common RL Algorithms: Q-Learning)
 *
 *   Q(s,a) ← Q(s,a) + α·[r + γ·max_a' Q(s',a') − Q(s,a)]     (α=0.1, γ=0.9)
 *
 * Không cần DQN/PPO — không gian trạng thái nhỏ (mode × tier × model/strategy).
 * Reward quy ước §P6-M2: +1 verdict confirmed ∧ runComplete / −1 refuted /
 * 0 pending-bỏ (bỏ = không update — pending không phải bằng chứng).
 *
 * P6-M1 — LEDGER (KHÔNG bảng attribution riêng): StrategyAdaptationLog
 * (fromStrategy/toStrategy/successful) + AgentRunRecord.model (P4-M2) vẫn là
 * nguồn dữ liệu; 2 điểm chốt nhập liệu:
 *   W1 · markSessionAdaptationOutcome đóng SAL (workflow side — actionKey =
 *       toStrategy, stateKey = mode-tier của workflow routing)
 *   W2 · resolveArbiterVerdicts cuối run goal-loop (actionKey = model THỰC
 *       TẾ chạy nhiều nhất của run, stateKey = agent-runtime — xem
 *       agentRuntimeStateKey)
 *
 * State-key quy ước `mode-${routingMode}-tier-${tier}` — TÁI DÙNG FORMAT key
 * sẵn của historical-feedback (mode-A-tier-1...). Goal-loop runtime KHÔNG có
 * routing workflow → một state tổng hợp 'agent' (mode-agent-tier-1): mọi run
 * chat-agent ghi vào cùng state để dữ liệu học hội tụ nhanh (đúng chủ đích
 * "không gian trạng thái nhỏ"); khi goal-loop tương lai có routing context
 * chỉ cần đổi helper — mọi consumer (softmax §P6-M3, advisory §P6-M4) đều
 * qua helper này.
 *
 * Thuần-toán (qLearningUpdate/softmaxPolicy/deterministicSeed/pickIndexBySeed)
 * tách riêng KHÔNG I/O — test trực tiếp; mọi hàm DB fail-open tuyệt đối
 * (learning side-channel KHÔNG BAO GIỜ làm gãy run agent).
 */

import { db } from '@/lib/db'
import { getTuningNumber } from './tuning-store'

// ==================== HẰNG SỐ (nguồn: spec §P6-M2) ====================

/** Tốc độ học α — spec §P6-M2: 0.1 (cập nhật thận trọng, chống nhiễu 1 run) */
export const Q_LEARNING_ALPHA = 0.1
/** Hệ số chiết khấu γ — spec §P6-M2: 0.9 */
export const Q_LEARNING_GAMMA = 0.9
/**
 * τ mặc định cho softmax(τ) §P6-M3 — env RUNTIME_MODEL_TAU override
 * (floor 0.05: τ→0 tiệm cận argmax cứng — mất tính ngẫu nhiên chống cascade).
 */
export const RUNTIME_MODEL_TAU_DEFAULT = 0.5
/** Floor τ — τ→0 mất tính ngẫu nhiên chống cascade (spec §P6-M3 τ vừa). */
export const RUNTIME_MODEL_TAU_FLOOR = 0.05

/**
 * Parse τ từ env (RUNTIME_MODEL_TAU) — FB-P6-R1-B-07: parse tường minh để
 * "0" (giá trị hợp lệ — user chủ ý τ=0) qua floor 0.05 chứ KHÔNG rơi nhầm
 * về default (bản trước `parseFloat(x || '0.5') || 0.5` coi '0' là falsy);
 * NaN/∞/rỗng → default 0.5. Thuần — test trực tiếp (r79).
 */
export function parseRuntimeModelTau(value: string | undefined): number {
  const parsed = parseFloat(value ?? '')
  return Math.max(RUNTIME_MODEL_TAU_FLOOR, Number.isFinite(parsed) ? parsed : RUNTIME_MODEL_TAU_DEFAULT)
}

// ==================== STATE KEY (P6-M1 quy ước) ====================

/**
 * State key chuẩn `mode-${routingMode}-tier-${tier}` — đúng format key sẵn
 * của historical-feedback (tái dùng triệt để theo spec §P6-M1).
 */
export function qStateKey(routingMode: string | number, tier: string | number): string {
  return `mode-${routingMode}-tier-${tier}`
}

/**
 * State của GOAL-LOOP RUNTIME (chat agents) — không có routing workflow nên
 * dùng một state tổng hợp: mọi run goal-loop ghi/học chung (mode-agent-tier-1).
 * §P6-M3 (softmax llm.ts) + §P6-M4 (advisory dropdown/PLAN hint) đều đọc qua
 * helper này để 2 phía luôn cùng key.
 */
export function agentRuntimeStateKey(): string {
  return qStateKey('agent', 1)
}

// ==================== THUẦN — TOÁN Q (test trực tiếp) ====================

/**
 * Một bước Q-learning (thuần):
 *   Q' = Q + α·[r + γ·maxNextQ − Q]
 * maxNextQ = max_a' Q(s',·) — episod kết thúc (terminal) → caller truyền 0.
 * Kẹp [-1, 1]: reward ∈ {-1, 0, +1} và γ<1 → giới hạn tự nhiên |Q| ≤
 * r_max/(1−γ) = 10 về mặt lý thuyết, nhưng kẹp sớm giữ bảng đọc được + chống
 * tích luỹ float sai lệch qua hàng nghìn update.
 */
export function qLearningUpdate(
  currentQ: number,
  reward: number,
  maxNextQ: number,
  alpha: number = Q_LEARNING_ALPHA,
  gamma: number = Q_LEARNING_GAMMA,
): number {
  if (!Number.isFinite(currentQ) || !Number.isFinite(reward) || !Number.isFinite(maxNextQ)) {
    return Number.isFinite(currentQ) ? currentQ : 0
  }
  const next = currentQ + alpha * (reward + gamma * maxNextQ - currentQ)
  return Math.min(1, Math.max(-1, next))
}

/**
 * Phân phối softmax(τ) (thuần) — §P6-M3: π(a) = exp(score/τ) / Σ exp(score/τ).
 *
 * weights[i] = 0 → π(i) = 0 (model bị chặn health — "weight 0" theo spec;
 * LƯU Ý FB-P6-R1-A-12: weights là CỔNG (0 = chặn) chứ KHÔNG phải multiplier
 * "score × health" theo chữ spec — production dùng binary-health tương đương
 * vì llm.ts lọc blocked khỏi candidates và không truyền weights);
 * weight mặc định 1. Mảng rỗng / toàn weight-0 → trả mảng 0
 * (caller tự xử fallback — KHÔNG đoán mò ở tầng thuần). τ vô hiệu
 * (NaN/≤0/∞ — vd env parse hỏng) → sanitize về RUNTIME_MODEL_TAU_DEFAULT
 * (0.5) và VẪN trả phân bố hợp lệ (FB-P6-R1-A-04: JSDoc cũ ghi "trả mảng 0"
 * — sai hành vi thực; policy là lớp học, τ hỏng không được giết phân phối).
 *
 * Ổn định số trị: trừ max(score/τ) — chỉ trên ứng viên CÒN SỐNG (w>0,
 * FB-P6-R1-A-08: argmax bị chặn phải không kéo max xuống gây underflow toàn
 * mảng) — trước khi exp (score lớn → exp tràn ∞ → NaN).
 */
export function softmaxPolicy(scores: number[], tau: number, weights?: number[]): number[] {
  const n = scores.length
  if (n === 0) return []
  const t = Number.isFinite(tau) && tau > 0 ? tau : RUNTIME_MODEL_TAU_DEFAULT
  const w = weights ?? scores.map(() => 1)
  if (w.length !== n || w.some(x => x < 0)) return scores.map(() => 0)

  const scaled = scores.map(s => (Number.isFinite(s) ? s / t : -Infinity))
  const alive = scaled.map((x, i) => (w[i] > 0 && Number.isFinite(x) ? x : -Infinity))
  const max = Math.max(...alive)
  if (!Number.isFinite(max)) return scores.map(() => 0) // toàn -∞ (không có ứng viên trọng số > 0)

  const exps = alive.map(x => (Number.isFinite(x) ? Math.exp(x - max) : 0))
  const sum = exps.reduce((s, v) => s + v, 0)
  if (!(sum > 0)) return scores.map(() => 0)
  return exps.map(e => e / sum)
}

/**
 * Hash FNV-1a 32-bit tất định từ chuỗi + PHÂN TÁN CUỐI (murmur3 fmix32).
 * Nguồn seed "hash(sessionId, cycle) chạy lại được" (spec §P6-M3). Cùng
 * input → cùng seed → cùng lựa chọn.
 *
 * FB-P6-R1-A-02: FNV-1a trần (không finalizer) với chuỗi cycle tuần tự
 * ('…|0', '…|1', '…|2' — chỉ ký tự cuối đổi, '0'→'1' xor đúng 1 bit 0)
 * tạo seed lệch nhau CHÍNH XÁC ±FNV-prime (0x01000193) → r = seed/2³²
 * đi cấp số cộng bước 1/256 → 20 chu kỳ của 1 session rơi cố định 1-2
 * bucket xác suất (đo 500 session ngẫu nhiên: mean distinct model ≈1.99/4,
 * 16-19% session chỉ đụng 1 model — phá mục tiêu chống 429-cascade).
 * fmix32 (avalanche) phá cấu trúc cấp số cộng này, giữ nguyên tính tất
 * định. Chuẩn hoá: FNV-1a thuần chạy trên code-unit UTF-16 (không phải
 * byte UTF-8) — đúng vector chuẩn cho ASCII, lệch canonical cho non-ASCII;
 * hệ thống chỉ cần tất định nội bộ (không cần khớp thư viện ngoài).
 * Lưu ý join('|'): seed('a|b','c') ≡ seed('a','b|c') — sessionId là
 * uuid/cuid không chứa '|' nên vô hại thực tế (ghi nhận FB-P6-R1-A-10).
 */
export function deterministicSeed(...parts: string[]): number {
  const str = parts.join('|')
  // FNV-1a 32-bit
  let h = 0x811c9dc5
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  // Avalanche finalizer (murmur3 fmix32) — FB-P6-R1-A-02: phá cấu trúc số
  // học tuyến tính của FNV-trần trên input tuần tự, phân bố seed đều trên
  // toàn vùng uint32 (bảo toàn tính tất định — cùng input vẫn cùng output).
  h ^= h >>> 16
  h = Math.imul(h, 0x85ebca6b)
  h ^= h >>> 13
  h = Math.imul(h, 0xc2b2ae35)
  h ^= h >>> 16
  return h >>> 0
}

/**
 * Chọn index từ phân phối xác suất bằng seed tất định (thuần) — walk danh sách
 * tích luỹ [prob[0], prob[0]+prob[1], …] rồi lấy theo seed/(2³²−1) (đều khắp
 * [0,1); cặp (0, 2³²−1) cùng r=0 với xác suất 2/2³² — không đáng kể, ghi nhận
 * FB-P6-R1-A-07). Xác suất toàn 0 hoặc seed suy biến (âm/NaN/∞ — không thể
 * đến từ deterministicSeed >>> 0, chỉ qua caller trực tiếp) → trả -1
 * (caller fallback ứng viên đầu/đường cũ).
 */
export function pickIndexBySeed(probs: number[], seed: number): number {
  if (!Number.isFinite(seed) || seed < 0) return -1
  const sum = probs.reduce((s, v) => s + v, 0)
  if (!(sum > 0)) return -1
  const r = (seed % 0xffffffff) / 0xffffffff
  let acc = 0
  for (let i = 0; i < probs.length; i++) {
    acc += probs[i] / sum
    if (r < acc) return i
  }
  return probs.length - 1
}

// ==================== DB — UPDATE / ADVICE (fail-open tuyệt đối) ====================

export interface QAdviceEntry {
  action: string
  q: number
  visits: number
}

/**
 * Cập nhật Q(s,a) một bước (spec §P6-M2 signature).
 * Đọc Q hiện tại (không có → 0, visits 0) → max_a' Q(s',·) → upsert.
 * Episodic goal-loop: nextStateKey thường = stateKey (run sau bắt đầu cùng
 * trạng thái runtime) — γ·max Q(s,·) vẫn đúng nghĩa continuing task.
 *
 * max_a' Q(s',·) là MAX THUẦN trên các entry có sẵn của s' (state rỗng → 0
 * — uniform prior khởi điểm; FB-P6-R1-A-01: bản trước reduce khởi điểm 0
 * khiến max bị FLOOR tại 0 kể cả khi mọi entry s' âm — lệch công thức spec
 * §P6-M2 "γ·max_a' Q(s',a')" và lệch chính claim "max đầy đủ", khiến state
 * toàn-model-xấu học chậm ~10× và attractor lệch).
 *
 * NGUYÊN TỬ (FB-P6-R1-A-03): chuỗi đọc-tính-ghi được TUẦN TỰ HOÁ IN-PROCESS
 * qua chuỗi promise dùng chung (mọi updateQ gọi tới đều xếp hàng — 2 run
 * goal-loop đóng cùng lúc trên cùng (stateKey,actionKey) không còn
 * lost-update qValue; đo thật bản cũ: 10 update song song chỉ 1 ăn nhập).
 * KHÔNG dùng $transaction tương tác: Prisma + SQLite giữ lock suốt
 * transaction (đo thật FB-P6: 10 tx song song → Socket timeout nhiễm lan cả
 * hook của test file khác). Triển khai 1 process pm2 duy nhất + QEntry chỉ
 * được ghi qua updateQ → tuần tự hoá in-process kín mọi writer thật.
 * Fail-open: lỗi DB → log + return (KHÔNG throw — learning side-channel).
 */
let updateQChain: Promise<void> = Promise.resolve()
export function updateQ(
  stateKey: string,
  actionKey: string,
  reward: number,
  nextStateKey: string,
): Promise<void> {
  const run = updateQChain.then(() => updateQStep(stateKey, actionKey, reward, nextStateKey))
  // Chuỗi không bao giờ chết vì một link lỗi (updateQStep đã nuốt lỗi nội bộ —
  // belt-and-suspenders cho tương lai ai sửa làm nó throw được)
  updateQChain = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}

/**
 * Một bước đọc-tính-ghi (chỉ chạy trong chuỗi tuần tự của updateQ).
 * FB-P6-R2-04: bọc timeout tầng app — nếu Prisma socket-timeout không kick
 * (kịch bản hi hữu), link treo vĩnh viễn sẽ đóng băng cả chuỗi learning;
 * timeout reject → fail-open log → chuỗi tiếp tục. Prisma socket-timeout
 * (~5s) vẫn là hàng rào đầu tiên; đây là belt-and-suspenders.
 *
 * NEURAL-ARCH (2026-10-11): timeout đọc runtime từ tuning-store
 * (updateq_step_timeout_ms — STORE > ENV > 20s mặc định) — tinh chỉnh được
 * trên tab Kiến trúc Neural mà không restart pm2.
 */
async function updateQStep(
  stateKey: string,
  actionKey: string,
  reward: number,
  nextStateKey: string,
): Promise<void> {
  const timeoutMs = getTuningNumber('updateq_step_timeout_ms')
  const work = updateQStepInner(stateKey, actionKey, reward, nextStateKey)
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`updateQ step timeout ${timeoutMs}ms`)), timeoutMs)
  })
  try {
    await Promise.race([work, timeout])
  } catch (err) {
    // FB-P6-R3-02: đường timeout PHẢI log (JSDoc cũ nói "fail-open log" nhưng
    // không có log nào — work không bao giờ reject vì updateQStepInner tự
    // catch, nên nhánh này chỉ là timeout). Work nền có thể hoàn tất trễ.
    console.warn(
      `[QTable] updateQ(${stateKey}, ${actionKey}) step timeout ${timeoutMs}ms (fail-open — chuỗi tiếp tục, work nền có thể hoàn tất trễ):`,
      err instanceof Error ? err.message : String(err),
    )
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

async function updateQStepInner(
  stateKey: string,
  actionKey: string,
  reward: number,
  nextStateKey: string,
): Promise<void> {
  try {
    const existing = await db.qEntry.findUnique({
      where: { stateKey_actionKey: { stateKey, actionKey } },
      select: { qValue: true, visits: true },
    })
    const currentQ = existing?.qValue ?? 0
    const visits = existing?.visits ?? 0

    // max_a' Q(s',·) THUẦN trên entry có sẵn (FB-P6-R1-A-01) — state kế rỗng
    // → 0 (uniform prior). SQLite REAL không lưu NaN (hóa NULL) nên max không
    // bao giờ NaN từ DB; qLearningUpdate vẫn NaN-guard cho tầng thuần.
    const nextEntries = await db.qEntry.findMany({
      where: { stateKey: nextStateKey },
      select: { qValue: true },
    })
    const maxNextQ = nextEntries.length > 0 ? Math.max(...nextEntries.map(e => e.qValue)) : 0

    // NEURAL-ARCH (2026-10-11): α/γ đọc runtime từ tuning-store
    // (q_learning_alpha / q_learning_gamma — STORE > ENV > hằng số spec
    // 0.1/0.9). getTuningNumber là tra Map in-process (rẻ) + fail-open về
    // default khi DB chết — không làm chậm/gãy chuỗi learning. Hằng số
    // export Q_LEARNING_ALPHA/GAMMA giữ nguyên làm default + cho test r79.
    const newQ = qLearningUpdate(
      currentQ,
      reward,
      maxNextQ,
      getTuningNumber('q_learning_alpha'),
      getTuningNumber('q_learning_gamma'),
    )
    await db.qEntry.upsert({
      where: { stateKey_actionKey: { stateKey, actionKey } },
      create: { stateKey, actionKey, qValue: newQ, visits: visits + 1 },
      update: { qValue: newQ, visits: { increment: 1 } },
    })
  } catch (err) {
    console.warn(
      `[QTable] updateQ(${stateKey}, ${actionKey}) failed (fail-open):`,
      err instanceof Error ? err.message : String(err),
    )
  }
}

/**
 * Lời khuyên Q cho danh sách ứng viên (spec §P6-M2 signature) — trả entry cho
 * TẤT CẢ candidate (chưa học → q=0, visits=0 — "chưa có → uniform prior"),
 * sắp xếp theo q giảm dần (đứng đầu = đề xuất mạnh nhất).
 */
export async function getQAdvice(stateKey: string, candidateActions: string[]): Promise<QAdviceEntry[]> {
  const candidates = [...new Set(candidateActions.filter(Boolean))]
  if (candidates.length === 0) return []
  try {
    const rows = await db.qEntry.findMany({
      where: { stateKey, actionKey: { in: candidates } },
      select: { actionKey: true, qValue: true, visits: true },
    })
    const byAction = new Map(rows.map(r => [r.actionKey, r]))
    return candidates
      .map(action => ({
        action,
        q: byAction.get(action)?.qValue ?? 0,
        visits: byAction.get(action)?.visits ?? 0,
      }))
      .sort((a, b) => b.q - a.q || b.visits - a.visits)
  } catch (err) {
    // Fail-open: DB lỗi → mọi ứng viên trống (uniform prior) — caller vẫn chạy
    console.warn(`[QTable] getQAdvice(${stateKey}) failed (fail-open → uniform):`, err instanceof Error ? err.message : String(err))
    return candidates.map(action => ({ action, q: 0, visits: 0 }))
  }
}

/**
 * Top-N hành động đã học của một state (§P6-M4 advisory dropdown / PLAN hint)
 * — chỉ trả action CÓ dữ liệu (visits > 0), sắp xếp q giảm dần. limit bị
 * kẹp [1,20]; limit vô hiệu (NaN/∞) → default 5 (FB-P6-R1-A-11: NaN làm
 * Prisma take throw — vẫn fail-open nhưng gây log noise).
 */
export async function getTopQAdvice(stateKey: string, limit = 5): Promise<QAdviceEntry[]> {
  try {
    const lim = Number.isFinite(limit) ? Math.max(1, Math.min(20, Math.floor(limit))) : 5
    const rows = await db.qEntry.findMany({
      where: { stateKey, visits: { gt: 0 } },
      select: { actionKey: true, qValue: true, visits: true },
      orderBy: [{ qValue: 'desc' }, { visits: 'desc' }],
      take: lim,
    })
    return rows.map(r => ({ action: r.actionKey, q: r.qValue, visits: r.visits }))
  } catch (err) {
    console.warn(`[QTable] getTopQAdvice(${stateKey}) failed (fail-open → rỗng):`, err instanceof Error ? err.message : String(err))
    return []
  }
}

/** Đếm tổng visits của state (log/telemetry — dễ đọc bản đồ học). */
export async function qEntryCount(): Promise<{ entries: number; totalVisits: number }> {
  try {
    const rows = await db.qEntry.findMany({ select: { visits: true } })
    return { entries: rows.length, totalVisits: rows.reduce((s, r) => s + r.visits, 0) }
  } catch {
    return { entries: 0, totalVisits: 0 }
  }
}
