/**
 * EVO-P4 (BLUEPRINT-EVO-NAO-P1-P5 §4.5/§5.7) — EVOLVE API
 * ============================================================================
 *
 * GET  /api/brain/evolve?brain=KEY[&runId=<id>] — trạng thái vòng + ứng viên
 *      (runId omit = vòng mới nhất của brain). Run của process trước được
 *      rebuild từ DB; running mà heartbeat stale > 60s → đánh dấu failed
 *      (mồ côi không treo vĩnh viễn — precedent HN §4.2-2b).
 * POST /api/brain/evolve { brain, candidates?, seed? } — khởi động vòng
 *      (async fire-and-forget, trả runId NGAY).
 *
 * Contract pin §5.7 (r108): reason 400 = 'flag_off' (cờ brain_evolve off
 * HOẶC kill-switch toàn cục brain_search_global off) | 'already_running' |
 * 'invalid_brain' (ngoài A/B/C — knowledge ghost chưa vào search space) |
 * 'invalid_candidates' (ngoài 4–24 bước 4). Mở rộng additive duy nhất:
 * 'invalid_seed' (seed người dùng truyền phải nguyên 0..SEED_MAX — từ chối
 * rõ ràng hơn kẹp im lặng; ghi nhận ở changelog blueprint).
 *
 * Cờ: `brain_evolve` (tuning #35, mặc định OFF) + `brain_search_global`
 * (#36, 'off' = kill mọi search). Read-only đối với BrainModel/active —
 * H1/H2: search chỉ ĐỀ XUẤT.
 */

import { NextRequest, NextResponse } from 'next/server'
import { getTuningEnum } from '@/lib/learning/tuning-store'
import {
  startEvoRun,
  getEvoRunState,
  validateEvoStart,
} from '@/lib/brain/evolve'
import type { BrainKey } from '@/lib/brain/registry'

export const dynamic = 'force-dynamic'

/** Đọc cờ kill-switch — fail-open OFF (lỗi đọc = chặn, an toàn H1). */
function isEvoAllowed(): { allowed: boolean; reason?: string } {
  try {
    if (getTuningEnum('brain_evolve') !== 'on') {
      return { allowed: false, reason: "cờ 'brain_evolve' đang off — bật qua UI Tham số runtime (tuning #35)" }
    }
  } catch {
    return { allowed: false, reason: "không đọc được cờ 'brain_evolve' (fail-open = chặn)" }
  }
  try {
    if (getTuningEnum('brain_search_global') === 'off') {
      return { allowed: false, reason: "kill-switch toàn cục 'brain_search_global' đang off — mọi não search bị dừng (U5 §5.6)" }
    }
  } catch {
    // cờ global đọc lỗi → không chặn vì cờ riêng đã pass (fail-open theo per-feature)
  }
  return { allowed: true }
}

export async function GET(request: NextRequest) {
  try {
    const brain = request.nextUrl?.searchParams?.get('brain') ?? new URL(request.url).searchParams.get('brain')
    const runId = request.nextUrl?.searchParams?.get('runId') ?? new URL(request.url).searchParams.get('runId') ?? undefined
    if (!brain) {
      return NextResponse.json({ error: "thiếu query 'brain' (calibration_v3 | surrogate | policy)" }, { status: 400 })
    }
    const payload = await getEvoRunState(brain, runId)
    return NextResponse.json(payload)
  } catch (err) {
    console.error('[Evolve API] GET failed:', err instanceof Error ? err.message : String(err))
    return NextResponse.json(
      { error: 'Không tải được trạng thái evolve', details: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    )
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>

    // 1) Cờ (reason 'flag_off' — pin §5.7)
    const flag = isEvoAllowed()
    if (!flag.allowed) {
      return NextResponse.json({ ok: false, reason: 'flag_off', message: flag.reason }, { status: 400 })
    }

    // 2) Validate input (reason pin — F6/0.5)
    const check = validateEvoStart({ brain: body.brain, candidates: body.candidates, seed: body.seed })
    if (!check.ok) {
      return NextResponse.json({ ok: false, reason: check.reason, message: check.message }, { status: 400 })
    }

    // 3) Khởi động (bên trong kiểm already_running — race an toàn)
    const result = await startEvoRun({
      brain: body.brain as BrainKey,
      candidates: typeof body.candidates === 'number' ? body.candidates : 8,
      seed: typeof body.seed === 'number' ? body.seed : undefined,
    })
    if (!result.ok) {
      return NextResponse.json({ ok: false, reason: result.reason, message: result.message }, { status: 400 })
    }
    return NextResponse.json({ ok: true, runId: result.runId })
  } catch (err) {
    console.error('[Evolve API] POST failed:', err instanceof Error ? err.message : String(err))
    return NextResponse.json(
      { error: 'Không khởi động được vòng evolve', details: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    )
  }
}
