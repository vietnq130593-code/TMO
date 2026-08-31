/**
 * OPUS (Task 13-b) — DOSSIER BUILDER (giao thức đọc 5 tầng §III)
 * ============================================================
 *
 * buildOpusDossier(sessionId, messageId?) — dựng hồ sơ review có GIÁM SÁT
 * (mọi section đều có cap ký tự — KHÔNG dump vô hạn vào prompt LLM):
 *
 *   §1. YÊU CẦU GỐC         — user message ĐẦU TIÊN của session mà metadata
 *                             KHÔNG chứa opusDirective (chân lý để re-anchor,
 *                             đọc nguyên văn, cap 4000 chars)
 *   §2. LỊCH SỬ HỘI THOẠI   — 30 tin gần nhất (cap 1500/tin, đánh số + role +
 *                             thời gian); tin opusDirective chỉ còn 1 dòng
 *                             "[Opus directive #N: <goal>]"
 *   §3. THOUGHT PROGRESS    — AgentRunRecord 10 run gần nhất (KHÔNG tính run
 *                             review của chính Opus) + goalLoop metadata của
 *                             assistant messages + đánh dấu RUN ĐANG REVIEW.
 *                             Tổng cap 25000 — tràn thì run mới giữ nguyên chi
 *                             tiết, run cũ còn 1 dòng tóm tắt
 *   §4. KẾT QUẢ CUỐI        — assistant message theo messageId param (nếu là
 *                             assistant message hợp lệ) else tin cuối cùng —
 *                             nguyên văn cap 8000
 *   §5. BẰNG CHỨNG KIỂM ĐỊNH — metadata máy (toolCalls/confidence/testResults)
 *                             + tổng hợp AgentRunRecord + 5 vòng Opus review
 *                             trước đó (tiến trình). Cap 6000. Trống → ghi rõ
 *                             "KHÔNG có bằng chứng kiểm định máy nào..."
 *   §6. ISSUE LEDGER ĐANG MỞ — getOpenIssues (evidence cap 500/issue)
 *
 * Mỗi section kèm chỉ dẫn ngắn cho Opus theo đúng thứ tự đọc cố định.
 */

import type { AgentRunRecord, ChatMessage, OpusReview } from '@prisma/client'
import { db } from '@/lib/db'
import { getOpenIssues, parseMetadata } from './ledger'

// ==================== CAPS (GIÁM SÁT) ====================

const CAP_ORIGINAL_REQUEST = 4000
const CAP_CHAT_HISTORY_MSGS = 30
const CAP_HISTORY_MSG_CHARS = 1500
const CAP_THOUGHT_PROGRESS = 25000
const CAP_FINAL_RESULT = 8000
const CAP_EVIDENCE = 6000
const CAP_ISSUE_EVIDENCE = 500
const MAX_RUNS = 10
const MAX_PRIOR_REVIEWS = 5

// ==================== HELPERS ====================

function fmtTime(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(d.getHours())}:${pad(d.getMinutes())} ${pad(d.getDate())}/${pad(d.getMonth() + 1)}`
}

function truncate(text: string, cap: number): string {
  if (text.length <= cap) return text
  return `${text.slice(0, cap)}\n[…đã lược bớt ${text.length - cap} ký tự]`
}

/** metadata có phải tin nhắn chỉ đạo của Opus chèn vào chat không */
function isOpusDirective(meta: Record<string, unknown> | null): boolean {
  return !!(meta && meta.opusDirective === true)
}

// ==================== RESOLVE MỤC TIÊU REVIEW ====================

export interface OpusReviewTarget {
  /** assistant message đang được review (§4) — null khi session chưa có assistant message nào */
  assistantMessage: ChatMessage | null
  /** runId của run sinh ra assistant message đó (hoặc run mới nhất của session) */
  runRef: string | null
  /** AgentRunRecord đang review (chi tiết cho §3) */
  runRecord: AgentRunRecord | null
}

/**
 * Xác định "cái đang được review":
 *   - messageId param trỏ tới 1 ASSISTANT message hợp lệ của session → dùng nó;
 *     nếu messageId không tồn tại / không phải assistant (vd user message id
 *     từ job.messageId của worker hook) → fallback assistant message cuối cùng.
 *   - runRef: AgentRunRecord của session khớp messageId (run sinh ra message),
 *     else run mới nhất (loại trừ run review của chính Opus — agentName='Opus'
 *     hoặc runId bắt đầu 'opus_rev_').
 */
export async function resolveReviewTarget(sessionId: string, messageId?: string | null): Promise<OpusReviewTarget> {
  let assistantMessage: ChatMessage | null = null
  if (messageId) {
    const byId = await db.chatMessage.findUnique({ where: { id: messageId } })
    if (byId && byId.sessionId === sessionId && byId.role === 'assistant') {
      assistantMessage = byId
    }
  }
  if (!assistantMessage) {
    assistantMessage = await db.chatMessage.findFirst({
      where: { sessionId, role: 'assistant' },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    })
  }

  const notOpusRun = { sessionId, agentName: { not: 'Opus' } } as const
  let runRecord: AgentRunRecord | null = null
  if (assistantMessage) {
    runRecord = await db.agentRunRecord.findFirst({
      where: { ...notOpusRun, messageId: assistantMessage.id },
      orderBy: { createdAt: 'desc' },
    })
  }
  if (!runRecord) {
    runRecord = await db.agentRunRecord.findFirst({
      where: notOpusRun,
      orderBy: { createdAt: 'desc' },
    })
  }

  return {
    assistantMessage,
    runRef: runRecord?.runId ?? null,
    runRecord,
  }
}

// ==================== CÁC SECTION ====================

/** §1 — user message đầu tiên KHÔNG phải opusDirective (đọc nguyên văn, cap 4000) */
async function sectionOriginalRequest(sessionId: string): Promise<string> {
  const candidates = await db.chatMessage.findMany({
    where: { sessionId, role: 'user' },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    take: 60,
  })
  const original = candidates.find(m => !isOpusDirective(parseMetadata(m.metadata)))
  if (!original) {
    return '§1. YÊU CẦU GỐC (RE-ANCHOR — đối chiếu MỌI đánh giá về đây)\n⚠️ KHÔNG tìm thấy yêu cầu gốc nào của user trong session này (mọi user message đều là chỉ đạo của Opus hoặc session rỗng).'
  }
  return [
    '§1. YÊU CẦU GỐC (RE-ANCHOR — đối chiếu MỌI đánh giá về đây; đây là CHÂN LÝ TỐI CAO của Mr. Architect)',
    `(${fmtTime(original.createdAt)} — đọc nguyên văn)`,
    truncate(original.content, CAP_ORIGINAL_REQUEST),
  ].join('\n')
}

/** §2 — 30 tin gần nhất; directive chỉ còn 1 dòng */
function sectionChatHistory(messages: ChatMessage[]): string {
  const lines: string[] = [
    `§2. LỊCH SỬ HỘI THOẠI (${messages.length} tin gần nhất — đọc để hiểu diễn biến, mỗi tin cap ${CAP_HISTORY_MSG_CHARS} ký tự)`,
  ]
  let directiveNo = 0
  messages.forEach((m, idx) => {
    const meta = parseMetadata(m.metadata)
    if (meta && isOpusDirective(meta)) {
      directiveNo++
      const verdict = meta.verdict as { directive?: { goal?: unknown } } | undefined
      const goal = verdict?.directive && typeof verdict.directive.goal === 'string' ? verdict.directive.goal : ''
      lines.push(`[${idx + 1}] ${m.role} ${fmtTime(m.createdAt)} — [Opus directive #${directiveNo}: ${goal || '(xem § các vòng review trước)'}]`)
      return
    }
    lines.push(
      `[${idx + 1}] ${m.role} ${fmtTime(m.createdAt)}:\n${truncate(m.content, CAP_HISTORY_MSG_CHARS)}`
    )
  })
  return lines.join('\n')
}

/** 1 dòng tóm tắt run (dùng khi lược bớt) */
function runOneLiner(r: AgentRunRecord): string {
  const parts = [
    r.runId ?? '(no runId)',
    r.agentName ?? '?',
    r.status ?? '?',
  ]
  if (r.stopReason) parts.push(`stop=${r.stopReason}`)
  parts.push(`${r.cycles ?? 0} chu kỳ, ${r.toolCalls ?? 0} tools, ${r.toolFailures ?? 0} fail`)
  if (r.createdAt) parts.push(`— ${fmtTime(r.createdAt)}`)
  return `- ${parts.join(' | ')}`
}

/** Khối chi tiết 1 run */
function runDetailBlock(r: AgentRunRecord, isTarget: boolean): string {
  const lines: string[] = []
  if (isTarget) lines.push('▶ RUN ĐANG REVIEW:')
  lines.push(
    `  runId=${r.runId ?? '(n/a)'} | agent=${r.agentName ?? '?'} | status=${r.status ?? '?'}${r.stopReason ? ` | stopReason=${r.stopReason}` : ''}`
  )
  const stats: string[] = []
  if (r.cycles != null) stats.push(`cycles=${r.cycles}`)
  if (r.toolCalls != null) stats.push(`toolCalls=${r.toolCalls}`)
  if (r.toolFailures != null) stats.push(`toolFailures=${r.toolFailures}`)
  if (r.evaluatorConfidence != null) stats.push(`evaluatorConfidence=${r.evaluatorConfidence}`)
  if (r.durationMs != null) stats.push(`duration=${(r.durationMs / 1000).toFixed(1)}s`)
  if (r.complete != null) stats.push(`complete=${r.complete}`)
  if (stats.length > 0) lines.push(`  ${stats.join(' | ')}`)
  if (r.startedAt || r.completedAt) {
    lines.push(
      `  started=${r.startedAt ? fmtTime(r.startedAt) : '?'} → completed=${r.completedAt ? fmtTime(r.completedAt) : '?'}`
    )
  }
  return lines.join('\n')
}

/** §3 — thought progress: runs + goalLoop metadata, cap 25000, tràn thì lược run cũ */
function sectionThoughtProgress(
  runs: AgentRunRecord[],
  target: OpusReviewTarget,
  messages: ChatMessage[]
): string {
  const header =
    '§3. THOUGHT PROGRESS (toàn bộ quá trình suy nghĩ/hành động — đọc KỸ: tool calls, kết quả trung gian, vấp váp, sửa chữa)'

  // (b) goalLoop metadata từ assistant messages (mới nhất trước)
  const goalLoopLines: string[] = []
  for (const m of [...messages].reverse()) {
    if (m.role !== 'assistant') continue
    const meta = parseMetadata(m.metadata)
    const gl = meta?.goalLoop as Record<string, unknown> | undefined
    if (!gl || typeof gl !== 'object') continue
    const bits: string[] = []
    if (gl.cycles != null) bits.push(`${gl.cycles} chu kỳ`)
    if (gl.complete != null) bits.push(`complete=${gl.complete}`)
    if (gl.stopReason != null) bits.push(`stopReason=${gl.stopReason}`)
    if (gl.evaluatorConfidence != null) bits.push(`confidence=${gl.evaluatorConfidence}`)
    if (gl.tokensUsed != null) bits.push(`tokens=${gl.tokensUsed}`)
    if (Array.isArray(gl.missing) && gl.missing.length > 0) {
      bits.push(`còn thiếu: ${gl.missing.slice(0, 3).map(String).join('; ')}`)
    }
    goalLoopLines.push(`  [${fmtTime(m.createdAt)}] goal-loop: ${bits.join(', ')}`)
  }
  const goalLoopSection =
    goalLoopLines.length > 0
      ? `\n── Progress từng chu kỳ (metadata goalLoop của assistant messages, mới nhất trước):\n${goalLoopLines.join('\n')}`
      : ''

  // (a) runs — newest giữ chi tiết, cũ lược thành 1 dòng khi vượt cap
  const detailBlocks = runs.map(r => ({ run: r, text: runDetailBlock(r, r.id === target.runRecord?.id) }))
  let budget = CAP_THOUGHT_PROGRESS - header.length - goalLoopSection.length - 400
  const detailed: string[] = []
  const oneLiners: string[] = []
  let dropped = 0
  for (let i = 0; i < detailBlocks.length; i++) {
    const { run, text } = detailBlocks[i]
    if (text.length <= budget) {
      detailed.push(text)
      budget -= text.length
    } else {
      // Tràn cap: run này + mọi run cũ hơn → 1 dòng tóm tắt (nếu còn chỗ)
      for (let j = i; j < detailBlocks.length; j++) {
        const line = runOneLiner(detailBlocks[j].run)
        if (line.length <= budget) {
          oneLiners.push(line)
          budget -= line.length
        } else {
          dropped = detailBlocks.length - j
          break
        }
      }
      break
    }
  }

  const parts: string[] = [header]
  if (target.runRecord) parts.push(`── RUN ĐANG REVIEW (neo): runId=${target.runRef ?? '(n/a)'}`)
  parts.push(`── Các run đã chạy (AgentRunRecord — tối đa ${MAX_RUNS} run gần nhất của session, KHÔNG tính run review của Opus, mới nhất trước):`)
  if (detailed.length > 0) parts.push(detailed.join('\n'))
  if (oneLiners.length > 0) parts.push(`── Các run cũ hơn (đã lược chi tiết cho vừa cap ${CAP_THOUGHT_PROGRESS} ký tự):\n${oneLiners.join('\n')}`)
  if (dropped > 0) parts.push(`  […bỏ qua ${dropped} run cũ hơn nữa do vượt cap]`)
  if (runs.length === 0) parts.push('  (KHÔNG có AgentRunRecord nào — session chưa từng chạy goal-loop/agent run)')
  parts.push(goalLoopSection.trimStart())
  return parts.filter(p => p.length > 0).join('\n')
}

/** §4 — kết quả cuối: nguyên văn assistant message đang review, cap 8000 */
function sectionFinalResult(target: OpusReviewTarget): string {
  const header =
    '§4. KẾT QUẢ CUỐI (báo cáo agent đưa ra — đọc nguyên văn; đối chiếu LỜI TUYÊN BỐ trong đây với bằng chứng máy ở §5)'
  if (!target.assistantMessage) {
    return `${header}\n⚠️ KHÔNG có assistant message nào trong session — run chưa/ko sản xuất kết quả cuối.`
  }
  const m = target.assistantMessage
  return [
    header,
    `(messageId=${m.id} · ${fmtTime(m.createdAt)}${m.model ? ` · model=${m.model}` : ''})`,
    truncate(m.content, CAP_FINAL_RESULT),
  ].join('\n')
}

/** §5 — bằng chứng kiểm định máy, cap 6000 */
async function sectionEvidence(
  sessionId: string,
  messages: ChatMessage[],
  runs: AgentRunRecord[]
): Promise<string> {
  const header =
    '§5. BẰNG CHỨNG KIỂM ĐỊNH (máy đọc được — bằng chứng máy > lời tuyên bố của agent; gì CHƯA verify thì ghi CHƯA verify)'

  const lines: string[] = []

  // (a) metadata của assistant messages
  const metaLines: string[] = []
  for (const m of [...messages].reverse()) {
    if (m.role !== 'assistant') continue
    const meta = parseMetadata(m.metadata)
    if (!meta) continue
    const bits: string[] = []
    if (meta.toolCallsExecuted != null) bits.push(`toolCalls=${meta.toolCallsExecuted}`)
    if (meta.reactIterations != null) bits.push(`iterations=${meta.reactIterations}`)
    if (meta.confidence != null) bits.push(`confidence=${meta.confidence}`)
    const gl = meta.goalLoop as Record<string, unknown> | undefined
    if (gl && typeof gl === 'object') {
      if (gl.verified != null) bits.push(`verified=${gl.verified}`)
      if (gl.evaluatorConfidence != null) bits.push(`evaluatorConfidence=${gl.evaluatorConfidence}`)
    }
    const ar = meta.agentRun as Record<string, unknown> | undefined
    if (ar && typeof ar === 'object') {
      const arBits: string[] = []
      if (ar.toolCalls != null) arBits.push(`toolCalls=${ar.toolCalls}`)
      if (ar.filesRead != null) arBits.push(`filesRead=${ar.filesRead}`)
      if (ar.commandsRun != null) arBits.push(`commandsRun=${ar.commandsRun}`)
      if (ar.editsMade != null) arBits.push(`editsMade=${ar.editsMade}`)
      if (ar.status != null) arBits.push(`status=${ar.status}`)
      if (arBits.length > 0) bits.push(`agentRun(${arBits.join(', ')})`)
    }
    // testResults / bất kỳ key kiểm định nào model- hoặc tool-ghi (nếu có)
    if (meta.testResults != null) {
      bits.push(`testResults=${truncate(JSON.stringify(meta.testResults), 400)}`)
    }
    if (bits.length > 0) metaLines.push(`  [${fmtTime(m.createdAt)} · msg ${m.id.slice(0, 10)}…] ${bits.join(' · ')}`)
  }
  if (metaLines.length > 0) {
    lines.push(`── Từ metadata các assistant message (mới nhất trước):\n${metaLines.join('\n')}`)
  }

  // (b) tổng hợp AgentRunRecord
  if (runs.length > 0) {
    const completed = runs.filter(r => r.status === 'completed').length
    const failed = runs.filter(r => r.status === 'failed').length
    const toolCalls = runs.reduce((s, r) => s + (r.toolCalls ?? 0), 0)
    const toolFailures = runs.reduce((s, r) => s + (r.toolFailures ?? 0), 0)
    const confs = runs.map(r => r.evaluatorConfidence).filter((c): c is number => c != null)
    const avgConf = confs.length > 0 ? (confs.reduce((s, c) => s + c, 0) / confs.length).toFixed(2) : null
    lines.push(
      `── Tổng hợp ${runs.length} run gần nhất: ${completed} completed, ${failed} failed, ${toolCalls} tool calls, ${toolFailures} tool failures${avgConf ? `, evaluatorConfidence trung bình ${avgConf}` : ''}`
    )
  }

  // (b2) REVIEW 13-f — GoalLoopJob durable gần nhất: job crash KHÔNG sinh
  // assistant message (bằng chứng duy nhất nằm ở đây) — Opus cần thấy lỗi
  // để FIX. Job completed cũng liệt kê để đối chiếu với assistant message.
  try {
    const jobs = await db.goalLoopJob.findMany({
      where: { sessionId },
      orderBy: { createdAt: 'desc' },
      take: 5,
      select: { id: true, status: true, stopReason: true, error: true, attempts: true, completedAt: true, createdAt: true },
    })
    if (jobs.length > 0) {
      const jobLines: string[] = []
      for (const j of jobs) {
        const bits = [j.status]
        if (j.stopReason) bits.push(`stop=${j.stopReason}`)
        if (j.attempts != null && j.attempts > 0) bits.push(`attempts=${j.attempts}`)
        if (j.status === 'failed' && j.error) bits.push(`lỗi: ${truncate(j.error, 220)}`)
        jobLines.push(`  [${fmtTime(j.createdAt)} · job ${j.id.slice(0, 10)}…] ${bits.join(' · ')}`)
      }
      lines.push(`── GoalLoopJob durable (${jobs.length} gần nhất — job 'failed' là BẰNG CHỨNG crash, run đó KHÔNG có assistant message):\n${jobLines.join('\n')}`)
    }
  } catch { /* fail-open — không có mảnh này thì bỏ qua */ }

  // (c) các vòng Opus review trước đó — để thấy TIẾN TRÌNH
  const priorReviews: OpusReview[] = await db.opusReview.findMany({
    where: { sessionId },
    orderBy: { createdAt: 'desc' },
    take: MAX_PRIOR_REVIEWS,
  })
  if (priorReviews.length > 0) {
    const reviewLines: string[] = []
    for (const r of [...priorReviews].reverse()) {
      let summary = ''
      let issueTitles: string[] = []
      try {
        const v = r.verdict ? (JSON.parse(r.verdict) as Record<string, unknown>) : null
        if (v) {
          if (typeof v.summary === 'string') summary = v.summary
          if (Array.isArray(v.issues)) {
            issueTitles = v.issues
              .map(i => (i && typeof i === 'object' && typeof (i as { title?: unknown }).title === 'string' ? (i as { title: string }).title : ''))
              .filter(Boolean)
          }
        }
      } catch { /* verdict hỏng — bỏ qua chi tiết */ }
      reviewLines.push(
        `  #${reviewLines.length + 1} [${r.decision}] ${fmtTime(r.createdAt)} — ${truncate(summary, 250)}` +
          (issueTitles.length > 0 ? ` — issues: ${issueTitles.map(t => `"${truncate(t, 80)}"`).join(', ')}` : '')
      )
    }
    lines.push(
      `── Các vòng review TRƯỚC ĐÓ của Opus (${priorReviews.length} gần nhất — đọc để thấy TIẾN TRÌNH, issue nào đã đóng):\n${reviewLines.join('\n')}`
    )
  }

  if (lines.length === 0) {
    return `${header}\n⚠️ KHÔNG có bằng chứng kiểm định máy nào được ghi nhận — coi là CHƯA verify. Mọi tuyên bố "đã test/đã pass" không có mục tương ứng ở trên là TUYÊN BỐ KHÔNG KIỂM CHỨNG.`
  }
  const body = lines.join('\n\n')
  return `${header}\n${truncate(body, CAP_EVIDENCE)}`
}

/** §6 — issue ledger đang mở */
async function sectionOpenLedger(sessionId: string): Promise<string> {
  const header =
    '§6. ISSUE LEDGER ĐANG MỞ (vấn đề đã ghi mà chưa đóng thì KHÔNG được coi là đã giải quyết — liệt kê lại trong verdict mọi issue chưa sửa)'
  const issues = await getOpenIssues(sessionId)
  if (issues.length === 0) {
    return `${header}\n✅ Sổ sạch — không có issue nào đang mở.`
  }
  const lines = issues.map(
    (i, idx) =>
      `  ${idx + 1}. [${i.severity.toUpperCase()}] ${i.title}\n     Bằng chứng: ${truncate(i.evidence ?? '(không có)', CAP_ISSUE_EVIDENCE)}\n     (mở ${fmtTime(i.openedAt)}${i.runRef ? ` · run ${i.runRef}` : ''})`
  )
  return `${header}\n${lines.join('\n')}`
}

// ==================== DOSSIER CHÍNH ====================

/**
 * Dựng dossier review hoàn chỉnh cho Opus (string tiếng Việt, 6 section theo
 * đúng giao thức đọc §III). KHÔNG throw — mọi lỗi truy vấn bỏ qua section đó
 * với ghi chú rõ ràng (Opus luôn nhận được dossier dùng được).
 */
export async function buildOpusDossier(sessionId: string, messageId?: string | null): Promise<string> {
  const generatedAt = new Date()

  // Fetch song song các nguồn
  const [history, runs, target] = await Promise.all([
    db.chatMessage
      .findMany({
        where: { sessionId, role: { in: ['user', 'assistant'] } },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: CAP_CHAT_HISTORY_MSGS,
      })
      .then(rows => rows.slice().reverse())
      .catch(() => [] as ChatMessage[]),
    db.agentRunRecord
      .findMany({
        where: { sessionId, agentName: { not: 'Opus' } },
        orderBy: { createdAt: 'desc' },
        take: MAX_RUNS,
      })
      .catch(() => [] as AgentRunRecord[]),
    resolveReviewTarget(sessionId, messageId).catch(
      () => ({ assistantMessage: null, runRef: null, runRecord: null }) as OpusReviewTarget
    ),
  ])

  const [s1, s2, s3, s4, s5, s6] = await Promise.all([
    sectionOriginalRequest(sessionId).catch(
      () => '§1. YÊU CẦU GỐC\n⚠️ Không đọc được yêu cầu gốc (lỗi truy vấn).'
    ),
    Promise.resolve(sectionChatHistory(history)).catch(() => '§2. LỊCH SỬ HỘI THOẠI\n⚠️ Không đọc được lịch sử.'),
    Promise.resolve(sectionThoughtProgress(runs, target, history)).catch(
      () => '§3. THOUGHT PROGRESS\n⚠️ Không đọc được thought progress.'
    ),
    Promise.resolve(sectionFinalResult(target)).catch(() => '§4. KẾT QUẢ CUỐI\n⚠️ Không đọc được kết quả cuối.'),
    sectionEvidence(sessionId, history, runs).catch(
      () => '§5. BẰNG CHỨNG KIỂM ĐỊNH\n⚠️ Không đọc được bằng chứng — coi là chưa verify.'
    ),
    sectionOpenLedger(sessionId).catch(() => '§6. ISSUE LEDGER ĐANG MỞ\n⚠️ Không đọc được sổ issue.'),
  ])

  const header = [
    '════════════════ OPUS DOSSIER — HỒ SƠ REVIEW RUN-KẾT ════════════════',
    `Session: ${sessionId}`,
    `Dựng lúc: ${fmtTime(generatedAt)}`,
    `Run đang review: ${target.runRef ?? '(không xác định được runId)'}`,
    'Đọc THEO ĐÚNG THỨ TỰ §1→§6 (re-anchor trước, đánh giá sau — §III).',
    '═════════════════════════════════════════════════════════════════════',
  ].join('\n')

  return [header, s1, s2, s3, s4, s5, s6].join('\n\n' + '─'.repeat(72) + '\n\n')
}
