/**
 * SELF-DIRECTION ORCHESTRATOR — Bộ não Omega của module Self-direction
 * ====================================
 * (2026-09-12) Module Self-direction: agents tự phát hiện khoảng trống hệ
 * thống → tạo đề xuất chờ Mr. Architect phê duyệt (hoặc ủy quyền Omega duyệt).
 * Đề xuất được duyệt → ORCHESTRATION:
 *   1. Omega lập kế hoạch (bao nhiêu bước? agent nào làm gì?)
 *   2. Từng bước giao agent thực hiện (persona từ AgentProfile)
 *   3. Omega đánh giá output từng bước — đạt mới bàn giao bước kế tiếp,
 *      không đạt → phản hồi + thử lại (max 3 lần)
 *   4. Hoàn tất → Omega viết báo cáo hoàn thiện (đã làm gì, làm thế nào,
 *      kết quả từng bước, kết quả sau cùng, đề xuất thêm)
 *
 * Fire-and-forget: các route gọi triggerOrchestration()/omegaReviewPending()
 * và trả response ngay — UI poll GET /api/self-direction/proposals để xem
 * tiến độ (status: planning → executing → completed/failed).
 */

import { db } from '@/lib/db'
import { callLLMForAgent } from '@/lib/llm'
import { findBalancedJson } from '@/lib/code-team/find-balanced-json'
import { getAgentRoster } from '@/lib/agent-roster'

// ==================== TYPES ====================

export interface SdPlanStep {
  title: string
  description: string
  assignee: string
}

export interface SdWorkPlan {
  planSummary: string
  steps: SdPlanStep[]
}

export interface SdReviewVerdict {
  decision: 'approve' | 'reject'
  reason: string
}

export interface SdStepEvaluation {
  complete: boolean
  evaluation: string
}

// ==================== CONSTANTS ====================

const OMEGA_FALLBACK_BRAIN = { provider: 'nvidia', model: 'moonshotai/kimi-k3' }
const LLM_TIMEOUT_MS = 120_000
const MAX_PLAN_STEPS = 12
const MAX_STEP_ATTEMPTS = 3
/** Proposal đang planning/executing mà updatedAt đứng yên quá lâu → coi là gián đoạn (PM2 restart/OOM) */
const STALLED_AFTER_MS = 10 * 60_000

const VALID_CATEGORIES = ['gap', 'kb_contradiction', 'tool_failure', 'missing_skill', 'missing_test', 'improvement', 'long_term']
const VALID_PRIORITIES = ['low', 'medium', 'high', 'critical']

// ==================== IN-PROCESS LOCKS (chống double-run) ====================

const globalForSd = globalThis as unknown as {
  __tmoSdRunningOrchestrations?: Set<string>
  __tmoSdReviewingProposals?: Set<string>
}
const runningOrchestrations: Set<string> = (globalForSd.__tmoSdRunningOrchestrations ??= new Set())
const reviewingProposals: Set<string> = (globalForSd.__tmoSdReviewingProposals ??= new Set())

// ==================== Z-AI SDK FALLBACK ====================
// callLLMForAgent ở chế độ ENFORCE_KIMI_K3 (mặc định) KHÔNG có z-ai-sdk
// fallback trong chuỗi (chỉ NVIDIA). Sandbox không có NVIDIA key → mọi call
// chết. Tự thêm tầng fallback cuối: z-ai-web-dev-sdk (chạy trong sandbox
// không cần key) — pattern copy từ llm.ts tryZaiSdk.

let zaiSdkModule: { chat: { completions: { create: (p: unknown) => Promise<unknown> } } } | null = null
let zaiSdkInitPromise: Promise<typeof zaiSdkModule> | null = null

async function getZaiSdk(): Promise<typeof zaiSdkModule> {
  if (zaiSdkModule) return zaiSdkModule
  if (!zaiSdkInitPromise) {
    zaiSdkInitPromise = (async () => {
      try {
        const mod = await import('z-ai-web-dev-sdk')
        const ZAI = (mod as unknown as { default: { create: () => Promise<unknown> } }).default
        const inst = (await ZAI.create()) as NonNullable<typeof zaiSdkModule>
        zaiSdkModule = inst
        return inst
      } catch (err) {
        console.warn('[SelfDirection] z-ai-sdk init failed:', err instanceof Error ? err.message : String(err))
        return null
      }
    })()
  }
  return zaiSdkInitPromise.then(r => r)
}

async function tryZaiSdk(prompt: string, systemPrompt: string | undefined): Promise<string | null> {
  try {
    const sdk = await getZaiSdk()
    if (!sdk) return null
    const messages = [
      ...(systemPrompt ? [{ role: 'system', content: systemPrompt }] : []),
      { role: 'user', content: prompt },
    ]
    const res = (await sdk.chat.completions.create({ messages })) as {
      choices?: Array<{ message?: { content?: string } }>
      model?: string
    }
    const content = res?.choices?.[0]?.message?.content ?? ''
    return content || null
  } catch (err) {
    console.warn('[SelfDirection] z-ai-sdk fallback failed:', err instanceof Error ? err.message : String(err))
    return null
  }
}

// ==================== CORE LLM HELPER ====================

async function callBrain(params: {
  prompt: string
  systemPrompt?: string
  temperature?: number
  maxTokens?: number
  label: string
}): Promise<string> {
  const { prompt, systemPrompt, temperature = 0.3, maxTokens = 1200, label } = params
  try {
    const result = await withTimeout(
      callLLMForAgent(prompt, OMEGA_FALLBACK_BRAIN, systemPrompt, {
        agentName: 'SelfDirection',
        temperature,
        maxTokens,
      }),
      LLM_TIMEOUT_MS,
      `${label} (NVIDIA chain)`,
    )
    if (result.content && result.content.trim()) return result.content.trim()
  } catch (err) {
    console.warn(`[SelfDirection] ${label}: NVIDIA chain lỗi — thử z-ai-sdk fallback:`, err instanceof Error ? err.message : String(err))
  }
  // Fallback cuối: z-ai-sdk (sandbox, không cần key)
  const zai = await withTimeout(tryZaiSdk(prompt, systemPrompt), LLM_TIMEOUT_MS, `${label} (zai-sdk)`)
  if (zai && zai.trim()) {
    console.log(`[SelfDirection] ${label}: dùng z-ai-sdk fallback ✓`)
    return zai.trim()
  }
  throw new Error(`${label}: mọi LLM backend đều thất bại`)
}

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
  })
  try {
    return await Promise.race([promise, timeoutPromise])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

// ==================== SETTINGS ====================

export async function getSelfDirectionSettings(): Promise<{ omegaDelegated: boolean; delegatedAt: Date | null }> {
  try {
    const row = await db.selfDirectionSettings.findUnique({ where: { id: 'singleton' } })
    return { omegaDelegated: row?.omegaDelegated ?? false, delegatedAt: row?.delegatedAt ?? null }
  } catch {
    return { omegaDelegated: false, delegatedAt: null }
  }
}

export async function setDelegation(enabled: boolean): Promise<void> {
  await db.selfDirectionSettings.upsert({
    where: { id: 'singleton' },
    create: { id: 'singleton', omegaDelegated: enabled, delegatedAt: enabled ? new Date() : null },
    update: { omegaDelegated: enabled, delegatedAt: enabled ? new Date() : null },
  })
}

// ==================== ROSTER / AGENT PERSONA ====================

/** Danh sách tên agent hợp lệ có thể nhận việc + text roster cho prompt */
async function rosterInfo(): Promise<{ names: string[]; text: string }> {
  try {
    const roster = await getAgentRoster()
    const names: string[] = []
    const lines: string[] = []
    const push = (label: string, entries: typeof roster.standalone) => {
      if (entries.length === 0) return
      lines.push(`${label}:`)
      for (const e of entries) {
        names.push(e.name)
        const skills = (e.capable || e.description || '').replace(/\s+/g, ' ').slice(0, 120)
        lines.push(`- ${e.name}${e.team ? ` [${e.team}${e.position ? '/' + e.position : ''}]` : ''}: ${skills}`)
      }
    }
    push('STANDALONE (orchestrator)', roster.standalone)
    push('CODE TEAM', roster.codeTeam)
    push('RESEARCH TEAM', roster.research)
    push('AGENTS KHÁC', roster.custom)
    if (!names.includes('Omega')) names.push('Omega')
    return { names, text: lines.join('\n').slice(0, 3500) || '(roster trống — chỉ có Omega)' }
  } catch {
    return { names: ['Omega'], text: '- Omega [standalone]: orchestrator tổng hợp' }
  }
}

/** Chuẩn hóa assignee LLM trả về → tên agent có thật trong roster */
function normalizeAssignee(assignee: string | undefined | null, validNames: string[]): string {
  if (!assignee) return 'Omega'
  const a = assignee.trim()
  if (!a) return 'Omega'
  const lower = a.toLowerCase()
  // Match chính xác (case-insensitive)
  const exact = validNames.find(n => n.toLowerCase() === lower)
  if (exact) return exact
  // Alias thường gặp
  if (lower.includes('team code') || lower.includes('code team') || lower === 'code' || lower.includes('team lead')) {
    return validNames.find(n => n === 'APEX') ?? 'Omega'
  }
  if (lower.includes('verif') || lower.includes('g3') || lower.includes('kiểm định')) {
    return validNames.find(n => n === 'CATALYST') ?? 'Omega'
  }
  if (lower.includes('generat') || lower.includes('g1')) {
    return validNames.find(n => n === 'CORTEX') ?? 'Omega'
  }
  if (lower.includes('g2')) {
    return validNames.find(n => n === 'BOLT') ?? 'Omega'
  }
  if (lower.includes('omega') || lower.includes('orchestrat')) return 'Omega'
  // Fuzzy: chứa tên agent
  const partial = validNames.find(n => lower.includes(n.toLowerCase()))
  if (partial) return partial
  return 'Omega'
}

/** Lấy persona (system prompt) của 1 agent theo tên */
async function agentPersona(name: string): Promise<{ systemPrompt: string; brain: { provider: string; model: string } }> {
  try {
    const p = await db.agentProfile.findFirst({
      where: { name, enabled: true },
      select: { instruction: true, provider: true, model: true, description: true, position: true, team: true },
    })
    if (p) {
      const base = p.instruction || `Bạn là ${name}${p.position ? ` (${p.position})` : ''}. ${p.description || ''}`
      return { systemPrompt: base, brain: { provider: p.provider || 'nvidia', model: p.model || 'moonshotai/kimi-k3' } }
    }
  } catch { /* fail-open */ }
  return {
    systemPrompt: `Bạn là ${name}, một agent trong hệ thống multi-agent TMO. Hoàn thành phần việc được giao một cách chuyên nghiệp, cụ thể và có kết quả rõ ràng.`,
    brain: OMEGA_FALLBACK_BRAIN,
  }
}

// ==================== 1. OMEGA REVIEW — duyệt thay Mr. Architect ====================

/**
 * Omega review 1 đề xuất đang pending (khi được ủy quyền) → approve/reject.
 * Fire-and-forget friendly: caller dùng void omegaReviewPending(id).
 */
export async function omegaReviewPending(proposalId: string): Promise<void> {
  if (reviewingProposals.has(proposalId)) return
  reviewingProposals.add(proposalId)
  try {
    const proposal = await db.selfDirectionProposal.findUnique({ where: { id: proposalId } })
    if (!proposal || proposal.status !== 'pending') return

    const systemPrompt = `Bạn là OMEGA — orchestrator tổng hợp của hệ thống multi-agent TMO, đang được Mr. Architect ỦY QUYỀN phê duyệt các đề xuất của module Self-direction.
Quyết định của bạn có giá trị như quyết định của Mr. Architect. Hãy cân nhắc kỹ lưỡng:
- Đề xuất có giải quyết vấn đề thật không? Kế hoạch triển khai khả thi không?
- Ưu tiên càng cao càng cần triển khai sớm; đề xuất mơ hồ/lợi ích không rõ → từ chối kèm lý do để agent đề xuất lại.

Output DUY NHẤT một JSON hợp lệ (KHÔNG markdown fence, KHÔNG giải thích ngoài):
{"decision": "approve" | "reject", "reason": "lý do ngắn gọn (1-3 câu, tiếng Việt)"}`

    const userPrompt = `ĐỀ XUẤT CẦN DUYỆT:
Tiêu đề: ${proposal.title}
Danh mục: ${proposal.category} | Ưu tiên: ${proposal.priority}

VẤN ĐỀ:
${proposal.problem.slice(0, 1200)}

GIẢI PHÁP ĐỀ XUẤT:
${proposal.solution.slice(0, 1200)}

CÁCH TRIỂN KHAI:
${proposal.implementation.slice(0, 1200)}

THỜI ĐIỂM ĐỀ XUẤT: ${proposal.scheduleAt ? new Date(proposal.scheduleAt).toLocaleString('vi-VN') : 'Ngay khi được duyệt'}
TÁC ĐỘNG KỲ VỌNG: ${(proposal.impact || '(không nêu)').slice(0, 500)}

GHI CHÚ CỦA MR. ARCHITECT (nếu có):
${(proposal.userNotes || '(không có)').slice(0, 800)}

Quyết định duyệt hay không duyệt (JSON).`

    const raw = await callBrain({ prompt: userPrompt, systemPrompt, maxTokens: 400, label: `OmegaReview ${proposal.id.slice(0, 8)}` })
    const jsonStr = findBalancedJson(raw.replace(/```(?:json)?/g, ''), 'decision')
    if (!jsonStr) throw new Error('Không parse được verdict JSON')
    const obj = JSON.parse(jsonStr) as Record<string, unknown>
    const verdict: SdReviewVerdict = {
      decision: obj.decision === 'approve' ? 'approve' : 'reject',
      reason: typeof obj.reason === 'string' ? obj.reason.slice(0, 600) : '',
    }

    const now = new Date()
    const dueNow = !proposal.scheduleAt || proposal.scheduleAt.getTime() <= now.getTime()
    if (verdict.decision === 'approve') {
      await db.selfDirectionProposal.update({
        where: { id: proposalId },
        data: {
          status: dueNow ? 'ready' : 'approved',
          reviewer: 'omega',
          decisionReason: `Omega duyệt: ${verdict.reason}`,
          reviewedAt: now,
        },
      })
      if (dueNow) void triggerOrchestration(proposalId)
      console.log(`[SelfDirection] Omega DUYỆT "${proposal.title}"${dueNow ? ' → kích hoạt triển khai' : ` (hẹn lịch ${proposal.scheduleAt?.toISOString()})`}: ${verdict.reason}`)
    } else {
      await db.selfDirectionProposal.update({
        where: { id: proposalId },
        data: {
          status: 'rejected',
          reviewer: 'omega',
          decisionReason: `Omega không duyệt: ${verdict.reason}`,
          reviewedAt: now,
        },
      })
      console.log(`[SelfDirection] Omega TỪ CHỐI "${proposal.title}": ${verdict.reason}`)
    }
  } catch (err) {
    // Review fail → giữ pending (Mr. Architect vẫn duyệt thủ công được)
    console.warn(`[SelfDirection] OmegaReview ${proposalId} lỗi (giữ pending):`, err instanceof Error ? err.message : String(err))
  } finally {
    reviewingProposals.delete(proposalId)
  }
}

// ==================== 2. PLAN — Omega lập kế hoạch triển khai ====================

async function generateWorkPlan(proposal: {
  title: string; problem: string; solution: string; implementation: string
  impact: string | null; userNotes: string | null
}): Promise<SdWorkPlan> {
  const { names, text } = await rosterInfo()

  const systemPrompt = `Bạn là OMEGA — orchestrator của hệ thống multi-agent TMO. Một đề xuất cải tiến hệ thống VỪA ĐƯỢC Mr. Architect phê duyệt. Nhiệm vụ của bạn: lập KẾ HOẠCH TRIỂN KHAI chi tiết.

Nguyên tắc lập kế hoạch:
- Chia công việc thành 3-6 bước tuần tự hợp lý (tối đa ${MAX_PLAN_STEPS}), mỗi bước 1 việc rõ ràng có kết quả kiểm chứng được.
- Giao đúng người: xem AGENT ROSTER bên dưới — chọn agent có chuyên môn phù hợp nhất từng bước.
- Bước cuối cùng LUÔN là kiểm định/nghiệm thu (giao verifier hoặc chính bạn).
- Mô tả từng bước đủ cụ thể để agent thực hiện không cần hỏi lại.

Output DUY NHẤT một JSON hợp lệ (KHÔNG markdown fence):
{"planSummary": "tóm tắt kế hoạch 1-2 câu", "steps": [{"title": "tên bước ngắn", "description": "mô tả cụ thể cần làm gì, tiêu chí hoàn thành", "assignee": "TÊN agent trong roster"}]}`

  const userPrompt = `ĐỀ XUẤT ĐÃ DUYỆT: ${proposal.title}

VẤN ĐỀ:
${proposal.problem.slice(0, 1500)}

GIẢI PHÁP:
${proposal.solution.slice(0, 1500)}

CÁCH TRIỂN KHAI:
${proposal.implementation.slice(0, 1500)}

TÁC ĐỘNG KỲ VỌNG: ${(proposal.impact || '(không nêu)').slice(0, 500)}
GHI CHÚ CỦA MR. ARCHITECT (bắt buộc tôn trọng nếu có):
${(proposal.userNotes || '(không có)').slice(0, 800)}

AGENT ROSTER:
${text}

Lập kế hoạch triển khai (JSON).`

  try {
    const raw = await callBrain({ prompt: userPrompt, systemPrompt, maxTokens: 1600, temperature: 0.4, label: 'OmegaPlan' })
    const jsonStr = findBalancedJson(raw.replace(/```(?:json)?/g, ''), 'steps')
    if (jsonStr) {
      const obj = JSON.parse(jsonStr) as Record<string, unknown>
      const rawSteps = Array.isArray(obj.steps) ? obj.steps : []
      const steps: SdPlanStep[] = rawSteps
        .filter((s): s is Record<string, unknown> => !!s && typeof s === 'object')
        .slice(0, MAX_PLAN_STEPS)
        .map(s => ({
          title: String(s.title || 'Bước').slice(0, 150),
          description: String(s.description || '').slice(0, 800),
          assignee: normalizeAssignee(typeof s.assignee === 'string' ? s.assignee : null, names),
        }))
      if (steps.length > 0) {
        return {
          planSummary: String(obj.planSummary || `Kế hoạch ${steps.length} bước do Omega lập`).slice(0, 500),
          steps,
        }
      }
    }
    throw new Error('Plan JSON rỗng/sai shape')
  } catch (err) {
    console.warn('[SelfDirection] OmegaPlan lỗi — dùng kế hoạch mặc định:', err instanceof Error ? err.message : String(err))
    return defaultPlan(proposal.title, names)
  }
}

function defaultPlan(title: string, validNames: string[]): SdWorkPlan {
  const pick = (n: string) => (validNames.includes(n) ? n : 'Omega')
  return {
    planSummary: `Kế hoạch mặc định 4 bước (LLM không phản hồi — fallback): phân tích → triển khai lõi → tích hợp → kiểm định, cho đề xuất "${title.slice(0, 80)}".`,
    steps: [
      { title: 'Phân tích & thiết kế giải pháp chi tiết', description: `Phân tích vấn đề của đề xuất "${title.slice(0, 80)}", xác định yêu cầu, rủi ro, thiết kế giải pháp cụ thể trước khi triển khai. Kết quả: bản thiết kế rõ ràng các việc cần làm.`, assignee: pick('APEX') },
      { title: 'Triển khai phần lõi của giải pháp', description: 'Thực hiện phần việc chính theo thiết kế ở bước 1. Kết quả: phần lõi hoàn thành kèm mô tả cụ thể đã làm gì.', assignee: pick('CORTEX') },
      { title: 'Triển khai phần bổ trợ & tích hợp', description: 'Hoàn thiện các phần phụ thuộc, tích hợp phần lõi vào tổng thể hệ thống. Kết quả: hệ thống đồng bộ, không bỏ sót.', assignee: pick('BOLT') },
      { title: 'Kiểm định chất lượng & nghiệm thu', description: 'Kiểm tra kết quả triển khai theo tiêu chí đề xuất, xác nhận vấn đề gốc đã được giải quyết. Kết quả: verdict đạt/không đạt kèm bằng chứng.', assignee: pick('CATALYST') },
    ],
  }
}

// ==================== 3. EXECUTE — agent thực hiện 1 bước ====================

async function executeStep(params: {
  proposal: { title: string; problem: string; solution: string; implementation: string; userNotes: string | null }
  step: { stepOrder: number; title: string; description: string; assignee: string }
  previousOutputs: Array<{ title: string; output: string }>
  reworkFeedback?: string | null
}): Promise<string> {
  const { proposal, step, previousOutputs, reworkFeedback } = params
  const persona = await agentPersona(step.assignee)

  const systemPrompt = `${persona.systemPrompt}

═══════════════════════════════════════════
 CHẾ ĐỘ THỰC THI BƯỚC KẾ HOẠCH (SELF-DIRECTION)
═══════════════════════════════════════════
Bạn đang thực hiện 1 bước trong kế hoạch triển khai đề xuất đã được Mr. Architect phê duyệt. Viết báo cáo output NGẮN GỌN, CỤ THỂ (tối đa ~250 từ): đã làm gì, kết quả gì, còn vấn đề gì. KHÔNG markdown heading lớn, KHÔNG tool_call — chỉ text báo cáo.`

  const handover = previousOutputs.length > 0
    ? previousOutputs.map(p => `• [Bước "${p.title}"]: ${p.output.slice(0, 500)}`).join('\n')
    : '(bước đầu tiên — chưa có bàn giao)'

  const userPrompt = `ĐỀ XUẤT ĐANG TRIỂN KHAI: ${proposal.title}
VẤN ĐỀ GỐC: ${proposal.problem.slice(0, 600)}
GIẢI PHÁP ĐÃ DUYỆT: ${proposal.solution.slice(0, 600)}
${proposal.userNotes ? `GHI CHÚ MR. ARCHITECT (bắt buộc tuân thủ): ${proposal.userNotes.slice(0, 400)}` : ''}

KẾT QUẢ BÀN GIAO TỪ CÁC BƯỚC TRƯỚC:
${handover}

BẠN (${step.assignee}) THỰC HIỆN BƯỚC ${step.stepOrder}: ${step.title}
MÔ TẢ CÔNG VIỆC: ${step.description}
${reworkFeedback ? `\n⚠️ PHẢN HỒI TỪ OMEGA VỀ LẦN THỬ TRƯỚC (chưa đạt — phải khắc phục): ${reworkFeedback.slice(0, 600)}` : ''}

Viết báo cáo output của bạn.`

  try {
    const result = await withTimeout(
      callLLMForAgent(userPrompt, persona.brain, systemPrompt, {
        agentName: step.assignee,
        temperature: 0.5,
        maxTokens: 900,
      }),
      LLM_TIMEOUT_MS,
      `StepExec ${step.assignee}`,
    )
    if (result.content && result.content.trim()) return result.content.trim().slice(0, 3000)
  } catch { /* fall through */ }
  // zai-sdk fallback
  const zai = await withTimeout(tryZaiSdk(userPrompt, systemPrompt), LLM_TIMEOUT_MS, `StepExec zai ${step.assignee}`)
  if (zai && zai.trim()) return zai.trim().slice(0, 3000)
  throw new Error(`Agent ${step.assignee} không tạo được output`)
}

// ==================== 4. EVALUATE — Omega đánh giá bước ====================

async function evaluateStep(params: {
  step: { stepOrder: number; title: string; description: string; assignee: string }
  output: string
  attempt: number
}): Promise<SdStepEvaluation> {
  const systemPrompt = `Bạn là OMEGA — orchestrator, phụ trách ĐÁNH GIÁ chất lượng công việc các agent bàn giao trong module Self-direction.
Đánh giá THỰC TẾ, không khắt khe quá mức: output CHẤP NHẬN ĐƯỢC nếu agent đã làm phần việc chính của bước (kể cả chưa hoàn hảo mọi chi tiết). CHỈ đánh giá chưa đạt khi output (a) bỏ sót phần việc chính, (b) sai hướng với mô tả công việc, hoặc (c) quá chung chung/khung suông không có kết quả cụ thể nào.

Output DUY NHẤT một JSON hợp lệ (KHÔNG markdown fence):
{"complete": true|false, "evaluation": "nhận xét ngắn (1-3 câu, tiếng Việt): điểm đạt; nếu chưa đạt — nêu rõ CẦN BỔ SUNG GÌ cụ thể"}`

  const userPrompt = `BƯỚC ${params.step.stepOrder}: ${params.step.title} (agent thực hiện: ${params.step.assignee})
MÔ TẢ CÔNG VIỆC: ${params.step.description}

OUTPUT AGENT BÀN GIAO (lần thử ${params.attempt}/${MAX_STEP_ATTEMPTS}):
${params.output.slice(0, 2000)}

Đánh giá (JSON).`

  try {
    const raw = await callBrain({ prompt: userPrompt, systemPrompt, maxTokens: 350, temperature: 0.2, label: `StepEval ${params.step.stepOrder}` })
    const jsonStr = findBalancedJson(raw.replace(/```(?:json)?/g, ''), 'complete')
    if (jsonStr) {
      const obj = JSON.parse(jsonStr) as Record<string, unknown>
      return {
        complete: obj.complete === true || obj.complete === 'true',
        evaluation: typeof obj.evaluation === 'string' ? obj.evaluation.slice(0, 600) : '',
      }
    }
  } catch (err) {
    console.warn('[SelfDirection] StepEval lỗi — mặc định đạt (fail-open):', err instanceof Error ? err.message : String(err))
  }
  // Fail-open: không đánh giá được → chấp nhận output để không kẹt pipeline
  return { complete: true, evaluation: '(Omega không đánh giá được — chấp nhận theo fail-open)' }
}

// ==================== 5. REPORT — Omega viết báo cáo hoàn thiện ====================

async function writeFinalReport(params: {
  proposal: { title: string; problem: string; solution: string; implementation: string }
  steps: Array<{ stepOrder: number; title: string; assignee: string; status: string; output: string | null; evaluation: string | null }>
  failed: boolean
}): Promise<string> {
  const stepsText = params.steps.map(s =>
    `Bước ${s.stepOrder} — ${s.title} [${s.assignee}] (${s.status === 'done' ? 'đạt' : s.status}):\n  Output: ${(s.output || '(trống)').slice(0, 600)}\n  Đánh giá Omega: ${s.evaluation || '(không có)'}`
  ).join('\n\n')

  const systemPrompt = `Bạn là OMEGA — orchestrator. Kế hoạch triển khai đề xuất "${params.proposal.title}" ${params.failed ? 'đã THẤT BẠI ở 1 bước' : 'đã HOÀN TẤT'}. Viết BÁO CÁO HOÀN THIỆN gửi Mr. Architect bằng tiếng Việt, markdown đơn giản (chỉ dùng ## và **, KHÔNG bảng), theo đúng khung:

## Tổng quan
(1-2 câu: đề xuất gì, kết quả sau cùng)

## Đã triển khai những gì & triển khai như thế nào
(tóm tắt cách tiếp cận tổng thể)

## Kết quả các bước triển khai
(mỗi bước 2-4 câu: agent nào làm gì, kết quả ra sao${params.failed ? ' — nêu rõ bước nào THẤT BẠI và tại sao' : ''})

## Kết quả sau cùng
(vấn đề gốc đã được giải quyết chưa? còn tồn đọng gì?)

## Ý kiến & đề xuất khác
(đề xuất tiếp theo cho hệ thống, nếu có)

Giữ báo cáo dưới 600 từ.`

  const userPrompt = `ĐỀ XUẤT: ${params.proposal.title}
VẤN ĐỀ GỐC: ${params.proposal.problem.slice(0, 800)}
GIẢI PHÁP ĐÃ DUYỆT: ${params.proposal.solution.slice(0, 800)}

KẾT QUẢ TỪNG BƯỚC:
${stepsText.slice(0, 4000)}

Viết báo cáo hoàn thiện.`

  try {
    const raw = await callBrain({ prompt: userPrompt, systemPrompt, maxTokens: 1400, temperature: 0.4, label: 'OmegaReport' })
    return raw.slice(0, 6000)
  } catch (err) {
    console.warn('[SelfDirection] OmegaReport lỗi — dùng báo cáo deterministic:', err instanceof Error ? err.message : String(err))
    // Fallback deterministic
    const lines = [
      `## Tổng quan`,
      params.failed
        ? `Đề xuất "${params.proposal.title}" đã được triển khai nhưng THẤT BẠI ở 1 bước (báo cáo dự phòng — LLM không phản hồi).`
        : `Đề xuất "${params.proposal.title}" đã được triển khai hoàn tất qua ${params.steps.length} bước (báo cáo dự phòng — LLM không phản hồi).`,
      ``,
      `## Kết quả các bước triển khai`,
      ...params.steps.map(s => `Bước ${s.stepOrder} — ${s.title} [${s.assignee}]: ${s.status === 'done' ? 'Hoàn tất' : 'THẤT BẠI'}. ${(s.output || '').slice(0, 300)}`),
      ``,
      `## Kết quả sau cùng`,
      params.failed ? `Chưa hoàn thành — cần xem xét thử lại (bấm "Thử lại" trong Lịch sử).` : `Hoàn thành theo kế hoạch.`,
      ``,
      `## Ý kiến & đề xuất khác`,
      `Kiểm tra lại chất lượng output từng bước trong tab Chi tiết để đánh giá độc lập.`,
    ]
    return lines.join('\n')
  }
}

// ==================== 6. ORCHESTRATION — điều phối toàn bộ ====================

/**
 * Kick-off orchestration (fire-and-forget). Trả true nếu bắt đầu thành công.
 * Chấp nhận: status ready/approved (deploy sớm)/failed (retry).
 *
 * FIX 2026-08-29 (race condition): lock phải được đặt TRƯỚC mọi await. Bản cũ
 * đặt lock sau `await findUnique` → 2 lời gọi đồng thời (poll promoteDue +
 * user bấm "Triển khai ngay") cùng vượt check has() rồi cùng add + cùng kick
 * runOrchestration → steps bị deleteMany/createMany đan xen (nhân đôi stepOrder,
 * xung đột status). Check-and-add đồng bộ (không await xen giữa) là atomic
 * trong event loop JS → đảm bảo đúng 1 orchestration chạy mỗi proposal.
 */
export async function triggerOrchestration(proposalId: string): Promise<boolean> {
  if (runningOrchestrations.has(proposalId)) return false
  runningOrchestrations.add(proposalId) // reserve NGAY (atomic với check phía trên)
  let started = false
  try {
    const proposal = await db.selfDirectionProposal.findUnique({ where: { id: proposalId }, select: { status: true, title: true } })
    if (!proposal) return false
    if (!['ready', 'approved', 'failed'].includes(proposal.status)) return false
    console.log(`[SelfDirection] Trigger orchestration cho "${proposal.title}" (status=${proposal.status})`)
    // Fire-and-forget — mọi lỗi được xử lý trong catch bên dưới
    void runOrchestration(proposalId).catch(async err => {
      console.error(`[SelfDirection] Orchestration ${proposalId} crash:`, err instanceof Error ? err.message : String(err))
      try {
        await db.selfDirectionProposal.update({
          where: { id: proposalId },
          data: {
            status: 'failed',
            decisionReason: `Lỗi orchestration: ${err instanceof Error ? err.message : String(err)}`,
          },
        })
      } catch { /* best-effort */ }
    }).finally(() => {
      runningOrchestrations.delete(proposalId)
    })
    started = true
    return true
  } catch (err) {
    console.warn(`[SelfDirection] Trigger orchestration ${proposalId} lỗi:`, err instanceof Error ? err.message : String(err))
    return false
  } finally {
    // Không kick được orchestration (early-return/exception) → nhả lock reservation
    if (!started) runningOrchestrations.delete(proposalId)
  }
}

/** Kiểm tra orchestration có đang chạy cho proposal này không (in-process) */
export function isOrchestrating(proposalId: string): boolean {
  return runningOrchestrations.has(proposalId)
}

async function runOrchestration(proposalId: string): Promise<void> {
  // === Phase 1: PLAN ===
  await db.selfDirectionProposal.update({ where: { id: proposalId }, data: { status: 'planning' } })
  const proposal = await db.selfDirectionProposal.findUnique({ where: { id: proposalId } })
  if (!proposal) throw new Error('Proposal biến mất')

  // Retry → xóa steps cũ
  await db.proposalStep.deleteMany({ where: { proposalId } })

  const plan = await generateWorkPlan(proposal)
  await db.proposalStep.createMany({
    data: plan.steps.map((s, i) => ({
      proposalId,
      stepOrder: i + 1,
      title: s.title,
      description: s.description,
      assignee: s.assignee,
      status: 'pending',
    })),
  })
  await db.selfDirectionProposal.update({
    where: { id: proposalId },
    data: { status: 'executing', planSummary: plan.planSummary, executedAt: new Date() },
  })
  console.log(`[SelfDirection] Bắt đầu triển khai "${proposal.title}": ${plan.steps.length} bước [${plan.steps.map(s => s.assignee).join(' → ')}]`)

  // === Phase 2: EXECUTE từng bước (tuần tự + đánh giá + rework) ===
  let failed = false
  let failReason = ''
  const totalSteps = plan.steps.length
  const doneOutputs: Array<{ title: string; output: string }> = []

  for (let i = 0; i < totalSteps; i++) {
    const stepDef = plan.steps[i]
    const stepRow = await db.proposalStep.findFirst({ where: { proposalId, stepOrder: i + 1 } })
    if (!stepRow) continue

    await db.proposalStep.update({
      where: { id: stepRow.id },
      data: { status: 'in_progress', startedAt: new Date(), attempts: { increment: 1 } },
    })

    let stepDone = false
    let lastOutput = ''
    let lastEvaluation = ''
    for (let attempt = 1; attempt <= MAX_STEP_ATTEMPTS && !stepDone; attempt++) {
      if (attempt > 1) {
        await db.proposalStep.update({ where: { id: stepRow.id }, data: { attempts: { increment: 1 } } })
      }
      lastOutput = await executeStep({
        proposal,
        step: { ...stepDef, stepOrder: i + 1 },
        previousOutputs: doneOutputs.slice(-3), // bàn giao 3 bước gần nhất (anti context-bloat)
        reworkFeedback: attempt > 1 ? lastEvaluation : null,
      })
      const evaluation = await evaluateStep({
        step: { ...stepDef, stepOrder: i + 1 },
        output: lastOutput,
        attempt,
      })
      lastEvaluation = evaluation.evaluation
      if (evaluation.complete) {
        await db.proposalStep.update({
          where: { id: stepRow.id },
          data: { status: 'done', output: lastOutput, evaluation: lastEvaluation, finishedAt: new Date() },
        })
        doneOutputs.push({ title: stepDef.title, output: lastOutput })
        stepDone = true
        console.log(`[SelfDirection] Bước ${i + 1}/${totalSteps} "${stepDef.title}" [${stepDef.assignee}] ĐẠT (lần ${attempt})`)
      } else {
        console.warn(`[SelfDirection] Bước ${i + 1}/${totalSteps} [${stepDef.assignee}] CHƯA ĐẠT (lần ${attempt}): ${lastEvaluation.slice(0, 150)}`)
        if (attempt < MAX_STEP_ATTEMPTS) {
          await db.proposalStep.update({
            where: { id: stepRow.id },
            data: { output: lastOutput, evaluation: `Chưa đạt (lần ${attempt}): ${lastEvaluation} — sẽ thử lại` },
          })
        }
      }
    }

    if (!stepDone) {
      await db.proposalStep.update({
        where: { id: stepRow.id },
        data: { status: 'failed', output: lastOutput, evaluation: `THẤT BẠI sau ${MAX_STEP_ATTEMPTS} lần: ${lastEvaluation}` },
      })
      failed = true
      failReason = `Bước ${i + 1} "${stepDef.title}" (agent ${stepDef.assignee}) không đạt sau ${MAX_STEP_ATTEMPTS} lần thử`
      break // dừng cả pipeline
    }
  }

  // === Phase 3: REPORT ===
  const finalSteps = await db.proposalStep.findMany({ where: { proposalId }, orderBy: { stepOrder: 'asc' } })
  const report = await writeFinalReport({ proposal, steps: finalSteps, failed })
  await db.selfDirectionProposal.update({
    where: { id: proposalId },
    data: {
      status: failed ? 'failed' : 'completed',
      // Hoàn tất thành công → xóa reason cũ của lần fail trước (nếu retry),
      // báo cáo Omega là nguồn thông tin duy nhất cho kết quả cuối.
      decisionReason: failed ? failReason : null,
      omegaReport: report,
      completedAt: new Date(),
    },
  })
  console.log(`[SelfDirection] "${proposal.title}" ${failed ? `THẤT BẠI: ${failReason}` : `HOÀN TẤT ${finalSteps.length} bước — báo cáo Omega đã lưu`}`)
}

// ==================== 7. AUTO-PROMOTION (gọi từ GET proposals) ====================

/**
 * Đến hạn triển khai (scheduleAt <= now) → approved chuyển ready + trigger.
 * Đồng thời recover orchestration bị gián đoạn (PM2 restart/OOM).
 * TRẢ VỀ: danh sách id đã kích hoạt (để log).
 */
export async function promoteDueProposals(): Promise<string[]> {
  const triggered: string[] = []
  try {
    const now = new Date()
    // 1) Đến hạn → ready + orchestrate
    const due = await db.selfDirectionProposal.findMany({
      where: { status: 'approved', OR: [{ scheduleAt: null }, { scheduleAt: { lte: now } }] },
      select: { id: true },
    })
    for (const p of due) {
      await db.selfDirectionProposal.update({ where: { id: p.id }, data: { status: 'ready' } })
      if (await triggerOrchestration(p.id)) triggered.push(p.id)
    }
    // 2) Ready nhưng chưa chạy (vd server restart ngay sau promote) → trigger lại
    const ready = await db.selfDirectionProposal.findMany({ where: { status: 'ready' }, select: { id: true } })
    for (const p of ready) {
      if (await triggerOrchestration(p.id)) triggered.push(p.id)
    }
    // 3) Orchestration gián đoạn (PM2 restart/OOM) → failed + recoverable.
    //    TÍN HIỆU SỐNG: (a) in-process lock đang giữ = chắc chắn đang chạy;
    //    (b) step gần nhất có startedAt/finishedAt mới = pipeline đang tiến triển.
    //    (Lưu ý: proposal.updatedAt KHÔNG cập nhật khi steps tiến triển —
    //    không được chỉ dựa vào nó kẻo giết nhầm orchestration đang chạy.)
    const stalledCutoff = new Date(Date.now() - STALLED_AFTER_MS)
    const candidates = await db.selfDirectionProposal.findMany({
      where: { status: { in: ['planning', 'executing'] } },
      select: { id: true, updatedAt: true, status: true },
    })
    for (const p of candidates) {
      if (isOrchestrating(p.id)) continue // đang chạy trong process này
      // FIX 2026-08-29: tính tín hiệu sống từ TẤT CẢ steps thay vì chỉ 1 row
      // findFirst(orderBy finishedAt/startedAt desc) — bản cũ hay pick nhầm
      // step đã done (finishedAt mới nhất) mà bỏ sót step đang in_progress
      // (finishedAt=null xếp cuối trong DESC của SQLite). Ngoài ra step.updatedAt
      // (Prisma tự update ở MỌI lần ghi: attempts/output/evaluation giữa các
      // lần thử lại) là tín hiệu sống chính xác nhất trong lúc rework.
      let lastSignal = p.updatedAt.getTime()
      const steps = await db.proposalStep.findMany({
        where: { proposalId: p.id },
        select: { startedAt: true, finishedAt: true, updatedAt: true },
      })
      for (const s of steps) {
        lastSignal = Math.max(
          lastSignal,
          s.startedAt?.getTime() ?? 0,
          s.finishedAt?.getTime() ?? 0,
          s.updatedAt.getTime(),
        )
      }
      if (lastSignal >= stalledCutoff.getTime()) continue // còn tín hiệu sống
      await db.selfDirectionProposal.update({
        where: { id: p.id },
        data: { status: 'failed', decisionReason: 'Triển khai bị gián đoạn (server restart?) — bấm "Thử lại" để Omega tiếp tục' },
      })
      console.warn(`[SelfDirection] Proposal ${p.id} đánh dấu failed (stalled > 10 phút, không còn tín hiệu sống)`)
    }
  } catch (err) {
    console.warn('[SelfDirection] promoteDueProposals lỗi (fail-open):', err instanceof Error ? err.message : String(err))
  }
  return triggered
}

/** Ủy quyền đang bật → tự review mọi proposal pending (gọi từ GET proposals) */
export async function autoReviewPendingIfDelegated(): Promise<number> {
  try {
    const settings = await getSelfDirectionSettings()
    if (!settings.omegaDelegated) return 0
    const pending = await db.selfDirectionProposal.findMany({
      where: { status: 'pending' },
      select: { id: true },
      orderBy: { createdAt: 'asc' },
      take: 10,
    })
    return kickOmegaReviewsSerially(pending.map(p => p.id))
  } catch {
    return 0
  }
}

/**
 * FIX 2026-08-29 (429 rate-limit storm): kick nhiều Omega review TUẦN TỰ thay
 * vì song song. Bản cũ void-kick tới 10 review cùng lúc → tất cả đổ dồn vào
 * z-ai-sdk cùng lúc → 429 "Too many requests" (thấy trong log E2E), review
 * fail hàng loạt rồi phải chờ poll heal lại. Chuỗi tuần tự mỗi lần 1 review
 * (reviewingProposals guard vẫn chống double-kick từ poll 4s của UI).
 * Fire-and-forget: trả về số review đã xếp hàng ngay lập tức.
 */
export function kickOmegaReviewsSerially(proposalIds: string[]): number {
  let queued = 0
  const todo: string[] = []
  for (const id of proposalIds) {
    if (reviewingProposals.has(id)) continue // đang review — bỏ qua
    todo.push(id)
    reviewingProposals.add(id) // reserve ngay chống double-queue từ poll xen giữa
    queued++
  }
  if (todo.length === 0) return 0
  void (async () => {
    for (const id of todo) {
      // omegaReviewPending tự check+add lock; vì ta đã reserve ở trên nên gọi
      // inner logic qua wrapper: nhả reservation rồi gọi hàm chính (nó sẽ tự
      // add lại lock của nó) — giữ nguyên 1 đường vào duy nhất.
      reviewingProposals.delete(id)
      try {
        await omegaReviewPending(id)
      } catch { /* đã được xử lý bên trong — fail-open giữ pending */ }
    }
  })()
  return queued
}

// ==================== 8. VALIDATION HELPERS (dùng cho API routes) ====================

export function validateProposalInput(input: Record<string, unknown>): { ok: true; data: {
  title: string; category: string; priority: string; problem: string; solution: string; implementation: string
  scheduleAt: Date | null; impact: string | null; source: string; createdBy: string
} } | { ok: false; error: string } {
  const title = String(input.title || '').trim()
  const problem = String(input.problem || '').trim()
  const solution = String(input.solution || '').trim()
  const implementation = String(input.implementation || '').trim()
  if (!title) return { ok: false, error: 'Thiếu tiêu đề' }
  if (!problem) return { ok: false, error: 'Thiếu phần "Vấn đề là gì?"' }
  if (!solution) return { ok: false, error: 'Thiếu phần "Giải quyết như thế nào?"' }
  if (!implementation) return { ok: false, error: 'Thiếu phần "Triển khai như thế nào?"' }
  const category = VALID_CATEGORIES.includes(String(input.category)) ? String(input.category) : 'improvement'
  const priority = VALID_PRIORITIES.includes(String(input.priority)) ? String(input.priority) : 'medium'
  let scheduleAt: Date | null = null
  if (input.scheduleAt !== undefined && input.scheduleAt !== null && String(input.scheduleAt) !== '') {
    const d = new Date(String(input.scheduleAt))
    if (!Number.isNaN(d.getTime())) scheduleAt = d
  }
  return {
    ok: true,
    data: {
      title: title.slice(0, 200),
      category,
      priority,
      problem: problem.slice(0, 4000),
      solution: solution.slice(0, 4000),
      implementation: implementation.slice(0, 4000),
      scheduleAt,
      impact: input.impact ? String(input.impact).slice(0, 1000) : null,
      source: ['scan', 'agent', 'user', 'omega'].includes(String(input.source)) ? String(input.source) : 'user',
      createdBy: String(input.createdBy || 'user').slice(0, 100),
    },
  }
}
