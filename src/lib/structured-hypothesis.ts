// ============================================================================
// STRUCTURED HYPOTHESIS REPOSITORY (SHR) + KHO MẨU CoT — Task 21 (2026-10-21)
//
// Thiết kế: knowledge/SELF_REFLECTION_DESIGN.md (R2 — phản chiếu xuyên chu kỳ)
// · SHR §2        — hypothesis có cấu trúc, posterior Laplace (α+1)/(α+β+2),
//                   vòng đời đóng băng bằng công thức: promote ≥0.80 ∧ α+β≥4,
//                   demote ≤0.35 ∧ α+β≥3, parrot_suspect khi cơ chế trùng ≥0.9
//                   mà ngữ cảnh lệch ≥0.5.
// · Kho mẫu CoT §5 — nén MDL 200-400 ký tự từ dòng REFLECT (✅/❓) + cơ chế,
//                   truy hồi Jaccard ≥0.5, ngân sách Kraft ≤64 mẩu (LRU×quality),
//                   chuỗi nguồn gốc ≤3 thế hệ (union bound — sai tích luỹ qua
//                   "mẩu dẫn mẩu"), drift Jaccard(con,gốc) <0.4 → cấm tái dùng.
// · RunContext    — Task 21-c: biên độ dữ liệu GĐ0(c) chu kỳ 1 sống qua các
//                   chu kỳ sau (đường CLI spawn mới mỗi chu kỳ mất in-memory).
//
// NGUYÊN TẮC λ-GROUNDED (chống causal parrot — BCA §5): agent KHÔNG tự cập
// nhật α/β được. Tool hypothesis_write chỉ GHI pendingJudgment; harness đối
// chiếu bằng chứng tool THẬT của chu kỳ (verifyPendingJudgments) rồi mới áp
// dụng — phán quyết không tìm thấy bằng chứng khớp → BỊ TỪ CHỐI.
//
// Toàn bộ fail-open: lỗi DB không bao giờ làm hỏng goal-loop.
// ============================================================================

import { db } from '@/lib/db'

// ==================== HẰNG SỐ (khởi tạo chờ kalib — §0 thiết kế) ====================

export const SHR_CONSTANTS = {
  /** posterior Laplace ≥ ngưỡng này ∧ đủ quan sát → promote (vào belief-state ưu tiên) */
  PROMOTE_POSTERIOR: 0.80,
  /** posterior ≤ ngưỡng này ∧ đủ quan sát → demote (ra khỏi belief-state) */
  DEMOTE_POSTERIOR: 0.35,
  /** α+β tối thiểu để promote (chống promote sau 1 lần may mắn) */
  PROMOTE_MIN_OBS: 4,
  /** α+β tối thiểu để demote (chống demote sau 1 lần xui) */
  DEMOTE_MIN_OBS: 3,
  /** Jaccard cơ chế ≥ ngưỡng này = trùng nội dung (parrot check) */
  PARROT_MECH_JACCARD: 0.9,
  /** khoảng cách ngữ cảnh ≥ ngưỡng này (1 - Jaccard ctx) = ngữ cảnh lệch */
  PARROT_CTX_DISTANCE: 0.5,
  /** kho mẩu CoT: tối đa mẩu/session (Kraft budget) */
  COT_BUDGET: 64,
  /** Jaccard ngữ cảnh ≥ ngưỡng này → mẩu được nạp (prior reasoning) */
  COT_MATCH_THRESHOLD: 0.5,
  /** chuỗi nguồn gốc tối đa 3 thế hệ — thế hệ 3 = tail (union bound) */
  COT_CHAIN_DEPTH: 3,
  /** Jaccard(con, gốc chuỗi) < ngưỡng này → drifted (cấm tái dùng nhánh) */
  COT_DRIFT_THRESHOLD: 0.4,
  /** mỗi lần truy hồi nạp tối đa 2 mẩu posterior cao nhất (R<C — kênh prompt là kênh nhiễu) */
  COT_MAX_RETRIEVE: 2,
} as const

// ==================== TIỆN ÍCH ====================

/** Token hóa chuỗi thành Set từ khóa (lowercase, ≥3 ký tự, lọc stopword Việt/Anh) */
function tokenize(text: string): Set<string> {
  const STOP = new Set([
    'và', 'của', 'cho', 'với', 'không', 'được', 'một', 'các', 'những', 'this',
    'cần', 'phải', 'có', 'là', 'trong', 'khi', 'thì', 'để', 'từ', 'the', 'and',
    'for', 'with', 'that', 'this', 'from', 'have', 'not', 'are', 'was', 'you',
    'your', 'will', 'shall', 'into', 'out', 'all', 'any', 'can', 'may', 'use',
    'using', 'make', 'made', 'when', 'what', 'which', 'how', 'why', 'who',
    'file', 'files', 'task', 'work', 'run', 'set', 'get', 'put', 'new', 'old',
  ])
  const raw = (text || '').toLowerCase().split(/[^\p{L}\p{N}_./-]+/u)
  const out = new Set<string>()
  for (const t of raw) {
    const w = t.replace(/^[./-]+|[./-]+$/g, '')
    if (w.length >= 3 && w.length <= 40 && !STOP.has(w)) out.add(w)
  }
  return out
}

/** Jaccard giữa 2 chuỗi token hóa — 0..1 */
export function jaccard(a: string, b: string): number {
  const A = tokenize(a)
  const B = tokenize(b)
  if (A.size === 0 || B.size === 0) return 0
  let inter = 0
  for (const x of A) if (B.has(x)) inter++
  return inter / (A.size + B.size - inter)
}

/** Posterior Laplace của hypothesis: (α+1)/(α+β+2) — MaxEnt khi α=β=0 */
export function posteriorOf(alpha: number, beta: number): number {
  return (alpha + 1) / (alpha + beta + 2)
}

/**
 * Chữ ký ngữ cảnh hiện hành — từ khóa mục tiêu (tần suất cao) + tên tools
 * đã dùng. Dùng làm contextSig khi truy hồi mẩu CoT (PC-neighborhood).
 */
export function computeContextSignature(goal: string, toolNames: string[]): string {
  const freq = new Map<string, number>()
  for (const w of tokenize(goal)) freq.set(w, (freq.get(w) || 0) + 1)
  const topGoal = [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(e => e[0])
  const tools = [...new Set(toolNames.map(t => t.toLowerCase()))].slice(0, 4)
  return [...new Set([...topGoal, ...tools])].join(' ')
}

/** Chuẩn hóa whitespace để so khớp trích dẫn bằng chứng */
function norm(s: string): string {
  return (s || '').toLowerCase().replace(/\s+/g, ' ').trim()
}

/**
 * Chuẩn hóa TÊN TOOL khi so khớp bằng chứng λ-verify (rà soát sau Task 21 —
 * E2E-2 lộ: agent trên đường CLI biết tool dưới tên `tmo_shell` nhưng evidence
 * của harness ghi tên ĐÃ RESOLVE `shell` → so khớp thất bại → phán quyết ĐÚNG
 * bị TỪ CHỐI oan). Chuẩn hóa cả 2 phía: strip prefix tmo_ + map alias native
 * (bash→shell, read→file_read...) — giống TOOL_NAME_ALIASES của executor.
 */
const EVIDENCE_TOOL_ALIASES: Record<string, string> = {
  bash: 'shell', sh: 'shell', read: 'file_read', write: 'file_write',
  edit: 'file_edit', multiedit: 'file_multi_edit', multi_edit: 'file_multi_edit',
  todowrite: 'todo_write', todoread: 'todo_read', glob: 'file_list', ls: 'file_list',
}
function normalizeEvidenceToolName(name: string): string {
  const n = (name || '').toLowerCase().trim()
  const stripped = n.startsWith('tmo_') ? n.slice(4) : n
  return EVIDENCE_TOOL_ALIASES[stripped] ?? EVIDENCE_TOOL_ALIASES[n] ?? stripped
}

/**
 * So khớp MỜ trích dẫn bằng chứng với text kết quả tool (thực tế result bị
 * cut 400 chars nên exact substring thường fail): ≥50% token (≥4 ký tự) của
 * quote xuất hiện trong result → khớp. Exact substring luôn thắng.
 */
function evidenceQuoteMatches(quote: string, resultText: string): boolean {
  const q = norm(quote)
  const r = norm(resultText)
  if (!q || !r) return false
  if (q.length >= 12 && r.includes(q.slice(0, Math.min(q.length, 60)))) return true
  const qTokens = [...tokenize(quote)].filter(t => t.length >= 4)
  if (qTokens.length === 0) return false
  let hit = 0
  for (const t of qTokens) if (r.includes(t)) hit++
  return hit / qTokens.length >= 0.5
}

// ==================== SHR — SINH / PARROT CHECK ====================

export interface ProposeHypothesisArgs {
  sessionId: string
  agentName?: string | null
  runId?: string | null
  contextSig: string
  intervention: string
  predictedDelta: string
  mechanicsClaim: string
  sourceCycle?: number | null
}

export interface ProposeHypothesisResult {
  ok: boolean
  error?: string
  /** created = mới sinh α=β=0 · duplicate = trùng cơ chế đã có · parrot = nghi vẹt */
  kind?: 'created' | 'duplicate' | 'parrot'
  id?: string
  posterior?: number
  note?: string
}

/**
 * Sinh hypothesis mới (α=β=0 — posterior 0.5 MaxEnt, B3). Parrot check trước
 * khi tạo: cơ chế trùng ≥0.9 mà ngữ cảnh lệch ≥0.5 → đánh dấu parrot_suspect
 * lên hypothesis CŨ (bài học vay sai chỗ), không tạo bản sao.
 */
export async function proposeHypothesis(args: ProposeHypothesisArgs): Promise<ProposeHypothesisResult> {
  try {
    if (!args.sessionId) return { ok: false, error: 'sessionId is required' }
    const mechanics = (args.mechanicsClaim || '').trim().slice(0, 200)
    const contextSig = (args.contextSig || '').trim().slice(0, 200)
    if (!mechanics || !contextSig) {
      return { ok: false, error: 'mechanicsClaim + contextSig bắt buộc (mechanicsClaim ≤ 12 từ — MỘT quan hệ nhân quả)' }
    }
    const alive = await db.structuredHypothesis.findMany({
      where: {
        // IMP-2 (F1 — điều tra Task F "hypothesis lặp 4× qua các spawn session"):
        // dedup mở rộng khỏi phạm vi 1 session — hypothesis_write thực thi trong
        // inner loop CLI có thể ghi vào session CỦA SPAWN (env TMO_SESSION_ID của
        // spawn / agent tự khai sessionId) nhưng vẫn mang sourceRunId của run
        // goal-loop → match chéo session CÙNG run: spawn sau propose lại nguyên
        // văn hypothesis spawn trước sẽ bị chặn ở đây. runId null (legacy/đường
        // không truyền) → giữ hành vi cũ (chỉ theo session).
        OR: [
          { sessionId: args.sessionId },
          ...(args.runId ? [{ sourceRunId: args.runId }] : []),
        ],
        status: { in: ['candidate', 'promoted', 'parrot_suspect'] },
      },
      select: { id: true, contextSig: true, mechanicsClaim: true, status: true },
    })
    for (const h of alive) {
      const mechSim = jaccard(mechanics, h.mechanicsClaim)
      if (mechSim >= SHR_CONSTANTS.PARROT_MECH_JACCARD) {
        // FIX (rà soát sau Task 21 — lộ nhờ test A4): duplicate-check ≥0.95 đặt
        // TRƯỚC parrot-check ≥0.9 → parrot không bao giờ kích hoạt (mọi cặp
        // trùng cơ chế ≥0.95 đều bị nuốt bởi nhánh duplicate). Thứ tự đúng:
        // parrot là điều kiện CỤ THỂ HƠN (cơ chế trùng ∧ ngữ cảnh LỆCH) →
        // kiểm tra TRƯỚC; chỉ khi ngữ cảnh còn khớp mới là duplicate thật.
        const ctxSim = jaccard(contextSig, h.contextSig)
        if (ctxSim <= 1 - SHR_CONSTANTS.PARROT_CTX_DISTANCE) {
          await db.structuredHypothesis.update({
            where: { id: h.id },
            data: { status: 'parrot_suspect' },
          }).catch(() => null)
          return {
            ok: true, kind: 'parrot', id: h.id,
            note: `Nghi vẹt (parrot_suspect): cơ chế trùng (${mechSim.toFixed(2)}) nhưng ngữ cảnh lệch — hypothesis cũ bị gắn cờ, cần test lại ở ngữ cảnh này`,
          }
        }
        if (mechSim >= 0.95) {
          return { ok: true, kind: 'duplicate', id: h.id, note: `Trùng hypothesis hiện có (Jaccard cơ chế ${mechSim.toFixed(2)}) — không tạo bản sao` }
        }
      }
    }
    const created = await db.structuredHypothesis.create({
      data: {
        sessionId: args.sessionId,
        agentName: args.agentName ?? null,
        sourceRunId: args.runId ?? null,
        contextSig,
        intervention: (args.intervention || '').slice(0, 400),
        predictedDelta: (args.predictedDelta || '').slice(0, 400),
        mechanicsClaim: mechanics,
        alpha: 0,
        beta: 0,
        status: 'candidate',
        sourceCycle: args.sourceCycle ?? null,
      },
    })
    return { ok: true, kind: 'created', id: created.id, posterior: 0.5, note: 'Đã sinh hypothesis (α=0, β=0 — posterior 0.5). Khi có bằng chứng tool xác nhận/bác → hypothesis_write op=judge' }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

// ==================== SHR — JUDGMENT (pending → verify cuối chu kỳ) ====================

export interface JudgeHypothesisArgs {
  sessionId: string
  hypothesisId: string
  /** confirmed (α+=1) | refuted (β+=1) */
  verdict: 'confirmed' | 'refuted'
  evidenceTool: string
  evidenceQuote: string
}

/**
 * GHI phán quyết PENDING — KHÔNG áp dụng ngay (λ-grounded). Harness gọi
 * verifyPendingJudgments cuối chu kỳ với bằng chứng tool thật; chỉ khi
 * evidenceTool chạy THÀNH CÔNG và evidenceQuote khớp kết quả → α/β cập nhật.
 */
export async function recordJudgment(args: JudgeHypothesisArgs): Promise<{ ok: boolean; error?: string; note?: string }> {
  try {
    if (!args.sessionId || !args.hypothesisId) return { ok: false, error: 'sessionId + hypothesisId bắt buộc' }
    if (args.verdict !== 'confirmed' && args.verdict !== 'refuted') {
      return { ok: false, error: 'verdict phải là "confirmed" hoặc "refuted"' }
    }
    if (!args.evidenceTool || !args.evidenceQuote) {
      return { ok: false, error: 'evidenceTool + evidenceQuote bắt buộc — phán quyết không có bằng chứng sẽ bị từ chối' }
    }
    const h = await db.structuredHypothesis.findFirst({
      where: { id: args.hypothesisId, sessionId: args.sessionId },
    })
    // FIX (rà soát sau Task 21): agent có thể trích id RÚT GỌN (UI/evidence
    // preview hiện 6 ký tự cuối — "id ab12cd") → exact match fail oan. Fallback:
    // nếu không tìm thấy id chính xác, thử suffix-match (id thật KẾT THÚC bằng
    // chuỗi agent đưa, ≥6 ký tự) trong CÙNG session — chỉ 1 kết quả duy nhất
    // mới chấp nhận (không mơ hồ).
    let hyp = h
    if (!hyp && args.hypothesisId.length >= 6 && args.hypothesisId.length < 20) {
      const suffixCandidates = await db.structuredHypothesis.findMany({
        where: { sessionId: args.sessionId, id: { endsWith: args.hypothesisId } },
      })
      if (suffixCandidates.length === 1) hyp = suffixCandidates[0]
    }
    if (!hyp) return { ok: false, error: `Hypothesis không tồn tại trong session: ${args.hypothesisId}` }
    if (hyp.status === 'demoted') return { ok: false, error: 'Hypothesis đã bị demote — không nhận phán quyết nữa' }
    await db.structuredHypothesis.update({
      where: { id: hyp.id },
      data: {
        pendingJudgment: JSON.stringify({
          verdict: args.verdict,
          evidenceTool: args.evidenceTool,
          evidenceQuote: args.evidenceQuote.slice(0, 400),
          judgedAt: new Date().toISOString(),
        }),
      },
    })
    return {
      ok: true,
      note: `Đã ghi nhận phán quyết "${args.verdict}" (chưa áp dụng). Cuối chu kỳ hệ thống đối chiếu: ${args.evidenceTool} phải có kết quả THÀNH CÔNG chứa trích dẫn — khớp thì α/β mới cập nhật (λ-grounded).`,
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

export interface CycleEvidenceEntry {
  tool: string
  success: boolean
  text: string
}

export interface VerifyJudgmentsResult {
  applied: Array<{ id: string; claim: string; verdict: string; alpha: number; beta: number; posterior: number }>
  rejected: Array<{ id: string; claim: string; reason: string }>
  promoted: Array<{ id: string; claim: string }>
  demoted: Array<{ id: string; claim: string }>
}

/**
 * VERIFY pending judgments cuối chu kỳ — đối chiếu bằng chứng tool THẬT:
 * evidenceTool phải có entry thành công trong cycleEvidence VÀ evidenceQuote
 * khớp (fuzzy) text kết quả. Khớp → α+=1/β+=1 + kiểm promote/demote. Không
 * khớp → TỪ CHỐI (xóa pending — chống agent tự xác nhận không bằng chứng).
 */
export async function verifyPendingJudgments(
  sessionId: string,
  cycleEvidence: CycleEvidenceEntry[],
  /**
   * IMP-2 (F1): runId của run goal-loop — kèm cả hypothesis của run này từ
   * session SPAWN (sourceRunId khớp) để phán quyết pending không bị bỏ sót chỉ
   * vì được ghi từ session khác. Không truyền → hành vi cũ (chỉ theo session).
   */
  runId?: string | null,
): Promise<VerifyJudgmentsResult> {
  const result: VerifyJudgmentsResult = { applied: [], rejected: [], promoted: [], demoted: [] }
  try {
    if (!sessionId) return result
    const pending = await db.structuredHypothesis.findMany({
      where: {
        OR: [
          { sessionId },
          ...(runId ? [{ sourceRunId: runId }] : []),
        ],
        pendingJudgment: { not: null },
        status: { in: ['candidate', 'promoted', 'parrot_suspect'] },
      },
    })
    const okEvidence = cycleEvidence.filter(e => e.success)
    for (const h of pending) {
      let judgment: { verdict: string; evidenceTool: string; evidenceQuote: string } | null = null
      try { judgment = JSON.parse(h.pendingJudgment as string) } catch { judgment = null }
      if (!judgment) {
        await db.structuredHypothesis.update({ where: { id: h.id }, data: { pendingJudgment: null } }).catch(() => null)
        continue
      }
      // λ-check: tool phải chạy thành công + quote khớp kết quả.
      // FIX tên tool: so khớp SAU KHI chuẩn hóa 2 phía (tmo_shell ≡ shell ≡ bash;
      // agent trích tên CLI, evidence ghi tên TMO resolve — đều hợp lệ).
      const jt = normalizeEvidenceToolName(judgment.evidenceTool)
      const candidates = judgment.evidenceTool
        ? okEvidence.filter(e => normalizeEvidenceToolName(e.tool) === jt)
        : okEvidence
      const matched = candidates.some(e => evidenceQuoteMatches(judgment!.evidenceQuote, e.text))
      if (!matched) {
        await db.structuredHypothesis.update({ where: { id: h.id }, data: { pendingJudgment: null } }).catch(() => null)
        result.rejected.push({
          id: h.id, claim: h.mechanicsClaim,
          reason: `không tìm thấy bằng chứng: ${judgment.evidenceTool} không có kết quả thành công khớp trích dẫn "${judgment.evidenceQuote.slice(0, 60)}"`,
        })
        continue
      }
      const alpha = h.alpha + (judgment.verdict === 'confirmed' ? 1 : 0)
      const beta = h.beta + (judgment.verdict === 'refuted' ? 1 : 0)
      const posterior = posteriorOf(alpha, beta)
      // Vòng đời đóng băng bằng công thức (§2)
      let status = h.status
      if (posterior >= SHR_CONSTANTS.PROMOTE_POSTERIOR && alpha + beta >= SHR_CONSTANTS.PROMOTE_MIN_OBS) {
        status = 'promoted'
        result.promoted.push({ id: h.id, claim: h.mechanicsClaim })
      } else if (posterior <= SHR_CONSTANTS.DEMOTE_POSTERIOR && alpha + beta >= SHR_CONSTANTS.DEMOTE_MIN_OBS) {
        status = 'demoted'
        result.demoted.push({ id: h.id, claim: h.mechanicsClaim })
      } else if (h.status === 'parrot_suspect' && judgment.verdict === 'refuted') {
        // parrot nghi vẹt được test lại mà trùng/refute → về candidate để theo dõi
        status = 'candidate'
      }
      await db.structuredHypothesis.update({
        where: { id: h.id },
        data: { alpha, beta, status, pendingJudgment: null },
      }).catch(() => null)
      result.applied.push({ id: h.id, claim: h.mechanicsClaim, verdict: judgment.verdict, alpha, beta, posterior })
    }
    return result
  } catch {
    return result // fail-open tuyệt đối
  }
}

// ==================== IMP-2 (F1) — MIRROR hypothesis_write TỪ SPAWN CLI ====================

/**
 * IMP-2 (F1 — điều tra Task F "hypothesis lặp 4× qua 4 session spawn"): goal-loop
 * CLI mỗi vòng spawn process riêng — hypothesis_write thực thi trong inner loop
 * CLI có thể ghi vào session CỦA SPAWN (env TMO_SESSION_ID của spawn / agent tự
 * khai sessionId) thay vì session goal-loop → (a) dedup per-session của spawn
 * sau KHÔNG thấy hypothesis spawn trước (propose lại NGUYÊN VĂN), (b)
 * renderBeliefState(session goal-loop) KHÔNG bao giờ thấy → belief-state trống.
 * Giải pháp mirror theo pattern TASK 20 của todo (goal-loop đã làm cho todo ở
 * block mirror executedCalls — giờ hypothesis được mirror tương tự):
 *   - op=propose → gọi proposeHypothesis với session goal-loop (idempotent:
 *     dedup — đã mở rộng match chéo sourceRunId — trả 'duplicate' khi spawn ghi
 *     đúng session sẵn; 'created' = bản sao goal-loop thật sự được tạo).
 *   - op=judge → hypothesisId nhắm row của session SPAWN (id globally unique —
 *     findUnique được): tìm "anh sinh đôi" trong session goal-loop theo
 *     mechanicsClaim (Jaccard ≥ PARROT_MECH_JACCARD, khớp TỐT NHẤT) rồi ghi
 *     phán quyết pending lên bản sao (verifyPendingJudgments cuối chu kỳ đối
 *     chiếu bằng chứng như thường).
 * Toàn bộ fail-open — mirror KHÔNG BAO GIỜ làm hỏng vòng lặp.
 */
export async function mirrorSpawnHypothesis(params: {
  goalSessionId: string
  runId: string | null
  agentName?: string | null
  op: string
  args: Record<string, unknown>
}): Promise<{ mirrored: boolean; note?: string }> {
  try {
    if (!params.goalSessionId) return { mirrored: false }
    if (params.op === 'propose') {
      const mechanicsClaim = typeof params.args.mechanicsClaim === 'string' ? params.args.mechanicsClaim : ''
      const contextSig = typeof params.args.contextSig === 'string' ? params.args.contextSig : ''
      if (!mechanicsClaim.trim() || !contextSig.trim()) return { mirrored: false }
      const res = await proposeHypothesis({
        sessionId: params.goalSessionId,
        agentName: params.agentName ?? null,
        runId: params.runId,
        contextSig,
        intervention: typeof params.args.intervention === 'string' ? params.args.intervention : '',
        predictedDelta: typeof params.args.predictedDelta === 'string' ? params.args.predictedDelta : '',
        mechanicsClaim,
        sourceCycle: typeof params.args.sourceCycle === 'number' ? params.args.sourceCycle : null,
      })
      // mirrored=true CHỈ khi thật sự tạo bản sao trong session goal-loop
      // ('created'); 'duplicate'/'parrot' = đã có / đã xử lý ở dedup — im lặng.
      return { mirrored: res.ok && res.kind === 'created', note: res.note }
    }
    if (params.op === 'judge') {
      const hypothesisId = typeof params.args.hypothesisId === 'string' ? params.args.hypothesisId : ''
      const evidenceTool = typeof params.args.evidenceTool === 'string' ? params.args.evidenceTool : ''
      const evidenceQuote = typeof params.args.evidenceQuote === 'string' ? params.args.evidenceQuote : ''
      if (!hypothesisId || !evidenceTool || !evidenceQuote) return { mirrored: false }
      const src = await db.structuredHypothesis.findUnique({ where: { id: hypothesisId } }).catch(() => null)
      // id đã thuộc session goal-loop (đường phổ biến — spawn ghi đúng session)
      // → không cần mirror.
      if (!src || src.sessionId === params.goalSessionId) return { mirrored: false }
      const twins = await db.structuredHypothesis.findMany({
        where: { sessionId: params.goalSessionId, status: { in: ['candidate', 'promoted', 'parrot_suspect'] } },
        select: { id: true, mechanicsClaim: true },
        take: 60,
      })
      let bestId: string | null = null
      let bestSim = 0
      for (const tw of twins) {
        const sim = jaccard(src.mechanicsClaim, tw.mechanicsClaim)
        if (sim > bestSim) { bestSim = sim; bestId = tw.id }
      }
      if (!bestId || bestSim < SHR_CONSTANTS.PARROT_MECH_JACCARD) return { mirrored: false }
      const res = await recordJudgment({
        sessionId: params.goalSessionId,
        hypothesisId: bestId,
        verdict: params.args.verdict === 'refuted' ? 'refuted' : 'confirmed',
        evidenceTool,
        evidenceQuote,
      })
      return { mirrored: res.ok, note: res.note }
    }
    return { mirrored: false } // op=list / op lạ — không có gì để mirror
  } catch {
    return { mirrored: false } // fail-open — mirror không được phép crash loop
  }
}

// ==================== BELIEF-STATE RENDER (R2 nén xuống R1 — π-channel) ====================

/**
 * Render belief-state ≤ ~60 từ cho directive chu kỳ sau (bước 0 ABDUCTION —
 * trước khi hành động, agent thấy hypothesis sống + đã bác). Promoted đứng
 * đầu (bài học đã trả tiền), candidate posterior cao kế tiếp, demoted nêu tên.
 */
export async function renderBeliefState(sessionId: string, runId?: string | null): Promise<string> {
  try {
    if (!sessionId) return ''
    const all = await db.structuredHypothesis.findMany({
      where: {
        // IMP-2 (F1 — điều tra Task F): kèm hypothesis của run hiện hành từ MỌI
        // session — goal-loop CLI mỗi vòng spawn process riêng, hypothesis có
        // thể ghi theo session spawn (sourceRunId vẫn trỏ về run goal-loop).
        // Trước đây query chỉ theo sessionId goal-loop → hypothesis của spawn
        // KHÔNG bao giờ được render → belief-state trống, spawn sau đề xuất lại
        // từ đầu (đúng gap TASK 20 đã fix cho todo nhưng hypothesis chưa có).
        OR: [
          { sessionId },
          ...(runId ? [{ sourceRunId: runId }] : []),
        ],
        status: { in: ['candidate', 'promoted', 'demoted'] },
      },
      orderBy: { updatedAt: 'desc' },
      take: 120,
    })
    if (all.length === 0) return ''
    const promoted = all.filter(h => h.status === 'promoted').slice(0, 3)
    const candidates = all
      .filter(h => h.status === 'candidate')
      .map(h => ({ h, p: posteriorOf(h.alpha, h.beta) }))
      .sort((a, b) => b.p - a.p)
      .slice(0, 3)
    const demoted = all.filter(h => h.status === 'demoted').slice(0, 2)
    if (promoted.length === 0 && candidates.length === 0 && demoted.length === 0) return ''
    const lines: string[] = []
    if (promoted.length > 0) {
      lines.push(`🧬 BELIEF-STATE các chu kỳ trước (π — CHỈ tin khi bằng chứng mới xác nhận lại):`)
      for (const h of promoted) {
        lines.push(`- [KHẲNG ĐỊNH ${h.alpha}/${h.beta} đúng/sai] ${h.mechanicsClaim} (ctx: ${h.contextSig.split(' ').slice(0, 4).join(',')})`)
      }
    }
    if (candidates.length > 0) {
      if (lines.length === 0) lines.push(`🧬 BELIEF-STATE các chu kỳ trước (π — CHỈ tin khi bằng chứng mới xác nhận lại):`)
      for (const { h, p } of candidates) {
        lines.push(`- [Chưa chắc ${h.alpha}/${h.beta}] ${h.mechanicsClaim} (p=${p.toFixed(2)})`)
      }
    }
    if (demoted.length > 0) {
      lines.push(`Đã bác: ${demoted.map(h => h.mechanicsClaim.split(' ').slice(0, 6).join(' ')).join(' · ')}`)
    }
    if (lines.length === 0) return ''
    // Đánh dấu lần render gần nhất (dữ liệu cho parrot/audit sau)
    await db.structuredHypothesis.updateMany({
      where: { id: { in: [...promoted.map(h => h.id), ...candidates.map(c => c.h.id)] } },
      data: { lastRenderedAt: new Date() },
    }).catch(() => null)
    return '\n\n' + lines.join('\n')
  } catch {
    return '' // fail-open
  }
}

// ==================== KHO MẨU CoT — NÉN / TRUY HỒI / KRAFT / CHUỖI ====================

export interface CotCompressionArgs {
  sessionId: string
  agentName?: string | null
  /** báo cáo cuối chu kỳ của agent (chứa dòng ✅/❓ REFLECT) */
  report: string
  contextSig: string
  /** posterior gắn với mẩu: confidence của evaluator chu kỳ này */
  posterior: number
  /** mẫu cha (mẩu được truy hồi chu kỳ này) — chuỗi nguồn gốc */
  parentSampleId?: string | null
  /** cơ chế hay nhất của chu kỳ (mechanicsClaim hypothesis) — null thì suy từ ✅ */
  bestMechanics?: string | null
}

export interface CotCompressionResult {
  created: boolean
  id?: string
  reason?: string
}

/** Trích dòng ✅ (đã chắc chắn) và ❓ (còn chưa chắc) từ báo cáo REFLECT */
function extractReflectLines(report: string): { established: string; uncertain: string } {
  const text = report || ''
  const okMatch = text.match(/✅[^:\n]*:\s*(.+)/)
  const uncertainMatch = text.match(/❓[^:\n]*:\s*(.+)/)
  const established = okMatch ? okMatch[1].trim().slice(0, 220) : ''
  // fallback: câu đầu của báo cáo nếu không có dòng ✅
  const fallback = text.split(/\n+/).map(l => l.trim()).find(l => l.length > 30) || ''
  const uncertain = uncertainMatch ? uncertainMatch[1].trim().slice(0, 160) : ''
  return { established: established || fallback.slice(0, 200), uncertain }
}

/**
 * Nén báo cáo chu kỳ thành mẩu 200-400 ký tự (MDL — giữ DỰ ĐOÁN ĐƯỢC: cơ chế
 * + kết luận, bỏ diễn giải từng bước). Nén tại chỗ — KHÔNG gọi model thêm.
 * Kraft: đầy 64 mẩu → xóa mẩu posterior thấp nhất × lâu chưa truy hồi nhất.
 * Chuỗi: parent thế hệ 3 = tail → không sinh thế hệ 4. Drift: Jaccard(con,
 * gốc chuỗi) < 0.4 → mẩu mới bị đánh dấu drifted (cấm tái dùng nhánh).
 */
export async function compressCycleToSample(args: CotCompressionArgs): Promise<CotCompressionResult> {
  try {
    if (!args.sessionId || !args.report || args.report.trim().length < 40) {
      return { created: false, reason: 'báo cáo quá ngắn / thiếu dữ liệu nén' }
    }
    const reflect = extractReflectLines(args.report)
    const mechanics = (args.bestMechanics || reflect.established).slice(0, 140)
    if (!mechanics.trim()) return { created: false, reason: 'không trích được cơ chế/kết luận' }
    const ctx = (args.contextSig || '').slice(0, 60)

    // Chuỗi nguồn gốc — cap 3 thế hệ (union bound)
    let generation = 1
    let parentRef: string | null = null
    if (args.parentSampleId) {
      const parent = await db.cotSample.findUnique({ where: { id: args.parentSampleId } }).catch(() => null)
      if (parent && parent.sessionId === args.sessionId && !parent.drifted) {
        if (parent.generation >= SHR_CONSTANTS.COT_CHAIN_DEPTH) {
          return { created: false, reason: `mẫu cha thế hệ ${parent.generation} = tail — không sinh thế hệ ${parent.generation + 1} (chống sai lệch tích luỹ)` }
        }
        generation = parent.generation + 1
        parentRef = parent.id
        // Drift check — đi về GỐC chuỗi, so con vs gốc
        let root = parent
        let hops = 0
        while (root.parentRef && hops < SHR_CONSTANTS.COT_CHAIN_DEPTH) {
          const up = await db.cotSample.findUnique({ where: { id: root.parentRef } }).catch(() => null)
          if (!up) break
          root = up
          hops++
        }
        const driftSim = jaccard(`${ctx} ${mechanics}`, `${root.contextSig} ${root.mechanics}`)
        if (driftSim < SHR_CONSTANTS.COT_DRIFT_THRESHOLD) {
          // vẫn ghi lại để audit nhưng drifted=true → cấm tái dùng + cấm làm cha
          const sampleText = `[drifted gen${generation} | ctx: ${ctx} | mech: ${mechanics} | concl: ${reflect.established.slice(0, 120)}]`
          await db.cotSample.create({
            data: {
              sessionId: args.sessionId, agentName: args.agentName ?? null,
              contextSig: ctx, mechanics, conclusion: reflect.established.slice(0, 220),
              sampleText: sampleText.slice(0, 420), generation, parentRef,
              posterior: Math.max(0, Math.min(1, args.posterior)), drifted: true,
            },
          }).catch(() => null)
          return { created: false, reason: `drift: Jaccard(con, gốc chuỗi)=${driftSim.toFixed(2)} < ${SHR_CONSTANTS.COT_DRIFT_THRESHOLD} — nhánh bị cấm tái dùng` }
        }
      }
    }

    // Kraft budget — đầy thì xóa mẩu KÉM NHẤT (posterior thấp nhất, lâu chưa truy hồi nhất).
    // FIX (rà soát sau Task 21): mọi mẫu đều drifted → findFirst(where drifted:false)
    // trả null → KHÔNG xóa → vượt budget. Giờ fallback xóa tồi nhất trong TẤT CẢ
    // (kể cả drifted — drifted chỉ cấm truy hồi/làm cha, vẫn xóa được khi cần chỗ).
    const count = await db.cotSample.count({ where: { sessionId: args.sessionId } })
    if (count >= SHR_CONSTANTS.COT_BUDGET) {
      let worst = await db.cotSample.findFirst({
        where: { sessionId: args.sessionId, drifted: false },
        orderBy: [{ posterior: 'asc' }, { lastRetrievedAt: 'asc' }, { hitCount: 'asc' }],
      })
      if (!worst) {
        worst = await db.cotSample.findFirst({
          where: { sessionId: args.sessionId },
          orderBy: [{ posterior: 'asc' }, { lastRetrievedAt: 'asc' }, { hitCount: 'asc' }],
        })
      }
      if (worst) await db.cotSample.delete({ where: { id: worst.id } }).catch(() => null)
    }

    const conf = Math.max(0, Math.min(1, args.posterior))
    const sampleText = `[gen${generation} | ctx: ${ctx} | mech: ${mechanics} | concl: ${reflect.established.slice(0, 150)}${reflect.uncertain ? ` | open: ${reflect.uncertain.slice(0, 80)}` : ''} | conf: ${conf.toFixed(2)}]`
    const created = await db.cotSample.create({
      data: {
        sessionId: args.sessionId, agentName: args.agentName ?? null,
        contextSig: ctx, mechanics, conclusion: reflect.established.slice(0, 220),
        sampleText: sampleText.slice(0, 420), generation, parentRef,
        posterior: conf, drifted: false,
      },
    })
    // Liên kết ngược: hypothesis khớp cơ chế nhận cotRef (mối nối trụ cột 2↔3)
    if (mechanics.length > 10) {
      const alive = await db.structuredHypothesis.findMany({
        where: { sessionId: args.sessionId, status: { in: ['candidate', 'promoted'] } },
        select: { id: true, mechanicsClaim: true },
      })
      let bestId: string | null = null
      let bestSim = 0
      for (const h of alive) {
        const sim = jaccard(mechanics, h.mechanicsClaim)
        if (sim > bestSim) { bestSim = sim; bestId = h.id }
      }
      if (bestId && bestSim >= 0.5) {
        await db.structuredHypothesis.update({ where: { id: bestId }, data: { cotRef: created.id } }).catch(() => null)
      }
    }
    return { created: true, id: created.id }
  } catch (err) {
    return { created: false, reason: err instanceof Error ? err.message : String(err) }
  }
}

export interface PriorReasoningResult {
  block: string
  /** id mẩu khớp — mẩu tốt nhất làm CHA cho mẩu chu kỳ này (chuỗi nguồn gốc) */
  parentSampleId: string | null
  matchedCount: number
}

/**
 * Truy hồi mẩu CoT theo chữ ký ngữ cảnh (Jaccard ≥ 0.5) — nạp tối đa 2 mẩu
 * posterior cao nhất dưới nhãn "may be wrong, verify" (mẩu là prior KHÔNG
 * phải chân lý — chống parrot, B18). Cập nhật hitCount + lastRetrievedAt.
 */
export async function buildPriorReasoningBlock(sessionId: string, contextSig: string): Promise<PriorReasoningResult> {
  try {
    if (!sessionId || !contextSig) return { block: '', parentSampleId: null, matchedCount: 0 }
    const samples = await db.cotSample.findMany({
      where: { sessionId, drifted: false },
      orderBy: { posterior: 'desc' },
      take: 100,
    })
    if (samples.length === 0) return { block: '', parentSampleId: null, matchedCount: 0 }
    const scored = samples
      .map(s => ({ s, sim: jaccard(contextSig, s.contextSig) }))
      .filter(x => x.sim >= SHR_CONSTANTS.COT_MATCH_THRESHOLD)
      .sort((a, b) => b.s.posterior - a.s.posterior || b.sim - a.sim)
      .slice(0, SHR_CONSTANTS.COT_MAX_RETRIEVE)
    if (scored.length === 0) return { block: '', parentSampleId: null, matchedCount: 0 }
    // Cập nhật thống kê truy hồi (LRU cho eviction sau này)
    await db.cotSample.updateMany({
      where: { id: { in: scored.map(x => x.s.id) } },
      data: { hitCount: { increment: 1 }, lastRetrievedAt: new Date() },
    }).catch(() => null)
    const lines = scored.map(x => `- ${x.s.sampleText}`)
    const block = `\n\n🧠 Prior reasoning (may be wrong, verify) — mẩu suy luận run trước khớp ngữ cảnh (prior KHÔNG phải chân lý — kiểm chứng lại bằng tool):\n${lines.join('\n')}`
    return { block, parentSampleId: scored[0].s.id, matchedCount: scored.length }
  } catch {
    return { block: '', parentSampleId: null, matchedCount: 0 } // fail-open
  }
}

// ==================== RUN CONTEXT — biên độ dữ liệu xuyên chu kỳ (Task 21-c) ====================

/**
 * Parse khối "📐 BIÊN ĐỘ DỮ LIỆU: ..." từ báo cáo agent. Agent viết ở GĐ0(c)
 * và chốt lại trong báo cáo GĐ3 (protocol yêu cầu) — harness trích xuất.
 *
 * FIX 2026-10-22 (lộ E2E todo-coverage): quét TẤT CẢ khối 📐 trong text và
 * ƯU TIÊN khối CÓ marker phạm vi ("cần đọc"/"ngoài phạm vi"...) — khối 📐
 * thật theo protocol luôn có marker. Trước đây regex lấy match ĐẦU TIÊN →
 * khi agent NHẮC TỚI "📐 BIÊN ĐỘ DỮ LIỆU" trong nội dung todo/báo cáo
 * trung gian (không phải khối 📐), parser nhặt nhầm đoạn đó (E2E thực tế:
 * dataScope bị stash từ nội dung todo "[Nghiệm thu 4] Báo cáo cuối với 📐
 * BIÊN ĐỘ DỮ LIỆU + ✅/❓" thay vì khối 📐 thật cuối báo cáo).
 */
const DATA_SCOPE_MARKER_RE = /(cần\s*đọc|cần\s*kiểm\s*tra|ngoài\s*phạm\s*vi|ngoại\s*phạm\s*vi|out\s*of\s*scope)/i

/** Khối 📐 hợp lệ về hình thức: có marker phạm vi (dùng gate khi stash —
 *  chống nhặt nhầm đoạn text chỉ NHẮC TỚI 📐). */
export function looksLikeDataScope(scope: string | null | undefined): boolean {
  if (!scope) return false
  return DATA_SCOPE_MARKER_RE.test(scope)
}

export function parseDataScopeBlock(report: string): string | null {
  if (!report) return null
  // (1) Quét mọi khối "📐 BIÊN ĐỘ DỮ LIỆU ..." — ưu tiên khối có marker
  const re = /📐\s*BIÊN\s*ĐỘ\s*DỮ\s*LIỆU\s*:?\s*([\s\S]{10,700}?)(?=\n\s*\n|\n[✅❓📋🎯🔍⚖️🧬]|$)/gi
  let first: string | null = null
  let m: RegExpExecArray | null
  while ((m = re.exec(report)) !== null) {
    const scope = m[1].replace(/\s+/g, ' ').trim()
    if (scope.length < 10) continue
    const capped = scope.slice(0, 500)
    if (!first) first = capped
    if (DATA_SCOPE_MARKER_RE.test(capped)) return capped // khối 📐 thật (có marker)
  }
  if (first) return first // không khối nào có marker → giữ match đầu (hành vi cũ)
  // (2) Fallback lỏng: dòng có chữ "biên độ" + 4 dòng kế
  const lines = report.split('\n')
  const idx = lines.findIndex(l => /biên\s*độ\s*dữ\s*liệu/i.test(l))
  if (idx >= 0) {
    const scope = lines.slice(idx, idx + 5).join(' ').replace(/\s+/g, ' ').trim()
    if (scope.length >= 10) return scope.slice(0, 500)
  }
  return null
}

export async function upsertRunContext(params: {
  runId: string
  sessionId: string
  dataScope?: string | null
  goalDigest?: string | null
  contextKeywords?: string | null
  /** TODO-COVERAGE: JSON array string tiêu chí nghiệm thu (extractDirectiveSpec
   *  lúc run START) — preserve-on-null như các field khác (end-of-cycle upsert
   *  không truyền → không đè giá trị đã stash từ đầu run). */
  acceptanceCriteria?: string | null
  /** UNCERTAINTY LEDGER: JSON array string [{text, firstSeenCycle}] — mục ❓
   *  của chu kỳ (đã merge aging). Preserve-on-null tương tự. */
  uncertainItems?: string | null
}): Promise<void> {
  try {
    if (!params.runId || !params.sessionId) return
    const data: Record<string, string | null | Date> = { updatedAt: new Date() }
    if (params.dataScope) data.dataScope = params.dataScope
    if (params.goalDigest) data.goalDigest = params.goalDigest
    if (params.contextKeywords) data.contextKeywords = params.contextKeywords
    if (params.acceptanceCriteria) data.acceptanceCriteria = params.acceptanceCriteria
    if (params.uncertainItems) data.uncertainItems = params.uncertainItems
    await db.runContext.upsert({
      where: { runId: params.runId },
      create: {
        runId: params.runId, sessionId: params.sessionId,
        dataScope: params.dataScope ?? null,
        goalDigest: params.goalDigest ?? null,
        contextKeywords: params.contextKeywords ?? null,
        acceptanceCriteria: params.acceptanceCriteria ?? null,
        uncertainItems: params.uncertainItems ?? null,
      },
      update: data,
    })
  } catch { /* fail-open */ }
}

/** Đọc RunContext — trả null nếu chưa có (chu kỳ 1 chưa xong) */
export async function getRunContext(runId: string): Promise<{ dataScope: string | null; goalDigest: string | null; contextKeywords: string | null; acceptanceCriteria: string | null; uncertainItems: string | null } | null> {
  try {
    if (!runId) return null
    const rc = await db.runContext.findUnique({ where: { runId } })
    if (!rc) return null
    return { dataScope: rc.dataScope, goalDigest: rc.goalDigest, contextKeywords: rc.contextKeywords, acceptanceCriteria: rc.acceptanceCriteria, uncertainItems: rc.uncertainItems }
  } catch {
    return null
  }
}

// ==================== UNCERTAINTY LEDGER — phản chiếu là năng lực TRONG QUY TRÌNH (2026-10-22) ====================
//
// User directive: "xác định biên độ dữ liệu và tự phản chiếu là năng lực nằm
// trong quy trình xử lý chứ không phải ở trong 1 báo cáo nghiệm thu nào hết".
// 📐 đã là năng lực trong quy trình (parse → RunContext → render lại → coverage).
// Giờ phản chiếu được cùng xử lý: dòng ❓ "Còn CHƯA CHẮC" KHÔNG chỉ là chữ trong
// báo cáo — harness trích thành ledger sống theo run, re-render directive chu
// kỳ sau (như 📐), mục treo ≥2 chu kỳ bị nhắc ưu tiên (chống "phản chiếu cho
// đẹp" rồi quên). Cùng họ λ-GROUNDED: không tin tự khai — theo dõi deterministic.

/** 1 mục trong ledger ❓ */
export interface UncertainItem {
  text: string
  /** chu kỳ đầu tiên mục này xuất hiện (aging ≥2 chu kỳ → cảnh báo) */
  firstSeenCycle: number
}

/** Số mục ❓ tối đa trong ledger (chống phình directive) */
export const UNCERTAIN_LEDGER_MAX = 3
/** Jaccard ≥ ngưỡng này giữa mục mới ↔ mục cũ = CÙNG một điều chưa chắc */
export const UNCERTAIN_MATCH_JACCARD = 0.55

/**
 * Trích các mục ❓ "còn chưa chắc" từ báo cáo chu kỳ. Ưu tiên dòng có chữ
 * "chưa chắc" (protocol GĐ3) — chống nhặt nhầm ❓ xuất hiện rải rác trong văn
 * bản khác (BELIEF-STATE, todo...). Tách mục theo dấu ; / · / " - ". Trả về
 * tối đa UNCERTAIN_LEDGER_MAX mục, mỗi mục ≤200 ký tự.
 */
export function parseUncertainItems(report: string): string[] {
  if (!report) return []
  const lines = report.split('\n')
  // (1) dòng ❓ có chữ "chưa chắc" (dòng REFLECT đúng protocol) — ưu tiên
  const preferred: string[] = []
  const rest: string[] = []
  for (const line of lines) {
    const m = line.match(/❓[^:\n]{0,80}:\s*(.+)/)
    if (!m) continue
    if (/chưa\s*chắc/i.test(line) || /còn\s*chưa/i.test(line)) preferred.push(m[1])
    else rest.push(m[1])
  }
  const pool = preferred.length > 0 ? preferred : rest.slice(0, 1)
  // (2) tách mục: "; " / " · " / " - " (mục dài chứa "," tiếng Việt — không tách theo ",")
  const items: string[] = []
  for (const raw of pool) {
    for (const part of raw.split(/\s*[;·]\s*|\s+-\s+/)) {
      const t = part.trim().slice(0, 200)
      if (t.length >= 8) items.push(t)
      if (items.length >= UNCERTAIN_LEDGER_MAX) return items
    }
  }
  return items
}

/**
 * Merge mục ❓ mới với ledger cũ — mục trùng (Jaccard ≥ UNCERTAIN_MATCH_JACCARD)
 * giữ firstSeenCycle gốc (aging), mục mới nhận firstSeenCycle = chu kỳ hiện tại.
 * Pure function (test được) — caller chịu trách nhiệm persist.
 */
export function mergeUncertainLedger(
  prevJson: string | null | undefined,
  newItems: string[],
  cycle: number,
): string {
  let prev: UncertainItem[] = []
  if (prevJson) {
    try {
      const parsed = JSON.parse(prevJson) as unknown
      if (Array.isArray(parsed)) {
        prev = parsed
          .filter((x): x is UncertainItem => !!x && typeof (x as UncertainItem).text === 'string')
          .map(x => ({ text: String(x.text).slice(0, 200), firstSeenCycle: Number(x.firstSeenCycle) || cycle }))
          .slice(0, UNCERTAIN_LEDGER_MAX)
      }
    } catch { /* JSON hỏng → coi như ledger trống */ }
  }
  const merged: UncertainItem[] = newItems.slice(0, UNCERTAIN_LEDGER_MAX).map(text => {
    // mục mới trùng mục cũ → KẾ THỪA firstSeenCycle (đây chính là aging)
    let firstSeen = cycle
    for (const p of prev) {
      if (jaccard(text, p.text) >= UNCERTAIN_MATCH_JACCARD) {
        firstSeen = Math.min(p.firstSeenCycle, cycle)
        break
      }
    }
    return { text, firstSeenCycle: firstSeen }
  })
  return JSON.stringify(merged)
}

/**
 * Render block directive từ ledger ❓ — chu kỳ sau THẤY các giả thuyết chưa
 * kiểm chứng + tuổi của chúng (≥2 chu kỳ → nhắc ưu tiên xử lý). Trả '' khi
 * ledger rỗng/hỏng (fail-open).
 */
export function renderUncertainLedgerBlock(uncertainItemsJson: string | null | undefined, currentCycle: number): string {
  if (!uncertainItemsJson) return ''
  try {
    const parsed = JSON.parse(uncertainItemsJson) as unknown
    if (!Array.isArray(parsed) || parsed.length === 0) return ''
    const items = parsed
      .filter((x): x is UncertainItem => !!x && typeof (x as UncertainItem).text === 'string')
      .slice(0, UNCERTAIN_LEDGER_MAX)
    if (items.length === 0) return ''
    const lines = items.map(it => {
      const age = currentCycle - (Number(it.firstSeenCycle) || currentCycle)
      return `- ${it.text}${age >= 1 ? ` (chưa kiểm chứng từ chu kỳ ${it.firstSeenCycle}${age >= 2 ? ' — ⚠️ treo ≥2 chu kỳ: ƯU TIÊN kiểm định bằng tool hoặc bác bỏ ngay chu kỳ này' : ''})` : ''}`
    })
    return `\n\n❓ CÒN CHƯA CHẮC (tự phản chiếu chu kỳ trước — giả thuyết CHƯA kiểm chứng, KHÔNG dùng làm tiền đề kết luận; ưu tiên kiểm định bằng tool hoặc bác bỏ và bỏ khỏi danh sách):\n${lines.join('\n')}`
  } catch {
    return ''
  }
}

// ==================== LIST (cho tool op=list) ====================

export async function listHypotheses(sessionId: string, status?: string): Promise<Array<{
  id: string; mechanicsClaim: string; contextSig: string; predictedDelta: string
  status: string; alpha: number; beta: number; posterior: number; cotRef: string | null
}>> {
  try {
    const where: { sessionId: string; status?: string } = { sessionId }
    if (status) where.status = status
    const rows = await db.structuredHypothesis.findMany({
      where,
      orderBy: { updatedAt: 'desc' },
      take: 30,
    })
    return rows.map(h => ({
      id: h.id, mechanicsClaim: h.mechanicsClaim, contextSig: h.contextSig,
      predictedDelta: h.predictedDelta, status: h.status, alpha: h.alpha, beta: h.beta,
      posterior: posteriorOf(h.alpha, h.beta), cotRef: h.cotRef,
    }))
  } catch {
    return []
  }
}
