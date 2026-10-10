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
import type { Finding, CreatedProposal, ProposalInput, SuccessCriteria } from './types'
import { STEP_LABELS, baseKeyOf } from './types'

// ==================== CONSTANTS ====================

const ALISTA_AGENT_NAME = 'ALISTA'
// 2026-09-24 (USER DIRECTIVE): ALISTA → zen/muse-spark-1.3-contributor-free.
// Fail-open: DB error → fallback zen space-bunny-free (minimax-m3 cũ đã EOL 410
// — loại bỏ 2026-11-30).
const ALISTA_FALLBACK_BRAIN = { provider: 'zen', model: 'space-bunny-free' }

/**
 * Resolve ALISTA brain from DB AgentProfile (mirror resolveOmegaBrain pattern).
 * Reads provider/model từ DB (set = zen/muse-spark-1.3-contributor-free).
 * Fail-open: DB error → fallback zen space-bunny-free.
 */
async function resolveAlistaBrain(): Promise<{ provider: string; model: string }> {
  try {
    const alista = await db.agentProfile.findFirst({
      where: { name: ALISTA_AGENT_NAME, enabled: true },
      select: { provider: true, model: true },
    })
    if (alista && alista.provider && alista.model) {
      return { provider: alista.provider, model: alista.model }
    }
  } catch { /* fail-open */ }
  return ALISTA_FALLBACK_BRAIN
}
// Task 20 (2026-09-03): 60s cũ giết chuỗi fallback trước khi tới lượt
// (lịch sử: chuỗi NIM cần ~460s — giữ trần 600s);
// prober (llm.ts) trip breaker cho lõi hang nên call thường trở lại ~giây.
const LLM_TIMEOUT_MS = Math.max(30_000, parseInt(process.env.ALISTA_LLM_TIMEOUT_MS || '600000', 10) || 600_000)
const MAX_PROPOSALS_PER_CHECK = 3
const DEDUPE_WINDOW_DAYS = 7

/** Status còn sống → không tạo proposal trùng key */
const LIVE_STATUSES = ['pending', 'approved', 'ready', 'planning', 'executing']

// ━━ REMOVED 2026-10-15 (user directive): gỡ bỏ fallback z-ai-web-dev-sdk —
// sdk chỉ tồn tại trong sandbox triển khai, không có trên máy local của user
// (không nằm trong package.json). LLM synthesis giờ chỉ qua callLLMForAgent
// (chuỗi NVIDIA kimi-k3 → fallback chain); LLM lỗi → fallback template từ
// evidence (pipeline KHÔNG bao giờ chết vì LLM — nguyên tắc fail-safe giữ nguyên). ━━

export async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
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
5. SUCCESS_CRITERIA của mỗi finding là TIÊU CHÍ XÁC NHẬN HIỆU QUẢ giải pháp — đưa nguyên vẹn vào cuối phần implementation (pipeline sẽ tự append nếu thiếu).
6. output JSON hợp lệ duy nhất — KHÔNG markdown fence:
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
    if (f.successCriteria) {
      lines.push(`SUCCESS_CRITERIA (tiêu chí xác nhận hiệu quả — đưa vào cuối implementation): ${JSON.stringify(f.successCriteria)}`)
    }
    lines.push(`DIRECTION (gợi ý giải pháp): ${f.direction}`)
    lines.push('')
  })
  lines.push(`Hãy viết ${findings.length} proposal (1 per finding) theo format JSON đã nêu. Output DUY NHẤT JSON hợp lệ.`)
  return lines.join('\n')
}

// ==================== SUCCESS CRITERIA TEXT (v1.3) ====================

/** Format criteria thành khối text tiếng Việt — đưa vào implementation của proposal */
function formatSuccessCriteria(c: SuccessCriteria): string {
  const ops: Record<string, string> = { gte: '≥', lte: '≤', eq: '=' }
  const op = ops[c.operator] ?? '='
  const recheckTxt = c.recheckAfterMs > 0
    ? `ALISTA sẽ đo lại sau ${formatDuration(c.recheckAfterMs)} khi proposal hoàn tất (${c.recheckWhy})`
    : 'ALISTA đo lại NGAY khi proposal hoàn tất (metric phản ánh tức thời)'
  return `🎯 TIÊU CHÍ XÁC NHẬN HIỆU QUẢ (ALISTA tự kiểm định): metric "${c.metric}" từ mức hiện tại ${c.current} phải đạt ${op} ${c.target}. ${recheckTxt}.`
}

/** Format ms → text tiếng Việt (vd '48 giờ', '1 giờ') */
function formatDuration(ms: number): string {
  const hours = ms / 3600_000
  if (hours >= 24 && Number.isInteger(hours / 24)) return `${hours / 24} ngày`
  if (hours >= 1) return `${Math.round(hours * 10) / 10} giờ`
  return `${Math.round(ms / 60_000)} phút`
}

/** Đảm bảo implementation có khối criteria — append nếu LLM quên (guaranteed) */
function ensureCriteriaInImplementation(implementation: string, c: SuccessCriteria | undefined): string {
  if (!c) return implementation
  const marker = 'TIÊU CHÍ XÁC NHẬN HIỆU QUẢ'
  if (implementation.includes(marker)) return implementation
  return `${implementation}\n\n${formatSuccessCriteria(c)}`
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
): Promise<{ drafts: LLMProposalDraft[]; source: 'kimi' | 'template' }> {
  const systemPrompt = ALISTA_SYSTEM_PROMPT.replace('<STEP>', `${checkId}/7: ${checkLabel}`)
  const userPrompt = buildUserPrompt(checkId, checkLabel, findings)

  let raw: string | null = null
  let source: 'kimi' | 'template' = 'template'

  // Lần 1: callLLMForAgent (Zen muse-spark free → fallback NIM kimi-k3 chain)
  try {
    const brain = await resolveAlistaBrain()
    const result = await withTimeout(
      callLLMForAgent(userPrompt, brain, systemPrompt, {
        agentName: ALISTA_AGENT_NAME,
        agentId: 'alista',
        temperature: 0.3,
        maxTokens: 3000,
      }),
      LLM_TIMEOUT_MS,
      `ALISTA LLM check ${checkId}`,
    )
    if (result.content && result.content.trim()) {
      raw = result.content.trim()
      source = 'kimi'
    }
  } catch (err) {
    console.warn(`[ALISTA][proposals] LLM call fail (check ${checkId}):`, err instanceof Error ? err.message : String(err))
  }

  // (2026-10-15) z-ai-sdk fallback đã GỠ BỎ (user directive — sdk không có trên
  // local). LLM lỗi → return drafts rỗng → caller dùng fallback template.

  if (!raw) return { drafts: [], source: 'template' }

  // Parse JSON
  try {
    const jsonStr = findBalancedJson(raw.replace(/```(?:json)?/g, ''), 'proposals')
    if (!jsonStr) return { drafts: [], source: 'template' }
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
    if (drafts.length === 0) return { drafts: [], source: 'template' }
    return { drafts, source }
  } catch (err) {
    console.warn(`[ALISTA][proposals] LLM JSON parse fail (check ${checkId}):`, err instanceof Error ? err.message : String(err))
    return { drafts: [], source: 'template' }
  }
}

// ==================== FAIL-SAFE TEMPLATE (khi LLM/parse fail) ====================

function fallbackFromFindings(findings: Finding[], followUpFor?: FollowUpContext): LLMProposalDraft[] {
  return findings.slice(0, MAX_PROPOSALS_PER_CHECK).map(f => {
    // Title = `[ALISTA] <slug>:<target>:<yyyymm>[:vN] — <short label>`
    const shortLabel = (f.direction.split('.')[0] || f.direction).slice(0, 100)
    const implementation = `1) Điều tra root cause của vấn đề này; 2) Áp dụng phương án đã nêu trong solution; 3) Verify kết quả bằng metrics trước-sau; 4) Thêm regression test/guard để không lặp lại.`
    return {
      key: f.key,
      title: `${f.key} — ${shortLabel}`,
      problem: followUpProblemPrefix(followUpFor, f) + `Vấn đề phát hiện qua collector ${f.checkLabel} (target: ${f.target}). Bằng chứng: ${JSON.stringify(f.evidence)}. Priority: ${f.priority}, category: ${f.category}.`,
      solution: f.direction,
      implementation: ensureCriteriaInImplementation(implementation, f.successCriteria),
      impact: f.successCriteria
        ? `Khi metric "${f.successCriteria.metric}" đạt ${f.successCriteria.target} — vấn đề được xác nhận là đã xử lý triệt để.`
        : `Giảm tái diễn vấn đề, tăng độ tin cậy của subsystem ${f.checkLabel}.`,
    }
  })
}

// ==================== FOLLOW-UP (v1.2 — xác minh sau khi Self-Direction hoàn tất) ====================

/**
 * Context follow-up — khi ALISTA nhận thông tin đề xuất cũ đã được phê duyệt +
 * xử lý hoàn tất và xác minh lại thấy vấn đề chưa triệt để (hoặc phát hiện mới).
 */
export interface FollowUpContext {
  /** ID proposal gốc đã completed */
  proposalId: string
  /** Title proposal gốc (để trích dẫn trong problem) */
  proposalTitle: string
  /** Thời điểm completed */
  completedAt: Date
  /** Base key gốc `[ALISTA] <slug>:<target>:<yyyymm>` — follow-up key = `<base>:v<N>` */
  baseKey: string
  /** Trigger nguồn verification: 'completion-hook' (ngay khi hoàn tất) | 'sweep' (an toàn 60s) */
  trigger?: 'completion-hook' | 'sweep'
}

/** So khớp 2 key cùng VẤN ĐỀ (slug:target) — bỏ qua yyyymm (lệch tháng) + hậu tố :vN */
function sameIssue(a: string, b: string): boolean {
  const normalize = (k: string) => {
    const base = baseKeyOf(k)
    const m = base.match(/^\[ALISTA\]\s+([a-z_]+):([^:]+):\d{6}/i)
    return m ? `${m[1].toLowerCase()}:${m[2].toLowerCase()}` : base.toLowerCase()
  }
  return normalize(a) === normalize(b)
}

/** Prefix problem cho proposal follow-up — phân biệt 2 flavor */
function followUpProblemPrefix(followUpFor: FollowUpContext | undefined, finding: Finding): string {
  if (!followUpFor) return ''
  const completedStr = new Intl.DateTimeFormat('vi-VN', {
    timeZone: 'Asia/Ho_Chi_Minh', day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  }).format(followUpFor.completedAt)
  // Finding cùng target với proposal gốc → "vẫn chưa triệt để"; khác → "phát hiện mới"
  const isOriginalTarget = sameIssue(finding.key, followUpFor.baseKey)
  if (isOriginalTarget) {
    return `⟲ FOLLOW-UP — Đề xuất gốc #${followUpFor.proposalId} "${followUpFor.proposalTitle.slice(0, 120)}" đã được phê duyệt và xử lý hoàn tất (${completedStr} giờ VN), nhưng ALISTA xác minh lại thấy vấn đề CHƯA được xử lý triệt để. `
  }
  return `⟲ FOLLOW-UP — Sau khi đề xuất gốc #${followUpFor.proposalId} "${followUpFor.proposalTitle.slice(0, 120)}" hoàn tất (${completedStr} giờ VN), ALISTA xác minh lại và phát hiện VẤN ĐỀ MỚI trong cùng khu vực kiểm tra. `
}

/** Đếm số proposal đã có với base key (gốc + các follow-up :v1..vN) → seq kế tiếp */
async function nextFollowUpKey(baseKey: string): Promise<string> {
  try {
    const count = await db.selfDirectionProposal.count({
      where: { createdBy: ALISTA_AGENT_NAME, title: { startsWith: baseKey } },
    })
    return `${baseKey}:v${count + 1}`
  } catch {
    return `${baseKey}:v1` // fail-open — dedupe LIVE 7d vẫn chống spam
  }
}

// ==================== DEDUPE ====================

/** Query existing proposals còn sống với key prefix — chống spam đêm
 *  FIX v1.2: prefix được strip hậu tố `:vN` (base key) — proposal gốc và
 *  follow-up là CÙNG một vấn đề, live proposal gốc chặn follow-up trùng và ngược lại. */
async function findLiveProposalsByKeyPrefix(keyPrefixes: string[]): Promise<Map<string, string>> {
  // Map<baseKey, existingTitle> — nếu title.startsWith(baseKey) → đã có
  const out = new Map<string, string>()
  if (keyPrefixes.length === 0) return out
  try {
    const cutoff = new Date(Date.now() - DEDUPE_WINDOW_DAYS * 24 * 3600_000)
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

// ==================== RECURRENCE (v1.3) ====================

/** Rank priority để so sánh + bump khi vấn đề tái diễn */
const PRIORITY_RANK: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 }

/**
 * (v1.3) Đếm số lần ALISTA đã đề xuất cùng vấn đề (base key prefix — mọi trạng
 * thái, kể cả completed/rejected) + lần gần nhất. Vấn đề dai dẳng = đề xuất
 * nhiều lần vẫn tái xuất hiện → annotate vào problem + bump priority.
 */
interface RecurrenceInfo { count: number; lastProposedAt: Date | null }

async function findRecurrenceInfo(baseKeys: string[]): Promise<Map<string, RecurrenceInfo>> {
  const out = new Map<string, RecurrenceInfo>()
  if (baseKeys.length === 0) return out
  try {
    // Query 1 lần toàn bộ proposal của ALISTA (mới nhất trước) rồi group theo
    // base key prefix — rẻ hơn N query prefix riêng lẻ (prefix không index được).
    const rows = await db.selfDirectionProposal.findMany({
      where: { createdBy: ALISTA_AGENT_NAME },
      orderBy: { createdAt: 'desc' },
      select: { title: true, createdAt: true },
      take: 500,
    })
    for (const r of rows) {
      for (const bk of baseKeys) {
        if (!r.title.startsWith(bk)) continue
        const cur = out.get(bk) ?? { count: 0, lastProposedAt: null }
        cur.count += 1
        // rows desc — row đầu gặp là mới nhất
        if (!cur.lastProposedAt) cur.lastProposedAt = r.createdAt
        out.set(bk, cur)
      }
    }
  } catch (err) {
    console.warn('[ALISTA][proposals] recurrence query fail (fail-open):', err instanceof Error ? err.message : String(err))
  }
  return out
}

/** Prefix problem khi vấn đề tái diễn — đánh dấu độ dai dẳng cho owner */
function recurrenceProblemPrefix(info: RecurrenceInfo | undefined): string {
  if (!info || info.count === 0) return ''
  const lastStr = info.lastProposedAt
    ? new Intl.DateTimeFormat('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', day: '2-digit', month: '2-digit' }).format(info.lastProposedAt)
    : 'không rõ'
  return `⚠ TÁI DIỄN (lần đề xuất thứ ${info.count + 1} cho cùng vấn đề — lần gần nhất ${lastStr} giờ VN, vẫn chưa xử lý dứt điểm). `
}

/**
 * Bump priority khi vấn đề dai dẳng — DETERMINISTIC (không phải LLM quyết):
 *   recurrence ≥ 4 → tối thiểu 'high' · ≥ 2 → tối thiểu 'medium'
 */
function bumpPriorityByRecurrence(priority: string, recurrenceCount: number): string {
  if (recurrenceCount >= 4 && (PRIORITY_RANK[priority] ?? 99) > PRIORITY_RANK.high) return 'high'
  if (recurrenceCount >= 2 && (PRIORITY_RANK[priority] ?? 99) > PRIORITY_RANK.medium) return 'medium'
  return priority
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
 * @param opts.deadlineMs deadline cứng — check ngay trước khi gọi LLM (re-check)
 * @param opts.followUpFor (v1.2) context xác minh lại đề xuất đã hoàn tất —
 *        finding cùng target với base key gốc → key follow-up `<base>:v<N>`,
 *        problem có prefix ⟲ FOLLOW-UP; finding khác target → key follow-up
 *        trên base của chính nó (phát hiện mới sau khi xử lý).
 * @returns CreatedProposal[] (created=true → tạo mới; created=false → skip do dedupe)
 */
export async function createProposalsForCheck(
  checkId: number,
  findings: Finding[],
  opts: { deadlineMs: number; followUpFor?: FollowUpContext },
): Promise<CreatedProposal[]> {
  if (findings.length === 0) return []
  // Re-check deadline trước khi gọi LLM (pipeline tuần tự có thể đã trượt)
  if (Date.now() >= opts.deadlineMs) {
    console.warn(`[ALISTA][proposals] check ${checkId}: trượt deadline trước LLM — skip ${findings.length} findings`)
    return []
  }

  const checkLabel = STEP_LABELS[checkId as 1 | 2 | 3 | 4 | 5 | 6 | 7] || `Check ${checkId}`
  const followUpFor = opts.followUpFor

  // 0. (v1.2) Follow-up mode → override key các finding sang key follow-up `<base>:v<N>`
  // TRƯỚC khi build prompt (LLM echo đúng key mới) — dùng base key GỐC từ đề xuất
  // đã hoàn tất cho finding cùng vấn đề (sameIssue — bỏ qua lệch yyyymm),
  // base riêng cho finding phát hiện mới.
  if (followUpFor) {
    const remapped: Finding[] = []
    for (const f of findings) {
      const useOriginalBase = sameIssue(f.key, followUpFor.baseKey)
      const baseKey = useOriginalBase ? baseKeyOf(followUpFor.baseKey) : baseKeyOf(f.key)
      const followKey = await nextFollowUpKey(baseKey)
      remapped.push({ ...f, key: followKey })
    }
    findings = remapped
  }

  // 1. LLM synthesis (fail-safe template nếu LLM/parse lỗi)
  const { drafts: rawDrafts, source: llmSource } = await synthesizeWithLLM(checkId, checkLabel, findings)
  let drafts = rawDrafts
  if (drafts.length === 0) {
    console.log(`[ALISTA][proposals] check ${checkId}: LLM không trả draft hợp lệ — dùng fallback template từ evidence`)
    drafts = fallbackFromFindings(findings, followUpFor)
  }

  // Re-check deadline sau LLM
  if (Date.now() >= opts.deadlineMs) {
    console.warn(`[ALISTA][proposals] check ${checkId}: trượt deadline sau LLM — skip tạo proposal`)
    return []
  }

  // 1b. (v1.2) Chuẩn hoá key LLM echo — chống lệch key khỏi finding (bypass dedupe):
  // match loose (prefix 2 chiều) về finding gần nhất rồi GHI ĐÈ key draft.
  const findingByKey = new Map(findings.map(f => [f.key, f]))
  for (const d of drafts) {
    if (findingByKey.has(d.key)) continue
    const loose = findings.find(f => d.key.startsWith(f.key) || f.key.startsWith(d.key))
    if (loose) d.key = loose.key
  }

  // 1c. (v1.3) Recurrence — đếm số lần đã đề xuất cùng vấn đề (base key,
  //      mọi trạng thái). Vấn đề dai dẳng → annotate problem + bump priority.
  const recurrenceBaseKeys = Array.from(new Set(findings.map(f => baseKeyOf(f.key))))
  const recurrenceMap = await findRecurrenceInfo(recurrenceBaseKeys)

  // 2. Dedupe — query live proposals theo BASE key prefix (strip `:vN`)
  const keyPrefixes = Array.from(new Set(drafts.map(d => baseKeyOf(d.key))))
  const liveMap = await findLiveProposalsByKeyPrefix(keyPrefixes)

  // 3. Match draft với finding (để lấy category/priority thật — không tin LLM)
  //    (findingByKey đã build ở 1b)

  // 4. Tạo từng proposal
  const created: CreatedProposal[] = []
  for (const draft of drafts.slice(0, MAX_PROPOSALS_PER_CHECK)) {
    const finding = findingByKey.get(draft.key) || findings.find(f => baseKeyOf(draft.key) === baseKeyOf(f.key))
    if (!finding) {
      // Draft không match finding nào → skip (safety)
      created.push({ id: '', title: draft.title, created: false, skipReason: 'draft key không match finding' })
      continue
    }

    // Dedupe check (theo base key — gốc và follow-up cùng chặn nhau trong 7 ngày LIVE)
    const existingTitle = liveMap.get(baseKeyOf(draft.key))
    if (existingTitle) {
      created.push({ id: '', title: existingTitle, created: false, skipReason: 'đã có proposal còn sống (dedupe 7 ngày)' })
      continue
    }

    // (v1.3) Recurrence — annotate + bump priority (deterministic, không LLM)
    const recInfo = recurrenceMap.get(baseKeyOf(draft.key))
    const effectivePriority = bumpPriorityByRecurrence(finding.priority, recInfo?.count ?? 0)
    if (effectivePriority !== finding.priority) {
      console.log(`[ALISTA][proposals] check ${checkId}: bump priority ${finding.priority} → ${effectivePriority} (vấn đề tái diễn ${recInfo?.count} lần) — key=${draft.key}`)
    }

    // Build ProposalInput — category/priority LẤY TỪ RULES (+ bump recurrence) — không tin LLM
    const scheduleAt = computeScheduleAt(effectivePriority)
    const executionMode = classifyExecutionMode({
      category: finding.category,
      problem: draft.problem,
      solution: draft.solution,
    })
    // (v1.2) Prefix ⟲ FOLLOW-UP + (v1.3) prefix ⚠ TÁI DIỄN vào problem
    const problem = (followUpFor
      ? followUpProblemPrefix(followUpFor, finding)
      : '') + recurrenceProblemPrefix(recInfo) + draft.problem

    // (v1.3) Criteria append guaranteed — LLM có thể quên đưa SUCCESS_CRITERIA
    const implementation = ensureCriteriaInImplementation(draft.implementation, finding.successCriteria)

    try {
      const row = await createSelfDirectionProposal({
        // FIX v1.2: truncate 200 chars — khớp contract validateProposalInput
        title: `${draft.key} — ${draft.title}`.slice(0, 200),
        category: finding.category,
        priority: effectivePriority,
        problem: problem.slice(0, 4000),
        solution: draft.solution,
        implementation,
        impact: draft.impact,
        scheduleAt,
        status: 'pending',
        source: 'agent',
        createdBy: ALISTA_AGENT_NAME,
        executionMode,
      })
      created.push({ id: row.id, title: row.title, created: true })
      // Update dedupe map in-memory (base key) để chống trùng trong cùng ca
      liveMap.set(baseKeyOf(draft.key), row.title)
    } catch (err) {
      console.error(`[ALISTA][proposals] tạo proposal fail (key=${draft.key}):`, err instanceof Error ? err.message : String(err))
      created.push({ id: '', title: draft.title, created: false, skipReason: `create fail: ${err instanceof Error ? err.message : String(err)}` })
    }
  }

  // (v1.2) Log chính xác nguồn văn bản + lý do skip từng loại
  const createdCount = created.filter(c => c.created).length
  const skipDedupe = created.filter(c => !c.created && c.skipReason?.includes('dedupe')).length
  const skipOther = created.filter(c => !c.created && !c.skipReason?.includes('dedupe')).length
  const mode = followUpFor ? ` FOLLOW-UP #${followUpFor.proposalId}` : ''
  console.log(
    `[ALISTA][proposals] check ${checkId}${mode}: nguồn=${llmSource} — tạo ${createdCount}/${drafts.length} proposal` +
    ` (skip ${skipDedupe} do dedupe, ${skipOther} do lý do khác)`,
  )

  return created
}

/** Helper export ProposalInput type (cho index.ts barrel) */
export type { ProposalInput }
