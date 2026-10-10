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
 * weights[i] = 0 → π(i) = 0 (model bị chặn health — "weight 0" theo spec);
 * weight mặc định 1. Mảng rỗng / toàn weight-0 / τ không hợp lệ → trả mảng 0
 * (caller tự xử fallback — KHÔNG đoán mò ở tầng thuần).
 *
 * Ổn định số trị: trừ max(score/τ) trước khi exp (score lớn → exp tràn ∞ → NaN).
 */
export function softmaxPolicy(scores: number[], tau: number, weights?: number[]): number[] {
  const n = scores.length
  if (n === 0) return []
  const t = Number.isFinite(tau) && tau > 0 ? tau : RUNTIME_MODEL_TAU_DEFAULT
  const w = weights ?? scores.map(() => 1)
  if (w.length !== n || w.some(x => x < 0)) return scores.map(() => 0)

  const scaled = scores.map(s => (Number.isFinite(s) ? s / t : -Infinity))
  const max = Math.max(...scaled.filter(x => Number.isFinite(x)))
  if (!Number.isFinite(max)) return scores.map(() => 0) // toàn -∞ (không có ứng viên trọng số > 0)

  const exps = scaled.map((x, i) => (w[i] > 0 && Number.isFinite(x) ? Math.exp(x - max) : 0))
  const sum = exps.reduce((s, v) => s + v, 0)
  if (!(sum > 0)) return scores.map(() => 0)
  return exps.map(e => e / sum)
}

/**
 * Hash FNV-1a 32-bit tất định từ chuỗi — nguồn seed "hash(sessionId, cycle)
 * chạy lại được" (spec §P6-M3). Cùng input → cùng seed → cùng lựa chọn.
 */
export function deterministicSeed(...parts: string[]): number {
  const str = parts.join('|')
  // FNV-1a 32-bit
  let h = 0x811c9dc5
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

/**
 * Chọn index từ phân phối xác suất bằng seed tất định (thuần) — walk danh sách
 * tích luỹ [prob[0], prob[0]+prob[1], …] rồi lấy theo seed/2^32 (đều khắp
 * [0,1)). Xác suất toàn 0 → trả -1 (caller fallback ứng viên đầu/đường cũ).
 */
export function pickIndexBySeed(probs: number[], seed: number): number {
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
 * Fail-open: lỗi DB → log + return (KHÔNG throw — learning side-channel).
 */
export async function updateQ(
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

    // max_a' Q(s',·) — chưa có entry nào ở state kế → 0 (uniform prior khởi điểm)
    const nextEntries = await db.qEntry.findMany({
      where: { stateKey: nextStateKey },
      select: { qValue: true },
    })
    const maxNextQ = nextEntries.reduce((m, e) => Math.max(m, e.qValue), 0)

    const newQ = qLearningUpdate(currentQ, reward, maxNextQ)
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
 * — chỉ trả action CÓ dữ liệu (visits > 0), sắp xếp q giảm dần.
 */
export async function getTopQAdvice(stateKey: string, limit = 5): Promise<QAdviceEntry[]> {
  try {
    const rows = await db.qEntry.findMany({
      where: { stateKey, visits: { gt: 0 } },
      select: { actionKey: true, qValue: true, visits: true },
      orderBy: [{ qValue: 'desc' }, { visits: 'desc' }],
      take: Math.max(1, Math.min(20, limit)),
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
