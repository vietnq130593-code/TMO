/**
 * Chính sách HARD-RSS tier của MemWatchdog — module THUẦN (0 import) để test
 * trực tiếp không cần DB/process. Tiền lệ cấu trúc: isPidRecycleSuspect
 * (goal-loop-durable-types, DEBT-R17BC r140).
 *
 * §7.10 BLUEPRINT-R17BC (round riêng 2026-10-21 — DEBT-R17BC giữ hoãn đúng
 * anti-goal v0.2 "gốc ratchet dành blueprint riêng sau khi W2 đo RSS peak"):
 * ---------------------------------------------------------------------------
 * BẰNG CHỨNG (dev.log 2026-10-20, tái hiện bằng `rg -a "MemWatchdog" dev.log`):
 *   - 15 boot liên tiếp chết ở HARD 2100MB với RSS lần-check-đầu 2230→2632MB
 *     (SelfExitDrain HARD-RSS) → crash-loop ~29s/vòng; "ratchet" vì mỗi lần
 *     restart turbopack cache ấm thêm một chút tới khi một boot bắt kịp RSS
 *     dưới 2100 thì sống.
 *   - 2 boot bắt kịp RSS 2047/2081MB (< 2100) → SỐNG, avail 1333-1425MB còn
 *     dư, và RSS HỒI VỀ 487/557MB chỉ sau ~40s → spike cold-compile Next dev
 *     là THOÁNG QUA, không phải leak.
 *   - Pilot W2 nới tạm 2800/3000 cho boot sống qua ngưỡng (verified) — nhưng
 *     làm YẾU bảo vệ OOM steady-state (reaper sandbox SIGINT thực chiến ở
 *     ~2.1-2.2GB — vòng 11c).
 *
 * FIX ĐÚNG TẦNG — HARD tier (tier BLIND RSS, tier duy nhất không phân biệt
 * spike thoáng vs leak thật) nhận CỬA SỔ BOOT-GRACE tính từ process start:
 *   1. TRONG grace: vượt HARD chỉ LOG + observation event (spike cold-compile
 *      được tha) nhưng vượt CEILING (mặc định HARD+700 — với HARD 2100 thì
 *      ceiling 2800, đúng giá trị pilot đã sống sót) vẫn exit ngay: runaway
 *      thật không được tha.
 *   2. NGOÀI grace: hành vi Y HỆT trước đây (exit ngay ở HARD — giữ hợp đồng
 *      vòng 11c "tự exit TRƯỚC reaper").
 *   3. Các tier ÁP LỰC THẬT (RSS×2 avail-aware chỉ exit khi MemAvailable
 *      <900MB; global guard MemAvailable<450MB exit ngay) KHÔNG nhận grace —
 *      bằng chứng spike boot vẫn để avail 1333-1425MB; áp lực hệ thống thật
 *      phải được xử lý tức thì CẢ trong grace. Grace chỉ áp cho tier mù.
 *
 * Ngữ nghĩa 0 = tắt (đồng bộ họ MEM_WATCHDOG_ hiện hành: hardMb=0 tắt tier,
 * graceMs=0 tắt grace). Đầu vào rác/NaN → RƠI VỀ HÀNH VI CŨ (exit hard-rss):
 * grace là KHOAN DUNG MỚI, fail-safe phải nghiêng về bảo vệ cũ.
 */

/** Kết quả quyết định của HARD tier cho 1 lần check. */
export type HardTierDecision =
  | { action: 'ok' }
  | { action: 'exit'; reason: 'hard-rss'; rssMb: number; hardMb: number }
  | { action: 'exit'; reason: 'grace-ceiling'; rssMb: number; ceilingMb: number }
  | {
      action: 'grace-log'
      rssMb: number
      hardMb: number
      ceilingMb: number
      graceRemainingMs: number
    }

/** Cửa sổ boot-grace mặc định 3 phút — đủ trùm cold-compile (bằng chứng:
 * spike rơi về ~500MB trong ~40s kể từ lần check đầu; 3 phút chừa dư cho
 * compile kéo dài khi cache lạnh hoàn toàn + polling UI dồn dập lúc boot). */
export const MEM_WATCHDOG_BOOT_GRACE_MS_DEFAULT = 180_000

/** Ceiling grace mặc định = HARD + 700MB (HARD 2100 → ceiling 2800 — đúng
 * giá trị pilot 2026-10-20 đã sống qua boot với peak 2.2-2.6GB, chừa ~170MB
 * trên peak quan sát cao nhất 2632MB). */
export const MEM_WATCHDOG_BOOT_CEILING_HEADROOM_MB = 700

/**
 * Quyết định hành động của HARD-RSS tier cho 1 lần check.
 *
 * @param rssMb     RSS hiện tại (MB)
 * @param hardMb    ngưỡng HARD (MB) — 0 = tier tắt
 * @param uptimeMs  tuổi process (ms) — nguồn: process.uptime()
 * @param graceMs   cửa sổ boot-grace (ms) — 0 = tắt grace
 * @param ceilingMb ceiling tự vệ TRONG grace (MB) — thấp hơn HARD sẽ bị
 *                  kẹp lên HARD; NaN/rác → coi như = HARD (bảo thủ)
 */
export function resolveHardTierDecision(input: {
  rssMb: number
  hardMb: number
  uptimeMs: number
  graceMs: number
  ceilingMb: number
}): HardTierDecision {
  const { rssMb, hardMb, uptimeMs, graceMs, ceilingMb } = input

  // Tier tắt (0) hoặc RSS chưa chạm HARD — không việc gì.
  // NaN rssMb/hardMb: không so sánh được → 'ok' (đồng bộ fail-open try/catch
  // của watchdog gốc — watchdog lỗi không được phép tự giết app).
  if (!(hardMb > 0) || !(rssMb >= hardMb)) return { action: 'ok' }

  // Grace chỉ kích hoạt với graceMs hợp lệ DƯƠNG và uptime hợp lệ. Mọi đầu
  // vào rác (NaN/âm) → rơi về hành vi cũ: exit hard-rss.
  const graceActive = graceMs > 0 && Number.isFinite(graceMs) &&
    Number.isFinite(uptimeMs) && uptimeMs >= 0 && uptimeMs < graceMs
  if (!graceActive) {
    return { action: 'exit', reason: 'hard-rss', rssMb, hardMb }
  }

  // Trong grace: ceiling không được thấp hơn HARD (kẹp lên — cấu hình sai
  // không được biến grace thành "tha tất cả"); ceiling rác → = HARD (spike
  // nào chạm HARD cũng exit — bảo thủ như không có grace).
  const ceilingEffective = Number.isFinite(ceilingMb)
    ? Math.max(ceilingMb, hardMb)
    : hardMb
  if (rssMb >= ceilingEffective) {
    return { action: 'exit', reason: 'grace-ceiling', rssMb, ceilingMb: ceilingEffective }
  }

  // Vượt HARD trong grace nhưng dưới ceiling → tha (log + observation event
  // do caller phát) — nghi spike cold-compile thoáng qua.
  return {
    action: 'grace-log',
    rssMb,
    hardMb,
    ceilingMb: ceilingEffective,
    graceRemainingMs: graceMs - uptimeMs,
  }
}
