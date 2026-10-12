/**
 * BRAIN POLICY REPORT API — GET /api/brain/policy (BRAIN-P4, blueprint §4.4)
 * ======================================================================
 *
 * Báo cáo READ-ONLY của Brain-C "Lệnh" — bề mặt quan sát cho Q1 (composite
 * reward LOG-ONLY — user chốt 2026-10-12):
 *   - flag     : trạng thái cờ master runtime_policy + 3 cờ organ kill-switch
 *                (STORE > ENV > DEFAULT=off — tuning store)
 *   - active   : bản BrainModel active (version/nSamples/successRate/λ
 *                phân rã/CV) — null khi não ngủ
 *   - reward   : trọng số đang dùng + sweep trạng thái + LOG-ONLY các mẫu
 *                reward gần đây (tính lại từ ledger — không lưu bảng nào)
 *   - proposals: đề xuất tham số của organ-3 (chỉ khi policy_organ_tuning
 *                on — kill-switch; KHÔNG tự ghi TuningParam/TuningChangeLog)
 *
 * READ-ONLY TUYỆT ĐỐI (r87 pin count): chỉ count/findMany — không ghi bảng
 * nào kể cả khi flag on. Composite reward là log-only đúng Q1: đợt quan sát
 * bắt đầu từ blueprint v0.9; report này chính là bằng chứng 2 đợt quan sát.
 */

import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import {
  isRuntimePolicyEnabled,
  isPolicyOrganEnabled,
  loadActivePolicy,
  buildTuningProposals,
  POLICY_LAMBDA_K,
  POLICY_REPLICATE_SCALE,
  POLICY_MIN_TRAIN_SAMPLES,
  POLICY_MIN_Q_ENTRIES,
  POLICY_MIN_VERDICTS,
  POLICY_INPUT_MODE,
  type PolicyOrgan,
} from '@/lib/brain/brains/policy'
import {
  REWARD_WEIGHTS,
  collectRewardLedger,
  computeRunReward,
  outcomeFromEvidence,
  sweepRewardWeights,
  type SweepSample,
} from '@/lib/brain/reward'
import { getTuningEnum } from '@/lib/learning/tuning-store'

export const dynamic = 'force-dynamic'

/** Số mẫu reward log-only gần nhất hiển thị trong report. */
const RECENT_REWARD_SAMPLES = 10

export async function GET() {
  try {
    // ── Cờ + organ (đọc rẻ qua tuning-store snapshot) ──
    const organs: Record<PolicyOrgan, 'on' | 'off'> = {
      routing: isPolicyOrganEnabled('routing') ? 'on' : 'off',
      adaptation: isPolicyOrganEnabled('adaptation') ? 'on' : 'off',
      tuning: isPolicyOrganEnabled('tuning') ? 'on' : 'off',
    }
    // FB-BRAIN-P4-R1-11: bỏ field envFallback — bản trước tính bằng CÙNG biểu
    // thức value (getTuningEnum đã gộp chuỗi STORE>ENV>DEFAULT) nên luôn bằng
    // value → computation thừa + gây hiểu lầm "có tách tầng ENV".
    const flag = {
      key: 'runtime_policy',
      value: (isRuntimePolicyEnabled() ? 'on' : 'off') as 'on' | 'off',
      organs,
    }

    // ── Bản active (1 findFirst trên index [brain, active]) ──
    const activeModel = await loadActivePolicy()
    const active = activeModel
      ? {
          version: activeModel.version,
          nSamples: activeModel.nSamples,
          successRate: activeModel.successRate,
          inputMode: POLICY_INPUT_MODE,
          lambda: {
            value: activeModel.lambda,
            formula: `1 − min(clamp(n/${POLICY_LAMBDA_K}, 0, 1), wilsonLB(p̂, n))`,
            netShare: 1 - activeModel.lambda,
          },
          cv: {
            ceMixture: activeModel.cv.cvCeMixture,
            ceBaselineQ: activeModel.cv.ceBaseline,
          },
          actionVocab: activeModel.actionVocab.models,
        }
      : null

    // ── Reward LOG-ONLY: tính lại từ ledger (READ-ONLY — không bảng lưu) ──
    const { rows, verdicts, baselines } = await collectRewardLedger(2000)
    const recent = rows.slice(-RECENT_REWARD_SAMPLES).map(r => {
      const tally = verdicts.get(r.sessionId) ?? null
      const result = computeRunReward(r, tally, baselines)
      return {
        runId: r.runId,
        model: r.model,
        agent: r.agentName,
        reward: result ? result.reward : null,
        components: result
          ? {
              outcome: result.components.outcome,
              efficiency: result.components.efficiency,
              quality: result.components.quality,
            }
          : null,
        createdAt: r.createdAt.toISOString(),
      }
    })
    // Outcome* nhất quán với khối `recent` (outcomeFromEvidence — verdict-aware)
    // — FB-BRAIN-P4-R1-04: bản trước dùng r.complete thô → 1 run refuted-complete
    // hiện 2 giá trị Outcome* khác nhau trong cùng 1 report.
    const sweepSamples: SweepSample[] = rows.map(r => {
      const result = computeRunReward(r, verdicts.get(r.sessionId) ?? null, baselines)
      return {
        model: r.model,
        outcome: outcomeFromEvidence(r.complete === 1, verdicts.get(r.sessionId) ?? null),
        efficiency: result ? result.components.efficiency : null,
        quality: null,
      }
    })
    const sweep = sweepRewardWeights(sweepSamples)
    const reward = {
      mode: 'log-only' as const,
      observationStartedAt: 'blueprint v0.9 (2026-10-12) — đợt quan sát 1 của 2 (Q1 user chốt)',
      weights: REWARD_WEIGHTS,
      replicateScale: POLICY_REPLICATE_SCALE,
      ledger: {
        usableRuns: rows.length,
        verdictSessions: verdicts.size,
        baselinedModels: baselines.size,
      },
      sweep: {
        feasible: sweep.feasible,
        weights: sweep.weights,
        reason: sweep.reason,
        nModels: sweep.nModels,
        correlation: Number.isFinite(sweep.correlation) ? sweep.correlation : null,
      },
      recent,
    }

    // ── Organ-3 proposals (kill-switch — [] khi organ off) ──
    const proposals = await buildTuningProposals()

    // ── Ngưỡng thức tỉnh (đếm thật — cùng nguồn /api/brain) ──
    const [qEntries, verdictCount] = await Promise.all([
      db.qEntry.count().catch(() => null),
      db.arbiterVerdict.count().catch(() => null),
    ])
    const thresholds = {
      usableRuns: { current: rows.length, min: POLICY_MIN_TRAIN_SAMPLES },
      qEntries: { current: qEntries, min: POLICY_MIN_Q_ENTRIES },
      verdicts: { current: verdictCount, min: POLICY_MIN_VERDICTS },
    }

    return NextResponse.json({
      flag,
      active,
      reward,
      proposals,
      thresholds,
      disclaimer:
        'READ-ONLY — report không ghi bảng nào. Composite reward LOG-ONLY (Q1 chốt: 2 đợt quan sát trước khi tham gia quyết định — updateQ giữ nhị phân ±1). Proposals organ-3 chỉ là ĐỀ XUẤT — người duyệt là user qua UI tuning.',
      generatedAt: new Date().toISOString(),
    })
  } catch (err) {
    return NextResponse.json(
      {
        error: 'Brain policy report thất bại (fail-open — runtime giữ nguyên)',
        details: err instanceof Error ? err.message : String(err),
      },
      { status: 500 },
    )
  }
}
