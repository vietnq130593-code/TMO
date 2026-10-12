/**
 * BRAIN TRAIN LOCK — single-flight in-process mutex (blueprint A7)
 * ============================================================================
 *
 * Từ BRAIN-P3: nguồn trigger train nhân lên (nút UI + auto-train sau eval
 * run của Brain-A + auto-train sau agent run của Brain-B) → cần khóa
 * single-flight đúng khuyến nghị A7 (blueprint §4.1 ghi chú A7 + §6):
 *
 *   "Train trùng nhịp (cron + nút UI cùng lúc) → Single-flight in-process
 *    mutex + @@unique([brain, version]) bắt đua ở DB; train luôn NGOÀI
 *    request path."
 *
 * Phạm vi khóa: THEO BRAIN (key = 'calibration_v3' | 'surrogate' | ...) —
 * train Brain-A và Brain-B song song được (không chặn nhau); 2 lệnh train
 * CÙNG brain trùng nhịp → lệnh sau nhận lỗi "already in progress" thay vì
 * chạy đua bump version (lãng phí CPU + ghi 2 bản model gần giống nhau).
 * Layer chặn cuối vẫn là DB: @@unique([brain, version]) bắt đua tiến trình
 * khác (pm2 fork) — khóa này chỉ có tác dụng trong 1 process.
 *
 * Thuần in-process (globalThis — sống qua HMR của dev server), KHÔNG DB,
 * KHÔNG async — acquire/release đồng bộ quanh await train (try/finally
 * bắt buộc ở caller để không khóa vĩnh viễn khi train throw).
 */

const globalForLock = globalThis as unknown as {
  __tmoBrainTrainLocks?: Set<string>
}

function locks(): Set<string> {
  if (!globalForLock.__tmoBrainTrainLocks) {
    globalForLock.__tmoBrainTrainLocks = new Set<string>()
  }
  return globalForLock.__tmoBrainTrainLocks
}

/**
 * Cố chiếm khóa train của 1 brain. true = chiếm được (caller PHẢI release
 * trong finally); false = đang có train khác của cùng brain chạy → caller
 * trả kết quả "already in progress" (không đợi, không xếp hàng — train là
 * background job, lệnh thừa bỏ qua cho sạch).
 */
export function acquireTrainLock(brain: string): boolean {
  const set = locks()
  if (set.has(brain)) return false
  set.add(brain)
  return true
}

/** Trả khóa — gọi trong finally của mọi đường acquire thành công. */
export function releaseTrainLock(brain: string): void {
  locks().delete(brain)
}

/** Đang có train của brain này chạy? (hiển thị/telemetry — không dùng để quyết định acquire) */
export function isTrainLocked(brain: string): boolean {
  return locks().has(brain)
}
