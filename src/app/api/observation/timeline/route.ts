/**
 * OBS-P2 — OBSERVATION TIMELINE API (BLUEPRINT-OBSERVATION §C.4, chốt §7 Task 23)
 * ============================================================================
 *
 * GET /api/observation/timeline?runId=&actor=&kind=&since=&before=&limit=
 *
 * Trả sự kiện mới→cũ từ ObservationEvent (model 103), paginate bằng
 * before=seq. Khi có runId → JOIN thêm BrainInferenceTrace (model 104) theo
 * runId — "cả 2 nguồn trong 1 response" (C.4) cho chế độ kim tuyến của UI
 * tab Quan sát (OBS-P3).
 *
 * Hợp đồng:
 *   - READ-ONLY TUYỆT ĐỐI — chỉ SELECT, không ghi gì (pin r96);
 *   - Response kèm `flags` (4 cờ obs_*) để UI tự hiển thị trạng thái quan
 *     sát — cờ off không làm route lỗi (timeline đọc những gì có, thường rỗng);
 *   - Tham số rác (limit 0/âm/ky tự, before âm) → 400 với lý do rõ
 *     (contract precedent /api/brain/activity 15-a);
 *   - Fail-open: lỗi DB → 500 + error message, không throw sập process.
 */

import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getTuningEnum } from '@/lib/learning/tuning-store'
import { OBS_KINDS } from '@/lib/observation/kinds'

export const dynamic = 'force-dynamic'

/** Limit mặc định + trần (tương tự pattern take các route quan sát sẵn có). */
const DEFAULT_LIMIT = 50
const MAX_LIMIT = 200
/** Trần số trace join theo runId (kim tuyến — đủ dày, không phình response). */
const MAX_TRACES = 100

function safeFlag(key: string): boolean {
  try {
    return getTuningEnum(key) === 'on'
  } catch {
    return false
  }
}

export async function GET(request: Request) {
  const url = new URL(request.url)
  const runId = url.searchParams.get('runId')?.trim() || null
  const actor = url.searchParams.get('actor')?.trim() || null
  const kind = url.searchParams.get('kind')?.trim() || null
  const sinceRaw = url.searchParams.get('since')
  const beforeRaw = url.searchParams.get('before')
  const limitRaw = url.searchParams.get('limit')

  // ── Validate tham số (400 rác — contract 15-a precedent) ──
  let limit = DEFAULT_LIMIT
  if (limitRaw !== null && limitRaw !== '') {
    const n = Number(limitRaw)
    if (!Number.isInteger(n) || n < 1 || n > MAX_LIMIT) {
      return NextResponse.json(
        { error: `limit phải là số nguyên 1–${MAX_LIMIT} (nhận "${limitRaw}")` },
        { status: 400 },
      )
    }
    limit = n
  }
  let before: number | null = null
  if (beforeRaw !== null && beforeRaw !== '') {
    const n = Number(beforeRaw)
    if (!Number.isInteger(n) || n < 1) {
      return NextResponse.json(
        { error: `before phải là seq nguyên ≥ 1 (nhận "${beforeRaw}")` },
        { status: 400 },
      )
    }
    before = n
  }
  let since: Date | null = null
  if (sinceRaw !== null && sinceRaw !== '') {
    const t = Date.parse(sinceRaw)
    if (!Number.isFinite(t)) {
      return NextResponse.json({ error: `since phải là ISO timestamp (nhận "${sinceRaw}")` }, { status: 400 })
    }
    since = new Date(t)
  }

  try {
    // ── Query sự kiện mới→cũ (mọi filter AND) ──
    const where: Record<string, unknown> = {}
    if (runId) where.runId = runId
    if (actor) where.actor = actor
    if (kind) where.kind = kind
    if (since) where.ts = { gte: since }
    if (before !== null) {
      where.seq = where.seq ? { ...(where.seq as object), lt: before } : { lt: before }
    }

    const [rows, total] = await Promise.all([
      db.observationEvent.findMany({
        where,
        orderBy: { seq: 'desc' },
        take: limit + 1, // +1 để biết còn trang sau
        select: {
          seq: true, ts: true, actor: true, kind: true, runId: true,
          sessionId: true, table: true, rowKey: true, summary: true, payloadJson: true,
        },
      }),
      db.observationEvent.count({ where }),
    ])

    const hasMore = rows.length > limit
    const page = (hasMore ? rows.slice(0, limit) : rows).map(r => {
      let payload: Record<string, unknown> = {}
      try {
        payload = JSON.parse(r.payloadJson) as Record<string, unknown>
      } catch {
        payload = { unparseable: true }
      }
      return {
        seq: r.seq,
        ts: r.ts.toISOString(),
        actor: r.actor,
        kind: r.kind,
        runId: r.runId,
        sessionId: r.sessionId,
        table: r.table,
        rowKey: r.rowKey,
        summary: r.summary,
        payload,
      }
    })

    // ── Kim tuyến: JOIN BrainInferenceTrace theo runId (C.4) ──
    let traces: Array<Record<string, unknown>> = []
    if (runId) {
      const tRows = await db.brainInferenceTrace.findMany({
        where: { runId },
        orderBy: { ts: 'desc' },
        take: MAX_TRACES,
        select: {
          id: true, ts: true, brain: true, modelVersion: true, organ: true,
          runId: true, inputHash: true, inputJson: true, outputJson: true, latencyMs: true,
        },
      })
      traces = tRows.map(t => ({
        id: t.id,
        ts: t.ts.toISOString(),
        brain: t.brain,
        modelVersion: t.modelVersion,
        organ: t.organ,
        runId: t.runId,
        inputHash: t.inputHash,
        latencyMs: t.latencyMs,
        input: t.inputJson ?? null,
        output: t.outputJson ?? null,
      }))
    }

    return NextResponse.json({
      ok: true,
      flags: {
        obsLedger: safeFlag('obs_ledger'),
        obsBrainTrace: safeFlag('obs_brain_trace'),
        obsImpact: safeFlag('obs_impact'),
        uiObservation: safeFlag('ui_observation'),
      },
      events: page,
      hasMore,
      nextBefore: hasMore && page.length > 0 ? page[page.length - 1].seq : null,
      total,
      traces,
      // kind catalog cho UI filter bar (single-source kinds.ts — doctrine #9)
      kinds: OBS_KINDS,
    })
  } catch (err) {
    console.error('[ObservationTimeline] GET failed:', err instanceof Error ? err.message : String(err))
    return NextResponse.json(
      { error: 'Timeline quan sát thất bại (read-only — không ảnh hưởng trạng thái gì)' },
      { status: 500 },
    )
  }
}
