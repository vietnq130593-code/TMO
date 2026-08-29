/**
 * EPISODIC CLASSIFY API — Task A6-API-UI
 *
 * POST /api/episodic/classify — test phân loại lỗi theo taxonomy B.3 (B1-B7):
 * user dán raw error message (+ tool) → root cause + manifestation + điểm
 * match + decision path + playbook (phản ứng ĐÚNG vs anti-pattern).
 *
 * Thuần tính toán trong memory (classifyRootCause) — KHÔNG đụng DB/Neo4j/
 * Qdrant. Fail-open: try/catch, không 500.
 */

import { NextRequest, NextResponse } from 'next/server'
import { classifyRootCause } from '@/lib/episodic-memory'

export const dynamic = 'force-dynamic'

const RAW_MAX = 2000

export async function POST(request: NextRequest) {
  let rawMessage = ''
  let tool: string | undefined

  try {
    const body = await request.json()
    if (typeof body === 'object' && body !== null) {
      const b = body as Record<string, unknown>
      if (typeof b.rawMessage === 'string') rawMessage = b.rawMessage.trim().slice(0, RAW_MAX)
      if (typeof b.tool === 'string' && b.tool.trim()) tool = b.tool.trim().slice(0, 60)
    }
  } catch {
    // body không phải JSON — rawMessage rỗng → 400 bên dưới
  }

  if (!rawMessage) {
    return NextResponse.json(
      { ok: false, error: 'Thiếu rawMessage — dán error message cần phân loại' },
      { status: 400 },
    )
  }

  try {
    const result = classifyRootCause({ rawMessage, tool })
    return NextResponse.json({ ok: true, input: { rawMessage, tool: tool ?? null }, result, error: null })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[Episodic/Classify] POST error (fail-open):', err)
    return NextResponse.json({ ok: false, result: null, error: msg })
  }
}
