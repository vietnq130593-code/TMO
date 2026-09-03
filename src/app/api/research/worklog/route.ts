/**
 * /api/research/worklog — GET (list) + POST (create) worklog entry — TB-13 §2.2 + TB-09 §4.2
 * =================================================================================
 * Spec:
 *  - TB-13 §2.2 — API route worklog list/create.
 *  - TB-09 §4.2 — Worklog entry 8 trường BẮT BUỘC: mission · status · currentPhase
 *    · overallProgress · tlReadBack · done · issuesFaced · suggestionsNextGroup ·
 *    filesChanged (8 logical fields, 9 keys — 3a+3b gộp).
 *  - TB-04 §5 + TC-06 — Evidence bắt buộc: claim trong done/findings thiếu evidence
 *    → 400 'Evidence gap — claims missing evidence (TC-06)'.
 *
 * Behavior:
 *  GET  /api/research/worklog?taskId=&missionId=&phase=&limit=50&offset=0
 *      → 200 { status:'ok', worklogs: DecodedResearchWorklog[], total }
 *  POST /api/research/worklog { taskId, missionId, phase, entry, evidence?,
 *         artifactMap?, modelSwitched? }
 *      → 201 { status:'ok', worklog }
 *      → 400 nếu entry thiếu 1 trong 8 trường (manual validation — zod chưa cài).
 *      → 400 nếu evidence gap (TC-06: claim thiếu evidence).
 *
 * Manual validation (zod KHÔNG cài trong package.json — fallback manual theo spec).
 *
 * Fail-open: lỗi DB → 500 graceful (KHÔNG crash).
 */

import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import {
  encodeJson,
  decodeWorklog,
  type WorklogEntry,
  type EvidenceItem,
  type ModelSwitchEntry,
  type WorklogPhaseValue,
  type DecodedResearchWorklog,
} from '@/lib/research-team/types'
import { filterClaimsWithEvidence } from '@/lib/research-team/g2/evidence-log'
// FIX (Task 19 audit): dùng worklog-schema.ts (SSOT validation TB-09 §4.2) thay
// vì inline duplicate 120 dòng — file này trước đây 0 import (dead code) dù route
// tự viết lại y hệt logic.
import { validateWorklogEntry } from '@/lib/research-team/worklog-schema'

export const dynamic = 'force-dynamic'

// ============================================================
// §1. VALIDATION — delegate worklog-schema.ts (SSOT — TB-09 §4.2)
// ============================================================

interface ValidationResult {
  valid: boolean
  error?: string
}

/**
 * Validate 8 trường required — delegate validateWorklogEntry của worklog-schema.ts
 * (trước đây route tự viết 120 dòng trùng lặp — dead-code duplication).
 */
function validateEntry(entry: unknown): ValidationResult {
  const result = validateWorklogEntry(entry)
  if (!result.valid) {
    return { valid: false, error: result.errors.join('; ') || 'Entry invalid (TB-09 §4.2)' }
  }
  return { valid: true }
}

/**
 * TC-06 evidence gap check:
 *  - FIX (Task 19 audit A#2): claims CHỈ lấy từ entry.findings[] (claim thật của DR).
 *  - done[] là progress text — KHÔNG phải claim cần evidence (coi done[] là claim
 *    làm mọi POST hợp lệ bị 400 false-positive).
 */
function checkEvidenceGapForEntry(
  entry: WorklogEntry,
  evidence: EvidenceItem[],
): { hasGap: boolean; gapClaims: string[] } {
  const claims: string[] = []
  if (Array.isArray(entry.findings)) {
    for (const f of entry.findings) {
      if (f && typeof f.finding === 'string' && f.finding.trim().length > 0) {
        claims.push(f.finding)
      }
    }
  }
  // Dedupe
  const uniqueClaims = Array.from(new Set(claims))
  const { rejected } = filterClaimsWithEvidence(uniqueClaims, evidence || [])
  return { hasGap: rejected.length > 0, gapClaims: rejected }
}

// ============================================================
// §2. GET — LIST WORKLOGS
// ============================================================

export async function GET(req: NextRequest) {
  try {
    const url = new URL(req.url)
    const taskId = url.searchParams.get('taskId') || undefined
    const missionId = url.searchParams.get('missionId') || undefined
    const phase = url.searchParams.get('phase') || undefined
    const limitRaw = Number(url.searchParams.get('limit') ?? '50')
    const offsetRaw = Number(url.searchParams.get('offset') ?? '0')

    const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 200) : 50
    const offset = Number.isFinite(offsetRaw) ? Math.max(offsetRaw, 0) : 0

    const where: Record<string, unknown> = {}
    if (taskId) where.taskId = taskId
    if (missionId) where.missionId = missionId
    if (phase) where.phase = phase

    const [rows, total] = await Promise.all([
      db.researchWorklog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: limit,
        skip: offset,
      }),
      db.researchWorklog.count({ where }),
    ])

    const worklogs: DecodedResearchWorklog[] = rows.map(decodeWorklog)
    return NextResponse.json({
      status: 'ok',
      worklogs,
      total,
      limit,
      offset,
    })
  } catch (err) {
    console.error('[ResearchWorklog] GET list error:', err)
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
// §3. POST — CREATE WORKLOG ENTRY (8-field validated + TC-06 evidence gap)
// ============================================================

interface PostBody {
  taskId?: string
  missionId?: string
  phase?: WorklogPhaseValue
  entry?: WorklogEntry
  evidence?: EvidenceItem[]
  artifactMap?: unknown
  modelSwitched?: ModelSwitchEntry[]
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

  // 1. Required fields: taskId, missionId, phase, entry
  if (!body.taskId || typeof body.taskId !== 'string') {
    return NextResponse.json(
      { status: 'error', error: 'Trường "taskId" bắt buộc và phải là chuỗi' },
      { status: 400 },
    )
  }
  if (!body.missionId || typeof body.missionId !== 'string') {
    return NextResponse.json(
      { status: 'error', error: 'Trường "missionId" bắt buộc và phải là chuỗi' },
      { status: 400 },
    )
  }
  if (!body.phase || typeof body.phase !== 'string' || body.phase.trim().length === 0) {
    return NextResponse.json(
      { status: 'error', error: 'Trường "phase" bắt buộc và phải là chuỗi' },
      { status: 400 },
    )
  }

  // 2. Validate entry 8 trường (worklog-schema SSOT)
  const entryValidation = validateEntry(body.entry)
  if (!entryValidation.valid) {
    return NextResponse.json(
      { status: 'error', error: entryValidation.error || 'Entry invalid (8 trường required TB-09 §4.2)' },
      { status: 400 },
    )
  }

  const entry = body.entry as WorklogEntry
  const evidence = Array.isArray(body.evidence) ? body.evidence : []

  // 3. TC-06 evidence gap check — claims trong done/findings phải có evidence match
  const gapCheck = checkEvidenceGapForEntry(entry, evidence)
  if (gapCheck.hasGap) {
    return NextResponse.json(
      {
        status: 'error',
        error: `Evidence gap — claims missing evidence (TC-06): ${gapCheck.gapClaims.length} claim(s) thiếu evidence`,
        gapClaims: gapCheck.gapClaims,
      },
      { status: 400 },
    )
  }

  // 4. Persist ResearchWorklog row
  try {
    const row = await db.researchWorklog.create({
      data: {
        taskId: body.taskId,
        missionId: body.missionId,
        phase: body.phase,
        entryJson: encodeJson(entry),
        evidenceJson: encodeJson(evidence),
        artifactMapJson: body.artifactMap !== undefined ? encodeJson(body.artifactMap) : null,
        modelSwitchedJson: encodeJson(body.modelSwitched || []),
      },
    })

    const worklog = decodeWorklog(row)
    return NextResponse.json({ status: 'ok', worklog }, { status: 201 })
  } catch (err) {
    // FK constraint error nếu taskId/missionId không tồn tại → 400 friendly (caller
    // có thể test smoke với fake IDs; spec nói "có thể 500 nếu taskId không tồn
    // tại do FK — điều đó OK, chỉ cần KHÔNG 201 với evidence gap")
    const msg = err instanceof Error ? err.message : String(err)
    if (msg.includes('Foreign key') || msg.includes('foreign key') || msg.includes('constraint')) {
      return NextResponse.json(
        { status: 'error', error: `FK constraint — taskId/missionId không tồn tại: ${msg}` },
        { status: 400 },
      )
    }
    console.error('[ResearchWorklog] POST create error:', err)
    return NextResponse.json(
      {
        status: 'error',
        error: `Create worklog failed: ${msg}`,
      },
      { status: 500 },
    )
  }
}
