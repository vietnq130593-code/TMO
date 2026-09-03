/**
 * Cron Schedule — lịch có cấu trúc cho CronJob (user request 2026-09-14)
 *
 * UI Smolab > Automation dựng lịch bằng nút Ngày / Tuần / Tháng:
 *   - Ngày  : chọn giờ + phút (nút Thêm để thêm nhiều giờ) → Lặp = mỗi ngày tại các giờ đó
 *   - Tuần  : tích các ngày trong tuần → chọn giờ + phút (+ Thêm) → Lặp = mỗi tuần
 *   - Tháng : chọn các ngày trong tháng → chọn giờ (+ Thêm) → Lặp = mỗi tháng
 *   - Lặp TẮT → tác vụ chạy ĐÚNG MỘT LẦN tại lần khớp lịch kế tiếp (one-time)
 *
 * Tools manage_automation (Omega) + propose_automation (agents khác) dùng cùng
 * cấu trúc này — mọi đường tạo cron job đều về 1 chỗ validate/tính toán.
 *
 * Lưu trữ: CronJob.scheduleJson (JSON string). CronJob.expression giữ cron
 * expression đại diện (times[0]) — scheduler match theo nextRunAt, expression
 * chỉ dùng hiển thị + lọc heartbeat legacy.
 */

// ==================== TYPES ====================

export type CronScheduleMode = 'day' | 'week' | 'month'

export interface CronScheduleConfig {
  /** 'day' | 'week' | 'month' */
  mode: CronScheduleMode
  /** Các giờ thực thi 'HH:mm' — luôn ≥ 1 phần tử, unique, sorted */
  times: string[]
  /** mode='week': các thứ trong tuần 0=CN..6=T7 (ít nhất 1) */
  daysOfWeek?: number[]
  /** mode='month': các ngày trong tháng 1-31 (ít nhất 1) */
  daysOfMonth?: number[]
  /** true = lặp lại theo chu kỳ mode · false = chạy đúng 1 lần */
  repeat: boolean
}

// ==================== CONSTANTS ====================

/** Thứ trong tuần hiển thị tiếng Việt — index theo JS getDay() (0=CN) */
export const DOW_LABELS_VI: Record<number, string> = {
  0: 'CN', 1: 'T2', 2: 'T3', 3: 'T4', 4: 'T5', 5: 'T6', 6: 'T7',
}

/** Thứ đầy đủ (mô tả) */
const DOW_FULL_VI: Record<number, string> = {
  0: 'Chủ nhật', 1: 'thứ Hai', 2: 'thứ Ba', 3: 'thứ Tư', 4: 'thứ Năm', 5: 'thứ Sáu', 6: 'thứ Bảy',
}

const MAX_TIMES = 12
const MAX_DAYS = 31

// ==================== VALIDATE ====================

function parseTimeToParts(t: string): { h: number; m: number } | null {
  const m = t.match(/^(\d{1,2}):(\d{2})$/)
  if (!m) return null
  const h = parseInt(m[1], 10)
  const mm = parseInt(m[2], 10)
  if (!Number.isInteger(h) || h < 0 || h > 23) return null
  if (!Number.isInteger(mm) || mm < 0 || mm > 59) return null
  return { h, m: mm }
}

/** Chuẩn hoá '9:5' → '09:05' (đảm bảo format HH:mm) */
export function normalizeTime(t: string): string | null {
  const parts = parseTimeToParts(t.trim())
  if (!parts) return null
  return `${String(parts.h).padStart(2, '0')}:${String(parts.m).padStart(2, '0')}`
}

/**
 * Validate + chuẩn hoá lịch có cấu trúc (dữ liệu từ UI hoặc LLM tool args —
 * KHÔNG tin đầu vào, validate toàn bộ như mọi automation input).
 */
export function validateCronSchedule(
  input: unknown,
): { ok: true; data: CronScheduleConfig } | { ok: false; error: string } {
  if (!input || typeof input !== 'object') {
    return { ok: false, error: 'Thiếu schedule (object)' }
  }
  const raw = input as Record<string, unknown>

  const mode = String(raw.mode || '')
  if (mode !== 'day' && mode !== 'week' && mode !== 'month') {
    return { ok: false, error: 'schedule.mode không hợp lệ — phải là "day" | "week" | "month"' }
  }

  // times: 'HH:mm'[]
  if (!Array.isArray(raw.times) || raw.times.length === 0) {
    return { ok: false, error: 'schedule.times cần ít nhất 1 giờ (vd ["09:30"]) — dùng nút Thêm để thêm giờ' }
  }
  if (raw.times.length > MAX_TIMES) {
    return { ok: false, error: `schedule.times tối đa ${MAX_TIMES} giờ` }
  }
  const times: string[] = []
  for (const t of raw.times) {
    const norm = normalizeTime(String(t))
    if (!norm) return { ok: false, error: `schedule.times có giờ không hợp lệ "${t}" — format HH:mm (vd "09:30")` }
    if (!times.includes(norm)) times.push(norm)
  }
  times.sort()

  const config: CronScheduleConfig = { mode, times, repeat: raw.repeat !== false }

  if (mode === 'week') {
    const dows = Array.isArray(raw.daysOfWeek) ? raw.daysOfWeek : []
    const valid = [...new Set(dows.map(d => parseInt(String(d), 10)))]
      .filter(d => Number.isInteger(d) && d >= 0 && d <= 6)
      .sort((a, b) => a - b)
    if (valid.length === 0) {
      return { ok: false, error: 'schedule.daysOfWeek cần ít nhất 1 ngày trong tuần (0=CN..6=T7)' }
    }
    if (valid.length !== dows.length) {
      return { ok: false, error: 'schedule.daysOfWeek có giá trị không hợp lệ (0=CN..6=T7)' }
    }
    config.daysOfWeek = valid
  }

  if (mode === 'month') {
    const doms = Array.isArray(raw.daysOfMonth) ? raw.daysOfMonth : []
    const valid = [...new Set(doms.map(d => parseInt(String(d), 10)))]
      .filter(d => Number.isInteger(d) && d >= 1 && d <= 31)
      .sort((a, b) => a - b)
    if (valid.length === 0) {
      return { ok: false, error: 'schedule.daysOfMonth cần ít nhất 1 ngày trong tháng (1-31)' }
    }
    if (valid.length !== doms.length) {
      return { ok: false, error: 'schedule.daysOfMonth có giá trị không hợp lệ (1-31)' }
    }
    if (valid.length > MAX_DAYS) {
      return { ok: false, error: `schedule.daysOfMonth tối đa ${MAX_DAYS} ngày` }
    }
    config.daysOfMonth = valid
  }

  return { ok: true, data: config }
}

// ==================== NEXT RUN COMPUTATION ====================

/**
 * Tính lần chạy kế tiếp (> from) theo lịch có cấu trúc.
 * - day  : quét hôm nay + 2 ngày tiếp × times
 * - week : quét 8 ngày tiếp, lọc theo daysOfWeek × times
 * - month: quét 62 ngày tiếp, lọc theo daysOfMonth × times
 * (tháng thiếu ngày 29-31 tự nhảy sang tháng kế — JS Date tự rollover,
 *  match theo getDate() nên an toàn)
 * Trả null nếu không tìm thấy (không xảy ra trong 62 ngày quét).
 */
export function nextRunFromSchedule(schedule: CronScheduleConfig, from: Date = new Date()): Date | null {
  const base = new Date(from.getTime())
  base.setSeconds(0, 0) // bỏ giây/ms để so khớp phút

  const scanDays =
    schedule.mode === 'day' ? 3 :
    schedule.mode === 'week' ? 8 :
    62

  let best: Date | null = null

  for (let dayOffset = 0; dayOffset <= scanDays; dayOffset++) {
    const day = new Date(base.getTime())
    day.setDate(day.getDate() + dayOffset)

    if (schedule.mode === 'week') {
      const dow = day.getDay()
      if (!schedule.daysOfWeek?.includes(dow)) continue
    }
    if (schedule.mode === 'month') {
      const dom = day.getDate()
      if (!schedule.daysOfMonth?.includes(dom)) continue
    }

    for (const t of schedule.times) {
      const parts = parseTimeToParts(t)
      if (!parts) continue
      const candidate = new Date(day.getTime())
      candidate.setHours(parts.h, parts.m, 0, 0)
      if (candidate.getTime() <= base.getTime()) continue
      if (!best || candidate.getTime() < best.getTime()) best = candidate
    }
  }

  return best
}

// ==================== CRON EXPRESSION ====================

/**
 * Sinh danh sách cron expression (1 expression per time) — dùng hiển thị và
 * làm expression đại diện. Chỉ dùng cho dạng lịch đơn giản; matching thực tế
 * vẫn theo nextRunFromSchedule (nextRunAt).
 */
export function scheduleToCronExpressions(schedule: CronScheduleConfig): string[] {
  return schedule.times.map(t => {
    const parts = parseTimeToParts(t)!
    const { h, m } = parts
    if (schedule.mode === 'day') return `${m} ${h} * * *`
    if (schedule.mode === 'week') return `${m} ${h} * * ${(schedule.daysOfWeek ?? []).join(',')}`
    return `${m} ${h} ${(schedule.daysOfMonth ?? []).join(',')} * *`
  })
}

/** Expression đại diện (times[0]) — lưu vào CronJob.expression để hiển thị */
export function scheduleToRepresentativeExpression(schedule: CronScheduleConfig): string {
  const exprs = scheduleToCronExpressions(schedule)
  return exprs[0] ?? '0 0 * * *'
}

// ==================== DESCRIBE (tiếng Việt) ====================

/**
 * Mô tả lịch tiếng Việt cho UI + tool result.
 * vd: "Mỗi ngày lúc 09:30, 14:00" · "Hàng tuần vào T2, T4 lúc 09:00" ·
 *     "Hàng tháng vào ngày 1, 15 lúc 08:00" · "Một lần vào 09:30 (ngày gần nhất)"
 */
export function describeSchedule(schedule: CronScheduleConfig): string {
  const times = schedule.times.join(', ')
  const repeatWord =
    schedule.mode === 'day' ? 'Mỗi ngày' :
    schedule.mode === 'week' ? 'Hàng tuần' :
    'Hàng tháng'

  let when = ''
  if (schedule.mode === 'week') {
    const dows = (schedule.daysOfWeek ?? []).slice().sort((a, b) => a - b)
    // Sắp xếp T2..CN cho tự nhiên
    dows.sort((a, b) => ((a === 0 ? 7 : a) - (b === 0 ? 7 : b)))
    when = ` vào ${dows.map(d => DOW_LABELS_VI[d]).join(', ')}`
  } else if (schedule.mode === 'month') {
    when = ` vào ngày ${(schedule.daysOfMonth ?? []).join(', ')}`
  }

  if (schedule.repeat) {
    return `${repeatWord}${when} lúc ${times}`
  }
  const next = nextRunFromSchedule(schedule)
  const nextStr = next
    ? `${String(next.getDate()).padStart(2, '0')}/${String(next.getMonth() + 1).padStart(2, '0')}/${next.getFullYear()} ${String(next.getHours()).padStart(2, '0')}:${String(next.getMinutes()).padStart(2, '0')}`
    : '(không tính được)'
  return `Một lần lúc ${times} — lần chạy gần nhất: ${nextStr}`
}

// ==================== PARSE (legacy expression → schedule) ====================

/**
 * Best-effort parse cron expression thô → CronScheduleConfig (để edit job cũ
 * bằng builder). repeat mặc định true (cron expression vốn là chu kỳ lặp).
 * Trả null nếu không nhận dạng được dạng đơn giản.
 */
export function parseExpressionToSchedule(expression: string): CronScheduleConfig | null {
  const parts = expression.trim().split(/\s+/)
  if (parts.length !== 5) return null
  const [min, hour, day, month, dow] = parts
  if (month !== '*') return null

  const minNum = /^\d+$/.test(min) ? parseInt(min, 10) : null
  const hourNum = /^\d+$/.test(hour) ? parseInt(hour, 10) : null
  if (minNum === null || hourNum === null) return null
  if (minNum < 0 || minNum > 59 || hourNum < 0 || hourNum > 23) return null
  const time = `${String(hourNum).padStart(2, '0')}:${String(minNum).padStart(2, '0')}`

  // Daily: M H * * *
  if (day === '*' && dow === '*') {
    return { mode: 'day', times: [time], repeat: true }
  }

  // Weekly: M H * * D1,D2 (0-6, không có bước nhảy */n)
  if (day === '*' && /^\d+(,\d+)*$/.test(dow)) {
    const dows = dow.split(',').map(d => parseInt(d, 10))
    if (dows.every(d => d >= 0 && d <= 6)) {
      return { mode: 'week', times: [time], daysOfWeek: dows, repeat: true }
    }
    return null
  }

  // Monthly: M H D1,D2 * *
  if (dow === '*' && /^\d+(,\d+)*$/.test(day)) {
    const doms = day.split(',').map(d => parseInt(d, 10))
    if (doms.every(d => d >= 1 && d <= 31)) {
      return { mode: 'month', times: [time], daysOfMonth: doms, repeat: true }
    }
    return null
  }

  return null
}

/** Parse an toàn scheduleJson từ DB → config (null nếu hỏng/không có) */
export function parseScheduleJson(json: string | null | undefined): CronScheduleConfig | null {
  if (!json) return null
  try {
    const parsed = JSON.parse(json)
    const validated = validateCronSchedule(parsed)
    return validated.ok ? validated.data : null
  } catch {
    return null
  }
}

// ==================== EXECUTOR HELPERS ====================

/**
 * Executor lưu trong CronJob.executor:
 *   ''            → Automation Agent mặc định (generic, như cũ)
 *   'RAMPAGE'        → agent cụ thể thực thi
 *   'team:code'   → TEAM thực thi: TL (Team Leader) của team điều phối triển khai toàn bộ tác vụ
 */
export function parseExecutor(executor: string | null | undefined): { type: 'default' | 'agent' | 'team'; value: string } {
  const raw = (executor || '').trim()
  if (!raw) return { type: 'default', value: '' }
  if (raw.startsWith('team:')) {
    const team = raw.slice('team:'.length).trim()
    if (team) return { type: 'team', value: team }
  }
  return { type: 'agent', value: raw }
}
