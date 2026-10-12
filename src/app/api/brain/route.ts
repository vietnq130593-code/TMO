/**
 * BRAIN API — phục panel "Não vận hành" (tab Database > Kiến trúc)
 * ======================================================================
 *
 * GET → trạng thái 3 brain (Brain-A/B/C — BLUEPRINT-BRAIN-P1-P5 §4.1,
 * áp dụng sớm phần UI theo chỉ thị user 2026-10-12):
 *   - registry tĩnh từ src/lib/brain/registry.ts (single-source #9)
 *   - đếm thật các bảng nguồn thức tỉnh (EvalResult / AgentRunRecord /
 *     QEntry / ArbiterVerdict) — mỗi đếm fail-open độc lập (null = lỗi)
 *   - lifecycle: dormant (thiếu mẫu) → awake (đủ mẫu, chưa có bản active)
 *     → active (có bản BrainModel active)
 *   - các phiên bản BrainModel đã train (nếu có) — KHÔNG kéo weightsJson
 *
 * Chỉ đọc (read-only) — train qua POST /api/brain/train (BRAIN-P2:
 * pipeline Brain-A calibration-v3.ts + BRAIN-P3: Brain-B brains/surrogate.ts
 * — chỉ brain trong BRAIN_TRAINABLE_KEYS nhận train, còn lại 400); replay-eval
 * qua POST /api/brain/replay (BRAIN-P3 — READ-ONLY, cờ replay_eval).
 *
 * Nhẹ cho SQLite: toàn bộ count/findMany take nhỏ trên bảng có index
 * ([brain, active] — migration add_brain_model); KHÔNG $transaction
 * (bài học BUG2-119).
 */

import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import {
  BRAIN_REGISTRY,
  BRAIN_TRAINABLE_KEYS,
  BRAIN_TRAINING_IMPLEMENTED,
  type BrainApiResponse,
  type BrainModelSummary,
  type BrainStatusEntry,
  type BrainLifecycle,
} from '@/lib/brain/registry'

export const dynamic = 'force-dynamic'

/** Đếm an toàn — lỗi → null (signal hiển thị "—", không sập response). */
async function safeCount(fn: () => Promise<number>): Promise<number | null> {
  try {
    return await fn()
  } catch {
    return null
  }
}

/** Parse trainMetaJson fail-open — lỗi/không hợp lệ → meta rỗng. */
function parseTrainMeta(raw: string): BrainModelSummary['meta'] {
  try {
    const obj = JSON.parse(raw) as Record<string, unknown>
    const num = (v: unknown): number | undefined =>
      typeof v === 'number' && Number.isFinite(v) ? v : undefined
    return {
      nSamples: num(obj.nSamples),
      cvScore: num(obj.cvScore),
      ciLow: num(obj.cvScoreCiLow),
      ciHigh: num(obj.cvScoreCiHigh),
      metric: typeof obj.metric === 'string' ? obj.metric : undefined,
      // BRAIN-P2 — baseline đối chứng + kết luận CV (hiển thị "thắng/thua V2")
      // BRAIN-P3 — surrogate viết thẳng 'brierBaseline' (base-rate đối chứng
      // của đầu success); V3 viết 'brierV2' — đọc cả 2 (fail-open từng trường)
      brierBaseline: num(obj.brierV2) ?? num(obj.brierBaseline),
      improved: typeof obj.improved === 'boolean' ? obj.improved : undefined,
    }
  } catch {
    return {}
  }
}

export async function GET() {
  try {
    // ── Đếm nguồn thức tỉnh (mỗi nguồn fail-open độc lập) ──
    const [evalResults, agentRuns, qEntries, verdicts] = await Promise.all([
      safeCount(() => db.evalResult.count()),
      safeCount(() => db.agentRunRecord.count()),
      safeCount(() => db.qEntry.count()),
      safeCount(() => db.arbiterVerdict.count()),
    ])
    const counts: Record<string, number | null> = {
      evalResults,
      agentRuns,
      qEntries,
      verdicts,
    }

    // ── Các phiên bản đã train (thường rỗng giai đoạn đầu) ──
    let models: Array<{
      id: string
      brain: string
      version: number
      inputMode: string
      active: boolean
      trainedAt: Date
      trainMetaJson: string
    }> = []
    try {
      models = await db.brainModel.findMany({
        orderBy: [{ brain: 'asc' }, { version: 'desc' }],
        take: 30,
        select: {
          id: true,
          brain: true,
          version: true,
          inputMode: true,
          active: true,
          trainedAt: true,
          trainMetaJson: true,
        },
      })
    } catch {
      // fail-open — brain chưa train lần nào cũng vào đây (bảng mới tạo rỗng
      // thì findMany vẫn thành công; chỉ lỗi DB thật mới nhánh này)
    }

    // ── Ghép registry → trạng thái ──
    const brains: BrainStatusEntry[] = BRAIN_REGISTRY.map(spec => {
      const signals = spec.signals.map(sig => {
        const current = counts[sig.key] ?? null
        return {
          ...sig,
          current,
          // null (lỗi đếm) = chưa OK — fail-open giữ brain ngủ
          ok: current !== null && current >= sig.min,
        }
      })
      const specModels = models
        .filter(m => m.brain === spec.key)
        .map<BrainModelSummary>(m => ({
          id: m.id,
          brain: m.brain,
          version: m.version,
          inputMode: m.inputMode,
          active: m.active,
          trainedAt: m.trainedAt.toISOString(),
          meta: parseTrainMeta(m.trainMetaJson),
        }))
      const hasActive = specModels.some(m => m.active)
      const allOk = signals.length > 0 && signals.every(s => s.ok)
      const lifecycle: BrainLifecycle = hasActive ? 'active' : allOk ? 'awake' : 'dormant'
      return {
        ...spec,
        lifecycle,
        signals,
        models: specModels,
        trainable: BRAIN_TRAINABLE_KEYS.includes(spec.key),
      }
    })

    const payload: BrainApiResponse = {
      trainingImplemented: BRAIN_TRAINING_IMPLEMENTED,
      brains,
      generatedAt: new Date().toISOString(),
    }
    return NextResponse.json(payload)
  } catch (err) {
    console.error('[Brain] GET failed:', err instanceof Error ? err.message : String(err))
    return NextResponse.json(
      { error: 'Không tải được trạng thái não vận hành', details: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    )
  }
}
