/**
 * RESEARCH TEAM — G3 KB STORE (TB-05 §5 KB 3 tầng + DR-C6 + TB-08 capture/curate)
 * =================================================================================
 * Spec:
 *  - TB-05 §5 — Team Knowledge Base 9 categories (lesson, anti-pattern, baseline,
 *    pattern, calibration, ...). HAN là Curator (consolidate/dedup/retire).
 *  - DR-C6 — KB 3 lớp:
 *      (1) Canonical = SQLite/Prisma ResearchKBEntry (versioned, soft-delete retire).
 *      (2) Snapshot .md multi-file + index.md (artifact cho Directed Reading).
 *      (3) Live System read-only qua snapshot — mọi write qua KB Write Protocol.
 *  - TB-05 §9 E1 + TC-05 — Cold-start seed: KB trống → seed starter entries từ
 *    bảng nguồn §5.1. Idempotent (chỉ seed khi count()===0).
 *  - TB-08 §4 + DECISION-RECORD v1.3 — Curate kép 3 mốc (KB_CURATE_PHASES):
 *      phase 1 (NEW)  → phase 2 (CURATED) → phase 3 (FINALIZED).
 *    Chu kỳ: (a) mỗi ~10 entry NEW; (b) cuối mission; (c) định kỳ 7 ngày.
 *  - TB-05 §6.3 — RETIRE: soft-delete (retiredAt = now, KHÔNG xóa — giữ audit
 *    trail). Lý do: DUPLICATE | OUTDATED | REFUTED | SUPERSEDED.
 *  - TB-05 §7.4 — KB Entry Schema 8 trường (ID/Category/Insight/Evidence/Source/
 *    Mission/Status + Confidence: HIGH/MEDIUM/LOW).
 *
 * Bất biến:
 *  - KHÔNG xóa entry — chỉ soft-delete qua retiredAt (DR-C6 + TB-05 §6.4 I5).
 *  - curatePhase CHỈ tăng phase (1→2→3), KHÔNG hạ (TB-08 §4).
 *  - append-only audit: mọi curate/retire ghi note vào content (KHÔNG rewrite).
 *  - snapshot .md regenerate sau mỗi capture/curate (DR-C6 tầng 2).
 *
 * Fail-open: mọi function wrap try/catch. DB/fs error → throw (caller handle).
 * Hàm get/query trả null/empty array khi DB error (non-blocking reads).
 */

import { promises as fs } from 'fs'
import { join, resolve, isAbsolute } from 'path'
import { db } from '@/lib/db'
import { KB_CURATE_PHASES } from '../constants'
import type { KBEntryCategoryValue, ResearchKBEntry } from '../types'

// ============================================================
// §0. VALID KB CATEGORIES — TASK 3-fix WORK 7b (audit F.33 fix)
// ============================================================

/**
 * Danh sách category hợp lệ cho KB entry (TB-05 §5 + TB-14 calibration).
 * Trước đây addEntry KHÔNG validate category → caller có thể truyền 'INVALID'
 * hoặc bất kỳ string nào → DB poison. Giờ enforce enum (caller 400 nếu sai).
 */
export const VALID_KB_CATEGORIES: readonly string[] = [
  'lesson',
  'anti-pattern',
  'baseline',
  'pattern',
  'calibration',
] as const

/** Validate KB category — true nếu thuộc VALID_KB_CATEGORIES. */
export function isValidKBCategory(category: string): boolean {
  return VALID_KB_CATEGORIES.includes(category)
}

/**
 * Resolve snapshot output dir AN TOÀN — TASK 3-fix WORK 7a (audit F.32 fix).
 *
 * Path traversal protection:
 *  - Default: DEFAULT_SNAPSHOT_DIR (workspace/research/kb-snapshot)
 *  - If outputDir provided:
 *    - Reject absolute paths outside workspace/research/
 *    - Reject paths containing '..' (parent traversal)
 *    - Resolve relative to process.cwd()/workspace/research/
 *
 * Trả error object thay vì throw — caller API trả 400 graceful.
 */
export function resolveSnapshotDir(
  outputDir?: string,
): { ok: true; dir: string } | { ok: false; error: string } {
  // Default
  if (!outputDir || outputDir.trim().length === 0) {
    return { ok: true, dir: resolve(DEFAULT_SNAPSHOT_DIR) }
  }

  const trimmed = outputDir.trim()

  // Reject any path containing '..' segments (parent traversal attempt)
  // (covers both 'workspace/../etc' and 'foo/../../etc')
  if (/\.\.[\\/]/.test(trimmed) || trimmed === '..' || trimmed.endsWith('..')) {
    return {
      ok: false,
      error: `Snapshot outputDir chứa '..' — path traversal blocked (F.32): ${trimmed}`,
    }
  }

  // Resolve to absolute (relative to cwd if input is relative)
  const resolved = resolve(trimmed)

  // Workspace root — chỉ cho phép ghi trong process.cwd()/workspace/research/
  const workspaceResearchRoot = resolve(join(process.cwd(), 'workspace', 'research'))

  // Check resolved path phải nằm trong workspace/research/
  if (!resolved.startsWith(workspaceResearchRoot + '/') && resolved !== workspaceResearchRoot) {
    return {
      ok: false,
      error: `Snapshot outputDir ngoài workspace/research/ — path traversal blocked (F.32): resolved=${resolved}, allowed-root=${workspaceResearchRoot}`,
    }
  }

  // Reject if absolute outside workspace AND caller tried absolute path
  if (isAbsolute(trimmed)) {
    if (!trimmed.startsWith(workspaceResearchRoot)) {
      return {
        ok: false,
        error: `Absolute path ngoài workspace/research/ blocked (F.32): ${trimmed}`,
      }
    }
  }

  return { ok: true, dir: resolved }
}

// ============================================================
// §1. TYPES — KBEntryInput + snapshot result
// ============================================================

/**
 * Input cho addEntry — TB-05 §7.4 KB Entry Schema:
 *  - category: lesson | anti-pattern | baseline | pattern | calibration | ...
 *  - title: 1 câu ngắn, actionable (Insight).
 *  - content: Evidence/Context (file:line | log excerpt | metric | discussion ref)
 *    + Source + Mission + Confidence (HIGH/MEDIUM/LOW — TB-05 §11 Q6 trường 8).
 *  - sourceMission: code mission (MS-YYYYMMDD-NNN) nếu có.
 *  - applicability: TB-14 §5 context-fit block (optional P4 — dùng đầy đủ P2b scoring).
 *    Encode JSON String vào content section "## Applicability" (DR-C6 — KHÔNG thêm
 *    cột Prisma; everything inside content để versioned + soft-delete).
 */
export interface KBEntryInput {
  category: KBEntryCategoryValue
  title: string
  content: string
  sourceMission?: string
  /** TB-14 §5 context-fit block — optional P4; encode JSON vào content section. */
  applicability?: Record<string, unknown>
}

/** Snapshot export result (DR-C6 tầng 2). */
export interface SnapshotResult {
  files: string[]
  indexMd: string
  generatedAt: string
}

/** KB stats cho health/dashboard. */
export interface KBStats {
  total: number
  active: number
  retired: number
  byCategory: Record<string, number>
  byPhase: Record<number, number>
  snapshotGeneratedAt?: string
}

// ============================================================
// §2. ADD ENTRY — TB-05 §7.4 KB Entry Schema
// ============================================================

/**
 * Add new KB entry (phase=1 NEW mặc định).
 * TB-05 §7.4 + DR-C6 tầng 1:
 *  - db.researchKBEntry.create với category/title/content/sourceMission/phase.
 *  - applicability (nếu có) → encode JSON + append vào content section
 *    "## Applicability" (DR-C6 — mọi metadata nằm content, versioned cùng entry).
 *  - Snapshot .md regeneration: caller quyết (captureAtFinalize / API snapshot).
 *
 * Caller có thể set phase khác 1 cho candidate được promote (TB-08 §8 flow).
 *
 * TASK 3-fix WORK 7b (audit F.33 fix): validate category enum — throw nếu sai.
 */
export async function addEntry(
  input: KBEntryInput,
  phase: 1 | 2 | 3 = 1,
): Promise<{ id: string; entry: ResearchKBEntry }> {
  // Validate category enum (F.33 fix)
  if (!input.category || !isValidKBCategory(String(input.category))) {
    throw new Error(
      `addEntry: category "${input.category}" không hợp lệ. Valid: ${VALID_KB_CATEGORIES.join(' | ')}`,
    )
  }
  if (!input.title || !input.title.trim()) {
    throw new Error('addEntry: title BẮT BUỘC non-empty')
  }
  if (!input.content || !input.content.trim()) {
    throw new Error('addEntry: content BẮT BUỘC non-empty')
  }

  const finalContent = buildEntryContent(input.content, input.applicability)

  const row = await db.researchKBEntry.create({
    data: {
      category: String(input.category),
      title: input.title,
      content: finalContent,
      sourceMission: input.sourceMission ?? null,
      phase: validatePhase(phase),
      retiredAt: null,
    },
  })

  return { id: row.id, entry: row }
}

// ============================================================
// §3. GET / QUERY — non-throwing reads
// ============================================================

export async function getEntry(id: string): Promise<ResearchKBEntry | null> {
  try {
    const row = await db.researchKBEntry.findUnique({ where: { id } })
    return row ?? null
  } catch (err) {
    console.warn(
      '[KBStore] getEntry failed (non-blocking — null):',
      err instanceof Error ? err.message : String(err),
    )
    return null
  }
}

export interface QueryKBParams {
  category?: string
  phase?: number
  search?: string
  /** Default 50 — không vượt 200. */
  limit?: number
  offset?: number
  /** Include retired entries? Default false (chỉ active). */
  includeRetired?: boolean
}

/**
 * Query KB với filters + optional full-text search (SQLite LIKE trên title/content).
 * TB-05 §7.2 — quy tắc đọc hiệu quả: load theo filter (Mission + Category + keywords)
 * thay vì toàn bộ file; token budget đọc KB tính vào ngân sách ~6–10K của G3.
 */
export async function queryKB(params: QueryKBParams = {}): Promise<ResearchKBEntry[]> {
  try {
    const limit = Math.min(Math.max(params.limit ?? 50, 1), 200)
    const offset = Math.max(params.offset ?? 0, 0)

    const where: Record<string, unknown> = {}
    if (params.category) where.category = params.category
    if (typeof params.phase === 'number' && Number.isFinite(params.phase)) {
      where.phase = Math.trunc(params.phase)
    }
    if (!params.includeRetired) {
      where.retiredAt = null
    }
    if (params.search && params.search.trim().length > 0) {
      const kw = params.search.trim()
      where.OR = [
        { title: { contains: kw } },
        { content: { contains: kw } },
      ]
    }

    const rows = await db.researchKBEntry.findMany({
      where,
      orderBy: [{ phase: 'asc' }, { createdAt: 'desc' }],
      take: limit,
      skip: offset,
    })
    return rows
  } catch (err) {
    console.warn(
      '[KBStore] queryKB failed (non-blocking — empty):',
      err instanceof Error ? err.message : String(err),
    )
    return []
  }
}

// ============================================================
// §4. RETIRE — soft-delete (TB-05 §6.3 + DR-C6)
// ============================================================

/**
 * Retire KB entry — soft-delete:
 *  - Set retiredAt = now (KHÔNG xóa — DR-C6 giữ audit trail).
 *  - Append note vào content: "## Retire Note — {reason} — {timestamp}".
 *
 * TB-05 §6.3 — 4 lý do retire:
 *  - DUPLICATE — trùng lặp, đã merge vào entry khác.
 *  - OUTDATED — lỗi thời, công nghệ/config đổi.
 *  - REFUTED — bị vượt refute, evidence mới mâu thuẫn.
 *  - SUPERSEDED — có entry mới hơn, evidence mạnh hơn.
 *
 * TB-05 §11 Q4 — PRE-APPROVAL: HAN liệt kê retire-candidates → NEMESIS duyệt tại
 * CP3 TRƯỚC khi retire có hiệu lực. Hàm này thực thi retire SAU khi đã được duyệt.
 */
export async function retireEntry(
  id: string,
  reason: string,
): Promise<ResearchKBEntry> {
  const row = await db.researchKBEntry.findUnique({ where: { id } })
  if (!row) {
    throw new Error(`retireEntry: KB entry ${id} không tồn tại`)
  }
  if (row.retiredAt) {
    // Idempotent — đã retired, return as-is (append-only: KHÔNG overwrite note cũ)
    return row
  }

  const at = new Date().toISOString()
  const retireNote = `\n\n## Retire Note\n- Reason: ${reason}\n- RetiredAt: ${at}\n- By: HAN (Curator — TB-05 §6.3 + DR Q4 pre-approval)`

  const updated = await db.researchKBEntry.update({
    where: { id },
    data: {
      retiredAt: new Date(at),
      content: row.content + retireNote,
    },
  })
  return updated
}

// ============================================================
// §5. CURATE PHASE — curate kép 3 mốc (TB-08 §4 + DECISION-RECORD v1.3)
// ============================================================

/**
 * Curate KB entry — nâng phase 1→2→3 (CHỈ tăng, KHÔNG hạ).
 * TB-08 §4 + DECISION-RECORD v1.3:
 *  - phase 1 (NEW) → phase 2 (CURATED): HAN consolidate trong chu trình G3 gần nhất.
 *  - phase 2 (CURATED) → phase 3 (FINALIZED): end-of-mission hoặc định kỳ 7 ngày.
 *
 * Append-only audit: ghi "## Curation Note" vào content với curator + reason + ts.
 * KHÔNG rewrite nội dung cũ — DR-C3 append-only.
 *
 * Throw nếu:
 *  - Entry không tồn tại.
 *  - fromPhase ≠ current phase (caller truyền sai).
 *  - toPhase ≤ fromPhase (chỉ tăng, không hạ).
 *  - Entry đã retired (KHÔNG curate entry đã soft-delete).
 */
export async function curatePhase(
  id: string,
  fromPhase: 1 | 2 | 3,
  toPhase: 1 | 2 | 3,
  curator: 'HAN' | 'NEMESIS',
  reason: string,
): Promise<ResearchKBEntry> {
  if (!KB_CURATE_PHASES.includes(fromPhase)) {
    throw new Error(`curatePhase: fromPhase ${fromPhase} không hợp lệ (KB_CURATE_PHASES=${KB_CURATE_PHASES.join(',')})`)
  }
  if (!KB_CURATE_PHASES.includes(toPhase)) {
    throw new Error(`curatePhase: toPhase ${toPhase} không hợp lệ (KB_CURATE_PHASES=${KB_CURATE_PHASES.join(',')})`)
  }
  if (toPhase <= fromPhase) {
    throw new Error(`curatePhase: chỉ tăng phase (1→2→3), KHÔNG hạ (fromPhase=${fromPhase} → toPhase=${toPhase})`)
  }

  const row = await db.researchKBEntry.findUnique({ where: { id } })
  if (!row) {
    throw new Error(`curatePhase: KB entry ${id} không tồn tại`)
  }
  if (row.phase !== fromPhase) {
    throw new Error(
      `curatePhase: entry ${id} hiện tại phase=${row.phase}, KHÔNG khớp fromPhase=${fromPhase}`,
    )
  }
  if (row.retiredAt) {
    throw new Error(`curatePhase: entry ${id} đã retired (KHÔNG curate entry đã soft-delete — DR-C6)`)
  }

  const at = new Date().toISOString()
  const curationNote = `\n\n## Curation Note\n- Curated by: ${curator}\n- Phase: ${fromPhase} → ${toPhase}\n- At: ${at}\n- Reason: ${reason}`

  const updated = await db.researchKBEntry.update({
    where: { id },
    data: {
      phase: toPhase,
      content: row.content + curationNote,
    },
  })
  return updated
}

// ============================================================
// §6. EXPORT SNAPSHOT — DR-C6 tầng 2 (multi-file + index.md)
// ============================================================

/** Default output dir — DR-C6 tầng 2 snapshot path (TB-01 §3 workspace). */
export const DEFAULT_SNAPSHOT_DIR = 'workspace/research/kb-snapshot'

/** Mapping category → snapshot filename (DR-C6 multi-file theo category). */
const CATEGORY_FILE_MAP: Record<string, string> = {
  lesson: 'lessons.md',
  'anti-pattern': 'anti-patterns.md',
  baseline: 'baselines.md',
  pattern: 'patterns.md',
  calibration: 'calibration.md',
}

/**
 * Export KB snapshot — DR-C6 tầng 2:
 *  - 1 file/category: lessons.md, anti-patterns.md, baselines.md, patterns.md,
 *    calibration.md (categories khác → misc.md).
 *  - 1 index.md — mục lục tổng (Category | Count | Phase | LastUpdated).
 *  - Regenerate sau mỗi capture/curate (idempotent — overwrite file cũ).
 *
 * TASK 3-fix WORK 7a (audit F.32 fix): resolveSnapshotDir() validate outputDir
 * — path traversal blocked. Caller nhận error object thay vì throw (400 graceful).
 *
 * Live System đọc KB read-only qua snapshot này (tầng 3 DR-C6).
 *
 * Fail-open: fs.mkdir / writeFile error → throw (caller handle, KHÔNG crash process
 * — caller API route catch và trả 500 graceful).
 */
export async function exportSnapshot(
  outputDir?: string,
): Promise<SnapshotResult> {
  // Path traversal validation (F.32 fix)
  const dirCheck = resolveSnapshotDir(outputDir)
  if (!dirCheck.ok) {
    throw new Error(dirCheck.error)
  }
  const dir = dirCheck.dir
  await fs.mkdir(dir, { recursive: true })

  const rows = await db.researchKBEntry.findMany({
    orderBy: [{ category: 'asc' }, { phase: 'asc' }, { createdAt: 'asc' }],
  })

  // Group theo category
  const grouped: Record<string, ResearchKBEntry[]> = {}
  for (const r of rows) {
    const cat = r.category || 'misc'
    if (!grouped[cat]) grouped[cat] = []
    grouped[cat].push(r)
  }

  const files: string[] = []
  const generatedAt = new Date().toISOString()

  // 1 file/category
  for (const category of Object.keys(grouped)) {
    const entries = grouped[category]
    const filename = CATEGORY_FILE_MAP[category] || 'misc.md'
    const filepath = join(dir, filename)
    const md = renderCategoryMarkdown(category, entries, generatedAt)
    await fs.writeFile(filepath, md, 'utf-8')
    files.push(filepath)
  }

  // Categories chưa có entry → tạo placeholder file để index đầy đủ
  for (const category of Object.keys(CATEGORY_FILE_MAP)) {
    if (!grouped[category]) {
      const filename = CATEGORY_FILE_MAP[category]
      const filepath = join(dir, filename)
      const md = renderCategoryMarkdown(category, [], generatedAt)
      await fs.writeFile(filepath, md, 'utf-8')
      files.push(filepath)
    }
  }

  // index.md — mục lục tổng (DR-C6 tầng 2)
  const indexMd = renderIndexMarkdown(grouped, files, generatedAt)
  const indexPath = join(dir, 'index.md')
  await fs.writeFile(indexPath, indexMd, 'utf-8')
  files.push(indexPath)

  return { files, indexMd: indexPath, generatedAt }
}

// ============================================================
// §7. SEED KB — TC-05 cold-start (TB-05 §9 E1)
// ============================================================

/**
 * Seed KB cold-start — TC-05 + TB-05 §9 E1:
 *  - Nếu db.researchKBEntry.count() === 0 → seed starter entries từ bảng nguồn
 *    TB-05 §5.1 (Data Preprocessing, Model Training, Ensemble, Anti-Patterns,
 *    System Patterns, Config Lessons, Performance Baselines).
 *  - Idempotent: chỉ seed khi KB EMPTY. Nếu đã có entries → return seeded=0.
 *  - KHÔNG crash pipeline — fail-open: lỗi DB → throw (caller handle).
 *
 * Return: { seeded: number, categories: string[] } — count + unique categories.
 */
export async function seedKB(): Promise<{ seeded: number; categories: string[] }> {
  const existing = await db.researchKBEntry.count()
  if (existing > 0) {
    return { seeded: 0, categories: [] }
  }

  const starters = STARTER_KB_ENTRIES
  const categories = new Set<string>()
  let seeded = 0

  // Sequential create để tránh race-condition (idempotent check đã đảm bảo empty)
  for (const s of starters) {
    await db.researchKBEntry.create({
      data: {
        category: s.category,
        title: s.title,
        content: s.content,
        sourceMission: s.sourceMission ?? null,
        phase: 1,
        retiredAt: null,
      },
    })
    seeded++
    categories.add(s.category)
  }

  // Generate snapshot sau seed (DR-C6 tầng 2)
  try {
    await exportSnapshot()
  } catch (err) {
    console.warn(
      '[KBStore] exportSnapshot after seed failed (non-blocking):',
      err instanceof Error ? err.message : String(err),
    )
  }

  return { seeded, categories: Array.from(categories) }
}

// ============================================================
// §8. STATS — cho health/dashboard
// ============================================================

export async function getKBStats(): Promise<KBStats> {
  const [total, retired, active, byCategoryRows, byPhaseRows] = await Promise.all([
    db.researchKBEntry.count(),
    db.researchKBEntry.count({ where: { retiredAt: { not: null } } }),
    db.researchKBEntry.count({ where: { retiredAt: null } }),
    db.researchKBEntry.groupBy({ by: ['category'], _count: { _all: true } }),
    db.researchKBEntry.groupBy({ by: ['phase'], _count: { _all: true } }),
  ])

  const byCategory: Record<string, number> = {}
  for (const r of byCategoryRows) {
    byCategory[r.category] = r._count._all
  }
  const byPhase: Record<number, number> = {}
  for (const r of byPhaseRows) {
    byPhase[r.phase] = r._count._all
  }

  // Snapshot generatedAt — đọc từ index.md mtime nếu có
  let snapshotGeneratedAt: string | undefined
  try {
    const indexPath = resolve(DEFAULT_SNAPSHOT_DIR, 'index.md')
    const stat = await fs.stat(indexPath)
    snapshotGeneratedAt = stat.mtime.toISOString()
  } catch {
    // file không tồn tại → undefined
  }

  return {
    total,
    active,
    retired,
    byCategory,
    byPhase,
    snapshotGeneratedAt,
  }
}

// ============================================================
// §9. INTERNAL HELPERS
// ============================================================

function validatePhase(p: number): number {
  const n = Math.trunc(p)
  if (!KB_CURATE_PHASES.includes(n as 1 | 2 | 3)) {
    return 1 // fallback — KHÔNG throw (defensive)
  }
  return n
}

/**
 * Build entry content — TB-05 §7.4 KB Entry Schema 8 trường.
 * Content chứa: Insight (title) + Evidence/Context (caller cung cấp) + Source +
 * Mission + Confidence + Applicability (nếu có).
 *
 * Caller truyền content đã có Evidence/Context — hàm này chỉ append Applicability
 * section nếu có (DR-C6 — KHÔNG thêm cột Prisma, mọi metadata nằm content).
 */
function buildEntryContent(
  content: string,
  applicability?: Record<string, unknown>,
): string {
  if (!applicability || Object.keys(applicability).length === 0) {
    return content
  }
  try {
    const applicabilityJson = JSON.stringify(applicability, null, 2)
    return `${content}\n\n## Applicability (TB-14 §5 context-fit)\n\`\`\`json\n${applicabilityJson}\n\`\`\``
  } catch {
    return content
  }
}

/** Render 1 category thành markdown — DR-C6 tầng 2 multi-file. */
function renderCategoryMarkdown(
  category: string,
  entries: ResearchKBEntry[],
  generatedAt: string,
): string {
  const lines: string[] = []
  lines.push(`# KB Category: ${category}`)
  lines.push('')
  lines.push(`> DR-C6 tầng 2 snapshot — auto-generated ${generatedAt}`)
  lines.push(`> Canonical source: SQLite ResearchKBEntry (soft-delete retire)`)
  lines.push(`> Total entries: ${entries.length}`)
  lines.push('')
  lines.push('| # | ID | Phase | Title | Content (excerpt) | Retired | Created |')
  lines.push('|---|---|---|---|---|---|---|')
  entries.forEach((e, i) => {
    const excerpt = (e.content || '').replace(/\|/g, '\\|').slice(0, 120).replace(/\n/g, ' ')
    const retired = e.retiredAt ? `✓ ${e.retiredAt.toISOString()}` : '—'
    const created = e.createdAt instanceof Date ? e.createdAt.toISOString() : String(e.createdAt)
    lines.push(`| ${i + 1} | ${e.id} | ${e.phase} | ${e.title.replace(/\|/g, '\\|')} | ${excerpt} | ${retired} | ${created} |`)
  })
  return lines.join('\n')
}

/** Render index.md — mục lục tổng DR-C6 tầng 2. */
function renderIndexMarkdown(
  grouped: Record<string, ResearchKBEntry[]>,
  files: string[],
  generatedAt: string,
): string {
  const lines: string[] = []
  lines.push('# Team Knowledge Base — Snapshot Index')
  lines.push('')
  lines.push(`> DR-C6 tầng 2 snapshot — auto-generated ${generatedAt}`)
  lines.push('> Canonical: SQLite ResearchKBEntry · Live System reads read-only')
  lines.push('>')
  lines.push('> Spec: TB-05 §5 + TB-08 §4 + DECISION-RECORD v1.3 (C6 3 lớp)')
  lines.push('')
  lines.push('## Mục lục theo Category')
  lines.push('')
  lines.push('| Category | File | Active | Retired | Total |')
  lines.push('|---|---|---|---|---|')
  let totalActive = 0
  let totalRetired = 0
  let totalAll = 0
  for (const [category, entries] of Object.entries(grouped)) {
    const file = CATEGORY_FILE_MAP[category] || 'misc.md'
    const active = entries.filter((e) => !e.retiredAt).length
    const retired = entries.length - active
    totalActive += active
    totalRetired += retired
    totalAll += entries.length
    lines.push(`| ${category} | ${file} | ${active} | ${retired} | ${entries.length} |`)
  }
  lines.push(`| **TOTAL** | — | **${totalActive}** | **${totalRetired}** | **${totalAll}** |`)
  lines.push('')
  lines.push('## Files')
  lines.push('')
  for (const f of files) {
    lines.push(`- ${f}`)
  }
  lines.push('')
  lines.push('## Curate Phase Legend (TB-08 §4 + DR v1.3)')
  lines.push('')
  lines.push('- **Phase 1 (NEW)** — vừa capture, chờ HAN consolidate trong chu trình G3 gần nhất.')
  lines.push('- **Phase 2 (CURATED)** — HAN đã consolidate/dedup/retire (chu kỳ ~10 entry NEW).')
  lines.push('- **Phase 3 (FINALIZED)** — chốt cuối mission hoặc định kỳ 7 ngày.')
  lines.push('- **Retired** — soft-delete (KHÔNG xóa, giữ audit trail — DR-C6).')
  return lines.join('\n')
}

// ============================================================
// §10. STARTER KB ENTRIES — TB-05 §5.1 (TC-05 cold-start seed)
// ============================================================

interface StarterEntry {
  category: string
  title: string
  content: string
  sourceMission?: string
}

/**
 * Starter KB entries — TB-05 §5.1 bảng nguồn:
 *  - Data Preprocessing (5) · Model Training (5) · Ensemble (4)
 *  - Anti-Patterns A1-A5 (5) · System Patterns S1-S4 (4)
 *  - System Anti-Patterns AS1-AS3 (3) · Config Lessons C1-C3 (3)
 *  - Performance Baselines (3) · Research Insights (1)
 *
 * Lược xuống ~15 entry thiết yếu cho cold-start (TC-05 chỉ verify seed hoạt động,
 * không yêu cầu đủ 35+ entry của nguồn — KB sẽ EVOLVE thêm qua từng vòng G3).
 */
const STARTER_KB_ENTRIES: readonly StarterEntry[] = [
  // ---------- Lesson (Data Preprocessing + Model Training + Ensemble — M1) ----------
  {
    category: 'lesson',
    title: 'MNAR features → dùng flag + KNN impute (Missing > 40%)',
    content: 'Insight: Missing value pattern gợi ý MNAR → KHÔNG dùng simple imputation cho MNAR features.\nEvidence: nguồn TB-05 §5.1 Category Data Preprocessing #1 (HIGH confidence).\nSource: HAN (cold-start seed).\nMission: M1.\nConfidence: HIGH.',
  },
  {
    category: 'lesson',
    title: 'Target encoding cần K-Fold (Cat features high cardinality)',
    content: 'Insight: Target encoding trước split → data leakage; phải dùng K-Fold.\nEvidence: TB-05 §5.1 Data Preprocessing #2 (HIGH).\nSource: HAN (cold-start seed).\nMission: M1.\nConfidence: HIGH.',
  },
  {
    category: 'lesson',
    title: 'XGBoost: depth 3-5 tốt hơn 6+ (Tabular data)',
    content: 'Insight: XGBoost depth=6+ dễ overfit trên dataset nhỏ; depth 3-5 ổn định hơn.\nEvidence: TB-05 §5.1 Model Training #6 (HIGH).\nSource: HAN (cold-start seed).\nMission: M1.\nConfidence: HIGH.',
  },
  {
    category: 'lesson',
    title: '3-5 models ensemble tốt nhất (quá nhiều → overfit)',
    content: 'Insight: Ensemble 3-5 models cho diversity; quá nhiều → overfit.\nEvidence: TB-05 §5.1 Ensemble #11 (HIGH).\nSource: HAN (cold-start seed).\nMission: M1.\nConfidence: HIGH.',
  },
  {
    category: 'lesson',
    title: 'Stacking Ridge meta safe nhất (small-medium datasets)',
    content: 'Insight: Stacking với Ridge meta learner ít overfit hơn LogisticRegression/LGBM.\nEvidence: TB-05 §5.1 Ensemble #13 (HIGH).\nSource: HAN (cold-start seed).\nMission: M1.\nConfidence: HIGH.',
  },
  // ---------- Lesson (Research Insights) ----------
  {
    category: 'lesson',
    title: 'Decompose audit hệ thống theo 4 branch (hiện trạng → điểm yếu → pattern → feasibility)',
    content: 'Insight: Decompose audit hệ thống theo 4 branch cho coverage đủ.\nEvidence: Discussion ② Research Council — task audit memory (TB-05 §5 R1 / KB-20250612-003).\nSource: SIVIL (cold-start seed).\nMission: M2.\nConfidence: HIGH.',
  },
  // ---------- Anti-pattern (M1 + M2) ----------
  {
    category: 'anti-pattern',
    title: 'A1 — KHÔNG dùng toàn bộ features (Noise + overfitting)',
    content: 'Anti-Pattern: Dùng toàn bộ features mà không filter → noise + overfitting.\nEvidence: TB-05 §5.1 Anti-Patterns A1.\nSource: HAN (cold-start seed).\nMission: M1.\nConfidence: HIGH.',
  },
  {
    category: 'anti-pattern',
    title: 'A3 — KHÔNG target encode trước split (Data leakage)',
    content: 'Anti-Pattern: Target encoding trước split → data leakage.\nEvidence: TB-05 §5.1 Anti-Patterns A3.\nSource: HAN (cold-start seed).\nMission: M1.\nConfidence: HIGH.',
  },
  {
    category: 'anti-pattern',
    title: 'AS1 — Retry mù quáng khi API lỗi 4xx (4xx = config/sai key)',
    content: 'System Anti-Pattern: 4xx = config/sai key, KHÔNG retry được — fail-fast ngay.\nEvidence: log 121s (retry mù) vs 6.2s (fail-fast) — TB-05 §5.1 AS1.\nSource: LISMA → HAN (cold-start seed).\nMission: M2.\nConfidence: HIGH.',
  },
  // ---------- Pattern (System Patterns M2) ----------
  {
    category: 'pattern',
    title: 'S1 — LLM key fail-fast + timeout (mọi service dùng external API)',
    content: 'System Pattern: Khi gọi external API (LLM key), thiết lập fail-fast + timeout ngắn thay vì retry mù quáng.\nEvidence: TB-05 §5.1 System Patterns S1 (HIGH).\nSource: HAN (cold-start seed).\nMission: M2.\nConfidence: HIGH.',
    sourceMission: 'system-baseline',
  },
  {
    category: 'pattern',
    title: 'S2 — Key health check định kỳ (service pool nhiều keys)',
    content: 'System Pattern: Service dùng pool nhiều keys → health check định kỳ + circuit breaker.\nEvidence: TB-05 §5.1 System Patterns S2 (HIGH).\nSource: HAN (cold-start seed).\nMission: M2.\nConfidence: HIGH.',
  },
  {
    category: 'pattern',
    title: 'S3 — Config validate trước khi ghi (mọi dịch vụ có config file)',
    content: 'System Pattern: Validate config trước khi persist — tránh runtime fail do config sai.\nEvidence: TB-05 §5.1 System Patterns S3 (HIGH).\nSource: HAN (cold-start seed).\nMission: M2.\nConfidence: HIGH.',
  },
  // ---------- Baseline (Performance Baselines M2) ----------
  {
    category: 'baseline',
    title: 'Chat latency (no config) — 121s baseline',
    content: 'Performance Baseline: Chat latency no-config = 121s (sau tối ưu 6.2s).\nEvidence: TB-05 §5.1 Performance Baselines (log mission M2 thật — example 4428-4511).\nSource: HAN (cold-start seed).\nMission: M2.\nConfidence: HIGH (measured).\nApplicability: applicable cho mọi mission M2 audit chat latency — TB-14 §5 context-fit.',
    sourceMission: 'system-baseline',
  },
  {
    category: 'baseline',
    title: 'Neo4j nodes — 39,615 baseline',
    content: 'Performance Baseline: Neo4j nodes = 39,615 (tham chiếu).\nEvidence: TB-05 §5.1 Performance Baselines.\nSource: HAN (cold-start seed).\nMission: M2.\nConfidence: HIGH (measured).',
    sourceMission: 'system-baseline',
  },
  {
    category: 'baseline',
    title: 'R2 PDFs — 52 baseline (chưa ingest)',
    content: 'Performance Baseline: R2 PDFs = 52 (chưa ingest — tham chiếu).\nEvidence: TB-05 §5.1 Performance Baselines.\nSource: HAN (cold-start seed).\nMission: M2.\nConfidence: HIGH (measured).',
    sourceMission: 'system-baseline',
  },
] as const
