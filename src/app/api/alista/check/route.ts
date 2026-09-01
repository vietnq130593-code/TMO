/**
 * ALISTA — POST /api/alista/check · GET /api/alista/check?checkId=X
 * ====================================================================
 * POST (body {force?}): khởi động pipeline Kiểm tra toàn diện (manual).
 *   - Trả 201 {checkId, startedAt} NGAY (fire-and-forget — pipeline chạy async).
 *   - Nếu force=false và đã có check hôm nay → trả luôn check cũ (idempotent).
 *   - UI poll GET?checkId=… mỗi 2s tối đa 300s để theo dõi tiến độ từng bước.
 *
 * GET ?checkId=X: đọc globalState Map → trả {status, steps[], proposalsCreated,
 *   durationMs, deadlineMet, ...}. Nếu checkId không có trong Map (process
 *   restart) → fallback đọc TaskExecution 'alista-check' mới nhất.
 *
 * Deadline manual: now + 10' (mềm — đủ cho 7 bước + LLM, không để UI poll
 * timeout). Nếu chạy quá 10' vẫn ghi proposal đã có (graceful partial).
 */

import { NextRequest, NextResponse } from 'next/server'
import { randomUUID } from 'crypto'
import { db } from '@/lib/db'
import { runComprehensiveCheck, getCheckState } from '@/lib/alista'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

// ==================== POST — khởi động check manual ====================

export async function POST(request: NextRequest) {
  let force = false
  try {
    const body = await request.json() as { force?: boolean }
    force = !!body.force
  } catch { /* body rỗng OK — force=false default */ }

  // Idempotency: nếu !force và đã có check "completed" hôm nay → trả luôn
  if (!force) {
    try {
      const startOfToday = getStartOfTodayVN()
      const recent = await db.taskExecution.findFirst({
        where: {
          type: 'alista-check',
          status: 'completed',
          startedAt: { gte: startOfToday },
        },
        orderBy: { startedAt: 'desc' },
        select: { id: true, startedAt: true, completedAt: true, result: true },
      })
      if (recent?.result) {
        try {
          const parsed = JSON.parse(recent.result) as { checkId?: string }
          if (parsed.checkId) {
            const state = getCheckState(parsed.checkId)
            if (state && state.status === 'completed') {
              return NextResponse.json({
                checkId: parsed.checkId,
                startedAt: state.startedAt,
                status: 'completed',
                message: 'Đã có check hôm nay — trả lại kết quả cũ (force=true để chạy lại)',
                reused: true,
              })
            }
          }
        } catch { /* ignore parse error — chạy check mới */ }
      }
    } catch (err) {
      console.warn('[ALISTA][route:check] idempotency query fail (fail-open — chạy check mới):', err instanceof Error ? err.message : String(err))
    }
  }

  // Khởi động pipeline fire-and-forget — deadline now + 10' (mềm cho UI poll)
  // FIX checkId: sinh UUID TRƯỚC khi fire — trả ngay cho client poll GET ?checkId=…
  // (trước đây trả 'pending' → client phải đoán qua /checks → id không khớp state Map)
  const startedAt = Date.now()
  const deadlineMs = startedAt + 10 * 60_000 // 10 phút mềm
  const checkId = randomUUID()
  // Promise không await — pipeline chạy nền, route trả về ngay
  void runComprehensiveCheck({ trigger: 'manual', checkId, force, deadlineMs })
    .then((result) => {
      console.log(`[ALISTA][route:check] POST xong — checkId=${result.checkId}, ${result.proposalsCreated.length} proposals, ${result.durationMs}ms`)
    })
    .catch((err) => {
      console.error('[ALISTA][route:check] POST pipeline error:', err instanceof Error ? err.message : String(err))
    })

  return NextResponse.json(
    { checkId, startedAt, deadlineMs, message: 'Pipeline đang chạy — poll GET ?checkId=… để theo dõi' },
    { status: 202 },
  )
}

// ==================== GET — poll state của check ====================

export async function GET(request: NextRequest) {
  const checkId = request.nextUrl.searchParams.get('checkId')
  if (!checkId) {
    return NextResponse.json(
      { error: 'Thiếu query ?checkId=' },
      { status: 400 },
    )
  }

  // Đọc state từ globalState Map (sống trong process)
  const state = getCheckState(checkId)
  if (state) {
    return NextResponse.json(state)
  }

  // Fallback: nếu process restart → state mất → đọc TaskExecution mới nhất
  try {
    const recent = await db.taskExecution.findFirst({
      where: { type: 'alista-check' },
      orderBy: { startedAt: 'desc' },
      take: 1,
    })
    if (recent) {
      // Parse result JSON để xem checkId có khớp không
      let parsed: { checkId?: string } | null = null
      try {
        parsed = JSON.parse(recent.result || '{}') as { checkId?: string }
      } catch { /* ignore */ }
      if (parsed?.checkId === checkId) {
        return NextResponse.json({
          checkId,
          trigger: 'manual',
          startedAt: recent.startedAt.getTime(),
          completedAt: recent.completedAt?.getTime(),
          status: recent.status === 'running' ? 'running' : 'completed',
          reason: 'restored_from_task_execution',
          steps: [],
          proposalsCreated: [],
          partialSteps: [],
          deadlineMet: true,
          deadlineMs: 0,
          error: recent.errorMessage,
        })
      }
    }
  } catch (err) {
    console.warn('[ALISTA][route:check] GET fallback fail:', err instanceof Error ? err.message : String(err))
  }

  return NextResponse.json(
    { error: `checkId=${checkId} không tìm thấy trong state (pipeline có thể đã hoàn tất hoặc process restart)` },
    { status: 404 },
  )
}

// ==================== HELPERS ====================

/** Bắt đầu "hôm nay" theo giờ VN — pattern như /api/metrics/overview */
function getStartOfTodayVN(): Date {
  const now = new Date()
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Ho_Chi_Minh',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now)
  const y = parts.find(p => p.type === 'year')!.value
  const m = parts.find(p => p.type === 'month')!.value
  const d = parts.find(p => p.type === 'day')!.value
  return new Date(`${y}-${m}-${d}T00:00:00+07:00`)
}
