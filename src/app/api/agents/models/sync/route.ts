/**
 * Free Models Sync API — R5 (2026-10-14)
 * ============================================================
 * GET  /api/agents/models/sync  — trạng thái sync (lastSyncAt, source, diff)
 * POST /api/agents/models/sync  — force đồng bộ NGAY từ CLI opencode /
 *                                 models.dev (bỏ TTL 6h) — dùng cho nút
 *                                 "Đồng bộ ngay" trong dropdown model.
 *
 * Response: { ok, result?, status } — status = getSyncStatus() (mirror
 * field freeModelsSync của /api/agents/models để UI chỉ cần 1 shape).
 */

import { NextResponse } from 'next/server'
import { syncZenFreeModels, getSyncStatus } from '@/lib/free-models-sync'

export const dynamic = 'force-dynamic'

export async function GET() {
  try {
    return NextResponse.json({ ok: true, status: getSyncStatus() })
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: 'Failed to get sync status', details: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    )
  }
}

export async function POST() {
  try {
    const result = await syncZenFreeModels(true)
    return NextResponse.json({
      ok: result.ok,
      result,
      status: getSyncStatus(),
    })
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: 'Failed to sync free models', details: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    )
  }
}
