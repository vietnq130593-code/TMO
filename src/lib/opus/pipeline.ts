/**
 * OPUS (Task 13-b) — PIPELINE: VERDICT → DIRECTIVE → DISPATCH → AUTO LOOP
 * ===========================================================================
 *
 * Luồng đầy đủ của Opus CTO meta-agent:
 *
 *   MANUAL:  user bấm "Opus review" → POST /api/opus/review → runOpusReview
 *            → UI hiển thị verdict → user bấm "Ban hành chỉ đạo" →
 *            POST /api/opus/dispatch → dispatchDirectiveForReview →
 *            applyOpusVerdict(autoDispatch=true) → directive message vào chat
 *            + enqueue goal-loop job → agent chạy theo chỉ đạo.
 *
 *   AUTO:    3 nguồn trigger (REVIEW 13-f):
 *            (1) goal-loop-worker hoàn thành/fail job → hook maybeAutoOpusReview
 *                (import động — chống circular)
 *            (2) chat route INLINE hoàn thành (ENABLE_DURABLE_GOAL_LOOP=false
 *                là mặc định sandbox — user chat không qua worker) → hook sau
 *                khi assistant message persist xong
 *            (3) sweepOpusAutoSessions — reconciliation sweep chạy trong worker
 *                tick (~30s): lưới an toàn cho mọi stall (job quá nhanh rơi
 *                vào dedupe window, PM2 restart giữa review, dispatch chết,
 *                verdict rơi rớt…)
 *            → gate (mode auto + kill switch + dedupe 45s + 4 tín hiệu A/B/
 *            C/D — xem passesAutoGate) → runAutoReview (serialize
 *            per-session) → runOpusReview(triggerMode='auto') → verdict:
 *              CONTINUE/FIX/REDIRECT → applyOpusVerdict(autoDispatch=true)
 *                                    → dispatch job kế → LOOP TIẾP TỤC
 *              ESCALATE/STOP         → applyOpusVerdict(autoDispatch=false)
 *                                    → dừng chờ user (predicate §VII)
 *
 * AUTO-DISPATCH WIRE (mục 6 spec): directive message (user-role ChatMessage)
 * được enqueue như 1 lượt chat mới — TÁI SỬ DỤNG ĐÚNG cơ chế
 * goalLoopWorker.enqueue() mà POST /api/openclaw/chat dùng cho user message
 * (nhánh DURABLE_GOAL_LOOP quanh L955 của route đó): import TRỰC TIẾP
 * singleton `goalLoopWorker` (KHÔNG fetch HTTP đến chính mình), jobInput đầy
 * đủ GoalLoopJobInput (systemPrompt / userMessage=directive / chatHistory /
 * agent info đọc từ AgentSession.agentProfileId → AgentProfile / tools resolve
 * DB-first + getEffectiveToolNames — mirror chat route).
 *
 * LƯU Ý WORKER: ENABLE_DURABLE_GOAL_LOOP=false (mặc định sandbox) →
 * instrumentation KHÔNG start worker (chat chạy inline như cũ). Để directive
 * job được claim, dispatchDirectiveGoalLoop() gọi goalLoopWorker.start() —
 * idempotent, không ảnh hưởng đường inline của chat (chỉ claim job queued do
 * Opus tạo — DB queue rỗng với các session thường). Flip flag=true sau này →
 * start() no-op vì worker đã chạy.
 */

import type { AgentProfile, ChatMessage, OpusReview, OpusSettings } from '@prisma/client'
import { db } from '@/lib/db'
import { goalLoopWorker } from '@/lib/goal-loop-worker'
import { getStandaloneAgentTools } from '@/lib/standalone-agents'
import { getEffectiveToolNames } from '@/lib/tool-access'
import { buildWorkspaceContext } from '@/lib/workspace/workspace-context'
import { archiveStaleRunTodos } from '@/lib/code-team/dev-tools'
import { isSessionDeletedDeep } from '@/lib/session-tombstone'
import { runOpusReview, markReviewRunning, markReviewDone } from './reviewer'
import { parseMetadata } from './ledger'
import type { OpusVerdict } from './types'

// ==================== SETTINGS (SINGLETON + KILL SWITCH) ====================

/** Đọc (upsert-read) OpusSettings singleton — kill switch toàn hệ thống */
export async function getOpusSettings(): Promise<OpusSettings> {
  return db.opusSettings.upsert({
    where: { id: 'singleton' },
    update: {},
    create: { id: 'singleton' },
  })
}

/**
 * Kill switch có đang bật không. Fail-open false khi DB lỗi: review kế tiếp
 * sẽ tự fail → verdict ESCALATE an toàn (không có đường nào "DB lỗi → Opus
 * vẫn tự động hành động").
 */
export async function isKilled(): Promise<boolean> {
  try {
    const s = await getOpusSettings()
    return s.killed
  } catch {
    return false
  }
}

/** Bật/tắt kill switch (route /api/opus/kill) */
export async function setOpusKilled(killed: boolean): Promise<OpusSettings> {
  return db.opusSettings.upsert({
    where: { id: 'singleton' },
    update: { killed, killedAt: killed ? new Date() : null },
    create: { id: 'singleton', killed, killedAt: killed ? new Date() : null },
  })
}

// ==================== FORMAT DIRECTIVE MESSAGE ====================

const DIRECTIVE_MESSAGE_CAP = 16000

/**
 * Render verdict thành text tiếng Việt đẹp để chèn vào chat (role='user' —
 * Opus nói vào phiên với danh mình) và làm goal cho agent run kế (auto-dispatch).
 */
export function formatDirectiveMessage(verdict: OpusVerdict): string {
  const lines: string[] = []
  lines.push(`⚖️ OPUS — CHỈ ĐẠO [${verdict.decision}]`)
  lines.push('')
  if (verdict.summary) lines.push(`📋 TÓM TẮT: ${verdict.summary}`)

  const a = verdict.axes
  lines.push('')
  lines.push('📊 ĐÁNH GIÁ 5 TRỤC (0-10):')
  lines.push(`• Tuân thủ spec: ${a.specCompliance.score}/10 — ${a.specCompliance.note}`)
  lines.push(`• Chất lượng quá trình: ${a.processQuality.score}/10 — ${a.processQuality.note}`)
  lines.push(`• Trạng thái kiểm định: ${a.verification.score}/10 — ${a.verification.note}`)
  lines.push(`• Rủi ro & nợ kỹ thuật: ${a.riskDebt.score}/10 — ${a.riskDebt.note}`)
  lines.push(`• Trung thực báo cáo: ${a.reportHonesty.score}/10 — ${a.reportHonesty.note}`)

  if (verdict.issues.length > 0) {
    lines.push('')
    lines.push(`🚨 VẤN ĐỀ GHI NHẬN (${verdict.issues.length}):`)
    verdict.issues.forEach((issue, i) => {
      lines.push(`${i + 1}. [${issue.severity.toUpperCase()}] ${issue.title}`)
      if (issue.evidence) lines.push(`   ⟩ Bằng chứng: ${issue.evidence}`)
      if (issue.suggestedFix) lines.push(`   ⟩ Gợi ý sửa: ${issue.suggestedFix}`)
    })
  }

  const d = verdict.directive
  lines.push('')
  lines.push('🎯 CHỈ ĐẠO THỰC THI:')
  lines.push(`• Mục tiêu: ${d.goal || '(không nêu)'}`)
  lines.push(`• Lý do: ${d.rationale || '(không nêu)'}`)
  lines.push(`• Phạm vi: ${d.scope || '(không nêu)'}`)
  lines.push(`• Phân công: ${d.delegation || '(không nêu)'}`)
  if (d.acceptanceCriteria.length > 0) {
    lines.push('• Tiêu chí nghiệm thu:')
    for (const c of d.acceptanceCriteria) lines.push(`   - [ ] ${c}`)
  }
  if (d.budgetHint) lines.push(`• Ngân sách đề xuất: ${d.budgetHint}`)

  if (verdict.rationale) {
    lines.push('')
    lines.push(`💡 LÝ DO QUYẾT ĐỊNH: ${verdict.rationale}`)
  }
  if (verdict.evidenceRefs.length > 0) {
    lines.push('')
    lines.push(`🔍 BẰNG CHỨNG ĐÃ DÙNG: ${verdict.evidenceRefs.join(' · ')}`)
  }

  const st = verdict.stopAssessment
  const mark = (b: boolean) => (b ? '✓' : '✗')
  lines.push('')
  lines.push(
    `🏁 ĐIỀU KIỆN DỪNG: ledger sạch ${mark(st.ledgerClean)} · kiểm định xanh ${mark(st.verificationGreen)} · ` +
      `spec đạt ${mark(st.specSatisfied)} · không blocking mới ${mark(st.noNewBlocking)} → ` +
      (verdict.decision === 'STOP'
        ? st.allMet
          ? 'ĐỦ 4/4 — STOP hợp lệ'
          : 'CHƯA đủ 4 điều kiện — chưa đủ cơ sở kết thúc theo §VII (tác vụ còn vấn đề tồn; auto mode đã đính chính review lại — model vẫn insist STOP, xem rationale)'
        : st.allMet
          ? 'ĐỦ 4/4'
          : 'CHƯA đủ — vòng lặp tiếp tục')
  )
  if (st.notes) lines.push(`   Ghi chú: ${st.notes}`)

  const text = lines.join('\n')
  if (text.length <= DIRECTIVE_MESSAGE_CAP) return text
  return `${text.slice(0, DIRECTIVE_MESSAGE_CAP)}\n[…Opus chỉ đạo bị lược bớt do vượt cap ${DIRECTIVE_MESSAGE_CAP} ký tự]`
}

// ==================== SERIALIZE (cho API) ====================

export interface SerializedOpusReview {
  id: string
  sessionId: string
  runRef: string | null
  messageId: string | null
  decision: string
  verdict: OpusVerdict | null
  triggerMode: string
  model: string | null
  tokensUsed: number | null
  durationMs: number | null
  createdAt: string
}

export function serializeOpusReview(review: OpusReview): SerializedOpusReview {
  let verdict: OpusVerdict | null = null
  if (review.verdict) {
    try {
      verdict = JSON.parse(review.verdict) as OpusVerdict
    } catch {
      verdict = null
    }
  }
  return {
    id: review.id,
    sessionId: review.sessionId,
    runRef: review.runRef,
    messageId: review.messageId,
    decision: review.decision,
    verdict,
    triggerMode: review.triggerMode,
    model: review.model,
    tokensUsed: review.tokensUsed,
    durationMs: review.durationMs,
    createdAt: review.createdAt.toISOString(),
  }
}

export function serializeChatMessage(m: ChatMessage): {
  id: string
  sessionId: string
  role: string
  content: string
  metadata: Record<string, unknown> | null
  createdAt: string
} {
  return {
    id: m.id,
    sessionId: m.sessionId,
    role: m.role,
    content: m.content,
    metadata: parseMetadata(m.metadata),
    createdAt: m.createdAt.toISOString(),
  }
}

// ==================== SYSTEM PROMPT CHO DIRECTIVE RUN ====================

/**
 * Base prompt cho lượt chạy theo directive (mirror tinh thần DEFAULT_SYSTEM_PROMPT
 * của chat route — nhưng định vị rõ: tin user sắp tới là CHỈ ĐẠO CẤP TRÊN của Opus).
 */
const DIRECTIVE_BASE_PROMPT = `Bạn là agent của The Magnum Opus (TMO) — Hệ thống GraphRAG Knowledge Base.

Tin nhắn user bạn sắp nhận là CHỈ ĐẠO CẤP TRÊN từ OPUS — CTO của hệ thống (Opus phán đoán run-KẾT thay Mr. Architect giữa các run). Thực hiện đúng mục tiêu, phạm vi và tiêu chí nghiệm thu trong chỉ đạo.

Quy tắc:
1. Làm theo chỉ đạo của Opus như yêu cầu trực tiếp của Mr. Architect
2. CHỈ đụng những gì nằm trong scope của chỉ đạo — không tự mở rộng phạm vi
3. Mọi tuyên bố "hoàn thành" PHẢI kèm bằng chứng máy đọc được (test/lint/typecheck/tool output)
4. Trung thực báo cáo: chưa xong thì nói chưa xong, lỗi thì nói rõ lỗi gì
5. Trả lời bằng tiếng Việt trừ khi user dùng ngôn ngữ khác
6. Knowledge Base local là nguồn bổ sung — cite nguồn khi dùng dữ liệu từ đó`

/** Max chars cho khối skills inject (mirror chat route) */
const MAX_SKILLS_CHARS = 16000

/**
 * Dựng system prompt cho directive run — mirror các khối CỐT LÕI của
 * /api/openclaw/chat (agent instruction + base + workspace + capability +
 * roster + skills + standing orders), từng khối fail-open. KB pre-search bị
 * bỏ (phụ thuộc query — directive tự mang ngữ cảnh đủ trong content).
 */
async function buildDirectiveSystemPrompt(profile: AgentProfile): Promise<string> {
  let systemPrompt = profile.instruction.trim() + '\n\n--- Base System Prompt ---\n' + DIRECTIVE_BASE_PROMPT

  // Workspace context (root + cấu trúc cấp 1 + tool hướng dẫn)
  try {
    const workspaceCtx = await buildWorkspaceContext()
    if (workspaceCtx.text) systemPrompt += `\n\n${workspaceCtx.text}`
  } catch (err) {
    console.warn('[Opus][pipeline] Workspace context lỗi (fail-open):', err instanceof Error ? err.message : String(err))
  }

  // Runtime capability report — agents phải BIẾT tool nào thật sự hoạt động
  try {
    const { buildCapabilityPromptBlock } = await import('@/lib/agent-capabilities')
    const block = await buildCapabilityPromptBlock()
    systemPrompt += `\n${block}`
  } catch (err) {
    console.warn('[Opus][pipeline] Capability probe lỗi (fail-open):', err instanceof Error ? err.message : String(err))
  }

  // Agent roster — danh bạ đồng nghiệp (Opus thường phân công qua directive)
  try {
    const { buildAgentRosterPromptBlock } = await import('@/lib/agent-roster')
    const block = await buildAgentRosterPromptBlock(profile.name)
    if (block) systemPrompt += `\n${block}`
  } catch (err) {
    console.warn('[Opus][pipeline] Agent roster lỗi (fail-open):', err instanceof Error ? err.message : String(err))
  }

  // Enabled skills (global — mirror chat route, budget 16k chars)
  try {
    const enabledSkills = await db.agentSkill.findMany({
      where: { enabled: true },
      select: { name: true, slug: true, content: true, source: true },
    })
    if (enabledSkills.length > 0) {
      let skillsText = ''
      for (const skill of enabledSkills) {
        const section = `## Skill: ${skill.name} (source: ${skill.source})\n${skill.content}\n\n---\n\n`
        if (skillsText.length + section.length > MAX_SKILLS_CHARS) {
          skillsText += `## Skill: ${skill.name} (source: ${skill.source})\n[Content truncated — skill content too large. Use the skill name to look up details.]\n\n---\n\n`
          break
        }
        skillsText += section
      }
      systemPrompt += `\n\n--- Available Skills ---\nYou have access to the following skills. Each skill is a guide that tells you WHEN and HOW to use a specific capability. Follow the instructions in each skill when the situation calls for it.\n\n${skillsText}`
    }
  } catch (err) {
    console.warn('[Opus][pipeline] Skills inject lỗi (fail-open):', err instanceof Error ? err.message : String(err))
  }

  // Standing orders — chỉ thị thường trực
  try {
    const standingOrders = await db.standingOrder.findMany({
      where: { enabled: true },
      select: { order: true, priority: true },
      orderBy: { priority: 'desc' },
    })
    if (standingOrders.length > 0) {
      const ordersText = standingOrders.map(o => `- [P${o.priority}] ${o.order}`).join('\n')
      systemPrompt += `\n\n--- Standing Orders ---\nYou MUST follow these standing orders at all times:\n${ordersText}`
    }
  } catch (err) {
    console.warn('[Opus][pipeline] Standing orders lỗi (fail-open):', err instanceof Error ? err.message : String(err))
  }

  return systemPrompt
}

// ==================== AUTO-DISPATCH GOAL-LOOP (mục 6) ====================

/**
 * Enqueue directive message như 1 lượt chat mới của session — TÁI SỬ DỤNG ĐÚNG
 * goalLoopWorker.enqueue() (cùng GoalLoopJobInput contract như chat route nhánh
 * durable). Import trực tiếp singleton — KHÔNG HTTP đến chính mình.
 *
 * Trả về jobId (null khi không dispatch được — session không có agent profile…).
 * KHÔNG throw — caller (applyOpusVerdict) fail-open: directive message vẫn đã
 * vào chat, user/auto-round kế có thể thử lại.
 */
async function dispatchDirectiveGoalLoop(sessionId: string, directiveMessage: ChatMessage): Promise<string | null> {
  try {
    // 1. Agent đúng của session (AgentSession.agentProfileId → AgentProfile)
    const session = await db.agentSession.findUnique({ where: { sessionId } })
    if (!session) {
      console.warn(`[Opus][pipeline] dispatch: session ${sessionId} không tồn tại — bỏ qua`)
      return null
    }
    const profile = session.agentProfileId
      ? await db.agentProfile.findUnique({ where: { id: session.agentProfileId } })
      : null
    if (!profile) {
      console.warn(
        `[Opus][pipeline] dispatch: session ${sessionId} không có AgentProfile (agentProfileId=${session.agentProfileId ?? 'null'}) — directive chỉ nằm lại trong chat, không tự chạy`
      )
      return null
    }

    // 2. Resolve agent tools — mirror chat route: DB-first (AgentProfile.tools)
    //    → standalone def → [] (mọi tool đều được phép); enforce ToolAssignment
    let agentTools = getStandaloneAgentTools(profile.name)
    if (profile.tools) {
      try {
        const parsed = JSON.parse(profile.tools)
        if (Array.isArray(parsed) && parsed.length > 0) {
          agentTools = parsed.map((t: unknown) => String(t))
        }
      } catch { /* tools JSON hỏng → giữ standalone def (fail-open, mirror route) */ }
    }
    try {
      agentTools = await getEffectiveToolNames(profile.name, agentTools)
    } catch { /* fail-open — giữ whitelist như trên (mirror route) */ }

    // 3. CI-2 per-task todo isolation — archive todo run trước (mirror chat route)
    try {
      await archiveStaleRunTodos(sessionId)
    } catch { /* fail-open — không chặn dispatch */ }

    // 4. System prompt (mirror các khối cốt lõi của chat route)
    const systemPrompt = await buildDirectiveSystemPrompt(profile)

    // 5. chatHistory — 30 tin user/assistant gần nhất TRƯỚC directive (directive
    //    message chính là userMessage của job — không lặp trong history)
    const historyRows = await db.chatMessage.findMany({
      where: { sessionId, role: { in: ['user', 'assistant'] } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 31,
    })
    const chatHistory = historyRows
      .filter(m => m.id !== directiveMessage.id)
      .slice(0, 30)
      .reverse()
      .map(m => ({ role: m.role, content: m.content }))

    // 6. ĐẢM BẢO WORKER SỐNG (ENABLE_DURABLE_GOAL_LOOP=false → instrumentation
    //    chưa start; chat vẫn inline như cũ — worker chỉ claim job directive)
    goalLoopWorker.start()

    // 7. Enqueue — ĐÚNG cơ chế chat route dùng cho user message
    const jobId = await goalLoopWorker.enqueue({
      sessionId,
      messageId: directiveMessage.id,
      jobInput: {
        systemPrompt,
        userMessage: directiveMessage.content,
        chatHistory,
        agentProvider: profile.provider,
        agentModel: profile.model,
        agentId: profile.id,
        agentName: profile.name,
        agentTemperature: profile.temperature,
        agentMaxTokens: profile.maxTokens,
        agentTools,
        agentSessionId: sessionId,
      },
    })
    console.log(
      `[Opus][pipeline] Directive ĐÃ DISPATCH — job ${jobId} (session ${sessionId}, agent ${profile.name}, ${agentTools.length} tools cho phép)`
    )
    return jobId
  } catch (err) {
    console.error(
      '[Opus][pipeline] dispatchDirectiveGoalLoop lỗi (directive message vẫn nằm trong chat):',
      err instanceof Error ? err.message : String(err)
    )
    return null
  }
}

// ==================== APPLY VERDICT ====================

const DISPATCHABLE_DECISIONS: readonly string[] = ['CONTINUE', 'FIX', 'REDIRECT']

/**
 * Áp verdict: chèn directive message vào chat (role='user', metadata
 * opusDirective=true + opusReviewId + decision + verdict JSON). Sau đó:
 *   - ESCALATE/STOP: KHÔNG dispatch gì thêm (STOP = kết thúc loop; ESCALATE =
 *     tạm dừng chờ user)
 *   - CONTINUE/FIX/REDIRECT + autoDispatch=true → enqueue goal-loop job kế
 * Trả về message đã insert (null khi session đã bị xóa — tombstone).
 */
export async function applyOpusVerdict(
  review: { id: string; sessionId: string; triggerMode?: string },
  verdict: OpusVerdict,
  opts?: { autoDispatch?: boolean; triggerMode?: 'manual' | 'auto' }
): Promise<ChatMessage | null> {
  // TOMBSTONE GUARD — session đã xóa thì không chèn (không hồi sinh phiên)
  try {
    if (await isSessionDeletedDeep(review.sessionId)) {
      console.warn(`[Opus][pipeline] applyOpusVerdict: session ${review.sessionId} đã bị xóa — không chèn directive`)
      return null
    }
  } catch { /* fail-open — vẫn chèn */ }

  const content = formatDirectiveMessage(verdict)
  const triggerMode = opts?.triggerMode ?? review.triggerMode ?? 'manual'
  const message = await db.chatMessage.create({
    data: {
      sessionId: review.sessionId,
      role: 'user',
      content,
      metadata: JSON.stringify({
        opusDirective: true,
        opusReviewId: review.id,
        decision: verdict.decision,
        triggerMode, // REVIEW 13-f #5: UI footer "Opus hành động thay Mr. Architect" khi auto
        verdict,
      }),
    },
  })

  // messageCount + tracking session (fail-open, mirror chat route)
  db.agentSession
    .updateMany({
      where: { sessionId: review.sessionId },
      data: { messageCount: { increment: 1 }, updatedAt: new Date() },
    })
    .catch(() => {})

  console.log(
    `[Opus][pipeline] Directive message ${message.id} đã chèn vào session ${review.sessionId} (decision=${verdict.decision}, ${content.length} chars)`
  )

  if (opts?.autoDispatch && DISPATCHABLE_DECISIONS.includes(verdict.decision)) {
    await dispatchDirectiveGoalLoop(review.sessionId, message)
  }
  return message
}

// ==================== DISPATCH THEO REVIEW ID (MANUAL MODE) ====================

/** Error có statusCode để route map HTTP status chính xác */
export class OpusDispatchError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message)
    this.name = 'OpusDispatchError'
  }
}

/**
 * User bấm "Ban hành chỉ đạo" (MANUAL mode): tìm OpusReview → applyOpusVerdict
 * với autoDispatch=TRUE (user đã chủ động phê duyệt — dù session đang manual).
 * Review đã từng dispatch (đã có ChatMessage metadata.opusReviewId trùng) →
 * lỗi 400 "đã ban hành".
 */
export async function dispatchDirectiveForReview(reviewId: string): Promise<ChatMessage> {
  const review = await db.opusReview.findUnique({ where: { id: reviewId } })
  if (!review) {
    throw new OpusDispatchError('Không tìm thấy review này', 404)
  }

  // Đã từng ban hành? — marker JSON string trong metadata (JSON.stringify
  // chuẩn hóa nên contains an toàn: '"opusReviewId":"<id>"')
  const marker = `"opusReviewId":"${review.id}"`
  const existing = await db.chatMessage.findFirst({
    where: { sessionId: review.sessionId, role: 'user', metadata: { contains: marker } },
    select: { id: true },
  })
  if (existing) {
    throw new OpusDispatchError('Review này đã được ban hành chỉ đạo rồi', 400)
  }

  let verdict: OpusVerdict
  try {
    verdict = JSON.parse(review.verdict ?? '') as OpusVerdict
  } catch {
    throw new OpusDispatchError('Review này không có verdict hợp lệ để ban hành', 400)
  }

  // TASK 21 — STOP GUARD (manual path): verdict STOP nhưng predicate 4 điều
  // kiện §VII chưa thỏa (allMet=false) → KHÔNG ban hành — phán kết thúc khi
  // còn vấn đề tồn là mâu thuẫn nội tại của verdict. Yêu cầu review lại.
  if (verdict.decision === 'STOP' && !verdict.stopAssessment.allMet) {
    throw new OpusDispatchError(
      'Verdict STOP nhưng predicate 4 điều kiện (§VII) CHƯA thỏa — stopAssessment.allMet=false (còn vấn đề tồn, chưa được phép kết thúc). Hãy chạy "Opus review" lại để Opus tiếp tục vòng mới (FIX/REDIRECT/CONTINUE) xử lý các vấn đề còn mở.',
      400
    )
  }

  const message = await applyOpusVerdict(
    { id: review.id, sessionId: review.sessionId, triggerMode: review.triggerMode },
    verdict,
    { autoDispatch: true }
  )
  if (!message) {
    throw new OpusDispatchError('Không chèn được directive message (session có thể đã bị xóa)', 409)
  }
  return message
}

// ==================== AUTO MODE — GATE + RUNNER ====================

/** Chống double-fire: không review session này trong 45s sau review gần nhất */
const AUTO_REVIEW_DEDUPE_MS = 45_000

/**
 * REVIEW 13-f: ngưỡng "tín hiệu treo" — directive đã ban hành mà không có
 * assistant reply và không có job queued/running trong N ms → coi là dispatch
 * chết (enqueue lỗi / worker chết giữa chừng) → cần Opus review lại để tự chữa.
 */
const STALLED_DIRECTIVE_MS = 120_000

/** Review verdict dispatchable nhưng chưa bao giờ được ban hành sau N ms → review lại */
const UNAPPLIED_VERDICT_MS = 120_000

/**
 * Gate auto mode — trả pass + reason (để log chẩn đoán). Kiểm tra:
 *   1. AgentSession.opusReviewMode === 'auto'
 *   2. Kill switch KHÔNG bật
 *   3. Không có OpusReview nào của session trong 45s qua
 *   4. Tồn tại ÍT NHẤT 1 trong 4 "tín hiệu cần review" (REVIEW 13-f — trước
 *      đây chỉ có tín hiệu A khiến auto loop STALL ở 4 kịch bản thật):
 *        (A) Assistant message MỚI sau assistant-message-time của review gần
 *            nhất (chưa review nội dung mới — tín hiệu chính)
 *        (B) GoalLoopJob status='failed' hoàn thành SAU review gần nhất —
 *            run crash không sinh assistant message (markFailed/sweepOrphans
 *            không ghi message) — Opus cần biết để FIX
 *        (C) Directive ĐÃ ban hành (decision dispatchable) là message cuối,
 *            KHÔNG có assistant reply, KHÔNG có job queued/running, và đã
 *            > STALLED_DIRECTIVE_MS → dispatch chết → review lại để tự chữa
 *        (D) Review gần nhất có verdict dispatchable nhưng CHƯA bao giờ được
 *            ban hành (không có directive message marker) và đã >
 *            UNAPPLIED_VERDICT_MS → applyOpusVerdict chết giữa chừng (vd PM2
 *            restart ngay sau khi lưu review) → review lại
 */
async function passesAutoGate(sessionId: string): Promise<{ pass: boolean; reason: string; modeAuto: boolean }> {
  const session = await db.agentSession.findUnique({
    where: { sessionId },
    select: { opusReviewMode: true },
  })
  if (!session) return { pass: false, reason: 'session không tồn tại', modeAuto: false }
  const modeAuto = session.opusReviewMode === 'auto'
  if (!modeAuto) return { pass: false, reason: `chế độ review = ${session.opusReviewMode ?? 'manual'}`, modeAuto: false }

  if (await isKilled()) {
    return { pass: false, reason: 'KILL SWITCH đang bật — auto mode ngưng toàn hệ thống', modeAuto: true }
  }

  const lastReview = await db.opusReview.findFirst({
    where: { sessionId },
    orderBy: { createdAt: 'desc' },
  })
  const now = Date.now()
  if (lastReview && now - lastReview.createdAt.getTime() < AUTO_REVIEW_DEDUPE_MS) {
    return {
      pass: false,
      reason: `review gần nhất cách ${Math.round((now - lastReview.createdAt.getTime()) / 1000)}s (< ${AUTO_REVIEW_DEDUPE_MS / 1000}s — chống double-fire)`,
      modeAuto: true,
    }
  }

  // Ngưỡng "đã review tới đâu": assistant-message-time của review gần nhất
  // (fallback createdAt của review khi messageId mất/không khớp)
  let threshold: Date | null = null
  if (lastReview) {
    if (lastReview.messageId) {
      const m = await db.chatMessage.findUnique({
        where: { id: lastReview.messageId },
        select: { createdAt: true, role: true, sessionId: true },
      })
      if (m && m.sessionId === sessionId && m.role === 'assistant') threshold = m.createdAt
    }
    if (!threshold) threshold = lastReview.createdAt
  }

  // ---- TÍN HIỆU A: assistant message mới chưa review (tín hiệu chính) ----
  const newer = await db.chatMessage.findFirst({
    where: { sessionId, role: 'assistant', ...(threshold ? { createdAt: { gt: threshold } } : {}) },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    select: { id: true },
  })
  if (newer) {
    return { pass: true, reason: `assistant message mới chưa review: ${newer.id}`, modeAuto: true }
  }

  // ---- TÍN HIỆU B: job failed sau review gần nhất (run crash không có ----
  // ---- assistant message — hook fail-path cần lối qua này)            ----
  if (lastReview) {
    const failedJob = await db.goalLoopJob.findFirst({
      where: { sessionId, status: 'failed', completedAt: { gt: lastReview.createdAt } },
      orderBy: { completedAt: 'desc' },
      select: { id: true },
    })
    if (failedJob) {
      return { pass: true, reason: `goal-loop job crash chưa review: ${failedJob.id}`, modeAuto: true }
    }
  }

  // ---- TÍN HIỆU C: directive dispatchable treo (không reply, không job) ----
  const lastMsg = await db.chatMessage.findFirst({
    where: { sessionId },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    select: { id: true, role: true, createdAt: true, metadata: true },
  })
  if (lastMsg && lastMsg.role === 'user' && now - lastMsg.createdAt.getTime() > STALLED_DIRECTIVE_MS) {
    const meta = parseMetadata(lastMsg.metadata)
    const decision = typeof meta?.decision === 'string' ? meta.decision : ''
    if (meta?.opusDirective === true && DISPATCHABLE_DECISIONS.includes(decision)) {
      const activeJob = await db.goalLoopJob.findFirst({
        where: { sessionId, status: { in: ['queued', 'running'] } },
        select: { id: true, status: true },
      })
      if (!activeJob) {
        return {
          pass: true,
          reason: `directive [${decision}] treo > ${STALLED_DIRECTIVE_MS / 1000}s không reply không job (dispatch chết) — review lại để tự chữa`,
          modeAuto: true,
        }
      }
    }
  }

  // ---- TÍN HIỆU D: verdict dispatchable chưa bao giờ ban hành (review ----
  // ---- xong nhưng applyOpusVerdict chết giữa chừng)                   ----
  if (lastReview && DISPATCHABLE_DECISIONS.includes(lastReview.decision) && now - lastReview.createdAt.getTime() > UNAPPLIED_VERDICT_MS) {
    const marker = `"opusReviewId":"${lastReview.id}"`
    const dispatched = await db.chatMessage.findFirst({
      where: { sessionId, role: 'user', metadata: { contains: marker } },
      select: { id: true },
    })
    if (!dispatched) {
      return {
        pass: true,
        reason: `review [${lastReview.decision}] cách ${Math.round((now - lastReview.createdAt.getTime()) / 1000)}s chưa từng ban hành — verdict rơi rớt, review lại`,
        modeAuto: true,
      }
    }
  }

  return { pass: false, reason: 'chưa có tín hiệu mới cần review (không assistant message mới / job crash / directive treo)', modeAuto: true }
}

/**
 * CỔNG AUTO MODE — goal-loop-worker gọi (void, KHÔNG await ở caller) mỗi khi
 * job hoàn thành/fail. Kiểm tra gate rồi fire-and-forget runAutoReview.
 * KHÔNG throw — mọi lỗi nuốt + log.
 */
export async function maybeAutoOpusReview(
  sessionId: string,
  ctx?: { runRef?: string | null; messageId?: string | null }
): Promise<void> {
  try {
    const gate = await passesAutoGate(sessionId)
    if (!gate.pass) {
      // Chỉ log khi session ĐANG auto nhưng bị chặn — session manual im lặng
      // (mọi job completion đều gọi hook này, tránh noise log)
      if (gate.modeAuto) {
        console.log(`[Opus][auto] session=${sessionId} SKIP auto review — ${gate.reason}`)
      }
      return
    }
    console.log(`[Opus][auto] session=${sessionId} gate PASS (${gate.reason}) → chạy review tự động`)
    void runAutoReview(sessionId, ctx).catch(err =>
      console.warn('[Opus][auto] runAutoReview lỗi (fire-and-forget):', err instanceof Error ? err.message : String(err))
    )
  } catch (err) {
    console.warn('[Opus][auto] maybeAutoOpusReview lỗi (nuốt):', err instanceof Error ? err.message : String(err))
  }
}

/** Serialize per-session: các vòng auto review chạy NỐI TIẾP, không chồng */
const autoChains = new Map<string, Promise<void>>()

async function runAutoReviewInner(
  sessionId: string,
  ctx?: { runRef?: string | null; messageId?: string | null }
): Promise<void> {
  // Gate kiểm tra LẠI sau khi xếp hàng đủ lượt (tình huống đổi trong lúc chờ)
  const gate = await passesAutoGate(sessionId)
  if (!gate.pass) {
    console.log(`[Opus][auto] session=${sessionId} SKIP (sau khi xếp hàng) — ${gate.reason}`)
    return
  }
  // Mutual-exclusion với đường manual (route /api/opus/review) — in-process
  if (!markReviewRunning(sessionId)) {
    console.log(`[Opus][auto] session=${sessionId} SKIP — có review khác đang chạy (manual?)`)
    return
  }
  try {
    let { review, verdict } = await runOpusReview(sessionId, ctx?.messageId ?? null, 'auto')

    // ===== TASK 21 — STOP GUARD (harness, user report 2026-09-30) =====
    // Trọng tài phán STOP nhưng predicate 4 điều kiện §VII CHƯA thỏa
    // (stopAssessment.allMet=false) → verdict TỰ MÂU THUẪN: instruction §VII
    // nói rõ "khi chưa đủ 4 điều kiện — tiếp tục vòng mới". Trước đây harness
    // phẳng: model phán STOP là loop tự dừng dù còn vấn đề tồn. Giờ: review
    // lại 1 lần kèm đính chính; model vẫn insist STOP (tác vụ độc hại/vô
    // nghĩa — nêu rõ rationale) → tôn trọng phán đó.
    if (verdict.decision === 'STOP' && !verdict.stopAssessment.allMet) {
      console.warn(
        `[Opus][auto] session=${sessionId} STOP GUARD: verdict STOP nhưng 4 điều kiện CHƯA thỏa (ledger=${verdict.stopAssessment.ledgerClean}, verify=${verdict.stopAssessment.verificationGreen}, spec=${verdict.stopAssessment.specSatisfied}, noNewBlocking=${verdict.stopAssessment.noNewBlocking}) — review lại theo §VII thay vì dừng loop khi còn vấn đề tồn`
      )
      const retried = await runOpusReview(sessionId, ctx?.messageId ?? null, 'auto', {
        correctiveHint:
          'Verdict vòng trước của bạn là STOP nhưng stopAssessment.allMet=false — predicate 4 điều kiện §VII CHƯA thỏa. ' +
          'Theo §VII bạn KHÔNG được STOP khi chưa đủ 4 điều kiện: hãy tiếp tục vòng mới (FIX/REDIRECT/CONTINUE kèm directive đầy đủ 6 trường). ' +
          'Chỉ STOP nếu (a) đủ cả 4 điều kiện với bằng chứng (allMet=true) hoặc (b) tác vụ độc hại/vô nghĩa — nêu rõ trong rationale.',
      })
      review = retried.review
      verdict = retried.verdict
      console.log(
        `[Opus][auto] session=${sessionId} STOP GUARD → review lại xong: decision=${verdict.decision} allMet=${verdict.stopAssessment.allMet}`
      )
    }

    const action =
      verdict.decision === 'CONTINUE' || verdict.decision === 'FIX' || verdict.decision === 'REDIRECT'
        ? 'ban hành directive + auto-dispatch goal-loop (vòng lặp tiếp tục)'
        : verdict.decision === 'STOP'
          ? 'dừng loop (predicate 4 điều kiện / phát hiện độc hại) — chờ user'
          : 'tạm dừng chờ Mr. Architect'
    console.log(`[Opus][auto] session=${sessionId} review=${review.id.slice(0, 12)}… decision=${verdict.decision} → ${action}`)

    // Kill switch re-check TRƯỚC KHI hành động (user có thể bấm Kill giữa lúc
    // review đang chạy — tôn trọng phanh duy nhất còn lại của auto mode)
    if (await isKilled()) {
      console.log(`[Opus][auto] session=${sessionId} KILL SWITCH bật giữa review — KHÔNG ban hành directive`)
      return
    }

    await applyOpusVerdict(review, verdict, {
      autoDispatch: DISPATCHABLE_DECISIONS.includes(verdict.decision),
      triggerMode: 'auto', // runAutoReviewInner luôn là auto (REVIEW 13-f #5)
    })
  } finally {
    markReviewDone(sessionId)
  }
}

/**
 * Chạy 1 vòng auto review — serialize per-session (in-process Map<sessionId,
 * Promise>): nhiều trigger gần nhau (job hoàn thành liên tiếp…) chạy NỐI TIẾP
 * chứ không song song. Trả promise để caller có thể await (route test) —
 * maybeAutoOpusReview thì fire-and-forget.
 */
export function runAutoReview(
  sessionId: string,
  ctx?: { runRef?: string | null; messageId?: string | null }
): Promise<void> {
  const prev = autoChains.get(sessionId) ?? Promise.resolve()
  const next = prev.then(() => runAutoReviewInner(sessionId, ctx))
  autoChains.set(sessionId, next)
  void next
    .catch(err =>
      console.warn('[Opus][auto] runAutoReview vòng lỗi (nuốt — chuỗi tiếp tục):', err instanceof Error ? err.message : String(err))
    )
    .then(() => {
      if (autoChains.get(sessionId) === next) autoChains.delete(sessionId)
    })
  return next
}

// ==================== RECONCILIATION SWEEP (REVIEW 13-f) ====================

/**
 * Sweep đối chiếu (reconciliation) auto session — goal-loop-worker tick gọi
 * định kỳ (throttle nội bộ). Là LƯỚI AN TOÀN cho mọi stall của auto loop mà
 * hook sự kiện (job hoàn thành / chat inline) bỏ sót:
 *   - job hoàn thành quá nhanh (< 45s dedupe window) → hook bị gate chặn,
 *     không có gì re-trigger → sweep tick sau bắt lại (dedupe đã hết)
 *   - PM2 restart giữa review đang chạy (LLM call 30-120s) → review mất dấu,
 *     không OpusReview row → sweep phát hiện assistant message chưa review
 *   - hook fail-path/sweepOrphans bỏ sót → tín hiệu B (failed job) của gate
 *     phát hiện qua sweep
 *   - dispatch chết / verdict rơi rớt → tín hiệu C/D của gate qua sweep
 * KHÔNG throw; mỗi session fail-open riêng. Gate tự chặn khi không có tín
 * hiệu mới (query rẻ: vài query có index cho mỗi auto session).
 */
const OPUS_SWEEP_MIN_INTERVAL_MS = 30_000
let lastOpusSweepAt = 0

export async function sweepOpusAutoSessions(): Promise<{ sessions: number }> {
  if (Date.now() - lastOpusSweepAt < OPUS_SWEEP_MIN_INTERVAL_MS) return { sessions: 0 }
  lastOpusSweepAt = Date.now()
  try {
    const sessions = await db.agentSession.findMany({
      where: { opusReviewMode: 'auto' },
      select: { sessionId: true },
    })
    for (const s of sessions) {
      // Fire-and-forget — maybeAutoOpusReview tự gate + KHÔNG throw
      void maybeAutoOpusReview(s.sessionId)
    }
    return { sessions: sessions.length }
  } catch (err) {
    console.warn('[Opus][sweep] sweepOpusAutoSessions lỗi (nuốt — tick sau thử lại):', err instanceof Error ? err.message : String(err))
    return { sessions: 0 }
  }
}
