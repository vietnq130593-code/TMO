/**
 * EPISODIC DECAY API — Task A6-API-UI
 *
 * POST /api/episodic/decay — chạy episode importance decay thủ công từ UI
 * (hoặc cron): episode không được truy cập > `days` ngày → importance *=
 * `factor`. Lesson KHÔNG bao giờ decay (C.2).
 *
 * Body (optional): {days?: number, factor?: number} — mặc định {30, 0.9}
 * (EPISODIC_THRESHOLDS.episodeDecayDays / episodeDecayFactor).
 *
 * Fail-open: try/catch, trả {decayed: 0, error} khi lỗi — không 500.
 */

import { NextRequest, NextResponse } from 'next/server'
import { EPISODIC_THRESHOLDS, decayEpisodes } from '@/lib/episodic-memory'

export const dynamic = 'force-dynamic'

const DAYS_MIN = 1
const DAYS_MAX = 365
const FACTOR_MIN = 0
const FACTOR_MAX = 1

export async function POST(request: NextRequest) {
  let days: number = EPISODIC_THRESHOLDS.episodeDecayDays
  let factor: number = EPISODIC_THRESHOLDS.episodeDecayFactor

  try {
    const body = await request.json()
    if (typeof body === 'object' && body !== null) {
      const b = body as Record<string, unknown>
      if (typeof b.days === 'number' && Number.isFinite(b.days)) {
        days = Math.min(Math.max(Math.round(b.days), DAYS_MIN), DAYS_MAX)
      }
      if (typeof b.factor === 'number' && Number.isFinite(b.factor)) {
        factor = Math.min(Math.max(b.factor, FACTOR_MIN), FACTOR_MAX)
      }
    }
  } catch {
    // Không có body / body không phải JSON — dùng mặc định
  }

  try {
    const decayed = await decayEpisodes({ days, factor })
    return NextResponse.json({
      ok: true,
      decayed,
      params: { days, factor },
      error: null,
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[Episodic/Decay] POST error (fail-open):', err)
    return NextResponse.json({
      ok: false,
      decayed: 0,
      params: { days, factor },
      error: msg,
    })
  }
}
