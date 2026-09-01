/**
 * ALISTA — Proposals Engine (v1.1)
 * ==================================
 * Pipeline proposals TUẦN TỰ:
 *   1. Lấy Findings[] của CHỈ 1 check (đã qua rules deterministic)
 *   2. LLM (kimi-k3) viết 4 phần problem/solution/implementation/impact — JSON
 *   3. Parse + validate (validateProposalInput chuẩn orchestrator.ts)
 *   4. Dedupe theo key `[ALISTA] <slug>:<target>:<yyyymm>` — nếu đã có proposal
 *      còn sống trong 7 ngày → SKIP (chống spam đêm)
 *   5. Fail-safe template: LLM/parse lỗi → sinh văn bản từ evidence + direction
 *      (pipeline KHÔNG bao giờ chết vì LLM)
 *   6. createSelfDirectionProposal với source:'agent', createdBy:'ALISTA',
 *      scheduleAt=null (low/medium) hoặc 08:00 hôm sau (high/critical)
 *
 * Cap: ≤3 proposals/1 check, ≤6 proposals/1 ca trực (cap chung ở comprehensive-check.ts)
 */

import { db } from '@/lib/db'
import { callLLMForAgent } from '@/lib/llm'
import { findBalancedJson } from '@/lib/code-team/find-balanced-json'
import { createSelfDirectionProposal } from '@/lib/self-direction/orchestrator'
import { classifyExecutionMode } from '@/lib/self-direction/scan'
import type { Finding, CreatedProposal, ProposalInput } from './types'
import { STEP_LABELS } from './types'

// ==================== CONSTANTS ====================

const ALISTA_AGENT_NAME = 'ALISTA'
const ALISTA_BRAIN = { provider: 'nvidia', model: 'moonshotai/kimi-k3' }
const LLM_TIMEOUT_MS = 60_000 // mỗi LLM call có timeout riêng — chống kẹt >6h
const MAX_PROPOSALS_PER_CHECK = 3
const DEDUPE_WINDOW_DAYS = 7

/** Status còn sống → không tạo proposal trùng key */
const LIVE_STATUSES = ['pending', 'approved', 'ready', 'planning', 'executing']

// ==================== Z-AI SDK FALLBACK (đồng bộ scan.ts) ====================

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
        console.warn('[ALISTA][proposals] z-ai-sdk init failed:', err instanceof Error ? err.message : String(err))
        return null
      }
    })()
  }
  return zaiSdkInitPromise.then(r => r)
}

async function tryZaiSdk(prompt: string, systemPrompt: string): Promise<string | null> {
  try {
    const sdk = await getZaiSdk()
    if (!sdk) return null
    const messages = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: prompt },
    ]
    const res = (await sdk.chat.completions.create({ messages })) as {
      choices?: Array<{ message?: { content?: string } }>
    }
    return res?.choices?.[0]?.message?.content ?? ''
  } catch (err) {
    console.warn('[ALISTA][proposals] z-ai-sdk fallback failed:', err instanceof Error ? err.message : String(err))
    return null
  }
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

// ==================== SYSTEM PROMPT ====================

const ALISTA_SYSTEM_PROMPT = `Bạn là ALISTA — Kỹ sư Bảo trì Hệ thống của The Magnum Opus (TMO). Ca trực 23h30 hàng ngày, budget 6h (đến 05:30 hôm sau).

Bạn đang ở bước ${'<STEP>'} trong pipeline kiểm tra toàn diện 7 bước. Đã có FINDINGS (do rules deterministic sinh ra từ dữ liệu thật). Nhiệm vụ của bạn: viết 4 phần proposal Self-Direction cho từng finding — problem/solution/implementation/impact.

NGUYÊN TẮC VÀNG:
1. KHÔNG bịa số liệu — chỉ dùng số liệu đã có trong findings.evidence.
2. Tiếng Việt, ngắn gọn (≤2.000 ký tự/phần).
3. 4 phần rõ ràng: Vấn đề là gì / Giải quyết như thế nào / Triển khai như thế nào (các bước cụ thể) / Tác động kỳ vọng (1 câu).
4. Mỗi proposal phải có "key" đúng với key trong finding (để pipeline dedupe).
5. output JSON hợp lệ duy nhất — KHÔNG markdown fence:
{"proposals":[{"key":"<key>","title":"<tiêu đề ngắn tiếng Việt>","problem":"...","solution":"...","implementation":"...","impact":"..."}]}`

// ==================== PROMPT BUILDER ====================

function buildUserPrompt(checkId: number, checkLabel: string, findings: Finding[]): string {
  const lines: string[] = []
  lines.push(`BƯỚC ${checkId}: ${checkLabel}`)
  lines.push('')
  lines.push(`FINDINGS (${findings.length} phát hiện có vấn đề từ rules deterministic):`)
  lines.push('')
  findings.forEach((f, i) => {
    lines.push(`--- FINDING ${i + 1} ---`)
    lines.push(`KEY: ${f.key}`)
    lines.push(`CATEGORY: ${f.category}`)
    lines.push(`PRIORITY: ${f.priority}`)
    lines.push(`TARGET: ${f.target}`)
    lines.push(`EVIDENCE: ${JSON.stringify(f.evidence)}`)
    lines.push(`DIRECTION (gợi ý giải pháp): ${f.direction}`)
    lines.push('')
  })
  lines.push(`Hãy viết ${findings.length} proposal (1 per finding) theo format JSON đã nêu. Output DUY NHẤT JSON hợp lệ.`)
  return lines.join('\n')
}

// ==================== LLM SYNTHESIS ====================

interface LLMProposalDraft {
  key: string
  title: string
  problem: string
  solution: string
  implementation: string
  impact: string | null
}

async function synthesizeWithLLM(
  checkId: number,
  checkLabel: string,
  findings: Finding[],
): Promise<{ drafts: LLMProposalDraft[]; usedFallback: boolean }> {
  const systemPrompt = ALISTA_SYSTEM_PROMPT.replace('<STEP>', `${checkId}/7: ${checkLabel}`)
  const userPrompt = buildUserPrompt(checkId, checkLabel, findings)

  let raw: string | null = null

  // Lần 1: callLLMForAgent (kimi-k3 enforced + fallback chain)
  try {
    const result = await withTimeout(
      callLLMForAgent(userPrompt, ALISTA_BRAIN, systemPrompt, {
        agentName: ALISTA_AGENT_NAME,
        agentId: 'alista',
        temperature: 0.3,
        maxTokens: 3000,
      }),
      LLM_TIMEOUT_MS,
      `ALISTA LLM check ${checkId}`,
    )
    if (result.content && result.content.trim()) raw = result.content.trim()
  } catch (err) {
    console.warn(`[ALISTA][proposals] LLM call fail (check ${checkId}):`, err instanceof Error ? err.message : String(err))
  }

  // Lần 2: z-ai-sdk fallback (text-only — vẫn OK vì parse JSON từ text)
  if (!raw) {
    try {
      const zaiText = await withTimeout(
        tryZaiSdk(userPrompt, systemPrompt),
        LLM_TIMEOUT_MS,
        `ALISTA zai-sdk check ${checkId}`,
      )
      if (zaiText && zaiText.trim()) raw = zaiText.trim()
    } catch (err) {
      console.warn(`[ALISTA][proposals] z-ai-sdk fallback fail (check ${checkId}):`, err instanceof Error ? err.message : String(err))
    }
  }

  if (!raw) return { drafts: [], usedFallback: true }

  // Parse JSON
  try {
    const jsonStr = findBalancedJson(raw.replace(/```(?:json)?/g, ''), 'proposals')
    if (!jsonStr) return { drafts: [], usedFallback: true }
    const obj = JSON.parse(jsonStr) as Record<string, unknown>
    const arr = Array.isArray(obj.proposals) ? obj.proposals : []
    const drafts: LLMProposalDraft[] = []
    for (const item of arr.slice(0, MAX_PROPOSALS_PER_CHECK)) {
      if (!item || typeof item !== 'object') continue
      const p = item as Record<string, unknown>
      const key = String(p.key || '').trim()
      const title = String(p.title || '').trim()
      const problem = String(p.problem || '').trim()
      const solution = String(p.solution || '').trim()
      const implementation = String(p.implementation || '').trim()
      if (!key || !title || !problem || !solution || !implementation) continue
      drafts.push({
        key, title: title.slice(0, 200),
        problem: problem.slice(0, 4000),
        solution: solution.slice(0, 4000),
        implementation: implementation.slice(0, 4000),
        impact: p.impact ? String(p.impact).slice(0, 1000) : null,
      })
    }
    return { drafts, usedFallback: false }
  } catch (err) {
    console.warn(`[ALISTA][proposals] LLM JSON parse fail (check ${checkId}):`, err instanceof Error ? err.message : String(err))
    return { drafts: [], usedFallback: true }
  }
}

// ==================== FAIL-SAFE TEMPLATE (khi LLM/parse fail) ====================

function fallbackFromFindings(findings: Finding[]): LLMProposalDraft[] {
  return findings.slice(0, MAX_PROPOSALS_PER_CHECK).map(f => {
    // Title = `[ALISTA] <slug>:<target>:<yyyymm> — <short label>`
    const shortLabel = (f.direction.split('.')[0] || f.direction).slice(0, 100)
    return {
      key: f.key,
      title: `${f.key} — ${shortLabel}`,
      problem: `Vấn đề phát hiện qua collector ${f.checkLabel} (target: ${f.target}). Bằng chứng: ${JSON.stringify(f.evidence)}. Priority: ${f.priority}, category: ${f.category}.`,
      solution: f.direction,
      implementation: `1) Điều tra root cause của vấn đề này; 2) Áp dụng phương án đã nêu trong solution; 3) Verify kết quả bằng metrics trước-sau; 4) Thêm regression test/guard để không lặp lại.`,
      impact: `Giảm tái diễn vấn đề, tăng độ tin cậy của subsystem ${f.checkLabel}.`,
    }
  })
}

// ==================== DEDUPE ====================

/** Query existing proposals còn sống với key prefix — chống spam đêm */
async function findLiveProposalsByKeyPrefix(keyPrefixes: string[]): Promise<Map<string, string>> {
  // Map<keyPrefix, existingTitle> — nếu title.startsWith(keyPrefix) → đã có
  const out = new Map<string, string>()
  if (keyPrefixes.length === 0) return out
  try {
    const cutoff = new Date(Date.now() - DEDUPE_WINDOW_DAYS * 24 * 3600_000)
    // Prisma doesn't have startsWith on title directly without mode — use findMany + filter
    // Optimize: query with where clause to limit, then filter in-memory
    const rows = await db.selfDirectionProposal.findMany({
      where: {
        createdBy: ALISTA_AGENT_NAME,
        status: { in: LIVE_STATUSES },
        createdAt: { gte: cutoff },
      },
      select: { title: true, status: true },
      take: 500,
    })
    for (const r of rows) {
      for (const prefix of keyPrefixes) {
        if (r.title.startsWith(prefix)) {
          out.set(prefix, r.title)
          break
        }
      }
    }
  } catch (err) {
    console.warn('[ALISTA][proposals] dedupe query fail (fail-open — sẽ tạo trùng):', err instanceof Error ? err.message : String(err))
  }
  return out
}

// ==================== SCHEDULE AT ====================

/** Low/medium → null (triển khai ngay khi duyệt). High/critical → 08:00 hôm sau (giờ VN) */
function computeScheduleAt(priority: string): Date | null {
  if (priority === 'high' || priority === 'critical') {
    // 08:00 hôm sau theo giờ VN (Asia/Ho_Chi_Minh = UTC+7)
    const now = new Date()
    const tomorrow = new Date(now.getTime() + 24 * 3600_000)
    // Format hôm sau theo tz HN
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Ho_Chi_Minh',
      year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(tomorrow)
    const y = parts.find(p => p.type === 'year')!.value
    const m = parts.find(p => p.type === 'month')!.value
    const d = parts.find(p => p.type === 'day')!.value
    return new Date(`${y}-${m}-${d}T08:00:00+07:00`)
  }
  return null
}

// ==================== MAIN: CREATE PROPOSALS FOR CHECK ====================

/**
 * Tạo proposal cho 1 check (TUẦN TỰ — chỉ 1 check tại 1 thời điểm).
 * @param checkId 1-7
 * @param findings từ rules
 * @param deadlineMs deadline cứng — check ngay trước khi gọi LLM (re-check)
 * @returns CreatedProposal[] (created=true → tạo mới; created=false → skip do dedupe)
 */
export async function createProposalsForCheck(
  checkId: number,
  findings: Finding[],
  opts: { deadlineMs: number },
): Promise<CreatedProposal[]> {
  if (findings.length === 0) return []
  // Re-check deadline trước khi gọi LLM (pipeline tuần tự có thể đã trượt)
  if (Date.now() >= opts.deadlineMs) {
    console.warn(`[ALISTA][proposals] check ${checkId}: trượt deadline trước LLM — skip ${findings.length} findings`)
    return []
  }

  const checkLabel = STEP_LABELS[checkId as 1 | 2 | 3 | 4 | 5 | 6 | 7] || `Check ${checkId}`

  // 1. LLM synthesis (fail-safe template nếu LLM/parse lỗi)
  let { drafts, usedFallback } = await synthesizeWithLLM(checkId, checkLabel, findings)
  if (drafts.length === 0) {
    console.log(`[ALISTA][proposals] check ${checkId}: LLM không trả draft hợp lệ — dùng fallback template từ evidence`)
    drafts = fallbackFromFindings(findings)
    usedFallback = true
  }

  // Re-check deadline sau LLM
  if (Date.now() >= opts.deadlineMs) {
    console.warn(`[ALISTA][proposals] check ${checkId}: trượt deadline sau LLM — skip tạo proposal`)
    return []
  }

  // 2. Dedupe — query live proposals theo key prefix
  const keyPrefixes = drafts.map(d => d.key)
  const liveMap = await findLiveProposalsByKeyPrefix(keyPrefixes)

  // 3. Match draft với finding (để lấy category/priority thật — không tin LLM)
  const findingByKey = new Map(findings.map(f => [f.key, f]))

  // 4. Tạo từng proposal
  const created: CreatedProposal[] = []
  for (const draft of drafts.slice(0, MAX_PROPOSALS_PER_CHECK)) {
    const finding = findingByKey.get(draft.key) || findings.find(f => draft.key.startsWith(f.key))
    if (!finding) {
      // Draft không match finding nào → skip (safety)
      created.push({ id: '', title: draft.title, created: false, skipReason: 'draft key không match finding' })
      continue
    }

    // Dedupe check
    const existingTitle = liveMap.get(draft.key)
    if (existingTitle) {
      created.push({ id: '', title: existingTitle, created: false, skipReason: 'đã có proposal còn sống (dedupe)' })
      continue
    }

    // Build ProposalInput — category/priority LẤY TỪ RULES (không tin LLM)
    const scheduleAt = computeScheduleAt(finding.priority)
    const executionMode = classifyExecutionMode({
      category: finding.category,
      problem: draft.problem,
      solution: draft.solution,
    })

    try {
      const row = await createSelfDirectionProposal({
        title: `${draft.key} — ${draft.title}`,
        category: finding.category,
        priority: finding.priority,
        problem: draft.problem,
        solution: draft.solution,
        implementation: draft.implementation,
        impact: draft.impact,
        scheduleAt,
        status: 'pending',
        source: 'agent',
        createdBy: ALISTA_AGENT_NAME,
        executionMode,
      })
      created.push({ id: row.id, title: row.title, created: true })
      // Update dedupe map in-memory để chống trùng trong cùng ca
      liveMap.set(draft.key, row.title)
    } catch (err) {
      console.error(`[ALISTA][proposals] tạo proposal fail (key=${draft.key}):`, err instanceof Error ? err.message : String(err))
      created.push({ id: '', title: draft.title, created: false, skipReason: `create fail: ${err instanceof Error ? err.message : String(err)}` })
    }
  }

  if (usedFallback) {
    console.log(`[ALISTA][proposals] check ${checkId}: dùng fallback template — tạo ${created.filter(c => c.created).length}/${drafts.length} proposal`)
  } else {
    console.log(`[ALISTA][proposals] check ${checkId}: LLM synthesis OK — tạo ${created.filter(c => c.created).length}/${drafts.length} proposal (skip ${created.filter(c => !c.created).length} do dedupe)`)
  }

  return created
}

/** Helper export ProposalInput type (cho index.ts barrel) */
export type { ProposalInput }
