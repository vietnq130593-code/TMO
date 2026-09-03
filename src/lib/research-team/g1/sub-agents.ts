/**
 * RESEARCH TEAM — G1 SUB-AGENTS (TB-03 §5 SA matrix + §5.3 dual-interpretation conflict)
 * =================================================================================
 * Spec:
 *  - TB-03 §5.1 — Bảng số sub-agents theo loại task (5–300 / 5–15 / 5–15 ...).
 *  - TB-03 §5.2 — Chiến lược batch (Sequential / Parallel / Hybrid).
 *  - TB-03 §5.3 — SA conflict resolution protocol: 2 SA cùng chủ đề trái ngược →
 *    điều tra bắt buộc; không giải thích được → ESCALATE NEMESIS kèm 2 interpretation.
 *  - TB-03 §5.4 — Stop conditions (S1–S5) + batch cap ≤ 25/round (TB-01 §2 Q1).
 *  - constants.ts SUB_AGENT_LIMITS = { perPart: 20, perG1Round: 25 }.
 *
 * Fail-open policy (TB-13 §4 — NIM keys placeholder trong sandbox):
 *  - dispatchSubAgent lỗi LLM → status FAILED + error field; KHÔNG throw.
 *  - dispatchPlan không bao giờ reject toàn plan vì 1 SA fail — Promise.allSettled
 *    thu tất cả kết quả; SA FAILED đánh dấu ❌ trong registry, batch tiếp tục.
 *
 * NOTE: Sub-agent là instance model stack chung (kimi-k3 + fallback chain — TB-01 §2).
 * SA dùng callLLM (kimi-k3 agent core + fallback chain) vì là agent logic;
 * nếu cần deep reasoning sẽ qua callLLM (sivil.ts SYNTHESIZE + council engine.ts).
 * callUtilityLLM (extraction cores nemotron/gpt-oss) CHỈ dùng cho trích xuất tài liệu — KHÔNG cho agent logic.
 */

import { callLLM } from '@/lib/llm'
import type { LLMResult } from '@/lib/llm'
import { SUB_AGENT_LIMITS } from '../constants'
import { recordModelSwitch } from '../model-switch'

// ============================================================
// §1. TYPES — SubAgent + DispatchPlan
// ============================================================

export type SubAgentStatus =
  | 'PENDING' // Chưa dispatch
  | 'RUNNING' // Đang chạy LLM
  | 'DONE' // Hoàn thành, có result
  | 'FAILED' // LLM error / timeout / parse fail
  | 'CONFLICT' // Bị flag mâu thuẫn với SA khác (TC-03)

export interface SubAgent {
  /** ID dạng SA-NN (TB-00 §1.4 — within 1 part) */
  id: string
  /** Label ngắn cho display (vd: "Missing value scan") */
  label: string
  /** Task 1 dòng mô tả phạm vi SA này đảm nhiệm */
  task: string
  status: SubAgentStatus
  /** Result text từ LLM (khi DONE) */
  result?: string
  /** Evidence refs (file:line / log excerpt) — TB-04 §5 claim bắt buộc evidence */
  evidence?: string[]
  /** Model đã dùng để chạy SA (TB-01 §2 — kimi-k3 mặc định + fallback chain) */
  modelUsed?: string
  /** Error message nếu FAILED */
  error?: string
  startedAt?: string
  finishedAt?: string
}

export interface DispatchPlan {
  partId: string
  /** Số SA thực sự sẽ dispatch (≤ perPart=20) */
  saCount: number
  tasks: SubAgent[]
  round: number
  /** Note nếu directions > 20 → overflow (top-20 theo priority) */
  overflowNote?: string
}

// ============================================================
// §2. PLAN SUB-AGENTS (TB-03 §4.1 DECOMPOSE + §5.4 cap)
// ============================================================

/**
 * Chia directions thành DispatchPlan:
 *  - Cap SUB_AGENT_LIMITS.perPart = 20 (TB-03 §5.4 batch cap).
 *  - Label SA-01..SA-NN (TB-00 §1.4 — 2 digit pad).
 *  - directions.length > 20 → ưu tiên top-20 theo thứ tự (caller đã rank),
 *    ghi overflowNote để SIVIL biết branch bị cắt.
 *
 * Pure function — KHÔNG side-effect (chưa call LLM, chưa spawn gì).
 */
export function planSubAgents(
  partId: string,
  exploreDirections: string[],
  round: number,
): DispatchPlan {
  const directions = (exploreDirections || []).filter((d) => typeof d === 'string' && d.trim().length > 0)
  const cap = SUB_AGENT_LIMITS.perPart // 20
  const overflow = directions.length > cap
  const selected = overflow ? directions.slice(0, cap) : directions

  const tasks: SubAgent[] = selected.map((dir, idx) => ({
    id: `SA-${String(idx + 1).padStart(2, '0')}`,
    label: dir.slice(0, 80), // label ngắn cho display
    task: dir,
    status: 'PENDING',
  }))

  return {
    partId,
    saCount: tasks.length,
    tasks,
    round,
    overflowNote: overflow
      ? `Directions (${directions.length}) > cap (${cap}) — top-${cap} selected; ${directions.length - cap} branches skipped (TB-03 §5.4 cap)`
      : undefined,
  }
}

// ============================================================
// §3. DISPATCH ONE SUB-AGENT (TB-03 §4.2 DISPATCH)
// ============================================================

/**
 * Dispatch 1 SA: gọi callLLM (kimi-k3 agent core), set status, parse result.
 * - LLM success → status DONE + result + modelUsed.
 * - LLM error → status FAILED + error; KHÔNG throw (fail-open).
 * - Record model switch nếu fallback xảy ra (non-blocking — best-effort).
 *
 * TB-03 §5.4 stop S5: SA đơn lẻ chết → retry ≤ 2 (caller lo — hàm này chỉ 1 lần
 * call). Vẫn chết → FAILED trong registry, batch tiếp tục.
 */
export async function dispatchSubAgent(
  sa: SubAgent,
  prompt: string,
  systemPrompt: string,
): Promise<SubAgent> {
  const startedAt = new Date().toISOString()
  const running: SubAgent = { ...sa, status: 'RUNNING', startedAt }

  let llmResult: LLMResult
  try {
    llmResult = await callLLM(prompt, systemPrompt, `g1-sa-${sa.id}`, {
      temperature: 0.2,
      maxTokens: 2000, // SA output nhỏ — claim + evidence ngắn
      agentId: 'SIVIL',
      agentName: 'SIVIL (sub-orchestrator)',
    })
  } catch (err) {
    // LLM throw (network, timeout...) → FAILED, KHÔNG crash
    const errorMsg = err instanceof Error ? err.message : String(err)
    console.warn(`[ResearchTeam/g1] SA ${sa.id} dispatchSubAgent threw:`, errorMsg)
    return {
      ...running,
      status: 'FAILED',
      error: `LLM call threw: ${errorMsg}`,
      finishedAt: new Date().toISOString(),
    }
  }

  // LLM error field (NIM placeholder keys → 401 etc.) → FAILED fail-open
  if (llmResult.error) {
    console.warn(`[ResearchTeam/g1] SA ${sa.id} LLM error:`, llmResult.error)
    return {
      ...running,
      status: 'FAILED',
      error: llmResult.error,
      finishedAt: new Date().toISOString(),
    }
  }

  // Parse result + extract evidence lines (file:line pattern)
  const result = (llmResult.content || '').trim()
  const evidence = extractEvidenceLines(result)

  // Record model switch nếu LLM trả model khác primary (kimi-k3) — DR-C7
  // Non-blocking: nếu record fail, không ảnh hưởng SA result.
  const modelUsed = llmResult.model || 'unknown'
  // (Heuristic: nếu modelUsed không chứa 'kimi-k3' → có thể đã fallback.)
  if (modelUsed && !modelUsed.includes('kimi-k3') && !modelUsed.includes('none')) {
    try {
      await recordModelSwitch({
        agentId: 'SIVIL',
        fromModel: 'moonshotai/kimi-k3',
        toModel: modelUsed,
        trigger: `SA ${sa.id} LLM fallback (TB-01 §2 chain)`,
        nextCheck: new Date(Date.now() + 60 * 60 * 1000).toISOString(), // +1h
      })
    } catch (err) {
      console.warn(
        `[ResearchTeam/g1] SA ${sa.id} recordModelSwitch non-blocking fail:`,
        err instanceof Error ? err.message : String(err),
      )
    }
  }

  return {
    ...running,
    status: result ? 'DONE' : 'FAILED',
    result: result || undefined,
    evidence: evidence.length > 0 ? evidence : undefined,
    modelUsed,
    error: result ? undefined : 'LLM returned empty content',
    finishedAt: new Date().toISOString(),
  }
}

/** Extract evidence refs từ SA result — pattern `path:line` hoặc `file.ext:NN` */
function extractEvidenceLines(text: string): string[] {
  if (!text) return []
  const pattern = /(?:[\w./-]+\.(?:ts|tsx|js|jsx|py|md|json|csv|log|ipynb)):\d+(?::\d+)?/g
  const matches = text.match(pattern) || []
  // Dedupe preserving order
  return Array.from(new Set(matches))
}

// ============================================================
// §4. DISPATCH PLAN (TB-03 §4.2 — Parallel Waves mặc định)
// ============================================================

/**
 * Dispatch TẤT cả SA trong plan song song (Promise.allSettled).
 *
 * TB-03 §5.4 + constants.ts: perG1Round cap = 25. Nếu plan.saCount > 25 → chia
 * batches (Sequential theo phase) — mỗi batch ≤ 25, tổng hợp giữa chừng.
 * Hiện tại perPart cap = 20 → 1 part luôn ≤ 20 SA; perG1Round=25 là trần cho
 * multi-part cùng round. Caller (engine.ts) chịu trách nhiệm không vượt 25/round
 * khi gọi nhiều part cùng lúc.
 *
 * Trả về plan mới với tasks đã update status/result.
 */
export async function dispatchPlan(plan: DispatchPlan): Promise<DispatchPlan> {
  if (plan.tasks.length === 0) {
    return plan
  }

  // Nếu vượt perG1Round=25 → chia batches sequential (TB-03 §5.2 Sequential Batches)
  if (plan.tasks.length > SUB_AGENT_LIMITS.perG1Round) {
    return dispatchPlanInBatches(plan, SUB_AGENT_LIMITS.perG1Round)
  }

  // Default: 1 wave parallel (TB-03 §5.2 Parallel Waves)
  const results = await Promise.allSettled(
    plan.tasks.map((sa) =>
      dispatchSubAgent(
        sa,
        buildSAPrompt(sa),
        SA_SYSTEM_PROMPT,
      ),
    ),
  )

  const updatedTasks = plan.tasks.map((sa, idx) => {
    const r = results[idx]
    if (r.status === 'fulfilled') return r.value
    // Promise rejected (lỗi hạ tầng ngoài LLM) → FAILED
    return {
      ...sa,
      status: 'FAILED' as SubAgentStatus,
      error: `Promise rejected: ${r.reason instanceof Error ? r.reason.message : String(r.reason)}`,
      finishedAt: new Date().toISOString(),
    }
  })

  return { ...plan, tasks: updatedTasks }
}

/**
 * Dispatch plan theo batches sequential (khi saCount > perG1Round cap).
 * Mỗi batch ≤ batchSize; tổng hợp kết quả giữa chừng (TB-03 §5.4 — Sequential).
 */
async function dispatchPlanInBatches(
  plan: DispatchPlan,
  batchSize: number,
): Promise<DispatchPlan> {
  const allTasks: SubAgent[] = [...plan.tasks]
  const updated: SubAgent[] = []

  for (let i = 0; i < allTasks.length; i += batchSize) {
    const batch = allTasks.slice(i, i + batchSize)
    const batchPlan: DispatchPlan = {
      ...plan,
      tasks: batch,
      saCount: batch.length,
    }
    const done = await dispatchPlan(batchPlan)
    updated.push(...done.tasks)
    // TB-03 §5.4 stop S1: ≥ 50% SA fail trong batch → log warning (không dừng)
    const failCount = done.tasks.filter((t) => t.status === 'FAILED').length
    if (failCount > 0 && failCount / done.tasks.length >= 0.5) {
      console.warn(
        `[ResearchTeam/g1] Batch ${Math.floor(i / batchSize) + 1} ≥ 50% SA FAILED (TB-03 §5.4 stop S1) — continue (fail-open)`,
      )
    }
  }

  return { ...plan, tasks: updated }
}

/** Prompt user cho SA — gắn task + ID + constraint return format */
function buildSAPrompt(sa: SubAgent): string {
  return [
    `SA-ID: ${sa.id}`,
    `TASK: ${sa.task}`,
    '',
    'Thực hiện task trong phạm vi hẹp đã chỉ định. Trả kết quả ngắn gọn:',
    '- Phát hiện chính (1-3 dòng).',
    '- Evidence: file:line hoặc log excerpt (bắt buộc nếu có claim).',
    '- KHÔNG giải thích lan man — SA chỉ là 1 mắt exploration.',
  ].join('\n')
}

const SA_SYSTEM_PROMPT = [
  'Bạn là Sub-Agent của SIVIL (G1 — research team TMO).',
  'Phạm vi: 1 task hẹp — explore 1 hướng/khía cạnh/module.',
  '',
  'Nguyên tắc (TB-03 §5.1):',
  '- Trả kết quả ngắn (≤ 200 từ) — không lan man.',
  '- Mọi claim BẮT BUỘC kèm evidence (file:line / log excerpt / metric).',
  '- Nếu không tìm thấy gì → trả "Không có phát hiện đáng kể" + lý do.',
  '- KHÔNG bịa số liệu; nếu thiếu data → ghi rõ "(thiếu data)".',
].join('\n')

// ============================================================
// §5. DETECT CONFLICTS (TB-03 §5.3 — dual-interpretation escalation)
// ============================================================

export interface ConflictPair {
  a: SubAgent
  b: SubAgent
  summary: string
}

export interface ConflictDetectionResult {
  hasConflict: boolean
  conflictPairs: ConflictPair[]
}

/**
 * Detect conflict giữa SA results (TB-03 §5.3 — TC-03 gate).
 *
 * HEURISTIC (TB-13 §1 nguyên tắc 7 — tái dùng hạ tầng, không NLP phức tạp):
 *  - 2 SA có result trái ngược về cùng chủ đề → flag conflict.
 *  - Cặp từ đối lập tiếng Việt/Anh: "không nên" ↔ "nên" / "bỏ" ↔ "giữ" /
 *    "sai" ↔ "đúng" / "drop" ↔ "keep" / "fail" ↔ "pass" / "❌" ↔ "✅".
 *  - Nếu result có cùng chủ đề (overlap keyword ≥ 30%) + chứa cặp đối lập → conflict.
 *
 * HEURISTIC là tiền-chẩn-đoán (TB-03 §6.3) — engine.ts sẽ ESCALATE nếu không giải
 * thích được; không tự xử lý (TB-03 §5.3 3B: SIVIL flag, NEMESIS quyết).
 *
 * Note: KHÔNG cần NLP phức tạp — keyword match đủ cho gate TC-03 (tabletop test).
 */
export function detectConflicts(sas: SubAgent[]): ConflictDetectionResult {
  const done = sas.filter((s) => s.status === 'DONE' && s.result)
  if (done.length < 2) {
    return { hasConflict: false, conflictPairs: [] }
  }

  const pairs: ConflictPair[] = []
  for (let i = 0; i < done.length; i++) {
    for (let j = i + 1; j < done.length; j++) {
      const a = done[i]
      const b = done[j]
      const conflict = detectConflictPair(a, b)
      if (conflict) {
        pairs.push({ a, b, summary: conflict })
      }
    }
  }

  // Mark SA status CONFLICT để engine.ts dễ filter
  for (const pair of pairs) {
    pair.a.status = 'CONFLICT'
    pair.b.status = 'CONFLICT'
  }

  return { hasConflict: pairs.length > 0, conflictPairs: pairs }
}

/** Cặp từ đối lập — heuristic đơn giản (TB-13 §1 — không NLP) */
const OPPOSITE_PAIRS: Array<[string[], string[]]> = [
  // Việt
  [['không nên', 'ko nên', 'không được'], ['nên', 'được', 'phải']],
  [['bỏ', 'xóa', 'gỡ bỏ'], ['giữ', 'thêm', 'tích hợp']],
  [['sai', 'lỗi', 'hỏng'], ['đúng', 'ổn', 'chính xác']],
  [['chậm', 'chặn', 'treo'], ['nhanh', 'ok', 'bình thường']],
  // Anh
  [['drop', 'remove', 'delete'], ['keep', 'add', 'include']],
  [['fail', 'fail-fast', 'broken'], ['pass', 'working', 'ok']],
  [['❌', 'worsen', 'regress'], ['✅', 'improve', 'better']],
  [['no', 'false'], ['yes', 'true']],
]

/** Detect 1 cặp conflict — overlap keyword ≥ 30% + chứa opposite pair */
function detectConflictPair(a: SubAgent, b: SubAgent): string | null {
  const ta = (a.result || '').toLowerCase()
  const tb = (b.result || '').toLowerCase()
  if (!ta || !tb) return null

  // 1. Topic overlap — tokenize + Jaccard ≥ 0.3
  const overlap = jaccardOverlap(ta, tb)
  if (overlap < 0.3) return null

  // 2. Có cặp đối lập: a chứa từ nhóm X, b chứa từ nhóm Y (hoặc ngược)
  for (const [negGroup, posGroup] of OPPOSITE_PAIRS) {
    const aNeg = negGroup.some((w) => ta.includes(w))
    const aPos = posGroup.some((w) => ta.includes(w))
    const bNeg = negGroup.some((w) => tb.includes(w))
    const bPos = posGroup.some((w) => tb.includes(w))

    // 1 SA nói "nên" + 1 SA nói "không nên" → conflict
    // FIX (Task 19 audit A#4): nhánh 2 cũ `aNeg && bPos && !bPos` = mâu thuẫn
    // logic (bPos && !bPos luôn false) — mất nửa chiều conflict (a âm, b dương)
    // → TC-03 gate mù. Đúng phải là `!bNeg` (b thuần dương) mirror nhánh 1.
    if ((aPos && bNeg && !aNeg) || (aNeg && bPos && !bNeg)) {
      const aWord = aPos ? posGroup.find((w) => ta.includes(w)) : negGroup.find((w) => ta.includes(w))
      const bWord = bNeg ? negGroup.find((w) => tb.includes(w)) : posGroup.find((w) => tb.includes(w))
      return (
        `Conflict "${aWord}" vs "${bWord}" — 2 SA cùng chủ đề (overlap ${(overlap * 100).toFixed(0)}%) ` +
        `trả kết quả trái ngược (TC-03 dual-interpretation). ` +
        `A=${a.id}: "${(a.result || '').slice(0, 80)}..." · B=${b.id}: "${(b.result || '').slice(0, 80)}..."`
      )
    }
  }

  return null
}

/** Jaccard overlap coefficient giữa 2 chuỗi tokenized */
function jaccardOverlap(a: string, b: string): number {
  const stop = new Set([
    'và', 'hoặc', 'của', 'cho', 'trong', 'với', 'một', 'các', 'the', 'a', 'an',
    'is', 'are', 'to', 'in', 'on', 'and', 'or', 'for', 'with', 'this', 'that',
    'không', 'có', 'là', 'được', 'với', 'các', 'trong',
  ])
  const ta = new Set(
    a.split(/\s+/).filter((t) => t.length > 2 && !stop.has(t)),
  )
  const tb = new Set(
    b.split(/\s+/).filter((t) => t.length > 2 && !stop.has(t)),
  )
  if (ta.size === 0 || tb.size === 0) return 0
  let inter = 0
  for (const t of ta) if (tb.has(t)) inter++
  const union = ta.size + tb.size - inter
  return union === 0 ? 0 : inter / union
}
