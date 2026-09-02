/**
 * /api/research/missions/[id] — GET (detail) + PATCH (transition/tier change) — TB-13 §2.2
 * =================================================================================================
 * Spec:
 *  - TB-13 §2.2 — API route chi tiết + state transition (append-only event).
 *  - TB-02 §7 — Status flow: CLASSIFY → TRIAGING → DECOMPOSING → RESEARCHING →
 *    MONITORING → FINALIZED (+ branch ESCALATED, PIVOTED).
 *  - DR-C3 — Tier change append-only (changelog + decision log).
 *
 * Next.js 16 App Router: params là Promise (await bắt buộc).
 */

import { NextRequest, NextResponse } from 'next/server'
import {
  getMission,
  transitionMission,
  updateClarification,
} from '@/lib/research-team/mission-store'
import { changeTier } from '@/lib/research-team/tier'

export const dynamic = 'force-dynamic'

interface RouteContext {
  params: Promise<{ id: string }>
}

// ============================================================
// GET — DETAIL
// ============================================================

export async function GET(_req: NextRequest, { params }: RouteContext) {
  const { id } = await params
  try {
    const mission = await getMission(id)
    if (!mission) {
      return NextResponse.json(
        { status: 'error', error: `Mission ${id} không tồn tại` },
        { status: 404 },
      )
    }
    return NextResponse.json({ status: 'ok', mission })
  } catch (err) {
    console.error('[ResearchMissions:id] GET error:', err)
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
// PATCH — TRANSITION (status) / TIER CHANGE (tier)
// ============================================================

interface PatchBody {
  status?: string
  tier?: 'T1' | 'T2' | 'T3'
  /** TASK 3-fix WORK 6 (audit C.13 fix): missionType M1/M2/M3 — chỉ set qua
   *  clarify flow (status === 'CLASSIFY' → 'TRIAGING'). updateClarification
   *  lưu missionType + tier + status trong 1 transaction (atomic). */
  missionType?: 'M1' | 'M2' | 'M3'
  decision?: {
    agent?: string
    decision?: string
    reason: string
    ref?: string
  }
}

export async function PATCH(req: NextRequest, { params }: RouteContext) {
  const { id } = await params

  let body: PatchBody
  try {
    body = (await req.json()) as PatchBody
  } catch {
    return NextResponse.json(
      { status: 'error', error: 'Body JSON không hợp lệ' },
      { status: 400 },
    )
  }

  // Validate body: cần ít nhất `status`, `tier`, hoặc `missionType`
  if (!body.status && !body.tier && !body.missionType) {
    return NextResponse.json(
      {
        status: 'error',
        error: 'Body cần có trường "status", "tier" hoặc "missionType"',
      },
      { status: 400 },
    )
  }

  try {
    // 0. Check mission tồn tại trước (404 friendly)
    const existing = await getMission(id)
    if (!existing) {
      return NextResponse.json(
        { status: 'error', error: `Mission ${id} không tồn tại` },
        { status: 404 },
      )
    }

    // TASK 3-fix WORK 6 (audit C.13 fix): clarify flow — nếu body có `missionType`
    // AND mission status === 'CLASSIFY' → gọi updateClarification (atomic update
    // missionType + tier + status + confidence + decision log). Trước đây
    // `missionType` bị drop (PATCH không handle → transitionMission + changeTier
    // riêng lẻ → user's M1/M2/M3 selection mất).
    if (body.missionType && existing.status === 'CLASSIFY') {
      if (!body.tier) {
        return NextResponse.json(
          { status: 'error', error: 'Clarify flow cần cả "missionType" và "tier"' },
          { status: 400 },
        )
      }
      try {
        const mission = await updateClarification(id, {
          missionType: body.missionType,
          tier: body.tier,
          confidence: existing.confidence || { signals: [], conflicts: [], level: 'MEDIUM' },
          decision: body.decision
            ? {
                at: new Date().toISOString(),
                agent: body.decision.agent || 'USER',
                decision: body.decision.decision || 'CLARIFY',
                reason: body.decision.reason,
                ref: body.decision.ref,
              }
            : {
                at: new Date().toISOString(),
                agent: 'USER',
                decision: 'CLARIFY',
                reason: `User clarified: missionType=${body.missionType}, tier=${body.tier}`,
              },
        })
        return NextResponse.json({ status: 'ok', mission })
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        if (msg.includes('không tồn tại')) {
          return NextResponse.json(
            { status: 'error', error: msg },
            { status: 404 },
          )
        }
        return NextResponse.json(
          { status: 'error', error: `Clarify failed: ${msg}` },
          { status: 400 },
        )
      }
    }

    let mission = existing

    // 1. Transition status (nếu có)
    if (body.status) {
      try {
        mission = await transitionMission(id, {
          toStatus: body.status,
          decision: body.decision
            ? {
                at: new Date().toISOString(),
                agent: body.decision.agent || 'KING',
                decision: body.decision.decision || 'CONTINUE',
                reason: body.decision.reason,
                ref: body.decision.ref,
              }
            : undefined,
        })
      } catch (err) {
        // Transition không hợp lệ → 400
        const msg = err instanceof Error ? err.message : String(err)
        if (msg.includes('không tồn tại')) {
          return NextResponse.json(
            { status: 'error', error: msg },
            { status: 404 },
          )
        }
        return NextResponse.json(
          { status: 'error', error: `Transition không hợp lệ: ${msg}` },
          { status: 400 },
        )
      }
    }

    // 2. Tier change (nếu có và khác tier hiện tại) — DR-C3 append-only
    if (body.tier && body.tier !== mission.tier) {
      try {
        mission = await changeTier(
          id,
          body.tier,
          body.decision?.reason || `tier change via PATCH (target: ${body.tier})`,
          body.decision?.ref,
          body.decision?.agent,
        )
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        if (msg.includes('no-op')) {
          // Đã ở tier đó → không lỗi, chỉ skip
        } else if (msg.includes('không tồn tại')) {
          return NextResponse.json(
            { status: 'error', error: msg },
            { status: 404 },
          )
        } else {
          return NextResponse.json(
            { status: 'error', error: `Tier change failed: ${msg}` },
            { status: 400 },
          )
        }
      }
    }

    return NextResponse.json({ status: 'ok', mission })
  } catch (err) {
    console.error('[ResearchMissions:id] PATCH error:', err)
    return NextResponse.json(
      {
        status: 'error',
        error: err instanceof Error ? err.message : 'Lỗi không xác định',
      },
      { status: 500 },
    )
  }
}
