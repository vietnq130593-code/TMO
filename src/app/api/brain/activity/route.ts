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
 * Fail-open tuyệt đối: mọi nhánh đọc DB bọc try/catch — thiếu dữ liệu →
 * field null + `error` message, response vẫn 200 (tab quan sát không bao
 * giờ trắng trang vì thiếu dữ liệu). 400 CHỈ cho query rác (brain/head).
 *
 * READ-ONLY TUYỆT ĐỐI: chỉ count/findFirst/findMany/findUnique — KHÔNG
 * create/update/delete, KHÔNG đụng runtime/tuning/BrainModel.active.
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

/** Run gần nhất (mọi status — chạy 'running' vẫn có ctx cfg biết ngay lúc spawn). */
async function latestRun() {
  return db.agentRunRecord.findFirst({
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    select: { model: true, agentName: true, parentRunId: true, createdAt: true },
  })
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

  // (a) Có AgentRunRecord status='running' đang chạy không (toàn cục — fail-open false)
  try {
    agentRunInProgress = (await db.agentRunRecord.count({ where: { status: 'running' } })) > 0
  } catch (err) {
    errors.push(`agentRunInProgress: ${errMsg(err)}`)
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
    ...(errors.length > 0 ? { error: errors.join('; ') } : {}),
  })
}
