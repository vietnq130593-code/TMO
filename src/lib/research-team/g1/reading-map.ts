/**
 * RESEARCH TEAM — G1 READING MAP (TB-10 §1-§2 — directed reading 1 map G1 duy nhất)
 * ===================================================================================
 * Spec:
 *  - TB-10 §1.3 — Directed Reading 4 bước: (1) đọc Artifact Map → (2) đọc code
 *    selective → (3) đọc Research Protocol → (4) fix + verify + update map.
 *  - TB-10 §2 — 3 lớp thông tin: Research Protocol (TL) | Worklog + Artifact Map
 *    (Group) | Ground Truth M1/M2 (code/data/logs thật).
 *  - TB-10 §5.5 — SIVIL/BELI (G1) đọc map từ group/part trước (quy tắc 2).
 *  - TB-10 §13 Q6 — SA trả map-fragments trong findings; SIVIL tổng hợp 1 map
 *    G1 duy nhất (tránh trùng lặp entry).
 *
 * Reading Map ≠ Artifact Map:
 *  - Reading Map = kế hoạch ĐỌC (file nào cần đọc, vì sao, mức ưu tiên).
 *  - Artifact Map = bản đồ ARTIFACT đã/đang tạo (TB-10 §3 — file này khác).
 *
 * Fail-open policy (TB-13 §4 — NIM keys placeholder):
 *  - LLM error → targets=[] + note "LLM unavailable"; KHÔNG crash.
 */

import { callLLM } from '@/lib/llm'
import type { LLMResult } from '@/lib/llm'
import { RESEARCH_ROSTER, AGENT_ID } from '../constants'
import { existsSync, statSync } from 'fs'
import { join, resolve, isAbsolute } from 'path'

// ============================================================
// §1. TYPES — ReadingTarget + ReadingMap
// ============================================================

export type ReadingRelevance = 'core' | 'context' | 'reference'
export type ReadingStatus = 'pending' | 'read' | 'skipped'

export interface ReadingTarget {
  /** Path file cần đọc (tương đối hoặc tuyệt đối) */
  path: string
  /** Lý do cần đọc file này (1-2 câu) */
  reason: string
  /** Mức độ liên quan — core (đọc sâu) | context (scan-qua) | reference (lookup) */
  relevance: ReadingRelevance
  /** Status: pending (chưa đọc) | read (đã đọc) | skipped (đã bỏ qua — không tồn tại/relevant) */
  status: ReadingStatus
}

export interface ReadingMap {
  missionId: string
  targets: ReadingTarget[]
  generatedAt: string
  /** Workspace root (path cơ sở cho targets tương đối) */
  workspaceRoot?: string
  /** Note nếu LLM fail-open hoặc targets rỗng */
  note?: string
}

// ============================================================
// §2. SYSTEM PROMPT — directed reading planner
// ============================================================

const READING_MAP_SYSTEM_PROMPT = [
  'Bạn là SIVIL (G1 Sub-Orchestrator — research team TMO).',
  `JD: ${RESEARCH_ROSTER.find((r) => r.id === AGENT_ID.SIVIL)?.jd ?? 'Biến 1 task thành N hướng explore song song'}.`,
  '',
  'NHIỆM VỤ — DIRECTED READING (TB-10 §1.3):',
  '- Lập kế hoạch đọc SELECTIVE cho G1 — KHÔNG đọc mù toàn bộ artifacts.',
  '- Ưu tiên theo relevance: core (đọc sâu) → context (scan) → reference (lookup).',
  '- Mỗi target phải có lý do cụ thể (file:line nào cần, vì sao).',
  '',
  'NGUYÊN TẮC (TB-10 §5.5 + §5.6):',
  '- Mỗi G khi BẮT ĐẦU part → đọc Artifact Map TRƯỚC khi đọc code.',
  '- Chỉ đọc artifacts ✅ cần đọc; bỏ qua ❌ (TB-10 quy tắc 2).',
  '- M2: Live System READ-ONLY; Workspace mới được viết/chỉnh.',
  '',
  'OUTPUT JSON ONLY:',
  '{',
  '  "targets": [',
  '    {',
  '      "path": "src/lib/memory.ts",',
  '      "reason": "Đọc memory coordination logic — core target cho audit memory arch",',
  '      "relevance": "core"',
  '    },',
  '    {',
  '      "path": "src/lib/llm.ts",',
  '      "reason": "Đọc retry/timeout behavior — evidence cho chat latency 121s",',
  '      "relevance": "core"',
  '    }',
  '  ]',
  '}',
].join('\n')

// ============================================================
// §3. BUILD READING MAP — async (LLM call)
// ============================================================

/**
 * Build ReadingMap cho 1 mission + task description.
 *  - Gọi callLLM sinh danh sách file cần đọc (directed — KHÔNG đọc mù).
 *  - workspaceRoot mặc định = process.cwd()/workspace/research/<missionId>.
 *  - LLM error → fail-open: targets=[] + note "LLM unavailable".
 *
 * TB-10 §5.5 quy tắc 2: Mỗi G khi BẮT ĐẦU part → đọc map TRƯỚC code.
 * Caller (engine.ts runG1Round) gọi hàm này TRƯỚC khi SIVIL dispatch SA.
 */
export async function buildReadingMap(
  missionId: string,
  taskDescription: string,
  workspaceRoot?: string,
): Promise<ReadingMap> {
  const generatedAt = new Date().toISOString()
  const root = workspaceRoot || defaultWorkspaceRoot(missionId)

  const userPrompt = [
    `MISSION: ${missionId}`,
    `TASK: ${taskDescription}`,
    `WORKSPACE ROOT: ${root}`,
    '',
    'Lập kế hoạch đọc directed — 5-15 file cần đọc cho task này.',
    'Mỗi file kèm reason + relevance (core/context/reference).',
    'Output JSON theo schema đã nêu.',
  ].join('\n')

  let llm: LLMResult
  try {
    llm = await callLLM(userPrompt, READING_MAP_SYSTEM_PROMPT, 'g1-reading-map', {
      temperature: 0.2,
      maxTokens: 2000,
      agentId: 'SIVIL',
      agentName: 'SIVIL (Sub-Orchestrator)',
    })
  } catch (err) {
    return failOpenReadingMap(missionId, root, generatedAt, err)
  }

  if (llm.error) {
    return failOpenReadingMap(missionId, root, generatedAt, llm.error)
  }

  const parsed = extractJsonFromContent(llm.content)
  if (!parsed) {
    return failOpenReadingMap(missionId, root, generatedAt, 'JSON parse failed')
  }

  const targets = toReadingTargets(parsed.targets, root)

  return {
    missionId,
    targets,
    generatedAt,
    workspaceRoot: root,
    note:
      targets.length === 0
        ? 'LLM trả targets rỗng — SIVIL có thể cần tự bổ sung target trước khi dispatch SA'
        : undefined,
  }
}

/** Default workspace root — TB-01 §3 + TB-13 §7 */
function defaultWorkspaceRoot(missionId: string): string {
  return join(process.cwd(), 'workspace', 'research', missionId)
}

/** Fail-open builder — LLM error → targets rỗng + note */
function failOpenReadingMap(
  missionId: string,
  root: string,
  generatedAt: string,
  err: unknown,
): ReadingMap {
  const reason = err instanceof Error ? err.message : String(err)
  console.warn('[ResearchTeam/g1/reading-map] LLM fail-open:', reason)
  return {
    missionId,
    targets: [],
    generatedAt,
    workspaceRoot: root,
    note: `LLM unavailable — targets rỗng; SIVIL cần tự bổ sung target hoặc ESCALATE nếu không có baseline (TB-13 §4 fail-open)`,
  }
}

// ============================================================
// §4. MARK READ — update target status (pure-ish — returns new map)
// ============================================================

/**
 * Update status 1 target sang 'read' (hoặc 'skipped' nếu path không tồn tại).
 * Trả về ReadingMap mới (immutable — KHÔNG mutate input).
 *
 * TB-10 §5.6 quy tắc 6: mỗi artifact mới → UPDATE MAP NGAY. Hàm này hỗ trợ
 * cập nhật status khi SIVIL/BELI đã đọc xong 1 file.
 */
export async function markRead(
  map: ReadingMap,
  path: string,
): Promise<ReadingMap> {
  if (!map || !map.targets) return map || { missionId: '', targets: [], generatedAt: new Date().toISOString() }

  const normalizedPath = normalizePath(path, map.workspaceRoot)
  const exists = fileExistsSafe(normalizedPath)

  const targets = map.targets.map((t) => {
    if (normalizePath(t.path, map.workspaceRoot) !== normalizedPath) return t
    return {
      ...t,
      status: exists ? ('read' as ReadingStatus) : ('skipped' as ReadingStatus),
    }
  })

  return { ...map, targets }
}

/** Normalize path — resolve relative to workspaceRoot nếu không tuyệt đối */
function normalizePath(p: string, workspaceRoot?: string): string {
  if (!p) return ''
  if (isAbsolute(p)) return resolve(p)
  if (workspaceRoot) return resolve(join(workspaceRoot, p))
  return resolve(p)
}

/** Safe existsSync — KHÔNG throw trên path lạ */
function fileExistsSafe(p: string): boolean {
  try {
    return existsSync(p) && statSync(p).isFile()
  } catch {
    return false
  }
}

// ============================================================
// §5. SUMMARIZE MAP — pure helper (markdown report)
// ============================================================

/**
 * Sinh markdown summary của ReadingMap cho worklog (TB-10 §3.3 khối 4 —
 * Reading Strategy cho G sau).
 * Pure helper — không side-effect.
 */
export function summarizeMap(map: ReadingMap): string {
  if (!map || !map.targets || map.targets.length === 0) {
    return [
      '## Reading Map',
      '(empty — SIVIL chưa lập kế hoạch đọc)',
      `- missionId: ${map?.missionId || '(unknown)'}`,
      `- workspaceRoot: ${map?.workspaceRoot || '(default)'}`,
      map?.note ? `- note: ${map.note}` : '',
    ]
      .filter(Boolean)
      .join('\n')
  }

  const lines: string[] = []
  lines.push('## Reading Map')
  lines.push(`- Mission: ${map.missionId}`)
  lines.push(`- Generated: ${map.generatedAt}`)
  lines.push(`- Workspace Root: ${map.workspaceRoot || '(default)'}`)
  if (map.note) lines.push(`- Note: ${map.note}`)
  lines.push('')

  // Group theo relevance
  const core = map.targets.filter((t) => t.relevance === 'core')
  const context = map.targets.filter((t) => t.relevance === 'context')
  const reference = map.targets.filter((t) => t.relevance === 'reference')

  if (core.length > 0) {
    lines.push(`### 🔴 Core targets (đọc sâu — ${core.length})`)
    for (const t of core) lines.push(`- [${t.status}] ${t.path} — ${t.reason}`)
  }
  if (context.length > 0) {
    lines.push('')
    lines.push(`### 🟡 Context (scan-qua — ${context.length})`)
    for (const t of context) lines.push(`- [${t.status}] ${t.path} — ${t.reason}`)
  }
  if (reference.length > 0) {
    lines.push('')
    lines.push(`### 📘 Reference (lookup — ${reference.length})`)
    for (const t of reference) lines.push(`- [${t.status}] ${t.path} — ${t.reason}`)
  }

  // Summary stats
  const readCount = map.targets.filter((t) => t.status === 'read').length
  const skippedCount = map.targets.filter((t) => t.status === 'skipped').length
  const pendingCount = map.targets.filter((t) => t.status === 'pending').length
  lines.push('')
  lines.push('### Stats')
  lines.push(`- Read: ${readCount} · Skipped: ${skippedCount} · Pending: ${pendingCount} · Total: ${map.targets.length}`)

  return lines.join('\n')
}

// ============================================================
// §6. HELPERS — JSON parse + array conversion
// ============================================================

/** Extract JSON object từ LLM content — 3 strategies */
function extractJsonFromContent(content: string): Record<string, unknown> | null {
  if (!content || typeof content !== 'string') return null
  const trimmed = content.trim()

  try {
    const parsed = JSON.parse(trimmed)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed
  } catch {
    // fallthrough
  }

  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i)
  if (fenceMatch) {
    try {
      const parsed = JSON.parse(fenceMatch[1])
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed
    } catch {
      // fallthrough
    }
  }

  const braceMatch = trimmed.match(/\{[\s\S]*\}/)
  if (braceMatch) {
    try {
      const parsed = JSON.parse(braceMatch[0])
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed
    } catch {
      // fallthrough
    }
  }

  return null
}

function toReadingTargets(value: unknown, _workspaceRoot?: string): ReadingTarget[] {
  if (!Array.isArray(value)) return []
  const out: ReadingTarget[] = []
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') continue
    const r = raw as Record<string, unknown>
    const path = typeof r.path === 'string' ? r.path : ''
    if (!path) continue
    const reason = typeof r.reason === 'string' ? r.reason : '(no reason provided)'
    const relevance = isValidRelevance(r.relevance) ? (r.relevance as ReadingRelevance) : 'context'
    out.push({
      path,
      reason,
      relevance,
      status: 'pending',
    })
  }
  return out
}

function isValidRelevance(v: unknown): v is ReadingRelevance {
  return v === 'core' || v === 'context' || v === 'reference'
}
