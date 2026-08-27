/**
 * Agent Runtime Capabilities — xác nhận runtime (runtime verification)
 *
 * User request 2026-08-29: "Agents có biết tool nào thực sự hoạt động chưa,
 * có *xác nhận runtime* không". Trước đây system prompt chỉ liệt kê tool về
 * mặt lý thuyết — agent không biết shell đã bật chưa, Qdrant sống không,
 * skills folder có bao nhiêu skill... và chỉ phát hiện tool hỏng SAU khi gọi
 * thất bại.
 *
 * Lib này THỰC THI các probe thật (đọc file, chạy echo, ping Qdrant/Neo4j,
 * đếm skills, gọi SDK web search) rồi:
 *   1. buildCapabilityPromptBlock() → inject vào system prompt của MỌI agents
 *      (độc lập qua /api/openclaw/chat + team code qua workflow-engine) —
 *      agent biết CHÍNH XÁC tool nào verified hoạt động.
 *   2. GET /api/agent-capabilities → JSON report cho UI/debug.
 *
 * Probe được cache trong module (60s cho fs/shell, dài hơn cho các probe
 * tốn kém) — tránh chạy lại mỗi request chat.
 */

import { readdir, readFile } from 'fs/promises'
import { join } from 'path'
import { resolveWorkspaceRoot } from '@/lib/code-team/workspace-root'
import { shell as executeShellFn } from '@/lib/code-team/dev-tools'
import { checkQdrantHealth } from '@/lib/qdrant'
import { checkNeo4jHealth } from '@/lib/neo4j'
import { listAvailableServers } from '@/lib/mcp/mcp-bridge'
import { isFlagEnabled } from '@/lib/feature-flags'
import { db } from '@/lib/db'

// ==================== TYPES ====================

export type CapabilityStatus = 'ok' | 'degraded' | 'unavailable'

export interface CapabilityEntry {
  /** Nhóm tool (hiển thị trong prompt + UI) */
  group: string
  /** Tên tool(s) liên quan — agent dùng để emit tool_call */
  tools: string[]
  status: CapabilityStatus
  /** Chi tiết xác nhận runtime (VD: "echo 200 OK (14ms)" hoặc lỗi) */
  detail: string
  durationMs?: number
}

export interface CapabilityReport {
  probedAt: string
  workspaceRoot: string | null
  capabilities: CapabilityEntry[]
  /** Số lượng skills agent có thể liệt kê động qua list_skills */
  skills: { dbEnabled: number; filesystem: number }
  /** MCP servers đang kết nối (bridge + built-in) */
  mcp: { servers: number; note: string }
}

// ==================== CACHE ====================

const CACHE_TTL_MS = 60_000 // 60s cho probe nhanh
const globalForCaps = globalThis as unknown as {
  __tmoCapabilityCache?: { report: CapabilityReport; at: number }
  __tmoWebProbe?: { ok: boolean; detail: string; at: number; durationMs: number }
}

// ==================== PROBES ====================
// Mỗi probe THỰC THI thật (không chỉ check env/config) — đây chính là
// "xác nhận runtime" user yêu cầu. Fail-open: probe lỗi → status
// unavailable + detail lỗi, KHÔNG bao giờ throw ra ngoài.

async function probeFilesystem(): Promise<{ root: string | null; entries: number; readOk: boolean; detail: string }> {
  try {
    const root = await resolveWorkspaceRoot()
    if (!root) {
      return { root: null, entries: 0, readOk: false, detail: 'Chưa đăng ký workspace — dùng nút "Chọn thư mục" trong tab Code' }
    }
    const entries = await readdir(root)
    // Đọc thật 1 file để xác nhận quyền read (package.json gần như luôn tồn tại)
    let readOk = false
    try {
      const head = await readFile(join(root, 'package.json'), 'utf-8')
      readOk = head.length > 0
    } catch {
      readOk = false
    }
    return {
      root,
      entries: entries.length,
      readOk,
      detail: readOk
        ? `root=${root} — liệt kê OK (${entries.length} mục cấp 1), đọc file OK`
        : `root=${root} — liệt kê OK nhưng KHÔNG đọc được file (kiểm tra quyền)`,
    }
  } catch (err) {
    return { root: null, entries: 0, readOk: false, detail: `probe lỗi: ${err instanceof Error ? err.message : String(err)}` }
  }
}

async function probeShell(): Promise<{ ok: boolean; detail: string; durationMs: number }> {
  const t0 = Date.now()
  // FIX (user bug report 2026-08-30): probe cũ gọi executeShellFn trực tiếp từ
  // dev-tools — BYPASS flag check ở layer executeTool. Kết quả: probe báo
  // "shell ok — echo xác nhận" dù tool_call shell thật bị chặn bởi
  // ENABLE_SHELL_TOOL=false ("shell tool is disabled"). Probe phải xác minh
  // QUYỀN THỰC THI qua đúng path mà agent sẽ đi: flag check + echo thật.
  if (!isFlagEnabled('ENABLE_SHELL_TOOL')) {
    return {
      ok: false,
      detail: 'TẮT (ENABLE_SHELL_TOOL=false trong .env) — tool_call shell sẽ bị từ chối. Sửa .env: ENABLE_SHELL_TOOL=true rồi restart app.',
      durationMs: 0,
    }
  }
  try {
    const res = (await executeShellFn({ command: 'echo __TMO_PROBE_OK__' })) as { success?: boolean; output?: string; stdout?: string; error?: string }
    const out = String(res?.output ?? res?.stdout ?? '')
    const ok = res?.success !== false && out.includes('__TMO_PROBE_OK__')
    return { ok, detail: ok ? `flag BẬT + echo xác nhận (${Date.now() - t0}ms)` : `output bất thường: ${out.slice(0, 80)}`, durationMs: Date.now() - t0 }
  } catch (err) {
    return { ok: false, detail: `không thực thi được: ${err instanceof Error ? err.message : String(err)}`, durationMs: Date.now() - t0 }
  }
}

async function probeKnowledge(): Promise<{ qdrant: string; neo4j: string }> {
  const out = { qdrant: 'unknown', neo4j: 'unknown' }
  try {
    const q = await Promise.race([
      checkQdrantHealth(),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error('timeout 4s')), 4000)),
    ])
    out.qdrant = q?.connected ? 'ok' : (q?.error ? `lỗi: ${String(q.error).slice(0, 60)}` : 'không kết nối được')
  } catch (err) {
    out.qdrant = `lỗi: ${err instanceof Error ? err.message.slice(0, 60) : String(err)}`
  }
  try {
    const n = await Promise.race([
      checkNeo4jHealth(),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error('timeout 4s')), 4000)),
    ])
    out.neo4j = n?.connected ? 'ok' : 'không kết nối được'
  } catch (err) {
    out.neo4j = `lỗi: ${err instanceof Error ? err.message.slice(0, 60) : String(err)}`
  }
  return out
}

/** Web search probe — đa nguồn: API key pools (Tavily/Serper/Jina) + SDK z-ai.
 * Cache dài (10 phút). FIX (user bug report 2026-08-30): probe cũ CHỈ test SDK
 * z-ai — trên máy local SDK luôn lỗi ".z-ai-config not found" (SDK chỉ khả dụng
 * trong sandbox Z.ai) → probe báo cả nhóm web ❌ dù Tavily/Serper/Jina keys
 * hoạt động tốt. Giờ probe kiểm tra MỌI nguồn theo đúng path tool sẽ dùng. */
async function probeWebSearch(): Promise<{ ok: boolean; detail: string; durationMs: number }> {
  const cached = globalForCaps.__tmoWebProbe
  if (cached && Date.now() - cached.at < 10 * 60_000) {
    return { ok: cached.ok, detail: `${cached.detail} (đã xác nhận ${Math.round((Date.now() - cached.at) / 1000)}s trước)`, durationMs: cached.durationMs }
  }
  const t0 = Date.now()

  // Nguồn 1-3: API key pools (chính — hoạt động cả ngoài sandbox Z.ai)
  const sources: string[] = []
  try {
    const { tavilyKeyPool, serperKeyPool, jinaKeyPool } = await import('@/lib/service-key-pool')
    if (tavilyKeyPool.hasKeys()) sources.push(`Tavily (${tavilyKeyPool.getTotalCount()} keys)`)
    if (serperKeyPool.hasKeys()) sources.push(`Serper (${serperKeyPool.getTotalCount()} keys)`)
    if (jinaKeyPool.hasKeys()) sources.push(`Jina (${jinaKeyPool.getTotalCount()} keys)`)
  } catch { /* ignore */ }

  // Nguồn 4: SDK z-ai (fallback — chỉ hoạt động trong sandbox Z.ai)
  let sdkOk = false
  let sdkErr = ''
  try {
    const ZAI = (await import('z-ai-web-dev-sdk')).default
    const zai = await ZAI.create()
    const results = await zai.functions.invoke('web_search', { query: 'test', num: 1 })
    sdkOk = Array.isArray(results) || (results && typeof results === 'object')
  } catch (err) {
    sdkErr = err instanceof Error ? err.message.slice(0, 60) : String(err).slice(0, 60)
  }
  if (sdkOk) sources.push('SDK z-ai')

  // Flag cho web_search/web_fetch unified tools (tavily/serper/jina tools riêng
  // lẻ không cần flag này)
  const unifiedFlag = isFlagEnabled('ENABLE_WEB_UNIFIED')

  let ok: boolean
  let detail: string
  if (sources.length > 0) {
    ok = true
    detail = `nguồn hoạt động: ${sources.join(' · ')}`
    if (!unifiedFlag) {
      detail += ` — LƯU Ý: web_search/web_fetch TẮT (ENABLE_WEB_UNIFIED=false); tavily/serper/jina vẫn dùng được`
    }
    if (!sdkOk) {
      // Không báo lỗi SDK khi đã có key sources — SDK chỉ là fallback
      detail += ` · SDK z-ai không khả dụng (ngoài môi trường Z.ai — bình thường khi chạy local)`
    }
  } else {
    ok = false
    detail = 'KHÔNG có nguồn web search nào: thiếu TAVILY_API_KEY/SERPER_API_KEY/JINA_API_KEY trong .env'
    if (!sdkOk) detail += ` và SDK z-ai lỗi (${sdkErr})`
    if (!unifiedFlag) detail += ' · web_search/web_fetch cũng TẮT (ENABLE_WEB_UNIFIED=false)'
  }

  globalForCaps.__tmoWebProbe = { ok, detail, at: Date.now(), durationMs: Date.now() - t0 }
  return { ok, detail, durationMs: Date.now() - t0 }
}

async function probeSkills(): Promise<{ dbEnabled: number; filesystem: number }> {
  const out = { dbEnabled: 0, filesystem: 0 }
  try {
    out.dbEnabled = await db.agentSkill.count({ where: { enabled: true } })
  } catch { /* ignore */ }
  try {
    const skillsDir = join(process.cwd(), 'skills')
    const dirs = await readdir(skillsDir)
    for (const d of dirs) {
      try {
        await readFile(join(skillsDir, d, 'SKILL.md'), 'utf-8')
        out.filesystem++
      } catch { /* not a skill dir */ }
    }
  } catch { /* no skills dir */ }
  return out
}

async function probeMcp(): Promise<{ servers: number; note: string; flag: boolean }> {
  const flag = isFlagEnabled('ENABLE_MCP_CALL')
  try {
    const servers = await listAvailableServers()
    const mockCount = servers.filter(s => s.mock).length
    return {
      servers: servers.length,
      note: `${servers.length} MCP server (${servers.map(s => s.id).join(', ')}) — mcp_call ${flag ? 'ĐÃ BẬT' : 'TẮT (ENABLE_MCP_CALL=false)'}${mockCount > 0 ? ` · LƯU Ý: ${mockCount}/${servers.length} server builtin là MOCK (kết quả mô phỏng — KHÔNG phải thực thi thật: puppeteer không mở browser thật, postgres không query DB thật)` : ''}`,
      flag,
    }
  } catch (err) {
    return { servers: 0, note: `bridge lỗi: ${err instanceof Error ? err.message.slice(0, 60) : String(err)}`, flag }
  }
}

async function probeTodo(): Promise<{ ok: boolean; detail: string }> {
  const flag = isFlagEnabled('ENABLE_TODO_TOOL')
  if (!flag) return { ok: false, detail: 'TẮT (ENABLE_TODO_TOOL=false)' }
  try {
    // Read-only probe — không tạo row rác
    const count = await db.todo.count()
    return { ok: true, detail: `ĐÃ BẬT — DB sống (${count} todo hiện có)` }
  } catch (err) {
    return { ok: false, detail: `DB lỗi: ${err instanceof Error ? err.message.slice(0, 60) : String(err)}` }
  }
}

// ==================== MAIN ====================

export async function probeCapabilities(): Promise<CapabilityReport> {
  const cached = globalForCaps.__tmoCapabilityCache
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
    return cached.report
  }

  // Chạy song song — tổng thời gian probe ≈ probe chậm nhất (~5s tối đa)
  const [fsProbe, shellProbe, kbProbe, webProbe, skillsProbe, mcpProbe, todoProbe] = await Promise.all([
    probeFilesystem(),
    probeShell(),
    probeKnowledge(),
    probeWebSearch().catch(() => ({ ok: false, detail: 'probe exception', durationMs: 0 })),
    probeSkills(),
    probeMcp(),
    probeTodo(),
  ])

  const fsStatus: CapabilityStatus = fsProbe.root && fsProbe.readOk ? 'ok' : fsProbe.root ? 'degraded' : 'unavailable'
  const grepOk = fsProbe.root ? true : false

  const capabilities: CapabilityEntry[] = [
    {
      group: 'filesystem',
      tools: ['file_read', 'file_list', 'file_edit', 'file_multi_edit', 'file_delete', 'grep'],
      status: fsStatus,
      detail: fsProbe.detail,
    },
    {
      group: 'shell',
      tools: ['shell'],
      status: shellProbe.ok ? 'ok' : 'unavailable',
      detail: shellProbe.ok ? shellProbe.detail : shellProbe.detail,
      durationMs: shellProbe.durationMs,
    },
    {
      group: 'knowledge',
      tools: ['knowledge_search', 'knowledge_graph', 'knowledge_write'],
      status: kbProbe.qdrant === 'ok' && kbProbe.neo4j === 'ok' ? 'ok' : kbProbe.qdrant === 'ok' || kbProbe.neo4j === 'ok' ? 'degraded' : 'unavailable',
      detail: `Qdrant: ${kbProbe.qdrant} · Neo4j: ${kbProbe.neo4j}`,
    },
    {
      group: 'web',
      tools: ['tavily', 'serper', 'jina', 'web_search', 'web_fetch'],
      status: webProbe.ok ? 'ok' : 'unavailable',
      detail: webProbe.detail,
      durationMs: webProbe.durationMs,
    },
    {
      group: 'skills',
      tools: ['list_skills', 'read_skill'],
      status: skillsProbe.dbEnabled + skillsProbe.filesystem > 0 ? 'ok' : 'unavailable',
      detail: `${skillsProbe.dbEnabled} skill bật (DB) + ${skillsProbe.filesystem} skill trên đĩa — gọi list_skills để liệt kê động`,
    },
    {
      group: 'mcp',
      tools: ['mcp_list_servers', 'mcp_call'],
      status: mcpProbe.flag && mcpProbe.servers > 0 ? 'ok' : mcpProbe.servers > 0 ? 'degraded' : 'unavailable',
      detail: mcpProbe.note,
    },
    {
      group: 'todo',
      tools: ['todo_write', 'todo_read'],
      status: todoProbe.ok ? 'ok' : 'unavailable',
      detail: todoProbe.detail,
    },
    {
      group: 'tests/git/diagnostics',
      tools: ['run_tests', 'git_commit', 'git_push', 'git_pull', 'get_diagnostics'],
      status: fsProbe.root ? 'ok' : 'unavailable',
      detail: fsProbe.root
        ? `chạy trong workspace root (${fsProbe.root}). git_push/git_pull: push-pull remote khi user yêu cầu — token tự lấy từ GitHub Token Store (token user nhập dialog Pull Code được lưu tự động)`
        : 'cần workspace',
    },
  ]

  const report: CapabilityReport = {
    probedAt: new Date().toISOString(),
    workspaceRoot: fsProbe.root,
    capabilities,
    skills: skillsProbe,
    mcp: { servers: mcpProbe.servers, note: mcpProbe.note },
  }

  globalForCaps.__tmoCapabilityCache = { report, at: Date.now() }
  return report
}

/** Invalidate cache (gọi sau khi user đổi workspace / bật flag). */
export function invalidateCapabilityCache(): void {
  globalForCaps.__tmoCapabilityCache = undefined
  globalForCaps.__tmoWebProbe = undefined
}

// ==================== PROMPT BLOCK ====================

const STATUS_ICON: Record<CapabilityStatus, string> = { ok: '✅', degraded: '⚠️', unavailable: '❌' }

/**
 * Text block inject vào system prompt — cho agent biết CHÍNH XÁC capability
 * nào đã được XÁC NHẬN RUNTIME (probe thật chạy ngay trước cuộc hội thoại).
 */
export async function buildCapabilityPromptBlock(): Promise<string> {
  let report: CapabilityReport
  try {
    report = await probeCapabilities()
  } catch (err) {
    // Fail-open — không bao giờ chặn cuộc chat vì probe lỗi
    return `\n--- Runtime Capabilities ---\n(Không probe được: ${err instanceof Error ? err.message.slice(0, 100) : String(err)})`
  }

  const lines: string[] = []
  lines.push('--- Runtime Capabilities (đã XÁC NHẬN bằng thực thi thật lúc ' + new Date(report.probedAt).toLocaleTimeString('vi-VN') + ') ---')
  lines.push('Các tool dưới đây ĐÃ được probe runtime — chỉ dùng tool có trạng thái ✅ hoặc ⚠️:')
  for (const cap of report.capabilities) {
    lines.push(`${STATUS_ICON[cap.status]} ${cap.group} [${cap.tools.join(', ')}] — ${cap.detail}`)
  }
  lines.push('')
  lines.push('CÁCH GỌI TOOL (ReAct): viết đúng 1 dòng trong câu trả lời theo format:')
  lines.push('tool_call: <tên_tool>({ "arg1": "giá trị 1", ... })')
  lines.push('Sau khi tool trả kết quả (role: tool) bạn tiếp tục luận lý. KHÔNG gọi tool bị ❌.')
  lines.push('')
  lines.push('LÀM VIỆC LONG-RUNNING (task phức tạp nhiều bước):')
  lines.push('1. NGAY ĐẦU TIÊN gọi todo_write để chia nhỏ công việc thành các bước (status "pending").')
  lines.push('2. Đánh dấu "in_progress" khi bắt đầu 1 bước, "completed" khi xong, "failed"/"blocked" khi lỗi.')
  lines.push('3. Phát sinh bước mới → thêm vào todo_write. User theo dõi tiến độ thật của bạn qua panel "Agent Tasks".')
  lines.push('   todo_write({"todos":[{"content":"mô tả bước","status":"pending","priority":"high"}]})')
  lines.push('4. LIỆT KÊ SKILL động: list_skills({}) → danh sách skill + mô tả; đọc chi tiết: read_skill({"slug":"<slug>"}).')
  lines.push('5. LIỆT KÊ MCP server: mcp_list_servers({}) → servers + tools + trạng thái.')

  return '\n' + lines.join('\n')
}
