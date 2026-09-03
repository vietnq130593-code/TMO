/**
 * /api/research/missions — LIST (GET) + CREATE (POST) — TB-13 §2.2
 * ===================================================================
 * Spec:
 *  - TB-13 §2.2 — API route list/tạo mission. POST → CLASSIFY gán tier (TC-01).
 *  - TB-02 §1 — Pipeline: REQUEST → CLASSIFY (Bước 0) → TRIAGE (tier) → ...
 *  - DR-C2 — Confidence counting: HIGH/MEDIUM classify ngay; LOW hỏi 1 câu.
 *  - TB-02 §6 edge #1 — Ambiguous request (LOW): trả đúng 1 câu hỏi, KHÔNG guess.
 *
 * Behavior:
 *  GET  /api/research/missions?status=&tier=&limit=&offset= → list
 *  POST /api/research/missions { request, title? } → CLASSIFY + create
 *    - confidence LOW (ambiguous) → 201 { status:'needs_clarification', clarifyingQuestion, mission }
 *    - confidence HIGH/MEDIUM    → 201 { status:'classified', mission, classify }
 *
 * Fail-open: lỗi LLM/DB → 500 graceful (KHÔNG crash).
 */

import { NextRequest, NextResponse } from 'next/server'
import { classifyMission } from '@/lib/research-team/classify'
import {
  createMission,
  listMissions,
  countMissions,
} from '@/lib/research-team/mission-store'

export const dynamic = 'force-dynamic'

// ============================================================
// GET — LIST MISSIONS
// ============================================================

export async function GET(req: NextRequest) {
  try {
    const url = new URL(req.url)
    const status = url.searchParams.get('status') || undefined
    const tier = url.searchParams.get('tier') || undefined
    const limitRaw = Number(url.searchParams.get('limit') ?? '50')
    const offsetRaw = Number(url.searchParams.get('offset') ?? '0')

    const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 200) : 50
    const offset = Number.isFinite(offsetRaw) ? Math.max(offsetRaw, 0) : 0

    const filter = { status, tier, limit, offset }
    const [missions, total] = await Promise.all([
      listMissions(filter),
      countMissions(filter),
    ])

    return NextResponse.json({
      status: 'ok',
      missions,
      total,
      limit,
      offset,
    })
  } catch (err) {
    console.error('[ResearchMissions] GET list error:', err)
    return NextResponse.json(
      {
        status: 'error',
        error: err instanceof Error ? err.message : 'Lỗi không xác định',
      },
      { status: 500 },
    )
  }
}

// ============================================================
// POST — CREATE MISSION (CLASSIFY + persist)
// ============================================================

interface CreateRequestBody {
  request?: string
  title?: string
}

export async function POST(req: NextRequest) {
  let body: CreateRequestBody
  try {
    body = (await req.json()) as CreateRequestBody
  } catch {
    return NextResponse.json(
      { status: 'error', error: 'Body JSON không hợp lệ' },
      { status: 400 },
    )
  }

  const request = (body?.request || '').trim()
  const title = body?.title?.trim() || undefined

  if (!request) {
    return NextResponse.json(
      { status: 'error', error: 'Trường "request" bắt buộc và không được rỗng' },
      { status: 400 },
    )
  }

  // ---------- 1. CLASSIFY (Bước 0 — TB-02 §1) ----------
  let classify
  try {
    classify = await classifyMission(request, title)
  } catch (err) {
    // classify.ts đã fail-open về LOW, nhưng nếu có throw bất thường → graceful 500
    console.error('[ResearchMissions] POST classifyMission threw:', err)
    return NextResponse.json(
      {
        status: 'error',
        error: `Classify failed: ${err instanceof Error ? err.message : String(err)}`,
      },
      { status: 500 },
    )
  }

  // ---------- 2. CREATE MISSION ----------
  try {
    const mission = await createMission({
      request,
      title,
      missionType: classify.missionType,
      tier: classify.tier, // undefined nếu LOW → store sẽ set tier=''
      confidence: classify.confidence,
      initialDecisionLog: [
        {
          at: new Date().toISOString(),
          agent: 'NEMESIS',
          decision: 'RESEARCH',
          reason: `Classified as ${classify.missionType}${
            classify.tier ? `/${classify.tier}` : '/?'
          } (confidence: ${classify.confidence.level})`,
        },
      ],
    })

    // ---------- 3. RESPONSE theo confidence level (DR-C2 + TC-01) ----------
    if (classify.confidence.level === 'LOW') {
      // TB-02 §6 edge #1 — KHÔNG guess, trả đúng 1 câu hỏi clarifying
      return NextResponse.json(
        {
          status: 'needs_clarification',
          mission,
          clarifyingQuestion: classify.clarifyingQuestion,
          classify,
        },
        { status: 201 },
      )
    }

    // HIGH / MEDIUM — classified thành công, tier đã set
    return NextResponse.json(
      {
        status: 'classified',
        mission,
        classify,
      },
      { status: 201 },
    )
  } catch (err) {
    console.error('[ResearchMissions] POST createMission failed:', err)
    return NextResponse.json(
      {
        status: 'error',
        error: `Create mission failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      },
      { status: 500 },
    )
  }
}
