import { NextResponse } from 'next/server'
import {
  reconcilePendingWritebacks,
  getPendingWritebackAudit,
} from '@/lib/kb-routing/transactional-writeback'

// Phase 2 SMOLAB Proposal 6 — Reconcile endpoint.
// POST: re-attempt failed/partial writeback batches (idempotent).
// GET:  list pending/partial/failed batches for audit UI.

export async function POST(request: Request) {
  try {
    const url = new URL(request.url)
    const limitParam = url.searchParams.get('limit') || '10'
    const limit = Math.min(parseInt(limitParam, 10) || 10, 100)

    const result = await reconcilePendingWritebacks(limit)

    return NextResponse.json({
      ok: true,
      ...result,
    })
  } catch (err) {
    console.error('[Reconcile] Error:', err)
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : 'Reconcile failed' },
      { status: 500 }
    )
  }
}

export async function GET() {
  try {
    const audit = await getPendingWritebackAudit()

    return NextResponse.json(audit)
  } catch (err) {
    console.error('[Reconcile GET] Error:', err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to list' },
      { status: 500 }
    )
  }
}
