/**
 * OpenClaw Status API — Check gateway health
 *
 * GET /api/openclaw/status — Returns gateway connection status
 */

import { NextResponse } from 'next/server'
import { isGatewayOnline } from '@/lib/openclaw'
// REQ-AUDIT FIX2 (2026-10-19) — micro-cache GET: Smolab poll 15s/lần (pill
// trạng thái gateway). TTL 20s ≈ 1.3× nhịp poll → ~50% request được gộp,
// dữ liệu tối đa 20s tuổi — chấp nhận được cho pill online/offline. Thất
// bại kết nối (offline) cũng được cache: bớt nỗ lực connect liên tục khi
// gateway đang tắt (on-demand idle-shutdown 10 phút).
import { withPollCache } from '@/lib/poll-microcache'

export const dynamic = 'force-dynamic'

async function GET_impl() {
  const startTime = Date.now()

  try {
    const result = await isGatewayOnline()

    if (result.online) {
      return NextResponse.json({
        status: 'online',
        responseTimeMs: result.responseTime,
        timestamp: new Date().toISOString(),
      })
    }

    return NextResponse.json({
      status: 'offline',
      responseTimeMs: result.responseTime || Date.now() - startTime,
      error: 'Gateway returned non-ok status',
      timestamp: new Date().toISOString(),
    })
  } catch (err) {
    return NextResponse.json({
      status: 'offline',
      responseTimeMs: Date.now() - startTime,
      error: err instanceof Error ? err.message : 'Gateway unreachable',
      timestamp: new Date().toISOString(),
    })
  }
}

export async function GET() {
  return withPollCache('oc|status', 20_000, () => GET_impl())
}
