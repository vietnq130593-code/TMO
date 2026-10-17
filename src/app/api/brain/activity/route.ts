/**
 * BRAIN-LIVE — ACTIVITY API (GET /api/brain/activity) — READ-ONLY
 * ============================================================================
 *
 * Đài quan sát tab BRAIN (module Smolab — chỉ thị user 2026-10-12): vector
 * đặc trưng THẬT + activation từng lớp của brain đang chọn, tính từ run/eval
 * GẦN NHẤT trong DB (điểm sáng nơ-ron theo dữ liệu thật khi agent vận hành):
 *   ?brain=calibration_v3|surrogate|policy (bắt buộc)
 *   &head=success|tokens|durationMs (chỉ surrogate — mặc định 'success')
 *
 * Nguồn dữ liệu thật cho từng brain (KHÔNG mô phỏng):
 *   - calibration_v3: EvalResult gần nhất (+ join EvalCase difficulty/
 *     category — ĐÚNG mapping trainBrainCalibrationV3Locked, calibration-v3.ts
 *     ~dòng 374-386) → 10 đặc trưng thô → chuẩn hóa (x−mean)/std bằng
 *     means/stds của bản active. KHI DORMANT inputVector = null — QUYẾT ĐỊNH
 *     trung thực: stats chuẩn hóa nằm trong trainMeta của bản active, chưa
 *     có bản active thì không thể chuẩn hóa đúng scale input layer thật
 *     (trả feature thô sẽ sai lệch); sourceLabel vẫn trả.
 *   - surrogate: AgentRunRecord gần nhất → ctx {model, agent, delegated} →
 *     one-hot theo vocab. KHI ACTIVE: vocab + chuẩn hóa từ bản active
 *     (loadActiveSurrogate). KHI DORMANT: vocab dựng lại từ AgentRunRecord
 *     usable — ĐÚNG filter pipeline train (trainBrainSurrogateLocked) —
 *     inputVector = one-hot THÔ 0/1 (giá trị thật, chỉ chưa chuẩn hóa vì
 *     không có means/stds).
 *   - policy: tương tự surrogate — ctx {agent, delegated}; vocab agents từ
 *     bản active, hoặc từ ledger usable khi dormant (filter ĐÚNG
 *     collectRewardLedger — reward.ts).
 *
 * Task 26-BE (đài quan sát v2 — hợp đồng API chốt 26-RESTORE) THÊM 2 field:
 *   - training: snapshot từ train-progress bus (in-memory) — lượt train GẦN
 *     NHẤT/đang chạy của MỌI nguồn (nút train UI + auto-retrain), kể cả
 *     brain khác brain đang xem (FE tự so khớp); null khi bus trống.
 *   - backprop: gradient THẬT của 1 MẪU THẬT — mẫu nguồn gần nhất (CHÍNH
 *     mẫu đã dựng inputVector) — qua bản active HIỆN TẠI:
 *       · deltas[k][j] = δ nơ-ron j lớp activations[k+1] — lấy từ
 *         MLP.backward(x, yTrue).db (mlp.ts — δ lớp k chính là db[k]); FE
 *         tính per-edge = |deltas[c][j] × activations[c][i]|.
 *       · yTrue = nhãn THẬT của mẫu nguồn, đúng transform pipeline train:
 *         - calibration_v3: y = [answered ? 1 : 0] từ cùng EvalResult (schema
 *           EvalResult.answered Boolean).
 *         - surrogate/success: y = [complete ? 1 : 0]; surrogate/tokens &
 *           durationMs: y = (log1p(giá trị) − mean)/std theo ĐÚNG
 *           targetStats bản active (surrogate.ts:666-673 — toLogSpace +
 *           chuẩn hóa; loadActiveSurrogate đã expose targetStats).
 *         - policy: KHÔNG có nhãn thật cho 1 run riêng lẻ (y là phân phối
 *           mixture chỉ build được từ reward ledger lúc train) → deltas/
 *           yTrue/loss null + label giải thích — TRUNG THỰC, không mô phỏng.
 *       · loss = lossOf(x, yTrue) qua bản active.
 *     CHỈ tính khi status === 'active' và có inputVector ĐÃ CHUẨN HÓA và có
 *     nhãn thật của mẫu đó; thiếu 1 điều kiện → backprop=null hoặc object
 *     null-số + label giải thích. GHI CHÚ TRUNG THỰC: đây là gradient của
 *     MẪU GẦN NHẤT tính trên weights HIỆN TẠI — KHÔNG phải gradient của lượt
 *     train lịch sử (khi training.status === 'running' FE dùng để boost hiển
 *     thị — hạt vàng — chứ đây vẫn là gradient 1 mẫu thật, không phải luồng
 *     gradient của lượt train đang chạy).
 *     Perf: 1 pass forward+backward cho 1 mẫu — không đáng kể; bọc try/catch
 *     fail-open (lỗi → backprop null + message trong `errors`).
 *
 * Fail-open tuyệt đối: mọi nhánh đọc DB bọc try/catch — thiếu dữ liệu →
 * field null + `error` message, response vẫn 200 (tab quan sát không bao
 * giờ trắng trang vì thiếu dữ liệu). 400 CHỈ cho query rác (brain/head).
 *
 * READ-ONLY TUYỆT ĐỐI: chỉ count/findFirst/findMany/findUnique — KHÔNG
 * create/update/delete, KHÔNG đụng runtime/tuning/BrainModel.active.
 * Backprop chạy thuần trong RAM trên MLP đã nạp — KHÔNG ghi DB gì cả.
 */

import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { BRAIN_REGISTRY } from '@/lib/brain/registry'
import { loadActiveV3 } from '@/lib/brain/calibration-v3'
import {
  FEATURE_NAMES,
  buildFeatureVector,
  type FeatureCtx,
} from '@/lib/calibration-multifeature'
import {
  loadActiveSurrogate,
  buildSurrogateVocab,
  buildSurrogateFeatureRow,
  surrogateFeatureNames,
  toLogSpace,
  type ActiveSurrogate,
  type SurrogateFeatureCtx,
  type SurrogateVocab,
} from '@/lib/brain/brains/surrogate'
import {
  loadActivePolicy,
  buildPolicyVocab,
  buildPolicyFeatureRow,
  policyFeatureNames,
  type PolicyFeatureCtx,
  type PolicyVocab,
} from '@/lib/brain/brains/policy'
import { trainProgressSnapshot } from '@/lib/brain/train-progress'
import type { MLP } from '@/lib/brain/mlp'

export const dynamic = 'force-dynamic'

const BRAIN_KEYS: readonly string[] = BRAIN_REGISTRY.map(b => b.key)
const SURROGATE_HEADS = ['success', 'tokens', 'durationMs'] as const
type SurrogateHead = (typeof SURROGATE_HEADS)[number]

// ==================== FB-BRAIN-LIVE-R1-04 — CACHE VOCAB DORMANT (TTL 60s) ====================
// Trước-fix: mỗi poll 2.5s/client, nhánh dormant surrogate+policy chạy
// findMany take-5000 (đọc tới 5000 row đủ cột) ×2 chỉ để dựng vocab one-hot
// — tải đọc lặp lại vô ích vì vocab gần như không đổi (chỉ đổi khi có
// run/model mới).
// QUYẾT ĐỊNH KỸ THUẬT — TTL cache thay vì SELECT DISTINCT:
//  · DISTINCT (prisma distinct: ['model']/['agentName']) KHÔNG giữ đúng
//    kết quả: vocab pipeline = distinct trong 5000 row ĐẦU theo createdAt
//    asc, SAU đó mới filter usable (trainBrainSurrogateLocked /
//    collectRewardLedger đều cap 5000) — SELECT DISTINCT quét TOÀN BỘ row
//    rồi mới giới hạn, khi >5000 row usable sẽ cho vocab KHÁC pipeline
//    train; filter usable (typeof/Number.isFinite) cũng phải đọc row trước.
//  · TTL cache giữ NGUYÊN đường query + filter cũ → kết quả giống hệt trên
//    cùng dữ liệu (đối chiếu r92 C3/C4 one-hot dựng từ builder thật), chỉ
//    bỏ việc LẶP: 1 query/60s thay vì 1 query/2.5s/client.
//  · Chấp nhận trễ ≤60s khi DB có run/model mới — đây là hiển thị quan sát
//    (one-hot để nhìn), KHÔNG đụng pipeline train/runtime; nhánh ACTIVE
//    đọc vocab từ bản active (specJson) nên không dính cache.
//  · Không cần invalidate khi train: bản active làm route rẽ nhánh ACTIVE
//    (không dùng cache); cache chỉ phục vụ nhánh dormant.
const VOCAB_CACHE_TTL_MS = 60_000
const dormantVocabCache = new Map<'surrogate' | 'policy', { at: number; vocab: unknown }>()

/** Đọc vocab dormant từ cache (còn hạn) — null = hết hạn/chưa có. */
function vocabCacheGet<T>(brain: 'surrogate' | 'policy'): T | null {
  const e = dormantVocabCache.get(brain)
  if (!e || Date.now() - e.at > VOCAB_CACHE_TTL_MS) return null
  return e.vocab as T
}

/** Ghi vocab dormant vào cache (kèm thời điểm now). */
function vocabCacheSet(brain: 'surrogate' | 'policy', vocab: unknown): void {
  dormantVocabCache.set(brain, { at: Date.now(), vocab })
}

/** Thông điệp lỗi ngắn gọn cho field `error` (fail-open — không bao giờ throw ra ngoài). */
function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** HH:MM giờ địa phương — gọn cho nhãn nguồn ('AgentRun · … · 12:34'). */
function hhmm(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}`
}

/** Rút gọn nhãn nguồn 60 ký tự (tên model/agent dài — giữ nhãn 1 dòng UI). */
function clipLabel(s: string): string {
  return s.length <= 60 ? s : `${s.slice(0, 57)}…`
}

/**
 * Chuẩn hóa hàng đặc trưng (x−mean)/std — null/không hữu hạn → 0 (= mean
 * tập train, impute trung bình). CÔNG THỨC DÙNG CHUNG 3 pipeline — copy
 * nguyên từ applyV3Model (calibration-v3.ts:623-625) / applySurrogateHead
 * (surrogate.ts:1034-1036) / applyPolicyMixture (policy.ts:961-963); các
 * hàm nguồn không export bước này nên đặt lại đây cùng công thức (means/
 * stds đã được loadActive* validate đúng D chiều + stds > 0 → không chia 0).
 */
function standardizeRow(row: readonly (number | null)[], means: number[], stds: number[]): number[] {
  return row.map((v, j) =>
    typeof v === 'number' && Number.isFinite(v) ? (v - means[j]) / stds[j] : 0,
  )
}

/** One-hot thô (0/1) — null an toàn cho JSON (builder trả (number|null)[] nhưng one-hot luôn number). */
function toPlainNumbers(row: readonly (number | null)[]): number[] {
  return row.map(v => (typeof v === 'number' && Number.isFinite(v) ? v : 0))
}

/** Run gần nhất (mọi status — chạy 'running' vẫn có ctx cfg biết ngay lúc spawn).
 * 26-BE: select THÊM complete/tokensUsed/durationMs — nhãn thật cho backprop
 * surrogate (đúng transform pipeline — xem JSDoc header); additive, read-only. */
async function latestRun() {
  return db.agentRunRecord.findFirst({
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    select: {
      model: true, agentName: true, parentRunId: true, createdAt: true,
      complete: true, tokensUsed: true, durationMs: true,
    },
  })
}

// ==================== 26-BE — BACKPROP (gradient THẬT 1 mẫu — xem JSDoc header) ====================

/** Shape hợp đồng 26-RESTORE — KHÔNG đổi tên key (FE đang code theo). */
interface BackpropInfo {
  /** δ theo lớp trọng số k = 0..L−2: deltas[k][j] = δ nơ-ron j lớp activations[k+1] */
  deltas: number[][] | null
  /** nhãn thật của mẫu nguồn (đúng transform pipeline — xem JSDoc) */
  yTrue: number[] | null
  /** loss mẫu thật qua bản active (lossOf) */
  loss: number | null
  /** nhãn nguồn mẫu + nhãn thật, vd 'AgentRun · 12:34 · complete=1' */
  label: string | null
}

/** backward + lossOf trên bản active cho 1 cặp (x, y) — Float64 → number[]. */
function finishBackprop(mlp: MLP, x: number[], y: number[], label: string): BackpropInfo {
  const grad = mlp.backward(x, y) // δ lớp k chính là grad.db[k] (mlp.ts)
  return {
    deltas: grad.db.map(d => Array.from(d)),
    yTrue: y,
    loss: mlp.lossOf(x, y),
    label,
  }
}

/** Chưa có nhãn thật → object null-số + label giải thích (trung thực — không mô phỏng). */
function noLabelBackprop(note: string): BackpropInfo {
  return { deltas: null, yTrue: null, loss: null, label: note }
}

/**
 * Backprop surrogate theo head — y ĐÚNG transform pipeline train
 * (surrogate.ts:664-673): success = [complete?1:0] · tokens/durationMs =
 * (toLogSpace(v) − mean)/std theo targetStats bản active (đã expose qua
 * loadActiveSurrogate — KHÔNG tái chế tạo công thức). Run chưa kết thúc
 * (complete/tokens/durationMs null) → null-số + label giải thích.
 */
function surrogateBackprop(
  active: ActiveSurrogate,
  head: SurrogateHead,
  run: { complete: boolean | null; tokensUsed: number | null; durationMs: number | null; createdAt: Date },
  x: number[],
): BackpropInfo {
  if (head === 'success') {
    if (typeof run.complete !== 'boolean') {
      return noLabelBackprop('chưa có nhãn thật cho mẫu gần nhất (run đang chạy — chưa có complete)')
    }
    const y = [run.complete ? 1 : 0]
    return finishBackprop(active.heads.success, x, y, `AgentRun · ${hhmm(run.createdAt)} · complete=${run.complete ? 1 : 0}`)
  }
  if (head === 'tokens') {
    if (typeof run.tokensUsed !== 'number' || !Number.isFinite(run.tokensUsed) || run.tokensUsed < 0) {
      return noLabelBackprop('chưa có nhãn thật cho mẫu gần nhất (run chưa có tokensUsed)')
    }
    // ĐÚNG pipeline: y = (log1p(tokens) − mean)/std theo targetStats bản active
    const t = toLogSpace(run.tokensUsed)
    const y = [(t - active.targetStats.tokens.mean) / active.targetStats.tokens.std]
    return finishBackprop(
      active.heads.tokens, x, y,
      `AgentRun · ${hhmm(run.createdAt)} · tokens=${run.tokensUsed} (log1p chuẩn hóa targetStats bản active)`,
    )
  }
  // head === 'durationMs'
  if (typeof run.durationMs !== 'number' || !Number.isFinite(run.durationMs) || run.durationMs < 0) {
    return noLabelBackprop('chưa có nhãn thật cho mẫu gần nhất (run chưa có durationMs)')
  }
  const t = toLogSpace(run.durationMs)
  const y = [(t - active.targetStats.durationMs.mean) / active.targetStats.durationMs.std]
  return finishBackprop(
    active.heads.durationMs, x, y,
    `AgentRun · ${hhmm(run.createdAt)} · durationMs=${run.durationMs} (log1p chuẩn hóa targetStats bản active)`,
  )
}

export async function GET(request: Request) {
  const url = new URL(request.url)
  const brain = url.searchParams.get('brain') ?? ''
  if (!BRAIN_KEYS.includes(brain)) {
    return NextResponse.json(
      { ok: false, error: `brain '${brain || '(trống)'}' không hợp lệ (${BRAIN_KEYS.join(' | ')})` },
      { status: 400 },
    )
  }
  const headParam = url.searchParams.get('head') ?? 'success'
  if (brain === 'surrogate' && !SURROGATE_HEADS.includes(headParam as SurrogateHead)) {
    return NextResponse.json(
      { ok: false, error: `head '${headParam}' không hợp lệ cho surrogate (${SURROGATE_HEADS.join(' | ')})` },
      { status: 400 },
    )
  }
  const head = headParam as SurrogateHead

  const errors: string[] = []
  let agentRunInProgress = false
  let status: 'active' | 'dormant' = 'dormant'
  let inputVector: number[] | null = null
  let activations: number[][] | null = null
  let featureNames: string[] | null = null
  let sourceLabel: string | null = null
  // 26-BE: 2 field mới (hợp đồng 26-RESTORE) — xem JSDoc header
  let backprop: BackpropInfo | null = null
  // training = snapshot bus — MỌI nguồn train (nút UI + auto-retrain), kể cả
  // brain khác brain đang xem (FE tự so khớp); bus trống/quá 30 phút → null.
  // Bus fail-open nội bộ (không bao giờ throw) — gọi trực tiếp an toàn.
  const training = trainProgressSnapshot()

  // (a) Có AgentRunRecord status='running' đang chạy không (toàn cục — fail-open false)
  try {
    agentRunInProgress = (await db.agentRunRecord.count({ where: { status: 'running' } })) > 0
  } catch (err) {
    errors.push(`agentRunInProgress: ${errMsg(err)}`)
  }

  // R24-b §8.5 (mốc a ghost UI): Brain-D "Tri Thức" CHƯA có model/hoạt động
  // thật tới D3 — trả trung thực dormant + field null (không giả tín hiệu,
  // nguyên tắc THẬT của đài). Ghost topology render 100% từ registry ở
  // client (planned.layers — precedent A/B/C dormant); chip Agent toàn cục
  // + snapshot training vẫn sống để đài hiển thị trạng thái vận hành chung.
  if (brain === 'knowledge') {
    return NextResponse.json({
      ok: true,
      brain,
      head: null,
      status: 'dormant' as const,
      agentRunInProgress,
      inputVector: null,
      activations: null,
      featureNames: null,
      sourceLabel: null,
      fetchedAt: new Date().toISOString(),
      backprop: null,
      training,
      ...(errors.length > 0 ? { error: errors.join('; ') } : {}),
    })
  }

  if (brain === 'calibration_v3') {
    // Bản active (loadActiveV3 fail-open nội bộ — mọi lỗi nạp → null → dormant)
    const active = await loadActiveV3()
    status = active ? 'active' : 'dormant'

    try {
      const r = await db.evalResult.findFirst({
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        select: {
          caseId: true,
          rawConfidence: true,
          coverage: true,
          answered: true,
          retrievedChunks: true,
          extractionF1: true,
          hallucinationDetected: true,
          createdAt: true,
        },
      })
      if (r) {
        sourceLabel = clipLabel(`EvalResult · ${hhmm(r.createdAt)}`)
        const evalCase = await db.evalCase.findUnique({
          where: { id: r.caseId },
          select: { difficulty: true, category: true },
        })
        // Mapping EvalResult → Partial<FeatureCtx> — copy ĐÚNG
        // trainBrainCalibrationV3Locked (calibration-v3.ts:374-386): 6 trường
        // trực tiếp từ EvalResult + difficulty/category từ EvalCase join.
        const ctx: Partial<FeatureCtx> = {
          rawConfidence: r.rawConfidence,
          coverage: r.coverage,
          answered: r.answered,
          retrievedChunks: r.retrievedChunks,
          extractionF1: r.extractionF1,
          hallucinationDetected: r.hallucinationDetected,
          difficulty: evalCase?.difficulty ?? undefined,
          category: evalCase?.category ?? undefined,
        }
        if (active) {
          const x = standardizeRow(buildFeatureVector(ctx), active.means, active.stds)
          inputVector = x
          activations = active.mlp.forwardActivations(x)
          featureNames = [...FEATURE_NAMES]
          // 26-BE backprop (A): y thật = [answered?1:0] từ CHÍNH EvalResult
          // dựng x (EvalResult.answered Boolean — schema dòng ~1527) — gradient
          // 1 mẫu thật qua bản active (bọc fail-open: lỗi → null + errors)
          try {
            const yTrue = [r.answered === true ? 1 : 0]
            backprop = finishBackprop(
              active.mlp, x, yTrue,
              `EvalResult · ${hhmm(r.createdAt)} · answered=${r.answered === true ? 'true' : 'false'}`,
            )
          } catch (err) {
            backprop = null
            errors.push(`backprop: ${errMsg(err)}`)
          }
        }
        // DORMANT → inputVector giữ null (quyết định ghi ở header JSDoc).
      }
    } catch (err) {
      errors.push(`EvalResult: ${errMsg(err)}`)
    }
  } else if (brain === 'surrogate') {
    const active = await loadActiveSurrogate()
    status = active ? 'active' : 'dormant'

    try {
      const run = await latestRun()
      if (run) {
        sourceLabel = clipLabel(
          `AgentRun · model ${run.model ?? '—'} · agent ${run.agentName ?? '—'} · ${hhmm(run.createdAt)}`,
        )
        if (typeof run.model === 'string' && run.model !== '') {
          const ctx: SurrogateFeatureCtx = {
            model: run.model,
            agent: run.agentName,
            delegated: run.parentRunId !== null,
          }
          if (active) {
            const x = standardizeRow(
              buildSurrogateFeatureRow(ctx, active.vocab),
              active.means,
              active.stds,
            )
            inputVector = x
            activations = active.heads[head].forwardActivations(x)
            featureNames = surrogateFeatureNames(active.vocab)
            // 26-BE backprop (B) theo head — y ĐÚNG transform pipeline
            // (targetStats bản active — xem surrogateBackprop JSDoc)
            try {
              backprop = surrogateBackprop(active, head, run, x)
            } catch (err) {
              backprop = null
              errors.push(`backprop: ${errMsg(err)}`)
            }
          } else {
            // DORMANT: vocab từ AgentRunRecord usable — filter ĐÚNG
            // trainBrainSurrogateLocked (surrogate.ts:573-578) → one-hot THÔ
            // 0/1 thật (chưa chuẩn hóa — không có means/stds khi dormant).
            // FB-BRAIN-LIVE-R1-04: vocab cache TTL 60s (khối quyết định ở
            // đầu file) — bỏ query 5000-row lặp lại mỗi poll 2.5s; hết hạn
            // 60s → dựng lại từ ĐÚNG đường query gốc (không invalidate chủ
            // động — chấp nhận trễ ≤60s cho hiển thị quan sát).
            let vocab = vocabCacheGet<SurrogateVocab>('surrogate')
            if (vocab === null) {
              const rows = await db.agentRunRecord.findMany({
                select: {
                  model: true, agentName: true, parentRunId: true,
                  complete: true, tokensUsed: true, durationMs: true,
                },
                orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
                take: 5000,
              })
              const usable = rows.filter(
                r => typeof r.model === 'string' && r.model !== ''
                  && typeof r.complete === 'boolean'
                  && typeof r.tokensUsed === 'number' && Number.isFinite(r.tokensUsed) && r.tokensUsed >= 0
                  && typeof r.durationMs === 'number' && Number.isFinite(r.durationMs) && r.durationMs >= 0,
              )
              vocab = buildSurrogateVocab(
                usable.map(r => ({
                  model: r.model as string,
                  agent: r.agentName,
                  delegated: r.parentRunId !== null,
                })),
              )
              vocabCacheSet('surrogate', vocab)
            }
            inputVector = toPlainNumbers(buildSurrogateFeatureRow(ctx, vocab))
            featureNames = surrogateFeatureNames(vocab)
          }
        } else {
          errors.push('run gần nhất không có model — không dựng one-hot cfg được (AgentRunRecord.model null)')
        }
      }
    } catch (err) {
      errors.push(`AgentRunRecord: ${errMsg(err)}`)
    }
  } else {
    // policy
    const active = await loadActivePolicy()
    status = active ? 'active' : 'dormant'

    try {
      const run = await latestRun()
      if (run) {
        sourceLabel = clipLabel(
          `AgentRun · model ${run.model ?? '—'} · agent ${run.agentName ?? '—'} · ${hhmm(run.createdAt)}`,
        )
        const ctx: PolicyFeatureCtx = {
          agent: run.agentName,
          delegated: run.parentRunId !== null,
        }
        if (active) {
          const x = standardizeRow(
            buildPolicyFeatureRow(ctx, active.vocab),
            active.means,
            active.stds,
          )
          inputVector = x
          activations = active.mlp.forwardActivations(x)
          featureNames = policyFeatureNames(active.vocab)
          // 26-BE backprop (C): policy KHÔNG có nhãn thật cho 1 run riêng lẻ
          // (y là phân phối mixture chỉ build được từ reward ledger lúc train —
          // xem surrogateBackprop) → TRUNG THỰC null-số + label giải thích
          backprop = noLabelBackprop(
            'chưa có nhãn thật cho mẫu gần nhất (policy — phân phối mục tiêu chỉ dựng được từ reward ledger lúc train)',
          )
        } else {
          // DORMANT: vocab agents từ ledger usable — filter ĐÚNG
          // collectRewardLedger (reward.ts:246-251 — nguồn ctxs khi train
          // policy) → one-hot THÔ 0/1 thật (chưa chuẩn hóa khi dormant).
          // FB-BRAIN-LIVE-R1-04: vocab cache TTL 60s (khối comment đầu
          // file) — bỏ query 5000-row lặp lại mỗi poll 2.5s.
          let vocab = vocabCacheGet<PolicyVocab>('policy')
          if (vocab === null) {
            const rows = await db.agentRunRecord.findMany({
              select: {
                model: true, agentName: true, parentRunId: true,
                complete: true, tokensUsed: true,
              },
              orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
              take: 5000,
            })
            const usable = rows.filter(
              r => typeof r.model === 'string' && r.model !== ''
                && typeof r.complete === 'boolean'
                && typeof r.tokensUsed === 'number' && Number.isFinite(r.tokensUsed) && r.tokensUsed >= 0,
            )
            vocab = buildPolicyVocab(
              usable.map(r => ({ agent: r.agentName, delegated: r.parentRunId !== null })),
            )
            vocabCacheSet('policy', vocab)
          }
          inputVector = toPlainNumbers(buildPolicyFeatureRow(ctx, vocab))
          featureNames = policyFeatureNames(vocab)
        }
      }
    } catch (err) {
      errors.push(`AgentRunRecord: ${errMsg(err)}`)
    }
  }

  // Fail-open: thiếu dữ liệu → field null + error message, vẫn 200 (header)
  return NextResponse.json({
    ok: true,
    brain,
    head: brain === 'surrogate' ? head : null,
    status,
    agentRunInProgress,
    inputVector,
    activations,
    featureNames,
    sourceLabel,
    fetchedAt: new Date().toISOString(),
    // 26-BE (hợp đồng 26-RESTORE) — gradient thật 1 mẫu gần nhất qua bản active
    backprop,
    // 26-BE — snapshot bus train gần nhất/đang chạy (mọi nguồn, mọi brain)
    training,
    ...(errors.length > 0 ? { error: errors.join('; ') } : {}),
  })
}
