/**
 * RESEARCH TEAM — KING TASK .MD (TB-07 §2.5 task .md template + DR-C3 append-only + TC-13 gate)
 * ============================================================================================
 * Spec:
 *  - TB-07 §2.5 — Task .md template: header YAML (version/taskId/mission/tier/partIdx) +
 *    body sections (Title / Description / Input / Output / Constraints / Success Criteria
 *    / Research Protocol? / System Audit Charter? / CHANGELOG append-only).
 *  - DR-C3 — Append-only: version bump + CHANGELOG entry (KHÔNG rewrite lịch sử).
 *    bumpVersion tạo entry mới {at, field:'version', from:old, to:new, reason} + amendment.
 *  - TB-07 §11 Q5 + TC-13 gate — Success Criteria BẮT BUỘC trước ASSIGN (validateSuccessCriteria
 *    trả invalid nếu mảng rỗng — king/decompose.ts dùng để VETO council ①).
 *
 * Pure module — KHÔNG side-effect, KHÔNG import db/llm. Caller persist qua ResearchTask.
 *
 * Fail-open: KHÔNG throw — parse lỗi → fallback values hợp lệ (version=1, các trường rỗng).
 */

import type {
  SuccessCriterion,
  ChangelogEntry,
} from '../types'

// ============================================================
// §1. TYPES — TaskMdContent
// ============================================================

/**
 * Nội dung task .md — TB-07 §2.5 template (header YAML + body sections).
 *  - version: số amendment (DR-C3 — chỉ tăng, không giảm).
 *  - taskId: T-<MISSION>-<NNN>.
 *  - mission: code mission (MS-YYYYMMDD-NNN).
 *  - tier: T1|T2|T3 (lưu để trace).
 *  - partIdx: số part (1..N — KING DECOMPOSE).
 *  - successCriteria: BẮT BUỘC trước ASSIGN (gate TC-13).
 *  - changelog: append-only — mọi amendment ghi thêm (KHÔNG rewrite).
 *  - researchProtocol / systemAuditCharter: optional (M2 chỉ — TB-07 §2.5).
 */
export interface TaskMdContent {
  version: number
  taskId: string
  mission: string
  tier: string
  partIdx: number
  title: string
  description: string
  input: string
  output: string
  constraints: string[]
  successCriteria: SuccessCriterion[]
  changelog: ChangelogEntry[]
  /** Optional — TB-07 §2.5 M2 research protocol (lớn hơn T1) */
  researchProtocol?: string
  /** Optional — TB-07 §2.5 M2 system audit charter (redesign kiến trúc) */
  systemAuditCharter?: string
}

// ============================================================
// §2. RENDER — TaskMdContent → markdown string
// ============================================================

/**
 * Render TaskMdContent → markdown — TB-07 §2.5 format:
 *
 *   ---
 *   version: 1
 *   taskId: T-MS-001-001
 *   mission: MS-20260902-001
 *   tier: T2
 *   partIdx: 1
 *   ---
 *
 *   # Title
 *
 *   ## Description
 *   ...
 *
 *   ## Input
 *   ...
 *
 *   ## Output
 *   ...
 *
 *   ## Constraints
 *   - ...
 *
 *   ## Success Criteria
 *   - [SC-1] <criterion> — Measure: <measure>
 *
 *   ## Research Protocol (optional)
 *   ...
 *
 *   ## System Audit Charter (optional)
 *   ...
 *
 *   ## CHANGELOG
 *   - [v1] (ISO) — field 'version' from '(init)' to '1' — reason: initial draft
 *
 * Pure function — không side-effect.
 */
export function renderTaskMd(content: TaskMdContent): string {
  const lines: string[] = []

  // YAML frontmatter
  lines.push('---')
  lines.push(`version: ${content.version}`)
  lines.push(`taskId: ${content.taskId}`)
  lines.push(`mission: ${content.mission}`)
  lines.push(`tier: ${content.tier}`)
  lines.push(`partIdx: ${content.partIdx}`)
  lines.push('---')
  lines.push('')

  // Title
  lines.push(`# ${content.title || '(untitled task)'}`)
  lines.push('')

  // Description
  lines.push('## Description')
  lines.push(content.description || '(no description)')
  lines.push('')

  // Input
  lines.push('## Input')
  lines.push(content.input || '(no input)')
  lines.push('')

  // Output
  lines.push('## Output')
  lines.push(content.output || '(no output)')
  lines.push('')

  // Constraints
  lines.push('## Constraints')
  if (content.constraints && content.constraints.length > 0) {
    for (const c of content.constraints) {
      lines.push(`- ${c}`)
    }
  } else {
    lines.push('(none)')
  }
  lines.push('')

  // Success Criteria
  lines.push('## Success Criteria')
  if (content.successCriteria && content.successCriteria.length > 0) {
    for (const sc of content.successCriteria) {
      const metFlag = typeof sc.met === 'boolean' ? ` [${sc.met ? 'MET' : 'NOT-MET'}]` : ''
      lines.push(`- [${sc.id || '?'}] ${sc.criterion}${metFlag}`)
      lines.push(`  - Measure: ${sc.measure}`)
    }
  } else {
    lines.push('⚠️ EMPTY — gate TC-13 VETO sẽ chặn ASSIGN (TB-07 §11 Q5)')
  }
  lines.push('')

  // Research Protocol (optional)
  if (content.researchProtocol && content.researchProtocol.trim().length > 0) {
    lines.push('## Research Protocol')
    lines.push(content.researchProtocol)
    lines.push('')
  }

  // System Audit Charter (optional)
  if (content.systemAuditCharter && content.systemAuditCharter.trim().length > 0) {
    lines.push('## System Audit Charter')
    lines.push(content.systemAuditCharter)
    lines.push('')
  }

  // CHANGELOG (append-only — DR-C3)
  lines.push('## CHANGELOG')
  if (content.changelog && content.changelog.length > 0) {
    for (const e of content.changelog) {
      lines.push(
        `- [v${e.to || '?'}] (${e.at}) — field '${e.field}' from '${e.from}' to '${e.to}' — reason: ${e.reason}`,
      )
    }
  } else {
    lines.push(`- [v1] (${new Date().toISOString()}) — initial draft`)
  }

  return lines.join('\n')
}

// ============================================================
// §3. PARSE — markdown → TaskMdContent (defensive)
// ============================================================

/**
 * Parse markdown → TaskMdContent — defensive:
 *  - YAML frontmatter (giữa `---` lines) → version/taskId/mission/tier/partIdx.
 *  - Section markdown `## Heading` → fields tương ứng.
 *  - Lỗi parse → fallback giá trị hợp lệ (version=1, mảng rỗng).
 *
 * Pure function — không throw.
 */
export function parseTaskMd(md: string): TaskMdContent {
  const fallback: TaskMdContent = {
    version: 1,
    taskId: '',
    mission: '',
    tier: '',
    partIdx: 1,
    title: '',
    description: '',
    input: '',
    output: '',
    constraints: [],
    successCriteria: [],
    changelog: [],
  }
  if (!md || typeof md !== 'string' || md.trim().length === 0) return fallback

  const lines = md.split('\n')

  // 1. Parse YAML frontmatter (giữa 2 dòng `---` đầu tiên)
  const yamlFields = parseYamlFrontmatter(lines)
  const version = parsePosInt(yamlFields.version, 1)
  const partIdx = parsePosInt(yamlFields.partIdx, 1)

  // 2. Parse sections (`## Heading` blocks)
  const sections = parseSections(lines)

  return {
    version,
    taskId: yamlFields.taskId || fallback.taskId,
    mission: yamlFields.mission || fallback.mission,
    tier: yamlFields.tier || fallback.tier,
    partIdx,
    title: extractH1(lines) || extractFirstLine(sections['Description'] || ''),
    description: sections['Description']?.trim() || fallback.description,
    input: sections['Input']?.trim() || fallback.input,
    output: sections['Output']?.trim() || fallback.output,
    constraints: parseBulletList(sections['Constraints']),
    successCriteria: parseSuccessCriteriaSection(sections['Success Criteria']),
    changelog: parseChangelogSection(sections['CHANGELOG']),
    researchProtocol: sections['Research Protocol']?.trim() || undefined,
    systemAuditCharter: sections['System Audit Charter']?.trim() || undefined,
  }
}

// ============================================================
// §4. VALIDATE SUCCESS CRITERIA — gate TC-13 (TB-07 §11 Q5)
// ============================================================

/**
 * Validate Success Criteria — gate TC-13 (TB-07 §11 Q5):
 *  - Empty array → invalid 'Success Criteria required before ASSIGN (TC-13)'.
 *  - Mỗi criterion phải có 'criterion' (text) + 'measure' (cách verify).
 *
 * King/decompose.ts gọi BEFORE ASSIGNED → VETO council ① nếu thiếu.
 * Pure function — không throw.
 */
export function validateSuccessCriteria(
  content: TaskMdContent,
): { valid: boolean; reason?: string } {
  if (!content.successCriteria || content.successCriteria.length === 0) {
    return {
      valid: false,
      reason: 'Success Criteria required before ASSIGN (TC-13)',
    }
  }
  for (const sc of content.successCriteria) {
    if (!sc.criterion || sc.criterion.trim().length === 0) {
      return {
        valid: false,
        reason: `Success Criterion ${sc.id || '?'} thiếu 'criterion' text — gate TC-13`,
      }
    }
    if (!sc.measure || sc.measure.trim().length === 0) {
      return {
        valid: false,
        reason: `Success Criterion ${sc.id || '?'} thiếu 'measure' (cách verify) — gate TC-13`,
      }
    }
  }
  return { valid: true }
}

// ============================================================
// §5. BUMP VERSION — DR-C3 append-only (KHÔNG rewrite)
// ============================================================

/**
 * Bump version — DR-C3 append-only:
 *  - version = old + 1.
 *  - Append ChangelogEntry {at, field:'version', from:old, to:new, reason} vào changelog.
 *  - Append amendment text vào changelog (TB-07 §2.5 CHANGELOG block format).
 *
 * KHÔNG rewrite — giữ toàn bộ lịch sử amendment. Caller persist qua PATCH /tasks/[id].
 */
export function bumpVersion(
  content: TaskMdContent,
  amendment: { amendment: string; reason: string },
): TaskMdContent {
  const oldVersion = content.version
  const newVersion = oldVersion + 1
  const at = new Date().toISOString()

  const changelogEntry: ChangelogEntry = {
    at,
    field: 'version',
    from: String(oldVersion),
    to: String(newVersion),
    reason: amendment.reason || `(v${oldVersion} → v${newVersion}) ${amendment.amendment}`,
  }

  return {
    ...content,
    version: newVersion,
    changelog: [...(content.changelog || []), changelogEntry],
  }
}

// ============================================================
// §6. INTERNAL HELPERS — YAML/section parsing (defensive)
// ============================================================

function parseYamlFrontmatter(lines: string[]): Record<string, string> {
  const out: Record<string, string> = {}
  if (lines.length < 2 || lines[0].trim() !== '---') return out

  let i = 1
  while (i < lines.length && lines[i].trim() !== '---') {
    const line = lines[i]
    const idx = line.indexOf(':')
    if (idx > 0) {
      const key = line.slice(0, idx).trim()
      const value = line.slice(idx + 1).trim()
      if (key && value) out[key] = value
    }
    i++
  }
  return out
}

function parseSections(lines: string[]): Record<string, string> {
  const sections: Record<string, string> = {}
  let currentHeading = ''
  let buffer: string[] = []

  const flush = () => {
    if (currentHeading) {
      sections[currentHeading] = buffer.join('\n').trim()
    }
  }

  for (const line of lines) {
    const m = line.match(/^##\s+(.+?)\s*$/)
    if (m) {
      flush()
      currentHeading = m[1].trim()
      buffer = []
    } else if (currentHeading) {
      buffer.push(line)
    }
  }
  flush()
  return sections
}

function extractH1(lines: string[]): string {
  for (const line of lines) {
    const m = line.match(/^#\s+(.+?)\s*$/)
    if (m) return m[1].trim()
  }
  return ''
}

function extractFirstLine(text: string): string {
  if (!text) return ''
  const first = text.split('\n').find((l) => l.trim().length > 0)
  return (first || '').trim()
}

function parseBulletList(section: string | undefined): string[] {
  if (!section) return []
  const items: string[] = []
  for (const line of section.split('\n')) {
    const m = line.match(/^\s*-\s+(.+?)\s*$/)
    if (m && m[1] !== '(none)') {
      items.push(m[1])
    }
  }
  return items
}

function parseSuccessCriteriaSection(section: string | undefined): SuccessCriterion[] {
  if (!section) return []
  const out: SuccessCriterion[] = []
  const lines = section.split('\n')

  let current: SuccessCriterion | null = null
  for (const line of lines) {
    const m = line.match(/^\s*-\s*\[([^\]]+)\]\s*(.+?)\s*(?:\[(MET|NOT-MET)\])?\s*$/)
    if (m) {
      if (current) out.push(current)
      current = {
        id: m[1].trim(),
        criterion: m[2].trim(),
        measure: '',
        met: m[3] ? m[3] === 'MET' : undefined,
      }
    } else if (current) {
      const mm = line.match(/^\s*-\s*Measure:\s*(.+?)\s*$/)
      if (mm) {
        current.measure = mm[1].trim()
      }
    }
  }
  if (current) out.push(current)

  // Filter invalid (criterion empty)
  return out.filter((sc) => sc.criterion && sc.criterion.trim().length > 0)
}

function parseChangelogSection(section: string | undefined): ChangelogEntry[] {
  if (!section) return []
  const out: ChangelogEntry[] = []
  for (const line of section.split('\n')) {
    const m = line.match(
      /^\s*-\s*\[v([^\]]+)\]\s*\(([^)]+)\)\s*—\s*field\s+'([^']+)'\s*from\s+'([^']*)'\s*to\s+'([^']*)'\s*—\s*reason:\s*(.+?)\s*$/,
    )
    if (m) {
      out.push({
        at: m[2].trim(),
        field: m[3].trim(),
        from: m[4].trim(),
        to: m[5].trim(),
        reason: m[6].trim(),
      })
    }
  }
  return out
}

function parsePosInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback
  const n = Number.parseInt(value, 10)
  if (!Number.isFinite(n) || n < 1) return fallback
  return n
}
