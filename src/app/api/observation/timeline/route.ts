/**
 * OBS-P2 — OBSERVATION TIMELINE API (BLUEPRINT-OBSERVATION §C.4, chốt §7 Task 23)
 * ============================================================================
 *
 * GET /api/observation/timeline?runId=&actor=&kind=&since=&before=&limit=
 *     &brain=  (Task 26-BE — đài quan sát v2, hợp đồng 26-RESTORE)
 *
 * Trả sự kiện mới→cũ từ ObservationEvent (model 103), paginate bằng
 * before=seq. Khi có runId → JOIN thêm BrainInferenceTrace (model 104) theo
 * runId — "cả 2 nguồn trong 1 response" (C.4) cho chế độ kim tuyến của UI
 * tab Quan sát (OBS-P3).
 *
 * Task 26-BE thêm (hợp đồng 26-RESTORE — FE đang code theo đúng shape):
 *   - ?brain= (tùy chọn, mặc định KHÔNG lọc — mọi nhánh cũ giữ nguyên):
 *       · traces: lọc theo CỘT brain (BrainInferenceTrace.brain) đúng giá
 *         trị — join khi có runId HOẶC brain (AND cả hai nếu cùng truyền).
 *       · events: lọc JS post-query theo payload.brain === giá trị (SQLite
 *         không index JSON payload) — cursor vòng gom ĐÚNG limit+1 dòng
 *         khớp (hasMore/nextBefore đúng trên trang ĐÃ LỌC; payload rách/
 *         không có brain → loại; trần quét bảo vệ fail-open).
 *       · LƯU Ý trung thực: `total` đếm ở TẦNG DB (runId/actor/kind/since/
 *         before) — KHÔNG tính payload.brain (không thể count JSON không
 *         index) — dùng events.length/hasMore để lật trang dưới filter brain.
 *         Brain lạ → khớp 0 dòng (fail-open 200 rỗng, KHÔNG 400).
 *   - alerts24h: count ObservationEvent kind='obs.alert' trong 24 giờ qua
 *     (count query riêng trên index @@index([kind, ts]) — KHÔNG tương tác
 *     với filter nào; trường tổng quan cho badge cảnh báo FE). Đếm lỗi →
 *     0 (fail-open — badge tắt an toàn).
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
/** Trần số trace join theo runId/brain (kim tuyến — đủ dày, không phình response). */
const MAX_TRACES = 100
/** Task 26-BE — cursor lọc JS payload.brain: cỡ batch mỗi vòng + trần vòng. */
const BRAIN_FILTER_BATCH = 100
const BRAIN_FILTER_MAX_ROUNDS = 60 // quét tối đa 6.000 dòng gần nhất rồi dừng (fail-open)

function safeFlag(key: string): boolean {
  try {
    return getTuningEnum(key) === 'on'
  } catch {
    return false
  }
}

/** payload.brain của 1 dòng event — parse lỗi/không có brain → null. */
function payloadBrainOf(payloadJson: string): string | null {
  try {
    const p = JSON.parse(payloadJson) as { brain?: unknown }
    return typeof p.brain === 'string' ? p.brain : null
  } catch {
    return null
  }
}

/** Dòng event theo select chuẩn của route (26-BE — dùng chung 2 nhánh query). */
interface EventRow {
  seq: number
  ts: Date
  actor: string
  kind: string
  runId: string | null
  sessionId: string | null
  table: string | null
  rowKey: string | null
  summary: string
  payloadJson: string
}

export async function GET(request: Request) {
  const url = new URL(request.url)
  const runId = url.searchParams.get('runId')?.trim() || null
  const actor = url.searchParams.get('actor')?.trim() || null
  const kind = url.searchParams.get('kind')?.trim() || null
  // Task 26-BE — filter não (traces theo cột brain + events theo payload.brain)
  const brain = url.searchParams.get('brain')?.trim() || null
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
    // ── Query sự kiện mới→cũ (mọi filter DB AND) ──
    // NOTE 26-BE: seq (before) KHÔNG nhét vào `where` ngay — nhánh brain lọc
    // JS cần lật cursor từng vòng; nhánh thường áp before vào where như cũ.
    const where: Record<string, unknown> = {}
    if (runId) where.runId = runId
    if (actor) where.actor = actor
    if (kind) where.kind = kind
    if (since) where.ts = { gte: since }

    const select = {
      seq: true, ts: true, actor: true, kind: true, runId: true,
      sessionId: true, table: true, rowKey: true, summary: true, payloadJson: true,
    }

    let rows: EventRow[]
    let hasMore: boolean
    if (brain) {
      // ── 26-BE: lọc JS payload.brain — cursor vòng gom ĐÚNG limit+1 dòng ──
      const collected: EventRow[] = []
      let cursor: number | null = before
      for (let round = 0; round < BRAIN_FILTER_MAX_ROUNDS; round++) {
        const w: Record<string, unknown> = { ...where }
        if (cursor !== null) w.seq = { lt: cursor }
        const batch = await db.observationEvent.findMany({
          where: w,
          orderBy: { seq: 'desc' },
          take: BRAIN_FILTER_BATCH,
          select,
        })
        if (batch.length === 0) break // hết dữ liệu — dừng (fail-open)
        for (const r of batch) {
          if (payloadBrainOf(r.payloadJson) === brain) collected.push(r)
        }
        if (collected.length > limit) break // đủ limit+1 → có trang sau
        if (batch.length < BRAIN_FILTER_BATCH) break // hết dữ liệu
        cursor = batch[batch.length - 1].seq
      }
      rows = collected.slice(0, limit + 1)
      hasMore = collected.length > limit
    } else {
      // ── Nhánh cũ (giữ nguyên): before vào where, take limit+1 ──
      const w: Record<string, unknown> = { ...where }
      if (before !== null) w.seq = { lt: before }
      rows = await db.observationEvent.findMany({
        where: w,
        orderBy: { seq: 'desc' },
        take: limit + 1, // +1 để biết còn trang sau
        select,
      })
      hasMore = rows.length > limit
    }

    // total: đếm tầng DB (runId/actor/kind/since/before) — KHÔNG tính
    // payload.brain (JSON không index — xem JSDoc header 26-BE)
    const countWhere: Record<string, unknown> = { ...where }
    if (before !== null) countWhere.seq = { lt: before }
    const total = await db.observationEvent.count({ where: countWhere })

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
    // 26-BE: join khi có runId HOẶC brain (lọc cột brain thật); cả hai cùng
    // truyền → AND (mọi filter AND — cùng quy ước nhánh cũ)
    let traces: Array<Record<string, unknown>> = []
    if (runId || brain) {
      const tWhere: Record<string, unknown> = {}
      if (runId) tWhere.runId = runId
      if (brain) tWhere.brain = brain
      const tRows = await db.brainInferenceTrace.findMany({
        where: tWhere,
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

    // ── 26-BE: alerts24h — count obs.alert 24 giờ qua (index [kind, ts]) ──
    // KHÔNG tương tác với filter — trường tổng quan cho badge FE; đếm lỗi → 0
    let alerts24h = 0
    try {
      alerts24h = await db.observationEvent.count({
        where: { kind: 'obs.alert', ts: { gte: new Date(Date.now() - 24 * 3600_000) } },
      })
    } catch {
      alerts24h = 0 // fail-open — badge tắt an toàn, response vẫn 200
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
      // 26-BE (hợp đồng 26-RESTORE) — badge cảnh báo FE
      alerts24h,
    })
  } catch (err) {
    console.error('[ObservationTimeline] GET failed:', err instanceof Error ? err.message : String(err))
    return NextResponse.json(
      { error: 'Timeline quan sát thất bại (read-only — không ảnh hưởng trạng thái gì)' },
      { status: 500 },
    )
  }
}
