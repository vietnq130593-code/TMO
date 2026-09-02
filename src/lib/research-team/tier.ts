/**
 * RESEARCH TEAM — TIER (TB-02 §4 complexity + DR-C3 append-only + floor rules M2)
 * ==============================================================================
 * Spec:
 *  - TB-02 §4 — Bảng quyết định complexity: 3 tiêu chí (Phạm vi · Độ sâu suy luận ·
 *    Rủi ro) × 3 mức (1/2/3 điểm). Tổng 3→T1 · 4–6→T2 · 7–9→T3.
 *  - TB-02 §4 "floor-rule M2": (a) Proposal đụng ≥2 module → tối thiểu T2;
 *    (b) audit TRỌN 1 module / redesign kiến trúc → T3.
 *  - DR-C3 — nâng/hạ tier giữa chừng: APPEND-ONLY (changelog + decision log,
 *    KHÔNG rewrite lịch sử).
 *
 * Nguyên tắc: file này là pure-function cho TRIAGE (scoreComplexity + applyFloorRules);
 * changeTier là side-effect (DB write) và tuân thủ DR-C3 append-only.
 */

import { db } from '@/lib/db'
import {
  encodeJson,
  decodeMission,
  decodeJsonArray,
  decodeJsonObject,
} from './types'
import type {
  DecodedResearchMission,
  DecisionLogEntry,
  ChangelogEntry,
  ConfidenceSignals,
} from './types'

// ============================================================
// §1. TYPES — Triage I/O
// ============================================================

export interface TriageInput {
  /** Phạm vi — 1 file/hàm(1) · 1 module/feature(2) · multi-module/pipeline(3) */
  scope: 1 | 2 | 3
  /** Độ sâu suy luận — trực tiếp(1) · vài bước(2) · cần research/POC(3) */
  reasoningDepth: 1 | 2 | 3
  /** Rủi ro sai — thấp dễ phát hiện(1) · trung bình cần test(2) · cao nhiều vòng verify(3) */
  risk: 1 | 2 | 3
}

export interface TriageResult {
  total: number
  tier: 'T1' | 'T2' | 'T3'
  /** Giải thích vì sao chọn tier này (TB-02 §4 — traceability cho Decision Log) */
  rationale: string
}

// ============================================================
// §2. PURE FUNCTION — SCORE COMPLEXITY (TB-02 §4)
// ============================================================

/**
 * Chấm điểm complexity + chọn tier (TB-02 §4):
 *   total = scope + reasoningDepth + risk
 *   3 điểm → T1 (Simple — Fast Track)
 *   4–6 điểm → T2 (Medium — Standard Track)
 *   7–9 điểm → T3 (Complex — Full Pipeline)
 *
 * Pure function — không side-effect, dùng được cả trong classify.ts và test.
 */
export function scoreComplexity(input: TriageInput): TriageResult {
  const scope = clampScore(input.scope)
  const reasoningDepth = clampScore(input.reasoningDepth)
  const risk = clampScore(input.risk)
  const total = scope + reasoningDepth + risk

  let tier: 'T1' | 'T2' | 'T3'
  if (total <= 3) tier = 'T1'
  else if (total <= 6) tier = 'T2'
  else tier = 'T3'

  const rationale =
    `TRIAGE: scope=${scope} (1=file/hàm·2=module·3=multi-module) + ` +
    `reasoningDepth=${reasoningDepth} (1=trực tiếp·2=vài bước·3=research/POC) + ` +
    `risk=${risk} (1=thấp·2=trung bình·3=cao) = ${total} → ${tier} ` +
    `(TB-02 §4: 3→T1 · 4–6→T2 · 7–9→T3)`

  return { total, tier, rationale }
}

/** Clamp điểm về khoảng [1,3] — phòng LLM trả giá trị ngoài biên */
function clampScore(v: number): 1 | 2 | 3 {
  if (!Number.isFinite(v)) return 2 // thiếu → medium an toàn
  if (v <= 1) return 1
  if (v >= 3) return 3
  return 2
}

// ============================================================
// §3. FLOOR RULES M2 (TB-02 §4 — 2 floor-rule an toàn)
// ============================================================

/**
 * Áp floor rules M2 (TB-02 §4 EXT):
 *  (a) Proposal M2 đụng ≥2 module / cross-module → tối thiểu T2.
 *  (b) Audit TRỌN 1 module / redesign kiến trúc → T3.
 *
 * Chỉ áp dụng cho missionType M2. floor-rule là một-way: chỉ nâng, không hạ.
 * Hint từ LLM `signals` (mảng string) — KHÔNG override mù:
 * chỉ áp dụng khi signals NÊU RÕ tín hiệu đó.
 */
export function applyFloorRules(
  missionType: 'M1' | 'M2' | 'M3',
  baseTier: 'T1' | 'T2' | 'T3',
  signals: string[],
): { tier: 'T1' | 'T2' | 'T3'; adjusted: boolean; reason?: string } {
  if (missionType !== 'M2') {
    return { tier: baseTier, adjusted: false }
  }

  const joined = signals.join(' ').toLowerCase()

  // (b) Audit trọn 1 module / redesign kiến trúc → T3
  const fullModuleAudit = signalsContain(joined, [
    'audit toàn module',
    'audit trọn module',
    'audit 1 module',
    'redesign kiến trúc',
    'redesign kien truc',
    'redesign architecture',
    'toàn hệ thống',
    'toàn he thong',
    'cross-module redesign',
  ])
  if (fullModuleAudit) {
    const target: 'T1' | 'T2' | 'T3' = 'T3'
    if (tierRank(target) > tierRank(baseTier)) {
      return {
        tier: target,
        adjusted: true,
        reason:
          'Floor-rule M2 (b): audit trọn 1 module / redesign kiến trúc → T3 (TB-02 §4)',
      }
    }
  }

  // (a) Proposal đụng ≥2 module / cross-module → tối thiểu T2
  const crossModule = signalsContain(joined, [
    '≥2 module',
    '>=2 module',
    '2+ module',
    'cross-module',
    'cross module',
    'nhiều module',
    'nhieu module',
    'multi-module',
    'multi module',
    'đụng nhiều module',
    'dung nhieu module',
  ])
  if (crossModule) {
    const target: 'T1' | 'T2' | 'T3' = 'T2'
    if (tierRank(target) > tierRank(baseTier)) {
      return {
        tier: target,
        adjusted: true,
        reason:
          'Floor-rule M2 (a): Proposal đụng ≥2 module / cross-module → tối thiểu T2 (TB-02 §4)',
      }
    }
  }

  return { tier: baseTier, adjusted: false }
}

/** Match bất kỳ cụm từ nào trong lowercased signals string */
function signalsContain(lowered: string, phrases: string[]): boolean {
  return phrases.some((p) => lowered.includes(p))
}

/** Rank tier: T1 < T2 < T3 — dùng cho so sánh floor-rule + tie-break.
 *  Empty/undefined tier (mission ở CLASSIFY chưa set) → rank 0 (= chưa có tier). */
export function tierRank(t: 'T1' | 'T2' | 'T3' | '' | string): number {
  if (t === 'T1') return 1
  if (t === 'T2') return 2
  if (t === 'T3') return 3
  return 0 // chưa set (LOW confidence) hoặc giá trị lạ
}

/**
 * DR-C2 tie-break UP (P5): khi điểm nằm ngay biên (±1) giữa 2 tier → chọn tier
 * cao hơn. Lý do: hạ tier giữa chừng rẻ (DR-C3 append-only), thiếu depth thì đắt.
 *
 * Áp dụng cho MEDIUM confidence (1 mâu thuẫn). Nhận điểm THỰC TẾ (chưa floor-rule),
 * trả tier sau tie-break.
 */
export function tieBreakUp(total: number): 'T1' | 'T2' | 'T3' {
  // total đã ở dạng 3..9. ±1 biên giữa T1/T2 = 3..4; giữa T2/T3 = 6..7.
  // Tie-break UP chỉ áp dụng "nằm ngay biên":
  //  - total=3 (T1) nhưng MEDIUM → xem xét nâng lên T2? KHÔNG — 3 điểm là điểm
  //    thấp nhất, rõ ràng T1. Tie-break UP chỉ áp dụng khi điểm chạm biên trên.
  //  - total=6 (T2) MEDIUM → có thể nâng T3? 6 đã là T2, không phải biên với T3.
  //  - total=4 (T2) MEDIUM: điểm chạm biên trên của T1 (3) — KHÔNG nâng vì 4 rõ T2.
  // Cách đọc đúng DR-C2: "tie-break UP" nghĩa là khi tổng điểm nằm NGAY tại biên
  // trên của tier hiện tại (3 → biên với T2; 6 → biên với T3) → nâng lên tier cao.
  if (total === 3) return 'T2' // biên trên T1 (3 điểm) → nâng T2
  if (total === 6) return 'T3' // biên trên T2 (6 điểm) → nâng T3
  // Còn lại: giữ nguyên theo bảng
  if (total <= 3) return 'T1'
  if (total <= 6) return 'T2'
  return 'T3'
}

// ============================================================
// §4. CHANGE TIER — DR-C3 APPEND-ONLY (TB-02 §6 edge #3/#4 + DR-C3)
// ============================================================

/**
 * Đổi tier mission — DR-C3 APPEND-ONLY:
 *  (1) Append ChangelogEntry `{field:'tier', from, to, reason}` vào changelogJson
 *  (2) Append DecisionLogEntry `{decision:'PIVOT'|'CONTINUE', reason, ref}` vào
 *      decisionLogJson
 *  (3) Update mission.tier = newTier
 *
 * Throw nếu:
 *  - mission không tồn tại
 *  - newTier === current tier (no-op — KHÔNG ghi audit trail rỗng)
 */
export async function changeTier(
  missionId: string,
  newTier: 'T1' | 'T2' | 'T3',
  reason: string,
  ref?: string,
  agent?: string,
): Promise<DecodedResearchMission> {
  const row = await db.researchMission.findUnique({ where: { id: missionId } })
  if (!row) {
    throw new Error(`changeTier: mission ${missionId} không tồn tại`)
  }

  const oldTier = (row.tier || '') as 'T1' | 'T2' | 'T3' | ''
  if (oldTier === newTier) {
    throw new Error(
      `changeTier: no-op — mission ${missionId} đã ở tier ${newTier}`,
    )
  }

  const at = new Date().toISOString()
  const isUpgrade = tierRank(newTier) > tierRank(oldTier)

  // Append changelog (DR-C3 — KHÔNG rewrite)
  const changelog = decodeJsonArray<ChangelogEntry>(row.changelogJson)
  changelog.push({
    at,
    field: 'tier',
    from: oldTier || '(unset)',
    to: newTier,
    reason: reason || `tier ${oldTier || '(unset)'}→${newTier}`,
  })

  // Append decision log (decision='PIVOT' nếu nâng/hạ = thay đổi hướng;
  // 'CONTINUE' nếu caller chỉ định rõ — thường là PIVOT cho tier change)
  const decisionLog = decodeJsonArray<DecisionLogEntry>(row.decisionLogJson)
  decisionLog.push({
    at,
    agent: agent || 'KING',
    decision: 'PIVOT',
    reason:
      `tier ${isUpgrade ? 'nâng' : 'hạ'} ${oldTier}→${newTier}: ${reason}`,
    ref,
  })

  const updated = await db.researchMission.update({
    where: { id: missionId },
    data: {
      tier: newTier,
      changelogJson: encodeJson(changelog),
      decisionLogJson: encodeJson(decisionLog),
    },
  })

  return decodeMission(updated)
}

/** Re-export decodeJsonObject để classify.ts có thể dùng chung (không trùng lặp import) */
export const _decodeJson = decodeJsonObject

/** Re-export ConfidenceSignals type để classify.ts dùng chung */
export type { ConfidenceSignals }
