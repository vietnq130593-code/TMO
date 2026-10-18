/**
 * OBS-P1 (BLUEPRINT-OBSERVATION-P1-P4 §C.2/C.3 — chốt §7 Task 23 2026-10-13)
 * ==========================================================================
 *
 * SỔ CÁI SỰ KIỆN QUAN SÁT — helper `observeEvent()` fire-and-forget:
 *
 *   Agent/brain/tuning/reward ──► observeEvent() ──► queue có-hạn (512)
 *        │                                                   │ drain tuần tự
 *        │ check cờ obs_ledger TRƯỚC (off → return —        ▼
 *        │ overhead ~0, C.3)                    seq = MAX(seq)+1 (transaction
 *        ▼                                      ngắn — RO-4) → Prisma create
 *   KHÔNG BAO GIỜ block/throw tại call-site (RO-3 — fail-open tuyệt đối:
 *   quan sát KHÔNG được làm hỏng nghiệp vụ chính).
 *
 * Kind-name single-source: src/lib/observation/kinds.ts (thống nhất HyperNAS
 * §9 từ v0.1 cả 2 blueprint — doctrine #9).
 *
 * Cờ (tất cả off mặc định — TUNING_SPECS thứ 26–29): `obs_ledger` gate TOÀN
 * BỘ ghi event + trace; `obs_brain_trace` nâng vết inference hash-only →
 * full vector (trace.ts); `obs_impact` (impact.ts); `ui_observation` (UI).
 *
 * Import direction (check-imports sạch): ledger.ts → db + tuning-store +
 * neural-types. NGƯỢC CHIỀU (tuning-store/agent-run-tracker gọi ledger) PHẢI
 * dynamic import() tại call-site — chống chu trình tĩnh (tiền lệ
 * agent-run-tracker ↔ metrics-db).
 */

import { db, withSqliteRetry } from '@/lib/db'
import { getTuningEnum } from '@/lib/learning/tuning-store'

// ==================== HẰNG SỐ (doctrine #1 — hardcode kèm nguồn) ====================

/** Giới hạn hàng đợi ghi — đầy → drop + đếm dropped (C.3 "bounded queue 512"). */
export const OBS_QUEUE_MAX = 512
/** Giữ tối đa số dòng sự kiện (Q3 §7 chốt — tiền lệ cap TuningChangeLog). */
export const OBS_EVENTS_KEEP = 50_000
/** Sự kiện cũ hơn N ngày bị prune (Q3 §7 chốt). */
export const OBS_EVENTS_MAX_AGE_DAYS = 30
/** Chu kỳ chạy prune: sau mỗi 1.000 sự kiện ghi (C.2 — không cron thêm). */
export const OBS_PRUNE_EVERY = 1_000
/** Payload JSON tối đa 4KB THEO BYTE UTF-8 (C.2 — overflow truncate + flag
 * truncated:true; FB-OBS-R1-03: đếm .length UTF-16 cho phép payload ký tự
 * đa byte vượt cap thật ~3× — tiếng Việt 3 byte/char). */
export const OBS_PAYLOAD_MAX_BYTES = 4_096

// ==================== INPUT ====================

export interface ObserveEventInput {
  /** 'agent:<name>' | 'user' | 'system' | 'brain:<key>' | 'search' */
  actor: string
  /** Xem OBS_KINDS (kinds.ts) — enum chuỗi mở */
  kind: string
  /** 1 dòng tóm tắt hiển thị timeline (KHÔNG JSON — C.2) */
  summary: string
  /** Chi tiết ≤ 4KB — tự truncate (RO-2: KHÔNG lưu full context nhạy cảm) */
  payload?: Record<string, unknown>
  /** FK logic AgentRunRecord (kim tuyến — GAP-1) */
  runId?: string | null
  sessionId?: string | null
  /** bảng bị ảnh hưởng (kind db.write / brain.infer-ref) */
  table?: string | null
  rowKey?: string | null
}

// ==================== STATE (globalThis — sống sót HMR, tiền lệ __tmoTuningSnapshot) ====================

interface ObsLedgerState {
  queue: ObserveEventInput[]
  draining: boolean
  drainPromise: Promise<void> | null
  written: number
  dropped: number
  failed: number
  lastWriteLatencyMs: number
  /** đếm ghi từ lần prune cuối (mỗi OBS_PRUNE_EVERY → chạy prune 1 lần) */
  sincePrune: number
  pruning: boolean
  /** GIAO_THUC-GS Task 32: lỗi ghi gần nhất (message + kind + ts) — obs.health
   *  hiển thị lý do thay vì chỉ đếm failed mơ hồ; null = chưa từng fail. */
  lastError: { message: string; kind: string; ts: number } | null
  /** throttle console.error lỗi ghi (1 dòng/phút — chống spam log) */
  lastErrorLogTs: number
}

const globalForObs = globalThis as unknown as { __tmoObsLedger?: ObsLedgerState }

function state(): ObsLedgerState {
  if (!globalForObs.__tmoObsLedger) {
    globalForObs.__tmoObsLedger = {
      queue: [],
      draining: false,
      drainPromise: null,
      written: 0,
      dropped: 0,
      failed: 0,
      lastWriteLatencyMs: 0,
      sincePrune: 0,
      pruning: false,
      lastError: null,
      lastErrorLogTs: 0,
    }
  }
  return globalForObs.__tmoObsLedger
}

// ==================== FLAG (check ĐỒNG BỘ — rẻ: snapshot in-process) ====================

/** Cờ tổng obs_ledger (STORE › ENV › DEFAULT=off). Off → mọi ghi no-op. */
export function isObsLedgerEnabled(): boolean {
  try {
    return getTuningEnum('obs_ledger') === 'on'
  } catch {
    return false // fail-open: tuning-store lỗi → coi off (không ghi gì)
  }
}

// ==================== GHI SỰ KIỆN ====================

/**
 * Ghi 1 sự kiện quan sát — FIRE-AND-FORGET (void): KHÔNG await tại call-site,
 * KHÔNG BAO GIỜ throw. Cờ off → return ngay (overhead ~0 — C.3/RO-3).
 * Queue đầy → drop + đếm (obs.health.dropped).
 */
export function observeEvent(evt: ObserveEventInput): void {
  if (!isObsLedgerEnabled()) return
  const st = state()
  if (st.queue.length >= OBS_QUEUE_MAX) {
    st.dropped++
    return
  }
  st.queue.push(evt)
  if (!st.draining) {
    st.draining = true
    st.drainPromise = drain().finally(() => {
      const s = state()
      s.draining = false
      // Queue có thể đã dài thêm trong lúc drain — kéo tiếp (không đợi event mới)
      if (s.queue.length > 0 && !s.draining) {
        s.draining = true
        s.drainPromise = drain().finally(() => {
          state().draining = false
        })
      }
    })
  }
}

/** Đợi hàng đợi ghi xong — cho test + call-site cần bền (không bắt buộc). */
export async function flushObservationQueue(): Promise<void> {
  const st = state()
  if (st.drainPromise) await st.drainPromise.catch(() => {})
  // vòng kéo tiếp (nếu có) cũng đợi
  const st2 = state()
  if (st2.drainPromise) await st2.drainPromise.catch(() => {})
}

// ==================== THROTTLE (OBS-V3 H7 — R34) ====================

/** Cửa sổ throttle mặc định — 1 sự kiện/khóa/10 phút (H7: model chết + caller
 * retry liên tục không được spam timeline; rule P6 provider-degraded vẫn đủ
 * 3 sample trong 1h vì các lần cách nhau >10' đếm là các lần THẬT). */
export const OBS_THROTTLE_WINDOW_MS = 10 * 60_000

/**
 * observeEvent + throttle in-memory theo khóa — cho call-site tần suất lỗi
 * lặp cao (tiền lệ: model.failover khi provider chết, mọi call đều fail).
 * Cùng fail-open tuyệt đối: throttle lỗi → vẫn gọi observeEvent thường (thà
 * dư 1 sự kiện hơn mất tín hiệu). Test r122 pin cửa sổ + reset.
 */
export function observeEventThrottled(
  throttleKey: string,
  evt: ObserveEventInput,
  opts?: { windowMs?: number },
): void {
  try {
    const windowMs = opts?.windowMs ?? OBS_THROTTLE_WINDOW_MS
    const now = Date.now()
    const g = globalThis as unknown as { __tmoObsThrottle?: Map<string, number> }
    if (!g.__tmoObsThrottle) g.__tmoObsThrottle = new Map()
    const last = g.__tmoObsThrottle.get(throttleKey)
    if (typeof last === 'number' && now - last < windowMs) return // trong cửa sổ — nuốt
    g.__tmoObsThrottle.set(throttleKey, now)
    // Map lớn dần theo số khóa lỗi — dọn 1 lần/tuần tương đương (rẻ, không cron)
    if (g.__tmoObsThrottle.size > 512) {
      for (const [k, ts] of g.__tmoObsThrottle) {
        if (now - ts > 7 * 24 * 3600_000) g.__tmoObsThrottle.delete(k)
      }
    }
    observeEvent(evt)
  } catch {
    // fail-open — throttle không được phép nuốt LUÔN: thử đường thường
    try {
      observeEvent(evt)
    } catch {
      /* observeEvent vốn không throw — đây là lớp phòng thủ cuối */
    }
  }
}

/** Reset throttle cho TEST (cô lập giữa các case — precedent resetAlertDedupState). */
export function resetObservationThrottle(): void {
  try {
    const g = globalThis as unknown as { __tmoObsThrottle?: Map<string, number> }
    g.__tmoObsThrottle?.clear()
  } catch {
    /* no-op */
  }
}

/** Drain tuần tự — single-writer tự nhiên: seq không race (RO-4). */
async function drain(): Promise<void> {
  for (;;) {
    const st = state()
    const evt = st.queue.shift()
    if (!evt) return
    const t0 = Date.now()
    try {
      await writeOne(evt)
      st.written++
      st.lastWriteLatencyMs = Date.now() - t0
      st.sincePrune++
    } catch (err) {
      st.failed++ // fail-open — sự kiện hỏng KHÔNG dừng drain
      // GIAO_THUC-GS Task 32: bắt lỗi cụ thể để obs.health chẩn đoán được gốc rễ
      // (bằng chứng: 3 lần ghi thất bại chỉ hiện con số, không lý do). Log throttle
      // 1 dòng/phút — giữ fail-open, không spam.
      try {
        st.lastError = {
          message: err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200),
          kind: evt.kind,
          ts: Date.now(),
        }
        if (Date.now() - st.lastErrorLogTs > 60_000) {
          st.lastErrorLogTs = Date.now()
          console.error('[OBS-LEDGER] ghi sự kiện thất bại (fail-open, tiếp tục drain):', st.lastError.message, `· kind=${evt.kind}`)
        }
      } catch { /* không được phép throw trong catch */ }
    }
    if (st.sincePrune >= OBS_PRUNE_EVERY && !st.pruning) {
      st.sincePrune = 0
      st.pruning = true
      void pruneObservationEvents().finally(() => {
        state().pruning = false
      })
    }
  }
}

/** 1 sự kiện = 1 transaction ngắn cấp seq MAX+1 rồi create (RO-4).
 * Task 33 (§0b lượt 2): bọc withSqliteRetry — đo thật 3 sự kiện MẤT (2 run.end
 * + 1 brain.train) vì "$transaction expired 5000ms" dưới cụm ghi run-close
 * (10088ms/20040ms/5032ms — dev.log 41318/43212/43899). run.end là sự kiện
 * ĐÓNG KIM TUYẾN — mất nó là timeline đứt + stall rule mù. Retry chạy
 * transaction MỚI hoàn toàn (seq đọc lại — transaction cũ hết hạn chưa bao
 * giờ commit nên an toàn; drain loop đơn luồng không tự đua). */
async function writeOne(evt: ObserveEventInput): Promise<void> {
  const payloadJson = capPayload(evt.payload)
  await withSqliteRetry(
    () => db.$transaction(async tx => {
      const last = await tx.observationEvent.findFirst({
        orderBy: { seq: 'desc' },
        select: { seq: true },
      })
      await tx.observationEvent.create({
        data: {
          seq: (last?.seq ?? 0) + 1,
          actor: evt.actor,
          kind: evt.kind,
          summary: evt.summary,
          payloadJson,
          runId: evt.runId ?? null,
          sessionId: evt.sessionId ?? null,
          table: evt.table ?? null,
          rowKey: evt.rowKey ?? null,
        },
      })
    }),
    { label: `ledger.writeOne(${evt.kind})` },
  )
}

/** Độ dài BYTE UTF-8 của chuỗi — khác .length (đếm đơn vị UTF-16 — FB-OBS-R1-03). */
function byteLen(s: string): number {
  return Buffer.byteLength(s, 'utf8')
}

/** Cắt chuỗi theo BYTE UTF-8 — có thể rơi giữa 1 codepoint (→ U+FFFD cuối,
 * chấp nhận cho đường "cắt thô" chẩn đoán). */
function utf8ByteSlice(s: string, maxBytes: number): string {
  return Buffer.from(s, 'utf8').subarray(0, maxBytes).toString('utf8')
}

/** Payload ≤ 4KB theo byte — overflow cắt + đánh dấu truncated:true (C.2/RO-2). */
export function capPayload(payload?: Record<string, unknown>): string {
  if (!payload || Object.keys(payload).length === 0) return '{}'
  let json = JSON.stringify(payload)
  if (byteLen(json) <= OBS_PAYLOAD_MAX_BYTES) return json
  const capped = { ...payload, truncated: true }
  json = JSON.stringify(capped)
  if (byteLen(json) <= OBS_PAYLOAD_MAX_BYTES) return json
  // Vẫn vượt (1 trường quá lớn) — cắt thô THEO BYTE + đánh dấu
  // (head budget −160: đủ chỗ cho vỏ JSON quanh head — FB-OBS-R1-03)
  return JSON.stringify({
    truncated: true,
    note: 'payload vượt 4KB — đã cắt',
    head: utf8ByteSlice(json, OBS_PAYLOAD_MAX_BYTES - 160),
  })
}

// ==================== PRUNE (Q3 §7 chốt — 50K dòng / 30 ngày) ====================

/**
 * Xoá sự kiện cũ: > N ngày HOẶC ngoài K dòng mới nhất. Idempotent, fail-open.
 * opts (keep/maxAgeDays) chỉ định cho TEST (FB-OBS-R1-06: pin count-cap mà
 * không phải seed 50K dòng) — production gọi KHÔNG tham số (mặc định hằng số Q3 §7).
 */
export async function pruneObservationEvents(
  opts?: { keep?: number; maxAgeDays?: number },
): Promise<{ deleted: number }> {
  const keep = opts?.keep ?? OBS_EVENTS_KEEP
  const maxAgeDays = opts?.maxAgeDays ?? OBS_EVENTS_MAX_AGE_DAYS
  try {
    const cutoff = new Date(Date.now() - maxAgeDays * 24 * 3600 * 1000)
    const byAge = await db.observationEvent.deleteMany({ where: { ts: { lt: cutoff } } })
    let byCount = 0
    const total = await db.observationEvent.count()
    if (total > keep) {
      // Giữ `keep` dòng MỚI NHẤT: tìm seq cắt rồi deleteMany seq < đó
      const kth = await db.observationEvent.findFirst({
        orderBy: { seq: 'desc' },
        skip: keep - 1,
        select: { seq: true },
      })
      if (kth) {
        const res = await db.observationEvent.deleteMany({ where: { seq: { lt: kth.seq } } })
        byCount = res.count
      }
    }
    return { deleted: byAge.count + byCount }
  } catch {
    return { deleted: 0 } // fail-open — prune lỗi không ảnh hưởng gì
  }
}

// ==================== HEALTH (OBS-P4 obs.health + test r95) ====================

export interface ObsLedgerHealth {
  queued: number
  draining: boolean
  written: number
  dropped: number
  failed: number
  lastWriteLatencyMs: number
  /** Task 32: lỗi ghi gần nhất (null = chưa từng fail) — chẩn đoán gốc rễ */
  lastError: { message: string; kind: string; ts: number } | null
}

/** Ảnh chụp sức khỏe ledger — nguồn cho sự kiện obs.health (GAP-7/RO-7). */
export function getObservationHealth(): ObsLedgerHealth {
  const st = state()
  return {
    queued: st.queue.length,
    draining: st.draining,
    written: st.written,
    dropped: st.dropped,
    failed: st.failed,
    lastWriteLatencyMs: st.lastWriteLatencyMs,
    lastError: st.lastError,
  }
}

// ==================== HOOK TIỆN ÍCH (C.3 đợt 1 — gọi cùng format) ====================

/** Khối kết quả chung 3 pipeline train (calibration-v3 / surrogate / policy). */
export interface BrainTrainResultLike {
  trained: boolean
  version: number | null
  active: boolean
  sampleSize: number
  improved: boolean
  usable: number
  total: number
  error?: string
}

/**
 * Hook brain.train — 3 pipeline gọi CÙNG format (C.3 đợt 1 "brain train
 * start/end (3 pipeline)"): phase start lúc vào (sau lock), phase end lúc
 * có kết quả/exception. Chỉ gọi khi lock THÀNH CÔNG (bỏ lệnh trùng A7
 * không phát sự kiện — tránh noise single-flight).
 */
export function observeBrainTrain(
  brain: string,
  phase: 'start' | 'end',
  info: {
    inputMode: string
    useDraft: boolean
    result?: BrainTrainResultLike
    durationMs?: number
    error?: unknown
  },
): void {
  if (phase === 'start') {
    observeEvent({
      actor: `brain:${brain}`,
      kind: 'brain.train',
      summary: `${brain} train bắt đầu (${info.inputMode}${info.useDraft ? ', nháp' : ''})`,
      payload: { phase, brain, inputMode: info.inputMode, useDraft: info.useDraft },
    })
    return
  }
  const r = info.result
  const failed = info.error !== undefined ? String(info.error instanceof Error ? info.error.message : info.error) : null
  observeEvent({
    actor: `brain:${brain}`,
    kind: 'brain.train',
    summary: failed
      ? `${brain} train LỖI — ${failed.slice(0, 120)}`
      : r?.trained
        ? `${brain} train xong — v${r.version}${r.active ? ' ACTIVE' : ''}${r.improved ? ' · thắng đối chứng' : ' · chưa thắng đối chứng'} (n=${r.sampleSize})`
        : `${brain} train bỏ qua — ${r?.error?.slice(0, 100) ?? 'không đủ dữ liệu'}`,
    payload: {
      phase: 'end',
      brain,
      inputMode: info.inputMode,
      useDraft: info.useDraft,
      durationMs: info.durationMs ?? null,
      error: failed,
      ...(r
        ? {
            trained: r.trained,
            version: r.version,
            active: r.active,
            improved: r.improved,
            sampleSize: r.sampleSize,
            usable: r.usable,
            total: r.total,
            resultError: r.error ?? null,
          }
        : {}),
    },
  })
}
