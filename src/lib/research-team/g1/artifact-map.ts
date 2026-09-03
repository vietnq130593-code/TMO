/**
 * RESEARCH TEAM — G1 ARTIFACT MAP (TB-10 §3 + §4 + gate E4 TC-14)
 * ==================================================================
 * Spec:
 *  - TB-10 §3 — Research Artifact Map: format M1 `artifact:type:metric_impact` ·
 *    M2 `file:type:relevance:status` (TB-00 §1.4).
 *  - TB-10 §4 — Dynamic Artifact Chain: mỗi artifact mới → entry mới (D1 append),
 *    KHÔNG ghi đè (D2 superseded), tracking FULL chain kể cả FAIL (D3).
 *  - TB-10 §9 — 5 status M2: planned | reading | audited | evidence-attached | superseded.
 *  - TB-13 §3 ResearchWorklog.artifactMapJson — 1 map G1 duy nhất (TB-10 §13 Q6).
 *  - Gate E4 TC-14: worklog thiếu Artifact Map → KHÔNG giao group kế (TB-09 §10 E4).
 *
 * Nguyên tắc (TB-13 §3): Prisma SQLite không dùng list primitive → artifactMap
 * encode JSON String trong DB; file này cung cấp pure builders/validators để
 * caller (engine.ts) encode qua encodeJson() khi persist.
 */

import type { SuccessCriterion } from '../types'

// ============================================================
// §1. TYPES — ArtifactEntry + ArtifactMap
// ============================================================

export type ArtifactType = 'code' | 'spec' | 'log' | 'data' | 'report'
export type ArtifactRelevance = 'core-target' | 'context' | 'evidence' | 'reference' | 'output'
export type ArtifactStatus = 'audited' | 'draft' | 'stale'

export interface ArtifactEntry {
  /** ID dạng file path hoặc artifact name (TB-00 §1.4) */
  id: string
  /** Loại artifact — M1/M2 unified set (TB-10 §3.1/§3.2) */
  type: ArtifactType
  /** Path đầy đủ (M2: có thể prefix LIVE: / WS: để phân biệt nguồn — TB-10 D4) */
  path: string
  /** Relevance tới mission (TB-10 §3.2 — core-target | context | evidence | ...) */
  relevance: ArtifactRelevance
  /** Status (TB-10 §9 — planned/reading/audited/evidence-attached/superseded).
   *  Simplified 3-tier cho P2: audited (đã đọc xong) | draft (chưa hoàn tất) | stale (cần re-compute) */
  status: ArtifactStatus
  /** Note tùy chọn — metric impact (M1) hoặc evidence ref (M2) */
  note?: string
}

export interface ArtifactMap {
  missionId: string
  taskId: string
  entries: ArtifactEntry[]
  generatedAt: string
  /** complete = entries.length > 0 (gate E4 TC-14: KHÔNG empty) */
  complete: boolean
}

// ============================================================
// §2. BUILD ARTIFACT MAP — pure (TB-10 §3.3 — 5 khối chuẩn)
// ============================================================

/**
 * Build ArtifactMap từ synthesis + filesChanged (TB-10 §3 + §10.1).
 *
 * Pure function — không LLM call, không side-effect. Caller (sivil.ts) pass
 * synthesis text + filesChanged list → trả về map đã build.
 *
 * Chiến lược:
 *  - Mỗi file trong filesChanged → 1 entry (type theo extension).
 *  - Relevance infer từ keyword trong synthesis (core-target | context | evidence).
 *  - Status: 'audited' nếu file có evidence mention, ngược lại 'draft'.
 *  - complete = entries.length > 0 (gate E4 TC-14 — chặn handoff nếu empty).
 */
export function buildArtifactMap(
  missionId: string,
  taskId: string,
  synthesis: string,
  filesChanged: string[],
): ArtifactMap {
  const generatedAt = new Date().toISOString()
  const safeFiles = (filesChanged || []).filter((f) => typeof f === 'string' && f.trim().length > 0)
  const safeSynthesis = synthesis || ''

  const entries: ArtifactEntry[] = safeFiles.map((file) => {
    const type = inferArtifactType(file)
    const relevance = inferRelevance(file, safeSynthesis)
    const status: ArtifactStatus = isInSynthesis(file, safeSynthesis) ? 'audited' : 'draft'
    const note = buildNote(file, safeSynthesis)
    return {
      id: shortId(file),
      type,
      path: file,
      relevance,
      status,
      note,
    }
  })

  // Dedupe theo path (D1 TB-10 §4 — append-only; nhưng trong cùng 1 build,
  // file trùng path giữ entry đầu)
  const seen = new Set<string>()
  const deduped = entries.filter((e) => {
    if (seen.has(e.path)) return false
    seen.add(e.path)
    return true
  })

  return {
    missionId,
    taskId,
    entries: deduped,
    generatedAt,
    complete: deduped.length > 0,
  }
}

/** Infer ArtifactType từ file extension (TB-10 §3.1/§3.2) */
function inferArtifactType(file: string): ArtifactType {
  const lower = file.toLowerCase()
  if (lower.endsWith('.py') || lower.endsWith('.ts') || lower.endsWith('.tsx') || lower.endsWith('.js')) {
    return 'code'
  }
  if (lower.endsWith('.md') || lower.endsWith('.txt')) {
    // Spec markdown vs report — heuristic qua prefix path
    if (lower.includes('spec') || lower.includes('task-')) return 'spec'
    return 'report'
  }
  if (lower.endsWith('.log') || lower.includes('dev.log') || lower.includes('pm2')) {
    return 'log'
  }
  if (lower.endsWith('.csv') || lower.endsWith('.json') || lower.endsWith('.ipynb')) {
    return 'data'
  }
  if (lower.startsWith('workspace/') || lower.startsWith('ws:')) {
    return 'report'
  }
  return 'code' // default
}

/** Infer relevance từ keyword trong synthesis (TB-10 §3.2) */
function inferRelevance(file: string, synthesis: string): ArtifactRelevance {
  const syn = synthesis.toLowerCase()
  const f = file.toLowerCase()

  // Core-target: file được nhắc là "main" / "core" / "key" / "primary"
  if (
    syn.includes(`${f}`) &&
    (syn.includes('main') || syn.includes('core') || syn.includes('primary') || syn.includes('key'))
  ) {
    return 'core-target'
  }

  // Evidence: file có trong evidence list (file:line pattern)
  if (syn.match(new RegExp(escapeRegex(f) + ':\\d+', 'i'))) {
    return 'evidence'
  }

  // Output: file trong workspace (BELI tạo)
  if (f.startsWith('workspace/') || f.startsWith('ws:')) {
    return 'output'
  }

  // Reference: file docs/README
  if (f.endsWith('.md') && (f.includes('readme') || f.includes('doc'))) {
    return 'reference'
  }

  // Context: default
  return 'context'
}

function isInSynthesis(file: string, synthesis: string): boolean {
  return synthesis.toLowerCase().includes(file.toLowerCase())
}

function buildNote(file: string, synthesis: string): string | undefined {
  // M1: tìm "CV -X.XXX" hoặc "Runtime X→Y min" gần file mention
  const lower = synthesis.toLowerCase()
  const fLower = file.toLowerCase()
  const idx = lower.indexOf(fLower)
  if (idx < 0) return undefined
  // Look ahead 200 chars for metric
  const around = lower.slice(idx, idx + 200)
  const metricMatch = around.match(/(cv[:\s-]*\d+\.\d+|runtime[:\s-]*\d+\s*→\s*\d+\s*min|delta[:\s-]*[+-]?\d+\.\d+)/i)
  if (metricMatch) return metricMatch[0]
  return undefined
}

function shortId(file: string): string {
  // Lấy basename + 4 char hash cho uniqueness (TB-00 §1.4 — ID ngắn)
  const parts = file.split('/')
  const base = parts[parts.length - 1] || file
  return base.replace(/[^a-zA-Z0-9._-]/g, '').slice(0, 32)
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// ============================================================
// §3. VALIDATE ARTIFACT MAP — gate E4 TC-14 (TB-09 §10 E4 + TB-10 §13 Q6)
// ============================================================

export interface ArtifactMapValidation {
  valid: boolean
  reason?: string
}

/**
 * Gate E4 TC-14 (TB-09 §10 E4): validate ArtifactMap trước khi handoff group kế.
 *  - map null/undefined → invalid (chặn handoff).
 *  - map.entries.length === 0 → invalid (empty map = no audit).
 *  - map.complete === false → invalid.
 *
 * SIVIL phải bổ sung map trước khi NEMESIS MONITOR pass.
 */
export function validateArtifactMap(map: ArtifactMap | null | undefined): ArtifactMapValidation {
  if (!map) {
    return {
      valid: false,
      reason: 'Artifact Map missing (gate E4 TC-14) — SIVIL phải build map trước khi handoff',
    }
  }
  if (!Array.isArray(map.entries) || map.entries.length === 0) {
    return {
      valid: false,
      reason: 'Artifact Map empty (gate E4 TC-14) — cần ≥ 1 entry trước khi giao group kế',
    }
  }
  if (map.complete === false) {
    return {
      valid: false,
      reason: 'Artifact Map not complete (gate E4 TC-14) — entries.length=0 → complete=false',
    }
  }
  return { valid: true }
}

// ============================================================
// §4. SUMMARIZE ARTIFACT MAP — pure helper (markdown report)
// ============================================================

/**
 * Sinh markdown summary của ArtifactMap cho worklog (TB-10 §3.3 — 5 khối chuẩn).
 * Pure helper — không side-effect.
 */
export function summarizeArtifactMap(map: ArtifactMap): string {
  if (!map || !map.entries || map.entries.length === 0) {
    return [
      '## Artifact Map',
      '(empty — gate E4 TC-14 sẽ chặn handoff)',
      `- missionId: ${map?.missionId || '(unknown)'}`,
      `- taskId: ${map?.taskId || '(unknown)'}`,
    ].join('\n')
  }

  const lines: string[] = []
  lines.push('## Artifact Map')
  lines.push(`- Mission: ${map.missionId}`)
  lines.push(`- Task: ${map.taskId}`)
  lines.push(`- Generated: ${map.generatedAt}`)
  lines.push(`- Complete: ${map.complete ? '✅' : '❌'} (${map.entries.length} entries)`)
  lines.push('')
  lines.push('### Artifact Chain')
  lines.push('| ID | Type | Relevance | Status | Path | Note |')
  lines.push('|---|---|---|---|---|---|')
  for (const e of map.entries) {
    lines.push(
      `| ${e.id} | ${e.type} | ${e.relevance} | ${formatStatus(e.status)} | ${e.path} | ${e.note || '—'} |`,
    )
  }

  // Reading Strategy cho G sau (TB-10 §3.3 khối 4)
  lines.push('')
  lines.push('### Reading Strategy cho G sau')
  const coreTargets = map.entries.filter((e) => e.relevance === 'core-target')
  const evidence = map.entries.filter((e) => e.relevance === 'evidence')
  const context = map.entries.filter((e) => e.relevance === 'context')
  if (coreTargets.length > 0) {
    lines.push(`🔴 Ưu tiên ĐẦU (core-target — ${coreTargets.length}):`)
    for (const e of coreTargets.slice(0, 5)) lines.push(`  - ${e.path}`)
  }
  if (evidence.length > 0) {
    lines.push(`🟠 Ưu tiên 2 (evidence — ${evidence.length}):`)
    for (const e of evidence.slice(0, 5)) lines.push(`  - ${e.path}`)
  }
  if (context.length > 0) {
    lines.push(`🟡 Ưu tiên 3 (context — ${context.length}):`)
    for (const e of context.slice(0, 3)) lines.push(`  - ${e.path} (scan-qua)`)
  }
  const skipped = map.entries.filter((e) => e.status === 'stale')
  if (skipped.length > 0) {
    lines.push(`❌ KHÔNG cần đọc (stale — ${skipped.length}):`)
    for (const e of skipped.slice(0, 3)) lines.push(`  - ${e.path}`)
  }

  return lines.join('\n')
}

function formatStatus(status: ArtifactStatus): string {
  switch (status) {
    case 'audited':
      return '✅ audited'
    case 'draft':
      return '⚠️ draft'
    case 'stale':
      return '❌ stale'
    default:
      return status
  }
}

// ============================================================
// §5. VALIDATE SUCCESS CRITERIA — TC-13 helper (council ① gate)
// ============================================================

/**
 * Gate TC-13 (TB-07 §11 Q5): task .md thiếu Success Criteria → council ① VETO.
 * Pure helper — engine.ts dùng trong runCouncil round 1.
 */
export function validateSuccessCriteria(
  criteria: SuccessCriterion[] | null | undefined,
): { valid: boolean; reason?: string } {
  if (!criteria || !Array.isArray(criteria) || criteria.length === 0) {
    return {
      valid: false,
      reason: 'Success Criteria missing (gate TC-13) — task .md phải có ≥ 1 criterion trước ASSIGN',
    }
  }
  // Mỗi criterion phải có 'criterion' (text) + 'measure' (cách verify)
  for (const c of criteria) {
    if (!c.criterion || !c.criterion.trim()) {
      return {
        valid: false,
        reason: `Success Criterion ${c.id || '?'} thiếu 'criterion' text (gate TC-13)`,
      }
    }
    if (!c.measure || !c.measure.trim()) {
      return {
        valid: false,
        reason: `Success Criterion ${c.id || '?'} thiếu 'measure' (cách verify) — gate TC-13`,
      }
    }
  }
  return { valid: true }
}
