/**
 * /api/research/kb — KB query (GET) + seed/retire/curate (POST) — TB-13 §2.2 + DR-C6
 * =================================================================================
 * Spec:
 *  - TB-13 §2.2 — API route KB query/seed/retire (3 tầng DR-C6).
 *  - TB-05 §5 + DR-C6 — KB 3 lớp: SQLite canonical + snapshot .md + Live read-only.
 *  - TB-08 §4 + DECISION-RECORD v1.3 — Curate kép 3 mốc (phase 1→2→3).
 *  - TB-12 §3.2 TC-05 — KB cold-start seed idempotent.
 *
 * Behavior:
 *  GET  /api/research/kb?action=stats            → { status:'ok', stats: KBStats }
 *  GET  /api/research/kb?category=&phase=&search=&limit=&offset=
 *      → 200 { status:'ok', entries, total, limit, offset }
 *  POST /api/research/kb { action:'seed' }        → TC-05 cold-start (idempotent)
 *  POST /api/research/kb { action:'add', input, phase? }    → addEntry
 *  POST /api/research/kb { action:'retire', id, reason }     → soft-delete
 *  POST /api/research/kb { action:'curate', id, fromPhase, toPhase, curator, reason }
 *  POST /api/research/kb { action:'snapshot', outputDir? }  → exportSnapshot
 *
 * Fail-open: lỗi DB → 500 graceful (KHÔNG crash).
 */

import { NextRequest, NextResponse } from 'next/server'
import {
  seedKB,
  addEntry,
  getEntry,
  queryKB,
  retireEntry,
  curatePhase,
  exportSnapshot,
  getKBStats,
  isValidKBCategory,
  VALID_KB_CATEGORIES,
  type KBEntryInput,
} from '@/lib/research-team/g3/kb-store'

export const dynamic = 'force-dynamic'

// ============================================================
// §1. VALID ACTIONS
// ============================================================

const VALID_GET_ACTIONS = ['stats', 'query'] as const
const VALID_POST_ACTIONS = ['seed', 'add', 'retire', 'curate', 'snapshot'] as const

type GetAction = (typeof VALID_GET_ACTIONS)[number]
type PostAction = (typeof VALID_POST_ACTIONS)[number]

// ============================================================
// §2. GET — STATS / QUERY
// ============================================================

export async function GET(req: NextRequest) {
  try {
    const url = new URL(req.url)
    const actionRaw = url.searchParams.get('action') || 'query'
    const action: GetAction = (
      VALID_GET_ACTIONS.includes(actionRaw as GetAction) ? actionRaw : 'query'
    ) as GetAction

    // ---------- action=stats ----------
    if (action === 'stats') {
      const stats = await getKBStats()
      return NextResponse.json({
        status: 'ok',
        stats,
      })
    }

    // ---------- action=query (default) ----------
    const category = url.searchParams.get('category') || undefined
    const phaseRaw = url.searchParams.get('phase')
    const phase =
      phaseRaw !== null && phaseRaw !== '' && Number.isFinite(parseInt(phaseRaw, 10))
        ? parseInt(phaseRaw, 10)
        : undefined
    const search = url.searchParams.get('search') || undefined
    const limitRaw = Number(url.searchParams.get('limit') ?? '50')
    const offsetRaw = Number(url.searchParams.get('offset') ?? '0')
    const includeRetiredRaw = url.searchParams.get('includeRetired')
    const includeRetired = includeRetiredRaw === 'true' || includeRetiredRaw === '1'

    const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 200) : 50
    const offset = Number.isFinite(offsetRaw) ? Math.max(offsetRaw, 0) : 0

    const entries = await queryKB({
      category,
      phase,
      search,
      limit,
      offset,
      includeRetired,
    })

    return NextResponse.json({
      status: 'ok',
      entries,
      total: entries.length,
      limit,
      offset,
      filter: { category, phase, search, includeRetired },
    })
  } catch (err) {
    console.error('[ResearchKB] GET error:', err)
    return NextResponse.json(
      {
        status: 'error',
        error: err instanceof Error ? err.message : 'Lỗi không xác định',
      },
      { status: 500 },
    )
  }
}

// ============================================================
// §3. POST — SEED / ADD / RETIRE / CURATE / SNAPSHOT
// ============================================================

interface PostBody {
  action?: string
  // add
  input?: KBEntryInput
  phase?: 1 | 2 | 3
  // retire
  id?: string
  reason?: string
  // curate
  fromPhase?: 1 | 2 | 3
  toPhase?: 1 | 2 | 3
  curator?: 'HAN' | 'NEMESIS'
  // snapshot
  outputDir?: string
}

export async function POST(req: NextRequest) {
  let body: PostBody
  try {
    body = (await req.json()) as PostBody
  } catch {
    return NextResponse.json(
      { status: 'error', error: 'Body JSON không hợp lệ' },
      { status: 400 },
    )
  }

  const action = body?.action
  if (!action || !VALID_POST_ACTIONS.includes(action as PostAction)) {
    return NextResponse.json(
      {
        status: 'error',
        error: `Action không hợp lệ. Valid: ${VALID_POST_ACTIONS.join(' | ')}`,
      },
      { status: 400 },
    )
  }

  try {
    // ---------- action=seed (TC-05 cold-start idempotent) ----------
    if (action === 'seed') {
      const result = await seedKB()
      if (result.seeded === 0) {
        return NextResponse.json({
          status: 'ok',
          seeded: 0,
          message: 'KB already seeded — idempotent skip (TC-05)',
        })
      }
      return NextResponse.json({
        status: 'ok',
        seeded: result.seeded,
        categories: result.categories,
        message: `TC-05 cold-start: seeded ${result.seeded} starter entries`,
      })
    }

    // ---------- action=add ----------
    if (action === 'add') {
      const input = body.input
      if (!input || typeof input !== 'object') {
        return NextResponse.json(
          { status: 'error', error: 'Trường "input" bắt buộc (KBEntryInput)' },
          { status: 400 },
        )
      }
      if (!input.category || typeof input.category !== 'string') {
        return NextResponse.json(
          { status: 'error', error: `input.category bắt buộc (một trong: ${VALID_KB_CATEGORIES.join(' | ')})` },
          { status: 400 },
        )
      }
      // TASK 3-fix WORK 7b (audit F.33 fix): validate category enum server-side
      if (!isValidKBCategory(input.category)) {
        return NextResponse.json(
          {
            status: 'error',
            error: `input.category "${input.category}" không hợp lệ. Valid: ${VALID_KB_CATEGORIES.join(' | ')}`,
          },
          { status: 400 },
        )
      }
      if (!input.title || typeof input.title !== 'string') {
        return NextResponse.json(
          { status: 'error', error: 'input.title bắt buộc (1 câu ngắn, actionable)' },
          { status: 400 },
        )
      }
      if (!input.content || typeof input.content !== 'string') {
        return NextResponse.json(
          { status: 'error', error: 'input.content bắt buộc (Evidence/Context)' },
          { status: 400 },
        )
      }

      const phase = (body.phase === 1 || body.phase === 2 || body.phase === 3) ? body.phase : 1
      try {
        const result = await addEntry(input, phase)
        return NextResponse.json({
          status: 'ok',
          id: result.id,
          entry: result.entry,
        })
      } catch (err) {
        // addEntry throw nếu category invalid (đã validate nhưng double-safety)
        const msg = err instanceof Error ? err.message : String(err)
        if (msg.includes('không hợp lệ') || msg.includes('BẮT BUỘC')) {
          return NextResponse.json({ status: 'error', error: msg }, { status: 400 })
        }
        throw err // re-throw → catch ngoài cùng → 500
      }
    }

    // ---------- action=retire ----------
    if (action === 'retire') {
      const id = body.id
      const reason = body.reason || '(no reason provided)'
      if (!id || typeof id !== 'string') {
        return NextResponse.json(
          { status: 'error', error: 'Trường "id" bắt buộc (KB entry id)' },
          { status: 400 },
        )
      }
      const retired = await retireEntry(id, reason)
      return NextResponse.json({
        status: 'ok',
        entry: retired,
        message: `Retired (soft-delete — DR-C6): ${id}`,
      })
    }

    // ---------- action=curate ----------
    if (action === 'curate') {
      const id = body.id
      const fromPhase = body.fromPhase
      const toPhase = body.toPhase
      const curator = body.curator
      const reason = body.reason || '(no reason provided)'

      if (!id || typeof id !== 'string') {
        return NextResponse.json(
          { status: 'error', error: 'Trường "id" bắt buộc' },
          { status: 400 },
        )
      }
      if (fromPhase !== 1 && fromPhase !== 2 && fromPhase !== 3) {
        return NextResponse.json(
          { status: 'error', error: 'fromPhase phải là 1 | 2 | 3' },
          { status: 400 },
        )
      }
      if (toPhase !== 1 && toPhase !== 2 && toPhase !== 3) {
        return NextResponse.json(
          { status: 'error', error: 'toPhase phải là 1 | 2 | 3' },
          { status: 400 },
        )
      }
      if (toPhase <= fromPhase) {
        return NextResponse.json(
          { status: 'error', error: 'curatePhase chỉ tăng phase (1→2→3), KHÔNG hạ (TB-08 §4)' },
          { status: 400 },
        )
      }
      if (curator !== 'HAN' && curator !== 'NEMESIS') {
        return NextResponse.json(
          { status: 'error', error: 'curator phải là "HAN" hoặc "NEMESIS"' },
          { status: 400 },
        )
      }

      const curated = await curatePhase(id, fromPhase, toPhase, curator, reason)
      return NextResponse.json({
        status: 'ok',
        entry: curated,
        message: `Curated phase ${fromPhase} → ${toPhase} by ${curator}`,
      })
    }

    // ---------- action=snapshot ----------
    if (action === 'snapshot') {
      const outputDir = body.outputDir
      try {
        const result = await exportSnapshot(outputDir)
        return NextResponse.json({
          status: 'ok',
          files: result.files,
          indexMd: result.indexMd,
          generatedAt: result.generatedAt,
          fileCount: result.files.length,
        })
      } catch (err) {
        // TASK 3-fix WORK 7a (audit F.32 fix): exportSnapshot throw nếu
        // outputDir chứa '..' hoặc ngoài workspace/research/ → 400 graceful
        // (KHÔNG 500 vì đây là validation error, không phải server error).
        const msg = err instanceof Error ? err.message : String(err)
        if (msg.includes('path traversal') || msg.includes('F.32')) {
          return NextResponse.json({ status: 'error', error: msg }, { status: 400 })
        }
        throw err // re-throw → catch ngoài cùng → 500
      }
    }

    // Unreachable — action validated ở trên
    return NextResponse.json(
      { status: 'error', error: `Action "${action}" chưa xử lý` },
      { status: 400 },
    )
  } catch (err) {
    console.error('[ResearchKB] POST error:', err)
    const message = err instanceof Error ? err.message : String(err)
    // DB error → 500 graceful
    return NextResponse.json(
      {
        status: 'error',
        error: `KB operation failed: ${message}`,
      },
      { status: 500 },
    )
  }
}

// ============================================================
// §4. ENTRY LOOKUP (convenience — alias for queryKB getEntry)
// ============================================================

/** Helper để lookup 1 entry by id — caller (UI/agent) tiện dùng. */
export async function HEAD(req: NextRequest) {
  try {
    const url = new URL(req.url)
    const id = url.searchParams.get('id')
    if (!id) {
      return NextResponse.json(
        { status: 'error', error: 'Query param "id" bắt buộc' },
        { status: 400 },
      )
    }
    const entry = await getEntry(id)
    if (!entry) {
      return NextResponse.json(
        { status: 'error', error: `KB entry ${id} không tồn tại` },
        { status: 404 },
      )
    }
    return NextResponse.json({ status: 'ok', entry })
  } catch (err) {
    console.error('[ResearchKB] HEAD error:', err)
    return NextResponse.json(
      { status: 'error', error: err instanceof Error ? err.message : 'Lỗi không xác định' },
      { status: 500 },
    )
  }
}
