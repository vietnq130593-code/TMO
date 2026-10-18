/**
 * BRAIN TRAIN API — POST /api/brain/train (BRAIN-P2 + BRAIN-P3, blueprint §4.2/§4.3)
 * ======================================================================
 *
 * Trigger train THEO CHỈ THỊ (nút "Huấn luyện lại" panel Não vận hành +
 * auto-retrain: Brain-A sau eval run ở src/lib/eval/runner.ts · Brain-B
 * sau agent run ở src/lib/agent-goal-loop.ts) — KHÔNG tự train trong
 * request path của runtime (đúng kỷ luật blueprint §4.2).
 *
 * Body: { brain: 'calibration_v3' | 'surrogate', inputMode?, force? }
 * (BRAIN_TRAINABLE_KEYS; inputMode mặc định theo từng brain — mode vector chờ
 * Q2).
 *
 * R7 — FORCE (chỉ thị user 2026-10-31 "không muốn bản nháp, muốn hiệu lực
 * thật"): body.force=true → bản train trở thành ACTIVE NGAY cả khi không
 * thắng đối chứng CV, VÀ cờ runtime của brain (calibration_v3 / replay_eval
 * / runtime_policy) tự bật ON (setTuningValue — audit vào change log) để
 * model thật sự VẬN HÀNH trong chuỗi runtime ngay sau train. Metrics CV vẫn
 * tính + trả đầy đủ (minh bạch chất lượng); trainMeta.appliedBy='user-force'.
 * Đường auto-retrain (eval runner / agent-goal-loop) KHÔNG truyền force.
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
import { db } from '@/lib/db'
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
import {
  BRAIN_DRAFT_RULES,
  downsampleHistory,
  validateBrainDraft,
  type BrainDraftSpec,
} from '@/lib/brain/spec-schema'
import type { BrainKey } from '@/lib/brain/registry'
// OBS-V3 H4 (R34) — proposal.apply khi kiến trúc trở thành ACTIVE
import { observeEvent } from '@/lib/observation/ledger'

export const dynamic = 'force-dynamic'

/**
 * BRAIN-UX §9.2 — đọc bản nháp khi body có useDraft=true. Trả về
 * { override } hợp lệ hoặc { error, status } cho route trả thẳng. Draft
 * vẫn đi ĐẦY ĐỦ cổng train → CV → thăng cấp (bất biến A1 — §9.1-1: KHÔNG
 * có đường tắt "vẽ xong chạy ngay").
 */
async function loadDraftOverride(
  brain: string,
  useDraft: boolean,
): Promise<{ override?: BrainDraftSpec; error?: string; status?: number }> {
  if (!useDraft) return {}
  try {
    const row = await db.brainSpecDraft.findUnique({ where: { brain } })
    if (!row) {
      return {
        error: `useDraft=true nhưng chưa có bản nháp cho brain '${brain}' — lưu nháp ở Brain Studio (UX-1) trước`,
        status: 400,
      }
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(row.specJson)
    } catch {
      return { error: `Bản nháp '${brain}' hỏng JSON (specJson không parse được) — lưu lại nháp để sửa`, status: 400 }
    }
    const rule = BRAIN_DRAFT_RULES[brain as BrainKey]
    // inputDim cho trần tham số: dùng khóa A=10; B/C động → null (điểm
    // chặn thật là mlp.validateSpec lúc dựng MLP trong pipeline)
    const validation = validateBrainDraft({ ...(parsed as object), brain }, rule?.inputUnits ?? null)
    if (!validation.ok) {
      return { error: `Bản nháp '${brain}' không hợp lệ: ${validation.errors.join('; ')}`, status: 400 }
    }
    return { override: validation.normalized }
  } catch (err) {
    return {
      error: `Đọc bản nháp '${brain}' thất bại: ${err instanceof Error ? err.message : String(err)}`,
      status: 500,
    }
  }
}

export async function POST(request: Request) {
  let body: { brain?: unknown; inputMode?: unknown; useDraft?: unknown; force?: unknown; origin?: unknown; searchRunId?: unknown } = {}
  try {
    body = (await request.json()) as { brain?: unknown; inputMode?: unknown; useDraft?: unknown; force?: unknown; origin?: unknown; searchRunId?: unknown }
  } catch {
    return NextResponse.json({ error: 'Body phải là JSON { brain }' }, { status: 400 })
  }

  const brain = typeof body.brain === 'string' ? body.brain : ''
  if (!BRAIN_TRAINABLE_KEYS.includes(brain as never)) {
    return NextResponse.json(
      {
        error: `Brain '${brain || '(trống)'}' chưa có pipeline train — hỗ trợ: ${BRAIN_TRAINABLE_KEYS.join(', ')}`,
        supported: BRAIN_TRAINABLE_KEYS,
      },
      { status: 400 },
    )
  }

  // OBS-V3 H4 (BLUEPRINT-OBSERVATION-V3 §C.1 — R34): origin tùy chọn từ client
  // (whitelist 'evo-deploy' — deployEvoArchitecture truyền qua saveDraft/train)
  // — chỉ để GHI NHÃN nguồn vào sự kiện proposal.apply, không đổi hành vi.
  const origin = body.origin === 'evo-deploy' ? ('evo-deploy' as const) : undefined

  // FB-OBSV3-R1-02 (R35 fixbug): searchRunId — id BrainSearchRun của session
  // EVO sinh ra kiến trúc (evolve-tab thread qua chuỗi deploy → nháp → train).
  // Ghi chú H4 0.2: KHÔNG đè evt.runId (FK là kim tuyến AgentRunRecord) —
  // runId EVO nằm trong rowKey + payload, tiền lệ 31-e (search.*).
  const searchRunId =
    typeof body.searchRunId === 'string' && body.searchRunId.length > 0 && body.searchRunId.length <= 64
      ? body.searchRunId
      : undefined

  // R7 — force: hiệu chỉnh chủ đích (user/agents qua tab BRAIN) áp dụng THẬT
  const force = body.force === true
  // R7 — bật cờ runtime tương ứng khi force (để model active THẬT SỰ vận hành
  // trong chuỗi runtime, không chỉ nằm DB). Fail-open: lỗi cờ → vẫn trả kết
  // quả train + flagOn:false (client hiển thị hướng dẫn bật tay).
  const flagKeyByBrain: Record<string, string> = {
    calibration_v3: 'calibration_v3',
    surrogate: 'replay_eval',
    policy: 'runtime_policy',
  }
  const ensureFlagOn = async (): Promise<boolean> => {
    if (!force) return false
    const key = flagKeyByBrain[brain]
    if (!key) return false
    try {
      const { setTuningValue } = await import('@/lib/learning/tuning-store')
      await setTuningValue(key, 'on')
      return true
    } catch (err) {
      console.warn(`[BrainTrain] bật cờ ${key} thất bại (fail-open — model active nhưng cờ giữ nguyên):`, err instanceof Error ? err.message : String(err))
      return false
    }
  }

  // BRAIN-UX §9.3 — nút Huấn luyện của Training Console gửi useDraft=true
  // để train theo bản nháp (đã validate lại ở server — không tin client)
  const draftLoad = await loadDraftOverride(brain, body.useDraft === true)
  if (draftLoad.error) {
    return NextResponse.json({ error: draftLoad.error }, { status: draftLoad.status ?? 400 })
  }
  const override = draftLoad.override

  /**
   * OBS-V3 H4 (R34) — phát `proposal.apply` khi một KIẾN TRÚC ĐỀ XUẤT trở
   * THÀNH ACTIVE qua đường route này. FB-OBSV3-R1-01 (R35 fixbug, về đúng
   * spec §C.1 "result.active && useDraft"): CHỈ phát khi train THEO BẢN NHÁP
   * (override != null ⟺ useDraft=true + draft hợp lệ) — retrain weights
   * thường không draft KHÔNG phải "áp dụng đề xuất kiến trúc" (đó là
   * brain.train end của observeBrainTrain); tránh ô nhiễm neo impact P7
   * (pass 2 chỉ chấm origin 'evo-deploy' — xem impact.ts). Đường
   * auto-retrain trong lib không qua route — không lặp. Fail-open tuyệt đối.
   */
  const emitProposalApply = (
    result: { version: number | null; active: boolean; improved: boolean; forced?: boolean },
    ctx: { inputMode: string; score?: string },
  ): void => {
    try {
      if (!result.active || !override) return
      const archSummary = override.hidden.length
        ? override.hidden.map(h => `${h.units}·${h.activation}`).join(' → ')
        : null
      observeEvent({
        actor: 'user',
        kind: 'proposal.apply',
        table: 'BrainModel',
        rowKey: `${brain}#v${result.version ?? '?'}${searchRunId ? `@${searchRunId}` : ''}`,
        summary:
          `ÁP DỤNG kiến trúc ${brain} v${result.version} ACTIVE` +
          `${result.improved ? ' (thắng CV)' : ' (theo chỉ định — CV chưa thắng)'}` +
          `${archSummary ? ` · ${archSummary}` : ''}` +
          `${origin ? ' · nguồn EVO' : ''}`,
        payload: {
          brain,
          version: result.version,
          active: true,
          improved: result.improved,
          forced: result.forced === true,
          inputMode: ctx.inputMode,
          useDraft: body.useDraft === true,
          origin: origin ?? 'editor',
          ...(searchRunId ? { searchRunId } : {}),
          archSummary,
          ...(ctx.score ? { score: ctx.score } : {}),
        },
      })
    } catch { /* fail-open — quan sát không được làm hỏng train */ }
  }

  try {
    if (brain === 'calibration_v3') {
      // ── Brain-A "V3" (BRAIN-P2) — CV so V2 đối chứng ──
      const inputMode = typeof body.inputMode === 'string' ? body.inputMode : V3_INPUT_MODE
      const result = await trainBrainCalibrationV3(inputMode, override, { force })
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
      const flagOn = result.active ? await ensureFlagOn() : false
      emitProposalApply(result, {
        inputMode,
        score: result.cvBrier != null ? `cvBrier ${result.cvBrier.toFixed(4)} vs V2 ${result.brierV2?.toFixed(4) ?? '—'}` : undefined,
      })
      return NextResponse.json({
        trained: true,
        brain,
        version: result.version,
        active: result.active,
        improved: result.improved,
        forced: result.forced || undefined,
        flagOn: flagOn || undefined,
        cvBrier: result.cvBrier,
        cvBrierCi: result.cvBrierCi,
        brierV2: result.brierV2,
        sampleSize: result.sampleSize,
        usable: result.usable,
        total: result.total,
        history: result.history ? downsampleHistory(result.history, 200) : undefined,
        gradAbsMean: result.gradAbsMean,
        draftUsed: result.draftUsed,
      })
    }

    // ── Brain-C "Lệnh" policy head (BRAIN-P4) — CV mixture so π_Q ──
    if (brain === 'policy') {
      const inputMode = typeof body.inputMode === 'string' ? body.inputMode : POLICY_INPUT_MODE
      const result = await trainBrainPolicy(inputMode, override, { force })
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
      const flagOn = result.active ? await ensureFlagOn() : false
      emitProposalApply(result, {
        inputMode,
        score: result.cv ? `CE mixture ${result.cv.cvCeMixture?.toFixed(4) ?? '—'} vs π_Q ${result.cv.ceBaseline?.toFixed(4) ?? '—'}` : undefined,
      })
      return NextResponse.json({
        trained: true,
        brain,
        version: result.version,
        active: result.active,
        improved: result.improved,
        forced: result.forced || undefined,
        flagOn: flagOn || undefined,
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
        history: result.history ? downsampleHistory(result.history, 200) : undefined,
        gradAbsMean: result.gradAbsMean,
        draftUsed: result.draftUsed,
      })
    }

    // ── Brain-B "Vọng" surrogate (BRAIN-P3) — CV so baseline từng đầu ──
    const inputMode = typeof body.inputMode === 'string' ? body.inputMode : SURROGATE_INPUT_MODE
    const result = await trainBrainSurrogate(inputMode, override, { force })
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
    const flagOn = result.active ? await ensureFlagOn() : false
    emitProposalApply(result, {
      inputMode,
      score: result.heads?.success ? `Brier ${result.heads.success.cvBrier?.toFixed(4) ?? '—'} vs base ${result.heads.success.brierBaseline?.toFixed(4) ?? '—'}` : undefined,
    })
    return NextResponse.json({
      trained: true,
      brain,
      version: result.version,
      active: result.active,
      improved: result.improved,
      forced: result.forced || undefined,
      flagOn: flagOn || undefined,
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
      history: result.history
        ? {
            success: downsampleHistory(result.history.success, 200),
            tokens: downsampleHistory(result.history.tokens, 200),
            durationMs: downsampleHistory(result.history.durationMs, 200),
          }
        : undefined,
      gradAbsMean: result.gradAbsMean,
      draftUsed: result.draftUsed,
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
