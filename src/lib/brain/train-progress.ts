/**
 * TRAIN-PROGRESS BUS (Task 26-BE — hợp đồng API đài quan sát v2, chốt
 * 26-RESTORE 2026-10-14)
 * ==========================================================================
 *
 * Bus IN-MEMORY ghi tiến trình train của 3 pipeline (trainBrainCalibrationV3 /
 * trainBrainSurrogate / trainBrainPolicy) — cho GET /api/brain/activity trả
 * field `training` (FE đài quan sát v2 boost hiển thị hạt gradient vàng khi
 * status === 'running').
 *
 * Nguyên tắc (theo precedent impact.ts):
 *   - globalThis guard — sống sót qua HMR (next dev nạp lại module nhưng
 *     process giữ nguyên; tiền lệ __tmoObsLedger / __tmoObsImpactWorker).
 *   - KHÔNG DB, KHÔNG cron, KHÔNG IO — bus là observation thuần: mọi hàm bọc
 *     try/catch nội bộ, KHÔNG BAO GIỜ throw (làm hỏng train là lỗi thiết kế).
 *   - Pipeline gọi DẠNG ADDITIVE cạnh observeBrainTrain: start ngay SAU khi
 *     acquireTrainLock thành công (bỏ lệnh trùng A7 — không phát, đúng tiền
 *     lệ "Chỉ gọi khi lock THÀNH CÔNG" của ledger.observeBrainTrain), end ở
 *     MỌI lối ra: train xong (kể cả trained=false — "ngủ an toàn" là done +
 *     reason, KHÔNG phải failed) và throw (failed).
 *
 * Snapshot trả sự kiện GẦN NHẤT nếu đang `running` HOẶC kết thúc trong 30
 * phút qua — mọi nguồn (nút train UI + auto-retrain), mọi brain (FE tự so
 * khớp brain đang xem — hợp đồng 26-RESTORE). Ring buffer 10 sự kiện gần
 * nhất giữ lại cho debug/hiển thị sau này.
 */

import type { BrainKey } from './registry'

// ==================== HẰNG SỐ (doctrine #1 — nguồn hợp đồng 26-RESTORE) ====================

/** Snapshot trả về khi sự kiện kết thúc trong N ms qua (hợp đồng: 30 phút). */
export const TRAIN_PROGRESS_TTL_MS = 30 * 60_000
/** Ring buffer giữ N sự kiện gần nhất (debug/hiển thị sau này). */
export const TRAIN_PROGRESS_RING = 10

// ==================== TYPE (hợp đồng FE — KHÔNG đổi tên key) ====================

/** Tóm tắt số liệu cuối của 1 lượt train — điền gì CÓ SẴN, không chế tạo. */
export interface TrainProgressSummary {
  epochsRun?: number | null
  finalLoss?: number | null
  gradAbsMean?: number[] | null
}

/**
 * Snapshot cho field `training` của GET /api/brain/activity — ĐÚNG shape hợp
 * đồng 26-RESTORE (FE đang code theo — không thêm/bớt key).
 */
export interface TrainProgressSnapshot {
  brain: string
  head: string | null
  status: 'running' | 'done' | 'failed'
  startedAt: string
  endedAt: string | null
  epochsRun: number | null
  finalLoss: number | null
  gradAbsMean: number[] | null
}

/** Bản ghi đầy đủ trong ring (có reason + epoch-ms thô cho test/debug). */
export interface TrainProgressEvent {
  brain: string
  head: string | null
  status: 'running' | 'done' | 'failed'
  startedAtMs: number
  endedAtMs: number | null
  epochsRun: number | null
  finalLoss: number | null
  gradAbsMean: number[] | null
  /** lý do ngủ an toàn / lỗi — nội bộ ring (không vào snapshot hợp đồng). */
  reason: string | null
}

// ==================== STATE (globalThis — sống sót HMR, precedent ledger.ts) ====================

interface TrainProgressState {
  ring: TrainProgressEvent[]
}

const globalForTrainProgress = globalThis as unknown as {
  __tmoTrainProgress?: TrainProgressState
}

function state(): TrainProgressState {
  if (!globalForTrainProgress.__tmoTrainProgress) {
    globalForTrainProgress.__tmoTrainProgress = { ring: [] }
  }
  return globalForTrainProgress.__tmoTrainProgress
}

// ==================== BUS API (fail-open — KHÔNG BAO GIỜ throw) ====================

/**
 * Đánh dấu 1 lượt train BẮT ĐẦU — gọi ở ĐẦU đường train (sau lock A7, trước
 * mọi query DB — hợp đồng 26-BE mục 1). Push record `running` mới vào ring.
 */
export function trainProgressStart(brain: BrainKey, head?: string | null, now?: number): void {
  try {
    const st = state()
    st.ring.push({
      brain,
      head: head ?? null,
      status: 'running',
      startedAtMs: typeof now === 'number' && Number.isFinite(now) ? now : Date.now(),
      endedAtMs: null,
      epochsRun: null,
      finalLoss: null,
      gradAbsMean: null,
      reason: null,
    })
    if (st.ring.length > TRAIN_PROGRESS_RING) {
      st.ring.splice(0, st.ring.length - TRAIN_PROGRESS_RING)
    }
  } catch {
    /* bus là observation thuần — lỗi nội bộ KHÔNG được phép vỡ ra ngoài */
  }
}

/**
 * Chốt 1 lượt train: ok=true → `done` (kể cả trained=false "ngủ an toàn" —
 * truyền reason để ring lưu), ok=false → `failed` (throw pipeline). Tìm
 * record `running` MỚI NHẤT đúng brain + head; không thấy → no-op (fail-open).
 * `summary` điền gì CÓ SẴN từ result (surrogate 3 head: để null — trung thực
 * vì đa đầu). Tham số `now`/`reason` chỉ định cho TEST (thiết kế test được).
 */
export function trainProgressEnd(
  brain: BrainKey,
  ok: boolean,
  summary?: TrainProgressSummary,
  reason?: string | null,
  now?: number,
): void {
  try {
    const st = state()
    // Tìm record running mới nhất của brain (ring đã theo thứ tự thời gian —
    // quét từ cuối; head chỉ mang tính bổ trợ vì 3 pipeline đều head=null)
    for (let i = st.ring.length - 1; i >= 0; i--) {
      const r = st.ring[i]
      if (r.brain === brain && r.status === 'running') {
        r.status = ok ? 'done' : 'failed'
        r.endedAtMs = typeof now === 'number' && Number.isFinite(now) ? now : Date.now()
        if (summary) {
          if (typeof summary.epochsRun === 'number' && Number.isFinite(summary.epochsRun)) {
            r.epochsRun = summary.epochsRun
          }
          if (typeof summary.finalLoss === 'number' && Number.isFinite(summary.finalLoss)) {
            r.finalLoss = summary.finalLoss
          }
          if (Array.isArray(summary.gradAbsMean)) {
            r.gradAbsMean = summary.gradAbsMean.filter(
              v => typeof v === 'number' && Number.isFinite(v),
            )
          }
        }
        if (typeof reason === 'string' && reason !== '') {
          r.reason = reason
        }
        return
      }
    }
    // không có running nào khớp (end không start — không xảy ra trên pipeline
    // đã wire) → no-op, KHÔNG throw
  } catch {
    /* fail-open tuyệt đối */
  }
}

/**
 * Sự kiện GẦN NHẤT nếu đang `running` HOẶC kết thúc trong 30 phút qua —
 * shape ĐÚNG hợp đồng `training` (26-RESTORE). Bus trống / sự kiện quá cũ →
 * null. `now` tùy chọn cho TEST (thiết kế test được — xem task 26-BE mục 1).
 */
export function trainProgressSnapshot(now?: number): TrainProgressSnapshot | null {
  try {
    const st = state()
    const last = st.ring[st.ring.length - 1]
    if (!last) return null
    if (last.status !== 'running') {
      const t = typeof now === 'number' && Number.isFinite(now) ? now : Date.now()
      if (last.endedAtMs === null) return null // dòng lạ (không thể xảy ra) — bảo thủ
      if (t - last.endedAtMs > TRAIN_PROGRESS_TTL_MS) return null // quá 30 phút — hết hạn
    }
    return {
      brain: last.brain,
      head: last.head,
      status: last.status,
      startedAt: new Date(last.startedAtMs).toISOString(),
      endedAt: last.endedAtMs === null ? null : new Date(last.endedAtMs).toISOString(),
      epochsRun: last.epochsRun,
      finalLoss: last.finalLoss,
      gradAbsMean: last.gradAbsMean,
    }
  } catch {
    return null // fail-open — route vẫn 200 với training:null
  }
}

/**
 * Bản SAO ring (10 sự kiện gần nhất) — debug/hiển thị sau này (mục 1: "giữ
 * ring buffer để debug/hiển thị sau này"). Read-only theo cấu trúc bản sao.
 */
export function trainProgressRecent(): TrainProgressEvent[] {
  try {
    return state().ring.map(r => ({ ...r, gradAbsMean: r.gradAbsMean ? [...r.gradAbsMean] : null }))
  } catch {
    return []
  }
}

/** Dọn ring + đánh dấu sạch — cho TEST cô lập giữa các file (bun test 1 process). */
export function trainProgressReset(): void {
  try {
    state().ring = []
  } catch {
    /* no-op */
  }
}
