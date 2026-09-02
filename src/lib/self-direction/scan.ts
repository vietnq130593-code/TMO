/**
 * SELF-DIRECTION SCAN ENGINE — Tự phân tích hệ thống để phát hiện khoảng trống
 * ====================================
 * (2026-09-12) Trả lời câu hỏi: "Mình thiếu gì? Cần thêm gì? Học gì? Hệ thống
 * cần bổ sung điều gì? KB có chỗ nào mâu thuẫn không? Tool nào hay fail?
 * Skill nào thiếu? Test nào chưa có?"
 *
 * Nguồn dữ liệu quét (tất cả đã có sẵn trong SQLite):
 *   1. ToolMetric   — tool nào hay fail (72h qua), tỷ lệ thành công từng tool
 *   2. AgentSkill   — skill nào đã cài/thiếu
 *   3. Document     — KB trống hay có tài liệu lỗi/pending
 *   4. PendingWriteback — vùng xám KB cần review (mâu thuẫn tiềm năng)
 *   5. LessonRecord — bài học cần review (needsReview)
 *   6. AgentProfile — roster agents (đủ người hay thiếu chuyên môn?)
 *   7. EvalRun      — chất lượng trả lời gần đây (nếu có)
 *
 * Flow: collect snapshot → LLM phân tích (Omega analyst persona) → tối đa 5
 * đề xuất dạng JSON → dedup với proposals pending hiện có → insert DB.
 * LLM fail → fallback deterministic từ dữ liệu thu thập được (không bao giờ
 * quét xong mà 0 đề xuất khi có tín hiệu bất thường).
 */

import { db } from '@/lib/db'
import { callLLMForAgent } from '@/lib/llm'
import { findBalancedJson } from '@/lib/code-team/find-balanced-json'
import { createSelfDirectionProposal } from '@/lib/self-direction/orchestrator'

// ==================== TYPES ====================

export interface ScanProposalInput {
  title: string
  category: string
  priority: 'low' | 'medium' | 'high' | 'critical'
  problem: string
  solution: string
  implementation: string
  scheduleAt: Date | null
  impact: string | null
  /** llm | code-workflow (CI-6 B5) — thiếu/invalid → classifyExecutionMode quyết định */
  executionMode?: string
}

export interface ScanResult {
  created: number
  proposals: Array<{ id: string; title: string }>
  notes: string[]
}

interface SystemSnapshot {
  toolFailures: Array<{ tool: string; errors: number; topError: string; totalCalls: number }>
  skillsInstalled: number
  skillSlugs: string[]
  kb: { documents: number; errorDocs: number; pendingWritebacks: number; lessonsNeedReview: number }
  agents: { total: number; enabled: number; codeTeam: number; standalone: number }
  evalRuns: number
  recentErrors: string[]
}

// ==================== CONSTANTS ====================

const SCAN_WINDOW_HOURS = 72
const MAX_PROPOSALS_PER_SCAN = 5
const LLM_TIMEOUT_MS = 120_000
const OMEGA_FALLBACK_BRAIN = { provider: 'nvidia', model: 'moonshotai/kimi-k3' }
const VALID_CATEGORIES = ['gap', 'kb_contradiction', 'tool_failure', 'missing_skill', 'missing_test', 'improvement', 'long_term']

// ==================== CI-6 B5 — PHÂN LOẠI executionMode (code-workflow?) ====================

/**
 * Deterministic classifier — đề xuất này có đòi hỏi THAY ĐỔI CODE trong
 * workspace không? (CI-6 B5: proposals code-change → executionMode
 * 'code-workflow' — agents sửa code thật + pipeline kiểm định 9 bước).
 *
 * Nguyên tắc BẢO THỦ: mặc định 'llm' (thuần hội thoại — tương thích ngược);
 * chỉ lên 'code-workflow' khi có tín hiệu rõ ràng:
 *   - category thuộc nhóm rủi ro code (tool_failure ~ tool_gap, missing_test
 *     ~ test_gap — map từ bộ category thực tế của module);
 *   - text problem/solution khớp regex HÀNH ĐỘNG thay đổi source (xem bên dưới).
 *
 * FIX 2026-09-02 (Omega audit #1 MEDIUM — classifier tham lam): regex cũ
 * /code|tool|git|api|route|schema|bug|lỗi|hàm|function|component/i là DANH TỪ
 * chung → match gần như mọi đề xuất kỹ thuật (audit thực tế: 5/5 đề xuất scan
 * bị đánh code-workflow, kể cả kb_contradiction chỉ cần review tri thức).
 * Regex mới đòi hỏi ĐỘNG TỪ sửa source đi CÙNG mục tiêu code (cách ≤60 ký tự
 * trong cùng câu) — "API trả lời chậm" / "tool hay timeout" (phân tích, giám
 * sát) không còn bị kéo vào code-workflow; "sửa tool X" / "viết test cho hàm
 * Y" / "fix bug trong route Z" thì vẫn đúng code-workflow.
 */
const CODE_WORKFLOW_CATEGORIES = new Set(['tool_failure', 'missing_test'])
/**
 * FIX 2026-09-02 (Omega audit #1): category thuần tri thức — review writeback
 * vùng xám / mâu thuẫn KB là knowledge-work (approve/reject/đánh dấu lại),
 * KHÔNG đụng source code → classifier không bao giờ đẩy lên code-workflow.
 * (LLM hint tường minh executionMode='code-workflow' vẫn được tôn trọng ở
 * normalizeExecutionMode — nếu giải pháp thật sự cần sửa code, LLM nói rõ.)
 */
const LLM_ONLY_CATEGORIES = new Set(['kb_contradiction'])
const CODE_CHANGE_ACTION_RE = new RegExp(
  [
    // (1) Động từ thay đổi source + mục tiêu code trong cùng câu
    String.raw`\b(sửa|sua|fix|patch|refactor|viết|viet|rewrite|thêm|them|add|tạo|tao|create|xây|xay|build|implement|commit|push|deploy|xóa|xoa|remove|bổ sung|bo sung)\b`,
    String.raw`[^\n.]{0,60}`,
    String.raw`\b(code|hàm|ham|function|component|module|script|route|api|endpoint|schema|model|prisma|tool|test|hook|middleware|type|interface|file|library|package|bug|lỗi|loi)\b`,
    // (2) "bug/lỗi/crash ... trong code/hàm/route..."
    String.raw`|\b(bug|lỗi|loi|crash|exception)\b[^\n.]{0,50}\b(trong|của|cua|ở|o|at|in|of)\b[^\n.]{0,40}\b(code|hàm|ham|function|component|module|route|api|schema|tool)\b`,
  ].join(''),
  'i',
)

export function classifyExecutionMode(input: {
  category?: string | null
  problem?: string | null
  solution?: string | null
}): 'llm' | 'code-workflow' {
  const category = String(input.category || '').trim()
  if (LLM_ONLY_CATEGORIES.has(category)) return 'llm'
  if (CODE_WORKFLOW_CATEGORIES.has(category)) return 'code-workflow'
  const text = `${input.problem || ''}\n${input.solution || ''}`
  if (CODE_CHANGE_ACTION_RE.test(text)) return 'code-workflow'
  return 'llm'
}

/** Chuẩn hóa executionMode: giá trị hợp lệ giữ nguyên, thiếu/sai → classifier */
function normalizeExecutionMode(input: {
  category?: string | null
  problem?: string | null
  solution?: string | null
  executionMode?: string | null
}): 'llm' | 'code-workflow' {
  if (input.executionMode === 'code-workflow' || input.executionMode === 'llm') return input.executionMode
  return classifyExecutionMode(input)
}

// ==================== Z-AI SDK FALLBACK — ĐÃ GỠ (audit Omega #5, 2026-09-02) ====================
// Trước đây file này có bản copy getZaiSdk/tryZaiSdk "đồng bộ orchestrator".
// callLLMForAgent (llm.ts) ĐÃ tự có z-ai-sdk làm fallback CUỐI chuỗi (sandbox
// self-heal FIX RESET-2026-08-30) — bản copy ở đây chỉ trùng lặp bảo trì và
// gọi z-ai-sdk 2 lần khi chuỗi NVIDIA fail. Đã xóa: analyzeWithLLM giờ chỉ
// dùng callLLMForAgent (fallback z-ai-sdk bên trong).

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

// ==================== 1. COLLECT — thu thập snapshot hệ thống ====================

async function collectSnapshot(): Promise<SystemSnapshot> {
  const since = new Date(Date.now() - SCAN_WINDOW_HOURS * 3600_000)
  const snapshot: SystemSnapshot = {
    toolFailures: [],
    skillsInstalled: 0,
    skillSlugs: [],
    kb: { documents: 0, errorDocs: 0, pendingWritebacks: 0, lessonsNeedReview: 0 },
    agents: { total: 0, enabled: 0, codeTeam: 0, standalone: 0 },
    evalRuns: 0,
    recentErrors: [],
  }

  // 1) Tool failures (group thủ công — SQLite không hỗ trợ groupBy tốt qua Prisma + dữ liệu nhỏ)
  try {
    const failedMetrics = await db.toolMetric.findMany({
      where: { success: false, timestamp: { gte: since } },
      select: { toolName: true, errorTag: true },
      take: 2000,
      orderBy: { timestamp: 'desc' },
    })
    const totalMetrics = await db.toolMetric.findMany({
      where: { timestamp: { gte: since } },
      select: { toolName: true },
      take: 5000,
    })
    const failByTool = new Map<string, { errors: number; topError: string; errorCounts: Map<string, number> }>()
    for (const m of failedMetrics) {
      const entry = failByTool.get(m.toolName) ?? { errors: 0, topError: '', errorCounts: new Map<string, number>() }
      entry.errors++
      if (m.errorTag) entry.errorCounts.set(m.errorTag, (entry.errorCounts.get(m.errorTag) || 0) + 1)
      failByTool.set(m.toolName, entry)
    }
    const callsByTool = new Map<string, number>()
    for (const m of totalMetrics) callsByTool.set(m.toolName, (callsByTool.get(m.toolName) || 0) + 1)
    snapshot.toolFailures = [...failByTool.entries()]
      .map(([tool, v]) => {
        const topError = [...v.errorCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || ''
        return { tool, errors: v.errors, topError, totalCalls: callsByTool.get(tool) || v.errors }
      })
      .sort((a, b) => b.errors - a.errors)
      .slice(0, 10)
  } catch (err) {
    console.warn('[SelfDirectionScan] ToolMetric collect lỗi (fail-open):', err instanceof Error ? err.message : String(err))
  }

  // 2) Skills
  try {
    const skills = await db.agentSkill.findMany({
      where: { agentId: 'default' },
      select: { slug: true, enabled: true },
    })
    snapshot.skillsInstalled = skills.filter(s => s.enabled).length
    snapshot.skillSlugs = skills.filter(s => s.enabled).map(s => s.slug).slice(0, 30)
  } catch { /* fail-open */ }

  // 3) KB
  try {
    snapshot.kb.documents = await db.document.count()
    snapshot.kb.errorDocs = await db.document.count({ where: { status: 'error' } })
    snapshot.kb.pendingWritebacks = await db.pendingWriteback.count({ where: { status: 'pending' } })
    snapshot.kb.lessonsNeedReview = await db.lessonRecord.count({ where: { needsReview: true } })
  } catch { /* fail-open */ }

  // 4) Agents
  try {
    snapshot.agents.total = await db.agentProfile.count()
    snapshot.agents.enabled = await db.agentProfile.count({ where: { enabled: true } })
    snapshot.agents.codeTeam = await db.agentProfile.count({ where: { team: 'code', enabled: true } })
    snapshot.agents.standalone = await db.agentProfile.count({ where: { team: null, enabled: true } })
  } catch { /* fail-open */ }

  // 5) Eval runs
  try {
    snapshot.evalRuns = await db.evalRun.count()
  } catch { /* fail-open */ }

  return snapshot
}

// ==================== 2. ANALYZE — LLM phân tích & đề xuất ====================

function snapshotToText(s: SystemSnapshot): string {
  const lines: string[] = []
  lines.push(`THỜI GIAN QUÉT: ${new Date().toLocaleString('vi-VN')} (cửa sổ ${SCAN_WINDOW_HOURS}h)`)
  lines.push('')
  lines.push('■ TOOL FAILURES (72h qua):')
  if (s.toolFailures.length === 0) {
    lines.push('  (không có tool nào fail — hoặc chưa ghi nhận metrics)')
  } else {
    for (const f of s.toolFailures) {
      lines.push(`  - ${f.tool}: ${f.errors} lỗi / ${f.totalCalls} calls (${Math.round((1 - f.errors / Math.max(1, f.totalCalls)) * 100)}% thành công)${f.topError ? ` — lỗi hay gặp: ${f.topError}` : ''}`)
    }
  }
  lines.push('')
  lines.push(`■ SKILLS: ${s.skillsInstalled} skill đang bật${s.skillSlugs.length ? ` (${s.skillSlugs.join(', ')})` : ' — CHƯA CÀI SKILL NÀO'}`)
  lines.push('')
  lines.push('■ KNOWLEDGE BASE:')
  lines.push(`  - Tài liệu: ${s.kb.documents} (lỗi xử lý: ${s.kb.errorDocs})`)
  lines.push(`  - Writeback vùng xám chờ review (nguy cơ mâu thuẫn KB): ${s.kb.pendingWritebacks}`)
  lines.push(`  - Bài học chờ review: ${s.kb.lessonsNeedReview}`)
  lines.push('')
  lines.push(`■ AGENTS: ${s.agents.enabled}/${s.agents.total} đang bật (Code Team: ${s.agents.codeTeam}, Standalone: ${s.agents.standalone})`)
  lines.push('')
  lines.push(`■ EVAL RUNS (đo chất lượng trả lời): ${s.evalRuns}`)
  lines.push('■ TEST SUITE: không có bảng ghi test coverage — kết quả test chỉ nằm rải rác trong tool metrics (run_tests).')
  return lines.join('\n')
}

async function analyzeWithLLM(snapshot: SystemSnapshot): Promise<ScanProposalInput[]> {
  const systemPrompt = `Bạn là OMEGA — orchestrator của hệ thống multi-agent TMO (The Magnum Opus), đang chạy chế độ SELF-DIRECTION ANALYST: tự đánh giá hệ thống để phát hiện MÌNH THIẾU GÌ, CẦN THÊM GÌ, HỌC GÌ, BỔ SUNG GÌ.

Hệ thống gồm: Knowledge Base (GraphRAG: Qdrant + Neo4j + SQLite), multi-agent (Code Team 5 agents + Omega), Skills Marketplace, tool system (shell, file ops, web search...).

Dựa vào SNAPSHOT bên dưới, đề xuất tối đa ${MAX_PROPOSALS_PER_SCAN} cải tiến CẦN THIẾT NHẤT (ưu tiên theo mức độ ảnh hưởng). Mỗi đề xuất PHẢI có 4 phần rõ ràng: vấn đề là gì (dựa trên dữ liệu thật trong snapshot), giải quyết như thế nào, triển khai như thế nào (các bước cụ thể), thời điểm triển khai.

Danh mục (category): "gap" (thiếu năng lực/học gì), "kb_contradiction" (KB mâu thuẫn/chất lượng), "tool_failure" (tool hay fail), "missing_skill" (thiếu skill), "missing_test" (thiếu test/eval), "improvement" (cải tiến), "long_term" (kế hoạch dài hạn phát triển).

Trường "executionMode" (CI-6 B5): "code-workflow" nếu giải pháp ĐÒI HỎI THAY ĐỔI SOURCE CODE thật trong workspace (sửa tool/API/route/schema/bug, viết hàm/component, thêm test... — agents sẽ edit file thật + chạy pipeline kiểm định trước khi push); "llm" nếu chỉ cần phân tích/tư vấn/tổ chức kiến thức thuần (mặc định khi không chắc).

Output DUY NHẤT một JSON hợp lệ (KHÔNG markdown fence):
{"proposals": [{"title": "tiêu đề ngắn tiếng Việt", "category": "gap|kb_contradiction|tool_failure|missing_skill|missing_test|improvement|long_term", "priority": "low|medium|high|critical", "problem": "vấn đề là gì (2-4 câu, dẫn chứng từ snapshot)", "solution": "giải quyết như thế nào (2-4 câu)", "implementation": "triển khai như thế nào — các bước cụ thể", "scheduleAt": "ISO datetime hoặc null (null = ngay khi duyệt; ưu tiên cao thì sớm)", "impact": "tác động kỳ vọng (1 câu)", "executionMode": "llm|code-workflow"}]}`

  const userPrompt = `SNAPSHOT HỆ THỐNG TMO:
${snapshotToText(snapshot)}

Phân tích và đề xuất (JSON).`

  try {
    let raw: string | null = null
    try {
      // callLLMForAgent tự kèm z-ai-sdk fallback cuối chuỗi (llm.ts) — không
      // cần bản copy tryZaiSdk ở đây nữa (audit Omega #5).
      const result = await withTimeout(
        callLLMForAgent(userPrompt, OMEGA_FALLBACK_BRAIN, systemPrompt, {
          agentName: 'SelfDirectionScan',
          temperature: 0.4,
          maxTokens: 2200,
        }),
        LLM_TIMEOUT_MS,
        'ScanLLM (NVIDIA chain + z-ai-sdk fallback)',
      )
      if (result.content && result.content.trim()) raw = result.content.trim()
    } catch { /* fall xuống deterministic fallback proposals */ }
    if (!raw || !raw.trim()) return []

    const jsonStr = findBalancedJson(raw.replace(/```(?:json)?/g, ''), 'proposals')
    if (!jsonStr) return []
    const obj = JSON.parse(jsonStr) as Record<string, unknown>
    const arr = Array.isArray(obj.proposals) ? obj.proposals : []
    const out: ScanProposalInput[] = []
    for (const item of arr.slice(0, MAX_PROPOSALS_PER_SCAN)) {
      if (!item || typeof item !== 'object') continue
      const p = item as Record<string, unknown>
      const title = String(p.title || '').trim()
      const problem = String(p.problem || '').trim()
      const solution = String(p.solution || '').trim()
      const implementation = String(p.implementation || '').trim()
      if (!title || !problem || !solution || !implementation) continue
      let scheduleAt: Date | null = null
      if (typeof p.scheduleAt === 'string' && p.scheduleAt) {
        const d = new Date(p.scheduleAt)
        if (!Number.isNaN(d.getTime())) scheduleAt = d
      }
      const priority = ['low', 'medium', 'high', 'critical'].includes(String(p.priority)) ? (String(p.priority) as ScanProposalInput['priority']) : 'medium'
      out.push({
        title: title.slice(0, 200),
        category: VALID_CATEGORIES.includes(String(p.category)) ? String(p.category) : 'improvement',
        priority,
        problem: problem.slice(0, 3000),
        solution: solution.slice(0, 3000),
        implementation: implementation.slice(0, 3000),
        scheduleAt,
        impact: p.impact ? String(p.impact).slice(0, 600) : null,
        // CI-6 B5: LLM hint executionMode — invalid/thiếu → deterministic classifier
        executionMode: normalizeExecutionMode({
          category: String(p.category || ''),
          problem,
          solution,
          executionMode: typeof p.executionMode === 'string' ? p.executionMode : null,
        }),
      })
    }
    return out
  } catch (err) {
    console.warn('[SelfDirectionScan] LLM analyze lỗi — fallback deterministic:', err instanceof Error ? err.message : String(err))
    return []
  }
}

// ==================== 3. FALLBACK — đề xuất deterministic từ dữ liệu ====================

function fallbackProposals(s: SystemSnapshot): ScanProposalInput[] {
  const out: ScanProposalInput[] = []
  const now = Date.now()
  const in2h = new Date(now + 2 * 3600_000)
  const in24h = new Date(now + 24 * 3600_000)

  // a) Tool hay fail nhất
  const worst = s.toolFailures[0]
  if (worst && worst.errors >= 3) {
    const priority = worst.errors >= 10 ? 'critical' : worst.errors >= 5 ? 'high' : 'medium'
    out.push({
      title: `Điều tra tool "${worst.tool}" hay fail (${worst.errors} lỗi/72h)`,
      category: 'tool_failure',
      priority: priority as ScanProposalInput['priority'],
      problem: `Tool "${worst.tool}" ghi nhận ${worst.errors} lần fail trong 72h qua trên tổng ${worst.totalCalls} lần gọi (tỷ lệ thành công ${Math.round((1 - worst.errors / Math.max(1, worst.totalCalls)) * 100)}%).${worst.topError ? ` Lỗi hay gặp nhất: "${worst.topError}".` : ''} Điều này làm giảm độ tin cậy của các agent đang phụ thuộc tool này.`,
      solution: `Phân tích nguyên nhân gốc của lỗi (input sai format? timeout? quyền truy cập?), sau đó sửa tool hoặc thêm retry/fallback thông minh. Kiểm định lại bằng chuỗi test gọi tool lặp lại.`,
      implementation: `1) Thu thập 5-10 log lỗi gần nhất của tool; 2) Phân loại nguyên nhân (input/timeout/quyền); 3) Patch tool + thêm validate input; 4) Thêm retry với backoff cho lỗi tạm thời; 5) Chạy test hồi quy 20 lần gọi liên tiếp.`,
      scheduleAt: priority === 'critical' ? in2h : in24h,
      impact: 'Tăng tỷ lệ thành công của tool, giảm agent bị kẹt vì tool fail.',
    })
  }

  // b) Chưa cài skill nào
  if (s.skillsInstalled === 0) {
    out.push({
      title: 'Cài đặt bộ skill nền tảng cho hệ thống',
      category: 'missing_skill',
      priority: 'high',
      problem: 'Hệ thống CHƯA cài skill nào từ Skills Marketplace. Agents đang thiếu các năng lực cốt lõi: Web Search (tra cứu thông tin mới), Page Reader (đọc trang web), TTS/ASR (giọng nói), VLM (hiểu ảnh) — giới hạn mạnh khả năng tự hoàn thành tác vụ.',
      solution: 'Cài đặt và bật các skill nền tảng: web_search, page_reader, tts, asr, vlm, image_generation từ Skills Marketplace, sau đó tích hợp vào prompt các agents cần dùng.',
      implementation: '1) Vào Smolab > Skills duyệt marketplace; 2) Cài 6 skill nền tảng; 3) Test từng skill 1 lần gọi thật; 4) Gán skill vào agents phù hợp qua Tools Manager.',
      scheduleAt: in2h,
      impact: 'Agents có đầy đủ năng lực search/đọc web/giọng nói/hiểu ảnh để tự chủ hơn.',
    })
  }

  // c) KB vùng xám chờ review
  if (s.kb.pendingWritebacks >= 3) {
    out.push({
      title: `Xử lý ${s.kb.pendingWritebacks} writeback vùng xám chờ review (nguy cơ mâu thuẫn KB)`,
      category: 'kb_contradiction',
      priority: 'high',
      problem: `Có ${s.kb.pendingWritebacks} writeback ở "vùng xám" (confidence 0.3-0.5) chờ review trong KB. Nếu kéo dài, Knowledge Base sẽ tích lũy tri thức chưa kiểm chứng — các câu trả lời sau này có thể mâu thuẫn nhau.`,
      solution: 'Review toàn bộ writeback chờ duyệt: approve mục đúng (kèm nâng confidence), reject mục sai. Sau đó bật cơ chế auto-learn conservative để giảm vùng xám phát sinh.',
      implementation: '1) Vào tab Auto-Learn > phần review writeback; 2) Duyệt từng mục theo nguồn dẫn; 3) Mục bị từ chối kèm ghi chú lý do để auto-learn học luật mới; 4) Kiểm tra lại tỷ lệ vùng xám sau 1 tuần.',
      scheduleAt: in24h,
      impact: 'KB sạch mâu thuẫn nội tại, câu trả lời đồng nhất hơn.',
    })
  }

  // d) KB trống
  if (s.kb.documents === 0) {
    out.push({
      title: 'Nạp bộ tài liệu nền tảng vào Knowledge Base',
      category: 'gap',
      priority: 'high',
      problem: 'Knowledge Base đang TRỐNG (0 tài liệu). Hybrid search và GraphRAG không có dữ liệu để trả lời — mọi câu hỏi kiến thức đều rơi vào fallback LLM chung, mất ưu thế truy xuất chính xác.',
      solution: 'Nạp 5-10 tài liệu nền tảng của lĩnh vực hệ thống đang phục vụ (tài liệu kỹ thuật, quy trình, kiến thức cốt lõi) để KB có chỗ dựa ban đầu.',
      implementation: '1) Chuẩn bị 5-10 PDF chất lượng cao; 2) Upload qua Database > Tài liệu; 3) Chạy pipeline extraction đầy đủ (parse → chunk → entity → embedding → index); 4) Test 5 câu hỏi truy xuất để xác nhận chất lượng.',
      scheduleAt: in24h,
      impact: 'KB có tri thức nền, hybrid search hoạt động thực chất.',
    })
  }

  // e) Thiếu eval
  if (s.evalRuns === 0) {
    out.push({
      title: 'Thiết lập bộ eval đo chất lượng trả lời của hệ thống',
      category: 'missing_test',
      priority: 'medium',
      problem: 'Chưa có eval run nào được ghi nhận. Hệ thống không có số đo khách quan về chất lượng câu trả lời (độ chính xác, độ đầy đủ) — mọi đánh giá hiện tại là cảm tính, không phát hiện được regression.',
      solution: 'Xây dựng bộ eval gồm 15-20 câu hỏi chuẩn kèm đáp án kỳ vọng, chạy định kỳ (hàng tuần) để theo dõi chất lượng qua các thay đổi của hệ thống.',
      implementation: '1) Soạn 15-20 test case (câu hỏi + đáp án chuẩn + rubric chấm); 2) Import vào hệ thống eval; 3) Chạy eval run đầu tiên để có baseline; 4) Lập cron chạy hàng tuần + review kết quả.',
      scheduleAt: new Date(now + 3 * 24 * 3600_000),
      impact: 'Có baseline chất lượng, phát hiện regression sớm.',
    })
  }

  // f) Kế hoạch dài hạn (luôn có 1 đề xuất long_term)
  if (out.length < 3) {
    out.push({
      title: 'Kế hoạch dài hạn: phát triển năng lực tự học của hệ thống',
      category: 'long_term',
      priority: 'low',
      problem: 'Hệ thống hiện phản ứng theo yêu cầu nhưng chưa có vòng lặp tự cải tiến dài hạn: insight từ auto-learn chưa được chưng cất thành chiến lược, episodic memory chưa được khai thác để tránh lặp lỗi cũ.',
      solution: 'Xây dựng chu trình quarterly: tổng hợp episodic memory + lessons + metrics → chưng cất thành 3-5 mục tiêu chiến lược → đưa vào Self-direction sebagai đề xuất long_term cho kỳ kế hoạch sau.',
      implementation: '1) Lập cron tổng hợp monthly report từ episodic memory + tool metrics; 2) Omega phân tích report → đề xuất mục tiêu; 3) Mr. Architect duyệt vào lộ trình; 4) Đo lường kết quả mỗi quý.',
      scheduleAt: new Date(now + 7 * 24 * 3600_000),
      impact: 'Hệ thống chuyển từ phản ứng sang chủ động tự hoàn thiện theo chu kỳ.',
    })
  }

  return out.slice(0, MAX_PROPOSALS_PER_SCAN).map(p => ({
    ...p,
    // CI-6 B5: fallback deterministic cũng qua classifier (đề xuất tool_failure/
    // missing_test hoặc text chỉ dấu code-change → code-workflow)
    executionMode: normalizeExecutionMode(p),
  }))
}

// ==================== 4. DEDUP + PERSIST ====================

function normalizeTitle(t: string): string {
  return t.toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 80)
}

async function dedupAndCreate(inputs: ScanProposalInput[]): Promise<{ created: Array<{ id: string; title: string }>; notes: string[] }> {
  const notes: string[] = []
  const created: Array<{ id: string; title: string }> = []
  if (inputs.length === 0) return { created, notes }

  // Lấy các proposal đang pending + created trong 24h qua để dedup
  const recentCutoff = new Date(Date.now() - 24 * 3600_000)
  const existing = await db.selfDirectionProposal.findMany({
    where: { OR: [{ status: 'pending' }, { createdAt: { gte: recentCutoff } }] },
    select: { title: true },
  })
  const existingTitles = new Set(existing.map(p => normalizeTitle(p.title)))

  for (const input of inputs) {
    const norm = normalizeTitle(input.title)
    if (existingTitles.has(norm)) {
      notes.push(`Bỏ qua (trùng): ${input.title.slice(0, 60)}`)
      continue
    }
    // CI-6 B5: chế độ thực thi (LLM hint hoặc deterministic classifier) —
    // createSelfDirectionProposal chịu đựng Prisma client cũ (fail-open)
    const row = await createSelfDirectionProposal({
      title: input.title,
      category: input.category,
      priority: input.priority,
      problem: input.problem,
      solution: input.solution,
      implementation: input.implementation,
      scheduleAt: input.scheduleAt,
      impact: input.impact,
      status: 'pending',
      source: 'scan',
      createdBy: 'self-direction-scan',
      executionMode: normalizeExecutionMode(input),
    })
    existingTitles.add(norm)
    created.push({ id: row.id, title: row.title })
  }
  return { created, notes }
}

// ==================== 5. ENTRY POINT ====================

export async function runSelfDirectionScan(): Promise<ScanResult> {
  console.log('[SelfDirectionScan] Bắt đầu quét hệ thống...')
  const snapshot = await collectSnapshot()

  let inputs = await analyzeWithLLM(snapshot)
  let usedFallback = false
  if (inputs.length === 0) {
    inputs = fallbackProposals(snapshot)
    usedFallback = true
    console.log(`[SelfDirectionScan] LLM không trả đề xuất — dùng fallback deterministic (${inputs.length} đề xuất)`)
  }

  const { created, notes } = await dedupAndCreate(inputs)
  const result: ScanResult = {
    created: created.length,
    proposals: created,
    notes: [
      ...notes,
      ...(usedFallback ? ['(Dùng đề xuất deterministic — LLM không phản hồi)'] : []),
    ],
  }
  console.log(`[SelfDirectionScan] Hoàn tất: ${result.created} đề xuất mới (từ ${inputs.length} ứng viên, ${notes.length} trùng bị bỏ)`)
  return result
}
