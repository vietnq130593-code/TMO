/**
 * OBS-P2 (BLUEPRINT-OBSERVATION-P1-P4 §C.2/C.3 — chốt §7 Task 23 2026-10-13)
 * ==========================================================================
 *
 * VẾT SUY DIỄN NÃO — `traceInference()` fire-and-forget, gọi tại 3 organ
 * call-site runtime (C.3 đợt 2): calibrate (tryCalibrationV3) · replay_eval
 * (buildReplayReport) · policy_mixture (applyPolicyMixture).
 *
 * Mỗi lần não predict lưu 2 dòng:
 *   1. BrainInferenceTrace (model 104) — bản ghi đầy đủ: inputHash SHA-256
 *      (mặc định hash-only — Q2 §7 chốt) + inputJson/outputJson CHỈ khi cờ
 *      `obs_brain_trace` bật (capped 2KB) + modelVersion provenance.
 *   2. ObservationEvent kind 'brain.infer-ref' (model 103) — tham chiếu
 *      (table/rowKey trỏ trace) để timeline API có sự kiện não trong 1
 *      nguồn duy nhất (C.4 "cả 2 nguồn trong 1 response" qua join runId).
 *
 * Gate: cờ `obs_ledger` (chung đợt 1+2 — C.3). Off → no-op, overhead 0.
 * Fail-open tuyệt đối (RO-3): KHÔNG bao giờ throw/async chậm block organ —
 * mọi thứ chạy nền qua queue riêng của trace.
 */

import { createHash } from 'node:crypto'
import { db } from '@/lib/db'
import { getTuningEnum } from '@/lib/learning/tuning-store'

// ==================== HẰNG SỐ (doctrine #1 — nguồn §C.2) ====================

/** Giữ tối đa số vết inference (Q3 §7 chốt — prune riêng tần suất cao). */
export const OBS_TRACE_KEEP = 20_000
/** Vết cũ hơn N ngày bị prune (Q3 §7 chốt). */
export const OBS_TRACE_MAX_AGE_DAYS = 14
/** Chu kỳ prune: sau mỗi 1.000 vết ghi (C.2). */
export const OBS_TRACE_PRUNE_EVERY = 1_000
/** inputJson/outputJson capped 2KB THEO BYTE UTF-8 (§C.2 — vượt thì cắt +
 * flag truncated; FB-OBS-R1-03: đếm .length cho phép vector đa byte vượt ~3×). */
export const OBS_TRACE_JSON_MAX_BYTES = 2_048
/** Queue vết có-hạn — đối xứng OBS_QUEUE_MAX (ledger.ts). */
export const OBS_TRACE_QUEUE_MAX = 512

// ==================== INPUT ====================

export interface TraceInferenceInput {
  /** 'calibration_v3' | 'surrogate' | 'policy' — khớp BRAIN_REGISTRY */
  brain: string
  /** 'calibrate' | 'replay_eval' | 'policy_mixture' | … */
  organ: string
  /** Bản BrainModel dùng (provenance — GAP-2 "weights nào đang tư duy") */
  modelVersion: number
  /** Vector/object input — hash luôn; full CHỈ khi obs_brain_trace on */
  input: unknown
  /** Output predict (số/mảng/object) */
  output: unknown
  latencyMs: number
  runId?: string | null
}

// ==================== STATE (globalThis — HMR-safe, tiền lệ ledger.ts) ====================

interface ObsTraceState {
  queue: TraceInferenceInput[]
  draining: boolean
  written: number
  dropped: number
  failed: number
  sincePrune: number
  /** chống prune chồng chéo — đối xứng ledger (FB-OBS-R1-13) */
  pruning: boolean
}

const globalForObsTrace = globalThis as unknown as { __tmoObsTrace?: ObsTraceState }

function state(): ObsTraceState {
  if (!globalForObsTrace.__tmoObsTrace) {
    globalForObsTrace.__tmoObsTrace = {
      queue: [],
      draining: false,
      written: 0,
      dropped: 0,
      failed: 0,
      sincePrune: 0,
      pruning: false,
    }
  }
  return globalForObsTrace.__tmoObsTrace
}

// ==================== GHI VẾT ====================

/** Cờ nâng cấp vết lên full vector (Q2 §7 chốt hash mặc định). */
export function isObsBrainTraceEnabled(): boolean {
  try {
    return getTuningEnum('obs_brain_trace') === 'on'
  } catch {
    return false
  }
}

/**
 * Ghi vết 1 lần não suy diễn — FIRE-AND-FORGET (void): organ KHÔNG await,
 * KHÔNG BAO GIỜ throw. Cờ obs_ledger off → return ngay (overhead 0).
 */
export function traceInference(input: TraceInferenceInput): void {
  try {
    // check cờ tại đây bằng import động ledger? — KHÔNG: getTuningEnum trực
    // tiếp (rẻ, không chu trình — trace.ts KHÔNG bị tuning-store import).
    if (getTuningEnum('obs_ledger') !== 'on') return
  } catch {
    return
  }
  const st = state()
  if (st.queue.length >= OBS_TRACE_QUEUE_MAX) {
    st.dropped++
    return
  }
  st.queue.push(input)
  if (!st.draining) {
    st.draining = true
    void drainTrace().finally(() => {
      state().draining = false
    })
  }
}

/** Đợi queue vết xong — cho test (r96). */
export async function flushTraceQueue(): Promise<void> {
  // drain là vòng void — đợi bằng poll ngắn queue rỗng + draining=false
  for (let i = 0; i < 200; i++) {
    const st = state()
    if (st.queue.length === 0 && !st.draining) return
    await new Promise(r => setTimeout(r, 10))
  }
}

async function drainTrace(): Promise<void> {
  for (;;) {
    const st = state()
    const item = st.queue.shift()
    if (!item) return
    try {
      await writeOneTrace(item)
      st.written++
      st.sincePrune++
    } catch {
      st.failed++
    }
    if (st.sincePrune >= OBS_TRACE_PRUNE_EVERY && !st.pruning) {
      st.sincePrune = 0
      st.pruning = true
      void pruneBrainInferenceTraces().finally(() => {
        state().pruning = false
      })
    }
  }
}

/** SHA-256 canonical JSON của input — 64 hex, so khớp được (C.2). */
export function hashObsInput(input: unknown): string {
  return createHash('sha256').update(JSON.stringify(input ?? null)).digest('hex')
}

/** Cap JSON 2KB THEO BYTE — vượt thì cắt + flag truncated (§C.2; FB-OBS-R1-03). */
export function capTraceJson(value: unknown): string | null {
  if (value === undefined || value === null) return null
  const json = JSON.stringify(value)
  if (Buffer.byteLength(json, 'utf8') <= OBS_TRACE_JSON_MAX_BYTES) return json
  return JSON.stringify({
    truncated: true,
    head: Buffer.from(json, 'utf8').subarray(0, OBS_TRACE_JSON_MAX_BYTES - 60).toString('utf8'),
  })
}

async function writeOneTrace(item: TraceInferenceInput): Promise<void> {
  const inputHash = hashObsInput(item.input)
  const full = isObsBrainTraceEnabled()
  const inputJson = full ? capTraceJson(item.input) : null
  const outputJson = full ? capTraceJson(item.output) : null

  // 1 dòng BrainInferenceTrace + 1 sự kiện tham chiếu trong timeline
  const trace = await db.brainInferenceTrace.create({
    data: {
      brain: item.brain,
      modelVersion: item.modelVersion,
      organ: item.organ,
      runId: item.runId ?? null,
      inputHash,
      inputJson,
      outputJson,
      latencyMs: Math.max(0, Math.round(item.latencyMs)),
    },
  })
  // brain.infer-ref: table/rowKey trỏ trace — timeline 1 nguồn (C.4)
  await db.$transaction(async tx => {
    const last = await tx.observationEvent.findFirst({
      orderBy: { seq: 'desc' },
      select: { seq: true },
    })
    await tx.observationEvent.create({
      data: {
        seq: (last?.seq ?? 0) + 1,
        actor: `brain:${item.brain}`,
        kind: 'brain.infer-ref',
        runId: item.runId ?? null,
        table: 'BrainInferenceTrace',
        rowKey: trace.id,
        summary: `${item.brain} suy diễn (${item.organ}) — ${item.latencyMs}ms · v${item.modelVersion}`,
        payloadJson: JSON.stringify({
          brain: item.brain,
          organ: item.organ,
          modelVersion: item.modelVersion,
          inputHash,
          latencyMs: Math.max(0, Math.round(item.latencyMs)),
          fullVector: full,
        }),
      },
    })
  })
}

// ==================== PRUNE (Q3 §7 — 20K / 14 ngày) ====================

/**
 * Xoá vết cũ: > N ngày HOẶC ngoài K dòng mới nhất. Idempotent, fail-open.
 * opts (keep/maxAgeDays) chỉ định cho TEST (FB-OBS-R1-06: pin count-cap mà
 * không phải seed 20K dòng) — production gọi KHÔNG tham số (mặc định hằng số Q3 §7).
 */
export async function pruneBrainInferenceTraces(
  opts?: { keep?: number; maxAgeDays?: number },
): Promise<{ deleted: number }> {
  const keep = opts?.keep ?? OBS_TRACE_KEEP
  const maxAgeDays = opts?.maxAgeDays ?? OBS_TRACE_MAX_AGE_DAYS
  try {
    const cutoff = new Date(Date.now() - maxAgeDays * 24 * 3600 * 1000)
    const byAge = await db.brainInferenceTrace.deleteMany({ where: { ts: { lt: cutoff } } })
    let byCount = 0
    const total = await db.brainInferenceTrace.count()
    if (total > keep) {
      // Giữ `keep` dòng MỚI NHẤT: mốc = createdAt của dòng thứ KEEP mới nhất
      // → xoá mọi dòng cũ hơn mốc (đối xứng ledger.prune)
      const kth = await db.brainInferenceTrace.findFirst({
        orderBy: { createdAt: 'desc' },
        skip: keep - 1,
        select: { createdAt: true },
      })
      if (kth) {
        const res = await db.brainInferenceTrace.deleteMany({
          where: { createdAt: { lt: kth.createdAt } },
        })
        byCount = res.count
      }
    }
    return { deleted: byAge.count + byCount }
  } catch {
    return { deleted: 0 }
  }
}

/** Ảnh chụp sức khỏe trace — obs.health (GAP-7). */
export function getTraceHealth(): { queued: number; written: number; dropped: number; failed: number } {
  const st = state()
  return { queued: st.queue.length, written: st.written, dropped: st.dropped, failed: st.failed }
}
