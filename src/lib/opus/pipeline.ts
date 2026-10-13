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
import { db, withSqliteRetry } from '@/lib/db'
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

/** Đọc (upsert-read) OpusSettings singleton — kill switch toàn hệ thống.
 * Task 33 (§0b lượt 2): withSqliteRetry — đo thật 19:1x cụm ghi run-close làm
 * upsert dính P1008 "Timed out" 4 lần (dev.log ~49580 — Opus review auto
 * chạy đúng lúc burst). Upsert singleton idempotent — retry an toàn tuyệt đối. */
export async function getOpusSettings(): Promise<OpusSettings> {
  return withSqliteRetry(
    () => db.opusSettings.upsert({
      where: { id: 'singleton' },
      update: {},
      create: { id: 'singleton' },
    }),
    { label: 'getOpusSettings(upsert-read)' },
  )
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

/** Bật/tắt kill switch (route /api/opus/kill) — idempotent, retry an toàn */
export async function setOpusKilled(killed: boolean): Promise<OpusSettings> {
  return withSqliteRetry(
    () => db.opusSettings.upsert({
      where: { id: 'singleton' },
      update: { killed, killedAt: killed ? new Date() : null },
      create: { id: 'singleton', killed, killedAt: killed ? new Date() : null },
    }),
    { label: `setOpusKilled(${killed})` },
  )
}

// ==================== FORMAT DIRECTIVE MESSAGE ====================

const DIRECTIVE_MESSAGE_CAP = 16000

/**
 * Render verdict thành text tiếng Việt để chèn vào chat (role='user' — Opus
 * nói vào phiên với danh mình) và làm goal cho agent run kế (auto-dispatch).
 *
 * 2026-10 USER DIRECTIVE — Chỉ đạo ban hành cho Omega CHỈ GỒM 2 MỤC:
 *   MỤC 1 — TÓM TẮT VẤN ĐỀ: các vấn đề chính của run vừa xong.
 *   MỤC 2 — CHỈ ĐẠO BƯỚC TIẾP THEO: cần làm gì + làm như thế nào.
 * Trước đây 8 sections (mục tiêu/lý do/phạm vi/phân công/nghiệm thu/ngân sách
 * + 5 trục đánh giá + issues + evidence + điều kiện dừng) dài tới 16k chars —
 * agent bị loãng trọng tâm. Phần review chi tiết (5 trục, evidence, stop
 * conditions) Opus đã trình bày trong OpusReview panel riêng — KHÔNG lặp lại
 * trong directive. Verdict JSON (metadata) vẫn GIỮ ĐỦ trường cho UI +
 * auto-gate; chỉ đổi văn bản ban hành.
 */
export function formatDirectiveMessage(verdict: OpusVerdict): string {
  const d = verdict.directive
  const lines: string[] = []
  lines.push(`⚖️ OPUS — CHỈ ĐẠO [${verdict.decision}]`)

  // ━━ MỤC 1 — TÓM TẮT VẤN ĐỀ ━━
  const issueLines = verdict.issues.length > 0
    ? verdict.issues.slice(0, 5).map((iss, i) => {
        const evi = iss.evidence && iss.evidence !== '(model không dẫn bằng chứng — tự ghi nhận là điểm trừ report honesty)'
          ? ` (bằng chứng: ${iss.evidence})`
          : ''
        return `${i + 1}. [${iss.severity.toUpperCase()}] ${iss.title}${evi}`
      }).join('\n')
    : ''
  lines.push('')
  lines.push('📋 TÓM TẮT VẤN ĐỀ:')
  if (verdict.summary) lines.push(verdict.summary)
  lines.push(issueLines || '(không có vấn đề blocking — run đạt yêu cầu theo review)')

  // ━━ MỤC 2 — CHỈ ĐẠO BƯỚC TIẾP THEO ━━
  lines.push('')
  lines.push('🚀 BƯỚC TIẾP THEO:')
  if (d.goal) lines.push(`• Mục tiêu: ${d.goal}`)
  // Cách làm: gộp rationale (cách tiếp cận/vì sao) + delegation (giao ai)
  const howParts = [d.rationale, d.delegation].filter(Boolean).join(' — ')
  if (howParts) lines.push(`• Cách làm: ${howParts}`)
  if (d.scope) lines.push(`• Phạm vi: ${d.scope}`)
  if (d.acceptanceCriteria.length > 0) {
    lines.push('• Nghiệm thu:')
    for (const c of d.acceptanceCriteria.slice(0, 6)) lines.push(`   - [ ] ${c}`)
  }

  const text = lines.join('\n')
  if (text.length <= DIRECTIVE_MESSAGE_CAP) return text
  return `${text.slice(0, DIRECTIVE_MESSAGE_CAP)}\n[…chỉ đạo bị lược bớt do vượt cap ${DIRECTIVE_MESSAGE_CAP} ký tự]`
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
  // 2026-09-01 — SKILL ACCESS: lọc skill bị chặn cho riêng Opus (fail-open)
  try {
    let enabledSkills = await db.agentSkill.findMany({
      where: { enabled: true },
      select: { name: true, slug: true, content: true, source: true },
    })
    if (enabledSkills.length > 0) {
      try {
        const { getDisabledSlugsForAgent } = await import('@/lib/skill-access')
        const disabled = await getDisabledSlugsForAgent(profile.name)
        if (disabled.size > 0) enabledSkills = enabledSkills.filter(sk => !disabled.has(sk.slug))
      } catch { /* fail-open */ }
    }
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

// ==================== DELEGATION ROUTING (A5/E27 fix) ====================

/**
 * Tìm agent name trong chuỗi delegation mà Opus chỉ định (vd "Omega lập plan",
 * "SHOCWAVE code lượt đầu", "RAMPAGE review"). Match case-insensitive word boundary
 * chống false-positive (vd "RAMPAGE" không match "RAMPAGE-2" hay "CATALYST" chứa "CAT").
 *
 * Trả về agent name CHÍNH XÁC (từ DB) nếu tìm thấy + khác currentAgentName.
 * Trả về null nếu không match hoặc match chính currentAgent (không cần switch).
 *
 * A5/E27 fix: trước đây directive "delegation: Omega" bị RAMPAGE (session agent)
 * nhận → RAMPAGE phải tự delegate_task (không enforcement). Giờ switch session
 * agentProfileId sang delegatee trước khi enqueue → agent ĐÚNG nhận directive.
 */
async function findDelegateeAgent(delegationStr: string, currentAgentName: string): Promise<string | null> {
  try {
    // Lấy danh sách agent names từ DB (enabled + system agents — filter sau)
    const agents = await db.agentProfile.findMany({
      where: { enabled: true },
      select: { name: true },
    })
    const names = agents.map(a => a.name).filter(Boolean)
    if (names.length === 0) return null

    // Sort by length DESC để match tên dài trước (vd "RAMPAGE" không match trước "RAMPAGE-2")
    names.sort((a, b) => b.length - a.length)

    const lower = delegationStr.toLowerCase()
    for (const name of names) {
      // Word boundary, case-insensitive — tránh match substring
      const re = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i')
      if (re.test(lower)) {
        // Trả về nếu khác current agent (không cần switch nếu cùng)
        return name !== currentAgentName ? name : null
      }
    }
  } catch (err) {
    console.warn('[Opus][pipeline] findDelegateeAgent lỗi (fail-open):', err instanceof Error ? err.message : String(err))
  }
  return null
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

    // ━━ A5/E27 FIX: delegation routing ━━
    // Parse verdict.directive.delegation từ directive message metadata → tìm
    // AgentProfile match tên → nếu enabled + khác session's current agent →
    // switch session.agentProfileId sang delegatee (đảm bảo agent nhận directive
    // ĐÚNG người Opus chỉ định, không phải agent hiện tại của session).
    let profile = session.agentProfileId
      ? await db.agentProfile.findUnique({ where: { id: session.agentProfileId } })
      : null
    try {
      const meta = directiveMessage.metadata ? JSON.parse(directiveMessage.metadata) : null
      const verdict = meta?.verdict
      const delegationStr = typeof verdict?.directive?.delegation === 'string' ? verdict.directive.delegation : ''
      if (delegationStr && profile) {
        // Tìm agent name match (case-insensitive, word boundary) trong delegation string
        const delegateeName = await findDelegateeAgent(delegationStr, profile.name)
        if (delegateeName && delegateeName !== profile.name) {
          const delegatee = await db.agentProfile.findUnique({ where: { name: delegateeName } })
          if (delegatee?.enabled) {
            console.log(`[Opus][pipeline] Delegation routing: session ${sessionId} agent ${profile.name} → ${delegatee.name} (Opus directive chỉ định)`)
            // Switch session agentProfileId sang delegatee (đảm bảo job run với profile đúng)
            await db.agentSession.update({ where: { sessionId }, data: { agentProfileId: delegatee.id } })
            profile = delegatee
          } else if (delegatee && !delegatee.enabled) {
            console.warn(`[Opus][pipeline] Delegation routing: agent "${delegateeName}" bị DISABLED — giữ session agent ${profile.name}, directive nội dung sẽ hướng dẫn agent tự delegate_task`)
          }
        }
      }
    } catch (err) {
      console.warn('[Opus][pipeline] Delegation routing parse lỗi (fail-open — giữ session agent):', err instanceof Error ? err.message : String(err))
    }

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
 *
 * noDispatchReason (FIX 2026-09-25 — Omega↔Opus loop vô hạn): khi verdict
 * dispatchable NHƯNG harness quyết định KHÔNG auto-dispatch (spec đã đạt +
 * không blocking mới, hoặc vượt circuit breaker) → message vẫn chèn (giá trị
 * review cho user) kèm footer lý do + metadata opusTerminal=true. Signal C
 * (directive treo) của auto gate BỎ QUA directive có marker này — đó là
 * điểm kết có chủ đích, không phải dispatch chết.
 */
export async function applyOpusVerdict(
  review: { id: string; sessionId: string; triggerMode?: string },
  verdict: OpusVerdict,
  opts?: { autoDispatch?: boolean; triggerMode?: 'manual' | 'auto'; noDispatchReason?: string }
): Promise<ChatMessage | null> {
  // TOMBSTONE GUARD — session đã xóa thì không chèn (không hồi sinh phiên)
  try {
    if (await isSessionDeletedDeep(review.sessionId)) {
      console.warn(`[Opus][pipeline] applyOpusVerdict: session ${review.sessionId} đã bị xóa — không chèn directive`)
      return null
    }
  } catch { /* fail-open — vẫn chèn */ }

  const noDispatchReason = opts?.noDispatchReason?.trim() || ''
  let content = formatDirectiveMessage(verdict)
  if (noDispatchReason) {
    content += `\n\n🛑 TỰ ĐỘNG DỪNG VÒNG LẶP (không dispatch): ${noDispatchReason}`
  }
  const triggerMode = opts?.triggerMode ?? review.triggerMode ?? 'manual'
  const message = await db.chatMessage.create({
    data: {
      sessionId: review.sessionId,
      role: 'user',
      content,
      metadata: JSON.stringify({
        opusDirective: true,
        opusTerminal: noDispatchReason ? true : undefined,
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
    `[Opus][pipeline] Directive message ${message.id} đã chèn vào session ${review.sessionId} (decision=${verdict.decision}, ${content.length} chars${noDispatchReason ? ', KHÔNG dispatch — terminal' : ''})`
  )

  if (opts?.autoDispatch && DISPATCHABLE_DECISIONS.includes(verdict.decision)) {
    await dispatchDirectiveGoalLoop(review.sessionId, message)
  }
  return message
}

// ==================== DISPATCH THEO REVIEW ID (MANUAL MODE) ====================

/** Error có statusCode + code máy-đọc-được để route/UI phân biệt đúng case (không gộp hết vào 400) */
export type OpusDispatchErrorCode =
  | 'not_found'
  | 'already_dispatched'
  | 'invalid_verdict'
  | 'stop_guard'
  | 'insert_failed'
  | 'dispatch_error'

export class OpusDispatchError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: OpusDispatchErrorCode = 'dispatch_error'
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
    throw new OpusDispatchError('Không tìm thấy review này', 404, 'not_found')
  }

  // Đã từng ban hành? — marker JSON string trong metadata (JSON.stringify
  // chuẩn hóa nên contains an toàn: '"opusReviewId":"<id>"')
  const marker = `"opusReviewId":"${review.id}"`
  const existing = await db.chatMessage.findFirst({
    where: { sessionId: review.sessionId, role: 'user', metadata: { contains: marker } },
    select: { id: true },
  })
  if (existing) {
    throw new OpusDispatchError('Review này đã được ban hành chỉ đạo rồi', 400, 'already_dispatched')
  }

  let verdict: OpusVerdict
  try {
    verdict = JSON.parse(review.verdict ?? '') as OpusVerdict
  } catch {
    throw new OpusDispatchError('Review này không có verdict hợp lệ để ban hành', 400, 'invalid_verdict')
  }

  // TASK 21 — STOP GUARD (manual path): verdict STOP nhưng predicate 4 điều
  // kiện §VII chưa thỏa (allMet=false) → KHÔNG ban hành — phán kết thúc khi
  // còn vấn đề tồn là mâu thuẫn nội tại của verdict. Yêu cầu review lại.
  if (verdict.decision === 'STOP' && !verdict.stopAssessment.allMet) {
    throw new OpusDispatchError(
      'Verdict STOP nhưng predicate 4 điều kiện (§VII) CHƯA thỏa — stopAssessment.allMet=false (còn vấn đề tồn, chưa được phép kết thúc). Hãy chạy "Opus review" lại để Opus tiếp tục vòng mới (FIX/REDIRECT/CONTINUE) xử lý các vấn đề còn mở.',
      400,
      'stop_guard'
    )
  }

  const message = await applyOpusVerdict(
    { id: review.id, sessionId: review.sessionId, triggerMode: review.triggerMode },
    verdict,
    { autoDispatch: true }
  )
  if (!message) {
    throw new OpusDispatchError('Không chèn được directive message (session có thể đã bị xóa)', 409, 'insert_failed')
  }
  return message
}

// ==================== AUTO MODE — GATE + RUNNER ====================

/** Chống double-fire: không review session này trong 45s sau review gần nhất */
const AUTO_REVIEW_DEDUPE_MS = 45_000

/**
 * CIRCUIT BREAKER (FIX 2026-09-25 — Omega↔Opus loop vô hạn): số directive
 * auto-dispatch tối đa liên tiếp sau tin nhắn user THẬT gần nhất. Vượt ngưỡng
 * → auto loop tạm dừng, trả quyền quyết định cho user. Đếm từ tin user thật
 * cuối cùng để user gửi yêu cầu mới = reset chu kỳ làm việc mới.
 */
const MAX_AUTO_DIRECTIVE_ROUNDS = 8

/** Đếm số directive auto đã chèn trong chu kỳ làm việc hiện tại (sau tin user thật cuối cùng). */
async function countAutoDirectivesThisCycle(sessionId: string): Promise<number> {
  try {
    // Tin user thật gần nhất (KHÔNG phải directive của Opus).
    // LƯU Ý SQL 3-valued logic: metadata NULL (tin user gốc) KHÔNG match
    // `NOT { metadata: { contains } }` (NULL LIKE → NULL → NOT NULL → NULL →
    // bị lọc) — phải OR thêm `metadata: null` mới đúng.
    const lastRealUser = await db.chatMessage.findFirst({
      where: {
        sessionId,
        role: 'user',
        OR: [
          { metadata: null },
          { metadata: { not: { contains: '"opusDirective":true' } } },
        ],
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: { createdAt: true },
    })
    return await db.chatMessage.count({
      where: {
        sessionId,
        role: 'user',
        metadata: { contains: '"opusDirective":true' },
        ...(lastRealUser ? { createdAt: { gt: lastRealUser.createdAt } } : {}),
      },
    })
  } catch {
    return 0 // fail-open — không để lỗi đếm chặn luồng review chính
  }
}

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
    // FIX 2026-09-25: opusTerminal = điểm kết CÓ CHỦ ĐÍCH (SATISFIED-SPEC
    // GUARD / CIRCUIT BREAKER) — không phải dispatch chết → không re-review.
    if (meta?.opusDirective === true && !meta?.opusTerminal && DISPATCHABLE_DECISIONS.includes(decision)) {
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

    // ===== MODE-SWITCH GUARD (user report 2026-09-29 — "chuyển Opus review
    // từ auto về manual có dừng tự động không?") =====
    // Gate chỉ chặn review MỚI (lúc trigger + lúc dequeue). User có thể đổi
    // chế độ sang manual NGAY GIỮA lúc auto review đang chạy (LLM 30-120s) —
    // ý định đó phải được tôn trọng NGAY LẬP TỨC: KHÔNG STOP-GUARD retry
    // (tiết kiệm 1 LLM call), KHÔNG ban hành directive, KHÔNG auto-dispatch
    // job. OpusReview row vẫn đã lưu (persist trong runOpusReview) — user xem
    // kết quả trong panel Opus và tự bấm "Ban hành chỉ đạo" nếu muốn.
    // Thực nghiệm xác nhận gap (session test đổi manual 18:01:21 nhưng
    // directive vẫn chèn 18:01:57 + auto-dispatch queued).
    try {
      const sNow = await db.agentSession.findUnique({
        where: { sessionId },
        select: { opusReviewMode: true },
      })
      if (sNow && sNow.opusReviewMode !== 'auto') {
        console.log(
          `[Opus][auto] session=${sessionId} MODE-SWITCH GUARD: user đã chuyển chế độ review sang '${sNow.opusReviewMode ?? 'manual'}' trong lúc review đang chạy — dừng toàn bộ hành động tự động (review vẫn lưu, KHÔNG ban hành directive, KHÔNG auto-dispatch)`
        )
        return
      }
    } catch (modeErr) {
      // fail-open: lỗi query không được chặn verdict (review đã trả lời đúng lúc mode còn auto)
      console.warn('[Opus][auto] MODE-SWITCH GUARD query lỗi (fail-open):', modeErr instanceof Error ? modeErr.message : String(modeErr))
    }

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

    // ===== SATISFIED-SPEC GUARD (user report 2026-09-25 — Omega↔Opus loop vô hạn) =====
    // Predicate §VII yêu cầu verificationGreen mới được STOP — nhưng với task
    // user ĐÃ WAIVE verification (VD read-only Q&A) hoặc không có machine-check
    // khả thi, verificationGreen KHÔNG BAO GIỜ true → Opus bị protocol ép
    // CONTINUE mãi trên deliverable ĐÃ ĐẠT SPEC (tự nó kết luận "task complete,
    // budget 0, no further action") → mỗi CONTINUE dispatch job → Omega chạy
    // lại task đã xong → review lại → CONTINUE... (quan sát thật: e2eb trả lời
    // đúng 18:51, sau đó 5 re-run 20:38→21:02 chỉ vì §VII cấm STOP).
    // Giải pháp: verdict dispatchable NHƯNG stopAssessment nói spec ĐÃ đạt +
    // review KHÔNG tạo blocking issue mới → KHÔNG dispatch (directive vẫn chèn
    // informational, loop kết thúc — các issue còn lại là process-quality debt
    // cho FUTURE task / user quyết định, không phải việc re-run deliverable).
    if (DISPATCHABLE_DECISIONS.includes(verdict.decision)) {
      const st = verdict.stopAssessment
      if (st.specSatisfied && st.noNewBlocking) {
        console.log(
          `[Opus][auto] session=${sessionId} SATISFIED-SPEC GUARD: decision=${verdict.decision} nhưng specSatisfied=true + noNewBlocking=true → KHÔNG dispatch (task đã đạt spec; issues còn lại là process-debt cho future task)`
        )
        await applyOpusVerdict(review, verdict, {
          autoDispatch: false,
          triggerMode: 'auto',
          noDispatchReason:
            'spec gốc đã được đáp ứng (specSatisfied=true) và review không phát hiện blocking issue mới (noNewBlocking=true) — ' +
            'không còn việc khả thi nào cho agent ở deliverable này; các issue còn mở là process-quality debt cho các task sau.',
        })
        return
      }

      // ===== CIRCUIT BREAKER — giới hạn số vòng auto liên tiếp =====
      // Bất kể predicate thế nào, auto loop KHÔNG được chạy không giới hạn
      // (bảo vệ chống mọi pathology loop khác: FIX sinh issue mới → chạy lại →
      // issue mới...). Vượt ngưỡng → dừng vòng auto, trả quyền cho user.
      const autoRounds = await countAutoDirectivesThisCycle(sessionId)
      if (autoRounds >= MAX_AUTO_DIRECTIVE_ROUNDS) {
        console.warn(
          `[Opus][auto] session=${sessionId} CIRCUIT BREAKER: đã auto-dispatch ${autoRounds}/${MAX_AUTO_DIRECTIVE_ROUNDS} vòng liên tiếp → tạm dừng auto loop, chờ user`
        )
        await applyOpusVerdict(review, verdict, {
          autoDispatch: false,
          triggerMode: 'auto',
          noDispatchReason:
            `auto loop đã chạy ${autoRounds} vòng liên tiếp (giới hạn ${MAX_AUTO_DIRECTIVE_ROUNDS}) — tạm dừng để tránh lặp vô hạn; ` +
            'user xem lại ledger/issues rồi chủ động yêu cầu chạy tiếp nếu cần.',
        })
        return
      }
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
    const sweepMsg = err instanceof Error ? err.message : String(err)
    // FIX (user report 2026-08-31 — "Unknown argument `opusReviewMode`"):
    // Prisma client trong process cũ hơn schema → validation error spam mỗi
    // tick. Một lần duy nhất: kích hoạt ensureDbReady (tự prisma generate +
    // db push) và in hướng dẫn RESTART rõ ràng thay vì câm lặng thử lại mãi.
    const g = globalThis as unknown as { __tmoSweepClientDriftHinted?: boolean }
    if (/unknown (argument|field)/i.test(sweepMsg) && !g.__tmoSweepClientDriftHinted) {
      g.__tmoSweepClientDriftHinted = true
      console.error(
        '[Opus][sweep] ⛔ Prisma client trong process CŨ hơn schema.prisma (thiếu field như opusReviewMode). ' +
        'Đang tự chữa (prisma generate + db push) — sau đó RESTART app (bun run dev) để nạp client mới. ' +
        'Nếu vẫn lỗi: chạy `bun install` (postinstall prisma generate) rồi restart.'
      )
      try {
        const { ensureDbReady } = await import('@/lib/db-setup')
        void ensureDbReady({ force: true }).catch(() => { /* tick sau sẽ thử lại */ })
      } catch { /* db-setup không load được — để tick sau */ }
    }
    console.warn('[Opus][sweep] sweepOpusAutoSessions lỗi (nuốt — tick sau thử lại):', sweepMsg)
    return { sessions: 0 }
  }
}
