/**
 * /api/research/missions/[id]/run — POST kingFullLifecycle (Task 3-fix WORK 7d)
 * =================================================================================
 * Spec:
 *  - TASK 3-fix WORK 7d (audit B.11 fix): trước đây không có endpoint run
 *    lifecycle → UI không thể trigger kingFullLifecycle. Giờ POST /run gọi
 *    kingFullLifecycle — wired G1/G2/G3 + Tournament (WORK 3).
 *
 * ROUND-40 fix #40-2 (bug phát hiện qua test thực tế): trước đây route
 * AWAIT toàn bộ kingFullLifecycle trong 1 HTTP request blocking. Lifecycle
 * thật (G1 council + T1/G2/G3 + MONITOR + FINALIZE, LLM effort=max) chạy
 * 15-20+ phút → client disconnect (curl timeout, proxy/gateway cắt
 * long-request, user đóng tab) giết request handler giữa chừng → mission
 * kẹt MÃI Ở trạng thái trung gian (RESEARCHING) — bằng chứng thật: mission
 * cmuv6j9zx sau 560s curl timeout chết ngay giữa G1 part 1, log trống
 * hoàn toàn 40s sau đó. Fix: mặc định chạy lifecycle BACKGROUND
 * (fire-and-forget — process PM2 sống liên tục), trả 202 ngay kèm trạng
 * thái. Thêm in-flight guard chống double-run. Giữ ?wait=true cho hành vi
 * blocking cũ (script/test) — người gọi tự chịu rủi ro disconnect.
 *
 * Behavior:
 *  POST /api/research/missions/[id]/run
 *    → 202 { status:'started' } — lifecycle chạy background; poll
 *       GET /api/research/missions/{id} (field status) để xem tiến độ
 *       (TRIAGING → DECOMPOSING → RESEARCHING → MONITORING → FINALIZED)
 *    → 200 { status:'ok', mission, finalReport, parts, errors } nếu ?wait=true
 *    → 409 nếu lifecycle của mission này đang chạy (in-flight)
 *    → 404 nếu mission null
 *    → 400 nếu status FINALIZED (đã terminal — không re-run)
 *    → 500 nếu kingFullLifecycle throw khi wait=true (background: lỗi ghi log)
 *
 * LLM fail-open (NIM placeholder): errors array ghi 'LLM unavailable' nhưng
 * pipeline structure đúng (G1/G2/G3 đã chạy, không còn dead code).
 *
 * Next.js 16 App Router: params là Promise (await bắt buộc).
 */

import { NextRequest, NextResponse } from 'next/server'
import { getMission } from '@/lib/research-team/mission-store'
import { kingFullLifecycle } from '@/lib/research-team/king/engine'

export const dynamic = 'force-dynamic'

interface RouteContext {
  params: Promise<{ id: string }>
}

// In-flight guard (ROUND-40): missionId → startedAt (ms). Chống 2 lifecycle
// đè nhau khi client POST /run 2 lần. Process restart → map reset (mission kẹt
// giữa chừng có thể re-run — chấp nhận, không có job-store bền).
const inFlightRuns = new Map<string, number>()
const IN_FLIGHT_TTL_MS = 30 * 60 * 1000 // 30 phút — trần lifecycle dài nhất

function isRunning(missionId: string): boolean {
  const startedAt = inFlightRuns.get(missionId)
  if (!startedAt) return false
  if (Date.now() - startedAt > IN_FLIGHT_TTL_MS) {
    inFlightRuns.delete(missionId) // stale — lifecycle chắc chắn đã chết
    return false
  }
  return true
}

export async function POST(req: NextRequest, { params }: RouteContext) {
  const { id } = await params

  try {
    // 0. Chế độ chạy: mặc định background; ?wait=true giữ hành vi blocking cũ
    const url = new URL(req.url)
    const wait = url.searchParams.get('wait') === 'true'

    // 1. Check mission exists
    const existing = await getMission(id)
    if (!existing) {
      return NextResponse.json(
        { status: 'error', error: `Mission ${id} không tồn tại` },
        { status: 404 },
      )
    }

    // 2. Validate status — không re-run nếu FINALIZED (terminal)
    if (existing.status === 'FINALIZED') {
      return NextResponse.json(
        {
          status: 'error',
          error: `Mission ${id} đã FINALIZED (terminal) — không re-run. Tạo mission mới hoặc PATCH status='RESEARCHING' để re-RESEARCHING.`,
        },
        { status: 400 },
      )
    }

    // 3. ROUND-40 — in-flight guard: lifecycle đang chạy thì từ chối
    if (isRunning(id)) {
      return NextResponse.json(
        {
          status: 'error',
          error: `Mission ${id} đang có lifecycle chạy (in-flight từ ${new Date(inFlightRuns.get(id)!).toISOString()}). Poll GET /api/research/missions/${id} để theo dõi.`,
        },
        { status: 409 },
      )
    }
    inFlightRuns.set(id, Date.now())

    // 4a. Background mode (default) — fire-and-forget: client disconnect
    //     KHÔNG còn giết lifecycle (bug #40-2). Process PM2 sống liên tục.
    if (!wait) {
      void (async () => {
        try {
          const result = await kingFullLifecycle(id)
          console.log(
            `[ResearchMissions:run] Background lifecycle ${id} xong — status=${result.mission?.status ?? 'unknown'}, errors=${result.errors.length}`,
          )
        } catch (err) {
          // LLM fail-open đã nuốt bên trong; throw tới đây là lỗi hạ tầng —
          // ghi log đầy đủ, KHÔNG crash process (lifecycle khác vẫn chạy)
          console.error(
            `[ResearchMissions:run] Background lifecycle ${id} CRASH:`,
            err instanceof Error ? err.message : String(err),
          )
        } finally {
          inFlightRuns.delete(id)
        }
      })()
      return NextResponse.json(
        {
          status: 'started',
          missionId: id,
          note: `Lifecycle chạy background (round-40 fix #40-2). Poll GET /api/research/missions/${id} — status sẽ đi TRIAGING → DECOMPOSING → RESEARCHING → MONITORING → FINALIZED. Dùng ?wait=true nếu cần hành vi blocking cũ.`,
        },
        { status: 202 },
      )
    }

    // 4b. Wait mode (?wait=true) — hành vi blocking cũ cho script/test.
    //     Caller tự chịu rủi ro: client disconnect giữa chừng giết lifecycle
    //     (đây chính là bug #40-2 đã chứng minh bằng mission cmuv6j9zx).
    try {
      const result = await kingFullLifecycle(id)
      return NextResponse.json({
        status: 'ok',
        mission: result.mission,
        finalReport: result.finalReport,
        parts: result.parts,
        errors: result.errors,
      })
    } finally {
      inFlightRuns.delete(id)
    }
  } catch (err) {
    inFlightRuns.delete(id)
    console.error('[ResearchMissions:run] POST error:', err)
    return NextResponse.json(
      {
        status: 'error',
        error: err instanceof Error ? err.message : String(err),
      },
      { status: 500 },
    )
  }
}
