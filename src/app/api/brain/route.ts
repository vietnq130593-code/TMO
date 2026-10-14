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
      // BRAIN-UX §9.3/§9.4 — |gradient| trung bình từng lớp (chế độ lan
      // truyền ngược UX-3) + cờ train từ bản nháp UX-2 (provenance)
      gradAbsMean: Array.isArray(obj.gradAbsMean) && obj.gradAbsMean.every(v => typeof v === 'number' && Number.isFinite(v))
        ? (obj.gradAbsMean as number[])
        : undefined,
      draftUsed: typeof obj.draftUsed === 'boolean' ? obj.draftUsed : undefined,
    }
  } catch {
    return {}
  }
}

export async function GET() {
  try {
    // ── Đếm nguồn thức tỉnh (mỗi nguồn fail-open độc lập) ──
    // R4-ĐIỀU TRA: qEntries dùng SUM(visits) (số lần updateQ — thoát deadlock
    // không gian trạng thái nhỏ; nhất quán gate train policy.ts).
    const [evalResults, agentRuns, qEntries, verdicts] = await Promise.all([
      safeCount(() => db.evalResult.count()),
      safeCount(() => db.agentRunRecord.count()),
      safeCount(() => import('@/lib/learning/q-table').then(m => m.countQLearningSignal())),
      safeCount(() => db.arbiterVerdict.count()),
    ])
    const counts: Record<string, number | null> = {
      evalResults,
      agentRuns,
      qEntries,
      verdicts,
    }

    // ── BRAIN-UX §9.1-3: ước tính số chiều đầu vào brain động (surrogate) ──
    // D = distinct(model) + distinct(agent) + 1 — CÙNG công thức vocab khi
    // train (surrogate.ts:146-147) nhưng đếm trên TOÀN BỘ AgentRunRecord
    // (train lọc usable — có thể lệch) → exact=false; bản active có sẵn thì
    // dùng spec thật (exact=true). Fail-open null.
    const surrogateVocabEstimate = await safeCount(async () => {
      const [m, a] = await Promise.all([
        db.agentRunRecord.groupBy({ by: ['model'], _count: { _all: true } }),
        db.agentRunRecord.findMany({ select: { agentId: true }, distinct: ['agentId'] }),
      ])
      return m.length + a.length + 1
    })

    // ── Các phiên bản đã train (thường rỗng giai đoạn đầu) ──
    let models: Array<{
      id: string
      brain: string
      version: number
      inputMode: string
      active: boolean
      trainedAt: Date
      trainMetaJson: string
      specJson: string
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
          specJson: true,
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

      // BRAIN-UX §9.1-3 — inputDim cho bộ đếm tham số editor:
      // A: khóa 10 (features-10) · B/C: từ bản active nếu có, B ước tính
      // DB khi chưa train (exact=false), C không ước tính được (task vocab
      // phức tạp — null trung thực, chặn thật tại mlp.validateSpec lúc train)
      // FB-BRAIN-UX-R1-02 — outputDim: số unit lớp output HIỆN TẠI từ bản
      // active (lớp CUỐI cùng specJson — vd |A| của policy) → bộ đếm tham số
      // editor đủ ×|A|; null khi chưa train (fail-open).
      let inputDim: number | null = null
      let inputDimExact = true
      let outputDim: number | null = null
      const activeModel = specModels.find(m => m.active)
      if (spec.key === 'calibration_v3') {
        inputDim = 10
      } else if (activeModel) {
        const activeRaw = models.find(m => m.brain === spec.key && m.active)
        try {
          if (activeRaw) {
            const specDoc = JSON.parse(activeRaw.specJson) as {
              layers?: Array<{ units?: number }>
              heads?: Record<string, { layers?: Array<{ units?: number }> }>
              spec?: { layers?: Array<{ units?: number }> }
            }
            // Dạng specJson từng brain: A = MlpSpec (layers đầu) · B =
            // SurrogateSpecDoc (heads.success.layers) · C = PolicySpecDoc
            // (spec.layers — FB-BRAIN-UX-R1-02: thêm nhánh `spec` vì policy
            // lồng MlpSpec dưới key `spec`, không phải `layers` đầu — thiếu
            // nhánh này thì |A| của policy không bao giờ đọc được).
            const layersArr = specDoc.layers ?? specDoc.spec?.layers ?? specDoc.heads?.success?.layers
            const first = layersArr?.[0]?.units
            if (typeof first === 'number' && Number.isFinite(first)) inputDim = first
            // Lớp CUỐI cùng (layers hoặc heads.success.layers) = unit output
            const last = layersArr?.[layersArr.length - 1]?.units
            if (typeof last === 'number' && Number.isFinite(last)) outputDim = last
          }
        } catch { /* fail-open null */ }
      } else if (spec.key === 'surrogate' && surrogateVocabEstimate !== null) {
        inputDim = surrogateVocabEstimate
        inputDimExact = false
      }

      return {
        ...spec,
        lifecycle,
        signals,
        models: specModels,
        trainable: BRAIN_TRAINABLE_KEYS.includes(spec.key),
        inputDim,
        inputDimExact,
        outputDim,
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
