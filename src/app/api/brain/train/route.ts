/**
 * BRAIN TRAIN API — POST /api/brain/train (BRAIN-P2 + BRAIN-P3, blueprint §4.2/§4.3)
 * ======================================================================
 *
 * Trigger train THEO CHỈ THỊ (nút "Huấn luyện lại" panel Não vận hành +
 * auto-retrain: Brain-A sau eval run ở src/lib/eval/runner.ts · Brain-B
 * sau agent run ở src/lib/agent-goal-loop.ts) — KHÔNG tự train trong
 * request path của runtime (đúng kỷ luật blueprint §4.2).
 *
 * Body: { brain: 'calibration_v3' | 'surrogate', inputMode? } (BRAIN_
 * TRAINABLE_KEYS; inputMode mặc định theo từng brain — mode vector chờ Q2).
 *
 * Hành vi (kế thừa nguyên vẹn pattern POST /api/eval/calibration):
 *   - brain lạ/chưa có pipeline → 400 (liệt kê các brain đã hỗ trợ)
 *   - thiếu mẫu / lệch lớp / mode chưa hỗ trợ / train trùng nhịp (A7) → 400
 *     { error, usable, need } — KHÔNG ghi DB gì cả (ngủ an toàn);
 *     usable/total phản ánh SỐ THẬT trong DB (FB-BRAIN-P2-R1-08)
 *   - train xong → 200 { trained, version, active, improved, sampleSize }
 *     + chỉ số CV theo brain (V3: cvBrier vs brierV2 · B: heads 3 đầu) —
 *     active=true CHỈ khi thắng baseline đối chứng qua 5-fold CV (ngặt);
 *     thua vẫn ghi bản vết audit active=false.
 *
 * Fail-open 2 chiều: lỗi hệ thống (DB...) → 500 nhưng KHÔNG bao giờ làm
 * hỏng trạng thái runtime hiện có (chuỗi calibration V3→V2→V1 và replay
 * đo-lường thuần tự giữ).
 */

import { NextResponse } from 'next/server'
import {
  BRAIN_TRAINABLE_KEYS,
} from '@/lib/brain/registry'
import {
  trainBrainCalibrationV3,
  MIN_TRAIN_SAMPLES_V3,
  V3_INPUT_MODE,
} from '@/lib/brain/calibration-v3'
import {
  trainBrainSurrogate,
  SURROGATE_MIN_TRAIN_SAMPLES,
  SURROGATE_INPUT_MODE,
} from '@/lib/brain/brains/surrogate'
import {
  trainBrainPolicy,
  POLICY_MIN_TRAIN_SAMPLES,
  POLICY_INPUT_MODE,
} from '@/lib/brain/brains/policy'

export const dynamic = 'force-dynamic'

export async function POST(request: Request) {
  let body: { brain?: unknown; inputMode?: unknown } = {}
  try {
    body = (await request.json()) as { brain?: unknown; inputMode?: unknown }
  } catch {
    return NextResponse.json({ error: 'Body phải là JSON { brain }' }, { status: 400 })
  }

  const brain = typeof body.brain === 'string' ? body.brain : ''
  if (!BRAIN_TRAINABLE_KEYS.includes(brain as never)) {
    return NextResponse.json(
      {
        error: `Brain '${brain || '(trống)'}' chưa có pipeline train — hỗ trợ: ${BRAIN_TRAINABLE_KEYS.join(', ')} (Brain-C chờ P4)`,
        supported: BRAIN_TRAINABLE_KEYS,
      },
      { status: 400 },
    )
  }

  try {
    if (brain === 'calibration_v3') {
      // ── Brain-A "V3" (BRAIN-P2) — CV so V2 đối chứng ──
      const inputMode = typeof body.inputMode === 'string' ? body.inputMode : V3_INPUT_MODE
      const result = await trainBrainCalibrationV3(inputMode)
      if (!result.trained) {
        return NextResponse.json(
          {
            error: result.error || 'insufficient data to train Brain-A V3',
            brain,
            usable: result.usable,
            need: MIN_TRAIN_SAMPLES_V3,
          },
          { status: 400 },
        )
      }
      return NextResponse.json({
        trained: true,
        brain,
        version: result.version,
        active: result.active,
        improved: result.improved,
        cvBrier: result.cvBrier,
        cvBrierCi: result.cvBrierCi,
        brierV2: result.brierV2,
        sampleSize: result.sampleSize,
        usable: result.usable,
        total: result.total,
      })
    }

    // ── Brain-C "Lệnh" policy head (BRAIN-P4) — CV mixture so π_Q ──
    if (brain === 'policy') {
      const inputMode = typeof body.inputMode === 'string' ? body.inputMode : POLICY_INPUT_MODE
      const result = await trainBrainPolicy(inputMode)
      if (!result.trained) {
        // Thiếu mẫu / thiếu Q / thiếu verdict / lệch lớp / mode chưa hỗ trợ /
        // trùng nhịp A7 — ngủ an toàn, không ghi DB
        return NextResponse.json(
          {
            error: result.error || 'insufficient data to train Brain-C policy',
            brain,
            usable: result.usable,
            need: POLICY_MIN_TRAIN_SAMPLES,
            qEntries: result.qEntries,
            verdicts: result.verdicts,
          },
          { status: 400 },
        )
      }
      return NextResponse.json({
        trained: true,
        brain,
        version: result.version,
        active: result.active,
        improved: result.improved,
        sampleSize: result.sampleSize,
        usable: result.usable,
        total: result.total,
        qEntries: result.qEntries,
        verdicts: result.verdicts,
        cv: result.cv
          ? {
              ceMixture: result.cv.cvCeMixture,
              ceMixtureCi: [result.cv.cvCeMixtureCiLo, result.cv.cvCeMixtureCiHi],
              ceBaselineQ: result.cv.ceBaseline,
              improved: result.cv.improved,
              folds: result.cv.folds,
            }
          : null,
      })
    }

    // ── Brain-B "Vọng" surrogate (BRAIN-P3) — CV so baseline từng đầu ──
    const inputMode = typeof body.inputMode === 'string' ? body.inputMode : SURROGATE_INPUT_MODE
    const result = await trainBrainSurrogate(inputMode)
    if (!result.trained) {
      // Thiếu mẫu / lệch lớp / mode chưa hỗ trợ / trùng nhịp A7 — ngủ an
      // toàn, không ghi DB
      return NextResponse.json(
        {
          error: result.error || 'insufficient data to train Brain-B surrogate',
          brain,
          usable: result.usable,
          need: SURROGATE_MIN_TRAIN_SAMPLES,
        },
        { status: 400 },
      )
    }
    return NextResponse.json({
      trained: true,
      brain,
      version: result.version,
      active: result.active,
      improved: result.improved,
      sampleSize: result.sampleSize,
      usable: result.usable,
      total: result.total,
      heads: {
        success: {
          cvBrier: result.heads?.success.cvBrier,
          brierBaseline: result.heads?.success.brierBaseline,
          improved: result.heads?.success.improved,
          auc: result.heads?.success.auc,
        },
        tokens: {
          cvMaeLog: result.heads?.tokens.cvMae,
          maeBaselineLog: result.heads?.tokens.maeBaseline,
          improved: result.heads?.tokens.improved,
        },
        durationMs: {
          cvMaeLog: result.heads?.durationMs.cvMae,
          maeBaselineLog: result.heads?.durationMs.maeBaseline,
          improved: result.heads?.durationMs.improved,
        },
      },
    })
  } catch (err) {
    console.error('[BrainTrain] POST failed:', err instanceof Error ? err.message : String(err))
    return NextResponse.json(
      {
        error: `Train ${brain} thất bại (runtime giữ nguyên — fail-open)`,
        details: err instanceof Error ? err.message : String(err),
      },
      { status: 500 },
    )
  }
}
