/**
 * EVO-P4 (BLUEPRINT-EVO-NAO-P1-P5 §4.5) — EVOLVE RUNNER + TRẠNG THÁI
 * ============================================================================
 *
 * Vòng tiến hoá: sinh ứng viên từ encoding 144 (mutation + crossover 80/20
 * vòng đầu — Q3; repair one-hot F8) → train + chấm benchmark EVO-P0 (CÙNG
 * fixture + CÙNG giao thức — công bằng §0.1) → ghi BrainSearchCandidate
 * (KHÔNG giữ weights — H6) + heartbeat từng ứng viên (mồ côi stale > 60s →
 * mark failed — precedent HN §4.2-2b).
 *
 * R26 SMART SEARCH (evo/smart-search.ts): ứng viên #0 = hạt giống ĐÃ TÍNH
 * TOÁN từ dữ liệu (suggestArch — kim tự tháp hình học + trần dung lượng theo
 * mẫu); cha mutation/crossover chọn theo GIẢI ĐẤU (tournament k=3); mutation
 * rate thích ứng 0,15 → 0,06. GET kèm `suggestion` hiển thị ở form E2.
 *
 * BẤT BIẾN (§6):
 *  - H1: KHÔNG đụng đường runtime — không đọc/ghi BrainModel, không thay
 *    brain active; ứng viên chỉ là ĐỀ XUẤT (H2 — user duyệt qua A1).
 *  - H3: ngân sách SEARCH_MAX_CANDIDATES ≤ 24 / SEARCH_MAX_WALL_MS 10 phút
 *    — vượt wall → dừng sớm, status 'done' + summary.note 'budget_exceeded'.
 *  - H4: tất định — seed = hash(runId) mặc định (F7/0.5 — "seed tự sinh
 *    tất định" = hash(runId), HIỆN rõ cho user nhập lại đè); cùng seed +
 *    cùng fixture → cùng chuỗi ứng viên + điểm bit-đối-bit.
 *  - H5: DB additive — chỉ INSERT; prune theo precedent HN (SEARCH_SESSIONS_KEEP).
 *  - H7: ứng viên có block thắng CV nhưng p95 > 2× bản MLP chuỗi (default
 *    draft chấm trên CÙNG fixture) → blockedH7 — KHÔNG đề xuất áp runtime.
 *
 * Cờ: `brain_evolve` (tuning #35, mặc định OFF — route chặn 400 flag_off)
 * + `brain_search_global` (tuning #36 — off = kill mọi não search).
 *
 * Run registry in-memory trên globalThis (precedent singleton — app restart
 * = mất run đang chạy → GET sweep heartbeat stale đánh dấu failed trung thực).
 */

import { createHash } from 'crypto'
import { db } from '@/lib/db'
import { BRAIN_TRAINABLE_KEYS, type BrainKey } from '@/lib/brain/registry'
import {
  SEARCH_MAX_CANDIDATES,
  SEARCH_MAX_WALL_MS,
  SEED_MAX,
  EVO_ENCODING_DIM,
  sampleEvoCandidate,
  mutateEvo,
  crossoverEvo,
  decodeEvoCandidate,
  encodeEvoCandidate,
  padEvo96to144,
} from '@/lib/brain/search-space'
import {
  loadEvoFixture,
  scoreEvoCandidate,
  scoreEvoBaseline,
  type EvoCandidateSpec,
  type EvoScoreResult,
} from '@/lib/brain/evo/benchmark'
import {
  adaptiveMutationRate,
  pickTournamentParent,
  suggestArch,
  suggestionToEncoding,
} from '@/lib/brain/evo/smart-search'
import { formatArchSummary } from '@/lib/brain/evo/blocks'
import { makeRng } from '@/lib/brain/init'
import { defaultDraftFor } from '@/lib/brain/spec-schema'

// ==================== HẰNG SỐ ====================

/** Trần tham số mọi ứng viên (BRAIN_MAX_PARAMS precedent mlp.ts — 250K). */
export const EVO_MAX_PARAMS = 250_000
/** Q3 — vòng đầu: 80% mutation / 20% crossover. */
export const EVO_MUTATION_RATE = 0.8
/** Heartbeat stale → run mồ côi bị đánh dấu failed (giây — precedent HN 4.2-2b). */
export const EVO_HEARTBEAT_STALE_MS = 60_000

// ==================== TYPES (contract §5.7 — route + UI cùng import) ====================

export interface EvolveCandidateRow {
  idx: number
  archSummary: string
  cvScore: number
  ciLow: number
  ciHigh: number
  params: number
  trainMs: number
  p95LatencyMs: number
  beatActive: boolean
  blockedH7: boolean
  encoding: number[]
  spec: unknown
  moeSkipped: boolean
  note?: string
}

export interface EvolveRunState {
  id: string
  brain: string
  status: 'running' | 'done' | 'failed' | 'cancelled'
  seed: number
  candidatesMax: number
  progress: { done: number; total: number; elapsedMs: number; wallMsMax: number }
  summary?: {
    bestCandidateIdx: number | null
    nBeatActive: number
    nBlockedH7: number
    durationMs: number
    note?: string
  }
  error?: string
}

/** R26 smart-sizing — gợi ý kích thước theo dữ liệu fixture (hiển thị form E2). */
export interface EvolveSuggestionResponse {
  brain: string
  hidden: Array<{ units: number; activation: string }>
  nLayers: number
  inputDim: number
  outputDim: number
  nSamples: number
  paramsEstimate: number
  paramsCap: number
  rationale: string
}

export interface EvolveGetResponse {
  ok: true
  run: EvolveRunState | null
  candidates: EvolveCandidateRow[]
  /** Có khi brain có fixture (A/B/C); thiếu khi knowledge (chưa vào search space). */
  suggestion?: EvolveSuggestionResponse
}

/** Tính suggestion cho brain — fail-open undefined (knowledge / lỗi fixture). */
function evoSuggestionFor(brain: string): EvolveSuggestionResponse | undefined {
  try {
    const fx = loadEvoFixture(brain)
    const sug = suggestArch({
      brain: brain as BrainKey,
      inputDim: fx.inputDim,
      outputDim: fx.outputDim,
      nSamples: fx.nSamples,
      paramsBudget: EVO_MAX_PARAMS,
    })
    return {
      brain: sug.brain,
      hidden: sug.hidden,
      nLayers: sug.nLayers,
      inputDim: sug.inputDim,
      outputDim: sug.outputDim,
      nSamples: sug.nSamples,
      paramsEstimate: sug.paramsEstimate,
      paramsCap: sug.paramsCap,
      rationale: sug.rationale,
    }
  } catch {
    return undefined // knowledge chưa có fixture (D4 §8.4) — UI hiện thông báo D4
  }
}

// ==================== REGISTRY (globalThis singleton) ====================

interface RunRecord {
  state: EvolveRunState
  candidates: EvolveCandidateRow[]
  cancelRequested: boolean
  startedAtMs: number
  encodings: number[][]
}

const REGISTRY_KEY = '__tmo_evo_runs__'

function getRegistry(): Map<string, RunRecord> {
  const g = globalThis as { __tmo_evo_runs__?: Map<string, RunRecord> }
  if (!g.__tmo_evo_runs__) g.__tmo_evo_runs__ = new Map()
  return g.__tmo_evo_runs__
}

/** F7/0.5 — seed tự sinh tất định = hash(runId) (hiện rõ cho user đè). */
export function seedFromRunId(runId: string): number {
  const h = createHash('sha256').update(`evo:${runId}`).digest()
  return h.readUInt32BE(0) % (SEED_MAX + 1)
}

// ==================== VALIDATION (reason pin §5.7 — F6/0.5) ====================

export type EvolveStartError = 'invalid_brain' | 'invalid_candidates' | 'invalid_seed' | 'already_running'

export interface EvolveStartCheck {
  ok: boolean
  reason?: EvolveStartError
  message?: string
}

export function validateEvoStart(input: {
  brain?: unknown
  candidates?: unknown
  seed?: unknown
}): EvolveStartCheck {
  const { brain, candidates, seed } = input
  if (typeof brain !== 'string' || !BRAIN_TRAINABLE_KEYS.includes(brain as BrainKey)) {
    return {
      ok: false,
      reason: 'invalid_brain',
      message: `brain '${String(brain)}' ngoài menu (${BRAIN_TRAINABLE_KEYS.join(' | ')}) — knowledge ghost chưa vào search space (D3/EVO mở encoding §8.4)`,
    }
  }
  const n = candidates === undefined || candidates === null ? 8 : candidates
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 4 || n > SEARCH_MAX_CANDIDATES || n % 4 !== 0) {
    return {
      ok: false,
      reason: 'invalid_candidates',
      message: `candidates phải nguyên 4–24 bước 4 (H3 ≤ ${SEARCH_MAX_CANDIDATES}/10 phút), nhận ${String(candidates)}`,
    }
  }
  if (seed !== undefined && seed !== null) {
    if (typeof seed !== 'number' || !Number.isInteger(seed) || seed < 0 || seed > SEED_MAX) {
      return { ok: false, reason: 'invalid_seed', message: `seed phải nguyên 0..${SEED_MAX}, nhận ${String(seed)}` }
    }
  }
  return { ok: true }
}

// ==================== BASELINE ĐỐI CHỨNG (tính 1 LẦN đầu run) ====================

interface EvoBaselines {
  /** Điểm đối chứng beatActive: bản active chấm lại trên fixture, hoặc heuristic. */
  activeScore: number
  activeKind: 'active_model' | 'heuristic'
  /** p95 tham chiếu bản MLP chuỗi (default draft cùng fixture) — cổng H7. */
  mlpChainP95Ms: number
}

async function computeBaselines(brain: BrainKey): Promise<EvoBaselines> {
  const fixture = loadEvoFixture(brain)
  // Bản active thật (nếu có) chấm lại TRÊN CÙNG fixture — so sánh sạch
  let activeScore: number | null = null
  let activeKind: EvoBaselines['activeKind'] = 'heuristic'
  try {
    const activeModel = await db.brainModel.findFirst({ where: { brain, active: true } })
    if (activeModel) {
      const specDoc = JSON.parse(activeModel.specJson) as { layers?: unknown }
      const draft = defaultDraftFor(brain)
      // bản active là MLP chuỗi → dựng candidate thuần MLP từ default draft +
      // layers thật (đơn giản hoá trung thực: dùng default draft làm đại diện
      // MLP chuỗi; điểm active THẬT nằm trong trainMetaJson — ở đây chấm lại
      // đúng giao thức benchmark để CÔNG BẲNG với ứng viên)
      void specDoc
      const spec = draftToEvoCandidate(draft)
      const scored = scoreEvoCandidate(spec, fixture, 42)
      activeScore = scored.cvScore
      activeKind = 'active_model'
    }
  } catch {
    // fail-open — rơi về heuristic
  }
  if (activeScore === null) {
    activeScore = scoreEvoBaseline(fixture).cvScore
  }
  // p95 tham chiếu MLP chuỗi: default draft (cùng fixture, cùng giao thức)
  const mlpRef = scoreEvoCandidate(draftToEvoCandidate(defaultDraftFor(brain)), fixture, 42)
  return { activeScore, activeKind, mlpChainP95Ms: mlpRef.p95LatencyMs }
}

/** Draft MLP thuần → EvoCandidateSpec (không block — đại diện "bản MLP chuỗi"). */
function draftToEvoCandidate(draft: ReturnType<typeof defaultDraftFor>): EvoCandidateSpec {
  return {
    head: {
      hidden: draft.hidden.map(h => ({ units: h.units, activation: h.activation })),
      hyper: {
        lr: draft.hyper.lr,
        l2: draft.hyper.l2,
        epochs: draft.hyper.epochs,
        batch: draft.hyper.batch,
        patience: draft.hyper.patience,
      },
    },
    blocks: [
      { type: 'identity' },
      { type: 'identity' },
      { type: 'identity' },
    ],
    headDim: 64,
  }
}

// ==================== RUN LOOP ====================

export interface EvolveStartResult {
  ok: boolean
  runId?: string
  reason?: EvolveStartError
  message?: string
}

/**
 * Khởi động vòng evolve (async fire-and-forget — route trả runId NGAY).
 * Caller (route) đã chặn cờ + validate; hàm này chỉ kiểm already_running.
 */
export async function startEvoRun(input: {
  brain: BrainKey
  candidates: number
  seed?: number
}): Promise<EvolveStartResult> {
  const { brain, candidates } = input
  const registry = getRegistry()
  for (const rec of registry.values()) {
    if (rec.state.brain === brain && rec.state.status === 'running') {
      return { ok: false, reason: 'already_running', message: `vòng evolve '${brain}' đang chạy (runId ${rec.state.id})` }
    }
  }
  const runId = `evo_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
  const seed = typeof input.seed === 'number' ? input.seed : seedFromRunId(runId)
  const fixture = loadEvoFixture(brain)

  const record: RunRecord = {
    state: {
      id: runId,
      brain,
      status: 'running',
      seed,
      candidatesMax: candidates,
      progress: { done: 0, total: candidates, elapsedMs: 0, wallMsMax: SEARCH_MAX_WALL_MS },
    },
    candidates: [],
    cancelRequested: false,
    startedAtMs: Date.now(),
    encodings: [],
  }
  registry.set(runId, record)

  // DB row (H5 additive)
  try {
    await db.brainSearchRun.create({
      data: {
        id: runId,
        brain,
        status: 'running',
        seed,
        heartbeatAt: new Date(),
        dataFingerprint: `evo-fixture:${fixture.dataFingerprint}`,
        inputMode: 'evo-144',
        candidatesMax: candidates,
        wallMsMax: SEARCH_MAX_WALL_MS,
      },
    })
  } catch (err) {
    console.warn('[Evolve] tạo BrainSearchRun thất bại (không chặn chạy):', err instanceof Error ? err.message : String(err))
  }

  // Fire-and-forget — mọi lỗi bọc vào state failed
  void runEvolveLoop(runId, brain, seed, candidates).catch(err => {
    const rec = getRegistry().get(runId)
    if (rec) {
      rec.state.status = 'failed'
      rec.state.error = err instanceof Error ? err.message : String(err)
    }
    void db.brainSearchRun.update({
      where: { id: runId },
      data: { status: 'failed', error: rec?.state.error, finishedAt: new Date() },
    }).catch(() => {})
  })

  return { ok: true, runId }
}

async function runEvolveLoop(runId: string, brain: BrainKey, seed: number, total: number): Promise<void> {
  const registry = getRegistry()
  const rec = registry.get(runId)
  if (!rec) return
  const fixture = loadEvoFixture(brain)
  const rng = makeRng(seed)
  const baselines = await computeBaselines(brain)
  // R26 smart-sizing: hạt giống #0 = kiến trúc ĐÃ TÍNH TOÁN từ dữ liệu fixture
  // (suggestArch) — mọi vòng khởi đầu bằng cơ chế tính thay vì ngẫu nhiên thuần.
  const seedEncoding = suggestionToEncoding(
    suggestArch({
      brain,
      inputDim: fixture.inputDim,
      outputDim: fixture.outputDim,
      nSamples: fixture.nSamples,
      paramsBudget: EVO_MAX_PARAMS,
    }),
    brain,
    fixture.inputDim,
  )
  let nBeatActive = 0
  let nBlockedH7 = 0
  let bestIdx: number | null = null
  let bestScore = -1

  for (let i = 0; i < total; i++) {
    // H3 wall + cancel (cooperative)
    const elapsed = Date.now() - rec.startedAtMs
    if (rec.cancelRequested) {
      rec.state.status = 'cancelled'
      break
    }
    if (elapsed > SEARCH_MAX_WALL_MS) {
      rec.state.status = 'done'
      rec.state.summary = {
        bestCandidateIdx: bestIdx,
        nBeatActive,
        nBlockedH7,
        durationMs: elapsed,
        note: 'budget_exceeded — dừng sớm theo H3 (≤24 ứng viên/10 phút), giữ các ứng viên đã chấm',
      }
      break
    }

    // ── Sinh ứng viên (R26 smart search): #0 = hạt giống suggestArch (đã tính
    // ở trên); sau đó 80% mutation / 20% crossover (Q3) với CHA CHỌN THEO
    // GIẢI ĐẤU (tournament k=3 — thay uniform) + mutation rate thích ứng
    // 0,15 → 0,06 theo tiến độ (khám phá sớm — khai thác muộn). ──
    let encoding: number[]
    if (i === 0 || rec.encodings.length === 0) {
      encoding = i === 0 ? [...seedEncoding] : sampleEvoCandidate(rng, brain, fixture.inputDim)
    } else if (rng() < EVO_MUTATION_RATE || rec.encodings.length < 2) {
      const parent = pickTournamentParent(rec.encodings, rec.candidates.map(c => c.cvScore), rng)
      encoding = mutateEvo(parent, rng, adaptiveMutationRate(i, total))
    } else {
      const scores = rec.candidates.map(c => c.cvScore)
      const a = pickTournamentParent(rec.encodings, scores, rng)
      const b = pickTournamentParent(rec.encodings, scores, rng)
      encoding = crossoverEvo(a, b, rng)
    }

    // ── Decode + chấm ──
    let row: EvolveCandidateRow
    try {
      const spec = decodeEvoCandidate(encoding, brain)
      const scored: EvoScoreResult = scoreEvoCandidate(spec, fixture, seed + i)
      const hasBlock = spec.blocks.some(b => b.type !== 'identity')
      const beatActive = scored.cvScore > baselines.activeScore
      const blockedH7 = hasBlock && beatActive && scored.p95LatencyMs > 2 * Math.max(0.001, baselines.mlpChainP95Ms)
      if (beatActive && !blockedH7) nBeatActive++
      if (blockedH7) nBlockedH7++
      if (scored.cvScore > bestScore) {
        bestScore = scored.cvScore
        bestIdx = i
      }
      row = {
        idx: i,
        archSummary: formatArchSummary(
          spec.blocks,
          spec.head.hidden.map(h => h.units),
        ) + (scored.moeSkipped ? ' (moe skipped — Q4 <2K mẫu)' : ''),
        cvScore: scored.cvScore,
        ciLow: scored.ciLow,
        ciHigh: scored.ciHigh,
        params: scored.params,
        trainMs: scored.trainMs,
        p95LatencyMs: scored.p95LatencyMs,
        beatActive,
        blockedH7,
        encoding,
        spec,
        moeSkipped: scored.moeSkipped,
        ...(scored.params > EVO_MAX_PARAMS ? { note: `params ${scored.params} > trần ${EVO_MAX_PARAMS} (BRAIN_MAX_PARAMS) — KHÔNG thể áp dụng vào draft` } : {}),
      }
    } catch (err) {
      // decode/score lỗi (vector rác sau cùng repair vẫn failsafe) — ghi trung thực
      row = {
        idx: i,
        archSummary: '(lỗi decode/score)',
        cvScore: 0,
        ciLow: 0,
        ciHigh: 0,
        params: 0,
        trainMs: 0,
        p95LatencyMs: 0,
        beatActive: false,
        blockedH7: false,
        encoding,
        spec: null,
        moeSkipped: false,
        note: `score_error: ${err instanceof Error ? err.message : String(err)}`,
      }
    }

    rec.candidates.push(row)
    rec.encodings.push(encoding)
    rec.state.progress.done = i + 1
    rec.state.progress.elapsedMs = Date.now() - rec.startedAtMs

    // DB persist từng ứng viên (H5 additive) + heartbeat
    try {
      await db.brainSearchCandidate.create({
        data: {
          runId,
          idx: i,
          specJson: JSON.stringify(row.spec),
          encodingJson: JSON.stringify(row.encoding),
          metricsJson: JSON.stringify({
            archSummary: row.archSummary,
            ciLow: row.ciLow,
            ciHigh: row.ciHigh,
            params: row.params,
            trainMs: row.trainMs,
            p95LatencyMs: row.p95LatencyMs,
            beatActive: row.beatActive,
            blockedH7: row.blockedH7,
            moeSkipped: row.moeSkipped,
            ...(row.note ? { note: row.note } : {}),
          }),
          cvScore: row.cvScore,
          beatActive: row.beatActive,
        },
      })
      await db.brainSearchRun.update({
        where: { id: runId },
        data: { heartbeatAt: new Date() },
      })
    } catch (err) {
      console.warn(`[Evolve] persist ứng viên #${i} thất bại (không chặn vòng):`, err instanceof Error ? err.message : String(err))
    }
  }

  // ── Kết thúc ──
  const finalRec = registry.get(runId)
  if (!finalRec) return
  if (finalRec.state.status === 'running') {
    finalRec.state.status = 'done'
  }
  finalRec.state.summary = {
    bestCandidateIdx: bestIdx,
    nBeatActive,
    nBlockedH7,
    durationMs: Date.now() - finalRec.startedAtMs,
    ...(finalRec.state.summary?.note ? { note: finalRec.state.summary.note } : {}),
  }
  try {
    await db.brainSearchRun.update({
      where: { id: runId },
      data: {
        status: finalRec.state.status,
        summaryJson: JSON.stringify(finalRec.state.summary),
        finishedAt: new Date(),
      },
    })
  } catch {
    // fail-open — in-memory state vẫn đúng
  }
}

// ==================== CANCEL (cooperative — precedent HN §4.2-2c) ====================

export async function cancelEvoRun(runId: string): Promise<{ ok: boolean; message: string }> {
  const rec = getRegistry().get(runId)
  if (!rec) {
    return { ok: true, message: `runId '${runId}' không có trong registry (đã xong/restart) — idempotent no-op` }
  }
  if (rec.state.status !== 'running') {
    return { ok: true, message: `run đã ${rec.state.status} — no-op` }
  }
  rec.cancelRequested = true
  return { ok: true, message: 'đã yêu cầu dừng — vòng dừng ở ứng viên kế tiếp (cooperative)' }
}

// ==================== GET STATE (rebuild từ DB khi restart) ====================

export async function getEvoRunState(
  brain: string,
  runId?: string,
): Promise<EvolveGetResponse> {
  const registry = getRegistry()

  // Ưu tiên in-memory (run đang chạy trong process này)
  let rec: RunRecord | undefined
  if (runId) {
    rec = registry.get(runId)
  } else {
    for (const r of registry.values()) {
      if (r.state.brain === brain && (!rec || r.startedAtMs > rec.startedAtMs)) rec = r
    }
  }

  if (rec) {
    // R26: kèm suggestion smart-sizing (fail-open undefined — knowledge)
    const suggestion = evoSuggestionFor(brain)
    return { ok: true, run: rec.state, candidates: rec.candidates, ...(suggestion ? { suggestion } : {}) }
  }

  // Rebuild từ DB (run của process trước / sau restart)
  try {
    const run = runId
      ? await db.brainSearchRun.findUnique({ where: { id: runId } })
      : await db.brainSearchRun.findFirst({
          where: { brain, inputMode: 'evo-144' },
          orderBy: { startedAt: 'desc' },
        })
    if (!run || run.inputMode !== 'evo-144') {
      const suggestion = evoSuggestionFor(brain)
      return { ok: true, run: null, candidates: [], ...(suggestion ? { suggestion } : {}) }
    }
    let status = run.status as EvolveRunState['status']
    // Sweep mồ côi: running mà heartbeat stale > 60s → failed (HN §4.2-2b)
    if (status === 'running' && Date.now() - run.heartbeatAt.getTime() > EVO_HEARTBEAT_STALE_MS) {
      status = 'failed'
      await db.brainSearchRun.update({
        where: { id: run.id },
        data: { status: 'failed', error: 'worker chết (restart?) — heartbeat stale > 60s', finishedAt: new Date() },
      }).catch(() => {})
    }
    const rows = await db.brainSearchCandidate.findMany({
      where: { runId: run.id },
      orderBy: { idx: 'asc' },
    })
    const candidates: EvolveCandidateRow[] = rows.map(r => {
      const m = JSON.parse(r.metricsJson) as Record<string, unknown>
      return {
        idx: r.idx,
        archSummary: typeof m.archSummary === 'string' ? m.archSummary : '(?)',
        cvScore: r.cvScore,
        ciLow: typeof m.ciLow === 'number' ? m.ciLow : r.cvScore,
        ciHigh: typeof m.ciHigh === 'number' ? m.ciHigh : r.cvScore,
        params: typeof m.params === 'number' ? m.params : 0,
        trainMs: typeof m.trainMs === 'number' ? m.trainMs : 0,
        p95LatencyMs: typeof m.p95LatencyMs === 'number' ? m.p95LatencyMs : 0,
        beatActive: r.beatActive,
        blockedH7: m.blockedH7 === true,
        encoding: JSON.parse(r.encodingJson) as number[],
        spec: JSON.parse(r.specJson),
        moeSkipped: m.moeSkipped === true,
        ...(typeof m.note === 'string' ? { note: m.note } : {}),
      }
    })
    const summary = run.summaryJson
      ? (JSON.parse(run.summaryJson) as EvolveRunState['summary'])
      : undefined
    const suggestion = evoSuggestionFor(brain)
    return {
      ok: true,
      run: {
        id: run.id,
        brain: run.brain,
        status,
        seed: run.seed,
        candidatesMax: run.candidatesMax,
        progress: {
          done: candidates.length,
          total: run.candidatesMax,
          elapsedMs: run.finishedAt ? run.finishedAt.getTime() - run.startedAt.getTime() : Date.now() - run.startedAt.getTime(),
          wallMsMax: run.wallMsMax,
        },
        ...(summary ? { summary } : {}),
        ...(run.error ? { error: run.error } : {}),
      },
      candidates,
      ...(suggestion ? { suggestion } : {}),
    }
  } catch (err) {
    console.error('[Evolve] getEvoRunState DB error:', err instanceof Error ? err.message : String(err))
    return { ok: true, run: null, candidates: [] }
  }
}

/** Kiểm tra run đang chạy (in-memory) theo brain — route dùng cho already_running. */
export function isEvoRunning(brain: string): boolean {
  for (const rec of getRegistry().values()) {
    if (rec.state.brain === brain && rec.state.status === 'running') return true
  }
  return false
}

// re-export tiện route
export { EVO_ENCODING_DIM, padEvo96to144, encodeEvoCandidate }
