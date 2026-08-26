/**
 * Agent Capabilities API — runtime tool verification report
 *
 * GET /api/agent-capabilities
 *
 * Trả về JSON report các capability đã được PROBE THẬT (đọc file, chạy echo,
 * ping Qdrant/Neo4j, gọi SDK web search, đếm skills, enumerate MCP...).
 * Đây là nguồn dữ liệu cho prompt block buildCapabilityPromptBlock() —
 * agents được inject danh sách tool "verified working" vào system prompt.
 *
 * Query params:
 *   ?refresh=1 — bỏ cache, probe lại ngay (dùng sau khi đổi workspace/flag)
 */

import { NextRequest, NextResponse } from 'next/server'
import { probeCapabilities, invalidateCapabilityCache } from '@/lib/agent-capabilities'

export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  try {
    if (request.nextUrl.searchParams.get('refresh') === '1') {
      invalidateCapabilityCache()
    }
    const report = await probeCapabilities()
    return NextResponse.json({ ok: true, ...report })
  } catch (err) {
    return NextResponse.json({
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    }, { status: 500 })
  }
}
