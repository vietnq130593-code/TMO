/**
 * BRAIN TRAIN API — POST /api/brain/train (BRAIN-P2, blueprint §4.2)
 * ======================================================================
 *
 * Trigger train THEO CHỈ THỊ (nút "Huấn luyện lại" panel Não vận hành +
 * auto-retrain sau eval run ở src/lib/eval/runner.ts) — KHÔNG tự train
 * trong request path của runtime (đúng kỷ luật blueprint §4.2).
 *
 * Body: { brain: 'calibration_v3' } (duy nhất phase này — BRAIN_TRAINABLE_
 * KEYS; inputMode mặc định 'features-10', mode vector chờ Q2).
 *
 * Hành vi (kế thừa nguyên vẹn pattern POST /api/eval/calibration):
 *   - brain lạ/chưa có pipeline → 400 (liệt kê các brain đã hỗ trợ)
 *   - thiếu mẫu (< 30 usable) / lệch lớp → 400 { error, usable, need } —
 *     KHÔNG ghi DB gì cả (ngủ an toàn)
 *   - train xong → 200 { trained, version, active, cvBrier vs brierV2,
 *     improved, sampleSize } — active=true CHỈ khi thắng V2 qua 5-fold CV
 *     Brier (ngặt); thua vẫn ghi bản vết audit active=false.
 *
 * Fail-open 2 chiều: lỗi hệ thống (DB...) → 500 nhưng KHÔNG bao giờ làm
 * hỏng trạng thái runtime hiện có (chuỗi V3→V2→V1 tự giữ).
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

export const dynamic = 'force-dynamic'

export async function POST(request: Request) {
  let body: { brain?: unknown; inputMode?: unknown } = {}
  try {
    body = (await request.json()) as { brain?: unknown; inputMode?: unknown }
  } catch {
    return NextResponse.json({ error: 'Body phải là JSON { brain }' }, { status: 400 })
  }

  const brain = typeof body.brain === 'string' ? body.brain : ''
  if (brain !== 'calibration_v3') {
    return NextResponse.json(
      {
        error: `Brain '${brain || '(trống)'}' chưa có pipeline train — BRAIN-P2 chỉ hỗ trợ: ${BRAIN_TRAINABLE_KEYS.join(', ')} (Brain-B/C chờ P3/P4)`,
        supported: BRAIN_TRAINABLE_KEYS,
      },
      { status: 400 },
    )
  }
  const inputMode = typeof body.inputMode === 'string' ? body.inputMode : V3_INPUT_MODE

  try {
    const result = await trainBrainCalibrationV3(inputMode)
    if (!result.trained) {
      // Thiếu mẫu / lệch lớp / mode chưa hỗ trợ — ngủ an toàn, không ghi DB
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
  } catch (err) {
    console.error('[BrainTrain] POST failed:', err instanceof Error ? err.message : String(err))
    return NextResponse.json(
      {
        error: 'Train Brain-A V3 thất bại (runtime giữ nguyên chuỗi cũ — fail-open)',
        details: err instanceof Error ? err.message : String(err),
      },
      { status: 500 },
    )
  }
}
