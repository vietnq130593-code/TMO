/**
 * OPUS (Task 13-b) — REVIEWER (chạy 1 vòng review run-KẾT)
 * ============================================================
 *
 * runOpusReview(sessionId, messageId?, triggerMode):
 *   1. Persist AgentRunRecord (runId='opus_rev_…', agentName='Opus',
 *      status='running') → completed/failed trong finally (durationMs,
 *      tokensUsed) — review của Opus cũng hiện trong Thought Process panel
 *      như mọi agent run ( trung thực: Opus không giấu hoạt động của mình).
 *   2. buildOpusDossier() → 1 prompt dossier (6 section có giám sát cap).
 *   3. callLLMForAgent(dossierPrompt, {provider, model}, OPUS_INSTRUCTION) —
 *      model chain kimi-k3→deepseek v4 pro/flash→minimax-m3 + z-ai-sdk
 *      fallback ĐÃ enforce bên trong llm.ts (user decision #6) — KHÔNG tự
 *      implement fallback ở đây.
 *   4. Parse + validate JSON verdict (strip markdown fence, lấy block {...}
 *      ngoài cùng lớn nhất, normalize 5 động từ / clamp axes 0-10 /
 *      normalize severity 4 mức / default trường thiếu). Parse fail → retry
 *      1 lần với "LẦN CUỐI: chỉ JSON thuần." → vẫn fail → verdict ESCALATE
 *      AN TOÀN (FAIL-SAFE: KHÔNG BAO GIỜ hành động dựa trên verdict rác).
 *   5. Persist OpusReview + syncLedgerFromVerdict → trả { review, verdict }.
 */

import type { AgentRunRecord, OpusReview } from '@prisma/client'
import { db } from '@/lib/db'
import { callLLMForAgent, type LLMResult } from '@/lib/llm'
import { OPUS_AGENT_NAME, OPUS_INSTRUCTION, getOpusProfile } from './opus-agent'
import { buildOpusDossier, resolveReviewTarget } from './dossier'
import { syncLedgerFromVerdict } from './ledger'
import {
  OPUS_DECISIONS,
  type OpusAxis,
  type OpusDecision,
  type OpusDirective,
  type OpusIssue,
  type OpusStopAssessment,
  type OpusVerdict,
} from './types'

// ==================== LOCK IN-PROCESS (route 409 + auto không chồng) ====================

const runningReviews = new Set<string>()

/** Đánh dấu session đang có review chạy. Trả false nếu đã có (→ 409 ở route / skip ở auto). */
export function markReviewRunning(sessionId: string): boolean {
  if (runningReviews.has(sessionId)) return false
  runningReviews.add(sessionId)
  return true
}

export function markReviewDone(sessionId: string): void {
  runningReviews.delete(sessionId)
}

export function isReviewRunning(sessionId: string): boolean {
  return runningReviews.has(sessionId)
}

// ==================== PARSE + VALIDATE VERDICT ====================

/**
 * Lấy block JSON object ngoài cùng lớn nhất từ text model trả về:
 * strip markdown fence ```...``` nếu có, rồi brace-scan từ '{' đầu tiên
 * (có xử lý string + escape để không vỡ khi JSON chứa '{' trong chuỗi).
 */
export function extractJsonBlock(text: string): string | null {
  if (!text) return null
  // 1. Markdown fence → lấy nội dung bên trong fence ĐẦU TIÊN có chứa '{'
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const candidates = [fenceMatch?.[1], text]
  for (const candidate of candidates) {
    if (!candidate) continue
    const start = candidate.indexOf('{')
    if (start < 0) continue
    let depth = 0
    let inString = false
    let escaped = false
    for (let i = start; i < candidate.length; i++) {
      const ch = candidate[i]
      if (inString) {
        if (escaped) escaped = false
        else if (ch === '\\') escaped = true
        else if (ch === '"') inString = false
        continue
      }
      if (ch === '"') inString = true
      else if (ch === '{') depth++
      else if (ch === '}') {
        depth--
        if (depth === 0) return candidate.slice(start, i + 1)
      }
    }
  }
  return null
}

function clampScore(raw: unknown): number {
  const n = typeof raw === 'number' ? raw : Number(raw)
  if (!Number.isFinite(n)) return 5
  return Math.min(10, Math.max(0, Math.round(n * 10) / 10))
}

function asString(raw: unknown, fallback = ''): string {
  return typeof raw === 'string' ? raw.trim() : fallback
}

function normalizeDecision(raw: unknown): OpusDecision | null {
  const s = typeof raw === 'string' ? raw.trim().toUpperCase() : ''
  return (OPUS_DECISIONS as readonly string[]).includes(s) ? (s as OpusDecision) : null
}

function normalizeAxis(raw: unknown, label: string): OpusAxis {
  const obj = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  return {
    score: clampScore(obj.score),
    note: asString(obj.note) || `Chưa có ghi chú cho trục ${label}`,
  }
}

function normalizeDirective(raw: unknown): OpusDirective {
  const obj = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const ac = Array.isArray(obj.acceptanceCriteria)
    ? obj.acceptanceCriteria.map(c => asString(c)).filter(Boolean)
    : []
  return {
    goal: asString(obj.goal),
    rationale: asString(obj.rationale),
    scope: asString(obj.scope),
    delegation: asString(obj.delegation),
    acceptanceCriteria: ac,
    budgetHint: asString(obj.budgetHint) || undefined,
  }
}

function normalizeStopAssessment(raw: unknown): OpusStopAssessment {
  const obj = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const b = (v: unknown): boolean => v === true
  const ledgerClean = b(obj.ledgerClean)
  const verificationGreen = b(obj.verificationGreen)
  const specSatisfied = b(obj.specSatisfied)
  const noNewBlocking = b(obj.noNewBlocking)
  return {
    ledgerClean,
    verificationGreen,
    specSatisfied,
    noNewBlocking,
    // FIX (review R2-b #3, 2026-08-31): harness RECOMPUTE — không tin self-report
    // allMet của model. STOP GUARD (pipeline) chặn STOP khi !allMet; trước đây
    // model tự báo allMet=true nhưng 4 sub-flag false (mâu thuẫn chiều NGƯỢC)
    // vẫn lọt qua guard và dừng loop. allMet = AND 4 sub-flag (authoritative).
    allMet: ledgerClean && verificationGreen && specSatisfied && noNewBlocking,
    notes: asString(obj.notes) || undefined,
  }
}

/**
 * Parse + validate text model → OpusVerdict. Throw khi:
 *   - không tìm thấy JSON object nào
 *   - JSON.parse fail
 *   - decision không thuộc 5 động từ (sau normalize uppercase)
 * (→ caller retry 1 lần rồi fail-safe ESCALATE.)
 */
export function parseOpusVerdict(text: string): OpusVerdict {
  const block = extractJsonBlock(text)
  if (!block) throw new Error('Không tìm thấy JSON object trong output model')
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(block) as Record<string, unknown>
  } catch (err) {
    throw new Error(`JSON.parse fail: ${err instanceof Error ? err.message : String(err)}`)
  }
  const decision = normalizeDecision(parsed.decision)
  if (!decision) {
    throw new Error(`Decision "${String(parsed.decision)}" không thuộc 5 động từ (CONTINUE/FIX/REDIRECT/ESCALATE/STOP)`)
  }

  const axesRaw = parsed.axes && typeof parsed.axes === 'object' ? (parsed.axes as Record<string, unknown>) : {}
  const issuesRaw = Array.isArray(parsed.issues) ? parsed.issues : []
  const issues: OpusIssue[] = []
  for (const i of issuesRaw) {
    const obj = i && typeof i === 'object' ? (i as Record<string, unknown>) : {}
    const title = asString(obj.title)
    if (!title) continue // issue BẮT BUỘC có title — bỏ entry rác
    issues.push({
      title,
      severity:
        typeof obj.severity === 'string' &&
        ['blocking', 'major', 'minor', 'nit'].includes(obj.severity.trim().toLowerCase())
          ? (obj.severity.trim().toLowerCase() as OpusIssue['severity'])
          : 'minor',
      evidence: asString(obj.evidence) || '(model không dẫn bằng chứng — tự ghi nhận là điểm trừ report honesty)',
      suggestedFix: asString(obj.suggestedFix) || undefined,
    })
  }

  const evidenceRefs = Array.isArray(parsed.evidenceRefs)
    ? parsed.evidenceRefs.map(r => asString(r)).filter(Boolean)
    : []

  return {
    decision,
    summary: asString(parsed.summary),
    axes: {
      specCompliance: normalizeAxis(axesRaw.specCompliance, 'spec compliance'),
      processQuality: normalizeAxis(axesRaw.processQuality, 'process quality'),
      verification: normalizeAxis(axesRaw.verification, 'verification'),
      riskDebt: normalizeAxis(axesRaw.riskDebt, 'risk & tech debt'),
      reportHonesty: normalizeAxis(axesRaw.reportHonesty, 'report honesty'),
    },
    issues,
    directive: normalizeDirective(parsed.directive),
    rationale: asString(parsed.rationale),
    evidenceRefs,
    stopAssessment: normalizeStopAssessment(parsed.stopAssessment),
  }
}

/** Verdict ESCALATE an toàn khi model không trả JSON hợp lệ sau 2 lần thử */
export function buildSafeEscalateVerdict(reason: string): OpusVerdict {
  const axis = (label: string): OpusAxis => ({ score: 5, note: `Chưa đánh giá được (${label}) — model không trả verdict hợp lệ` })
  return {
    decision: 'ESCALATE',
    summary: 'Opus không đọc được verdict JSON từ model',
    axes: {
      specCompliance: axis('spec compliance'),
      processQuality: axis('process quality'),
      verification: axis('verification'),
      riskDebt: axis('risk & tech debt'),
      reportHonesty: axis('report honesty'),
    },
    issues: [],
    directive: {
      goal: 'Kiểm tra lại model/định dạng output của Opus',
      rationale: `Parse lỗi 2 lần (${reason}) — cần kiểm tra cấu hình model chain trước khi tiếp tục review tự động`,
      scope: 'Chỉ kiểm tra cấu hình model/instruction của Opus — không thay đổi phần còn lại của hệ thống',
      delegation: 'Mr. Architect',
      acceptanceCriteria: ['Opus model trả về JSON parse được ngay lần thử đầu'],
    },
    rationale: 'Parse lỗi 2 lần — dừng chờ Mr. Architect thay vì phán đoán mù',
    evidenceRefs: [],
    stopAssessment: {
      ledgerClean: false,
      verificationGreen: false,
      specSatisfied: false,
      noNewBlocking: false,
      allMet: false,
      notes: 'Verdict fallback an toàn — KHÔNG hành động nào dựa trên dữ liệu rác của model',
    },
  }
}

// ==================== RUN 1 VÒ REVIEW ====================

export interface OpusReviewResult {
  /** Row OpusReview đã persist */
  review: OpusReview
  /** Verdict đã normalize (hoặc safe-ESCALATE) */
  verdict: OpusVerdict
}

/**
 * Chạy 1 vòng review Opus cho session. KHÔNG tự acquire lock (caller quyết —
 * route dùng markReviewRunning để 409, runAutoReview dùng để skip khi chồng).
 *
 * TASK 21 — opts.correctiveHint: văn bản nhắc nhở mắc buộc vào cuối dossier
 * prompt khi harness phát hiện verdict trước TỰ MÂU THUẪN (STOP mà predicate
 * 4 điều kiện chưa thỏa) → model được yêu cầu review lại đúng §VII thay vì
 * dừng loop khi còn vấn đề tồn (user report 2026-09-30).
 */
export async function runOpusReview(
  sessionId: string,
  messageId?: string | null,
  triggerMode: 'manual' | 'auto' = 'manual',
  opts?: { correctiveHint?: string }
): Promise<OpusReviewResult> {
  const startedAt = Date.now()
  const runId = `opus_rev_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`

  // 1. Persist AgentRunRecord chạy review (Opus trung thực về hoạt động của mình)
  let runRecord: AgentRunRecord | null = null
  try {
    runRecord = await db.agentRunRecord.create({
      data: {
        sessionId,
        runId,
        agentName: OPUS_AGENT_NAME,
        status: 'running',
        startedAt: new Date(),
      },
    })
  } catch (err) {
    console.warn('[Opus][reviewer] Không persist được AgentRunRecord running (fail-open):', err instanceof Error ? err.message : String(err))
  }

  let verdict!: OpusVerdict
  let llm: LLMResult | null = null
  let failed = false
  // FIX (BUG: fail-safe ESCALATE xóa sổ issue): verdict fallback có issues=[] —
  // nếu vẫn sync ledger, syncLedgerFromVerdict sẽ auto-resolve TOÀN BỘ issue
  // đang mở ( coi "không tái xuất hiện = đã sửa") chỉ vì model/DB fail →
  // mất dữ liệu vĩnh viễn + vòng review sau đọc ledger sạch → STOP sai sự thật.
  // Cờ này chặn bước 7 sync ledger khi verdict không đáng tin.
  let usedFallback = false
  try {
    // 2. Profile + dossier
    const profile = await getOpusProfile()
    const agentConfig = profile
      ? { provider: profile.provider, model: profile.model }
      : // getOpusProfile chỉ null khi DB lỗi — fallback cấu hình khai báo của Opus
        // (llm.ts vẫn override về chain kimi-k3 toàn hệ thống nên vô hại)
        { provider: 'nvidia', model: 'moonshotai/kimi-k3' }

    const dossier = await buildOpusDossier(sessionId, messageId)
    const dossierPrompt =
      dossier +
      '\n\n━━━ NHIỆM VỤ ━━━\n' +
      'Review run vừa hoàn thành theo §III-§X. Trả về ĐÚNG 1 JSON object, không markdown fence, không text kèm theo.' +
      (opts?.correctiveHint ? `\n\n━━━ ĐÍNH CHÍNH (HARNESS) ━━━\n${opts.correctiveHint}` : '')

    // 3. Gọi LLM (model chain đã enforce trong llm.ts)
    llm = await callLLMForAgent(dossierPrompt, agentConfig, OPUS_INSTRUCTION, {
      temperature: profile?.temperature ?? 0.4,
      maxTokens: profile?.maxTokens ?? 16384,
      agentId: profile?.id,
      agentName: OPUS_AGENT_NAME,
    })

    // 4. Parse + retry 1 lần + fail-safe
    try {
      verdict = parseOpusVerdict(llm.content ?? '')
    } catch (firstErr) {
      const firstReason = firstErr instanceof Error ? firstErr.message : String(firstErr)
      console.warn(`[Opus][reviewer] Parse verdict lần 1 fail (${firstReason}) — retry 1 lần với prompt đôn đốc`)
      try {
        const retry = await callLLMForAgent(
          dossierPrompt + '\n\nLẦN CUỐI: chỉ JSON thuần.',
          agentConfig,
          OPUS_INSTRUCTION,
          {
            temperature: profile?.temperature ?? 0.4,
            maxTokens: profile?.maxTokens ?? 16384,
            agentId: profile?.id,
            agentName: OPUS_AGENT_NAME,
          }
        )
        verdict = parseOpusVerdict(retry.content ?? '')
        llm = retry
      } catch (secondErr) {
        const secondReason = secondErr instanceof Error ? secondErr.message : String(secondErr)
        verdict = buildSafeEscalateVerdict(`${firstReason} → ${secondReason}`)
        usedFallback = true
        console.warn(`[Opus][reviewer] Parse verdict lần 2 vẫn fail — FAIL-SAFE ESCALATE: ${secondReason}`)
      }
    }
  } catch (err) {
    // Lỗi hạ tầng (DB dossier / LLM chết hẳn) → verdict ESCALATE an toàn
    failed = true
    usedFallback = true
    const reason = err instanceof Error ? err.message : String(err)
    verdict = buildSafeEscalateVerdict(reason)
    console.error('[Opus][reviewer] runOpusReview lỗi hạ tầng — verdict ESCALATE an toàn:', reason)
  }

  const durationMs = Date.now() - startedAt

  // Neo mục tiêu review (messageId assistant + runRef) cho OpusReview row
  let reviewMessageId: string | null = null
  let runRef: string | null = null
  try {
    const target = await resolveReviewTarget(sessionId, messageId)
    reviewMessageId = target.assistantMessage?.id ?? null
    runRef = target.runRef
  } catch { /* fail-open — để null */ }

  try {
    // 6. Persist OpusReview
    const review = await db.opusReview.create({
      data: {
        sessionId,
        runRef,
        messageId: reviewMessageId,
        decision: verdict.decision,
        verdict: JSON.stringify(verdict),
        triggerMode,
        model: llm?.model ?? null,
        tokensUsed: llm?.tokensUsed ?? null,
        durationMs,
      },
    })

    // 7. Sync Issue Ledger từ verdict — CHỈ khi verdict thật từ model.
    // Bỏ qua hoàn toàn khi fallback: issues=[] sẽ bị syncLedgerFromVerdict
    // hiểu là "model xác nhận mọi issue đã hết" → đóng oan toàn bộ sổ.
    if (!usedFallback) {
      try {
        await syncLedgerFromVerdict({
          sessionId,
          runRef,
          reviewId: review.id,
          issues: verdict.issues,
        })
      } catch (err) {
        console.warn('[Opus][reviewer] syncLedgerFromVerdict lỗi (review vẫn lưu):', err instanceof Error ? err.message : String(err))
      }
    } else {
      console.warn('[Opus][reviewer] Bỏ qua sync Issue Ledger — verdict fallback không đáng tin (chống đóng oan issue đang mở)')
    }

    console.log(
      `[Opus][reviewer] session=${sessionId} review=${review.id.slice(0, 12)}… decision=${verdict.decision} trigger=${triggerMode} model=${llm?.model ?? 'n/a'} duration=${(durationMs / 1000).toFixed(1)}s issues=${verdict.issues.length}${usedFallback ? ' [FALLBACK]' : ''}`
    )

    return { review, verdict }
  } finally {
    // 8. Đóng AgentRunRecord của chính review này — LUÔN chạy kể cả khi
    // db.opusReview.create throw (trước đây: create fail → record kẹt
    // status='running' vĩnh viễn = zombie trong Thought Progress panel).
    try {
      if (runRecord) {
        await db.agentRunRecord.updateMany({
          where: { id: runRecord.id, status: 'running' },
          data: {
            status: failed ? 'failed' : 'completed',
            stopReason: failed ? 'error' : 'complete',
            complete: !failed,
            tokensUsed: llm?.tokensUsed ?? null,
            durationMs,
            completedAt: new Date(),
          },
        })
      }
    } catch (err) {
      console.warn('[Opus][reviewer] Đóng AgentRunRecord lỗi (fail-open):', err instanceof Error ? err.message : String(err))
    }
  }
}
