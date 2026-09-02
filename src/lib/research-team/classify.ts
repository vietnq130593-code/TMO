/**
 * RESEARCH TEAM — CLASSIFY (TB-02 §1 pipeline + §4 complexity + §6 edge #1 + DR-C2 + DR-C1)
 * =================================================================================
 * Spec:
 *  - TB-02 §1 — CLASSIFY là Bước 0 của MỌI request: mission_type (M1/M2/M3) +
 *    confidence; ambiguous → hỏi user đúng 1 câu.
 *  - TB-02 §4 — TRIAGE: 3 tiêu chí (scope/reasoningDepth/risk) × 3 mức → T1/T2/T3.
 *  - TB-02 §6 edge #1 — Request ambiguous (LOW confidence): hỏi user ĐÚNG 1 CÂU,
 *    KHÔNG đoán mò.
 *  - DR-C2 — Confidence counting (deterministic):
 *      HIGH  = signals ≥3 AND conflicts = 0  → classify ngay + tier from triage
 *      MED   = conflicts = 1                 → tie-break UP (chọn tier cao hơn)
 *      LOW   = conflicts ≥2 OR signals <3 OR ambiguous=true → KHÔNG guess, hỏi 1 câu
 *  - DR-C1 — M2 verify-only threshold: không đề nghị thay đổi → kết luận + Verify-Report
 *    mini + KB; có đề nghị → Proposal 1-item. (Hint lưu trong signals — không ảnh
 *    hưởng tới classify mission_type; chi tiết ở TB-11 — xử lý ở phase sau.)
 *
 * Fail-open policy: nếu LLM error/parse fail → LOW confidence + clarifyingQuestion,
 * KHÔNG throw. Caller (API route) đảm bảo mission vẫn persist với status 'CLASSIFY'.
 */

import { callUtilityLLM } from '@/lib/llm'
import type { LLMResult } from '@/lib/llm'
import {
  scoreComplexity,
  applyFloorRules,
  tieBreakUp,
  tierRank,
  type TriageInput,
  type TriageResult,
} from './tier'
import type { ConfidenceSignals } from './types'

// ============================================================
// §1. TYPES — ClassifyResult
// ============================================================

export interface ClassifyResult {
  /** Mission type — M1 Kaggle · M2 System Research TMO · M3 grand/research-paper */
  missionType: 'M1' | 'M2' | 'M3'
  /** DR-C2 confidence signals (signals/conflicts/level) — persist vào mission.confidenceJson */
  confidence: ConfidenceSignals
  /** Tier sau TRIAGE + floor-rule + tie-break; undefined khi LOW confidence (chờ user) */
  tier?: 'T1' | 'T2' | 'T3'
  /** TRIAGE score chi tiết (3 tiêu chí + total) — traceability cho Decision Log */
  triageScore?: { scope: number; reasoningDepth: number; risk: number; total: number }
  /** Câu hỏi 1 câu khi LOW confidence (TB-02 §6 edge #1) — undefined khi HIGH/MEDIUM */
  clarifyingQuestion?: string
  /** Raw signals/conflicts từ LLM — debug + ghi vào Decision Log */
  rawSignals: { signals: string[]; conflicts: string[] }
}

// ============================================================
// §2. SYSTEM PROMPT — DR-C2 confidence counting
// ============================================================

const CLASSIFY_SYSTEM_PROMPT = [
  'Bạn là KING (Team Lead). Phân loại request nghiên cứu.',
  '',
  'MISSION TYPE:',
  '- M1 = Kaggle/dataset competition (nhắc đến dataset/competition/CV/leaderboard/metric)',
  '- M2 = System Research TMO (nhắc đến logs/code/config/performance/system/module)',
  '- M3 = grand research/paper (nhắc đến paper/đề tài nghiên cứu lớn/literature review)',
  '',
  'DR-C2 CONFIDENCE COUNTING (deterministic):',
  '- HIGH = ≥3 tín hiệu cùng chiều ủng hộ mission_type, 0 mâu thuẫn',
  '- MEDIUM = đúng 1 tín hiệu mâu thuẫn → tie-break UP (chọn tier cao hơn)',
  '- LOW = ≥2 mâu thuẫn HOẶC thiếu tín hiệu (<3) HOẶC request mơ hồ → KHÔNG đoán, phải hỏi user 1 câu',
  '',
  'COMPLEXITY (TB-02 §4 — mỗi tiêu chí 1/2/3 điểm):',
  '- scope: 1=file/hàm · 2=1 module/feature · 3=multi-module/pipeline',
  '- reasoningDepth: 1=trực tiếp rõ ràng · 2=vài bước suy luận · 3=cần research/POC',
  '- risk: 1=thấp dễ phát hiện sai · 2=trung bình cần test · 3=cao cần nhiều vòng verify',
  'Tính: 3 điểm → T1 · 4–6 → T2 · 7–9 → T3.',
  'M2 floor rules (chỉ M2): đề xuất đụng ≥2 module → tối thiểu T2; audit trọn 1 module / redesign kiến trúc → T3.',
  '',
  'OUTPUT JSON ONLY (KHÔNG markdown, KHÔNG giải thích ngoài JSON):',
  '{',
  '  "missionType": "M1" | "M2" | "M3",',
  '  "signals": ["tín hiệu 1 ủng hộ", "tín hiệu 2", ...],',
  '  "conflicts": ["mâu thuẫn nếu có"],',
  '  "complexity": { "scope": 1|2|3, "reasoningDepth": 1|2|3, "risk": 1|2|3 },',
  '  "ambiguous": true | false',
  '}',
  '',
  'Tín hiệu phải CỤ THỂ — ví dụ: "nhắc đến logs/system/config" cho M2, "nhắc đến dataset/competition/CV" cho M1.',
  'Khi request mơ hồ không rõ M1 hay M2 → ambiguous=true + signals/conflicts phản ánh đúng.',
].join('\n')

// ============================================================
// §3. JSON EXTRACT (an toàn — handle markdown fence + garbage)
// ============================================================

/**
 * Extract JSON object từ LLM content. LLM thường bọc JSON trong ```json ... ```
 * hoặc thêm text thừa — helper này tự lấy block JSON đầu tiên hợp lệ.
 */
function extractJsonObject(content: string): Record<string, unknown> | null {
  if (!content || typeof content !== 'string') return null
  const trimmed = content.trim()

  // 1. Thử parse thẳng (LLM trả JSON sạch)
  try {
    const parsed = JSON.parse(trimmed)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed
  } catch {
    // fallthrough
  }

  // 2. Markdown fence ```json ... ```
  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i)
  if (fenceMatch) {
    try {
      const parsed = JSON.parse(fenceMatch[1])
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed
    } catch {
      // fallthrough
    }
  }

  // 3. Tìm { ... } đầu tiên (greedy, balanced-ish qua regex)
  const braceMatch = trimmed.match(/\{[\s\S]*\}/)
  if (braceMatch) {
    try {
      const parsed = JSON.parse(braceMatch[0])
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed
    } catch {
      // fallthrough
    }
  }

  return null
}

// ============================================================
// §4. CLASSIFY MISSION — main entry
// ============================================================

/**
 * Phân loại mission: gọi callUtilityLLM → parse JSON → DR-C2 confidence counting
 * → TRIAGE → floor-rule → tie-break.
 *
 * KHÔNG throw — mọi lỗi (LLM error, parse fail, ...) → LOW confidence +
 * clarifyingQuestion mặc định.
 */
export async function classifyMission(
  request: string,
  title?: string,
): Promise<ClassifyResult> {
  const safeRequest = (request || '').trim()
  if (!safeRequest) {
    return lowConfidenceFallback('Request rỗng — không thể phân loại.')
  }

  // ---------- 1. GỌI LLM (callUtilityLLM — nemotron extraction core) ----------
  const userPrompt = [
    `TITLE: ${title || '(không có)'}`,
    `REQUEST: ${safeRequest}`,
    '',
    'Phân loại request theo schema JSON đã nêu. Liệt kê signals/conflicts CỤ THỂ.',
  ].join('\n')

  let llmResult: LLMResult
  try {
    llmResult = await callUtilityLLM(userPrompt, CLASSIFY_SYSTEM_PROMPT, 'research-classify', {
      temperature: 0.1,
      maxTokens: 1500,
      agentId: 'KING',
      agentName: 'KING (Team Lead)',
    })
  } catch (err) {
    console.error(
      '[ResearchTeam/classify] callUtilityLLM threw:',
      err instanceof Error ? err.message : String(err),
    )
    return lowConfidenceFallback(
      `LLM call failed: ${err instanceof Error ? err.message : String(err)}`,
    )
  }

  if (llmResult.error) {
    console.warn('[ResearchTeam/classify] LLM error field:', llmResult.error)
    return lowConfidenceFallback(`LLM error: ${llmResult.error}`)
  }

  // ---------- 2. PARSE JSON ----------
  const parsed = extractJsonObject(llmResult.content)
  if (!parsed) {
    console.warn(
      '[ResearchTeam/classify] JSON parse failed. Content preview:',
      llmResult.content.slice(0, 200),
    )
    return lowConfidenceFallback(
      'LLM không trả JSON hợp lệ — không thể phân loại tự động.',
    )
  }

  // ---------- 3. EXTRACT FIELDS (defensive) ----------
  const rawMissionType = String(parsed.missionType ?? '').toUpperCase()
  const missionType: 'M1' | 'M2' | 'M3' = isValidMissionType(rawMissionType)
    ? rawMissionType
    : 'M2' // default M2 cho TMO app — nhưng LOW sẽ không guess

  const signals = toStringArray(parsed.signals)
  const conflicts = toStringArray(parsed.conflicts)
  const ambiguous = parsed.ambiguous === true

  const complexityRaw = parsed.complexity
  const complexity =
    complexityRaw && typeof complexityRaw === 'object' && !Array.isArray(complexityRaw)
      ? (complexityRaw as Record<string, unknown>)
      : {}

  const scope = clampScoreField(complexity.scope)
  const reasoningDepth = clampScoreField(complexity.reasoningDepth)
  const risk = clampScoreField(complexity.risk)

  // ---------- 4. DR-C2 CONFIDENCE COUNTING ----------
  // HIGH: signals.length >= 3 AND conflicts.length === 0
  // MEDIUM: conflicts.length === 1 (và signals >= 1 — không thiếu hẳn)
  // LOW: conflicts >= 2 OR signals < 3 OR ambiguous=true
  let level: 'HIGH' | 'MEDIUM' | 'LOW'
  if (ambiguous || conflicts.length >= 2 || signals.length < 3) {
    level = 'LOW'
  } else if (conflicts.length === 1) {
    level = 'MEDIUM'
  } else {
    // conflicts.length === 0
    level = signals.length >= 3 ? 'HIGH' : 'LOW'
  }

  const confidence: ConfidenceSignals = { signals, conflicts, level }

  // ---------- 5. TRIAGE → TIER ----------
  const triageInput: TriageInput = { scope, reasoningDepth, risk }
  const triage: TriageResult = scoreComplexity(triageInput)
  let triageTier = triage.tier
  let floorReason: string | undefined

  // Apply M2 floor-rule (chỉ M2)
  if (missionType === 'M2') {
    const floor = applyFloorRules(missionType, triageTier, signals)
    if (floor.adjusted) {
      triageTier = floor.tier
      floorReason = floor.reason
    }
  }

  // ---------- 6. TIE-BREAK UP (DR-C2 MEDIUM) ----------
  // MEDIUM confidence + total nằm ngay biên trên của tier hiện tại → nâng tier.
  let finalTier: 'T1' | 'T2' | 'T3' = triageTier
  let tieBreakReason: string | undefined
  if (level === 'MEDIUM') {
    const upTier = tieBreakUp(triage.total)
    if (tierRank(upTier) > tierRank(finalTier)) {
      tieBreakReason = `Tie-break UP (DR-C2 MEDIUM): total=${triage.total} ở biên → nâng ${finalTier}→${upTier}`
      finalTier = upTier
    }
    // Ghi lý do tie-break vào signals để Decision Log truy vết
    if (tieBreakReason) {
      confidence.signals = [
        ...confidence.signals,
        `[tie-break-up] ${tieBreakReason}`,
      ]
    }
  }

  // ---------- 7. BUILD RESULT ----------
  const result: ClassifyResult = {
    missionType,
    confidence,
    tier: undefined,
    triageScore: {
      scope,
      reasoningDepth,
      risk,
      total: triage.total,
    },
    rawSignals: { signals, conflicts },
  }

  if (level === 'LOW') {
    // KHÔNG guess — TB-02 §6 edge #1: hỏi user đúng 1 câu.
    // Mission type vẫn được hint (default M2 hoặc LLM guess) nhưng tier KHÔNG set.
    result.tier = undefined
    result.clarifyingQuestion =
      'Đây là nghiên cứu hệ thống TMO (M2) hay bài toán Kaggle/dataset (M1)?'
    return result
  }

  // HIGH / MEDIUM → classify ngay, tier đã set
  result.tier = finalTier

  // Floor-rule / tie-break reason → lưu vào confidence.signals để debug + audit
  if (floorReason) {
    confidence.signals = [...confidence.signals, `[floor-rule] ${floorReason}`]
  }
  if (tieBreakReason && level === 'MEDIUM') {
    // already pushed above
  }

  return result
}

// ============================================================
// §5. HELPERS
// ============================================================

function isValidMissionType(v: string): v is 'M1' | 'M2' | 'M3' {
  return v === 'M1' || v === 'M2' || v === 'M3'
}

function toStringArray(v: unknown): string[] {
  if (Array.isArray(v)) {
    return v.map((x) => String(x)).filter((s) => s.trim().length > 0)
  }
  if (typeof v === 'string' && v.trim()) {
    return [v.trim()]
  }
  return []
}

function clampScoreField(v: unknown): 1 | 2 | 3 {
  const n = Number(v)
  if (!Number.isFinite(n)) return 2 // thiếu → medium an toàn
  if (n <= 1) return 1
  if (n >= 3) return 3
  return 2
}

/** LOW confidence fallback — không throw, luôn trả valid ClassifyResult */
function lowConfidenceFallback(reason: string): ClassifyResult {
  return {
    missionType: 'M2', // default hint — KHÔNG guess thật (tier undefined)
    confidence: {
      signals: [],
      conflicts: [reason],
      level: 'LOW',
    },
    tier: undefined,
    clarifyingQuestion:
      'Đây là nghiên cứu hệ thống TMO (M2) hay bài toán Kaggle/dataset (M1)?',
    rawSignals: { signals: [], conflicts: [reason] },
  }
}
